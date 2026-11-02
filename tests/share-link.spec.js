import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('encrypted snapshots round-trip Unicode, BOM, literal markup and compressed text', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShareLink, readShareLink } = await import('./share-link.js');
    const values = ['\uFEFF  Résumé — 你好 👩‍💻\n\t<b>literal text</b>\n\ntrailing spaces  ', 'Repeated text.\n'.repeat(20000)];
    const links = await Promise.all(values.map((text) => createShareLink(text, 'https://example.com/nested/plainlet/?ignored=1#old')));
    return {
      values,
      restored: await Promise.all(links.map((link) => readShareLink(new URL(link).hash))),
      links,
      unrelated: await readShareLink('#ordinary-anchor'),
    };
  });
  expect(result.restored).toEqual(result.values);
  expect(result.unrelated).toBeNull();
  for (const link of result.links) {
    expect(link.startsWith('https://example.com/nested/plainlet/#share=1.')).toBe(true);
    expect(link.length).toBeLessThan(8000);
    expect(link).not.toContain('literal');
  }
});

test('each share uses a fresh key and IV even for identical text', async ({ page }) => {
  const links = await page.evaluate(async () => {
    const { createShareLink } = await import('./share-link.js');
    return Promise.all([1, 2].map(() => createShareLink('Same snapshot', location.href)));
  });
  const [first, second] = links.map((link) => new URL(link).hash.split('.'));
  expect(first[1]).not.toBe(second[1]);
  expect(first[2]).not.toBe(second[2]);
  expect(first[3]).not.toBe(second[3]);
});

test('wrong keys, modified IVs, modified ciphertext and malformed links are rejected', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { createShareLink, readShareLink } = await import('./share-link.js');
    const hash = new URL(await createShareLink('Private snapshot', location.href)).hash;
    const modified = [1, 2, 3].map((index) => {
      const parts = hash.split('.');
      parts[index] = (parts[index][0] === 'A' ? 'B' : 'A') + parts[index].slice(1);
      return parts.join('.');
    });
    const invalid = [...modified, '#share=', hash.replace('#share=1.', '#share=2.'), hash.slice(0, -3), `${hash}.extra`, hash.replace('.', '.!'), `#share=${'a'.repeat(8000)}`];
    return Promise.all(invalid.map(async (value) => {
      try { await readShareLink(value); return 'accepted'; } catch (error) { return error.code; }
    }));
  });
  expect(codes.every((code) => code === 'invalid')).toBe(true);
});

test('sharing limits the complete URL and original UTF-8 bytes', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { createShareLink, MAX_SHARE_TEXT_BYTES, MAX_SHARE_URL_LENGTH } = await import('./share-link.js');
    const random = crypto.getRandomValues(new Uint8Array(14000));
    const incompressible = Array.from(random, (value) => String.fromCharCode(value + 32)).join('');
    const cases = [
      [incompressible, location.href],
      ['x'.repeat(MAX_SHARE_TEXT_BYTES + 1), location.href],
      ['界'.repeat(Math.floor(MAX_SHARE_TEXT_BYTES / 3) + 1), location.href],
      ['short text', `https://example.com/${'a'.repeat(MAX_SHARE_URL_LENGTH)}`],
    ];
    return Promise.all(cases.map(async ([text, base]) => {
      try { await createShareLink(text, base); return 'accepted'; } catch (error) { return error.code; }
    }));
  });
  expect(codes).toEqual(['too-large', 'too-large', 'too-large', 'too-large']);
});

test('raw links work without compression APIs and encrypted sharing never falls back to plaintext', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShareLink, readShareLink } = await import('./share-link.js');
    const compression = window.CompressionStream;
    const decompression = window.DecompressionStream;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
    const text = 'Plain Unicode 你好 '.repeat(50);
    const compressed = await createShareLink(text, location.href);
    const result = {};
    try {
      window.CompressionStream = undefined;
      window.DecompressionStream = undefined;
      const raw = await createShareLink(text, location.href);
      result.restored = await readShareLink(new URL(raw).hash);
      try { await readShareLink(new URL(compressed).hash); } catch (error) { result.decompression = error.code; }
      Object.defineProperty(window, 'crypto', { configurable: true, value: undefined });
      try { await createShareLink(text, location.href); } catch (error) { result.encrypt = error.code; }
      try { await readShareLink(new URL(raw).hash); } catch (error) { result.decrypt = error.code; }
    } finally {
      window.CompressionStream = compression;
      window.DecompressionStream = decompression;
      Object.defineProperty(window, 'crypto', cryptoDescriptor);
    }
    return { ...result, text };
  });
  expect(result.restored).toBe(result.text);
  expect(result.decompression).toBe('unsupported');
  expect(result.encrypt).toBe('unsupported');
  expect(result.decrypt).toBe('unsupported');
});

test('authenticated malicious payloads cannot bypass decompression, format or UTF-8 validation', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { readShareLink, MAX_SHARE_TEXT_BYTES } = await import('./share-link.js');
    const oversized = new Uint8Array(MAX_SHARE_TEXT_BYTES + 1).fill(65);
    const gzip = new Uint8Array(await new Response(new Blob([oversized]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const bomb = new Uint8Array(gzip.length + 1);
    bomb[0] = 1;
    bomb.set(gzip, 1);
    // Construct authenticated inputs independently; an attacker knows every link's key.
    const payloads = [bomb, new Uint8Array([2, 65]), new Uint8Array([0, 0xff]), new Uint8Array([1, 65])];
    function base64(bytes) {
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    }
    return Promise.all(payloads.map(async (payload) => {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('plainlet:share:1'), tagLength: 128 }, key, payload));
      const hash = `#share=1.${base64(raw)}.${base64(iv)}.${base64(encrypted)}`;
      try { await readShareLink(hash); return 'accepted'; } catch (error) { return error.code; }
    }));
  });
  expect(codes).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
});

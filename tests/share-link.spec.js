import { test, expect } from '@playwright/test';

// Fixed vectors produced independently with Node's crypto implementation.
const vectorText = '\uFEFF  Legacy résumé 👋\n<b>literal</b>  ';
const legacyVector = '#share=1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8.ICEiIyQlJicoKSor.0tUdz0y4Vmt9HSG34Wo3UKM8gV8uoJNx_X1mLiu0MmAB65dl4hkauCrdTr_Tt27EsHcg75Rn4vSRUro';
const passwordVector = '#share=3.LC0uLzAxMjM0NTY3ODk6Ow.ICEiIyQlJicoKSor.AxybOydRFfpbE9zgvsBz9pIoEGQUmG93vMWFHVirRoIPwXZdaLsZacT3GXd5aiLQmE-RMl-JfRQKWtQ';
const vectorPassword = '  Crème brûlée 🔐 secret  ';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('ordinary links preserve raw and compressed Unicode without using crypto', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShareLink, readShareLink } = await import('./share-link.js');
    const descriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
    Object.defineProperty(window, 'crypto', { configurable: true, value: undefined });
    try {
      const values = ['', '\uFEFF  Résumé — 你好 👩‍💻\n\t<b>literal text</b>\n\ntrailing spaces  ', 'Repeated text.\n'.repeat(20000)];
      const links = await Promise.all(values.map((text) => createShareLink(text, 'https://example.com/nested/plainlet/?ignored=1#old')));
      return {
        values,
        restored: await Promise.all(links.map((link) => readShareLink(new URL(link).hash))),
        links,
        unrelated: await readShareLink('#ordinary-anchor'),
      };
    } finally {
      Object.defineProperty(window, 'crypto', descriptor);
    }
  });
  expect(result.restored).toEqual(result.values);
  expect(result.unrelated).toBeNull();
  for (const link of result.links) {
    expect(link.startsWith('https://example.com/nested/plainlet/#share=2.')).toBe(true);
    expect(link.length).toBeLessThan(8000);
  }
});

test('existing encrypted links and independent PBKDF2 password vectors still open', async ({ page }) => {
  const result = await page.evaluate(async ({ legacy, protectedHash, password, text }) => {
    const { createShareLink, readShareLink } = await import('./share-link.js');
    return {
      legacyText: await readShareLink(legacy),
      protectedText: await readShareLink(protectedHash, { password }),
      plainLength: new URL(await createShareLink(text, location.href)).hash.length,
    };
  }, { legacy: legacyVector, protectedHash: passwordVector, password: vectorPassword, text: vectorText });
  expect(result.legacyText).toBe(vectorText);
  expect(result.protectedText).toBe(vectorText);
  expect(result.plainLength).toBeLessThan(legacyVector.length);
});

test('protected links require the separately shared password and use fresh salt and IV', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShareLink, readShareLink, generateSharePassword } = await import('./share-link.js');
    const password = generateSharePassword();
    const otherPassword = generateSharePassword();
    const text = 'A protected snapshot.\n'.repeat(100);
    const links = await Promise.all([1, 2].map(() => createShareLink(text, location.href, { password })));
    let missing;
    try { await readShareLink(new URL(links[0]).hash); } catch (error) { missing = error.code; }
    return {
      password, otherPassword, links, missing, text,
      opened: await readShareLink(new URL(links[0]).hash, { password }),
    };
  });
  expect(result.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.password).not.toBe(result.otherPassword);
  expect(result.opened).toBe(result.text);
  expect(result.missing).toBe('password-required');
  const [first, second] = result.links.map((link) => new URL(link).hash.split('.'));
  expect(first[0]).toBe('#share=3');
  expect(first[1]).not.toBe(second[1]);
  expect(first[2]).not.toBe(second[2]);
  expect(first[3]).not.toBe(second[3]);
  for (const link of result.links) {
    expect(link).not.toContain(result.password);
    expect(link).not.toContain('protected');
  }
});

test('chosen passwords preserve whitespace and Unicode exactly and enforce a bounded size', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShareLink, readShareLink } = await import('./share-link.js');
    const password = '  Cafe\u0301 🔒 with spaces  ';
    const link = await createShareLink('Exact password', location.href, { password });
    const hash = new URL(link).hash;
    const opened = await readShareLink(hash, { password });
    const codes = [];
    for (const wrong of [password.trim(), password.normalize('NFC'), '', 'x'.repeat(1025), '界'.repeat(342)]) {
      try { await readShareLink(hash, { password: wrong }); codes.push('accepted'); } catch (error) { codes.push(error.code); }
    }
    for (const bad of ['', 'x'.repeat(1025), '界'.repeat(342)]) {
      try { await createShareLink('text', location.href, { password: bad }); codes.push('accepted'); } catch (error) { codes.push(error.code); }
    }
    return { opened, codes };
  });
  expect(result.opened).toBe('Exact password');
  expect(result.codes).toEqual(['wrong-password', 'wrong-password', 'password-required', 'password-too-long', 'password-too-long', 'password-required', 'password-too-long', 'password-too-long']);
});

test('wrong passwords and tampered salt, IV or ciphertext cannot open protected links', async ({ page }) => {
  const result = await page.evaluate(async ({ hash, password }) => {
    const { readShareLink } = await import('./share-link.js');
    const modified = [1, 2, 3].map((index) => {
      const parts = hash.split('.');
      parts[index] = (parts[index][0] === 'A' ? 'B' : 'A') + parts[index].slice(1);
      return parts.join('.');
    });
    const codes = [];
    for (const value of modified) {
      try { await readShareLink(value, { password }); codes.push('accepted'); } catch (error) { codes.push(error.code); }
    }
    try { await readShareLink(hash, { password: 'wrong but plausible password' }); codes.push('accepted'); } catch (error) { codes.push(error.code); }
    const malformed = ['#share=', hash.replace('#share=3.', '#share=4.'), `${hash}.extra`, hash.replace('.', '.!'), '#share=3.short.iv.cipher', hash.replace('#share=3.', '#share=2.'), hash.replace('#share=3.', '#share=1.'), `#share=${'a'.repeat(8000)}`];
    const malformedCodes = [];
    for (const value of malformed) {
      try { await readShareLink(value); malformedCodes.push('accepted'); } catch (error) { malformedCodes.push(error.code); }
    }
    return { codes, malformedCodes };
  }, { hash: passwordVector, password: vectorPassword });
  expect(result.codes).toEqual(['wrong-password', 'wrong-password', 'wrong-password', 'wrong-password']);
  expect(result.malformedCodes.every((code) => code === 'invalid')).toBe(true);
});

test('sharing limits the complete URL and original UTF-8 bytes in both modes', async ({ page }) => {
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
    const codes = [];
    for (const options of [{}, { password: 'Chosen password' }]) {
      for (const [text, base] of cases) {
        try { await createShareLink(text, base, options); codes.push('accepted'); } catch (error) { codes.push(error.code); }
      }
    }
    return codes;
  });
  expect(codes).toEqual(Array(8).fill('too-large'));
});

test('raw links use the exact URL budget, including the extra overhead of password protection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShareLink } = await import('./share-link.js');
    const compression = window.CompressionStream;
    window.CompressionStream = undefined;
    try {
      const base = 'https://example.com/';
      const cases = [{}, { password: 'Size boundary password' }];
      const result = [];
      for (const options of cases) {
        const extra = options.password ? 22 + 1 + 16 + 1 : 0;
        const bytes = Math.floor((8000 - base.length - '#share=2.'.length - extra) * 3 / 4) - 1 - (options.password ? 16 : 0);
        const link = await createShareLink('x'.repeat(bytes), base, options);
        let overflow;
        try { await createShareLink('x'.repeat(bytes + 1), base, options); } catch (error) { overflow = error.code; }
        result.push({ length: link.length, overflow, bytes });
      }
      return result;
    } finally {
      window.CompressionStream = compression;
    }
  });
  for (const boundary of result) {
    expect(boundary.length).toBeGreaterThanOrEqual(7999);
    expect(boundary.length).toBeLessThanOrEqual(8000);
    expect(boundary.overflow).toBe('too-large');
  }
  expect(result[0].bytes).toBeGreaterThan(result[1].bytes);
});

test('missing optional APIs leave ordinary sharing available and never downgrade protected links', async ({ page }) => {
  const result = await page.evaluate(async ({ protectedHash, password }) => {
    const { createShareLink, readShareLink, generateSharePassword } = await import('./share-link.js');
    const compression = window.CompressionStream;
    const decompression = window.DecompressionStream;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
    const text = 'Plain Unicode 你好 '.repeat(50);
    const compressed = await createShareLink(text, location.href);
    const result = {};
    try {
      window.CompressionStream = undefined;
      window.DecompressionStream = undefined;
      Object.defineProperty(window, 'crypto', { configurable: true, value: undefined });
      const raw = await createShareLink(text, location.href);
      result.restored = await readShareLink(new URL(raw).hash);
      try { await readShareLink(new URL(compressed).hash); } catch (error) { result.decompression = error.code; }
      try { generateSharePassword(); } catch (error) { result.generate = error.code; }
      try { await createShareLink(text, location.href, { password }); } catch (error) { result.encrypt = error.code; }
      try { await readShareLink(protectedHash, { password }); } catch (error) { result.decrypt = error.code; }
    } finally {
      window.CompressionStream = compression;
      window.DecompressionStream = decompression;
      Object.defineProperty(window, 'crypto', cryptoDescriptor);
    }
    return { ...result, text };
  }, { protectedHash: passwordVector, password: vectorPassword });
  expect(result.restored).toBe(result.text);
  expect(result.decompression).toBe('unsupported');
  expect(result.generate).toBe('unsupported');
  expect(result.encrypt).toBe('unsupported');
  expect(result.decrypt).toBe('unsupported');
});

test('untrusted payloads cannot bypass decompression, format or UTF-8 bounds in either mode', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { readShareLink, MAX_SHARE_TEXT_BYTES } = await import('./share-link.js');
    const oversized = new Uint8Array(MAX_SHARE_TEXT_BYTES + 1).fill(65);
    const gzip = new Uint8Array(await new Response(new Blob([oversized]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const bomb = new Uint8Array(gzip.length + 1);
    bomb[0] = 1;
    bomb.set(gzip, 1);
    const payloads = [bomb, new Uint8Array([2, 65]), new Uint8Array([0, 0xff]), new Uint8Array([1, 65])];
    function base64(bytes) {
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    }
    // Build protected malicious payloads independently of the codec.
    const password = 'Attacker-owned password';
    const salt = new Uint8Array(16).fill(42);
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, hash: 'SHA-256', iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const codes = [];
    for (const payload of payloads) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('plainlet:share:3'), tagLength: 128 }, key, payload));
      const hashes = [`#share=2.${base64(payload)}`, `#share=3.${base64(salt)}.${base64(iv)}.${base64(encrypted)}`];
      for (const hash of hashes) {
        try { await readShareLink(hash, { password }); codes.push('accepted'); } catch (error) { codes.push(error.code); }
      }
    }
    return codes;
  });
  expect(codes).toEqual(Array(8).fill('invalid'));
});

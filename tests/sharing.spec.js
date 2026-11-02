import { test, expect } from '@playwright/test';

// Sharing and clipboard tests must never read or change the machine clipboard.
async function mockClipboard(page, options = {}) {
  await page.addInitScript((settings) => {
    window.testClipboard = { text: settings.text || '', written: [], denied: Boolean(settings.denied) };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => window.testClipboard.text,
        writeText: async (text) => {
          if (window.testClipboard.denied) throw new DOMException('Denied', 'NotAllowedError');
          window.testClipboard.written.push(text);
        },
      },
    });
    document.execCommand = () => false;
  }, options);
}

async function generateLink(page, text) {
  await page.getByRole('textbox', { name: 'Your plain text' }).fill(text);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Share', exact: true })).toBeVisible();
  return page.getByRole('textbox', { name: 'Share link', exact: true }).inputValue();
}

async function closeShare(page) {
  await page.getByRole('dialog', { name: 'Share', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
}

// Build the already-published v1 format independently to keep old links covered.
async function legacyLink(page, text) {
  return page.evaluate(async (value) => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const bytes = new TextEncoder().encode(value);
    const payload = new Uint8Array(bytes.length + 1);
    payload.set(bytes, 1);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('plainlet:share:1'), tagLength: 128,
    }, key, payload));
    const base64 = (data) => btoa(Array.from(data, (byte) => String.fromCharCode(byte)).join(''))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const url = new URL(location.href);
    url.hash = `share=1.${base64(raw)}.${base64(iv)}.${base64(encrypted)}`;
    return url.href;
  }, text);
}

async function delayCompression(page) {
  await page.evaluate(() => {
    const original = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = function (...args) {
      const response = this;
      return new Promise((resolve, reject) => {
        window.releaseShareCompression = () => original.apply(response, args).then(resolve, reject)
          .finally(() => { window.shareCompressionFinished = true; });
      });
    };
  });
}

async function protectLink(page) {
  await page.getByRole('checkbox', { name: 'Password protect', exact: true }).check();
  await expect(page.locator('#share-password')).toHaveValue('');
  await expect(page.locator('#share-link')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Generate password', exact: true }).click();
  await expect(page.locator('#share-link')).toHaveValue(/#share=3\./);
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
  return { link: await page.locator('#share-link').inputValue(), password: await page.locator('#share-password').inputValue() };
}

test('sharing is available for nonempty text and copies a link without changing the current address', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await expect(share).toBeDisabled();
  const address = page.url();
  const text = 'A private snapshot';
  const link = await generateLink(page, text);
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:4174\/plainlet\/#share=2\./);
  expect(link).not.toContain(encodeURIComponent(text));
  expect(link.length).toBeLessThanOrEqual(8000);
  expect(page.url()).toBe(address);
  const dialog = page.getByRole('dialog', { name: 'Share', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Share link', exact: true })).toHaveAttribute('readonly', '');
  await expect(dialog.getByRole('checkbox', { name: 'Password protect', exact: true })).not.toBeChecked();
  await expect(dialog.locator('#share-password')).not.toBeVisible();
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([link]);
  await expect(page.locator('#share-status')).toContainText(/copied/i);
  await closeShare(page);
  await expect(share).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  await page.getByRole('button', { name: 'Clear text', exact: true }).click();
  await expect(share).toBeDisabled();
});

test('a new recipient opens literal Unicode text without uploads or saved history, and reload clears it', async ({ page, browser }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = '  Résumé — 你好 👩‍💻\n\t<b>literal HTML</b>\n<script>window.sharedScriptRan=true</script>\ntrailing spaces  ';
  const link = await generateLink(page, text);
  const recipientContext = await browser.newContext();
  const recipient = await recipientContext.newPage();
  await mockClipboard(recipient);
  const requests = [];
  recipient.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  await recipient.goto(link);
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  await expect(recipient).toHaveURL('http://127.0.0.1:4174/plainlet/');
  expect(await recipient.evaluate(() => window.sharedScriptRan)).toBeUndefined();
  expect(await recipient.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await recipient.getByRole('button', { name: 'History', exact: true }).click();
  await expect(recipient.getByRole('dialog', { name: 'History', exact: true }).getByRole('listitem')).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).origin).toBe('http://127.0.0.1:4174');
    expect(new URL(request.url).hash).toBe('');
    expect(request.url).not.toContain('share=');
  }
  await recipient.reload();
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('');
  await recipientContext.close();
});

test('each link is a fixed snapshot and later edits can be shared separately', async ({ page, context }) => {
  await mockClipboard(page);
  await page.goto('./');
  const first = await generateLink(page, 'First version');
  await closeShare(page);
  const second = await generateLink(page, 'Second version');
  expect(second).not.toBe(first);
  const recipient = await context.newPage();
  await mockClipboard(recipient);
  await recipient.goto(first);
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('First version');
  await recipient.goto(second);
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('Second version');
});

test('large incompressible pastes remain editable and copyable when they cannot be shared', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = await page.evaluate(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(20000));
    window.testClipboard.text = btoa(String.fromCharCode(...bytes));
    return window.testClipboard.text;
  });
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Your plain text' });
  await expect(editor).toHaveValue(text);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('This paste is too big to share.');
  await expect(page.getByRole('dialog', { name: 'Share', exact: true })).not.toBeVisible();
  await expect(editor).toHaveValue(text);
  await editor.fill(`${text}\nStill editable`);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([`${text}\nStill editable`]);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'History', exact: true }).locator('pre')).toHaveText(text);
});

test('text above the share decoding safety limit can still be pasted and copied', async ({ page }) => {
  const text = 'x'.repeat(1024 * 1024 + 1);
  await mockClipboard(page, { text });
  await page.goto('./');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('This paste is too big to share.');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written[0].length)).toBe(text.length);
});

test('blocked clipboard access selects the share link for manual copying without altering the editor', async ({ page }) => {
  await mockClipboard(page, { denied: true });
  await page.goto('./');
  const text = 'Keep the editor unchanged';
  const link = await generateLink(page, text);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Share link', exact: true });
  await expect(field).toBeFocused();
  expect(await field.evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([0, link.length]);
  await expect(page.locator('#share-status')).toContainText('Ctrl+C or ⌘C');
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
});

test('a malformed incoming share reports failure and leaves current text intact', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Keep my current work');
  await page.evaluate(() => { location.hash = 'share=1.invalid'; });
  await expect(page.locator('#status')).not.toBeEmpty();
  await expect(page.locator('#status')).toContainText(/link/i);
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('Keep my current work');
  await expect(page).toHaveURL('http://127.0.0.1:4174/plainlet/');
});

for (const action of ['edit', 'clear', 'paste']) {
  test(`an incoming share never replaces newer ${action} work after decryption is delayed`, async ({ page }) => {
    await mockClipboard(page, { text: 'New clipboard text' });
    await page.goto('./');
    await page.getByRole('textbox', { name: 'Your plain text' }).fill('Current text');
    const link = await legacyLink(page, 'Older shared text');
    await page.evaluate(() => {
      const original = crypto.subtle.decrypt.bind(crypto.subtle);
      crypto.subtle.decrypt = (...args) => new Promise((resolve, reject) => {
        window.releaseShareDecrypt = () => original(...args).then(resolve, reject).finally(() => { window.shareDecryptFinished = true; });
      });
    });
    await page.evaluate((url) => { location.hash = new URL(url).hash; }, link);
    await page.waitForFunction(() => typeof window.releaseShareDecrypt === 'function');
    if (action === 'edit') await page.getByRole('textbox', { name: 'Your plain text' }).fill('Newer typing');
    if (action === 'clear') await page.getByRole('button', { name: 'Clear text', exact: true }).click();
    if (action === 'paste') await page.getByRole('button', { name: 'Paste', exact: true }).click();
    await page.evaluate(() => window.releaseShareDecrypt());
    await page.waitForFunction(() => window.shareDecryptFinished);
    const expected = action === 'edit' ? 'Newer typing' : action === 'clear' ? '' : 'New clipboard text';
    await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(expected);
    await expect(page).toHaveURL('http://127.0.0.1:4174/plainlet/');
  });
}

test('editing during share generation cancels the stale link dialog', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Old text');
  await delayCompression(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseShareCompression === 'function');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('New text');
  await page.evaluate(() => window.releaseShareCompression());
  await page.waitForFunction(() => window.shareCompressionFinished);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog', { name: 'Share', exact: true })).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('New text');
});

test('Share? explains link access and size limits and remains usable on a narrow screen', async ({ page }, testInfo) => {
  await mockClipboard(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('./');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const share = page.getByRole('button', { name: 'Share', exact: true });
  const bounds = await share.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.locator('.about-menu > summary').click();
  await page.getByRole('button', { name: 'Share?', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Share?', exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(/anyone.*link/i);
  await expect(help).toContainText(/Password protect/);
  await expect(help).toContainText(/too big to share|too large to share/i);
  expect(await help.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(help).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Share?', exact: true })).toBeFocused();
  await page.locator('.about-menu > summary').click();
  await generateLink(page, 'A compact share dialog');
  const dialog = page.getByRole('dialog', { name: 'Share', exact: true });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  const field = await page.getByRole('textbox', { name: 'Share link', exact: true }).boundingBox();
  expect(field.x).toBeGreaterThanOrEqual(0);
  expect(field.x + field.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('share-mobile.png'), fullPage: true });
});

test('cached sharing opens and copies an incoming link while offline', async ({ page, context }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = 'Shared offline ✓\n' + 'Repeated text compresses. '.repeat(200);
  const link = await generateLink(page, text);
  await closeShare(page);
  await expect(page.locator('#offline-status')).toHaveText('Ready to work offline');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cachedURLs = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (await Promise.all(keys.map(async (key) => (await (await caches.open(key)).keys()).map((request) => request.url)))).flat();
  });
  expect(cachedURLs.some((url) => url.endsWith('/share-link.js'))).toBe(true);
  expect(cachedURLs.every((url) => !url.includes('#') && !url.includes('share='))).toBe(true);
  await context.setOffline(true);
  const recipient = await context.newPage();
  await mockClipboard(recipient);
  await recipient.goto(link);
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  await recipient.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await recipient.evaluate(() => window.testClipboard.written)).toEqual([text]);
  await recipient.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(recipient.getByRole('dialog', { name: 'Share', exact: true })).toBeVisible();
});

test('ordinary sharing needs no encryption support and password failure never exposes an ordinary link as protected', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const protectedLink = await page.evaluate(async () => {
    const { createShareLink, generateSharePassword } = await import('./share-link.js');
    const result = await createShareLink('Incoming protected text', location.href, { password: generateSharePassword() });
    Object.defineProperty(crypto, 'subtle', { configurable: true, value: undefined });
    return result;
  });
  const text = 'Ordinary sharing stays available';
  const plain = await generateLink(page, text);
  expect(new URL(plain).hash).toMatch(/^#share=2\./);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([plain]);
  await page.getByRole('checkbox', { name: 'Password protect', exact: true }).check();
  await page.getByRole('button', { name: 'Generate password', exact: true }).click();
  await expect(page.locator('#share-status')).toContainText(/unavailable|not supported/i);
  if (await page.locator('#share-protect').isChecked()) {
    await expect(page.locator('#share-link')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
    await page.locator('#share-protect').uncheck();
  }
  await expect(page.locator('#share-link')).toHaveValue(plain);
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
  await closeShare(page);
  await page.evaluate((url) => { location.hash = new URL(url).hash; }, protectedLink);
  await expect(page.locator('#status')).toContainText(/browser cannot open|unavailable|not supported/i);
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([plain, text]);
});

test('opening History during incoming decryption keeps the shared text and dialog focus', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Earlier editor text');
  const link = await legacyLink(page, 'Shared text still arrives');
  await page.evaluate(() => {
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.decrypt = (...args) => new Promise((resolve, reject) => {
      window.releaseShareDecrypt = () => original(...args).then(resolve, reject);
    });
  });
  await page.evaluate((url) => { location.hash = new URL(url).hash; }, link);
  await page.waitForFunction(() => typeof window.releaseShareDecrypt === 'function');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History', exact: true });
  const close = history.getByRole('button', { name: 'Close history', exact: true });
  await expect(history).toBeVisible();
  await expect(close).toBeFocused();
  await page.evaluate(() => window.releaseShareDecrypt());
  await expect(page.locator('#status')).toHaveText('Shared text opened.');
  await expect(history).toBeVisible();
  await expect(close).toBeFocused();
  await expect(history.getByRole('listitem')).toHaveCount(0);
  await expect(page.locator('#text-input')).toHaveValue('Shared text still arrives');
  await close.click();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('Shared text still arrives');
  await expect(page).toHaveURL('http://127.0.0.1:4174/plainlet/');
});

test('opening Privacy during link compression cancels the outgoing dialog and its progress message', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Keep my current text');
  await delayCompression(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseShareCompression === 'function');
  await expect(page.locator('#status')).toHaveText('Creating share link…');
  await page.locator('.about-menu > summary').click();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  const privacy = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await expect(privacy).toBeVisible();
  await expect(privacy.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(page.locator('#status')).toBeEmpty();
  await page.evaluate(() => window.releaseShareCompression());
  await expect(page.locator('#share-button')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#share-dialog')).not.toBeVisible();
  await expect(privacy).toBeVisible();
  await expect(privacy.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(page.locator('#status')).toBeEmpty();
  await expect(page.locator('#text-input')).toHaveValue('Keep my current text');
});

test('password-protected sharing copies the password separately and opens only after a correct password', async ({ page, browser }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = '  Protected résumé 👩‍💻\n<script>window.sharedScriptRan=true</script>\n\tKeep spacing  ';
  await generateLink(page, text);
  const { link, password } = await protectLink(page);
  expect(password.length).toBeGreaterThanOrEqual(20);
  expect(link).not.toContain(password);
  await expect(page.getByRole('dialog', { name: 'Share', exact: true })).toContainText(/send .* separately/i);
  await page.getByRole('button', { name: 'Copy password', exact: true }).click();
  await expect(page.locator('#share-status')).toContainText(/password copied/i);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([password, link]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  const recipientContext = await browser.newContext();
  const recipient = await recipientContext.newPage();
  await mockClipboard(recipient);
  const requests = [];
  recipient.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  await recipient.goto(link);
  const unlock = recipient.getByRole('dialog', { name: 'Password required', exact: true });
  await expect(unlock).toBeVisible();
  await expect(recipient.locator('#text-input')).toHaveValue('');
  await expect(recipient).toHaveURL('http://127.0.0.1:4174/plainlet/');
  await unlock.getByLabel('Password', { exact: true }).fill('This is the wrong password');
  await unlock.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(recipient.locator('#unlock-status')).toContainText('Wrong password or damaged link.');
  await expect(unlock).toBeVisible();
  await expect(recipient.locator('#text-input')).toHaveValue('');
  await unlock.getByLabel('Password', { exact: true }).fill(password);
  await unlock.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(unlock).not.toBeVisible();
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  await expect(recipient.locator('#unlock-password')).toHaveValue('');
  expect(await recipient.evaluate(() => window.sharedScriptRan)).toBeUndefined();
  expect(await recipient.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await recipient.getByRole('button', { name: 'History', exact: true }).click();
  await expect(recipient.getByRole('dialog', { name: 'History', exact: true }).getByRole('listitem')).toHaveCount(0);
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).origin).toBe('http://127.0.0.1:4174');
    expect(new URL(request.url).hash).toBe('');
    expect(request.url).not.toContain(password);
  }
  await recipient.reload();
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('');
  await expect(unlock).not.toBeVisible();
  await recipientContext.close();
});

test('password protection starts blank and accepts a chosen password without requiring Generate', async ({ page, context }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = 'Protected using my own password';
  await generateLink(page, text);
  await page.getByRole('checkbox', { name: 'Password protect', exact: true }).check();
  const chosen = '  My chosen résumé password 🔑  ';
  const field = page.locator('#share-password');
  await expect(field).toHaveValue('');
  await expect(page.locator('#share-link')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
  await field.fill(chosen);
  await expect(page.locator('#share-link')).toHaveValue(/#share=3\./);
  const link = await page.locator('#share-link').inputValue();
  expect(link).not.toContain(encodeURIComponent(chosen));
  await page.getByRole('button', { name: 'Copy password', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([chosen]);
  const recipient = await context.newPage();
  await mockClipboard(recipient);
  await recipient.goto(link);
  const unlock = recipient.getByRole('dialog', { name: 'Password required', exact: true });
  await unlock.getByLabel('Password', { exact: true }).fill(chosen);
  await unlock.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
});

for (const cancel of ['Cancel', 'Escape']) {
  test(`cancelling password entry with ${cancel} preserves existing text and forgets the incoming link`, async ({ page }) => {
    await mockClipboard(page);
    await page.goto('./');
    await generateLink(page, 'Incoming protected text');
    const { link } = await protectLink(page);
    await closeShare(page);
    await page.getByRole('textbox', { name: 'Your plain text' }).fill('Keep my current work');
    await page.evaluate((url) => { location.hash = new URL(url).hash; }, link);
    const unlock = page.getByRole('dialog', { name: 'Password required', exact: true });
    await expect(unlock).toBeVisible();
    await unlock.getByLabel('Password', { exact: true }).fill('Discard this password');
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await unlock.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(unlock).not.toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('Keep my current work');
    await expect(page.locator('#unlock-password')).toHaveValue('');
    await expect(page).toHaveURL('http://127.0.0.1:4174/plainlet/');
    await page.reload();
    await expect(unlock).not.toBeVisible();
  });
}

test('turning password protection off or closing Share clears it and restores the ordinary flow', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = 'Choose protection only when needed';
  const plain = await generateLink(page, text);
  const first = await protectLink(page);
  await page.getByRole('checkbox', { name: 'Password protect', exact: true }).uncheck();
  await expect(page.locator('#share-password')).not.toBeVisible();
  await expect(page.locator('#share-password')).toHaveValue('');
  await expect(page.locator('#share-link')).toHaveValue(plain);
  const second = await protectLink(page);
  expect(second.password).not.toBe(first.password);
  await closeShare(page);
  await expect(page.locator('#share-password')).toHaveValue('');
  await expect(page.locator('#share-link')).toHaveValue('');
  const again = await generateLink(page, text);
  expect(again).toBe(plain);
  await expect(page.getByRole('checkbox', { name: 'Password protect', exact: true })).not.toBeChecked();
  await expect(page.locator('#share-password')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
});

test('a pending password derivation cannot expose or restore an old ordinary link', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const plain = await generateLink(page, 'A snapshot with optional protection');
  await page.evaluate(() => {
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.deriveKey = (...args) => new Promise((resolve, reject) => {
      window.releasePasswordDerivation = () => derive(...args).then(resolve, reject);
    });
    crypto.subtle.encrypt = (...args) => encrypt(...args).finally(() => { window.passwordEncryptionFinished = true; });
  });
  await page.getByRole('checkbox', { name: 'Password protect', exact: true }).check();
  await page.getByRole('button', { name: 'Generate password', exact: true }).click();
  await page.waitForFunction(() => typeof window.releasePasswordDerivation === 'function');
  await expect(page.locator('#share-link')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
  await page.getByRole('checkbox', { name: 'Password protect', exact: true }).uncheck();
  await expect(page.locator('#share-link')).toHaveValue(plain);
  await page.evaluate(() => window.releasePasswordDerivation());
  await page.waitForFunction(() => window.passwordEncryptionFinished);
  await expect(page.locator('#share-link')).toHaveValue(plain);
  await expect(page.locator('#share-password')).toHaveValue('');
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([plain]);
});

test('changing a password while encryption is pending never makes the previous password link copyable', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await generateLink(page, 'Use the most recently entered password');
  const generated = await protectLink(page);
  await page.evaluate(() => {
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
    window.originalPasswordDerive = derive;
    crypto.subtle.deriveKey = (...args) => new Promise((resolve, reject) => {
      window.passwordDerivations ??= [];
      window.passwordDerivations.push(() => derive(...args).then(resolve, reject));
    });
  });
  await page.locator('#share-password').fill('First chosen password');
  await page.waitForFunction(() => window.passwordDerivations?.length === 1);
  const chosen = '  Second chosen résumé password 🔑  ';
  await page.locator('#share-password').fill(chosen);
  await expect(page.locator('#share-link')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
  await page.evaluate(() => window.passwordDerivations[0]());
  await page.waitForFunction(() => window.passwordDerivations?.length === 2);
  await expect(page.locator('#share-link')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled();
  await page.evaluate(() => window.passwordDerivations[1]());
  await expect(page.locator('#share-link')).toHaveValue(/#share=3\./);
  const link = await page.locator('#share-link').inputValue();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([link]);
  const result = await page.evaluate(async ({ url, chosen, generated }) => {
    const { readShareLink } = await import('./share-link.js');
    crypto.subtle.deriveKey = window.originalPasswordDerive;
    const hash = new URL(url).hash;
    const text = await readShareLink(hash, { password: chosen });
    const rejected = [];
    for (const password of [generated, 'First chosen password']) {
      try { await readShareLink(hash, { password }); rejected.push('accepted'); }
      catch (error) { rejected.push(error.code); }
    }
    return { text, rejected };
  }, { url: link, chosen, generated: generated.password });
  expect(result.text).toBe('Use the most recently entered password');
  expect(result.rejected).toEqual(['wrong-password', 'wrong-password']);
});

test('password copying has a manual fallback and protected controls fit a narrow screen', async ({ page }, testInfo) => {
  await mockClipboard(page, { denied: true });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('./');
  await generateLink(page, 'Protected on a phone');
  const { password } = await protectLink(page);
  await page.getByRole('button', { name: 'Copy password', exact: true }).click();
  const field = page.locator('#share-password');
  await expect(field).toBeFocused();
  expect(await field.evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([0, password.length]);
  await expect(page.locator('#share-status')).toContainText('Ctrl+C or ⌘C');
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
  const dialog = page.getByRole('dialog', { name: 'Share', exact: true });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  for (const button of await dialog.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ path: testInfo.outputPath('password-share-mobile.png'), fullPage: true });
});

test('password-protected snapshots also open offline using the cached app', async ({ page, context }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = 'Password-protected offline text. '.repeat(200);
  await generateLink(page, text);
  const { link, password } = await protectLink(page);
  await closeShare(page);
  await expect(page.locator('#offline-status')).toHaveText('Ready to work offline');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  const recipient = await context.newPage();
  await mockClipboard(recipient);
  await recipient.goto(link);
  const unlock = recipient.getByRole('dialog', { name: 'Password required', exact: true });
  await expect(unlock).toBeVisible();
  await unlock.getByLabel('Password', { exact: true }).fill(password);
  await unlock.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
  expect(await recipient.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('changing an already-copied password link reminds the sender to copy the updated link', async ({ page, context }) => {
  await mockClipboard(page);
  await page.goto('./');
  const text = 'Use the updated password and updated link together';
  await generateLink(page, text);
  const original = await protectLink(page);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  const chosen = 'A newly chosen password for this snapshot';
  await page.locator('#share-password').fill(chosen);
  await expect(page.locator('#share-status')).toHaveText('Link changed. Copy the new link.');
  const updated = await page.locator('#share-link').inputValue();
  expect(updated).not.toBe(original.link);
  await page.getByRole('button', { name: 'Copy password', exact: true }).click();
  await expect(page.locator('#share-status')).toContainText('Copy the updated link too.');
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.locator('#share-status')).toHaveText('Share link copied.');
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([original.link, chosen, updated]);

  const recipient = await context.newPage();
  await mockClipboard(recipient);
  await recipient.goto(updated);
  const unlock = recipient.getByRole('dialog', { name: 'Password required', exact: true });
  await unlock.getByLabel('Password', { exact: true }).fill(original.password);
  await unlock.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(recipient.locator('#unlock-status')).toContainText('Wrong password or damaged link.');
  await expect(recipient.locator('#text-input')).toHaveValue('');
  await unlock.getByLabel('Password', { exact: true }).fill(chosen);
  await unlock.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(recipient.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
});

test('Cancel and Escape during password derivation preserve the editor after late decryption finishes', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await generateLink(page, 'Incoming protected text');
  const { link, password } = await protectLink(page);
  await closeShare(page);
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Keep my current work');
  await page.evaluate(() => {
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.deriveKey = (...args) => new Promise((resolve, reject) => {
      window.releaseCancelledUnlock = () => derive(...args).then(resolve, reject);
    });
    crypto.subtle.decrypt = (...args) => decrypt(...args).finally(() => { window.cancelledUnlockFinished = true; });
  });
  for (const cancel of ['Cancel', 'Escape']) {
    await page.evaluate((url) => {
      window.releaseCancelledUnlock = undefined;
      window.cancelledUnlockFinished = false;
      location.hash = new URL(url).hash;
    }, link);
    const unlock = page.getByRole('dialog', { name: 'Password required', exact: true });
    await expect(unlock).toBeVisible();
    await unlock.getByLabel('Password', { exact: true }).fill(password);
    await unlock.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForFunction(() => typeof window.releaseCancelledUnlock === 'function');
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await unlock.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(unlock).not.toBeVisible();
    await expect(page.locator('#unlock-password')).toHaveValue('');
    await page.evaluate(() => window.releaseCancelledUnlock());
    await page.waitForFunction(() => window.cancelledUnlockFinished);
    await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('Keep my current work');
    await expect(page.locator('#status')).toHaveText('Share link not opened. Your text is unchanged.');
    await expect(unlock).not.toBeVisible();
    await expect(page.locator('#unlock-password')).toHaveValue('');
    await expect(page).toHaveURL('http://127.0.0.1:4174/plainlet/');
  }
});

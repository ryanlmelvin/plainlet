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

test('sharing is available for nonempty text and copies a link without changing the current address', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await expect(share).toBeDisabled();
  const address = page.url();
  const text = 'A private snapshot';
  const link = await generateLink(page, text);
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:4174\/plainlet\/#share=/);
  expect(link).not.toContain(encodeURIComponent(text));
  expect(link.length).toBeLessThanOrEqual(8000);
  expect(page.url()).toBe(address);
  const dialog = page.getByRole('dialog', { name: 'Share', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Share link', exact: true })).toHaveAttribute('readonly', '');
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
    const link = await page.evaluate(async () => {
      const { createShareLink } = await import('./share-link.js');
      const result = await createShareLink('Older shared text', location.href);
      const original = crypto.subtle.decrypt.bind(crypto.subtle);
      crypto.subtle.decrypt = (...args) => new Promise((resolve, reject) => {
        window.releaseShareDecrypt = () => original(...args).then(resolve, reject).finally(() => { window.shareDecryptFinished = true; });
      });
      return result;
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
  await page.evaluate(() => {
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (...args) => new Promise((resolve, reject) => {
      window.releaseShareEncrypt = () => original(...args).then(resolve, reject).finally(() => { window.shareEncryptFinished = true; });
    });
  });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseShareEncrypt === 'function');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('New text');
  await page.evaluate(() => window.releaseShareEncrypt());
  await page.waitForFunction(() => window.shareEncryptFinished);
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
  await expect(help).toContainText(/AES-256-GCM/);
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

test('missing encryption support reports a useful error while ordinary copying keeps working', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Keep working in this browser');
  const link = await page.evaluate(async () => {
    const { createShareLink } = await import('./share-link.js');
    const result = await createShareLink('Incoming encrypted text', location.href);
    Object.defineProperty(crypto, 'subtle', { configurable: true, value: undefined });
    return result;
  });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.locator('#status')).toContainText(/unavailable.*browser/i);
  await expect(page.getByRole('dialog', { name: 'Share', exact: true })).not.toBeVisible();
  await page.evaluate((url) => { location.hash = new URL(url).hash; }, link);
  await expect(page.locator('#status')).toContainText(/browser cannot open/i);
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('Keep working in this browser');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual(['Keep working in this browser']);
});

test('opening History during incoming decryption keeps the shared text and dialog focus', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Earlier editor text');
  const link = await page.evaluate(async () => {
    const { createShareLink } = await import('./share-link.js');
    const result = await createShareLink('Shared text still arrives', location.href);
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.decrypt = (...args) => new Promise((resolve, reject) => {
      window.releaseShareDecrypt = () => original(...args).then(resolve, reject);
    });
    return result;
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

test('opening Privacy during link encryption cancels the outgoing dialog and its progress message', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox', { name: 'Your plain text' }).fill('Keep my current text');
  await page.evaluate(() => {
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (...args) => new Promise((resolve, reject) => {
      window.releaseShareEncrypt = () => original(...args).then(resolve, reject);
    });
  });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseShareEncrypt === 'function');
  await expect(page.locator('#status')).toHaveText('Creating share link…');
  await page.locator('.about-menu > summary').click();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  const privacy = page.getByRole('dialog', { name: 'Privacy', exact: true });
  await expect(privacy).toBeVisible();
  await expect(privacy.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(page.locator('#status')).toBeEmpty();
  await page.evaluate(() => window.releaseShareEncrypt());
  await expect(page.locator('#share-button')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#share-dialog')).not.toBeVisible();
  await expect(privacy).toBeVisible();
  await expect(privacy.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(page.locator('#status')).toBeEmpty();
  await expect(page.locator('#text-input')).toHaveValue('Keep my current text');
});

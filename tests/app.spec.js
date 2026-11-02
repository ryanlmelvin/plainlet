import { test, expect } from '@playwright/test';

// Never read or modify the machine's clipboard. Button interactions use this
// mock, while ordinary editing still uses Chromium's real textarea behavior.
async function mockClipboard(page, options = {}) {
  await page.addInitScript((settings) => {
    window.testClipboard = {
      text: settings.text ?? '',
      written: [],
      readMode: settings.readMode ?? 'success',
      writeMode: settings.writeMode ?? 'success',
      resolveRead: null,
    };
    const clipboard = {
      readText() {
        const state = window.testClipboard;
        if (state.readMode === 'denied') return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
        if (state.readMode === 'pending') return new Promise((resolve) => { state.resolveRead = resolve; });
        return Promise.resolve(state.text);
      },
      writeText(text) {
        const state = window.testClipboard;
        if (state.writeMode === 'denied') return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
        state.written.push({ type: 'text/plain', text });
        return Promise.resolve();
      },
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: settings.unsupported ? undefined : clipboard,
    });
    // The deprecated fallback is also mocked, so failed API tests cannot
    // accidentally fall through to an OS clipboard write.
    document.execCommand = () => false;
  }, options);
}

test('has exactly three controls with useful empty-state behavior', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await expect(page.locator('.toolbar').getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Clear text' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toBeEditable();
});

test('paste and copy preserve Unicode, literal HTML, spacing, and newlines', async ({ page }) => {
  const text = '  Résumé — 你好 👩‍💻\n\t<b>literal HTML</b>\n\ntrailing spaces  ';
  await mockClipboard(page, { text });
  await page.goto('./');
  await page.getByRole('textbox').fill('Old buffer');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue(text);
  await expect(page.getByRole('status')).toHaveText('Pasted as plain text.');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Plain text copied.');
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([{ type: 'text/plain', text }]);
  await expect(page.locator('textarea b')).toHaveCount(0);
});

test('keyboard editing remains a plain-text buffer and clear restores focus', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const input = page.getByRole('textbox');
  await input.focus();
  await page.keyboard.insertText('Hello <strong>world</strong>');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('  👋  ');
  await expect(input).toHaveValue('Hello <strong>world</strong>\n  👋  ');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written[0].text)).toBe('Hello <strong>world</strong>\n  👋  ');
  await page.getByRole('button', { name: 'Clear text' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
});

test('an empty clipboard does not erase existing text', async ({ page }) => {
  await mockClipboard(page, { text: '' });
  await page.goto('./');
  await page.getByRole('textbox').fill('Keep this');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('Keep this');
  await expect(page.getByRole('status')).toContainText('No text found');
});

for (const settings of [{ readMode: 'denied' }, { unsupported: true }]) {
  test(`paste ${settings.unsupported ? 'unsupported' : 'denied'} preserves text and explains manual paste`, async ({ page }) => {
    await mockClipboard(page, settings);
    await page.goto('./');
    await page.getByRole('textbox').fill('Keep this');
    await page.getByRole('button', { name: 'Paste', exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveValue('Keep this');
    await expect(page.getByRole('textbox')).toBeFocused();
    await expect(page.getByRole('status')).toContainText('Ctrl+V or ⌘V');
    await expect(page.getByRole('status')).toContainText('touch and hold');
  });
}

test('clear cancels a delayed clipboard read, including from an empty buffer', async ({ page }) => {
  await mockClipboard(page, { readMode: 'pending' });
  await page.goto('./');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear text' })).toBeEnabled();
  await page.getByRole('button', { name: 'Clear text' }).click();
  await page.evaluate(() => window.testClipboard.resolveRead('Late clipboard text'));
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(page.getByRole('status')).toHaveText('Text cleared.');
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
});

test('typing cancels a delayed clipboard read', async ({ page }) => {
  await mockClipboard(page, { readMode: 'pending' });
  await page.goto('./');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await page.getByRole('textbox').fill('Newer work');
  await page.evaluate(() => window.testClipboard.resolveRead('Old clipboard text'));
  await expect(page.getByRole('textbox')).toHaveValue('Newer work');
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
});

test('failed copy selects text and explains the manual fallback', async ({ page }) => {
  await mockClipboard(page, { writeMode: 'denied' });
  await page.goto('./');
  await page.getByRole('textbox').fill('Copy me manually');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Ctrl+C or ⌘C');
  await expect(page.getByRole('textbox')).toBeFocused();
  expect(await page.getByRole('textbox').evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([0, 16]);
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
});

test('a reload clears the buffer without saving text in browser storage', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await page.getByRole('textbox').fill('Private text must not persist');
  await page.reload();
  await expect(page.getByRole('textbox')).toHaveValue('');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('manifest assets resolve under the GitHub Pages subpath and work offline', async ({ page, context, request }) => {
  await mockClipboard(page, { text: 'Available offline' });
  await page.goto('./');
  const manifestURL = await page.locator('link[rel="manifest"]').evaluate((link) => link.href);
  const manifestResponse = await request.get(manifestURL);
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(new URL(manifest.start_url, manifestURL).pathname).toBe('/plainlet/');
  expect(new URL(manifest.scope, manifestURL).pathname).toBe('/plainlet/');
  for (const icon of manifest.icons) {
    const response = await request.get(new URL(icon.src, manifestURL).href);
    expect(response.ok(), icon.src).toBeTruthy();
    expect(response.headers()['content-type']).toBe('image/png');
    const bytes = await response.body();
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    const [width, height] = icon.sizes.split('x').map(Number);
    expect(bytes.readUInt32BE(16)).toBe(width);
    expect(bytes.readUInt32BE(20)).toBe(height);
  }
  await expect(page.locator('#offline-status')).toHaveText('Ready to work offline');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.getByRole('textbox').fill('Never cache this text');
  const storedURLs = await page.evaluate(async () => {
    const names = await caches.keys();
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((entry) => entry.url)))).flat();
  });
  expect(storedURLs.length).toBeGreaterThan(0);
  expect(storedURLs.every((url) => url.startsWith('http://127.0.0.1:4174/plainlet/'))).toBeTruthy();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox')).toHaveValue('');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('Available offline');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Plain text copied.');
});

test('desktop layout has no overflow and produces a review screenshot', async ({ page }, testInfo) => {
  await mockClipboard(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  await expect(page.locator('#offline-status')).toHaveText('Ready to work offline');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
});

test('mobile layout keeps all three controls usable without horizontal overflow', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await mockClipboard(page);
  await page.goto('http://127.0.0.1:4174/plainlet/');
  await expect(page.locator('#offline-status')).toHaveText('Ready to work offline');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  for (const button of await page.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  }
  await page.getByRole('textbox').fill('A little plain text.');
  await page.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect(page.getByRole('status')).toHaveText('Plain text copied.');
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  await context.close();
});

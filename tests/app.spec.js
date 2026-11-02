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

test('keeps history immediately beside copy on the right of the editor toolbar', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await expect(page.locator('.toolbar').getByRole('button')).toHaveText(['Paste', 'Clear text', 'History', 'Copy']);
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Clear text' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toBeEditable();
  const historyButton = page.getByRole('button', { name: 'History', exact: true });
  await expect(historyButton).toBeEnabled();
  const copyBounds = await page.getByRole('button', { name: 'Copy', exact: true }).boundingBox();
  const historyBounds = await historyButton.boundingBox();
  const toolbarGap = await page.locator('.toolbar').evaluate((toolbar) => parseFloat(getComputedStyle(toolbar).columnGap));
  expect(historyBounds.y).toBe(copyBounds.y);
  expect(copyBounds.x - historyBounds.x - historyBounds.width).toBeCloseTo(toolbarGap, 1);
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

test('a reload clears typed text without adding it to history', async ({ page }) => {
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

test('mobile layout keeps the editor and history controls usable without horizontal overflow', async ({ browser }, testInfo) => {
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

async function pasteText(page, text) {
  await page.evaluate((value) => { window.testClipboard.text = value; }, text);
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue(text);
}

async function openHistory(page) {
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History', exact: true });
  await expect(history).toBeVisible();
  return history;
}

test('empty history can be closed with Escape and returns focus to its button', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const history = await openHistory(page);
  await expect(history.getByRole('listitem')).toHaveCount(0);
  await expect(history.getByRole('button', { name: 'Clear history', exact: true })).toBeDisabled();
  await expect(history.getByRole('button', { name: 'Close history', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toBeFocused();
});

test('history saves successful pastes newest first, coalesces duplicates, and survives reload', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const first = '  Résumé — 你好 👩‍💻\n\t<b>literal HTML</b>\n\ntrailing spaces  ';
  await pasteText(page, first);
  await pasteText(page, 'Second paste');
  await pasteText(page, first);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Your plain text' })).toHaveValue('');
  const history = await openHistory(page);
  await expect(history.getByRole('listitem')).toHaveCount(2);
  expect(await history.locator('pre').allTextContents()).toEqual([first, 'Second paste']);
  await expect(history.locator('b')).toHaveCount(0);
});

test('native paste records its plain text payload without recording typing or empty pastes', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const input = page.getByRole('textbox', { name: 'Your plain text' });
  await input.fill('Typed prefix: ');
  await input.evaluate((field) => {
    const data = new DataTransfer();
    data.setData('text/plain', ' \n\t ');
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const pasted = '<img src=x onerror="window.unexpectedMarkup = true">\nPlain paste';
  // Dispatch the browser events without accessing the machine clipboard. A
  // synthetic paste has no default insertion, so reproduce that insertion only
  // when the app has left the event's default behavior intact.
  await input.evaluate((field, text) => {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    data.setData('text/html', '<strong>Unwanted rich text</strong>');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    if (!event.defaultPrevented) {
      field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: text, bubbles: true }));
    }
  }, pasted);
  await expect(input).toHaveValue(`Typed prefix: ${pasted}`);
  await input.fill('Edited after pasting');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(input).toHaveValue('Edited after pasting');
  const history = await openHistory(page);
  await expect(history.getByRole('listitem')).toHaveCount(1);
  expect(await history.locator('pre').allTextContents()).toEqual([pasted]);
  await expect(history.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.unexpectedMarkup)).toBeUndefined();
});

test('history copies the exact past paste without replacing the current editor text', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const saved = '  Saved 👋\n\t<b>plain text</b>  ';
  await pasteText(page, saved);
  await page.getByRole('textbox').fill('Keep editing this');
  const history = await openHistory(page);
  await history.getByRole('listitem').getByRole('button', { name: 'Copy paste', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([{ type: 'text/plain', text: saved }]);
  await expect(history.getByRole('status')).toContainText('copied');
  await expect(page.locator('#text-input')).toHaveValue('Keep editing this');
  await expect(history.getByRole('listitem')).toHaveCount(1);
});

test('loading a past paste restores its exact text for sharing without changing history or the clipboard', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const saved = '  Résumé — 你好 👩‍💻\n\t<b>literal HTML</b>\n\ntrailing spaces  ';
  await pasteText(page, saved);
  await pasteText(page, 'A newer paste');
  const savedStorage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  const editor = page.getByRole('textbox', { name: 'Your plain text', exact: true });
  await editor.fill('Replace this current buffer');
  const history = await openHistory(page);
  await history.locator('pre').filter({ hasText: 'Résumé' }).click();
  await expect(history).not.toBeVisible();
  await expect(editor).toHaveValue(saved);
  await expect(editor).toBeFocused();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).toBe(savedStorage);

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share', exact: true });
  await expect(share).toBeVisible();
  const link = await share.getByRole('textbox', { name: 'Share link', exact: true }).inputValue();
  expect(await page.evaluate(async (url) => {
    const { readShareLink } = await import('./share-link.js');
    return readShareLink(new URL(url).hash);
  }, link)).toBe(saved);
  await share.getByRole('button', { name: 'Close', exact: true }).click();
  await openHistory(page);
  expect(await history.locator('pre').allTextContents()).toEqual(['A newer paste', saved]);
});

test('history row padding, action-area whitespace, Enter and Space all load the paste', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const saved = 'Saved text\nwith another line\nand a third line';
  await pasteText(page, saved);
  const editor = page.getByRole('textbox', { name: 'Your plain text', exact: true });
  for (const activation of ['row padding', 'action whitespace', 'Enter', 'Space']) {
    await editor.fill(`Current text before ${activation}`);
    const history = await openHistory(page);
    const row = history.getByRole('listitem');
    if (activation === 'row padding') {
      await row.click({ position: { x: 2, y: 2 } });
    } else if (activation === 'action whitespace') {
      const actions = row.locator('.history-actions');
      const bounds = await actions.boundingBox();
      // Below the icon buttons is still part of the entry, not a button.
      await actions.click({ position: { x: 2, y: bounds.height - 2 } });
    } else {
      const preview = row.locator('pre');
      await expect(preview).toHaveAttribute('role', 'button');
      await preview.focus();
      await page.keyboard.press(activation);
    }
    await expect(history).not.toBeVisible();
    await expect(editor).toHaveValue(saved);
    await expect(editor).toBeFocused();
  }
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
});

test('loading history cancels a pending clipboard read so it cannot overwrite the restored text', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const saved = 'The paste chosen from history';
  await pasteText(page, saved);
  await page.getByRole('textbox', { name: 'Your plain text', exact: true }).fill('Current work');
  await page.evaluate(() => { window.testClipboard.readMode = 'pending'; });
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  const history = await openHistory(page);
  await history.locator('pre').click();
  await expect(history).not.toBeVisible();
  await page.evaluate(() => window.testClipboard.resolveRead('Late clipboard content'));
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Your plain text', exact: true })).toHaveValue(saved);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
  await openHistory(page);
  expect(await history.locator('pre').allTextContents()).toEqual([saved]);
});

test('loading history cancels a failed pending history copy without selecting hidden text', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const saved = 'Restore this saved paste';
  await pasteText(page, saved);
  await page.getByRole('textbox', { name: 'Your plain text', exact: true }).fill('Current work');
  await page.evaluate(() => {
    window.testClipboard.fallbackCalls = [];
    navigator.clipboard.writeText = () => new Promise((resolve, reject) => {
      window.testClipboard.rejectWrite = reject;
    });
    document.execCommand = (command) => {
      window.testClipboard.fallbackCalls.push(command);
      return false;
    };
  });
  const history = await openHistory(page);
  const copy = history.getByRole('button', { name: 'Copy paste', exact: true });
  await copy.click();
  await expect(copy).toHaveAttribute('aria-busy', 'true');
  await history.locator('pre').click();
  await expect(history).not.toBeVisible();
  await page.evaluate(() => window.testClipboard.rejectWrite(new DOMException('Denied', 'NotAllowedError')));
  await expect(page.locator('#history-dialog [data-action="Copy"]')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => window.testClipboard.fallbackCalls)).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Your plain text', exact: true })).toHaveValue(saved);
  await expect(page.getByRole('textbox', { name: 'Your plain text', exact: true })).toBeFocused();
});

test('deleting one paste and clearing history persist without clearing the editor', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  await pasteText(page, 'First paste');
  await pasteText(page, 'Second paste');
  let history = await openHistory(page);
  await history.getByRole('listitem').filter({ hasText: 'First paste' }).getByRole('button', { name: 'Delete paste', exact: true }).click();
  await expect(history.getByRole('listitem')).toHaveCount(1);
  expect(await history.locator('pre').allTextContents()).toEqual(['Second paste']);
  await expect(page.locator('#text-input')).toHaveValue('Second paste');
  await page.reload();
  await page.getByRole('textbox').fill('Unrelated current work');
  history = await openHistory(page);
  expect(await history.locator('pre').allTextContents()).toEqual(['Second paste']);
  await history.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(history.getByRole('listitem')).toHaveCount(0);
  await expect(history.getByRole('button', { name: 'Clear history', exact: true })).toBeDisabled();
  await expect(page.locator('#text-input')).toHaveValue('Unrelated current work');
  await page.reload();
  history = await openHistory(page);
  await expect(history.getByRole('listitem')).toHaveCount(0);
});

test('history additions, deletion, and clearing stay in sync across tabs', async ({ page, context }) => {
  await mockClipboard(page);
  await page.goto('./');
  await pasteText(page, 'First tab paste');
  const secondPage = await context.newPage();
  await mockClipboard(secondPage);
  await secondPage.goto('./');
  const secondHistory = await openHistory(secondPage);
  await expect(secondHistory.locator('pre')).toHaveText(['First tab paste']);
  await pasteText(page, 'Another paste');
  await expect(secondHistory.locator('pre')).toHaveText(['Another paste', 'First tab paste']);
  await secondHistory.getByRole('listitem').filter({ hasText: 'First tab paste' }).getByRole('button', { name: 'Delete paste', exact: true }).click();
  const firstHistory = await openHistory(page);
  await expect(firstHistory.locator('pre')).toHaveText(['Another paste']);
  await firstHistory.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(secondHistory.getByRole('listitem')).toHaveCount(0);
  await secondHistory.getByRole('button', { name: 'Close history', exact: true }).click();
  await pasteText(secondPage, 'After clearing');
  await expect(firstHistory.locator('pre')).toHaveText(['After clearing']);
  await secondPage.close();
});

test('cancelled and denied clipboard reads never enter history', async ({ page }) => {
  await mockClipboard(page, { readMode: 'pending' });
  await page.goto('./');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await page.getByRole('button', { name: 'Clear text', exact: true }).click();
  await page.evaluate(() => window.testClipboard.resolveRead('Cancelled paste'));
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.testClipboard.readMode = 'denied'; });
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Clipboard access is unavailable');
  const history = await openHistory(page);
  await expect(history.getByRole('listitem')).toHaveCount(0);
});

test('unavailable storage preserves pasted text and history for the current session', async ({ page }) => {
  await mockClipboard(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await page.goto('./');
  await pasteText(page, 'Still usable when storage is full');
  await expect(page.getByRole('status')).toContainText('History could not be saved');
  await expect(page.getByRole('status')).toContainText('while this page is open');
  let history = await openHistory(page);
  expect(await history.locator('pre').allTextContents()).toEqual(['Still usable when storage is full']);
  await history.getByRole('button', { name: 'Copy paste', exact: true }).click();
  expect(await page.evaluate(() => window.testClipboard.written[0].text)).toBe('Still usable when storage is full');
  await page.reload();
  history = await openHistory(page);
  await expect(history.getByRole('listitem')).toHaveCount(0);
});

test('failed history copy selects the saved text and preserves current work', async ({ page }) => {
  await mockClipboard(page, { writeMode: 'denied' });
  await page.goto('./');
  await pasteText(page, 'Copy saved text manually');
  await page.getByRole('textbox').fill('Current work stays here');
  const history = await openHistory(page);
  await history.getByRole('button', { name: 'Copy paste', exact: true }).click();
  await expect(history.getByRole('status')).toContainText('Ctrl+C or ⌘C');
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('Copy saved text manually');
  await expect(page.locator('#text-input')).toHaveValue('Current work stays here');
  expect(await page.evaluate(() => window.testClipboard.written)).toEqual([]);
});

test('opening history prevents a pending editor copy from selecting text behind the dialog', async ({ page }) => {
  await mockClipboard(page);
  await page.goto('./');
  const input = page.getByRole('textbox', { name: 'Your plain text' });
  await input.fill('Keep this selection');
  await input.evaluate((field) => { field.setSelectionRange(3, 3); });
  await page.evaluate(() => {
    window.testClipboard.fallbackCalls = [];
    navigator.clipboard.writeText = () => new Promise((resolve, reject) => {
      window.testClipboard.rejectWrite = reject;
    });
    document.execCommand = (command) => {
      window.testClipboard.fallbackCalls.push(command);
      return false;
    };
  });
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const history = await openHistory(page);
  await page.evaluate(() => window.testClipboard.rejectWrite(new DOMException('Denied', 'NotAllowedError')));
  await expect(page.locator('#copy-button')).toBeEnabled();
  expect(await page.evaluate(() => window.testClipboard.fallbackCalls)).toEqual([]);
  expect(await page.locator('#text-input').evaluate((field) => [field.selectionStart, field.selectionEnd])).toEqual([3, 3]);
  await expect(history).toBeVisible();
  await expect(history.getByRole('button', { name: 'Close history', exact: true })).toBeFocused();
});

test('mobile history wraps long pastes and keeps icon controls usable', async ({ page }, testInfo) => {
  await mockClipboard(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./');
  await pasteText(page, 'LongUnbrokenPaste'.repeat(80));
  await pasteText(page, 'Another paste\nwith a second line');
  const history = await openHistory(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await history.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBeTruthy();
  for (const button of await history.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  }
  for (const icon of await history.locator('button svg').all()) {
    await expect(icon).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-history.png'), fullPage: true });
});

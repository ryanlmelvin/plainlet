import { test as base, expect } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const docsRoot = fileURLToPath(new URL('../docs/', import.meta.url));
const mimeTypes = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// The pre-notification release cached the editor and registered a worker once,
// but had no update listener, activation message, or reload action.
const legacyWorker = `
const VERSION = 'legacy';
const SCOPE = new URL('./', self.location.href).href;
const CACHE = 'plainlet:' + SCOPE + ':' + VERSION;
const FILES = ['./', './index.html', './styles.css', './app.js', './text-buffer.js', './paste-history.js', './sw-register.js', './icons/icon.svg'];
const URLS = new Set(FILES.map(file => new URL(file, SCOPE).href));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  url.search = '';
  if (event.request.method !== 'GET' || !URLS.has(url.href)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href)) || fetch(event.request)));
});
`;
const legacyRegistration = `
navigator.serviceWorker.register('./sw.js', { scope: './' })
  .then(() => navigator.serviceWorker.ready)
  .then(() => { document.querySelector('#offline-status').textContent = 'Ready to work offline'; });
`;

// Each test owns an origin and two real releases. Cacheable responses make a
// stale HTTP-cache install visible instead of merely testing a mocked worker.
const test = base.extend({
  releases: async ({}, use) => {
    const state = { version: 1, brokenAsset: null, workerRequests: 0, legacy: false };
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      const relative = url.pathname.replace(/^\/plainlet\//, '') || 'index.html';
      if (!url.pathname.startsWith('/plainlet/') || relative.includes('..')) {
        response.writeHead(404).end();
        return;
      }
      if (relative === 'sw.js') state.workerRequests += 1;
      if (relative === state.brokenAsset) {
        response.writeHead(503, { 'Cache-Control': 'no-store' }).end('Unavailable');
        return;
      }
      try {
        let content = await readFile(path.join(docsRoot, relative));
        if (state.legacy && state.version === 1) {
          if (relative === 'sw.js') content = legacyWorker;
          if (relative === 'sw-register.js') content = legacyRegistration;
          if (relative === 'app.js') {
            content = content.toString()
              .replace("import { restoreUpdateText, setupUpdates } from './sw-register.js';\n", '')
              .replace('restoreUpdateText(input);\n', '')
              .replace('setupUpdates(input);', '');
          }
          if (relative === 'index.html') {
            content = content.toString()
              .replace(/\s*<div id="update-notice"[\s\S]*?<\/div>/, '')
              .replace('</head>', '<script type="module" src="./sw-register.js"></script></head>');
          }
        }
        if (relative === 'sw.js') {
          content = content.toString().replace(/const VERSION = '[^']+';/, `const VERSION = 'update-test-${state.version}';`);
        } else if (relative === 'index.html') {
          content = content.toString().replace('<html lang="en">', `<html lang="en" data-test-release="${state.version}">`);
        } else if (relative === 'styles.css') {
          content = `${content}\n:root{--test-release:${state.version}}`;
        }
        response.writeHead(200, {
          'Content-Type': mimeTypes[path.extname(relative)] || 'application/octet-stream',
          'Cache-Control': relative === 'sw.js' ? 'no-store' : 'public, max-age=3600',
        }).end(content);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await use({ state, url: `http://127.0.0.1:${server.address().port}/plainlet/` });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});

async function loadInstalled(page, releases) {
  await page.goto(releases.url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await expect(page.locator('#update-notice')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
}

async function installNext(page, releases) {
  releases.state.version += 1;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await expect(page.locator('#update-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
}

test('an available update waits for a click, preserves text, and installs fresh offline assets', async ({ page, context, releases }) => {
  await loadInstalled(page, releases);
  const text = '  Keep my résumé 👋\n\t<b>literal text</b>\ntrailing spaces  ';
  await page.getByRole('textbox', { name: 'Your plain text' }).fill(text);
  await installNext(page, releases);
  await expect(page.locator('#update-notice')).toContainText('Update available');
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
  await expect(page.getByRole('textbox')).toHaveValue(text);

  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  // The update is completely downloaded before the button appears.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '2');
  await expect(page.getByRole('textbox')).toHaveValue(text);
  await expect(page.locator('#update-notice')).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--test-release').trim())).toBe('2');
  expect(navigations).toBe(1);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

  await page.reload();
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '2');
});

test('a tab opened after an update is already waiting immediately offers it', async ({ page, context, releases }, testInfo) => {
  await loadInstalled(page, releases);
  await installNext(page, releases);
  const other = await context.newPage();
  await other.setViewportSize({ width: 320, height: 640 });
  await other.goto(releases.url);
  await expect(other.locator('html')).toHaveAttribute('data-test-release', '1');
  await expect(other.getByRole('button', { name: 'Update now', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
  expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const bounds = await other.getByRole('button', { name: 'Update now', exact: true }).boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await other.screenshot({ path: testInfo.outputPath('update-notice-mobile.png'), fullPage: true });
});

test('updating one tab leaves another tab and its text intact until its own update click', async ({ page, context, releases }) => {
  await loadInstalled(page, releases);
  const other = await context.newPage();
  await other.goto(releases.url);
  await other.getByRole('textbox').fill('Do not interrupt this tab');
  await installNext(page, releases);
  await expect(other.locator('#update-notice')).toBeVisible();
  let otherNavigations = 0;
  other.on('framenavigated', (frame) => { if (frame === other.mainFrame()) otherNavigations += 1; });
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '2');
  await expect(other.getByRole('textbox')).toHaveValue('Do not interrupt this tab');
  await expect(other.locator('html')).toHaveAttribute('data-test-release', '1');
  expect(otherNavigations).toBe(0);
  await expect(other.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
  await other.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(other.locator('html')).toHaveAttribute('data-test-release', '2');
  await expect(other.getByRole('textbox')).toHaveValue('Do not interrupt this tab');
  expect(otherNavigations).toBe(1);
});

for (const eventName of ['focus', 'online', 'visibilitychange']) {
  test(`returning via ${eventName} checks for a new release`, async ({ page, releases }) => {
    await loadInstalled(page, releases);
    const previousChecks = releases.state.workerRequests;
    releases.state.version = 2;
    await page.evaluate((name) => {
      const target = name === 'visibilitychange' ? document : window;
      target.dispatchEvent(new Event(name));
    }, eventName);
    await expect(page.locator('#update-notice')).toBeVisible();
    expect(releases.state.workerRequests).toBeGreaterThan(previousChecks);
    await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
  });
}

test('a failed download keeps the old release usable and a later check can retry', async ({ page, releases }) => {
  await loadInstalled(page, releases);
  await page.getByRole('textbox').fill('Still editing');
  releases.state.version = 2;
  releases.state.brokenAsset = 'styles.css';
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    const installing = registration.installing;
    if (installing && installing.state !== 'redundant') {
      await new Promise((resolve) => installing.addEventListener('statechange', () => {
        if (installing.state === 'redundant') resolve();
      }));
    }
  });
  await expect(page.locator('#update-notice')).toBeHidden();
  await expect(page.getByRole('textbox')).toHaveValue('Still editing');
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
  releases.state.brokenAsset = null;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeVisible();
});

test('unavailable update storage does not reload away current text', async ({ page, releases }) => {
  await loadInstalled(page, releases);
  await page.getByRole('textbox').fill('Keep this unsaved text');
  await installNext(page, releases);
  await page.evaluate(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new DOMException('Blocked', 'SecurityError'); },
    });
  });
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator('#update-status')).not.toBeEmpty();
  await expect(page.getByRole('textbox')).toHaveValue('Keep this unsaved text');
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
});

test('the recovery page updates a legacy app without clearing history or another tab', async ({ page, context, releases }) => {
  releases.state.legacy = true;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'Saved before update notifications existed' },
    });
    document.execCommand = () => false;
  });
  await loadInstalled(page, releases);
  await expect(page.locator('#update-notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await page.getByRole('textbox').fill('Keep working in the old tab');
  releases.state.version = 2;

  const recovery = await context.newPage();
  await recovery.goto(`${releases.url}update.html`);
  await expect(recovery.getByRole('heading', { name: 'Update Plainlet', exact: true })).toBeVisible();
  await recovery.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(recovery).toHaveURL(releases.url);
  await expect(recovery.locator('html')).toHaveAttribute('data-test-release', '2');
  await recovery.getByRole('button', { name: 'History', exact: true }).click();
  await expect(recovery.getByRole('dialog', { name: 'History', exact: true }).locator('pre'))
    .toHaveText('Saved before update notifications existed');
  await expect(page.locator('html')).toHaveAttribute('data-test-release', '1');
  await expect(page.getByRole('textbox')).toHaveValue('Keep working in the old tab');
  expect(await recovery.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(names.map(async name => (await caches.open(name)).keys()));
    return requests.flat().some(request => new URL(request.url).pathname.endsWith('/update.html'));
  })).toBe(false);
});

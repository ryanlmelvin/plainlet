# Plainlet

A little space for plain text. Paste it in. Copy it clean.

**[Open Plainlet](https://ryanlmelvin.github.io/plainlet/)**

Plainlet is a small, installable web app with exactly three buttons:

- **Paste** reads plain text from your device clipboard and replaces the current buffer. If there is no text, the existing buffer stays intact.
- **Clear text** empties the buffer.
- **Copy** writes the buffer to the clipboard as plain text.

You can also type, edit, or paste directly into the text area. Rich-text styling is discarded; words, spacing, line breaks, emoji, and literal markup remain. This is a formatting remover, not an HTML-to-text converter or Markdown parser.

## Install and use offline

Open the app online once and wait for **Ready to work offline**. Install it through your browser's installation menu, or use **Share → Add to Home Screen** in Safari on iPhone/iPad. Installation availability depends on the browser. There is deliberately no fourth install button.

Clipboard buttons require HTTPS (or localhost) and may request browser permission. If access is blocked, focus the text area and use your device's normal Paste or Copy action. The app provides instructions when this happens.

## Privacy and storage

Text stays in the current page's memory. There are no uploads, analytics, accounts, saved drafts, or text history. Reloading starts with an empty buffer. Like other sites, a browser may keep a page alive when you navigate away and return.

The service worker caches only the app's static files for offline use. It does not cache clipboard content. Your browser/operating system still controls the system clipboard and any clipboard history it provides. GitHub Pages receives ordinary requests for app files, never the buffer's contents.

## Development

The app is plain HTML, CSS, and JavaScript. It has no runtime dependencies and needs no build step. Serve `docs/` with any static HTTP server, for example:

```sh
python3 -m http.server 4173 --directory docs
```

Open `http://localhost:4173`. Opening `index.html` directly as a file does not support the clipboard and service-worker features.

Browser tests use Playwright (development only):

```sh
npm ci
npm test
```

Local tests use installed Google Chrome. CI uses Playwright Chromium. The tests serve the app under `/plainlet/`, matching the GitHub Pages project path, and isolate clipboard behavior from your real clipboard.

## GitHub Pages

Publish the `docs/` directory on `main` using **Settings → Pages → Deploy from a branch**. All app, manifest, and service-worker paths are relative, so deployment also works under another repository name. `.nojekyll` disables Jekyll processing.

When changing any app file, increment `VERSION` in `docs/sw.js` so the next release gets a fresh offline cache. A new service worker activates after existing app tabs/windows close; it never forcibly reloads a page containing text. Reopen the app online to receive updates.

## Future history

`docs/text-buffer.js` owns an in-memory buffer with change subscriptions, independent of the interface and clipboard access. A future, explicitly enabled history store can subscribe to buffer changes without redesigning the app. No history storage or history interface is implemented now. Keep future user-data storage separate from the service worker's app-file cache.

## License

[MIT](LICENSE) · Copyright © 2026 Ryan L. Melvin

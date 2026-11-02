# Plainlet

A little space for plain text. Paste it in. Copy it clean.

**[Open Plainlet](https://ryanlmelvin.github.io/plainlet/)**

Plainlet is a small, installable web app:

- **Paste** reads plain text from your device clipboard and replaces the current buffer. If there is no text, the existing buffer stays intact.
- **Clear text** empties the buffer.
- **Copy** writes the buffer to the clipboard as plain text.
- **History**, beside Copy on the right, shows past pastes with a copy icon and a trash icon for each entry. **Clear history** removes all entries without changing the current buffer.
- **Share**, at the top right, creates a link containing a snapshot of the current text. Choose **Copy link** to share it. **Share?** in the Plainlet menu explains how it works.

You can also type, edit, or paste directly into the text area. Rich-text styling is discarded; words, spacing, line breaks, emoji, and literal markup remain. This is a formatting remover, not an HTML-to-text converter or Markdown parser.

## Share a snapshot

Shared text lives entirely in the URL fragment (after `#`), not on a server. **Share → Copy link** creates an ordinary link, compressing the text when that makes it smaller. Ordinary links are not encrypted: **anyone with the complete link can read the text**. They require no password or encryption work and leave more room for text than the original key-in-link format.

For a protected link, check **Password protect**, then enter a strong password or choose **Generate**. The password field starts empty; generation happens only when requested. **Copy link** stays disabled until the protected link is ready for the exact password shown. Every password edit clears the old link immediately and creates a new one. Copy the link and password separately; the recipient must enter the password to open the text. Plainlet never saves passwords and cannot recover forgotten ones. Passwords preserve all spaces and Unicode exactly, with a safety limit of 1,024 UTF-8 bytes.

Password protection uses AES-256-GCM with a fresh 128-bit salt and 96-bit nonce per link. PBKDF2-HMAC-SHA256 derives the encryption key from the password using 600,000 iterations; the work factor is fixed by the format, not controlled by a received link. Generate uses 32 cryptographically random bytes encoded as a 43-character password. Only the salt, nonce, and ciphertext are in the URL; neither the password nor key is included. Someone with the link can attempt password guesses offline, so choose a strong password or use Generate. Password protection does not authenticate the sender or revoke copies already opened.

Opening a link loads its snapshot into the editor without adding it to paste history. Plainlet removes the fragment from the current address after reading it, so clearing or reloading does not reopen the snapshot. A later edit does not change an existing share. Links have no expiration or revocation; the browser or the app used to send them may retain a copy.

Sharing is limited to a complete URL of 8,000 characters and 1 MiB of UTF-8 text before compression. Actual capacity depends on the text and site address, and some messaging apps may truncate long URLs. If either limit is exceeded, Plainlet says **“This paste is too big to share.”** These limits apply only to sharing: the editor, Paste, and Copy have no added size limit.

Only password protection and opening original encrypted links require a secure browser context with Web Crypto. Ordinary sharing works without it. Compression uses the browser's Compression Streams API; browsers without it can create uncompressed links, but need decompression support to open compressed ones. Invalid, damaged, or oversized links leave existing text intact. An incorrect password allows retry or cancellation without changing existing text. All link formats also open offline after the current app has been cached.

Original `#share=1` links remain readable and still include their key. New ordinary links use version 2, and password-protected links use version 3. Adding a password to a new link does not protect any ordinary link already sent.

## Install and use offline

Open the app online once to cache its files for offline use. The Plainlet menu includes installation instructions. Installation availability depends on the browser.

When a new version has downloaded, **Update available** appears with an **Update now** button. Updating keeps your current text and history. Other open tabs keep their text and offer their own update button. Plainlet checks for updates when you return or reconnect, and once a minute while visible.

If an older installed version does not have the update button yet, open [Update Plainlet](https://ryanlmelvin.github.io/plainlet/update.html) in a new tab and choose **Update now** once. This loads the latest app without clearing your saved history. Text in an existing tab stays there; copy it before closing that tab if you need it.

Clipboard buttons require HTTPS (or localhost) and may request browser permission. If access is blocked, focus the text area and use your device's normal Paste or Copy action. The app provides instructions when this happens.

## Privacy and storage

Text stays on your device. There are no uploads, analytics, accounts, or automatic saved drafts. Ordinary reloads start with an empty buffer. Choosing **Update now** briefly saves the current text in this tab's session storage, then restores it and removes the snapshot after updating. Successful pastes through the Paste button or directly into the text area are saved in this browser's local storage, newest first. Exact duplicates move to the top; empty or whitespace-only pastes and ordinary typing are not saved. You can copy or delete individual entries, or clear all history. Like other sites, a browser may keep a page alive when you navigate away and return.

History stays on this browser and device until you delete it or clear the site's browser data. If local storage is blocked or full, the app reports it and keeps history changes only for the current page session.

The service worker caches only the app's static files for offline use. It does not cache clipboard content or share links. Your browser/operating system still controls the system clipboard and any clipboard history it provides. GitHub Pages receives ordinary requests for app files, never the buffer's contents; URL fragments are not included in HTTP requests.

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

When changing any app file, increment `VERSION` in `docs/sw.js` so the next release gets a fresh offline cache. Downloads bypass the HTTP cache and are saved under the app's canonical URLs. A new service worker activates when the user chooses **Update now**, or after all old app tabs/windows close. Only a tab whose user requested an update reloads; other tabs are left open. The standalone `docs/update.html` recovery page is deliberately outside the offline cache so older versions can reach it.

## History storage

`docs/text-buffer.js` owns the in-memory editor buffer. `docs/paste-history.js` stores paste history separately in local storage, under a key scoped to the app's path. It synchronizes history changes between open tabs. History is never placed in the service worker's app-file cache.

## License

[MIT](LICENSE) · Copyright © 2026 Ryan L. Melvin

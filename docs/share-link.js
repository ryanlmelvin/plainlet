// These bounds apply only to links. The editor and clipboard have no size limit.
export const MAX_SHARE_URL_LENGTH = 8000;
export const MAX_SHARE_TEXT_BYTES = 1024 * 1024;

const PREFIX = '#share=';
const VERSION = '1';
const AAD = new TextEncoder().encode(`plainlet:share:${VERSION}`);

export class ShareLinkError extends Error {
  constructor(code) {
    super(code === 'too-large' ? 'This paste is too big to share.'
      : code === 'unsupported' ? 'Encrypted sharing is unavailable in this browser.'
        : 'This share link is invalid or incomplete.');
    this.name = 'ShareLinkError';
    this.code = code;
  }
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new ShareLinkError('unsupported');
  }
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ShareLinkError('invalid');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // Reject truncated and non-canonical encodings, including unused-bit changes.
  if (encodeBase64(bytes) !== value) throw new ShareLinkError('invalid');
  return bytes;
}

async function decompress(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new ShareLinkError('unsupported');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // Enforce the bound while streaming, before allocating the full output.
      if (size > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('invalid');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* The stream may already have failed. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** A snapshot: the key and authenticated ciphertext both live in the fragment. */
export async function createShareLink(text, baseURL) {
  if (typeof text !== 'string') throw new TypeError('Share links accept strings only.');
  // UTF-8 uses at least as many bytes as UTF-16 code units for valid input.
  if (text.length > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('too-large');
  const plain = new TextEncoder().encode(text);
  if (plain.byteLength > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('too-large');
  requireCrypto();

  const url = new URL(baseURL);
  url.search = '';
  url.hash = '';
  let content = plain;
  let format = 0;
  if (typeof CompressionStream !== 'undefined') {
    const compressed = new Uint8Array(await new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer());
    if (compressed.byteLength < plain.byteLength) {
      content = compressed;
      format = 1;
    }
  }
  // The format byte is encrypted and authenticated along with the text.
  const payload = new Uint8Array(content.byteLength + 1);
  payload[0] = format;
  payload.set(content, 1);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, payload,
  ));
  url.hash = `share=${VERSION}.${encodeBase64(rawKey)}.${encodeBase64(iv)}.${encodeBase64(encrypted)}`;
  if (url.href.length > MAX_SHARE_URL_LENGTH) throw new ShareLinkError('too-large');
  return url.href;
}

/** Return null for ordinary page anchors; reject all malformed share links. */
export async function readShareLink(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(PREFIX)) return null;
  try {
    if (hash.length > MAX_SHARE_URL_LENGTH) throw new ShareLinkError('invalid');
    const parts = hash.slice(PREFIX.length).split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new ShareLinkError('invalid');
    const rawKey = decodeBase64(parts[1]);
    const iv = decodeBase64(parts[2]);
    const encrypted = decodeBase64(parts[3]);
    if (rawKey.byteLength !== 32 || iv.byteLength !== 12 || encrypted.byteLength < 17) {
      throw new ShareLinkError('invalid');
    }
    requireCrypto();
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const payload = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, encrypted,
    ));
    if (payload[0] !== 0 && payload[0] !== 1) throw new ShareLinkError('invalid');
    const plain = payload[0] === 1 ? await decompress(payload.subarray(1)) : payload.subarray(1);
    if (plain.byteLength > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('invalid');
    // Preserve a literal leading BOM, and reject corrupted UTF-8 rather than replacing it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
  } catch (error) {
    if (error instanceof ShareLinkError) throw error;
    throw new ShareLinkError('invalid');
  }
}

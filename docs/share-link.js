// These bounds apply only to links. The editor and clipboard have no size limit.
export const MAX_SHARE_URL_LENGTH = 8000;
export const MAX_SHARE_TEXT_BYTES = 1024 * 1024;

const PREFIX = '#share=';
const PASSWORD_VERSION = '3';
const PASSWORD_CONTEXT = new TextEncoder().encode(`plainlet:share:${PASSWORD_VERSION}`);
const PASSWORD_ITERATIONS = 600000;
const MAX_PASSWORD_BYTES = 1024;

export class ShareLinkError extends Error {
  constructor(code) {
    const messages = {
      'too-large': 'This paste is too big to share.',
      unsupported: 'This browser does not support this sharing feature.',
      'password-required': 'Enter the password to open this share link.',
      'wrong-password': 'The password is incorrect or the share link is damaged.',
      'password-too-long': 'This password is too long. Use at most 1,024 UTF-8 bytes.',
      invalid: 'This share link is invalid or incomplete.',
    };
    super(messages[code] || messages.invalid);
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

/** Generated only on request. Its 256 random bits stay outside the share URL. */
export function generateSharePassword() {
  requireCrypto();
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function passwordBytes(password) {
  if (typeof password !== 'string' || password.length === 0) throw new ShareLinkError('password-required');
  if (password.length > MAX_PASSWORD_BYTES) throw new ShareLinkError('password-too-long');
  // Passwords are exact: whitespace and Unicode normalization are intentional.
  const bytes = new TextEncoder().encode(password);
  if (bytes.byteLength > MAX_PASSWORD_BYTES) throw new ShareLinkError('password-too-long');
  return bytes;
}

async function derivePasswordKey(password, salt, usage) {
  // Keep the work factor fixed by the format, never controlled by an incoming URL.
  const material = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
    material, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
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

async function encodeText(text) {
  if (typeof text !== 'string') throw new TypeError('Share links accept strings only.');
  // UTF-8 uses at least as many bytes as UTF-16 code units for valid input.
  if (text.length > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('too-large');
  const plain = new TextEncoder().encode(text);
  if (plain.byteLength > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('too-large');
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
  const payload = new Uint8Array(content.byteLength + 1);
  payload[0] = format;
  payload.set(content, 1);
  return payload;
}

async function decodeText(payload) {
  if (payload[0] !== 0 && payload[0] !== 1) throw new ShareLinkError('invalid');
  const plain = payload[0] === 1 ? await decompress(payload.subarray(1)) : payload.subarray(1);
  if (plain.byteLength > MAX_SHARE_TEXT_BYTES) throw new ShareLinkError('invalid');
  // Preserve a literal leading BOM; reject malformed UTF-8 instead of replacing it.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
}

/** A plain snapshot by default; only protected links perform key derivation. */
export async function createShareLink(text, baseURL, { password } = {}) {
  const protectedLink = password !== undefined;
  let secret;
  if (protectedLink) {
    requireCrypto();
    secret = passwordBytes(password);
  }
  const payload = await encodeText(text);
  const url = new URL(baseURL);
  url.search = '';
  url.hash = '';
  // Check the final encoded size before encrypting or allocating a large URL.
  const fragmentLength = protectedLink
    ? '#share=3.'.length + 22 + 1 + 16 + 1 + Math.ceil((payload.byteLength + 16) * 4 / 3)
    : '#share=2.'.length + Math.ceil(payload.byteLength * 4 / 3);
  if (url.href.length + fragmentLength > MAX_SHARE_URL_LENGTH) throw new ShareLinkError('too-large');

  if (!protectedLink) {
    url.hash = `share=2.${encodeBase64(payload)}`;
  } else {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derivePasswordKey(secret, salt, 'encrypt');
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: PASSWORD_CONTEXT, tagLength: 128 }, key, payload,
    ));
    url.hash = `share=${PASSWORD_VERSION}.${encodeBase64(salt)}.${encodeBase64(iv)}.${encodeBase64(encrypted)}`;
  }
  return url.href;
}

/** Return null for ordinary anchors; preserve support for the original key-in-link format. */
export async function readShareLink(hash, { password } = {}) {
  if (typeof hash !== 'string' || !hash.startsWith(PREFIX)) return null;
  try {
    if (hash.length > MAX_SHARE_URL_LENGTH) throw new ShareLinkError('invalid');
    const parts = hash.slice(PREFIX.length).split('.');
    if (parts[0] === '2') {
      if (parts.length !== 2) throw new ShareLinkError('invalid');
      return await decodeText(decodeBase64(parts[1]));
    }
    if (parts.length !== 4 || (parts[0] !== '1' && parts[0] !== PASSWORD_VERSION)) {
      throw new ShareLinkError('invalid');
    }
    const keyOrSalt = decodeBase64(parts[1]);
    const iv = decodeBase64(parts[2]);
    const encrypted = decodeBase64(parts[3]);
    const protectedLink = parts[0] === PASSWORD_VERSION;
    if (keyOrSalt.byteLength !== (protectedLink ? 16 : 32) || iv.byteLength !== 12 || encrypted.byteLength < 17) {
      throw new ShareLinkError('invalid');
    }
    requireCrypto();
    if (protectedLink && (password === undefined || password === '')) throw new ShareLinkError('password-required');
    const key = protectedLink
      ? await derivePasswordKey(passwordBytes(password), keyOrSalt, 'decrypt')
      : await crypto.subtle.importKey('raw', keyOrSalt, 'AES-GCM', false, ['decrypt']);
    const aad = protectedLink ? PASSWORD_CONTEXT : new TextEncoder().encode('plainlet:share:1');
    let payload;
    try {
      payload = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, encrypted,
      ));
    } catch {
      throw new ShareLinkError(protectedLink ? 'wrong-password' : 'invalid');
    }
    return await decodeText(payload);
  } catch (error) {
    if (error instanceof ShareLinkError) throw error;
    throw new ShareLinkError('invalid');
  }
}

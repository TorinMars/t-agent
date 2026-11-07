// Content rules shared by the task files API (services/task-files.js) and the preview of any path (services/fs-read.js):
// what counts as a text file (at most 5 MiB of UTF-8 without control characters) and which images may be shown (PNG, JPEG, GIF, WebP by name and content).
const crypto = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function failure(code, statusCode, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  return error;
}

// A text answer: { path, content, revision, eol, bom } (the shape of GET <task>/files/content), plus the hidden storageEol a write needs.
function inspectBuffer(buffer, displayPath) {
  if (buffer.length > MAX_TEXT_BYTES) throw failure('FILE_TOO_LARGE', 413);
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const textBytes = bom ? buffer.subarray(3) : buffer;
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(textBytes); }
  catch (error) { throw failure('FILE_UNSUPPORTED', 415, error); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) throw failure('FILE_UNSUPPORTED', 415);
  const firstBreak = decoded.match(/\r\n|\n|\r/);
  const eol = firstBreak && firstBreak[0] === '\r\n' ? '\r\n' : '\n';
  const result = {
    path: displayPath,
    content: decoded.replace(/\r\n?/g, '\n'),
    revision: crypto.createHash('sha256').update(buffer).digest('hex'),
    eol,
    bom,
  };
  Object.defineProperty(result, 'storageEol', {
    value: firstBreak && firstBreak[0] === '\r' ? '\r' : eol,
    enumerable: false,
  });
  return result;
}

// Only PNG, JPEG, GIF and WebP, by name and by content; never SVG (it can carry script).
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function imageTypeOf(name) {
  return IMAGE_TYPES[path.extname(String(name || '')).slice(1).toLowerCase()] || null;
}

function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// The headers of an image answer: it never runs in the page's origin as a document.
const IMAGE_HEADERS = { 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' };

module.exports = { MAX_TEXT_BYTES, failure, inspectBuffer, IMAGE_TYPES, imageTypeOf, sniffImage, IMAGE_HEADERS };

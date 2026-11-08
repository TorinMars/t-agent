// Content rules shared by the task files API (services/task-files.js) and the preview of any path (services/fs-read.js): what counts as a text
// file (at most 5 MiB of UTF-8 without control characters), which images may be shown (by name and content, 20 MiB) and which raw files
// (PDF, audio, video: by name and signature, 200 MiB, streamed with Range support).
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

// Images that may be shown, by name and by content. SVG is allowed: the page only ever shows it through <img>, and the answer carries
// `Content-Security-Policy: sandbox`, so its scripts never run in the page's origin.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

function extensionOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

function imageTypeOf(name) {
  return IMAGE_TYPES[extensionOf(name)] || null;
}

// The brands of an ISO base media file (`ftyp` box at offset 4): the major brand and the compatible ones.
function ftypBrands(buffer) {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  const boxSize = Math.min(buffer.readUInt32BE(0) || buffer.length, buffer.length);
  const brands = [buffer.subarray(8, 12).toString('latin1')];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(buffer.subarray(offset, offset + 4).toString('latin1'));
  return brands;
}

// SVG: text that starts, after an optional BOM, white space, an XML declaration, comments and a doctype, with an <svg> element.
const SVG_SNIFF_BYTES = 64 * 1024;
function looksLikeSvg(buffer) {
  let text = buffer.subarray(0, SVG_SNIFF_BYTES).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let index = 0;
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text.startsWith('<?xml', index)) {
      const end = text.indexOf('?>', index);
      if (end < 0) return false;
      index = end + 2;
    } else if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end < 0) return false;
      index = end + 3;
    } else if (text.slice(index, index + 9).toUpperCase() === '<!DOCTYPE') {
      const close = text.indexOf('>', index);
      const subset = text.indexOf('[', index);
      const end = subset >= 0 && subset < close ? text.indexOf(']', subset) : index;
      const after = end < 0 ? -1 : text.indexOf('>', end);
      if (close < 0 || after < 0) return false;
      index = after + 1;
    } else {
      return /^<svg[\s>/]/.test(text.slice(index, index + 5));
    }
  }
}

function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.length >= 14 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.length >= 6 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) return 'image/x-icon';
  const brands = ftypBrands(buffer);
  if (brands && brands.some(brand => brand === 'avif' || brand === 'avis')) return 'image/avif';
  if (looksLikeSvg(buffer)) return 'image/svg+xml';
  return null;
}

// The headers of an image answer: it never runs in the page's origin as a document.
const IMAGE_HEADERS = { 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' };

// ── Raw files (PDF, audio, video): streamed with Range support for the browser's own viewer and players ──

const MAX_RAW_BYTES = 200 * 1024 * 1024;
// The bytes needed to check a raw file's signature.
const RAW_SNIFF_BYTES = 16;

const ISO_MEDIA = head => head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
const OGG = head => head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'OggS';
const ID3 = head => head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'ID3';
const MPEG_AUDIO = head => head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
const ADTS = head => head.length >= 2 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0;
const MAGIC = {
  pdf: head => head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-',
  iso: ISO_MEDIA,
  webm: head => head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3,
  ogg: OGG,
  wav: head => head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WAVE',
  flac: head => head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'fLaC',
  mp3: head => ID3(head) || MPEG_AUDIO(head),
  aac: head => ID3(head) || ADTS(head),
};

// extension: [Content-Type, kind, signature]
const RAW_TYPES = {
  pdf: ['application/pdf', 'pdf', 'pdf'],
  mp3: ['audio/mpeg', 'audio', 'mp3'],
  m4a: ['audio/mp4', 'audio', 'iso'],
  aac: ['audio/aac', 'audio', 'aac'],
  wav: ['audio/wav', 'audio', 'wav'],
  ogg: ['audio/ogg', 'audio', 'ogg'],
  oga: ['audio/ogg', 'audio', 'ogg'],
  opus: ['audio/ogg', 'audio', 'ogg'],
  flac: ['audio/flac', 'audio', 'flac'],
  mp4: ['video/mp4', 'video', 'iso'],
  m4v: ['video/mp4', 'video', 'iso'],
  mov: ['video/quicktime', 'video', 'iso'],
  webm: ['video/webm', 'video', 'webm'],
  ogv: ['video/ogg', 'video', 'ogg'],
};

// { type, kind } of a raw file by its name, or null when the name is not a PDF, audio or video file of the table.
function rawTypeOf(name) {
  const entry = RAW_TYPES[extensionOf(name)];
  return entry ? { type: entry[0], kind: entry[1] } : null;
}

// Whether the first bytes of a file match the signature its name promises.
function rawMagicMatches(name, head) {
  const entry = RAW_TYPES[extensionOf(name)];
  return Boolean(entry && MAGIC[entry[2]](Buffer.isBuffer(head) ? head : Buffer.alloc(0)));
}

// One `Range: bytes=` range of a file of `size` bytes: null for the whole file (no header, another unit or several ranges, which may be ignored),
// { start, end } (inclusive) for a range, or 'unsatisfiable' for a malformed or out-of-file range (416).
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const match = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!match) return null;
  if (match[1].includes(',')) return null;
  const range = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(match[1]);
  if (!range || (!range[1] && !range[2])) return 'unsatisfiable';
  let start;
  let end;
  if (!range[1]) {
    const suffix = Number(range[2]);
    if (!suffix || !size) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || start >= size || (range[2] && Number(range[2]) < start)) return 'unsatisfiable';
  }
  return { start, end };
}

// The headers of a raw answer. A PDF has no CSP sandbox, because Chrome does not show a sandboxed PDF in its viewer; audio and video keep it.
function rawHeaders(type) {
  return {
    'Content-Type': type,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
  };
}

// Sends an opened raw file: { type, size, range (null | { start, end } | 'unsatisfiable'), stream (a Readable of exactly the range, or null for
// HEAD and 416) }. `errorBody` is the JSON body of a 416 answer.
function sendRaw(res, file, errorBody = { error: 'RANGE_NOT_SATISFIABLE' }) {
  const headers = rawHeaders(file.type);
  if (file.range === 'unsatisfiable') {
    if (file.stream) file.stream.destroy();
    res.status(416).set({ ...headers, 'Content-Range': `bytes */${file.size}` }).json(errorBody);
    return;
  }
  const { start, end } = file.range || { start: 0, end: file.size - 1 };
  res.status(file.range ? 206 : 200).set({
    ...headers,
    'Content-Length': String(Math.max(0, end - start + 1)),
    ...(file.range ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
  });
  if (!file.stream) { res.end(); return; }
  res.on('close', () => file.stream.destroy());
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
}

module.exports = {
  MAX_TEXT_BYTES, failure, inspectBuffer,
  MAX_IMAGE_BYTES, IMAGE_TYPES, imageTypeOf, sniffImage, IMAGE_HEADERS,
  MAX_RAW_BYTES, RAW_SNIFF_BYTES, RAW_TYPES, rawTypeOf, rawMagicMatches, parseRange, rawHeaders, sendRaw,
};

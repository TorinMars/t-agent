#!/usr/bin/env node
// Reads one file for services/fs-read.js as the dropped terminal user (the parent spawns this script with that uid/gid).
// Usage: fs-read-child.js <text|image> <absolute path>
//    or: fs-read-child.js raw <absolute path> <Range header or ''> <head|body>
// Writes one JSON line, then the bytes; always exits 0 after an answer. For text and image the line is { realPath, length } or { error } and the
// whole file follows; the text and image checks on the bytes are done by the parent. For raw (PDF, audio, video) the line is
// { realPath, size, range, head } or { error } (`head`: the first bytes in base64, so the parent checks the signature too), then exactly the bytes
// of the range are streamed (none for 'head', a 416 range or an empty file); the parent stops the child when its answer closes.
const { readRaw, openRawFile } = require('../services/fs-read');

const [kind, absolute, rangeHeader, mode] = process.argv.slice(2);

function answer(header, data) {
  process.stdout.write(`${JSON.stringify(header)}\n`);
  if (data && data.length) process.stdout.write(data);
}

const codeOf = error => (/^[A-Z0-9_]+$/.test(error && error.message || '') ? error.message : 'FS_READ_FAILED');

(async () => {
  if (!['text', 'image', 'raw'].includes(kind) || typeof absolute !== 'string' || !absolute.startsWith('/')) {
    answer({ error: 'BAD_PATH' });
    return;
  }
  if (kind === 'raw') {
    let file;
    try { file = await openRawFile(absolute, rangeHeader || undefined, { head: mode === 'head' }); }
    catch (error) { answer({ error: codeOf(error) }); return; }
    answer({ realPath: file.realPath, size: file.size, range: file.range, head: file.head.toString('base64') });
    if (file.stream) {
      file.stream.on('error', () => process.exit(1));
      file.stream.pipe(process.stdout);
    }
    return;
  }
  try {
    const { realPath, data } = await readRaw(absolute, kind);
    answer({ realPath, length: data.length }, data);
  } catch (error) {
    answer({ error: codeOf(error) });
  }
})();

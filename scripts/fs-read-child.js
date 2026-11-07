#!/usr/bin/env node
// Reads one file for services/fs-read.js as the dropped terminal user (the parent spawns this script with that uid/gid).
// Usage: fs-read-child.js <text|image> <absolute path>. Writes one JSON line ({ realPath, length } or { error }), then the bytes; always exits 0
// after an answer. The text and image checks on the bytes are done by the parent.
const { readRaw } = require('../services/fs-read');

const [kind, absolute] = process.argv.slice(2);

function answer(header, data) {
  process.stdout.write(`${JSON.stringify(header)}\n`);
  if (data && data.length) process.stdout.write(data);
}

(async () => {
  if (!['text', 'image'].includes(kind) || typeof absolute !== 'string' || !absolute.startsWith('/')) {
    answer({ error: 'BAD_PATH' });
    return;
  }
  try {
    const { realPath, data } = await readRaw(absolute, kind);
    answer({ realPath, length: data.length }, data);
  } catch (error) {
    answer({ error: /^[A-Z0-9_]+$/.test(error && error.message || '') ? error.message : 'FS_READ_FAILED' });
  }
})();

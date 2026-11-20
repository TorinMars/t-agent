// /sw.js with the hash of the offline files written into it ("The page while its engine is down" in docs/design/failover-and-one-login.md): a
// change of public/offline.html or a file it loads changes the worker's bytes, so browsers install the new worker and fill a new cache. The text is
// read again when a file's size or modification time changes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OFFLINE_FILES = ['offline.html', 'css/offline.css', 'js/offline.js', 'js/local-keys.js', 'js/i18n.js', 'js/i18n-zh-ui.js', 'favicon.svg'];
const PLACEHOLDER = '__OFFLINE_VERSION__';

function createServiceWorkerSource({ publicDir }) {
  let memo = null;
  const stamp = file => { try { const stat = fs.statSync(path.join(publicDir, file)); return `${file}:${stat.size}:${stat.mtimeMs}`; } catch { return `${file}:-`; } };
  return function source() {
    const key = ['sw.js', ...OFFLINE_FILES].map(stamp).join('|');
    if (memo && memo.key === key) return memo.text;
    const hash = crypto.createHash('sha256');
    for (const file of OFFLINE_FILES) { try { hash.update(fs.readFileSync(path.join(publicDir, file))); } catch { hash.update(`missing:${file}`); } }
    const text = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8').split(PLACEHOLDER).join(hash.digest('hex').slice(0, 16));
    memo = { key, text };
    return text;
  };
}

module.exports = { createServiceWorkerSource, OFFLINE_FILES, PLACEHOLDER };

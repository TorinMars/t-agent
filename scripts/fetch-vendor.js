#!/usr/bin/env node
// Download the third-party frontend libraries used by the page at pinned versions into public/vendor and verify them with SHA-256,
// so nothing depends on a runtime CDN (upstream changes, offline, tampering). The manifest is scripts/vendor-libs.json.
//
// node scripts/fetch-vendor.js            verify downloaded files; re-download and verify again when missing or mismatched
// node scripts/fetch-vendor.js --check    verify only, no network
// node scripts/fetch-vendor.js --update   after upgrading versions, recompute and write back the sha256 values in the manifest
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(__dirname, 'vendor-libs.json');
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

(async () => {
  const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--update') ? 'update' : 'fetch';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let failed = false;
  for (const lib of manifest.libs) {
    const target = path.join(root, lib.file);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (mode !== 'update' && current && sha256(current) === lib.sha256) { console.log(`ok       ${lib.file}`); continue; }
    if (mode === 'check') { console.error(`MISMATCH ${lib.file}${current ? '' : '(file does not exist)'}`); failed = true; continue; }
    const body = await download(lib.url);
    if (mode === 'update') lib.sha256 = sha256(body);
    else if (sha256(body) !== lib.sha256) { console.error(`SHA-256 mismatch; refusing to write ${lib.file}`); failed = true; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    console.log(`${mode === 'update' ? 'updated ' : 'fetched '} ${lib.file}  ${lib.sha256}`);
  }
  if (mode === 'update') fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error.message); process.exit(1); });

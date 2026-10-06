#!/usr/bin/env node
// 把页面用到的第三方前端库按固定版本下载到 public/vendor，并用 SHA-256 校验，
// 避免依赖运行时 CDN（上游改版、离线、被篡改）。清单见 scripts/vendor-libs.json。
//
//   node scripts/fetch-vendor.js            校验已下载的文件，缺失或不一致时重新下载并再次校验
//   node scripts/fetch-vendor.js --check    只校验，不联网
//   node scripts/fetch-vendor.js --update   升级版本后重新计算并写回清单里的 sha256
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(__dirname, 'vendor-libs.json');
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
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
    if (mode === 'check') { console.error(`MISMATCH ${lib.file}${current ? '' : '（文件不存在）'}`); failed = true; continue; }
    const body = await download(lib.url);
    if (mode === 'update') lib.sha256 = sha256(body);
    else if (sha256(body) !== lib.sha256) { console.error(`SHA-256 不一致，拒绝写入 ${lib.file}`); failed = true; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    console.log(`${mode === 'update' ? 'updated ' : 'fetched '} ${lib.file}  ${lib.sha256}`);
  }
  if (mode === 'update') fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error.message); process.exit(1); });

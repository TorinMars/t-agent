// Static files: scripts and styles named by the hash of their content are cached for a year (`immutable`); everything else is revalidated each time
// (`no-cache`). Scripts and styles are sent as brotli / gzip copies made once, and the Chinese dictionaries are left out of the page for English readers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createStaticAssets, wantsChinese } = require('../lib/static-assets');

const PUBLIC = path.join(__dirname, '../public');
const hashOf = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex').slice(0, 16);
const LONG = 'public, max-age=31536000, immutable';

async function startServer(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-asset-cache-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'asset-cache-test-secret-'.repeat(3), T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 8000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const m = output.match(/Server running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  return (route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { Host: `127.0.0.1:${port}`, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('the page names each script and style by its content hash; only that URL is cached for a year', async t => {
  const get = await startServer(t);
  const page = await get('/h5');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store', 'the page itself is never stored');
  const html = page.body.toString();
  const urls = [...html.matchAll(/(?:src|href)="(\/(?:js|css|vendor)\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(urls.length > 20, 'the page names its assets');
  for (const url of urls) {
    const [file, v] = url.split('?v=');
    assert.equal(v, hashOf(file), `${file} carries the hash of its content`);
  }
  const shell = urls.find(url => url.startsWith('/js/h5.js?'));
  const cached = await get(shell, { 'Accept-Encoding': 'gzip' });
  assert.equal(cached.status, 200);
  assert.equal(cached.headers['cache-control'], LONG);
  const xterm = urls.find(url => url.startsWith('/vendor/xterm/xterm-5.5.0.js?'));
  assert.equal((await get(xterm)).headers['cache-control'], LONG, 'vendor scripts named by their hash too');
  const css = urls.find(url => url.startsWith('/css/h5.css?'));
  assert.equal((await get(css)).headers['cache-control'], LONG);

  // A plain URL, an app version (the old naming), a wrong or an old hash, and files the page does not name by hash are revalidated each time.
  for (const route of ['/js/h5.js', '/js/h5.js?v=2.87.13', '/js/h5.js?v=0123456789abcdef', `/js/h5.js?v=${hashOf('js/h5.js').toUpperCase()}`, '/css/h5.css?v=../../x', '/js/voice-input.js', '/icons/icon-192.png', `/icons/icon-192.png?v=${hashOf('icons/icon-192.png')}`, '/manifest-h5.json', '/sw.js', '/vendor/marked/marked-15.0.12.min.js']) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['cache-control'], 'no-cache', route);
  }
});

test('scripts and styles are sent as brotli or gzip copies made once, by what the browser accepts', async t => {
  const get = await startServer(t);
  const raw = fs.readFileSync(path.join(PUBLIC, 'js/h5.js'));
  const first = await get('/js/h5.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(first.status, 200);
  assert.ok(['br', 'gzip'].includes(first.headers['content-encoding']), 'compressed on the fly before the copy is ready');
  let br;
  for (let i = 0; i < 100; i++) { // the copy is made in the background
    br = await get('/js/h5.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    if (br.headers['content-encoding'] === 'br' && /-br"$/.test(br.headers.etag || '')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(br.headers.etag, new RegExp(`^"${hashOf('js/h5.js')}-br"$`));
  assert.match(br.headers.vary, /Accept-Encoding/);
  assert.match(br.headers['content-type'], /javascript/);
  assert.equal(br.headers['cache-control'], 'no-cache', 'a plain URL still revalidates');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), raw, 'the copy is the file');
  const dynamicGzip = zlib.gzipSync(raw).length;
  assert.ok(br.body.length < dynamicGzip * 0.85, `brotli 11 (${br.body.length}) is clearly smaller than gzip (${dynamicGzip})`);
  // Revalidation of the copy: 304 without a body.
  const again = await get('/js/h5.js', { 'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  // gzip only, and no compression at all.
  const gz = await get(`/js/h5.js?v=${hashOf('js/h5.js')}`, { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers['cache-control'], LONG);
  assert.deepEqual(zlib.gunzipSync(gz.body), raw);
  const plain = await get('/js/h5.js', { 'Accept-Encoding': 'identity' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, raw);
  const refused = await get('/js/h5.js', { 'Accept-Encoding': 'br;q=0, gzip' });
  assert.notEqual(refused.headers['content-encoding'], 'br', 'a coding with q=0 is not used');
  // HEAD and a range request keep working.
  const range = await get('/js/h5.js', { 'Accept-Encoding': 'identity', Range: 'bytes=0-9' });
  assert.equal(range.status, 206);
  assert.equal(range.body.length, 10);
});

test('an unchanged static file is answered with 304 and no body', async t => {
  const get = await startServer(t);
  const first = await get('/js/h5.js', { 'Accept-Encoding': 'identity' });
  assert.ok(first.headers.etag, 'the file has an ETag to validate against');
  const again = await get('/js/h5.js', { 'Accept-Encoding': 'identity', 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers['cache-control'], 'no-cache');
});

test('the Chinese dictionaries are in the page only for someone who reads it in Chinese (the ta-lang cookie)', async t => {
  const get = await startServer(t);
  const english = (await get('/h5')).body.toString();
  assert.doesNotMatch(english, /i18n-zh-/, 'English readers do not download the dictionaries');
  assert.match(english, /<script defer src="\/js\/i18n\.js\?v=[0-9a-f]{16}"><\/script>/, 'i18n.js itself stays');
  const chinese = (await get('/h5', { Cookie: 'other=1; ta-lang=zh' })).body.toString();
  const dictionaries = [...chinese.matchAll(/src="\/js\/(i18n-zh-[\w-]+)\.js\?v=[0-9a-f]{16}"/g)].map(match => match[1]);
  assert.deepEqual(dictionaries, ['i18n-zh-ui', 'i18n-zh-server', 'i18n-zh-extra']);
  assert.ok(chinese.indexOf('/js/i18n.js') < chinese.indexOf('/js/i18n-zh-ui.js') && chinese.indexOf('/js/i18n-zh-extra.js') < chinese.indexOf('/js/h5-shell.js'), 'in their place, before the shell');
  assert.equal(wantsChinese({ headers: { cookie: 'ta-lang=zhx' } }), false);
  assert.equal(wantsChinese({ headers: {} }), false);
});

test('every script of the phone page is deferred, in its old order, and the page has a skeleton', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'h5.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
  assert.ok(scripts.length > 20);
  for (const attrs of scripts) assert.match(attrs, /^ defer src="[^"]+"$/, `deferred, no inline script: ${attrs}`);
  const order = scripts.map(attrs => /src="([^"]+)"/.exec(attrs)[1]);
  const before = (a, b) => assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  before('/js/i18n.js', '/js/i18n-zh-ui.js');
  before('/js/i18n-zh-extra.js', '/js/h5-shell.js');
  before('/vendor/xterm/addon-unicode11-0.8.0.js', '/js/h5.js');
  before('/js/h5-shell.js', '/js/terminal-owner.js');
  before('/js/agent-activity.js', '/js/h5.js');
  assert.equal(order.at(-1), '/js/h5.js');
  assert.match(html, /<div id="h5-root">\s*<div class="h5-skeleton"/, 'the skeleton is inside the root the shell replaces');
});

test('a changed file gets a new hash: its old URL is no longer cached for long, and path tricks name no file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-assets-'));
  try {
    fs.mkdirSync(path.join(dir, 'js'));
    const file = path.join(dir, 'js', 'app.js');
    fs.writeFileSync(file, 'console.log(1);');
    const assets = createStaticAssets({ publicDir: dir });
    const page = '<script defer src="/js/app.js"></script><script defer src="/js/i18n-zh-ui.js"></script><link href="/css/missing.css">';
    const first = assets.rewritePage(page, { zh: false });
    const v1 = /app\.js\?v=([0-9a-f]{16})/.exec(first)[1];
    assert.doesNotMatch(first, /i18n-zh/);
    assert.match(first, /href="\/css\/missing\.css"/, 'a missing file keeps its plain URL');
    assert.equal(assets.cacheControl({ query: { v: v1 } }, file), LONG);
    fs.writeFileSync(file, 'console.log(2); // a release changed it');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const v2 = /app\.js\?v=([0-9a-f]{16})/.exec(assets.rewritePage(page))[1];
    assert.notEqual(v2, v1, 'the new content has a new URL');
    assert.equal(assets.cacheControl({ query: { v: v1 } }, file), 'no-cache', 'the old URL is not kept for a year with the new content');
    assert.equal(assets.cacheControl({ query: { v: v2 } }, file), LONG);
    assert.equal(assets.cacheControl({ query: { v: [v2] } }, file), 'no-cache');
    assert.equal(assets.cacheControl({ query: {} }, file), 'no-cache');
    assert.equal(assets.assetUrl('/js/../../etc/passwd'), '/js/../../etc/passwd', 'no file outside the folder');
    assert.equal(assets.assetUrl('/js/%2e%2e/%2e%2e/x.js'), '/js/%2e%2e/%2e%2e/x.js');
    assert.equal(assets.pickEncoding('gzip, deflate, br'), 'br');
    assert.equal(assets.pickEncoding('gzip;q=1, br;q=0'), 'gzip');
    assert.equal(assets.pickEncoding('*'), 'br');
    assert.equal(assets.pickEncoding('identity'), null);
    assert.equal(assets.pickEncoding(''), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

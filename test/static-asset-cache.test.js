// Static files: scripts and styles named by the hash of their content are cached for a year (`immutable`); everything else is revalidated each time
// (`no-cache`). Scripts and styles are sent as brotli / gzip copies made once, and the Chinese dictionaries are left out of the page for English readers.
// The combined scripts and the hashes of the files the page loads later have their own cases in test/static-asset-combine.test.js.
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
const sha16 = content => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
const hashOf = file => sha16(fs.readFileSync(path.join(PUBLIC, file)));
const COMBINED = /^\/js\/combined-[0-9a-f]{12}\.js$/;
const CHUNK = /^\/js\/chunks\/[\w.-]+-[A-Z0-9]{8}\.js$/;
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
  const chunks = urls.filter(url => url.startsWith('/js/chunks/'));
  assert.ok(chunks.length >= 1 && chunks.length <= 4, `the shell's chunks are preloaded: ${chunks}`);
  assert.deepEqual(urls.map(url => url.split('?v=')[0].replace(/combined-[0-9a-f]{12}/, 'combined')), [
    '/vendor/xterm/xterm-5.5.0.css', '/css/h5.css', '/js/combined.js', '/vendor/xterm/xterm-5.5.0.js', '/vendor/xterm/addon-fit-0.10.0.js', '/vendor/xterm/addon-unicode11-0.8.0.js',
    ...chunks, '/js/h5-shell.js', '/js/combined.js', '/js/h5.js',
  ], 'the English page: two style sheets, the shell and its chunks, the page script, xterm, and one request for each run of small scripts');
  for (const chunk of chunks) {
    // A chunk is imported by its name, which is the hash of its content (scripts/build-page-bundles.js): cached for a year by name, no ?v=.
    assert.match(chunk, CHUNK);
    assert.match(html, new RegExp(`<link rel="modulepreload" href="${chunk}">`));
    const response = await get(chunk);
    assert.equal(response.status, 200, chunk);
    assert.equal(response.headers['cache-control'], LONG, `${chunk} is cached for a year by its name`);
    assert.match(response.headers['content-type'], /javascript/);
  }
  assert.doesNotMatch(/window\.TAAssets=[^<]*/.exec(html)[0], /\/js\/chunks\//, 'no loader builds a chunk URL, so the page does not carry their hashes');
  for (const url of urls) {
    if (CHUNK.test(url)) continue;
    const [file, v] = url.split('?v=');
    if (!COMBINED.test(file)) { assert.equal(v, hashOf(file), `${file} carries the hash of its content`); continue; }
    // A combined script is no file: it is named by the hash of what the server sends for it, and cached like the files.
    const combined = await get(url);
    assert.equal(combined.status, 200, file);
    assert.equal(v, sha16(combined.body), `${file} carries the hash of its content`);
    assert.equal(combined.headers['cache-control'], LONG, file);
    assert.match(combined.headers['content-type'], /javascript/);
    assert.equal((await get(file)).headers['cache-control'], 'no-cache', 'without its hash it is revalidated');
    assert.equal((await get(`${file}?v=0123456789abcdef`)).headers['cache-control'], 'no-cache');
  }
  // The files the page loads later (the chat and mind map bundles, the chat's style sheet, the Markdown renderer, mermaid, the dictionaries of an
  // English page): the page carries the hash of each, and the URL made from it is cached for a year too.
  const later = JSON.parse(/window\.TAAssets=(\{[^;<]*\});/.exec(html)[1]);
  for (const file of ['/js/agent-chat-ui.js', '/css/agent-chat.css', '/js/mindmap-ui.js', '/css/markdown.css', '/vendor/marked/marked-15.0.12.min.js', '/vendor/mermaid/mermaid-12.1.0.min.js', '/js/i18n-zh-ui.js', '/js/i18n-zh-server.js', '/js/i18n-zh-extra.js']) {
    assert.equal(later[file], hashOf(file), `the page knows the hash of ${file}`);
    const response = await get(`${file}?v=${later[file]}`);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers['cache-control'], LONG, `${file} is cached for a year when asked for by its own hash`);
  }
  assert.equal((await get(`/js/agent-chat-ui.js?v=${hashOf('js/agent-chat.js')}`)).headers['cache-control'], 'no-cache', 'the hash of another file (what the loaders sent before) is not cached');
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
  // The copy is made in the background, after those of the scripts before it in the page (brotli 11: several seconds on a shared CI machine).
  for (const end = Date.now() + 60_000; Date.now() < end;) {
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
  assert.doesNotMatch(english, /(?:src|href)="[^"]*i18n-zh-/, 'English readers do not download the dictionaries');
  // i18n.js itself stays: it is the first file of the page's first combined script.
  const first = url => /<script defer src="(\/js\/combined-[0-9a-f]{12}\.js\?v=[0-9a-f]{16})"><\/script>/.exec(url)[1];
  assert.match((await get(first(english))).body.toString(), /^\(function \(parts\) \{[\s\S]*?\n\}\)\(\[\n"\/js\/local-keys\.js",\n/m);
  const chinese = (await get('/h5', { Cookie: 'other=1; ta-lang=zh' })).body.toString();
  const dictionaries = [...chinese.matchAll(/src="\/js\/(i18n-zh-[\w-]+)\.js\?v=[0-9a-f]{16}"/g)].map(match => match[1]);
  assert.deepEqual(dictionaries, ['i18n-zh-ui', 'i18n-zh-server', 'i18n-zh-extra']);
  assert.equal(first(chinese), first(english), 'the same combined script in both languages');
  assert.ok(chinese.indexOf(first(chinese)) < chinese.indexOf('/js/i18n-zh-ui.js') && chinese.indexOf('/js/i18n-zh-extra.js') < chinese.indexOf('/js/h5-shell.js'), 'in their place: after i18n.js, before the shell');
  assert.doesNotMatch(chinese, /TAAssets=[^<]*i18n-zh-/, 'the Chinese page loads them itself, so they are not among the files for later');
  assert.equal(wantsChinese({ headers: { cookie: 'ta-lang=zhx' } }), false);
  assert.equal(wantsChinese({ headers: {} }), false);
});

test('every script of the phone page is deferred, in its old order, and the page has a skeleton', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'h5.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
  assert.ok(scripts.length > 20);
  // The shell is an ES module (deferred by itself, it runs in its place in this order); every other script is a deferred classic one.
  assert.deepEqual(scripts.filter(attrs => attrs.includes('type="module"')), [' type="module" src="/js/h5-shell.js"']);
  for (const attrs of scripts) assert.match(attrs, /^ (?:defer|type="module") src="[^"]+"(?: data-combine)?$/, `deferred, no inline script: ${attrs}`);
  const order = scripts.map(attrs => /src="([^"]+)"/.exec(attrs)[1]);
  const before = (a, b) => assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  before('/js/i18n.js', '/js/i18n-zh-ui.js');
  before('/js/i18n-zh-extra.js', '/js/h5-shell.js');
  before('/vendor/xterm/addon-unicode11-0.8.0.js', '/js/h5.js');
  before('/js/h5-shell.js', '/js/terminal-owner.js');
  before('/js/i18n.js', '/js/toast.js');
  before('/js/client-auth.js', '/js/h5-shell.js');
  before('/js/local-keys.js', '/js/i18n.js'); // the registry of browser storage, before anything reads a key
  before('/js/page-state.js', '/js/h5-shell.js'); // the shell reads the shared page state's cache when it starts
  before('/js/mindmap.js', '/js/h5.js');
  assert.equal(order.at(-1), '/js/h5.js');
  // The scripts sent in one request (data-combine) are the small hand-written ones; the big and the vendored ones and the dictionaries stay on their own.
  const combine = scripts.filter(attrs => attrs.endsWith(' data-combine')).map(attrs => /src="([^"]+)"/.exec(attrs)[1]);
  assert.equal(combine.length, 23);
  for (const src of combine) {
    assert.match(src, /^\/js\/[\w.-]+\.js$/);
    assert.doesNotMatch(src, /h5-shell|\/h5\.js|i18n-zh-/, `${src} stays a request of its own`);
    assert.ok(fs.statSync(path.join(PUBLIC, src)).size < 64 * 1024, `${src} is small`);
    assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, src), 'utf8'), /currentScript/, `${src} does not read its own tag (a part of a combined script has no src)`);
  }
  // The chat's style sheet is loaded with the chat bundle (public/js/agent-chat.js), not by the page.
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]), ['/vendor/xterm/xterm-5.5.0.css', '/css/h5.css']);
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

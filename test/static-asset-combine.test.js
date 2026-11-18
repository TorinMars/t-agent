// lib/static-assets.js, the two things a page gets besides the hashed URLs of its own tags:
// - the hash of every script and style it may load later (the inline `window.TAAssets` / `window.TAAsset`), so the lazy loaders ask for a file by the
//   hash of that file and get the year-long cache;
// - one request for each run of `data-combine` scripts: the combined script holds the files as they are and runs them in order, each as a script of
//   its own, is named by the hash of its content, and is rebuilt when a file changes.
// What a browser does with them (errors in one part, fewer requests, the lazy loaders) is in scripts/test-h5-assets-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const express = require('express');
const { createStaticAssets } = require('../lib/static-assets');

const PUBLIC = path.join(__dirname, '../public');
const LONG = 'public, max-age=31536000, immutable';
const ORIGIN = 'http://page.test';
const sha16 = content => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

// A public folder with these files ({ 'js/a.js': 'source' }).
function folder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-combine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
// Writes a file again with a later modification time (a change within the same millisecond and of the same size would not be seen).
let clock = Date.now();
function change(file, content) {
  fs.writeFileSync(file, content);
  clock += 5000;
  fs.utimesSync(file, new Date(clock), new Date(clock));
}
// The inline script of a page, run: { map, asset(path) }, or null when the page has none.
function later(html) {
  const found = /<script>(window\.TAAssets=[^<]*)<\/script>/.exec(html);
  if (!found) return null;
  const window = {};
  vm.runInNewContext(found[1], { window });
  return { map: { ...window.TAAssets }, asset: window.TAAsset };
}
// Runs a combined script with a document that only records: the script elements it appended, in order ({ src, text }).
function run(body) {
  const ran = [];
  const node = () => ({ attrs: {}, text: '', setAttribute(name, value) { this.attrs[name] = value; } });
  const head = { inside: 0, appendChild(script) { this.inside += 1; ran.push({ src: script.attrs['data-src'], text: script.text }); }, removeChild() { this.inside -= 1; } };
  vm.runInNewContext(String(body), { document: { head, createElement: name => { assert.equal(name, 'script'); return node(); } }, location: { origin: ORIGIN } });
  assert.equal(head.inside, 0, 'every part is taken out of the page again after it ran');
  return ran;
}
const tagsOf = html => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => match[1]);
// The files as server.js serves them: the copies and combined scripts first, then the files themselves.
async function serve(t, assets, dir) {
  const app = express();
  app.use(['/js', '/css', '/vendor'], assets.precompressed);
  app.use(express.static(dir, { index: false, setHeaders: assets.setHeaders }));
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (route, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: server.address().port, path: route, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

test('the page carries the hash of every script and style it does not load itself, and TAAsset names a file by it', t => {
  const dir = folder(t, {
    'js/app.js': 'console.log("page");', 'css/page.css': 'body { margin: 0; }',
    'js/lazy-ui.js': 'window.Lazy = 1;', 'css/lazy.css': '.lazy { color: red; }', 'vendor/lib/lib-1.0.0.min.js': 'window.Lib = 1;',
    'js/.hidden.js': 'secret', 'js/notes.txt': 'not a script', 'js/odd name.js': 'window.Odd = 1;', 'icons/icon.js': 'outside the three folders',
  });
  const assets = createStaticAssets({ publicDir: dir, listTtlMs: 0 });
  const page = '<head>\n  <title>t</title>\n  <style>html { margin: 0; }</style>\n  <link rel="stylesheet" href="/css/page.css">\n  <script defer src="/js/app.js"></script>\n</head>';
  const html = assets.rewritePage(page);
  const first = later(html);
  assert.deepEqual(first.map, {
    '/css/lazy.css': sha16('.lazy { color: red; }'), '/js/lazy-ui.js': sha16('window.Lazy = 1;'), '/vendor/lib/lib-1.0.0.min.js': sha16('window.Lib = 1;'),
  }, 'the files for later, without the ones the page loads itself, hidden files, other types and other folders');
  assert.equal(first.asset('/js/lazy-ui.js'), `/js/lazy-ui.js?v=${sha16('window.Lazy = 1;')}`);
  assert.equal(first.asset('/js/app.js'), '/js/app.js', 'a file that is not among them keeps its plain address');
  assert.equal(first.asset('/js/missing.js'), '/js/missing.js');
  assert.equal(first.asset('constructor'), 'constructor', 'no inherited name is taken for a hash');
  assert.equal(assets.cacheControl({ query: { v: first.map['/js/lazy-ui.js'] } }, path.join(dir, 'js/lazy-ui.js')), LONG, 'that URL is cached for a year');
  assert.equal(assets.cacheControl({ query: { v: sha16('console.log("page");') } }, path.join(dir, 'js/lazy-ui.js')), 'no-cache', 'the hash of another file is not');
  // It is an inline script before the first style sheet (it never waits for one), and the page's own tags keep their hashed URLs.
  assert.ok(html.indexOf('<script>window.TAAssets=') > html.indexOf('</style>') && html.indexOf('<script>window.TAAssets=') < html.indexOf('<link rel="stylesheet"'));
  assert.match(html, new RegExp(`href="/css/page\\.css\\?v=${sha16('body { margin: 0; }')}"`));
  assert.match(html, new RegExp(`src="/js/app\\.js\\?v=${sha16('console.log("page");')}"`));

  // A changed file has a new hash in the next page; a new file is there too, and a removed one is gone.
  change(path.join(dir, 'js/lazy-ui.js'), 'window.Lazy = 2;');
  fs.writeFileSync(path.join(dir, 'js/more.js'), 'window.More = 1;');
  fs.rmSync(path.join(dir, 'css/lazy.css'));
  const second = later(assets.rewritePage(page));
  assert.deepEqual(second.map, { '/js/lazy-ui.js': sha16('window.Lazy = 2;'), '/js/more.js': sha16('window.More = 1;'), '/vendor/lib/lib-1.0.0.min.js': sha16('window.Lib = 1;') });
  assert.equal(assets.cacheControl({ query: { v: first.map['/js/lazy-ui.js'] } }, path.join(dir, 'js/lazy-ui.js')), 'no-cache', 'the old URL is not kept for a year with the new content');

  // Nothing for later, or nowhere to put it: the page is left as it is.
  const only = folder(t, { 'js/app.js': 'console.log(1);' });
  assert.equal(later(createStaticAssets({ publicDir: only }).rewritePage(page)), null, 'no empty script when the page loads everything itself');
  assert.equal(assets.rewritePage('<p>no scripts or styles</p>'), '<p>no scripts or styles</p>');
});

test('a run of data-combine scripts becomes one tag; the combined script holds the files unchanged, in order', async t => {
  const SOURCES = {
    'js/a.js': 'const A = "a";\nwindow.order = ["a"];\n',
    // Everything a string literal has to carry: quotes, backslashes, a template with ${}, a closing script tag, line separators, CRLF, an emoji.
    'js/b.js': 'const B = `b ${A} \\${not}`; // \'single\' "double" \\n \\\\ </script>\r\nconst sep = "  "; const face = "😀";\r\n',
    'js/c.js': '\'use strict\';\nwindow.order.push("c") // no line break at the end',
    'js/big.js': 'window.order.push("big");',
    'js/d.js': 'window.order.push("d");',
    'js/e.js': 'window.order.push("e");',
    'js/f.js': 'window.order.push("f");',
    'js/solo.js': 'window.order.push("solo");',
  };
  const dir = folder(t, SOURCES);
  const assets = createStaticAssets({ publicDir: dir });
  const page = [
    '<head>',
    '  <script defer src="/js/a.js" data-combine></script>',
    '  <script defer src="/js/b.js" data-combine></script>',
    '  <script defer src="/js/c.js" data-combine></script>',
    '  <script defer src="/js/big.js"></script>',
    '  <script defer src="/js/d.js" data-combine></script>',
    '  <script defer src="/js/gone.js" data-combine></script>',
    '  <script defer src="/js/e.js" data-combine></script><script defer src="/js/f.js" data-combine></script>',
    '  <script src="/js/solo.js" data-combine></script>',
    '</head>',
  ].join('\n');
  const html = assets.rewritePage(page);
  const tags = tagsOf(html);
  const hashed = name => `/${name}?v=${sha16(SOURCES[name])}`;
  assert.equal(tags.length, 6);
  assert.match(tags[0], /^\/js\/combined-[0-9a-f]{12}\.js\?v=[0-9a-f]{16}$/, 'a, b and c are one request');
  assert.equal(tags[1], hashed('js/big.js'), 'a script without the mark stays, and ends the run');
  assert.equal(tags[2], hashed('js/d.js'), 'a marked script without a marked neighbour stays a tag of its own');
  assert.equal(tags[3], '/js/gone.js', 'a file that does not exist keeps its tag (and its 404), and ends the run');
  assert.match(tags[4], /^\/js\/combined-[0-9a-f]{12}\.js\?v=[0-9a-f]{16}$/, 'e and f are one request (also on one line)');
  assert.equal(tags[5], hashed('js/solo.js'), 'only a plain deferred tag is combined');
  assert.notEqual(tags[0].split('?')[0], tags[4].split('?')[0]);
  assert.equal(html.split('\n').length, page.split('\n').length - 2, 'the lines of the files that went into a combined script are gone');
  assert.match(html, /^ {2}<script defer src="\/js\/combined-[0-9a-f]{12}\.js\?v=[0-9a-f]{16}"><\/script>\n {2}<script defer src="\/js\/big\.js/m, 'in the place and with the indent of the first');
  assert.equal(later(html), null, 'files that are part of a combined script are not among the files for later');

  // The combined script: named by the hash of its content, and its parts are the files, byte for byte, each with the address it is known by.
  const [urlPath, version] = tags[0].split('?v=');
  const combined = assets.combinedScript(urlPath);
  assert.deepEqual(combined.files, ['/js/a.js', '/js/b.js', '/js/c.js']);
  assert.equal(version, sha16(combined.body));
  assert.equal(combined.hash, version);
  assert.deepEqual(run(combined.body), ['js/a.js', 'js/b.js', 'js/c.js'].map(name => ({ src: `/${name}`, text: `${SOURCES[name]}\n//# sourceURL=${ORIGIN}/${name}` })));
  assert.deepEqual(assets.combinedScript(tags[4].split('?')[0]).files, ['/js/e.js', '/js/f.js']);
  assert.equal(assets.combinedScript('/js/combined-000000000000.js'), null, 'a combined script no page named does not exist');
  assert.equal(assets.combinedScript('/js/a.js'), null);
  assert.equal(assets.rewritePage(page), html, 'the same page again: the same URLs');

  // Served like a file: a year for the URL with its hash, revalidation for any other, gzip from the first request and brotli once it is made.
  const get = await serve(t, assets, dir);
  const first = await get(tags[0], { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], LONG);
  assert.match(first.headers['content-type'], /javascript/);
  assert.match(first.headers.vary, /Accept-Encoding/);
  assert.ok(['gzip', 'br'].includes(first.headers['content-encoding']), 'compressed from the first request');
  await assets.idle();
  const br = await get(tags[0], { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.etag, `"${version}-br"`);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), combined.body);
  const gz = await get(tags[0], { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), combined.body);
  const plain = await get(tags[0], { 'Accept-Encoding': 'identity', Range: 'bytes=0-9' });
  assert.equal(plain.status, 200, 'it is sent whole');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers.etag, `"${version}"`);
  assert.deepEqual(plain.body, combined.body);
  const again = await get(tags[0], { 'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const head = await get(tags[0], { 'Accept-Encoding': 'identity' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), combined.body.length);
  assert.equal(head.body.length, 0);
  for (const route of [urlPath, `${urlPath}?v=0123456789abcdef`, `${urlPath}?v=${version.toUpperCase()}`, `${urlPath}?v=${version}&v=${version}`]) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['cache-control'], 'no-cache', route);
  }
  assert.equal((await get('/js/combined-000000000000.js')).status, 404);
  assert.equal((await get(urlPath, {}, 'POST')).status, 404, 'only read');
  // The files themselves are still served one by one (a page from before, a test page).
  const single = await get('/js/b.js', { 'Accept-Encoding': 'identity' });
  assert.equal(single.status, 200);
  assert.equal(single.headers['cache-control'], 'no-cache');
  assert.equal(single.body.toString(), SOURCES['js/b.js']);
  assert.equal((await get(hashed('js/b.js'))).headers['cache-control'], LONG);

  // A changed file: the same address with a new hash; the old URL is no longer cached for long and answers with the new content.
  change(path.join(dir, 'js/b.js'), 'const B = "changed";\n');
  const next = tagsOf(assets.rewritePage(page))[0];
  assert.equal(next.split('?v=')[0], urlPath);
  assert.notEqual(next.split('?v=')[1], version, 'a changed file changes the hash of the combined script');
  const changed = await get(next, { 'Accept-Encoding': 'gzip' });
  assert.equal(changed.headers['cache-control'], LONG);
  assert.equal(run(zlib.gunzipSync(changed.body))[1].text, `const B = "changed";\n\n//# sourceURL=${ORIGIN}/js/b.js`);
  const old = await get(tags[0], { 'Accept-Encoding': 'identity' });
  assert.equal(old.headers['cache-control'], 'no-cache');
  assert.equal(sha16(old.body), next.split('?v=')[1]);
  // Also when no page was made in between (the file changes while pages are open): the next request sees it.
  change(path.join(dir, 'js/a.js'), 'const A = "again";\n');
  assert.equal(run((await get(urlPath, { 'Accept-Encoding': 'identity' })).body)[0].text, `const A = "again";\n\n//# sourceURL=${ORIGIN}/js/a.js`);
  // A file that is gone is left out, as its own tag would have failed to load.
  fs.rmSync(path.join(dir, 'js/c.js'));
  assert.deepEqual(run((await get(urlPath, { 'Accept-Encoding': 'identity' })).body).map(part => part.src), ['/js/a.js', '/js/b.js']);
  assert.deepEqual(tagsOf(assets.rewritePage(page)).slice(0, 2).map(tag => tag.split('?')[0].replace(/combined-[0-9a-f]+/, 'combined')), ['/js/combined.js', '/js/c.js'], 'and the next page combines what is left');
});

test('a page after the first reads no file again and looks at each file once', async t => {
  const files = { 'css/page.css': 'body { margin: 0; }', 'js/main.js': 'window.main = 1;', 'js/lazy-ui.js': 'window.Lazy = 1;', 'css/lazy.css': '.lazy { color: red; }' };
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) files[`js/${name}.js`] = `window.${name} = 1;`;
  const dir = folder(t, files);
  const assets = createStaticAssets({ publicDir: dir });
  const page = `<link rel="stylesheet" href="/css/page.css">\n${['a', 'b', 'c', 'd', 'e', 'f'].map(name => `<script defer src="/js/${name}.js" data-combine></script>`).join('\n')}\n<script defer src="/js/main.js"></script>`;
  const first = assets.rewritePage(page);
  await assets.idle();
  const calls = { statSync: 0, readFileSync: 0, readdirSync: 0 };
  const originals = {};
  for (const name of Object.keys(calls)) { originals[name] = fs[name]; fs[name] = function counted(...args) { calls[name] += 1; return originals[name].apply(this, args); }; }
  t.after(() => Object.assign(fs, originals));
  let html;
  try { html = assets.rewritePage(page); } finally { Object.assign(fs, originals); }
  assert.equal(html, first);
  assert.equal(calls.readFileSync, 0, 'no file is read again: the hashes and the combined script are kept while the files are unchanged');
  assert.equal(calls.readdirSync, 0, 'the list of files is kept for a few seconds');
  assert.equal(calls.statSync, Object.keys(files).length, 'one look at each file (its size and modification time)');
});

test('the real page: its two combined scripts hold the marked files as they are, and every file a loader names is known by its hash', () => {
  const assets = createStaticAssets({ publicDir: PUBLIC });
  const source = fs.readFileSync(path.join(PUBLIC, 'h5.html'), 'utf8');
  const marked = [...source.matchAll(/<script defer src="([^"]+)" data-combine><\/script>/g)].map(match => match[1]);
  const hashOf = urlPath => sha16(fs.readFileSync(path.join(PUBLIC, urlPath)));
  const chinese = assets.rewritePage(source, { zh: true });
  const english = assets.rewritePage(source, { zh: false });
  const tags = tagsOf(chinese);
  assert.deepEqual(tags.map(tag => tag.split('?v=')[0].replace(/combined-[0-9a-f]{12}/, 'combined')), [
    '/js/combined.js', '/js/i18n-zh-ui.js', '/js/i18n-zh-server.js', '/js/i18n-zh-extra.js', '/vendor/xterm/xterm-5.5.0.js', '/vendor/xterm/addon-fit-0.10.0.js', '/vendor/xterm/addon-unicode11-0.8.0.js',
    '/js/h5-shell.js', '/js/combined.js', '/js/h5.js',
  ]);
  assert.deepEqual(tagsOf(english), tags.filter(tag => !tag.includes('i18n-zh-')), 'the English page: the same without the dictionaries');
  const parts = [];
  for (const tag of tags) {
    const [urlPath, version] = tag.split('?v=');
    const combined = assets.combinedScript(urlPath);
    if (!combined) { assert.equal(version, hashOf(urlPath), `${urlPath} carries the hash of its content`); continue; }
    assert.equal(version, sha16(combined.body));
    const ran = run(combined.body);
    assert.deepEqual(ran.map(part => part.src), combined.files);
    for (const part of ran) assert.equal(part.text, `${fs.readFileSync(path.join(PUBLIC, part.src), 'utf8')}\n//# sourceURL=${ORIGIN}${part.src}`, `${part.src} is in the combined script as it is in its file`);
    parts.push(combined.files);
  }
  assert.deepEqual(parts, [marked.slice(0, 3), marked.slice(3)], 'the run in the head and the run in the body, in the order of the page');
  assert.deepEqual(parts[0], ['/js/i18n.js', '/js/toast.js', '/js/client-auth.js']);

  // Every script or style a lazy loader names is among the files the page knows the hash of (a loader that names a new file needs no list here,
  // but its file has to be under /js, /css or /vendor).
  const map = later(english).map;
  const named = new Set();
  for (const file of ['public/js/agent-chat.js', 'public/js/mindmap.js', 'public/js/i18n.js', 'scripts/h5-shell/Design.jsx']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(text, /window\.TAAsset\(/, `${file} asks for its files through the page's hashes`);
    assert.doesNotMatch(text, /currentScript/, `${file} does not build an address from its own tag`);
    for (const [, urlPath] of text.matchAll(/'(\/(?:js|css|vendor)\/[\w./-]+\.(?:js|css))'/g)) named.add(urlPath);
  }
  assert.deepEqual([...named].sort(), ['/css/agent-chat.css', '/css/markdown.css', '/js/agent-chat-ui.js', '/js/i18n-zh-extra.js', '/js/i18n-zh-server.js', '/js/i18n-zh-ui.js', '/js/markdown-view.js', '/js/mindmap-ui.js', '/vendor/marked/marked-15.0.12.min.js', '/vendor/mermaid/mermaid-12.1.0.min.js']);
  for (const urlPath of named) assert.equal(map[urlPath], hashOf(urlPath), `the page knows the hash of ${urlPath}`);
  for (const urlPath of marked) assert.equal(map[urlPath], undefined, `${urlPath} is loaded by the page`);
  assert.equal(later(chinese).map['/js/i18n-zh-ui.js'], undefined, 'the Chinese page loads its dictionaries itself');
});

// The small loaders, run with a document that only records what they add to the page.
// `chatLinked`: the page already has a link to the chat's style sheet. The page's own style sheet (h5.css) is always there.
function loaderPage({ withAssets, chatLinked = false }) {
  const added = [];
  const element = name => ({ name, attrs: {}, style: {}, setAttribute(key, value) { this.attrs[key] = value; }, remove() { added.splice(added.indexOf(this), 1); } });
  const pageSheet = { after(node) { added.push(node); node.place = 'after h5.css'; } };
  const document = {
    activeElement: null,
    head: { append(node) { added.push(node); node.place = 'end of head'; } },
    createElement: element,
    createElementNS: (ns, name) => element(name),
    querySelector: selector => (selector.includes('/css/h5.css') ? pageSheet : selector.includes('/css/agent-chat.css') && chatLinked ? {} : null),
  };
  const window = withAssets ? { TAAsset: urlPath => `${urlPath}?v=hash-of-${urlPath.split('/').pop()}` } : {};
  return { added, context: { document, window } };
}

test('the chat and mind map loaders ask for their bundles by the hash the page carries, and by the plain address without it', async () => {
  const chat = fs.readFileSync(path.join(PUBLIC, 'js/agent-chat.js'), 'utf8');
  const mindmap = fs.readFileSync(path.join(PUBLIC, 'js/mindmap.js'), 'utf8');
  const container = () => ({ style: {}, textContent: '', setAttribute() {} });
  for (const withAssets of [true, false]) {
    const url = urlPath => (withAssets ? `${urlPath}?v=hash-of-${urlPath.split('/').pop()}` : urlPath);
    // The mind map: one script.
    const map = loaderPage({ withAssets });
    vm.runInNewContext(`${mindmap}\nMindMap.mount(container, { onClose() {} });`, { ...map.context, container: container() });
    assert.deepEqual(map.added.map(node => [node.name, node.src]), [['script', url('/js/mindmap-ui.js')]]);
    // The chat: its bundle and its style sheet together, the style sheet right after the page's own.
    const page = loaderPage({ withAssets });
    const notices = [];
    vm.runInNewContext(`${chat}\nthis.view = AgentChat.mount(container, { conversation: { agent: 'claude' }, notify: message => notices.push(message) });`, { ...page.context, container: container(), notices });
    // The style sheet goes where its tag used to be, after h5.css, so rules of the same weight keep their order.
    assert.deepEqual(page.added.map(node => [node.name, node.src || node.href, node.place]).sort(), [['link', url('/css/agent-chat.css'), 'after h5.css'], ['script', url('/js/agent-chat-ui.js'), 'end of head']]);
    assert.equal(page.added.find(node => node.name === 'link').rel, 'stylesheet');
    // A style sheet that fails to load: the chat is not drawn unstyled, the person is told, and the failed tag is gone so the next chat tries again.
    page.added.find(node => node.name === 'link').onerror();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(notices, ['The chat view could not be loaded']);
    assert.deepEqual(page.added.map(node => node.name), ['script']);
  }
  // A page that links the chat's style sheet itself (a test page, a page from before): no second one.
  const linked = loaderPage({ withAssets: true, chatLinked: true });
  vm.runInNewContext(`${chat}\nAgentChat.mount(container, { conversation: { agent: 'claude' } });`, { ...linked.context, container: container() });
  assert.deepEqual(linked.added.map(node => node.name), ['script']);
});

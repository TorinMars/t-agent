// How the page's scripts and styles reach a real Chromium through lib/static-assets.js, served by a real HTTP server with the middleware of server.js
// (precompressed copies, compression, express.static with the cache headers), so the browser's own cache decides what is asked for again:
// - the first load of the page (English and Chinese) asks for the two runs of small scripts as two combined requests, every URL carries a content hash
//   and is answered `immutable`, and the page works (no errors, the Chinese page is in Chinese);
// - the shell is an ES module: the chunks it imports (/js/chunks/<name>-<hash>.js, scripts/build-page-bundles.js) are named by their content hash,
//   preloaded by the page and cached for a year by name;
// - the lazy loaders (the chat bundle and its style sheet, the mind map bundle, the document preview's Markdown renderer and mermaid) ask for each
//   file by the hash of that file, or by a chunk name, get the year-long cache, and the chat is drawn with its style sheet and highlighted code; the
//   screens that open on demand (Settings, T-Attention, the design sheet) load their chunks the same way;
// - a second visit asks the server for none of these files again (all from the browser's cache);
// - in a combined script each part is a script of its own: a part that throws or does not parse stops nothing after it, top-level names are shared
//   as with separate tags, 'use strict' stays in its file, and an error names the file it came from.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const express = require('express');
const compression = require('compression');
const { createStaticAssets, wantsChinese } = require('../lib/static-assets');

const root = path.resolve(__dirname, '..');
const PUBLIC = path.join(root, 'public');
const LONG = 'public, max-age=31536000, immutable';
const sha16 = content => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
const hashOf = urlPath => sha16(fs.readFileSync(path.join(PUBLIC, urlPath)));
const DESIGN_MD = ['# Design of Fix login', '', 'Some **bold** text.', '', '```js', 'const answer = 42;', '```', '', '```mermaid', 'graph TD', '  A --> B', '```', ''].join('\n');
const CHUNK = /^\/js\/chunks\/[\w.-]+-[A-Z0-9]{8}\.js$/;

// An app like server.js: the page through rewritePage, the static files with the same middleware, and the few API answers the page needs.
// `seen`: every request that reached the server ({ url, status, cacheControl, encoding, bytes }; bytes: the body as sent, after compression).
function makeApp(assets, publicDir, page, seen) {
  const app = express();
  app.use((req, res, next) => {
    let bytes = 0;
    const { write, end } = res;
    res.write = function counted(chunk, ...rest) { if (chunk) bytes += Buffer.byteLength(chunk); return write.call(this, chunk, ...rest); };
    res.end = function counted(chunk, ...rest) { if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk); return end.call(this, chunk, ...rest); };
    res.on('finish', () => seen.push({ url: req.originalUrl, status: res.statusCode, cacheControl: res.getHeader('cache-control'), encoding: res.getHeader('content-encoding') || null, bytes }));
    next();
  });
  app.get('/h5', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(assets.rewritePage(fs.readFileSync(path.join(publicDir, page), 'utf8'), { zh: wantsChinese(req) }));
  });
  const json = body => (req, res) => res.json(body);
  app.get('/api/remote-servers', json([]));
  app.get('/api/tasks', json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]));
  app.get('/api/task-groups', json([{ key: 'doing', name: 'In progress', sort_order: 1 }]));
  app.get('/api/tasks/1/terminals', json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]));
  app.get(['/api/tasks/terminal-activity', '/api/tasks/terminal-subagents'], json({}));
  app.get('/api/oss/config', json({ enabled: false }));
  app.get(['/api/system/check-update', '/api/system/update-status'], json({ status: 'current', local_version: '1.0.0' }));
  app.get('/api/agent-chat/summary', json({ running: 0, queued: 0, submitted: 0 }));
  app.get('/api/mindmaps', json({ maps: [] }));
  app.get('/api/tasks/1/files/content', json({ path: 'DESIGN.md', content: DESIGN_MD, revision: 'r1', eol: '\n', bom: false }));
  app.get('/api/tasks/1/agent/conversations', json([{ id: 'c1', agent: 'claude', session_id: null, title: 'New chat', mode: 'ask', running: false, opened: { web: null, h5: null } }]));
  app.get('/api/tasks/1/agent/conversations/c1', json({ conversation: { id: 'c1' }, items: [{ id: 'u1', kind: 'user', text: 'hello agent' }, { id: 't1', kind: 'text', text: 'Hi **there**\n\n```js\nconst answer = 42;\n```' }], pending: [], status: 'idle', seq: 0 }));
  app.get('/api/tasks/1/agent/conversations/c1/events', (req, res) => { res.type('text/event-stream'); res.end(': ok\n\n'); });
  app.use(['/js', '/css', '/vendor'], assets.precompressed);
  app.use('/vendor', compression(), express.static(path.join(publicDir, 'vendor'), { index: false, setHeaders: assets.setHeaders }));
  app.use(['/js', '/css'], compression());
  app.use(express.static(publicDir, { index: false, setHeaders: assets.setHeaders }));
  app.use((req, res) => res.status(404).json({ error: 'not mocked' }));
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function newContext(browser, origin, { zh = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (zh) await context.addCookies([{ name: 'ta-lang', value: 'zh', url: origin }]);
  await context.addInitScript(lang => {
    // The remembered task and terminal, so the page opens the terminal at once, and the language (i18n.js keeps it here and in the ta-lang cookie).
    try { localStorage.setItem('h5-task:local', '1'); localStorage.setItem('h5-terminal:local:1', 'h5-default'); localStorage.setItem('ta-lang', lang); } catch { /* not the page origin */ }
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  }, zh ? 'zh' : 'en');
  return context;
}

const isAsset = entry => /^\/(js|css|vendor)\//.test(entry.url);
const plain = url => url.split('?')[0].replace(/combined-[0-9a-f]{12}/, 'combined');

async function waitFor(condition, what) {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(condition(), `timed out waiting for ${what}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const pageErrors = [];
  const seen = [];
  const assets = createStaticAssets({ publicDir: PUBLIC });
  // As server.js does at start: the page once, so its copies (and the combined scripts) are ready for the first visitor.
  assets.rewritePage(fs.readFileSync(path.join(PUBLIC, 'h5.html'), 'utf8'));
  await assets.idle();
  const { server, origin } = await listen(makeApp(assets, PUBLIC, 'h5.html', seen));
  try {
    // 1. First load, English and Chinese: two combined requests instead of 19 small scripts, every URL hashed and cached for a year.
    const firstLoad = {};
    for (const zh of [false, true]) {
      const context = await newContext(browser, origin, { zh });
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(`${zh ? 'zh' : 'en'}: ${error.message}`));
      seen.length = 0;
      await page.goto(`${origin}/h5`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.sockets.length > 0 && window.sockets[0].readyState === 1);
      await page.locator('.h5-header').waitFor();
      const loaded = seen.filter(isAsset);
      const chunks = assets.modulePreloads('/js/h5-shell.js');
      assert.ok(chunks.length >= 1 && chunks.length <= 4, `the shell imports a few chunks: ${chunks}`);
      const expected = ['/vendor/xterm/xterm-5.5.0.css', '/css/h5.css', '/js/combined.js',
        ...(zh ? ['/js/i18n-zh-ui.js', '/js/i18n-zh-server.js', '/js/i18n-zh-extra.js'] : []),
        '/vendor/xterm/xterm-5.5.0.js', '/vendor/xterm/addon-fit-0.10.0.js', '/vendor/xterm/addon-unicode11-0.8.0.js', '/js/h5-shell.js', ...chunks, '/js/combined.js', '/js/h5.js'];
      assert.deepEqual(loaded.map(entry => plain(entry.url)).sort(), expected.slice().sort(), `${zh ? 'Chinese' : 'English'}: the scripts and styles of the first load`);
      assert.equal(await page.locator('link[rel="modulepreload"]').count(), chunks.length, 'each chunk of the shell is preloaded');
      for (const entry of loaded) {
        if (entry.url.startsWith('/js/chunks/')) {
          assert.match(entry.url, CHUNK, `${entry.url}: a chunk is named by its hash, with no ?v=`);
          assert.equal(entry.status, 200, entry.url);
          assert.equal(entry.cacheControl, LONG, `${entry.url} is cached for a year`);
          continue;
        }
        assert.match(entry.url, /\?v=[0-9a-f]{16}$/, `${entry.url} carries a hash`);
        assert.equal(entry.status, 200, entry.url);
        assert.equal(entry.cacheControl, LONG, `${entry.url} is cached for a year`);
        if (!entry.url.includes('/combined-')) assert.equal(entry.url.split('?v=')[1], hashOf(entry.url.split('?')[0]), `${entry.url}: the hash of its own content`);
      }
      assert.equal(await page.evaluate(() => I18n.get()), zh ? 'zh' : 'en');
      // Each part of a combined script ran: the globals of the first run (i18n, toast, client auth) and of the second (the terminal helpers, chat, mind map).
      assert.deepEqual(await page.evaluate(() => [typeof I18n, typeof Toast, typeof TerminalProtocol, typeof VoiceInput, typeof AgentChat, typeof MindMap]), Array(6).fill('object'));
      if (zh) assert.ok(/[\u4e00-\u9fff]/.test(await page.locator('body').innerText()), 'the Chinese page is drawn in Chinese');
      const all = seen.filter(entry => entry.url === '/h5' || isAsset(entry));
      firstLoad[zh ? 'zh' : 'en'] = { requests: all.length, bytes: all.reduce((sum, entry) => sum + entry.bytes, 0), encodings: [...new Set(loaded.map(entry => entry.encoding))].join('/') };
      await context.close();
    }

    // 2. The lazy loaders, in one context: each file is asked for by the hash of its own content and gets the year-long cache.
    // Each view in a page of its own (one context, so one browser cache).
    const context = await newContext(browser, origin);
    const open = async (url, ready = true) => {
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(`lazy: ${error.message}`));
      await page.goto(`${origin}${url}`, { waitUntil: 'load' });
      if (ready) await page.waitForFunction(() => window.sockets.length > 0 && window.sockets[0].readyState === 1);
      return page;
    };
    const lazyRequest = urlPath => seen.find(entry => entry.url.split('?')[0] === urlPath);
    const expectLazy = urlPath => {
      const entry = lazyRequest(urlPath);
      assert.ok(entry, `${urlPath} was loaded`);
      assert.equal(entry.url, `${urlPath}?v=${hashOf(urlPath)}`, `${urlPath} is asked for by the hash of its own content`);
      assert.equal(entry.status, 200);
      assert.equal(entry.cacheControl, LONG, `${urlPath} is cached for a year`);
    };
    const openAll = async () => {
      // The chat (a notification link): its bundle and its style sheet, and the chat is drawn styled.
      let page = await open('/h5?openChat=1:c1', false);
      await page.locator('#h5-agent .ac-bubble', { hasText: 'hello agent' }).waitFor();
      const styled = await page.evaluate(() => {
        const chat = document.querySelector('#h5-agent .agent-chat');
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => new URL(link.href).pathname);
        return { display: getComputedStyle(chat).display, bg: getComputedStyle(chat).getPropertyValue('--ac-bg').trim(), links };
      });
      assert.equal(styled.display, 'flex', 'the chat is laid out by agent-chat.css');
      assert.ok(styled.bg, 'the chat has its colours');
      assert.deepEqual(styled.links.slice(0, 3), ['/vendor/xterm/xterm-5.5.0.css', '/css/h5.css', '/css/agent-chat.css'], 'the chat style sheet goes right after the page one');
      // The chat's code is highlighted (highlight.js from the chunk it shares with the design sheet), and it runs on the shell's React.
      await page.locator('#h5-agent .hljs-keyword', { hasText: 'const' }).waitFor();
      await page.close();
      // The mind map.
      page = await open('/h5');
      if (!await page.locator('#h5-tasks-mindmap').isVisible().catch(() => false)) {
        await page.locator('#h5-open-tasks').tap();
        await page.locator('#h5-tasks-mindmap').waitFor({ state: 'visible' });
      }
      await page.locator('#h5-tasks-mindmap').tap();
      await page.locator('#mm-new').waitFor();
      await page.close();
      // The document preview: marked, the Markdown view and its style sheet, and mermaid for the diagram.
      page = await open('/h5');
      await page.locator('#h5-design').tap();
      await page.locator('#h5-design-body h1', { hasText: 'Design of Fix login' }).waitFor();
      await page.locator('#h5-design-body .hljs-keyword', { hasText: 'const' }).waitFor();
      await page.waitForFunction(() => typeof window.mermaid === 'object' && window.mermaid);
      await page.close();
      // The screens that open on demand: Settings and the T-Attention panel come from their chunks.
      page = await open('/h5');
      await page.evaluate(() => window.H5UI.actions.openSettings());
      await page.locator('#h5-settings .h5-setting-group').first().waitFor();
      await page.evaluate(() => window.H5UI.actions.closeSettings());
      await page.locator('#h5-attention').tap();
      await page.locator('#h5-attention-sheet').waitFor();
      await page.close();
    };
    seen.length = 0;
    await openAll();
    for (const urlPath of ['/js/agent-chat-ui.js', '/css/agent-chat.css', '/js/mindmap-ui.js', '/vendor/marked/marked-15.0.12.min.js', '/css/markdown.css', '/vendor/mermaid/mermaid-12.1.0.min.js']) expectLazy(urlPath);
    assert.equal(lazyRequest('/js/markdown-view.js'), undefined, 'the page takes the Markdown view from its chunk, not from the share page file');
    const lazyChunks = seen.filter(entry => entry.url.startsWith('/js/chunks/'));
    for (const name of ['screen-settings', 'screen-attention', 'screen-design', 'markdown-view-entry']) assert.ok(lazyChunks.some(entry => entry.url.startsWith(`/js/chunks/${name}-`)), `the ${name} chunk was loaded`);
    for (const entry of lazyChunks) {
      assert.match(entry.url, CHUNK, entry.url);
      assert.equal(entry.status, 200, entry.url);
      assert.equal(entry.cacheControl, LONG, `${entry.url} is cached for a year`);
    }
    const lazyBytes = seen.filter(entry => /agent-chat-ui|agent-chat\.css|mindmap-ui|marked-|\/chunks\/|markdown\.css|mermaid-/.test(entry.url)).reduce((sum, entry) => sum + entry.bytes, 0);

    // 3. The same again, as a later visit: no script or style is asked for again, the lazy ones included.
    seen.length = 0;
    await openAll();
    const again = seen.filter(isAsset);
    assert.deepEqual(again.map(entry => entry.url), [], 'a later visit takes every script and style from the browser cache');
    await context.close();

    // 4. A combined script in a real browser: each part is a script of its own.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-assets-browser-'));
    try {
      const files = {
        'js/a.js': 'const shared = "from a"; let counter = 1; function helper() { return "helper"; }\nwindow.order = ["a"];\nwindow.aScript = document.currentScript && document.currentScript.getAttribute("data-src");\n',
        'js/b.js': 'window.order.push("b");\nthrow new Error("b fails");\n',
        'js/c.js': 'window.order.push("c";\n', // a syntax error
        'js/d.js': '\'use strict\';\nwindow.order.push("d:" + shared + ":" + helper() + ":" + (++counter));\nwindow.dStrict = (function () { return this === undefined; })();\n',
        'js/e.js': 'sloppyGlobal = "e";\nwindow.eStrict = (function () { return this === undefined; })();\nwindow.order.push("e");\n',
        'js/after.js': 'window.order.push("after");\n',
      };
      for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), content); }
      const test = ['<!doctype html><html><head><meta charset="utf-8">',
        '<script>window.errors = []; window.addEventListener("error", event => window.errors.push({ message: event.message, stack: event.error && event.error.stack || "" }));</script>',
        ...['a', 'b', 'c', 'd', 'e'].map(name => `<script defer src="/js/${name}.js" data-combine></script>`),
        '<script defer src="/js/after.js"></script>',
        '</head><body></body></html>'].join('\n');
      fs.writeFileSync(path.join(dir, 'test.html'), test);
      const partsAssets = createStaticAssets({ publicDir: dir });
      const parts = await listen(makeApp(partsAssets, dir, 'test.html', []));
      try {
        const partsContext = await browser.newContext();
        const partsPage = await partsContext.newPage();
        const thrown = [];
        partsPage.on('pageerror', error => thrown.push(error.message));
        await partsPage.goto(`${parts.origin}/h5`, { waitUntil: 'load' });
        const result = await partsPage.evaluate(() => ({ order: window.order, aScript: window.aScript, dStrict: window.dStrict, eStrict: window.eStrict, sloppy: window.sloppyGlobal, errors: window.errors, scripts: [...document.scripts].map(script => script.getAttribute('src')).filter(Boolean) }));
        assert.equal(result.scripts.length, 2, 'one combined script and the unmarked one');
        assert.deepEqual(result.order, ['a', 'b', 'd:from a:helper:2', 'e', 'after'], 'a throwing part and a part that does not parse stop nothing; top-level const / let / function are shared');
        assert.equal(result.aScript, '/js/a.js', 'document.currentScript is the part, with its address in data-src');
        assert.equal(result.dStrict, true, "'use strict' holds in its file");
        assert.equal(result.eStrict, false, 'and not in the next one');
        assert.equal(result.sloppy, 'e');
        assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
        assert.match(result.errors[0].message, /b fails/);
        assert.match(result.errors[0].stack, /\/js\/b\.js:2/, 'the stack names the file and its own line');
        assert.match(result.errors[1].message, /SyntaxError|missing \) after argument list|Unexpected token/i);
        await partsContext.close();
      } finally { parts.server.closeAllConnections(); await new Promise(resolve => parts.server.close(resolve)); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    assert.deepEqual(pageErrors, [], 'no browser errors');
    console.log(`First load (requests for the page, its scripts and styles; bytes as sent): English ${firstLoad.en.requests} requests, ${firstLoad.en.bytes} bytes (${firstLoad.en.encodings}); Chinese ${firstLoad.zh.requests} requests, ${firstLoad.zh.bytes} bytes. Lazy files: ${lazyBytes} bytes, none asked for again on a later visit.`);
    console.log('Page assets: combined small scripts, hashed lazy bundles with the year-long cache, a styled chat and isolated parts passed.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Browser test of the page while its engine is down (public/sw.js, public/offline.html, public/js/offline.js; "The page while its engine is down" in
// docs/design/failover-and-one-login.md). Two real HTTP servers stand for engine T01 (the page's) and its linked engine K01; the real service worker
// (as server.js sends it, lib/service-worker.js) is installed by T01's page. Then T01 goes down: its page still opens and says "T01 can't be reached",
// offers "Continue on K01" only when K01 answers, the button opens K01's page, and the page comes back by itself once T01 answers again. A proxy's
// 502 counts as down; nothing else of the engine is served from the cache. SHOTS=<folder> saves a 390px screenshot.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createServiceWorkerSource, OFFLINE_FILES } = require('../lib/service-worker');

const root = path.resolve(__dirname, '..');
const PUBLIC = path.join(root, 'public');
const swSource = createServiceWorkerSource({ publicDir: PUBLIC });
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

// The offline files of the worker and of the server are the same list.
const workerFiles = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8').match(/const OFFLINE_FILES = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
assert.deepEqual(workerFiles.map(file => file.slice(1)), OFFLINE_FILES, 'public/sw.js and lib/service-worker.js list the same offline files');

function startServer(handler, port = 0) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  // T01: `down` null (up), 'reset' (nothing answers: every connection is cut) or 502 (a proxy in front of a stopped engine).
  const t01 = { down: null, pageHits: 0, apiHits: 0 };
  const k01 = { up: true };
  let k01Port = 0;
  const pageHtml = () => `<!doctype html><meta charset="utf-8"><title>T01 page</title><body><h1 id="live">Live page of T01</h1><script>
    localStorage.setItem('ta-linked-engines', JSON.stringify({ self: { instance_id: 'inst-t01', name: 'T01' }, peers: [{ instance_id: 'inst-k01', name: 'K01', addresses: ['http://127.0.0.1:${k01Port}'] }] }));
    navigator.serviceWorker.register('/sw.js');
  </script></body>`;
  const t01Server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (t01.down === 'reset') { req.socket.destroy(); return; }
    if (t01.down === 502) { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<h1>Bad gateway</h1>'); return; }
    if (url.pathname === '/' || url.pathname === '/h5') { t01.pageHits += 1; res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(pageHtml()); return; }
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (url.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' }); res.end(swSource()); return; }
    if (url.pathname.startsWith('/api/')) { t01.apiHits += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"live":true}'); return; }
    const file = path.join(PUBLIC, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404); res.end('no');
  });
  const k01Server = await startServer((req, res) => {
    if (!k01.up) { req.socket.destroy(); return; }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>K01</title><h1 id="k01">Page of K01 at ${url.pathname}</h1>`);
  });
  k01Port = k01Server.address().port;
  // localhost is a secure context, so the worker runs over plain HTTP; K01 is another origin.
  const T01 = `http://localhost:${t01Server.address().port}`;

  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    const tab = await context.newPage();
    await tab.goto(`${T01}/h5`);
    await tab.waitForSelector('#live');
    await tab.evaluate(async () => { await navigator.serviceWorker.ready; });
    await tab.waitForFunction(async () => {
      const names = await caches.keys();
      if (!names.some(name => name.startsWith('t-agent-offline-'))) return false;
      return Boolean(await caches.match('/offline.html')) && Boolean(await caches.match('/js/offline.js'));
    }, null, { timeout: 10000 });
    // Up: the page is the engine's own, every visit goes to it.
    const hits = t01.pageHits;
    await tab.reload();
    await tab.waitForSelector('#live');
    assert.equal(t01.pageHits, hits + 1, 'a visit while the engine is up reaches the engine');

    // Down (nothing answers): the offline view, with "Continue on K01".
    t01.down = 'reset';
    await tab.goto(`${T01}/h5`);
    await tab.waitForSelector('#offline-title');
    await tab.waitForSelector('.offline-button', { timeout: 10000 });
    assert.equal(await tab.textContent('#offline-title'), "T01 can't be reached");
    assert.equal(await tab.textContent('#offline-text'), 'Your tasks on K01 are still running. Continue there; this page comes back by itself when T01 answers.');
    assert.deepEqual(await tab.$$eval('.offline-button', buttons => buttons.map(button => button.textContent)), ['Continue on K01']);
    assert.equal(await tab.textContent('#offline-retry'), 'Try again');
    // Targets of at least 36px (44px with touch) and nothing wider than the screen.
    const box = await tab.locator('.offline-button').boundingBox();
    assert.ok(box.height >= 36, `button height ${box.height}`);
    assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll at 390px');
    if (process.env.SHOTS) await tab.screenshot({ path: path.join(process.env.SHOTS, 'failover-offline-view-390.png') });
    // No API answer comes from the cache: a request to the engine fails like any other while it is down.
    const apiBefore = t01.apiHits;
    assert.equal(await tab.evaluate(() => fetch('/api/tasks').then(() => 'answered', () => 'failed')), 'failed');
    assert.equal(t01.apiHits, apiBefore);

    // "Continue on K01" opens K01's page at the same page path.
    await tab.click('.offline-button');
    await tab.waitForSelector('#k01');
    assert.equal(await tab.textContent('#k01'), 'Page of K01 at /h5');

    // K01 down too: no button, the view says so.
    k01.up = false;
    await tab.goto(`${T01}/`);
    await tab.waitForFunction(() => /No other device answers either/.test(document.getElementById('offline-text').textContent), null, { timeout: 15000 });
    assert.equal(await tab.$$eval('.offline-button', buttons => buttons.length), 0);
    assert.equal(await tab.textContent('#offline-text'), 'No other device answers either. This page comes back by itself when T01 answers.');

    // A proxy's 502 counts as down too.
    k01.up = true;
    t01.down = 502;
    await tab.goto(`${T01}/`);
    await tab.waitForSelector('.offline-button', { timeout: 10000 });
    assert.equal(await tab.textContent('#offline-title'), "T01 can't be reached");

    // T01 answers again: the page comes back by itself (the health check runs every 5 s).
    t01.down = null;
    await tab.waitForSelector('#live', { timeout: 12000 });
    assert.equal(new URL(tab.url()).pathname, '/');

    // Try again while it is still down keeps the view and looks again.
    t01.down = 'reset';
    await tab.goto(`${T01}/`);
    await tab.waitForSelector('.offline-button', { timeout: 10000 });
    t01.down = null;
    await tab.click('#offline-retry');
    await tab.waitForSelector('#live', { timeout: 5000 });

    // Chinese: the view is translated through the same dictionaries as the page.
    await tab.evaluate(() => localStorage.setItem('ta-lang', 'zh'));
    t01.down = 'reset';
    await tab.goto(`${T01}/`);
    await tab.waitForSelector('.offline-button', { timeout: 10000 });
    assert.equal(await tab.textContent('#offline-title'), '\u65e0\u6cd5\u8fde\u63a5 T01');
    assert.equal(await tab.textContent('.offline-button'), '\u5728 K01 \u4e0a\u7ee7\u7eed');
    if (process.env.SHOTS) await tab.screenshot({ path: path.join(process.env.SHOTS, 'failover-offline-view-390-zh.png') });
    await context.close();
    console.log('Offline view: the page opens while T01 is down, offers Continue on K01 when K01 answers, opens it, and comes back by itself when T01 answers.');
  } finally {
    await browser.close();
    t01Server.close();
    k01Server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

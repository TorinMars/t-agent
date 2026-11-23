// The extension updates itself ("The extension updates itself" in docs/design/browser-extension.md), in a real headless Chromium: a copy of
// the extension folder is loaded unpacked, its manifest.json is made newer on disk, and the bridge's `reload` request makes the extension
// reload from that folder: the new version says hello, and the tab it owned before is still its own. Without a newer manifest it does nothing.
const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  WebSocketServer
} = require('ws');
const {
  chromium
} = require('playwright');
const delay = ms => new Promise(r => setTimeout(r, ms));
test('reload request: the unpacked extension reloads from its folder when the folder is newer', {
  timeout: 120000
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagent-reload-'));
  const ext = path.join(dir, 'extension');
  await fs.cp(path.resolve(__dirname, '..'), ext, {
    recursive: true,
    filter: source => !source.includes(`${path.sep}test`)
  });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Reload fixture</title><p>Page</p>');
  });
  const wss = new WebSocketServer({
    server,
    path: '/api/browser-ext/ws'
  });
  const hellos = [];
  let socket,
    seq = 0;
  const pending = new Map();
  wss.on('connection', ws => {
    socket = ws;
    ws.on('message', data => {
      const m = JSON.parse(data);
      if (m.type === 'hello') {
        hellos.push(m);
        ws.send(JSON.stringify({
          type: 'welcome',
          protocol: 1,
          server_name: 'Fixture',
          browser_id: 'fixture'
        }));
      }
      if (m.type === 'result') {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(r));
    await new Promise(r => server.close(r));
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  // Loaded like "Load unpacked" in chrome://extensions (CDP Extensions.loadUnpacked over Playwright's pipe): Chromium does not reload an
  // extension that --load-extension loaded, it unloads it.
  browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--headless=new', '--enable-unsafe-extension-debugging']
  });
  const cdp = await browser.newBrowserCDPSession();
  const {
    id: extensionId
  } = await cdp.send('Extensions.loadUnpacked', {
    path: ext
  });
  // The pairing, written into the extension's storage from its service worker (CDP Runtime.evaluate through Target.sendMessageToTarget).
  let worker;
  for (let n = 0; n < 100 && !worker; n++) {
    worker = (await cdp.send('Target.getTargets')).targetInfos.find(x => x.type === 'service_worker' && x.url.includes(extensionId));
    if (!worker) await delay(50);
  }
  const {
    sessionId
  } = await cdp.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: false
  });
  const replies = new Map();
  cdp.on('Target.receivedMessageFromTarget', e => {
    const m = JSON.parse(e.message);
    if (e.sessionId === sessionId) replies.get(m.id)?.(m);
  });
  let calls = 0;
  const evaluate = expression => new Promise(resolve => {
    const id = ++calls;
    replies.set(id, resolve);
    void cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          awaitPromise: true,
          expression
        }
      })
    });
  });
  const pairing = JSON.stringify({
    token: 'tab_local-fixture-only',
    server_url: base,
    name: 'Fixture'
  });
  let reply;
  // The worker's extension bindings may come a moment after its target.
  for (let n = 0; n < 50; n++) {
    reply = await evaluate(`chrome.storage?.local ? chrome.storage.local.set(${pairing}).then(() => 'ok') : 'not yet'`);
    if (reply.result?.result?.value === 'ok') break;
    await delay(100);
  }
  assert.equal(reply.result?.result?.value, 'ok', JSON.stringify(reply));
  for (let n = 0; n < 100 && !hellos.length; n++) await delay(50);
  const running = require('../manifest.json').version;
  assert.equal(hellos[0]?.version, running);
  assert.equal(hellos[0].install_type, 'development');
  const ok = async (method, params = {}) => {
    const id = `c_${++seq}`;
    const m = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 15000);
      pending.set(id, r => {
        clearTimeout(timer);
        resolve(r);
      });
      socket.send(JSON.stringify({
        type: 'cmd',
        id,
        method,
        params,
        timeout_ms: 10000
      }));
    });
    assert.equal(m.ok, true, JSON.stringify(m));
    return m.result;
  };
  const tab = (await ok('tabs.open', {
    url: base
  })).tab;
  // The folder is not newer: nothing happens.
  socket.send(JSON.stringify({
    type: 'reload',
    version: '99.0.0'
  }));
  await delay(800);
  assert.equal(hellos.length, 1, 'no reload while the folder holds the running version');
  // T-Agent updated the folder: the extension reloads and comes back with the new version and its tab.
  const manifest = JSON.parse(await fs.readFile(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.version = '99.0.0';
  await fs.writeFile(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  socket.send(JSON.stringify({
    type: 'reload',
    version: '99.0.0'
  }));
  for (let n = 0; n < 200 && hellos.length < 2; n++) await delay(50);
  assert.equal(hellos.length, 2, 'the extension reloaded and connected again');
  assert.equal(hellos[1].version, '99.0.0');
  assert.deepEqual(hellos[1].owned_tabs, [{
    tab_id: tab.tab_id
  }], 'the tab it owned is still its own');
  assert.equal((await ok('page.snapshot', {
    tab_id: tab.tab_id,
    mode: 'text'
  })).title, 'Reload fixture');
});

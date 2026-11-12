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
test('unpacked extension contract in local headless Chromium', {
  timeout: 120000
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagent-extension-'));
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/xhr')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'session=server-secret');
      res.end(JSON.stringify({
        ok: true,
        token: 'body-secret'
      }));
      return;
    }
    if (req.url === '/next') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Next</title><h1>Next page</h1><button id="after">After navigation</button>');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(await fs.readFile(path.join(__dirname, 'pages/form.html')));
  });
  const wss = new WebSocketServer({
    server,
    path: '/api/browser-ext/ws'
  });
  let socket,
    hello,
    seq = 0;
  const pending = new Map(),
    events = [];
  wss.on('connection', ws => {
    socket = ws;
    ws.on('message', data => {
      const m = JSON.parse(data);
      if (m.type === 'hello') {
        hello = m;
        ws.send(JSON.stringify({
          type: 'welcome',
          protocol: 1,
          server_name: 'Fixture',
          browser_id: 'fixture'
        }));
      }
      if (m.type === 'ping') ws.send('{"type":"pong"}');
      if (m.type === 'result') {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      }
      if (m.type === 'event') events.push(m);
    });
  });
  wss.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
    throw error;
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const ext = path.resolve(__dirname, '..');
  let context;
  t.after(async () => {
    await context?.close();
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(r));
    await new Promise(r => server.close(r));
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  context = await chromium.launchPersistentContext(dir, {
    headless: true,
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/options.html`);
  await setup.evaluate(async base => chrome.storage.local.set({
    token: 'tab_local-fixture-only',
    server_url: base,
    name: 'Fixture'
  }), base);
  for (let n = 0; n < 100 && !hello; n++) await delay(50);
  assert.equal(hello?.protocol, 1);
  assert.equal(hello?.version, '1.0.0');
  assert.equal(hello.methods.length, 25);
  const cmd = async (method, params = {}) => {
    const id = `c_${++seq}`;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 15000);
      pending.set(id, m => {
        clearTimeout(timer);
        resolve(m);
      });
      socket.send(JSON.stringify({
        type: 'cmd',
        id,
        method,
        params,
        timeout_ms: 10000
      }));
    });
    return response;
  };
  const ok = async (method, params = {}) => {
    const r = await cmd(method, params);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  let tabId, randomId;
  await t.test('group tabs, handover and takeback enforce scope', async () => {
    tabId = (await ok('tabs.open', {
      url: base,
      active: true
    })).tab.tab_id;
    await ok('page.wait', {
      tab_id: tabId,
      selector: '#name'
    });
    const random = await context.newPage();
    await random.goto(base);
    randomId = await setup.evaluate(async base => (await chrome.tabs.query({
      url: base + '/*'
    })).find(t => t.groupId === -1).id, base);
    assert.equal((await cmd('page.snapshot', {
      tab_id: randomId
    })).error.code, 'TAB_NOT_ALLOWED');
    await setup.evaluate(id => chrome.runtime.sendMessage({
      type: 'handover',
      tab_id: id
    }), randomId);
    assert.equal((await ok('page.snapshot', {
      tab_id: randomId
    })).title, 'Local browser fixture');
    await setup.evaluate(id => chrome.runtime.sendMessage({
      type: 'takeback',
      tab_id: id
    }), randomId);
    assert.equal((await cmd('page.snapshot', {
      tab_id: randomId
    })).error.code, 'TAB_NOT_ALLOWED');
    assert.equal((await cmd('tabs.open', {
      url: 'chrome://settings'
    })).error.code, 'TAB_NOT_SCRIPTABLE');
  });
  await t.test('snapshot refs, native input, MAIN eval and page fetch', async () => {
    const s = await ok('page.snapshot', {
      tab_id: tabId
    });
    assert(!JSON.stringify(s).includes('never-export-this'));
    const input = s.elements.find(e => e.selector === '#name');
    assert(input.ref);
    assert.equal(input.tag, 'input');
    await ok('input.type', {
      tab_id: tabId,
      target: {
        ref: input.ref
      },
      text: 'controlled value',
      clear: true
    });
    assert.equal((await ok('page.eval', {
      tab_id: tabId,
      expression: 'window.controlled'
    })).value, 'controlled value');
    await ok('input.select', {
      tab_id: tabId,
      target: {
        selector: '#choice'
      },
      values: ['two']
    });
    assert.equal((await ok('page.eval', {
      tab_id: tabId,
      expression: 'document.querySelector("#choice").value'
    })).value, 'two');
    const f = await ok('page.fetch', {
      tab_id: tabId,
      url: '/xhr'
    });
    assert(f.body.includes('<redacted:11>'));
    assert(!JSON.stringify(f).includes('body-secret'));
    const html = await ok('page.snapshot', {
      tab_id: tabId,
      mode: 'html'
    });
    assert(!html.html.includes('never-export-this'));
  });
  await t.test('CDP network, redaction, raw exception and console', async () => {
    await ok('net.start', {
      tab_id: tabId
    });
    await ok('input.click', {
      tab_id: tabId,
      target: {
        selector: '#save'
      }
    });
    let requests = [];
    for (let n = 0; n < 100; n++) {
      requests = (await ok('net.list', {
        tab_id: tabId
      })).requests;
      if (requests.some(r => r.status === 200)) break;
      await delay(50);
    }
    const r = requests.find(r => r.url.includes('/xhr'));
    assert(r);
    assert(!r.url.includes('url-secret'));
    await delay(150);
    const d = await ok('net.get', {
      tab_id: tabId,
      req_id: r.req_id
    });
    assert(!JSON.stringify(d).includes('local-test-only'));
    assert(!JSON.stringify(d).includes('server-secret'));
    assert(!JSON.stringify(d).includes('body-secret'));
    const raw = await ok('net.get', {
      tab_id: tabId,
      req_id: r.req_id,
      raw: true
    });
    assert.equal(Object.entries(raw.request.headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1], 'Bearer local-test-only');
    assert(raw.response.body.includes('body-secret'));
    assert((await ok('page.console', {
      tab_id: tabId
    })).entries.some(e => e.text === 'request complete'));
    assert((await ok('net.stop', {
      tab_id: tabId
    })).count >= 1);
  });
  await t.test('record click, request, response and navigation; detach on stop', async () => {
    const r = await ok('record.start', {
      tab_id: tabId
    });
    await ok('input.click', {
      tab_id: tabId,
      target: {
        selector: '#save'
      }
    });
    await delay(300);
    await ok('input.type', {
      tab_id: tabId,
      target: {
        selector: '#password'
      },
      text: 'private-typed',
      clear: true
    });
    await ok('input.click', {
      tab_id: tabId,
      target: {
        selector: '#next'
      }
    });
    await ok('page.wait', {
      tab_id: tabId,
      selector: '#after'
    });
    await delay(600);
    await ok('input.click', {
      tab_id: tabId,
      target: {
        selector: '#after'
      }
    });
    const stopped = await ok('record.stop', {
      recording_id: r.recording_id
    });
    assert(stopped.items > 0);
    const items = events.filter(e => e.event === 'record.items').flatMap(e => e.data.items);
    for (const k of ['click', 'nav', 'request', 'response']) assert(items.some(i => i.kind === k), `Missing ${k}`);
    assert(!JSON.stringify(items).includes('private-typed'));
    assert(!JSON.stringify(items).includes('body-secret'));
    assert.equal((await ok('tabs.list')).tabs.find(t => t.tab_id === tabId).capturing, false);
  });
  await t.test('unpair close halts automatic reconnect', async () => {
    socket.close(4401, 'revoked');
    await delay(150);
    assert.equal((await setup.evaluate(() => chrome.runtime.sendMessage({
      type: 'status'
    }))).status, 'needs pairing');
  });
});

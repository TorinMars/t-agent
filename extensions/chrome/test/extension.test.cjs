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
  const hits = {};
  const server = http.createServer(async (req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/rec') {
      res.setHeader('Content-Type', 'text/html');
      res.end(await fs.readFile(path.join(__dirname, 'pages/record.html')));
      return;
    }
    if (req.url === '/rec.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile(path.join(__dirname, 'pages/record.js')));
      return;
    }
    if (req.url === '/rec.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(`.icon { cursor: pointer; display: inline-block } /* ${'padding '.repeat(40)} */`);
      return;
    }
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
  assert.equal(hello?.version, require('../manifest.json').version, 'hello carries the manifest version');
  assert.equal(hello.methods.length, 26);
  assert(hello.features.includes('open.record') && hello.features.includes('record.types'), 'hello lists the 1.0.4 features');
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
  await t.test('open with record: the first load once, filters, sources, target context and what appeared', async () => {
    const opened = await ok('tabs.open', {
      url: `${base}/rec`,
      active: true,
      record: {
        types: ['Document', 'XHR', 'Fetch'],
        max_body_bytes: 64
      }
    });
    assert.match(opened.recording_id, /^rec_/);
    assert.equal(opened.tab.url, `${base}/rec`);
    assert.equal(opened.tab.how, 'group');
    const id = opened.tab.tab_id;
    await ok('page.wait', {
      tab_id: id,
      selector: '#save'
    });
    await delay(700);
    // The person clicks the icon (a trusted click from outside the extension).
    const page = context.pages().find(p => p.url() === `${base}/rec`);
    await page.click('#icon');
    await delay(300);
    await ok('input.click', {
      tab_id: id,
      target: {
        selector: '#many'
      }
    });
    await delay(700);
    await ok('input.click', {
      tab_id: id,
      target: {
        selector: '#save'
      }
    });
    await delay(800);
    await ok('record.stop', {
      recording_id: opened.recording_id
    });
    const items = events.filter(e => e.event === 'record.items' && e.data.recording_id === opened.recording_id).flatMap(e => e.data.items);
    const text = JSON.stringify(items);
    assert.equal(hits['/rec'], 1, 'the page was loaded once: no reload');
    assert.deepEqual([items[0].kind, items[0].source, items[0].action], ['nav', 'agent', 'open']);
    const doc = items.find(i => i.kind === 'response' && i.url === `${base}/rec`);
    assert(doc, 'the first document request is recorded');
    assert.equal(doc.type, 'Document');
    assert(new TextEncoder().encode(doc.response.body).length <= 64, 'the body is cut at max_body_bytes');
    assert.equal(doc.response.body_truncated, true);
    assert(doc.response.body_bytes > 64, 'the size before the cut is kept');
    const script = items.find(i => i.kind === 'response' && i.url === `${base}/rec.js`);
    assert(script, 'a request of another type keeps its item');
    assert.equal(script.body_omitted, 'type');
    assert.equal(script.response.body, undefined);
    const xhr = items.find(i => i.kind === 'response' && i.url.includes('/xhr?first=1'));
    assert(xhr?.response.body.includes('"ok":true'), 'an XHR body is kept');
    assert(!text.includes('body-secret'));
    const user = items.find(i => i.kind === 'click' && i.source === 'user');
    assert(user, 'the person\'s click is recorded');
    assert.equal(user.nearest, undefined);
    assert.equal(user.target.nearest.aria_label, 'Refresh list');
    assert.equal(user.target.nearest.name, 'Refresh list');
    assert.equal(user.target.nearest.selector, '#refresh');
    assert(user.target.selector, 'the original fields stay');
    const saves = items.filter(i => i.kind === 'click' && i.target?.selector === '#save');
    assert.equal(saves.length, 1, 'an agent click is recorded once');
    assert.equal(saves[0].source, 'agent');
    assert.equal(saves[0].command, 'input.click');
    assert.equal(saves[0].target.nearest.name, 'Save order');
    const appeared = items.filter(i => i.kind === 'dom').flatMap(i => i.appeared || []);
    assert(appeared.some(a => a.type === 'heading' && a.text === 'Orders'), 'the first load\'s DOM is recorded (recorder installed at commit)');
    assert(appeared.some(a => a.type === 'alert' && a.text.startsWith('Saved with key')), JSON.stringify(appeared));
    assert(appeared.some(a => a.type === 'dialog' && a.text.startsWith('Confirm order')));
    assert(appeared.some(a => a.type === 'alert' && a.text === 'List refreshed'), 'text put into a live region');
    assert(!text.includes('eyJhbGciOiJIUzI1NiJ9'), 'a JWT in page text is redacted');
    assert(!text.includes('abcdefgh12345678'), 'a bearer token in page text is redacted');
    const many = items.filter(i => i.kind === 'dom' && (i.appeared || []).some(a => a.text?.startsWith('Item ')));
    assert.equal(many.length, 1);
    assert.equal(many[0].appeared.length, 20, 'at most 20 entries per item');
    assert(many[0].appeared_more >= 5);
    assert(many[0].appeared.every(a => a.text.length <= 120));
    assert(items.every(i => i.kind !== 'dom' || !('landmarks' in i)));
    await ok('tabs.close', {
      tab_id: id
    });
  });
  await t.test('unpair close halts automatic reconnect', async () => {
    socket.close(4401, 'revoked');
    await delay(150);
    assert.equal((await setup.evaluate(() => chrome.runtime.sendMessage({
      type: 'status'
    }))).status, 'needs pairing');
  });
});

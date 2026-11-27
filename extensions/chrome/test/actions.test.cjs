// The actions of extension 1.0.8 in real headless Chromium ("Actions: drag, upload, fill, check, dialogs" in docs/design/browser-extension.md):
// snapshot of open shadow roots and a same-origin iframe (refs that click and type there, by the page and through the debugger), stable refs,
// --filter interactive and --diff, fill and check, an HTML5 and a mouse drag, upload through DOM.setFileInputFiles, shot --zoom and --annotate,
// console --level / --pattern, and dialogs found and answered without a held debugger. A local fixture server only; no real site.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const delay = ms => new Promise(r => setTimeout(r, ms));

test('page actions of extension 1.0.8 in local headless Chromium', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagent-actions-'));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(await fs.readFile(path.join(__dirname, 'pages', req.url === '/frame' ? 'frame.html' : 'actions.html')));
  });
  const wss = new WebSocketServer({ server, path: '/api/browser-ext/ws' });
  let socket, hello, seq = 0;
  const pending = new Map(),
    events = [];
  wss.on('connection', ws => {
    socket = ws;
    ws.on('message', data => {
      const m = JSON.parse(data);
      if (m.type === 'hello') {
        hello = m;
        ws.send(JSON.stringify({ type: 'welcome', protocol: 1, server_name: 'Fixture', browser_id: 'fixture' }));
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ext = path.resolve(__dirname, '..');
  let context;
  t.after(async () => {
    await context?.close();
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(r));
    await new Promise(r => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    headless: true,
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  // Playwright answers every dialog itself unless a page has a listener: an empty one leaves them to the extension, as in the person's Chrome.
  context.on('page', p => p.on('dialog', () => {}));
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/options.html`);
  await setup.evaluate(async base => chrome.storage.local.set({ token: 'tab_local-fixture-only', server_url: base, name: 'Fixture' }), base);
  for (let n = 0; n < 100 && !hello; n++) await delay(50);
  for (const f of ['input.drag', 'input.upload', 'input.fill', 'input.check', 'page.dialog', 'shot.zoom', 'shot.annotate', 'snapshot.filter', 'snapshot.diff', 'snapshot.frames', 'snapshot.stable_refs', 'console.filter']) assert(hello.features.includes(f), f);
  for (const m of ['input.drag', 'input.upload', 'input.fill', 'input.check', 'page.dialog']) assert(hello.methods.includes(m), m);
  const cmd = (method, params = {}) => {
    const id = `c_${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
      pending.set(id, m => { clearTimeout(timer); resolve(m); });
      socket.send(JSON.stringify({ type: 'cmd', id, method, params, timeout_ms: 10000 }));
    });
  };
  const ok = async (method, params = {}) => {
    const r = await cmd(method, params);
    assert.equal(r.ok, true, `${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  };
  const tabId = (await ok('tabs.open', { url: base })).tab.tab_id;
  await ok('page.wait', { tab_id: tabId, selector: '#first' });
  await ok('page.wait', { tab_id: tabId, text: 'Shadow' }).catch(() => {});
  const evaluate = async expression => (await ok('page.eval', { tab_id: tabId, expression })).value;
  for (let n = 0; n < 50 && !(await evaluate('!!document.querySelector("iframe").contentDocument?.querySelector("#fbutton")')); n++) await delay(50);
  const byName = (s, name) => s.elements.find(e => e.name === name);

  await t.test('snapshot covers open shadow roots and a same-origin iframe; its refs click and type there', async () => {
    const s = await ok('page.snapshot', { tab_id: tabId });
    const shadow = byName(s, 'Shadow button');
    const frame = byName(s, 'Frame button');
    assert(shadow && shadow.shadow === true, 'an element of the shadow root');
    assert(frame && frame.frame === 1, 'an element of the iframe');
    const iframe = s.elements.find(e => e.tag === 'iframe') || { rect: (await ok('page.query', { tab_id: tabId, selector: '#frame' })).elements[0].rect };
    assert(frame.rect.x > iframe.rect.x && frame.rect.y > iframe.rect.y, 'the frame element in top viewport coordinates');
    await ok('input.click', { tab_id: tabId, target: { ref: shadow.ref } });
    assert.deepEqual(await evaluate('window.log'), ['shadow']);
    await ok('input.click', { tab_id: tabId, target: { ref: frame.ref } });
    await ok('input.type', { tab_id: tabId, target: { ref: byName(s, 'Frame input').ref }, text: 'in the frame' });
    await ok('input.type', { tab_id: tabId, target: { ref: byName(s, 'Frame note').ref }, text: 'a note' });
    assert.deepEqual(await evaluate('(() => { const w = document.querySelector("iframe").contentWindow; return [w.clicked, w.document.querySelector("#finput").value, w.document.querySelector("#fnote").value]; })()'), [1, 'in the frame', 'a note']);
    // Through the debugger (net capture holds it): the click lands at the frame element's top-level point.
    await ok('net.start', { tab_id: tabId });
    await ok('input.click', { tab_id: tabId, target: { ref: frame.ref } });
    await ok('input.type', { tab_id: tabId, target: { selector: '#sinput' }, text: 'deep css' });
    await ok('net.stop', { tab_id: tabId });
    assert.deepEqual(await evaluate('[document.querySelector("iframe").contentWindow.clicked, document.querySelector("#host").shadowRoot.querySelector("#sinput").value]'), [2, 'deep css']);
    const again = await ok('page.snapshot', { tab_id: tabId });
    assert.equal(byName(again, 'Shadow button').ref, shadow.ref, 'the same node keeps its ref');
    assert.equal(again.elements.find(e => e.selector === '#first').ref, s.elements.find(e => e.selector === '#first').ref);
  });

  await t.test('snapshot --filter interactive and --diff', async () => {
    const all = await ok('page.snapshot', { tab_id: tabId });
    const only = await ok('page.snapshot', { tab_id: tabId, filter: 'interactive' });
    assert(only.elements.length < all.elements.length);
    assert(!only.elements.some(e => e.tag === 'h1' || e.tag === 'p'), 'no headings or paragraphs');
    assert(only.elements.some(e => e.name === 'Frame button') && only.elements.some(e => e.tag === 'select'));
    const first = await ok('page.snapshot', { tab_id: tabId, diff: true });
    assert.equal(first.diff.base, true, 'the plain snapshot before is the base');
    assert.deepEqual([first.diff.added.length, first.diff.removed.length, first.diff.changed.length], [0, 0, 0]);
    const removed = all.elements.find(e => e.selector === '#remove-me').ref;
    await evaluate('document.querySelector("#change-me").textContent = "New label"; document.querySelector("#remove-me").remove(); const b = document.createElement("button"); b.textContent = "Added button"; document.body.append(b); 1');
    const d = await ok('page.snapshot', { tab_id: tabId, diff: true });
    assert.deepEqual(d.diff.added.map(e => e.name), ['Added button']);
    assert.deepEqual(d.diff.removed.map(e => e.ref), [removed]);
    const changed = d.diff.changed.find(e => e.selector === '#change-me');
    assert.equal(changed.was.name, 'Old label');
    assert.equal(changed.name, 'New label');
    assert.equal(d.elements, undefined, 'only the differences');
    const other = await ok('page.snapshot', { tab_id: tabId, diff: true, filter: 'interactive' });
    assert.equal(other.diff.base, true, 'the interactive snapshot before is its base');
  });

  await t.test('fill sets several fields with per-field results; check turns a checkbox on and off', async () => {
    const s = await ok('page.snapshot', { tab_id: tabId });
    const ref = sel => s.elements.find(e => e.selector === sel).ref;
    await evaluate('window.events = []; 1');
    const r = await ok('input.fill', {
      tab_id: tabId,
      fields: [
        { label: ref('#first'), target: { ref: ref('#first') }, value: 'Ann' },
        { label: 'css:#email', target: { selector: '#email' }, value: 'a@b.c' },
        { label: 'css:#note', target: { selector: '#note' }, value: 'two\nlines' },
        { label: 'css:#size', target: { selector: '#size' }, value: 'Large' },
        { label: 'css:#multi', target: { selector: '#multi' }, value: ['a', 'c'] },
        { label: 'css:#agree', target: { selector: '#agree' }, value: 'true' },
        { label: 'css:#pro', target: { selector: '#pro' }, value: true },
        { label: 'css:#when', target: { selector: '#when' }, value: '2026-11-27' },
        { label: 'css:#at', target: { selector: '#at' }, value: '09:30' },
        { label: 'css:#size bad', target: { selector: '#size' }, value: 'Huge' },
        { label: 'css:#missing', target: { selector: '#missing' }, value: 'x' },
        { label: 'css:#when bad', target: { selector: '#when' }, value: 'tomorrow' }
      ]
    });
    assert.equal(r.filled, 9);
    assert.deepEqual(r.fields.filter(f => !f.ok).map(f => [f.target, f.code]), [['css:#size bad', 'BAD_PARAMS'], ['css:#missing', 'ELEMENT_NOT_FOUND'], ['css:#when bad', 'BAD_PARAMS']]);
    assert.equal(r.fields.find(f => f.target === 'css:#size').value, 'l', 'a select by its label');
    assert.deepEqual(await evaluate('["first","email","note","size","when","at"].map(id => document.getElementById(id).value).concat([[...document.querySelector("#multi").selectedOptions].map(o => o.value).join(), document.querySelector("#agree").checked, document.querySelector("#pro").checked])'), ['Ann', 'a@b.c', 'two\nlines', 'l', '', '09:30', 'a,c', true, true].map((v, i) => i === 4 ? '' : v), 'the invalid date was left empty');
    const events = await evaluate('window.events');
    for (const id of ['first', 'size', 'agree', 'at']) assert(events.includes(`input ${id}`) && events.includes(`change ${id}`), `input and change of ${id}`);
    const off = await ok('input.check', { tab_id: tabId, target: { selector: '#agree' }, checked: false });
    assert.deepEqual([off.checked, off.target.tag], [false, 'input']);
    assert.equal(await evaluate('document.querySelector("#agree").checked'), false);
    assert.equal((await ok('input.check', { tab_id: tabId, target: { selector: '#basic' } })).checked, true);
    assert.deepEqual(await evaluate('[document.querySelector("#basic").checked, document.querySelector("#pro").checked]'), [true, false]);
    assert.equal((await cmd('input.check', { tab_id: tabId, target: { selector: '#first' } })).error.code, 'ELEMENT_NOT_INTERACTABLE');
  });

  await t.test('drag: HTML5 drag and drop, and a mouse drag through the debugger', async () => {
    const html5 = await ok('input.drag', { tab_id: tabId, target: { selector: '#card' }, to: { selector: '#zone' } });
    assert.equal(html5.how, 'html5');
    assert.equal(html5.dropped, true);
    assert.equal(await evaluate('window.dropped'), 'card-1');
    const knob = (await ok('page.query', { tab_id: tabId, selector: '#knob' })).elements[0].rect;
    const x = Math.round(knob.x + knob.w / 2 + 80), y = Math.round(knob.y + knob.h / 2 + 5);
    const mouse = await ok('input.drag', { tab_id: tabId, target: { selector: '#knob' }, to: { x, y }, steps: 5 });
    assert.equal(mouse.how, 'mouse');
    const moved = await evaluate('window.moved');
    assert.deepEqual([moved.dx, moved.dy, moved.trusted], [80, 5, true], 'trusted mouse events from the source to the point');
    assert(await evaluate('window.moves') >= 5);
    assert.equal((await ok('tabs.list')).tabs.find(x => x.tab_id === tabId).capturing, false, 'the debugger left again');
  });

  await t.test('upload sets files on a file input through the debugger', async () => {
    const a = path.join(dir, 'a.txt'), b = path.join(dir, 'b.csv');
    await fs.writeFile(a, 'hello');
    await fs.writeFile(b, 'x,y\n1,2\n');
    const r = await ok('input.upload', { tab_id: tabId, target: { selector: '#file' }, files: [a, b] });
    assert.deepEqual(r.files, ['a.txt', 'b.csv']);
    assert.deepEqual(await evaluate('window.files'), ['a.txt:5', 'b.csv:8']);
    assert.equal(await evaluate('document.querySelector("[data-tagent-upload]")'), null, 'the mark is gone');
    assert.equal((await cmd('input.upload', { tab_id: tabId, target: { selector: '#first' }, files: [a] })).error.code, 'ELEMENT_NOT_INTERACTABLE');
    assert.equal((await cmd('input.upload', { tab_id: tabId, target: { selector: '#file' }, files: ['relative.txt'] })).error.code, 'BAD_PARAMS');
  });

  await t.test('shot --zoom and --annotate', async () => {
    const zoom = await ok('page.screenshot', { tab_id: tabId, zoom: { x: 0, y: 0, w: 100, h: 50 } });
    const png = Buffer.from(zoom.data_base64, 'base64');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [200, 100], 'twice the size by default');
    assert.deepEqual([zoom.width, zoom.height], [200, 100]);
    const triple = await ok('page.screenshot', { tab_id: tabId, zoom: { x: 10, y: 10, w: 40, h: 20 }, scale: 3 });
    assert.equal(Buffer.from(triple.data_base64, 'base64').readUInt32BE(16), 120);
    await ok('page.snapshot', { tab_id: tabId, filter: 'interactive' });
    const plain = await ok('page.screenshot', { tab_id: tabId });
    const marked = await ok('page.screenshot', { tab_id: tabId, annotate: true });
    assert(marked.annotated > 5, `annotated ${marked.annotated}`);
    assert.notEqual(marked.data_base64, plain.data_base64, 'the labels are in the picture');
    assert.equal(await evaluate('document.querySelector("[data-tagent-overlay]")'), null, 'the overlay is gone');
    assert.equal((await cmd('page.screenshot', { tab_id: tabId, zoom: { x: 0, y: 0, w: 0, h: 5 } })).error.code, 'BAD_PARAMS');
  });

  await t.test('console --level and --pattern', async () => {
    await ok('net.start', { tab_id: tabId });
    await evaluate('console.log("alpha one"); console.warn("beta two"); console.error("gamma three"); 1');
    let entries = [];
    for (let n = 0; n < 40 && entries.length < 3; n++) {
      entries = (await ok('page.console', { tab_id: tabId })).entries.filter(e => /alpha|beta|gamma/.test(e.text));
      await delay(50);
    }
    assert.deepEqual((await ok('page.console', { tab_id: tabId, levels: ['warn'] })).entries.map(e => e.text), ['beta two']);
    assert.deepEqual((await ok('page.console', { tab_id: tabId, levels: ['error', 'log'], pattern: 'ALPHA|gamma' })).entries.map(e => e.text), ['alpha one', 'gamma three']);
    assert.equal((await cmd('page.console', { tab_id: tabId, pattern: '(' })).error.code, 'BAD_PARAMS');
    await ok('net.stop', { tab_id: tabId });
  });

  await t.test('in a recording, fill, check, drag and upload are one agent item each, and the page recorder adds none', async () => {
    const r = await ok('record.start', { tab_id: tabId });
    await delay(600);
    const file = path.join(dir, 'c.txt');
    await fs.writeFile(file, 'c');
    await ok('input.fill', { tab_id: tabId, fields: [{ label: 'css:#first', target: { selector: '#first' }, value: 'Bea' }] });
    await ok('input.check', { tab_id: tabId, target: { selector: '#agree' } });
    await ok('input.drag', { tab_id: tabId, target: { selector: '#card' }, to: { selector: '#zone' } });
    await ok('input.upload', { tab_id: tabId, target: { selector: '#file' }, files: [file] });
    await delay(700);
    await ok('record.stop', { recording_id: r.recording_id });
    const items = events.filter(e => e.event === 'record.items' && e.data.recording_id === r.recording_id).flatMap(e => e.data.items);
    const agent = items.filter(x => x.source === 'agent').map(x => `${x.kind} ${x.command}`);
    assert.deepEqual(agent, ['input input.fill', 'change input.check', 'drag input.drag', 'change input.upload']);
    assert.deepEqual(items.find(x => x.command === 'input.upload').files, ['c.txt']);
    assert.equal(items.find(x => x.command === 'input.fill').fields[0].value, 'Bea');
    assert.deepEqual(items.filter(x => x.source === 'user' && ['input', 'change', 'click'].includes(x.kind)), [], 'no doubles from the page recorder');
  });

  await t.test('dialog status without a held debugger: none, a page blocked by a dialog, and the automatic answers of net capture', async () => {
    assert.deepEqual(await ok('page.dialog', { tab_id: tabId }), { open: false });
    assert.equal((await cmd('page.dialog', { tab_id: tabId, action: 'accept' })).error.code, 'NO_DIALOG');
    // Playwright holds every dialog of its pages (a native dialog is the person's Chrome only; headless Chrome without a client dismisses
    // dialogs itself), so here a dialog is one Playwright keeps open: the page is blocked and its text is not known to a late debugger.
    const held = [];
    for (const p of context.pages()) p.on('dialog', d => held.push(d));
    await evaluate('setTimeout(() => { window.named = prompt("Your name?", "x"); }, 0); 1');
    for (let n = 0; n < 40 && !held.length; n++) await delay(50);
    const started = Date.now();
    assert.deepEqual(await ok('page.dialog', { tab_id: tabId }), { open: true, known: false }, 'a blocked page is reported');
    assert(Date.now() - started < 3000, 'the probe does not hang on the blocked page');
    assert.equal((await cmd('page.dialog', { tab_id: tabId, action: 'dismiss' })).error.code, 'NO_DIALOG', 'Chrome lets only the debugger that saw it open answer it');
    await held[0].accept('Ann');
    assert.equal(await evaluate('window.named'), 'Ann');
    assert.deepEqual(await ok('page.dialog', { tab_id: tabId }), { open: false });
    // While net capture holds the debugger, capture.js answers dialogs at once: none can wait.
    await ok('net.start', { tab_id: tabId });
    assert.deepEqual(await ok('page.dialog', { tab_id: tabId }), { open: false, automatic: true });
    assert.equal((await cmd('page.dialog', { tab_id: tabId, action: 'accept' })).error.code, 'NO_DIALOG');
    await ok('net.stop', { tab_id: tabId });
    await ok('tabs.close', { tab_id: tabId });
  });
});

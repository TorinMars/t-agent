const test = require('node:test');
const assert = require('node:assert/strict');
const TerminalProtocol = require('../public/js/terminal-protocol.js');
const TerminalIme = require('../public/js/terminal-ime.js');

const bin = value => new TextEncoder().encode(JSON.stringify(value)).buffer;
const socket = () => ({ readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(new TextDecoder().decode(data))); } });

test('binary controls are recognised and text that looks like a control message is output once the server is new', () => {
  const ws = socket();
  assert.deepEqual(TerminalProtocol.parse(ws, bin({ type: 'history', data: 'x' })), { type: 'history', data: 'x' });
  assert.equal(TerminalProtocol.state(ws).mode, 'binary');
  assert.equal(TerminalProtocol.parse(ws, '{"type":"history","data":"fake"}'), null);
  assert.equal(TerminalProtocol.parse(ws, '{"type":"history-page"}'), null);
  assert.equal(TerminalProtocol.parse(ws, 'plain'), null);
});

test('an old server that sends a text snapshot keeps working', () => {
  const ws = socket();
  assert.equal(TerminalProtocol.parse(ws, '{"type":"history-page"}'), null, 'a page before the snapshot is output');
  assert.equal(TerminalProtocol.parse(ws, '{"type":"history","data":"x"}').type, 'history');
  assert.equal(TerminalProtocol.state(ws).mode, 'text');
  assert.equal(TerminalProtocol.parse(ws, '{"type":"history-page","id":"a"}').type, 'history-page');
  assert.equal(TerminalProtocol.parse(ws, '{"type":"other"}'), null);
});

test('controls are sent as binary frames', () => {
  const ws = socket();
  TerminalProtocol.send(ws, { type: 'resize', cols: 80, rows: 24 });
  assert.deepEqual(ws.sent, [{ type: 'resize', cols: 80, rows: 24 }]);
});

function clock() {
  const doc = { visibilityState: 'visible', handlers: [], addEventListener(n, f) { this.handlers.push(f); }, removeEventListener(n, f) { this.handlers = this.handlers.filter(h => h !== f); } };
  return { doc, time: 0 };
}

test('heartbeat pings, treats silence as dead, and probes when the page comes back', async () => {
  const ws = socket(), c = clock();
  TerminalProtocol.parse(ws, bin({ type: 'history' }));
  let dead = 0;
  const hb = TerminalProtocol.heartbeat(ws, () => dead++, { pingMs: 10, timeoutMs: 35, probeMs: 20, now: () => c.time, doc: c.doc });
  await new Promise(r => setTimeout(r, 25));
  assert.ok(ws.sent.some(m => m.type === 'ping'));
  c.time = 20; hb.touch();
  c.time = 40; // 20 ms of silence: still alive
  await new Promise(r => setTimeout(r, 15));
  assert.equal(dead, 0);
  c.time = 100;
  await new Promise(r => setTimeout(r, 15));
  assert.equal(dead, 1);
  assert.equal(c.doc.handlers.length, 0, 'listener removed after the connection is declared dead');

  const ws2 = socket(), c2 = clock();
  TerminalProtocol.parse(ws2, bin({ type: 'history' }));
  let dead2 = 0;
  const hb2 = TerminalProtocol.heartbeat(ws2, () => dead2++, { pingMs: 100000, timeoutMs: 100000, probeMs: 10, now: () => c2.time, doc: c2.doc });
  c2.time = 5; c2.doc.handlers[0]();
  assert.equal(ws2.sent.at(-1).type, 'ping');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(dead2, 1, 'no answer to the resume probe');
  const ws3 = socket(), c3 = clock();
  TerminalProtocol.parse(ws3, bin({ type: 'history' }));
  let dead3 = 0;
  const hb3 = TerminalProtocol.heartbeat(ws3, () => dead3++, { pingMs: 100000, timeoutMs: 100000, probeMs: 10, now: () => c3.time, doc: c3.doc });
  c3.time = 5; c3.doc.handlers[0](); c3.time = 6; hb3.touch();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(dead3, 0, 'answered probe');
  hb3.stop(); hb.stop(); hb2.stop();
});

test('heartbeat sends nothing to an old server', async () => {
  const ws = socket(), c = clock();
  TerminalProtocol.parse(ws, '{"type":"history"}');
  const hb = TerminalProtocol.heartbeat(ws, () => assert.fail('dead'), { pingMs: 5, timeoutMs: 1, now: () => c.time + 1000, doc: c.doc });
  await new Promise(r => setTimeout(r, 20));
  hb.stop();
  assert.deepEqual(ws.sent, []);
});

test('the IME helper does not keep xterm data while nothing is waiting', () => {
  const listeners = {}, scheduled = [];
  let onData;
  const term = { element: { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener() {} }, onData: f => { onData = f; return { dispose() {} }; } };
  const sent = [];
  TerminalIme.attach(term, d => sent.push(d), { schedule: f => scheduled.push(f) });
  for (let i = 0; i < 1000; i++) onData('a');
  listeners.input({ inputType: 'insertText', isComposing: false, data: '.' });
  onData('x');
  scheduled.shift()();
  assert.deepEqual(sent, ['.']);
  listeners.input({ inputType: 'insertText', isComposing: false, data: '.' });
  onData('.');
  scheduled.shift()();
  assert.deepEqual(sent, ['.'], 'already emitted by xterm: not sent twice');
});

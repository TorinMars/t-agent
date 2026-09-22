const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
function setup() {
  const { document, Event } = parseHTML('<button id="btn-terminal-history"></button>');
  const frames = [], timers = new Map(); let timerId = 0;
  const context = { document, WebSocket: { OPEN: 1 }, requestAnimationFrame: fn => frames.push(fn),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    TerminalViewport: { restore: (term, value) => { term.restored = value; } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/terminal-history.js'), 'utf8') + '\nthis.History = TerminalHistory;', context);
  function instance() {
    const writes = [], callbacks = [], sent = [];
    const inst = { term: {}, paused: false, ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      clipboard: { writeHistory: (data, done) => { writes.push(data); callbacks.push(done); } } };
    inst.history = context.History.attach(inst); inst.history.bind(inst.ws);
    return { inst, writes, callbacks, sent };
  }
  return { document, Event, frames, timers, History: context.History, instance,
    click: id => document.getElementById(id).dispatchEvent(new Event('click')) };
}
function initial(item, archive = { id: 'snapshot', before: 99, hasMore: true, limit: 500 }) {
  return item.inst.history.handle(JSON.stringify({ type: 'history', data: 'ANSI', archive }), item.inst.ws);
}
test('history replay pauses input through parser completion and paging is explicit plain text', () => {
  const app = setup(), item = app.instance(); app.History.activate(item.inst);
  assert.ok(initial(item)); assert.equal(item.inst.paused, true); assert.deepEqual(item.writes, ['ANSI']);
  assert.equal(item.sent.length, 0);
  item.callbacks[0](); while (app.frames.length) app.frames.shift()(); assert.equal(item.inst.paused, false);
  app.click('btn-terminal-history'); assert.equal(item.sent.length, 1);
  const request = item.sent[0]; assert.equal(request.before, 99); assert.equal(request.type, 'history-page');
  item.inst.history.handle(JSON.stringify({ ...request, before: 40, hasMore: true, data: '<img src=x>recent\n' }), item.inst.ws);
  assert.equal(app.document.getElementById('terminal-history-text').textContent, '<img src=x>recent\n');
  assert.equal(app.document.querySelector('img'), null); assert.deepEqual(item.writes, ['ANSI']);
  app.click('terminal-history-earlier'); assert.equal(item.sent[1].before, 40);
  item.inst.history.handle(JSON.stringify({ ...item.sent[1], before: 0, hasMore: false, data: 'older\n' }), item.inst.ws);
  assert.equal(app.document.getElementById('terminal-history-text').textContent, 'older\n<img src=x>recent\n');
  assert.equal(app.document.getElementById('terminal-history-earlier').disabled, true);
});
test('switching terminals cancels pending pages and rejects stale sockets and replay callbacks', () => {
  const app = setup(), first = app.instance(), next = app.instance(); app.History.activate(first.inst); initial(first);
  app.click('btn-terminal-history'); const request = first.sent[0];
  app.History.activate(next.inst); initial(next);
  first.inst.history.handle(JSON.stringify({ ...request, before: 0, hasMore: false, data: 'wrong terminal' }), first.inst.ws);
  assert.equal(app.document.getElementById('terminal-history-text'), null);
  const oldSocket = first.inst.ws; first.inst.ws = { readyState: 1, send() {} }; first.inst.history.bind(first.inst.ws); initial(first);
  first.callbacks[0](); while (app.frames.length) app.frames.shift()();
  assert.equal(first.inst.paused, true, 'old replay must not unpause a new connection');
  assert.ok(first.inst.history.handle(JSON.stringify({ type: 'history', data: 'stale' }), oldSocket));
  assert.deepEqual(first.writes, ['ANSI', 'ANSI']);
});
test('legacy, timeout, error and disconnect states do not request or render unwanted pages', () => {
  const app = setup(), item = app.instance(); app.History.activate(item.inst); initial(item, undefined);
  // Explicitly omit archive for a legacy Engine.
  item.inst.history.handle(JSON.stringify({ type: 'history', data: '' }), item.inst.ws);
  app.click('btn-terminal-history'); assert.equal(item.sent.length, 0);
  assert.match(app.document.getElementById('btn-terminal-history').title, /升级/);
  initial(item); app.click('btn-terminal-history'); const request = item.sent[0];
  for (const fn of [...app.timers.values()]) fn();
  assert.match(app.document.getElementById('terminal-history-status').textContent, /超时/);
  item.inst.history.handle(JSON.stringify({ ...request, data: 'late', before: 0, hasMore: false }), item.inst.ws);
  assert.equal(app.document.getElementById('terminal-history-text').textContent, '');
  app.click('terminal-history-earlier');
  item.inst.history.handle(JSON.stringify({ ...item.sent[1], error: 'STALE_HISTORY' }), item.inst.ws);
  assert.match(app.document.getElementById('terminal-history-status').textContent, /失败/);
  item.inst.history.disconnect(item.inst.ws);
  assert.equal(app.document.getElementById('btn-terminal-history').disabled, true);
  assert.match(app.document.getElementById('terminal-history-status').textContent, /断开/);
});
test('closing and reopening restarts snapshot and timeout retry keeps the same cursor', () => {
  const app = setup(), item = app.instance(); app.History.activate(item.inst); initial(item);
  app.click('btn-terminal-history'); const first = item.sent[0];
  item.inst.history.handle(JSON.stringify({ ...first, before: 40, hasMore: true, data: 'recent' }), item.inst.ws);
  app.click('terminal-history-close'); app.click('btn-terminal-history');
  assert.equal(item.sent[1].before, 99);
  for (const fn of [...app.timers.values()]) fn();
  app.click('terminal-history-earlier'); assert.equal(item.sent[2].before, 99);
  assert.notEqual(item.sent[2].requestId, item.sent[1].requestId);
  item.inst.history.handle(JSON.stringify({ ...item.sent[2], before: 0, hasMore: false, data: 'retry success' }), item.inst.ws);
  assert.equal(app.document.getElementById('terminal-history-text').textContent, 'retry success');
});

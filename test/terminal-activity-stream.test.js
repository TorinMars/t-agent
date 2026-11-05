// The pushed terminal activity (lib/terminal-activity-stream.js): a snapshot on connect, a new one on every change, only the owner's tasks,
// one shared sub-agent refresh for all streams, and a heartbeat comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createActivityStream } = require('../lib/terminal-activity-stream');

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeStream() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.headers = {};
  res.chunks = [];
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.flushHeaders = () => {};
  res.write = chunk => { res.chunks.push(chunk); return true; };
  // The `event: activity` messages as parsed objects.
  res.events = () => res.chunks.filter(chunk => chunk.startsWith('event: activity\n')).map(chunk => JSON.parse(chunk.split('\n')[1].slice(6)));
  return { req, res };
}

test('a stream gets the snapshot of its own tasks on connect and again after each change', async () => {
  let activity = { 1: { default: 'running' }, 2: { other: 'done' } };
  const hub = createActivityStream({ activity: ids => Object.fromEntries(ids.filter(id => activity[id]).map(id => [id, activity[id]])), subagents: () => ({}), debounceMs: 5 });
  const { req, res } = fakeStream();
  hub.serve(req, res, () => [1]);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.deepEqual(res.events(), [{ activity: { 1: { default: 'running' } }, subagents: {} }], 'task 2 belongs to someone else');

  activity = { 1: { default: 'done' }, 2: { other: 'done' } };
  hub.notify();
  hub.notify(); // a burst is one message
  await tick(30);
  assert.deepEqual(res.events().at(-1), { activity: { 1: { default: 'done' } }, subagents: {} });
  assert.equal(res.events().length, 2);

  // Nothing changed for this stream (only another owner's task did): no message.
  activity = { 1: { default: 'done' }, 2: {} };
  hub.notify();
  await tick(30);
  assert.equal(res.events().length, 2);

  activity = {};
  hub.notify();
  await tick(30);
  assert.deepEqual(res.events().at(-1), { activity: {}, subagents: {} }, 'acknowledged: idle terminals are left out');

  req.emit('close');
  assert.equal(hub.size(), 0);
});

test('sub-agent counts are read once per refresh for every stream, and only changes are sent', async () => {
  let reads = 0;
  let subagents = { 1: { c1: 2 }, 2: { c2: 1 } };
  const hub = createActivityStream({ activity: () => ({}), subagents: () => { reads += 1; return subagents; }, subagentMs: 20, debounceMs: 1 });
  const a = fakeStream();
  const b = fakeStream();
  hub.serve(a.req, a.res, () => [1]);
  hub.serve(b.req, b.res, () => [2]);
  assert.deepEqual(a.res.events()[0].subagents, { 1: { c1: 2 } }, 'the first snapshot already has the counts');
  assert.deepEqual(b.res.events()[0].subagents, { 2: { c2: 1 } });
  await tick(70);
  const readsWithTwo = reads;
  assert.ok(readsWithTwo >= 2 && readsWithTwo <= 6, `one shared timer, not one per stream (${readsWithTwo} reads)`);
  assert.equal(a.res.events().length, 1, 'no change: nothing sent');

  subagents = { 2: { c2: 1 } }; // terminals without running sub-agents are left out
  await tick(60);
  assert.deepEqual(a.res.events().at(-1).subagents, {}, 'the sub-agent finished');
  assert.equal(b.res.events().length, 1, 'the other stream saw no change');

  a.req.emit('close');
  b.req.emit('close');
  const stopped = reads;
  await tick(60);
  assert.equal(reads, stopped, 'no stream: the sub-agent timer stops');
});

test('a heartbeat comment keeps an idle stream open', async () => {
  const hub = createActivityStream({ activity: () => ({}), subagents: () => ({}), heartbeatMs: 15 });
  const { req, res } = fakeStream();
  hub.serve(req, res, () => []);
  await tick(50);
  assert.ok(res.chunks.filter(chunk => chunk === ': ping\n\n').length >= 2);
  assert.ok(res.chunks.includes('retry: 5000\n\n'));
  req.emit('close');
});

test('the tracker change callback, a closed session and an ack reach the stream (routes/terminal.js wiring)', () => {
  const source = require('node:fs').readFileSync(require.resolve('../routes/terminal.js'), 'utf8');
  assert.match(source, /createActivityTracker\(pty, shell, \(\) => activityStream\.notify\(\)\)/);
  assert.equal((source.match(/activityStream\.notify\(\)/g) || []).length, 3, 'tracker changes, natural exit and close / restart / delete');
});

test('the agent chat counters of the owner travel in the same snapshot and are pushed when a turn or a queue changes', async () => {
  const counts = { alice: { running: 0, queued: 0, submitted: 0 }, bob: { running: 1, queued: 0, submitted: 1 } };
  let watched = 0;
  let changed = null;
  const hub = createActivityStream({
    activity: () => ({}), subagents: () => ({}), debounceMs: 1,
    agents: owner => counts[owner], watchAgents: listener => { watched += 1; changed = listener; },
  });
  const a = fakeStream();
  const b = fakeStream();
  const old = fakeStream();
  hub.serve(a.req, a.res, () => [], 'alice');
  hub.serve(b.req, b.res, () => [], 'bob');
  hub.serve(old.req, old.res, () => []); // no owner: no counters (as before)
  assert.equal(watched, 1, 'subscribed once');
  assert.deepEqual(a.res.events(), [{ activity: {}, subagents: {}, agents: { running: 0, queued: 0, submitted: 0 } }]);
  assert.deepEqual(b.res.events()[0].agents, { running: 1, queued: 0, submitted: 1 });
  assert.equal('agents' in old.res.events()[0], false);

  counts.alice = { running: 1, queued: 2, submitted: 3 };
  changed();
  await tick(20);
  assert.deepEqual(a.res.events().at(-1).agents, { running: 1, queued: 2, submitted: 3 }, 'pushed without a request');
  assert.equal(b.res.events().length, 1, 'bob saw no change');
  assert.equal(old.res.events().length, 1);
  for (const s of [a, b, old]) s.req.emit('close');
});

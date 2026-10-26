const test = require('node:test');
const assert = require('node:assert/strict');
const AgentActivity = require('../public/js/agent-activity.js');

// A container with the two counters, as in the pages.
function fakeElement() {
  const part = () => { const classes = new Set(); return { count: { textContent: '' }, label: { textContent: '' }, classes, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }, querySelector(selector) { return selector === '.count' ? this.count : this.label; } }; };
  const parts = { submitted: part(), running: part() };
  return { hidden: true, parts, querySelector: selector => parts[selector.replace('.agent-activity-', '')] || null };
}
function fakeDocument() {
  const listeners = {};
  return { hidden: false, listeners, addEventListener: (name, fn) => { listeners[name] = fn; } };
}
const answer = body => ({ ok: true, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the counters are whole numbers, never negative or missing', () => {
  assert.deepEqual(AgentActivity.counters({ submitted: 3, running: 1 }).map(item => [item.key, item.count]), [['submitted', 3], ['running', 1]]);
  assert.deepEqual(AgentActivity.counters({ submitted: -2, running: 'x' }).map(item => item.count), [0, 0]);
  assert.deepEqual(AgentActivity.counters(null).map(item => item.count), [0, 0]);
  assert.deepEqual(AgentActivity.counters({ submitted: 2.9 }).map(item => item.count), [2, 0]);
});

test('the numbers appear after the first answer, follow the next ones, and a failure leaves them as they were', async () => {
  const element = fakeElement();
  const documentImpl = fakeDocument();
  const calls = [];
  let reply = answer({ submitted: 4, running: 2 });
  const timers = [];
  const activity = AgentActivity.attach(element, {
    documentImpl, fetchImpl: async (url, options) => { calls.push([url, options.headers['X-Requested-With']]); return reply; },
    setIntervalImpl: fn => { timers.push(fn); return timers.length; }, clearIntervalImpl: () => { timers.length = 0; },
  });
  assert.equal(element.hidden, true, 'hidden until there is something to show');
  await tick();
  assert.equal(element.hidden, false);
  assert.deepEqual([element.parts.submitted.count.textContent, element.parts.running.count.textContent], ['4', '2']);
  assert.deepEqual([element.parts.submitted.label.textContent, element.parts.running.label.textContent], ['submitted', 'running']);
  assert.deepEqual(calls[0], ['/api/agent-chat/summary', 'XMLHttpRequest']);

  reply = answer({ submitted: 0, running: 0 });
  timers[0](); // the timer fires
  await tick();
  assert.equal(element.parts.running.count.textContent, '0');
  assert.equal(element.parts.running.classes.has('idle'), true, 'a zero is shown quietly');

  reply = { ok: false, json: async () => ({}) };
  timers[0]();
  await tick();
  assert.equal(element.parts.submitted.count.textContent, '0');
  reply = answer({ submitted: 1, running: 1 });
  documentImpl.hidden = true;
  const before = calls.length;
  timers[0]();
  await tick();
  assert.equal(calls.length, before, 'nothing is asked while the page is hidden');
  documentImpl.hidden = false;
  documentImpl.listeners.visibilitychange();
  await tick();
  assert.equal(element.parts.submitted.count.textContent, '1', 'it refreshes at once when the page is shown again');
  activity.stop();
  assert.equal(timers.length, 0, 'the timer is cleared');
});

test('an older answer that arrives late does not replace a newer one', async () => {
  const element = fakeElement();
  const resolvers = [];
  const activity = AgentActivity.attach(element, {
    documentImpl: fakeDocument(), setIntervalImpl: () => 1, clearIntervalImpl() {},
    fetchImpl: () => new Promise(resolve => resolvers.push(resolve)),
  });
  void activity.refresh(); // a second request while the first one is still open
  resolvers[1](answer({ submitted: 9, running: 9 }));
  await tick();
  resolvers[0](answer({ submitted: 1, running: 1 }));
  await tick();
  assert.equal(element.parts.submitted.count.textContent, '9');
});

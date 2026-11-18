// The page store of the phone page (scripts/h5-shell/store.mjs): `set` tells the listeners only when a value changed, `share` keeps the parts that did not.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/store.mjs');

test('set notifies only when some key gets another value', async () => {
  const { createStore } = await load();
  const list = { tasks: [] };
  const ui = createStore({ a: 1, list, gone: null });
  let calls = 0;
  ui.subscribe(() => { calls += 1; });
  const first = ui.get();
  ui.set({ a: 1 });
  ui.set({ list });
  ui.set({ a: 1, gone: null });
  ui.set(state => ({ a: state.a }));
  ui.set({});
  ui.set(() => null);
  ui.set(() => undefined);
  assert.equal(calls, 0, 'nothing changed: no listener is called');
  assert.equal(ui.get(), first, 'and the state keeps its identity');
  ui.set({ a: 2 });
  assert.equal(calls, 1);
  assert.notEqual(ui.get(), first);
  assert.equal(ui.get().list, list, 'the other keys keep their values');
  ui.set({ list: { tasks: [] } }); // an equal but new object is a change: the store compares one level only
  assert.equal(calls, 2);
  ui.set({ added: 'x' });
  assert.equal(calls, 3);
  ui.set({ nothing: undefined }); // a missing key set to undefined reads the same
  assert.equal(calls, 3);
  ui.set({ a: NaN });
  ui.set({ a: NaN });
  assert.equal(calls, 4, 'NaN equals NaN (Object.is)');
});

test('set still takes a function of the state and merges the patch', async () => {
  const { createStore } = await load();
  const ui = createStore({ count: 1, other: 'x' });
  ui.set(state => ({ count: state.count + 1 }));
  assert.deepEqual(ui.get(), { count: 2, other: 'x' });
  const off = ui.subscribe(() => assert.fail('unsubscribed'));
  off();
  ui.set({ count: 3 });
  assert.equal(ui.get().count, 3);
});

test('share keeps every part that did not change, and the whole when nothing did', async () => {
  const { createStore, sharePlain } = await load();
  assert.equal(createStore({}).share, sharePlain);
  const device = () => ({ key: 'local', local: true, label: 'This machine', name: '', instanceId: 'i1', offline: false });
  const row = (id, extra = {}) => ({ id, ref: `local:${id}`, title: `T${id}`, running: 0, device: device(), sessions: { label: `T${id}`, rows: [{ kind: 'terminal', id: 'a' }] }, ...extra });
  const before = { note: null, tasks: [row(1), row(2), row(3)], sortable: true };
  const same = sharePlain(before, { note: null, tasks: [row(1), row(2), row(3)], sortable: true });
  assert.equal(same, before, 'an equal list is the very same object');

  const next = sharePlain(before, { note: null, tasks: [row(1), row(2, { running: 1 }), row(3)], sortable: true });
  assert.notEqual(next, before);
  assert.notEqual(next.tasks, before.tasks);
  assert.equal(next.tasks[0], before.tasks[0], 'an unchanged row keeps its object');
  assert.equal(next.tasks[2], before.tasks[2]);
  assert.notEqual(next.tasks[1], before.tasks[1], 'the changed row is new');
  assert.equal(next.tasks[1].running, 1);
  assert.equal(next.tasks[1].device, before.tasks[1].device, 'and keeps the parts of it that did not change');
  assert.equal(next.tasks[1].sessions, before.tasks[1].sessions);

  const shorter = sharePlain(before, { note: null, tasks: [row(1), row(2)], sortable: true });
  assert.equal(shorter.tasks.length, 2);
  assert.equal(shorter.tasks[1], before.tasks[1]);
  const moved = sharePlain(before, { note: null, tasks: [row(2), row(1), row(3)], sortable: true });
  assert.deepEqual(moved.tasks.map(item => item.id), [2, 1, 3], 'a new order is a new list');

  // A key that came or went is a change, even with an undefined value.
  const swapped = sharePlain({ a: 1, b: undefined }, { a: 1, c: undefined });
  assert.deepEqual(Object.keys(swapped), ['a', 'c']);
  // Only plain data is compared deeply: a function, a node or a class instance by identity.
  const fn = () => {};
  assert.equal(sharePlain({ f: fn }, { f: fn }).f, fn);
  class Box { constructor(v) { this.v = v; } }
  const box = new Box(1);
  const other = new Box(1);
  assert.equal(sharePlain({ x: box }, { x: other }).x, other);
  assert.equal(sharePlain([1, 2], { 0: 1, 1: 2 }).length, undefined, 'an array and an object are not mixed');
  assert.equal(sharePlain(null, { a: 1 }).a, 1);
});

test('shallowEqual compares one level with Object.is', async () => {
  const { shallowEqual } = await load();
  const inner = { x: 1 };
  assert.equal(shallowEqual({ a: 1, inner }, { a: 1, inner }), true);
  assert.equal(shallowEqual({ a: 1, inner }, { a: 1, inner: { x: 1 } }), false);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(shallowEqual({ a: undefined }, { b: undefined }), false);
  assert.equal(shallowEqual(null, null), true);
  assert.equal(shallowEqual(null, {}), false);
});

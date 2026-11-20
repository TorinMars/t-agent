// Remove from Recent and Clear list ("Remove from Recent and Clear list" in docs/design/shared-page-state.md): the merge rules of a removal (a
// tombstone) and of a clear (the clear mark), each with Undo, over a fake clock. Only the Recent list changes: drafts and other keys stay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-recent-remove-'));
const merge = require('../services/page-state-merge');

const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const BASE = Date.UTC(2026, 10, 20, 8, 0, 0); // the fake clock starts here
const DAY = 24 * 60 * 60 * 1000;

// One engine's stored state and its page changes, stamped by a fake clock (as services/page-state.js `change` does).
function engine(by, clock) {
  let state = { recent: {}, keys: {} };
  return {
    get state() { return state; },
    set state(next) { state = next; },
    change(body) { state = merge.merge(state, merge.changeState(body, { at: clock.next(), by }), clock.now).state; return merge.pageView(state); },
    absorb(other) { const result = merge.merge(state, other, clock.now); state = result.state; return result.changed; },
    view: () => merge.pageView(state),
  };
}
function fakeClock() {
  const clock = { now: BASE, next() { clock.now += 1000; return clock.now; } };
  return clock;
}
const entry = (instance, task, terminal, used, extra = {}) => ({ instance, task: String(task), terminal, title: `S${task}`, agent: null, used, ...extra });
const ids = view => view.recent.map(item => `${item.instance === T ? 'T' : 'K'}|${item.task}|${item.terminal}`);
const usedOf = view => view.recent.map(item => item.used);

test('remove from Recent: a tombstone of that entry only; Undo notes it again with its time, so the order and "when" come back', () => {
  const clock = fakeClock();
  const a = engine(T, clock);
  const draft = merge.draftKey(`${T}|2|b`);
  a.change({
    recent: [entry(T, 1, 'a', BASE - 3000), entry(T, 2, 'b', BASE - 2000, { client: 'phone', device: 'abcdefgh1' }), entry(K, 3, 'c', BASE - 1000)],
    keys: { [draft]: { instance: T, task: '2', terminal: 'b', text: 'half a sentence' } },
  });
  const before = a.view();
  assert.deepEqual(ids(before), ['K|3|c', 'T|2|b', 'T|1|a']);
  const removed = before.recent[1];
  a.change({ recent: [{ instance: T, task: '2', terminal: 'b', gone: true }] });
  assert.deepEqual(ids(a.view()), ['K|3|c', 'T|1|a'], 'only that entry left the list');
  assert.ok(a.view().keys[draft], 'the session\'s draft stays');
  a.change({ recent: [removed] }); // Undo
  const back = a.view();
  assert.deepEqual(back.recent, before.recent, 'the same entries, order, times and where they were seen');
  // Showing it again (a newer time) also brings it back, on top.
  a.change({ recent: [{ instance: T, task: '2', terminal: 'b', gone: true }] });
  a.change({ recent: [entry(T, 2, 'b', clock.now + 1)] });
  assert.equal(ids(a.view())[0], 'T|2|b');
});

test('clear: every entry older than the clear goes, the current one sent with it stays; drafts and keys stay; the mark is kept', () => {
  const clock = fakeClock();
  const a = engine(T, clock);
  const draft = merge.draftKey(`${K}|3|c`);
  a.change({ recent: [entry(T, 1, 'a', BASE - 3000), entry(T, 2, 'b', BASE - 2000), entry(K, 3, 'c', BASE - 1000)], keys: { [draft]: { text: 'x' }, 'h5-task-list-tab': 'recent' } });
  const current = a.view().recent.find(item => item.terminal === 'a');
  a.change({ clear: true, recent: [current] });
  const view = a.view();
  assert.deepEqual(ids(view), ['T|1|a'], 'only the current session is left');
  assert.equal(view.recent[0].used, BASE - 3000, 'with its time');
  assert.ok(view.keys[draft] && view.keys['h5-task-list-tab'] === 'recent', 'drafts and other keys are not touched');
  assert.ok(a.state.cleared && a.state.cleared.by === T, 'the clear mark is stored');
  assert.equal(a.state.recent[`${K}|3|c`].gone, true, 'the others are tombstones too (for an engine that does not know the mark)');
  // A long time later the tombstones are gone, the mark is not.
  clock.now += 40 * DAY;
  const trimmed = merge.trim(a.state, clock.now);
  assert.ok(trimmed.cleared, 'the mark outlives the tombstones');
  assert.equal(trimmed.recent[`${K}|3|c`], undefined);
});

test('clear: another engine\'s older copy never brings the list back, also entries this side never had; a later note stays; the merge is the same both ways', () => {
  const clock = fakeClock();
  const a = engine(T, clock);
  const b = engine(K, clock);
  a.change({ recent: [entry(T, 1, 'a', BASE - 3000), entry(K, 3, 'c', BASE - 1000)] });
  b.absorb(a.state);
  // B has an entry A never saw (a task A may not see), noted before the clear.
  b.change({ recent: [entry(K, 9, 'hidden', BASE - 500)] });
  const bOld = b.state;
  a.change({ clear: true, recent: [] });
  assert.deepEqual(ids(a.view()), []);
  // The old copy of B arrives: nothing comes back on A, and B, merging A's state, is cleared too (its hidden entry included).
  a.absorb(bOld);
  assert.deepEqual(ids(a.view()), [], 'the older copy brings nothing back');
  b.absorb(a.state);
  assert.deepEqual(ids(b.view()), [], 'the other engine is cleared, its own entry included');
  // A session shown on B after the clear stays everywhere.
  b.change({ recent: [entry(K, 4, 'new', clock.now)] });
  a.absorb(b.state);
  assert.deepEqual(ids(a.view()), ['K|4|new']);
  // Commutative and idempotent.
  const ab = merge.merge(a.state, bOld, clock.now).state;
  const ba = merge.merge(bOld, a.state, clock.now).state;
  assert.equal(merge.stableJson(ab), merge.stableJson(ba), 'the same whichever side merges');
  assert.equal(merge.merge(ab, ab, clock.now).changed, false, 'merging the result again changes nothing');
  assert.equal(merge.merge(ab, bOld, clock.now).changed, false, 'the older copy again changes nothing');
  // Of two clears the later wins.
  const first = { at: 10, by: K };
  const second = { at: 20, by: T };
  const x = merge.merge({ recent: {}, keys: {}, cleared: first }, { recent: {}, keys: {}, cleared: second }, clock.now).state;
  const y = merge.merge({ recent: {}, keys: {}, cleared: second }, { recent: {}, keys: {}, cleared: first }, clock.now).state;
  assert.deepEqual(x.cleared, second);
  assert.deepEqual(y.cleared, second);
});

test('clear with Undo: the entries noted again after it, or in the same change before it was sent, come back with their order and times', () => {
  const clock = fakeClock();
  const a = engine(T, clock);
  a.change({ recent: [entry(T, 1, 'a', BASE - 3000), entry(T, 2, 'b', BASE - 2000, { device: 'abcdefgh1' }), entry(K, 3, 'c', BASE - 1000)] });
  const before = a.view();
  const current = before.recent.find(item => item.terminal === 'c');
  const removed = before.recent.filter(item => item !== current);
  // Undo after the clear reached the server.
  a.change({ clear: true, recent: [current] });
  a.change({ recent: removed });
  assert.deepEqual(a.view().recent, before.recent, 'Undo after the clear');
  // Undo before the page sent the clear: one change carries the clear and the entries put back.
  const b = engine(T, fakeClock());
  b.change({ recent: before.recent });
  b.change({ clear: true, recent: [current, ...removed] });
  assert.deepEqual(b.view().recent, before.recent, 'Undo in the same change');
});

test('an older engine that drops the unknown mark still sees the list cleared (the tombstones); a state never cleared has no mark', () => {
  const clock = fakeClock();
  const a = engine(T, clock);
  a.change({ recent: [entry(T, 1, 'a', BASE - 3000), entry(K, 3, 'c', BASE - 1000)] });
  assert.equal('cleared' in a.state, false, 'no mark until a clear: the stored JSON and its digest are as before');
  a.change({ clear: true, recent: [] });
  const { cleared, ...older } = a.state; // what an older engine keeps of it
  assert.ok(cleared);
  const old = engine(K, clock);
  old.state = { recent: { [`${K}|3|c`]: { ...entry(K, 3, 'c', BASE - 1000), gone: false, at: BASE + 1, by: K } }, keys: {} };
  old.absorb(older);
  assert.deepEqual(ids(old.view()), [], 'the tombstones clear it');
});

test('a page change: `clear` must be true or false', () => {
  assert.throws(() => merge.changeState({ clear: 'yes' }, { at: 1, by: T }), /INVALID_PAGE_STATE/);
  assert.equal('cleared' in merge.changeState({ clear: false }, { at: 1, by: T }), false);
  assert.deepEqual(merge.changeState({ clear: true }, { at: 7, by: T }).cleared, { at: 7, by: T });
});

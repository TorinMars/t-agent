// The merge rules of the mind map copies (services/mindmap-merge.js; "Mind maps on every engine" in docs/design/mind-maps.md). Pure: no files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-merge-'));
const merge = require('../services/mindmap-merge');

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const map = (vv, at, by, extra = {}) => ({
  kind: 'map', id: ID, title: 'Plan', data: { root: { topic: `${by}-${at}` } }, revision: 3, created_at: '2026-11-01T00:00:00.000Z', updated_at: new Date(at).toISOString(),
  sync: { vv, at, by, by_name: by.toUpperCase() }, ...extra,
});
const tomb = (vv, at, by) => ({ kind: 'tomb', id: ID, deleted_at: new Date(at).toISOString(), revision: 3, sync: { vv, at, by, by_name: by.toUpperCase() } });

test('version vectors: equal, after, before and concurrent; joined takes each engine\'s larger number', () => {
  assert.equal(merge.compare({ a: 1 }, { a: 1 }), 'equal');
  assert.equal(merge.compare({ a: 2 }, { a: 1 }), 'after');
  assert.equal(merge.compare({ a: 1, b: 1 }, { a: 1 }), 'after');
  assert.equal(merge.compare({ a: 1 }, { a: 1, b: 1 }), 'before');
  assert.equal(merge.compare({ a: 2 }, { a: 1, b: 1 }), 'concurrent');
  assert.deepEqual(merge.joined({ a: 2, b: 1 }, { a: 1, c: 4 }), { a: 2, b: 1, c: 4 });
  // A long offline session still descends from where it started (no list of ancestors to forget).
  assert.equal(merge.compare({ a: 500, b: 3 }, { a: 1, b: 3 }), 'after');
});

test('cleanVector keeps only engine ids with whole positive numbers', () => {
  assert.deepEqual(merge.cleanVector({ 'engine-1': 3 }), { 'engine-1': 3 });
  for (const bad of [null, [], {}, { 'a b': 1 }, { a: 0 }, { a: 1.5 }, { a: '1' }]) assert.equal(merge.cleanVector(bad), null, JSON.stringify(bad));
});

test('a map only one side has is copied; the same or an older version changes nothing; a newer one replaces', () => {
  const v1 = map({ a: 1 }, 100, 'a');
  assert.deepEqual(merge.decide(null, v1), { store: v1, copy: null });
  assert.deepEqual(merge.decide(v1, v1), { store: null, copy: null });
  const v2 = map({ a: 1, b: 1 }, 200, 'b');
  assert.deepEqual(merge.decide(v1, v2), { store: v2, copy: null });
  assert.deepEqual(merge.decide(v2, v1), { store: null, copy: null }, 'an echo of an older version');
});

test('two engines saved different content from the same base: the newer is the map, the other is kept as "(conflict from <engine>)"', () => {
  const onA = map({ a: 2, b: 1 }, 300, 'a');
  const onB = map({ a: 1, b: 2 }, 400, 'b');
  const atA = merge.decide(onA, onB);
  const atB = merge.decide(onB, onA);
  assert.equal(atA.store.sync.by, 'b', 'the later save wins');
  assert.deepEqual(atA.store.sync.vv, { a: 2, b: 2 }, 'the result has seen both');
  assert.deepEqual(atA.store, atB.store, 'both engines end at the same map');
  assert.equal(atA.copy.title, 'Plan (conflict from A)');
  assert.deepEqual(atA.copy.data, onA.data);
  assert.equal(atA.copy.sync.conflict_of, ID);
  assert.deepEqual(atA.copy, atB.copy, 'the same copy, with the same id, on both engines');
  assert.match(atA.copy.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(atA.copy.id, ID);
  // Seen again later (from a third engine): the merged map descends from it, nothing new.
  assert.deepEqual(merge.decide(atA.store, onA), { store: null, copy: null });
  // A tie in time goes to the greater engine id.
  const tieA = map({ a: 2, b: 1 }, 500, 'a');
  const tieB = map({ a: 1, b: 2 }, 500, 'b');
  assert.equal(merge.decide(tieA, tieB).store.sync.by, 'b');
  assert.equal(merge.decide(tieB, tieA).store.sync.by, 'b');
});

test('concurrent saves that ended at the same content keep one map and no copy', () => {
  const onA = { ...map({ a: 2, b: 1 }, 300, 'a'), data: { root: { topic: 'same' } } };
  const onB = { ...map({ a: 1, b: 2 }, 400, 'b'), data: { root: { topic: 'same' } } };
  const result = merge.decide(onA, onB);
  assert.equal(result.copy, null);
  assert.deepEqual(result.store.sync.vv, { a: 2, b: 2 });
});

test('a conflict title keeps its suffix within 200 characters, and an unknown engine is named', () => {
  const long = merge.conflictTitle('x'.repeat(200), 'K01');
  assert.equal([...long].length, 200);
  assert.ok(long.endsWith(' (conflict from K01)'));
  assert.equal(merge.conflictTitle('Plan', ''), 'Plan (conflict from another engine)');
  assert.equal(merge.conflictTitle('\u8ba1\u5212', 'T01'), '\u8ba1\u5212 (conflict from T01)');
});

test('a delete removes the version it saw, and a later one; an edit the deleting engine never saw keeps the map', () => {
  const v1 = map({ a: 1 }, 100, 'a');
  const deleted = tomb({ a: 1, b: 1 }, 200, 'b');
  assert.deepEqual(merge.decide(v1, deleted), { store: deleted, copy: null });
  const editedOffline = map({ a: 2 }, 300, 'a');
  assert.deepEqual(merge.decide(editedOffline, deleted), { store: null, copy: null }, 'the edit stays');
  // The deleting engine gets that edit: the map comes back, with a version that has seen the delete.
  const back = merge.decide(deleted, editedOffline);
  assert.equal(back.store.kind, 'map');
  assert.deepEqual(back.store.sync.vv, { a: 2, b: 1 });
  // The deleted version or an older one arriving later stays deleted.
  assert.deepEqual(merge.decide(deleted, v1), { store: null, copy: null });
  // A newer delete wins over an older one; two deletes made apart are joined.
  const later = tomb({ a: 1, b: 2 }, 300, 'b');
  assert.deepEqual(merge.decide(deleted, later), { store: later, copy: null });
  const other = tomb({ a: 2 }, 250, 'a');
  assert.deepEqual(merge.decide(deleted, other).store.sync.vv, { a: 2, b: 1 });
});

test('the revision here goes up with each change of content and takes a larger revision of a version that descends', () => {
  const local = map({ a: 1 }, 100, 'a', { revision: 4 });
  assert.equal(merge.revisionOf(local, { ...map({ a: 2 }, 200, 'a'), revision: 9 }), 9, 'a company computer\'s offline saves keep their numbers');
  assert.equal(merge.revisionOf(local, { ...map({ a: 2 }, 200, 'a'), revision: 2 }), 5);
  assert.equal(merge.revisionOf(local, { ...local, sync: { ...local.sync, vv: { a: 1, b: 1 } }, revision: 1 }), 4, 'the same content: unchanged, an open page can still save');
  assert.equal(merge.revisionOf(null, { ...map({ a: 1 }, 100, 'a'), revision: 7 }), 7);
  assert.equal(merge.revisionOf(tomb({ a: 1 }, 100, 'a'), { ...map({ a: 2 }, 200, 'a'), revision: 1 }), 4, 'back from a delete: past the deleted revision');
});

// The "moved" record of the shared page state (services/page-state-merge.js `moves`, services/page-state.js `recordMove`; "After the move" in
// docs/design/task-move.md): a task moved to another engine is re-pointed in the Recent list, the session of a column and the drafts, on every
// side the same; a tombstone of the old place is dropped; the record lives 30 days; a state without moves reads as before. Fake clocks only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-move-record-data-'));
delete process.env.TAGENT_HOME;
const Database = require('better-sqlite3');
const merge = require('../services/page-state-merge');
const { createPageState } = require('../services/page-state');
const drafts = require('../public/js/continue-drafts.js');

const T = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const DAY = 24 * 60 * 60 * 1000;
const entry = (instance, task, terminal, extra = {}) => ({ instance, task: String(task), terminal, title: 'Notes', agent: 'claude', used: 100, gone: false, at: 10, by: T, ...extra });
const stateOf = (entries = [], keys = {}, moves = undefined) => ({ recent: Object.fromEntries(entries.map(item => [merge.recentId(item), item])), keys, ...(moves ? { moves } : {}) });
const move = (from, to, at = 50) => merge.moveState({ from, to, title: 'Notes' }, { at, by: T });

test('a moved task is re-pointed: the Recent entry, the column, the draft (new key name); the old tombstone goes; the same whichever side merges', () => {
  const draftValue = { instance: T, task: '5', terminal: 'term-1', text: 'half a sentence', at: 40, client: 'computer', device: 'abcdefgh' };
  const before = stateOf([entry(T, 5, 'term-1'), entry(T, 5, 'term-2', { gone: true, at: 60 }), entry(T, 6, 'x')], {
    'h5-column:abc123': { value: JSON.stringify({ instance: T, task: '5', terminal: 'term-1' }), at: 20, by: T },
    [merge.draftKey(`${T}|5|term-1`)]: { value: draftValue, at: 40, by: T },
  });
  const moved = move({ instance: T, task: '5' }, { instance: K, task: '12' });
  const ab = merge.merge(before, moved, 1000).state;
  const ba = merge.merge(moved, before, 1000).state;
  assert.equal(merge.stableJson(ab), merge.stableJson(ba), 'commutative');
  assert.equal(merge.merge(ab, ab, 1000).changed, false, 'merging again changes nothing');
  assert.deepEqual(Object.keys(ab.recent).sort(), [`${K}|12|term-1`, `${T}|6|x`].sort(), 'the entry is at its new place; the old tombstone is dropped');
  assert.equal(ab.recent[`${K}|12|term-1`].title, 'Notes');
  assert.deepEqual(JSON.parse(ab.keys['h5-column:abc123'].value), { instance: K, task: '12', terminal: 'term-1' });
  const newDraft = merge.draftKey(`${K}|12|term-1`);
  assert.equal(newDraft, drafts.draftKey(`${K}|12|term-1`), 'the same key name the page computes (continue-drafts.js)');
  assert.equal(ab.keys[newDraft].value.text, 'half a sentence');
  assert.equal(ab.keys[merge.draftKey(`${T}|5|term-1`)], undefined);
  // A page that still knows the old place notes it again: it lands at the new one.
  const late = merge.merge(ab, merge.changeState({ recent: [{ instance: T, task: 5, terminal: 'term-1', title: 'Notes', used: 500 }] }, { at: 70, by: T }), 1000).state;
  assert.equal(late.recent[`${K}|12|term-1`].used, 500);
  assert.equal(late.recent[`${T}|5|term-1`], undefined);
  // The page reads the moves.
  assert.deepEqual(merge.pageView(ab).moves, [{ from: { instance: T, task: '5' }, to: { instance: K, task: '12' }, title: 'Notes', at: 50 }]);
});

test('a task moved twice goes to its last place; a move record lives 30 days; a state without moves has no `moves` (older peers digest the same)', () => {
  const twice = merge.merge(merge.merge(stateOf([entry(T, 5, 'a')]), move({ instance: T, task: '5' }, { instance: K, task: '12' }, 50), 1000).state,
    move({ instance: K, task: '12' }, { instance: M, task: '3' }, 60), 1000).state;
  assert.deepEqual(Object.keys(twice.recent), [`${M}|3|a`]);
  const old = merge.trim(twice, 60 + merge.MOVES_KEEP_MS + 1);
  assert.equal(old.moves, undefined, 'expired records go');
  assert.ok(!('moves' in merge.merge(stateOf([entry(T, 1, 'a')]), stateOf([entry(K, 2, 'b')]), 1000).state));
  assert.throws(() => merge.moveState({ from: { instance: T, task: '5' }, to: { instance: T, task: '5' } }, { at: 1, by: T }), /INVALID_PAGE_STATE/);
  assert.throws(() => merge.moveState({ from: { instance: 'bad id!', task: '5' }, to: { instance: K, task: '1' } }, { at: 1, by: T }), /INVALID_PAGE_STATE/);
});

test('recordMove: stored, pushed to the pages of this engine, and kept when the state is merged with a peer that has none', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-move-record-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000;
  const service = createPageState({ db, owner: () => 'me', identity: () => ({ instance_id: T, name: 'T01' }), now: () => clock, intervalMs: 0, visibility: () => null });
  service.change('me', { recent: [{ instance: T, task: 5, terminal: 'term-1', title: 'Notes', used: clock }] });
  const pushed = [];
  const stop = service.follow('me', text => pushed.push(JSON.parse(text)));
  t.after(stop);
  clock += 1000;
  assert.equal(service.recordMove('me', { from: { instance: T, task: '5' }, to: { instance: K, task: '12' }, title: 'Notes' }), true);
  const view = service.read('me');
  assert.deepEqual(view.recent.map(item => `${item.instance}|${item.task}|${item.terminal}`), [`${K}|12|term-1`]);
  assert.equal(view.moves.length, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(pushed.some(answer => answer.moves && answer.moves.length === 1), 'the open page hears it');
  assert.equal(service.recordMove('me', { from: { instance: T, task: '5' }, to: { instance: K, task: '12' }, title: 'Notes' }), true, 'stamped again: a newer version');
});

test('a T-Attention item of a moved task opens the task at its new place (moved_to, by instance id); without the row it offers the resume command', async () => {
  const model = await import('../scripts/h5-shell/attention-model.mjs');
  const context = { host: 'old-mac', session: { resume: 'claude --resume abc' }, tagent: { task_id: '5', terminal_id: 'term-1', moved_to: { instance: K, task_id: '12', terminal_id: 'term-1' } } };
  const tasks = [
    { id: 5, ref: 'local|5', source: 'local', device: { instanceId: T } }, // another task with the old id: never opened
    { id: 12, ref: 'remote:3|12', source: 'remote:3', device: { instanceId: K } },
  ];
  assert.deepEqual(model.jumpBack(context, { sourceKey: 'local', groups: [{ tasks: [tasks[0]] }], tasks, localHost: 'new-mac' }), { kind: 'terminal', taskId: 'remote:3|12', terminalId: 'term-1' });
  assert.deepEqual(model.jumpBack(context, { sourceKey: 'local', groups: [], tasks: [tasks[0]], localHost: 'old-mac' }), { kind: 'copy', command: 'claude --resume abc' });
});

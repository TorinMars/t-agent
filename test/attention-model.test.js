// The pure logic of the T-Attention page (scripts/h5-shell/attention-model.mjs): groups and order, the "Needs you" count, live change events,
// reminders, links and the edit form's PATCH body.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'attention-model.mjs')).href);
const item = (id, status, extra = {}) => ({ id, title: `T${id}`, status, priority: 'none', due_date: null, updated_at: '2026-11-01T00:00:00Z', ...extra });

test('groups come in the fixed order, empty ones left out, closed statuses together and folded', async () => {
  const { groupItems } = await load();
  const groups = groupItems([item(1, 'todo'), item(2, 'done'), item(3, 'waiting_user'), item(4, 'failed'), item(5, 'cancelled'), item(6, 'working'), item(7, 'review')]);
  assert.deepEqual(groups.map(group => group.key), ['needs', 'review', 'working', 'todo', 'closed']);
  assert.deepEqual(groups.at(-1).items.map(entry => entry.id).sort(), [2, 4, 5]);
  assert.equal(groups.at(-1).folded, true);
  assert.equal(groups[0].folded, false);
  assert.deepEqual(groupItems([item(1, 'todo')]).map(group => group.key), ['todo']);
  assert.equal(groupItems([], { keepEmpty: true }).length, 5);
  assert.deepEqual(groupItems([item(1, 'strange')]).map(group => group.key), ['todo'], 'an unknown status is listed under To do');
});

test('within a group: priority, then due date (none last), then the newest update, then id', async () => {
  const { groupItems } = await load();
  const list = [
    item(1, 'todo', { priority: 'low' }),
    item(2, 'todo', { priority: 'high', due_date: '2026-12-01' }),
    item(3, 'todo', { priority: 'high', due_date: '2026-11-20' }),
    item(4, 'todo', { priority: 'high' }),
    item(5, 'todo', { priority: 'medium', updated_at: '2026-11-02T00:00:00Z' }),
    item(6, 'todo', { priority: 'medium', updated_at: '2026-11-03T00:00:00Z' }),
    item(7, 'todo'),
    item(8, 'todo'),
  ];
  assert.deepEqual(groupItems(list)[0].items.map(entry => entry.id), [3, 2, 4, 6, 5, 1, 7, 8]);
});

test('the Needs you count is the number of waiting_user tasks', async () => {
  const { needsCount } = await load();
  assert.equal(needsCount([item(1, 'waiting_user'), item(2, 'review'), item(3, 'waiting_user')]), 2);
  assert.equal(needsCount(null), 0);
});

test('a change event adds, replaces or removes a task, and returns a new list', async () => {
  const { applyChange } = await load();
  const list = [item(1, 'todo'), item(2, 'working')];
  const created = applyChange(list, { kind: 'created', item: item(3, 'todo') });
  assert.deepEqual(created.map(entry => entry.id), [1, 2, 3]);
  assert.notEqual(created, list);
  const updated = applyChange(list, { kind: 'updated', item: item(2, 'waiting_user', { updated_at: '2026-11-02T00:00:00Z' }) });
  assert.equal(updated[1].status, 'waiting_user');
  assert.equal(list[1].status, 'working', 'the old list is not changed');
  assert.deepEqual(applyChange(list, { kind: 'deleted', item: { id: 1 } }).map(entry => entry.id), [2]);
  assert.equal(applyChange(list, { kind: 'deleted', item: { id: 9 } }), list);
  assert.deepEqual(applyChange(list, { kind: 'updated', item: item(9, 'todo') }).map(entry => entry.id), [1, 2, 9], 'an update of an unknown task adds it');
  const late = applyChange(updated, { kind: 'updated', item: item(2, 'working', { updated_at: '2026-11-01T12:00:00Z' }) });
  assert.equal(late[1].status, 'waiting_user', 'an older copy does not replace a newer one');
  assert.equal(applyChange(list, null), list);
});

test('a reminder only for a move INTO waiting_user, failed or review', async () => {
  const { reminderFor } = await load();
  const moved = reminderFor({ kind: 'updated', item: item(1, 'waiting_user', { attention_reason: 'Allow Bash?' }), previous: item(1, 'working') });
  assert.deepEqual(moved, { id: 1, status: 'waiting_user', label: 'Needs you', title: 'T1', reason: 'Allow Bash?' });
  assert.equal(reminderFor({ kind: 'created', item: item(2, 'failed'), previous: null }).label, 'Failed', 'a task created as failed');
  assert.equal(reminderFor({ kind: 'updated', item: item(3, 'review'), previous: item(3, 'working') }).status, 'review');
  assert.equal(reminderFor({ kind: 'updated', item: item(1, 'waiting_user'), previous: item(1, 'waiting_user') }), null, 'already there');
  assert.equal(reminderFor({ kind: 'updated', item: item(1, 'done'), previous: item(1, 'working') }), null);
  assert.equal(reminderFor({ kind: 'created', item: item(1, 'todo') }), null);
  assert.equal(reminderFor({ kind: 'deleted', item: item(1, 'failed') }), null);
});

test('only web links and page addresses of this app can be opened', async () => {
  const { safeLink } = await load();
  assert.deepEqual(safeLink('https://example.test/pr/1'), { url: 'https://example.test/pr/1', external: true });
  assert.deepEqual(safeLink('/?openChat=c1'), { url: '/?openChat=c1', external: false });
  for (const bad of ['javascript:alert(1)', '//evil.test/x', '/\\evil.test', 'data:text/html,x', 'ftp://x', '', null, 'https://a b']) assert.equal(safeLink(bad), null, String(bad));
});

test('the edit form sends only what changed; empty notes and due date clear them', async () => {
  const { patchFor } = await load();
  const base = item(1, 'todo', { notes: 'n', priority: 'none', due_date: '2026-11-10' });
  const same = { title: 'T1', notes: 'n', status: 'todo', priority: 'none', due_date: '2026-11-10' };
  assert.equal(patchFor(base, same), null);
  assert.deepEqual(patchFor(base, { ...same, title: '  New  ', status: 'review' }), { title: 'New', status: 'review' });
  assert.deepEqual(patchFor(base, { ...same, notes: '', due_date: '' }), { notes: null, due_date: null });
  assert.deepEqual(patchFor({ ...base, priority: undefined }, { ...same, priority: 'high' }), { priority: 'high' });
});

test('overdue: a due date before today on a task that is not closed', async () => {
  const { overdue, today } = await load();
  assert.equal(today(new Date(2026, 10, 8, 23, 59)), '2026-11-08');
  assert.equal(overdue(item(1, 'todo', { due_date: '2026-11-07' }), '2026-11-08'), true);
  assert.equal(overdue(item(1, 'todo', { due_date: '2026-11-08' }), '2026-11-08'), false);
  assert.equal(overdue(item(1, 'done', { due_date: '2026-11-01' }), '2026-11-08'), false);
  assert.equal(overdue(item(1, 'todo'), '2026-11-08'), false);
});

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

test('within a group of an older server (no sort_order): priority, then due date (none last), then the newest update, then id', async () => {
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

test('within a group of a server with sort_order: the highest first, ties by the highest id; priority does not count', async () => {
  const { groupItems } = await load();
  const list = [
    item(1, 'todo', { sort_order: 10, priority: 'high' }),
    item(2, 'todo', { sort_order: 30 }),
    item(3, 'todo', { sort_order: 20, due_date: '2026-01-01' }),
    item(4, 'todo', { sort_order: 20 }),
    item(5, 'todo', { sort_order: -1 }),
  ];
  assert.deepEqual(groupItems(list)[0].items.map(entry => entry.id), [2, 4, 3, 1, 5]);
});

test('hasTree: a list with the parent_id key comes from a server with sub-tasks', async () => {
  const { hasTree } = await load();
  assert.equal(hasTree([item(1, 'todo', { parent_id: null })]), true);
  assert.equal(hasTree([item(1, 'todo')]), false, 'an older server');
  assert.equal(hasTree([]), false);
  assert.equal(hasTree(null), false);
});

const tree = (id, status, parent, order, extra = {}) => item(id, status, { parent_id: parent, sort_order: order, ...extra });
const shape = nodes => nodes.map(node => (node.children.length ? [node.item.id, shape(node.children)] : node.item.id));

test('buildTree: sub-tasks under their parent in the same group, depth first, in the group order', async () => {
  const { buildTree, groupItems } = await load();
  const all = [
    tree(1, 'todo', null, 100), tree(2, 'todo', 1, 50), tree(3, 'todo', 1, 60), tree(4, 'todo', 3, 10), tree(5, 'todo', null, 90), tree(6, 'todo', null, 95),
  ];
  const nodes = buildTree(groupItems(all)[0].items, all);
  assert.deepEqual(shape(nodes), [[1, [[3, [4]], 2]], 6, 5]);
  assert.equal(nodes[0].children[0].children[0].depth, 2);
  assert.equal(nodes[0].parent, null);
});

test('buildTree: a sub-task whose parent is in another group is a top-level row with that parent; an unknown parent is a plain row', async () => {
  const { buildTree, groupItems } = await load();
  const all = [tree(1, 'working', null, 10), tree(2, 'review', 1, 5), tree(3, 'review', 99, 4), tree(4, 'review', 2, 3)];
  const review = groupItems(all).find(group => group.key === 'review');
  const nodes = buildTree(review.items, all);
  assert.deepEqual(shape(nodes), [[2, [4]], 3]);
  assert.equal(nodes[0].parent.id, 1, 'the parent of another group, for the hint');
  assert.equal(nodes[1].parent, null, 'a parent that is not known');
  assert.equal(nodes[0].children[0].parent, null, 'a sub-task drawn under its parent has no hint');
});

test('buildTree: deep trees stop indenting at MAX_INDENT; a cycle in the data never loops', async () => {
  const { buildTree, MAX_INDENT } = await load();
  const chain = [tree(1, 'todo', null, 9), tree(2, 'todo', 1, 8), tree(3, 'todo', 2, 7), tree(4, 'todo', 3, 6), tree(5, 'todo', 4, 5), tree(6, 'todo', 5, 4)];
  let node = buildTree(chain)[0];
  const indents = [];
  while (node) { indents.push([node.depth, node.indent]); node = node.children[0]; }
  assert.equal(MAX_INDENT, 3);
  assert.deepEqual(indents, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 3], [5, 3]]);
  const cycle = [tree(1, 'todo', 2, 2), tree(2, 'todo', 1, 1), tree(3, 'todo', 3, 0)];
  const nodes = buildTree(cycle);
  assert.deepEqual(shape(nodes).flat(Infinity).sort(), [1, 2, 3], 'every row is drawn once');
});

test('visibleRows: a collapsed parent hides its sub-tasks at every depth', async () => {
  const { buildTree, visibleRows } = await load();
  const all = [tree(1, 'todo', null, 9), tree(2, 'todo', 1, 8), tree(3, 'todo', 2, 7), tree(4, 'todo', null, 6)];
  const nodes = buildTree(all);
  assert.deepEqual(visibleRows(nodes).map(row => row.id), [1, 2, 3, 4]);
  assert.deepEqual(visibleRows(nodes, new Set([2])).map(row => row.id), [1, 2, 4]);
  assert.deepEqual(visibleRows(nodes, new Set([1])).map(row => [row.id, row.hasChildren]), [[1, true], [4, false]]);
});

test('readCollapsed: a JSON list of ids; anything else is none', async () => {
  const { readCollapsed } = await load();
  assert.deepEqual([...readCollapsed('[1,2]')], [1, 2]);
  assert.deepEqual([...readCollapsed('{"a":1}')], []);
  assert.deepEqual([...readCollapsed('not json')], []);
  assert.deepEqual([...readCollapsed(null)], []);
  assert.deepEqual([...readCollapsed('[1,"x",null]')], [1]);
});

test('children, descendants and the Parent choices (never the task itself or one of its sub-tasks)', async () => {
  const { childrenOf, descendantsOf, parentChoices } = await load();
  const all = [tree(1, 'todo', null, 9), tree(2, 'working', 1, 8), tree(3, 'todo', 2, 7), tree(4, 'todo', null, 6), tree(5, 'todo', 1, 10)];
  assert.deepEqual(childrenOf(all, 1).map(entry => entry.id), [5, 2]);
  assert.deepEqual([...descendantsOf(all, 1)].sort(), [2, 3, 5]);
  assert.deepEqual(parentChoices(all, all[0]).map(entry => entry.id), [4]);
  assert.deepEqual(parentChoices(all, all[2]).map(entry => entry.id).sort(), [1, 2, 4, 5]);
  assert.deepEqual([...descendantsOf([tree(1, 'todo', 2, 0), tree(2, 'todo', 1, 0)], 1)], [2], 'a cycle stops');
});

test('moveLocal: the moved task goes between its new neighbours, to the top or bottom, or into another status', async () => {
  const { moveLocal, groupItems } = await load();
  const all = [tree(1, 'todo', null, 30), tree(2, 'todo', null, 20), tree(3, 'todo', null, 10), tree(4, 'working', null, 5)];
  const ids = list => groupItems(list).map(group => [group.key, group.items.map(entry => entry.id)]);
  assert.deepEqual(ids(moveLocal(all, 3, { before: 1 })), [['working', [4]], ['todo', [3, 1, 2]]]);
  assert.deepEqual(ids(moveLocal(all, 1, { after: 2 })), [['working', [4]], ['todo', [2, 1, 3]]]);
  assert.deepEqual(ids(moveLocal(all, 1, { after: 3 })), [['working', [4]], ['todo', [2, 3, 1]]]);
  assert.deepEqual(ids(moveLocal(all, 3, { position: 'top' })), [['working', [4]], ['todo', [3, 1, 2]]]);
  assert.deepEqual(ids(moveLocal(all, 1, { position: 'bottom' })), [['working', [4]], ['todo', [2, 3, 1]]]);
  const moved = moveLocal(all, 2, { position: 'top', status: 'working' });
  assert.deepEqual(ids(moved), [['working', [2, 4]], ['todo', [1, 3]]]);
  assert.equal(all[1].status, 'todo', 'the old list is not changed');
  assert.equal(moveLocal(all, 9, { before: 1 }), null);
  assert.equal(moveLocal(all, 1, { before: 4 }), null, 'a target in another group');
});

test('stepMove: up, down and to the top among the siblings drawn at the same level', async () => {
  const { stepMove } = await load();
  const all = [tree(1, 'todo', null, 30), tree(2, 'todo', 1, 25), tree(3, 'todo', 1, 24), tree(4, 'todo', null, 20), tree(5, 'todo', null, 10)];
  assert.deepEqual(stepMove(all, 4, 'up'), { before: 1 });
  assert.deepEqual(stepMove(all, 4, 'down'), { after: 5 });
  assert.deepEqual(stepMove(all, 5, 'top'), { before: 1 });
  assert.equal(stepMove(all, 1, 'up'), null);
  assert.equal(stepMove(all, 5, 'down'), null);
  assert.deepEqual(stepMove(all, 3, 'up'), { before: 2 }, 'a sub-task moves among its siblings');
  assert.equal(stepMove(all, 3, 'down'), null);
  assert.equal(stepMove(all, 9, 'up'), null);
});

test('rollbackItems: only the tasks the shown change touched go back, unless a newer copy came meanwhile', async () => {
  const { rollbackItems } = await load();
  const before = [tree(1, 'todo', null, 3), tree(2, 'todo', null, 2), tree(3, 'todo', null, 1)];
  const shown = before.map(entry => (entry.id === 3 ? { ...entry, sort_order: 4 } : entry));
  assert.deepEqual(rollbackItems(shown, before, shown), before);
  const newer = { ...shown[2], title: 'From the server' };
  const now = [shown[0], { ...shown[1], title: 'Live' }, newer];
  const back = rollbackItems(now, before, shown);
  assert.equal(back[2], newer, 'a newer copy stays');
  assert.equal(back[1].title, 'Live', 'an untouched task keeps its live copy');
});

test('statusOfGroup: the status a drop on a group title gives', async () => {
  const { statusOfGroup } = await load();
  assert.deepEqual(['needs', 'review', 'working', 'todo', 'closed', 'x'].map(statusOfGroup), ['waiting_user', 'review', 'working', 'todo', 'done', null]);
});

test('the Needs you count is the number of waiting_user tasks', async () => {
  const { needsCount } = await load();
  assert.equal(needsCount([item(1, 'waiting_user'), item(2, 'review'), item(3, 'waiting_user')]), 2);
  assert.equal(needsCount(null), 0);
});

test('a reorder change with the same updated_at still replaces the copy (the renumbered neighbours of /move)', async () => {
  const { applyChange } = await load();
  const list = [item(1, 'todo', { sort_order: 10 }), item(2, 'todo', { sort_order: 20 })];
  const next = applyChange(list, { kind: 'updated', reorder: true, event: null, item: item(1, 'todo', { sort_order: 30 }) });
  assert.equal(next[0].sort_order, 30);
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

test('the in-page notice is left out only for a review with the plain_turn_end marker on that change', async () => {
  const { reminderFor, showsNotice } = await load();
  const into = (status, extra = {}) => ({ kind: 'updated', item: item(1, status), previous: item(1, 'working'), ...extra });
  const plain = into('review', { plain_turn_end: true });
  assert.equal(showsNotice(plain), false, 'a plain turn end');
  assert.ok(reminderFor(plain), 'it is still a reminder: the sound and the system notification follow their own settings');
  assert.equal(showsNotice(into('review')), true, 'a review after sub-agents, SessionEnd, a manual change or another listener');
  assert.equal(showsNotice({ ...into('review'), plain_turn_end: false }), true);
  assert.equal(showsNotice({ ...into('review'), plain_turn_end: 'true' }), true, 'only exactly true');
  assert.equal(showsNotice(into('waiting_user', { plain_turn_end: true })), true, 'waiting_user always');
  assert.equal(showsNotice(into('failed', { plain_turn_end: true })), true, 'failed always');
  assert.equal(showsNotice(into('waiting_user')), true);
  assert.equal(showsNotice(into('failed')), true);
  assert.equal(showsNotice({ kind: 'created', item: item(2, 'review'), previous: null, plain_turn_end: true }), false, 'a task first seen at its plain Stop');
  assert.equal(showsNotice(into('review', { item: item(1, 'review', { context: { plain_turn_end: true } }) })), true, 'a marker inside the item does not count');
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

test('a change of the order alone is never a reminder', async () => {
  const { reminderFor } = await load();
  const waiting = item(1, 'waiting_user', { sort_order: 5 });
  assert.equal(reminderFor({ kind: 'updated', item: waiting, previous: { ...waiting, sort_order: 2 }, event: { type: 'updated', data: { sort_order: 5 } } }), null);
  assert.equal(reminderFor({ kind: 'updated', item: waiting, previous: null, event: { type: 'moved', from_status: 'waiting_user', to_status: 'waiting_user' } }), null, 'a move event without previous');
  assert.ok(reminderFor({ kind: 'updated', item: waiting, previous: item(1, 'working'), event: { type: 'moved', from_status: 'working', to_status: 'waiting_user' } }), 'a move into Needs you is one');
  // The server's /move: every task whose order changed comes with reorder: true; the renumbered neighbours with event: null.
  assert.equal(reminderFor({ kind: 'updated', item: waiting, previous: item(1, 'working'), reorder: true, event: null }), null, 'a renumbered neighbour');
  assert.equal(reminderFor({ kind: 'updated', item: waiting, previous: item(1, 'working'), reorder: true, event: { type: 'updated', data: { sort_order: 5, move: { position: 'top' } } } }), null);
  assert.ok(reminderFor({ kind: 'updated', item: waiting, previous: item(1, 'working'), reorder: true, event: { type: 'status', from_status: 'working', to_status: 'waiting_user', data: { status: 'waiting_user', move: { position: 'top' } } } }), 'a drop that changed the status');
});

test('only web links and page addresses of this app can be opened', async () => {
  const { safeLink } = await load();
  assert.deepEqual(safeLink('https://example.test/pr/1'), { url: 'https://example.test/pr/1', external: true });
  assert.deepEqual(safeLink('/?openChat=c1'), { url: '/?openChat=c1', external: false });
  for (const bad of ['javascript:alert(1)', '//evil.test/x', '/\\evil.test', 'data:text/html,x', 'ftp://x', '', null, 'https://a b']) assert.equal(safeLink(bad), null, String(bad));
});

test('the edit form: custom status, result and parent only when the form has them; empty clears (null)', async () => {
  const { patchFor } = await load();
  const base = item(1, 'todo', { notes: '', custom_status: 'Blocked', result: null, parent_id: 4 });
  const same = { title: 'T1', notes: '', status: 'todo', priority: 'none', due_date: '', custom_status: 'Blocked', result: '', parent_id: '4' };
  assert.equal(patchFor(base, same), null);
  assert.deepEqual(patchFor(base, { ...same, custom_status: '  ', result: ' Shipped ', parent_id: '' }), { custom_status: null, result: 'Shipped', parent_id: null });
  assert.deepEqual(patchFor(base, { ...same, parent_id: '7' }), { parent_id: 7 });
  const { custom_status: _c, result: _r, parent_id: _p, ...old } = same;
  assert.equal(patchFor(base, old), null, 'an older server form has none of them');
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

test('context: parsed from an object or a JSON string; the pending line wins over the reason', async () => {
  const { contextOf, pendingLine } = await load();
  assert.deepEqual(contextOf({ context: { goal: 'g' } }), { goal: 'g' });
  assert.deepEqual(contextOf({ context: '{"goal":"g"}' }), { goal: 'g' });
  assert.deepEqual(contextOf({ context: 'not json' }), {});
  assert.deepEqual(contextOf(null), {});
  assert.equal(pendingLine(item(1, 'waiting_user', { attention_reason: 'r', context: { pending: { kind: 'permission', text: 'Allow Bash: npm test' } } })), 'Allow Bash: npm test');
  assert.equal(pendingLine(item(1, 'waiting_user', { attention_reason: 'r' })), 'r');
  assert.equal(pendingLine(item(1, 'todo')), '');
});

test('timeline sentences: activity kinds, status changes, created; quiet context updates are left out', async () => {
  const { eventSentence } = await load();
  assert.deepEqual(eventSentence({ type: 'activity', data: { kind: 'prompt', text: 'Add login' } }), { key: 'You asked', text: 'Add login', kind: 'prompt' });
  assert.deepEqual(eventSentence({ type: 'activity', data: '{"kind":"permission","text":"Bash: rm -rf build"}' }), { key: 'Asked for permission', text: 'Bash: rm -rf build', kind: 'permission' });
  assert.equal(eventSentence({ type: 'activity', data: { kind: 'turn_end', text: '' } }).key, 'Finished a turn');
  assert.equal(eventSentence({ type: 'activity', data: { kind: 'something-new', text: 'x' } }).key, 'Note', 'an unknown kind is a note');
  assert.deepEqual(eventSentence({ type: 'status', from_status: 'working', to_status: 'waiting_user' }), { key: 'Now needs you', text: '', kind: 'status', status: 'waiting_user' });
  assert.equal(eventSentence({ type: 'status', to_status: 'review' }).key, 'Ready for your review');
  assert.equal(eventSentence({ type: 'status', to_status: 'odd' }).key, 'Status changed');
  assert.equal(eventSentence({ type: 'created' }).key, 'Created');
  assert.deepEqual(eventSentence({ type: 'updated', data: { title: 'x', priority: 'high', context: {} } }), { key: 'Changed', text: 'title, priority', kind: 'updated' });
  assert.equal(eventSentence({ type: 'updated', data: { context: {}, attention_reason: 'x' } }), null);
  assert.equal(eventSentence({ type: 'weird' }), null);
});

test('timeline sentences of the sub-task fields: custom status, result, parent, and moves', async () => {
  const { eventSentences, timeline } = await load();
  const titleOf = id => (id === 4 ? 'Parent task' : '');
  assert.deepEqual(eventSentences({ type: 'updated', data: { custom_status: 'Blocked' } }), [{ key: 'Custom status', text: 'Blocked', kind: 'custom_status' }]);
  assert.deepEqual(eventSentences({ type: 'updated', data: { custom_status: null } })[0].key, 'Custom status cleared');
  assert.deepEqual(eventSentences({ type: 'updated', data: { result: { from: null, to: 'Shipped' } } })[0], { key: 'Result', text: 'Shipped', kind: 'result' });
  assert.deepEqual(eventSentences({ type: 'updated', data: { parent_id: 4 } }, titleOf)[0], { key: 'Moved under', text: 'Parent task', kind: 'parent', joined: true });
  assert.equal(eventSentences({ type: 'updated', data: { parent_id: 9 } }, titleOf)[0].text, '#9', 'a parent that is not known');
  assert.equal(eventSentences({ type: 'updated', data: { parent_id: null } })[0].key, 'Now top-level');
  assert.deepEqual(eventSentences({ type: 'updated', data: { title: 'x', result: 'r', due_date: null } }).map(entry => [entry.key, entry.text]), [['Changed', 'title, due date'], ['Result', 'r']]);
  assert.deepEqual(eventSentences({ type: 'updated', data: { sort_order: 5 } }), [], 'the order alone says nothing');
  assert.deepEqual(eventSentences({ type: 'moved', data: { before: 2 } }).map(entry => entry.key), ['Moved']);
  assert.deepEqual(eventSentences({ type: 'updated', data: { sort_order: 30, move: { before: 2 }, reason: 'drag' } }).map(entry => entry.key), ['Moved'], 'the server stores a move as an update with data.move');
  assert.deepEqual(eventSentences({ type: 'status', to_status: 'working', data: { status: 'working', sort_order: 9, move: { position: 'top' } } }).map(entry => entry.key), ['Started working']);
  assert.deepEqual(eventSentences({ type: 'activity', data: { kind: 'note', text: 'Handled' } }), [{ key: 'Handled', text: '', kind: 'note' }]);
  assert.deepEqual(eventSentences({ type: 'activity', data: { kind: 'note', text: 'Rejected: Missing tests' } }), [{ key: 'Rejected', text: 'Missing tests', kind: 'note' }]);
  assert.deepEqual(eventSentences({ type: 'activity', data: { kind: 'note', text: 'Rejected' } }), [{ key: 'Rejected', text: '', kind: 'note' }]);
  assert.equal(eventSentences({ type: 'activity', data: { kind: 'note', text: 'Rejectedly done' } })[0].key, 'Note', 'only that note');
  assert.deepEqual(eventSentences({ type: 'status', to_status: 'working', data: { status: 'working', custom_status: 'Retry' } }).map(entry => entry.key), ['Started working', 'Custom status']);
  const at = minute => new Date(2026, 10, 6, 9, minute).toISOString();
  const days = timeline([
    { id: 5, at: at(5), type: 'moved' }, { id: 4, at: at(4), type: 'moved' }, { id: 3, at: at(3), type: 'updated', data: { sort_order: 1 } },
    { id: 2, at: at(2), type: 'updated', data: { sort_order: 2, move: { after: 3 } } }, { id: 1, at: at(1), type: 'activity', data: { kind: 'note', text: 'Handled' } },
  ]);
  assert.deepEqual(days[0].items.map(entry => [entry.id, entry.key]), [[1, 'Handled'], [5, 'Moved']], 'a run of moves is one sentence, at the last one');
});

test('timeline: oldest first, grouped by local day', async () => {
  const { timeline, dayOf } = await load();
  const local = (d, h) => new Date(2026, 10, d, h, 0).toISOString();
  const events = [ // newest first, as the API sends them
    { id: 5, at: local(6, 9), type: 'status', to_status: 'waiting_user', actor: 'claude' },
    { id: 4, at: local(6, 8), type: 'activity', data: { kind: 'prompt', text: 'Continue' }, actor: 'claude' },
    { id: 3, at: local(5, 18), type: 'updated', data: { context: {} } },
    { id: 2, at: local(5, 17), type: 'activity', data: { kind: 'turn_end', text: 'Done with step 1' } },
    { id: 1, at: local(5, 16), type: 'created', actor: 'claude' },
  ];
  const days = timeline(events);
  assert.deepEqual(days.map(day => day.day), [dayOf(local(5, 12)), dayOf(local(6, 12))]);
  assert.deepEqual(days[0].items.map(entry => entry.id), [1, 2], 'the quiet update is left out');
  assert.deepEqual(days[1].items.map(entry => [entry.key, entry.text]), [['You asked', 'Continue'], ['Now needs you', '']]);
  assert.equal(days[1].items[1].actor, 'claude');
  assert.deepEqual(timeline(null), []);
});

test('jump back: the T-Agent terminal when its task is in the local list, else the resume command', async () => {
  const { jumpBack } = await load();
  const groups = [{ tasks: [{ id: 7 }, { id: 9 }] }];
  const context = { tagent: { task_id: '9', terminal_id: 'h5-abc' }, session: { resume: "cd '/w' && claude --resume s1" } };
  assert.deepEqual(jumpBack(context, { sourceKey: 'local', groups }), { kind: 'terminal', taskId: 9, terminalId: 'h5-abc' });
  assert.deepEqual(jumpBack(context, { sourceKey: 'remote:2', groups }), { kind: 'copy', command: "cd '/w' && claude --resume s1" }, 'a remote Engine is shown');
  assert.deepEqual(jumpBack({ ...context, tagent: { task_id: '99', terminal_id: 'x' } }, { sourceKey: 'local', groups }).kind, 'copy', 'the task is not here');
  assert.equal(jumpBack({}, { sourceKey: 'local', groups }), null);
  // A session of another machine (context.host is not this Client's host) never jumps to a local terminal of the same id.
  assert.equal(jumpBack({ ...context, host: 'other-box' }, { sourceKey: 'local', groups, localHost: 'my-mac' }).kind, 'copy');
  assert.equal(jumpBack({ ...context, host: 'My-Mac' }, { sourceKey: 'local', groups, localHost: 'my-mac' }).kind, 'terminal', 'the host is compared without case');
});

test('onThisMachine: context.host against the host of GET /api/attention; unknown on either side is this machine', async () => {
  const { onThisMachine } = await load();
  assert.equal(onThisMachine({ host: 'box' }, 'box'), true);
  assert.equal(onThisMachine({ host: 'box' }, 'other'), false);
  assert.equal(onThisMachine({}, 'other'), true);
  assert.equal(onThisMachine({ host: 'box' }, null), true);
});

test('context file paths: relative to the folder, or already absolute', async () => {
  const { contextFilePath } = await load();
  assert.equal(contextFilePath({ cwd: '/w/app/' }, { path: 'src/a.js' }), '/w/app/src/a.js');
  assert.equal(contextFilePath({ cwd: '/w/app' }, { path: './b.js' }), '/w/app/b.js');
  assert.equal(contextFilePath({}, { path: '/abs/c.js' }), '/abs/c.js');
  assert.equal(contextFilePath({ cwd: 'relative' }, { path: 'a' }), null);
  assert.equal(contextFilePath({ cwd: '/w' }, {}), null);
});

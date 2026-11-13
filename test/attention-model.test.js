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

// ── The phone list: the Home view (lib/attention-home.js, shared with `t-attention list --tree`) ──
const sections = view => Object.fromEntries(view.sections.map(section => [section.key, shape(section.nodes)]));

test('homeGroups: Needs you (waiting_user trees, then review), Working, To do, every section kept; Done counts done, failed and cancelled', async () => {
  const { homeGroups, HOME_SECTIONS } = await load();
  assert.deepEqual(HOME_SECTIONS.map(section => section.key), ['needs_you', 'working', 'todo']);
  const view = homeGroups([
    tree(1, 'review', null, 50), tree(2, 'waiting_user', null, 10), tree(3, 'working', null, 5), tree(4, 'done', null, 1), tree(5, 'failed', null, 2),
    tree(6, 'cancelled', null, 3), tree(7, 'review', null, 60),
  ]);
  assert.deepEqual(view.sections.map(section => [section.key, section.label]), [['needs_you', 'Needs you'], ['working', 'Working'], ['todo', 'To do']]);
  assert.deepEqual(sections(view), { needs_you: [2, 7, 1], working: [3], todo: [] }, 'waiting_user before review, each by sort_order; an empty section stays');
  assert.equal(view.done, 3);
  const empty = homeGroups([]);
  assert.deepEqual(sections(empty), { needs_you: [], working: [], todo: [] });
  assert.equal(empty.done, 0);
});

test('homeGroups: a tree stays together in the section of its most urgent open task, each row with its own status', async () => {
  const { homeGroups } = await load();
  const items = [
    tree(1, 'working', null, 90), tree(2, 'todo', 1, 10), tree(3, 'working', 1, 5), // a working tree with a todo child: Working
    tree(10, 'working', null, 80), tree(11, 'review', 10, 1), tree(12, 'working', 10, 2), // a review child pulls its tree into Needs you
    tree(20, 'todo', null, 70), tree(21, 'todo', 20, 1), tree(22, 'waiting_user', 21, 1), // a waiting_user grandchild: Needs you, first
    tree(30, 'todo', null, 60), tree(31, 'todo', 30, 1),
  ];
  const view = homeGroups(items);
  assert.deepEqual(sections(view), { needs_you: [[20, [[21, [22]]]], [10, [11, 12]]], working: [[1, [3, 2]]], todo: [[30, [31]]] });
  const working = view.sections[1].nodes[0];
  assert.deepEqual([working.item.status, working.children[0].item.status, working.children[1].item.status], ['working', 'working', 'todo'], 'siblings by status, then sort_order');
  assert.deepEqual([working.depth, working.children[1].depth, working.children[1].indent, working.parent], [0, 1, 1, null]);
});

test('homeGroups: finished tasks are only counted, but a finished parent keeps its open sub-task under it', async () => {
  const { homeGroups } = await load();
  const view = homeGroups([
    tree(1, 'done', null, 9), tree(2, 'todo', 1, 1), tree(3, 'done', 1, 2), // a done parent with an open child and a done one
    tree(4, 'working', null, 8), tree(5, 'failed', 4, 1), // a failed leaf under an open task: counted only
    tree(6, 'done', null, 7), tree(7, 'cancelled', 6, 1), // a finished tree: counted only
  ]);
  assert.deepEqual(sections(view), { needs_you: [], working: [4], todo: [[1, [2]]] });
  assert.equal(view.done, 5);
});

test('homeGroups: an older server (no parent_id) lists every task in the section of its status; a cycle never loops; an unknown parent is a plain row', async () => {
  const { homeGroups } = await load();
  const old = homeGroups([item(1, 'todo', { priority: 'high' }), item(2, 'todo'), item(3, 'review'), item(4, 'working'), item(5, 'done')]);
  assert.deepEqual(sections(old), { needs_you: [3], working: [4], todo: [1, 2] });
  assert.equal(old.done, 1);
  const cycle = homeGroups([tree(1, 'todo', 2, 2), tree(2, 'todo', 1, 1), tree(3, 'todo', 3, 0), tree(4, 'working', 99, 5)]);
  assert.deepEqual(sections(cycle).todo.flat(Infinity).sort(), [1, 2, 3], 'every row once');
  assert.deepEqual(sections(cycle).working, [4]);
});

test('homeGroups: several engines keep their trees apart (ids repeat), this machine first among equals', async () => {
  const { homeGroups } = await load();
  const items = [on('remote:7', 1, 'todo', null, 30), on('remote:7', 2, 'review', 1, 5), on('local', 1, 'todo', null, 10), on('local', 2, 'todo', 1, 20)];
  const view = homeGroups(items, { engines: ['local', 'remote:7'] });
  const keys = list => list.map(node => (node.children.length ? [node.item.key, keys(node.children)] : node.item.key));
  assert.deepEqual(view.sections.map(section => keys(section.nodes)), [[['remote:7:1', ['remote:7:2']]], [], [['local:1', ['local:2']]]]);
  const both = homeGroups([on('remote:7', 5, 'todo', null, 30), on('local', 6, 'todo', null, 10)], { engines: ['local', 'remote:7'] });
  assert.deepEqual(keys(both.sections[2].nodes), ['local:6', 'remote:7:5']);
});

test('homeGroups gives the same sections, rows and Done count as `t-attention list --tree` for the same data', async () => {
  const { homeGroups } = await load();
  const cli = require('../scripts/t-attention.js');
  const items = [
    tree(1, 'working', null, 100, { custom_status: 'Coordinating' }), tree(2, 'working', 1, 40), tree(3, 'working', 2, 30), tree(4, 'working', 1, 50),
    tree(5, 'review', 1, 60), tree(6, 'waiting_user', null, 10), tree(7, 'todo', null, 20), tree(8, 'done', null, 5), tree(9, 'failed', null, 6),
    tree(10, 'done', null, 7), tree(11, 'todo', 10, 1), tree(12, 'cancelled', 1, 2), tree(13, 'review', null, 90), tree(14, 'todo', 99, 3),
    tree(15, 'waiting_user', 7, 1), tree(16, 'todo', 16, 4),
  ];
  const flat = nodes => nodes.flatMap(node => [[node.item.id, node.depth], ...flat(node.children)]);
  const page = homeGroups(items);
  const command = cli.treeGroups(items);
  assert.deepEqual(page.sections.map(section => [section.key, flat(section.nodes)]), command.groups.map(group => [group.key, group.rows.map(row => [row.item.id, row.depth])]));
  assert.equal(page.done, command.done);
  assert.deepEqual(command.groups[0].rows.map(row => row.item.id), [6, 7, 15, 13, 1, 5, 4, 2, 3], 'a sanity check of the shared order');
  assert.deepEqual(command.groups[2].rows.map(row => row.item.id), [16, 14, 10, 11], 'a finished root after the open ones');
});

test('homeDetail: what you need to do in Needs you, custom status and notes in Working, nothing in To do; times as MM-DD HH:MM', async () => {
  const { homeDetail, shortTime } = await load();
  assert.deepEqual(homeDetail(item(1, 'waiting_user', { attention_reason: 'Pick a date' }), 'needs_you'), { kind: 'reason', text: 'Pick a date' });
  assert.deepEqual(homeDetail(item(1, 'waiting_user', { attention_reason: 'Old', context: { pending: { text: 'Allow Bash' } } }), 'needs_you'), { kind: 'reason', text: 'Allow Bash' });
  assert.deepEqual(homeDetail(item(2, 'review'), 'needs_you'), { kind: 'confirm', text: 'Waits for your confirmation' });
  assert.deepEqual(homeDetail(item(2, 'review', { attention_reason: 'Check the PR' }), 'needs_you'), { kind: 'reason', text: 'Check the PR' });
  assert.equal(homeDetail(item(3, 'working', { custom_status: 'Busy' }), 'needs_you'), null, 'the parent of a task that needs you');
  assert.deepEqual(homeDetail(item(3, 'working', { custom_status: 'In testing', notes: '\n Due Friday \nmore' }), 'working'), { kind: 'progress', text: 'In testing · Due Friday' });
  assert.deepEqual(homeDetail(item(4, 'todo', { notes: 'Waits for 41' }), 'working'), { kind: 'progress', text: 'Waits for 41' });
  assert.equal(homeDetail(item(4, 'working'), 'working'), null);
  assert.equal(homeDetail(item(5, 'todo', { notes: 'x', custom_status: 'y' }), 'todo'), null);
  const at = new Date(2026, 2, 2, 14, 5);
  assert.equal(shortTime(at.toISOString()), '03-02 14:05');
  assert.equal(shortTime(''), '');
  assert.equal(shortTime('nope'), '');
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
  assert.equal(statusOfGroup('needs_you'), 'waiting_user', 'a drop on the phone\'s Needs you');
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

// ── Several engines in one list (this machine and connected services) ──
const on = (engine, id, status, parent, order, extra = {}) => ({ ...tree(id, status, parent, order, extra), engine, key: `${engine}:${id}` });

test('engines: keys, tagging and reading a key back', async () => {
  const { engineOf, itemKey, keyOf, parseKey, tagItem } = await load();
  const raw = item(5, 'todo', { source: 'claude' });
  const tagged = tagItem(raw, 'remote:7');
  assert.deepEqual([tagged.engine, tagged.key, tagged.source, tagged.id], ['remote:7', 'remote:7:5', 'claude', 5], 'the reporter source stays');
  assert.equal(raw.key, undefined, 'the answer is not changed');
  assert.equal(keyOf(raw), 5, 'an untagged item is named by its id');
  assert.equal(engineOf(raw), 'local');
  assert.equal(itemKey('local', 3), 'local:3');
  assert.deepEqual(parseKey('remote:7:5'), { engine: 'remote:7', id: 5 });
  assert.deepEqual(parseKey('local:12'), { engine: 'local', id: 12 });
  assert.deepEqual(parseKey(9), { engine: 'local', id: 9 }, 'a bare id is this machine');
  assert.deepEqual(parseKey('9'), { engine: 'local', id: 9 });
  assert.equal(parseKey('remote:7:x'), null);
  assert.equal(parseKey(''), null);
});

test('attentionEngines: the listed devices, remote ones only when online with attention:remote; this machine alone before the list is known', async () => {
  const { attentionEngines } = await load();
  const local = { key: 'local', label: 'This machine', name: 'mac', listed: true, capabilities: null, instanceId: 'i-local' };
  const k01 = { key: 'remote:7', label: 'K01', listed: true, capabilities: ['attention:remote'], instanceId: 'i-k01' };
  const old = { key: 'remote:8', label: 'Old', listed: true, capabilities: ['tasks:archive'] };
  const unknown = { key: 'remote:9', label: 'New', listed: true, capabilities: null };
  const hidden = { key: 'remote:10', label: 'Hidden', listed: false, hidden: true, capabilities: ['attention:remote'] };
  const offline = { key: 'remote:11', label: 'Away', listed: true, offline: true, capabilities: ['attention:remote'] };
  assert.deepEqual(attentionEngines([local, k01, old, unknown, hidden, offline]).map(engine => engine.key), ['local', 'remote:7']);
  assert.deepEqual(attentionEngines([local, k01])[1], { key: 'remote:7', local: false, label: 'K01', name: '', instanceId: 'i-k01' });
  assert.deepEqual(attentionEngines(undefined).map(engine => engine.key), ['local'], 'a page without h5.js');
  assert.deepEqual(attentionEngines([{ key: 'local', label: 'This machine' }]).map(engine => engine.key), ['local'], 'an older sources shape');
  assert.deepEqual(attentionEngines([{ ...local, listed: false }, { ...k01, listed: false }]).map(engine => engine.key), ['local'], 'not known yet');
  assert.deepEqual(attentionEngines([{ ...local, listed: false, hidden: true }, k01]).map(engine => engine.key), ['remote:7'], 'this machine hidden from the list');
  assert.deepEqual(attentionEngines([{ ...local, listed: false, hidden: true }, old]).map(engine => engine.key), ['local'], 'never nothing');
});

test('groups of several engines: this machine first, then the engines in list order, each block by sort_order', async () => {
  const { groupItems } = await load();
  const items = [
    on('remote:7', 1, 'todo', null, 90), on('local', 1, 'todo', null, 10), on('remote:3', 2, 'todo', null, 50),
    on('local', 2, 'todo', null, 20), on('remote:7', 2, 'todo', null, 5), on('remote:7', 3, 'waiting_user', null, 1),
  ];
  const groups = groupItems(items, { engines: ['local', 'remote:7', 'remote:3'] });
  assert.deepEqual(groups.map(group => group.key), ['needs', 'todo']);
  assert.deepEqual(groups[1].items.map(entry => entry.key), ['local:2', 'local:1', 'remote:7:1', 'remote:7:2', 'remote:3:2']);
  assert.deepEqual(groupItems(items).find(group => group.key === 'todo').items.slice(0, 2).map(entry => entry.key), ['local:2', 'local:1'], 'this machine first without an order');
});

test('trees of several engines: a parent_id means an item of the same engine, even when the ids repeat', async () => {
  const { buildTree, childrenOf, descendantsOf, groupItems, parentChoices, visibleRows } = await load();
  const items = [
    on('local', 1, 'todo', null, 30), on('local', 2, 'todo', 1, 20),
    on('remote:7', 1, 'todo', null, 30), on('remote:7', 2, 'todo', null, 25), on('remote:7', 3, 'todo', 2, 10),
    on('remote:7', 4, 'review', 1, 5),
  ];
  const todo = groupItems(items, { engines: ['local', 'remote:7'] }).find(group => group.key === 'todo');
  const nodes = buildTree(todo.items, items);
  const keys = list => list.map(node => (node.children.length ? [node.item.key, keys(node.children)] : node.item.key));
  assert.deepEqual(keys(nodes), [['local:1', ['local:2']], 'remote:7:1', ['remote:7:2', ['remote:7:3']]]);
  assert.deepEqual(visibleRows(nodes, new Set(['remote:7:2'])).map(row => row.key), ['local:1', 'local:2', 'remote:7:1', 'remote:7:2']);
  const review = groupItems(items).find(group => group.key === 'review');
  assert.equal(buildTree(review.items, items)[0].parent.key, 'remote:7:1', 'the parent of another group is the one of the same engine');
  assert.deepEqual(childrenOf(items, 'remote:7:1').map(entry => entry.key), ['remote:7:4']);
  assert.deepEqual(childrenOf(items, 'local:1').map(entry => entry.key), ['local:2']);
  assert.deepEqual([...descendantsOf(items, 'remote:7:2')], ['remote:7:3']);
  const choices = parentChoices(items, items[3]).map(entry => entry.key);
  assert.deepEqual(choices.sort(), ['remote:7:1', 'remote:7:4'], 'the Parent select lists only its own engine, never itself or a sub-task');
});

test('moves of several engines: neighbours of the same engine only, keys in, ids in the body', async () => {
  const { moveLocal, rollbackItems, stepMove } = await load();
  const items = [on('local', 1, 'todo', null, 30), on('local', 2, 'todo', null, 20), on('remote:7', 1, 'todo', null, 100), on('remote:7', 2, 'todo', null, 50)];
  const moved = moveLocal(items, 'remote:7:2', { before: 1 });
  assert.equal(moved.find(entry => entry.key === 'remote:7:2').sort_order, 101, 'before remote 1, not local 1');
  assert.equal(moved.find(entry => entry.key === 'local:1').sort_order, 30);
  assert.equal(moveLocal(items, 'local:1', { position: 'top', status: 'review' }).find(entry => entry.key === 'local:1').status, 'review');
  assert.equal(moveLocal(items, 'remote:7:9', { before: 1 }), null);
  assert.deepEqual(stepMove(items, 'remote:7:1', 'up'), null, 'the first of its engine: the local rows above are not its siblings');
  assert.deepEqual(stepMove(items, 'remote:7:2', 'top'), { before: 1 });
  assert.deepEqual(stepMove(items, 'local:2', 'down'), null, 'the last of this machine');
  const back = rollbackItems(moved, items, moved);
  assert.deepEqual(back.map(entry => entry.sort_order), items.map(entry => entry.sort_order));
});

test('changes of several engines: the key decides, so equal ids of two engines never mix', async () => {
  const { applyChange, needsCount } = await load();
  const items = [on('local', 1, 'todo', null, 1), on('remote:7', 1, 'todo', null, 1)];
  const next = applyChange(items, { kind: 'updated', item: { ...items[1], status: 'waiting_user', updated_at: '2026-11-02T00:00:00Z' } });
  assert.deepEqual(next.map(entry => entry.status), ['todo', 'waiting_user']);
  assert.equal(needsCount(next), 1);
  assert.deepEqual(applyChange(next, { kind: 'deleted', item: items[0] }).map(entry => entry.key), ['remote:7:1']);
  assert.equal(applyChange(next, { kind: 'created', item: on('remote:3', 1, 'todo', null, 1) }).length, 3);
});

test('collapsed parents: ids of this machine, keys of another engine', async () => {
  const { collapseId, readCollapsed } = await load();
  assert.deepEqual([...readCollapsed('[1,"remote:7:5","x","remote:7:y",null]')], [1, 'remote:7:5']);
  assert.equal(collapseId(on('local', 4, 'todo', null, 1)), 4);
  assert.equal(collapseId(on('remote:7', 4, 'todo', null, 1)), 'remote:7:4');
  assert.equal(collapseId(item(4, 'todo')), 4);
});

test('jump back to a task of another engine: its row of the one list, on that engine\'s host', async () => {
  const { jumpBack } = await load();
  const context = { host: 'k01', tagent: { task_id: 9, terminal_id: 'h5-abc' }, session: { resume: 'claude --resume s1' } };
  const tasks = [{ id: 9, ref: 'local|9', source: 'local' }, { id: 9, ref: 'remote:7|9', source: 'remote:7' }];
  assert.deepEqual(jumpBack(context, { sourceKey: 'remote:7', tasks, localHost: 'K01' }), { kind: 'terminal', taskId: 'remote:7|9', terminalId: 'h5-abc' });
  assert.equal(jumpBack(context, { sourceKey: 'remote:3', tasks, localHost: 'k01' }).kind, 'copy', 'that engine\'s task is not listed');
  assert.equal(jumpBack(context, { sourceKey: 'remote:7', tasks, localHost: 'other' }).kind, 'copy', 'it ran on yet another machine');
});

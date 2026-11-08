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

// The rows of the "Recent" tab of the task list (scripts/h5-shell/recent-rows.mjs): the switcher's order, the task, device and state of each row,
// sessions that are gone, the search and the Running / Needs you filters with their counts, and the words for when a session was last used.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/recent-rows.mjs');
const entry = (sourceKey, taskId, terminalId, extra = {}) => ({ sourceKey, taskId, terminalId, title: '', agent: null, ...extra });
const device = { key: 'remote:7', name: 'K01', instanceId: 'k' };
const TASKS = [
  { source: 'local', id: 1, title: 'SELF-TAGENT', device: { key: 'local', name: 'T01', instanceId: 't' } },
  { source: 'remote:7', id: 3, title: 'Search popup', device },
];
const LIST = [
  entry('local', '1', 'c1', { title: 'main dev', agent: 'claude', lastUsed: 100 }),
  entry('local', '1', 'x1', { title: '', agent: 'codex', lastUsed: 90 }),
  entry('remote:7', '3', 'm', { title: 'MAIN', agent: 'claude', lastUsed: 80 }),
  entry('remote:7', '3', 't', { title: 'Terminal 1' }),
];
const STATES = { 'local|1|c1': 'running', 'remote:7|3|m': 'waiting' };
const statusOf = item => STATES[`${item.sourceKey}|${item.taskId}|${item.terminalId}`] || 'idle';

test('the rows follow the switcher: the shown session first, then the most recently used, each with its task, device and state', async () => {
  const { recentRows } = await load();
  const rows = recentRows(LIST, { shown: { sourceKey: 'remote:7', taskId: 3, terminalId: 'm' }, tasks: TASKS, statusOf });
  assert.deepEqual(rows.map(row => row.terminalId), ['m', 'c1', 'x1', 't']);
  assert.deepEqual(rows.map(row => row.current), [true, false, false, false]);
  assert.deepEqual(rows[0], {
    key: 'remote:7|3|m', ref: 'remote:7|3', sourceKey: 'remote:7', taskId: '3', terminalId: 'm', agent: 'claude', name: 'MAIN', named: true,
    taskTitle: 'Search popup', device, status: 'waiting', waiting: null, current: true, lastUsed: 80,
  });
  const asking = recentRows(LIST, { tasks: TASKS, statusOf, kindOf: item => (item.terminalId === 'm' ? 'select' : null) });
  assert.deepEqual(asking.map(row => row.waiting), [null, null, 'select', null], 'the kind of a question rides on its row');
  assert.deepEqual([rows[2].name, rows[2].named], ['Codex session', false], 'no name: the kind, for the page to translate');
  assert.deepEqual([rows[3].lastUsed, rows[3].status], [null, 'idle'], 'an old entry has no time');
  const none = recentRows(LIST, { shown: null, tasks: TASKS, statusOf });
  assert.deepEqual(none.map(row => row.terminalId), ['c1', 'x1', 'm', 't'], 'under a chat: the order of the list, none current');
  assert.ok(none.every(row => !row.current));
  assert.deepEqual(recentRows([], {}), []);
});

test('a session whose task is not listed has no task or device (h5.js drops the gone ones before)', async () => {
  const { recentRows } = await load();
  const rows = recentRows([entry('remote:9', '5', 'z', { title: 'Gone' })], { tasks: TASKS });
  assert.deepEqual([rows[0].taskTitle, rows[0].device, rows[0].status], ['', null, 'idle']);
});

test('search matches the session or task name; Running and Needs you keep the sessions in that state; counts', async () => {
  const { recentRows, filterRecent, recentCounts } = await load();
  const rows = recentRows(LIST, { tasks: TASKS, statusOf });
  const ids = list => list.map(row => row.terminalId);
  assert.deepEqual(ids(filterRecent(rows, '', 'all')), ['c1', 'x1', 'm', 't']);
  assert.deepEqual(ids(filterRecent(rows, 'MAIN', 'all')), ['c1', 'm'], 'any case, in the session name ("main dev", "MAIN")');
  assert.deepEqual(ids(filterRecent(rows, ' popup ', 'all')), ['m', 't'], 'in the task name, trimmed');
  assert.deepEqual(ids(filterRecent(rows, 'codex', 'all')), ['x1'], 'an unnamed session by its kind');
  assert.deepEqual(ids(filterRecent(rows, '', 'running')), ['c1']);
  assert.deepEqual(ids(filterRecent(rows, '', 'pending')), ['m']);
  assert.deepEqual(ids(filterRecent(rows, 'self', 'pending')), [], 'both at once');
  assert.deepEqual(recentCounts(rows), { running: 1, pending: 1 });
  assert.deepEqual(recentCounts([]), { running: 0, pending: 0 });
});

test('the words for when a session was last used', async () => {
  const { recentWhen } = await load();
  const now = Date.UTC(2026, 10, 19, 12);
  const ago = minutes => now - minutes * 60000;
  assert.equal(recentWhen(null, now), null);
  assert.equal(recentWhen(0, now), null);
  assert.deepEqual(recentWhen(ago(0.5), now), { count: 0, word: 'just now' });
  assert.deepEqual(recentWhen(now + 5000, now), { count: 0, word: 'just now' }, 'a clock a little ahead');
  assert.deepEqual(recentWhen(ago(2), now), { count: 2, word: 'min ago' });
  assert.deepEqual(recentWhen(ago(59), now), { count: 59, word: 'min ago' });
  assert.deepEqual(recentWhen(ago(60), now), { count: 1, word: 'h ago' });
  assert.deepEqual(recentWhen(ago(23 * 60 + 59), now), { count: 23, word: 'h ago' });
  assert.deepEqual(recentWhen(ago(24 * 60), now), { count: 0, word: 'yesterday' });
  assert.deepEqual(recentWhen(ago(2 * 24 * 60), now), { count: 2, word: 'days ago' });
});

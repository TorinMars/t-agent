// The words and numbers of the Time and Memories tabs (scripts/h5-shell/usage-time-model.mjs; "Usage time and memories: the page" in
// docs/design/usage-time-page.md): durations, the change from the previous period, the tiles, the stacked bars, the task rows, the kinds line, the
// device choices with a device that needs an update, and the memories' colour, words, place and target. The real page is
// scripts/test-h5-usage-time-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'usage-time-model.mjs')).href);
const SOURCES = [{ key: 'local', instanceId: 'inst-a', label: 'This machine' }, { key: 'remote:7', instanceId: 'inst-k', label: 'K01', capabilities: ['terminal:control'] }, { key: 'remote:8', instanceId: 'inst-t', label: 'T01', capabilities: ['usage:time'] }];

test('durations read as the design writes them', async () => {
  const { duration } = await load();
  assert.equal(duration(0), '0 min');
  assert.equal(duration(15), '1 min', 'a few seconds are a minute');
  assert.equal(duration(6 * 60), '6 min');
  assert.equal(duration(28 * 3600), '28 h');
  assert.equal(duration(23 * 3600 + 40 * 60), '23 h 40 min');
  assert.equal(duration(41 * 3600 + 5 * 60), '41 h 05 min');
  assert.equal(duration(-5), '0 min');
});

test('the change from the previous period says its sign in words', async () => {
  const { delta } = await load();
  assert.deepEqual(delta(2 * 3600 + 600, 'week'), { text: '+2 h 10 min vs last week', tone: 'up' });
  assert.deepEqual(delta(-300, 'today'), { text: '−5 min vs yesterday', tone: 'down' });
  assert.deepEqual(delta(20, '30d'), { text: 'Same as the 30 days before', tone: 'same' });
  assert.deepEqual(delta(undefined, 'week'), { text: 'Same as last week', tone: 'same' });
});

test('tiles, bars, tasks and kinds from a summary', async () => {
  const { tiles, bars, taskRows, lookedText, kindsLine } = await load();
  const summary = { tiles: { page_s: 85200, working_s: 147900, waiting_s: 12000, learn_s: 7500, page_delta: 7800, working_delta: 0, waiting_delta: -600, learn_delta: 900, median_wait_s: 360, learn_days: 5, away_working_s: 104400 } };
  const four = tiles(summary, 'week');
  assert.deepEqual(four.map(tile => [tile.label, tile.value, tile.delta.text, tile.note]), [
    ['On the page', '23 h 40 min', '+2 h 10 min vs last week', ''],
    ['Agents working', '41 h 05 min', 'Same as last week', 'while you were away: 29 h'],
    ['Waiting for you', '3 h 20 min', '−10 min vs last week', 'median wait 6 min'],
    ['Learn English', '2 h 05 min', '+15 min vs last week', '5 of 7 days'],
  ]);
  const days = bars([{ day: '2026-11-16', sessions_s: 3600, learn_s: 600, other_s: 0 }, { day: '2026-11-17', sessions_s: 7200, learn_s: 0, other_s: 1200 }], 'week');
  assert.deepEqual(days.map(bar => [bar.label, bar.total, Math.round(bar.height * 100)]), [['Mon', 4200, 50], ['Tue', 8400, 100]]);
  assert.equal(days[0].text, 'Mon 11-16: Sessions 1 h, Learn 10 min, Other 0 min');
  const month = bars(Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, sessions_s: 60 })), '30d');
  assert.deepEqual(month.filter(bar => bar.label).map(bar => bar.label), ['1', '6', '11', '16', '21', '26', '30']);
  const rows = taskRows([{ task: 'inst-a|1', looked_s: 44400, worked_s: 100800 }, { task: 'inst-a|2', looked_s: 14700, worked_s: 32400 }]);
  assert.deepEqual(rows.map(row => Math.round(row.share * 100)), [100, 33]);
  assert.equal(lookedText(rows[0]), '12 h 20 min / 28 h');
  assert.equal(kindsLine([{ kind: 'claude', share: 0.62 }, { kind: 'codex', share: 21 }, { kind: 'terminal', share: 0.12 }, { kind: 'notebook', share: 0.05 }, { kind: 'x', share: 1 }]), 'Kinds of session: Claude 62%, Codex 21%, terminals 12%, notebooks 5%.');
  assert.equal(kindsLine([]), '');
});

test('the device chip lists the summary devices and says which device needs an update first', async () => {
  const { deviceChoices } = await load();
  const choices = deviceChoices({ devices: [{ id: 'inst-a', name: 'MacBook' }, { id: 'inst-t', name: 'T01' }] }, SOURCES);
  assert.deepEqual(choices.map(choice => [choice.id, choice.name, choice.old]), [['all', 'All devices', false], ['inst-a', 'MacBook', false], ['inst-t', 'T01', false], ['inst-k', 'K01', true]]);
  assert.equal(choices[3].note, 'K01 needs an update first');
  // A device that has not said what it can do yet (capabilities null) is not called old.
  assert.equal(deviceChoices({ devices: [] }, [{ key: 'remote:9', instanceId: 'x', label: 'Z', capabilities: null }]).length, 1);
  // The server's own word (`supported: false`, from that engine's /v1/info) is enough, and the device is listed once.
  const server = deviceChoices({ devices: [{ id: 'inst-a', name: 'MacBook', self: true, supported: true }, { id: 'inst-k', name: 'K01', self: false, supported: false }, { id: 'inst-n', name: 'New', self: false, supported: null }] }, SOURCES);
  assert.deepEqual(server.map(choice => [choice.id, choice.old]), [['all', false], ['inst-a', false], ['inst-k', true], ['inst-n', false]]);
  assert.equal(server[2].note, 'K01 needs an update first');
});

test('memories: the dot colour comes with a word, the place line, the target and the digest heading', async () => {
  const { memoryLook, memoryWhere, memoryTarget, memoryDate, titleLookup, digestHeading } = await load();
  assert.deepEqual(memoryLook({ kind: 'note' }), { color: 'warning.light', word: 'your note' });
  assert.deepEqual(memoryLook({ kind: 'event', event: 'attention-confirm' }), { color: 'success.light', word: 'event' });
  assert.deepEqual(memoryLook({ kind: 'event', event: 'engine-down' }), { color: 'error.light', word: 'event' });
  assert.deepEqual(memoryLook({ kind: 'event', event: 'learn-finished' }), { color: 'primary.main', word: 'event' });
  assert.deepEqual(memoryLook({ kind: 'digest' }), { color: 'primary.main', word: 'digest' });
  const state = { sources: SOURCES, taskList: { tasks: [{ source: 'local', id: 4, title: 'SELF-TAGENT', sessions: { rows: [{ kind: 'terminal', id: 'c1', title: 'main dev' }] } }] } };
  const titles = titleLookup(state);
  assert.equal(titles('inst-a|4'), 'SELF-TAGENT');
  assert.equal(titles('inst-a|4|c1'), 'main dev');
  assert.equal(titles('inst-k|4'), '');
  const words = parts => parts.map(part => part.text).join('|');
  assert.equal(words(memoryWhere({ kind: 'event', event: 'attention-confirm', task: 'inst-a|4' }, titles)), 'Task|SELF-TAGENT|event');
  assert.equal(words(memoryWhere({ kind: 'note', task: 'inst-a|4', session: 'inst-a|4|c1' }, titles)), 'SELF-TAGENT|main dev|your note');
  assert.equal(words(memoryWhere({ kind: 'event', event: 'learn-practice' }, titles)), 'Learn|event');
  assert.equal(words(memoryWhere({ kind: 'event', event: 'engine-down' }, titles)), 'Engines|event');
  assert.equal(words(memoryWhere({ kind: 'note', task: 'zz:1', task_title: 'From the server' }, titles)), 'From the server|your note');
  assert.ok(memoryWhere({ kind: 'note', task: 'inst-a|4' }, titles)[0].name, 'a title is marked as a name (never translated)');
  assert.deepEqual(memoryTarget({ task: 'inst-a|4', session: 'inst-a|4|c1' }, SOURCES), { sourceKey: 'local', taskId: '4', terminalId: 'c1' });
  assert.deepEqual(memoryTarget({ task: 'inst-k|9' }, SOURCES), { sourceKey: 'remote:7', taskId: '9', terminalId: null });
  assert.equal(memoryTarget({ task: null }, SOURCES), null);
  assert.equal(memoryDate(new Date(2026, 10, 24, 9).getTime()), '11-24');
  const sunday = new Date(2026, 10, 22, 21, 0).getTime();
  assert.deepEqual(digestHeading({ at: sunday, week: '2026-W47' }, sunday + 3600000), { title: 'This week, in short', written: 'written Sun 21:00' });
  assert.equal(digestHeading({ at: sunday, week: '2026-W47' }, sunday + 9 * 86400000).title, 'Week of 11-16');
  const { isoWeekOf, mondayOfWeek } = await load();
  assert.equal(isoWeekOf(new Date(2026, 10, 24, 10).getTime()), '2026-W48');
  assert.equal(isoWeekOf(new Date(2027, 0, 1, 10).getTime()), '2026-W53');
  assert.equal(memoryDate(mondayOfWeek('2026-W48')), '11-23');
  assert.equal(mondayOfWeek('2026-11-16'), null);
});

test('opening a target closes Settings and uses the page actions', async () => {
  const { openTarget } = await load();
  const calls = [];
  const ui = { actions: { closeSettings: () => calls.push('close'), openTerminalLink: arg => calls.push(['terminal', arg]), openRow: (ref, row) => calls.push(['row', ref, row]) } };
  assert.equal(openTarget(ui, { sourceKey: 'remote:7', taskId: '9', terminalId: 'c2' }), true);
  assert.equal(openTarget(ui, { sourceKey: 'local', taskId: '4', terminalId: null }), true);
  assert.equal(openTarget(ui, null), false);
  assert.deepEqual(calls, ['close', ['terminal', { sourceKey: 'remote:7', taskId: 9, terminalId: 'c2' }], 'close', ['row', 'local|4', { kind: 'task' }]]);
});

// The recent sessions of the session switcher (scripts/h5-shell/recent-sessions.mjs): order, duplicates, the limit, sessions that are gone, other
// engines, the stored form, the cards and their places in the stack.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/recent-sessions.mjs');
const entry = (sourceKey, taskId, terminalId, extra = {}) => ({ sourceKey, taskId, terminalId, title: '', agent: null, ...extra });

test('a shown session goes first, an older copy of it goes away, and nothing changes when it is already first', async () => {
  const { noteRecent } = await load();
  let list = [];
  list = noteRecent(list, entry('local', 1, 'default', { title: 'Terminal 1' }));
  list = noteRecent(list, entry('local', 1, 'c1', { title: 'Claude work', agent: 'claude' }));
  list = noteRecent(list, entry('local', 2, 'b1'));
  assert.deepEqual(list.map(item => item.terminalId), ['b1', 'c1', 'default']);
  list = noteRecent(list, entry('local', 1, 'default', { title: 'Terminal 1' }));
  assert.deepEqual(list.map(item => item.terminalId), ['default', 'b1', 'c1'], 'shown again: first, once');
  assert.equal(noteRecent(list, entry('local', '1', 'default', { title: 'Terminal 1' })), list, 'the same list when it is first already (ids as strings or numbers)');
  const renamed = noteRecent(list, entry('local', 1, 'default', { title: 'Build' }));
  assert.notEqual(renamed, list);
  assert.equal(renamed[0].title, 'Build', 'a new name of the first one is kept');
  assert.equal(renamed.length, 3);
  assert.equal(noteRecent(list, { sourceKey: 'local', taskId: 1 }), list, 'an entry without a terminal is ignored');
});

test('at most RECENT_MAX entries are kept, the oldest go', async () => {
  const { noteRecent, RECENT_MAX } = await load();
  assert.equal(RECENT_MAX, 12);
  let list = [];
  for (let index = 0; index < 20; index += 1) list = noteRecent(list, entry('local', 1, `t${index}`));
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].terminalId, 't19');
  assert.equal(list.at(-1).terminalId, 't8');
  assert.equal(noteRecent([], entry('local', 1, 'x'), 3).length, 1);
});

test('sessions of other engines are entries of their own, keyed by device, task and terminal', async () => {
  const { noteRecent, recentKey, recentTaskRef } = await load();
  let list = noteRecent([], entry('local', 5, 'default'));
  list = noteRecent(list, entry('remote:7', 5, 'default', { agent: 'codex' }));
  assert.equal(list.length, 2, 'the same task id and terminal id on another engine is another session');
  assert.equal(recentKey(list[0]), 'remote:7|5|default');
  assert.equal(recentTaskRef(list[0]), 'remote:7|5', 'the ref openRow takes');
  assert.equal(list[0].agent, 'codex');
});

test('sessions that are gone are dropped: a task not in the list, a terminal not among the known terminals of its task', async () => {
  const { pruneRecent } = await load();
  const list = [entry('local', 1, 'default'), entry('local', 1, 'gone'), entry('remote:7', 3, 'x'), entry('local', 9, 'y'), entry('remote:8', 1, 'z')];
  const tasks = [{ source: 'local', id: 1 }, { source: 'remote:7', id: 3 }, { source: 'remote:8', id: 1 }];
  const kept = pruneRecent(list, tasks, { 'local|1': ['default', 'c1'] });
  assert.deepEqual(kept.map(item => `${item.sourceKey}|${item.taskId}|${item.terminalId}`), ['local|1|default', 'remote:7|3|x', 'remote:8|1|z']);
  assert.equal(pruneRecent(kept, tasks, {}), kept, 'nothing gone: the same list');
  assert.deepEqual(pruneRecent(list, [], {}), [], 'an empty task list keeps nothing');
});

test('the stored form survives a round trip; bad data reads as an empty list, duplicates and extra entries are dropped', async () => {
  const { noteRecent, parseRecent, serializeRecent, RECENT_MAX } = await load();
  let list = noteRecent([], entry('local', 1, 'default', { title: 'Terminal 1' }));
  list = noteRecent(list, entry('remote:7', 2, 'c1', { title: 'Review', agent: 'claude' }));
  assert.deepEqual(parseRecent(serializeRecent(list)), list);
  for (const bad of [null, '', 'nope', '{"a":1}', '42', '[1,2]']) assert.deepEqual(parseRecent(bad), [], String(bad));
  const messy = JSON.stringify([
    { sourceKey: 'local', taskId: 1, terminalId: 'a', agent: 'vim', title: 7 },
    { sourceKey: 'local', taskId: '1', terminalId: 'a' },
    { sourceKey: '', taskId: 1, terminalId: 'b' },
    ...Array.from({ length: 20 }, (_, index) => ({ sourceKey: 'local', taskId: 2, terminalId: `t${index}` })),
  ]);
  const read = parseRecent(messy);
  assert.equal(read.length, RECENT_MAX);
  assert.deepEqual(read[0], { sourceKey: 'local', taskId: '1', terminalId: 'a', title: '', agent: null }, 'cleaned: an unknown agent and a non-text title are dropped');
  assert.equal(read.filter(item => item.terminalId === 'a').length, 1, 'no duplicate');
});

test('the cards: the shown session on top and current, then the others; the switcher opens on the previous one', async () => {
  const { switcherCards, startIndex } = await load();
  const list = [entry('local', 1, 'default'), entry('local', 2, 'b1'), entry('remote:7', 3, 'x')];
  const cards = switcherCards(list, { sourceKey: 'local', taskId: 1, terminalId: 'default' });
  assert.deepEqual(cards.map(card => [card.terminalId, card.current]), [['default', true], ['b1', false], ['x', false]]);
  assert.equal(startIndex(cards), 1);
  const underChat = switcherCards(list, null);
  assert.equal(underChat.some(card => card.current), false, 'a chat is shown: no current card');
  assert.equal(startIndex(underChat), 0);
  const alone = switcherCards([entry('local', 1, 'default')], { sourceKey: 'local', taskId: '1', terminalId: 'default' });
  assert.equal(alone.length, 1);
  assert.equal(startIndex(alone), 0, 'only the current one: it is centred');
  assert.deepEqual(switcherCards([], null), []);
});

test('the place of a card: centred, behind on the left (smaller, darker), on top to the right, further right off the stack', async () => {
  const { cardPlace, settleIndex } = await load();
  const size = { step: 56, offset: 232, far: 390 };
  assert.deepEqual(cardPlace(0, size), { x: -0, scale: 1, dim: 0 });
  const behind = cardPlace(2, size);
  assert.equal(behind.x, -112);
  assert.ok(Math.abs(behind.scale - 0.92) < 1e-9);
  assert.ok(Math.abs(behind.dim - 0.36) < 1e-9);
  assert.deepEqual(cardPlace(-1, size), { x: 232, scale: 1, dim: 0 });
  assert.deepEqual(cardPlace(-0.5, size), { x: 116, scale: 1, dim: 0 }, 'between two places it is interpolated');
  assert.deepEqual(cardPlace(-2, size), { x: 622, scale: 1, dim: 0 });
  assert.equal(cardPlace(30, size).dim, 0.72, 'the darkening has a limit');
  assert.equal(settleIndex(1.4, 5), 1);
  assert.equal(settleIndex(1.6, 5), 2);
  assert.equal(settleIndex(-0.8, 5), 0);
  assert.equal(settleIndex(9, 5), 4);
  assert.equal(settleIndex(3, 0), 0);
});

test('the wide row: cards side by side without overlap, sized by the area, scrolled to show the selected card, and the pick after a hand scroll', async () => {
  const { switcherRow, rowScrollFor, rowPick } = await load();
  const row = switcherRow({ width: 1064, height: 796 }, 4);
  assert.equal(row.cardH, 525, 'two thirds of the area');
  assert.equal(row.cardW, 341, '0.65 of the height');
  assert.deepEqual(row.xs, [24, 385, 746, 1107], 'most recent first from the left, 20px apart');
  assert.equal(row.contentW, 24 * 2 + 4 * 341 + 3 * 20);
  assert.equal(switcherRow({ width: 1848, height: 976 }, 4).cardW, 380, 'at most 380px wide');
  assert.equal(switcherRow({ width: 700, height: 420 }, 4).cardW, 280, 'at least 280px wide');
  const fits = (width, height) => { const r = switcherRow({ width, height }, 12); return r.xs.filter(x => x + r.cardW <= width).length; };
  assert.ok(fits(1848, 976) > fits(1064, 796), 'a wider window shows more whole cards');
  assert.equal(rowScrollFor(row, 1, 0, 1064), 0, 'already in view: no scroll');
  assert.equal(rowScrollFor(row, 3, 0, 1064), 1107 + 341 + 24 - 1064, 'the last card: its right edge comes into view');
  assert.equal(rowScrollFor(row, 0, 300, 1064), 0, 'back to the first card');
  assert.equal(rowScrollFor(row, 9, 120, 1064), 120, 'no such card: unchanged');
  assert.equal(rowPick(row, 1, 0, 1064), 1, 'the selected card is in view');
  assert.equal(rowPick(row, 0, 380, 1064), 1, 'scrolled away from it: the card most in view');
  assert.equal(rowPick(row, 1, 560, 1064), 2, 'less than 60% of it in view');
});

test('lastUsed: a shown entry is stamped, the one left is stamped with `leave`, and old stored lists stay readable', async () => {
  const { noteRecent, parseRecent, serializeRecent } = await load();
  let list = noteRecent([], entry('local', 1, 'a'), undefined, { now: 1000 });
  assert.equal(list[0].lastUsed, 1000);
  list = noteRecent(list, entry('local', 1, 'b'), undefined, { now: 2000 });
  assert.deepEqual(list.map(item => [item.terminalId, item.lastUsed]), [['b', 2000], ['a', 1000]], 'without `leave` the one left keeps its time');
  list = noteRecent(list, entry('local', 1, 'a'), undefined, { now: 5000, leave: true });
  assert.deepEqual(list.map(item => [item.terminalId, item.lastUsed]), [['a', 5000], ['b', 5000]], 'with `leave` the one left was used until now');
  assert.equal(noteRecent(list, entry('local', 1, 'a'), undefined, { now: 9000, leave: true }), list, 'shown again while first: the same list');
  const renamed = noteRecent(list, entry('local', 1, 'a', { title: 'New' }), undefined, { now: 9000, leave: true });
  assert.deepEqual([renamed[0].title, renamed[0].lastUsed, renamed[1].lastUsed], ['New', 5000, 5000], 'a new name of the first one keeps the times');
  // A list stored before lastUsed existed: read as it is, with no time, and stamped from then on.
  const old = parseRecent(JSON.stringify([{ sourceKey: 'local', taskId: '1', terminalId: 'x', title: 'Old', agent: 'claude' }]));
  assert.deepEqual(old, [{ sourceKey: 'local', taskId: '1', terminalId: 'x', title: 'Old', agent: 'claude' }]);
  assert.equal(noteRecent(old, entry('local', 2, 'y'), undefined, { now: 7000 })[1].lastUsed, undefined, 'an old entry left by a new visit keeps no time');
  assert.deepEqual(parseRecent(serializeRecent(list)), list, 'the time is stored');
  for (const bad of [0, -5, 'soon', null, Infinity]) assert.equal('lastUsed' in parseRecent(JSON.stringify([{ ...entry('local', 1, 'a'), lastUsed: bad }]))[0], false, String(bad));
});

test('editRecent renames or forgets one entry and keeps the same list when nothing changes', async () => {
  const { editRecent, recentKey } = await load();
  const list = [entry('local', 1, 'a', { title: 'One', lastUsed: 5 }), entry('remote:7', 1, 'a', { title: 'Two' })];
  const renamed = editRecent(list, recentKey(list[1]), 'Second');
  assert.deepEqual(renamed.map(item => item.title), ['One', 'Second']);
  assert.equal(renamed[0], list[0]);
  assert.equal(editRecent(list, recentKey(list[1]), 'Two'), list, 'the same name');
  assert.equal(editRecent(list, 'local|9|z', 'X'), list, 'no such entry');
  assert.deepEqual(editRecent(list, recentKey(list[0]), null).map(item => item.sourceKey), ['remote:7'], 'forgotten');
});

// The Recent menu of the initial command (scripts/h5-shell/start-commands.mjs) and its merge in the shared page state (services/page-state-merge.js,
// key `ta-start-commands`): one entry per text, the newest first, 10 at most, never a value too long for the page state; two devices' lists merge
// per command by the later time and are cut to the 10 newest, the same on every side.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const merge = require('../services/page-state-merge');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/h5-shell/start-commands.mjs')).href);
const memory = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
};

test('recordCommand: newest first, deduped, at most 10, cleaned', async () => {
  const { recordCommand, recentCommands, START_COMMANDS_KEY, RECENT_MAX } = await load();
  assert.equal(START_COMMANDS_KEY, 'ta-start-commands');
  assert.equal(RECENT_MAX, 10);
  const storage = memory();
  for (let i = 0; i < 12; i += 1) assert.equal(recordCommand(`cmd ${i}`, { now: 1000 + i, storage }), true);
  assert.equal(recordCommand('cmd 3\r\n', { now: 2000, storage }), true, 'used again: moves to the top');
  const list = recentCommands(storage);
  assert.equal(list.length, 10);
  assert.deepEqual(list.slice(0, 3).map(entry => entry.command), ['cmd 3', 'cmd 11', 'cmd 10']);
  assert.equal(list.filter(entry => entry.command === 'cmd 3').length, 1, 'one entry per text');
  assert.ok(!list.some(entry => entry.command === 'cmd 0'), 'the oldest went');
  assert.equal(recordCommand('   ', { storage }), false, 'blank: not remembered');
  assert.equal(recordCommand('x'.repeat(4001), { storage }), false, 'too long: not remembered');
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(START_COMMANDS_KEY))), ['shell'], 'kept as { shell: { command: ms } }');
});

test('recordCommand keeps the value under the page state limit', async () => {
  const { recordCommand, recentCommands } = await load();
  const storage = memory();
  for (let i = 0; i < 10; i += 1) recordCommand(`${i}${'z'.repeat(3990)}`, { now: 100 + i, storage });
  const text = storage.getItem('ta-start-commands');
  assert.ok(text.length <= merge.VALUE_MAX, `fits (${text.length})`);
  assert.ok(recentCommands(storage).length < 10 && recentCommands(storage)[0].command.startsWith('9'), 'the oldest long ones went, the newest stayed');
});

test('commandPreview: one line, cut with an ellipsis', async () => {
  const { commandPreview } = await load();
  assert.equal(commandPreview('cd docs\n  npm run dev  '), 'cd docs ⏎ npm run dev');
  assert.equal(commandPreview('a'.repeat(100), 10), `${'a'.repeat(9)}…`);
});

test('the server merges two devices\' lists per command and keeps the 10 newest, the same on both sides', () => {
  const keyState = (value, at, by) => ({ recent: {}, keys: { 'ta-start-commands': { value, at, by } } });
  const a = {}; const b = {};
  for (let i = 0; i < 8; i += 1) a[`a${i}`] = 100 + i * 2; // 100, 102, ... 114
  for (let i = 0; i < 8; i += 1) b[`b${i}`] = 101 + i * 2; // 101, 103, ... 115
  a.shared = 50; b.shared = 200; // the later time of a command wins
  const left = merge.merge(keyState({ shell: a }, 10, 'aaaa'), keyState({ shell: b }, 11, 'bbbb'), 1000).state;
  const right = merge.merge(keyState({ shell: b }, 11, 'bbbb'), keyState({ shell: a }, 10, 'aaaa'), 1000).state;
  assert.equal(merge.stableJson(left), merge.stableJson(right), 'commutative');
  const kept = left.keys['ta-start-commands'].value.shell;
  assert.equal(Object.keys(kept).length, 10);
  assert.equal(kept.shared, 200);
  assert.deepEqual(Object.entries(kept).sort(([, x], [, y]) => y - x).map(([name]) => name).slice(0, 3), ['shared', 'b7', 'a7']);
  assert.equal(merge.merge(left, right, 1000).changed, false, 'merging again changes nothing');
  // A page that sends more than 10 is cut too (the change goes through the same trim).
  const many = {};
  for (let i = 0; i < 15; i += 1) many[`c${i}`] = i + 1;
  const cut = merge.merge({ recent: {}, keys: {} }, merge.changeState({ keys: { 'ta-start-commands': { shell: many } } }, { at: 5, by: 'cccc' }), 1000).state;
  assert.equal(Object.keys(cut.keys['ta-start-commands'].value.shell).length, 10);
  assert.ok(!('c0' in cut.keys['ta-start-commands'].value.shell));
  // capTimes keeps a merged value under VALUE_MAX.
  const long = {};
  for (let i = 0; i < 10; i += 1) long[`${i}${'q'.repeat(3000)}`] = i + 1;
  const capped = merge.capTimes({ shell: long }, 10);
  assert.ok(JSON.stringify(capped).length <= merge.VALUE_MAX);
  assert.ok(Object.keys(capped.shell).every(name => Number(name[0]) >= 5), 'the oldest went first');
});

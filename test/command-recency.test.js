// Recently used saved commands (scripts/h5-shell/command-recency.mjs): order, divider position, one order per kind, unknown commands, storage, words.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '..', 'public', 'js');
const load = () => import('../scripts/h5-shell/command-recency.mjs');
const memory = (initial = {}) => {
  const data = { ...initial };
  return { data, getItem: key => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
};
const MIN = 60000;
const DAY = 1440 * MIN;

test('used commands come first, most recent at the top; the others keep their usual order', async () => {
  const { orderCommands, recordUse, usesFor } = await load();
  const { AGENT_COMMANDS } = await import('../scripts/h5-shell/commands.mjs');
  const storage = memory();
  const now = 1_800_000_000_000;
  assert.ok(recordUse('claude', '/diff', { now: now - 3 * DAY, storage }));
  assert.ok(recordUse('claude', '/model', { now: now - DAY, storage }));
  assert.ok(recordUse('claude', '/compact', { now: now - 5 * MIN, storage }));
  const { used, rest } = orderCommands(AGENT_COMMANDS.claude.commands, usesFor('claude', storage));
  assert.deepEqual(used.map(entry => entry.command), ['/compact', '/model', '/diff']);
  assert.equal(used[0].usedAt, now - 5 * MIN);
  assert.equal(used[0].note, 'Summarize the conversation to free context', 'a used entry keeps its description');
  assert.deepEqual(rest.map(entry => entry.command), AGENT_COMMANDS.claude.commands.map(entry => entry.command).filter(command => !['/compact', '/model', '/diff'].includes(command)));
  // Using a command again moves it to the top.
  recordUse('claude', '/diff', { now, storage });
  assert.deepEqual(orderCommands(AGENT_COMMANDS.claude.commands, usesFor('claude', storage)).used.map(entry => entry.command), ['/diff', '/compact', '/model']);
});

test('the divider goes only between used and never used commands', async () => {
  const { orderCommands } = await load();
  const commands = [{ command: 'a' }, { command: 'b' }, { command: 'c' }];
  const none = orderCommands(commands, {});
  assert.equal(none.used.length, 0, 'nothing used: no divider, the plain list');
  assert.deepEqual(none.rest.map(entry => entry.command), ['a', 'b', 'c']);
  const some = orderCommands(commands, { c: 5 });
  assert.deepEqual([some.used.map(entry => entry.command), some.rest.map(entry => entry.command)], [['c'], ['a', 'b']], 'the divider sits after the one used command');
  const all = orderCommands(commands, { a: 1, b: 3, c: 2 });
  assert.deepEqual([all.used.map(entry => entry.command), all.rest.length], [['b', 'c', 'a'], 0], 'everything used: nothing after it, so no divider');
});

test('Claude Code, Codex and the shell keep their own order', async () => {
  const { recordUse, usesFor } = await load();
  const storage = memory();
  recordUse('claude', '/compact', { now: 10, storage });
  recordUse('codex', '/status', { now: 20, storage });
  recordUse(null, 'git status', { now: 30, storage });
  assert.deepEqual(usesFor('claude', storage), { '/compact': 10 });
  assert.deepEqual(usesFor('codex', storage), { '/status': 20 });
  assert.deepEqual(usesFor(null, storage), { 'git status': 30 });
  assert.deepEqual(usesFor('something-else', storage), { 'git status': 30 }, 'an unknown agent is a plain shell');
  assert.equal(recordUse('codex', '/clear', { now: 40, storage }), false, 'a Claude command is not part of the Codex list');
  assert.deepEqual(usesFor('codex', storage), { '/status': 20 });
});

test('commands that are no longer in the list are ignored and dropped at the next use', async () => {
  const { RECENCY_KEY, recordUse, usesFor } = await load();
  const storage = memory({ [RECENCY_KEY]: JSON.stringify({ claude: { '/gone': 99, '/model': 5, '/usage': 'x', '/init': -1 } }) });
  assert.deepEqual(usesFor('claude', storage), { '/model': 5 }, 'unknown commands and bad times are left out');
  assert.equal(recordUse('claude', '/gone', { now: 100, storage }), false);
  recordUse('claude', '/clear', { now: 200, storage });
  assert.deepEqual(JSON.parse(storage.data[RECENCY_KEY]).claude, { '/model': 5, '/clear': 200 }, 'the stored kind holds only commands of its list');
});

test('the order survives a reload, and broken or missing storage never throws', async () => {
  const { RECENCY_KEY, recordUse, usesFor } = await load();
  const storage = memory();
  recordUse('codex', '/review', { now: 1234, storage });
  const reloaded = memory({ [RECENCY_KEY]: storage.data[RECENCY_KEY] });
  assert.deepEqual(usesFor('codex', reloaded), { '/review': 1234 });
  assert.deepEqual(usesFor('codex', memory({ [RECENCY_KEY]: '{not json' })), {});
  assert.deepEqual(usesFor('codex', memory({ [RECENCY_KEY]: '[1,2]' })), {});
  assert.deepEqual(usesFor('codex', null), {});
  assert.equal(recordUse('codex', '/review', { storage: null }), false);
  const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(recordUse('codex', '/review', { storage: refusing }), false);
  const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem() {} };
  assert.deepEqual(usesFor('codex', throwing), {});
});

test('the time words, in English and Chinese', async () => {
  const { usedLabel } = await load();
  const now = 1_800_000_000_000;
  const cases = [[now - 20000, 'used just now'], [now - 5 * MIN, 'used 5 min ago'], [now - 59 * MIN, 'used 59 min ago'], [now - 3 * 60 * MIN, 'used 3 h ago'],
    [now - DAY - MIN, 'used yesterday'], [now - 3 * DAY, 'used 3 days ago'], [now + MIN, 'used just now']];
  for (const [at, words] of cases) assert.equal(usedLabel(at, now), words);
  const sandbox = { TALocalKeys: { get: () => 'zh', set() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-extra.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  const HAN = /[\u4e00-\u9fff]/;
  for (const [at] of cases) assert.ok(HAN.test(sandbox.I18n.t(usedLabel(at, now))), `${usedLabel(at, now)} has a Chinese translation`);
  assert.match(sandbox.I18n.t('used 5 min ago'), /^5 /, 'the number is kept');
  for (const text of ['recently used first', 'Edit before sending']) assert.ok(HAN.test(sandbox.I18n.t(text)), `${text} has a Chinese translation`);
});

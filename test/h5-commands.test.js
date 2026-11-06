// The presets of the saved commands list (scripts/h5-shell/commands.mjs): slash commands per agent and the "Keys" group of key combinations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '..', 'public', 'js');
function chinese() {
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  return sandbox.I18n;
}

test('Claude Code and Codex list key combinations with exact bytes and translated notes', async () => {
  const { AGENT_COMMANDS } = await import('../scripts/h5-shell/commands.mjs');
  const I18n = chinese();
  assert.notEqual(I18n.t('Keys'), 'Keys', 'the group header has a Chinese translation');
  for (const agent of ['claude', 'codex']) {
    const { keys } = AGENT_COMMANDS[agent];
    assert.ok(Array.isArray(keys) && keys.length >= 5 && keys.length <= 10, `${agent} has a small key list`);
    const labels = new Set();
    for (const entry of keys) {
      assert.match(entry.label, /^(Esc|Shift|Ctrl|Alt)\b[\w+ ]*$/, `${agent} ${entry.label}: an exact key name`);
      assert.ok(!labels.has(entry.label), `${agent} ${entry.label} is listed once`);
      labels.add(entry.label);
      const parts = Array.isArray(entry.send) ? entry.send : [entry.send];
      assert.ok(parts.length >= 1 && parts.every(part => typeof part === 'string' && part.length > 0), `${agent} ${entry.label} has bytes to send`);
      assert.ok(entry.note && I18n.t(entry.note) !== entry.note, `${agent} ${entry.label}: the note "${entry.note}" has a Chinese translation`);
    }
    const bytes = Object.fromEntries(keys.map(entry => [entry.label, entry.send]));
    assert.equal(bytes['Shift+Tab'], '\x1b[Z', 'Shift+Tab is the back-tab sequence');
    assert.equal(bytes.Esc, '\x1b');
    assert.deepEqual(bytes['Esc Esc'], ['\x1b', '\x1b'], 'Esc Esc is two separate presses');
    assert.equal(bytes['Ctrl+C'], '\x03');
    assert.equal(bytes['Ctrl+R'], '\x12');
    assert.equal(bytes['Ctrl+G'], '\x07');
    assert.equal(bytes['Ctrl+J'], '\n');
  }
  const codex = Object.fromEntries(AGENT_COMMANDS.codex.keys.map(entry => [entry.label, entry.send]));
  assert.equal(codex['Shift+Left'], '\x1b[1;2D', 'Codex: Shift+Left edits the last queued message');
  assert.equal(codex['Ctrl+T'], '\x14', 'Codex: Ctrl+T opens the transcript');
  const claude = Object.fromEntries(AGENT_COMMANDS.claude.keys.map(entry => [entry.label, entry.send]));
  assert.equal(claude['Ctrl+O'], '\x0f', 'Claude Code: Ctrl+O toggles the transcript');
});

test('a plain shell terminal has commands but no key group', async () => {
  const { commandsFor, SHELL_COMMANDS } = await import('../scripts/h5-shell/commands.mjs');
  assert.equal(commandsFor(null), SHELL_COMMANDS);
  assert.equal(commandsFor('other'), SHELL_COMMANDS);
  assert.equal(SHELL_COMMANDS.keys, undefined);
  assert.ok(commandsFor('codex').keys.length > 0);
});

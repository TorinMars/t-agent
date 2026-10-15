const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAgentConfig, createAgentConfigStore, cleanValues, setTomlKey, getTomlKey, AgentConfigError } = require('../services/agent-config');

const roots = [];
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-ac-'));
  roots.push(dir);
  return dir;
}
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
const service = dir => createAgentConfig({ env: {}, home: dir });

test('Claude: writes permissions, model, effort and status line, keeps the rest of settings.json, and writing again changes nothing', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  const file = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [] } }));
  const values = { permission: 'plan', model: 'opus', effort: 'high', statusLine: 'basename "$PWD"', alwaysThinking: 'true', cleanupDays: '30', language: '' };
  const result = service(dir).apply('claude', values);
  assert.deepEqual(result.changed.sort(), ['alwaysThinking', 'cleanupDays', 'effort', 'model', 'permission', 'statusLine']);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.permissions, { allow: ['Bash(ls)'], defaultMode: 'plan' });
  assert.equal(saved.model, 'opus');
  assert.equal(saved.effortLevel, 'high');
  assert.deepEqual(saved.statusLine, { type: 'command', command: 'basename "$PWD"' });
  assert.equal(saved.alwaysThinkingEnabled, true);
  assert.equal(saved.cleanupPeriodDays, 30);
  assert.equal(saved.theme, 'dark');
  assert.equal('language' in saved, false);
  assert.deepEqual(service(dir).apply('claude', values).changed, []);
  // Also write the local override file, so it is not overwritten by the remote defaults from agent-sync.py
  const override = JSON.parse(fs.readFileSync(path.join(dir, '.config/t-agent/overrides/claude/settings.json'), 'utf8'));
  assert.equal(override.model, 'opus');
  assert.equal(override.permissions.defaultMode, 'plan');
});

test('Claude: an invalid JSON config file is left unchanged and reported', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  const file = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => service(dir).apply('claude', { model: 'opus' }), error => error instanceof AgentConfigError && error.code === 'CONFIG_INVALID');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('Codex: changes only the given keys, keeps comments and other tables, writes the status line array on one line', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.codex'));
  const file = path.join(dir, '.codex', 'config.toml');
  fs.writeFileSync(file, '# My notes\nmodel = "old"\n\n[tui]\ntheme = "dark"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  const result = service(dir).apply('codex', { model: 'gpt-5.5', approval: 'on-request', sandbox: 'workspace-write', effort: 'high', statusLine: 'model-with-reasoning, current-dir' });
  assert.equal(result.changed.length, 5);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# My notes\nmodel = "gpt-5.5"\n/);
  assert.match(text, /^approval_policy = "on-request"$/m);
  assert.match(text, /^sandbox_mode = "workspace-write"$/m);
  assert.match(text, /\[tui\]\ntheme = "dark"\nstatus_line = \["model-with-reasoning", "current-dir"\]\n/);
  assert.match(text, /\[projects\."\/x"\]\ntrust_level = "trusted"/);
  // A new top-level key must land before the first table, otherwise it would count as a key inside the table
  assert.ok(text.indexOf('approval_policy') < text.indexOf('[tui]'));
  assert.deepEqual(service(dir).apply('codex', { model: 'gpt-5.5' }).changed, []);
});

test('Read current values: restore each tool’s existing config into form values; a broken file only flags that tool', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude')); fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', statusLine: { type: 'command', command: 'x' }, alwaysThinkingEnabled: false }));
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-6"  # Comment\n[tui]\nstatus_line = ["a", "b"]\n');
  const current = service(dir).read();
  assert.equal(current.claude.model, 'sonnet');
  assert.equal(current.claude.statusLine, 'x');
  assert.equal(current.claude.alwaysThinking, 'false');
  assert.equal(current.claude.permission, '');
  assert.equal(current.codex.model, 'gpt-6');
  assert.equal(current.codex.statusLine, 'a, b');
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), 'nope');
  const broken = service(dir).read();
  assert.equal(broken.errors.claude, 'CONFIG_INVALID');
  assert.equal(broken.codex.model, 'gpt-6');
});

test('Validation: unknown tools, unknown items, values outside the enum, invalid numbers, line breaks and invalid lists are all rejected', () => {
  assert.throws(() => cleanValues('vim', {}), /UNKNOWN_TOOL/);
  assert.throws(() => cleanValues('claude', { hacked: 'x' }), /UNKNOWN_FIELD/);
  assert.throws(() => cleanValues('claude', { permission: 'root' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('claude', { cleanupDays: '-1' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('claude', { model: 'a\nb' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('codex', { statusLine: 'a, b"; evil' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('codex', { model: 5 }), /INVALID_VALUE/);
  assert.deepEqual(cleanValues('codex', { model: '  gpt  ', sandbox: '' }), { model: 'gpt', sandbox: '' });
});

test('TOML helper: keys are placed correctly inside a table, at the top level, and when the table does not exist', () => {
  assert.equal(setTomlKey('', ['model'], '"a"'), 'model = "a"\n');
  assert.equal(setTomlKey('[x]\na = 1\n', ['b'], '2'), 'b = 2\n[x]\na = 1\n');
  assert.equal(getTomlKey('b = 2\n[x]\na = 1\n', ['b']), '2');
  assert.equal(getTomlKey('b = 2\n[x]\na = 1\n', ['x', 'a']), '1');
  assert.equal(getTomlKey('[x]\na = 1\n', ['b']), undefined);
  assert.equal(setTomlKey('a = 1\n', ['t', 'k'], '"v"'), 'a = 1\n\n[t]\nk = "v"\n');
});

test('Client save: keys present in the override (including an empty string) win over the global default', () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const store = createAgentConfigStore(database);
  store.setDefaults('u', 'claude', { model: 'sonnet', permission: 'auto', effort: 'high' });
  store.setOverride('u', '7', 'claude', { model: 'opus', permission: '' });
  const state = store.get('u');
  assert.deepEqual(store.effective(state, '7', 'claude'), { model: 'opus', permission: '', effort: 'high' });
  assert.deepEqual(store.effective(state, 'local', 'claude'), { model: 'sonnet', permission: 'auto', effort: 'high' });
  assert.deepEqual(store.get('other').defaults, { claude: {}, codex: {} });
});

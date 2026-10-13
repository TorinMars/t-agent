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

test('Claude：写入权限、模型、思考强度和状态栏，保留 settings.json 里的其他内容，重复写入不再改动', () => {
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
  // 同时写入本机覆盖文件，避免被 agent-sync.py 的远程默认值盖回去
  const override = JSON.parse(fs.readFileSync(path.join(dir, '.config/t-agent/overrides/claude/settings.json'), 'utf8'));
  assert.equal(override.model, 'opus');
  assert.equal(override.permissions.defaultMode, 'plan');
});

test('Claude：配置文件不是合法 JSON 时不改动并报错', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude'));
  const file = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => service(dir).apply('claude', { model: 'opus' }), error => error instanceof AgentConfigError && error.code === 'CONFIG_INVALID');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('Codex：只改指定键，保留注释和其他表，数组状态栏写成单行', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.codex'));
  const file = path.join(dir, '.codex', 'config.toml');
  fs.writeFileSync(file, '# 我的备注\nmodel = "old"\n\n[tui]\ntheme = "dark"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  const result = service(dir).apply('codex', { model: 'gpt-5.5', approval: 'on-request', sandbox: 'workspace-write', effort: 'high', statusLine: 'model-with-reasoning, current-dir' });
  assert.equal(result.changed.length, 5);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# 我的备注\nmodel = "gpt-5.5"\n/);
  assert.match(text, /^approval_policy = "on-request"$/m);
  assert.match(text, /^sandbox_mode = "workspace-write"$/m);
  assert.match(text, /\[tui\]\ntheme = "dark"\nstatus_line = \["model-with-reasoning", "current-dir"\]\n/);
  assert.match(text, /\[projects\."\/x"\]\ntrust_level = "trusted"/);
  // 顶层新键必须落在第一个表之前，否则会被当成表里的键
  assert.ok(text.indexOf('approval_policy') < text.indexOf('[tui]'));
  assert.deepEqual(service(dir).apply('codex', { model: 'gpt-5.5' }).changed, []);
});

test('读取当前值：把两个工具的现有配置还原成表单值，坏文件只标记该工具', () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, '.claude')); fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', statusLine: { type: 'command', command: 'x' }, alwaysThinkingEnabled: false }));
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-6"  # 注释\n[tui]\nstatus_line = ["a", "b"]\n');
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

test('校验：未知工具、未知项、枚举外的值、非法数字、换行和非法列表都被拒绝', () => {
  assert.throws(() => cleanValues('vim', {}), /UNKNOWN_TOOL/);
  assert.throws(() => cleanValues('claude', { hacked: 'x' }), /UNKNOWN_FIELD/);
  assert.throws(() => cleanValues('claude', { permission: 'root' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('claude', { cleanupDays: '-1' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('claude', { model: 'a\nb' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('codex', { statusLine: 'a, b"; evil' }), /INVALID_VALUE/);
  assert.throws(() => cleanValues('codex', { model: 5 }), /INVALID_VALUE/);
  assert.deepEqual(cleanValues('codex', { model: '  gpt  ', sandbox: '' }), { model: 'gpt', sandbox: '' });
});

test('TOML 辅助：键在表里、顶层和不存在的表时都放对位置', () => {
  assert.equal(setTomlKey('', ['model'], '"a"'), 'model = "a"\n');
  assert.equal(setTomlKey('[x]\na = 1\n', ['b'], '2'), 'b = 2\n[x]\na = 1\n');
  assert.equal(getTomlKey('b = 2\n[x]\na = 1\n', ['b']), '2');
  assert.equal(getTomlKey('b = 2\n[x]\na = 1\n', ['x', 'a']), '1');
  assert.equal(getTomlKey('[x]\na = 1\n', ['b']), undefined);
  assert.equal(setTomlKey('a = 1\n', ['t', 'k'], '"v"'), 'a = 1\n\n[t]\nk = "v"\n');
});

test('Client 保存：覆盖里出现的键（含空串）优先于全局默认', () => {
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

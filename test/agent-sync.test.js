const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const python = spawnSync('python3', ['--version']).status === 0;
const script = path.join(__dirname, '../scripts/agent-sync.py');
const BEGIN = '<!-- t-agent:managed:begin -->';

function machine(remote) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sync-'));
  const rules = path.join(root, 'remote');
  for (const [rel, text] of Object.entries(remote)) {
    fs.mkdirSync(path.dirname(path.join(rules, rel)), { recursive: true });
    fs.writeFileSync(path.join(rules, rel), text);
  }
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const sync = (args = [], env = {}) => spawnSync('python3', [script, 'all', '--verbose', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, T_AGENT_SYNC_CACHE: path.join(root, 'cache'), T_AGENT_RULES_BASE: `file://${rules}`, ...env },
  });
  const file = rel => path.join(home, rel);
  const read = rel => fs.readFileSync(file(rel), 'utf8');
  return { root, rules, home, sync, file, read };
}

const REMOTE = {
  'claude/CLAUDE.md': '## 远程规则\n- 规则一\n',
  'claude/settings.json': JSON.stringify({ model: 'sonnet', permissions: { defaultMode: 'auto', allow: ['Bash(ls)'] } }),
  'codex/AGENTS.md': '## 远程规则\n- 规则二\n',
  'codex/config.toml': 'model = "gpt-6-sol"\napproval_policy = "on-request"\napprovals_reviewer = "auto_review"\nsandbox_mode = "workspace-write"\n',
};

test('规则写入受管区块并保留本机内容，配置递归合并', { skip: !python }, () => {
  const m = machine(REMOTE);
  fs.writeFileSync(m.file('.claude/CLAUDE.md'), '# 我的规则\n- 本机独有\n');
  fs.writeFileSync(m.file('.claude/settings.json'), JSON.stringify({ theme: 'dark', model: 'opus', permissions: { allow: ['Bash(git status)'], defaultMode: 'manual' }, statusLine: { type: 'command' } }));
  fs.writeFileSync(m.file('.codex/config.toml'), '# 备注\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n\n[tui]\nscreen_reader_detection_done = true\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  const result = m.sync();
  assert.equal(result.status, 0, result.stderr);

  const claudeRules = m.read('.claude/CLAUDE.md');
  assert.ok(claudeRules.startsWith('# 我的规则\n- 本机独有\n'));
  assert.ok(claudeRules.includes(BEGIN) && claudeRules.includes('- 规则一'));

  const settings = JSON.parse(m.read('.claude/settings.json'));
  assert.equal(settings.model, 'sonnet');
  assert.equal(settings.permissions.defaultMode, 'auto');
  assert.deepEqual(settings.permissions.allow, ['Bash(git status)', 'Bash(ls)']);
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.statusLine, { type: 'command' });

  const toml = m.read('.codex/config.toml');
  assert.ok(toml.startsWith('# 备注\nmodel = "gpt-6-sol"\nmodel_reasoning_effort = "medium"\n'));
  assert.ok(toml.indexOf('approvals_reviewer = "auto_review"') < toml.indexOf('[tui]'), '新键插入顶层而不是 [tui] 里');
  assert.ok(toml.includes('[tui]\nscreen_reader_detection_done = true') && toml.includes('[projects."/x"]\ntrust_level = "trusted"'));
  assert.equal(fs.readFileSync(m.file('.codex/config.toml.t-agent.bak'), 'utf8').includes('gpt-5.5'), true, '首次修改前备份');
});

test('内容没有变化时不重写文件，远程更新只替换受管区块', { skip: !python }, () => {
  const m = machine(REMOTE);
  m.sync();
  const before = ['.claude/CLAUDE.md', '.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md'].map(f => fs.statSync(m.file(f)).mtimeMs);
  const second = m.sync();
  assert.match(second.stderr, /Claude 已是最新/);
  assert.deepEqual(['.claude/CLAUDE.md', '.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md'].map(f => fs.statSync(m.file(f)).mtimeMs), before);

  fs.writeFileSync(m.file('.claude/CLAUDE.md'), `# 顶部本机规则\n\n${m.read('.claude/CLAUDE.md')}\n# 底部本机规则\n`);
  fs.writeFileSync(path.join(m.rules, 'claude/CLAUDE.md'), `## 远程规则 v2\n- 新规则\n${BEGIN}\n`);
  const third = m.sync();
  assert.equal(third.status, 0, third.stderr);
  const text = m.read('.claude/CLAUDE.md');
  assert.ok(text.startsWith('# 顶部本机规则') && text.trimEnd().endsWith('# 底部本机规则'));
  assert.ok(text.includes('- 新规则') && !text.includes('- 规则一'));
  assert.equal(text.split(BEGIN).length - 1, 1, '远程内容里的标记被剔除，区块不会重复');
});

test('本机或远程文件有问题时不覆盖，也不影响退出码', { skip: !python }, () => {
  const m = machine({ ...REMOTE, 'codex/config.toml': 'model = "a"\nnotes = """\nmulti\n"""\n' });
  fs.writeFileSync(m.file('.claude/settings.json'), '{ 这不是合法 JSON');
  fs.writeFileSync(m.file('.codex/config.toml'), 'model = "local"\n');
  const result = m.sync();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /settings\.json/);
  assert.match(result.stderr, /只支持单行 key = value/);
  assert.equal(m.read('.claude/settings.json'), '{ 这不是合法 JSON');
  assert.equal(m.read('.codex/config.toml'), 'model = "local"\n');
});

test('远程缺少某个文件时不动本机；远程不可达时使用缓存并快速返回', { skip: !python }, () => {
  const m = machine({ 'claude/CLAUDE.md': '## 只有规则\n' });
  fs.writeFileSync(m.file('.claude/settings.json'), '{"theme":"dark"}');
  const first = m.sync();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(m.read('.claude/settings.json'), '{"theme":"dark"}');
  assert.ok(!fs.existsSync(m.file('.codex/config.toml')));

  const cached = machine(REMOTE);
  cached.sync();
  fs.rmSync(cached.file('.claude/CLAUDE.md'));
  const start = Date.now();
  const offline = cached.sync([], { T_AGENT_RULES_BASE: 'http://127.0.0.1:1' });
  assert.equal(offline.status, 0);
  assert.ok(Date.now() - start < 4000, '远程不可达时不能长时间阻塞');
  assert.ok(cached.read('.claude/CLAUDE.md').includes('- 规则一'), '联网失败时用缓存补回规则');
});

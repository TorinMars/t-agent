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
  'claude/CLAUDE.md': '## Remote rules\n- Rule one\n',
  'claude/settings.json': JSON.stringify({ model: 'sonnet', permissions: { defaultMode: 'auto', allow: ['Bash(ls)'] } }),
  'codex/AGENTS.md': '## Remote rules\n- Rule two\n',
  'codex/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'remote-stop' }] }] } }),
  'codex/config.toml': 'model = "gpt-6-sol"\napproval_policy = "on-request"\napprovals_reviewer = "auto_review"\nsandbox_mode = "workspace-write"\n',
};

test('When node file sync manages the config the startup script skips the config but still syncs the rules', { skip: !python }, () => {
  const m = machine(REMOTE);
  fs.writeFileSync(m.file('.codex/config.toml'), 'model = "node"\n');
  fs.writeFileSync(m.file('.codex/config.toml.t-agent-file-sync-managed'), 't-agent-file-sync\n');
  const result = m.sync();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(m.read('.codex/config.toml'), 'model = "node"\n');
  assert.match(m.read('.codex/AGENTS.md'), /Rule two/);
  fs.utimesSync(m.file('.codex/config.toml.t-agent-file-sync-managed'), new Date(0), new Date(0));
  m.sync();
  assert.match(m.read('.codex/config.toml'), /gpt-6-sol/);
});

test('Rules are written into the managed block and local content is kept; the config is merged recursively', { skip: !python }, () => {
  const m = machine(REMOTE);
  fs.writeFileSync(m.file('.claude/CLAUDE.md'), '# My rules\n- Local only\n');
  fs.writeFileSync(m.file('.claude/settings.json'), JSON.stringify({ theme: 'dark', model: 'opus', permissions: { allow: ['Bash(git status)'], defaultMode: 'manual' }, statusLine: { type: 'command' } }));
  fs.writeFileSync(m.file('.codex/config.toml'), '# Notes\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n\n[tui]\nscreen_reader_detection_done = true\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  const result = m.sync();
  assert.equal(result.status, 0, result.stderr);

  const claudeRules = m.read('.claude/CLAUDE.md');
  assert.ok(claudeRules.startsWith('# My rules\n- Local only\n'));
  assert.ok(claudeRules.includes(BEGIN) && claudeRules.includes('- Rule one'));

  const settings = JSON.parse(m.read('.claude/settings.json'));
  assert.equal(settings.model, 'sonnet');
  assert.equal(settings.permissions.defaultMode, 'auto');
  assert.deepEqual(settings.permissions.allow, ['Bash(git status)', 'Bash(ls)']);
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.statusLine, { type: 'command' });

  const toml = m.read('.codex/config.toml');
  assert.ok(toml.startsWith('# Notes\nmodel = "gpt-6-sol"\nmodel_reasoning_effort = "medium"\n'));
  assert.ok(toml.indexOf('approvals_reviewer = "auto_review"') < toml.indexOf('[tui]'), 'A new key is inserted at the top level, not inside [tui] ');
  assert.ok(toml.includes('[tui]\nscreen_reader_detection_done = true') && toml.includes('[projects."/x"]\ntrust_level = "trusted"'));
  assert.equal(fs.readFileSync(m.file('.codex/config.toml.t-agent.bak'), 'utf8').includes('gpt-5.5'), true, 'A backup is made before the first modification');
});

test('The file is not rewritten when nothing changed, and a remote update only replaces the managed block', { skip: !python }, () => {
  const m = machine(REMOTE);
  m.sync();
  const before = ['.claude/CLAUDE.md', '.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md'].map(f => fs.statSync(m.file(f)).mtimeMs);
  const second = m.sync();
  assert.match(second.stderr, /Claude is already up to date/);
  assert.deepEqual(['.claude/CLAUDE.md', '.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md'].map(f => fs.statSync(m.file(f)).mtimeMs), before);

  fs.writeFileSync(m.file('.claude/CLAUDE.md'), `# Top local rules\n\n${m.read('.claude/CLAUDE.md')}\n# Bottom local rules\n`);
  fs.writeFileSync(path.join(m.rules, 'claude/CLAUDE.md'), `## Remote rules v2\n- New rule\n${BEGIN}\n`);
  const third = m.sync();
  assert.equal(third.status, 0, third.stderr);
  const text = m.read('.claude/CLAUDE.md');
  assert.ok(text.startsWith('# Top local rules') && text.trimEnd().endsWith('# Bottom local rules'));
  assert.ok(text.includes('- New rule') && !text.includes('- Rule one'));
  assert.equal(text.split(BEGIN).length - 1, 1, 'Markers inside the remote content are stripped, so the block is not duplicated');
});

test('Nothing is overwritten when the local or remote file has a problem, and the exit code is unaffected', { skip: !python }, () => {
  const m = machine({ ...REMOTE, 'codex/config.toml': 'model = "a"\nnotes = """\nmulti\n"""\n' });
  fs.writeFileSync(m.file('.claude/settings.json'), '{ { this is not valid JSON');
  fs.writeFileSync(m.file('.codex/config.toml'), 'model = "local"\n');
  const result = m.sync();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /settings\.json/);
  assert.match(result.stderr, /only single-line key = value is supported/);
  assert.equal(m.read('.claude/settings.json'), '{ { this is not valid JSON');
  assert.equal(m.read('.codex/config.toml'), 'model = "local"\n');
});

test('A missing remote file leaves the local one alone; an unreachable remote uses the cache and returns quickly', { skip: !python }, () => {
  const m = machine({ 'claude/CLAUDE.md': '## Rules only\n' });
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
  assert.ok(Date.now() - start < 4000, 'An unreachable remote must not block for long');
  assert.ok(cached.read('.claude/CLAUDE.md').includes('- Rule one'), 'When the network fails the cache restores the rules');
});

function writeOverride(m, rel, text) {
  const target = path.join(m.home, '.config/t-agent/overrides', rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

test('A local override wins over the remote, while keys without an override still follow remote updates', { skip: !python }, () => {
  const m = machine(REMOTE);
  writeOverride(m, 'claude/settings.json', JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)'] } }));
  writeOverride(m, 'codex/config.toml', 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[tui]\nnotifications = true\n');
  assert.equal(m.sync().status, 0);

  let settings = JSON.parse(m.read('.claude/settings.json'));
  assert.equal(settings.model, 'opus', 'sonnet, which wins over the remote');
  assert.equal(settings.permissions.defaultMode, 'auto', 'Keys without an override still come from the remote');
  assert.deepEqual(settings.permissions.allow, ['Bash(ls)', 'Bash(npm test)']);
  let toml = m.read('.codex/config.toml');
  assert.match(toml, /^model = "gpt-5\.5"$/m);
  assert.match(toml, /^approvals_reviewer = "auto_review"$/m);
  assert.match(toml, /^model_reasoning_effort = "high"$/m);
  assert.match(toml, /\[tui\]\nnotifications = true/);

  // After the remote later changes a key without an override: it takes effect; a key with an override: still the local value
  fs.writeFileSync(path.join(m.rules, 'claude/settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'plan' } }));
  fs.writeFileSync(path.join(m.rules, 'codex/config.toml'), 'model = "gpt-6-sol"\nsandbox_mode = "read-only"\n');
  assert.equal(m.sync().status, 0);
  settings = JSON.parse(m.read('.claude/settings.json'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.permissions.defaultMode, 'plan');
  toml = m.read('.codex/config.toml');
  assert.match(toml, /^model = "gpt-5\.5"$/m);
  assert.match(toml, /^sandbox_mode = "read-only"$/m);
});

test('Local overrides are applied even when the remote has no config file', { skip: !python }, () => {
  const m = machine({ 'claude/CLAUDE.md': '## Rules\n' });
  writeOverride(m, 'claude/settings.json', '{"model":"opus"}');
  assert.equal(m.sync().status, 0);
  assert.deepEqual(JSON.parse(m.read('.claude/settings.json')), { model: 'opus' });
});

test('A broken override file stops that tool’s config from syncing and leaves the local config alone', { skip: !python }, () => {
  const m = machine(REMOTE);
  fs.writeFileSync(m.file('.claude/settings.json'), '{"model":"local"}');
  fs.writeFileSync(m.file('.codex/config.toml'), 'model = "local"\n');
  writeOverride(m, 'claude/settings.json', '{ { broken');
  writeOverride(m, 'codex/config.toml', 'notes = """\nmulti\n"""\n');
  const result = m.sync();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /local override.*is not valid JSON/);
  assert.match(result.stderr, /local override.*only single-line key = value is supported/);
  assert.equal(m.read('.claude/settings.json'), '{"model":"local"}');
  assert.equal(m.read('.codex/config.toml'), 'model = "local"\n');
  assert.ok(m.read('.claude/CLAUDE.md').includes('- Rule one'), 'Rule sync is unaffected');
});

test('Codex hooks.json merges with the hooks already on this machine, and syncing again produces no duplicates', { skip: !python }, () => {
  const m = machine(REMOTE);
  const mine = { type: 'command', command: 'my-own-hook' };
  fs.writeFileSync(m.file('.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [mine] }], PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }));
  const first = m.sync();
  assert.equal(first.status, 0, first.stderr);
  const merged = JSON.parse(m.read('.codex/hooks.json'));
  assert.equal(merged.hooks.Stop.length, 2, 'Existing local hooks are kept and remote hooks are appended');
  assert.deepEqual(merged.hooks.Stop[0].hooks[0], mine);
  assert.equal(merged.hooks.Stop[1].hooks[0].command, 'remote-stop');
  assert.ok(merged.hooks.PreToolUse, 'Events that exist only locally are kept');

  const before = fs.statSync(m.file('.codex/hooks.json')).mtimeMs;
  const second = m.sync();
  assert.match(second.stderr, /Codex is already up to date/);
  assert.equal(fs.statSync(m.file('.codex/hooks.json')).mtimeMs, before);
  assert.equal(JSON.parse(m.read('.codex/hooks.json')).hooks.Stop.length, 2);
});

test('A corrupted local hooks.json is not overwritten and is reported', { skip: !python }, () => {
  const m = machine(REMOTE);
  fs.writeFileSync(m.file('.codex/hooks.json'), '{broken');
  const result = m.sync();
  assert.equal(result.status, 0);
  assert.equal(m.read('.codex/hooks.json'), '{broken');
  assert.match(result.stderr, /hooks\.json/);
});

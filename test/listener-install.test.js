// lib/listener-install.js: the Claude listener hooks merged into ~/.claude/settings.json and the hook path file.
// Every home and data folder is a temporary folder: the real ~/.claude and ~/.tagent are never read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../lib/listener-install');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-listener-install-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let count = 0;
function machine() {
  const home = path.join(tmp, `home-${count += 1}`);
  fs.mkdirSync(home, { recursive: true });
  return { home, dataDir: path.join(home, '.tagent'), settings: path.join(home, '.claude', 'settings.json') };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode });
  fs.chmodSync(file, mode);
};
const entries = install.listenerEntries();
const listenerCount = Object.values(entries).reduce((sum, groups) => sum + groups.length, 0);

test('the listener entries are the groups of rules/claude/settings.json that read the hook path, with the $TA_ATTENTION_HOOK fallback', () => {
  assert.deepEqual(Object.keys(entries).sort(), ['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  for (const groups of Object.values(entries)) {
    for (const group of groups) {
      const command = group.hooks[0].command;
      assert.match(command, /listeners\/claude-hook\.path/);
      assert.match(command, /\[ -f "\$h" \] \|\| h="\$TA_ATTENTION_HOOK"/);
      assert.match(command, /TA_ATTENTION_ENTRY=2 node "\$h"/);
      assert.ok(!command.includes('TA_HOOK_URL'), 'the terminal-activity hooks are not part of the listener');
    }
  }
});

test('install into a missing settings file: writes the path file and every entry (mode 600), nothing else', () => {
  const m = machine();
  const result = install.installClaudeHooks({ dataDir: m.dataDir, home: m.home });
  assert.equal(result.changed, true);
  assert.equal(result.added, listenerCount);
  assert.equal(result.backup, null, 'no backup of a file that did not exist');
  assert.equal(result.toolHooks, true);
  assert.equal(fs.readFileSync(path.join(m.dataDir, 'listeners', 'claude-hook.path'), 'utf8').trim(), install.HOOK_PATH);
  assert.equal(fs.statSync(m.settings).mode & 0o777, 0o600);
  assert.deepEqual(read(m.settings), { hooks: entries });
  assert.deepEqual(install.checkClaudeHooks({ dataDir: m.dataDir, home: m.home }), { hookPath: true, toolHooks: true, current: true });
});

test('merge keeps other keys and other hooks, backs the file up once, keeps its mode, and a second run changes nothing', () => {
  const m = machine();
  const mine = { hooks: [{ type: 'command', command: 'echo mine' }] };
  const original = { model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [mine], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } };
  write(m.settings, original, 0o640);
  const first = install.installClaudeHooks({ dataDir: m.dataDir, home: m.home });
  assert.equal(first.changed, true);
  assert.equal(first.backup, `${m.settings}.t-agent.bak`);
  assert.deepEqual(read(first.backup), original, 'the backup is the file before the change');
  assert.equal(fs.statSync(m.settings).mode & 0o777, 0o640, 'the file mode is kept');
  const merged = read(m.settings);
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.permissions, original.permissions);
  assert.deepEqual(merged.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(merged.hooks.Stop, [mine, ...entries.Stop], 'the user hook stays first; the listener is added after it');

  const before = fs.readFileSync(m.settings, 'utf8');
  const mtime = fs.statSync(m.settings).mtimeMs;
  const second = install.installClaudeHooks({ dataDir: m.dataDir, home: m.home });
  assert.deepEqual([second.changed, second.added, second.updated], [false, 0, 0]);
  assert.equal(fs.readFileSync(m.settings, 'utf8'), before, 'idempotent');
  assert.equal(fs.statSync(m.settings).mtimeMs, mtime, 'not even rewritten');
  assert.deepEqual(read(first.backup), original, 'the first backup is kept');
  assert.deepEqual(fs.readdirSync(path.dirname(m.settings)).sort(), ['settings.json', 'settings.json.t-agent.bak'], 'no temporary file is left');
});

test('an older listener entry (same event and matcher) is replaced in place, not added next to it', () => {
  const m = machine();
  const old = { hooks: [{ type: 'command', command: 'd="$HOME/.tagent"; h="$(cat "$d/listeners/claude-hook.path")"; node "$h"', timeout: 5 }] };
  write(m.settings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }, old] } });
  assert.equal(install.checkClaudeHooks({ dataDir: m.dataDir, home: m.home }).current, false);
  const result = install.installClaudeHooks({ dataDir: m.dataDir, home: m.home });
  assert.equal(result.updated, 1);
  assert.equal(result.added, listenerCount - 1);
  assert.deepEqual(read(m.settings).hooks.Stop, [{ hooks: [{ type: 'command', command: 'other' }] }, ...entries.Stop]);
});

test('a settings file that is not valid JSON (or has odd hooks) is not touched, and nothing else is written', () => {
  for (const bad of ['{ "model": ', '[1, 2]', '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
    const m = machine();
    write(m.settings, bad);
    assert.throws(() => install.installClaudeHooks({ dataDir: m.dataDir, home: m.home }), error => error.name === 'ListenerInstallError' && error.code === 'SETTINGS_INVALID' && /~\/\.claude\/settings\.json/.test(error.message));
    assert.equal(fs.readFileSync(m.settings, 'utf8'), bad);
    assert.equal(fs.existsSync(`${m.settings}.t-agent.bak`), false);
    assert.equal(fs.existsSync(path.join(m.dataDir, 'listeners', 'claude-hook.path')), false, 'the path file waits for a mergeable settings file');
  }
  const m = machine();
  write(m.settings, '{ not json');
  assert.throws(() => install.installClaudeHooks({ dataDir: m.dataDir, home: m.home }), { message: '~/.claude/settings.json is not valid JSON' });
  assert.throws(() => install.uninstallClaudeHooks({ dataDir: m.dataDir, home: m.home }), { code: 'SETTINGS_INVALID' });
});

test('uninstall removes exactly the listener groups and the path file; user hooks and mixed groups stay', () => {
  const m = machine();
  const mixed = { hooks: [{ type: 'command', command: 'echo mixed' }, { type: 'command', command: 'cat "$d/listeners/claude-hook.path"' }] };
  write(m.settings, { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], SessionEnd: [mixed] } });
  install.installClaudeHooks({ dataDir: m.dataDir, home: m.home });
  const result = install.uninstallClaudeHooks({ dataDir: m.dataDir, home: m.home });
  assert.equal(result.removed, listenerCount);
  assert.equal(result.pathRemoved, true);
  assert.deepEqual(read(m.settings), { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], SessionEnd: [mixed] } });
  assert.equal(fs.existsSync(path.join(m.dataDir, 'listeners', 'claude-hook.path')), false);
  assert.deepEqual(install.checkClaudeHooks({ dataDir: m.dataDir, home: m.home }), { hookPath: false, toolHooks: true, current: false }, 'the mixed group still reads the path');

  // Only listener hooks: the hooks key goes away; a second uninstall changes nothing.
  const n = machine();
  install.installClaudeHooks({ dataDir: n.dataDir, home: n.home });
  install.uninstallClaudeHooks({ dataDir: n.dataDir, home: n.home });
  assert.deepEqual(read(n.settings), {});
  const again = install.uninstallClaudeHooks({ dataDir: n.dataDir, home: n.home });
  assert.deepEqual([again.changed, again.pathRemoved], [false, false]);
  // No settings file at all: nothing to do.
  const empty = machine();
  assert.equal(install.uninstallClaudeHooks({ dataDir: empty.dataDir, home: empty.home }).changed, false);
  assert.equal(fs.existsSync(empty.settings), false);
});

test('a missing hook script is refused before anything is written', () => {
  const m = machine();
  assert.throws(() => install.installClaudeHooks({ dataDir: m.dataDir, home: m.home, hookPath: path.join(tmp, 'gone.js') }), { code: 'HOOK_MISSING' });
  assert.equal(fs.existsSync(m.settings), false);
});

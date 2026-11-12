// Shared Claude settings of the rules and skills sync in TA_CLAUDE_SETTINGS (routes/terminal.js claudeSettings, services/rule-sync.js
// sessionClaudeSettings): on a receiver the shared values come first and T-Agent's hook and peer permission go on top; keys kept local, the source
// itself, the role off and a malformed file add nothing. The real claude binary is never started here: node-pty is mocked. Throwaway HOME and data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-shared-claude-settings-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { peerFsSettings } = require('../services/peer-fs-settings');
const { STATE_KEY } = require('../services/rule-sync');
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], killed: false,
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {},
        kill() { this.killed = true; this.exit(); },
      };
      shells.push(pty);
      return pty;
    } };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
});
const terminal = mod.exports;
class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
}
const task = tasks.createTask('owner', { title: 'shared claude settings' });
const ENDPOINT = 'http://127.0.0.1:9/hooks/terminal-activity';
const SHARED_FILE = path.join(home, '.claude', 'shared', 'claude-settings.json');
const SOURCE = { instance_id: '11111111-1111-4111-8111-111111111111', name: 'Home Mac', since: '2026-11-12T00:00:00.000Z' };

function setState(value) {
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE_KEY, JSON.stringify(value));
}
function writeShared(settings) {
  fs.mkdirSync(path.dirname(SHARED_FILE), { recursive: true });
  fs.writeFileSync(SHARED_FILE, typeof settings === 'string' ? settings : JSON.stringify({ _comment: 'Synced by T-Agent from Home Mac.', ...settings }, null, 2));
}
// The settings a new Claude terminal gets.
function sessionSettings({ peer = false } = {}) {
  terminal.setHookEndpoint(ENDPOINT);
  peerFsSettings().setEnabled(peer);
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${row.terminal_id}&clientId=test` }, { login: 'owner' });
  const pty = shells[shells.length - 1];
  assert.match(pty.input[0], /--settings "\$TA_CLAUDE_SETTINGS"/);
  const settings = JSON.parse(pty.options.env.TA_CLAUDE_SETTINGS);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
  return settings;
}
const HOOK_ONLY = settings => {
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, 'command');
};
const RECEIVED = {
  statusLine: { type: 'command', command: '~/.claude/shared/statusline/statusline-command.sh', padding: 0 },
  model: 'opus',
  permissions: { defaultMode: 'acceptEdits' },
  spinnerTipsEnabled: false,
};

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a receiver injects the shared values under T-Agent\'s session hook', () => {
  setState({ role: 'receive', following: SOURCE });
  writeShared({ ...RECEIVED, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'evil' }] }] }, env: { ANTHROPIC_API_KEY: 'x' }, apiKeyHelper: 'cat key' });
  const settings = sessionSettings();
  assert.deepEqual(settings.statusLine, RECEIVED.statusLine);
  assert.equal(settings.model, 'opus');
  assert.equal(settings.spinnerTipsEnabled, false);
  assert.deepEqual(settings.permissions, { defaultMode: 'acceptEdits' });
  assert.equal(settings._comment, undefined, 'the notice is not passed on');
  assert.equal(settings.env, undefined, 'a denied key in the file is never injected');
  assert.equal(settings.apiKeyHelper, undefined);
  assert.deepEqual(Object.keys(settings.hooks), ['SessionStart'], 'T-Agent\'s hook wins; hooks are never shared');
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /claude-session-hook\.js/);
});

test('with peer file access the peer permission joins the shared permission mode in one permissions object', () => {
  setState({ role: 'receive', following: SOURCE });
  writeShared(RECEIVED);
  const settings = sessionSettings({ peer: true });
  assert.deepEqual(settings.permissions, { defaultMode: 'acceptEdits', allow: ['mcp__t-agent-peers'] });
  assert.ok(settings.hooks.SessionStart);
  assert.equal(settings.model, 'opus');
});

test('keys kept local are not injected, so this machine\'s own settings.json wins', () => {
  setState({ role: 'receive', following: SOURCE, keep_local: ['model', 'permissions.defaultMode', 'env'] });
  writeShared(RECEIVED);
  const settings = sessionSettings({ peer: true });
  assert.equal(settings.model, undefined);
  assert.deepEqual(settings.permissions, { allow: ['mcp__t-agent-peers'] });
  assert.deepEqual(settings.statusLine, RECEIVED.statusLine);
});

test('the source itself, the role off and a receiver without a source inject nothing', () => {
  writeShared(RECEIVED);
  setState({ role: 'source', following: null });
  HOOK_ONLY(sessionSettings());
  setState({ role: 'off', following: SOURCE });
  HOOK_ONLY(sessionSettings());
  setState({ role: 'receive', following: null });
  HOOK_ONLY(sessionSettings());
  setState({ role: 'receive', following: SOURCE });
  fs.rmSync(SHARED_FILE);
  HOOK_ONLY(sessionSettings());
});

test('a malformed shared file adds nothing and is logged once', t => {
  setState({ role: 'receive', following: SOURCE });
  writeShared('{ not json');
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = original; });
  HOOK_ONLY(sessionSettings());
  assert.deepEqual(sessionSettings({ peer: true }).permissions, { allow: ['mcp__t-agent-peers'] });
  console.warn = original;
  assert.equal(warnings.filter(line => line.includes('claude-settings.json')).length, 1, 'one warning for the same file');
  writeShared('[]');
  HOOK_ONLY(sessionSettings());
});

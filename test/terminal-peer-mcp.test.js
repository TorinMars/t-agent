// Peer file access in terminal launches: with the switch on (services/peer-fs-settings.js), Claude and Codex sessions started by a
// terminal get the read-only `t-agent-peers` MCP server (scripts/peer-mcp.js) on their command line, and the PTY gets the variables
// it needs. The real claude / codex binaries are never started: node-pty is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-peer-mcp-launch-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { peerFsSettings } = require('../services/peer-fs-settings');
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const peerScript = path.resolve(__dirname, '../scripts/peer-mcp.js');
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
const task = tasks.createTask('owner', { title: 'peer launch' });
const ENDPOINT = 'http://127.0.0.1:9/hooks/terminal-activity';
const SETTINGS = '--settings "$TA_CLAUDE_SETTINGS"';
const MCP = '--mcp-config "$TA_MCP_CONFIG"';
const CODEX = `-c "mcp_servers.t-agent-peers.command=$TA_PEER_MCP_COMMAND" -c "mcp_servers.t-agent-peers.args=$TA_PEER_MCP_ARGS" -c 'mcp_servers.t-agent-peers.env_vars=["TA_PEER_URL","TA_PEER_TASK","TA_PEER_TERMINAL","TA_HOOK_TOKEN"]'`;
const PEER_KEYS = ['TA_PEER_URL', 'TA_PEER_TASK', 'TA_PEER_TERMINAL', 'TA_MCP_CONFIG', 'TA_PEER_MCP_COMMAND', 'TA_PEER_MCP_ARGS'];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function open(taskId, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${taskId}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return shells[shells.length - 1];
}
const boundSession = id => db.prepare('SELECT agent_session_id FROM task_terminals WHERE terminal_id = ?').get(id).agent_session_id;
// What the shell makes of a typed line's "$VAR" references, for the values the agent receives.
const expand = (line, env) => line.replace(/\$([A-Z_]+)/g, (_, key) => env[key] ?? '');

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('with the switch on a Claude terminal gets the t-agent-peers MCP server; the token stays in the environment', () => {
  terminal.setHookEndpoint(ENDPOINT);
  peerFsSettings().setEnabled(true);
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  assert.deepEqual(pty.input, [`claude --session-id ${boundSession(row.terminal_id)} ${SETTINGS} ${MCP}\r`], '--mcp-config is the last option (it takes several values)');
  const env = pty.options.env;
  assert.equal(env.TA_PEER_URL, 'http://127.0.0.1:9/api/peer-fs', 'the relay is on the origin of the hook endpoint');
  assert.equal(env.TA_PEER_TASK, String(task.id));
  assert.equal(env.TA_PEER_TERMINAL, row.terminal_id);
  assert.match(env.TA_HOOK_TOKEN, /^[0-9a-f]{64}$/);
  const config = JSON.parse(env.TA_MCP_CONFIG);
  assert.deepEqual(config, { mcpServers: { 't-agent-peers': { type: 'stdio', command: process.execPath, args: [peerScript] } } });
  assert.ok(fs.existsSync(peerScript));
  // Claude passes its whole environment to stdio MCP servers, so the config names no variable and holds no token.
  assert.ok(!env.TA_MCP_CONFIG.includes(env.TA_HOOK_TOKEN));
  assert.ok(!expand(pty.input[0], env).includes(env.TA_HOOK_TOKEN), 'the expanded command line (what ps shows) has no token');
  const settings = JSON.parse(env.TA_CLAUDE_SETTINGS);
  assert.deepEqual(Object.keys(settings), ['hooks', 'permissions']);
  assert.deepEqual(settings.permissions, { allow: ['mcp__t-agent-peers'] }, 'the read-only peer tools do not ask each time');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('with the switch on a Codex terminal gets the server through -c overrides and passes the variables on', () => {
  terminal.setHookEndpoint(ENDPOINT);
  peerFsSettings().setEnabled(true);
  const row = terminal.createTerminal(task.id, { agent: 'codex' });
  const pty = open(task.id, row.terminal_id);
  assert.deepEqual(pty.input, [`codex ${CODEX}\r`]);
  const env = pty.options.env;
  for (const key of PEER_KEYS) assert.ok(env[key], `${key} is set`);
  // The values are TOML; for these plain paths JSON reads them the same way.
  assert.equal(JSON.parse(env.TA_PEER_MCP_COMMAND), process.execPath);
  assert.deepEqual(JSON.parse(env.TA_PEER_MCP_ARGS), [peerScript]);
  const typed = expand(pty.input[0], env);
  assert.ok(typed.includes(`mcp_servers.t-agent-peers.command="${process.execPath}"`));
  assert.ok(!typed.includes(env.TA_HOOK_TOKEN), 'Codex gets the token from its environment (env_vars), not from argv');

  // A reopened Codex terminal resumes its session with the same server.
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '12');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-peer.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'cccccccc-9001', cwd: task.work_dir, timestamp: new Date(Date.now() + 1000).toISOString() } }]));
  terminal.listTerminals(task.id);
  assert.equal(boundSession(row.terminal_id), 'cccccccc-9001');
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `codex resume cccccccc-9001 ${CODEX}`);
  terminal.controlSession(task.id, 'restart-workdir', row.terminal_id);
  assert.deepEqual(open(task.id, row.terminal_id).input, [`codex resume cccccccc-9001 ${CODEX}\r`]);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('reopened and resumed Claude terminals keep the server', () => {
  terminal.setHookEndpoint(ENDPOINT);
  peerFsSettings().setEnabled(true);
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  open(task.id, row.terminal_id);
  const sessionId = boundSession(row.terminal_id);
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --session-id ${sessionId} ${SETTINGS} ${MCP}`, 'no session file yet');
  const folder = path.join(home, '.claude', 'projects', path.resolve(task.work_dir).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${sessionId}.jsonl`), jsonl([{ type: 'user', message: { content: 'hello' } }]));
  terminal.controlSession(task.id, 'restart-workdir', row.terminal_id);
  const again = open(task.id, row.terminal_id);
  assert.deepEqual(again.input, [`claude --resume ${sessionId} ${SETTINGS} ${MCP}\r`]);
  assert.ok(again.options.env.TA_MCP_CONFIG);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('with the switch off the commands and the environment have no peer server', () => {
  terminal.setHookEndpoint(ENDPOINT);
  peerFsSettings().setEnabled(false);
  try {
    const claude = terminal.createTerminal(task.id, { agent: 'claude' });
    const claudePty = open(task.id, claude.terminal_id);
    assert.deepEqual(claudePty.input, [`claude --session-id ${boundSession(claude.terminal_id)} ${SETTINGS}\r`]);
    for (const key of PEER_KEYS) assert.equal(claudePty.options.env[key], undefined, `${key} is not set`);
    assert.deepEqual(Object.keys(JSON.parse(claudePty.options.env.TA_CLAUDE_SETTINGS)), ['hooks']);
    assert.equal(terminal.reopenCommand(task.id, claude.terminal_id, task.work_dir), `claude --session-id ${boundSession(claude.terminal_id)} ${SETTINGS}`);
    const codex = terminal.createTerminal(task.id, { agent: 'codex' });
    assert.deepEqual(open(task.id, codex.terminal_id).input, ['codex\r']);
    const plain = terminal.createTerminal(task.id);
    const plainPty = open(task.id, plain.terminal_id);
    assert.deepEqual(plainPty.input, []);
    for (const key of PEER_KEYS) assert.equal(plainPty.options.env[key], undefined);
    for (const row of [claude, codex, plain]) terminal.controlSession(task.id, 'delete', row.terminal_id);
  } finally { peerFsSettings().setEnabled(true); }
});

test('the switch is read when the shell starts, so the command and the environment always agree', () => {
  terminal.setHookEndpoint(ENDPOINT);
  peerFsSettings().setEnabled(true);
  const off = terminal.createTerminal(task.id, { agent: 'claude' });
  peerFsSettings().setEnabled(false); // switched off between the create and the first shell
  const offPty = open(task.id, off.terminal_id);
  assert.ok(!offPty.input[0].includes(MCP));
  assert.equal(offPty.options.env.TA_MCP_CONFIG, undefined);
  const on = terminal.createTerminal(task.id, { agent: 'codex' });
  peerFsSettings().setEnabled(true);
  const onPty = open(task.id, on.terminal_id);
  assert.deepEqual(onPty.input, [`codex ${CODEX}\r`]);
  assert.ok(onPty.options.env.TA_PEER_MCP_COMMAND);
  for (const row of [off, on]) terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('peer variables of an outer terminal are never inherited; without a hook endpoint nothing is added', () => {
  peerFsSettings().setEnabled(true);
  const outer = { TA_PEER_URL: 'http://127.0.0.1:1/api/peer-fs', TA_PEER_TASK: '999', TA_PEER_TERMINAL: 'outer', TA_MCP_CONFIG: '{"outer":true}', TA_PEER_MCP_COMMAND: '"/outer/node"', TA_PEER_MCP_ARGS: '["/outer.js"]' };
  Object.assign(process.env, outer);
  try {
    terminal.setHookEndpoint(null);
    const bare = terminal.createTerminal(task.id, { agent: 'claude' });
    const barePty = open(task.id, bare.terminal_id);
    assert.deepEqual(barePty.input, [`claude --session-id ${boundSession(bare.terminal_id)}\r`], 'no relay to call: no server');
    for (const key of PEER_KEYS) assert.equal(barePty.options.env[key], undefined, `${key} of the outer terminal is dropped`);
    const codex = terminal.createTerminal(task.id, { agent: 'codex' });
    assert.deepEqual(open(task.id, codex.terminal_id).input, ['codex\r']);

    terminal.setHookEndpoint(ENDPOINT);
    const own = terminal.createTerminal(task.id, { agent: 'claude' });
    const ownPty = open(task.id, own.terminal_id);
    assert.equal(ownPty.options.env.TA_PEER_TERMINAL, own.terminal_id, 'this terminal\'s own values replace the outer ones');
    assert.equal(ownPty.options.env.TA_PEER_TASK, String(task.id));
    assert.equal(ownPty.options.env.TA_PEER_URL, 'http://127.0.0.1:9/api/peer-fs');
    for (const row of [bare, codex, own]) terminal.controlSession(task.id, 'delete', row.terminal_id);
  } finally {
    for (const key of Object.keys(outer)) delete process.env[key];
  }
});

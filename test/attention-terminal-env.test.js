// T-Attention in T-Agent terminals (B in DESIGN.md "T-Attention: easy listener install"): routes/terminal.js gives each new shell
// TA_ATTENTION_URL, a per-terminal TA_ATTENTION_TOKEN and TA_ATTENTION_HOOK, and ends the token when the shell closes or exits.
// node-pty is mocked; the data folder and HOME are temporary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-env-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
// Inherited values (a server started inside a T-Agent terminal) are never passed on.
process.env.TA_ATTENTION_URL = 'http://outer.invalid';
process.env.TA_ATTENTION_TOKEN = 'tatt_outer';
const db = require('../db');
const tasks = require('../services/engine-tasks');
const { createAttentionService } = require('../services/attention');
const service = createAttentionService({ db });
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
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
const task = tasks.createTask('owner', { title: 'attention env' });
const HOOK = path.resolve(__dirname, '../plugins/listeners/claude/hook.js');
const URL_HERE = 'http://127.0.0.1:4567';

function open(id) {
  terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return shells[shells.length - 1];
}

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.setHookEndpoint(null);
  terminal.setAttentionTerminals(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('without the attention provider (or the hook endpoint) a shell gets no T-Attention variables, and inherited ones are dropped', () => {
  terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id);
  const env = open(row.terminal_id).options.env;
  assert.equal(env.TA_ATTENTION_URL, undefined);
  assert.equal(env.TA_ATTENTION_TOKEN, undefined);
  assert.equal(env.TA_ATTENTION_HOOK, undefined);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('each shell gets the loopback URL, its own token and the hook path; the token ends on close, on restart and when the shell exits', async () => {
  terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');
  terminal.setAttentionTerminals({
    url: URL_HERE,
    issue: (taskId, terminalId) => service.issueTerminalToken({ taskId, terminalId }).token,
    revoke: (taskId, terminalId) => service.revokeTerminalToken({ taskId, terminalId }),
  });
  const a = terminal.createTerminal(task.id);
  const b = terminal.createTerminal(task.id);
  const envA = open(a.terminal_id).options.env;
  const envB = open(b.terminal_id).options.env;
  assert.equal(envA.TA_ATTENTION_URL, URL_HERE);
  assert.equal(envA.TA_ATTENTION_HOOK, HOOK);
  assert.match(envA.TA_ATTENTION_TOKEN, /^tatt_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(envA.TA_ATTENTION_TOKEN, envB.TA_ATTENTION_TOKEN, 'one token per terminal');
  assert.ok(service.verifyToken(envA.TA_ATTENTION_TOKEN));
  assert.equal(service.terminalTokenCount(), 2);
  assert.deepEqual(service.listTokens(), [], 'terminal tokens are not in the token list');
  assert.ok(!shells.at(-1).input.join('').includes(envB.TA_ATTENTION_TOKEN), 'the token is never typed');

  terminal.controlSession(task.id, 'close', a.terminal_id);
  assert.equal(service.verifyToken(envA.TA_ATTENTION_TOKEN), null, 'closed: the token ended');

  terminal.controlSession(task.id, 'restart-workdir', b.terminal_id);
  assert.equal(service.verifyToken(envB.TA_ATTENTION_TOKEN), null);
  const restarted = open(b.terminal_id);
  assert.ok(service.verifyToken(restarted.options.env.TA_ATTENTION_TOKEN), 'the new shell has a new token');

  // The shell exits by itself (exit typed in it).
  restarted.exit();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(service.verifyToken(restarted.options.env.TA_ATTENTION_TOKEN), null);
  assert.equal(service.terminalTokenCount(), 0);
  terminal.controlSession(task.id, 'delete', a.terminal_id);
  terminal.controlSession(task.id, 'delete', b.terminal_id);
});

test('when the terminal user is paired with another server, that config wins: only the hook path is set', () => {
  fs.writeFileSync(path.join(root, 'attention-client.json'), JSON.stringify({ url: 'https://central.example.com', token: 'tatt_central' }));
  try {
    const row = terminal.createTerminal(task.id);
    const env = open(row.terminal_id).options.env;
    assert.equal(env.TA_ATTENTION_URL, undefined);
    assert.equal(env.TA_ATTENTION_TOKEN, undefined);
    assert.equal(env.TA_ATTENTION_HOOK, HOOK);
    terminal.controlSession(task.id, 'delete', row.terminal_id);
    // Logged in to this server itself: the terminal still gets its own token.
    fs.writeFileSync(path.join(root, 'attention-client.json'), JSON.stringify({ url: `${URL_HERE}/`, token: 'tatt_here' }));
    const same = terminal.createTerminal(task.id);
    assert.equal(open(same.terminal_id).options.env.TA_ATTENTION_URL, URL_HERE);
    terminal.controlSession(task.id, 'delete', same.terminal_id);
  } finally {
    fs.rmSync(path.join(root, 'attention-client.json'), { force: true });
  }
});

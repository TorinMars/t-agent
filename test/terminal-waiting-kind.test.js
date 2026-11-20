// The two waiting kinds of an agent terminal through routes/terminal.js ("Two waiting kinds" in docs/design/terminals.md): a hook report with
// kind=select|accept (and via=tool) reaches the tracker; GET /terminal-activity (with ?kinds=1), the pushed stream, the desktop window's activity and
// the ack carry and keep it; and the Claude sessions T-Agent starts get the activity hooks of rules/claude/settings.json in TA_CLAUDE_SETTINGS
// ("Activity hooks come with the terminal"). routes/terminal.js runs for real with node-pty mocked; the data folder and HOME are temporary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-waiting-kind-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'waiting-kind-test-secret-waiting-kind-test-secret';
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });
process.env.HOME = home;

const db = require('../db');
const tasks = require('../services/engine-tasks');

const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], pid: 0, process: 'claude',
        onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
        write(text) { this.input.push(text); }, pause() {}, resume() {}, resize() {}, kill() { this.exit(); },
      };
      shells.push(pty);
      return pty;
    } };
    if (name === '../services/terminal-reaper') return { reap: async () => {}, reapSync() {} };
    return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
  },
});
const terminal = mod.exports;
terminal.setHookEndpoint('http://127.0.0.1:4567/hooks/terminal-activity');

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
}
const OWNER = 'owner';
test.after(() => {
  terminal.shutdownTerminals();
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function open(taskId, terminalId) {
  terminal.handleWs(new Socket(), { url: `/terminal/ws?taskId=${taskId}&terminalId=${terminalId}&clientId=test` }, { login: OWNER });
  const pty = shells[shells.length - 1];
  return { pty, token: pty.options.env.TA_HOOK_TOKEN };
}
const task = tasks.createTask(OWNER, { title: 'Waiting kinds' });
// The module runs in its own context: its objects are compared as plain JSON.
const plain = value => JSON.parse(JSON.stringify(value));
const activityOf = ids => plain(terminal.activitySnapshot(ids));
const kindsOf = ids => plain(terminal.waitingKindSnapshot(ids));

test('a hook report names the kind: the activity stays done for older pages, the kinds and the window\'s activity say which, the ack keeps it', () => {
  const ask = terminal.createTerminal(task.id, { agent: 'claude' });
  const plan = terminal.createTerminal(task.id, { agent: 'claude' });
  const finished = terminal.createTerminal(task.id, { agent: 'codex' });
  const a = open(task.id, ask.terminal_id);
  const p = open(task.id, plan.terminal_id);
  const f = open(task.id, finished.terminal_id);
  const report = (row, token, event, options) => terminal.reportHook(task.id, row.terminal_id, token, event, undefined, options);
  for (const [row, token] of [[ask, a.token], [plan, p.token], [finished, f.token]]) assert.equal(report(row, token, 'start'), 204);
  assert.equal(report(ask, a.token, 'attention', { kind: 'select', via: 'tool' }), 204);
  assert.equal(report(plan, p.token, 'attention', { kind: 'accept', via: 'tool' }), 204);
  assert.equal(report(finished, f.token, 'stop'), 204);
  assert.equal(report(ask, 'wrong', 'attention', { kind: 'accept' }), 403, 'the token still guards it');

  const id = String(task.id);
  assert.deepEqual(activityOf([task.id])[id], { [ask.terminal_id]: 'done', [plan.terminal_id]: 'done', [finished.terminal_id]: 'done' },
    'an older page reads every one as needs you');
  assert.deepEqual(kindsOf([task.id])[id], { [ask.terminal_id]: 'select', [plan.terminal_id]: 'accept' }, 'a finished turn has no kind');

  const live = Object.fromEntries(plain(terminal.liveTerminalActivity()).map(entry => [entry.terminal_id, entry]));
  assert.equal(live[ask.terminal_id].state, 'waiting');
  assert.equal(live[ask.terminal_id].waiting_kind, 'select');
  assert.equal(live[plan.terminal_id].waiting_kind, 'accept');
  assert.equal(live[finished.terminal_id].state, 'done');
  assert.ok(!('waiting_kind' in live[finished.terminal_id]));

  // The person opened the question: it still waits for the answer. The finished one is seen and goes idle.
  terminal.acknowledgeActivity(task.id, ask.terminal_id);
  terminal.acknowledgeActivity(task.id, finished.terminal_id);
  assert.equal(kindsOf([task.id])[id][ask.terminal_id], 'select');
  assert.equal(activityOf([task.id])[id][finished.terminal_id], undefined);

  // The answer (the tool's PostToolUse posts event=start): running again, no kind.
  assert.equal(report(ask, a.token, 'start'), 204);
  assert.equal(activityOf([task.id])[id][ask.terminal_id], 'running');
  assert.deepEqual(kindsOf([task.id])[id], { [plan.terminal_id]: 'accept' });
  // An older hook without a kind: an accept, as its prompts were permissions; an unknown kind is none.
  assert.equal(report(ask, a.token, 'attention', {}), 204);
  assert.equal(kindsOf([task.id])[id][ask.terminal_id], 'accept');
  for (const row of [ask, plan, finished]) terminal.controlSession(task.id, 'close', row.terminal_id);
  assert.deepEqual(kindsOf([task.id]), {}, 'a closed terminal waits for nothing');
});

test('the activity stream sends the kinds with the activity, and a kind change is pushed', async () => {
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const { token } = open(task.id, row.terminal_id);
  terminal.reportHook(task.id, row.terminal_id, token, 'start');
  const req = new EventEmitter();
  const res = new EventEmitter();
  const written = [];
  Object.assign(res, { setHeader() {}, flushHeaders() {}, write(text) { written.push(text); } });
  terminal.serveActivityStream(req, res, () => [task.id]);
  const last = () => {
    const messages = written.filter(text => text.startsWith('event: activity'));
    return JSON.parse(messages[messages.length - 1].split('data: ')[1]);
  };
  assert.deepEqual(last().waiting_kind, {});
  terminal.reportHook(task.id, row.terminal_id, token, 'attention', undefined, { kind: 'accept' });
  await new Promise(resolve => setTimeout(resolve, 150)); // the stream's debounce (100 ms)
  assert.deepEqual(last().waiting_kind, { [task.id]: { [row.terminal_id]: 'accept' } });
  terminal.reportHook(task.id, row.terminal_id, token, 'attention', undefined, { kind: 'select', via: 'tool' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(last().waiting_kind, { [task.id]: { [row.terminal_id]: 'select' } }, 'same state, another kind: pushed too');
  req.emit('close');
  terminal.controlSession(task.id, 'close', row.terminal_id);
});

test('a Claude session T-Agent starts gets the activity hooks of rules/claude/settings.json, so ~/.claude/settings.json need not have them', () => {
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const { pty } = open(task.id, row.terminal_id);
  const settings = JSON.parse(pty.options.env.TA_CLAUDE_SETTINGS);
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'claude', 'settings.json'), 'utf8')).hooks;
  const posts = group => group.hooks.every(hook => hook.command.includes('$TA_HOOK_URL'));
  const wanted = Object.fromEntries(Object.entries(rules).map(([event, groups]) => [event, groups.filter(posts)]).filter(([, groups]) => groups.length));
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...Object.keys(wanted), 'SessionStart'].sort());
  for (const [event, groups] of Object.entries(wanted)) assert.deepEqual(settings.hooks[event], groups, event);
  assert.ok(settings.hooks.PreToolUse.some(group => group.matcher === 'AskUserQuestion'), 'the question tool is there');
  assert.ok(!JSON.stringify(settings).includes('claude-hook.path'), 'the T-Attention listener stays the person\'s install choice');
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /claude-session-hook\.js/);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')), 'no settings file was written');
  terminal.controlSession(task.id, 'close', row.terminal_id);
});

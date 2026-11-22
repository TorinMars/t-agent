// OpenCode terminals (docs/design/opencode-terminals.md): the typed commands, the PTY environment (TA_OPENCODE_CONFIG with the plugin and the peer MCP
// server, the person's OPENCODE_CONFIG_CONTENT merged in), the binding by the plugin's session reports, the names and the resume from opencode's
// database. node-pty is mocked; the real opencode is never started and the database is a fixture in a temporary home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-opencode-terminal-')));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
for (const key of ['XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG_CONTENT', 'TA_SESSION_NAME', 'TA_OPENCODE_CONFIG']) delete process.env[key];
const Database = require('better-sqlite3');
const db = require('../db');
const peerSwitch = require('../services/peer-fs-settings').peerFsSettings();
peerSwitch.setEnabled(false);
const tasks = require('../services/engine-tasks');
const { sessionFiles } = require('../lib/agent-sessions');
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const PLUGIN = path.resolve(__dirname, '../scripts/opencode-session-plugin.js');
const PEER_SCRIPT = path.resolve(__dirname, '../scripts/peer-mcp.js');
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
  module: mod, __dirname: path.dirname(terminalPath), process, console, URL,
  setInterval, clearInterval, setTimeout, clearTimeout, Buffer,
  require(name) {
    if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
    if (name === 'node-pty') return { spawn(shell, args, options) {
      const pty = { options, input: [], killed: false, pid: 999999,
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
const task = tasks.createTask('owner', { title: 'opencode terminals' });
const workDir = fs.realpathSync(task.work_dir);
const PREFIX = 'OPENCODE_CONFIG_CONTENT="$TA_OPENCODE_CONFIG"';
const HOOK = 'http://127.0.0.1:9/hooks/terminal-activity';

function open(taskId, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${taskId}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return shells[shells.length - 1];
}
const row = id => db.prepare('SELECT agent, agent_session_id, title, title_custom FROM task_terminals WHERE terminal_id = ?').get(id);

// opencode's database, with the `session` columns of opencode 1.19.6 the listing reads.
const dbFile = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
function opencodeDb() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const handle = new Database(dbFile);
  handle.pragma('journal_mode = WAL');
  handle.exec(`CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
    title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer)`);
  return handle;
}
function addSession(id, title, { directory = workDir, parent = null, at = Date.now() } = {}) {
  const handle = opencodeDb();
  handle.prepare("INSERT OR REPLACE INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', ?, 'brave-otter', ?, ?, '1.19.6', ?, ?)")
    .run(id, parent, directory, title, at, at);
  handle.close();
  sessionFiles.clear();
}

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a new OpenCode terminal types opencode with the config prefix; the config loads the plugin and nothing else', () => {
  terminal.setHookEndpoint(HOOK);
  const created = terminal.createTerminal(task.id, { agent: 'opencode' });
  assert.equal(created.agent, 'opencode');
  assert.match(created.title, /^OpenCode \d+$/);
  assert.equal(row(created.terminal_id).agent_session_id, null, 'opencode has no id before the first prompt');
  const pty = open(task.id, created.terminal_id);
  assert.deepEqual(pty.input, [`${PREFIX} opencode\r`]);
  const env = pty.options.env;
  assert.equal(JSON.parse(env.TA_OPENCODE_CONFIG).plugin[0], `file://${PLUGIN}`);
  assert.equal(env.TA_HOOK_URL, `${HOOK}?task=${task.id}&terminal=${created.terminal_id}`);
  assert.ok(!env.TA_OPENCODE_CONFIG.includes(env.TA_HOOK_TOKEN), 'the token stays in its own variable');
  assert.equal(env.TA_SESSION_NAME, undefined, 'an unnamed terminal sets no name');
  terminal.controlSession(task.id, 'delete', created.terminal_id);
});

test('without a hook endpoint OpenCode starts plain, and an outer terminal\'s config is never passed on', () => {
  terminal.setHookEndpoint(null);
  process.env.TA_OPENCODE_CONFIG = '{"plugin":["file:///outer.js"]}';
  try {
    const created = terminal.createTerminal(task.id, { agent: 'opencode' });
    const pty = open(task.id, created.terminal_id);
    assert.deepEqual(pty.input, ['opencode\r']);
    assert.equal(pty.options.env.TA_OPENCODE_CONFIG, undefined);
    terminal.controlSession(task.id, 'delete', created.terminal_id);
  } finally { delete process.env.TA_OPENCODE_CONFIG; terminal.setHookEndpoint(HOOK); }
});

test('with peer file access on, the same config adds the t-agent-peers MCP server; the command line does not change', () => {
  terminal.setHookEndpoint(HOOK);
  peerSwitch.setEnabled(true);
  try {
    const created = terminal.createTerminal(task.id, { agent: 'opencode' });
    const pty = open(task.id, created.terminal_id);
    assert.deepEqual(pty.input, [`${PREFIX} opencode\r`]);
    const config = JSON.parse(pty.options.env.TA_OPENCODE_CONFIG);
    assert.deepEqual(config.mcp, { 't-agent-peers': { type: 'local', command: [process.execPath, PEER_SCRIPT] } });
    assert.ok(pty.options.env.TA_PEER_URL && pty.options.env.TA_PEER_TERMINAL === created.terminal_id, 'opencode passes its environment to the server');
    terminal.controlSession(task.id, 'delete', created.terminal_id);
  } finally { peerSwitch.setEnabled(false); }
});

test('the person\'s own OPENCODE_CONFIG_CONTENT is merged in, never lost; a value that is not a JSON object is left out', () => {
  terminal.setHookEndpoint(HOOK);
  peerSwitch.setEnabled(true);
  const warn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'anthropic/x', plugin: ['mine@1.0.0', `file://${PLUGIN}`], mcp: { mine: { type: 'remote', url: 'https://x' } } });
    let created = terminal.createTerminal(task.id, { agent: 'opencode' });
    let pty = open(task.id, created.terminal_id);
    const config = JSON.parse(pty.options.env.TA_OPENCODE_CONFIG);
    assert.equal(config.model, 'anthropic/x');
    assert.deepEqual(config.plugin, ['mine@1.0.0', `file://${PLUGIN}`], 'their plugins first, this plugin once');
    assert.deepEqual(Object.keys(config.mcp), ['mine', 't-agent-peers']);
    assert.equal(pty.options.env.OPENCODE_CONFIG_CONTENT, process.env.OPENCODE_CONFIG_CONTENT, 'their own variable is left as it is');
    terminal.controlSession(task.id, 'delete', created.terminal_id);

    process.env.OPENCODE_CONFIG_CONTENT = '{ not json';
    created = terminal.createTerminal(task.id, { agent: 'opencode' });
    pty = open(task.id, created.terminal_id);
    assert.deepEqual(JSON.parse(pty.options.env.TA_OPENCODE_CONFIG).plugin, [`file://${PLUGIN}`]);
    assert.ok(warnings.some(text => text.includes('OPENCODE_CONFIG_CONTENT')));
    terminal.controlSession(task.id, 'delete', created.terminal_id);
  } finally {
    console.warn = warn;
    delete process.env.OPENCODE_CONFIG_CONTENT;
    peerSwitch.setEnabled(false);
  }
});

test('the plugin\'s reports bind the terminal: startup binds, /new keeps the binding, a resumed session rebinds; bad reports change nothing', () => {
  terminal.setHookEndpoint(HOOK);
  const created = terminal.createTerminal(task.id, { agent: 'opencode' });
  const pty = open(task.id, created.terminal_id);
  const token = pty.options.env.TA_HOOK_TOKEN;
  const report = (body, extra = {}) => terminal.reportHook(task.id, extra.terminal ?? created.terminal_id, extra.token ?? token, 'session', body);
  const first = 'ses_dfb2ee326ffenXILrXxvHwj6qe';
  const fresh = 'ses_dfb2ee326fffAAAAAAAAAAAAAA';
  const picked = 'ses_dfb2ee3270000BBBBBBBBBBBBB';

  assert.equal(report({ session_id: first, source: 'startup', cwd: task.work_dir }, { token: 'f'.repeat(64) }), 403);
  assert.equal(report({ session_id: 'ses_x;rm', source: 'startup', cwd: task.work_dir }), 400);
  assert.equal(report({ session_id: first, source: 'startup', cwd: path.join(root, 'elsewhere') }), 400, 'another directory');
  assert.equal(report({ session_id: first, source: 'startup' }), 400, 'no directory');
  assert.equal(row(created.terminal_id).agent_session_id, null);

  assert.equal(report({ session_id: first, source: 'startup', cwd: task.work_dir }), 204);
  assert.equal(row(created.terminal_id).agent_session_id, first);
  assert.equal(report({ session_id: fresh, source: 'new', cwd: task.work_dir }), 204);
  assert.equal(row(created.terminal_id).agent_session_id, first, '/new keeps the terminal on its first conversation');
  assert.equal(report({ session_id: picked, source: 'resume', cwd: task.work_dir }), 204);
  assert.equal(row(created.terminal_id).agent_session_id, picked, 'a session picked with /sessions rebinds');

  const codex = terminal.createTerminal(task.id, { agent: 'codex' });
  const codexPty = open(task.id, codex.terminal_id);
  assert.equal(terminal.reportHook(task.id, codex.terminal_id, codexPty.options.env.TA_HOOK_TOKEN, 'session', { session_id: first, source: 'startup', cwd: task.work_dir }), 404, 'only Claude and OpenCode terminals report sessions');
  terminal.controlSession(task.id, 'delete', codex.terminal_id);
  terminal.controlSession(task.id, 'delete', created.terminal_id);
});

test('a terminal not bound yet takes the session of a "new" report', () => {
  terminal.setHookEndpoint(HOOK);
  const created = terminal.createTerminal(task.id, { agent: 'opencode' });
  const pty = open(task.id, created.terminal_id);
  assert.equal(terminal.reportHook(task.id, created.terminal_id, pty.options.env.TA_HOOK_TOKEN, 'session', { session_id: 'ses_dfb2ee3271111CCCCCCCCCCCCC', source: 'new', cwd: task.work_dir }), 204);
  assert.equal(row(created.terminal_id).agent_session_id, 'ses_dfb2ee3271111CCCCCCCCCCCCC');
  terminal.controlSession(task.id, 'delete', created.terminal_id);
});

test('the activity events of the plugin drive the terminal state and the waiting kinds', () => {
  terminal.setHookEndpoint(HOOK);
  const created = terminal.createTerminal(task.id, { agent: 'opencode' });
  const pty = open(task.id, created.terminal_id);
  const token = pty.options.env.TA_HOOK_TOKEN;
  const hook = (event, options) => terminal.reportHook(task.id, created.terminal_id, token, event, undefined, options);
  const state = () => terminal.activitySnapshot([task.id])[task.id][created.terminal_id];
  const kind = () => (terminal.waitingKindSnapshot([task.id])[task.id] || {})[created.terminal_id];
  assert.equal(hook('start'), 204);
  assert.equal(state(), 'running');
  assert.equal(hook('attention', { kind: 'accept' }), 204);
  assert.equal(kind(), 'accept');
  assert.equal(hook('start'), 204);
  assert.equal(kind(), undefined);
  assert.equal(hook('attention', { kind: 'select', via: 'tool' }), 204);
  assert.equal(kind(), 'select');
  assert.equal(hook('start'), 204);
  assert.equal(hook('stop'), 204);
  assert.equal(state(), 'done');
  terminal.controlSession(task.id, 'delete', created.terminal_id);
});

test('names follow the session title in opencode\'s database; a default title keeps "OpenCode N"; a reopen resumes a session that is still there', () => {
  terminal.setHookEndpoint(HOOK);
  const created = terminal.createTerminal(task.id, { agent: 'opencode' });
  const pty = open(task.id, created.terminal_id);
  const id = 'ses_dfb2ee3272222DDDDDDDDDDDDD';
  assert.equal(terminal.reportHook(task.id, created.terminal_id, pty.options.env.TA_HOOK_TOKEN, 'session', { session_id: id, source: 'startup', cwd: task.work_dir }), 204);
  const listed = () => terminal.listTerminals(task.id).find(entry => entry.terminal_id === created.terminal_id);

  assert.deepEqual([listed().agent, listed().title], ['opencode', created.title], 'no database yet');
  assert.equal(terminal.reopenCommand(task.id, created.terminal_id, task.work_dir), `${PREFIX} opencode`, 'a session that is not in the database starts fresh');

  addSession(id, 'New session - 2026-11-22T19:53:07.462Z');
  assert.equal(listed().title, created.title, 'opencode\'s default title is no name');
  assert.equal(terminal.reopenCommand(task.id, created.terminal_id, task.work_dir), `${PREFIX} opencode -s ${id}`);

  addSession(id, 'Fix the \u767b\u5f55 page');
  assert.equal(listed().title, 'Fix the \u767b\u5f55 page');
  const sessions = terminal.listAgentSessions(task, 'opencode');
  assert.deepEqual(sessions.map(entry => [entry.id, entry.title]), [[id, 'Fix the \u767b\u5f55 page']]);

  addSession('ses_dfb2ee3273333EEEEEEEEEEEEE', 'A sub-agent', { parent: id });
  addSession('ses_dfb2ee3274444FFFFFFFFFFFFF', 'Another folder', { directory: path.join(root, 'other') });
  assert.deepEqual(terminal.listAgentSessions(task, 'opencode').map(entry => entry.id), [id], 'root sessions of the task folder only');

  terminal.controlSession(task.id, 'restart-workdir', created.terminal_id);
  assert.deepEqual(open(task.id, created.terminal_id).input, [`${PREFIX} opencode -s ${id}\r`]);
  terminal.controlSession(task.id, 'delete', created.terminal_id);
});

test('a terminal made from an earlier session resumes it; a named one passes the name only through TA_SESSION_NAME', () => {
  terminal.setHookEndpoint(HOOK);
  const id = 'ses_dfb2ee3275555GGGGGGGGGGGGG';
  addSession(id, 'Earlier work');
  const resumed = terminal.createTerminal(task.id, { agent: 'opencode', session_id: id });
  assert.equal(row(resumed.terminal_id).agent_session_id, id);
  assert.deepEqual(open(task.id, resumed.terminal_id).input, [`${PREFIX} opencode -s ${id}\r`]);
  terminal.controlSession(task.id, 'delete', resumed.terminal_id);
  assert.throws(() => terminal.createTerminal(task.id, { agent: 'opencode', session_id: 'ses; rm -rf /' }), /INVALID_SESSION_ID/);

  const name = 'Named \u540d "q" $x';
  const named = terminal.createTerminal(task.id, { agent: 'opencode', title: name });
  const pty = open(task.id, named.terminal_id);
  assert.deepEqual(pty.input, [`${PREFIX} opencode\r`], 'no name option on the command line');
  assert.equal(pty.options.env.TA_SESSION_NAME, name);
  terminal.renameTerminal(task.id, named.terminal_id, 'Second name');
  assert.deepEqual(pty.input, [`${PREFIX} opencode\r`], 'nothing is typed into a running opencode');
  terminal.controlSession(task.id, 'restart-workdir', named.terminal_id);
  assert.equal(open(task.id, named.terminal_id).options.env.TA_SESSION_NAME, 'Second name', 'the next start gets the new name');
  terminal.controlSession(task.id, 'delete', named.terminal_id);
});

// The whole chain without opencode: the real plugin (imported as opencode imports it) posts to a hook endpoint that calls reportHook, as server.js does.
test('the real plugin binds a real terminal through the hook endpoint', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const status = terminal.reportHook(Number(url.searchParams.get('task')), url.searchParams.get('terminal'), req.headers['x-ta-token'], url.searchParams.get('event'),
        body ? JSON.parse(body) : undefined, { kind: url.searchParams.get('kind') || '', via: url.searchParams.get('via') || '' });
      res.statusCode = status;
      res.end();
      server.emit('reported', url.searchParams.get('event'));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    terminal.setHookEndpoint(`http://127.0.0.1:${server.address().port}/hooks/terminal-activity`);
    const created = terminal.createTerminal(task.id, { agent: 'opencode' });
    const env = open(task.id, created.terminal_id).options.env;
    const saved = { url: process.env.TA_HOOK_URL, token: process.env.TA_HOOK_TOKEN };
    process.env.TA_HOOK_URL = env.TA_HOOK_URL;
    process.env.TA_HOOK_TOKEN = env.TA_HOOK_TOKEN;
    let hooks;
    try {
      const mod = await import(pathToFileURL(PLUGIN).href);
      hooks = await mod.TAgentSessionPlugin({ client: { session: { get: async () => ({ data: null }), update: async () => ({}) } }, directory: workDir });
    } finally {
      if (saved.url === undefined) delete process.env.TA_HOOK_URL; else process.env.TA_HOOK_URL = saved.url;
      if (saved.token === undefined) delete process.env.TA_HOOK_TOKEN; else process.env.TA_HOOK_TOKEN = saved.token;
    }
    const seen = [];
    const done = new Promise(resolve => server.on('reported', event => { seen.push(event); if (seen.length === 3) resolve(); }));
    const id = 'ses_dfb2ee3276666HHHHHHHHHHHHH';
    await hooks.event({ event: { type: 'session.created', properties: { sessionID: id, info: { id, directory: workDir, title: 'New session - 2026-11-22T19:53:07.462Z' } } } });
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } } });
    await hooks.event({ event: { type: 'question.asked', properties: { sessionID: id, id: 'que_1' } } });
    await done;
    assert.deepEqual(seen, ['session', 'start', 'attention']);
    assert.equal(row(created.terminal_id).agent_session_id, id);
    assert.equal((terminal.waitingKindSnapshot([task.id])[task.id] || {})[created.terminal_id], 'select');
    terminal.controlSession(task.id, 'delete', created.terminal_id);
  } finally {
    terminal.setHookEndpoint(HOOK);
    await new Promise(resolve => server.close(resolve));
  }
});

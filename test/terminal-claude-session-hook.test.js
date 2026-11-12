// Claude terminals follow the session Claude really runs (after /clear, /resume, a fork) through a per-process
// SessionStart hook. The real claude binary is never started here: node-pty is mocked and the hook script is fed by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-session-hook-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
const db = require('../db');
// Peer file access off: these commands are the ones without the `t-agent-peers` MCP server (test/terminal-peer-mcp.test.js has those).
require('../services/peer-fs-settings').peerFsSettings().setEnabled(false);
const tasks = require('../services/engine-tasks');
const shells = [];
const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
const hookScript = path.resolve(__dirname, '../scripts/claude-session-hook.js');
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
const task = tasks.createTask('owner', { title: 'session hook' });
const other = tasks.createTask('owner', { title: 'other task' });
const claudeFolder = path.join(home, '.claude', 'projects', path.resolve(task.work_dir).replace(/[^A-Za-z0-9]/g, '-'));
const HOOK = '--settings "$TA_CLAUDE_SETTINGS"';
const sessionFile = id => path.join(claudeFolder, `${id}.jsonl`);

function open(taskId, id) {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${taskId}&terminalId=${id}&clientId=test` }, { login: 'owner' });
  return shells[shells.length - 1];
}
const boundSession = id => db.prepare('SELECT agent_session_id FROM task_terminals WHERE terminal_id = ?').get(id).agent_session_id;

test.after(() => {
  terminal.closeTaskTerminals(task.id);
  terminal.closeTaskTerminals(other.id);
  terminal.setHookEndpoint(null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a new Claude terminal starts with its session id and the per-process session hook', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  const sessionId = boundSession(row.terminal_id);
  assert.deepEqual(pty.input, [`claude --session-id ${sessionId} ${HOOK}\r`]);
  const env = pty.options.env;
  assert.equal(env.TA_HOOK_URL, `http://127.0.0.1:9/hooks/terminal-activity?task=${task.id}&terminal=${row.terminal_id}`);
  assert.match(env.TA_HOOK_TOKEN, /^[0-9a-f]{64}$/);
  const settings = JSON.parse(env.TA_CLAUDE_SETTINGS);
  assert.deepEqual(Object.keys(settings), ['hooks'], 'only adds a hook; nothing else of the person\'s settings is overridden');
  assert.deepEqual(Object.keys(settings.hooks), ['SessionStart']);
  const hook = settings.hooks.SessionStart[0].hooks[0];
  assert.equal(hook.type, 'command');
  assert.ok(hook.command.includes(`'${hookScript}'`) && hook.command.includes(`'${process.execPath}'`));
  assert.match(hook.command, />\/dev\/null 2>&1 \|\| true$/, 'prints nothing and never fails Claude');
  assert.ok(!hook.command.includes(env.TA_HOOK_TOKEN) && !pty.input.join('').includes(env.TA_HOOK_TOKEN), 'the token stays in the environment');
  terminal.controlSession(task.id, 'close', row.terminal_id);
});

const subagentFolder = id => path.join(claudeFolder, id, 'subagents');
const writeSubagent = id => {
  fs.mkdirSync(subagentFolder(id), { recursive: true });
  fs.writeFileSync(path.join(subagentFolder(id), 'agent-one.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'work' } })}\n`);
};
const subagentsOf = id => (JSON.parse(JSON.stringify(terminal.subagentSnapshot([task.id], home)))[task.id] || {})[id] || 0;

test('invalid session reports are refused and change nothing', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  const token = pty.options.env.TA_HOOK_TOKEN;
  const original = boundSession(row.terminal_id);
  const cleared = '0f0e0d0c-1111-4222-8333-444455556666';
  const report = (body, extra = {}) => terminal.reportHook(extra.task ?? task.id, extra.terminal ?? row.terminal_id, extra.token ?? token, 'session', body);

  for (const source of ['clear', 'resume']) {
    assert.equal(report({ session_id: cleared, source, cwd: task.work_dir }, { token: 'f'.repeat(64) }), 403, 'wrong token');
    assert.equal(report({ session_id: cleared, source, cwd: task.work_dir }, { token: '' }), 403, 'no token');
    assert.equal(report({ session_id: cleared, source, cwd: task.work_dir }, { task: other.id }), 403, 'token of another task');
    const second = terminal.createTerminal(task.id, { agent: 'claude' });
    assert.equal(report({ session_id: cleared, source, cwd: task.work_dir }, { terminal: second.terminal_id }), 403, 'token of another terminal');
    terminal.controlSession(task.id, 'delete', second.terminal_id);
    assert.equal(report({ session_id: '../../etc', source, cwd: task.work_dir }), 400, 'malformed session id');
    assert.equal(report({ session_id: 42, source, cwd: task.work_dir }), 400, 'not a string');
    assert.equal(report(undefined), 400, 'no body');
    assert.equal(report({ session_id: cleared, source, cwd: other.work_dir }), 400, 'a session of another directory');
    assert.equal(report({ session_id: cleared, source }), 400, 'no directory');
  }
  assert.equal(boundSession(row.terminal_id), original, 'nothing rejected changed the binding');
  // A rejected report does not change the live session either: the sub-agent count still reads the original one.
  writeSubagent(cleared);
  assert.equal(subagentsOf(row.terminal_id), 0);
  fs.rmSync(path.join(claudeFolder, cleared), { recursive: true, force: true });
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('/clear keeps the binding: a new shell resumes the original conversation', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  const token = pty.options.env.TA_HOOK_TOKEN;
  const original = boundSession(row.terminal_id);
  const cleared = '0f0e0d0c-1111-4222-8333-444455556667';
  const clearedAgain = '0f0e0d0c-1111-4222-8333-444455556668';
  const report = body => terminal.reportHook(task.id, row.terminal_id, token, 'session', body);
  fs.mkdirSync(claudeFolder, { recursive: true });
  fs.writeFileSync(sessionFile(original), `${JSON.stringify({ type: 'user', message: { content: 'original prompt' } })}\n`);

  assert.equal(report({ session_id: original, source: 'startup', cwd: task.work_dir }), 204, 'startup reports the same id');
  assert.equal(boundSession(row.terminal_id), original);
  assert.equal(report({ session_id: cleared, source: 'clear', cwd: task.work_dir }), 204);
  assert.equal(boundSession(row.terminal_id), original, '/clear does not move the terminal to the new session');
  fs.writeFileSync(sessionFile(cleared), `${JSON.stringify({ type: 'user', message: { content: 'after clear' } })}\n`);
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --resume ${original} ${HOOK}`);
  assert.equal(terminal.listTerminals(task.id).find(item => item.terminal_id === row.terminal_id).title, 'original prompt', 'the name follows the bound session');

  // The sub-agent count follows the session the live shell really runs.
  writeSubagent(cleared);
  assert.equal(subagentsOf(row.terminal_id), 1, 'sub-agents of the cleared session are counted while its shell lives');
  // A second /clear: the binding is still the original; the live id is the newest.
  assert.equal(report({ session_id: clearedAgain, source: 'clear', cwd: task.work_dir }), 204);
  assert.equal(boundSession(row.terminal_id), original);
  assert.equal(subagentsOf(row.terminal_id), 0, 'the first cleared session is no longer the running one');
  writeSubagent(clearedAgain);
  assert.equal(subagentsOf(row.terminal_id), 1);

  // A restart drops the live id: the new shell resumes the original, and the count reads the original again.
  terminal.controlSession(task.id, 'restart-workdir', row.terminal_id);
  assert.deepEqual(open(task.id, row.terminal_id).input, [`claude --resume ${original} ${HOOK}\r`]);
  assert.equal(subagentsOf(row.terminal_id), 0, 'the cleared sessions are not counted after the shell ended');
  writeSubagent(original);
  assert.equal(subagentsOf(row.terminal_id), 1, 'the original session is counted');
  for (const id of [original, cleared, clearedAgain]) fs.rmSync(path.join(claudeFolder, id), { recursive: true, force: true });
  terminal.controlSession(task.id, 'close', row.terminal_id);
  assert.equal(subagentsOf(row.terminal_id), 0, 'a closed shell has no sub-agents');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('/resume and startup still rebind the terminal; reopening then resumes that session', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  const token = pty.options.env.TA_HOOK_TOKEN;
  const original = boundSession(row.terminal_id);
  const picked = '0f0e0d0c-1111-4222-8333-444455556669';
  const started = '0f0e0d0c-1111-4222-8333-44445555666a';
  const report = body => terminal.reportHook(task.id, row.terminal_id, token, 'session', body);

  // A /clear and then /resume of another conversation: the binding moves to the picked one.
  assert.equal(report({ session_id: '0f0e0d0c-1111-4222-8333-44445555666b', source: 'clear', cwd: task.work_dir }), 204);
  assert.equal(boundSession(row.terminal_id), original);
  assert.equal(report({ session_id: picked, source: 'resume', cwd: task.work_dir }), 204);
  assert.equal(boundSession(row.terminal_id), picked, '/resume moves the terminal to the picked session');
  // The picked session has no message yet (no file): a new shell starts that id again instead of the old conversation.
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --session-id ${picked} ${HOOK}`);
  fs.mkdirSync(claudeFolder, { recursive: true });
  fs.writeFileSync(sessionFile(picked), `${JSON.stringify({ type: 'user', message: { content: 'picked conversation' } })}\n`);
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --resume ${picked} ${HOOK}`);
  assert.equal(terminal.listTerminals(task.id).find(item => item.terminal_id === row.terminal_id).title, 'picked conversation', 'the sidebar title follows');
  writeSubagent(picked);
  assert.equal(subagentsOf(row.terminal_id), 1);

  // A fresh start (source startup, e.g. Claude started again by hand in the same shell) rebinds too; compact keeps the id.
  assert.equal(report({ session_id: started, source: 'startup', cwd: task.work_dir }), 204);
  assert.equal(boundSession(row.terminal_id), started);
  assert.equal(subagentsOf(row.terminal_id), 0);
  assert.equal(report({ session_id: started, source: 'compact', cwd: task.work_dir }), 204);
  assert.equal(boundSession(row.terminal_id), started);

  // After a restart of the shell the new PTY types the command of the bound session.
  terminal.controlSession(task.id, 'restart-workdir', row.terminal_id);
  assert.deepEqual(open(task.id, row.terminal_id).input, [`claude --session-id ${started} ${HOOK}\r`]);
  fs.rmSync(path.join(claudeFolder, picked), { recursive: true, force: true });
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('only Claude terminals take a session report', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const plain = terminal.createTerminal(task.id);
  const pty = open(task.id, plain.terminal_id);
  assert.deepEqual(pty.input, [], 'a plain shell types nothing');
  assert.equal(terminal.reportHook(task.id, plain.terminal_id, pty.options.env.TA_HOOK_TOKEN, 'session', { session_id: '0f0e0d0c-1111-4222-8333-444455556666', cwd: task.work_dir }), 404);
  const codex = terminal.createTerminal(task.id, { agent: 'codex' });
  const codexPty = open(task.id, codex.terminal_id);
  assert.deepEqual(codexPty.input, ['codex\r'], 'Codex gets no --settings');
  assert.equal(terminal.reportHook(task.id, codex.terminal_id, codexPty.options.env.TA_HOOK_TOKEN, 'session', { session_id: '0f0e0d0c-1111-4222-8333-444455556666', cwd: task.work_dir }), 404);
  terminal.controlSession(task.id, 'delete', plain.terminal_id);
  terminal.controlSession(task.id, 'delete', codex.terminal_id);
});

test('without a hook endpoint the commands stay as before', () => {
  terminal.setHookEndpoint(null);
  // A server started from inside a t-agent terminal has that terminal's hook variables; they are not passed on.
  Object.assign(process.env, { TA_HOOK_URL: 'http://127.0.0.1:1/outer', TA_HOOK_TOKEN: 'outer-token', TA_CLAUDE_SETTINGS: '{"outer":true}' });
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  assert.deepEqual(pty.input, [`claude --session-id ${boundSession(row.terminal_id)}\r`]);
  assert.equal(pty.options.env.TA_CLAUDE_SETTINGS, undefined);
  assert.equal(pty.options.env.TA_HOOK_URL, undefined);
  assert.equal(pty.options.env.TA_HOOK_TOKEN, undefined);
  for (const key of ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_CLAUDE_SETTINGS']) delete process.env[key];
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --session-id ${boundSession(row.terminal_id)}`);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

// Names given in T-Agent reach Claude as its session display name (`--name`), through the PTY environment only.
const NAME = '--name "$TA_SESSION_NAME"';

test('a Claude terminal named at creation starts Claude with --name; the name itself is only in the environment', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  // Quotes, $, backticks and a newline: the shell would read them in a typed line. The name is user content in any script.
  const typedName = 'Fix "login" $HOME `id` \'x\'\n\u767b\u5f55 \u{1F600}';
  const row = terminal.createTerminal(task.id, { agent: 'claude', title: typedName });
  const pty = open(task.id, row.terminal_id);
  const sessionId = boundSession(row.terminal_id);
  assert.deepEqual(pty.input, [`claude --session-id ${sessionId} ${NAME} ${HOOK}\r`], '--name comes before --settings');
  const stored = 'Fix "login" $HOME `id` \'x\' \u767b\u5f55 \u{1F600}'; // a terminal name has no control characters: the newline became a space
  assert.equal(row.title, stored);
  assert.equal(pty.options.env.TA_SESSION_NAME, stored, 'the exact stored name');
  assert.ok(!pty.input[0].includes('login') && !pty.input[0].includes('`'), 'nothing of the name is typed');
  // A real shell gives Claude the exact name as one argument and runs nothing from it (claude is replaced by a program that prints its arguments).
  const printArgs = `'${process.execPath}' -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`;
  for (const shell of ['/bin/sh', '/bin/zsh', '/bin/bash'].filter(candidate => fs.existsSync(candidate))) {
    const out = spawnSync(shell, ['-c', pty.input[0].replace(/\r$/, '').replace(/^claude/, printArgs)], { env: { PATH: process.env.PATH, ...pty.options.env }, encoding: 'utf8' });
    assert.equal(out.status, 0, `${shell}: ${out.stderr}`);
    const args = JSON.parse(out.stdout);
    assert.deepEqual(args.slice(0, 4), ['--session-id', sessionId, '--name', stored], shell);
    assert.equal(args[4], '--settings');
  }

  // Claude writes the name to the session file as its custom-title (checked against Claude Code 2.1.322); the listing shows it unchanged.
  fs.mkdirSync(claudeFolder, { recursive: true });
  fs.writeFileSync(sessionFile(sessionId), [{ type: 'custom-title', customTitle: stored, sessionId }, { type: 'user', message: { content: 'hello' } }].map(item => JSON.stringify(item)).join('\n') + '\n');
  assert.equal(terminal.listTerminals(task.id).find(item => item.terminal_id === row.terminal_id).title, stored);
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('a Claude terminal without a name gets no --name and no TA_SESSION_NAME, also when the server has an outer one', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  process.env.TA_SESSION_NAME = 'outer terminal name';
  try {
    const row = terminal.createTerminal(task.id, { agent: 'claude' });
    const pty = open(task.id, row.terminal_id);
    assert.deepEqual(pty.input, [`claude --session-id ${boundSession(row.terminal_id)} ${HOOK}\r`]);
    assert.equal(pty.options.env.TA_SESSION_NAME, undefined, 'the outer terminal\'s name is not passed on');
    assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --session-id ${boundSession(row.terminal_id)} ${HOOK}`);
    terminal.controlSession(task.id, 'delete', row.terminal_id);
    // A named terminal gets its own name, not the outer one.
    const named = terminal.createTerminal(task.id, { agent: 'claude', title: 'Inner' });
    assert.equal(open(task.id, named.terminal_id).options.env.TA_SESSION_NAME, 'Inner');
    terminal.controlSession(task.id, 'delete', named.terminal_id);
  } finally { delete process.env.TA_SESSION_NAME; }
});

test('a rename in T-Agent reaches Claude at the next start: reopen and resume pass the new name', () => {
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const row = terminal.createTerminal(task.id, { agent: 'claude' });
  const pty = open(task.id, row.terminal_id);
  const sessionId = boundSession(row.terminal_id);
  assert.deepEqual(pty.input, [`claude --session-id ${sessionId} ${HOOK}\r`], 'not named yet');
  const renamed = 'Renamed \u91cd\u547d\u540d "q" $x';
  terminal.renameTerminal(task.id, row.terminal_id, renamed);
  assert.deepEqual(pty.input, [`claude --session-id ${sessionId} ${HOOK}\r`], 'nothing is typed into the running session');

  // No session file yet: the same id starts again, now with the name.
  assert.equal(terminal.reopenCommand(task.id, row.terminal_id, task.work_dir), `claude --session-id ${sessionId} ${NAME} ${HOOK}`);
  terminal.controlSession(task.id, 'restart-workdir', row.terminal_id);
  const second = open(task.id, row.terminal_id);
  assert.deepEqual(second.input, [`claude --session-id ${sessionId} ${NAME} ${HOOK}\r`]);
  assert.equal(second.options.env.TA_SESSION_NAME, renamed);

  // With a session file the terminal resumes it under the newest name.
  fs.mkdirSync(claudeFolder, { recursive: true });
  fs.writeFileSync(sessionFile(sessionId), `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
  terminal.renameTerminal(task.id, row.terminal_id, 'Second name');
  terminal.controlSession(task.id, 'restart-workdir', row.terminal_id);
  const third = open(task.id, row.terminal_id);
  assert.deepEqual(third.input, [`claude --resume ${sessionId} ${NAME} ${HOOK}\r`]);
  assert.equal(third.options.env.TA_SESSION_NAME, 'Second name');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
});

test('without a hook endpoint a named Claude terminal still gets --name; Codex and plain shells never do', () => {
  terminal.setHookEndpoint(null);
  const row = terminal.createTerminal(task.id, { agent: 'claude', title: 'No hook' });
  const pty = open(task.id, row.terminal_id);
  assert.deepEqual(pty.input, [`claude --session-id ${boundSession(row.terminal_id)} ${NAME}\r`]);
  assert.equal(pty.options.env.TA_SESSION_NAME, 'No hook');
  terminal.controlSession(task.id, 'delete', row.terminal_id);
  terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
  const codex = terminal.createTerminal(task.id, { agent: 'codex', title: 'Named Codex' });
  const codexPty = open(task.id, codex.terminal_id);
  assert.deepEqual(codexPty.input, ['codex\r'], 'Codex has no start-time name option');
  assert.equal(codexPty.options.env.TA_SESSION_NAME, undefined);
  const plain = terminal.createTerminal(task.id, { title: 'Named shell' });
  const plainPty = open(task.id, plain.terminal_id);
  assert.deepEqual(plainPty.input, []);
  assert.equal(plainPty.options.env.TA_SESSION_NAME, undefined);
  terminal.controlSession(task.id, 'delete', codex.terminal_id);
  terminal.controlSession(task.id, 'delete', plain.terminal_id);
});

function runHook(env, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [hookScript], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    const started = Date.now();
    child.on('close', code => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

test('the hook script posts the session with the token header, prints nothing and exits 0', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ url: req.url, token: req.headers['x-ta-token'], type: req.headers['content-type'], body: JSON.parse(body) }); res.statusCode = 204; res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hooks/terminal-activity?task=3&terminal=abc`;
  const input = JSON.stringify({ session_id: 'aaaaaaaa-bbbb', source: 'clear', cwd: '/work', transcript_path: '/x.jsonl', hook_event_name: 'SessionStart' });
  const result = await runHook({ TA_HOOK_URL: url, TA_HOOK_TOKEN: 'secret-token' }, input);
  server.close();
  assert.deepEqual(result, { code: 0, out: '', ms: result.ms });
  assert.deepEqual(seen, [{ url: '/hooks/terminal-activity?task=3&terminal=abc&event=session', token: 'secret-token', type: 'application/json', body: { session_id: 'aaaaaaaa-bbbb', source: 'clear', cwd: '/work' } }]);
});

test('the hook script does nothing outside a t-agent terminal and never fails', async () => {
  const input = JSON.stringify({ session_id: 'aaaaaaaa-bbbb', source: 'startup', cwd: '/work' });
  assert.deepEqual(await runHook({}, input).then(r => [r.code, r.out]), [0, '']);
  assert.deepEqual(await runHook({ TA_HOOK_URL: 'http://127.0.0.1:9/hooks/terminal-activity?task=1&terminal=a', TA_HOOK_TOKEN: 't' }, 'not json').then(r => [r.code, r.out]), [0, '']);
  const refused = await runHook({ TA_HOOK_URL: 'http://127.0.0.1:9/hooks/terminal-activity?task=1&terminal=a', TA_HOOK_TOKEN: 't' }, input);
  assert.deepEqual([refused.code, refused.out], [0, ''], 'the server is not reachable');
  assert.ok(refused.ms < 2500);
});

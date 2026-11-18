// A foreground job that ignores SIGHUP (Codex does, and keeps its session lock) must not outlive a closed terminal or the server.
// Real node-pty shells through routes/terminal.js; the data folder and HOME are temporary, and the job is a plain `node -e`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;
const { EventEmitter } = require('node:events');

const skip = process.platform === 'win32' ? 'POSIX terminals only' : false;
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 't-agent-reaper-wiring-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, '.zshrc'), ''); // no startup wizard, no user rc files
process.env.HOME = home;
process.env.ZDOTDIR = home;
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');

const db = skip ? null : require('../db');
const tasks = skip ? null : require('../test-support/older-tasks').olderTasks(require('../services/engine-tasks'), db);
const terminal = skip ? null : require('../routes/terminal');
const task = skip ? null : tasks.createTask('owner', { title: 'reaper wiring' });
const strays = new Set();

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  bufferedAmount = 0;
  send(data) { this.sent.push(data); }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
  text() { return this.sent.map(item => { try { return JSON.parse(item).data || ''; } catch { return String(item); } }).join(''); }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
// A zombie counts as gone: it has ended and only waits for its parent.
function alive(pid) {
  try { return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
}
// A node job that ignores SIGHUP and SIGTERM, like Codex ignores SIGHUP. The marker is split in the typed text, so the echo never matches.
const stubborn = marker => `${JSON.stringify(process.execPath)} -e "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});`
  + `console.log('${marker.slice(0, 2)}'+'${marker.slice(2)}:'+process.pid);setInterval(()=>{},1000)"`;

async function openShell(id = 'default') {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=reaper` }, { login: 'owner' });
  assert.equal(ws.readyState, 1, 'terminal did not open');
  return ws;
}
let jobCount = 0;
// The runs of the reaper's process table (`ps -axo pid=,ppid=,pgid=,tpgid=`) among the calls of a spy on child_process.execFile / spawnSync.
const tableRuns = spy => spy.mock.calls.filter(call => call.arguments[0] === 'ps' && String(call.arguments[1]).includes('pid=,ppid=,pgid=,tpgid=')).length;
async function startJobs(ws) {
  const pidFile = path.join(root, `bg-${Date.now()}-${jobCount += 1}.pid`);
  // A background job of the same shell: it is not the foreground group, so it must survive. Node resets the SIGHUP that nohup ignores,
  // so the job ignores it itself; it keeps the default SIGTERM, so a SIGTERM sent to the wrong group would end it and fail the test.
  ws.emit('message', `nohup ${JSON.stringify(process.execPath)} -e "process.on('SIGHUP',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" ${JSON.stringify(pidFile)} >/dev/null 2>&1 &\r`);
  ws.emit('message', `${stubborn('REAPPID')}\r`);
  const background = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 10000, 'the background job'));
  strays.add(background);
  const foreground = Number(await until(() => (ws.text().match(/REAPPID:(\d+)/) || [])[1], 10000, 'the foreground job'));
  strays.add(foreground);
  assert.ok(alive(foreground) && alive(background));
  return { foreground, background };
}

test.after(() => {
  if (skip) return;
  try { terminal.closeTaskTerminals(task.id); } catch {}
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  db.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }); // the shells may still write their history
});

test('closing a terminal ends its foreground job but leaves background jobs alone', { skip, timeout: 30000 }, async t => {
  const ws = await openShell();
  const { foreground, background } = await startJobs(ws);
  const blocking = t.mock.method(childProcess, 'spawnSync');
  const inBackground = t.mock.method(childProcess, 'execFile');
  terminal.controlSession(task.id, 'close', 'default');
  assert.equal(blocking.mock.callCount(), 0, 'the close does not block the server on the process table (before: one spawnSync of ps)');
  assert.deepEqual(terminal.liveTerminalIds(task.id), [], 'the terminal has no shell from this moment');
  assert.equal(ws.code, 1000, 'and its socket is closed at once');
  await until(() => !alive(foreground), 8000, 'the foreground job to end after close');
  assert.equal(tableRuns(inBackground), 1);
  assert.equal(alive(background), true, 'a background job must survive the close');
});

test('closing a task with several terminals reads one process table, in the background, and ends every foreground job', { skip, timeout: 60000 }, async t => {
  const ids = ['default', terminal.createTerminal(task.id).terminal_id, terminal.createTerminal(task.id).terminal_id];
  const jobs = [];
  for (const id of ids) jobs.push(await startJobs(await openShell(id)));
  assert.equal(terminal.liveTerminalIds(task.id).length, 3);
  const blocking = t.mock.method(childProcess, 'spawnSync');
  const inBackground = t.mock.method(childProcess, 'execFile');
  terminal.closeTaskTerminals(task.id);
  assert.deepEqual(terminal.liveTerminalIds(task.id), [], 'every terminal is without a shell at once');
  assert.equal(blocking.mock.callCount(), 0, 'nothing blocks (before: three spawnSync of ps, one per terminal)');
  for (const job of jobs) await until(() => !alive(job.foreground), 8000, 'every foreground job to end after the task was closed');
  assert.equal(tableRuns(inBackground), 1, 'one table for the three terminals');
  for (const job of jobs) assert.equal(alive(job.background), true, 'the background jobs survive');
  for (const id of ids.slice(1)) terminal.controlSession(task.id, 'delete', id);
});

test('shutdownTerminals ends every foreground job synchronously and is idempotent', { skip, timeout: 30000 }, async () => {
  const ws = await openShell();
  const { foreground, background } = await startJobs(ws);
  const started = Date.now();
  terminal.shutdownTerminals();
  assert.ok(Date.now() - started < 3000, 'shutdownTerminals must finish within its short grace period');
  // SIGKILL has been sent when it returns; allow a moment for the kernel to end the process.
  await until(() => !alive(foreground), 2000, 'the foreground job to end after shutdownTerminals');
  assert.equal(alive(background), true, 'a background job must survive the shutdown');
  assert.doesNotThrow(() => terminal.shutdownTerminals());
});

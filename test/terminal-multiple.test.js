const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-multiple-'));
process.env.T_AGENT_DATA_DIR = root;
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const db = require('../db');
const tasks = require('../services/engine-tasks');
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
        write(text) { this.input.push(text); }, pause() { this.paused = true; }, resume() { this.paused = false; this.resumes = (this.resumes || 0) + 1; }, resize(cols, rows) { this.size = [cols, rows]; },
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
  bufferedAmount = 0;
  send(data) { this.sent.push(data); }
  async waitFor(count) {
    for (let i = 0; this.sent.length < count && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(this.sent.length >= count, 'timed out waiting for terminal output');
  }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close'); }
}
const task = tasks.createTask('owner', { title: 'multiple' });
function connect(id, owner = 'owner', extra = '') {
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=test${extra}` }, { login: owner });
  return ws;
}
test.after(() => {
  terminal.closeTaskTerminals(task.id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('independent shells preserve histories across switching; control only affects the selected terminal', async () => {
  const added = terminal.createTerminal(task.id);
  const first = connect('default');
  const second = connect(added.terminal_id);
  assert.equal(shells.length, 2);
  assert.equal(first.readyState, 1);
  assert.equal(shells[1].options.cwd, task.work_dir);
  first.emit('message', 'first command');
  second.emit('message', 'second command');
  assert.deepEqual(shells.map(s => s.input), [['first command'], ['second command']]);
  await Promise.all([first.waitFor(1), second.waitFor(1)]);
  first.sent.length = 0; second.sent.length = 0;
  shells[0].data('FIRST HISTORY');
  shells[1].data('SECOND HISTORY');
  await Promise.all([first.waitFor(1), second.waitFor(1)]);
  assert.deepEqual(first.sent, ['FIRST HISTORY']);
  assert.deepEqual(second.sent, ['SECOND HISTORY']);
  second.close(1000, 'switch');
  assert.equal(shells[1].killed, false);
  const reconnected = connect(added.terminal_id);
  assert.equal(shells.length, 2);
  await reconnected.waitFor(1);
  assert.match(JSON.parse(reconnected.sent[0]).data, /SECOND HISTORY/);
  terminal.controlSession(task.id, 'restart-workdir', added.terminal_id);
  assert.equal(shells[0].killed, false);
  assert.equal(shells[1].killed, true);
  const restarted = connect(added.terminal_id);
  assert.equal(shells.length, 3);
  await restarted.waitFor(1);
  assert.doesNotMatch(JSON.parse(restarted.sent[0]).data, /SECOND HISTORY/);
  shells[1].data('late output from old shell');
  restarted.close(1000, 'switch');
  const empty = connect(added.terminal_id);
  await empty.waitFor(1);
  assert.doesNotMatch(JSON.parse(empty.sent[0]).data, /SECOND HISTORY/);
  assert.equal(first.readyState, 1);
  terminal.controlSession(task.id, 'close', added.terminal_id);
  shells[0].data(' STILL RUNNING');
  await first.waitFor(2);
  assert.equal(first.sent.at(-1), ' STILL RUNNING');
  terminal.controlSession(task.id, 'close');
});

test('terminal IDs cannot address other tasks or bypass ownership', () => {
  const other = tasks.createTask('owner', { title: 'other' });
  const foreign = terminal.createTerminal(other.id);
  assert.throws(() => terminal.controlSession(task.id, 'close', foreign.terminal_id), /TERMINAL_NOT_FOUND/);
  assert.throws(() => terminal.assertTerminal(task.id, '../escape'), /INVALID_TERMINAL_ID/);
  const count = shells.length;
  assert.equal(connect(foreign.terminal_id).code, 1008);
  assert.equal(connect('default', 'stranger').code, 1008);
  assert.equal(shells.length, count);
  assert.equal(terminal.listTerminals(task.id).length, 2);
});

test('deleting an extra terminal stops its shell and permanently removes its history and tab', () => {
  const added = terminal.createTerminal(task.id);
  const ws = connect(added.terminal_id);
  const shell = shells.at(-1);
  shell.data('history to delete');
  terminal.controlSession(task.id, 'delete', added.terminal_id);
  assert.equal(shell.killed, true);
  assert.equal(ws.readyState, 3);
  assert.equal(db.prepare('SELECT * FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, added.terminal_id), undefined);
  shell.data('late output');
  shell.exit();
  assert.equal(terminal.listTerminals(task.id).some(row => row.terminal_id === added.terminal_id), false);
  assert.equal(connect(added.terminal_id).code, 1008);
  const closed = terminal.createTerminal(task.id);
  terminal.controlSession(task.id, 'close', closed.terminal_id);
  terminal.controlSession(task.id, 'delete', closed.terminal_id);
  assert.throws(() => terminal.assertTerminal(task.id, closed.terminal_id), /TERMINAL_NOT_FOUND/);
});

test('history controls are scoped, bounded and never passed to PTY; snapshot precedes live bytes', async () => {
  const added = terminal.createTerminal(task.id);
  const seed = connect(added.terminal_id);
  const shell = shells.at(-1);
  const oldText = Array.from({ length: 2000 }, (_, i) => `old-${i}\r\n`).join('');
  await seed.waitFor(1);
  shell.data(oldText);
  await until(() => seed.sent.slice(1).join('').length >= oldText.length, 'old output delivered');
  seed.close(1000, 'seed done');
  const ws = connect(added.terminal_id);
  shell.data('LIVE-A'); shell.data('LIVE-B');
  await ws.waitFor(2);
  const history = JSON.parse(ws.sent[0]);
  assert.equal(history.type, 'history');
  assert.doesNotMatch(history.data, /LIVE-|old-100\r/);
  await until(() => ws.sent.slice(1).join('').length >= 12, 'live output delivered');
  assert.equal(ws.sent.slice(1).join(''), 'LIVE-ALIVE-B', 'live chunks may be merged but keep their order');
  const request = { type: 'history-page', ...history.archive, requestId: 'r' };
  ws.emit('message', JSON.stringify(request));
  const page = JSON.parse(ws.sent.at(-1));
  assert.match(page.data, /old-1999/);
  assert.doesNotMatch(page.data, /LIVE-/);
  assert.ok(page.data.split('\n').filter(Boolean).length <= 500);
  ws.emit('message', JSON.stringify({ ...request, id: 'foreign' }));
  assert.equal(JSON.parse(ws.sent.at(-1)).error, 'INVALID_HISTORY_REQUEST');
  ws.emit('message', '{"type":"history-page",broken');
  ws.emit('message', JSON.stringify({ type: 'history-future' }));
  assert.deepEqual(shell.input, []);
  const next = connect(added.terminal_id);
  await next.waitFor(1);
  const before = next.sent.length;
  ws.emit('message', JSON.stringify(request));
  assert.equal(next.sent.length, before);
  next.emit('message', JSON.stringify(request));
  assert.equal(JSON.parse(next.sent.at(-1)).error, 'INVALID_HISTORY_REQUEST');
  db.prepare('UPDATE tasks SET user_id = ? WHERE id = ?').run('other-owner', task.id);
  await new Promise(resolve => setTimeout(resolve, 1100)); // access checks are cached for about 1 s
  next.emit('message', JSON.stringify(request));
  assert.equal(next.code, 1008);
  assert.deepEqual(shell.input, []);
  db.prepare('UPDATE tasks SET user_id = ? WHERE id = ?').run('owner', task.id);
  terminal.controlSession(task.id, 'delete', added.terminal_id);
});

test('proto=2: controls are binary frames, text that looks like a control message is plain input, ping is answered', async () => {
  const added = terminal.createTerminal(task.id);
  const ws = connect(added.terminal_id, 'owner', '&proto=2');
  const shell = shells.at(-1);
  await ws.waitFor(1);
  assert.ok(Buffer.isBuffer(ws.sent[0]), 'the snapshot is a binary frame');
  assert.equal(JSON.parse(ws.sent[0].toString()).type, 'history');
  const resize = '{"type":"resize","cols":10,"rows":5}';
  ws.emit('message', Buffer.from(resize), false);
  assert.equal(shell.size, undefined);
  assert.deepEqual(shell.input, [resize], 'a text frame is input even when it parses as a resize');
  ws.emit('message', Buffer.from(resize.replace('10', '11')), true);
  assert.deepEqual(shell.size, [11, 5]);
  ws.emit('message', Buffer.from('{"type":"history-page","id":"x"}'), false);
  assert.equal(shell.input.length, 2);
  ws.emit('message', Buffer.from('{"type":"ping"}'), true);
  assert.deepEqual(JSON.parse(ws.sent.at(-1).toString()), { type: 'pong' });
  assert.equal(shell.input.length, 2);
  // The old protocol (no proto=2) is unchanged: text controls, text snapshot, ping is not a control message.
  const old = connect(added.terminal_id, 'owner', '');
  await old.waitFor(1);
  assert.equal(typeof old.sent[0], 'string');
  old.emit('message', '{"type":"resize","cols":20,"rows":6}');
  assert.deepEqual(shell.size, [20, 6]);
  terminal.controlSession(task.id, 'delete', added.terminal_id);
});

test('natural PTY exit drains final live bytes and snapshot before closing', async () => {
  const added = terminal.createTerminal(task.id);
  const ws = connect(added.terminal_id);
  const shell = shells.at(-1);
  shell.data('last-line');
  shell.exit();
  await ws.waitFor(2);
  for (let i = 0; ws.readyState === 1 && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(JSON.parse(ws.sent[0]).type, 'history');
  assert.equal(ws.sent[1], 'last-line');
  assert.equal(ws.reason, 'terminal exited');
  terminal.controlSession(task.id, 'delete', added.terminal_id);
});

test('terminal history is kept in memory only: a reconnect replays it, a new shell after close or restart starts empty', async () => {
  const other = tasks.createTask('owner', { title: 'memory only' });
  const open = () => {
    const ws = new Socket();
    terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default&clientId=mem` }, { login: 'owner' });
    return ws;
  };
  const before = shells.length;
  const first = open();
  await first.waitFor(1);
  shells.at(-1).data('tui output\x1b[?1003h\x1b[?1006h');
  await first.waitFor(2);
  first.close(1000, 'switch');
  const again = open();
  await again.waitFor(1);
  assert.equal(shells.length, before + 1, 'a reconnect keeps the shell');
  assert.match(JSON.parse(again.sent[0]).data, /tui output/, 'a reconnect replays from memory');
  // Nothing was written to the database: the table and the column no longer exist.
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'terminal_logs'").get(), undefined);
  assert.equal(db.prepare('PRAGMA table_info(task_terminals)').all().some(column => column.name === 'buffer'), false);
  again.close(1000, 'bye');
  terminal.controlSession(other.id, 'close');
  const fresh = open();
  await fresh.waitFor(1);
  assert.equal(shells.length, before + 2, 'a new shell is started');
  assert.doesNotMatch(JSON.parse(fresh.sent[0]).data, /tui output/);
  terminal.closeTaskTerminals(other.id);
});

test('a second client is refused until it takes over; the same client replaces its own socket', async () => {
  const other = tasks.createTask('owner', { title: 'single owner' });
  const open = query => {
    const ws = new Socket();
    terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default${query}` }, { login: 'owner' });
    return ws;
  };
  const before = shells.length;
  const pc = open('&clientId=pc');
  await pc.waitFor(1);
  assert.equal(shells.length, before + 1);

  const phone = open('&clientId=phone');
  assert.equal(phone.code, 4009, 'a different client is told the terminal is in use');
  assert.equal(pc.readyState, 1, 'the owner stays connected');
  assert.deepEqual(phone.sent, [], 'a refused client receives no terminal output');
  phone.emit('message', 'ignored');
  assert.deepEqual(shells[before].input, [], 'a refused client cannot type');

  const reload = open('&clientId=pc');
  assert.equal(pc.code, 1000, 'the same client replaces its old socket');
  assert.equal(reload.readyState, 1);

  const taken = open('&clientId=phone&takeover=1');
  assert.equal(reload.code, 4010, 'the previous owner is told it was taken over');
  await taken.waitFor(1);
  taken.emit('message', 'phone command');
  assert.deepEqual(shells[before].input, ['phone command']);
  assert.equal(shells.length, before + 1, 'taking over keeps the same shell');

  taken.close(1000, 'bye');
  const again = open('&clientId=pc');
  assert.equal(again.readyState, 1, 'a free terminal can be opened without taking over');
  terminal.closeTaskTerminals(other.id);
});

test('desktop and phone list and create the same terminals', () => {
  const other = tasks.createTask('owner', { title: 'shared list' });
  const added = terminal.createTerminal(other.id);
  assert.doesNotMatch(added.terminal_id, /^h5-/);
  assert.deepEqual(Array.from(terminal.listTerminals(other.id), row => row.terminal_id), ['default', added.terminal_id]);
});

test('the default terminal can be deleted: it stops, is no longer listed or connectable, and other terminals are untouched', () => {
  const own = tasks.createTask('owner', { title: 'default delete' });
  const other = terminal.createTerminal(own.id);
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${own.id}&terminalId=default&clientId=test` }, { login: 'owner' });
  const shell = shells.at(-1);
  shell.data('default history');
  terminal.controlSession(own.id, 'delete', 'default');
  assert.equal(shell.killed, true);
  assert.equal(ws.readyState, 3);
  assert.equal(terminal.listTerminals(own.id).map(row => row.terminal_id).join(), other.terminal_id);
  assert.throws(() => terminal.assertTerminal(own.id, 'default'), /TERMINAL_NOT_FOUND/);
  const refused = new Socket();
  terminal.handleWs(refused, { url: `/terminal/ws?taskId=${own.id}&terminalId=default&clientId=test` }, { login: 'owner' });
  assert.equal(refused.code, 1008);
  terminal.controlSession(own.id, 'delete', other.terminal_id);
  assert.equal(terminal.listTerminals(own.id).length, 0, 'a task may have no terminal at all');
  assert.equal(terminal.createTerminal(own.id).title, 'Terminal 1');
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; !check() && i < 200; i++) await sleep(10);
  assert.ok(check(), label);
}

test('the PTY is paused while the socket is backed up and resumed once it drains', async () => {
  const other = tasks.createTask('owner', { title: 'flow control' });
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default&clientId=flow` }, { login: 'owner' });
  const shell = shells.at(-1);
  await ws.waitFor(1);
  ws.bufferedAmount = 4 * 1024 * 1024;
  shell.data('first');
  await until(() => shell.paused === true, 'paused above the high watermark');
  await sleep(60);
  assert.equal(shell.paused, true, 'stays paused while the backlog is high');
  ws.bufferedAmount = 0;
  await until(() => shell.paused === false, 'resumed below the low watermark');
  ws.sent.length = 0;
  shell.data('second');
  await ws.waitFor(1);
  assert.equal(ws.sent[0], 'second');
  terminal.closeTaskTerminals(other.id);
});

test('a socket that closes while the PTY is paused never leaves the PTY paused', async () => {
  const other = tasks.createTask('owner', { title: 'flow close' });
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default&clientId=flow` }, { login: 'owner' });
  const shell = shells.at(-1);
  await ws.waitFor(1);
  ws.bufferedAmount = 4 * 1024 * 1024;
  shell.data('x');
  await until(() => shell.paused === true, 'paused');
  ws.close(1006, 'gone');
  await until(() => shell.paused === false, 'resumed after the socket closed');
  terminal.closeTaskTerminals(other.id);
});

test('a burst of chunks is parsed in bounded batches, in order, and delivered intact', async () => {
  const other = tasks.createTask('owner', { title: 'batching' });
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default&clientId=batch` }, { login: 'owner' });
  const shell = shells.at(-1);
  await ws.waitFor(1);
  ws.sent.length = 0;
  const parts = Array.from({ length: 2000 }, (_, i) => `line-${i}\r\n`);
  for (const part of parts) shell.data(part);
  await until(() => ws.sent.join('').length >= parts.join('').length, 'all output delivered');
  assert.equal(ws.sent.join(''), parts.join(''));
  assert.ok(ws.sent.length < parts.length, 'chunks were merged before parsing');
  terminal.closeTaskTerminals(other.id);
});

test('the in-memory history keeps the end of a very long output', async () => {
  const other = tasks.createTask('owner', { title: 'history limit' });
  const open = () => {
    const ws = new Socket();
    terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default&clientId=limit` }, { login: 'owner' });
    return ws;
  };
  const ws = open();
  const shell = shells.at(-1);
  await ws.waitFor(1);
  let total = 0;
  for (let i = 0; i < 70; i++) {
    const chunk = `${i}`.padStart(4, '0') + ' ' + 'y'.repeat(100 * 1024 - 5) + '\r\n';
    total += chunk.length;
    shell.data(chunk);
  }
  await until(() => ws.sent.slice(1).join('').length >= total, 'all output delivered');
  ws.close(1000, 'switch');
  const again = open();
  await again.waitFor(1);
  const replay = JSON.parse(again.sent[0]);
  assert.match(replay.data, /0069 y/, 'the newest output is replayed');
  assert.doesNotMatch(replay.data, /0000 y/);
  terminal.closeTaskTerminals(other.id);
});

test('access is rechecked about once a second, not per chunk, and revoking it still closes the socket', async () => {
  const other = tasks.createTask('owner', { title: 'auth cache' });
  const ws = new Socket();
  terminal.handleWs(ws, { url: `/terminal/ws?taskId=${other.id}&terminalId=default&clientId=auth` }, { login: 'owner' });
  const shell = shells.at(-1);
  await ws.waitFor(1);
  const realPrepare = db.prepare.bind(db);
  let lookups = 0;
  db.prepare = sql => { if (/FROM tasks WHERE id = \? AND user_id/.test(sql)) lookups += 1; return realPrepare(sql); };
  try {
    for (let i = 0; i < 20; i++) { shell.data(`chunk ${i}\r\n`); await sleep(2); }
    await ws.waitFor(2);
    assert.ok(lookups <= 2, `expected a cached check, saw ${lookups} lookups`);
    db.prepare = realPrepare;
    db.prepare('UPDATE tasks SET user_id = ? WHERE id = ?').run('someone-else', other.id);
    await sleep(1100);
    shell.data('after revoke');
    await until(() => ws.readyState !== 1, 'socket closed after access was revoked');
    assert.equal(ws.code, 1008);
  } finally {
    db.prepare = realPrepare;
    db.prepare('UPDATE tasks SET user_id = ? WHERE id = ?').run('owner', other.id);
    terminal.closeTaskTerminals(other.id);
  }
});

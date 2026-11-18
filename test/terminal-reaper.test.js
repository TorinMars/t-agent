// The terminal reaper: finds the foreground process group of each terminal and terminates it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const childProcess = require('node:child_process');
const { foregroundGroups, readProcessTable, readProcessTableAsync, reapSync, reap } = require('../services/terminal-reaper');

const row = (pid, ppid, pgid, tpgid) => `${pid} ${ppid} ${pgid} ${tpgid}`;
const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

// A fake kill(): groups in `alive` answer probes until they get one of `dieOn`.
function fakeKill(alive, dieOn = {}) {
  const calls = [];
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    const group = -pid;
    if (!alive.has(group)) throw esrch();
    if ((dieOn[group] || []).includes(sig) || sig === 'SIGKILL') alive.delete(group);
  };
  return { kill, calls };
}

test('foregroundGroups returns nothing while the shell itself is in the foreground', () => {
  assert.deepEqual(foregroundGroups([100], row(100, 1, 100, 100)), []);
});

test('foregroundGroups returns the group of the agent running in the foreground', () => {
  const ps = [row(100, 1, 100, 200), row(200, 100, 200, 200), row(201, 200, 200, 200)].join('\n');
  assert.deepEqual(foregroundGroups([100], ps), [200]);
});

test('foregroundGroups leaves background jobs alone', () => {
  // 300 is a background job of shell 100 (its own group, not the tty foreground group).
  const ps = [row(100, 1, 100, 100), row(300, 100, 300, 100)].join('\n');
  assert.deepEqual(foregroundGroups([100], ps), []);
  const busy = [row(100, 1, 100, 200), row(200, 100, 200, 200), row(300, 100, 300, 200)].join('\n');
  assert.deepEqual(foregroundGroups([100], busy), [200]);
});

test('foregroundGroups skips shells missing from the table and removes duplicates', () => {
  const ps = [row(100, 1, 100, 200), row(101, 1, 101, 200)].join('\n');
  assert.deepEqual(foregroundGroups([100, 101, 555], ps), [200]);
  assert.deepEqual(foregroundGroups([], ps), []);
});

test('foregroundGroups never returns the server group or a group <= 1', () => {
  const own = 4242;
  const ps = [
    row(process.pid, 1, own, 0),
    row(100, process.pid, 100, own),
    row(101, process.pid, 101, 1),
    row(102, process.pid, 102, 0),
    row(103, process.pid, 103, -1),
  ].join('\n');
  assert.deepEqual(foregroundGroups([100, 101, 102, 103], ps), []);
});

test('foregroundGroups ignores malformed lines', () => {
  const ps = ['', 'garbage', '100 1 100', '100 1 abc 200', '  100   1   100   200  ', '1 2 3 4 5'].join('\n');
  assert.deepEqual(foregroundGroups([100], ps), [200]);
  assert.deepEqual(foregroundGroups([100], null), []);
});

test('reapSync sends SIGTERM first and SIGKILL only to groups that stay alive', () => {
  const ps = [row(100, 1, 100, 200), row(101, 1, 101, 300), row(102, 1, 102, 400)].join('\n');
  // 200 exits on SIGTERM, 300 ignores it, 400 is already gone.
  const { kill, calls } = fakeKill(new Set([200, 300]), { 200: ['SIGTERM'] });
  let slept = 0;
  const result = reapSync([100, 101, 102], { graceMs: 120, kill, table: () => ps, sleep: () => { slept += 1; } });
  assert.deepEqual(result, { groups: [200, 300, 400], killed: [300] });
  assert.deepEqual(calls.slice(0, 3), [[-200, 'SIGTERM'], [-300, 'SIGTERM'], [-400, 'SIGTERM']]);
  assert.deepEqual(calls[calls.length - 1], [-300, 'SIGKILL']);
  assert.ok(calls.some(([pid, sig]) => pid === -300 && sig === 0));
  assert.ok(!calls.some(([pid, sig]) => pid === -200 && sig === 'SIGKILL'));
  assert.ok(slept > 0);
});

test('reapSync stops waiting once every group is gone', () => {
  const ps = row(100, 1, 100, 200);
  const { kill, calls } = fakeKill(new Set([200]), { 200: ['SIGTERM'] });
  let slept = 0;
  const result = reapSync([100], { graceMs: 10000, kill, table: () => ps, sleep: () => { slept += 1; } });
  assert.deepEqual(result, { groups: [200], killed: [] });
  assert.deepEqual(calls, [[-200, 'SIGTERM'], [-200, 0]]);
  assert.equal(slept, 1);
});

test('reapSync ignores EPERM and does nothing without shells or a table', () => {
  const eperm = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
  assert.deepEqual(reapSync([100], { kill: eperm, table: () => row(100, 1, 100, 200), sleep() {} }), { groups: [200], killed: [] });
  const never = () => assert.fail('must not run');
  assert.deepEqual(reapSync([], { kill: never, table: never }), { groups: [], killed: [] });
  assert.deepEqual(reapSync([100], { kill: never, table: () => null }), { groups: [], killed: [] });
  assert.deepEqual(reapSync([100], { kill: never, table: () => { throw new Error('ps failed'); } }), { groups: [], killed: [] });
});

test('reap sends SIGTERM now and SIGKILL after the grace period to groups still alive', async () => {
  const keep = setTimeout(() => {}, 5000); // the reaper's own timer is unref'd
  try {
    const ps = [row(100, 1, 100, 200), row(101, 1, 101, 300)].join('\n');
    const { kill, calls } = fakeKill(new Set([200, 300]), { 200: ['SIGTERM'] });
    const pending = reap([100, 101], { graceMs: 30, kill, table: () => ps });
    assert.deepEqual(calls, [[-200, 'SIGTERM'], [-300, 'SIGTERM']]);
    const result = await pending;
    assert.deepEqual(result, { groups: [200, 300], killed: [300] });
    assert.deepEqual(calls[calls.length - 1], [-300, 'SIGKILL']);
  } finally {
    clearTimeout(keep);
  }
});

test('reap resolves at once when nothing needs reaping and never rejects', async () => {
  const never = () => assert.fail('must not run');
  assert.deepEqual(await reap([], { kill: never, table: never }), { groups: [], killed: [] });
  assert.deepEqual(await reap([100], { kill: never, table: () => null }), { groups: [], killed: [] });
  const gone = () => { throw esrch(); };
  assert.deepEqual(await reap([100], { kill: gone, table: () => row(100, 1, 100, 200) }), { groups: [200], killed: [] });
});

test('reap reads the table without blocking: nothing is signalled before it arrives, and the shells may be killed only after the SIGTERMs', async () => {
  const keep = setTimeout(() => {}, 5000);
  try {
    const ps = [row(100, 1, 100, 200), row(101, 1, 101, 300)].join('\n');
    const { kill, calls } = fakeKill(new Set([200, 300]), { 200: ['SIGTERM'] });
    const order = [];
    let deliver;
    let tables = 0;
    const table = () => { tables += 1; return new Promise(resolve => { deliver = resolve; }); };
    const pending = reap([100, 101], { graceMs: 30, kill, table, signalled: () => order.push(`signalled after ${calls.length} signals`) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [], 'the table has not arrived: no signal yet');
    assert.deepEqual(order, [], 'and the caller must not kill the shells yet (their rows name the foreground groups)');
    deliver(ps);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [[-200, 'SIGTERM'], [-300, 'SIGTERM']]);
    assert.deepEqual(order, ['signalled after 2 signals'], 'told once, right after the SIGTERMs and before the grace period');
    assert.deepEqual(await pending, { groups: [200, 300], killed: [300] });
    assert.deepEqual(order, ['signalled after 2 signals']);
    assert.equal(tables, 1, 'one table for both shells');
  } finally {
    clearTimeout(keep);
  }
});

test('reap reads one table for any number of shells', async () => {
  let tables = 0;
  const shells = Array.from({ length: 12 }, (_, index) => 100 + index);
  const ps = shells.map(pid => row(pid, 1, pid, pid + 1000)).join('\n');
  const { kill, calls } = fakeKill(new Set(), {});
  const result = await reap(shells, { kill, table: async () => { tables += 1; return ps; } });
  assert.equal(tables, 1, 'before: one table per terminal when a task was closed');
  assert.deepEqual(result.groups, shells.map(pid => pid + 1000));
  assert.equal(calls.length, 12);
});

test('reap always tells the caller, also with no process id, no table, a failing table or a failing callback', async () => {
  const never = () => assert.fail('must not run');
  const told = [];
  const tell = name => () => told.push(name);
  // Shells without a process id (not started, a stand-in): no table is read and the caller is told before reap() returns.
  const none = reap([undefined, null, 0, -5, 'x'], { kill: never, table: never, signalled: tell('no pid') });
  assert.deepEqual(told, ['no pid']);
  assert.deepEqual(await none, { groups: [], killed: [] });
  const empty = reap([], { kill: never, table: never, signalled: tell('empty') });
  assert.deepEqual(told, ['no pid', 'empty']);
  await empty;
  assert.deepEqual(await reap([100], { kill: never, table: async () => null, signalled: tell('no table') }), { groups: [], killed: [] });
  assert.deepEqual(await reap([100], { kill: never, table: () => Promise.reject(new Error('ps failed')), signalled: tell('rejected') }), { groups: [], killed: [] });
  assert.deepEqual(await reap([100], { kill: never, table: () => { throw new Error('ps failed'); }, signalled: tell('thrown') }), { groups: [], killed: [] });
  assert.deepEqual(told, ['no pid', 'empty', 'no table', 'rejected', 'thrown']);
  const gone = () => { throw esrch(); };
  assert.deepEqual(await reap(['100'], { kill: gone, table: () => row(100, 1, 100, 200), signalled: () => { throw new Error('callback failed'); } }), { groups: [200], killed: [] });
});

test('reap by default reads the table in the background and never with spawnSync', { skip: process.platform === 'win32' }, async t => {
  const sync = t.mock.method(childProcess, 'spawnSync');
  const background = t.mock.method(childProcess, 'execFile');
  let told = 0;
  // The shell is this process: its row is there, and its foreground group is its own or the server's, so nothing is signalled.
  const pending = reap([process.pid], { kill: () => assert.fail('nothing to signal'), signalled: () => { told += 1; } });
  assert.equal(told, 0, 'reap() returned before the table was read');
  assert.deepEqual(await pending, { groups: [], killed: [] });
  assert.equal(told, 1);
  assert.equal(sync.mock.callCount(), 0, 'the event loop was never blocked (before: spawnSync with a 1.5 s limit)');
  assert.equal(background.mock.callCount(), 1);
  assert.deepEqual(background.mock.calls[0].arguments.slice(0, 2), ['ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=']]);
});

test('readProcessTableAsync gives the same table as readProcessTable', { skip: process.platform === 'win32' }, async () => {
  const text = await readProcessTableAsync();
  assert.equal(typeof text, 'string');
  const mine = text.split('\n').map(l => l.trim().split(/\s+/).map(Number)).find(cols => cols[0] === process.pid);
  assert.ok(mine, 'the table has a row for this process');
  assert.equal(mine.length, 4);
  assert.equal(mine[1], process.ppid);
});

test('readProcessTable lists the current process', { skip: process.platform === 'win32' }, () => {
  const text = readProcessTable();
  assert.equal(typeof text, 'string');
  const mine = text.split('\n').map(l => l.trim().split(/\s+/).map(Number)).find(cols => cols[0] === process.pid);
  assert.ok(mine, 'the table has a row for this process');
  assert.equal(mine.length, 4);
  assert.equal(mine[1], process.ppid);
});

// Starts a real process in its own group. A detached `sh` starts it in the background and exits, so the
// process is reparented to init, which reaps it at once (a zombie child of the test would still answer
// kill(-pgid, 0)). Resolves with the group id once the process has installed its handlers.
function startGroup(t, script) {
  return new Promise((resolve, reject) => {
    const sh = spawn('/bin/sh', ['-c', '"$0" -e "$1" </dev/null 2>/dev/null &', process.execPath, script], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const group = sh.pid;
    t.after(() => {
      try { process.kill(-group, 'SIGKILL'); } catch {}
      sh.stdout.destroy();
    });
    let out = '';
    sh.on('error', reject);
    sh.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('ready')) resolve(group);
    });
    setTimeout(() => reject(new Error('the test process did not start')), 5000).unref();
  });
}

const groupAlive = group => { try { process.kill(-group, 0); return true; } catch { return false; } };

async function waitGone(group) {
  for (let i = 0; i < 100 && groupAlive(group); i += 1) await new Promise(r => setTimeout(r, 20));
  return !groupAlive(group);
}

test('reapSync kills a real foreground group that ignores SIGHUP and SIGTERM', { skip: process.platform === 'win32' }, async t => {
  const stubborn = await startGroup(t, "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')");
  const polite = await startGroup(t, "setInterval(()=>{},1000);console.log('ready')");
  const fakeShell = 999990;
  const ps = [row(fakeShell, 1, fakeShell, stubborn), row(fakeShell + 1, 1, fakeShell + 1, polite)].join('\n');
  const result = reapSync([fakeShell, fakeShell + 1], { graceMs: 400, table: () => ps });
  assert.deepEqual(result.groups, [stubborn, polite]);
  assert.deepEqual(result.killed, [stubborn]);
  assert.ok(await waitGone(stubborn), 'the stubborn group is gone');
  assert.ok(await waitGone(polite), 'the polite group is gone');
});

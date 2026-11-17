// The terminal reaper: finds the foreground process group of each terminal and terminates it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { foregroundGroups, readProcessTable, reapSync, reap } = require('../services/terminal-reaper');

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

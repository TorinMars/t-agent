// The shared poll clock of the terminals (lib/terminal-poll.js) and what it costs: one timer for every tracker and shell watch, one read of
// pty.process per terminal per tick, one process table per tick (macOS), four times fewer ticks while nobody watches, and no /proc reads
// where /proc does not exist. Everything runs on a mocked clock; `ps` and /proc are stand-ins, so the counts are the same on every system.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { createPollClock, sharedClock, POLL_MS, UNWATCHED_POLL_MS } = require('../lib/terminal-poll');
const { createActivityTracker } = require('../lib/terminal-activity');
const { watchShellReturn } = require('../lib/terminal-input-modes');

test.beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 }));
test.afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

// Time moves one poll at a time, so every tick sees its own Date.now().
const advance = (ms, step = 100) => { for (let passed = 0; passed < ms; passed += step) mock.timers.tick(step); };

// A PTY stand-in that counts how often its foreground process is asked for.
function fakePty(name, extra = {}) {
  const pty = { reads: 0, name, ...extra };
  Object.defineProperty(pty, 'process', { get() { pty.reads += 1; return pty.name; } });
  return pty;
}

// lib/terminal-activity.js as a server without /proc that reads the process table with ps (macOS), with `ps` replaced by a counter.
function activityOnMac(t) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const exists = fs.existsSync;
  const asked = [];
  mock.method(fs, 'existsSync', file => { if (String(file).startsWith('/proc')) { asked.push(file); return false; } return exists(file); });
  const procReads = [];
  const read = fs.readFileSync;
  mock.method(fs, 'readFileSync', (file, ...rest) => { if (String(file).startsWith('/proc')) procReads.push(file); return read(file, ...rest); });
  const tables = [];
  mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    tables.push([file, ...args]);
    callback(null, 'ttys001 10 10 node /opt/bin/codex\nttys002 20 20 -zsh\n');
  });
  const file = require.resolve('../lib/terminal-activity');
  const cached = require.cache[file];
  delete require.cache[file];
  const activity = require(file); // a new copy: /proc is decided once per process
  require.cache[file] = cached;
  return { activity, tables, asked, procReads };
}

test('the shared clock polls every 500 ms and every 2 s while nobody watches', () => {
  assert.equal(POLL_MS, 500);
  assert.equal(UNWATCHED_POLL_MS, 2000);
  assert.equal(sharedClock.period(), 0, 'no terminal: no timer');
});

test('one timer serves the tracker and the shell watch of every terminal, and pty.process is read once per terminal per tick', () => {
  let timers = 0;
  const mocked = globalThis.setInterval;
  globalThis.setInterval = (...args) => { timers += 1; return mocked(...args); };
  try {
    const clock = createPollClock({ fastMs: 500, slowMs: 2000 });
    assert.equal(clock.period(), 0);
    const ptys = [fakePty('zsh'), fakePty('zsh'), fakePty('zsh')];
    let returns = 0;
    const stops = ptys.flatMap(pty => [
      createActivityTracker(pty, '/bin/zsh', () => {}, { clock }).stop,
      watchShellReturn(pty, '/bin/zsh', () => { returns += 1; }, clock),
    ]);
    assert.equal(clock.size(), 6);
    assert.equal(timers, 1, 'six watchers, one timer (before: one each)');
    advance(5000);
    assert.deepEqual(ptys.map(pty => pty.reads), [10, 10, 10], 'ten ticks: one read per terminal per tick (before: two)');

    // Both watchers still see what they need from the one read.
    ptys[0].name = 'make';
    advance(1000);
    ptys[0].name = 'zsh';
    advance(500);
    assert.equal(returns, 1, 'the shell watch saw the program return to the shell');

    for (const stop of stops) stop();
    for (const stop of stops) stop(); // ending twice is harmless
    assert.equal(clock.period(), 0, 'no watcher left: the timer is gone');
    const before = ptys.map(pty => pty.reads);
    advance(3000);
    assert.deepEqual(ptys.map(pty => pty.reads), before);
    assert.equal(timers, 1);
  } finally { globalThis.setInterval = mocked; }
});

test('the process table is read once per tick for all terminals: 120 a minute while watched, 30 while not, fast again at once', t => {
  const { activity, tables } = activityOnMac(t);
  let watching = true;
  const clock = createPollClock({ fastMs: POLL_MS, slowMs: UNWATCHED_POLL_MS });
  clock.watchedBy(() => watching);
  const ptys = [1, 2, 3, 4].map(n => fakePty(n === 1 ? 'node' : 'zsh', { ptsName: `/dev/ttys00${n}` }));
  const trackers = ptys.map(pty => activity.createActivityTracker(pty, '/bin/zsh', () => {}, { clock }));
  const stops = ptys.map(pty => watchShellReturn(pty, '/bin/zsh', () => {}, clock));
  try {
    assert.equal(clock.period(), 500);
    advance(60000);
    assert.equal(tables.length, 120, 'watched: one table per 500 ms tick, whatever the number of terminals');
    assert.deepEqual(tables[0], ['ps', '-axo', 'tty=,pgid=,tpgid=,command=']);
    assert.deepEqual(ptys.map(pty => pty.reads), [120, 120, 120, 120]);

    // Nobody watches any more: the clock notices at its next tick, without being told.
    watching = false;
    advance(500);
    assert.equal(clock.period(), 2000);
    tables.length = 0;
    for (const pty of ptys) pty.reads = 0;
    advance(60000);
    assert.equal(tables.length, 30, 'not watched: one table per 2 s tick');
    assert.deepEqual(ptys.map(pty => pty.reads), [30, 30, 30, 30]);

    // The first watcher brings the full speed back at once (routes/terminal.js calls wake()).
    watching = true;
    clock.wake();
    assert.equal(clock.period(), 500);
    tables.length = 0;
    advance(2000);
    assert.equal(tables.length, 4);

    // The table still does its job: a node-based agent is recognised by its argv.
    assert.deepEqual(activity.foregroundCommand(ptys[0]), ['node', 'codex', 'node']);
  } finally {
    for (const tracker of trackers) tracker.stop();
    for (const stop of stops) stop();
  }
});

test('/proc is asked once and never read where it does not exist', t => {
  const { activity, asked, procReads } = activityOnMac(t);
  const clock = createPollClock({ fastMs: 500 });
  const trackers = [fakePty('zsh'), fakePty('zsh'), fakePty('zsh')].map(pty => activity.createActivityTracker(pty, '/bin/zsh', () => {}, { clock }));
  try {
    advance(10000);
    assert.deepEqual(asked, ['/proc/self/stat'], 'decided at the first poll, for the whole process');
    assert.deepEqual(procReads, [], '60 polls: no read that can only fail (before: two per poll)');
  } finally { for (const tracker of trackers) tracker.stop(); }
});

test('where /proc exists the foreground group and its argv are still read from it', () => {
  const exists = fs.existsSync;
  mock.method(fs, 'existsSync', file => (file === '/proc/self/stat' ? true : exists(file)));
  const read = fs.readFileSync;
  mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === '/proc/4321/stat') return '4321 (zsh) S 1 4321 4321 34816 9876 4194304 0 0';
    if (file === '/proc/9876/cmdline') return 'node\0/usr/local/bin/claude\0--resume\0';
    return read(file, ...rest);
  });
  const file = require.resolve('../lib/terminal-activity');
  const cached = require.cache[file];
  delete require.cache[file];
  const { foregroundCommand } = require(file);
  require.cache[file] = cached;
  assert.deepEqual(foregroundCommand({ pid: 4321, process: 'node' }), ['node', 'claude', 'node']);
});

test('a short burst of output between two slow polls still makes a hookless agent running, then done', () => {
  const clock = createPollClock({ fastMs: 500, slowMs: 2000 });
  clock.watchedBy(() => false);
  const pty = fakePty('gemini');
  const seen = [];
  const tracker = createActivityTracker(pty, '/bin/zsh', state => seen.push(state), { clock });
  try {
    assert.equal(clock.period(), 2000);
    for (let chunk = 0; chunk < 4; chunk += 1) { advance(100); tracker.noteOutput(); } // 100 .. 400 ms: over before the poll at 2000 ms
    advance(1500);
    assert.equal(tracker.state(), 'idle', 'no poll yet');
    advance(100);
    assert.equal(tracker.state(), 'running', 'the poll at 2 s still knows about the burst (its chunks are older than burstMs by then)');
    advance(2000);
    assert.equal(tracker.state(), 'done', 'quiet for more than quietMs');
    assert.deepEqual(seen, ['running', 'done']);
    // A hook event starts a new count: output from before it is not a burst after it.
    for (let chunk = 0; chunk < 4; chunk += 1) { advance(100); tracker.noteOutput(); }
    tracker.report('stop');
    advance(2000);
    assert.equal(tracker.state(), 'done');
  } finally { tracker.stop(); }
});

test('a batch job and its end are still seen by the slow clock, only later', () => {
  const clock = createPollClock({ fastMs: 500, slowMs: 2000 });
  clock.watchedBy(() => false);
  const pty = fakePty('zsh');
  const tracker = createActivityTracker(pty, '/bin/zsh', () => {}, { clock });
  try {
    pty.name = 'make';
    advance(2000);
    assert.equal(tracker.state(), 'idle', 'one poll is not enough (minBusyPolls)');
    advance(2000);
    assert.equal(tracker.state(), 'running');
    pty.name = 'zsh';
    advance(2000);
    assert.equal(tracker.state(), 'done');
  } finally { tracker.stop(); }
});

test('clock rules: no probe means fast, a failing probe means fast, any probe saying yes means fast, a failing poll does not stop the others', () => {
  const clock = createPollClock({ fastMs: 500, slowMs: 2000 });
  let ran = 0;
  const stopBad = clock.subscribe(() => { throw new Error('poll failed'); });
  const stopGood = clock.subscribe(() => { ran += 1; });
  assert.equal(clock.period(), 500, 'no probe: always fast');
  assert.throws(() => mock.timers.tick(500), /poll failed/, 'the error is not hidden');
  assert.equal(ran, 1, 'the other subscriber was still polled');
  stopBad();

  const answers = { a: false, b: false };
  const dropA = clock.watchedBy(() => answers.a);
  clock.watchedBy(() => answers.b);
  assert.equal(clock.period(), 2000);
  answers.b = true;
  clock.wake();
  assert.equal(clock.period(), 500);
  answers.b = false;
  clock.wake();
  assert.equal(clock.period(), 2000);
  dropA();
  clock.watchedBy(() => { throw new Error('probe failed'); });
  assert.equal(clock.period(), 500, 'a probe that fails must not slow the terminals down');

  // Outside a tick pty.process is read on every call.
  const pty = fakePty('zsh');
  clock.processOf(pty);
  clock.processOf(pty);
  assert.equal(pty.reads, 2);
  stopGood();
  assert.equal(clock.period(), 0);
});

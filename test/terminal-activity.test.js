const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityTracker, parsePs } = require('../lib/terminal-activity');

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('running while a non-shell process owns the foreground, done after it returns, idle after ack', async () => {
  const pty = { process: 'bash' };
  const seen = [];
  const tracker = createActivityTracker(pty, '/bin/bash', state => seen.push(state), 10);
  try {
    pty.process = 'make';
    await tick(60);
    assert.equal(tracker.state(), 'running');
    await tick(80); // silent for a long time: still running
    assert.equal(tracker.state(), 'running');
    pty.process = 'bash';
    await tick(40);
    assert.equal(tracker.state(), 'done');
    tracker.acknowledge();
    assert.deepEqual(seen, ['running', 'done', 'idle']);
  } finally { tracker.stop(); }
});

test('instant commands do not flash running', async () => {
  const pty = { process: 'bash' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, 20);
  try {
    pty.process = 'ls';
    await tick(25);
    pty.process = 'bash';
    await tick(80);
    assert.equal(tracker.state(), 'idle');
  } finally { tracker.stop(); }
});

test('acknowledge is ignored while running', async () => {
  const pty = { process: 'sleep' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, 10);
  try {
    await tick(60);
    tracker.acknowledge();
    assert.equal(tracker.state(), 'running');
  } finally { tracker.stop(); }
});

const FAST = { pollMs: 10, burstMs: 200, quietMs: 80, echoMs: 20 };

test('agent in the foreground: running while it streams output, done once it goes quiet', async () => {
  const pty = { process: 'claude' };
  const seen = [];
  const tracker = createActivityTracker(pty, '/bin/bash', state => seen.push(state), FAST);
  try {
    await tick(60);
    assert.equal(tracker.state(), 'idle'); // foreground alone does not mean working
    const spinner = setInterval(() => tracker.noteOutput(), 10);
    await tick(100);
    assert.equal(tracker.state(), 'running');
    clearInterval(spinner);
    await tick(200); // waiting for the user
    assert.equal(tracker.state(), 'done');
    tracker.acknowledge();
    assert.deepEqual(seen, ['running', 'done', 'idle']);
  } finally { tracker.stop(); }
});

test('typing echo and resize redraws do not make an agent look busy', async () => {
  const pty = { process: 'codex' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, { ...FAST, echoMs: 30 });
  try {
    for (let i = 0; i < 10; i++) {
      tracker.noteInput();
      tracker.noteOutput();
      await tick(10);
    }
    assert.equal(tracker.state(), 'idle');
  } finally { tracker.stop(); }
});

test('agent starts working again after a done acknowledgement', async () => {
  const pty = { process: 'claude' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, FAST);
  try {
    for (let round = 0; round < 2; round++) {
      const spinner = setInterval(() => tracker.noteOutput(), 10);
      await tick(100);
      clearInterval(spinner);
      assert.equal(tracker.state(), 'running');
      await tick(200);
      assert.equal(tracker.state(), 'done');
      tracker.acknowledge();
    }
  } finally { tracker.stop(); }
});

const HOOKED = { pollMs: 10, burstMs: 200, quietMs: 40, echoMs: 20, staleMs: 120 };

test('hook events drive the state, and output cadence no longer does once hooked', async () => {
  const pty = { process: 'claude' };
  const seen = [];
  const tracker = createActivityTracker(pty, '/bin/bash', state => seen.push(state), HOOKED);
  try {
    assert.equal(tracker.report('start'), true);
    assert.equal(tracker.state(), 'running');
    const keepAlive = setInterval(() => tracker.noteOutput(), 10);
    await tick(100);
    clearInterval(keepAlive);
    await tick(60); // quiet for longer than quietMs, but under staleMs: still running
    assert.equal(tracker.state(), 'running');
    tracker.report('stop');
    assert.equal(tracker.state(), 'done');
    const chatter = setInterval(() => tracker.noteOutput(), 10);
    await tick(100); // status-bar redraws after Stop must not restart it
    clearInterval(chatter);
    assert.equal(tracker.state(), 'done');
    tracker.acknowledge();
    assert.deepEqual(seen, ['running', 'done', 'idle']);
  } finally { tracker.stop(); }
});

test('hooked agent that was interrupted (no Stop hook) finishes after staleMs of silence', async () => {
  const pty = { process: 'codex' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, HOOKED);
  try {
    tracker.report('start');
    await tick(60);
    assert.equal(tracker.state(), 'running');
    await tick(150);
    assert.equal(tracker.state(), 'done');
  } finally { tracker.stop(); }
});

test('permission prompt reports done, and resumes running once the agent works again', async () => {
  const pty = { process: 'claude' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, HOOKED);
  try {
    tracker.report('start');
    tracker.report('attention');
    assert.equal(tracker.state(), 'done');
    const spinner = setInterval(() => tracker.noteOutput(), 10);
    await tick(100);
    clearInterval(spinner);
    assert.equal(tracker.state(), 'running');
    tracker.report('stop');
    assert.equal(tracker.state(), 'done');
  } finally { tracker.stop(); }
});

test('returning to the shell ends hook mode so a hookless agent is detected by output again', async () => {
  const pty = { process: 'claude' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, HOOKED);
  try {
    tracker.report('start');
    tracker.report('stop');
    tracker.acknowledge();
    pty.process = 'bash';
    await tick(40);
    pty.process = 'gemini';
    const spinner = setInterval(() => tracker.noteOutput(), 10);
    await tick(100);
    clearInterval(spinner);
    assert.equal(tracker.state(), 'running');
  } finally { tracker.stop(); }
});

test('unknown hook events are rejected', () => {
  const tracker = createActivityTracker({ process: 'bash' }, '/bin/bash', () => {}, HOOKED);
  try { assert.equal(tracker.report('bogus'), false); } finally { tracker.stop(); }
});

test('parsePs groups the foreground process of every terminal and ignores background ones', () => {
  const output = [
    'ttys001   1907  9304 /bin/zsh',
    'ttys001   9304  9304 node /Users/me/.npm-global/bin/codex --flag',
    'ttys001   9304  9304 /vendor/codex',
    'ttys002   500   500  -zsh',
    '??        1     1    /sbin/launchd',
    '',
  ].join('\n');
  const result = parsePs(output);
  assert.deepEqual(result.get('ttys001'), ['node', 'codex', 'codex'], 'foreground group only, first two argv entries');
  assert.deepEqual(result.get('ttys002'), ['zsh']);
  assert.equal(result.has('ttys999'), false);
});

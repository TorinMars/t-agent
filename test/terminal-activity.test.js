const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityTracker, parsePs } = require('../lib/terminal-activity');

// The tracker is driven only by timers and Date.now(), so the tests run on a mocked clock:
// with real timers a busy machine delays the poll interval and the result depends on the load.
// The clock starts far from 0 because the tracker's "last input/output" times start at 0.
test.beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 }));
test.afterEach(() => mock.timers.reset());
const tick = async ms => { mock.timers.tick(ms); await Promise.resolve(); };

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

test('since() is the time of the last state change: the start until the first one, unchanged by a repeated state', async () => {
  const pty = { process: 'claude' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, HOOKED);
  try {
    const started = Date.now();
    assert.equal(tracker.since(), started, 'never changed: the start');
    await tick(50);
    tracker.report('start');
    assert.equal(tracker.since(), started + 50);
    await tick(30);
    tracker.report('start'); // still running: no change
    assert.equal(tracker.since(), started + 50);
    tracker.report('attention');
    assert.equal(tracker.state(), 'done');
    assert.equal(tracker.awaitingAnswer(), true);
    assert.equal(tracker.since(), started + 80);
    await tick(10);
    tracker.report('attention', { kind: 'select' }); // the kind of the same wait: no state change
    assert.equal(tracker.since(), started + 80);
    await tick(10);
    tracker.report('stop');
    tracker.acknowledge();
    assert.equal(tracker.state(), 'idle');
    assert.equal(tracker.since(), started + 100);
  } finally { tracker.stop(); }
});

test('a question keeps its kind: select or accept, an attention without a kind is accept, and seeing it does not answer it', () => {
  const pty = { process: 'claude' };
  const seen = [];
  const tracker = createActivityTracker(pty, '/bin/bash', state => seen.push(state), HOOKED);
  try {
    assert.equal(tracker.waitingKind(), null);
    tracker.report('start');
    assert.equal(tracker.report('attention', { kind: 'select' }), true);
    assert.equal(tracker.state(), 'done');
    assert.equal(tracker.waitingKind(), 'select');
    tracker.acknowledge();
    assert.equal(tracker.state(), 'done', 'the person looked at the question: it still waits for an answer');
    assert.equal(tracker.waitingKind(), 'select');
    tracker.report('start'); // answered: the agent works again
    assert.equal(tracker.waitingKind(), null);
    tracker.report('attention'); // an older hook: no kind, its prompts were permissions
    assert.equal(tracker.waitingKind(), 'accept');
    tracker.report('stop');
    assert.equal(tracker.waitingKind(), null, 'a finished turn is no question');
    assert.equal(tracker.awaitingAnswer(), false);
    tracker.report('attention', { kind: 'bogus' });
    assert.equal(tracker.waitingKind(), 'accept', 'an unknown kind counts as none');
    tracker.report('end');
    assert.equal(tracker.waitingKind(), null);
    assert.deepEqual(seen.filter(state => state === 'idle'), []);
  } finally { tracker.stop(); }
});

test('two hooks of one wait: a kind-less copy never replaces a known kind, a named one does, and a kind change is told', () => {
  const pty = { process: 'claude' };
  let changes = 0;
  const tracker = createActivityTracker(pty, '/bin/bash', () => { changes += 1; }, HOOKED);
  try {
    tracker.report('start');
    changes = 0;
    tracker.report('attention', { kind: 'select' }); // the current Notification entry
    tracker.report('attention'); // an older entry for the same Notification, in the person's own settings
    assert.equal(tracker.waitingKind(), 'select');
    assert.equal(changes, 1, 'one change: running -> done');
    tracker.report('attention', { kind: 'accept' });
    assert.equal(tracker.waitingKind(), 'accept');
    assert.equal(changes, 2, 'the same state with another kind is told to the feeds');
    tracker.report('attention', { kind: 'accept' });
    assert.equal(changes, 2, 'nothing changed: nothing told');
    tracker.report('stop');
    changes = 0;
    tracker.report('attention', { kind: 'select' }); // done (finished) -> a question: the state stays done, the kind is new
    assert.equal(tracker.waitingKind(), 'select');
    assert.equal(changes, 1);
  } finally { tracker.stop(); }
});

test('a question from a tool hook (AskUserQuestion, ExitPlanMode) is ended by its PostToolUse, not by output, and keeps its kind', async () => {
  const pty = { process: 'claude' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, HOOKED);
  try {
    tracker.report('start');
    tracker.report('attention', { kind: 'select', tool: true });
    tracker.report('attention', { kind: 'accept' }); // a Notification for the same dialog
    assert.equal(tracker.waitingKind(), 'select', 'the tool\'s kind is kept');
    const redraws = setInterval(() => tracker.noteOutput(), 10); // sub-agents and the dialog redraw the screen
    await tick(100);
    clearInterval(redraws);
    assert.equal(tracker.state(), 'done');
    assert.equal(tracker.waitingKind(), 'select', 'output does not end a tool\'s question');
    tracker.report('start'); // its PostToolUse: answered
    assert.equal(tracker.state(), 'running');
    assert.equal(tracker.waitingKind(), null);
    tracker.report('attention', { kind: 'accept' }); // a permission prompt afterwards: output ends it again
    const spinner = setInterval(() => tracker.noteOutput(), 10);
    await tick(100);
    clearInterval(spinner);
    assert.equal(tracker.state(), 'running');
  } finally { tracker.stop(); }
});

test('a Notification question is replaced by the tool question that follows, and returning to the shell ends any question', async () => {
  const pty = { process: 'claude' };
  const tracker = createActivityTracker(pty, '/bin/bash', () => {}, HOOKED);
  try {
    tracker.report('start');
    tracker.report('attention', { kind: 'accept' });
    tracker.report('attention', { kind: 'select', tool: true });
    assert.equal(tracker.waitingKind(), 'select');
    pty.process = 'bash';
    await tick(20);
    assert.equal(tracker.waitingKind(), null);
    assert.equal(tracker.state(), 'done');
  } finally { tracker.stop(); }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityTracker } = require('../lib/terminal-activity');

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('running while a non-shell process owns the foreground, done after it returns, idle after ack', async () => {
  const pty = { process: 'bash' };
  const seen = [];
  const tracker = createActivityTracker(pty, '/bin/bash', state => seen.push(state), 10);
  try {
    pty.process = 'claude';
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

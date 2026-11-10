const test = require('node:test');
const assert = require('node:assert/strict');
const { idleBlockers } = require('../lib/update-idle');
const { isTerminalInputFrame } = require('../lib/terminal-recent-input');

const QUIET = 600_000;
const NOW = 10_000_000;
const shell = { state: 'idle', subagents: 0, awaiting: false, foreground: ['zsh', 'zsh'], shell: 'zsh', agent: null, resumable: false };
const agent = { ...shell, foreground: ['node', 'claude', 'node'], agent: 'claude', resumable: true };
const blockers = (terminals = [], chat = { running: 0, queued: 0 }, inputs = []) => idleBlockers({ terminals, chat, inputs }, { quietMs: QUIET, now: NOW });

test('nothing going on: no reasons', () => {
  assert.deepEqual(blockers([shell, { ...shell, state: 'done' }]), []);
});

test('terminal_running: running state, running sub-agents, and an agent waiting at a question', () => {
  assert.deepEqual(blockers([{ ...shell, state: 'running' }]), [{ code: 'terminal_running', count: 1 }]);
  assert.deepEqual(blockers([{ ...agent, subagents: 2 }]), [{ code: 'terminal_running', count: 1 }]);
  assert.deepEqual(blockers([{ ...agent, state: 'done', awaiting: true }]), [{ code: 'terminal_running', count: 1 }]);
});

test('terminal_program: a program that cannot come back blocks', () => {
  for (const name of ['vim', 'ssh', 'tmux', 'less']) {
    assert.deepEqual(blockers([{ ...shell, foreground: [name, name] }]), [{ code: 'terminal_program', count: 1 }], name);
  }
  assert.deepEqual(blockers([{ ...shell, foreground: ['myserver', 'myserver'] }]), [{ code: 'terminal_program', count: 1 }]);
});

test('terminal_program: an unknown foreground is not assumed to be safe', () => {
  assert.deepEqual(blockers([{ ...shell, foreground: [] }]), [{ code: 'terminal_program', count: 1 }]);
});

test('an agent that is not working and can be resumed does not block', () => {
  assert.deepEqual(blockers([agent, { ...agent, state: 'done' }]), []);
});

test('an agent with no bound session blocks', () => {
  assert.deepEqual(blockers([{ ...agent, resumable: false }]), [{ code: 'terminal_program', count: 1 }]);
});

test('an agent started by hand in a plain terminal blocks', () => {
  assert.deepEqual(blockers([{ ...agent, agent: null, resumable: false }]), [{ code: 'terminal_program', count: 1 }]);
});

test('a resumable binding only covers the agent of that terminal', () => {
  assert.deepEqual(blockers([{ ...agent, foreground: ['node', 'codex', 'node'] }]), [{ code: 'terminal_program', count: 1 }]);
  assert.deepEqual(blockers([{ ...agent, foreground: ['claude', 'vim', 'vim'] }]), [{ code: 'terminal_program', count: 1 }]);
});

test('chat_running counts running turns and queued messages', () => {
  assert.deepEqual(blockers([], { running: 1, queued: 2 }), [{ code: 'chat_running', count: 3 }]);
  assert.deepEqual(blockers([], { running: 0, queued: 1 }), [{ code: 'chat_running', count: 1 }]);
});

test('recent_input counts only input inside the quiet window', () => {
  assert.deepEqual(blockers([], undefined, [NOW - 1000, NOW - QUIET + 1, NOW - QUIET, NOW - QUIET * 2]), [{ code: 'recent_input', count: 2 }]);
});

test('reasons are independent', () => {
  assert.deepEqual(blockers([{ ...shell, state: 'running', foreground: ['npm', 'test'] }], { running: 1, queued: 0 }, [NOW]).map(reason => reason.code),
    ['terminal_running', 'terminal_program', 'chat_running', 'recent_input']);
});

test('a snapshot of the wrong shape throws instead of reading as idle', () => {
  for (const snapshot of [null, {}, { terminals: [], chat: {} }, { terminals: [], inputs: [] }]) {
    assert.throws(() => idleBlockers(snapshot, { quietMs: QUIET, now: NOW }), /INVALID_IDLE_SNAPSHOT/);
  }
});

test('terminal input frames are told apart from control frames', () => {
  assert.equal(isTerminalInputFrame(Buffer.from('ls\r'), false, true), true);
  assert.equal(isTerminalInputFrame(Buffer.from('{"type":"resize"}'), true, true), false);
  assert.equal(isTerminalInputFrame(Buffer.from('{"type":"resize","cols":80,"rows":24}'), false, false), false);
  assert.equal(isTerminalInputFrame(Buffer.from('{not json'), false, false), true);
  assert.equal(isTerminalInputFrame(Buffer.from('echo hi'), false, false), true);
});

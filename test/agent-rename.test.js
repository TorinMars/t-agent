// "Rename reaches the agent" in docs/design/terminals.md: lib/agent-rename.js decides when a T-Agent rename is typed into the agent as
// `/rename <name>`, with an injected terminal (probe) and PTY write, on a mocked clock.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRenamer, sanitizeAgentName, decide, CLEAR_PROMPT, MAX_WAIT_MS } = require('../lib/agent-rename');

test.beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 }));
test.afterEach(() => mock.timers.reset());
const tick = ms => mock.timers.tick(ms);

// A fake terminal: `info` is what the probe answers (null: no live shell); `typed` collects the writes.
function harness(initial = {}) {
  const shell = { id: 'shell-1' };
  const t = { info: { token: shell, state: 'idle', awaiting: false, foreground: ['zsh', 'claude'], ...initial }, typed: [], logs: [] };
  t.renamer = createAgentRenamer({
    probe: () => t.info,
    write: (key, token, data) => {
      if (!t.info || t.info.token !== token) return false;
      t.typed.push(data);
      return true;
    },
    log: message => t.logs.push(message),
  });
  return t;
}
const typedAll = t => { tick(60); tick(150); return t.typed; };

test('sanitize: one line, control and invisible characters become spaces, capped, any script kept', () => {
  assert.equal(sanitizeAgentName('  MAIN-CC  '), 'MAIN-CC');
  assert.equal(sanitizeAgentName('a\nb\r\tc\x1b[31m'), 'a b c [31m');
  assert.equal(sanitizeAgentName('x\u2028y\u200bz\u202ew'), 'x y z w');
  assert.equal(sanitizeAgentName('"quoted" $HOME `cmd`'), '"quoted" $HOME `cmd`');
  assert.equal(sanitizeAgentName('\u4e2d\u6587 \ud83d\ude80'), '\u4e2d\u6587 \ud83d\ude80');
  assert.equal(Array.from(sanitizeAgentName('\ud83d\ude80'.repeat(100))).length, 80); // code points, no broken surrogate pair
  assert.equal(sanitizeAgentName(null), '');
});

test('decide: sends to a known agent in the foreground, idle or running; waits only at a question', () => {
  const idle = { agent: 'claude', state: 'idle', awaiting: false, foreground: ['claude'] };
  assert.equal(decide(idle), 'send');
  assert.equal(decide({ ...idle, state: 'done' }), 'send'); // finished its turn, back at the prompt
  assert.equal(decide({ ...idle, state: 'running' }), 'send'); // both agents take /rename while they work
  assert.equal(decide({ ...idle, agent: 'codex', foreground: ['codex'], state: 'running' }), 'send');
  assert.equal(decide({ ...idle, state: 'done', awaiting: true }), 'wait'); // a permission question: typing would answer it
  assert.equal(decide({ ...idle, foreground: ['zsh'] }), 'wait'); // the shell owns the terminal: never typed into a shell
  assert.equal(decide({ ...idle, foreground: [] }), 'wait');
  assert.equal(decide({ ...idle, agent: null }), 'drop');
  assert.equal(decide({ ...idle, agent: 'gemini' }), 'drop');
  assert.equal(decide(null), 'drop'); // no live shell
});

test('idle Claude: clears the prompt, types the command, then Enter on its own', () => {
  const t = harness();
  assert.equal(t.renamer.request('1:a', 'claude', 'MAIN-CC'), 'sent');
  assert.deepEqual(t.typed, [CLEAR_PROMPT]);
  assert.equal(CLEAR_PROMPT, '\x05' + '\x15'.repeat(12));
  tick(60);
  assert.deepEqual(t.typed, [CLEAR_PROMPT, '/rename MAIN-CC']);
  tick(149);
  assert.equal(t.typed.length, 2);
  tick(1);
  assert.deepEqual(t.typed, [CLEAR_PROMPT, '/rename MAIN-CC', '\r']);
  assert.equal(t.renamer.pending('1:a'), null);
});

test('Codex gets the same command; a shell or an unknown agent gets nothing', () => {
  const codex = harness({ foreground: ['codex'] });
  assert.equal(codex.renamer.request('1:c', 'codex', 'Review  PR'), 'sent');
  assert.deepEqual(typedAll(codex), [CLEAR_PROMPT, '/rename Review PR', '\r']);
  for (const agent of [null, undefined, 'shell', 'gemini']) {
    const t = harness();
    assert.equal(t.renamer.request('1:s', agent, 'Name'), 'skipped');
    assert.deepEqual(typedAll(t), []);
  }
});

test('running: typed at once, without waiting for the turn to end', () => {
  const t = harness({ state: 'running' });
  assert.equal(t.renamer.request('1:a', 'claude', 'While working'), 'sent');
  assert.deepEqual(typedAll(t), [CLEAR_PROMPT, '/rename While working', '\r']);
});

test('at a question: waits, and sends as soon as it is answered (after the settle time)', () => {
  const t = harness({ state: 'done', awaiting: true });
  assert.equal(t.renamer.request('1:a', 'claude', 'Later'), 'pending');
  tick(10_000);
  assert.deepEqual(t.typed, []);
  t.info.awaiting = false;
  t.info.state = 'running';
  t.renamer.poke('1:a');
  tick(499);
  assert.deepEqual(t.typed, []);
  tick(1);
  assert.deepEqual(typedAll(t), [CLEAR_PROMPT, '/rename Later', '\r']);
});

test('at a question: the poll also catches the answer without a poke', () => {
  const t = harness({ state: 'done', awaiting: true });
  assert.equal(t.renamer.request('1:a', 'claude', 'Polled'), 'pending');
  t.info.awaiting = false;
  tick(2000);
  assert.deepEqual(typedAll(t), [CLEAR_PROMPT, '/rename Polled', '\r']);
});

test('a newer rename replaces the pending one; only the newest is sent', () => {
  const t = harness({ state: 'done', awaiting: true });
  assert.equal(t.renamer.request('1:a', 'claude', 'First'), 'pending');
  assert.equal(t.renamer.request('1:a', 'claude', 'Second'), 'pending');
  assert.equal(t.renamer.pending('1:a').name, 'Second');
  t.info.awaiting = false;
  tick(2000);
  assert.deepEqual(typedAll(t), [CLEAR_PROMPT, '/rename Second', '\r']);
  tick(10_000);
  assert.equal(t.typed.length, 3); // nothing more
});

test('gives up after 30 minutes of waiting at a question and logs it', () => {
  const t = harness({ state: 'done', awaiting: true });
  t.renamer.request('1:a', 'claude', 'Never');
  tick(MAX_WAIT_MS - 2000);
  assert.ok(t.renamer.pending('1:a'));
  tick(2000);
  assert.equal(t.renamer.pending('1:a'), null);
  assert.match(t.logs.join('\n'), /agent rename of 1:a given up/);
  t.info.awaiting = false;
  tick(10_000);
  assert.deepEqual(t.typed, []);
});

test('no live shell (exited, closed): nothing is sent, nothing waits', () => {
  const t = harness();
  t.info = null;
  assert.equal(t.renamer.request('1:a', 'claude', 'Closed'), 'dropped');
  assert.equal(t.renamer.pending('1:a'), null);
  tick(5000);
  assert.deepEqual(t.typed, []);
});

test('waiting for the agent to own the foreground; the shell ends or is replaced meanwhile: dropped', () => {
  const t = harness({ foreground: ['zsh'] }); // Claude not started yet, or exited
  assert.equal(t.renamer.request('1:a', 'claude', 'Gone'), 'pending');
  t.info = { ...t.info, token: { id: 'shell-2' }, foreground: ['claude'] }; // restarted: another shell
  tick(2000);
  assert.equal(t.renamer.pending('1:a'), null);
  assert.deepEqual(t.typed, []);
  t.info.foreground = ['zsh'];
  assert.equal(t.renamer.request('1:b', 'claude', 'Exited'), 'pending');
  t.info = null;
  tick(2000);
  assert.equal(t.renamer.pending('1:b'), null);
});

test('cancel and names that cannot be typed', () => {
  const t = harness({ awaiting: true });
  t.renamer.request('1:a', 'claude', 'Kept');
  t.renamer.cancel('1:a');
  t.info.awaiting = false;
  tick(5000);
  assert.deepEqual(t.typed, []);
  assert.equal(t.renamer.request('1:a', 'claude', '  \n\t '), 'skipped');
  assert.equal(t.renamer.request('1:a', 'claude', 'fix @home'), 'skipped'); // would open Claude's file suggestions
  assert.equal(t.renamer.request('1:a', 'claude', 'mail a@b.c'), 'sent'); // @ inside a word is plain text
});

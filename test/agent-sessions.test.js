const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSessions, startupCommand } = require('../lib/agent-sessions');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-'));
  const dir = path.join(home, 'work', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('startupCommand builds new and resume commands and rejects bad ids', () => {
  assert.equal(startupCommand('claude'), 'claude');
  assert.equal(startupCommand('codex', 'abcd1234-ef56'), 'codex resume abcd1234-ef56');
  assert.equal(startupCommand('claude', 'abcd1234-ef56'), 'claude --resume abcd1234-ef56');
  assert.equal(startupCommand('bash'), null);
  assert.throws(() => startupCommand('claude', 'x; rm -rf /'), /INVALID_SESSION_ID/);
});

test('lists Claude sessions of the directory with the first prompt as title', () => {
  const { home, dir } = setup();
  const folder = path.join(home, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'aaaaaaaa-1111.jsonl'), jsonl([
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { content: 'fix \u767b\u5f55 login' } },
  ]));
  const rows = listSessions('claude', dir, home);
  assert.deepEqual(rows.map(row => [row.id, row.title]), [['aaaaaaaa-1111', 'fix \u767b\u5f55 login']]);
  assert.deepEqual(listSessions('claude', path.join(home, 'other'), home), []);
});

test('lists only Codex sessions whose cwd matches', () => {
  const { home, dir } = setup();
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '25');
  fs.mkdirSync(day, { recursive: true });
  const meta = (id, cwd) => ({ type: 'session_meta', payload: { id, cwd } });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), jsonl([meta('bbbbbbbb-2222', dir),
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'add tests' }] } }]));
  fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), jsonl([meta('cccccccc-3333', '/elsewhere')]));
  assert.deepEqual(listSessions('codex', dir, home).map(row => [row.id, row.title]), [['bbbbbbbb-2222', 'add tests']]);
});

test('a sub-agent log is judged by its last real row: a late background notice, a row longer than the tail, an empty file', () => {
  const { runningSubagentsIn } = require('../lib/agent-sessions');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-rows-'));
  const write = (name, text) => fs.writeFileSync(path.join(folder, name), text);
  const finished = { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
  const toolUse = { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } };
  const notice = { type: 'user', isMeta: true, origin: { kind: 'task-notification', producer: 'session-task' }, message: { content: '<task-notification>' } };
  write('agent-notice.jsonl', jsonl([finished, notice]));
  assert.equal(runningSubagentsIn(folder), 0, 'a notice after the final message does not restart the sub-agent');
  write('agent-working.jsonl', jsonl([toolUse, notice]));
  assert.equal(runningSubagentsIn(folder), 1, 'a notice in the middle of the work leaves it running');
  write('agent-woken.jsonl', jsonl([finished, notice, { type: 'api-request' }]));
  assert.equal(runningSubagentsIn(folder), 2, 'a sub-agent the notice woke runs again');
  write('agent-huge.jsonl', `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(200 * 1024) } })}\n`);
  assert.equal(runningSubagentsIn(folder), 3, 'a row longer than the tail cannot be read: not known to be finished');
  write('agent-empty.jsonl', '');
  assert.equal(runningSubagentsIn(folder), 3, 'an empty log is not counted');
  assert.equal(runningSubagentsIn(path.join(folder, 'missing')), 0);
});

test('runningSubagents counts the sub-agents of a Claude session whose log is unfinished and recent', () => {
  const { runningSubagents, SUBAGENT_STALE_MS } = require('../lib/agent-sessions');
  const { home, dir } = setup();
  const id = 'aaaaaaaa-2222';
  const folder = path.join(home, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), id, 'subagents');
  fs.mkdirSync(folder, { recursive: true });
  const write = (name, rows, ageMs = 0) => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, jsonl(rows));
    if (ageMs) { const when = new Date(Date.now() - ageMs); fs.utimesSync(file, when, when); }
  };
  write('agent-a1.meta.json', [{ agentType: 'general-purpose' }]);
  write('agent-a1.jsonl', [{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }]);
  write('agent-a2.jsonl', [{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }]);
  write('agent-a3.jsonl', [{ type: 'user', message: { content: [{ type: 'tool_result' }] } }]);
  write('agent-a4.jsonl', [{ type: 'assistant', message: { stop_reason: 'tool_use' } }], SUBAGENT_STALE_MS + 60000); // stale: killed with its parent
  fs.writeFileSync(path.join(folder, 'agent-a5.jsonl'), `${JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } })}\n{"type":"assis`); // partial last line
  write('notes.jsonl', [{ type: 'user' }]); // not a sub-agent log
  fs.symlinkSync(path.join(folder, 'agent-a1.jsonl'), path.join(folder, 'agent-a6.jsonl')); // links are skipped
  assert.equal(runningSubagents(dir, id, home), 2);
  assert.equal(runningSubagents(dir, 'bbbbbbbb-3333', home), 0);
  assert.equal(runningSubagents(dir, '../../etc', home), 0);
  assert.equal(runningSubagents(null, id, home), 0);
});

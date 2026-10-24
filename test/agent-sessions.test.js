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

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

test('Claude project folder names: every other character becomes "-", and a name over 200 characters is cut and gets a hash of the path', () => {
  const { claudeProjectName } = require('../lib/agent-sessions');
  assert.equal(claudeProjectName('/Users/a b/proj.x'), '-Users-a-b-proj-x');
  // Java's String.hashCode over the whole path, as Claude Code uses (absolute value, base 36).
  const long = `/${'a'.repeat(199)}hello`;
  let hash = 0;
  for (const char of long) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  assert.equal(claudeProjectName(long), `-${'a'.repeat(199)}-${Math.abs(hash).toString(36)}`);
  assert.equal(claudeProjectName(long).length, 201 + Math.abs(hash).toString(36).length);
  const { home } = setup();
  const dir = path.join(home, 'x'.repeat(210));
  const folder = path.join(home, '.claude', 'projects', claudeProjectName(dir));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'abcdef12-3456.jsonl'), jsonl([{ type: 'user', message: { content: 'long path' } }]));
  assert.deepEqual(listSessions('claude', dir, home).map(row => row.title), ['long path']);
});

// Counts every file that is opened or read through fs while `run` works (listing folders and stat calls are not reads).
function countReads(run) {
  const { mock } = require('node:test');
  const spies = ['openSync', 'readSync', 'readFileSync'].map(name => mock.method(fs, name));
  try {
    const value = run();
    return { value, opened: spies[0].mock.callCount() + spies[2].mock.callCount(), calls: spies.reduce((sum, spy) => sum + spy.mock.callCount(), 0) };
  } finally { for (const spy of spies) spy.mock.restore(); }
}
// The session files of a test were written a moment ago; the cache only keeps a file that has been still for 2 s, so the clock is put ahead.
function clockAhead(t) {
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
  t.after(() => mock.timers.reset());
}

test('a second listing of unchanged Claude session files reads no file, and only a changed file is read again', t => {
  clockAhead(t);
  const { home, dir } = setup();
  const folder = path.join(home, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const file = n => path.join(folder, `aaaaaaaa-000${n}.jsonl`);
  for (const n of [1, 2, 3]) fs.writeFileSync(file(n), jsonl([{ type: 'user', message: { content: `prompt ${n}` } }, { type: 'ai-title', aiTitle: `Session ${n}` }]));
  const first = countReads(() => listSessions('claude', dir, home));
  assert.equal(first.opened, 6, 'the first listing reads the head and the tail of each of the three files');
  assert.deepEqual(first.value.map(row => row.title).sort(), ['Session 1', 'Session 2', 'Session 3']);

  const second = countReads(() => listSessions('claude', dir, home));
  assert.equal(second.calls, 0, 'nothing changed: no file is opened or read (before: 6 opens, up to 768 KiB each file)');
  assert.deepEqual(second.value, first.value, 'and the answer is the same, times included');

  fs.appendFileSync(file(2), jsonl([{ type: 'custom-title', customTitle: 'Renamed in Claude' }]));
  const third = countReads(() => listSessions('claude', dir, home));
  assert.equal(third.opened, 2, 'only the file that changed is read again');
  assert.deepEqual(third.value.map(row => row.title).sort(), ['Renamed in Claude', 'Session 1', 'Session 3']);
  assert.equal(countReads(() => listSessions('claude', dir, home)).calls, 0);

  // A new file and a removed file follow the folder listing.
  fs.writeFileSync(file(4), jsonl([{ type: 'user', message: { content: 'prompt 4' } }]));
  fs.rmSync(file(1));
  const fourth = countReads(() => listSessions('claude', dir, home));
  assert.equal(fourth.opened, 2);
  assert.deepEqual(fourth.value.map(row => row.title).sort(), ['Renamed in Claude', 'Session 3', 'prompt 4']);
});

test('a second listing of unchanged Codex sessions reads no file: not the rollouts of other folders, not the name index', t => {
  clockAhead(t);
  const { home, dir } = setup();
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '02');
  fs.mkdirSync(day, { recursive: true });
  const meta = (id, cwd) => ({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-11-02T10:00:00.000Z' } });
  const prompt = text => ({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text }] } });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), jsonl([meta('bbbbbbbb-0001', dir), prompt('first here')]));
  fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), jsonl([meta('bbbbbbbb-0002', dir), prompt('second here')]));
  for (let n = 0; n < 5; n += 1) fs.writeFileSync(path.join(day, `rollout-other-${n}.jsonl`), jsonl([meta(`cccccccc-000${n}`, '/elsewhere'), prompt('not here')]));
  const index = path.join(home, '.codex', 'session_index.jsonl');
  fs.writeFileSync(index, jsonl([{ id: 'bbbbbbbb-0002', thread_name: 'Named thread' }]));

  const first = countReads(() => listSessions('codex', dir, home));
  assert.equal(first.opened, 8, 'the first listing reads the index and the head of all seven rollouts');
  assert.deepEqual(first.value.map(row => [row.id, row.title]).sort(), [['bbbbbbbb-0001', 'first here'], ['bbbbbbbb-0002', 'Named thread']]);
  const second = countReads(() => listSessions('codex', dir, home));
  assert.equal(second.calls, 0, 'nothing changed: no file is read (before: 8 opens on every listing)');
  assert.deepEqual(second.value, first.value);
  // The cache is per file, so another folder's listing reuses what was read.
  assert.equal(countReads(() => listSessions('codex', '/elsewhere', home)).calls, 0);

  fs.appendFileSync(index, jsonl([{ id: 'bbbbbbbb-0001', thread_name: 'Renamed later' }]));
  const third = countReads(() => listSessions('codex', dir, home));
  assert.equal(third.opened, 1, 'only the index changed');
  assert.deepEqual(third.value.map(row => row.title).sort(), ['Named thread', 'Renamed later']);
});

test('a session file written again with its old size and times (a task rename does that) is read again', t => {
  clockAhead(t);
  const { home, dir } = setup();
  const moved = path.join(home, 'work', 'prox');
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '03');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-move.jsonl');
  const rows = cwd => jsonl([{ type: 'session_meta', payload: { id: 'dddddddd-0001', cwd } }]);
  fs.writeFileSync(file, rows(dir));
  const written = new Date(Date.now() - 90_000); // a whole millisecond, so the rewritten file can get exactly the same time
  fs.utimesSync(file, written, written);
  assert.deepEqual(listSessions('codex', dir, home).map(row => row.id), ['dddddddd-0001']);
  assert.equal(countReads(() => listSessions('codex', dir, home)).calls, 0, 'cached');
  // As lib/agent-session-move.js rewrites it: a temporary file with the old times takes the place of the file. Same length, same mtime.
  const stat = fs.statSync(file);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, rows(moved));
  fs.utimesSync(temp, stat.atime, stat.mtime);
  fs.renameSync(temp, file);
  assert.equal(fs.statSync(file).size, stat.size);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs, 'size and modification time alone would not show the change');
  assert.deepEqual(listSessions('codex', dir, home), [], 'the old folder no longer has it');
  assert.deepEqual(listSessions('codex', moved, home).map(row => row.id), ['dddddddd-0001'], 'the new folder does');
});

test('the file cache: bounded, least recently used first, never pushing out what the listing in progress uses, and not trusting a fresh file', () => {
  const { createFileCache } = require('../lib/agent-sessions');
  let clock = 100_000;
  let reads = 0;
  const cache = createFileCache({ max: 3, racyMs: 1000, now: () => clock });
  const stat = (inode, at = 0, size = 10) => ({ ino: inode, size, mtimeMs: at, ctimeMs: at });
  const get = (name, fileStat) => cache.get(name, fileStat, () => { reads += 1; return `value of ${name}`; });

  cache.begin();
  assert.equal(get('a', stat(1)), 'value of a');
  assert.equal(get('a', stat(1)), 'value of a');
  assert.equal(reads, 1, 'the same file is read once');
  for (const changed of [stat(1, 0, 11), stat(1, 5), stat(2), { ...stat(1), ctimeMs: 7 }]) {
    const before = reads;
    get('a', changed);
    assert.equal(reads, before + 1, 'another size, modification time, inode or change time: read again');
  }
  // Changed less than racyMs before the read: a second write in the same timestamp tick would not show, so it is not kept.
  reads = 0;
  get('fresh', stat(9, clock - 500));
  get('fresh', stat(9, clock - 500));
  assert.equal(reads, 2);
  clock += 1000;
  get('fresh', stat(9, clock - 1500));
  get('fresh', stat(9, clock - 1500));
  assert.equal(reads, 3, 'kept once the file has been still long enough');
  assert.throws(() => cache.get('broken', stat(8), () => { throw new Error('unreadable'); }), /unreadable/);

  // At most `max` files: the least recently used one goes first.
  cache.clear();
  reads = 0;
  cache.begin();
  for (const name of ['a', 'b', 'c']) get(name, stat(1));
  cache.begin();
  get('a', stat(1)); // used again: b is now the oldest
  get('d', stat(1));
  assert.equal(cache.size(), 3);
  reads = 0;
  cache.begin();
  get('a', stat(1));
  get('c', stat(1));
  get('d', stat(1));
  assert.equal(reads, 0);
  get('b', stat(1));
  assert.equal(reads, 1, 'b was dropped');

  // A listing of more files than the cache holds keeps `max` of them instead of pushing its own entries out one after the other.
  cache.clear();
  const many = ['f1', 'f2', 'f3', 'f4', 'f5'];
  cache.begin();
  for (const name of many) get(name, stat(1));
  assert.equal(cache.size(), 3);
  reads = 0;
  cache.begin();
  for (const name of many) get(name, stat(1));
  assert.equal(reads, 2, 'three of the five are served from the cache on every listing (a plain LRU would read all five again)');
  assert.equal(cache.size(), 3);
});

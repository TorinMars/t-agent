// Context recall in the Claude listener (plugins/listeners/claude/hook.js): the `context` fields per event, the
// `activity` timeline entries, the transcript `excerpt` (size cap, only on transitions to waiting_user / review),
// TA_HOOK_URL parsing, git numstat with its time limit, and a big transcript. Temporary folders only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { fakeServer, TOKEN } = require('./fixtures/attention-fake-server');
const hookModule = require('../plugins/listeners/claude/hook.js');

const HOOK = path.resolve(__dirname, '../plugins/listeners/claude/hook.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-context-')));
let count = 0;
const fresh = name => { const dir = path.join(tmp, `${name}-${count += 1}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
// A 3-byte character in UTF-8 (a CJK ideograph), built from its code point: the excerpt must never cut one in half.
const WIDE = String.fromCodePoint(0x4e2d);
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

function configure(dir, url) {
  fs.writeFileSync(path.join(dir, 'attention-client.json'), JSON.stringify({ url, token: TOKEN }), { mode: 0o600 });
}

function hook(dir, input, env = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: path.join(tmp, 'no-home'), TAGENT_HOME: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function gitRepo() {
  const repo = fresh('repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feat/login');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'x\ny\nz\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n');
  return repo;
}

const line = object => `${JSON.stringify(object)}\n`;
const userLine = text => line({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text, tool) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', id: 'toolu_1', name: tool.name, input: tool.input }] : [])] } });

test('every event fills its part of the context, sends an activity, and the excerpt only on transitions', { skip: !hasGit }, async () => {
  const fake = await fakeServer();
  const dir = fresh('data');
  configure(dir, fake.url);
  const repo = gitRepo();
  const transcript = path.join(fresh('transcript'), 's.jsonl');
  fs.writeFileSync(transcript, userLine('Fix the login page') + assistantLine('Looking at routes/auth.js now.'));
  const session = 'ctx-session-1';
  const base = { session_id: session, transcript_path: transcript, cwd: repo, permission_mode: 'default' };
  const env = { TA_HOOK_URL: 'http://127.0.0.1:3000/hooks/terminal-activity?task=7&terminal=t-1' };
  const lastPut = () => fake.requests.filter(r => r.method === 'PUT').at(-1).body;
  try {
    await hook(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login page' }, env);
    let body = lastPut();
    const { turn_started_at: turnStarted, started_at: startedAt, ...context } = body.context;
    assert.ok(Date.parse(turnStarted) && Date.parse(startedAt));
    assert.deepEqual(context, {
      latest_prompt: 'Fix the login page', turns: 1, pending: null, cwd: repo, host: os.hostname(), branch: 'feat/login',
      session: { agent: 'claude', id: session, resume: `cd '${repo}' && claude --resume ${session}` },
      tagent: { task_id: '7', terminal_id: 't-1' }, goal: 'Fix the login page',
    });
    assert.deepEqual(body.activity, { kind: 'prompt', text: 'Fix the login page' });
    assert.equal(body.excerpt, undefined, 'no excerpt for working');
    assert.equal(body.context.files, undefined, 'no git on a prompt');

    await hook(dir, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Also add a test' });
    body = lastPut();
    assert.equal(body.context.goal, undefined, 'the goal is set once');
    assert.equal(body.context.started_at, undefined);
    assert.equal(body.context.turns, 2);
    assert.equal(body.context.tagent, null, 'outside a T-Agent terminal');
    assert.equal(fake.items.get(1).context.goal, 'Fix the login page');

    // PermissionRequest (before the dialog) only remembers the tool: no request.
    const before = fake.requests.length;
    const permission = await hook(dir, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test -- test/auth.test.js', description: 'Run tests' } });
    assert.deepEqual([permission.code, permission.out, fake.requests.length], [0, '', before]);

    await hook(dir, { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    body = lastPut();
    assert.deepEqual(body.context.pending, { kind: 'permission', text: 'Claude needs your permission to use Bash', tool: 'Bash', command: 'npm test -- test/auth.test.js' });
    assert.deepEqual(body.context.files, [{ path: 'a.txt', added: 2, deleted: 0 }, { path: 'b.txt', added: 0, deleted: 2 }]);
    assert.equal(body.context.branch, 'feat/login');
    assert.deepEqual(body.activity, { kind: 'permission', text: 'Claude needs your permission to use Bash: npm test -- test/auth.test.js' });
    assert.equal(body.excerpt, 'User: Fix the login page\n\nClaude: Looking at routes/auth.js now.');

    await hook(dir, { ...base, hook_event_name: 'Notification', message: 'Claude has a question for you', notification_type: 'elicitation_dialog' });
    body = lastPut();
    assert.deepEqual(body.context.pending, { kind: 'question', text: 'Claude has a question for you' });
    assert.equal(body.excerpt, undefined, 'still waiting: not a transition');
    assert.equal(body.context.files, undefined);

    await hook(dir, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'toolu_1' });
    body = lastPut();
    assert.deepEqual(body.context, { pending: null });
    assert.deepEqual(body.activity, { kind: 'resumed', text: 'Claude continued (Bash)' });

    fs.appendFileSync(transcript, assistantLine('Done. The page redirects now.'));
    await hook(dir, { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done. The page redirects now.' });
    body = lastPut();
    assert.equal(body.status, 'review');
    assert.equal(body.context.last_reply, 'Done. The page redirects now.');
    assert.equal(body.context.pending, null);
    assert.equal(body.context.files.length, 2);
    assert.deepEqual(body.activity, { kind: 'turn_end', text: 'Done. The page redirects now.' });
    assert.match(body.excerpt, /Claude: Done\. The page redirects now\.$/);

    await hook(dir, { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done again.' });
    assert.equal(lastPut().excerpt, undefined, 'already in review: no excerpt');

    await hook(dir, { ...base, hook_event_name: 'StopFailure', error: 'overloaded', error_details: '529' });
    body = lastPut();
    assert.deepEqual(body.context.pending, { kind: 'error', text: 'API error: overloaded (529)' });
    assert.deepEqual(body.activity, { kind: 'error', text: 'API error: overloaded (529)' });
    assert.equal(body.excerpt, undefined);

    const item = fake.items.get(1);
    assert.equal(item.context.goal, 'Fix the login page');
    assert.equal(item.context.turns, 2);
    assert.equal(item.context.session.id, session);
    const kinds = fake.events.get(1).filter(e => e.type === 'activity').map(e => e.data.kind).reverse();
    assert.deepEqual(kinds, ['prompt', 'prompt', 'permission', 'question', 'resumed', 'turn_end', 'turn_end', 'error']);
  } finally {
    await fake.close();
  }
});

test('a permission without PermissionRequest takes the tool and command from the transcript; outside a repo no files', async () => {
  const fake = await fakeServer();
  const dir = fresh('data');
  configure(dir, fake.url);
  const folder = fresh('plain');
  const transcript = path.join(folder, 's.jsonl');
  fs.writeFileSync(transcript, userLine('Deploy it') + assistantLine('Running the deploy.', { name: 'Bash', input: { command: './deploy.sh --prod' } }));
  try {
    await hook(dir, { session_id: 'ctx-2', transcript_path: transcript, cwd: folder, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    const body = fake.requests.at(-1).body;
    assert.deepEqual(body.context.pending, { kind: 'permission', text: 'Claude needs your permission to use Bash', tool: 'Bash', command: './deploy.sh --prod' });
    assert.equal(body.context.files, undefined);
    assert.equal(body.title, `Claude session in ${path.basename(folder)}`);
    assert.equal(body.context.session.resume, `cd '${folder}' && claude --resume ctx-2`, 'the identity is sent on create');
  } finally {
    await fake.close();
  }
});

test('a slow git is cut after 1.5 s: the update is still sent, without files, and the hook stays under 2.5 s', async () => {
  const fake = await fakeServer();
  const dir = fresh('data');
  configure(dir, fake.url);
  const bin = fresh('slow-git-bin');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  try {
    const result = await hook(dir, { session_id: 'ctx-3', cwd: fresh('work'), hook_event_name: 'Stop', last_assistant_message: 'Finished.' }, { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    assert.deepEqual([result.code, result.out], [0, '']);
    assert.ok(result.ms >= 1400 && result.ms < 2500, `took ${result.ms} ms`);
    const put = fake.requests.find(r => r.method === 'PUT');
    assert.ok(put, 'the update was sent');
    assert.equal(put.body.status, 'review');
    assert.equal(put.body.context.files, undefined);
  } finally {
    await fake.close();
  }
});

test('a big transcript: only the tail is read, the excerpt is readable text of at most 8 KiB, fast', async () => {
  const folder = fresh('big');
  const file = path.join(folder, 'big.jsonl');
  const fd = fs.openSync(file, 'w');
  const huge = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 60; i += 1) {
    fs.writeSync(fd, userLine(`Old question ${i}`));
    fs.writeSync(fd, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: huge }] } }));
  }
  fs.writeSync(fd, '{"type":"assistant","message":{broken json\n');
  fs.writeSync(fd, line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta text' } }));
  fs.writeSync(fd, userLine('<command-name>/clear</command-name>'));
  fs.writeSync(fd, line({ type: 'system', content: 'system line' }));
  for (let i = 0; i < 40; i += 1) {
    fs.writeSync(fd, userLine(`Question ${i}: ${'why '.repeat(60)}`));
    fs.writeSync(fd, assistantLine(`Answer ${i}: ${'because '.repeat(40)}\u00e9${WIDE}`));
  }
  fs.writeSync(fd, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'tool output' }] } }));
  fs.writeSync(fd, assistantLine('Final answer.'));
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > 10 * 1024 * 1024);

  const started = Date.now();
  const { excerpt } = hookModule.readTranscript(file);
  const ms = Date.now() - started;
  assert.ok(ms < 300, `read in ${ms} ms`);
  assert.ok(Buffer.byteLength(excerpt) <= 8 * 1024, `${Buffer.byteLength(excerpt)} bytes`);
  assert.ok(Buffer.byteLength(excerpt) > 6 * 1024, 'close to the cap');
  assert.match(excerpt, /^(User|Claude): /, 'starts at a whole message');
  assert.match(excerpt, /Claude: Final answer\.$/);
  for (const bad of ['tool output', 'meta text', 'command-name', 'system line', 'Old question', 'xxxx', 'broken']) assert.ok(!excerpt.includes(bad), bad);
  assert.ok(!excerpt.includes('�'), 'no broken characters');

  // One long message is cut to 2000 characters; a missing or non-JSONL file gives nothing.
  const long = path.join(folder, 'long.jsonl');
  fs.writeFileSync(long, assistantLine(WIDE.repeat(5000)));
  const one = hookModule.readTranscript(long).excerpt;
  assert.ok(Buffer.byteLength(one) <= 8 * 1024 && one.endsWith('...'));
  assert.deepEqual(hookModule.readTranscript(path.join(folder, 'missing.jsonl')), { excerpt: '', lastTool: null });
  assert.deepEqual(hookModule.readTranscript(path.join(folder, 'notes.txt')), { excerpt: '', lastTool: null });
});

test('TA_HOOK_URL gives the T-Agent task and terminal; anything else gives null', () => {
  const { tagentFrom } = hookModule;
  assert.deepEqual(tagentFrom({ TA_HOOK_URL: 'http://127.0.0.1:3000/hooks/terminal-activity?task=12&terminal=term-a1' }), { task_id: '12', terminal_id: 'term-a1' });
  assert.deepEqual(tagentFrom({ TA_HOOK_URL: 'http://127.0.0.1:3000/hooks/terminal-activity?terminal=x&task=3&event=start' }), { task_id: '3', terminal_id: 'x' });
  assert.equal(tagentFrom({ TA_HOOK_URL: 'http://127.0.0.1:3000/hooks/terminal-activity?task=12' }), null);
  assert.equal(tagentFrom({ TA_HOOK_URL: 'not a url' }), null);
  assert.equal(tagentFrom({}), null);
});

test('commandOf and branchOf: the useful part of a tool input; the branch of a worktree checkout', () => {
  const { commandOf, branchOf } = hookModule;
  assert.equal(commandOf({ command: ' ls -la ' }), 'ls -la');
  assert.equal(commandOf({ file_path: '/x/y.js', content: 'z' }), '/x/y.js');
  assert.equal(commandOf({ a: 1 }), '{"a":1}');
  assert.equal(commandOf(null), '');
  assert.equal(commandOf({ command: 'y'.repeat(3000) }).length, 1000);
  const repo = fresh('wt');
  const gitDir = path.join(repo, 'real-git');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feat/x\n');
  fs.mkdirSync(path.join(repo, 'checkout', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'checkout', '.git'), 'gitdir: ../real-git\n');
  assert.equal(branchOf(path.join(repo, 'checkout', 'sub')), 'feat/x');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), '0123456789abcdef0123\n');
  assert.equal(branchOf(path.join(repo, 'checkout')), '0123456789ab', 'detached HEAD');
});

test('rules/claude/settings.json has the PermissionRequest hook for every tool', () => {
  const settings = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../rules/claude/settings.json'), 'utf8'));
  const groups = settings.hooks.PermissionRequest.filter(group => group.hooks.some(h => h.command.includes('claude-hook.path')));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, '*');
});

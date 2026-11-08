// T-Attention end to end: a real server.js (temporary data folder, local mode), a token made through the browser session API, the real Claude
// listener (plugins/listeners/claude/hook.js) run as Claude Code runs it (hook JSON on stdin, config from TA_ATTENTION_URL / TA_ATTENTION_TOKEN)
// for one session: UserPromptSubmit -> PermissionRequest + Notification -> PostToolUse -> Stop -> SessionEnd. Checked after each step: the item
// status; at the end: the context, the activity timeline, the live stream (SSE), that the transcript excerpt is never stored or published, the
// notifications a fake notifier plugin got (test/fixtures/attention-fake-notifier.js, preloaded with `node -r`) with their card text, and
// `t-attention show ref:claude:<id>` against the same server. The second test gives the real change events to the page's real feed (attention-feed.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'plugins', 'listeners', 'claude', 'hook.js');
const CLI = path.join(ROOT, 'scripts', 't-attention.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'attention-fake-notifier.js');
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const MARKER = 'EXCERPT-ONLY-7f3a91'; // appears only in the transcript, so only in the excerpt the listener sends

async function startServer(t, temp, notifierLog) {
  const data = path.join(temp, 'server-data');
  const child = spawn(process.execPath, ['-r', PRELOAD, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', ACCESS_MODE: 'local', SESSION_SECRET: 'attention-e2e-test-secret-'.repeat(3),
      T_AGENT_DATA_DIR: data, TAGENT_HOME: data, T_AGENT_DB_PATH: path.join(data, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'),
      SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', TA_FAKE_NOTIFIER_LOG: notifierLog,
      TA_FAKE_EXCERPT_LOG: path.join(temp, 'excerpts.jsonl'), TA_FAKE_EXCERPT_MARKER: MARKER,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Client startup timed out: ${output}`)), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Client exited before becoming ready: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  return { base: `http://127.0.0.1:${port}`, dbPath: path.join(data, 'db.sqlite') };
}

// Collects a server-sent events body; until(pattern) waits until the text read so far matches.
function sse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: '' };
  state.until = async (want, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (!want(state.text)) {
      if (Date.now() > deadline) throw new Error(`stream did not deliver: ${state.text}`);
      const { value, done } = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({}), 200))]);
      if (done) throw new Error(`stream ended: ${state.text}`);
      if (value) state.text += decoder.decode(value, { stream: true });
    }
    return state.text;
  };
  state.close = () => reader.cancel().catch(() => {});
  return state;
}
const changesIn = text => [...text.matchAll(/event: change\ndata: (.*)\n\n/g)].map(match => JSON.parse(match[1]));

// Runs the hook as Claude Code does: one JSON object on stdin; the hook always exits 0 and prints nothing.
function runHook(env, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'feat/login');
  fs.writeFileSync(path.join(dir, 'login.js'), 'const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  fs.writeFileSync(path.join(dir, 'login.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
}

test('Claude listener -> core -> SSE, timeline, context, notifier and CLI on a real server', { timeout: 90000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-e2e-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const notifierLog = path.join(temp, 'notifications.jsonl');
  const { base, dbPath } = await startServer(t, temp, notifierLog);

  // A token through the browser session API (local mode: the page's session), shown once.
  const made = await fetch(`${base}/api/attention/tokens`, { method: 'POST', headers: { ...XHR, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e claude' }) });
  assert.equal(made.status, 201);
  const { token } = await made.json();
  assert.match(token, /^tatt_/);
  const byRef = async ref => {
    const response = await fetch(`${base}/api/attention/by-ref/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${token}` } });
    return response.status === 404 ? null : response.json();
  };

  // The live stream, opened before the first hook.
  const stream = sse(await fetch(`${base}/api/attention/stream`));
  t.after(() => stream.close());

  // The session: a git folder with a changed file, and a transcript whose text exists only there.
  const cwd = path.join(temp, 'repo');
  gitRepo(cwd);
  const transcript = path.join(temp, 'session.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: `Add a remember-me box to the login page ${MARKER}` } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `I will edit login.js and then run the tests. ${MARKER}` }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const sessionId = '3f1c2b9e-e2e0-4a11-9d0b-0123456789ab';
  const ref = `claude:${sessionId}`;
  const hookHome = path.join(temp, 'hook-home');
  const env = {
    PATH: process.env.PATH, HOME: path.join(temp, 'home'), TAGENT_HOME: hookHome,
    TA_ATTENTION_URL: base, TA_ATTENTION_TOKEN: token, TA_ATTENTION_HOOK_TIMEOUT_MS: '8000',
    TA_HOOK_URL: 'http://127.0.0.1:1/hooks/terminal-activity?task=5&terminal=term-1',
  };
  const common = { session_id: sessionId, transcript_path: transcript, cwd, permission_mode: 'default' };
  const step = async (event, status) => {
    const ran = await runHook(env, { ...common, ...event });
    assert.deepEqual([ran.code, ran.stdout], [0, ''], `${event.hook_event_name}: the hook exits 0 and prints nothing (${ran.stderr})`);
    const found = await byRef(ref);
    if (status === null) assert.equal(found, null, event.hook_event_name);
    else assert.equal(found && found.item.status, status, `${event.hook_event_name} -> ${status}`);
    return found;
  };

  await step({ hook_event_name: 'UserPromptSubmit', prompt: '  Add a remember-me box to the login page  ' }, 'working');
  // PermissionRequest only remembers the tool for the Notification that follows: no request, no item change.
  await step({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test -- --watch=false', description: 'Run the tests' } }, 'working');
  await step({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 'waiting_user');
  await step({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --watch=false' }, tool_response: { stdout: 'ok' } }, 'working');
  // A background sub-agent still runs: the Stop is held back and nobody is notified; the Stop after it finished goes to review.
  const subagents = path.join(temp, 'session', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const subagentLog = stopReason => fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { stop_reason: stopReason } })}\n`);
  subagentLog('tool_use');
  await step({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Started a sub-agent.' }, 'working');
  subagentLog('end_turn');
  await step({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'The remember-me box is in place.\nAll 12 tests pass.' }, 'review');
  const last = await step({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, 'review');

  // The item and its context.
  const { item, events } = last;
  assert.equal(item.title, 'Add a remember-me box to the login page');
  assert.equal(item.source, 'claude');
  assert.equal(item.external_ref, ref);
  assert.equal(item.attention_reason, 'The remember-me box is in place.\nAll 12 tests pass.');
  const context = item.context;
  assert.equal(context.goal, 'Add a remember-me box to the login page');
  assert.equal(context.latest_prompt, 'Add a remember-me box to the login page');
  assert.equal(context.last_reply, 'The remember-me box is in place.\nAll 12 tests pass.');
  assert.equal(context.pending, undefined, 'pending is cleared when the work resumed and at the turn end');
  assert.equal(context.cwd, cwd);
  assert.equal(context.branch, 'feat/login');
  assert.equal(context.host, os.hostname());
  assert.equal(context.turns, 1);
  assert.ok(!Number.isNaN(Date.parse(context.started_at)) && !Number.isNaN(Date.parse(context.turn_started_at)));
  assert.deepEqual(context.files, [{ path: 'login.js', added: 2, deleted: 0 }]);
  assert.deepEqual(context.session, { agent: 'claude', id: sessionId, resume: `cd '${cwd}' && claude --resume ${sessionId}` });
  assert.deepEqual(context.tagent, { task_id: '5', terminal_id: 'term-1' });
  assert.equal(context.summary, undefined, 'the AI summary is off by default');

  // The timeline: the activity entries in order (events are newest first), between the status changes.
  const oldestFirst = [...events].reverse();
  assert.deepEqual(oldestFirst.filter(event => event.type === 'activity').map(event => [event.data.kind, event.data.text]), [
    ['prompt', 'Add a remember-me box to the login page'],
    ['permission', 'Claude needs your permission to use Bash: npm test -- --watch=false'],
    ['resumed', 'Claude continued (Bash)'],
    ['note', 'Waiting for 1 sub-agent'],
    ['turn_end', 'The remember-me box is in place. All 12 tests pass.'],
    ['session_end', 'Session ended (prompt_input_exit)'],
  ]);
  assert.deepEqual(oldestFirst.filter(event => event.type === 'status' || event.type === 'created').map(event => event.to_status), ['working', 'waiting_user', 'working', 'review']);
  assert.ok(events.every(event => event.actor === 'claude'), 'every event names the listener');

  // The live stream: one change per hook that changed something, in order, with the item.
  const changes = changesIn(await stream.until(text => changesIn(text).length >= 6));
  assert.deepEqual(changes.map(change => [change.kind, change.item.status]), [['created', 'working'], ['updated', 'waiting_user'], ['updated', 'working'], ['updated', 'working'], ['updated', 'review'], ['updated', 'review']]);
  assert.deepEqual(changes[1].item.context.pending, { kind: 'permission', text: 'Claude needs your permission to use Bash', tool: 'Bash', command: 'npm test -- --watch=false' });
  assert.equal(changes[5].event.type, 'activity');

  // The excerpt is sent on the transitions to waiting_user and review (the server got it in process, for the AI summary) ...
  const excerpts = fs.readFileSync(path.join(temp, 'excerpts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(excerpts, [{ status: 'waiting_user', marker: true }, { status: 'review', marker: true }]);
  // ... and is never stored or published.
  assert.equal(stream.text.includes(MARKER), false, 'not in the stream');
  assert.equal(JSON.stringify(last).includes(MARKER), false, 'not in the item or its events');
  for (const file of [dbPath, `${dbPath}-wal`]) {
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(MARKER), false, `not in ${path.basename(file)}`);
  }

  // The notifier got exactly waiting_user and review, each once, with the card.
  const notes = await (async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const lines = fs.existsSync(notifierLog) ? fs.readFileSync(notifierLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      if (lines.length >= 2 || Date.now() > deadline) return lines;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  await new Promise(resolve => setTimeout(resolve, 300)); // nothing more arrives
  const final = fs.readFileSync(notifierLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(final.map(note => [note.id, note.status, note.previous, note.mode, note.reason]), [[item.id, 'waiting_user', 'working', 'message', 'status'], [item.id, 'review', 'working', 'message', 'status']]);
  assert.equal(notes.length, 2);
  // The card of the Telegram plugin (no page address is set, so no Open line).
  assert.equal(final[0].text, [
    '\u{1F64B} Needs you \u00b7 Add a remember-me box to the login page',
    '',
    'Needs: Claude needs your permission to use Bash',
    'npm test -- --watch=false',
    '',
    'You asked: Add a remember-me box to the login page',
    '',
    'Changed: 1 file, +2 -0',
    '\u2022 login.js',
    '',
    `${cwd} \u00b7 feat/login \u00b7 ${os.hostname()} \u00b7 claude`,
  ].join('\n'));
  assert.match(final[1].text, /Review \u00b7 Add a remember-me box to the login page/);
  assert.match(final[1].text, /The remember-me box is in place\./);
  assert.ok(final[1].text.includes(`${cwd} \u00b7 feat/login \u00b7 ${os.hostname()} \u00b7 claude`));
  assert.equal(JSON.stringify(final).includes(MARKER), false, 'a notifier never gets the excerpt');

  // The CLI against the same server: the context card of the session.
  const shown = execFileSync(process.execPath, [CLI, 'show', `ref:${ref}`], { env: { ...env, TA_HOOK_URL: '' }, encoding: 'utf8' });
  assert.match(shown, /Add a remember-me box to the login page/);
  assert.match(shown, /review/i);
  assert.match(shown, /Goal/);
  assert.match(shown, /The remember-me box is in place\./);
  assert.match(shown, /login\.js/);
  assert.ok(shown.includes(`claude --resume ${sessionId}`), shown);
  const json = JSON.parse(execFileSync(process.execPath, [CLI, 'show', `ref:${ref}`, '--json'], { env, encoding: 'utf8' }));
  assert.equal((json.item || json).id, item.id);
});

test('real change events reach the page feed: no notice for a plain turn end, a notice after sub-agents and from other paths', { timeout: 90000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-quiet-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const { base } = await startServer(t, temp, path.join(temp, 'notifications.jsonl'));
  const made = await fetch(`${base}/api/attention/tokens`, { method: 'POST', headers: { ...XHR, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e quiet' }) });
  const { token } = await made.json();
  const auth = { Authorization: `Bearer ${token}` };
  const stream = sse(await fetch(`${base}/api/attention/stream`));
  t.after(() => stream.close());

  const transcript = path.join(temp, 'quiet.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ship the page' } })}\n`);
  const subagents = path.join(temp, 'quiet', 'subagents');
  const subagentLog = stopReason => {
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { stop_reason: stopReason } })}\n`);
  };
  const env = { PATH: process.env.PATH, HOME: path.join(temp, 'home'), TAGENT_HOME: path.join(temp, 'hook-home'), TA_ATTENTION_URL: base, TA_ATTENTION_TOKEN: token, TA_ATTENTION_HOOK_TIMEOUT_MS: '8000' };
  const common = { session_id: '7a1c2b9e-e2e0-4a11-9d0b-0123456789cd', transcript_path: transcript, cwd: temp, permission_mode: 'default' };
  const hook = async event => assert.deepEqual((await runHook(env, { ...common, ...event })).code, 0);
  const stop = message => hook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message });
  const prompt = text => hook({ hook_event_name: 'UserPromptSubmit', prompt: text });

  await prompt('Ship the page');
  await stop('Plain answer'); // an ordinary turn end
  await prompt('Now with a sub-agent');
  subagentLog('tool_use');
  await stop('Started a sub-agent'); // held
  subagentLog('end_turn');
  await prompt('<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>'); // Claude Code wakes the session
  await stop('The sub-agent finished'); // the review after the sub-agents
  const { item } = await (await fetch(`${base}/api/attention/by-ref/${encodeURIComponent(`claude:${common.session_id}`)}`, { headers: auth })).json();
  const patch = status => fetch(`${base}/api/attention/${item.id}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  await patch('working');
  await patch('review'); // another path to review

  const changes = changesIn(await stream.until(text => changesIn(text).length >= 8));
  assert.deepEqual(changes.map(change => [change.item.status, change.plain_turn_end === true]), [
    ['working', false], ['review', true], ['working', false], ['working', false], ['working', false], ['review', false], ['working', false], ['review', false],
  ]);
  assert.equal(JSON.stringify(item).includes('plain_turn_end'), false, 'the item never holds the marker');
  assert.equal(item.context.plain_turn_end, undefined);

  // The real feed, fed with the real events exactly as the stream sent them.
  const { startAttentionFeed } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'h5-shell', 'attention-feed.mjs')).href);
  globalThis.document = { addEventListener() {}, activeElement: null, visibilityState: 'visible' };
  t.after(() => { delete globalThis.document; });
  let state = {};
  const notices = [];
  const statuses = [];
  const ui = {
    get: () => state,
    set: next => { state = { ...state, ...(typeof next === 'function' ? next(state) : next) }; },
    subscribe() {},
    actions: {},
    notify: (text, kind) => notices.push([text, kind]),
  };
  let onChange = null;
  class FakeEventSource { addEventListener(name, fn) { if (name === 'change') onChange = fn; } close() {} }
  const feed = startAttentionFeed(ui, { api: async () => ({ items: [] }), EventSourceImpl: FakeEventSource });
  t.after(() => feed.stop());
  await new Promise(resolve => setImmediate(resolve));
  for (const change of changes) {
    onChange({ data: JSON.stringify(change) });
    statuses.push(state.attention.items.find(entry => entry.id === item.id).status);
  }
  assert.deepEqual(statuses, changes.map(change => change.item.status), 'the status still changes at every event, also at the plain turn end');
  assert.deepEqual(notices, [
    ['Review: Ship the page \u2014 The sub-agent finished', 'info'],
    ['Review: Ship the page \u2014 The sub-agent finished', 'info'],
  ], 'one notice after the sub-agents and one for the API change; none for the plain turn end');
});

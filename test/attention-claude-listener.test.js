// The Claude Code listener (plugins/listeners/claude/hook.js): hook JSON as Claude Code 2.1.x sends it on stdin,
// checked against the requests a fake T-Attention server receives. Also the hook command distributed in
// rules/claude/settings.json. Every run has a temporary HOME / data folder; the real ~/.tagent is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeServer, TOKEN } = require('./fixtures/attention-fake-server');

const HOOK = path.resolve(__dirname, '../plugins/listeners/claude/hook.js');
const SETTINGS = path.resolve(__dirname, '../rules/claude/settings.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-listener-'));
let count = 0;
const SESSION = '3f2b9c1e-7a1d-4c55-9e0a-2b8d6f1c0a11';
const base = { session_id: SESSION, transcript_path: `/Users/me/.claude/projects/-work-app/${SESSION}.jsonl`, cwd: '/work/app', permission_mode: 'default' };
const events = {
  prompt: { ...base, hook_event_name: 'UserPromptSubmit', prompt: '  Fix the login\n page   so it redirects after sign-in, and add a regression test for the redirect please  ', session_title: '' },
  prompt2: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Also update the README' },
  permission: { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', title: 'Claude Code', notification_type: 'permission_prompt' },
  question: { ...base, hook_event_name: 'Notification', message: 'Claude has a question for you', notification_type: 'elicitation_dialog' },
  idle: { ...base, hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' },
  stop: { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done: the login page now redirects. Tests pass.' },
  failure: { ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'Rate limit reached, resets 5pm', last_assistant_message: '' },
  end: { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
  other: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
  tool: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok', stderr: '', interrupted: false }, tool_use_id: 'toolu_01' },
  toolFailure: { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1', tool_use_id: 'toolu_02' },
};

function dataDir() {
  const dir = path.join(tmp, `data-${count += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

function configure(dir, url, token = TOKEN) {
  fs.writeFileSync(path.join(dir, 'attention-client.json'), JSON.stringify({ url, token }), { mode: 0o600 });
}

function spawnAndFeed(command, args, env, input) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function hook(dir, input, env = {}) {
  return spawnAndFeed(process.execPath, [HOOK], { PATH: process.env.PATH, HOME: path.join(tmp, 'no-home'), TAGENT_HOME: dir, ...env }, input);
}

const ref = `/api/attention/by-ref/${encodeURIComponent(`claude:${SESSION}`)}`;
// The status part of a body, without the context recall fields (checked in their own tests).
const core = body => { const { context, activity, excerpt, plain_turn_end, ...rest } = body || {}; return rest; }; // eslint-disable-line no-unused-vars
const coreOf = request => ({ ...request, body: core(request.body) });

test('one task per session: the first prompt creates it with a title, later events only change status and reason', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  try {
    const first = await hook(dir, events.prompt);
    assert.deepEqual([first.code, first.out], [0, ''], 'prints nothing (UserPromptSubmit output would become Claude context)');
    assert.equal(fake.requests.length, 2, 'a lookup by ref, then the create with the title');
    assert.deepEqual([fake.requests[0].method, fake.requests[0].path, fake.requests[0].auth], ['GET', ref, `Bearer ${TOKEN}`]);
    assert.deepEqual([fake.requests[1].method, fake.requests[1].path], ['PUT', ref]);
    assert.deepEqual(core(fake.requests[1].body), {
      status: 'working', attention_reason: null, meta: { host: os.hostname(), cwd: '/work/app' }, source: 'claude',
      title: 'Fix the login page so it redirects after sign-in, and add a regression test f...',
    });
    assert.equal(Array.from(fake.requests[1].body.title).length, 80);
    const [item] = fake.items.values();
    assert.equal(item.external_ref, `claude:${SESSION}`);

    item.title = 'Renamed by the user';
    const steps = [
      [events.permission, { status: 'waiting_user', attention_reason: 'Claude needs your permission to use Bash', source: 'claude' }],
      [events.prompt2, { status: 'working', attention_reason: null, meta: { host: os.hostname(), cwd: '/work/app' }, source: 'claude' }],
      [events.question, { status: 'waiting_user', attention_reason: 'Claude has a question for you', source: 'claude' }],
      [events.stop, { status: 'review', attention_reason: 'Done: the login page now redirects. Tests pass.', source: 'claude' }],
      [events.failure, { status: 'failed', attention_reason: 'API error: rate_limit (Rate limit reached, resets 5pm)', source: 'claude' }],
    ];
    for (const [input, body] of steps) {
      const before = fake.requests.length;
      const result = await hook(dir, input);
      assert.deepEqual([result.code, result.out], [0, '']);
      assert.equal(fake.requests.length, before + 2, `${input.hook_event_name}: lookup and update`);
      assert.deepEqual(fake.requests.at(-2).method + ' ' + fake.requests.at(-2).path, `GET ${ref}`);
      assert.deepEqual(coreOf(fake.requests.at(-1)), { method: 'PUT', path: ref, query: {}, auth: `Bearer ${TOKEN}`, body });
    }
    assert.equal(item.title, 'Renamed by the user', 'the title is never sent for an existing task');
    assert.equal(fake.items.size, 1);
  } finally {
    await fake.close();
  }
});

test('Notification types that do not wait for the user and other events send nothing', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  try {
    for (const input of [events.idle, events.other, { ...events.stop, session_id: '' }]) {
      assert.deepEqual(await hook(dir, input).then(r => [r.code, r.out]), [0, '']);
    }
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('a Stop for a session never seen creates the task with a fallback title (review, never done)', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  try {
    await hook(dir, events.stop);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1].body.title, 'Claude session in app');
    assert.equal([...fake.items.values()][0].status, 'review');
  } finally {
    await fake.close();
  }
});

test('SessionEnd moves a working or waiting task to review and leaves the others alone', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  try {
    await hook(dir, events.prompt);
    const [item] = fake.items.values();
    let before = fake.requests.length;
    await hook(dir, events.end);
    assert.deepEqual(fake.requests.slice(before).map(r => [r.method, r.path, r.query, core(r.body)]), [
      ['GET', ref, {}, {}],
      ['PATCH', `/api/attention/${item.id}`, {}, { status: 'review', source: 'claude' }],
    ]);
    assert.deepEqual(fake.requests.at(-1).body.activity, { kind: 'session_end', text: 'Session ended (prompt_input_exit)' });
    assert.equal(item.status, 'review');

    before = fake.requests.length;
    await hook(dir, events.end);
    assert.deepEqual(fake.requests.slice(before).map(r => [r.method, r.body]), [['GET', undefined], ['PATCH', { source: 'claude', activity: { kind: 'session_end', text: 'Session ended (prompt_input_exit)' } }]], 'already in review: only the timeline entry');
    await hook(dir, { ...events.end, session_id: 'never-seen' });
    assert.equal(fake.items.size, 1, 'SessionEnd never creates a task');
  } finally {
    await fake.close();
  }
});

test('no config, a disabled listener or bad input: no request, exit 0', async () => {
  const fake = await fakeServer();
  try {
    const empty = dataDir();
    assert.deepEqual(await hook(empty, events.prompt).then(r => [r.code, r.out]), [0, '']);
    const dir = dataDir();
    configure(dir, fake.url);
    assert.deepEqual(await hook(dir, events.prompt, { TA_ATTENTION_LISTENER: '0' }).then(r => [r.code, r.out]), [0, '']);
    assert.deepEqual(await hook(dir, 'not json').then(r => [r.code, r.out]), [0, '']);
    assert.equal(fake.requests.length, 0);
    // The environment config works without a file, as for the CLI.
    await hook(empty, events.permission, { TA_ATTENTION_URL: fake.url, TA_ATTENTION_TOKEN: TOKEN });
    assert.equal(fake.requests.length, 2);
  } finally {
    await fake.close();
  }
});

test('a server that hangs, is down or refuses the token: exit 0 within the 2 s budget, error in the log', async () => {
  const slow = await fakeServer({ handler: () => true });
  const fake = await fakeServer();
  try {
    const dir = dataDir();
    configure(dir, slow.url);
    const hung = await hook(dir, events.prompt);
    assert.deepEqual([hung.code, hung.out], [0, '']);
    assert.ok(hung.ms < 2800, `gave up after ${hung.ms} ms`);
    const logFile = path.join(dir, 'listeners', 'claude.log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /UserPromptSubmit 3f2b9c1e-[^ ]+: timeout The server did not answer/);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

    const downDir = dataDir();
    configure(downDir, 'http://127.0.0.1:9');
    const down = await hook(downDir, events.stop);
    assert.deepEqual([down.code, down.out], [0, '']);
    assert.ok(down.ms < 1500, `failed fast: ${down.ms} ms`);
    assert.match(fs.readFileSync(path.join(downDir, 'listeners', 'claude.log'), 'utf8'), /Stop .*network Cannot reach the server/);

    const deniedDir = dataDir();
    configure(deniedDir, fake.url, 'tatt_revoked');
    assert.equal((await hook(deniedDir, events.stop)).code, 0);
    const log = fs.readFileSync(path.join(deniedDir, 'listeners', 'claude.log'), 'utf8');
    assert.match(log, /auth Invalid token/);
    assert.ok(!log.includes('tatt_revoked'), 'the token is never logged');
  } finally {
    slow.server.closeAllConnections();
    await Promise.all([slow.close(), fake.close()]);
  }
});

test('after a prompt left the task waiting_user, the next tool event sets it back to working once', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  const stateFile = path.join(dir, 'listeners', 'claude-state', `${SESSION}.json`);
  try {
    await hook(dir, events.prompt);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status, 'working');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    await hook(dir, events.permission);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status, 'waiting_user');
    const [item] = fake.items.values();
    assert.equal(item.status, 'waiting_user');

    let before = fake.requests.length;
    const resumed = await hook(dir, events.tool);
    assert.deepEqual([resumed.code, resumed.out], [0, '']);
    assert.deepEqual(fake.requests.slice(before), [{ method: 'PUT', path: ref, query: {}, auth: `Bearer ${TOKEN}`, body: { status: 'working', attention_reason: null, source: 'claude', context: { pending: null }, activity: { kind: 'resumed', text: 'Claude continued (Bash)' } } }]);
    assert.deepEqual([item.status, item.attention_reason], ['working', null]);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status, 'working');

    before = fake.requests.length;
    await hook(dir, events.tool);
    await hook(dir, events.toolFailure);
    assert.equal(fake.requests.length, before, 'no request on later tool calls');

    await hook(dir, events.question);
    before = fake.requests.length;
    await hook(dir, events.toolFailure);
    assert.equal(fake.requests.length, before + 1, 'a failed tool call also means Claude went on');
    assert.equal(item.status, 'working');
  } finally {
    await fake.close();
  }
});

test('tool events make no request when the session is not waiting, unknown, or its task is gone', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  const stateDir = path.join(dir, 'listeners', 'claude-state');
  try {
    await hook(dir, events.tool);
    assert.equal(fake.requests.length, 0, 'no state for this session');
    await hook(dir, events.prompt);
    await hook(dir, events.stop);
    let before = fake.requests.length;
    for (let i = 0; i < 3; i += 1) await hook(dir, events.tool);
    assert.equal(fake.requests.length, before, 'state review: nothing to send');

    // The user deleted the task while Claude waited: the resume does not create it again and forgets the session.
    await hook(dir, events.permission);
    fake.items.clear();
    before = fake.requests.length;
    await hook(dir, events.tool);
    assert.equal(fake.requests.length, before + 1);
    assert.equal(fake.items.size, 0);
    assert.equal(fs.existsSync(path.join(stateDir, `${SESSION}.json`)), false);

    // A server that is down while waiting: still exit 0 fast.
    const downDir = dataDir();
    configure(downDir, 'http://127.0.0.1:9');
    fs.mkdirSync(path.join(downDir, 'listeners', 'claude-state'), { recursive: true });
    fs.writeFileSync(path.join(downDir, 'listeners', 'claude-state', `${SESSION}.json`), JSON.stringify({ status: 'waiting_user' }));
    const down = await hook(downDir, events.tool);
    assert.deepEqual([down.code, down.out], [0, '']);
    assert.ok(down.ms < 1500);
  } finally {
    await fake.close();
  }
});

test('SessionEnd removes the session state; states older than 2 days are pruned; odd session ids get a hashed file name', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  const stateDir = path.join(dir, 'listeners', 'claude-state');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const old = path.join(stateDir, 'old-session.json');
    const fresh = path.join(stateDir, 'fresh-session.json');
    fs.writeFileSync(old, '{"status":"waiting_user"}');
    fs.writeFileSync(fresh, '{"status":"waiting_user"}');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(old, threeDaysAgo, threeDaysAgo);

    await hook(dir, events.prompt);
    assert.equal(fs.existsSync(old), false, 'pruned');
    assert.equal(fs.existsSync(fresh), true);
    await hook(dir, events.end);
    assert.equal(fs.existsSync(path.join(stateDir, `${SESSION}.json`)), false);

    await hook(dir, { ...events.prompt, session_id: '../../escape' });
    const names = fs.readdirSync(stateDir);
    assert.ok(names.some(name => /^[0-9a-f]{64}\.json$/.test(name)), names.join(','));
    assert.equal(fs.existsSync(path.join(dir, 'escape.json')), false);
  } finally {
    await fake.close();
  }
});

test('an older server without GET by-ref: the hook falls back to the list and still sends the title only on create', async () => {
  const fake = await fakeServer({ legacy: true });
  const dir = dataDir();
  configure(dir, fake.url);
  try {
    await hook(dir, events.prompt);
    assert.deepEqual(fake.requests.map(r => r.method), ['GET', 'GET', 'PUT']);
    assert.ok(fake.requests[2].body.title);
    await hook(dir, events.permission);
    assert.equal(fake.requests.at(-1).body.title, undefined);
    assert.equal([...fake.items.values()][0].status, 'waiting_user');
    await hook(dir, events.end);
    assert.equal(fake.requests.at(-1).method, 'PATCH');
    assert.equal([...fake.items.values()][0].status, 'review');
  } finally {
    await fake.close();
  }
});

test('rules/claude/settings.json adds the listener next to the terminal-activity hooks, for the mapped events', () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const listener = group => group.hooks.some(h => h.command.includes('listeners/claude-hook.path'));
  for (const name of ['UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']) {
    const groups = settings.hooks[name];
    assert.equal(groups.filter(listener).length, 1, `${name} has the listener once`);
    for (const group of groups.filter(listener)) assert.equal(group.hooks[0].timeout, 5);
  }
  for (const name of ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd']) {
    assert.ok(settings.hooks[name].some(group => group.hooks.some(h => h.command.includes('$TA_HOOK_URL'))), `${name} keeps the terminal-activity hook`);
  }
  for (const name of ['PostToolUse', 'PostToolUseFailure']) {
    const groups = settings.hooks[name].filter(listener);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, '*', `${name} for every tool`);
  }
  const notification = settings.hooks.Notification.find(listener);
  assert.deepEqual(notification.matcher.split('|').sort(), ['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog', 'permission_prompt', 'worker_permission_prompt']);
});

test('the distributed hook command finds the hook through the data folder and is harmless when anything is missing', async () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const command = settings.hooks.Stop.find(group => group.hooks[0].command.includes('claude-hook.path')).hooks[0].command;
  const fake = await fakeServer();
  const nodeDir = path.dirname(process.execPath);
  try {
    // Default data folder under HOME, as `t-attention login` leaves it.
    const home = path.join(tmp, `home-${count += 1}`);
    fs.mkdirSync(path.join(home, '.tagent', 'listeners'), { recursive: true });
    configure(path.join(home, '.tagent'), fake.url);
    fs.writeFileSync(path.join(home, '.tagent', 'listeners', 'claude-hook.path'), `${HOOK}\n`);
    const env = { PATH: `${nodeDir}:/usr/bin:/bin`, HOME: home };
    const ran = await spawnAndFeed('/bin/sh', ['-c', command], env, events.stop);
    assert.deepEqual([ran.code, ran.out], [0, '']);
    assert.equal(fake.requests.length, 2, 'the hook ran and created the task');

    // TAGENT_HOME moves the data folder for the command too.
    const moved = dataDir();
    fs.mkdirSync(path.join(moved, 'listeners'));
    configure(moved, fake.url);
    fs.writeFileSync(path.join(moved, 'listeners', 'claude-hook.path'), `${HOOK}\n`);
    await spawnAndFeed('/bin/sh', ['-c', command], { ...env, HOME: path.join(tmp, 'nowhere'), TAGENT_HOME: moved }, { ...events.stop, session_id: 'moved' });
    assert.equal(fake.requests.length, 4);

    const before = fake.requests.length;
    const noPointer = await spawnAndFeed('/bin/sh', ['-c', command], { PATH: env.PATH, HOME: path.join(tmp, 'empty-home') }, events.stop);
    assert.deepEqual([noPointer.code, noPointer.out], [0, '']);
    fs.writeFileSync(path.join(home, '.tagent', 'listeners', 'claude-hook.path'), '/gone/t-agent/plugins/listeners/claude/hook.js\n');
    const stale = await spawnAndFeed('/bin/sh', ['-c', command], env, events.stop);
    assert.deepEqual([stale.code, stale.out], [0, '']);
    fs.writeFileSync(path.join(home, '.tagent', 'listeners', 'claude-hook.path'), `${HOOK}\n`);
    const catOnly = path.join(tmp, 'cat-only-bin');
    fs.mkdirSync(catOnly, { recursive: true });
    if (!fs.existsSync(path.join(catOnly, 'cat'))) fs.symlinkSync(fs.existsSync('/bin/cat') ? '/bin/cat' : '/usr/bin/cat', path.join(catOnly, 'cat'));
    const noNode = await spawnAndFeed('/bin/sh', ['-c', command], { PATH: catOnly, HOME: home }, events.stop);
    assert.deepEqual([noNode.code, noNode.out], [0, '']);
    assert.equal(fake.requests.length, before);
  } finally {
    await fake.close();
  }
});

test('the manifest describes a listener plugin', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../plugins/listeners/claude/manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'claude');
  assert.equal(manifest.kind, 'listener');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
  assert.ok(fs.existsSync(path.resolve(__dirname, '../plugins/listeners/claude', manifest.entry)));
});

test('in a T-Agent terminal the command uses $TA_ATTENTION_HOOK when the hook path file is missing, with the URL and token from the environment', async () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const command = settings.hooks.Stop.find(group => group.hooks[0].command.includes('claude-hook.path')).hooks[0].command;
  const fake = await fakeServer();
  try {
    const home = path.join(tmp, `home-${count += 1}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TA_ATTENTION_HOOK: HOOK, TA_ATTENTION_URL: fake.url, TA_ATTENTION_TOKEN: TOKEN };
    const ran = await spawnAndFeed('/bin/sh', ['-c', command], env, { ...events.stop, session_id: 'terminal-env' });
    assert.deepEqual([ran.code, ran.out], [0, '']);
    assert.equal(fake.requests.length, 2, 'no data folder, no login: the terminal environment is enough');
    const missing = await spawnAndFeed('/bin/sh', ['-c', command], { ...env, TA_ATTENTION_HOOK: path.join(tmp, 'gone.js') }, { ...events.stop, session_id: 'gone' });
    assert.deepEqual([missing.code, missing.out], [0, '']);
    assert.equal(fake.requests.length, 2);
  } finally {
    await fake.close();
  }
});

test('an older listener entry does nothing when the same event in ~/.claude/settings.json also has the current one', async () => {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  const home = path.join(tmp, `home-${count += 1}`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const current = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hooks.Stop.find(group => group.hooks[0].command.includes('claude-hook.path'));
  try {
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [current] } }));
    // The older entry runs `node <hook>` without the mark.
    await hook(dir, { ...events.stop, session_id: 'old-entry' }, { HOME: home });
    assert.equal(fake.requests.length, 0, 'the current entry reports this event');
    await hook(dir, { ...events.stop, session_id: 'new-entry' }, { HOME: home, TA_ATTENTION_ENTRY: '2' });
    assert.equal(fake.requests.length, 2, 'the current entry runs');
    // Another event without the current entry: the older entry still reports it.
    await hook(dir, { ...events.prompt, session_id: 'old-entry' }, { HOME: home });
    assert.equal(fake.requests.length, 4);
    // CLAUDE_CONFIG_DIR moves the Claude settings.
    await hook(dir, { ...events.stop, session_id: 'moved' }, { HOME: path.join(tmp, 'nowhere'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
    assert.equal(fake.requests.length, 4);
  } finally {
    await fake.close();
  }
});

// ---------- sub-agents: one notice after the last one ----------
const FINISHED = { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
const WORKING = { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } };

// A transcript and a real `subagents` folder next to it, as Claude Code leaves them.
function sessionLogs() {
  const root = path.join(tmp, `logs-${count += 1}`);
  fs.mkdirSync(root);
  const transcript = path.join(root, `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'Run three reviews' } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Started them.' }] } })}\n`);
  const folder = path.join(root, SESSION, 'subagents');
  const write = (name, row, ageMs = 0) => {
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `agent-${name}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'go' } })}\n${JSON.stringify(row)}\n`);
    if (ageMs) { const when = new Date(Date.now() - ageMs); fs.utimesSync(file, when, when); }
  };
  return { transcript, folder, write };
}

async function withListener(run) {
  const fake = await fakeServer();
  const dir = dataDir();
  configure(dir, fake.url);
  try {
    const [item] = (await hook(dir, events.prompt), [...fake.items.values()]);
    await run({ fake, dir, item, state: () => JSON.parse(fs.readFileSync(path.join(dir, 'listeners', 'claude-state', `${SESSION}.json`), 'utf8')) });
  } finally {
    await fake.close();
  }
}

const stopWith = transcript => ({ ...events.stop, transcript_path: transcript });

test('Stop with no sub-agent log, or with only finished sub-agents, goes to review as before', async () => {
  await withListener(async ({ fake, dir, item }) => {
    const logs = sessionLogs();
    await hook(dir, stopWith(logs.transcript)); // no subagents folder
    assert.equal(item.status, 'review');
    assert.ok(fake.requests.at(-1).body.excerpt, 'the excerpt of a transition');
    await hook(dir, events.prompt2);
    logs.write('a1', FINISHED);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(item.status, 'review');
  });
  await withListener(async ({ dir, item }) => {
    await hook(dir, { ...events.stop, transcript_path: undefined });
    assert.equal(item.status, 'review', 'no transcript path: count 0');
  });
});

test('Stop while a sub-agent runs stays working: no review, no reason, no excerpt, a timeline note', async () => {
  await withListener(async ({ fake, dir, item, state }) => {
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    const { body } = fake.requests.at(-1);
    assert.deepEqual(core(body), { status: 'working', attention_reason: null, source: 'claude' });
    assert.deepEqual(body.activity, { kind: 'note', text: 'Waiting for 1 sub-agent' });
    assert.equal(body.excerpt, undefined);
    assert.equal(body.context.files, undefined);
    assert.equal(body.context.pending, null);
    assert.equal(body.context.last_reply, 'Done: the login page now redirects. Tests pass.');
    assert.deepEqual([item.status, item.attention_reason], ['working', null]);
    assert.equal(state().status, 'working');
    assert.equal(state().pending, null);
  });
});

test('three sub-agents finishing one by one, a Stop after each: only the last Stop goes to review, once', async () => {
  await withListener(async ({ fake, dir, item, state }) => {
    const logs = sessionLogs();
    for (const name of ['a1', 'a2', 'a3']) logs.write(name, WORKING);
    const seen = [];
    const stop = async () => {
      await hook(dir, stopWith(logs.transcript));
      const { body } = fake.requests.at(-1);
      seen.push([item.status, body.activity.text, Boolean(body.excerpt)]);
    };
    await stop();
    logs.write('a1', FINISHED);
    await stop();
    logs.write('a2', FINISHED);
    await stop();
    logs.write('a3', FINISHED);
    await stop();
    assert.deepEqual(seen, [
      ['working', 'Waiting for 3 sub-agents', false],
      ['working', 'Waiting for 2 sub-agents', false],
      ['working', 'Waiting for 1 sub-agent', false],
      ['review', 'Done: the login page now redirects. Tests pass.', true],
    ]);
    assert.equal(item.attention_reason, 'Done: the login page now redirects. Tests pass.');
    assert.equal(state().status, 'review');
    assert.equal(fake.requests.filter(r => r.method === 'PUT' && r.body.status === 'review').length, 1, 'one move to review');
  });
});

test('a plain Stop carries plain_turn_end on the update and never in the context; so does a Stop of a session never seen', async () => {
  await withListener(async ({ fake, dir, item, state }) => {
    const logs = sessionLogs();
    await hook(dir, stopWith(logs.transcript));
    const { body } = fake.requests.at(-1);
    assert.equal(body.plain_turn_end, true);
    assert.equal(body.status, 'review');
    assert.equal('plain_turn_end' in body.context, false, 'not part of the context');
    assert.equal(item.status, 'review');
    assert.equal(state().held_stop, false);
  });
  const fake = await fakeServer();
  try {
    const dir = dataDir();
    configure(dir, fake.url);
    await hook(dir, events.stop);
    assert.equal(fake.requests.at(-1).body.plain_turn_end, true, 'first seen at its Stop');
  } finally {
    await fake.close();
  }
});

test('a Stop held for sub-agents, then the final Stop: neither carries the marker, also with wake-up prompts in between', async () => {
  await withListener(async ({ fake, dir, item, state }) => {
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(fake.requests.at(-1).body.plain_turn_end, undefined);
    assert.equal(state().held_stop, true);
    logs.write('a1', FINISHED);
    await hook(dir, { ...events.prompt2, prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' });
    assert.equal(state().held_stop, true, 'a wake-up is not the user\'s prompt');
    await hook(dir, stopWith(logs.transcript));
    const { body } = fake.requests.at(-1);
    assert.deepEqual([body.status, body.plain_turn_end], ['review', undefined]);
    assert.equal(item.status, 'review');
    assert.equal(state().held_stop, false, 'cleared when the review is written');
    // The next turn is plain again.
    await hook(dir, events.prompt2);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(fake.requests.at(-1).body.plain_turn_end, true);
  });
});

test('a wake-up wrapped in a system reminder counts too; a Stop held before a failed update is still remembered', async () => {
  await withListener(async ({ dir, state }) => {
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    await hook(dir, { ...events.prompt2, prompt: '<system-reminder>\nA task ended.\n<task-notification><task-id>a1</task-id></task-notification>\n</system-reminder>' });
    assert.equal(state().held_stop, true);
  });
  const fake = await fakeServer();
  try {
    const dir = dataDir();
    configure(dir, 'http://127.0.0.1:1');
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'listeners', 'claude-state', `${SESSION}.json`), 'utf8'));
    assert.equal(saved.held_stop, true, 'the server was down, the hold counts');
    configure(dir, fake.url);
    logs.write('a1', FINISHED);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(fake.requests.at(-1).body.plain_turn_end, undefined);
  } finally {
    await fake.close();
  }
});

test('a real prompt clears a held Stop: the next Stop is a plain turn end', async () => {
  await withListener(async ({ fake, dir, state }) => {
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(state().held_stop, true);
    await hook(dir, events.prompt2);
    assert.equal(state().held_stop, false);
    logs.write('a1', FINISHED);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(fake.requests.at(-1).body.plain_turn_end, true);
  });
});

test('SessionEnd moving a busy session to review sends no marker', async () => {
  await withListener(async ({ fake, dir, item }) => {
    await hook(dir, events.end);
    assert.equal(item.status, 'review');
    assert.equal(fake.requests.at(-1).body.plain_turn_end, undefined);
  });
});

test('a crashed sub-agent stops counting once its log is stale, and the next Stop goes to review', async () => {
  await withListener(async ({ dir, item }) => {
    const { SUBAGENT_STALE_MS } = require('../lib/agent-sessions');
    const logs = sessionLogs();
    logs.write('crashed', WORKING, SUBAGENT_STALE_MS + 60000);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(item.status, 'review');
  });
});

test('a session whose logs are held back still ends: SessionEnd moves the working task to review', async () => {
  await withListener(async ({ dir, item }) => {
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(item.status, 'working');
    await hook(dir, { ...events.end, transcript_path: logs.transcript });
    assert.equal(item.status, 'review');
  });
});

test('while sub-agents run a question still reaches the user, and a failure is still reported', async () => {
  await withListener(async ({ fake, dir, item }) => {
    const logs = sessionLogs();
    logs.write('a1', WORKING);
    await hook(dir, stopWith(logs.transcript));
    assert.equal(item.status, 'working');
    await hook(dir, { ...events.permission, transcript_path: logs.transcript });
    assert.equal(item.status, 'waiting_user');
    assert.equal(fake.requests.at(-1).body.attention_reason, 'Claude needs your permission to use Bash');
    assert.ok(fake.requests.at(-1).body.excerpt);
    await hook(dir, { ...events.failure, transcript_path: logs.transcript });
    assert.equal(item.status, 'failed');
  });
});

test('counting sub-agent logs is quick: 200 recent logs of 1 MiB each', () => {
  const { runningSubagents } = require(HOOK);
  const logs = sessionLogs();
  logs.write('seed', WORKING);
  const padding = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1024 * 1024) } })}\n${JSON.stringify(WORKING)}\n`;
  for (let i = 0; i < 200; i += 1) fs.writeFileSync(path.join(logs.folder, `agent-big${i}.jsonl`), padding);
  const started = Date.now();
  assert.equal(runningSubagents(logs.transcript), 201);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  assert.equal(runningSubagents('/no/such/place.jsonl'), 0);
  assert.equal(runningSubagents(undefined), 0);
  assert.equal(runningSubagents('/not/a/transcript'), 0);
});

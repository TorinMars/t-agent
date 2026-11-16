// `tcli notify` (scripts/tcli-notify.js) and its relay /api/tcli/notify (routes/tcli-notify.js) with the real attention-notify service and fake
// notifiers on loopback (never Telegram): the terminal credential, the From line made on the server, the default link, the switch (403), nothing
// set up (409), bad input (400 / 413), the status route, and the CLI output and exit codes, spawned as a terminal runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionNotify } = require('../services/attention-notify');
const { createNotifyRelayRouter } = require('../routes/tcli-notify');
const { formatResults, describe } = require('../scripts/tcli-notify');

const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const SECRET = 'tcli-notify-test-secret-0123456789abcdef';
const HOOK = { task: '12', terminal: 'term-a', token: 'c'.repeat(64) };
const hookHeaders = (hook = HOOK) => ({ 'X-T-Agent-Task': hook.task, 'X-T-Agent-Terminal': hook.terminal, 'X-T-Agent-Token': hook.token });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tcli-notify-'));

const db = new Database(':memory:');
db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT, title TEXT)');
db.prepare("INSERT INTO tasks (id, user_id, title) VALUES (12, 'owner', 'Fix the CI build')").run();

// Two fake notifiers that take direct messages. `behaviour.fail` makes one throw, `ready` takes it out.
const behaviour = { fake: { ready: true, fail: null }, mail: { ready: true, fail: null } };
const calls = [];
const fakePlugin = name => ({
  name, label: name, configFields: [], direct: true,
  ready: () => behaviour[name].ready,
  async notify(args) { if (behaviour[name].fail) throw new Error(behaviour[name].fail); calls.push({ name, ...args }); return { outcome: 'sent' }; },
  async test() { return { ok: true }; },
});
let clock = Date.parse('2026-11-16T12:00:00Z');
const service = createAttentionNotify({ db, sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [fakePlugin('fake'), fakePlugin('mail')], log: () => {}, now: () => clock });
const terminalNames = [];
let base;
let server;

test.before(async () => {
  const app = express();
  app.use('/api/tcli', createNotifyRelayRouter({
    db, notify: () => service, owner: () => 'owner',
    verifyToken: (task, terminal, token) => task === 12 && terminal === HOOK.terminal && token === HOOK.token,
    terminalName: (taskId, terminalId) => { terminalNames.push([taskId, terminalId]); return 'Claude 1'; },
  }));
  app.use((req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(work, { recursive: true, force: true }); });
test.beforeEach(() => {
  calls.length = 0;
  clock += 5 * 60 * 1000; // past the 60 s dedupe of the last test
  behaviour.fake = { ready: true, fail: null };
  behaviour.mail = { ready: true, fail: null };
  service.saveRules('owner', { agentMessages: true, quietHours: { enabled: false }, publicUrl: '', rateLimit: { message: 200 } });
});

async function call(method, route, { headers = hookHeaders(), body, raw } = {}) {
  const response = await fetch(`${base}/api/tcli${route}`, {
    method, headers: { ...headers, ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
// The CLI as a terminal runs it: only the variables a T-Agent shell has (never the ones of the shell running this test).
function terminalEnv(overrides = {}) {
  return { PATH: process.env.PATH, HOME: work, TA_HOOK_URL: `${base}/hooks/terminal-activity?task=${HOOK.task}&terminal=${HOOK.terminal}`, TA_HOOK_TOKEN: HOOK.token, ...overrides };
}
function run(args, { env = terminalEnv(), input } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: work });
    const out = []; const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

test('the relay takes only terminal requests with a valid token', async () => {
  assert.deepEqual(await call('POST', '/notify', { headers: {}, body: { text: 'x' } }), { status: 418, body: { error: 'PASSED_ON' } }, 'no terminal headers: passed on');
  const missing = await call('POST', '/notify', { headers: { 'X-T-Agent-Task': '12' }, body: { text: 'x' } });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'TCLI_AUTH_REQUIRED');
  const wrong = await call('POST', '/notify', { headers: hookHeaders({ ...HOOK, token: 'd'.repeat(64) }), body: { text: 'x' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'TCLI_AUTH_INVALID');
  assert.equal((await call('GET', '/notify/status', { headers: hookHeaders({ ...HOOK, terminal: 'other' }) })).status, 403);
  assert.equal(calls.length, 0);
  // Not from this machine: passed on untouched.
  const app = express();
  app.use('/api/tcli', createNotifyRelayRouter({ db, notify: () => service, owner: () => 'owner', isLocal: () => false, verifyToken: () => true, terminalName: () => '' }));
  app.use((req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  const remote = http.createServer(app);
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${remote.address().port}/api/tcli/notify`, { method: 'POST', headers: { ...hookHeaders(), 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(response.status, 418);
  } finally { remote.closeAllConnections(); remote.close(); }
});

test('the From line is made on the server from the task and the terminal, and the link is the page under publicUrl', async () => {
  const sent = await call('POST', '/notify', { body: { text: 'Done', title: 'Build', from: 'Spoofed sender', via: ['fake'] } });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { results: [{ notifier: 'fake', outcome: 'sent' }] });
  assert.deepEqual(calls[0].message, { title: 'Build', text: 'Done', from: 'Fix the CI build · Claude 1' });
  assert.equal(calls[0].link, '', 'no publicUrl: no link');
  assert.deepEqual(terminalNames.at(-1), [12, 'term-a']);
  service.saveRules('owner', { publicUrl: 'https://t.example.com' });
  await call('POST', '/notify', { body: { text: 'Linked', via: ['fake'] } });
  assert.equal(calls[1].link, 'https://t.example.com/');
  await call('POST', '/notify', { body: { text: 'Own link', via: ['fake'], link: 'https://ci.example.com/run/7' } });
  assert.equal(calls[2].link, 'https://ci.example.com/run/7');
});

test('the switch off is 403, nothing set up is 409, and bad input is 400 or 413', async () => {
  service.saveRules('owner', { agentMessages: false });
  const off = await call('POST', '/notify', { body: { text: 'x' } });
  assert.equal(off.status, 403);
  assert.deepEqual(off.body, { error: 'NOTIFY_AGENT_ACCESS_OFF', message: 'Agent messages are turned off in Settings → T-Attention → Rules for all notifiers' });
  assert.equal((await call('GET', '/notify/status')).body.agentMessages, false, 'the status still answers');
  service.saveRules('owner', { agentMessages: true });
  behaviour.fake.ready = false;
  behaviour.mail.ready = false;
  const none = await call('POST', '/notify', { body: { text: 'x' } });
  assert.equal(none.status, 409);
  assert.deepEqual(none.body, { error: 'NOTIFY_NOT_CONFIGURED', message: 'No notifier can send messages. Set up Telegram or email in Settings → T-Attention' });
  behaviour.fake.ready = true;
  for (const [body, code] of [[{}, 'TEXT_REQUIRED'], [{ text: 'x'.repeat(3001) }, 'TEXT_TOO_LONG'], [{ text: 'x', via: 'Bad!' }, 'INVALID_VIA'], [{ text: 'x', link: 'file:///etc/passwd' }, 'INVALID_LINK']]) {
    const refused = await call('POST', '/notify', { body });
    assert.equal(refused.status, 400, code);
    assert.equal(refused.body.error, code);
  }
  assert.deepEqual(await call('POST', '/notify', { raw: '{not json' }), { status: 400, body: { error: 'INVALID_REQUEST', message: 'Invalid JSON body' } });
  const big = await call('POST', '/notify', { raw: JSON.stringify({ text: 'x'.repeat(17 * 1024) }) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'PAYLOAD_TOO_LARGE');
  assert.equal(calls.length, 0);
  assert.equal((await call('GET', '/notify/nope')).status, 404);
});

test('the status route names each notifier, quiet hours and the switch', async () => {
  behaviour.mail.ready = false;
  service.saveRules('owner', { quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC' } });
  const status = await call('GET', '/notify/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, {
    agentMessages: true,
    quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC', active: true },
    notifiers: [{ name: 'fake', label: 'fake', enabled: true, ready: true }, { name: 'mail', label: 'mail', enabled: true, ready: false }],
  });
  const cli = await run(['notify', 'status']);
  assert.equal(cli.code, 0);
  assert.equal(cli.out, ['Agent messages  on', 'Quiet hours     00:00-23:59 UTC, now (nothing is sent)', 'fake            ready', 'mail            not set up', ''].join('\n'));
  assert.deepEqual(JSON.parse((await run(['notify', 'status', '--json'])).out), status.body);
});

test('CLI: the text from arguments, stdin and a file; one line per notifier; exit 0', async () => {
  const sent = await run(['notify', 'The', 'long', 'build', 'finished', '--title', 'CI']);
  assert.equal(sent.code, 0, sent.err);
  assert.equal(sent.out, 'fake  sent\nmail  sent\n');
  assert.deepEqual(calls.map(entry => [entry.name, entry.message.title, entry.message.text, entry.message.from]), [['fake', 'CI', 'The long build finished', 'Fix the CI build · Claude 1'], ['mail', 'CI', 'The long build finished', 'Fix the CI build · Claude 1']]);
  const piped = await run(['notify', '-', '--via', 'mail'], { input: 'From stdin\nline two\n' });
  assert.equal(piped.code, 0, piped.err);
  assert.equal(piped.out, 'mail  sent\n');
  assert.equal(calls.at(-1).message.text, 'From stdin\nline two');
  const file = path.join(work, 'note.md');
  fs.writeFileSync(file, 'From a file');
  const fromFile = await run(['notify', '--file', 'note.md', '--via', 'fake', '--json']);
  assert.equal(fromFile.code, 0);
  assert.deepEqual(JSON.parse(fromFile.out), { results: [{ notifier: 'fake', outcome: 'sent' }] });
  assert.equal(calls.at(-1).message.text, 'From a file');
  // `--` sends a text that starts like an option or is the word status.
  assert.equal((await run(['notify', '--', 'status'])).code, 0);
  assert.equal(calls.at(-1).message.text, 'status');
});

test('CLI: skipped by the rules exits 1 and says why; a failure exits 4; mixed with a send exits 0', async () => {
  service.saveRules('owner', { quietHours: { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC' } });
  const quiet = await run(['notify', 'at night']);
  assert.equal(quiet.code, 1);
  assert.equal(quiet.out, 'fake  skipped: quiet hours\nmail  skipped: quiet hours\n');
  assert.match(quiet.err, /not sent .*do not try again/);
  service.saveRules('owner', { quietHours: { enabled: false } });
  assert.equal((await run(['notify', 'once'])).code, 0);
  const again = await run(['notify', 'once']);
  assert.equal(again.code, 1);
  assert.match(again.out, /fake  skipped: the same message was sent less than a minute ago/);
  behaviour.fake.fail = 'smtp down';
  behaviour.mail.fail = 'smtp down';
  const failed = await run(['notify', 'broken']);
  assert.equal(failed.code, 4);
  assert.equal(failed.out, 'fake  failed: smtp down\nmail  failed: smtp down\n');
  behaviour.mail.fail = null;
  const mixed = await run(['notify', 'half']);
  assert.equal(mixed.code, 0);
  assert.equal(mixed.out, 'fake  failed: smtp down\nmail  sent\n');
});

test('CLI: the switch off exits 2, nothing set up exits 1, outside a terminal exits 2, usage errors exit 1', async () => {
  service.saveRules('owner', { agentMessages: false });
  const off = await run(['notify', 'x']);
  assert.equal(off.code, 2);
  assert.match(off.err, /Agent messages are turned off in Settings → T-Attention → Rules for all notifiers \(NOTIFY_AGENT_ACCESS_OFF\)/);
  const offJson = await run(['notify', 'x', '--json']);
  assert.equal(JSON.parse(offJson.err).error, 'NOTIFY_AGENT_ACCESS_OFF');
  service.saveRules('owner', { agentMessages: true });
  behaviour.fake.ready = false;
  behaviour.mail.ready = false;
  const none = await run(['notify', 'x']);
  assert.equal(none.code, 1);
  assert.match(none.err, /No notifier can send messages\. Set up Telegram or email in Settings → T-Attention \(NOTIFY_NOT_CONFIGURED\)/);
  const outside = await run(['notify', 'x'], { env: { PATH: process.env.PATH, HOME: work } });
  assert.equal(outside.code, 2);
  assert.match(outside.err, /tcli works inside a T-Agent terminal/);
  for (const args of [['notify', '--title', 'only a title'], ['notify', 'x'.repeat(3001)], ['notify', 'a', '--file', 'note.md'], ['notify', 'x', '--via', 'Bad!'], ['notify', '--file', 'missing.txt'], ['notify', 'x', '--bogus']]) {
    const result = await run(args);
    assert.equal(result.code, 1, `${args.join(' ')}: ${result.err}`);
  }
  assert.equal(calls.length, 0);
  const help = await run(['notify', 'help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /tcli notify <text\.\.\.>/);
  assert.match((await run(['help'])).out, /notify\s+send the user a short message/);
});

test('the output of relayed and other outcomes', () => {
  assert.equal(formatResults([{ notifier: 'telegram', outcome: 'relayed', detail: 'sent', via: 'T01' }, { notifier: 'email', outcome: 'quiet_hours' }]), 'telegram  relayed through T01 (sent)\nemail     skipped: quiet hours');
  assert.equal(describe({ notifier: 'telegram', outcome: 'relayed', detail: 'rate_limited', via: 'T01' }).text, 'relayed through T01 (skipped: hourly limit reached)');
  assert.equal(describe({ notifier: 'telegram', outcome: 'relayed', detail: 'rate_limited', via: 'T01' }).sent, false);
  assert.deepEqual(describe({ notifier: 'telegram', outcome: 'relay_failed', detail: 'The sender device needs a T-Agent update', via: 'T01' }), { text: 'failed through T01: The sender device needs a T-Agent update', sent: false, failed: true });
  assert.equal(describe({ notifier: 'telegram', outcome: 'relay_offline', detail: 'REMOTE_OFFLINE', via: 'T01' }).text, 'failed: the sender device T01 is offline');
  assert.equal(describe({ notifier: 'email', outcome: 'skipped', detail: 'turned off' }).text, 'skipped: turned off');
});

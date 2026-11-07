// t-attention CLI (scripts/t-attention.js) and lib/attention-client.js against a small fake T-Attention server.
// Every run uses a temporary HOME and its own environment, so the real ~/.tagent is never read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fakeServer, TOKEN } = require('./fixtures/attention-fake-server');

const CLI = path.resolve(__dirname, '../scripts/t-attention.js');
const HOOK = path.resolve(__dirname, '../plugins/listeners/claude/hook.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-cli-'));
let homeCount = 0;

function newHome() {
  const dir = path.join(tmp, `home-${homeCount += 1}`);
  fs.mkdirSync(dir);
  return dir;
}

function run(args, { home, env = {}, input } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home || newHome(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

const auth = fake => ({ TA_ATTENTION_URL: fake.url, TA_ATTENTION_TOKEN: TOKEN });

test('help prints usage with exit 0; no command, an unknown command or option is a usage error (1)', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: t-attention <command>/);
  assert.match(help.stdout, /Exit codes: 0 ok, 1 usage, 2 auth, 3 not found/);
  for (const line of help.stdout.split('\n')) assert.ok(line.length <= 60, `help fits a phone terminal: ${line}`);
  assert.equal((await run([])).code, 1);
  const unknown = await run(['frobnicate']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);
  assert.equal((await run(['list', '--bogus'])).code, 1);
  assert.equal((await run(['list', '--status'])).code, 1, 'a value flag without a value');
});

test('without any config the CLI says how to log in and exits 2, sending nothing', async () => {
  const result = await run(['list']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Not logged in: run t-attention login/);
  const json = await run(['list', '--json']);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.stderr).exit, 2);
});

test('login checks the token, writes <home>/.tagent/attention-client.json with mode 600 and records the Claude hook path', async () => {
  const fake = await fakeServer();
  const home = newHome();
  try {
    const bad = await run(['login', '--url', fake.url, '--token', 'tatt_wrong'], { home });
    assert.equal(bad.code, 2);
    assert.equal(fs.existsSync(path.join(home, '.tagent', 'attention-client.json')), false, 'a refused token is not saved');

    const ok = await run(['login', '--url', `${fake.url}/`, '--token', TOKEN], { home });
    assert.equal(ok.code, 0, ok.stderr);
    const file = path.join(home, '.tagent', 'attention-client.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { url: fake.url, token: TOKEN });
    assert.equal(fs.readFileSync(path.join(home, '.tagent', 'listeners', 'claude-hook.path'), 'utf8').trim(), HOOK);
    assert.ok(!ok.stdout.includes(TOKEN), 'the token is never printed');
    assert.deepEqual(fake.requests.at(-1).query, { limit: '1' });

    // The saved config is used from now on.
    const listed = await run(['list'], { home });
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(fake.requests.at(-1).auth, `Bearer ${TOKEN}`);

    const missing = await run(['login', '--url', fake.url], { home: newHome() });
    assert.equal(missing.code, 1);
    const unchecked = await run(['login', '--url', 'http://127.0.0.1:9', '--token', TOKEN, '--no-check', '--json'], { home: newHome() });
    assert.equal(unchecked.code, 0);
    assert.equal(JSON.parse(unchecked.stdout).checked, false);
  } finally {
    await fake.close();
  }
});

test('config precedence: flags > TA_ATTENTION_URL/TOKEN > file; TAGENT_HOME moves the file', async () => {
  const [fileServer, envServer, flagServer] = await Promise.all([fakeServer(), fakeServer(), fakeServer()]);
  const home = newHome();
  try {
    fs.mkdirSync(path.join(home, '.tagent'));
    fs.writeFileSync(path.join(home, '.tagent', 'attention-client.json'), JSON.stringify({ url: fileServer.url, token: TOKEN }));
    assert.equal((await run(['list'], { home })).code, 0);
    assert.equal(fileServer.requests.length, 1);
    assert.equal((await run(['list'], { home, env: { TA_ATTENTION_URL: envServer.url } })).code, 0);
    assert.equal(envServer.requests.length, 1, 'env url wins over the file; the token still comes from the file');
    assert.equal(envServer.requests[0].auth, `Bearer ${TOKEN}`);
    assert.equal((await run(['list', '--url', flagServer.url], { home, env: { TA_ATTENTION_URL: envServer.url } })).code, 0);
    assert.equal(flagServer.requests.length, 1, 'the flag wins over env');
    assert.equal((await run(['list', '--token', 'tatt_flag'], { home })).code, 2, 'the flag token wins over the file token');

    const dataHome = path.join(tmp, 'custom-data');
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'attention-client.json'), JSON.stringify({ url: envServer.url, token: TOKEN }));
    assert.equal((await run(['list'], { home, env: { TAGENT_HOME: dataHome } })).code, 0);
    assert.equal(envServer.requests.length, 2);
    assert.equal((await run(['list'], { home, env: { T_AGENT_DATA_DIR: dataHome } })).code, 0);
    assert.equal(envServer.requests.length, 3, 'the old name T_AGENT_DATA_DIR works too');
  } finally {
    await Promise.all([fileServer.close(), envServer.close(), flagServer.close()]);
  }
});

test('add, list, show, update, status verbs, upsert and rm send the contract requests', async () => {
  const fake = await fakeServer();
  const env = auth(fake);
  try {
    const added = await run(['add', 'Write', 'the', 'report', '--priority', 'high', '--due', '2026-11-20', '--notes', 'two pages', '--ref', 'ci:42', '--link', 'https://example.com', '--label', 'PR', '--json'], { env });
    assert.equal(added.code, 0, added.stderr);
    const item = JSON.parse(added.stdout);
    assert.equal(item.title, 'Write the report');
    assert.deepEqual(fake.requests.at(-1), { method: 'POST', path: '/api/attention', query: {}, auth: `Bearer ${TOKEN}`, body: { title: 'Write the report', priority: 'high', due_date: '2026-11-20', notes: 'two pages', link_url: 'https://example.com', link_label: 'PR', source: 'cli', external_ref: 'ci:42' } });
    assert.equal((await run(['add', '--priority', 'low'], { env })).code, 1, 'add needs a title');

    const second = await run(['add', 'Check the deploy', '--status', 'waiting_user', '--reason', 'Approve the migration'], { env });
    assert.equal(second.code, 0);
    assert.match(second.stdout, /^Added #2 Check the deploy \(Needs you\)/);

    const listed = await run(['list'], { env: { ...env } });
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /^Needs you \(1\)\n  #2 Check the deploy\n     Approve the migration\n\nTo do \(1\)\n  #1 Write the report  !high due 2026-11-20\n$/);
    await run(['list', '--status', 'review,failed', '--q', 'deploy', '--all'], { env });
    assert.deepEqual(fake.requests.at(-1).query, { status: 'review,failed', q: 'deploy', include_done: '1' });
    assert.equal((await run(['list', '--status', 'nope'], { env })).code, 1);
    const listJson = JSON.parse((await run(['list', '--json'], { env })).stdout);
    assert.equal(listJson.items.length, 2);

    const shown = await run(['show', '1'], { env });
    assert.equal(shown.code, 0);
    assert.match(shown.stdout, /^#1 Write the report\nStatus: {3}To do\nPriority: high/);
    assert.match(shown.stdout, /History\n/);
    const byRef = await run(['show', 'ref:ci:42', '--json'], { env });
    assert.equal(JSON.parse(byRef.stdout).item.id, 1);
    assert.deepEqual(fake.requests.at(-2).query, { include_done: '1', limit: '1000' }, 'a ref is resolved through the list');
    assert.equal((await run(['show', 'ref:none'], { env })).code, 3);
    assert.equal((await run(['show', '99'], { env })).code, 3);
    assert.equal((await run(['show', 'abc'], { env })).code, 1);

    assert.equal((await run(['update', '1', '--title', 'Write the summary', '--reason', '', '--due', ''], { env })).code, 0);
    assert.deepEqual(fake.requests.at(-1).body, { title: 'Write the summary', due_date: null, attention_reason: null });
    assert.equal(fake.requests.at(-1).method, 'PATCH');
    assert.equal(fake.requests.at(-1).path, '/api/attention/1');
    assert.equal((await run(['update', '1'], { env })).code, 1, 'update without fields');
    assert.equal((await run(['update', '1', '--status', 'finished'], { env })).code, 1);

    const verbs = { done: 'done', review: 'review', fail: 'failed', cancel: 'cancelled', wait: 'waiting_user', work: 'working' };
    for (const [verb, status] of Object.entries(verbs)) {
      const result = await run([verb, 'ref:ci:42', '--reason', `because ${verb}`], { env });
      assert.equal(result.code, 0, `${verb}: ${result.stderr}`);
      assert.deepEqual(fake.requests.at(-1).body, { status, attention_reason: `because ${verb}` });
      assert.equal(fake.requests.at(-1).path, '/api/attention/1');
    }
    await run(['done', '2'], { env });
    assert.deepEqual(fake.requests.at(-1).body, { status: 'done' });

    const created = await run(['upsert', '--ref', 'build:7', '--title', 'Nightly build', '--status', 'working', '--json'], { env });
    assert.equal(created.code, 0, created.stderr);
    assert.equal(fake.requests.at(-1).method, 'PUT');
    assert.equal(fake.requests.at(-1).path, `/api/attention/by-ref/${encodeURIComponent('build:7')}`);
    const updated = await run(['upsert', '--ref', 'build:7', '--status', 'failed', '--reason', 'Test failed'], { env });
    assert.match(updated.stdout, /^Updated #3 Nightly build \(Failed\)/);
    assert.deepEqual(fake.requests.at(-1).body, { status: 'failed', attention_reason: 'Test failed', source: 'cli' });
    assert.equal((await run(['upsert', '--ref', 'build:8', '--status', 'working'], { env })).code, 1, 'a new ref needs a title (400 is a usage error)');
    assert.equal((await run(['upsert', '--title', 'x'], { env })).code, 1);

    const removed = await run(['rm', '3', '--json'], { env });
    assert.equal(removed.code, 0);
    assert.deepEqual(JSON.parse(removed.stdout), { deleted: 3 });
    assert.equal(fake.requests.at(-1).method, 'DELETE');
    assert.equal((await run(['rm', '3'], { env })).code, 3);

    const conflict = await run(['add', 'Again', '--ref', 'ci:42'], { env });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /already exists \(#1\)/);
    const conflictJson = await run(['add', 'Again', '--ref', 'ci:42', '--json'], { env });
    assert.deepEqual(JSON.parse(conflictJson.stderr), { error: 'EXTERNAL_REF_EXISTS', message: 'A task with this external_ref already exists', exit: 1 });
  } finally {
    await fake.close();
  }
});

test('auth, server and network failures map to exit codes 2 and 4', async () => {
  const fake = await fakeServer();
  const broken = await fakeServer({ handler: (req, res, { send }) => send(500, { error: 'INTERNAL', message: 'Database is locked' }) });
  const html = await fakeServer({ handler: (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>login</html>'); } });
  const slow = await fakeServer({ handler: () => true });
  try {
    const denied = await run(['list'], { env: { TA_ATTENTION_URL: fake.url, TA_ATTENTION_TOKEN: 'tatt_bad' } });
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /Invalid token \(check the token: t-attention login\)/);
    const failed = await run(['list'], { env: auth(broken) });
    assert.equal(failed.code, 4);
    assert.match(failed.stderr, /Database is locked/);
    const notJson = await run(['list'], { env: auth(html) });
    assert.equal(notJson.code, 4);
    assert.match(notJson.stderr, /did not answer with JSON/);
    const started = Date.now();
    const timedOut = await run(['list', '--timeout', '0.3'], { env: auth(slow) });
    assert.equal(timedOut.code, 4);
    assert.match(timedOut.stderr, /did not answer within 0.3 s/);
    assert.ok(Date.now() - started < 3000);
    const down = await run(['list'], { env: { TA_ATTENTION_URL: 'http://127.0.0.1:9', TA_ATTENTION_TOKEN: TOKEN } });
    assert.equal(down.code, 4);
    assert.match(down.stderr, /Cannot reach the server/);
    assert.equal((await run(['list'], { env: { TA_ATTENTION_URL: 'ftp://x', TA_ATTENTION_TOKEN: TOKEN } })).code, 1);
  } finally {
    slow.server.closeAllConnections();
    await Promise.all([fake.close(), broken.close(), html.close(), slow.close()]);
  }
});

test('the client keeps a path prefix of the server URL and encodes refs', async () => {
  const fake = await fakeServer({ handler: (req, res, { url, send }) => send(200, { items: [], path: url.pathname }) });
  try {
    const { createClient } = require('../lib/attention-client');
    const api = createClient({ url: `${fake.url}/proxy/`, token: TOKEN });
    await api.list({ status: 'working' });
    assert.equal(fake.requests[0].path, '/proxy/api/attention');
    await api.request('PUT', `/by-ref/${encodeURIComponent('claude:a/b c')}`, { body: {} });
    assert.equal(fake.requests[1].path, '/proxy/api/attention/by-ref/claude%3Aa%2Fb%20c');
  } finally {
    await fake.close();
  }
});

test('package.json exposes the t-attention bin, executable with a node shebang', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.bin['t-attention'], 'scripts/t-attention.js');
  assert.match(fs.readFileSync(CLI, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(CLI).mode & 0o111, 'executable');
});

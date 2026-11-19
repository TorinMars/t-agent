// Links opened by programs in a T-Agent terminal (docs/design/open-links.md): the link shims (scripts/clipboard-shims/open, xdg-open,
// ta-browser) run with sh against the real relay (routes/open-link.js) on loopback with a fake offer, and fake "real" open / xdg-open /
// browser commands later in PATH that record what reaches them; the relay's checks (credential, link rules, rate limit); and offerLink of
// routes/terminal.js with a fake attached socket (forwarding, the page's answer, no viewer, timeout, a closed socket, an old page).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-open-link-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
const { SHIM_DIR, clipboardShimEnv } = require('../lib/clipboard-shims');
const { createOpenLinkRelayRouter, checkLink, createRateLimit } = require('../routes/open-link');

const TOKEN = 'f'.repeat(64);
const HOOK = { task: 12, terminal: 'term-a' };
const fakeDir = path.join(root, 'fake');
const recordDir = path.join(root, 'records');
fs.mkdirSync(fakeDir);
fs.mkdirSync(recordDir);
for (const name of ['open', 'xdg-open', 'fake-browser']) {
  fs.writeFileSync(path.join(fakeDir, name), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done >> "$FAKE_RECORDS/${name}"\nprintf '\\n' >> "$FAKE_RECORDS/${name}"\nexit "\${FAKE_EXIT:-0}"\n`, { mode: 0o755 });
}
// curl is wrapped to record its arguments (the token must never be one), then the real curl runs.
const realCurl = ['/usr/bin/curl', '/bin/curl', '/usr/local/bin/curl'].find(file => fs.existsSync(file));
if (realCurl) fs.writeFileSync(path.join(fakeDir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_RECORDS/curl"\nexec ${realCurl} "$@"\n`, { mode: 0o755 });
const record = name => { try { return fs.readFileSync(path.join(recordDir, name), 'utf8'); } catch { return null; } };
const clearRecords = () => { for (const file of fs.readdirSync(recordDir)) fs.rmSync(path.join(recordDir, file)); };

// The relay on loopback; `answer` decides what the fake offer says, `offers` records what reached it.
const offers = [];
let answer = () => ({ delivered: true });
const db = new Database(':memory:');
db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id TEXT, title TEXT)');
db.prepare("INSERT INTO tasks (id, user_id, title) VALUES (12, 'owner', 'Links')").run();
let allowAll = () => true;
let server;
let base;
test.before(async () => {
  const app = express();
  app.use('/api/tcli', createOpenLinkRelayRouter({
    db, allow: key => allowAll(key),
    verifyToken: (task, terminal, token) => task === HOOK.task && terminal === HOOK.terminal && token === TOKEN,
    offer: async (taskId, terminalId, url) => { offers.push({ taskId, terminalId, url }); return answer(url); },
  }));
  app.use((req, res) => res.status(418).json({ error: 'PASSED_ON' }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections(); server.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
test.beforeEach(() => { offers.length = 0; answer = () => ({ delivered: true }); allowAll = () => true; clearRecords(); });

function shimEnv(extra = {}) {
  const env = {
    HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', FAKE_RECORDS: recordDir,
    ...clipboardShimEnv(`${fakeDir}:/usr/bin:/bin`, null, { env: {} }),
    TA_HOOK_URL: `${base}/hooks/terminal-activity?task=${HOOK.task}&terminal=${HOOK.terminal}`,
    TA_HOOK_TOKEN: TOKEN,
    ...extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}
// Runs a shim (by its name, found first in PATH) with sh; resolves with its exit code and output.
function run(name, args, env = shimEnv()) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', '"$@"', 'sh', name, ...args], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { out += data; });
    child.on('close', code => resolve({ code, out }));
  });
}

test('the link shims are executable, come first in PATH and BROWSER is the link shim; an inherited BROWSER is kept for the fallback', () => {
  for (const name of ['open', 'xdg-open', 'ta-browser']) assert.ok(fs.statSync(path.join(SHIM_DIR, name)).mode & 0o111, name);
  const env = clipboardShimEnv('/usr/bin', null, { env: { BROWSER: 'firefox --new-window' } });
  assert.equal(env.BROWSER, path.join(SHIM_DIR, 'ta-browser'));
  assert.equal(env.TA_BROWSER_REAL, 'firefox --new-window');
  const nested = clipboardShimEnv('/usr/bin', null, { env: { BROWSER: '/elsewhere/clipboard-shims/ta-browser' } });
  assert.equal(nested.TA_BROWSER_REAL, undefined, 'a BROWSER that is a link shim is never kept: no loop');
});

test('open with one web link hands it to the relay with the terminal credential and does not run the real open', { skip: !realCurl && 'no curl' }, async () => {
  const url = 'https://preview.example.dev/pr/42?tab=files&x=[1]#top';
  const { code } = await run('open', [url]);
  assert.equal(code, 0);
  assert.deepEqual(offers, [{ taskId: 12, terminalId: 'term-a', url }]);
  assert.equal(record('open'), null, 'the real open did not run');
  assert.ok(!record('curl').includes(TOKEN), 'the token is not on the command line');
  const linux = await run('xdg-open', ['http://example.com/']);
  assert.equal(linux.code, 0);
  assert.equal(offers[1].url, 'http://example.com/');
  assert.equal(record('xdg-open'), null);
});

test('a link no page took, a refused one, a server that is gone or a rate limit run the real open as before', { skip: !realCurl && 'no curl' }, async () => {
  answer = () => ({ delivered: false, reason: 'no-viewer' });
  assert.equal((await run('open', ['https://example.com/a'])).code, 0);
  assert.equal(record('open'), '[https://example.com/a]\n');
  clearRecords();
  allowAll = () => false;
  await run('open', ['https://example.com/b']);
  assert.equal(record('open'), '[https://example.com/b]\n', '429: the engine opens it');
  clearRecords();
  const gone = await run('xdg-open', ['https://example.com/c'], shimEnv({ TA_HOOK_URL: 'http://127.0.0.1:9/hooks/terminal-activity?task=12&terminal=term-a' }));
  assert.equal(gone.code, 0);
  assert.equal(record('xdg-open'), '[https://example.com/c]\n');
  clearRecords();
  await run('open', ['https://example.com/d'], shimEnv({ TA_HOOK_TOKEN: '0'.repeat(64) }));
  assert.equal(record('open'), '[https://example.com/d]\n', 'a wrong token: 403, the engine opens it');
  clearRecords();
  answer = () => ({ delivered: false, reason: 'not-shown' });
  await run('open', ['http://localhost:5173/']);
  assert.equal(record('open'), '[http://localhost:5173/]\n');
  assert.equal(offers.length, 1, 'only the link that the relay checked against the page was offered; localhost was not');
});

test('anything that is not exactly one web link goes to the real command untouched, without asking the relay', async () => {
  const cases = [
    ['open', ['-a', 'Safari', 'https://example.com/']],
    ['open', ['-R', '/tmp/file.txt']],
    ['open', ['-g', 'https://example.com/']],
    ['open', ['https://a.example/', 'https://b.example/']],
    ['open', ['.']],
    ['open', ['/Applications/Safari.app']],
    ['open', ['mailto:a@example.com']],
    ['open', ['file:///etc/passwd']],
    ['open', ['https://exa mple.com/']],
    ['open', ['https://example.com/"quoted"']],
    ['open', ['https://example.com/back\\slash']],
    ['open', ['https://example.com/\u4e2d\u6587']],
    ['open', ['https://example.com/two\nlines']],
    ['open', ['https://']],
    ['open', []],
    ['xdg-open', ['--help']],
    ['xdg-open', ['/home/user/report.pdf']],
  ];
  for (const [name, args] of cases) {
    clearRecords();
    const { code } = await run(name, args);
    assert.equal(code, 0, `${name} ${args.join(' ')}`);
    assert.equal(record(name), `${args.map(arg => `[${arg}]`).join('')}\n`, `${name} ${args.join(' ')}`);
  }
  assert.equal(offers.length, 0);
});

test('outside a T-Agent terminal (no marker, no hook variables) the shims only run the real command', async () => {
  await run('open', ['https://example.com/'], shimEnv({ TA_CLIPBOARD_OSC52: undefined }));
  assert.equal(record('open'), '[https://example.com/]\n');
  clearRecords();
  await run('open', ['https://example.com/'], shimEnv({ TA_HOOK_URL: undefined }));
  assert.equal(record('open'), '[https://example.com/]\n');
  assert.equal(offers.length, 0);
});

test('the real command is found later in PATH, never the shim itself, and its exit code comes back', async () => {
  const twice = shimEnv();
  twice.PATH = `${SHIM_DIR}:${SHIM_DIR}:${fakeDir}:/usr/bin:/bin`;
  const { code } = await run('open', ['-a', 'Notes'], { ...twice, FAKE_EXIT: '3' });
  assert.equal(code, 3);
  assert.equal(record('open'), '[-a][Notes]\n');
  if (['/usr/bin/xdg-open', '/bin/xdg-open'].some(file => fs.existsSync(file))) return; // a Linux desktop has the real one
  const none = shimEnv();
  none.PATH = `${SHIM_DIR}:/usr/bin:/bin`;
  const missing = await run(path.join(SHIM_DIR, 'xdg-open'), ['--version'], none);
  assert.equal(missing.code, 127);
  assert.match(missing.out, /xdg-open: command not found/);
});

test('$BROWSER (ta-browser): a web link goes to the page; otherwise the inherited browser, else the real open or xdg-open', { skip: !realCurl && 'no curl' }, async () => {
  const browser = path.join(SHIM_DIR, 'ta-browser');
  assert.equal((await run(browser, ['https://example.com/x'])).code, 0);
  assert.equal(offers.length, 1);
  assert.equal(record('open'), null);
  answer = () => ({ delivered: false, reason: 'no-viewer' });
  await run(browser, ['https://example.com/y'], shimEnv({ TA_BROWSER_REAL: `${path.join(fakeDir, 'fake-browser')} --new-window` }));
  assert.equal(record('fake-browser'), '[--new-window][https://example.com/y]\n');
  clearRecords();
  await run(browser, ['https://example.com/z']);
  const fallback = os.platform() === 'darwin' ? 'open' : 'xdg-open';
  assert.equal(record(fallback), '[https://example.com/z]\n');
  clearRecords();
  await run(browser, ['https://example.com/loop'], shimEnv({ TA_BROWSER_REAL: browser }));
  assert.equal(record(fallback), '[https://example.com/loop]\n', 'a TA_BROWSER_REAL that is the shim is skipped');
});

// ── The relay ──

async function post(body, headers = { 'X-T-Agent-Task': '12', 'X-T-Agent-Terminal': 'term-a', 'X-T-Agent-Token': TOKEN }) {
  const response = await fetch(`${base}/api/tcli/open-link`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('the relay takes only the terminal credential from this machine and passes other requests on', async () => {
  assert.equal((await post({ url: 'https://example.com/' })).body.delivered, true);
  assert.equal((await post({ url: 'https://example.com/' }, { 'X-T-Agent-Task': '12', 'X-T-Agent-Terminal': 'term-a', 'X-T-Agent-Token': 'x' })).status, 403);
  assert.equal((await post({ url: 'https://example.com/' }, { 'X-T-Agent-Task': '12' })).status, 401);
  assert.equal((await post({ url: 'https://example.com/' }, {})).status, 418, 'without the headers it meets the next route (the login gate)');
  assert.equal(offers.length, 1);
});

test('the relay checks the link: http(s) only, length, no spaces; links that only work on this machine are not offered', async () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/', `https://example.com/${'a'.repeat(4100)}`, 'https://exa mple.com/', 'https://', 42, null]) {
    const answerOf = await post({ url });
    assert.equal(answerOf.status, 400, String(url).slice(0, 40));
    assert.equal(answerOf.body.error, 'INVALID_URL');
  }
  assert.equal((await post('{nope')).status, 400);
  for (const [url, reason] of [
    ['http://localhost:3000/', 'local-only'], ['http://127.0.0.1:8080/x', 'local-only'], ['http://[::1]:5000/', 'local-only'], ['http://app.localhost/', 'local-only'],
    ['https://claude.ai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback', 'local-callback'],
    ['https://auth.openai.com/oauth/authorize?redirect_uri=http://127.0.0.1:1455/auth/callback&state=s', 'local-callback'],
  ]) {
    assert.deepEqual((await post({ url })).body, { delivered: false, reason }, url);
  }
  assert.equal(offers.length, 0);
  assert.deepEqual(checkLink('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fx'), { ok: true, url: 'https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fx' });
});

test('the relay answers no viewer when the offer fails, and limits links per terminal', async () => {
  answer = () => { throw new Error('gone'); };
  assert.deepEqual((await post({ url: 'https://example.com/' })).body, { delivered: false, reason: 'no-viewer' });
  answer = () => ({ delivered: false, reason: 'no-answer' });
  assert.deepEqual((await post({ url: 'https://example.com/' })).body, { delivered: false, reason: 'no-answer' });
  let clock = 0;
  const allow = createRateLimit({ max: 5, windowMs: 10_000, now: () => clock });
  for (let index = 0; index < 5; index += 1) assert.equal(allow('12:a'), true);
  assert.equal(allow('12:a'), false, 'the sixth within 10 s');
  assert.equal(allow('12:b'), true, 'per terminal');
  clock = 10_001;
  assert.equal(allow('12:a'), true, 'the window moved on');
  allowAll = () => false;
  const limited = await post({ url: 'https://example.com/' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.delivered, false);
});

// ── offerLink: the terminal route forwards the link to the attached page ──

test('offerLink sends the link to the attached page and waits for its answer; no page, an old page, no answer or a close is no delivery', async () => {
  const appDb = require('../db');
  const tasks = require('../test-support/older-tasks').olderTasks(require('../services/engine-tasks'), appDb);
  const terminalPath = path.resolve(__dirname, '../routes/terminal.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(terminalPath, 'utf8'), {
    module: mod, __dirname: path.dirname(terminalPath), process, console: { ...console, warn() {} }, URL,
    setInterval, clearInterval, setTimeout, clearTimeout, Buffer, setImmediate, queueMicrotask,
    require(name) {
      if (name === '../lib/node-pty-runtime') return { repairSpawnHelperPermissions() {} };
      if (name === 'node-pty') return { spawn(shell, args, options) {
        return { options, onData() {}, onExit(fn) { this.exit = fn; }, write() {}, pause() {}, resume() {}, resize() {}, kill() { this.exit(); } };
      } };
      return require(name.startsWith('.') ? path.resolve(path.dirname(terminalPath), name) : name);
    },
  });
  const terminal = mod.exports;
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close'); }
    controls() { return this.sent.filter(Buffer.isBuffer).map(data => JSON.parse(data.toString())); }
    answer(message) { this.emit('message', Buffer.from(JSON.stringify(message)), true); }
  }
  const plain = value => JSON.parse(JSON.stringify(value)); // answers made inside the vm context have its own Object prototype
  const waitFor = async check => { for (let index = 0; index < 200 && !check(); index += 1) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check()); };
  const task = tasks.createTask('owner', { title: 'links' });
  try {
    const added = terminal.createTerminal(task.id, { agent: 'claude' });
    const id = added.terminal_id;
    assert.deepEqual(plain(await terminal.offerLink(task.id, id, 'https://example.com/')), { delivered: false, reason: 'no-viewer' }, 'no shell, no page');
    const ws = new Socket();
    terminal.handleWs(ws, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=a&proto=2` }, { login: 'owner' });
    await waitFor(() => ws.controls().some(message => message.type === 'history'));

    const taken = terminal.offerLink(task.id, id, 'https://example.com/pr/42');
    const offer = ws.controls().find(message => message.type === 'open-link');
    assert.equal(offer.url, 'https://example.com/pr/42');
    assert.equal(offer.agent, 'claude');
    ws.answer({ type: 'open-link-result', id: 'wrong', shown: true }); // another id changes nothing
    ws.answer({ type: 'open-link-result', id: offer.id, shown: true });
    assert.deepEqual(plain(await taken), { delivered: true });

    const refused = terminal.offerLink(task.id, id, 'https://example.com/b');
    ws.answer({ type: 'open-link-result', id: ws.controls().filter(message => message.type === 'open-link').pop().id, shown: false });
    assert.deepEqual(plain(await refused), { delivered: false, reason: 'not-shown' });

    assert.deepEqual(plain(await terminal.offerLink(task.id, id, 'https://example.com/c', { timeoutMs: 30 })), { delivered: false, reason: 'no-answer' });

    const closing = terminal.offerLink(task.id, id, 'https://example.com/d');
    ws.close();
    assert.deepEqual(plain(await closing), { delivered: false, reason: 'no-viewer' });

    const old = new Socket(); // a page without proto=2 would print the JSON: never offered
    terminal.handleWs(old, { url: `/terminal/ws?taskId=${task.id}&terminalId=${id}&clientId=b` }, { login: 'owner' });
    await waitFor(() => old.sent.length > 0);
    assert.deepEqual(plain(await terminal.offerLink(task.id, id, 'https://example.com/e')), { delivered: false, reason: 'no-viewer' });
    assert.ok(!old.sent.some(data => String(data).includes('open-link')));
  } finally {
    terminal.closeTaskTerminals(task.id);
    appDb.close();
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createEnvironmentCheck, request, writable } = require('../services/environment-check');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-env-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const OK_ANSWER = { ok: true, status: 200, headers: { date: new Date().toUTCString() } };
const finder = file => ({ find: async () => file });
// Everything works; a test changes what it wants to see fail.
const healthy = (extra = {}) => ({
  env: { HOME: root, PATH: '' },
  projectRoot: root,
  tasksDir: root,
  dataDir: root,
  sessionSecret: 'x'.repeat(40),
  verifyNodePty: async () => {},
  exists: () => true,
  terminalUser: { resolveTerminalUser: () => ({ user: null, reason: 'not-root' }) },
  finders: { claude: finder('/bin/claude'), git: finder('/usr/bin/git'), pm2: finder('/usr/bin/pm2') },
  run: async () => ({ ok: true, stdout: 'tool 1.2.3\n', stderr: '' }),
  request: async () => OK_ANSWER,
  claudeProbe: async () => ({ models: 3, account: { subscriptionType: 'Pro' } }),
  codexModule: {
    findCodex: async () => '/bin/codex',
    AppServerClient: class { async start() {} async request() { return { account: { type: 'chatgpt' } }; } close() {} },
  },
  frp: { findFrpc: () => null, probeFrpc: () => ({ version: '0.58.1', supported: true, error: '' }) },
  statfs: () => ({ bavail: 50 * 1024 * 1024, bsize: 4096 }),
  ...extra,
});
const context = (extra = {}) => ({ origin: 'https://client.example', oss: null, clientAuth: null, frpConfigured: false, ...extra });
const report = async (deps, ctx) => createEnvironmentCheck(deps).run(context(ctx));
const featureOf = (result, id) => result.features.find(feature => feature.id === id);
const checkOf = (result, feature, id) => featureOf(result, feature).checks.find(check => check.id === id);

test('on a healthy machine every feature works, and the report says so with what each check found', async () => {
  const result = await report(healthy());
  assert.deepEqual(result.summary, { ok: result.features.length, warn: 0, fail: 0 });
  assert.deepEqual(result.features.map(feature => feature.id), ['terminal', 'claude-terminal', 'claude-chat', 'codex-terminal', 'codex-chat', 'network', 'updates', 'oss', 'access', 'tunnel', 'apps', 'storage']);
  assert.ok(result.features.every(feature => ['ok', 'info'].includes(feature.status)));
  assert.match(checkOf(result, 'claude-terminal', 'cli').detail, /\/bin\/claude \(tool 1\.2\.3\)/);
  assert.match(checkOf(result, 'claude-chat', 'engine').detail, /logged in \(Pro\)/);
  assert.match(checkOf(result, 'codex-chat', 'engine').detail, /logged in with ChatGPT/);
  assert.equal(checkOf(result, 'network', 'clock').status, 'ok');
  assert.ok(result.checked_at > 0 && result.machine.node && result.machine.user);
});

test('a terminal that cannot start, no shell, a missing terminal user and an unwritable task folder are problems of Terminals', async () => {
  const broken = await report(healthy({
    verifyNodePty: async () => { throw new Error('spawn-helper: permission denied'); },
    exists: () => false,
    terminalUser: { resolveTerminalUser: () => ({ user: null, reason: 'missing-default', name: 'dev' }) },
    tasksDir: '/proc/definitely/not/writable/here',
  }));
  const terminals = featureOf(broken, 'terminal');
  assert.equal(terminals.status, 'fail');
  assert.deepEqual(terminals.checks.map(check => check.status), ['fail', 'fail', 'warn', 'fail']);
  assert.match(terminals.checks[0].detail, /A terminal cannot start: spawn-helper: permission denied/);
  assert.match(terminals.checks[0].fix, /npm rebuild node-pty/);
  assert.match(terminals.checks[2].detail, /run as root because the user dev does not exist/);
  assert.match(terminals.checks[2].fix, /TERMINAL_USER=/);
  assert.equal(terminals.checks[3].impact, 'New tasks cannot be created');
  assert.equal(broken.summary.fail, 1);
});

test('missing agent programs, a missing login and a broken engine name what stops working and what to do', async () => {
  const none = await report(healthy({
    finders: { claude: finder(null), git: finder(null), pm2: finder(null) },
    codexModule: { findCodex: async () => null, AppServerClient: class {} },
    claudeProbe: async () => { throw new Error('binary not found'); },
  }));
  assert.equal(checkOf(none, 'claude-terminal', 'cli').impact, 'Claude sessions in terminals cannot start');
  assert.match(checkOf(none, 'claude-terminal', 'cli').fix, /CLAUDE_PATH/);
  assert.match(checkOf(none, 'claude-chat', 'engine').detail, /Claude Code cannot start: binary not found/);
  for (const [feature, impact] of [['codex-terminal', 'Codex sessions in terminals cannot start'], ['codex-chat', 'The Codex chat view cannot start']]) {
    assert.equal(checkOf(none, feature, feature === 'codex-chat' ? 'engine' : 'cli').impact, impact);
    assert.match(checkOf(none, feature, feature === 'codex-chat' ? 'engine' : 'cli').fix, /CODEX_PATH/);
  }
  assert.deepEqual([featureOf(none, 'updates').status, featureOf(none, 'apps').status], ['warn', 'warn'], 'git and pm2 are conveniences: a warning');

  const loggedOut = await report(healthy({
    claudeProbe: async () => ({ models: 3, account: {} }),
    codexModule: { findCodex: async () => '/bin/codex', AppServerClient: class { async start() {} async request() { return { account: null, requiresOpenaiAuth: true }; } close() {} } },
  }));
  assert.equal(checkOf(loggedOut, 'claude-chat', 'engine').status, 'warn');
  assert.match(checkOf(loggedOut, 'claude-chat', 'engine').fix, /Run `claude`/);
  assert.equal(checkOf(loggedOut, 'codex-chat', 'engine').status, 'warn');
  assert.match(checkOf(loggedOut, 'codex-chat', 'engine').fix, /codex login/);

  let closed = 0;
  const old = await report(healthy({ codexModule: { findCodex: async () => '/bin/codex', AppServerClient: class { async start() { throw new Error('unknown subcommand app-server'); } close() { closed++; } } } }));
  assert.equal(checkOf(old, 'codex-chat', 'engine').status, 'fail');
  assert.match(checkOf(old, 'codex-chat', 'engine').fix, /Update Codex/);
  assert.equal(closed, 1, 'the process is closed even when it failed to start');
});

test('network: an unreachable server is a problem of the features that need it, proxy settings are shown without credentials, and a wrong clock is found', async () => {
  const down = await report(healthy({
    env: { HOME: root, PATH: '', https_proxy: 'http://user:secret@127.0.0.1:7897' },
    request: async url => (/anthropic|raw\.github/.test(url) ? { ok: false, error: 'Connection timed out after 6001 milliseconds' } : OK_ANSWER),
  }));
  assert.equal(checkOf(down, 'network', 'anthropic').status, 'fail');
  assert.match(checkOf(down, 'network', 'anthropic').detail, /api\.anthropic\.com cannot be reached: Connection timed out/);
  assert.equal(checkOf(down, 'network', 'anthropic').impact, 'Claude sessions and the Claude chat cannot work');
  assert.match(checkOf(down, 'network', 'anthropic').fix, /https_proxy/);
  assert.equal(checkOf(down, 'network', 'openai').status, 'ok');
  assert.match(checkOf(down, 'network', 'github').detail, /raw\.githubusercontent\.com cannot be reached/);
  assert.equal(checkOf(down, 'network', 'proxy').detail, 'https_proxy points to 127.0.0.1:7897');
  assert.equal(/user:secret|secret@|:secret/.test(JSON.stringify(down)), false, 'no credentials of the proxy in the report');
  assert.equal(checkOf(await report(healthy()), 'network', 'proxy').status, 'info');

  const late = new Date(Date.now() - 5 * 60 * 1000).toUTCString();
  const skewed = await report(healthy({ request: async () => ({ ok: true, status: 200, headers: { date: late } }) }));
  assert.equal(checkOf(skewed, 'network', 'clock').status, 'warn');
  assert.match(checkOf(skewed, 'network', 'clock').detail, /The clock is (299|300|301) seconds ahead of the servers/);
  assert.equal(checkOf(skewed, 'network', 'clock').impact, 'Authenticator codes may be rejected at login');
  const offline = await report(healthy({ request: async () => ({ ok: false, error: 'offline' }) }));
  assert.equal(checkOf(offline, 'network', 'clock').status, 'info', 'without an answer the clock cannot be compared');
});

test('image upload is only checked when it is set up: the bucket, and the CORS rule for the page it is used from', async () => {
  const off = await report(healthy());
  assert.deepEqual(featureOf(off, 'oss').checks.map(check => check.status), ['info', 'info', 'info']);
  assert.equal(featureOf(off, 'oss').status, 'info');

  const oss = { enabled: true, bucket: 'my-images', region: 'oss-cn-hangzhou' };
  const asked = [];
  const rule = answer => healthy({ request: async (url, options = {}) => { asked.push([url, options.method, options.headers]); return options.method === 'OPTIONS' ? answer : OK_ANSWER; } });
  const allowed = await report(rule({ ok: true, status: 200, headers: { 'access-control-allow-origin': 'https://client.example' } }), { oss });
  assert.deepEqual(featureOf(allowed, 'oss').checks.map(check => check.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(asked.find(entry => entry[1] === 'OPTIONS'), ['https://my-images.oss-cn-hangzhou.aliyuncs.com/', 'OPTIONS', { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST' }]);
  const wildcard = await report(rule({ ok: true, status: 200, headers: { 'access-control-allow-origin': '*' } }), { oss });
  assert.equal(checkOf(wildcard, 'oss', 'cors').status, 'ok');
  const blocked = await report(rule({ ok: true, status: 403, headers: {} }), { oss });
  assert.equal(checkOf(blocked, 'oss', 'cors').status, 'fail');
  assert.match(checkOf(blocked, 'oss', 'cors').fix, /allowed origin https:\/\/client\.example, allowed method POST/);
  assert.equal(checkOf(blocked, 'oss', 'cors').impact, 'The browser blocks pasted-image uploads from this page');
  const unreachable = await report(healthy({ request: async () => ({ ok: false, error: 'Could not resolve host' }) }), { oss });
  assert.equal(checkOf(unreachable, 'oss', 'bucket').status, 'fail');
  assert.equal(checkOf(unreachable, 'oss', 'cors').status, 'info', 'an unreachable bucket cannot be asked about CORS');
});

test('login: a weak session key, an unbound authenticator and plain HTTP from another address are found, local access is fine', async () => {
  const auth = (mode, bound) => ({ accessMode: () => mode, status: () => ({ bound }) });
  for (const secret of ['', 'dev-secret-change-me', 'short']) {
    const weak = await report(healthy({ sessionSecret: secret }));
    assert.equal(checkOf(weak, 'access', 'secret').status, 'fail', `"${secret}" is weak`);
    assert.match(checkOf(weak, 'access', 'secret').fix, /SESSION_SECRET of at least 32 characters/);
  }
  assert.equal(checkOf(await report(healthy()), 'access', 'authenticator').status, 'info');
  assert.equal(checkOf(await report(healthy(), { clientAuth: auth('local', false) }), 'access', 'authenticator').status, 'info');
  assert.equal(checkOf(await report(healthy(), { clientAuth: auth('unset', false) }), 'access', 'authenticator').status, 'info');
  assert.equal(checkOf(await report(healthy(), { clientAuth: auth('remote', true) }), 'access', 'authenticator').status, 'ok');
  const unbound = await report(healthy(), { clientAuth: auth('remote', false) });
  assert.equal(checkOf(unbound, 'access', 'authenticator').status, 'warn');
  assert.match(checkOf(unbound, 'access', 'authenticator').fix, /client-auth-setup\.js/);
  const http = await report(healthy(), { clientAuth: auth('remote', true), origin: 'http://203.0.113.5:3000' });
  assert.equal(checkOf(http, 'access', 'transport').status, 'warn');
  assert.match(checkOf(http, 'access', 'transport').fix, /CLIENT_ALLOW_HTTP=true/);
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://client.example']) {
    assert.equal(checkOf(await report(healthy(), { clientAuth: auth('remote', true), origin }), 'access', 'transport').status, 'ok', origin);
  }
  assert.equal(checkOf(await report(healthy(), { clientAuth: auth('local', false), origin: 'http://203.0.113.5:3000' }), 'access', 'transport').status, 'ok', 'local mode has no remote sign-in to protect');
});

test('the tunnel program matters only when the tunnel is set up; storage warns before the disk is full', async () => {
  assert.equal(checkOf(await report(healthy()), 'tunnel', 'frpc').status, 'info');
  assert.equal(checkOf(await report(healthy(), { frpConfigured: true }), 'tunnel', 'frpc').status, 'fail');
  assert.equal(checkOf(await report(healthy({ frp: { findFrpc: () => '/bin/frpc', probeFrpc: () => ({ version: '0.58.1', supported: true, error: '' }) } })), 'tunnel', 'frpc').detail, 'frpc 0.58.1');
  assert.equal(checkOf(await report(healthy({ frp: { findFrpc: () => '/bin/frpc', probeFrpc: () => ({ version: '0.10.0', supported: false, error: '' }) } })), 'tunnel', 'frpc').status, 'warn');
  assert.equal(checkOf(await report(healthy({ frp: { findFrpc: () => '/bin/frpc', probeFrpc: () => ({ version: '', supported: true, error: 'frpc was found but cannot be run' }) } }), { frpConfigured: true }), 'tunnel', 'frpc').status, 'fail');

  const free = megabytes => healthy({ statfs: () => ({ bavail: megabytes, bsize: 1024 * 1024 }) });
  assert.equal(checkOf(await report(free(50000)), 'storage', 'disk').status, 'ok');
  assert.equal(checkOf(await report(free(500)), 'storage', 'disk').status, 'warn');
  assert.equal(checkOf(await report(free(50)), 'storage', 'disk').status, 'fail');
  assert.equal(checkOf(await report(healthy({ dataDir: '/proc/not/writable' })), 'storage', 'disk').status, 'fail');
  assert.equal(checkOf(await report(healthy({ statfs: () => { throw new Error('no statfs'); } })), 'storage', 'disk').status, 'ok', 'a disk that cannot be measured is not a problem');
});

test('a check that throws or hangs is one failed check, never a failed report, and checking changes nothing on the machine', async () => {
  const result = await report(healthy({
    checkTimeoutMs: 80,
    verifyNodePty: () => new Promise(() => {}),
    run: async () => { throw new Error('exec exploded'); },
  }));
  assert.equal(checkOf(result, 'terminal', 'pty').status, 'warn');
  assert.equal(checkOf(result, 'terminal', 'pty').detail, 'The check did not finish in time');
  assert.equal(checkOf(result, 'claude-terminal', 'cli').status, 'fail');
  assert.match(checkOf(result, 'claude-terminal', 'cli').detail, /The check failed: exec exploded/);
  assert.ok(result.features.length === 12, 'the other features are still there');

  const missing = path.join(root, 'not', 'there', 'yet');
  await report(healthy({ tasksDir: missing, dataDir: path.join(root, 'also', 'missing') }));
  assert.equal(fs.existsSync(path.join(root, 'not')), false);
  assert.equal(fs.existsSync(path.join(root, 'also')), false, 'no folder is created to find out whether it could be');
  assert.equal(writable(missing), true, 'a folder that does not exist yet is judged by the folder it would be created in');
  assert.equal(writable('/proc/not/there'), false);
  assert.equal(writable('/'), os.userInfo().uid === 0, 'the root of the disk is only writable for root');
});

test('the report holds no account names, e-mail addresses or secrets', async () => {
  const text = JSON.stringify(await report(healthy({
    claudeProbe: async () => ({ models: 3, account: { email: 'person@example.com', organization: 'Acme', subscriptionType: 'Max' } }),
    codexModule: { findCodex: async () => '/bin/codex', AppServerClient: class { async start() {} async request() { return { account: { type: 'chatgpt', email: 'person@example.com' } }; } close() {} } },
  }), { oss: { enabled: true, bucket: 'b', region: 'oss-cn-hangzhou', accessKeyId: 'AKIDSECRET', accessKeySecret: 'SUPERSECRET' } }));
  for (const secret of ['person@example.com', 'Acme', 'AKIDSECRET', 'SUPERSECRET', 'x'.repeat(40)]) assert.equal(text.includes(secret), false, secret);
});

// A real server for the helper that asks like the agents do.
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}/`); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('request() reads the status and headers of an answer, for HEAD and for a CORS preflight, and says why when there is none', async () => {
  await withServer((req, res) => {
    res.setHeader('Date', 'Mon, 26 Oct 2026 10:00:00 GMT');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', req.headers.origin || ''); res.statusCode = 200; } else res.statusCode = 404;
    res.end();
  }, async url => {
    const head = await request(url);
    assert.deepEqual([head.ok, head.status, head.headers.date], [true, 404, 'Mon, 26 Oct 2026 10:00:00 GMT'], 'any answer, even an error status, means the server is reachable');
    const preflight = await request(url, { method: 'OPTIONS', headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST' } });
    assert.deepEqual([preflight.status, preflight.headers['access-control-allow-origin']], [200, 'https://client.example']);
  });
  const refused = await request('http://127.0.0.1:9/', { timeoutSeconds: 3 });
  assert.equal(refused.ok, false);
  assert.ok(refused.error && refused.error.length > 0, 'the reason is given');
});

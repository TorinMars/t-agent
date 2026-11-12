// Settings of a linked device (routes/device-settings.js): the allowlist of per-device page routes a linked peer may call, the peer side
// (/v1/device-settings: link tokens only, nothing outside the list, bodies cut down to the listed fields, no secret in any answer), the page side
// (/api/device-settings: the device list with support, the forward and its error mapping), and two real server.js processes linked through a
// real service-link tunnel, where A changes B's per-device settings and B's secrets never show.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-device-settings-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'device-settings-test-secret-device-settings';
delete process.env.TAGENT_HOME;

const express = require('express');
const Database = require('better-sqlite3');
const deviceSettings = require('../routes/device-settings');
const { allowedRoute, bodyFor, ALLOWLIST, CAPABILITY, createEngineDeviceSettingsRouter, createDeviceSettingsRouter } = deviceSettings;

const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  fs.rmSync(root, { recursive: true, force: true });
});
async function call(base, method, route, body, headers = HEADERS) {
  const response = await fetch(base + route, { method, redirect: 'manual', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}
async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('the allowlist takes the per-device page routes only, written exactly', () => {
  const ok = [
    ['GET', '/auth/me'], ['PUT', '/auth/settings'], ['GET', '/peer-fs/settings'], ['PUT', '/peer-fs/settings'], ['GET', '/agent-skills'],
    ['POST', '/agent-skills/tcli/install'], ['POST', '/agent-skills/t-attention/install'], ['POST', '/agent-skills/t-attention/remove-old'],
    ['GET', '/rule-sync'], ['PUT', '/rule-sync'], ['POST', '/rule-sync/push'], ['POST', '/rule-sync/reset-source'], ['POST', '/rule-sync/create-shared'],
    ['POST', '/rule-sync/remove-import'], ['POST', '/rule-sync/dismiss-local-changes'], ['GET', '/rule-sync/shared'], ['PUT', '/rule-sync/shared'],
    ['GET', '/attention/widget/settings'], ['PUT', '/attention/widget/settings'],
  ];
  for (const [method, route] of ok) assert.ok(allowedRoute(method, route), `${method} ${route}`);
  const refused = [
    // Settings with secrets, shared settings, Telegram, the account and anything else of the page.
    ['GET', '/oss/config'], ['PUT', '/oss/config'], ['GET', '/translate/config'], ['GET', '/speech/config'], ['GET', '/attention-notify/config'],
    ['GET', '/attention/telegram/status'], ['POST', '/attention/telegram/logout'], ['GET', '/attention/tokens'], ['POST', '/attention/tokens'],
    ['GET', '/remote-tokens'], ['POST', '/remote-tokens/pairing'], ['POST', '/service-links/code'], ['POST', '/auth/mode'], ['POST', '/system/restart'],
    ['GET', '/pm2/status'], ['GET', '/settings-sync'], ['GET', '/attention/plugins'], ['POST', '/attention/plugins/claude/install'],
    // The listed paths with another method, case, trailing slash, query, encoding or a step out.
    ['POST', '/auth/me'], ['DELETE', '/peer-fs/settings'], ['HEAD', '/peer-fs/settings'], ['GET', '/Peer-fs/settings'], ['GET', '/peer-fs/settings/'],
    ['GET', '/peer-fs/settings?x=1'], ['GET', '/peer-fs/%73ettings'], ['GET', '/peer-fs/../oss/config'], ['POST', '/agent-skills/../../oss/install'],
    ['POST', '/agent-skills/%2e%2e/install'], ['POST', '/agent-skills/a/b/install'], ['POST', '/agent-skills/Tcli/install'], ['POST', '/rule-sync/bundle'],
    ['PUT', '/rule-sync/push'], ['GET', '//peer-fs/settings'], ['GET', 'peer-fs/settings'], ['GET', '/peer-fs/settings\n'], ['GET', '/peer-fs/settings '],
    ['GET', ''], [null, '/auth/me'], ['GET', null],
  ];
  for (const [method, route] of refused) assert.equal(allowedRoute(method, route), null, `${method} ${JSON.stringify(route)}`);
  assert.ok(ALLOWLIST.every(entry => entry.path.source.startsWith('^') && entry.path.source.endsWith('$')), 'every pattern is anchored');
});

test('a body is cut down to the fields of its entry', () => {
  const widget = allowedRoute('PUT', '/attention/widget/settings');
  assert.deepEqual(bodyFor(widget, { enabled: false, language: 'zh', extra: 1 }), { enabled: false }, 'the shared language is not taken from a peer');
  assert.deepEqual(bodyFor(allowedRoute('PUT', '/auth/settings'), { work_dir: '/x', username: 'root' }), { work_dir: '/x' });
  assert.deepEqual(bodyFor(allowedRoute('POST', '/rule-sync/push'), { anything: true }), {});
  assert.equal(bodyFor(allowedRoute('GET', '/rule-sync'), { a: 1 }), undefined, 'a read sends no body');
  assert.deepEqual(bodyFor(allowedRoute('PUT', '/peer-fs/settings'), ['enabled']), {}, 'an array is no object');
  assert.deepEqual(bodyFor(allowedRoute('PUT', '/peer-fs/settings'), Object.create({ enabled: true })), {}, 'own fields only');
  assert.equal(CAPABILITY, 'settings:device');
});

// ---- The peer side, with fake services ----

function memoryDb() {
  const memory = new Database(':memory:');
  memory.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, work_dir TEXT);
    CREATE TABLE remote_servers (id INTEGER PRIMARY KEY, owner_id TEXT, name TEXT, base_url TEXT, token_cipher TEXT, status TEXT, created_at TEXT);
    INSERT INTO users (username, work_dir) VALUES ('local', NULL);`);
  return memory;
}
const fakeEngineAuth = scope => (req, res, next) => {
  assert.equal(scope, 'engine:admin');
  const match = /^Bearer (\d)$/.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' });
  req.engineAuth = { tokenId: Number(match[1]) };
  next();
};
const LINKS = { linkForToken: id => ({ 1: { id: 'link-1', revoked: false }, 2: { id: 'link-2', revoked: true } })[id] || null };

async function peerApp() {
  const memory = memoryDb();
  const seen = { skills: [], rule: [], widget: [] };
  const { createAgentSkillsRouter } = require('../routes/agent-skills');
  const { createBrowserRouter } = require('../routes/rule-sync');
  const { createPeerFsSettingsRouter } = require('../routes/peer-fs');
  const { createAttentionWidgetRoutes } = require('../routes/attention-widget');
  const { createWidgetSettings } = require('../services/attention-widget');
  let peerFs = true;
  const pass = (req, res, next) => next();
  const widgetSettings = createWidgetSettings({ db: memory });
  const launcher = { status: async () => ({ platform_supported: true, swiftc: true, running: false, building: false, last_error: null }), setEnabled: async enabled => { seen.widget.push(enabled); }, verifyToken: () => false };
  const widget = createAttentionWidgetRoutes({ service: {}, launcher, settings: widgetSettings, db: memory, settleMs: 10 });
  const router = createEngineDeviceSettingsRouter({
    serviceLinks: LINKS, requireEngineAuth: fakeEngineAuth, db: memory,
    owner: () => memory.prepare("SELECT username AS login, work_dir FROM users WHERE username = 'local'").get(),
    peerFsSettings: () => createPeerFsSettingsRouter({ settings: () => ({ enabled: () => peerFs, setEnabled: value => { peerFs = value; return { enabled: peerFs }; } }) }),
    agentSkills: () => createAgentSkillsRouter({ requireAuth: pass, clientOrigin: pass, getService: () => ({
      list: () => ({ skills: [{ name: 'tcli', claude: { installed: false, path: '/home/x/.claude/skills/tcli' } }] }),
      install: name => { seen.skills.push(name); return { ok: true, name, results: {} }; },
      removeOld: () => ({ ok: true, moved: [], skipped: [] }),
    }) }),
    ruleSync: () => createBrowserRouter({ requireAuth: pass, clientOrigin: pass, getService: () => ({
      overview: () => ({ role: 'off', codex: false }),
      update: body => { seen.rule.push(body); return { role: body.role || 'off' }; },
      pushNow: async () => ({ role: 'source' }),
    }) }),
    widget: () => widget.peerSettings,
  });
  const app = express();
  app.use(express.json());
  app.use('/v1/device-settings', router);
  return { url: await listen(app), memory, seen, widgetSettings, peerFs: () => peerFs };
}
const auth = id => ({ ...HEADERS, Authorization: `Bearer ${id}` });

test('/v1/device-settings: only a live link token, only the allowlist; bodies are cut down', async () => {
  const { url, memory, seen, widgetSettings, peerFs } = await peerApp();
  assert.equal((await call(url, 'GET', '/v1/device-settings/peer-fs/settings')).status, 401);
  assert.deepEqual(await call(url, 'GET', '/v1/device-settings/peer-fs/settings', undefined, auth(3)).then(r => [r.status, r.body]), [403, { error: 'LINKED_ONLY' }], 'not a link token');
  assert.deepEqual(await call(url, 'GET', '/v1/device-settings/peer-fs/settings', undefined, auth(2)).then(r => [r.status, r.body]), [403, { error: 'LINKED_ONLY' }], 'a revoked link');
  // A path outside the list is refused before any handler, with the token of a live link.
  for (const route of ['/oss/config', '/translate/config', '/attention/tokens', '/peer-fs/settings/', '/Peer-fs/settings', '/agent-skills/%2e%2e/install', '/rule-sync/bundle']) {
    assert.deepEqual(await call(url, 'GET', `/v1/device-settings${route}`, undefined, auth(1)).then(r => [r.status, r.body]), [404, { error: 'DEVICE_SETTING_NOT_ALLOWED' }], route);
  }
  assert.equal((await call(url, 'DELETE', '/v1/device-settings/peer-fs/settings', undefined, auth(1))).status, 404);
  assert.equal((await call(url, 'POST', '/v1/device-settings/rule-sync/bundle', {}, auth(1))).status, 404);

  // Peer file access: read, write, validation as on the page.
  assert.deepEqual((await call(url, 'GET', '/v1/device-settings/peer-fs/settings', undefined, auth(1))).body, { enabled: true });
  const off = await call(url, 'PUT', '/v1/device-settings/peer-fs/settings', { enabled: false, other: 'x' }, auth(1));
  assert.deepEqual([off.status, off.body], [200, { enabled: false }]);
  assert.equal(peerFs(), false);
  assert.equal((await call(url, 'PUT', '/v1/device-settings/peer-fs/settings', { enabled: 'no' }, auth(1))).body.error, 'VALIDATION_FAILED');

  // The working directory: only its two fields, and a folder that is created.
  const before = await call(url, 'GET', '/v1/device-settings/auth/me', undefined, auth(1));
  assert.deepEqual(Object.keys(before.body).sort(), ['effective_work_dir', 'work_dir']);
  assert.equal(before.body.work_dir, null);
  assert.equal(before.body.effective_work_dir, process.env.TASKS_BASE_DIR);
  const folder = path.join(root, 'peer-work');
  const saved = await call(url, 'PUT', '/v1/device-settings/auth/settings', { work_dir: `  ${folder} `, username: 'root' }, auth(1));
  assert.deepEqual([saved.status, saved.body], [200, { success: true, work_dir: folder }]);
  assert.ok(fs.statSync(folder).isDirectory());
  assert.equal(memory.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'no other field reached the table');
  assert.equal((await call(url, 'GET', '/v1/device-settings/auth/me', undefined, auth(1))).body.work_dir, folder);
  assert.equal((await call(url, 'PUT', '/v1/device-settings/auth/settings', { work_dir: 5 }, auth(1))).body.error, 'INVALID_WORK_DIRECTORY');
  assert.equal((await call(url, 'PUT', '/v1/device-settings/auth/settings', { work_dir: '' }, auth(1))).body.work_dir, null, 'empty is the default again');

  // Agent skills and rules sync go to the page's own routers.
  assert.equal((await call(url, 'GET', '/v1/device-settings/agent-skills', undefined, auth(1))).body.skills[0].name, 'tcli');
  assert.equal((await call(url, 'POST', '/v1/device-settings/agent-skills/tcli/install', {}, auth(1))).body.ok, true);
  assert.deepEqual(seen.skills, ['tcli']);
  assert.deepEqual((await call(url, 'PUT', '/v1/device-settings/rule-sync', { role: 'receive', codex: true, secret: 'x' }, auth(1))).body, { role: 'receive' });
  assert.deepEqual(seen.rule, [{ role: 'receive', codex: true }]);
  assert.equal((await call(url, 'POST', '/v1/device-settings/rule-sync/push', {}, auth(1))).body.role, 'source');

  // The window: the switch is taken, the shared language is not, and the page language of this machine is never noted.
  const widget = await call(url, 'GET', '/v1/device-settings/attention/widget/settings', undefined, { ...auth(1), 'Accept-Language': 'zh-CN' });
  assert.equal(widget.body.enabled, true);
  assert.equal(memory.prepare('SELECT COUNT(*) AS n FROM system_state WHERE key = ?').get(require('../services/attention-widget').PAGE_LANGUAGE_KEY).n, 0);
  const switched = await call(url, 'PUT', '/v1/device-settings/attention/widget/settings', { enabled: false, language: 'zh' }, auth(1));
  assert.deepEqual([switched.status, switched.body.enabled, switched.body.language], [200, false, 'auto']);
  assert.deepEqual(widgetSettings.read(), { enabled: false, language: 'auto' });
  assert.deepEqual(seen.widget, [false]);
});

test('/v1/device-settings: the window paths say so when this service has no window', async () => {
  const router = createEngineDeviceSettingsRouter({ serviceLinks: LINKS, requireEngineAuth: fakeEngineAuth, db: memoryDb(), widget: () => null });
  const app = express();
  app.use(express.json());
  app.use('/v1/device-settings', router);
  const url = await listen(app);
  assert.deepEqual(await call(url, 'GET', '/v1/device-settings/attention/widget/settings', undefined, auth(1)).then(r => [r.status, r.body]), [404, { error: 'WIDGET_UNAVAILABLE' }]);
});

// ---- The page side, with a fake peer ----

async function pageApp({ reply, info }) {
  const memory = memoryDb();
  memory.exec(`INSERT INTO remote_servers (id, owner_id, name, base_url, token_cipher, status, created_at) VALUES
    (7, 'local', 'K01', 'tunnel://link-7', 'cipher-7', 'online', '2026-01-01'),
    (8, 'local', 'Plain', 'http://plain', 'cipher-8', 'online', '2026-01-02'),
    (9, 'local', 'Old Mac', 'tunnel://link-9', 'cipher-9', 'online', '2026-01-03'),
    (10, 'local', 'Away', 'tunnel://link-10', 'cipher-10', 'offline', '2026-01-04'),
    (11, 'local', 'Gone', 'tunnel://link-11', 'cipher-11', 'unauthorized', '2026-01-05'),
    (12, 'other', 'Not mine', 'tunnel://link-12', 'cipher-12', 'online', '2026-01-06')`);
  const links = { 7: { id: 'link-7' }, 9: { id: 'link-9' }, 10: { id: 'link-10' }, 11: { id: 'link-11', revoked: true }, 12: { id: 'link-12' } };
  const calls = [];
  const infos = [];
  const unauthorized = [];
  const router = createDeviceSettingsRouter({
    db: memory,
    serviceLinks: { linkForServer: id => links[id] || null, noteUnauthorized: id => unauthorized.push(id) },
    request: async (baseUrl, pathname, token, options) => { calls.push({ baseUrl, pathname, token, options }); return reply(pathname, options); },
    readInfo: async row => { infos.push(row.id); return info(row); },
    decrypt: cipher => `token-of-${cipher}`,
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { user: { login: 'local' } }; next(); });
  app.use('/api/device-settings', router);
  return { url: await listen(app), calls, infos, unauthorized };
}
const peerError = (status, body, message = body && body.error) => Object.assign(new Error(message || `REMOTE_HTTP_${status}`), { statusCode: status, peerBody: body });

test('/api/device-settings/devices: linked devices of this owner only, with support read from /v1/info and kept for a minute', async () => {
  const { url, infos } = await pageApp({
    reply: () => ({}),
    info: row => ({ 7: { capabilities: ['tasks:read', CAPABILITY] }, 9: { capabilities: ['tasks:read'] } })[row.id] || Promise.reject(new Error('REMOTE_OFFLINE')),
  });
  const first = await call(url, 'GET', '/api/device-settings/devices');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { devices: [
    { id: 7, name: 'K01', online: true, supported: true },
    { id: 9, name: 'Old Mac', online: true, supported: false },
    { id: 10, name: 'Away', online: false, supported: null },
  ] }, 'no plain Engine, no revoked link, no other owner; an offline device is not read');
  assert.equal(first.text.includes('tunnel://') || first.text.includes('cipher') || first.text.includes('token'), false, 'no address or token');
  assert.deepEqual(infos.sort(), [7, 9]);
  await call(url, 'GET', '/api/device-settings/devices');
  assert.deepEqual(infos.sort(), [7, 9], 'answered from what is known');
});

test('/api/device-settings/:id/*: only the allowlist, only linked devices, bodies cut down, errors mapped', async () => {
  let next = () => ({ enabled: true });
  const { url, calls, unauthorized } = await pageApp({ reply: (pathname, options) => next(pathname, options), info: () => ({ capabilities: [CAPABILITY] }) });
  // Refused here, before anything is sent.
  for (const route of ['/7/oss/config', '/7/translate/config', '/7/attention/telegram/status', '/7/peer-fs/settings/', '/7/peer-fs/../oss/config', '/007/peer-fs/settings', '/x/peer-fs/settings']) {
    const answer = await call(url, 'GET', `/api/device-settings${route}`);
    assert.ok([404].includes(answer.status), route);
  }
  assert.deepEqual((await call(url, 'GET', '/api/device-settings/7/oss/config')).body, { error: 'DEVICE_SETTING_NOT_ALLOWED' });
  for (const id of [8, 11, 12, 99]) assert.deepEqual((await call(url, 'GET', `/api/device-settings/${id}/peer-fs/settings`)).body, { error: 'DEVICE_NOT_LINKED' }, `row ${id}`);
  assert.equal(calls.length, 0);

  const read = await call(url, 'GET', '/api/device-settings/7/peer-fs/settings');
  assert.deepEqual([read.status, read.body], [200, { enabled: true }]);
  assert.deepEqual(calls.at(-1), { baseUrl: 'tunnel://link-7', pathname: '/v1/device-settings/peer-fs/settings', token: 'token-of-cipher-7', options: { method: 'GET', timeoutMs: 15000 } });
  next = (pathname, options) => ({ enabled: options.body.enabled });
  await call(url, 'PUT', '/api/device-settings/7/attention/widget/settings', { enabled: false, language: 'zh' });
  assert.deepEqual(calls.at(-1).options, { method: 'PUT', body: { enabled: false }, timeoutMs: 20000 }, 'the shared language never goes to the peer');
  await call(url, 'POST', '/api/device-settings/7/agent-skills/tcli/install', { junk: 1 });
  assert.deepEqual([calls.at(-1).pathname, calls.at(-1).options.body, calls.at(-1).options.timeoutMs], ['/v1/device-settings/agent-skills/tcli/install', {}, 60000]);

  // The peer's own error passes as its page would see it.
  next = () => { throw peerError(409, { error: 'RULE_SYNC_SHARED_CHANGED', current: { content_revision: 'r2' } }); };
  assert.deepEqual(await call(url, 'PUT', '/api/device-settings/7/rule-sync/shared', { content: 'x', base_revision: 'r1' }).then(r => [r.status, r.body]), [409, { error: 'RULE_SYNC_SHARED_CHANGED', current: { content_revision: 'r2' } }]);
  next = () => { throw peerError(400, { error: 'Failed to create the working directory: EACCES' }); };
  assert.deepEqual(await call(url, 'PUT', '/api/device-settings/7/auth/settings', { work_dir: '/root/x' }).then(r => [r.status, r.body.error]), [400, 'Failed to create the working directory: EACCES']);
  // An older peer: a plain 404 or a redirect to its page.
  next = () => { throw peerError(404, null); };
  assert.deepEqual(await call(url, 'GET', '/api/device-settings/7/peer-fs/settings').then(r => [r.status, r.body]), [501, { error: 'DEVICE_SETTINGS_UNSUPPORTED' }]);
  next = () => { throw peerError(302, null); };
  assert.equal((await call(url, 'GET', '/api/device-settings/7/peer-fs/settings')).status, 501);
  // A token the peer refuses marks the link; no answer at all is offline.
  next = () => { throw peerError(401, { error: 'ENGINE_TOKEN_INVALID' }); };
  assert.deepEqual(await call(url, 'GET', '/api/device-settings/7/peer-fs/settings').then(r => [r.status, r.body]), [502, { error: 'ENGINE_UNAUTHORIZED' }]);
  assert.deepEqual(unauthorized, [7]);
  next = () => { throw new Error('REMOTE_OFFLINE'); };
  assert.deepEqual(await call(url, 'GET', '/api/device-settings/7/peer-fs/settings').then(r => [r.status, r.body]), [502, { error: 'REMOTE_OFFLINE' }]);
  next = () => { throw new Error('socket hang up'); };
  assert.deepEqual(await call(url, 'GET', '/api/device-settings/7/peer-fs/settings').then(r => [r.status, r.body]), [502, { error: 'ENGINE_OFFLINE' }]);
});

// ---- Two real services ----

function spawnService(t, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-device-settings-real-'));
  const home = path.join(temp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, TAGENT_HOME: '', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'),
      TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local', TA_WIDGET_DISABLED: '1',
      // Agent skills and the rules sync read and write the home folder: a temporary one, never the real ~/.claude or ~/.codex.
      HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { output: '', temp, home };
  child.stderr.on('data', chunk => { state.output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start: ${state.output}`)), 20000);
    child.stdout.on('data', chunk => {
      state.output += chunk;
      const match = state.output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match && !state.url) { clearTimeout(timer); state.url = `http://127.0.0.1:${match[1]}`; resolve(state); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code}: ${state.output}`)); });
  });
}

test('two real services over a real link: A changes B\'s per-device settings, A\'s stay, and B\'s secrets never show', { timeout: 120000 }, async t => {
  const [serverA, serverB] = await Promise.all([
    spawnService(t, { ENGINE_NAME: 'engine-a', SESSION_SECRET: 'device-a-session-secret-device-a-session-secret' }),
    spawnService(t, { ENGINE_NAME: 'engine-b', SESSION_SECRET: 'device-b-session-secret-device-b-session-secret' }),
  ]);
  const a = (method, route, body) => call(serverA.url, method, route, body);
  const b = (method, route, body) => call(serverB.url, method, route, body);
  const SECRETS = ['sk-device-translate-SECRET-41a', 'oss-device-SECRET-93b'];
  assert.equal((await b('PUT', '/api/translate/config', { provider: 'deepseek', apiKey: SECRETS[0], model: 'deepseek-flash' })).status, 200);
  assert.equal((await b('PUT', '/api/oss/config', { enabled: true, region: 'oss-cn-hangzhou', bucket: 'device-bucket', accessKeyId: 'LTAI-device', accessKeySecret: SECRETS[1] })).status, 200);

  // B joins A, so A reaches B through the tunnel.
  const made = await a('POST', '/api/service-links/code', {});
  const joined = await b('POST', '/api/service-links/join', { url: serverA.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const device = await until(async () => {
    const answer = (await a('GET', '/api/device-settings/devices')).body;
    return answer && answer.devices.find(item => item.name === 'engine-b' && item.supported === true);
  }, 'A sees B with the feature', 30000);
  assert.equal(device.online, true);
  const id = device.id;
  const answers = [];
  const onB = async (method, route, body) => { const answer = await a(method, `/api/device-settings/${id}${route}`, body); answers.push(answer.text); return answer; };

  // Peer file access, through the link and only on B.
  assert.deepEqual((await onB('GET', '/peer-fs/settings')).body, { enabled: true });
  assert.deepEqual((await onB('PUT', '/peer-fs/settings', { enabled: false })).body, { enabled: false });
  assert.deepEqual((await b('GET', '/api/peer-fs/settings')).body, { enabled: false });
  assert.deepEqual((await a('GET', '/api/peer-fs/settings')).body, { enabled: true });

  // The working directory: two fields only, saved on B.
  const me = await onB('GET', '/auth/me');
  assert.deepEqual(Object.keys(me.body).sort(), ['effective_work_dir', 'work_dir']);
  assert.equal(me.body.effective_work_dir, path.join(serverB.temp, 'tasks'));
  const workDir = path.join(serverB.temp, 'b-work');
  assert.equal((await onB('PUT', '/auth/settings', { work_dir: workDir })).body.work_dir, workDir);
  assert.equal((await b('GET', '/auth/me')).body.work_dir, workDir);
  assert.equal((await a('GET', '/auth/me')).body.work_dir || null, null);

  // Agent skills and the rules sync of B (its temporary home folder).
  const skills = await onB('GET', '/agent-skills');
  assert.equal(skills.status, 200);
  assert.ok(skills.body.skills.every(skill => !skill.claude || skill.claude.path.startsWith(serverB.home)), 'B\'s own folders');
  const installed = await onB('POST', '/agent-skills/tcli/install', {});
  assert.equal(installed.status, 200, installed.text);
  assert.ok(fs.existsSync(path.join(serverB.home, '.claude', 'skills', 'tcli', 'SKILL.md')), 'written on B');
  assert.equal(fs.existsSync(path.join(serverA.home, '.claude', 'skills', 'tcli')), false, 'not on A');
  const ruleB = (await onB('GET', '/rule-sync')).body;
  const codexA = (await a('GET', '/api/rule-sync')).body.codex;
  assert.equal(ruleB.role, 'off');
  assert.equal((await onB('PUT', '/rule-sync', { codex: !ruleB.codex })).body.codex, !ruleB.codex);
  assert.equal((await b('GET', '/api/rule-sync')).body.codex, !ruleB.codex);
  assert.equal((await a('GET', '/api/rule-sync')).body.codex, codexA, 'A keeps its own');

  // The window switch (never started in test mode).
  const window = await onB('PUT', '/attention/widget/settings', { enabled: false, language: 'zh' });
  assert.deepEqual([window.status, window.body.enabled, window.body.language], [200, false, 'auto']);
  assert.equal((await b('GET', '/api/attention/widget/settings')).body.enabled, false);
  assert.equal((await a('GET', '/api/attention/widget/settings')).body.enabled, true);

  // Nothing outside the list, and none of B's secrets in any answer or log.
  for (const route of ['/oss/config', '/translate/config', '/speech/config', '/attention/tokens', '/remote-tokens']) {
    assert.deepEqual((await onB('GET', route)).body, { error: 'DEVICE_SETTING_NOT_ALLOWED' }, route);
  }
  const exposed = [serverA.output, serverB.output, ...answers].join('\n');
  for (const secret of SECRETS) assert.equal(exposed.includes(secret), false, 'no secret of B reaches A');
});

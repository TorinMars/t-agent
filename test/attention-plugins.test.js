// T-Attention plugin overview: GET /api/attention/plugins (routes/attention.js, services/attention-plugins.js), the local listener
// checks (lib/attention-plugins-local.js) and the skipped notifier plugins (services/attention-notify.js scanNotifiers).
// Every path is a temporary folder: the real ~/.tagent and ~/.claude are never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');
const { createPluginOverview } = require('../services/attention-plugins');
const notify = require('../services/attention-notify');
const local = require('../lib/attention-plugins-local');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'attention-plugins-test-secret-0123456789';
const TOKEN_SECRET = 'tatt_should-never-appear-in-the-answer';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-plugins-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let count = 0;
const newDir = name => { const dir = path.join(tmp, `${name}-${count += 1}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };

// A listeners folder with the real claude manifest, a broken manifest and one of another kind.
function listenersDir() {
  const dir = newDir('listeners');
  writeJson(path.join(dir, 'claude', 'manifest.json'), fs.readFileSync(path.join(ROOT, 'plugins', 'listeners', 'claude', 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'claude', 'hook.js'), '');
  writeJson(path.join(dir, 'broken', 'manifest.json'), '{ not json');
  writeJson(path.join(dir, 'noentry', 'manifest.json'), { name: 'noentry', version: '0.1.0', kind: 'listener', entry: 'missing.js' });
  writeJson(path.join(dir, 'other', 'manifest.json'), { name: 'other', kind: 'notifier' });
  return dir;
}

// A home with a data folder (logged in, hook path set) and a ~/.claude/settings.json with the listener hook.
function setUpHome({ hook = true, login = true, settings = 'synced' } = {}) {
  const home = newDir('home');
  const data = path.join(home, '.tagent');
  if (login) writeJson(path.join(data, 'attention-client.json'), { url: 'http://127.0.0.1:1', token: TOKEN_SECRET });
  if (hook) {
    const script = path.join(home, 'hook.js');
    fs.writeFileSync(script, '');
    fs.mkdirSync(path.join(data, 'listeners'), { recursive: true });
    fs.writeFileSync(path.join(data, 'listeners', 'claude-hook.path'), `${script}\n`);
  }
  const command = 'd="${TAGENT_HOME:-$HOME/.tagent}"; h="$(cat "$d/listeners/claude-hook.path")"; node "$h"';
  if (settings === 'synced') writeJson(path.join(home, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
  if (settings === 'other') writeJson(path.join(home, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } });
  if (settings === 'broken') writeJson(path.join(home, '.claude', 'settings.json'), '{');
  return { home, data };
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  return db;
}

test('readListeners lists every listener manifest; a broken one has an error, other kinds are left out', () => {
  const found = local.readListeners(listenersDir());
  assert.deepEqual(found.map(entry => [entry.name, entry.error]), [
    ['broken', 'manifest.json is not valid JSON'],
    ['claude', null],
    ['noentry', 'the entry missing.js is missing'],
  ]);
  const claude = found.find(entry => entry.name === 'claude');
  assert.equal(claude.version, '1.0.0');
  assert.equal(claude.entry, 'hook.js');
  assert.ok(claude.events.includes('Stop'));
  assert.deepEqual(local.readListeners(path.join(tmp, 'missing')), []);
  assert.deepEqual(local.readListeners().map(entry => entry.name), ['claude'], 'the bundled listener');
});

test('checkListener: hook path, login and the Claude hooks in settings.json (false when missing, null when unreadable)', () => {
  const ready = setUpHome();
  assert.deepEqual(local.checkListener('claude', { dataDir: ready.data, home: ready.home }), { hookPath: true, loggedIn: true, toolHooks: true });
  const bare = setUpHome({ hook: false, login: false, settings: 'none' });
  assert.deepEqual(local.checkListener('claude', { dataDir: bare.data, home: bare.home }), { hookPath: false, loggedIn: false, toolHooks: false });
  assert.equal(local.checkListener('claude', { dataDir: bare.data, home: setUpHome({ settings: 'other' }).home }).toolHooks, false);
  assert.equal(local.checkListener('claude', { dataDir: bare.data, home: setUpHome({ settings: 'broken' }).home }).toolHooks, null);
  // A hook path that points to a file that is gone does not count.
  const stale = setUpHome();
  fs.rmSync(path.join(stale.home, 'hook.js'));
  assert.equal(local.checkListener('claude', { dataDir: stale.data, home: stale.home }).hookPath, false);
  // A listener without a known tool config: toolHooks null. The data folder follows TAGENT_HOME / T_AGENT_DATA_DIR.
  assert.equal(local.checkListener('other', { dataDir: ready.data, home: ready.home }).toolHooks, null);
  assert.equal(local.checkListener('claude', { env: { T_AGENT_DATA_DIR: ready.data }, homedir: () => bare.home }).loggedIn, true);
});

test('scanNotifiers keeps the skipped plugins; the overview lists them with loaded:false next to the loaded ones', () => {
  const dir = newDir('notifiers');
  writeJson(path.join(dir, 'good', 'manifest.json'), { name: 'good', version: '2.0.0', kind: 'notifier', description: 'A good one' });
  fs.writeFileSync(path.join(dir, 'good', 'index.js'), "module.exports = { name: 'good', notify: async () => {}, test: async () => {}, status: config => ({ configured: Boolean(config.ok), summary: 'Ready' }) };");
  writeJson(path.join(dir, 'bad', 'manifest.json'), { name: 'bad', version: '0.1.0', kind: 'notifier', description: 'Has no notify' });
  fs.writeFileSync(path.join(dir, 'bad', 'index.js'), "module.exports = { name: 'bad' };");
  writeJson(path.join(dir, 'nojson', 'manifest.json'), '{');
  const logs = [];
  const scanned = notify.scanNotifiers(dir, (level, message) => logs.push(message));
  assert.deepEqual(scanned.loaded.map(entry => entry.plugin.name), ['good']);
  assert.deepEqual(scanned.skipped.map(entry => [entry.name, entry.version]), [['bad', '0.1.0'], ['nojson', null]]);
  assert.equal(logs.length, 2);

  const service = notify.createAttentionNotify({ db: makeDb(), sessionSecret: SECRET, pluginsDir: dir, getOwner: () => 'local', log: () => {} });
  const listed = service.overview('local');
  assert.deepEqual(listed.find(entry => entry.name === 'good'), {
    name: 'good', version: '2.0.0', description: 'A good one', loaded: true, error: null, configured: false, summary: 'Ready',
    statuses: { waiting_user: 'message', review: 'message', failed: 'message' },
  });
  const bad = listed.find(entry => entry.name === 'bad');
  assert.equal(bad.loaded, false);
  assert.equal(bad.description, 'Has no notify');
  assert.match(bad.error, /notifier interface/);
  assert.equal(bad.configured, null);
  assert.equal(listed.find(entry => entry.name === 'nojson').loaded, false);
  service.stop();
});

test('GET /api/attention/plugins with a session and with a token: listeners with the local state and counts, notifiers, no secrets', async t => {
  const db = makeDb();
  let clock = Date.parse('2026-11-08T10:00:00.000Z');
  const service = createAttentionService({ db, now: () => new Date(clock) });
  const first = service.create({ title: 'session 1', status: 'working', source: 'claude', external_ref: 'claude:1' });
  service.create({ title: 'session 2', status: 'waiting_user', source: 'claude', external_ref: 'claude:2' });
  service.create({ title: 'done one', status: 'done', source: 'claude' });
  service.create({ title: 'by hand', status: 'todo' });
  clock += 60000;
  service.update(first.id, { status: 'review' }, { actor: 'claude' });

  const fake = { name: 'fake', version: '1.0.0', description: 'Fake', notify: async () => {}, test: async () => {}, status: () => ({ configured: true, summary: 'All set' }) };
  const notifier = notify.createAttentionNotify({
    db, sessionSecret: SECRET, notifiers: [fake], getOwner: () => 'local', log: () => {},
    skipped: [{ name: 'broken', version: '0.0.1', description: null, error: 'it does not have the notifier interface' }],
  });
  notifier.saveRules('local', { statuses: ['waiting_user', 'review'], modes: { fake: { waiting_user: 'call', review: 'off' } } });
  const where = setUpHome();
  const plugins = createPluginOverview({ service, notify: notifier, listenersDir: listenersDir(), env: {}, homedir: () => where.home, terminalUser: () => ({ user: null }) });
  const routes = createAttentionRoutes({ service, plugins });
  const app = express();
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'local' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); notifier.stop(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/attention`;

  const viaSession = await fetch(`${base}/plugins`);
  assert.equal(viaSession.status, 200);
  const text = await viaSession.text();
  assert.equal(text.includes(TOKEN_SECRET), false, 'the saved token is never returned');
  const body = JSON.parse(text);
  const claude = body.listeners.find(entry => entry.name === 'claude');
  assert.deepEqual(claude.local, { hookPath: true, loggedIn: true, toolHooks: true, hooksCurrent: false, autoTerminal: false, installable: true, lastEventAt: '2026-11-08T10:01:00.000Z', itemCount: 2 }, 'a hand-made hook entry is not the current one');
  assert.equal(claude.version, '1.0.0');
  assert.equal(body.listeners.find(entry => entry.name === 'broken').error, 'manifest.json is not valid JSON');
  assert.deepEqual(body.listeners.find(entry => entry.name === 'noentry').local, { hookPath: false, loggedIn: true, toolHooks: null, lastEventAt: null, itemCount: 0 });
  assert.deepEqual(body.notifiers, [
    { name: 'fake', version: '1.0.0', description: 'Fake', loaded: true, error: null, configured: true, summary: 'All set', statuses: { waiting_user: 'call', review: 'off' } },
    { name: 'broken', version: '0.0.1', description: null, error: 'it does not have the notifier interface', loaded: false, configured: null, summary: null, statuses: {} },
  ]);

  const { token } = service.createToken({ name: 'cli' });
  const viaToken = await fetch(`${base}/plugins`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(viaToken.status, 200);
  assert.deepEqual(await viaToken.json(), body, 'a token sees the same overview (the notifier part of the single user)');
  assert.equal((await fetch(`${base}/plugins`, { headers: { Authorization: 'Bearer tatt_wrong' } })).status, 401);
});

test('without a plugin overview the route is a JSON 404; the terminal user\'s home is read when the service drops privileges', async t => {
  const db = makeDb();
  const service = createAttentionService({ db });
  const routes = createAttentionRoutes({ service });
  const app = express();
  app.use('/api/attention', routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const missing = await fetch(`http://127.0.0.1:${server.address().port}/api/attention/plugins`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'NOT_FOUND');

  const user = setUpHome();
  const root = setUpHome({ hook: false, login: false, settings: 'none' });
  const overview = createPluginOverview({ service, listenersDir: listenersDir(), env: {}, homedir: () => root.home, terminalUser: () => ({ user: { name: 'dev', uid: 1000, gid: 1000, home: user.home } }) });
  const claude = overview.overview('local').listeners.find(entry => entry.name === 'claude');
  assert.deepEqual(claude.local, { hookPath: true, loggedIn: true, toolHooks: true, hooksCurrent: false, autoTerminal: false, installable: true, lastEventAt: null, itemCount: 0 });
  assert.deepEqual(overview.overview('local').notifiers, [], 'no notify service: no notifiers');
});

// Manifest-driven notifier settings (services/attention-notify.js, routes/attention.js, services/attention-plugins.js): the manifest
// `config` schema, values validated and stored encrypted per user, secrets returned only as { set }, the enable switch that gates notify,
// POST /api/attention/plugins/:name/test without secrets in its message, and the move of Telegram's ring time into the manifest settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const notify = require('../services/attention-notify');
const { createAttentionService } = require('../services/attention');
const { createAttentionRoutes } = require('../routes/attention');
const { createPluginOverview } = require('../services/attention-plugins');
const { decryptToken, encryptToken } = require('../lib/token-crypto');
const { createTelegramNotifier } = require('../plugins/notifiers/telegram');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'attention-plugin-config-test-secret-0123456789';
const API_KEY = 'pk_live_very-secret-value-0001';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-plugin-config-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SCHEMA = [
  { key: 'url', label: 'Webhook URL', type: 'string', required: true, placeholder: 'https://example.com/hook' },
  { key: 'apiKey', label: 'API key', type: 'secret', help: 'From the provider' },
  { key: 'seconds', label: 'Ring time (seconds)', type: 'number', integer: true, min: 5, max: 120, default: 30 },
  { key: 'loud', label: 'Loud', type: 'boolean', default: false },
  { key: 'level', label: 'Level', type: 'select', options: ['low', { value: 'high', label: 'High' }], default: 'low' },
];
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};
const rawState = (db, key) => { const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key); return row ? row.value : null; };
const readState = (db, key) => { const raw = rawState(db, key); return raw ? JSON.parse(decryptToken(raw, SECRET)) : null; };
const writeState = (db, key, value) => db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run(key, encryptToken(JSON.stringify(value), SECRET));
const settle = () => new Promise(resolve => setImmediate(resolve));
const item = (id, status) => ({ id, title: `Item ${id}`, status, source: 'claude', attention_reason: null, link_url: null });

function fakePlugin(name = 'hook', behaviour = {}) {
  const calls = [];
  const tests = [];
  return {
    calls, tests,
    plugin: {
      name,
      ready: config => Boolean(config.url),
      async notify(args) { calls.push(args); return { outcome: 'sent' }; },
      async test(config, extra) { tests.push({ config, extra }); if (behaviour.test) return behaviour.test(config, extra); return { ok: true }; },
    },
  };
}
function makeService({ plugin, manifest = { config: SCHEMA }, db = makeDb(), timers, ...rest } = {}) {
  const fake = plugin || fakePlugin();
  const service = notify.createAttentionNotify({
    db, sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [fake.plugin || fake], manifests: { [(fake.plugin || fake).name]: manifest },
    log: () => {}, ...(timers ? { timers } : {}), ...rest,
  });
  service.saveRules('owner', { messageDelayMinutes: 0 }); // messages at once; the wait is tested in test/attention-notify.test.js
  return { service, db, fake };
}

test('validateConfigSchema accepts the five types and cleans them; bad schemas are refused with the reason', () => {
  const clean = notify.validateConfigSchema(SCHEMA);
  assert.deepEqual(clean.map(field => [field.key, field.type, field.required]), [['url', 'string', true], ['apiKey', 'secret', false], ['seconds', 'number', false], ['loud', 'boolean', false], ['level', 'select', false]]);
  assert.deepEqual(clean[4].options, [{ value: 'low', label: 'low' }, { value: 'high', label: 'High' }]);
  assert.equal(clean[2].default, 30);
  assert.deepEqual(notify.validateConfigSchema(undefined), []);
  const bad = [
    [{}, /must be a list/],
    [[{ key: '1x', label: 'A', type: 'string' }], /key must be/],
    [[{ key: 'a', label: 'A', type: 'string' }, { key: 'a', label: 'B', type: 'string' }], /listed twice/],
    [[{ key: 'a', type: 'string' }], /label is missing/],
    [[{ key: 'a', label: 'A', type: 'color' }], /type must be one of/],
    [[{ key: 'a', label: 'A', type: 'select' }], /options must be a list/],
    [[{ key: 'a', label: 'A', type: 'string', options: ['x'] }], /only a select has options/],
    [[{ key: 'a', label: 'A', type: 'secret', default: 'x' }], /secret cannot have a default/],
    [[{ key: 'a', label: 'A', type: 'number', min: 10, max: 1 }], /min is above max/],
    [[{ key: 'a', label: 'A', type: 'number', min: 1, max: 5, default: 9 }], /the default is not valid/],
    [[{ key: 'a', label: 'A', type: 'string', min: 1 }], /only a number has/],
    [[{ key: 'a', label: 'A', type: 'boolean', required: 'yes' }], /required must be true or false/],
  ];
  for (const [schema, reason] of bad) assert.throws(() => notify.validateConfigSchema(schema), reason, JSON.stringify(schema));
});

test('scanNotifiers skips a plugin with an invalid config schema and loads the real Telegram manifest with its settings', () => {
  const dir = path.join(tmp, 'scan');
  fs.mkdirSync(path.join(dir, 'odd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'odd', 'manifest.json'), JSON.stringify({ name: 'odd', version: '1', kind: 'notifier', config: [{ key: 'a', type: 'nope', label: 'A' }] }));
  fs.writeFileSync(path.join(dir, 'odd', 'index.js'), "module.exports = { name: 'odd', notify: async () => {}, test: async () => {} };");
  const scanned = notify.scanNotifiers(dir, () => {});
  assert.deepEqual(scanned.loaded, []);
  assert.match(scanned.skipped[0].error, /invalid config in manifest\.json: config field a: type must be one of/);

  const real = notify.scanNotifiers(path.join(ROOT, 'plugins', 'notifiers'), () => {});
  const telegram = real.loaded.find(entry => entry.plugin.name === 'telegram');
  assert.ok(telegram, 'the Telegram plugin still loads');
  assert.equal(telegram.manifest.customUi, 'telegram');
  assert.equal(telegram.manifest.test, true);
  assert.deepEqual(telegram.manifest.config.map(field => [field.key, field.type, field.default, field.min, field.max]), [['callSeconds', 'number', 30, 5, 120]]);
});

test('normalizeConfigValues: types, unknown keys, required, empty secret keeps, { set: true } keeps, null clears, empty goes back to the default', () => {
  const schema = notify.validateConfigSchema(SCHEMA);
  const current = { url: 'https://a', apiKey: API_KEY, seconds: 45, level: 'high' };
  assert.deepEqual(notify.normalizeConfigValues(schema, { url: ' https://b ' }, current), { url: 'https://b', apiKey: API_KEY, seconds: 45, level: 'high' });
  assert.equal(notify.normalizeConfigValues(schema, { apiKey: '' }, current).apiKey, API_KEY, 'an empty secret keeps the saved one');
  assert.equal(notify.normalizeConfigValues(schema, { apiKey: { set: true } }, current).apiKey, API_KEY, 'the masked value sent back keeps it');
  assert.equal('apiKey' in notify.normalizeConfigValues(schema, { apiKey: null }, current), false, 'null clears a secret');
  assert.equal(notify.normalizeConfigValues(schema, { apiKey: 'new-key' }, current).apiKey, 'new-key');
  assert.equal('seconds' in notify.normalizeConfigValues(schema, { seconds: '' }, current), false, 'an emptied number goes back to its default');
  assert.equal(notify.normalizeConfigValues(schema, { seconds: '60' }, current).seconds, 60);
  assert.equal(notify.normalizeConfigValues(schema, { loud: true }, current).loud, true);
  const refused = [
    [{ nope: 1 }, /Unknown setting: nope/],
    [{ seconds: 3 }, /Ring time \(seconds\) must be a whole number from 5 to 120/],
    [{ seconds: 7.5 }, /whole number/],
    [{ seconds: 'abc' }, /whole number/],
    [{ loud: 'yes' }, /Loud must be on or off/],
    [{ level: 'mid' }, /Level: choose one of the listed values/],
    [{ url: 5 }, /Webhook URL must be text/],
    [{ url: '' }, /Webhook URL is required/],
    [[], /Invalid settings/],
  ];
  for (const [body, reason] of refused) assert.throws(() => notify.normalizeConfigValues(schema, body, current), reason, JSON.stringify(body));
  assert.throws(() => notify.normalizeConfigValues(schema, {}, {}), /Webhook URL is required/, 'a required field without a value');
});

test('getPluginConfig masks secrets as { set }, the store is encrypted, savePluginConfig keeps left-out fields', () => {
  const { service, db } = makeService();
  const empty = service.getPluginConfig('hook', 'owner');
  assert.equal(empty.enabled, true, 'a notifier is on by default');
  assert.deepEqual(empty.values, { apiKey: { set: false }, seconds: 30, loud: false, level: 'low' });
  assert.equal(empty.schema.length, 5);
  assert.equal(empty.test, true);
  const saved = service.savePluginConfig('hook', 'owner', { values: { url: 'https://hook.example', apiKey: API_KEY, seconds: 50 } });
  assert.deepEqual(saved.values, { url: 'https://hook.example', apiKey: { set: true }, seconds: 50, loud: false, level: 'low' });
  assert.equal(JSON.stringify(saved).includes(API_KEY), false, 'the secret is never returned');
  assert.equal(rawState(db, 'attention-plugin:hook:owner').includes(API_KEY), false, 'stored encrypted');
  assert.equal(readState(db, 'attention-plugin:hook:owner').values.apiKey, API_KEY);
  const again = service.savePluginConfig('hook', 'owner', { enabled: false });
  assert.equal(again.enabled, false);
  assert.equal(again.values.url, 'https://hook.example', 'values stay when only the switch changes');
  assert.equal(readState(db, 'attention-plugin:hook:owner').values.apiKey, API_KEY);
  const keep = service.savePluginConfig('hook', 'owner', { values: { apiKey: '', loud: true } });
  assert.equal(readState(db, 'attention-plugin:hook:owner').values.apiKey, API_KEY, 'an empty secret keeps the saved one');
  assert.equal(keep.values.loud, true);
  assert.equal(keep.values.seconds, 50);
  assert.equal(service.getPluginConfig('hook', 'other').values.url, undefined, 'per user');
  assert.throws(() => service.savePluginConfig('hook', 'owner', { enabled: 'yes' }), /enabled must be true or false/);
  assert.throws(() => service.savePluginConfig('hook', 'owner', { other: 1 }), /Unknown field: other/);
  assert.throws(() => service.getPluginConfig('missing', 'owner'), error => error.statusCode === 404);
  const overview = service.overview('owner')[0];
  assert.equal(overview.enabled, false);
  assert.equal(overview.settings, true);
  assert.equal(overview.configured, true, 'without a status hook: every required field has a value');
  service.stop();
});

test('a disabled plugin gets no notify call, also not a delayed call that was waiting; notify gets the values', async () => {
  const timers = { list: [], setTimeout(fn) { this.list.push(fn); return this.list.length; }, clearTimeout() {} };
  const { service, fake } = makeService({ timers });
  service.savePluginConfig('hook', 'owner', { values: { url: 'https://hook.example', apiKey: API_KEY } });
  await Promise.all(service.handle({ kind: 'updated', item: item(1, 'waiting_user'), previous: item(1, 'working'), event: { actor: 'claude' } }));
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].values, { url: 'https://hook.example', apiKey: API_KEY, seconds: 30, loud: false, level: 'low' });
  assert.equal(fake.calls[0].config.url, 'https://hook.example', 'config also carries the values');

  service.savePluginConfig('hook', 'owner', { enabled: false });
  const tasks = service.handle({ kind: 'updated', item: item(2, 'waiting_user'), previous: item(2, 'working'), event: { actor: 'claude' } });
  assert.equal(tasks.length, 0);
  await settle();
  assert.equal(fake.calls.length, 1, 'switched off: nothing is sent');

  service.savePluginConfig('hook', 'owner', { enabled: true });
  service.saveRules('owner', { modes: { hook: { failed: 'call' } }, callDelayMinutes: 5 });
  service.handle({ kind: 'updated', item: item(3, 'failed'), previous: item(3, 'working'), event: { actor: 'claude' } });
  assert.equal(timers.list.length >= 1, true, 'a call is planned');
  service.savePluginConfig('hook', 'owner', { enabled: false });
  timers.list.at(-1)();
  await settle();
  assert.equal(fake.calls.length, 1, 'the planned call is dropped when the plugin is switched off before it fires');
  service.stop();
});

async function serve(t, plugins, service) {
  const routes = createAttentionRoutes({ service, plugins });
  const app = express();
  app.use('/api/attention', routes.bearer);
  app.use(express.json());
  app.use('/api/attention', (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); }, routes.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { routes.closeStreams(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/api/attention`;
}
const send = async (url, method = 'GET', body, headers = {}) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, data: text ? JSON.parse(text) : null };
};

test('HTTP: GET/PUT /plugins/:name/config and POST /plugins/:name/test; tokens are refused; the test message holds no secret', async t => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  const attention = createAttentionService({ db });
  let failWith = null;
  const fake = fakePlugin('hook', { test: async () => { if (failWith) throw new Error(failWith); return { ok: true, message: 'Delivered to the hook' }; } });
  const { service } = makeService({ plugin: fake, db, manifest: { config: SCHEMA, customUi: null } });
  t.after(() => { service.stop(); db.close(); });
  const plugins = createPluginOverview({ service: attention, notify: service, listenersDir: path.join(tmp, 'none'), env: {}, homedir: () => tmp, terminalUser: () => ({ user: null }) });
  const base = await serve(t, plugins, attention);

  const first = await send(`${base}/plugins/hook/config`);
  assert.equal(first.status, 200);
  assert.equal(first.data.enabled, true);
  assert.deepEqual(first.data.values.apiKey, { set: false });

  const bad = await send(`${base}/plugins/hook/config`, 'PUT', { values: { url: 'https://h', seconds: 500 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'INVALID_SETTINGS');
  assert.equal(bad.data.message, 'Ring time (seconds) must be a whole number from 5 to 120');

  const saved = await send(`${base}/plugins/hook/config`, 'PUT', { values: { url: 'https://h', apiKey: API_KEY } });
  assert.equal(saved.status, 200);
  assert.equal(saved.text.includes(API_KEY), false);
  assert.deepEqual(saved.data.values.apiKey, { set: true });
  assert.equal((await send(`${base}/plugins`)).text.includes(API_KEY), false, 'the overview has no secret either');

  const ok = await send(`${base}/plugins/hook/test`, 'POST');
  assert.deepEqual(ok.data, { ok: true, message: 'Delivered to the hook' });
  assert.equal(fake.tests.at(-1).extra.values.apiKey, API_KEY, 'the plugin gets the real values');
  assert.equal(fake.tests.at(-1).extra.owner, 'owner');

  failWith = `request to https://h?key=${API_KEY} failed`;
  const failed = await send(`${base}/plugins/hook/test`, 'POST');
  assert.equal(failed.status, 200);
  assert.equal(failed.data.ok, false);
  assert.equal(failed.text.includes(API_KEY), false, 'a secret in the error is hidden');
  assert.equal(failed.data.message, 'request to https://h?key=[hidden] failed');

  await send(`${base}/plugins/hook/config`, 'PUT', { enabled: false });
  assert.deepEqual((await send(`${base}/plugins/hook/test`, 'POST')).data, { ok: false, message: 'The plugin is turned off' });
  assert.equal((await send(`${base}/plugins`)).data.notifiers[0].enabled, false, 'the overview shows the switch');

  assert.equal((await send(`${base}/plugins/missing/config`)).status, 404);
  assert.equal((await send(`${base}/plugins/missing/test`, 'POST')).data.error, 'NOT_FOUND');

  const { token } = attention.createToken({ name: 'cli' });
  const viaToken = await send(`${base}/plugins/hook/config`, 'GET', undefined, { Authorization: `Bearer ${token}` });
  assert.equal(viaToken.status, 403);
  assert.equal(viaToken.data.error, 'TOKEN_NOT_ALLOWED');
  assert.equal((await send(`${base}/plugins/hook/config`, 'PUT', { enabled: true }, { Authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await send(`${base}/plugins/hook/test`, 'POST', undefined, { Authorization: `Bearer ${token}` })).status, 403);
});

test('HTTP: without a notify service the settings routes are a JSON 404', async t => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  t.after(() => db.close());
  const attention = createAttentionService({ db });
  const base = await serve(t, null, attention);
  const res = await send(`${base}/plugins/telegram/config`);
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'NOT_FOUND');
});

test('Telegram: a saved ring time moves into the manifest settings on first read and keeps working; the old route writes there too', async t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'notifiers', 'telegram', 'manifest.json'), 'utf8'));
  const db = makeDb();
  const old = { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef', session: 'SESSION-STRING-1234567890', phone: '+86*******78', account: { id: '1', name: 'Ann' }, target: { input: 'bob', id: '2', accessHash: '3', username: 'bob', name: 'Bob' }, callSeconds: 45 };
  writeState(db, 'attention-notify:telegram:owner', old);
  const plugin = createTelegramNotifier({ loadGram: () => { throw new Error('no network in this test'); } });
  const logs = [];
  const service = notify.createAttentionNotify({ db, sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], manifests: { telegram: manifest }, log: (level, message) => logs.push(message) });
  t.after(() => { service.stop(); plugin.close(); });

  const config = service.getPluginConfig('telegram', 'owner');
  assert.deepEqual(config.values, { callSeconds: 45 }, 'the saved value, not the default');
  assert.equal(config.customUi, 'telegram');
  assert.equal(readState(db, 'attention-plugin:telegram:owner').values.callSeconds, 45);
  const own = readState(db, 'attention-notify:telegram:owner');
  assert.equal('callSeconds' in own, false, 'moved, not copied');
  assert.equal(own.session, old.session, 'the login stays where it was');
  assert.deepEqual(own.target, old.target);
  assert.ok(logs.some(line => /telegram: moved 1 setting\(s\) of owner/.test(line)));

  // The plugin still sees the ring time (its status, the summary and the ready check), and is still configured.
  const entry = service.overview('owner')[0];
  assert.equal(entry.configured, true);
  assert.equal(entry.enabled, true);
  assert.equal(entry.settings, true);
  assert.equal(JSON.stringify(entry).includes(old.session), false);

  // The old endpoint of the Telegram section (PUT /api/attention-notify/telegram/config) writes the ring time into the manifest settings.
  const app = express();
  app.use((req, res, next) => { req.session = { user: { login: 'owner' } }; next(); });
  app.use('/api/attention-notify', service.createRouter({ requireAuth: (req, res, next) => next(), clientOrigin: (req, res, next) => next() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/attention-notify`;
  const put = await send(`${base}/telegram/config`, 'PUT', { callSeconds: 60 });
  assert.equal(put.status, 200);
  assert.equal(put.data.callSeconds, 60);
  assert.equal(service.getPluginConfig('telegram', 'owner').values.callSeconds, 60);
  assert.equal('callSeconds' in readState(db, 'attention-notify:telegram:owner'), false);
  assert.equal((await send(`${base}/telegram/status`)).data.callSeconds, 60);

  // And the generic form's save is what the Telegram section reads.
  service.savePluginConfig('telegram', 'owner', { values: { callSeconds: 20 } });
  assert.equal((await send(`${base}/telegram/status`)).data.callSeconds, 20);
  assert.equal(readState(db, 'attention-notify:telegram:owner').session, old.session, 'saving the form leaves the login alone');

  // Logging out forgets the login only; the ring time stays.
  await send(`${base}/telegram/logout`, 'POST');
  assert.equal(readState(db, 'attention-notify:telegram:owner'), null);
  assert.equal(service.getPluginConfig('telegram', 'owner').values.callSeconds, 20);
});

test('a user without stored Telegram settings gets the defaults and nothing is written on read', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'notifiers', 'telegram', 'manifest.json'), 'utf8'));
  const db = makeDb();
  const plugin = createTelegramNotifier({ loadGram: () => { throw new Error('no network'); } });
  const service = notify.createAttentionNotify({ db, sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], manifests: { telegram: manifest }, log: () => {} });
  assert.deepEqual(service.getPluginConfig('telegram', 'owner').values, { callSeconds: 30 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM system_state').get().n, 0);
  service.stop();
  plugin.close();
});

test('scrubSecrets and publicValues', () => {
  assert.equal(notify.scrubSecrets('a abcd b abcd', ['abcd', 'x', null]), 'a [hidden] b [hidden]');
  const schema = notify.validateConfigSchema(SCHEMA);
  assert.deepEqual(notify.publicValues(schema, { apiKey: API_KEY, url: 'u' }), { url: 'u', apiKey: { set: true }, seconds: 30, loud: false, level: 'low' });
});

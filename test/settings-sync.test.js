// Settings sync across linked devices (services/settings-sync.js): the registry adapters of every synced setting, the conflict rules, the sealed
// payloads, the rounds (push after a debounced local change, pull when a link comes online, older peers skipped), the hidden-devices mapping between
// machines, and two real server.js processes linked through a real service-link tunnel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-settings-sync-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'settings-sync-test-secret-settings-sync-test';
delete process.env.TAGENT_HOME;

const express = require('express');
const Database = require('better-sqlite3');
const db = require('../db');
const sync = require('../services/settings-sync');
const syncStore = require('../services/settings-sync-store');
const { createSettingsSync, defaultRegistry, isNewer, seal, open, deriveLinkKey, aadOf, CAPABILITY, SCOPES } = sync;

const SECRET = process.env.SESSION_SECRET;
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(base, method, route, body, headers = HEADERS) {
  const response = await fetch(base + route, { method, redirect: 'manual', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
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
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function memoryDb() {
  const memory = new Database(':memory:');
  memory.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE engine_identity (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE remote_servers (id INTEGER PRIMARY KEY, owner_id TEXT, name TEXT);`);
  return memory;
}

// ---- Two in-process services joined by one link, the requests going straight to the other side's engine handlers (as JSON, like the wire) ----
const LINK = '0b9a2f7c-1d2e-4f3a-8b4c-5d6e7f8a9b0c';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_TO_B = `tae_${'a'.repeat(43)}`; // A calls B with it (B issued it)
const TOKEN_TO_A = `tae_${'b'.repeat(43)}`;

function pairOf({ keys = ['translate', 'oss', 'notify-rules'], capabilitiesB = [CAPABILITY], debounceMs = 20, idA = ID_A, idB = ID_B, wrongHashOnB = false, tamper = null } = {}) {
  const wire = [];
  const logs = [];
  const log = { warn: message => logs.push(String(message)), error: message => logs.push(String(message)), info: message => logs.push(String(message)) };
  const make = (name, instanceId, peerName, token, ownHash, capabilities) => {
    const values = {};
    const registry = keys.map(key => ({
      key,
      read: () => (Object.hasOwn(values, key) ? values[key] : null),
      write: (owner, value) => { if (value === 'REFUSED') throw Object.assign(new Error('INVALID_SYNC_VALUE'), { statusCode: 400 }); values[key] = value; },
    }));
    const clock = { now: 1000 };
    const listeners = new Set();
    const peer = { id: LINK, name: peerName, online: true, remoteServerId: 1, instanceId: null, baseUrl: `fake://${peerName}`, token };
    const links = {
      peers: () => [peer],
      onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      emit: () => { for (const listener of listeners) listener(LINK); },
      noteUnauthorized() {},
    };
    const side = { name, instanceId, values, clock, peer, links, capabilities, calls: [] };
    side.service = createSettingsSync({
      db: memoryDb(), sessionSecret: `${name}-session-secret`, serviceLinks: links, registry, owner: () => 'owner',
      identity: () => ({ instance_id: instanceId, name }), issuedTokenHash: () => ownHash,
      request: (...args) => dispatch(side, ...args), now: () => clock.now, log, intervalMs: 0, debounceMs,
    });
    return side;
  };
  const a = make('A', idA, 'B', TOKEN_TO_B, sha(TOKEN_TO_A), [CAPABILITY]);
  const b = make('B', idB, 'A', TOKEN_TO_A, wrongHashOnB ? sha('tae_something_else') : sha(TOKEN_TO_B), capabilitiesB);
  a.other = b; b.other = a;
  async function dispatch(from, baseUrl, route, token, opts = {}) {
    const target = from.other;
    const body = opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body));
    if (tamper && body && body.sealed) tamper(body.sealed);
    const method = opts.method || 'GET';
    from.calls.push(`${method} ${route.split('?')[0]}`);
    wire.push({ from: from.name, method, route, body });
    if (!from.peer.online) throw Object.assign(new Error('REMOTE_OFFLINE'), { statusCode: 502 });
    const link = { id: LINK, revoked: false, peer_instance_id: from.instanceId };
    const url = new URL(route, 'http://peer');
    let answer;
    try {
      if (url.pathname === '/v1/info') answer = { capabilities: target.capabilities };
      else if (!target.capabilities.includes(CAPABILITY)) throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
      else if (method === 'GET' && url.pathname === '/v1/settings-sync') answer = target.service.engineDescribe(link, url.searchParams.get('public_key'));
      else if (method === 'POST' && url.pathname === '/v1/settings-sync/pull') answer = target.service.enginePull(link, body);
      else if (method === 'PUT' && url.pathname === '/v1/settings-sync') answer = target.service.enginePush(link, body);
      else throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
    } catch (error) {
      throw Object.assign(new Error(error.message), { statusCode: error.statusCode || 500 });
    }
    const copy = JSON.parse(JSON.stringify(answer));
    wire.push({ to: from.name, route, answer: copy });
    return copy;
  }
  return { a, b, wire, logs };
}

const changeOn = (side, key, value, at) => {
  if (at !== undefined) side.clock.now = at;
  side.values[key] = value;
  side.service.noteLocalChange(key);
};

// ---- Rules ----

test('newer wins, a tie goes to the greater instance id, and a value beats a key that never had one', () => {
  const v = (updated_at, updated_by, hash = 'h') => ({ updated_at, updated_by, hash });
  assert.equal(isNewer(v(200, 'a'), v(100, 'b')), true);
  assert.equal(isNewer(v(100, 'b'), v(200, 'a')), false);
  assert.equal(isNewer(v(100, 'b'), v(100, 'a')), true, 'tie: the greater instance id');
  assert.equal(isNewer(v(100, 'a'), v(100, 'b')), false);
  assert.equal(isNewer(v(100, 'a'), v(100, 'a')), false, 'the same version is not newer');
  assert.equal(isNewer(v(0, 'a'), v(0, 'b', null)), true, 'first sync: a value beats a never-set key even with the smaller id');
  assert.equal(isNewer(v(0, 'z', null), v(0, 'a')), false);
  assert.equal(isNewer(v(0, 'z', null), v(0, 'a', null)), false, 'two keys that never had a value: nothing to send');
  assert.equal(isNewer(v(500, 'a', null), v(0, 'b')), true, 'a tombstone with a real time beats a value from before the feature');
  assert.equal(isNewer(v(0, 'a'), v(500, 'b', null)), false);
});

test('envelopes: the right key and direction open them; a wrong key, another direction or a changed byte fails closed', () => {
  const pair = () => {
    const one = crypto.generateKeyPairSync('x25519');
    const two = crypto.generateKeyPairSync('x25519');
    const pub = key => key.export({ format: 'jwk' }).x;
    return { one, two, pub };
  };
  const { one, two, pub } = pair();
  const hashes = [sha('tae_one'), sha('tae_two')];
  const k1 = deriveLinkKey({ privateKey: one.privateKey, publicKey: pub(two.publicKey), linkId: LINK, tokenHashes: hashes });
  const k2 = deriveLinkKey({ privateKey: two.privateKey, publicKey: pub(one.publicKey), linkId: LINK, tokenHashes: [...hashes].reverse() });
  assert.deepEqual(k1, k2, 'both ends derive the same key');
  const aad = aadOf('push', ID_A, LINK);
  const envelope = seal(k1, { values: { translate: { value: { apiKey: 'sk-envelope-secret' } } } }, aad);
  assert.equal(JSON.stringify(envelope).includes('sk-envelope-secret'), false);
  assert.deepEqual(open(k2, envelope, aad).values.translate.value, { apiKey: 'sk-envelope-secret' });

  const fails = (fn, code = 'SETTINGS_SYNC_DECRYPT_FAILED') => assert.throws(fn, error => error.message === code && error.statusCode === 400 && !String(error.stack).includes('sk-envelope-secret'));
  const other = deriveLinkKey({ privateKey: one.privateKey, publicKey: pub(two.publicKey), linkId: LINK, tokenHashes: [sha('tae_one'), sha('tae_three')] });
  fails(() => open(other, envelope, aad));
  const otherLink = deriveLinkKey({ privateKey: one.privateKey, publicKey: pub(two.publicKey), linkId: 'another-link', tokenHashes: hashes });
  fails(() => open(otherLink, envelope, aad));
  fails(() => open(k2, envelope, aadOf('pull', ID_A, LINK)), 'SETTINGS_SYNC_DECRYPT_FAILED');
  fails(() => open(k2, envelope, aadOf('push', ID_B, LINK)));
  const flipped = Buffer.from(envelope.data, 'base64url');
  flipped[0] ^= 1;
  fails(() => open(k2, { ...envelope, data: flipped.toString('base64url') }, aad));
  fails(() => open(k2, { ...envelope, tag: Buffer.alloc(16).toString('base64url') }, aad));
  fails(() => open(k2, { ...envelope, v: 2 }, aad));
  fails(() => open(k2, null, aad));
  assert.throws(() => deriveLinkKey({ privateKey: one.privateKey, publicKey: 'not a key', linkId: LINK, tokenHashes: hashes }), /SETTINGS_SYNC_BAD_KEY/);
});

// ---- Rounds between two services ----

test('a local change is pushed after the debounce, once, and comes back the other way; secrets never travel or log in the clear', async () => {
  const { a, b, wire, logs } = pairOf({ debounceMs: 60 });
  a.service.reconcile(); b.service.reconcile(); // what start() does first: the values of before get their metadata
  changeOn(a, 'translate', { enabled: true, providers: { deepseek: { apiKey: 'sk-translate-SECRET-111' } } }, 5000);
  for (let i = 0; i < 4; i += 1) a.service.noteLocalChange('translate');
  await settle(20);
  assert.equal(a.calls.length, 0, 'nothing before the debounce');
  await until(() => b.values.translate && b.values.translate.providers, 'A to B');
  await settle();
  assert.equal(a.calls.filter(entry => entry === 'GET /v1/info').length, 1, 'many changes in the debounce make one round');
  assert.deepEqual(b.values.translate, a.values.translate);
  assert.deepEqual(a.service.meta().translate.updated_at, b.service.meta().translate.updated_at);
  assert.equal(b.service.meta().translate.updated_by, ID_A);

  changeOn(b, 'oss', { accessKeySecret: 'oss-SECRET-222', bucket: 'bucket' }, 6000);
  await until(() => a.values.oss && a.values.oss.bucket === 'bucket', 'B to A');
  assert.deepEqual(a.values.oss, b.values.oss);

  const everything = JSON.stringify(wire) + logs.join('\n') + JSON.stringify(a.service.view()) + JSON.stringify(b.service.view());
  for (const secret of ['sk-translate-SECRET-111', 'oss-SECRET-222']) assert.equal(everything.includes(secret), false, `${secret} never in the clear`);
  assert.ok(wire.some(entry => entry.body && entry.body.sealed), 'a push carried an envelope');

  const view = a.service.view();
  const translate = view.keys.find(entry => entry.key === 'translate');
  assert.deepEqual(translate.synced_peers, ['B']);
  assert.deepEqual(translate.pending_peers, []);
  assert.equal(translate.updated_by_name, 'A');
  assert.equal(view.keys.find(entry => entry.key === 'oss').updated_by_name, 'B');
  assert.deepEqual(view.peers.map(peer => [peer.name, peer.online, peer.supported, peer.last_error]), [['B', true, true, null]]);
  assert.ok(view.peers[0].last_sync_at);
  a.service.stop(); b.service.stop();
});

test('the newer change wins on both sides, a tie goes to the greater instance id, and a clear travels as a tombstone', async () => {
  const { a, b } = pairOf();
  a.values.translate = { from: 'A' }; a.clock.now = 100; a.service.reconcile();
  b.values.translate = { from: 'B' }; b.clock.now = 200; b.service.reconcile();
  await a.service.syncAll();
  assert.deepEqual(a.values.translate, { from: 'B' }, 'B changed later');
  assert.deepEqual(b.values.translate, { from: 'B' });

  // The same time on both sides: B's id is greater.
  a.values.oss = { from: 'A' }; b.values.oss = { from: 'B' };
  a.clock.now = 9000; b.clock.now = 9000;
  // Both clocks are already ahead of 9000 after the round above? Make the tie exact through the metadata.
  a.service.reconcile(['oss']); b.service.reconcile(['oss']);
  assert.equal(a.service.meta().oss.updated_at, b.service.meta().oss.updated_at, 'the same time on both sides');
  await b.service.syncAll();
  assert.deepEqual(a.values.oss, { from: 'B' });
  assert.deepEqual(b.values.oss, { from: 'B' });

  // A clear on A reaches B as a clear.
  a.clock.now = 20000;
  a.values.translate = null; a.service.reconcile(['translate']);
  assert.equal(a.service.meta().translate.hash, null);
  assert.ok(a.service.meta().translate.updated_at > 0);
  await a.service.syncAll();
  assert.equal(b.values.translate, null);
  assert.equal(b.service.meta().translate.hash, null);
  assert.equal(b.service.meta().translate.updated_at, a.service.meta().translate.updated_at);
});

test('first sync: a value from before the feature beats a key that never had one, whatever the ids; two old values go to the greater id', async () => {
  // A (the smaller id) had a value before; B never had one. B starts the round.
  const { a, b } = pairOf();
  a.values.translate = { old: 'A' };
  a.service.reconcile(); b.service.reconcile();
  assert.equal(a.service.meta().translate.updated_at, 0, 'a value from before the feature counts as time 0');
  await b.service.syncAll();
  assert.deepEqual(b.values.translate, { old: 'A' });

  // Both had a value before: the greater id (B) wins, from either side.
  const second = pairOf();
  second.a.values.oss = { old: 'A' }; second.b.values.oss = { old: 'B' };
  second.a.service.reconcile(); second.b.service.reconcile();
  await second.a.service.syncAll();
  assert.deepEqual(second.a.values.oss, { old: 'B' });
  assert.deepEqual(second.b.values.oss, { old: 'B' });
});

test('a wrong link key or a changed envelope applies nothing, and the error is a code without values', async () => {
  const wrong = pairOf({ wrongHashOnB: true });
  wrong.a.values.translate = { apiKey: 'sk-wrong-key-SECRET' }; wrong.a.clock.now = 100; wrong.a.service.reconcile();
  wrong.b.values.oss = { accessKeySecret: 'oss-wrong-key-SECRET' }; wrong.b.clock.now = 100; wrong.b.service.reconcile();
  await wrong.a.service.syncAll();
  assert.equal(Object.hasOwn(wrong.b.values, 'translate'), false, 'B applied nothing');
  assert.equal(Object.hasOwn(wrong.a.values, 'oss'), false, 'A applied nothing');
  assert.equal(wrong.a.service.view().peers[0].last_error, 'SETTINGS_SYNC_DECRYPT_FAILED');
  assert.equal(wrong.logs.join('\n').includes('SECRET'), false);

  const tampered = pairOf({ tamper: sealed => { const bytes = Buffer.from(sealed.data, 'base64url'); bytes[3] ^= 0x40; sealed.data = bytes.toString('base64url'); } });
  tampered.a.values.translate = { apiKey: 'sk-tampered-SECRET' }; tampered.a.clock.now = 100; tampered.a.service.reconcile();
  await tampered.a.service.syncAll();
  assert.equal(Object.hasOwn(tampered.b.values, 'translate'), false, 'a changed byte is refused');
  assert.equal(tampered.a.service.view().peers[0].last_error, 'SETTINGS_SYNC_DECRYPT_FAILED');
});

test('a value the receiver refuses is ignored and logged by code only', async () => {
  const { a, b, logs } = pairOf();
  a.values.translate = 'REFUSED'; a.clock.now = 100; a.service.reconcile();
  await a.service.syncAll();
  assert.equal(Object.hasOwn(b.values, 'translate'), false);
  assert.ok(logs.some(line => line.includes('INVALID_SYNC_VALUE')));
  assert.deepEqual(a.service.view().keys.find(entry => entry.key === 'translate').pending_peers, ['B'], 'still pending');
});

test('a link that comes online is synced at once; an older peer without the capability is skipped', async () => {
  const { a, b } = pairOf();
  a.peer.online = false;
  a.values.translate = { apiKey: 'sk-online-SECRET' }; a.clock.now = 100;
  a.service.start();
  try {
    await settle();
    assert.equal(Object.hasOwn(b.values, 'translate'), false, 'offline: nothing yet');
    a.peer.online = true;
    a.links.emit();
    await until(() => b.values.translate, 'synced when the link came online');
  } finally { a.service.stop(); }

  const old = pairOf({ capabilitiesB: [] });
  old.a.values.translate = { apiKey: 'sk-old-peer-SECRET' }; old.a.service.reconcile();
  await old.a.service.syncAll();
  assert.deepEqual(old.a.calls, ['GET /v1/info'], 'only the capability check');
  const view = old.a.service.view();
  assert.equal(view.peers[0].supported, false);
  assert.deepEqual(view.keys.find(entry => entry.key === 'translate').pending_peers, [], 'an older peer is neither synced nor pending');
  assert.deepEqual(view.keys.find(entry => entry.key === 'translate').synced_peers, []);
});

test('the global save hook reaches a started service; a value written by the sync does not count as a local change', async () => {
  const { a, b } = pairOf();
  a.service.start();
  b.service.start();
  try {
    await settle();
    a.values.translate = { hooked: true }; a.clock.now = 50000;
    syncStore.settingChanged('translate');
    await until(() => b.values.translate && b.values.translate.hooked, 'the hook pushed the change');
    const time = b.service.meta().translate.updated_at;
    // B's own hook ran too (one bus in this process) and saw nothing new for itself.
    await settle(150);
    assert.equal(b.service.meta().translate.updated_at, time);
    assert.equal(b.service.meta().translate.updated_by, ID_A);

    // A change no hook reported is found by the next hash comparison (here the page's view) and sent all the same.
    a.values.oss = { unhooked: true }; a.clock.now = 60000;
    a.service.view();
    await until(() => b.values.oss && b.values.oss.unhooked, 'a change found by the hash comparison is pushed');
  } finally { a.service.stop(); b.service.stop(); }
});

// ---- The registry of this server ----

test('only the shared groups are in the registry; per-device settings and Telegram never are', () => {
  const keys = defaultRegistry({ db, sessionSecret: SECRET }).map(entry => entry.key);
  assert.deepEqual(keys, ['translate', 'voice', 'oss', 'oss-agent-access', 'attention-summary', 'notify-rules', 'notifier-plugins', 'widget-language', 'task-list-devices', 'browser-sites']);
  assert.deepEqual(Object.entries(SCOPES).filter(([, scope]) => scope === 'shared').map(([key]) => key), keys);
  for (const key of ['workdir', 'access', 'authenticator', 'engine-name', 'widget-enabled', 'peer-fs', 'restart', 'rule-sync']) {
    assert.equal(SCOPES[key], 'device', key);
    assert.equal(keys.includes(key), false, key);
  }
  assert.equal(SCOPES.telegram, 'telegram');
});

test('every registry adapter round-trips its setting with the secrets, and the services read it back as saved', () => {
  const owner = 'owner';
  const changed = [];
  const off = syncStore.onSettingChanged(group => changed.push(group));
  try {
    const translator = require('../services/translator').createTranslator({ db, sessionSecret: SECRET });
    translator.saveConfig(owner, { provider: 'deepseek', apiKey: 'sk-translate-REGISTRY-1', model: 'deepseek-flash' });
    const speech = require('../services/speech').createSpeech({ db, sessionSecret: SECRET, env: {} });
    speech.saveConfig(owner, { apiKey: 'sk-voice-REGISTRY-2', region: 'beijing', hotwords: 'tagent' });
    const oss = require('../services/oss-images').createOssImages({ db, sessionSecret: SECRET });
    oss.saveConfig(owner, { enabled: true, region: 'oss-cn-hangzhou', bucket: 'my-bucket', accessKeyId: 'LTAI-id', accessKeySecret: 'oss-REGISTRY-3' });
    const agentAccess = require('../services/oss-agent-settings').createOssAgentSettings({ db });
    agentAccess.setEnabled(false);
    const attention = { onChangeInternal: () => () => {}, get: () => null };
    const summary = require('../services/attention-summary').createAttentionSummary({ db, sessionSecret: SECRET, attention, translator, owner: () => owner, log: () => {} });
    summary.saveSettings(owner, { enabled: true, provider: 'deepseek', model: 'deepseek-flash' });
    const plugin = name => ({ name, label: name, async notify() { return { outcome: 'sent' }; }, async test() { return { ok: true }; } });
    const schema = { config: [{ key: 'url', label: 'URL', type: 'string' }, { key: 'token', label: 'Token', type: 'secret' }] };
    const notify = require('../services/attention-notify').createAttentionNotify({
      db, sessionSecret: SECRET, onChange: null, getOwner: () => owner, notifiers: [plugin('telegram'), plugin('webhook')], manifests: { telegram: schema, webhook: schema }, log: () => {},
    });
    notify.saveRules(owner, { statuses: ['failed'], callDelayMinutes: 7, publicUrl: 'https://tagent.example.test' });
    notify.savePluginConfig('webhook', owner, { enabled: true, values: { url: 'https://hook.example.test', token: 'hook-REGISTRY-4' } });
    notify.savePluginConfig('telegram', owner, { enabled: true, values: { url: 'https://telegram.example.test', token: 'telegram-REGISTRY-5' } });
    const widget = require('../services/attention-widget').createWidgetSettings({ db });
    widget.save({ enabled: false, language: 'zh' });
    const browserSites = require('../services/browser-sites').sitesFor(db);
    browserSites.save('github.com', { title: 'GitHub', summary: 'Code hosting' });
    db.prepare("INSERT OR REPLACE INTO engine_identity (key, value) VALUES ('instance_id', ?)").run(ID_A);
    require('../routes/task-list-prefs').importFromSync({ db }, owner, [ID_B]);

    assert.deepEqual([...new Set(changed)].sort(), ['attention-summary', 'browser-sites', 'notifier-plugins', 'notify-rules', 'oss', 'oss-agent-access', 'translate', 'voice', 'widget-language'].sort(), 'every save path calls the hook');

    const registry = defaultRegistry({ db, sessionSecret: SECRET });
    const saved = Object.fromEntries(registry.map(entry => [entry.key, entry.read(owner)]));
    for (const [key, value] of Object.entries(saved)) assert.notEqual(value, null, `${key} has a value`);
    assert.equal(saved.translate.providers.deepseek.apiKey, 'sk-translate-REGISTRY-1');
    assert.equal(saved.voice.apiKey, 'sk-voice-REGISTRY-2');
    assert.equal(saved.oss.accessKeySecret, 'oss-REGISTRY-3');
    assert.deepEqual(saved['oss-agent-access'], { enabled: false });
    assert.equal(saved['attention-summary'].enabled, true);
    assert.equal(saved['notify-rules'].callDelayMinutes, 7);
    assert.deepEqual(Object.keys(saved['notifier-plugins']), ['webhook'], 'Telegram is never part of it');
    assert.equal(saved['notifier-plugins'].webhook.values.token, 'hook-REGISTRY-4');
    assert.equal(saved['widget-language'], 'zh');
    assert.deepEqual(saved['task-list-devices'], [ID_B]);

    changed.length = 0;
    // browser-sites has merge (CRDT) semantics, not replace: write(null) is a no-op (deletions travel as per-site tombstones inside the value), so it
    // is handled on its own below and left out of the generic clear / round-trip loops that assume replace semantics.
    const replaceEntries = registry.filter(entry => entry.key !== 'browser-sites');
    for (const entry of replaceEntries) entry.write(owner, null);
    for (const entry of replaceEntries) assert.equal(entry.read(owner), null, `${entry.key} cleared`);
    assert.equal(require('../services/browser-sites').exportForSync({ db }, owner).sites['github.com'].title, 'GitHub', 'browser-sites: write(null) by a peer never wipes it');
    assert.equal(notify.getPluginConfig('telegram', owner).values.token.set, true, 'clearing the plugins leaves Telegram alone');
    assert.equal(widget.read().enabled, false, 'the window switch stays');
    assert.equal(widget.read().language, 'auto');
    for (const entry of replaceEntries) entry.write(owner, saved[entry.key]);
    for (const entry of replaceEntries) assert.deepEqual(entry.read(owner), saved[entry.key], `${entry.key} round-trips`);
    // browser-sites: an incoming set merges per site; a newer peer entry wins, and the whole value round-trips.
    require('../services/browser-sites').importFromSync({ db }, owner, { sites: { 'news.com': { site: 'news.com', title: 'News', updated_at: Date.now() + 1000, updated_by: 'peer' } }, tombstones: {} });
    assert.equal(browserSites.get('news.com').title, 'News', 'browser-sites: a peer entry merges in');
    assert.deepEqual(changed, [], 'a write by the sync never calls the hook');

    assert.equal(translator.isConfigured(owner), true);
    assert.equal(translator.getConfig(owner).hasApiKey, true);
    assert.equal(speech.getConfig(owner).hasApiKey, true);
    assert.equal(oss.getConfig(owner).hasAccessKeySecret, true);
    assert.equal(agentAccess.enabled(), false);
    assert.equal(summary.getSettings(owner).enabled, true);
    assert.equal(notify.getRules(owner).callDelayMinutes, 7);
    assert.deepEqual(notify.getPluginConfig('webhook', owner).values.token, { set: true });
    assert.equal(widget.read().enabled, false);
    assert.equal(widget.read().language, 'zh');

    // A malformed value is refused before anything is written.
    for (const [key, bad] of [['translate', 'text'], ['oss-agent-access', { enabled: 'yes' }], ['widget-language', 'fr'], ['notifier-plugins', { webhook: { enabled: true } }], ['task-list-devices', ['not an id!']]]) {
      assert.throws(() => registry.find(entry => entry.key === key).write(owner, bad), /INVALID_SYNC_VALUE/, key);
    }
    assert.deepEqual(registry.find(entry => entry.key === 'translate').read(owner), saved.translate);
  } finally { off(); }
});

// ---- Hidden devices across machines ----

function deviceDb(own, rows, { reported = {}, links = [] } = {}) {
  const memory = memoryDb();
  memory.prepare("INSERT INTO engine_identity (key, value) VALUES ('instance_id', ?)").run(own);
  for (const [id, name] of rows) memory.prepare("INSERT INTO remote_servers (id, owner_id, name) VALUES (?, 'owner', ?)").run(id, name);
  memory.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('remote_engine_instances_v1', JSON.stringify(reported));
  memory.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('service_links_v1', JSON.stringify({ links }));
  return memory;
}

test('hidden devices travel as instance ids: this device is "local" on one side and a remote row on the other, both ways', async () => {
  const prefs = require('../routes/task-list-prefs');
  const ID_C = '33333333-3333-4333-8333-333333333333';
  const ID_Z = '99999999-9999-4999-8999-999999999999';
  // A: row 7 is B (reported), row 8 has no known id, row 9 is C. B: row 3 is A (its link record), row 4 is C.
  const dbA = deviceDb(ID_A, [[7, 'B'], [8, 'Unknown'], [9, 'C']], { reported: { 7: ID_B, 9: ID_C } });
  const dbB = deviceDb(ID_B, [[3, 'A'], [4, 'C']], { reported: { 4: ID_C }, links: [{ remote_server_id: 3, peer_instance_id: ID_A }] });
  const fakeAuth = (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); };
  const appOf = memory => { const app = express(); app.use(express.json()); app.use('/hidden', prefs.createTaskListPrefsRouter({ db: memory, requireAuth: fakeAuth })); return listen(app); };
  const [urlA, urlB] = await Promise.all([appOf(dbA), appOf(dbB)]);

  assert.equal((await call(urlA, 'PUT', '/hidden', { hidden: ['local', 'remote:8'] })).status, 200);
  assert.deepEqual(prefs.exportForSync({ db: dbA }, 'owner'), [ID_A], 'A hides itself; the row without a known id stays on A only');
  prefs.importFromSync({ db: dbB }, 'owner', prefs.exportForSync({ db: dbA }, 'owner'));
  assert.deepEqual((await call(urlB, 'GET', '/hidden')).body, { hidden: ['remote:3'] }, 'on B, A is row 3');

  // B also hides itself and C; an id neither knows is kept.
  assert.equal((await call(urlB, 'PUT', '/hidden', { hidden: ['local', 'remote:3'] })).status, 200);
  prefs.importFromSync({ db: dbB }, 'owner', [...prefs.exportForSync({ db: dbB }, 'owner'), ID_C, ID_Z].sort());
  const shared = prefs.exportForSync({ db: dbB }, 'owner');
  assert.deepEqual(shared, [ID_A, ID_B, ID_C, ID_Z].sort());
  prefs.importFromSync({ db: dbA }, 'owner', shared);
  // On A that is every device (A itself, B, C, and row 8 hidden on A only), and a list that hides everything hides nothing.
  assert.deepEqual((await call(urlA, 'GET', '/hidden')).body, { hidden: [] });
  // Shown again by A for row 8: then A, B and C stay hidden.
  assert.equal((await call(urlA, 'PUT', '/hidden', { hidden: ['local', 'remote:7', 'remote:9'] })).status, 200);
  assert.deepEqual((await call(urlA, 'GET', '/hidden')).body, { hidden: ['local', 'remote:7', 'remote:9'] });
  assert.deepEqual(prefs.exportForSync({ db: dbA }, 'owner'), shared, 'the shared list stays whole, the unknown id too');

  // A shows B again: the shared list loses B, keeps the ids A does not know.
  assert.equal((await call(urlA, 'PUT', '/hidden', { hidden: ['local', 'remote:9'] })).status, 200);
  assert.deepEqual(prefs.exportForSync({ db: dbA }, 'owner'), [ID_A, ID_C, ID_Z].sort());
  prefs.importFromSync({ db: dbB }, 'owner', prefs.exportForSync({ db: dbA }, 'owner'));
  assert.deepEqual((await call(urlB, 'GET', '/hidden')).body, { hidden: ['remote:3', 'remote:4'] }, 'B itself is visible again on B');
  prefs.importFromSync({ db: dbB }, 'owner', null);
  assert.deepEqual((await call(urlB, 'GET', '/hidden')).body, { hidden: [] });
  assert.equal(prefs.exportForSync({ db: dbB }, 'owner'), null);
});

test('hidden devices saved before this version are exported by their instance ids', () => {
  const prefs = require('../routes/task-list-prefs');
  const memory = deviceDb(ID_A, [[7, 'B'], [8, 'Unknown']], { reported: { 7: ID_B } });
  memory.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run(prefs.STATE_KEY, JSON.stringify({ owner: ['remote:7', 'remote:8'] }));
  assert.deepEqual(prefs.exportForSync({ db: memory }, 'owner'), [ID_B]);
  assert.deepEqual(prefs.hiddenDevices(memory, 'owner'), ['remote:7', 'remote:8']);
});

// ---- The routes ----

test('/v1/settings-sync takes only a live service-link token; /api/settings-sync answers the scopes without values', async () => {
  const { createEngineSettingsSyncRouter, createSettingsSyncRouter } = require('../routes/settings-sync');
  const { a } = pairOf();
  a.values.translate = { apiKey: 'sk-route-SECRET' }; a.service.reconcile();
  const links = { linkForToken: id => ({ 1: { id: LINK, revoked: false, peer_instance_id: ID_B }, 2: { id: 'x', revoked: true } })[id] || null };
  const engineAuth = () => (req, res, next) => {
    const match = /^Bearer (\d)$/.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' });
    req.engineAuth = { tokenId: Number(match[1]) };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/settings-sync', createEngineSettingsSyncRouter({ service: a.service, serviceLinks: links, requireEngineAuth: engineAuth }));
  app.use('/api/settings-sync', createSettingsSyncRouter({ service: a.service, requireAuth: (req, res, next) => next() }));
  const url = await listen(app);
  const auth = id => ({ ...HEADERS, Authorization: `Bearer ${id}` });
  assert.equal((await call(url, 'GET', '/v1/settings-sync')).status, 401);
  assert.deepEqual(await call(url, 'GET', '/v1/settings-sync', undefined, auth(3)).then(r => [r.status, r.body]), [403, { error: 'LINKED_ONLY' }], 'not a link token');
  assert.deepEqual(await call(url, 'GET', '/v1/settings-sync', undefined, auth(2)).then(r => [r.status, r.body]), [403, { error: 'LINKED_ONLY' }], 'a revoked link');
  const meta = await call(url, 'GET', '/v1/settings-sync', undefined, auth(1));
  assert.equal(meta.status, 200);
  assert.equal(meta.body.instance_id, ID_A);
  assert.match(meta.body.public_key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(meta.body.keys), ['translate', 'oss', 'notify-rules']);
  assert.equal(meta.text.includes('sk-route-SECRET'), false);
  const bad = await call(url, 'POST', '/v1/settings-sync/pull', { instance_id: ID_B, public_key: 'short', keys: ['translate'] }, auth(1));
  assert.deepEqual([bad.status, bad.body], [400, { error: 'SETTINGS_SYNC_BAD_KEY' }]);
  const impostor = await call(url, 'POST', '/v1/settings-sync/pull', { instance_id: ID_A, public_key: meta.body.public_key, keys: ['translate'] }, auth(1));
  assert.deepEqual([impostor.status, impostor.body], [400, { error: 'INVALID_SETTINGS_SYNC' }], 'the sender must be the link peer');
  const pulled = await call(url, 'POST', '/v1/settings-sync/pull', { instance_id: ID_B, public_key: meta.body.public_key, keys: ['translate'] }, auth(1));
  assert.equal(pulled.status, 200);
  assert.ok(pulled.body.sealed && pulled.body.sealed.data);
  assert.equal(pulled.text.includes('sk-route-SECRET'), false, 'the value is sealed');
  const junk = await call(url, 'PUT', '/v1/settings-sync', { instance_id: ID_B, public_key: meta.body.public_key, sealed: { v: 1, alg: 'A256GCM', iv: 'AAAA', data: 'AAAA', tag: 'AAAA' } }, auth(1));
  assert.deepEqual([junk.status, junk.body], [400, { error: 'SETTINGS_SYNC_DECRYPT_FAILED' }]);

  const page = await call(url, 'GET', '/api/settings-sync');
  assert.equal(page.status, 200);
  assert.equal(page.body.supported, true);
  assert.equal(page.body.scopes.translate, 'shared');
  assert.equal(page.body.scopes.workdir, 'device');
  assert.equal(page.body.scopes.telegram, 'telegram');
  assert.deepEqual(Object.keys(page.body.keys[0]).sort(), ['key', 'pending_peers', 'scope', 'synced_peers', 'updated_at', 'updated_by_name']);
  assert.equal(page.text.includes('sk-route-SECRET'), false);
  const now = await call(url, 'POST', '/api/settings-sync/now', {});
  assert.equal(now.status, 200);
  assert.ok(Array.isArray(now.body.peers));
  assert.equal(page.body.telegram, null, 'no relay: no Telegram sender to name');
});

test('/api/settings-sync names the device that sends Telegram, from the relay summary, without a wait', async () => {
  const { createSettingsSyncRouter } = require('../routes/settings-sync');
  const { a } = pairOf();
  let summary = { sender_name: 'K01', self: false, conflict: false };
  let calls = 0;
  const relay = { summary: name => { calls += 1; assert.equal(name, 'telegram'); if (summary instanceof Error) throw summary; return summary; } };
  const app = express();
  app.use(express.json());
  app.use('/api/settings-sync', createSettingsSyncRouter({ service: a.service, requireAuth: (req, res, next) => next(), getRelay: () => relay }));
  const url = await listen(app);
  assert.deepEqual((await call(url, 'GET', '/api/settings-sync')).body.telegram, { sender_name: 'K01', self: false, conflict: false });
  summary = { sender_name: 'T01', self: true, conflict: true };
  assert.deepEqual((await call(url, 'POST', '/api/settings-sync/now', {})).body.telegram, { sender_name: 'T01', self: true, conflict: true });
  summary = null;
  assert.equal((await call(url, 'GET', '/api/settings-sync')).body.telegram, null, 'nobody has Telegram');
  summary = new Error('broken');
  const failed = await call(url, 'GET', '/api/settings-sync');
  assert.equal(failed.status, 200, 'a failing relay never breaks the route');
  assert.equal(failed.body.telegram, null);
  assert.equal(calls, 4);
});

// ---- Two real services ----

function spawnService(t, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-settings-sync-real-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TAGENT_HOME: '', HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', T_AGENT_DATA_DIR: temp, T_AGENT_DB_PATH: path.join(temp, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { output: '', temp };
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

test('two real services over a real link: translation, OSS and notify rules go both ways, the working directory stays', { timeout: 120000 }, async t => {
  const [serverA, serverB] = await Promise.all([
    spawnService(t, { ENGINE_NAME: 'engine-a', SESSION_SECRET: 'real-a-session-secret-real-a-session-secret' }),
    spawnService(t, { ENGINE_NAME: 'engine-b', SESSION_SECRET: 'real-b-session-secret-real-b-session-secret' }),
  ]);
  const a = (method, route, body) => call(serverA.url, method, route, body);
  const b = (method, route, body) => call(serverB.url, method, route, body);
  const SECRETS = ['sk-real-translate-SECRET-9f3', 'oss-real-SECRET-71c', 'sk-real-b-SECRET-55e'];

  // Made on A before the link exists.
  assert.equal((await a('PUT', '/api/translate/config', { provider: 'deepseek', apiKey: SECRETS[0], model: 'deepseek-flash' })).status, 200);
  assert.equal((await b('GET', '/api/translate/config')).body.hasApiKey, false);

  const made = await a('POST', '/api/service-links/code', {});
  const joined = await b('POST', '/api/service-links/join', { url: serverA.url, code: made.body.code, confirm: true });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));

  await until(async () => (await b('GET', '/api/translate/config')).body.hasApiKey === true, 'translation reaches B', 30000);
  const onB = (await b('GET', '/api/translate/config')).body;
  assert.equal(onB.enabled, true);
  assert.equal(onB.provider, 'deepseek');
  assert.equal(onB.shared_from, null, 'B has its own copy now, not the linked fallback');

  // OSS and the notify rules on A reach B (A to B through the tunnel).
  assert.equal((await a('PUT', '/api/oss/config', { enabled: true, region: 'oss-cn-hangzhou', bucket: 'real-bucket', accessKeyId: 'LTAI-real', accessKeySecret: SECRETS[1] })).status, 200);
  assert.equal((await a('PUT', '/api/attention-notify/config', { statuses: ['failed', 'review'], callDelayMinutes: 5 })).status, 200);
  // The working directory is per device.
  const workDir = path.join(serverA.temp, 'my-work');
  assert.equal((await a('PUT', '/auth/settings', { work_dir: workDir })).status, 200);
  await until(async () => (await b('GET', '/api/oss/config')).body.bucket === 'real-bucket', 'OSS reaches B', 30000);
  const ossB = (await b('GET', '/api/oss/config')).body;
  assert.equal(ossB.hasAccessKeySecret, true);
  assert.equal(ossB.enabled, true);
  await until(async () => (await b('GET', '/api/attention-notify/config')).body.rules.callDelayMinutes === 5, 'notify rules reach B', 30000);
  assert.deepEqual((await b('GET', '/api/attention-notify/config')).body.rules.statuses, ['review', 'failed']);

  // A change on B goes back to A (B calls A directly).
  assert.equal((await b('PUT', '/api/attention-notify/config', { callDelayMinutes: 9 })).status, 200);
  assert.equal((await b('PUT', '/api/translate/config', { provider: 'glm', apiKey: SECRETS[2], model: 'glm-5.3-flash' })).status, 200);
  await until(async () => (await a('GET', '/api/attention-notify/config')).body.rules.callDelayMinutes === 9, 'notify rules back to A', 30000);
  await until(async () => (await a('GET', '/api/translate/config')).body.provider === 'glm', 'translation back to A', 30000);
  assert.equal((await a('GET', '/api/translate/config')).body.providers.deepseek.hasApiKey, true, 'the first key is still there');

  assert.equal((await a('GET', '/auth/me')).body.work_dir, workDir);
  assert.equal((await b('GET', '/auth/me')).body.work_dir || null, null, 'the working directory never reaches B');

  // The page view on A: B synced, scopes fixed.
  const view = await until(async () => {
    const answer = (await a('POST', '/api/settings-sync/now', {})).body;
    const entry = answer && answer.keys.find(item => item.key === 'notify-rules');
    return entry && entry.synced_peers.length === 1 ? answer : null;
  }, 'A reports B as synced', 20000);
  assert.equal(view.scopes.workdir, 'device');
  assert.equal(view.peers.length, 1);
  assert.deepEqual([view.peers[0].online, view.peers[0].supported, view.peers[0].last_error], [true, true, null]);
  assert.equal(view.keys.find(item => item.key === 'notify-rules').updated_by_name, 'engine-b');

  const exposed = [serverA.output, serverB.output, JSON.stringify(view), JSON.stringify((await b('GET', '/api/settings-sync')).body)].join('\n');
  for (const secret of SECRETS) assert.equal(exposed.includes(secret), false, 'no secret in the logs or the page answers');
});

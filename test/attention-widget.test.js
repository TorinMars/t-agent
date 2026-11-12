// The T-Attention desktop window (macOS): the widget API (routes/attention-widget.js) with its token and this-machine rule, the merged list of this
// machine and connected services (a fake remote helper, a failing engine, a hidden device, an engine without T-Attention), key routing for every
// action, the strings in Chinese, the settings with a fake launcher, the launcher itself (services/attention-widget.js) with a fake spawner and a fake
// execFile (no window is ever opened and swiftc never runs), and the mount order in a real server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-widget-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'attention-widget-test-secret-attention-widget-test-secret';
fs.mkdirSync(process.env.TASKS_BASE_DIR, { recursive: true });

const express = require('express');
const db = require('../db');
const { defaultService } = require('../services/attention');
const { RemoteAttentionError } = require('../services/remote-attention');
const { createWidgetSettings, createWidgetLauncher, blockedReason } = require('../services/attention-widget');
const { createAttentionWidgetRoutes, tagColorIndex, readStringList, createDictionary } = require('../routes/attention-widget');
const { STATE_KEY: HIDDEN_KEY } = require('../routes/task-list-prefs');

const OWNER = 'owner';
const TOKEN = 'widget-token-0123456789-abcdefghijklmnopqrstuv';
const servers = [];
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); servers.push(server); });
test.after(() => { for (const server of servers) server.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: parsed, headers: response.headers };
}

// A connected service's T-Attention in memory, answering like services/remote-attention.js `call` (errors as RemoteAttentionError).
function fakeRemote() {
  const engines = new Map(); // row name -> { items, fail, unsupported, slow, calls }
  const add = (name, options = {}) => { const engine = { items: [], nextId: 1, calls: [], ...options }; engines.set(name, engine); return engine; };
  const error = (status, body) => new RemoteAttentionError(status, body);
  async function remoteCall(row, { method, path: pathname = '', body }) {
    const engine = engines.get(row.name);
    engine.calls.push({ method, path: pathname, body });
    if (engine.unsupported) throw error(501, { error: 'ATTENTION_REMOTE_UNSUPPORTED' });
    if (engine.fail) throw error(502, { error: 'REMOTE_CONNECTION_FAILED' });
    if (engine.slow) await new Promise(resolve => setTimeout(resolve, engine.slow));
    const [route, query = ''] = pathname.split('?');
    const match = /^\/(\d+)(\/move)?$/.exec(route);
    const find = id => engine.items.find(item => item.id === id);
    if (method === 'GET' && !route) {
      const params = new URLSearchParams(query);
      const statuses = params.get('status') ? params.get('status').split(',') : null;
      return { items: engine.items.filter(item => (statuses ? statuses.includes(item.status) : !['done', 'failed', 'cancelled'].includes(item.status))) };
    }
    if (method === 'POST' && !route) {
      const item = { id: engine.nextId++, status: 'todo', sort_order: engine.nextId, parent_id: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...body };
      engine.items.push(item);
      return item;
    }
    const item = match && find(Number(match[1]));
    if (!item) throw error(404, { error: 'NOT_FOUND', message: 'Task not found' });
    if (method === 'GET') return { item, events: [] };
    if (method === 'PATCH') { Object.assign(item, body); return item; }
    if (method === 'POST' && match[2]) return { item, items: [] };
    if (method === 'DELETE') {
      const children = engine.items.filter(other => other.parent_id === item.id).map(other => other.id);
      if (children.length) throw error(409, { error: 'HAS_CHILDREN', message: 'This task has subtasks; delete them or give them another parent first', children });
      engine.items = engine.items.filter(other => other !== item);
      return null;
    }
    throw error(404, { error: 'NOT_FOUND' });
  }
  return { add, engines, remote: { call: remoteCall } };
}

const service = defaultService();
const remoteRow = (name, { enabled = 1 } = {}) => Number(db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher, enabled) VALUES (?, ?, ?, ?, ?)').run(OWNER, name, `http://${name.toLowerCase()}.test`, 'x', enabled).lastInsertRowid);
const setHidden = list => db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(HIDDEN_KEY, JSON.stringify({ [OWNER]: list }));
const clearItems = () => { db.prepare('DELETE FROM attention_items').run(); };

function fakeLauncher(token = TOKEN) {
  const launcher = {
    enabledCalls: [],
    statusValue: { platform_supported: true, swiftc: true, running: true, building: false, last_error: null },
    verifyToken: value => value === token,
    setEnabled: async on => { launcher.enabledCalls.push(on); launcher.statusValue.running = on; },
    status: async () => ({ ...launcher.statusValue }),
  };
  return launcher;
}

async function widgetApp({ remote, launcher = fakeLauncher(), isLocal, stringList, ...rest } = {}) {
  const settings = createWidgetSettings({ db });
  const routes = createAttentionWidgetRoutes({
    service, launcher, settings, db, remote: remote || fakeRemote().remote, owner: () => OWNER,
    localName: () => 'Studio Mac', localInstanceId: () => 'local-instance', remoteInstanceId: row => `instance-${row.name}`,
    ...(isLocal ? { isLocal } : {}), ...(stringList ? { stringList } : {}), ...rest,
  });
  const app = express();
  app.use('/api/attention/widget', routes.bearer);
  // What server.js has after the bearer routers: the session path (here: a fake login) and the settings router.
  app.use(express.json());
  app.use('/api/attention/widget/settings', (req, res, next) => { req.session = { user: { login: OWNER } }; next(); }, routes.settings);
  app.use((req, res) => res.status(418).json({ error: 'SESSION_PATH' }));
  const base = await listen(app);
  return { base: `${base}/api/attention/widget`, settings, launcher };
}
const AUTH = { Authorization: `Bearer ${TOKEN}` };

test('the widget API needs the window token, from this machine, without forwarding headers', async () => {
  const { base } = await widgetApp();
  const ok = await call('GET', `${base}/strings`, undefined, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Basic ${TOKEN}` }, { Authorization: 'Bearer' },
    { ...AUTH, 'X-Forwarded-For': '203.0.113.9' }, { ...AUTH, Forwarded: 'for=203.0.113.9' }, { ...AUTH, 'X-Real-IP': '203.0.113.9' }]) {
    const answer = await call('GET', `${base}/items`, undefined, headers);
    assert.equal(answer.status, 401, JSON.stringify(headers));
    assert.equal(answer.body.error, 'WIDGET_TOKEN_INVALID');
    assert.equal(answer.headers.get('cache-control'), 'no-store');
  }
  // An unknown path with the token is a JSON 404 here, never the session path.
  assert.deepEqual((await call('GET', `${base}/nothing`, undefined, AUTH)).body.error, 'NOT_FOUND');
  assert.equal((await call('GET', `${base}/nothing`)).status, 401);
  // No window runs: no token is valid.
  const idle = await widgetApp({ launcher: { ...fakeLauncher(), verifyToken: () => false } });
  assert.equal((await call('GET', `${idle.base}/items`, undefined, AUTH)).status, 401);
  // A request that does not come from this machine.
  const away = await widgetApp({ isLocal: () => false });
  assert.equal((await call('GET', `${away.base}/items`, undefined, AUTH)).status, 401);
  // /settings: without Authorization it goes on to the session path; with the token it is refused.
  assert.equal((await call('GET', `${base}/settings`)).status, 200);
  const refused = await call('PUT', `${base}/settings`, { enabled: false }, AUTH);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'TOKEN_NOT_ALLOWED');
});

test('items: this machine and the connected services in one list, a failing engine named, hidden and unsupported ones left out', async () => {
  clearItems();
  const fake = fakeRemote();
  const laptop = fake.add('Laptop');
  laptop.items.push(
    { id: 1, title: 'Remote parent', status: 'waiting_user', sort_order: 50, parent_id: null, context: { pending: { kind: 'permission', text: 'Allow rm?' } }, custom_status: 'Blocked', result: null, attention_reason: 'Approve', priority: 'high', due_date: '2026-12-01', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z' },
    { id: 2, title: 'Remote child', status: 'waiting_user', sort_order: 49, parent_id: 1, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z' },
  );
  fake.add('Broken', { fail: true });
  fake.add('Old', { unsupported: true });
  fake.add('Hidden');
  fake.add('Slow', { slow: 400 });
  const laptopId = remoteRow('Laptop');
  remoteRow('Broken');
  remoteRow('Old');
  const hiddenId = remoteRow('Hidden');
  remoteRow('Slow');
  remoteRow('Disabled', { enabled: 0 });
  setHidden([`remote:${hiddenId}`]);
  const local = service.create({ title: 'Local task', status: 'review', context: { pending: { kind: 'question', text: 'Which one?' } } }, { actor: 'user' });
  for (let index = 0; index < 55; index += 1) {
    const done = service.create({ title: `Done ${index}`, status: 'todo' }, { actor: 'user' });
    service.update(done.id, { status: 'done' }, { actor: 'user' });
  }
  const { base } = await widgetApp({ remote: fake.remote, readTimeoutMs: 150 });
  const answer = await call('GET', `${base}/items`, undefined, AUTH);
  assert.equal(answer.status, 200);
  const { items, engines, failed, host, updated_at: updatedAt } = answer.body;
  assert.equal(host, os.hostname());
  assert.ok(Date.parse(updatedAt));
  assert.deepEqual(engines.map(engine => engine.key), ['local', `remote:${laptopId}`, `remote:${laptopId + 1}`, `remote:${laptopId + 4}`]);
  assert.deepEqual(engines[0], { key: 'local', name: 'Studio Mac', local: true, color_index: tagColorIndex('local-instance') });
  assert.deepEqual(engines[1], { key: `remote:${laptopId}`, name: 'Laptop', local: false, color_index: tagColorIndex('instance-Laptop') });
  assert.deepEqual(failed.sort(), ['Broken', 'Slow'], 'a failing and a slow engine are named; the one without T-Attention is left out quietly');
  assert.equal(fake.engines.get('Hidden').calls.length, 0, 'a hidden device is not read');
  assert.equal(fake.engines.get('Laptop').calls.length, 2, 'open and finished items are read in parallel');
  const byKey = new Map(items.map(item => [item.key, item]));
  const parent = byKey.get(`remote:${laptopId}:1`);
  assert.deepEqual(parent, {
    key: `remote:${laptopId}:1`, engine: `remote:${laptopId}`, id: 1, parent_key: null, title: 'Remote parent', status: 'waiting_user', custom_status: 'Blocked',
    result: null, attention_reason: 'Approve', pending: 'Allow rm?', priority: 'high', due_date: '2026-12-01', sort_order: 50,
    updated_at: '2026-11-02T00:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(byKey.get(`remote:${laptopId}:2`).parent_key, `remote:${laptopId}:1`);
  assert.equal(byKey.get(`local:${local.id}`).pending, 'Which one?');
  assert.equal(byKey.get(`local:${local.id}`).engine, 'local');
  const finished = items.filter(item => item.status === 'done');
  assert.equal(finished.length, 50, 'only the last 50 finished items');
  assert.ok(!finished.some(item => item.title === 'Done 0' || item.title === 'Done 4'), 'the oldest finished ones are left out');
  assert.ok(finished.some(item => item.title === 'Done 54'));
  // The page's colour hash.
  const { tagColorIndex: pageIndex } = await import('../scripts/h5-shell/task-order.mjs');
  for (const id of ['local-instance', 'instance-Laptop', '0f8fad5b-d9cb-469f-a165-70867728950e', '']) assert.equal(tagColorIndex(id), pageIndex(id));
  setHidden([]);
  db.prepare('DELETE FROM remote_servers').run();
});

test('items: with this machine hidden, the others are shown; with everything hidden, this machine is', async () => {
  clearItems();
  const fake = fakeRemote();
  fake.add('Laptop').items.push({ id: 7, title: 'There', status: 'todo', sort_order: 1, parent_id: null });
  const laptopId = remoteRow('Laptop');
  service.create({ title: 'Here', status: 'todo' }, { actor: 'user' });
  const { base } = await widgetApp({ remote: fake.remote });
  setHidden(['local']);
  let answer = await call('GET', `${base}/items`, undefined, AUTH);
  assert.deepEqual(answer.body.engines.map(engine => engine.key), [`remote:${laptopId}`]);
  assert.deepEqual(answer.body.items.map(item => item.title), ['There']);
  setHidden(['local', `remote:${laptopId}`]); // everything hidden: nothing is hidden
  answer = await call('GET', `${base}/items`, undefined, AUTH);
  assert.deepEqual(answer.body.engines.map(engine => engine.key), ['local', `remote:${laptopId}`]);
  fake.engines.get('Laptop').unsupported = true;
  setHidden(['local']); // the only listed engine has no T-Attention: this machine is shown, as on the page
  answer = await call('GET', `${base}/items`, undefined, AUTH);
  assert.deepEqual(answer.body.engines.map(engine => engine.key), ['local']);
  assert.deepEqual(answer.body.items.map(item => item.title), ['Here']);
  setHidden([]);
  db.prepare('DELETE FROM remote_servers').run();
});

test('every action goes to the engine of its key', async () => {
  clearItems();
  const fake = fakeRemote();
  const laptop = fake.add('Laptop');
  const laptopId = remoteRow('Laptop');
  const remoteKey = `remote:${laptopId}`;
  const { base } = await widgetApp({ remote: fake.remote });

  // Create on each engine, with a parent of the same engine.
  const localParent = await call('POST', `${base}/items`, { engine: 'local', title: 'Local parent', status: 'working', notes: 'n' }, AUTH);
  assert.equal(localParent.status, 201);
  assert.equal(localParent.body.engine, 'local');
  assert.equal(localParent.body.key, `local:${localParent.body.id}`);
  assert.equal(service.get(localParent.body.id).source, 'user');
  const localChild = await call('POST', `${base}/items`, { engine: 'local', title: 'Local child', parent_key: localParent.body.key }, AUTH);
  assert.equal(localChild.body.parent_key, localParent.body.key);
  const remoteItem = await call('POST', `${base}/items`, { engine: remoteKey, title: 'Remote one', status: 'review' }, AUTH);
  assert.equal(remoteItem.status, 201);
  assert.equal(remoteItem.body.key, `${remoteKey}:1`);
  assert.deepEqual(laptop.calls.at(-1), { method: 'POST', path: '', body: { title: 'Remote one', status: 'review' } });
  assert.equal((await call('POST', `${base}/items`, { engine: 'local', title: 'x', parent_key: `${remoteKey}:1` }, AUTH)).status, 400);
  assert.equal((await call('POST', `${base}/items`, { engine: 'remote:999', title: 'x' }, AUTH)).body.error, 'ENGINE_NOT_FOUND');
  assert.equal((await call('POST', `${base}/items`, { engine: 'elsewhere', title: 'x' }, AUTH)).body.error, 'VALIDATION_FAILED');
  assert.equal((await call('POST', `${base}/items`, { engine: 'local', title: '' }, AUTH)).body.error, 'VALIDATION_FAILED', 'the owner validates');

  // PATCH with parent_key -> parent_id.
  const patched = await call('PATCH', `${base}/items/${localChild.body.key}`, { title: 'Renamed', custom_status: 'Busy', parent_key: null }, AUTH);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title, 'Renamed');
  assert.equal(patched.body.parent_key, null);
  await call('PATCH', `${base}/items/${remoteKey}:1`, { notes: 'remote notes', parent_key: null }, AUTH);
  assert.deepEqual(laptop.calls.at(-1), { method: 'PATCH', path: '/1', body: { notes: 'remote notes', parent_id: null } });
  assert.equal((await call('PATCH', `${base}/items/local:999999`, { title: 'x' }, AUTH)).status, 404);
  assert.equal((await call('PATCH', `${base}/items/bad-key`, { title: 'x' }, AUTH)).status, 404);

  // Confirm / reject / handled: only from their starting status.
  const wrong = await call('POST', `${base}/items/${localParent.body.key}/confirm`, {}, AUTH);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, 'WRONG_STATUS');
  assert.equal((await call('POST', `${base}/items/${localParent.body.key}/reject`, {}, AUTH)).body.error, 'WRONG_STATUS');
  assert.equal((await call('POST', `${base}/items/${localParent.body.key}/handled`, {}, AUTH)).body.error, 'WRONG_STATUS');
  service.update(localParent.body.id, { status: 'review' }, { actor: 'user' });
  const confirmed = await call('POST', `${base}/items/${localParent.body.key}/confirm`, undefined, AUTH);
  assert.equal(confirmed.body.status, 'done');
  service.update(localParent.body.id, { status: 'review' }, { actor: 'user' });
  const rejected = await call('POST', `${base}/items/${localParent.body.key}/reject`, { reason: 'Tests fail' }, AUTH);
  assert.equal(rejected.body.status, 'working');
  const events = service.detail(localParent.body.id).events;
  assert.ok(events.some(event => event.type === 'activity' && event.data.kind === 'note' && event.data.text === 'Rejected: Tests fail'));
  service.update(localParent.body.id, { status: 'waiting_user', attention_reason: 'Answer me' }, { actor: 'user' });
  const handled = await call('POST', `${base}/items/${localParent.body.key}/handled`, {}, AUTH);
  assert.equal(handled.body.status, 'working');
  assert.equal(handled.body.attention_reason, null);
  assert.ok(service.detail(localParent.body.id).events.some(event => event.type === 'activity' && event.data.text === 'Handled'));
  // On the remote: the status is read there first, the change is sent there.
  const remoteRejected = await call('POST', `${base}/items/${remoteKey}:1/reject`, {}, AUTH);
  assert.equal(remoteRejected.status, 200);
  assert.deepEqual(laptop.calls.at(-1), { method: 'PATCH', path: '/1', body: { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Rejected' } } });
  assert.equal((await call('POST', `${base}/items/${remoteKey}:1/confirm`, {}, AUTH)).body.error, 'WRONG_STATUS');
  laptop.items[0].status = 'waiting_user';
  assert.equal((await call('POST', `${base}/items/${remoteKey}:1/handled`, {}, AUTH)).body.status, 'working');
  assert.equal((await call('POST', `${base}/items/${remoteKey}:9/handled`, {}, AUTH)).status, 404);

  // Move: keys of the same engine only.
  const other = service.create({ title: 'Neighbour', status: 'working' }, { actor: 'user' });
  const moved = await call('POST', `${base}/items/${localParent.body.key}/move`, { before_key: `local:${other.id}` }, AUTH);
  assert.deepEqual(moved.body, { ok: true });
  const cross = await call('POST', `${base}/items/${localParent.body.key}/move`, { after_key: `${remoteKey}:1` }, AUTH);
  assert.equal(cross.status, 400);
  assert.equal(cross.body.error, 'VALIDATION_FAILED');
  assert.equal(cross.body.message, 'Target is on another device');
  assert.deepEqual((await call('POST', `${base}/items/${localParent.body.key}/move`, { position: 'top', status: 'todo' }, AUTH)).body, { ok: true });
  assert.equal(service.get(localParent.body.id).status, 'todo');
  assert.equal((await call('POST', `${base}/items/${localParent.body.key}/move`, {}, AUTH)).body.error, 'VALIDATION_FAILED', 'the owner checks the placement');
  await call('POST', `${base}/items/${remoteKey}:1/move`, { position: 'bottom' }, AUTH);
  assert.deepEqual(laptop.calls.at(-1), { method: 'POST', path: '/1/move', body: { position: 'bottom' } });

  // Delete: HAS_CHILDREN passes through, from either engine.
  await call('PATCH', `${base}/items/${localChild.body.key}`, { parent_key: localParent.body.key }, AUTH);
  const blocked = await call('DELETE', `${base}/items/${localParent.body.key}`, undefined, AUTH);
  assert.equal(blocked.status, 409);
  assert.deepEqual({ error: blocked.body.error, children: blocked.body.children }, { error: 'HAS_CHILDREN', children: [localChild.body.id] });
  assert.equal(typeof blocked.body.message, 'string');
  laptop.items.push({ id: 5, title: 'Remote child', status: 'todo', parent_id: 1 });
  const remoteBlocked = await call('DELETE', `${base}/items/${remoteKey}:1`, undefined, AUTH);
  assert.deepEqual({ status: remoteBlocked.status, error: remoteBlocked.body.error, children: remoteBlocked.body.children }, { status: 409, error: 'HAS_CHILDREN', children: [5] });
  assert.equal((await call('DELETE', `${base}/items/${localChild.body.key}`, undefined, AUTH)).status, 204);
  assert.equal(service.get(localChild.body.id), null);
  assert.equal((await call('DELETE', `${base}/items/${remoteKey}:5`, undefined, AUTH)).status, 204);
  assert.equal(laptop.items.some(item => item.id === 5), false);
  db.prepare('DELETE FROM remote_servers').run();
});

test('strings: the list in widgets/macos/strings.json, in English or from the Chinese dictionary', async () => {
  const list = readStringList();
  for (const text of ['Needs you', 'Done: {1}', 'Could not load {1}', 'Nothing needs you', 'Quit']) assert.ok(list.includes(text), text);
  const words = createDictionary()();
  const missing = list.filter(text => typeof words[text] !== 'string');
  assert.deepEqual(missing, [], 'every string of the window has a Chinese translation in public/js/i18n-zh-*.js');
  const { base, settings } = await widgetApp();
  let answer = await call('GET', `${base}/strings`, undefined, AUTH);
  assert.equal(answer.body.lang, 'en');
  assert.equal(answer.body.strings['Needs you'], 'Needs you');
  assert.equal(answer.body.strings['Done: {1}'], 'Done: {1}');
  settings.save({ language: 'zh' });
  answer = await call('GET', `${base}/strings`, undefined, AUTH);
  assert.equal(answer.body.lang, 'zh');
  assert.equal(answer.body.strings['Needs you'], words['Needs you']);
  assert.match(answer.body.strings['Done: {1}'], /\{1\}/, 'the placeholder stays');
  assert.notEqual(answer.body.strings['Done: {1}'], 'Done: {1}');
  // 'auto' follows the page's language, which the settings read learns from its cookie.
  settings.save({ language: 'auto' });
  assert.equal((await call('GET', `${base}/strings`, undefined, AUTH)).body.lang, 'en');
  await call('GET', `${base}/settings`, undefined, { Cookie: 'ta-lang=zh' });
  assert.equal((await call('GET', `${base}/strings`, undefined, AUTH)).body.lang, 'zh');
  await call('GET', `${base}/settings`, undefined, { Cookie: 'other=1' });
  assert.equal((await call('GET', `${base}/strings`, undefined, AUTH)).body.lang, 'en');
  // A string the dictionary does not know is shown in English.
  const extra = await widgetApp({ stringList: () => ['Needs you', 'Some new widget word'] });
  extra.settings.save({ language: 'zh' });
  assert.deepEqual(Object.keys((await call('GET', `${extra.base}/strings`, undefined, AUTH)).body.strings), ['Needs you', 'Some new widget word']);
  assert.equal((await call('GET', `${extra.base}/strings`, undefined, AUTH)).body.strings['Some new widget word'], 'Some new widget word');
  extra.settings.save({ language: 'auto' });
});

test('settings: echoed with the launcher status, validated, and the switch starts and stops the window', async () => {
  db.prepare("DELETE FROM system_state WHERE key LIKE 'attention_widget_%'").run();
  const launcher = fakeLauncher();
  const { base } = await widgetApp({ launcher });
  let answer = await call('GET', `${base}/settings`);
  assert.deepEqual(answer.body, { enabled: true, language: 'auto', platform_supported: true, swiftc: true, running: true, building: false, last_error: null });
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  answer = await call('PUT', `${base}/settings`, { enabled: false });
  assert.equal(answer.body.enabled, false);
  assert.equal(answer.body.running, false);
  assert.deepEqual(launcher.enabledCalls, [false]);
  answer = await call('PUT', `${base}/settings`, { language: 'zh' });
  assert.equal(answer.body.language, 'zh');
  assert.deepEqual(launcher.enabledCalls, [false], 'the language alone does not touch the window');
  answer = await call('PUT', `${base}/settings`, { enabled: true });
  assert.deepEqual(launcher.enabledCalls, [false, true]);
  assert.equal(answer.body.running, true);
  for (const body of [{ enabled: 'yes' }, { language: 'fr' }, [1]]) {
    const refused = await call('PUT', `${base}/settings`, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, 'VALIDATION_FAILED');
  }
  assert.deepEqual((await call('GET', `${base}/settings`)).body.language, 'zh');
  await call('PUT', `${base}/settings`, { language: 'auto' });
});

// ── The launcher, with fakes for everything that would touch the system.

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); setImmediate(() => child.emit('exit', null, signal)); return true; };
  return child;
}

function launcherKit({ platform = 'darwin', env = { PATH: '/usr/bin', HOME: '/Users/me' }, version = '9.9.9', tools = true, buildFails = false, source = true } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'launcher-'));
  const sourcePath = path.join(dir, 'TAttentionWidget.swift');
  if (source) fs.writeFileSync(sourcePath, 'import AppKit\n');
  const calls = { exec: [], spawn: [], logs: [] };
  const children = [];
  const execFile = (file, args, options, callback) => {
    calls.exec.push({ file, args, timeout: options.timeout, env: options.env });
    setImmediate(() => {
      if (file === '/usr/bin/xcode-select') return tools ? callback(null, '/Library/Developer/CommandLineTools\n', '') : callback(Object.assign(new Error('no tools'), { code: 2 }), '', 'error: unable to get active developer directory');
      if (file === '/usr/bin/xcrun' && args.includes('--show-sdk-path')) return callback(null, '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n', '');
      if (file === '/usr/bin/xcrun') return callback(null, '/Library/Developer/CommandLineTools/usr/bin/swiftc\n', '');
      if (buildFails) return callback(Object.assign(new Error('exit 1'), { code: 1 }), '', 'warning: x\nTAttentionWidget.swift:3:1: error: cannot find foo in scope\n');
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'binary');
      return callback(null, '', '');
    });
  };
  const spawnFake = (file, args, options) => {
    calls.spawn.push({ file, args, options });
    const child = fakeChild();
    children.push(child);
    return child;
  };
  const settings = createWidgetSettings({ db });
  db.prepare("DELETE FROM system_state WHERE key LIKE 'attention_widget_%'").run();
  let tokenCount = 0;
  const launcher = createWidgetLauncher({
    settings, dataDir: dir, sourcePath, version, platform, env, pid: 4242, spawn: spawnFake, execFile,
    randomToken: () => `token-${++tokenCount}`, log: line => calls.logs.push(line),
  });
  return { launcher, settings, calls, children, dir, sourcePath };
}
const URL_OF = 'http://127.0.0.1:5173';

test('launcher: builds once, spawns with the parent pid, the url and a new token, and rebuilds only when needed', async () => {
  const kit = launcherKit();
  await kit.launcher.start({ url: URL_OF });
  const build = kit.calls.exec.find(entry => entry.file.endsWith('swiftc'));
  assert.deepEqual(build.args.slice(0, 6), ['-O', '-swift-version', '5', '-framework', 'AppKit', kit.sourcePath]);
  assert.equal(build.args[6], '-o');
  assert.match(build.args[7], /t-attention-widget\.4242\.tmp$/, 'built to a temporary name first');
  assert.equal(build.timeout, 600000);
  // swiftc by its own path needs the SDK from xcrun (without it: "unable to load standard library for target ...").
  assert.equal(build.env.SDKROOT, '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
  assert.equal(fs.readFileSync(kit.launcher.paths.binary, 'utf8'), 'binary');
  assert.equal(fs.existsSync(build.args[7]), false, 'the temporary file was renamed');
  assert.equal(JSON.parse(fs.readFileSync(kit.launcher.paths.stampFile, 'utf8')).version, '9.9.9');
  assert.equal(kit.calls.spawn.length, 1);
  const spawned = kit.calls.spawn[0];
  assert.equal(spawned.file, kit.launcher.paths.binary);
  assert.deepEqual(spawned.args, ['--parent-pid', '4242']);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.deepEqual(spawned.options.env, { PATH: '/usr/bin', HOME: '/Users/me', TA_WIDGET_URL: URL_OF, TA_WIDGET_TOKEN: 'token-1' });
  assert.equal(kit.launcher.verifyToken('token-1'), true);
  assert.equal(kit.launcher.verifyToken('token-2'), false);
  assert.equal(kit.launcher.verifyToken(''), false);
  assert.deepEqual(await kit.launcher.status(), { platform_supported: true, swiftc: true, running: true, building: false, last_error: null });
  // The swiftc stub itself is never run: only xcode-select and xcrun find it.
  assert.ok(!kit.calls.exec.some(entry => entry.file === '/usr/bin/swiftc'));

  // Rebuild decisions.
  assert.equal(kit.launcher.rebuildReason(), null, 'current');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(kit.sourcePath, future, future);
  assert.equal(kit.launcher.rebuildReason(), 'source changed');
  fs.utimesSync(kit.launcher.paths.binary, new Date(Date.now() + 120000), new Date(Date.now() + 120000));
  assert.equal(kit.launcher.rebuildReason(), null);
  fs.writeFileSync(kit.launcher.paths.stampFile, JSON.stringify({ version: '1.0.0' }));
  assert.equal(kit.launcher.rebuildReason(), 'version changed');
  fs.rmSync(kit.launcher.paths.binary);
  assert.equal(kit.launcher.rebuildReason(), 'missing');

  // A second launcher on a current binary does not build.
  const again = launcherKit();
  await again.launcher.start({ url: URL_OF });
  const builds = again.calls.exec.filter(entry => entry.file.endsWith('swiftc')).length;
  again.children[0].emit('exit', 0, null);
  const fresh = createWidgetLauncher({ settings: again.settings, dataDir: again.dir, sourcePath: again.sourcePath, version: '9.9.9', platform: 'darwin', env: {}, pid: 1, spawn: () => fakeChild(), execFile: (file, args, options, callback) => { again.calls.exec.push({ file, args }); setImmediate(() => callback(null, file.endsWith('xcrun') ? '/x/swiftc\n' : '/dev\n', '')); }, log: () => {} });
  await fresh.start({ url: URL_OF });
  assert.equal(again.calls.exec.filter(entry => entry.file.endsWith('swiftc')).length, builds, 'no second build');
  fresh.stop();
});

test('launcher: no respawn after the window quits on its own; off kills it, off and on starts it again', async () => {
  const kit = launcherKit();
  await kit.launcher.start({ url: URL_OF });
  assert.equal(kit.children.length, 1);
  kit.children[0].emit('exit', 0, null); // the person chose Quit
  assert.equal((await kit.launcher.status()).running, false);
  assert.equal(kit.launcher.verifyToken('token-1'), false, 'the token ends with the window');
  await kit.launcher.ensure();
  await kit.launcher.setEnabled(true);
  assert.equal(kit.children.length, 1, 'not started again while the switch stays on');
  kit.settings.save({ enabled: false });
  await kit.launcher.setEnabled(false);
  kit.settings.save({ enabled: true });
  await kit.launcher.setEnabled(true);
  assert.equal(kit.children.length, 2, 'off and on starts it again');
  assert.equal(kit.launcher.verifyToken('token-2'), true, 'with a new token');
  // Off: SIGTERM, and that exit is not a quit.
  kit.settings.save({ enabled: false });
  await kit.launcher.setEnabled(false);
  assert.deepEqual(kit.children[1].signals, ['SIGTERM']);
  assert.equal(kit.launcher.verifyToken('token-2'), false);
  await new Promise(resolve => setImmediate(resolve));
  kit.settings.save({ enabled: true });
  await kit.launcher.setEnabled(true);
  assert.equal(kit.children.length, 3);
  // A crash: no respawn, the reason is kept and logged once.
  kit.children[2].stderr.emit('data', Buffer.from('fatal: something broke\n'));
  kit.children[2].emit('exit', 3, null);
  const status = await kit.launcher.status();
  assert.equal(status.running, false);
  assert.match(status.last_error, /^The window stopped \(exit code 3\): fatal: something broke$/);
  assert.equal(kit.calls.logs.length, 1);
  await kit.launcher.ensure();
  assert.equal(kit.children.length, 3);
  // Shutdown sends SIGTERM to a running window.
  kit.settings.save({ enabled: false });
  await kit.launcher.setEnabled(false);
  kit.settings.save({ enabled: true });
  await kit.launcher.setEnabled(true);
  kit.launcher.stop();
  assert.deepEqual(kit.children[3].signals, ['SIGTERM']);
  // Switched off before the server listens: nothing is built or started.
  const off = launcherKit();
  off.settings.save({ enabled: false });
  await off.launcher.start({ url: URL_OF });
  assert.equal(off.calls.exec.length, 0);
  assert.equal(off.calls.spawn.length, 0);
});

test('launcher: not on Linux, not in test mode, CI, a T-Agent terminal or with TA_WIDGET_DISABLED; missing tools and build failures are reported', async () => {
  const linux = launcherKit({ platform: 'linux' });
  await linux.launcher.start({ url: URL_OF });
  assert.equal(linux.calls.exec.length + linux.calls.spawn.length, 0);
  assert.deepEqual(await linux.launcher.status(), { platform_supported: false, swiftc: false, running: false, building: false, last_error: null });
  for (const env of [{ NODE_ENV: 'test' }, { TA_WIDGET_DISABLED: '1' }, { CI: 'true' }, { TA_PEER_TASK: '3' }]) {
    const kit = launcherKit({ env });
    await kit.launcher.start({ url: URL_OF });
    assert.equal(kit.calls.spawn.length, 0, JSON.stringify(env));
    assert.ok(!kit.calls.exec.some(entry => entry.file.endsWith('swiftc')), 'nothing is built');
    assert.match((await kit.launcher.status()).last_error, /^Not started: /);
  }
  assert.equal(blockedReason({ CI: 'false' }), null);
  // Under PM2 the service starts the window even when PM2 carries a T-Agent terminal's variables.
  assert.equal(blockedReason({ TA_HOOK_TOKEN: 'x', pm_id: '0' }), null);
  assert.match(blockedReason({ TA_HOOK_TOKEN: 'x' }), /inside a T-Agent terminal/);
  assert.equal(blockedReason({}), null);

  const noTools = launcherKit({ tools: false });
  await noTools.launcher.start({ url: URL_OF });
  assert.equal(noTools.calls.spawn.length, 0);
  assert.deepEqual(await noTools.launcher.status(), { platform_supported: true, swiftc: false, running: false, building: false, last_error: 'Xcode command line tools needed: xcode-select --install' });
  assert.ok(!noTools.calls.exec.some(entry => entry.file === '/usr/bin/xcrun'), 'xcrun is not asked without a developer folder');

  const failing = launcherKit({ buildFails: true });
  await failing.launcher.start({ url: URL_OF });
  assert.equal(failing.calls.spawn.length, 0);
  const status = await failing.launcher.status();
  assert.equal(status.last_error, 'The build failed: TAttentionWidget.swift:3:1: error: cannot find foo in scope');
  assert.deepEqual(failing.calls.logs, ['T-Attention desktop window: The build failed: TAttentionWidget.swift:3:1: error: cannot find foo in scope']);
  assert.equal(fs.existsSync(failing.launcher.paths.binary), false, 'a failed build leaves no binary');
  assert.deepEqual(fs.readdirSync(failing.launcher.paths.folder), [], 'nor a temporary file');

  const noSource = launcherKit({ source: false });
  await noSource.launcher.start({ url: URL_OF });
  assert.equal(noSource.calls.spawn.length, 0);
  assert.equal((await noSource.launcher.status()).last_error, 'The window source is missing from this install');
});

test('a real server.js answers the widget API before the gates and keeps its settings behind the login', async t => {
  const data = path.join(root, 'server-data');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', ACCESS_MODE: 'local', SESSION_SECRET: 'attention-widget-server-secret-'.repeat(3),
      T_AGENT_DATA_DIR: data, TAGENT_HOME: data, T_AGENT_DB_PATH: path.join(data, 'db.sqlite'), TASKS_BASE_DIR: path.join(root, 'server-tasks'),
      SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}/api/attention/widget`;
  for (const headers of [{}, { Authorization: 'Bearer tatt_wrong' }, { Authorization: 'Bearer anything' }]) {
    const answer = await call('GET', `${base}/items`, undefined, headers);
    assert.equal(answer.status, 401);
    assert.equal(answer.body.error, 'WIDGET_TOKEN_INVALID', 'the widget router answers, not the attention token router');
  }
  const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
  const settings = await call('GET', `${base}/settings`, undefined, XHR);
  assert.equal(settings.status, 200);
  assert.equal(settings.body.enabled, true);
  assert.equal(settings.body.running, false);
  assert.equal(settings.body.platform_supported, process.platform === 'darwin');
  if (process.platform === 'darwin') assert.equal(settings.body.last_error, 'Not started: the server runs in test mode');
  const saved = await call('PUT', `${base}/settings`, { language: 'zh' }, XHR);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.language, 'zh');
  assert.equal((await call('PUT', `${base}/settings`, { language: 'en' }, { ...XHR, Authorization: 'Bearer x' })).status, 403);
  assert.equal(fs.existsSync(path.join(data, 'widget')), false, 'nothing was built in test mode');
});

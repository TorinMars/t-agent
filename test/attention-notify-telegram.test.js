// The Telegram notifier (plugins/notifiers/telegram) with a mocked gramjs: login steps, message text, the requestCall / discardCall
// sequence and its timeout, the fallback on call errors, and that the session string, api_hash, code and password never reach a response or a log.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionNotify } = require('../services/attention-notify');
const { createTelegramNotifier, messageText, dhHash, MESSAGE_MAX } = require('../plugins/notifiers/telegram');

const SECRET = 'attention-telegram-test-secret-012345';
const API_HASH = '0123456789abcdef0123456789abcdef';
const SESSION = '1AgAOMTQ5LjE1NC4xNjcuNTAB-SESSION-SECRET';
const PASSWORD = 'my 2FA password';
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve)); };

// A TL object: { className, ...args }, like gramjs objects.
function tlProxy(prefix = '') {
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      const name = prefix ? `${prefix}.${key}` : key;
      if (/^[a-z]/.test(key)) return tlProxy(name);
      return function TL(args = {}) { return { className: name, ...args }; };
    },
  });
}
function rpcError(errorMessage, extra = {}) { return Object.assign(new Error(`RPCError ${errorMessage}`), { errorMessage, ...extra }); }

// The gramjs mock. `handlers` answers client.invoke by the request's className.
function mockGram() {
  const state = { clients: [], invokes: [], messages: [], handlers: {}, sendCode: null, entity: null };
  class TelegramClient {
    constructor(session, apiId, apiHash, params) {
      this.session = session; this.apiId = apiId; this.apiHash = apiHash; this.params = params; this.events = []; this.connected = false;
      state.clients.push(this);
    }
    async connect() { this.connected = true; }
    async disconnect() { this.connected = false; }
    async sendCode(credentials, phone) { state.sendCodeArgs = { credentials, phone }; if (state.sendCode) return state.sendCode(); return { phoneCodeHash: 'hash-1', isCodeViaApp: true }; }
    async invoke(request) {
      state.invokes.push(request);
      const handler = state.handlers[request.className];
      if (!handler) return {};
      return handler(request, this);
    }
    async sendMessage(peer, options) { state.messages.push({ peer, ...options }); if (state.sendMessage) return state.sendMessage(); return {}; }
    async getMe() { return { id: 1001, firstName: 'Account', lastName: 'One', username: 'acc_one', phone: '8613800000078' }; }
    async _switchDC(dcId) { state.switchedTo = dcId; }
    async getDialogs() { state.dialogsRead = true; return []; }
    async getEntity(input) { state.entityInput = input; if (state.entity) return state.entity(input); return { className: 'User', id: 2002, accessHash: '-55', firstName: 'Account', lastName: 'Two', username: 'acc_two' }; }
    addEventHandler(fn) { this.events.push(fn); }
    removeEventHandler(fn) { this.events = this.events.filter(item => item !== fn); }
    emit(update) { for (const fn of this.events) fn(update); }
  }
  class StringSession { constructor(value) { this.value = value; } save() { return this.value || SESSION; } }
  const gram = {
    Api: tlProxy(), TelegramClient, sessions: { StringSession }, Logger: class { constructor(level) { this.level = level; } },
    helpers: { returnBigInt: value => `big:${value}` },
    password: { computeCheck: async (info, password) => ({ className: 'InputCheckPasswordSRP', srpId: info.srpId, ok: password === PASSWORD }) },
  };
  return { gram, state };
}
function fakeTimers() {
  let seq = 0;
  const list = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; list.set(id, { fn, ms }); return id; },
    clearTimeout: id => list.delete(id),
    fireWhere(test) { for (const [id, timer] of list) if (test(timer)) { list.delete(id); timer.fn(); return true; } return false; },
    list,
  };
}
const dhConfig = () => {
  const p = crypto.randomBytes(256);
  p[0] |= 0x80; p[255] |= 1;
  return { className: 'messages.DhConfig', g: 3, p, version: 1, random: crypto.randomBytes(256) };
};
const savedConfig = extra => ({ apiId: 12345, apiHash: API_HASH, session: SESSION, phone: '+86*******78', account: { id: '1001', name: 'Account One', username: 'acc_one' }, target: { input: 'acc_two', id: '2002', accessHash: '-55', username: 'acc_two', name: 'Account Two' }, ...extra });

test('the message has the status, title, reason, source and link', () => {
  const body = messageText({ item: { status: 'waiting_user', title: 'Fix the build', attention_reason: 'Claude needs permission to run npm', source: 'claude' }, link: 'https://t.example.com/?attention=4' });
  assert.equal(body, 'T-Attention · Needs you: Fix the build\nReason: Claude needs permission to run npm\nSource: claude\nOpen: https://t.example.com/?attention=4');
  assert.match(messageText({ item: { status: 'failed', title: 'x' }, reason: 'call_failed', error: 'no calls' }), /Failed: x\n\(A call was not possible: no calls\)$/);
  assert.equal(messageText({ item: { status: 'review', title: 'y' } }), 'T-Attention · Review: y');
});

test('the card uses item.context: Needs (pending text and command), summary first, else the first line of the last reply, folder and branch', () => {
  const context = {
    goal: 'Make the build green', last_reply: '\n\nI changed the test runner.\nThen more text', cwd: '/Users/me/work/app', branch: 'feat/x',
    pending: { kind: 'permission', text: 'Claude wants to run a command', tool: 'Bash', command: 'npm test -- --watch' },
  };
  const item = { status: 'waiting_user', title: 'Fix the build', attention_reason: 'Claude wants to run a command', source: 'claude', context };
  assert.equal(messageText({ item, link: 'https://t.example.com/?attention=4' }), [
    'T-Attention \u00b7 Needs you: Fix the build', 'Needs: Claude wants to run a command', 'Command: npm test -- --watch',
    'Last reply: I changed the test runner.', 'Folder: /Users/me/work/app (feat/x)', 'Source: claude', 'Open: https://t.example.com/?attention=4',
  ].join('\n'), 'the reason equal to the pending text is not repeated');
  const withSummary = messageText({ item: { ...item, context: JSON.stringify({ ...context, summary: { text: 'Doing: build fix\nProgress: tests pass\nNeeds: approve npm', at: '2026-11-08T00:00:00Z', model: 'm' } }) } });
  assert.match(withSummary, /\nDoing: build fix\nProgress: tests pass\nNeeds: approve npm\n/, 'the summary (also from a JSON string) replaces the last reply');
  assert.equal(withSummary.includes('Last reply'), false);
  assert.equal(messageText({ item: { status: 'review', title: 'x', context: { branch: 'main' } } }), 'T-Attention \u00b7 Review: x\nFolder: ? (main)');
  assert.equal(messageText({ item: { status: 'review', title: 'x', context: 'not json' } }), 'T-Attention \u00b7 Review: x');
});

test('the card is plain text: control and direction characters are removed, long values are cut, the total is capped and the link kept', () => {
  const long = 'y'.repeat(5000);
  const body = messageText({
    item: { status: 'failed', title: `Title\u0007 with *stars* _under_ \`code\` [x](http://evil)\u202e${long}`, attention_reason: long, source: 'claude',
      context: { pending: { text: long, command: long }, summary: { text: `${long}\n${long}\n${long}` }, cwd: long, branch: long } },
    link: 'https://t.example.com/?attention=9',
  });
  assert.ok(body.length <= MESSAGE_MAX, `capped: ${body.length}`);
  assert.ok(body.endsWith('\nOpen: https://t.example.com/?attention=9'), 'the link survives the cap');
  assert.match(body, /^T-Attention \u00b7 Failed: Title with \*stars\* _under_ `code` \[x\]\(http:\/\/evil\) y+\u2026\n/, 'formatting characters are kept as text; the title is cut');
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u202e]/.test(body), false);
  assert.ok(body.includes('\u2026'));
});

test('messages are sent with parseMode off, so user text is never read as Markdown', async () => {
  const { gram, state } = mockGram();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  await plugin.notify({ item: { status: 'failed', title: '**bold**' }, mode: 'message', config: savedConfig() });
  assert.equal(state.messages[0].parseMode, false);
  assert.equal(state.messages[0].message, 'T-Attention \u00b7 Failed: **bold**');
  plugin.close();
});

test('the Diffie-Hellman hash is 32 bytes of sha256 over a 256-byte g^a', () => {
  const hash = dhHash(dhConfig());
  assert.equal(hash.length, 32);
});

test('notify(message) sends to the stored account 2 with the gramjs client of the saved session', async () => {
  const { gram, state } = mockGram();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  assert.equal(plugin.ready({}), false);
  assert.equal(plugin.ready(savedConfig()), true);
  await plugin.notify({ item: { status: 'failed', title: 'Deploy', source: 'cli' }, mode: 'message', reason: 'status', config: savedConfig(), link: '' });
  await plugin.notify({ item: { status: 'review', title: 'Second' }, mode: 'message', reason: 'status', config: savedConfig(), link: '' });
  assert.equal(state.clients.length, 1, 'the connected client is reused');
  assert.equal(state.clients[0].session.value, SESSION);
  assert.equal(state.clients[0].params.baseLogger.level, 'none', 'gramjs logging is off');
  assert.deepEqual(state.messages[0].peer, { className: 'InputPeerUser', userId: 'big:2002', accessHash: 'big:-55' });
  assert.equal(state.messages[0].message, 'T-Attention · Failed: Deploy\nSource: cli');
  state.sendMessage = () => { throw rpcError('FLOOD', { seconds: 42 }); };
  await assert.rejects(plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'message', config: savedConfig() }), /wait 42 seconds/);
  plugin.close();
});

test('a call: GetDhConfig, RequestCall with g_a_hash and protocol, then DiscardCall after the ring time', async () => {
  const { gram, state } = mockGram();
  const timers = fakeTimers();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  state.handlers['phone.RequestCall'] = () => ({ className: 'phone.PhoneCall', phoneCall: { className: 'PhoneCallWaiting', id: '77', accessHash: '88' } });
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers });
  const pending = plugin.notify({ item: { status: 'waiting_user', title: 'x' }, mode: 'call', reason: 'status', config: savedConfig({ callSeconds: 20 }) });
  await settle();
  const names = state.invokes.map(request => request.className);
  assert.deepEqual(names, ['messages.GetDhConfig', 'phone.RequestCall']);
  const request = state.invokes[1];
  assert.deepEqual(request.userId, { className: 'InputUser', userId: 'big:2002', accessHash: 'big:-55' });
  assert.equal(request.gAHash.length, 32);
  assert.equal(request.video, false);
  assert.equal(request.protocol.className, 'PhoneCallProtocol');
  assert.ok(request.protocol.udpP2p && request.protocol.udpReflector && request.protocol.maxLayer >= request.protocol.minLayer);
  assert.ok(timers.fireWhere(timer => timer.ms === 20000), 'rings 20 seconds');
  assert.deepEqual(await pending, { outcome: 'call_timeout' });
  const discard = state.invokes[2];
  assert.equal(discard.className, 'phone.DiscardCall');
  assert.deepEqual(discard.peer, { className: 'InputPhoneCall', id: '77', accessHash: '88' });
  assert.equal(discard.reason.className, 'PhoneCallDiscardReasonMissed');
  assert.equal(discard.duration, 0);
  assert.equal(state.clients[0].events.length, 0, 'the update handler is removed');
  plugin.close();
});

test('a call ends at once when account 2 answers (hang up) or declines (nothing to discard)', async () => {
  const { gram, state } = mockGram();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  state.handlers['phone.RequestCall'] = () => ({ phoneCall: { id: '77', accessHash: '88' } });
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  const answered = plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig() });
  await settle();
  state.clients[0].emit({ className: 'UpdatePhoneCall', phoneCall: { className: 'PhoneCallAccepted', id: '99' } }); // another call: ignored
  state.clients[0].emit({ className: 'UpdatePhoneCall', phoneCall: { className: 'PhoneCallAccepted', id: '77' } });
  assert.deepEqual(await answered, { outcome: 'call_answered' });
  assert.equal(state.invokes.at(-1).className, 'phone.DiscardCall');
  assert.equal(state.invokes.at(-1).reason.className, 'PhoneCallDiscardReasonHangup');
  const before = state.invokes.length;
  const declined = plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig() });
  await settle();
  state.clients[0].emit({ className: 'UpdatePhoneCall', phoneCall: { className: 'PhoneCallDiscarded', id: '77' } });
  assert.deepEqual(await declined, { outcome: 'call_declined' });
  assert.deepEqual(state.invokes.slice(before).map(request => request.className), ['messages.GetDhConfig', 'phone.RequestCall']);
  plugin.close();
});

test('call errors (privacy, flood wait) return a message fallback and are logged without secrets', async () => {
  const { gram, state } = mockGram();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  const logs = [];
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  state.handlers['phone.RequestCall'] = () => { throw rpcError('USER_PRIVACY_RESTRICTED'); };
  const privacy = await plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig(), log: (level, message) => logs.push(message) });
  assert.deepEqual(privacy, { fallback: 'message', error: 'The privacy settings of account 2 do not allow calls from account 1' });
  state.handlers['phone.RequestCall'] = () => { throw rpcError('FLOOD', { seconds: 300 }); };
  const flood = await plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig(), log: (level, message) => logs.push(message) });
  assert.match(flood.error, /wait 300 seconds/);
  assert.equal(logs.length, 2);
  assert.equal(logs.join('\n').includes(SESSION) || logs.join('\n').includes(API_HASH), false);
  plugin.close();
});

test('end to end through the service: a failed call becomes a fallback message on Telegram', async () => {
  const { gram, state } = mockGram();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  state.handlers['phone.RequestCall'] = () => { throw rpcError('USER_PRIVACY_RESTRICTED'); };
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const listeners = [];
  const logs = [];
  const service = createAttentionNotify({ db, sessionSecret: SECRET, onChange: fn => { listeners.push(fn); return () => {}; }, getOwner: () => 'owner', notifiers: [plugin], log: (level, message) => logs.push(message) });
  service.saveRules('owner', { modes: { telegram: { waiting_user: 'call' } } });
  require('../lib/token-crypto');
  db.prepare("INSERT INTO system_state (key, value) VALUES ('attention-notify:telegram:owner', ?)").run(require('../lib/token-crypto').encryptToken(JSON.stringify(savedConfig()), SECRET));
  listeners[0]({ kind: 'updated', item: { id: 5, title: 'Approve', status: 'waiting_user', source: 'claude' }, previous: { id: 5, status: 'working' }, event: { actor: 'claude' } });
  await settle(10);
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0].message, /^T-Attention · Needs you: Approve\nSource: claude\n\(A call was not possible: The privacy settings/);
  assert.equal(logs.join('\n').includes(SESSION), false);
  plugin.close();
});

// The login endpoints through the real service router.
async function loginServer(options = {}) {
  const { gram, state } = mockGram();
  const timers = fakeTimers();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers, ...options });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const logs = [];
  const service = createAttentionNotify({ db, sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], log: (level, message) => logs.push(message) });
  const app = express();
  app.use((req, res, next) => { req.session = { user: { login: 'owner' } }; next(); });
  app.use('/api/attention-notify', service.createRouter({ requireAuth: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/attention-notify/telegram`;
  const bodies = [];
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body ? JSON.stringify(body) : undefined });
    const raw = await res.text();
    bodies.push(raw);
    return { status: res.status, data: JSON.parse(raw) };
  };
  return { gram, state, timers, plugin, db, logs, server, call, bodies, close: () => { plugin.close(); server.close(); } };
}

test('login: start sends the code, verify asks for the 2FA password, password finishes; secrets never leave the server', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, db } = ctx;
    assert.equal((await call('GET', '/status')).data.step, 'none');
    assert.equal((await call('POST', '/start', { api_id: 'x', api_hash: API_HASH, phone: '+8613800000078' })).status, 400);
    assert.equal((await call('POST', '/start', { api_id: 12345, api_hash: 'short', phone: '+8613800000078' })).status, 400);
    assert.equal((await call('POST', '/verify', { code: '12345' })).status, 409, 'verify before start');
    const started = await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+86 138 0000 0078' });
    assert.equal(started.status, 200);
    assert.equal(started.data.step, 'code');
    assert.equal(started.data.codeVia, 'app');
    assert.equal(started.data.phone, '+86*********78');
    assert.deepEqual(state.sendCodeArgs, { credentials: { apiId: 12345, apiHash: API_HASH }, phone: '+8613800000078' });
    state.handlers['auth.SignIn'] = request => { if (request.phoneCode !== '24680') throw rpcError('PHONE_CODE_INVALID'); throw rpcError('SESSION_PASSWORD_NEEDED'); };
    const wrong = await call('POST', '/verify', { code: '11111' });
    assert.deepEqual([wrong.status, wrong.data.error], [502, 'The code is wrong']);
    const verified = await call('POST', '/verify', { code: '24 680' });
    assert.equal(verified.data.step, 'password');
    assert.equal(state.invokes.filter(request => request.className === 'auth.SignIn').at(-1).phoneCodeHash, 'hash-1');
    state.handlers['account.GetPassword'] = () => ({ className: 'account.Password', srpId: 7 });
    state.handlers['auth.CheckPassword'] = request => { if (!request.password.ok) throw rpcError('PASSWORD_HASH_INVALID'); return {}; };
    const badPassword = await call('POST', '/password', { password: 'nope' });
    assert.deepEqual([badPassword.status, badPassword.data.error], [502, 'The password is wrong']);
    const done = await call('POST', '/password', { password: PASSWORD });
    assert.equal(done.status, 200);
    assert.equal(done.data.loggedIn, true);
    assert.deepEqual(done.data.account, { id: '1001', name: 'Account One', username: 'acc_one' });
    assert.equal(done.data.hasApiHash, true);
    const stored = db.prepare("SELECT value FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().value;
    assert.equal(stored.includes(SESSION) || stored.includes(API_HASH), false, 'stored encrypted');
    // Account 2 by username, then by numeric id (the dialogs are read first so the id is known).
    const target = await call('PUT', '/config', { target: '@acc_two', callSeconds: 45 });
    assert.deepEqual(target.data.target, { input: 'acc_two', name: 'Account Two', username: 'acc_two' });
    assert.equal(target.data.callSeconds, 45);
    await call('PUT', '/config', { target: '2002' });
    assert.equal(state.dialogsRead, true);
    assert.equal(state.entityInput, 'big:2002');
    state.entity = () => ({ className: 'User', id: 1001, self: true });
    assert.equal((await call('PUT', '/config', { target: 'acc_one' })).status, 400, 'account 1 itself is refused');
    state.entity = () => ({ className: 'Channel', id: 5 });
    assert.equal((await call('PUT', '/config', { target: 'somechannel' })).status, 400);
    assert.equal((await call('PUT', '/config', { callSeconds: 500 })).status, 400);
    // The test message reaches account 2.
    state.entity = null;
    await call('PUT', '/config', { target: 'acc_two' });
    const tested = await call('POST', '/test', { kind: 'message' });
    assert.deepEqual(tested.data, { ok: true, outcome: 'sent' });
    assert.match(state.messages.at(-1).message, /^T-Attention · Needs you: Test message/);
    // Log out ends the session on Telegram and forgets it here.
    const out = await call('POST', '/logout');
    assert.equal(out.data.loggedIn, false);
    assert.ok(state.invokes.some(request => request.className === 'auth.LogOut'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().n, 0);
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    for (const secret of [SESSION, API_HASH, PASSWORD, '24680', 'hash-1']) assert.equal(everything.includes(secret), false, `${secret} must not leave the server`);
  } finally { ctx.close(); }
});

test('login: a started login expires after 10 minutes and a direct sign-in without 2FA finishes at verify', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, timers } = ctx;
    await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+447700900123' });
    assert.ok(timers.fireWhere(timer => timer.ms === 10 * 60 * 1000));
    assert.equal((await call('POST', '/verify', { code: '12345' })).status, 409);
    await call('POST', '/start', { api_id: 12345, phone: '+447700900123', api_hash: API_HASH });
    state.handlers['auth.SignIn'] = () => ({ className: 'auth.Authorization' });
    const done = await call('POST', '/verify', { code: '12345' });
    assert.equal(done.data.loggedIn, true);
    assert.equal(done.data.step, 'done');
    state.sendCode = () => { throw rpcError('PHONE_NUMBER_INVALID'); };
    const bad = await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+10000000' });
    assert.deepEqual([bad.status, bad.data.error], [502, 'The phone number is invalid']);
    assert.equal((await call('POST', '/test', { kind: 'message' })).status, 409, 'no account 2 yet');
  } finally { ctx.close(); }
});

test('status(config, owner) is the plugin overview hook: configured and a summary with the phone masked and no secret', () => {
  const plugin = createTelegramNotifier({ loadGram: () => { throw new Error('gramjs is not needed for the status'); } });
  const none = plugin.status({}, 'local');
  assert.equal(none.configured, false);
  assert.equal(none.summary, 'Not logged in');
  const full = plugin.status(savedConfig(), 'local');
  assert.equal(full.configured, true);
  assert.equal(full.summary, 'Logged in as Account One (+86*******78) → account 2 Account Two');
  // An unmasked phone (an older saved config) is masked; no target means not configured.
  const raw = plugin.status(savedConfig({ phone: '+8613800000078', target: undefined, account: { id: '1', name: '', username: 'acc_one' } }), 'local');
  assert.equal(raw.configured, false);
  assert.equal(raw.summary, 'Logged in as @acc_one (+86*********78) → account 2 not chosen');
  for (const state of [none, full, raw]) {
    const text = JSON.stringify({ configured: state.configured, summary: state.summary });
    for (const secret of [SESSION, API_HASH, '13800000078', '12345']) assert.equal(text.includes(secret), false, `no ${secret}`);
  }
});

test('the notifier overview shows the Telegram state and the per-status modes, and never a stored secret', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const plugin = createTelegramNotifier({ loadGram: () => { throw new Error('not needed'); } });
  const service = createAttentionNotify({ db, sessionSecret: SECRET, notifiers: [plugin], getOwner: () => 'local', log: () => {} });
  const store = config => db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('attention-notify:telegram:local', ?)").run(require('../lib/token-crypto').encryptToken(JSON.stringify(config), SECRET));
  store(savedConfig());
  service.saveRules('local', { statuses: ['waiting_user', 'review'], modes: { telegram: { waiting_user: 'call' } } });
  const [entry] = service.overview('local');
  assert.deepEqual(entry, { name: 'telegram', version: null, description: null, loaded: true, error: null, enabled: true, configured: true, summary: 'Logged in as Account One (+86*******78) → account 2 Account Two', statuses: { waiting_user: 'call', review: 'message' }, settings: false, test: true, customUi: null, origin: 'builtin', dev: false });
  // A summary that would carry a stored secret is dropped.
  store(savedConfig({ account: { id: '1', name: SESSION } }));
  assert.equal(service.overview('local')[0].summary, null);
  service.stop();
});

// ---- QR login ----
const TOKEN_1 = Buffer.from('qr-token-one-secret');
const TOKEN_2 = Buffer.from('qr-token-two-secret');
const urlOf = token => `tg://login?token=${token.toString('base64url')}`;
const exports_ = state => state.invokes.filter(request => request.className === 'auth.ExportLoginToken');

test('QR login: start shows a server-rendered SVG, the token refreshes when it expires, the scan finishes the login', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock });
  try {
    const { call, state, db } = ctx;
    assert.equal((await call('POST', '/qr/start', { api_id: 'x', api_hash: API_HASH })).status, 400);
    assert.equal((await call('POST', '/qr/start', { api_id: 12345, api_hash: 'short' })).status, 400);
    const tokens = [TOKEN_1, TOKEN_2];
    state.handlers['auth.ExportLoginToken'] = () => {
      const token = tokens.shift();
      return token ? { className: 'auth.LoginToken', token, expires: Math.floor(clock / 1000) + 30 } : { className: 'auth.LoginTokenSuccess', authorization: { className: 'auth.Authorization' } };
    };
    const started = await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    assert.equal(started.status, 200);
    assert.equal(started.data.step, 'qr');
    assert.equal(started.data.url, urlOf(TOKEN_1));
    assert.match(started.data.svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>\s*$/, 'rendered on the server with qrcode');
    assert.equal(started.data.expiresAt, new Date(clock + 30000).toISOString());
    const request = exports_(state)[0];
    assert.deepEqual([request.apiId, request.apiHash, request.exceptIds], [12345, API_HASH, []]);
    assert.equal(state.clients.at(-1).session.value, '', 'a fresh session');
    // Polling before expiry does not ask Telegram again.
    clock += 2000;
    assert.equal((await call('GET', '/qr/status')).data.url, urlOf(TOKEN_1));
    assert.equal(exports_(state).length, 1);
    // After expiry the next poll gets a new token and a new QR.
    clock += 29000;
    const refreshed = await call('GET', '/qr/status');
    assert.equal(refreshed.data.step, 'qr');
    assert.equal(refreshed.data.url, urlOf(TOKEN_2));
    assert.notEqual(refreshed.data.svg, started.data.svg);
    assert.equal(exports_(state).length, 2);
    // Account 1 scans and accepts: UpdateLoginToken, then the export returns LoginTokenSuccess.
    state.clients.at(-1).emit({ className: 'UpdateLoginToken' });
    clock += 2000;
    const done = await call('GET', '/qr/status');
    assert.equal(done.data.step, 'done');
    assert.equal(done.data.loggedIn, true);
    assert.equal(done.data.phone, '+86*********78', 'the phone of account 1 comes from getMe, masked');
    assert.deepEqual(done.data.account, { id: '1001', name: 'Account One', username: 'acc_one' });
    assert.equal(done.data.url, undefined);
    assert.equal(state.clients.at(-1).connected, false, 'the login client is closed');
    assert.equal((await call('GET', '/qr/status')).data.step, 'done', 'still done on the next poll');
    assert.equal((await call('GET', '/status')).data.step, 'done');
    const stored = db.prepare("SELECT value FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().value;
    assert.equal(stored.includes(SESSION) || stored.includes(API_HASH), false, 'stored encrypted');
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    for (const secret of [SESSION, API_HASH]) assert.equal(everything.includes(secret), false, `${secret} must not leave the server`);
  } finally { ctx.close(); }
});

test('QR login: a DC migration switches the data center and imports the token there', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async url => `<svg>${url.length}</svg>` });
  try {
    const { call, state } = ctx;
    let scanned = false;
    state.handlers['auth.ExportLoginToken'] = () => (scanned
      ? { className: 'auth.LoginTokenMigrateTo', dcId: 4, token: TOKEN_2 }
      : { className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    state.handlers['auth.ImportLoginToken'] = request => {
      assert.equal(state.switchedTo, 4, 'the switch happens before the import');
      assert.equal(Buffer.compare(request.token, TOKEN_2), 0);
      return { className: 'auth.LoginTokenSuccess', authorization: { className: 'auth.Authorization' } };
    };
    assert.equal((await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH })).data.svg, `<svg>${urlOf(TOKEN_1).length}</svg>`);
    scanned = true;
    state.clients.at(-1).emit({ className: 'UpdateLoginToken' });
    const done = await call('GET', '/qr/status');
    assert.equal(done.data.step, 'done');
    assert.equal(state.switchedTo, 4);
    assert.ok(state.invokes.some(request => request.className === 'auth.ImportLoginToken'));
  } finally { ctx.close(); }
});

test('QR login: SESSION_PASSWORD_NEEDED after the scan moves to the 2FA password step, which finishes the login', async () => {
  const clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async () => '<svg></svg>' });
  try {
    const { call, state } = ctx;
    let scanned = false;
    state.handlers['auth.ExportLoginToken'] = () => { if (scanned) throw rpcError('SESSION_PASSWORD_NEEDED'); return { className: 'auth.LoginToken', token: TOKEN_1, expires: clock / 1000 + 30 }; };
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    scanned = true;
    state.clients.at(-1).emit({ className: 'UpdateLoginToken' });
    const asked = await call('GET', '/qr/status');
    assert.equal(asked.data.step, 'password');
    assert.equal(asked.data.url, undefined);
    assert.equal(asked.data.svg, undefined);
    assert.equal((await call('GET', '/status')).data.step, 'password');
    state.handlers['account.GetPassword'] = () => ({ className: 'account.Password', srpId: 7 });
    state.handlers['auth.CheckPassword'] = request => { if (!request.password.ok) throw rpcError('PASSWORD_HASH_INVALID'); return {}; };
    assert.equal((await call('POST', '/password', { password: 'nope' })).data.error, 'The password is wrong');
    const done = await call('POST', '/password', { password: PASSWORD });
    assert.equal(done.data.loggedIn, true);
    assert.equal((await call('GET', '/qr/status')).data.step, 'done');
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    for (const secret of [SESSION, API_HASH, PASSWORD]) assert.equal(everything.includes(secret), false, `${secret} must not leave the server`);
  } finally { ctx.close(); }
});

test('QR login: it expires after 10 minutes or on cancel, overlapping polls export once, and Telegram errors are explained', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async () => '<svg></svg>' });
  try {
    const { call, state, timers } = ctx;
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired', 'nothing started');
    let release;
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    state.handlers['auth.ExportLoginToken'] = () => new Promise(resolve => { release = () => resolve({ className: 'auth.LoginToken', token: TOKEN_2, expires: Math.floor(clock / 1000) + 30 }); });
    clock += 31000;
    const polls = [call('GET', '/qr/status'), call('GET', '/qr/status')];
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const answers = await Promise.all(polls);
    assert.deepEqual(answers.map(answer => answer.data.url), [urlOf(TOKEN_2), urlOf(TOKEN_2)]);
    assert.equal(exports_(state).length, 2, 'one export for two overlapping polls');
    assert.ok(timers.fireWhere(timer => timer.ms === 10 * 60 * 1000));
    const expired = await call('GET', '/qr/status');
    assert.equal(expired.data.step, 'expired');
    assert.equal(expired.data.loggedIn, false);
    assert.equal(state.clients.at(-1).connected, false);
    // Cancel ends it too.
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    assert.equal((await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH })).data.step, 'qr');
    await call('POST', '/cancel');
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    // A bad api_id pair, and a flood wait during a refresh, come back as short messages.
    state.handlers['auth.ExportLoginToken'] = () => { throw rpcError('API_ID_INVALID'); };
    const bad = await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    assert.deepEqual([bad.status, bad.data.error], [502, 'The api_id / api_hash pair is invalid']);
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    state.handlers['auth.ExportLoginToken'] = () => { throw rpcError('FLOOD', { seconds: 9 }); };
    clock += 31000;
    const flood = await call('GET', '/qr/status');
    assert.deepEqual([flood.status, flood.data.error], [502, 'Telegram asks to wait 9 seconds before trying again']);
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    assert.equal(ctx.bodies.join('\n').includes(API_HASH), false);
  } finally { ctx.close(); }
});

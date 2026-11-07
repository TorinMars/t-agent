// T-Attention notifier: Telegram user account 1 -> user account 2 over the MTProto user API (npm package `telegram`, gramjs).
// Account 1 logs in from Settings (api_id, api_hash, phone, code, optional 2FA password); its session string and api_hash are
// stored encrypted by services/attention-notify.js and are never logged or sent to the browser. A session string is full access
// to account 1. Account 2 (the target) gets the messages and the calls.
// A call is only a ring: phone.requestCall with the Diffie-Hellman g_a_hash Telegram needs, then phone.discardCall after N seconds
// or as soon as it is answered or declined. No audio is set up.
const crypto = require('crypto');

const LOGIN_TTL_MS = 10 * 60 * 1000; // a started login waits at most 10 minutes for the code / password
const IDLE_MS = 10 * 60 * 1000; // a connected client for notifications is closed after 10 idle minutes
const DEFAULT_CALL_SECONDS = 30;
const STATUS_LABELS = { waiting_user: 'Needs you', review: 'Review', failed: 'Failed', working: 'Working', todo: 'To do', done: 'Done', cancelled: 'Cancelled' };

class TelegramError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'NotifyError'; this.statusCode = statusCode; }
}

const text = value => (typeof value === 'string' ? value.trim() : '');
const code = error => String((error && error.errorMessage) || '');
// The browser and the logs only get the Telegram error code (upper case letters), never the raw error object.
function explain(error) {
  const name = code(error);
  if (name === 'FLOOD' || /^FLOOD_WAIT/.test(name) || (error && Number.isFinite(error.seconds))) return `Telegram asks to wait ${Number(error.seconds) || 0} seconds before trying again`;
  const known = {
    PHONE_NUMBER_INVALID: 'The phone number is invalid', PHONE_NUMBER_BANNED: 'This phone number is banned by Telegram',
    PHONE_CODE_INVALID: 'The code is wrong', PHONE_CODE_EXPIRED: 'The code has expired; start the login again', PHONE_CODE_EMPTY: 'Enter the code',
    PASSWORD_HASH_INVALID: 'The password is wrong', API_ID_INVALID: 'The api_id / api_hash pair is invalid', API_ID_PUBLISHED_FLOOD: 'This api_id cannot be used; create your own at my.telegram.org',
    USERNAME_NOT_OCCUPIED: 'No Telegram user has this username', USERNAME_INVALID: 'The username is invalid',
    USER_PRIVACY_RESTRICTED: 'The privacy settings of account 2 do not allow calls from account 1', USER_IS_BLOCKED: 'Account 2 blocked account 1',
    PARTICIPANT_VERSION_OUTDATED: 'The Telegram app of account 2 cannot take this call', AUTH_KEY_UNREGISTERED: 'The Telegram login has ended; log in again',
    SESSION_REVOKED: 'The Telegram login has ended; log in again', USER_DEACTIVATED: 'Account 1 has been deactivated',
  }[name];
  if (known) return known;
  return /^[A-Z0-9_]{3,64}$/.test(name) ? `Telegram error ${name}` : 'Telegram could not be reached';
}
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length < 5 ? '' : `+${digits.slice(0, 2)}${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-2)}`;
}

// The message for one item: a short card that says what it is, what it needs and where it is. Plain text (sent with parseMode off, so
// '*', '_' or '`' in user text are not read as formatting), control characters removed, at most MESSAGE_MAX characters; the link stays whole.
const MESSAGE_MAX = 1000;
const oneLine = (value, max) => cut(String(value || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
const lines = (value, max) => cut(String(value || '').split(/\r?\n/).map(line => oneLine(line, max)).filter(Boolean).join('\n'), max);
function cut(value, max) { return value.length > max ? `${value.slice(0, max - 1).trimEnd()}\u2026` : value; }
function contextOf(item) {
  let context = item && item.context;
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = null; } }
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}
function messageText({ item, link, reason, error }) {
  const context = contextOf(item);
  const pending = context.pending && typeof context.pending === 'object' ? context.pending : null;
  const out = [`T-Attention \u00b7 ${STATUS_LABELS[item.status] || oneLine(item.status, 30)}: ${oneLine(item.title, 200)}`];
  const needs = pending && oneLine(pending.text, 300);
  if (needs) out.push(`Needs: ${needs}`);
  if (pending && pending.command) out.push(`Command: ${oneLine(pending.command, 300)}`);
  const why = oneLine(item.attention_reason, 300);
  if (why && why !== needs) out.push(`Reason: ${why}`);
  const summary = context.summary && typeof context.summary === 'object' ? lines(context.summary.text, 400) : '';
  const lastReply = typeof context.last_reply === 'string' ? oneLine(context.last_reply.split(/\r?\n/).find(line => line.trim()) || '', 200) : '';
  if (summary) out.push(summary);
  else if (lastReply) out.push(`Last reply: ${lastReply}`);
  const folder = oneLine(context.cwd, 160);
  const branch = oneLine(context.branch, 80);
  if (folder || branch) out.push(`Folder: ${folder || '?'}${branch ? ` (${branch})` : ''}`);
  if (item.source) out.push(`Source: ${oneLine(item.source, 60)}`);
  if (reason === 'call_failed') out.push(`(A call was not possible: ${oneLine(error || 'unknown error', 200)})`);
  const tail = link ? `\nOpen: ${oneLine(link, 500)}` : '';
  return cut(out.join('\n'), MESSAGE_MAX - tail.length) + tail;
}

// Big-endian bytes <-> BigInt, and g^a mod p, for the call's Diffie-Hellman hash.
const toBig = bytes => BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
function toBytes(value, length) {
  const hex = value.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex.slice(-length * 2), 'hex');
}
function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) { if (e & 1n) result = (result * b) % modulus; e >>= 1n; b = (b * b) % modulus; }
  return result;
}
function dhHash(dh, randomBytes = crypto.randomBytes) {
  const p = toBig(dh.p);
  const salt = dh.random && dh.random.length ? Buffer.from(dh.random) : Buffer.alloc(256);
  const own = randomBytes(256);
  const a = toBig(own.map((byte, index) => byte ^ (salt[index] || 0))) % (p - 1n) || 2n;
  const gA = toBytes(modPow(BigInt(dh.g), a, p), 256);
  return crypto.createHash('sha256').update(gA).digest();
}

// options: loadGram() -> the `telegram` module (tests pass a mock), timers, randomBytes.
function createTelegramNotifier(options = {}) {
  const loadGram = options.loadGram || (() => require('telegram'));
  const timers = options.timers || { setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); if (handle.unref) handle.unref(); return handle; }, clearTimeout };
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const logins = new Map(); // owner -> { client, apiId, apiHash, phone, phoneCodeHash, step, timer }
  const clients = new Map(); // session string -> { client, ready, idle }

  function makeClient(session, apiId, apiHash) {
    const gram = loadGram();
    return new gram.TelegramClient(new gram.sessions.StringSession(session || ''), Number(apiId), apiHash, {
      connectionRetries: 3, floodSleepThreshold: 0, deviceModel: 'T-Attention', appVersion: '1.0', baseLogger: new gram.Logger('none'),
    });
  }
  const quietly = promise => Promise.resolve(promise).catch(() => {});
  function dropLogin(owner) {
    const login = logins.get(owner);
    if (!login) return;
    timers.clearTimeout(login.timer);
    logins.delete(owner);
    quietly(login.client.disconnect());
  }
  // The connected client for a saved session, reused while notifications come in.
  async function clientFor(config) {
    let entry = clients.get(config.session);
    if (!entry) {
      const client = makeClient(config.session, config.apiId, config.apiHash);
      entry = { client, ready: client.connect().then(() => client) };
      clients.set(config.session, entry);
      entry.ready.catch(() => { if (clients.get(config.session) === entry) clients.delete(config.session); });
    }
    timers.clearTimeout(entry.idle);
    entry.idle = timers.setTimeout(() => { clients.delete(config.session); quietly(entry.client.disconnect()); }, IDLE_MS);
    return entry.ready;
  }
  function closeClient(session) {
    const entry = clients.get(session);
    if (!entry) return;
    clients.delete(session);
    timers.clearTimeout(entry.idle);
    quietly(entry.ready.then(client => client.disconnect()));
  }
  const peerOf = (gram, target) => new gram.Api.InputPeerUser({ userId: gram.helpers.returnBigInt(target.id), accessHash: gram.helpers.returnBigInt(target.accessHash) });
  const userOf = (gram, target) => new gram.Api.InputUser({ userId: gram.helpers.returnBigInt(target.id), accessHash: gram.helpers.returnBigInt(target.accessHash) });
  const ready = config => Boolean(config && config.session && config.apiHash && config.apiId && config.target && config.target.id);

  async function sendMessage(config, body) {
    const gram = loadGram();
    const client = await clientFor(config);
    await client.sendMessage(peerOf(gram, config.target), { message: body, linkPreview: false, parseMode: false });
  }

  // Rings account 2 and hangs up after `seconds`, or when it is answered or declined. Returns 'answered' | 'declined' | 'timeout'.
  async function ring(config, seconds) {
    const gram = loadGram();
    const { Api } = gram;
    const client = await clientFor(config);
    const dh = await client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }));
    const gAHash = dhHash(dh, randomBytes);
    let settle;
    const outcome = new Promise(resolve => { settle = resolve; });
    let callId = null;
    const early = []; // updates that arrive before requestCall returns its id
    const onUpdate = update => {
      if (!update || update.className !== 'UpdatePhoneCall' || !update.phoneCall) return;
      if (callId === null) { early.push(update.phoneCall); return; }
      const call = update.phoneCall;
      if (String(call.id) !== callId) return;
      if (call.className === 'PhoneCallAccepted') settle('answered');
      if (call.className === 'PhoneCallDiscarded') settle('declined');
    };
    client.addEventHandler(onUpdate);
    let timer;
    try {
      const result = await client.invoke(new Api.phone.RequestCall({
        video: false, userId: userOf(gram, config.target), randomId: crypto.randomInt(1, 2 ** 31 - 1), gAHash,
        protocol: new Api.PhoneCallProtocol({ udpP2p: true, udpReflector: true, minLayer: 65, maxLayer: 92, libraryVersions: ['2.4.4', '4.0.0'] }),
      }));
      const call = result.phoneCall;
      callId = String(call.id);
      for (const seen of early) onUpdate({ className: 'UpdatePhoneCall', phoneCall: seen });
      timer = timers.setTimeout(() => settle('timeout'), seconds * 1000);
      const how = await outcome;
      // A declined call is already over; an answered or unanswered one is hung up by us.
      if (how !== 'declined') {
        await client.invoke(new Api.phone.DiscardCall({
          peer: new Api.InputPhoneCall({ id: call.id, accessHash: call.accessHash }), duration: 0, connectionId: gram.helpers.returnBigInt(0),
          reason: how === 'timeout' ? new Api.PhoneCallDiscardReasonMissed() : new Api.PhoneCallDiscardReasonHangup(),
        }));
      }
      return how;
    } finally {
      timers.clearTimeout(timer);
      client.removeEventHandler(onUpdate);
    }
  }
  const callSeconds = config => Math.min(120, Math.max(5, Number(config.callSeconds) || DEFAULT_CALL_SECONDS));

  // ---- The contract interface ----
  async function notify({ item, reason, mode, config, log, link, error }) {
    if (!ready(config)) throw new TelegramError('Telegram is not set up');
    if (mode === 'call') {
      try {
        const how = await ring(config, callSeconds(config));
        return { outcome: `call_${how}` };
      } catch (failure) {
        const why = explain(failure);
        if (log) log('warn', `call failed: ${why}`);
        if (/^(AUTH_KEY_UNREGISTERED|SESSION_REVOKED)$/.test(code(failure))) closeClient(config.session);
        return { fallback: 'message', error: why };
      }
    }
    try { await sendMessage(config, messageText({ item, link, reason, error })); return { outcome: 'sent' }; }
    catch (failure) { throw new TelegramError(explain(failure), 502); }
  }
  async function test(config, { kind = 'message', link = '' } = {}) {
    if (!ready(config)) throw new TelegramError('Log in and choose account 2 first', 409);
    try {
      if (kind === 'call') return { ok: true, outcome: await ring(config, callSeconds(config)) };
      await sendMessage(config, messageText({ item: { status: 'waiting_user', title: 'Test message', attention_reason: 'This is a test from Settings', source: 'T-Attention' }, link }));
      return { ok: true, outcome: 'sent' };
    } catch (failure) { throw new TelegramError(explain(failure), 502); }
  }
  function status(config, owner) {
    const login = owner !== undefined ? logins.get(owner) : null;
    return {
      loggedIn: Boolean(config.session), step: login ? login.step : (config.session ? 'done' : 'none'),
      apiId: config.apiId || (login && login.apiId) || null, hasApiHash: Boolean(config.apiHash),
      phone: config.phone || (login ? maskPhone(login.phone) : ''), account: config.account || null,
      target: config.target ? { input: config.target.input, name: config.target.name, username: config.target.username } : null,
      callSeconds: callSeconds(config),
    };
  }

  // ---- Login and settings endpoints: /api/attention-notify/telegram/... ----
  function routes(router, { store, owner }) {
    const wrap = handler => async (req, res, next) => { try { await handler(req, res); } catch (failure) { next(failure.name === 'NotifyError' ? failure : new TelegramError(explain(failure), 502)); } };
    const finish = async (req, login) => {
      const client = login.client;
      const me = await client.getMe();
      const config = store.read(owner(req));
      if (config.session && config.session !== client.session.save()) closeClient(config.session);
      const account = { id: String(me.id), name: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username || '' };
      store.write(owner(req), { ...config, apiId: login.apiId, apiHash: login.apiHash, session: client.session.save(), phone: maskPhone(login.phone), account });
      timers.clearTimeout(login.timer);
      logins.delete(owner(req));
      quietly(client.disconnect());
    };
    router.get('/status', (req, res) => res.json(status(store.read(owner(req)), owner(req))));
    router.post('/start', wrap(async (req, res) => {
      const body = req.body || {};
      const apiId = Number(body.api_id);
      const apiHash = text(body.api_hash) || store.read(owner(req)).apiHash || '';
      const phone = text(body.phone).replace(/[\s()-]/g, '');
      if (!Number.isInteger(apiId) || apiId <= 0) throw new TelegramError('Enter the api_id from my.telegram.org');
      if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new TelegramError('Enter the api_hash from my.telegram.org (32 characters)');
      if (!/^\+?\d{6,16}$/.test(phone)) throw new TelegramError('Enter the phone number of account 1 with the country code');
      dropLogin(owner(req));
      const client = makeClient('', apiId, apiHash);
      await client.connect();
      try {
        const sent = await client.sendCode({ apiId, apiHash }, phone);
        const login = { client, apiId, apiHash, phone, phoneCodeHash: sent.phoneCodeHash, step: 'code' };
        login.timer = timers.setTimeout(() => dropLogin(owner(req)), LOGIN_TTL_MS);
        logins.set(owner(req), login);
        res.json({ ...status(store.read(owner(req)), owner(req)), codeVia: sent.isCodeViaApp ? 'app' : 'sms' });
      } catch (failure) { quietly(client.disconnect()); throw failure; }
    }));
    router.post('/verify', wrap(async (req, res) => {
      const login = logins.get(owner(req));
      if (!login || login.step !== 'code') throw new TelegramError('Start the login first', 409);
      const phoneCode = text(req.body && req.body.code).replace(/\s/g, '');
      if (!/^\d{3,10}$/.test(phoneCode)) throw new TelegramError('Enter the code');
      const { Api } = loadGram();
      try {
        const result = await login.client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode }));
        if (result && result.className === 'auth.AuthorizationSignUpRequired') { dropLogin(owner(req)); throw new TelegramError('This phone number has no Telegram account'); }
      } catch (failure) {
        if (code(failure) !== 'SESSION_PASSWORD_NEEDED') throw failure;
        login.step = 'password';
        return res.json(status(store.read(owner(req)), owner(req)));
      }
      await finish(req, login);
      res.json(status(store.read(owner(req)), owner(req)));
    }));
    router.post('/password', wrap(async (req, res) => {
      const login = logins.get(owner(req));
      if (!login || login.step !== 'password') throw new TelegramError('Start the login first', 409);
      const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
      if (!password) throw new TelegramError('Enter the two-step verification password');
      const gram = loadGram();
      const info = await login.client.invoke(new gram.Api.account.GetPassword());
      const check = await gram.password.computeCheck(info, password);
      await login.client.invoke(new gram.Api.auth.CheckPassword({ password: check }));
      await finish(req, login);
      res.json(status(store.read(owner(req)), owner(req)));
    }));
    router.post('/cancel', (req, res) => { dropLogin(owner(req)); res.json(status(store.read(owner(req)), owner(req))); });
    router.post('/logout', wrap(async (req, res) => {
      dropLogin(owner(req));
      const config = store.read(owner(req));
      if (config.session) {
        // Ends the session on Telegram too (best effort), then forgets it here.
        try {
          const client = await clientFor(config);
          await client.invoke(new (loadGram().Api.auth.LogOut)());
        } catch { /* the saved copy is removed anyway */ }
        closeClient(config.session);
      }
      store.clear(owner(req));
      res.json(status({}, owner(req)));
    }));
    // Account 2 (a username or a numeric id) and the ring time.
    router.put('/config', wrap(async (req, res) => {
      const body = req.body || {};
      const config = store.read(owner(req));
      const next = { ...config };
      if (body.callSeconds !== undefined) {
        const seconds = Number(body.callSeconds);
        if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) throw new TelegramError('The ring time must be 5 to 120 seconds');
        next.callSeconds = seconds;
      }
      if (body.target !== undefined) {
        const input = text(body.target).replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
        if (!input) delete next.target;
        else {
          if (!config.session) throw new TelegramError('Log in to Telegram first', 409);
          if (!/^(\d{1,20}|[A-Za-z][A-Za-z0-9_]{3,31})$/.test(input)) throw new TelegramError('Enter a Telegram username or a numeric user id');
          const gram = loadGram();
          const client = await clientFor(config);
          // A numeric id is only known to this session after it saw the user, so the dialogs are read first.
          if (/^\d+$/.test(input)) await client.getDialogs({ limit: 200 });
          let user;
          try { user = await client.getEntity(/^\d+$/.test(input) ? gram.helpers.returnBigInt(input) : input); }
          catch (failure) {
            if (/^\d+$/.test(input) && !code(failure)) throw new TelegramError('Account 1 does not know this user id yet: send it a message first, or use the username');
            throw failure;
          }
          if (!user || user.className !== 'User') throw new TelegramError('The target must be a Telegram user');
          if (user.self) throw new TelegramError('The target must be another account than account 1');
          next.target = { input, id: String(user.id), accessHash: String(user.accessHash), username: user.username || '', name: [user.firstName, user.lastName].filter(Boolean).join(' ') };
        }
      }
      store.write(owner(req), next);
      res.json(status(next, owner(req)));
    }));
  }

  return {
    name: 'telegram',
    label: 'Telegram',
    configFields: [
      { key: 'target', label: 'Account 2 (username or user id)', type: 'text' },
      { key: 'callSeconds', label: 'Ring time (seconds)', type: 'number', default: DEFAULT_CALL_SECONDS },
    ],
    modes: ['message', 'call', 'off'],
    ready, notify, test, status, routes,
    close() { for (const owner of [...logins.keys()]) dropLogin(owner); for (const session of [...clients.keys()]) closeClient(session); },
  };
}

module.exports = createTelegramNotifier();
module.exports.createTelegramNotifier = createTelegramNotifier;
module.exports.messageText = messageText;
module.exports.MESSAGE_MAX = MESSAGE_MAX;
module.exports.explain = explain;
module.exports.dhHash = dhHash;

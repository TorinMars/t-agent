// T-Attention notifier: Telegram user account 1 -> user account 2 over the MTProto user API (npm package `telegram`, gramjs).
// Account 1 logs in from Settings with api_id and api_hash, then either a QR code scanned in the Telegram app of account 1 (auth.exportLoginToken,
// see "QR login" below) or the phone number and code; both may end with the 2FA password. Its session string and api_hash are
// stored encrypted by services/attention-notify.js and are never logged or sent to the browser. A session string is full access
// to account 1. Account 2 (the target) gets the messages and the calls.
// A call is only a ring: phone.requestCall with the Diffie-Hellman g_a_hash Telegram needs, then phone.discardCall after N seconds
// or as soon as it is answered or declined. No audio is set up.
const crypto = require('crypto');

const LOGIN_TTL_MS = 10 * 60 * 1000; // a started login waits at most 10 minutes for the code / password
const IDLE_MS = 10 * 60 * 1000; // a connected client for notifications is closed after 10 idle minutes
const DEFAULT_CALL_SECONDS = 30;
const NETWORK_TIMEOUT_MS = 20 * 1000; // connecting to Telegram, or one QR token export, gives up after this long
const PROXY_TIMEOUT_SECONDS = 10; // one attempt to open a connection through the SOCKS proxy
const UNREACHABLE = 'Cannot reach Telegram. Check the network or set ALL_PROXY to a SOCKS proxy for the T-Agent service, then try again';
const STATUS_LABELS = { waiting_user: 'Needs you', review: 'Review', failed: 'Failed', working: 'Working', todo: 'To do', done: 'Done', cancelled: 'Cancelled' };

class TelegramError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'NotifyError'; this.statusCode = statusCode; }
}

const text = value => (typeof value === 'string' ? value.trim() : '');
const code = error => String((error && error.errorMessage) || '');
// The browser and the logs only get the Telegram error code (upper case letters), never the raw error object.
function explain(error) {
  if (error instanceof TelegramError) return error.message;
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
// The SOCKS proxy for gramjs from the environment, or null to connect directly. gramjs ignores the proxy variables and speaks only SOCKS and
// MTProxy, so an http:// proxy cannot be used; it is skipped like a malformed value. The result may hold credentials: never log or return it.
const SOCKS_TYPES = { socks: 5, socks5: 5, socks5h: 5, socks4: 4, socks4a: 4 };
function parseSocksProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const socksType = SOCKS_TYPES[url.protocol.slice(0, -1).toLowerCase()];
    const ip = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port === '' ? 1080 : Number(url.port); // 1080 is the usual SOCKS port, as in curl
    if (!socksType || !ip || !port) return null;
    const proxy = { ip, port, socksType, timeout: PROXY_TIMEOUT_SECONDS };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch { return null; }
}
function proxyFromEnv(env) {
  for (const name of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    const proxy = parseSocksProxy(env[name]);
    if (proxy) return proxy;
  }
  return null;
}
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length < 5 ? '' : `+${digits.slice(0, 2)}${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-2)}`;
}

// The message for one item: a compact card that says what it is, what it needs, what changed and where it is. cardOf() cleans and cuts every value
// first and renderCard() draws the same card in one of two formats: messageHtml (Telegram HTML, what is sent) and messageText (plain text, the
// fallback when Telegram refuses the entities). Values are cut before they are escaped, so an entity or a tag is never cut in half, and every value
// from users or the agent is escaped, so '<b>', '&amp;' or Markdown marks in it stay literal text. Control and direction characters are removed.
// MESSAGE_MAX is the visible length (Telegram allows 4096 UTF-16 units after parsing). It is shared out section by section: the header, the link, the
// call-failed note and the footer are reserved first, so a long body can never push them out. Only http(s) links are used, and a link is never cut.
const MESSAGE_MAX = 2000;
const LINK_MAX = 1000;
const FILES_SHOWN = 3;
const SECTION_MIN = 8; // less room than this: the section is left out rather than shown as a stub
const GROUP_GAPS = 5; // the blank lines between the groups of the card
const LINK_LABEL = 'Open in T-Agent';
const STATUS_EMOJI = { waiting_user: '\u{1F64B}', review: '\u{1F440}', failed: '\u274c', working: '\u23f3', todo: '\u{1F4DD}', done: '\u2705', cancelled: '\u{1F6AB}' };
const OTHER_STATUS_EMOJI = '\u{1F514}';
const oneLine = (value, max) => cut(String(value || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
const lines = (value, max) => cut(String(value || '').split(/\r?\n/).map(line => oneLine(line, max)).filter(Boolean).join('\n'), max);
// Never leaves half of a surrogate pair (an emoji) at the end.
function cut(value, max) {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/.test(value[max - 2] || '') ? max - 2 : max - 1;
  return `${value.slice(0, Math.max(0, end)).trimEnd()}\u2026`;
}
function contextOf(item) {
  let context = item && item.context;
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = null; } }
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}
// The end of a long path is the part that names the file.
const shortPath = (value, max) => { const path = oneLine(value, Infinity); return path.length > max ? `\u2026${path.slice(1 - max).replace(/^[\udc00-\udfff]/, '')}` : path; };
const httpLink = value => {
  try {
    const url = new URL(String(value || '').trim());
    return /^https?:$/.test(url.protocol) && url.href.length <= LINK_MAX ? url.href : '';
  } catch { return ''; }
};
const count = value => (Number.isFinite(value) ? value : 0);
function changedFiles(context) {
  const files = (Array.isArray(context.files) ? context.files : []).filter(file => file && typeof file === 'object' && oneLine(file.path, 1));
  if (!files.length) return { changed: '', paths: [], more: '' };
  const added = files.reduce((sum, file) => sum + count(file.added), 0);
  const deleted = files.reduce((sum, file) => sum + count(file.deleted), 0);
  const counted = files.some(file => Number.isFinite(file.added) || Number.isFinite(file.deleted));
  return {
    changed: `${files.length} ${files.length === 1 ? 'file' : 'files'}${counted ? `, +${added} -${deleted}` : ''}`,
    paths: files.slice(0, FILES_SHOWN).map(file => shortPath(file.path, 100)),
    more: files.length > FILES_SHOWN ? `and ${files.length - FILES_SHOWN} more` : '',
  };
}
// The values of the card, cleaned and cut to fit MESSAGE_MAX. `fit` is called in order of importance, which is not the order they are shown in.
// `origin` ({ name }): the linked device the item belongs to, when another device relayed it here (services/attention-relay.js): a "From <name>" line.
function cardOf({ item, link, reason, error, origin }) {
  const context = contextOf(item);
  const pending = context.pending && typeof context.pending === 'object' ? context.pending : null;
  const status = STATUS_LABELS[item.status] || oneLine(item.status, 30) || 'Update';
  const title = oneLine(item.title, 200);
  const emoji = STATUS_EMOJI[item.status] || OTHER_STATUS_EMOJI;
  const href = httpLink(link);
  const note = reason === 'call_failed' ? `(A call was not possible: ${oneLine(error || 'unknown error', 200)})` : '';
  const fromName = origin && typeof origin === 'object' ? oneLine(origin.name, 60) : '';
  const from = fromName ? `From ${fromName}` : '';
  let left = MESSAGE_MAX - GROUP_GAPS - (emoji.length + 1 + status.length + 3 + title.length) - (from ? from.length + 1 : 0) - (note ? note.length + 1 : 0) - (href ? LINK_LABEL.length + 2 + href.length + 1 : 0);
  const fit = (value, extra = 0) => {
    if (!value) return '';
    const room = left - extra - 1;
    if (room < SECTION_MIN) return '';
    const out = cut(value, room);
    left -= out.length + extra + 1;
    return out;
  };
  const where = [['code', oneLine(context.cwd, 120)], ['code', oneLine(context.branch, 60)], ['text', oneLine(context.host, 40)], ['text', oneLine(item.source, 30)]]
    .map(([kind, value]) => ({ kind, value: fit(value, 3) })).filter(part => part.value);
  const needs = pending ? fit(oneLine(pending.text, 300), 7) : '';
  const command = pending ? fit(lines(pending.command, 300)) : '';
  const why = oneLine(item.attention_reason, 300);
  const reasonText = why && why !== oneLine(pending && pending.text, 300) ? fit(why, 8) : '';
  const asked = fit(oneLine(context.latest_prompt, 160), 11);
  const summary = context.summary && typeof context.summary === 'object' ? lines(context.summary.text, 400) : '';
  const lastReply = typeof context.last_reply === 'string' ? lines(context.last_reply.split(/\r?\n/).filter(line => line.trim()).slice(0, 3).join('\n'), 300) : '';
  const quote = fit(summary || lastReply);
  const files = changedFiles(context);
  const changed = fit(files.changed, 9);
  const paths = changed ? files.paths.map(path => fit(path, 2)).filter(Boolean) : [];
  const more = changed ? fit(files.more) : '';
  return { emoji, status, title, from, needs, command, reason: reasonText, asked, quote, changed, paths, more, note, where, href };
}
function renderCard(card, format) {
  const { text: plain, bold, italic, pre, quote, code: mono, link } = format;
  const where = card.where.map(part => (part.kind === 'code' ? mono(part.value) : plain(part.value))).join(' \u00b7 ');
  const groups = [
    [`${card.emoji} ${bold(card.status)}${card.title ? ` \u00b7 ${bold(card.title)}` : ''}`, card.from && plain(card.from)],
    [card.needs && `${bold('Needs:')} ${plain(card.needs)}`, card.command && pre(card.command), card.reason && `${bold('Reason:')} ${plain(card.reason)}`],
    [card.asked && `${bold('You asked:')} ${plain(card.asked)}`, card.quote && quote(card.quote)],
    [card.changed && `${bold('Changed:')} ${plain(card.changed)}`, ...card.paths.map(path => `\u2022 ${plain(path)}`), card.more && plain(card.more)],
    [card.note && italic(card.note)],
    [where, card.href && link(card.href)],
  ];
  return groups.map(group => group.filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}
const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = value => escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// gramjs reads a link whose address holds '+' or 'tg://user?id=<n>' as a mention, looks it up and drops the link when that fails (client/messageParse.js).
// Such an address is shown as text instead, because rewriting it could change what it means.
const READ_AS_MENTION = /\+|tg:\/\/user\?id=\d/;
const tag = name => value => `<${name}>${escapeHtml(value)}</${name}>`;
const HTML_FORMAT = {
  text: escapeHtml, bold: tag('b'), italic: tag('i'), pre: tag('pre'), quote: tag('blockquote'), code: tag('code'),
  link: href => (READ_AS_MENTION.test(href) ? `${LINK_LABEL}: ${escapeHtml(href)}` : `<a href="${escapeAttribute(href)}">${LINK_LABEL}</a>`),
};
const same = value => value;
const PLAIN_FORMAT = { text: same, bold: same, italic: same, pre: same, quote: same, code: same, link: href => `Open: ${href}` };
const messageHtml = input => renderCard(cardOf(input), HTML_FORMAT);
const messageText = input => renderCard(cardOf(input), PLAIN_FORMAT);
// Telegram's answers that say the formatting of the message was refused: a plain copy can still be delivered. Other errors are not retried.
const FORMAT_REFUSED = /^(ENTITY_|ENTITIES_|MESSAGE_EMPTY$|MESSAGE_TOO_LONG$)/;
// What "Test message" in Settings sends: the real card with realistic content, so the format can be seen.
const SAMPLE_ITEM = {
  status: 'waiting_user', title: 'Test message', attention_reason: 'This is a test from Settings; the details below are sample data', source: 'claude',
  context: {
    pending: { kind: 'permission', text: 'Claude wants to run a command', tool: 'Bash', command: 'npm test -- --watch' },
    latest_prompt: 'Fix the failing login test', cwd: '/home/me/work/app', branch: 'fix/login', host: 'my-laptop',
    summary: { text: 'Doing: fixing the login test\nProgress: the cause is found\nNeeds: approval to run the tests' },
    files: [{ path: 'src/login.js', added: 30, deleted: 5 }, { path: 'src/session.js', added: 8, deleted: 2 }, { path: 'test/login.test.js', added: 3, deleted: 0 }, { path: 'README.md', added: 1, deleted: 0 }],
  },
};

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

// options: loadGram() -> the `telegram` module (tests pass a mock), timers, randomBytes, env (default process.env, for the proxy).
function createTelegramNotifier(options = {}) {
  const loadGram = options.loadGram || (() => require('telegram'));
  const timers = options.timers || { setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); if (handle.unref) handle.unref(); return handle; }, clearTimeout };
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const renderQr = options.renderQr || (url => require('qrcode').toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  const logins = new Map(); // owner -> { client, apiId, apiHash, phone, phoneCodeHash, step, timer }
  const clients = new Map(); // session string -> { client, ready, idle }
  const qrEnded = new Map(); // owner -> 'done' | 'expired': how the last QR login ended, for /qr/status after it is gone

  function makeClient(session, apiId, apiHash) {
    const gram = loadGram();
    const proxy = proxyFromEnv(env);
    return new gram.TelegramClient(new gram.sessions.StringSession(session || ''), Number(apiId), apiHash, {
      connectionRetries: 3, floodSleepThreshold: 0, deviceModel: 'T-Attention', appVersion: '1.0', baseLogger: new gram.Logger('none'),
      ...(proxy ? { proxy } : {}),
    });
  }
  const quietly = promise => Promise.resolve(promise).catch(() => {});
  // Ends a gramjs client for good. disconnect() is not enough: gramjs's update loop keeps running until destroy(), and neither of them closes a
  // socket that is still connecting (Connection.disconnect returns early) or ends the retry loop of MTProtoSender.connect. So: no more attempts,
  // destroy(), and close the socket in flight. _sender, _retries and _connection are private to gramjs (the version is pinned in package.json).
  function stopClient(client) {
    const sender = client._sender;
    if (sender) sender._retries = 0;
    quietly(client.destroy());
    const socket = sender && sender._connection && sender._connection.socket;
    if (socket) quietly(socket.close());
  }
  // Rejects when the promise takes too long. A late answer is ignored: the caller has already failed.
  function limited(promise) {
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => reject(new TelegramError(UNREACHABLE, 504)), NETWORK_TIMEOUT_MS);
      Promise.resolve(promise).then(
        value => { timers.clearTimeout(timer); resolve(value); },
        failure => { timers.clearTimeout(timer); reject(failure); },
      );
    });
  }
  // gramjs answers false, without an error, when all its attempts failed. On any failure the client is stopped; if it connects after the
  // timeout after all, it is stopped again, because only then can its socket be closed.
  async function connectClient(client) {
    const attempt = Promise.resolve(client.connect());
    try {
      if (await limited(attempt) === false) throw new TelegramError(UNREACHABLE, 504);
      return client;
    } catch (failure) {
      stopClient(client);
      quietly(attempt.then(() => stopClient(client)));
      throw failure;
    }
  }
  function dropLogin(owner) {
    const login = logins.get(owner);
    if (!login) return;
    timers.clearTimeout(login.timer);
    logins.delete(owner);
    login.dropped = true; // an export still under way must not finish this login
    if (login.kind === 'qr' && login.step !== 'done') qrEnded.set(owner, 'expired');
    stopClient(login.client);
  }
  // The connected client for a saved session, reused while notifications come in.
  async function clientFor(config) {
    let entry = clients.get(config.session);
    if (!entry) {
      const client = makeClient(config.session, config.apiId, config.apiHash);
      entry = { client, ready: connectClient(client) };
      clients.set(config.session, entry);
      entry.ready.catch(() => { timers.clearTimeout(entry.idle); if (clients.get(config.session) === entry) clients.delete(config.session); });
    }
    timers.clearTimeout(entry.idle);
    entry.idle = timers.setTimeout(() => { if (clients.get(config.session) === entry) clients.delete(config.session); stopClient(entry.client); }, IDLE_MS);
    return entry.ready;
  }
  function closeClient(session) {
    const entry = clients.get(session);
    if (!entry) return;
    clients.delete(session);
    timers.clearTimeout(entry.idle);
    quietly(entry.ready.then(stopClient));
  }
  const peerOf = (gram, target) => new gram.Api.InputPeerUser({ userId: gram.helpers.returnBigInt(target.id), accessHash: gram.helpers.returnBigInt(target.accessHash) });
  const userOf = (gram, target) => new gram.Api.InputUser({ userId: gram.helpers.returnBigInt(target.id), accessHash: gram.helpers.returnBigInt(target.accessHash) });
  const ready = config => Boolean(config && config.session && config.apiHash && config.apiId && config.target && config.target.id);

  // Sends the card as Telegram HTML. If Telegram refuses the entities, it is sent once more as plain text, so a notification is not lost.
  async function sendMessage(config, input, log) {
    const gram = loadGram();
    const client = await clientFor(config);
    const peer = peerOf(gram, config.target);
    try {
      await client.sendMessage(peer, { message: messageHtml(input), linkPreview: false, parseMode: 'html' });
    } catch (failure) {
      if (!FORMAT_REFUSED.test(code(failure))) throw failure;
      if (log) log('warn', `formatted message refused (${code(failure)}), sending plain text`);
      await client.sendMessage(peer, { message: messageText(input), linkPreview: false, parseMode: false });
    }
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
  async function notify({ item, reason, mode, config, log, link, error, origin }) {
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
    try { await sendMessage(config, { item, link, reason, error, origin }, log); return { outcome: 'sent' }; }
    catch (failure) { throw new TelegramError(explain(failure), 502); }
  }
  async function test(config, { kind = 'message', link = '', log, origin } = {}) {
    if (!ready(config)) throw new TelegramError('Log in and choose account 2 first', 409);
    try {
      if (kind === 'call') return { ok: true, outcome: await ring(config, callSeconds(config)) };
      await sendMessage(config, { item: SAMPLE_ITEM, link, origin }, log);
      return { ok: true, outcome: 'sent' };
    } catch (failure) { throw new TelegramError(explain(failure), 502); }
  }
  // The settings page and the plugin overview read this. `configured` and `summary` are the overview hook (see plugins/README.md):
  // the summary names the accounts with the phone masked and never holds the session string, the api_hash or the api_id.
  function overviewSummary(config) {
    if (!config.session) return 'Not logged in';
    const account = config.account || {};
    const phone = /\*/.test(String(config.phone || '')) ? String(config.phone) : maskPhone(config.phone);
    const who = account.name || (account.username ? `@${account.username}` : 'account 1');
    const target = config.target
      ? `account 2 ${config.target.name || (config.target.username ? `@${config.target.username}` : config.target.input || '')}`.trim()
      : 'account 2 not chosen';
    return `Logged in as ${oneLine(who, 80)}${phone ? ` (${phone})` : ''} \u2192 ${oneLine(target, 100)}`;
  }
  function status(config, owner) {
    const login = owner !== undefined ? logins.get(owner) : null;
    return {
      configured: ready(config), summary: overviewSummary(config),
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
      if (login.dropped) return;
      const config = store.read(owner(req));
      if (config.session && config.session !== client.session.save()) closeClient(config.session);
      const account = { id: String(me.id), name: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username || '' };
      store.write(owner(req), { ...config, apiId: login.apiId, apiHash: login.apiHash, session: client.session.save(), phone: maskPhone(login.phone || me.phone), account });
      timers.clearTimeout(login.timer);
      login.step = 'done';
      if (logins.get(owner(req)) === login) logins.delete(owner(req));
      if (login.kind === 'qr') qrEnded.set(owner(req), 'done');
      stopClient(client);
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
      await connectClient(client);
      try {
        const sent = await client.sendCode({ apiId, apiHash }, phone);
        const login = { client, apiId, apiHash, phone, phoneCodeHash: sent.phoneCodeHash, step: 'code' };
        login.timer = timers.setTimeout(() => dropLogin(owner(req)), LOGIN_TTL_MS);
        logins.set(owner(req), login);
        res.json({ ...status(store.read(owner(req)), owner(req)), codeVia: sent.isCodeViaApp ? 'app' : 'sms' });
      } catch (failure) { stopClient(client); throw failure; }
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

    // ---- QR login ----
    // auth.exportLoginToken gives a token for tg://login?token=<base64url>, valid about 30 seconds. The app of account 1 scans it and accepts it,
    // Telegram sends UpdateLoginToken, and the next export returns auth.LoginTokenSuccess, or auth.LoginTokenMigrateTo when account 1 lives on
    // another data center: then the client switches to that DC and imports the token there. SESSION_PASSWORD_NEEDED moves to the password step.
    // A token is exported again when it expired or when the update came; the page polls /qr/status every 2 seconds and gets the current QR.
    const loginUrl = token => `tg://login?token=${Buffer.from(token).toString('base64url')}`;
    async function applyToken(req, login, result) {
      if (login.dropped) return; // the answer came after the timeout or a cancel
      const { Api } = loadGram();
      let answer = result;
      if (answer && answer.className === 'auth.LoginTokenMigrateTo') {
        await login.client._switchDC(answer.dcId);
        if (login.dropped) { stopClient(login.client); return; } // the switch connected it again
        answer = await login.client.invoke(new Api.auth.ImportLoginToken({ token: answer.token }));
      }
      if (answer && answer.className === 'auth.LoginTokenSuccess') { await finish(req, login); return; }
      if (!answer || answer.className !== 'auth.LoginToken') throw new TelegramError('Telegram sent an unexpected answer; start the login again', 502);
      login.url = loginUrl(answer.token);
      login.svg = await renderQr(login.url);
      login.expiresAt = Number(answer.expires) * 1000;
      login.scanned = false;
    }
    async function exportToken(req, login) {
      const { Api } = loadGram();
      try {
        const result = await login.client.invoke(new Api.auth.ExportLoginToken({ apiId: login.apiId, apiHash: login.apiHash, exceptIds: [] }));
        await applyToken(req, login, result);
      } catch (failure) {
        if (code(failure) !== 'SESSION_PASSWORD_NEEDED') throw failure;
        login.step = 'password';
        login.url = ''; login.svg = '';
      }
    }
    // One export at a time per login, so overlapping polls do not ask Telegram twice.
    function refresh(req, login) {
      if (!login.pending) login.pending = limited(exportToken(req, login)).finally(() => { login.pending = null; });
      return login.pending;
    }
    function qrAnswer(req) {
      const login = logins.get(owner(req));
      const config = store.read(owner(req));
      if (!login || login.kind !== 'qr') return { ...status(config, owner(req)), step: (!login && qrEnded.get(owner(req))) || 'expired' };
      const answer = { ...status(config, owner(req)), step: login.step };
      if (login.step === 'qr') Object.assign(answer, { url: login.url, svg: login.svg, expiresAt: new Date(login.expiresAt).toISOString() });
      return answer;
    }
    router.post('/qr/start', wrap(async (req, res) => {
      const body = req.body || {};
      const apiId = Number(body.api_id);
      const apiHash = text(body.api_hash) || store.read(owner(req)).apiHash || '';
      if (!Number.isInteger(apiId) || apiId <= 0) throw new TelegramError('Enter the api_id from my.telegram.org');
      if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new TelegramError('Enter the api_hash from my.telegram.org (32 characters)');
      dropLogin(owner(req));
      qrEnded.delete(owner(req));
      const client = makeClient('', apiId, apiHash);
      await connectClient(client);
      const login = { kind: 'qr', client, apiId, apiHash, phone: '', step: 'qr', url: '', svg: '', expiresAt: 0, scanned: false, pending: null };
      login.onUpdate = update => { if (update && update.className === 'UpdateLoginToken') login.scanned = true; };
      client.addEventHandler(login.onUpdate);
      login.timer = timers.setTimeout(() => { if (logins.get(owner(req)) === login) dropLogin(owner(req)); }, LOGIN_TTL_MS);
      logins.set(owner(req), login);
      try { await refresh(req, login); }
      catch (failure) { if (logins.get(owner(req)) === login) { dropLogin(owner(req)); qrEnded.delete(owner(req)); } throw failure; }
      res.json(qrAnswer(req));
    }));
    router.get('/qr/status', wrap(async (req, res) => {
      const login = logins.get(owner(req));
      if (login && login.kind === 'qr' && login.step === 'qr' && (login.scanned || now() >= login.expiresAt - 1000)) {
        try { await refresh(req, login); }
        catch (failure) { if (logins.get(owner(req)) === login) dropLogin(owner(req)); throw failure; }
      }
      res.json(qrAnswer(req));
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
module.exports.messageHtml = messageHtml;
module.exports.MESSAGE_MAX = MESSAGE_MAX;
module.exports.explain = explain;
module.exports.dhHash = dhHash;
module.exports.maskPhone = maskPhone;
module.exports.proxyFromEnv = proxyFromEnv;
module.exports.NETWORK_TIMEOUT_MS = NETWORK_TIMEOUT_MS;
module.exports.UNREACHABLE = UNREACHABLE;

// The bridge to the T-Agent browser extension ("Browser extension" in docs/design/browser-extension.md; the extension itself is extensions/chrome/). It holds:
//  - pairing: a one-time code (8 characters of PAIR_ALPHABET, 5 minutes, single use, kept in memory only) that the extension's options page
//    trades for a token (POST /api/browser-ext/pair, routes/browser-ext.js). The token (`tab_` + 32 random bytes, base64url) is given out
//    once; only its SHA-256 is kept, in system_state `browser_ext_v1` (a JSON list of { browser_id, name, token_hash, created_at,
//    last_seen_at, version, user_agent }), so there is no schema change;
//  - the WebSocket /api/browser-ext/ws (server.js hands the upgrade here): this machine only, Origin chrome-extension://..., then a `hello`
//    with the token within 10 s, `welcome` back. Close codes: 4400 no or bad hello, 4401 bad or revoked token, 4408 silent for 60 s,
//    4409 replaced by a newer socket of the same browser, 4426 protocol not supported. Pings get pongs;
//  - commands: `{ type: 'cmd', id: 'c_<n>', method, params, timeout_ms }` to the extension, its `result` back, with a timeout of our own
//    (BROWSER_TIMEOUT) a little after the one we gave it; only the methods of METHODS are sent (METHOD_NOT_ALLOWED), to the browser
//    named by params.browser_id or else to the one that connected last (BROWSER_NOT_CONNECTED when there is none); a method or a newer
//    option (PARAM_FEATURES) the extension's hello does not list is refused with UNKNOWN_METHOD;
//  - events: tab.handed / tab.released / tab.closed / tab.used (kept as the last few per browser for the status), record.items and
//    record.stopped (services/browser-recordings.js, which redacts again before it writes);
//  - the care of T-Agent's tabs (services/browser-tab-care.js): which terminal used which tab, closed when the agent's turn ended, the terminal
//    closed or the tab sat idle ("Closing T-Agent's tabs" in docs/design/browser-extension.md); only for an extension that lists `close.auto`;
//  - the extension's own update: a hello from an unpacked extension older than extensions/chrome/manifest.json gets `{ type: 'reload' }`
//    ("The extension updates itself").
// Tokens, cookies and bodies are never logged; results are never logged or kept, and `raw: true` answers go only to the caller.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { redactDeep, redactUrl } = require('../lib/browser-redact');
const { createTabCare } = require('./browser-tab-care');

const MANIFEST = path.resolve(__dirname, '..', 'extensions', 'chrome', 'manifest.json');
// The version of the extension in this install's folder, read at each hello (a git update changes it without a restart).
function folderVersion() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version || null; } catch { return null; }
}
const versionParts = value => (/^\d+(\.\d+){0,3}$/.test(String(value || '')) ? String(value).split('.').map(Number) : null);
function newerVersion(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
const RELOAD_EVERY_MS = 10 * 60_000;
const RELOAD_TRIES = 3;

const KEY = 'browser_ext_v1';
const PROTOCOL = 1;
const TOKEN_PREFIX = 'tab_';
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // [A-HJ-NP-Z2-9], 32 characters
const PAIR_CODE_LENGTH = 8;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_BROWSERS = 20;
const RECENT_EVENTS = 20;
const SEEN_WRITE_MS = 60_000;
const CLOSE = { BAD_HELLO: 4400, UNAUTHORIZED: 4401, SILENT: 4408, REPLACED: 4409, PROTOCOL: 4426 };

// The v1 methods (contract section 3). The server sends exactly these names and nothing else.
const METHODS = Object.freeze([
  'tabs.list', 'tabs.open', 'tabs.close', 'tabs.navigate', 'tabs.activate',
  'page.snapshot', 'page.query', 'page.eval', 'page.wait', 'page.screenshot', 'page.console', 'page.fetch',
  'input.click', 'input.type', 'input.press', 'input.hover', 'input.scroll', 'input.select',
  'net.start', 'net.stop', 'net.list', 'net.get',
  'record.start', 'record.stop', 'debug.detach',
  // Added in extension 1.0.3: bring the tab of a T-Agent page to the front (the desktop window's Open session, routes/attention-widget.js). An older
  // extension does not list it in its hello, so command() answers UNKNOWN_METHOD and the caller falls back.
  'tabs.reveal',
]);
// Options newer than the method itself: param -> [the feature the extension must list in its hello, the tcli flag]. An extension before
// 1.0.4 sends no `features` and would ignore these params silently, so command() refuses them with UNKNOWN_METHOD and a message to reload
// the extension ("Recording" in docs/design/browser-extension.md).
const PARAM_FEATURES = Object.freeze({
  'tabs.open': { record: ['open.record', 'open --record'] },
  'record.start': {
    types: ['record.types', 'record start --types'],
    drop_other_types: ['record.types', 'record start --drop-other-types'],
    max_body_bytes: ['record.max_body', 'record start --max-body'],
  },
});
// Answers that the server redacts again unless the caller asked for `raw: true` (they carry headers, URLs and bodies).
const REDACT_AGAIN = new Set(['net.list', 'net.get', 'page.fetch']);

// HTTP statuses of the extension's error codes, for the relay (routes/browser-ext.js).
const EXTENSION_STATUS = {
  TAB_NOT_ALLOWED: 403, TAB_NOT_SCRIPTABLE: 403, TAB_NOT_FOUND: 404, REF_NOT_FOUND: 404, ELEMENT_NOT_FOUND: 404, REQUEST_NOT_FOUND: 404,
  ELEMENT_NOT_INTERACTABLE: 409, DEBUGGER_BUSY: 409, NOT_CAPTURING: 409, BAD_PARAMS: 400, UNKNOWN_METHOD: 400, EVAL_FAILED: 422, TIMEOUT: 504, INTERNAL: 502,
};

class BridgeError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}
const ERRORS = {
  BROWSER_NOT_CONNECTED: (message = 'No browser with the T-Agent extension is connected. Pair one in Settings → Tasks and files → Browser extension.') => new BridgeError('BROWSER_NOT_CONNECTED', message, 503),
  BROWSER_TIMEOUT: method => new BridgeError('BROWSER_TIMEOUT', `The browser did not answer ${method} in time`, 504),
  METHOD_NOT_ALLOWED: method => new BridgeError('METHOD_NOT_ALLOWED', `${String(method).slice(0, 64)} is not a browser method`, 400),
  PAIR_CODE_INVALID: () => new BridgeError('PAIR_CODE_INVALID', 'The pairing code is wrong, used or expired. Make a new one in T-Agent Settings.', 400),
  BROWSER_NOT_FOUND: () => new BridgeError('BROWSER_NOT_FOUND', 'There is no paired browser with this id', 404),
  INVALID_NAME: () => new BridgeError('INVALID_NAME', 'The name must be 1 to 60 characters on one line', 400),
  TOO_MANY_BROWSERS: () => new BridgeError('TOO_MANY_BROWSERS', `At most ${MAX_BROWSERS} browsers can be paired; remove one first`, 409),
  BAD_PARAMS: message => new BridgeError('BAD_PARAMS', message, 400),
};

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || /[\r\n\u0000-\u001f\u007f]/.test(name) || [...name].length > 60) return null;
  return name;
}

function createBrowserBridge({
  db,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  serverName = () => 'T-Agent',
  recordings = null,
  isLocal = req => require('../lib/terminal-relay-auth').fromThisMachine(req),
  helloTimeoutMs = 10_000,
  silenceMs = 60_000,
  pairCodeTtlMs = 5 * 60_000,
  defaultTimeoutMs = 30_000,
  maxTimeoutMs = 10 * 60_000,
  graceMs = 2_000,
  log = message => console.log(message),
  extensionVersion = folderVersion,
  tabCareOptions = {},
} = {}) {
  if (!db) throw new Error('createBrowserBridge needs db');
  // browser_id -> { version, at, tries }: the reload asked of an extension that reported `version`, at most once per RELOAD_EVERY_MS, and not
  // again after RELOAD_TRIES for the same version (its folder is not this one, so reloading does not help).
  const reloads = new Map();
  const care = createTabCare({
    close: (browserId, tabId) => command('tabs.close', { browser_id: browserId, tab_id: tabId, auto: true }),
    log,
    ...tabCareOptions,
  });
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const connections = new Map(); // browser_id -> connection
  const listeners = new Set();
  let pairCode = null; // { code, expiresAt }
  let seq = 0;

  // ── Store ──
  function readStore() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(KEY);
    if (!row) return [];
    try {
      const list = JSON.parse(row.value);
      return Array.isArray(list) ? list.filter(entry => isPlainObject(entry) && typeof entry.browser_id === 'string' && typeof entry.token_hash === 'string') : [];
    } catch { return []; }
  }
  function writeStore(list) {
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(KEY, JSON.stringify(list));
  }
  function updateEntry(browserId, change) {
    const list = readStore();
    const entry = list.find(item => item.browser_id === browserId);
    if (!entry) return null;
    Object.assign(entry, change);
    writeStore(list);
    return entry;
  }
  function findByToken(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const wanted = Buffer.from(hashToken(token), 'hex');
    return readStore().find(entry => {
      const stored = Buffer.from(entry.token_hash, 'hex');
      return stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted);
    }) || null;
  }

  // ── Pairing ──
  function makeCode() {
    const bytes = randomBytes(PAIR_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) code += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
    return code;
  }
  // A new code replaces the one before: only the newest code works.
  function createPairCode() {
    const code = makeCode();
    pairCode = { code, expiresAt: now() + pairCodeTtlMs };
    return { code, expires_at: new Date(pairCode.expiresAt).toISOString(), expires_in_seconds: Math.round(pairCodeTtlMs / 1000) };
  }
  const normalizeCode = value => (typeof value === 'string' ? value.toUpperCase().replace(/[\s-]+/g, '') : '');
  function pair({ code, name, version, user_agent: userAgent } = {}) {
    const given = normalizeCode(code);
    const live = pairCode && pairCode.expiresAt > now() ? pairCode : null;
    if (!live) pairCode = null;
    const match = live && given.length === live.code.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(live.code));
    if (!match) throw ERRORS.PAIR_CODE_INVALID();
    const list = readStore();
    if (list.length >= MAX_BROWSERS) throw ERRORS.TOO_MANY_BROWSERS();
    pairCode = null; // single use
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const browserId = `br_${randomBytes(6).toString('hex')}`;
    const at = new Date(now()).toISOString();
    list.push({
      browser_id: browserId, name: validName(name) || 'Chrome', token_hash: hashToken(token), created_at: at, last_seen_at: null,
      version: cleanText(version, 32) || null, user_agent: cleanText(userAgent, 300) || null,
    });
    writeStore(list);
    log(`Browser extension paired: ${validName(name) || 'Chrome'} (${browserId})`);
    return { token, browser_id: browserId, server_name: serverName() };
  }

  // ── Browsers ──
  function activeConnection() {
    let latest = null;
    for (const conn of connections.values()) if (!latest || conn.connectedAt > latest.connectedAt) latest = conn;
    return latest;
  }
  function describe(entry, active) {
    const conn = connections.get(entry.browser_id);
    return {
      browser_id: entry.browser_id, name: entry.name, version: (conn && conn.version) || entry.version || null,
      created_at: entry.created_at || null, last_seen_at: conn ? new Date(conn.lastMessageAt).toISOString() : entry.last_seen_at || null,
      online: Boolean(conn), active: Boolean(conn && active && conn === active),
      connected_at: conn ? new Date(conn.connectedAt).toISOString() : null,
      browser: conn ? conn.browser : null, user_agent: (conn && conn.browser.user_agent) || entry.user_agent || null,
      methods: conn && conn.methods ? conn.methods.size : null,
      recent_events: conn ? conn.recentEvents.slice() : [],
    };
  }
  function list() {
    const active = activeConnection();
    return readStore().map(entry => describe(entry, active));
  }
  function status() {
    const browsers = list();
    const active = browsers.find(browser => browser.active) || null;
    return { protocol: PROTOCOL, connected: Boolean(active), active_browser_id: active ? active.browser_id : null, browsers, methods: METHODS.slice(), extension_version: extensionVersion() };
  }
  function rename(browserId, name) {
    const valid = validName(name);
    if (!valid) throw ERRORS.INVALID_NAME();
    if (!updateEntry(browserId, { name: valid })) throw ERRORS.BROWSER_NOT_FOUND();
    return describe(readStore().find(entry => entry.browser_id === browserId), activeConnection());
  }
  // Revokes the token: the entry goes, and an open socket of that browser is closed with 4401.
  function remove(browserId) {
    const entries = readStore();
    const next = entries.filter(entry => entry.browser_id !== browserId);
    if (next.length === entries.length) throw ERRORS.BROWSER_NOT_FOUND();
    writeStore(next);
    const conn = connections.get(browserId);
    if (conn) drop(conn, CLOSE.UNAUTHORIZED, 'Revoked', 'The browser was removed in T-Agent Settings');
    log(`Browser extension removed: ${browserId}`);
    return { removed: true, browser_id: browserId };
  }

  // ── Sockets ──
  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
  function rejectPending(conn, error) {
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      conn.pending.delete(id);
      pending.reject(error);
    }
  }
  // Ends a connection: its commands fail with BROWSER_NOT_CONNECTED, and it is no longer the one commands go to.
  function drop(conn, code, reason, message = 'The browser disconnected') {
    if (connections.get(conn.browserId) === conn) connections.delete(conn.browserId);
    clearTimeout(conn.silenceTimer);
    rejectPending(conn, ERRORS.BROWSER_NOT_CONNECTED(message));
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) conn.ws.close(code, reason);
  }

  function attach(ws) {
    let conn = null;
    const helloTimer = setTimeout(() => ws.close(CLOSE.BAD_HELLO, 'Hello expected'), helloTimeoutMs);
    ws.on('error', () => { /* the close event follows */ });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      clearTimeout(conn.silenceTimer);
      if (connections.get(conn.browserId) === conn) {
        connections.delete(conn.browserId);
        updateEntry(conn.browserId, { last_seen_at: new Date(conn.lastMessageAt).toISOString() });
        log(`Browser extension disconnected: ${conn.browserId}`);
      }
      rejectPending(conn, ERRORS.BROWSER_NOT_CONNECTED());
    });
    ws.on('message', (data, isBinary) => {
      let message = null;
      if (!isBinary) { try { message = JSON.parse(data.toString('utf8')); } catch { message = null; } }
      if (!conn) {
        clearTimeout(helloTimer);
        if (!isPlainObject(message) || message.type !== 'hello') { ws.close(CLOSE.BAD_HELLO, 'Hello expected'); return; }
        conn = hello(ws, message);
        return;
      }
      conn.lastMessageAt = now();
      armSilence(conn);
      if (!isPlainObject(message)) return;
      if (message.type === 'ping') {
        send(ws, { type: 'pong' });
        if (now() - conn.seenWrittenAt >= SEEN_WRITE_MS) {
          conn.seenWrittenAt = now();
          updateEntry(conn.browserId, { last_seen_at: new Date(conn.lastMessageAt).toISOString() });
        }
      } else if (message.type === 'result') onResult(conn, message);
      else if (message.type === 'event') onEvent(conn, message);
    });
  }

  function armSilence(conn) {
    clearTimeout(conn.silenceTimer);
    conn.silenceTimer = setTimeout(() => drop(conn, CLOSE.SILENT, 'Silent too long'), silenceMs);
  }

  function hello(ws, message) {
    const entry = findByToken(message.token);
    if (!entry) { ws.close(CLOSE.UNAUTHORIZED, 'Token not valid'); return null; }
    if (message.protocol !== PROTOCOL) { ws.close(CLOSE.PROTOCOL, `Protocol ${PROTOCOL} only`); return null; }
    const old = connections.get(entry.browser_id);
    const browser = isPlainObject(message.browser) ? message.browser : {};
    const conn = {
      ws, browserId: entry.browser_id, version: cleanText(message.version, 32) || null,
      browser: { name: cleanText(browser.name, 100) || null, user_agent: cleanText(browser.user_agent, 300) || null },
      methods: Array.isArray(message.methods) ? new Set(message.methods.filter(name => typeof name === 'string')) : null,
      features: new Set(Array.isArray(message.features) ? message.features.filter(name => typeof name === 'string').slice(0, 100) : []),
      connectedAt: now(), lastMessageAt: now(), seenWrittenAt: now(), pending: new Map(), recentEvents: [], silenceTimer: null,
    };
    connections.set(entry.browser_id, conn);
    if (old) drop(old, CLOSE.REPLACED, 'Replaced by a newer connection', 'The browser connected again; the old connection was closed');
    updateEntry(entry.browser_id, { last_seen_at: new Date(conn.connectedAt).toISOString(), ...(conn.version ? { version: conn.version } : {}) });
    armSilence(conn);
    send(ws, { type: 'welcome', protocol: PROTOCOL, server_name: serverName(), browser_id: entry.browser_id });
    log(`Browser extension connected: ${entry.name} (${entry.browser_id}, extension ${conn.version || '?'})`);
    conn.installType = cleanText(message.install_type, 32) || null;
    askReload(conn);
    if (conn.features.has('close.auto')) care.connected(entry.browser_id, Array.isArray(message.owned_tabs) ? message.owned_tabs : null);
    return conn;
  }

  // An unpacked extension (installType 'development') older than this install's folder is asked to reload itself; the extension reloads only
  // when the folder it runs from really holds a newer manifest. An older extension without `reload` in its features ignores the message.
  function askReload(conn) {
    const latest = extensionVersion();
    if (conn.installType !== 'development' || !latest || !newerVersion(latest, conn.version)) return;
    const last = reloads.get(conn.browserId);
    const same = last && last.version === conn.version && last.latest === latest;
    if (same && (now() - last.at < RELOAD_EVERY_MS || last.tries >= RELOAD_TRIES)) return;
    reloads.set(conn.browserId, { version: conn.version, latest, at: now(), tries: same ? last.tries + 1 : 1 });
    send(conn.ws, { type: 'reload', version: latest });
    log(`Browser extension ${conn.browserId} runs ${conn.version || '?'}; asked it to reload to ${latest}`);
  }

  function onResult(conn, message) {
    const pending = typeof message.id === 'string' ? conn.pending.get(message.id) : null;
    if (!pending) return; // late (timed out) or unknown
    clearTimeout(pending.timer);
    conn.pending.delete(message.id);
    pending.tab = isPlainObject(message.tab) ? message.tab : null;
    if (message.ok === true) { pending.resolve(isPlainObject(message.result) ? message.result : {}); return; }
    const error = isPlainObject(message.error) ? message.error : {};
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'EXTENSION_ERROR';
    const text = cleanText(error.message, 2000) || `The browser answered ${code}`;
    pending.reject(new BridgeError(code, text, EXTENSION_STATUS[code] || 502));
  }

  function onEvent(conn, message) {
    const name = typeof message.event === 'string' ? message.event : '';
    const data = isPlainObject(message.data) ? message.data : {};
    try {
      if (name === 'record.items') {
        if (recordings) recordings.append(data.recording_id, Array.isArray(data.items) ? data.items : [], { browser_id: conn.browserId });
      } else if (name === 'record.stopped') {
        if (recordings) recordings.stop(data.recording_id, { reason: cleanText(data.reason, 200) || 'stopped' });
      } else if (/^tab\.(handed|released|closed|used)$/.test(name)) {
        if (Number.isInteger(data.tab_id)) {
          if (name === 'tab.used' && data.kept === true) care.keep(conn.browserId, data.tab_id);
          else care.forget(conn.browserId, data.tab_id);
        }
        const entry = { at: new Date(now()).toISOString(), event: name, tab_id: Number.isInteger(data.tab_id) ? data.tab_id : null };
        if (typeof data.url === 'string') entry.url = redactUrl(data.url.slice(0, 2000));
        if (typeof data.title === 'string') entry.title = cleanText(data.title, 200);
        conn.recentEvents.push(entry);
        if (conn.recentEvents.length > RECENT_EVENTS) conn.recentEvents.shift();
      } else return;
    } catch (error) {
      log(`Browser extension event ${name} was not stored: ${error.code || error.message}`);
    }
    for (const listener of listeners) { try { listener(name, data, conn.browserId); } catch { /* a listener's own problem */ } }
  }

  // ── Commands ──
  function timeoutFor(method, params, requested) {
    let timeout = Number.isFinite(requested) && requested > 0 ? requested : defaultTimeoutMs;
    if (method === 'page.wait' && Number.isFinite(params.timeout_ms)) timeout = Math.max(timeout, params.timeout_ms + 5000);
    return Math.min(Math.max(Math.round(timeout), 1000), maxTimeoutMs);
  }

  // Sends one command and resolves with its result. `context`: { task_id, terminal_id } of the tcli call (recordings are tagged with it).
  function command(method, params = {}, { timeoutMs, context = {} } = {}) {
    if (typeof method !== 'string' || !METHODS.includes(method)) return Promise.reject(ERRORS.METHOD_NOT_ALLOWED(method));
    if (params === null || params === undefined) params = {};
    if (!isPlainObject(params)) return Promise.reject(ERRORS.BAD_PARAMS('params must be an object'));
    const { browser_id: wanted, ...rest } = params;
    let conn;
    if (wanted !== undefined) {
      conn = typeof wanted === 'string' ? connections.get(wanted) : null;
      if (!conn) return Promise.reject(ERRORS.BROWSER_NOT_CONNECTED(`The browser ${String(wanted).slice(0, 40)} is not connected`));
    } else conn = activeConnection();
    if (!conn) return Promise.reject(ERRORS.BROWSER_NOT_CONNECTED());
    if (conn.methods && !conn.methods.has(method)) {
      return Promise.reject(new BridgeError('UNKNOWN_METHOD', `The connected extension (version ${conn.version || '?'}) does not support ${method}; update it`, 400));
    }
    for (const [param, [feature, flag]] of Object.entries(PARAM_FEATURES[method] || {})) {
      if (rest[param] !== undefined && !conn.features.has(feature)) {
        return Promise.reject(new BridgeError('UNKNOWN_METHOD', `The extension is older than this command (version ${conn.version || '?'} does not support ${flag}): reload it in chrome://extensions`, 400));
      }
    }
    const timeout = timeoutFor(method, rest, timeoutMs);
    seq += 1;
    const id = `c_${seq}`;
    let entry;
    const sent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(ERRORS.BROWSER_TIMEOUT(method));
      }, timeout + graceMs);
      entry = { resolve, reject, timer, method, tab: null };
      conn.pending.set(id, entry);
      try { send(conn.ws, { type: 'cmd', id, method, params: rest, timeout_ms: timeout }); }
      catch (error) { clearTimeout(timer); conn.pending.delete(id); reject(ERRORS.BROWSER_NOT_CONNECTED()); }
    });
    return sent.then(result => afterResult(method, rest, result, conn, context, entry.tab), error => {
      try { noteCare(method, rest, null, conn, context, entry.tab, error); } catch (problem) { log(`Browser tab care: ${problem.message}`); }
      throw error;
    });
  }

  // The tab care: the tab a command used (the result's `tab` of an extension from 1.0.5, else the tab of tabs.open's answer) belongs to the
  // terminal that sent it; tabs.close forgets it. Only an extension that closes with `auto` (feature close.auto) is cared for.
  function noteCare(method, params, result, conn, context, used, error = null) {
    if (!conn.features.has('close.auto')) return;
    const tab = used || (result && isPlainObject(result.tab) ? result.tab : null);
    if (!tab || !Number.isInteger(tab.tab_id)) return;
    if (method === 'tabs.close') {
      if (!error || ['TAB_NOT_ALLOWED', 'TAB_NOT_FOUND'].includes(error.code)) care.forget(conn.browserId, tab.tab_id);
      return;
    }
    if (error && error.code === 'TAB_NOT_FOUND') { care.forget(conn.browserId, tab.tab_id); return; }
    care.noteTab(conn.browserId, tab.tab_id, { context, how: tab.how === 'handed' ? 'handed' : 'group', keep: tab.keep === true || (method === 'tabs.open' && params.keep === true) });
  }

  function afterResult(method, params, result, conn, context, used = null) {
    try { noteCare(method, params, result, conn, context, used); } catch (error) { log(`Browser tab care: ${error.message}`); }
    // record.start, and tabs.open with `record` (its tab is in result.tab).
    if (recordings && (method === 'record.start' || method === 'tabs.open') && typeof result.recording_id === 'string') {
      const tab = isPlainObject(result.tab) ? result.tab : result;
      try {
        recordings.start(result.recording_id, {
          tab_id: Number.isInteger(tab.tab_id) ? tab.tab_id : Number.isInteger(params.tab_id) ? params.tab_id : null,
          browser_id: conn.browserId, task_id: context.task_id ?? null, terminal_id: context.terminal_id ?? null, url: tab.url,
          options: isPlainObject(result.options) ? result.options : undefined,
        });
      } catch (error) { log(`Browser recording ${result.recording_id} was not registered: ${error.code || error.message}`); }
    }
    if (recordings && method === 'record.stop') {
      const id = typeof result.recording_id === 'string' ? result.recording_id : params.recording_id;
      try { recordings.stop(id, { reason: 'stopped' }); } catch { /* an unknown recording */ }
    }
    if (REDACT_AGAIN.has(method) && params.raw !== true) return redactDeep(result);
    return result;
  }

  // ── Upgrade (server.js) ──
  // This machine only (404, as the access gate answers), and only from an extension page (403).
  function handleUpgrade(req, socket, head) {
    if (!isLocal(req)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const origin = String(req.headers.origin || '');
    if (!origin.startsWith('chrome-extension://')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => attach(ws));
  }

  function onEventListener(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function closeAll() {
    care.stop();
    for (const conn of [...connections.values()]) drop(conn, 1001, 'Server stopping');
  }
  // routes/terminal.js through server.js: { task_id, terminal_id } of a terminal whose agent turn ended, or that was closed / restarted.
  const turnEnded = context => { try { care.turnEnded(context); } catch (error) { log(`Browser tab care: ${error.message}`); } };
  const terminalEnded = context => { try { care.terminalEnded(context); } catch (error) { log(`Browser tab care: ${error.message}`); } };

  return {
    createPairCode, pair, list, status, rename, remove, command, attach, handleUpgrade, onEvent: onEventListener, closeAll,
    connected: () => connections.size > 0, turnEnded, terminalEnded, tabCare: () => care.snapshot(),
  };
}

let shared = null;
function getBrowserBridge() {
  if (!shared) {
    shared = createBrowserBridge({
      db: require('../db'),
      recordings: require('./browser-recordings').getBrowserRecordings(),
      serverName: () => { try { return require('./engine-identity').getEngineIdentity().name || 'T-Agent'; } catch { return 'T-Agent'; } },
    });
  }
  return shared;
}

module.exports = { createBrowserBridge, getBrowserBridge, BridgeError, METHODS, PROTOCOL, CLOSE, PAIR_ALPHABET, TOKEN_PREFIX, MAX_FRAME_BYTES, EXTENSION_STATUS, hashToken, newerVersion, folderVersion };

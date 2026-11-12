// T-Attention: one Telegram sender for all linked devices. Only one device is logged in to Telegram and sends; the other linked devices make their
// own decisions (statuses, foreground, dedupe, quiet hours, a delayed call's wait) and then hand the final delivery to that device over the service link
// (POST /v1/attention/notify-relay on the sender). The same Telegram session used on two machines at once makes them push each other out, so a device
// that is not the sender never sends to Telegram itself, even when it is logged in too. See "One Telegram sender for linked devices" under "T-Attention notifiers" in DESIGN.md.
//
// The sender (resolve()):
//   1. the device named by the stored choice `telegram_sender` (system_state, { instance_id, updated_at }), when it is this device and Telegram is set
//      up here, or a linked device with the capability `notify:relay` that is not known to be without Telegram;
//   2. otherwise the devices where Telegram is set up (this one and the linked ones that report it): the one with the smallest instance id, so that
//      every device picks the same one without asking; with more than one the page asks the person to choose (`conflict`);
//   3. no device with Telegram: nobody; this device behaves as before (its own plugin, which is not set up, is skipped).
// The choice is set from Settings ("Use this device as the sender"), stored on every device and sent to the linked ones with PUT
// /v1/attention/notify-relay/sender; the newest `updated_at` wins. A device that was offline gets it when its link comes up (both sides compare). A
// peer's PUT is never sent on, so there is no loop. Linked devices without `notify:relay` (older versions) are never a sender and never told anything.
const express = require('express');

const CAPABILITY = 'notify:relay';
const ROUTE = '/v1/attention/notify-relay';
const RELAYED = new Set(['telegram']);
const STATE_KEY = 'telegram_sender';
const CACHE_MS = 60_000;
const RETRY_PROBE_MS = 15_000; // a peer that did not answer is asked again sooner
const PROBE_TIMEOUT_MS = 3_000;
const PUSH_TIMEOUT_MS = 5_000;
// A call rings up to 120 s on the sender, plus the time to reach Telegram.
const SEND_TIMEOUT_MS = { message: 45_000, call: 180_000 };
const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
// Failures that mean the sender could not be reached (as opposed to an answer from it).
const OFFLINE_CODES = new Set(['REMOTE_OFFLINE', 'REMOTE_TIMEOUT', 'REMOTE_CONNECTION_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE']);

const fault = (code, statusCode) => Object.assign(new Error(code), { statusCode });
const codeOf = error => {
  const text = String((error && (error.code || error.message)) || '');
  return /^[A-Z0-9_]{2,64}$/.test(text) ? text : 'RELAY_FAILED';
};

// A failure of one relay: `offline` when the sender could not be reached, else the sender answered with an error. `code` is a short upper-case code.
class RelayError extends Error {
  constructor(code, offline, statusCode = null) { super(code); this.name = 'RelayError'; this.code = code; this.offline = offline; this.statusCode = statusCode; }
}

// ---- What an item looks like on the wire ----
// Only the fields the Telegram card uses, each cut to a size the card never exceeds. Never the excerpt, the terminal ids or anything else of the context.
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const count = value => (Number.isFinite(value) ? Math.max(0, Math.min(1e9, Math.round(value))) : undefined);
const prune = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
function contextObject(value) {
  let context = value;
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = null; } }
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}
function relayItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const context = contextObject(source.context);
  const pending = context.pending && typeof context.pending === 'object' && !Array.isArray(context.pending)
    ? prune({ kind: text(context.pending.kind, 40), text: text(context.pending.text, 2000), tool: text(context.pending.tool, 100), command: text(context.pending.command, 4000) })
    : null;
  const summary = context.summary && typeof context.summary === 'object' && typeof context.summary.text === 'string' ? { text: context.summary.text.slice(0, 2000) } : null;
  const files = Array.isArray(context.files)
    ? context.files.filter(file => file && typeof file === 'object' && typeof file.path === 'string').slice(0, 50).map(file => prune({ path: file.path.slice(0, 1000), added: count(file.added), deleted: count(file.deleted) }))
    : [];
  const clean = prune({
    pending: pending && Object.keys(pending).length ? pending : null, cwd: text(context.cwd, 1000), branch: text(context.branch, 200), host: text(context.host, 200),
    latest_prompt: text(context.latest_prompt, 2000), summary, last_reply: text(context.last_reply, 4000), files: files.length ? files : null,
  });
  return {
    id: Number.isSafeInteger(source.id) && source.id >= 0 ? source.id : 0,
    title: text(source.title, 500) || '',
    status: text(source.status, 30) || '',
    source: text(source.source, 60) || null,
    attention_reason: text(source.attention_reason, 2000) || null,
    context: clean,
  };
}
const cleanLink = value => {
  if (typeof value !== 'string' || !value || value.length > 2000) return '';
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
};
const cleanChoice = value => {
  if (!value || typeof value !== 'object') return null;
  const id = value.instance_id === null ? null : (typeof value.instance_id === 'string' && INSTANCE_ID.test(value.instance_id) ? value.instance_id : undefined);
  if (id === undefined || !Number.isSafeInteger(value.updated_at) || value.updated_at < 0) return null;
  return { instance_id: id, updated_at: value.updated_at };
};

// options: db, notify (services/attention-notify.js: localReady(name), acceptRelay(input), relayTest(input)), serviceLinks (peers(), onChange(),
// linkForToken()), request (services/remote-client.js), identity() -> { instance_id, name }, readInfo(peer) -> /v1/info, now, log(level, message).
function createAttentionRelay(options) {
  const { db, serviceLinks, request } = options;
  const now = options.now || Date.now;
  const log = options.log || ((level, message) => (level === 'warn' ? console.warn : console.log)(`[attention-relay] ${message}`));
  const identity = options.identity;
  let notify = options.notify || null;
  const readInfo = options.readInfo || (peer => request(peer.baseUrl, '/v1/info', peer.token, { timeoutMs: PROBE_TIMEOUT_MS }));
  // Per link: { supported, ready, instanceId, choice, effective, at, failed, generation, pending }. The facts survive the link going offline.
  const cache = new Map();
  let unsubscribe = null;

  const me = () => { try { const value = identity() || {}; return { instance_id: String(value.instance_id || ''), name: String(value.name || '') }; } catch { return { instance_id: '', name: '' }; } };
  const localReady = name => { try { return Boolean(notify && notify.localReady(name)); } catch { return false; } };

  function readChoice() {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY);
    if (!row) return { instance_id: null, updated_at: 0 };
    try { return cleanChoice(JSON.parse(row.value)) || { instance_id: null, updated_at: 0 }; } catch { return { instance_id: null, updated_at: 0 }; }
  }
  function writeChoice(choice) {
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(STATE_KEY, JSON.stringify(choice));
    return choice;
  }
  // A choice from a peer (its PUT, or its status seen in a probe): kept only when it is newer. Answers what is stored.
  function acceptChoice(given) {
    const choice = cleanChoice(given);
    if (!choice) throw fault('INVALID_SENDER', 400);
    const current = readChoice();
    if (choice.updated_at > current.updated_at) {
      writeChoice(choice);
      log('info', `the Telegram sender changed (from a linked device): ${choice.instance_id ? 'set' : 'cleared'}`);
      return choice;
    }
    return current;
  }

  // ---- The linked devices ----
  const entryOf = id => {
    if (!cache.has(id)) cache.set(id, { supported: null, ready: null, instanceId: null, choice: null, effective: null, at: null, failed: false, generation: 0, pending: null });
    return cache.get(id);
  };
  const fresh = entry => entry.at !== null && now() - entry.at < (entry.failed ? RETRY_PROBE_MS : CACHE_MS);
  const peers = () => { try { return serviceLinks.peers(); } catch { return []; } };
  const idOf = peer => (cache.get(peer.id) && cache.get(peer.id).instanceId) || peer.instanceId || null;

  async function probe(peer) {
    const info = await readInfo(peer);
    if (!info || !Array.isArray(info.capabilities) || !info.capabilities.includes(CAPABILITY)) return { supported: false };
    const status = await request(peer.baseUrl, `${ROUTE}/status`, peer.token, { timeoutMs: PROBE_TIMEOUT_MS });
    const telegram = status && status.notifiers && status.notifiers.telegram;
    return {
      supported: true,
      instanceId: status && typeof status.instance_id === 'string' && INSTANCE_ID.test(status.instance_id) ? status.instance_id : null,
      ready: Boolean(telegram && telegram.ready === true),
      choice: cleanChoice(status && status.sender && status.sender.telegram),
      effective: status && status.effective && typeof status.effective.telegram === 'string' ? status.effective.telegram : null,
    };
  }
  // Both sides keep the newest choice: a newer one of the peer is taken, ours is sent when it is the newer one (a device that was offline catches up).
  function exchange(peer, theirs) {
    const ours = readChoice();
    if (theirs && theirs.updated_at > ours.updated_at) { acceptChoice(theirs); return; }
    if (ours.updated_at > 0 && (!theirs || ours.updated_at > theirs.updated_at)) void push(peer, ours);
  }
  // Never rejects. One probe per link at a time; a result for a link that changed meanwhile is dropped.
  function refresh(peer) {
    const entry = entryOf(peer.id);
    if (entry.pending) return entry.pending;
    const { generation } = entry;
    const current = () => cache.get(peer.id) === entry && entry.generation === generation;
    const work = probe(peer).then(found => {
      if (!current()) return;
      Object.assign(entry, { supported: found.supported, failed: false, at: now() });
      if (found.supported) {
        Object.assign(entry, { ready: found.ready, instanceId: found.instanceId || peer.instanceId || null, choice: found.choice, effective: found.effective });
        exchange(peer, found.choice);
      } else Object.assign(entry, { ready: null, choice: null, effective: null });
    }, error => {
      if (error && error.statusCode === 401) { try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next 401 tries again */ } }
      if (!current()) return;
      entry.failed = true;
      entry.at = now();
    }).finally(() => { if (entry.pending === work) entry.pending = null; });
    entry.pending = work;
    return work;
  }
  async function refreshStale() {
    await Promise.all(peers().filter(peer => peer.online && !fresh(entryOf(peer.id))).map(refresh));
  }

  // ---- Who sends ----
  // { self, peer, explicit, conflict, none }. Synchronous, from what is known now.
  function resolve(name = 'telegram') {
    const own = me();
    const ready = localReady(name);
    const linked = peers().map(peer => ({ peer, entry: entryOf(peer.id), id: idOf(peer) }));
    const capable = linked.filter(row => row.entry.supported === true);
    const choice = readChoice();
    if (choice.instance_id) {
      if (choice.instance_id === own.instance_id && ready) return { self: true, peer: null, explicit: true, conflict: false, none: false };
      // A linked device that was chosen: also while it was not asked yet (the choice came from it, or from a device that knew it), unless it is known
      // to be an older version or to have no Telegram.
      const chosen = linked.find(row => row.id === choice.instance_id);
      if (chosen && chosen.entry.supported !== false && chosen.entry.ready !== false) return { self: false, peer: chosen.peer, explicit: true, conflict: false, none: false };
    }
    const candidates = [...(ready ? [{ id: own.instance_id, peer: null }] : []), ...capable.filter(row => row.entry.ready === true && row.id).map(row => ({ id: row.id, peer: row.peer }))];
    if (!candidates.length) return { self: false, peer: null, explicit: false, conflict: false, none: true };
    candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const pick = candidates[0];
    return { self: pick.peer === null, peer: pick.peer, explicit: false, conflict: candidates.length > 1, none: false };
  }
  const effectiveId = name => {
    const sender = resolve(name);
    if (sender.none) return null;
    return sender.self ? me().instance_id : idOf(sender.peer);
  };

  // For attention-notify's deliver(): the linked device to relay to, or null to send here (this device is the sender, or nobody is). Waits for a
  // stale peer at most as long as one probe takes.
  async function target(name) {
    if (!RELAYED.has(name)) return null;
    await refreshStale();
    const sender = resolve(name);
    return sender.peer ? { peer: sender.peer, name: sender.peer.name } : null;
  }

  async function post(peer, path, body, timeoutMs) {
    if (!peer.online) throw new RelayError('REMOTE_OFFLINE', true);
    try {
      return await request(peer.baseUrl, `${ROUTE}${path}`, peer.token, { method: 'POST', body, timeoutMs });
    } catch (error) {
      const code = codeOf(error);
      if (error && error.statusCode === 401) { try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* best effort */ } }
      // The tunnel answers 502 REMOTE_OFFLINE when the peer is gone; any other status is the sender's own answer.
      const offline = OFFLINE_CODES.has(code) || !Number.isInteger(error && error.statusCode);
      if (code === 'NOT_SENDER') { const entry = entryOf(peer.id); entry.at = null; } // ask it again before the next relay
      throw new RelayError(code, offline, Number.isInteger(error && error.statusCode) ? error.statusCode : null);
    }
  }
  // One delivery to the sender: { outcome, detail? }. Throws a RelayError.
  async function send(peer, payload) {
    const answer = await post(peer, '', payload, SEND_TIMEOUT_MS[payload.mode] || SEND_TIMEOUT_MS.message);
    return {
      outcome: answer && typeof answer.outcome === 'string' && /^[a-z_]{1,40}$/.test(answer.outcome) ? answer.outcome : 'unknown',
      detail: answer && typeof answer.detail === 'string' ? answer.detail.slice(0, 200) : undefined,
    };
  }
  // The Settings test through the sender: { ok, outcome, message }.
  async function sendTest(peer, { notifier, kind }) {
    const answer = await post(peer, '/test', { notifier, kind }, SEND_TIMEOUT_MS[kind] || SEND_TIMEOUT_MS.message);
    return {
      ok: !(answer && answer.ok === false),
      outcome: answer && typeof answer.outcome === 'string' ? answer.outcome.slice(0, 40) : undefined,
      message: answer && typeof answer.message === 'string' ? answer.message.slice(0, 300) : undefined,
    };
  }

  // ---- The sender switch ----
  async function push(peer, choice) {
    if (!peer.online) return false;
    try {
      const answer = await request(peer.baseUrl, `${ROUTE}/sender`, peer.token, { method: 'PUT', body: { notifier: 'telegram', ...choice }, timeoutMs: PUSH_TIMEOUT_MS });
      const stored = cleanChoice(answer);
      const entry = entryOf(peer.id);
      if (stored) entry.choice = stored;
      if (stored && stored.updated_at > choice.updated_at) acceptChoice(stored); // the peer had a newer one
      entry.at = null; // its effective sender changed: ask again
      return true;
    } catch { return false; }
  }
  // "Use this device as the sender": stored here and sent to every linked device that can relay. Answers how many were told.
  async function useThisDevice() {
    if (!localReady('telegram')) throw Object.assign(new Error('Log in to Telegram on this device and choose account 2 first'), { name: 'NotifyError', statusCode: 409 });
    const current = readChoice();
    const choice = writeChoice({ instance_id: me().instance_id, updated_at: Math.max(now(), current.updated_at + 1) });
    log('info', 'this device is now the Telegram sender');
    const targets = peers().filter(peer => entryOf(peer.id).supported !== false);
    const results = await Promise.all(targets.map(peer => push(peer, choice)));
    return { told: results.filter(Boolean).length, offline: results.filter(ok => !ok).length };
  }

  // ---- The sender side ----
  // A relayed delivery from the linked device `link` (the record of the token's service link). The origin is the link, never what the body says.
  async function accept(link, body) {
    const given = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!RELAYED.has(given.notifier)) throw fault('UNKNOWN_NOTIFIER', 400);
    if (!['message', 'call'].includes(given.mode)) throw fault('INVALID_MODE', 400);
    if (!['status', 'still'].includes(given.reason)) throw fault('INVALID_REASON', 400);
    const item = relayItem(given.item);
    if (!item.status) throw fault('INVALID_ITEM', 400);
    const sender = resolve(given.notifier);
    if (!sender.self) throw fault('NOT_SENDER', 409);
    const origin = { instance_id: String(link.peer_instance_id || link.id), name: String(link.name || 'Linked service').slice(0, 80) };
    return notify.acceptRelay({ notifier: given.notifier, mode: given.mode, reason: given.reason, item, link: cleanLink(given.link), origin });
  }
  async function acceptTest(link, body) {
    const given = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!RELAYED.has(given.notifier)) throw fault('UNKNOWN_NOTIFIER', 400);
    const sender = resolve(given.notifier);
    if (!sender.self) throw fault('NOT_SENDER', 409);
    const origin = { instance_id: String(link.peer_instance_id || link.id), name: String(link.name || 'Linked service').slice(0, 80) };
    return notify.relayTest({ notifier: given.notifier, kind: given.kind === 'call' ? 'call' : 'message', origin });
  }
  // GET /v1/attention/notify-relay/status: what a linked device needs to choose. From what is known now, never a wait.
  function status() {
    return {
      instance_id: me().instance_id,
      notifiers: { telegram: { ready: localReady('telegram') } },
      sender: { telegram: readChoice() },
      effective: { telegram: effectiveId('telegram') },
    };
  }

  // ---- For the page (GET /api/attention-notify/config `relay`) ----
  // Never waits; a stale peer is asked again for the next read.
  const refreshInBackground = () => { for (const peer of peers()) if (peer.online && !fresh(entryOf(peer.id))) void refresh(peer); };
  function view(name = 'telegram') {
    refreshInBackground();
    const own = me();
    const sender = resolve(name);
    const linked = peers().filter(peer => entryOf(peer.id).supported === true);
    const relaying = sender.self
      ? linked.filter(peer => entryOf(peer.id).effective === own.instance_id).map(peer => ({ name: peer.name, online: Boolean(peer.online) }))
      : [];
    return {
      notifier: name,
      me: { name: own.name, ready: localReady(name) },
      linked: linked.length,
      sender: sender.none ? null : sender.self ? { name: own.name, self: true, online: true } : { name: sender.peer.name, self: false, online: Boolean(sender.peer.online) },
      explicit: sender.explicit,
      conflict: sender.conflict,
      relaying,
    };
  }

  // ---- For the scope label of the settings sheet (GET /api/settings-sync `telegram`) ----
  // { sender_name, self, conflict } of the device that sends now (its name as the page shows it: this device's own name, or the link's name), or null
  // when no device has Telegram. From what is known now, like view(): never a wait, and a stale peer is asked again only once its cache ran out.
  function summary(name = 'telegram') {
    refreshInBackground();
    const sender = resolve(name);
    if (sender.none) return null;
    const senderName = sender.self ? me().name : String((sender.peer && sender.peer.name) || '');
    return { sender_name: senderName.slice(0, 80), self: sender.self, conflict: sender.conflict };
  }

  function start() {
    if (unsubscribe || !serviceLinks || typeof serviceLinks.onChange !== 'function') return;
    unsubscribe = serviceLinks.onChange(id => {
      const peer = peers().find(candidate => candidate.id === id);
      if (!peer) { cache.delete(id); return; }
      const entry = cache.get(id);
      if (entry) Object.assign(entry, { at: null, failed: false, generation: entry.generation + 1, pending: null });
      if (peer.online) void refresh(peer);
    });
  }
  function stop() { if (unsubscribe) unsubscribe(); unsubscribe = null; }

  return {
    handles: name => RELAYED.has(name), target, send, sendTest, resolve, view, summary, status, accept, acceptTest, acceptChoice, readChoice, useThisDevice,
    refreshStale, start, stop, attach(service) { notify = service; },
  };
}

// ---- Routes ----
let defaultRelay = null;
const setDefaultRelay = relay => { defaultRelay = relay; };
const getDefaultRelay = () => defaultRelay;

const sendFault = (res, error) => {
  const code = /^[A-Z0-9_]+$/.test((error && error.message) || '') ? error.message : 'NOTIFY_RELAY_FAILED';
  res.status(Number.isInteger(error && error.statusCode) ? error.statusCode : 500).json({ error: code });
};

// The Engine side, mounted at /v1/attention/notify-relay before /v1/attention (routes/engine-v1.js). Only a token issued for a live service link gets in,
// like /v1/linked-services; the token is checked before the body is read (server.js keeps the global JSON parser off /v1/attention).
function createEngineRouter(options = {}) {
  const getRelay = options.getRelay || getDefaultRelay;
  const serviceLinks = options.serviceLinks || null;
  const links = () => serviceLinks || require('./service-links').getServiceLinks();
  const requireEngineAuth = options.requireEngineAuth || require('../middleware/engine-auth');
  const router = express.Router();
  router.use(requireEngineAuth(), (req, res, next) => {
    const link = links().linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    const relay = getRelay();
    if (!relay) return res.status(503).json({ error: 'NOTIFY_RELAY_UNAVAILABLE' });
    req.relayLink = link;
    req.relay = relay;
    res.set('Cache-Control', 'no-store');
    next();
  }, express.json({ limit: '64kb' }));
  router.get('/status', (req, res) => res.json(req.relay.status()));
  router.put('/sender', (req, res) => {
    try { res.json(req.relay.acceptChoice(req.body)); } catch (error) { sendFault(res, error); }
  });
  router.post('/test', async (req, res) => {
    try { res.json(await req.relay.acceptTest(req.relayLink, req.body)); } catch (error) { sendFault(res, error); }
  });
  router.post('/', async (req, res) => {
    try { res.json(await req.relay.accept(req.relayLink, req.body)); } catch (error) { sendFault(res, error); }
  });
  // A body that is too big or not JSON.
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error && error.status === 413 ? 413 : 400).json({ error: error && error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST' });
  });
  return router;
}

module.exports = { createAttentionRelay, createEngineRouter, setDefaultRelay, getDefaultRelay, relayItem, RelayError, CAPABILITY, ROUTE, STATE_KEY, CACHE_MS };

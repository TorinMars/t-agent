// T-Attention read copies across linked devices (docs/design/attention-copies.md). An item stays owned by the engine whose database has it, and only
// that engine changes it; every engine joined to it by service links keeps a read copy, so the list, the badge, the reminders and the desktop window
// show the same items whether or not the owner answers right now. The same pattern as the Learn and usage data syncs (services/learn-sync.js,
// services/ui-events-sync.js):
//
// - Rows (table attention_copies): one per item and owner, the owner's own items included (owner '': the journal of this engine's items, written
//   from the change bus of services/attention.js and checked against attention_items at start). A row is the whole item as the owner lists it, the
//   kind of its last change and the owner's version `rev` (a hybrid clock in ms); a deleted item is a tombstone. The later `rev` wins whole
//   (services/attention-copy-merge.js); an engine never takes a row of its own items from a peer.
// - Change numbers: every row written here, own or copied, gets the next number of the database. A device asks a peer for the rows after the highest
//   number of that peer it has (`have`, per link), one page at a time, and sends its own rows after the number the peer reports. A receiver applies a
//   row only when it is newer, so an echo stops at once; what it applied gets new numbers and goes on to its other peers (a chain A–B–C reaches C).
// - Transport: GET /v1/info must list `attention:copy` (an older peer is skipped, and the page reads it live as before); GET /v1/attention-copy,
//   POST /v1/attention-copy/pull, PUT /v1/attention-copy. Rows travel only inside the settings sync's AES-256-GCM envelopes, with a key derived from
//   that link's settings-sync key and their own additional data. Link tokens only.
// - When: a change of an own item pushes to every online peer 1.5 s later (one round for a burst), a link that comes online gets a round, and every
//   5 minutes.
// - Company computers take part like normal machines: the items describe sessions, not the person's own progress (shared, like the page state).
// - Actions on a copy: while the owner is online they go to the owner (routes/remote-servers.js, routes/attention-widget.js); while it is offline
//   the safe ones are queued here (attention_copy_queue), shown at once as pending, and applied in order when the owner is back, or dropped when
//   the owner changed the same field meanwhile; the others are refused (`offline`).
// - Copies never reach a notifier: their changes go out on this module's own bus (onChange), which only the page stream and the desktop window
//   read, never on the attention service's bus that the notifiers, the AI summary and /v1/attention/stream follow. A notifier fires on the owner only.
const os = require('os');
const crypto = require('crypto');
const { seal, open } = require('./settings-sync');
const { readState, writeState } = require('./settings-sync-store');
const merge = require('./attention-copy-merge');

const { isPlainObject } = merge;
const CAPABILITY = 'attention:copy';
const ROUTE = '/v1/attention-copy';
const PEERS_KEY = 'attention_copy_peers_v1';
const OWNERS_KEY = 'attention_copy_owners_v1';
const CLOCK_KEY = 'attention_copy_clock_v1';
const PAGE_SIZE = 100;
const MAX_PAGE = 500;
const MAX_PAGES_PER_ROUND = 200;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PUSH_MS = 1500;
const REQUEST_TIMEOUT_MS = 15_000;
const DAY = 24 * 60 * 60 * 1000;
const TOMBSTONE_MS = 30 * DAY; // a tombstone is kept this long, then forgotten
const OWNER_FORGET_MS = 30 * DAY; // the copies of an owner nobody has heard of for this long are removed (an unlinked device)
const DROPPED_KEEP_MS = 7 * DAY; // a dropped queued change is shown this long unless dismissed
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const { INSTANCE_ID } = merge;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attention_copies (
  owner     TEXT    NOT NULL,
  item_id   INTEGER NOT NULL,
  rev       INTEGER NOT NULL,
  deleted   INTEGER NOT NULL DEFAULT 0,
  item      TEXT,
  event     TEXT,
  at        TEXT    NOT NULL,
  sync_seq  INTEGER NOT NULL,
  PRIMARY KEY (owner, item_id)
);
CREATE INDEX IF NOT EXISTS idx_attention_copies_seq ON attention_copies (sync_seq);
CREATE TABLE IF NOT EXISTS attention_copy_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  fields     TEXT    NOT NULL,
  activity   TEXT,
  base       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'pending',
  reason     TEXT,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_copy_queue_item ON attention_copy_queue (owner, item_id, id);
`;
// The two tables (also in db/schema.sql, made at every start). No schema generation: an older version leaves them alone, and a change it made to
// the items is found by the check at start (`reconcile`).
const ensureSchema = db => db.exec(SCHEMA);

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const errorCode = error => (error && /^[A-Z0-9_]{1,64}$/.test(error.message || '') ? error.message : 'ATTENTION_COPY_FAILED');
const aadOf = (direction, sender, linkId) => Buffer.from(`t-agent attention-copy v1|${direction}|${sender}|${linkId}`);
const copyKeyFrom = linkKey => Buffer.from(crypto.hkdfSync('sha256', linkKey, Buffer.alloc(0), Buffer.from('t-agent attention-copy v1'), 32));
const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const parse = text => { if (!text) return null; try { return JSON.parse(text); } catch { return null; } };
const iso = ms => new Date(ms).toISOString();
const later = (a, b) => (Date.parse(a || '') || 0) > (Date.parse(b || '') || 0);
// An error of a request to a peer that means "it cannot be reached now" (offline, a tunnel down, a timeout, a 5xx).
const unreachable = error => !error || !error.statusCode || error.statusCode >= 500 || /OFFLINE|CONNECTION|TIMEOUT|UNREACHABLE/.test(String(error.message || ''));

// An item row of attention_items in the shape services/attention.js lists it (meta and context parsed).
const itemOfRow = row => ({ ...row, meta: parse(row.meta), context: parse(row.context) });

function createAttentionCopy(options) {
  const {
    db, service, serviceLinks = null, request = null,
    identity, // () => { instance_id, name }
    linkKeys, // { publicKey(), linkKey(peer, publicKey) }: the settings sync's key pair and link keys
    enabled = () => true,
    host = () => os.hostname(),
    now = Date.now, log = console,
    intervalMs = SYNC_INTERVAL_MS, pushMs = PUSH_MS, timeoutMs = REQUEST_TIMEOUT_MS, pageSize = PAGE_SIZE, quietMs = merge.QUIET_MS,
  } = options;
  ensureSchema(db);
  const me = () => identity().instance_id;

  // ---- The clock and the change numbers (kept in system_state, so the numbers never go back when rows are removed) ----
  const clock = (() => {
    const stored = readState(db, CLOCK_KEY);
    const maxSeq = Number(db.prepare('SELECT COALESCE(MAX(sync_seq), 0) FROM attention_copies').pluck().get()) || 0;
    const maxRev = Number(db.prepare("SELECT COALESCE(MAX(rev), 0) FROM attention_copies WHERE owner = ''").pluck().get()) || 0;
    return { rev: Math.max(int(stored && stored.rev), maxRev), seq: Math.max(int(stored && stored.seq), maxSeq) };
  })();
  const saveClock = () => writeState(db, CLOCK_KEY, { rev: clock.rev, seq: clock.seq });
  const nextSeq = () => { clock.seq += 1; return clock.seq; };
  const nextRev = () => { clock.rev = merge.nextRev(clock.rev, now()); return clock.rev; };
  const maxSeq = () => clock.seq;

  // ---- Stored state ----
  const readPeers = () => { const value = readState(db, PEERS_KEY); return isPlainObject(value) ? value : {}; };
  function updatePeer(id, change) {
    const peers = readPeers();
    const current = isPlainObject(peers[id]) ? peers[id] : {};
    peers[id] = { ...current, ...change(current) };
    if (serviceLinks) {
      const live = new Set(livePeers().map(peer => peer.id));
      for (const key of Object.keys(peers)) if (!live.has(key)) delete peers[key];
    }
    writeState(db, PEERS_KEY, peers);
    return peers[id];
  }
  const peerState = id => { const state = readPeers()[id]; return isPlainObject(state) ? state : {}; };
  // The owners whose items are copied here: { <instance id>: { name, host, seen_at } }; seen_at is the newest time this engine or a peer heard from it.
  const readOwners = () => { const value = readState(db, OWNERS_KEY); return isPlainObject(value) ? value : {}; };
  function noteOwners(entries) {
    const owners = readOwners();
    let changed = false;
    for (const [id, info] of Object.entries(entries)) {
      if (id === me() || !INSTANCE_ID.test(id) || !isPlainObject(info)) continue;
      const current = isPlainObject(owners[id]) ? owners[id] : {};
      const seen = typeof info.seen_at === 'string' && !Number.isNaN(Date.parse(info.seen_at)) ? info.seen_at : null;
      const next = { ...current };
      const newer = Boolean(seen && later(seen, current.seen_at));
      if (newer) next.seen_at = seen;
      // The name and host: the ones the owner gives of itself (its own entry), else the newest heard, else the first.
      for (const field of ['name', 'host']) {
        const value = typeof info[field] === 'string' && info[field] && info[field].length <= 200 ? info[field] : null;
        if (value && (info.self === true || newer || !current[field])) next[field] = value;
      }
      if (JSON.stringify(next) !== JSON.stringify(current)) { owners[id] = next; changed = true; }
    }
    if (changed) writeState(db, OWNERS_KEY, owners);
  }
  const markSeen = (instanceId, name = null) => noteOwners({ [instanceId]: { seen_at: iso(now()), ...(name ? { name } : {}) } });

  // ---- Links ----
  const livePeers = () => {
    if (!serviceLinks) return [];
    try { return serviceLinks.peers(); } catch { return []; }
  };
  const onlinePeers = () => livePeers().filter(peer => peer.online);
  const supportedPeer = peer => Boolean(peer && peer.instanceId && peerState(peer.id).supported === true);
  const peerOfOwner = owner => livePeers().find(peer => peer.instanceId === owner) || null;
  const peerOfServer = serverId => livePeers().find(peer => Number(peer.remoteServerId) === Number(serverId)) || null;

  function copyKey(peer, publicKey) {
    if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) throw fault('ATTENTION_COPY_BAD_KEY', 400);
    return copyKeyFrom(linkKeys.linkKey(peer, publicKey));
  }

  // ---- The copy bus: the changes of copies, for the page stream and the desktop window (never the notifiers) ----
  const listeners = new Set();
  function emit(change) {
    for (const listener of [...listeners]) {
      try { listener(change); } catch (error) { log.warn(`[attention-copy] a change listener failed: ${error.message}`); }
    }
  }
  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange needs a function');
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  // ---- Rows ----
  const selectRow = db.prepare('SELECT * FROM attention_copies WHERE owner = ? AND item_id = ?');
  const upsert = db.prepare(`INSERT INTO attention_copies (owner, item_id, rev, deleted, item, event, at, sync_seq) VALUES (@owner, @item_id, @rev, @deleted, @item, @event, @at, @sync_seq)
    ON CONFLICT(owner, item_id) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted, item = excluded.item, event = excluded.event, at = excluded.at, sync_seq = excluded.sync_seq`);
  const queueOf = db.prepare('SELECT * FROM attention_copy_queue WHERE owner = ? AND item_id = ? ORDER BY id');
  const entryOf = row => ({ id: row.id, fields: parse(row.fields) || {}, activity: parse(row.activity), base: parse(row.base) || {}, at: row.created_at, state: row.state, reason: row.reason });

  // This engine's own item changed (the attention service's bus): its journal row, then a push soon.
  function journal(change) {
    if (!enabled() || !change || !change.item || !positive(change.item.id)) return;
    const id = change.item.id;
    const stored = selectRow.get('', id);
    const deleted = change.kind === 'deleted';
    const text = deleted ? null : JSON.stringify(change.item);
    if (stored && Boolean(stored.deleted) === deleted && stored.item === text) return; // an activity note alone: the item is the same
    const at = (change.event && typeof change.event.at === 'string' && change.event.at) || iso(now());
    const event = merge.slimEvent(change.event, change);
    db.transaction(() => {
      upsert.run({ owner: '', item_id: id, rev: nextRev(), deleted: deleted ? 1 : 0, item: text, event: event ? JSON.stringify(event) : null, at, sync_seq: nextSeq() });
      saveClock();
    })();
    schedulePush();
  }
  const positive = value => Number.isSafeInteger(value) && value > 0;

  // At start: the journal against attention_items (a change made while this module was off, by an older version or before a crash, is journaled now;
  // an item that is gone gets its tombstone).
  function reconcile() {
    if (!enabled()) return 0;
    let count = 0;
    db.transaction(() => {
      const journaled = new Map(db.prepare("SELECT item_id, deleted, item FROM attention_copies WHERE owner = ''").all().map(row => [row.item_id, row]));
      const at = iso(now());
      for (const row of db.prepare('SELECT * FROM attention_items').all()) {
        const text = JSON.stringify(itemOfRow(row));
        const stored = journaled.get(row.id);
        journaled.delete(row.id);
        if (stored && !stored.deleted && stored.item === text) continue;
        upsert.run({ owner: '', item_id: row.id, rev: nextRev(), deleted: 0, item: text, event: null, at: row.updated_at || at, sync_seq: nextSeq() });
        count += 1;
      }
      for (const [id, stored] of journaled) {
        if (stored.deleted) continue;
        upsert.run({ owner: '', item_id: id, rev: nextRev(), deleted: 1, item: null, event: null, at, sync_seq: nextSeq() });
        count += 1;
      }
      if (count) saveClock();
    })();
    return count;
  }

  // ---- Owners and how a copy is shown ----
  // The owners this engine shows copies of: the linked peers that have the copies (online or not), and owners known only through a peer (a chain).
  // A linked peer that is older (no capability) is not one: the page reads it live, as before. [{ instance_id, name, host, engine, linked, online, as_of }]
  function owners() {
    const map = readOwners();
    const out = [];
    const direct = new Set();
    for (const peer of livePeers()) {
      if (!peer.instanceId) continue;
      direct.add(peer.instanceId);
      if (!supportedPeer(peer)) continue;
      const info = map[peer.instanceId] || {};
      out.push({ instance_id: peer.instanceId, name: info.name || peer.name, host: info.host || null, engine: `remote:${peer.remoteServerId}`, linked: true, online: Boolean(peer.online), as_of: info.seen_at || null });
    }
    for (const owner of db.prepare("SELECT DISTINCT owner FROM attention_copies WHERE owner != '' AND deleted = 0").pluck().all()) {
      if (direct.has(owner) || owner === me()) continue;
      const info = map[owner] || {};
      out.push({ instance_id: owner, name: info.name || owner.slice(0, 8), host: info.host || null, engine: null, linked: false, online: false, as_of: info.seen_at || null });
    }
    return out;
  }
  const ownerInfo = owner => owners().find(entry => entry.instance_id === owner) || null;

  // The item of a copy row as the page and the window get it: as the owner listed it with the queued changes applied, and who owns it.
  function decorate(row, info = ownerInfo(row.owner)) {
    const item = parse(row.item);
    if (!item) return null;
    const entries = queueOf.all(row.owner, row.item_id).map(entryOf);
    const pending = entries.filter(entry => entry.state === 'pending');
    const dropped = entries.filter(entry => entry.state === 'dropped');
    return {
      ...merge.project(item, pending),
      owner: row.owner, owner_name: info ? info.name : null, owner_engine: info ? info.engine : null, copy: true,
      pending: pending.map(entry => ({ id: entry.id, at: entry.at, fields: Object.keys(entry.fields) })),
      dropped: dropped.map(entry => ({ id: entry.id, at: entry.at, fields: Object.keys(entry.fields), reason: entry.reason })),
    };
  }

  // The copies the page lists: for each owner shown (`owners`), its items filtered and cut like GET /api/attention (status, include_done, limit),
  // sort_order DESC then id DESC. { items, owners }.
  function list({ includeDone = false, limit = 200, status = null } = {}) {
    const shown = owners();
    const items = [];
    const statuses = status ? String(status).split(',').map(value => value.trim()).filter(Boolean) : null;
    const max = Math.min(1000, Math.max(1, Number(limit) || 200));
    for (const info of shown) {
      const rows = db.prepare('SELECT * FROM attention_copies WHERE owner = ? AND deleted = 0').all(info.instance_id);
      const own = rows.map(row => decorate(row, info)).filter(Boolean)
        .filter(item => (statuses ? statuses.includes(item.status) : includeDone || !['done', 'failed', 'cancelled'].includes(item.status)))
        .sort((a, b) => (Number(b.sort_order) || 0) - (Number(a.sort_order) || 0) || b.id - a.id)
        .slice(0, max);
      items.push(...own);
    }
    return { items, owners: shown };
  }
  // The copies of one owner (the desktop window's part for that engine), every one, as the owner would list them.
  const itemsOf = owner => list({ includeDone: true, limit: 1000 }).items.filter(item => item.owner === owner);
  function getCopy(owner, id) {
    const row = selectRow.get(owner, Number(id));
    return row && !row.deleted ? decorate(row) : null;
  }

  // ---- Pages ----
  // The owners entry of a page: this engine as it names itself, and every owner it knows.
  function ownersOut() {
    return { ...readOwners(), [me()]: { name: identity().name || '', host: host(), seen_at: iso(now()), self: true } };
  }
  function exportPage(after, limit) {
    const rows = db.prepare('SELECT * FROM attention_copies WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?').all(after, limit + 1);
    const more = rows.length > limit;
    const taken = rows.slice(0, limit);
    const self = me();
    return {
      rows: taken.map(row => ({ owner: row.owner || self, id: row.item_id, rev: row.rev, deleted: Boolean(row.deleted), item: row.deleted ? null : parse(row.item), event: parse(row.event), at: row.at })),
      owners: ownersOut(), after, next: more ? taken[taken.length - 1].sync_seq : Math.max(maxSeq(), after), more,
    };
  }

  // Applies a page from `sender` in one transaction; returns how many rows changed something. The changes go out on the copy bus afterwards.
  function applyPage(payload, sender) {
    if (!isPlainObject(payload)) throw fault('INVALID_ATTENTION_COPY', 400);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length > MAX_PAGE) throw fault('ATTENTION_COPY_TOO_LARGE', 413);
    const self = me();
    const changes = [];
    db.transaction(() => {
      for (const raw of rows) {
        const row = merge.rowFromPeer(raw);
        if (!row || row.owner === self) continue; // this engine's own items are only ever its own
        const stored = selectRow.get(row.owner, row.id);
        if (!merge.wins(row, stored)) continue;
        upsert.run({ owner: row.owner, item_id: row.id, rev: row.rev, deleted: row.deleted ? 1 : 0, item: row.deleted ? null : JSON.stringify(row.item), event: row.event ? JSON.stringify(row.event) : null, at: row.at, sync_seq: nextSeq() });
        changes.push({ row, stored });
      }
      if (changes.length) saveClock();
      if (isPlainObject(payload.owners)) noteOwners(payload.owners);
      if (sender && INSTANCE_ID.test(sender)) markSeen(sender);
    })();
    for (const { row, stored } of changes) publish(row, stored);
    return changes.length;
  }
  // One copy change on the bus: { kind, item, previous, event, copy: true, reorder?, plain_turn_end?, quiet? }.
  function publish(row, stored) {
    if (row.deleted && (!stored || stored.deleted)) return; // a tombstone of an item never shown here
    const info = ownerInfo(row.owner);
    const previous = stored && !stored.deleted ? decorate(stored, info) : null;
    const kind = merge.changeKind(row, stored);
    const item = row.deleted ? previous : decorate({ owner: row.owner, item_id: row.id, item: JSON.stringify(row.item) }, info);
    if (!item) return;
    const event = row.event || null;
    emit({
      kind, item, previous, event: event ? { ...event, item_id: row.id } : null, copy: true,
      ...(event && event.reorder ? { reorder: true } : {}), ...(event && event.plain_turn_end ? { plain_turn_end: true } : {}),
      ...(merge.isQuiet(row.at, now(), quietMs) ? { quiet: true } : {}),
    });
  }
  // The copy of an item changed here (a queued change added, applied or dropped): the page redraws it.
  function republish(owner, id, extra = {}) {
    const row = selectRow.get(owner, Number(id));
    if (!row || row.deleted) return;
    const item = decorate(row);
    if (item) emit({ kind: 'updated', item, previous: null, event: null, copy: true, quiet: true, ...extra });
  }

  // ---- The queue: changes to the items of an owner that is offline ----
  function enqueue(owner, id, queued) {
    const row = selectRow.get(owner, Number(id));
    if (!row || row.deleted) return null;
    const pending = queueOf.all(owner, row.item_id).map(entryOf).filter(entry => entry.state === 'pending');
    const shown = merge.project(parse(row.item), pending);
    db.prepare('INSERT INTO attention_copy_queue (owner, item_id, fields, activity, base, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, row.item_id, JSON.stringify(queued.fields), queued.activity ? JSON.stringify(queued.activity) : null, JSON.stringify(merge.baseOf(shown, queued.fields)), iso(now()));
    republish(owner, row.item_id);
    return decorate(selectRow.get(owner, row.item_id));
  }
  // A dropped change the person has read (the page's close button). True when there was one.
  function dismiss(entryId) {
    const entry = db.prepare("SELECT * FROM attention_copy_queue WHERE id = ? AND state = 'dropped'").get(Number(entryId));
    if (!entry) return false;
    db.prepare('DELETE FROM attention_copy_queue WHERE id = ?').run(entry.id);
    republish(entry.owner, entry.item_id);
    return true;
  }
  const pendingCount = owner => Number(db.prepare("SELECT COUNT(*) FROM attention_copy_queue WHERE owner = ? AND state = 'pending'").pluck().get(owner)) || 0;

  // The owner is back: its queued changes, in order. Each is checked against the owner's item as it is now (merge.resolveQueued): applied, already
  // there, or dropped (the owner changed the same field meanwhile, the item is gone, or the owner refused it). Stops at the first request that does not
  // reach the owner (the rest wait for the next round).
  async function flush(peer, call) {
    const entries = db.prepare("SELECT * FROM attention_copy_queue WHERE owner = ? AND state = 'pending' ORDER BY id").all(peer.instanceId);
    const touched = new Map(); // item id -> the ids of the entries dropped now
    for (const raw of entries) {
      const entry = entryOf(raw);
      let current = null;
      try { const found = await call(`/v1/attention/${raw.item_id}`); current = found && found.item ? found.item : null; }
      catch (error) { if (error && error.statusCode === 404) current = null; else throw error; }
      const decision = merge.resolveQueued(entry, current);
      let reason = decision.drop || null;
      if (decision.apply) {
        try { await call(`/v1/attention/${raw.item_id}`, { method: 'PATCH', body: decision.apply.body }); }
        catch (error) {
          if (unreachable(error) || error.statusCode === 401 || error.statusCode === 429) throw error;
          reason = error.statusCode === 404 ? 'gone' : 'refused';
        }
      }
      if (!touched.has(raw.item_id)) touched.set(raw.item_id, []);
      if (reason) {
        db.prepare("UPDATE attention_copy_queue SET state = 'dropped', reason = ?, done_at = ? WHERE id = ?").run(reason, iso(now()), raw.id);
        touched.get(raw.item_id).push({ id: raw.id, reason });
      } else db.prepare('DELETE FROM attention_copy_queue WHERE id = ?').run(raw.id);
    }
    for (const [id, dropped] of touched) republish(peer.instanceId, id, dropped.length ? { dropped_now: dropped } : {});
    return entries.length;
  }

  // ---- Actions on a copy (routes/remote-servers.js, routes/attention.js and routes/attention-widget.js) ----
  // Whether the copy sync covers the engine of a remote_servers row (a linked peer with the capability): its items are read from the copies here.
  const covers = serverId => supportedPeer(peerOfServer(serverId));
  const coversOwner = owner => { const peer = peerOfOwner(owner); return peer ? supportedPeer(peer) : ownerInfo(owner) !== null; };
  const peerOnline = serverId => { const peer = peerOfServer(serverId); return Boolean(peer && peer.online); };
  // The answer for a request to the T-Attention of an owner that cannot be reached: { status, body }, or null when the copies do not cover it (the
  // caller answers its own error then). `serverId` names a linked engine's remote_servers row, `owner` an instance id (a device known only through a
  // chain, which this engine cannot reach at all: reads only). `itemId` null: the list (GET) or a new item (POST).
  function offline({ serverId = null, owner = null, method, itemId = null, sub = '', body } = {}) {
    let instanceId = owner;
    let linked = false;
    if (serverId !== null && serverId !== undefined) {
      const peer = peerOfServer(serverId);
      if (!supportedPeer(peer)) return null;
      instanceId = peer.instanceId;
      linked = true;
    } else if (!instanceId || !coversOwner(instanceId)) return null;
    else linked = Boolean(peerOfOwner(instanceId));
    const info = ownerInfo(instanceId);
    if (itemId === null) {
      if (method === 'GET') return { status: 200, body: { items: itemsOf(instanceId), host: info ? info.host : null, instance_id: instanceId, copy: true, as_of: info ? info.as_of : null } };
      return { status: 409, body: refusalBody(merge.queueRule(method, sub, body, { hasItem: false })) };
    }
    const copy = getCopy(instanceId, itemId);
    if (!copy) return { status: 404, body: { error: 'NOT_FOUND', message: 'Task not found' } };
    if (method === 'GET' && !sub) return { status: 200, body: { item: copy, events: [], copy: { owner: instanceId, as_of: info ? info.as_of : null } } };
    if (!linked) return { status: 409, body: { error: 'ATTENTION_OWNER_NOT_LINKED', message: 'This task belongs to a device that is not linked to this one; change it on a device that is' } };
    const rule = merge.queueRule(method, sub, body);
    if (rule.refuse) return { status: rule.refuse.status, body: refusalBody(rule) };
    const item = enqueue(instanceId, itemId, rule.queue);
    return item ? { status: 202, body: item } : { status: 404, body: { error: 'NOT_FOUND', message: 'Task not found' } };
  }
  const refusalBody = rule => ({ error: rule.refuse.error, message: rule.refuse.message });
  // A write that reached the owner: the copies follow at once (a round with that peer), not only at its push.
  function nudge(serverId) {
    const peer = peerOfServer(serverId);
    if (peer && peer.online && supportedPeer(peer) && request) void syncPeer(peer);
  }

  // ---- Engine side ----
  const peerForLink = link => livePeers().find(peer => peer.id === link.id) || null;
  function requirePeer(link) {
    if (!enabled()) throw fault('NOT_FOUND', 404);
    const peer = peerForLink(link);
    if (!peer) throw fault('LINKED_ONLY', 403);
    return peer;
  }
  function checkSender(link, body) {
    const given = isPlainObject(body) ? body : {};
    if (typeof given.public_key !== 'string' || !PUBLIC_KEY.test(given.public_key)) throw fault('ATTENTION_COPY_BAD_KEY', 400);
    if (typeof given.instance_id !== 'string' || !INSTANCE_ID.test(given.instance_id)) throw fault('INVALID_ATTENTION_COPY', 400);
    if (link.peer_instance_id && link.peer_instance_id !== given.instance_id) throw fault('INVALID_ATTENTION_COPY', 400);
    return given;
  }
  const haveOf = (state, instanceId) => (isPlainObject(state.have) && state.have.instance_id === instanceId ? int(state.have.seq) : 0);

  // GET /v1/attention-copy
  function engineDescribe(link) {
    const peer = requirePeer(link);
    const state = peerState(peer.id);
    return { instance_id: me(), public_key: linkKeys.publicKey(), max_seq: maxSeq(), have: haveOf(state, link.peer_instance_id || state.instance_id || (isPlainObject(state.have) ? state.have.instance_id : '')) };
  }
  // POST /v1/attention-copy/pull { instance_id, public_key, after, limit }
  function enginePull(link, body) {
    const peer = requirePeer(link);
    const given = checkSender(link, body);
    const after = int(given.after);
    const limit = Math.min(MAX_PAGE, Math.max(1, int(given.limit) || pageSize));
    const key = copyKey(peer, given.public_key);
    return { instance_id: me(), sealed: seal(key, exportPage(after, limit), aadOf('pull', me(), link.id)) };
  }
  // PUT /v1/attention-copy { instance_id, public_key, sealed }: the peer's rows after `after` (inside the envelope). Answers how far this device has them.
  function enginePush(link, body) {
    const peer = requirePeer(link);
    const given = checkSender(link, body);
    const key = copyKey(peer, given.public_key);
    const payload = open(key, given.sealed, aadOf('push', given.instance_id, link.id));
    const applied = applyPage(payload, given.instance_id);
    const had = haveOf(peerState(peer.id), given.instance_id);
    const have = int(payload.after) <= had ? Math.max(had, int(payload.next)) : had;
    updatePeer(peer.id, () => ({ supported: true, instance_id: given.instance_id, have: { seq: have, instance_id: given.instance_id } }));
    if (applied) schedulePush();
    return { applied, have };
  }

  // ---- Failures in the log (once per reason, once when it works again, codes only) ----
  const reported = new Map();
  function report(key, what, error = null) {
    const reason = error ? errorCode(error) : null;
    const before = reported.get(key) || null;
    if (reason === before) return;
    if (reason) { reported.set(key, reason); log.warn(`[attention-copy] ${what} failed: ${reason}`); } else {
      reported.delete(key);
      if (before) (log.info || log.warn).call(log, `[attention-copy] ${what} works again (it failed with ${before})`);
    }
  }

  // ---- Rounds ----
  const running = new Map();
  const again = new Set();

  async function round(peer) {
    const call = (route, opts = {}) => request(peer.baseUrl, route, peer.token, { timeoutMs, ...opts });
    let applied = 0;
    try {
      const info = await call('/v1/info');
      const supported = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
      const before = peerState(peer.id).supported;
      updatePeer(peer.id, () => ({ supported }));
      if (before !== supported) emitOwners();
      if (!supported) { report(peer.id, `sync with ${peer.name}`); return 0; }
      const theirs = await call(ROUTE);
      if (!theirs || typeof theirs.instance_id !== 'string' || !INSTANCE_ID.test(theirs.instance_id)) throw fault('ATTENTION_COPY_BAD_ANSWER', 502);
      const key = copyKey(peer, theirs.public_key);
      const self = me();
      const mine = linkKeys.publicKey();
      const theirMax = int(theirs.max_seq);
      markSeen(theirs.instance_id);

      // The changes queued while it was offline go first, so the pull below already brings their result.
      if (peer.instanceId === theirs.instance_id && pendingCount(theirs.instance_id)) await flush(peer, call);

      // Pull: the peer's rows after what this device has of them.
      let after = haveOf(peerState(peer.id), theirs.instance_id);
      if (after > theirMax) after = 0; // the peer's database is older than what we had (restored): from the start
      for (let pages = 0; after < theirMax && pages < MAX_PAGES_PER_ROUND; pages += 1) {
        const answer = await call(`${ROUTE}/pull`, { method: 'POST', body: { instance_id: self, public_key: mine, after, limit: pageSize } });
        const payload = open(key, answer && answer.sealed, aadOf('pull', theirs.instance_id, peer.id));
        applied += applyPage(payload, theirs.instance_id);
        const next = int(payload.next);
        if (next <= after) break;
        after = next;
        updatePeer(peer.id, () => ({ instance_id: theirs.instance_id, have: { seq: after, instance_id: theirs.instance_id } }));
        if (!payload.more) break;
      }

      // Push: this device's rows after what the peer has of them.
      let sent = int(theirs.have);
      if (sent > maxSeq()) sent = 0;
      for (let pages = 0; sent < maxSeq() && pages < MAX_PAGES_PER_ROUND; pages += 1) {
        const page = exportPage(sent, pageSize);
        const answer = await call(ROUTE, { method: 'PUT', body: { instance_id: self, public_key: mine, sealed: seal(key, page, aadOf('push', self, peer.id)) } });
        const have = int(answer && answer.have);
        if (have <= sent) break;
        sent = have;
        if (!page.more) break;
      }
      updatePeer(peer.id, () => ({ last_sync_at: iso(now()), last_error: null }));
      report(peer.id, `sync with ${peer.name}`);
    } catch (error) {
      if (error && error.statusCode === 401 && serviceLinks && typeof serviceLinks.noteUnauthorized === 'function') {
        try { serviceLinks.noteUnauthorized(peer.remoteServerId); } catch { /* the next call tries again */ }
      }
      report(peer.id, `sync with ${peer.name}`, error);
      try { updatePeer(peer.id, () => ({ last_error: errorCode(error), last_error_at: iso(now()) })); } catch { /* logged above */ }
    }
    return applied;
  }

  function syncPeer(peer) {
    if (running.has(peer.id)) { again.add(peer.id); return running.get(peer.id); }
    const work = (async () => {
      let applied = 0;
      do {
        again.delete(peer.id);
        const current = onlinePeers().find(candidate => candidate.id === peer.id) || peer;
        applied += await round(current);
      } while (again.has(peer.id));
      return applied;
    })().catch(error => { report(peer.id, `sync with ${peer.name}`, error); return 0; }).finally(() => running.delete(peer.id));
    running.set(peer.id, work);
    return work;
  }

  async function syncAll() {
    if (!enabled() || !request) return;
    const results = await Promise.all(onlinePeers().map(syncPeer));
    if (results.some(count => count > 0)) schedulePush();
  }
  const syncInBackground = () => syncAll().then(() => report('rounds', 'a sync round'), error => report('rounds', 'a sync round', error)).catch(() => {});

  // A push a moment after a change: one round for a burst of changes (the first change starts the wait, later ones ride along).
  let timer = null;
  function schedulePush() {
    if (!started || timer) return;
    timer = setTimeout(() => { timer = null; syncInBackground(); }, pushMs);
    if (timer.unref) timer.unref();
  }

  // The owners changed in a way the page shows (a link online or offline, a peer that gained or lost the copies): the stream tells the page.
  const emitOwners = () => emit({ kind: 'owners', owners: owners() });

  // Old rows: tombstones after 30 days, the copies of an owner nobody heard of for 30 days (an unlinked device), dropped changes after 7 days.
  function prune() {
    const cut = iso(now() - TOMBSTONE_MS);
    db.prepare('DELETE FROM attention_copies WHERE deleted = 1 AND at < ?').run(cut);
    const map = readOwners();
    const direct = new Set(livePeers().map(peer => peer.instanceId).filter(Boolean));
    for (const owner of db.prepare("SELECT DISTINCT owner FROM attention_copies WHERE owner != ''").pluck().all()) {
      if (direct.has(owner)) continue;
      const seen = Date.parse((map[owner] || {}).seen_at || '') || 0;
      if (now() - seen > OWNER_FORGET_MS) {
        db.prepare('DELETE FROM attention_copies WHERE owner = ?').run(owner);
        db.prepare('DELETE FROM attention_copy_queue WHERE owner = ?').run(owner);
      }
    }
    db.prepare("DELETE FROM attention_copy_queue WHERE state = 'dropped' AND done_at < ?").run(iso(now() - DROPPED_KEEP_MS));
  }

  // ---- Life ----
  let started = false;
  let interval = null;
  const unsubscribe = [];
  function start() {
    if (started || !enabled()) return;
    started = true;
    unsubscribe.push(service.onChange(journal));
    reconcile();
    try { prune(); } catch (error) { log.warn(`[attention-copy] cleanup failed: ${error.message}`); }
    if (serviceLinks) {
      unsubscribe.push(serviceLinks.onChange(id => {
        emitOwners();
        const peer = onlinePeers().find(candidate => candidate.id === id);
        if (peer && request) syncPeer(peer);
      }));
    }
    if (request && intervalMs > 0) {
      interval = setInterval(() => { try { prune(); } catch { /* next time */ } syncInBackground(); }, intervalMs);
      if (interval.unref) interval.unref();
    }
    if (request) setImmediate(syncInBackground);
  }
  function stop() {
    started = false;
    while (unsubscribe.length) unsubscribe.pop()();
    if (interval) clearInterval(interval);
    interval = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start, stop, syncAll, syncPeer, reconcile, prune, journal, onChange, list, itemsOf, getCopy, owners, covers, coversOwner, peerOnline, offline, nudge, dismiss,
    engineDescribe, enginePull, enginePush, exportPage, applyPage, peerStates: readPeers, flush,
  };
}

// Off with SETTINGS_SYNC_ENABLED=false or ATTENTION_COPY_ENABLED=false (config.attentionCopyEnabled): then every engine's items are read live, as before.
const syncEnabled = () => require('../config').attentionCopyEnabled !== false;

let singleton = null;
function getAttentionCopy() {
  if (singleton) return singleton;
  const db = require('../db');
  const settingsSync = require('./settings-sync').getSettingsSync();
  const identity = () => { const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity(); return { instance_id: instanceId, name }; };
  singleton = createAttentionCopy({
    db, service: require('./attention').defaultService(), serviceLinks: require('./service-links').getServiceLinks(),
    request: (...args) => require('./remote-client').request(...args),
    identity,
    linkKeys: { publicKey: () => settingsSync.publicKey(), linkKey: (peer, publicKey) => settingsSync.linkKey(peer, publicKey) },
    enabled: syncEnabled,
  });
  return singleton;
}
// The module when it is on, else null (the callers then read every engine live, as before).
const sharedCopy = () => (syncEnabled() ? getAttentionCopy() : null);

module.exports = { createAttentionCopy, getAttentionCopy, sharedCopy, ensureSchema, syncEnabled, aadOf, copyKeyFrom, CAPABILITY, ROUTE, PEERS_KEY, OWNERS_KEY, CLOCK_KEY, PAGE_SIZE };

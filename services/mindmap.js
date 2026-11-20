// Mind maps: one JSON file per map in <data folder>/mindmaps (see "Mind maps" in docs/design/mind-maps.md). Self-contained: no database table, and it never reads or
// changes tasks, work directories, terminals, agent chat or terminal activity.
//
// - A file is { id, title, data, revision, created_at, updated_at, sync, cache? }. `data` is opaque to the server: a JSON object, or null until the page first saves.
// - The app has one user (services/single-user.js), so maps are not scoped per owner; this matches the items of services/attention.js.
// - Ids are UUIDs, checked before any path is built: a value that is not one is simply "not found". A map keeps its id on every engine.
// - Writes go to a temp file in the same folder, are fsynced and then renamed, and run one at a time per id. Creates run one at a time too, so the
//   map limit holds under concurrent creates.
// - Deleting moves the file to trash/<id>-<time>.json, from where it can be moved back by hand, and leaves a tombstone (below).
// - A corrupt file is left alone and treated as absent, with one log line naming only the id. Map content is never logged: not even a JSON.parse
//   message, which can quote it.
//
// Copies on every engine ("Mind maps on every engine" in docs/design/mind-maps.md; the rules are services/mindmap-merge.js, the transport
// services/mindmap-sync.js). Each map carries `sync`: { vv, at, by, by_name, seq, conflict_of? }:
// - vv / at / by / by_name: its version (a version vector, the time on this folder's hybrid clock, the engine and its name). A save here adds one to
//   this engine's number in vv; the clock never goes back (max(now, the newest time seen + 1)).
// - seq: the change number of the last write here, from one counter per folder. A peer asks for the entries after the number it has.
// - Deletes leave a tombstone sync/tombstones/<id>.json { id, deleted_at, revision, sync }, kept TOMB_DAYS days, so the delete reaches every engine.
// - sync/state.json: { seq, clock, names } (the counter, the clock, the names of the engines seen in versions).
// - Migration: a file from before (no `sync`) gets { vv: { <this engine>: 1 }, at: its updated_at, by: this engine } and a change number, in the
//   background after the folder is first used (`migrate`), never inside a request; its id stays (ids are random UUIDs, so the maps of two engines
//   never collide and same-named maps stay two maps). A file written into the folder behind the server's back is adopted the same way.
// - `cache` (a company computer only): { opened_at }, the last time the page opened the map here; never sent to a peer.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const dataHome = require('../lib/data-home');
const merge = require('./mindmap-merge');

const LIMITS = { dataBytes: 8 * 1024 * 1024, maps: 2000, titleChars: 200 };
const DEFAULT_TITLE = 'Untitled map';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_SUFFIX = '.tmp';
const CREATE_QUEUE = 'create';
const META_QUEUE = 'meta';
const LIST_BATCH = 8; // files read at once by the list: at most 8 maps of 8 MB in memory
const TOMB_DAYS = 30;
// A server that stopped between writing a map and writing sync/state.json leaves the counter a little behind the files; at each start the counter
// jumps this far ahead instead of reading every file to find the newest number (gaps in the numbers are harmless).
const SEQ_MARGIN = 1000;
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAP_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
const TIME_TEXT = /^[0-9TZ:.+-]{10,40}$/;

class MindmapError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.name = 'MindmapError';
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

const invalid = message => new MindmapError(400, 'INVALID_MINDMAP', message);
const notFound = () => new MindmapError(404, 'MINDMAP_NOT_FOUND', 'Mind map not found');
const tooLarge = () => new MindmapError(413, 'MINDMAP_TOO_LARGE', 'The mind map is too large (limit: 8 MB)');
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function cleanTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || [...title].length > LIMITS.titleChars || LINE_BREAK.test(title)) throw invalid('The title must be 1 to 200 characters on one line');
  return title;
}

function checkBody(body) {
  if (!isObject(body)) throw invalid('The request is not a valid mind map');
}

function isRecord(value, id) {
  return isObject(value)
    && value.id === id
    && typeof value.title === 'string'
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && (value.data === null || isObject(value.data))
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string';
}

// The version of a stored entry, or null when it has none (a file from before, or one edited by hand).
function syncOf(value) {
  const sync = isObject(value) ? value.sync : null;
  if (!isObject(sync)) return null;
  const vv = merge.cleanVector(sync.vv);
  if (!vv || !Number.isSafeInteger(sync.at) || sync.at < 0 || typeof sync.by !== 'string' || !merge.INSTANCE_ID.test(sync.by)) return null;
  const seq = Number.isSafeInteger(sync.seq) && sync.seq >= 0 ? sync.seq : 0;
  const out = { vv, at: sync.at, by: sync.by, by_name: typeof sync.by_name === 'string' ? sync.by_name.slice(0, 128) : '', seq };
  if (typeof sync.conflict_of === 'string' && UUID.test(sync.conflict_of)) out.conflict_of = sync.conflict_of;
  return out;
}

function parseRecord(text, id) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return isRecord(value, id) ? value : null;
}

const detailOf = record => ({ id: record.id, title: record.title, data: record.data, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at });
// The form an entry travels in between engines: what every engine must store the same (never `cache` or the local change number).
function wireOf(entry) {
  const sync = { vv: entry.sync.vv, at: entry.sync.at, by: entry.sync.by, by_name: entry.sync.by_name, ...(entry.sync.conflict_of ? { conflict_of: entry.sync.conflict_of } : {}) };
  if (entry.kind === 'tomb') return { id: entry.id, deleted_at: entry.deleted_at, revision: entry.revision, sync };
  return { ...detailOf(entry), sync };
}

// Engine names as they arrive in versions: one line, at most 128 characters.
const cleanName = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) : '');

function createMindmapService({
  dataDir, now = () => new Date(), log = message => console.warn(message), maxMaps = LIMITS.maps, maxDataBytes = LIMITS.dataBytes,
  // Who this engine is ({ instance_id, name }): the server passes services/engine-identity.js. A test that passes nothing gets an id of its own.
  identity = null,
  // Tests only: { beforeWrite(entry) } is awaited before a map or tombstone with a change number is written, to hold a write while something else runs.
  hooks = {},
} = {}) {
  if (!dataDir) throw new Error('createMindmapService needs the data folder');
  const ownId = `engine-${crypto.randomUUID()}`;
  const me = () => {
    const value = identity ? identity() : null;
    return { instance_id: value && merge.INSTANCE_ID.test(value.instance_id || '') ? value.instance_id : ownId, name: cleanName(value && value.name) };
  };
  const dir = dataHome.layout(dataDir, {}).mindmapsDir;
  const trashDir = path.join(dir, 'trash');
  const syncDir = path.join(dir, 'sync');
  const tombDir = path.join(syncDir, 'tombstones');
  const stateFile = path.join(syncDir, 'state.json');
  const fileOf = id => path.join(dir, `${id}.json`);
  const tombOf = id => path.join(tombDir, `${id}.json`);
  const queues = new Map();
  // id -> { signature, summary, sync, cache } for the list, so that an unchanged file is not read again. summary is null for a corrupt file (logged once per change).
  const known = new Map();
  const tombs = new Map(); // id -> tombstone entry
  let meta = { seq: 0, clock: 0, names: {} };
  const listeners = new Set();
  let ready = null;

  function prepare() {
    if (!ready) {
      ready = (async () => {
        await fs.mkdir(trashDir, { recursive: true, mode: DIR_MODE });
        await fs.mkdir(tombDir, { recursive: true, mode: DIR_MODE });
        for (const folder of [dir, trashDir, syncDir, tombDir]) dataHome.tighten(folder, DIR_MODE);
        // One server per data folder (server.lock), and nothing is written before this runs: any temp file here was left by a crash.
        for (const folder of [dir, syncDir, tombDir]) {
          for (const name of await fs.readdir(folder)) {
            if (name.endsWith(TEMP_SUFFIX)) await fs.rm(path.join(folder, name), { force: true });
          }
        }
        const hadState = await loadState();
        await loadTombs();
        if (hadState) meta.seq += SEQ_MARGIN;
        else {
          // The first start with copies (no sync/state.json yet): every file is read once, only read, so the counter and the clock start past
          // whatever versions are already there (a folder copied from another engine, a state file deleted by hand).
          for (const entry of await readAll()) if (entry.sync) observe(entry.sync);
        }
        await saveState();
        // Files without a version get theirs in the background, never inside a request ("Migration" in docs/design/mind-maps.md).
        void migrate();
      })().catch(error => { ready = null; throw error; });
    }
    return ready;
  }

  // Runs tasks with the same key one after the other.
  function serial(key, task) {
    const run = (queues.get(key) || Promise.resolve()).then(task);
    const tail = run.then(() => {}, () => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  const corrupt = id => log(`Mind maps: skipped a corrupt file: ${id}`);

  // Makes a rename durable. Not every platform can fsync a folder (Windows cannot); the rename itself has already happened.
  async function syncFolder(folder) {
    let handle;
    try {
      handle = await fs.open(folder, 'r');
      await handle.sync();
    } catch {} finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  // `durable` false (the migration): the folder is synced once after many files instead of after each one.
  async function writeFileAtomic(folder, target, text, { durable = true } = {}) {
    const temp = path.join(folder, `.${path.basename(target, '.json')}.${process.pid}.${crypto.randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', FILE_MODE);
      await handle.writeFile(text);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    if (durable) await syncFolder(folder);
  }

  async function writeAtomic(record, options) {
    try {
      if (hooks.beforeWrite) await hooks.beforeWrite(record);
      known.delete(record.id);
      await writeFileAtomic(dir, fileOf(record.id), JSON.stringify(record), options);
      known.delete(record.id);
    } finally { written(record); } // written, or failed: either way no longer on its way (a failed write leaves a gap)
  }

  // ---- The counter, the clock and the names (sync/state.json) ----
  // True when the folder had a state file.
  async function loadState() {
    let value = null;
    try { value = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { value = null; }
    if (!isObject(value)) return false;
    meta = {
      seq: Number.isSafeInteger(value.seq) && value.seq >= 0 ? value.seq : 0,
      clock: Number.isSafeInteger(value.clock) && value.clock >= 0 ? value.clock : 0,
      names: isObject(value.names) ? Object.fromEntries(Object.entries(value.names).filter(([id, name]) => merge.INSTANCE_ID.test(id) && typeof name === 'string').map(([id, name]) => [id, cleanName(name)])) : {},
    };
    return true;
  }
  // Written in order, so the last rename holds the newest state.
  const saveState = () => serial(META_QUEUE, () => writeFileAtomic(syncDir, stateFile, JSON.stringify(meta)));
  // A change number is taken before its file is written, and the write takes a moment. Until it is on disk the number is "on its way" (`onTheirWay`):
  // a page made meanwhile stops before the lowest such number, and the newest number told to a peer is below it, so a peer never records a number
  // as had while its entry was missing from the page ("Change numbers and pages" in docs/design/mind-maps.md).
  const onTheirWay = new Set();
  const nextSeq = () => { meta.seq += 1; onTheirWay.add(meta.seq); return meta.seq; };
  const written = entry => { if (entry && entry.sync && entry.sync.seq) onTheirWay.delete(entry.sync.seq); };
  // The newest change number whose entry, and every one before it, is on disk.
  const settledSeq = () => (onTheirWay.size ? Math.min(...onTheirWay) - 1 : meta.seq);
  function tick() {
    meta.clock = Math.max(now().getTime(), meta.clock + 1);
    return meta.clock;
  }
  function observe(sync) {
    if (sync.at > meta.clock) meta.clock = sync.at;
    if (sync.seq > meta.seq) meta.seq = sync.seq;
    if (sync.by && sync.by_name && meta.names[sync.by] !== sync.by_name && sync.by !== me().instance_id) meta.names[sync.by] = sync.by_name;
  }
  const nameOf = by => (by === me().instance_id ? me().name : meta.names[by] || '');
  // A new version made here, after `base` (the version vector it follows, or none for a new map).
  function ownVersion(base = null) {
    const self = me();
    const vv = { ...(base || {}) };
    vv[self.instance_id] = (vv[self.instance_id] || 0) + 1;
    return { vv, at: tick(), by: self.instance_id, by_name: self.name, seq: nextSeq() };
  }

  // ---- Tombstones ----
  function tombFrom(value, id) {
    if (!isObject(value) || value.id !== id || typeof value.deleted_at !== 'string') return null;
    const sync = syncOf(value);
    if (!sync) return null;
    return { kind: 'tomb', id, deleted_at: value.deleted_at, revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0, sync };
  }
  async function loadTombs() {
    tombs.clear();
    for (const name of await fs.readdir(tombDir)) {
      const match = MAP_FILE.exec(name);
      if (!match) continue;
      let value = null;
      try { value = JSON.parse(await fs.readFile(tombOf(match[1]), 'utf8')); } catch { value = null; }
      const tomb = tombFrom(value, match[1]);
      if (tomb) { tombs.set(tomb.id, tomb); observe(tomb.sync); }
    }
    await purgeTombs();
  }
  const tombRecord = tomb => ({ id: tomb.id, deleted_at: tomb.deleted_at, revision: tomb.revision, sync: tomb.sync });
  async function writeTomb(tomb) {
    try {
      if (hooks.beforeWrite) await hooks.beforeWrite(tomb);
      tombs.set(tomb.id, tomb);
      await writeFileAtomic(tombDir, tombOf(tomb.id), JSON.stringify(tombRecord(tomb)));
    } finally { written(tomb); }
  }
  async function dropTomb(id) {
    if (!tombs.has(id)) return;
    tombs.delete(id);
    await fs.rm(tombOf(id), { force: true });
  }
  // Tombstones older than TOMB_DAYS go: by then every engine that was online in that time has the delete (a peer away longer can bring the map back).
  async function purgeTombs() {
    const oldest = now().getTime() - TOMB_DAYS * DAY;
    let removed = 0;
    for (const tomb of [...tombs.values()]) {
      const when = Date.parse(tomb.deleted_at);
      if (Number.isFinite(when) && when < oldest) {
        await serial(tomb.id, () => (tombs.get(tomb.id) === tomb ? dropTomb(tomb.id) : null));
        removed += 1;
      }
    }
    return removed;
  }

  // ---- Reading ----
  // The stored map, or null when it is missing or corrupt.
  async function load(id) {
    let text;
    try { text = await fs.readFile(fileOf(id), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const record = parseRecord(text, id);
    if (!record) corrupt(id);
    return record;
  }
  // The entry of an id for the merge: the map ({ kind: 'map', ...record, sync }), its tombstone, or null.
  async function entryOf(id) {
    const record = await load(id);
    if (record) {
      const sync = syncOf(record);
      if (sync) return { kind: 'map', ...record, sync };
    }
    return tombs.get(id) || null;
  }

  async function mapIds() {
    const ids = [];
    for (const name of await fs.readdir(dir)) {
      const match = MAP_FILE.exec(name);
      if (match) ids.push(match[1]);
    }
    return ids;
  }

  // The summary of one file: from memory when its size and time have not changed, else read from the disk. null when it is gone or corrupt.
  async function summarize(id) {
    let stat;
    try { stat = await fs.stat(fileOf(id)); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const signature = `${stat.mtimeMs}:${stat.size}`;
    const cached = known.get(id);
    if (cached && cached.signature === signature) return cached;
    let text;
    try { text = await fs.readFile(fileOf(id), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const record = parseRecord(text, id);
    if (!record) corrupt(id);
    const entry = record
      ? { signature, summary: { id: record.id, title: record.title, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at, size: stat.size }, sync: syncOf(record), cache: isObject(record.cache) ? record.cache : null }
      : { signature, summary: null, sync: null, cache: null };
    known.set(id, entry);
    return entry;
  }

  // Every map file read (eight at a time, from memory when unchanged): [{ id, summary, sync, cache }] of the readable ones.
  async function readAll() {
    const ids = await mapIds();
    const present = new Set(ids);
    for (const id of known.keys()) if (!present.has(id)) known.delete(id);
    const out = [];
    for (let start = 0; start < ids.length; start += LIST_BATCH) {
      const batch = ids.slice(start, start + LIST_BATCH);
      const read = await Promise.all(batch.map(summarize));
      read.forEach((entry, index) => { if (entry && entry.summary) out.push({ id: batch[index], ...entry }); });
    }
    return out;
  }

  // A map without a version (from before, or put back from the trash by hand) gets one now, and a map next to its own tombstone (put back by hand)
  // wins over it: both count as a change here, so they travel.
  async function adopt(id, options) {
    return serial(id, async () => {
      const record = await load(id);
      if (!record) return;
      const sync = syncOf(record);
      const tomb = tombs.get(id);
      if (sync && !tomb) return;
      const self = me();
      const base = merge.joined(sync ? sync.vv : {}, tomb ? tomb.sync.vv : {});
      const version = sync || tomb ? ownVersion(base) : { vv: { [self.instance_id]: 1 }, at: Math.max(Date.parse(record.updated_at) || 0, 0), by: self.instance_id, by_name: self.name, seq: nextSeq() };
      if (version.at > meta.clock) meta.clock = version.at;
      await writeAtomic({ ...record, sync: version }, options);
      if (tomb) await dropTomb(id);
    });
  }

  // The migration, in the background: every file without a version (from before copies, or written into the folder behind the server's back) and
  // every file next to its own tombstone is adopted, one at a time with a pause between them, so requests keep their turn (each id's queue is
  // shared with the page's writes). The folder is synced once at the end. A request never waits for it: until a file has its version it is listed
  // (with no "edited on") and travels from its first round after.
  let migrating = null;
  let migrateAgain = false;
  function migrate() {
    if (migrating) { migrateAgain = true; return migrating; }
    migrating = (async () => {
      do {
        migrateAgain = false;
        const todo = (await readAll()).filter(entry => !entry.sync || tombs.has(entry.id)).map(entry => entry.id);
        for (const id of todo) {
          await adopt(id, { durable: false });
          await new Promise(resolve => setImmediate(resolve));
        }
        if (todo.length) {
          await syncFolder(dir);
          await saveState();
          changed();
        }
      } while (migrateAgain);
    })().catch(error => log(`Mind maps: the migration of map files failed (${error.code || error.name})`)).finally(() => { migrating = null; });
    return migrating;
  }
  // Resolves when no migration is running (tests).
  const settled = async () => { while (migrating) await migrating; };

  function checkData(value) {
    if (!isObject(value)) throw invalid('The map data must be a JSON object');
    let text;
    // Extremely deep nesting overflows JSON.stringify.
    try { text = JSON.stringify(value); } catch { throw invalid('The map data must be a JSON object'); }
    if (Buffer.byteLength(text, 'utf8') > maxDataBytes) throw tooLarge();
    return value;
  }

  function checkId(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  }

  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* a listener's own failure */ } } };
  // The page's summary of a map: who changed it last ("edited on").
  const pageSummary = entry => ({ ...entry.summary, by: entry.sync ? entry.sync.by : null, by_name: entry.sync ? nameOf(entry.sync.by) || entry.sync.by_name : null });

  async function list() {
    await prepare();
    const all = await readAll();
    if (all.some(entry => !entry.sync || tombs.has(entry.id))) void migrate();
    const maps = all.map(pageSummary);
    maps.sort((a, b) => (a.updated_at === b.updated_at ? a.id.localeCompare(b.id) : (a.updated_at < b.updated_at ? 1 : -1)));
    return maps;
  }

  async function get(id) {
    checkId(id);
    await prepare();
    const record = await load(id);
    if (!record) throw notFound();
    return detailOf(record);
  }

  // What the page asks while a map is open: whether it changed (its revision) and where it was changed last.
  async function head(id) {
    checkId(id);
    await prepare();
    const entry = await summarize(id);
    if (!entry || !entry.summary) throw notFound();
    const summary = pageSummary(entry);
    return { id, title: summary.title, revision: summary.revision, updated_at: summary.updated_at, by: summary.by, by_name: summary.by_name };
  }

  async function create(body = {}) {
    checkBody(body);
    const title = body.title === undefined ? DEFAULT_TITLE : cleanTitle(body.title);
    const data = body.data === undefined ? null : checkData(body.data);
    const record = await serial(CREATE_QUEUE, async () => {
      await prepare();
      if ((await mapIds()).length >= maxMaps) throw new MindmapError(409, 'MINDMAP_LIMIT', 'Too many mind maps (limit: 2000); delete some first');
      const time = now().toISOString();
      const made = { id: crypto.randomUUID(), title, data, revision: 1, created_at: time, updated_at: time, sync: ownVersion() };
      await writeAtomic(made);
      return made;
    });
    await saveState();
    changed();
    return detailOf(record);
  }

  async function update(id, body) {
    checkId(id);
    checkBody(body);
    const hasTitle = body.title !== undefined;
    const hasData = body.data !== undefined;
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw invalid('The revision must be a whole number');
    if (!hasTitle && !hasData) throw invalid('Send a title or map data to change');
    const title = hasTitle ? cleanTitle(body.title) : undefined;
    const data = hasData ? checkData(body.data) : undefined;
    const next = await serial(id, async () => {
      await prepare();
      const current = await load(id);
      if (!current) throw notFound();
      if (body.revision !== current.revision) {
        throw new MindmapError(409, 'MINDMAP_CONFLICT', 'The mind map changed elsewhere; reload it before saving', { current_revision: current.revision });
      }
      const sync = syncOf(current);
      const written = {
        ...current,
        ...(hasTitle ? { title } : {}),
        ...(hasData ? { data } : {}),
        revision: current.revision + 1,
        updated_at: now().toISOString(),
        sync: { ...ownVersion(sync ? sync.vv : null), ...(sync && sync.conflict_of ? { conflict_of: sync.conflict_of } : {}) },
      };
      await writeAtomic(written);
      return written;
    });
    await saveState();
    changed();
    return { id: next.id, title: next.title, revision: next.revision, updated_at: next.updated_at };
  }

  async function remove(id) {
    checkId(id);
    await serial(id, async () => {
      await prepare();
      const record = await load(id);
      const sync = record ? syncOf(record) : null;
      const time = now();
      try {
        await fs.rename(fileOf(id), path.join(trashDir, `${id}-${time.toISOString().replace(/[:.]/g, '-')}.json`));
      } catch (error) {
        if (error.code === 'ENOENT') throw notFound();
        throw error;
      }
      known.delete(id);
      await syncFolder(dir);
      await syncFolder(trashDir);
      // The delete travels: a tombstone that has seen this version (a corrupt file's version is unknown: only this engine's part).
      await writeTomb({ kind: 'tomb', id, deleted_at: time.toISOString(), revision: record ? record.revision : 0, sync: ownVersion(sync ? sync.vv : (tombs.get(id) || {}).sync?.vv) });
    });
    await saveState();
    changed();
  }

  // ---- For the sync (services/mindmap-sync.js) ----
  const maxSeq = () => settledSeq();

  // A peer's entry, checked like one made here, or null.
  function cleanIncoming(raw) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id)) return null;
    const sync = syncOf({ sync: isObject(raw.sync) ? { ...raw.sync, seq: 0 } : null });
    if (!sync) return null;
    sync.by_name = cleanName(sync.by_name);
    if (raw.deleted_at !== undefined) {
      if (typeof raw.deleted_at !== 'string' || !TIME_TEXT.test(raw.deleted_at) || !Number.isFinite(Date.parse(raw.deleted_at))) return null;
      return { kind: 'tomb', id: raw.id, deleted_at: raw.deleted_at, revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0, sync };
    }
    let title;
    try { title = cleanTitle(raw.title); } catch { return null; }
    if (raw.data !== null) {
      try { checkData(raw.data); } catch { return null; }
    }
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) return null;
    for (const field of ['created_at', 'updated_at']) {
      if (typeof raw[field] !== 'string' || !TIME_TEXT.test(raw[field]) || !Number.isFinite(Date.parse(raw[field]))) return null;
    }
    return { kind: 'map', id: raw.id, title, data: raw.data, revision: raw.revision, created_at: raw.created_at, updated_at: raw.updated_at, sync };
  }

  // Stores what the merge decided for one id. `seq`: the change number to give it (0 on a company computer for a copy of its home's).
  async function store(local, result, seq, { mirror = false } = {}) {
    const sync = { ...result.sync, seq };
    if (result.kind === 'map') {
      const revision = mirror ? result.revision : merge.revisionOf(local, result);
      const record = { ...detailOf(result), revision, sync };
      if (local && local.kind === 'map' && local.cache) record.cache = local.cache;
      await writeAtomic(record);
      if (local && local.kind === 'tomb') await dropTomb(result.id);
      return;
    }
    if (local && local.kind === 'map') {
      await fs.rename(fileOf(result.id), path.join(trashDir, `${result.id}-${now().toISOString().replace(/[:.]/g, '-')}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      known.delete(result.id);
      await syncFolder(dir);
    }
    await writeTomb({ ...result, revision: local && local.kind === 'map' ? local.revision : result.revision, sync });
  }

  // Applies a peer's entries, each against what is stored here (services/mindmap-merge.js), one id at a time. Returns how many changed something.
  // `cacheOnly` (a company computer reading its home): a result that is exactly the home's entry gets no change number (it is not passed on), and a
  // map that has nothing waiting here (its number at most `handedOver`) takes the home's revision, so the page sees the same numbers either way.
  async function applyEntries(items, { cacheOnly = false, handedOver = 0 } = {}) {
    await prepare();
    let applied = 0;
    const changedIds = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const incoming = cleanIncoming(raw);
      if (!incoming) continue;
      if (incoming.kind === 'tomb' && Date.parse(incoming.deleted_at) < now().getTime() - TOMB_DAYS * DAY) continue;
      observe(incoming.sync);
      const copy = await serial(incoming.id, async () => {
        const local = await entryOf(incoming.id);
        const { store: result, copy: extra } = merge.decide(local, incoming);
        if (!result) return extra;
        const plain = cacheOnly && result === incoming;
        const waiting = local && local.sync && local.sync.seq > handedOver;
        await store(local, result, plain ? 0 : nextSeq(), { mirror: cacheOnly && plain && !waiting });
        applied += 1;
        changedIds.push(incoming.id);
        return extra;
      });
      if (copy) {
        await serial(copy.id, async () => {
          const local = await entryOf(copy.id);
          const { store: result } = merge.decide(local, copy);
          if (!result) return;
          await store(local, result, nextSeq());
          applied += 1;
          changedIds.push(copy.id);
        });
      }
    }
    if (applied) await saveState();
    return { applied, ids: changedIds };
  }

  // The entries changed after change number `after`, in number order, at most `maxBytes` of map JSON (one map always goes, however large) and
  // `maxRows` entries: { maps, tombstones, after, next, more }. `next`: the number to ask after next time.
  async function exportPage(after, { maxBytes = 2 * 1024 * 1024, maxRows = 500 } = {}) {
    await prepare();
    // Taken before the files are read: an entry written after this has a larger number and goes in a later page.
    const newest = settledSeq();
    const inPage = seq => seq > after && seq <= newest;
    const rows = [
      ...(await readAll()).filter(entry => entry.sync && inPage(entry.sync.seq)).map(entry => ({ kind: 'map', id: entry.id, seq: entry.sync.seq })),
      ...[...tombs.values()].filter(tomb => inPage(tomb.sync.seq)).map(tomb => ({ kind: 'tomb', id: tomb.id, seq: tomb.sync.seq, tomb })),
    ].sort((a, b) => a.seq - b.seq);
    const page = { maps: [], tombstones: [], after, next: Math.max(newest, after), more: false };
    let bytes = 0;
    let last = after;
    for (const row of rows) {
      if (page.maps.length + page.tombstones.length >= maxRows) { page.more = true; break; }
      let wire;
      if (row.kind === 'tomb') wire = wireOf(row.tomb);
      else {
        const entry = await entryOf(row.id);
        if (!entry || entry.kind !== 'map' || entry.sync.seq !== row.seq) { last = Math.max(last, row.seq); continue; } // changed meanwhile: a later page has it
        wire = wireOf(entry);
      }
      const size = row.kind === 'map' ? Buffer.byteLength(JSON.stringify(wire), 'utf8') : 256;
      if (bytes && bytes + size > maxBytes) { page.more = true; break; }
      bytes += size;
      (row.kind === 'map' ? page.maps : page.tombstones).push(wire);
      last = row.seq;
    }
    if (page.more) page.next = last;
    return page;
  }

  // The current entries of some ids (what a company computer refreshes from its home): { maps, tombstones, missing }.
  async function exportIds(ids) {
    await prepare();
    const out = { maps: [], tombstones: [], missing: [] };
    for (const id of ids) {
      if (typeof id !== 'string' || !UUID.test(id)) continue;
      const entry = await entryOf(id);
      if (!entry) out.missing.push(id);
      else (entry.kind === 'map' ? out.maps : out.tombstones).push(wireOf(entry));
    }
    return out;
  }

  // The summaries of every map with their versions (what a company computer lists through its home).
  async function exportSummaries() {
    await prepare();
    return (await readAll()).filter(entry => entry.sync).map(entry => ({ ...pageSummary(entry), vv: entry.sync.vv }));
  }

  // What this folder holds, for a company computer: [{ id, kind, seq, vv, opened_at, summary }].
  async function localEntries() {
    await prepare();
    return [
      ...(await readAll()).filter(entry => entry.sync).map(entry => ({ id: entry.id, kind: 'map', seq: entry.sync.seq, vv: entry.sync.vv, opened_at: entry.cache && Number.isSafeInteger(entry.cache.opened_at) ? entry.cache.opened_at : 0, summary: pageSummary(entry) })),
      ...[...tombs.values()].map(tomb => ({ id: tomb.id, kind: 'tomb', seq: tomb.sync.seq, vv: tomb.sync.vv, opened_at: 0, summary: null })),
    ];
  }

  // A company computer remembers when a map was last opened here (it keeps maps opened in the last days as its cache).
  async function noteOpened(id) {
    checkId(id);
    await prepare();
    await serial(id, async () => {
      const record = await load(id);
      const at = now().getTime();
      // At most once an hour: a large map is not written again on every open.
      if (!record || (isObject(record.cache) && Number.isSafeInteger(record.cache.opened_at) && at - record.cache.opened_at < 60 * 60 * 1000)) return;
      await writeAtomic({ ...record, cache: { opened_at: at } });
    });
  }

  // Removes entries from this folder without a tombstone: a company computer's cache dropping what its home keeps (never a delete).
  async function forget(ids) {
    await prepare();
    let removed = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !UUID.test(id)) continue;
      await serial(id, async () => {
        const record = await fs.rm(fileOf(id)).then(() => true, () => false);
        known.delete(id);
        if (tombs.has(id)) { await dropTomb(id); removed += 1; } else if (record) removed += 1;
      });
    }
    if (removed) await syncFolder(dir);
    return removed;
  }

  const onChanged = listener => { listeners.add(listener); return () => listeners.delete(listener); };

  return {
    list, get, head, create, update, remove, dir, trashDir, syncDir,
    maxSeq, applyEntries, exportPage, exportIds, exportSummaries, localEntries, noteOpened, forget, purgeTombs, onChanged, prepare, settled,
    identity: me,
  };
}

// A map id as the service makes them: a lowercase version 4 UUID. Used by the Client's proxy to refuse a bad id before anything is forwarded.
const isMindmapId = id => typeof id === 'string' && UUID.test(id);

// The one service of this server's data folder, shared by /api/mindmaps, /v1/mindmaps and the sync: its queues are what make writes of one map, and
// creates against the map limit, run one at a time, so a second instance on the same folder would break that.
let shared = null;
function getMindmapService() {
  if (!shared) {
    shared = createMindmapService({
      dataDir: dataHome.paths().root,
      identity: () => {
        try {
          const { engine_id: instanceId, name } = require('./engine-identity').getEngineIdentity();
          return { instance_id: instanceId, name };
        } catch { return null; }
      },
    });
  }
  return shared;
}

module.exports = { createMindmapService, getMindmapService, isMindmapId, MindmapError, LIMITS, TOMB_DAYS, UUID };

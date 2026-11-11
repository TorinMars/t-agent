// Mind maps: one JSON file per map in <data folder>/mindmaps (see "Mind maps" in DESIGN.md). Self-contained: no database table, and it never reads or
// changes tasks, work directories, terminals, agent chat or terminal activity.
//
// - A file is { id, title, data, revision, created_at, updated_at }. `data` is opaque to the server: a JSON object, or null until the page first saves.
// - The app has one user (services/single-user.js), so maps are not scoped per owner; this matches the items of services/attention.js.
// - Ids are server-made UUIDs, checked before any path is built: a value that is not one is simply "not found".
// - Writes go to a temp file in the same folder, are fsynced and then renamed, and run one at a time per id. Creates run one at a time too, so the
//   map limit holds under concurrent creates.
// - Deleting moves the file to trash/<id>-<time>.json, from where it can be moved back by hand.
// - A corrupt file is left alone and treated as absent, with one log line naming only the id. Map content is never logged: not even a JSON.parse
//   message, which can quote it.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const dataHome = require('../lib/data-home');

const LIMITS = { dataBytes: 8 * 1024 * 1024, maps: 2000, titleChars: 200 };
const DEFAULT_TITLE = 'Untitled map';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_SUFFIX = '.tmp';
const CREATE_QUEUE = 'create';
const LIST_BATCH = 8; // files read at once by the list: at most 8 maps of 8 MB in memory
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAP_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;

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

function parseRecord(text, id) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return isRecord(value, id) ? value : null;
}

const summaryOf = (record, size) => ({ id: record.id, title: record.title, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at, size });
const detailOf = record => ({ id: record.id, title: record.title, data: record.data, revision: record.revision, created_at: record.created_at, updated_at: record.updated_at });

function createMindmapService({ dataDir, now = () => new Date(), log = message => console.warn(message), maxMaps = LIMITS.maps, maxDataBytes = LIMITS.dataBytes } = {}) {
  if (!dataDir) throw new Error('createMindmapService needs the data folder');
  const dir = dataHome.layout(dataDir, {}).mindmapsDir;
  const trashDir = path.join(dir, 'trash');
  const fileOf = id => path.join(dir, `${id}.json`);
  const queues = new Map();
  // id -> { signature, summary } for the list, so that an unchanged file is not read again. summary is null for a corrupt file (logged once per change).
  const known = new Map();
  let ready = null;

  function prepare() {
    if (!ready) {
      ready = (async () => {
        await fs.mkdir(trashDir, { recursive: true, mode: DIR_MODE });
        dataHome.tighten(dir, DIR_MODE);
        dataHome.tighten(trashDir, DIR_MODE);
        // One server per data folder (server.lock), and nothing is written before this runs: any temp file here was left by a crash.
        for (const name of await fs.readdir(dir)) {
          if (name.endsWith(TEMP_SUFFIX)) await fs.rm(path.join(dir, name), { force: true });
        }
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

  async function writeAtomic(record) {
    const temp = path.join(dir, `.${record.id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', FILE_MODE);
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, fileOf(record.id));
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    known.delete(record.id);
    await syncFolder(dir);
  }

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
    if (cached && cached.signature === signature) return cached.summary;
    let text;
    try { text = await fs.readFile(fileOf(id), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const record = parseRecord(text, id);
    if (!record) corrupt(id);
    const summary = record ? summaryOf(record, stat.size) : null;
    known.set(id, { signature, summary });
    return summary;
  }

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

  async function list() {
    await prepare();
    const ids = await mapIds();
    const present = new Set(ids);
    for (const id of known.keys()) if (!present.has(id)) known.delete(id);
    const summaries = [];
    for (let start = 0; start < ids.length; start += LIST_BATCH) {
      summaries.push(...await Promise.all(ids.slice(start, start + LIST_BATCH).map(summarize)));
    }
    const maps = summaries.filter(Boolean);
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

  async function create(body = {}) {
    checkBody(body);
    const title = body.title === undefined ? DEFAULT_TITLE : cleanTitle(body.title);
    const data = body.data === undefined ? null : checkData(body.data);
    return serial(CREATE_QUEUE, async () => {
      await prepare();
      if ((await mapIds()).length >= maxMaps) throw new MindmapError(409, 'MINDMAP_LIMIT', 'Too many mind maps (limit: 2000); delete some first');
      const time = now().toISOString();
      const record = { id: crypto.randomUUID(), title, data, revision: 1, created_at: time, updated_at: time };
      await writeAtomic(record);
      return detailOf(record);
    });
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
    return serial(id, async () => {
      await prepare();
      const current = await load(id);
      if (!current) throw notFound();
      if (body.revision !== current.revision) {
        throw new MindmapError(409, 'MINDMAP_CONFLICT', 'The mind map changed elsewhere; reload it before saving', { current_revision: current.revision });
      }
      const next = {
        ...current,
        ...(hasTitle ? { title } : {}),
        ...(hasData ? { data } : {}),
        revision: current.revision + 1,
        updated_at: now().toISOString(),
      };
      await writeAtomic(next);
      return { id: next.id, title: next.title, revision: next.revision, updated_at: next.updated_at };
    });
  }

  async function remove(id) {
    checkId(id);
    return serial(id, async () => {
      await prepare();
      const time = now().toISOString().replace(/[:.]/g, '-');
      try {
        await fs.rename(fileOf(id), path.join(trashDir, `${id}-${time}.json`));
      } catch (error) {
        if (error.code === 'ENOENT') throw notFound();
        throw error;
      }
      known.delete(id);
      await syncFolder(dir);
      await syncFolder(trashDir);
    });
  }

  return { list, get, create, update, remove, dir, trashDir };
}

// A map id as the service makes them: a lowercase version 4 UUID. Used by the Client's proxy to refuse a bad id before anything is forwarded.
const isMindmapId = id => typeof id === 'string' && UUID.test(id);

// The one service of this server's data folder, shared by /api/mindmaps and /v1/mindmaps: its queues are what make writes of one map, and creates
// against the map limit, run one at a time, so a second instance on the same folder would break that.
let shared = null;
function getMindmapService() {
  if (!shared) shared = createMindmapService({ dataDir: dataHome.paths().root });
  return shared;
}

module.exports = { createMindmapService, getMindmapService, isMindmapId, MindmapError, LIMITS };

// Recordings of the browser extension ("Browser extension" in DESIGN.md, contract section 6): `tcli browser record start` makes the extension send
// `record.items` events (services/browser-bridge.js), and they are appended here, redacted again on this side (lib/browser-redact.js redactDeep):
//   <data dir>/browser-recordings/<recording_id>.jsonl   one item per line (0600)
//   <data dir>/browser-recordings/<recording_id>.json    the summary: { recording_id, tab_id, browser_id, started_at, stopped_at, stop_reason,
//                                                         origins, items, bytes, kinds, dropped_items, truncated, task_id, terminal_id }
// Limits: 200 MiB per recording (items after that are dropped and counted, `truncated: true`), 2 GiB in all (the oldest recordings are removed
// first), and 14 days (counted from the last item or the stop; checked at start, every 6 hours and after appends).
const fs = require('node:fs');
const path = require('node:path');
const { redactDeep } = require('../lib/browser-redact');

const MiB = 1024 * 1024;
const DEFAULTS = { maxRecordingBytes: 200 * MiB, maxTotalBytes: 2048 * MiB, keepMs: 14 * 24 * 3600 * 1000, cleanupEveryMs: 6 * 3600 * 1000 };
const ID = /^rec_[A-Za-z0-9]{1,24}_[A-Za-z0-9]{1,16}$/;
const MAX_ORIGINS = 20;
const MAX_ITEMS_PER_BATCH = 5000;

class RecordingError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

const iso = ms => new Date(ms).toISOString();
const originOf = url => { try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : null; } catch { return null; } };

function createBrowserRecordings({ dir, now = Date.now, ...limits } = {}) {
  if (!dir) throw new Error('createBrowserRecordings needs dir');
  const { maxRecordingBytes, maxTotalBytes, keepMs, cleanupEveryMs } = { ...DEFAULTS, ...limits };
  const summaries = new Map(); // id -> summary (kept in memory, written after each change)
  let loaded = false;

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const itemsPath = id => path.join(dir, `${id}.jsonl`);
  const summaryPath = id => path.join(dir, `${id}.json`);
  const validId = id => typeof id === 'string' && ID.test(id);

  function load() {
    if (loaded) return;
    loaded = true;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!validId(id)) continue;
      try {
        const summary = JSON.parse(fs.readFileSync(summaryPath(id), 'utf8'));
        if (summary && summary.recording_id === id) {
          try { summary.bytes = fs.statSync(itemsPath(id)).size; } catch { summary.bytes = 0; }
          summaries.set(id, summary);
        }
      } catch { /* a broken summary is left alone */ }
    }
  }

  function save(summary) {
    ensureDir();
    const file = summaryPath(summary.recording_id);
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(summary, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function blank(id, info = {}) {
    const at = iso(now());
    return {
      recording_id: id, tab_id: Number.isInteger(info.tab_id) ? info.tab_id : null, browser_id: info.browser_id || null,
      started_at: info.started_at || at, stopped_at: null, stop_reason: null, last_item_at: null,
      origins: [], items: 0, bytes: 0, kinds: {}, dropped_items: 0, truncated: false,
      task_id: info.task_id === undefined ? null : info.task_id, terminal_id: info.terminal_id === undefined ? null : info.terminal_id,
    };
  }

  // Called when record.start answered: who started it (the task and terminal of the tcli call) and where.
  function start(id, info = {}) {
    load();
    if (!validId(id)) throw new RecordingError('BAD_RECORDING_ID', 'The recording id is not valid', 400);
    const summary = summaries.get(id) || blank(id, info);
    for (const field of ['tab_id', 'browser_id', 'task_id', 'terminal_id']) if (info[field] !== undefined && info[field] !== null) summary[field] = info[field];
    const origin = originOf(info.url);
    if (origin && !summary.origins.includes(origin) && summary.origins.length < MAX_ORIGINS) summary.origins.push(origin);
    summaries.set(id, summary);
    save(summary);
    return { ...summary };
  }

  // One `record.items` batch. Items of an unknown recording (it was started before this server ran) start a summary without a task.
  function append(id, items, info = {}) {
    load();
    if (!validId(id)) throw new RecordingError('BAD_RECORDING_ID', 'The recording id is not valid', 400);
    if (!Array.isArray(items)) throw new RecordingError('BAD_ITEMS', 'items must be a list', 400);
    let summary = summaries.get(id);
    if (!summary) { summary = blank(id, info); summaries.set(id, summary); }
    const lines = [];
    let added = 0;
    for (const item of items.slice(0, MAX_ITEMS_PER_BATCH)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const clean = redactDeep(item);
      const line = `${JSON.stringify(clean)}\n`;
      const size = Buffer.byteLength(line);
      if (summary.bytes + added + size > maxRecordingBytes) { summary.dropped_items += 1; summary.truncated = true; continue; }
      lines.push(line);
      added += size;
      summary.items += 1;
      const kind = typeof clean.kind === 'string' ? clean.kind.slice(0, 32) : 'other';
      summary.kinds[kind] = (summary.kinds[kind] || 0) + 1;
      const origin = originOf(clean.url);
      if (origin && !summary.origins.includes(origin) && summary.origins.length < MAX_ORIGINS) summary.origins.push(origin);
      if (summary.tab_id === null && Number.isInteger(clean.tab_id)) summary.tab_id = clean.tab_id;
    }
    summary.dropped_items += Math.max(0, items.length - MAX_ITEMS_PER_BATCH);
    if (lines.length) {
      ensureDir();
      fs.appendFileSync(itemsPath(id), lines.join(''), { mode: 0o600 });
      summary.bytes += added;
      summary.last_item_at = iso(now());
    }
    save(summary);
    enforceTotal(id);
    return { appended: lines.length, items: summary.items, bytes: summary.bytes, truncated: summary.truncated };
  }

  function stop(id, { reason = 'stopped', stopped_at } = {}) {
    load();
    if (!validId(id)) return null;
    const summary = summaries.get(id);
    if (!summary) return null;
    if (!summary.stopped_at) {
      summary.stopped_at = stopped_at || iso(now());
      summary.stop_reason = typeof reason === 'string' ? reason.slice(0, 200) : 'stopped';
      save(summary);
    }
    return { ...summary };
  }

  const lastActivity = summary => Date.parse(summary.stopped_at || summary.last_item_at || summary.started_at) || 0;

  function removeFiles(id) {
    summaries.delete(id);
    for (const file of [itemsPath(id), summaryPath(id)]) { try { fs.rmSync(file, { force: true }); } catch { /* gone already */ } }
  }

  // The oldest recordings go first until all of them fit in maxTotalBytes; the recording being written (`keep`) is the last to go.
  function enforceTotal(keep = null) {
    let total = 0;
    for (const summary of summaries.values()) total += summary.bytes;
    if (total <= maxTotalBytes) return;
    const oldest = [...summaries.values()].sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0));
    for (const summary of oldest) {
      if (total <= maxTotalBytes) break;
      if (summary.recording_id === keep) continue;
      total -= summary.bytes;
      removeFiles(summary.recording_id);
    }
  }

  function cleanup() {
    load();
    const limit = now() - keepMs;
    let removed = 0;
    for (const summary of [...summaries.values()]) {
      if (lastActivity(summary) < limit) { removeFiles(summary.recording_id); removed += 1; }
    }
    enforceTotal();
    return removed;
  }

  function list() {
    load();
    return [...summaries.values()].map(summary => ({ ...summary })).sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));
  }

  function get(id) {
    load();
    const summary = validId(id) ? summaries.get(id) : null;
    if (!summary) throw new RecordingError('RECORDING_NOT_FOUND', 'There is no recording with this id', 404);
    return { ...summary };
  }

  // The items file as a stream (JSON lines), or an empty stream for a recording without items yet.
  function itemsStream(id) {
    get(id);
    const file = itemsPath(id);
    if (!fs.existsSync(file)) return require('node:stream').Readable.from([]);
    return fs.createReadStream(file);
  }

  function remove(id) {
    get(id);
    removeFiles(id);
    return { removed: true, recording_id: id };
  }

  let timer = null;
  function startCleanup() {
    try { cleanup(); } catch { /* the next run tries again */ }
    if (!timer && cleanupEveryMs > 0) {
      timer = setInterval(() => { try { cleanup(); } catch { /* the next run tries again */ } }, cleanupEveryMs);
      if (timer.unref) timer.unref();
    }
  }
  function stopCleanup() { if (timer) clearInterval(timer); timer = null; }

  return { dir, start, append, stop, list, get, itemsStream, remove, cleanup, startCleanup, stopCleanup, validId };
}

let shared = null;
function getBrowserRecordings() {
  if (!shared) {
    const root = require('../lib/data-home').paths().root;
    shared = createBrowserRecordings({ dir: path.join(root, 'browser-recordings') });
  }
  return shared;
}

module.exports = { createBrowserRecordings, getBrowserRecordings, RecordingError, RECORDING_LIMITS: DEFAULTS };

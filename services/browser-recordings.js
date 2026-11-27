// Recordings of the browser extension ("Browser extension" in docs/design/browser-extension.md, contract section 6): `tcli browser record start` makes the extension send
// `record.items` events (services/browser-bridge.js), and they are appended here, redacted again on this side (lib/browser-redact.js redactDeep):
//   <data dir>/browser-recordings/<recording_id>.jsonl   one item per line (0600)
//   <data dir>/browser-recordings/<recording_id>.json    the summary: { recording_id, tab_id, browser_id, started_at, stopped_at, stop_reason,
//                                                         origins, items, bytes, kinds, dropped_items, truncated, task_id, terminal_id,
//                                                         options? (the recording's filters: network, dom, bodies, types, drop_other_types,
//                                                         max_body_bytes; from extension 1.0.4), tabs? (items per tab id, at most
//                                                         MAX_TABS ids: a recording follows the tabs its page opens; older
//                                                         recordings have none), frames?, frame_bytes?, frames_dropped? (pictures,
//                                                         below) }
//   <data dir>/browser-recordings/<recording_id>.frames/<n>.jpg   the pictures of a recording made with --frames (0600, folder 0700)
// Limits: 200 MiB per recording (items after that are dropped and counted, `truncated: true`), 2 GiB in all (the oldest recordings are removed
// first), and 14 days (counted from the last item or the stop; checked at start, every 6 hours and after appends).
// Pictures ("Pictures of a recording" in docs/design/browser-extension.md): a `frame` item from the extension carries a masked JPEG in
// `data_base64`; it is written to its own file and the line keeps `{ kind: 'frame', for_seq, frame: <n>, file, bytes, width, height, mime }`
// without the image, so `record items` stays small. At most the recording's `max_frames` (200 by default, never over 500), 512 KiB each and
// 50 MiB per recording; past that one `{ kind: 'frame', skipped: 'limit' }` line notes it and the rest are counted in `frames_dropped`. The
// pictures count towards the 2 GiB of all recordings and go with their recording (removal, the 14 days).
// Reading: itemsStream (the file as it is), and filterItems / requests, which read it line by line through lib/browser-recording-query.js (the
// filters of `tcli browser record items` and the merge of `record requests`; "Reading recordings" in docs/design/tcli.md).
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { redactDeep } = require('../lib/browser-redact');
const { filterLines, mergeRequests } = require('../lib/browser-recording-query');

const MiB = 1024 * 1024;
const DEFAULTS = {
  maxRecordingBytes: 200 * MiB, maxTotalBytes: 2048 * MiB, keepMs: 14 * 24 * 3600 * 1000, cleanupEveryMs: 6 * 3600 * 1000,
  maxFrames: 500, defaultFrames: 200, maxFrameBytes: 512 * 1024, maxFrameTotalBytes: 50 * MiB,
};
const ID = /^rec_[A-Za-z0-9]{1,24}_[A-Za-z0-9]{1,16}$/;
const MAX_ORIGINS = 20;
const MAX_TABS = 20; // tab ids counted in the summary (the extension follows at most 10 per recording)
const MAX_ITEMS_PER_BATCH = 5000;

class RecordingError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

const iso = ms => new Date(ms).toISOString();
// The filters a recording was started with, as the extension reported them (only known keys and plain values are kept).
function cleanOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const out = {};
  for (const key of ['network', 'dom', 'bodies', 'drop_other_types', 'frames']) if (typeof options[key] === 'boolean') out[key] = options[key];
  if (Array.isArray(options.types)) out.types = options.types.filter(type => typeof type === 'string' && /^[A-Za-z]{1,32}$/.test(type)).slice(0, 32);
  else if (options.types === null) out.types = null;
  if (Number.isInteger(options.max_body_bytes) && options.max_body_bytes >= 0) out.max_body_bytes = options.max_body_bytes;
  else if (options.max_body_bytes === null) out.max_body_bytes = null;
  if (Number.isInteger(options.max_frames) && options.max_frames > 0) out.max_frames = options.max_frames;
  return out;
}
const originOf = url => { try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : null; } catch { return null; } };

function createBrowserRecordings({ dir, now = Date.now, ...limits } = {}) {
  if (!dir) throw new Error('createBrowserRecordings needs dir');
  const { maxRecordingBytes, maxTotalBytes, keepMs, cleanupEveryMs, maxFrames, defaultFrames, maxFrameBytes, maxFrameTotalBytes } = { ...DEFAULTS, ...limits };
  const summaries = new Map(); // id -> summary (kept in memory, written after each change)
  let loaded = false;

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const itemsPath = id => path.join(dir, `${id}.jsonl`);
  const summaryPath = id => path.join(dir, `${id}.json`);
  const framesDir = id => path.join(dir, `${id}.frames`);
  const frameName = n => `${String(n).padStart(6, '0')}.jpg`;
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
    const options = cleanOptions(info.options);
    if (options) summary.options = options;
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
      // A picture is not text: it leaves the item before the redaction (the extension masked it before it was taken) and goes to its own file.
      const { data_base64: picture, ...rest } = item;
      let clean = redactDeep(rest);
      let image = null;
      if (clean.kind === 'frame') {
        const framed = frameOf(summary, clean, picture);
        if (!framed) continue;
        ({ clean, image } = framed);
      }
      const line = `${JSON.stringify(clean)}\n`;
      const size = Buffer.byteLength(line);
      if (summary.bytes + added + size > maxRecordingBytes) { summary.dropped_items += 1; summary.truncated = true; continue; }
      if (image) writeFrame(id, summary, clean, image);
      lines.push(line);
      added += size;
      summary.items += 1;
      const kind = typeof clean.kind === 'string' ? clean.kind.slice(0, 32) : 'other';
      summary.kinds[kind] = (summary.kinds[kind] || 0) + 1;
      const origin = originOf(clean.url);
      if (origin && !summary.origins.includes(origin) && summary.origins.length < MAX_ORIGINS) summary.origins.push(origin);
      const tab = Number.isInteger(clean.tab) ? clean.tab : Number.isInteger(clean.tab_id) ? clean.tab_id : null;
      if (summary.tab_id === null && tab !== null) summary.tab_id = tab;
      if (tab !== null) {
        const tabs = summary.tabs || (summary.tabs = {});
        const key = String(tab);
        if (tabs[key] !== undefined || Object.keys(tabs).length < MAX_TABS) tabs[key] = (tabs[key] || 0) + 1;
      }
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

  // A `frame` item: the picture checked (a JPEG of at most maxFrameBytes) and counted against the recording's limits. Returns the line to
  // write (without the picture) and the bytes, or a `skipped` line, or null when the limit was noted already.
  function frameOf(summary, clean, picture) {
    const limit = Math.min(summary.options && Number.isInteger(summary.options.max_frames) ? summary.options.max_frames : defaultFrames, maxFrames);
    if (typeof picture !== 'string') return { clean: { ...clean, skipped: typeof clean.skipped === 'string' ? clean.skipped.slice(0, 40) : 'no picture' }, image: null };
    const image = /^[A-Za-z0-9+/]+={0,2}$/.test(picture) ? Buffer.from(picture, 'base64') : null;
    if (!image || image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) return { clean: { ...clean, skipped: 'not a JPEG' }, image: null };
    if (image.length > maxFrameBytes) return { clean: { ...clean, skipped: 'too large' }, image: null };
    if ((summary.frames || 0) >= limit || (summary.frame_bytes || 0) + image.length > maxFrameTotalBytes) {
      summary.frames_dropped = (summary.frames_dropped || 0) + 1;
      if (summary.frames_dropped > 1) return null;
      return { clean: { kind: 'frame', seq: clean.seq, at: clean.at, tab: clean.tab, tab_id: clean.tab_id, for_seq: clean.for_seq, skipped: 'limit' }, image: null };
    }
    const n = (summary.frames || 0) + 1;
    return { clean: { ...clean, frame: n, file: frameName(n), bytes: image.length, mime: 'image/jpeg' }, image };
  }
  function writeFrame(id, summary, clean, image) {
    fs.mkdirSync(framesDir(id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(framesDir(id), clean.file), image, { mode: 0o600 });
    summary.frames = clean.frame;
    summary.frame_bytes = (summary.frame_bytes || 0) + image.length;
  }

  // The picture of frame n of a recording, as { file, bytes }; FRAME_NOT_FOUND when there is none.
  function frame(id, n) {
    get(id);
    const number = typeof n === 'string' && /^\d{1,9}$/.test(n) ? Number(n) : n;
    if (!Number.isInteger(number) || number < 1) throw new RecordingError('FRAME_NOT_FOUND', 'There is no such picture in this recording', 404);
    const file = path.join(framesDir(id), frameName(number));
    let stat;
    try { stat = fs.statSync(file); } catch { throw new RecordingError('FRAME_NOT_FOUND', 'There is no such picture in this recording', 404); }
    return { file, bytes: stat.size };
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
    for (const file of [itemsPath(id), summaryPath(id), framesDir(id)]) { try { fs.rmSync(file, { force: true, recursive: true }); } catch { /* gone already */ } }
  }

  // The oldest recordings go first until all of them fit in maxTotalBytes; the recording being written (`keep`) is the last to go.
  function enforceTotal(keep = null) {
    const size = summary => summary.bytes + (summary.frame_bytes || 0);
    let total = 0;
    for (const summary of summaries.values()) total += size(summary);
    if (total <= maxTotalBytes) return;
    const oldest = [...summaries.values()].sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0));
    for (const summary of oldest) {
      if (total <= maxTotalBytes) break;
      if (summary.recording_id === keep) continue;
      total -= size(summary);
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

  // The items file line by line (an empty run for a recording without items yet). Throws RECORDING_NOT_FOUND at once, before the first line.
  function itemLines(id) {
    get(id);
    const file = itemsPath(id);
    return (async function* lines() {
      if (!fs.existsSync(file)) return;
      const input = fs.createReadStream(file);
      const reader = readline.createInterface({ input, crlfDelay: Infinity });
      try { for await (const line of reader) yield line; } finally { reader.close(); input.destroy(); } // also when the reader stops early
    })();
  }

  // The lines that pass a filter of lib/browser-recording-query.js parseItemFilter (an async iterator of JSON text without the newline).
  function filterItems(id, filter) {
    return filterLines(itemLines(id), filter);
  }

  // The requests of a recording, request and response merged (lib/browser-recording-query.js mergeRequests): { requests, left_out }.
  function requests(id, options) {
    return mergeRequests(itemLines(id), options);
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

  return { dir, start, append, stop, list, get, itemsStream, itemLines, filterItems, requests, frame, remove, cleanup, startCleanup, stopCleanup, validId };
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

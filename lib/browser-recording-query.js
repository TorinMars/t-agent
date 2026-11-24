'use strict';
// Reading a browser recording ("Reading recordings" in docs/design/tcli.md): the filters of `tcli browser record items` and the merge of
// `tcli browser record requests`. One module for both sides, so the answer is the same whether the server filters (services/browser-recordings.js,
// routes/browser-ext.js) or tcli does it itself because the T-Agent it talks to is older (scripts/tcli-browser-records.js). Node built-ins only.
//
// An item is one line of <recording_id>.jsonl, as the extension sent it and the server redacted it: { seq, at, kind, tab_id, url, ... }. The network
// kinds are `request` (a summary when the request starts: req_id, method, url, type, status 0), `response` (the same req_id when it finished, with the
// request and response headers and bodies) and `ws` (a WebSocket frame, by url). A redirect sends a `response` for the old hop (status 3xx) and a new
// `request` with the same req_id. Items made by tcli commands carry `source: 'agent'`; an item without a source counts as the person's ('user').
// A recording follows the tabs the recorded page opens, so items carry `tab` (the same as `tab_id`; older recordings have only `tab_id`) and
// --tab picks one tab's items or requests.

const KIND_ALIASES = Object.freeze({ net: ['request', 'response', 'ws'], network: ['request', 'response', 'ws'] });
// Static files: left out of `record requests` unless --all (or --type names them).
const STATIC_TYPES = Object.freeze(['Script', 'Stylesheet', 'Image', 'Font', 'Media']);
const SOURCES = Object.freeze(['agent', 'user']);
const MAX_PATTERN = 1000;
const MAX_LIST = 50;

class QueryError extends Error {
  constructor(message) { super(message); this.code = 'BAD_FILTER'; this.status = 400; }
}

// A query value as text: a string, or a list of strings (a repeated query parameter or option), joined with commas.
function text(value, name) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (!value.every(item => typeof item === 'string')) throw new QueryError(`--${name} must be text`);
    return value.join(',');
  }
  if (typeof value !== 'string') throw new QueryError(`--${name} must be text`);
  return value;
}
function names(value, name) {
  const raw = text(value, name);
  if (raw === undefined) return undefined;
  const list = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (!list.length) throw new QueryError(`--${name} needs a value`);
  if (list.length > MAX_LIST) throw new QueryError(`--${name} takes at most ${MAX_LIST} values`);
  return list;
}
function whole(value, name) {
  const raw = text(value, name);
  if (raw === undefined) return undefined;
  if (!/^\d{1,9}$/.test(raw.trim())) throw new QueryError(`--${name} must be a whole number`);
  return Number(raw.trim());
}

// --tab: one tab id.
function tabId(value) {
  const id = whole(value, 'tab');
  return id === undefined ? null : id;
}
const tabOf = item => (Number.isInteger(item.tab) ? item.tab : Number.isInteger(item.tab_id) ? item.tab_id : null);

// --url: a substring, or /regex/flags.
function urlMatcher(value) {
  const raw = text(value, 'url');
  if (raw === undefined) return undefined;
  if (!raw) throw new QueryError('--url needs a value');
  if (raw.length > MAX_PATTERN) throw new QueryError(`--url is longer than ${MAX_PATTERN} characters`);
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  if (!regex) return { source: raw, test: url => url.includes(raw) };
  if (/[^imsu]/.test(regex[2])) throw new QueryError('--url /regex/ takes only the flags i, m, s and u');
  let pattern;
  try { pattern = new RegExp(regex[1], regex[2]); } catch (error) { throw new QueryError(`--url is not a valid regular expression: ${error.message}`); }
  return { source: raw, test: url => pattern.test(url) };
}

// --status: 200, 4xx, 400-499, 0 (no response yet), as a comma list. Each becomes [low, high].
function statusRanges(value) {
  const list = names(value, 'status');
  if (!list) return undefined;
  return list.map(token => {
    const lower = token.toLowerCase();
    let match = /^(\d{1,3})$/.exec(lower);
    if (match) return [Number(match[1]), Number(match[1])];
    match = /^([1-5])xx$/.exec(lower);
    if (match) return [Number(match[1]) * 100, Number(match[1]) * 100 + 99];
    match = /^(\d{3})-(\d{3})$/.exec(lower);
    if (match && Number(match[1]) <= Number(match[2])) return [Number(match[1]), Number(match[2])];
    throw new QueryError(`--status takes codes like 200, 4xx, 400-499 or 0, not "${token}"`);
  });
}

// The filter of `record items` from query parameters or options (strings). Returns null when nothing filters, so the caller can send the file as
// it is. Throws QueryError (code BAD_FILTER, status 400) for a value it cannot use.
function parseItemFilter(query = {}) {
  const kinds = names(query.kind, 'kind');
  if (kinds) for (const kind of kinds) if (!/^[a-z][a-z0-9_.-]{0,31}$/i.test(kind)) throw new QueryError(`--kind takes names like net, click or dom, not "${kind}"`);
  const sources = names(query.source, 'source');
  if (sources) for (const source of sources) if (!SOURCES.includes(source)) throw new QueryError(`--source is agent or user, not "${source}"`);
  const types = names(query.type, 'type');
  const filter = {
    kinds: kinds ? new Set(kinds.flatMap(kind => KIND_ALIASES[kind.toLowerCase()] || [kind.toLowerCase()])) : null,
    types: types ? new Set(types.map(type => type.toLowerCase())) : null,
    sources: sources ? new Set(sources) : null,
    url: urlMatcher(query.url) || null,
    status: statusRanges(query.status) || null,
    tab: tabId(query.tab),
    offset: whole(query.offset, 'offset') || 0,
    limit: whole(query.limit, 'limit'),
  };
  if (filter.limit === 0) throw new QueryError('--limit must be at least 1');
  const active = filter.kinds || filter.types || filter.sources || filter.url || filter.status || filter.tab !== null || filter.offset || filter.limit !== undefined;
  return active ? filter : null;
}

const statusIn = (ranges, status) => {
  const code = Number.isFinite(status) ? status : 0;
  return ranges.some(([low, high]) => code >= low && code <= high);
};

// Whether one item passes the filter (offset and limit aside).
function itemMatches(filter, item) {
  if (!item || typeof item !== 'object') return false;
  if (filter.kinds && !filter.kinds.has(String(item.kind || '').toLowerCase())) return false;
  if (filter.types && !(typeof item.type === 'string' && filter.types.has(item.type.toLowerCase()))) return false;
  if (filter.sources && !filter.sources.has(item.source === 'agent' ? 'agent' : 'user')) return false;
  if (filter.url && !(typeof item.url === 'string' && filter.url.test(item.url))) return false;
  if (filter.status && !(item.status !== undefined && item.status !== null && statusIn(filter.status, Number(item.status)))) return false;
  if (filter.tab !== null && filter.tab !== undefined && tabOf(item) !== filter.tab) return false;
  return true;
}

// The lines (JSON text, with or without the newline) that pass the filter, with offset and limit. A line that is not JSON is skipped.
async function* filterLines(lines, filter) {
  let skipped = 0;
  let given = 0;
  for await (const raw of lines) {
    const line = String(raw).replace(/\r?\n$/, '');
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!itemMatches(filter, item)) continue;
    if (skipped < filter.offset) { skipped += 1; continue; }
    yield line;
    given += 1;
    if (filter.limit !== undefined && given >= filter.limit) return;
  }
}

// The options of `record requests`: --type (overrides the static default), --all, --url, --status, --tab, --limit, --offset.
function parseRequestOptions(query = {}) {
  const types = names(query.type, 'type');
  const all = query.all === true || query.all === '1' || query.all === 'true';
  const options = {
    types: types ? new Set(types.map(type => type.toLowerCase())) : null,
    all,
    url: urlMatcher(query.url) || null,
    status: statusRanges(query.status) || null,
    tab: tabId(query.tab),
    offset: whole(query.offset, 'offset') || 0,
    limit: whole(query.limit, 'limit'),
  };
  if (options.limit === 0) throw new QueryError('--limit must be at least 1');
  return options;
}

const STATIC = new Set(STATIC_TYPES.map(type => type.toLowerCase()));
// Whether a request of this resource type is kept (before the url and status filters, which need the whole request).
function typeKept(options, type) {
  const lower = typeof type === 'string' ? type.toLowerCase() : '';
  if (options.types) return options.types.has(lower);
  if (options.all) return true;
  return !STATIC.has(lower);
}

const has = (object, key) => object[key] !== undefined && object[key] !== null;
const number = value => (Number.isFinite(value) ? value : undefined);

// Merges the request and response items of a recording into one entry per request (one per hop of a redirect), in the order the requests started.
// items: an (async) iterable of items or of JSON lines. Returns { requests, left_out } (left_out: static files left out by the default).
async function mergeRequests(items, options = parseRequestOptions()) {
  const entries = [];
  const latest = new Map(); // req_id -> its newest entry (the current hop)
  const dropped = new Set(); // req_ids left out by their type
  const sockets = new Map(); // url -> the newest WebSocket entry, for the frame count
  let leftOut = 0;

  const start = (item, fromRequest) => {
    const entry = {
      req_id: item.req_id, seq: number(item.seq), method: item.method, url: item.url, type: item.type,
      status: null, mime: undefined, size: undefined, duration_ms: undefined, started_at: undefined, finished_at: undefined,
      from_cache: undefined, failed: undefined, tab_id: tabOf(item) ?? undefined, source: item.source,
      request: undefined, response: undefined, timing: undefined, initiator: undefined,
      redirected_from: undefined, redirected_to: undefined, ws_frames: undefined, missing: fromRequest ? 'response' : 'request',
    };
    if (fromRequest) {
      entry.started_at = number(item.at);
      if (Number(item.status) > 0) entry.status = Number(item.status);
      for (const key of ['mime', 'size', 'from_cache', 'failed']) if (has(item, key)) entry[key] = item[key];
      if (Number(item.duration_ms) > 0) entry.duration_ms = Number(item.duration_ms);
    }
    entries.push(entry);
    latest.set(item.req_id, entry);
    if (String(item.type || '').toLowerCase() === 'websocket' && typeof item.url === 'string') sockets.set(item.url, entry);
    return entry;
  };

  const finish = (entry, item) => {
    for (const key of ['method', 'url', 'type']) if (has(item, key)) entry[key] = item[key];
    if (has(item, 'status')) entry.status = Number(item.status) > 0 ? Number(item.status) : entry.status;
    const request = item.request && typeof item.request === 'object' ? item.request : null;
    const response = item.response && typeof item.response === 'object' ? item.response : null;
    if (request) entry.request = request;
    if (response) {
      entry.response = response;
      if (has(response, 'mime')) entry.mime = response.mime;
      if (Number.isFinite(response.size)) entry.size = response.size;
    }
    if (item.timing && typeof item.timing === 'object') entry.timing = item.timing;
    if (has(item, 'initiator')) entry.initiator = item.initiator;
    if (has(item, 'failed')) entry.failed = item.failed;
    if (has(item, 'from_cache')) entry.from_cache = item.from_cache;
    if (Array.isArray(item.frames) && item.frames.length) entry.ws_frames = (entry.ws_frames || 0) + item.frames.length;
    const timing = entry.timing || {};
    if (entry.started_at === undefined) entry.started_at = number(timing.started_at);
    entry.finished_at = number(timing.finished_at) ?? number(item.at);
    if (Number(item.duration_ms) > 0) entry.duration_ms = Number(item.duration_ms);
    else if (entry.started_at !== undefined && entry.finished_at !== undefined && entry.finished_at >= entry.started_at) entry.duration_ms = entry.finished_at - entry.started_at;
    if (entry.source === undefined && has(item, 'source')) entry.source = item.source;
    entry.missing = entry.missing === 'request' ? 'request' : undefined;
    entry.answered = true;
  };

  for await (const raw of items) {
    let item = raw;
    if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
      const line = String(raw).trim();
      if (!line) continue;
      try { item = JSON.parse(line); } catch { continue; }
    }
    if (!item || typeof item !== 'object') continue;
    const kind = item.kind;
    if (kind === 'ws') {
      const socket = typeof item.url === 'string' ? sockets.get(item.url) : null;
      if (socket) socket.ws_frames = (socket.ws_frames || 0) + 1;
      continue;
    }
    if ((kind !== 'request' && kind !== 'response') || typeof item.req_id !== 'string' || !item.req_id) continue;
    if (kind === 'request') {
      if (!typeKept(options, item.type)) {
        if (!options.types && STATIC.has(String(item.type || '').toLowerCase())) leftOut += 1;
        dropped.add(item.req_id);
        latest.delete(item.req_id);
        continue;
      }
      dropped.delete(item.req_id);
      const previous = latest.get(item.req_id);
      const entry = start(item, true);
      if (previous) { previous.redirected_to = item.url; entry.redirected_from = previous.url; }
      continue;
    }
    // A response.
    if (dropped.has(item.req_id)) continue;
    let entry = latest.get(item.req_id);
    if (!entry) {
      if (!typeKept(options, item.type)) {
        if (!options.types && STATIC.has(String(item.type || '').toLowerCase())) leftOut += 1;
        dropped.add(item.req_id);
        continue;
      }
      entry = start(item, false);
    } else if (entry.answered && has(item, 'url') && item.url !== entry.url) {
      // A second hop whose request item is missing (dropped at the size limit): its own entry.
      const previous = entry;
      entry = start(item, false);
      previous.redirected_to = item.url;
      entry.redirected_from = previous.url;
    }
    finish(entry, item);
  }

  const kept = [];
  let skipped = 0;
  for (const entry of entries) {
    if (options.url && !(typeof entry.url === 'string' && options.url.test(entry.url))) continue;
    if (options.status && !statusIn(options.status, entry.status)) continue;
    if (options.tab !== null && options.tab !== undefined && entry.tab_id !== options.tab) continue;
    if (skipped < options.offset) { skipped += 1; continue; }
    delete entry.answered;
    kept.push(Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)));
    if (options.limit !== undefined && kept.length >= options.limit) break;
  }
  return { requests: kept, left_out: leftOut };
}

module.exports = { parseItemFilter, itemMatches, tabOf, filterLines, parseRequestOptions, mergeRequests, QueryError, KIND_ALIASES, STATIC_TYPES, SOURCES };

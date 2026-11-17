// The notices of the T-Attention desktop window (macOS): the bubbles it shows beside itself. See "Floating window notices" in DESIGN.md.
//
// The `widget` notifier (plugins/notifiers/widget) pushes one notice per message it is given; the window reads them with
// GET /api/attention/widget/notices?after=<seq> (routes/attention-widget.js) on its 5 s refresh. Kept only in memory, on this machine: at most
// NOTICES_MAX, none older than NOTICE_MAX_AGE_MS. A notice is never relayed to another device (services/attention-relay.js relays Telegram only).
//
// A notice (the contract the window reads, keep it exact):
//   { seq, at, kind: 'item' | 'direct' | 'test', title, text, from, status, key, target, seconds }
//   seq      a whole number, one higher for every notice of this server process (the first is 1)
//   at       when it was pushed, ISO 8601
//   title    one line, at most 200 characters
//   text     at most 500 characters, may have line breaks, trimmed
//   from     who sent it (a direct message's `from`, or the linked device), one line of at most 80 characters, or null
//   status   the item status for kind 'item' (waiting_user, review, done, failed ...), else null
//   key      the window's item key ('local:12') for kind 'item', else null
//   target   the absolute http(s) address to open on a click (no user name or password), or null
//   seconds  how long to show it; 0 = until it is clicked or closed
//
// The window state (setWidgetState): the launcher of services/attention-widget.js tells the notifier whether a window can show notices on this
// machine ({ supported, blocked, enabled, running, url }); server.js wires it. Without it (tests, another platform) nothing is ready.
const NOTICES_MAX = 20;
const NOTICE_MAX_AGE_MS = 10 * 60 * 1000;
const RECENT_MS = 60 * 1000; // what a window that has just started gets (no `after`)
const KINDS = ['item', 'direct', 'test'];
const LIMITS = Object.freeze({ title: 200, text: 500, from: 80, status: 40, key: 64, target: 2000 });
const SECONDS_MAX = 600;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// Never leaves half of a surrogate pair at the end; a cut text ends with an ellipsis.
function cut(value, max) {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/.test(value[max - 2] || '') ? max - 2 : max - 1;
  return `${value.slice(0, Math.max(0, end)).trimEnd()}\u2026`;
}
const oneLine = (value, max) => cut(String(value ?? '').replace(LONE_SURROGATE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max);
const multiLine = (value, max) => cut(String(value ?? '').replace(LONE_SURROGATE, '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  .split('\n').map(line => line.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim(), max);
const lineOrNull = (value, max) => { const text = typeof value === 'string' ? oneLine(value, max) : ''; return text || null; };

// An absolute http(s) address without a user name or password, or null (javascript:, data:, file:, a page path ... are refused).
function safeTarget(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > LIMITS.target) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.href.length <= LIMITS.target ? url.href : null;
}
// A page path of T-Agent ('/...', not '//host' and no backslash, as services/attention.js linkUrl) against an http(s) base, or null.
function resolvePath(pathname, base) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) return null;
  const origin = safeTarget(base);
  if (!origin) return null;
  try { return safeTarget(new URL(pathname, origin).href); } catch { return null; }
}
const secondsOf = value => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 && number <= SECONDS_MAX ? number : null;
};

// A notice as the window gets it; throws TypeError for a kind or a title / text that is missing.
function normalizeNotice(input = {}, { seq, at, defaultSeconds = 8 } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('A notice must be an object');
  if (!KINDS.includes(input.kind)) throw new TypeError(`A notice kind must be one of ${KINDS.join(', ')}`);
  const title = oneLine(input.title, LIMITS.title);
  const text = multiLine(input.text, LIMITS.text);
  if (!title && !text) throw new TypeError('A notice needs a title or a text');
  const item = input.kind === 'item';
  const seconds = secondsOf(input.seconds);
  return {
    seq,
    at,
    kind: input.kind,
    title: title || oneLine(text.split('\n')[0], LIMITS.title),
    text,
    from: lineOrNull(input.from, LIMITS.from),
    status: item ? lineOrNull(input.status, LIMITS.status) : null,
    key: item ? lineOrNull(input.key, LIMITS.key) : null,
    target: safeTarget(input.target),
    seconds: seconds === null ? defaultSeconds : seconds,
  };
}

// options: now() (ms), max, maxAgeMs.
function createWidgetNotices({ now = () => Date.now(), max = NOTICES_MAX, maxAgeMs = NOTICE_MAX_AGE_MS } = {}) {
  let seq = 0;
  let notices = []; // oldest first
  const prune = () => {
    const oldest = now() - maxAgeMs;
    notices = notices.filter(notice => Date.parse(notice.at) > oldest);
    if (notices.length > max) notices = notices.slice(notices.length - max);
  };
  // Adds one notice (normalizeNotice) and returns it with its seq.
  function push(input) {
    const notice = normalizeNotice(input, { seq: seq + 1, at: new Date(now()).toISOString() });
    seq = notice.seq;
    notices.push(notice);
    prune();
    return { ...notice };
  }
  // { seq: the latest seq, notices: oldest first }. after: a seq the reader has seen; without it (a window that has just started), the notices
  // of the last 60 s. An `after` above the latest seq (this server restarted since the reader saw it) counts as no `after`.
  function list({ after } = {}) {
    prune();
    const fresh = after === undefined || after === null || after > seq;
    const since = now() - RECENT_MS;
    const chosen = fresh ? notices.filter(notice => Date.parse(notice.at) > since) : notices.filter(notice => notice.seq > after);
    return { seq, notices: chosen.map(notice => ({ ...notice })) };
  }
  return { push, list, latestSeq: () => seq, size: () => { prune(); return notices.length; }, clear: () => { notices = []; } };
}

let shared = null;
const defaultNotices = () => { if (!shared) shared = createWidgetNotices(); return shared; };

// The window state of this machine for the notifier: () => { supported, blocked, enabled, running, url }. Set by server.js.
let widgetState = () => ({ supported: false, blocked: false, enabled: false, running: false, url: null });
function setWidgetState(fn) { widgetState = typeof fn === 'function' ? fn : widgetState; }
// fn: another state function (tests); default the one server.js set.
function readWidgetState(fn = widgetState) {
  let state = null;
  try { state = (typeof fn === 'function' ? fn : widgetState)(); } catch { state = null; }
  const value = state && typeof state === 'object' ? state : {};
  return { supported: value.supported === true, blocked: Boolean(value.blocked), enabled: value.enabled === true, running: value.running === true, url: safeTarget(value.url) };
}

module.exports = {
  createWidgetNotices, defaultNotices, normalizeNotice, safeTarget, resolvePath, setWidgetState, readWidgetState,
  NOTICES_MAX, NOTICE_MAX_AGE_MS, RECENT_MS, LIMITS, KINDS,
};

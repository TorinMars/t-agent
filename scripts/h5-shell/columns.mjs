// The multi-column view (Columns.jsx): the rules without the page. Each column is an iframe of the same page in pane mode, `/h5?pane=<id>`; the top
// page only keeps the list of column ids, in order, whether the view is on and which tab of its navigation rail is shown. See "Multi-column view" in
// docs/design/page-shell-and-columns.md.

export const STORAGE_KEY = 'h5-columns'; // { on: boolean, ids: [id, ...], tab: 'columns' | 'maps' }, one per device
export const MAX_COLUMNS = 12;
// The navigation rail of the page (NAV_WIDTH px on the left, full height, wide layout only, in the single view and in the columns view alike):
// Sessions, Columns, Attention and Mind maps, then Update and Settings at the bottom. The tab of the columns view is remembered with the layout.
export const NAV_WIDTH = 72; // px
export const TABS = ['columns', 'maps'];
export const readTab = value => (TABS.includes(value) ? value : 'columns');
// The width of a column: up to VISIBLE_COLUMNS columns share the strip's visible width evenly; with more, each one is a quarter of that width and the
// strip scrolls sideways (nothing is squeezed). Never narrower than MIN_COLUMN_WIDTH, so a narrow window fits fewer and scrolls earlier. 340px keeps
// four columns side by side at 1440px next to the navigation rail (1368px of strip: four of 342px).
export const VISIBLE_COLUMNS = 4;
export const MIN_COLUMN_WIDTH = 340; // px
// The minimum width of each column (its `flex-basis` and `min-width`) for a strip whose visible width is stripWidth px.
export const minColumnWidth = stripWidth => {
  const width = Number(stripWidth);
  return Number.isFinite(width) && width > 0 ? Math.max(MIN_COLUMN_WIDTH, Math.floor(width / VISIBLE_COLUMNS)) : MIN_COLUMN_WIDTH;
};
// The width each of `count` columns gets: the visible width shared evenly, but never below minColumnWidth (then the strip scrolls).
export const columnWidth = (stripWidth, count) => {
  const min = minColumnWidth(stripWidth);
  const width = Number(stripWidth);
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  return Number.isFinite(width) && width > 0 ? Math.max(min, width / n) : min;
};
export const MESSAGE_TYPE = 't-agent-pane';
export const PANE_EVENTS = new Set(['ready', 'focus', 'title', 'scroll-x', 'step', 'move', 'maximize', 'peek', 'mindmaps']);
export const PEEK_LINES = 6;
const AGENTS = new Set(['claude', 'codex']);
const SCROLL_MAX = 10000; // px of one forwarded sideways scroll
const ID = /^[a-z0-9]{1,16}$/;
const TEXT_MAX = 200;

export const isPaneId = value => typeof value === 'string' && ID.test(value);

// The pane id of a page address (`?pane=abc`), or '' when the page is not a pane or the id is not valid.
export function paneIdOf(search) {
  let value = null;
  try { value = new URLSearchParams(search || '').get('pane'); } catch { return ''; }
  return isPaneId(value) ? value : '';
}
// A page with any `pane` parameter (valid or not) or inside a frame never offers the view: a column must never open columns of its own.
export function canOfferColumns(search, framed) {
  if (framed) return false;
  try { return !new URLSearchParams(search || '').has('pane'); } catch { return false; }
}

// The number of columns the first use opens: as many as fit at MIN_COLUMN_WIDTH, at least 2 and at most VISIBLE_COLUMNS. `width` is the strip's
// width (the window less the navigation rail, `stripWidthOf`): 4 from a 1432px window, 3 from 1092px.
export const defaultCount = width => Math.max(2, Math.min(VISIBLE_COLUMNS, Math.floor((Number(width) || 0) / MIN_COLUMN_WIDTH)));
export const stripWidthOf = windowWidth => Math.max(0, (Number(windowWidth) || 0) - NAV_WIDTH);

// A new short id that is not taken: 6 characters of [a-z0-9].
export function newId(taken = [], random = Math.random) {
  const used = new Set(taken);
  for (let tries = 0; tries < 1000; tries += 1) {
    let id = '';
    for (let i = 0; i < 6; i += 1) id += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36) % 36];
    if (!used.has(id)) return id;
  }
  throw new Error('No free column id');
}

// The stored layout, cleaned: only valid, distinct ids, at most MAX_COLUMNS, and the tab of the rail ('columns' unless 'maps' was stored, so a layout
// written before the rail existed opens on the columns). Anything unreadable is the default (off, no ids yet, the columns tab).
export function readLayout(raw) {
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  const ids = [];
  for (const id of (data && Array.isArray(data.ids) ? data.ids : [])) if (isPaneId(id) && !ids.includes(id) && ids.length < MAX_COLUMNS) ids.push(id);
  return { on: Boolean(data && data.on === true), ids, tab: readTab(data && data.tab) };
}
export const writeLayout = layout => JSON.stringify({ on: Boolean(layout.on), ids: layout.ids.slice(0, MAX_COLUMNS), tab: readTab(layout.tab) });

// Mind map columns (v2.133.0 to v2.134.x) are gone: a mind map has its own tab now. Such a column was a pane that remembered its mind map view under
// `pane:<id>:h5-mindmap` (LEGACY_MAP_KEY). On load the top page drops every column that has that key, and forgets its keys (`dropped`); the other
// columns keep their order. `isMapColumn(id)` says whether the key is stored. With no column left, the view opens its default columns.
export const LEGACY_MAP_KEY = 'h5-mindmap';
export const legacyMapKeyOf = paneId => `pane:${paneId}:${LEGACY_MAP_KEY}`;
export function dropMapColumns(ids, isMapColumn) {
  const kept = [];
  const dropped = [];
  for (const id of ids) (isMapColumn(id) ? dropped : kept).push(id);
  return { ids: dropped.length ? kept : ids, dropped };
}

// The ids to show when the view is turned on: the stored ones, or on first use the default number of new ones (`width`: the strip's width).
export function columnsFor(ids, width, random = Math.random) {
  if (ids.length) return ids.slice(0, MAX_COLUMNS);
  const made = [];
  for (let i = 0; i < defaultCount(width); i += 1) made.push(newId(made, random));
  return made;
}
export const canAdd = ids => ids.length < MAX_COLUMNS;
export const canClose = ids => ids.length > 1; // the last column is never closed: leaving the view is the toggle
export const addColumn = (ids, random = Math.random) => (canAdd(ids) ? [...ids, newId(ids, random)] : ids);
export const closeColumn = (ids, id) => (canClose(ids) ? ids.filter(item => item !== id) : ids);
// The order with `id` moved to `index` (clamped to the ends); the same array when nothing changes (an unknown id, the same place).
export function moveColumn(ids, id, index) {
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, Math.floor(Number(index)) || 0));
  if (from < 0 || from === to) return ids;
  const next = ids.filter(item => item !== id);
  next.splice(to, 0, id);
  return next;
}
// One place left (-1) or right (1); at an end it stays.
export const shiftColumn = (ids, id, by) => (ids.includes(id) && (by === 1 || by === -1) ? moveColumn(ids, id, ids.indexOf(id) + by) : ids);
// The order the columns' elements keep in the page: the ids that were already there in their old order, then the new ones. Only the CSS `order` of a
// column shows where it is: moving an iframe's element in the DOM reloads its page (and drops its terminal connection), so a reorder never moves one.
export function mountOrder(mounted, ids) {
  const kept = (mounted || []).filter(id => ids.includes(id));
  return [...kept, ...ids.filter(id => !kept.includes(id))];
}

// A message from a pane: { type: 't-agent-pane', paneId, event: 'ready' | 'focus' | 'title' | 'scroll-x' | 'step' | 'move' | 'maximize' | 'peek' |
// 'mindmaps', title?, session?, device?, target?, agent?, sheet?, width?, dx?, step?, lines? }. 'title': the task and session shown, and the device of
// that task when the pane's list tags it (`device`: { name, instanceId, local, offline }, kept only with a name or as this machine), the terminal it
// shows (`target`: { sourceKey, taskId, terminalId }, for the state of its column), that terminal's agent ('claude', 'codex' or none), whether its
// task sheet is shown (`sheet`: true, else left out) and
// its terminal width (`width`: { mode: 'fit' | 'wide', cols }, left out without a terminal): the column's header draws them; 'scroll-x': a sideways wheel or trackpad swipe inside the pane
// that nothing in it scrolls (dx in px, nonzero, at most 10000 either way); 'step': Ctrl+Alt+Left / Right pressed inside the pane, 'move':
// Ctrl+Alt+Shift+Left / Right (step -1 or 1); 'maximize': Cmd/Ctrl+Shift+Enter in the pane, to maximize its column or to restore the columns (a
// toggle); 'peek': the answer to a peek request, the last lines of the pane's terminal (at most PEEK_LINES strings); 'mindmaps': the person asked for
// the mind maps inside the pane (its task sheet's Mind maps button): the top page shows its Mind maps tab. Anything else is null.
// The caller checks the origin and that the sender is one of its own iframes (and that its id is this paneId).
export function readPaneMessage(data) {
  if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE || !isPaneId(data.paneId) || !PANE_EVENTS.has(data.event)) return null;
  const text = value => (typeof value === 'string' ? value.trim().slice(0, TEXT_MAX) : '');
  const message = { paneId: data.paneId, event: data.event };
  if (data.event === 'title') {
    message.title = text(data.title);
    message.session = text(data.session);
    const device = readDevice(data.device);
    if (device) message.device = device;
    const target = readTarget(data.target);
    if (target) message.target = target;
    if (AGENTS.has(data.agent)) message.agent = data.agent;
    if (data.sheet === true) message.sheet = true;
    const width = readWidth(data.width);
    if (width) message.width = width;
  }
  if (data.event === 'peek') message.lines = readLines(data.lines);
  if (data.event === 'scroll-x') {
    if (typeof data.dx !== 'number' || !Number.isFinite(data.dx) || data.dx === 0) return null;
    message.dx = Math.max(-SCROLL_MAX, Math.min(SCROLL_MAX, data.dx));
  }
  if (data.event === 'step' || data.event === 'move') {
    if (data.step !== 1 && data.step !== -1) return null;
    message.step = data.step;
  }
  return message;
}

// The terminal width a pane reports ({ mode: 'fit' | 'wide', cols: 20 to 1000 }), or null.
export function readWidth(value) {
  if (!value || typeof value !== 'object' || (value.mode !== 'fit' && value.mode !== 'wide')) return null;
  const cols = Number(value.cols);
  return { mode: value.mode, cols: Number.isInteger(cols) && cols >= 20 && cols <= 1000 ? cols : 0 };
}

// The device of a pane's task as its column's header shows it (the same engine tag as the task list): a name (this machine may have none: an older server), the
// instance id that gives the tag its colour, and whether it is this machine or offline. Anything unusable is null.
export function readDevice(value) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '';
  const local = value.local === true;
  if (!name && !local) return null;
  const instanceId = typeof value.instanceId === 'string' ? value.instanceId.slice(0, 80) : '';
  return { name, instanceId, local, offline: value.offline === true };
}
// What a pane says about its task's device (from the row of the task list that is selected and tagged), or null without one.
export const deviceOfRow = row => (row && row.device ? readDevice({ name: row.device.local ? row.device.name : row.device.label, instanceId: row.device.instanceId, local: row.device.local, offline: row.device.offline }) : null);
// The shape DeviceTag (TaskDrawer.jsx) draws: this machine is named by `name`, a remote device by `label`.
export const tagOf = device => (device ? { key: device.local ? 'local' : 'remote', local: device.local, name: device.local ? device.name : '', label: device.name, instanceId: device.instanceId, offline: device.offline } : null);

// The sideways part of a wheel event in px, or 0 when it is not a sideways scroll: |deltaX| > |deltaY| (a sideways trackpad swipe or tilt wheel), or
// Shift with a vertical wheel (systems that do not turn it into deltaX themselves). A pinch (ctrlKey) or Cmd+wheel is never sideways.
export function sidewaysDelta({ deltaX = 0, deltaY = 0, deltaMode = 0, shiftKey = false, ctrlKey = false, metaKey = false } = {}, pageWidth = 800) {
  if (ctrlKey || metaKey) return 0;
  const x = Number(deltaX) || 0;
  const y = Number(deltaY) || 0;
  const value = Math.abs(x) > Math.abs(y) ? x : (shiftKey ? x || y : 0);
  if (!value) return 0;
  const unit = deltaMode === 1 ? 40 : deltaMode === 2 ? (Number(pageWidth) || 800) : 1;
  return value * unit;
}
// The column step of a key: Ctrl+Alt+Left = -1, Ctrl+Alt+Right = 1 (Ctrl+Option on a Mac), else 0. Cmd or Shift with them is another key.
export function columnStep({ key, ctrlKey = false, altKey = false, metaKey = false, shiftKey = false } = {}) {
  if (!ctrlKey || !altKey || metaKey || shiftKey) return 0;
  return key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
}
// The move of a key: Ctrl+Alt+Shift+Left = -1, Ctrl+Alt+Shift+Right = 1 (Ctrl+Option+Shift on a Mac): the focused column one place left / right.
export function columnMove({ key, ctrlKey = false, altKey = false, metaKey = false, shiftKey = false } = {}) {
  if (!ctrlKey || !altKey || metaKey || !shiftKey) return 0;
  return key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
}
// The column a step moves the focus to: the previous or next open column, stopping at the ends; with no focus, the first (right) or last (left).
export function stepTarget(ids, focus, step) {
  if (!ids.length || (step !== 1 && step !== -1)) return null;
  const at = ids.indexOf(focus);
  if (at < 0) return step > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, at + step))];
}
// The scrollLeft that shows [left, left + width) of the strip's content whole, or null when it is already whole in view (a column wider than the
// view is shown from its start).
export function revealLeft({ left, width, scrollLeft, clientWidth }) {
  const right = left + width;
  if (left >= scrollLeft - 1 && right <= scrollLeft + clientWidth + 1) return null;
  if (left < scrollLeft || width >= clientWidth) return Math.max(0, Math.round(left));
  return Math.max(0, Math.round(right - clientWidth));
}
// Which edges of the strip hide columns: { left, right } (1px of rounding is not hidden content).
export function hiddenEdges({ scrollLeft, scrollWidth, clientWidth }) {
  return { left: scrollLeft > 1, right: scrollLeft + clientWidth < scrollWidth - 1 };
}
export const forgetMessage = () => ({ type: MESSAGE_TYPE, event: 'forget' });
// The actions of a column's header that work inside its pane (the header is the top page's, the page it acts on is the pane's): { type, event, ... }.
// 'tasks': show the task sheet (`toggle`: close it when it is shown, the header's "Project · session" button); 'width': the terminal width (`mode`
// 'fit' or 'wide' with `cols`, or nothing: switch Fit <-> Wide, as the normal header's button); 'rename' and 'restart': the session shown, as its row's
// menu does (restart asks first); 'reload': the pane's page loaded again (the normal header's Refresh). null for anything else.
export const PARENT_ACTIONS = new Set(['tasks', 'width', 'rename', 'restart', 'reload']);
export function actionMessage(event, options = {}) {
  if (!PARENT_ACTIONS.has(event)) return null;
  const message = { type: MESSAGE_TYPE, event };
  if (event === 'tasks' && options.toggle === true) message.toggle = true;
  if (event === 'width' && (options.mode === 'fit' || options.mode === 'wide')) {
    message.mode = options.mode;
    const cols = Number(options.cols);
    if (Number.isInteger(cols) && cols > 0) message.cols = cols;
  }
  return message;
}
// What a pane reads from such a message (pane.mjs): { event, toggle?, mode?, cols? }, or null when it is not one.
export function readAction(data) {
  if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE || !PARENT_ACTIONS.has(data.event)) return null;
  const action = { event: data.event };
  if (data.event === 'tasks') action.toggle = data.toggle === true;
  if (data.event === 'width' && (data.mode === 'fit' || data.mode === 'wide')) {
    action.mode = data.mode;
    const cols = Number(data.cols);
    if (Number.isInteger(cols) && cols > 0) action.cols = cols;
  }
  return action;
}
// What the top page asks a column to show when something in the top page would select a session while the strip is shown (a notification click,
// a ?openChat= link): { type, event: 'open', sourceKey ('local', 'remote:3' ...), taskId, terminalId? (when known), conversationId? (a chat) }.
// null when the target is not usable.
export function openMessage({ sourceKey, taskId, terminalId, conversationId } = {}) {
  const key = typeof sourceKey === 'string' ? sourceKey.trim() : '';
  const id = Number(taskId);
  if (!key || !Number.isInteger(id) || id <= 0) return null;
  const message = { type: MESSAGE_TYPE, event: 'open', sourceKey: key, taskId: id };
  if (terminalId !== undefined && terminalId !== null && String(terminalId)) message.terminalId = String(terminalId);
  if (conversationId !== undefined && conversationId !== null && String(conversationId)) message.conversationId = String(conversationId);
  return message;
}
// The column a request to open goes to: the focused one, else the first one (columns being closed do not count).
export const targetColumn = (ids, focus) => (focus && ids.includes(focus) ? focus : ids[0] || null);
export const paneUrl = id => `/h5?pane=${encodeURIComponent(id)}`;

const SOURCE_KEY = /^(local|remote:[1-9]\d*)$/;

// The terminal a pane shows ({ sourceKey, taskId, terminalId }), or null.
export function readTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const taskId = Number(value.taskId);
  const terminalId = typeof value.terminalId === 'string' ? value.terminalId : '';
  if (typeof value.sourceKey !== 'string' || !SOURCE_KEY.test(value.sourceKey) || !Number.isSafeInteger(taskId) || taskId <= 0 || !/^[A-Za-z0-9_.:-]{1,64}$/.test(terminalId)) return null;
  return { sourceKey: value.sourceKey, taskId, terminalId };
}
// The last lines of a pane's terminal for the peek card: strings, at most PEEK_LINES, each at most TEXT_MAX characters.
export function readLines(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(line => typeof line === 'string').slice(-PEEK_LINES).map(line => line.replace(/\s+$/, '').slice(0, TEXT_MAX));
}

// ── Maximize (one column fills the strip; the others become the rail) ──
// `state.columns.maximized` is the id of the maximized column, or null. Any open column can be maximized, whatever it shows (a terminal, a chat, the
// task list), only while the strip is shown, and only one at a time. It is not stored: a reload shows the columns side by side again.
export const RAIL_WIDTH = 72; // px
export function canMaximize(columns, id) {
  if (!columns || !columns.shown || !id) return false;
  return columns.ids.includes(id) && !(columns.closing || []).includes(id);
}
// The maximized column that is still valid after any change (a column closed, the strip hidden), else null.
export const keptMaximized = columns => (columns && columns.maximized && canMaximize(columns, columns.maximized) ? columns.maximized : null);
// Cmd/Ctrl+Shift+Enter toggles: { maximized: id } for a column when none is maximized, { maximized: null } when one is; null when nothing changes.
export function toggleMaximize(columns, id) {
  if (!columns || !columns.shown) return null;
  if (columns.maximized) return { maximized: null };
  return canMaximize(columns, id) ? { maximized: id } : null;
}
// The other open columns, in the order shown: the tiles of the rail.
export const railColumns = (columns, maximized) => (columns ? columns.ids.filter(id => id !== maximized && !(columns.closing || []).includes(id)) : []);
// Cmd+Shift+Enter (Ctrl+Shift+Enter elsewhere; either is taken): maximize the focused column or restore. Never with Alt, and never inside an IME
// composition. A pane posts it as 'maximize' (pane.mjs).
export const maximizeKey = ({ key, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false, isComposing = false, keyCode = 0 } = {}) => (
  key === 'Enter' && shiftKey && !altKey && (ctrlKey || metaKey) && !isComposing && keyCode !== 229
);

// The state of a column's tile: 'running' (green: the terminal runs, or a sub-agent of it), 'waiting' (orange: the terminal waits at a question, a
// T-Attention task of that terminal waits for the person, or the terminal finished and was not seen yet), 'idle' (grey: anything else, a column with
// no terminal). `kind` names the question the terminal waits at, 'select' or 'accept' ("Two waiting kinds" in docs/design/terminals.md), else null.
// `activity` is the top page's terminal activity, { sourceKey: { taskId: { terminalId: 'running' | 'select' | 'accept' | 'done' } } } (h5.js
// `terminalActivity`); `items` the T-Attention items of the top page (`state.attention.items`, tagged with their engine). `count` is the number of items
// that need the person, and `question` the pending text of the newest of them ('' when none).
export function columnStatus(info, { activity, items } = {}) {
  const target = info ? info.target : null;
  if (!target) return { state: 'idle', kind: null, count: 0, question: '' };
  const needs = (Array.isArray(items) ? items : []).filter(item => item && item.status === 'waiting_user' && (item.engine || 'local') === target.sourceKey && matchesTarget(item, target));
  needs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const ran = ((((activity || {})[target.sourceKey] || {})[target.taskId]) || {})[target.terminalId];
  const kind = WAITING_WORDS[ran] ? ran : null;
  const state = needs.length || kind || ran === 'done' ? 'waiting' : ran === 'running' ? 'running' : 'idle';
  return { state, kind, count: needs.length, question: needs.length ? pendingText(needs[0]) : '' };
}
const contextOfItem = item => {
  const raw = item && item.context;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
};
const matchesTarget = (item, target) => {
  const tagent = contextOfItem(item).tagent;
  return Boolean(tagent && String(tagent.task_id) === String(target.taskId) && String(tagent.terminal_id) === target.terminalId);
};
const pendingText = item => {
  const pending = contextOfItem(item).pending;
  const text = pending && pending.text ? String(pending.text) : item.attention_reason ? String(item.attention_reason) : '';
  return text.trim().slice(0, 400);
};
// The English words of a tile's state (the page translates them): the label of the tile is "<name>, <agent> <state>".
export const STATE_WORDS = { running: 'running', waiting: 'needs you', idle: 'idle' };
// A wait at a question says which kind it is, in the same colour: "Needs selection" (the agent asks the person to choose or enter something) or
// "Needs acceptance" (it waits for an approval); "Needs you" stays for a finished turn not seen yet and a T-Attention task.
export const WAITING_WORDS = { select: 'Needs selection', accept: 'Needs acceptance' };
// The words of a state from one of the word tables (capitalized like TaskDrawer.jsx `STATE_WORDS`, or lower case like the ones here), with the kind.
export const stateWord = (words, state, kind) => {
  const named = state === 'waiting' && WAITING_WORDS[kind];
  if (!named) return words[state];
  return words.waiting === 'needs you' ? named.toLowerCase() : named;
};
export const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };
// The short name of a column for its tile and peek: the task, else '' (the caller says "Column N").
export const columnName = info => (info && info.title) || '';

// ── The header of a column and the column list of the bar ──
// The words of a column's state in the column list ("focused" wins over the others) and in the header's label.
export const LIST_WORDS = { focused: 'focused', running: 'running', waiting: 'needs you', idle: 'idle' };
export const listState = (status, focused) => (focused ? 'focused' : status.state);
// The name a column's header shows: { title, session }, both '' before the pane said them.
export function headerName(info) {
  if (!info) return { title: '', session: '' };
  return { title: info.title || '', session: info.title ? info.session || '' : '' };
}
// The accessible name of a column's header: "<task>, <session>, <state>" (e.g. "SELF-TAGENT, main dev, needs you"); `name` is the shown title when the
// pane said none ("Column 2", "Choose a task"). The words are English; the page translates the parts it knows.
export function headerLabel(info, words, fallback) {
  const { title, session } = headerName(info);
  return [title || fallback, session, words].filter(Boolean).join(', ');
}
// The summary of the bar: how many open columns run and how many need the person, and the first of those (in the order shown), or null.
export function summarize(ids, statusOf) {
  let running = 0;
  let waiting = 0;
  let first = null;
  for (const id of ids) {
    const state = statusOf(id).state;
    if (state === 'running') running += 1;
    if (state === 'waiting') { waiting += 1; if (!first) first = id; }
  }
  return { running, waiting, first };
}

// ── The navigation rail ──
// The arrow keys move the focus between the rail's destinations (Up / Left: the previous, Down / Right: the next, wrapping; Home / End: the first and
// the last); Tab reaches each of them and Enter or Space opens one (they are buttons). Returns the index to focus, or -1 for another key.
export function railKey(key, index, count) {
  if (!(count > 0)) return -1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}
// The destinations of the rail, top to bottom (Update and Settings sit at its bottom). Columns and Mind maps are tabs of the columns view; a page that
// cannot show that view (a framed page: `state.columns` is null) has no Columns destination and opens the mind maps over the whole window.
// Attention is not a page: it shows or hides the T-Attention panel on the right. Learn is a page of its own over the rest (the Learn page, `learnOpen`).
export const RAIL_DESTINATIONS = [
  { view: 'sessions', id: 'h5-nav-sessions', icon: 'terminalKeyboard', label: 'Sessions' },
  { view: 'columns', id: 'h5-nav-columns', icon: 'columns', label: 'Columns', needsColumns: true },
  { view: 'attention', id: 'h5-nav-attention', icon: 'attention', label: 'Attention', toggle: true },
  { view: 'maps', id: 'h5-nav-maps', icon: 'mindmap', label: 'Mind maps' },
  { view: 'learn', id: 'h5-nav-learn', icon: 'learn', label: 'Learn' },
];
export const railDestinations = canShowColumns => RAIL_DESTINATIONS.filter(item => canShowColumns || !item.needsColumns);
// The destination that is the current page (`aria-current="page"`): Settings while it is open, else Learn while it is open, else the tab of the
// columns view while it is shown, else Sessions (the single view).
export function railView({ settingsOpen = false, learnOpen = false, columns = null } = {}) {
  if (settingsOpen) return 'settings';
  if (learnOpen) return 'learn';
  if (columns && columns.shown) return readTab(columns.tab) === 'maps' ? 'maps' : 'columns';
  return 'sessions';
}
// The phone's bottom navigation (BottomNav.jsx): the same destinations without Columns (a phone has no columns view), then Settings. On a phone
// Attention, Mind maps and Settings are pages of their own over the terminal page: one at a time, and Sessions is the terminal page itself.
export const SETTINGS_DESTINATION = { view: 'settings', id: 'h5-bnav-settings', icon: 'setting', label: 'Settings' };
// The ids of the bar's items; Attention keeps the page's T-Attention id (`#h5-attention`), which a phone has nowhere else.
const PHONE_IDS = { sessions: 'h5-bnav-sessions', attention: 'h5-attention', maps: 'h5-bnav-maps', learn: 'h5-bnav-learn', settings: 'h5-bnav-settings' };
export const phoneDestinations = () => [...railDestinations(false), SETTINGS_DESTINATION].map(item => ({ ...item, id: PHONE_IDS[item.view], toggle: false }));
// The destination that is shown on a phone: Settings, T-Attention, Learn or the mind maps while open (in that order, the one on top first), else Sessions.
export function phoneView({ settingsOpen = false, attentionOpen = false, learnOpen = false, mindmapOpen = false } = {}) {
  if (settingsOpen) return 'settings';
  if (attentionOpen) return 'attention';
  if (learnOpen) return 'learn';
  if (mindmapOpen) return 'maps';
  return 'sessions';
}
// The red badge of the "Columns" destination: the number of open columns that need the person, the same count as the bar's "N needs you" chip.
export const needsCount = (ids, statusOf) => summarize(ids, statusOf).waiting;

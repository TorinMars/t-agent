// The multi-column view (Columns.jsx): the rules without the page. Each column is an iframe of the same page in pane mode, `/h5?pane=<id>`; the top
// page only keeps the list of column ids, in order, and whether the view is on. See "Multi-column view" in DESIGN.md.

export const STORAGE_KEY = 'h5-columns'; // { on: boolean, ids: [id, ...] }, one per device
export const MAX_COLUMNS = 12;
// The width of a column: up to VISIBLE_COLUMNS columns share the strip's visible width evenly; with more, each one is a quarter of that width and the
// strip scrolls sideways (nothing is squeezed). Never narrower than MIN_COLUMN_WIDTH, so a narrow window fits fewer and scrolls earlier.
export const VISIBLE_COLUMNS = 4;
export const MIN_COLUMN_WIDTH = 360; // px
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
export const PANE_EVENTS = new Set(['ready', 'focus', 'title', 'scroll-x', 'step', 'move', 'maximize', 'peek']);
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

// The number of columns the first use opens: as many as fit at MIN_COLUMN_WIDTH, at least 2 and at most VISIBLE_COLUMNS (4 from 1440px).
export const defaultCount = width => Math.max(2, Math.min(VISIBLE_COLUMNS, Math.floor((Number(width) || 0) / MIN_COLUMN_WIDTH)));

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

// The stored layout, cleaned: only valid, distinct ids, at most MAX_COLUMNS. Anything unreadable is the default (off, no ids yet).
export function readLayout(raw) {
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  const ids = [];
  for (const id of (data && Array.isArray(data.ids) ? data.ids : [])) if (isPaneId(id) && !ids.includes(id) && ids.length < MAX_COLUMNS) ids.push(id);
  return { on: Boolean(data && data.on === true), ids };
}
export const writeLayout = layout => JSON.stringify({ on: Boolean(layout.on), ids: layout.ids.slice(0, MAX_COLUMNS) });

// The ids to show when the view is turned on: the stored ones, or on first use the default number of new ones.
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

// A message from a pane: { type: 't-agent-pane', paneId, event: 'ready' | 'focus' | 'title' | 'scroll-x' | 'step' | 'move' | 'maximize' | 'peek',
// title?, session?, device?, map?, target?, agent?, dx?, step?, lines? }. 'title': the task and session shown, and the device of that task when the
// pane's list tags it (`device`: { name, instanceId, local, offline }, kept only with a name or as this machine), the mind map the pane shows (`map`:
// { title, screen: 'list' | 'editor' }, see "mind map columns" below), the terminal it shows (`target`: { sourceKey, taskId, terminalId }, for the
// state of its tile in the rail) and that terminal's agent ('claude', 'codex' or none); 'scroll-x': a sideways wheel or trackpad swipe inside the pane
// that nothing in it scrolls (dx in px, nonzero, at most 10000 either way); 'step': Ctrl+Alt+Left / Right pressed inside the pane, 'move':
// Ctrl+Alt+Shift+Left / Right (step -1 or 1); 'maximize': Cmd/Ctrl+Shift+Enter (or the mind map's Maximize button) in the pane, to maximize its
// column or to restore the columns (a toggle);
// 'peek': the answer to a peek request, the last lines of the pane's terminal (at most PEEK_LINES strings). Anything else is null.
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
    const map = readMapInfo(data.map);
    if (map) message.map = map;
    const target = readTarget(data.target);
    if (target) message.target = target;
    if (AGENTS.has(data.agent)) message.agent = data.agent;
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

// The device of a pane's task as its tab shows it (the same engine tag as the task list): a name (this machine may have none: an older server), the
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

// ── Mind map columns ──
// A column shows a mind map when its pane has the mind map view open (the list of maps, or one map in the editor): the view is the pane's own
// `#h5-mindmap`, a fixed layer of the pane's window, so it fills the column and never the top page. The pane says so in its `title` message (`map`),
// and the tab draws the map icon and name. What a column shows is remembered by the pane itself, like its task and terminal: `pane:<id>:h5-mindmap`
// (MAP_KEY under the pane's prefix) = { screen: 'list' } or { screen: 'editor', sourceKey, id }; a pane that starts with it opens the view again.
// "Add mind map column" makes a new column at the end and writes { screen: 'list' } under its key before its iframe exists, so it starts on the list.
// A map opened from the list of a column opens in that column (the one the person is using, so the focused one).
export const MAP_KEY = 'h5-mindmap';
const SOURCE_KEY = /^(local|remote:[1-9]\d*)$/;
const MAP_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const mapKeyOf = paneId => `pane:${paneId}:${MAP_KEY}`;
// What a column's pane remembers of its mind map view, cleaned; null for nothing usable (the column shows its task as usual).
export function readMapColumn(raw) {
  let data = null;
  try { data = typeof raw === 'string' && raw ? JSON.parse(raw) : raw; } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (data.screen === 'list') return { screen: 'list' };
  if (data.screen === 'editor' && typeof data.sourceKey === 'string' && SOURCE_KEY.test(data.sourceKey) && typeof data.id === 'string' && MAP_ID.test(data.id)) return { screen: 'editor', sourceKey: data.sourceKey, id: data.id };
  return null;
}
// The stored text of a view (what the mind map reports: { screen, sourceKey?, id?, title? }), or null when nothing is to be kept.
export function writeMapColumn(view) {
  const clean = readMapColumn(view);
  return clean ? JSON.stringify(clean) : null;
}
// The `map` of a pane's title message: { title (the map's name, '' on the list), screen }; null when the pane shows no map.
export function readMapInfo(value) {
  if (!value || typeof value !== 'object' || (value.screen !== 'list' && value.screen !== 'editor')) return null;
  return { title: typeof value.title === 'string' ? value.title.trim().slice(0, TEXT_MAX) : '', screen: value.screen };
}
// "Add mind map column": the new column (at the end, a fresh id) and the order with it; null when no column can be added (12 open already). `open`
// are the open columns, `taken` every id still mounted (a column being closed keeps its id until it is gone).
export function addMapColumn(open, taken = open, random = Math.random) {
  if (!canAdd(open)) return null;
  const id = newId(taken, random);
  return { id, ids: [...taken, id] };
}

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
// `state.columns.maximized` is the id of the maximized column, or null. Any open column can be maximized, whatever it shows (a terminal, a chat, a
// mind map), only while the strip is shown, and only one at a time. It is not stored: a reload shows the columns side by side again.
export const RAIL_WIDTH = 72; // px
export const isMapColumn = (columns, id) => Boolean(columns && columns.titles && columns.titles[id] && columns.titles[id].map);
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
// composition. A pane posts it as 'maximize' (pane.mjs; the mind map view of a pane posts it itself, since it knows when a topic is being edited).
export const maximizeKey = ({ key, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false, isComposing = false, keyCode = 0 } = {}) => (
  key === 'Enter' && shiftKey && !altKey && (ctrlKey || metaKey) && !isComposing && keyCode !== 229
);

// The state of a column's tile: 'running' (green: the terminal runs, or a sub-agent of it), 'waiting' (orange: a T-Attention task of that terminal
// waits for the person, or the terminal finished and was not seen yet), 'idle' (grey: anything else, a map column, a column with no terminal).
// `activity` is the top page's terminal activity, { sourceKey: { taskId: { terminalId: 'running' | 'done' } } } (h5.js `terminalActivity`); `items`
// the T-Attention items of the top page (`state.attention.items`, tagged with their engine). `count` is the number of items that need the person, and
// `question` the pending text of the newest of them ('' when none).
export function columnStatus(info, { activity, items } = {}) {
  const target = info && !info.map ? info.target : null;
  if (!target) return { state: 'idle', count: 0, question: '' };
  const needs = (Array.isArray(items) ? items : []).filter(item => item && item.status === 'waiting_user' && (item.engine || 'local') === target.sourceKey && matchesTarget(item, target));
  needs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const ran = ((((activity || {})[target.sourceKey] || {})[target.taskId]) || {})[target.terminalId];
  const state = needs.length || ran === 'done' ? 'waiting' : ran === 'running' ? 'running' : 'idle';
  return { state, count: needs.length, question: needs.length ? pendingText(needs[0]) : '' };
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
export const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };
// The short name of a column for its tile and peek: the map's name for a map column ('Mind maps' on the list), else the task (and the session),
// else '' (the caller says "Column N").
export function columnName(info) {
  if (!info) return '';
  if (info.map) return info.map.title || 'Mind maps';
  return info.title || '';
}

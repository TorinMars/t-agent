// The multi-column view (Columns.jsx): the rules without the page. Each column is an iframe of the same page in pane mode, `/h5?pane=<id>`; the top
// page only keeps the list of column ids, in order, and whether the view is on. See "Multi-column view" in DESIGN.md.

export const STORAGE_KEY = 'h5-columns'; // { on: boolean, ids: [id, ...] }, one per device
export const MAX_COLUMNS = 12;
// The width of a column: never narrower than an 80-column terminal at the pane's terminal font (minColumnWidth); wider windows share the space evenly,
// and when the columns do not fit the strip scrolls sideways (nothing is squeezed).
export const TERMINAL_COLUMNS = 80;
export const MIN_COLUMN_FLOOR = 480; // px; never narrower, whatever the font measures
export const FALLBACK_COLUMN_WIDTH = 640; // px; when the character width cannot be measured
// The space beside the terminal's cells inside a column: the inset of `.h5-terminal .h5-xterm` (4px on each side, public/css/h5.css) and the
// column's 1px left border. xterm's vertical scrollbar is measured by the caller and added to it.
export const TERMINAL_SIDE_PADDING = 8 + 1;
export const minColumnWidth = (charWidth, padding = TERMINAL_SIDE_PADDING) => {
  const char = Number(charWidth);
  const extra = Number(padding);
  if (!Number.isFinite(char) || char <= 0 || char > 100) return FALLBACK_COLUMN_WIDTH;
  return Math.max(MIN_COLUMN_FLOOR, Math.ceil(TERMINAL_COLUMNS * char + (Number.isFinite(extra) && extra > 0 ? extra : 0)));
};
export const DEFAULT_COLUMN_WIDTH = 420; // the first use opens floor(width / column width) columns, 2 to 4
export const MESSAGE_TYPE = 't-agent-pane';
export const PANE_EVENTS = new Set(['ready', 'focus', 'title', 'scroll-x', 'step']);
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

export const defaultCount = (width, columnWidth = DEFAULT_COLUMN_WIDTH) => Math.max(2, Math.min(4, Math.floor((Number(width) || 0) / (Number(columnWidth) > 0 ? Number(columnWidth) : DEFAULT_COLUMN_WIDTH))));

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
export function columnsFor(ids, width, random = Math.random, columnWidth = DEFAULT_COLUMN_WIDTH) {
  if (ids.length) return ids.slice(0, MAX_COLUMNS);
  const made = [];
  for (let i = 0; i < defaultCount(width, columnWidth); i += 1) made.push(newId(made, random));
  return made;
}
export const canAdd = ids => ids.length < MAX_COLUMNS;
export const canClose = ids => ids.length > 1; // the last column is never closed: leaving the view is the toggle
export const addColumn = (ids, random = Math.random) => (canAdd(ids) ? [...ids, newId(ids, random)] : ids);
export const closeColumn = (ids, id) => (canClose(ids) ? ids.filter(item => item !== id) : ids);

// A message from a pane: { type: 't-agent-pane', paneId, event: 'ready' | 'focus' | 'title' | 'scroll-x' | 'step', title?, session?, dx?, step? }.
// 'scroll-x': a sideways wheel or trackpad swipe inside the pane that nothing in it scrolls (dx in px, nonzero, at most 10000 either way);
// 'step': Ctrl+Alt+Left / Right pressed inside the pane (step -1 or 1). Anything else is null.
// The caller checks the origin and that the sender is one of its own iframes (and that its id is this paneId).
export function readPaneMessage(data) {
  if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE || !isPaneId(data.paneId) || !PANE_EVENTS.has(data.event)) return null;
  const text = value => (typeof value === 'string' ? value.trim().slice(0, TEXT_MAX) : '');
  const message = { paneId: data.paneId, event: data.event };
  if (data.event === 'title') { message.title = text(data.title); message.session = text(data.session); }
  if (data.event === 'scroll-x') {
    if (typeof data.dx !== 'number' || !Number.isFinite(data.dx) || data.dx === 0) return null;
    message.dx = Math.max(-SCROLL_MAX, Math.min(SCROLL_MAX, data.dx));
  }
  if (data.event === 'step') {
    if (data.step !== 1 && data.step !== -1) return null;
    message.step = data.step;
  }
  return message;
}

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

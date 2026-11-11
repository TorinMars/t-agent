// The multi-column view (Columns.jsx): the rules without the page. Each column is an iframe of the same page in pane mode, `/h5?pane=<id>`; the top
// page only keeps the list of column ids, in order, and whether the view is on. See "Multi-column view" in DESIGN.md.

export const STORAGE_KEY = 'h5-columns'; // { on: boolean, ids: [id, ...] }, one per device
export const MAX_COLUMNS = 6;
export const MIN_COLUMN_WIDTH = 380; // px; wider screens share the space evenly, narrower ones scroll sideways
export const DEFAULT_COLUMN_WIDTH = 420; // the first use opens floor(width / 420) columns, 2 to 4
export const MESSAGE_TYPE = 't-agent-pane';
export const PANE_EVENTS = new Set(['ready', 'focus', 'title']);
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

export const defaultCount = width => Math.max(2, Math.min(4, Math.floor((Number(width) || 0) / DEFAULT_COLUMN_WIDTH)));

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

// A message from a pane: { type: 't-agent-pane', paneId, event: 'ready' | 'focus' | 'title', title?, session? }. Anything else is null.
// The caller checks the origin and that the sender is one of its own iframes (and that its id is this paneId).
export function readPaneMessage(data) {
  if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE || !isPaneId(data.paneId) || !PANE_EVENTS.has(data.event)) return null;
  const text = value => (typeof value === 'string' ? value.trim().slice(0, TEXT_MAX) : '');
  const message = { paneId: data.paneId, event: data.event };
  if (data.event === 'title') { message.title = text(data.title); message.session = text(data.session); }
  return message;
}
export const forgetMessage = () => ({ type: MESSAGE_TYPE, event: 'forget' });
export const paneUrl = id => `/h5?pane=${encodeURIComponent(id)}`;

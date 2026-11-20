// The mind map view: the list of maps and the editor around one map. Plain DOM (the page's React bundle is not available here and would cost more than this file).
import { PATHS } from '../h5-shell/Icons.jsx';
import { readShared, writeShared } from '../h5-shell/shared-store.mjs';
import { shortName, tagColor } from '../h5-shell/task-order.mjs';
import { localGet, localSet } from '../h5-shell/local-keys.mjs';
import { createEditor } from './editor.js';
import { createSaver } from './saver.mjs';
import { blankDoc, sanitizeDoc, DocError } from './doc.mjs';
import { buildXmind, parseXmind, describeLost, XmindError, XMIND_LIMITS } from './xmind.mjs';

const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
// The services whose maps are listed (`sources` of the mount options, in the one order of devices, by name): { key, label, base, online, instanceId }.
// `label` is the device's name (this machine's engine name too); `base` is where that service's maps are (`/api/mindmaps` here,
// `/api/remote-servers/:id/mindmaps` for a connected service, same shapes); `instanceId` gives its tag the colour it has in the task list. Without the
// option the view shows this machine only.
const LOCAL_KEY = 'local';
const LOCAL_SOURCE = { key: LOCAL_KEY, label: 'This machine', local: true, base: '/api/mindmaps', online: true };
// A draft is kept per service and map. This machine keeps the key it always had, so a draft written before maps were shared still comes back; a connected
// service's key has its source key in it, and the draft itself says which service it is for (checked again when it is read).
// Kept in this browser: a draft is the copy of this browser's unsaved edits (up to DRAFT_MAX); the saved map is on its service for every device.
const DRAFT_KEY = (sourceKey, id) => (sourceKey === LOCAL_KEY ? `h5-mindmap-draft:${id}` : `h5-mindmap-draft:${sourceKey}|${id}`);
const OFFLINE_CODES = new Set(['REMOTE_OFFLINE', 'REMOTE_CONNECTION_FAILED']);
const DRAFT_MAX = 1500000; // characters; a larger map is not kept in the browser (a retry still has it in memory)
const KEEPALIVE_MAX = 60000; // bytes the browser allows in a request that outlives the page
const FLUSH_WAIT_MS = 3000;
// '1': the list of the Mind maps tab is folded away. The person's choice, the same on every device and engine (the shared page state, shared-store.mjs).
const FOLD_KEY = 'h5-mindmap-list-folded';
const readFolded = () => readShared(FOLD_KEY) === '1';
const writeFolded = on => writeShared(FOLD_KEY, on ? '1' : null);
// The machine "Create on" starts with: the one a task or map was last made on (a source key here; the shared page state keeps the instance id), the
// same on every device and engine ("Create on" in docs/design/entry-symmetry.md).
const CREATE_ON_KEY = 'h5-create-on';
const CODE_MESSAGES = {
  MINDMAP_NOT_FOUND: 'This map no longer exists',
  INVALID_MINDMAP: 'The service refused this map because its content is not valid',
  MINDMAP_TOO_LARGE: 'This map is too large to save (8 MB limit)',
  MINDMAP_LIMIT: 'No more maps can be created (limit reached)',
};
// While a map or the list is shown, the page asks this engine every POLL_MS whether the open map changed (on any engine: maps are copied to every
// linked engine, "Mind maps on every engine" in docs/design/mind-maps.md), and reads the list again every LIST_EVERY polls.
const POLL_MS = 10000;
const LIST_EVERY = 3;
const STATE_TEXT = { saved: 'Saved', dirty: 'Saving...', saving: 'Saving...', retrying: 'Not saved, retrying...', conflict: 'Conflict: not saved', rejected: 'Not saved' };

const SHORTCUTS = [
  ['Tab', 'Add subtopic'], ['Enter', 'Add topic after'], ['Shift+Enter', 'Add topic before'], ['Mod+Enter', 'Add parent topic'],
  ['F2 / Space', 'Edit topic'], ['Delete', 'Delete topic'], ['Arrows', 'Move selection'], ['Mod+/', 'Collapse or expand'],
  ['Mod+Z', 'Undo'], ['Mod+Shift+Z / Mod+Y', 'Redo'], ['Mod+C / X / V', 'Copy, cut, paste topics'],
  ['Mod+= / Mod+-', 'Zoom in / out'], ['Mod+0', 'Actual size'], ['Mod+9', 'Fit map'], ['F3', 'Label'], ['F4', 'Note'], ['Alt+Up / Down', 'Move topic'],
];

class ApiError extends Error {
  constructor(code, status, json) { super(code); this.code = code; this.status = status; this.json = json; }
}

async function raw(method, url, body, { keepalive = false } = {}) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: text, keepalive: keepalive && text !== undefined && text.length <= KEEPALIVE_MAX });
  const reply = await res.text();
  let json = {};
  try { json = reply ? JSON.parse(reply) : {}; } catch { json = {}; }
  return { status: res.status, json };
}

async function call(method, url, body) {
  let answer;
  try { answer = await raw(method, url, body); } catch { throw new ApiError('NETWORK', 0, {}); }
  if (answer.status < 200 || answer.status >= 300) throw new ApiError(answer.json.error || `HTTP_${answer.status}`, answer.status, answer.json);
  return answer.json;
}

const sourceName = src => (src.local && (!src.label || src.label === LOCAL_SOURCE.label) ? tr(LOCAL_SOURCE.label) : src.label); // "This machine" only on an older server without a name
// A connected service that did not answer (the proxy says 502). This machine never answers that way.
const isOffline = error => error instanceof ApiError && (error.status === 502 || OFFLINE_CODES.has(error.code));
const isUnsupported = error => error instanceof ApiError && (error.status === 501 || error.code === 'MINDMAPS_UNSUPPORTED');

// `src`: the service the request went to, named when it is offline.
function messageFor(error, src) {
  if (error instanceof XmindError || error instanceof DocError) return tr(error.message);
  if (error instanceof ApiError) {
    if (CODE_MESSAGES[error.code]) return tr(CODE_MESSAGES[error.code]);
    if (src && !src.local && isOffline(error)) return `${tr('This service is offline:')} ${sourceName(src)}`;
    if (isUnsupported(error)) return tr('This service is too old for mind maps. Update it first.');
    if (error.code === 'NETWORK') return tr('The service cannot be reached. Try again in a moment.');
    if (error.code === 'MINDMAP_HOME_OFFLINE' && error.json && typeof error.json.message === 'string') return tr(error.json.message);
  }
  return tr('Something went wrong');
}

function normalizeSources(list) {
  if (!Array.isArray(list)) return [LOCAL_SOURCE];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item.key !== 'string' || typeof item.base !== 'string' || seen.has(item.key)) continue;
    seen.add(item.key);
    const local = item.key === LOCAL_KEY;
    out.push({ key: item.key, label: String(item.label || (local ? LOCAL_SOURCE.label : item.key)), local, base: item.base.replace(/\/+$/, ''), online: local || item.online !== false, instanceId: typeof item.instanceId === 'string' ? item.instanceId : null });
  }
  return out;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child != null));
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function iconNode(name, size = 24) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1024 1024');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}
function iconButton(name, label, onClick, props = {}) {
  const text = tr(label);
  return el('button', { type: 'button', class: 'mm-icon', 'aria-label': text, title: text, onClick, ...props }, iconNode(name));
}

function parseTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? `${text.replace(' ', 'T')}Z` : text); // SQLite's UTC format, which older Safari cannot parse
  return Number.isNaN(date.getTime()) ? null : date;
}
function sizeText(bytes) {
  const n = Number(bytes) || 0;
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`;
}
const clipTitle = title => [...String(title || '').replace(/[\r\n]+/g, ' ').trim()].slice(0, 200).join(''); // the service takes 1 to 200 characters on one line
const safeFileName = title => `${String(title || 'Mind map').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120).trim() || 'Mind map'}.xmind`;

function download(bytes, name) {
  const file = new File([bytes], name, { type: 'application/vnd.xmind.workbook' });
  // A Home Screen app on iOS cannot follow a download link; the share sheet can save the file.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(file);
  const link = el('a', { href: url, download: name, style: 'display:none' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// `split`: the Mind maps tab of the multi-column view (see "Mind maps tab" in docs/design/mind-maps.md). The list of maps (search, New map, the maps of
// every service) stays on the left, about 280px, and the open map fills the rest; a button in the map's bar folds the list away (remembered per
// device, FOLD_KEY). There is no Close and no Back to the list: the navigation rail of the view is the way out. Escape in the editor (no topic edited,
// no dialog) moves the keyboard to the open map's row. The view takes keys only while its tab is shown (`active`, `setActive`) and only those meant
// for it (on its own elements, or on the page's body), since the rail and the columns' headers are on the same page.
export function mountApp(root, { onClose, notify = () => {}, onLayers = () => {}, sources: given, split = false, active: activeGiven = true }) {
  let disposed = false;
  let screen = 'list';
  let current = null; // { id, src, title, editor, saver, ... } the open map and the service it is on
  // The listed services (an empty list: not known yet, the list says "Loading..."), and what each one's list is, by source key:
  // { status: 'loading' | 'ready' | 'error' | 'offline' | 'unsupported', maps, error, seq, base }. A service whose answer is 501 is left out of the list.
  let sources = given === undefined ? [LOCAL_SOURCE] : normalizeSources(given);
  const lists = new Map();
  // Where this engine keeps the maps (`sync` of its list answer, services/mindmap-sync.js): undefined until it answered, null when it does not say
  // (the sync is off, or an older server: every service is listed as before), else { enabled, engines, older, cache_only, home_name, home_online,
  // waiting }. With the sync every map is in this engine's own list; a linked engine is read itself only when it is too old to keep a copy (`older`).
  let syncInfo;
  let loadSeq = 0;
  let createOn = null; // "Create on": the service chosen in this view; null: the one chosen last time (CREATE_ON_KEY), else the first
  let importTarget = null;
  let dialog = null; // the open dialog: { close }
  let active = split ? activeGiven !== false : true;
  let listFolded = split && readFolded();
  let query = ''; // the search of the split list
  const say = (text, kind) => notify(text, kind);
  // Whether a key or clipboard event is the view's: always in the full-window view; in the tab only while it is shown and the event is on its own
  // elements (or on nothing in particular: the page's body).
  const owns = event => {
    if (!split) return true;
    if (!active) return false;
    const target = event && event.target;
    return !target || target === document.body || target === document.documentElement || root.contains(target);
  };

  root.replaceChildren();
  root.classList.add('mm');
  root.classList.toggle('mm-split', split);
  if (split) {
    root.setAttribute('role', 'region');
    root.removeAttribute('aria-modal');
  } else {
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
  }
  root.setAttribute('aria-label', tr('Mind maps'));

  // ── Layers for the back gesture: closing the view, leaving the editor, closing a dialog ──
  function pushLayers() {
    const layers = [closeAll];
    if (screen === 'editor') layers.push(() => { void leaveEditor(); });
    if (dialog) layers.push(dialog.close);
    onLayers(layers);
  }
  function closeAll() { if (screen === 'editor') void leaveEditor({ thenClose: true }); else onClose(); }

  // ── Dialogs (inside the view, so the terminal and its keys stay out of it) ──
  function openDialog(titleText, content, buttons, { onDismiss } = {}) {
    if (dialog) dialog.close();
    const opener = document.activeElement;
    const box = el('div', { class: 'mm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': titleText });
    const wrap = el('div', { class: 'mm-dialog-wrap', onPointerdown: e => { if (e.target === wrap) dismiss(); } }, box);
    const close = () => {
      if (!dialog || dialog.box !== box) return;
      dialog = null;
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      pushLayers();
      if (current && current.editor && screen === 'editor') current.editor.focus();
      else if (opener && opener.focus && opener.isConnected) opener.focus();
    };
    const dismiss = () => { close(); if (onDismiss) onDismiss(); };
    function onKey(e) {
      if (!owns(e) && !box.contains(e.target)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...box.querySelectorAll('button, input, textarea, a[href]')].filter(n => !n.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    box.append(el('h2', { class: 'mm-dialog-title', text: titleText }));
    if (content) box.append(content);
    if (buttons && buttons.length) {
      box.append(el('div', { class: 'mm-dialog-actions' }, ...buttons.map(b => el('button', { type: 'button', class: b.primary ? 'mm-btn mm-btn-primary' : b.danger ? 'mm-btn mm-btn-danger' : 'mm-btn', text: b.label, onClick: () => { if (b.keepOpen) b.run(close); else { close(); b.run && b.run(); } } }))));
    }
    root.append(wrap);
    document.addEventListener('keydown', onKey, true);
    dialog = { box, close: dismiss };
    pushLayers();
    const input = box.querySelector('input, textarea');
    (input || box.querySelector('button')).focus();
    if (input && input.select) input.select();
    return { close, dismiss };
  }
  const confirmDialog = (titleText, message, label, run) => openDialog(titleText, el('p', { class: 'mm-dialog-text', text: message }), [{ label: tr('Cancel') }, { label, danger: true, run }]);
  function promptDialog(titleText, value, label, run, { multiline = false, placeholder = '' } = {}) {
    const input = multiline
      ? el('textarea', { class: 'mm-input', rows: '6', placeholder })
      : el('input', { class: 'mm-input', type: 'text', placeholder });
    input.value = value;
    const submit = close => { const text = input.value; close(); run(text); };
    let handle = null;
    if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); submit(handle.close); } });
    handle = openDialog(titleText, input, [{ label: tr('Cancel') }, { label, primary: true, keepOpen: true, run: submit }]);
    return handle;
  }

  // ── List ──
  const rows = el('div', { class: 'mm-rows' });
  const fileInput = el('input', { type: 'file', class: 'mm-file', tabindex: '-1', 'aria-hidden': 'true', onChange: onFilePicked });
  if (!matchMedia('(pointer: coarse)').matches) fileInput.setAttribute('accept', '.xmind'); // on a phone a file type the system does not know could not be chosen at all
  // "Create on" (the same idea and words as the New task form of the task list): only when more than one service can take a new map.
  const createSelect = el('select', { id: 'mm-create-on', class: 'mm-select', 'aria-label': tr('Create on'), onChange: () => { createOn = createSelect.value; } });
  const createRow = el('label', { class: 'mm-on', hidden: true }, el('span', { class: 'mm-on-label', text: tr('Create on') }), createSelect);
  let createSig = '';
  // The search of the split list: the maps whose title contains the text (any case), on every service.
  const searchInput = split ? el('input', { id: 'mm-search', class: 'mm-search-input', type: 'search', placeholder: tr('Search'), 'aria-label': tr('Search mind maps'),
    autocomplete: 'off', spellcheck: 'false', onInput: () => { query = searchInput.value.trim().toLowerCase(); renderList(); },
    onKeydown: e => { if (e.key === 'Escape' && searchInput.value && !e.isComposing) { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; query = ''; renderList(); } } }) : null;
  const searchRow = split ? el('label', { class: 'mm-search' }, iconNode('search', 16), searchInput) : null;
  const listView = el('section', { class: 'mm-view mm-list', ...(split ? { id: 'mm-list', 'aria-label': tr('Mind maps') } : {}) },
    el('header', { class: 'mm-top' },
      split ? null : iconButton('close', 'Close', () => closeAll(), { id: 'mm-close' }),
      el('h1', { class: 'mm-heading', text: tr('Mind maps') }),
      iconButton('Import', 'Import .xmind', () => { importTarget = createTarget(); fileInput.click(); }, { id: 'mm-import' }),
      iconButton('add', 'New map', () => { void createMap(); }, { id: 'mm-new' })),
    searchRow, createRow, rows, fileInput);

  const sourceByKey = key => sources.find(src => src.key === key) || null;
  const listOf = src => lists.get(src.key) || { status: 'loading', maps: [] };
  const syncOn = () => Boolean(syncInfo && syncInfo.enabled);
  // The services whose maps are listed: this engine first alone (until it says whether it keeps every map), then with the sync this engine and the
  // older linked engines, without it every service.
  function listedSources() {
    if (syncInfo === undefined) return sources.filter(src => src.local);
    if (!syncOn()) return sources;
    const older = new Set(Array.isArray(syncInfo.older) ? syncInfo.older : []);
    return sources.filter(src => src.local || (src.instanceId && older.has(src.instanceId)));
  }
  // The services a map can be created on: online, and its list answered (so it is known to have maps at all). This machine always. With the sync
  // only this engine: a map made here is on every engine, so there is no "Create on".
  const createTargets = () => (syncOn() ? sources.filter(src => src.local)
    : listedSources().filter(src => (src.local ? listOf(src).status !== 'unsupported' : src.online && listOf(src).status === 'ready')));
  function createTarget() {
    const targets = createTargets();
    const last = createOn === null ? readShared(CREATE_ON_KEY) : null;
    return targets.find(src => src.key === createOn) || targets.find(src => src.key === last) || targets[0] || sourceByKey(LOCAL_KEY) || LOCAL_SOURCE;
  }
  // A map made on `src`: the next "Create on" starts there, here and on every other device (only when there was a choice).
  const noteCreated = src => { if (createTargets().length > 1) writeShared(CREATE_ON_KEY, src.key); };
  function updateCreateOn() {
    const targets = createTargets();
    const picked = createTarget();
    const sig = JSON.stringify([targets.map(src => [src.key, sourceName(src)]), picked.key]);
    if (sig === createSig) return; // rebuilding the options would close a select that is open
    createSig = sig;
    createSelect.replaceChildren(...targets.map(src => el('option', { value: src.key, translate: src.local ? false : 'no', text: sourceName(src) })));
    createSelect.value = picked.key;
    createRow.hidden = targets.length < 2;
  }

  // Reads one service's list. Each fails on its own: a slow or offline one neither delays nor blanks the others, and a late answer of an older read is ignored.
  async function loadSource(src) {
    const seq = (loadSeq += 1);
    const before = lists.get(src.key);
    if (!src.online) { lists.set(src.key, { status: 'offline', maps: [], seq, base: src.base }); renderList(); return; }
    // A list already shown stays while it is read again, so a rename or a return from the editor does not flash "Loading...".
    lists.set(src.key, before && before.status === 'ready' && before.base === src.base ? { ...before, seq } : { status: 'loading', maps: [], seq, base: src.base });
    renderList();
    let next;
    let sync = null;
    try {
      const answer = await call('GET', src.base);
      next = { status: 'ready', maps: Array.isArray(answer.maps) ? answer.maps : [] };
      sync = answer.sync && typeof answer.sync === 'object' ? answer.sync : null;
    } catch (error) {
      next = isUnsupported(error) ? { status: 'unsupported', maps: [] }
        : !src.local && isOffline(error) ? { status: 'offline', maps: [] }
          : { status: 'error', maps: [], error };
    }
    const now = lists.get(src.key);
    if (disposed || !now || now.seq !== seq || !sourceByKey(src.key)) return;
    lists.set(src.key, { ...next, seq, base: src.base });
    if (src.local) noteSync(next.status === 'ready' ? sync : (syncInfo || null));
    renderList();
  }
  // This engine said where it keeps the maps: the services listed follow (an older engine that came into view is read).
  function noteSync(sync) {
    const before = JSON.stringify(listedSources().map(src => src.key));
    syncInfo = sync;
    if (JSON.stringify(listedSources().map(src => src.key)) === before) return;
    for (const src of listedSources()) if (!src.local && !lists.has(src.key)) void loadSource(src);
  }
  function loadList() {
    renderList();
    return Promise.all(listedSources().map(src => loadSource(src)));
  }

  // The engine tag of a row (`tagged`: more than one service is listed): the device's name cut to 8 characters in the colour its instance id gives it in
  // the task list (task-order.mjs), muted when the service is offline.
  function tagOf(src) {
    const { index, color, background } = tagColor(src.instanceId);
    const name = sourceName(src);
    return el('span', { class: 'mm-row-tag', translate: 'no', title: name, 'data-source': src.key, 'data-color': String(index), style: `color:${color};background:${background}`, text: shortName(name) });
  }
  // With the sync the map is on every engine, so its tag says where it was edited last (the same tag, coloured by that engine's instance id).
  function editedTag(map) {
    const name = typeof map.by_name === 'string' && map.by_name ? map.by_name : null;
    if (!name) return null;
    const { index, color, background } = tagColor(map.by || null);
    const title = `${tr('Edited on')} ${name}`;
    return el('span', { class: 'mm-row-tag', translate: 'no', title, 'aria-label': title, 'data-edited': map.by || '', 'data-color': String(index), style: `color:${color};background:${background}`, text: shortName(name) });
  }
  function mapRow(src, map, tagged = false) {
    const when = parseTime(map.updated_at);
    const meta = [when ? when.toLocaleString() : '', sizeText(map.size)].filter(Boolean).join(' · ');
    const ref = `${src.key}|${map.id}`;
    const tag = !tagged ? null : src.local && syncOn() ? editedTag(map) : tagOf(src);
    return el('div', { class: 'mm-row', role: 'listitem', 'data-source': src.key, 'data-id': map.id, 'data-ref': ref },
      el('button', { type: 'button', class: 'mm-row-open', 'data-part': 'open', onClick: () => { void openFromList(src, map.id); } },
        el('span', { class: 'mm-row-title', translate: 'no', text: map.title || tr('Untitled map') }),
        el('span', { class: 'mm-row-line' }, tag, el('span', { class: 'mm-row-meta', translate: 'no', text: meta }))),
      iconButton('draftKeyboard', 'Rename', () => renameMap(src, map), { 'data-part': 'rename' }),
      iconButton('delete', 'Delete', () => deleteMap(src, map), { 'data-part': 'delete' }));
  }
  const note = (text, extra = '') => el('p', { class: `mm-note${extra}`, text });
  const retry = src => el('button', { type: 'button', class: 'mm-btn mm-retry', text: tr('Try again'), onClick: () => { void loadSource(src); } });

  // One list of the maps of every listed service, the last edited first ("Mind maps in one list" in docs/design/entry-symmetry.md): each row with its
  // engine tag when more than one service is listed, no group per service and no place of its own for this machine, so the page of every engine shows
  // the same list. A service that cannot list its maps now says so in one line under the list (its name, and "Loading...", "Offline" or the error
  // with Try again), in the one order of devices.
  const editedAt = map => { const when = parseTime(map.updated_at); return when ? when.getTime() : 0; };
  function renderList() {
    updateCreateOn();
    // The focus stays on the same button of the same row when a service's answer redraws the list.
    const active = document.activeElement;
    const focusRow = active && rows.contains(active) && active.closest('.mm-row');
    const focus = focusRow ? [focusRow.dataset.ref, active.dataset.part] : null;
    const shown = listedSources().filter(src => listOf(src).status !== 'unsupported');
    if (!shown.length) { rows.replaceChildren(note(tr(sources.length ? 'No mind maps yet. Create one or import a .xmind file.' : 'Loading...'))); return; }
    // Tags when more than one engine is involved: several services listed, or (with the sync) more than one engine keeping the maps.
    const tagged = shown.length > 1 || (syncOn() && Array.isArray(syncInfo.engines) && syncInfo.engines.length > 1);
    const rank = new Map(shown.map((src, index) => [src.key, index]));
    const all = shown.filter(src => listOf(src).status === 'ready').flatMap(src => listOf(src).maps.map(map => ({ src, map })));
    const maps = (query ? all.filter(({ map }) => String(map.title || tr('Untitled map')).toLowerCase().includes(query)) : all)
      .sort((a, b) => editedAt(b.map) - editedAt(a.map) || rank.get(a.src.key) - rank.get(b.src.key) || String(a.map.id).localeCompare(String(b.map.id)));
    const waiting = shown.filter(src => listOf(src).status !== 'ready');
    const parts = [];
    // A company computer whose home is away lists the maps it has (opened here lately, or made here), and says so.
    if (syncOn() && syncInfo.cache_only && syncInfo.home_online === false && syncInfo.home_name) {
      const waitingCount = Number(syncInfo.waiting) || 0;
      const text = `${tr(`${syncInfo.home_name} can't be reached. These are the maps opened on this computer lately; changes are kept here and move to ${syncInfo.home_name} when it is back.`)}${waitingCount ? ` ${tr(`${waitingCount} changes wait.`)}` : ''}`;
      parts.push(el('p', { class: 'mm-banner', role: 'status', 'data-part': 'home-offline', text }));
    }
    if (maps.length) parts.push(el('div', { class: 'mm-section-rows', role: 'list' }, ...maps.map(({ src, map }) => mapRow(src, map, tagged))));
    else if (waiting.length === shown.length && waiting.every(src => listOf(src).status === 'loading')) parts.push(note(tr('Loading...')));
    else if (query && all.length) parts.push(note(tr('No maps match')));
    else if (!waiting.length || !all.length) parts.push(note(tr(waiting.length ? 'No mind maps' : 'No mind maps yet. Create one or import a .xmind file.')));
    for (const src of waiting) {
      const list = listOf(src);
      const name = tagged ? el('span', { class: 'mm-source-name', translate: 'no', text: sourceName(src) }) : null;
      const line = el('p', { class: 'mm-source', 'data-source': src.key, 'data-state': list.status }, name,
        list.status === 'offline' ? el('span', { class: 'mm-source-offline', text: tr('Offline') })
          : el('span', { class: 'mm-source-state', text: list.status === 'error' ? messageFor(list.error, src) : tr('Loading...') }));
      parts.push(list.status === 'error' ? el('div', { class: 'mm-source-error' }, line, retry(src)) : line);
    }
    rows.replaceChildren(...parts);
    markCurrent();
    if (focus) {
      const row = [...rows.querySelectorAll('.mm-row')].find(node => node.dataset.ref === focus[0]);
      const button = row && row.querySelector(`[data-part="${focus[1]}"]`);
      if (button) button.focus();
    }
  }
  // The split list marks the row of the open map (and keeps its title in step with the editor's).
  function markCurrent() {
    if (!split) return;
    const ref = current ? `${current.src.key}|${current.id}` : '';
    for (const row of rows.querySelectorAll('.mm-row')) {
      const open = row.querySelector('.mm-row-open');
      row.toggleAttribute('data-current', row.dataset.ref === ref);
      if (row.dataset.ref === ref) {
        open.setAttribute('aria-current', 'true');
        const title = row.querySelector('.mm-row-title');
        if (title && current.title && title.textContent !== current.title) title.textContent = current.title;
      } else open.removeAttribute('aria-current');
    }
  }

  // The services listed changed (connected, removed, hidden or shown again, offline or back). A new one, or one that came back, is read; the rest keep their lists.
  function setSources(list) {
    const next = normalizeSources(list);
    const before = new Map(sources.map(src => [src.key, src]));
    sources = next;
    for (const key of [...lists.keys()]) if (!sourceByKey(key)) lists.delete(key);
    if (!sourceByKey(createOn)) createOn = null;
    for (const src of listedSources()) {
      const old = before.get(src.key);
      const back = old && !old.online && src.online;
      if (!old || old.base !== src.base || old.online !== src.online || !lists.has(src.key)) void loadSource(src);
      // The open map's service is back: its waiting save goes now.
      if (back && current && current.src.key === src.key && current.saver) current.saver.wake();
    }
    renderList();
  }

  // The split view keeps one map open: before another one is shown, the open one is left (its edits saved, a short wait only). False when it is still
  // leaving (a second click meanwhile).
  async function makeRoom() {
    if (!split || !current) return true;
    await leaveEditor({ silent: true });
    return !current;
  }
  async function openFromList(src, id) {
    if (split && current && current.src.key === src.key && current.id === id) { if (current.editor) current.editor.focus(); return; }
    if (!(await makeRoom())) return;
    await openMap(src, id);
  }

  async function createMap() {
    const src = createTarget();
    if (!(await makeRoom())) return;
    try {
      const title = tr('Untitled map');
      const created = await call('POST', src.base, { title });
      noteCreated(src);
      showEditor(created, src);
    } catch (error) { say(messageFor(error, src), 'error'); }
  }
  function renameMap(src, map) {
    // The open map of the split view is renamed through its editor, which saves the title with the map (a rename of its own would raise the revision
    // under the editor's save).
    if (split && current && current.src.key === src.key && current.id === map.id) {
      promptDialog(tr('Rename map'), current.title || '', tr('Rename'), value => {
        const title = value.trim();
        if (!title || !current || current.id !== map.id) return;
        titleField.value = title;
        commitTitle();
      });
      return;
    }
    promptDialog(tr('Rename map'), map.title || '', tr('Rename'), async value => {
      const title = value.trim();
      if (!title || title === map.title) return;
      try {
        await call('PUT', `${src.base}/${encodeURIComponent(map.id)}`, { revision: map.revision, title });
        await loadSource(src);
      } catch (error) {
        say(error.code === 'MINDMAP_CONFLICT' ? tr('This map was changed elsewhere. The list was reloaded.') : messageFor(error, src), 'error');
        void loadSource(src);
      }
    });
  }
  function deleteMap(src, map) {
    confirmDialog(tr('Delete map'), `${tr('Delete this map? This cannot be undone.')} ${map.title || ''}`, tr('Delete'), async () => {
      // The open map of the split view is closed first, without saving it again.
      if (split && current && current.src.key === src.key && current.id === map.id) await returnToList(true);
      try {
        await call('DELETE', `${src.base}/${encodeURIComponent(map.id)}`);
        clearDraft(src.key, map.id);
        await loadSource(src);
      } catch (error) { say(messageFor(error, src), 'error'); void loadSource(src); }
    });
  }

  async function onFilePicked() {
    const file = fileInput.files && fileInput.files[0];
    const src = importTarget || createTarget(); // the service chosen when Import was pressed
    importTarget = null;
    fileInput.value = '';
    if (!file) return;
    if (file.size > XMIND_LIMITS.file) { say(tr('This .xmind file is too large'), 'error'); return; }
    if (!(await makeRoom())) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { doc, lost } = parseXmind(bytes, { parseXml: text => new DOMParser().parseFromString(text, 'text/xml') });
      const title = clipTitle(file.name.replace(/\.xmind$/i, '')) || tr('Imported map');
      const created = await call('POST', src.base, { title, data: doc });
      noteCreated(src);
      const dropped = describeLost(lost, tr);
      say(dropped.length ? `${tr('Imported.')} ${dropped.join(', ')}` : tr('Imported'), dropped.length ? 'warning' : 'success');
      await openMap(src, created.id);
    } catch (error) { say(messageFor(error, src), 'error'); }
  }

  // ── Editor ──
  const titleField = el('input', { class: 'mm-title', type: 'text', translate: 'no', 'aria-label': tr('Map title'), maxlength: '200', onChange: () => commitTitle(), onKeydown: e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') titleField.blur();
    else if (e.key === 'Escape') { titleField.value = current ? current.title : ''; titleField.blur(); if (current && current.editor) current.editor.focus(); }
  } });
  const statusNode = el('span', { class: 'mm-status', role: 'status' });
  const canvas = el('div', { class: 'mm-canvas', translate: 'no' });
  const barButtons = {};
  const barButton = (key, icon, label, run) => {
    const button = iconButton(icon, label, () => run(), { id: `mm-action-${key}`, onPointerdown: e => e.preventDefault() });
    barButtons[key] = button;
    return button;
  };
  const bar = el('nav', { class: 'mm-bar', 'aria-label': tr('Map actions') },
    barButton('child', 'subnode', 'Add subtopic', () => act('addChild')),
    barButton('sibling', 'sisternode', 'Add topic after', () => act('addSibling')),
    barButton('edit', 'edit', 'Edit topic', () => act('edit')),
    barButton('delete', 'delete', 'Delete topic', () => act('remove')),
    barButton('fold', 'minusSquare', 'Collapse', () => act('toggleFold')),
    barButton('undo', 'undo', 'Undo', () => act('undo')),
    barButton('redo', 'redo', 'Redo', () => act('redo')),
    barButton('fit', 'fitWindow', 'Fit map', () => act('fit')));
  const exportButton = iconButton('export', 'Export .xmind', () => exportMap(), { id: 'mm-export' });
  const moreButton = iconButton('taskMore', 'More', () => openMore(), { id: 'mm-more' });
  // The split view: fold the list away or bring it back (`aria-expanded`: whether the list is shown).
  const foldButton = split ? iconButton('sidebarFold', 'Hide the map list', () => setFolded(!listFolded), { id: 'mm-list-toggle', 'aria-controls': 'mm-list' }) : null;
  const emptyNote = split ? el('p', { class: 'mm-empty', text: tr('Open a mind map from the list, or create one.') }) : null;
  // "A newer version was saved on <engine>", with Reload, while the open map has edits of its own that are not saved (without them it reloads by itself).
  const newerText = el('span', { class: 'mm-newer-text' });
  const newerBar = el('div', { id: 'mm-newer', class: 'mm-newer', role: 'status', hidden: true }, newerText,
    el('button', { type: 'button', id: 'mm-newer-reload', class: 'mm-text-btn', text: tr('Reload the newer version'), onClick: () => { if (current) void reloadMap(current); } }));
  const editorView = el('section', { class: 'mm-view mm-editor', hidden: true },
    el('header', { class: 'mm-top' },
      split ? null : iconButton('back', 'Back to the list', () => { void leaveEditor(); }, { id: 'mm-back' }),
      titleField, statusNode, emptyNote ? el('span', { class: 'mm-top-gap' }) : null, foldButton, exportButton, moreButton),
    newerBar, emptyNote, canvas, bar);
  root.append(listView, editorView);

  // What is shown: the list or the editor (the full-window view), or the list beside the editor (split; the editor says how to start while no map is
  // open, and the list can be folded away).
  function layout() {
    if (!split) {
      listView.hidden = screen === 'editor';
      editorView.hidden = screen !== 'editor';
      return;
    }
    listView.hidden = listFolded;
    editorView.hidden = false;
    editorView.toggleAttribute('data-empty', !current);
    const label = tr(listFolded ? 'Show the map list' : 'Hide the map list');
    foldButton.setAttribute('aria-label', label);
    foldButton.title = label;
    foldButton.setAttribute('aria-expanded', listFolded ? 'false' : 'true');
    foldButton.firstChild.firstChild.setAttribute('d', PATHS[listFolded ? 'sidebarUnfold' : 'sidebarFold']);
    markCurrent();
  }
  function setFolded(on) {
    listFolded = Boolean(on);
    writeFolded(listFolded);
    layout();
  }
  // Escape in the split editor: the keyboard goes to the open map's row (the map stays open), when the list is shown.
  function focusList() {
    if (listFolded) return;
    const row = rows.querySelector('.mm-row-open[aria-current="true"]') || rows.querySelector('.mm-row-open');
    (row || searchInput).focus();
  }
  layout();

  function act(name) { if (current && current.editor) current.editor.actions[name](); }

  function updateBar() {
    if (!current || !current.editor) return;
    const { editor } = current;
    const tpc = editor.selected();
    const node = tpc && tpc.nodeObj;
    barButtons.delete.disabled = !node || !node.parent;
    const hasChildren = Boolean(node && node.parent && node.children && node.children.length); // the central topic has no fold
    barButtons.fold.disabled = !hasChildren;
    const folded = Boolean(node && node.expanded === false);
    const label = tr(folded ? 'Expand' : 'Collapse');
    barButtons.fold.setAttribute('aria-label', label);
    barButtons.fold.title = label;
    barButtons.fold.firstChild.firstChild.setAttribute('d', PATHS[folded ? 'plusSquare' : 'minusSquare']);
    barButtons.undo.disabled = !editor.canUndo();
    barButtons.redo.disabled = !editor.canRedo();
  }

  function setStatus(state) {
    statusNode.textContent = tr(STATE_TEXT[state] || '');
    statusNode.dataset.state = state;
  }

  // The draft of a map on one service. It is used only when it says it is for that service (a draft of this machine written before sharing says nothing).
  function readDraftOf(sourceKey, id) {
    let draft = null;
    try { draft = JSON.parse(localGet(DRAFT_KEY(sourceKey, id))); } catch { return null; }
    if (!draft || typeof draft !== 'object') return null;
    const owner = draft.source === undefined ? LOCAL_KEY : draft.source;
    return owner === sourceKey && (draft.id === undefined || draft.id === id) ? draft : null;
  }
  // With the sync a map has one id on every engine, so a draft kept while the map was opened from another engine (`<source key>|<id>`, from before
  // the sync) belongs to this engine's copy of it too.
  const draftKeys = (src, id) => (src.local && syncOn() ? [LOCAL_KEY, ...sources.filter(item => !item.local).map(item => item.key)] : [src.key]);
  function readDraft(src, id) {
    for (const key of draftKeys(src, id)) {
      const draft = readDraftOf(key, id);
      if (draft) return draft;
    }
    return null;
  }
  const clearDraft = (sourceKey, id) => {
    localSet(DRAFT_KEY(sourceKey, id), null);
    if (sourceKey === LOCAL_KEY && syncOn()) for (const item of sources) if (!item.local) localSet(DRAFT_KEY(item.key, id), null);
  };
  function writeDraft(sourceKey, id, revision, title, doc) {
    try {
      const text = JSON.stringify({ source: sourceKey, id, revision, title, data: doc, at: Date.now() });
      if (text.length <= DRAFT_MAX) localSet(DRAFT_KEY(sourceKey, id), text);
    } catch { /* storage full or blocked: the retry still has the edits in memory */ }
  }

  // `src`: the service the map is on. Everything the editor sends goes there: saves, the check after a conflict, reload, save as a new copy.
  function showEditor(map, src, { doc: given, restored = false, draftConflict = null } = {}) {
    newerBar.hidden = true;
    let doc = given;
    try {
      if (!doc) doc = map.data ? sanitizeDoc(map.data) : blankDoc(map.title);
    } catch (error) { say(messageFor(error), 'error'); return; }
    screen = 'editor';
    titleField.value = map.title || '';
    setStatus('saved');
    pushLayers();
    canvas.replaceChildren();
    const state = { id: map.id, src: { key: src.key, label: src.label, local: src.local, base: src.base }, title: map.title || '', editor: null, saver: null, leaving: false };
    current = state;
    layout();
    void startEditor(state, map, doc, { restored, draftConflict });
  }

  async function startEditor(state, map, doc, { restored, draftConflict }) {
    let editor;
    try {
      editor = await createEditor(canvas, doc, {
        t: tr,
        onChange: () => markChanged(state),
        onSelection: () => { if (state === current) updateBar(); },
        onSaveNow: () => { if (state.saver) void state.saver.flush(); },
        onOpenInfo: kind => openInfo(state, kind),
        onBack: () => { if (split) focusList(); else void leaveEditor(); },
        owns,
        isBlocked: () => Boolean(dialog),
        notify: text => say(text, 'error'),
      });
    } catch { say(tr('The editor could not start'), 'error'); if (state === current) void returnToList(); return; }
    if (state !== current || disposed) { editor.destroy(); return; }
    state.editor = editor;
    const url = `${state.src.base}/${encodeURIComponent(state.id)}`;
    state.saver = createSaver({
      revision: map.revision,
      send: (body, options) => raw('PUT', url, body, options),
      getSnapshot: () => ({ title: state.title, data: editor.getDoc() }),
      verify: async sent => {
        const { status, json } = await raw('GET', url);
        return status === 200 && json.title === sent.title && JSON.stringify(json.data) === JSON.stringify(sent.data);
      },
      onState: next => { if (state === current) setStatus(next); },
      onConflict: info => showConflict(state, info),
      onRejected: code => say(messageFor(new ApiError(code, 0, {})), 'error'),
      writeDraft: () => writeDraft(state.src.key, state.id, state.saver.revision, state.title, editor.getDoc()),
      clearDraft: () => clearDraft(state.src.key, state.id),
    });
    updateBar();
    if (restored) { state.saver.touch(); say(tr('Unsaved changes from this device were restored'), 'info'); }
    if (draftConflict) showDraftConflict(state, draftConflict);
  }

  function markChanged(state) { if (state.saver) state.saver.touch(); updateBar(); }

  function commitTitle() {
    if (!current) return;
    const value = titleField.value.trim();
    if (!value) { titleField.value = current.title; return; }
    if (value === current.title) return;
    current.title = value;
    if (current.saver) current.saver.touch();
    markCurrent();
  }

  // The copy goes to the service of the original.
  async function saveAsCopy(state, doc, title) {
    try {
      const created = await call('POST', state.src.base, { title: clipTitle(`${title || tr('Untitled map')} ${tr('(copy)')}`), data: doc });
      clearDraft(state.src.key, state.id);
      await returnToList(true);
      showEditor(created, state.src, { doc });
      say(tr('Saved as a new copy'), 'success');
    } catch (error) { say(messageFor(error, state.src), 'error'); }
  }

  function showConflict(state, { gone }) {
    if (state !== current) return;
    newerBar.hidden = true;
    const doc = state.editor ? state.editor.getDoc() : null;
    const buttons = [];
    if (!gone) buttons.push({ label: tr('Reload from the service'), run: () => { void reloadMap(state); } });
    buttons.push({ label: tr('Save as a new copy'), primary: true, run: () => { void saveAsCopy(state, doc, state.title); } });
    const message = tr(gone ? 'This map was deleted elsewhere. Your version can still be saved as a new copy.' : 'This map was changed elsewhere. Your latest changes were not saved.');
    openDialog(tr('Not saved'), el('p', { class: 'mm-dialog-text', text: message }), buttons);
  }

  function showDraftConflict(state, draft) {
    const message = tr('Unsaved changes from this device were found, but the map has changed since then.');
    openDialog(tr('Unsaved changes'), el('p', { class: 'mm-dialog-text', text: message }), [
      { label: tr('Discard my changes'), run: () => clearDraft(state.src.key, state.id) },
      { label: tr('Save mine as a new copy'), primary: true, run: () => { void saveAsCopy(state, draft.data, draft.title); } },
    ]);
  }

  // `from`: the engine a newer version came from, when the map reloads by itself.
  async function reloadMap(state, { from = null } = {}) {
    try {
      const map = await call('GET', `${state.src.base}/${encodeURIComponent(state.id)}`);
      if (state !== current) return;
      clearDraft(state.src.key, state.id);
      await returnToList(true);
      showEditor(map, state.src);
      if (from) say(tr(`Updated to the version saved on ${from}`), 'info');
    } catch (error) { say(messageFor(error, state.src), 'error'); }
  }

  // The open map changed (on another engine, or another page of this one): without unsaved edits here it reloads; with them the bar offers the
  // newer version (keeping on typing ends in the usual conflict, which offers a new copy). Only maps of this engine's own copy are asked about.
  async function checkNewer() {
    const state = current;
    if (!syncOn() || !state || !state.src.local || !state.saver || !state.editor || state.leaving) return;
    if (['conflict', 'rejected'].includes(state.saver.state)) return;
    let head;
    try { head = await call('GET', `${state.src.base}/${encodeURIComponent(state.id)}/head`); } catch (error) {
      if (error instanceof ApiError && error.code === 'MINDMAP_NOT_FOUND' && state === current && !state.saver.dirty) {
        say(tr(CODE_MESSAGES.MINDMAP_NOT_FOUND), 'warning');
        await returnToList();
      }
      return;
    }
    // A save of ours on its way: its answer says whether the head was ours (the same revision) or a conflict (then the conflict dialog says so).
    if (state === current && state.saver.state === 'saving') await state.saver.flush();
    if (state !== current || ['conflict', 'rejected'].includes(state.saver.state) || !(Number(head.revision) > state.saver.revision)) return;
    const from = typeof head.by_name === 'string' && head.by_name ? head.by_name : tr('another device');
    const busy = state.saver.dirty || state.editor.isEditing() || document.activeElement === titleField || Boolean(dialog);
    if (!busy) { await reloadMap(state, { from }); return; }
    newerText.textContent = tr(`A newer version was saved on ${from}.`);
    newerBar.hidden = false;
  }
  let pollTimer = null;
  let polls = 0;
  const listShown = () => (split ? !listFolded && active : screen === 'list');
  function schedulePoll() {
    if (disposed) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (document.visibilityState !== 'hidden' && syncOn()) {
        polls += 1;
        await checkNewer().catch(() => {});
        const local = sources.find(src => src.local);
        if (local && listShown() && polls % LIST_EVERY === 0) await loadSource(local).catch(() => {});
      }
      schedulePoll();
    }, POLL_MS);
  }

  function exportMap() {
    if (!current || !current.editor) return;
    current.editor.finishEdit();
    try { download(buildXmind({ title: current.title, data: current.editor.getDoc() }), safeFileName(current.title)); }
    catch { say(tr('The map could not be exported'), 'error'); }
  }

  function openInfo(state, kind) {
    const tpc = state.editor && state.editor.selected();
    if (!tpc) return;
    const node = tpc.nodeObj;
    if (kind === 'note') promptDialog(tr('Note'), node.note || '', tr('Save'), value => { void state.editor.setInfo(tpc, { note: value.trim() }); }, { multiline: true });
    else if (kind === 'label') promptDialog(tr('Labels (comma separated)'), (node.tags || []).map(tag => (typeof tag === 'string' ? tag : tag.text)).join(', '), tr('Save'), value => { void state.editor.setInfo(tpc, { tags: value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }); });
    else promptDialog(tr('Link (http, https or mailto)'), node.hyperLink || '', tr('Save'), value => { void state.editor.setInfo(tpc, { hyperLink: value.trim() }); });
  }

  function openMore() {
    if (!current || !current.editor) return;
    const { editor } = current;
    const item = (label, run, disabled = false) => el('button', { type: 'button', class: 'mm-menu-item', text: tr(label), disabled, onClick: () => { dialog.close(); run(); } });
    const hasSel = Boolean(editor.selected());
    const list = el('div', { class: 'mm-menu' },
      item('Add parent topic', () => act('addParent'), !hasSel),
      item('Note', () => act('note'), !hasSel),
      item('Labels', () => act('label'), !hasSel),
      item('Link', () => act('link'), !hasSel),
      item('Copy topic', () => act('copyTopics'), !hasSel),
      item('Cut topic', () => act('cutTopics'), !hasSel),
      item('Paste topic', () => act('pasteTopics'), !hasSel),
      item('Zoom in', () => act('zoomIn')),
      item('Zoom out', () => act('zoomOut')),
      matchMedia('(pointer: coarse)').matches ? null : item('Keyboard shortcuts', openShortcuts));
    openDialog(tr('More'), list, []);
  }
  function openShortcuts() {
    const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
    const rowsList = SHORTCUTS.map(([keys, label]) => el('div', { class: 'mm-key-row' }, el('kbd', { text: keys.replace(/Mod/g, apple ? 'Cmd' : 'Ctrl') }), el('span', { text: tr(label) })));
    openDialog(tr('Keyboard shortcuts'), el('div', { class: 'mm-keys' }, ...rowsList), [{ label: tr('Close') }]);
  }

  // Saves what is pending (a short wait only) and shows the list. `silent`: a replacing open follows at once.
  async function returnToList(silent = false) {
    const state = current;
    if (state && state.editor) {
      if (state.saver) state.saver.dispose();
      state.editor.destroy();
    }
    current = null;
    canvas.replaceChildren();
    screen = 'list';
    layout();
    if (silent) return;
    pushLayers();
    void loadList();
    const row = rows.querySelector('button, [tabindex]');
    (row || root.querySelector('#mm-new')).focus();
  }

  // `silent`: another map follows at once in the split view (the list is read again, the keyboard stays where it is).
  async function leaveEditor({ thenClose = false, silent = false } = {}) {
    const state = current;
    if (!state || state.leaving) return;
    state.leaving = true;
    if (state.editor) state.editor.finishEdit();
    commitTitle();
    if (state.saver && state.saver.dirty) {
      await Promise.race([state.saver.flush(), new Promise(resolve => setTimeout(resolve, FLUSH_WAIT_MS))]);
      if (state.saver.dirty && state.saver.state !== 'conflict') say(tr('Not saved yet. Your changes stay on this device and come back when you open this map again.'), 'warning');
    }
    if (thenClose) { await returnToList(true); pushLayers(); if (dialog) dialog.close(); onClose(); return; }
    if (silent) { await returnToList(true); void loadList(); return; }
    await returnToList();
  }

  // Opens a map on its own service, with this device's draft of that map on that service if there is one.
  async function openMap(src, id) {
    try {
      const map = await call('GET', `${src.base}/${encodeURIComponent(id)}`);
      const draft = readDraft(src, id);
      if (!draft) { showEditor(map, src); return; }
      let doc = null;
      try { doc = sanitizeDoc(draft.data); } catch { clearDraft(src.key, id); showEditor(map, src); return; } // a draft that cannot be read must not lock the map
      if (draft.revision === map.revision) { showEditor({ ...map, title: draft.title || map.title }, src, { doc, restored: true }); return; }
      showEditor(map, src, { draftConflict: { ...draft, data: doc } });
    } catch (error) { say(messageFor(error, src), 'error'); if (screen === 'list') void loadSource(src); }
  }

  // ── Page events ──
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') { if (current && current.saver) current.saver.wake(); void checkNewer().catch(() => {}); return; }
    if (current && current.saver) { current.editor && current.editor.finishEdit(); void current.saver.flush({ keepalive: true }); }
  };
  const onPageHide = () => { if (current && current.saver) void current.saver.flush({ keepalive: true }); };
  const onOnline = () => { if (current && current.saver) current.saver.wake(); };
  const onListKey = e => {
    if (split || dialog || screen !== 'list') return; // the tab has no Close: its rail is the way out
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  document.addEventListener('keydown', onListKey, true);

  pushLayers();
  void loadList();
  schedulePoll();
  if (!split) root.querySelector('#mm-new').focus(); // the tab leaves the keyboard on its rail

  return {
    get busy() { return Boolean(current && current.saver && current.saver.dirty); },
    flush: options => (current && current.saver ? current.saver.flush(options) : Promise.resolve()),
    setSources: list => { if (!disposed) setSources(list); },
    // The tab is shown or hidden: hidden, a topic being edited is committed and the map is saved now; the open map and the list stay as they are.
    setActive: on => {
      active = Boolean(on);
      if (active || !current) return;
      if (current.editor) current.editor.finishEdit();
      if (current.saver) void current.saver.flush();
    },
    destroy() {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('keydown', onListKey, true);
      if (dialog) { const { close } = dialog; close(); }
      if (current && current.saver) current.saver.dispose();
      if (current && current.editor) current.editor.destroy();
      current = null;
      root.replaceChildren();
    },
  };
}

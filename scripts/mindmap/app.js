// The mind map view: the list of maps and the editor around one map. Plain DOM (the page's React bundle is not available here and would cost more than this file).
import { PATHS } from '../h5-shell/Icons.jsx';
import { createEditor } from './editor.js';
import { createSaver } from './saver.mjs';
import { blankDoc, sanitizeDoc, DocError } from './doc.mjs';
import { buildXmind, parseXmind, describeLost, XmindError, XMIND_LIMITS } from './xmind.mjs';

const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
// The services whose maps are listed (`sources` of the mount options, in list order): { key, label, base, online }. `base` is where that service's maps are
// (`/api/mindmaps` here, `/api/remote-servers/:id/mindmaps` for a connected service, same shapes). Without the option the view shows this machine only.
const LOCAL_KEY = 'local';
const LOCAL_SOURCE = { key: LOCAL_KEY, label: 'This machine', local: true, base: '/api/mindmaps', online: true };
// A draft is kept per service and map. This machine keeps the key it always had, so a draft written before maps were shared still comes back; a connected
// service's key has its source key in it, and the draft itself says which service it is for (checked again when it is read).
const DRAFT_KEY = (sourceKey, id) => (sourceKey === LOCAL_KEY ? `h5-mindmap-draft:${id}` : `h5-mindmap-draft:${sourceKey}|${id}`);
const OFFLINE_CODES = new Set(['REMOTE_OFFLINE', 'REMOTE_CONNECTION_FAILED']);
const DRAFT_MAX = 1500000; // characters; a larger map is not kept in the browser (a retry still has it in memory)
const KEEPALIVE_MAX = 60000; // bytes the browser allows in a request that outlives the page
const FLUSH_WAIT_MS = 3000;
const CODE_MESSAGES = {
  MINDMAP_NOT_FOUND: 'This map no longer exists',
  INVALID_MINDMAP: 'The service refused this map because its content is not valid',
  MINDMAP_TOO_LARGE: 'This map is too large to save (8 MB limit)',
  MINDMAP_LIMIT: 'No more maps can be created (limit reached)',
};
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

const sourceName = src => (src.local ? tr(src.label || LOCAL_SOURCE.label) : src.label);
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
    out.push({ key: item.key, label: String(item.label || (local ? LOCAL_SOURCE.label : item.key)), local, base: item.base.replace(/\/+$/, ''), online: local || item.online !== false });
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

export function mountApp(root, { onClose, notify = () => {}, onLayers = () => {}, sources: given }) {
  let disposed = false;
  let screen = 'list';
  let current = null; // { id, src, title, editor, saver, ... } the open map and the service it is on
  // The listed services (an empty list: not known yet, the list says "Loading..."), and what each one's list is, by source key:
  // { status: 'loading' | 'ready' | 'error' | 'offline' | 'unsupported', maps, error, seq, base }. A service whose answer is 501 is left out of the list.
  let sources = given === undefined ? [LOCAL_SOURCE] : normalizeSources(given);
  const lists = new Map();
  let loadSeq = 0;
  let createOn = LOCAL_KEY; // "Create on": the service a new or imported map goes to
  let importTarget = null;
  let dialog = null; // the open dialog: { close }
  const say = (text, kind) => notify(text, kind);

  root.replaceChildren();
  root.classList.add('mm');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
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
  const listView = el('section', { class: 'mm-view mm-list' },
    el('header', { class: 'mm-top' },
      iconButton('close', 'Close', () => closeAll(), { id: 'mm-close' }),
      el('h1', { class: 'mm-heading', text: tr('Mind maps') }),
      iconButton('Import', 'Import .xmind', () => { importTarget = createTarget(); fileInput.click(); }, { id: 'mm-import' }),
      iconButton('add', 'New map', () => { void createMap(); }, { id: 'mm-new' })),
    createRow, rows, fileInput);

  const sourceByKey = key => sources.find(src => src.key === key) || null;
  const listOf = src => lists.get(src.key) || { status: 'loading', maps: [] };
  // The services a map can be created on: online, and its list answered (so it is known to have maps at all). This machine always.
  const createTargets = () => sources.filter(src => (src.local ? listOf(src).status !== 'unsupported' : src.online && listOf(src).status === 'ready'));
  function createTarget() {
    const targets = createTargets();
    return targets.find(src => src.key === createOn) || targets.find(src => src.local) || targets[0] || sourceByKey(LOCAL_KEY) || LOCAL_SOURCE;
  }
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
    try {
      const { maps } = await call('GET', src.base);
      next = { status: 'ready', maps: Array.isArray(maps) ? maps : [] };
    } catch (error) {
      next = isUnsupported(error) ? { status: 'unsupported', maps: [] }
        : !src.local && isOffline(error) ? { status: 'offline', maps: [] }
          : { status: 'error', maps: [], error };
    }
    const now = lists.get(src.key);
    if (disposed || !now || now.seq !== seq || !sourceByKey(src.key)) return;
    lists.set(src.key, { ...next, seq, base: src.base });
    renderList();
  }
  function loadList() {
    renderList();
    return Promise.all(sources.map(src => loadSource(src)));
  }

  function mapRow(src, map) {
    const when = parseTime(map.updated_at);
    const meta = [when ? when.toLocaleString() : '', sizeText(map.size)].filter(Boolean).join(' · ');
    const ref = `${src.key}|${map.id}`;
    return el('div', { class: 'mm-row', role: 'listitem', 'data-source': src.key, 'data-id': map.id, 'data-ref': ref },
      el('button', { type: 'button', class: 'mm-row-open', 'data-part': 'open', onClick: () => { void openMap(src, map.id); } },
        el('span', { class: 'mm-row-title', translate: 'no', text: map.title || tr('Untitled map') }),
        el('span', { class: 'mm-row-meta', translate: 'no', text: meta })),
      iconButton('draftKeyboard', 'Rename', () => renameMap(src, map), { 'data-part': 'rename' }),
      iconButton('delete', 'Delete', () => deleteMap(src, map), { 'data-part': 'delete' }));
  }
  const note = (text, extra = '') => el('p', { class: `mm-note${extra}`, text });
  const retry = src => el('button', { type: 'button', class: 'mm-btn mm-retry', text: tr('Try again'), onClick: () => { void loadSource(src); } });

  // One list: this machine first, then each other service in the order of the task list, each under a small header (its name, and "Offline"). This machine
  // alone has no header and looks as it always did.
  function renderList() {
    updateCreateOn();
    // The focus stays on the same button of the same row when a service's answer redraws the list.
    const active = document.activeElement;
    const focusRow = active && rows.contains(active) && active.closest('.mm-row');
    const focus = focusRow ? [focusRow.dataset.ref, active.dataset.part] : null;
    const shown = sources.filter(src => listOf(src).status !== 'unsupported');
    if (!shown.length) { rows.replaceChildren(note(tr(sources.length ? 'No mind maps yet. Create one or import a .xmind file.' : 'Loading...'))); return; }
    const alone = shown.length === 1 && shown[0].local;
    rows.replaceChildren(...shown.map(src => {
      const list = listOf(src);
      const section = el('section', { class: 'mm-section', 'data-source': src.key });
      if (!alone) {
        section.append(el('h2', { class: 'mm-source', 'data-source': src.key },
          el('span', { class: 'mm-source-name', translate: src.local ? false : 'no', text: sourceName(src) }),
          list.status === 'offline' ? el('span', { class: 'mm-source-offline', text: tr('Offline') }) : null));
      }
      const small = alone ? '' : ' mm-note-small';
      if (list.status === 'loading') section.append(note(tr('Loading...'), small));
      else if (list.status === 'error') section.append(note(messageFor(list.error, src), small), retry(src));
      else if (list.status === 'ready' && !list.maps.length) section.append(note(tr(alone ? 'No mind maps yet. Create one or import a .xmind file.' : 'No mind maps'), small));
      else if (list.status === 'ready') section.append(el('div', { class: 'mm-section-rows', role: 'list' }, ...list.maps.map(map => mapRow(src, map))));
      return section; // offline: the header says so, and nothing else is shown
    }));
    if (focus) {
      const row = [...rows.querySelectorAll('.mm-row')].find(node => node.dataset.ref === focus[0]);
      const button = row && row.querySelector(`[data-part="${focus[1]}"]`);
      if (button) button.focus();
    }
  }

  // The services listed changed (connected, removed, hidden or shown again, offline or back). A new one, or one that came back, is read; the rest keep their lists.
  function setSources(list) {
    const next = normalizeSources(list);
    const before = new Map(sources.map(src => [src.key, src]));
    sources = next;
    for (const key of [...lists.keys()]) if (!sourceByKey(key)) lists.delete(key);
    if (!sourceByKey(createOn)) createOn = LOCAL_KEY;
    for (const src of next) {
      const old = before.get(src.key);
      const back = old && !old.online && src.online;
      if (!old || old.base !== src.base || old.online !== src.online || !lists.has(src.key)) void loadSource(src);
      // The open map's service is back: its waiting save goes now.
      if (back && current && current.src.key === src.key && current.saver) current.saver.wake();
    }
    renderList();
  }

  async function createMap() {
    const src = createTarget();
    try {
      const title = tr('Untitled map');
      const created = await call('POST', src.base, { title });
      showEditor(created, src);
    } catch (error) { say(messageFor(error, src), 'error'); }
  }
  function renameMap(src, map) {
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
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { doc, lost } = parseXmind(bytes, { parseXml: text => new DOMParser().parseFromString(text, 'text/xml') });
      const title = clipTitle(file.name.replace(/\.xmind$/i, '')) || tr('Imported map');
      const created = await call('POST', src.base, { title, data: doc });
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
  const editorView = el('section', { class: 'mm-view mm-editor', hidden: true },
    el('header', { class: 'mm-top' },
      iconButton('back', 'Back to the list', () => { void leaveEditor(); }, { id: 'mm-back' }),
      titleField, statusNode, exportButton, moreButton),
    canvas, bar);
  root.append(listView, editorView);

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
  function readDraft(src, id) {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY(src.key, id))); } catch { return null; }
    if (!draft || typeof draft !== 'object') return null;
    const owner = draft.source === undefined ? LOCAL_KEY : draft.source;
    return owner === src.key && (draft.id === undefined || draft.id === id) ? draft : null;
  }
  const clearDraft = (sourceKey, id) => { try { localStorage.removeItem(DRAFT_KEY(sourceKey, id)); } catch { /* blocked storage */ } };
  function writeDraft(sourceKey, id, revision, title, doc) {
    try {
      const text = JSON.stringify({ source: sourceKey, id, revision, title, data: doc, at: Date.now() });
      if (text.length <= DRAFT_MAX) localStorage.setItem(DRAFT_KEY(sourceKey, id), text);
    } catch { /* storage full or blocked: the retry still has the edits in memory */ }
  }

  // `src`: the service the map is on. Everything the editor sends goes there: saves, the check after a conflict, reload, save as a new copy.
  function showEditor(map, src, { doc: given, restored = false, draftConflict = null } = {}) {
    let doc = given;
    try {
      if (!doc) doc = map.data ? sanitizeDoc(map.data) : blankDoc(map.title);
    } catch (error) { say(messageFor(error), 'error'); return; }
    screen = 'editor';
    listView.hidden = true;
    editorView.hidden = false;
    titleField.value = map.title || '';
    setStatus('saved');
    pushLayers();
    canvas.replaceChildren();
    const state = { id: map.id, src: { key: src.key, label: src.label, local: src.local, base: src.base }, title: map.title || '', editor: null, saver: null, leaving: false };
    current = state;
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
        onBack: () => { void leaveEditor(); },
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

  async function reloadMap(state) {
    try {
      const map = await call('GET', `${state.src.base}/${encodeURIComponent(state.id)}`);
      clearDraft(state.src.key, state.id);
      await returnToList(true);
      showEditor(map, state.src);
    } catch (error) { say(messageFor(error, state.src), 'error'); }
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
    editorView.hidden = true;
    listView.hidden = false;
    if (silent) return;
    pushLayers();
    void loadList();
    const row = rows.querySelector('button, [tabindex]');
    (row || root.querySelector('#mm-new')).focus();
  }

  async function leaveEditor({ thenClose = false } = {}) {
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
    if (document.visibilityState !== 'hidden') { if (current && current.saver) current.saver.wake(); return; }
    if (current && current.saver) { current.editor && current.editor.finishEdit(); void current.saver.flush({ keepalive: true }); }
  };
  const onPageHide = () => { if (current && current.saver) void current.saver.flush({ keepalive: true }); };
  const onOnline = () => { if (current && current.saver) current.saver.wake(); };
  const onListKey = e => {
    if (dialog || screen !== 'list') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  document.addEventListener('keydown', onListKey, true);

  pushLayers();
  void loadList();
  root.querySelector('#mm-new').focus();

  return {
    get busy() { return Boolean(current && current.saver && current.saver.dirty); },
    flush: () => (current && current.saver ? current.saver.flush() : Promise.resolve()),
    setSources: list => { if (!disposed) setSources(list); },
    destroy() {
      disposed = true;
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

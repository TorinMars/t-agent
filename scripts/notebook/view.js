// The shell notebook view ("Shell notebook: the page" in docs/design/shell-notebook-page.md): cells of shell commands and text over the terminal
// area of a notebook session. Plain DOM, like the mind map view (the page's React bundle is not available to a lazily loaded IIFE). The notebook lives
// on the engine of the task: this view loads it (GET {base}), follows its stream (GET {base}/events) and sends what the person changes (ops, run,
// interrupt, restart, input, clear). Everything a program printed is drawn with textContent; Markdown goes through the page's safe renderer.
import { PATHS, DRAWN } from '../h5-shell/Icons.jsx';
import { applyEvent, createOpQueue, newCellId, normalCell, normalDoc, SOURCE_BYTES } from './ops.mjs';
import { outputWindow, parseLine, plainStyle, styleAfter, styleCss, WINDOW_LINES } from './sgr.mjs';
import {
  codeNumber, countLabel, fileName, ipynbOf, kernelStatus, metaOf, outputText, programOf, queuedAfter, rowLine, shellTokens,
} from './model.mjs';
import { renderMarkdown } from './markdown.mjs';

const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const MOD = APPLE ? 'Cmd' : 'Ctrl';
const SVG = 'http://www.w3.org/2000/svg';
const STREAM_IDLE_MS = 50000; // the server pings every 20 s: this long without a byte means the stream is gone
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const DD_MS = 800; // the two presses of D D
const CODES = {
  NOTEBOOK_NOT_FOUND: 'This notebook no longer exists',
  TASK_NOT_FOUND: 'This task no longer exists',
  TASK_ARCHIVED: 'The task is archived, so its notebook cannot run or change',
  TASK_HAS_NO_FOLDER: 'The task has no folder for its notebooks',
  CELL_NOT_FOUND: 'That cell no longer exists',
  INVALID_NOTEBOOK_OPS: 'The engine refused a change of the notebook',
  NOTEBOOK_TOO_LARGE: 'The notebook file is larger than 20 MB',
  NOTEBOOK_FILE_UNREADABLE: 'The notebook file cannot be read (it is not a Jupyter notebook)',
  NO_RUNNING_CELL: 'No cell is running',
  INVALID_NOTEBOOK_INPUT: 'The engine refused this input',
  TASK_MOVING: 'The task is being moved; try again when it is done',
  NOTEBOOK_UNSUPPORTED: 'This engine has no shell notebooks yet; it needs an update first',
  NOTEBOOK_FAILED: 'The notebook failed on the engine',
  NETWORK: 'The engine did not answer',
};
const messageOf = error => tr(CODES[error && error.message] || (error && error.message) || 'Unknown error');
const SAVED_TEXT = { saved: 'Saved', saving: 'Saving…', retrying: 'Not saved, retrying…' };

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  return node;
}
// An icon of the page's set (scripts/h5-shell/Icons.jsx): a library path (filled, 1024 grid) or a self-drawn one (stroked, 24 grid).
function icon(name, size = 20) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'nb-icon');
  const path = document.createElementNS(SVG, 'path');
  if (DRAWN[name]) {
    svg.setAttribute('viewBox', '0 0 24 24');
    path.setAttribute('d', DRAWN[name]);
    for (const [key, value] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.5'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) path.setAttribute(key, value);
  } else {
    svg.setAttribute('viewBox', '0 0 1024 1024');
    path.setAttribute('d', PATHS[name] || '');
    path.setAttribute('fill', 'currentColor');
  }
  svg.append(path);
  return svg;
}
// A button with an English label (translated) and, for an icon-only one, the same title.
function button(className, label, { iconName = null, iconOnly = false, size = 20 } = {}) {
  const node = el('button', className, { type: 'button' });
  if (iconName) node.append(icon(iconName, size));
  if (iconOnly) { node.setAttribute('aria-label', tr(label)); node.title = tr(label); }
  else node.append(el('span', 'nb-btn-label', { text: tr(label) }));
  return node;
}
const fineClick = event => !(event.button > 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
const composing = event => Boolean(event.isComposing) || event.keyCode === 229;
const mod = event => event.metaKey !== event.ctrlKey; // Cmd on a Mac, Ctrl elsewhere (either one alone, so an external keyboard works both ways)
const touchInput = () => document.documentElement.getAttribute('data-input') === 'touch';

// Draws one output line as spans (textContent only).
function lineNode(text, start) {
  const node = el('div', 'nb-line');
  const { runs, end } = parseLine(text, start);
  for (const run of runs) {
    const css = styleCss(run.style);
    if (!Object.keys(css).length) { node.append(document.createTextNode(run.text)); continue; }
    const span = document.createElement('span');
    Object.assign(span.style, css);
    span.textContent = run.text;
    node.append(span);
  }
  if (!runs.length) node.append(document.createTextNode('​')); // an empty line keeps its height
  return { node, end };
}

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', '', { href: url, download: name });
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// options: { api, base, notebookId, title, notify, onTitle, embedded, onStatus, onOpenTerminal, onRename, taskTitle }.
export function mountView(host, options) {
  const { api, base } = options;
  const notify = typeof options.notify === 'function' ? options.notify : () => {};
  const onTitle = typeof options.onTitle === 'function' ? options.onTitle : () => {};
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const ownHeader = options.header !== undefined ? Boolean(options.header) : Boolean(options.embedded);
  const client = `page-${newCellId()}${newCellId()}`;
  let doc = null;
  let title = String(options.title || '');
  let selected = null; // the id of the selected cell
  let editing = null; // the id of the cell whose editor has the focus (edit mode), null in command mode
  let active = options.active !== false;
  let destroyed = false;
  let live = false; // the stream is connected
  let lastStatus = '';
  let ddAt = 0;
  const showAll = new Set();
  const stoppedRun = new Set(); // cells whose failure or stop cleared the queue of a run: "Run all stopped here"
  const views = new Map(); // cell id -> its view
  const dirty = new Map(); // cell id -> the first output line to draw again (Infinity: only the meta line)
  let frame = 0;
  let ticker = 0;

  // ── The frame ──
  host.textContent = '';
  const root = el('div', 'nb-root', { 'data-own-header': ownHeader ? 'true' : undefined });
  const head = el('div', 'nb-head');
  const headTitle = el('div', 'nb-head-title', { translate: 'no' });
  const headSub = el('div', 'nb-head-sub', { translate: 'no' });
  const chip = el('span', 'nb-chip', { role: 'status' });
  const menuButton = button('nb-icon-btn nb-menu-btn', 'Notebook menu', { iconName: 'taskMore', iconOnly: true });
  menuButton.setAttribute('aria-haspopup', 'menu');
  if (ownHeader) {
    const mark = el('span', 'nb-head-mark', { 'aria-hidden': 'true' });
    mark.append(icon('notebook', 20));
    const names = el('div', 'nb-head-names');
    names.append(headTitle, headSub);
    head.append(mark, names, el('span', 'nb-flex'), chip, menuButton);
    root.append(head);
  }
  const toolbar = el('div', 'nb-toolbar', { role: 'toolbar', 'aria-label': tr('Notebook') });
  const tools = {
    run: button('nb-tool', 'Run', { iconName: 'play', size: 18 }),
    runAll: button('nb-tool', 'Run all', { iconName: 'runAll', size: 18 }),
    stop: button('nb-tool', 'Stop', { iconName: 'stopSquare', size: 16 }),
    restart: button('nb-tool', 'Restart shell', { iconName: 'reload', size: 16 }),
    code: button('nb-tool', '+ Code'),
    text: button('nb-tool', '+ Text'),
    clear: button('nb-tool nb-tool-muted', 'Clear outputs'),
  };
  toolbar.append(tools.run, tools.runAll, tools.stop, tools.restart, el('span', 'nb-tool-sep', { 'aria-hidden': 'true' }), tools.code, tools.text, el('span', 'nb-flex'), tools.clear);
  const banner = el('div', 'nb-banner', { role: 'alert', hidden: true });
  const scroller = el('div', 'nb-scroll');
  const list = el('div', 'nb-cells', { role: 'list', 'aria-label': tr('Cells') });
  const empty = el('div', 'nb-empty', { hidden: true });
  const hint = el('p', 'nb-hint', { text: tr(`Shift+Enter runs the cell and moves on · ${MOD}+Enter runs it in place · Esc, then A / B adds a cell above / below`) });
  const loading = el('p', 'nb-loading', { text: tr('Loading…') });
  scroller.append(loading, list, empty, hint);
  const actionbar = el('div', 'nb-actionbar', { role: 'toolbar', 'aria-label': tr('Notebook') });
  const bar = {
    run: button('nb-bar-btn', 'Run', { iconName: 'play', size: 18 }),
    runAll: button('nb-bar-btn', 'Run all', { iconName: 'runAll', size: 18 }),
    stop: button('nb-bar-btn', 'Stop', { iconName: 'stopSquare', size: 16 }),
    cell: button('nb-bar-btn', '+ Cell'),
  };
  actionbar.append(bar.run, bar.runAll, bar.stop, bar.cell);
  root.append(toolbar, banner, scroller, actionbar);
  host.append(root);

  // ── The engine ──
  const queue = createOpQueue({
    send: ops => api.post(`${base}/ops`, { client, ops }),
    onState: () => reportStatus(),
    onRefused: error => { notify(messageOf(error), 'error'); void reload(); },
  });
  const findCell = id => (doc ? doc.cells.find(cell => cell.id === id) : null) || null;
  const codeIds = () => (doc ? doc.cells.filter(cell => cell.type === 'code').map(cell => cell.id) : []);

  function showBanner(text, retry = false) {
    banner.textContent = '';
    if (!text) { banner.hidden = true; return; }
    banner.append(el('span', 'nb-banner-text', { text }));
    if (retry) {
      const again = button('nb-text-btn', 'Try again');
      again.addEventListener('click', () => { showBanner(''); void reload(); });
      banner.append(again);
    }
    banner.hidden = false;
  }

  function status() {
    const kernel = doc ? kernelStatus(doc.kernel, doc.cells) : { text: '', tone: 'idle' };
    const saved = SAVED_TEXT[queue.state()] || 'Saved';
    return {
      path: doc ? String(doc.path || '') : '', saved, live, kernel, line: doc ? rowLine(doc.kernel, doc.cells) : '',
      running: Boolean(doc && doc.kernel.state === 'busy'),
    };
  }
  function reportStatus() {
    if (destroyed) return;
    const now = status();
    const text = JSON.stringify(now);
    if (ownHeader) {
      headTitle.textContent = title;
      headSub.textContent = [options.taskTitle || '', now.path, tr(now.live || !doc ? now.saved : 'Reconnecting…')].filter(Boolean).join(' · ');
      chip.textContent = tr(now.kernel.text);
      chip.dataset.tone = now.kernel.tone;
      chip.hidden = !doc;
    }
    const busy = Boolean(doc && doc.kernel.state === 'busy');
    for (const node of [tools.stop, bar.stop]) node.disabled = !busy;
    const code = codeIds().length > 0;
    for (const node of [tools.runAll, bar.runAll]) node.disabled = !code;
    const pick = selected && findCell(selected);
    for (const node of [tools.run, bar.run]) node.disabled = !pick;
    tools.clear.disabled = !(doc && doc.cells.some(cell => cell.type === 'code' && (cell.lines.length || cell.count !== null)));
    if (text === lastStatus) return;
    lastStatus = text;
    onStatus(now);
  }

  // After the stream ended: false when the notebook is gone (404: the view says so and the page is told, `onGone`), true otherwise.
  async function stillThere() {
    try {
      const notebook = await api.get(base);
      if (!destroyed) take({ type: 'snapshot', notebook });
      return true;
    } catch (error) {
      if (destroyed) return false;
      if (error.status !== 404) return true;
      loading.hidden = true;
      showBanner(tr(messageOf(error)));
      if (typeof options.onGone === 'function') options.onGone();
      return false;
    }
  }
  async function reload() {
    try {
      const notebook = await api.get(base);
      if (destroyed) return;
      take({ type: 'snapshot', notebook });
    } catch (error) {
      if (destroyed) return;
      if (!doc) { loading.hidden = true; showBanner(tr(`Could not load the notebook: ${messageOf(error)}`), error.message !== 'NOTEBOOK_NOT_FOUND'); }
      else notify(tr(`Could not load the notebook: ${messageOf(error)}`), 'error');
    }
  }

  // One event of the stream (or the answer of a GET as a snapshot).
  function take(event) {
    const before = doc ? doc.kernel : null;
    if (event.type === 'cell' && doc && event.patch && (event.patch.state === 'failed' || event.patch.state === 'stopped') && before && before.queue.length) stoppedRun.add(event.id);
    if (event.type === 'cell' && event.patch && (event.patch.state === 'running' || event.patch.state === 'queued')) stoppedRun.delete(event.id);
    const result = applyEvent(doc, event, { client, keep: id => queue.pending(id), pending: () => queue.pendingOps() });
    if (result.resync) { void reload(); return; }
    doc = result.doc;
    if (event.type === 'snapshot') {
      loading.hidden = true;
      showBanner('');
      if (result.title !== undefined && result.title !== title) { title = result.title; onTitle(title); }
    }
    if (result.cells === 'all') renderAll();
    else for (const id of result.cells) markDirty(id, result.from && id in result.from ? result.from[id] : Infinity);
    if (result.kernel) {
      // The kernel decides the "Queued · runs after" lines and where the input field is: every code cell's meta is drawn again.
      for (const id of codeIds()) markDirty(id, Infinity);
      maybeFocusInput(before);
    }
    syncTicker();
    reportStatus();
  }

  // ── The stream: fetch, so the status is seen; reconnects with a backoff, and every connection starts with a snapshot ──
  let streamCtrl = null;
  async function stream() {
    let attempt = 0;
    while (!destroyed) {
      const ctrl = new AbortController();
      streamCtrl = ctrl;
      let idle = 0;
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS); };
      let gone = false;
      let ended = false;
      try {
        const res = await fetch(`${base}/events`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal });
        if (res.status === 404) gone = true;
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        live = true;
        attempt = 0;
        reportStatus();
        touch();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let data = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) ended = true;
          if (done || destroyed) break;
          touch();
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n');
          while (cut >= 0) {
            const line = buffer.slice(0, cut).replace(/\r$/, '');
            buffer = buffer.slice(cut + 1);
            if (line === '') {
              if (data.length) {
                let event = null;
                try { event = JSON.parse(data.join('\n')); } catch { event = null; }
                data = [];
                if (event) take(event);
              }
            } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            cut = buffer.indexOf('\n');
          }
        }
      } catch { /* a dropped connection: tried again below */ }
      clearTimeout(idle);
      if (destroyed) return;
      live = false;
      reportStatus();
      // An ended stream may mean the row was deleted (the engine ends it normally then): the GET says whether the notebook is still there.
      if (gone || ended) {
        const still = await stillThere();
        if (destroyed) return;
        if (!still) return;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
      attempt += 1;
    }
  }

  // ── Drawing ──
  function markDirty(id, from) {
    const before = dirty.has(id) ? dirty.get(id) : Infinity;
    dirty.set(id, Math.min(before, from));
    if (!frame) frame = requestAnimationFrame(drawDirty);
  }
  function drawDirty() {
    frame = 0;
    if (destroyed || !doc) return;
    const work = [...dirty];
    dirty.clear();
    for (const [id, from] of work) {
      const cell = findCell(id);
      const view = views.get(id);
      if (!cell || !view) continue;
      if (view.type !== cell.type) { renderAll(); return; }
      view.update(cell, from);
    }
  }

  // Every cell, in the notebook's order. A cell's elements are kept (a focused editor keeps its focus and caret); only what moved is moved.
  function renderAll() {
    if (!doc) return;
    const ids = new Set(doc.cells.map(cell => cell.id));
    for (const [id, view] of views) {
      const cell = findCell(id);
      if (!ids.has(id) || (cell && cell.type !== view.type)) { view.item.remove(); views.delete(id); }
    }
    let ref = list.firstChild;
    for (const cell of doc.cells) {
      let view = views.get(cell.id);
      if (!view) { view = makeCell(cell); views.set(cell.id, view); }
      if (view.item === ref) ref = ref.nextSibling;
      else list.insertBefore(view.item, ref);
      view.update(cell, 0);
    }
    if (selected && !ids.has(selected)) selected = null;
    if (!selected && doc.cells.length) selected = doc.cells[0].id;
    for (const [id, view] of views) view.select(id === selected);
    empty.hidden = doc.cells.length > 0;
    if (!empty.hidden && !empty.firstChild) {
      empty.append(el('p', 'nb-empty-text', { text: tr('This notebook has no cells yet') }));
      const add = button('nb-text-btn', '+ Code');
      add.addEventListener('click', () => insertCell(doc.cells.length, 'code', { edit: true }));
      empty.append(add);
    }
    reportStatus();
  }

  function select(id, { focus = false, scroll = true } = {}) {
    if (!id || !views.has(id)) return;
    selected = id;
    for (const [other, view] of views) view.select(other === id);
    const view = views.get(id);
    if (focus) view.cell.focus({ preventScroll: true });
    if (scroll) view.item.scrollIntoView({ block: 'nearest' });
    reportStatus();
  }
  const neighbour = (id, step) => {
    const at = doc.cells.findIndex(cell => cell.id === id);
    const next = doc.cells[at + step];
    return next ? next.id : null;
  };

  // ── One cell ──
  function makeCell(first) {
    const type = first.type;
    const item = el('div', 'nb-item', { role: 'listitem' });
    const cell = el('div', 'nb-cell', { tabindex: '0', 'data-type': type, 'data-id': first.id });
    const view = { type, item, cell, id: first.id, out: null, styleAt: { index: 0, style: plainStyle() } };
    item.append(cell);
    cell.addEventListener('pointerdown', event => { if (!event.target.closest('button, input, textarea, a')) select(first.id, { scroll: false }); });
    cell.addEventListener('focusin', () => { if (selected !== first.id) select(first.id, { scroll: false }); });
    cell.addEventListener('keydown', event => commandKey(event, first.id));

    if (type === 'code') {
      view.count = el('span', 'nb-count', { 'aria-hidden': 'true' });
      view.run = button('nb-run', 'Run this cell', { iconName: 'play', iconOnly: true, size: 18 });
      view.run.addEventListener('click', () => {
        const now = findCell(first.id);
        if (now && now.state === 'running') void interrupt();
        else void runCells([first.id]);
      });
      // The editor: a textarea over its own highlighted copy (same font, padding and wrapping), so the colours never change what is typed.
      view.code = el('div', 'nb-code');
      view.hl = el('pre', 'nb-hl', { 'aria-hidden': 'true' });
      view.input = el('textarea', 'nb-input', {
        rows: '1', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'soft', translate: 'no',
        'aria-label': tr('Shell commands'), placeholder: tr('Shell commands'),
      });
      view.code.append(view.hl, view.input);
      view.output = el('div', 'nb-output');
      view.note = el('div', 'nb-out-note', { hidden: true });
      view.lines = el('div', 'nb-lines', { translate: 'no' });
      view.full = el('div', 'nb-full', { hidden: true });
      view.output.append(view.note, view.lines, view.full);
      view.meta = el('div', 'nb-meta', { 'aria-live': 'polite' });
      view.stdin = null;
      cell.append(view.run, view.count, view.code, view.output, view.meta);
      bindEditor(view, first.id);
    } else {
      view.md = el('div', 'nb-md markdown-body');
      view.md.addEventListener('dblclick', () => editText(first.id));
      view.input = el('textarea', 'nb-input nb-md-input', { rows: '1', spellcheck: 'true', hidden: true, 'aria-label': tr('Text (Markdown)'), placeholder: tr('Text (Markdown)') });
      cell.append(view.md, view.input);
      bindEditor(view, first.id);
      const grow = () => { view.input.style.height = 'auto'; view.input.style.height = `${view.input.scrollHeight}px`; };
      view.input.addEventListener('input', grow);
      view.input.addEventListener('focus', grow);
      view.input.addEventListener('blur', () => { if (!destroyed) { view.input.hidden = true; view.md.hidden = false; view.drawText(findCell(first.id)); } });
    }
    const insert = el('div', 'nb-insert');
    const addCode = button('nb-insert-btn', '+ Code');
    const addText = button('nb-insert-btn', '+ Text');
    addCode.tabIndex = -1;
    addText.tabIndex = -1;
    const at = () => doc.cells.findIndex(entry => entry.id === first.id) + 1;
    addCode.addEventListener('click', () => insertCell(at(), 'code', { edit: true }));
    addText.addEventListener('click', () => insertCell(at(), 'markdown', { edit: true }));
    insert.append(el('span', 'nb-insert-line'), addCode, addText, el('span', 'nb-insert-line'));
    item.append(insert);

    view.select = on => { cell.toggleAttribute('data-selected', on); };
    let shownSource = null;
    view.drawText = now => {
      if (!now || type !== 'markdown') return;
      if (!view.input.hidden) return;
      view.md.textContent = '';
      if (!now.source.trim()) { view.md.append(el('p', 'nb-md-empty', { text: tr('Double-click to write text') })); return; }
      renderMarkdown(view.md, now.source);
    };
    view.update = (now, from) => {
      if (now.source !== shownSource) {
        shownSource = now.source;
        if (view.input.value !== now.source) setValue(view.input, now.source);
        if (type === 'code') drawHighlight(view);
        else view.drawText(now);
      }
      if (type !== 'code') return;
      view.count.textContent = countLabel(now);
      cell.dataset.state = now.state;
      const running = now.state === 'running';
      view.run.replaceChildren(icon(running ? 'stopSquare' : 'play', running ? 16 : 18));
      const label = tr(running ? 'Stop this cell' : 'Run this cell');
      view.run.setAttribute('aria-label', label);
      view.run.title = label;
      view.run.disabled = now.state === 'queued';
      const all = showAll.has(now.id);
      const same = view.drawn && view.drawn.lines === now.lines && view.drawn.count === now.lines.length && view.drawn.all === all;
      if (from !== Infinity && !(from === 0 && same)) {
        drawLines(view, now, from);
        view.drawn = { lines: now.lines, count: now.lines.length, all };
      }
      drawExtras(view, now);
      drawMeta(view, now);
      drawStdin(view, now);
    };
    return view;
  }

  function setValue(input, value) {
    if (document.activeElement === input) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = value;
      input.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
    } else input.value = value;
  }
  function drawHighlight(view) {
    view.hl.textContent = '';
    for (const run of shellTokens(view.input.value)) {
      if (!run.kind) { view.hl.append(document.createTextNode(run.text)); continue; }
      view.hl.append(el('span', `nb-tok-${run.kind}`, { text: run.text }));
    }
    view.hl.append(document.createTextNode('\n')); // a last empty line still has its height
  }

  function bindEditor(view, id) {
    const input = view.input;
    input.addEventListener('focus', () => { editing = id; if (selected !== id) select(id, { scroll: false }); view.cell.setAttribute('data-editing', ''); });
    input.addEventListener('blur', () => { if (editing === id) editing = null; view.cell.removeAttribute('data-editing'); });
    input.addEventListener('input', () => {
      const cell = findCell(id);
      if (!cell) return;
      const value = input.value;
      if (new Blob([value]).size > SOURCE_BYTES) { notify(tr('A cell can hold at most 1 MB of text; this change is not saved'), 'error'); return; }
      cell.source = value;
      queue.edit(id, value);
      if (view.type === 'code') drawHighlight(view);
      reportStatus();
    });
    input.addEventListener('keydown', event => editKey(event, id, view));
  }

  // The output of a code cell: the last WINDOW_LINES lines (all of them on Show all), drawn from the first changed line on.
  function drawLines(view, cell, from) {
    const lines = cell.lines;
    const win = outputWindow(lines.length, cell.dropped, showAll.has(cell.id));
    const out = view.out;
    if (view.styleAt.index > from) view.styleAt = { index: 0, style: plainStyle() };
    let start = from;
    if (!out || out.start !== win.start || from < out.start) {
      view.lines.textContent = '';
      start = win.start;
    } else {
      const keep = Math.max(0, Math.min(from, out.end) - out.start);
      while (view.lines.childNodes.length > keep) view.lines.lastChild.remove();
      start = out.start + keep;
    }
    let style = view.styleAt.index <= start ? styleAfter(lines, view.styleAt.index, start, view.styleAt.style) : styleAfter(lines, 0, start);
    const fragment = document.createDocumentFragment();
    for (let i = start; i < win.end; i++) {
      if (i === win.end - 1) view.styleAt = { index: i, style };
      const drawn = lineNode(lines[i], style);
      fragment.append(drawn.node);
      style = drawn.end;
    }
    view.lines.append(fragment);
    view.out = { start: win.start, end: win.end };
  }
  // What goes with the lines: "Last 200 of N lines · Show all · Download", the full-screen message, whether there is an output at all.
  function drawExtras(view, cell) {
    const lines = cell.lines;
    const win = outputWindow(lines.length, cell.dropped, showAll.has(cell.id));
    view.output.toggleAttribute('data-has', lines.length > 0 || cell.state === 'fullscreen');
    // "Last 200 of N lines · Show all · Download", or the lines the engine did not keep. The buttons stay the same elements while lines arrive,
    // so a press is never lost to a redraw.
    const all = showAll.has(cell.id);
    if (!view.noteParts) {
      const count = el('span', 'nb-out-count');
      const toggle = button('nb-text-btn nb-show-all', 'Show all');
      toggle.addEventListener('click', () => {
        if (showAll.has(cell.id)) showAll.delete(cell.id); else showAll.add(cell.id);
        view.out = null;
        view.drawn = null;
        markDirty(cell.id, 0);
      });
      const download = button('nb-text-btn nb-download', 'Download');
      download.addEventListener('click', () => {
        const now = findCell(cell.id);
        if (now) saveFile(`${fileName(doc.path, 'notebook').replace(/\.ipynb$/i, '')}-cell-${codeNumber(doc.cells, cell.id)}.txt`, outputText(now.lines), 'text/plain;charset=utf-8');
      });
      view.note.append(count, toggle, download);
      view.noteParts = { count, toggle, download };
    }
    const { count, toggle } = view.noteParts;
    view.note.hidden = !(win.windowed || (all && win.dropped));
    if (!view.note.hidden) {
      const total = win.total.toLocaleString('en-US');
      count.textContent = all ? (win.dropped ? tr(`The first ${win.dropped.toLocaleString('en-US')} lines were not kept`) : '') : tr(`Last ${WINDOW_LINES} of ${total} lines`);
      count.hidden = !count.textContent;
      toggle.hidden = !win.windowed;
      toggle.firstChild.textContent = tr(all ? 'Show less' : 'Show all');
    }
    // A program that draws a full screen (vim, htop, less): it was stopped; a terminal of the task can run it.
    const fullKey = cell.state === 'fullscreen' ? `${cell.program || ''}\n${cell.source}` : null;
    if (view.fullKey === fullKey) return;
    view.fullKey = fullKey;
    view.full.textContent = '';
    view.full.hidden = cell.state !== 'fullscreen';
    if (cell.state === 'fullscreen') {
      // The engine names the program (`program`, "The program" when it could not tell); an older answer without it: the first word of the cell.
      const named = cell.program && cell.program !== 'The program' ? cell.program : cell.program ? '' : programOf(cell.source);
      const program = named;
      view.full.append(el('span', 'nb-full-text', { text: program ? tr(`${program} draws a full screen, which a cell cannot show. It was stopped.`) : tr('This program draws a full screen, which a cell cannot show. It was stopped.') }));
      if (typeof options.onOpenTerminal === 'function') {
        const open = button('nb-text-btn', 'Open in a terminal');
        open.addEventListener('click', () => options.onOpenTerminal({ program }));
        view.full.append(open);
      }
    }
  }

  function drawMeta(view, cell) {
    const meta = metaOf(cell, {
      now: Date.now(), after: queuedAfter(doc.kernel, doc.cells, cell.id), stoppedRun: stoppedRun.has(cell.id), kernelStopped: doc.kernel.state === 'stopped',
    });
    view.meta.textContent = '';
    view.meta.dataset.tone = meta ? meta.tone : '';
    view.output.dataset.tone = meta ? meta.tone : '';
    if (!meta || !meta.parts.length) { view.meta.hidden = true; return; }
    view.meta.hidden = false;
    if (meta.check) view.meta.append(icon('check', 14));
    if (meta.tone === 'running') view.meta.append(el('span', 'nb-spinner', { 'aria-hidden': 'true' }));
    view.meta.append(el('span', 'nb-meta-text', { text: meta.parts.map(part => tr(part)).join(' \u00b7 ') }));
  }

  // Under the running cell: a field whose text goes to the command (a `read`, a y/N prompt, a password). Enter sends.
  function drawStdin(view, cell) {
    const show = cell.state === 'running' && doc.kernel.running === cell.id;
    if (!show) { if (view.stdin) { view.stdin.box.remove(); view.stdin = null; } return; }
    if (!view.stdin) {
      const box = el('form', 'nb-stdin', { autocomplete: 'off' });
      const label = el('label', 'nb-stdin-label');
      const caption = el('span', 'nb-stdin-caption');
      const field = el('input', 'nb-stdin-input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': tr('Input for the running cell'), enterkeyhint: 'send' });
      label.append(caption, field);
      const send = el('button', 'nb-send', { type: 'submit', text: tr('Send') });
      const row = el('div', 'nb-stdin-row');
      row.append(label, send);
      const hide = el('label', 'nb-stdin-hide');
      const hideBox = el('input', '', { type: 'checkbox' });
      hideBox.addEventListener('change', () => { field.type = hideBox.checked ? 'password' : 'text'; field.focus(); });
      hide.append(hideBox, el('span', '', { text: tr('Hide what I type') }));
      const foot = el('div', 'nb-stdin-foot');
      foot.append(el('span', 'nb-stdin-hint', { text: tr('Enter sends') }), hide);
      box.append(row, foot);
      box.addEventListener('submit', event => {
        event.preventDefault();
        const text = field.value;
        field.value = '';
        void sendInput(text);
      });
      field.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); view.cell.focus(); } });
      view.cell.append(box);
      view.stdin = { box, caption, field };
    }
    view.stdin.caption.textContent = tr(doc.kernel.waiting_input ? 'The command asks for input' : 'Input for the running command');
    view.stdin.box.toggleAttribute('data-waiting', Boolean(doc.kernel.waiting_input));
  }
  function maybeFocusInput(before) {
    if (!doc || !active || !doc.kernel.waiting_input || (before && before.waiting_input) || touchInput()) return;
    const view = views.get(doc.kernel.running);
    const focused = document.activeElement;
    if (!view || !view.stdin || (focused && focused !== document.body && !root.contains(focused))) return;
    if (focused && /^(TEXTAREA|INPUT)$/.test(focused.tagName) && focused !== view.stdin.field) return;
    view.stdin.field.focus({ preventScroll: true });
  }

  // The "Running · 0:38" lines tick once a second while a cell runs (and the view is shown).
  function syncTicker() {
    const want = active && !destroyed && Boolean(doc && doc.cells.some(cell => cell.state === 'running'));
    if (want && !ticker) ticker = setInterval(() => { for (const cell of doc.cells) if (cell.state === 'running') markDirty(cell.id, Infinity); }, 1000);
    if (!want && ticker) { clearInterval(ticker); ticker = 0; }
  }

  // ── Changes of the cells ──
  function insertCell(index, type, { edit = false } = {}) {
    if (!doc) return null;
    const id = newCellId();
    const at = Math.max(0, Math.min(doc.cells.length, index));
    doc.cells = doc.cells.slice();
    doc.cells.splice(at, 0, normalCell({ id, type, source: '' }));
    queue.push({ op: 'insert', index: at, cell: { id, type, source: '' } });
    renderAll();
    select(id, { focus: !edit });
    if (edit) focusEditor(id);
    return id;
  }
  function deleteCell(id) {
    const at = doc.cells.findIndex(cell => cell.id === id);
    if (at < 0) return;
    const next = doc.cells[at + 1] || doc.cells[at - 1] || null;
    doc.cells = doc.cells.filter(cell => cell.id !== id);
    queue.push({ op: 'delete', id });
    renderAll();
    if (next) select(next.id, { focus: true });
  }
  function setType(id, type) {
    const cell = findCell(id);
    if (!cell || cell.type === type) return;
    const at = doc.cells.indexOf(cell);
    doc.cells = doc.cells.slice();
    doc.cells[at] = normalCell({ id, type, source: cell.source });
    queue.push({ op: 'type', id, type });
    renderAll();
    select(id, { focus: true });
  }
  function focusEditor(id) {
    const view = views.get(id);
    if (!view) return;
    if (view.type === 'markdown') { editText(id); return; }
    view.input.focus({ preventScroll: true });
    const end = view.input.value.length;
    view.input.setSelectionRange(end, end);
    view.item.scrollIntoView({ block: 'nearest' });
  }
  function editText(id) {
    const view = views.get(id);
    if (!view || view.type !== 'markdown') return;
    view.md.hidden = true;
    view.input.hidden = false;
    view.input.focus({ preventScroll: true });
  }
  // A text cell is drawn again when its editor is left.
  function finishText(id) {
    const view = views.get(id);
    if (!view || view.type !== 'markdown' || view.input.hidden) return;
    view.cell.focus({ preventScroll: true }); // the blur draws it
  }

  // ── Running ──
  async function runCells(ids) {
    if (!doc) return false;
    const targets = ids.filter(id => { const cell = findCell(id); return cell && cell.type === 'code'; });
    if (!targets.length) return false;
    try { await queue.flush(); } catch (error) { notify(tr(`Could not save the notebook: ${messageOf(error)}`), 'error'); return false; }
    if (destroyed) return false;
    // Shown as queued at once; the engine's events say what really happens.
    const before = new Map();
    for (const id of targets) {
      const cell = findCell(id);
      if (cell.state === 'running' || cell.state === 'queued') continue;
      before.set(id, cell.state);
      take({ type: 'cell', id, patch: { state: 'queued' } });
    }
    try {
      const answer = await api.post(`${base}/run`, { ids: targets, client });
      if (answer && answer.kernel && !destroyed) take({ type: 'kernel', kernel: answer.kernel });
      return true;
    } catch (error) {
      for (const [id, state] of before) { const cell = findCell(id); if (cell && cell.state === 'queued') take({ type: 'cell', id, patch: { state } }); }
      notify(tr(`Could not run the cell: ${messageOf(error)}`), 'error');
      return false;
    }
  }
  // Shift+Enter: run the cell and go to the next one (a new code cell at the end). A text cell is only drawn.
  function runAndNext(id) {
    const cell = findCell(id);
    if (!cell) return;
    if (cell.type === 'code') void runCells([id]);
    const next = neighbour(id, 1);
    if (next) {
      const nextView = views.get(next);
      if (editing && nextView && nextView.type === 'code') focusEditor(next);
      else select(next, { focus: true });
    } else insertCell(doc.cells.length, 'code', { edit: true });
  }
  function runInPlace(id) {
    const cell = findCell(id);
    if (!cell) return;
    if (cell.type === 'code') void runCells([id]);
    else finishText(id);
  }
  const runAll = () => runCells(codeIds());
  async function post(path, body, failure) {
    try {
      const answer = await api.post(`${base}/${path}`, body || {});
      if (answer && answer.kernel && !destroyed) take({ type: 'kernel', kernel: answer.kernel });
      return answer;
    } catch (error) {
      notify(tr(`${failure}: ${messageOf(error)}`), 'error');
      return null;
    }
  }
  const interrupt = () => post('interrupt', {}, 'Could not stop the cell');
  const stopShell = () => post('stop', {}, 'Could not stop the shell');
  const clearOutputs = () => { stoppedRun.clear(); return post('clear', {}, 'Could not clear the outputs'); };
  const sendInput = text => post('input', { text }, 'Could not send the input');

  // ── The restart confirmation (MD2 dialog: h6 title, body, Cancel then Restart in the error colour: the shell's state is lost) ──
  let dialog = null;
  function closeDialog() {
    if (!dialog) return;
    const { layer, opener } = dialog;
    dialog = null;
    layer.remove();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  }
  function confirmRestart() {
    if (!doc || dialog) return;
    const running = doc.kernel.running ? codeNumber(doc.cells, doc.kernel.running) : 0;
    const layer = el('div', 'nb-dialog-layer');
    const box = el('div', 'nb-dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'nb-restart-title', 'aria-describedby': 'nb-restart-text', id: 'nb-restart' });
    box.append(el('h2', 'nb-dialog-title', { id: 'nb-restart-title', text: tr('Restart the shell?') }));
    box.append(el('p', 'nb-dialog-text', {
      id: 'nb-restart-text',
      text: tr(running
        ? `Variables, the working directory and the running cell ${running} are lost. The outputs stay in the notebook.`
        : 'Variables and the working directory are lost. The outputs stay in the notebook.'),
    }));
    const actions = el('div', 'nb-dialog-actions');
    const cancel = button('nb-text-btn', 'Cancel');
    const confirm = button('nb-text-btn nb-danger', 'Restart');
    actions.append(cancel, confirm);
    box.append(actions);
    layer.append(box);
    layer.addEventListener('pointerdown', event => { if (event.target === layer) closeDialog(); });
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); }
      if (event.key === 'Tab') { // the focus stays in the dialog
        const first = cancel;
        const last = confirm;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    cancel.addEventListener('click', closeDialog);
    confirm.addEventListener('click', () => { closeDialog(); void post('restart', {}, 'Could not restart the shell'); });
    dialog = { layer, opener: document.activeElement };
    document.body.append(layer);
    confirm.focus();
  }

  // ── The menu of the view's own header (a column of the multi-column view has no page header) ──
  let menu = null;
  const MENU = [['rename', 'Rename'], ['download', 'Download .ipynb'], ['clear', 'Clear outputs'], ['stop-shell', 'Stop shell'], ['restart', 'Restart shell']];
  function closeMenu() { if (menu) { menu.remove(); menu = null; menuButton.setAttribute('aria-expanded', 'false'); } }
  function openMenu() {
    if (menu) { closeMenu(); return; }
    menu = el('div', 'nb-menu', { role: 'menu', 'aria-label': tr('Notebook menu') });
    for (const [name, label] of MENU) {
      if (name === 'rename' && typeof options.onRename !== 'function') continue;
      const item = el('button', 'nb-menu-item', { type: 'button', role: 'menuitem', text: tr(label), 'data-action': name });
      item.addEventListener('click', () => { closeMenu(); action(name); });
      menu.append(item);
    }
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('.nb-menu-item')];
      const at = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); menuButton.focus(); }
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length].focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    });
    head.append(menu);
    menuButton.setAttribute('aria-expanded', 'true');
    menu.firstChild.focus();
  }
  menuButton.addEventListener('click', openMenu);
  const outside = event => { if (menu && !menu.contains(event.target) && event.target !== menuButton && !menuButton.contains(event.target)) closeMenu(); };
  document.addEventListener('pointerdown', outside, true);

  function downloadIpynb() {
    if (!doc) return;
    saveFile(fileName(doc.path), ipynbOf(doc), 'application/x-ipynb+json');
  }
  // The actions of the header's menu (the page header's, or the view's own).
  function action(name) {
    if (name === 'rename' && typeof options.onRename === 'function') options.onRename();
    else if (name === 'download') downloadIpynb();
    else if (name === 'clear') void clearOutputs();
    else if (name === 'stop-shell') void stopShell();
    else if (name === 'restart') confirmRestart();
    else if (name === 'run-all') void runAll();
  }

  // ── Keys ──
  // Edit mode (the focus in a cell's editor).
  function editKey(event, id, view) {
    if (composing(event)) return;
    if (event.key === 'Enter' && mod(event) && event.shiftKey) { event.preventDefault(); void runAll(); return; }
    if (event.key === 'Enter' && event.shiftKey && !mod(event) && !event.altKey) { event.preventDefault(); runAndNext(id); return; }
    if (event.key === 'Enter' && mod(event)) { event.preventDefault(); runInPlace(id); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); view.cell.focus({ preventScroll: true }); return; }
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && view.type === 'code') {
      event.preventDefault();
      const input = view.input;
      if (!document.execCommand || !document.execCommand('insertText', false, '  ')) {
        input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input'));
      }
    }
  }
  // Command mode (the focus on a cell itself).
  function commandKey(event, id) {
    if (event.target !== views.get(id)?.cell || composing(event) || event.altKey) return;
    const plain = !event.ctrlKey && !event.metaKey;
    const key = event.key;
    if (key === 'Enter' && mod(event) && event.shiftKey) { event.preventDefault(); void runAll(); return; }
    if (key === 'Enter' && event.shiftKey && plain) { event.preventDefault(); runAndNext(id); return; }
    if (key === 'Enter' && mod(event)) { event.preventDefault(); runInPlace(id); return; }
    if (!plain || event.shiftKey) return;
    if (key === 'Enter') { event.preventDefault(); focusEditor(id); return; }
    if (key === 'ArrowDown' || key === 'j') { event.preventDefault(); const next = neighbour(id, 1); if (next) select(next, { focus: true }); return; }
    if (key === 'ArrowUp' || key === 'k') { event.preventDefault(); const prev = neighbour(id, -1); if (prev) select(prev, { focus: true }); return; }
    const at = doc.cells.findIndex(cell => cell.id === id);
    if (key === 'a') { event.preventDefault(); insertCell(at, 'code'); return; }
    if (key === 'b') { event.preventDefault(); insertCell(at + 1, 'code'); return; }
    if (key === 'm') { event.preventDefault(); setType(id, 'markdown'); return; }
    if (key === 'y') { event.preventDefault(); setType(id, 'code'); return; }
    if (key === 'd') {
      event.preventDefault();
      const now = Date.now();
      if (now - ddAt < DD_MS) { ddAt = 0; deleteCell(id); } else ddAt = now;
    }
  }

  // ── The toolbar and the phone's action bar ──
  const selectedOrFirst = () => selected || (doc && doc.cells[0] ? doc.cells[0].id : null);
  const runSelected = () => { const id = selectedOrFirst(); if (id) runAndNext(id); };
  const addBelow = type => { const at = selected ? doc.cells.findIndex(cell => cell.id === selected) + 1 : doc.cells.length; insertCell(at, type, { edit: true }); };
  for (const node of [tools.run, bar.run]) node.addEventListener('click', runSelected);
  for (const node of [tools.runAll, bar.runAll]) node.addEventListener('click', () => void runAll());
  for (const node of [tools.stop, bar.stop]) node.addEventListener('click', () => void interrupt());
  tools.restart.addEventListener('click', confirmRestart);
  tools.code.addEventListener('click', () => addBelow('code'));
  bar.cell.addEventListener('click', () => addBelow('code'));
  tools.text.addEventListener('click', () => addBelow('markdown'));
  tools.clear.addEventListener('click', () => void clearOutputs());
  // A click (not a drag) inside a cell's area, outside its editor, keeps the selection; the buttons do not take the editor's focus away on a phone.
  root.addEventListener('mousedown', event => { if (event.target.closest('.nb-tool, .nb-bar-btn') && fineClick(event)) event.preventDefault(); });

  reportStatus();
  void reload();
  void stream();

  return {
    flush() { return queue.flush().catch(() => {}); },
    setActive(on) { active = Boolean(on); syncTicker(); },
    action,
    destroy() {
      destroyed = true;
      closeDialog();
      closeMenu();
      document.removeEventListener('pointerdown', outside, true);
      if (streamCtrl) streamCtrl.abort();
      if (frame) cancelAnimationFrame(frame);
      if (ticker) clearInterval(ticker);
      void queue.flush().catch(() => {}).finally(() => queue.dispose()); // what was typed is still sent
      host.textContent = '';
    },
  };
}

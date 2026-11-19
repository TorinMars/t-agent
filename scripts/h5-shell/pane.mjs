// Pane mode: the page shown as one column of the multi-column view (an <iframe> of `/h5?pane=<id>` in the top page; see "Pane mode" in docs/design/page-shell-and-columns.md).
// Only with a valid id AND inside a frame: a top-level `?pane=` or an invalid id is the normal page. In a pane:
// - what this view shows is remembered under `pane:<id>:<key>` (`H5Pane.key`), so panes never overwrite each other or the normal view; device-wide
//   preferences keep their shared keys;
// - the top page keeps the long-lived streams, the reminders and the updater (h5.js, attention-feed.mjs, Update.jsx, agent-chat.js read `H5Pane`);
// - the back-layer history is off (entry.jsx): the history of a frame is joined with the top page's, and a pane's `history.go` would move another column;
// - the pane tells its parent `ready`, `focus` and `title` ({ type: 't-agent-pane', paneId, event }, posted to this origin only), and forgets its keys
//   on `{ type: 't-agent-pane', event: 'forget' }` from its parent window on this origin (answered with `forgotten`); `{ ..., event: 'open', sourceKey,
//   taskId, terminalId?, conversationId? }` from there opens that task and terminal as a tap in the list would, or that agent chat as a `?openChat=` link
//   would (h5.js `ui.actions.paneOpen`); `peek` asks for the last lines of the terminal (answered with `peek` { lines }); the actions of the column's header, which the top page draws in place of this page's own header
//   (hidden in a pane, Header.jsx): `tasks` ({ toggle? }) shows (or hides) the task sheet, `width` ({ mode?, cols? }) sets or switches the terminal
//   width, `rename` and `restart` act on the session shown as its row's menu does (restart asks first), `reload` loads this page again (h5.js
//   `ui.actions.paneTasks`, `paneRename`, `paneRestart`, `setTerminalWidth`, `toggleTerminalWidth`, `refresh`); each one counts as the person using
//   this column (`engaged`), since it is;
// - a pane shows no mind map: its Mind maps button posts `mindmaps` and the top page shows its Mind maps tab (h5.js `openMindmaps`);
// - a sideways wheel or trackpad swipe (or Shift+wheel) that nothing inside the pane can scroll is posted as `scroll-x` ({ dx }) and the top page
//   scrolls its strip: the gesture never reaches xterm, and a vertical one is never touched; Ctrl+Alt+Left / Right (Ctrl+Option on a Mac) is posted as
//   `step` ({ step: -1 | 1 }), with Shift as `move` (this column one place left / right), and Cmd/Ctrl+Shift+Enter as `maximize` (this column
//   maximized, or the columns restored); none of them reaches the terminal (see "Multi-column view" in docs/design/page-shell-and-columns.md);
// - whether this column is the focused one of the view (`state.paneFocused`, which the compact bottom area of a column follows, Terminal.jsx
//   CompactBottom): `{ type: 't-agent-pane', event: 'focused', on }` from the parent whenever its focused column changes and after `ready`; a press in
//   the pane, its window getting the focus after the person used it, or the focus coming into its draft box (`ui.actions.paneUse`) makes it true at
//   once, before the parent's answer to `focus` comes back;
// - the page takes no focus by itself until the person pressed a pointer or a key in this pane (`H5Pane.engaged()`): otherwise every column would pull the
//   focus into its frame as it loads.
import { localForget } from './local-keys.mjs';
import { PEEK_LINES, columnMove, columnStep, deviceOfRow, maximizeKey, readAction, readDevice, sidewaysDelta } from './columns.mjs';

export const PANE_ID = /^[a-z0-9]{1,16}$/;
export const PANE_MESSAGE = 't-agent-pane';
export const paneKeyPrefix = id => `pane:${id}:`;

// The pane id of this window, or null for the normal page.
export function detectPane(win = window) {
  let id = null;
  try { id = new URLSearchParams(win.location.search).get('pane'); } catch { return null; }
  if (!id || !PANE_ID.test(id)) return null;
  let framed = true;
  try { framed = win.top !== win; } catch { /* a frame whose top cannot be compared is a frame */ }
  return framed ? id : null;
}

// Removes every key of one pane from both storages (the local one is shared by the frames of one origin, the session one by the frames of one tab),
// through the registry of browser storage (local-keys.mjs); `stores`: Storage-like objects instead (a test). The top page can call it too.
export function forgetPaneKeys(id, stores = null) {
  const prefix = paneKeyPrefix(id);
  if (!stores) return localForget(prefix);
  let removed = 0;
  for (const storage of stores) {
    try {
      if (!storage) continue;
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) { const key = storage.key(i); if (key && key.startsWith(prefix)) keys.push(key); }
      for (const key of keys) { storage.removeItem(key); removed += 1; }
    } catch { /* storage blocked: nothing was kept */ }
  }
  return removed;
}

// Parts of the page that keep every wheel event for themselves (an editor with its own scrollbars, an open dialog).
const OWN_WHEEL = '.monaco-editor, .MuiModal-root, dialog[open]';
// Whether something under `target` can still scroll sideways by `dx` (it takes the gesture, not the strip): the wide terminal (moved with a transform
// on .xterm-screen inside `.h5-xterm.h5-wide`, public/js/terminal-gestures.js) until its edge, and any element that scrolls sideways itself.
export function scrollsInside(target, dx, win = window) {
  for (let el = target && target.nodeType === 1 ? target : target && target.parentElement; el && el !== win.document.documentElement; el = el.parentElement) {
    if (el.matches(OWN_WHEEL)) return true;
    if (el.classList.contains('h5-xterm') && el.classList.contains('h5-wide')) {
      const screen = el.querySelector('.xterm-screen');
      if (!screen) return false;
      const max = screen.offsetWidth - el.clientWidth;
      const offset = el.getBoundingClientRect().left - screen.getBoundingClientRect().left;
      return dx > 0 ? offset < max - 0.5 : offset > 0.5;
    }
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = win.getComputedStyle(el).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return true;
    }
  }
  return false;
}

// Starts pane mode for the pane `id` (from detectPane): sets `window.H5Pane` for the other scripts of the page and talks to the parent.
export function startPane(ui, id, { win = window, doc = document } = {}) {
  const prefix = paneKeyPrefix(id);
  const post = (event, extra = {}) => {
    try { win.parent.postMessage({ type: PANE_MESSAGE, paneId: id, event, ...extra }, win.location.origin); } catch { /* the parent is gone */ }
  };
  let engaged = false;
  const pane = Object.freeze({
    id, prefix, key: name => `${prefix}${name}`, post, engaged: () => engaged,
    forget: () => forgetPaneKeys(id),
  });
  win.H5Pane = pane;

  // The task and session shown and, when the task list tags the shown task, its device (else the name of a remote service as a device without a
  // colour), whether the task sheet is shown and the terminal width: the column's header in the top page draws them (this page's own header is hidden),
  // once the page has started and on every change.
  let started = false;
  let title = null;
  const sendTitle = () => {
    const state = ui.get();
    const row = state.taskList && Array.isArray(state.taskList.tasks) ? state.taskList.tasks.find(item => item.selected && item.device) : null;
    const device = deviceOfRow(row) || (state.sourceLabel ? readDevice({ name: state.sourceLabel, local: false }) : null);
    const sheet = state.wide ? !state.sidebarCollapsed : Boolean(state.tasksOpen);
    const width = state.terminalWidth ? { mode: state.terminalWidth.mode === 'wide' ? 'wide' : 'fit', cols: state.terminalWidth.cols || 0 } : null;
    const target = state.shownTarget || null;
    const agent = state.terminalAgent || '';
    const next = { title: state.taskName || '', session: state.sessionName || '', ...(device ? { device } : {}), ...(target ? { target } : {}), ...(agent ? { agent } : {}), ...(sheet ? { sheet } : {}), ...(width ? { width } : {}) };
    const key = JSON.stringify(next);
    if (title === key) return;
    title = key;
    post('title', next);
  };
  ui.subscribe(() => { if (started) sendTitle(); });
  // `ready` after every script of the page has run (they are all deferred, so they ran before DOMContentLoaded).
  const ready = () => { if (started) return; started = true; post('ready'); sendTitle(); };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ready, { once: true });
  else win.setTimeout(ready, 0);

  // The person uses this column: a press anywhere in it, or the focus coming into its window (a click and its focus count once).
  let focusAt = -Infinity;
  const focused = () => {
    const was = ui.get().paneFocused;
    if (!was) ui.set({ paneFocused: true }); // shown as the focused column at once; the parent confirms it with `focused`
    const now = Date.now();
    if (was && now - focusAt < 200) return; // a column that was not the focused one always tells the parent
    focusAt = now;
    post('focus');
  };
  const engage = () => { if (engaged) return; engaged = true; ui.set({ paneEngaged: true }); };
  // The focus came into the draft box (a click, or Tab from the top page): the person uses this column.
  ui.actions.paneUse = () => { engage(); focused(); };
  doc.addEventListener('pointerdown', engage, true);
  doc.addEventListener('keydown', engage, true);
  doc.addEventListener('pointerdown', focused, true);
  win.addEventListener('focus', () => { if (engaged) focused(); }); // a focus the page took by itself is not the person's

  // Sideways scrolling of the strip from inside the pane, before anything in the page (capture on the window): passive: false, since a gesture the
  // strip takes is cancelled here so xterm never scrolls or reports it.
  win.addEventListener('wheel', event => {
    const dx = sidewaysDelta(event, win.innerWidth);
    if (!dx || scrollsInside(event.target, dx, win)) return;
    event.preventDefault();
    event.stopPropagation();
    post('scroll-x', { dx });
  }, { capture: true, passive: false });
  // Ctrl+Alt+Left / Right: the previous / next column; with Shift: this column one place left / right. Never a key for the terminal (xterm would send
  // it as a word move or a selection).
  win.addEventListener('keydown', event => {
    // Cmd/Ctrl+Shift+Enter: maximize this column or restore the columns (the top page decides); it never reaches the terminal.
    if (maximizeKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) post('maximize');
      return;
    }
    const step = event.isComposing ? 0 : columnStep(event);
    const move = event.isComposing ? 0 : columnMove(event);
    if (!step && !move) return;
    event.preventDefault();
    event.stopPropagation();
    if (step) post('step', { step }); // a held key moves on, one column per repeat
    else post('move', { step: move });
  }, true);

  win.addEventListener('message', event => {
    if (event.source !== win.parent || event.origin !== win.location.origin) return;
    const data = event.data;
    if (!data || data.type !== PANE_MESSAGE) return;
    if (data.paneId !== undefined && data.paneId !== id) return;
    if (data.event === 'forget') { pane.forget(); post('forgotten'); return; }
    // The top page's focused column changed (or this pane just said `ready`): the compact bottom area shows its tools only in the focused column.
    if (data.event === 'focused') { const on = data.on === true; if (ui.get().paneFocused !== on) ui.set({ paneFocused: on }); return; }
    // An action of the column's header (the top page draws it in place of this page's header).
    const action = readAction(data);
    if (action) { engage(); runAction(ui, action); return; }
    // The peek card of this column's tile asks for the last lines of the terminal shown.
    if (data.event === 'peek') { post('peek', { lines: ui.actions.paneTail ? ui.actions.paneTail(PEEK_LINES) : [] }); return; }
    if (data.event === 'open' && typeof data.sourceKey === 'string' && data.taskId != null && ui.actions.paneOpen) {
      const text = value => (typeof value === 'string' && value ? value : null);
      const request = { sourceKey: data.sourceKey, taskId: data.taskId, terminalId: text(data.terminalId), conversationId: text(data.conversationId) };
      void Promise.resolve(ui.actions.paneOpen(request)).catch(() => { /* ignored quietly */ });
    }
  });
  return pane;
}

// What an action of the column's header does in this page: the same actions as this page's own header and the session row's menu.
function runAction(ui, action) {
  const run = (name, ...args) => { const fn = ui.actions[name]; if (typeof fn === 'function') void Promise.resolve(fn(...args)).catch(() => { /* told by the action itself */ }); };
  if (action.event === 'tasks') run('paneTasks', { toggle: action.toggle });
  else if (action.event === 'width') {
    if (action.mode) run('setTerminalWidth', { mode: action.mode, ...(action.cols ? { cols: action.cols } : {}) });
    else run('toggleTerminalWidth');
  } else if (action.event === 'rename') run('paneRename');
  else if (action.event === 'restart') run('paneRestart');
  else if (action.event === 'reload') run('refresh');
}

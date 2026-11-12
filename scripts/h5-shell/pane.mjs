// Pane mode: the page shown as one column of the multi-column view (an <iframe> of `/h5?pane=<id>` in the top page; see "Pane mode" in DESIGN.md).
// Only with a valid id AND inside a frame: a top-level `?pane=` or an invalid id is the normal page. In a pane:
// - what this view shows is remembered under `pane:<id>:<key>` (`H5Pane.key`), so panes never overwrite each other or the normal view; device-wide
//   preferences keep their shared keys;
// - the top page keeps the long-lived streams, the reminders and the updater (h5.js, attention-feed.mjs, Update.jsx, agent-chat.js read `H5Pane`);
// - the back-layer history is off (entry.jsx): the history of a frame is joined with the top page's, and a pane's `history.go` would move another column;
// - the pane tells its parent `ready`, `focus` and `title` ({ type: 't-agent-pane', paneId, event }, posted to this origin only), and forgets its keys
//   on `{ type: 't-agent-pane', event: 'forget' }` from its parent window on this origin (answered with `forgotten`); `{ ..., event: 'open', sourceKey,
//   taskId, terminalId?, conversationId? }` from there opens that task and terminal as a tap in the list would, or that agent chat as a `?openChat=` link
//   would (h5.js `ui.actions.paneOpen`);
// - a sideways wheel or trackpad swipe (or Shift+wheel) that nothing inside the pane can scroll is posted as `scroll-x` ({ dx }) and the top page
//   scrolls its strip: the gesture never reaches xterm, and a vertical one is never touched; Ctrl+Alt+Left / Right (Ctrl+Option on a Mac) is posted as
//   `step` ({ step: -1 | 1 }) and never reaches the terminal (see "Multi-column view" in DESIGN.md);
// - the page takes no focus by itself until the person pressed a pointer or a key in this pane (`H5Pane.engaged()`): otherwise every column would pull the
//   focus into its frame as it loads.
import { columnStep, sidewaysDelta } from './columns.mjs';

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

// Removes every key of one pane from both storages (localStorage is shared by the frames of one origin, sessionStorage by the frames of one tab).
// The top page can call it too, with the storages of its own window.
export function forgetPaneKeys(id, stores = [globalThis.localStorage, globalThis.sessionStorage]) {
  const prefix = paneKeyPrefix(id);
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

// Parts of the page that keep every wheel event for themselves (an editor with its own scrollbars, the mind map's canvas, an open dialog).
const OWN_WHEEL = '.monaco-editor, #h5-mindmap, .MuiModal-root, dialog[open]';
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
    forget: () => forgetPaneKeys(id, [win.localStorage, win.sessionStorage]),
  });
  win.H5Pane = pane;

  // The task and session shown (the header's two lines), once the page has started and on every change.
  let started = false;
  let title = null;
  const sendTitle = () => {
    const state = ui.get();
    const next = { title: state.taskName || '', session: state.sessionName || '' };
    if (title && title.title === next.title && title.session === next.session) return;
    title = next;
    post('title', next);
  };
  ui.subscribe(() => { if (started) sendTitle(); });
  // `ready` after every script of the page has run (they are all deferred, so they ran before DOMContentLoaded).
  const ready = () => { if (started) return; started = true; post('ready'); sendTitle(); };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ready, { once: true });
  else win.setTimeout(ready, 0);

  // The person uses this column: a press anywhere in it, or the focus coming into its window (a click and its focus count once).
  let focusAt = -Infinity;
  const focused = () => { const now = Date.now(); if (now - focusAt < 200) return; focusAt = now; post('focus'); };
  const engage = () => { if (engaged) return; engaged = true; ui.set({ paneEngaged: true }); };
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
  // Ctrl+Alt+Left / Right: the previous / next column, never a key for the terminal (xterm would send it as a word move).
  win.addEventListener('keydown', event => {
    const step = event.isComposing ? 0 : columnStep(event);
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    post('step', { step }); // a held key moves on, one column per repeat
  }, true);

  win.addEventListener('message', event => {
    if (event.source !== win.parent || event.origin !== win.location.origin) return;
    const data = event.data;
    if (!data || data.type !== PANE_MESSAGE) return;
    if (data.paneId !== undefined && data.paneId !== id) return;
    if (data.event === 'forget') { pane.forget(); post('forgotten'); return; }
    if (data.event === 'open' && typeof data.sourceKey === 'string' && data.taskId != null && ui.actions.paneOpen) {
      const text = value => (typeof value === 'string' && value ? value : null);
      const request = { sourceKey: data.sourceKey, taskId: data.taskId, terminalId: text(data.terminalId), conversationId: text(data.conversationId) };
      void Promise.resolve(ui.actions.paneOpen(request)).catch(() => { /* ignored quietly */ });
    }
  });
  return pane;
}

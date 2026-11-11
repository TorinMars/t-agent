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
// - the page takes no focus by itself until the person pressed a pointer or a key in this pane (`H5Pane.engaged()`): otherwise every column would pull the
//   focus into its frame as it loads.
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

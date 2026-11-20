// Usage data ("Usage data" in docs/design/usage-data.md): which buttons of the page are pressed, where and when, recorded on the server that serves the
// page so the layout can be improved from real use. This is the small part of the first screen: one capture-phase listener for clicks (and for
// Enter / Space) on the document, so every button is covered, also the ones of lazy chunks; a column of the multi-column view is a page of its own
// with its own listener. No handler of a button is changed. The listener only keeps the target and the store's state; the recorder
// (usage-recorder.mjs, a chunk of its own) is loaded only when the server says that recording is on, and turns the presses into events.

// The fixed labels of the task and session menus (public/js/h5.js showMenu) that may be recorded as the detail of a menu row. Anything else (a device
// or service name in "New session") is not.
export const MENU_ACTIONS = new Set(['Copy text', 'Rename', 'Reopen', 'Open', 'Restart in the working directory', 'Delete', 'Delete session', 'Remove from Recent', 'New session', 'Edit working directory',
  'Archive', 'Visible to', 'Move up', 'Move down', 'Move to top', 'Move to bottom', 'Terminal', 'Claude', 'Codex', 'Claude Code']);
// The data-track-detail of a menu row (TaskDrawer.jsx, TermMenu.jsx): its label when it is one of the fixed ones above, else nothing.
export const menuDetail = item => (item && item.kind !== 'raw' && MENU_ACTIONS.has(item.label) ? item.label : undefined);

// Starts listening. `ui` is the store: `usageRecording` is null until the switch was read (GET /api/ui-events/settings), then true or false; the
// Settings group sets it when the switch changes, and the recorder sets it to false when the server says so. While it is false nothing is kept.
export function startUsageTracking(ui, { doc = document, win = window, url = '/api/ui-events', load = () => import('./usage-recorder.mjs') } = {}) {
  let recorder = null;
  let loading = false;
  let early = []; // presses before the recorder is there (at most 50)
  let checked = 0;
  const hear = (type, target) => {
    if (ui.get().usageRecording === false) return;
    const item = { type, target, s: ui.get(), at: Date.now() };
    if (recorder) recorder.press(item);
    else if (early.length < 50) early.push(item);
  };
  doc.addEventListener('click', event => hear('click', event.target), true);
  doc.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !event.isComposing) hear('keydown', event.target); }, true);
  const start = () => {
    if (recorder) { recorder.resume(); return; }
    if (loading) return;
    loading = true;
    load().then(module => {
      recorder = module.startRecorder(ui, { doc, win, url });
      if (ui.get().usageRecording === false) recorder.stop();
      for (const item of early) recorder.press(item);
      early = [];
    }).catch(() => { loading = false; }); // a chunk that cannot load: nothing is recorded on this page
  };
  let was = ui.get().usageRecording;
  ui.subscribe(() => {
    const now = ui.get().usageRecording;
    if (now === was) return;
    was = now;
    if (now) start();
    else if (now === false) { early = []; if (recorder) recorder.stop(); }
  });
  // The switch: read once the first screen is up, and again when the page comes back after ten minutes or more (it may have changed elsewhere).
  const read = () => {
    checked = Date.now();
    win.fetch(`${url}/settings`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(res => (res.ok ? res.json() : null))
      .then(answer => ui.set({ usageRecording: Boolean(answer && answer.enabled) }), () => ui.set({ usageRecording: false }));
  };
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && Date.now() - checked > 600000) read(); });
  setTimeout(read, 1500);
}

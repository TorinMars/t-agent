// The state the phone page shows. public/js/h5.js (the controller: terminals, sockets, the chat, the tasks) writes it with `set` and registers what a tap
// does in `actions`; the React / MUI shell (App.jsx) reads it and calls the actions. Neither side touches the other's DOM.
// `set(patch)` changes the state (and tells the listeners) only when some key of the patch gets another value (Object.is): a patch that repeats what
// is there draws nothing. The values are never changed in place, so a slice that did not change keeps its identity and the components that read it
// (use-store.mjs `useStore`) are not drawn again. `share(before, next)` gives `next` with every part that equals the same part of `before` (deeply)
// replaced by that part, and `before` itself when nothing differs: h5.js builds its lists afresh each time and passes them through it.
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (!next || typeof next !== 'object') return;
      let changed = false;
      for (const key of Object.keys(next)) if (!Object.is(state[key], next[key])) { changed = true; break; }
      if (!changed) return;
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    share: sharePlain,
    actions: {},
  };
}

// Same keys and Object.is values (one level).
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
}

// Structural sharing of plain data (objects and arrays of the state, see `share` above). Anything else (a function, a DOM node, a class instance) is
// compared by identity only.
const plain = value => {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return Array.isArray(value) || proto === Object.prototype || proto === null;
};
export function sharePlain(before, next) {
  if (Object.is(before, next) || !plain(before) || !plain(next) || Array.isArray(before) !== Array.isArray(next)) return next;
  if (Array.isArray(next)) {
    let same = before.length === next.length;
    const out = next.map((value, index) => {
      const kept = index < before.length ? sharePlain(before[index], value) : value;
      if (kept !== before[index]) same = false;
      return kept;
    });
    return same ? before : out;
  }
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(before).length;
  const out = {};
  for (const key of keys) {
    const had = Object.prototype.hasOwnProperty.call(before, key);
    out[key] = had ? sharePlain(before[key], next[key]) : next[key];
    if (!had || out[key] !== before[key]) same = false;
  }
  return same ? before : out;
}

export const initialState = () => ({
  wide: false,
  pane: null, // the pane id when this page is one column of the multi-column view (pane.mjs), else null
  paneEngaged: false, // a pane only: the person pressed a pointer or a key in it; until then nothing in it takes the focus by itself
  paneFocused: false, // a pane only: this column is the focused one of the multi-column view (pane.mjs), so its compact bottom area shows its tools
  draftNote: null, // where the draft box's text came from: { kind: 'took' | 'offer', text } (h5.js "Drafts that follow their session"), drawn above the box
  draftPeek: '', // a pane only: the draft box's text on one line (h5.js `autosize`), shown with a "Draft" tag while the column is not the focused one
  // How the page is used, decided by media queries (never by the user agent; entry.jsx keeps it current):
  // 'pointer' = a mouse or trackpad and no touch screen (a computer), 'touch' = everything else (phones, tablets, an iPad with a trackpad).
  input: 'touch',
  hasKeyboard: false, // a hardware keyboard was used (a trusted keydown while no on-screen keyboard was open): the computer shortcuts work in touch mode too
  sidebarCollapsed: false, // wide layout only: the permanent task sidebar is folded away (remembered in localStorage)
  tasksOpen: false,
  settingsOpen: false,
  settingsTarget: null, // { id, seq }: the group (and part) of the settings sheet to open, from ui.actions.openSettings(id) (settings-target.mjs)
  learnOpen: false, // the Learn page (screen-learn.jsx) is open: ui.actions.openLearn() / closeLearn()
  taskName: '', // empty: "Choose a task"
  sessionName: '',
  terminalAgent: null, // 'claude' / 'codex' / 'opencode' / 'notebook' when the current session is that agent's, null for a plain shell: picks the presets of the saved commands list
  // The shell notebook shown instead of a terminal (h5.js `showNotebook`): { path, saved, live, kernel: { text, tone } | null }; null when none is. The
  // session header shows it (Header.jsx) and its menu acts on it (`ui.actions.notebookAction`).
  notebook: null,
  sources: [{ key: 'local', label: 'This machine' }], // every connected service: { key, label, name, offline, hidden, listed, instanceId, capabilities }
  sourceKey: 'local', // the service of the shown task
  sourceLabel: '', // its name when it is not this machine (shown in the header)
  hiddenDevices: { supported: false, keys: [] }, // the devices left out of the list ("Show in task list"); `supported`: false on an older server
  // The task list: a note (loading, an error, no tasks), or `tasks`, every listed device's tasks in one flat list in the shared order (h5.js "Task order"), each with
  // its `source`, `device` tag (null with one device), `movable` and the sessions listed under it; `sortable`: the order can be changed. `groups` is this machine's
  // tasks by group, for T-Attention's way back.
  taskList: { note: null, groups: [], tasks: [], sortable: false },
  archived: { supported: false, open: false, status: 'idle', busy: null, count: null, rows: [] }, // the Archived section at the end of the task list (h5.js `showArchived`)
  creatingTask: false,
  newTaskOpen: false, // the New task dialog (TaskDrawer.jsx `NewTaskDialog`) is open
  // { title, items: [{ label, kind }], naming, task, name, rename, renameValue } while the terminal / chat actions or the New session dialog are open.
  // naming: the New session dialog of the "+" of task `task` (its ref), with { sub, taskTitle, service, busy, error } (TaskDrawer.jsx `NewSessionDialog`);
  // rename: { kind, id, task } of the row whose name field is shown in its place;
  // anchor: the "⋯" button of a session row, whose actions are a popup under it (TermMenu.jsx); null for the sheet from the bottom.
  menu: null,
  empty: 'Choose a task to open its phone terminal', // what the terminal area says when there is no terminal; null when one is shown
  emptyCreate: false, // the terminal area also offers a button that opens the task's New session dialog (the task has no terminal)
  mods: {},
  osk: false, // the terminal on-screen keyboard (Osk.jsx) is shown; the "Terminal keyboard" button of row 2 toggles it (h5.js `toggleKeyboard`)
  learnKeys: false, // the Learn page's own keyboard (Learn.jsx `useLearnKeys`) is shown: the phone's bottom navigation steps aside
  softKeyboard: false, // touch input: the system keyboard is up (h5.js `fitViewport`: the visual viewport is much shorter); the phone's bottom navigation hides
  mindmapOpen: false, // the full-window mind map view is shown (h5.js `openMindmaps` / `closeMindmaps`): the Mind maps destination of the phone's bottom navigation
  translating: false,
  copyText: null, // the text of the copy view while it is open
  copyStale: false, // new output arrived while the user holds a selection in the copy view
  // The copy bar (public/js/terminal-clipboard.js): { id, kind, text, preview, chars }. kind 'ask': a program's copy without a recent gesture
  // of the user, written only on Copy; kind 'tap': the browser refused a copy (page selection or program), Copy on the bar writes it.
  clipboard: null,
  // The link bar (h5.js, docs/design/open-links.md): a web link a program in the shown terminal opened, waiting for Open.
  // { id, url, program ('Claude' | 'Codex' | 'OpenCode' | ''), more (links queued behind it), ttl, holding, round }
  openLink: null,
  upload: null, // { status, progress, count } while images or files go up (progress of the current file: 0-100, or null when it is not known; count: { index, total } of the batch)
  retainUrl: null, // the link (several joined with spaces) of what was uploaded after its terminal went away
  pasteSheet: null, // { open } the Paste sheet (Dialogs.jsx `PasteDialog`) after the browser refused to read the clipboard (h5.js `paste`)
  design: null, // { open, status: loading | ready | missing | folder | no-dir | no-task | error, dir, path, link, line, content, message } of the file sheet (DESIGN.md, or a terminal file link)
  files: null, // { open, key, base, dir } of the read-only file tree (FileTree.jsx): base = `<tasksBase>/<task>/files` (null without a task); a new key (task, working directory or Engine) draws a new tree
  taskDialog: null, // { kind: 'delete' | 'workdir' | 'archive' | 'visibility', id, title, workDir, error, busy, status, devices } a confirmation or form of a task; `status` (loading | ready | error) and `devices` belong to 'visibility'
  notice: null, // { id, message, type, action } the last floating notice (action: { label, run } or null)
  // T-Attention (attention-feed.mjs, Attention.jsx): { open, status: idle | loading | ready | error, items, needs (the waiting_user count, the badge
  // on #h5-attention), live (the stream is connected), focus (a task id whose edit view opens) }; with several engines also engines, failed, noMove
  // (see "Every engine in one list" in docs/design/page-attention.md)
  attention: { open: false, status: 'idle', items: null, needs: 0, live: false, focus: null },
  // Plan usage (plan-usage-feed.mjs, PlanUsage.jsx): the last reading of each engine { status: 'ok' | 'offline' | 'missing', answer, fetchedAt }, by
  // its key; `open`: the details are shown; `refreshing`: a Refresh is on its way.
  planUsage: { readings: {}, open: false, refreshing: false },
  updateDot: false, // the header updater (Update.jsx `UpdateButton`) sees an update or a needed restart: the red dot of the multi-column bar's Update button
  columns: null, // the multi-column view of a wide screen (Columns.jsx `startColumns`): null on a page that never offers it (a pane, a framed page)
  activeCount: 0, // running or pending terminal sessions of the listed services (the count of a column's "Next running or pending session"; h5.js `showActiveCount`)
  // The session switcher (Switcher.jsx, docs/design/session-switcher.md): `recent` the sessions shown on this device, most recent first, without the ones
  // that are gone ({ sourceKey, taskId, terminalId, title, agent }; h5.js "Recent sessions"); `switcher` null while closed, else { seq, press (counts the
  // presses of the switch button while open), previews: { '<sourceKey>|<taskId>|<terminalId>': { lines, live } } }.
  recent: [],
  switcher: null,
  // Usage data (usage-track.mjs): whether this server records button use; null until the page has read the switch (Settings > Usage data sets it).
  usageRecording: null,
});

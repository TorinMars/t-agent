// The state the phone page shows. public/js/h5.js (the controller: terminals, sockets, the chat, the tasks) writes it with `set` and registers what a tap
// does in `actions`; the React / MUI shell (App.jsx) reads it and calls the actions. Neither side touches the other's DOM.
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    actions: {},
  };
}

export const initialState = () => ({
  wide: false,
  // How the page is used, decided by media queries (never by the user agent; entry.jsx keeps it current):
  // 'pointer' = a mouse or trackpad and no touch screen (a computer), 'touch' = everything else (phones, tablets, an iPad with a trackpad).
  input: 'touch',
  hasKeyboard: false, // a hardware keyboard was used (a trusted keydown while no on-screen keyboard was open): the computer shortcuts work in touch mode too
  sidebarCollapsed: false, // wide layout only: the permanent task sidebar is folded away (remembered in localStorage)
  tasksOpen: false,
  settingsOpen: false,
  taskName: '', // empty: "Choose a task"
  sessionName: '',
  terminalAgent: null, // 'claude' / 'codex' when the current terminal is that agent's, null for a plain shell: picks the presets of the saved commands list
  sources: [{ key: 'local', label: 'This machine' }], // every connected service: { key, label, offline, hidden }
  sourceKey: 'local', // the service of the shown task
  sourceLabel: '', // its name when it is not this machine (shown in the header)
  hiddenDevices: { supported: false, keys: [] }, // the devices left out of the list ("Show in task list"); `supported`: false on an older server
  // The task list: a note (loading, an error, no tasks), or one section per service, each with groups of tasks; a task can carry the sessions listed under it.
  // `groups` is this machine's section, for T-Attention's way back.
  taskList: { note: null, groups: [], sections: [] },
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
  translating: false,
  copyText: null, // the text of the copy view while it is open
  copyStale: false, // new output arrived while the user holds a selection in the copy view
  // The copy bar (public/js/terminal-clipboard.js): { id, kind, text, preview, chars }. kind 'ask': a program's copy without a recent gesture
  // of the user, written only on Copy; kind 'tap': the browser refused a copy (page selection or program), Copy on the bar writes it.
  clipboard: null,
  upload: null, // { status, progress } while an image goes up (progress: 0-100, or null when it is not known)
  retainUrl: null, // the link of an image that was uploaded after its terminal went away
  pasteSheet: null, // { open } the Paste sheet (Dialogs.jsx `PasteDialog`) after the browser refused to read the clipboard (h5.js `paste`)
  design: null, // { open, status: loading | ready | missing | folder | no-dir | no-task | error, dir, path, link, line, content, message } of the file sheet (DESIGN.md, or a terminal file link)
  files: null, // { open, key, base, dir } of the read-only file tree (FileTree.jsx): base = `<tasksBase>/<task>/files` (null without a task); a new key (task, working directory or Engine) draws a new tree
  taskDialog: null, // { kind: 'delete' | 'workdir' | 'archive' | 'visibility', id, title, workDir, error, busy, status, devices } a confirmation or form of a task; `status` (loading | ready | error) and `devices` belong to 'visibility'
  notice: null, // { id, message, type } the last floating notice
  // T-Attention (attention-feed.mjs, Attention.jsx): { open, status: idle | loading | ready | error, items, needs (the waiting_user count, the badge
  // on #h5-attention), live (the stream is connected), focus (a task id whose edit view opens) }
  attention: { open: false, status: 'idle', items: null, needs: 0, live: false, focus: null },
  activeCount: 0, // running or pending terminal sessions of the listed services (the badge on #h5-cycle; h5.js `showActiveCount`)
});

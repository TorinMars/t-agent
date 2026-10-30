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
  tasksOpen: false,
  settingsOpen: false,
  taskName: '', // empty: "Choose a task"
  sessionName: '',
  sources: [{ key: 'local', label: 'This machine' }],
  sourceKey: 'local',
  // The task list: a note (loading, an error, no tasks), or groups of tasks; a task can carry the sessions listed under it.
  taskList: { note: null, groups: [] },
  creatingTask: false,
  menu: null, // { title, items: [{ label, kind }], renaming, renameValue } while the terminal / chat / session sheet is open
  empty: 'Choose a task to open its phone terminal', // what the terminal area says when there is no terminal; null when one is shown
  keysHidden: false,
  mods: {},
  translating: false,
  copyText: null, // the text of the copy view while it is open
  upload: null, // { status, progress } while an image goes up (progress: 0-100, or null when it is not known)
  retainUrl: null, // the link of an image that was uploaded after its terminal went away
  notice: null, // { id, message, type } the last floating notice
});

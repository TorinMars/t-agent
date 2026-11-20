// The one door of the page to browser storage (localStorage and sessionStorage), and the registry of every key it may keep there. Rule: "One
// experience on every device and engine" in AGENTS.md: what describes the person and their work is kept on the server (the shared page state,
// public/js/page-state.js), and a browser keeps only what is tied to it. So every key is declared here with its reason, in one of four categories:
//   hardware               tied to this device's hardware (the microphone, the screen's size, its gesture)
//   browser                tied to this browser or tab (which session this window opens, a tab's client id, unsaved edits, a reload guard)
//   device-setting         what the person explicitly sets for this device only (scope "device" in Settings)
//   cache-of-shared-state  this browser's copy of a value of the shared page state, read at start before the server answers
// A key not declared here can be neither read nor written through it (`refused()` lists what was tried), and test/local-storage-keys.test.js fails
// when any page source touches localStorage, sessionStorage or indexedDB outside this file, or uses a key this list does not declare. The table
// "Key audit" in docs/design/shared-page-state.md lists the same keys.
//
// A classic script, the first of the page (h5.html, login.html); `window.TALocalKeys`. Every access is guarded: private mode or blocked storage only
// loses what would have been kept.
(function (global) {
  // [key, area, category, reason, pane]. `*` in a key stands for any text; `pane`: a column of the multi-column view keeps its own copy under
  // `pane:<id>:<key>` (scripts/h5-shell/pane.mjs).
  const KEYS = [
    ['h5-source', 'local', 'browser', 'the service of the session this window opens at start: it decides the first requests before any answer', true],
    ['h5-task:*', 'local', 'browser', 'the task this window opens at start on that service (the last looked at anywhere is the first of the shared Recent list)', true],
    ['h5-terminal:*:*', 'local', 'browser', 'the terminal this window opens for that task at start', true],
    ['h5-terminal-width', 'local', 'hardware', 'fit or a fixed width: depends on the size of this screen', true],
    ['h5-terminal-wide-cols', 'local', 'hardware', 'the fixed terminal width of this screen', true],
    ['h5-terminal-width-noted', 'local', 'hardware', 'a one-time hint about the gesture of this device (long press or right click)', false],
    ['h5-sidebar-collapsed', 'local', 'cache-of-shared-state', 'the folded task sidebar (a column keeps its own, which stays in this browser)', true],
    ['h5-recent-sessions', 'local', 'cache-of-shared-state', 'the Recent list kept before the shared page state: read once to import it, then removed', false],
    ['h5-task-list-tab', 'local', 'cache-of-shared-state', 'the chosen tab of the task list', false],
    ['h5-columns', 'local', 'cache-of-shared-state', 'the multi-column layout', false],
    ['h5-design-outline', 'local', 'cache-of-shared-state', 'the outline column of the file sheet shown or folded', false],
    ['h5-attention-collapsed', 'local', 'cache-of-shared-state', 'the collapsed T-Attention parents', false],
    ['h5-attention-add-on', 'local', 'cache-of-shared-state', 'the engine a new T-Attention task goes to', false],
    ['h5-create-on', 'local', 'cache-of-shared-state', 'the machine "Create on" starts with (new task, new mind map): the one chosen last', false],
    ['ta-saved-commands-used', 'local', 'cache-of-shared-state', 'the recency of saved commands', false],
    ['h5-mindmap-list-folded', 'local', 'cache-of-shared-state', 'the folded list of the Mind maps tab', false],
    ['word-translate', 'local', 'cache-of-shared-state', 'tap to translate on or off', false],
    ['ta-lang', 'local', 'cache-of-shared-state', 'the language, read before the first paint (its cookie tells the server)', false],
    ['ta-page-state', 'local', 'cache-of-shared-state', 'the copy of the shared page state and the changes not sent yet', false],
    ['ta-page-state-imported', 'local', 'cache-of-shared-state', 'which values this browser kept before the shared page state were already sent', false],
    ['h5-attention-sound', 'local', 'device-setting', 'the T-Attention sound: Settings offers it as "Reminders on this device"', false],
    ['voice-enabled', 'local', 'hardware', 'voice input on this device: its microphone and permission', false],
    ['voice-keep-mic', 'local', 'hardware', 'keeping the microphone of this device ready', false],
    ['t-agent.settings-tab', 'local', 'browser', 'the device whose settings the open form edits, chosen where it is edited', false],
    ['t-agent.settings-device', 'local', 'browser', 'the same choice as kept before the Settings tabs: read once, then removed', false],
    ['h5-mindmap-draft:*', 'local', 'browser', 'the unsaved edits of a map in this browser (the saved map is on its service)', false],
    ['h5-mindmap', 'local', 'browser', 'kept by mind map columns of v2.133 and v2.134: read only to drop them', true],
    ['ta-device-id', 'local', 'browser', 'a random id of this browser, so the "Continue" hint and the drafts never offer this device its own session or text', false],
    ['terminal-client-id', 'session', 'browser', 'names this tab as one terminal client', true],
    ['h5-auto-reloaded-versions', 'session', 'browser', 'the versions this tab reloaded for by itself, so it never reloads twice', false],
    ['ta-lang-applied', 'session', 'browser', 'a language from another device is applied once per tab', false],
  ].map(([key, area, category, reason, pane]) => ({ key, area, category, reason, pane }));
  const CATEGORIES = ['hardware', 'browser', 'device-setting', 'cache-of-shared-state'];
  const PANE = /^pane:[a-z0-9]{1,16}:/;
  const toRegex = key => new RegExp(`^${key.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
  const matchers = KEYS.map(entry => ({ entry, regex: toRegex(entry.key) }));

  // The declaration of a stored key (a pane's copy included), or null.
  function declared(key, area = 'local') {
    if (typeof key !== 'string' || !key) return null;
    const pane = PANE.exec(key);
    const name = pane ? key.slice(pane[0].length) : key;
    const hit = matchers.find(({ entry, regex }) => entry.area === area && regex.test(name) && (!pane || entry.pane));
    return hit ? hit.entry : null;
  }

  // The door over one window's storages (`root`: the window; a test passes its own { localStorage, sessionStorage }).
  function build(root) {
    const refusedKeys = [];
    const area = name => { try { return name === 'session' ? root.sessionStorage : root.localStorage; } catch { return null; } };
    function allowed(key, where) {
      if (declared(key, where)) return true;
      if (!refusedKeys.includes(`${where}:${key}`)) refusedKeys.push(`${where}:${key}`);
      return false;
    }
    function get(key, where = 'local') {
      if (!allowed(key, where)) return null;
      try { const store = area(where); return store ? store.getItem(key) : null; } catch { return null; }
    }
    // Writes the text (null or undefined removes it); false when it was not kept.
    function set(key, value, where = 'local') {
      if (!allowed(key, where)) return false;
      try {
        const store = area(where);
        if (!store) return false;
        if (value === null || value === undefined) store.removeItem(key); else store.setItem(key, String(value));
        return true;
      } catch { return false; }
    }
    const remove = (key, where = 'local') => set(key, null, where);
    // Removes every declared key that starts with `prefix` (a pane's keys) from both areas; answers how many.
    function forget(prefix) {
      let removed = 0;
      for (const where of ['local', 'session']) {
        try {
          const store = area(where);
          if (!store || typeof prefix !== 'string' || !prefix) continue;
          const keys = [];
          for (let i = 0; i < store.length; i += 1) { const key = store.key(i); if (key && key.startsWith(prefix) && declared(key, where)) keys.push(key); }
          for (const key of keys) { store.removeItem(key); removed += 1; }
        } catch { /* storage blocked: nothing was kept */ }
      }
      return removed;
    }
    // A Storage-like object over the declared keys of one area, for code that takes a storage (settings-tabs.mjs, page-state.js).
    const storage = (where = 'local') => ({ getItem: key => get(key, where), setItem: (key, value) => { set(key, value, where); }, removeItem: key => { remove(key, where); } });

    return { KEYS, CATEGORIES, declared, get, set, remove, forget, storage, build, refused: () => refusedKeys.slice() };
  }

  const api = build(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TALocalKeys = api;
}(typeof window !== 'undefined' ? window : globalThis));

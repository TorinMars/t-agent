// The page's side of the shared page state (docs/design/shared-page-state.md): what the page remembers about the person is kept on the server
// (/api/page-state) and is the same on every device and every linked engine. A classic script before the shell, so the shell and h5.js find
// `TAPageState` when they start; not part of the first-screen bundle.
//
// - Keys: the person-level localStorage keys (MOVED below) are kept on the server under the same names. The browser's own key stays as a cache:
//   every value the server gives is written into it (a mirror), so the scripts that read it at start still find the last value at once, and a change
//   is written to it and sent to the server (`TAPageState.store`, a localStorage-like object, or `set`). Two keys name devices and tasks and are
//   translated between this page's source keys (`local`, `remote:<n>`) and engine instance ids (CODECS). `h5-column:<pane id>` is the session a
//   column shows (h5.js, already in instance ids).
// - Recent sessions: entries in instance ids (`recent()`, `noteRecent()`); `recentForPage` / `toShared` map them to this page's sources and back.
//   A device whose instance id is not known (an older Engine) is named `~<source key>` and its entries stay in this browser only. "Clear list"
//   (`clearRecent(keep)`) sends the clear mark (`clear: true`) with the entries that stay; until the server took it, only those are shown.
// - Changes are shown at once and sent 800 ms later (one request for a burst), kept in the cache until the server took them (a reload sends them
//   again), and sent with keepalive when the page is hidden. An answer replaces the state; changes made meanwhile stay on top.
// - Following other devices: the server pushes the new state to the top page after every change on any device or linked engine (`pushed`, from
//   this engine's activity stream that h5.js keeps open while the page is visible: "The page push" in docs/design/shared-page-state.md). The light
//   read stays as the fallback: at start, when the tab becomes visible or gets the focus (at most every 3 s) and every 60 s while visible. A pane of
//   the multi-column view and other tabs follow the cache through `storage` events (no requests or streams of their own). Every answer has the
//   `version` of the server's state: an older one than this page took (a read that crossed a push) is not applied.
// - Before this feature each browser kept its own values: once per browser they are sent as an import (version time 0, so a value set since on
//   any device wins), the recent list by h5.js (`importRecent`).
// - An older server (404) keeps everything in this browser, as before.
(function (root) {
  const URL = '/api/page-state';
  const CACHE_KEY = 'ta-page-state';
  const IMPORTED_KEY = 'ta-page-state-imported'; // the parts of this browser's old state already sent: 'keys', 'codec', 'recent'
  const MOVED = [
    'h5-task-list-tab', 'h5-columns', 'h5-sidebar-collapsed', 'h5-design-outline', 'h5-attention-collapsed', 'h5-attention-add-on', 'h5-attention-view', 'h5-attention-cal-view', 'h5-create-on',
    'ta-saved-commands-used', 'h5-mindmap-list-folded', 'word-translate', 'ta-lang', 'ta-start-commands',
  ];
  // Kept on the server as JSON (not as the text the browser keeps), so the server can merge it: the recency of saved commands, per command, and the
  // recent initial commands of a new terminal (scripts/h5-shell/start-commands.mjs).
  const JSON_KEYS = new Set(['ta-saved-commands-used', 'ta-start-commands']);
  const toText = shared => (shared === null || shared === undefined ? null : typeof shared === 'string' ? shared : JSON.stringify(shared));
  const fromText = (name, text) => {
    if (text === null || !JSON_KEYS.has(name)) return text;
    try { return JSON.parse(text); } catch { return null; }
  };
  const COLUMN_PREFIX = 'h5-column:';
  const RECENT_MAX = 12;
  const LOCAL_MAX = 24;
  const SEND_MS = 800;
  const READ_GAP_MS = 3000;
  const POLL_MS = 60000;
  const RETRY_MS = [5000, 15000, 60000];

  // ---- Identities (pure) ----
  // `sources`: [{ key, instanceId }] of this page. The identity of a source is its instance id, or `~<key>` while it has none.
  const idOf = from => (from && from.instanceId) || (from ? `~${from.key}` : '');
  function sourceOf(instance, sources) {
    const list = Array.isArray(sources) ? sources : [];
    const hit = list.find(from => from.instanceId && from.instanceId === instance) || list.find(from => `~${from.key}` === instance);
    return hit ? hit.key : null;
  }
  const isLocalOnly = instance => typeof instance === 'string' && instance.startsWith('~');
  // Where an entry was noted, `client` (phone, computer, mac, home) and `device` (that browser's random id), carried both ways when present: another
  // device offers "Continue <session>" from them (docs/design/continue-and-drafts.md).
  const seenOn = entry => ({ ...(entry.client ? { client: entry.client } : {}), ...(entry.device ? { device: entry.device } : {}) });
  // A page entry { sourceKey, taskId, terminalId, title, agent, lastUsed } as a shared one { instance, task, terminal, title, agent, used }.
  function toShared(entry, sources, now = Date.now()) {
    if (!entry) return null;
    const from = (Array.isArray(sources) ? sources : []).find(item => item.key === entry.sourceKey);
    if (!from) return null;
    return { instance: idOf(from), task: String(entry.taskId), terminal: String(entry.terminalId), title: entry.title || '', agent: entry.agent || null, used: Number(entry.lastUsed) > 0 ? Number(entry.lastUsed) : now, ...seenOn(entry) };
  }
  // A shared entry as this page's, or null for a device this page does not list.
  function toPage(entry, sources) {
    const sourceKey = entry && sourceOf(entry.instance, sources);
    if (!sourceKey) return null;
    const out = { sourceKey, taskId: String(entry.task), terminalId: String(entry.terminal), title: entry.title || '', agent: entry.agent || null, ...seenOn(entry) };
    if (Number(entry.used) > 0) out.lastUsed = Number(entry.used);
    return out;
  }
  // The shared list (used last first) as this page's recent list: the entries it can name, one per session, at most `max`.
  function recentForPage(list, sources, max = RECENT_MAX) {
    const seen = new Set();
    const out = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const row = toPage(entry, sources);
      const key = row && `${row.sourceKey}|${row.taskId}|${row.terminalId}`;
      if (!row || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= max) break;
    }
    return out;
  }
  const sharedId = entry => `${entry.instance}|${entry.task}|${entry.terminal}`;
  const byUse = (x, y) => (Number(y.used) || 0) - (Number(x.used) || 0) || (sharedId(x) < sharedId(y) ? -1 : 1);

  // Keys whose values name devices and tasks. The collapsed T-Attention parents: this page keeps a JSON list of this machine's task ids and
  // `remote:<n>:<id>` keys; shared, `<instance>:<id>`. An id of a device this page does not list is kept as it was.
  const COLLAPSED = /^(local|remote:[1-9]\d*):(\d+)$/;
  const SHARED_ITEM = /^([A-Za-z0-9-]{1,64}):(\d+)$/;
  // One engine: a source key on the page, its instance id in the shared state.
  const ENGINE_CODEC = {
    decode(value, sources) { return typeof value === 'string' ? sourceOf(value, sources) : null; },
    encode(text, sources, previous) {
      if (text === null) return null;
      const from = (sources || []).find(entry => entry.key === text);
      return from && from.instanceId ? from.instanceId : previous === undefined ? null : previous;
    },
  };
  const CODECS = {
    'h5-attention-collapsed': {
      decode(value, sources) {
        if (!Array.isArray(value)) return null;
        const out = [];
        for (const item of value) {
          const match = SHARED_ITEM.exec(String(item));
          const key = match && sourceOf(match[1], sources);
          if (key === 'local') out.push(Number(match[2])); else if (key) out.push(`${key}:${match[2]}`);
        }
        return JSON.stringify(out);
      },
      encode(text, sources, previous) {
        let list = [];
        try { list = JSON.parse(text || '[]'); } catch { list = []; }
        const known = new Set((sources || []).filter(from => from.instanceId).map(from => from.instanceId));
        const out = (Array.isArray(previous) ? previous : []).filter(item => { const match = SHARED_ITEM.exec(String(item)); return match && !known.has(match[1]); });
        for (const item of Array.isArray(list) ? list : []) {
          const match = typeof item === 'number' ? ['', 'local', String(item)] : COLLAPSED.exec(String(item));
          const from = match && (sources || []).find(entry => entry.key === match[1]);
          if (from && from.instanceId) out.push(`${from.instanceId}:${match[2]}`);
        }
        return [...new Set(out)];
      },
    },
    // The engine a new T-Attention task goes to: a source key here, an instance id shared.
    'h5-attention-add-on': ENGINE_CODEC,
    // The machine "Create on" starts with (a new task, a new mind map): the one chosen last, the same way.
    'h5-create-on': ENGINE_CODEC,
  };
  // Every codec needs this page's own instance id (it names this machine's tasks).
  const canCode = sources => (Array.isArray(sources) ? sources : []).some(from => from.key === 'local' && from.instanceId);

  const pure = { idOf, sourceOf, toShared, toPage, recentForPage, CODECS, MOVED };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---- Storage of this browser (guarded: private mode or blocked storage only loses the cache) ----
  // Through the registry of browser storage (public/js/local-keys.js), where the cache keys are declared as `cache-of-shared-state`.
  const keysOf = root.TALocalKeys || { get: () => null, set: () => false };
  const local = { get: key => keysOf.get(key), set: (key, value) => keysOf.set(key, value) };
  const readJson = key => { try { return JSON.parse(local.get(key) || 'null'); } catch { return null; } };
  const PANE = (() => { try { return new URLSearchParams(location.search).has('pane') && root.top !== root; } catch { return false; } })();

  const empty = () => ({ recent: {}, keys: {} });
  let state = { recent: [], keys: {} }; // the last answer of the server
  let pending = empty(); // changes the server has not taken: recent by id, keys by name
  let imports = empty(); // what this browser kept before the feature, sent once
  let localRecent = {}; // the entries of devices without an instance id: this browser only
  let supported = null; // null until the server answered; false: an older server (404)
  let sources = [];
  let peers = [];
  const listeners = new Set();

  function readCache() {
    const cache = readJson(CACHE_KEY);
    if (!cache || cache.v !== 1) return;
    if (cache.state && Array.isArray(cache.state.recent) && cache.state.keys && typeof cache.state.keys === 'object') state = cache.state;
    // The changes a page of this browser had not sent yet are sent by the next top page (a pane of the columns view leaves them to it).
    if (!PANE && cache.pending && cache.pending.recent && cache.pending.keys) pending = cache.pending;
    if (!PANE && cache.imports && cache.imports.recent && cache.imports.keys) imports = cache.imports;
    if (cache.local && typeof cache.local === 'object') localRecent = cache.local;
    if (Array.isArray(cache.sources)) sources = cache.sources;
    if (typeof cache.supported === 'boolean') supported = cache.supported;
  }
  let cacheText = '';
  function writeCache() {
    cacheText = JSON.stringify({ v: 1, state, pending, imports, local: localRecent, sources, supported });
    local.set(CACHE_KEY, cacheText);
  }

  // ---- The view: the server's state with the changes not taken yet on top ----
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function value(name) {
    if (has(pending.keys, name)) return pending.keys[name];
    if (has(state.keys, name)) return state.keys[name];
    if (has(imports.keys, name)) return imports.keys[name];
    return undefined;
  }
  function recent() {
    const cleared = Boolean(pending.clear); // a clear not taken yet: only what was sent with it (or noted since) is left
    const byId = new Map(cleared ? [] : state.recent.map(entry => [sharedId(entry), entry]));
    if (!cleared) for (const [id, entry] of Object.entries(imports.recent)) if (!byId.has(id) && !entry.gone) byId.set(id, entry);
    for (const [id, entry] of Object.entries(pending.recent)) { if (entry.gone) byId.delete(id); else byId.set(id, entry); }
    for (const [id, entry] of Object.entries(localRecent)) byId.set(id, entry);
    return [...byId.values()].sort(byUse);
  }

  const emit = (what = null) => { for (const listener of listeners) { try { listener(what); } catch { /* one listener never stops the others */ } } };

  // ---- Mirror: the server's value of each moved key into the browser's own key ----
  let applyingLang = false;
  function mirror() {
    const changed = [];
    for (const name of MOVED) {
      const shared = value(name);
      if (shared === undefined) continue;
      let text;
      if (CODECS[name]) { if (!canCode(sources)) continue; text = CODECS[name].decode(shared, sources); }
      else text = toText(shared);
      if (local.get(name) === text) continue;
      local.set(name, text);
      changed.push(name);
    }
    if (changed.includes('ta-lang')) applyLanguage();
    if (changed.length) emit(changed);
  }
  // A language chosen on another device: this page reloads in it once (i18n.js `set`), only when the browser kept it (else it would reload again).
  function applyLanguage() {
    const wanted = value('ta-lang');
    const i18n = root.I18n;
    if (PANE || !i18n || typeof i18n.set !== 'function' || (wanted !== 'en' && wanted !== 'zh') || (typeof i18n.get === 'function' && i18n.get() === wanted)) return;
    if (local.get('ta-lang') !== wanted) return;
    if (keysOf.get('ta-lang-applied', 'session') === wanted || !keysOf.set('ta-lang-applied', wanted, 'session')) return;
    applyingLang = true;
    try { i18n.set(wanted); } finally { applyingLang = false; }
  }

  // ---- Talking to the server ----
  const headers = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };
  let version = 0; // the newest `version` of the server's state this page took
  let moves = []; // [{ from: { instance, task }, to: { instance, task }, title, at }]: the server re-points the shared state itself; this is for what a page keeps alone
  let answered = false; // the server's state was read or pushed since this page started (not only the cache)
  function take(answer) {
    if (!answer || !Array.isArray(answer.recent) || !answer.keys || typeof answer.keys !== 'object') return false;
    const given = Number(answer.version);
    if (Number.isSafeInteger(given) && given < version) return true; // taken (a change sent is in it), but older than what this page shows
    if (Number.isSafeInteger(given)) version = given;
    answered = true;
    state = { recent: answer.recent, keys: answer.keys };
    moves = Array.isArray(answer.moves) ? answer.moves : []; // tasks moved to another engine (services/task-move.js), newest first
    peers = Array.isArray(answer.peers) ? answer.peers : [];
    supported = true;
    return true;
  }
  let reading = null;
  let readAt = 0;
  function load() {
    if (reading) return reading;
    readAt = Date.now();
    reading = (async () => {
      let res;
      try { res = await fetch(URL, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' }); } catch { return false; }
      if (res.status === 404) { supported = false; writeCache(); return false; }
      if (!res.ok) return false;
      let answer = null;
      try { answer = await res.json(); } catch { return false; }
      if (!take(answer)) return false;
      importOnce();
      writeCache();
      mirror();
      emit(null);
      if (dirty()) send();
      return true;
    })().finally(() => { reading = null; });
    return reading;
  }
  // The page push (h5.js, `event: page-state` of this engine's activity stream): the JSON of the answer a read would give, or {"read":true} for a
  // state too large to push (then it is read). The changes this page has not sent yet stay on top, as with a read.
  function pushed(text) {
    if (PANE || supported === false) return false;
    let answer = null;
    try { answer = typeof text === 'string' ? JSON.parse(text) : text; } catch { return false; }
    if (answer && answer.read === true) { load(); return true; }
    if (!take(answer)) return false;
    readAt = Date.now();
    writeCache();
    mirror();
    emit(null);
    return true;
  }
  const dirty = () => Boolean(pending.clear) || Object.keys(pending.recent).length + Object.keys(pending.keys).length + Object.keys(imports.recent).length + Object.keys(imports.keys).length > 0;
  let timer = null;
  let sending = null;
  let failures = 0;
  function schedule(ms = SEND_MS) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; send(); }, ms);
  }
  async function send({ keepalive = false } = {}) {
    if (supported === false || !dirty()) return;
    if (sending) { if (!keepalive) { await sending; schedule(); } return; }
    const sent = { recent: { ...pending.recent }, keys: { ...pending.keys }, clear: pending.clear || 0 };
    const sentImports = { recent: { ...imports.recent }, keys: { ...imports.keys } };
    const body = { recent: Object.values(sent.recent), keys: sent.keys };
    if (sent.clear) body.clear = true;
    if (Object.keys(sentImports.recent).length || Object.keys(sentImports.keys).length) body.import = { recent: Object.values(sentImports.recent), keys: sentImports.keys };
    sending = (async () => {
      let res;
      try { res = await fetch(URL, { method: 'PUT', headers, body: JSON.stringify(body), credentials: 'same-origin', keepalive }); } catch { res = null; }
      if (res && res.status === 404) { supported = false; writeCache(); return; }
      let answer = null;
      if (res && res.ok) { try { answer = await res.json(); } catch { answer = null; } }
      if (!take(answer)) {
        // Kept for the next try (a 400 means the change is malformed: it is dropped so it does not block the others).
        if (res && res.status === 400) { pending = empty(); imports = empty(); writeCache(); return; }
        schedule(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
        failures += 1;
        return;
      }
      failures = 0;
      // What was sent is taken; a change made meanwhile (another value under the same name) stays.
      for (const [id, entry] of Object.entries(sent.recent)) if (pending.recent[id] === entry) delete pending.recent[id];
      for (const [name, entry] of Object.entries(sent.keys)) if (has(pending.keys, name) && pending.keys[name] === entry) delete pending.keys[name];
      if (sent.clear && pending.clear === sent.clear) delete pending.clear; // a second clear meanwhile is sent next
      for (const id of Object.keys(sentImports.recent)) delete imports.recent[id];
      for (const name of Object.keys(sentImports.keys)) delete imports.keys[name];
      writeCache();
      mirror();
      emit(null);
    })().finally(() => { sending = null; });
    return sending;
  }

  // ---- Changes from this page ----
  function set(name, next) {
    const shared = next === undefined ? null : next;
    if (value(name) === shared && !has(imports.keys, name)) return;
    pending.keys[name] = shared;
    writeCache();
    emit([name]);
    schedule();
  }
  // The localStorage-like door of the moved keys: the browser's key is written at once (the cache), the server's value follows.
  const store = {
    getItem(name) {
      const shared = value(name);
      if (shared !== undefined && !CODECS[name]) return toText(shared);
      if (shared !== undefined && canCode(sources)) return CODECS[name].decode(shared, sources);
      return local.get(name);
    },
    setItem(name, text) {
      const str = text === null || text === undefined ? null : String(text);
      if (!name.startsWith(COLUMN_PREFIX)) local.set(name, str); // a column's session is kept on the server only
      if (!MOVED.includes(name) && !name.startsWith(COLUMN_PREFIX)) { emit([name]); return; } // any other key stays in this browser (a pane's own keys)
      if (CODECS[name]) {
        if (!canCode(sources)) { emit([name]); return; } // stays in this browser until the page knows its devices
        set(name, CODECS[name].encode(str, sources, value(name)));
      } else set(name, fromText(name, str));
      if (name === 'ta-lang' && !applyingLang) send({ keepalive: true }); // the page reloads next
    },
    removeItem(name) { store.setItem(name, null); },
  };
  // Recent sessions: changed entries ({ instance, task, terminal, title, agent, used } or { ..., gone: true }).
  function noteRecent(entries) {
    let changed = false;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !entry.instance) continue;
      const id = sharedId(entry);
      if (isLocalOnly(entry.instance)) {
        if (entry.gone) delete localRecent[id]; else localRecent[id] = entry;
      } else pending.recent[id] = entry.gone ? { instance: entry.instance, task: entry.task, terminal: entry.terminal, gone: true } : entry;
      changed = true;
    }
    if (!changed) return;
    for (const list of [localRecent, pending.recent]) { // an older server never takes them: at most LOCAL_MAX wait
      for (const [id] of Object.entries(list).sort(([, x], [, y]) => byUse(x, y)).slice(LOCAL_MAX)) delete list[id];
    }
    writeCache();
    emit(['recent']);
    schedule();
  }
  // "Clear list" of the Recent tab: every entry goes, on every device and engine (the server's clear mark, page-state-merge.js), except `keep`
  // (the shown session, as shared entries, sent again with the clear's version). Entries put back by Undo are noted after it (`noteRecent`).
  function clearRecent(keep) {
    const stay = (Array.isArray(keep) ? keep : []).filter(entry => entry && entry.instance && !entry.gone);
    const ids = new Set(stay.map(sharedId));
    for (const id of Object.keys(localRecent)) if (!ids.has(id)) delete localRecent[id];
    for (const id of Object.keys(pending.recent)) if (!ids.has(id)) delete pending.recent[id]; // a change not sent yet would carry the clear's version
    imports.recent = {};
    pending.clear = (Number(pending.clear) || 0) + 1;
    for (const entry of stay) { if (isLocalOnly(entry.instance)) localRecent[sharedId(entry)] = entry; else pending.recent[sharedId(entry)] = entry; }
    writeCache();
    emit(['recent']);
    schedule();
  }
  // A value this page found by itself (a column restoring what it showed here before): kept only when no device set one (version time 0).
  function importKey(name, next) {
    if (value(name) !== undefined) return;
    imports.keys[name] = next === undefined ? null : next;
    writeCache();
    emit([name]);
    schedule();
  }
  // The recent list this browser kept before the feature (h5.js maps it): sent once, under the version time 0.
  function importRecent(entries) {
    if (imported().includes('recent')) return;
    markImported('recent');
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !entry.instance) continue;
      if (isLocalOnly(entry.instance)) localRecent[sharedId(entry)] = entry; else imports.recent[sharedId(entry)] = entry;
    }
    writeCache();
    emit(['recent']);
    schedule();
  }
  const imported = () => { const list = readJson(IMPORTED_KEY); return Array.isArray(list) ? list : []; };
  const markImported = part => local.set(IMPORTED_KEY, JSON.stringify([...new Set([...imported(), part])]));
  // The moved keys this browser kept and the server does not have: sent once (the ones that name devices once this page knows its devices).
  function importOnce() {
    if (supported !== true) return;
    const done = imported();
    for (const part of ['keys', 'codec']) {
      if (done.includes(part) || (part === 'codec' && !canCode(sources))) continue;
      markImported(part);
      for (const name of MOVED) {
        if (Boolean(CODECS[name]) !== (part === 'codec') || value(name) !== undefined) continue;
        const text = local.get(name);
        if (text === null) continue;
        imports.keys[name] = CODECS[name] ? CODECS[name].encode(text, sources, undefined) : fromText(name, text);
      }
    }
    if (dirty()) schedule();
  }
  // This page's devices (h5.js publishSources): the keys that name devices are decoded again.
  function setSources(list) {
    const next = (Array.isArray(list) ? list : []).map(from => ({ key: String(from.key), instanceId: from.instanceId || null }));
    if (JSON.stringify(next) === JSON.stringify(sources)) return;
    sources = next;
    writeCache();
    importOnce();
    mirror();
    emit(['sources']);
  }

  // ---- Start and following ----
  readCache();
  root.addEventListener('storage', event => {
    if (event.key !== CACHE_KEY || !event.newValue || event.newValue === cacheText) return;
    let cache = null;
    try { cache = JSON.parse(event.newValue); } catch { return; }
    if (!cache || cache.v !== 1 || !cache.state || !Array.isArray(cache.state.recent)) return;
    state = cache.state; // another frame or tab of this browser read or changed the state; this page's own changes stay on top
    if (typeof cache.supported === 'boolean') supported = cache.supported;
    mirror();
    emit(null);
  });
  root.addEventListener('pagehide', () => { if (dirty()) send({ keepalive: true }); });
  if (!PANE) {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const again = () => { if (visible() && Date.now() - readAt >= READ_GAP_MS) load(); };
    document.addEventListener('visibilitychange', () => { if (visible()) again(); else if (dirty()) send({ keepalive: true }); });
    root.addEventListener('focus', again);
    setInterval(() => { if (visible() && supported !== false) load(); }, POLL_MS);
    load();
  }

  root.TAPageState = {
    ...pure, store, get: value, set, importKey, recent, noteRecent, clearRecent, importRecent, setSources, load, send, pushed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    supported: () => supported,
    answered: () => answered,
    peers: () => peers,
    moves: () => moves,
    keys: () => [...new Set([...Object.keys(state.keys), ...Object.keys(pending.keys)])],
  };
}(typeof window !== 'undefined' ? window : globalThis));

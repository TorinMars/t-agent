// Continue where you left off (docs/design/continue-and-drafts.md): the "Continue <session>" hint on entry, and the text of the draft box that
// follows its session across devices. Both ride on the shared page state (public/js/page-state.js, `TAPageState`), which the server pushes to every
// open page, so nothing in the server, the stream or the sync changes for them. A classic script of the page; h5.js wires it (`TAContinue`).
//
// - Where a session was looked at: each recent entry carries the `client` that noted it (phone, computer, mac, home) and `device`, a random id of
//   that browser (`ta-device-id`), so another device can say "Last viewed on your computer" and this device never offers its own session.
// - Drafts: one key per session in the shared page state, `ta-draft:<hash of instance|task|terminal>` (a key name allows no `|` or capitals), the
//   value { instance, task, terminal, text, at, client, device }; null when sent or emptied (a cleared key travels like any other). The newer edit
//   wins (the shared state's merge: the later version of a key); a page never changes the text while its box has the focus, and its own unsent text
//   is never overwritten: the other draft is offered instead.
// Pure rules first, then the page's controller (both unit tested with a fake clock and a fake shared state, test/continue-drafts.test.js).
(function (root) {
  const DRAFT_PREFIX = 'ta-draft:';
  const DRAFT_MAX = 4000; // characters: a longer draft stays in this box only (a key of the shared state holds at most 16 KB of JSON)
  const DRAFT_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // an older draft is dropped
  const DRAFTS_MAX = 20; // live drafts kept in the shared state (it holds at most 128 keys): the oldest beyond it are cleared
  const SEND_GAP_MS = 2000; // while typing, a draft is written at most this often (each write is a PUT and a push to every page)
  const HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  const HINT_MS = 10000;
  const CLIENTS = { phone: 'phone', computer: 'computer', mac: 'Mac app', home: 'Home Screen app' };

  // ---- Pure rules ----
  // FNV-1a over UTF-16 code units, two seeds: 16 hex characters name a session in a key.
  function hash32(text, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const sessionId = ident => (ident && ident.instance ? `${ident.instance}|${ident.task}|${ident.terminal}` : '');
  const draftKey = id => `${DRAFT_PREFIX}${hash32(id, 0x811c9dc5)}${hash32(id, 0x01234567)}`;
  const isDraftKey = name => typeof name === 'string' && name.startsWith(DRAFT_PREFIX);

  // What the page runs in ({ app, standalone, platform } of open-link.js `environment`) as a client kind.
  function clientKind(env) {
    const e = env || {};
    if (e.app) return 'mac';
    if (e.standalone) return 'home';
    return e.platform === 'ios' || e.platform === 'android' ? 'phone' : 'computer';
  }
  const clientLabel = client => CLIENTS[client] || '';

  // A stored draft for the session `id`, checked: { text, at, client, device }, or null (none, malformed, another session's, too old, too long).
  function cleanDraft(value, id, now) {
    if (!value || typeof value !== 'object' || sessionId(value) !== id) return null;
    const { text, at } = value;
    if (typeof text !== 'string' || !text.trim() || text.length > DRAFT_MAX || !Number.isFinite(at) || at <= 0 || now - at > DRAFT_KEEP_MS) return null;
    return { text, at, client: CLIENTS[value.client] ? value.client : null, device: typeof value.device === 'string' ? value.device : '' };
  }
  const signature = draft => (draft ? `${draft.device}|${draft.at}|${draft.text.length}` : '');

  // What to do when the shared draft of the bound session is (or becomes) `remote`. `known`: the signature this page handled last; `box`: the text in
  // the box; `base`: the text of the shared draft this page saw last (its own write or one read), so a clear empties only a box that holds what was
  // cleared, never text the box kept while another draft won; `taken`: the text
  // last put in from another device (a box that still holds it has no text of its own, so it follows); `device`: this browser's id. { act, sig }: 'none' (nothing to do), 'same' (already in the box), 'wait' (the box has the focus: decided again on blur), 'fill'
  // (put it in the box, with the caption), 'offer' (this box has its own unsent text: offer it), 'clear' (sent or emptied elsewhere: empty the box).
  function arrival({ remote, known, box, base, taken = '', focused, device }) {
    const sig = signature(remote);
    if (sig === known) return { act: 'none', sig };
    if (!remote) {
      if (!box || box !== base) return { act: 'none', sig }; // empty already, or this box's own text: kept
      return focused ? { act: 'wait', sig } : { act: 'clear', sig };
    }
    if (remote.device && remote.device === device) return { act: 'none', sig }; // this browser's own write coming back
    if (remote.text === box) return { act: 'same', sig };
    if (focused) return { act: 'wait', sig };
    return !box.trim() || box === taken ? { act: 'fill', sig } : { act: 'offer', sig }; // this device's own text is never replaced
  }

  // "2 min ago", "just now", "3 h ago", "yesterday", "4 days ago" (each part has its Chinese entry).
  function ago(at, now) {
    const minutes = Math.max(0, Math.floor((now - at) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
    const days = Math.floor(minutes / 1440);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  const lastViewedText = (client, at, now) => `Last viewed on your ${clientLabel(client)} · ${ago(at, now)}`;
  const draftFromText = (client, at, now) => (clientLabel(client) ? `Draft from your ${clientLabel(client)} · ${ago(at, now)}` : `Draft from another device · ${ago(at, now)}`);
  const useDraftText = client => (clientLabel(client) ? `Use the draft from your ${clientLabel(client)}` : 'Use the draft from another device');

  // Whether to offer "Continue <session>" on entry. `top`: the session last looked at anywhere (the first of the shared Recent list, as this page's
  // entry: { sourceKey, taskId, terminalId, title, lastUsed, client, device }); `listed`: it still exists (it is in the page's pruned list); `shown`:
  // the session this device opened by itself; `device`: this browser's id. Not offered for a session that is gone, older than 12 hours, last viewed
  // on this same device or on a client the entry does not name, or that this device shows anyway. { client, at } or null.
  function hintFor({ top, listed, shown, device, now }) {
    if (!top || !listed || !CLIENTS[top.client] || !top.device || top.device === device) return null;
    const at = Number(top.lastUsed);
    if (!(at > 0) || now - at > HINT_MAX_AGE_MS || at - now > 60000) return null;
    const key = entry => `${entry.sourceKey}|${entry.taskId}|${entry.terminalId}`;
    if (shown && key(shown) === key(top)) return null;
    return { client: top.client, at };
  }

  // The drafts to clear: too old ones, and the oldest live ones beyond DRAFTS_MAX (`keep`: the bound session's key, never cleared here).
  function staleDrafts(entries, now, keep = null) {
    const live = [];
    const out = [];
    for (const [name, value] of entries) {
      if (!isDraftKey(name) || value === null || value === undefined) continue;
      const draft = value && typeof value === 'object' ? cleanDraft(value, sessionId(value), now) : null;
      if (!draft) { if (name !== keep) out.push(name); continue; }
      live.push([name, draft.at]);
    }
    live.sort((a, b) => b[1] - a[1]);
    for (const [name] of live.slice(DRAFTS_MAX)) if (name !== keep) out.push(name);
    return out;
  }

  const pure = {
    DRAFT_MAX, DRAFT_KEEP_MS, DRAFTS_MAX, SEND_GAP_MS, HINT_MAX_AGE_MS, HINT_MS, CLIENTS,
    sessionId, draftKey, isDraftKey, clientKind, clientLabel, cleanDraft, signature, arrival, ago, lastViewedText, draftFromText, useDraftText, hintFor, staleDrafts,
  };

  // ---- This browser ----
  // A random id of this browser (`ta-device-id`, a `browser` key of public/js/local-keys.js): without storage, one per page load.
  function deviceId() {
    const keys = root.TALocalKeys;
    const kept = keys && keys.get('ta-device-id');
    if (typeof kept === 'string' && /^[a-z0-9]{8,32}$/.test(kept)) return kept;
    let id = '';
    try { id = Array.from(root.crypto.getRandomValues(new Uint8Array(10)), byte => (byte % 36).toString(36)).join(''); } catch { id = ''; }
    while (id.length < 12) id += Math.floor(Math.random() * 36).toString(36);
    if (keys) keys.set('ta-device-id', id);
    return id;
  }
  function client() {
    // open-link.js declares `const OpenLink` at the top level of a classic script: a global binding, not a property of window.
    const links = typeof OpenLink !== 'undefined' ? OpenLink : root.OpenLink; // eslint-disable-line no-undef
    try { return clientKind(links ? links.environment(root) : {}); } catch { return 'computer'; }
  }

  // The draft box of one page (h5.js: the top page or a column). `input`: the textarea; `store`: { get, set, send, keys } (TAPageState);
  // `setText(text)`: puts a text in the box (h5.js also resizes it); `onNote(note)`: the caption above the box, { kind: 'took' | 'offer', client,
  // at } or null. h5.js calls `bind` when the shown session changes, `input` / `blur` from the box's events, `sent` after a send, `changed` when
  // the shared state changed, `flush` when the page hides.
  function createDrafts({ input, store, setText, onNote = () => {}, device = deviceId(), kind = client(), now = () => Date.now() }) {
    let id = ''; // the bound session (shared identity), '' for none or a session of an engine without an instance id
    let ident = null;
    let pageKey = null; // the bound session as this page names it (its drafts stay here when it has no shared identity)
    const local = new Map(); // drafts that are not shared: sessions without an identity, text longer than DRAFT_MAX
    let base = '';
    let taken = '';
    let known = '';
    let note = null;
    let dirty = false;
    let lastWrite = 0;
    let timer = null;
    const focused = () => typeof document !== 'undefined' && document.activeElement === input;
    const show = next => { note = next; onNote(next); };
    const remote = () => (id ? cleanDraft(store.get(draftKey(id)), id, now()) : null);
    const localKey = () => id || pageKey;

    function write() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty) return;
      dirty = false;
      const text = input.value;
      const key = localKey();
      if (!id || text.length > DRAFT_MAX) { if (key) { if (text.trim()) local.set(key, text); else local.delete(key); } return; } // stays in this box
      if (key) local.delete(key);
      lastWrite = now();
      base = text;
      const value = text.trim() ? { ...ident, text, at: lastWrite, client: kind, device } : null;
      known = signature(value && cleanDraft(value, id, lastWrite));
      store.set(draftKey(id), value);
      if (value) for (const name of staleDrafts(store.keys().map(k => [k, store.get(k)]), lastWrite, draftKey(id))) store.set(name, null);
    }
    function decide() {
      if (!id) return;
      const draft = remote();
      const { act, sig } = arrival({ remote: draft, known, box: input.value, base, taken, focused: focused(), device });
      if (act === 'wait') return;
      known = sig;
      if (act === 'same') { base = input.value; dirty = false; return; }
      if (draft) base = draft.text;
      if (act === 'fill') { setText(draft.text); base = draft.text; taken = draft.text; dirty = false; show({ kind: 'took', client: draft.client, at: draft.at }); return; }
      if (act === 'offer') { base = draft.text; show({ kind: 'offer', client: draft.client, at: draft.at, text: draft.text }); return; }
      if (act === 'clear') { setText(''); base = ''; taken = ''; dirty = false; show(null); return; }
      if (!draft && note && note.kind === 'offer') show(null); // the offered draft was sent or emptied elsewhere
    }
    return {
      get id() { return id; },
      get note() { return note; },
      device,
      kind,
      // The shown session changed (`target`: { ident: { instance, task, terminal } | null, pageKey } or null): the box's text is kept for the session
      // left, and the box shows the new session's draft.
      bind(target) {
        const raw = target && target.ident;
        // `~<source>`: an engine without an instance id, whose sessions are named in this page only (page-state.js): its drafts stay here.
        const nextIdent = raw && typeof raw.instance === 'string' && raw.instance && !raw.instance.startsWith('~')
          ? { instance: raw.instance, task: String(raw.task), terminal: String(raw.terminal) } : null;
        const nextId = sessionId(nextIdent);
        const nextPage = target ? target.pageKey || null : null;
        if (nextId === id && nextPage === pageKey) return;
        if (nextPage && nextPage === pageKey && !id && nextId) { // the same session, whose engine's instance id is known now: its text is shared from here
          id = nextId; ident = nextIdent; local.delete(nextPage);
          if (input.value) { dirty = true; write(); } else decide();
          return;
        }
        write();
        id = nextId; ident = nextIdent; pageKey = nextPage; known = ''; taken = ''; dirty = false;
        if (note) show(null);
        const draft = remote();
        const kept = localKey() ? local.get(localKey()) : undefined;
        let text = '';
        if (kept !== undefined) text = kept; // this box's own text that is not shared (too long, or no shared identity)
        else if (draft) {
          text = draft.text; known = signature(draft);
          if (draft.device !== device) { taken = text; show({ kind: 'took', client: draft.client, at: draft.at }); }
        }
        base = draft ? draft.text : text;
        if (input.value !== text) setText(text);
      },
      // Typing (an `input` event of the box): written at once, then at most every SEND_GAP_MS. The caption of a taken draft goes.
      input() {
        dirty = true;
        if (note && note.kind === 'took') show(null);
        const wait = lastWrite + SEND_GAP_MS - now();
        if (wait <= 0) write(); else if (!timer) timer = setTimeout(write, wait);
      },
      // The box lost the focus: what is typed is written and sent at once, and a draft that waited for the focus to go is decided.
      blur() { const had = dirty; write(); if (had) store.send(); decide(); },
      // The page hides or closes: written and sent with keepalive.
      flush() { const had = dirty; write(); if (had) store.send({ keepalive: true }); },
      // A send from this box succeeded (`startId`: the session bound when it started): the rest of the box (usually nothing) is its draft now, so a
      // sent draft is cleared everywhere.
      sent(startId = id) {
        if (startId && startId !== id) { store.set(draftKey(startId), null); local.delete(startId); store.send(); return; }
        if (note) show(null);
        dirty = true; lastWrite = 0; write(); store.send();
      },
      // "Use the draft from your <device>": the offered draft replaces this box's text.
      useOffer() {
        if (!note || note.kind !== 'offer') return;
        const { text, client: from, at } = note;
        setText(text); base = text; taken = text; dirty = false;
        show({ kind: 'took', client: from, at });
      },
      changed: decide,
      // Too old drafts, and the oldest beyond DRAFTS_MAX, are cleared (the top page, once its state is read).
      sweep() { for (const name of staleDrafts(store.keys().map(k => [k, store.get(k)]), now(), id ? draftKey(id) : null)) store.set(name, null); },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { ...pure, createDrafts }; // the tests pass `device`, `kind` and `now`
  else root.TAContinue = { ...pure, deviceId, client, createDrafts };
}(typeof window !== 'undefined' ? window : globalThis));

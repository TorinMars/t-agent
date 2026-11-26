// The live side of T-Attention on the page (started once by entry.jsx, before the panel is ever opened, so the "Needs you" badge and the reminders
// work from the start): reads the list (GET /api/attention), follows GET /api/attention/stream (server-sent events, event 'change'), keeps
// `state.attention` in the store and registers the actions the panel (Attention.jsx) and the Settings group (AttentionSettings.jsx) call.
// One list of every engine: this machine and each connected service of the task list (h5.js `state.sources`: listed, online, with 'attention:remote';
// `attentionEngines`) is one entry with its own list read, stream, reconnects and failure, through this Client's proxy (`/api/remote-servers/:id/attention`).
// The items of all of them are one list, each tagged with its `engine` and `key` (attention-model.mjs `tagItem`); every action goes to the item's own engine.
// An engine whose read fails says so in the panel (`failed`) while the others go on; one that answers 501 (no T-Attention there) is left out quietly.
// Reminders: a change that moves a task INTO waiting_user, failed or review gives a toast (not for a plain Claude turn end, showsNotice) and a short
// sound made with WebAudio (no audio file; on by default, off in Settings). A change this page made itself (the user's own tap here) gives none.
// There are no system (browser / OS) notifications: reminders away from the page come from the server's notifiers (Telegram, services/attention-notify.js).
// `passive` (a pane of the multi-column view, pane.mjs): no stream, no reminders and no reads of its own; the actions stay (Settings uses them) and the
// list is read when the panel is opened. The top page follows the stream and reminds once for all its columns.
// The top page opens this machine's stream with `?tab=1`: the server then counts it as an open page of this machine (services/page-channel.js) that
// the desktop window's Open session can switch in place. Its first event is `hello` { stream }; the page reports when it is seen (shown or focused) with
// POST /api/attention/stream/seen { stream }, and `open-terminal` { engine, task_id, terminal_id } shows that terminal as the `?openTerminal=` link does
// (h5.js ui.actions.openTerminalLink); `open-item` { key } (a click on a task of the desktop window) shows that task's details here, as the
// `?openAttention=<key>` link of h5.js does: `openAttention({ item: key })`, and Attention.jsx waits for a task that is not listed yet (`focus`). The
// stream stays open while the page is hidden, so a background tab is switched too.
// Read copies (docs/design/attention-copies.md): this machine's list and stream (`copies=1`) also carry the read copies it keeps of every linked engine
// that has them (`copies: { items, owners }`), so those engines need no list read or stream of their own, and their items stay listed while they are
// offline ("<engine> is offline · as of <time>", `attention.offline`). A copy is tagged with its owner's engine key (the task list's `remote:<id>`, or
// `copy:<instance id>` for a device known only through another one); its actions go to the proxy as before, which answers from the copy while the owner
// is offline (a queued change, shown at once with `pending`, or a refusal). An engine without copies (an older one, a plain remote) is read live.
import { localGet, localSet } from './local-keys.mjs';
import { applyChange, attentionEngines, engineOf, itemKey, keyOf, needsCount, parseKey, reminderFor, showsNotice, tagItem } from './attention-model.mjs';

export const BASE = '/api/attention';
// The API of an engine's T-Attention: this machine's own, or a connected service's through this Client's proxy (h5.js names it 'remote:<id>').
// A device known only through another one (`copy:<instance id>`): its copies on this machine, read only.
export const baseOf = engine => (!engine || engine === 'local' ? BASE : String(engine).startsWith('copy:') ? `${BASE}/copies/${encodeURIComponent(String(engine).slice(5))}` : `/api/remote-servers/${String(engine).replace(/^remote:/, '')}/attention`);
const LIST_QUERY = '?include_done=1&limit=200';
// The engine key of a read copy: its owner's row in the task list, else the owner's instance id.
export const copyKeyOf = item => (item && item.owner_engine) || `copy:${item && item.owner}`;
const tagCopy = item => tagItem(item, copyKeyOf(item));
const OWN_MS = 8000; // a change event for a task this page changed within this time, made by 'user', is this page's own
const RETRY_MS = [1000, 2000, 5000, 10000, 30000, 60000];
// '0' = off (default on). An old 'h5-attention-notify' value (system notifications, removed) is ignored. Kept in this browser, not in the shared page
// state: Settings offers it as "Reminders on this device" (scope device), since a phone in a meeting and a computer at home want different sounds.
const SOUND_KEY = 'h5-attention-sound';

const read = key => localGet(key);
const write = (key, value) => { localSet(key, value); }; // null removes; blocked storage: not remembered

export function prefs() {
  return { sound: read(SOUND_KEY) !== '0' };
}

// Two short soft tones (about 0.3 s). The AudioContext is made on the first use and resumed on the user's first tap of the page, since browsers
// start it suspended until a gesture.
let audio = null;
function context() {
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return null;
  if (!audio) { try { audio = new Ctx(); } catch { audio = null; } }
  return audio;
}
export function playSound() {
  const ctx = context();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    const start = ctx.currentTime + 0.01;
    [[880, 0], [660, 0.16]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.15);
    });
    return true;
  } catch { return false; }
}

export function startAttentionFeed(ui, { t = text => text, api, EventSourceImpl, passive = false } = {}) {
  const ES = passive ? null : EventSourceImpl || (typeof EventSource === 'undefined' ? null : EventSource);
  const own = new Map(); // item key -> time until which a 'user' change of it is this page's own
  let entries = new Map(); // engine key -> its entry, in the order of the list (the one order of devices, by name)
  const unsupported = new Map(); // engine key -> its capabilities when it answered 501: left out until they change
  let sourcesSeen; // the `state.sources` the entries were made from
  let stopped = false;
  // The read copies of this machine's list: whether its first answer came (until then no other engine is read: it may cover them), and the owners it
  // keeps copies of ([{ instance_id, name, host, engine, linked, online, as_of }]; empty from an older server, which then reads every engine live).
  let copiesKnown = false;
  let owners = [];
  let copyEngines = new Map(); // engine key -> its entry of `attention.engines`
  // Copies of this machine's last list whose engine was not shown when it came (the task list's devices not known yet): shown from here once they are.
  let parked = [];
  let localHidden = false; // this machine is hidden in the task list: its list is read for the copies, its own items are not shown

  const current = () => ui.get().attention || {};
  const alive = entry => !stopped && entries.get(entry.key) === entry;
  const nameOf = entry => (entry.local ? entry.name || t('This machine') : entry.label || entry.name || entry.key);
  const engineName = key => { const entry = entries.get(key) || copyEngines.get(key); return entry ? nameOf(entry) : key; };
  // The copy engines shown: an owner of the copies whose device the task list lists (or one it does not know: a device known through another), in
  // the one order of devices of the task list, then the others by name.
  function copyEnginesOf(sources) {
    const list = Array.isArray(sources) ? sources : [];
    const known = list.some(source => source && source.listed === true);
    const out = new Map();
    for (const owner of owners) {
      const key = owner.engine || `copy:${owner.instance_id}`;
      const source = list.find(entry => entry && (entry.key === key || (owner.instance_id && entry.instanceId === owner.instance_id)));
      if (source ? source.listed !== true : !known) continue;
      out.set(key, {
        key, local: false, label: source ? source.label : owner.name, name: source ? source.name || owner.name : owner.name, instanceId: owner.instance_id, host: owner.host || null,
        ready: Boolean(owner.online && owner.linked), copy: true, offline: !owner.online, linked: Boolean(owner.linked), asOf: owner.as_of || null,
      });
    }
    const order = new Map(list.map((source, index) => [source && source.key, index]));
    return new Map([...out.entries()].sort(([a, x], [b, y]) => (order.has(a) ? order.get(a) : 1e6) - (order.has(b) ? order.get(b) : 1e6) || String(x.name).localeCompare(String(y.name), 'en')));
  }
  const coveredBy = () => {
    const keys = new Set();
    for (const owner of owners) { if (owner.engine) keys.add(owner.engine); if (owner.instance_id) keys.add(`id:${owner.instance_id}`); }
    return keys;
  };
  // The state of the panel from the entries: the overall status (ready once any engine answered), live (every engine that answered is connected), the
  // engines shown (`engines`, for the tags, the order and "on <engine>"; the colour of a tag comes from the instance id h5.js knows, else the one the
  // engine's list answered with) and the ones that failed (`failed`, only when there is more than one).
  const patch = (next = {}) => ui.set(state => {
    const attention = { ...(state.attention || {}), ...next };
    const list = [...entries.values()];
    const ready = list.filter(entry => entry.status === 'ready');
    // The engines in the one order of devices: the ones read live and the ones read from the copies, as the task list orders them.
    const order = new Map(((ui.get().sources) || []).map((source, index) => [source && source.key, index]));
    const shown = [...list.filter(entry => !(entry.local && localHidden)), ...copyEngines.values()].map((entry, index) => ({ entry, index }))
      .sort((a, b) => (order.has(a.entry.key) ? order.get(a.entry.key) : 1e6 + a.index) - (order.has(b.entry.key) ? order.get(b.entry.key) : 1e6 + b.index))
      .map(({ entry }) => entry);
    attention.status = ready.length ? 'ready' : list.some(entry => entry.status === 'loading') ? 'loading' : list.some(entry => entry.status === 'error') ? 'error' : (attention.status || 'idle');
    attention.live = ready.length > 0 && ready.every(entry => entry.live);
    attention.engines = shown.map(entry => (entry.copy ? { ...entry } : { key: entry.key, local: entry.local, label: entry.label, name: entry.name, instanceId: entry.instanceId || entry.instance || null, host: entry.host, ready: entry.status === 'ready' }));
    attention.failed = shown.length > 1 ? list.filter(entry => entry.status === 'error').map(entry => ({ key: entry.key, name: nameOf(entry) })) : [];
    // The engines whose items are their copies as of a time: offline linked ones, and devices known only through another one.
    attention.offline = [...copyEngines.values()].filter(entry => entry.offline).map(entry => ({ key: entry.key, name: nameOf(entry), asOf: entry.asOf, linked: entry.linked }));
    const local = entries.get('local');
    attention.host = local ? local.host : null;
    attention.error = local ? local.error : null;
    if (Array.isArray(attention.items)) attention.items = attention.items.filter(item => (entries.has(engineOf(item)) && !(localHidden && engineOf(item) === 'local')) || copyEngines.has(engineOf(item)));
    attention.needs = needsCount(attention.items);
    return { attention };
  });
  const markOwn = key => { if (key != null) own.set(key, Date.now() + OWN_MS); };
  const isOwn = change => {
    const key = keyOf(change.item);
    const until = own.get(key);
    if (!until) return false;
    if (until < Date.now()) { own.delete(key); return false; }
    const actor = change.event && change.event.actor;
    return !actor || actor === 'user';
  };

  // The page stream (`?tab=1`, this machine's entry of the top page): its id from `hello`, and when the page is seen it says so (only the page seen last
  // gets the desktop window's Open session).
  let pageStream = null;
  const isTopPage = () => { try { return typeof window !== 'undefined' && window.top === window; } catch { return false; } };
  const reportSeen = () => {
    if (passive || !pageStream) return;
    Promise.resolve().then(() => api('POST', `${BASE}/stream/seen`, { stream: pageStream })).catch(() => { /* an older server, or offline */ });
  };
  if (!passive && typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', reportSeen);

  const make = info => ({ ...info, base: baseOf(info.key), query: info.key === 'local' ? `${LIST_QUERY}&copies=1` : LIST_QUERY, status: 'idle', loaded: false, error: null, host: null, live: false, es: null, retry: 0, timer: 0, loadTimer: 0, loadRetry: 0, readSeq: 0, loadedAt: 0 });
  // An engine without T-Attention (501 ATTENTION_REMOTE_UNSUPPORTED from the proxy) is not an error: it is left out without a word.
  const isUnsupported = error => Boolean(error && (error.status === 501 || (error.data && error.data.error === 'ATTENTION_REMOTE_UNSUPPORTED')));
  const capabilitiesOf = key => { const found = (ui.get().sources || []).find(source => source && source.key === key); return JSON.stringify((found && found.capabilities) || null); };

  async function load(entry) {
    const seq = ++entry.readSeq;
    entry.loadedAt = Date.now();
    clearTimeout(entry.loadTimer);
    entry.loadTimer = 0;
    if (!entry.loaded) { entry.status = 'loading'; patch(); }
    try {
      const data = await api('GET', `${entry.base}${entry.query}`);
      if (seq !== entry.readSeq || !alive(entry)) return;
      const items = (Array.isArray(data && data.items) ? data.items : []).filter(item => item && item.id != null).map(item => tagItem(item, entry.key));
      Object.assign(entry, { loaded: true, status: 'ready', error: null, loadRetry: 0, host: data && typeof data.host === 'string' ? data.host : null, instance: data && typeof data.instance_id === 'string' ? data.instance_id : null });
      if (entry.local) {
        // The read copies of this machine (an older server has none): their items replace the copies the page had, and the engines they cover are not
        // read live (sync below drops their entries).
        const copies = data && data.copies && typeof data.copies === 'object' ? data.copies : null;
        const before = new Set(copyEngines.keys());
        owners = copies && Array.isArray(copies.owners) ? copies.owners.filter(owner => owner && owner.instance_id) : [];
        copiesKnown = true;
        copyEngines = copyEnginesOf(ui.get().sources);
        const copied = copies && Array.isArray(copies.items) ? copies.items.filter(item => item && item.id != null && item.owner).map(tagCopy) : [];
        const known = new Set(owners.map(owner => owner.engine || `copy:${owner.instance_id}`));
        parked = copied.filter(item => !copyEngines.has(engineOf(item)) && known.has(engineOf(item)));
        patch({ items: [...(current().items || []).filter(item => engineOf(item) !== entry.key && !before.has(engineOf(item)) && !copyEngines.has(engineOf(item))), ...items, ...copied] });
        sync(true);
        return;
      }
      patch({ items: [...(current().items || []).filter(item => engineOf(item) !== entry.key), ...items] });
    } catch (error) {
      if (seq !== entry.readSeq || !alive(entry)) return;
      if (entry.local && !copiesKnown) { copiesKnown = true; sync(true); } // no copies to wait for: the other engines are read live
      if (!entry.local && isUnsupported(error)) { unsupported.set(entry.key, capabilitiesOf(entry.key)); drop(entry); patch(); return; }
      entry.error = error.message;
      if (!entry.loaded) entry.status = 'error';
      patch();
      // Another engine's list is read again later, each time later (as its stream reconnects); this machine's waits for its stream or Try again, as before.
      if (!entry.local) scheduleLoad(entry);
    }
  }
  function scheduleLoad(entry) {
    if (passive || entry.loadTimer || !alive(entry)) return;
    const wait = RETRY_MS[Math.min(entry.loadRetry, RETRY_MS.length - 1)];
    entry.loadRetry += 1;
    entry.loadTimer = setTimeout(() => { entry.loadTimer = 0; if (alive(entry)) void load(entry); }, wait);
  }

  function remind(change, entry) {
    const note = reminderFor(change);
    // A copy change that is history when it arrives (made more than a minute before: a device back online) is shown without a reminder.
    if (passive || !note || isOwn(change) || change.quiet === true) return;
    // With more than one engine every item names its engine, this machine's too, so a reminder reads the same on every engine's page: "<Status>:
    // <title> (K01) — <reason>".
    const engines = entries.size + copyEngines.size;
    const head = `${t(note.label)}: ${note.title}${engines > 1 ? ` (${engineName(engineOf(change.item)) || nameOf(entry)})` : ''}`;
    if (showsNotice(change)) ui.notify(note.reason ? `${head} — ${note.reason}` : head, note.status === 'failed' ? 'error' : 'info');
    if (prefs().sound) playSound();
  }

  function onChange(entry, message) {
    if (!alive(entry)) return;
    let change;
    try { change = JSON.parse(message.data); } catch { return; }
    // An owner went offline or came back (this machine's stream with copies): the list says so, read again.
    if (change && change.kind === 'owners') { if (entry.local) void load(entry); return; }
    if (!change || !change.item || change.item.id == null) return;
    const tag = item => (change.copy && item.owner ? tagCopy(item) : tagItem(item, entry.key));
    change = { ...change, item: tag(change.item), ...(change.previous ? { previous: tag(change.previous) } : {}) };
    if (change.copy && parked.some(item => engineOf(item) === engineOf(change.item))) { parked = applyChange(parked, change); return; }
    if (change.copy && !entries.has(engineOf(change.item)) && !copyEngines.has(engineOf(change.item))) {
      // An owner this page does not know yet (just linked): read the list, which names it.
      if (!owners.some(owner => owner.instance_id === change.item.owner)) void load(entry);
      return;
    }
    // A change queued here while its owner was offline that the owner had changed meanwhile: the owner's change stays, the page says so.
    if (Array.isArray(change.dropped_now) && change.dropped_now.length && !passive) ui.notify(`${t(`Not sent to ${engineName(engineOf(change.item))}`)}: ${change.item.title} — ${t('it was changed there in the meantime')}`, 'warning');
    // An update sent without `previous` is compared with the copy the page had (so a change of the order alone is never a reminder).
    const known = change.kind === 'updated' && !change.previous ? (current().items || []).find(item => keyOf(item) === keyOf(change.item)) : null;
    patch({ items: applyChange(current().items || [], change) });
    remind(known ? { ...change, previous: known } : change, entry);
  }

  function connect(entry) {
    clearTimeout(entry.timer);
    entry.timer = 0;
    if (!ES || entry.es || !alive(entry)) return;
    let es;
    const tab = entry.base === BASE && isTopPage();
    const query = [...(tab ? ['tab=1'] : []), ...(entry.local ? ['copies=1'] : [])].join('&');
    try { es = new ES(`${entry.base}/stream${query ? `?${query}` : ''}`); } catch { schedule(entry); return; }
    entry.es = es;
    es.addEventListener('change', message => onChange(entry, message));
    if (tab) {
      es.addEventListener('hello', message => {
        if (entry.es !== es) return;
        let data = null;
        try { data = JSON.parse(message.data); } catch { /* a broken message: no id */ }
        pageStream = data && typeof data.stream === 'string' ? data.stream : null;
        if (document.visibilityState === 'visible') reportSeen();
      });
      // The desktop window: a terminal (Open session) or a task's details (a click on a task).
      const on = (name, run) => es.addEventListener(name, message => {
        let data = null;
        try { data = JSON.parse(message.data); } catch { return; }
        if (entry.es === es && data) void Promise.resolve().then(() => run(data)).catch(() => {});
      });
      on('open-terminal', data => ui.actions.openTerminalLink({ sourceKey: String(data.engine || ''), taskId: Number(data.task_id), terminalId: String(data.terminal_id || '') }));
      on('open-item', data => ui.actions.openAttention({ item: String(data.key) }));
    }
    // Every (re)connection reads the list again: changes made while it was away are not replayed.
    es.addEventListener('open', () => {
      if (entry.es !== es) return;
      entry.retry = 0;
      entry.live = true;
      patch();
      if (Date.now() - entry.loadedAt > 1500) void load(entry);
    });
    es.addEventListener('error', () => {
      if (entry.es !== es) return;
      entry.live = false;
      patch();
      // A connection the browser gave up on (an HTTP error, a closed stream) is opened again here, later each time; else the browser retries itself.
      if (es.readyState === 2) { es.close(); entry.es = null; schedule(entry); }
    });
  }
  function schedule(entry) {
    if (!alive(entry) || entry.timer) return;
    const wait = RETRY_MS[Math.min(entry.retry, RETRY_MS.length - 1)];
    entry.retry += 1;
    entry.timer = setTimeout(() => { entry.timer = 0; connect(entry); }, wait);
  }
  // An engine that left the list (unlinked, hidden, offline, or without T-Attention): its stream and timers end and its items go.
  function drop(entry) {
    clearTimeout(entry.timer);
    clearTimeout(entry.loadTimer);
    entry.timer = entry.loadTimer = 0;
    if (entry.es) { entry.es.close(); entry.es = null; }
    entry.readSeq += 1;
    if (entries.get(entry.key) === entry) { const next = new Map(entries); next.delete(entry.key); entries = next; }
  }
  const start = entry => {
    if (passive) { if (current().open) void load(entry); return; }
    void load(entry);
    connect(entry);
  };

  // The engines follow h5.js: a service linked or removed, hidden or shown in the task list, offline or back, or one whose capabilities were read.
  // `force`: the copies changed (which engines they cover).
  function sync(force = false) {
    if (stopped) return;
    const sources = ui.get().sources;
    if (!force && sources === sourcesSeen && entries.size) return;
    const sourcesChanged = sources !== sourcesSeen;
    sourcesSeen = sources;
    for (const [key, capabilities] of [...unsupported]) if (capabilitiesOf(key) !== capabilities) unsupported.delete(key); // upgraded: tried again
    // The engines this machine keeps copies of are not read live; until its first list answered, no other engine is (it may cover them).
    const covered = coveredBy();
    const nextCopies = copyEnginesOf(sources);
    const copiesChanged = JSON.stringify([...nextCopies.values()]) !== JSON.stringify([...copyEngines.values()]);
    // A copy engine shown again (its device shown in the task list again): its items come with this machine's next list.
    const before = new Set(copyEngines.keys());
    const gained = copiesKnown && [...nextCopies.keys()].some(key => !before.has(key));
    copyEngines = nextCopies;
    const listed = attentionEngines(sources);
    let wanted = listed.filter(info => !unsupported.has(info.key) && (info.key === 'local' || (copiesKnown && !covered.has(info.key) && !(info.instanceId && covered.has(`id:${info.instanceId}`)))));
    // This machine's list is read also while it is hidden in the task list, for the copies it carries; its own items are then not shown (hidden).
    localHidden = !listed.some(info => info.key === 'local');
    if (localHidden) wanted = [{ key: 'local', local: true, label: 'This machine', name: ((sources || []).find(source => source && source.key === 'local') || {}).name || '' }, ...wanted];
    const keys = new Set(wanted.map(info => info.key));
    let changed = false;
    for (const entry of [...entries.values()]) if (!keys.has(entry.key)) { drop(entry); changed = true; }
    const next = new Map();
    const added = [];
    for (const info of wanted) {
      const kept = entries.get(info.key);
      if (kept) {
        if (kept.label !== info.label || kept.name !== info.name || kept.instanceId !== info.instanceId) changed = true;
        next.set(info.key, Object.assign(kept, info));
      } else { const entry = make(info); next.set(info.key, entry); added.push(entry); }
    }
    if ([...next.keys()].join('\n') !== [...entries.keys()].join('\n')) changed = true;
    entries = next;
    if (changed || added.length || copiesChanged || (force && !sourcesChanged)) patch();
    for (const entry of added) start(entry);
    if (gained) {
      // Copies parked by the last list: shown now; an engine shown again after it was hidden: read again (its copies may have changed meanwhile).
      const back = parked.filter(item => copyEngines.has(engineOf(item)));
      const fromList = new Set(back.map(item => engineOf(item)));
      parked = parked.filter(item => !copyEngines.has(engineOf(item)));
      if (back.length) patch({ items: [...(current().items || []).filter(item => !fromList.has(engineOf(item))), ...back] });
      if ([...nextCopies.keys()].some(key => !before.has(key) && !fromList.has(key)) && entries.get('local')) void load(entries.get('local'));
    }
  }

  // The page shown again: read the lists (the phone may have slept) and connect at once where the stream is gone.
  document.addEventListener('visibilitychange', () => {
    if (passive || document.visibilityState !== 'visible') return;
    reportSeen();
    for (const entry of entries.values()) {
      void load(entry);
      if (!entry.es) { entry.retry = 0; connect(entry); }
    }
  });
  // Browsers start audio suspended until a gesture: the first tap of the page wakes the context (only when sound is on).
  const wake = () => { if (prefs().sound) { const ctx = context(); if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {}); } };
  document.addEventListener('pointerdown', wake, { once: true, capture: true });

  // ── Actions of the panel ──
  // Every action names its item by its key ('local:5', 'remote:7:5'; a bare id is an item of this machine) and goes to that item's own engine.
  const target = ref => {
    const parsed = parseKey(ref);
    if (!parsed) throw new Error('Unknown task');
    return { ...parsed, key: itemKey(parsed.engine, parsed.id), url: `${baseOf(parsed.engine)}/${encodeURIComponent(parsed.id)}` };
  };
  const blur = () => { const el = document.activeElement; if (el && el !== document.body && typeof el.blur === 'function') el.blur(); };
  const loadAll = ({ notReady = false } = {}) => Promise.all([...entries.values()].filter(entry => !notReady || entry.status !== 'ready').map(entry => load(entry)));
  // The control that opened the side sheet of a wide screen: the focus goes back to it when the sheet closes, if it is still there and the person
  // has not put the focus somewhere else meanwhile.
  let opener = null;
  ui.actions.openAttention = ({ item = null } = {}) => {
    const state = ui.get();
    if (state.wide && !current().open) { const active = document.activeElement; opener = active && active !== document.body ? active : null; }
    blur();
    // A wide screen shows one of them at a time: the file viewer and the file tree make way.
    if (state.wide) {
      if (state.design && state.design.open && ui.actions.closeDesign) ui.actions.closeDesign();
      if (state.files && state.files.open && ui.actions.closeFiles) ui.actions.closeFiles();
    }
    patch({ open: true, focus: item });
    void loadAll({ notReady: true });
  };
  ui.actions.closeAttention = () => {
    const back = opener;
    opener = null;
    const wasOpen = Boolean(current().open);
    patch({ open: false, focus: null });
    if (!wasOpen || !ui.get().wide || !back || !back.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('#h5-attention-sheet')) return;
    back.focus({ preventScroll: true });
  };
  ui.actions.toggleAttention = () => {
    const state = ui.get();
    if (state.wide && state.attention && state.attention.open) ui.actions.closeAttention();
    else ui.actions.openAttention();
  };
  ui.actions.attentionReload = () => loadAll();
  const replace = item => patch({ items: applyChange(current().items || [], { kind: 'updated', item }) });
  // A new task on `engine` (this machine unless another engine of the list is named).
  ui.actions.attentionCreate = async (body, engine = 'local') => {
    const raw = await api('POST', baseOf(engine), body);
    const item = tagItem(raw, engine);
    markOwn(keyOf(item));
    if (item && item.id != null) patch({ items: applyChange(current().items || [], { kind: 'created', item }) });
    return item;
  };
  // The answer for the item of a copy: the copy itself while its owner is offline (with `pending`), else the owner's item, which keeps the copy's
  // marks until the copy arrives.
  const asShown = (raw, engine, key) => {
    const before = (current().items || []).find(item => keyOf(item) === key);
    const item = raw && raw.copy && raw.owner ? tagCopy(raw) : tagItem(raw, engine);
    return before && before.copy && item && !item.copy ? { ...item, copy: true, owner: before.owner, owner_name: before.owner_name, owner_engine: before.owner_engine, pending: [], dropped: before.dropped || [] } : item;
  };
  ui.actions.attentionUpdate = async (ref, body) => {
    const { engine, key, url } = target(ref);
    markOwn(key);
    const item = asShown(await api('PATCH', url, body), engine, key);
    markOwn(key);
    if (item && item.id != null) replace(item);
    return item;
  };
  // The note of a change that was not sent (it was dropped): read, so it goes.
  ui.actions.attentionDismiss = id => api('DELETE', `${BASE}/copies/queue/${encodeURIComponent(id)}`);
  // Move a task (POST <engine>/:id/move, body { before | after | position, status?, reason? }, ids of the same engine): the answer's `item` and `items`
  // (every task whose order changed) replace the page's copies. An engine without /move (404 / 405) is put in `noMove`, and the panel stops offering
  // the drag for its rows.
  ui.actions.attentionMove = async (ref, body) => {
    const { engine, key, url } = target(ref);
    markOwn(key);
    let data;
    try { data = await api('POST', `${url}/move`, body); }
    catch (error) {
      if ((error.status === 404 && !(error.data && error.data.error === 'NOT_FOUND')) || error.status === 405) {
        const noMove = Array.isArray(current().noMove) ? current().noMove : [];
        if (!noMove.includes(engine)) patch({ noMove: [...noMove, engine] });
      }
      throw error;
    }
    let items = current().items || [];
    for (const raw of [...(Array.isArray(data && data.items) ? data.items : []), ...(data && data.item ? [data.item] : [])]) {
      const item = tagItem(raw, engine);
      if (item && item.id != null) { markOwn(keyOf(item)); items = applyChange(items, { kind: 'updated', item }); }
    }
    patch({ items });
    return data;
  };
  // The panel's own copy of the list while a request is on its way (a move or a row button shown at once), and putting it back when it failed.
  ui.actions.attentionShow = items => patch({ items });
  ui.actions.attentionDelete = async ref => {
    const { key, url } = target(ref);
    markOwn(key);
    await api('DELETE', url);
    patch({ items: (current().items || []).filter(item => keyOf(item) !== key) });
  };
  ui.actions.attentionDetail = ref => api('GET', target(ref).url);
  // The engine entry of an item's engine (its tag, and whether its items are copies as of a time).
  ui.actions.attentionEngine = key => copyEngines.get(key) || null;
  // A new AI summary (the engine writes it into context.summary later and sends a change event; session only).
  ui.actions.attentionSummarize = ref => api('POST', `${target(ref).url}/summarize`, {});
  // Settings (AttentionSettings.jsx): the sound.
  ui.actions.attentionPrefs = () => prefs();
  ui.actions.attentionSetSound = on => { write(SOUND_KEY, on ? null : '0'); if (on) playSound(); };

  // A wide screen shows one of them at a time: a file viewer or file tree that opens while this panel is open takes its place.
  const others = s => Boolean((s.design && s.design.open) || (s.files && s.files.open));
  let otherOpen = others(ui.get());
  ui.subscribe(() => {
    const s = ui.get();
    const now = others(s);
    if (now && !otherOpen && s.wide && s.attention && s.attention.open) ui.actions.closeAttention();
    otherOpen = now;
    if (s.sources !== sourcesSeen) sync();
  });

  sync();
  return {
    stop() { stopped = true; for (const entry of entries.values()) { clearTimeout(entry.timer); clearTimeout(entry.loadTimer); if (entry.es) entry.es.close(); entry.es = null; } },
    load: () => loadAll(),
  };
}

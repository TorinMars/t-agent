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
import { applyChange, attentionEngines, engineOf, itemKey, keyOf, needsCount, parseKey, reminderFor, showsNotice, tagItem } from './attention-model.mjs';

export const BASE = '/api/attention';
// The API of an engine's T-Attention: this machine's own, or a connected service's through this Client's proxy (h5.js names it 'remote:<id>').
export const baseOf = engine => (!engine || engine === 'local' ? BASE : `/api/remote-servers/${String(engine).replace(/^remote:/, '')}/attention`);
const LIST_QUERY = '?include_done=1&limit=200';
const OWN_MS = 8000; // a change event for a task this page changed within this time, made by 'user', is this page's own
const RETRY_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const SOUND_KEY = 'h5-attention-sound'; // '0' = off (default on). An old 'h5-attention-notify' value (system notifications, removed) is ignored.

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* not remembered */ } };

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
  let entries = new Map(); // engine key -> its entry, in the order of the list (this machine first)
  const unsupported = new Map(); // engine key -> its capabilities when it answered 501: left out until they change
  let sourcesSeen; // the `state.sources` the entries were made from
  let stopped = false;

  const current = () => ui.get().attention || {};
  const alive = entry => !stopped && entries.get(entry.key) === entry;
  const nameOf = entry => (entry.local ? entry.name || t('This machine') : entry.label || entry.key);
  // The state of the panel from the entries: the overall status (ready once any engine answered), live (every engine that answered is connected), the
  // engines shown (`engines`, for the tags, the order and "on <engine>"; the colour of a tag comes from the instance id h5.js knows, else the one the
  // engine's list answered with) and the ones that failed (`failed`, only when there is more than one).
  const patch = (next = {}) => ui.set(state => {
    const attention = { ...(state.attention || {}), ...next };
    const list = [...entries.values()];
    const ready = list.filter(entry => entry.status === 'ready');
    attention.status = ready.length ? 'ready' : list.some(entry => entry.status === 'loading') ? 'loading' : list.some(entry => entry.status === 'error') ? 'error' : (attention.status || 'idle');
    attention.live = ready.length > 0 && ready.every(entry => entry.live);
    attention.engines = list.map(entry => ({ key: entry.key, local: entry.local, label: entry.label, name: entry.name, instanceId: entry.instanceId || entry.instance || null, host: entry.host, ready: entry.status === 'ready' }));
    attention.failed = list.length > 1 ? list.filter(entry => entry.status === 'error').map(entry => ({ key: entry.key, name: nameOf(entry) })) : [];
    const local = entries.get('local');
    attention.host = local ? local.host : null;
    attention.error = local ? local.error : null;
    if (Array.isArray(attention.items)) attention.items = attention.items.filter(item => entries.has(engineOf(item)));
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

  const make = info => ({ ...info, base: baseOf(info.key), status: 'idle', loaded: false, error: null, host: null, live: false, es: null, retry: 0, timer: 0, loadTimer: 0, loadRetry: 0, readSeq: 0, loadedAt: 0 });
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
      const data = await api('GET', `${entry.base}${LIST_QUERY}`);
      if (seq !== entry.readSeq || !alive(entry)) return;
      const items = (Array.isArray(data && data.items) ? data.items : []).filter(item => item && item.id != null).map(item => tagItem(item, entry.key));
      Object.assign(entry, { loaded: true, status: 'ready', error: null, loadRetry: 0, host: data && typeof data.host === 'string' ? data.host : null, instance: data && typeof data.instance_id === 'string' ? data.instance_id : null });
      patch({ items: [...(current().items || []).filter(item => engineOf(item) !== entry.key), ...items] });
    } catch (error) {
      if (seq !== entry.readSeq || !alive(entry)) return;
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
    if (passive || !note || isOwn(change)) return;
    // An item of another engine names it: "<Status>: <title> (K01) — <reason>".
    const head = `${t(note.label)}: ${note.title}${entry.local ? '' : ` (${nameOf(entry)})`}`;
    if (showsNotice(change)) ui.notify(note.reason ? `${head} — ${note.reason}` : head, note.status === 'failed' ? 'error' : 'info');
    if (prefs().sound) playSound();
  }

  function onChange(entry, message) {
    if (!alive(entry)) return;
    let change;
    try { change = JSON.parse(message.data); } catch { return; }
    if (!change || !change.item || change.item.id == null) return;
    change = { ...change, item: tagItem(change.item, entry.key), ...(change.previous ? { previous: tagItem(change.previous, entry.key) } : {}) };
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
    try { es = new ES(`${entry.base}/stream`); } catch { schedule(entry); return; }
    entry.es = es;
    es.addEventListener('change', message => onChange(entry, message));
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
  function sync() {
    if (stopped) return;
    const sources = ui.get().sources;
    if (sources === sourcesSeen && entries.size) return;
    sourcesSeen = sources;
    for (const [key, capabilities] of [...unsupported]) if (capabilitiesOf(key) !== capabilities) unsupported.delete(key); // upgraded: tried again
    const wanted = attentionEngines(sources).filter(info => !unsupported.has(info.key));
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
    if (changed || added.length) patch();
    for (const entry of added) start(entry);
  }

  // The page shown again: read the lists (the phone may have slept) and connect at once where the stream is gone.
  document.addEventListener('visibilitychange', () => {
    if (passive || document.visibilityState !== 'visible') return;
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
  ui.actions.openAttention = ({ item = null } = {}) => {
    blur();
    const state = ui.get();
    // A wide screen shows one of them at a time: the file viewer and the file tree make way.
    if (state.wide) {
      if (state.design && state.design.open && ui.actions.closeDesign) ui.actions.closeDesign();
      if (state.files && state.files.open && ui.actions.closeFiles) ui.actions.closeFiles();
    }
    patch({ open: true, focus: item });
    void loadAll({ notReady: true });
  };
  ui.actions.closeAttention = () => patch({ open: false, focus: null });
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
  ui.actions.attentionUpdate = async (ref, body) => {
    const { engine, key, url } = target(ref);
    markOwn(key);
    const item = tagItem(await api('PATCH', url, body), engine);
    markOwn(key);
    if (item && item.id != null) replace(item);
    return item;
  };
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

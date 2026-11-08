// The live side of T-Attention on the page (started once by entry.jsx, before the panel is ever opened, so the "Needs you" badge and the reminders
// work from the start): reads the list (GET /api/attention), follows GET /api/attention/stream (server-sent events, event 'change'), keeps
// `state.attention` in the store and registers the actions the panel (Attention.jsx) and the Settings group (AttentionSettings.jsx) call.
// Reminders: a change that moves a task INTO waiting_user, failed or review gives a toast (not for a plain Claude turn end, showsNotice), a system notification (only when the user enabled it in
// Settings and the browser granted it) and a short sound made with WebAudio (no audio file; on by default, off in Settings). A change this page made
// itself (the user's own tap here) gives none.
import { applyChange, needsCount, reminderFor, showsNotice } from './attention-model.mjs';

export const BASE = '/api/attention';
const LIST_URL = `${BASE}?include_done=1&limit=200`;
const OWN_MS = 8000; // a change event for a task this page changed within this time, made by 'user', is this page's own
const RETRY_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const SOUND_KEY = 'h5-attention-sound'; // '0' = off (default on)
const NOTIFY_KEY = 'h5-attention-notify'; // '1' = system notifications on (default off; needs the browser's permission)

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* not remembered */ } };

export function prefs() {
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  return { sound: read(SOUND_KEY) !== '0', notify: read(NOTIFY_KEY) === '1' && permission === 'granted', permission };
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

// A system notification: the Notification constructor where it works, else the page's service worker (Android Chrome has no constructor).
export function showSystemNotification(title, body, { tag, onClick } = {}) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const options = { body, tag, icon: '/icons/icon-192.png' };
  try {
    const shown = new Notification(title, options);
    shown.onclick = () => { try { window.focus(); } catch { /* no focus */ } if (onClick) onClick(); shown.close(); };
    return true;
  } catch {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then(reg => reg.showNotification(title, options)).catch(() => {});
    return true;
  }
}

export function startAttentionFeed(ui, { t = text => text, api, EventSourceImpl } = {}) {
  const ES = EventSourceImpl || (typeof EventSource === 'undefined' ? null : EventSource);
  const own = new Map(); // id -> time until which a 'user' change of it is this page's own
  let source = null;
  let retry = 0;
  let timer = 0;
  let readSeq = 0;
  let stopped = false;

  const current = () => ui.get().attention || {};
  const patch = next => ui.set(state => {
    const attention = { ...(state.attention || {}), ...next };
    attention.needs = needsCount(attention.items);
    return { attention };
  });
  const markOwn = id => { if (id != null) own.set(id, Date.now() + OWN_MS); };
  const isOwn = change => {
    const id = change.item && change.item.id;
    const until = own.get(id);
    if (!until) return false;
    if (until < Date.now()) { own.delete(id); return false; }
    const actor = change.event && change.event.actor;
    return !actor || actor === 'user';
  };

  let loadedAt = 0;
  async function load() {
    const seq = ++readSeq;
    loadedAt = Date.now();
    if (!current().items) patch({ status: 'loading' });
    try {
      const data = await api('GET', LIST_URL);
      if (seq !== readSeq) return;
      patch({ status: 'ready', items: Array.isArray(data && data.items) ? data.items : [], host: data && typeof data.host === 'string' ? data.host : null, error: null });
    } catch (error) {
      if (seq !== readSeq) return;
      patch({ status: current().items ? 'ready' : 'error', error: error.message });
    }
  }

  function remind(change) {
    const note = reminderFor(change);
    if (!note || isOwn(change)) return;
    const head = `${t(note.label)}: ${note.title}`;
    if (showsNotice(change)) ui.notify(note.reason ? `${head} — ${note.reason}` : head, note.status === 'failed' ? 'error' : 'info');
    const settings = prefs();
    if (settings.notify) showSystemNotification(`T-Attention · ${t(note.label)}`, note.reason ? `${note.title}\n${note.reason}` : note.title, { tag: `attention-${note.id}`, onClick: () => ui.actions.openAttention({ item: note.id }) });
    if (settings.sound) playSound();
  }

  function onChange(message) {
    let change;
    try { change = JSON.parse(message.data); } catch { return; }
    if (!change || !change.item) return;
    patch({ items: applyChange(current().items || [], change) });
    remind(change);
  }

  function connect() {
    clearTimeout(timer);
    timer = 0;
    if (stopped || !ES || source) return;
    let es;
    try { es = new ES(`${BASE}/stream`); } catch { schedule(); return; }
    source = es;
    es.addEventListener('change', onChange);
    // Every (re)connection reads the list again: changes made while it was away are not replayed.
    es.addEventListener('open', () => { retry = 0; patch({ live: true }); if (Date.now() - loadedAt > 1500) void load(); });
    es.addEventListener('error', () => {
      patch({ live: false });
      // A connection the browser gave up on (an HTTP error, a closed stream) is opened again here, later each time; else the browser retries itself.
      if (es.readyState === 2) { es.close(); if (source === es) source = null; schedule(); }
    });
  }
  function schedule() {
    if (stopped || timer) return;
    const wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
    retry += 1;
    timer = setTimeout(() => { timer = 0; connect(); }, wait);
  }

  // The page shown again: read the list (the phone may have slept) and connect at once when the stream is gone.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void load();
    if (!source) { retry = 0; connect(); }
  });
  // Browsers start audio suspended until a gesture: the first tap of the page wakes the context (only when sound is on).
  const wake = () => { if (prefs().sound) { const ctx = context(); if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {}); } };
  document.addEventListener('pointerdown', wake, { once: true, capture: true });

  // ── Actions of the panel ──
  const blur = () => { const el = document.activeElement; if (el && el !== document.body && typeof el.blur === 'function') el.blur(); };
  ui.actions.openAttention = ({ item = null } = {}) => {
    blur();
    const state = ui.get();
    // A wide screen has one panel on the right: the file viewer and the file tree make way.
    if (state.wide) {
      if (state.design && state.design.open && ui.actions.closeDesign) ui.actions.closeDesign();
      if (state.files && state.files.open && ui.actions.closeFiles) ui.actions.closeFiles();
    }
    patch({ open: true, focus: item });
    if (current().status !== 'ready') void load();
  };
  ui.actions.closeAttention = () => patch({ open: false, focus: null });
  ui.actions.toggleAttention = () => {
    const state = ui.get();
    if (state.wide && state.attention && state.attention.open) ui.actions.closeAttention();
    else ui.actions.openAttention();
  };
  ui.actions.attentionReload = () => load();
  const replace = item => patch({ items: applyChange(current().items || [], { kind: 'updated', item }) });
  ui.actions.attentionCreate = async body => {
    const item = await api('POST', BASE, body);
    markOwn(item && item.id);
    if (item && item.id != null) patch({ items: applyChange(current().items || [], { kind: 'created', item }) });
    return item;
  };
  ui.actions.attentionUpdate = async (id, body) => {
    markOwn(id);
    const item = await api('PATCH', `${BASE}/${encodeURIComponent(id)}`, body);
    markOwn(id);
    if (item && item.id != null) replace(item);
    return item;
  };
  ui.actions.attentionDelete = async id => {
    markOwn(id);
    await api('DELETE', `${BASE}/${encodeURIComponent(id)}`);
    patch({ items: (current().items || []).filter(item => item.id !== id) });
  };
  ui.actions.attentionDetail = id => api('GET', `${BASE}/${encodeURIComponent(id)}`);
  // A new AI summary (the server writes it into context.summary later and sends a change event; session only).
  ui.actions.attentionSummarize = id => api('POST', `${BASE}/${encodeURIComponent(id)}/summarize`, {});
  // Settings (AttentionSettings.jsx): sound, system notifications.
  ui.actions.attentionPrefs = () => prefs();
  ui.actions.attentionSetSound = on => { write(SOUND_KEY, on ? null : '0'); if (on) playSound(); };
  ui.actions.attentionSetNotify = async on => {
    if (!on) { write(NOTIFY_KEY, null); return prefs(); }
    if (typeof Notification === 'undefined') return prefs();
    let permission = Notification.permission;
    if (permission === 'default' && Notification.requestPermission) permission = await Notification.requestPermission();
    write(NOTIFY_KEY, permission === 'granted' ? '1' : null);
    return prefs();
  };
  ui.actions.attentionTestNotify = () => showSystemNotification(`T-Attention · ${t('Test')}`, t('System notifications work'), { tag: 'attention-test' });

  // A wide screen has one panel on the right: a file viewer or file tree that opens while this panel is open takes its place.
  const others = s => Boolean((s.design && s.design.open) || (s.files && s.files.open));
  let otherOpen = others(ui.get());
  ui.subscribe(() => {
    const s = ui.get();
    const now = others(s);
    if (now && !otherOpen && s.wide && s.attention && s.attention.open) ui.actions.closeAttention();
    otherOpen = now;
  });

  void load();
  connect();
  return { stop() { stopped = true; clearTimeout(timer); if (source) source.close(); source = null; }, load };
}

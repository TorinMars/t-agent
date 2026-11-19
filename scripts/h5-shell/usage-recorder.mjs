// The recorder of usage data ("Usage data" in docs/design/usage-data.md), loaded on demand by usage-track.mjs once the server said that recording is
// on: it turns a press into an event, buffers the events and sends them in batches to POST /api/ui-events, and tells the server which controls the
// page shows (for "Not used in 30 days").
// PRIVACY: an event names a control by its stable identity (data-track, id, data-action, a few fixed data-* attributes, or the project's class name
// with its role), never by its visible text or aria-label: those can hold task, session or file names. No input value, path or terminal text is read.
// The pure part (controlOf, identityOf, surfaceOf, cleanId) takes DOM elements and only calls closest(), getAttribute() and classList: no layout reads,
// so a click is never slowed down.

// Button-like controls. A Switch or Checkbox counts by its input (the click of its label row reaches the input too, so it is counted once).
export const CONTROL = 'button,[role=button],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=switch],'
  + 'input[type=checkbox],input[type=radio],a.MuiButtonBase-root,label.MuiButtonBase-root,.MuiButtonBase-root';
// Fixed data-* attributes whose values are product strings (key names, views, filters), used as `<prefix>:<value>` when there is no id.
const DATA_KEYS = [['data-key', 'key'], ['data-modifier', 'mod'], ['data-shortcut', 'shortcut'], ['data-view', 'view'], ['data-filter', 'filter'], ['data-group', 'group'], ['data-cols', 'cols']];
// Ids that end in a name of something (a skill, a plugin, a notifier): only the part before the name is kept.
const NAMED_TAIL = ['h5-agent-skill-install-', 'h5-agent-skill-', 'h5-plugin-login-', 'h5-plugins-tab-', 'h5-notify-mode-'];
const VALUE = /^[A-Za-z0-9_.-]{1,32}$/;
const DETAIL = /^[\x20-\x7e]{1,48}$/; // printable ASCII: a command of commands.mjs, a key combination, a fixed menu label

// An id that is stable and says nothing about the person's content, or null: React / MUI generated ids are refused, a run of hex with digits (a uuid)
// becomes `*`, a number between dashes `#` (`h5-settings-tab-3` -> `h5-settings-tab-#`), and a name at the end of a known id is cut.
export function cleanId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z][\w-]{0,79}$/.test(id) || /^mui-/i.test(id)) return null;
  const tail = NAMED_TAIL.find(prefix => id.startsWith(prefix) && id.length > prefix.length);
  if (tail) return `${tail}*`;
  return id.replace(/[0-9a-f]+(?:-[0-9a-f]+)*/gi, run => (run.length >= 8 && /\d/.test(run) ? '*' : run)).replace(/(^|[-_])\d+(?=[-_]|$)/g, '$1#').slice(0, 64);
}
const value = (el, name) => { const v = el.getAttribute(name); return v && VALUE.test(v) ? v : null; };
const tagRole = el => {
  const role = el.getAttribute('role');
  if (role && /^[a-z]{1,24}$/.test(role)) return role;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input') return el.getAttribute('type') === 'radio' ? 'radio' : 'checkbox';
  return tag === 'a' ? 'link' : 'button';
};
const projectClass = el => {
  for (const name of el.classList || []) if (/^h5-[a-z0-9-]{1,48}$/.test(name)) return name;
  return null;
};

// The round part of an MUI Switch, Checkbox or Radio is a ButtonBase around the real input: the input is the control.
const inputOf = el => (el.matches('.MuiSwitch-switchBase,.MuiCheckbox-root,.MuiRadio-root') && el.querySelector('input')) || el;

// The control a click or key landed on, or null (text, the terminal, a disabled control).
export function controlOf(target) {
  let el = target && target.closest ? target.closest(CONTROL) : null;
  if (el) el = inputOf(el);
  // A character key of the on-screen keyboard (Osk.jsx, data-char) is typing: never recorded, not even as a count.
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-char')) return null;
  return el;
}

// { key, detail, source } of a control. source: 'track' | 'id' | 'action' | 'data' | 'class' (its own project class) | 'ancestor' (the closest
// project class above it, with its role) | 'role' (nothing better: the role alone). The last three are the fallbacks.
export function identityOf(el) {
  const raw = el.getAttribute('data-track-detail');
  const detail = raw && DETAIL.test(raw) ? raw : null;
  const track = cleanId(el.getAttribute('data-track'));
  if (track) return { key: track, detail, source: 'track' };
  const id = cleanId(el.id);
  if (id) return { key: id, detail, source: 'id' };
  const action = value(el, 'data-action');
  if (action) return { key: `action:${action}`, detail, source: 'action' };
  for (const [name, prefix] of DATA_KEYS) { const v = value(el, name); if (v) return { key: `${prefix}:${v}`, detail, source: 'data' }; }
  const own = projectClass(el);
  if (own) return { key: own, detail, source: 'class' };
  let up = el.parentElement;
  for (let depth = 0; up && depth < 8; depth += 1, up = up.parentElement) {
    const upId = cleanId(up.id);
    const name = projectClass(up) || (upId && upId.startsWith('h5-') ? upId : null); // a menu or dialog of the page has an id, not a class
    if (name) return { key: `${name}/${tagRole(el)}`, detail, source: 'ancestor' };
  }
  return { key: tagRole(el), detail, source: 'role' };
}

// Where a control is: a small fixed set (docs/design/usage-data.md "Surfaces"). The first rule that holds wins; portals (menus, dialogs) are at the
// end of <body>, so they never lie inside another surface.
const SURFACES = [
  ['#h5-switcher', 'switcher'], ['#h5-columns-nav', 'rail'], ['#h5-bnav', 'bottom-nav'], ['.h5-add-menu', 'menu:commands'], ['#h5-keys', 'key-row'],
  ['#h5-osk', 'keyboard'], ['#h5-attention-sheet', 'attention'], ['#h5-design-sheet', 'design'], ['#h5-files-sheet', 'files'], ['#h5-mindmap,#h5-columns-maps-view', 'maps'],
  ['#h5-agent', 'chat'], ['#h5-term-menu,#h5-session-menu', 'task-menu'],
];
const portalSurface = (el, selector, kind) => {
  const root = el.closest(selector);
  if (!root) return null;
  const id = cleanId(root.id);
  return id ? `${kind}:${id.replace(/^h5-/, '')}` : kind;
};
export function surfaceOf(el) {
  const settings = el.closest('#h5-settings,#h5-settings-page');
  if (settings) {
    const group = el.closest('.h5-setting-group');
    const name = group && value(group, 'data-group');
    return name ? `settings:${name}` : 'settings';
  }
  for (const [selector, name] of SURFACES) if (el.closest(selector)) return name;
  const portal = portalSurface(el, '.MuiMenu-root,.MuiPopover-root', 'menu') || portalSurface(el, '.MuiDialog-root', 'dialog');
  if (portal) return portal;
  if (el.closest('#h5-tasks')) return 'task-list';
  if (el.closest('#h5-bottom')) return el.closest('#h5-actions') && !el.closest('[data-single],[data-compact]') ? 'tool-row' : 'bottom-row';
  if (el.closest('.h5-header')) return 'header';
  if (el.closest('#h5-columns')) return 'columns';
  if (el.closest('.MuiSnackbar-root')) return 'notice';
  return 'page';
}

// The new state of a switch, a checkbox or a toggle button after this click ('on' / 'off'), or null. In the capture phase a checkbox input already
// holds its new value; an aria-checked / aria-pressed control is changed by its handler afterwards, so its new state is the opposite.
export function stateOf(el) {
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input') return el.checked ? 'on' : 'off';
  const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed');
  if (aria === 'true') return 'off';
  if (aria === 'false') return 'on';
  return null;
}

// The context of the page at the moment of the event, from the store (no DOM): the view, the layout, the input mode, pane or not, and whether the
// shown session is on this machine or on another one (never its name).
export function contextOf(s) {
  const columns = s.columns && s.columns.shown ? s.columns.tab || 'columns' : null;
  return {
    view: columns === 'maps' || (!columns && s.mindmapOpen) ? 'maps' : columns ? 'columns' : 'sessions',
    layout: s.wide ? 'wide' : 'narrow',
    input: s.input === 'pointer' ? 'pointer' : 'touch',
    pane: Boolean(s.pane),
    device: !s.sourceKey || s.sourceKey === 'local' ? 'local' : 'remote',
  };
}

// The event of one activation, or null for anything that is not a control.
export function eventOf(target, s, now = Date.now()) {
  const el = controlOf(target);
  if (!el) return null;
  const { key, detail } = identityOf(el);
  const event = { at: now, key, surface: surfaceOf(el), ...contextOf(s) };
  if (detail) event.detail = detail;
  const state = stateOf(el);
  if (state) event.state = state;
  return event;
}

const NATIVE = /^(BUTTON|A|INPUT|SELECT|SUMMARY|TEXTAREA)$/; // Enter / Space on these fire a click by themselves
const EDITABLE = el => el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset)$/.test(el.type));
export const BATCH = 50;
export const FLUSH_MS = 10000;
const SEEN_MAX = 200;

// The event of a press that usage-track.mjs heard ({ type: 'click' | 'keydown', target, s: the state then, at }), or null. Enter / Space count only on a
// control that is not a native button: MUI calls the onClick of a list row, a menu item or a tab without a DOM click.
export function eventOfPress({ type, target, s, at }) {
  if (!target || !target.closest) return null;
  if (type === 'keydown' && (NATIVE.test(target.tagName) || EDITABLE(target))) return null;
  return eventOf(target, s, at);
}

// Starts the recorder. `ui` is the store; `url` the route. Returns { press, stop }: `press` takes one press, `stop` drops what is buffered (the switch
// was turned off). While stopped nothing is buffered, scanned or sent.
export function startRecorder(ui, { doc = document, win = window, url = '/api/ui-events' } = {}) {
  const page = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let events = [];
  let seen = [];
  const known = new Set();
  let timer = 0;
  let scanTimer = 0;
  let stopped = false;
  const body = () => {
    const batch = { page, sent: Date.now(), events, seen };
    events = [];
    seen = [];
    return JSON.stringify(batch);
  };
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (stopped || (!events.length && !seen.length)) return;
    win.fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body() })
      .then(res => (res.ok ? res.json() : null)).then(answer => { if (answer && answer.enabled === false) ui.set({ usageRecording: false }); })
      .catch(() => { /* lost: usage data is best effort */ });
  };
  const later = () => { if (!timer) timer = setTimeout(flush, FLUSH_MS); };
  // The controls on screen, so "Not used in 30 days" knows what exists: in an idle moment, after the start and after each press (which often opens
  // a menu or a dialog). Only combinations not sent yet from this page go out.
  const scan = () => {
    scanTimer = 0;
    if (stopped) return;
    const layout = ui.get().wide ? 'wide' : 'narrow';
    for (const el of doc.querySelectorAll(CONTROL)) {
      if (seen.length >= SEEN_MAX) break;
      const control = inputOf(el); // a disabled control is shown too, so it counts as seen
      if (control.hasAttribute('data-char')) continue;
      const entry = { key: identityOf(control).key, surface: surfaceOf(control), layout };
      const id = `${entry.key}|${entry.surface}|${layout}`;
      if (!known.has(id)) { known.add(id); seen.push(entry); }
    }
    if (seen.length) later();
  };
  const idle = win.requestIdleCallback ? fn => win.requestIdleCallback(fn, { timeout: 5000 }) : fn => setTimeout(fn, 200);
  const scanSoon = (ms = 1500) => { if (!scanTimer) scanTimer = setTimeout(() => idle(scan), ms); };
  const press = item => {
    if (stopped) return;
    const event = eventOfPress(item);
    if (!event) return;
    events.push(event);
    if (events.length >= BATCH) flush(); else later();
    scanSoon();
  };
  // The page goes away or into the background: what is buffered goes with a beacon (it survives the unload).
  const leave = () => {
    if (stopped || (!events.length && !seen.length)) return;
    clearTimeout(timer);
    timer = 0;
    try { if (!win.navigator.sendBeacon(url, new Blob([body()], { type: 'application/json' }))) throw new Error('refused'); } catch { /* lost */ }
  };
  win.addEventListener('pagehide', leave);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') leave(); });
  scanSoon(3000);
  return {
    press, flush, scan, page,
    stop() { stopped = true; events = []; seen = []; known.clear(); clearTimeout(timer); timer = 0; },
    resume() { if (stopped) { stopped = false; scanSoon(3000); } },
  };
}

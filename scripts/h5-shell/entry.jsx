// The Material UI shell of the phone page (/h5). It is drawn at once, while the page is still being parsed (flushSync), so that the scripts after it
// (voice-input.js, h5.js ...) find #h5-translate-input, #h5-voice and the rest where they have always been.
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createStore, initialState } from './store.mjs';
import { createBackLayers } from './back.mjs';
import { startAttentionFeed } from './attention-feed.mjs';
import { startPlanUsage } from './plan-usage-feed.mjs';
import { detectPane, paneKeyPrefix, startPane } from './pane.mjs';
import { api, t } from './common.jsx';
import { onShared, readShared, writeShared } from './shared-store.mjs';
import { localGet } from './local-keys.mjs';
import { RAW_KINDS, kindOf } from './file-kinds.mjs';
import { arrangeTasks, mergeOrder, moveKey, sameOrder, stepTarget } from './task-order.mjs';
import { orderDevices } from './device-order.mjs';
import { RECENT_MAX, editRecent, noteRecent, parseRecent, pruneRecent, recentKey } from './recent-sessions.mjs';
import { startColumns } from './Columns.jsx';
// T-Attention settings slots: the modules of other T-Attention parts that register Settings content (attention-slots.mjs) are imported by the Settings
// chunk (screen-settings.jsx), which is loaded when Settings first opens (lazy-screens.jsx).
import { preloadOnIntent } from './lazy-screens.jsx';
import { startUsageTracking } from './usage-track.mjs';

// One breakpoint for the shell and for h5.js (which reads it from `H5UI.media.wideQuery`), so the two can never disagree.
const wideQuery = window.matchMedia('(min-width: 900px)');
// The input mode is separate from the width and never read from the user agent: 'pointer' when the main pointer is fine and can hover and no coarse
// pointer (a touch screen) exists at all, else 'touch'. An iPad with a trackpad still reports a coarse pointer, so it stays 'touch'.
const fineQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
const coarseQuery = window.matchMedia('(any-pointer: coarse)');
const inputMode = () => (fineQuery.matches && !coarseQuery.matches ? 'pointer' : 'touch');
// Pane mode (pane.mjs): this page is one column of the multi-column view. Decided once, before anything is read from storage.
const paneId = detectPane(window);
// The layout of this view: per pane (a pane key stays in this browser); the top page's is the person's, the same on every device and engine (the
// shared page state, shared-store.mjs).
const SIDEBAR_KEY = `${paneId ? paneKeyPrefix(paneId) : ''}h5-sidebar-collapsed`;
const readCollapsed = () => readShared(SIDEBAR_KEY) === '1';

const ui = createStore({ ...initialState(), wide: wideQuery.matches, input: inputMode(), sidebarCollapsed: readCollapsed(), pane: paneId });
if (paneId) startPane(ui, paneId);
ui.media = { wideQuery, inputMode };
// The kind of a file (file-kinds.mjs), for h5.js: it decides how the file sheet reads a file (text, image or raw bytes).
ui.fileKinds = { kindOf, isRaw: kind => RAW_KINDS.has(kind) };
// The rules of the shared task order (task-order.mjs), for h5.js: where each task goes, and the whole order to save after a move.
ui.taskOrder = { arrangeTasks, mergeOrder, moveKey, sameOrder, stepTarget };
ui.orderDevices = orderDevices; // the one order of devices on every page (device-order.mjs): h5.js sorts its services with it
// The recent sessions of the session switcher (recent-sessions.mjs), for h5.js, which notes every session it shows.
ui.recent = { max: RECENT_MAX, key: recentKey, note: noteRecent, prune: pruneRecent, parse: parseRecent, edit: editRecent }; // parse: the old per-browser list, imported once (h5.js)
let notices = 0;
// `action`: one action of the notice, `{ label, run }` (an English label, a function), shown as a text button ("Floating notices" in docs/design/toast.md).
// With an action also: `lead` (English words before the message, which is then a name drawn in bold and never translated), `detail` (a second line),
// `close` (a close button) and `ms` (how long it stays), for the "Continue <session>" hint (docs/design/continue-and-drafts.md).
ui.notify = (message, type = 'info', { action = null, lead = '', detail = '', close = false, ms = 0 } = {}) => {
  const text = String(message === undefined || message === null ? '' : message).trim();
  const one = action && typeof action.run === 'function' && action.label ? { label: String(action.label), run: action.run } : null;
  const more = one && (lead || detail || close || ms) ? { lead: String(lead || ''), detail: String(detail || ''), close: Boolean(close), ms: Number(ms) || 0 } : null;
  if (text) ui.set({ notice: { id: ++notices, message: text, type, action: one, ...more } });
};
window.H5UI = ui;
// Voice input turned off (voice-input.js owns the setting, but runs after the first paint can happen): the microphone button must not show and then vanish.
if (localGet('voice-enabled') === '0') document.documentElement.setAttribute('data-voice-off', ''); // storage blocked: on
// The floating notices of every script of the page (voice input, chat, uploads) go through the shell.
window.notify = (message, type) => ui.notify(message, type);
window.Toast = { show: (message, options = {}) => ui.notify(message, options.type), error: message => ui.notify(message, 'error'), success: message => ui.notify(message, 'success') };

// The input mode follows the media queries (a mouse plugged in, a tablet docked) and is also on <html data-input> for CSS.
function syncInput() {
  const input = inputMode();
  document.documentElement.dataset.input = input;
  if (ui.get().input !== input) ui.set({ input });
}
syncInput();
fineQuery.addEventListener('change', syncInput);
coarseQuery.addEventListener('change', syncInput);

// A hardware keyboard on a touch device (an iPad with a keyboard): the first trusted keydown while the visual viewport is at its full height for this
// width (no on-screen keyboard is open) turns on the computer shortcuts and typing to the terminal. The touch bars stay as they are.
let tallest = 0;
let tallestWidth = 0;
const viewportHeight = () => (window.visualViewport ? window.visualViewport.height : window.innerHeight);
function measureViewport() {
  if (window.innerWidth !== tallestWidth) { tallestWidth = window.innerWidth; tallest = 0; }
  tallest = Math.max(tallest, viewportHeight());
}
measureViewport();
window.visualViewport?.addEventListener('resize', measureViewport);
window.addEventListener('resize', measureViewport);
document.addEventListener('keydown', event => {
  if (ui.get().hasKeyboard || !event.isTrusted || event.isComposing || event.keyCode === 229 || !event.key || event.key === 'Unidentified') return;
  measureViewport();
  if (tallest - viewportHeight() > 8) return; // an on-screen keyboard is open: its keys say nothing about a hardware keyboard
  document.documentElement.dataset.keyboard = 'hardware';
  ui.set({ hasKeyboard: true });
}, true);

// Wide layout: fold the permanent sidebar away and back. The terminal refits to the new width by itself (a real layout change, so a PTY resize is right).
ui.actions.toggleSidebar = () => {
  const collapsed = !ui.get().sidebarCollapsed;
  writeShared(SIDEBAR_KEY, collapsed ? '1' : null);
  // The rename field and the popup of a row are drawn inside the sidebar or point into it: they go with it (as with the sheet of a phone, h5.js `closeTasks`).
  const menu = ui.get().menu;
  if (collapsed && menu && (menu.rename || menu.anchor)) ui.actions.menuCancel();
  ui.set({ sidebarCollapsed: collapsed });
};

// Folded or unfolded on another device: this page follows.
onShared(() => { const collapsed = readCollapsed(); if (collapsed !== ui.get().sidebarCollapsed) ui.set({ sidebarCollapsed: collapsed }); });

// The multi-column view (Columns.jsx): its remembered state is read before the first render, so a restored strip is drawn at once and h5.js finds
// `columns.shown` when it starts (it then opens no terminal socket of its own).
startColumns(ui);

const root = createRoot(document.getElementById('h5-root'));
flushSync(() => root.render(<App ui={ui} />));

// The back button closes the open sheet, dialog or menu (scripts/h5-shell/back.mjs). The panel beside the terminal on a wide screen (T-Attention) is not a
// modal, so it is named here; the modals are found by themselves. Not in a pane: a frame's history entries are joined with the top page's, so a pane's
// `history.go` could move another column or the top page; there Escape and the close buttons close what is open.
const back = paneId ? null : createBackLayers({
  extra: () => {
    const s = ui.get();
    const layers = [];
    if (s.wide && s.attention && s.attention.open) layers.push({ close: () => ui.actions.closeAttention() });
    // The mind map view (view -> editor -> dialog): a back press goes from the editor to the list before it leaves the view. It lies over everything else.
    for (const close of s.mindmapLayers || []) layers.push({ close });
    // Settings on a computer is a page beside the rail, not a modal (Settings.jsx); on a phone it is a modal and found by itself.
    if (s.wide && s.settingsOpen) layers.push({ close: () => ui.actions.closeSettings() });
    // So is the Learn page on a computer (Learn.jsx); on a phone it is a modal too.
    if (s.wide && s.learnOpen) layers.push({ close: () => ui.actions.closeLearn() });
    // The session switcher (Switcher.jsx) is not a modal either; it lies over the terminal.
    if (s.switcher) layers.push({ close: () => ui.actions.closeSwitcher() });
    return layers;
  },
});
if (back) ui.subscribe(back.sync);

// T-Attention: the list, its live stream and the reminders run from the start (the badge on the Attention button); the panel is drawn when opened.
// A pane has no Attention button and leaves the stream and the reminders to the top page (`passive`).
startAttentionFeed(ui, { t, api, passive: Boolean(paneId) });

// Plan usage in the session header (plan-usage-feed.mjs): the readings of the shown engine, polled while the page is visible. A pane has no session
// header of its own (the top page draws the column headers), so it reads nothing.
if (!paneId) startPlanUsage(ui, { api });

// The chunk of an on-demand screen is asked for as soon as the pointer, a finger or the focus reaches the button that opens it.
preloadOnIntent(document);

// Usage data (usage-track.mjs, "Usage data" in docs/design/usage-data.md): which buttons are pressed, sent in batches to this server while the
// switch in Settings > Usage data is on. A pane records its own presses (its document is its own).
startUsageTracking(ui);

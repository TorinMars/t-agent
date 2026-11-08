// The Material UI shell of the phone page (/h5). It is drawn at once, while the page is still being parsed (flushSync), so that the scripts after it
// (voice-input.js, h5.js ...) find #h5-translate-input, #h5-voice and the rest where they have always been.
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createStore, initialState } from './store.mjs';
import { createBackLayers } from './back.mjs';
import { startAttentionFeed } from './attention-feed.mjs';
import { api, t } from './common.jsx';
import { RAW_KINDS, kindOf } from './file-kinds.mjs';
// T-Attention settings slots: the modules of other T-Attention parts that register Settings content (attention-slots.mjs) are imported here, e.g.
import './PluginSettings.jsx';
import './NotifierSettings.jsx';

// One breakpoint for the shell and for h5.js (which reads it from `H5UI.media.wideQuery`), so the two can never disagree.
const wideQuery = window.matchMedia('(min-width: 900px)');
// The input mode is separate from the width and never read from the user agent: 'pointer' when the main pointer is fine and can hover and no coarse
// pointer (a touch screen) exists at all, else 'touch'. An iPad with a trackpad still reports a coarse pointer, so it stays 'touch'.
const fineQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
const coarseQuery = window.matchMedia('(any-pointer: coarse)');
const inputMode = () => (fineQuery.matches && !coarseQuery.matches ? 'pointer' : 'touch');
const SIDEBAR_KEY = 'h5-sidebar-collapsed';
const readCollapsed = () => { try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; } };

const ui = createStore({ ...initialState(), wide: wideQuery.matches, input: inputMode(), sidebarCollapsed: readCollapsed() });
ui.media = { wideQuery, inputMode };
// The kind of a file (file-kinds.mjs), for h5.js: it decides how the file sheet reads a file (text, image or raw bytes).
ui.fileKinds = { kindOf, isRaw: kind => RAW_KINDS.has(kind) };
let notices = 0;
ui.notify = (message, type = 'info') => {
  const text = String(message === undefined || message === null ? '' : message).trim();
  if (text) ui.set({ notice: { id: ++notices, message: text, type } });
};
window.H5UI = ui;
// Voice input turned off (voice-input.js owns the setting, but runs after the first paint can happen): the microphone button must not show and then vanish.
try { if (localStorage.getItem('voice-enabled') === '0') document.documentElement.setAttribute('data-voice-off', ''); } catch { /* storage blocked: on */ }
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
  try { if (collapsed) localStorage.setItem(SIDEBAR_KEY, '1'); else localStorage.removeItem(SIDEBAR_KEY); } catch { /* not remembered */ }
  ui.set({ sidebarCollapsed: collapsed });
};

const root = createRoot(document.getElementById('h5-root'));
flushSync(() => root.render(<App ui={ui} />));

// The back button closes the open sheet, dialog or menu (scripts/h5-shell/back.mjs). The panels beside the terminal on a wide screen (the file tree, and
// the file panel over it) are not modals, so they are named here, the lower one first; the modals are found by themselves.
const back = createBackLayers({
  extra: () => {
    const s = ui.get();
    if (!s.wide) return [];
    const layers = [];
    if (s.files && s.files.open) layers.push({ close: () => ui.actions.closeFiles && ui.actions.closeFiles() });
    if (s.design && s.design.open) layers.push({ close: () => ui.actions.closeDesign && ui.actions.closeDesign() });
    if (s.attention && s.attention.open) layers.push({ close: () => ui.actions.closeAttention() });
    return layers;
  },
});
ui.subscribe(back.sync);

// T-Attention: the list, its live stream and the reminders run from the start (the badge on the Attention button); the panel is drawn when opened.
startAttentionFeed(ui, { t, api });

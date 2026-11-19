import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Divider from '@mui/material/Divider';
import GlobalStyles from '@mui/material/GlobalStyles';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { alpha, getOverlayAlpha } from '@mui/material/styles';
import { Pill, named, t } from './common.jsx';
import { TOUCH } from './theme.mjs';
import { Icon } from './Icons.jsx';
import { DeviceTag } from './TaskDrawer.jsx';
import { UpdateButton } from './Update.jsx';
import { SETTLE_MS } from './list-drag.jsx';
import { useFlipX, useTabDrag } from './tab-drag.jsx';
import { countRender, useStore, useStoreKeys } from './use-store.mjs';
import { shallowEqual } from './store.mjs';
import { forgetPaneKeys } from './pane.mjs';
import { measureTerminalBox } from './terminal-box.mjs';
import {
  STORAGE_KEY, newId, canAdd, canClose, canOfferColumns, columnMove, columnStep, columnsFor, forgetMessage, hiddenEdges, minColumnWidth, mountOrder,
  moveColumn, openMessage, paneUrl, readLayout, readPaneMessage, revealLeft, shiftColumn, sidewaysDelta, stepTarget, tagOf, targetColumn, writeLayout,
  AGENT_NAMES, MESSAGE_TYPE, RAIL_WIDTH, STATE_WORDS, canMaximize, columnName, columnStatus, keptMaximized, maximizeKey,
  railColumns, toggleMaximize, LIST_WORDS, actionMessage, headerLabel, headerName, listState, summarize,
  NAV_WIDTH, dropMapColumns, legacyMapKeyOf, needsCount, railKey, readTab, stripWidthOf, railDestinations, railView,
} from './columns.mjs';

// The multi-column view of a wide screen: the top page shows a row of iframes of itself in pane mode (`/h5?pane=<id>`), each a whole copy of the page
// with its own terminal, draft box and tool row under one header that the top page draws (`ColumnHeader`; the pane hides its own page header). The
// page's navigation rail (`NavRail`, "Views", also shown in the single view) stays on the left: Sessions leaves the view, Columns and Mind maps are its two
// tabs (the strip and a whole mind map page, `MapsTab`). The top page keeps one
// activity feed, one notifier and one updater; while the strip is shown its own terminal is hidden and holds no socket (h5.js, `columns.shown`).
// The rules (ids, order, the message format) are in columns.mjs; "Multi-column view" in docs/design/page-shell-and-columns.md.
//
// state.columns: null on a page that never offers the view (a pane, or any page inside a frame), else
//   { enabled (the person's choice, remembered), shown (enabled and the screen is wide), ids (in order), focus (an id or null), tab ('columns' or
//     'maps': the tab of the rail that is shown, remembered), titles ({ id: { title, session, device?, target?, agent?, sheet, width } } from the
//     panes), ready ({ id: true } once the pane said so), closing ([id] being closed), maximized (the id of the column that fills the strip, or null;
//     not stored), tails ({ id: [line] }, the last lines a pane sent for the peek card of its tile) }
// `ids` is the order the person sees (the column list, the columns and their headers from left to right, the keys, storage). The columns' elements never follow it: each keeps the
// place in the DOM it was created at (`mountOrder`) and is shown at its place by the CSS `order` property, since moving an iframe's element reloads its page.

const CLOSE_DELAY_MS = 250; // a closed column stays mounted (hidden) this long, so its pane receives 'forget' before its iframe goes away
const FOCUS_CHECK_MS = 300;
const MAX_ORDER = 999; // a column being closed (hidden) comes after every shown one

const readStored = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const writeStored = value => { try { localStorage.setItem(STORAGE_KEY, value); } catch { /* not remembered */ } };
const frames = () => [...document.querySelectorAll('#h5-columns iframe[data-pane-id]')];
const frameOf = id => frames().find(el => el.dataset.paneId === id);
const stripEl = () => document.getElementById('h5-columns-strip');
const columnEl = id => document.querySelector(`#h5-columns .h5-column[data-pane-id="${id}"]`);
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const openOf = columns => columns.ids.filter(id => !columns.closing.includes(id));
// While a column is maximized, the other columns stay mounted and connected at the width they had (so their pages see no resize and their
// terminals keep their size), out of sight under the maximized one; `frozen` keeps those widths and the strip's sideways scroll, measured just before.
const frozen = { widths: new Map(), scroll: 0 };
const postTo = (id, message) => { const frame = frameOf(id); try { frame?.contentWindow?.postMessage({ type: MESSAGE_TYPE, ...message }, location.origin); } catch { /* gone */ } };
// The live region of the strip (#h5-columns-live): moves of a column are said there.
const say = text => { const el = document.getElementById('h5-columns-live'); if (el) el.textContent = t(text); };

// Scrolls the strip so the column is whole in view (from its start when it is wider than the view): smooth, or at once with reduced motion. Its place is
// read from its layout (`offsetLeft` in the strip, its offsetParent), so a column still sliding to a new place (a transform) is aimed at where it goes.
function revealColumn(id) {
  const strip = stripEl();
  const column = id && columnEl(id);
  if (!strip || !column || !column.offsetParent) return;
  const left = revealLeft({ left: column.offsetLeft, width: column.offsetWidth, scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth });
  if (left !== null) strip.scrollTo({ left, behavior: reducedMotion() ? 'auto' : 'smooth' });
}
const scrollStrip = dx => { const strip = stripEl(); if (strip && dx) strip.scrollBy({ left: dx, behavior: 'auto' }); };

export function startColumns(ui) {
  if (!canOfferColumns(location.search, window.top !== window)) { ui.set({ columns: null }); return; }
  const wideQuery = ui.media.wideQuery;
  const stored = readLayout(readStored());
  // Mind map columns of v2.133 / v2.134 are dropped, with every key their panes kept (see LEGACY_MAP_KEY in columns.mjs).
  const legacy = dropMapColumns(stored.ids, id => { try { return localStorage.getItem(legacyMapKeyOf(id)) !== null; } catch { return false; } });
  for (const id of legacy.dropped) forgetPaneKeys(id);
  stored.ids = legacy.ids;
  const get = () => ui.get().columns;
  const put = patch => {
    const before = get();
    const next = { ...before, ...patch };
    next.shown = next.enabled && wideQuery.matches;
    next.maximized = keptMaximized(next); // a maximized column that was closed, or a strip that went away: restored
    ui.set({ columns: next });
    writeStored(writeLayout({ on: next.enabled, ids: next.ids.filter(id => !next.closing.includes(id)), tab: next.tab }));
    if (before && before.maximized !== next.maximized) {
      if (before.maximized) postTo(before.maximized, { event: 'maximized', on: false });
      if (next.maximized) postTo(next.maximized, { event: 'maximized', on: true });
      say(next.maximized ? 'Column maximized. The other columns are in the rail.' : 'Columns restored');
    }
    // Each pane is told whether it is the focused column (its compact bottom area shows its tools only then; "Pane mode" in page-shell-and-columns.md).
    if (before && before.focus !== next.focus) {
      if (before.focus && !next.closing.includes(before.focus)) postTo(before.focus, { event: 'focused', on: false });
      if (next.focus) postTo(next.focus, { event: 'focused', on: true });
    }
  };
  ui.set({ columns: { enabled: false, shown: false, ids: [], focus: null, tab: stored.tab, titles: {}, ready: {}, closing: [], maximized: null, tails: {} } });
  put({ enabled: stored.on, ids: stored.on ? columnsFor(stored.ids, stripWidthOf(window.innerWidth)) : stored.ids });
  wideQuery.addEventListener('change', () => put({}));

  ui.actions.toggleColumns = () => {
    const now = get();
    if (now.enabled) { put({ enabled: false, focus: null }); return; }
    put({ enabled: true, focus: null, ids: columnsFor(now.ids.filter(id => !now.closing.includes(id)), stripWidthOf(window.innerWidth)) }); // the focus is not taken: the person clicks a column
  };
  ui.actions.addColumn = () => {
    const now = get();
    const open = now.ids.filter(id => !now.closing.includes(id));
    if (!canAdd(open)) return;
    put({ ids: [...now.ids, newId(now.ids)], maximized: null }); // a column being closed is still mounted: its id is not given out again
  };
  // The tab of the navigation rail: 'columns' (the strip) or 'maps' (the Mind maps page). The other tab stays mounted and hidden, so nothing reloads
  // (ColumnStrip). Remembered with the layout. The Mind maps button of the task sheet (the top page's, or a pane's: 'mindmaps') shows 'maps'.
  ui.actions.showColumnsTab = tab => {
    const now = get();
    const next = readTab(tab);
    if (!now || !now.shown || now.tab === next) return;
    put({ tab: next });
    // The keyboard never stays in the tab that was hidden (Safari does not focus a clicked button, so it could stay in a column's frame): it goes to
    // the destination that was opened.
    setTimeout(() => {
      const active = document.activeElement;
      const hidden = document.getElementById(next === 'maps' ? 'h5-columns-tab' : 'h5-columns-maps');
      if (active && hidden && hidden.contains(active)) { const button = document.getElementById(next === 'maps' ? 'h5-nav-maps' : 'h5-nav-columns'); if (button) button.focus(); }
    }, 0);
  };
  // A destination of the navigation rail (NavRail): 'sessions' leaves the view (the single view comes back), 'columns' and 'maps' show that tab, entering
  // the view first when it is off. Below the wide breakpoint the view cannot be shown, so only 'sessions' does anything there.
  ui.actions.showView = view => {
    const now = get();
    if (view === 'sessions') { if (now.enabled) put({ enabled: false, focus: null }); return; }
    const tab = readTab(view === 'maps' ? 'maps' : 'columns');
    if (!now.enabled) {
      put({ enabled: true, focus: null, tab, ids: columnsFor(now.ids.filter(id => !now.closing.includes(id)), stripWidthOf(window.innerWidth)) });
      return;
    }
    ui.actions.showColumnsTab(tab);
  };
  // Maximize: one column (any: a terminal, a chat, the task list) fills the strip and the other columns become the rail (ColumnRail). Their widths and
  // the strip's scroll are kept first, so they stay as they were and come back exactly. Restore: back to the strip; `focus` (a tile, Open column)
  // takes the focus into that column, and a focus that was in the rail goes into the maximized column (the rail is gone). These two actions are the one
  // entry point: the header's Maximize button and Cmd/Ctrl+Shift+Enter (the top page's key, or 'maximize' from a pane) go through `toggleMaximize`.
  ui.actions.maximizeColumn = id => {
    const now = get();
    if (!canMaximize(now, id) || now.maximized === id) return;
    frozen.widths = new Map([...document.querySelectorAll('#h5-columns .h5-column')].map(el => [el.dataset.paneId, el.offsetWidth]));
    frozen.scroll = stripEl() ? stripEl().scrollLeft : 0;
    put({ maximized: id, focus: id });
  };
  ui.actions.restoreColumns = ({ focus = null } = {}) => {
    const now = get();
    if (!now || !now.maximized) return;
    const active = document.activeElement;
    const inRail = Boolean(active && active.closest && active.closest('#h5-columns-rail'));
    const target = focus && openOf(now).includes(focus) ? focus : inRail ? now.maximized : null;
    put({ maximized: null, ...(target ? { focus: target } : {}) });
    if (target) setTimeout(() => { const frame = frameOf(target); try { if (frame) frame.focus(); } catch { /* gone */ } revealColumn(target); }, 0);
  };
  ui.actions.toggleMaximize = id => {
    const now = get();
    if (!now || now.tab !== 'columns') return;
    const change = toggleMaximize(now, id || (now && now.focus));
    if (!change) return;
    if (change.maximized) ui.actions.maximizeColumn(change.maximized);
    else ui.actions.restoreColumns();
  };
  // The peek card of a tile asks that pane for the last lines of its terminal (answered with 'peek', kept in `tails`).
  ui.actions.peekColumn = id => { if (get() && get().maximized && openOf(get()).includes(id)) postTo(id, { event: 'peek' }); };
  ui.actions.closeColumn = id => {
    const now = get();
    const open = now.ids.filter(item => !now.closing.includes(item));
    if (!open.includes(id) || !canClose(open)) return;
    const frame = frameOf(id);
    try { frame?.contentWindow?.postMessage(forgetMessage(), location.origin); } catch { /* already gone */ }
    put({ closing: [...now.closing, id], focus: now.focus === id ? null : now.focus });
    setTimeout(() => {
      const later = get();
      const { [id]: _title, ...titles } = later.titles;
      const { [id]: _ready, ...ready } = later.ready;
      put({ ids: later.ids.filter(item => item !== id), closing: later.closing.filter(item => item !== id), titles, ready });
    }, CLOSE_DELAY_MS);
  };
  ui.actions.focusColumn = id => { if (get().focus !== id && get().ids.includes(id)) put({ focus: id }); };
  // Ctrl+Alt+Left / Right (from the top page or forwarded by a pane): the focus moves to the previous / next column, into its iframe (the person asked
  // for it, so the top page focuses the frame), and the column is scrolled into view (ColumnStrip, on the focus change; here too when it stays).
  ui.actions.stepColumn = step => {
    const now = get();
    if (!now || !now.shown || now.tab !== 'columns') return;
    if (now.maximized) { ui.actions.restoreColumns({ focus: stepTarget(openOf(now), now.focus, step) }); return; }
    const id = stepTarget(now.ids.filter(item => !now.closing.includes(item)), now.focus, step);
    if (!id) return;
    if (now.focus !== id) put({ focus: id });
    const frame = frameOf(id);
    try { if (frame) frame.focus(); } catch { /* gone */ }
    revealColumn(id);
  };
  ui.actions.scrollColumns = dx => { if (get() && get().shown) scrollStrip(dx); };
  // A column chosen (its header clicked, the column list, "1 needs you"): that column takes the focus and is scrolled into view; `focusFrame` also moves
  // the keyboard into its frame.
  ui.actions.showColumn = (id, { focusFrame = false } = {}) => {
    const now = get();
    if (!now || !now.shown || !openOf(now).includes(id)) return;
    if (now.maximized && now.maximized !== id) { ui.actions.restoreColumns({ focus: id }); return; } // another column chosen: back to the strip
    if (now.focus !== id) put({ focus: id });
    if (focusFrame) { const frame = frameOf(id); try { if (frame) frame.focus(); } catch { /* gone */ } }
    revealColumn(id);
  };
  // An action of a column's header that works inside its pane (columns.mjs `actionMessage`): the column takes the focus, and for the task sheet, rename
  // and restart (they need the keyboard, or ask a question) the keyboard goes into its frame first. The message waits for the frame's page like `open`.
  ui.actions.columnAction = (id, event, options = {}) => {
    const now = get();
    const message = actionMessage(event, options);
    if (!now || !now.shown || !message || !openOf(now).includes(id)) return;
    if (now.focus !== id) put({ focus: id });
    if (event === 'tasks' || event === 'rename' || event === 'restart') { const frame = frameOf(id); try { if (frame) frame.focus(); } catch { /* gone */ } }
    pending.set(id, [...(pending.get(id) || []), message]);
    deliver(id);
  };
  // A new place for a column (a header dropped, Ctrl+Alt+Shift+Left / Right): the order is saved at once, the columns slide to their places
  // (useFlipX), the column keeps (or takes) the focus and is scrolled into view, and the move is said. An element with the keyboard focus that lost it
  // gets it back.
  const reorder = (id, next) => {
    const now = get();
    const open = openOf(now);
    const active = document.activeElement;
    if (next !== open) put({ ids: [...next, ...now.ids.filter(item => now.closing.includes(item))], focus: id });
    else if (now.focus !== id) put({ focus: id });
    say(`Column moved to position ${next.indexOf(id) + 1} of ${next.length}`);
    setTimeout(() => {
      if (active && active !== document.body && active.isConnected && document.activeElement !== active) { try { active.focus({ preventScroll: true }); } catch { /* gone */ } }
      revealColumn(id);
    }, 0);
  };
  ui.actions.moveColumnTo = (id, index) => {
    const now = get();
    if (!now || !now.shown || !openOf(now).includes(id)) return;
    reorder(id, moveColumn(openOf(now), id, index));
  };
  // From the top page it moves the focused column; from a pane, that pane's own column.
  ui.actions.moveColumn = (step, id) => {
    const now = get();
    const which = id || (now && now.focus);
    if (!now || !now.shown || now.tab !== 'columns' || now.maximized || !which || !openOf(now).includes(which)) return; // no moves while a column is maximized
    reorder(which, shiftColumn(openOf(now), which, step));
  };
  window.addEventListener('keydown', event => {
    // Cmd/Ctrl+Shift+Enter on the top page (a header, the rail): maximize the focused column, or restore. Inside a column the pane posts 'maximize'.
    const strip = Boolean(get() && get().shown && get().tab === 'columns'); // the keys of the strip work in the Columns tab only
    if (strip && maximizeKey(event) && (get().maximized || canMaximize(get(), get().focus))) {
      event.preventDefault();
      event.stopPropagation();
      ui.actions.toggleMaximize();
      return;
    }
    const on = strip && !event.isComposing;
    const step = on ? columnStep(event) : 0;
    const move = on ? columnMove(event) : 0;
    if (!step && !move) return;
    event.preventDefault();
    event.stopPropagation();
    if (step) ui.actions.stepColumn(step);
    else ui.actions.moveColumn(move);
  }, true);

  // Open requests for the columns. A message posted before the pane's page has loaded would reach the iframe's first empty document and be lost, so
  // each one waits until that iframe element has fired `load` (or its pane said 'ready'); a strip drawn again has new iframe elements.
  const loadedFrames = new WeakSet();
  const pending = new Map(); // id -> [message]
  const deliver = id => {
    const frame = frameOf(id);
    const list = pending.get(id);
    if (!list || !frame || !loadedFrames.has(frame)) return;
    pending.delete(id);
    for (const message of list) { try { frame.contentWindow.postMessage(message, location.origin); } catch { /* gone */ } }
  };
  ui.actions.columnLoaded = (id, frame) => { if (frame) loadedFrames.add(frame); deliver(id); };
  // The top page itself would select a session after load (h5.js: a ?openChat= link): while the strip is shown the hidden normal view stays as it is,
  // and the focused column (else the first) is asked to show it, scrolled into view and outlined (the Columns tab is shown for it). False when the
  // strip is not shown (the caller goes on as usual) or the target is not usable.
  ui.actions.openInColumn = target => {
    const now = get();
    if (!now || !now.shown) return false;
    const message = openMessage(target);
    const id = targetColumn(now.ids.filter(item => !now.closing.includes(item)), now.focus);
    if (!message || !id) return false;
    pending.set(id, [...(pending.get(id) || []), message]);
    deliver(id);
    if (now.focus !== id || now.tab !== 'columns') put({ focus: id, tab: 'columns' });
    setTimeout(() => revealColumn(id), 0);
    return true;
  };

  // Messages from the panes: same origin only, and only from one of the strip's own iframes, about itself.
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !get() || !get().shown) return;
    const frame = frames().find(el => el.contentWindow === event.source);
    const message = frame && readPaneMessage(event.data);
    if (!message || message.paneId !== frame.dataset.paneId) return;
    const id = message.paneId;
    if (message.event === 'ready') { put({ ready: { ...get().ready, [id]: true } }); ui.actions.columnLoaded(id, frame); postTo(id, { event: 'focused', on: get().focus === id }); }
    else if (message.event === 'focus') ui.actions.focusColumn(id);
    else if (message.event === 'scroll-x') scrollStrip(message.dx);
    else if (message.event === 'step') ui.actions.stepColumn(message.step);
    else if (message.event === 'move') ui.actions.moveColumn(message.step, id);
    else if (message.event === 'maximize') ui.actions.toggleMaximize(id);
    else if (message.event === 'peek') put({ tails: { ...get().tails, [id]: message.lines } });
    else if (message.event === 'mindmaps') ui.actions.showColumnsTab('maps');
    else {
      const info = { title: message.title, session: message.session, device: message.device || null, target: message.target || null, agent: message.agent || '', sheet: message.sheet === true, width: message.width || null };
      put({ titles: { ...get().titles, [id]: info } });
    }
  });
}

// The page under the view is hidden: its header, terminal, sidebar, chat and full-window mind map (the Mind maps tab has its own element). Notices and
// dialogs (higher z-index) stay above the view, and so do the navigation rail (NavRail, left of the view), the T-Attention side sheet (floating over the
// right of the view, which keeps its full width, as the single view does) and Settings.
// The strip's sideways scrollbar is always drawn while the columns overflow, also where the system hides scrollbars until they are used (macOS):
// a styled ::-webkit-scrollbar is a classic one (Chrome, Edge, Safari). Firefox takes the standard properties instead; they are set only where
// ::-webkit-scrollbar does not exist, since Chrome would let them win and draw its overlay scrollbar again.
const SCROLLBAR = 10; // px
const STRIP_SCROLLBAR = {
  '#h5-columns-strip::-webkit-scrollbar': { height: SCROLLBAR, background: '#1a1a1a' },
  '#h5-columns-strip::-webkit-scrollbar-track': { background: '#1a1a1a', borderTop: '1px solid rgba(255,255,255,0.08)' },
  '#h5-columns-strip::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.32)', borderRadius: SCROLLBAR / 2, border: '2px solid #1a1a1a', minWidth: 40 },
  '#h5-columns-strip::-webkit-scrollbar-thumb:hover': { background: 'rgba(255,255,255,0.5)' },
  '@supports not selector(::-webkit-scrollbar)': { '#h5-columns-strip': { scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.4) #1a1a1a' } },
};
// No scroll snapping: Chrome snaps a programmatic scroll in its direction to the next column start, even with `proximity`, so every small sideways
// swipe forwarded from a pane (scrollBy of a few px) would jump a whole column, and `mandatory` pulls small native scrolls back. The strip scrolls freely.
// The edge shadows: on this dark page a black fade hardly shows, so the hidden side gets a light fade with a 1px line at the very edge.
const EDGE = { position: 'absolute', top: 0, width: 32, pointerEvents: 'none', zIndex: 1, transition: 'opacity .15s', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } };

const HIDE_PAGE = {
  'html[data-columns] #h5-app, html[data-columns] #h5-tasks, html[data-columns] #h5-agent, html[data-columns] #h5-mindmap': { display: 'none !important' },
  'html[data-columns] #h5-settings': { zIndex: 1255 },
};

// One header per column, drawn by the top page right above the column's iframe (`ColumnHeader`, `.h5-column-head`): the drag grip (pointer input),
// the state dot (green running, orange needs you, grey idle: `columnStatus`, from the top page's terminal activity and T-Attention), the device tag of
// the pane's task (the same DeviceTag as the task list) and "Project · session ▾", which opens that column's task sheet (a message to its pane; the
// pane hides its own page header). On the right: "Needs you" and an orange tint and top line while the column waits for the person, else the agent
// of a running terminal; then the actions: fit / wide terminal width, maximize, the "⋯" menu (`ColumnMenu`, everything the header does and more) and
// close. With a mouse, fit and maximize (and on unfocused columns also "⋯" and close) show on hover or keyboard focus inside the header; in touch input
// mode "⋯" and close are always shown with 44px targets and fit and maximize live in the menu. The focused column has a 2px primary top line and a
// lighter header (a higher MD2 elevation overlay); the other columns' pages are slightly dimmed. Holding the header drags the column to a new place
// (useTabDrag in tab-drag.jsx). See "Multi-column view" in docs/design/page-shell-and-columns.md.
const HEAD_HEIGHT = 38;
const HEAD_TOUCH = 44;
const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const MAXIMIZE_KEYS = APPLE ? '⌘⇧↩' : 'Ctrl+Shift+Enter';
const WIDE_CHOICES = [120, 160, 200];
// The MD2 dark theme shows elevation as a white overlay on the surface (1dp 5%, 4dp 9%, ...): `getOverlayAlpha` is MUI's own table.
export const overlay = dp => `linear-gradient(${alpha('#fff', Number(getOverlayAlpha(dp)))}, ${alpha('#fff', Number(getOverlayAlpha(dp)))})`;
// The state dot: the theme's success, warning and disabled colours (green 400, orange 400 and 38% white in the dark theme).
const STATE_COLORS = { running: 'success.main', waiting: 'warning.main', idle: 'text.disabled' };
const STATUS_KEYS = ['attention', 'terminalActivity'];
const columnsOf = strip => [...strip.querySelectorAll(':scope > .h5-column')];
const paneKey = el => el.dataset.paneId;
// The status of every column, from the top page's terminal activity and T-Attention items (read only while the strip is shown: these parts are mounted
// only then, so an activity push in the normal view draws nothing of the strip).
function useStatusOf(ui, columns) {
  const live = useStoreKeys(ui, STATUS_KEYS);
  return id => columnStatus(columns.titles[id], { activity: live.terminalActivity, items: live.attention && live.attention.items });
}
// The state of the session the single view shows (its page header's dot, Header.jsx): the same rule as a column's (`columnStatus`), on the terminal shown
// (`state.shownTarget`, h5.js). A string, so the header part that draws it is drawn again only when the state changes, not on every activity push.
const SHOWN_STATE = state => (state.shownTarget
  ? columnStatus({ target: state.shownTarget }, { activity: state.terminalActivity, items: state.attention && state.attention.items }).state
  : null);
export const useShownState = ui => useStore(ui, SHOWN_STATE);
// The name of a column as its header and the column list show it: { title, session, shown (what is drawn when the pane said nothing), tag }.
function nameOf(columns, id, index) {
  const info = columns.titles[id];
  const { title, session } = headerName(info);
  const fallback = info ? t('Choose a task') : t(`Column ${index + 1}`);
  return { info, title, session, shown: title || fallback, tag: info && info.device ? tagOf(info.device) : null };
}
export const Dot = ({ state, className }) => (
  <Box component="span" aria-hidden="true" className={className} data-state={state} sx={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', bgcolor: STATE_COLORS[state] }} />
);
// "Project · session", cut with an ellipsis; the task is the stronger of the two.
function ColumnName({ name, size = 13 }) {
  return (
    <>
      <Box component="span" className="h5-column-title" translate={name.title ? 'no' : undefined}
        sx={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: size, fontWeight: 600 }}>{name.shown}</Box>
      {name.session ? (
        <Box component="span" className="h5-column-session" translate="no"
          sx={{ flex: '0 100 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: size, color: 'text.secondary' }}>{`· ${name.session}`}</Box>
      ) : null}
    </>
  );
}

function ColumnHeader({ id, index, columns, closable, touch, ui, drag, onMenu, onWidthMenu, menuOpen }) {
  const statusOf = useStatusOf(ui, columns);
  const status = statusOf(id);
  const name = nameOf(columns, id, index);
  const { info } = name;
  const focused = columns.focus === id;
  const waiting = status.state === 'waiting';
  const maximized = columns.maximized === id;
  const width = info && info.width ? info.width : null;
  const wide = Boolean(width && width.mode === 'wide');
  const agent = info && status.state === 'running' && AGENT_NAMES[info.agent] ? AGENT_NAMES[info.agent] : '';
  const label = headerLabel(info, [t(STATE_WORDS[status.state]), focused ? t('focused') : ''].filter(Boolean).join(', '), name.shown);
  const sheetLabel = t('Switch task or session');
  const maximizeLabel = maximized ? t('Restore columns') : t('Maximize');
  const act = { className: 'h5-column-act', size: 'small' };
  // A click on the header itself (not on one of its buttons) focuses the column and moves the keyboard into it.
  const onClick = event => { if (!event.target.closest || !event.target.closest('button')) ui.actions.showColumn(id, { focusFrame: true }); };
  return (
    <Box className="h5-column-head" role="group" aria-label={label} data-pane-id={id} data-state={status.state} data-focused={focused ? '' : undefined}
      data-menu={menuOpen ? '' : undefined} onClick={onClick} {...drag.hold()}
      sx={theme => ({
        flex: '0 0 auto', position: 'relative', height: HEAD_HEIGHT, [TOUCH]: { height: HEAD_TOUCH, pr: 0 }, boxSizing: 'border-box', display: 'flex', alignItems: 'center',
        gap: 1, pl: 1.25, pr: 0.5, borderBottom: 1, borderColor: waiting ? alpha(theme.palette.warning.main, 0.24) : 'divider',
        userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: touch ? 'default' : 'grab',
        bgcolor: 'background.paper',
        backgroundImage: waiting
          ? `linear-gradient(${alpha(theme.palette.warning.main, 0.1)}, ${alpha(theme.palette.warning.main, 0.1)}), ${overlay(focused ? 4 : 1)}`
          : overlay(focused ? 4 : 1),
        // The top line: primary on the focused column, orange on a column that needs the person (2px, inside the header).
        '&::before': { content: '""', position: 'absolute', left: 0, right: 0, top: 0, height: 2, pointerEvents: 'none',
          bgcolor: focused ? theme.palette.primary.main : waiting ? theme.palette.warning.main : 'transparent' },
        // Pointer input: the actions show on hover or keyboard focus inside the header (or while its menu is open); the focused column always shows
        // "⋯" and close. Touch input: "⋯" and close are always there, fit and maximize are only in the menu (not drawn at all).
        '& .h5-column-act': { display: 'none' },
        '&:hover .h5-column-act, &:focus-within .h5-column-act, &[data-menu] .h5-column-act': { display: 'inline-flex' },
        '&[data-focused] .h5-column-act[data-keep], html[data-input="touch"] & .h5-column-act[data-keep]': { display: 'inline-flex' },
        '&:hover .h5-column-hint, &:focus-within .h5-column-hint, &[data-menu] .h5-column-hint': { display: 'none' },
      })}>
      {touch ? null : (
        <Box component="span" className="h5-column-grip" aria-hidden="true" title={t('Drag to reorder')} sx={{ display: 'inline-flex', flex: '0 0 auto', color: 'text.disabled', ml: -0.5 }}>
          <Icon name="holder" size={14} />
        </Box>
      )}
      <Dot state={status.state} className="h5-column-dot" />
      {name.tag ? <DeviceTag device={name.tag} /> : null}
      <ButtonBase className="h5-column-switch" aria-haspopup="dialog" aria-expanded={Boolean(info && info.sheet)} title={sheetLabel}
        aria-label={`${[name.title || name.shown, name.session].filter(Boolean).join(' · ')}, ${sheetLabel}`}
        onClick={() => ui.actions.columnAction(id, 'tasks', { toggle: true })}
        sx={theme => ({
          flex: '0 1 auto', minWidth: 0, height: 28, [TOUCH]: { height: 40 }, display: 'flex', alignItems: 'center', gap: 0.75, px: 0.75, borderRadius: '6px', color: 'text.primary',
          '@media (hover: hover)': { '&:hover': { bgcolor: 'action.hover' } }, '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
        })}>
        <ColumnName name={name} />
        <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', flex: '0 0 auto', color: 'text.secondary' }}><Icon name="down" size={12} /></Box>
      </ButtonBase>
      <Box sx={{ flex: '1 1 0', minWidth: 0 }} />
      {waiting ? <Pill className="h5-column-needs" label={t('Needs you')} tone="warning" sx={{ flex: '0 0 auto', height: 22, px: 1, fontSize: 12, fontWeight: 600 }} /> : null}
      {!waiting && agent ? <Box component="span" className="h5-column-hint" sx={{ flex: '0 0 auto', fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>{agent}</Box> : null}
      <Box className="h5-column-actions" sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 0.25, [TOUCH]: { gap: 0 } }}>
        {touch ? null : (
          <IconButton {...act} data-action="width" {...named(t('Wide terminal'))} aria-pressed={wide} disabled={!width}
            sx={wide ? { color: 'primary.light' } : undefined}
            onClick={() => ui.actions.columnAction(id, 'width')} onContextMenu={event => { event.preventDefault(); if (width) onWidthMenu(id, event.currentTarget); }}>
            <Icon name="columnWidth" size={18} />
          </IconButton>
        )}
        {touch ? null : (
          <IconButton {...act} data-action="maximize" {...named(maximizeLabel)} aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter" aria-pressed={maximized}
            onClick={() => ui.actions.toggleMaximize(id)}>
            <Icon name={maximized ? 'restore' : 'maximize'} size={16} />
          </IconButton>
        )}
        <IconButton {...act} data-keep="" data-action="more" {...named(t('Column actions'))} aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={event => onMenu(id, event.currentTarget)}>
          <Icon name="taskMore" size={18} />
        </IconButton>
        <IconButton {...act} data-keep="" data-action="close" {...named(t('Close column'))} disabled={!closable} onClick={() => ui.actions.closeColumn(id)}>
          <Icon name="close" size={14} />
        </IconButton>
      </Box>
    </Box>
  );
}

// The "⋯" menu of a column: everything its header does, so nothing needs a mouse or a hover. Items that act inside the pane move the keyboard
// there (the menu then gives the focus back to nothing on the top page: `disableRestoreFocus`).
function ColumnMenu({ menu, columns, ui, onClose }) {
  const [restore, setRestore] = useState(true);
  const id = menu ? menu.id : null;
  const info = id ? columns.titles[id] : null;
  const width = info && info.width ? info.width : null;
  const terminal = Boolean(info && info.target);
  const open = id ? openOf(columns) : [];
  const maximized = Boolean(id && columns.maximized === id);
  useEffect(() => { if (menu) setRestore(true); }, [menu]);
  const run = (into, action) => { if (into) setRestore(false); onClose(); setTimeout(action, 0); };
  const item = { sx: { minHeight: 36, fontSize: 14, gap: 2, [TOUCH]: { minHeight: 44 } } };
  return (
    <Menu id="h5-column-menu" anchorEl={menu ? menu.anchor : null} open={Boolean(menu)} onClose={onClose} disableRestoreFocus={!restore}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { minWidth: 240 } }, list: { 'aria-label': t('Column actions') } }}>
      <MenuItem {...item} data-action="tasks" onClick={() => run(true, () => ui.actions.columnAction(id, 'tasks'))}>{t('Switch task or session…')}</MenuItem>
      <MenuItem {...item} data-action="width" disabled={!width} onClick={() => run(false, () => ui.actions.columnAction(id, 'width', { mode: width && width.mode === 'wide' ? 'fit' : 'wide' }))}>
        {width && width.mode === 'wide' ? t('Fit the terminal width') : t('Wide terminal')}
      </MenuItem>
      <MenuItem {...item} data-action="maximize" onClick={() => run(false, () => ui.actions.toggleMaximize(id))}>
        <Box component="span" sx={{ flex: '1 1 auto' }}>{maximized ? t('Restore columns') : t('Maximize')}</Box>
        <Box component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>{MAXIMIZE_KEYS}</Box>
      </MenuItem>
      <Divider />
      <MenuItem {...item} data-action="rename" disabled={!terminal} onClick={() => run(true, () => ui.actions.columnAction(id, 'rename'))}>{t('Rename session')}</MenuItem>
      <MenuItem {...item} data-action="restart" disabled={!terminal} onClick={() => run(true, () => ui.actions.columnAction(id, 'restart'))}>{t('Restart session')}</MenuItem>
      <MenuItem {...item} data-action="reload" onClick={() => run(false, () => ui.actions.columnAction(id, 'reload'))}>{t('Reload column')}</MenuItem>
      <Divider />
      <MenuItem {...item} data-action="close" disabled={!canClose(open)} onClick={() => run(false, () => ui.actions.closeColumn(id))} sx={{ ...item.sx, color: 'error.main' }}>{t('Close column')}</MenuItem>
    </Menu>
  );
}

// The width choices of a column's terminal (a right click on its width button), as the normal header's long press: Fit, or 120 / 160 / 200 columns.
function WidthMenu({ menu, columns, ui, onClose }) {
  const info = menu ? columns.titles[menu.id] : null;
  const width = info && info.width ? info.width : null;
  const wide = Boolean(width && width.mode === 'wide');
  const pick = options => { onClose(); ui.actions.columnAction(menu.id, 'width', options); };
  return (
    <Menu id="h5-column-width-menu" anchorEl={menu ? menu.anchor : null} open={Boolean(menu)} onClose={onClose} slotProps={{ list: { 'aria-label': t('Wide terminal') } }}>
      <MenuItem selected={!wide} onClick={() => pick({ mode: 'fit' })} sx={{ minHeight: 36, [TOUCH]: { minHeight: 44 } }}>{t('Fit to screen')}</MenuItem>
      {WIDE_CHOICES.map(cols => (
        <MenuItem key={cols} selected={wide && width.cols === cols} data-cols={cols} onClick={() => pick({ mode: 'wide', cols })} sx={{ minHeight: 36, [TOUCH]: { minHeight: 44 } }}>
          {t(`${cols} columns, scroll sideways`)}
        </MenuItem>
      ))}
    </Menu>
  );
}

// The bar's part about the columns: "N columns ▾" (#h5-columns-list) opens the list of every open column (#h5-columns-list-menu, also those scrolled
// out of view) with its state dot, device tag, task · session and state word; choosing one scrolls it into view and moves the keyboard into it. Then
// how many run (#h5-columns-summary) and, when any needs the person, "N needs you" (#h5-columns-needs), which goes to the first of them.
function ColumnSummary({ columns, open, ui }) {
  const statusOf = useStatusOf(ui, columns);
  const [anchor, setAnchor] = useState(null);
  const [restore, setRestore] = useState(true);
  const sum = summarize(open, statusOf);
  const go = id => { setRestore(false); setAnchor(null); setTimeout(() => ui.actions.showColumn(id, { focusFrame: true }), 0); };
  const count = open.length === 1 ? t('1 column') : t(`${open.length} columns`);
  return (
    <>
      <Button id="h5-columns-list" size="small" color="inherit" variant="outlined" aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? 'h5-columns-list-menu' : undefined}
        title={t('All columns')} endIcon={<Icon name="down" size={12} />}
        onClick={event => { setRestore(true); setAnchor(event.currentTarget); }}
        sx={{ flex: '0 0 auto', height: 28, minWidth: 0, px: 1.25, fontSize: 13, fontWeight: 600, borderColor: 'divider', '& .MuiButton-endIcon': { ml: 0.75, color: 'text.secondary' } }}>
        {count}
      </Button>
      <Menu id="h5-columns-list-menu" anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} disableRestoreFocus={!restore}
        slotProps={{ paper: { sx: { width: 360, maxWidth: 'calc(100vw - 16px)' } }, list: { 'aria-label': t('All columns') } }}>
        {open.map((id, index) => {
          const name = nameOf(columns, id, index);
          const status = statusOf(id);
          const state = listState(status, columns.focus === id);
          return (
            <MenuItem key={id} className="h5-columns-list-item" data-pane-id={id} data-state={state} selected={columns.focus === id} onClick={() => go(id)}
              sx={{ minHeight: 40, gap: 1, [TOUCH]: { minHeight: 44 } }}>
              <Dot state={status.state} />
              {name.tag ? <DeviceTag device={name.tag} /> : null}
              <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.75 }}><ColumnName name={name} /></Box>
              <Box component="span" className="h5-columns-list-state"
                sx={{ flex: '0 0 auto', fontSize: 12, color: state === 'focused' ? 'primary.light' : state === 'waiting' ? 'warning.light' : 'text.secondary' }}>
                {t(LIST_WORDS[state])}
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
      {sum.running ? <Box component="span" id="h5-columns-summary" sx={{ flex: '0 0 auto', fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>{t(`${sum.running} running`)}</Box> : null}
      {sum.first ? (
        <Pill id="h5-columns-needs" tone="warning" onClick={() => ui.actions.showColumn(sum.first, { focusFrame: true })}
          label={<><Dot state="waiting" />{sum.waiting === 1 ? t('1 needs you') : t(`${sum.waiting} need you`)}</>}
          sx={{ flex: '0 0 auto', height: 24, gap: 0.75, fontSize: 12 }} />
      ) : null}
    </>
  );
}

// The rail of a maximized column (#h5-columns-rail, RAIL_WIDTH px on the left; a nav landmark "Other columns"): Restore at the top, then
// one tile per other open column in the order shown: its state dot (green running, orange needs you, grey idle; columns.mjs `columnStatus`, from
// the top page's terminal activity and T-Attention), a short name and a red count of the T-Attention tasks of its terminal that wait for the
// person. Hovering a tile or focusing it shows its peek card beside it: task and session, agent and state, the pending question or the last lines
// of the terminal (asked from that pane), and "Open column". A click on a tile (or Open column) restores the columns and focuses that one.
// Escape in the rail closes the peek, else restores. The columns behind the tiles stay mounted and connected (see ColumnStrip).
const RAIL_KEYS = ['columns', 'attention', 'terminalActivity'];
const PEEK_DELAY_MS = 250;
const PEEK_WIDTH = 300;
const tileWords = (info, status) => {
  const agent = info && AGENT_NAMES[info.agent] ? AGENT_NAMES[info.agent] : '';
  return [agent, t(STATE_WORDS[status.state])].filter(Boolean).join(' ');
};
function ColumnRail({ ui }) {
  const state = useStoreKeys(ui, RAIL_KEYS);
  const columns = state.columns;
  const [peek, setPeek] = useState(null); // { id, top }
  const timer = useRef(0);
  const quiet = useRef(null); // a tile given the focus back by Escape: no peek for that focus
  const tiles = railColumns(columns, columns.maximized);
  const open = openOf(columns);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (peek && !tiles.includes(peek.id)) setPeek(null); }, [peek, tiles.join(',')]);
  const show = (id, el) => {
    clearTimeout(timer.current);
    const box = el.getBoundingClientRect();
    setPeek(now => (now && now.id === id ? now : { id, top: Math.max(8, Math.min(box.top, window.innerHeight - 260)) }));
    ui.actions.peekColumn(id);
  };
  const hoverIn = (id, el) => { clearTimeout(timer.current); timer.current = setTimeout(() => show(id, el), PEEK_DELAY_MS); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPeek(null), PEEK_DELAY_MS); };
  const openColumn = id => { setPeek(null); ui.actions.restoreColumns({ focus: id }); };
  const onKeyDown = event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (peek) {
      const tile = document.querySelector(`#h5-columns-rail .h5-rail-tile[data-pane-id="${peek.id}"]`);
      const inCard = Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.h5-rail-peek'));
      clearTimeout(timer.current);
      setPeek(null);
      if (tile && inCard) { quiet.current = peek.id; tile.focus(); }
      return;
    }
    ui.actions.restoreColumns({ focus: columns.maximized });
  };
  const restoreLabel = t('Restore columns');
  return (
    <Box component="nav" id="h5-columns-rail" aria-label={t('Other columns')} onKeyDown={onKeyDown}
      sx={{ flex: `0 0 ${RAIL_WIDTH}px`, width: RAIL_WIDTH, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, py: 0.5,
        bgcolor: '#1a1a1a', borderRight: 1, borderColor: 'divider', overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
      <IconButton id="h5-columns-restore" {...named(restoreLabel)} aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter Escape"
        onClick={() => ui.actions.restoreColumns({ focus: columns.maximized })} sx={{ flex: '0 0 auto' }}>
        <Icon name="restore" size={20} />
      </IconButton>
      <Box component="ul" role="list" sx={{ listStyle: 'none', m: 0, p: 0, width: '100%', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {tiles.map(id => {
          const info = columns.titles[id];
          const status = columnStatus(info, { activity: state.terminalActivity, items: state.attention && state.attention.items });
          const own = columnName(info);
          const name = own || t(`Column ${open.indexOf(id) + 1}`);
          const label = `${name}, ${tileWords(info, status)}`;
          return (
            <Box component="li" key={id} sx={{ px: 0.5 }} onMouseLeave={leave} onMouseEnter={() => { if (peek && peek.id === id) clearTimeout(timer.current); }}>
              <ButtonBase className="h5-rail-tile" data-pane-id={id} data-state={status.state} aria-label={label} title={label}
                aria-describedby={peek && peek.id === id ? 'h5-rail-peek' : undefined}
                onClick={() => openColumn(id)}
                onMouseEnter={event => hoverIn(id, event.currentTarget)}
                onFocus={event => { if (quiet.current === id) { quiet.current = null; return; } show(id, event.currentTarget); }}
                onBlur={event => { if (!event.relatedTarget || !event.relatedTarget.closest || !event.relatedTarget.closest('.h5-rail-peek')) leave(); }}
                sx={theme => ({
                  position: 'relative', width: '100%', minHeight: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0.5,
                  px: 0.5, py: 0.75, borderRadius: '8px', color: 'text.secondary', fontSize: 11, lineHeight: 1.2,
                  backgroundColor: peek && peek.id === id ? theme.palette.action.selected : 'transparent',
                  '@media (hover: hover)': { '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.text.primary } },
                  '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
                })}>
                <Box component="span" aria-hidden="true" className="h5-rail-dot" sx={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', bgcolor: STATE_COLORS[status.state] }} />
                <Box component="span" aria-hidden="true" className="h5-rail-name" translate={own ? 'no' : undefined}
                  sx={{ maxWidth: '100%', overflow: 'hidden', textAlign: 'center', wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {name}
                </Box>
                {status.count ? (
                  <Box component="span" aria-hidden="true" className="h5-rail-badge"
                    sx={{ position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, px: '4px', borderRadius: '8px', bgcolor: '#f44336', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center' }}>
                    {status.count > 99 ? '99+' : status.count}
                  </Box>
                ) : null}
              </ButtonBase>
              {peek && peek.id === id ? (
                <PeekCard id={id} top={peek.top} info={info} status={status} name={name} lines={columns.tails[id] || []}
                  onOpen={() => openColumn(id)} onEnter={() => clearTimeout(timer.current)} onLeave={leave} />
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// The peek card of a rail tile: fixed beside the rail, next to its tile. Answering a permission prompt from here is not offered: the page does not
// know the prompt's options (T-Attention gives the question text only), so the card opens the column instead.
function PeekCard({ id, top, info, status, name, lines, onOpen, onEnter, onLeave }) {
  const session = info && info.title && info.session ? info.session : '';
  const words = tileWords(info, status);
  return (
    <Box id="h5-rail-peek" className="h5-rail-peek" data-pane-id={id} role="group" aria-label={name} onMouseEnter={onEnter} onMouseLeave={onLeave}
      onBlur={event => { if (!event.relatedTarget || !event.currentTarget.parentElement.contains(event.relatedTarget)) onLeave(); }}
      sx={theme => ({
        position: 'fixed', left: NAV_WIDTH + RAIL_WIDTH + 8, top, zIndex: 3, width: PEEK_WIDTH, maxWidth: `calc(100vw - ${NAV_WIDTH + RAIL_WIDTH + 24}px)`, boxSizing: 'border-box', p: 1.5,
        display: 'flex', flexDirection: 'column', gap: 1, borderRadius: '8px', bgcolor: theme.palette.background.paper,
        backgroundImage: 'linear-gradient(rgba(255,255,255,0.08), rgba(255,255,255,0.08))', boxShadow: theme.shadows[8], border: 1, borderColor: 'divider',
      })}>
      <Box>
        <Box className="h5-rail-peek-name" translate="no" sx={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Box>
        {session ? <Box translate="no" sx={{ fontSize: 12, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session}</Box> : null}
        <Box className="h5-rail-peek-state" sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.75, fontSize: 12, color: 'text.secondary' }}>
          <Box component="span" aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATE_COLORS[status.state] }} />
          <span>{words}</span>
        </Box>
      </Box>
      {status.question ? (
        <Box className="h5-rail-peek-question" translate="no" sx={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'hidden' }}>{status.question}</Box>
      ) : lines.length ? (
        <Box component="pre" className="h5-rail-peek-lines" translate="no"
          sx={{ m: 0, p: 1, fontSize: 11, lineHeight: 1.35, fontFamily: 'Menlo, Consolas, monospace', bgcolor: '#121212', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'hidden' }}>
          {lines.join('\n')}
        </Box>
      ) : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <ButtonBase className="h5-rail-peek-open" onClick={onOpen}
          sx={theme => ({ px: 1.5, py: 0.75, borderRadius: '6px', fontSize: 13, fontWeight: 600, color: theme.palette.primary.light, '&:hover': { backgroundColor: theme.palette.action.hover }, '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } })}>
          {t('Open column')}
        </ButtonBase>
      </Box>
    </Box>
  );
}

// The navigation rail of the page (#h5-columns-nav, a nav landmark "Views", NAV_WIDTH px, full height; MD2 navigation rail), shown on the wide layout in
// the single view and in the columns view alike, at the left edge (fixed, above the columns view). Destinations with an icon over a caption label:
// Sessions (the single view; in the columns view it leaves the view), Columns and Mind maps (the two tabs of the columns view; Columns carries a red
// badge with the number of open columns that need the person), and Attention (shows or hides the T-Attention panel on the right, active while it is
// open, with a red badge of the items that need the person). At the bottom: Update (the page's one updater, `UpdateButton`, with its red dot) and
// Settings (current while Settings is open). The current page is in the primary colour with a 3px indicator and `aria-current="page"`; choosing any
// destination while Settings is open closes Settings first. Each destination is a Tab stop; the arrow keys and Home / End move between them
// (`railKey`); Enter or Space opens one. The element stays mounted on a narrow screen, hidden (`display: none`), so the updater inside it keeps its one
// poll across a resize; a pane has no rail. See "Navigation rail" in docs/design/page-navigation.md.
const NAV = state => {
  const columns = state.columns;
  const shown = Boolean(columns && columns.shown);
  const live = { activity: state.terminalActivity, items: state.attention && state.attention.items };
  return {
    wide: state.wide, pane: state.pane, canColumns: Boolean(columns),
    view: railView({ settingsOpen: state.settingsOpen, columns }),
    attentionOpen: Boolean(state.attention && state.attention.open),
    attentionNeeds: Number(state.attention && state.attention.needs) || 0,
    // Only while the view is shown: the panes' titles are what the count is about.
    columnsNeeds: shown ? needsCount(openOf(columns), id => columnStatus(columns.titles[id], live)) : 0,
  };
};
const RAIL_ITEM_SX = (current, active) => theme => ({
  position: 'relative', width: NAV_WIDTH, height: 56, flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0.5,
  color: current || active ? theme.palette.primary.main : theme.palette.text.secondary,
  backgroundColor: active ? alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) : 'transparent',
  '@media (hover: hover)': { '&:hover': { backgroundColor: active ? alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity + theme.palette.action.hoverOpacity) : theme.palette.action.hover } },
  '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
  '&::before': { content: '""', position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: '0 3px 3px 0', bgcolor: current ? theme.palette.primary.main : 'transparent' },
});
const RAIL_ACTION_SX = { flex: '0 0 auto', width: 48, height: 48, color: 'text.secondary' };
export function NavRail({ ui }) {
  const state = useStore(ui, NAV, shallowEqual);
  countRender('NavRail');
  const shown = state.wide && !state.pane;
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-nav-rail', shown);
    measureTerminalBox(); // the page moved right by the rail's width, in the same frame
    return () => document.documentElement.removeAttribute('data-nav-rail');
  }, [shown]);
  if (state.pane) return null;
  // Settings goes away before any other destination is shown.
  const leaveSettings = () => { if (ui.get().settingsOpen && ui.actions.closeSettings) ui.actions.closeSettings(); };
  const choose = item => {
    const settings = ui.get().settingsOpen;
    leaveSettings();
    if (item.view === 'attention') {
      const open = Boolean(ui.get().attention && ui.get().attention.open);
      if (open && !settings) ui.actions.closeAttention();
      else if (!open) ui.actions.openAttention();
      return;
    }
    if (state.canColumns && ui.actions.showView) { ui.actions.showView(item.view); return; }
    if (item.view === 'maps' && ui.actions.openMindmaps) ui.actions.openMindmaps(); // no columns view here: the mind maps over the whole window
  };
  const onKeyDown = event => {
    const buttons = [...event.currentTarget.querySelectorAll('.h5-nav-item')];
    const at = buttons.indexOf(document.activeElement);
    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = railKey(event.key, at, buttons.length);
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
  };
  const needsWords = (count, one, many) => (count === 1 ? t(one) : t(many.replace('{1}', count)));
  const settingsLabel = t('Settings');
  const settingsCurrent = state.view === 'settings';
  return (
    <Box component="nav" id="h5-columns-nav" aria-label={t('Views')} onKeyDown={onKeyDown}
      sx={theme => ({ position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 1260, width: NAV_WIDTH, boxSizing: 'border-box', display: shown ? 'flex' : 'none',
        flexDirection: 'column', alignItems: 'center', pt: 'max(8px, env(safe-area-inset-top))', pb: 'max(8px, env(safe-area-inset-bottom))', gap: 0.5,
        bgcolor: 'background.paper', backgroundImage: overlay(1), borderRight: 1, borderColor: 'divider', overflowY: 'auto', overflowX: 'hidden',
        scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, color: theme.palette.text.secondary })}>
      {railDestinations(state.canColumns).map(item => {
        const current = state.view === item.view;
        const active = Boolean(item.toggle && state.attentionOpen);
        const badge = item.view === 'columns' ? state.columnsNeeds : item.view === 'attention' ? state.attentionNeeds : 0;
        const label = t(item.label);
        const words = !badge ? '' : item.view === 'columns' ? needsWords(badge, '1 needs you', '{1} need you') : needsWords(badge, '1 item needs you', '{1} items need you');
        return (
          <ButtonBase key={item.view} id={item.id} className="h5-nav-item" data-view={item.view} data-tab={state.canColumns && (item.view === 'columns' || item.view === 'maps') ? item.view : undefined}
            aria-current={current ? 'page' : undefined} aria-expanded={item.toggle ? state.attentionOpen : undefined} data-active={active ? '' : undefined}
            aria-label={words ? `${label}, ${words}` : label} onClick={() => choose(item)} sx={RAIL_ITEM_SX(current, active)}>
            <Badge className="h5-nav-badge" badgeContent={badge} max={99} color="error" invisible={!badge} overlap="circular"
              slotProps={{ badge: { 'aria-hidden': 'true', id: item.view === 'columns' ? 'h5-nav-needs' : item.view === 'attention' ? 'h5-nav-attention-count' : undefined } }}>
              <Icon name={item.icon} size={24} />
            </Badge>
            <Box component="span" className="h5-nav-label" aria-hidden="true" sx={theme => ({ ...theme.typography.caption, fontWeight: 500, lineHeight: '16px', letterSpacing: '0.4px' })}>{label}</Box>
          </ButtonBase>
        );
      })}
      <Box sx={{ flex: '1 1 auto' }} />
      {/* The updater of the page (polling, the dialog, the silent reload after an automatic update): one, here, on every layout (hidden with the rail on a
          narrow screen, where the header's "More" menu opens its dialog through ui.actions.openUpdate). */}
      <Box className="h5-nav-update" sx={{ display: 'flex', '& #h5-update': RAIL_ACTION_SX, '& #h5-update svg': { fontSize: 22 } }}>
        <UpdateButton ui={ui} />
      </Box>
      <ButtonBase id="h5-nav-settings" className="h5-nav-item" data-view="settings" {...named(settingsLabel)} aria-current={settingsCurrent ? 'page' : undefined}
        onClick={() => { if (!ui.get().settingsOpen) ui.actions.openSettings(); }}
        sx={theme => ({ ...RAIL_ACTION_SX, borderRadius: '50%', color: settingsCurrent ? theme.palette.primary.main : theme.palette.text.secondary,
          backgroundColor: settingsCurrent ? alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) : 'transparent',
          '@media (hover: hover)': { '&:hover': { backgroundColor: theme.palette.action.hover } },
          '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } })}>
        <Icon name="setting" size={22} />
      </ButtonBase>
    </Box>
  );
}

// The Mind maps tab (#h5-columns-maps): the page's own mind map view (public/js/mindmap.js, scripts/mindmap/), mounted in its inner element by h5.js
// (`mountMindmapTab`) with the list beside the open map. Mounted the first time the tab is shown and kept while the view is shown: hidden with
// `visibility: hidden` like the Columns tab, so the open map, its unsaved edits and the list survive a switch. `setMindmapTabActive` tells the view
// whether its keys are its own.
function MapsTab({ ui, active }) {
  const host = useRef(null);
  // On a page that starts on this tab the element is drawn before h5.js has run: h5.js mounts it itself when it starts.
  useLayoutEffect(() => {
    if (ui.actions.mountMindmapTab) ui.actions.mountMindmapTab(host.current, active);
    return () => { if (ui.actions.unmountMindmapTab) ui.actions.unmountMindmapTab(); };
  }, [ui]);
  useEffect(() => { if (ui.actions.setMindmapTabActive) ui.actions.setMindmapTabActive(active); }, [ui, active]);
  // The view is mounted in an inner element whose props never change: React would reset the class and attributes the view puts on its root.
  return (
    <Box id="h5-columns-maps" data-active={active ? '' : undefined} aria-hidden={active ? undefined : 'true'}
      sx={{ position: 'absolute', inset: 0, visibility: active ? 'visible' : 'hidden' }}>
      <div id="h5-columns-maps-view" ref={host} />
    </Box>
  );
}

const STRIP_KEYS = ['columns', 'wide', 'pane', 'input'];
// The drag of a column by its header: its place is dimmed with a dashed outline, a lifted copy of the header follows the pointer and a primary line
// shows where it lands (tab-drag.jsx); the iframes take no pointer events meanwhile, so the pointer is never lost to a page under it.
const DRAG_SX = theme => ({
  '& .h5-column[data-drag-slot] > iframe': { opacity: 0.55 },
  '& .h5-column[data-drag-slot]::after': {
    content: '""', position: 'absolute', inset: 0, pointerEvents: 'none', border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.6)}`,
  },
  '& .h5-column-drop-line': { position: 'absolute', top: 0, bottom: 0, left: 0, width: 3, borderRadius: '2px', zIndex: 4, pointerEvents: 'none', bgcolor: 'primary.main' },
  '& .h5-column-head-float': { position: 'fixed', left: 0, top: 0, zIndex: 5, pointerEvents: 'none', willChange: 'transform' },
  '& .h5-column-head-float-body': {
    height: '100%', overflow: 'hidden', borderRadius: '4px', bgcolor: 'background.paper', backgroundImage: overlay(8),
    boxShadow: 'none', transformOrigin: '50% 50%', transition: `transform ${SETTLE_MS}ms ease-out, box-shadow ${SETTLE_MS}ms ease-out`,
  },
  '& .h5-column-head-float-body > .h5-column-head': { height: '100%' },
  '& .h5-column-head-float-lifted': { transform: 'scale(1.02)', boxShadow: `${theme.shadows[8]}, 0 0 0 1px ${alpha(theme.palette.primary.main, 0.45)}` },
  '@media (prefers-reduced-motion: reduce)': { '& .h5-column-head-float-body': { transition: 'none' } },
});
const NO_FRAME_POINTER = { 'html[data-column-drag] #h5-columns iframe': { pointerEvents: 'none' } };

export function ColumnStrip({ ui }) {
  const state = useStoreKeys(ui, STRIP_KEYS);
  countRender('ColumnStrip');
  const columns = state.columns;
  const shown = Boolean(columns && columns.shown);
  const touch = state.input === 'touch';
  const root = useRef(null);
  const strip = useRef(null);
  const count = useRef(0);
  const mounted = useRef([]);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const [menu, setMenu] = useState(null); // the "⋯" menu: { id, anchor }
  const [widthMenu, setWidthMenu] = useState(null); // the width choices: { id, anchor }
  // The strip's visible width, observed: each column is at least a quarter of it (and at least MIN_COLUMN_WIDTH; minColumnWidth in columns.mjs), so
  // up to four share it evenly and more scroll sideways. Before the first measurement the window's width stands in for it.
  const [stripWidth, setStripWidth] = useState(() => stripWidthOf(window.innerWidth));
  const columnWidth = minColumnWidth(stripWidth);
  const maximized = shown ? columns.maximized : null;
  const tab = shown ? columns.tab : 'columns';
  // The Mind maps tab is mounted the first time it is shown and kept (hidden) while the view is shown.
  const [mapsMounted, setMapsMounted] = useState(() => shown && tab === 'maps');
  useEffect(() => { if (shown && tab === 'maps') setMapsMounted(true); else if (!shown) setMapsMounted(false); }, [shown, tab]);
  const wasMaximized = useRef(null);
  const drag = useTabDrag(strip, root, { drop: (id, index) => ui.actions.moveColumnTo(id, index), say });
  // Back from a maximized column: the strip's sideways scroll comes back as it was (the widths need nothing: the strip has its full width again and
  // the width it had was never measured anew while the rail took part of it).
  useLayoutEffect(() => {
    const el = strip.current;
    if (wasMaximized.current && !maximized && el) el.scrollLeft = frozen.scroll;
    wasMaximized.current = maximized;
  }, [maximized]);
  useLayoutEffect(() => {
    if (!shown) return undefined;
    document.documentElement.setAttribute('data-columns', '');
    return () => document.documentElement.removeAttribute('data-columns');
  }, [shown]);
  // A click into a column moves the focus into its iframe, which the top page sees only as its own blur and a new active element (no event
  // comes out of the frame): checked on blur and every FOCUS_CHECK_MS while the strip is shown, acting only when the active element changed. The
  // panes may also say 'focus' themselves.
  useEffect(() => {
    if (!shown) return undefined;
    let seen = document.activeElement;
    const check = () => {
      const el = document.activeElement;
      if (el === seen) return;
      seen = el;
      if (el && el.tagName === 'IFRAME' && el.dataset.paneId) ui.actions.focusColumn(el.dataset.paneId);
    };
    const soon = () => setTimeout(check, 0);
    window.addEventListener('blur', soon);
    const timer = setInterval(check, FOCUS_CHECK_MS);
    return () => { window.removeEventListener('blur', soon); clearInterval(timer); };
  }, [shown, ui]);
  const open = columns ? openOf(columns) : [];
  const order = open.join(',');
  // A new order slides the columns to their places (their elements stay where they are in the DOM; only their CSS `order` changed). Nothing slides while
  // a header is being dragged.
  useFlipX(strip, { items: columnsOf, key: paneKey, busy: drag.busy });
  // Whether the columns overflow and which edges hide some (the edge shadows and `data-overflow`): on scroll, on a resize, and when the columns or
  // their order change.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!shown || !el) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (el.clientWidth > 0 && !el.hasAttribute('data-maximized')) setStripWidth(el.clientWidth);
      const next = { overflow: el.scrollWidth > el.clientWidth + 1, ...hiddenEdges(el) };
      setEdges(now => (now.overflow === next.overflow && now.left === next.left && now.right === next.right ? now : next));
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    el.addEventListener('scroll', soon, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    if (observer) observer.observe(el);
    return () => { el.removeEventListener('scroll', soon); if (observer) observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [shown, order, columnWidth, maximized]);
  // A new column is scrolled into view (it is the last one).
  useEffect(() => {
    const grew = open.length > count.current && count.current > 0;
    count.current = open.length;
    if (grew) revealColumn(open[open.length - 1]);
  }, [open.length]);
  // A column that takes the focus (a click, the column list, the keys, an open request) is scrolled whole into view when part of it is hidden.
  const focus = columns ? columns.focus : null;
  useEffect(() => { if (shown && focus) revealColumn(focus); }, [shown, focus]);
  // A sideways wheel or Shift+wheel over the top bar or a column's header scrolls the strip (inside a pane the pane forwards it, pane.mjs).
  useEffect(() => {
    const el = root.current;
    if (!shown || !el) return undefined;
    const onWheel = event => {
      if (!event.target.closest || !event.target.closest('#h5-columns-bar, .h5-column-head')) return;
      const dx = sidewaysDelta(event, window.innerWidth);
      if (!dx) return;
      event.preventDefault();
      scrollStrip(dx);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [shown]);
  // A menu whose column went away closes.
  useEffect(() => { if (menu && !open.includes(menu.id)) setMenu(null); if (widthMenu && !open.includes(widthMenu.id)) setWidthMenu(null); }, [order]);
  if (!shown) return null;
  // The columns' elements in the order they were created (never moved: an iframe moved in the DOM reloads), each shown at its place by `order`.
  mounted.current = mountOrder(mounted.current, columns.ids);
  const closable = canClose(open);
  const shadow = side => ({ ...EDGE, [side]: 0, bottom: edges.overflow ? SCROLLBAR : 0, opacity: edges[side] ? 1 : 0,
    borderLeft: side === 'left' ? '1px solid rgba(255,255,255,0.22)' : 0, borderRight: side === 'right' ? '1px solid rgba(255,255,255,0.22)' : 0,
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(255,255,255,0.13), rgba(255,255,255,0))` });
  // The tab that is not shown stays mounted at the same size, with `visibility: hidden` (never `display: none` or an unmount): the columns' pages keep
  // their layout, their terminals their size and their sockets, and come back without a reload; the mind map keeps its open map.
  const columnsShownNow = tab === 'columns';
  return (
    <Box id="h5-columns" ref={root} role="region" aria-label={t('Multi-column view')} data-tab={tab}
      // Right of the navigation rail (NavRail, drawn by App above this view), to the window's right edge (the T-Attention side sheet floats over it).
      sx={theme => ({ position: 'fixed', top: 0, bottom: 0, left: NAV_WIDTH, right: 0, zIndex: 1250, display: 'flex', flexDirection: 'row', bgcolor: 'background.default', color: 'text.primary', ...DRAG_SX(theme) })}>
      <GlobalStyles styles={HIDE_PAGE} />
      <GlobalStyles styles={STRIP_SCROLLBAR} />
      <GlobalStyles styles={NO_FRAME_POINTER} />
      <Box id="h5-columns-views" sx={{ flex: '1 1 auto', minWidth: 0, position: 'relative' }}>
        <Box id="h5-columns-tab" data-active={columnsShownNow ? '' : undefined} aria-hidden={columnsShownNow ? undefined : 'true'}
          sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', visibility: columnsShownNow ? 'visible' : 'hidden' }}>
          {/* The app bar of the Columns tab (MD2 dense app bar, the colour of the page's own header): the columns, then "+ Column". */}
          <Box id="h5-columns-bar" sx={theme => ({ flex: '0 0 auto', minHeight: 40, [TOUCH]: { minHeight: 48 }, display: 'flex', alignItems: 'center', gap: 1, px: 1.5,
            bgcolor: theme.palette.grey[900], borderBottom: 1, borderColor: 'divider' })}>
            <ColumnSummary columns={columns} open={open} ui={ui} />
            <Box sx={{ flex: '1 1 auto' }} />
            <Button id="h5-columns-add" size="small" color="inherit" aria-label={t('Add column')} title={t('Add column')} disabled={!canAdd(open)} onClick={() => ui.actions.addColumn()}
              startIcon={<Icon name="add" size={14} />} sx={{ flex: '0 0 auto', height: 30, px: 1.25, fontSize: 13, fontWeight: 600, bgcolor: 'action.selected', '&:hover': { bgcolor: 'action.focus' } }}>
              {t('Column')}
            </Button>
          </Box>
          <Box sx={{ flex: '1 1 auto', minHeight: 0, position: 'relative', display: 'flex' }}>
            {maximized ? <ColumnRail ui={ui} /> : null}
            <Box id="h5-columns-strip" ref={strip} className="h5-columns-scroll" data-overflow={edges.overflow ? '' : undefined} data-maximized={maximized ? '' : undefined}
              style={{ '--h5-column-min': `${columnWidth}px` }}
              sx={{ flex: '1 1 auto', minWidth: 0, position: 'relative', display: 'flex', overflowX: maximized ? 'hidden' : 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain' }}>
              {mounted.current.map(id => {
                const closing = columns.closing.includes(id);
                const focused = columns.focus === id;
                const place = open.indexOf(id);
                const info = columns.titles[id];
                const label = t(`Column ${place + 1}`);
                const name = info && info.title ? [info.title, info.session].filter(Boolean).join(' · ') : '';
                // While a column is maximized it fills the strip; every other column stays mounted at the width it had, out of sight under it
                // (`visibility: hidden`, not `display: none`: its page keeps its layout and size, its socket and its messages).
                const railed = Boolean(maximized && id !== maximized && !closing);
                const look = maximized === id ? { flex: '1 1 auto', minWidth: 0, borderLeft: 0 }
                  : railed ? { position: 'absolute', top: 0, bottom: 0, left: 0, boxSizing: 'border-box', width: frozen.widths.get(id) || columnWidth, borderLeft: place > 0 ? 1 : 0, visibility: 'hidden', pointerEvents: 'none' }
                    : { flex: `1 0 ${columnWidth}px`, minWidth: columnWidth, borderLeft: place > 0 ? 1 : 0 };
                // The pages of the columns that are not focused are slightly dimmed (while one is focused); their text stays readable.
                const dim = Boolean(columns.focus && !focused && !closing);
                return (
                  <Box key={id} className="h5-column" data-pane-id={id} data-focused={focused ? '' : undefined} data-ready={columns.ready[id] ? '' : undefined}
                    data-maximized={maximized === id ? '' : undefined} data-railed={railed ? '' : undefined} aria-hidden={railed ? 'true' : undefined}
                    onPointerDown={() => ui.actions.focusColumn(id)} style={{ order: closing ? MAX_ORDER : place }}
                    sx={{ display: closing ? 'none' : 'flex', flexDirection: 'column', position: 'relative', ...look, borderColor: 'divider' /* after `look`: its border shorthand would reset the colour */ }}>
                    {closing ? null : (
                      <ColumnHeader id={id} index={place} columns={columns} closable={closable} touch={touch} ui={ui} drag={drag}
                        menuOpen={Boolean(menu && menu.id === id)} onMenu={(which, anchor) => setMenu({ id: which, anchor })} onWidthMenu={(which, anchor) => setWidthMenu({ id: which, anchor })} />
                    )}
                    <Box component="iframe" src={paneUrl(id)} title={name ? `${label}: ${name}` : label} data-pane-id={id} data-dim={dim ? '' : undefined}
                      allow="clipboard-read; clipboard-write; microphone; screen-wake-lock" onLoad={event => ui.actions.columnLoaded(id, event.currentTarget)}
                      sx={{ flex: '1 1 auto', minHeight: 0, width: '100%', border: 0, display: 'block', bgcolor: 'background.default',
                        filter: dim ? 'brightness(0.9)' : 'none', transition: 'filter 120ms ease-out', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }} />
                  </Box>
                );
              })}
            </Box>
            <Box aria-hidden="true" className="h5-columns-edge" data-side="left" data-shown={edges.left ? '' : undefined} sx={shadow('left')} />
            <Box aria-hidden="true" className="h5-columns-edge" data-side="right" data-shown={edges.right ? '' : undefined} sx={shadow('right')} />
          </Box>
        </Box>
        {mapsMounted ? <MapsTab ui={ui} active={!columnsShownNow} /> : null}
      </Box>
      <ColumnMenu menu={menu} columns={columns} ui={ui} onClose={() => setMenu(null)} />
      <WidthMenu menu={widthMenu} columns={columns} ui={ui} onClose={() => setWidthMenu(null)} />
      <Box id="h5-columns-live" aria-live="polite" aria-atomic="true" sx={VISUALLY_HIDDEN} />
    </Box>
  );
}

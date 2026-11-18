import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import GlobalStyles from '@mui/material/GlobalStyles';
import IconButton from '@mui/material/IconButton';
import { alpha } from '@mui/material/styles';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { DeviceTag } from './TaskDrawer.jsx';
import { ColumnsUpdateButton } from './Update.jsx';
import { SETTLE_MS } from './list-drag.jsx';
import { useFlipX, useTabDrag } from './tab-drag.jsx';
import { countRender, useStoreKeys } from './use-store.mjs';
import {
  STORAGE_KEY, newId, canAdd, canClose, canOfferColumns, columnMove, columnStep, columnsFor, forgetMessage, hiddenEdges, minColumnWidth, mountOrder,
  moveColumn, openMessage, paneUrl, readLayout, readPaneMessage, revealLeft, shiftColumn, sidewaysDelta, stepTarget, tagOf, targetColumn, writeLayout,
  AGENT_NAMES, MESSAGE_TYPE, RAIL_WIDTH, STATE_WORDS, addMapColumn, canMaximize, columnName, columnStatus, keptMaximized, mapKeyOf, maximizeKey,
  railColumns, toggleMaximize, writeMapColumn,
} from './columns.mjs';

// The multi-column view of a wide screen: the top page shows a row of iframes of itself in pane mode (`/h5?pane=<id>`), each a whole copy of the page
// with its own header, terminal, draft box and tool row, and the person goes back to the normal view with the same button. The top page keeps one
// activity feed, one notifier and one updater; while the strip is shown its own terminal is hidden and holds no socket (h5.js, `columns.shown`).
// The rules (ids, order, the message format) are in columns.mjs; "Multi-column view" in docs/design/page-shell-and-columns.md.
//
// state.columns: null on a page that never offers the view (a pane, or any page inside a frame), else
//   { enabled (the person's choice, remembered), shown (enabled and the screen is wide), ids (in order), focus (an id or null),
//     titles ({ id: { title, session, device?, map?, target?, agent? } } from the panes), ready ({ id: true } once the pane said so), closing ([id] being
//     closed), maximized (the id of a mind map column that fills the strip, or null; not stored), tails ({ id: [line] }, the last lines a pane sent
//     for the peek card of its tile) }
// `ids` is the order the person sees (the tabs, the columns from left to right, the keys, storage). The columns' elements never follow it: each keeps the
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
// While a mind map column is maximized, the other columns stay mounted and connected at the width they had (so their pages see no resize and their
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
  const get = () => ui.get().columns;
  const put = patch => {
    const before = get();
    const next = { ...before, ...patch };
    next.shown = next.enabled && wideQuery.matches;
    next.maximized = keptMaximized(next); // a maximized column that was closed, stopped showing a map, or a strip that went away: restored
    ui.set({ columns: next });
    writeStored(writeLayout({ on: next.enabled, ids: next.ids.filter(id => !next.closing.includes(id)) }));
    if (before && before.maximized !== next.maximized) {
      if (before.maximized) postTo(before.maximized, { event: 'maximized', on: false });
      if (next.maximized) postTo(next.maximized, { event: 'maximized', on: true });
      say(next.maximized ? 'Column maximized. The other columns are in the rail.' : 'Columns restored');
    }
  };
  ui.set({ columns: { enabled: false, shown: false, ids: [], focus: null, titles: {}, ready: {}, closing: [], maximized: null, tails: {} } });
  put({ enabled: stored.on, ids: stored.on ? columnsFor(stored.ids, window.innerWidth) : stored.ids });
  wideQuery.addEventListener('change', () => put({}));

  ui.actions.toggleColumns = () => {
    const now = get();
    if (now.enabled) { put({ enabled: false, focus: null }); return; }
    put({ enabled: true, focus: null, ids: columnsFor(now.ids.filter(id => !now.closing.includes(id)), window.innerWidth) }); // the focus is not taken: the person clicks a column
  };
  ui.actions.addColumn = () => {
    const now = get();
    const open = now.ids.filter(id => !now.closing.includes(id));
    if (!canAdd(open)) return;
    put({ ids: [...now.ids, newId(now.ids)], maximized: null }); // a column being closed is still mounted: its id is not given out again
  };
  // "Add mind map column": a new column at the end whose pane starts on the list of maps. What a column shows is its pane's to remember
  // (`pane:<id>:h5-mindmap`, pane.mjs), so it is written there before the iframe exists. The new column takes the focus (outlined, scrolled into view).
  ui.actions.addMapColumn = () => {
    const now = get();
    if (!now || !now.shown) return;
    const made = addMapColumn(openOf(now), now.ids);
    if (!made) return;
    try { localStorage.setItem(mapKeyOf(made.id), writeMapColumn({ screen: 'list' })); } catch { /* the column starts on its task list instead */ }
    put({ ids: made.ids, focus: made.id, maximized: null });
  };
  // Maximize: one column (any: a terminal, a chat, a mind map) fills the strip and the other columns become the rail (ColumnRail). Their widths and
  // the strip's scroll are kept first, so they stay as they were and come back exactly. Restore: back to the strip; `focus` (a tile, Open column)
  // takes the focus into that column, and a focus that was in the rail goes into the maximized column (the rail is gone). These two actions are the one
  // entry point: the map's Maximize button and Cmd/Ctrl+Shift+Enter (the top page's key, or 'maximize' from a pane) go through `toggleMaximize`.
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
    if (!now || !now.shown) return;
    if (now.maximized) { ui.actions.restoreColumns({ focus: stepTarget(openOf(now), now.focus, step) }); return; }
    const id = stepTarget(now.ids.filter(item => !now.closing.includes(item)), now.focus, step);
    if (!id) return;
    if (now.focus !== id) put({ focus: id });
    const frame = frameOf(id);
    try { if (frame) frame.focus(); } catch { /* gone */ }
    revealColumn(id);
  };
  ui.actions.scrollColumns = dx => { if (get() && get().shown) scrollStrip(dx); };
  // A tab tapped or clicked: that column takes the focus and is scrolled into view; a pointer click also moves the keyboard into its frame (a key press on
  // the tab leaves the focus on the tab).
  ui.actions.showColumn = (id, { focusFrame = false } = {}) => {
    const now = get();
    if (!now || !now.shown || !openOf(now).includes(id)) return;
    if (now.maximized && now.maximized !== id) { ui.actions.restoreColumns({ focus: id }); return; } // another column's tab: back to the strip
    if (now.focus !== id) put({ focus: id });
    if (focusFrame) { const frame = frameOf(id); try { if (frame) frame.focus(); } catch { /* gone */ } }
    revealColumn(id);
  };
  // A new place for a column (a tab dropped, Ctrl+Alt+Shift+Left / Right): the order is saved at once, the tabs and the columns slide to their places
  // (useFlipX), the column keeps (or takes) the focus and is scrolled into view, and the move is said. A tab with the keyboard focus that React moved
  // in the DOM lost it: it gets it back.
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
    if (!now || !now.shown || now.maximized || !which || !openOf(now).includes(which)) return; // no moves while a column is maximized
    reorder(which, shiftColumn(openOf(now), which, step));
  };
  window.addEventListener('keydown', event => {
    // Cmd/Ctrl+Shift+Enter on the top page (a tab, the rail): maximize the focused column, or restore. Inside a column the pane posts 'maximize'.
    if (get() && get().shown && maximizeKey(event) && (get().maximized || canMaximize(get(), get().focus))) {
      event.preventDefault();
      event.stopPropagation();
      ui.actions.toggleMaximize();
      return;
    }
    const on = get() && get().shown && !event.isComposing;
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
  // and the focused column (else the first) is asked to show it, scrolled into view and outlined. False when the strip is not shown (the caller goes
  // on as usual) or the target is not usable.
  ui.actions.openInColumn = target => {
    const now = get();
    if (!now || !now.shown) return false;
    const message = openMessage(target);
    const id = targetColumn(now.ids.filter(item => !now.closing.includes(item)), now.focus);
    if (!message || !id) return false;
    pending.set(id, [...(pending.get(id) || []), message]);
    deliver(id);
    if (now.focus !== id) put({ focus: id });
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
    if (message.event === 'ready') { put({ ready: { ...get().ready, [id]: true } }); ui.actions.columnLoaded(id, frame); }
    else if (message.event === 'focus') ui.actions.focusColumn(id);
    else if (message.event === 'scroll-x') scrollStrip(message.dx);
    else if (message.event === 'step') ui.actions.stepColumn(message.step);
    else if (message.event === 'move') ui.actions.moveColumn(message.step, id);
    else if (message.event === 'maximize') ui.actions.toggleMaximize(id);
    else if (message.event === 'peek') put({ tails: { ...get().tails, [id]: message.lines } });
    else {
      const info = { title: message.title, session: message.session, device: message.device || null, map: message.map || null, target: message.target || null, agent: message.agent || '' };
      put({ titles: { ...get().titles, [id]: info } });
    }
  });
}

// The header button of the normal view (#h5-columns-open) and the first button of the strip's bar (#h5-columns-toggle, pressed): one label.
export function ColumnsToggle({ state, ui, inBar = false }) {
  if (!state.columns || !state.wide || state.columns.shown !== inBar) return null;
  const label = t('Multi-column view');
  const size = inBar ? 'small' : 'medium';
  return (
    <IconButton id={inBar ? 'h5-columns-toggle' : 'h5-columns-open'} size={size} {...named(label)} aria-pressed={state.columns.shown}
      sx={state.columns.shown ? { color: 'primary.light' } : undefined} onClick={() => ui.actions.toggleColumns()}>
      <Icon name="columns" size={size === 'small' ? 20 : 22} />
    </IconButton>
  );
}

// The page under the strip is hidden: its header, terminal, sidebar, chat and mind map. Notices and dialogs (higher z-index) stay above the strip.
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

const HIDE_PAGE = { 'html[data-columns] #h5-app, html[data-columns] #h5-tasks, html[data-columns] #h5-attention-sheet, html[data-columns] #h5-agent, html[data-columns] #h5-mindmap': { display: 'none !important' } };

// The tabs of the strip's top bar (#h5-columns-tabs, after the switch, "Add column" at its end): one per column, in the order the columns are shown,
// each the device tag of the pane's task (when its list tags it, the same DeviceTag as the task list and the pane's header), its task and session
// ("Column N" before the pane said them) and its close button. The focused column's tab is picked out (a tint and a primary outline, as the column's own
// outline), the tabs of the columns scrolled into view have a light underline. A tap or click on a tab focuses its column and scrolls it into view.
// The row never wraps: it scrolls sideways itself (no scrollbar: a wheel, a swipe, and the focused tab is scrolled into it). A tab held (useTabDrag)
// is dragged along the row to give its column a new place.
const TAB_MIN = 90;
const TAB_MAX = 220;
const TAB_HEIGHT = 30;
const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const tabLook = (theme, focused, inView) => {
  const shadows = [];
  if (focused) shadows.push(`inset 0 0 0 1px ${theme.palette.primary.main}`);
  if (inView) shadows.push(`inset 0 -2px 0 ${focused ? theme.palette.primary.main : 'rgba(255,255,255,0.32)'}`);
  return shadows.length ? shadows.join(', ') : 'none';
};
// The drag of a tab: its place is an empty dashed slot, the copy under the pointer is lifted (as the rows of the lists, list-drag.jsx DRAG_SX).
const TAB_DRAG_SX = theme => ({
  '& .h5-column-tab[data-drag-slot]': { backgroundColor: 'transparent', boxShadow: 'none' },
  '& .h5-column-tab[data-drag-slot] > *': { opacity: 0, pointerEvents: 'none' },
  '& .h5-column-tab[data-drag-slot]::before': {
    content: '""', position: 'absolute', inset: 0, borderRadius: '6px', pointerEvents: 'none',
    border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.6)}`, backgroundColor: alpha(theme.palette.primary.main, 0.1),
  },
  '& .h5-column-tab-float': { position: 'fixed', left: 0, top: 0, zIndex: 5, pointerEvents: 'none', willChange: 'transform' },
  '& .h5-column-tab-float-body': {
    height: '100%', borderRadius: '6px', backgroundColor: theme.palette.background.paper, backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.12))',
    boxShadow: 'none', transformOrigin: '50% 50%', transition: `transform ${SETTLE_MS}ms ease-out, box-shadow ${SETTLE_MS}ms ease-out`,
  },
  '& .h5-column-tab-float-body > .h5-column-tab': { height: '100%', maxWidth: 'none' },
  '& .h5-column-tab-float-lifted': { transform: 'scale(1.04)', boxShadow: `${theme.shadows[8]}, 0 0 0 1px ${alpha(theme.palette.primary.main, 0.45)}` },
  '& .h5-column-tab-float .h5-device-tag': { borderColor: 'currentColor', borderStyle: 'solid' },
  '@media (prefers-reduced-motion: reduce)': { '& .h5-column-tab-float-body': { transition: 'none' } },
});
const tabsOf = row => [...row.querySelectorAll('.h5-column-tab[data-pane-id]')];
const columnsOf = strip => [...strip.querySelectorAll(':scope > .h5-column')];
const paneKey = el => el.dataset.paneId;

function ColumnTabs({ columns, open, inView, ui, hostRef }) {
  const row = useRef(null);
  const drag = useTabDrag(row, hostRef, { drop: (id, index) => ui.actions.moveColumnTo(id, index), say });
  useFlipX(row, { items: tabsOf, key: paneKey, takeDropped: drag.takeDropped, busy: drag.busy });
  // The focused tab is scrolled into the row.
  const focus = columns.focus;
  const order = open.join(',');
  useEffect(() => {
    const el = row.current;
    const tab = focus && el ? el.querySelector(`.h5-column-tab[data-pane-id="${focus}"]`) : null;
    if (!tab) return;
    const left = revealLeft({ left: tab.offsetLeft, width: tab.offsetWidth, scrollLeft: el.scrollLeft, clientWidth: el.clientWidth });
    if (left !== null) el.scrollTo({ left, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [focus, order]);
  const closable = canClose(open);
  return (
    <Box id="h5-columns-tabs" ref={row} role="list" aria-label={t('Column tabs')}
      sx={{ flex: '0 1 auto', minWidth: 0, position: 'relative', display: 'flex', alignItems: 'center', gap: '4px', py: '3px', overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
      {open.map((id, index) => {
        const info = columns.titles[id];
        const label = t(`Column ${index + 1}`);
        const map = info && info.map ? info.map : null; // a mind map column: the map icon, the map's name (or "Mind maps" on the list) and a "map" tag
        const name = map ? map.title : info && info.title ? [info.title, info.session].filter(Boolean).join(' · ') : '';
        const tag = !map && info && info.device ? tagOf(info.device) : null;
        const focused = columns.focus === id;
        const seen = inView.includes(id);
        const shown = name || (map ? t('Mind maps') : label);
        return (
          <Box key={id} role="listitem" className="h5-column-tab" data-pane-id={id} data-focused={focused ? '' : undefined} data-in-view={seen ? '' : undefined}
            data-kind={map ? 'map' : undefined} data-maximized={columns.maximized === id ? '' : undefined} {...drag.hold()}
            sx={theme => ({
              flex: '0 0 auto', minWidth: TAB_MIN, maxWidth: TAB_MAX, height: TAB_HEIGHT, boxSizing: 'border-box', position: 'relative', display: 'flex', alignItems: 'center',
              borderRadius: '6px', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
              color: focused ? theme.palette.text.primary : theme.palette.text.secondary, backgroundColor: focused ? theme.palette.action.selected : 'transparent',
              boxShadow: tabLook(theme, focused, seen), transition: 'background-color 120ms ease-out', '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              '@media (hover: hover)': { '&:hover': { backgroundColor: focused ? theme.palette.action.selected : theme.palette.action.hover } },
            })}>
            <ButtonBase className="h5-column-tab-main" disableRipple aria-current={focused ? 'true' : undefined} title={map ? `${shown} (${t('map')})` : name || label}
              aria-keyshortcuts="Control+Alt+Shift+ArrowLeft Control+Alt+Shift+ArrowRight"
              onClick={event => ui.actions.showColumn(id, { focusFrame: event.detail > 0 })}
              sx={theme => ({
                flex: '1 1 auto', minWidth: 0, height: '100%', justifyContent: 'flex-start', gap: 0.75, pl: 1, pr: 0.25, borderRadius: '6px',
                fontSize: 12, fontWeight: focused ? 600 : 500, color: 'inherit', '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
              })}>
              {tag ? <DeviceTag device={tag} /> : null}
              {map ? <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', flex: '0 0 auto', color: 'primary.light' }}><Icon name="mindmap" size={14} /></Box> : null}
              <Box component="span" className="h5-column-tab-name" translate={name ? 'no' : undefined}
                sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{shown}</Box>
              {map ? (
                <Box component="span" className="h5-column-tab-kind"
                  sx={{ flex: '0 0 auto', px: 0.5, fontSize: 10, lineHeight: '14px', fontWeight: 600, borderRadius: '4px', color: 'primary.light', border: 1, borderColor: 'currentColor' }}>
                  {t('map')}
                </Box>
              ) : null}
            </ButtonBase>
            <IconButton className="h5-column-tab-close" size="small" {...named(t('Close column'))} disabled={!closable} onClick={() => ui.actions.closeColumn(id)} sx={{ flex: '0 0 auto', p: 0.5, mr: 0.25 }}>
              <Icon name="close" size={14} />
            </IconButton>
          </Box>
        );
      })}
    </Box>
  );
}

// The rail of a maximized column (#h5-columns-rail, RAIL_WIDTH px on the left; a nav landmark "Other columns"): Restore at the top, then
// one tile per other open column in the order shown: its state dot (green running, orange needs you, grey idle; columns.mjs `columnStatus`, from
// the top page's terminal activity and T-Attention), a short name and a red count of the T-Attention tasks of its terminal that wait for the
// person. Hovering a tile or focusing it shows its peek card beside it: task and session, agent and state, the pending question or the last lines
// of the terminal (asked from that pane), and "Open column". A click on a tile (or Open column) restores the columns and focuses that one.
// Escape in the rail closes the peek, else restores. The columns behind the tiles stay mounted and connected (see ColumnStrip).
const STATE_COLORS = { running: '#66bb6a', waiting: '#ffa726', idle: 'rgba(255,255,255,0.38)' };
const RAIL_KEYS = ['columns', 'attention', 'terminalActivity'];
const PEEK_DELAY_MS = 250;
const PEEK_WIDTH = 300;
const tileWords = (info, status) => {
  const agent = info && !info.map && AGENT_NAMES[info.agent] ? AGENT_NAMES[info.agent] : '';
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
          const name = info && info.map && !info.map.title ? t('Mind maps') : own || t(`Column ${open.indexOf(id) + 1}`);
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
  const session = info && !info.map && info.title && info.session ? info.session : '';
  const words = tileWords(info, status);
  return (
    <Box id="h5-rail-peek" className="h5-rail-peek" data-pane-id={id} role="group" aria-label={name} onMouseEnter={onEnter} onMouseLeave={onLeave}
      onBlur={event => { if (!event.relatedTarget || !event.currentTarget.parentElement.contains(event.relatedTarget)) onLeave(); }}
      sx={theme => ({
        position: 'fixed', left: RAIL_WIDTH + 8, top, zIndex: 3, width: PEEK_WIDTH, maxWidth: `calc(100vw - ${RAIL_WIDTH + 24}px)`, boxSizing: 'border-box', p: 1.5,
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

const STRIP_KEYS = ['columns', 'wide', 'pane', 'updateDot'];
export function ColumnStrip({ ui }) {
  const state = useStoreKeys(ui, STRIP_KEYS);
  countRender('ColumnStrip');
  const columns = state.columns;
  const shown = Boolean(columns && columns.shown);
  const root = useRef(null);
  const strip = useRef(null);
  const count = useRef(0);
  const mounted = useRef([]);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const [inView, setInView] = useState('');
  // The strip's visible width, observed: each column is at least a quarter of it (and at least MIN_COLUMN_WIDTH; minColumnWidth in columns.mjs), so
  // up to four share it evenly and more scroll sideways. Before the first measurement the window's width stands in for it.
  const [stripWidth, setStripWidth] = useState(() => window.innerWidth);
  const columnWidth = minColumnWidth(stripWidth);
  const maximized = shown ? columns.maximized : null;
  const wasMaximized = useRef(null);
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
  // A new order slides the columns to their places (their elements stay where they are in the DOM; only their CSS `order` changed).
  useFlipX(strip, { items: columnsOf, key: paneKey });
  // Whether the columns overflow, which edges hide some (the edge shadows and `data-overflow`) and which columns are in view (at least half of one, the
  // underline of its tab): on scroll, on a resize, and when the columns or their order change.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!shown || !el) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (el.clientWidth > 0 && !el.hasAttribute('data-maximized')) setStripWidth(el.clientWidth);
      const next = { overflow: el.scrollWidth > el.clientWidth + 1, ...hiddenEdges(el) };
      setEdges(now => (now.overflow === next.overflow && now.left === next.left && now.right === next.right ? now : next));
      const view = columnsOf(el).filter(column => {
        if (!column.offsetParent || column.hasAttribute('data-railed')) return false;
        const overlap = Math.min(column.offsetLeft + column.offsetWidth, el.scrollLeft + el.clientWidth) - Math.max(column.offsetLeft, el.scrollLeft);
        return overlap > 0 && overlap >= Math.min(column.offsetWidth, el.clientWidth) / 2 - 1;
      }).map(paneKey).sort().join(',');
      setInView(now => (now === view ? now : view));
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
  // A column that takes the focus (a click, a tab, the keys, an open request) is scrolled whole into view when part of it is hidden.
  const focus = columns ? columns.focus : null;
  useEffect(() => { if (shown && focus) revealColumn(focus); }, [shown, focus]);
  // A wheel over the top bar: over the tabs while they overflow, it scrolls the tabs (a vertical wheel too; a sideways one natively); elsewhere a sideways
  // wheel or Shift+wheel scrolls the strip (inside a pane the pane forwards it, pane.mjs).
  useEffect(() => {
    const el = root.current;
    if (!shown || !el) return undefined;
    const onWheel = event => {
      if (!event.target.closest || !event.target.closest('#h5-columns-bar')) return;
      const tabs = event.target.closest('#h5-columns-tabs');
      if (tabs && tabs.scrollWidth > tabs.clientWidth + 1) {
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.shiftKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        tabs.scrollLeft += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        return;
      }
      const dx = sidewaysDelta(event, window.innerWidth);
      if (!dx) return;
      event.preventDefault();
      scrollStrip(dx);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [shown]);
  if (!shown) return null;
  // The columns' elements in the order they were created (never moved: an iframe moved in the DOM reloads), each shown at its place by `order`.
  mounted.current = mountOrder(mounted.current, columns.ids);
  const viewed = inView ? inView.split(',') : [];
  const shadow = side => ({ ...EDGE, [side]: 0, bottom: edges.overflow ? SCROLLBAR : 0, opacity: edges[side] ? 1 : 0,
    borderLeft: side === 'left' ? '1px solid rgba(255,255,255,0.22)' : 0, borderRight: side === 'right' ? '1px solid rgba(255,255,255,0.22)' : 0,
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(255,255,255,0.13), rgba(255,255,255,0))` });
  return (
    <Box id="h5-columns" ref={root} role="region" aria-label={t('Multi-column view')}
      sx={theme => ({ position: 'fixed', inset: 0, zIndex: 1250, display: 'flex', flexDirection: 'column', bgcolor: '#121212', color: 'text.primary', ...TAB_DRAG_SX(theme) })}>
      <GlobalStyles styles={HIDE_PAGE} />
      <GlobalStyles styles={STRIP_SCROLLBAR} />
      <Box id="h5-columns-bar" sx={{ flex: '0 0 auto', minHeight: 36, display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, bgcolor: '#212121', borderBottom: 1, borderColor: 'divider' }}>
        <ColumnsUpdateButton state={state} ui={ui} />
        <ColumnsToggle state={state} ui={ui} inBar />
        <ColumnTabs columns={columns} open={open} inView={viewed} ui={ui} hostRef={root} />
        <IconButton id="h5-columns-add" size="small" {...named(t('Add column'))} disabled={!canAdd(open)} onClick={() => ui.actions.addColumn()} sx={{ flex: '0 0 auto' }}>
          <Icon name="add" size={18} />
        </IconButton>
        <IconButton id="h5-columns-add-map" size="small" {...named(t('Add mind map column'))} disabled={!canAdd(open)} onClick={() => ui.actions.addMapColumn()} sx={{ flex: '0 0 auto' }}>
          <Icon name="mindmap" size={18} />
        </IconButton>
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
            const name = info && info.map ? info.map.title || t('Mind maps') : info && info.title ? [info.title, info.session].filter(Boolean).join(' · ') : '';
            // While a map column is maximized it fills the strip; every other column stays mounted at the width it had, out of sight under it
            // (`visibility: hidden`, not `display: none`: its page keeps its layout and size, its socket and its messages).
            const railed = Boolean(maximized && id !== maximized && !closing);
            const look = maximized === id ? { flex: '1 1 auto', minWidth: 0, borderLeft: 0 }
              : railed ? { position: 'absolute', top: 0, bottom: 0, left: 0, boxSizing: 'border-box', width: frozen.widths.get(id) || columnWidth, borderLeft: place > 0 ? 1 : 0, visibility: 'hidden', pointerEvents: 'none' }
                : { flex: `1 0 ${columnWidth}px`, minWidth: columnWidth, borderLeft: place > 0 ? 1 : 0 };
            return (
              <Box key={id} className="h5-column" data-pane-id={id} data-focused={focused ? '' : undefined} data-ready={columns.ready[id] ? '' : undefined}
                data-maximized={maximized === id ? '' : undefined} data-railed={railed ? '' : undefined} aria-hidden={railed ? 'true' : undefined}
                onPointerDown={() => ui.actions.focusColumn(id)} style={{ order: closing ? MAX_ORDER : place }}
                sx={{ display: closing ? 'none' : 'flex', flexDirection: 'column', position: 'relative', borderColor: 'divider', ...look }}>
                <Box component="iframe" src={paneUrl(id)} title={name ? `${label}: ${name}` : label} data-pane-id={id}
                  allow="clipboard-read; clipboard-write; microphone; screen-wake-lock" onLoad={event => ui.actions.columnLoaded(id, event.currentTarget)}
                  sx={{ flex: '1 1 auto', minHeight: 0, width: '100%', border: 0, display: 'block', bgcolor: '#121212' }} />
                {focused ? <Box aria-hidden="true" className="h5-column-outline" sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: theme => `inset 0 0 0 1px ${theme.palette.primary.main}` }} /> : null}
              </Box>
            );
          })}
        </Box>
        <Box aria-hidden="true" className="h5-columns-edge" data-side="left" data-shown={edges.left ? '' : undefined} sx={shadow('left')} />
        <Box aria-hidden="true" className="h5-columns-edge" data-side="right" data-shown={edges.right ? '' : undefined} sx={shadow('right')} />
      </Box>
      <Box id="h5-columns-live" aria-live="polite" aria-atomic="true" sx={VISUALLY_HIDDEN} />
    </Box>
  );
}

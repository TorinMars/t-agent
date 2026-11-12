import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import GlobalStyles from '@mui/material/GlobalStyles';
import IconButton from '@mui/material/IconButton';
import { alpha } from '@mui/material/styles';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { DeviceTag } from './TaskDrawer.jsx';
import { SETTLE_MS } from './list-drag.jsx';
import { useFlipX, useTabDrag } from './tab-drag.jsx';
import {
  STORAGE_KEY, newId, canAdd, canClose, canOfferColumns, columnMove, columnStep, columnsFor, forgetMessage, hiddenEdges, minColumnWidth, mountOrder,
  moveColumn, openMessage, paneUrl, readLayout, readPaneMessage, revealLeft, shiftColumn, sidewaysDelta, stepTarget, tagOf, targetColumn, writeLayout,
} from './columns.mjs';

// The multi-column view of a wide screen: the top page shows a row of iframes of itself in pane mode (`/h5?pane=<id>`), each a whole copy of the page
// with its own header, terminal, draft box and tool row, and the person goes back to the normal view with the same button. The top page keeps one
// activity feed, one notifier and one updater; while the strip is shown its own terminal is hidden and holds no socket (h5.js, `columns.shown`).
// The rules (ids, order, the message format) are in columns.mjs; "Multi-column view" in DESIGN.md.
//
// state.columns: null on a page that never offers the view (a pane, or any page inside a frame), else
//   { enabled (the person's choice, remembered), shown (enabled and the screen is wide), ids (in order), focus (an id or null),
//     titles ({ id: { title, session, device? } } from the panes), ready ({ id: true } once the pane said so), closing ([id] being closed) }
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
    const next = { ...get(), ...patch };
    next.shown = next.enabled && wideQuery.matches;
    ui.set({ columns: next });
    writeStored(writeLayout({ on: next.enabled, ids: next.ids.filter(id => !next.closing.includes(id)) }));
  };
  ui.set({ columns: { enabled: false, shown: false, ids: [], focus: null, titles: {}, ready: {}, closing: [] } });
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
    put({ ids: [...now.ids, newId(now.ids)] }); // a column being closed is still mounted: its id is not given out again
  };
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
    if (!now || !now.shown || !which || !openOf(now).includes(which)) return;
    reorder(which, shiftColumn(openOf(now), which, step));
  };
  window.addEventListener('keydown', event => {
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
    else put({ titles: { ...get().titles, [id]: { title: message.title, session: message.session, device: message.device || null } } });
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
        const name = info && info.title ? [info.title, info.session].filter(Boolean).join(' · ') : '';
        const tag = info && info.device ? tagOf(info.device) : null;
        const focused = columns.focus === id;
        const seen = inView.includes(id);
        return (
          <Box key={id} role="listitem" className="h5-column-tab" data-pane-id={id} data-focused={focused ? '' : undefined} data-in-view={seen ? '' : undefined} {...drag.hold()}
            sx={theme => ({
              flex: '0 0 auto', minWidth: TAB_MIN, maxWidth: TAB_MAX, height: TAB_HEIGHT, boxSizing: 'border-box', position: 'relative', display: 'flex', alignItems: 'center',
              borderRadius: '6px', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
              color: focused ? theme.palette.text.primary : theme.palette.text.secondary, backgroundColor: focused ? theme.palette.action.selected : 'transparent',
              boxShadow: tabLook(theme, focused, seen), transition: 'background-color 120ms ease-out', '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              '@media (hover: hover)': { '&:hover': { backgroundColor: focused ? theme.palette.action.selected : theme.palette.action.hover } },
            })}>
            <ButtonBase className="h5-column-tab-main" disableRipple aria-current={focused ? 'true' : undefined} title={name || label}
              aria-keyshortcuts="Control+Alt+Shift+ArrowLeft Control+Alt+Shift+ArrowRight"
              onClick={event => ui.actions.showColumn(id, { focusFrame: event.detail > 0 })}
              sx={theme => ({
                flex: '1 1 auto', minWidth: 0, height: '100%', justifyContent: 'flex-start', gap: 0.75, pl: 1, pr: 0.25, borderRadius: '6px',
                fontSize: 12, fontWeight: focused ? 600 : 500, color: 'inherit', '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
              })}>
              {tag ? <DeviceTag device={tag} /> : null}
              <Box component="span" className="h5-column-tab-name" translate={name ? 'no' : undefined}
                sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{name || label}</Box>
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

export function ColumnStrip({ state, ui }) {
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
      if (el.clientWidth > 0) setStripWidth(el.clientWidth);
      const next = { overflow: el.scrollWidth > el.clientWidth + 1, ...hiddenEdges(el) };
      setEdges(now => (now.overflow === next.overflow && now.left === next.left && now.right === next.right ? now : next));
      const view = columnsOf(el).filter(column => {
        if (!column.offsetParent) return false;
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
  }, [shown, order, columnWidth]);
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
        <ColumnsToggle state={state} ui={ui} inBar />
        <ColumnTabs columns={columns} open={open} inView={viewed} ui={ui} hostRef={root} />
        <IconButton id="h5-columns-add" size="small" {...named(t('Add column'))} disabled={!canAdd(open)} onClick={() => ui.actions.addColumn()} sx={{ flex: '0 0 auto' }}>
          <Icon name="add" size={18} />
        </IconButton>
      </Box>
      <Box sx={{ flex: '1 1 auto', minHeight: 0, position: 'relative', display: 'flex' }}>
        <Box id="h5-columns-strip" ref={strip} className="h5-columns-scroll" data-overflow={edges.overflow ? '' : undefined} style={{ '--h5-column-min': `${columnWidth}px` }}
          sx={{ flex: '1 1 auto', minWidth: 0, position: 'relative', display: 'flex', overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain' }}>
          {mounted.current.map(id => {
            const closing = columns.closing.includes(id);
            const focused = columns.focus === id;
            const place = open.indexOf(id);
            const info = columns.titles[id];
            const label = t(`Column ${place + 1}`);
            const name = info && info.title ? [info.title, info.session].filter(Boolean).join(' · ') : '';
            return (
              <Box key={id} className="h5-column" data-pane-id={id} data-focused={focused ? '' : undefined} data-ready={columns.ready[id] ? '' : undefined}
                onPointerDown={() => ui.actions.focusColumn(id)} style={{ order: closing ? MAX_ORDER : place }}
                sx={{ flex: `1 0 ${columnWidth}px`, minWidth: columnWidth, display: closing ? 'none' : 'flex', flexDirection: 'column', position: 'relative', borderLeft: place > 0 ? 1 : 0, borderColor: 'divider' }}>
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

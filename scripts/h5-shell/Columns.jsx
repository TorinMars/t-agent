import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import GlobalStyles from '@mui/material/GlobalStyles';
import IconButton from '@mui/material/IconButton';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import {
  STORAGE_KEY, newId, canAdd, canClose, canOfferColumns, columnStep, columnsFor, forgetMessage, hiddenEdges,
  minColumnWidth, openMessage, paneUrl, readLayout, readPaneMessage, revealLeft, sidewaysDelta, stepTarget, targetColumn, writeLayout,
} from './columns.mjs';

// The multi-column view of a wide screen: the top page shows a row of iframes of itself in pane mode (`/h5?pane=<id>`), each a whole copy of the page
// with its own header, terminal, draft box and tool row, and the person goes back to the normal view with the same button. The top page keeps one
// activity feed, one notifier and one updater; while the strip is shown its own terminal is hidden and holds no socket (h5.js, `columns.shown`).
// The rules (ids, order, the message format) are in columns.mjs; "Multi-column view" in DESIGN.md.
//
// state.columns: null on a page that never offers the view (a pane, or any page inside a frame), else
//   { enabled (the person's choice, remembered), shown (enabled and the screen is wide), ids (in order), focus (an id or null),
//     titles ({ id: { title, session } } from the panes), ready ({ id: true } once the pane said so), closing ([id] being closed) }

const CLOSE_DELAY_MS = 250; // a closed column stays mounted (hidden) this long, so its pane receives 'forget' before its iframe goes away
const FOCUS_CHECK_MS = 300;

const readStored = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const writeStored = value => { try { localStorage.setItem(STORAGE_KEY, value); } catch { /* not remembered */ } };
const frames = () => [...document.querySelectorAll('#h5-columns iframe[data-pane-id]')];
const frameOf = id => frames().find(el => el.dataset.paneId === id);
const stripEl = () => document.getElementById('h5-columns-strip');
const columnEl = id => document.querySelector(`#h5-columns .h5-column[data-pane-id="${id}"]`);
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// Scrolls the strip so the column is whole in view (from its start when it is wider than the view): smooth, or at once with reduced motion.
function revealColumn(id) {
  const strip = stripEl();
  const column = id && columnEl(id);
  if (!strip || !column) return;
  const box = column.getBoundingClientRect();
  const left = revealLeft({ left: box.left - strip.getBoundingClientRect().left + strip.scrollLeft, width: box.width, scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth });
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
  window.addEventListener('keydown', event => {
    const step = get() && get().shown && !event.isComposing ? columnStep(event) : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    ui.actions.stepColumn(step);
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
    else put({ titles: { ...get().titles, [id]: { title: message.title, session: message.session } } });
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

export function ColumnStrip({ state, ui }) {
  const columns = state.columns;
  const shown = Boolean(columns && columns.shown);
  const root = useRef(null);
  const strip = useRef(null);
  const count = useRef(0);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
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
  const open = columns ? columns.ids.filter(id => !columns.closing.includes(id)) : [];
  // Whether the columns overflow and which edges hide some (the edge shadows and `data-overflow`): on scroll, on a resize, and when the columns change.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!shown || !el) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (el.clientWidth > 0) setStripWidth(el.clientWidth);
      const next = { overflow: el.scrollWidth > el.clientWidth + 1, ...hiddenEdges(el) };
      setEdges(now => (now.overflow === next.overflow && now.left === next.left && now.right === next.right ? now : next));
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    el.addEventListener('scroll', soon, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    if (observer) observer.observe(el);
    return () => { el.removeEventListener('scroll', soon); if (observer) observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [shown, open.length, columnWidth]);
  // A new column is scrolled into view (it is the last one).
  useEffect(() => {
    const grew = open.length > count.current && count.current > 0;
    count.current = open.length;
    if (grew) revealColumn(open[open.length - 1]);
  }, [open.length]);
  // A column that takes the focus (a click, the keys, an open request) is scrolled whole into view when part of it is hidden.
  const focus = columns ? columns.focus : null;
  useEffect(() => { if (shown && focus) revealColumn(focus); }, [shown, focus]);
  // A sideways wheel or Shift+wheel over the top bar or a column's bar scrolls the strip (inside a pane the pane forwards it, pane.mjs).
  useEffect(() => {
    const el = root.current;
    if (!shown || !el) return undefined;
    const onWheel = event => {
      if (!event.target.closest || !event.target.closest('#h5-columns-bar, .h5-column-bar')) return;
      const dx = sidewaysDelta(event, window.innerWidth);
      if (!dx) return;
      event.preventDefault();
      scrollStrip(dx);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [shown]);
  if (!shown) return null;
  const closable = canClose(open);
  const shadow = side => ({ ...EDGE, [side]: 0, bottom: edges.overflow ? SCROLLBAR : 0, opacity: edges[side] ? 1 : 0,
    borderLeft: side === 'left' ? '1px solid rgba(255,255,255,0.22)' : 0, borderRight: side === 'right' ? '1px solid rgba(255,255,255,0.22)' : 0,
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(255,255,255,0.13), rgba(255,255,255,0))` });
  return (
    <Box id="h5-columns" ref={root} role="region" aria-label={t('Multi-column view')}
      sx={{ position: 'fixed', inset: 0, zIndex: 1250, display: 'flex', flexDirection: 'column', bgcolor: '#121212', color: 'text.primary' }}>
      <GlobalStyles styles={HIDE_PAGE} />
      <GlobalStyles styles={STRIP_SCROLLBAR} />
      <Box id="h5-columns-bar" sx={{ flex: '0 0 auto', minHeight: 36, display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, bgcolor: '#212121', borderBottom: 1, borderColor: 'divider' }}>
        <ColumnsToggle state={state} ui={ui} inBar />
        <IconButton id="h5-columns-add" size="small" {...named(t('Add column'))} disabled={!canAdd(open)} onClick={() => ui.actions.addColumn()}>
          <Icon name="add" size={18} />
        </IconButton>
      </Box>
      <Box sx={{ flex: '1 1 auto', minHeight: 0, position: 'relative', display: 'flex' }}>
        <Box id="h5-columns-strip" ref={strip} className="h5-columns-scroll" data-overflow={edges.overflow ? '' : undefined} style={{ '--h5-column-min': `${columnWidth}px` }}
          sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain' }}>
          {columns.ids.map(id => {
            const closing = columns.closing.includes(id);
            const focused = columns.focus === id;
            const number = open.indexOf(id) + 1;
            const info = columns.titles[id];
            const label = t(`Column ${number}`);
            const name = info && info.title ? [info.title, info.session].filter(Boolean).join(' · ') : '';
            return (
              <Box key={id} className="h5-column" data-pane-id={id} data-focused={focused ? '' : undefined} data-ready={columns.ready[id] ? '' : undefined}
                onPointerDown={() => ui.actions.focusColumn(id)}
                sx={{ flex: `1 0 ${columnWidth}px`, minWidth: columnWidth, display: closing ? 'none' : 'flex', flexDirection: 'column', position: 'relative', borderLeft: 1, borderColor: 'divider', '&:first-of-type': { borderLeft: 0 } }}>
                <Box className="h5-column-bar" sx={{ flex: '0 0 auto', minHeight: 28, display: 'flex', alignItems: 'center', gap: 0.5, pl: 1, pr: 0.25, fontSize: 12, bgcolor: focused ? 'action.selected' : 'transparent', color: focused ? 'text.primary' : 'text.secondary' }}>
                  <Box component="span" className="h5-column-name" translate={name ? 'no' : undefined} sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || label}</Box>
                  <IconButton className="h5-column-close" size="small" {...named(t('Close column'))} disabled={!closable || closing} onClick={() => ui.actions.closeColumn(id)} sx={{ p: 0.5 }}>
                    <Icon name="close" size={14} />
                  </IconButton>
                </Box>
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
    </Box>
  );
}

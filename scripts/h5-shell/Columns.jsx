import { useEffect, useLayoutEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import GlobalStyles from '@mui/material/GlobalStyles';
import IconButton from '@mui/material/IconButton';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import {
  MIN_COLUMN_WIDTH, STORAGE_KEY, newId, canAdd, canClose, canOfferColumns, columnsFor, forgetMessage, paneUrl, readLayout, readPaneMessage, writeLayout,
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
    const frame = frames().find(el => el.dataset.paneId === id);
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

  // Messages from the panes: same origin only, and only from one of the strip's own iframes, about itself.
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !get() || !get().shown) return;
    const frame = frames().find(el => el.contentWindow === event.source);
    const message = frame && readPaneMessage(event.data);
    if (!message || message.paneId !== frame.dataset.paneId) return;
    const id = message.paneId;
    if (message.event === 'ready') put({ ready: { ...get().ready, [id]: true } });
    else if (message.event === 'focus') ui.actions.focusColumn(id);
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
const HIDE_PAGE = { 'html[data-columns] #h5-app, html[data-columns] #h5-tasks, html[data-columns] #h5-attention-sheet, html[data-columns] #h5-agent, html[data-columns] #h5-mindmap': { display: 'none !important' } };

export function ColumnStrip({ state, ui }) {
  const columns = state.columns;
  const shown = Boolean(columns && columns.shown);
  const strip = useRef(null);
  const count = useRef(0);
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
  // A new column is scrolled into view (it is the last one).
  const open = columns ? columns.ids.filter(id => !columns.closing.includes(id)) : [];
  useEffect(() => {
    const grew = open.length > count.current && count.current > 0;
    count.current = open.length;
    if (grew && strip.current) strip.current.scrollTo({ left: strip.current.scrollWidth });
  }, [open.length]);
  if (!shown) return null;
  const closable = canClose(open);
  return (
    <Box id="h5-columns" role="region" aria-label={t('Multi-column view')}
      sx={{ position: 'fixed', inset: 0, zIndex: 1250, display: 'flex', flexDirection: 'column', bgcolor: '#121212', color: 'text.primary' }}>
      <GlobalStyles styles={HIDE_PAGE} />
      <Box id="h5-columns-bar" sx={{ flex: '0 0 auto', minHeight: 36, display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, bgcolor: '#212121', borderBottom: 1, borderColor: 'divider' }}>
        <ColumnsToggle state={state} ui={ui} inBar />
        <IconButton id="h5-columns-add" size="small" {...named(t('Add column'))} disabled={!canAdd(open)} onClick={() => ui.actions.addColumn()}>
          <Icon name="add" size={18} />
        </IconButton>
      </Box>
      <Box id="h5-columns-strip" ref={strip}
        sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain' }}>
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
              sx={{ flex: `1 0 ${MIN_COLUMN_WIDTH}px`, minWidth: MIN_COLUMN_WIDTH, display: closing ? 'none' : 'flex', flexDirection: 'column', position: 'relative', scrollSnapAlign: 'start', borderLeft: 1, borderColor: 'divider', '&:first-of-type': { borderLeft: 0 } }}>
              <Box className="h5-column-bar" sx={{ flex: '0 0 auto', minHeight: 28, display: 'flex', alignItems: 'center', gap: 0.5, pl: 1, pr: 0.25, fontSize: 12, bgcolor: focused ? 'action.selected' : 'transparent', color: focused ? 'text.primary' : 'text.secondary' }}>
                <Box component="span" className="h5-column-name" translate={name ? 'no' : undefined} sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || label}</Box>
                <IconButton className="h5-column-close" size="small" {...named(t('Close column'))} disabled={!closable || closing} onClick={() => ui.actions.closeColumn(id)} sx={{ p: 0.5 }}>
                  <Icon name="close" size={14} />
                </IconButton>
              </Box>
              <Box component="iframe" src={paneUrl(id)} title={name ? `${label}: ${name}` : label} data-pane-id={id}
                allow="clipboard-read; clipboard-write; microphone; screen-wake-lock"
                sx={{ flex: '1 1 auto', minHeight: 0, width: '100%', border: 0, display: 'block', bgcolor: '#121212' }} />
              {focused ? <Box aria-hidden="true" className="h5-column-outline" sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: theme => `inset 0 0 0 1px ${theme.palette.primary.main}` }} /> : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

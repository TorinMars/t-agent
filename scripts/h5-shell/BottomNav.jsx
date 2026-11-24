import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { overlay } from './Columns.jsx';
import { phoneDestinations, phoneView, railKey } from './columns.mjs';
import { measureTerminalBox } from './terminal-box.mjs';
import { shallowEqual } from './store.mjs';
import { countRender, useStore } from './use-store.mjs';

// The phone's bottom navigation (#h5-bnav, a nav landmark "Views"): the phone counterpart of the navigation rail (Columns.jsx `NavRail`), on the narrow
// layout only and never in a pane. An MD2 bottom navigation bar, 56px plus the bottom safe-area inset, fixed at the bottom of the window (z-index 1150:
// under MUI's modals, so the drawer, a dialog or a deeper full-screen page such as a plugin page of Settings lies over it, while the four destination
// pages end above it and leave it free): Sessions (the terminal page), Attention (`#h5-attention` on a touch screen, `#h5-bnav-attention` with a
// mouse, whose "More tools" menu keeps `#h5-attention`; with the red count of the T-Attention items that
// need the person), Mind maps, Learn and Settings, each an icon over a label, the shown one in the primary colour with `aria-current="page"`. The four
// destinations other than Sessions are pages over the terminal page that end above the bar (h5.css `html[data-bnav]`, h5.js `bottomNavSpace`); one is
// open at a time, choosing another closes it, Sessions closes them all, and the back button closes the open one (back.mjs: each is a layer), which is
// Sessions again. The arrow keys move between the items (`railKey`).
// The bar steps aside while it would be in the way: while the terminal's own keyboard (Osk) or the Learn page's (`state.learnKeys`) is shown, while the
// English coach chat is open (`state.learnCoach`: its input sits at the bottom, the header's back arrow returns), while the draft box has the focus and while the
// system keyboard is up (`state.softKeyboard`, h5.js `fitViewport`); it comes back RETURN_MS after. While the task drawer is open it lies under the
// drawer's scrim and is inert. `html[data-bnav]`
// is set while it is shown: the page (`.h5-app`) keeps its room free at the bottom, so the terminal refits when it comes or goes.
// On the Sessions destination while a terminal is shown (touch input; `state.shownTarget`), the bar is hidden by default and only a pull handle
// (#h5-bnav-handle, "Show navigation") stays: a 16px strip above the safe area with a 4 x 40px bar, plus an error-colour dot while Attention has a count.
// `html[data-bnav-handle]` keeps only that strip's room (also while a destination page is open over that terminal, so going there and back does not
// resize the PTY). A tap or an upward swipe on the handle shows the bar as an overlay (`state.navPeek`): no room is taken, the terminal keeps its
// size. It hides again after a destination is chosen, a tap outside it, a downward swipe on it, Escape, the back button (entry.jsx: a back layer) or
// PEEK_MS without a touch on it. See "Pull handle on the session page" in docs/design/page-navigation.md.
// See "Bottom navigation" in docs/design/page-navigation.md.
const BNAV = state => ({
  pane: Boolean(state.pane), narrow: !state.wide, pointer: state.input === 'pointer',
  // The coach chat takes the bar's room like a keyboard does (no `data-bnav-room`): the page ends at the bottom of the window.
  osk: Boolean(state.osk || state.learnKeys || state.learnCoach), typing: state.keyboard === 'draft' || Boolean(state.softKeyboard), soft: Boolean(state.softKeyboard),
  under: Boolean(state.tasksOpen),
  view: phoneView({ settingsOpen: state.settingsOpen, attentionOpen: Boolean(state.attention && state.attention.open), learnOpen: Boolean(state.learnOpen), mindmapOpen: Boolean(state.mindmapOpen) }),
  needs: Number(state.attention && state.attention.needs) || 0,
  session: Boolean(state.shownTarget), peek: Boolean(state.navPeek),
});

// Shows one destination of the phone: the page that is open goes away first; Sessions closes every one of them. Choosing the one shown does nothing.
export function choosePhoneView(ui, view) {
  const state = ui.get();
  const attentionOpen = Boolean(state.attention && state.attention.open);
  if (view !== 'settings' && state.settingsOpen && ui.actions.closeSettings) ui.actions.closeSettings();
  if (view !== 'attention' && attentionOpen && ui.actions.closeAttention) ui.actions.closeAttention();
  if (view !== 'maps' && state.mindmapOpen && ui.actions.closeMindmaps) ui.actions.closeMindmaps();
  if (view !== 'learn' && state.learnOpen && ui.actions.closeLearn) ui.actions.closeLearn();
  if (view === 'settings' && !state.settingsOpen) ui.actions.openSettings();
  else if (view === 'learn' && !state.learnOpen) ui.actions.openLearn();
  else if (view === 'attention' && !attentionOpen) ui.actions.openAttention();
  else if (view === 'maps' && !state.mindmapOpen) ui.actions.openMindmaps();
}

const ITEM_SX = current => theme => ({
  flex: '1 1 0', minWidth: 0, maxWidth: 168, height: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0.5,
  color: current ? theme.palette.primary.main : theme.palette.text.secondary,
  '@media (hover: hover)': { '&:hover': { backgroundColor: theme.palette.action.hover } },
  '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
});
const BADGE_SX = { '& .MuiBadge-badge': { typography: 'caption', fontSize: 10, fontWeight: 500, height: 16, minWidth: 16, px: 0.5, pointerEvents: 'none' } };

// After the draft box or the system keyboard hid it, the bar comes back this long after they went away (it goes at once): a tap that blurs the draft
// box lands where the finger is, before the page below it moves.
const RETURN_MS = 250;
// The bar shown from the pull handle hides again after this long without a touch on it.
export const PEEK_MS = 6000;
// A swipe on the handle (up) or on the shown bar (down) of at least this many pixels.
const SWIPE_PX = 16;
export function BottomNav({ ui }) {
  const state = useStore(ui, BNAV, shallowEqual);
  countRender('BottomNav');
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    if (state.typing) { setReturning(true); return undefined; }
    const timer = setTimeout(() => setReturning(false), RETURN_MS);
    return () => clearTimeout(timer);
  }, [state.typing]);
  const phone = !state.pane && state.narrow;
  const free = phone && !state.osk && !state.typing && !returning; // nothing in the way: the bar (or the handle) may be shown
  // A terminal is shown behind the phone's pages (touch input): its page keeps only the handle's room, on Sessions and under the other destinations.
  const terminal = phone && !state.pointer && state.session;
  // Sessions with a terminal: the bar is hidden behind the pull handle, shown over the page while peeking (and under the drawer's scrim, as before).
  const handled = terminal && state.view === 'sessions';
  const shown = free && (!handled || state.peek || state.under);
  const handle = free && handled && !state.peek && !state.under;
  const full = shown && !handled; // the bar's room is kept (the destination pages, or Sessions without a terminal)
  // Away for typing (the draft box, and the moment after it or the system keyboard) while no system keyboard is up: the page keeps the bar's room
  // (`data-bnav-room`), so the terminal keeps its size and its PTY is not resized for one message. With the system keyboard up the room is not kept
  // (the keyboard covers it; h5.js pins the terminal as before). The terminal keyboard is a real change of the layout: its room is the keyboard's.
  const room = phone && !free && !state.osk && !state.soft && !terminal;
  const handleRoom = terminal && !state.osk && !state.soft;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-bnav', full);
    root.toggleAttribute('data-bnav-room', room);
    root.toggleAttribute('data-bnav-handle', handleRoom);
    measureTerminalBox(); // the terminal area got or gave back the bar's room, in the same frame
    if (ui.actions.fitAboveBottomNav) ui.actions.fitAboveBottomNav();
    return () => { root.removeAttribute('data-bnav'); root.removeAttribute('data-bnav-room'); root.removeAttribute('data-bnav-handle'); };
  }, [full, room, handleRoom, ui]);
  // The peek ends by itself when the handle's place goes away (another destination, the keyboard, the drawer, no terminal).
  const peeking = state.peek && free && handled && !state.under;
  useEffect(() => { if (state.peek && !peeking) ui.set({ navPeek: false }); }, [state.peek, peeking, ui]);
  const hide = () => { if (ui.get().navPeek) ui.set({ navPeek: false }); };
  // While peeking: a tap outside the bar, Escape and PEEK_MS without a touch on it hide it; a touch, a key or the focus on it restarts the wait.
  const timer = useRef(0);
  useEffect(() => {
    if (!peeking) return undefined;
    const restart = () => { clearTimeout(timer.current); timer.current = setTimeout(hide, PEEK_MS); };
    restart();
    const away = event => {
      if (event.target && event.target.closest && event.target.closest('#h5-bnav, #h5-bnav-handle')) { restart(); return; }
      hide();
    };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      const back = nav.current && nav.current.contains(document.activeElement);
      hide();
      if (back) setTimeout(() => { const el = document.getElementById('h5-bnav-handle'); if (el) el.focus(); }, 0);
    };
    const el = nav.current;
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    if (el) { el.addEventListener('keydown', restart); el.addEventListener('focusin', restart); }
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', escape, true);
      if (el) { el.removeEventListener('keydown', restart); el.removeEventListener('focusin', restart); }
    };
  }, [peeking]); // eslint-disable-line react-hooks/exhaustive-deps
  // A swipe: where the finger went down on the handle or the shown bar.
  const swipe = useRef(null);
  const onTouchStart = event => { const point = event.touches && event.touches[0]; swipe.current = point ? point.clientY : null; };
  const swiped = event => {
    const point = event.changedTouches && event.changedTouches[0];
    const from = swipe.current;
    swipe.current = null;
    return point && from != null ? point.clientY - from : 0;
  };
  // The handle: a tap, or a swipe up. A keyboard press puts the focus on the current destination.
  const peek = event => {
    ui.set({ navPeek: true });
    if (event && event.detail === 0) setTimeout(() => { const el = nav.current && (nav.current.querySelector('[aria-current="page"]') || nav.current.querySelector('.h5-bnav-item')); if (el) el.focus(); }, 0);
  };
  // Over T-Attention and Settings (MUI modals that end above the bar), the bar stays usable: it is a child of <body> of its own (a portal), so it
  // can be kept out of what the open modal hides from assistive technology (MUI sets `aria-hidden` on the other children of <body>), and a focus
  // that comes into it is not pulled back into the modal (the modal's focus trap listens for `focusin` on the document).
  const nav = useRef(null);
  const exposed = shown && !state.under && state.view !== 'sessions';
  useEffect(() => {
    const el = nav.current;
    if (!el || !exposed) return undefined;
    const expose = () => { if (el.getAttribute('aria-hidden') === 'true') el.removeAttribute('aria-hidden'); };
    expose();
    const watch = new MutationObserver(expose);
    watch.observe(el, { attributes: true, attributeFilter: ['aria-hidden'] });
    const keep = event => event.stopPropagation();
    el.addEventListener('focusin', keep);
    return () => { watch.disconnect(); el.removeEventListener('focusin', keep); };
  }, [exposed]);
  if (state.pane) return null;
  const onKeyDown = event => {
    const buttons = [...event.currentTarget.querySelectorAll('.h5-bnav-item')];
    const at = buttons.indexOf(document.activeElement);
    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = railKey(event.key, at, buttons.length);
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
  };
  const showLabel = t('Show navigation');
  return createPortal(
    <>
    {handle ? (
      <ButtonBase id="h5-bnav-handle" aria-label={showLabel} title={showLabel} aria-controls="h5-bnav" onClick={peek}
        onTouchStart={onTouchStart} onTouchEnd={event => { if (swiped(event) <= -SWIPE_PX) { event.preventDefault(); peek(); } }}
        sx={theme => ({ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1150, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          boxSizing: 'border-box', height: 'calc(16px + env(safe-area-inset-bottom))', pt: '6px', pb: 'env(safe-area-inset-bottom)', touchAction: 'none',
          bgcolor: 'background.paper', backgroundImage: overlay(1),
          '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } })}>
        <Box component="span" className="h5-bnav-grip" aria-hidden="true" sx={{ position: 'relative', width: 40, height: 4, borderRadius: '2px', bgcolor: 'text.disabled' }}>
          {state.needs ? <Box component="span" className="h5-bnav-handle-dot" sx={{ position: 'absolute', left: 48, top: -2, width: 8, height: 8, borderRadius: '50%', bgcolor: 'error.main' }} /> : null}
        </Box>
      </ButtonBase>
    ) : null}
    <Box component="nav" id="h5-bnav" ref={nav} aria-label={t('Views')} onKeyDown={onKeyDown} inert={state.under || undefined} data-under={state.under ? '' : undefined}
      data-peek={peeking ? '' : undefined}
      onTouchStart={peeking ? onTouchStart : undefined} onTouchEnd={peeking ? event => { if (swiped(event) >= SWIPE_PX) hide(); } : undefined}
      sx={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1150, display: shown ? 'flex' : 'none', justifyContent: 'center',
        boxSizing: 'border-box', height: 'calc(56px + env(safe-area-inset-bottom))', pb: 'env(safe-area-inset-bottom)', px: 'env(safe-area-inset-left)',
        bgcolor: 'background.paper', backgroundImage: overlay(1), borderTop: 1, borderColor: 'divider' }}>
      {phoneDestinations().map(item => {
        const current = state.view === item.view;
        const attention = item.view === 'attention';
        const badge = attention ? state.needs : 0;
        const label = t(item.label);
        // No count is null, not 0: MUI's Badge keeps drawing the last content while invisible, which put a stray "0" into the items' text.
        // Attention keeps the name of the T-Attention button it replaces ("Attention (1)"): its count is in the name.
        const name = attention && badge ? `${label} (${badge})` : label;
        // In pointer input (a narrow computer window) the bottom area's "More tools" menu keeps `#h5-attention` (always mounted): the bar's item has its own id.
        const id = attention && state.pointer ? 'h5-bnav-attention' : item.id;
        return (
          <ButtonBase key={item.view} id={id} className="h5-bnav-item" data-view={item.view} data-action={attention ? 'attention' : undefined}
            aria-current={current ? 'page' : undefined} aria-label={name} title={attention ? name : undefined} onClick={() => { hide(); choosePhoneView(ui, item.view); }} sx={ITEM_SX(current)}>
            <Badge className={attention ? 'h5-attention-badge' : undefined} badgeContent={badge || null} max={99} color="error" invisible={!badge} overlap="circular" sx={BADGE_SX}>
              <Icon name={item.icon} size={24} />
            </Badge>
            <Box component="span" className="h5-bnav-label" aria-hidden="true" sx={theme => ({ ...theme.typography.caption, fontWeight: 500, lineHeight: '16px', letterSpacing: '0.4px' })}>{label}</Box>
          </ButtonBase>
        );
      })}
    </Box>
    </>,
    document.body,
  );
}

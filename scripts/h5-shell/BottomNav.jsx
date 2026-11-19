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
// The bar steps aside while it would be in the way: while the terminal's own keyboard (Osk) is shown, while the draft box has the focus and while the
// system keyboard is up (`state.softKeyboard`, h5.js `fitViewport`); it comes back RETURN_MS after. While the task drawer is open it lies under the
// drawer's scrim and is inert. `html[data-bnav]`
// is set while it is shown: the page (`.h5-app`) keeps its room free at the bottom, so the terminal refits when it comes or goes.
// See "Bottom navigation" in docs/design/page-navigation.md.
const BNAV = state => ({
  pane: Boolean(state.pane), narrow: !state.wide, pointer: state.input === 'pointer',
  osk: Boolean(state.osk), typing: state.keyboard === 'draft' || Boolean(state.softKeyboard), soft: Boolean(state.softKeyboard),
  under: Boolean(state.tasksOpen),
  view: phoneView({ settingsOpen: state.settingsOpen, attentionOpen: Boolean(state.attention && state.attention.open), learnOpen: Boolean(state.learnOpen), mindmapOpen: Boolean(state.mindmapOpen) }),
  needs: Number(state.attention && state.attention.needs) || 0,
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
  const shown = phone && !state.osk && !state.typing && !returning;
  // Away for typing (the draft box, and the moment after it or the system keyboard) while no system keyboard is up: the page keeps the bar's room
  // (`data-bnav-room`), so the terminal keeps its size and its PTY is not resized for one message. With the system keyboard up the room is not kept
  // (the keyboard covers it; h5.js pins the terminal as before). The terminal keyboard is a real change of the layout: its room is the keyboard's.
  const room = phone && !shown && !state.osk && !state.soft;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-bnav', shown);
    root.toggleAttribute('data-bnav-room', room);
    measureTerminalBox(); // the terminal area got or gave back the bar's room, in the same frame
    if (ui.actions.fitAboveBottomNav) ui.actions.fitAboveBottomNav();
    return () => { root.removeAttribute('data-bnav'); root.removeAttribute('data-bnav-room'); };
  }, [shown, room, ui]);
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
  return createPortal(
    <Box component="nav" id="h5-bnav" ref={nav} aria-label={t('Views')} onKeyDown={onKeyDown} inert={state.under || undefined} data-under={state.under ? '' : undefined}
      sx={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1150, display: shown ? 'flex' : 'none', justifyContent: 'center',
        boxSizing: 'border-box', height: 'calc(56px + env(safe-area-inset-bottom))', pb: 'env(safe-area-inset-bottom)', px: 'env(safe-area-inset-left)',
        bgcolor: 'background.paper', backgroundImage: overlay(1), borderTop: 1, borderColor: 'divider' }}>
      {phoneDestinations().map(item => {
        const current = state.view === item.view;
        const attention = item.view === 'attention';
        const badge = attention ? state.needs : 0;
        const label = t(item.label);
        // Attention keeps the name of the T-Attention button it replaces ("Attention (1)"): its count is in the name.
        const name = attention && badge ? `${label} (${badge})` : label;
        // In pointer input (a narrow computer window) the bottom area's "More tools" menu keeps `#h5-attention` (always mounted): the bar's item has its own id.
        const id = attention && state.pointer ? 'h5-bnav-attention' : item.id;
        return (
          <ButtonBase key={item.view} id={id} className="h5-bnav-item" data-view={item.view} data-action={attention ? 'attention' : undefined}
            aria-current={current ? 'page' : undefined} aria-label={name} title={attention ? name : undefined} onClick={() => choosePhoneView(ui, item.view)} sx={ITEM_SX(current)}>
            <Badge className={attention ? 'h5-attention-badge' : undefined} badgeContent={badge} max={99} color="error" invisible={!badge} overlap="circular" sx={BADGE_SX}>
              <Icon name={item.icon} size={24} />
            </Badge>
            <Box component="span" className="h5-bnav-label" aria-hidden="true" sx={theme => ({ ...theme.typography.caption, fontWeight: 500, lineHeight: '16px', letterSpacing: '0.4px' })}>{label}</Box>
          </ButtonBase>
        );
      })}
    </Box>,
    document.body,
  );
}

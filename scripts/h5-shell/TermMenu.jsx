import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { TOUCH } from './theme.mjs';

const POPUP_MARGIN = 8; // the popup keeps this far from the edges of what can be seen

// Below the button, or above it when it does not fit there and there is more room above. The visible area is the visual viewport, so the on-screen
// keyboard counts as the end of the screen. What fits in neither place scrolls inside its maximum height.
function popupPlace(anchor, height) {
  const viewport = window.visualViewport;
  const top = viewport ? viewport.offsetTop : 0;
  const bottom = top + (viewport ? viewport.height : window.innerHeight);
  const box = anchor.getBoundingClientRect();
  const below = bottom - box.bottom - POPUP_MARGIN;
  const above = box.top - top - POPUP_MARGIN;
  const flip = height > below && above > below;
  return { flip, maxHeight: Math.max(flip ? above : below, 0) };
}

// The actions of a session row: a popup right under its "⋯" (`menu.anchor`), right-aligned to it, so the choices appear where the person tapped. It is
// a modal menu, so the back button (back.mjs) and a tap beside it close it like any other layer. Nothing behind it moves, so a scroll or a drag can only
// mean the person has moved on: it closes then too, and when its row has gone.
function SessionPopup({ menu, ui, keepFocus }) {
  const anchor = menu ? menu.anchor : null;
  const open = Boolean(menu);
  const paperRef = useRef(null);
  const [place, setPlace] = useState({ flip: false, maxHeight: undefined });
  const measure = useCallback(paper => {
    paperRef.current = paper;
    if (!paper || !anchor) return;
    const next = popupPlace(anchor, paper.scrollHeight);
    setPlace(last => (last.flip === next.flip && last.maxHeight === next.maxHeight ? last : next));
  }, [anchor]);
  // Popover shifts a paper that does not fit, but never turns it over; a change of the visible area (the keyboard going away) can change the side.
  useEffect(() => {
    if (!open) return undefined;
    const again = () => measure(paperRef.current);
    const viewport = window.visualViewport;
    window.addEventListener('resize', again);
    viewport?.addEventListener('resize', again);
    return () => {
      window.removeEventListener('resize', again);
      viewport?.removeEventListener('resize', again);
    };
  }, [open, measure]);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => ui.actions.menuCancel();
    const inside = event => Boolean(paperRef.current) && paperRef.current.contains(event.target);
    // Only what carries the button counts: the terminal beside the list scrolls by itself whenever it prints.
    const scrolled = event => { if (!inside(event) && event.target.contains && event.target.contains(anchor)) close(); };
    const dragged = event => { if (!inside(event)) close(); };
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('wheel', dragged, { capture: true, passive: true });
    window.addEventListener('touchmove', dragged, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('wheel', dragged, { capture: true });
      window.removeEventListener('touchmove', dragged, { capture: true });
    };
  }, [open, anchor, ui]);
  // Its row was removed (the list was read again, the sidebar folded): nothing is left to point at.
  useEffect(() => { if (open && anchor && !anchor.isConnected) ui.actions.menuCancel(); });
  // An action that ends without closing anything (a confirmation answered with Cancel) closes the popup as well. Rename replaces the menu state with the
  // field, so it is left alone.
  const run = index => {
    ui.actions.menuRun(index);
    if (ui.get().menu === menu) ui.actions.menuCancel();
  };
  return (
    <Menu
      id="h5-session-menu" anchorEl={anchor} open={open} onClose={() => ui.actions.menuCancel()} marginThreshold={POPUP_MARGIN}
      anchorOrigin={{ vertical: place.flip ? 'top' : 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: place.flip ? 'bottom' : 'top', horizontal: 'right' }}
      // It goes at once: its items are gone with the state, and the rename field must be alone when it takes the focus.
      transitionDuration={{ enter: 120, exit: 0 }}
      // "Rename" hands the focus to the name field in the task list: the "⋯" that opened the popup must not take it back.
      disableRestoreFocus={keepFocus}
      slotProps={{
        paper: { ref: measure, className: 'h5-session-menu-paper', sx: { minWidth: 160, maxWidth: `calc(100vw - ${POPUP_MARGIN * 2}px)`, maxHeight: place.maxHeight } },
        list: { id: 'h5-session-menu-actions', 'aria-label': menu ? menu.title : undefined },
      }}
    >
      {menu ? menu.items.map((item, index) => (
        <MenuItem
          key={`${index}:${item.label}`} className={item.kind === 'danger' ? 'danger' : undefined} onClick={() => run(index)}
          sx={{ minHeight: 36, px: 1.5, fontSize: 14, whiteSpace: 'normal', overflowWrap: 'anywhere', color: item.kind === 'danger' ? 'error.main' : undefined, [TOUCH]: { minHeight: 44 } }}
        >
          {item.kind === 'raw' ? item.label : t(item.label)}
        </MenuItem>
      )) : null}
    </Menu>
  );
}

// The sheet from the bottom with the actions of a chat or of a task ("⋯"); the actions of a session row are a popup under its "⋯" (`SessionPopup`). The
// "Session" list of the "+" of a task (`menu.naming`) and the rename field (`menu.rename`) are not shown here: they are drawn in the task list, where the
// person tapped (TaskDrawer.jsx).
// On a phone it is as wide as the window (at most 480px, centred). Beside the permanent sidebar it rises inside the sidebar's width, under the "⋯" that
// opened it, instead of floating over the middle of the window far from it.
export function TermMenu({ state, ui }) {
  const shown = state.menu && !state.menu.naming && !state.menu.rename ? state.menu : null;
  const menu = shown && !shown.anchor ? shown : null;
  const keepFocus = Boolean(state.menu && state.menu.rename);
  const placement = state.wide ? { width: 320, maxWidth: 320, left: 0, right: 'auto', mx: 0 } : { maxWidth: 480, width: '100%', mx: 'auto' };
  return (
    <>
      <SessionPopup menu={shown && shown.anchor ? shown : null} ui={ui} keepFocus={keepFocus} />
      <Drawer
        anchor="bottom" id="h5-term-menu" open={Boolean(menu)} onClose={() => ui.actions.menuCancel()}
        slotProps={{ paper: { className: 'h5-menu-panel', sx: { ...placement, borderRadius: '16px 16px 0 0', p: 1.5, backgroundImage: 'none', maxHeight: '80vh' } } }}
        aria-labelledby="h5-term-menu-title"
        ModalProps={{ disableRestoreFocus: keepFocus }}
      >
        {menu ? (
          <>
            <Typography id="h5-term-menu-title" variant="subtitle2" component="h3" color="text.secondary" sx={{ mb: 1, overflowWrap: 'anywhere' }}>{menu.title}</Typography>
            <List id="h5-term-menu-actions" className="h5-menu-actions" disablePadding sx={{ overflowY: 'auto' }}>
              {menu.items.map((item, index) => (
                <ListItemButton key={`${index}:${item.label}`} component="button" className={item.kind === 'danger' ? 'danger' : undefined} onClick={() => ui.actions.menuRun(index)}
                  sx={{ width: '100%', borderRadius: 1, color: item.kind === 'danger' ? 'error.main' : undefined, overflowWrap: 'anywhere', textAlign: 'left' }}>
                  {item.kind === 'raw' ? item.label : t(item.label)}
                </ListItemButton>
              ))}
            </List>
            <Button id="h5-term-menu-cancel" className="h5-menu-cancel" onClick={() => ui.actions.menuCancel()} fullWidth sx={{ mt: 1 }}>{t('Cancel')}</Button>
          </>
        ) : null}
      </Drawer>
    </>
  );
}

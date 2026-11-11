import { useRef, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import MenuIcon from '@mui/icons-material/Menu';
import RefreshIcon from '@mui/icons-material/Refresh';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { UpdateButton } from './Update.jsx';
import { ColumnsToggle } from './Columns.jsx';

export function Header({ state, ui }) {
  const docked = state.wide && !state.sidebarCollapsed; // the permanent sidebar is shown, so the task name opens nothing
  const fold = state.sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  const refresh = t('Refresh the page');
  return (
    <AppBar position="static" color="default" enableColorOnDark elevation={0} className="h5-header" sx={{ flex: '0 0 auto', borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar variant="dense" disableGutters sx={{ px: 1, gap: 1, minHeight: 44 }}>
        {state.wide ? (
          // Wide layout: fold the permanent sidebar away and back (the state is remembered; entry.jsx `toggleSidebar`).
          <IconButton id="h5-sidebar-toggle" {...named(t(fold))} aria-expanded={!state.sidebarCollapsed} aria-controls="h5-tasks" onClick={() => ui.actions.toggleSidebar()}>
            <Icon name={state.sidebarCollapsed ? 'sidebarUnfold' : 'sidebarFold'} size={22} />
          </IconButton>
        ) : null}
        <ButtonBase
          id="h5-open-tasks" className="h5-task-button" aria-expanded={state.tasksOpen && !state.sidebarCollapsed} aria-haspopup="dialog" aria-controls="h5-tasks"
          onClick={() => ui.actions.openTasks()}
          sx={{ flex: '1 1 auto', minWidth: 0, justifyContent: 'flex-start', gap: 1, px: 1, py: 0.5, borderRadius: 1, textAlign: 'left', pointerEvents: docked ? 'none' : 'auto' }}
        >
          {state.wide ? null : <MenuIcon fontSize="small" aria-hidden="true" />}
          <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
            <Typography id="h5-task-name" className="h5-task-name" variant="subtitle1" component="div" noWrap sx={{ fontWeight: 600, lineHeight: 1.3 }}>{state.taskName || t('Choose a task')}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, minWidth: 0 }}>
              {/* The service of the shown task when it is not this machine, on the line of the session name. */}
              {state.sourceLabel ? <Typography id="h5-task-service" className="h5-task-service" variant="caption" component="div" color="primary.light" noWrap translate="no" title={state.sourceLabel} sx={{ flex: '0 1 auto', maxWidth: '60%', lineHeight: 1.3, fontWeight: 600 }}>{state.sourceLabel}</Typography> : null}
              <Typography id="h5-session-name" className="h5-session-name" variant="caption" component="div" color="text.secondary" noWrap translate="no" sx={{ flex: '1 1 auto', minWidth: 0, lineHeight: 1.3 }}>{state.sessionName || ' '}</Typography>
            </Box>
          </Box>
        </ButtonBase>
        <ColumnsToggle state={state} ui={ui} />
        {state.terminalWidth ? <WidthButton width={state.terminalWidth} ui={ui} /> : null}
        <IconButton id="h5-refresh" {...named(refresh)} onClick={() => ui.actions.refresh()}>
          <RefreshIcon />
        </IconButton>
        {/* A pane of the multi-column view has no updater: the top page checks, reloads and so reloads its columns (pane.mjs). */}
        {state.pane ? null : <UpdateButton ui={ui} />}
      </Toolbar>
    </AppBar>
  );
}

// The terminal width switch (h5.js `setTerminalWidth`, "Terminal width" in DESIGN.md). A tap switches Fit <-> Wide (the PTY gets the chosen column
// count and the screen moves sideways). A long press (500 ms) or a right click opens a small menu: Fit to screen, 120, 160 or 200 columns.
const WIDE_CHOICES = [120, 160, 200];
const LONG_PRESS_MS = 500;
const LIFT_OPEN_MS = 400; // a long press without a following click (some browsers send none) opens the menu this long after the lift
export function WidthButton({ width, ui }) {
  const anchor = useRef(null);
  // A long press is only marked while the finger is down. The menu opens from the click that follows the lift (it lands on this button,
  // before the menu's backdrop exists); opening it on pointerup let that click land on the new backdrop and close the menu at once. A browser
  // that sends no click after a long press opens it after LIFT_OPEN_MS instead.
  const press = useRef({ timer: 0, long: false, touch: false, lift: 0 });
  const [open, setOpen] = useState(false);
  const wide = width.mode === 'wide';
  const label = t('Wide terminal');
  const stop = () => { clearTimeout(press.current.timer); press.current.timer = 0; };
  const pick = choice => { setOpen(false); ui.actions.setTerminalWidth(choice === 'fit' ? { mode: 'fit' } : { mode: 'wide', cols: choice }); };
  return (
    <>
      <IconButton
        id="h5-term-width" ref={anchor} {...named(label)} aria-pressed={wide} aria-haspopup="menu" aria-expanded={open} data-cols={wide ? width.cols : undefined}
        sx={wide ? { color: 'primary.light' } : undefined}
        onPointerDown={event => {
          press.current.touch = event.pointerType !== 'mouse';
          if (event.button) return;
          stop();
          press.current.long = false;
          press.current.timer = setTimeout(() => { press.current.timer = 0; press.current.long = true; }, LONG_PRESS_MS);
        }}
        onPointerUp={() => { stop(); if (press.current.long) { clearTimeout(press.current.lift); press.current.lift = setTimeout(() => { press.current.lift = 0; if (press.current.long) { press.current.long = false; setOpen(true); } }, LIFT_OPEN_MS); } }}
        onPointerLeave={stop} onPointerCancel={() => { stop(); press.current.long = false; }}
        // A right click opens the menu at once; a touch long press (which also fires contextmenu on Android) waits for the lift.
        onContextMenu={event => { event.preventDefault(); if (press.current.touch) { stop(); press.current.long = true; } else setOpen(true); }}
        onClick={() => { if (press.current.long) { press.current.long = false; clearTimeout(press.current.lift); press.current.lift = 0; setOpen(true); return; } ui.actions.toggleTerminalWidth(); }}
      >
        <Icon name="columnWidth" size={22} />
      </IconButton>
      <Menu id="h5-term-width-menu" anchorEl={anchor.current} open={open} onClose={() => setOpen(false)} MenuListProps={{ 'aria-label': label }}>
        <MenuItem selected={!wide} onClick={() => pick('fit')} sx={{ minHeight: 44 }}>{t('Fit to screen')}</MenuItem>
        {WIDE_CHOICES.map(cols => (
          <MenuItem key={cols} selected={wide && width.cols === cols} data-cols={cols} onClick={() => pick(cols)} sx={{ minHeight: 44 }}>{t(`${cols} columns, scroll sideways`)}</MenuItem>
        ))}
      </Menu>
    </>
  );
}

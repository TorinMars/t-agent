import { useRef, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { Pill, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { Dot, overlay, useShownKind, useShownState } from './Columns.jsx';
import { AGENT_NAMES, STATE_WORDS, WAITING_WORDS, stateWord } from './columns.mjs';
import { DeviceTag } from './TaskDrawer.jsx';
import { shallowEqual } from './store.mjs';
import { countRender, useStore } from './use-store.mjs';

// The device of the shown task, as the task list tags it: its row's own engine tag (h5.js tags the rows whenever the order can be changed or more than one
// device is listed), drawn by the same DeviceTag in its closed look. Without a tag (one device and no sorting, or a task its list does not show) the
// header names a remote device in plain text, as before, and this machine not at all. Only the tag is taken from the list (h5.js keeps an unchanged
// tag the same object, store.mjs `share`), so a change of another row does not draw the header.
const HEADER = state => {
  const shown = state.taskList && Array.isArray(state.taskList.tasks) ? state.taskList.tasks.find(row => row.selected && row.device) : null;
  return {
    wide: state.wide, sidebarCollapsed: state.sidebarCollapsed, tasksOpen: state.tasksOpen, taskName: state.taskName, sourceLabel: state.sourceLabel,
    sessionName: state.sessionName, terminalWidth: state.terminalWidth, pane: state.pane, tag: shown ? shown.device : null,
    hasTarget: Boolean(state.shownTarget), agent: state.terminalAgent || '', updateDot: Boolean(state.updateDot),
  };
};

// The session header ("Session header" in docs/design/page-navigation.md).
// Computer (wide layout): a dense 48px bar that reads like a column header (Columns.jsx `ColumnHeader`): the sidebar fold toggle, the state dot of the
// session shown, its device tag and "task · session" on one line cut with an ellipsis (a click unfolds a folded sidebar), the agent and its state; at
// the right "Wide terminal" and "More" (Refresh the page). Update is in the navigation rail there.
// Phone: a 56px MD2 top app bar: the menu button (opens the task drawer), the task name over a status line (dot, device tag, session, state), "Wide
// terminal" and "More" (Refresh the page, Update with its red dot).
export function Header({ ui }) {
  const state = useStore(ui, HEADER, shallowEqual);
  countRender('Header');
  // A column of the multi-column view: the top page draws the column's header (Columns.jsx `ColumnHeader`) and acts on this page by messages
  // (pane.mjs), so the page's own header would only say the same things twice.
  if (state.pane) return null;
  const wide = state.wide;
  const docked = wide && !state.sidebarCollapsed; // the permanent sidebar is shown, so the task name opens nothing
  const fold = state.sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  const tag = state.tag;
  const device = tag ? (
    <Box id="h5-task-service" className="h5-task-service h5-task-device" component="span" sx={{ flex: '0 1 auto', minWidth: 0, display: 'inline-flex', maxWidth: '40%' }}>
      <DeviceTag device={tag} />
    </Box>
  ) : state.sourceLabel ? (
    <Typography id="h5-task-service" className="h5-task-service" variant="caption" component="span" color="primary.light" noWrap translate="no" title={state.sourceLabel}
      sx={{ flex: '0 1 auto', maxWidth: '40%', fontWeight: 500 }}>{state.sourceLabel}</Typography>
  ) : null;
  const taskName = state.taskName || t('Choose a task');
  return (
    <AppBar position="static" color="default" elevation={0} className="h5-header" data-layout={wide ? 'wide' : 'phone'}
      sx={{ flex: '0 0 auto', bgcolor: 'background.paper', backgroundImage: overlay(1), borderBottom: 1, borderColor: 'divider' }}>
      {/* 47px + the 1px line = 48px on a computer; 55px + 1px = 56px on a phone (the skeleton in h5.html has the same heights). */}
      <Toolbar variant="dense" disableGutters sx={{ minHeight: wide ? 47 : 55, px: wide ? 1 : 0.5, gap: wide ? 1 : 0.5 }}>
        {wide ? (
          // Wide layout: fold the permanent sidebar away and back (the state is remembered; entry.jsx `toggleSidebar`).
          <IconButton id="h5-sidebar-toggle" {...named(t(fold))} aria-expanded={!state.sidebarCollapsed} aria-controls="h5-tasks" onClick={() => ui.actions.toggleSidebar()} sx={{ color: 'text.secondary' }}>
            <Icon name={state.sidebarCollapsed ? 'sidebarUnfold' : 'sidebarFold'} size={22} />
          </IconButton>
        ) : (
          <IconButton id="h5-open-tasks" className="h5-task-button" {...named(t('Tasks'))} aria-expanded={state.tasksOpen} aria-haspopup="dialog" aria-controls="h5-tasks"
            onClick={() => ui.actions.openTasks()}>
            <Icon name="menu" size={22} />
          </IconButton>
        )}
        {wide ? (
          <ButtonBase
            id="h5-open-tasks" className="h5-task-button" aria-expanded={state.tasksOpen && !state.sidebarCollapsed} aria-haspopup="dialog" aria-controls="h5-tasks"
            onClick={() => ui.actions.openTasks()} tabIndex={docked ? -1 : 0}
            sx={theme => ({ flex: '0 1 auto', minWidth: 0, height: 36, justifyContent: 'flex-start', gap: 1, px: 1, borderRadius: 1, textAlign: 'left', pointerEvents: docked ? 'none' : 'auto',
              '@media (hover: hover)': { '&:hover': { bgcolor: 'action.hover' } }, '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } })}
          >
            {state.hasTarget ? <StateDot ui={ui} /> : null}
            {device}
            <Typography id="h5-task-name" className="h5-task-name" variant="subtitle1" component="span" noWrap translate={state.taskName ? 'no' : undefined}
              sx={{ flex: '0 1 auto', minWidth: 0, fontWeight: 500 }}>{taskName}</Typography>
            {state.sessionName ? (
              <Typography className="h5-task-subline" variant="body2" component="span" color="text.secondary" noWrap sx={{ flex: '0 100 auto', minWidth: 0, display: 'flex', gap: 0.5 }}>
                <span aria-hidden="true">·</span>
                <Box id="h5-session-name" className="h5-session-name" component="span" translate="no" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{state.sessionName}</Box>
              </Typography>
            ) : <Box id="h5-session-name" className="h5-session-name" component="span" hidden />}
          </ButtonBase>
        ) : (
          <Box sx={{ flex: '1 1 auto', minWidth: 0, pl: 0.5 }}>
            <Typography id="h5-task-name" className="h5-task-name" variant="subtitle1" component="div" noWrap translate={state.taskName ? 'no' : undefined}
              sx={{ fontWeight: 500, lineHeight: '22px' }}>{taskName}</Typography>
            <Box className="h5-task-subline" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, height: 20 }}>
              {state.hasTarget ? <StateDot ui={ui} /> : null}
              {device}
              <Typography id="h5-session-name" className="h5-session-name" variant="caption" component="span" color="text.secondary" noWrap translate="no" sx={{ flex: '0 1 auto', minWidth: 0 }}>{state.sessionName || ' '}</Typography>
              {state.hasTarget ? <StateWord ui={ui} /> : null}
            </Box>
          </Box>
        )}
        {wide ? (
          <>
            {state.hasTarget ? <StateHint ui={ui} agent={state.agent} /> : null}
            <Box sx={{ flex: '1 1 auto' }} />
          </>
        ) : null}
        {state.terminalWidth ? <WidthButton width={state.terminalWidth} ui={ui} /> : null}
        <MoreMenu ui={ui} phone={!wide} updateDot={state.updateDot} />
      </Toolbar>
    </AppBar>
  );
}

// The parts that show the live state of the session (running / needs you / idle, Columns.jsx `useShownState`) subscribe to it themselves, so an
// activity push draws them only when that state changes and never the header.
function StateDot({ ui }) {
  const state = useShownState(ui) || 'idle';
  return <Dot state={state} className="h5-header-dot" />;
}
// Computer: the agent and "running" in a caption after the names (as a column header shows the agent), or a "Needs you" chip ("Needs selection" /
// "Needs acceptance" while it waits at that kind of question).
function StateHint({ ui, agent }) {
  const state = useShownState(ui);
  const kind = useShownKind(ui);
  if (state === 'waiting') return <Pill className="h5-header-needs" data-waiting={kind || undefined} label={t(WAITING_WORDS[kind] || 'Needs you')} tone="warning" sx={{ flex: '0 0 auto', height: 22, px: 1, typography: 'caption', fontWeight: 500 }} />;
  if (state !== 'running') return null;
  return (
    <Typography className="h5-header-hint" variant="caption" component="span" color="text.secondary" noWrap sx={{ flex: '0 0 auto' }}>
      {[AGENT_NAMES[agent], t(STATE_WORDS.running)].filter(Boolean).join(' · ')}
    </Typography>
  );
}
// Phone: "· running" / "· needs you" after the session name on the status line.
function StateWord({ ui }) {
  const state = useShownState(ui);
  const kind = useShownKind(ui);
  if (state !== 'running' && state !== 'waiting') return null;
  return (
    <Typography className="h5-header-state" variant="caption" component="span" noWrap color={state === 'waiting' ? 'warning.main' : 'text.secondary'} sx={{ flex: '0 0 auto' }}>
      {`· ${t(stateWord(STATE_WORDS, state, kind))}`}
    </Typography>
  );
}

// "More" at the right end of the header: Refresh the page (`#h5-refresh`: the cache cleared and the page loaded again), and on a phone Update (the
// rail's updater opens its dialog: `ui.actions.openUpdate`, registered by Update.jsx `UpdateButton`; the focus comes back to this button). The red dot of
// a waiting update shows on the button too, so it is seen without opening the menu.
function MoreMenu({ ui, phone, updateDot }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  const label = t('More');
  const dot = phone && updateDot;
  return (
    <>
      <IconButton id="h5-header-more" ref={anchor} {...named(label)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'h5-header-more-menu' : undefined}
        data-attention={dot ? 'true' : undefined} onClick={() => setOpen(true)} sx={{ color: 'text.secondary' }}>
        <Badge variant="dot" color="error" invisible={!dot} overlap="circular"><Icon name="taskMore" size={22} /></Badge>
      </IconButton>
      <Menu id="h5-header-more-menu" anchorEl={anchor.current} open={open} onClose={() => setOpen(false)} slotProps={{ list: { 'aria-label': label, dense: !phone } }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <MenuItem id="h5-refresh" onClick={() => { setOpen(false); ui.actions.refresh(); }} sx={{ minHeight: 44 }}>
          <ListItemIcon><Icon name="reload" size={20} /></ListItemIcon>
          <ListItemText>{t('Refresh the page')}</ListItemText>
        </MenuItem>
        {phone ? (
          <MenuItem id="h5-header-update" data-attention={updateDot ? 'true' : undefined} aria-haspopup="dialog"
            onClick={() => { setOpen(false); if (ui.actions.openUpdate) ui.actions.openUpdate(anchor.current); }} sx={{ minHeight: 44 }}>
            <ListItemIcon><Badge variant="dot" color="error" invisible={!updateDot} overlap="circular"><SystemUpdateAltIcon sx={{ fontSize: 20 }} /></Badge></ListItemIcon>
            <ListItemText>{t('Update')}</ListItemText>
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

// The terminal width switch (h5.js `setTerminalWidth`, "Terminal width" in docs/design/page-terminal-and-bottom-bar.md). A tap switches Fit <-> Wide (the PTY gets the chosen column
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

import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { alpha, getOverlayAlpha } from '@mui/material/styles';
import Chip from '@mui/material/Chip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { DialogError, DomIcon, api, deviceParts, deviceText, t, terminalMark } from './common.jsx';
import { shortName, tagColor } from './task-order.mjs';
import { TOUCH } from './theme.mjs';
import { Icon } from './Icons.jsx';
import { ArchivedTasks } from './ArchivedTasks.jsx';
import { DRAG_SX, useListDrag } from './list-drag.jsx';
import { shallowEqual } from './store.mjs';
import { countRender, useStore, useStoreKeys } from './use-store.mjs';

const GLYPHS = { shell: '>_', claude: '✳', codex: 'GPT' };

// The sessions under a task are its terminals. Every session row has "⋯" actions, under the selected task or any other.
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };

// The live state of a session (h5.js `sessionState`, from the pushed terminal activity): its words and the colours of the column headers (Columns.jsx
// `STATE_COLORS`: green running, orange needs you, grey idle). The dot takes the main shade; the status line the light one, which reads better as text.
const STATE_WORDS = { running: 'Running', waiting: 'Needs you', idle: 'Idle' };
const STATE_DOT = { running: 'success.main', waiting: 'warning.main', idle: 'text.disabled' };
const STATE_TEXT = { running: 'success.light', waiting: 'warning.light', idle: 'text.secondary' };

// What a session row is: "Claude session", "Codex session" or "Terminal" (the glyph of its tile shows it; screen readers get the words).
const kindOf = row => (AGENT_NAMES[row.agent] ? `${AGENT_NAMES[row.agent]} session` : 'Terminal');

// The second line of a session row: its live state ("Running", "Needs you", "Idle"; what it is while the state is not known), then the folder of a
// terminal that kept its own directory after the task's working directory changed (the full path is the row's tooltip).
function subtitle(row) {
  const state = row.status ? t(STATE_WORDS[row.status]) : row.kind === 'terminal' ? t(kindOf(row)) : '';
  const folder = row.otherDir ? row.otherDir.replace(/\/+$/, '').split('/').pop() || row.otherDir : '';
  return [state, folder].filter(Boolean).join(' \u00B7 ');
}

// The selected row, a task or a session: the MD2 selected list item (primary at 12% with a 3px indicator at the left edge, drawn inside the row so it takes no width).
const SELECTED_SX = theme => ({ bgcolor: alpha(theme.palette.primary.main, 0.12), boxShadow: `inset 3px 0 0 ${theme.palette.primary.main}` });
// The hover look of a whole row line (the tag, the name and the buttons), where a pointer can hover.
const HOVER_SX = { '@media (hover: hover)': { '&:hover': { bgcolor: 'action.hover' } } };
// A status dot (8px), in the colour of its state.
const DOT_SX = { flex: '0 0 auto', display: 'inline-block', width: 8, height: 8, borderRadius: '50%' };
// The buttons of a row on a computer appear while the pointer is over its line or the keyboard focus is inside it (`:focus-visible`, so a click that
// leaves the focus on the row does not keep them shown); they keep their place (opacity only), so nothing moves, and Tab still reaches them. On a touch
// screen they are always shown.
const REVEAL_SX = {
  '& .h5-row-act': { opacity: 0, transition: 'opacity 120ms ease-out' },
  '&:hover .h5-row-act, &:has(:focus-visible) .h5-row-act': { opacity: 1 },
  '@media (prefers-reduced-motion: reduce)': { '& .h5-row-act': { transition: 'none' } },
  // Its own key, so it does not replace the row's own [TOUCH] rules when spread into them.
  [`${TOUCH} .h5-row-act`]: { opacity: 1 },
};

// Keeps the node in the visible part of the task list: when it appears, and when the visible area changes (the on-screen keyboard opens or closes;
// the sheet follows the visual viewport through --h5-height). With the focus inside it, the form of the focused field (with its outline) is kept in view.
function useInView(ref) {
  useEffect(() => {
    const show = () => {
      const node = ref.current;
      if (!node) return;
      const active = document.activeElement;
      const form = active && node.contains(active) ? active.closest('form') : null;
      (form && node.contains(form) ? form : node).scrollIntoView({ block: 'nearest' });
    };
    show();
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    viewport.addEventListener('resize', show);
    return () => viewport.removeEventListener('resize', show);
  }, [ref]);
}

// Escape in a name field closes it. preventDefault: the page does not pass the key on to the terminal (h5.js), and the sheet of a phone stays open.
const escapeCancels = ui => event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  ui.actions.menuCancel();
};

// The two create dialogs lie over the page like the task dialogs (TaskDialogs.jsx: a MUI Dialog, so the back gesture, Escape and a tap beside them close
// them), in the one dialog pattern of the theme ("One dialog pattern" in docs/design/page-dialogs.md). They fill only the visible area (--h5-height follows
// the visual viewport, h5.js `fitViewport`), so with the on-screen keyboard up the dialog sits above it; only the fields scroll while the title and the
// buttons stay. New session is a short centred dialog (16px margins on a phone, from the theme); New task, a longer form, is full screen on a phone. The
// focused field is kept in view when the keyboard opens or closes.
const CREATE_DIALOG_SX = { bottom: 'auto', height: 'var(--h5-height, 100%)' };
const DIALOG_FORM_SX = { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' };
function useFocusedInView(open) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return undefined;
    const show = () => {
      const active = document.activeElement;
      if (active && active.closest && active.closest('.MuiDialog-paper')) active.scrollIntoView({ block: 'nearest' });
    };
    viewport.addEventListener('resize', show);
    return () => viewport.removeEventListener('resize', show);
  }, [open]);
}

// The shortcut that opens the New session dialog for the task shown (h5.js, the capture-phase keydown after Cmd/Ctrl+K), shown in the title of the "+".
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const NEW_SESSION_KEYS = APPLE ? ' (⌘⇧O)' : ' (Ctrl+Shift+O)';
const optionId = index => `h5-new-session-option-${index}`;
// A key that belongs to an input method composing text: Enter and the arrows are left to it.
const composing = event => Boolean(event.nativeEvent && event.nativeEvent.isComposing) || event.keyCode === 229;

// The New session dialog of the "+" of a task, of "New session" in the empty terminal area and of Cmd/Ctrl+Shift+O (h5.js `addSession`, `menu.naming`): the
// task's title (and its service when it is not this machine), the optional name field, then the choices as full-width buttons and Cancel. The first list is
// Claude session, Codex session, New Terminal (`pick` items): one is highlighted, Claude session first. The field takes the focus, as in the other dialogs;
// Up and Down in it move the highlight (wrapping) while the focus stays in the field (`aria-activedescendant`), and Enter makes a NEW session of the highlighted
// kind with the typed name (`menuPick`). Tab moves the focus into the choices, one stop (roving tabIndex: only the highlighted one is in the tab order); there
// Up and Down move the highlight with the focus, Enter makes the focused kind, Shift+Tab goes back to the field. A press (pointer, or Space on a focused
// choice) on Claude / Codex session opens its sub-list (New …, the earlier sessions, Back), which replaces the choices; there Enter in the field runs New ….
// While the terminal is being made nothing can be pressed and the dialog does not close; a failure is shown under the choices.
export function NewSessionDialog({ state, ui }) {
  const menu = state.menu && state.menu.naming ? state.menu : null;
  const open = Boolean(menu);
  const [shown, setShown] = useState(menu); // what was last shown, kept while the dialog fades out
  if (menu && menu !== shown) setShown(menu);
  const view = menu || shown;
  useFocusedInView(open);
  // The highlighted choice, for the list it was chosen in: a new list (another opening, a sub-list, Back) starts on its first choice again.
  const [highlight, setHighlight] = useState({ items: null, at: 0 });
  const busy = Boolean(view && view.busy);
  const close = () => { if (!busy) ui.actions.menuCancel(); };
  const picks = view ? view.items.map((item, index) => (item.pick ? index : -1)).filter(index => index >= 0) : [];
  const at = view && highlight.items === view.items && highlight.at < picks.length ? highlight.at : 0;
  const active = picks.length ? picks[at] : -1;
  const setAt = next => setHighlight({ items: view.items, at: next });
  const step = delta => (at + delta + picks.length) % picks.length;
  const create = index => { if (!busy) { if (index >= 0) ui.actions.menuPick(index); else ui.actions.menuNameSubmit(); } };
  const plainKey = event => !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !composing(event);
  const arrow = event => (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0);
  const fieldKey = event => {
    if (!plainKey(event)) return;
    if (event.key === 'Enter') { event.preventDefault(); create(active); return; }
    if (arrow(event) && picks.length) { event.preventDefault(); setAt(step(arrow(event))); }
  };
  const optionKey = (event, index) => {
    if (!plainKey(event)) return;
    if (event.key === 'Enter') { event.preventDefault(); create(index); return; } // not the press of the button: that opens the sub-list
    if (arrow(event)) {
      event.preventDefault();
      const next = (picks.indexOf(index) + arrow(event) + picks.length) % picks.length;
      setAt(next);
      const node = document.getElementById(optionId(picks[next]));
      if (node) node.focus();
    }
  };
  return (
    <Dialog id="h5-new-session" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-new-session-title" sx={CREATE_DIALOG_SX}>
      {view ? (
        <Box component="form" id="h5-new-name" className="h5-menu-name" autoComplete="off" sx={DIALOG_FORM_SX} onSubmit={event => { event.preventDefault(); create(active); }}>
          <DialogTitle id="h5-new-session-title">{t('New session')}</DialogTitle>
          <DialogContent>
            <DialogContentText id="h5-new-session-task" variant="body2" translate="no">{view.taskTitle}</DialogContentText>
            {view.service ? <Typography id="h5-new-session-service" variant="caption" component="p" color="text.secondary" translate="no" sx={{ overflowWrap: 'anywhere' }}>{view.service}</Typography> : null}
            <TextField
              id="h5-new-name-input" key={view.task} name="name" size="small" fullWidth autoFocus defaultValue={view.name} placeholder={t('Name (optional)')} disabled={busy}
              onChange={event => ui.actions.menuName(event.target.value)} onKeyDown={fieldKey} sx={{ mt: 2 }}
              slotProps={{ htmlInput: {
                maxLength: 40, enterKeyHint: 'go', autoCapitalize: 'off', spellCheck: false, 'aria-label': t('Name (optional)'),
                ...(active >= 0 ? { role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'h5-term-menu-actions', 'aria-autocomplete': 'none', 'aria-activedescendant': optionId(active) } : {}),
              } }}
            />
            {view.sub ? <Typography id="h5-new-session-sub" variant="overline" component="h3" color="text.secondary" sx={{ display: 'block', mt: 2, mb: -1 }}>{t(view.sub)}</Typography> : null}
            {/* The choices: an MD2 simple-dialog list, edge to edge; the highlighted one is the selected row. */}
            <Box id="h5-term-menu-actions" className="h5-menu-actions" role={active >= 0 ? 'listbox' : 'group'} aria-label={t(view.sub || 'New session')} sx={{ display: 'flex', flexDirection: 'column', mt: 1, mx: -3 }}>
              {view.items.map((item, index) => {
                const option = item.pick && active >= 0;
                const on = option && index === active;
                return (
                  <ListItemButton
                    key={`${index}:${item.label}`} component="button" type="button" selected={on} disabled={busy}
                    className={[item.kind === 'danger' ? 'danger' : '', on ? 'h5-choice-on' : ''].filter(Boolean).join(' ') || undefined}
                    onClick={() => ui.actions.menuRun(index)}
                    {...(option ? {
                      id: optionId(index), role: 'option', 'aria-selected': on ? 'true' : 'false', tabIndex: on ? 0 : -1,
                      onKeyDown: event => optionKey(event, index), onFocus: () => { if (!on) setAt(picks.indexOf(index)); },
                    } : {})}
                    sx={{
                      width: '100%', flex: '0 0 auto', minHeight: 48, px: 3, border: 0, typography: 'body1', textAlign: 'left', overflowWrap: 'anywhere',
                      color: item.kind === 'danger' ? 'error.light' : 'text.primary',
                      // The focus ring stands inside the row, apart from the highlight (the selected row).
                      '&:focus-visible, &.Mui-focusVisible': { outline: '2px solid', outlineColor: 'text.primary', outlineOffset: '-2px' },
                    }}
                  >
                    {item.kind === 'raw' ? item.label : t(item.label)}
                  </ListItemButton>
                );
              })}
            </Box>
            {active >= 0 ? <Typography id="h5-new-session-keys" variant="caption" component="p" color="text.secondary" sx={{ mt: 1, [TOUCH]: { display: 'none' } }}>{t('Enter to create · ↑↓ to choose')}</Typography> : null}
            {busy ? <Typography id="h5-new-session-busy" role="status" variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('Creating…')}</Typography> : null}
            {view.error ? <DialogError id="h5-new-session-error">{view.error}</DialogError> : null}
          </DialogContent>
          <DialogActions>
            <Button id="h5-term-menu-cancel" className="h5-menu-cancel" disabled={busy} onClick={close}>{t('Cancel')}</Button>
          </DialogActions>
        </Box>
      ) : null}
    </Dialog>
  );
}

// The rename field, in place of the row being renamed (same place, indentation and height). Enter or Save keeps the name; Escape or leaving the field
// cancels. The Save button does not take the focus (its pointerdown is cancelled), so pressing it does not first cancel through the blur.
function RenameRow({ menu, ui, row }) {
  const ref = useRef(null);
  useInView(ref);
  useEffect(() => {
    const input = ref.current && ref.current.querySelector('input');
    if (input) { input.focus({ preventScroll: true }); input.select(); }
  }, []);
  const keep = event => event.preventDefault();
  return (
    <Box
      ref={ref} component="form" id="h5-term-rename" className="h5-menu-rename" autoComplete="off"
      onSubmit={event => { event.preventDefault(); ui.actions.menuRename(new FormData(event.currentTarget).get('title')); }}
      sx={theme => ({ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 40, pl: 0.5, [TOUCH]: { gap: 1 }, borderRadius: 2, ...(row.current ? SELECTED_SX(theme) : {}) })}
    >
      <TextField
        id="h5-term-rename-input" name="title" size="small" fullWidth defaultValue={menu.renameValue} onKeyDown={escapeCancels(ui)} onBlur={() => ui.actions.menuCancel()}
        slotProps={{ input: { sx: { typography: 'body2' } }, htmlInput: { maxLength: 40, enterKeyHint: 'done', 'aria-label': t('Terminal name') } }}
      />
      <Button type="submit" variant="contained" size="small" onPointerDown={keep} onMouseDown={keep} sx={{ flex: '0 0 auto', minHeight: 40 }}>{t('Save')}</Button>
    </Box>
  );
}

// The sessions under a task: its terminals. Every session row has "⋯" actions, for the task the row is under. With `sessions.movable` (h5.js: the
// service saves the order and the task has two or more terminals) a terminal row is held to drag it among the task's own rows (`SESSION_DRAG`); while a
// row of the list is being renamed, none of them moves. The rows never select text or show the touch callout, so a long press is only the drag.
const HELD_ROW_SX = { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' };
function Sessions({ ui, taskId, sessions, menu, drag }) {
  const renaming = Boolean(menu && menu.rename && menu.rename.task === taskId);
  const movable = row => Boolean(sessions.movable && !renaming && row.kind === 'terminal');
  return (
    <List className="h5-terminal-list" data-task={taskId} role="group" aria-label={sessions.label} dense disablePadding sx={{ ml: 2, mr: 0.5, pb: 0.5 }}>
      {sessions.note ? <Typography className="h5-peek-note" variant="body2" color="text.secondary" sx={{ px: 1, py: 0.75 }}>{t(sessions.note)}</Typography> : null}
      {sessions.rows.map(row => (
        <React.Fragment key={`${row.kind}:${row.id}`}>
        {row.more && menu && menu.rename && menu.rename.task === taskId && menu.rename.kind === row.kind && menu.rename.id === row.id ? <RenameRow menu={menu} ui={ui} row={row} /> : (
        <Box
          className="h5-terminal-row" data-session={row.kind === 'terminal' ? row.id : undefined} data-status={row.status || undefined} data-movable={movable(row) ? 'true' : undefined} {...(movable(row) && drag ? drag.hold() : {})}
          sx={theme => ({ display: 'flex', alignItems: 'center', gap: 0.5, pr: 0.5, [TOUCH]: { gap: 1, pr: 0 }, borderRadius: 2, ...(row.current ? SELECTED_SX(theme) : HOVER_SX), ...REVEAL_SX, ...HELD_ROW_SX })}
        >
          <ListItemButton
            component="button" className="h5-terminal-main" aria-current={row.current ? 'true' : undefined}
            selected={row.current} onClick={() => ui.actions.openRow(taskId, row)}
            sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 40, py: 0.25, pl: 1, pr: 0.5, borderRadius: 2, gap: 1.25, textAlign: 'left', '&:hover, &.Mui-selected, &.Mui-selected:hover': { bgcolor: 'transparent' } }}
          >
            <SessionKindIcon agent={row.kind === 'terminal' ? row.agent : null} title={t(kindOf(row))}>
              {/* The live state as a dot on the tile's corner, ringed in the list's colour so it stands apart from the tile. */}
              {row.status ? <Box component="span" className="h5-terminal-dot" sx={{ ...DOT_SX, position: 'absolute', right: -3, bottom: -3, width: 10, height: 10, bgcolor: STATE_DOT[row.status], boxShadow: theme => `0 0 0 2px ${theme.palette.background.paper}` }} /> : null}
            </SessionKindIcon>
            <Box component="span" sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <Box component="span" className="h5-terminal-name" sx={{ typography: 'body2', fontWeight: row.current ? 500 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</Box>
              {subtitle(row) ? (
                <Box component="span" className="h5-terminal-sub" title={row.otherDir ? `${t('Directory')}: ${row.otherDir}` : undefined} sx={{ typography: 'caption', lineHeight: 1.35, color: row.status ? STATE_TEXT[row.status] : 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {/* What the session is, for screen readers (the tile shows it as a glyph) when the line names its state. */}
                  {row.status && row.kind === 'terminal' ? <Box component="span" sx={VISUALLY_HIDDEN}>{`${t(kindOf(row))}, `}</Box> : null}
                  {subtitle(row)}
                </Box>
              ) : null}
            </Box>
          </ListItemButton>
          {row.more ? (
            <IconButton className="h5-terminal-more h5-row-act" size="small" sx={{ p: 0.5 }} aria-label={t('Terminal actions')} title={t('Terminal actions')} aria-haspopup="menu" onClick={event => ui.actions.rowMore(taskId, row, event.currentTarget)}>
              <Icon name="taskMore" size={20} />
            </IconButton>
          ) : null}
        </Box>)}
        </React.Fragment>
      ))}
    </List>
  );
}

// The tile that says what a session is: the Claude or Codex mark, or `>_` for a plain shell. Also the cards of the session switcher (Switcher.jsx).
export function SessionKindIcon({ agent, title, size = 28, children }) {
  return (
    <Box component="span" className={`h5-terminal-icon ${agent || 'shell'}`} aria-hidden="true" title={title} sx={{ position: 'relative', flex: `0 0 ${size}px`, width: size, height: size, borderRadius: 1.5, bgcolor: 'action.hover', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', typography: 'caption', fontFamily: 'monospace', color: agent === 'claude' ? '#d97757' : 'text.secondary', '& svg': { width: Math.round(size * 0.64), height: Math.round(size * 0.64) } }}>
      {agent ? <DomIcon make={terminalMark(agent)} /> : GLYPHS.shell}
      {children}
    </Box>
  );
}

// The engine tag of a task (the pill): the device's engine name cut to 8 characters (the full name, "Offline" and why its tasks cannot be moved are the
// `title`), in the colour its instance id gives it on every client (task-order.mjs). An offline device's tag is muted (dashed, disabled text). With the
// task's sessions open (`expanded`) the tag shows it in the same width: its 1px border takes the tag's own colour (solid; the text colour for an
// offline tag) and the tint gets stronger.
export function DeviceTag({ device, unplaced, expanded }) {
  const parts = deviceParts(device);
  const { index, color, background, open } = tagColor(device.instanceId);
  const title = [deviceText(device), device.offline ? t('Offline') : '', unplaced ? t('Its tasks can be moved once this device is updated') : ''].filter(Boolean).join(' · ');
  const look = device.offline
    ? (expanded ? { color: 'text.secondary', bgcolor: 'action.selected', borderColor: 'text.secondary', borderStyle: 'dashed' }
      : { color: 'text.disabled', bgcolor: 'transparent', borderColor: 'divider', borderStyle: 'dashed' })
    : (expanded ? { color, bgcolor: open, borderColor: color } : { color, bgcolor: background, borderColor: 'transparent' });
  return (
    <Box
      component="span" className="h5-device-tag" data-source={device.key} data-color={index} data-offline={device.offline ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined} title={title} translate="no"
      sx={{
        flex: '0 0 auto', display: 'inline-block', boxSizing: 'border-box', maxWidth: 104, height: 20, px: 0.75, borderRadius: 10, border: 1,
        fontSize: 11, fontWeight: 600, lineHeight: '18px', letterSpacing: 0, textTransform: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        transition: 'background-color 120ms ease-out, border-color 120ms ease-out', '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        ...look,
      }}
    >
      {device.local && !device.name ? parts.name /* "This machine" of an older server: a short word, never cut */ : shortName(parts.name)}
    </Box>
  );
}

// Sorting the list (h5.js "Task order"). A row that can be moved is picked up two ways. Its engine tag at the left edge (`TaskTag`) drags at once: with a
// mouse after a move of 4px; a finger needs no long press (the tag has `touch-action: none`, so it never scrolls the list) and starts after 4px too; a
// plain tap or click on the tag (no drag started) opens or closes the task's sessions, like a tap on the row. The rest of the row's line (`.h5-task-head`,
// not its "⋯" and "+") is held, like a session row: a finger held still for HOLD_MS picks the task up (a short vibration); a finger that moves more than
// HOLD_SLOP_PX before that scrolls the list, and a short tap opens or closes the task as before; a release after the hold opens nothing (its click is
// swallowed). The line keeps `touch-action: auto` and never selects text or shows the touch callout or the context menu while pressed. A mouse picks the
// task up after HOLD_MS or a move of DRAG_MOVE_PX; a plain click opens or closes it, and the click after a drag is swallowed. From the keyboard the tag
// is a button: Space or Enter picks the task up, Up and Down move it, Space or Enter drops it and Escape (or leaving the tag) puts it back; a live region
// says where it is. The row button stays the keyboard's way to open and close the task.
// While dragging, a copy of the row floats under the pointer, its place in the list is an empty slot of the same height, and the other rows slide out of
// the way (transforms only: the rows are measured once when the drag starts, and nothing is laid out again per frame). Near the top or the bottom edge the
// list scrolls. The drop asks h5.js to move the task (`reorderTask`: before the task now after the slot, or after the last one), which saves the whole
// order; the copy settles into the slot. The rows are the ones shown, so with a search or a filter on, a task goes next to the tasks it was dropped between.
// Every other change of the order (a menu move, a newer order from the server, a save that failed and moved back) slides the rows to their new places
// too (FLIP, in `useListDrag`'s layout effect: each row, open or closed, slides by the difference of its own top, so rows with session lists of other
// heights land right, and a change that comes while the last one still slides starts from where the rows are seen). `prefers-reduced-motion: reduce`
// makes every move instant.
// The sessions of a task are sorted the same way (h5.js "Session order"), within their own task only (`SESSION_DRAG`): the whole row is the grip, but it has
// to be held. A finger held still for HOLD_MS picks the row up (a short vibration where the phone has one); a finger that moves more than HOLD_SLOP_PX
// before that is scrolling the list, and a short tap opens the session as before. The row keeps `touch-action: auto`, so the list scrolls from it; once the
// row is picked up, the list's touchmove is cancelled instead (a non-passive listener, which iOS Safari needs too). A mouse picks the row up after HOLD_MS
// or a move of DRAG_MOVE_PX; a plain click opens the session, and the click after a drag (or a hold) is swallowed. The copy stays inside the task's own
// rows. The "⋯" of a session row offers Move up and Move down for the keyboard (h5.js).
// The hook, its timings and the drag styles are shared with the T-Attention list (list-drag.jsx).
// What differs between the two lists that are sorted by dragging. `rows`: the rows the slides follow; `key`: a row's name; `group`: rows move only among
// the rows of their own group; `peers`: the rows a picked one moves among; `head`: the part that is copied; `clamp`: the copy stays inside its peers;
// `hold`: a press on the grip must be held (or, with a mouse, moved) to pick the row up (a row's `hold()` props always must); `ignore`: the controls of a
// held row that never start a drag; `drop`: the row was dropped somewhere else.
const TASK_DRAG = {
  rows: list => [...list.querySelectorAll('.h5-task[data-ref]')],
  key: el => el.dataset.ref,
  group: () => '',
  row: handle => handle.closest('.h5-task'),
  peers: list => [...list.querySelectorAll('.h5-task[data-movable="true"]')],
  head: row => row.querySelector('.h5-task-head') || row,
  floatClass: 'h5-task-float',
  clamp: false,
  hold: false, // the tag drags at once; the row's line is held (`hold()` on `.h5-task-head`)
  ignore: '.h5-task-tag, .h5-task-more, .h5-task-add, input, textarea',
  focus: (list, ref) => [...list.querySelectorAll('.h5-task[data-movable="true"]')].find(el => el.dataset.ref === ref)?.querySelector('button.h5-task-tag') || null,
  dragging: (ui, on) => ui.actions.taskDragging(on),
  tap: (ui, ref) => ui.actions.toggleTask(ref),
  drop: (ui, s, others) => {
    const after = s.index >= others.length;
    const target = (after ? others[others.length - 1] : others[s.index]).ref;
    ui.actions.reorderTask(s.ref, target, after);
  },
};
const sessionsOf = row => row.closest('.h5-terminal-list');
const SESSION_DRAG = {
  rows: list => [...list.querySelectorAll('.h5-terminal-list[data-task] > .h5-terminal-row[data-session]')],
  key: el => `${sessionsOf(el).dataset.task}\n${el.dataset.session}`,
  group: el => sessionsOf(el).dataset.task,
  row: handle => handle.closest('.h5-terminal-row'),
  peers: (list, row) => [...sessionsOf(row).querySelectorAll(':scope > .h5-terminal-row[data-movable="true"]')],
  head: row => row,
  floatClass: 'h5-task-float h5-session-float',
  clamp: true,
  hold: true,
  focus: () => null,
  dragging: (ui, on) => ui.actions.sessionDragging(on),
  tap: null, // a tap is the row's own click: it opens the session
  drop: (ui, s, others, say) => {
    const ids = others.map(item => item.el.dataset.session);
    ids.splice(s.index, 0, s.rows[s.from].el.dataset.session);
    ui.actions.reorderSessions(sessionsOf(s.rows[s.from].el).dataset.task, ids);
    say(t(`Moved to position ${s.index + 1} of ${s.rows.length}`));
  },
};

// The engine tag is the one control at the left edge of a task row (`TaskTag`): it names the device, shows whether the task is open, and is the drag
// grip. It is as wide as its pill and as tall as the row, so on a touch screen its target is 44px tall (the row is 44px), and the hit area (`::after`)
// reaches 6px past the pill on each side (into the list's padding and over the gap), and is at least 44px wide for a short name, so the row is no taller
// and nothing is added to its width. A tag that can be dragged is a button with `touch-action: none` (only the tag: the list scrolls everywhere else) and
// the grab cursor; its keyboard focus rings the pill. A tag that cannot be dragged (an Engine with no instance id yet, or no sorting) is a plain span; a
// tap on it still opens or closes the task.
const TAG_SX = {
  flex: '0 0 auto', alignSelf: 'stretch', position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: 104,
  m: 0, p: 0, border: 0, borderRadius: 1, bgcolor: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer',
  userSelect: 'none', WebkitUserSelect: 'none', WebkitTapHighlightColor: 'transparent',
  '&::after': { content: '""', position: 'absolute', inset: '0 -4px 0 -4px' },
  [TOUCH]: { '&::after': { inset: 'auto', top: 0, bottom: 0, left: '50%', width: 'max(calc(100% + 12px), 44px)', transform: 'translateX(-50%)' } },
};
const GRIP_SX = {
  ...TAG_SX, cursor: 'grab', touchAction: 'none', WebkitTouchCallout: 'none',
  '&:focus-visible': { outline: 'none' },
  '&:focus-visible > .h5-device-tag': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
};
function TaskTag({ task, ui, drag }) {
  const tag = <DeviceTag device={task.device} unplaced={task.unplaced} expanded={task.expanded} />;
  if (task.movable) {
    return (
      <Box
        component="button" type="button" className="h5-task-tag" aria-roledescription="sortable"
        aria-label={t(`${deviceParts(task.device).name}, drag to reorder`)} {...drag.grip(task)} sx={GRIP_SX}
      >
        {tag}
      </Box>
    );
  }
  return <Box component="span" className="h5-task-tag" onClick={() => ui.actions.toggleTask(task.ref)} sx={TAG_SX}>{tag}</Box>;
}
const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

function Tasks({ taskList, rename, ui, query, filter, drag, sessionDrag }) {
  const { note, tasks } = taskList;
  if (note) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t(note)}</Typography>;
  const needle = query.trim().toLowerCase();
  const filtering = Boolean(needle) || filter !== 'all';
  // A search keeps the tasks whose name matches, or that have a matching session in a list that is open. Running and Pending keep the tasks that have such a session, known from the feeds.
  const keep = task => {
    if (!filtering) return true;
    if (filter !== 'all' && !task[filter]) return false;
    const rows = (task.sessions && task.sessions.rows) || [];
    return !needle || task.title.toLowerCase().includes(needle) || rows.some(row => row.title.toLowerCase().includes(needle));
  };
  // One flat list in the shared order (h5.js `renderTasks`): no section per device and no group titles; a search or a filter keeps that order.
  const shown = (tasks || []).filter(keep);
  if (filtering && !shown.length) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('No matching sessions')}</Typography>;
  // Every row with an engine tag (h5.js tags the rows whenever the order can be changed or more than one device is listed) starts with it: it opens and
  // closes the task, shows that it is open, and is the drag grip of a row that can be moved. Only an older server with this machine alone has no tags;
  // there the row keeps its chevron, so whether a task is open still shows.
  return shown.map(task => (
    <TaskRow
      key={task.ref} task={task} ui={ui} drag={drag} sessionDrag={sessionDrag}
      // The rename field of a session row: only the task it is under gets the menu.
      menu={rename && rename.rename.task === task.ref ? rename : null}
    />
  ));
}

// The name of a task as the person typed it (no capitals forced on it), medium weight, at most two lines with an ellipsis; the full name is its `title`.
// A computer has the compact list size (14px), a touch screen the MD2 list size (16px).
const TASK_TITLE_SX = theme => ({
  ...theme.typography.body2, fontWeight: 500, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere',
  [TOUCH]: { fontSize: theme.typography.body1.fontSize, lineHeight: 1.375 },
});
// The dot at the end of a task row: orange when one of its sessions needs the person, else green when one runs (none when all are idle).
const taskState = task => (task.pending ? 'waiting' : task.running ? 'running' : null);

// One task row with its sessions. h5.js keeps the row object of a task that did not change (store.mjs `share`) and the drag props are stable
// (`useListDrag`), so a change of one task (a pushed activity state, a session opened) draws that row alone.
// On a computer the row's "+" (New session) and "⋯" appear while the pointer is over its line or the focus is inside it, in a space kept for them (where
// the status dot is shown otherwise); on a touch screen there is one "⋯" (44px), whose menu starts with New session (h5.js `taskMore`). Both "⋯" open a
// menu under the button, as a session row's does.
const TaskRow = React.memo(function TaskRow({ task, ui, drag, sessionDrag, menu }) {
  countRender('TaskRow');
  const state = taskState(task);
  // The selected look goes to the shown session when it is listed under the row, else to the task itself.
  const selectedHere = task.selected && !(task.expanded && task.sessions && task.sessions.rows.some(row => row.current));
  return (
    <Box
      className="h5-task" data-ref={task.ref} data-source={task.source} data-movable={task.movable ? 'true' : undefined}
      sx={{ position: 'relative', ...(task.expanded ? { borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } } : {}) }}
    >
      {/* A row that can be moved is held on its line to drag it (the tag drags at once): no text selection or touch callout, but it still scrolls. */}
      <Box
        className={task.add ? 'h5-task-head h5-task-row' : 'h5-task-head'} data-selected={selectedHere ? 'true' : undefined} {...(task.movable ? drag.hold() : {})}
        sx={theme => ({
          display: 'flex', alignItems: 'center', gap: 1, pl: 1, pr: 0.5, borderRadius: 2, [TOUCH]: { pr: 0 },
          ...(selectedHere ? SELECTED_SX(theme) : HOVER_SX), ...REVEAL_SX, ...(task.movable ? HELD_ROW_SX : {}),
          '@media (hover: hover)': { '&:hover .h5-task-dot': { opacity: 0 } }, '&:has(:focus-visible) .h5-task-dot': { opacity: 0 },
        })}
      >
        {task.device ? <TaskTag task={task} ui={ui} drag={drag} /> : null}
        <ListItemButton
          component="button" className="h5-task-item" aria-current={task.selected ? 'true' : undefined} aria-expanded={task.expanded}
          onClick={() => ui.actions.toggleTask(task.ref)}
          sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 40, py: 0.5, px: 0.5, borderRadius: 2, textAlign: 'left', '&:hover': { bgcolor: 'transparent' } }}
        >
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, width: '100%', minWidth: 0 }}>
            {task.device ? null : <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', color: 'text.secondary', transform: task.expanded ? 'rotate(90deg)' : 'none' }}><Icon name="treeChevron" size={14} /></Box>}
            <Box component="span" sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <Box component="span" className="h5-task-title" title={task.title} sx={TASK_TITLE_SX}>{task.title}</Box>
              {task.count != null ? <Box component="span" className="h5-task-count" sx={{ typography: 'caption', color: 'text.secondary' }}>{task.count} {t(task.count === 1 ? 'session' : 'sessions')}</Box> : null}
            </Box>
          </Box>
        </ListItemButton>
        {task.add ? (
          <Box className="h5-task-actions" sx={{ flex: '0 0 auto', position: 'relative', display: 'flex', alignItems: 'center', gap: 0.25 }}>
            {state ? <Box component="span" className="h5-task-dot" data-state={state} aria-hidden="true" sx={{ ...DOT_SX, bgcolor: STATE_DOT[state], position: 'absolute', right: 10, top: 'calc(50% - 4px)', transition: 'opacity 120ms ease-out', [TOUCH]: { position: 'static', mr: 0.5 } }} /> : null}
            {/* "+" (pointer input only) left of "⋯" (move, rename, working directory, archive, delete), which stays at the right end of the row */}
            <IconButton className="h5-task-add h5-row-act" size="small" sx={{ p: 0.5, [TOUCH]: { display: 'none' } }} aria-label={t('New session')} title={t('New session') + NEW_SESSION_KEYS} aria-haspopup="dialog" onClick={() => ui.actions.addSession(task.ref)}><Icon name="add" size={18} /></IconButton>
            <IconButton className="h5-task-more h5-row-act" size="small" sx={{ p: 0.5 }} aria-label={t('Task actions')} title={t('Task actions')} aria-haspopup="menu" onClick={event => ui.actions.taskMore(task.ref, event.currentTarget)}><Icon name="taskMore" size={20} /></IconButton>
          </Box>
        ) : null}
      </Box>
      {task.expanded && task.sessions ? <Sessions ui={ui} taskId={task.ref} sessions={task.sessions} menu={menu} drag={sessionDrag} /> : null}
    </Box>
  );
});

// The folder name the server makes from a task title (titleToSlug in routes/tasks.js and services/engine-tasks.js), for the default path shown.
const slug = title => title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_.]/g, '').replace(/^-+|-+$/g, '') || 'task';

// The New task dialog, opened by "New task" at the end of the task list (h5.js `openNewTask`; `newTaskOpen` in the store). Every opening starts empty, on
// this machine. Create makes the task (h5.js `createTask`); the dialog closes once it is made and the new task is opened. While it is being made nothing can
// be pressed and the dialog does not close; a failure is a notice and an inline Alert, and with a working directory the field says so instead.
export function NewTaskDialog({ state, ui }) {
  const open = Boolean(state.newTaskOpen);
  const phone = useMediaQuery(theme => theme.breakpoints.down('sm'));
  const [title, setTitle] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [dirError, setDirError] = useState('');
  const [failed, setFailed] = useState(false); // the task was not created (no working directory to blame)
  const [base, setBase] = useState(null); // the folder new tasks of this machine go under (the user's setting, TASKS_BASE_DIR, else ~/tasks)
  const [on, setOn] = useState('local'); // "Create on": the service a new task is made on; this machine unless chosen
  useFocusedInView(open);
  useEffect(() => { if (open) { setTitle(''); setWorkDir(''); setDirError(''); setFailed(false); setOn('local'); } }, [open]);
  // The services a task can be made on: online and in the list. A choice that went offline or was hidden meanwhile falls back to this machine, or the first that is left.
  const targets = state.sources.filter(source => !source.offline && !source.hidden);
  const picked = targets.find(source => source.key === on) || targets.find(source => source.key === 'local') || targets[0];
  const onKey = picked ? picked.key : 'local';
  const target = ui.actions.newTaskTarget ? ui.actions.newTaskTarget(onKey) : { local: true };
  useEffect(() => {
    if (!open || !target.local) return;
    let live = true;
    api('GET', '/auth/me').then(user => { if (live) setBase((user && user.effective_work_dir) || null); }).catch(() => {});
    return () => { live = false; };
  }, [open, target.local]);
  // An empty field keeps the default rule: the path shown is only a hint and is never sent.
  const defaultPath = target.local && base ? `${base.replace(/\/+$/, '')}/${slug(title.trim() || 'task')}` : '';
  const submit = async event => {
    event.preventDefault();
    const value = title.trim();
    const dir = workDir.trim();
    if (!value || state.creatingTask) return;
    if (dir && ui.actions.isAbsolutePath && !ui.actions.isAbsolutePath(dir)) { setDirError('Enter an absolute path'); return; }
    setDirError('');
    setFailed(false);
    if (!(await ui.actions.createTask(value, dir, onKey))) { if (dir) setDirError('The task was not created. Check the working directory.'); else setFailed(true); }
  };
  const busy = state.creatingTask;
  const close = () => ui.actions.closeNewTask();
  return (
    <Dialog id="h5-new-task-dialog" open={open} onClose={close} fullWidth maxWidth="sm" fullScreen={phone} aria-labelledby="h5-new-task-title-label" sx={CREATE_DIALOG_SX}>
      <Box component="form" id="h5-new-task" className="h5-new-task" autoComplete="off" onSubmit={submit} sx={DIALOG_FORM_SX}>
        <DialogTitle id="h5-new-task-title-label" sx={phone ? { pt: 'max(16px, env(safe-area-inset-top))' } : null}>{t('New task')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            id="h5-new-task-title" autoFocus size="small" fullWidth placeholder={t('New task title')} value={title} onChange={event => setTitle(event.target.value)} sx={{ mt: 1 }}
            slotProps={{ htmlInput: { maxLength: 200, enterKeyHint: 'done', 'aria-label': t('New task title') } }} // no floating label: its id would be the dialog title's
          />
          {/* "Create on" comes after the title (the first field, with the focus): it decides the default working directory shown below it. */}
          {state.sources.length > 1 ? (
            <TextField
              id="h5-new-task-on" className="h5-new-task-on-row" select size="small" fullWidth label={t('Create on')} value={onKey} onChange={event => setOn(event.target.value)}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': t('Create on') } }}
            >
              {targets.map(source => <option key={source.key} value={source.key}>{deviceText(source)}</option>)}
            </TextField>
          ) : null}
          <TextField
            id="h5-new-task-dir" size="small" fullWidth label={t('Working directory')} value={workDir} placeholder={defaultPath || t('Default folder')}
            onChange={event => { setWorkDir(event.target.value); setDirError(''); }} error={Boolean(dirError)}
            sx={{ '& .MuiInputLabel-root': { pointerEvents: 'none' } }} // a tap on the label over the outline reaches the field (a whole 44px target on a narrow phone)
            helperText={<span id="h5-new-task-dir-help">{dirError ? t(dirError) : target.local
              ? `${t('Leave empty to use the default:')} ${defaultPath || t('a folder named after the task under the tasks folder')}`
              : t('Absolute path on the remote engine. Leave empty to use a folder named after the task under that engine’s tasks folder.')}</span>}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { autoCapitalize: 'off', spellCheck: false, 'aria-label': t('Working directory') } }}
          />
          {failed ? <DialogError id="h5-new-task-error" sx={{ mt: 0 }}>{t('The task was not created.')}</DialogError> : null}
        </DialogContent>
        <DialogActions sx={phone ? { pb: 'max(8px, env(safe-area-inset-bottom))' } : null}>
          <Button id="h5-new-task-cancel" onClick={close} disabled={busy}>{t('Cancel')}</Button>
          <Button id="h5-new-task-create" type="submit" variant="contained" disabled={busy}>{t('Create')}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

// The list reads the tasks, the Archived section and, while a session row is being renamed, the menu (only then: another menu draws no row).
const PANEL = state => ({ taskList: state.taskList, archived: state.archived, rename: state.menu && state.menu.rename ? state.menu : null });
// The filters of the list: All, Running and Needs you (h5.js puts `running` / `pending`, counts of the task's terminals from the activity feeds, on each
// task row). A chip names how many sessions of the listed tasks are in that state, from the same rows.
const FILTERS = [['all', 'All', null], ['running', 'Running', 'running'], ['pending', 'Needs you', 'waiting']];
const countOf = (tasks, key) => (tasks || []).reduce((sum, task) => sum + (Number(task[key]) || 0), 0);
// MD2 choice chips: the chosen one is a primary tint with primary text, the others are outlined. 28px (32px on a touch screen, at least 44px wide, where
// the `::after` reaches 6px above and below, into the row's padding, so each is a 44px target; wrapped rows keep 12px between them for that).
const CHIP_SX = on => theme => ({
  height: 28, borderRadius: 14, typography: 'body2', fontSize: 13, position: 'relative',
  '& .MuiChip-label': { px: 1 }, '& .MuiChip-icon': { ml: 1, mr: -0.5 }, // tight enough for the three chips and the options button in one line of the 304px list
  ...(on ? { bgcolor: alpha(theme.palette.primary.main, 0.16), color: 'primary.main', borderColor: 'transparent', '&:hover, &.MuiChip-clickable:hover': { bgcolor: alpha(theme.palette.primary.main, 0.24) } } : {}),
  '&::after': { content: '""', position: 'absolute', inset: '-4px 0' },
  [TOUCH]: { height: 32, minWidth: 44, borderRadius: 16, '& .MuiChip-label': { px: 1 }, '& .MuiChip-icon': { ml: 1 }, '&::after': { inset: '-6px 0' } },
});
function Panel({ ui, wide }) {
  const state = useStore(ui, PANEL, shallowEqual);
  countRender('TaskPanel');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [options, setOptions] = useState(null); // the "List options" button while its menu is open
  const listRef = useRef(null);
  const floatRef = useRef(null);
  const liveRef = useRef(null);
  const searchRef = useRef(null);
  const drag = useListDrag(listRef, floatRef, liveRef, ui, TASK_DRAG);
  const sessionDrag = useListDrag(listRef, floatRef, liveRef, ui, SESSION_DRAG);
  const tasks = state.taskList && state.taskList.tasks;
  const option = run => () => { setOptions(null); run(); };
  return (
    <Box sx={theme => ({ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, ...DRAG_SX(theme) })}>
      {/* The top of the list: the title with New task at its right, the search field, then the filter chips with their counts. */}
      <Box className="h5-sheet-header" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 48, pl: 2, pr: 1, [TOUCH]: { minHeight: 56 } }}>
        <Typography id="h5-tasks-title" variant="h6" component="h2" sx={{ flex: '1 1 auto', minWidth: 0 }}>{t('Tasks')}</Typography>
        <Button id="h5-add-task" color="primary" size="medium" startIcon={<Icon name="add" size={18} />} aria-haspopup="dialog" onClick={() => ui.actions.openNewTask()} sx={{ flex: '0 0 auto', px: 1.25 }}>{t('New task')}</Button>
        {wide ? null : <IconButton id="h5-close-tasks" aria-label={t('Close')} title={t('Close')} onClick={() => ui.actions.closeTasks()}><Icon name="close" size={20} /></IconButton>}
      </Box>
      <Box className="h5-task-search" sx={{ px: 1.5, pt: 0.5, pb: 1 }}>
        <TextField
          size="small" fullWidth type="search" placeholder={t('Search sessions')} value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }}
          slotProps={{
            input: {
              inputRef: searchRef,
              startAdornment: <InputAdornment position="start" sx={{ color: 'text.secondary', mr: 0.5 }}><Icon name="search" size={16} /></InputAdornment>,
              endAdornment: query ? (
                <InputAdornment position="end">
                  <IconButton id="h5-task-search-clear" size="small" edge="end" aria-label={t('Clear search')} title={t('Clear search')} onClick={() => { setQuery(''); if (searchRef.current) searchRef.current.focus(); }} sx={{ p: 0.5 }}><Icon name="close" size={14} /></IconButton>
                </InputAdornment>
              ) : null,
              sx: {
                typography: 'body2', bgcolor: 'action.hover', '& input': { py: 1 }, '& input::-webkit-search-cancel-button': { display: 'none' },
                '&:not(.Mui-focused):not(:hover) .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
              },
            },
            htmlInput: { id: 'h5-task-search-input', 'aria-label': t('Search sessions') },
          }}
        />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 1.5, pr: 1, pb: 1, [TOUCH]: { gap: 0, pr: 0.5 } }}>
        <Box className="h5-task-filters" role="group" aria-label={t('Filter')} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, flex: '1 1 auto', minWidth: 0, [TOUCH]: { columnGap: 0.75, rowGap: 1.5 } }}>
          {FILTERS.map(([key, label, look]) => {
            const on = filter === key;
            const count = look ? countOf(tasks, key) : 0;
            return (
              <Chip
                key={key} component="button" clickable variant="outlined" data-filter={key} aria-pressed={on} onClick={() => setFilter(key)}
                icon={look ? <Box component="span" className="h5-filter-dot" sx={{ ...DOT_SX, bgcolor: STATE_DOT[look] }} /> : undefined}
                label={count ? `${t(label)} ${count}` : t(label)} sx={CHIP_SX(on)}
              />
            );
          })}
        </Box>
        {/* The less used list actions (open or close every task's sessions) wait behind one button at the end of the chips. */}
        <IconButton
          id="h5-task-list-more" size="small" aria-label={t('List options')} title={t('List options')} aria-haspopup="menu" aria-expanded={options ? 'true' : undefined}
          aria-controls={options ? 'h5-task-list-menu' : undefined} onClick={event => setOptions(event.currentTarget)} sx={{ p: 0.5 }}
        ><Icon name="taskMore" size={20} /></IconButton>
        <Menu
          id="h5-task-list-menu" anchorEl={options} open={Boolean(options)} onClose={() => setOptions(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <MenuItem id="h5-expand-all" onClick={option(() => ui.actions.expandAll())} sx={{ typography: 'body2', minHeight: 36 }}>{t('Expand all')}</MenuItem>
          <MenuItem id="h5-collapse-all" onClick={option(() => ui.actions.collapseAll())} sx={{ typography: 'body2', minHeight: 36 }}>{t('Collapse all')}</MenuItem>
        </Menu>
      </Box>
      {/* Basis 0: a long list (many open tasks) scrolls inside its own space instead of squeezing the rows below it (the settings row). */}
      <List id="h5-task-list" ref={listRef} className="h5-task-list" disablePadding sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', px: 0.5, pb: 0.5 }}>
        <Tasks taskList={state.taskList} rename={state.rename} ui={ui} query={query} filter={filter} drag={drag} sessionDrag={sessionDrag} />
        {/* Archived tasks are not searched: the entry goes away while a search or a filter is on. */}
        {query.trim() || filter !== 'all' ? null : <ArchivedTasks archived={state.archived} ui={ui} />}
      </List>
      {/* The floating copy of a dragged row goes in here (useListDrag), and a keyboard move or a session moved is announced in the live region. */}
      <Box ref={floatRef} className="h5-task-float-host" />
      <Box id="h5-task-order-live" ref={liveRef} aria-live="assertive" aria-atomic="true" sx={VISUALLY_HIDDEN} />
      {/* Below the list, in a narrow pane only: the other destinations of the page (DrawerNav). A phone has its bottom navigation, the wide layout the rail. */}
      {wide ? null : <DrawerNav ui={ui} />}
    </Box>
  );
}

// The other destinations of the page below the task list of a narrow pane of the multi-column view ("Phone drawer" in docs/design/page-navigation.md):
// a phone has them in its bottom navigation (BottomNav.jsx) and the wide layout in the navigation rail (Columns.jsx `NavRail`), but a pane has neither.
// Labelled MD2 list rows with an icon: Mind maps (the top page shows its Mind maps tab) and Settings (a pane has no T-Attention). Choosing one closes
// the drawer first, as an MD2 modal navigation drawer does.
const DRAWER_NAV = state => Boolean(state.pane);
const NAV_ROW_SX = { minHeight: 48, [TOUCH]: { minHeight: 48 }, px: 2, gap: 0, '& .MuiListItemIcon-root': { minWidth: 40, color: 'text.secondary' } };
function DrawerNav({ ui }) {
  const pane = useStore(ui, DRAWER_NAV);
  if (!pane) return null;
  const go = open => () => { ui.actions.closeTasks(); open(); };
  const text = { slotProps: { primary: { variant: 'subtitle2', noWrap: true } } };
  return (
    <>
      <Divider />
      <List component="nav" id="h5-tasks-nav" aria-label={t('Views')} disablePadding sx={{ py: 0.5, flex: '0 0 auto' }}>
        <ListItemButton id="h5-tasks-mindmap" onClick={go(() => ui.actions.openMindmaps())} sx={NAV_ROW_SX}>
          <ListItemIcon><Icon name="mindmap" size={24} /></ListItemIcon>
          <ListItemText primary={t('Mind maps')} {...text} />
        </ListItemButton>
        <ListItemButton id="h5-tasks-settings" aria-haspopup="dialog" onClick={go(() => ui.actions.openSettings())} sx={NAV_ROW_SX}>
          <ListItemIcon><Icon name="setting" size={24} /></ListItemIcon>
          <ListItemText primary={t('Settings')} {...text} />
        </ListItemButton>
      </List>
    </>
  );
}

// The drawer container. A phone: an MD2 modal navigation drawer from the left (min(320px, 100vw - 56px) wide, over a 32% scrim; the page under it
// stays where it is). A wide screen (a computer, a landscape tablet): a permanent sidebar of 304px right of the navigation rail.
const DRAWER_KEYS = ['wide', 'sidebarCollapsed', 'tasksOpen', 'pane', 'paneEngaged'];
const SURFACE = `linear-gradient(${alpha('#fff', Number(getOverlayAlpha(1)))}, ${alpha('#fff', Number(getOverlayAlpha(1)))})`; // MD2 dark surface at 1dp, as the rail and the header
export function TaskDrawer({ ui }) {
  const state = useStoreKeys(ui, DRAWER_KEYS);
  // The height follows the visual viewport (--h5-height, h5.js `fitViewport`), so the on-screen keyboard shortens the list instead of covering its end
  // (a name field in the list stays visible above the keyboard). The widths are the CSS variables of h5.css (--h5-sidebar-width, --h5-drawer-width).
  const height = 'var(--h5-height, 100%)';
  if (state.wide) {
    // Folded away with the header button (entry.jsx `toggleSidebar`): what is shown then fills the whole width.
    if (state.sidebarCollapsed) return null;
    const paper = { className: 'h5-sheet-panel', id: 'h5-tasks', sx: { width: 'var(--h5-sidebar-width)', maxWidth: '100%', height, backgroundImage: 'none', left: 'var(--h5-nav-width, 0px)' } };
    return (
      // The permanent drawer's own element has no size (its paper is fixed), so the sidebar is the paper.
      <Drawer variant="permanent" slotProps={{ paper }} sx={{ '& .MuiDrawer-paper': { position: 'fixed' } }}>
        <Panel ui={ui} wide={state.wide} />
      </Drawer>
    );
  }
  const paper = { className: 'h5-sheet-panel', sx: { width: 'var(--h5-drawer-width)', maxWidth: '100%', height, bgcolor: 'background.paper', backgroundImage: SURFACE, borderRadius: 0 } };
  return (
    <Drawer
      id="h5-tasks" open={state.tasksOpen} onClose={() => ui.actions.closeTasks()}
      slotProps={{ paper, backdrop: { id: 'h5-task-backdrop', sx: { bgcolor: 'rgba(0, 0, 0, 0.32)' } } }}
      // A pane of the multi-column view opens on this sheet; it must not pull the focus into its frame before the person used it (pane.mjs).
      ModalProps={{ 'aria-labelledby': 'h5-tasks-title', disableAutoFocus: Boolean(state.pane && !state.paneEngaged) }}
    >
      <Panel ui={ui} wide={state.wide} />
    </Drawer>
  );
}

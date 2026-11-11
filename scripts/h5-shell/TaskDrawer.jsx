import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import NativeSelect from '@mui/material/NativeSelect';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SearchIcon from '@mui/icons-material/Search';
import SettingsIcon from '@mui/icons-material/Settings';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import { DomIcon, Pill, api, deviceParts, deviceText, t, terminalMark } from './common.jsx';
import { shortName, tagColor } from './task-order.mjs';
import { TOUCH } from './theme.mjs';
import { Icon } from './Icons.jsx';
import { ArchivedTasks } from './ArchivedTasks.jsx';

const GLYPHS = { shell: '>_', claude: '✳', codex: 'GPT' };

// The sessions under a task are its terminals. Every session row has "⋯" actions, under the selected task or any other.
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };

// The second line of a session row: what it is, the folder of a terminal that kept its own directory after the task's working directory
// changed (the full path is the row's tooltip).
function subtitle(row) {
  const name = AGENT_NAMES[row.agent];
  // A Claude / Codex running in a terminal is a "Session".
  const kind = row.kind === 'terminal' ? (name ? `${name} ${t('Session')}` : t('Terminal')) : '';
  const folder = row.otherDir ? row.otherDir.replace(/\/+$/, '').split('/').pop() || row.otherDir : '';
  return [kind, folder].filter(Boolean).join(' \u00B7 ');
}

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
// them). They fill only the visible area (--h5-height follows the visual viewport, h5.js `fitViewport`), so with the on-screen keyboard up the dialog sits above
// it; on a phone the margins are smaller, and only the fields scroll while the title and the buttons stay. The focused field is kept in view when the keyboard
// opens or closes.
const CREATE_DIALOG_SX = {
  bottom: 'auto',
  height: 'var(--h5-height, 100%)',
  '& .MuiDialog-paper': { [TOUCH]: { m: 2, width: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)' } },
};
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
          <DialogTitle id="h5-new-session-title" sx={{ pb: 0.5 }}>{t('New session')}</DialogTitle>
          <DialogContent>
            <DialogContentText id="h5-new-session-task" variant="body2" translate="no" sx={{ overflowWrap: 'anywhere' }}>{view.taskTitle}</DialogContentText>
            {view.service ? <Typography id="h5-new-session-service" variant="caption" component="p" color="text.secondary" translate="no" sx={{ overflowWrap: 'anywhere' }}>{view.service}</Typography> : null}
            <TextField
              id="h5-new-name-input" key={view.task} name="name" size="small" fullWidth autoFocus defaultValue={view.name} placeholder={t('Name (optional)')} disabled={busy}
              onChange={event => ui.actions.menuName(event.target.value)} onKeyDown={fieldKey} sx={{ mt: 1.5 }}
              slotProps={{ input: { sx: { fontSize: 14 } }, htmlInput: {
                maxLength: 40, enterKeyHint: 'go', autoCapitalize: 'off', spellCheck: false, 'aria-label': t('Name (optional)'),
                ...(active >= 0 ? { role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'h5-term-menu-actions', 'aria-autocomplete': 'none', 'aria-activedescendant': optionId(active) } : {}),
              } }}
            />
            {view.sub ? <Typography id="h5-new-session-sub" variant="subtitle2" component="h3" color="text.secondary" sx={{ mt: 1.5 }}>{t(view.sub)}</Typography> : null}
            <Box id="h5-term-menu-actions" className="h5-menu-actions" role={active >= 0 ? 'listbox' : 'group'} aria-label={t(view.sub || 'New session')} sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: view.sub ? 1 : 1.5 }}>
              {view.items.map((item, index) => {
                const option = item.pick && active >= 0;
                const on = option && index === active;
                return (
                  <Button
                    key={`${index}:${item.label}`} variant={on ? 'contained' : 'outlined'} disableElevation fullWidth disabled={busy}
                    className={[item.kind === 'danger' ? 'danger' : '', on ? 'h5-choice-on' : ''].filter(Boolean).join(' ') || undefined}
                    onClick={() => ui.actions.menuRun(index)}
                    {...(option ? {
                      id: optionId(index), role: 'option', 'aria-selected': on ? 'true' : 'false', tabIndex: on ? 0 : -1,
                      onKeyDown: event => optionKey(event, index), onFocus: () => { if (!on) setAt(picks.indexOf(index)); },
                    } : {})}
                    sx={{
                      justifyContent: 'flex-start', textAlign: 'left', overflowWrap: 'anywhere', minHeight: 40,
                      // The focus ring stands outside the button, apart from the highlight (the filled button).
                      '&:focus-visible, &.Mui-focusVisible': { outline: '2px solid', outlineColor: 'text.primary', outlineOffset: '2px' },
                    }}
                  >
                    {item.kind === 'raw' ? item.label : t(item.label)}
                  </Button>
                );
              })}
            </Box>
            {active >= 0 ? <Typography id="h5-new-session-keys" variant="caption" component="p" color="text.secondary" sx={{ mt: 1, [TOUCH]: { display: 'none' } }}>{t('Enter to create · ↑↓ to choose')}</Typography> : null}
            {busy ? <Typography id="h5-new-session-busy" role="status" variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('Creating…')}</Typography> : null}
            {view.error ? <Typography id="h5-new-session-error" role="alert" variant="body2" color="error" sx={{ mt: 1, overflowWrap: 'anywhere' }}>{view.error}</Typography> : null}
          </DialogContent>
          <DialogActions>
            <Button id="h5-term-menu-cancel" className="h5-menu-cancel" color="inherit" disabled={busy} onClick={close}>{t('Cancel')}</Button>
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
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, [TOUCH]: { gap: 1 }, borderRadius: 2, borderLeft: 3, borderColor: row.current ? 'primary.main' : 'transparent' }}
    >
      <TextField
        id="h5-term-rename-input" name="title" size="small" fullWidth defaultValue={menu.renameValue} onKeyDown={escapeCancels(ui)} onBlur={() => ui.actions.menuCancel()}
        slotProps={{ input: { sx: { fontSize: 14 } }, htmlInput: { maxLength: 40, enterKeyHint: 'done', 'aria-label': t('Terminal name') } }}
      />
      <Button type="submit" variant="contained" size="small" onPointerDown={keep} onMouseDown={keep} sx={{ flex: '0 0 auto', minHeight: 40 }}>{t('Save')}</Button>
    </Box>
  );
}

// The sessions under a task: its terminals. Every session row has "⋯" actions, for the task the row is under.
function Sessions({ ui, taskId, sessions, menu }) {
  return (
    <List className="h5-terminal-list" role="group" aria-label={sessions.label} dense disablePadding sx={{ ml: 1.75, mb: 0.125, pl: 0.125, borderLeft: 1, borderColor: 'divider' }}>
      {sessions.note ? <Typography className="h5-peek-note" variant="body2" color="text.secondary" sx={{ px: 1, py: 0.75 }}>{t(sessions.note)}</Typography> : null}
      {sessions.rows.map(row => (
        <React.Fragment key={`${row.kind}:${row.id}`}>
        {row.more && menu && menu.rename && menu.rename.task === taskId && menu.rename.kind === row.kind && menu.rename.id === row.id ? <RenameRow menu={menu} ui={ui} row={row} /> : (
        <Box className="h5-terminal-row" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, [TOUCH]: { gap: 1 }, borderRadius: 2, borderLeft: 3, borderColor: row.current ? 'primary.main' : 'transparent', bgcolor: row.current ? 'action.selected' : undefined }}>
          <ListItemButton
            component="button" className="h5-terminal-main" aria-current={row.current ? 'true' : undefined}
            selected={row.current} onClick={() => ui.actions.openRow(taskId, row)}
            sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 40, py: 0.125, px: 0.75, borderRadius: 2, gap: 0.875, textAlign: 'left', fontSize: 14, '&.Mui-selected': { bgcolor: 'transparent' } }}
          >
            <Box component="span" className={`h5-terminal-icon ${row.agent || 'shell'}`} aria-hidden="true" sx={{ position: 'relative', flex: '0 0 28px', width: 28, height: 28, borderRadius: 1.5, bgcolor: 'action.hover', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontFamily: 'monospace', color: row.agent === 'claude' ? '#d97757' : 'text.secondary', '& svg': { width: 18, height: 18 } }}>
              {row.kind === 'terminal' && row.agent ? <DomIcon make={terminalMark(row.agent)} /> : GLYPHS.shell}
            </Box>
            <Box component="span" sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <Box component="span" className="h5-terminal-name" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</Box>
              {subtitle(row) ? <Box component="span" className="h5-terminal-sub" title={row.otherDir ? `${t('Directory')}: ${row.otherDir}` : undefined} sx={{ fontSize: 12, lineHeight: 1.3, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle(row)}</Box> : null}
            </Box>
          </ListItemButton>
          {row.more ? (
            <IconButton className="h5-terminal-more" size="small" sx={{ p: 0.5 }} aria-label={t('Terminal actions')} title={t('Terminal actions')} aria-haspopup="menu" onClick={event => ui.actions.rowMore(taskId, row, event.currentTarget)}>
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          ) : null}
        </Box>)}
        </React.Fragment>
      ))}
    </List>
  );
}

// The device tag in front of a task name (shown when more than one device is listed): the device's name cut to 8 characters (the full name, "Offline" and
// why its tasks cannot be moved are the `title`), in the colour its instance id gives it on every client (task-order.mjs). An offline device's tag is muted.
function DeviceTag({ device, unplaced }) {
  const parts = deviceParts(device);
  const { index, color, background } = tagColor(device.instanceId);
  const title = [deviceText(device), device.offline ? t('Offline') : '', unplaced ? t('Its tasks can be moved once this device is updated') : ''].filter(Boolean).join(' · ');
  return (
    <Box
      component="span" className="h5-device-tag" data-source={device.key} data-color={index} data-offline={device.offline ? 'true' : undefined} title={title} translate="no"
      sx={{
        flex: '0 0 auto', display: 'inline-block', boxSizing: 'border-box', maxWidth: 104, height: 20, px: 0.75, borderRadius: 10, border: 1,
        fontSize: 11, fontWeight: 600, lineHeight: '18px', letterSpacing: 0, textTransform: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        ...(device.offline
          ? { color: 'text.disabled', bgcolor: 'transparent', borderColor: 'divider', borderStyle: 'dashed' }
          : { color, bgcolor: background, borderColor: 'transparent' }),
      }}
    >
      {device.local && !device.name ? parts.name /* "This machine" of an older server: a short word, never cut */ : shortName(parts.name)}
    </Box>
  );
}

// Sorting the list (h5.js "Task order"). Only the grip at the left edge of a row that can be moved starts a drag, so a tap, a long press and a swipe on
// the rest of the row do what they did before sorting existed. With a mouse the drag starts after a move of 4px; a finger needs no long press (the grip
// has `touch-action: none`, so it never scrolls the list) and starts after 4px too; a plain tap or click on the grip does nothing. From the keyboard the
// grip is a button: Space or Enter picks the task up, Up and Down move it, Space or Enter drops it and Escape (or leaving the grip) puts it back; a live
// region says where it is.
// While dragging, a copy of the row floats under the pointer, its place in the list is an empty slot of the same height, and the other rows slide out of
// the way (transforms only: the rows are measured once when the drag starts, and nothing is laid out again per frame). Near the top or the bottom edge the
// list scrolls. The drop asks h5.js to move the task (`reorderTask`: before the task now after the slot, or after the last one), which saves the whole
// order; the copy settles into the slot. The rows are the ones shown, so with a search or a filter on, a task goes next to the tasks it was dropped between.
// Every other change of the order (a menu move, a newer order from the server, a save that failed and moved back) slides the rows to their new places
// too (FLIP, in `useTaskDrag`'s layout effect). `prefers-reduced-motion: reduce` makes every move instant.
const DRAG_MOVE_PX = 4;
const EDGE_PX = 40;
const MAX_SCROLL_PX = 14;
const SHIFT_MS = 180; // the rows sliding out of the way, and to their new places after an order change
const SETTLE_MS = 160; // the floating copy settling into the slot
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const slide = (node, y, ms) => {
  node.style.transition = ms ? `transform ${ms}ms ease-out` : 'none';
  node.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
};
const unslide = node => { node.style.transition = ''; node.style.transform = ''; };

function useTaskDrag(listRef, hostRef, liveRef, ui) {
  const live = useRef(null); // the drag in progress (pressed, picked up, or settling)
  // `rows`: ref -> { el, top } at the last commit; `dropped`: the places the rows were shown at when a drag ended (its slides are cleared at the commit
  // that moves them); `focus`: the grip to focus again after a drop from the keyboard (moving a row's element takes the focus away).
  const flip = useRef({ rows: new Map(), order: [], dropped: null });
  useEffect(() => () => { if (live.current) live.current.abort(); }, []);
  const say = text => { if (liveRef.current) liveRef.current.textContent = text; };

  useLayoutEffect(() => {
    const memo = flip.current;
    const list = listRef.current;
    if (!list) { memo.rows = new Map(); memo.order = []; return; }
    const els = [...list.querySelectorAll('.h5-task[data-ref]')];
    const now = new Map(els.map(el => [el.dataset.ref, { el, top: el.offsetTop }]));
    const order = els.map(el => el.dataset.ref);
    const before = memo.rows;
    const was = memo.order;
    const shownAt = new Map([...before].map(([ref, row]) => [ref, row.top]));
    const dropped = memo.dropped;
    const dragging = live.current && live.current.picked;
    if (dropped && !dragging) {
      memo.dropped = null;
      for (const node of dropped.nodes) unslide(node);
      for (const [ref, top] of dropped.at) shownAt.set(ref, top);
      if (dropped.focus) { const grip = gripOf(list, dropped.focus); if (grip && document.activeElement !== grip) grip.focus({ preventScroll: true }); }
    }
    memo.rows = now;
    memo.order = order;
    if (dragging || reducedMotion()) return;
    // Only a change of the order moves rows; rows that came or went (a search, a new task) and a row that opened do not.
    const common = order.filter(ref => before.has(ref) && before.get(ref).el === now.get(ref).el);
    const old = was.filter(ref => common.includes(ref));
    if (old.every((ref, index) => ref === common[index])) return;
    const moved = [];
    for (const ref of common) {
      const delta = shownAt.get(ref) - now.get(ref).top;
      if (Math.abs(delta) < 1) continue;
      slide(now.get(ref).el, delta, 0);
      moved.push(now.get(ref).el);
    }
    if (!moved.length) return;
    void list.offsetHeight; // one style flush for all of them, then they slide from where they were shown to where they are
    for (const node of moved) slide(node, 0, SHIFT_MS);
    setTimeout(() => { for (const node of moved) if (!node.style.transform) node.style.transition = ''; }, SHIFT_MS + 60);
  });

  const begin = (ref, grip, pointer) => {
    if (live.current) live.current.abort();
    const list = listRef.current;
    const host = hostRef.current;
    const row = grip.closest('.h5-task');
    if (!list || !host || !row) return;
    const keyboard = !pointer;
    const s = { ref, picked: false, frame: 0, rows: [], from: 0, index: 0, y: pointer ? pointer.y : 0, motion: !reducedMotion() };
    live.current = s;
    const rowsShown = () => s.rows.length;
    const place = (top, animate) => {
      s.float.style.transition = animate && s.motion ? `transform ${SETTLE_MS}ms ease-out` : 'none';
      s.float.style.transform = `translate3d(${s.left}px, ${top - s.originY}px, 0)`;
    };
    // The slot moves to `s.index` (the number of the other rows that come before it), the rows it passed slide by its height.
    const arrange = () => {
      const height = s.rows[s.from].height;
      let slot = 0;
      s.rows.forEach((item, j) => {
        if (j === s.from) return;
        let shift = 0;
        if (j < s.from && j >= s.index) { shift = height; slot -= item.height; }
        if (j > s.from && j <= s.index) { shift = -height; slot += item.height; }
        set(item, shift);
      });
      set(s.rows[s.from], slot);
    };
    function set(item, shift) {
      if (item.shift === shift) return;
      item.shift = shift;
      slide(item.el, shift, s.motion ? SHIFT_MS : 0);
    }
    const slotTop = () => { const slot = s.rows[s.from]; return s.box.top + slot.top + slot.shift - list.scrollTop; };
    // Pointer: the copy follows the pointer inside the list; the slot goes where the copy's top edge passed the middle of a row above it, or its bottom
    // edge the middle of a row below it (the places measured at the start, in the list's own coordinates, so scrolling does not change them).
    const aim = () => {
      const top = Math.min(Math.max(s.y - s.grab, s.box.top - s.headHeight / 2), s.box.bottom - s.headHeight / 2);
      place(top, false);
      const upper = top - s.box.top + list.scrollTop;
      const lower = upper + s.headHeight;
      let index = 0;
      s.rows.forEach((item, j) => {
        const middle = item.top + item.height / 2;
        if ((j < s.from && upper >= middle) || (j > s.from && lower > middle)) index += 1;
      });
      if (index !== s.index) { s.index = index; arrange(); }
    };
    // Near an edge of the list it scrolls, faster the closer the pointer is; the slot follows.
    const scroll = () => {
      s.frame = 0;
      if (!s.picked || keyboard) return;
      const top = s.y - s.box.top;
      const bottom = s.box.bottom - s.y;
      const step = top < EDGE_PX ? -Math.ceil(MAX_SCROLL_PX * (1 - Math.max(top, 0) / EDGE_PX)) : bottom < EDGE_PX ? Math.ceil(MAX_SCROLL_PX * (1 - Math.max(bottom, 0) / EDGE_PX)) : 0;
      if (!step) return;
      const was = list.scrollTop;
      list.scrollTop += step;
      if (list.scrollTop !== was) aim();
      s.frame = requestAnimationFrame(scroll);
    };
    const position = () => `${s.index + 1}`;
    const pick = () => {
      s.rows = [...list.querySelectorAll('.h5-task[data-movable="true"]')].map(el => ({ el, ref: el.dataset.ref, top: el.offsetTop, height: el.offsetHeight, shift: 0 }));
      s.from = s.index = s.rows.findIndex(item => item.el === row);
      if (s.from < 0) { stop(); live.current = null; return; }
      s.picked = true;
      s.box = list.getBoundingClientRect();
      const head = row.querySelector('.h5-task-head') || row;
      const box = head.getBoundingClientRect();
      s.headHeight = box.height;
      s.grab = keyboard ? 0 : s.y - box.top;
      // The floating copy: the row's own line (not its sessions), lifted. It is `position: fixed`; where its (0, 0) really is gets measured, so an
      // ancestor that makes a containing block (a transformed sheet) cannot move it off the pointer.
      const float = document.createElement('div');
      float.className = 'h5-task-float';
      float.setAttribute('aria-hidden', 'true');
      float.inert = true;
      const body = document.createElement('div');
      body.className = 'h5-task-float-body';
      const copy = head.cloneNode(true);
      for (const node of copy.querySelectorAll('.MuiTouchRipple-root')) node.remove(); // no ripple or focus ring frozen in the copy
      for (const node of copy.querySelectorAll('.Mui-focusVisible')) node.classList.remove('Mui-focusVisible');
      body.appendChild(copy);
      float.appendChild(body);
      float.style.width = `${box.width}px`;
      host.appendChild(float);
      const origin = float.getBoundingClientRect();
      s.left = box.left - origin.left;
      s.originY = origin.top;
      s.float = float;
      s.body = body;
      place(box.top, false);
      row.setAttribute('data-drag-slot', 'true');
      list.setAttribute('data-dragging', 'true');
      document.documentElement.setAttribute('data-task-drag', keyboard ? 'keyboard' : 'pointer');
      ui.actions.taskDragging(true);
      void body.offsetWidth;
      body.classList.add('h5-task-float-lifted');
      if (keyboard) say(t(`Picked up at position ${position()} of ${rowsShown()}. Press Up or Down to move, Space to drop, Escape to cancel.`));
    };
    const stop = () => {
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onMenu, true);
      grip.removeEventListener('blur', onBlur);
      list.removeEventListener('scroll', onScroll);
      list.removeAttribute('data-dragging');
      document.documentElement.removeAttribute('data-task-drag');
    };
    // The end of the settle: the copy goes, the row shows again in its place.
    const clear = () => {
      if (s.float) s.float.remove();
      row.removeAttribute('data-drag-slot');
      const memo = flip.current;
      if (memo.dropped && memo.dropped.owner === s) { // no commit moved the rows (nothing changed): their slides end here
        for (const node of memo.dropped.nodes) unslide(node);
        memo.dropped = null;
      }
      if (s.refocus) { const again = gripOf(list, ref); if (again && document.activeElement !== again) again.focus({ preventScroll: true }); }
      if (live.current === s) live.current = null;
    };
    // Drop (`save`) or put back. The copy settles into the slot; the order is saved at once, and the commit that moves the rows clears their slides,
    // starting from where they are shown, so nothing jumps.
    const end = save => {
      stop();
      if (!s.picked) { if (live.current === s) live.current = null; return; }
      if (!save && s.index !== s.from) { s.index = s.from; arrange(); }
      s.picked = false;
      s.refocus = keyboard && save;
      place(slotTop(), true);
      s.body.classList.remove('h5-task-float-lifted');
      const others = s.rows.filter((_, j) => j !== s.from);
      flip.current.dropped = {
        owner: s, nodes: s.rows.map(item => item.el), focus: s.refocus ? ref : null,
        at: new Map(s.rows.map(item => [item.ref, item.top + item.shift])),
      };
      if (save && s.index !== s.from) {
        const after = s.index >= others.length;
        const target = (after ? others[others.length - 1] : others[s.index]).ref;
        ui.actions.reorderTask(ref, target, after);
      } else ui.actions.taskDragging(false);
      setTimeout(clear, s.motion ? SETTLE_MS + 20 : 0);
    };
    // Keyboard: one row per press; the list scrolls to keep the slot in view, and the copy sits on the slot.
    const step = by => {
      const index = Math.min(Math.max(s.index + by, 0), s.rows.length - 1);
      if (index === s.index) { say(t(`Moved to position ${position()} of ${rowsShown()}`)); return; }
      s.index = index;
      arrange();
      const slot = s.rows[s.from];
      const top = slot.top + slot.shift;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + slot.height > list.scrollTop + list.clientHeight) list.scrollTop = top + slot.height - list.clientHeight;
      place(slotTop(), true);
      say(t(`Moved to position ${position()} of ${rowsShown()}`));
    };
    s.abort = () => { stop(); if (s.picked) { s.picked = false; for (const item of s.rows) unslide(item.el); ui.actions.taskDragging(false); } clear(); };
    // The click a mouse button sends after a drag lands on what is under it: it is swallowed once (it comes right after the pointerup).
    const swallowClick = () => {
      const eat = event => { event.preventDefault(); event.stopPropagation(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 400);
    };
    function onMove(event) {
      if (event.pointerId !== pointer.id) return;
      s.y = event.clientY;
      if (!s.picked) {
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= DRAG_MOVE_PX) return;
        pick();
        if (!s.picked) return;
      }
      aim();
      if (!s.frame) s.frame = requestAnimationFrame(scroll);
    }
    function onUp(event) {
      if (event.pointerId !== pointer.id) return;
      if (s.picked && pointer.mouse) swallowClick();
      end(true);
    }
    function onCancel(event) { if (event.pointerId === pointer.id) end(false); }
    function onKey(event) {
      if (event.key === 'Escape') {
        if (!s.picked) return;
        event.preventDefault();
        event.stopPropagation(); // the sheet stays open
        end(false);
        if (keyboard) say(t('Reorder cancelled'));
        return;
      }
      if (!keyboard) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); step(event.key === 'ArrowUp' ? -1 : 1); }
      else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        say(t(`Dropped at position ${position()} of ${rowsShown()}`));
        end(true);
      }
    }
    function onBlur() { if (live.current === s && s.picked) { end(false); say(t('Reorder cancelled')); } }
    function onScroll() { if (s.picked) place(slotTop(), true); } // the same target as the move that scrolled, so its slide goes on
    // A long press on the grip would open the context menu of a touch browser (Android Chrome).
    function onMenu(event) { event.preventDefault(); }
    window.addEventListener('keydown', onKey, true);
    if (keyboard) {
      grip.addEventListener('blur', onBlur);
      list.addEventListener('scroll', onScroll);
      pick();
      return;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    if (!pointer.mouse) window.addEventListener('contextmenu', onMenu, true);
  };
  // The props of the grip of a row that can be moved.
  const grip = task => ({
    onPointerDown: event => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault(); // no text selection, and a mouse does not move the focus to the grip
      begin(task.ref, event.currentTarget, { id: event.pointerId, x: event.clientX, y: event.clientY, mouse: event.pointerType === 'mouse' });
    },
    onKeyDown: event => {
      if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat || (live.current && live.current.picked)) return;
      event.preventDefault();
      event.stopPropagation();
      begin(task.ref, event.currentTarget, null);
    },
    onContextMenu: event => event.preventDefault(),
  });
  return { grip };
}
const gripOf = (list, ref) => [...list.querySelectorAll('.h5-task[data-movable="true"]')].find(el => el.dataset.ref === ref)?.querySelector('.h5-task-grip') || null;

// The grip: 20px wide on a computer, shown faintly and in full on the row's hover or its keyboard focus. On a touch screen it is always shown and its
// target is 44px: the row is 44px tall, and the hit area (`::after`) reaches into the list's padding on the left and over the row button's own padding
// on the right, so the row is no taller and the grip takes 34px of its width. Only the grip has `touch-action: none`: the list scrolls everywhere else.
const GRIP_SX = {
  flex: '0 0 auto', alignSelf: 'stretch', position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 20, mr: -0.5, p: 0, border: 0, borderRadius: 1, bgcolor: 'transparent', color: 'text.secondary', font: 'inherit', cursor: 'grab', opacity: 0.45,
  touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', WebkitTapHighlightColor: 'transparent',
  transition: 'opacity 120ms ease-out, color 120ms ease-out',
  '.h5-task-head:hover > &, &:focus-visible': { opacity: 1, color: 'text.primary' },
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
  '&::after': { content: '""', position: 'absolute', inset: '0 -2px 0 -4px' },
  [TOUCH]: { width: 34, mr: -1, opacity: 1, '&::after': { inset: '0 -6px 0 -4px' } },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
};
const GRIP_SPACE_SX = { flex: '0 0 auto', width: 20, mr: -0.5, [TOUCH]: { width: 34, mr: -1 } };
// The drag (useTaskDrag): the row's place is an empty slot (dashed, softly tinted), and the copy that floats under the pointer is lifted: a raised
// background, a soft shadow with a faint primary outline, 2% larger, the grip in the primary colour.
const DRAG_SX = theme => ({
  // Not `visibility: hidden`: that would take the focus from the grip of a task moved with the keyboard.
  '& .h5-task[data-drag-slot] > *': { opacity: 0, pointerEvents: 'none' },
  '& .h5-task[data-drag-slot]::before': {
    content: '""', position: 'absolute', inset: '3px 2px', borderRadius: '8px', pointerEvents: 'none',
    border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.55)}`, backgroundColor: alpha(theme.palette.primary.main, 0.08),
  },
  '& .h5-task-float': { position: 'fixed', left: 0, top: 0, zIndex: 5, pointerEvents: 'none', willChange: 'transform' },
  '& .h5-task-float-body': {
    borderRadius: '8px', backgroundColor: theme.palette.background.paper, backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1))',
    boxShadow: 'none', transformOrigin: '50% 50%', transition: `transform ${SETTLE_MS}ms ease-out, box-shadow ${SETTLE_MS}ms ease-out`,
  },
  '& .h5-task-float-lifted': { transform: 'scale(1.02)', boxShadow: `${theme.shadows[8]}, 0 0 0 1px ${alpha(theme.palette.primary.main, 0.35)}` },
  '& .h5-task-float .h5-task-grip': { opacity: 1, color: theme.palette.primary.main },
  '@media (prefers-reduced-motion: reduce)': { '& .h5-task-float-body': { transition: 'none' } },
});
const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

function Tasks({ state, ui, query, filter, drag }) {
  const { note, tasks } = state.taskList;
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
  // While the order can be changed, every row has a grip at its left edge; a row that cannot be moved (its device has no instance id yet) has an empty
  // space of the same width instead, so the chevrons stay in one column.
  const sortable = Boolean(state.taskList.sortable);
  return shown.map(task => {
    return (
      <Box
        key={task.ref} className="h5-task" data-ref={task.ref} data-source={task.source} data-movable={task.movable ? 'true' : undefined}
        sx={{ position: 'relative', borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}
      >
        <Box className={task.add ? 'h5-task-head h5-task-row' : 'h5-task-head'} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, borderRadius: 2, [TOUCH]: { gap: 1 } }}>
          {sortable && task.movable ? (
            <Box component="button" type="button" className="h5-task-grip" aria-label={t('Drag to reorder')} title={t('Drag to reorder')} aria-roledescription="sortable" {...drag.grip(task)} sx={GRIP_SX}>
              <Icon name="dragHandle" size={20} />
            </Box>
          ) : sortable ? <Box component="span" className="h5-task-grip-space" aria-hidden="true" sx={GRIP_SPACE_SX} /> : null}
          <ListItemButton
            component="button" className="h5-task-item" aria-current={task.selected ? 'true' : undefined} aria-expanded={task.expanded}
            onClick={() => ui.actions.toggleTask(task.ref)}
            sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 36, py: 0, px: 0.75, borderRadius: 2, textAlign: 'left', overflowWrap: 'anywhere', fontSize: 14, lineHeight: 1.25 }}
          >
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, width: '100%', minWidth: 0 }}>
              {task.expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
              {task.device ? <DeviceTag device={task.device} unplaced={task.unplaced} /> : null}
              <Box component="span" sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <Box component="span" className="h5-task-title" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>{task.title}</Box>
                {task.count != null ? <Box component="span" className="h5-task-count" sx={{ fontSize: 12, color: 'text.secondary' }}>{task.count} {t(task.count === 1 ? 'session' : 'sessions')}</Box> : null}
              </Box>
            </Box>
          </ListItemButton>
          {/* "⋯" (move, working directory, delete) left of the "+", which stays at the right end of the row */}
          {task.add ? <IconButton className="h5-task-more" size="small" sx={{ p: 0.5 }} aria-label={t('Task actions')} title={t('Task actions')} aria-haspopup="dialog" onClick={() => ui.actions.taskMore(task.ref)}><Icon name="taskMore" size={20} /></IconButton> : null}
          {task.add ? <IconButton className="h5-task-add" size="small" sx={{ p: 0.5 }} aria-label={t('New session')} title={t('New session') + NEW_SESSION_KEYS} aria-haspopup="dialog" onClick={() => ui.actions.addSession(task.ref)}><AddIcon /></IconButton> : null}
        </Box>
        {task.expanded && task.sessions ? <Sessions ui={ui} taskId={task.ref} sessions={task.sessions} menu={state.menu} /> : null}
      </Box>
    );
  });
}

// The folder name the server makes from a task title (titleToSlug in routes/tasks.js and services/engine-tasks.js), for the default path shown.
const slug = title => title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_.]/g, '').replace(/^-+|-+$/g, '') || 'task';

// The New task dialog, opened by "New task" at the end of the task list (h5.js `openNewTask`; `newTaskOpen` in the store). Every opening starts empty, on
// this machine. Create makes the task (h5.js `createTask`); the dialog closes once it is made and the new task is opened. While it is being made nothing can
// be pressed and the dialog does not close; a failure is a notice, and with a working directory the field says so too.
export function NewTaskDialog({ state, ui }) {
  const open = Boolean(state.newTaskOpen);
  const [title, setTitle] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [dirError, setDirError] = useState('');
  const [base, setBase] = useState(null); // the folder new tasks of this machine go under (the user's setting, TASKS_BASE_DIR, else ~/tasks)
  const [on, setOn] = useState('local'); // "Create on": the service a new task is made on; this machine unless chosen
  useFocusedInView(open);
  useEffect(() => { if (open) { setTitle(''); setWorkDir(''); setDirError(''); setOn('local'); } }, [open]);
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
    if (!(await ui.actions.createTask(value, dir, onKey)) && dir) setDirError('The task was not created. Check the working directory.');
  };
  const busy = state.creatingTask;
  const close = () => ui.actions.closeNewTask();
  return (
    <Dialog id="h5-new-task-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-new-task-title-label" sx={CREATE_DIALOG_SX}>
      <Box component="form" id="h5-new-task" className="h5-new-task" autoComplete="off" onSubmit={submit} sx={DIALOG_FORM_SX}>
        <DialogTitle id="h5-new-task-title-label">{t('New task')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {state.sources.length > 1 ? (
            <Box id="h5-new-task-on-row" component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.secondary', fontSize: 14 }}>
              <span style={{ whiteSpace: 'nowrap' }}>{t('Create on')}</span>
              <NativeSelect fullWidth value={onKey} inputProps={{ id: 'h5-new-task-on', 'aria-label': t('Create on') }} onChange={event => setOn(event.target.value)}>
                {targets.map(source => <option key={source.key} value={source.key}>{deviceText(source)}</option>)}
              </NativeSelect>
            </Box>
          ) : null}
          <TextField
            id="h5-new-task-title" autoFocus size="small" fullWidth placeholder={t('New task title')} value={title} onChange={event => setTitle(event.target.value)} sx={{ mt: 0.5 }}
            slotProps={{ htmlInput: { maxLength: 200, enterKeyHint: 'done', 'aria-label': t('New task title'), style: { paddingTop: 7, paddingBottom: 7 } } }}
          />
          <TextField
            id="h5-new-task-dir" size="small" fullWidth label={t('Working directory')} value={workDir} placeholder={defaultPath || t('Default folder')}
            onChange={event => { setWorkDir(event.target.value); setDirError(''); }} error={Boolean(dirError)}
            sx={{ '& .MuiInputLabel-root': { pointerEvents: 'none' } }} // a tap on the label over the outline reaches the field (a whole 44px target on a narrow phone)
            helperText={<span id="h5-new-task-dir-help">{dirError ? t(dirError) : target.local
              ? `${t('Leave empty to use the default:')} ${defaultPath || t('a folder named after the task under the tasks folder')}`
              : t('Absolute path on the remote engine. Leave empty to use a folder named after the task under that engine’s tasks folder.')}</span>}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { autoCapitalize: 'off', spellCheck: false, 'aria-label': t('Working directory'), style: { paddingTop: 7, paddingBottom: 7 } } }}
          />
        </DialogContent>
        <DialogActions>
          <Button id="h5-new-task-cancel" color="inherit" onClick={close} disabled={busy}>{t('Cancel')}</Button>
          <Button id="h5-new-task-create" type="submit" variant="contained" disabled={busy}>{t('Create')}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function Panel({ state, ui }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const listRef = useRef(null);
  const floatRef = useRef(null);
  const liveRef = useRef(null);
  const drag = useTaskDrag(listRef, floatRef, liveRef, ui);
  return (
    <Box sx={theme => ({ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, ...DRAG_SX(theme) })}>
      <Box className="h5-sheet-header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.25, borderBottom: 1, borderColor: 'divider' }}>
        <Typography id="h5-tasks-title" variant="h6" component="h2">{t('Tasks')}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', [TOUCH]: { gap: 1 } }}>
          <IconButton id="h5-expand-all" size="small" aria-label={t('Expand all')} title={t('Expand all')} onClick={() => ui.actions.expandAll()}><UnfoldMoreIcon /></IconButton>
          <IconButton id="h5-collapse-all" size="small" aria-label={t('Collapse all')} title={t('Collapse all')} onClick={() => ui.actions.collapseAll()}><UnfoldLessIcon /></IconButton>
          {state.wide ? null : <IconButton id="h5-close-tasks" aria-label={t('Close')} onClick={() => ui.actions.closeTasks()}><CloseIcon /></IconButton>}
        </Box>
      </Box>
      <Box className="h5-task-search" sx={{ px: 1.5, pb: 0.25, pt: 0.75, [TOUCH]: { pb: 0 } }}>
        <TextField
          size="small" fullWidth type="search" placeholder={t('Search sessions')} value={query} onChange={event => setQuery(event.target.value)}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>, sx: { borderRadius: 3, fontSize: 14, '& input': { py: 0.75 } } }, htmlInput: { id: 'h5-task-search-input', 'aria-label': t('Search sessions') } }}
        />
        {/* The filters look small (32px on a touch screen) but each is a 44px target: its `::after` reaches 6px above and below, into the row's padding. */}
        <Box className="h5-task-filters" sx={{ display: 'flex', gap: 0.75, pt: 0.75, [TOUCH]: { gap: 1, py: 0.75 } }}>
          {[['all', 'All'], ['running', 'Running'], ['pending', 'Pending']].map(([key, label]) => (
            <Pill
              key={key} label={t(label)} tone={filter === key ? 'primary' : 'default'} filled={filter === key} aria-pressed={filter === key} onClick={() => setFilter(key)}
              sx={{ [TOUCH]: { height: 32, minWidth: 44, px: 1.5, fontSize: 14, borderRadius: 16, position: 'relative', '&::after': { content: '""', position: 'absolute', inset: '-7px 0' } } }}
            />
          ))}
        </Box>
      </Box>
      {/* Basis 0: a long list (many open tasks) scrolls inside its own space instead of squeezing the rows below it (the settings row). */}
      <List id="h5-task-list" ref={listRef} className="h5-task-list" disablePadding sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', px: 0.5, pb: 0.5 }}>
        <Tasks state={state} ui={ui} query={query} filter={filter} drag={drag} />
        {/* Archived tasks are not searched: the entry goes away while a search or a filter is on. */}
        {query.trim() || filter !== 'all' ? null : <ArchivedTasks archived={state.archived} ui={ui} />}
      </List>
      {/* The floating copy of a dragged row goes in here (useTaskDrag), and a keyboard move is announced in the live region. */}
      <Box ref={floatRef} className="h5-task-float-host" />
      <Box id="h5-task-order-live" ref={liveRef} aria-live="assertive" aria-atomic="true" sx={VISUALLY_HIDDEN} />
      <Box sx={{ px: 1.5, pb: 0.75, [TOUCH]: { pt: 0.5, pb: 1 } }}>
        <Button id="h5-add-task" fullWidth variant="contained" size="medium" startIcon={<AddIcon />} aria-haspopup="dialog" onClick={() => ui.actions.openNewTask()} sx={{ borderRadius: 3, py: 0.5, textTransform: 'none', fontSize: 14 }}>{t('New task')}</Button>
      </Box>
      <Divider />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minHeight: 36 }}>
        <IconButton id="h5-tasks-mindmap" aria-label={t('Mind maps')} title={t('Mind maps')} onClick={() => ui.actions.openMindmaps()} size="small" sx={{ mr: 0.5, [TOUCH]: { ml: 1 } }}><Icon name="mindmap" size={20} /></IconButton>
        <IconButton id="h5-tasks-settings" aria-label={t('Settings')} title={t('Settings')} onClick={() => ui.actions.openSettings()} size="small" sx={{ mr: 1, [TOUCH]: { ml: 1 } }}><SettingsIcon fontSize="small" /></IconButton>
      </Box>
    </Box>
  );
}

// A phone: the list slides over the page. A wide screen (a computer, a landscape tablet): it stays beside it.
export function TaskDrawer({ state, ui }) {
  // The height follows the visual viewport (--h5-height, h5.js `fitViewport`), so the on-screen keyboard shortens the list instead of covering its end
  // (a name field in the list stays visible above the keyboard).
  const paperProps = { className: 'h5-sheet-panel', sx: { width: state.wide ? 320 : 'min(82vw, 360px)', maxWidth: '100%', height: 'var(--h5-height, 100%)', backgroundImage: 'none' } };
  if (state.wide) {
    // Folded away with the header button (entry.jsx `toggleSidebar`): what is shown then fills the whole width.
    if (state.sidebarCollapsed) return null;
    return (
      // The permanent drawer's own element has no size (its paper is fixed), so the sidebar is the paper.
      <Drawer variant="permanent" slotProps={{ paper: { ...paperProps, id: 'h5-tasks' } }} sx={{ '& .MuiDrawer-paper': { position: 'fixed' } }}>
        <Panel state={state} ui={ui} />
      </Drawer>
    );
  }
  return (
    <Drawer
      id="h5-tasks" open={state.tasksOpen} onClose={() => ui.actions.closeTasks()}
      slotProps={{ paper: paperProps, backdrop: { id: 'h5-task-backdrop' } }}
      // A pane of the multi-column view opens on this sheet; it must not pull the focus into its frame before the person used it (pane.mjs).
      ModalProps={{ 'aria-labelledby': 'h5-tasks-title', disableAutoFocus: Boolean(state.pane && !state.paneEngaged) }}
    >
      <Panel state={state} ui={ui} />
    </Drawer>
  );
}

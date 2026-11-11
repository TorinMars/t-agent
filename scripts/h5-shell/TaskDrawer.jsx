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
import NativeSelect from '@mui/material/NativeSelect';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SearchIcon from '@mui/icons-material/Search';
import SettingsIcon from '@mui/icons-material/Settings';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import { DeviceName, DomIcon, Pill, api, deviceText, t, terminalMark } from './common.jsx';
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

// The small header row of a service in the list: its name (this machine's with a "This machine" hint), and "Offline" when it is. An offline service shows just this, no error text.
function SourceHeader({ section, first }) {
  return (
    <Box component="h3" className="h5-source-header" data-source={section.key} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, m: 0, px: 0.75, pt: first ? 0.5 : 1, pb: 0.25, fontSize: 12, lineHeight: 1.3, fontWeight: 600, color: 'text.secondary', borderTop: first ? 0 : 1, borderColor: 'divider' }}>
      <DeviceName source={section} className="h5-source-name" hintClassName="h5-source-hint" />
      {section.offline ? <Box component="span" className="h5-source-offline" sx={{ flex: '0 0 auto', color: 'warning.main' }}>{t('Offline')}</Box> : null}
    </Box>
  );
}

function Tasks({ state, ui, query, filter }) {
  const { note, sections } = state.taskList;
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
  const shown = (sections || []).map(section => ({
    ...section,
    groups: section.groups.map(group => ({ ...group, tasks: group.tasks.filter(keep) })).filter(group => group.tasks.length),
  })).filter(section => !filtering || section.groups.length); // while searching, a service without a match goes altogether
  if (filtering && !shown.length) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('No matching sessions')}</Typography>;
  // Each service is one section, this machine first; its groups inside it, the way a list of one service has them. Reordering is per group: there is no way to drag a task to another service.
  return shown.map((section, index) => (
    <Box key={section.key} component="section" className="h5-source" data-source={section.key}>
      {section.header ? <SourceHeader section={section} first={index === 0} /> : null}
      {section.groups.map(group => (
    <Box key={group.key} component="section">
      {group.tasks.map(task => (
        <Box key={task.ref} sx={{ borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
          <Box className={task.add ? 'h5-task-row' : undefined} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, borderRadius: 2, [TOUCH]: { gap: 1 } }}>
            <ListItemButton
              component="button" className="h5-task-item" aria-current={task.selected ? 'true' : undefined} aria-expanded={task.expanded}
              onClick={() => ui.actions.toggleTask(task.ref)}
              sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 36, py: 0, px: 0.75, borderRadius: 2, textAlign: 'left', overflowWrap: 'anywhere', fontSize: 14, lineHeight: 1.25 }}
            >
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, width: '100%' }}>
                {task.expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
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
      ))}
    </Box>
      ))}
    </Box>
  ));
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
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
      <List id="h5-task-list" className="h5-task-list" disablePadding sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', px: 0.5, pb: 0.5 }}>
        <Tasks state={state} ui={ui} query={query} filter={filter} />
        {/* Archived tasks are not searched: the entry goes away while a search or a filter is on. */}
        {query.trim() || filter !== 'all' ? null : <ArchivedTasks archived={state.archived} ui={ui} />}
      </List>
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

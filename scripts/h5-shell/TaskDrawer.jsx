import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { DomIcon, Pill, api, t, terminalMark } from './common.jsx';
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

// The "Session" list of the "+" of a task, drawn right under that task's row and indented like its session rows (instead of a sheet at the bottom of
// the screen, far from the "+"): the optional name field, then the choices (New Terminal, Claude session, ...; their sub-lists replace them here).
// Enter in the field runs the first choice. The field takes the focus on a computer; on a touch screen it does not, so no keyboard covers the choices.
function NewSession({ menu, ui, pointer }) {
  const ref = useRef(null);
  useInView(ref);
  return (
    <Box ref={ref} id="h5-new-session" className="h5-new-session" role="group" aria-labelledby="h5-new-session-title" sx={{ ml: 1.75, mb: 0.5, pl: 0.125, borderLeft: 1, borderColor: 'divider' }}>
      <Box sx={{ ml: '3px' }}>
        <Typography id="h5-new-session-title" variant="caption" component="h3" color="text.secondary" sx={{ display: 'block', px: 0.75, pt: 0.25, overflowWrap: 'anywhere' }}>{menu.title}</Typography>
        <Box component="form" id="h5-new-name" className="h5-menu-name" autoComplete="off" sx={{ py: 0.5 }} onSubmit={event => { event.preventDefault(); ui.actions.menuNameSubmit(); }}>
          <TextField
            id="h5-new-name-input" name="name" size="small" fullWidth autoFocus={pointer} defaultValue={menu.name} placeholder={t('Name (optional)')}
            onChange={event => ui.actions.menuName(event.target.value)} onKeyDown={escapeCancels(ui)}
            slotProps={{ input: { sx: { fontSize: 14 } }, htmlInput: { maxLength: 40, enterKeyHint: 'go', autoCapitalize: 'off', spellCheck: false, 'aria-label': t('Name (optional)') } }}
          />
        </Box>
        <List id="h5-term-menu-actions" className="h5-menu-actions" dense disablePadding>
          {menu.items.map((item, index) => (
            <ListItemButton key={`${index}:${item.label}`} component="button" className={item.kind === 'danger' ? 'danger' : undefined} onClick={() => ui.actions.menuRun(index)}
              sx={{ width: '100%', minHeight: 36, py: 0.25, px: 0.75, borderRadius: 2, fontSize: 14, textAlign: 'left', overflowWrap: 'anywhere', color: item.kind === 'danger' ? 'error.main' : undefined }}>
              {item.kind === 'raw' ? item.label : t(item.label)}
            </ListItemButton>
          ))}
        </List>
        <Button id="h5-term-menu-cancel" className="h5-menu-cancel" size="small" onClick={() => ui.actions.menuCancel()} sx={{ ml: 0.25, mb: 0.25 }}>{t('Cancel')}</Button>
      </Box>
    </Box>
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

// The small header row of a service in the list: its name, and "Offline" when it is. An offline service shows just this, no error text.
function SourceHeader({ section, first }) {
  return (
    <Box component="h3" className="h5-source-header" data-source={section.key} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, m: 0, px: 0.75, pt: first ? 0.5 : 1, pb: 0.25, fontSize: 12, lineHeight: 1.3, fontWeight: 600, color: 'text.secondary', borderTop: first ? 0 : 1, borderColor: 'divider' }}>
      <Box component="span" className="h5-source-name" translate="no" sx={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{section.local ? t(section.label) : section.label}</Box>
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
    if (!filtering || (state.menu && state.menu.naming && state.menu.task === task.ref)) return true; // the task whose Session list is open stays, whatever the filter
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
            {task.add ? <IconButton className="h5-task-add" size="small" sx={{ p: 0.5 }} aria-label={t('Session')} title={t('Session')} onClick={() => ui.actions.addSession(task.ref)}><AddIcon /></IconButton> : null}
          </Box>
          {state.menu && state.menu.naming && state.menu.task === task.ref ? <NewSession menu={state.menu} ui={ui} pointer={state.input === 'pointer'} /> : null}
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

function Panel({ state, ui }) {
  const [title, setTitle] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [dirError, setDirError] = useState('');
  const [base, setBase] = useState(null); // the folder new tasks of this machine go under (the user's setting, TASKS_BASE_DIR, else ~/tasks)
  const [adding, setAdding] = useState(false);
  const [on, setOn] = useState('local'); // "Create on": the service a new task is made on; this machine unless chosen
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  // The services a task can be made on: online and in the list. A choice that went offline or was hidden meanwhile falls back to this machine, or the first that is left.
  const targets = state.sources.filter(source => !source.offline && !source.hidden);
  const picked = targets.find(source => source.key === on) || targets.find(source => source.key === 'local') || targets[0];
  const onKey = picked ? picked.key : 'local';
  const target = ui.actions.newTaskTarget ? ui.actions.newTaskTarget(onKey) : { local: true };
  useEffect(() => {
    if (!adding || !target.local) return;
    let live = true;
    api('GET', '/auth/me').then(user => { if (live) setBase((user && user.effective_work_dir) || null); }).catch(() => {});
    return () => { live = false; };
  }, [adding, target.local]);
  // An empty field keeps the default rule: the path shown is only a hint and is never sent.
  const defaultPath = target.local && base ? `${base.replace(/\/+$/, '')}/${slug(title.trim() || 'task')}` : '';
  const submit = async event => {
    event.preventDefault();
    const value = title.trim();
    const dir = workDir.trim();
    if (!value || state.creatingTask) return;
    if (dir && ui.actions.isAbsolutePath && !ui.actions.isAbsolutePath(dir)) { setDirError('Enter an absolute path'); return; }
    setDirError('');
    if (await ui.actions.createTask(value, dir, onKey)) { setTitle(''); setWorkDir(''); setAdding(false); }
    else if (dir) setDirError('The task was not created. Check the working directory.');
  };
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
      {/* Basis 0: a long list (an open Session list) scrolls inside its own space instead of squeezing the rows below it (the settings row). */}
      <List id="h5-task-list" className="h5-task-list" disablePadding sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', px: 0.5, pb: 0.5 }}>
        <Tasks state={state} ui={ui} query={query} filter={filter} />
        {/* Archived tasks are not searched: the entry goes away while a search or a filter is on. */}
        {query.trim() || filter !== 'all' ? null : <ArchivedTasks archived={state.archived} ui={ui} />}
      </List>
      {adding ? (
        <Box component="form" id="h5-new-task" className="h5-new-task" autoComplete="off" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 1, px: 2, pb: 1 }}>
          {state.sources.length > 1 ? (
            <Box id="h5-new-task-on-row" component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.secondary', fontSize: 14 }}>
              <span style={{ whiteSpace: 'nowrap' }}>{t('Create on')}</span>
              <NativeSelect fullWidth value={onKey} inputProps={{ id: 'h5-new-task-on', 'aria-label': t('Create on') }} onChange={event => setOn(event.target.value)}>
                {targets.map(source => <option key={source.key} value={source.key}>{source.key === 'local' ? t(source.label) : source.label}</option>)}
              </NativeSelect>
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              id="h5-new-task-title" autoFocus size="small" fullWidth placeholder={t('New task title')} value={title} onChange={event => setTitle(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 200, enterKeyHint: 'done', 'aria-label': t('New task title'), style: { paddingTop: 7, paddingBottom: 7 } } }}
            />
            <Button type="submit" variant="contained" disabled={state.creatingTask} sx={{ flex: '0 0 auto', height: 36 }}>{t('Create')}</Button>
          </Box>
          <TextField
            id="h5-new-task-dir" size="small" fullWidth label={t('Working directory')} value={workDir} placeholder={defaultPath || t('Default folder')}
            onChange={event => { setWorkDir(event.target.value); setDirError(''); }} error={Boolean(dirError)}
            helperText={<span id="h5-new-task-dir-help">{dirError ? t(dirError) : target.local
              ? `${t('Leave empty to use the default:')} ${defaultPath || t('a folder named after the task under the tasks folder')}`
              : t('Absolute path on the remote engine. Leave empty to use a folder named after the task under that engine’s tasks folder.')}</span>}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { autoCapitalize: 'off', spellCheck: false, 'aria-label': t('Working directory'), style: { paddingTop: 7, paddingBottom: 7 } } }}
          />
        </Box>) : null}
      <Box sx={{ px: 1.5, pb: 0.75, [TOUCH]: { pt: 0.5, pb: 1 } }}>
        <Button id="h5-add-task" fullWidth variant="contained" size="medium" startIcon={<AddIcon />} onClick={() => setAdding(open => !open)} sx={{ borderRadius: 3, py: 0.5, textTransform: 'none', fontSize: 14 }}>{t('New task')}</Button>
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
      ModalProps={{ 'aria-labelledby': 'h5-tasks-title' }}
    >
      <Panel state={state} ui={ui} />
    </Drawer>
  );
}

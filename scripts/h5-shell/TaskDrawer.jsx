import React, { useEffect, useState } from 'react';
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
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import { DomIcon, Pill, api, chatMark, t, terminalMark } from './common.jsx';
import { TOUCH } from './theme.mjs';
import { Icon } from './Icons.jsx';

const GLYPHS = { shell: '>_', claude: '✳', codex: 'GPT' };

// The sessions under a task: its terminals, then its chats. The selected task's rows have "⋯" actions; those of another task only open.
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };

// The second line of a session row: what it is, then its state or when it last changed.
function subtitle(row) {
  const name = AGENT_NAMES[row.agent];
  // A chat is an "Agent"; a Claude / Codex running in a terminal is a "Session".
  const kind = row.kind === 'chat' ? `${name || ''} ${t('Agent')}`.trim() : row.kind === 'terminal' ? (name ? `${name} ${t('Session')}` : t('Terminal')) : '';
  const state = row.running ? t('Running') : row.pending ? t('Pending') : ago(row.updated);
  return [kind, state].filter(Boolean).join(' \u00B7 ');
}

// "12 min ago" from a 'YYYY-MM-DD HH:MM:SS' time (UTC, as the server writes it); empty when it is not known.
function ago(value) {
  if (!value) return '';
  const time = Date.parse(`${String(value).replace(' ', 'T')}Z`);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return `${minutes} ${t('min ago')}`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} ${t('h ago')}`;
  return `${Math.round(minutes / 1440)} ${t('d ago')}`;
}

// The sessions under a task: its terminals, then its chats. The selected task's rows have "⋯" actions; those of another task only open.
function Sessions({ ui, taskId, sessions }) {
  return (
    <List className="h5-terminal-list" role="group" aria-label={sessions.label} dense disablePadding sx={{ ml: 1.75, mb: 0.125, pl: 0.125, borderLeft: 1, borderColor: 'divider' }}>
      {sessions.note ? <Typography className="h5-peek-note" variant="body2" color="text.secondary" sx={{ px: 1, py: 0.75 }}>{t(sessions.note)}</Typography> : null}
      {sessions.rows.map(row => (
        <React.Fragment key={`${row.kind}:${row.id}`}>
        <Box className="h5-terminal-row" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, [TOUCH]: { gap: 1 }, borderRadius: 2, borderLeft: 3, borderColor: row.current ? 'primary.main' : 'transparent', bgcolor: row.current ? 'action.selected' : undefined }}>
          <ListItemButton
            component="button" className="h5-terminal-main" aria-current={row.current ? 'true' : undefined}
            selected={row.current} onClick={() => ui.actions.openRow(taskId, row)}
            sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 40, py: 0.125, px: 0.75, borderRadius: 2, gap: 0.875, textAlign: 'left', fontSize: 14, '&.Mui-selected': { bgcolor: 'transparent' } }}
          >
            <Box component="span" className={`h5-terminal-icon ${row.agent || 'shell'}`} aria-hidden="true" sx={{ position: 'relative', flex: '0 0 28px', width: 28, height: 28, borderRadius: 1.5, bgcolor: 'action.hover', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontFamily: 'monospace', color: row.agent === 'claude' ? '#d97757' : 'text.secondary', '& svg': { width: 18, height: 18 } }}>
              {row.kind === 'chat' ? <DomIcon make={terminalMark(row.agent)} />
                : row.kind === 'terminal' && row.agent ? <DomIcon make={terminalMark(row.agent)} />
                  : GLYPHS.shell}
              {row.kind === 'chat' ? <Box component="span" className="h5-robot" sx={{ position: 'absolute', right: -4, bottom: -4, width: 16, height: 16, borderRadius: '50%', bgcolor: 'background.paper', border: 1, borderColor: 'divider', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'text.primary', '& svg': { width: 11, height: 11 } }}><SmartToyOutlinedIcon /></Box> : null}
            </Box>
            <Box component="span" sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <Box component="span" className="h5-terminal-name" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</Box>
              {subtitle(row) ? <Box component="span" className="h5-terminal-sub" sx={{ fontSize: 12, lineHeight: 1.3, color: row.running ? 'success.main' : 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle(row)}</Box> : null}
            </Box>
            {row.kind === 'chat' ? <Pill className="h5-agent-badge" label={t('AGENT')} sx={{ ml: 'auto', flex: '0 0 auto', height: 20, px: 0.75, fontSize: 10, letterSpacing: 0.5 }} /> : null}
          </ListItemButton>
          {row.more ? (
            <IconButton className="h5-terminal-more" size="small" sx={{ p: 0.5 }} aria-label={t(row.kind === 'chat' ? 'Chat actions' : 'Terminal actions')} onClick={() => ui.actions.rowMore(row)}>
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          ) : null}
        </Box>
        {row.children && row.children.length ? (
          <List className="h5-subagent-list" role="group" aria-label={t('Agents')} dense disablePadding sx={{ ml: 3.5, pl: 0.125, borderLeft: 1, borderColor: 'divider' }}>
            {row.children.map(sub => (
              <ListItemButton key={sub.id} component="button" className="h5-subagent-row" data-view={sub.id} aria-current={sub.current ? 'true' : undefined} selected={sub.current} onClick={() => ui.actions.openRow(taskId, sub)} title={sub.title}
                sx={{ minHeight: 32, py: 0.125, px: 0.75, borderRadius: 2, gap: 0.875, textAlign: 'left', fontSize: 13, width: '100%', borderLeft: 3, borderColor: sub.current ? 'primary.main' : 'transparent', '&.Mui-selected': { bgcolor: 'action.selected' } }}>
                <Box component="span" className={`h5-subagent-dot ${sub.status}`} aria-hidden="true" sx={{ flex: '0 0 8px', width: 8, height: 8, borderRadius: '50%', bgcolor: sub.status === 'running' ? 'success.main' : sub.status === 'error' ? 'error.main' : 'text.disabled' }} />
                <Box component="span" translate="no" sx={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.title}</Box>
                <Box component="span" sx={{ flex: '0 0 auto', fontSize: 11, color: 'text.secondary' }}>{t(sub.status === 'running' ? 'Running' : sub.status === 'error' ? 'Failed' : 'Done')}</Box>
              </ListItemButton>
            ))}
          </List>
        ) : null}
        </React.Fragment>
      ))}
    </List>
  );
}

function Tasks({ state, ui, query, filter }) {
  const { note, groups } = state.taskList;
  if (note) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t(note)}</Typography>;
  const needle = query.trim().toLowerCase();
  const filtering = Boolean(needle) || filter !== 'all';
  // A search or the Running filter keeps the tasks whose name matches, or that have a matching session in a list that is open.
  const shown = groups.map(group => ({
    ...group,
    tasks: group.tasks.filter(task => {
      if (!filtering) return true;
      const rows = (task.sessions && task.sessions.rows) || [];
      const nameHit = !needle || task.title.toLowerCase().includes(needle);
      const rowHit = rows.some(row => (!needle || row.title.toLowerCase().includes(needle)) && (filter === 'all' || row[filter]));
      return filter !== 'all' ? rowHit : nameHit || rowHit;
    }),
  })).filter(group => group.tasks.length);
  if (filtering && !shown.length) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('No matching sessions')}</Typography>;
  return shown.map(group => (
    <Box key={group.key} component="section">
      {group.tasks.map(task => (
        <Box key={task.id} sx={{ borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
          <Box className={task.add ? 'h5-task-row' : undefined} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, borderRadius: 2, [TOUCH]: { gap: 1 } }}>
            <ListItemButton
              component="button" className="h5-task-item" aria-current={task.selected ? 'true' : undefined} aria-expanded={task.expanded}
              onClick={() => ui.actions.toggleTask(task.id)}
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
            {task.add ? <IconButton className="h5-task-more" size="small" sx={{ p: 0.5 }} aria-label={t('Task actions')} title={t('Task actions')} aria-haspopup="dialog" onClick={() => ui.actions.taskMore(task.id)}><Icon name="taskMore" size={20} /></IconButton> : null}
            {task.add ? <IconButton className="h5-task-add" size="small" sx={{ p: 0.5 }} aria-label={t('Session')} title={t('Session')} onClick={() => ui.actions.addSession(task.id)}><AddIcon /></IconButton> : null}
          </Box>
          {task.expanded && task.sessions ? <Sessions ui={ui} taskId={task.id} sessions={task.sessions} /> : null}
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
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const target = ui.actions.newTaskTarget ? ui.actions.newTaskTarget() : { local: true };
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
    if (await ui.actions.createTask(value, dir)) { setTitle(''); setWorkDir(''); setAdding(false); }
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
      {state.sources.length > 1 ? (
        <Box id="h5-engine-row" component="label" className="h5-engine" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, pt: 1, color: 'text.secondary' }}>
          <span>{t('Engine')}</span>
          <NativeSelect fullWidth value={state.sourceKey} inputProps={{ id: 'h5-engine', 'aria-label': t('Engine') }} onChange={event => ui.actions.changeEngine(event.target.value)}>
            {state.sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
          </NativeSelect>
        </Box>
      ) : null}
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
      <List id="h5-task-list" className="h5-task-list" disablePadding sx={{ flex: '1 1 auto', overflowY: 'auto', px: 0.5, pb: 0.5 }}>
        <Tasks state={state} ui={ui} query={query} filter={filter} />
      </List>
      {adding ? (
        <Box component="form" id="h5-new-task" className="h5-new-task" autoComplete="off" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 1, px: 2, pb: 1 }}>
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
        <IconButton id="h5-tasks-settings" aria-label={t('Settings')} title={t('Settings')} onClick={() => ui.actions.openSettings()} size="small" sx={{ mr: 1, [TOUCH]: { ml: 1 } }}><SettingsIcon fontSize="small" /></IconButton>
      </Box>
    </Box>
  );
}

// A phone: the list slides over the page. A wide screen (a computer, a landscape tablet): it stays beside it.
export function TaskDrawer({ state, ui }) {
  const paperProps = { className: 'h5-sheet-panel', sx: { width: state.wide ? 320 : 'min(82vw, 360px)', maxWidth: '100%', backgroundImage: 'none' } };
  if (state.wide) {
    // Folded away with the header button (entry.jsx `toggleSidebar`): the terminal or chat then fills the whole width.
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

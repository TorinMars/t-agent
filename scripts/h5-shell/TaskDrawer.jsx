import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListSubheader from '@mui/material/ListSubheader';
import NativeSelect from '@mui/material/NativeSelect';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { DomIcon, chatMark, t, terminalMark } from './common.jsx';

const GLYPHS = { shell: '>_', claude: '✳', codex: 'GPT' };

// The sessions under a task: its terminals, then its chats. The selected task's rows have "⋯" actions; those of another task only open.
function Sessions({ ui, taskId, sessions }) {
  return (
    <List className="h5-terminal-list" role="group" aria-label={sessions.label} dense disablePadding sx={{ ml: 2, mb: 1, pl: 1, borderLeft: 2, borderColor: 'divider' }}>
      {sessions.note ? <Typography className="h5-peek-note" variant="body2" color="text.secondary" sx={{ px: 1, py: 1 }}>{t(sessions.note)}</Typography> : null}
      {sessions.rows.map(row => (
        <Box key={`${row.kind}:${row.id}`} className="h5-terminal-row" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <ListItemButton
            component="button" className="h5-terminal-main" aria-current={row.current ? 'true' : undefined}
            selected={row.current} onClick={() => ui.actions.openRow(taskId, row)}
            sx={{ flex: '1 1 auto', minWidth: 0, borderRadius: 1, gap: 1, textAlign: 'left' }}
          >
            <Box component="span" className={`h5-terminal-icon ${row.agent || 'shell'}`} aria-hidden="true" sx={{ flex: '0 0 22px', display: 'inline-flex', justifyContent: 'center', fontSize: 13, fontFamily: 'monospace', color: row.agent === 'claude' ? '#d97757' : 'text.secondary', '& svg': { width: 16, height: 16 } }}>
              {row.kind === 'chat' ? <DomIcon make={chatMark(row.agent)} />
                : row.kind === 'terminal' && row.agent ? <DomIcon make={terminalMark(row.agent)} />
                  : GLYPHS.shell}
            </Box>
            <Box component="span" className="h5-terminal-name" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</Box>
          </ListItemButton>
          {row.more ? (
            <IconButton className="h5-terminal-more" size="small" aria-label={t(row.kind === 'chat' ? 'Chat actions' : 'Terminal actions')} onClick={() => ui.actions.rowMore(row)}>
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          ) : null}
        </Box>
      ))}
    </List>
  );
}

function Tasks({ state, ui }) {
  const { note, groups } = state.taskList;
  if (note) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t(note)}</Typography>;
  return groups.map(group => (
    <Box key={group.key} component="section">
      <ListSubheader component="h3" className="h5-group-title" disableSticky sx={{ bgcolor: 'transparent', lineHeight: '32px', mt: 1 }}>{group.name}</ListSubheader>
      {group.tasks.map(task => (
        <Box key={task.id}>
          <Box className={task.add ? 'h5-task-row' : undefined} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ListItemButton
              component="button" className="h5-task-item" selected={task.selected} aria-current={task.selected ? 'true' : undefined} aria-expanded={task.expanded}
              onClick={() => ui.actions.toggleTask(task.id)}
              sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 48, borderRadius: 1, textAlign: 'left', overflowWrap: 'anywhere' }}
            >
              {task.title}
            </ListItemButton>
            {task.add ? <IconButton className="h5-task-add" aria-label={t('Session')} onClick={() => ui.actions.openSessionMenu()}><AddIcon /></IconButton> : null}
          </Box>
          {task.expanded && task.sessions ? <Sessions ui={ui} taskId={task.id} sessions={task.sessions} /> : null}
        </Box>
      ))}
    </Box>
  ));
}

function Panel({ state, ui }) {
  const [title, setTitle] = useState('');
  const submit = async event => {
    event.preventDefault();
    const value = title.trim();
    if (!value || state.creatingTask) return;
    if (await ui.actions.createTask(value)) setTitle('');
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box className="h5-sheet-header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Typography id="h5-tasks-title" variant="h6" component="h2">{t('Tasks')}</Typography>
        {state.wide ? null : <IconButton id="h5-close-tasks" aria-label={t('Close')} onClick={() => ui.actions.closeTasks()}><CloseIcon /></IconButton>}
      </Box>
      {state.sources.length > 1 ? (
        <Box id="h5-engine-row" component="label" className="h5-engine" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, pt: 1.5, color: 'text.secondary' }}>
          <span>{t('Engine')}</span>
          <NativeSelect fullWidth value={state.sourceKey} inputProps={{ id: 'h5-engine', 'aria-label': t('Engine') }} onChange={event => ui.actions.changeEngine(event.target.value)}>
            {state.sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
          </NativeSelect>
        </Box>
      ) : null}
      <Box component="form" id="h5-new-task" className="h5-new-task" autoComplete="off" onSubmit={submit} sx={{ display: 'flex', gap: 1, px: 2, py: 1.5 }}>
        <TextField
          id="h5-new-task-title" size="small" fullWidth placeholder={t('New task title')} value={title} onChange={event => setTitle(event.target.value)}
          slotProps={{ htmlInput: { maxLength: 200, enterKeyHint: 'done', 'aria-label': t('New task title') } }}
        />
        <Button type="submit" variant="contained" disabled={state.creatingTask} sx={{ flex: '0 0 auto' }}>{t('Create')}</Button>
      </Box>
      <List id="h5-task-list" className="h5-task-list" disablePadding sx={{ flex: '1 1 auto', overflowY: 'auto', px: 1.5, pb: 1.5 }}>
        <Tasks state={state} ui={ui} />
      </List>
      <Divider />
      <Button className="h5-desktop-link" component="a" href="/web" fullWidth sx={{ py: 1.5, borderRadius: 0 }}>{t('Desktop version')}</Button>
    </Box>
  );
}

// A phone: the list slides over the page. A wide screen (a computer, a landscape tablet): it stays beside it.
export function TaskDrawer({ state, ui }) {
  const paperProps = { className: 'h5-sheet-panel', sx: { width: state.wide ? 320 : 'min(78vw, 360px)', maxWidth: '100%', backgroundImage: 'none' } };
  if (state.wide) {
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

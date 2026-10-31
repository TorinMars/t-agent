import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import MenuIcon from '@mui/icons-material/Menu';
import RefreshIcon from '@mui/icons-material/Refresh';
import SettingsIcon from '@mui/icons-material/Settings';
import { t } from './common.jsx';

export function Header({ state, ui }) {
  return (
    <AppBar position="static" color="default" enableColorOnDark elevation={0} className="h5-header" sx={{ flex: '0 0 auto', borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar variant="dense" disableGutters sx={{ px: 1, gap: 1, minHeight: 52 }}>
        <ButtonBase
          id="h5-open-tasks" className="h5-task-button" aria-expanded={state.tasksOpen} aria-haspopup="dialog" aria-controls="h5-tasks"
          onClick={() => ui.actions.openTasks()}
          sx={{ flex: '1 1 auto', minWidth: 0, justifyContent: 'flex-start', gap: 1, px: 1, py: 0.5, borderRadius: 1, textAlign: 'left', pointerEvents: state.wide ? 'none' : 'auto' }}
        >
          {state.wide ? null : <MenuIcon fontSize="small" aria-hidden="true" />}
          <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
            <Typography id="h5-task-name" className="h5-task-name" variant="subtitle1" component="div" noWrap sx={{ fontWeight: 600, lineHeight: 1.3 }}>{state.taskName || t('Choose a task')}</Typography>
            <Typography id="h5-session-name" className="h5-session-name" variant="caption" component="div" color="text.secondary" noWrap translate="no" sx={{ lineHeight: 1.3 }}>{state.sessionName || ' '}</Typography>
          </Box>
        </ButtonBase>
        {/* agent-activity.js fills this in (the counts, and when it is shown); React draws it once and leaves it alone. */}
        <span className="agent-activity" id="agent-activity" role="status" hidden title="Messages sent to agents that have not finished (running or queued), and agent turns running now">
          <span className="agent-activity-submitted"><b className="count">0</b> <span className="label" translate="no">submitted</span></span>
          <span className="agent-activity-running"><b className="count">0</b> <span className="label" translate="no">running</span></span>
        </span>
        <IconButton id="h5-refresh" aria-label={t('Refresh the page')} title={t('Refresh the page')} onClick={() => ui.actions.refresh()}>
          <RefreshIcon />
        </IconButton>
        <IconButton id="h5-open-settings" aria-haspopup="dialog" aria-controls="h5-settings" aria-label={t('Settings')} onClick={() => ui.actions.openSettings()}>
          <SettingsIcon />
        </IconButton>
      </Toolbar>
    </AppBar>
  );
}

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { api, errorText, t } from './common.jsx';
import { watchRestart } from './restart-wait.mjs';

// "Restart T-Agent" on the "This machine" row of Settings → Engines (Engines.jsx). `restart` is the `restart` field of `GET /api/system/version`
// ({ supported, reason }): without it (an older server) there is no button; with `supported: false` the button is disabled and says why. A confirmation,
// then `POST /api/system/restart { confirm: true }` (202 { accepted, boot_id }), then `/api/system/version` every second until another `boot_id` answers,
// and the page reloads (restart-wait.mjs, the same rule as the manual update in Update.jsx; "Refresh now" after 20 s). A pane of the multi-column view
// does not draw it: the top page owns updates and restarts.

const ERRORS = {
  UPDATE_ADMIN_REQUIRED: 'Only the update administrator can restart T-Agent',
  NO_PROCESS_MANAGER: 'Needs a process manager such as PM2',
  UPDATE_IN_PROGRESS: 'An update is running. Try again when it has finished.',
};
const UNSUPPORTED = { NO_PROCESS_MANAGER: 'Needs a process manager such as PM2' };
const restartError = error => (ERRORS[error && error.message] ? t(ERRORS[error.message]) : `${t('Restart failed')}: ${errorText(error) || t('Unknown')}`);

// The `restart` field of a version answer, or null when the server does not have it.
export const restartInfo = version => (version && version.restart && typeof version.restart.supported === 'boolean' ? version.restart : null);

export function RestartButton({ restart, bootId }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ phase: 'confirm' }); // confirm | sending | restarting | back | error
  const [slow, setSlow] = useState(false);
  const stop = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (stop.current) stop.current(); }, []);
  if (!restart) return null;
  const supported = restart.supported === true;
  const locked = view.phase === 'sending' || view.phase === 'restarting' || view.phase === 'back';
  const close = () => { if (!locked) setOpen(false); };
  const show = () => { setView({ phase: 'confirm' }); setSlow(false); setOpen(true); };
  const send = async () => {
    setView({ phase: 'sending' });
    setSlow(false);
    let answer;
    try { answer = await api('POST', '/api/system/restart', { confirm: true }); }
    catch (error) { if (alive.current) setView({ phase: 'error', message: restartError(error) }); return; }
    if (!alive.current) return;
    setView({ phase: 'restarting' });
    stop.current = watchRestart({
      bootId: (answer && answer.boot_id) || bootId || null,
      read: () => api('GET', '/api/system/version'),
      onSlow: () => { if (alive.current) setSlow(true); },
      onBack: () => { if (!alive.current) return; setView({ phase: 'back' }); location.reload(); },
    });
  };
  const why = supported ? null : UNSUPPORTED[restart.reason] || 'Needs a process manager such as PM2';
  return (
    <>
      <Button size="small" variant="outlined" id="h5-restart" className="h5-engine-restart" disabled={!supported} aria-haspopup="dialog" onClick={show}>{t('Restart T-Agent')}</Button>
      {why ? <Typography id="h5-restart-why" variant="caption" color="text.secondary" sx={{ flexBasis: '100%' }}>{t(why)}</Typography> : null}
      <Dialog id="h5-restart-dialog" open={open} onClose={locked ? undefined : close} fullWidth maxWidth="xs" aria-labelledby="h5-restart-title" aria-describedby="h5-restart-body">
        <DialogTitle id="h5-restart-title">{t('Restart T-Agent')}</DialogTitle>
        <DialogContent id="h5-restart-body" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {view.phase === 'confirm' || view.phase === 'error' ? (
            <Typography id="h5-restart-question">{t('Restart T-Agent on this computer? Every terminal is closed and its screen is cleared. The page reloads when the service is back.')}</Typography>
          ) : null}
          {view.phase === 'sending' || view.phase === 'restarting' || view.phase === 'back' ? (
            <Box id="h5-restart-state" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <CircularProgress size={20} />
              <span>{t(view.phase === 'back' ? 'T-Agent is back, reloading…' : 'Restarting…')}</span>
            </Box>
          ) : null}
          {view.phase === 'restarting' && slow ? (
            <Typography id="h5-restart-slow" variant="body2">
              {t('The page refreshes automatically once the service is back; if it takes too long, refresh manually: ')}
              <Button size="small" id="h5-restart-refresh" onClick={() => location.reload()}>{t('Refresh now')}</Button>
            </Typography>
          ) : null}
          {view.phase === 'error' ? <Typography id="h5-restart-error" role="alert" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{view.message}</Typography> : null}
        </DialogContent>
        <DialogActions>
          <Button id="h5-restart-cancel" color="inherit" disabled={locked} onClick={close}>{t(view.phase === 'error' ? 'Close' : 'Cancel')}</Button>
          {view.phase === 'confirm' || view.phase === 'error' ? <Button id="h5-restart-confirm" variant="contained" color="warning" onClick={() => void send()}>{t('Restart')}</Button> : null}
        </DialogActions>
      </Dialog>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { api, t } from './common.jsx';

// The header "Update" button (right of the refresh button) and its modal. The modal reuses the /api/system update endpoints of the desktop page:
// opening it checks for a new version (nothing is installed by the check); "Update now" starts the update and follows it while the service restarts.
export function UpdateButton() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ phase: 'checking' }); // checking | current | available | updating | error
  const [log, setLog] = useState('');
  const timer = useRef(null);
  const alive = useRef(true);
  const logNode = useRef(null);
  useEffect(() => () => { alive.current = false; clearInterval(timer.current); }, []);
  useEffect(() => { const node = logNode.current; if (node) node.scrollTop = node.scrollHeight; }, [log]);

  const errorText = status => `${status.error || status.message || 'Update failed'}${status.error_details ? `: ${status.error_details}` : ''}`;
  const lines = status => (Array.isArray(status.log) ? status.log.map(line => line.text).join('\n') : '');

  const monitor = (bootId = null) => {
    clearInterval(timer.current);
    let restartingAt = null;
    let down = false;
    timer.current = setInterval(async () => {
      let status;
      try { status = await api('GET', '/api/system/update-status'); } catch { down = true; return; }
      if (!alive.current) return;
      const restarted = down || (restartingAt && Date.now() - restartingAt > 4000) || (bootId && status.boot_id && status.boot_id !== bootId);
      setLog(lines(status));
      if (status.status === 'blocked' || status.status === 'failed') {
        clearInterval(timer.current);
        setView({ phase: 'error', message: errorText(status) });
      } else if (status.stage === 'completed' || (status.status !== 'updating' && restarted)) {
        clearInterval(timer.current);
        setView({ phase: 'updating', message: 'Update complete, reloading…' });
        setTimeout(() => location.reload(), 1500);
      } else {
        if (status.stage === 'restarting' && !restartingAt) restartingAt = Date.now();
        setView(previous => ({ ...previous, phase: 'updating', message: status.stage === 'restarting' ? 'Restarting the PC service, this page reloads when it is back…' : (status.message || 'Updating…') }));
      }
    }, 1000);
  };

  const check = async () => {
    setView({ phase: 'checking' });
    setLog('');
    try {
      const status = await api('POST', '/api/system/check-update', {});
      if (!alive.current) return;
      const versions = { local: status.local_version || '?', remote: status.remote_version || '?', admin: Boolean(status.is_update_admin), notes: (status.remote_manifest && status.remote_manifest.release_url) || '' };
      if (status.status === 'updating') { setView({ phase: 'updating', ...versions, message: status.message || 'Updating…' }); monitor(); }
      else if (status.error || status.status === 'failed' || status.status === 'blocked') setView({ phase: 'error', ...versions, message: errorText(status) });
      else if (status.status === 'available') setView({ phase: 'available', ...versions });
      else setView({ phase: 'current', ...versions });
    } catch (error) {
      if (alive.current) setView({ phase: 'error', message: error.message || 'Update failed' });
    }
  };

  const start = async () => {
    setView(previous => ({ ...previous, phase: 'updating', message: 'Updating…' }));
    try {
      let bootId = null;
      try { bootId = (await api('GET', '/api/system/version')).boot_id || null; } catch { /* the monitor falls back to the restart grace period */ }
      await api('POST', '/api/system/apply-update', { confirm: true });
      monitor(bootId);
    } catch (error) { setView(previous => ({ ...previous, phase: 'error', message: error.message || 'Update not run' })); }
  };

  const busy = view.phase === 'checking' || view.phase === 'updating';
  // While the update runs the modal cannot be closed by accident (the service is about to restart).
  const close = () => { if (view.phase !== 'updating') { setOpen(false); clearInterval(timer.current); } };
  const show = () => { setOpen(true); void check(); };

  return (
    <>
      <IconButton id="h5-update" aria-label={t('Update')} title={t('Update')} aria-haspopup="dialog" onClick={show}>
        <SystemUpdateAltIcon />
      </IconButton>
      <Dialog id="h5-update-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-update-title" aria-describedby="h5-update-body">
        <DialogTitle id="h5-update-title" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('Update')}
          <IconButton id="h5-update-close" aria-label={t('Close')} edge="end" disabled={view.phase === 'updating'} onClick={close}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent id="h5-update-body" dividers>
          {view.phase === 'checking' ? (
            <Box id="h5-update-state" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}><CircularProgress size={20} /><span>{t('Checking for the latest version…')}</span></Box>
          ) : null}
          {view.local ? (
            <Box component="dl" id="h5-update-versions" sx={{ m: 0, mb: 1.5, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.5 }}>
              <dt>{t('Current version')}</dt><dd style={{ margin: 0 }} id="h5-update-current">{view.local}</dd>
              <dt>{t('Latest version')}</dt><dd style={{ margin: 0 }} id="h5-update-latest">{view.remote}</dd>
            </Box>
          ) : null}
          {view.notes && /^https?:\/\//.test(view.notes) ? <Typography variant="body2" sx={{ mb: 1 }}><a id="h5-update-notes" href={view.notes} target="_blank" rel="noopener noreferrer">{t('Release notes')}</a></Typography> : null}
          {view.phase === 'current' ? <Typography id="h5-update-state" role="status">{t('Already up to date')}</Typography> : null}
          {view.phase === 'available' ? <Typography id="h5-update-state" role="status">{view.admin ? t('A new version is available.') : t('Only the update administrator can run updates')}</Typography> : null}
          {view.phase === 'updating' ? <Typography id="h5-update-state" role="status">{t(view.message || 'Updating…')}</Typography> : null}
          {view.phase === 'error' ? <Typography id="h5-update-state" role="alert" color="error">{t(view.message)}</Typography> : null}
          {log ? <Paper id="h5-update-log" component="pre" variant="outlined" ref={logNode} aria-label={t('Update log')} aria-live="off" sx={{ m: 0, mt: 1.5, p: 1, maxHeight: '30vh', overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log}</Paper> : null}
        </DialogContent>
        <DialogActions>
          {view.phase === 'error' ? <Button id="h5-update-retry" onClick={() => void check()}>{t('Check again')}</Button> : null}
          {view.phase === 'available' && view.admin ? <Button id="h5-update-now" variant="contained" disabled={busy} onClick={() => void start()}>{t('Update now')}</Button> : null}
          <Button id="h5-update-dismiss" color="inherit" disabled={view.phase === 'updating'} onClick={close}>{t('Close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

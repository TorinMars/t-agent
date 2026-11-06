import { useEffect, useRef, useState } from 'react';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { api, t } from './common.jsx';

// The texts of the updater (the same as the old desktop page's, so the Chinese dictionary keeps its translations).
const STATUS = {
  idle: 'Not checked yet', checking: 'Checking', current: 'Up to date', available: 'Update available',
  local_newer: 'Local version is newer', blocked: 'Update blocked', updating: 'Updating', failed: 'Check failed',
  restart_pending: 'Service restart needed',
};
const statusLabel = status => STATUS[status] || status || 'Unknown';
export const RESTART_HELP = [
  ['PM2', 'pm2 restart t-agent'],
  ['macOS login service', 'launchctl kickstart -k gui/$(id -u)/com.tagent.client'],
  ['Linux systemd', 'sudo systemctl restart t-agent'],
];
export function errorLabel(code) {
  return ({
    VERSION_REQUEST_TIMEOUT: 'GitHub request timed out', VERSION_RESPONSE_TOO_LARGE: 'Version file exceeds the size limit',
    INVALID_APP_VERSION: 'Remote version is not valid SemVer', INVALID_MANIFEST: 'Remote version file is malformed',
    UNTRUSTED_VERSION_URL: 'Version link is not trusted', VERSION_URL_NOT_CONFIGURED: 'No GitHub version link configured',
    WORKTREE_DIRTY: 'Local uncommitted changes', BRANCH_DIVERGED: 'Local branch has diverged',
    TRACKED_RUNTIME_FILES: 'Config or data files are tracked by Git; forced update stopped to protect data',
    VERSION_SOURCE_MISMATCH: 'GitHub version does not match the Git branch', UPDATE_ADMIN_REQUIRED: 'Only the update administrator can run updates',
    INVALID_UPDATE_REPOSITORY: 'Update repository is misconfigured', INVALID_UPDATE_REF: 'Update branch is misconfigured',
    INVALID_UPDATE_ARCHIVE: 'Downloaded update package has an invalid structure', UNSAFE_UPDATE_ARCHIVE: 'Update package contains unsafe files',
    ARCHIVE_CURL_FAILED: 'Update package download failed', ARCHIVE_TAR_FAILED: 'Update package extraction failed',
    NPM_INSTALLING_FAILED: 'Dependency install failed. Check the Node/npm environment',
    NPM_BUILDING_FAILED: 'Frontend build failed',
    NODE_PTY_LOAD_FAILED: 'Terminal native module install failed',
  })[code] || code || '';
}
const installLabel = type => ({ archive: 'Package update', git: 'Git fast-forward update' })[type] || 'Unknown';
// There is a new version, or the code is already updated but the service still runs the old code (a restart is needed): the red dot.
export const needsAttention = status => Boolean(status) && (status.status === 'available' || status.status === 'restart_pending');
function formatTime(value) {
  if (!value) return t('Not checked yet');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
const errorText = status => `${t(errorLabel(status.error)) || t(status.message || 'Update failed')}${status.error_details ? `: ${status.error_details}` : ''}`;
const lines = status => (Array.isArray(status.log) ? status.log.map(line => line.text).join('\n') : '');
const POLL_MS = 60_000; // how often the red dot reads the update state
const RESTART_GRACE_MS = 4000;

const Detail = ({ label, id, children }) => (
  <>
    <dt>{t(label)}</dt>
    <dd style={{ margin: 0, overflowWrap: 'anywhere' }} id={id}>{children}</dd>
  </>
);

// The header "Update" button (right of the refresh button) and its modal. It uses the /api/system update endpoints: opening it
// checks for a new version (nothing is installed by the check); "Update now" starts the update and follows it while the service
// restarts. A forced update is offered only after an update was blocked by local uncommitted changes (WORKTREE_DIRTY). A red dot on the button says that an update is available or that the service must be restarted.
export function UpdateButton() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false); // the dialog is drawn only once it was opened the first time (it then stays, for its closing animation)
  const [view, setView] = useState({ phase: 'checking' }); // checking | current | available | restart | updating | error
  const [status, setStatus] = useState(null); // the last state read, for the dot and the details
  const [force, setForce] = useState(false);
  const [log, setLog] = useState('');
  const [slow, setSlow] = useState(false); // the restart takes long: offer to reload by hand
  const timer = useRef(null);
  const alive = useRef(true);
  const logNode = useRef(null);
  useEffect(() => () => { alive.current = false; clearInterval(timer.current); }, []);
  useEffect(() => { const node = logNode.current; if (node) node.scrollTop = node.scrollHeight; }, [log]);

  // The red dot: read the state now and every minute; a state that was never checked (or whose last check failed) is checked once.
  useEffect(() => {
    let stop = false;
    const read = async () => {
      try { const next = await api('GET', '/api/system/update-status'); if (!stop) setStatus(next); return next; } catch { return null; }
    };
    (async () => {
      const first = await read();
      if (stop || !first || !['idle', 'failed', 'blocked'].includes(first.status)) return;
      try { const next = await api('POST', '/api/system/check-update', {}); if (!stop) setStatus(next); } catch { /* the dot stays as it was */ }
    })();
    const poll = setInterval(() => void read(), POLL_MS);
    return () => { stop = true; clearInterval(poll); };
  }, []);

  const monitor = (bootId = null) => {
    clearInterval(timer.current);
    let restartingAt = null;
    let down = false;
    timer.current = setInterval(async () => {
      let next;
      try { next = await api('GET', '/api/system/update-status'); } catch { down = true; return; }
      if (!alive.current) return;
      const restarted = down || (restartingAt && Date.now() - restartingAt > RESTART_GRACE_MS) || (bootId && next.boot_id && next.boot_id !== bootId);
      setLog(lines(next));
      if (next.status === 'blocked' || next.status === 'failed') {
        clearInterval(timer.current);
        setStatus(next);
        setView(previous => ({ ...previous, phase: 'error', message: errorText(next), dirty: next.error === 'WORKTREE_DIRTY' }));
      } else if (next.stage === 'completed' || (next.status !== 'updating' && restarted)) {
        clearInterval(timer.current);
        setView(previous => ({ ...previous, phase: 'updating', message: 'Update complete, reloading…' }));
        setTimeout(() => location.reload(), 1500);
      } else {
        if (next.stage === 'restarting' && !restartingAt) { restartingAt = Date.now(); setTimeout(() => { if (alive.current) setSlow(true); }, 20000); }
        setView(previous => ({ ...previous, phase: 'updating', message: next.stage === 'restarting' ? 'Restarting the PC service, this page reloads when it is back…' : (next.message || 'Updating…') }));
      }
    }, 1000);
  };

  const check = async () => {
    setView({ phase: 'checking' });
    setLog('');
    setSlow(false);
    let next;
    try {
      next = await api('POST', '/api/system/check-update', {});
    } catch (error) {
      if (!alive.current) return;
      // A failed check answers 502 with { error, status }: show the state it left, with the error.
      const left = error.data && error.data.status;
      if (left) setStatus(left);
      setView({ phase: 'error', message: t(errorLabel(error.message)) || error.message || 'Update failed', status: left || null });
      return;
    }
    if (!alive.current) return;
    setStatus(next);
    setForce(false);
    if (next.status === 'updating') { setView({ phase: 'updating', status: next, message: next.message || 'Updating…' }); monitor(); }
    else if (next.status === 'restart_pending') setView({ phase: 'restart', status: next });
    else if (next.error || next.status === 'failed' || next.status === 'blocked') setView({ phase: 'error', status: next, message: errorText(next), dirty: next.error === 'WORKTREE_DIRTY' });
    else if (next.status === 'available') {
      setView({ phase: 'available', status: next });
      // A new version is announced once (notice_version, kept by the server); seeing it here counts as announced.
      if (next.remote_version && next.remote_version !== next.notice_version) api('POST', '/api/system/update-notified', { version: next.remote_version }).catch(() => {});
    } else setView({ phase: 'current', status: next });
  };

  const start = async () => {
    const forced = force && view.forceOffered && view.status && view.status.install_type !== 'archive';
    setView(previous => ({ ...previous, phase: 'updating', message: 'Updating…' }));
    try {
      let bootId = null;
      try { bootId = (await api('GET', '/api/system/version')).boot_id || null; } catch { /* the monitor falls back to the restart grace period */ }
      await api('POST', '/api/system/apply-update', forced ? { confirm: true, force: true } : { confirm: true });
      monitor(bootId);
    } catch (error) {
      setView(previous => ({ ...previous, phase: 'error', message: t(errorLabel(error.message)) || error.message || 'Update not run' }));
    }
  };

  const busy = view.phase === 'checking' || view.phase === 'updating';
  // While the update runs the modal cannot be closed by accident (the service is about to restart).
  const close = () => { if (view.phase !== 'updating') { setOpen(false); clearInterval(timer.current); } };
  const show = () => { setOpened(true); setOpen(true); void check(); };
  const shown = view.status || null;
  const notes = shown && shown.remote_manifest && shown.remote_manifest.release_url;
  const published = shown && shown.remote_manifest && shown.remote_manifest.published_at;
  const admin = Boolean(shown && shown.is_update_admin);
  const archive = shown && shown.install_type === 'archive';
  const forcing = Boolean(force && view.forceOffered && !archive);
  const noRestart = shown && shown.restart_required === false;
  const dot = needsAttention(status);

  return (
    <>
      <IconButton id="h5-update" aria-label={t('Update')} title={t('Update')} aria-haspopup="dialog" data-attention={dot ? 'true' : undefined} onClick={show}>
        <Badge id="h5-update-dot" variant="dot" color="error" invisible={!dot} overlap="circular">
          <SystemUpdateAltIcon />
        </Badge>
      </IconButton>
      {opened ? <Dialog id="h5-update-dialog" open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="h5-update-title" aria-describedby="h5-update-body">
        <DialogTitle id="h5-update-title" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
          {t('Update')}
          <IconButton id="h5-update-close" aria-label={t('Close')} edge="end" disabled={view.phase === 'updating'} onClick={close}><CloseIcon /></IconButton>
        </DialogTitle>
        {/* Links in the dialog use the theme's light blue: the browser's default link blue (and its visited purple) cannot be read on the dark paper. */}
        <DialogContent id="h5-update-body" dividers sx={{ '& a, & a:visited': { color: 'primary.light', textUnderlineOffset: '3px' }, '& a:hover': { color: 'primary.main' } }}>
          {view.phase === 'checking' ? (
            <Box id="h5-update-state" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}><CircularProgress size={20} /><span>{t('Checking for the latest version…')}</span></Box>
          ) : null}
          {shown ? (
            <Box component="dl" id="h5-update-versions" sx={{ m: 0, mb: 1.5, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.5, fontSize: 14 }}>
              <Detail label="Current version" id="h5-update-current">{shown.local_version || '?'}</Detail>
              <Detail label="Latest version" id="h5-update-latest">{shown.remote_version || '?'}</Detail>
              <Detail label="Status" id="h5-update-status">{t(statusLabel(shown.status))}</Detail>
              <Detail label="Install type" id="h5-update-install">{t(installLabel(shown.install_type))}</Detail>
              <Detail label="Last checked" id="h5-update-checked">{formatTime(shown.last_checked_at)}</Detail>
              {Number.isFinite(Number(shown.check_interval_seconds)) && shown.check_interval_seconds ? <Detail label="Check interval" id="h5-update-interval">{`${Number(shown.check_interval_seconds) / 60} ${t('min')}`}</Detail> : null}
              <Detail label="GitHub version source" id="h5-update-source"><code style={{ fontSize: 12, wordBreak: 'break-all' }}>{shown.version_url || t('Not configured')}</code></Detail>
              {published ? <Detail label="Published" id="h5-update-published">{formatTime(published)}</Detail> : null}
            </Box>
          ) : null}
          {notes && /^https?:\/\//.test(notes) ? <Typography variant="body2" sx={{ mb: 1 }}><a id="h5-update-notes" href={notes} target="_blank" rel="noopener noreferrer">{t('View GitHub release notes ↗')}</a></Typography> : null}
          {view.phase === 'current' ? <Typography id="h5-update-state" role="status">{t('Already up to date')}</Typography> : null}
          {view.phase === 'restart' ? (
            <Box id="h5-update-restart" role="status" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography id="h5-update-state" sx={{ fontWeight: 600 }}>{t(shown.message || 'Code updated; restart the service to apply it')}</Typography>
              <Typography variant="body2">{t('Restart for your install type:')}</Typography>
              {RESTART_HELP.map(([kind, command]) => (
                <Typography key={kind} variant="body2" component="div" className="h5-update-restart-command">{t(kind)}: <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{command}</code></Typography>
              ))}
              <Typography variant="body2" color="text.secondary">{t('Restarting interrupts programs running in terminals.')}</Typography>
            </Box>
          ) : null}
          {view.phase === 'available' ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography id="h5-update-state" role="status">{admin ? t('A new version is available.') : t('Only the update administrator can run updates')}</Typography>
              {admin ? (
                <>
                  <Typography id="h5-update-warning" variant="body2" color="warning.main">
                    {t(noRestart ? 'Only frontend assets are updated; the service will not restart and existing shells stay connected. Refresh the page manually afterwards.'
                      : archive ? 'The update downloads the official install package, then installs dependencies and restarts the service. Existing shell connections will be interrupted.'
                        : 'The update checks the Git workspace and fast-forwards the code, then installs dependencies and restarts the service. Existing shell connections will be interrupted.')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">{t('The SQLite database is backed up before updating; accounts, tokens, tasks and working directories are not overwritten.')}</Typography>
                  {/* The force option is offered only after an update was blocked by local changes ("Choose force update…"): shown
                      every time, it read like a warning that the install has uncommitted changes. */}
                  {archive || !view.forceOffered ? null : (
                    <FormControlLabel
                      sx={{ alignItems: 'flex-start', '& .MuiCheckbox-root': { pt: 0.25 } }}
                      control={<Checkbox checked={force} onChange={event => setForce(event.target.checked)} slotProps={{ input: { id: 'h5-update-force' } }} />}
                      label={<Typography variant="body2">{t('Force update: back up local uncommitted code and untracked files to a Git stash, then use the remote code; ignored config and task data are kept. The backup is not restored automatically, and committed divergence still blocks the update.')}</Typography>}
                    />
                  )}
                </>
              ) : null}
            </Box>
          ) : null}
          {view.phase === 'updating' ? <Typography id="h5-update-state" role="status">{t(view.message || 'Updating…')}</Typography> : null}
          {view.phase === 'updating' && slow ? (
            <Typography id="h5-update-slow" variant="body2" sx={{ mt: 1 }}>
              {t('The page refreshes automatically once the service is back; if it takes too long, refresh manually: ')}
              <Button size="small" onClick={() => location.reload()}>{t('Refresh now')}</Button>
            </Typography>
          ) : null}
          {view.phase === 'error' ? <Typography id="h5-update-state" role="alert" color="error">{t(view.message)}</Typography> : null}
          {log ? <Paper id="h5-update-log" component="pre" variant="outlined" ref={logNode} aria-label={t('Update log')} aria-live="off" sx={{ m: 0, mt: 1.5, p: 1, maxHeight: '30vh', overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log}</Paper> : null}
        </DialogContent>
        <DialogActions>
          {view.phase === 'error' && view.dirty && admin ? <Button id="h5-update-force-retry" onClick={() => { setForce(true); setView(previous => ({ ...previous, phase: 'available', forceOffered: true })); }}>{t('Choose force update…')}</Button> : null}
          {view.phase === 'error' || view.phase === 'restart' ? <Button id="h5-update-retry" onClick={() => void check()}>{t('Check again')}</Button> : null}
          {view.phase === 'available' && admin ? <Button id="h5-update-now" variant="contained" color={forcing ? 'warning' : 'primary'} disabled={busy} onClick={() => void start()}>{t(forcing ? 'Force update now' : 'Update now')}</Button> : null}
          <Button id="h5-update-dismiss" color="inherit" disabled={view.phase === 'updating'} onClick={close}>{t('Close')}</Button>
        </DialogActions>
      </Dialog> : null}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { DeviceName, Pill, api, deviceText, errorText, t } from './common.jsx';
import { EngineDialog, Feedback, Field, Group, Hint, Section, SubHeading, failure, useFeedback } from './Form.jsx';
import { ServiceLinksSection, UnlinkDialog, linkEngineKey, readLinks } from './ServiceLinks.jsx';
import { RestartButton, restartInfo } from './Restart.jsx';
import { PeerFsSwitch } from './PeerFs.jsx';
import { RuleSyncSection } from './RuleSync.jsx';
import { RemoteAccessSection } from './RemoteAccess.jsx';
import { ADVANCED_SECTIONS } from './settings-target.mjs';
import { ScopeLabel, SettingsSyncStatus, SyncNote, refreshSettingsSync, useSyncAfterSave } from './ScopeLabel.jsx';
import { InTab, LocalOnly, refreshDeviceTargets, useSettingsTab } from './DeviceTarget.jsx';

// Settings "Devices" (until the sheet was tidied up the groups "Engines", "Linked services", "Rules and skills sync" and "Remote service"), top to
// bottom: the device list (this machine first, then every remote Engine this Client is connected to, linked ones included), "Link a device"
// (ServiceLinks.jsx, the recommended way to add one), the peer file access switch (PeerFs.jsx), "Rules and skills sync" (RuleSync.jsx), and the
// folded "Advanced" part with the one-way options: "Connect a remote engine" (the connect form below) and "Let other clients connect to this one"
// (RemoteAccess.jsx). The device list was ported from the old desktop page's engine tabs in 2.87.13.
// The /api/remote-servers endpoints, their validation and their error texts: connect with an address and a pairing code or token (POST /api/remote-servers), edit
// the name and address (PUT, the saved token is reused and never sent to the browser), remove (DELETE), check (POST /:id/check), and update a remote
// Engine (/:id/check-update, /:id/apply-update, then /:id/update-status until it is back). After every change the task list is
// read again (ui.actions.enginesChanged in h5.js). "Show in task list" is one switch per device, shown when there is more than one device; it only changes
// what the list shows (h5.js `setDeviceVisible`, `/api/task-list/hidden-devices`), so it is here for a linked service too, whose other editing is blocked.
// Every device has its own engine name, and "Rename" changes it: this machine through `/api/system/engine-name`, a remote row (linked ones too) through
// `PUT /api/remote-servers/:id/name`, which renames that engine itself, or only the row here when the engine is too old (`name_source: 'local'`). A server
// without these routes shows no Rename for this machine, and the remote rows keep the name field of "Edit connection" (no `can_rename`).
// "Restart T-Agent" is on the row of this machine (Restart.jsx), from the `restart` field of `/api/system/version`; not in a pane of the multi-column view.
// With the tabs of the sheet (SettingsTabs.jsx), Shared holds the "Settings sync" status line and "Show in task list" (one switch per device, in a
// list of its own); a device tab holds the device list (without the switches), Link a device, the file access switch, Rules and skills sync and Advanced.

export function errorLabel(code) {
  return ({
    INVALID_REMOTE_URL: 'Invalid URL format', INVALID_REMOTE_PORT: 'Invalid port', TOKEN_REQUIRED: 'Enter a token',
    REMOTE_TIMEOUT: 'Connection timed out', REMOTE_HTTP_401: 'Token is invalid or has been revoked', REMOTE_ALREADY_EXISTS: 'This remote service is already connected',
    REMOTE_CONNECTION_FAILED: 'Failed to connect to the remote service', REMOTE_URL_MUST_NOT_HAVE_PATH: 'Enter only the scheme and host in the URL, without a path',
    PAIRING_CODE_INVALID: 'Invalid pairing code format', PAIRING_CODE_INVALID_OR_EXPIRED: 'The pairing code is invalid or has expired',
    ENGINE_SCOPE_REQUIRED: 'This connection token has no engine management permission. Use an owner token instead',
    ENGINE_ROUTE_NOT_FOUND: 'The remote engine is too old and needs one manual upgrade first',
    VERSION_URL_NOT_CONFIGURED: 'The remote engine has no version source configured', WORKTREE_DIRTY: 'The remote engine workspace has uncommitted changes',
    BRANCH_DIVERGED: 'The remote engine’s Git branch has diverged', NO_UPDATE_AVAILABLE: 'The remote engine is already up to date',
    UPDATE_IN_PROGRESS: 'The remote engine is running another update', UPDATE_CHECK_FAILED: 'The remote engine failed to check for updates',
    NPM_INSTALLING_FAILED: 'The remote engine failed to install dependencies', NPM_BUILDING_FAILED: 'The remote engine failed to build assets',
    NODE_PTY_LOAD_FAILED: 'The remote engine’s terminal native module check failed',
    DOCKER_MANAGED_UPDATE: 'This engine is managed by Docker. Update the image on the host',
    LAST_DEVICE_VISIBLE: 'At least one device must stay visible',
    INVALID_ENGINE_NAME: 'Enter a name of 1 to 60 characters on one line',
    ENGINE_ADMIN_REQUIRED: 'Only an administrator can rename this machine',
  })[code] || code || 'Operation failed';
}
const STATUS = { online: 'Online', offline: 'Offline', unauthorized: 'Authentication expired', local: 'This machine' };
const statusLabel = status => STATUS[status] || 'Unknown';
const statusColor = status => (status === 'online' || status === 'local' ? 'success' : status === 'offline' || status === 'unauthorized' ? 'error' : 'default');
const UPDATE_STATUS = {
  idle: 'Not checked yet', checking: 'Checking', current: 'Up to date', available: 'Update available',
  local_newer: 'Current version is newer', updating: 'Updating', blocked: 'Update blocked', failed: 'Update failed',
  restart_pending: 'Service restart needed',
};
const updateStatusLabel = status => UPDATE_STATUS[status] || status || 'Unknown';
const installTypeLabel = type => ({ archive: 'Package update', git: 'Git fast-forward update', docker: 'Docker image update' })[type] || 'Unknown';
const versionText = version => (version ? (String(version).startsWith('v') ? String(version) : `v${version}`) : t('Unknown version'));
function updateVersion(status, remote = false) {
  if (!status) return 'Unknown';
  if (remote) return status.remote_version || 'Not fetched yet';
  return status.local_version || (status.local_manifest && status.local_manifest.app_version) || 'Unknown';
}
// "http://host:port" back into the two fields of the form.
function splitAddress(baseUrl) {
  try { const parsed = new URL(baseUrl); return { url: `${parsed.protocol}//${parsed.hostname}`, port: parsed.port }; }
  catch { return { url: baseUrl || '', port: '' }; }
}
const codeOf = error => (error && error.message) || '';

// The rule of the server for an engine name: 1 to 60 characters on one line, any language. Counted in characters, so a Chinese name has the same limit.
export const NAME_MAX = 60;
export function nameProblem(value) {
  const text = String(value || '');
  if (/[\r\n]/.test(text)) return 'A name must be on one line';
  const trimmed = text.trim();
  if (!trimmed) return 'Enter a name';
  if (Array.from(trimmed).length > NAME_MAX) return 'A name can have at most 60 characters';
  return '';
}
// What a failed rename says: a known code in words, an offline engine (502 without a code of its own), else the server's own text.
function renameError(error) {
  const code = codeOf(error);
  const label = errorLabel(code);
  if (label !== code) return t(label);
  if (error && error.status === 502) return t('The engine is offline. Try again when it is online.');
  return errorText(error) || t('Operation failed');
}

// Rename one device. `target`: { kind: 'local', current: { name, default_name, custom } } for this machine, or { kind: 'remote', server } for a row of the list.
// This machine and a remote engine that keeps its own name (`name_source: 'engine'`) can go back to their default name (an empty name is the server's reset);
// a row named only here (`name_source: 'local'`) has no default, so it has no reset. The field keeps what was typed when the save fails.
function RenameDialog({ target, onClose, onDone }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(null);
  if (target) last.current = target; // the text stays while the dialog closes
  const shown = last.current;
  const local = Boolean(shown) && shown.kind === 'local';
  const current = !shown ? '' : local ? shown.current.name : shown.server.name;
  useEffect(() => { if (target) { setValue(current || ''); setError(''); setBusy(false); } }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- a new target fills the form
  const send = async name => {
    setBusy(true);
    setError('');
    try {
      const saved = local ? await api('PUT', '/api/system/engine-name', { name }) : await api('PUT', `/api/remote-servers/${shown.server.id}/name`, { name });
      setBusy(false);
      await onDone(shown, saved);
    } catch (failed) { setError(renameError(failed)); setBusy(false); }
  };
  const save = event => {
    event.preventDefault();
    if (busy) return;
    const problem = nameProblem(value);
    if (problem) { setError(t(problem)); return; }
    void send(value.trim());
  };
  const onlyHere = !local && Boolean(shown) && shown.server.name_source === 'local';
  // This machine says whether its name is the default one; a remote engine does not, so its reset is always offered.
  const resettable = Boolean(shown) && (local || shown.server.name_source === 'engine');
  const resetDisabled = busy || (local && !shown.current.custom);
  return (
    <Dialog id="h5-engine-rename" open={Boolean(target)} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="h5-engine-rename-title">
      <Box component="form" autoComplete="off" noValidate onSubmit={save}>
        <DialogTitle id="h5-engine-rename-title" sx={{ fontSize: 18 }}>{t('Rename engine')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Typography variant="body2" color="text.secondary" component="div">
            {t('Current name')}
            <Box component="strong" id="h5-engine-rename-current" translate="no" sx={{ display: 'block', color: 'text.primary', overflowWrap: 'anywhere' }}>{current}</Box>
          </Typography>
          <Field
            id="h5-engine-rename-name" label="Name" value={value} autoFocus disabled={busy} error={Boolean(error)}
            onChange={event => { setValue(event.target.value); setError(''); }} htmlInput={{ autoCapitalize: 'sentences', enterKeyHint: 'done' }}
          />
          {local ? (
            <Typography id="h5-engine-rename-default" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {t('Default name:')} <span translate="no">{shown.current.default_name}</span>
            </Typography>
          ) : null}
          {onlyHere ? <Typography id="h5-engine-rename-only-here" variant="body2" color="warning.main">{t('This engine is too old to be renamed. The new name only changes on this device.')}</Typography> : null}
          {busy ? <Box id="h5-engine-rename-busy" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><CircularProgress size={16} /><Typography variant="body2" component="span">{t('Saving…')}</Typography></Box> : null}
          {error ? <Typography id="h5-engine-rename-error" role="alert" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{error}</Typography> : null}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {resettable ? <Button id="h5-engine-rename-reset" color="inherit" disabled={resetDisabled} onClick={() => void send('')} sx={{ mr: 'auto' }}>{t('Reset to default')}</Button> : null}
          <Button id="h5-engine-rename-cancel" color="inherit" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
          <Button id="h5-engine-rename-save" type="submit" variant="contained" disabled={busy}>{t('Save')}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function ConnectDialog({ state, open, onClose, onDone }) {
  const [form, setForm] = useState({ url: '', port: '', token: '' });
  const [result, setResult] = useState({ message: '', ok: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm({ url: '', port: '', token: '' }); setResult({ message: '', ok: false }); } }, [open]);
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const values = () => ({ url: form.url.trim(), port: form.port, token: form.token.trim() });
  const test = async () => {
    setBusy(true);
    try { await api('POST', '/api/remote-servers/test', values()); setResult({ message: 'Connected', ok: true }); }
    catch (error) { setResult({ message: errorLabel(codeOf(error)), ok: false }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { const created = await api('POST', '/api/remote-servers', values()); onDone(created); }
    catch (error) { setResult({ message: errorLabel(codeOf(error)), ok: false }); }
    finally { setBusy(false); }
  };
  return (
    <EngineDialog
      state={state} id="h5-engine-connect" title={t('Connect remote service')} open={open} onClose={onClose}
      actions={<>
        <Button id="h5-engine-connect-cancel" color="inherit" onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-engine-connect-test" disabled={busy} onClick={() => void test()}>{t('Test connection')}</Button>
        <Button id="h5-engine-connect-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Connect')}</Button>
      </>}
    >
      <Field id="h5-engine-url" label="URL" value={form.url} onChange={set('url')} placeholder={t('e.g. http://192.168.1.20')} sx={{ mt: 1 }} />
      <Field id="h5-engine-port" label="Port" type="number" value={form.port} onChange={set('port')} placeholder={t('e.g. 14002')} htmlInput={{ inputMode: 'numeric', min: 1, max: 65535 }} />
      <Field id="h5-engine-token" label="Pairing code or access token" type="password" autoComplete="new-password" value={form.token} onChange={set('token')} placeholder="TA-XXXX-XXXX-XXXX or tae_…" />
      <Hint>{t('A pairing code is single-use; the token obtained is stored encrypted on the Client server.')}</Hint>
      <Feedback id="h5-engine-connect-result" feedback={{ message: result.message ? t(result.message) : '', error: !result.ok }} />
    </EngineDialog>
  );
}

function EditDialog({ state, server, onClose, onDone }) {
  const [form, setForm] = useState({ name: '', url: '', port: '' });
  const [result, setResult] = useState({ message: '', ok: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!server) return;
    // The form shows the connection as it is saved; the token is not part of it (it is reused and never reaches the browser).
    const address = splitAddress(server.base_url);
    setForm({ name: server.name || '', url: address.url, port: address.port });
    setResult({ message: '', ok: false });
  }, [server]);
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  // A row that can be renamed changes its name with "Rename" only: this form then neither shows nor sends it.
  const named = Boolean(server) && !server.can_rename;
  const values = () => ({ ...(named ? { name: form.name.trim() } : {}), url: form.url.trim(), port: form.port });
  const test = async () => {
    setBusy(true);
    try { await api('POST', `/api/remote-servers/${server.id}/test`, values()); setResult({ message: 'Connected; the token is valid', ok: true }); }
    catch (error) { setResult({ message: errorLabel(codeOf(error)), ok: false }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await api('PUT', `/api/remote-servers/${server.id}`, values()); onDone(server); }
    catch (error) { setResult({ message: errorLabel(codeOf(error)), ok: false }); }
    finally { setBusy(false); }
  };
  return (
    <EngineDialog
      state={state} id="h5-engine-edit" title={t('Edit remote connection')} open={Boolean(server)} onClose={onClose}
      actions={<>
        <Button id="h5-engine-edit-cancel" color="inherit" onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-engine-edit-test" disabled={busy} onClick={() => void test()}>{t('Test connection')}</Button>
        <Button id="h5-engine-edit-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
      </>}
    >
      {named ? <Field id="h5-engine-edit-name" label="Name" value={form.name} onChange={set('name')} htmlInput={{ maxLength: 80 }} sx={{ mt: 1 }} /> : null}
      <Field id="h5-engine-edit-url" label="URL" value={form.url} onChange={set('url')} placeholder={t('e.g. https://tasks.example.com')} sx={named ? undefined : { mt: 1 }} />
      <Field id="h5-engine-edit-port" label="Port" type="number" value={form.port} onChange={set('port')} placeholder={t('May be left empty for HTTPS')} htmlInput={{ inputMode: 'numeric', min: 1, max: 65535 }} />
      <Hint>{t('The token saved for this connection is reused, so you do not need to enter it again. The new address is saved only after it verifies successfully.')}</Hint>
      <Feedback id="h5-engine-edit-result" feedback={{ message: result.message ? t(result.message) : '', error: !result.ok }} />
    </EngineDialog>
  );
}

const Row = ({ label, children, id }) => (
  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, fontSize: 14 }}>
    <Typography variant="body2" color="text.secondary" component="span">{t(label)}</Typography>
    <Typography variant="body2" component="span" id={id} sx={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{children}</Typography>
  </Box>
);
const logText = status => (Array.isArray(status && status.log) ? status.log.map(line => line.text).join('\n') : '');
const WAIT_MS = 12 * 60_000; // how long the page waits for the remote Engine to come back after an update

// The update of a remote Engine: check, the result, a confirmation, then the progress while it installs and restarts.
function UpdateDialog({ state, server, onClose, onUpdated }) {
  const [view, setView] = useState({ phase: 'checking' }); // checking | result | error | confirm | updating | failed | done | timeout
  const [log, setLog] = useState('');
  const timer = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);
  const check = async () => {
    clearTimeout(timer.current);
    setView({ phase: 'checking' });
    setLog('');
    try {
      const status = await api('POST', `/api/remote-servers/${server.id}/check-update`, {});
      if (alive.current) setView({ phase: 'result', status });
    } catch (error) { if (alive.current) setView({ phase: 'error', message: errorLabel(codeOf(error)) }); }
  };
  useEffect(() => { if (server) void check(); else clearTimeout(timer.current); }, [server]);
  const wait = target => {
    const deadline = Date.now() + WAIT_MS;
    const poll = async () => {
      if (!alive.current) return;
      try {
        const status = await api('GET', `/api/remote-servers/${server.id}/update-status`);
        if (!alive.current) return;
        if (status.status === 'blocked' || status.status === 'failed') {
          setLog(logText(status));
          setView({ phase: 'failed', message: 'Remote engine update failed', error: `${t(errorLabel(status.error))}${status.error_details ? `: ${status.error_details}` : ''}` });
          return;
        }
        setLog(logText(status));
        if (updateVersion(status) === target && status.status !== 'updating') {
          setView({ phase: 'done', message: `${server.name} ${t('upgraded to')} ${target}` });
          onUpdated(server);
          return;
        }
        setView({ phase: 'updating', message: status.message || (status.stage === 'restarting' ? 'Engine restarting…' : 'Engine updating…') });
      } catch {
        if (alive.current) setView({ phase: 'updating', message: 'Engine is offline for now, waiting for it to restart…' });
      }
      if (Date.now() >= deadline) {
        setView({ phase: 'timeout', message: 'Timed out waiting for the engine to recover', error: 'Check the remote service process and logs; the update may still be running in the background.' });
        return;
      }
      timer.current = setTimeout(poll, 2000);
    };
    timer.current = setTimeout(poll, 1000);
  };
  const apply = async () => {
    const target = updateVersion(view.status, true);
    setView({ phase: 'updating', message: 'Starting the remote update…' });
    try { await api('POST', `/api/remote-servers/${server.id}/apply-update`, {}); }
    catch (error) { setView({ phase: 'failed', message: 'Update did not start', error: t(errorLabel(codeOf(error))) }); return; }
    wait(target);
  };
  const status = view.status;
  const locked = view.phase === 'updating';
  const releaseUrl = status && status.remote_manifest && status.remote_manifest.release_url;
  const canApply = Boolean(status) && status.status === 'available' && status.install_type !== 'docker';
  const title = !server ? '' : view.phase === 'confirm' ? `${t('Update')} ${server.name}` : view.phase === 'updating' ? `${t('Updating')} ${server.name}` : `${server.name} · ${t('Engine update')}`;
  return (
    <EngineDialog
      state={state} id="h5-engine-update" title={title} open={Boolean(server)} onClose={onClose} locked={locked}
      actions={<>
        {view.phase === 'confirm' ? <Button id="h5-engine-update-cancel" color="inherit" onClick={() => setView({ phase: 'result', status })}>{t('Cancel')}</Button>
          : <Button id="h5-engine-update-close" color="inherit" disabled={locked} onClick={onClose}>{t('Close')}</Button>}
        {['result', 'error', 'failed', 'timeout'].includes(view.phase) ? <Button id="h5-engine-update-check" onClick={() => void check()}>{t('Check again')}</Button> : null}
        {view.phase === 'result' && canApply ? <Button id="h5-engine-update-apply" variant="contained" onClick={() => setView({ phase: 'confirm', status })}>{t('Update now')}</Button> : null}
        {view.phase === 'confirm' ? <Button id="h5-engine-update-confirm" variant="contained" onClick={() => void apply()}>{t('Confirm update')}</Button> : null}
      </>}
    >
      {view.phase === 'checking' ? (
        <Box id="h5-engine-update-state" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}><CircularProgress size={20} /><span>{t('Asking the remote engine to check GitHub for updates…')}</span></Box>
      ) : null}
      {view.phase === 'error' ? <Typography id="h5-engine-update-state" role="alert" color="error">{t(view.message)}</Typography> : null}
      {view.phase === 'result' && status ? (
        <Box id="h5-engine-update-result" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <Row label="Current version" id="h5-engine-update-current">{updateVersion(status)}</Row>
          <Row label="Latest version" id="h5-engine-update-latest">{t(updateVersion(status, true))}</Row>
          <Row label="Status" id="h5-engine-update-status">{t(updateStatusLabel(status.status))}</Row>
          <Row label="Install type" id="h5-engine-update-install">{t(installTypeLabel(status.install_type))}</Row>
          <Row label="Target branch"><code>{status.update_ref || t('Not configured')}</code></Row>
          {releaseUrl && /^https?:\/\//.test(releaseUrl) ? <Row label="Release notes"><a id="h5-engine-update-notes" href={releaseUrl} target="_blank" rel="noopener noreferrer">GitHub Release ↗</a></Row> : null}
          {status.install_type === 'docker' && status.status === 'available' ? <Hint>{t('The host update script will pull a new image and recreate the Docker engine container.')}</Hint> : null}
          {status.error ? <Typography id="h5-engine-update-error" variant="body2" color="error">{`${t(errorLabel(status.error))}${status.error_details ? `: ${status.error_details}` : ''}`}</Typography> : null}
        </Box>
      ) : null}
      {view.phase === 'confirm' && status ? (
        <Box id="h5-engine-update-confirm-box" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <Typography variant="body2" color="warning.main">{t('Remote terminals disconnect during the update. The engine restarts automatically after installing dependencies, and the Client waits for it to come back.')}</Typography>
          <Row label="Current version">{updateVersion(status)}</Row>
          <Row label="Target version">{updateVersion(status, true)}</Row>
        </Box>
      ) : null}
      {['updating', 'failed', 'done', 'timeout'].includes(view.phase) ? (
        <Box id="h5-engine-update-state" role={view.phase === 'failed' || view.phase === 'timeout' ? 'alert' : 'status'} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {view.phase === 'updating' ? <CircularProgress size={20} /> : null}
          <span>{t(view.message)}</span>
        </Box>
      ) : null}
      {view.error ? <Typography id="h5-engine-update-error" variant="body2" color="error">{t(view.error)}</Typography> : null}
      {log ? <Paper id="h5-engine-update-log" component="pre" variant="outlined" aria-label={t('Update log')} sx={{ m: 0, p: 1, maxHeight: '30vh', overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log}</Paper> : null}
    </EngineDialog>
  );
}

// "Show in task list" of one device. The last visible device cannot be hidden: its switch is disabled.
function ShowInList({ device, hidden, last, onChange }) {
  const label = t('Show in task list');
  return (
    <FormControlLabel
      className="h5-engine-visible" data-device={device} sx={{ m: 0, alignSelf: 'flex-start', gap: 0.5 }} label={<Typography variant="body2" component="span">{label}</Typography>}
      control={<Switch size="small" checked={!hidden} disabled={last} onChange={event => onChange(device, event.target.checked)} slotProps={{ input: { className: 'h5-engine-visible-input', 'aria-label': label } }} />}
    />
  );
}

// "Show in task list" in the Shared tab: the name of each device and its switch, one row each (the device list itself is in the device tabs).
function ShownDevices({ servers, localName, showProps }) {
  const rows = [{ key: 'local', source: { key: 'local', name: localName ? localName.name : '' } }, ...servers.map(server => ({ key: `remote:${server.id}`, source: { key: `remote:${server.id}`, label: server.name } }))];
  return (
    <Section id="task-list-devices" title="Show in task list" aside={<ScopeLabel id="task-list-devices" scope="shared" />}>
      <Hint>{t('Which devices the task list shows. One choice for all linked devices.')}</Hint>
      <Box id="h5-shown-devices" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {rows.map(({ key, source }) => {
          const show = showProps(key);
          return (
            <Box key={key} component="label" className="h5-shown-device h5-engine-visible" data-device={key} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minHeight: 44, minWidth: 0, cursor: 'pointer' }}>
              <Box component="strong" sx={NAME}><DeviceName source={source} className="h5-engine-name" /></Box>
              <Switch
                size="small" checked={!show.hidden} disabled={show.last} onChange={event => show.onChange(key, event.target.checked)}
                slotProps={{ input: { className: 'h5-engine-visible-input', 'aria-label': t(`Show ${deviceText(source)} in task list`), style: { left: 0, width: '100%' } } }}
              />
            </Box>
          );
        })}
      </Box>
    </Section>
  );
}

// The buttons of a row (44px on a touch screen, from the theme), and the line of its name (a long name is cut, `DeviceName`).
const ACTIONS = { display: 'flex', flexWrap: 'wrap', gap: 0.5 };
const NAME = { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 0.75, fontWeight: 700 };

// `link`: this Engine is a linked service (ServiceLinks.jsx). Its address and token belong to the link, so they cannot be edited, and removing it ends the link.
// `show`: the props of its "Show in task list" switch, or null when the switches do not appear.
// `onRename`: null when this row cannot be renamed (an older server).
function EngineRow({ server, link, busy, show, onCheck, onUpdate, onEdit, onRename, onRemove, feedback }) {
  return (
    <Paper variant="outlined" className="h5-engine-row" data-engine={server.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box component="strong" sx={NAME}><DeviceName source={{ key: `remote:${server.id}`, label: server.name }} className="h5-engine-name" /></Box>
        {link ? <Typography className="h5-engine-linked" variant="caption" color="text.secondary" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{t('Linked')}</Typography> : null}
        <Pill className="h5-engine-status" tone={statusColor(server.status)} label={t(statusLabel(server.status))} />
      </Box>
      <Typography className="h5-engine-meta" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {[link ? link.peer_url : server.base_url, versionText(server.remote_version), server.last_checked_at ? `${t('Last checked')} ${server.last_checked_at}` : ''].filter(Boolean).join(' · ')}
      </Typography>
      {server.last_error && server.status !== 'online' ? <Typography className="h5-engine-error" variant="caption" color="error">{t(errorLabel(server.last_error))}</Typography> : null}
      {show ? <ShowInList {...show} /> : null}
      <Box sx={ACTIONS}>
        {onRename ? <Button size="small" variant="outlined" className="h5-engine-rename" onClick={onRename}>{t('Rename')}</Button> : null}
        <Button size="small" variant="outlined" className="h5-engine-check" disabled={busy} onClick={onCheck}>{t('Check')}</Button>
        <Button size="small" variant="outlined" className="h5-engine-update" onClick={onUpdate}>{t('Check for updates')}</Button>
        {link ? null : <Button size="small" variant="outlined" className="h5-engine-edit" onClick={onEdit}>{t('Edit connection')}</Button>}
        <Button size="small" variant="outlined" color="error" className="h5-engine-remove" onClick={onRemove}>{t(!link ? 'Remove connection' : link.state === 'revoked' ? 'Remove' : 'Unlink')}</Button>
      </Box>
      <Feedback feedback={feedback} />
    </Paper>
  );
}

// The folded "Advanced" part of the Devices group. Its content stays mounted while it is folded; `onToggle` reports a new state.
function Advanced({ open, onToggle, children }) {
  return (
    <Section id="advanced">
      <SubHeading>
        <ButtonBase
          id="h5-devices-advanced-toggle" aria-expanded={open ? 'true' : 'false'} aria-controls="h5-devices-advanced" onClick={() => onToggle(!open)}
          sx={{ width: '100%', minHeight: 44, justifyContent: 'space-between', gap: 1, borderRadius: 1, font: 'inherit', textAlign: 'left' }}
        >
          <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, minWidth: 0 }}><span>{t('Advanced')}</span><ScopeLabel /></Box>
          <ExpandMoreIcon aria-hidden="true" sx={{ color: 'text.secondary', transition: 'transform 150ms', transform: open ? 'rotate(180deg)' : 'none' }} />
        </ButtonBase>
      </SubHeading>
      <Collapse in={open} id="h5-devices-advanced" unmountOnExit={false}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{children}</Box>
      </Collapse>
    </Section>
  );
}

// `request`: { section, seq } from `ui.actions.openSettings(id)` (settings-target.mjs); a part inside "Advanced" unfolds it too.
export function DevicesGroup({ state, ui, request = null }) {
  // The device list and "Link a device" show the same links: a change in one makes both read again.
  const [linksVersion, setLinksVersion] = useState(0);
  // A link that comes or goes also changes the tabs of the sheet (DeviceTarget.jsx) and the devices of the settings sync.
  const onLinksChanged = () => { setLinksVersion(version => version + 1); void refreshDeviceTargets(); void refreshSettingsSync(); };
  const { scope: tabScope } = useSettingsTab(); // null without tabs: every part, as before
  const wantsAdvanced = target => Boolean(target) && ADVANCED_SECTIONS.has(target.section);
  const [advanced, setAdvanced] = useState(() => wantsAdvanced(request));
  const [advancedOpened, setAdvancedOpened] = useState(0);
  const toggleAdvanced = next => { setAdvanced(next); if (next) setAdvancedOpened(count => count + 1); };
  useEffect(() => { if (wantsAdvanced(request) && !advanced) toggleAdvanced(true); }, [request]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new request unfolds it
  const [servers, setServers] = useState([]);
  const [links, setLinks] = useState([]);
  const [unlinking, setUnlinking] = useState(null);
  const [localVersion, setLocalVersion] = useState(null);
  const [localName, setLocalName] = useState(null); // { name, default_name, custom } of /api/system/engine-name, or null on an older server (no Rename)
  const [localRestart, setLocalRestart] = useState(null); // { supported, reason, bootId } from /api/system/version, or null on an older server (no Restart)
  const [renaming, setRenaming] = useState(null); // the target of RenameDialog
  const [checking, setChecking] = useState(null); // id of the Engine being checked
  const [rowFeedback, setRowFeedback] = useState({}); // id -> { message, error }
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [feedback, say] = useFeedback();
  const [shownSynced, trackShown] = useSyncAfterSave('task-list-devices');
  const [opened, setOpened] = useState(0); // goes up each time the group opens: the parts below read their data again
  const load = async ({ keep = false } = {}) => {
    try {
      const [list, version, linked, own] = await Promise.all([
        api('GET', '/api/remote-servers'),
        api('GET', '/api/system/version').catch(() => null),
        readLinks().catch(() => null),
        api('GET', '/api/system/engine-name').catch(() => null),
      ]);
      setServers(Array.isArray(list) ? list : []);
      setLocalVersion(version && version.app_version ? version.app_version : null);
      const restart = restartInfo(version);
      setLocalRestart(restart ? { ...restart, bootId: version.boot_id || null } : null);
      setLocalName(own && typeof own.name === 'string' ? own : null);
      setLinks(linked || []);
      if (!keep) say('');
    } catch (error) { say(failure(error), true); }
  };
  const seenLinks = useRef(linksVersion);
  useEffect(() => {
    if (seenLinks.current === linksVersion) return;
    seenLinks.current = linksVersion;
    void load({ keep: true });
  }, [linksVersion]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const linkOf = server => links.find(link => link.remote_server_id === server.id);
  // The engine selector of the task list follows every change; `key` is the Engine whose connection changed (its terminals are reconnected).
  const changed = async key => { await load(); if (ui.actions.enginesChanged) await ui.actions.enginesChanged(key); };
  const note = (id, message, error = false) => setRowFeedback(all => ({ ...all, [id]: { message: message ? t(message) : '', error } }));
  const check = async server => {
    setChecking(server.id);
    note(server.id, '');
    try {
      const fresh = await api('POST', `/api/remote-servers/${server.id}/check`, {});
      setServers(all => all.map(item => (item.id === server.id ? { ...item, ...fresh } : item)));
      note(server.id, 'Connected');
    } catch (error) {
      const fresh = error.data && error.data.server;
      if (fresh) setServers(all => all.map(item => (item.id === server.id ? { ...item, ...fresh } : item)));
      note(server.id, errorLabel(codeOf(error)), true);
    } finally { setChecking(null); }
  };
  // The switches: only with more than one device, and not on an older server. Dropped when the server refuses (a stale page after another device changed the list).
  const hidden = state.hiddenDevices || { supported: false, keys: [] };
  const devices = ['local', ...servers.map(server => `remote:${server.id}`)];
  const visibleDevices = devices.filter(key => !hidden.keys.includes(key));
  const switches = hidden.supported && devices.length > 1;
  const setVisible = async (device, visible) => {
    try { await ui.actions.setDeviceVisible(device, visible); void trackShown(); }
    catch (error) { say(`${t(errorLabel(codeOf(error)))}`, true); }
  };
  const showProps = device => (switches ? { device, hidden: hidden.keys.includes(device), last: visibleDevices.length === 1 && visibleDevices[0] === device, onChange: (key, visible) => void setVisible(key, visible) } : null);
  // After a rename: this list, the task list and every other place that names a device (the same refresh as any change here); the links list too.
  const renamed = async target => {
    setRenaming(null);
    if (target.kind === 'remote' && linkOf(target.server)) onLinksChanged();
    await changed(null);
    say('Saved');
  };
  const restartHere = Boolean(localRestart) && !state.pane; // a pane leaves restarts to the top page, as it does updates
  const remove = async server => {
    const link = linkOf(server);
    if (link) { setUnlinking(link); return; }
    if (!confirm(t('Remove this remote connection? Remote data is not deleted.'))) return;
    try { await api('DELETE', `/api/remote-servers/${server.id}`); await changed(`remote:${server.id}`); say('Removed'); }
    catch (error) { say(failure(error), true); }
  };
  // The remote access list is read when "Advanced" unfolds, and again each time the group opens while it is unfolded.
  const remoteOpened = advanced ? opened + advancedOpened : 0;
  // In the Shared tab the switches are a list of their own; in a device tab the rows have none.
  const rowSwitches = switches && tabScope === null;
  const listShown = tabScope !== 'shared';
  return (
    <Group id="devices" title="Devices" request={request} onOpen={() => { void load(); setOpened(count => count + 1); }}>
      <InTab part="settings-sync"><SettingsSyncStatus opened={opened} /></InTab>
      {tabScope === 'shared' && switches ? <ShownDevices servers={servers} localName={localName} showProps={showProps} /> : null}
      {listShown ? (
        <>
          <Hint>{t('Devices are the machines whose tasks and terminals this page shows. This machine is always first. To add another one, link it below.')}</Hint>
          {/* What the list changes: the names (and Restart) are this device's own; which devices the task list shows is one set for all linked devices. */}
          <ScopeLabel id="engine-name" subject="Device names" follow={false} />
          {rowSwitches ? <ScopeLabel id="task-list-devices" scope="shared" subject="Show in task list" /> : null}
          <Box id="h5-engine-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Paper variant="outlined" className="h5-engine-row" data-engine="local" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <Box component="strong" sx={NAME}><DeviceName source={{ key: 'local', name: localName ? localName.name : '' }} className="h5-engine-name" hintClassName="h5-engine-hint" /></Box>
                <Pill tone="success" label={t('Local')} sx={{ flexShrink: 0 }} />
              </Box>
              <Typography className="h5-engine-meta" variant="caption" color="text.secondary"><span id="h5-engine-local-version">{versionText(localVersion)}</span></Typography>
              {rowSwitches ? <ShowInList {...showProps('local')} /> : null}
              {localName || restartHere ? (
                <Box sx={ACTIONS}>
                  {localName ? <Button size="small" variant="outlined" className="h5-engine-rename" onClick={() => setRenaming({ kind: 'local', current: localName })}>{t('Rename')}</Button> : null}
                  {restartHere ? <RestartButton restart={localRestart} bootId={localRestart.bootId} /> : null}
                </Box>
              ) : null}
            </Paper>
            {servers.map(server => (
              <EngineRow
                key={server.id} server={server} link={linkOf(server)} busy={checking === server.id} show={rowSwitches ? showProps(`remote:${server.id}`) : null} feedback={rowFeedback[server.id] || { message: '', error: false }}
                onCheck={() => void check(server)} onUpdate={() => setUpdating(server)} onEdit={() => setEditing(server)} onRemove={() => void remove(server)}
                onRename={server.can_rename ? () => setRenaming({ kind: 'remote', server }) : null}
              />
            ))}
            {servers.length ? null : <Hint id="h5-engine-empty">{t('No other devices yet')}</Hint>}
          </Box>
        </>
      ) : null}
      <Feedback id="h5-engines-feedback" feedback={feedback} />
      <SyncNote id="h5-engines-sync" note={shownSynced} />
      {listShown ? (
        <>
          <ServiceLinksSection state={state} ui={ui} version={linksVersion} opened={opened} onChanged={onLinksChanged} />
          <PeerFsSwitch opened={opened} />
          <RuleSyncSection state={state} opened={opened} />
          <Advanced open={advanced} onToggle={toggleAdvanced}>
            <LocalOnly id="h5-devices-advanced-remote">
              <Hint id="h5-devices-advanced-hint">{t('Linking (above) is the recommended way to add a device. The options here connect one way only: for a device that should not see this one, or one on an older version.')}</Hint>
              <Section id="connect" title="Connect a remote engine" level={4}>
                <Hint>{t('Enter the address of another client and a pairing code made under “Let other clients connect to this one” on that client. Only this side sees the other.')}</Hint>
                <Button id="h5-engine-connect-open" variant="contained" onClick={() => setConnecting(true)}>{t('Connect remote service')}</Button>
              </Section>
              <RemoteAccessSection opened={remoteOpened} />
            </LocalOnly>
          </Advanced>
        </>
      ) : null}
      <ConnectDialog state={state} open={connecting} onClose={() => setConnecting(false)} onDone={created => { setConnecting(false); void changed(null); say(`${t('Connected')}: ${created && created.name ? created.name : ''}`); }} />
      <EditDialog state={state} server={editing} onClose={() => setEditing(null)} onDone={server => { setEditing(null); void changed(`remote:${server.id}`); say('Saved'); }} />
      <UnlinkDialog link={unlinking} onClose={() => setUnlinking(null)} onDone={async link => { setUnlinking(null); onLinksChanged(); if (ui.actions.enginesChanged) await ui.actions.enginesChanged(linkEngineKey(link)); say('Unlinked'); }} />
      <RenameDialog target={renaming} onClose={() => setRenaming(null)} onDone={renamed} />
      <UpdateDialog state={state} server={updating} onClose={() => { setUpdating(null); void load(); }} onUpdated={server => void changed(`remote:${server.id}`)} />
    </Group>
  );
}

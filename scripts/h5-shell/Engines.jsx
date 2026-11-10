import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Pill, api, t } from './common.jsx';
import { EngineDialog, Feedback, Field, Group, Hint, failure, useFeedback } from './Form.jsx';
import { UnlinkDialog, linkEngineKey, readLinks } from './ServiceLinks.jsx';

// Settings "Engines": the remote Engines this Client is connected to (ported from the old desktop page's engine tabs in 2.87.13).
// The /api/remote-servers endpoints, their validation and their error texts: connect with an address and a pairing code or token (POST /api/remote-servers), edit
// the name and address (PUT, the saved token is reused and never sent to the browser), remove (DELETE), check (POST /:id/check), and update a remote
// Engine (/:id/check-update, /:id/apply-update, then /:id/update-status until it is back). After every change the engine selector of the task list is
// read again (ui.actions.enginesChanged in h5.js).

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
  const values = () => ({ name: form.name.trim(), url: form.url.trim(), port: form.port });
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
      <Field id="h5-engine-edit-name" label="Name" value={form.name} onChange={set('name')} htmlInput={{ maxLength: 80 }} sx={{ mt: 1 }} />
      <Field id="h5-engine-edit-url" label="URL" value={form.url} onChange={set('url')} placeholder={t('e.g. https://tasks.example.com')} />
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

// `link`: this Engine is a linked service (ServiceLinks.jsx). Its address and token belong to the link, so they cannot be edited, and removing it ends the link.
function EngineRow({ server, link, busy, onCheck, onUpdate, onEdit, onRemove, feedback }) {
  return (
    <Paper variant="outlined" className="h5-engine-row" data-engine={server.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <strong className="h5-engine-name" style={{ minWidth: 0, overflowWrap: 'anywhere', flex: '1 1 auto' }}>{server.name}</strong>
        {link ? <Typography className="h5-engine-linked" variant="caption" color="text.secondary" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{t('Linked')}</Typography> : null}
        <Pill className="h5-engine-status" tone={statusColor(server.status)} label={t(statusLabel(server.status))} />
      </Box>
      <Typography className="h5-engine-meta" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {[link ? link.peer_url : server.base_url, versionText(server.remote_version), server.last_checked_at ? `${t('Last checked')} ${server.last_checked_at}` : ''].filter(Boolean).join(' · ')}
      </Typography>
      {server.last_error && server.status !== 'online' ? <Typography className="h5-engine-error" variant="caption" color="error">{t(errorLabel(server.last_error))}</Typography> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        <Button size="small" variant="outlined" className="h5-engine-check" disabled={busy} onClick={onCheck}>{t('Check')}</Button>
        <Button size="small" variant="outlined" className="h5-engine-update" onClick={onUpdate}>{t('Check for updates')}</Button>
        {link ? null : <Button size="small" variant="outlined" className="h5-engine-edit" onClick={onEdit}>{t('Edit connection')}</Button>}
        <Button size="small" variant="outlined" color="error" className="h5-engine-remove" onClick={onRemove}>{t(!link ? 'Remove connection' : link.state === 'revoked' ? 'Remove' : 'Unlink')}</Button>
      </Box>
      <Feedback feedback={feedback} />
    </Paper>
  );
}

// `linksVersion` goes up after a change of the linked services; `onLinksChanged` reports one made here.
export function EnginesGroup({ state, ui, linksVersion, onLinksChanged }) {
  const [servers, setServers] = useState([]);
  const [links, setLinks] = useState([]);
  const [unlinking, setUnlinking] = useState(null);
  const [localVersion, setLocalVersion] = useState(null);
  const [checking, setChecking] = useState(null); // id of the Engine being checked
  const [rowFeedback, setRowFeedback] = useState({}); // id -> { message, error }
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [feedback, say] = useFeedback();
  const load = async ({ keep = false } = {}) => {
    try {
      const [list, version, linked] = await Promise.all([
        api('GET', '/api/remote-servers'),
        api('GET', '/api/system/version').catch(() => null),
        readLinks().catch(() => null),
      ]);
      setServers(Array.isArray(list) ? list : []);
      setLocalVersion(version && version.app_version ? version.app_version : null);
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
  const remove = async server => {
    const link = linkOf(server);
    if (link) { setUnlinking(link); return; }
    if (!confirm(t('Remove this remote connection? Remote data is not deleted.'))) return;
    try { await api('DELETE', `/api/remote-servers/${server.id}`); await changed(`remote:${server.id}`); say('Removed'); }
    catch (error) { say(failure(error), true); }
  };
  return (
    <Group id="engines" title="Engines" onOpen={load}>
      <Hint>{t('Engines are the machines whose tasks and terminals this page shows. This machine is always there; connect other Clients with their address and a pairing code made under “Remote service” on that Client.')}</Hint>
      <Box id="h5-engine-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Paper variant="outlined" className="h5-engine-row" data-engine="local" sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
          <strong style={{ flex: '1 1 auto' }}>{t('This machine')}</strong>
          <Typography variant="caption" color="text.secondary" id="h5-engine-local-version">{versionText(localVersion)}</Typography>
          <Pill tone="success" label={t('Local')} />
        </Paper>
        {servers.map(server => (
          <EngineRow
            key={server.id} server={server} link={linkOf(server)} busy={checking === server.id} feedback={rowFeedback[server.id] || { message: '', error: false }}
            onCheck={() => void check(server)} onUpdate={() => setUpdating(server)} onEdit={() => setEditing(server)} onRemove={() => void remove(server)}
          />
        ))}
        {servers.length ? null : <Hint id="h5-engine-empty">{t('No remote engines connected yet')}</Hint>}
      </Box>
      <Button id="h5-engine-connect-open" variant="contained" onClick={() => setConnecting(true)}>{t('Connect remote service')}</Button>
      <Feedback id="h5-engines-feedback" feedback={feedback} />
      <ConnectDialog state={state} open={connecting} onClose={() => setConnecting(false)} onDone={created => { setConnecting(false); void changed(null); say(`${t('Connected')}: ${created && created.name ? created.name : ''}`); }} />
      <EditDialog state={state} server={editing} onClose={() => setEditing(null)} onDone={server => { setEditing(null); void changed(`remote:${server.id}`); say('Saved'); }} />
      <UnlinkDialog link={unlinking} onClose={() => setUnlinking(null)} onDone={async link => { setUnlinking(null); onLinksChanged(); if (ui.actions.enginesChanged) await ui.actions.enginesChanged(linkEngineKey(link)); say('Unlinked'); }} />
      <UpdateDialog state={state} server={updating} onClose={() => { setUpdating(null); void load(); }} onUpdated={server => void changed(`remote:${server.id}`)} />
    </Group>
  );
}

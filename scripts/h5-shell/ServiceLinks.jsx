import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Pill, api, t } from './common.jsx';
import { copyText } from './Attention.jsx';
import { EngineDialog, Feedback, Field, Group, Hint, failure, useFeedback } from './Form.jsx';
import { codeGroups, countdownText, secondsLeft } from './plugins-model.mjs';

// Settings "Linked services": two T-Agent services that see and operate each other's tasks, terminals and sessions. Service A generates a 6-digit code
// (POST /api/service-links/code), service B enters A's address and the code (POST /api/service-links/join with confirm: true). A linked service is then an
// ordinary remote Engine in /api/remote-servers (its row is matched by `remote_server_id`), so the rest of the page does not change. See "Settings, Engines and
// Update" in DESIGN.md. After a join or an unlink the task list is read again with ui.actions.enginesChanged, as Engines.jsx does.

const LIST = '/api/service-links';
const POLL_EVERY = 3; // seconds between two reads of the list while the code dialog is open

// The links, or null when this server has no linking (an older server answers 404). Any other failure is thrown: it says nothing about the server's version.
export async function readLinks() {
  try {
    const data = await api('GET', LIST);
    return data && data.supported === true && Array.isArray(data.links) ? data.links : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
// The Engine key of a link in the engine selector: its terminals close when the link ends.
export const linkEngineKey = link => (link.remote_server_id === null || link.remote_server_id === undefined ? null : `remote:${link.remote_server_id}`);

const LINK_ERRORS = {
  CONFIRM_REQUIRED: 'Accept the warning before linking',
  INVALID_CODE: 'The code is wrong or has expired. Generate a new code on the other service.',
  SELF_LINK: 'This is the address of this service. Enter the address of the other service.',
  ALREADY_LINKED: 'This service is already linked to that service.',
  LINK_UNSUPPORTED: 'The other service does not support linking. Update it first.',
  LINK_UNREACHABLE: 'Could not reach that address. This service itself must be able to reach the address you entered; it is not enough that this browser can.',
  INVALID_REMOTE_URL: 'Invalid URL format',
  INVALID_REMOTE_PORT: 'Invalid port',
  REMOTE_URL_MUST_NOT_HAVE_PATH: 'Enter only the scheme and host in the URL, without a path',
};
const linkError = error => (LINK_ERRORS[error.message] ? t(LINK_ERRORS[error.message]) : failure(error));

const STATE = { online: 'Online', offline: 'Offline', revoked: 'Revoked' };
const STATE_TONE = { online: 'success', offline: 'error', revoked: 'warning' };
const isLoopback = hostname => hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);

// The code of this service, big, with a countdown. A new link in the list while it is open means the other service used the code. There is no way to cancel a
// code, so closing the dialog only stops watching; the code ends when it expires or is used.
function CodeDialog({ open, onClose, onLinked }) {
  const [made, setMade] = useState(null); // { code, expiresAt }
  const [left, setLeft] = useState(0);
  const [linked, setLinked] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const known = useRef(new Set()); // the ids of the links that existed before this code
  const run = useRef(0); // a newer code or a closed dialog makes the answers of older requests stale

  const create = async () => {
    run.current += 1;
    const mine = run.current;
    setError(''); setLinked(null); setCopied(false); setMade(null);
    try {
      // The list is read first: a link made with this code can then never be taken for an old one.
      const before = await readLinks();
      const created = await api('POST', `${LIST}/code`, {});
      if (mine !== run.current) return;
      known.current = new Set((before || []).map(link => link.id));
      const expiresAt = new Date(Date.now() + created.expires_in_seconds * 1000).toISOString();
      setMade({ code: created.code, expiresAt });
      setLeft(secondsLeft(expiresAt));
    } catch (failed) {
      if (mine === run.current) setError(failure(failed));
    }
  };

  useEffect(() => {
    if (open) void create();
    else run.current += 1;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- a new code each time the dialog opens

  useEffect(() => {
    if (!open || !made || linked) return undefined;
    let ticks = 0;
    const timer = setInterval(async () => {
      setLeft(secondsLeft(made.expiresAt));
      ticks += 1;
      if (ticks % POLL_EVERY) return;
      const mine = run.current;
      try {
        const links = await readLinks();
        const fresh = (links || []).find(link => !known.current.has(link.id));
        if (!fresh || mine !== run.current) return;
        known.current.add(fresh.id); // a slower read that is still on its way must not report it again
        setLinked(fresh);
        onLinked();
      } catch { /* the next read tries again */ }
    }, 1000);
    return () => clearInterval(timer);
  }, [open, made, linked]); // eslint-disable-line react-hooks/exhaustive-deps -- onLinked is only called

  const copy = async () => { setCopied(await copyText(made.code)); };
  const expired = Boolean(made) && !linked && left <= 0;
  const address = location.origin;

  return (
    <Dialog id="h5-link-code-dialog" open={open} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="h5-link-code-title">
      <DialogTitle id="h5-link-code-title" sx={{ fontSize: 18 }}>{t('Linking code')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {error ? <Typography id="h5-link-code-error" role="alert" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{error}</Typography> : null}
        {!made && !error ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
        {linked ? (
          <Typography id="h5-link-code-done" role="status" variant="body1" sx={{ overflowWrap: 'anywhere' }}>{t('Linked:')} <span translate="no">{linked.name}</span></Typography>
        ) : null}
        {made && !linked ? (
          <>
            <Typography variant="body2" color="text.secondary">{t('On the other service, open Settings → Linked services and enter this address and code.')}</Typography>
            <Typography variant="body2" component="div" sx={{ overflowWrap: 'anywhere' }}>
              {t('Address of this service:')} <Box component="code" id="h5-link-address" translate="no" sx={{ userSelect: 'all' }}>{address}</Box>
            </Typography>
            {isLoopback(location.hostname) ? (
              <Typography id="h5-link-address-warning" role="alert" variant="body2" sx={{ color: 'warning.main' }}>{t('The other service will not be able to reach this address. Tell it an address it can reach, such as the network address of this computer.')}</Typography>
            ) : null}
            <Box id="h5-link-code" translate="no" aria-label={t('Linking code')} sx={{ fontSize: 40, fontWeight: 700, letterSpacing: 4, textAlign: 'center', fontVariantNumeric: 'tabular-nums', opacity: expired ? 0.4 : 1 }}>{codeGroups(made.code)}</Box>
            <Typography id="h5-link-countdown" role="timer" variant="body2" color={expired ? 'error' : 'text.secondary'} sx={{ textAlign: 'center' }}>
              {expired ? t('The code expired') : `${t('Valid for')} ${countdownText(left)}`}
            </Typography>
            <Button id="h5-link-copy" variant="outlined" disabled={expired} onClick={() => void copy()}>{copied ? t('Copied') : t('Copy')}</Button>
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        {expired || error ? <Button id="h5-link-code-new" onClick={() => void create()}>{t('New code')}</Button> : null}
        <Button id="h5-link-code-close" onClick={onClose}>{linked ? t('Done') : t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// Enter the address and code of the other service. Nothing is sent before the warning is accepted.
function JoinDialog({ state, open, onClose, onJoined }) {
  const [form, setForm] = useState({ url: '', port: '', code: '' });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setForm({ url: '', port: '', code: '' }); setAsking(false); setError(''); } }, [open]);
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const setCode = code => setForm(current => ({ ...current, code: code.replace(/\s+/g, '').slice(0, 6) }));
  // maxLength would cut "123 456" before onChange sees it, so a paste is put in here, without its spaces.
  const pasteCode = event => {
    event.preventDefault();
    const input = event.target;
    setCode(`${input.value.slice(0, input.selectionStart)}${event.clipboardData.getData('text').replace(/\s+/g, '')}${input.value.slice(input.selectionEnd)}`);
  };
  const ready = Boolean(form.url.trim()) && /^\d{6}$/.test(form.code);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const link = await api('POST', `${LIST}/join`, { url: form.url.trim(), ...(form.port ? { port: form.port } : {}), code: form.code, confirm: true });
      setAsking(false);
      onJoined(link);
    } catch (failed) {
      setAsking(false);
      setError(linkError(failed));
      if (failed.message === 'INVALID_CODE') setForm(current => ({ ...current, code: '' })); // the same code cannot work: the server ends it after a few wrong tries
    } finally { setBusy(false); }
  };
  return (
    <>
      <EngineDialog
        state={state} id="h5-link-join-dialog" title={t('Join another service')} open={open} onClose={onClose}
        actions={<>
          <Button id="h5-link-join-cancel" color="inherit" onClick={onClose}>{t('Cancel')}</Button>
          <Button id="h5-link-join-send" variant="contained" disabled={!ready || busy} onClick={() => setAsking(true)}>{t('Link')}</Button>
        </>}
      >
        <Hint>{t('Enter the address and the code shown on the other service.')}</Hint>
        <Field id="h5-link-url" label="URL" value={form.url} onChange={set('url')} placeholder={t('e.g. http://192.168.1.20')} sx={{ mt: 1 }} />
        <Field id="h5-link-port" label="Port" type="number" value={form.port} onChange={set('port')} placeholder={t('e.g. 14002')} htmlInput={{ inputMode: 'numeric', min: 1, max: 65535 }} />
        <Field id="h5-link-code-input" label="Linking code" value={form.code} autoComplete="one-time-code" onChange={event => setCode(event.target.value)} onPaste={pasteCode} htmlInput={{ inputMode: 'numeric', maxLength: 6 }} />
        <Feedback id="h5-link-join-result" feedback={{ message: error, error: true }} />
      </EngineDialog>
      <Dialog id="h5-link-confirm" open={asking} onClose={busy ? undefined : () => setAsking(false)} fullWidth maxWidth="xs" aria-labelledby="h5-link-confirm-title">
        <DialogTitle id="h5-link-confirm-title" sx={{ fontSize: 18 }}>{t('Link these services?')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="body2" sx={{ color: 'warning.main' }}>{t('Linking gives both services full control of each other, including terminals on both machines.')}</Typography>
          <Typography variant="body2">{t('This also applies if this service only allows local access.')}</Typography>
          <Typography variant="body2">{t('Only link services you own.')}</Typography>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button id="h5-link-confirm-cancel" color="inherit" disabled={busy} onClick={() => setAsking(false)}>{t('Cancel')}</Button>
          <Button id="h5-link-confirm-accept" variant="contained" disabled={busy} onClick={() => void send()}>{t('Link services')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// Ends a link, from the list below and from the Engines list. A link the other side already ended only has its row removed, so it says that instead.
export function UnlinkDialog({ link, onClose, onDone }) {
  const last = useRef(null);
  if (link) last.current = link; // the text stays while the dialog closes
  const shown = last.current;
  const revoked = Boolean(shown) && shown.state === 'revoked';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (link) setError(''); }, [link]);
  const unlink = async () => {
    setBusy(true);
    setError('');
    try { await api('DELETE', `${LIST}/${encodeURIComponent(link.id)}`); onDone(link); }
    catch (failed) { setError(linkError(failed)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog id="h5-link-unlink" open={Boolean(link)} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="h5-link-unlink-title">
      <DialogTitle id="h5-link-unlink-title" sx={{ fontSize: 18 }}>{t(revoked ? 'Remove this link?' : 'Unlink this service?')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography id="h5-link-unlink-name" component="strong" variant="body2" translate="no" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{shown ? shown.name : ''}</Typography>
        <Typography variant="body2">{t(revoked ? 'The other service already ended this link.' : 'The two services will stop seeing each other.')}</Typography>
        <Typography variant="body2">{t('Tasks and files on both stay where they are.')}</Typography>
        <Feedback id="h5-link-unlink-result" feedback={{ message: error, error: true }} />
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        <Button id="h5-link-unlink-cancel" color="inherit" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-link-unlink-accept" variant="contained" color="error" disabled={busy} onClick={() => void unlink()}>{t(revoked ? 'Remove' : 'Unlink')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function LinkRow({ link, onUnlink }) {
  const revoked = link.state === 'revoked';
  const direction = t(link.role === 'initiator' ? 'This service generated the code' : 'Joined using a code');
  return (
    <Paper variant="outlined" className="h5-link-row" data-link={link.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <strong className="h5-link-name" translate="no" style={{ minWidth: 0, overflowWrap: 'anywhere', flex: '1 1 auto' }}>{link.name}</strong>
        <Pill className="h5-link-status" tone={STATE_TONE[link.state] || 'default'} label={t(STATE[link.state] || 'Unknown')} sx={{ flexShrink: 0 }} />
      </Box>
      <Typography className="h5-link-direction" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{[direction, link.peer_url].filter(Boolean).join(' · ')}</Typography>
      {revoked ? <Typography className="h5-link-revoked" variant="caption" sx={{ color: 'warning.main' }}>{t('The other service ended this link.')}</Typography> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        <Button size="small" variant="outlined" color="error" className="h5-link-unlink" onClick={onUnlink}>{t(revoked ? 'Remove' : 'Unlink')}</Button>
      </Box>
    </Paper>
  );
}

// `version` goes up after a change made in this group or in the Engines group, which show the same links.
export function ServiceLinksGroup({ state, ui, version, onChanged }) {
  const [links, setLinks] = useState(null); // null: not read yet, or a server without linking; the group is then not drawn at all
  const [generating, setGenerating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [unlinking, setUnlinking] = useState(null);
  const [feedback, say] = useFeedback();
  const load = async ({ keep = false } = {}) => {
    try { setLinks(await readLinks()); if (!keep) say(''); }
    catch (error) { say(failure(error), true); }
  };
  useEffect(() => { void load({ keep: true }); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps -- read when the sheet opens, to know whether to draw the group
  const changed = async key => { onChanged(); if (ui.actions.enginesChanged) await ui.actions.enginesChanged(key); };
  if (!links) return null;
  return (
    <Group id="service-links" title="Linked services" onOpen={load}>
      <Hint>{t('Link another T-Agent service, so that both services see and operate each other’s tasks, terminals and sessions.')}</Hint>
      <Box id="h5-link-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {links.map(link => <LinkRow key={link.id} link={link} onUnlink={() => setUnlinking(link)} />)}
        {links.length ? null : <Hint id="h5-link-empty">{t('No linked services yet')}</Hint>}
      </Box>
      <Button id="h5-link-generate" variant="contained" onClick={() => setGenerating(true)}>{t('Generate a linking code')}</Button>
      <Button id="h5-link-join" variant="outlined" onClick={() => setJoining(true)}>{t('Join another service')}</Button>
      <Feedback id="h5-link-feedback" feedback={feedback} />
      <CodeDialog open={generating} onClose={() => setGenerating(false)} onLinked={() => void changed(null)} />
      <JoinDialog state={state} open={joining} onClose={() => setJoining(false)} onJoined={link => { setJoining(false); void changed(linkEngineKey(link)); say(`${t('Linked:')} ${link.name}`); }} />
      <UnlinkDialog link={unlinking} onClose={() => setUnlinking(null)} onDone={link => { setUnlinking(null); void changed(linkEngineKey(link)); say('Unlinked'); }} />
    </Group>
  );
}

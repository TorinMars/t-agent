import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { errorLabel as engineErrorLabel } from './Engines.jsx';
import { readLinks } from './ServiceLinks.jsx';

// "Also update" in the Update dialog (Update.jsx): the connected services (the rows of /api/remote-servers) updated together with this machine.
// Each is checked when the dialog opens (`POST /api/remote-servers/:id/check-update`, all at once, apart from this machine's check). A service with an
// update gets a checkbox, ticked when it is a linked service (`remote_server_id` of /api/service-links) and not ticked for a plain remote Engine. Every
// other service stays in the list, greyed, with the reason and no checkbox: offline, up to date, a Docker install, blocked, or an error.
// `start()` sends `apply-update` to every ticked service at once and resolves when each one was accepted or refused: this machine's own update starts
// only then, because a linked service behind the reverse tunnel cannot be reached once this machine restarts. Each row then follows its service with
// `update-status` (as the remote update of Engines.jsx does) until it reports the new version, fails, or 12 minutes pass. "Update and restart" in DESIGN.md.

const WAIT_MS = 12 * 60_000;
const POLL_MS = 2000;
// The codes of a service that does not answer (remote-client.js, the service-link tunnel): "Offline" says it better than the technical text.
const OFFLINE = /^(REMOTE_CONNECTION_FAILED|REMOTE_TIMEOUT|TUNNEL_(CLOSED|CONNECT_FAILED|DROPPED|STOPPED|REPLACED))$/;
const failedReason = error => {
  const code = (error && error.message) || '';
  if (OFFLINE.test(code)) return 'Offline';
  return engineErrorLabel(code);
};
const statusError = status => `${t(engineErrorLabel(status.error))}${status.error_details ? `: ${status.error_details}` : ''}`;
const versionOf = status => (status && (status.local_version || (status.local_manifest && status.local_manifest.app_version))) || '';

// The row for the answer of check-update.
export function classify(status) {
  const current = versionOf(status);
  const target = (status && status.remote_version) || '';
  const base = { current, target };
  if (!status) return { ...base, phase: 'unavailable', reason: 'Check failed' };
  if (status.status === 'available') {
    if (status.install_type === 'docker') return { ...base, phase: 'unavailable', reason: 'This engine is managed by Docker. Update the image on the host' };
    return { ...base, phase: 'ready' };
  }
  if (status.status === 'current') return { ...base, phase: 'unavailable', reason: 'Up to date' };
  if (status.status === 'local_newer') return { ...base, phase: 'unavailable', reason: 'Current version is newer' };
  if (status.status === 'updating') return { ...base, phase: 'unavailable', reason: 'Already updating' };
  if (status.status === 'restart_pending') return { ...base, phase: 'unavailable', reason: 'Service restart needed' };
  if (status.status === 'blocked' || status.status === 'failed') return { ...base, phase: 'unavailable', reason: status.error ? statusError(status) : status.status === 'blocked' ? 'Update blocked' : 'Check failed' };
  return { ...base, phase: 'unavailable', reason: 'Check failed' };
}

// The state of the list. `rows` is null until the list was read, and [] when there is no other service.
export function useLinkedUpdates() {
  const [rows, setRows] = useState(null);
  const generation = useRef(0); // a new reading of the list ends everything the previous one started
  const timers = useRef(new Set());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; for (const timer of timers.current) clearTimeout(timer); }, []);
  const later = (run, ms) => { const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms); timers.current.add(timer); };
  const setRow = (gen, id, change) => {
    if (!alive.current || gen !== generation.current) return;
    setRows(all => (all ? all.map(row => (row.id === id ? { ...row, ...(typeof change === 'function' ? change(row) : change) } : row)) : all));
  };

  const load = async () => {
    generation.current += 1;
    const gen = generation.current;
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    setRows(null);
    const [servers, links] = await Promise.all([api('GET', '/api/remote-servers').catch(() => null), readLinks().catch(() => null)]);
    if (!alive.current || gen !== generation.current) return;
    const list = Array.isArray(servers) ? servers.filter(server => server && server.id !== undefined && server.id !== null) : [];
    const linked = new Set((links || []).filter(link => link.state !== 'revoked').map(link => link.remote_server_id));
    setRows(list.map(server => ({ id: server.id, name: server.name || `#${server.id}`, linked: linked.has(server.id), phase: 'checking', checked: false })));
    await Promise.all(list.map(async server => {
      try {
        const status = await api('POST', `/api/remote-servers/${server.id}/check-update`, {});
        const row = classify(status);
        setRow(gen, server.id, previous => ({ ...row, checked: row.phase === 'ready' && previous.linked }));
      } catch (error) {
        setRow(gen, server.id, { phase: 'unavailable', reason: failedReason(error), checked: false });
      }
    }));
  };

  const toggle = (id, checked) => setRows(all => all.map(row => (row.id === id && row.phase === 'ready' ? { ...row, checked } : row)));

  // Follows one service after its update was accepted, like the remote update of Engines.jsx.
  const follow = (gen, row) => {
    const deadline = Date.now() + WAIT_MS;
    const poll = async () => {
      if (!alive.current || gen !== generation.current) return;
      try {
        const status = await api('GET', `/api/remote-servers/${row.id}/update-status`);
        if (status.status === 'blocked' || status.status === 'failed') { setRow(gen, row.id, { phase: 'failed', reason: status.error ? statusError(status) : 'Remote engine update failed' }); return; }
        if (versionOf(status) === row.target && status.status !== 'updating') { setRow(gen, row.id, { phase: 'done', current: row.target }); return; }
        setRow(gen, row.id, { phase: 'updating', message: status.stage === 'restarting' ? 'Engine restarting…' : 'Engine updating…' });
      } catch {
        setRow(gen, row.id, { phase: 'updating', message: 'Engine is offline for now, waiting for it to restart…' });
      }
      if (Date.now() >= deadline) { setRow(gen, row.id, { phase: 'timeout', reason: 'Timed out waiting for the engine to recover' }); return; }
      later(poll, POLL_MS);
    };
    later(poll, 1000);
  };

  // Starts every ticked service; resolves once each one was accepted or refused (it never throws).
  const start = async () => {
    const gen = generation.current;
    const chosen = (rows || []).filter(row => row.phase === 'ready' && row.checked);
    if (!chosen.length) return;
    setRows(all => all.map(row => (chosen.some(item => item.id === row.id) ? { ...row, phase: 'starting' } : row)));
    await Promise.all(chosen.map(async row => {
      try {
        await api('POST', `/api/remote-servers/${row.id}/apply-update`, {});
        setRow(gen, row.id, { phase: 'accepted' });
        follow(gen, row);
      } catch (error) {
        setRow(gen, row.id, { phase: 'failed', reason: `${t('Update did not start')}: ${t(failedReason(error))}` });
      }
    }));
  };

  const selected = (rows || []).filter(row => row.phase === 'ready' && row.checked).length;
  return { rows, load, toggle, start, selected };
}

// The text of a row after "Update now".
function progressText(row) {
  if (row.phase === 'starting') return t('Starting the remote update…');
  if (row.phase === 'accepted') return t('Update accepted');
  if (row.phase === 'updating') return t(row.message || 'Engine updating…');
  if (row.phase === 'done') return t(`Updated to ${row.target}`);
  return t(row.reason || 'Remote engine update failed');
}
const BOX = 44; // the checkbox and the spinner take the same room, so every name lines up

function LinkedRow({ row, locked, onToggle }) {
  const inputId = `h5-update-linked-${row.id}`;
  const greyed = row.phase === 'unavailable';
  const versions = row.current && row.target && row.current !== row.target ? `${row.current} → ${row.target}` : row.current || '';
  const line = row.phase === 'checking' ? t('Checking…')
    : row.phase === 'ready' ? versions
      : greyed ? [t(row.reason), row.current].filter(Boolean).join(' · ')
        : progressText(row);
  const tone = row.phase === 'done' ? 'success.main' : row.phase === 'failed' || row.phase === 'timeout' ? 'error' : 'text.secondary';
  const busy = row.phase === 'checking' || row.phase === 'starting' || row.phase === 'accepted' || row.phase === 'updating';
  return (
    <Box
      component="li" className="h5-update-linked-row" data-engine={row.id} data-state={row.phase} data-linked={row.linked ? 'true' : 'false'}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: BOX, ml: '-10px', color: greyed ? 'text.disabled' : 'text.primary' }}
    >
      <Box sx={{ width: BOX, flex: `0 0 ${BOX}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {row.phase === 'ready' ? (
          <Checkbox checked={row.checked} disabled={locked} onChange={event => onToggle(row.id, event.target.checked)} slotProps={{ input: { id: inputId, className: 'h5-update-linked-check' } }} />
        ) : busy ? <CircularProgress size={18} aria-hidden="true" /> : null}
      </Box>
      <Box component={row.phase === 'ready' ? 'label' : 'div'} htmlFor={row.phase === 'ready' ? inputId : undefined} sx={{ flex: '1 1 auto', minWidth: 0, py: 0.5, cursor: row.phase === 'ready' ? 'pointer' : 'default' }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
          <Box component="span" className="h5-update-linked-name" translate="no" title={row.name} sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{row.name}</Box>
          {row.linked ? <Typography component="span" variant="caption" color={greyed ? 'text.disabled' : 'text.secondary'} sx={{ flexShrink: 0 }}>{t('Linked')}</Typography> : null}
        </Box>
        <Typography className="h5-update-linked-state" variant="body2" color={greyed ? 'text.disabled' : tone} sx={{ overflowWrap: 'anywhere' }} translate={row.phase === 'ready' ? 'no' : undefined}>{line}</Typography>
      </Box>
    </Box>
  );
}

// The list in the dialog; nothing when there is no other service.
export function LinkedList({ linked, locked }) {
  const { rows, toggle } = linked;
  if (!rows || !rows.length) return null;
  return (
    <Box id="h5-update-linked" component="section" aria-labelledby="h5-update-linked-title" sx={{ mt: 1.5, pt: 1, borderTop: 1, borderColor: 'divider' }}>
      <Typography id="h5-update-linked-title" variant="subtitle2" component="h3" sx={{ m: 0 }}>{t('Also update')}</Typography>
      <Box component="ul" aria-live="polite" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {rows.map(row => <LinkedRow key={row.id} row={row} locked={locked} onToggle={toggle} />)}
      </Box>
    </Box>
  );
}

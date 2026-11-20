import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { api, t, Pill } from './common.jsx';
import { errorLabel as engineErrorLabel } from './engine-errors.mjs';
import { readLinks } from './service-links-read.mjs';

// "Also update" in the Update dialog (Update.jsx): the connected services (the rows of /api/remote-servers) updated together with this machine.
// Each is checked when the dialog opens (`POST /api/remote-servers/:id/check-update`, all at once, apart from this machine's check). A service with an
// update gets a checkbox, ticked when it is a linked service (`remote_server_id` of /api/service-links) and not ticked for a plain remote Engine. Every
// other service stays in the list, greyed, with the reason and no checkbox: offline, up to date, a Docker install, blocked, or an error.
// `start()` sends `apply-update` to every ticked service at once and resolves when each one was accepted or refused: this machine's own update starts
// only then, because a linked service behind the reverse tunnel cannot be reached once this machine restarts. Each row then follows its service with
// `update-status` (as the remote update of Engines.jsx does) until it reports the new version, fails, or 12 minutes pass. "Update and restart" in docs/design/page-files-and-settings.md.
// "Update all" (`startAll`) asks every engine with an update, this machine included, to update by itself under its own idle rule
// (`POST /api/system/update-when-idle`, `POST /api/remote-servers/:id/update-when-idle`); each row then follows its engine's automatic update while the
// dialog is open ("Update all" in docs/design/update-check-and-versions.md). The list also has this machine's row (`here`), in name order.

const WAIT_MS = 12 * 60_000;
const POLL_MS = 2000;
const IDLE_POLL_MS = 5000; // "Update all": an engine may wait for idle terminals for hours, so its row reads less often (and only while the dialog is open)
const LOCAL = 'local';
// Why an engine cannot update by itself: the codes of POST .../update-when-idle.
const AUTO_UNSUPPORTED = { NO_PROCESS_MANAGER: 'Needs a process manager such as PM2 to restart the service', CHECKS_DISABLED: 'Version checks are turned off on this service' };
const TOO_OLD = 'Too old to update when idle: update it in Settings → Devices';
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

// "Update all": the row of an engine that was asked to update when idle, from its update-status; null when it was not asked (or nothing is left).
// `describe(auto)` is the Update dialog's line for an automatic update ("Waiting: 1 terminal running", "Will update at about 14:20"), already translated.
export function idleProgress(status, target, describe) {
  if (!status) return null;
  if (status.status === 'blocked' || status.status === 'failed') return { phase: 'failed', reason: status.error ? statusError(status) : 'Remote engine update failed' };
  if (target && versionOf(status) === target && status.status !== 'updating') return { phase: 'done', current: target };
  const auto = status.auto_update || {};
  if (status.status === 'updating' || auto.state === 'applying') return { phase: 'updating', message: 'Engine updating…' };
  if (!auto.requested) return null;
  if (auto.state === 'gave_up') return { phase: 'failed', line: describe(auto) || t('Automatic update stopped for this version') };
  return { phase: 'waiting', line: describe(auto) || t('Waiting for the service to be idle') };
}
// The row of an engine that refused "Update all".
function refusedIdle(error) {
  const code = (error && error.message) || '';
  if (code === 'UPDATE_WHEN_IDLE_UNSUPPORTED') return { phase: 'ready', note: TOO_OLD };
  if (code === 'AUTO_UPDATE_UNSUPPORTED') return { phase: 'failed', reason: AUTO_UNSUPPORTED[error.data && error.data.reason] || 'Not available on this service' };
  return { phase: 'failed', reason: `${t('Update did not start')}: ${t(failedReason(error))}` };
}

// The state of the list. `rows` is null until the list was read, and [] when there is no other service. `open`: the dialog is open (the rows of
// "Update all" read their engine only then). `local`: this machine's row after "Update all", or null while it shows the dialog's own check.
export function useLinkedUpdates(open = true, describe = () => '') {
  const [rows, setRows] = useState(null);
  const [local, setLocal] = useState(null);
  const shown = useRef(open);
  shown.current = open;
  const describeRef = useRef(describe);
  describeRef.current = describe;
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
    setLocal(null);
    const [servers, links] = await Promise.all([api('GET', '/api/remote-servers').catch(() => null), readLinks().catch(() => null)]);
    if (!alive.current || gen !== generation.current) return;
    const list = Array.isArray(servers) ? servers.filter(server => server && server.id !== undefined && server.id !== null) : [];
    const linked = new Set((links || []).filter(link => link.state !== 'revoked').map(link => link.remote_server_id));
    setRows(list.map(server => ({ id: server.id, name: server.name || `#${server.id}`, linked: linked.has(server.id), phase: 'checking', checked: false })));
    await Promise.all(list.map(async server => {
      try {
        const status = await api('POST', `/api/remote-servers/${server.id}/check-update`, {});
        const row = classify(status);
        // Asked to update when idle before (here or on another device): the row shows how far it is, from the engine's own state.
        const asked = row.phase === 'ready' ? idleProgress(status, row.target, describeRef.current) : null;
        setRow(gen, server.id, previous => ({ ...row, ...(asked || {}), checked: row.phase === 'ready' && !asked && previous.linked }));
        if (asked && asked.phase === 'waiting') followIdle(gen, server.id, row.target);
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

  // "Update all": follows an engine that updates when idle, every 5 s while the dialog is open, until it reports the new version or fails.
  const followIdle = (gen, id, target) => {
    const poll = async () => {
      if (!alive.current || gen !== generation.current) return;
      if (shown.current) {
        let next;
        try {
          const status = await api('GET', id === LOCAL ? '/api/system/update-status' : `/api/remote-servers/${id}/update-status`);
          next = idleProgress(status, target, describeRef.current) || { phase: 'done', current: versionOf(status) || target };
        } catch {
          next = { phase: 'updating', message: 'Engine is offline for now, waiting for it to restart…' };
        }
        if (!alive.current || gen !== generation.current) return;
        if (id === LOCAL) setLocal(previous => ({ ...previous, ...next })); else setRow(gen, id, next);
        if (next.phase === 'done' || next.phase === 'failed') return;
      }
      later(poll, IDLE_POLL_MS);
    };
    later(poll, IDLE_POLL_MS);
  };

  // "Update all": every engine with an update (`here`: this machine's { target } when it has one and this person may update it) is asked to update
  // under its own idle rule. Resolves once each one answered (it never throws).
  const startAll = async ({ here }) => {
    const gen = generation.current;
    const describe = describeRef.current;
    const chosen = (rows || []).filter(row => row.phase === 'ready' && !row.note);
    setRows(all => (all || []).map(row => (chosen.some(item => item.id === row.id) ? { ...row, phase: 'asking', checked: false } : row)));
    const ask = async (id, route, target, write) => {
      try {
        const status = await api('POST', route, { confirm: true });
        if (!alive.current || gen !== generation.current) return;
        const next = status && status.requested === false ? { phase: 'unavailable', reason: 'Up to date' } : idleProgress(status, target, describe) || { phase: 'waiting', line: t('Waiting for the service to be idle') };
        write(next);
        if (next.phase === 'waiting' || next.phase === 'updating') followIdle(gen, id, target);
      } catch (error) {
        if (alive.current && gen === generation.current) write(refusedIdle(error));
      }
    };
    if (here) setLocal({ phase: 'asking', target: here.target });
    await Promise.all([
      ...chosen.map(row => ask(row.id, `/api/remote-servers/${row.id}/update-when-idle`, row.target, next => setRow(gen, row.id, next))),
      ...(here ? [ask(LOCAL, '/api/system/update-when-idle', here.target, next => setLocal(previous => ({ ...previous, ...next })))] : []),
    ]);
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
  // Engines "Update all" would ask: the other ones here (this machine is the dialog's to count).
  const updatable = (rows || []).filter(row => row.phase === 'ready' && !row.note).length;
  return { rows, local, load, toggle, start, startAll, selected, updatable };
}

// The text of a row after "Update now".
function progressText(row) {
  if (row.phase === 'starting') return t('Starting the remote update…');
  if (row.phase === 'accepted') return t('Update accepted');
  if (row.phase === 'updating') return t(row.message || 'Engine updating…');
  if (row.phase === 'asking') return t('Asking it to update when idle…');
  if (row.phase === 'waiting') return row.line;
  if (row.phase === 'done') return t(`Updated to ${row.current || row.target}`);
  if (row.line) return row.line;
  return t(row.reason || 'Remote engine update failed');
}
const BOX = 44; // the checkbox and the spinner take the same room, so every name lines up

// The pill at the right of a row (as in Settings → Devices): what the engine's version is, before anything was started.
function pillOf(row) {
  if (row.phase === 'ready') return { tone: 'warning', label: 'Update available' };
  if (row.phase === 'unavailable' && row.reason === 'Up to date') return { tone: 'success', label: 'Up to date' };
  if (row.phase === 'done') return { tone: 'success', label: 'Up to date' };
  return null;
}

// `choose`: the checkbox of "Update now" (only while this machine has an update of its own to take the others along).
function LinkedRow({ row, locked, choose, onToggle }) {
  const inputId = `h5-update-linked-${row.id}`;
  const greyed = row.phase === 'unavailable';
  const versions = row.current && row.target && row.current !== row.target ? `${row.current} → ${row.target}` : row.current || '';
  const pill = pillOf(row);
  const line = row.phase === 'checking' ? t('Checking…')
    : row.phase === 'ready' ? [versions, row.note ? t(row.note) : ''].filter(Boolean).join(' · ')
      : greyed ? [pill ? '' : t(row.reason), row.current].filter(Boolean).join(' · ') // the pill already says "Up to date"
        : progressText(row);
  const tone = row.phase === 'done' ? 'success.main' : row.phase === 'failed' || row.phase === 'timeout' ? 'error' : 'text.secondary';
  const busy = row.phase === 'checking' || row.phase === 'starting' || row.phase === 'accepted' || row.phase === 'updating' || row.phase === 'asking' || row.phase === 'waiting';
  const box = row.phase === 'ready' && choose;
  return (
    <Box
      component="li" className="h5-update-linked-row" data-engine={row.id} data-state={row.phase} data-linked={row.linked ? 'true' : 'false'}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: BOX, ml: '-10px', color: greyed ? 'text.disabled' : 'text.primary' }}
    >
      <Box sx={{ width: BOX, flex: `0 0 ${BOX}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {box ? (
          <Checkbox checked={row.checked} disabled={locked} onChange={event => onToggle(row.id, event.target.checked)} slotProps={{ input: { id: inputId, className: 'h5-update-linked-check' } }} />
        ) : busy ? <CircularProgress size={18} aria-hidden="true" /> : null}
      </Box>
      <Box component={box ? 'label' : 'div'} htmlFor={box ? inputId : undefined} sx={{ flex: '1 1 auto', minWidth: 0, py: 0.5, cursor: box ? 'pointer' : 'default' }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
          <Box component="span" className="h5-update-linked-name" translate="no" title={row.name} sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{row.name}</Box>
          {row.linked ? <Typography component="span" variant="caption" color={greyed ? 'text.disabled' : 'text.secondary'} sx={{ flexShrink: 0 }}>{t('Linked')}</Typography> : null}
        </Box>
        <Typography className="h5-update-linked-state" variant="body2" color={greyed ? 'text.disabled' : tone} sx={{ overflowWrap: 'anywhere' }} translate={row.phase === 'ready' && !row.note ? 'no' : undefined}>{line}</Typography>
      </Box>
      {pill ? <Pill className="h5-update-linked-pill" tone={pill.tone} label={t(pill.label)} sx={{ flexShrink: 0, ml: 1 }} /> : null}
    </Box>
  );
}

// This machine's row: from the dialog's own check (`here.status`) until "Update all" asked it (`local` of the hook).
function localRow(here, local) {
  const status = here.status || {};
  const base = { id: LOCAL, name: here.name, linked: false, current: status.local_version || '', target: status.remote_version || '' };
  if (local) return { ...base, ...local };
  if (here.updating) return { ...base, phase: 'updating', message: 'Updating…' };
  if (!here.status) return { ...base, phase: 'checking' };
  const asked = status.status === 'available' ? idleProgress(status, base.target, here.describe || (() => '')) : null;
  if (asked) return { ...base, ...asked };
  const row = classify(status);
  return { ...base, ...row, current: base.current, target: base.target };
}

// The list in the dialog; nothing when there is no other service. `here`: { name, status, updating, describe } of this machine, drawn in name order.
// `choose`: the rows of services with an update have the checkbox of "Update now".
export function LinkedList({ linked, locked, here = null, choose = true }) {
  const { rows, toggle } = linked;
  if (!rows || !rows.length) return null;
  const all = here ? [...rows, localRow(here, linked.local)].sort((a, b) => String(a.name).localeCompare(String(b.name))) : rows;
  return (
    <Box id="h5-update-linked" component="section" aria-labelledby="h5-update-linked-title" sx={{ mt: 1.5, pt: 1, borderTop: 1, borderColor: 'divider' }}>
      <Typography id="h5-update-linked-title" variant="subtitle2" component="h3" sx={{ m: 0 }}>{t(here ? 'Engines' : 'Also update')}</Typography>
      <Box component="ul" aria-live="polite" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {all.map(row => <LinkedRow key={row.id} row={row} locked={locked} choose={choose && row.id !== LOCAL} onToggle={toggle} />)}
      </Box>
    </Box>
  );
}

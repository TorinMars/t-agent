import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { DialogError, Pill, api, errorText, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { Feedback, Field, Hint, Section, SubHeading, SwitchRow, useFeedback } from './Form.jsx';
import { ScopeLabel, SyncNote, useSyncAfterSave } from './ScopeLabel.jsx';
import { LocalOnly } from './DeviceTarget.jsx';
import { TOUCH } from './theme.mjs';

// "Devices and sign-ins" of Settings → Account and access (docs/design/page-files-and-settings.md): the devices that used this service (from the
// `X-TA-Device` id of each browser, public/js/client-auth.js), the recent sign-in events, and the switch "Alert me about new devices". The log is
// kept by this machine's own server (/api/access/*) and is not synced; the switch is a shared setting (settings sync group 'access-alerts').
// Both parts read their data each time the group opens (`opened`, a count from AccountGroup in Settings.jsx).

const IP_NOTES = {
  tunnel_no_forward: 'All visits come from the tunnel: the proxy does not pass the real address. Set X-Forwarded-For on the proxy (see the design note).',
  untrusted_forward: 'The proxy sends the visitor’s address, but this server does not use it: no tunnel or public address is set up here.',
};
const KINDS = {
  login_ok: 'Signed in', login_failed: 'Wrong code', new_device: 'New device', new_ip: 'New address', revoked: 'Signed out from Settings', blocked: 'Refused: signed out device',
};
const DAY = 86400000;

const dateText = at => (Number.isFinite(at) ? new Date(at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const shortTime = at => (Number.isFinite(at) ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
// "Just now", "5 min ago", "3 h ago", "2 days ago" within a week, the date after that.
function seenText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t(`${minutes} min ago`);
  if (minutes < 1440) return t(`${Math.round(minutes / 60)} h ago`);
  if (now - at < 7 * DAY) return t(`${Math.round(minutes / 1440)} days ago`);
  return dateText(at);
}
// A visit through the tunnel on this machine shows the loopback address: it is named so, except for this device on this machine itself.
const ipText = device => (device.loopback && !device.current ? `${device.last_ip} ${t('(tunnel)')}` : device.last_ip || '');
const deviceLine = device => [
  `${t('First seen')} ${dateText(device.first_seen)}`,
  `${t('Last seen')} ${seenText(device.last_seen)}`,
  ipText(device),
  device.ips_seen_count > 1 ? t(`${device.ips_seen_count} addresses`) : '',
].filter(Boolean).join(' · ');

// The "more" button of a device row and its menu (like the device rows of Settings → Devices). `actions`: [{ key, className, label, onClick, danger }].
function RowMenu({ device, actions }) {
  const [anchor, setAnchor] = useState(null);
  const menuId = `h5-access-menu-${device.id}`;
  return (
    <>
      <IconButton
        className="h5-access-more" aria-haspopup="menu" aria-controls={anchor ? menuId : undefined} aria-expanded={anchor ? 'true' : 'false'} edge="end"
        onClick={event => setAnchor(event.currentTarget)} {...named(t(`More actions for ${device.name}`))} sx={{ flexShrink: 0 }}
      ><Icon name="taskMore" size={20} /></IconButton>
      <Menu id={menuId} className="h5-access-menu" data-device={device.id} anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        {actions.map(action => (
          <MenuItem key={action.key} className={action.className} onClick={() => { setAnchor(null); action.onClick(); }} sx={action.danger ? { color: 'error.main' } : undefined}>{action.label}</MenuItem>
        ))}
      </Menu>
    </>
  );
}

function DeviceRow({ device, canSignOut, busy, onConfirm, onRename, onSignOut, onForget }) {
  const actions = [{ key: 'rename', className: 'h5-access-rename', label: t('Rename'), onClick: () => onRename(device) }];
  if (canSignOut && !device.current && !device.revoked_at) actions.push({ key: 'revoke', className: 'h5-access-revoke', label: t('Sign out this device'), onClick: () => onSignOut(device), danger: true });
  if (!device.current) actions.push({ key: 'forget', className: 'h5-access-forget', label: t('Forget'), onClick: () => onForget(device), danger: true });
  return (
    <ListItem className="h5-access-device" data-device={device.id} disableGutters divider sx={{ alignItems: 'flex-start', gap: 1, py: 1, minHeight: 56 }}>
      <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, minWidth: 0 }}>
          <Typography component="span" variant="subtitle1" className="h5-access-name" translate="no" sx={{ fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{device.name}</Typography>
          {device.current ? <Pill className="h5-access-current" label={t('This device')} tone="primary" /> : null}
          {device.revoked_at ? <Pill className="h5-access-revoked" label={t('Signed out')} tone="error" /> : null}
        </Box>
        <Typography variant="body2" color="text.secondary" className="h5-access-line" sx={{ overflowWrap: 'anywhere' }}>{deviceLine(device)}</Typography>
        {device.confirmed === false ? (
          <Box className="h5-access-unconfirmed" sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, color: 'warning.main' }}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              <Icon name="warning" size={18} />
              <Typography component="span" variant="body2" color="warning.main">{t('Not confirmed yet')}</Typography>
            </Box>
            <Button className="h5-access-confirm" size="small" disabled={busy} onClick={() => onConfirm(device)} sx={{ [TOUCH]: { minHeight: 44 } }}>{t('It was me')}</Button>
          </Box>
        ) : null}
      </Box>
      <RowMenu device={device} actions={actions} />
    </ListItem>
  );
}

// Rename one device: an empty name goes back to the name the server derives from the browser.
function RenameDialog({ device, onClose, onDone }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(null);
  if (device) last.current = device; // the text stays while the dialog closes
  const shown = last.current;
  useEffect(() => { if (device) { setValue(device.custom_name || device.name || ''); setError(''); setBusy(false); } }, [device]);
  const save = async event => {
    event.preventDefault();
    if (busy || !shown) return;
    const name = value.trim();
    if (name.length > 60 || /[\r\n]/.test(name)) { setError(t('A device name is one line of at most 60 characters.')); return; }
    setBusy(true);
    setError('');
    try {
      await api('POST', `/api/access/devices/${encodeURIComponent(shown.id)}/rename`, { name });
      setBusy(false);
      onDone();
    } catch (failed) { setError(errorText(failed)); setBusy(false); }
  };
  return (
    <Dialog id="h5-access-rename" open={Boolean(device)} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="h5-access-rename-title">
      <Box component="form" autoComplete="off" noValidate onSubmit={event => void save(event)}>
        <DialogTitle id="h5-access-rename-title">{t('Rename device')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Field
            id="h5-access-rename-name" label="Name" value={value} autoFocus disabled={busy} error={Boolean(error)}
            onChange={event => { setValue(event.target.value); setError(''); }} htmlInput={{ maxLength: 60, autoCapitalize: 'sentences', enterKeyHint: 'done' }}
            sx={{ mt: 1 }}
          />
          <Typography variant="body2" color="text.secondary">{t('Leave it empty to use the name taken from the browser.')}</Typography>
          {error ? <DialogError id="h5-access-rename-error">{error}</DialogError> : null}
        </DialogContent>
        <DialogActions>
          <Button id="h5-access-rename-cancel" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
          <Button id="h5-access-rename-save" type="submit" variant="contained" disabled={busy}>{t('Save')}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

// A destructive confirmation (sign out, forget): maxWidth xs, the action in the error colour after Cancel.
function ConfirmDialog({ id, open, title, text, action, busy, error, onClose, onConfirm }) {
  return (
    <Dialog id={id} open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}>
      <DialogTitle id={`${id}-title`} sx={{ overflowWrap: 'anywhere' }}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText id={`${id}-text`} variant="body2">{text}</DialogContentText>
        {error ? <DialogError id={`${id}-error`}>{error}</DialogError> : null}
      </DialogContent>
      <DialogActions>
        <Button id={`${id}-cancel`} disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
        <Button id={`${id}-confirm`} color="error" disabled={busy} onClick={onConfirm}>{action}</Button>
      </DialogActions>
    </Dialog>
  );
}

function EventRow({ event }) {
  const what = [t(KINDS[event.kind] || event.kind || ''), event.detail ? t(event.detail) : ''].filter(Boolean).join(' · ');
  return (
    <ListItem className="h5-access-event" data-event={event.id} data-kind={event.kind} disableGutters divider sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25, py: 0.75 }}>
      <Typography variant="body2" className="h5-access-event-what" sx={{ overflowWrap: 'anywhere' }}>{what}</Typography>
      <Typography variant="caption" color="text.secondary" className="h5-access-event-meta" sx={{ overflowWrap: 'anywhere' }}>
        {shortTime(event.at)}{' · '}<span translate="no">{event.device_name || t('Unknown device')}</span>{event.ip ? ` · ${event.ip}` : ''}
      </Typography>
    </ListItem>
  );
}

// The device list and the recent events (`#h5-sec-access-devices`). In a linked device's tab: the note that this part is set on that device's own page.
export function AccessDevicesSection({ opened }) {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null); // { list, more }
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [renaming, setRenaming] = useState(null);
  const [asking, setAsking] = useState(null); // { kind: 'revoke' | 'forget', device }
  const [askError, setAskError] = useState('');
  const load = async () => {
    try {
      const [devices, recent] = await Promise.all([api('GET', '/api/access/devices'), api('GET', '/api/access/events?limit=30')]);
      setData(devices);
      setEvents({ list: (recent && recent.events) || [], more: Boolean(recent && recent.more) });
    } catch (error) { say(errorText(error), true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const more = async () => {
    const list = events ? events.list : [];
    if (!list.length) return;
    setBusy(true);
    try {
      const next = await api('GET', `/api/access/events?before=${encodeURIComponent(list[list.length - 1].id)}&limit=30`);
      setEvents({ list: [...list, ...((next && next.events) || [])], more: Boolean(next && next.more) });
    } catch (error) { say(errorText(error), true); } finally { setBusy(false); }
  };
  const confirmDevice = async device => {
    setBusy(true);
    say('');
    try { await api('POST', `/api/access/devices/${encodeURIComponent(device.id)}/confirm`); await load(); } catch (error) { say(errorText(error), true); } finally { setBusy(false); }
  };
  const ask = (kind, device) => { setAskError(''); setAsking({ kind, device }); };
  const answer = async () => {
    if (!asking) return;
    const { kind, device } = asking;
    setBusy(true);
    setAskError('');
    try {
      const path = `/api/access/devices/${encodeURIComponent(device.id)}`;
      if (kind === 'revoke') await api('POST', `${path}/revoke`); else await api('DELETE', path);
      setAsking(null);
      say(kind === 'revoke' ? 'Signed out.' : 'Forgotten.');
      await load();
    } catch (error) { setAskError(errorText(error)); } finally { setBusy(false); }
  };
  const devices = (data && data.devices) || [];
  const canSignOut = Boolean(data && data.can_sign_out);
  const shownAsk = asking || { kind: 'revoke', device: { name: '' } };
  return (
    <Section id="access-devices" title="Devices and sign-ins" aside={<ScopeLabel id="access-devices" />}>
      <LocalOnly id="h5-access-devices-remote">
        <Hint id="h5-access-devices-hint">{t('Every browser, phone and Mac app that uses this service, with the address it came from. Kept on this machine only.')}</Hint>
        {data && !canSignOut ? <Hint id="h5-access-local-hint">{t('Local access only: there is no login, so devices are only logged and nothing can be signed out.')}</Hint> : null}
        {!data ? <Hint id="h5-access-devices-loading">{t('Loading…')}</Hint> : devices.length ? (
          <List id="h5-access-devices" aria-labelledby="h5-sec-access-devices-title" disablePadding>
            {devices.map(device => (
              <DeviceRow
                key={device.id} device={device} canSignOut={canSignOut} busy={busy} onConfirm={item => void confirmDevice(item)}
                onRename={setRenaming} onSignOut={item => ask('revoke', item)} onForget={item => ask('forget', item)}
              />
            ))}
          </List>
        ) : <Hint id="h5-access-devices-empty">{t('No devices yet.')}</Hint>}
        {data && IP_NOTES[data.ip_note] ? <Typography id="h5-access-ip-note" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{t(IP_NOTES[data.ip_note])}</Typography> : null}
        <Feedback id="h5-access-devices-feedback" feedback={feedback} />
        <SubHeading id="h5-access-events-title" level={4}>{t('Recent events')}</SubHeading>
        {!events ? <Hint>{t('Loading…')}</Hint> : events.list.length ? (
          <List id="h5-access-events" aria-labelledby="h5-access-events-title" disablePadding>
            {events.list.map(event => <EventRow key={event.id} event={event} />)}
          </List>
        ) : <Hint id="h5-access-events-empty">{t('No events yet.')}</Hint>}
        {events && events.more ? <Button id="h5-access-events-more" disabled={busy} onClick={() => void more()}>{t('Load more')}</Button> : null}
        <RenameDialog device={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); void load(); }} />
        <ConfirmDialog
          id={shownAsk.kind === 'revoke' ? 'h5-access-revoke-dialog' : 'h5-access-forget-dialog'} open={Boolean(asking)} busy={busy} error={askError}
          title={shownAsk.kind === 'revoke' ? t(`Sign out ${shownAsk.device.name}?`) : t(`Forget ${shownAsk.device.name}?`)}
          text={shownAsk.kind === 'revoke' ? t(`${shownAsk.device.name} must log in again with a code. Its open terminals close.`) : t('Its events are deleted too. If it visits again it shows up as a new device.')}
          action={shownAsk.kind === 'revoke' ? t('Sign out') : t('Forget')}
          onClose={() => setAsking(null)} onConfirm={() => void answer()}
        />
      </LocalOnly>
    </Section>
  );
}

// The switch "Alert me about new devices" (`#h5-sec-access-alerts`): this machine's own setting (/api/access/settings), copied to the linked
// devices by the settings sync, so it is in the Shared tab.
export function AccessAlertsSection({ opened }) {
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track, clearSync] = useSyncAfterSave('access-alerts');
  useEffect(() => {
    if (!opened) return;
    api('GET', '/api/access/settings').then(data => setEnabled(Boolean(data && data.access_alerts)), error => say(errorText(error), true));
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- reads only
  const change = async on => {
    setBusy(true);
    say('');
    clearSync();
    try {
      const data = await api('PUT', '/api/access/settings', { access_alerts: on });
      setEnabled(Boolean(data && data.access_alerts));
      void track();
    } catch (error) { say(errorText(error), true); } finally { setBusy(false); }
  };
  return (
    <Section id="access-alerts">
      <SwitchRow
        inputId="h5-access-alerts" label={t('Alert me about new devices')} checked={Boolean(enabled)} disabled={enabled === null || busy} onChange={on => void change(on)}
        secondary={t('A T-Attention task asks you when a new device signs in, a known device signs in from a far address, or a code is entered wrong 5 times in 10 minutes. At most one alert per device per hour.')}
        aside={<ScopeLabel id="access-alerts" scope="shared" />}
      />
      <Feedback id="h5-access-alerts-feedback" feedback={feedback} />
      <SyncNote id="h5-access-alerts-sync" note={synced} />
    </Section>
  );
}

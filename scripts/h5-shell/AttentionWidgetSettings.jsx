import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Feedback, Hint, failure, useFeedback } from './Form.jsx';
import TextField from './TextField.jsx';
import { registerAttentionSettings } from './attention-slots.mjs';
import { ScopeLabel, SyncNote, useSyncAfterSave } from './ScopeLabel.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';

// The "Desktop window (macOS)" part of the Settings group "T-Attention": the switch of the native floating window (services/attention-widget.js), the
// language it shows and a status line. GET / PUT /api/attention/widget/settings { enabled, language, platform_supported, swiftc, running, building,
// last_error }. Read each time the group opens (`opened` goes up), saved at once without Save. An older server answers 404: nothing is drawn.
// See "T-Attention desktop window (macOS)" in DESIGN.md.
const SETTINGS_URL = '/api/attention/widget/settings';
const INPUT_INSIDE = { left: 0, width: '100%' }; // MUI's hidden input of the switch stays on the thumb (see PeerFs.jsx)
const LANGUAGES = [['auto', 'Same as this page'], ['en', 'English'], ['zh', 'Chinese']];
const POLL_MS = 3000; // while a build runs, the status is read again

// The status line: what is true now, in the order a person needs it.
export function widgetStatus(setting) {
  if (!setting.platform_supported) return { text: 'Not supported on this system', error: false };
  if (!setting.swiftc) return { text: 'Xcode command line tools needed: xcode-select --install', error: true };
  if (!setting.enabled) return { text: 'Off', error: false };
  if (setting.running) return { text: 'Running', error: false };
  if (setting.building) return { text: 'Building the window…', error: false };
  if (setting.last_error) return { text: setting.last_error, error: true };
  return { text: 'Not running. Turn the switch off and on to start it again.', error: false };
}

// The window of the device chosen in "Settings for" (DeviceTarget.jsx): its switch and status are read and saved there. The language is one setting
// for all linked devices and is always saved here (settings sync copies it); a linked device takes only the switch (routes/device-settings.js).
function WidgetSettings(props) {
  const device = useDeviceTarget();
  return <WidgetPart key={device.key} {...props} call={device.api} remote={device.remote} name={device.name} />;
}
function WidgetPart({ opened, call, remote, name }) {
  const [setting, setSetting] = useState(null); // null until read; { missing: true } on an older server
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track] = useSyncAfterSave('widget-language');
  const timer = useRef(null);
  const show = data => setSetting({ enabled: data.enabled !== false, language: data.language || 'auto', platform_supported: Boolean(data.platform_supported), swiftc: Boolean(data.swiftc), running: Boolean(data.running), building: Boolean(data.building), last_error: data.last_error || null });
  const load = async () => {
    try { show(await call('GET', SETTINGS_URL)); }
    catch (error) {
      if (error.status === 404) { setSetting({ missing: true }); return; }
      say(failure(error), true);
    }
  };
  useEffect(() => { if (opened) { say(''); void load(); } }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  // While the window is being built, the status is read again until the build ends.
  useEffect(() => {
    clearTimeout(timer.current);
    if (setting && setting.building) timer.current = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer.current);
  }, [setting]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const save = async patch => {
    setBusy(true);
    setSetting(current => ({ ...current, ...patch }));
    try {
      if (remote && patch.language !== undefined) {
        // Saved on this device and copied by the sync; the switch and the status shown stay the chosen device's.
        const saved = await api('PUT', SETTINGS_URL, { language: patch.language });
        setSetting(current => ({ ...current, language: (saved && saved.language) || patch.language }));
      } else show(await call('PUT', SETTINGS_URL, patch));
      say('Saved');
      if (patch.language !== undefined) void track();
    }
    catch (error) { say(failure(error), true); await load(); }
    finally { setBusy(false); }
  };
  if (!setting) return <span id="h5-attention-widget" hidden />;
  if (setting.missing) return <span id="h5-attention-widget" hidden />;
  const label = t('Desktop window (macOS)');
  const status = widgetStatus(setting);
  const usable = setting.platform_supported;
  return (
    <Box id="h5-attention-widget" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <FormControlLabel
        sx={{ m: 0, alignSelf: 'flex-start', gap: 0.5 }} label={label}
        control={<Switch size="small" checked={setting.enabled} disabled={busy || !usable} onChange={event => void save({ enabled: event.target.checked })} slotProps={{ input: { id: 'h5-attention-widget-enabled', 'aria-label': label, style: INPUT_INSIDE } }} />}
      />
      {/* The switch is this Mac's own; the language of the window is one setting for all linked devices. */}
      <ScopeLabel id="widget-enabled" subject="On or off" sx={{ alignSelf: 'flex-start' }} />
      <Hint>{remote ? t(`A small window that stays above other windows on ${name} and shows the tasks that need you, from that machine and its connected devices.`) : t('A small window that stays above other windows on this Mac and shows the tasks that need you, from this machine and the connected devices.')}</Hint>
      <TextField
        id="h5-attention-widget-language" select label={t('Window language')} size="small" fullWidth value={setting.language} disabled={busy || !usable}
        onChange={event => void save({ language: event.target.value })} slotProps={{ select: { native: true } }}
      >
        {LANGUAGES.map(([value, text]) => <option key={value} value={value}>{t(text)}</option>)}
      </TextField>
      <ScopeLabel id="widget-language" scope="shared" subject="Window language" sx={{ alignSelf: 'flex-start' }} />
      <Typography id="h5-attention-widget-status" variant="body2" color={status.error ? 'error' : 'text.secondary'} sx={{ overflowWrap: 'anywhere' }}>
        {`${t('Status')}: ${t(status.text)}`}
      </Typography>
      <Feedback id="h5-attention-widget-feedback" feedback={feedback} />
      <SyncNote id="h5-attention-widget-sync" note={synced} />
    </Box>
  );
}

registerAttentionSettings({ id: 'widget', order: 35, Component: WidgetSettings });

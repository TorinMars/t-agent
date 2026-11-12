import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import { t } from './common.jsx';
import { Feedback, Hint, Section, failure, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';

// The peer file access switch of this Engine ("Peer file access" in DESIGN.md), a part of the Devices group (`#h5-sec-peer-fs`): whether the Claude
// and Codex sessions started here get the read-only `t-agent-peers` tools, and whether linked devices may read this Engine's files.
// It is read each time the group opens (`opened` goes up) and saved at once, without Save. An older server answers 404: nothing is drawn.
// The switch sits on the left edge of the group: MUI's hidden input is three thumbs wide and starts one thumb to the left, so it would
// stick out of the sheet. It is kept on the thumb; the whole label is the click target anyway.
const INPUT_INSIDE = { left: 0, width: '100%' };

// The switch of the device chosen in "Settings for" (DeviceTarget.jsx): this one, or a linked one through the link.
export function PeerFsSwitch(props) {
  const device = useDeviceTarget();
  return <PeerFsPart key={device.key} {...props} call={device.api} />;
}
function PeerFsPart({ opened, call }) {
  const [setting, setSetting] = useState({ loaded: false, supported: true, enabled: false });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try {
      const data = await call('GET', '/api/peer-fs/settings');
      setSetting({ loaded: true, supported: true, enabled: Boolean(data && data.enabled) });
      say('');
    } catch (error) {
      if (error.status === 404) { setSetting({ loaded: true, supported: false, enabled: false }); say(''); return; }
      say(failure(error), true);
    }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const change = async enabled => {
    setBusy(true);
    setSetting(current => ({ ...current, enabled }));
    try {
      const saved = await call('PUT', '/api/peer-fs/settings', { enabled });
      setSetting(current => ({ ...current, enabled: Boolean(saved && saved.enabled) }));
      say('Saved');
    } catch (error) {
      say(failure(error), true);
      try { // show what is really in effect
        const data = await call('GET', '/api/peer-fs/settings');
        setSetting(current => ({ ...current, enabled: Boolean(data && data.enabled) }));
      } catch { setSetting(current => ({ ...current, enabled: !enabled })); }
    } finally { setBusy(false); }
  };
  if (!setting.supported) return <span id="h5-peer-fs" hidden />;
  const label = t('Sessions can read files on linked devices');
  return (
    <Section id="peer-fs">
      <Box id="h5-peer-fs" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <FormControlLabel
          sx={{ m: 0, alignSelf: 'flex-start', gap: 0.5 }} label={label}
          control={<Switch size="small" checked={setting.enabled} disabled={!setting.loaded || busy} onChange={event => void change(event.target.checked)} slotProps={{ input: { id: 'h5-peer-fs-enabled', 'aria-label': label, style: INPUT_INSIDE } }} />}
        />
        <ScopeLabel id="peer-fs" sx={{ alignSelf: 'flex-start' }} />
        <Hint>{t('Claude and Codex sessions started here get tools to read files on linked devices, and linked devices can read this device’s files the same way. Read only: only the home folder, and sensitive files such as ~/.ssh and .env files are left out. Applies to sessions started after the change.')}</Hint>
        <Feedback id="h5-peer-fs-feedback" feedback={feedback} />
      </Box>
    </Section>
  );
}

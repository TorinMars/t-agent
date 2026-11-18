import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { t } from './common.jsx';
import { Feedback, Section, SwitchRow, failure, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';

// The peer file access switch of this Engine ("Peer file access" in docs/design/peer-file-access.md), a part of the Devices group (`#h5-sec-peer-fs`): whether the Claude
// and Codex sessions started here get the read-only `t-agent-peers` tools, and whether linked devices may read this Engine's files.
// It is read each time the group opens (`opened` goes up) and saved at once, without Save: a switch row (Form.jsx SwitchRow), a card of its own.
// An older server answers 404: nothing is drawn.

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
  return (
    <Section id="peer-fs">
      <Box id="h5-peer-fs" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <SwitchRow
          inputId="h5-peer-fs-enabled" label={t('Sessions can read files on linked devices')} checked={setting.enabled} disabled={!setting.loaded || busy} onChange={on => void change(on)}
          secondary={t('Sessions started here can read files on linked devices, and those devices can read this one’s the same way. Read only, home folder only; sensitive files such as ~/.ssh and .env are left out. Applies to sessions started after the change.')}
          aside={<ScopeLabel id="peer-fs" />}
        />
        <Feedback id="h5-peer-fs-feedback" feedback={feedback} />
      </Box>
    </Section>
  );
}

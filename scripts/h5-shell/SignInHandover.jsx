import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Feedback, Section, SwitchRow, failure, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';
import { handoverError, signInOn } from './sign-in-handover.mjs';

// One login for linked engines in Settings → Devices ("One login for linked engines" in docs/design/failover-and-one-login.md):
// - `SignInSwitch`: whether the device of the chosen tab accepts sign-in hand-overs from its linked devices (device scope, on by default; a linked
//   device's switch through /api/device-settings/<id>/sign-in-handover/settings). A part of its own (`#h5-sec-sign-in`), like the file access switch.
// - `SignInOnButton`: "Sign in on K01 too" on the row of each linked device that can take one: signs this browser in there now, in a new tab, so the
//   browser holds that device's login when this one is down. Never done without the person's click (no hidden sign-in in the background).

export function SignInSwitch(props) {
  const device = useDeviceTarget();
  return <SignInPart key={device.key} {...props} call={device.api} />;
}
function SignInPart({ opened, call }) {
  const [setting, setSetting] = useState({ loaded: false, supported: true, accept: true });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try {
      const data = await call('GET', '/api/sign-in-handover/settings');
      setSetting({ loaded: true, supported: true, accept: !(data && data.accept === false) });
      say('');
    } catch (error) {
      if (error.status === 404 || error.status === 501) { setSetting({ loaded: true, supported: false, accept: false }); say(''); return; }
      say(failure(error), true);
    }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const change = async accept => {
    setBusy(true);
    setSetting(current => ({ ...current, accept }));
    try {
      const saved = await call('PUT', '/api/sign-in-handover/settings', { accept });
      setSetting(current => ({ ...current, accept: !(saved && saved.accept === false) }));
      say('Saved');
    } catch (error) {
      say(failure(error), true);
      setSetting(current => ({ ...current, accept: !accept }));
    } finally { setBusy(false); }
  };
  if (!setting.supported) return <span id="h5-sign-in" hidden />;
  return (
    <Section id="sign-in">
      <Box id="h5-sign-in" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <SwitchRow
          inputId="h5-sign-in-accept" label={t('Accept sign-in from linked devices')} checked={setting.accept} disabled={!setting.loaded || busy} onChange={on => void change(on)}
          secondary={t('A browser signed in on a linked device can open this one without the code, when that login used a code too. Each hand-over works once, within a minute. Off: every login here needs the code.')}
          aside={<ScopeLabel id="sign-in" />}
        />
        <Feedback id="h5-sign-in-feedback" feedback={feedback} />
      </Box>
    </Section>
  );
}

// `peer`: { instance_id, name, online, supported, accepting, addresses } of GET /api/sign-in-handover/peers. `onDone(message, error)`: the row's line.
export function SignInOnButton({ peer, name, pagePath, onDone }) {
  const [busy, setBusy] = useState(false);
  if (!peer || peer.supported !== true) return null;
  if (peer.accepting === false) {
    return <Typography className="h5-engine-sign-in-off" variant="caption" color="text.secondary">{t(`${name} does not accept sign-in from linked devices`)}</Typography>;
  }
  const run = async () => {
    // Opened inside the click: a window opened after the requests would be blocked.
    let win = null;
    try { win = window.open('', '_blank'); } catch { win = null; }
    setBusy(true);
    try {
      await signInOn({ peer, api, win, pagePath, fetchImpl: (url, options) => fetch(url, options), navigate: url => location.assign(url) });
      onDone(t(`Signed in on ${name} in a new tab`), false);
    } catch (error) {
      const code = error && error.message;
      onDone(t(handoverError(code, name) || `${t('Failed')}: ${code}`), true);
    } finally { setBusy(false); }
  };
  return (
    <Box sx={{ display: 'flex', mt: 0.5, ml: -1 }}>
      <Button className="h5-engine-sign-in" data-engine={peer.instance_id} size="small" disabled={busy || !peer.online || !peer.addresses.length} onClick={() => void run()}>
        {t(`Sign in on ${name} too`)}
      </Button>
    </Box>
  );
}

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Feedback, Field, Group, Hint, failure, useFeedback } from './Form.jsx';
import { BASE } from './attention-feed.mjs';
import { attentionSettingsSlots } from './attention-slots.mjs';

// The "T-Attention" group of the settings sheet: the reminders of this page (sound, system notifications; remembered in this browser) and the
// CLI tokens (`Authorization: Bearer tatt_...` for the `t-attention` CLI and the listener plugins; only /api/attention* accepts them).
// The token endpoints take the browser session only. A new token is shown once, here, and never again.
// Below them: the components other parts registered (attention-slots.mjs; for example the notifier settings).
const when = value => { const at = Date.parse(value || ''); return Number.isFinite(at) ? new Date(at).toLocaleString() : ''; };

function TokenList({ opened }) {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null); // { name, token } shown once
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const codeNode = useRef(null);
  const load = async () => {
    try { const data = await api('GET', `${BASE}/tokens`); setTokens(Array.isArray(data && data.tokens) ? data.tokens : []); }
    catch (error) { setTokens([]); say(failure(error), true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  const create = async () => {
    const label = name.trim();
    if (!label) { say('Enter a name for the token', true); return; }
    setBusy(true);
    try {
      const result = await api('POST', `${BASE}/tokens`, { name: label });
      setCreated({ name: result.name || label, token: result.token });
      setCopyLabel('Copy');
      setName('');
      say('Token created. Copy it now: it is shown only once.');
      await load();
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const revoke = async token => {
    if (!confirm(t('Revoke this token? Programs that use it stop working at once.'))) return;
    try { await api('DELETE', `${BASE}/tokens/${encodeURIComponent(token.id)}`); say('Token revoked'); await load(); }
    catch (error) { say(failure(error), true); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(created.token); setCopyLabel('Copied'); }
    catch {
      const range = document.createRange();
      range.selectNodeContents(codeNode.current);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setCopyLabel('Press and hold to copy');
    }
  };
  return (
    <>
      <Typography variant="subtitle2" component="h3">{t('CLI tokens')}</Typography>
      <Hint>{t('The t-attention command and the listener plugins (for example Claude Code hooks) sign in with a token. A token can only read and change T-Attention tasks.')}</Hint>
      <Box id="h5-attention-tokens" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {tokens && tokens.length ? tokens.map(token => (
          <Paper key={token.id} variant="outlined" className="h5-attention-token" data-id={token.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Box component="strong" sx={{ overflowWrap: 'anywhere' }}>{token.name}</Box>
              <Typography variant="caption" component="small" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                {`${t('Created')} ${when(token.created_at)} · ${token.last_used_at ? `${t('Last used')} ${when(token.last_used_at)}` : t('Never used')}`}
              </Typography>
            </Box>
            {token.revoked_at ? <Typography variant="caption" color="text.secondary" className="h5-attention-token-revoked">{t('Revoked')}</Typography>
              : <Button size="small" className="h5-attention-token-revoke" onClick={() => void revoke(token)}>{t('Revoke')}</Button>}
          </Paper>
        )) : tokens ? <Hint>{t('No tokens created yet')}</Hint> : null}
      </Box>
      <Field id="h5-attention-token-name" label="Token name" value={name} onChange={event => setName(event.target.value)} placeholder={t('e.g. laptop claude')} htmlInput={{ maxLength: 60 }} />
      <Button id="h5-attention-token-create" variant="contained" disabled={busy} onClick={() => void create()}>{t('Create token')}</Button>
      {created ? (
        <Paper id="h5-attention-token-created" variant="outlined" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1 }}>
          <code id="h5-attention-token-value" ref={codeNode} translate="no" style={{ fontSize: 13, overflowWrap: 'anywhere', wordBreak: 'break-all', userSelect: 'all' }}>{created.token}</code>
          <Button id="h5-attention-token-copy" size="small" variant="outlined" onClick={() => void copy()} sx={{ flex: '0 0 auto' }}>{t(copyLabel)}</Button>
        </Paper>
      ) : null}
      <Feedback id="h5-attention-token-feedback" feedback={feedback} />
    </>
  );
}

function Reminders({ ui, prefs, setPrefs }) {
  const [feedback, say] = useFeedback();
  const notify = async on => {
    const next = await ui.actions.attentionSetNotify(on);
    setPrefs(next);
    if (on && next.permission === 'denied') say('The browser blocks notifications for this page. Allow them in the browser’s site settings.', true);
    else if (on && next.permission === 'unsupported') say('This browser has no system notifications', true);
    else say('');
  };
  const state = prefs.permission === 'unsupported' ? 'This browser has no system notifications'
    : prefs.notify ? 'System notifications are on' : prefs.permission === 'denied' ? 'The browser blocks notifications for this page' : 'System notifications are off';
  return (
    <>
      <Typography variant="subtitle2" component="h3">{t('Reminders on this device')}</Typography>
      <Hint>{t('When a task starts to need you, fails or is ready for review, this page shows a notice. A change you make on this page gives no reminder.')}</Hint>
      <FormControlLabel
        control={<Checkbox checked={prefs.sound} onChange={event => { ui.actions.attentionSetSound(event.target.checked); setPrefs(ui.actions.attentionPrefs()); }} slotProps={{ input: { id: 'h5-attention-sound' } }} />}
        label={t('Play a short sound')}
      />
      <Hint id="h5-attention-notify-state">{t(state)}</Hint>
      {prefs.notify ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button id="h5-attention-notify-test" variant="outlined" onClick={() => { if (!ui.actions.attentionTestNotify()) say('Could not show a notification', true); }}>{t('Send a test notification')}</Button>
          <Button id="h5-attention-notify-off" variant="outlined" color="inherit" onClick={() => void notify(false)}>{t('Turn off system notifications')}</Button>
        </Box>
      ) : prefs.permission === 'unsupported' ? null : (
        <Button id="h5-attention-notify-on" variant="contained" onClick={() => void notify(true)}>{t('Enable system notifications')}</Button>
      )}
      <Feedback id="h5-attention-notify-feedback" feedback={feedback} />
    </>
  );
}

export function AttentionSettings({ ui }) {
  const [prefs, setPrefs] = useState(() => ui.actions.attentionPrefs ? ui.actions.attentionPrefs() : { sound: true, notify: false, permission: 'unsupported' });
  const [opened, setOpened] = useState(0);
  const open = () => {
    if (ui.actions.attentionPrefs) setPrefs(ui.actions.attentionPrefs());
    setOpened(count => count + 1);
  };
  return (
    <Group id="attention" title="T-Attention" onOpen={open}>
      <Reminders ui={ui} prefs={prefs} setPrefs={setPrefs} />
      <TokenList opened={opened} />
      {/* SLOT: the settings of other T-Attention parts (attention-slots.mjs, e.g. NotifierSettings). Nothing is drawn when none is registered. */}
      {attentionSettingsSlots().map(({ id, Component }) => <Box key={id} className="h5-attention-slot" data-slot={id} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}><Component ui={ui} /></Box>)}
    </Group>
  );
}

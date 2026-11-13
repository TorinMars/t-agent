import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { api, errorText, t } from './common.jsx';
import { Feedback, Field, Group, Hint, failure, useFeedback } from './Form.jsx';
import TextField from './TextField.jsx';
import { BASE } from './attention-feed.mjs';
import { attentionSettingsSlots } from './attention-slots.mjs';
import { AttentionGuide } from './AttentionGuide.jsx';
import { ScopeLabel, ScopedHeading, SyncNote, useSyncAfterSave } from './ScopeLabel.jsx';
import { InTab, LocalOnly, useSettingsTab } from './DeviceTarget.jsx';
import { partShown } from './settings-tabs.mjs';

// The "T-Attention" group of the settings sheet: the reminders of this page (the in-page notice and the sound; remembered in this browser) and the
// CLI tokens (`Authorization: Bearer tatt_...` for the `t-attention` CLI and the listener plugins; only /api/attention* accepts them).
// The token endpoints take the browser session only. A new token is shown once, here, and never again.
// Order: the setup guide, the reminders, the components other parts registered (attention-slots.mjs: the plugin list with the notifiers, then the agent
// skill), the AI summary, the CLI tokens. With the tabs of the sheet each is drawn in the tab that holds it (settings-tabs.mjs); a slot that names its
// `part` is drawn only in that part's tabs, the others split their own controls (the plugin list, the desktop window).
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
      <ScopedHeading label={<ScopeLabel />}><Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700, mt: 1 }}>{t('CLI tokens')}</Typography></ScopedHeading>
      {/* A new token is shown once: it never crosses a link, so another device's tokens are made on its own page. */}
      <LocalOnly id="h5-attention-tokens-remote">
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
      </LocalOnly>
    </>
  );
}

// The AI summary (off by default): GET / PUT /api/attention/settings/summary { enabled, provider, model, providers }. The providers are the translation
// providers and their saved keys (Settings → Voice and translation → Translation): the server sends `providers` as a list [{ id, label, hasApiKey, model }] (never a key);
// a map { id: { label, hasApiKey } } and GET /api/translate/config (when `providers` is missing) are read too. A refused save shows the server's
// message (409 SUMMARY_PROVIDER_NOT_CONFIGURED: no key saved for that provider).
const providerMap = list => {
  if (Array.isArray(list)) return Object.fromEntries(list.filter(entry => entry && typeof entry.id === 'string').map(entry => [entry.id, entry]));
  return list && typeof list === 'object' ? list : null;
};
function SummarySettings({ opened }) {
  const [form, setForm] = useState({ enabled: false, provider: '', model: '' });
  const [providers, setProviders] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track] = useSyncAfterSave('attention-summary');
  const load = async () => {
    try {
      const data = (await api('GET', `${BASE}/settings/summary`)) || {};
      let list = providerMap(data.providers);
      if (!list) { try { list = providerMap(((await api('GET', '/api/translate/config')) || {}).providers) || {}; } catch { list = {}; } }
      setProviders(list);
      setForm({ enabled: Boolean(data.enabled), provider: data.provider || Object.keys(list)[0] || '', model: data.model || '' });
      setLoaded(true);
      say('');
    } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  const save = async () => {
    setBusy(true);
    try { await api('PUT', `${BASE}/settings/summary`, { enabled: form.enabled, provider: form.provider, model: form.model.trim() }); await load(); say('Saved'); void track(); }
    catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setBusy(false); }
  };
  const ids = Object.keys(providers);
  return (
    <>
      <ScopedHeading label={<ScopeLabel id="attention-summary" scope="shared" />}><Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700, mt: 1 }}>{t('AI summary')}</Typography></ScopedHeading>
      <FormControlLabel
        control={<Checkbox checked={form.enabled} disabled={!loaded} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} slotProps={{ input: { id: 'h5-attention-summary-enabled' } }} />}
        label={t('Write a 3-line summary when a task needs you or is ready for review')}
      />
      <TextField id="h5-attention-summary-provider" select label={t('Provider')} size="small" fullWidth value={form.provider} disabled={!loaded} onChange={event => setForm(current => ({ ...current, provider: event.target.value }))} slotProps={{ select: { native: true } }}>
        {ids.map(id => <option key={id} value={id}>{`${(providers[id] && providers[id].label) || id}${providers[id] && providers[id].hasApiKey === false ? ` (${t('no key saved')})` : ''}`}</option>)}
      </TextField>
      <Field id="h5-attention-summary-model" label="Model (optional)" value={form.model} disabled={!loaded} onChange={event => setForm(current => ({ ...current, model: event.target.value }))} placeholder={t('The provider’s default model')} />
      <Hint id="h5-attention-summary-privacy">{t('When this is on, the task’s goal, latest prompt, last reply, pending question, changed file names and the last messages of the session are sent to the chosen provider, with the translation key saved under Voice and translation. Nothing is sent while it is off.')}</Hint>
      <Button id="h5-attention-summary-save" variant="contained" disabled={busy || !loaded} onClick={() => void save()}>{t('Save')}</Button>
      <Feedback id="h5-attention-summary-feedback" feedback={feedback} />
      <SyncNote id="h5-attention-summary-sync" note={synced} />
    </>
  );
}

// The reminders of this page: the in-page notice and the sound. There are no system notifications; reminders away from the page come from the
// notifiers set up under Plugins (Telegram).
function Reminders({ ui, prefs, setPrefs }) {
  return (
    <>
      <ScopedHeading label={<ScopeLabel follow={false} />}><Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700, mt: 1 }}>{t('Reminders on this device')}</Typography></ScopedHeading>
      <Hint>{t('When a task starts to need you, fails or is ready for review, this page shows a notice. A change you make on this page gives no reminder.')}</Hint>
      <FormControlLabel
        control={<Checkbox checked={prefs.sound} onChange={event => { ui.actions.attentionSetSound(event.target.checked); setPrefs(ui.actions.attentionPrefs()); }} slotProps={{ input: { id: 'h5-attention-sound' } }} />}
        label={t('Play a short sound')}
      />
    </>
  );
}

// `request`: { section, seq } from `ui.actions.openSettings('attention')` (settings-target.mjs) opens the group from outside.
export function AttentionSettings({ ui, request = null }) {
  const [prefs, setPrefs] = useState(() => ui.actions.attentionPrefs ? ui.actions.attentionPrefs() : { sound: true });
  const [opened, setOpened] = useState(0);
  const { scope } = useSettingsTab();
  const open = () => {
    if (ui.actions.attentionPrefs) setPrefs(ui.actions.attentionPrefs());
    setOpened(count => count + 1);
  };
  return (
    <Group id="attention" title="T-Attention" onOpen={open} request={request}>
      {/* The first-run guide, or its "Show setup guide" button once it is closed or done (AttentionGuide.jsx). */}
      <InTab part="attention-guide">
        <ScopeLabel subject="Setup guide" sx={{ alignSelf: 'flex-start' }} />
        <LocalOnly id="h5-guide-settings-remote"><AttentionGuide ui={ui} place="settings" active={opened} /></LocalOnly>
      </InTab>
      <InTab part="reminders"><Reminders ui={ui} prefs={prefs} setPrefs={setPrefs} /></InTab>
      {/* SLOT: the settings of other T-Attention parts (attention-slots.mjs: the plugin list, then the agent skill). Nothing is drawn when none is registered. */}
      {attentionSettingsSlots().filter(slot => !slot.part || partShown(slot.part, scope)).map(({ id, Component }) => <Box key={id} className="h5-attention-slot" data-slot={id} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}><Component ui={ui} opened={opened} /></Box>)}
      <InTab part="attention-summary"><SummarySettings opened={opened} /></InTab>
      <InTab part="cli-tokens"><TokenList opened={opened} /></InTab>
    </Group>
  );
}

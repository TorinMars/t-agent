import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Slide from '@mui/material/Slide';
import TextField from './TextField.jsx';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { api, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { NAV_WIDTH } from './columns.mjs';
import { DevicesGroup } from './Engines.jsx';
import { AttentionSettings } from './AttentionSettings.jsx';
import { AgentSkillsSection } from './AgentSkillsSettings.jsx';
import { BrowserExtSection } from './BrowserExtSettings.jsx';
import { BrowserSitesSection } from './BrowserSites.jsx';
import { Actions, Feedback, Field, Group, GroupShown, Hint, Section, SettingsNav, SwitchRow, failure, useFeedback } from './Form.jsx';
import { GROUPS, groupInfo, settingsTarget } from './settings-target.mjs';
import { groupShown, tabForTarget } from './settings-tabs.mjs';
import { ScopeLabel, SyncNote, refreshSettingsSync, useSyncAfterSave } from './ScopeLabel.jsx';
import { InTab, LocalOnly, chooseTab, refreshDeviceTargets, useDeviceTarget, useSettingsTab } from './DeviceTarget.jsx';
import { SettingsTabs } from './SettingsTabs.jsx';
import { UsageDataGroup } from './UsageData.jsx';

// The address this page was opened at, to come back to after a login or a switch: `/` or `/h5` (an iPhone Home Screen app starts at /h5).
const pagePath = () => (/^\/h5(\/|$)/.test(location.pathname) ? '/h5' : '/');

const OSS_FIELDS = [
  ['region', 'Region (e.g. oss-cn-hangzhou)'], ['bucket', 'Bucket'], ['accessKeyId', 'AccessKey ID'],
  ['accessKeySecret', 'AccessKey Secret'], ['prefix', 'Object path prefix'], ['publicBaseUrl', 'Public HTTPS address (optional)'],
];
// A part of a group reads its data each time the group opens: `opened` counts the openings (0 before the first one).
const useOnOpen = (opened, load) => useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads

// The working directory of the device whose tab is chosen (DeviceTarget.jsx): this one, or a linked one through the link.
function WorkdirSection(props) {
  const device = useDeviceTarget();
  return <WorkdirPart key={device.key} {...props} call={device.api} />;
}
function WorkdirPart({ opened, call }) {
  const [value, setValue] = useState('');
  const known = useRef({ saved: '', custom: null });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try {
      const user = await call('GET', '/auth/me');
      known.current = { saved: user.work_dir || user.effective_work_dir || '', custom: user.work_dir || null };
      setValue(known.current.saved);
      say('');
    } catch (error) { say(failure(error), true); }
  };
  const save = async () => {
    const entered = value.trim();
    // An unchanged default path keeps inheriting the default; clearing the field restores it.
    const work_dir = entered === known.current.saved ? known.current.custom : entered || null;
    setBusy(true);
    try { await call('PUT', '/auth/settings', { work_dir }); await load(); say('Saved'); }
    catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  useOnOpen(opened, load);
  return (
    <Section id="workdir" title="Working directory" aside={<ScopeLabel id="workdir" />}>
      <Field
        id="h5-workdir" label="Working directory" value={value} onChange={event => setValue(event.target.value)} placeholder="e.g. /Users/yourname/tasks"
        helperText={t('Root directory for md files of new tasks; created if missing. Clear it to restore the default.')}
      />
      <Actions><Button id="h5-workdir-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button></Actions>
      <Feedback id="h5-workdir-feedback" feedback={feedback} />
    </Section>
  );
}

// The first lines of a settings part whose feature this service gets from a linked service (`shared_from` of its config, which an older server does not send).
function SharedFrom({ id, from }) {
  if (!from) return null;
  return (
    <>
      <Hint id={id}>{t(from.online === false ? `Provided by ${from.name} (offline)` : `Provided by ${from.name}`)}</Hint>
      <Hint>{t('Usage is charged to that service’s account; saving settings here makes this device use its own.')}</Hint>
    </>
  );
}

// "Let agent sessions manage OSS files (tcli)": whether the Claude and Codex sessions in this Client's terminals may use the bucket through the tcli
// command (GET / PUT /api/oss/agent-access, on by default). Read each time the group opens and saved at once, without Save: a switch row under the
// upload form, in the same card. An older server answers 404 and nothing is drawn.
function OssAgentAccess({ opened }) {
  const [setting, setSetting] = useState({ loaded: false, supported: true, enabled: false });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track] = useSyncAfterSave('oss-agent-access');
  const read = async () => Boolean((await api('GET', '/api/oss/agent-access') || {}).enabled);
  const load = async () => {
    try { setSetting({ loaded: true, supported: true, enabled: await read() }); say(''); }
    catch (error) {
      if (error.status === 404) { setSetting({ loaded: true, supported: false, enabled: false }); say(''); return; }
      say(failure(error), true);
    }
  };
  useOnOpen(opened, load);
  const change = async enabled => {
    setBusy(true);
    setSetting(current => ({ ...current, enabled }));
    try {
      const saved = await api('PUT', '/api/oss/agent-access', { enabled });
      setSetting(current => ({ ...current, enabled: Boolean(saved && saved.enabled) }));
      say('Saved');
      void track();
    } catch (error) {
      say(failure(error), true);
      try { const now = await read(); setSetting(current => ({ ...current, enabled: now })); } // show what is really in effect
      catch { setSetting(current => ({ ...current, enabled: !enabled })); }
    } finally { setBusy(false); }
  };
  if (!setting.supported) return <span id="h5-oss-agent" hidden />;
  return (
    <Box id="h5-oss-agent" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Divider sx={{ mx: -2, mb: 0.5 }} />
      <SwitchRow
        inputId="h5-oss-agent-enabled" label={t('Let agent sessions manage OSS files (tcli)')} checked={setting.enabled} disabled={!setting.loaded || busy} onChange={enabled => void change(enabled)}
        secondary={t('Claude and Codex sessions in T-Agent terminals can manage files in this bucket with tcli (list, upload, download, copy, move, delete). The access key stays on this server.')}
        aside={<ScopeLabel id="oss-agent-access" scope="shared" />}
      />
      <Feedback id="h5-oss-agent-feedback" feedback={feedback} />
      <SyncNote id="h5-oss-agent-sync" note={synced} />
    </Box>
  );
}

function OssSection({ opened }) {
  const [form, setForm] = useState({ enabled: false, region: '', bucket: '', accessKeyId: '', accessKeySecret: '', prefix: '', publicBaseUrl: '' });
  const [hasSecret, setHasSecret] = useState(false);
  const [shared, setShared] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track] = useSyncAfterSave('oss');
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const load = async () => {
    try {
      const config = await api('GET', '/api/oss/config');
      setForm({ enabled: Boolean(config.enabled), ...Object.fromEntries(OSS_FIELDS.map(([key]) => [key, key === 'accessKeySecret' ? '' : config[key] || ''])) });
      setHasSecret(Boolean(config.hasAccessKeySecret));
      setShared(config.shared_from || null);
      say('');
    } catch (error) { say(failure(error), true); }
  };
  const persist = async remove => {
    if (remove && !confirm(t('Delete the image and file upload settings?'))) return;
    setBusy(true);
    const payload = { enabled: form.enabled, ...Object.fromEntries(OSS_FIELDS.map(([key]) => [key, form[key].trim()])) };
    try {
      const saved = remove ? await api('DELETE', '/api/oss/config') : await api('PUT', '/api/oss/config', payload);
      await load();
      say(!remove && !saved.enabled ? 'Settings saved, but upload is not enabled. Tick “Enable image and file upload” above and save again.' : remove ? 'Deleted' : 'Saved');
      void track();
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  useOnOpen(opened, load);
  return (
    <Section id="oss" title="Image and file upload" aside={<ScopeLabel id="oss" scope="shared" />}>
      <SharedFrom id="h5-oss-shared" from={shared} />
      {/* Part of the form below, saved with it: a checkbox, not a switch. */}
      <FormControlLabel control={<Checkbox checked={form.enabled} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} slotProps={{ input: { id: 'h5-oss-enabled' } }} />} label={t('Enable image and file upload')} />
      {OSS_FIELDS.map(([key, label]) => (
        <Field key={key} id={`h5-oss-${key}`} label={label} value={form[key]} onChange={set(key)} type={key === 'accessKeySecret' ? 'password' : 'text'} autoComplete={key === 'accessKeySecret' ? 'new-password' : 'off'} />
      ))}
      <Hint id="h5-oss-secret-hint">{t(hasSecret ? 'Secret saved; leave empty to keep it.' : 'The secret is required for first-time setup.')}</Hint>
      <Hint>{t('Links are private and valid for 24 hours; the public address is only for buckets that allow public reads. Images up to 10 MiB open in the browser; other files up to 100 MiB download under their own name. Files go from the browser straight to OSS, so the bucket needs a CORS rule that allows POST from this page’s address.')}</Hint>
      <Actions>
        <Button id="h5-oss-clear" color="error" disabled={busy} onClick={() => void persist(true)}>{t('Delete settings')}</Button>
        <Button id="h5-oss-save" variant="contained" disabled={busy} onClick={() => void persist(false)}>{t('Save')}</Button>
      </Actions>
      <Feedback id="h5-oss-feedback" feedback={feedback} />
      <SyncNote id="h5-oss-sync" note={synced} />
      <OssAgentAccess opened={opened} />
    </Section>
  );
}

function TranslateSection({ opened }) {
  const [providers, setProviders] = useState({});
  const [current, setCurrent] = useState('');
  const [drafts, setDrafts] = useState({}); // input that is not saved yet survives switching providers
  const [shared, setShared] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track] = useSyncAfterSave('translate');
  const saved = providers[current] || {};
  const draft = drafts[current] || {};
  const field = key => (draft[key] !== undefined ? draft[key] : key === 'apiKey' ? '' : saved[key] || '');
  const edit = key => event => setDrafts(all => ({ ...all, [current]: { ...all[current], [key]: event.target.value } }));
  const load = async () => {
    try {
      const config = await api('GET', '/api/translate/config');
      const ids = Object.keys(config.providers || {});
      setProviders(config.providers || {});
      setCurrent(config.provider || ids[0] || '');
      setDrafts({});
      setShared(config.shared_from || null);
      say('');
    } catch (error) { say(failure(error), true); }
  };
  const save = async remove => {
    if (remove && !confirm(t('Delete all translation settings?'))) return;
    setBusy(true);
    try {
      if (remove) await api('DELETE', '/api/translate/config');
      else await api('PUT', '/api/translate/config', { provider: current, apiKey: field('apiKey').trim(), baseUrl: field('baseUrl').trim(), model: field('model').trim() });
      await load();
      say(remove ? 'Translation settings deleted' : 'Translation settings saved');
      void track();
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  useOnOpen(opened, load);
  return (
    <Section id="translate" title="Translation" aside={<ScopeLabel id="translate" scope="shared" />}>
      <SharedFrom id="h5-tr-shared" from={shared} />
      <TextField id="h5-tr-provider" select label={t('Translation service')} size="small" fullWidth value={current} onChange={event => setCurrent(event.target.value)} slotProps={{ select: { native: true } }}>
        {Object.keys(providers).map(id => <option key={id} value={id}>{`${providers[id].label}${providers[id].hasApiKey ? ` (${t('Key saved')})` : ''}`}</option>)}
      </TextField>
      <Field id="h5-tr-key" label="API Key" type="password" autoComplete="new-password" value={field('apiKey')} onChange={edit('apiKey')} placeholder={saved.hasApiKey ? t('Saved; leave empty to keep it') : t('API Key')} />
      <Field id="h5-tr-url" label="Endpoint" value={field('baseUrl')} onChange={edit('baseUrl')} />
      <Field id="h5-tr-model" label="Model" value={field('model')} onChange={edit('model')} />
      <Hint>{t('One key per provider, stored encrypted on the client and never sent to the browser or remote engines. The selected provider is used after saving. Only input with Chinese is translated; terminals on remote engines work too.')}</Hint>
      <Actions>
        <Button id="h5-tr-clear" color="error" disabled={busy} onClick={() => void save(true)}>{t('Delete all settings')}</Button>
        <Button id="h5-tr-save" variant="contained" disabled={busy} onClick={() => void save(false)}>{t('Save')}</Button>
      </Actions>
      <Feedback id="h5-tr-feedback" feedback={feedback} />
      <SyncNote id="h5-tr-sync" note={synced} />
    </Section>
  );
}

// Voice input on or off for this device (voice-input.js owns it; localStorage, like keeping the microphone ready), at once and without Save.
const useVoiceEnabled = Voice => useSyncExternalStore(listener => (Voice ? Voice.onEnabled(listener) : () => {}), () => !Voice || Voice.enabled);

// The switch row at the top of the voice input card. The fields under it stay usable and can still be saved while it is off, like the fields under
// "Enable image and file upload".
function VoiceSwitch() {
  const Voice = window.VoiceInput;
  const enabled = useVoiceEnabled(Voice);
  if (!Voice) return null;
  return (
    <>
      {/* The switch is kept in this browser (voice-input.js), not on the server: it is this device's own even when the rest is shared. */}
      <SwitchRow
        inputId="h5-vi-enabled" label={t('Enable voice input')} checked={enabled} onChange={on => Voice.setEnabled(on)}
        secondary={t('Applies at once on this device, without Save. When off, the microphone buttons are hidden and the microphone is not used.')}
        aside={<ScopeLabel scope="device" subject="Voice input on or off" follow={false} />}
      />
      <Divider sx={{ mx: -2 }} />
    </>
  );
}

function VoiceSection({ opened }) {
  const [config, setConfig] = useState({ regions: {}, languages: {}, keySource: 'none', shared: null });
  const [form, setForm] = useState({ apiKey: '', region: '', language: '', model: '', noise: '', hotwords: '', vocab: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const [synced, track] = useSyncAfterSave('voice');
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const load = async () => {
    try {
      const data = await api('GET', '/api/speech/config');
      setConfig({ regions: data.regions || {}, languages: data.languages || {}, keySource: data.keySource, shared: data.shared_from || null });
      setForm({ apiKey: '', region: data.region || '', language: data.language || '', model: data.model || '', noise: data.noiseThreshold === null || data.noiseThreshold === undefined ? '' : String(data.noiseThreshold), hotwords: data.hotwords || '', vocab: data.vocabularyId || '', url: data.endpoint || '' });
      say('');
    } catch (error) { say(failure(error), true); }
  };
  const save = async remove => {
    if (remove && !confirm(t('Delete all voice input settings?'))) return;
    setBusy(true);
    try {
      if (remove) await api('DELETE', '/api/speech/config');
      else await api('PUT', '/api/speech/config', { apiKey: form.apiKey.trim(), region: form.region, language: form.language, model: form.model.trim(), endpoint: form.url.trim(), noiseThreshold: form.noise.trim(), hotwords: form.hotwords, vocabularyId: form.vocab.trim() });
      await load();
      say(remove ? 'Voice input settings deleted' : 'Voice input settings saved');
      void track();
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  useOnOpen(opened, load);
  const labelOf = item => (typeof item === 'string' ? item : item.label);
  const region = config.regions[form.region];
  const keyHint = config.keySource === 'saved' ? 'Saved; leave empty to keep it' : config.keySource === 'environment' ? 'Using DASHSCOPE_API_KEY from the server; enter a key here to override it' : 'API Key';
  return (
    <Section id="voice" title="Voice input" aside={<ScopeLabel id="voice" scope="shared" />}>
      <SharedFrom id="h5-vi-shared" from={config.shared} />
      <VoiceSwitch />
      <Field id="h5-vi-key" label="Alibaba Cloud API Key" type="password" autoComplete="new-password" value={form.apiKey} onChange={set('apiKey')} placeholder={t(keyHint)} />
      <TextField id="h5-vi-region" select label={t('Region')} size="small" fullWidth value={form.region} onChange={set('region')} slotProps={{ select: { native: true } }}>
        {Object.entries(config.regions).map(([key, item]) => <option key={key} value={key}>{labelOf(item)}</option>)}
      </TextField>
      <TextField id="h5-vi-language" select label={t('Language')} size="small" fullWidth value={form.language} onChange={set('language')} slotProps={{ select: { native: true } }}>
        {Object.entries(config.languages).map(([key, item]) => <option key={key} value={key}>{labelOf(item)}</option>)}
      </TextField>
      <Field id="h5-vi-model" label="Model" value={form.model} onChange={set('model')} />
      <Field
        id="h5-vi-noise" label="Noise filter (-1 to 1, optional)" type="number" value={form.noise} onChange={set('noise')} placeholder={t('Service default')} htmlInput={{ inputMode: 'decimal', min: -1, max: 1, step: 0.1 }}
        helperText={t('Closer to 1 filters more noise (try 0.2 to 0.5 in a noisy room) but can cut quiet speech. It cannot tell your voice from other voices nearby.')}
      />
      <Field id="h5-vi-hotwords" label="Hot words (optional)" multiline minRows={3} value={form.hotwords} onChange={set('hotwords')} placeholder={t('One per line: names, product and code terms')} htmlInput={{ maxLength: 400 }} />
      <Field id="h5-vi-vocab" label="Hot word list ID (optional)" value={form.vocab} onChange={set('vocab')} placeholder={t('A list made in advance on Alibaba Cloud')} />
      <Field id="h5-vi-url" label="Endpoint (optional)" value={form.url} onChange={set('url')} />
      {/* While a linked service provides voice input, the address it uses is not known here. */}
      {config.shared ? null : <Hint id="h5-vi-effective">{`${t('Address in use:')} ${form.url.trim() || (region && region.endpoint) || ''}`}</Hint>}
      <Hint>{t('The key is stored encrypted on the client; the browser gets a one-minute token and sends the audio straight to Alibaba Cloud Model Studio. A key works only in its region, so choose the region it was created in. Leave the endpoint empty to use the region’s address.')}</Hint>
      <Actions>
        <Button id="h5-vi-clear" color="error" disabled={busy} onClick={() => void save(true)}>{t('Delete all settings')}</Button>
        <Button id="h5-vi-save" variant="contained" disabled={busy} onClick={() => void save(false)}>{t('Save')}</Button>
      </Actions>
      <Feedback id="h5-vi-feedback" feedback={feedback} />
      <SyncNote id="h5-vi-sync" note={synced} />
    </Section>
  );
}

// "Account and access": the access mode, then the authenticator. Log out is a row of the group list (LogoutRow).
function AccountGroup({ request }) {
  const [info, setInfo] = useState({ local: false, loopbackOnly: false, host: '', bound: false });
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try {
      const user = await api('GET', '/auth/me');
      setInfo({ local: user.access_mode === 'local', loopbackOnly: ['127.0.0.1', '::1', 'localhost'].includes(user.listen_host), host: user.listen_host, bound: Boolean(user.authenticator_bound) });
      setLoaded(true);
      say('');
    } catch (error) { say(failure(error), true); }
  };
  const switchMode = async () => {
    if (!info.local && !confirm(t('After switching to “local access only”, no code is needed, and phones, other computers and remote clients (including connections that use this Client as an engine) can no longer reach it.\n\nSessions on other devices end immediately. Switch?'))) return;
    setBusy(true);
    say('');
    try {
      const result = await api('POST', '/auth/mode', info.local ? { mode: 'remote', code: code.trim() } : { mode: 'local' });
      // A phone is not the local machine: switching to local access only locks this page out too.
      if (result.locked_out) { say('Switched to local access only. This device is not the local machine and can no longer connect; use the browser on the server itself.'); return; }
      location.replace(pagePath());
    } catch (error) {
      const data = error.data || {};
      if (data.error === 'AUTHENTICATOR_BINDING_REQUIRED') { location.href = (data.redirect || '/auth/setup?return_to=/').replace(/return_to=[^&]*/, `return_to=${pagePath()}`); return; }
      const known = { AUTH_CODE_INVALID: 'The code is invalid or already used. Wait for the next code.', AUTH_RATE_LIMITED: 'Too many attempts. Try again in 15 minutes.' }[data.error];
      say(known || `${t('Switch failed')}: ${error.message}`, true);
    } finally { setBusy(false); }
  };
  const hint = !loaded ? '' : t(info.local
    ? 'Only access from this machine is accepted, with no code; other devices and remote clients cannot reach this client.'
    : 'An authenticator login is required; phones, other computers and remote clients can connect.')
    + (!info.local && info.loopbackOnly ? ` ${t('Note: the service currently listens only on')} ${info.host}. ${t('To let other devices connect, set HOST=0.0.0.0 in .env and restart the service.')}` : '');
  return (
    <Group id="account" title="Account and access" onOpen={load} request={request}>
      <Section id="access" title="Access mode" aside={<ScopeLabel id="access" />}>
        <LocalOnly id="h5-access-remote">
          <Typography id="h5-access-title" variant="body1" component="strong" className="h5-setting-minor">{loaded ? t(info.local ? 'Local access only' : 'Authenticator + allow external access') : ''}</Typography>
          <Hint id="h5-access-hint">{hint}</Hint>
          {info.local && info.bound ? (
            <Box id="h5-access-code-row">
              <Field id="h5-access-code" label="6-digit authenticator code (verified when switching back to external access)" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" htmlInput={{ inputMode: 'numeric', maxLength: 6 }} />
            </Box>
          ) : <span id="h5-access-code-row" hidden />}
          <Actions>
            <Button id="h5-access-switch" variant="contained" disabled={busy || !loaded} onClick={() => void switchMode()}>{loaded ? t(info.local ? 'Switch to: authenticator + external access' : 'Switch to: local access only (no verification)') : ''}</Button>
          </Actions>
          <Feedback id="h5-access-feedback" feedback={feedback} />
        </LocalOnly>
      </Section>
      <Section id="authenticator" title="Authenticator" aside={<ScopeLabel id="authenticator" />}>
        <LocalOnly id="h5-authenticator-remote">
          <Hint>{t('Computer and phone share one binding. A login lasts 30 days and renews while in use. Replacing it ends the old authenticator, its recovery codes and other devices’ logins at once.')}</Hint>
          <Actions><Button id="h5-authenticator-replace" component="a" href={`/auth/setup?return_to=${pagePath()}`}>{t('Replace authenticator')}</Button></Actions>
        </LocalOnly>
      </Section>
    </Group>
  );
}

// "Tasks and files": where new tasks are kept, the image and file upload (with the agents' tcli access to it), the agent skills, then the browser
// extension that `tcli browser` drives and its site library. Each part is drawn in the tabs that hold it (InTab, settings-tabs.mjs).
function TasksFilesGroup({ request }) {
  const [opened, setOpened] = useState(0);
  return (
    <Group id="tasks-files" title="Tasks and files" onOpen={() => setOpened(count => count + 1)} request={request}>
      <InTab part="workdir"><WorkdirSection opened={opened} /></InTab>
      <InTab part="oss"><OssSection opened={opened} /></InTab>
      <InTab part="agent-skills"><AgentSkillsSection opened={opened} /></InTab>
      <InTab part="browser-ext"><BrowserExtSection opened={opened} /></InTab>
      <InTab part="browser-sites"><BrowserSitesSection opened={opened} /></InTab>
    </Group>
  );
}

// "Voice and translation": voice input, then the translation service. Each part says when a linked service provides it (SharedFrom).
function VoiceTranslateGroup({ request }) {
  const [opened, setOpened] = useState(0);
  return (
    <Group id="voice-translate" title="Voice and translation" onOpen={() => setOpened(count => count + 1)} request={request}>
      <InTab part="voice"><VoiceSection opened={opened} /></InTab>
      <InTab part="translate"><TranslateSection opened={opened} /></InTab>
    </Group>
  );
}

// ---- The page: the group list and one page per group -------------------------------------------------------------------------------------------

// The language of this page: the text button on the right shows the name of the OTHER language; switching reloads the page in it.
function LanguageRow() {
  const english = typeof I18n !== 'undefined' && I18n.get() === 'en';
  return (
    <ListItem className="h5-setting-row" secondaryAction={<Button id="h5-lang" translate="no" onClick={() => { if (typeof I18n !== 'undefined') I18n.toggle(); }}>{english ? '中文' : 'English'}</Button>} sx={{ minHeight: 48 }}>
      <ListItemText primary={<span className="h5-setting-label">{t('Language')}</span>} slotProps={{ primary: { variant: 'body2' } }} />
    </ListItem>
  );
}

// Log out: a row in the error colour (an exit action goes last, under the groups).
function LogoutRow({ ui }) {
  const logout = async () => {
    if (!confirm(t('Logging out disconnects local and remote terminals, but tasks running on the server keep running. Log out?'))) return;
    try {
      await api('POST', '/auth/logout', {});
      // The server puts the (hidden) login address of this install into the page.
      const meta = document.querySelector('meta[name="t-agent-login-path"]');
      location.replace(`${(meta && meta.content) || '/auth/login'}?return_to=${pagePath()}`);
    } catch { ui.notify(t('Log out failed. Please retry later.'), 'error'); }
  };
  return (
    <ListItemButton id="h5-logout" className="h5-setting-row" onClick={() => void logout()} sx={{ minHeight: 48, color: 'error.main' }}>
      <ListItemText primary={<span className="h5-setting-label">{t('Log out')}</span>} slotProps={{ primary: { variant: 'body2' } }} />
    </ListItemButton>
  );
}

// The version of this service at the bottom of the group list (GET /api/system/version, read when the page opens; nothing on an error).
function VersionLine() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    let alive = true;
    api('GET', '/api/system/version').then(answer => { if (alive && answer && answer.app_version) setVersion(String(answer.app_version)); }).catch(() => { /* no line */ });
    return () => { alive = false; };
  }, []);
  if (!version) return <span id="h5-settings-version" hidden />;
  return <Typography id="h5-settings-version" variant="caption" component="p" color="text.secondary" translate="no" sx={{ m: 0, px: 2, py: 2 }}>{`T-Agent v${version.replace(/^v/, '')}`}</Typography>;
}

// The rows under the groups, on a computer and on a phone: Language, Log out, the version.
function PageFooter({ ui }) {
  return (
    <>
      <Divider />
      <List disablePadding aria-label={t('This browser')}>
        <LanguageRow />
        <LogoutRow ui={ui} />
      </List>
      <VersionLine />
    </>
  );
}

// The two switches people change most, on the first page of Settings on a phone: voice input of this device and the reminder sound of this page.
// The same settings as the switches in their groups (voice-input.js and the T-Attention reminders), so both always show the same.
function QuickSwitches({ ui }) {
  const Voice = typeof window !== 'undefined' ? window.VoiceInput : null;
  const voice = useVoiceEnabled(Voice);
  const prefs = ui.actions.attentionPrefs;
  const [sound, setSound] = useState(() => (prefs ? Boolean(prefs().sound) : null));
  if (!Voice && sound === null) return null;
  return (
    <Box component="section" id="h5-settings-quick" aria-labelledby="h5-settings-quick-title" sx={{ pt: 1 }}>
      <Typography id="h5-settings-quick-title" variant="overline" component="h3" color="text.secondary" sx={{ display: 'block', px: 2, pt: 1 }}>{t('Quick switches')}</Typography>
      {Voice ? <SwitchRow inputId="h5-quick-voice" label={t('Voice input')} checked={voice} onChange={on => Voice.setEnabled(on)} sx={{ px: 2 }} /> : null}
      {sound !== null ? (
        <SwitchRow
          inputId="h5-quick-sound" label={t('Reminder sound')} checked={sound} sx={{ px: 2 }}
          onChange={on => { ui.actions.attentionSetSound(on); setSound(Boolean(ui.actions.attentionPrefs().sound)); }}
        />
      ) : null}
    </Box>
  );
}

const Chevron = () => <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', color: 'text.secondary', ml: 1 }}><Icon name="treeChevron" size={16} /></Box>;

// Up / Down (and Home / End) move the focus through the rows of the group list; Enter, Space or a click choose a group.
function moveFocus(event) {
  const steps = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
  if (!Object.hasOwn(steps, event.key)) return;
  const items = [...event.currentTarget.querySelectorAll('.h5-settings-group-item')];
  const at = items.indexOf(document.activeElement);
  if (at < 0) return;
  event.preventDefault();
  const step = steps[event.key];
  const next = step === 'first' ? 0 : step === 'last' ? items.length - 1 : (at + step + items.length) % items.length;
  items[next].focus();
}

// The group list. On a computer: a vertical tab list (one 48px row per group, the chosen one in the primary colour with a bar at its left edge);
// on a phone: a list of two-line rows (the group and what it holds) that open the group's page.
function GroupList({ groups, current, wide, onChoose }) {
  if (wide) {
    return (
      <List component="div" id="h5-settings-groups" role="tablist" aria-orientation="vertical" aria-label={t('Settings groups')} onKeyDown={moveFocus} sx={{ py: 1 }}>
        {groups.map(group => {
          const selected = current === group.id;
          return (
            <ListItemButton
              key={group.id} id={`h5-settings-group-${group.id}`} className="h5-settings-group-item" data-group={group.id} role="tab" aria-selected={selected ? 'true' : 'false'}
              aria-controls={`h5-set-${group.id}`} tabIndex={selected || (!current && group === groups[0]) ? 0 : -1} selected={selected} onClick={() => onChoose(group.id)}
              sx={theme => ({ minHeight: 48, px: 2, '&.Mui-selected': { color: 'primary.main', boxShadow: `inset 3px 0 0 ${theme.palette.primary.main}` } })}
            >
              <ListItemText primary={t(group.title)} slotProps={{ primary: { variant: 'body2', sx: { fontWeight: selected ? 500 : 400 } } }} />
            </ListItemButton>
          );
        })}
      </List>
    );
  }
  return (
    <List id="h5-settings-groups" aria-label={t('Settings groups')} onKeyDown={moveFocus} disablePadding>
      {groups.map(group => (
        <ListItem key={group.id} disablePadding divider>
          <ListItemButton id={`h5-settings-group-${group.id}`} className="h5-settings-group-item" data-group={group.id} aria-controls={`h5-set-${group.id}`} onClick={event => onChoose(group.id, event.currentTarget)} sx={{ minHeight: 72, px: 2 }}>
            <ListItemText primary={t(group.title)} secondary={t(group.summary)} slotProps={{ primary: { variant: 'body1' }, secondary: { variant: 'body2' } }} />
            <Chevron />
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  );
}

// The Settings page ("Settings page" in docs/design/page-files-and-settings.md). Opened by `state.settingsOpen` (`ui.actions.openSettings(id?)`,
// `ui.actions.closeSettings()`); `state.settingsTarget` ({ id, seq }, settings-target.mjs) shows one group and brings one part of it into view, on the
// device tab that holds that part. The groups: Tasks and files, Voice and translation, Devices (Engines.jsx), T-Attention, Account and access, Usage
// data (UsageData.jsx); a group with nothing in the chosen device tab is left out (settings-tabs.mjs). Every group stays mounted while the page is
// open, so edits survive a change of group or device tab; each reads its data when it is shown.
// - Computer (`state.wide`): the page fills the window to the right of the navigation rail (left NAV_WIDTH, no backdrop: the rail stays usable;
//   a column of the multi-column view has no rail and starts at its left edge).
//   (A column of the multi-column view has no rail: there it starts at the left edge.) Left, a 280px pane: the title, the device switch (SettingsTabs.jsx), the groups as a vertical tab list, Language, Log out and the version.
//   Right, the chosen group as cards in a column of at most 720px. Escape (and the back button, entry.jsx) closes it; the focus goes back to the
//   button that opened it.
// - Phone: a full-screen page (a modal, so back.mjs closes it on the back button) with a 56px app bar and a back arrow: the device switch, the
//   groups as two-line rows, the quick switches, Language, Log out and the version. A group opens its own full-screen page over it (a second modal,
//   kept mounted), whose back arrow, Escape and the phone's back button return to the list.
export function SettingsDrawer({ state, ui }) {
  // A target is used once: the page opened again later (the gear, or `settingsOpen` set directly) starts without it.
  useEffect(() => { if (!state.settingsOpen && state.settingsTarget) ui.set({ settingsTarget: null }); }, [state.settingsOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- only a closed page drops it
  if (!state.settingsOpen) return null;
  return <SettingsPage state={state} ui={ui} />;
}

function SettingsPage({ state, ui }) {
  const wide = Boolean(state.wide);
  const request = useMemo(() => {
    const target = state.settingsTarget && settingsTarget(state.settingsTarget.id);
    return target ? { ...target, seq: state.settingsTarget.seq } : null;
  }, [state.settingsTarget]);
  const { tab, scope, shared } = useSettingsTab();
  // A request is passed on once its tab is shown: the first time the tabs are known with it, the page moves to the tab that holds its part.
  const [placed, setPlaced] = useState(null);
  useEffect(() => {
    if (!request || tab === null || placed === request.seq) return;
    const wanted = tabForTarget(request, tab, { shared });
    if (wanted !== tab) chooseTab(wanted);
    setPlaced(request.seq);
  }, [request, tab, shared]); // eslint-disable-line react-hooks/exhaustive-deps -- `placed` only marks a request as done
  const passed = request && (tab === null || placed === request.seq) ? request : null;
  const requestFor = group => (passed && passed.group === group ? passed : null);
  const shown = useCallback(group => groupShown(group, scope), [scope]);
  const groups = GROUPS.filter(group => shown(group.id));
  // The group chosen by the person or by a request. A computer always shows one (the first one of the list until another is chosen, and when the
  // chosen one has nothing in the device tab); a phone shows the list while it is null.
  const [chosen, setChosen] = useState(null);
  const focusTitle = useRef(false);
  useEffect(() => { if (passed) { setChosen(passed.group); focusTitle.current = true; } }, [passed && passed.seq]); // eslint-disable-line react-hooks/exhaustive-deps -- a new request
  const fallback = groups.length ? groups[0].id : null;
  const current = chosen && shown(chosen) ? chosen : wide ? fallback : null;
  // The linked devices and the settings sync (whether a device is linked: the device tabs) are read each time the page opens.
  useEffect(() => { void refreshDeviceTargets(); void refreshSettingsSync(); }, []);
  const close = () => ui.actions.closeSettings();
  const pane = useRef(null);
  const choose = id => { focusTitle.current = true; setChosen(id); };
  // A newly chosen group starts at its top, and its title takes the focus when the person chose it (a screen reader reads where it is).
  useEffect(() => {
    if (pane.current) pane.current.scrollTop = 0;
    if (!focusTitle.current || !current) return;
    focusTitle.current = false;
    const title = document.getElementById(wide ? `h5-set-${current}-title` : 'h5-settings-page-title');
    if (title && wide) title.focus({ preventScroll: true });
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new group
  const nav = useMemo(() => ({ current, wide }), [current, wide]);
  const tree = (
    <SettingsNav.Provider value={nav}>
      <GroupShown.Provider value={shown}>
        <TasksFilesGroup request={requestFor('tasks-files')} />
        <VoiceTranslateGroup request={requestFor('voice-translate')} />
        <DevicesGroup state={state} ui={ui} request={requestFor('devices')} />
        <AttentionSettings ui={ui} request={requestFor('attention')} />
        <AccountGroup request={requestFor('account')} />
        <UsageDataGroup ui={ui} request={requestFor('usage-data')} />
      </GroupShown.Provider>
    </SettingsNav.Provider>
  );
  return wide ? <WidePage state={state} ui={ui} groups={groups} current={current} choose={choose} close={close} pane={pane}>{tree}</WidePage>
    : <PhonePage state={state} ui={ui} groups={groups} current={current} choose={choose} back={() => setChosen(null)} close={close} pane={pane}>{tree}</PhonePage>;
}

function WidePage({ state, ui, groups, current, choose, close, pane, children }) {
  const root = useRef(null);
  // The focus moves into the page (the chosen group of the list) and goes back to the button that opened it when the page closes.
  useEffect(() => {
    const opener = document.activeElement;
    const tabNode = root.current && root.current.querySelector('.h5-settings-group-item[tabindex="0"]');
    if (tabNode && !root.current.contains(document.activeElement)) tabNode.focus({ preventScroll: true });
    return () => { if (opener && opener.isConnected && typeof opener.focus === 'function') setTimeout(() => opener.focus({ preventScroll: true }), 0); };
  }, []);
  // Escape closes the page wherever the focus is (also on the rail), unless something above it (a dialog, a menu) takes it first.
  useEffect(() => {
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ([...document.body.children].some(el => el.classList && el.classList.contains('MuiModal-root') && !el.classList.contains('MuiModal-hidden'))) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- close reads the store
  return (
    <Box
      ref={root} id="h5-settings" role="region" aria-labelledby="h5-settings-title" className="h5-settings-page" data-layout="wide"
      sx={theme => ({ position: 'fixed', top: 0, right: 0, bottom: 0, left: state.pane ? 0 : NAV_WIDTH, zIndex: theme.zIndex.drawer + 1, display: 'flex', bgcolor: 'background.default', color: 'text.primary' })}
    >
      <Box component="nav" aria-label={t('Settings')} className="h5-settings-list" sx={{ flex: '0 0 280px', width: 280, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', borderRight: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Toolbar disableGutters sx={{ minHeight: 56, px: 2, gap: 1, justifyContent: 'space-between', flexShrink: 0 }}>
          <Typography id="h5-settings-title" variant="h6" component="h1">{t('Settings')}</Typography>
          <IconButton id="h5-close-settings" edge="end" onClick={close} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton>
        </Toolbar>
        <SettingsTabs state={state} />
        <GroupList groups={groups} current={current} wide onChoose={choose} />
        <Box sx={{ flex: '1 1 auto' }} />
        <PageFooter ui={ui} />
      </Box>
      <Box ref={pane} className="h5-settings-body" sx={{ flex: '1 1 auto', minWidth: 0, overflowY: 'auto', px: 4, py: 3 }}>
        <Box sx={{ maxWidth: 720 }}>{children}</Box>
      </Box>
    </Box>
  );
}

const AppTitle = ({ id, children, focusable = false }) => (
  <Typography id={id} variant="h6" component="h1" noWrap tabIndex={focusable ? -1 : undefined} sx={{ flex: '1 1 auto', minWidth: 0, outline: 'none' }}>{children}</Typography>
);

function PhonePage({ state, ui, groups, current, choose, back, close, pane, children }) {
  const info = current ? groupInfo(current) : null;
  // The title of the group's page is what was last shown, so it does not go blank while the page slides away.
  const lastTitle = useRef('');
  if (info) lastTitle.current = info.title;
  const entered = () => { const title = document.getElementById('h5-settings-page-title'); if (title) title.focus({ preventScroll: true }); };
  return (
    <>
      <Dialog id="h5-settings" open fullScreen onClose={close} aria-labelledby="h5-settings-title" slotProps={{ paper: { className: 'h5-sheet-panel h5-settings-page', 'data-layout': 'phone', sx: { backgroundImage: 'none' } } }}>
        <AppBar position="static" color="default" enableColorOnDark elevation={0} className="h5-sheet-header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
            <IconButton id="h5-close-settings" onClick={close} {...named(t('Close'))}><Icon name="back" size={22} /></IconButton>
            <AppTitle id="h5-settings-title">{t('Settings')}</AppTitle>
          </Toolbar>
        </AppBar>
        <Box className="h5-settings-list" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <SettingsTabs state={state} />
          <GroupList groups={groups} current={current} wide={false} onChoose={choose} />
          <QuickSwitches ui={ui} />
          <Box sx={{ flex: '1 1 auto', minHeight: 16 }} />
          <PageFooter ui={ui} />
        </Box>
      </Dialog>
      <Dialog
        id="h5-settings-page" open={Boolean(current)} keepMounted fullScreen onClose={back} aria-labelledby="h5-settings-page-title"
        slots={{ transition: Slide }} slotProps={{ transition: { direction: 'left', onEntered: entered }, paper: { className: 'h5-sheet-panel', sx: { backgroundImage: 'none', bgcolor: 'background.default' } } }}
      >
        <AppBar position="static" color="default" enableColorOnDark elevation={0} className="h5-sheet-header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
            <IconButton id="h5-settings-back" onClick={back} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
            <AppTitle id="h5-settings-page-title" focusable>{lastTitle.current ? t(lastTitle.current) : ''}</AppTitle>
          </Toolbar>
        </AppBar>
        <Box ref={pane} className="h5-settings-body" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', p: 2, pb: 4 }}>{children}</Box>
      </Dialog>
    </>
  );
}

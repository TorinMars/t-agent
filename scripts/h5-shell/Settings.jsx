import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Switch from '@mui/material/Switch';
import TextField from './TextField.jsx';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { api, t } from './common.jsx';
import { DevicesGroup } from './Engines.jsx';
import { AttentionSettings } from './AttentionSettings.jsx';
import { AgentSkillsSection } from './AgentSkillsSettings.jsx';
import { Feedback, Field, Group, Hint, ROW, Section, failure, useFeedback } from './Form.jsx';
import { settingsTarget } from './settings-target.mjs';
import { ScopeLabel, SyncNote, useSyncAfterSave } from './ScopeLabel.jsx';
import { DeviceSelector, LocalOnly, refreshDeviceTargets, useDeviceTarget } from './DeviceTarget.jsx';

// The address this page was opened at, to come back to after a login or a switch: `/` or `/h5` (an iPhone Home Screen app starts at /h5).
const pagePath = () => (/^\/h5(\/|$)/.test(location.pathname) ? '/h5' : '/');

const OSS_FIELDS = [
  ['region', 'Region (e.g. oss-cn-hangzhou)'], ['bucket', 'Bucket'], ['accessKeyId', 'AccessKey ID'],
  ['accessKeySecret', 'AccessKey Secret'], ['prefix', 'Object path prefix'], ['publicBaseUrl', 'Public HTTPS address (optional)'],
];
// A part of a group reads its data each time the group opens: `opened` counts the openings (0 before the first one).
const useOnOpen = (opened, load) => useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads

// The working directory of the device chosen in "Settings for" (DeviceTarget.jsx): this one, or a linked one through the link.
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
      <Field id="h5-workdir" label="Working directory" value={value} onChange={event => setValue(event.target.value)} placeholder="e.g. /Users/yourname/tasks" />
      <Hint>{t('Root directory for md files of new tasks; created if missing. Clear it to restore the default.')}</Hint>
      <Button id="h5-workdir-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
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
// command (GET / PUT /api/oss/agent-access, on by default). Read each time the group opens and saved at once, without Save; an older server answers
// 404 and nothing is drawn. Its hidden input is kept on the thumb, like the peer file access switch (PeerFs.jsx).
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
  const label = t('Let agent sessions manage OSS files (tcli)');
  return (
    <Box id="h5-oss-agent" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
      <FormControlLabel
        sx={{ m: 0, alignSelf: 'flex-start', gap: 0.5 }} label={label}
        control={<Switch size="small" checked={setting.enabled} disabled={!setting.loaded || busy} onChange={event => void change(event.target.checked)} slotProps={{ input: { id: 'h5-oss-agent-enabled', 'aria-label': label, style: { left: 0, width: '100%' } } }} />}
      />
      <ScopeLabel id="oss-agent-access" scope="shared" sx={{ alignSelf: 'flex-start' }} />
      <Hint>{t('Claude and Codex sessions in T-Agent terminals can list, upload, download, copy, move and delete files in this bucket with the tcli command. The access key never leaves this server.')}</Hint>
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
      <FormControlLabel control={<Checkbox checked={form.enabled} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} slotProps={{ input: { id: 'h5-oss-enabled' } }} />} label={t('Enable image and file upload')} />
      {OSS_FIELDS.map(([key, label]) => (
        <Field key={key} id={`h5-oss-${key}`} label={label} value={form[key]} onChange={set(key)} type={key === 'accessKeySecret' ? 'password' : 'text'} autoComplete={key === 'accessKeySecret' ? 'new-password' : 'off'} />
      ))}
      <Hint id="h5-oss-secret-hint">{t(hasSecret ? 'Secret saved; leave empty to keep it.' : 'The secret is required for first-time setup.')}</Hint>
      <Hint>{t('Private links valid for 24 hours are generated by default; the public address is only for buckets or domains that allow public reads. Images (PNG, JPEG, GIF, WebP) are limited to 10 MiB and open in the browser; other files are limited to 100 MiB and download under their original name. Both are uploaded from your browser straight to OSS, so the bucket needs a CORS rule that allows POST from this page’s address.')}</Hint>
      <Button id="h5-oss-save" variant="contained" disabled={busy} onClick={() => void persist(false)}>{t('Save')}</Button>
      <Button id="h5-oss-clear" variant="outlined" color="error" disabled={busy} onClick={() => void persist(true)}>{t('Delete settings')}</Button>
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
      <Hint>{t('Each provider’s key is stored encrypted on the client. Switching providers keeps saved keys, and they are never sent to the browser or remote engines. The selected provider is used after saving. Only input containing Chinese is translated; plain English is sent as-is. Translation runs on the client, so terminals on remote engines work too.')}</Hint>
      <Button id="h5-tr-save" variant="contained" disabled={busy} onClick={() => void save(false)}>{t('Save')}</Button>
      <Button id="h5-tr-clear" variant="outlined" color="error" disabled={busy} onClick={() => void save(true)}>{t('Delete all settings')}</Button>
      <Feedback id="h5-tr-feedback" feedback={feedback} />
      <SyncNote id="h5-tr-sync" note={synced} />
    </Section>
  );
}

// Turns voice input on or off for this device, at once and without Save (voice-input.js owns it; localStorage, like keeping the microphone ready).
// The options under it stay visible and can still be saved while it is off, like the fields under "Enable image and file upload".
function VoiceSwitch() {
  const Voice = window.VoiceInput;
  const enabled = useSyncExternalStore(listener => (Voice ? Voice.onEnabled(listener) : () => {}), () => !Voice || Voice.enabled);
  if (!Voice) return null;
  return (
    <>
      <FormControlLabel control={<Checkbox checked={enabled} onChange={event => Voice.setEnabled(event.target.checked)} slotProps={{ input: { id: 'h5-vi-enabled' } }} />} label={t('Enable voice input')} />
      {/* The switch is kept in this browser (voice-input.js), not on the server: it is this device's own even when the rest is shared. */}
      <ScopeLabel scope="device" subject="Voice input on or off" follow={false} sx={{ alignSelf: 'flex-start' }} />
      <Hint>{t('Applies at once on this device, without Save. When off, the microphone buttons are hidden and the microphone is not used.')}</Hint>
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
      <Field id="h5-vi-noise" label="Noise filter (-1 to 1, optional)" type="number" value={form.noise} onChange={set('noise')} placeholder={t('Service default')} htmlInput={{ inputMode: 'decimal', min: -1, max: 1, step: 0.1 }} />
      <Hint>{t('How sure the service must be that a sound is speech and not noise. Closer to 1 filters more noise (try 0.2 to 0.5 in a noisy room) but can cut quiet speech. It cannot tell your voice from other people talking nearby.')}</Hint>
      <Field id="h5-vi-hotwords" label="Hot words (optional)" multiline minRows={3} value={form.hotwords} onChange={set('hotwords')} placeholder={t('One per line: names, product and code terms')} htmlInput={{ maxLength: 400 }} />
      <Field id="h5-vi-vocab" label="Hot word list ID (optional)" value={form.vocab} onChange={set('vocab')} placeholder={t('A list made in advance on Alibaba Cloud')} />
      <Field id="h5-vi-url" label="Endpoint (optional)" value={form.url} onChange={set('url')} />
      {/* While a linked service provides voice input, the address it uses is not known here. */}
      {config.shared ? null : <Hint id="h5-vi-effective">{`${t('Address in use:')} ${form.url.trim() || (region && region.endpoint) || ''}`}</Hint>}
      <Hint>{t('The key is stored encrypted on the client. The browser never receives it: it gets a one-minute token and sends the audio straight to Alibaba Cloud Model Studio, so no audio goes through the client server. Keys are specific to a region, so choose the region the key was created in. Leave the endpoint empty to use the region’s address.')}</Hint>
      <Button id="h5-vi-save" variant="contained" disabled={busy} onClick={() => void save(false)}>{t('Save')}</Button>
      <Button id="h5-vi-clear" variant="outlined" color="error" disabled={busy} onClick={() => void save(true)}>{t('Delete all settings')}</Button>
      <Feedback id="h5-vi-feedback" feedback={feedback} />
      <SyncNote id="h5-vi-sync" note={synced} />
    </Section>
  );
}

// "Account and access": the access mode, then the authenticator. Log out is the row right under this group (LogoutRow).
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
          <Typography id="h5-access-title" variant="body2" component="strong" sx={{ fontWeight: 600 }}>{loaded ? t(info.local ? 'Local access only' : 'Authenticator + allow external access') : ''}</Typography>
          <Hint id="h5-access-hint">{hint}</Hint>
          {info.local && info.bound ? (
            <Box id="h5-access-code-row">
              <Field id="h5-access-code" label="6-digit authenticator code (verified when switching back to external access)" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" htmlInput={{ inputMode: 'numeric', maxLength: 6 }} />
            </Box>
          ) : <span id="h5-access-code-row" hidden />}
          <Button id="h5-access-switch" variant="contained" disabled={busy || !loaded} onClick={() => void switchMode()}>{loaded ? t(info.local ? 'Switch to: authenticator + external access' : 'Switch to: local access only (no verification)') : ''}</Button>
          <Feedback id="h5-access-feedback" feedback={feedback} />
        </LocalOnly>
      </Section>
      <Section id="authenticator" title="Authenticator" aside={<ScopeLabel id="authenticator" />}>
        <LocalOnly id="h5-authenticator-remote">
          <Hint>{t('Computer and phone share the same page and binding. Logins last 30 days and renew while in use; after 30 days of inactivity you must verify again. After replacing, the old authenticator, recovery codes and other devices’ logins stop working immediately.')}</Hint>
          <Button id="h5-authenticator-replace" component="a" href={`/auth/setup?return_to=${pagePath()}`} variant="outlined">{t('Replace authenticator')}</Button>
        </LocalOnly>
      </Section>
    </Group>
  );
}

const rowSx = { ...ROW, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, borderBottom: 1, borderColor: 'divider' };

// The first row: the language. The compact button on the right shows the name of the OTHER language; switching reloads the page in it.
function LanguageRow() {
  const english = typeof I18n !== 'undefined' && I18n.get() === 'en';
  return (
    <Box className="h5-setting-row" sx={rowSx}>
      <span className="h5-setting-label">{t('Language')}</span>
      <Button id="h5-lang" size="small" variant="outlined" color="inherit" translate="no" onClick={() => { if (typeof I18n !== 'undefined') I18n.toggle(); }}>{english ? '\u4e2d\u6587' : 'English'}</Button>
    </Box>
  );
}

// The last row: log out. The whole row is the button (an exit action goes last), in the error colour.
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
    <ButtonBase id="h5-logout" className="h5-setting-row" onClick={() => void logout()} sx={{ ...rowSx, width: '100%', justifyContent: 'flex-start', color: 'error.main', textAlign: 'left' }}>
      <span className="h5-setting-label">{t('Log out')}</span>
    </ButtonBase>
  );
}

// "Tasks and files": where new tasks are kept, the image and file upload (with the agents' tcli access to it), then the agent skills.
function TasksFilesGroup({ request }) {
  const [opened, setOpened] = useState(0);
  return (
    <Group id="tasks-files" title="Tasks and files" onOpen={() => setOpened(count => count + 1)} request={request}>
      <WorkdirSection opened={opened} />
      <OssSection opened={opened} />
      <AgentSkillsSection opened={opened} />
    </Group>
  );
}

// "Voice and translation": voice input, then the translation service. Each part says when a linked service provides it (SharedFrom).
function VoiceTranslateGroup({ request }) {
  const [opened, setOpened] = useState(0);
  return (
    <Group id="voice-translate" title="Voice and translation" onOpen={() => setOpened(count => count + 1)} request={request}>
      <VoiceSection opened={opened} />
      <TranslateSection opened={opened} />
    </Group>
  );
}

// The settings sheet that rises from the bottom (opened by the gear at the bottom of the task sidebar). Top to bottom: Language, Tasks and files,
// Voice and translation, Devices (Engines.jsx), T-Attention, Account and access, Log out. `state.settingsTarget` ({ id, seq }, set by
// `ui.actions.openSettings(id)` in h5.js) opens one group and shows one part of it; old group ids still work (settings-target.mjs).
export function SettingsDrawer({ state, ui }) {
  const request = useMemo(() => {
    const target = state.settingsTarget && settingsTarget(state.settingsTarget.id);
    return target ? { ...target, seq: state.settingsTarget.seq } : null;
  }, [state.settingsTarget]);
  const requestFor = group => (request && request.group === group ? request : null);
  // A target is used once: the sheet opened again later (the gear, or `settingsOpen` set directly) starts folded.
  useEffect(() => { if (!state.settingsOpen && state.settingsTarget) ui.set({ settingsTarget: null }); }, [state.settingsOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- only a closed sheet drops it
  // The linked devices of "Settings for" are read each time the sheet opens.
  useEffect(() => { if (state.settingsOpen) void refreshDeviceTargets(); }, [state.settingsOpen]);
  return (
    <Drawer
      anchor="bottom" id="h5-settings" open={state.settingsOpen} onClose={() => ui.actions.closeSettings()} aria-labelledby="h5-settings-title"
      slotProps={{ paper: { className: 'h5-sheet-panel', sx: { width: 'min(440px, 100%)', maxWidth: '100%', height: '92dvh', mx: 'auto', borderRadius: '16px 16px 0 0', backgroundImage: 'none' } } }}
    >
      <AppBar position="static" color="default" enableColorOnDark elevation={0} className="h5-sheet-header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" disableGutters sx={{ justifyContent: 'space-between', px: 2 }}>
          <Typography id="h5-settings-title" variant="h6" component="h2">{t('Settings')}</Typography>
          <IconButton id="h5-close-settings" aria-label={t('Close')} edge="end" onClick={() => ui.actions.closeSettings()}><CloseIcon /></IconButton>
        </Toolbar>
      </AppBar>
      <Box className="h5-settings-body" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', pb: 1 }}>
        <DeviceSelector />
        <LanguageRow />
        <TasksFilesGroup request={requestFor('tasks-files')} />
        <VoiceTranslateGroup request={requestFor('voice-translate')} />
        <DevicesGroup state={state} ui={ui} request={requestFor('devices')} />
        <AttentionSettings ui={ui} request={requestFor('attention')} />
        <AccountGroup request={requestFor('account')} />
        <LogoutRow ui={ui} />
      </Box>
    </Drawer>
  );
}

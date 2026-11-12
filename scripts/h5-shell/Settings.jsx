import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Checkbox from '@mui/material/Checkbox';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import TextField from './TextField.jsx';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { api, t } from './common.jsx';
import { EnginesGroup } from './Engines.jsx';
import { ServiceLinksGroup } from './ServiceLinks.jsx';
import { RuleSyncGroup } from './RuleSync.jsx';
import { AttentionSettings } from './AttentionSettings.jsx';
import { Feedback, Field, Group, Hint, ROW, failure, useFeedback } from './Form.jsx';

// The address this page was opened at, to come back to after a login or a switch: `/` or `/h5` (an iPhone Home Screen app starts at /h5).
const pagePath = () => (/^\/h5(\/|$)/.test(location.pathname) ? '/h5' : '/');

const OSS_FIELDS = [
  ['region', 'Region (e.g. oss-cn-hangzhou)'], ['bucket', 'Bucket'], ['accessKeyId', 'AccessKey ID'],
  ['accessKeySecret', 'AccessKey Secret'], ['prefix', 'Object path prefix'], ['publicBaseUrl', 'Public HTTPS address (optional)'],
];
function WorkdirGroup() {
  const [value, setValue] = useState('');
  const known = useRef({ saved: '', custom: null });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try {
      const user = await api('GET', '/auth/me');
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
    try { await api('PUT', '/auth/settings', { work_dir }); await load(); say('Saved'); }
    catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  return (
    <Group id="workdir" title="Working directory" onOpen={load}>
      <Field id="h5-workdir" label="Working directory" value={value} onChange={event => setValue(event.target.value)} placeholder="e.g. /Users/yourname/tasks" />
      <Hint>{t('Root directory for md files of new tasks; created if missing. Clear it to restore the default.')}</Hint>
      <Button id="h5-workdir-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
      <Feedback id="h5-workdir-feedback" feedback={feedback} />
    </Group>
  );
}

// The first lines of a settings group whose feature this service gets from a linked service (`shared_from` of its config, which an older server does not send).
function SharedFrom({ id, from }) {
  if (!from) return null;
  return (
    <>
      <Hint id={id}>{t(from.online === false ? `Provided by ${from.name} (offline)` : `Provided by ${from.name}`)}</Hint>
      <Hint>{t('Usage is charged to that service’s account; saving settings here makes this device use its own.')}</Hint>
    </>
  );
}

function OssGroup() {
  const [form, setForm] = useState({ enabled: false, region: '', bucket: '', accessKeyId: '', accessKeySecret: '', prefix: '', publicBaseUrl: '' });
  const [hasSecret, setHasSecret] = useState(false);
  const [shared, setShared] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
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
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  return (
    <Group id="oss" title="Image and file upload" onOpen={load}>
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
    </Group>
  );
}

function TranslateGroup() {
  const [providers, setProviders] = useState({});
  const [current, setCurrent] = useState('');
  const [drafts, setDrafts] = useState({}); // input that is not saved yet survives switching providers
  const [shared, setShared] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
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
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  return (
    <Group id="translate" title="Translation" onOpen={load}>
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
    </Group>
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
      <Hint>{t('Applies at once on this device, without Save. When off, the microphone buttons are hidden and the microphone is not used.')}</Hint>
    </>
  );
}

function VoiceGroup() {
  const [config, setConfig] = useState({ regions: {}, languages: {}, keySource: 'none', shared: null });
  const [form, setForm] = useState({ apiKey: '', region: '', language: '', model: '', noise: '', hotwords: '', vocab: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
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
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const labelOf = item => (typeof item === 'string' ? item : item.label);
  const region = config.regions[form.region];
  const keyHint = config.keySource === 'saved' ? 'Saved; leave empty to keep it' : config.keySource === 'environment' ? 'Using DASHSCOPE_API_KEY from the server; enter a key here to override it' : 'API Key';
  return (
    <Group id="voice" title="Voice input" onOpen={load}>
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
    </Group>
  );
}

function RemoteGroup() {
  const [tokens, setTokens] = useState([]);
  const [code, setCode] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const codeNode = useRef(null);
  const load = async () => {
    try { setTokens(await api('GET', '/api/remote-tokens')); say(''); }
    catch (error) { say(failure(error), true); }
  };
  const revoke = async token => {
    if (!confirm(t('Once revoked, remote connections using it stop working immediately.'))) return;
    try { await api('DELETE', `/api/remote-tokens/${token.id}`); await load(); }
    catch (error) { say(failure(error), true); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const created = await api('POST', '/api/remote-tokens/pairing', {});
      setCode(created.code);
      setCopyLabel('Copy');
      say('Pairing code created. Valid for 10 minutes, single use.');
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyLabel('Copied'); }
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
    <Group id="remote" title="Remote service" onOpen={load}>
      <Hint>{t('This client can also act as an engine so other clients can reach its tasks, files and terminals. On the other client choose “Connect remote” and enter this client’s address and a pairing code. The pairing code is valid for 10 minutes and can be used once.')}</Hint>
      <Hint>{t('Connect address:')} <code id="h5-remote-origin">{location.origin}</code></Hint>
      <Box id="h5-token-list" className="h5-token-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {tokens.length ? tokens.map(token => (
          <Paper key={token.id} variant="outlined" className="h5-token-row" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1 }}>
            <div>
              <strong>{token.name}</strong>
              <Typography variant="caption" component="small" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{`${token.token_prefix}… · ${token.scopes}`}</Typography>
            </div>
            <Button size="small" onClick={() => void revoke(token)}>{t('Revoke')}</Button>
          </Paper>
        )) : <Hint>{t('No tokens created yet')}</Hint>}
      </Box>
      <Button id="h5-token-create" variant="contained" disabled={busy} onClick={() => void create()}>{t('Generate pairing code')}</Button>
      {code ? (
        <Paper id="h5-token-created" variant="outlined" className="h5-token-created" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1 }}>
          <code id="h5-token-code" ref={codeNode} style={{ fontSize: 18, letterSpacing: 1, overflowWrap: 'anywhere', userSelect: 'all' }}>{code}</code>
          <Button id="h5-token-copy" size="small" variant="outlined" onClick={() => void copy()}>{t(copyLabel)}</Button>
        </Paper>
      ) : <span id="h5-token-created" hidden />}
      <Feedback id="h5-remote-feedback" feedback={feedback} />
    </Group>
  );
}

function AccessGroup() {
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
    <Group id="access" title="Access mode" onOpen={load}>
      <Typography id="h5-access-title" variant="subtitle2" component="strong">{loaded ? t(info.local ? 'Local access only' : 'Authenticator + allow external access') : ''}</Typography>
      <Hint id="h5-access-hint">{hint}</Hint>
      {info.local && info.bound ? (
        <Box id="h5-access-code-row">
          <Field id="h5-access-code" label="6-digit authenticator code (verified when switching back to external access)" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" htmlInput={{ inputMode: 'numeric', maxLength: 6 }} />
        </Box>
      ) : <span id="h5-access-code-row" hidden />}
      <Button id="h5-access-switch" variant="contained" disabled={busy || !loaded} onClick={() => void switchMode()}>{loaded ? t(info.local ? 'Switch to: authenticator + external access' : 'Switch to: local access only (no verification)') : ''}</Button>
      <Feedback id="h5-access-feedback" feedback={feedback} />
      <Typography variant="subtitle2" component="strong" sx={{ mt: 1 }}>{t('Authenticator')}</Typography>
      <Hint>{t('Computer and phone share the same page and binding. Logins last 30 days and renew while in use; after 30 days of inactivity you must verify again. After replacing, the old authenticator, recovery codes and other devices’ logins stop working immediately.')}</Hint>
      <Button id="h5-authenticator-replace" component="a" href={`/auth/setup?return_to=${pagePath()}`} variant="outlined">{t('Replace authenticator')}</Button>
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

// The settings sheet that rises from the bottom (opened by the gear at the bottom of the task sidebar): the Client configuration, translation and voice input.
export function SettingsDrawer({ state, ui }) {
  const [linksVersion, setLinksVersion] = useState(0); // Engines and Linked services show the same links: a change in one reads both again
  const linksChanged = () => setLinksVersion(version => version + 1);
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
        <LanguageRow />
        <WorkdirGroup />
        <OssGroup />
        <TranslateGroup />
        <VoiceGroup />
        <EnginesGroup state={state} ui={ui} linksVersion={linksVersion} onLinksChanged={linksChanged} />
        <ServiceLinksGroup state={state} ui={ui} version={linksVersion} onChanged={linksChanged} />
        <RuleSyncGroup state={state} />
        <RemoteGroup />
        <AttentionSettings ui={ui} />
        <AccessGroup />
        <LogoutRow ui={ui} />
      </Box>
    </Drawer>
  );
}

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import TextField from './TextField.jsx';
import { api, t } from './common.jsx';
import { Feedback, Field, Hint, failure, useFeedback } from './Form.jsx';
import { loginInProgress } from './plugins-model.mjs';

// T-Attention notifier settings, drawn on the pages of the plugin list (PluginSettings.jsx): the Telegram login (account 1) and account 2 on Telegram's
// page, and the rules of all notifiers (mode per status and notifier, delay before a call, quiet hours, hourly limits, the page address for links) on their own. Server side: services/attention-notify.js and
// plugins/notifiers/telegram. The session string and the api_hash never come back from the server; secret fields start empty.
// Linked devices share one Telegram sender (services/attention-relay.js, `relay` in GET /config): on the sender the page lists the devices that send
// through it; on another device it names the sender, sends its test through it, and offers "Use this device as the sender" and "Log out here".
const BASE = '/api/attention-notify';
// "Finished" is the review status: the agent ended its turn and the result is ready to look at.
const STATUS_LABELS = { waiting_user: 'Needs you', review: 'Finished (ready for review)', failed: 'Failed', working: 'Working', todo: 'To do', done: 'Done', cancelled: 'Cancelled' };
const STATUS_ORDER = ['waiting_user', 'failed', 'review', 'working', 'todo', 'done', 'cancelled'];
const MODE_LABELS = { off: 'Off', message: 'Message', call: 'Call' };
const OUTCOME_LABELS = {
  sent: 'Sent', fallback_sent: 'Sent as a message (the call failed)', call_failed: 'Call failed', call_timeout: 'Rang, no answer', call_answered: 'Answered',
  call_declined: 'Declined', call_scheduled: 'Call planned', duplicate: 'Skipped: sent less than 10 minutes ago', quiet_hours: 'Skipped: quiet hours',
  rate_limited: 'Skipped: hourly limit reached', skipped: 'Skipped: not set up', error: 'Error', foreground: 'Skipped: the session was open on screen',
  relayed: 'Sent through the sender device', relay_failed: 'Not sent: the sender device could not send it', relay_offline: 'Not sent: the sender device is offline',
};
const QR_POLL_MS = 2000;
const API_HELP = [
  'Open my.telegram.org/apps and log in with the phone number of account 1.',
  'Enter the code that Telegram sends to the Telegram app (not by SMS).',
  'Fill in App title and Short name (any words), choose Desktop as the platform, and click Create application.',
  'Copy App api_id and App api_hash into the fields below.',
];
const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

// The one sender of the linked devices. `relay` is null without linked devices that can relay (or on an older server): then nothing is drawn.
function RelayPart({ relay, status, busy, run, logout }) {
  const sender = relay && relay.sender;
  if (!relay || !relay.linked || !sender) return null;
  const testThrough = () => run(() => api('POST', `${BASE}/relay/test`, { kind: 'message' }), result => `Test message sent through ${result.via || sender.name}`);
  const useHere = () => run(() => api('PUT', `${BASE}/relay/sender`, { use: 'self' }), 'This device is now the sender');
  const useHereButton = <Button id="h5-tg-use-here" variant="contained" disabled={busy} onClick={() => void useHere()}>{t('Use this device as the sender')}</Button>;
  if (sender.self) {
    return (
      <Box id="h5-tg-relay" data-role="sender" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Hint id="h5-tg-relay-note">{t('This device sends Telegram notifications for all linked devices')}</Hint>
        {relay.relaying && relay.relaying.length ? (
          <>
            <Hint>{t('Devices that send through this one:')}</Hint>
            <Box id="h5-tg-relay-list" component="ul" sx={{ m: 0, pl: 3, typography: 'body2', color: 'text.secondary', overflowWrap: 'anywhere' }}>
              {relay.relaying.map(device => <li key={device.name} data-online={device.online ? '1' : '0'}>{`${device.name} · ${t(device.online ? 'Online' : 'Offline')}`}</li>)}
            </Box>
          </>
        ) : <Hint id="h5-tg-relay-list-empty">{t('No linked device sends through this one yet.')}</Hint>}
        {relay.conflict ? (
          <>
            <Hint id="h5-tg-relay-conflict">{t('Several linked devices are logged in to Telegram. Choose the one that sends; the others stop sending.')}</Hint>
            {useHereButton}
          </>
        ) : null}
      </Box>
    );
  }
  return (
    <Box id="h5-tg-relay" data-role="relaying" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography id="h5-tg-relay-note" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {t(`Telegram notifications are sent through ${sender.name}`)}
        {' · '}
        <Box component="span" id="h5-tg-relay-online" sx={{ color: sender.online ? 'success.main' : 'warning.main' }}>{t(sender.online ? 'Online' : 'Offline')}</Box>
      </Typography>
      <Hint>{t('This device hands its notifications to that device and does not use Telegram itself.')}</Hint>
      <Button id="h5-tg-relay-test" variant="outlined" disabled={busy} onClick={() => void testThrough()}>{t('Send test message')}</Button>
      {status.loggedIn ? (
        <>
          <Hint id="h5-tg-relay-own">{t('This device is logged in to Telegram too, but it does not send. The same login on two devices at once makes them log each other out.')}</Hint>
          {useHereButton}
          <Button id="h5-tg-logout-here" variant="outlined" color="error" disabled={busy} onClick={logout}>{t('Log out here')}</Button>
        </>
      ) : null}
    </Box>
  );
}

function TelegramPart({ telegram, relay, onChanged }) {
  const status = telegram.status || {};
  // Another linked device sends: the login of this device is hidden unless the person asks for it.
  const relaying = Boolean(relay && relay.linked && relay.sender && !relay.sender.self);
  const [loginHere, setLoginHere] = useState(false);
  const [login, setLogin] = useState({ apiId: '', apiHash: '', phone: '', code: '', password: '' });
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [byPhone, setByPhone] = useState(false);
  const [qr, setQr] = useState(null); // { url, svg, expiresAt } of the QR login that is shown
  const [feedback, say] = useFeedback();
  const qrStep = status.step === 'qr';
  // While the QR step is shown: read /qr/status at once and then every 2 seconds (the server exports a new token when the old one expired, and
  // finishes the login after the scan). Nothing is read while the page is hidden; it stops when the step ends or Telegram's page is left. The login itself
  // stays on the server until it times out, so coming back to the page reads the step again and shows the current code.
  useEffect(() => {
    if (!qrStep) { setQr(null); return undefined; }
    let stopped = false;
    let running = false;
    const tick = async (first = false) => {
      if (stopped || running || (!first && document.hidden)) return;
      running = true;
      try {
        const result = await api('GET', `${BASE}/telegram/qr/status`);
        if (stopped) return;
        if (result.step === 'qr') { setQr({ url: result.url, svg: result.svg, expiresAt: result.expiresAt }); return; }
        stopped = true;
        await onChanged();
        say(result.step === 'done' ? 'Logged in' : result.step === 'password' ? 'Enter the two-step verification password' : 'The QR code has expired; start again', result.step === 'expired');
      } catch (error) { if (!stopped) { stopped = true; await onChanged(); say(failure(error), true); } }
      finally { running = false; }
    };
    void tick(true);
    const timer = setInterval(() => void tick(), QR_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [qrStep]);
  useEffect(() => {
    setTarget((status.target && status.target.input) || '');
    // Typed secrets are dropped after each server step, so they do not stay in the page.
    setLogin(current => ({ ...current, apiId: status.apiId ? String(status.apiId) : current.apiId, apiHash: '', code: '', password: '' }));
  }, [telegram]);
  const set = key => event => setLogin(current => ({ ...current, [key]: event.target.value }));
  const run = async (action, done) => {
    setBusy(true);
    try { const result = await action(); await onChanged(); say(typeof done === 'function' ? done(result) : done); }
    catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const start = () => run(() => api('POST', `${BASE}/telegram/start`, { api_id: login.apiId.trim(), api_hash: login.apiHash.trim(), phone: login.phone.trim() }),
    result => (result.codeVia === 'app' ? 'Code sent to your Telegram app' : 'Code sent by SMS'));
  const startQr = () => run(async () => { const result = await api('POST', `${BASE}/telegram/qr/start`, { api_id: login.apiId.trim(), api_hash: login.apiHash.trim() }); if (result.step === 'qr') setQr({ url: result.url, svg: result.svg, expiresAt: result.expiresAt }); return result; },
    result => (result.step === 'done' ? 'Logged in' : result.step === 'password' ? 'Enter the two-step verification password' : ''));
  const verify = () => run(() => api('POST', `${BASE}/telegram/verify`, { code: login.code.trim() }), result => (result.step === 'password' ? 'Enter the two-step verification password' : 'Logged in'));
  const password = () => run(() => api('POST', `${BASE}/telegram/password`, { password: login.password }), 'Logged in');
  const cancel = () => run(() => api('POST', `${BASE}/telegram/cancel`, {}), '');
  const logout = () => { if (confirm(t('Log out of Telegram? The saved session is deleted here and ended on Telegram.'))) void run(() => api('POST', `${BASE}/telegram/logout`, {}), 'Logged out'); };
  const save = () => run(() => api('PUT', `${BASE}/telegram/config`, { target: target.trim() }), 'Saved');
  const test = kind => run(() => api('POST', `${BASE}/telegram/test`, { kind }), result => (kind === 'call' ? `${t('Test call')}: ${t(OUTCOME_LABELS[`call_${result.outcome}`] || result.outcome)}` : 'Test message sent'));
  const account = status.account;
  return (
    <>
      <Typography variant="subtitle2" component="strong">{telegram.label}</Typography>
      <Hint id="h5-tg-state">{status.loggedIn
        ? `${t('Account 1:')} ${account ? `${account.name}${account.username ? ` (@${account.username})` : ''}` : ''} ${status.phone || ''}`
        : t('Not logged in')}</Hint>
      <RelayPart relay={relay} status={status} busy={busy} run={run} logout={logout} />
      {relaying && !status.loggedIn && !loginHere && !['code', 'password', 'qr'].includes(status.step) ? (
        <Button id="h5-tg-login-here" variant="text" disabled={busy} onClick={() => setLoginHere(true)}>{t('Log in on this device instead')}</Button>
      ) : null}
      {!status.loggedIn && (!relaying || loginHere) && !['code', 'password', 'qr'].includes(status.step) ? (
        <>
          <Hint>{t('Account 1 sends the messages and rings account 2. It needs an api_id and api_hash of your own:')}</Hint>
          <Link id="h5-tg-api-link" variant="body2" href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer" sx={{ alignSelf: 'flex-start' }}>https://my.telegram.org/apps</Link>
          <Box id="h5-tg-api-help" component="ol" sx={{ m: 0, pl: 3, typography: 'body2', color: 'text.secondary', overflowWrap: 'anywhere' }}>
            {API_HELP.map(step => <li key={step}>{t(step)}</li>)}
          </Box>
          <Field id="h5-tg-apiid" label="api_id" value={login.apiId} onChange={set('apiId')} htmlInput={{ inputMode: 'numeric' }} />
          <Field id="h5-tg-apihash" label="api_hash" type="password" autoComplete="new-password" value={login.apiHash} onChange={set('apiHash')} placeholder={status.hasApiHash ? t('Saved; leave empty to keep it') : ''} />
          {byPhone ? (
            <>
              <Field id="h5-tg-phone" label="Phone number of account 1 (with country code)" value={login.phone} onChange={set('phone')} htmlInput={{ inputMode: 'tel' }} placeholder="+8613800000000" />
              <Button id="h5-tg-start" variant="contained" disabled={busy} onClick={() => void start()}>{t('Send code')}</Button>
              <Button id="h5-tg-use-qr" variant="text" disabled={busy} onClick={() => setByPhone(false)}>{t('Use a QR code instead')}</Button>
            </>
          ) : (
            <>
              <Button id="h5-tg-qr-start" variant="contained" disabled={busy} onClick={() => void startQr()}>{t('Log in with a QR code')}</Button>
              <Button id="h5-tg-use-phone" variant="text" disabled={busy} onClick={() => setByPhone(true)}>{t('Use phone number instead')}</Button>
            </>
          )}
        </>
      ) : null}
      {qrStep ? (
        <>
          <Hint id="h5-tg-qr-steps">{t('Open Telegram on the phone of account 1 \u2192 Settings \u2192 Devices \u2192 Link Desktop Device \u2192 scan this code')}</Hint>
          <Box id="h5-tg-qr" sx={{ alignSelf: 'center', width: 224, height: 224, p: 1, bgcolor: '#fff', borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {qr && qr.svg
              ? <Box component="img" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`} alt={t('Telegram login QR code')} data-url={qr.url} sx={{ width: '100%', height: '100%', display: 'block' }} />
              : <Typography variant="body2" sx={{ color: '#000' }}>{t('Loading\u2026')}</Typography>}
          </Box>
          <Hint>{t('The code changes about every 30 seconds; this page shows the current one.')}</Hint>
          <Button id="h5-tg-qr-cancel" variant="outlined" disabled={busy} onClick={() => void cancel()}>{t('Cancel')}</Button>
        </>
      ) : null}
      {status.step === 'code' ? (
        <>
          <Field id="h5-tg-code" label="Login code" value={login.code} onChange={set('code')} autoComplete="one-time-code" htmlInput={{ inputMode: 'numeric' }} />
          <Button id="h5-tg-verify" variant="contained" disabled={busy} onClick={() => void verify()}>{t('Log in')}</Button>
          <Button variant="outlined" disabled={busy} onClick={() => void cancel()}>{t('Cancel')}</Button>
        </>
      ) : null}
      {status.step === 'password' ? (
        <>
          <Field id="h5-tg-password" label="Two-step verification password" type="password" autoComplete="current-password" value={login.password} onChange={set('password')} />
          <Button id="h5-tg-password-send" variant="contained" disabled={busy} onClick={() => void password()}>{t('Log in')}</Button>
          <Button variant="outlined" disabled={busy} onClick={() => void cancel()}>{t('Cancel')}</Button>
        </>
      ) : null}
      {status.loggedIn && !relaying ? (
        <>
          <Field id="h5-tg-target" label="Account 2 (username or user id)" value={target} onChange={event => setTarget(event.target.value)} placeholder="@username" />
          <Hint id="h5-tg-target-state">{status.target ? `${t('Sends to:')} ${status.target.name}${status.target.username ? ` (@${status.target.username})` : ''}` : t('No account 2 chosen yet')}</Hint>
          <Hint>{t('For calls, account 2 must allow calls from account 1 (Privacy and Security > Calls); saving account 1 as a contact helps. The call only rings: there is no voice. It hangs up when answered, declined or after the ring time.')}</Hint>
          <Button id="h5-tg-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button id="h5-tg-test" variant="outlined" sx={{ flex: 1 }} disabled={busy || !status.target} onClick={() => void test('message')}>{t('Send test message')}</Button>
            <Button id="h5-tg-test-call" variant="outlined" sx={{ flex: 1 }} disabled={busy || !status.target} onClick={() => void test('call')}>{t('Test call')}</Button>
          </Box>
          <Button id="h5-tg-logout" variant="outlined" color="error" disabled={busy} onClick={logout}>{t('Log out of Telegram')}</Button>
        </>
      ) : null}
      <Feedback id="h5-tg-feedback" feedback={feedback} />
    </>
  );
}

function RulesPart({ data, onChanged }) {
  const notifiers = data.notifiers || [];
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  useEffect(() => {
    const rules = data.rules;
    if (!rules) return;
    const modes = {};
    for (const notifier of notifiers) {
      modes[notifier.name] = {};
      for (const status of STATUS_ORDER) modes[notifier.name][status] = rules.statuses.includes(status) ? ((rules.modes[notifier.name] || {})[status] || 'message') : 'off';
    }
    setForm({
      modes, delay: String(rules.callDelayMinutes), quiet: Boolean(rules.quietHours.enabled), start: rules.quietHours.start, end: rules.quietHours.end,
      messages: String(rules.rateLimit.message), calls: String(rules.rateLimit.call), publicUrl: rules.publicUrl || '',
    });
  }, [data]);
  if (!form) return null;
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const setMode = (name, status) => event => setForm(current => ({ ...current, modes: { ...current.modes, [name]: { ...current.modes[name], [status]: event.target.value } } }));
  const save = async () => {
    // A status notifies when at least one notifier is not off for it.
    const statuses = STATUS_ORDER.filter(status => notifiers.some(notifier => form.modes[notifier.name][status] !== 'off'));
    setBusy(true);
    try {
      await api('PUT', `${BASE}/config`, {
        statuses, modes: form.modes, callDelayMinutes: form.delay.trim(), publicUrl: form.publicUrl.trim(),
        quietHours: { enabled: form.quiet, start: form.start, end: form.end, timeZone: timeZone() },
        rateLimit: { message: form.messages.trim(), call: form.calls.trim() },
      });
      await onChanged();
      say('Saved');
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Typography variant="subtitle2" component="strong" sx={{ mt: 1 }}>{t('When to notify')}</Typography>
      {STATUS_ORDER.map(status => notifiers.map(notifier => (
        <TextField
          key={`${notifier.name}-${status}`} id={`h5-notify-mode-${notifier.name}-${status}`} select size="small" fullWidth
          label={`${t(STATUS_LABELS[status])} · ${notifier.label}`} value={form.modes[notifier.name][status]} onChange={setMode(notifier.name, status)} slotProps={{ select: { native: true } }}
        >
          {(data.modes || ['message', 'call', 'off']).map(mode => <option key={mode} value={mode}>{t(MODE_LABELS[mode] || mode)}</option>)}
        </TextField>
      )))}
      <Hint id="h5-notify-foreground">{t('No message while the session is open on a screen you used in the last 5 minutes.')}</Hint>
      <Field id="h5-notify-delay" label="Call only if still in that status after (minutes, 0 = at once)" type="number" value={form.delay} onChange={set('delay')} htmlInput={{ inputMode: 'numeric', min: 0, max: 1440 }} />
      <FormControlLabel control={<Checkbox checked={form.quiet} onChange={event => setForm(current => ({ ...current, quiet: event.target.checked }))} slotProps={{ input: { id: 'h5-notify-quiet' } }} />} label={t('Quiet hours (nothing is sent)')} />
      {form.quiet ? (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Field id="h5-notify-quiet-start" label="From" type="time" value={form.start} onChange={set('start')} />
          <Field id="h5-notify-quiet-end" label="To" type="time" value={form.end} onChange={set('end')} />
        </Box>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Field id="h5-notify-limit-messages" label="Messages per hour" type="number" value={form.messages} onChange={set('messages')} htmlInput={{ inputMode: 'numeric', min: 1, max: 200 }} />
        <Field id="h5-notify-limit-calls" label="Calls per hour" type="number" value={form.calls} onChange={set('calls')} htmlInput={{ inputMode: 'numeric', min: 0, max: 60 }} />
      </Box>
      <Field id="h5-notify-public-url" label="Page address for links (optional)" value={form.publicUrl} onChange={set('publicUrl')} placeholder={location.origin} />
      <Hint>{t('The same item and status is sent at most once in 10 minutes. A call that is not possible is sent as a message. Telegram may limit accounts that send too much automatically, so keep the limits low.')}</Hint>
      <Button id="h5-notify-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
      <Feedback id="h5-notify-feedback" feedback={feedback} />
      {data.recent && data.recent.length ? (
        <>
          <Typography variant="subtitle2" component="strong" sx={{ mt: 1 }}>{t('Recent notifications')}</Typography>
          <Box id="h5-notify-recent" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {data.recent.slice(0, 10).map((entry, index) => (
              <Typography key={index} variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {`${new Date(entry.at).toLocaleString()} · #${entry.item_id} ${t(STATUS_LABELS[entry.status] || entry.status)} · ${t(OUTCOME_LABELS[entry.outcome] || entry.outcome)}${entry.via ? ` · ${t(`Through ${entry.via}`)}` : ''}${entry.origin ? ` · ${t(`From ${entry.origin}`)}` : ''}`}
              </Typography>
            ))}
          </Box>
        </>
      ) : null}
    </>
  );
}

// GET /api/attention-notify/config, read when a page that needs it opens and again after each change; `changed` also tells the plugin list.
function useNotifierData(onChanged) {
  const [data, setData] = useState(null);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try { setData(await api('GET', `${BASE}/config`)); say(''); }
    catch (error) { say(failure(error), true); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- read when the page opens
  const changed = async () => { await load(); if (onChanged) await onChanged(); };
  return { data, feedback, changed };
}

// Telegram's own section on its page. `onLogin` says whether a login is under way, so the list can show it after the page is left.
export function TelegramSetup({ onChanged, onLogin }) {
  const { data, feedback, changed } = useNotifierData(onChanged);
  const telegram = data && (data.notifiers || []).find(notifier => notifier.name === 'telegram');
  const step = telegram && telegram.status ? telegram.status.step : undefined;
  useEffect(() => { if (onLogin && step !== undefined) onLogin(loginInProgress(step)); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new step counts
  return (
    <Box id="h5-notifier-settings" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Hint>{t('Get a Telegram message or call when an item needs you. The Telegram login of account 1 is full access to that account: it is stored encrypted on this client and never sent to the browser.')}</Hint>
      {telegram ? <TelegramPart telegram={telegram} relay={data.relay || null} onChanged={changed} /> : null}
      <Feedback id="h5-notifier-feedback" feedback={feedback} />
    </Box>
  );
}

// The rules of all notifiers, the page of the row under the plugin list.
export function NotifierRules({ onChanged }) {
  const { data, feedback, changed } = useNotifierData(onChanged);
  return (
    <Box id="h5-notifier-rules" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {data ? <RulesPart data={data} onChanged={changed} /> : <Hint>{t('Loading…')}</Hint>}
      <Feedback id="h5-notifier-rules-feedback" feedback={feedback} />
    </Box>
  );
}

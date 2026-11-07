import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import TextField from './TextField.jsx';
import { api, t } from './common.jsx';
import { Feedback, Field, Group, Hint, failure, useFeedback } from './Form.jsx';

// T-Attention notifier settings: the Telegram login (account 1), account 2, the ring time, and the rules (mode per status and notifier,
// delay before a call, quiet hours, hourly limits, the page address for links). Server side: services/attention-notify.js and
// plugins/notifiers/telegram. The session string and the api_hash never come back from the server; secret fields start empty.
const BASE = '/api/attention-notify';
const STATUS_LABELS = { waiting_user: 'Needs you', review: 'Review', failed: 'Failed', working: 'Working', todo: 'To do', done: 'Done', cancelled: 'Cancelled' };
const STATUS_ORDER = ['waiting_user', 'failed', 'review', 'working', 'todo', 'done', 'cancelled'];
const MODE_LABELS = { off: 'Off', message: 'Message', call: 'Call' };
const OUTCOME_LABELS = {
  sent: 'Sent', fallback_sent: 'Sent as a message (the call failed)', call_failed: 'Call failed', call_timeout: 'Rang, no answer', call_answered: 'Answered',
  call_declined: 'Declined', call_scheduled: 'Call planned', duplicate: 'Skipped: sent less than 10 minutes ago', quiet_hours: 'Skipped: quiet hours',
  rate_limited: 'Skipped: hourly limit reached', skipped: 'Skipped: not set up', error: 'Error',
};
const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

function TelegramPart({ telegram, onChanged }) {
  const status = telegram.status || {};
  const [login, setLogin] = useState({ apiId: '', apiHash: '', phone: '', code: '', password: '' });
  const [target, setTarget] = useState('');
  const [seconds, setSeconds] = useState('30');
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  useEffect(() => {
    setTarget((status.target && status.target.input) || '');
    setSeconds(String(status.callSeconds || 30));
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
  const verify = () => run(() => api('POST', `${BASE}/telegram/verify`, { code: login.code.trim() }), result => (result.step === 'password' ? 'Enter the two-step verification password' : 'Logged in'));
  const password = () => run(() => api('POST', `${BASE}/telegram/password`, { password: login.password }), 'Logged in');
  const cancel = () => run(() => api('POST', `${BASE}/telegram/cancel`, {}), '');
  const logout = () => { if (confirm(t('Log out of Telegram? The saved session is deleted here and ended on Telegram.'))) void run(() => api('POST', `${BASE}/telegram/logout`, {}), 'Logged out'); };
  const save = () => run(() => api('PUT', `${BASE}/telegram/config`, { target: target.trim(), callSeconds: Number(seconds) }), 'Saved');
  const test = kind => run(() => api('POST', `${BASE}/telegram/test`, { kind }), result => (kind === 'call' ? `${t('Test call')}: ${t(OUTCOME_LABELS[`call_${result.outcome}`] || result.outcome)}` : 'Test message sent'));
  const account = status.account;
  return (
    <>
      <Typography variant="subtitle2" component="strong">{telegram.label}</Typography>
      <Hint id="h5-tg-state">{status.loggedIn
        ? `${t('Account 1:')} ${account ? `${account.name}${account.username ? ` (@${account.username})` : ''}` : ''} ${status.phone || ''}`
        : t('Not logged in')}</Hint>
      {!status.loggedIn && status.step !== 'code' && status.step !== 'password' ? (
        <>
          <Hint>{t('Account 1 sends the messages and rings account 2. Create an app at my.telegram.org (API development tools) to get api_id and api_hash.')}</Hint>
          <Field id="h5-tg-apiid" label="api_id" value={login.apiId} onChange={set('apiId')} htmlInput={{ inputMode: 'numeric' }} />
          <Field id="h5-tg-apihash" label="api_hash" type="password" autoComplete="new-password" value={login.apiHash} onChange={set('apiHash')} placeholder={status.hasApiHash ? t('Saved; leave empty to keep it') : ''} />
          <Field id="h5-tg-phone" label="Phone number of account 1 (with country code)" value={login.phone} onChange={set('phone')} htmlInput={{ inputMode: 'tel' }} placeholder="+8613800000000" />
          <Button id="h5-tg-start" variant="contained" disabled={busy} onClick={() => void start()}>{t('Send code')}</Button>
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
      {status.loggedIn ? (
        <>
          <Field id="h5-tg-target" label="Account 2 (username or user id)" value={target} onChange={event => setTarget(event.target.value)} placeholder="@username" />
          <Hint id="h5-tg-target-state">{status.target ? `${t('Sends to:')} ${status.target.name}${status.target.username ? ` (@${status.target.username})` : ''}` : t('No account 2 chosen yet')}</Hint>
          <Field id="h5-tg-seconds" label="Ring time (seconds)" type="number" value={seconds} onChange={event => setSeconds(event.target.value)} htmlInput={{ inputMode: 'numeric', min: 5, max: 120 }} />
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
                {`${new Date(entry.at).toLocaleString()} · #${entry.item_id} ${t(STATUS_LABELS[entry.status] || entry.status)} · ${t(OUTCOME_LABELS[entry.outcome] || entry.outcome)}`}
              </Typography>
            ))}
          </Box>
        </>
      ) : null}
    </>
  );
}

// The notifier settings. `active` turns true when the surrounding group opens; the data is read then (and after each change).
export function NotifierSettings({ active = true }) {
  const [data, setData] = useState(null);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try { setData(await api('GET', `${BASE}/config`)); say(''); }
    catch (error) { say(failure(error), true); }
  };
  useEffect(() => { if (active) void load(); }, [active]);
  const telegram = data && (data.notifiers || []).find(notifier => notifier.name === 'telegram');
  return (
    <Box id="h5-notifier-settings" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Hint>{t('Get a Telegram message or call when an item needs you. The Telegram login of account 1 is full access to that account: it is stored encrypted on this client and never sent to the browser.')}</Hint>
      {telegram ? <TelegramPart telegram={telegram} onChanged={load} /> : null}
      {data ? <RulesPart data={data} onChanged={load} /> : null}
      <Feedback id="h5-notifier-feedback" feedback={feedback} />
    </Box>
  );
}

// The same settings as their own folding group of the settings sheet.
export function NotifierGroup() {
  const [opened, setOpened] = useState(0);
  return (
    <Group id="notify" title="T-Attention notifications" onOpen={() => setOpened(count => count + 1)}>
      {opened ? <NotifierSettings key={opened} active /> : null}
    </Group>
  );
}

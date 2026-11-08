import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import TextField from './TextField.jsx';
import { api, errorText, t } from './common.jsx';
import { Feedback, Field, Hint, useFeedback } from './Form.jsx';
import { BASE } from './attention-feed.mjs';
import { formFromConfig, formProblem, numberInput, valuesFromForm } from './plugin-config-model.mjs';

// The settings of one notifier on its page in Settings → T-Attention → Plugins (PluginSettings.jsx): the enable switch, the form drawn from the
// manifest's `config` schema, Save and Test; read when the page opens. Server side: GET/PUT /api/attention/plugins/:name/config and
// POST /api/attention/plugins/:name/test (services/attention-notify.js). The form echoes the values in effect (defaults filled in); secrets
// never come back from the server: their field starts empty, "Saved; leave empty to keep it" says one is saved, and only a typed value is sent.
// The per-status rules are a page of their own (`onRules`); a plugin's own section (manifest `customUi`, Telegram's login) is drawn above this form.

function ConfigField({ name, field, form, secretsSet, onValue, onClear, busy }) {
  const id = `h5-plugin-config-${name}-${field.key}`;
  const value = form.values[field.key];
  const help = field.help ? t(field.help) : undefined;
  if (field.type === 'boolean') {
    return (
      <Box>
        <FormControlLabel control={<Checkbox checked={value === true} disabled={busy} onChange={event => onValue(field.key, event.target.checked)} slotProps={{ input: { id } }} />} label={t(field.label)} />
        {help ? <Hint>{help}</Hint> : null}
      </Box>
    );
  }
  if (field.type === 'select') {
    return (
      <TextField id={id} select size="small" fullWidth label={t(field.label)} value={value} helperText={help} disabled={busy} onChange={event => onValue(field.key, event.target.value)} slotProps={{ select: { native: true } }}>
        {field.default === undefined ? <option value="">{t('Not chosen')}</option> : null}
        {(field.options || []).map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
      </TextField>
    );
  }
  if (field.type === 'secret') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Field
          id={id} label={field.label} type="password" autoComplete="new-password" value={value} helperText={help} disabled={busy}
          placeholder={secretsSet[field.key] ? t('Saved; leave empty to keep it') : (field.placeholder || '')} onChange={event => onValue(field.key, event.target.value)}
        />
        {secretsSet[field.key] ? <Button size="small" color="error" className="h5-plugin-config-clear" disabled={busy} onClick={() => onClear(field.key)} sx={{ alignSelf: 'flex-start' }}>{t('Remove the saved value')}</Button> : null}
      </Box>
    );
  }
  return (
    <Field
      id={id} label={field.label} type={field.type === 'number' ? 'number' : 'text'} value={value} helperText={help} disabled={busy}
      placeholder={field.placeholder || ''} onChange={event => onValue(field.key, event.target.value)} htmlInput={field.type === 'number' ? numberInput(field) : undefined}
    />
  );
}

export default function PluginConfigForm({ notifier, onChanged, onRules }) {
  const name = notifier.name;
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(true); // the first read starts at once
  const [feedback, say] = useFeedback();
  const url = `${BASE}/plugins/${encodeURIComponent(name)}`;
  const take = next => { setConfig(next); setForm(formFromConfig(next)); };
  const run = async (work, done) => {
    setBusy(true);
    try { const result = await work(); if (done) done(result); } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); } finally { setBusy(false); }
  };
  useEffect(() => { void run(async () => take(await api('GET', `${url}/config`))); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps -- read when the page opens
  const onValue = (key, value) => setForm(current => ({ ...current, values: { ...current.values, [key]: value } }));
  const save = body => run(async () => { take(await api('PUT', `${url}/config`, body)); if (onChanged) await onChanged(); }, () => say('Saved'));
  const saveForm = () => {
    const problem = formProblem(config.schema, form, { secretsSet: form.secretsSet });
    if (problem) { say(problem.message, true); return; }
    void save({ values: valuesFromForm(config.schema, form) });
  };
  const clear = key => void save({ values: valuesFromForm(config.schema, form, { clear: [key] }) });
  const test = () => run(() => api('POST', `${url}/test`), result => say(result.ok ? (result.message || 'Test sent') : `${t('Test failed')}: ${t(result.message || '')}`, !result.ok));
  const schema = (config && config.schema) || [];
  return (
    <Box className="h5-plugin-config" data-name={name} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {!config && busy ? <Hint>{t('Loading…')}</Hint> : null}
      {config && form ? (
        <Box className="h5-plugin-config-body" sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <FormControlLabel
            control={<Switch checked={form.enabled} disabled={busy} onChange={event => void save({ enabled: event.target.checked })} slotProps={{ input: { id: `h5-plugin-enabled-${name}` } }} />}
            label={form.enabled ? t('Turned on') : t('Turned off: sends nothing')} sx={{ ml: 0, gap: 1 }}
          />
          {schema.map(field => <ConfigField key={field.key} name={name} field={field} form={form} secretsSet={form.secretsSet} onValue={onValue} onClear={clear} busy={busy} />)}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {schema.length ? <Button variant="contained" className="h5-plugin-config-save" disabled={busy} onClick={saveForm}>{t('Save')}</Button> : null}
            {config.test ? <Button variant="outlined" className="h5-plugin-config-test" disabled={busy || !form.enabled} onClick={() => void test()}>{t('Test')}</Button> : null}
            <Button className="h5-plugin-config-rules" onClick={onRules}>{t('Message and call rules')}</Button>
          </Box>
        </Box>
      ) : null}
      <Feedback id={`h5-plugin-config-feedback-${name}`} feedback={feedback} />
    </Box>
  );
}

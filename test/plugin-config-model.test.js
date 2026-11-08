// The pure logic of the per-plugin settings form (scripts/h5-shell/plugin-config-model.mjs): the form state from GET
// /api/attention/plugins/:name/config, the PUT values from the form (secrets typed only, emptied fields back to the default) and the checks
// made before saving.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'plugin-config-model.mjs')).href);
const SCHEMA = [
  { key: 'url', label: 'Webhook URL', type: 'string', required: true },
  { key: 'token', label: 'Token', type: 'secret', required: true },
  { key: 'seconds', label: 'Ring time (seconds)', type: 'number', integer: true, min: 5, max: 120, default: 30 },
  { key: 'loud', label: 'Loud', type: 'boolean', default: false },
  { key: 'level', label: 'Level', type: 'select', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }], default: 'low' },
];

test('formFromConfig echoes the values in effect; a secret starts empty and says whether one is saved', async () => {
  const { formFromConfig } = await load();
  const form = formFromConfig({ enabled: false, schema: SCHEMA, values: { url: 'https://x', token: { set: true }, seconds: 45, loud: true, level: 'high' } });
  assert.deepEqual(form, { enabled: false, values: { url: 'https://x', token: '', seconds: '45', loud: true, level: 'high' }, secretsSet: { token: true } });
  const empty = formFromConfig({ enabled: true, schema: SCHEMA, values: { seconds: 30, token: { set: false } } });
  assert.deepEqual(empty, { enabled: true, values: { url: '', token: '', seconds: '30', loud: false, level: '' }, secretsSet: { token: false } });
  assert.deepEqual(formFromConfig(null), { enabled: true, values: {}, secretsSet: {} });
});

test('valuesFromForm: an empty secret is left out (kept), a typed one is sent, clear sends null; emptied fields are sent as ""', async () => {
  const { valuesFromForm } = await load();
  const form = { values: { url: ' https://y ', token: '', seconds: '60', loud: true, level: 'high' } };
  assert.deepEqual(valuesFromForm(SCHEMA, form), { url: 'https://y', seconds: 60, loud: true, level: 'high' });
  assert.deepEqual(valuesFromForm(SCHEMA, { values: { ...form.values, token: 's3cret' } }).token, 's3cret');
  assert.equal(valuesFromForm(SCHEMA, form, { clear: ['token'] }).token, null);
  assert.deepEqual(valuesFromForm(SCHEMA, { values: { url: '', token: '', seconds: '', loud: false, level: '' } }), { url: '', seconds: '', loud: false, level: '' });
});

test('formProblem: required fields (a saved secret counts), numbers and their range', async () => {
  const { formProblem } = await load();
  const good = { values: { url: 'https://x', token: '', seconds: '30', loud: false, level: 'low' } };
  assert.equal(formProblem(SCHEMA, good, { secretsSet: { token: true } }), null);
  assert.deepEqual(formProblem(SCHEMA, good, { secretsSet: { token: false } }), { key: 'token', message: 'Token is required' });
  assert.deepEqual(formProblem(SCHEMA, { values: { ...good.values, url: '  ' } }, { secretsSet: { token: true } }), { key: 'url', message: 'Webhook URL is required' });
  assert.deepEqual(formProblem(SCHEMA, { values: { ...good.values, seconds: '2' } }, { secretsSet: { token: true } }), { key: 'seconds', message: 'Ring time (seconds) is out of range' });
  assert.deepEqual(formProblem(SCHEMA, { values: { ...good.values, seconds: '7.5' } }, { secretsSet: { token: true } }), { key: 'seconds', message: 'Ring time (seconds) must be a whole number' });
  assert.equal(formProblem(SCHEMA, { values: { ...good.values, seconds: '' } }, { secretsSet: { token: true } }), null, 'empty goes back to the default');
});

test('numberInput gives the HTML attributes of a number field', async () => {
  const { numberInput } = await load();
  assert.deepEqual(numberInput({ integer: true, min: 5, max: 120 }), { inputMode: 'numeric', min: 5, max: 120, step: 1 });
  assert.deepEqual(numberInput({}), { inputMode: 'decimal' });
});

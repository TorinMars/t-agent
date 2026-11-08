// The pure logic of the per-plugin settings form (PluginConfigForm.jsx): the form state from GET /api/attention/plugins/:name/config and the
// `values` of the PUT from the form (see "Plugin settings from the manifest" in DESIGN.md). No DOM, no requests: test/plugin-config-model.test.js
// runs it in Node.
//
// Rules (they match services/attention-notify.js normalizeConfigValues):
// - every field shows the value in effect (the saved one, else the default); a secret field always starts empty and shows whether one is saved;
// - an empty secret is left out of the PUT, so the saved secret is kept; clearing a saved secret is a separate action (null);
// - an emptied text, number or select field is sent as '' and goes back to the manifest default.

const fields = config => (config && Array.isArray(config.schema) ? config.schema.filter(field => field && typeof field.key === 'string') : []);

// { enabled, values: { <key>: string | boolean }, secretsSet: { <key>: boolean } } for the form inputs.
export function formFromConfig(config) {
  const values = {};
  const secretsSet = {};
  const saved = (config && config.values && typeof config.values === 'object') ? config.values : {};
  for (const field of fields(config)) {
    const value = saved[field.key];
    if (field.type === 'secret') { values[field.key] = ''; secretsSet[field.key] = Boolean(value && value.set); continue; }
    if (field.type === 'boolean') { values[field.key] = value === true; continue; }
    values[field.key] = value === undefined || value === null ? '' : String(value);
  }
  return { enabled: !config || config.enabled !== false, values, secretsSet };
}

// The `values` object of the PUT. Secrets the person did not type are left out (kept on the server); clear lists secrets to remove (null).
export function valuesFromForm(schema, form, { clear = [] } = {}) {
  const out = {};
  const values = (form && form.values) || {};
  for (const field of Array.isArray(schema) ? schema : []) {
    const value = values[field.key];
    if (field.type === 'secret') {
      if (clear.includes(field.key)) out[field.key] = null;
      else if (typeof value === 'string' && value !== '') out[field.key] = value;
      continue;
    }
    if (field.type === 'boolean') { out[field.key] = value === true; continue; }
    const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
    if (field.type === 'number') { out[field.key] = text === '' ? '' : Number(text); continue; }
    out[field.key] = text;
  }
  return out;
}

// The first problem the page can see before saving (the server checks again): a required field without a value, a number out of range.
// Returns { key, message } or null; `message` is an English sentence ("<label> is required"), translated by the '{1} is required' style
// entries of public/js/i18n-zh-extra.js.
export function formProblem(schema, form, { secretsSet = {} } = {}) {
  const values = (form && form.values) || {};
  for (const field of Array.isArray(schema) ? schema : []) {
    const value = values[field.key];
    const empty = field.type === 'boolean' ? false : !(typeof value === 'string' ? value.trim() : value);
    if (field.required && empty && field.default === undefined && !(field.type === 'secret' && secretsSet[field.key])) return { key: field.key, message: `${field.label} is required` };
    if (field.type === 'number' && !empty) {
      const number = Number(String(value).trim());
      if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number))) return { key: field.key, message: `${field.label} must be a ${field.integer ? 'whole number' : 'number'}` };
      if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) return { key: field.key, message: `${field.label} is out of range` };
    }
  }
  return null;
}

// The HTML input attributes of a number field.
export function numberInput(field) {
  const out = { inputMode: field.integer ? 'numeric' : 'decimal' };
  if (field.min !== undefined) out.min = field.min;
  if (field.max !== undefined) out.max = field.max;
  if (field.integer) out.step = 1;
  return out;
}

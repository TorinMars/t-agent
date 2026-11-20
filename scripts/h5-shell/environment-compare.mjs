// The table of Settings → Devices → Environment ("Environment" in docs/design/environment-compare.md): the tools agent sessions rely on, a row per
// tool and a column per machine, from each machine's own tools list (GET /api/environment/tools here, /api/device-settings/<id>/environment/tools for
// a linked device). Pure functions, no React; English texts (the page translates them).
//
// A column: { key, name, state, report }   state 'ready' (report: { checked_at, platform, tools: [{ id, name, status, value, fix }] }), 'loading',
//                                          'offline', 'update' (too old to tell) or 'failed'.
// A tool's status: 'ok' (value: its version, a name such as `zsh`, or '' when found without a version), 'missing' (fix: the install hint of the
// environment check), 'not-needed' (Swift off macOS), 'unknown' (the probe failed or took too long).
import { orderDevices } from './device-order.mjs';

const numeric = value => /^v?\d+(?:\.\d+)+$/.test(value);
const parts = value => value.replace(/^v/, '').split('.').map(Number);
function newer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
const same = value => String(value || '').replace(/^v(?=\d)/, '');

// The machines in one order on every page, whichever engine serves it: by name (numbers in names by value), so T01's page and K01's page draw the
// same table (the shared rule of device-order.mjs). `columns`: [{ key, name, instanceId?, ... }].
export const orderColumns = columns => orderDevices(columns);

// The value the others are compared with, among the found values: the newest version when they are all versions, else the most common one
// (on a tie the first column's).
function reference(values) {
  if (values.every(numeric)) return values.reduce((best, value) => (newer(value, best) ? value : best));
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

// One cell: { text, tone, fix }. tone: 'same', 'diff' (a value that is not the reference, orange), 'missing' (red), 'na' (not needed), 'unknown'
// (the probe could not tell, or the machine has no such row), 'none' (the column has no report: its header says why).
function cellOf(column, tool) {
  if (column.state !== 'ready') return { text: '', tone: 'none', fix: '' };
  if (!tool) return { text: '—', tone: 'unknown', fix: '' };
  if (tool.status === 'ok') return { text: tool.value || 'ok', tone: 'same', fix: '', value: same(tool.value || 'ok') };
  if (tool.status === 'missing') return { text: 'not installed', tone: 'missing', fix: tool.fix || '' };
  if (tool.status === 'not-needed') return { text: 'not needed', tone: 'na', fix: '' };
  return { text: 'unknown', tone: 'unknown', fix: '' };
}

// { rows: [{ id, name, cells: [...] }], differences, missing, ready }: `differences` counts the rows whose found values are not all the same,
// `missing` the rows where a machine lacks the tool; `ready` the columns with a report. Rows in the order of the first report that has them.
export function compareTools(columns) {
  const ids = [];
  const names = new Map();
  for (const column of columns) {
    if (column.state !== 'ready' || !column.report || !Array.isArray(column.report.tools)) continue;
    for (const tool of column.report.tools) {
      if (!tool || typeof tool.id !== 'string') continue;
      if (!names.has(tool.id)) { ids.push(tool.id); names.set(tool.id, String(tool.name || tool.id)); }
    }
  }
  let differences = 0;
  let missing = 0;
  const rows = ids.map(id => {
    const cells = columns.map(column => cellOf(column, column.state === 'ready' && column.report && Array.isArray(column.report.tools) ? column.report.tools.find(tool => tool && tool.id === id) : null));
    const found = cells.filter(cell => cell.tone === 'same');
    const distinct = new Set(found.map(cell => cell.value));
    if (distinct.size > 1) {
      const best = reference(found.map(cell => cell.value));
      for (const cell of found) if (cell.value !== best) cell.tone = 'diff';
      differences += 1;
    }
    if (cells.some(cell => cell.tone === 'missing')) missing += 1;
    for (const cell of cells) delete cell.value;
    return { id, name: names.get(id), cells };
  });
  return { rows, differences, missing, ready: columns.filter(column => column.state === 'ready').length };
}

// The words under the table and on the Devices row ("2 differences · 1 missing"); '' when there is nothing to say. `t` translates.
export function summaryText({ differences = 0, missing = 0 } = {}, t = text => text) {
  const said = [];
  if (differences) said.push(differences === 1 ? t('1 difference') : t(`${differences} differences`));
  if (missing) said.push(t(`${missing} missing`));
  return said.join(' · ');
}

// What a column's header says under the machine's name when it has no report, '' when it has one.
export function columnNote(column) {
  if (column.state === 'loading') return 'Checking…';
  if (column.state === 'offline') return 'Offline';
  if (column.state === 'update') return `Update ${column.name} first`;
  if (column.state === 'failed') return 'Could not be read';
  return '';
}

// The state of a linked device's column before its list is read: 'offline' (not online), 'update' (too old: no `settings:device`, or no
// `environment:tools` in its /v1/info), or '' when its list can be read. `environment` null: not known yet, read it and see.
export function deviceState(device) {
  if (!device || !device.online) return 'offline';
  if (device.supported === false || device.environment === false) return 'update';
  return '';
}

// The install hints of the missing tools: [{ key, text }] with "<machine> · <tool>: <hint>" parts kept apart for translation.
export function missingHints(columns, rows) {
  const hints = [];
  for (const row of rows) {
    row.cells.forEach((cell, index) => {
      if (cell.tone === 'missing' && cell.fix) hints.push({ key: `${row.id}:${columns[index].key}`, machine: columns[index].name, tool: row.name, fix: cell.fix });
    });
  }
  return hints;
}

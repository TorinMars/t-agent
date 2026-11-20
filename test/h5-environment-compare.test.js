// The table of Settings → Devices → Environment (scripts/h5-shell/environment-compare.mjs): rows per tool, columns per machine by name, the
// newest version as the reference (others orange), missing tools red with their hint, the summary of the Devices row, and the column notes. The
// real table is scripts/test-h5-environment-browser.cjs; the tools list itself test/environment-check.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-env-compare-'));
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'environment-compare.mjs')).href);

const tool = (id, value, status = 'ok', extra = {}) => ({ id, name: { node: 'Node.js', claude: 'Claude Code', codex: 'Codex', git: 'git', tcli: 'tcli', shell: 'Shell', swift: 'Swift (Mac app)' }[id] || id, status, value, ...extra });
const T01 = { key: 'local', name: 'T01', state: 'ready', report: { tools: [tool('node', 'v24.22.0'), tool('claude', '2.1.323'), tool('codex', '0.167.1'), tool('git', '2.50.1'), tool('tcli', ''), tool('swift', '6.0'), tool('shell', 'zsh')] } };
const K01 = { key: 'remote:2', name: 'K01', state: 'ready', report: { tools: [tool('node', '24.22.0'), tool('claude', '2.1.310'), tool('codex', '', 'missing', { fix: 'Install Codex' }), tool('git', '2.39.5'), tool('tcli', ''), tool('swift', '6.0'), tool('shell', 'zsh')] } };

test('the mockup: two differences (older versions orange), one missing (red with its hint), the rest the same', async () => {
  const { compareTools, summaryText, missingHints } = await load();
  const columns = [T01, K01];
  const result = compareTools(columns);
  assert.deepEqual(result.rows.map(row => [row.name, ...row.cells.map(cell => `${cell.text}:${cell.tone}`)]), [
    ['Node.js', 'v24.22.0:same', '24.22.0:same'],
    ['Claude Code', '2.1.323:same', '2.1.310:diff'],
    ['Codex', '0.167.1:same', 'not installed:missing'],
    ['git', '2.50.1:same', '2.39.5:diff'],
    ['tcli', 'ok:same', 'ok:same'],
    ['Swift (Mac app)', '6.0:same', '6.0:same'],
    ['Shell', 'zsh:same', 'zsh:same'],
  ]);
  assert.deepEqual([result.differences, result.missing, result.ready], [2, 1, 2]);
  assert.equal(summaryText(result), '2 differences · 1 missing');
  assert.deepEqual(missingHints(columns, result.rows), [{ key: 'codex:remote:2', machine: 'K01', tool: 'Codex', fix: 'Install Codex' }]);
});

test('the newest version is the reference wherever it is; numbers compare by value, not as text', async () => {
  const { compareTools } = await load();
  const make = (key, name, value) => ({ key, name, state: 'ready', report: { tools: [tool('git', value)] } });
  const cells = compareTools([make('a', 'A', '2.9.0'), make('b', 'B', '2.10.0'), make('c', 'C', '2.10')]).rows[0].cells;
  assert.deepEqual(cells.map(cell => cell.tone), ['diff', 'same', 'diff'], '2.10.0 is newer than 2.9.0; 2.10 is a different value');
  const names = compareTools([make('a', 'A', 'bash'), make('b', 'B', 'zsh'), make('c', 'C', 'zsh')]).rows[0].cells;
  assert.deepEqual(names.map(cell => cell.tone), ['diff', 'same', 'same'], 'a name: the most common value is the reference');
});

test('columns without a report, a tool an older engine does not list, not needed and unknown values never count as differences', async () => {
  const { compareTools, summaryText, columnNote, deviceState } = await load();
  const linux = { key: 'remote:3', name: 'Linux', state: 'ready', report: { tools: [tool('git', '2.50.1'), tool('swift', '', 'not-needed'), tool('claude', '', 'unknown')] } };
  const away = { key: 'remote:4', name: 'Away', state: 'offline', report: null };
  const result = compareTools([T01, linux, away]);
  const row = id => result.rows.find(item => item.id === id).cells.map(cell => cell.tone);
  assert.deepEqual(row('swift'), ['same', 'na', 'none']);
  assert.deepEqual(row('claude'), ['same', 'unknown', 'none']);
  assert.deepEqual(row('node'), ['same', 'unknown', 'none'], 'not in its list: a dash');
  assert.deepEqual([result.differences, result.missing], [0, 0]);
  assert.equal(summaryText(result), '');
  assert.equal(summaryText({ differences: 1, missing: 0 }), '1 difference');
  assert.equal(summaryText({ differences: 0, missing: 3 }), '3 missing');
  assert.deepEqual(['loading', 'offline', 'update', 'failed', 'ready'].map(state => columnNote({ name: 'K01', state })), ['Checking…', 'Offline', 'Update K01 first', 'Could not be read', '']);
  assert.equal(deviceState({ online: false, supported: true, environment: true }), 'offline');
  assert.equal(deviceState({ online: true, supported: false, environment: null }), 'update');
  assert.equal(deviceState({ online: true, supported: true, environment: false }), 'update', 'a device without environment:tools');
  assert.equal(deviceState({ online: true, supported: true, environment: null }), '', 'not known yet: read it and see');
});

test('the machines are in one order whichever engine serves the page: by name, numbers by value', async () => {
  const { orderColumns } = await load();
  const names = list => orderColumns(list.map((name, index) => ({ key: `k${index}`, name }))).map(column => column.name);
  assert.deepEqual(names(['T01', 'K01']), ['K01', 'T01']);
  assert.deepEqual(names(['K01', 'T01']), ['K01', 'T01']);
  assert.deepEqual(names(['m10', 'M2', 'a']), ['a', 'M2', 'm10']);
});

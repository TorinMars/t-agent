// Browser storage of the page goes through one registry (public/js/local-keys.js), and every key it keeps is declared there with its reason ("Key
// audit" in docs/design/shared-page-state.md). This guards the rule "One experience on every device and engine" of AGENTS.md: person-level state
// belongs on the server (the shared page state), never in one browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-local-keys-data-'));
const registry = require('../public/js/local-keys.js');

const ROOT = path.join(__dirname, '..');
const RULE = 'AGENTS.md, "One experience on every device and engine": state that describes the person and their work is kept on the server and shared by '
  + 'all linked engines, never only in one browser; allowed per browser only: what is tied to that hardware or that browser, and what the person '
  + 'explicitly sets for one device. Keep person-level state on the server (the shared page state, public/js/page-state.js), or declare the key in '
  + 'public/js/local-keys.js with its category and reason (and in the "Key audit" table of docs/design/shared-page-state.md).';
const REGISTRY = 'public/js/local-keys.js';
// Built bundles and vendored or generated files: their sources are scanned instead.
const BUILT = new Set(['public/js/h5-shell.js', 'public/js/agent-chat-ui.js', 'public/js/mindmap-ui.js', 'public/js/notebook-ui.js', 'public/js/markdown-view.js']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(relative));
    else if (/\.(js|mjs|jsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}
function sources() {
  const page = fs.readdirSync(path.join(ROOT, 'public/js')).filter(name => name.endsWith('.js')).map(name => `public/js/${name}`)
    .filter(file => !BUILT.has(file) && !/^public\/js\/i18n-zh-/.test(file));
  return [...page, ...walk('scripts/h5-shell'), ...walk('scripts/agent-chat'), ...walk('scripts/mindmap'), ...walk('scripts/notebook')].filter(file => file !== REGISTRY);
}
// The code without its comments (line comments not inside a string or after a scheme's `:`, block comments), lines kept.
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' ')).split('\n').map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

test('no page source touches localStorage, sessionStorage or indexedDB except the registry', () => {
  const found = [];
  for (const file of sources()) {
    code(fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n').forEach((line, index) => {
      if (/\b(localStorage|sessionStorage|indexedDB)\b/.test(line)) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], `Browser storage is used outside ${REGISTRY}. ${RULE}`);
});

// ---- Every key used through the registry is declared ----
// A key expression as a pattern: a string as it is, a template with `*` for each `${...}`; a name: the string or template it is set to in the same
// file; a call of a key builder: its pattern. null when it cannot be read (the call passes a key it got from its caller: a wrapper).
// `export const NAME = '...'` of every scanned source: a key constant imported from another module.
const EXPORTED = new Map();
for (const file of sources()) {
  for (const [, name, value] of fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/export const ([A-Z_]+) = '([^']*)'/g)) EXPORTED.set(name, value);
}
const BUILDERS = { DRAFT_KEY: ['h5-mindmap-draft:*'], legacyMapKeyOf: ['pane:*:h5-mindmap'] };
function patternsOf(arg, text) {
  const value = arg.trim();
  let match = /^'([^']*)'$/.exec(value) || /^"([^"]*)"$/.exec(value);
  if (match) return [match[1]];
  match = /^`([^`]*)`$/.exec(value);
  if (match) return [match[1].replace(/\$\{[^}]*\}/g, '*')];
  match = /^([A-Za-z_$][\w$]*)\(/.exec(value);
  if (match && BUILDERS[match[1]]) return BUILDERS[match[1]];
  match = /^([A-Za-z_$][\w$]*)$/.exec(value);
  if (match) {
    const defined = new RegExp(`(?:const|let)\\s+${match[1]}\\s*=\\s*(['"\`])([^'"\`]*?(?:\\$\\{[^}]*\\}[^'"\`]*?)*)\\1`).exec(text);
    if (defined) return [defined[2].replace(/\$\{[^}]*\}/g, '*')];
    if (EXPORTED.has(match[1])) return [EXPORTED.get(match[1])]; // a constant another module exports (STORAGE_KEY of columns.mjs)
  }
  return null;
}
// Is a pattern declared? Exactly a declared key, or a stored name it matches; a leading `*` is a pane's prefix (`pane:<id>:`).
function isDeclared(pattern, area) {
  const keys = registry.KEYS.filter(entry => entry.area === area);
  const exact = name => keys.find(entry => entry.key === name);
  if (exact(pattern)) return true;
  if (pattern.startsWith('pane:*:')) { const entry = exact(pattern.slice(7)); return Boolean(entry && entry.pane); }
  if (pattern.startsWith('*')) { const entry = exact(pattern.slice(1)); return Boolean(entry && entry.pane); }
  return !pattern.includes('*') && Boolean(registry.declared(pattern, area));
}
// The calls that reach the registry, and what is put before the key (h5.js `store` adds `h5-`).
const CALLS = [
  { regex: /\b(?:TALocalKeys|LocalKeys|keysOf|keys|keys\(\))\.(?:get|set|remove)\(([^,)]+)/g },
  { regex: /\blocal(?:Get|Set)\(([^,)]+(?:\([^)]*\))?)/g },
  { regex: /\b(?:readShared|writeShared|useShared)\(([^,)]+)/g, shared: true },
  { regex: /\.(?:getItem|setItem|removeItem)\(([^,)]+)/g },
  { regex: /\bstore\.(?:get|set)\(([^,)]+)/g, file: 'public/js/h5.js', prefix: 'h5-' },
];
const SERVER_ONLY = 'h5-column:';
// Wrappers that pass on a key their caller chose (the caller is checked): the file and the argument.
const WRAPPERS = new Set([
  'public/js/h5.js storeKey(key', 'scripts/h5-shell/attention-feed.mjs key', 'scripts/h5-shell/pane.mjs key', 'public/js/page-state.js key', 'public/js/page-state.js name', 'public/js/terminal-owner.js key',
  'scripts/h5-shell/local-keys.mjs key', 'scripts/h5-shell/shared-store.mjs key', 'scripts/h5-shell/common.jsx key', 'scripts/h5-shell/local-keys.mjs prefix',
]);

test('every key used through the registry is declared there', () => {
  const unknown = [];
  const unreadable = [];
  for (const file of sources()) {
    const text = code(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const call of CALLS) {
      if (call.file && call.file !== file) continue;
      for (const match of text.matchAll(call.regex)) {
        const arg = match[1].trim();
        if (WRAPPERS.has(`${file} ${arg}`)) continue;
        const patterns = patternsOf(arg, text);
        const line = text.slice(0, match.index).split('\n').length;
        const rest = text.slice(match.index, text.indexOf('\n', match.index));
        const area = /'session'/.test(rest) ? 'session' : 'local'; // the area is the call's last argument, on the same line
        // The session of a column is kept on the server only: the shared page state never writes it to the browser (public/js/page-state.js).
        if (call.shared && patterns && patterns.every(pattern => pattern.startsWith(SERVER_ONLY))) continue;
        if (!patterns) { unreadable.push(`${file}:${line}: ${arg}`); continue; }
        for (const pattern of patterns) if (!isDeclared(`${call.prefix || ''}${pattern}`, area)) unknown.push(`${file}:${line}: ${call.prefix || ''}${pattern}`);
      }
    }
  }
  assert.deepEqual(unknown, [], `A key is used that ${REGISTRY} does not declare. ${RULE}`);
  assert.deepEqual(unreadable, [], `A storage key is not a string, a template, a constant of its file or a known key builder, so it cannot be checked. ${RULE}`);
  // The keys of the shared page state's cache (public/js/page-state.js) are declared too.
  for (const name of require('../public/js/page-state.js').MOVED) assert.ok(isDeclared(name, 'local'), `${name} (page-state.js MOVED) is declared. ${RULE}`);
});

test('the registry: every key has one of the four categories and a reason, and an undeclared key is refused', () => {
  for (const entry of registry.KEYS) {
    assert.ok(registry.CATEGORIES.includes(entry.category), `${entry.key}: category ${entry.category}`);
    assert.ok(['local', 'session'].includes(entry.area), entry.key);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 10, `${entry.key} has a reason`);
  }
  assert.deepEqual(registry.CATEGORIES, ['hardware', 'browser', 'device-setting', 'cache-of-shared-state']);
  const kept = new Map();
  const fake = { getItem: key => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => { kept.set(key, value); }, removeItem: key => { kept.delete(key); }, get length() { return kept.size; }, key: i => [...kept.keys()][i] };
  const keys = registry.build({ localStorage: fake, sessionStorage: fake });
  assert.equal(keys.set('h5-task-list-tab', 'recent'), true);
  assert.equal(keys.get('h5-task-list-tab'), 'recent');
  assert.equal(keys.set('my-new-preference', 'x'), false, 'an undeclared key is not written');
  kept.set('my-new-preference', 'x');
  assert.equal(keys.get('my-new-preference'), null, 'nor read');
  assert.deepEqual(keys.refused(), ['local:my-new-preference']);
  assert.equal(keys.set('pane:ab12:h5-source', 'local'), true, 'a pane keeps its own copy of a pane key');
  assert.equal(keys.set('pane:ab12:ta-lang', 'zh'), false, 'not of a key that has none');
  assert.equal(keys.set('h5-terminal:remote:3:12', 'k1'), true, 'a pattern');
  assert.equal(keys.forget('pane:ab12:'), 1);
  assert.equal(keys.get('terminal-client-id', 'local'), null, 'a session key is not a local one');
});

test('the registry and the "Key audit" table of docs/design/shared-page-state.md list the same keys, with the same categories', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/design/shared-page-state.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Key audit'), doc.indexOf('\n## ', doc.indexOf('## Key audit') + 5));
  const table = new Map();
  for (const line of section.split('\n').filter(row => /^\| `/.test(row))) {
    const [keysCell, storage, category] = line.split('|').slice(1).map(cell => cell.trim());
    for (const [, key] of keysCell.matchAll(/`([^`]+)`/g)) table.set(key.replace(/<[^>]+>/g, '*'), { area: storage.split(',')[0].trim(), category, pane: /\bpane\b/.test(storage) });
  }
  const declared = new Map(registry.KEYS.map(entry => [entry.key, { area: entry.area, category: entry.category, pane: entry.pane }]));
  assert.deepEqual([...table.keys()].sort(), [...declared.keys()].sort(), `The table and ${REGISTRY} differ. ${RULE}`);
  for (const [key, row] of table) assert.deepEqual(row, declared.get(key), `${key}: the table and the registry agree on storage, category and pane`);
});

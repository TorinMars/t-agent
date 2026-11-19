// Every key the server keeps in system_state and engine_identity is declared with its scope in one registry (lib/server-state-keys.js; the table in
// docs/design/server-state-keys.md). The server twin of test/local-storage-keys.test.js. This guards the rule "One experience on every device and
// engine" of AGENTS.md: state that describes the person is shared by all linked engines, and what stays on one machine says why.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-server-state-keys-data-'));
const Database = require('better-sqlite3');
const registry = require('../lib/server-state-keys');

const ROOT = path.join(__dirname, '..');
const RULE = 'AGENTS.md, "One experience on every device and engine": state that describes the person and their work is kept on the server and '
  + 'shared by all linked engines; allowed per device only: what is tied to that machine, and what the person explicitly sets for one device. '
  + 'Declare every system_state / engine_identity key in lib/server-state-keys.js with its scope (shared: by which sync, personal: by which sync, '
  + 'device: why, runtime: of what), and in the table of docs/design/server-state-keys.md.';
const REGISTRY = 'lib/server-state-keys.js';
const DOC = 'docs/design/server-state-keys.md';
const TABLES = /\b(system_state|engine_identity)\b/;

// ---- Sources ----
const DIRS = ['db', 'lib', 'services', 'routes', 'middleware', 'plugins', 'scripts'];
// Page code (scanned by test/local-storage-keys.test.js) and the Mac app: they never open the database.
const NOT_SERVER = new Set(['scripts/h5-shell', 'scripts/agent-chat', 'scripts/mindmap', 'scripts/mac-app', 'plugins/marketplace']);
function walk(dir) {
  const out = [];
  if (!fs.existsSync(path.join(ROOT, dir))) return out;
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.name === 'node_modules' || NOT_SERVER.has(relative)) continue;
    if (entry.isDirectory()) out.push(...walk(relative));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(relative);
  }
  return out;
}
const sources = () => ['server.js', 'config.js', ...DIRS.flatMap(walk)].filter(file => file !== REGISTRY && fs.existsSync(path.join(ROOT, file)));
// The code without its comments, lines kept. Strings, templates and regular expression literals are stepped over, so a `/*` or `//` inside one
// (a glob, an address) stays.
function code(text) {
  const out = text.split(''); // UTF-16 units, so indexes stay those of the text; comments are blanked in place
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '/' && next === '/') { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; blank(i, stop); i = stop; continue; }
    if (char === '/' && next === '*') { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2; blank(i, stop); i = stop; continue; }
    if (/['"`]/.test(char)) { const end = literalEnd(text, i); i = end < 0 ? text.length : end + 1; continue; }
    if (char === '/') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(out[k])) k -= 1;
      const before = out.slice(Math.max(0, k - 9), k + 1).join('');
      if (k < 0 || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of|delete|void|throw|new)$/.test(before)) {
        let j = i + 1;
        let inClass = false;
        for (; j < text.length && text[j] !== '\n'; j += 1) {
          if (text[j] === '\\') { j += 1; continue; }
          if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          else if (text[j] === '/' && !inClass) break;
        }
        if (text[j] === '/') { i = j + 1; continue; }
      }
    }
    i += 1;
  }
  return out.join('');
}
const texts = new Map();
// Sources given by a test instead of the files (the scanner's own checks below).
const virtual = new Map();
const textOf = file => {
  if (virtual.has(file)) return code(virtual.get(file));
  if (!texts.has(file)) texts.set(file, fs.existsSync(path.join(ROOT, file)) ? code(fs.readFileSync(path.join(ROOT, file), 'utf8')) : '');
  return texts.get(file);
};
// A file that reaches the tables: by SQL, or through the helpers of services/settings-sync-store.js.
const isStateFile = file => TABLES.test(textOf(file)) || /settings-sync-store/.test(textOf(file));

// ---- Reading expressions ----
// The end of the string literal that starts at `start` (a quote), or -1.
function literalEnd(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') { // skip a substitution (it may hold quotes of its own)
      let depth = 0;
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') { depth -= 1; if (depth === 0) break; } else if (/['"`]/.test(text[i])) { i = literalEnd(text, i); if (i < 0) return -1; }
      }
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}
// The top-level arguments of the call whose `(` is at `open`.
function argsAt(text, open) {
  const args = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (/['"`]/.test(char)) { i = literalEnd(text, i); if (i < 0) break; continue; }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      depth -= 1;
      if (depth === 0) { args.push(text.slice(from, i)); break; }
    } else if (char === ',' && depth === 1) { args.push(text.slice(from, i)); from = i + 1; }
  }
  return args.map(arg => arg.trim()).filter(Boolean);
}
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
// The value a name is set to in a file: a string or a template (its source), or null.
function constantOf(name, text) {
  const match = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*(['"\`])`).exec(text);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  const end = literalEnd(text, start);
  return end < 0 ? null : text.slice(start, end + 1);
}
// The template a key builder returns: `const name = owner => \`...\`` or `function name(...) { return \`...\`; }`, or null.
function builderOf(name, text) {
  const match = new RegExp(`(?:(?:const|let)\\s+${name}\\s*=\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*|function\\s+${name}\\s*\\([^)]*\\)\\s*\\{\\s*return\\s+)(['"\`])`).exec(text);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  const end = literalEnd(text, start);
  return end < 0 ? null : text.slice(start, end + 1);
}
// A string or template source as a pattern: `*` for each substitution that is not a constant of the file.
function patternOfLiteral(source, text) {
  const body = source.slice(1, -1);
  if (source[0] !== '`') return body;
  return body.replace(/\$\{\s*([^}]*?)\s*\}/g, (all, expr) => {
    const constant = /^[A-Za-z_$][\w$]*$/.test(expr) ? constantOf(expr, text) : null;
    return constant ? patternOfLiteral(constant, text) : '*';
  });
}
// The file a module name of `require('./x')` in `file` points to.
function requiredFile(name, file, text) {
  const match = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*require\\('(\\.{1,2}/[^']+)'\\)`).exec(text);
  if (!match) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
  return /\.(js|cjs|mjs)$/.test(target) ? target : `${target}.js`;
}
const FROM_TABLE = Symbol('a key read back from the table');
// A key expression as a pattern, FROM_TABLE, or null when it cannot be read.
function patternOf(arg, file, text) {
  const value = arg.trim();
  if (/^(['"`])[\s\S]*\1$/.test(value) && literalEnd(value, 0) === value.length - 1) return patternOfLiteral(value, text);
  if (/^[A-Za-z_$][\w$]*\.key$/.test(value)) return FROM_TABLE; // `row.key` of a SELECT key FROM ... row
  let match = /^[A-Za-z_$][\w$]*$/.exec(value);
  if (match) {
    const constant = constantOf(value, text);
    return constant ? patternOfLiteral(constant, text) : null;
  }
  match = /^(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\(/.exec(value);
  if (match) {
    const [, object, name] = match;
    const home = object ? requiredFile(object, file, text) : file;
    const built = home ? builderOf(name, home === file ? text : textOf(home)) : null;
    return built ? patternOfLiteral(built, home === file ? text : textOf(home)) : null;
  }
  return null;
}

// ---- Finding every key used ----
// Wrappers that pass on a key their caller chose (the callers are checked): the file and the argument.
const PASS_THROUGH = new Set([
  'services/settings-sync-store.js key', 'services/attention-notify.js key', 'services/attention-widget.js key', 'routes/task-list-prefs.js key',
]);
// The helpers that take a key (settings-sync-store's readState / writeState and the local wrappers of the same shape), and the database arguments
// that come before it.
const HELPERS = /(?<![\w$.])(?:(?:syncStore|store)\.)?(readState|writeState|deleteState|readKey|writeKey|readAll|writeAll)\(/g;
const DB_ARG = /^(?:db|database|activeDatabase|this\.db|[A-Za-z_$][\w$]*\.db|db\(\))$/;
// Names of module constants that hold a key (checked even when no read or write was seen, such as a default argument).
const KEY_CONSTANT = /^(?:const|let)\s+([A-Z][A-Z0-9_]*KEY|[a-z][A-Za-z0-9]*Key)\s*=\s*(['"`])/gm;

function scan(files = sources()) {
  const uses = []; // { file, line, store, pattern, like }
  const unreadable = [];
  for (const file of files) {
    const text = textOf(file);
    if (!isStateFile(file)) continue;
    // SQL that names a table, inside prepare() or anywhere else.
    for (const match of text.matchAll(/(['"`])\s*(SELECT|INSERT|DELETE|UPDATE|REPLACE|CREATE)\b/gi)) {
      const start = match.index;
      const end = literalEnd(text, start);
      if (end < 0) continue;
      const sql = text.slice(start + 1, end);
      const table = TABLES.exec(sql);
      if (!table) continue;
      const store = table[1];
      const line = lineAt(text, start);
      const op = match[2].toUpperCase();
      const inline = [
        ...[...sql.matchAll(/\bkey\s*=\s*'([^']*)'/gi)].map(m => ({ pattern: m[1], like: false })),
        ...[...sql.matchAll(/\bkey\s+LIKE\s+'([^']*)'/gi)].map(m => ({ pattern: m[1], like: true })),
        ...[...sql.matchAll(/\bVALUES\s*\(\s*'([^']*)'/gi)].map(m => ({ pattern: m[1], like: false })),
      ];
      const params = [...sql.matchAll(/\bkey\s*(=|LIKE)\s*\?/gi)].map(m => /like/i.test(m[1]));
      if (op === 'INSERT' || op === 'REPLACE') { if (/\bVALUES\s*\(\s*\?/i.test(sql)) params.unshift(false); }
      for (const hit of inline) uses.push({ file, line, store, ...hit });
      if (params.length) {
        const before = text.slice(0, start);
        const after = text.slice(end + 1);
        const call = /^\s*\)((?:\s*\.\s*(?:pluck|raw|expand)\(\s*\))*)\s*\.\s*(?:get|run|all|iterate)\(/.exec(after);
        if (!/\b(?:prepare|prepared)\(\s*$/.test(before) || !call) { unreadable.push(`${file}:${line}: a statement on ${store} whose key is not given where it is prepared`); continue; }
        const args = argsAt(text, end + 1 + call[0].length - 1);
        params.forEach((like, index) => {
          const arg = args[index];
          if (arg === undefined) { unreadable.push(`${file}:${line}: no key argument`); return; }
          if (PASS_THROUGH.has(`${file} ${arg}`)) return;
          const pattern = patternOf(arg, file, text);
          if (pattern === FROM_TABLE) return;
          if (pattern === null) unreadable.push(`${file}:${line}: ${arg}`);
          else uses.push({ file, line, store, pattern, like });
        });
      } else if (!inline.length && op !== 'SELECT' && op !== 'CREATE') {
        unreadable.push(`${file}:${line}: ${op} on ${store} without a key`);
      }
    }
    // The key helpers.
    for (const match of text.matchAll(HELPERS)) {
      if (/function\s+$/.test(text.slice(Math.max(0, match.index - 12), match.index))) continue; // its definition
      const args = argsAt(text, match.index + match[0].length - 1);
      if (args.length && DB_ARG.test(args[0])) args.shift();
      if (!args.length) continue; // readAll(db): its default key, a constant checked below
      const arg = args[0];
      const line = lineAt(text, match.index);
      if (PASS_THROUGH.has(`${file} ${arg}`)) continue;
      const pattern = patternOf(arg, file, text);
      if (pattern === FROM_TABLE) continue;
      if (pattern === null) unreadable.push(`${file}:${line}: ${match[1]}(${arg})`);
      else uses.push({ file, line, store: 'system_state', pattern, like: false });
    }
    // Key constants.
    for (const match of text.matchAll(KEY_CONSTANT)) {
      const source = constantOf(match[1], text.slice(match.index));
      if (source) uses.push({ file, line: lineAt(text, match.index), store: null, pattern: patternOfLiteral(source, text), like: false, constant: match[1] });
    }
  }
  return { uses, unreadable };
}

// ---- Matching a used pattern to a declaration ----
const starred = key => key.replace(/<[a-z]+>/g, '*');
function declarationsOf(use) {
  const stores = use.store ? [use.store] : registry.STORES;
  const entries = registry.KEYS.filter(entry => stores.includes(entry.store));
  if (use.like) {
    const prefix = use.pattern.replace(/%$/, '');
    return use.pattern.endsWith('%') && !prefix.includes('%') ? entries.filter(entry => starred(entry.key).startsWith(prefix)) : [];
  }
  const exact = entries.filter(entry => starred(entry.key) === use.pattern);
  if (exact.length || use.pattern.includes('*')) return exact;
  return stores.map(store => registry.declared(store, use.pattern)).filter(Boolean);
}
// Module constants named like a key that are not state keys: '<file> <name>'.
const NOT_STATE = new Set();

test('every key the server reads or writes in system_state or engine_identity is declared in the registry', () => {
  const { uses, unreadable } = scan();
  assert.ok(uses.length > 40, `the scan finds the keys (found ${uses.length})`);
  const unknown = uses.filter(use => !NOT_STATE.has(`${use.file} ${use.constant}`) && !declarationsOf(use).length)
    .map(use => `${use.file}:${use.line}: ${use.store || 'constant'} ${use.like ? 'LIKE ' : ''}${use.pattern}`);
  assert.deepEqual(unknown, [], `A state key is used that ${REGISTRY} does not declare. ${RULE}`);
  assert.deepEqual(unreadable, [], `A state key is not a string, a template, a constant of its file or a key builder, so it cannot be checked. ${RULE}`);
});

test('the scan finds an undeclared key in every form a source can use it, and flags one it cannot read', () => {
  const sample = {
    'services/sample-a.js': [
      "const syncStore = require('./settings-sync-store');",
      "const STATE_KEY = 'sample_inline_v1';",
      "const DEFAULT_KEY = 'sample_default_v1';",
      'const key = owner => `sample-owner:${owner}`;',
      'function read(db) { return db.prepare(\'SELECT value FROM system_state WHERE key = ?\').get(STATE_KEY); }',
      'function write(db, owner, v) {',
      '  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      '    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key(owner), JSON.stringify(v));',
      '}',
      "const flag = db => db.prepare(\"SELECT value FROM system_state WHERE key = 'sample_sql_literal_v1'\").get();",
      "const helper = (db, owner) => syncStore.writeState(db, `sample-helper:${owner}`, null);",
      "const seeded = db => db.prepare(\"INSERT INTO engine_identity (key, value) VALUES ('sample_identity', ?)\").run('x');",
      "const like = db => db.prepare('SELECT key FROM system_state WHERE key LIKE ?').all(`sample-like:${'x'}%`);",
      '// comments are not code: db.prepare("SELECT value FROM system_state WHERE key = \'sample_in_comment_v1\'")',
      "const kept = db.prepare('SELECT value FROM system_state WHERE key = ?'); // the key is given later: cannot be read",
      "const fine = db => db.prepare('SELECT value FROM system_state WHERE key = ?').get('translator:alice');",
    ].join('\n'),
    'services/sample-b.js': [
      "const other = require('./sample-a');",
      "const { readState } = require('./settings-sync-store');",
      'const read = (db, name) => readState(db, other.keyOf(name));',
      'const whole = db => db.prepare(\'SELECT COUNT(*) FROM system_state\').pluck().get();',
    ].join('\n'),
  };
  sample['services/sample-a.js'] += '\nconst keyOf = name => `sample-builder:${name}`;';
  try {
    for (const [file, text] of Object.entries(sample)) virtual.set(file, text);
    const { uses, unreadable } = scan(Object.keys(sample));
    const unknown = uses.filter(use => !declarationsOf(use).length).map(use => `${use.store || 'constant'} ${use.like ? 'LIKE ' : ''}${use.pattern}`).sort();
    assert.deepEqual(unknown, [
      'constant sample_default_v1', 'constant sample_inline_v1',
      'engine_identity sample_identity', 'system_state LIKE sample-like:*%', 'system_state sample-builder:*', 'system_state sample-helper:*',
      'system_state sample-owner:*', 'system_state sample_inline_v1', 'system_state sample_sql_literal_v1',
    ]);
    assert.equal(unreadable.length, 1, unreadable.join('\n'));
    assert.match(unreadable[0], /^services\/sample-a\.js:15: /);
    assert.ok(uses.some(use => use.pattern === 'translator:alice' && declarationsOf(use).length), 'a declared key passes');
  } finally {
    virtual.clear();
  }
});

test('every declared key is still used, and used in the file the registry names as its owner', () => {
  const { uses } = scan();
  const seen = new Map();
  for (const use of uses) {
    if (use.like) continue;
    for (const entry of declarationsOf(use)) {
      if (!seen.has(entry)) seen.set(entry, new Set());
      seen.get(entry).add(use.file);
    }
  }
  const unused = registry.KEYS.filter(entry => !seen.has(entry)).map(entry => `${entry.store} ${entry.key}`);
  assert.deepEqual(unused, [], `${REGISTRY} declares keys no source uses any more: remove them (and their rows of ${DOC})`);
  for (const entry of registry.KEYS) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.owner)), `${entry.key}: the owner file ${entry.owner} exists`);
    assert.ok(seen.get(entry).has(entry.owner), `${entry.key} is used in its owner ${entry.owner} (used in ${[...seen.get(entry)].join(', ')})`);
  }
});

test('the registry: every key has a store, one of the four scopes and a reason; patterns match the most specific declaration', () => {
  assert.deepEqual(registry.SCOPES, ['shared', 'personal', 'device', 'runtime']);
  const ids = new Set();
  for (const entry of registry.KEYS) {
    assert.ok(registry.STORES.includes(entry.store), `${entry.key}: store ${entry.store}`);
    assert.ok(registry.SCOPES.includes(entry.scope), `${entry.key}: scope ${entry.scope}`);
    assert.ok(typeof entry.how === 'string' && entry.how.length > 15, `${entry.key} says ${entry.scope === 'shared' || entry.scope === 'personal' ? 'which sync carries it' : 'why it stays here'}`);
    if (entry.scope === 'shared' || entry.scope === 'personal') assert.match(entry.how, /sync|sent to every linked/i, `${entry.key} names its sync`);
    if ('concern' in entry) assert.ok(typeof entry.concern === 'string' && entry.concern.length > 15, `${entry.key}: the concern is said`);
    assert.match(entry.key, /^[A-Za-z0-9_:.-]*(?:<[a-z]+>[A-Za-z0-9_:.-]*)*$/, `${entry.key}: a plain name with <placeholders>`);
    assert.ok(!ids.has(`${entry.store} ${entry.key}`), `${entry.key} is declared once`);
    ids.add(`${entry.store} ${entry.key}`);
  }
  assert.equal(registry.declared('system_state', 'translator:alice').key, 'translator:<owner>');
  assert.equal(registry.declared('system_state', 'attention-notify:alice').scope, 'shared');
  assert.equal(registry.declared('system_state', 'attention-notify:telegram:alice').key, 'attention-notify:<plugin>:<owner>');
  assert.equal(registry.declared('system_state', 'attention-notify:telegram:alice').scope, 'device');
  assert.equal(registry.declared('system_state', 'learn_v1_sync:alice').key, 'learn_v1_sync:<owner>');
  assert.equal(registry.declared('system_state', 'browser_site_v1:example.com:8080').key, 'browser_site_v1:<host>');
  assert.equal(registry.declared('system_state', 'translator:'), null, 'a placeholder is never empty');
  assert.equal(registry.declared('system_state', 'my_new_setting_v1'), null);
  assert.equal(registry.declared('engine_identity', 'translator:alice'), null, 'a key belongs to its own table');
  assert.equal(registry.declared('engine_identity', 'instance_id').scope, 'device');
  assert.throws(() => registry.assertDeclared('system_state', 'my_new_setting_v1'), { code: 'UNDECLARED_STATE_KEY', message: /my_new_setting_v1/ });
});

test('a guarded database refuses a row with an undeclared key, and keeps working for declared ones and old rows', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO system_state (key, value) VALUES ('retired_key_v0', '1')").run(); // a row an older version left
  const logs = [];
  registry.guard(db, { log: line => logs.push(line) });
  registry.guard(db, { log: line => logs.push(line) }); // twice is harmless
  const upsert = db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`);
  upsert.run('translator:alice', '{}');
  upsert.run('translator:alice', '{"a":1}');
  upsert.run('device_tier_v1', '{"company":true}');
  db.prepare("INSERT INTO engine_identity (key, value) VALUES ('instance_id', 'x')").run();
  assert.equal(db.prepare('SELECT value FROM system_state WHERE key = ?').get('translator:alice').value, '{"a":1}');
  assert.throws(() => upsert.run('my_new_setting_v1', '{}'), /UNDECLARED_STATE_KEY.*my_new_setting_v1/);
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('other_v1', '1'), /UNDECLARED_STATE_KEY/);
  assert.throws(() => db.prepare("UPDATE system_state SET key = 'renamed_v1' WHERE key = 'device_tier_v1'").run(), /UNDECLARED_STATE_KEY/);
  assert.throws(() => db.prepare("INSERT INTO engine_identity (key, value) VALUES ('nickname', 'x')").run(), /UNDECLARED_STATE_KEY/);
  assert.throws(() => db.transaction(() => { upsert.run('speech:alice', '{}'); upsert.run('nope_v1', '{}'); })(), /UNDECLARED_STATE_KEY/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM system_state WHERE key = 'speech:alice'").pluck().get(), 0, 'the refused transaction left nothing');
  db.prepare("UPDATE system_state SET value = '2' WHERE key = 'retired_key_v0'").run(); // an old row can still be changed and removed
  db.prepare("DELETE FROM system_state WHERE key = 'retired_key_v0'").run();
  assert.equal(logs.filter(line => line.includes('my_new_setting_v1')).length, 1, 'logged once per key');
  assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'").pluck().get(), 0, 'the triggers are temporary: never written to the file');
  db.close();
});

test('the database of the server is guarded', () => {
  const db = require('../db');
  assert.throws(() => db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run('my_new_setting_v1', '1'), { code: 'UNDECLARED_STATE_KEY' });
  db.prepare(`INSERT INTO system_state (key, value) VALUES ('ui_usage_v1', '{"enabled":true}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
});

test(`the registry and the table of ${DOC} list the same keys, with the same stores and scopes, and the same concerns`, () => {
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  const sectionOf = heading => {
    const at = doc.indexOf(`## ${heading}`);
    assert.ok(at >= 0, `${DOC} has "## ${heading}"`);
    const next = doc.indexOf('\n## ', at + 4);
    return doc.slice(at, next < 0 ? doc.length : next);
  };
  const rows = section => section.split('\n').filter(line => /^\| `/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  const table = rows(sectionOf('Key registry')).map(([key, store, scope]) => `${store} ${key.replace(/^`|`$/g, '')} ${scope}`).sort();
  assert.deepEqual(table, registry.KEYS.map(entry => `${entry.store} ${entry.key} ${entry.scope}`).sort(), `The table and ${REGISTRY} differ. ${RULE}`);
  const concerns = rows(sectionOf('Keys whose scope looks wrong')).map(([key]) => key.replace(/^`|`$/g, '')).sort();
  assert.deepEqual(concerns, registry.KEYS.filter(entry => entry.concern).map(entry => entry.key).sort(), 'the doc lists the keys with a concern');
});

test('AGENTS.md names this test in the rule it guards', () => {
  const rules = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const at = rules.indexOf('## One experience on every device and engine');
  assert.ok(at >= 0);
  const section = rules.slice(at, rules.indexOf('\n## ', at + 4));
  assert.match(section, /test\/server-state-keys\.test\.js/);
  assert.match(section, /lib\/server-state-keys\.js/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const dataHome = require('../lib/data-home');

const ROOT = path.resolve(__dirname, '..');
const CODE_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'VERSION.json'), 'utf8')).schema_version;
const posix = process.platform !== 'win32';

function temp(t, name = 'data-home') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t-agent-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mode = file => fs.statSync(file).mode & 0o777;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quiet = () => {};
// A child process outside the test runner (NODE_TEST_CONTEXT removed) with exactly the given data env.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'TAGENT_HOME', 'T_AGENT_DATA_DIR', 'T_AGENT_DB_PATH']) if (!(name in extra)) delete env[name];
  return env;
}
const openDb = env => spawnSync(process.execPath, ['-e', "require('./db').close()"], { cwd: ROOT, env: childEnv(env), encoding: 'utf8' });

test('the default data folder is ~/.tagent, TAGENT_HOME overrides it and T_AGENT_DATA_DIR still works', () => {
  const homedir = () => '/home/someone';
  assert.deepEqual(dataHome.resolveDataHome({ env: {}, homedir }), { root: '/home/someone/.tagent', source: 'default', explicit: false });
  assert.deepEqual(dataHome.resolveDataHome({ env: { TAGENT_HOME: '/srv/ta' }, homedir }), { root: '/srv/ta', source: 'TAGENT_HOME', explicit: true });
  assert.equal(dataHome.resolveDataHome({ env: { TAGENT_HOME: '~/x' }, homedir }).root, '/home/someone/x');
  assert.deepEqual(dataHome.resolveDataHome({ env: { T_AGENT_DATA_DIR: '/var/lib/t-agent' }, homedir }), { root: '/var/lib/t-agent', source: 'T_AGENT_DATA_DIR', explicit: true });
  assert.equal(dataHome.resolveDataHome({ env: { TAGENT_HOME: '/new', T_AGENT_DATA_DIR: '/old' }, homedir }).root, '/new', 'the new name wins');
  assert.equal(dataHome.resolveDataHome({ env: { TAGENT_HOME: '  ' }, homedir }).source, 'default', 'an empty value is not an override');
  const layout = dataHome.layout('/d', {});
  assert.equal(layout.dbPath, '/d/db.sqlite');
  assert.equal(layout.backupsDir, '/d/backups');
  assert.equal(layout.lockPath, '/d/server.lock');
  assert.equal(dataHome.layout('/d', { T_AGENT_DB_PATH: '/elsewhere/x.sqlite' }).dbPath, '/elsewhere/x.sqlite');
});

test('a test process without an override is refused instead of using the real home folder', () => {
  assert.throws(() => dataHome.paths({ env: { NODE_TEST_CONTEXT: 'child-v8' }, argv: ['node', 'x.js'] }), { code: 'DATA_HOME_IN_TEST' });
  assert.throws(() => dataHome.paths({ env: {}, argv: ['node', '/a/test/foo.test.js'] }), { code: 'DATA_HOME_IN_TEST' });
  assert.throws(() => dataHome.paths({ env: {}, argv: ['node', '/a/scripts/test-h5-browser.cjs'] }), { code: 'DATA_HOME_IN_TEST' });
  assert.equal(dataHome.paths({ env: { NODE_TEST_CONTEXT: 'child-v8', TAGENT_HOME: '/tmp/x' } }).root, '/tmp/x');
  assert.equal(dataHome.paths({ env: {}, argv: ['node', '/app/server.js'], homedir: () => '/h' }).root, '/h/.tagent');
});

test('a fresh start under the default folder creates ~/.tagent with private modes and stamps the schema', t => {
  const home = temp(t, 'fake-home');
  const result = openDb({ HOME: home, T_AGENT_LEGACY_DATA_DIR: path.join(home, 'no-old-data') });
  assert.equal(result.status, 0, result.stderr);
  const root = path.join(home, '.tagent');
  assert.ok(fs.existsSync(path.join(root, 'db.sqlite')));
  if (posix) {
    assert.equal(mode(root), 0o700);
    assert.equal(mode(path.join(root, 'db.sqlite')), 0o600);
  }
  const db = new Database(path.join(root, 'db.sqlite'), { readonly: true });
  assert.equal(db.pragma('user_version', { simple: true }), CODE_SCHEMA);
  db.close();
});

test('loose modes are tightened on start, with a warning', { skip: !posix }, t => {
  const root = path.join(temp(t), 'home');
  fs.mkdirSync(root, { mode: 0o755 });
  fs.chmodSync(root, 0o755);
  fs.writeFileSync(path.join(root, 'session-secret'), 'x'.repeat(64), { mode: 0o644 });
  fs.chmodSync(path.join(root, 'session-secret'), 0o644);
  const warnings = [];
  dataHome.prepare({ env: { TAGENT_HOME: root }, warn: message => warnings.push(message) });
  assert.equal(mode(root), 0o700);
  assert.equal(mode(path.join(root, 'session-secret')), 0o600);
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.match(warnings[0], /open to other users/);
});

test('the session secret is seeded from .env once, then the saved one wins; a new folder gets a random one', { skip: !posix }, t => {
  const seeded = path.join(temp(t), 'seeded');
  assert.equal(dataHome.sessionSecret({ env: { TAGENT_HOME: seeded, SESSION_SECRET: 'from-env-'.repeat(5) }, warn: quiet }), 'from-env-'.repeat(5));
  assert.equal(mode(path.join(seeded, 'session-secret')), 0o600);
  const fresh = path.join(temp(t), 'fresh');
  const random = dataHome.sessionSecret({ env: { TAGENT_HOME: fresh }, warn: quiet });
  assert.match(random, /^[0-9a-f]{64}$/);
  // Existing data without a secret in .env keeps the old built-in default, so its encrypted values stay readable.
  const legacy = path.join(temp(t), 'legacy');
  fs.mkdirSync(legacy);
  new Database(path.join(legacy, 'db.sqlite')).close();
  assert.equal(dataHome.sessionSecret({ env: { TAGENT_HOME: legacy }, warn: quiet }), dataHome.LEGACY_SECRET);
  // A different .env value later is ignored with a warning (checked in a child, the value is cached per process).
  const warned = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./lib/data-home').sessionSecret())"],
    { cwd: ROOT, env: childEnv({ TAGENT_HOME: seeded, SESSION_SECRET: 'another-secret' }), encoding: 'utf8' });
  assert.equal(warned.stdout, 'from-env-'.repeat(5));
  assert.match(warned.stderr, /SESSION_SECRET in \.env is ignored/);
});

// The old folder with a writer that keeps its changes in the WAL (not checkpointed), like a running old server.
function legacyWithWal(dir, rows = 3) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t (v TEXT)');
  for (let i = 0; i < rows; i += 1) db.prepare('INSERT INTO t VALUES (?)').run(`row ${i}`);
  fs.writeFileSync(path.join(dir, 'frpc.toml'), 'token = "x"\n');
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, 'backups', 'db-old.sqlite'), 'big old backup');
  return db;
}

test('the one-time copy takes a backup, includes the WAL, writes a marker and leaves the old folder unchanged', t => {
  const base = temp(t);
  const from = path.join(base, 'install', 'data');
  const to = path.join(base, 'home', '.tagent');
  const writer = legacyWithWal(from);
  assert.ok(fs.statSync(path.join(from, 'db.sqlite-wal')).size > 0, 'the rows are only in the WAL');
  const before = Object.fromEntries(['db.sqlite', 'db.sqlite-wal', 'frpc.toml'].map(name => [name, hash(path.join(from, name))]));
  const logs = [];
  const result = dataHome.migrateLegacyData({ from, to, log: message => logs.push(message), now: () => new Date('2026-11-05T10:00:00Z') });
  writer.close();

  assert.equal(result.status, 'copied');
  assert.equal(result.backup, `${from}.backup-2026-11-05T10-00-00-000Z`);
  for (const [name, digest] of Object.entries(before)) assert.equal(hash(path.join(result.backup, name)), digest, `backup of ${name}`);
  const copied = new Database(path.join(to, 'db.sqlite'), { readonly: true });
  assert.equal(copied.prepare('SELECT COUNT(*) AS n FROM t').get().n, 3);
  copied.close();
  assert.equal(fs.readFileSync(path.join(to, 'frpc.toml'), 'utf8'), 'token = "x"\n');
  assert.ok(!fs.existsSync(path.join(to, 'backups')), 'old update backups are not copied');
  assert.ok(!fs.existsSync(path.join(result.backup, 'backups')));
  const marker = JSON.parse(fs.readFileSync(path.join(to, 'migrated-from.json'), 'utf8'));
  assert.equal(marker.source, from);
  assert.equal(marker.backup, result.backup);
  assert.equal(marker.schema_version, CODE_SCHEMA);
  assert.ok(marker.app_version);
  if (posix) {
    assert.equal(mode(to), 0o700);
    assert.equal(mode(path.join(to, 'frpc.toml')), 0o600);
  }
  assert.ok(fs.readdirSync(path.dirname(to)).every(name => !name.includes('.partial-')), 'no temporary folder is left');
  assert.match(logs.join('\n'), /copied .* A backup of the old data is in/);
  assert.ok(fs.existsSync(path.join(from, 'db.sqlite')) && fs.existsSync(path.join(from, 'backups', 'db-old.sqlite')), 'the old folder is kept');

  // Idempotent: a second start sees the data and only notes that the old folder is ignored.
  const again = [];
  assert.equal(dataHome.migrateLegacyData({ from, to, log: message => again.push(message) }).status, 'exists');
  assert.match(again.join('\n'), /old folder .* is ignored and not changed/);
  assert.equal(fs.readdirSync(path.dirname(from)).filter(name => name.startsWith('data.backup-')).length, 1, 'no second backup');
});

test('the first start under the default folder copies the old data in (end to end)', t => {
  const base = temp(t);
  const home = path.join(base, 'home');
  const from = path.join(base, 'install', 'data');
  const writer = legacyWithWal(from, 5);
  writer.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)');
  writer.prepare('INSERT INTO tasks (title) VALUES (?)').run('old task');
  writer.close();
  fs.mkdirSync(home);
  const result = openDb({ HOME: home, T_AGENT_LEGACY_DATA_DIR: from });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Data folder: copied /);
  const db = new Database(path.join(home, '.tagent', 'db.sqlite'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 5);
  assert.equal(db.prepare('SELECT title FROM tasks').get().title, 'old task');
  assert.equal(db.pragma('user_version', { simple: true }), CODE_SCHEMA);
  db.close();
  // With an explicit folder nothing is copied.
  const explicit = path.join(base, 'explicit');
  assert.equal(openDb({ HOME: home, TAGENT_HOME: explicit, T_AGENT_LEGACY_DATA_DIR: from }).status, 0);
  assert.ok(!fs.existsSync(path.join(explicit, 'migrated-from.json')));
});

test('when both folders have a database the new one is used; nothing to copy when the old folder is empty', t => {
  const base = temp(t);
  const from = path.join(base, 'data');
  const to = path.join(base, '.tagent');
  legacyWithWal(from).close();
  fs.mkdirSync(to);
  new Database(path.join(to, 'db.sqlite')).close();
  const logs = [];
  assert.equal(dataHome.migrateLegacyData({ from, to, log: message => logs.push(message) }).status, 'exists');
  assert.match(logs[0], /has no user data; it is ignored/, 'no marker, but the old folder holds no user data (rules 1a / 1b below)');
  assert.equal(dataHome.migrateLegacyData({ from: path.join(base, 'missing'), to: path.join(base, 'other'), log: quiet }).status, 'none');
});

test('a copy that fails half way leaves no database in the new folder and can be retried', t => {
  const base = temp(t);
  const from = path.join(base, 'data');
  const to = path.join(base, '.tagent');
  legacyWithWal(from).close();
  const original = hash(path.join(from, 'db.sqlite'));
  // A folder left by a crashed process (pid 2^22 + 1 is never a live pid here) is cleaned up.
  const leftover = `${to}.partial-old-${2 ** 22 + 1}`;
  fs.mkdirSync(leftover);
  class Broken extends Database { pragma(text, options) { if (text === 'quick_check') return 'corrupt page 3'; return super.pragma(text, options); } }
  assert.throws(() => dataHome.migrateLegacyData({ from, to, log: quiet, Database: Broken }), error => {
    assert.equal(error.code, 'DATA_COPY_FAILED');
    assert.match(error.message, /failed its check \(corrupt page 3\)\. Nothing was changed in/);
    return true;
  });
  assert.ok(!fs.existsSync(path.join(to, 'db.sqlite')));
  assert.ok(!fs.existsSync(leftover));
  assert.ok(fs.readdirSync(base).every(name => !name.includes('.partial')), fs.readdirSync(base).join(','));
  assert.equal(hash(path.join(from, 'db.sqlite')), original);
  // The target folder already exists (for example it holds only a lock): entries are moved in and the database is linked last.
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'server.lock'), '{}');
  assert.equal(dataHome.migrateLegacyData({ from, to, log: quiet }).status, 'copied');
  const db = new Database(path.join(to, 'db.sqlite'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 3);
  db.close();
  assert.ok(fs.existsSync(path.join(to, 'migrated-from.json')));
});

test('a database with a newer schema is refused with a clear message', t => {
  const root = temp(t);
  const db = new Database(path.join(root, 'db.sqlite'));
  db.pragma(`user_version = ${CODE_SCHEMA + 1}`);
  db.close();
  const result = openDb({ TAGENT_HOME: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /was written by a newer T-Agent \(database schema \d+; this version supports up to \d+\)/);
  const after = new Database(path.join(root, 'db.sqlite'), { readonly: true });
  assert.equal(after.pragma('user_version', { simple: true }), CODE_SCHEMA + 1, 'the stored version is not changed');
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tasks'").get().n, 0, 'no migration ran');
  after.close();
});

test('an older database is migrated and its schema version is stored (old name T_AGENT_DATA_DIR)', t => {
  const root = temp(t);
  const db = new Database(path.join(root, 'db.sqlite'));
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)');
  db.prepare('INSERT INTO tasks (title) VALUES (?)').run('kept');
  db.close();
  const result = openDb({ T_AGENT_DATA_DIR: root });
  assert.equal(result.status, 0, result.stderr);
  const after = new Database(path.join(root, 'db.sqlite'), { readonly: true });
  assert.equal(after.pragma('user_version', { simple: true }), CODE_SCHEMA);
  assert.ok(after.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'work_dir'));
  assert.equal(after.prepare('SELECT title FROM tasks').get().title, 'kept');
  after.close();
});

test('a schema 7 database gets the terminal start directories (schema 8) and the later generations, with a copy taken first; a second start changes nothing', t => {
  const root = temp(t);
  assert.equal(openDb({ TAGENT_HOME: root }).status, 0);
  // Make it look like a database of the previous generation: no task_terminals.work_dir, no default-terminal table, user_version 7.
  const file = path.join(root, 'db.sqlite');
  const old = new Database(file);
  old.exec('ALTER TABLE task_terminals DROP COLUMN work_dir; DROP TABLE task_default_terminal_dirs;');
  const task = old.prepare("INSERT INTO tasks (title, work_dir, user_id) VALUES ('t', '/work/old', 'owner')").run().lastInsertRowid;
  const bare = old.prepare("INSERT INTO tasks (title, user_id) VALUES ('no dir', 'owner')").run().lastInsertRowid;
  old.prepare("INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id) VALUES (?, 'a', 'Claude 2', 'claude', 's1')").run(task);
  old.prepare("INSERT INTO task_terminals (task_id, terminal_id, title) VALUES (?, 'b', 'Terminal 2')").run(bare);
  old.pragma('user_version = 7');
  old.close();

  const result = openDb({ TAGENT_HOME: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`schema 7 is migrated to ${CODE_SCHEMA}; a copy of the database before the migration is in `));
  const after = new Database(file, { readonly: true });
  assert.equal(after.pragma('user_version', { simple: true }), CODE_SCHEMA);
  assert.deepEqual(after.prepare('SELECT terminal_id, work_dir, agent_session_id FROM task_terminals ORDER BY terminal_id').all(),
    [{ terminal_id: 'a', work_dir: '/work/old', agent_session_id: 's1' }, { terminal_id: 'b', work_dir: null, agent_session_id: null }], 'backfilled with the task directory; other columns kept');
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'task_default_terminal_dirs'").get().n, 1);
  after.close();
  const copies = fs.readdirSync(path.join(root, 'backups'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], new RegExp(`^db-schema-7-before-${CODE_SCHEMA}-.+\\.sqlite$`));
  const copy = new Database(path.join(root, 'backups', copies[0]), { readonly: true });
  assert.equal(copy.pragma('user_version', { simple: true }), 7, 'the copy is the database as it was');
  assert.ok(!copy.prepare('PRAGMA table_info(task_terminals)').all().some(column => column.name === 'work_dir'));
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM task_terminals').get().n, 2);
  copy.close();
  if (posix) assert.equal(mode(path.join(root, 'backups', copies[0])), 0o600);

  const again = openDb({ TAGENT_HOME: root });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /is migrated/);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 1, 'no second copy');
  const last = new Database(file, { readonly: true });
  assert.equal(last.prepare("SELECT work_dir FROM task_terminals WHERE terminal_id = 'a'").get().work_dir, '/work/old');
  last.close();
});

test('a schema 9 database gets tasks.archived_at (schema 10), with a copy taken first; existing data is kept, nothing is archived and a second start changes nothing', t => {
  const root = temp(t);
  assert.equal(openDb({ TAGENT_HOME: root }).status, 0);
  // A database of the previous generation: no tasks.archived_at, user_version 9.
  const file = path.join(root, 'db.sqlite');
  const old = new Database(file);
  old.exec('ALTER TABLE tasks DROP COLUMN archived_at');
  const task = old.prepare("INSERT INTO tasks (title, work_dir, user_id, sort_order, share_token) VALUES ('kept task', '/work/kept', 'owner', 7, 'token')").run().lastInsertRowid;
  old.prepare("INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id) VALUES (?, 'a', 'Claude 2', 'claude', 's1')").run(task);
  old.pragma('user_version = 9');
  old.close();

  const result = openDb({ TAGENT_HOME: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`schema 9 is migrated to ${CODE_SCHEMA}; a copy of the database before the migration is in `));
  const after = new Database(file, { readonly: true });
  assert.equal(after.pragma('user_version', { simple: true }), CODE_SCHEMA);
  assert.ok(after.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'archived_at'));
  assert.deepEqual(after.prepare('SELECT title, work_dir, user_id, sort_order, share_token, archived_at FROM tasks WHERE id = ?').get(task),
    { title: 'kept task', work_dir: '/work/kept', user_id: 'owner', sort_order: 7, share_token: 'token', archived_at: null }, 'the row is kept and is not archived');
  assert.equal(after.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ?').get(task).agent_session_id, 's1');
  after.close();
  const copies = fs.readdirSync(path.join(root, 'backups'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], new RegExp(`^db-schema-9-before-${CODE_SCHEMA}-.+\\.sqlite$`));
  const copy = new Database(path.join(root, 'backups', copies[0]), { readonly: true });
  assert.equal(copy.pragma('user_version', { simple: true }), 9, 'the copy is the database as it was');
  assert.ok(!copy.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'archived_at'));
  assert.equal(copy.prepare('SELECT title FROM tasks WHERE id = ?').get(task).title, 'kept task');
  copy.close();
  if (posix) assert.equal(mode(path.join(root, 'backups', copies[0])), 0o600);

  const again = openDb({ TAGENT_HOME: root });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /is migrated/);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 1, 'no second copy');
});

test('a schema 8 database gets the T-Attention tables (schema 9), with a copy taken first; existing data is kept and a second start changes nothing', t => {
  const root = temp(t);
  assert.equal(openDb({ TAGENT_HOME: root }).status, 0);
  // A database of the previous generation: no attention_* tables, user_version 8.
  const file = path.join(root, 'db.sqlite');
  const old = new Database(file);
  old.exec('DROP TABLE attention_events; DROP TABLE attention_items; DROP TABLE attention_tokens;');
  old.prepare("INSERT INTO tasks (title, work_dir, user_id) VALUES ('kept task', '/work', 'owner')").run();
  old.pragma('user_version = 8');
  old.close();

  const result = openDb({ TAGENT_HOME: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`schema 8 is migrated to ${CODE_SCHEMA}; a copy of the database before the migration is in `));
  const after = new Database(file);
  assert.equal(after.pragma('user_version', { simple: true }), CODE_SCHEMA);
  for (const table of ['attention_items', 'attention_events', 'attention_tokens']) {
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?').get('table', table).n, 1, table);
  }
  assert.ok(after.prepare('PRAGMA table_info(attention_items)').all().some(column => column.name === 'context'), 'items have the context column');
  assert.equal(after.prepare('SELECT title FROM tasks').get().title, 'kept task');
  // The events of an item go with it (foreign key with ON DELETE CASCADE).
  after.pragma('foreign_keys = ON');
  const item = after.prepare("INSERT INTO attention_items (title, created_at, updated_at) VALUES ('a', 'x', 'x')").run().lastInsertRowid;
  after.prepare("INSERT INTO attention_events (item_id, at, actor, type) VALUES (?, 'x', 'user', 'created')").run(item);
  assert.equal(after.prepare('SELECT status, priority, source FROM attention_items').get().status, 'todo');
  assert.deepEqual(dataHome.userDataIn(after).filter(entry => entry.startsWith('T-Attention')), ['T-Attention items: 1'], 'items count as user data');
  after.prepare('DELETE FROM attention_items WHERE id = ?').run(item);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM attention_events').get().n, 0);
  after.close();
  const copies = fs.readdirSync(path.join(root, 'backups'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], new RegExp(`^db-schema-8-before-${CODE_SCHEMA}-.+\\.sqlite$`));
  const copy = new Database(path.join(root, 'backups', copies[0]), { readonly: true });
  assert.equal(copy.pragma('user_version', { simple: true }), 8, 'the copy is the database as it was');
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'attention_%'").get().n, 0);
  copy.close();
  if (posix) assert.equal(mode(path.join(root, 'backups', copies[0])), 0o600);

  const again = openDb({ TAGENT_HOME: root });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /is migrated/);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 1, 'no second copy');

  // A schema 9 database made by an earlier build of T-Attention (before the context column) gets the column, rows kept.
  const early = new Database(file);
  early.prepare("INSERT INTO attention_items (title, created_at, updated_at) VALUES ('early', 'x', 'x')").run();
  early.exec('ALTER TABLE attention_items DROP COLUMN context');
  early.close();
  assert.equal(openDb({ TAGENT_HOME: root }).status, 0);
  const fixed = new Database(file, { readonly: true });
  assert.ok(fixed.prepare('PRAGMA table_info(attention_items)').all().some(column => column.name === 'context'));
  assert.equal(fixed.prepare('SELECT title FROM attention_items').get().title, 'early');
  fixed.close();
});

test('the lock refuses a second server and takes over a lock whose pid is dead', t => {
  const root = temp(t);
  const env = { TAGENT_HOME: root };
  const lockFile = path.join(root, 'server.lock');
  // Held by a live process (the parent of this test).
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, port: 4321, version: '9.9.9', started_at: 'then', install_dir: '/other' }));
  assert.throws(() => dataHome.acquireServerLock({ env, log: quiet }), error => {
    assert.equal(error.code, 'DATA_LOCKED');
    assert.match(error.message, /already using the data folder .* \(pid \d+, port 4321, version 9\.9\.9, started then, from \/other\)/);
    return true;
  });
  // Held by a pid that is not running any more.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: Number(dead), port: 1 }));
  const logs = [];
  const lock = dataHome.acquireServerLock({ env, port: 0, log: message => logs.push(message) });
  assert.match(logs.join('\n'), /removed a stale lock/);
  let record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(record.pid, process.pid);
  if (posix) assert.equal(mode(lockFile), 0o600);
  lock.update({ port: 5555 });
  record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(record.port, 5555);
  // A fresh, unreadable lock (a server writing it right now) is not taken over.
  lock.release();
  assert.ok(!fs.existsSync(lockFile));
  fs.writeFileSync(lockFile, '');
  assert.throws(() => dataHome.acquireServerLock({ env, log: quiet }), { code: 'DATA_LOCKED' });
});

test('a second server on the same data folder exits with a message naming the first one', { timeout: 30000 }, async t => {
  const root = temp(t);
  const env = childEnv({ TAGENT_HOME: root, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', SESSION_SECRET: 'data-home-test-secret-'.repeat(3),
    TASKS_BASE_DIR: path.join(root, 'tasks'), SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', ACCESS_MODE: 'local' });
  const first = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => first.kill('SIGKILL'));
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the first server did not start: ${output}`)), 20000);
    const onData = chunk => { output += chunk; if (/Server running at http:\/\/localhost:(\d+)/.test(output)) { clearTimeout(timer); resolve(); } };
    first.stdout.on('data', onData);
    first.stderr.on('data', onData);
    first.on('exit', code => { clearTimeout(timer); reject(new Error(`the first server exited (${code}): ${output}`)); });
  });
  const port = Number(output.match(/localhost:(\d+)/)[1]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'server.lock'), 'utf8')).port, port, 'the lock records the real port');
  const second = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(second.status, 1);
  assert.match(second.stderr, new RegExp(`T-Agent cannot start: Another T-Agent server is already using the data folder .*\\(pid ${first.pid}, port ${port}`));
  // A clean stop removes the lock.
  first.kill('SIGTERM');
  await new Promise(resolve => first.once('exit', resolve));
  assert.ok(!fs.existsSync(path.join(root, 'server.lock')));
});

// A database as a server start without the old data leaves it: the app schema plus the rows a start writes by itself.
function emptyStart(root, extraSql = '') {
  const result = openDb({ TAGENT_HOME: root });
  assert.equal(result.status, 0, result.stderr);
  const db = new Database(path.join(root, 'db.sqlite'));
  db.exec(`
    INSERT INTO task_groups (owner_id, group_key, name, sort_order, is_system) VALUES
      ('local', 'personal', 'Personal tasks', 0, 0), ('local', 'doing', 'Doing', 1000, 1), ('local', 'todo', 'To do', 1001, 1), ('local', 'done', 'Done', 1002, 1);
    INSERT INTO system_state (key, value) VALUES ('single_user_id', 'local'),
      ('file_sync_v1', '{"masterId":null,"files":[],"versions":{},"mode":"master"}'), ('update_state', '{"status":"idle"}');
    INSERT INTO users (username, salt, hash) VALUES ('local', 'single-user', 'password-auth-disabled');
    CREATE TABLE IF NOT EXISTS client_auth (owner_id TEXT PRIMARY KEY, secret_cipher TEXT, version TEXT NOT NULL, last_step INTEGER NOT NULL DEFAULT -1, recovery_hashes TEXT NOT NULL DEFAULT '[]', bound_at TEXT);
    INSERT INTO client_auth (owner_id, version) VALUES ('local', 'v');
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('s', '{}', 9999999999999);
    ${extraSql}`);
  db.close();
  fs.writeFileSync(path.join(root, 'session-secret'), 'secret-of-the-empty-start\n', { mode: 0o600 });
}
function oldDataWithTask(from) {
  fs.mkdirSync(from, { recursive: true });
  assert.equal(openDb({ T_AGENT_DATA_DIR: from }).status, 0);
  fs.rmSync(path.join(from, 'session-secret'), { force: true });
  const db = new Database(path.join(from, 'db.sqlite'));
  db.prepare("INSERT INTO tasks (title, status) VALUES ('my old task', 'doing')").run();
  db.close();
}
const countRows = (file, sql) => { const db = new Database(file, { readonly: true }); try { return db.prepare(sql).pluck().get(); } finally { db.close(); } };

test('what counts as user data: rows a start writes by itself do not count', t => {
  const root = temp(t);
  emptyStart(root);
  const db = new Database(path.join(root, 'db.sqlite'));
  assert.deepEqual(dataHome.userDataIn(db), []);
  db.exec("INSERT INTO apps (name, source) VALUES ('pm2 app', 'pm2')");
  assert.deepEqual(dataHome.userDataIn(db), [], 'apps registered from PM2 do not count');
  db.exec("UPDATE client_auth SET secret_cipher = 'x'");
  db.exec("INSERT INTO system_state (key, value) VALUES ('translator:local', 'x')");
  db.exec("UPDATE system_state SET value = '{\"masterId\":\"m\",\"files\":[]}' WHERE key = 'file_sync_v1'");
  db.exec("INSERT INTO task_groups (owner_id, group_key, name, sort_order, is_system) VALUES ('local', 'g1', 'Mine', 1, 0)");
  db.exec("UPDATE users SET work_dir = '/w'");
  assert.deepEqual(dataHome.userDataIn(db), ['task groups: 1', 'bound authenticator: 1', 'working directory settings: 1', 'settings: 1', 'file sync: 1']);
  db.close();
});

test('rule 1a: an empty data home without a marker is moved aside and the old data is copied in', t => {
  const base = temp(t);
  const to = path.join(base, 'home', '.tagent');
  const from = path.join(base, 'install', 'data');
  fs.mkdirSync(to, { recursive: true });
  emptyStart(to);
  oldDataWithTask(from);
  const oldHash = hash(path.join(from, 'db.sqlite'));
  const logs = [];
  const result = dataHome.migrateLegacyData({ from, to, log: message => logs.push(message), warn: message => logs.push(message), now: () => new Date('2026-11-06T01:02:03Z') });
  assert.equal(result.status, 'copied');
  assert.equal(countRows(path.join(to, 'db.sqlite'), "SELECT COUNT(*) FROM tasks WHERE title = 'my old task'"), 1);
  const aside = path.join(to, 'empty-start-2026-11-06T01-02-03-000Z');
  assert.ok(fs.existsSync(path.join(aside, 'db.sqlite')), 'the empty database is kept aside');
  assert.equal(fs.readFileSync(path.join(aside, 'session-secret'), 'utf8'), 'secret-of-the-empty-start\n');
  assert.ok(!fs.existsSync(path.join(to, 'session-secret')), 'the secret of the empty start is not used for the old data');
  assert.ok(fs.existsSync(path.join(to, 'migrated-from.json')));
  assert.equal(hash(path.join(from, 'db.sqlite')), oldHash, 'the old database is not changed');
  assert.match(logs.join('\n'), /had a database without user data .* moved it to .*empty-start-/);
  assert.equal(dataHome.dataHomeCheck().status, 'copied');
  // Afterwards the marker exists: later starts just use the data home.
  assert.equal(dataHome.migrateLegacyData({ from, to, log: quiet, warn: quiet }).status, 'exists');
});

test('rule 1a does not apply when the old folder has no user data, or a live server holds the data home', t => {
  const base = temp(t);
  const to = path.join(base, '.tagent');
  const from = path.join(base, 'data');
  fs.mkdirSync(to);
  emptyStart(to);
  fs.mkdirSync(from);
  assert.equal(openDb({ T_AGENT_DATA_DIR: from }).status, 0); // an old folder with only the schema
  const logs = [];
  assert.equal(dataHome.migrateLegacyData({ from, to, log: message => logs.push(message), warn: quiet }).status, 'exists');
  assert.match(logs[0], /has no user data; it is ignored/);
  oldDataWithTask(path.join(base, 'data2'));
  fs.writeFileSync(path.join(to, 'server.lock'), JSON.stringify({ pid: process.ppid }));
  assert.equal(dataHome.migrateLegacyData({ from: path.join(base, 'data2'), to, log: quiet, warn: quiet }).status, 'exists');
  assert.ok(fs.existsSync(path.join(to, 'db.sqlite')) && !fs.existsSync(path.join(to, 'migrated-from.json')), 'nothing moved while in use');
});

test('rule 1b: when both folders hold user data and there is no marker, the data home is kept and a loud warning names both', t => {
  const base = temp(t);
  const to = path.join(base, '.tagent');
  const from = path.join(base, 'data');
  fs.mkdirSync(to);
  emptyStart(to, "INSERT INTO tasks (title, status) VALUES ('new task', 'doing');");
  oldDataWithTask(from);
  const warnings = [];
  assert.equal(dataHome.migrateLegacyData({ from, to, log: quiet, warn: message => warnings.push(message) }).status, 'conflict');
  const text = warnings.join('\n');
  assert.match(text, /T-Agent data folder warning/);
  assert.ok(text.includes(`in use:  ${to} (tasks: 1`) && text.includes(`ignored: ${from} (tasks: 1`), text);
  assert.match(text, /move .* away .* start again/);
  assert.match(text, /set TAGENT_HOME=/);
  assert.equal(countRows(path.join(to, 'db.sqlite'), "SELECT COUNT(*) FROM tasks WHERE title = 'new task'"), 1, 'the data home is unchanged');
  assert.ok(!fs.existsSync(path.join(to, 'migrated-from.json')));
  assert.equal(dataHome.dataHomeCheck().status, 'conflict');
});

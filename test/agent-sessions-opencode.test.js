// OpenCode sessions are read from opencode's own SQLite database (docs/design/opencode-terminals.md). The fixture below has the
// `session` table of opencode 1.19.6 (the columns the listing reads, and a few beside them); the real ~/.local/share/opencode is never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The real path: opencode stores the directory it runs in as the system gives it (macOS's temporary folder is a link to /private/var).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-opencode-')));
process.env.T_AGENT_DATA_DIR = root;
const Database = require('better-sqlite3');
const { listSessions, startupCommand, isAgent, opencodeDb, sessionFiles } = require('../lib/agent-sessions');

const home = path.join(root, 'home');
const dir = path.join(root, 'work', 'proj');
fs.mkdirSync(dir, { recursive: true });
const env = {}; // no XDG_DATA_HOME, no OPENCODE_DB: the default place under the home
const dbFile = path.join(home, '.local', 'share', 'opencode', 'opencode.db');

function createDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text,
    title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, metadata text, cost real, agent text, model text,
    time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer)`);
  return db;
}
const insert = (db, row) => db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
  VALUES (@id, 'global', @parent_id, 'quick-harbor', @directory, @title, '1.19.6', @time_created, @time_updated, @time_archived)`)
  .run({ parent_id: null, time_archived: null, directory: dir, ...row });

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('opencode is a third agent: a fresh start, a resume by id, bad ids refused', () => {
  assert.ok(isAgent('opencode'));
  assert.equal(startupCommand('opencode'), 'opencode');
  assert.equal(startupCommand('opencode', 'ses_dfb2ee326ffenXILrXxvHwj6qe'), 'opencode -s ses_dfb2ee326ffenXILrXxvHwj6qe');
  assert.throws(() => startupCommand('opencode', 'ses_x; rm -rf /'), /INVALID_SESSION_ID/);
  assert.throws(() => listSessions('gemini', dir, home), /INVALID_AGENT/, 'an unknown agent is an error, never Codex');
});

test('the database path follows OPENCODE_DB, then XDG_DATA_HOME, then the home', () => {
  assert.equal(opencodeDb('/h', {}), '/h/.local/share/opencode/opencode.db');
  assert.equal(opencodeDb('/h', { XDG_DATA_HOME: '/x' }), '/x/opencode/opencode.db');
  assert.equal(opencodeDb('/h', { XDG_DATA_HOME: 'relative' }), '/h/.local/share/opencode/opencode.db', 'a relative XDG_DATA_HOME is ignored');
  assert.equal(opencodeDb('/h', { XDG_DATA_HOME: '/x', OPENCODE_DB: '/db/oc.db' }), '/db/oc.db');
  assert.equal(opencodeDb('/h', { XDG_DATA_HOME: '/x', OPENCODE_DB: 'other.db' }), '/x/opencode/other.db', 'a name is inside opencode\'s data folder');
  assert.equal(opencodeDb('/h', { OPENCODE_DB: ':memory:' }), null);
});

test('no database is no sessions, and the database is never created', () => {
  assert.deepEqual(listSessions('opencode', dir, home, undefined, env), []);
  assert.equal(fs.existsSync(dbFile), false);
});

test('lists the root sessions of the directory, newest first, with untitled ones marked', () => {
  const db = createDb(dbFile);
  insert(db, { id: 'ses_00000000000aOlderTitledSession', title: 'Fix the login page', time_created: 1000, time_updated: 2000 });
  insert(db, { id: 'ses_00000000000bNewerUntitledSess1', title: 'New session - 2026-11-22T19:53:07.462Z', time_created: 3000, time_updated: 4000 });
  insert(db, { id: 'ses_00000000000cChildOfTheOlderOne', parent_id: 'ses_00000000000aOlderTitledSession', title: 'Child session - 2026-11-22T19:53:07.462Z', time_created: 5000, time_updated: 6000 });
  insert(db, { id: 'ses_00000000000dArchivedSession111', title: 'Archived', time_created: 1, time_updated: 9000, time_archived: 9500 });
  insert(db, { id: 'ses_00000000000eAnotherDirectory11', title: 'Elsewhere', directory: path.join(root, 'work', 'other'), time_created: 1, time_updated: 9000 });
  insert(db, { id: 'ses_00000000000fChineseTitle00001', title: '\u4fee\u590d   login\n page', time_created: 10, time_updated: 1500 });
  insert(db, { id: 'bad id; rm -rf /', title: 'not an id', time_created: 1, time_updated: 9999 });
  db.close();
  sessionFiles.clear();
  const rows = listSessions('opencode', dir, home, undefined, env);
  assert.deepEqual(rows, [
    { id: 'ses_00000000000bNewerUntitledSess1', title: 'ledSess1', updated_at: 4000, started_at: 3000, untitled: true },
    { id: 'ses_00000000000aOlderTitledSession', title: 'Fix the login page', updated_at: 2000, started_at: 1000 },
    { id: 'ses_00000000000fChineseTitle00001', title: '\u4fee\u590d login page', updated_at: 1500, started_at: 10 },
  ]);
  assert.deepEqual(listSessions('opencode', dir, home, 1, env).map(row => row.id), ['ses_00000000000bNewerUntitledSess1'], 'the limit');
  assert.deepEqual(listSessions('opencode', path.join(root, 'work', 'none'), home, undefined, env), []);
});

test('a directory reached through a symbolic link finds the sessions of its real path', () => {
  const link = path.join(root, 'link-to-proj');
  fs.symlinkSync(dir, link);
  sessionFiles.clear();
  assert.deepEqual(listSessions('opencode', link, home, undefined, env).map(row => row.id).slice(0, 1), ['ses_00000000000bNewerUntitledSess1']);
});

test('a change while opencode runs (WAL) is seen; an unchanged database is not read again', () => {
  const writer = new Database(dbFile);
  writer.pragma('wal_autocheckpoint = 0'); // the change stays in the WAL file, as while opencode runs
  sessionFiles.clear();
  const before = listSessions('opencode', dir, home, undefined, env).length;
  writer.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?').run('Named by the model', 8000, 'ses_00000000000bNewerUntitledSess1');
  insert(writer, { id: 'ses_00000000000gBrandNewSession01', title: 'Brand new', time_created: 7000, time_updated: 7000 });
  const rows = listSessions('opencode', dir, home, undefined, env);
  assert.equal(rows.length, before + 1);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.id, row.title, Boolean(row.untitled)]), [
    ['ses_00000000000bNewerUntitledSess1', 'Named by the model', false], ['ses_00000000000gBrandNewSession01', 'Brand new', false]]);
  writer.close();
});

test('the listing is cached by the stats of the database and its WAL file', async () => {
  const file = path.join(root, 'cache', 'opencode.db');
  const db = createDb(file);
  insert(db, { id: 'ses_00000000000hCachedSession0001', title: 'Cached', time_created: 1, time_updated: 2 });
  db.close();
  const at = { OPENCODE_DB: file };
  assert.equal(listSessions('opencode', dir, home, undefined, at)[0].title, 'Cached'); // a read-only open leaves an empty WAL file behind
  // A file changed in the last 2 s is never cached (a second write in the same tick would not show): wait until the files are older.
  await new Promise(resolve => setTimeout(resolve, 2100));
  sessionFiles.clear();
  assert.equal(listSessions('opencode', dir, home, undefined, at)[0].title, 'Cached');
  assert.equal(sessionFiles.size(), 1, 'kept while the files stay the same');
  const copy = listSessions('opencode', dir, home, undefined, at);
  copy[0].title = 'changed by a caller';
  assert.equal(listSessions('opencode', dir, home, undefined, at)[0].title, 'Cached', 'callers get copies');
  const writer = new Database(file);
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare('UPDATE session SET title = ? WHERE id = ?').run('Renamed', 'ses_00000000000hCachedSession0001');
  assert.equal(listSessions('opencode', dir, home, undefined, at)[0].title, 'Renamed', 'a write to the WAL file is read again');
  writer.close();
});

test('a file that is not a database, or one without the session table, is no sessions', () => {
  const junk = path.join(root, 'junk.db');
  fs.writeFileSync(junk, 'not a database');
  assert.deepEqual(listSessions('opencode', dir, home, undefined, { OPENCODE_DB: junk }), []);
  const empty = path.join(root, 'empty.db');
  new Database(empty).close();
  assert.deepEqual(listSessions('opencode', dir, home, undefined, { OPENCODE_DB: empty }), []);
});

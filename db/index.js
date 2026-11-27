const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const dataHome = require('../lib/data-home');

// The data folder (~/.tagent by default, see lib/data-home.js): copied once from the old <install>/data, 0700, secrets 0600.
const { dbPath, backupsDir } = dataHome.prepare();
const db = new Database(dbPath);
// The schema generation is stored in the database (PRAGMA user_version). A database written by a newer version is refused,
// so an older app never runs its migrations over data it does not understand; an older database is migrated below and stamped.
const codeSchema = dataHome.codeSchemaVersion();
const storedSchema = db.pragma('user_version', { simple: true });
if (storedSchema > codeSchema) {
  db.close();
  throw dataHome.newerSchemaError(dbPath, storedSchema, codeSchema);
}

db.pragma('journal_mode = WAL');
// With WAL, NORMAL syncs the log at checkpoints instead of at every commit (FULL costs an fsync per commit). The database cannot be corrupted by
// that; a power failure or an operating system crash can only lose the last commits, and a crash of this process loses nothing. The SQLite bundled
// with better-sqlite3 already picks NORMAL for a WAL database (it is built with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1); it is set here so that it does
// not depend on how the driver was built.
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
dataHome.secureDatabaseFiles(dbPath);

// Before an older schema generation is migrated (an existing database, user_version 1 or more), a copy is written to the backups folder, so an
// older app version can be brought back with it (it refuses the migrated database). A failed copy is logged and the start goes on.
if (storedSchema > 0 && storedSchema < codeSchema) {
  const backup = path.join(backupsDir, `db-schema-${storedSchema}-before-${codeSchema}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  try {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    db.prepare('VACUUM INTO ?').run(backup);
    fs.chmodSync(backup, 0o600);
    console.log(`Database: schema ${storedSchema} is migrated to ${codeSchema}; a copy of the database before the migration is in ${backup}`);
  } catch (error) {
    console.warn(`Database: could not copy the database before migrating schema ${storedSchema} to ${codeSchema} (${error.message}); migrating anyway`);
  }
}

// schema.sql creates missing tables on every start; schema 9 added the T-Attention tables (attention_items, attention_events, attention_tokens) this way,
// schema 12 the usage data tables and schema 13 the English learning tables (learn_cards, learn_reviews); schema 26 the tables usage_time and
// memories (services/usage-time.js, "Usage time and memories" in docs/design/usage-time.md), new tables only, so nothing else is needed for them;
// schema 27 the access log tables access_devices, access_device_ips and access_events (services/access-log.js, docs/design/access-log.md), the same way.
// Schema 14: the sync columns of learn_cards and learn_reviews and the table learn_card_moves. They are added to a schema 13 database before
// schema.sql runs, because schema.sql makes indexes on them (services/learn-sync-store.js; a database without learn_cards gets it all from schema.sql).
// Schema 15: learn_cards.phonetic, added there too. Schema 17: learn_reviews.expected, tag and hinted, and the table learn_reports, the same way.
// Schema 19: learn_cards.picked_level, picked_skipped and picked_at (the pick of a translated sentence), the same way.
// Schema 20: the table learn_chats (the questions about a card and their answers), the same way.
// Schema 21: the tables learn_convos and learn_convo_messages (the English chats), the same way.
// Schema 22: learn_cards.fsrs_stability and fsrs_difficulty (FSRS-6), the same way, and every card's review state replayed from its answers once.
// Schema 23: learn_cards.parts and tip (the parts and the spelling tip of a word that keeps slipping), the same way.
// Schema 25: learn_cards.context_zh and context_source (an example sentence of a word's own), the same way.
const fsrsReplay = require('../services/learn-sync-store').ensureSyncSchema(db);
if (fsrsReplay && fsrsReplay.replayed) {
  console.log(`Database: the review state of ${fsrsReplay.replayed} learning cards was replayed with FSRS-6 (${fsrsReplay.earlier} due earlier, ${fsrsReplay.later} later, ${fsrsReplay.skipped} kept)`);
}
// Schema 16: the sync columns of ui_events and ui_controls (the usage data of every linked engine as one set), added the same way
// (services/ui-events.js ensureSchema; a database without the usage data tables gets them from schema.sql).
require('../services/ui-events').ensureSchema(db);
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);
// Every key of system_state and engine_identity is declared with its scope (lib/server-state-keys.js); a row with any other key is refused.
require('../lib/server-state-keys').guard(db);
// Schema 29: once, a stored "After the answer" of the sentence audio becomes the default "When the card appears" (services/learn-sync-store.js
// migrateSentencesAtStart). Only for a database below 29 that existed before (a new one has nothing stored); not on a company computer.
if (storedSchema > 0 && storedSchema < 29) {
  const company = require('../services/device-tier').createDeviceTier({ db }).isCompany();
  const moved = require('../services/learn-sync-store').migrateSentencesAtStart(db, { company });
  if (moved) console.log(`Database: the sentences of ${moved} learning settings are read when the card appears (the default since v2.174.2)`);
}

const { randomUUID } = require('crypto');
const identity = db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get();
if (!identity) {
  db.prepare("INSERT INTO engine_identity (key, value) VALUES ('instance_id', ?)").run(randomUUID());
}

const existing = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
if (!existing.includes('user_id'))     db.exec('ALTER TABLE tasks ADD COLUMN user_id TEXT');
if (!existing.includes('share_token')) db.exec('ALTER TABLE tasks ADD COLUMN share_token TEXT');
if (!existing.includes('work_dir'))    db.exec('ALTER TABLE tasks ADD COLUMN work_dir TEXT');

for (const column of ['technical_path', 'readme_path', 'agent_path']) {
  if (!existing.includes(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
}
// Schema 10: when the task was archived (services/task-archive.js); a task of an older database is simply not archived.
if (!existing.includes('archived_at')) db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT');

// Migrate documents on each host, including Engine workspaces. Missing/offline
// workspaces are left alone and retried on the next startup.
const documents = require('../services/task-documents');
for (const task of db.prepare('SELECT * FROM tasks').all()) {
  const root = task.work_dir || (task.md_path && path.dirname(task.md_path));
  if (!root || !fs.existsSync(root)) continue;
  try {
    documents.ensureDocument(task, 'agent');
    const agentPath = documents.resolveTask(task).agent_path;
    if (agentPath !== task.agent_path) db.prepare('UPDATE tasks SET agent_path = ? WHERE id = ?').run(agentPath, task.id);
  } catch (error) {
    console.warn(`Task ${task.id} instruction migration failed: ${error.message}`);
  }
}

const pairingColumns = db.prepare('PRAGMA table_info(engine_pairing_codes)').all().map(column => column.name);
if (!pairingColumns.includes('principal_id')) {
  db.exec("ALTER TABLE engine_pairing_codes ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'engine'");
}

// Terminals started as a Claude / Codex session remember the agent, its session id (bound later for Codex) and when they were created.
// title_custom (1): the person named the terminal (at creation or by a rename), so that name is shown instead of the agent session's name.
// work_dir (schema 8): the directory the terminal keeps when the task's working directory changes later. Terminals that exist when the column
// is added get the task's current directory, in the same transaction, so nothing changes for them; a second start finds the column and does nothing.
const terminalColumns = db.prepare('PRAGMA table_info(task_terminals)').all().map(column => column.name);
for (const [column, type] of [['agent', 'TEXT'], ['agent_session_id', 'TEXT'], ['agent_started_at', 'INTEGER'], ['title_custom', 'INTEGER']]) {
  if (!terminalColumns.includes(column)) db.exec(`ALTER TABLE task_terminals ADD COLUMN ${column} ${type}`);
}
// Schema 28: a plain terminal keeps its start command. Older terminals start with an empty command.
if (!terminalColumns.includes('start_command')) {
  db.exec("ALTER TABLE task_terminals ADD COLUMN start_command TEXT NOT NULL DEFAULT ''");
}
if (!terminalColumns.includes('work_dir')) {
  db.transaction(() => {
    db.exec('ALTER TABLE task_terminals ADD COLUMN work_dir TEXT');
    db.exec('UPDATE task_terminals SET work_dir = (SELECT work_dir FROM tasks WHERE tasks.id = task_terminals.task_id) WHERE work_dir IS NULL');
  })();
}

// T-Attention items got the context column during schema 9 (before its release); a database made by an earlier build of it gets the column here.
const attentionColumns = db.prepare('PRAGMA table_info(attention_items)').all().map(column => column.name);
if (!attentionColumns.includes('context')) db.exec('ALTER TABLE attention_items ADD COLUMN context TEXT');
// Schema 11: parent_id (the tree), custom_status and result of T-Attention items, and the index on parent_id. Nullable columns, so the items of
// an older database simply have no parent, custom status or result.
require('../services/attention').ensureTreeColumns(db);
// Schema 18: the schedule columns of T-Attention items (schedule, then_action, next_at, schedule_state, runs, last_fired_at, last_done_at, script_runs)
// and the index on next_at. Nullable columns and runs with a default 0, added when missing, so a database of any lower schema gets them.
require('../services/attention').ensureScheduleColumns(db);
// attention_tokens.scopes (extra token permissions, 'market' = "Can manage plugins"): a nullable column, so an older version that does not know
// it still reads and writes the table (its new tokens simply have no scope); no schema bump.
if (!db.prepare('PRAGMA table_info(attention_tokens)').all().some(column => column.name === 'scopes')) db.exec('ALTER TABLE attention_tokens ADD COLUMN scopes TEXT');

// The model and thinking effort chosen for an agent chat (empty: the agent's own default).
const conversationColumns = db.prepare('PRAGMA table_info(agent_conversations)').all().map(column => column.name);
for (const column of ['model', 'effort', 'queue']) { // queue: the messages queued in the chat (JSON)
  if (!conversationColumns.includes(column)) db.exec(`ALTER TABLE agent_conversations ADD COLUMN ${column} TEXT`);
}
// Where a chat is open (see schema.sql): the time it was opened on the desktop page / the phone page.
for (const column of ['opened_web', 'opened_h5', 'translate', 'collapse_keyboard']) { // translate / collapse_keyboard: the chat's switches (collapse_keyboard: NULL is on)
  if (!conversationColumns.includes(column)) db.exec(`ALTER TABLE agent_conversations ADD COLUMN ${column} INTEGER`);
}

// Bookmark groups created before the project became English-first used a Chinese default name.
db.prepare("UPDATE bookmarks SET group_name = 'Default' WHERE group_name = ?").run('\u9ed8\u8ba4');

// Terminal output history is no longer persisted (it lives in memory only). Drop what older versions stored; both statements are no-ops on a
// database that no longer has them, so this is safe to run on every start. Other task_terminals columns (agent_session_id, ...) are untouched.
db.exec('DROP TABLE IF EXISTS terminal_logs');
if (db.prepare('PRAGMA table_info(task_terminals)').all().some(column => column.name === 'buffer')) {
  db.exec('ALTER TABLE task_terminals DROP COLUMN buffer');
}

// User table (local accounts)
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id         INTEGER  PRIMARY KEY AUTOINCREMENT,
  username   TEXT     NOT NULL UNIQUE,
  salt       TEXT     NOT NULL,
  hash       TEXT     NOT NULL,
  work_dir   TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Migration: write the initial accounts configured in .env into the users table (first time only)
const config = require('../config');
for (const [username, cred] of Object.entries(config.authUsers || {})) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run(username, cred.salt, cred.hash);
  }
}

if (storedSchema < codeSchema) db.pragma(`user_version = ${codeSchema}`);

module.exports = db;

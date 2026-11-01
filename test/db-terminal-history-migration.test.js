const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

// db/index.js is a singleton that migrates on require, so each "start" is a child process on a temporary data directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-history-migration-'));
const dbFile = path.join(root, 'db.sqlite');
const start = () => execFileSync(process.execPath, ['-e', "require('./db').close()"], {
  cwd: path.resolve(__dirname, '..'), env: { ...process.env, T_AGENT_DATA_DIR: root, T_AGENT_DB_PATH: dbFile }, stdio: 'pipe',
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a fresh database has no terminal history storage', () => {
  start();
  const db = new Database(dbFile);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'terminal_logs'").get(), undefined);
  assert.deepEqual(db.prepare('PRAGMA table_info(task_terminals)').all().map(c => c.name).sort(),
    ['agent', 'agent_session_id', 'agent_started_at', 'task_id', 'terminal_id', 'title', 'updated_at']);
  db.close();
});

test('the migration drops the old history, keeps all other data and is safe to run again', () => {
  // Turn the database into the old layout: a terminal_logs table and a task_terminals.buffer column, with rows.
  const old = new Database(dbFile);
  old.exec("CREATE TABLE terminal_logs (task_id INTEGER PRIMARY KEY, buffer TEXT NOT NULL DEFAULT '', updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  old.exec("ALTER TABLE task_terminals ADD COLUMN buffer TEXT NOT NULL DEFAULT ''");
  old.prepare("INSERT INTO tasks (id, title, user_id, work_dir) VALUES (1, 'kept task', 'owner', '/work/dir')").run();
  old.prepare("INSERT INTO terminal_logs (task_id, buffer) VALUES (1, 'old default history')").run();
  old.prepare("INSERT INTO task_terminals (task_id, terminal_id, title, buffer, agent, agent_session_id, agent_started_at) VALUES (1, 'term-a', 'Claude', 'old history', 'claude', 'sess-1', 123)").run();
  old.close();

  start();
  start(); // running it again changes nothing

  const db = new Database(dbFile);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'terminal_logs'").get(), undefined);
  assert.equal(db.prepare('PRAGMA table_info(task_terminals)').all().some(c => c.name === 'buffer'), false);
  assert.deepEqual({ ...db.prepare('SELECT task_id, terminal_id, title, agent, agent_session_id, agent_started_at FROM task_terminals').get() },
    { task_id: 1, terminal_id: 'term-a', title: 'Claude', agent: 'claude', agent_session_id: 'sess-1', agent_started_at: 123 });
  assert.deepEqual({ ...db.prepare('SELECT title, user_id, work_dir FROM tasks WHERE id = 1').get() },
    { title: 'kept task', user_id: 'owner', work_dir: '/work/dir' });
  db.close();
});

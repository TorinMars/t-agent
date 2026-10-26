const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');

// The database of an earlier release has no model, effort or opened_* columns; starting the service adds them and keeps the chats.
test('an agent_conversations table from an earlier release gets its new columns and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-db-columns-'));
  try {
    const old = new Database(path.join(dir, 'db.sqlite'));
    const schema = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8')
      .replace(/  model TEXT,\n  effort TEXT,\n/, '').replace(/  opened_web INTEGER,\n  opened_h5 INTEGER,\n/, '').replace(/  -- When the chat was opened[^\n]*\n[^\n]*\n/, '').replace(/  -- The state of the chat's translation switch[^\n]*\n  translate INTEGER,\n/, '').replace(/  -- The messages the person queued[^\n]*\n  queue TEXT,\n/, '');
    old.exec(schema);
    old.prepare("INSERT INTO tasks (title) VALUES ('t')").run();
    old.prepare("INSERT INTO agent_conversations (id, task_id, agent, session_id, title, mode) VALUES ('c1', 1, 'codex', 'thread-1', 'Old chat', 'write')").run();
    assert.deepEqual(old.prepare('PRAGMA table_info(agent_conversations)').all().map(column => column.name).filter(name => /model|effort|opened|translate|queue/.test(name)), []);
    old.close();
    const script = "const db = require('./db'); const names = db.prepare('PRAGMA table_info(agent_conversations)').all().map(c => c.name); const row = db.prepare('SELECT * FROM agent_conversations').get(); db.close(); delete require.cache[require.resolve('./db')]; require('./db').close(); console.log(JSON.stringify({ names, row }));";
    const output = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, T_AGENT_DATA_DIR: dir } }).toString());
    for (const column of ['model', 'effort', 'opened_web', 'opened_h5', 'translate', 'queue']) assert.ok(output.names.includes(column), `${column} was added`);
    assert.deepEqual([output.row.id, output.row.title, output.row.model, output.row.opened_web, output.row.opened_h5, output.row.translate], ['c1', 'Old chat', null, null, null, null]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

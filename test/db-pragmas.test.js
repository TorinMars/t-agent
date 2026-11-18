const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// db/index.js is a singleton that opens the database on require, and these settings belong to its connection, so they are read in a child process
// on a temporary data directory. `asked` is every PRAGMA db/index.js runs itself.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-db-pragmas-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const script = `const Database = require('better-sqlite3');
const asked = [];
const pragma = Database.prototype.pragma;
Database.prototype.pragma = function (source, ...rest) { asked.push(String(source)); return pragma.call(this, source, ...rest); };
const db = require('./db');
const read = name => pragma.call(db, name, { simple: true });
process.stdout.write(JSON.stringify({ asked, journal_mode: read('journal_mode'), synchronous: read('synchronous'), foreign_keys: read('foreign_keys') }));
db.close();`;
const start = () => JSON.parse(execFileSync(process.execPath, ['-e', script], {
  cwd: path.resolve(__dirname, '..'), env: { ...process.env, T_AGENT_DATA_DIR: root, T_AGENT_DB_PATH: path.join(root, 'db.sqlite') }, stdio: 'pipe',
}).toString());

test('the database runs in WAL mode with synchronous NORMAL and foreign keys on, on a fresh and on an existing file', () => {
  for (const label of ['a fresh file', 'an existing file']) {
    const { asked, ...settings } = start();
    // synchronous: 0 OFF, 1 NORMAL, 2 FULL (an fsync per commit).
    assert.deepEqual(settings, { journal_mode: 'wal', synchronous: 1, foreign_keys: 1 }, label);
    // The SQLite bundled with better-sqlite3 would pick NORMAL for a WAL database by itself; db/index.js asks for it, so another build cannot change it.
    assert.ok(asked.includes('synchronous = NORMAL'), `${label}: db/index.js sets it itself (${asked.join('; ')})`);
    assert.ok(asked.indexOf('journal_mode = WAL') < asked.indexOf('synchronous = NORMAL'), 'after WAL is on');
  }
});

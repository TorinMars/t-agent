// What this engine last read of a linked engine's task list (services/linked-last-tasks.js), shown dimmed while that engine is offline ("Tasks of
// an offline engine" in docs/design/failover-and-one-login.md): only the row's fields, written only on a change, servers that are gone dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-linked-last-tasks-'));
const Database = require('better-sqlite3');
const { createLinkedLastTasks } = require('../services/linked-last-tasks');

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE remote_servers (id INTEGER PRIMARY KEY)`);
  db.prepare('INSERT INTO remote_servers (id) VALUES (7), (8)').run();
  let writes = 0;
  const clock = { now: Date.parse('2026-11-20T08:00:00.000Z') };
  const service = createLinkedLastTasks({ db, now: () => clock.now });
  const real = db.prepare.bind(db);
  db.prepare = sql => { if (/^INSERT INTO system_state/.test(sql)) writes += 1; return real(sql); };
  return { db, service, clock, writes: () => writes };
}

test('keeps only what a row shows, and hands it back while the engine is offline', () => {
  const { service } = setup();
  assert.equal(service.lastKnown(7), null);
  service.remember(7, [{ id: 3, title: 'SELF-TAGENT', status: 'doing', sort_order: 2, md_path: '/secret/path.md', work_dir: '/w' }, { title: 'no id' }]);
  assert.deepEqual(service.lastKnown(7), { at: '2026-11-20T08:00:00.000Z', tasks: [{ id: 3, title: 'SELF-TAGENT', status: 'doing', sort_order: 2 }] });
});

test('a list that did not change writes nothing; a changed one is written; servers that are gone are dropped', () => {
  const { db, service, writes } = setup();
  service.remember(7, [{ id: 1, title: 'A', status: 'doing' }]);
  service.remember(8, [{ id: 2, title: 'B', status: 'doing' }]);
  assert.equal(writes(), 2);
  service.remember(7, [{ id: 1, title: 'A', status: 'doing' }]);
  assert.equal(writes(), 2, 'the same list again: no write');
  service.remember(7, [{ id: 1, title: 'A renamed', status: 'doing' }]);
  assert.equal(writes(), 3);
  db.prepare('DELETE FROM remote_servers WHERE id = 8').run();
  service.remember(7, [{ id: 1, title: 'A again', status: 'doing' }]);
  assert.equal(service.lastKnown(8), null);
  assert.equal(service.lastKnown(7).tasks[0].title, 'A again');
});

test('at most 500 rows are kept', () => {
  const { service } = setup();
  service.remember(7, Array.from({ length: 600 }, (_, index) => ({ id: index, title: `T${index}`, status: 'doing' })));
  assert.equal(service.lastKnown(7).tasks.length, 500);
});

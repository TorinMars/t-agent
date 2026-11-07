const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAttentionService, AttentionError } = require('../services/attention');

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  let clock = Date.parse('2026-11-08T10:00:00.000Z');
  const service = createAttentionService({ db, now: () => new Date(clock) });
  return { db, service, tick: (ms = 1000) => { clock += ms; } };
}
const fails = (fn, pattern) => assert.throws(fn, error => error instanceof AttentionError && error.code === 'VALIDATION_FAILED' && (!pattern || pattern.test(error.message)));

test('context is stored as an object and merged shallowly; null removes a key; events name the changed keys', () => {
  const { service } = setup();
  const item = service.create({ title: 'ctx', context: { goal: 'Fix the login', cwd: '/w', turns: 1, session: { agent: 'claude', id: 's1', resume: "cd '/w' && claude --resume s1" } } });
  assert.deepEqual(item.context, { goal: 'Fix the login', cwd: '/w', turns: 1, session: { agent: 'claude', id: 's1', resume: "cd '/w' && claude --resume s1" } });
  const pending = { kind: 'permission', text: 'Allow Bash?', tool: 'Bash', command: 'npm test' };
  const next = service.update(item.id, { status: 'waiting_user', context: { pending, turns: 2, cwd: null, unknown_key: 'dropped' } });
  assert.deepEqual(next.context, { goal: 'Fix the login', turns: 2, pending, session: item.context.session });
  const { events } = service.detail(item.id);
  assert.deepEqual(events[0].data.context, ['cwd', 'pending', 'turns'], 'only the names of the changed keys');
  assert.equal(JSON.stringify(events[0].data).includes('Allow Bash?'), false);
  assert.deepEqual(events[1].data.context, ['cwd', 'goal', 'session', 'turns']);
  // The same context again changes nothing.
  assert.equal(service.update(item.id, { context: { turns: 2 } }).updated_at, next.updated_at);
  assert.equal(service.update(item.id, { context: null }).context, null, 'context: null clears it all');
  // Removing the last key leaves no context.
  const one = service.create({ title: 'one', context: { goal: 'g' } });
  assert.equal(service.update(one.id, { context: { goal: null } }).context, null);
});

test('context values: text is cut to its limit, wrong types and kinds are refused, the whole is at most 32 KiB', () => {
  const { service } = setup();
  const long = service.create({ title: 't', context: { goal: 'g'.repeat(5000), last_reply: `a\u0007b${'r'.repeat(3000)}`, files: Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.js`, added: i, deleted: 0 })) } });
  assert.equal(long.context.goal.length, 2000);
  assert.ok(long.context.last_reply.startsWith('ab'), 'control characters are dropped');
  assert.equal(long.context.last_reply.length, 2000);
  assert.equal(long.context.files.length, 50);
  fails(() => service.create({ title: 't', context: 'text' }), /context/);
  fails(() => service.create({ title: 't', context: { goal: 5 } }), /context\.goal/);
  fails(() => service.create({ title: 't', context: { pending: { kind: 'other', text: 'x' } } }), /pending\.kind/);
  fails(() => service.create({ title: 't', context: { pending: { text: 'x' } } }), /pending\.kind/);
  fails(() => service.create({ title: 't', context: { files: [{ path: 'a', added: -1, deleted: 0 }] } }), /files\.added/);
  fails(() => service.create({ title: 't', context: { files: 'a' } }), /files/);
  fails(() => service.create({ title: 't', context: { started_at: 'yesterday' } }), /started_at/);
  fails(() => service.create({ title: 't', context: { turns: 1.5 } }), /turns/);
  fails(() => service.create({ title: 't', context: { session: 'text' } }), /session/);
  assert.equal(service.create({ title: 't', context: { tagent: null, pending: null } }).context, null);
  assert.deepEqual(service.create({ title: 't', context: { tagent: { task_id: '12', terminal_id: 'default' } } }).context.tagent, { task_id: '12', terminal_id: 'default' });
  // Many full-size keys stay under 32 KiB; the limit is checked on the merged object.
  const full = Array.from({ length: 50 }, (_, i) => ({ path: `${'p'.repeat(990)}${i}`, added: 1, deleted: 1 }));
  fails(() => service.create({ title: 't', context: { files: full } }), /32768 bytes/);
});

test('activity is stored as an activity event in the same transaction; activity alone is published but changes nothing else', () => {
  const { db, service, tick } = setup();
  const seen = [];
  service.onChange(change => seen.push(change));
  const item = service.create({ title: 'a', status: 'working', activity: { kind: 'prompt', text: 'Fix the login' } }, { actor: 'claude' });
  tick();
  const same = service.update(item.id, { activity: { kind: 'note', text: 'n'.repeat(900) } }, { actor: 'claude' });
  assert.equal(same.updated_at, item.updated_at, 'activity only: the item is unchanged');
  service.update(item.id, { status: 'waiting_user', activity: { kind: 'permission', text: 'Allow Bash?' } }, { actor: 'claude' });
  const rows = db.prepare('SELECT type, actor, from_status, to_status, data FROM attention_events WHERE item_id = ? ORDER BY id').all(item.id);
  assert.deepEqual(rows.map(row => [row.type, row.to_status]), [['created', 'working'], ['activity', 'working'], ['activity', 'working'], ['status', 'waiting_user'], ['activity', 'waiting_user']]);
  assert.deepEqual(JSON.parse(rows[1].data), { kind: 'prompt', text: 'Fix the login' });
  assert.equal(JSON.parse(rows[2].data).text.length, 500, 'activity text is cut to 500');
  assert.deepEqual(seen.map(change => [change.kind, change.event.type, change.activity && change.activity.data.kind]), [['created', 'created', 'prompt'], ['updated', 'activity', 'note'], ['updated', 'status', 'permission']]);
  assert.throws(() => service.update(item.id, { activity: { kind: 'shout' } }), /activity\.kind/);
  assert.throws(() => service.update(item.id, { activity: 'text' }), /activity must be a JSON object/);
  // A failing activity row rolls the whole change back.
  db.exec("CREATE TRIGGER no_activity BEFORE INSERT ON attention_events WHEN NEW.type = 'activity' BEGIN SELECT RAISE(ABORT, 'no'); END");
  assert.throws(() => service.update(item.id, { title: 'renamed', activity: { kind: 'note', text: 'x' } }));
  assert.equal(service.get(item.id).title, 'a');
});

test('excerpt is never stored or published; only onChangeInternal subscribers get it', () => {
  const { db, service } = setup();
  const marker = 'SECRET-TRANSCRIPT-MARKER';
  const publicSeen = [];
  const internalSeen = [];
  service.onChange(change => publicSeen.push(change));
  service.onChangeInternal(change => internalSeen.push(change));
  const item = service.create({ title: 'x', excerpt: `start ${marker}`, context: { goal: 'g' }, activity: { kind: 'prompt', text: 'p' } });
  service.upsertByRef('claude:1', { title: 'y', status: 'working', excerpt: marker });
  service.update(item.id, { status: 'review', excerpt: `${'z'.repeat(9000)}${marker}` });
  assert.equal(internalSeen.length, 3);
  assert.equal(internalSeen[0].excerpt, `start ${marker}`);
  assert.ok(internalSeen[2].excerpt.endsWith(marker), 'the end of a long excerpt is kept');
  assert.ok(Buffer.byteLength(internalSeen[2].excerpt) <= 8192);
  assert.equal(JSON.stringify(publicSeen).includes(marker), false, 'never on the public bus (SSE, notifiers)');
  for (const table of ['attention_items', 'attention_events', 'attention_tokens']) {
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(marker), false, table);
  }
  assert.equal(JSON.stringify(service.detail(item.id)).includes(marker), false);
  assert.throws(() => service.create({ title: 'x', excerpt: 5 }), /excerpt must be text/);
  // An excerpt alone is no change.
  service.update(item.id, { excerpt: 'only' });
  assert.equal(internalSeen.length, 3);
});

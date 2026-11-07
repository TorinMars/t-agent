const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAttentionService, AttentionError, TOKEN_PATTERN, hashToken } = require('../services/attention');

// The real schema on an in-memory database, and a clock the test moves.
function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  let clock = Date.parse('2026-11-08T10:00:00.000Z');
  const service = createAttentionService({ db, now: () => new Date(clock) });
  return { db, service, tick: (ms = 1000) => { clock += ms; } };
}
const fails = (fn, code) => assert.throws(fn, error => error instanceof AttentionError && error.code === code);

test('create fills defaults, keeps meta as an object and writes a created event', () => {
  const { service } = setup();
  const item = service.create({ title: '  Review the release  ', meta: { cwd: '/w', host: 'mac' } }, { actor: 'user' });
  assert.equal(item.title, 'Review the release');
  assert.equal(item.status, 'todo');
  assert.equal(item.priority, 'none');
  assert.equal(item.source, 'user');
  assert.deepEqual(item.meta, { cwd: '/w', host: 'mac' });
  assert.equal(item.created_at, '2026-11-08T10:00:00.000Z');
  assert.equal(item.completed_at, null);
  const { events } = service.detail(item.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
  assert.equal(events[0].actor, 'user');
  assert.equal(events[0].to_status, 'todo');
  assert.deepEqual(events[0].data.meta, { cwd: '/w', host: 'mac' });
  // Chinese (and any other) user text is kept as it is.
  assert.equal(service.create({ title: '\u5ba1\u67e5\u53d1\u5e03' }).title, '\u5ba1\u67e5\u53d1\u5e03');
});

test('validation: lengths, enums, dates, link_url and meta', () => {
  const { service } = setup();
  fails(() => service.create({}), 'VALIDATION_FAILED');
  fails(() => service.create({ title: '   ' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x'.repeat(301) }), 'VALIDATION_FAILED');
  assert.equal(service.create({ title: 'x'.repeat(300) }).title.length, 300);
  fails(() => service.create({ title: 'a\nb' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', notes: 'n'.repeat(20001) }), 'VALIDATION_FAILED');
  assert.equal(service.create({ title: 't', notes: 'line 1\nline 2' }).notes, 'line 1\nline 2');
  fails(() => service.create({ title: 't', status: 'started' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', priority: 'urgent' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', due_date: '2026-02-30' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', due_date: '8.11.2026' }), 'VALIDATION_FAILED');
  assert.equal(service.create({ title: 't', due_date: '2026-02-28' }).due_date, '2026-02-28');
  fails(() => service.create({ title: 't', external_ref: 'r'.repeat(201) }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', attention_reason: 'r'.repeat(501) }), 'VALIDATION_FAILED');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', '/\\evil', 'ftp://host/x', 'https://user:pw@host/', 'not a url']) {
    fails(() => service.create({ title: 't', link_url: bad }), 'VALIDATION_FAILED');
  }
  for (const good of ['https://example.com/a?b=1', 'http://127.0.0.1:3000/', '/?openChat=abc']) {
    assert.equal(service.create({ title: 't', link_url: good }).link_url, good);
  }
  for (const bad of [[], 'text', 5]) fails(() => service.create({ title: 't', meta: bad }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', meta: { big: 'x'.repeat(8200) } }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 't', source: 'has space' }), 'VALIDATION_FAILED');
  fails(() => service.create(null), 'VALIDATION_FAILED');
  // Unknown fields are ignored; '' clears an optional field.
  const item = service.create({ title: 't', unknown: 1, notes: '' });
  assert.equal(item.notes, null);
  assert.equal('unknown' in item, false);
});

test('status changes set and clear completed_at and are recorded as status events', () => {
  const { service, tick } = setup();
  const item = service.create({ title: 'job', status: 'working' }, { actor: 'claude' });
  tick();
  const done = service.update(item.id, { status: 'done' }, { actor: 'user' });
  assert.equal(done.completed_at, '2026-11-08T10:00:01.000Z');
  assert.equal(done.updated_at, '2026-11-08T10:00:01.000Z');
  tick();
  const reopened = service.update(item.id, { status: 'review', attention_reason: 'look' }, { actor: 'cli' });
  assert.equal(reopened.completed_at, null);
  tick();
  const renamed = service.update(item.id, { title: 'job 2' });
  assert.equal(renamed.completed_at, null);
  const failed = service.update(item.id, { status: 'failed' });
  assert.ok(failed.completed_at);
  const created = service.create({ title: 'already finished', status: 'cancelled' });
  assert.equal(created.completed_at, created.created_at);
  const { events } = service.detail(item.id);
  assert.deepEqual(events.map(event => [event.type, event.from_status, event.to_status, event.actor]), [
    ['status', 'review', 'failed', 'user'],
    ['updated', 'review', 'review', 'user'],
    ['status', 'done', 'review', 'cli'],
    ['status', 'working', 'done', 'user'],
    ['created', null, 'working', 'claude'],
  ], 'newest first');
  assert.deepEqual(events[2].data, { status: 'review', attention_reason: 'look' }, 'the changed fields');
});

test('an update that changes nothing writes no event and publishes nothing', () => {
  const { service, tick } = setup();
  const item = service.create({ title: 'same', status: 'working' });
  const seen = [];
  service.onChange(change => seen.push(change));
  tick();
  const again = service.update(item.id, { title: 'same', status: 'working' });
  assert.equal(again.updated_at, item.updated_at);
  assert.equal(service.detail(item.id).events.length, 1);
  assert.equal(seen.length, 0);
  fails(() => service.update(9999, { title: 'x' }), 'NOT_FOUND');
  fails(() => service.update(item.id, { title: '' }), 'VALIDATION_FAILED');
});

test('external_ref is unique; upsert by ref creates once and then updates', () => {
  const { service } = setup();
  const first = service.create({ title: 'a', external_ref: 'claude:s1' });
  assert.throws(() => service.create({ title: 'b', external_ref: 'claude:s1' }), error => error.code === 'EXTERNAL_REF_EXISTS' && error.statusCode === 409 && error.id === first.id);
  const other = service.create({ title: 'c' });
  fails(() => service.update(other.id, { external_ref: 'claude:s1' }), 'EXTERNAL_REF_EXISTS');

  const made = service.upsertByRef('claude:s2', { title: 'first prompt', status: 'working', source: 'claude', external_ref: 'ignored' }, { actor: 'claude' });
  assert.equal(made.created, true);
  assert.equal(made.item.external_ref, 'claude:s2');
  const updated = service.upsertByRef('claude:s2', { status: 'waiting_user', attention_reason: 'Permission needed' }, { actor: 'claude' });
  assert.equal(updated.created, false);
  assert.equal(updated.item.id, made.item.id);
  assert.equal(updated.item.title, 'first prompt', 'later calls keep the title when they do not send one');
  assert.equal(updated.item.source, 'claude');
  assert.equal(service.getByRef('claude:s2').status, 'waiting_user');
  const detail = service.detailByRef('claude:s2');
  assert.equal(detail.item.id, made.item.id);
  assert.deepEqual(detail.events.map(event => event.type), ['status', 'created']);
  assert.equal(service.detailByRef('claude:missing'), null);
  fails(() => service.upsertByRef('claude:s3', { status: 'working' }), 'VALIDATION_FAILED'); // creating needs a title
  fails(() => service.upsertByRef('', { title: 'x' }), 'VALIDATION_FAILED');
  // The default source applies to a create only.
  const viaCli = service.upsertByRef('cli:1', { title: 'from cli' }, { defaultSource: 'cli' });
  assert.equal(viaCli.item.source, 'cli');
  assert.equal(service.upsertByRef('claude:s2', { title: 'renamed' }, { defaultSource: 'cli' }).item.source, 'claude');
});

test('list filters by status and text, hides finished items unless asked, and limits', () => {
  const { service } = setup();
  service.create({ title: 'open one' });
  service.create({ title: 'needs me', status: 'waiting_user', attention_reason: 'approve 100%' });
  service.create({ title: 'finished', status: 'done' });
  assert.deepEqual(service.list().map(item => item.title), ['needs me', 'open one'], 'newest first, done hidden');
  assert.equal(service.list({ includeDone: true }).length, 3);
  assert.deepEqual(service.list({ status: 'done,waiting_user' }).map(item => item.title), ['finished', 'needs me']);
  assert.deepEqual(service.list({ q: '100%' }).map(item => item.title), ['needs me'], 'LIKE wildcards in q are literal');
  assert.deepEqual(service.list({ q: 'OPEN' }).map(item => item.title), ['open one']);
  assert.equal(service.list({ limit: 1 }).length, 1);
  fails(() => service.list({ status: 'bogus' }), 'VALIDATION_FAILED');
  fails(() => service.list({ limit: '0' }), 'VALIDATION_FAILED');
});

test('delete removes the item and its events and publishes a deleted change', () => {
  const { db, service } = setup();
  const item = service.create({ title: 'gone', status: 'review' });
  service.update(item.id, { notes: 'n' });
  const seen = [];
  const unsubscribe = service.onChange(change => seen.push(change));
  service.remove(item.id, { actor: 'user' });
  assert.equal(service.get(item.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attention_events WHERE item_id = ?').get(item.id).n, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'deleted');
  assert.equal(seen[0].item.id, item.id);
  assert.equal(seen[0].event.type, 'deleted');
  assert.equal(seen[0].event.from_status, 'review');
  fails(() => service.remove(item.id), 'NOT_FOUND');
  unsubscribe();
  service.create({ title: 'after unsubscribe' });
  assert.equal(seen.length, 1);
});

test('the change bus carries kind, item, previous and the stored event; a failing listener does not stop others', t => {
  const { service } = setup();
  const seen = [];
  t.mock.method(console, 'warn', () => {});
  service.onChange(() => { throw new Error('boom'); });
  service.onChange(change => seen.push(change));
  const item = service.create({ title: 'bus' });
  service.update(item.id, { status: 'waiting_user' });
  assert.deepEqual(seen.map(change => change.kind), ['created', 'updated']);
  assert.equal(seen[0].previous, null);
  assert.equal(seen[1].previous.status, 'todo');
  assert.equal(seen[1].item.status, 'waiting_user');
  assert.equal(seen[1].event.type, 'status');
  assert.ok(seen[1].event.id > 0);
  assert.equal(service.get(item.id).status, 'waiting_user');
});

test('a change is written in one transaction: a failing event insert leaves the item unchanged', () => {
  const { db, service } = setup();
  const item = service.create({ title: 'atomic' });
  db.exec("CREATE TRIGGER no_events BEFORE INSERT ON attention_events BEGIN SELECT RAISE(ABORT, 'no'); END");
  assert.throws(() => service.update(item.id, { title: 'changed' }));
  assert.equal(service.get(item.id).title, 'atomic');
  assert.throws(() => service.create({ title: 'never' }));
  assert.equal(service.list({ q: 'never' }).length, 0);
});

test('tokens: shown once, stored as a hash, verified, last_used_at, revoked', () => {
  const { db, service, tick } = setup();
  const made = service.createToken({ name: ' laptop ' });
  assert.match(made.token, TOKEN_PATTERN);
  assert.ok(made.token.startsWith('tatt_'));
  assert.equal(made.name, 'laptop');
  const row = db.prepare('SELECT * FROM attention_tokens WHERE id = ?').get(made.id);
  assert.equal(row.token_hash, hashToken(made.token));
  assert.equal(JSON.stringify(row).includes(made.token), false);
  assert.equal(JSON.stringify(service.listTokens()).includes(made.token), false);
  tick();
  assert.deepEqual(service.verifyToken(made.token), { id: made.id, name: 'laptop' });
  assert.equal(service.listTokens()[0].last_used_at, '2026-11-08T10:00:01.000Z');
  assert.equal(service.verifyToken(`${made.token.slice(0, -1)}A`), null);
  assert.equal(service.verifyToken('tatt_short'), null);
  assert.equal(service.verifyToken(undefined), null);
  assert.equal(service.tokenActive(made.id), true);
  service.revokeToken(made.id);
  assert.equal(service.verifyToken(made.token), null);
  assert.equal(service.tokenActive(made.id), false);
  assert.ok(service.listTokens()[0].revoked_at);
  fails(() => service.revokeToken(999), 'NOT_FOUND');
  fails(() => service.createToken({ name: '' }), 'VALIDATION_FAILED');
});

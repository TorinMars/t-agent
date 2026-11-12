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

test('plain_turn_end is published on that one change only and is never stored', () => {
  const { service, db } = setup();
  const seen = [];
  service.onChange(change => seen.push(change));
  const { item } = service.upsertByRef('claude:s', { title: 'Task', status: 'working' }, { actor: 'claude', defaultSource: 'claude' });
  service.upsertByRef('claude:s', { status: 'review', plain_turn_end: true, context: { last_reply: 'Done' } }, { actor: 'claude' });
  assert.equal(seen.at(-1).plain_turn_end, true);
  assert.equal(seen.at(-1).item.status, 'review');
  assert.deepEqual(service.get(item.id).context, { last_reply: 'Done' }, 'not in the context');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM attention_items').all()).includes('plain_turn_end'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM attention_events').all()).includes('plain_turn_end'), false);
  // Later changes do not inherit it: another path to review keeps its notice.
  service.update(item.id, { status: 'working' }, { actor: 'user' });
  service.update(item.id, { status: 'review' }, { actor: 'cli' });
  assert.equal(seen.at(-1).item.status, 'review');
  assert.equal('plain_turn_end' in seen.at(-1), false);
  service.update(item.id, { status: 'working' }, { actor: 'user' });
  service.update(item.id, { status: 'review', plain_turn_end: 'yes' }, { actor: 'cli' });
  assert.equal('plain_turn_end' in seen.at(-1), false, 'only exactly true');
  // A task first seen at its plain Stop.
  service.upsertByRef('claude:new', { title: 'New', status: 'review', plain_turn_end: true }, { actor: 'claude' });
  assert.deepEqual([seen.at(-1).kind, seen.at(-1).plain_turn_end], ['created', true]);
});

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
  assert.deepEqual(service.verifyToken(made.token), { id: made.id, name: 'laptop', scopes: [] });
  assert.equal(service.listTokens()[0].last_used_at, '2026-11-08T10:00:01.000Z');
  // One character changed (never to itself: the last one of 32 bytes in base64url has only 16 values, so a fixed 'A' could give the same token).
  const changed = `${made.token.slice(0, 10)}${made.token[10] === 'A' ? 'B' : 'A'}${made.token.slice(11)}`;
  assert.equal(service.verifyToken(changed), null);
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

// ---------- tree, custom status, result and manual order (schema 11) ----------

const titles = items => items.map(item => item.title);
const groupTitles = (service, status) => titles(service.list({ status }));

test('parent_id, custom_status and result round-trip on create, update and upsert, and changes are in the event data', () => {
  const { service } = setup();
  const parent = service.create({ title: 'Parent', external_ref: 'p:1' });
  const child = service.create({ title: 'Child', parent_id: parent.id, custom_status: '  Blocked ', result: 'Half done' });
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.custom_status, 'Blocked', 'trimmed');
  assert.equal(child.result, 'Half done');
  assert.equal(parent.parent_id, null);
  assert.equal(parent.custom_status, null);
  assert.equal(parent.result, null);
  assert.deepEqual(service.events(child.id)[0].data, { title: 'Child', parent_id: parent.id, custom_status: 'Blocked', result: 'Half done' });

  const updated = service.update(child.id, { custom_status: 'Waiting for review', result: '' });
  assert.equal(updated.custom_status, 'Waiting for review');
  assert.equal(updated.result, null, "'' clears");
  assert.deepEqual(service.events(child.id)[0].data, { custom_status: 'Waiting for review', result: null });
  assert.equal(service.update(child.id, { parent_id: null }).parent_id, null);
  assert.deepEqual(service.events(child.id)[0].data, { parent_id: null });

  // parent_ref names the parent by its external_ref, on create, update and PUT by-ref.
  assert.equal(service.update(child.id, { parent_ref: 'p:1' }).parent_id, parent.id);
  const { item: byRef } = service.upsertByRef('c:2', { title: 'By ref', parent_ref: 'p:1', custom_status: 'Queued' });
  assert.deepEqual([byRef.parent_id, byRef.custom_status], [parent.id, 'Queued']);
  assert.equal(service.upsertByRef('c:2', { parent_ref: '' }).item.parent_id, null, "parent_ref '' clears");

  fails(() => service.create({ title: 'x', custom_status: 'a'.repeat(101) }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x', custom_status: 'two\nlines' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x', result: 'a'.repeat(501) }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x', parent_id: 'abc' }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x', parent_id: parent.id, parent_ref: 'p:1' }), 'VALIDATION_FAILED');
  assert.equal(service.create({ title: 'non-ASCII \u4e2d\u6587', custom_status: '\u963b\u585e', result: '\u5b8c\u6210' }).custom_status, '\u963b\u585e');
});

test('an unknown parent or a parent cycle is refused and nothing of the request is applied', () => {
  const { service } = setup();
  const a = service.create({ title: 'A' });
  const b = service.create({ title: 'B', parent_id: a.id });
  const c = service.create({ title: 'C', parent_id: b.id });
  const unknown = error => error instanceof AttentionError && error.code === 'VALIDATION_FAILED' && error.message === 'Unknown parent';
  const cycle = error => error instanceof AttentionError && error.code === 'VALIDATION_FAILED' && error.message === 'Parent cycle';
  assert.throws(() => service.create({ title: 'orphan', parent_id: 999 }), unknown);
  assert.throws(() => service.create({ title: 'orphan', parent_ref: 'nope' }), unknown);
  assert.equal(service.list({ q: 'orphan' }).length, 0, 'nothing created');
  assert.throws(() => service.update(a.id, { title: 'renamed', parent_id: a.id }), cycle);
  assert.throws(() => service.update(a.id, { title: 'renamed', parent_id: c.id }), cycle, 'a descendant');
  assert.throws(() => service.update(b.id, { status: 'done', parent_id: 999 }), unknown);
  assert.equal(service.get(a.id).title, 'A', 'the title was not applied');
  assert.equal(service.get(b.id).status, 'todo', 'the status was not applied');
  assert.throws(() => service.upsertByRef('new:1', { title: 'n', parent_ref: 'new:1' }), unknown, 'it does not exist yet');
  // Depth is unlimited and statuses are independent.
  const d = service.create({ title: 'D', parent_id: c.id, status: 'done' });
  assert.equal(service.get(c.id).status, 'todo');
  service.update(a.id, { status: 'review' });
  assert.equal(service.get(d.id).status, 'done');
  assert.deepEqual(titles(service.list({ parent: b.id })), ['C']);
  assert.deepEqual(titles(service.list({ parent: String(c.id), includeDone: true })), ['D']);
  fails(() => service.list({ parent: 'x' }), 'VALIDATION_FAILED');
});

test('an item with children cannot be deleted: 409 HAS_CHILDREN with the child ids, nothing deleted', () => {
  const { service } = setup();
  const a = service.create({ title: 'A' });
  const b = service.create({ title: 'B', parent_id: a.id });
  const c = service.create({ title: 'C', parent_id: a.id, status: 'done' });
  assert.throws(() => service.remove(a.id), error => error.code === 'HAS_CHILDREN' && error.statusCode === 409 && JSON.stringify(error.children) === JSON.stringify([b.id, c.id]));
  assert.ok(service.get(a.id));
  service.remove(b.id);
  service.update(c.id, { parent_id: null });
  assert.equal(service.remove(a.id), true);
});

test('new items go to the top of their group; a group is shown by sort_order, then id, highest first', () => {
  const { service, db } = setup();
  const one = service.create({ title: 'one' });
  const two = service.create({ title: 'two' });
  assert.ok(two.sort_order > one.sort_order);
  db.prepare('UPDATE attention_items SET sort_order = 5').run();
  assert.deepEqual(groupTitles(service, 'todo'), ['two', 'one'], 'ties: the higher id first');
  assert.equal(service.create({ title: 'three' }).sort_order, 6);
});

test('move: before, after, top and bottom inside a group; only the items in between are renumbered', () => {
  const { service } = setup();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(title => service.create({ title }));
  service.create({ title: 'W', status: 'working' });
  assert.deepEqual(groupTitles(service, 'todo'), ['D', 'C', 'B', 'A']);
  const seen = [];
  service.onChange(change => seen.push(change));

  let result = service.move(a.id, { position: 'top' });
  assert.deepEqual(groupTitles(service, 'todo'), ['A', 'D', 'C', 'B']);
  assert.equal(result.item.id, a.id);
  assert.deepEqual(titles(result.items).sort(), ['A', 'B', 'C', 'D']);
  result = service.move(d.id, { after: b.id });
  assert.deepEqual(groupTitles(service, 'todo'), ['A', 'C', 'B', 'D']);
  assert.deepEqual(titles(result.items).sort(), ['B', 'C', 'D'], 'A keeps its value');
  service.move(b.id, { before: a.id });
  assert.deepEqual(groupTitles(service, 'todo'), ['B', 'A', 'C', 'D']);
  const mark = seen.length;
  service.move(b.id, { position: 'bottom', reason: 'later' });
  assert.deepEqual(groupTitles(service, 'todo'), ['A', 'C', 'D', 'B']);
  assert.deepEqual(groupTitles(service, 'working'), ['W'], 'other groups are untouched');
  const event = service.events(b.id)[0];
  assert.equal(event.type, 'updated');
  assert.deepEqual(event.data.move, { position: 'bottom' });
  assert.equal(event.data.reason, 'later');
  assert.ok('sort_order' in event.data);
  assert.equal(service.events(c.id).some(entry => entry.data && entry.data.move), false, 'renumbered items get no event row');

  // Every published change carries reorder: true; the moved item has its event, the others event null.
  const last = seen.slice(mark);
  assert.deepEqual(last.map(change => change.item.title), ['B', 'A', 'C', 'D'], 'the moved item first');
  assert.ok(last.every(change => change.kind === 'updated' && change.reorder === true));
  assert.equal(last[0].event.type, 'updated');
  assert.ok(last.slice(1).every(change => change.event === null));

  // A move that changes nothing writes and publishes nothing.
  const count = seen.length;
  const same = service.move(a.id, { position: 'top' });
  assert.deepEqual(same.items, []);
  assert.equal(seen.length, count);
  assert.equal(service.events(a.id).length, 2, 'created + the first move');
});

test('move with status changes the status and the place in one transaction; targets must be in the group it ends up in', () => {
  const { service } = setup();
  const w1 = service.create({ title: 'W1', status: 'working' });
  const w2 = service.create({ title: 'W2', status: 'working' });
  const t = service.create({ title: 'T' });
  const done = service.create({ title: 'Done', status: 'done' });
  const failed = service.create({ title: 'Failed', status: 'failed' });
  const message = text => error => error instanceof AttentionError && error.code === 'VALIDATION_FAILED' && error.message === text;
  assert.throws(() => service.move(t.id, { before: w1.id }), message('Target is in another group'));
  assert.throws(() => service.move(t.id, { before: w1.id, status: 'review' }), message('Target is in another group'));
  assert.equal(service.get(t.id).status, 'todo', 'a refused move does not change the status');
  const moved = service.move(t.id, { after: w2.id, status: 'working' });
  assert.equal(moved.item.status, 'working');
  assert.deepEqual(groupTitles(service, 'working'), ['W2', 'T', 'W1']);
  assert.equal(service.events(t.id)[0].type, 'status');
  assert.equal(service.events(t.id)[0].data.status, 'working');
  // done, failed and cancelled are one group.
  service.move(done.id, { after: failed.id });
  assert.deepEqual(groupTitles(service, 'done,failed,cancelled'), ['Failed', 'Done']);
  service.move(w1.id, { before: failed.id, status: 'cancelled' });
  assert.deepEqual(groupTitles(service, 'done,failed,cancelled'), ['W1', 'Failed', 'Done']);
  assert.ok(service.get(w1.id).completed_at);

  assert.throws(() => service.move(t.id, {}), message('Give exactly one of before, after or position'));
  assert.throws(() => service.move(t.id, { before: w2.id, position: 'top' }), message('Give exactly one of before, after or position'));
  assert.throws(() => service.move(t.id, { position: 'middle' }), message("position must be 'top' or 'bottom'"));
  assert.throws(() => service.move(t.id, { before: 'x' }), message('before must be a task id'));
  assert.throws(() => service.move(t.id, { before: 999 }), message('Unknown target'));
  assert.throws(() => service.move(t.id, { after: t.id }), message('A task cannot be moved next to itself'));
  assert.throws(() => service.move(t.id, { position: 'top', status: 'bogus' }), error => error.code === 'VALIDATION_FAILED');
  fails(() => service.move(999, { position: 'top' }), 'NOT_FOUND');
});

test('move: a parent takes its same-group descendants along; after a parent means after its subtree', () => {
  const { service } = setup();
  const p = service.create({ title: 'P' });
  const c1 = service.create({ title: 'C1', parent_id: p.id });
  service.create({ title: 'G', parent_id: c1.id });
  service.create({ title: 'C2', parent_id: p.id });
  const away = service.create({ title: 'Away', parent_id: p.id, status: 'working' });
  const x = service.create({ title: 'X' });
  const y = service.create({ title: 'Y' });
  assert.deepEqual(groupTitles(service, 'todo'), ['Y', 'X', 'C2', 'G', 'C1', 'P']);
  service.move(p.id, { position: 'top' });
  assert.deepEqual(groupTitles(service, 'todo'), ['P', 'C2', 'C1', 'G', 'Y', 'X'], 'depth-first, children in their display order');
  assert.equal(service.get(away.id).status, 'working', 'a descendant in another group stays where it is');
  service.move(y.id, { after: p.id });
  assert.deepEqual(groupTitles(service, 'todo'), ['P', 'C2', 'C1', 'G', 'Y', 'X'], 'after P is after its subtree: already there');
  service.move(x.id, { after: p.id });
  assert.deepEqual(groupTitles(service, 'todo'), ['P', 'C2', 'C1', 'G', 'X', 'Y']);
  service.move(p.id, { position: 'bottom' });
  assert.deepEqual(groupTitles(service, 'todo'), ['X', 'Y', 'P', 'C2', 'C1', 'G']);
  assert.throws(() => service.move(p.id, { before: c1.id }), error => error.message === 'A task cannot be moved next to its own subtask');
  // A child may be moved on its own, inside its parent's block.
  const c2 = service.list({ q: 'C2' })[0];
  service.move(c2.id, { after: c1.id });
  assert.deepEqual(groupTitles(service, 'todo'), ['X', 'Y', 'P', 'C1', 'G', 'C2'], 'after C1 and its child G');
  // A parent that changes group takes the descendants that are already in the new group.
  service.move(p.id, { position: 'top', status: 'working' });
  assert.deepEqual(groupTitles(service, 'working'), ['P', 'Away']);
  assert.deepEqual(groupTitles(service, 'todo'), ['X', 'Y', 'C1', 'G', 'C2']);
});

test('move renumbers ties so the order is strict, inside one transaction', () => {
  const { service, db } = setup();
  const [a, b, c] = ['A', 'B', 'C'].map(title => service.create({ title }));
  db.prepare('UPDATE attention_items SET sort_order = 7').run();
  assert.deepEqual(groupTitles(service, 'todo'), ['C', 'B', 'A']);
  const result = service.move(a.id, { before: b.id });
  assert.deepEqual(groupTitles(service, 'todo'), ['C', 'A', 'B']);
  const orders = service.list().map(item => item.sort_order);
  assert.equal(new Set(orders).size, 3, 'distinct values');
  assert.ok(result.items.some(item => item.id === b.id));
  // A failing event insert rolls the whole move back.
  db.exec("CREATE TRIGGER no_events BEFORE INSERT ON attention_events BEGIN SELECT RAISE(ABORT, 'no'); END");
  const before = JSON.stringify(service.list());
  assert.throws(() => service.move(c.id, { position: 'bottom' }));
  assert.equal(JSON.stringify(service.list()), before);
});

test('a database made from an older schema.sql gets the schema 11 columns from the service', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8').replace(/^\s*(parent_id|custom_status|result)\b.*$/gm, '').replace(/completed_at {5}TEXT,/, 'completed_at TEXT'));
  assert.equal(db.prepare('PRAGMA table_info(attention_items)').all().some(column => column.name === 'parent_id'), false);
  const service = createAttentionService({ db });
  const columns = db.prepare('PRAGMA table_info(attention_items)').all().map(column => column.name);
  for (const name of ['parent_id', 'custom_status', 'result']) assert.ok(columns.includes(name), name);
  const parent = service.create({ title: 'p' });
  assert.equal(service.create({ title: 'c', parent_id: parent.id, result: 'r' }).parent_id, parent.id);
});

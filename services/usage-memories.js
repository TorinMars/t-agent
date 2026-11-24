const crypto = require('crypto');
const time = require('./usage-time');

// Memories ("Memories" in docs/design/usage-time.md): a timeline of what is worth coming back to, in the table memories (schema 26):
// - events: one English line the server makes where it already knows something happened (services/usage-memory-hooks.js): a T-Attention task the
//   person confirmed, sent back or handled, a task an agent finished or that failed, a task created or archived, an update applied, a practice
//   finished, an engine that went offline or came back, an agent turn longer than 30 minutes. De-duplicated: the same code and reference within
//   10 minutes is one event (also across engines: its uid is made from them);
// - notes: the person's own text (1..500 characters) with the time, task and session; never the terminal text;
// - digests: the weekly digest (services/usage-digest.js), one per week (uid digest-<week>).
// Rows are a union by uid across the linked engines; an edit or a delete (a tombstone, text '') wins when its updated_at is newer, a tombstone wins
// a tie. Kept until deleted. Clear (DELETE /api/usage-time?table=memories) makes every row a tombstone and writes a clear mark that every engine
// applies to the rows it has up to that time.

const KINDS = Object.freeze(['event', 'note', 'digest']);
const MAX_NOTE = 500;
const MAX_TEXT = 1200;
const MAX_LIST = 200;
const DEDUP_MS = 10 * 60 * 1000;
const EVENT = /^[a-z][a-z0-9-]{1,39}$/;
const REF = /^[\x20-\x7e]{0,160}$/;
const UID = /^[A-Za-z0-9-]{1,64}$/;
// The events the page may report (POST /api/memories/event): what only the page knows.
const PAGE_EVENTS = Object.freeze({
  'learn-session': 'Learn session finished',
  'learn-practice': 'Practice finished',
});

const fault = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
// One line: control characters and line breaks become spaces, cut to `max`.
const oneLine = (text, max) => String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// A note keeps its line breaks (at most 500 characters), other control characters go.
const noteText = text => String(text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();

function createMemories({ db = require('../db'), now = Date.now, identity = null, usage = null } = {}) {
  const store = usage || time.createUsageTime({ db, now, identity });
  const me = () => store.self().instance_id || '';

  const select = db.prepare('SELECT * FROM memories WHERE uid = ?');
  const upsert = db.prepare(`INSERT INTO memories (uid, at, kind, event, ref, text, task, session, source, week, sources, private, engine, deleted, updated_at, by, sync_seq)
    VALUES (@uid, @at, @kind, @event, @ref, @text, @task, @session, @source, @week, @sources, @private, @engine, @deleted, @updated_at, @by, @sync_seq)
    ON CONFLICT(uid) DO UPDATE SET at = excluded.at, kind = excluded.kind, event = excluded.event, ref = excluded.ref, text = excluded.text, task = excluded.task,
      session = excluded.session, source = excluded.source, week = excluded.week, sources = excluded.sources, private = excluded.private, engine = excluded.engine,
      deleted = excluded.deleted, updated_at = excluded.updated_at, by = excluded.by, sync_seq = excluded.sync_seq`);
  // A change time that is always after the row's last one (the newer wins on every engine).
  const stamp = previous => Math.max(now(), (previous ? previous.updated_at : 0) + 1);
  function write(row) {
    upsert.run({ event: '', ref: '', task: '', session: '', source: '', week: '', sources: '', private: 0, engine: '', deleted: 0, by: '', ...row, sync_seq: time.nextSeq(db) });
    time.usageTimeChanged(db);
    return item(select.get(row.uid));
  }

  // A row as the page gets it.
  function item(row) {
    if (!row) return null;
    let sources = null;
    if (row.sources) { try { sources = JSON.parse(row.sources); } catch { sources = null; } }
    return {
      uid: row.uid, at: row.at, kind: row.kind, event: time.orNull(row.event), text: row.text, task: time.orNull(row.task), session: time.orNull(row.session),
      task_title: row.task ? store.taskTitle(row.task) : null, source: time.orNull(row.source), week: time.orNull(row.week), sources,
      private: Boolean(row.private), engine: row.engine || me(), updated_at: row.updated_at,
    };
  }

  // ---- Events ----
  // Writes an event (made by the server), unless the same code and reference were written in the last 10 minutes. Answers the item or null.
  function addEvent({ event, text, ref = '', task = null, session = null, at = now() }) {
    if (typeof event !== 'string' || !EVENT.test(event) || typeof text !== 'string' || !text.trim()) return null;
    const refs = time.cleanRefs(task, session) || { task: '', session: '' };
    const cleanRef = typeof ref === 'string' && REF.test(ref) ? ref : '';
    const cleared = time.readMemoriesClear(db);
    if (cleared && at <= cleared.at) return null;
    const recent = db.prepare('SELECT 1 FROM memories WHERE kind = \'event\' AND event = ? AND ref = ? AND at > ? AND at <= ? LIMIT 1').pluck().get(event, cleanRef, at - DEDUP_MS, at + DEDUP_MS);
    if (recent) return null;
    // The same event seen by two engines (an engine that went offline, noticed by both of its peers) is one row: its uid is made from the code, the
    // reference and the 10-minute slot.
    const uid = `e-${crypto.createHash('sha256').update(`${event}|${cleanRef}|${Math.floor(at / DEDUP_MS)}`).digest('hex').slice(0, 30)}`;
    if (select.get(uid)) return null;
    return write({ uid, at, kind: 'event', event, ref: cleanRef, text: oneLine(text, 300), task: refs.task, session: refs.session, source: 'auto', updated_at: stamp(null) });
  }
  // POST /api/memories/event { event, task?, session? }: an event only the page knows (PAGE_EVENTS).
  function addPageEvent(body) {
    const allowed = new Set(['event', 'task', 'session']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw fault('INVALID_MEMORY', 400);
    if (!Object.prototype.hasOwnProperty.call(PAGE_EVENTS, body.event)) throw fault('INVALID_MEMORY', 400);
    const refs = time.cleanRefs(body.task, body.session);
    if (!refs) throw fault('INVALID_MEMORY', 400);
    const added = addEvent({ event: body.event, text: PAGE_EVENTS[body.event], ref: refs.session || refs.task, task: refs.task, session: refs.session });
    return { item: added, duplicate: !added };
  }

  // ---- Notes ----
  function checkNote(body, { partial = false } = {}) {
    const allowed = new Set(partial ? ['text', 'private'] : ['text', 'task', 'session', 'private']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw fault('INVALID_MEMORY', 400);
    if (body.private !== undefined && typeof body.private !== 'boolean') throw fault('INVALID_MEMORY', 400);
    if (!partial || body.text !== undefined) {
      if (typeof body.text !== 'string') throw fault('INVALID_MEMORY', 400);
      const text = noteText(body.text);
      if (!text || text.length > MAX_NOTE) throw fault('INVALID_MEMORY', 400);
    }
    if (partial && body.text === undefined && body.private === undefined) throw fault('INVALID_MEMORY', 400);
  }
  // POST /api/memories { text, task?, session?, private? }
  function addNote(body) {
    checkNote(body);
    const refs = time.cleanRefs(body.task, body.session);
    if (!refs) throw fault('INVALID_MEMORY', 400);
    const at = now();
    return write({ uid: crypto.randomUUID(), at, kind: 'note', text: noteText(body.text), task: refs.task, session: refs.session, source: 'person', private: body.private ? 1 : 0, updated_at: stamp(null) });
  }
  // PATCH /api/memories/:uid { text?, private? }: notes only.
  function editNote(uid, body) {
    checkNote(body, { partial: true });
    const row = typeof uid === 'string' && UID.test(uid) ? select.get(uid) : null;
    if (!row || row.deleted) throw fault('MEMORY_NOT_FOUND', 404);
    if (row.kind !== 'note') throw fault('MEMORY_NOT_EDITABLE', 409);
    return write({ ...row, text: body.text === undefined ? row.text : noteText(body.text), private: body.private === undefined ? row.private : (body.private ? 1 : 0), updated_at: stamp(row), by: '' });
  }
  // DELETE /api/memories/:uid: a tombstone (any kind), so the delete travels.
  function remove(uid) {
    const row = typeof uid === 'string' && UID.test(uid) ? select.get(uid) : null;
    if (!row || row.deleted) throw fault('MEMORY_NOT_FOUND', 404);
    write({ ...row, text: '', sources: '', deleted: 1, updated_at: stamp(row), by: '' });
    return { deleted: true, uid };
  }
  const has = uid => Boolean(typeof uid === 'string' && UID.test(uid) && select.get(uid) && !select.get(uid).deleted);

  // ---- Digests ----
  function writeDigest({ week, text, sources, at = now() }) {
    const uid = `digest-${week}`;
    const previous = select.get(uid);
    return write({ uid, at, kind: 'digest', text: oneLine(text, MAX_TEXT), week, sources: JSON.stringify(sources), source: 'model', updated_at: stamp(previous), by: '' });
  }
  const digestOf = week => { const row = select.get(`digest-${week}`); return row && !row.deleted ? item(row) : null; };

  // ---- List ----
  // GET /api/memories?q=&kind=all|event|note|digest&before=<at>&limit=50 -> { items, has_more, digest_on }, newest first.
  function list(query = {}) {
    const kind = query.kind === undefined || query.kind === '' ? 'all' : query.kind;
    if (kind !== 'all' && !KINDS.includes(kind)) throw fault('INVALID_MEMORY_QUERY', 400);
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw fault('INVALID_MEMORY_QUERY', 400);
    const before = query.before === undefined || query.before === '' ? null : Number(query.before);
    if (before !== null && !Number.isSafeInteger(before)) throw fault('INVALID_MEMORY_QUERY', 400);
    const q = query.q === undefined ? '' : String(query.q).trim().slice(0, 200);
    const where = ['deleted = 0'];
    const args = [];
    if (kind !== 'all') { where.push('kind = ?'); args.push(kind); }
    if (before !== null) { where.push('at < ?'); args.push(before); }
    if (q) { where.push("lower(text) LIKE ? ESCAPE '\\'"); args.push(`%${q.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`); }
    if (query.uid !== undefined) { where.push('uid = ?'); args.push(String(query.uid)); }
    const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY at DESC, uid DESC LIMIT ?`).all(...args, limit + 1);
    return { items: rows.slice(0, limit).map(item), has_more: rows.length > limit, digest_on: store.digestOn() };
  }

  // ---- Clear and export ----
  function clear() {
    let cleared = 0;
    const at = now();
    db.transaction(() => {
      for (const row of db.prepare('SELECT * FROM memories WHERE deleted = 0').all()) {
        upsert.run({ ...row, text: '', sources: '', deleted: 1, updated_at: Math.max(at, row.updated_at + 1), by: '', sync_seq: time.nextSeq(db) });
        cleared += 1;
      }
      time.writeMemoriesClear(db, { at, by: '', seq: time.nextSeq(db) });
    })();
    time.usageTimeChanged(db);
    return { cleared };
  }
  const exportColumns = ['at', 'time', 'kind', 'event', 'text', 'task', 'task_title', 'session', 'source', 'week', 'private', 'engine'];
  function exportRow(row) { const value = item(row); return { ...value, time: new Date(value.at).toISOString() }; }
  function exportMemories(write, format = 'json', rows = null) {
    const source = rows || db.prepare('SELECT * FROM memories WHERE deleted = 0 ORDER BY at, uid').iterate();
    if (format === 'csv') {
      write(`${exportColumns.join(',')}\n`);
      for (const row of source) { if (row.deleted) continue; const value = exportRow(row); write(`${time.csvLine(exportColumns.map(column => value[column]))}\n`); }
      return;
    }
    write(`{"exported_at":${JSON.stringify(new Date(now()).toISOString())},"memories":[`);
    let first = true;
    for (const row of source) {
      if (row.deleted) continue;
      const value = exportRow(row);
      delete value.updated_at;
      write(`${first ? '' : ','}${JSON.stringify(value)}`);
      first = false;
    }
    write(']}');
  }

  return { addEvent, addPageEvent, addNote, editNote, remove, has, writeDigest, digestOf, list, clear, exportMemories, item, usage: store };
}

module.exports = { createMemories, oneLine, noteText, KINDS, PAGE_EVENTS, MAX_NOTE, MAX_TEXT, DEDUP_MS, EVENT, UID };

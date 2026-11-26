// The read-only SQL tool of the English coach (`learn_sql`, "Views" and "Security of the SQL tool" in docs/design/learn-english-coach.md). The person's
// diary and chats are readable through it, so it is built to be safe by construction, not by trust in the model:
//
// 1. No live database. A snapshot is made for each answer: a new in-memory database that holds ONLY the coach_* tables, filled by this file from the
//    owner's rows (the owner is the page's login, never anything the model says), with the switches coach_read_answers / coach_read_text applied
//    (a view that is switched off is there but empty). Base tables, other owners, system_state, keys: not in it, so no query can reach them.
// 2. The query runs in a child process (not this server's process): the snapshot is opened there from its bytes, read-only, with a small V8 heap
//    and without the server's environment. The child is killed after QUERY_MS (a recursive bomb, a slow join), and its memory is never the
//    server's. (SQLite's hard_heap_limit does not bind here: the bundled SQLite does not count its memory. So a recursive query may not build
//    strings, the one way a query can grow a value exponentially; SQLite refuses any value over 1 GB anyway.)
// 3. Before it is sent, the text is checked: one statement, SELECT or WITH only, no comments, and none of the words that reach outside a plain
//    read (PRAGMA, ATTACH, load_extension, sqlite_ names, dbstat, fts, file functions, writes, temp objects, functions that make huge values).
//    The child checks again that the statement only reads (better-sqlite3 `reader`), so a write is refused twice.
// 4. At most MAX_ROWS rows and MAX_CHARS characters come back (cut with a marker, `truncated: true`).
const path = require('path');
const { fork } = require('child_process');
const Database = require('better-sqlite3');
const review = require('./learn-review');
const { studyMinutes } = require('./learn');

const QUERY_MS = 2000;
const START_MS = 5000; // the child's start (loading node and better-sqlite3) is not counted in QUERY_MS
const MAX_ROWS = 200;
const MAX_CHARS = 12_000;
const MAX_CELL = 2000;
const MAX_QUERY = 4000;
const CHILD = path.join(__dirname, 'learn-coach-sql-child.js');

class CoachSqlError extends Error {}

// The views: name, what a row is, and the columns with what they hold. learn_schema() gives this text to the model.
const VIEWS = [
  ['coach_cards', 'one row per word card the person studies', [
    ['id', 'INTEGER', 'card id'], ['kind', 'TEXT', 'word'], ['en', 'TEXT', 'the English'], ['zh', 'TEXT', 'the Chinese meaning'],
    ['state', 'TEXT', 'new (never answered) | learning (remembered under a day) | review | relearning (last answer wrong)'],
    ['due', 'TEXT', 'ISO time it is due'], ['stability', 'REAL', 'FSRS stability in days (NULL for new)'], ['difficulty', 'REAL', 'FSRS difficulty 1..10'],
    ['reps', 'INTEGER', 'answers given'], ['lapses', 'INTEGER', 'answers graded again'], ['known', 'INTEGER', '1 when the word counts as learned'],
    ['leech', 'INTEGER', '1 when it keeps slipping'], ['created_at', 'TEXT', 'ISO time added'], ['source', 'TEXT', 'translation | lookup | starter | manual'],
  ], 'answers'],
  ['coach_answers', 'one row per answer in practice', [
    ['card_id', 'INTEGER', 'coach_cards.id'], ['kind', 'TEXT', 'word'], ['en', 'TEXT', 'the card English'], ['at', 'TEXT', 'ISO time'],
    ['day', 'TEXT', 'YYYY-MM-DD in the person\'s time zone'], ['hour', 'INTEGER', '0..23 local'], ['weekday', 'TEXT', 'Monday..Sunday'],
    ['mode', 'TEXT', 'review | spell | build | dictation | say | fill | mistakes'], ['correct', 'INTEGER', '1 | 0'], ['grade', 'TEXT', 'again | hard | good'],
    ['typed', 'TEXT', 'what the person typed (may be NULL)'], ['expected', 'TEXT', 'what was asked for when wrong'], ['tags', 'TEXT', 'the mistake tag of a wrong answer'],
    ['hinted', 'INTEGER', '1 when help was used'],
  ], 'answers'],
  ['coach_days', 'one row per day with answers', [
    ['day', 'TEXT', 'YYYY-MM-DD local'], ['answers', 'INTEGER', 'answers that day'], ['cards', 'INTEGER', 'different cards answered'],
    ['right_first_time', 'INTEGER', 'cards whose first answer that day was right'], ['minutes', 'INTEGER', 'study minutes'], ['new_cards', 'INTEGER', 'cards answered for the first time'],
  ], 'answers'],
  ['coach_mistakes', 'one row per card ever answered wrong', [
    ['card_id', 'INTEGER', 'coach_cards.id'], ['kind', 'TEXT', 'word'], ['en', 'TEXT', 'the English'], ['wrong_count', 'INTEGER', 'wrong answers'],
    ['last_wrong_at', 'TEXT', 'ISO time'], ['tags', 'TEXT', 'the mistake tags, comma separated'], ['in_mistakes', 'INTEGER', '1 when it is in the Mistakes practice now'],
  ], 'answers'],
  ['coach_settings', 'the learning settings', [['key', 'TEXT', 'setting name'], ['value', 'TEXT', 'its value as JSON']], 'always'],
  ['coach_queue', 'what practice has now, by mode', [
    ['mode', 'TEXT', 'review | spell | fill | dictation | say | mistakes'], ['due', 'INTEGER', 'cards due now (not new)'],
    ['new_left', 'INTEGER', 'new cards still allowed today'], ['new_available', 'INTEGER', 'new cards this mode would give today'],
  ], 'answers'],
  ['coach_reports', 'the mistake reports', [['at', 'TEXT', 'ISO time'], ['summary', 'TEXT', 'the report summary'], ['mistakes', 'INTEGER', 'wrong answers covered'], ['answers', 'INTEGER', 'answers covered']], 'answers'],
  ['coach_journal', 'one row per English journal entry the person wrote', [
    ['day', 'TEXT', 'YYYY-MM-DD local'], ['weekday', 'TEXT', 'Monday..Sunday'], ['part', 'TEXT', 'morning | afternoon | evening | late night'],
    ['words', 'INTEGER', 'length in words'], ['text', 'TEXT', 'the entry as written'],
  ], 'text'],
  ['coach_messages', 'the person\'s chat messages (old English chats and this coach conversation)', [
    ['conversation', 'TEXT', "'coach' or the title of an old chat"], ['role', 'TEXT', 'user | assistant | practice'], ['at', 'TEXT', 'ISO time'],
    ['day', 'TEXT', 'YYYY-MM-DD local'], ['text', 'TEXT', 'the message'],
  ], 'text'],
];

// The text of learn_schema() for these switches.
function schemaText({ readAnswers = true, readText = true } = {}) {
  const lines = ['Read-only SQLite views of the person\'s English learning data (owner-scoped). Use SELECT or WITH ... SELECT on these only; one statement; at most 200 rows come back.'];
  for (const [name, about, columns, gate] of VIEWS) {
    const off = (gate === 'answers' && !readAnswers) || (gate === 'text' && !(readAnswers && readText));
    lines.push(`${name}: ${about}${off ? ' [EMPTY: the person switched this off in Learn settings]' : ''}`);
    lines.push(`  ${columns.map(([column, type, what]) => `${column} ${type} (${what})`).join('; ')}`);
  }
  lines.push('Times are ISO strings; days, hours and weekdays are in the person\'s time zone. SQLite functions such as count, sum, avg, min, max, round, date, strftime, substr, lower, instr, group_concat, json_extract work.');
  return lines.join('\n');
}

const iso = value => (Number.isFinite(value) ? new Date(value).toISOString() : null);
const WORDS = text => (String(text || '').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
const REVIEW_PREFIX = /^\s*please review my journal entry\s*:?\s*/i;
const formats = new Map();
function localParts(at, timeZone) {
  const id = timeZone || '';
  let format = formats.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', hourCycle: 'h23' });
    formats.set(id, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  const part = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 22 ? 'evening' : 'late night';
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hour, part };
}

// The snapshot for one owner: the bytes of an in-memory SQLite database holding only the coach_* tables. `learn`: the learning service of `db`
// (settings, pace, mistakeRows, slips). `readAnswers` / `readText`: the switches (off: the views are there, empty).
function buildSnapshot(db, owner, { learn, now = Date.now(), timeZone, readAnswers = true, readText = true } = {}) {
  const snap = new Database(':memory:');
  try {
    for (const [name, , columns] of VIEWS) snap.exec(`CREATE TABLE ${name} (${columns.map(([column, type]) => `${column} ${type}`).join(', ')})`);
    const insert = (name, rows) => {
      if (!rows.length) return;
      const columns = VIEWS.find(view => view[0] === name)[2].map(column => column[0]);
      const statement = snap.prepare(`INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(column => `@${column}`).join(', ')})`);
      for (const row of rows) statement.run(Object.fromEntries(columns.map(column => [column, row[column] === undefined ? null : row[column]])));
    };
    const current = learn.settings(owner);
    snap.transaction(() => {
      insert('coach_settings', Object.entries(current).map(([key, value]) => ({ key, value: JSON.stringify(value) })));
      if (!readAnswers) return;
      // Cards shown at all (services/learn.js `visible`).
      const cards = db.prepare(`SELECT * FROM learn_cards WHERE owner = @owner AND kind = 'word' AND suspended = 0 AND NOT (source = 'starter' AND reps = 0 AND @starter IS NULL) ORDER BY id`)
        .all({ owner, starter: current.starter });
      const slipped = learn.slips(cards);
      const rightCounts = new Map(db.prepare('SELECT card_id, SUM(correct) AS right FROM learn_reviews WHERE owner = ? GROUP BY card_id').all(owner).map(row => [row.card_id, row.right]));
      const byId = new Map(cards.map(card => [card.id, card]));
      insert('coach_cards', cards.map(card => {
        const days = Number.isFinite(card.fsrs_stability) ? card.fsrs_stability : card.interval_days;
        const state = !(card.reps > 0) ? 'new' : card.last_correct === 0 ? 'relearning' : days < 1 ? 'learning' : 'review';
        return {
          id: card.id, kind: card.kind, en: card.en, zh: card.zh, state, due: iso(card.due_at), stability: card.fsrs_stability, difficulty: card.fsrs_difficulty,
          reps: card.reps, lapses: card.lapses, known: review.isKnown(card, rightCounts.get(card.id) || 0) ? 1 : 0, leech: (slipped.get(card.id) || {}).leech ? 1 : 0,
          created_at: iso(card.created_at), source: card.source,
        };
      }));
      const answers = db.prepare('SELECT * FROM learn_reviews WHERE owner = ? ORDER BY at, id').all(owner).filter(row => byId.has(row.card_id));
      insert('coach_answers', answers.map(row => {
        const local = localParts(row.at, timeZone);
        const card = byId.get(row.card_id);
        return {
          card_id: row.card_id, kind: card.kind, en: card.en, at: iso(row.at), day: local.day, hour: local.hour, weekday: local.weekday, mode: row.mode, correct: row.correct,
          grade: row.grade, typed: row.answer, expected: row.expected, tags: row.tag || null, hinted: row.hinted,
        };
      }));
      // The days: answers, cards, right the first time that day, minutes, cards answered for the first time.
      const days = new Map();
      const firstEver = new Set();
      for (const row of answers) {
        const day = localParts(row.at, timeZone).day;
        const value = days.get(day) || { day, answers: 0, cards: new Set(), right: 0, times: [], fresh: 0 };
        value.answers += 1;
        if (!value.cards.has(row.card_id)) { value.cards.add(row.card_id); if (row.correct) value.right += 1; }
        if (!firstEver.has(row.card_id)) { firstEver.add(row.card_id); value.fresh += 1; }
        value.times.push(row.at);
        days.set(day, value);
      }
      insert('coach_days', [...days.values()].map(value => ({
        day: value.day, answers: value.answers, cards: value.cards.size, right_first_time: value.right, minutes: studyMinutes(value.times), new_cards: value.fresh,
      })));
      const inMistakes = new Set(learn.mistakeRows(owner, current.starter).map(row => row.id));
      const wrong = new Map();
      for (const row of answers) {
        if (row.correct) continue;
        const value = wrong.get(row.card_id) || { count: 0, last: 0, tags: new Set() };
        value.count += 1;
        value.last = Math.max(value.last, row.at);
        if (row.tag) value.tags.add(row.tag);
        wrong.set(row.card_id, value);
      }
      insert('coach_mistakes', [...wrong.entries()].map(([id, value]) => ({
        card_id: id, kind: byId.get(id).kind, en: byId.get(id).en, wrong_count: value.count, last_wrong_at: iso(value.last), tags: [...value.tags].join(',') || null,
        in_mistakes: inMistakes.has(id) ? 1 : 0,
      })));
      // The queue, with the same rules as services/learn.js queue (due cards that are not new; new ones up to today's allowance).
      const pace = learn.pace(owner, current, now);
      const { hasPracticeContext } = require('./learn-sentences');
      const withContext = cards.filter(hasPracticeContext);
      const queue = ['review', 'spell', 'fill', 'dictation', 'say'].map(mode => {
        const candidates = mode === 'fill' ? withContext : cards;
        return {
          mode, due: candidates.filter(card => card.reps > 0 && card.due_at <= now).length, new_left: pace.new_left,
          new_available: Math.min(pace.new_left, candidates.filter(card => !card.reps && (mode !== 'review' || card.due_at <= now)).length),
        };
      });
      queue.push({ mode: 'mistakes', due: inMistakes.size, new_left: pace.new_left, new_available: 0 });
      insert('coach_queue', queue);
      insert('coach_reports', db.prepare('SELECT * FROM learn_reports WHERE owner = ? ORDER BY covers_until').all(owner).map(row => {
        let summary = '';
        try { summary = String(JSON.parse(row.body).summary || ''); } catch { summary = ''; }
        return { at: iso(row.created_at), summary, mistakes: row.mistakes, answers: row.answers };
      }));
      if (!readText) return;
      const convos = db.prepare('SELECT uid, title, journal FROM learn_convos WHERE owner = ? AND deleted = 0').all(owner);
      const messages = [];
      const journal = [];
      for (const convo of convos) {
        const rows = db.prepare('SELECT role, text, at, meta FROM learn_convo_messages WHERE owner = ? AND convo_uid = ? ORDER BY at, uid').all(owner, convo.uid);
        const name = convo.uid === 'coach' ? 'coach' : convo.title || 'English chat';
        for (const row of rows) messages.push({ conversation: name, role: row.role, at: iso(row.at), day: localParts(row.at, timeZone).day, text: row.text });
        // The journal entries (as services/learn-chat.js counts them): in a journal chat the questions whose answer said journal, else its first
        // question; in the coach conversation the messages whose answer said journal.
        const pairs = [];
        rows.forEach((row, index) => {
          if (row.role !== 'user') return;
          const next = rows[index + 1] && rows[index + 1].role === 'assistant' ? rows[index + 1] : null;
          let flagged = false;
          try { flagged = Boolean(next && next.meta && JSON.parse(next.meta).journal); } catch { flagged = false; }
          pairs.push({ row, flagged });
        });
        const flagged = pairs.filter(pair => pair.flagged);
        const chosen = flagged.length ? flagged : convo.journal && convo.uid !== 'coach' ? pairs.slice(0, 1) : [];
        for (const { row } of chosen) {
          const local = localParts(row.at, timeZone);
          const text = row.text.replace(REVIEW_PREFIX, '');
          journal.push({ day: local.day, weekday: local.weekday, part: local.part, words: WORDS(text), text });
        }
      }
      insert('coach_messages', messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
      insert('coach_journal', journal.sort((a, b) => (a.day < b.day ? -1 : 1)));
    })();
    return snap.serialize();
  } finally {
    snap.close();
  }
}

// ---- The check of the query text ----
// Words that never appear in a query of the coach (outside string literals, and inside quoted names too). Writes and schema changes, transactions,
// PRAGMA, ATTACH, extensions, file and virtual-table functions, and the functions that make values of any size.
const DENIED = new Set([
  'pragma', 'attach', 'detach', 'load_extension', 'readfile', 'writefile', 'edit', 'fsdir', 'zipfile', 'sqlar_compress', 'sqlar_uncompress', 'dbstat',
  'fts3', 'fts4', 'fts5', 'fts5vocab', 'rtree', 'geopoly', 'randomblob', 'zeroblob', 'printf', 'format', 'char', 'unhex', 'insert', 'update', 'delete',
  'upsert', 'create', 'drop', 'alter', 'vacuum', 'reindex', 'analyze', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'temp', 'temporary',
  'trigger', 'virtual', 'into', 'returning', 'indexed', 'sqlite_version', 'sqlite_source_id', 'sqlite_compileoption_used', 'sqlite_compileoption_get', 'sqlite_offset',
]);
const DENIED_PREFIX = /^(sqlite_|pragma_|fts|json_tree$)/;

// The tokens of a query: { words (lower-case, quoted names included), semicolons (their places), concat (a || outside literals) }, or a CoachSqlError.
function tokens(query) {
  const words = [];
  let index = 0;
  const semicolons = [];
  let concat = false;
  const length = query.length;
  while (index < length) {
    const char = query[index];
    if (char === "'") { // a string literal ('' inside)
      index += 1;
      while (index < length && !(query[index] === "'" && query[index + 1] !== "'")) index += query[index] === "'" ? 2 : 1;
      if (index >= length) throw new CoachSqlError('A string is not closed');
      index += 1;
    } else if (char === '"' || char === '`' || char === '[') { // a quoted name: checked like a word
      const close = char === '[' ? ']' : char;
      let end = index + 1;
      let name = '';
      while (end < length && !(query[end] === close && query[end + 1] !== close)) { name += query[end]; end += query[end] === close ? 2 : 1; }
      if (end >= length) throw new CoachSqlError('A quoted name is not closed');
      words.push(name.toLowerCase());
      index = end + 1;
    } else if (char === '-' && query[index + 1] === '-') throw new CoachSqlError('Comments are not allowed');
    else if (char === '/' && query[index + 1] === '*') throw new CoachSqlError('Comments are not allowed');
    else if (char === ';') { semicolons.push(index); index += 1; }
    else if (char === '|' && query[index + 1] === '|') { concat = true; index += 2; }
    else if (/[A-Za-z_\u0080-￿]/.test(char)) {
      let end = index;
      while (end < length && /[A-Za-z0-9_$\u0080-￿]/.test(query[end])) end += 1;
      words.push(query.slice(index, end).toLowerCase());
      index = end;
    } else if (char === '?' || char === ':' || char === '@' || char === '$') {
      // A bound parameter: there are none to bind.
      if (char !== ':' || /[A-Za-z_]/.test(query[index + 1] || '')) throw new CoachSqlError('Parameters are not allowed');
      index += 1;
    } else index += 1;
  }
  return { words, semicolons, concat };
}

// The query as it is run, or a CoachSqlError with what is wrong (the model may try again).
function checkQuery(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new CoachSqlError('Give a query');
  if (raw.length > MAX_QUERY) throw new CoachSqlError(`The query cannot exceed ${MAX_QUERY} characters`);
  if (/\u0000/.test(raw)) throw new CoachSqlError('Invalid characters in the query');
  let query = raw.trim();
  const { words, semicolons, concat } = tokens(query);
  // One statement: a single ; only at the very end.
  if (semicolons.length > 1 || (semicolons.length === 1 && semicolons[0] !== query.length - 1)) throw new CoachSqlError('Only one statement is allowed');
  if (semicolons.length) query = query.slice(0, -1).trim();
  if (words[0] !== 'select' && words[0] !== 'with') throw new CoachSqlError('Only SELECT (or WITH ... SELECT) is allowed');
  for (const word of words) {
    if (DENIED.has(word) || DENIED_PREFIX.test(word)) throw new CoachSqlError(`"${word}" is not allowed; read the coach_* views only`);
  }
  // A recursive query may not build strings (doubling a string each step fills the memory long before the time limit).
  if (words.includes('recursive') && (concat || words.some(word => ['replace', 'concat', 'concat_ws', 'group_concat', 'string_agg', 'json_group_array', 'json_group_object'].includes(word)))) {
    throw new CoachSqlError('A recursive query cannot build strings');
  }
  return query;
}

// Runs a checked query over a snapshot in a child process: { columns, rows, truncated } or { error } (a refusal, an SQL error, the time limit).
function runQuery(snapshot, raw, { timeoutMs = QUERY_MS, maxRows = MAX_ROWS, maxChars = MAX_CHARS } = {}) {
  let query;
  try { query = checkQuery(raw); } catch (error) { return Promise.resolve({ error: error.message }); }
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const child = fork(CHILD, [], {
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=96'],
      // Nothing of the server's environment (no secrets), only what node needs to start.
      env: { PATH: process.env.PATH || '', NODE_OPTIONS: '' },
    });
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(value);
    };
    timer = setTimeout(() => finish({ error: 'The coach database could not be started' }), START_MS);
    child.on('message', message => {
      if (message && message.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ error: `The query took longer than ${timeoutMs / 1000} seconds and was stopped; make it simpler` }), timeoutMs);
        child.send({ snapshot, query, maxRows, maxChars, maxCell: MAX_CELL });
        return;
      }
      if (message && Array.isArray(message.columns)) finish({ columns: message.columns, rows: message.rows, truncated: Boolean(message.truncated) });
      else finish({ error: message && typeof message.error === 'string' ? message.error.slice(0, 300) : 'The query failed' });
    });
    child.on('error', () => finish({ error: 'The coach database could not be started' }));
    child.on('exit', () => finish({ error: 'The query used too much memory or failed; make it simpler' }));
  });
}

module.exports = { buildSnapshot, checkQuery, runQuery, schemaText, VIEWS, CoachSqlError, QUERY_MS, MAX_ROWS, MAX_CHARS, MAX_QUERY };

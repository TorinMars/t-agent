const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { parseOptions, runBackfill } = require('../scripts/learn-sentences-backfill');
const { dayStateKey } = require('../services/learn-sentences');
const { createLearn, settingsVersionKey } = require('../services/learn');
const { readState, writeState } = require('../services/settings-sync-store');

const NOW = Date.UTC(2026, 10, 25);
const S1 = 'We need a resilient deploy step before the release.';
const S2 = 'Please review the flaky tests and backlog before lunch.';
const ZH = '\u8fd9\u662f\u4e00\u4e2a\u4f8b\u53e5';
const good = word => JSON.stringify({ sentence: `Our team will ${word} the new plan next week.`, zh: ZH });

function setup(t, answer = good) {
  const dir = mkdtempSync(path.join(__dirname, '.backfill-test-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  const learn = createLearn({ db, now: () => NOW, lookupPhonetic: () => '' });
  const add = db.prepare(`INSERT INTO learn_cards (owner, kind, en, norm, zh, source, context, created_at, due_at,
    content_at, sync_seq, context_source, suspended) VALUES ('me', ?, ?, ?, ?, 'translation', ?, ?, ?, ?, ?, ?, ?)`);
  let seq = 0;
  function addCard(kind, word, context = '', origin = '', suspended = 0) {
    seq += 1;
    return Number(add.run(kind, word, word.toLowerCase(), ZH, context, NOW - 100 + seq, NOW, NOW - 100 + seq, seq, origin, suspended).lastInsertRowid);
  }
  addCard('sentence', S1);
  addCard('sentence', S2);
  addCard('word', 'resilient', S1);
  addCard('word', 'deploy', S1);
  const learned = addCard('word', 'release', S1);
  addCard('word', 'step', S1, 'manual');
  addCard('word', 'review', S2);
  addCard('word', 'flaky', S2);
  addCard('word', 'backlog', S2);
  addCard('word', 'lunch', S2, '', 1);
  db.prepare(`UPDATE learn_cards SET reps = 2, fsrs_stability = 25, fsrs_difficulty = 4, due_at = ?, last_correct = 1,
    interval_days = 30, last_result = 'good', last_at = ? WHERE id = ?`).run(NOW + 1000, NOW - 1000, learned);
  db.prepare(`INSERT INTO learn_reviews (card_id, owner, at, mode, grade, correct, answer, sync_seq)
    VALUES (?, 'me', ?, 'spell', 'good', 1, 'release', 11)`).run(learned, NOW - 1000);
  writeState(db, dayStateKey('me'), { day: '2026-11-25', count: 10 });
  writeState(db, settingsVersionKey('me'), { seq: 50, at: NOW, by: '' });

  const calls = [];
  const logs = [];
  const state = { company: false, configured: true };
  const deps = {
    db, owner: 'me', now: () => NOW, level: name => learn.level(name),
    isCompany: () => state.company, log: { info: line => logs.push(line), warn: line => logs.push(line) },
    translator: {
      isConfigured: () => state.configured,
      converse: async (owner, system, messages) => {
        assert.equal(owner, 'me');
        const { word } = JSON.parse(messages[0].content);
        calls.push(word);
        return answer(word, db);
      },
    },
  };
  const cards = () => db.prepare('SELECT * FROM learn_cards ORDER BY id').all();
  const reviews = () => db.prepare('SELECT * FROM learn_reviews ORDER BY id').all();
  const snapshot = () => ({ cards: cards(), reviews: reviews(), state: db.prepare('SELECT * FROM system_state ORDER BY key').all() });
  const run = (args, overrides) => runBackfill(parseOptions(['--delay-ms', '0', ...args]), { ...deps, ...overrides });
  return { db, cards, reviews, snapshot, calls, logs, state, run };
}

test('dry run is the default, reports candidate counts and leaves the database unchanged', async t => {
  const ctx = setup(t);
  const before = ctx.snapshot();
  assert.equal(await ctx.run([]), 0);
  assert.match(ctx.logs[0], /Dry run: 2 groups, 4 cards \(3 still learning, 1 learned\)/);
  assert.match(ctx.logs[1], /Example words: "backlog", "flaky", "deploy", "release"/);
  assert.equal(await ctx.run(['--dry-run', '--limit', '1']), 0);
  assert.match(ctx.logs[2], /1 groups, 1 cards/);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.snapshot(), before);
});

test('apply goes through all groups, preserves review state and the original keepers, and can be rerun', async t => {
  const ctx = setup(t);
  const before = ctx.snapshot();
  let confirmed = false;
  assert.equal(await ctx.run(['--apply'], { confirm: plan => {
    confirmed = true;
    assert.equal(plan.cards, 4);
    return true;
  } }), 0);
  assert.equal(confirmed, true);
  assert.deepEqual(ctx.calls, ['backlog', 'flaky', 'deploy', 'release']);
  assert.match(ctx.logs.at(-1), /4 done, 0 none, 0 failed, 0 skipped/);
  assert.ok(ctx.logs.some(line => /^"release": done \(\d+ characters\)$/.test(line)));
  assert.ok(ctx.logs.every(line => !line.includes(S1) && !line.includes(S2) && !line.includes('Our team will')));
  const generated = new Set(ctx.calls);
  for (const [index, card] of ctx.cards().entries()) {
    const old = before.cards[index];
    if (!generated.has(card.en)) {
      assert.deepEqual(card, old);
      continue;
    }
    const { context, context_zh, context_source, content_at, content_by, sync_seq } = card;
    assert.deepEqual([context, context_zh, context_source], [JSON.parse(good(card.en)).sentence, ZH, 'generated']);
    assert.ok(content_at > old.content_at && sync_seq > 50);
    assert.equal(content_by, '');
    assert.deepEqual({ ...card, context: old.context, context_zh: old.context_zh, context_source: old.context_source,
      content_at: old.content_at, content_by: old.content_by, sync_seq: old.sync_seq }, old);
  }
  assert.deepEqual(ctx.reviews(), before.reviews);
  assert.deepEqual(readState(ctx.db, dayStateKey('me')), { day: '2026-11-25', count: 10 });
  const after = ctx.snapshot();
  assert.equal(await ctx.run(['--apply', '--yes']), 0);
  assert.deepEqual(ctx.snapshot(), after);
  assert.equal(ctx.calls.length, 4);
  assert.match(ctx.logs.at(-1), /0 done, 0 none, 0 failed, 0 skipped/);
});

test('apply respects the confirmation and limit, then resumes with remaining cards', async t => {
  const ctx = setup(t);
  const before = ctx.snapshot();
  assert.equal(await ctx.run(['--apply'], { confirm: () => false }), 0);
  assert.deepEqual(ctx.snapshot(), before);
  assert.deepEqual(ctx.calls, []);
  assert.equal(await ctx.run(['--apply', '--yes', '--limit', '2']), 0);
  assert.deepEqual(ctx.calls, ['backlog', 'flaky']);
  assert.equal(await ctx.run(['--apply', '--yes']), 0);
  assert.deepEqual(ctx.calls, ['backlog', 'flaky', 'deploy', 'release']);
});

test('three consecutive model failures stop the run without exposing provider messages', async t => {
  const ctx = setup(t, () => { throw new Error('Private provider error'); });
  const before = ctx.snapshot();
  assert.equal(await ctx.run(['--apply', '--yes']), 1);
  assert.deepEqual(ctx.calls, ['backlog', 'flaky', 'deploy']);
  assert.deepEqual(ctx.snapshot(), before);
  assert.match(ctx.logs.at(-2), /Stopped after 3 consecutive model failures/);
  assert.match(ctx.logs.at(-1), /0 done, 0 none, 3 failed, 1 skipped/);
  assert.ok(ctx.logs.every(line => !line.includes('Private provider error')));
});

test('invalid model answers use the existing retry and none outcome, and a concurrent context edit is skipped', async t => {
  const ctx = setup(t, (word, db) => {
    if (word === 'backlog') return 'Invalid answer';
    if (word === 'flaky') db.prepare(`UPDATE learn_cards SET context = 'My own example.', context_source = 'manual' WHERE en = ?`).run(word);
    return good(word);
  });
  assert.equal(await ctx.run(['--apply', '--yes']), 0);
  assert.deepEqual(ctx.calls, ['backlog', 'backlog', 'flaky', 'deploy', 'release']);
  assert.equal(ctx.cards().find(card => card.en === 'backlog').context_source, 'none');
  assert.equal(ctx.cards().find(card => card.en === 'flaky').context, 'My own example.');
  assert.match(ctx.logs.at(-1), /2 done, 1 none, 0 failed, 1 skipped/);
});

test('company computers and owners with no translation model are refused', async t => {
  const ctx = setup(t);
  const before = ctx.snapshot();
  ctx.state.company = true;
  await assert.rejects(ctx.run(['--apply', '--yes']), /company computer/);
  ctx.state.company = false;
  ctx.state.configured = false;
  await assert.rejects(ctx.run([]), /No usable translation model is configured/);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.snapshot(), before);
});

test('options default to dry-run and validate numeric flags', () => {
  assert.equal(parseOptions([]).delayMs, 800);
  assert.equal(parseOptions(['--owner', 'other']).owner, 'other');
  assert.throws(() => parseOptions(['--apply', '--dry-run']), /either/);
  assert.throws(() => parseOptions(['--limit', '1.5']), /--limit must be an integer/);
  assert.throws(() => parseOptions(['--delay-ms', '-1']), /--delay-ms/);
});

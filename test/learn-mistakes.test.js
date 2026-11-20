// Learn: the mistakes and their analysis ("Mistakes" and "Mistake reports" in docs/design/learn-english.md; services/learn.js, services/learn-analysis.js,
// routes/learn.js): what a wrong answer keeps, the Mistakes list, the tagger's list on both sides, the question for the model (only the expected text,
// the written text, the mode and the tag), the check of its answer, the weekly rule with a fake clock, and the routes with a stubbed model. No test
// calls a real model: every `chat` here is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-mistakes-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn, MISTAKE_TAGS } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const analysisModule = require('../services/learn-analysis');
const { TranslatorError } = require('../services/translator');

const { createLearnAnalysis, buildPrompt, parseReport, kindCounts, weekKey, weeklyDue, weeklyRunner, WEEK } = analysisModule;
const NOW = Date.UTC(2026, 10, 20, 4, 0, 0);
const TZ = 'UTC';
const ZH = '\u5fc5\u8981\u7684';
const ZH_REPORT = '\u4f60\u5e38\u628a\u53cc\u5b57\u6bcd\u5199\u9519\u3002';
const HOUR = 60 * 60 * 1000;

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-mistakes-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

// A model that answers with `reply` (a function of the user message, or a string) and records every question.
function stubModel(reply) {
  const calls = [];
  const chat = async (owner, system, user, options) => {
    calls.push({ owner, system, user, options });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(JSON.parse(user)) : reply;
  };
  return { calls, chat };
}
const goodReply = message => JSON.stringify({
  summary: 'Most slips are double letters.',
  findings: [
    { title: 'Double letters', cause: 'You drop one of a pair.', action: 'Spell these words in a group for three days.', items: message.mistakes.filter(item => item.tag === 'a double letter').map(item => item.id) },
    { title: 'Ghost', cause: 'Nothing.', action: 'Nothing.', items: [999] },
  ],
});

function setup(t, { reply = goodReply, configured = true, company = false } = {}) {
  const db = database(t);
  const clock = { now: NOW };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null });
  learn.saveSettings('me', { starter: null });
  const model = stubModel(reply);
  const state = { configured, company };
  const logs = [];
  const analysis = createLearnAnalysis({
    learn, chat: model.chat, isConfigured: () => state.configured, modelInfo: () => ({ label: 'DeepSeek', model: 'deepseek-flash' }),
    company: () => state.company, owner: () => 'me', now: () => clock.now, log: { warn: message => logs.push(message), info() {} },
  });
  return { db, clock, learn, analysis, model, state, logs };
}

async function serve(t, learn, analysis) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: learn, analysis, sync: null, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  return async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

// Wrong answers to a few cards: `count` of them, an hour apart, ending at the clock's time.
function wrongAnswers(ctx, count, { start = ctx.clock.now - count * HOUR } = {}) {
  const words = ['necessary', 'address', 'occurred', 'expire', 'separate'];
  const cards = words.map(en => ctx.learn.addCard('me', { kind: 'word', en, zh: ZH, source: 'manual' }).card);
  const before = ctx.clock.now;
  for (let index = 0; index < count; index += 1) {
    ctx.clock.now = start + index * HOUR;
    const card = cards[index % cards.length];
    ctx.learn.answer('me', card.id, { mode: 'spell', grade: 'again', correct: false, answer: `${card.en}x`, tag: index % 2 ? 'double-letter' : 'extra-letter', hinted: index % 3 === 0 });
  }
  ctx.clock.now = Math.max(before, ctx.clock.now);
  return cards;
}

test('the tagger has the same list of tags on the page and on the server', async () => {
  const { MISTAKE_TAGS: pageTags } = await import('../scripts/h5-shell/learn-grade.mjs');
  assert.deepEqual(pageTags, MISTAKE_TAGS);
  for (const tag of MISTAKE_TAGS) assert.ok(analysisModule.KIND_OF_TAG[tag], `${tag} belongs to a kind of the report`);
});

test('a wrong answer keeps what was asked for, the first tag and whether help was used; a right one keeps none; the list is newest first', t => {
  const ctx = setup(t);
  const word = ctx.learn.addCard('me', { kind: 'word', en: 'necessary', zh: ZH, source: 'manual' }).card;
  const sentence = ctx.learn.addCard('me', { kind: 'sentence', en: 'He has already left the office.', zh: ZH, source: 'manual' }).card;
  ctx.learn.answer('me', word.id, { mode: 'spell', grade: 'good', correct: true, answer: 'necessary', tag: 'double-letter', expected: 'x' });
  ctx.clock.now += 1000;
  ctx.learn.answer('me', word.id, { mode: 'spell', grade: 'again', correct: false, answer: 'neccesary', tag: 'double-letter', hinted: true });
  ctx.clock.now += 1000;
  ctx.learn.answer('me', sentence.id, { mode: 'fill', grade: 'again', correct: false, answer: 'leave', tag: 'tense', expected: '  left ' });
  ctx.clock.now += 1000;
  ctx.learn.answer('me', sentence.id, { mode: 'build', grade: 'again', correct: false, answer: 'He already left the office.', tag: 'a-new-tag' });
  const rows = ctx.db.prepare('SELECT correct, expected, tag, hinted FROM learn_reviews ORDER BY id').all();
  assert.deepEqual(rows, [
    { correct: 1, expected: null, tag: '', hinted: 0 },
    { correct: 0, expected: 'necessary', tag: 'double-letter', hinted: 1 },
    { correct: 0, expected: 'left', tag: 'tense', hinted: 0 },
    { correct: 0, expected: 'He has already left the office.', tag: '', hinted: 0 },
  ]);
  assert.throws(() => ctx.learn.answer('me', word.id, { mode: 'spell', grade: 'again', correct: false, tag: 5 }), /Invalid answer/);
  const list = ctx.learn.mistakes('me', { limit: 2 });
  assert.equal(list.more, true);
  assert.deepEqual(list.mistakes.map(item => [item.mode, item.tag, item.expected, item.written]), [
    ['build', '', 'He has already left the office.', 'He already left the office.'],
    ['fill', 'tense', 'left', 'leave'],
  ]);
  assert.deepEqual(list.mistakes[0].card, { id: sentence.id, kind: 'sentence', en: 'He has already left the office.' });
  const next = ctx.learn.mistakes('me', { limit: 2, before: list.mistakes[1].at });
  assert.deepEqual(next.mistakes.map(item => [item.written, item.hinted]), [['neccesary', true]]);
  assert.equal(next.more, false);
  // An answer from before schema 17 has no detail: it expects the card's text and has no tag.
  ctx.db.prepare("UPDATE learn_reviews SET expected = NULL, tag = '' WHERE answer = 'neccesary'").run();
  assert.deepEqual(ctx.learn.mistakes('me', { limit: 1, before: list.mistakes[1].at }).mistakes[0].expected, 'necessary');
  assert.throws(() => ctx.learn.mistakes('me', { limit: 0 }), /Invalid list range/);
});

test('the analysis settings: on by default, checked, kept with the other learning settings', t => {
  const ctx = setup(t);
  const settings = ctx.learn.settings('me');
  assert.deepEqual([settings.analysis_auto, settings.report_seen, settings.report_lang], [true, '', 'en']);
  const saved = ctx.learn.saveSettings('me', { analysis_auto: false, report_lang: 'zh', report_seen: 'auto-2026-W47' });
  assert.deepEqual([saved.analysis_auto, saved.report_lang, saved.report_seen], [false, 'zh', 'auto-2026-W47']);
  for (const bad of [{ analysis_auto: 'yes' }, { report_lang: 'fr' }, { report_seen: 'not an id!' }]) assert.throws(() => ctx.learn.saveSettings('me', bad), /Invalid learning settings/, JSON.stringify(bad));
});

test('the question for the model holds only the expected text, the written text, the mode and the tag, within the limits', () => {
  const mistakes = Array.from({ length: 260 }, (_, index) => ({
    uid: `u${index}`, at: '2026-11-19T00:00:00.000Z', mode: index % 2 ? 'spell' : 'dictation', tag: index % 2 ? 'double-letter' : 'listening', hinted: true,
    expected: `expected ${index} ${'x'.repeat(index === 3 ? 400 : 5)}`, written: `written ${index}`, card: { id: index, kind: 'word', en: `word${index}` },
  }));
  const { system, user, items } = buildPrompt({ mistakes, lang: 'en' });
  const sent = JSON.parse(user);
  assert.ok(sent.mistakes.length <= 200, 'at most 200 mistakes');
  assert.equal(items.length, sent.mistakes.length);
  assert.ok(user.length <= analysisModule.MAX_PROMPT + 20, 'within the size cap');
  for (const item of sent.mistakes) assert.deepEqual(Object.keys(item).sort(), ['expected', 'id', 'mode', 'tag', 'written']);
  assert.equal(sent.mistakes[3].expected.length, analysisModule.MAX_TEXT, 'each text is cut');
  assert.equal(sent.mistakes[1].tag, 'a double letter');
  assert.doesNotMatch(user, /u0|2026-11-19|word1"|"hinted"|"card"/, 'no id, time, card or help flag goes out');
  assert.match(system, /never instructions/);
  assert.match(system, /in English/);
  assert.match(buildPrompt({ mistakes: mistakes.slice(0, 2), lang: 'zh' }).system, /in Simplified Chinese/);
  // The size cap: long texts make fewer items fit.
  const long = mistakes.map(item => ({ ...item, expected: 'y'.repeat(300), written: 'z'.repeat(300) }));
  const capped = buildPrompt({ mistakes: long });
  assert.ok(capped.user.length <= analysisModule.MAX_PROMPT + 20);
  assert.ok(capped.items.length < 200);
});

test("the model's answer is checked: a report from good JSON (fenced too), the ids mapped to cards; anything else is an error", () => {
  const items = [1, 2, 3].map(id => ({ id, source: { card: { kind: 'word', en: ['necessary', 'address', 'necessary'][id - 1] } } }));
  const kinds = [{ kind: 'spelling', count: 3 }];
  const body = parseReport(`\`\`\`json\n${JSON.stringify({ summary: ZH_REPORT, findings: [{ title: 'Double letters', cause: 'c', action: 'a', items: [1, 2, 3, 77, 'x'] }] })}\n\`\`\``, items, kinds);
  assert.equal(body.summary, ZH_REPORT);
  assert.deepEqual(body.kinds, kinds);
  assert.deepEqual(body.findings, [{ title: 'Double letters', cause: 'c', action: 'a', cards: [{ kind: 'word', en: 'necessary' }, { kind: 'word', en: 'address' }] }]);
  // Only a summary is a report too (few mistakes); extra findings and long texts are cut.
  assert.deepEqual(parseReport('{"summary":"Fine."}', items, kinds).findings, []);
  const many = parseReport(JSON.stringify({ summary: 's'.repeat(2000), findings: Array.from({ length: 9 }, (_, index) => ({ title: `t${index}`, cause: 'c', action: 'a', items: [1] })) }), items, kinds);
  assert.equal(many.findings.length, 4);
  assert.equal(many.summary.length, 600);
  for (const bad of ['', 'Sorry, I cannot help.', '{"summary": ""}', '{"summary": 5}', '[1,2]', '{"summary":"x","findings":"none"}', '{"summary":"x","findings":[{"cause":"no title"}]}', '{"summary": "x",']) {
    assert.throws(() => parseReport(bad, items, kinds), error => error.statusCode === 502 && /could not be read/.test(error.message), JSON.stringify(bad));
  }
  assert.deepEqual(kindCounts([{ tag: 'double-letter' }, { tag: 'letter-order' }, { tag: 'tense' }, { tag: '' }, { tag: 'tense' }, { tag: 'spelling' }]),
    [{ kind: 'spelling', count: 3 }, { kind: 'tense', count: 2 }, { kind: 'other', count: 1 }]);
});

test('the weekly rule: the switch, once in 7 days, at least 10 new mistakes; the smallest engine id makes it; weeks in UTC', () => {
  assert.deepEqual(weeklyDue({ now: NOW, auto: false, newMistakes: 50 }), { due: false, reason: 'off' });
  assert.deepEqual(weeklyDue({ now: NOW, auto: true, lastAutoAt: NOW - WEEK + 1, newMistakes: 50 }), { due: false, reason: 'too-soon' });
  assert.deepEqual(weeklyDue({ now: NOW, auto: true, lastAutoAt: NOW - WEEK, newMistakes: 9 }), { due: false, reason: 'few' });
  assert.deepEqual(weeklyDue({ now: NOW, auto: true, lastAutoAt: NOW - WEEK, newMistakes: 10 }), { due: true, reason: 'due' });
  assert.deepEqual(weeklyDue({ now: NOW, auto: true, newMistakes: 10 }), { due: true, reason: 'due' });
  assert.equal(weeklyRunner('b', [{ instance_id: 'c' }, { instance_id: null }]), true);
  assert.equal(weeklyRunner('b', [{ instance_id: 'a' }]), false);
  assert.equal(weekKey(NOW), '2026-W47');
  assert.equal(weekKey(Date.UTC(2026, 10, 22, 23, 59)), '2026-W47', 'Sunday is the end of the ISO week');
  assert.equal(weekKey(Date.UTC(2026, 10, 23, 0, 0)), '2026-W48');
  assert.equal(weekKey(Date.UTC(2027, 0, 1)), '2026-W53');
});

test('the weekly report runs by itself with a fake clock: only with 10 new mistakes, once a week, never with the switch off or on a company computer', async t => {
  const ctx = setup(t);
  wrongAnswers(ctx, 9);
  assert.equal(await ctx.analysis.checkWeekly(), 'few');
  ctx.clock.now += HOUR;
  wrongAnswers(ctx, 1, { start: ctx.clock.now });
  ctx.state.company = true;
  assert.equal(await ctx.analysis.checkWeekly(), 'company', 'a company computer never runs it');
  ctx.state.company = false;
  ctx.learn.saveSettings('me', { analysis_auto: false });
  assert.equal(await ctx.analysis.checkWeekly(), 'off');
  ctx.learn.saveSettings('me', { analysis_auto: true, report_lang: 'zh' });
  ctx.state.configured = false;
  assert.equal(await ctx.analysis.checkWeekly(), 'no-model');
  ctx.state.configured = true;
  assert.equal(ctx.model.calls.length, 0);
  assert.equal(await ctx.analysis.checkWeekly(), 'done');
  assert.equal(ctx.model.calls.length, 1);
  assert.match(ctx.model.calls[0].system, /Simplified Chinese/, 'in the language the page last used');
  assert.deepEqual(ctx.model.calls[0].options, { json: true, timeoutMs: 90000, temperature: 0.2 });
  const report = ctx.learn.lastReport('me');
  assert.equal(report.uid, `auto-${weekKey(ctx.clock.now)}`);
  assert.deepEqual([report.auto, report.mistakes, report.answers, report.lang, report.covers_from], [1, 10, 10, 'zh', 0]);
  assert.deepEqual(ctx.learn.summary('me').new_report, { uid: report.uid, created_at: new Date(report.created_at).toISOString(), mistakes: 10 });
  ctx.learn.saveSettings('me', { report_seen: report.uid });
  assert.equal(ctx.learn.summary('me').new_report, null, 'opened once, it is not offered again');
  // Ten more mistakes three days later: not again within the week.
  ctx.clock.now += 3 * 24 * HOUR;
  wrongAnswers(ctx, 12, { start: ctx.clock.now });
  assert.equal(await ctx.analysis.checkWeekly(), 'too-soon');
  // A week after the last one: the new mistakes only (the report covers until its time).
  ctx.clock.now = report.created_at + WEEK;
  assert.equal(await ctx.analysis.checkWeekly(), 'done');
  const second = ctx.learn.lastReport('me');
  assert.equal(second.mistakes, 12);
  assert.equal(second.covers_from, report.covers_until);
  assert.equal(JSON.parse(ctx.model.calls[1].user).mistakes.length, 12);
  // A failing model is logged once, without the mistakes, and nothing is stored.
  ctx.clock.now += WEEK;
  wrongAnswers(ctx, 10, { start: ctx.clock.now - 20 * HOUR });
  const failing = createLearnAnalysis({ learn: ctx.learn, chat: async () => { throw new TranslatorError('DeepSeek rate limit reached; please retry later', 502); }, isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now, company: () => false, log: { warn: message => ctx.logs.push(message) } });
  assert.equal(await failing.checkWeekly(), 'failed');
  assert.equal(await failing.checkWeekly(), 'failed');
  assert.deepEqual(ctx.logs, ['[learn-analysis] the weekly report failed: DeepSeek rate limit reached; please retry later']);
  assert.equal(ctx.learn.reports('me').reports.length, 2);
});

test('another engine with a smaller id makes the weekly report; this one waits', async t => {
  const ctx = setup(t);
  wrongAnswers(ctx, 12);
  let rounds = 0;
  const sync = { me: () => 'bbb', reportPeers: () => [{ instance_id: 'aaa' }], syncAll: async () => { rounds += 1; }, company: () => false };
  const other = createLearnAnalysis({ learn: ctx.learn, chat: ctx.model.chat, isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now, sync });
  assert.equal(await other.checkWeekly(), 'other-engine');
  const lower = createLearnAnalysis({ learn: ctx.learn, chat: ctx.model.chat, isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now, sync: { ...sync, me: () => 'aa' } });
  assert.equal(await lower.checkWeekly(), 'done');
  assert.equal(rounds, 1, 'a sync round first, so a report made elsewhere is seen');
});

test('the routes: Analyze with a stubbed model stores a report the page can read; no model, a run going on and a bad answer are clear errors', async t => {
  const ctx = setup(t);
  const call = await serve(t, ctx.learn, ctx.analysis);
  let view = (await call('GET', '/reports')).body;
  assert.deepEqual(view, { reports: [], since: { from: null, mistakes: 0, answers: 0 }, model: { ready: true, label: 'DeepSeek', name: 'deepseek-flash' }, running: false, auto: true });
  assert.equal((await call('POST', '/reports', { lang: 'en' })).status, 400, 'nothing to analyse');
  const cards = wrongAnswers(ctx, 6);
  const right = ctx.learn.addCard('me', { kind: 'word', en: 'deploy', zh: ZH, source: 'manual' }).card;
  ctx.learn.answer('me', right.id, { mode: 'spell', grade: 'good', correct: true, answer: 'deploy' });
  const list = (await call('GET', '/mistakes?limit=50')).body;
  assert.equal(list.mistakes.length, 6);
  assert.equal(list.mistakes[0].written, 'necessaryx');
  view = (await call('GET', '/reports')).body;
  assert.deepEqual(view.since, { from: null, mistakes: 6, answers: 7 });

  const made = await call('POST', '/reports', { lang: 'en' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const { report } = made.body;
  assert.deepEqual([report.auto, report.mistakes, report.answers, report.lang, report.summary, report.model], [false, 6, 7, 'en', 'Most slips are double letters.', 'DeepSeek deepseek-flash']);
  assert.deepEqual(report.kinds, [{ kind: 'spelling', count: 6 }]);
  assert.equal(report.findings.length, 2);
  // The double-letter mistakes (every second one), newest first, each card once.
  assert.deepEqual(report.findings[0].cards, ['necessary', 'expire', 'address'].map(en => ({ kind: 'word', en })));
  assert.deepEqual(report.findings[1].cards, [], 'an id the question did not have brings no card');
  const question = JSON.parse(ctx.model.calls[0].user);
  assert.equal(question.mistakes.length, 6);
  assert.doesNotMatch(ctx.model.calls[0].user, new RegExp(ZH), 'no meaning goes out');
  assert.equal((await call('GET', `/reports/${report.uid}`)).body.report.summary, report.summary);
  assert.equal((await call('GET', '/reports/nope-nope-nope')).status, 404);
  view = (await call('GET', '/reports')).body;
  assert.equal(view.reports.length, 1);
  assert.deepEqual(view.since, { from: report.covers_until, mistakes: 0, answers: 0 });
  assert.equal(ctx.learn.summary('me').new_report, null, 'a report asked for by hand is not announced');
  // The cards behind the findings, by kind and text (the ids are this engine's).
  const found = (await call('POST', '/cards/find', { refs: [...report.findings[0].cards, { kind: 'word', en: 'unknown' }, { kind: 'phrase', en: 'x' }] })).body.cards;
  assert.deepEqual(found.map(card => card.id).sort(), report.findings[0].cards.map(ref => cards.find(card => card.en === ref.en).id).sort());
  assert.equal((await call('POST', '/cards/find', { refs: 'x' })).status, 400);

  // A bad answer: an error, nothing stored, and the next run may go.
  wrongAnswers(ctx, 2, { start: ctx.clock.now + HOUR });
  ctx.clock.now += 3 * HOUR;
  const broken = createLearnAnalysis({ learn: ctx.learn, chat: async () => 'I think you should practise more.', isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now });
  const callBroken = await serve(t, ctx.learn, broken);
  const bad = await callBroken('POST', '/reports', {});
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /could not be read/);
  assert.equal(ctx.learn.reports('me').reports.length, 1);
  // One run at a time.
  let release;
  const slow = createLearnAnalysis({ learn: ctx.learn, chat: () => new Promise(resolve => { release = () => resolve(goodReply({ mistakes: [] })); }), isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now });
  const callSlow = await serve(t, ctx.learn, slow);
  const first = callSlow('POST', '/reports', {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await callSlow('GET', '/reports')).body.running, true);
  const second = await callSlow('POST', '/reports', {});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'An analysis is already running');
  release();
  assert.equal((await first).status, 200);
  // No model: 503 with what to do; the list still works.
  ctx.state.configured = false;
  const none = await call('POST', '/reports', {});
  assert.equal(none.status, 503);
  assert.match(none.body.error, /needs a translation model/);
  assert.equal((await call('GET', '/reports')).body.model.ready, false);
  assert.equal((await call('GET', '/mistakes')).status, 200);
  // The translator answering "not configured" is the same message.
  ctx.state.configured = true;
  wrongAnswers(ctx, 1, { start: ctx.clock.now + HOUR });
  ctx.clock.now += 2 * HOUR;
  const off = createLearnAnalysis({ learn: ctx.learn, chat: async () => { throw new TranslatorError('Translation service not configured yet', 409); }, isConfigured: () => true, owner: () => 'me', now: () => ctx.clock.now });
  const callOff = await serve(t, ctx.learn, off);
  assert.equal((await callOff('POST', '/reports', {})).status, 503);
  // A company computer never analyses by itself.
  ctx.state.company = true;
  const refused = await call('POST', '/reports', {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /made on a normal computer/);
});

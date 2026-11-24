// Learn: the English coach (docs/design/learn-english-coach.md; services/learn-coach.js, services/translator.js converseTools, routes/learn.js): the
// tool loop with a stubbed provider that issues tool calls (rounds, the time of the tool phase, the caps on results, economy, errors), the no-tools
// fallback, streaming with status / proposals / remembered lines, proposals run, cancelled and undone, one answer at a time, the rate limit, the
// cache-friendly prompt (the same prefix from one request to the next), usage, the practice result, the routes. No real model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-coach-data-'));
delete process.env.TAGENT_HOME;
const express = require('express');
const Database = require('better-sqlite3');
const { createLearn } = require('../services/learn');
const { createLearnRouter } = require('../routes/learn');
const { createTranslator, ToolsUnsupportedError } = require('../services/translator');
const coachModule = require('../services/learn-coach');
const { createLearnCoach, MAX_ROUNDS, ECONOMY_ROUNDS, MAX_RESULT, ENOUGH, BUSY } = coachModule;

const NOW = Date.UTC(2026, 10, 24, 4, 0, 0);
const TZ = 'UTC';
const ZH = '\u4e16\u754c';

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-coach-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
const meta = (value = {}) => `\n<<meta>>${JSON.stringify({ cards: [], mistakes: [], journal: false, suggestions: [], ...value })}`;
const call = (name, args, id = `call_${name}`) => ({ id, name, arguments: JSON.stringify(args) });

// A provider: `script(request, index)` gives { content, toolCalls, usage } for each converseTools call; the requests are recorded.
function stubProvider(script) {
  const requests = [];
  const converseTools = async (owner, system, messages, options) => {
    const request = { owner, system, messages: JSON.parse(JSON.stringify(messages)), options };
    requests.push(request);
    const step = await script(request, requests.length - 1);
    if (step instanceof Error) throw step;
    const content = [].concat(step.content || []);
    for (const piece of content) if (options.onDelta) options.onDelta(piece);
    return { content: content.join(''), toolCalls: step.toolCalls || [], usage: step.usage || null };
  };
  return { requests, converseTools };
}

function setup(t, { script = () => ({ content: ['Hello', ' there.', meta()] }), converse = null, attention = null, runQuery = null, now = NOW, configured = true, rateLimit = 1000 } = {}) {
  const db = database(t);
  const clock = { now };
  const learn = createLearn({ db, now: () => clock.now, timeZone: TZ, lookupWord: null, lookupPhonetic: () => '' });
  learn.saveSettings('me', { starter: null });
  const provider = stubProvider(script);
  const plain = { calls: [] };
  const state = { configured };
  const coach = createLearnCoach({
    db, learn, timeZone: TZ, now: () => clock.now, attention, rateLimit,
    converseTools: provider.converseTools,
    converse: converse || (async (owner, system, messages, options) => { plain.calls.push({ system, messages, options }); const text = `Plain answer.${meta()}`; if (options.onDelta) options.onDelta(text); return text; }),
    isConfigured: () => state.configured, activeModel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    ...(runQuery ? { runQuery } : {}),
  });
  return { db, clock, learn, coach, provider, plain, state };
}
const stored = db => db.prepare("SELECT * FROM learn_convo_messages WHERE owner = 'me' AND convo_uid = 'coach' ORDER BY at, uid").all();
const collect = () => { const deltas = []; const events = []; return { deltas, events, onDelta: piece => deltas.push(piece), onEvent: line => events.push(line) }; };

test('the loop: tool calls run on the server, their results go back, status lines while it looks, the answer streams; usage; the coach row', async t => {
  const queries = [];
  const ctx = setup(t, {
    runQuery: async (snapshot, query) => { queries.push({ snapshot, query }); return { columns: ['n'], rows: [[12]], truncated: false }; },
    script: (request, index) => {
      if (index === 0) return { content: ['Let me look.'], toolCalls: [call('learn_schema', {})], usage: { prompt_tokens: 100, completion_tokens: 5 } };
      if (index === 1) return { toolCalls: [call('learn_sql', { query: 'SELECT count(*) AS n FROM coach_cards' })], usage: { prompt_tokens: 150, completion_tokens: 7 } };
      return { content: ['You have ', '**12** cards.', meta({ suggestions: ['Practise now'] })], usage: { prompt_tokens: 200, completion_tokens: 9 } };
    },
  });
  const seen = collect();
  const result = await ctx.coach.send('me', { text: 'How many cards do I have?' }, seen);
  assert.deepEqual(seen.events.filter(line => line.type === 'status').map(line => line.text), ['Looking at your answers', 'Looking at your answers']);
  assert.equal(seen.deltas.join(''), 'Let me look.\n\nYou have **12** cards.');
  assert.equal(result.message.text, 'Let me look.\n\nYou have **12** cards.');
  assert.equal(result.tools, true);
  assert.deepEqual(result.usage, { calls: 3, tool_rounds: 2, prompt_tokens: 450, completion_tokens: 21 });
  assert.deepEqual(result.message.meta.usage, result.usage);
  assert.deepEqual(result.message.meta.suggestions, ['Practise now']);
  // The second request carries the first round's call and its result; the third the SQL result.
  const [, second, third] = ctx.provider.requests;
  const toolMessage = second.messages[second.messages.length - 1];
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_learn_schema');
  assert.match(toolMessage.content, /coach_cards: one row per card/);
  assert.deepEqual(JSON.parse(third.messages[third.messages.length - 1].content), { columns: ['n'], rows: [[12]], truncated: false });
  assert.equal(queries.length, 1);
  assert.ok(Buffer.isBuffer(queries[0].snapshot) || queries[0].snapshot instanceof Uint8Array, 'the query runs over a snapshot');
  assert.equal(second.options.toolChoice, 'auto');
  // Stored: the question and the answer in the coach conversation; the row exists once.
  assert.deepEqual(stored(ctx.db).map(row => row.role), ['user', 'assistant']);
  assert.deepEqual(ctx.db.prepare("SELECT uid, deleted, journal FROM learn_convos WHERE owner = 'me'").all().map(row => ({ ...row })), [{ uid: 'coach', deleted: 0, journal: 0 }]);
  assert.deepEqual(ctx.learn.summary('me').chats, 0, 'the coach is not one of the chats');
});

test('limits: at most 6 tool rounds (3 in economy), then the answer without tools; the tool phase ends after 30 s; bad arguments are an error result', async t => {
  const loop = setup(t, { script: request => (request.options.toolChoice === 'none' ? { content: [`Done.${meta()}`] } : { toolCalls: [call('learn_schema', {})] }) });
  const result = await loop.coach.send('me', { text: 'Look forever' });
  assert.equal(result.usage.tool_rounds, MAX_ROUNDS);
  assert.equal(loop.provider.requests.length, MAX_ROUNDS + 1);
  assert.equal(loop.provider.requests[MAX_ROUNDS].options.toolChoice, 'none');
  assert.equal(result.message.text, 'Done.');

  const economy = setup(t, { script: request => (request.options.toolChoice === 'none' ? { content: [`Done.${meta()}`] } : { toolCalls: [call('learn_schema', {})] }) });
  economy.learn.saveSettings('me', { coach_economy: true });
  assert.equal((await economy.coach.send('me', { text: 'Look' })).usage.tool_rounds, ECONOMY_ROUNDS);

  // The clock passes 30 s during the first round: the next call may not use tools, and a late tool call gets the limit as its result.
  const slow = setup(t, {
    script: (request, index) => {
      if (index === 0) { slow.clock.now += 31_000; return { toolCalls: [call('learn_schema', {})] }; }
      if (index === 1) return { toolCalls: [call('learn_schema', {}, 'call_late')] };
      return { content: [`Late.${meta()}`] };
    },
  });
  await slow.coach.send('me', { text: 'Slow' });
  assert.equal(slow.provider.requests[1].options.toolChoice, 'none');
  assert.match(slow.provider.requests[2].messages.at(-1).content, /tool limit was reached/);

  const bad = setup(t, { script: (request, index) => (index === 0 ? { toolCalls: [{ id: 'call_bad', name: 'learn_sql', arguments: '{nope' }, { id: 'call_x', name: 'drop_tables', arguments: '{}' }] } : { content: [`Ok.${meta()}`] }) });
  await bad.coach.send('me', { text: 'Bad' });
  const results = bad.provider.requests[1].messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content).error);
  assert.deepEqual(results, ['The arguments are not a JSON object', 'Unknown tool drop_tables']);
});

test('the results: each cut at 12,000 characters, at most 30,000 in all (12,000 in economy), then "enough data was read"', async t => {
  const big = { columns: ['text'], rows: [['x'.repeat(20_000)]], truncated: false };
  const script = (request, index) => (index < 4 ? { toolCalls: [call('learn_sql', { query: 'SELECT text FROM coach_messages' }, `call_${index}`)] } : { content: [`Ok.${meta()}`] });
  const ctx = setup(t, { runQuery: async () => big, script });
  await ctx.coach.send('me', { text: 'Read a lot' });
  const tools = ctx.provider.requests[4].messages.filter(item => item.role === 'tool').map(item => item.content);
  assert.equal(tools.length, 4);
  assert.ok(tools.every(text => text.length <= MAX_RESULT));
  assert.match(tools[0], /\[cut: the result was too long\]$/);
  assert.equal(tools.slice(0, 3).reduce((sum, text) => sum + text.length, 0) <= 30_000, true);
  assert.equal(JSON.parse(tools[3]).error, ENOUGH);

  const economy = setup(t, { runQuery: async () => big, script });
  economy.learn.saveSettings('me', { coach_economy: true });
  await economy.coach.send('me', { text: 'Read a lot' });
  const last = economy.provider.requests.at(-1).messages.filter(item => item.role === 'tool').map(item => item.content);
  assert.equal(JSON.parse(last[1]).error, ENOUGH, 'economy: the second result is refused');
});

test('a provider that refuses tools: the answer from the short summary, tools false, a notice, remembered for the next sends', async t => {
  const ctx = setup(t, { script: () => new ToolsUnsupportedError('DeepSeek cannot use tools with this model (HTTP 400)') });
  ctx.learn.addCard('me', { kind: 'word', en: 'separate', zh: ZH });
  const seen = collect();
  const result = await ctx.coach.send('me', { text: 'How am I doing?' }, seen);
  assert.equal(result.tools, false);
  assert.equal(result.message.text, 'Plain answer.');
  assert.match(result.message.meta.notice, /cannot look up your data/);
  assert.equal(result.message.meta.tools, false);
  assert.match(ctx.plain.calls[0].messages.at(-1).content, /Learning now: .* due, .*Words often wrong: none yet\.\n\nHow am I doing\?$/);
  assert.match(ctx.plain.calls[0].system, /cannot look up the data/);
  assert.equal(ctx.coach.view('me').tools_ok, false);
  await ctx.coach.send('me', { text: 'Again' });
  assert.equal(ctx.provider.requests.length, 1, 'tools are not tried again for this provider and model');
  assert.equal(ctx.plain.calls.length, 2);
});

test('errors and order: the checks before the model, nothing stored on a failure, one answer at a time, the rate limit', async t => {
  const failing = setup(t, { script: () => Object.assign(new Error('DeepSeek returned an error (HTTP 500)'), { statusCode: 502 }) });
  await assert.rejects(failing.coach.send('me', { text: 'Hi' }), { statusCode: 502, message: 'DeepSeek returned an error (HTTP 500)' });
  assert.equal(stored(failing.db).length, 0);
  await assert.rejects(failing.coach.send('me', { text: '' }), { statusCode: 400, message: 'Enter your question' });
  await assert.rejects(failing.coach.send('me', { text: 'x'.repeat(4001) }), { statusCode: 400 });
  failing.state.configured = false;
  await assert.rejects(failing.coach.send('me', { text: 'Hi' }), { statusCode: 503, message: 'Translation service not configured yet' });

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const busy = setup(t, { script: async () => { await gate; return { content: [`Ok.${meta()}`] }; } });
  const first = busy.coach.send('me', { text: 'One' });
  await assert.rejects(busy.coach.send('me', { text: 'Two' }), { statusCode: 409, message: BUSY });
  await assert.rejects(busy.coach.practiceResult('me', { total: 3, done: 3, right: 3 }), { statusCode: 409 });
  release();
  await first;
  assert.equal(busy.coach.running('me'), false);

  const limited = setup(t, { rateLimit: 2 });
  await limited.coach.send('me', { text: 'a' });
  await limited.coach.send('me', { text: 'b' });
  await assert.rejects(limited.coach.send('me', { text: 'c' }), { statusCode: 429 });
});

test('the prompt is cache friendly: two requests in a row share the system message and the older messages byte for byte', async t => {
  const ctx = setup(t, { script: () => ({ content: [`Answer.${meta()}`] }) });
  const notes = ['Goal: spoken English for work meetings', 'Prefers short answers'];
  notes.forEach((text, index) => ctx.db.prepare("INSERT INTO learn_coach_notes (owner, uid, text, created_at, updated_at) VALUES ('me', ?, ?, ?, ?)").run(`note-000${index}`, text, NOW - 1000 + index, NOW));
  await ctx.coach.send('me', { text: 'First question' });
  ctx.clock.now += 60_000;
  await ctx.coach.send('me', { text: 'Second question' });
  const [one, two] = ctx.provider.requests;
  assert.equal(one.system, two.system, 'the same system message (rules, notes, summary)');
  assert.doesNotMatch(one.system, /2026-11-24|\d{2}:\d{2}/, 'no date or time in the stable part');
  assert.match(one.system, /- Goal: spoken English for work meetings\n- Prefers short answers/);
  // The first request's history (none) + its question; the second request starts with the same older messages, then the new one with today's line.
  assert.equal(one.messages.length, 1);
  assert.deepEqual(two.messages.slice(0, 2), [{ role: 'user', content: 'First question' }, { role: 'assistant', content: 'Answer.' }]);
  assert.match(two.messages[2].content, /^Today is 2026-11-24\. .*\n\nSecond question$/);
  assert.deepEqual(one.options.tools, two.options.tools, 'the same tools');
});

test('proposals: settings, cards (a removal on its own card), a reminder; run, cancel, run twice, Undo within 10 s and not after', async t => {
  const created = [];
  const removed = [];
  const attention = { create: (body, options) => { created.push({ body, options }); return { id: 77 }; }, remove: id => { removed.push(id); return true; } };
  let deploy;
  const ctx = setup(t, {
    attention,
    script: (request, index) => (index === 0 ? {
      toolCalls: [
        call('propose_settings', { changes: { new_per_day: 15, coach_read_text: false, bogus: 1 } }, 'c1'),
        call('propose_cards', { add: [{ kind: 'word', en: 'reconcile', zh: ZH }, { kind: 'word', en: 'not a word!' }], remove: [deploy.id] }, 'c2'),
        call('propose_reminder', { time: '20:00', days: [], text: "Today's English practice" }, 'c3'),
      ],
    } : { content: [`Three things.${meta()}`] }),
  });
  deploy = ctx.learn.addCard('me', { kind: 'word', en: 'deploy', zh: ZH }).card;
  const seen = collect();
  const result = await ctx.coach.send('me', { text: 'Make it 15 new words, add reconcile, remind me at 8 pm' }, seen);
  const proposals = result.message.meta.proposals;
  assert.deepEqual(proposals.map(item => item.kind), ['settings', 'cards', 'cards', 'reminder']);
  assert.deepEqual(proposals[0].changes, { new_per_day: 15 }, 'only allowed keys; the coach switches are never proposed');
  assert.deepEqual(proposals[0].before, { new_per_day: 10 });
  assert.deepEqual([proposals[1].add.map(card => card.en), proposals[1].remove], [['reconcile'], []]);
  assert.deepEqual([proposals[2].add, proposals[2].remove], [[], [{ kind: 'word', en: 'deploy' }]]);
  assert.ok(proposals.every(item => item.state === 'open'));
  const proposalLine = seen.events.find(line => line.type === 'proposals');
  assert.deepEqual(proposalLine.proposals, proposals);
  assert.ok(seen.events.indexOf(proposalLine) > seen.events.findIndex(line => line.type === 'status'));
  assert.equal(ctx.learn.settings('me').new_per_day, 10, 'nothing changed before the tap');
  const uid = result.message.uid;

  const ran = await ctx.coach.runProposal('me', proposals[0].id, { message_uid: uid });
  assert.equal(ctx.learn.settings('me').new_per_day, 15);
  assert.equal(ran.proposal.state, 'done');
  assert.match(ran.undo.expires_at, /T/);
  await assert.rejects(ctx.coach.runProposal('me', proposals[0].id, { message_uid: uid }), { statusCode: 409 });
  await ctx.coach.undo('me', { token: ran.undo.token });
  assert.equal(ctx.learn.settings('me').new_per_day, 10, 'undone');
  assert.equal(ctx.coach.view('me').messages[1].meta.proposals[0].state, 'undone');

  const cards = await ctx.coach.runProposal('me', proposals[1].id, { message_uid: uid });
  assert.equal(cards.result.added.length, 1);
  assert.ok(ctx.db.prepare("SELECT 1 FROM learn_cards WHERE norm = 'reconcile' AND suspended = 0").get());
  const removal = await ctx.coach.runProposal('me', proposals[2].id, { message_uid: uid });
  assert.deepEqual(removal.result.removed, [deploy.id]);
  assert.equal(ctx.db.prepare('SELECT suspended FROM learn_cards WHERE id = ?').pluck().get(deploy.id), 1);
  ctx.clock.now += 10_001;
  await assert.rejects(ctx.coach.undo('me', { token: removal.undo.token }), { statusCode: 410 });

  const reminder = await ctx.coach.runProposal('me', proposals[3].id, { message_uid: uid });
  assert.equal(reminder.result.task_id, 77);
  assert.deepEqual(created[0].body.schedule, { kind: 'repeat', rule: { freq: 'daily', time: '20:00' }, tz: 'UTC' });
  assert.equal(created[0].body.link_url, '/h5?learn=coach');
  await ctx.coach.undo('me', { token: reminder.undo.token });
  assert.deepEqual(removed, [77]);

  const other = await ctx.coach.send('me', { text: 'again' });
  assert.equal(other.message.meta.proposals.length, 0);
  await assert.rejects(ctx.coach.runProposal('me', 'nope-nope-1', { message_uid: uid }), { statusCode: 404 });
});

test('open_screen: a button under the answer for an allowed screen (each once, at most 3); a bad screen is an error; the prompt asks for it; a no-tools answer names screens in its last line', async t => {
  const ctx = setup(t, {
    script: (request, index) => (index === 0 ? {
      toolCalls: [
        call('open_screen', { screen: 'mistakes' }, 'o1'), call('open_screen', { screen: 'mistakes' }, 'o2'), call('open_screen', { screen: 'admin' }, 'o3'),
        call('open_screen', { screen: 'progress' }, 'o4'), call('open_screen', { screen: 'settings' }, 'o5'), call('open_screen', { screen: 'how' }, 'o6'),
      ],
    } : { content: [`Here they are.${meta({ suggestions: ['Show my progress'] })}`] }),
  });
  const result = await ctx.coach.send('me', { text: 'Show my mistakes' });
  assert.deepEqual(result.message.meta.screens, ['mistakes', 'progress', 'settings']);
  const results = ctx.provider.requests[1].messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true, 'the same screen twice is one button');
  assert.match(results[2].error, /^screen must be one of mistakes, reports, progress/);
  assert.match(results[5].error, /At most 3 screen buttons/);
  assert.deepEqual(coachModule.TOOLS.find(tool => tool.name === 'open_screen').parameters.properties.screen.enum, ['mistakes', 'reports', 'progress', 'material', 'settings', 'how', 'review', 'practice', 'spell', 'dictation', 'fill', 'say']);
  assert.match(ctx.provider.requests[0].system, /call open_screen/);
  assert.match(ctx.provider.requests[0].system, /Show my progress/);
  assert.deepEqual(ctx.coach.view('me').messages[1].meta.screens, ['mistakes', 'progress', 'settings'], 'stored with the answer');
  const other = await ctx.coach.send('me', { text: 'Thanks' });
  assert.deepEqual(other.message.meta.screens, []);

  const plain = setup(t, {
    script: () => new ToolsUnsupportedError('no tools'),
    converse: async (owner, system, messages, options) => { const text = `See them.${meta({ screens: ['mistakes', 'nope', 'how'] })}`; if (options.onDelta) options.onDelta(text); return text; },
  });
  const named = await plain.coach.send('me', { text: 'Show my mistakes' });
  assert.deepEqual(named.message.meta.screens, ['mistakes', 'how']);
});

test('remember: a note at once with a remembered line and Undo; secrets, 40 notes and the memory switch are refused to the model', async t => {
  const ctx = setup(t, {
    script: (request, index) => (index === 0 ? { toolCalls: [call('remember', { text: 'Job interview in March, in English', until: '2027-03-31' }, 'r1'), call('remember', { text: 'My password is hunter2' }, 'r2')] } : { content: [`Good to know.${meta()}`] }),
  });
  const seen = collect();
  const result = await ctx.coach.send('me', { text: 'I have a job interview in March.' }, seen);
  const line = seen.events.find(item => item.type === 'remembered');
  assert.deepEqual([line.note.text, line.note.until], ['Job interview in March, in English', '2027-03-31']);
  assert.ok(line.note.undo.token);
  assert.deepEqual(result.message.meta.remembered.map(note => note.text), ['Job interview in March, in English']);
  const results = ctx.provider.requests[1].messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
  assert.ok(results[0].note_id);
  assert.match(results[1].error, /passwords/);
  assert.equal(ctx.coach.notes('me').notes.length, 1);
  await ctx.coach.undo('me', { token: line.note.undo.token });
  assert.equal(ctx.coach.notes('me').notes.length, 0);

  ctx.learn.saveSettings('me', { coach_memory: false });
  ctx.provider.requests.length = 0;
  await ctx.coach.send('me', { text: 'Remember this' });
  assert.match(ctx.provider.requests[0].system, /switched memory off/);
});

test('the practice result: stored first as a practice message (one short line), then her answer; a plan started from its card', async t => {
  const ctx = setup(t, {
    script: (request, index) => {
      if (request.messages.at(-1).content.includes('Practice result')) return { content: [`Nice work: 2 of 3 right.${meta({ suggestions: ['Practise the 1 I missed'] })}`] };
      return index === 0 ? { toolCalls: [call('propose_practice', { kind: 'today_spelling' }, 'p1')] } : { content: [`Start when ready.${meta()}`] };
    },
  });
  for (const en of ['separate', 'definitely', 'occurred']) ctx.learn.addCard('me', { kind: 'word', en, zh: ZH });
  const asked = await ctx.coach.send('me', { text: "Give me today's spelling practice" });
  const [plan] = asked.message.meta.proposals;
  assert.deepEqual([plan.kind, plan.plan.kind, plan.plan.words, plan.plan.steps[0].mode], ['practice', 'today_spelling', 3, 'spell']);
  const toolResult = JSON.parse(ctx.provider.requests[1].messages.at(-1).content);
  assert.deepEqual([toolResult.words, toolResult.title], [3, "Today's spelling"], 'the numbers are the server\'s');
  await assert.rejects(ctx.coach.runProposal('me', plan.id, { message_uid: asked.message.uid }), { statusCode: 400 });

  const started = await ctx.coach.startPlan('me', { message_uid: asked.message.uid, proposal_id: plan.id });
  assert.equal(started.stale, false);
  assert.deepEqual(started.plan.steps.map(step => [step.mode, step.cards.length]), [['spell', 3]]);
  assert.deepEqual(Object.keys(started.plan.steps[0].cards[0]).filter(key => ['next', 'is_new', 'missed', 'leech', 'parts', 'tip'].includes(key)), ['next', 'is_new', 'missed', 'leech', 'parts', 'tip'], 'cards as GET /queue gives them');
  assert.equal(ctx.coach.view('me').messages[1].meta.proposals[0].state, 'done');

  const seen = collect();
  const replied = await ctx.coach.practiceResult('me', {
    plan_id: started.plan.id, message_uid: asked.message.uid, proposal_id: plan.id, steps: [{ mode: 'spell', done: 3, right: 2 }], done: 3, total: 3, right: 2,
    missed: [{ en: 'separate', typed: 'seperate' }], seconds: 480,
  }, seen);
  assert.deepEqual(replied.messages.map(item => item.role), ['practice', 'assistant']);
  assert.equal(replied.messages[0].text, `Today's spelling finished: 3 words, 2 of 3 right, 8 min. Missed: separate (typed "seperate").`);
  assert.equal(replied.messages[0].meta.practice.right, 2);
  assert.deepEqual(replied.message.meta.suggestions, ['Practise the 1 I missed']);
  const last = ctx.provider.requests.at(-1).messages.at(-1).content;
  assert.match(last, /\[Practice result, sent by the app, not typed by the person\] Today's spelling finished/);
  // A page that does not send proposal_id: the only practice card of that answer names it.
  const named = await ctx.coach.practiceResult('me', { plan_id: started.plan.id, message_uid: asked.message.uid, done: 1, total: 3, right: 1, seconds: 30, stopped: true });
  assert.equal(named.messages[0].text, "Today's spelling: stopped after 1 of 3, 1 of 1 right, 1 min.");
  assert.equal(named.messages[0].meta.practice.kind, 'today_spelling');
  const early = await ctx.coach.practiceResult('me', { done: 9, total: 25, right: 7, seconds: 200, stopped: true });
  assert.match(early.messages[0].text, /stopped after 9 of 25/);
});

test('the view: the newest page first with has_more, before, the settings and tools_ok', async t => {
  const ctx = setup(t);
  for (let index = 0; index < 3; index += 1) { ctx.clock.now += 1000; await ctx.coach.send('me', { text: `Q${index}` }); }
  const page = ctx.coach.view('me', { limit: 4 });
  assert.deepEqual(page.messages.map(item => item.text), ['Q1', 'Hello there.', 'Q2', 'Hello there.']);
  assert.equal(page.messages.length, 4);
  assert.equal(page.has_more, true);
  assert.equal(page.messages[0].text, 'Q1');
  const older = ctx.coach.view('me', { before: page.messages[0].at, limit: 4 });
  assert.deepEqual(older.messages.map(item => item.text), ['Q0', 'Hello there.']);
  assert.equal(older.has_more, false);
  assert.deepEqual(page.settings, { memory: true, read_answers: true, read_text: true, economy: false });
  assert.equal(page.tools_ok, true);
  assert.throws(() => ctx.coach.view('me', { limit: 0 }), { statusCode: 400 });
});

// ---- Routes ----
async function serve(t, ctx, coach = ctx.coach) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', createLearnRouter({ service: ctx.learn, coach, chat: null, sync: null, analysis: null, pick: null, ask: null, requireAuth: (req, res, next) => { req.session = { user: { login: 'me' } }; next(); }, clientOrigin: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/learn`;
  return async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: /ndjson/.test(type) ? text.split('\n').filter(Boolean).map(line => JSON.parse(line)) : (text ? JSON.parse(text) : null) };
  };
}

test('the routes: GET /coach, a send as NDJSON (status, deltas, proposals, done with tools and usage), refusals as JSON, run, cancel, undo, notes, reset', async t => {
  const ctx = setup(t, {
    script: (request, index) => {
      if (request.messages.at(-1).content.endsWith('Plain')) return { content: [`Plain.${meta()}`] };
      return index === 0 ? { toolCalls: [call('propose_settings', { changes: { daily_goal: 30 } }, 's1'), call('remember', { text: 'Likes technical vocabulary' }, 'm1')] } : { content: ['Shall ', 'I?', meta()] };
    },
  });
  const http = await serve(t, ctx);
  const empty = await http('GET', '/coach');
  assert.deepEqual(empty.body, { messages: [], has_more: false, tools_ok: true, translator: true, settings: { memory: true, read_answers: true, read_text: true, economy: false } });
  const sent = await http('POST', '/coach/send', { text: 'Set my goal to 30' });
  assert.equal(sent.status, 200);
  assert.match(sent.type, /ndjson/);
  const types = sent.body.map(line => line.type || (line.delta !== undefined ? 'delta' : line.done ? 'done' : '?'));
  assert.deepEqual(types, ['status', 'status', 'remembered', 'delta', 'delta', 'proposals', 'done']);
  assert.deepEqual(sent.body.filter(line => line.type === 'status').map(line => line.text), ['Preparing a change', 'Saving a note']);
  const done = sent.body.at(-1);
  assert.deepEqual([done.tools, done.usage.calls, done.usage.tool_rounds, done.message.text], [true, 2, 1, 'Shall I?']);
  assert.deepEqual(done.messages.map(item => item.role), ['user', 'assistant']);
  const proposal = done.message.meta.proposals[0];

  assert.deepEqual((await http('POST', '/coach/send', { text: '' })).body, { error: 'Enter your question' });
  const run = await http('POST', `/coach/proposals/${proposal.id}/run`, { message_uid: done.message.uid });
  assert.equal(run.status, 200);
  assert.equal(ctx.learn.settings('me').daily_goal, 30);
  assert.equal((await http('POST', '/coach/undo', { token: run.body.undo.token })).status, 200);
  assert.equal(ctx.learn.settings('me').daily_goal, 20);
  assert.equal((await http('POST', '/coach/undo', { token: run.body.undo.token })).status, 410);
  assert.equal((await http('POST', `/coach/proposals/${proposal.id}/cancel`, { message_uid: done.message.uid })).status, 409, 'not open any more');

  const notes = await http('GET', '/coach/notes');
  assert.deepEqual(notes.body.notes.map(note => note.text), ['Likes technical vocabulary']);
  const uid = notes.body.notes[0].uid;
  assert.equal((await http('PATCH', `/coach/notes/${uid}`, { text: 'Likes technical words', until: '2027-01-01' })).body.note.until, '2027-01-01');
  assert.equal((await http('PATCH', `/coach/notes/${uid}`, { text: 'api key sk-abcdefghijklmnop' })).status, 400);
  const deleted = await http('DELETE', `/coach/notes/${uid}`);
  assert.ok(deleted.body.undo.token);
  assert.equal((await http('GET', '/coach/notes')).body.notes.length, 0);
  await http('POST', '/coach/undo', { token: deleted.body.undo.token });
  assert.equal((await http('GET', '/coach/notes')).body.notes[0].text, 'Likes technical words');
  assert.deepEqual((await http('POST', '/coach/summary/reset')).body, { ok: true });
  const page = await http('GET', '/coach?limit=1');
  assert.deepEqual([page.body.messages.length, page.body.has_more], [1, true]);
  assert.deepEqual((await http('GET', '/chats')).status, 503, 'no chat service handed in');
  const none = await serve(t, ctx, null);
  assert.equal((await none('GET', '/coach')).status, 503);
});

// ---- The translator's tool calls ----
function translatorWith(t, respond) {
  const db = database(t);
  const requests = [];
  const translator = createTranslator({ db, sessionSecret: 'test-secret-test-secret', fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return respond(requests.length - 1); } });
  translator.saveConfig('me', { provider: 'deepseek', apiKey: 'sk-test', enabled: true });
  return { translator, requests };
}
const sse = events => new Response(new ReadableStream({
  start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)); controller.close(); },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const tools = coachModule.TOOL_DEFS;

test('converseTools: tools in the request, a JSON answer with tool calls, a stream with tool calls in pieces and usage, a refusal of tools is typed', async t => {
  const json = translatorWith(t, () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'learn_schema', arguments: '{}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const answer = await json.translator.converseTools('me', 'system', [{ role: 'user', content: 'Hi' }], { tools, toolChoice: 'auto' });
  assert.deepEqual(answer, { content: '', toolCalls: [{ id: 'call_1', name: 'learn_schema', arguments: '{}' }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
  assert.equal(json.requests[0].body.tool_choice, 'auto');
  assert.equal(json.requests[0].body.tools.length, tools.length);
  assert.match(json.requests[0].url, /\/chat\/completions$/);

  const streamed = translatorWith(t, () => sse([
    { choices: [{ delta: { content: 'Let me ' } }] }, { choices: [{ delta: { content: 'look.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'learn_sql', arguments: '{"que' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"SELECT 1"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 40, completion_tokens: 8 } }, '[DONE]',
  ]));
  const pieces = [];
  const round = await streamed.translator.converseTools('me', 'system', [
    { role: 'user', content: 'Hi' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', name: 'learn_schema', arguments: '{}' }] }, { role: 'tool', tool_call_id: 'call_0', content: 'views' },
  ], { tools, onDelta: piece => pieces.push(piece) });
  assert.deepEqual(pieces, ['Let me ', 'look.']);
  assert.deepEqual(round.toolCalls, [{ id: 'call_a', name: 'learn_sql', arguments: '{"query":"SELECT 1"}' }]);
  assert.deepEqual(round.usage, { prompt_tokens: 40, completion_tokens: 8 });
  const sent = streamed.requests[0].body;
  assert.deepEqual(sent.messages[2], { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'learn_schema', arguments: '{}' } }] });
  assert.deepEqual(sent.messages[3], { role: 'tool', tool_call_id: 'call_0', content: 'views' });
  assert.deepEqual(sent.stream_options, { include_usage: true });

  const refused = translatorWith(t, () => new Response(JSON.stringify({ error: { message: 'This model does not support tools', code: 'invalid_request_error' } }), { status: 400 }));
  await assert.rejects(refused.translator.converseTools('me', 's', [{ role: 'user', content: 'Hi' }], { tools }), error => error instanceof ToolsUnsupportedError && error.code === 'TOOLS_UNSUPPORTED');
  const other = translatorWith(t, () => new Response(JSON.stringify({ error: { message: 'Insufficient balance' } }), { status: 400 }));
  await assert.rejects(other.translator.converseTools('me', 's', [{ role: 'user', content: 'Hi' }], { tools }), error => !(error instanceof ToolsUnsupportedError) && /Insufficient balance/.test(error.message));
  await assert.rejects(other.translator.converseTools('me', 's', [{ role: 'system', content: 'x' }], { tools }), { message: 'Invalid conversation' });
  await assert.rejects(other.translator.converseTools('me', 's', [{ role: 'user', content: 'x' }], { tools: [] }), { message: 'Invalid conversation' });
});

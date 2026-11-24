// The English coach on the Learn page: the pure parts in scripts/h5-shell/learn-series.mjs (the practice series: steps, the exercise of each card,
// the header's progress, the misses that come back, the result) and scripts/h5-shell/learn-coach.mjs (the stream lines, the proposal cards, the
// practice divider, the suggestions, the Remembered line and the notes). See docs/design/learn-english-coach-page.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-learn-coach-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const series = () => import('../scripts/h5-shell/learn-series.mjs');
const coach = () => import('../scripts/h5-shell/learn-coach.mjs');

const word = (id, en, extra = {}) => ({ id, kind: 'word', en, zh: `zh-${en}`, ...extra });
const sentence = (id, en) => ({ id, kind: 'sentence', en, zh: `zh-${id}` });

test('the exercise of a card in each step: spell, fill (a word inside its own sentence), dictation only with speech output, the retest as Spell', async () => {
  const { seriesExercise, exerciseCard, contextGap } = await series();
  const plain = word(1, 'separate');
  const inSentence = word(2, 'receive', { context: 'Did you receive the invoice?' });
  const line = sentence(3, 'The build failed again.');
  assert.equal(seriesExercise(plain, 'spell'), 'spell');
  assert.equal(seriesExercise(line, 'spell'), 'fill', 'a sentence gets the sentence exercise');
  assert.equal(seriesExercise(plain, 'retest'), 'spell');
  assert.equal(seriesExercise(inSentence, 'fill'), 'fill');
  assert.equal(seriesExercise(plain, 'fill'), 'spell', 'a word without its sentence is spelled');
  assert.equal(seriesExercise(line, 'fill'), 'fill');
  assert.equal(seriesExercise(line, 'dictation', { tts: true }), 'dictation');
  assert.equal(seriesExercise(line, 'dictation', { tts: false }), null);
  assert.equal(seriesExercise(plain, 'build'), null, 'Build the sentence stays hidden');
  assert.deepEqual(contextGap(inSentence), { word: 'receive', before: 'Did you ', after: ' the invoice?' });
  const shown = exerciseCard(inSentence, 'fill');
  assert.equal(shown.id, 2);
  assert.equal(shown.en, 'Did you receive the invoice?');
  assert.deepEqual(shown.gap, { word: 'receive', before: 'Did you ', after: ' the invoice?' });
  assert.equal(exerciseCard(inSentence, 'spell'), inSentence);
});

function mistakesPlan() {
  const cards = [word(1, 'separate'), word(2, 'receive', { context: 'Did you receive it?' }), word(3, 'necessary', { context: 'It is necessary.' })];
  return {
    id: 'p1', minutes: 12,
    steps: [{ mode: 'spell', cards }, { mode: 'fill', cards: cards.slice(1) }, { mode: 'dictation', cards: [sentence(9, 'We shipped it.')] }, { mode: 'retest', cards: [] }],
  };
}

test('a series runs its steps in order; dictation is left out without speech output; the misses come back in the retest', async () => {
  const { createSeries, seriesCurrent, seriesAnswer, seriesProgress, seriesDone, seriesResult } = await series();
  let state = createSeries(mistakesPlan(), { tts: false, now: 1000 });
  assert.deepEqual(state.steps.map(step => [step.mode, step.items.length]), [['spell', 3], ['fill', 2], ['retest', 0]]);
  assert.deepEqual(seriesProgress(state), { step: 1, steps: 3, at: 1, of: 3, share: 0 });
  state = seriesAnswer(state, { correct: true, answer: 'separate' });
  state = seriesAnswer(state, { correct: false, answer: 'recieve' });
  assert.deepEqual(seriesProgress(state).at, 3);
  state = seriesAnswer(state, { correct: true, answer: 'necessary' });
  assert.equal(seriesCurrent(state).mode, 'fill');
  assert.equal(seriesCurrent(state).exercise, 'fill');
  assert.deepEqual(seriesProgress(state), { step: 2, steps: 3, at: 1, of: 2, share: 3 / 6 });
  state = seriesAnswer(state, { correct: false, answer: 'recieve' }); // the same card again: one retest item
  state = seriesAnswer(state, { correct: false, answer: 'neccesary' });
  assert.deepEqual(state.steps[2].items.map(one => one.card.en), ['receive', 'necessary']);
  assert.equal(seriesCurrent(state).mode, 'retest');
  assert.equal(seriesCurrent(state).exercise, 'spell');
  assert.deepEqual(seriesProgress(state), { step: 3, steps: 3, at: 1, of: 2, share: 5 / 7 });
  state = seriesAnswer(state, { correct: true, answer: 'receive' });
  state = seriesAnswer(state, { correct: false, answer: 'necesary' }); // missed in the retest: not again
  assert.equal(seriesDone(state), true);
  assert.equal(seriesCurrent(state), null);
  const result = seriesResult(state, { messageUid: 'm1', now: 1000 + 125000 });
  assert.deepEqual(result, {
    plan_id: 'p1', message_uid: 'm1',
    steps: [{ mode: 'spell', total: 3, done: 3, right: 2 }, { mode: 'fill', total: 2, done: 2, right: 0 }, { mode: 'retest', total: 2, done: 2, right: 1 }],
    done: 5, total: 5, right: 2,
    missed: [{ en: 'receive', typed: 'recieve' }, { en: 'necessary', typed: 'neccesary' }],
    seconds: 125,
  });
});

test('with speech output the dictation step runs; a retest with nothing missed is skipped', async () => {
  const { createSeries, seriesAnswer, seriesDone, seriesProgress } = await series();
  let state = createSeries(mistakesPlan(), { tts: true });
  assert.deepEqual(state.steps.map(step => step.mode), ['spell', 'fill', 'dictation', 'retest']);
  assert.equal(seriesProgress(state).steps, 4);
  for (let i = 0; i < 6; i += 1) state = seriesAnswer(state, { correct: true, answer: 'x' });
  assert.equal(seriesDone(state), true);
  assert.equal(seriesProgress(state).steps, 3, 'the empty retest does not count at the end');
});

test('without a retest step a missed word comes back once at the end of the last step', async () => {
  const { createSeries, seriesAnswer, seriesCurrent, seriesDone, seriesResult, seriesProgress } = await series();
  let state = createSeries({ id: 7, steps: [{ mode: 'spell', cards: [word(1, 'a1'), word(2, 'b2'), word(3, 'c3')] }] });
  state = seriesAnswer(state, { correct: false, answer: 'aa' });
  state = seriesAnswer(state, { correct: true, answer: 'b2' });
  state = seriesAnswer(state, { correct: true, answer: 'c3' });
  assert.deepEqual(seriesProgress(state), { step: 1, steps: 1, at: 4, of: 4, share: 3 / 4 });
  assert.equal(seriesCurrent(state).card.en, 'a1');
  assert.equal(seriesCurrent(state).again, true);
  state = seriesAnswer(state, { correct: false, answer: 'a' }); // missed again: not a third time
  assert.equal(seriesDone(state), true);
  const result = seriesResult(state, { now: state.startedAt });
  assert.equal(result.total, 3);
  assert.equal(result.done, 3);
  assert.equal(result.right, 2);
  assert.deepEqual(result.missed, [{ en: 'a1', typed: 'aa' }]);
});

test('leaving early: the answers so far and stopped: true; skipped cards are neither right nor missed', async () => {
  const { createSeries, seriesAnswer, seriesResult } = await series();
  const cards = Array.from({ length: 25 }, (_, i) => word(i + 1, `w${i + 1}`));
  let state = createSeries({ id: 'p', steps: [{ mode: 'spell', cards }] });
  for (let i = 0; i < 8; i += 1) state = seriesAnswer(state, { correct: true, answer: 'x' });
  state = seriesAnswer(state, { skipped: true });
  const result = seriesResult(state, { messageUid: 'u', stopped: true });
  assert.equal(result.stopped, true);
  assert.equal(result.done, 9);
  assert.equal(result.total, 25);
  assert.equal(result.right, 8);
  assert.deepEqual(result.missed, []);
});

test('an empty or broken plan is a series that is done at once; unknown modes and suspended cards are left out', async () => {
  const { createSeries, seriesDone } = await series();
  assert.equal(seriesDone(createSeries(null)), true);
  assert.equal(seriesDone(createSeries({ steps: [{ mode: 'build', cards: [sentence(1, 'A b c.')] }, { mode: 'spell', cards: [word(2, 'x', { suspended: true })] }] })), true);
});

test('the stream lines: delta, status, proposals, remembered, done with its messages and tools, error', async () => {
  const { coachLine } = await coach();
  assert.deepEqual(coachLine({ delta: 'Hi' }), { kind: 'delta', text: 'Hi' });
  assert.deepEqual(coachLine({ type: 'status', text: 'Looking at your answers' }), { kind: 'status', text: 'Looking at your answers' });
  assert.deepEqual(coachLine({ type: 'proposals', proposals: [{ id: 'a' }, null] }), { kind: 'proposals', proposals: [{ id: 'a' }] });
  assert.deepEqual(coachLine({ type: 'remembered', note: { uid: 'n', text: 'x' } }), { kind: 'remembered', note: { uid: 'n', text: 'x' } });
  assert.equal(coachLine({ type: 'remembered' }), null);
  assert.deepEqual(coachLine({ done: true, message: { uid: 'a1', role: 'assistant' }, user: { uid: 'q1', role: 'user' }, tools: false }),
    { kind: 'done', messages: [{ uid: 'q1', role: 'user' }, { uid: 'a1', role: 'assistant' }], tools: false, usage: null });
  assert.deepEqual(coachLine({ type: 'done', messages: [{ uid: 'x' }], usage: { calls: 2 } }), { kind: 'done', messages: [{ uid: 'x' }], tools: true, usage: { calls: 2 } });
  assert.deepEqual(coachLine({ error: 'Timed out', status: 504 }), { kind: 'error', message: 'Timed out', status: 504 });
  assert.equal(coachLine({ chat: { uid: 'x' } }), null);
  assert.equal(coachLine('text'), null);
});

test('merging pages of messages keeps each once, oldest first, with meta read', async () => {
  const { mergeCoach, metaOf } = await coach();
  const merged = mergeCoach([{ uid: 'b', at: '2026-11-24T02:00:00Z', meta: '{"suggestions":["x"]}' }], [{ uid: 'a', at: '2026-11-24T01:00:00Z' }, { uid: 'b', at: '2026-11-24T02:00:00Z', text: 'B' }]);
  assert.deepEqual(merged.map(one => one.uid), ['a', 'b']);
  assert.equal(merged[1].text, 'B');
  assert.deepEqual(merged[1].meta, { suggestions: ['x'] });
  assert.deepEqual(metaOf({ meta: 'not json' }), {});
});

test('proposal cards: their type, the plan caption and steps, the settings rows, the card sections and the reminder line', async () => {
  const { proposalType, planOf, planCaption, settingRows, cardSections, cardsAction, chipList, reminderLine, zoneLabel, proposalsOf } = await coach();
  assert.equal(proposalType({ id: 1, kind: 'practice', plan: { steps: [] } }), 'plan');
  assert.equal(proposalType({ id: 1, kind: 'mistakes_series', steps: [] }), 'plan');
  assert.equal(proposalType({ id: 1, kind: 'settings', changes: { new_per_day: 15 } }), 'settings');
  assert.equal(proposalType({ id: 1, add: [{ en: 'x' }] }), 'cards');
  assert.equal(proposalType({ id: 1, kind: 'reminder', time: '20:00', text: 'x' }), 'reminder');
  assert.equal(proposalType({ id: 1, kind: 'memory', text: 'x' }), 'memory');
  assert.equal(proposalType({ id: 1, kind: 'other' }), null);
  const plan = planOf({ id: 1, kind: 'practice', plan: { kind: 'mistakes_series', title: 'Your mistakes', words: 9, minutes: 12, steps: [{ mode: 'spell', card_ids: [1, 2] }, { mode: 'retest', card_ids: [] }] } });
  assert.deepEqual(plan, { kind: 'mistakes_series', title: 'Your mistakes', steps: [{ mode: 'spell', count: 2 }, { mode: 'retest', count: 0 }], words: 9, minutes: 12, notes: '' });
  assert.deepEqual(planCaption(plan), [['{1} words', 9], ['about {1} minutes', 12]]);
  assert.deepEqual(planCaption({ words: 1, minutes: 0 }), [['1 word']]);
  assert.deepEqual(settingRows({ changes: { new_per_day: 15, audio_words: false, odd_key: 'x' } }, { new_per_day: 10, audio_words: true }), [
    { key: 'new_per_day', label: 'New words a day', name: 'new_per_day', from: { text: '10' }, to: { text: '15' } },
    { key: 'audio_words', label: 'Play words automatically', name: 'audio_words', from: { key: 'On' }, to: { key: 'Off' } },
    { key: 'odd_key', label: null, name: 'odd_key', from: null, to: { text: 'x' } },
  ]);
  assert.deepEqual(settingRows({ changes: { new_per_day: 15 }, before: { new_per_day: 5 } }, { new_per_day: 10 })[0].from, { text: '5' }, 'the card\'s own "before" wins');
  const sections = cardSections({ add: Array.from({ length: 6 }, (_, i) => ({ kind: 'word', en: `w${i}` })) });
  assert.deepEqual(sections.map(one => [one.part, one.title]), [['add', ['Add {1} words', 6]]]);
  assert.equal(cardsAction(sections), 'Add all');
  assert.deepEqual(chipList(sections[0].items), ['w0', 'w1', 'w2', '+3']);
  assert.deepEqual(chipList(sections[0].items.slice(0, 4)), ['w0', 'w1', 'w2', 'w3'], 'four fit without a +1');
  assert.deepEqual(cardSections({ remove: [5] }).map(one => [one.part, one.title, one.items[0].en]), [['remove', ['Remove 1 card'], '#5']]);
  assert.equal(cardsAction(cardSections({ add: [{ en: 'a' }], update: [{ id: 1, en: 'b', zh: 'c' }] })), 'Apply');
  assert.equal(zoneLabel('Asia/Taipei'), 'Taipei');
  assert.equal(zoneLabel('America/New_York'), 'New York');
  assert.deepEqual(reminderLine({ time: '20:00', text: "Today's English practice" }, { zone: 'Taipei' }), ['Every day at {1} ({2} time): "{3}".', '20:00', 'Taipei', "Today's English practice"]);
  assert.deepEqual(reminderLine({ time: '08:30', days: ['fri', 'mon', 3], text: 'x' }, { zone: 'Taipei' }), ['Every {1} at {2} ({3} time): "{4}".', 'mon, wed, fri', '08:30', 'Taipei', 'x']);
  const list = proposalsOf({ meta: { proposals: [{ id: 'a', kind: 'settings', changes: {}, state: 'open' }, { id: 'b', kind: 'weird' }, { kind: 'settings', changes: {} }] } }, { a: 'done' });
  assert.deepEqual(list.map(one => [one.id, one.state]), [['a', 'done']]);
});

test('the practice divider, the suggestions, the Remembered line and the notes rows', async () => {
  const { practiceLine, practiceOf, suggestionsOf, rememberedLine, rememberedOf, noteLine, cleanNote, NOTE_MAX } = await coach();
  assert.deepEqual(practiceLine({ kind: 'today_spelling', total: 25, done: 25, seconds: 480 }), ['Spelling finished · {1} words · {2} min', 25, 8]);
  assert.deepEqual(practiceLine({ kind: 'mistakes_series', total: 9, done: 9, seconds: 20 }), ['Practice finished · {1} words · {2} min', 9, 1]);
  assert.deepEqual(practiceLine({ kind: 'spell', total: 1, seconds: 60 }), ['Spelling finished · 1 word · {1} min', 1]);
  assert.deepEqual(practiceLine({ total: 25, done: 9, stopped: true }), ['Stopped after {1} of {2}', 9, 25]);
  assert.deepEqual(practiceOf({ meta: { practice: { total: 3 } } }), { total: 3 });
  assert.deepEqual(suggestionsOf({ meta: { suggestions: ['Practise the 3 I missed', { text: '5 more new words' }, '', 'Practise the 3 I missed', 'a', 'b', 'c'] } }), ['Practise the 3 I missed', '5 more new words', 'a', 'b']);
  assert.deepEqual(rememberedLine({ text: 'job interview in March', until: '2027-03-31' }, () => '31 Mar'), ['Remembered: {1} (until {2})', 'job interview in March', '31 Mar']);
  assert.deepEqual(rememberedLine({ text: 'likes short answers' }), ['Remembered: {1}', 'likes short answers']);
  assert.deepEqual(rememberedOf({ meta: { remembered: { uid: 'n', text: 'x' } } }), [{ uid: 'n', text: 'x' }]);
  assert.deepEqual(noteLine({ created_at: 'c', until: 'u' }, { short: () => '11-24', day: () => '31 Mar' }), ['{1} · until {2}', '11-24', '31 Mar']);
  assert.deepEqual(noteLine({ created_at: 'c' }, { short: () => '11-24' }), ['11-24']);
  assert.equal(cleanNote('  two\nlines  '), 'two lines');
  assert.equal(cleanNote('x'.repeat(300)).length, NOTE_MAX);
});

test('the usage caption: lookups, calls and tokens, nothing without lookups or tokens', async () => {
  const { usageParts, usageOf } = await coach();
  const number = n => n.toLocaleString('en-US');
  assert.deepEqual(usageParts({ calls: 4, tool_rounds: 3 }, number), [['Looked at your data {1} times', 3]]);
  assert.deepEqual(usageParts({ calls: 2, tool_rounds: 1 }, number), [['Looked at your data once']]);
  assert.deepEqual(usageParts({ calls: 3, tool_rounds: 2, prompt_tokens: 18000, completion_tokens: 400 }, number), [['Looked at your data {1} times', 2], ['{1} calls', 3], ['{1} tokens', '18,400']]);
  assert.deepEqual(usageParts({ calls: 1, tool_rounds: 0, prompt_tokens: 900, completion_tokens: 100 }, number), [['1 call'], ['{1} tokens', '1,000']]);
  assert.deepEqual(usageParts({ calls: 1, tool_rounds: 0 }), []);
  assert.deepEqual(usageParts(null), []);
  assert.deepEqual(usageOf({ meta: { usage: { calls: 1 } } }), { calls: 1 });
});

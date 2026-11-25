// The practice series of the English coach (pure, with unit tests): a plan from POST /api/learn/coach/plans/start (`{ id, steps: [{ mode, cards }] }`)
// run as one Learn session, step after step. Which exercise each card gets in a step, the progress of the header ("Step 2 of 4 · 7 / 9"), the
// words missed in the series that come back at its end, and the result the page posts to /api/learn/coach/practice-result.
// See "The practice series" in docs/design/learn-english-coach-page.md.
import { findWholeWord, SENTENCE_EXERCISE } from './learn-model.mjs';

// `review` is the step of a Review plan (services/learn-plan.js): a word is spelled, a sentence gets the sentence exercise, as in a Review session.
export const SERIES_MODES = ['spell', 'direct_spell', 'study', 'review', 'fill', 'dictation', 'retest'];

// A word card asked inside its own sentence in a Fill the gap step: its `context` with the word as the gap ({ word, before, after }), or null when
// the word is not in its context as a whole word.
export function contextGap(card) {
  if (!card || card.kind === 'sentence') return null;
  const context = String(card.context || '').trim();
  const word = String(card.en || '').trim();
  if (!context || !word) return null;
  const at = findWholeWord(context, word);
  if (at < 0) return null;
  const after = context.slice(at + word.length);
  if (findWholeWord(after, word) >= 0) return null;
  return { word: context.slice(at, at + word.length), before: context.slice(0, at), after };
}

// The exercise a card gets in a step (null: the card is left out of this step): Spell, Review and the retest spell a word and give a sentence the
// sentence exercise; Fill the gap takes a sentence, or a word inside its own sentence (else the word is spelled); Dictation needs speech output (`tts`), else
// the whole step is left out.
export function seriesExercise(card, mode, { tts = false } = {}) {
  if (!card) return null;
  const sentence = card.kind === 'sentence';
  if (mode === 'study' || mode === 'direct_spell') return sentence ? null : mode === 'study' ? 'study' : 'spell';
  if (mode === 'dictation') return tts ? 'dictation' : null;
  if (mode === 'fill') return sentence || contextGap(card) ? 'fill' : 'spell';
  if (mode === 'spell' || mode === 'review' || mode === 'retest') return sentence ? SENTENCE_EXERCISE : 'spell';
  return null;
}

// The card an exercise is shown with: a word in a Fill the gap step becomes its sentence with a fixed gap (`gap`, read by the exercise), the id stays
// the word card's, so the answer is the word card's answer.
export function exerciseCard(card, exercise, mode) {
  if (card && (mode === 'direct_spell' || (mode === 'fill' && exercise === 'spell'))) return { ...card, context: '', context_zh: '' };
  if (exercise !== 'fill' || !card || card.kind === 'sentence') return card;
  const gap = contextGap(card);
  return gap ? { ...card, en: String(card.context).trim(), zh: card.context_zh || card.zh, context: '', kind: 'sentence', gap } : card;
}

const item = (card, mode, exercise, again = false) => ({ card, mode, exercise, again });

// A new series from the plan: the steps that have something to do (a retest step is kept: it is filled with the words missed on the way), each
// with its items. `tts`: whether the page can speak (Dictation).
export function createSeries(plan, { tts = false, now = Date.now() } = {}) {
  const steps = [];
  for (const step of (plan && Array.isArray(plan.steps) ? plan.steps : [])) {
    if (!step || !SERIES_MODES.includes(step.mode)) continue;
    if (step.mode === 'retest') {
      if (!steps.some(one => one.mode === 'retest')) steps.push({ mode: 'retest', items: [] });
      continue;
    }
    const items = [];
    for (const card of Array.isArray(step.cards) ? step.cards : []) {
      if (!card || card.id === undefined || card.id === null || card.suspended) continue;
      const exercise = seriesExercise(card, step.mode, { tts });
      if (exercise) items.push(item(card, step.mode, exercise));
    }
    if (items.length) steps.push({ mode: step.mode, items });
  }
  // A retest is the end of the series.
  const retest = steps.findIndex(step => step.mode === 'retest');
  if (retest >= 0 && retest !== steps.length - 1) steps.push(...steps.splice(retest, 1));
  return { planId: plan && plan.id !== undefined ? plan.id : null, minutes: Number(plan && plan.minutes) || 0, steps, step: 0, at: 0, answers: [], startedAt: now, ...skipEmpty({ steps, step: 0, at: 0 }) };
}

// Past the end of a step (or onto a retest with nothing to retest): on to the next step that has an item.
function skipEmpty(state) {
  let { step, at } = state;
  while (step < state.steps.length && at >= state.steps[step].items.length) { step += 1; at = 0; }
  return { step, at };
}

export const seriesDone = state => !state || state.step >= state.steps.length;

// The item to show now: { card, mode, exercise, again, step, at } or null at the end.
export function seriesCurrent(state) {
  if (seriesDone(state)) return null;
  const found = state.steps[state.step].items[state.at];
  return found ? { ...found, step: state.step, at: state.at } : null;
}

// The steps that count in the header: those with items, and a retest not reached yet (it may stay empty: then the series ends before it).
const shownSteps = state => state.steps.filter((step, index) => step.items.length || (step.mode === 'retest' && index >= state.step));

// The header's progress: { step, steps, at, of } (1-based; at the end the last step at its end), and the share answered of the whole series (0..1).
export function seriesProgress(state) {
  const shown = shownSteps(state);
  const items = state.steps.reduce((sum, step) => sum + step.items.length, 0);
  const studied = state.steps.reduce((sum, step, index) => sum + (step.mode !== 'study' ? 0
    : index < state.step ? step.items.length : index === state.step ? state.at : 0), 0);
  const share = items ? Math.min(1, (studied + state.answers.length) / items) : 1;
  if (seriesDone(state)) {
    const last = shown[shown.length - 1];
    return { step: shown.length, steps: shown.length, at: last ? last.items.length : 0, of: last ? last.items.length : 0, share: 1 };
  }
  const current = state.steps[state.step];
  return { step: shown.indexOf(current) + 1, steps: shown.length, at: state.at + 1, of: current.items.length, share };
}

const sameCard = (a, b) => String(a && a.id) === String(b && b.id);

export function seriesStudy(state) {
  if (seriesCurrent(state)?.mode !== 'study') return state;
  return { ...state, ...skipEmpty({ steps: state.steps, step: state.step, at: state.at + 1 }) };
}

// One answer (or a skip: `skipped: true`) to the current item: kept, then the next item. A card missed outside the retest comes back once at the end
// of the series: into the retest step when the plan has one (each card once), else after the last step's items (each card once).
export function seriesAnswer(state, { correct = false, answer = '', skipped = false } = {}) {
  const current = seriesCurrent(state);
  if (!current || current.mode === 'study') return state;
  const steps = state.steps.map(step => ({ ...step, items: [...step.items] }));
  const answers = [...state.answers, { card: current.card, mode: current.mode, exercise: current.exercise, again: current.again, step: current.step, correct: Boolean(correct) && !skipped, skipped: Boolean(skipped), answer: String(answer || '') }];
  if (!correct && !skipped && current.mode !== 'retest' && !current.again) {
    const retest = steps.find(step => step.mode === 'retest');
    if (retest) {
      if (!retest.items.some(one => sameCard(one.card, current.card))) retest.items.push(item(current.card, 'retest', seriesExercise(current.card, 'retest')));
    } else {
      const last = steps[steps.length - 1];
      if (!last.items.some(one => one.again && sameCard(one.card, current.card))) last.items.push(item(current.card, current.mode, current.exercise, true));
    }
  }
  return { ...state, steps, answers, ...skipEmpty({ steps, step: state.step, at: state.at + 1 }) };
}

// The result posted to POST /api/learn/coach/practice-result, counted in different cards (words), not in items: a word asked in two steps of a
// mistakes series is one word. `total`: the cards of the items the plan gave (not the misses that came back nor the retest); `done`: of those, the
// cards answered there; `right`: the cards answered there and never wrong there; `missed`: each card answered wrong anywhere in the series, with what
// was typed the first time; `steps`: per step { mode, total, done, right } in items (the retest too); `stopped`: left before the end. `proposalId` and
// `kind` name the plan card it came from (the server titles the result by it).
export function seriesResult(state, { messageUid = '', proposalId = '', kind = '', stopped = false, now = Date.now() } = {}) {
  const key = card => String(card && card.id);
  const planned = new Set(state.steps.filter(step => step.mode !== 'retest' && step.mode !== 'study').flatMap(step => step.items.filter(one => !one.again).map(one => key(one.card))));
  const first = state.answers.filter(one => one.mode !== 'retest' && !one.again);
  const answered = new Set(first.map(one => key(one.card)));
  const wrong = new Set(first.filter(one => !one.correct).map(one => key(one.card)));
  const missed = [];
  for (const one of state.answers) {
    if (one.correct || one.skipped || missed.some(entry => entry.id === key(one.card))) continue;
    missed.push({ id: key(one.card), en: String(one.card.en || ''), typed: one.answer.slice(0, 200) });
  }
  const steps = state.steps.map((step, index) => {
    const mine = state.answers.filter(one => one.step === index);
    return { mode: step.mode, total: step.items.length, done: mine.length, right: mine.filter(one => one.correct).length };
  }).filter(step => step.mode !== 'study');
  return {
    plan_id: state.planId,
    message_uid: messageUid,
    ...(proposalId ? { proposal_id: String(proposalId) } : {}),
    ...(kind ? { kind: String(kind) } : {}),
    steps,
    done: answered.size,
    total: planned.size,
    right: [...answered].filter(id => !wrong.has(id)).length,
    missed: missed.map(({ en, typed }) => ({ en, typed })),
    seconds: Math.max(0, Math.round((now - state.startedAt) / 1000)),
    ...(stopped ? { stopped: true } : {}),
  };
}

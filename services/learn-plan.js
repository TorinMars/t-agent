// The practice plans of the English coach ("Practice plans" in docs/design/learn-english-coach.md): what a plan card offers and what its Start runs.
// Word practice selects cards first and applies a method to that selection. Saved preset plans still use the queues of services/learn.js.
//
// buildPlan(owner, kind, { words?, count? }) -> { kind, title, steps: [{ mode, card_ids }], words, minutes, notes } (steps without cards are left out;
// words: the different cards in it). Kinds:
// - today_spelling: the spell queue (due words, then today's new ones), the words now in Mistakes first.
// - review: the review queue.
// - more_new_words: the next `count` (5) new words; the allowance is raised only when the person starts it (startPlan with `raise`).
// - dictation, fill_gap: the dictation and fill queues (sentences).
// - mistakes_series: spell wrong words, most often wrong first, then retest words missed in the series.
// `words` (card ids or English texts) narrows a plan to those cards ("Practise the 3 I missed").
const { normalize } = require('./learn');
const { wholeWordPlaces } = require('./learn-sentences');
const { WORD_METHODS, cleanPracticeExamples } = require('./learn-merge');

const KINDS = ['today_spelling', 'review', 'mistakes_series', 'more_new_words', 'dictation', 'fill_gap'];
const WORD_SOURCES = ['today', 'due', 'new', 'highest_error_rate', 'selected'];
const SECONDS = { spell: 20, direct_spell: 20, study: 10, review: 12, fill: 30, dictation: 40, retest: 15 };
const TITLES = {
  word_practice: 'Word practice',
  today_spelling: "Today's spelling", review: 'Review', mistakes_series: 'Your mistakes', more_new_words: 'New words', dictation: 'Dictation', fill_gap: 'Fill the gap',
};
const MAX_CARDS = 50;

class PlanError extends Error { constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; } }

const hasPracticeContext = row => wholeWordPlaces(row.context, row.en).length === 1;

function createLearnPlan({ db, learn, now = Date.now }) {
  const limitOf = (count, fallback) => (Number.isInteger(count) && count >= 1 ? Math.min(count, MAX_CARDS) : fallback);
  // The owner's cards named by `words` (ids or English texts, a word card before a sentence card of the same text), in that order.
  function namedCards(owner, words) {
    if (!Array.isArray(words) || !words.length) return null;
    const out = [];
    const seen = new Set();
    for (const item of words.slice(0, MAX_CARDS)) {
      let row = null;
      if (Number.isSafeInteger(item)) row = db.prepare('SELECT * FROM learn_cards WHERE owner = ? AND id = ? AND suspended = 0').get(owner, item);
      else if (typeof item === 'string' && item.trim()) {
        row = db.prepare("SELECT * FROM learn_cards WHERE owner = ? AND norm = ? AND suspended = 0 ORDER BY kind = 'word' DESC LIMIT 1").get(owner, normalize(item));
      }
      if (row && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
    return out;
  }
  const minutesOf = steps => Math.max(1, Math.ceil(steps.reduce((sum, step) => sum + step.card_ids.length * (SECONDS[step.mode] || 20) * (step.mode === 'retest' ? 0.3 : 1), 0) / 60));
  const finish = (kind, steps, notes = '', extra = {}) => {
    const kept = steps.filter(step => step.card_ids.length);
    const words = new Set(kept.flatMap(step => step.card_ids)).size;
    return { kind, title: TITLES[kind], steps: kept, words, minutes: kept.length ? minutesOf(kept) : 0, notes, ...extra };
  };
  // The ids among `ids` that are word cards.
  const wordIds = (owner, ids) => (ids.length ? db.prepare(`SELECT id FROM learn_cards WHERE owner = ? AND kind = 'word' AND id IN (${ids.map(() => '?').join(',')})`).pluck().all(owner, ...ids) : []);
  const queueIds = async (owner, mode, limit, extra) => (await learn.queue(owner, mode, limit, extra ? { extra } : {})).cards.map(card => card.id);

  function selectWords(owner, { source, words, count }) {
    if (!WORD_SOURCES.includes(source)) throw new PlanError('Unknown word source');
    const take = limitOf(count, 10);
    const settings = learn.settings(owner);
    const at = now();
    const newLeft = learn.pace(owner, settings, at).new_left;
    const visible = "c.owner = @owner AND c.kind = 'word' AND c.suspended = 0 AND NOT (c.source = 'starter' AND c.reps = 0 AND @starter IS NULL)";
    const params = { owner, starter: settings.starter, at, take };
    const newWords = limit => db.prepare(`SELECT c.* FROM learn_cards c WHERE ${visible} AND c.reps = 0 ORDER BY c.due_at, c.id LIMIT @take`)
      .all({ ...params, take: Math.min(limit, newLeft) });
    if (source === 'new') return newWords(take);
    if (source === 'selected') {
      const selected = [];
      let newRemaining = newLeft;
      for (const row of namedCards(owner, words) || []) {
        if (row.kind !== 'word') continue;
        if (!row.reps) {
          if (!newRemaining || (row.source === 'starter' && settings.starter === null)) continue;
          newRemaining -= 1;
        }
        selected.push(row);
        if (selected.length === take) break;
      }
      return selected;
    }
    if (source === 'highest_error_rate') return db.prepare(`SELECT c.* FROM learn_cards c JOIN learn_reviews r ON r.card_id = c.id AND r.owner = c.owner
      WHERE ${visible} GROUP BY c.id HAVING SUM(r.correct = 0) > 0
      ORDER BY AVG(r.correct = 0) DESC, SUM(r.correct = 0) DESC, MAX(CASE WHEN r.correct = 0 THEN r.at END) DESC, c.id LIMIT @take`).all(params);
    const due = db.prepare(`SELECT c.* FROM learn_cards c WHERE ${visible} AND c.reps > 0 AND c.due_at <= @at ORDER BY c.due_at, c.id LIMIT @take`).all(params);
    return source === 'today' ? [...due, ...newWords(take - due.length)] : due;
  }

  function buildWordPlan(method, rows, rawExamples) {
    if (!WORD_METHODS.includes(method)) throw new PlanError('Unknown word practice method');
    const card_ids = rows.map(row => row.id);
    const modes = method === 'study_then_spell' ? ['study', 'direct_spell'] : [method === 'sentence_gap' ? 'fill' : 'direct_spell'];
    const missing = method === 'sentence_gap' ? rows.filter(row => !hasPracticeContext(row)).map(row => row.en) : [];
    const examples = cleanPracticeExamples(rawExamples, missing);
    return finish('word_practice', modes.map(mode => ({ mode, card_ids })), '', {
      method, words_list: rows.map(row => row.en), plain: missing.length - examples.length, examples,
    });
  }

  // The wrong answers of each card (all of them), for the order of a mistakes series.
  function wrongCounts(owner) {
    return new Map(db.prepare('SELECT card_id, COUNT(*) AS wrong, MAX(at) AS last FROM learn_reviews WHERE owner = ? AND correct = 0 GROUP BY card_id').all(owner)
      .map(row => [row.card_id, { wrong: row.wrong, last: row.last }]));
  }
  async function buildPlan(owner, kind, { words = null, count = null } = {}) {
    if (!KINDS.includes(kind)) throw new PlanError('Unknown practice plan');
    const named = namedCards(owner, words);
    if (kind === 'mistakes_series') return mistakesSeries(owner, named, limitOf(count, 12));
    if (named) {
      // A plan of the cards named: each in the exercise of its kind for this plan.
      const mode = kind === 'dictation' ? 'dictation' : kind === 'fill_gap' ? 'fill' : 'spell';
      const fit = named.filter(row => (mode === 'spell' ? row.kind === 'word' : row.kind === 'sentence'));
      return finish(kind, [{ mode, card_ids: fit.map(row => row.id) }]);
    }
    if (kind === 'today_spelling') {
      const ids = await queueIds(owner, 'spell', limitOf(count, MAX_CARDS));
      const wrong = new Set(learn.mistakeRows(owner, learn.settings(owner).starter).map(row => row.id));
      const first = ids.filter(id => wrong.has(id));
      return finish(kind, [{ mode: 'spell', card_ids: [...first, ...ids.filter(id => !wrong.has(id))] }], first.length ? `${first.length} words you got wrong come first` : '', { wrong_first: first.length });
    }
    if (kind === 'review') {
      // Review is word spelling too: the due word cards of the review queue, spelled.
      const ids = await queueIds(owner, 'review', 100);
      const words = new Set(wordIds(owner, ids));
      return finish(kind, [{ mode: 'spell', card_ids: ids.filter(id => words.has(id)).slice(0, limitOf(count, 20)) }]);
    }
    if (kind === 'dictation') return finish(kind, [{ mode: 'dictation', card_ids: await queueIds(owner, 'dictation', limitOf(count, 10)) }]);
    if (kind === 'fill_gap') return finish(kind, [{ mode: 'fill', card_ids: await queueIds(owner, 'fill', limitOf(count, 10)) }]);
    // more_new_words: the next new words in the order the spell queue gives new ones (by due date), before the allowance is raised.
    const take = limitOf(count, 5);
    const starter = learn.settings(owner).starter;
    const ids = db.prepare(`SELECT id FROM learn_cards WHERE owner = @owner AND kind = 'word' AND reps = 0 AND suspended = 0
      AND NOT (source = 'starter' AND @starter IS NULL) ORDER BY due_at ASC, id ASC LIMIT @take`).pluck().all({ owner, starter, take });
    return finish(kind, [{ mode: 'spell', card_ids: ids }], '', { count: take });
  }

  async function mistakesSeries(owner, named, limit) {
    const rows = named || (await learn.queue(owner, 'mistakes', limit)).cards.map(card => db.prepare('SELECT * FROM learn_cards WHERE id = ?').get(card.id)).filter(Boolean);
    const counts = wrongCounts(owner);
    const wrongOf = row => (counts.get(row.id) || { wrong: 0, last: 0 });
    // The most often wrong first, then the most recently wrong.
    const ordered = rows.slice().sort((a, b) => wrongOf(b).wrong - wrongOf(a).wrong || wrongOf(b).last - wrongOf(a).last || a.id - b.id);
    const wordRows = ordered.filter(row => row.kind === 'word');
    // Word spelling only: spell each wrong word, then retest them (the sentences and the dictation of the earlier series are not offered).
    const steps = [
      { mode: 'spell', card_ids: wordRows.map(row => row.id) },
      { mode: 'retest', card_ids: wordRows.map(row => row.id) },
    ];
    return finish('mistakes_series', steps, wordRows.length ? 'Each word comes back in another exercise; words missed again are retested at the end' : '');
  }

  // POST /coach/plans/start: the plan read again now, with the full queue cards of each step. `raise`: more_new_words raises today's allowance
  // first (once, when the person starts it). Returns { plan: { id, kind, title, steps: [{ mode, cards }], words, minutes }, stale } or { empty: true }.
  async function startPlan(owner, saved, { id, raise = false } = {}) {
    if (saved.kind === 'more_new_words' && raise) learn.addNewWords(owner, { count: saved.count || 5 });
    let plan;
    if (saved.kind === 'word_practice') {
      // Use the selection shown in the proposal. Names resolve to local word cards after sync.
      const rows = selectWords(owner, { source: 'selected', words: saved.words_list, count: MAX_CARDS });
      plan = buildWordPlan(saved.method, rows, saved.examples);
    } else if (saved.kind === 'more_new_words' && raise) {
      // The new words the raised allowance gives now.
      const cards = (await learn.queue(owner, 'spell', 100)).cards.filter(card => card.is_new).slice(0, saved.count || 5);
      plan = finish('more_new_words', [{ mode: 'spell', card_ids: cards.map(card => card.id) }], '', { count: saved.count || 5 });
    } else plan = await buildPlan(owner, saved.kind, { words: saved.words_list && saved.words_list.length ? saved.words_list : null, count: saved.count || null });
    const steps = [];
    const examples = new Map((plan.examples || []).map(example => [example.word, example]));
    const selectedCards = plan.kind === 'word_practice' && plan.steps.length
      ? await learn.practiceCards(owner, plan.steps[0].card_ids) : null;
    for (const step of plan.steps) {
      let cards = selectedCards || await learn.practiceCards(owner, step.card_ids);
      if (examples.size && step.mode === 'fill') cards = cards.map(card => {
        const example = examples.get(card.en);
        return example ? { ...card, context: example.sentence, context_zh: example.zh, context_source: 'generated' } : card;
      });
      if (cards.length) steps.push({ mode: step.mode, cards });
    }
    if (!steps.length) return { empty: true };
    const words = new Set(steps.flatMap(step => step.cards.map(card => card.id))).size;
    return { plan: { id, kind: plan.kind, title: plan.title, steps, words, minutes: plan.minutes }, stale: words !== saved.words };
  }

  return { selectWords, buildWordPlan, buildPlan, startPlan };
}

module.exports = { createLearnPlan, KINDS, TITLES, PlanError, WORD_SOURCES, hasPracticeContext };

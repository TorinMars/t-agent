// The practice plans of the English coach ("Practice plans" in docs/design/learn-english-coach.md): what a plan card offers and what its Start runs.
// A plan is built from the REAL queues of services/learn.js (queue, mistakeRows): this file only picks and orders cards that those give, so the
// numbers on a card are the server's, never the model's, and the scheduling rules stay in one place.
//
// buildPlan(owner, kind, { words?, count? }) -> { kind, title, steps: [{ mode, card_ids }], words, minutes, notes } (steps without cards are left out;
// words: the different cards in it). Kinds:
// - today_spelling: the spell queue (due words, then today's new ones), the words now in Mistakes first.
// - review: the review queue.
// - more_new_words: the next `count` (5) new words; the allowance is raised only when the person starts it (startPlan with `raise`).
// - dictation, fill_gap: the dictation and fill queues (sentences).
// - mistakes_series: the Mistakes queue as a series: 1 spell each wrong word (the most often wrong first), 2 fill the gap in the sentences (wrong
//   sentences and the person's sentences with a wrong word), 3 dictation of those sentences, or, without sentences, the worst words again, 4 a final
//   retest (the page keeps only the words missed again in the series).
// `words` (card ids or English texts) narrows a plan to those cards ("Practise the 3 I missed").
const { normalize } = require('./learn');

const KINDS = ['today_spelling', 'review', 'mistakes_series', 'more_new_words', 'dictation', 'fill_gap'];
const SECONDS = { spell: 20, review: 12, fill: 30, dictation: 40, retest: 15 };
const TITLES = {
  today_spelling: "Today's spelling", review: 'Review', mistakes_series: 'Your mistakes', more_new_words: 'New words', dictation: 'Dictation', fill_gap: 'Fill the gap',
};
const MAX_CARDS = 50;
const MAX_SENTENCES = 10;
const WORST = 5;

class PlanError extends Error { constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; } }

function createLearnPlan({ db, learn }) {
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
  const queueIds = async (owner, mode, limit, extra) => (await learn.queue(owner, mode, limit, extra ? { extra } : {})).cards.map(card => card.id);

  // The wrong answers of each card (all of them), for the order of a mistakes series.
  function wrongCounts(owner) {
    return new Map(db.prepare('SELECT card_id, COUNT(*) AS wrong, MAX(at) AS last FROM learn_reviews WHERE owner = ? AND correct = 0 GROUP BY card_id').all(owner)
      .map(row => [row.card_id, { wrong: row.wrong, last: row.last }]));
  }
  // The person's sentence cards that contain one of these words (as a whole word), at most MAX_SENTENCES, the most recent first.
  function sentencesWith(owner, wordRows, exclude) {
    if (!wordRows.length) return [];
    const patterns = wordRows.map(row => new RegExp(`\\b${row.norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    const out = [];
    for (const row of db.prepare("SELECT * FROM learn_cards WHERE owner = ? AND kind = 'sentence' AND suspended = 0 ORDER BY created_at DESC, id DESC LIMIT 2000").all(owner)) {
      if (out.length >= MAX_SENTENCES) break;
      if (!exclude.has(row.id) && patterns.some(pattern => pattern.test(row.en))) out.push(row);
    }
    return out;
  }

  async function buildPlan(owner, kind, { words = null, count = null } = {}) {
    if (!KINDS.includes(kind)) throw new PlanError('Unknown practice plan');
    const named = namedCards(owner, words);
    if (kind === 'mistakes_series') return mistakesSeries(owner, named, limitOf(count, 12));
    if (named) {
      // A plan of the cards named: each in the exercise of its kind for this plan.
      const mode = kind === 'review' ? 'review' : kind === 'dictation' ? 'dictation' : kind === 'fill_gap' ? 'fill' : 'spell';
      const fit = named.filter(row => mode === 'review' || (mode === 'spell' ? row.kind === 'word' : row.kind === 'sentence'));
      return finish(kind, [{ mode, card_ids: fit.map(row => row.id) }]);
    }
    if (kind === 'today_spelling') {
      const ids = await queueIds(owner, 'spell', limitOf(count, MAX_CARDS));
      const wrong = new Set(learn.mistakeRows(owner, learn.settings(owner).starter).map(row => row.id));
      const first = ids.filter(id => wrong.has(id));
      return finish(kind, [{ mode: 'spell', card_ids: [...first, ...ids.filter(id => !wrong.has(id))] }], first.length ? `${first.length} words you got wrong come first` : '', { wrong_first: first.length });
    }
    if (kind === 'review') return finish(kind, [{ mode: 'review', card_ids: await queueIds(owner, 'review', limitOf(count, 20)) }]);
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
    const wrongSentences = ordered.filter(row => row.kind === 'sentence');
    const sentences = [...wrongSentences, ...sentencesWith(owner, wordRows, new Set(wrongSentences.map(row => row.id)))].slice(0, MAX_SENTENCES);
    // The worst words come back once more when there are no sentences to hear them in.
    const worst = wordRows.filter(row => wrongOf(row).wrong >= 2).slice(0, WORST);
    const steps = [
      { mode: 'spell', card_ids: wordRows.map(row => row.id) },
      { mode: 'fill', card_ids: sentences.map(row => row.id) },
      { mode: 'dictation', card_ids: (sentences.length ? sentences : worst).map(row => row.id) },
      { mode: 'retest', card_ids: wordRows.map(row => row.id) },
    ];
    return finish('mistakes_series', steps, wordRows.length ? 'Each word comes back in another exercise; words missed again are retested at the end' : '');
  }

  // POST /coach/plans/start: the plan read again now, with the full queue cards of each step. `raise`: more_new_words raises today's allowance
  // first (once, when the person starts it). Returns { plan: { id, kind, title, steps: [{ mode, cards }], words, minutes }, stale } or { empty: true }.
  async function startPlan(owner, saved, { id, raise = false } = {}) {
    if (saved.kind === 'more_new_words' && raise) learn.addNewWords(owner, { count: saved.count || 5 });
    let plan;
    if (saved.kind === 'more_new_words' && raise) {
      // The new words the raised allowance gives now.
      const cards = (await learn.queue(owner, 'spell', 100)).cards.filter(card => card.is_new).slice(0, saved.count || 5);
      plan = finish('more_new_words', [{ mode: 'spell', card_ids: cards.map(card => card.id) }], '', { count: saved.count || 5 });
    } else plan = await buildPlan(owner, saved.kind, { words: saved.words_list && saved.words_list.length ? saved.words_list : null, count: saved.count || null });
    const steps = [];
    for (const step of plan.steps) {
      const cards = await learn.practiceCards(owner, step.card_ids);
      if (cards.length) steps.push({ mode: step.mode, cards });
    }
    if (!steps.length) return { empty: true };
    const words = new Set(steps.flatMap(step => step.cards.map(card => card.id))).size;
    return { plan: { id, kind: plan.kind, title: plan.title, steps, words, minutes: plan.minutes }, stale: words !== saved.words };
  }

  return { buildPlan, startPlan };
}

module.exports = { createLearnPlan, KINDS, TITLES, PlanError };

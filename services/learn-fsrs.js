// FSRS-6, the Free Spaced Repetition Scheduler ("Review rules" in docs/design/learn-review-fsrs.md): pure functions, no database, no clock, no fuzz.
//
// The formulas and the 21 default weights are those of the reference implementation ts-fsrs v5.4.2 ("v5.4.2 using FSRS-6.0";
// https://github.com/open-spaced-repetition/ts-fsrs/blob/v5.4.2/packages/fsrs/src/algorithm.ts and src/constant.ts), the same model as the
// fsrs4anki wiki "The Algorithm" (FSRS-6) and fsrs-rs. Every intermediate value is rounded to 8 decimals where ts-fsrs rounds it (roundTo), so the
// results equal the reference to the last digit (test/learn-fsrs.test.js runs its test vectors). Days are real numbers; ratings 1 again, 2 hard,
// 3 good, 4 easy (this app gives 1 to 3, services/learn-review.js).
//
// - Forgetting curve:      R(t, S) = (1 + factor * t / S) ^ decay, decay = -w20, factor = 0.9 ^ (1 / decay) - 1 (so R(S, S) = 0.9).
// - Interval:              I(r, S) = S / factor * (r ^ (1 / decay) - 1), whole days, at least 1, at most the maximum.
// - First answer:          S0(G) = w[G-1] (at least 0.1); D0(G) = w4 - e^(w5 * (G - 1)) + 1, clamped to [1, 10].
// - Difficulty:            D' = w7 * D0(4) + (1 - w7) * (D + linear damping(-w6 * (G - 3), D)), clamped to [1, 10]; damping = delta * (10 - D) / 9.
// - Recall (G >= 2):       S' = S * (1 + e^w8 * (11 - D) * S^-w9 * (e^(w10 * (1 - R)) - 1) * (w15 if hard) * (w16 if easy)).
// - Forgetting (G = 1):    S' = w11 * D^-w12 * ((S + 1)^w13 - 1) * e^(w14 * (1 - R)), at most S / e^(w17 * w18) (the FSRS-6 cap).
// - Same day (t = 0):      S' = S * S^-w19 * e^(w17 * (G - 3 + w18)), never below S for hard or good.
// Stability is kept within [0.001, 36500] days.
const VERSION = 'FSRS-6 (ts-fsrs 5.4.2)';
const DEFAULT_W = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
  0.0912, 0.0658, 0.1542,
]);
const S_MIN = 0.001;
const S_MAX = 36500;
const MAX_INTERVAL = 36500;
const RATINGS = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });

const roundTo = (value, decimals = 8) => { const factor = 10 ** decimals; return Math.round(value * factor) / factor; };
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function checkWeights(w) {
  if (!Array.isArray(w) || w.length !== 21 || !w.every(Number.isFinite)) throw new Error('FSRS needs 21 finite weights');
  return w;
}

// decay = -w20 and the factor that makes R(S, S) = 0.9 (as ts-fsrs computeDecayFactor).
function decayFactor(w = DEFAULT_W) {
  const decay = -w[20];
  const factor = Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1.0;
  return { decay, factor: roundTo(factor, 8) };
}

// The probability of recall after `t` days with stability `s`.
function retrievability(t, s, w = DEFAULT_W) {
  const { decay, factor } = decayFactor(w);
  return roundTo(Math.pow(1 + (factor * t) / s, decay), 8);
}

// The interval for a stability of 1 day at the desired retention `r` (0 < r <= 1); 1 at r = 0.9.
function intervalModifier(r, w = DEFAULT_W) {
  if (!(r > 0 && r <= 1)) throw new Error('The desired retention must be in (0, 1]');
  const { decay, factor } = decayFactor(w);
  return roundTo((Math.pow(r, 1 / decay) - 1) / factor, 8);
}

// The next interval in whole days for stability `s` at retention `r`: at least 1, at most `maxInterval` (no fuzz).
function nextInterval(s, r, { w = DEFAULT_W, maxInterval = MAX_INTERVAL } = {}) {
  return Math.min(Math.max(1, Math.round(s * intervalModifier(r, w))), maxInterval);
}

const initStability = (g, w = DEFAULT_W) => Math.max(w[g - 1], 0.1);
// Not clamped: the mean reversion uses D0(4) as it is; nextState clamps a first difficulty.
const initDifficulty = (g, w = DEFAULT_W) => roundTo(w[4] - Math.exp((g - 1) * w[5]) + 1, 8);
const linearDamping = (delta, d) => roundTo((delta * (10 - d)) / 9, 8);
const meanReversion = (init, current, w = DEFAULT_W) => roundTo(w[7] * init + (1 - w[7]) * current, 8);

function nextDifficulty(d, g, w = DEFAULT_W) {
  const delta = -w[6] * (g - 3);
  const next = d + linearDamping(delta, d);
  return clamp(meanReversion(initDifficulty(RATINGS.easy, w), next, w), 1, 10);
}

function recallStability(d, s, r, g, w = DEFAULT_W) {
  const hardPenalty = g === RATINGS.hard ? w[15] : 1;
  const easyBonus = g === RATINGS.easy ? w[16] : 1;
  return roundTo(clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus), S_MIN, S_MAX), 8);
}

// Before the FSRS-6 cap (nextState applies it).
function forgetStability(d, s, r, w = DEFAULT_W) {
  return roundTo(clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX), 8);
}

function shortTermStability(s, g, w = DEFAULT_W) {
  const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
  const masked = g >= RATINGS.hard ? Math.max(sinc, 1.0) : sinc;
  return roundTo(clamp(s * masked, S_MIN, S_MAX), 8);
}

// The memory state after an answer with rating `g` (1..4) `t` days (whole days, >= 0) after the previous one: { stability, difficulty }. `state`
// null: the first answer of a card. `shortTerm` false: the long-term model (no same-day formula, the forgetting cap is S), as ts-fsrs
// enable_short_term false. Mirrors ts-fsrs FSRSAlgorithm.next_state (without the manual rating 0).
function nextState(state, t, g, { w = DEFAULT_W, shortTerm = true } = {}) {
  checkWeights(w);
  if (!Number.isFinite(t) || t < 0) throw new Error(`Invalid elapsed days: ${t}`);
  if (![1, 2, 3, 4].includes(g)) throw new Error(`Invalid rating: ${g}`);
  if (!state) return { stability: initStability(g, w), difficulty: clamp(initDifficulty(g, w), 1, 10) };
  const { stability: s, difficulty: d } = state;
  if (!(d >= 1) || !(s >= S_MIN)) throw new Error(`Invalid memory state: stability ${s}, difficulty ${d}`);
  const r = retrievability(t, s, w);
  let stability;
  if (t === 0 && shortTerm) stability = shortTermStability(s, g, w);
  else if (g === RATINGS.again) {
    const floor = shortTerm ? s / Math.exp(w[17] * w[18]) : s;
    stability = clamp(roundTo(floor, 8), S_MIN, forgetStability(d, s, r, w));
  } else stability = recallStability(d, s, r, g, w);
  return { stability, difficulty: nextDifficulty(d, g, w) };
}

module.exports = {
  VERSION, DEFAULT_W, S_MIN, S_MAX, MAX_INTERVAL, RATINGS, roundTo, clamp, decayFactor, retrievability, intervalModifier, nextInterval,
  initStability, initDifficulty, linearDamping, meanReversion, nextDifficulty, recallStability, forgetStability, shortTermStability, nextState,
};

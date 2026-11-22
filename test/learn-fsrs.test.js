// FSRS-6 (services/learn-fsrs.js; "Review rules" in docs/design/learn-review-fsrs.md) against the test vectors of the reference implementation
// ts-fsrs v5.4.2: packages/fsrs/__tests__/algorithm.test.ts (the single formulas with the default weights), __tests__/FSRS-6.test.ts (the first
// answer and a memory state from fsrs-rs) and __tests__/impl/long-term_scheduler.test.ts (whole sequences of ratings with their intervals,
// stability and difficulty, with the FSRS-5 weights of that test and the long-term model). Pure functions: no database, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsrs = require('../services/learn-fsrs');

const { DEFAULT_W, nextState, nextInterval } = fsrs;

test('the default weights are the 21 of FSRS-6 in ts-fsrs 5.4.2', () => {
  assert.deepEqual([...DEFAULT_W], [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
    0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]);
  assert.match(fsrs.VERSION, /FSRS-6/);
  assert.ok(Object.isFrozen(DEFAULT_W), 'frozen');
});

test('the forgetting curve with the w20 decay (algorithm.test.ts "retrievability")', () => {
  assert.deepEqual([0, 1, 2, 3].map(t => fsrs.retrievability(t, 1.0)), [1.0, 0.9, 0.84588465, 0.8093881]);
  // R(S, S) = 0.9 for any stability: the factor is chosen so.
  for (const s of [0.5, 3, 40, 365]) assert.equal(fsrs.retrievability(s, s), 0.9);
  // The FSRS-5 decay (0.5) gives the older curve: (1 + 19/81 * t / S) ^ -0.5.
  const w5 = [...DEFAULT_W.slice(0, 20), 0.5];
  assert.equal(fsrs.retrievability(10, 10, w5), 0.9);
  assert.equal(fsrs.retrievability(20, 10, w5), fsrs.roundTo(Math.pow(1 + (19 / 81) * 2, -0.5), 8));
});

test('the first answer: S0 = w[G-1], D0 = w4 - e^(w5 (G-1)) + 1 clamped to [1, 10] (FSRS-6.test.ts "first repeat")', () => {
  const states = [1, 2, 3, 4].map(g => nextState(null, 0, g));
  assert.deepEqual(states.map(state => state.stability), [0.212, 1.2931, 2.3065, 8.2956]);
  assert.deepEqual(states.map(state => state.difficulty), [6.4133, 5.11217071, 2.11810397, 1]);
});

test('the next difficulty with linear damping and mean reversion (algorithm.test.ts "next_difficulty")', () => {
  assert.deepEqual([1, 2, 3, 4].map(g => fsrs.nextDifficulty(5.0, g)), [8.34176237, 6.66599536, 4.99022837, 3.31446137]);
});

test('stability after recall, after forgetting and on the same day (algorithm.test.ts "next_stability")', () => {
  const s = [5, 5, 5, 5];
  const d = [1, 2, 3, 4];
  const r = [0.9, 0.8, 0.7, 0.6];
  assert.deepEqual([1, 2, 3, 4].map((g, i) => fsrs.recallStability(d[i], s[i], r[i], g)), [25.60252118, 28.22657096, 58.65599107, 127.2266925]);
  assert.deepEqual([1, 2, 3, 4].map((g, i) => fsrs.forgetStability(d[i], s[i], r[i])), [1.05253961, 1.18943295, 1.36808387, 1.58498896]);
  assert.deepEqual([1, 2, 3, 4].map((g, i) => fsrs.shortTermStability(s[i], g)), [1.596818, 5, 5, 8.12960956]);
});

test('the interval for a desired retention, whole days, at least 1 (algorithm.test.ts "next_ivl")', () => {
  const retentions = Array.from({ length: 10 }, (_, i) => (i + 1) / 10);
  assert.deepEqual(retentions.map(r => nextInterval(1.0, r, { maxInterval: Number.MAX_VALUE })), [3116766 + 3, 34793, 2508, 387, 90, 27, 9, 3, 1, 1]);
  assert.equal(fsrs.intervalModifier(0.9), 1);
  assert.equal(nextInterval(1e6, 0.9, { maxInterval: 365 }), 365, 'capped');
  assert.equal(nextInterval(0.2, 0.95), 1, 'at least a day');
  assert.ok(nextInterval(30, 0.95) < nextInterval(30, 0.9) && nextInterval(30, 0.9) < nextInterval(30, 0.85), 'a higher retention gives shorter intervals');
  assert.throws(() => fsrs.intervalModifier(0), /retention/);
});

test('a memory state from fsrs-rs: again, good x5 at 0, 0, 1, 3, 8, 21 days (FSRS-6.test.ts "memory state")', () => {
  const ratings = [1, 3, 3, 3, 3, 3];
  const intervals = [0, 0, 1, 3, 8, 21];
  for (const [shortTerm, stability] of [[true, 53.62691], [false, 53.335106]]) {
    let state = null;
    ratings.forEach((g, i) => { state = nextState(state, intervals[i], g, { shortTerm }); });
    assert.ok(Math.abs(state.stability - stability) < 5e-5, `${shortTerm ? 'short' : 'long'}-term stability ${state.stability}`);
    assert.ok(Math.abs(state.difficulty - 6.3574867) < 5e-5, `difficulty ${state.difficulty}`);
  }
});

test('the FSRS-6 cap after forgetting: never above S / e^(w17 w18), and never below 0.001', () => {
  const state = { stability: 2, difficulty: 3 };
  const next = nextState(state, 5, 1);
  const cap = fsrs.roundTo(2 / Math.exp(DEFAULT_W[17] * DEFAULT_W[18]), 8);
  const plain = fsrs.forgetStability(3, 2, fsrs.retrievability(5, 2));
  assert.equal(next.stability, Math.min(cap, plain));
  assert.ok(next.stability <= cap);
  // The long-term model caps at S itself.
  assert.ok(nextState({ stability: 0.5, difficulty: 1 }, 1, 1, { shortTerm: false }).stability <= 0.5);
});

test('bad input is refused', () => {
  assert.throws(() => nextState(null, -1, 3), /elapsed/);
  assert.throws(() => nextState(null, 0, 5), /rating/);
  assert.throws(() => nextState({ stability: 0, difficulty: 5 }, 1, 3), /memory state/);
  assert.throws(() => nextState(null, 0, 3, { w: [1, 2] }), /21/);
});

// The long-term scheduler of ts-fsrs (src/impl/long_term_scheduler.ts) on top of nextState: every answer is a review; the four intervals are kept in
// order (again <= hard < good < easy) and the next answer comes on the due day. The weights of its test (FSRS-5, 19 numbers: w19 = 0, decay 0.5).
const W5 = [0.4197, 1.1869, 3.0412, 15.2441, 7.1434, 0.6477, 1.0007, 0.0674, 1.6597, 0.1712, 1.1178, 2.0225, 0.0904, 0.3025, 2.1214, 0.2498, 2.9466,
  0.4891, 0.6468, 0.0, 0.5];
function longTerm(ratings) {
  let state = null;
  let t = 0;
  const out = { ivl: [], s: [], d: [] };
  for (const rating of ratings) {
    const next = [1, 2, 3, 4].map(g => nextState(state, t, g, { w: W5, shortTerm: false }));
    const ivl = next.map(item => nextInterval(item.stability, 0.9, { w: W5 }));
    ivl[0] = Math.min(ivl[0], ivl[1]);
    ivl[1] = Math.max(ivl[1], ivl[0] + 1);
    ivl[2] = Math.max(ivl[2], ivl[1] + 1);
    ivl[3] = Math.max(ivl[3], ivl[2] + 1);
    state = next[rating - 1];
    t = ivl[rating - 1];
    out.ivl.push(t); out.s.push(state.stability); out.d.push(state.difficulty);
  }
  return out;
}

test('whole sequences of ratings (long-term_scheduler.test.ts test1 to test5)', () => {
  const cases = [
    [[3, 3, 3, 3, 3, 3, 1, 1, 3, 3, 3, 3, 3], [3, 13, 48, 155, 445, 1158, 17, 3, 11, 37, 112, 307, 773],
      [3.0412, 13.09130698, 48.15848988, 154.93732625, 445.05562739, 1158.07779739, 16.63063166, 3.01732209, 11.42247264, 37.37521902, 111.8752758,
        306.5974569, 772.94026648],
      [4.49094334, 4.26664289, 4.05746029, 3.86237659, 3.68044154, 3.51076891, 4.69833071, 5.55956298, 5.26323756, 4.98688448, 4.72915759, 4.4888015,
        4.26464541]],
    [[1, 2, 3, 4, 1, 2, 3, 4], [1, 2, 6, 41, 4, 7, 21, 133],
      [0.4197, 1.0344317, 5.5356759, 41.0033667, 4.46605519, 6.67743292, 20.88868155, 132.81849454],
      [7.1434, 7.03653841, 6.64066485, 5.92312772, 6.44779861, 6.45995078, 6.10293922, 5.36588547]],
    [[2, 3, 4, 1, 2, 3, 4, 1], [2, 7, 54, 5, 8, 26, 171, 8],
      [1.1869, 6.59167572, 53.76078737, 5.0853693, 8.09786749, 25.52991279, 171.16195166, 8.11072373],
      [6.23225985, 5.89059466, 5.14583392, 5.884097, 5.99269555, 5.667177, 4.91430736, 5.71619151]],
    [[3, 4, 1, 2, 3, 4, 1, 2], [3, 33, 4, 7, 26, 193, 9, 14],
      [3.0412, 32.65484522, 4.22256838, 7.2325009, 25.52681746, 193.36618775, 8.63899847, 14.31323867],
      [4.49094334, 3.69538259, 4.83221448, 5.12078462, 4.85403286, 4.07165035, 5.1050878, 5.34697075]],
    [[4, 1, 2, 3, 4, 1, 2, 3], [15, 3, 6, 27, 240, 10, 17, 60],
      [15.2441, 3.25621013, 6.32684549, 26.56339029, 239.70462771, 9.75621519, 17.06035531, 59.59547542],
      [1.16304343, 2.99573557, 3.59851762, 3.43436666, 2.60045771, 4.03816348, 4.46259158, 4.24020203]],
  ];
  cases.forEach(([ratings, ivl, s, d], index) => {
    const got = longTerm(ratings);
    assert.deepEqual(got.ivl, ivl, `test${index + 1} intervals`);
    assert.deepEqual(got.s, s, `test${index + 1} stability`);
    assert.deepEqual(got.d, d, `test${index + 1} difficulty`);
  });
});

test('the same answers always give the same state (deterministic, no fuzz)', () => {
  const run = () => { let state = null; [3, 2, 1, 3, 3].forEach((g, i) => { state = nextState(state, [0, 2, 5, 0, 4][i], g); }); return state; };
  assert.deepEqual(run(), run());
});

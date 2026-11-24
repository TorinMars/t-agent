// Vibration on key taps (scripts/h5-shell/key-haptics.mjs): the strengths and their durations, the stored value and its default, and what a device
// can play. The real page (the Settings group, the keys of the key row and of the page's own keyboard) is scripts/test-h5-key-haptics-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'key-haptics.mjs')).href);
const memory = (initial = {}) => {
  const kept = new Map(Object.entries(initial));
  return { kept, getItem: key => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => { kept.set(key, String(value)); }, removeItem: key => { kept.delete(key); } };
};

test('four strengths in order, Off plays nothing, Light is the 8 ms of before and the default', async () => {
  const { STRENGTHS, DEFAULT_STRENGTH, durationOf, hapticsOn } = await load();
  assert.deepEqual(STRENGTHS.map(item => [item.id, item.label, item.ms]), [['off', 'Off', 0], ['light', 'Light', 8], ['medium', 'Medium', 15], ['strong', 'Strong', 28]]);
  assert.deepEqual(STRENGTHS.map(item => item.note), ['No vibration', 'A short tap (as today)', 'A firmer tap', 'A clear buzz']);
  assert.equal(DEFAULT_STRENGTH, 'light');
  assert.equal(durationOf('off'), 0);
  assert.equal(durationOf('strong'), 28);
  for (const value of [undefined, null, '', 'loud', 'toString', 15]) assert.equal(durationOf(value), 8, `${String(value)} is the default`);
  assert.equal(hapticsOn('off'), false);
  assert.equal(hapticsOn('medium'), true);
});

test('the stored value: read with its default, written as one of the strengths, never throws', async () => {
  const { HAPTICS_KEY, readStrength, writeStrength } = await load();
  assert.equal(HAPTICS_KEY, 'h5-key-haptics');
  const store = memory();
  assert.equal(readStrength(store), 'light', 'nothing stored: Light');
  assert.equal(writeStrength('strong', store), true);
  assert.equal(store.kept.get(HAPTICS_KEY), 'strong');
  assert.equal(readStrength(store), 'strong');
  writeStrength('off', store);
  assert.equal(readStrength(store), 'off');
  assert.equal(readStrength(memory({ [HAPTICS_KEY]: 'buzz' })), 'light', 'an unknown value is the default');
  writeStrength('nonsense', store);
  assert.equal(store.kept.get(HAPTICS_KEY), 'light', 'only a strength is kept');
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readStrength(broken), 'light');
  assert.equal(writeStrength('medium', broken), false);
  // Without a registry (a unit test, a harness that loads the shell alone) nothing is kept and the default is used.
  assert.equal(readStrength(), 'light');
  assert.equal(writeStrength('medium'), false);
});

test('what a device can play: Android vibrates, an iPhone has the switch, a computer neither', async () => {
  const { hapticKind } = await load();
  const doc = withSwitch => ({ createElement: () => (withSwitch ? { switch: false } : {}) });
  const vibrate = () => true;
  assert.equal(hapticKind({ navigator: { maxTouchPoints: 5, vibrate }, document: doc(false) }), 'vibrate', 'Android');
  assert.equal(hapticKind({ navigator: { maxTouchPoints: 5 }, document: doc(true) }), 'switch', 'iPhone / iPad (iOS 17.4+)');
  assert.equal(hapticKind({ navigator: { maxTouchPoints: 5 }, document: doc(false) }), 'none', 'an older iPhone');
  assert.equal(hapticKind({ navigator: { maxTouchPoints: 0, vibrate }, document: doc(false) }), 'none', 'desktop Chrome: navigator.vibrate without a touch screen');
  assert.equal(hapticKind({ navigator: { maxTouchPoints: 0 }, document: doc(true) }), 'none', 'Safari on a Mac: the switch without a haptic');
  assert.equal(hapticKind({}), 'none');
  assert.equal(hapticKind(null), 'none');
  assert.equal(hapticKind({ navigator: { maxTouchPoints: 5 }, document: { createElement: () => { throw new Error('no'); } } }), 'none', 'never throws');
});

// The pure logic of the T-Attention first-run guide (scripts/h5-shell/guide-model.mjs): the three steps and their done state, from the JSON of
// GET /api/attention/plugins and GET /api/attention/settings/guide.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'guide-model.mjs')).href);
const claude = local => ({ name: 'claude', version: '1.0.0', local: { installable: true, ...local } });
const telegram = extra => ({ name: 'telegram', loaded: true, enabled: true, configured: true, test: true, customUi: 'telegram', ...extra });
const overview = ({ listeners = [claude({})], notifiers = [] } = {}) => ({ listeners, notifiers });
const done = state => state.steps.map(step => `${step.key}:${step.done ? step.how : '-'}`);

test('normalizeGuide makes every flag a boolean', async () => {
  const { normalizeGuide } = await load();
  assert.deepEqual(normalizeGuide(null), { dismissed: false, pageOnly: false, paired: false, tested: false });
  assert.deepEqual(normalizeGuide({ dismissed: 'yes', tested: true, extra: 1 }), { dismissed: false, pageOnly: false, paired: false, tested: true });
});

test('a fresh Client: nothing done, step 1 is open and the guide shows', async () => {
  const { guideState } = await load();
  const state = guideState(overview({ notifiers: [telegram({ configured: false })] }), {});
  assert.deepEqual(done(state), ['claude:-', 'notify:-', 'test:-']);
  assert.equal(state.current, 'claude');
  assert.equal(state.doneCount, 0);
  assert.equal(state.total, 3);
  assert.equal(state.show, true);
  assert.equal(state.allDone, false);
});

test('step 1 needs the hook path and the tool hooks on this machine; a used pairing code counts too', async () => {
  const { guideState, claudeConnected } = await load();
  assert.equal(claudeConnected(claude({ hookPath: true, toolHooks: false })), false);
  assert.equal(claudeConnected(claude({ hookPath: false, toolHooks: true })), false);
  assert.equal(claudeConnected({ ...claude({ hookPath: true, toolHooks: true }), error: 'Bad manifest' }), false);
  assert.equal(claudeConnected(null), false);
  assert.deepEqual(done(guideState(overview({ listeners: [claude({ hookPath: true, toolHooks: true })] }), {})).slice(0, 1), ['claude:here']);
  assert.deepEqual(done(guideState(overview({ listeners: [] }), { paired: true })).slice(0, 1), ['claude:paired']);
  assert.equal(guideState(overview({ listeners: [claude({ hookPath: true, toolHooks: true })] }), {}).current, 'notify');
});

test('step 2: a notifier that is on and set up, or "page only"; a disabled, unconfigured or broken one does not count', async () => {
  const { guideState, readyNotifiers, testableNotifiers, telegramNotifier } = await load();
  for (const notifier of [telegram({ enabled: false }), telegram({ configured: false }), telegram({ configured: null }), { name: 'broken', loaded: false, configured: true }]) {
    assert.equal(guideState(overview({ notifiers: [notifier] }), {}).steps[1].done, false, JSON.stringify(notifier));
  }
  const ready = overview({ notifiers: [telegram(), telegram({ name: 'quiet', test: false })] });
  assert.deepEqual(guideState(ready, {}).steps[1], { key: 'notify', title: 'Choose notifications', done: true, how: 'notifier', notifiers: ['telegram', 'quiet'] });
  assert.deepEqual(readyNotifiers(ready).map(n => n.name), ['telegram', 'quiet']);
  assert.deepEqual(testableNotifiers(ready).map(n => n.name), ['telegram'], 'a plugin without a test gets no test button');
  assert.equal(guideState(overview(), { pageOnly: true }).steps[1].how, 'pageOnly');
  assert.equal(telegramNotifier(overview({ notifiers: [telegram({ configured: false })] })).name, 'telegram');
  assert.equal(telegramNotifier(overview({ notifiers: [{ name: 'telegram', loaded: false }] })), null);
  assert.equal(telegramNotifier(null), null);
});

test('step 3 after one test worked; all done hides the guide; a closed guide does not show', async () => {
  const { guideState, doneLine } = await load();
  const all = overview({ listeners: [claude({ hookPath: true, toolHooks: true })], notifiers: [telegram()] });
  const state = guideState(all, { tested: true });
  assert.deepEqual(done(state), ['claude:here', 'notify:notifier', 'test:tested']);
  assert.equal(state.allDone, true);
  assert.equal(state.current, null);
  assert.equal(state.show, false);
  assert.equal(state.doneCount, 3);
  const closed = guideState(overview(), { dismissed: true });
  assert.equal(closed.show, false);
  assert.equal(closed.dismissed, true);
  assert.equal(closed.current, 'claude');
  assert.deepEqual(state.steps.map(doneLine), ['Claude Code on this machine reports here.', 'A notifier is on and set up.', 'A test worked.']);
  assert.equal(doneLine({ done: false, how: null }), '');
  assert.equal(doneLine({ done: true, how: 'paired' }), 'Another machine is connected.');
  assert.equal(doneLine({ done: true, how: 'pageOnly' }), 'Page and system notifications only.');
});

test('a broken overview answer gives a guide with nothing done', async () => {
  const { guideState } = await load();
  for (const data of [null, {}, { listeners: 'x', notifiers: [null, 3] }]) assert.deepEqual(done(guideState(data, null)), ['claude:-', 'notify:-', 'test:-']);
});

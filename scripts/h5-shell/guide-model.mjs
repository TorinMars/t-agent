// The pure logic of the T-Attention first-run guide (AttentionGuide.jsx): the three steps and whether each is done, from the JSON of
// GET /api/attention/plugins (the plugin overview) and GET /api/attention/settings/guide (services/attention-guide.js). No DOM, no requests,
// so test/guide-model.test.js runs it in Node. See "T-Attention first-run guide" in DESIGN.md.
import { normalizePlugins } from './plugins-model.mjs';

export const GUIDE_FLAGS = ['dismissed', 'pageOnly', 'paired', 'tested'];
export const STEP_KEYS = ['claude', 'notify', 'test'];
export const STEP_TITLES = { claude: 'Connect Claude', notify: 'Choose notifications', test: 'Send a test' };

// The guide flags, made safe: every flag a boolean (false when missing or not a boolean).
export function normalizeGuide(data) {
  const source = data && typeof data === 'object' ? data : {};
  return Object.fromEntries(GUIDE_FLAGS.map(flag => [flag, source[flag] === true]));
}

export const claudeListener = overview => normalizePlugins(overview).listeners.find(listener => listener.name === 'claude') || null;

// Step 1 is done when the claude listener is installed on the machine that runs this Client: the hook path is written and the tool hooks are in
// ~/.claude/settings.json. A pairing code that another machine used counts too (the overview only sees this machine).
export const claudeConnected = listener => Boolean(listener && !listener.error && listener.local && listener.local.hookPath && listener.local.toolHooks === true);

// The notifiers that send something: loaded, switched on and set up.
export const readyNotifiers = overview => normalizePlugins(overview).notifiers.filter(notifier => notifier.loaded !== false && notifier.enabled !== false && notifier.configured === true);

// The ready notifiers that have a test (POST /api/attention/plugins/:name/test).
export const testableNotifiers = overview => readyNotifiers(overview).filter(notifier => notifier.test !== false);

// The Telegram notifier when it is there and loaded ("Set up Telegram" opens its section under Notifications).
export const telegramNotifier = overview => normalizePlugins(overview).notifiers.find(notifier => notifier.name === 'telegram' && notifier.loaded !== false) || null;

// The steps in order: { key, title, done, how } with `how` the reason it is done (a key for the done line) or null.
export function guideSteps(overview, settings) {
  const flags = normalizeGuide(settings);
  const listener = claudeListener(overview);
  const ready = readyNotifiers(overview);
  const claude = claudeConnected(listener) ? 'here' : flags.paired ? 'paired' : null;
  const notify = ready.length ? 'notifier' : flags.pageOnly ? 'pageOnly' : null;
  const test = flags.tested ? 'tested' : null;
  return [
    { key: 'claude', title: STEP_TITLES.claude, done: Boolean(claude), how: claude },
    { key: 'notify', title: STEP_TITLES.notify, done: Boolean(notify), how: notify, notifiers: ready.map(notifier => notifier.name) },
    { key: 'test', title: STEP_TITLES.test, done: Boolean(test), how: test },
  ];
}

// Everything the guide draws: the steps, how many are done, the first open step and whether the guide shows by itself (not closed, not all done).
export function guideState(overview, settings) {
  const flags = normalizeGuide(settings);
  const steps = guideSteps(overview, flags);
  const doneCount = steps.filter(step => step.done).length;
  const open = steps.find(step => !step.done);
  const allDone = !open;
  return { steps, doneCount, total: steps.length, allDone, current: open ? open.key : null, dismissed: flags.dismissed, show: !flags.dismissed && !allDone };
}

// The line under a done step (English keys of public/js/i18n-zh-ui.js).
export function doneLine(step) {
  if (!step || !step.done) return '';
  if (step.how === 'here') return 'Claude Code on this machine reports here.';
  if (step.how === 'paired') return 'Another machine is connected.';
  if (step.how === 'notifier') return 'A notifier is on and set up.';
  if (step.how === 'pageOnly') return 'This page only.';
  if (step.how === 'tested') return 'A test worked.';
  return '';
}

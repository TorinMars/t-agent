// The pure logic of the "Plugins" section in Settings "T-Attention" (scripts/h5-shell/plugins-model.mjs): chips, activity line, setup steps and the
// per-status modes, from the JSON of GET /api/attention/plugins.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'plugins-model.mjs')).href);
const NOW = Date.parse('2026-11-08T12:00:00Z');
const listener = local => ({ name: 'claude', version: '1.0.0', description: 'Claude Code hooks', local });
const keys = chips => chips.map(chip => `${chip.key}:${chip.label}:${chip.tone}`);

test('normalizePlugins keeps two lists of objects with a name', async () => {
  const { normalizePlugins } = await load();
  assert.deepEqual(normalizePlugins(null), { listeners: [], notifiers: [] });
  assert.deepEqual(normalizePlugins({ listeners: 'x', notifiers: [null, 3, { name: 'telegram' }, { version: '1' }] }), { listeners: [], notifiers: [{ name: 'telegram' }, { version: '1', name: '?' }] });
});

test('relativeTime reads ISO and SQLite times and uses the task list words', async () => {
  const { relativeTime } = await load();
  const t = text => `[${text}]`;
  assert.equal(relativeTime('2026-11-08T11:59:40Z', { now: NOW, t }), '[Just now]');
  assert.equal(relativeTime('2026-11-08T11:55:00Z', { now: NOW, t }), '5 [min ago]');
  assert.equal(relativeTime('2026-11-08 09:00:00', { now: NOW, t }), '3 [h ago]', 'a SQLite time is UTC');
  assert.equal(relativeTime('2026-11-06T12:00:00.000Z', { now: NOW, t }), '2 [d ago]');
  assert.equal(relativeTime('2026-11-09T12:00:00Z', { now: NOW, t }), '[Just now]', 'a time in the future is not negative');
  assert.equal(relativeTime(null, { now: NOW }), '');
  assert.equal(relativeTime('not a time', { now: NOW }), '');
});

test('listener chips: installed, login, hooks synced or not, failed to load', async () => {
  const { listenerChips, listenerInstalled } = await load();
  const ready = listener({ hookPath: true, loggedIn: true, toolHooks: true, lastEventAt: null, itemCount: 0 });
  assert.equal(listenerInstalled(ready), true);
  assert.deepEqual(keys(listenerChips(ready)), ['installed:Installed:success', 'hooks:Hooks synced:success']);
  assert.deepEqual(keys(listenerChips(listener({ hookPath: true, loggedIn: false, toolHooks: false }))), ['installed:Not installed:warning', 'login:Not logged in:warning', 'hooks:Hooks not synced:warning']);
  assert.deepEqual(keys(listenerChips(listener({ hookPath: false, loggedIn: false, toolHooks: null }))), ['installed:Not installed:warning'], 'an unknown hook state shows no hooks chip');
  assert.deepEqual(keys(listenerChips({ name: 'broken', error: 'Bad manifest' })), ['error:Failed to load:error', 'installed:Not installed:warning']);
});

test('listener activity: open count and last event', async () => {
  const { listenerActivity } = await load();
  assert.equal(listenerActivity(listener({ itemCount: 3, lastEventAt: '2026-11-08T11:55:00Z' }), { now: NOW }), '3 open · Last event 5 min ago');
  assert.equal(listenerActivity(listener({ itemCount: 0, lastEventAt: null }), { now: NOW }), 'No open items · No events yet');
  const t = text => (text === '3 open' ? '3 OPEN' : text);
  assert.equal(listenerActivity(listener({ itemCount: 3 }), { now: NOW, t }), '3 OPEN · No events yet', 'the count sentence is one translatable text');
});

test('setup steps and the login command', async () => {
  const { setupSteps, loginCommand } = await load();
  assert.deepEqual(setupSteps(listener({ hookPath: false, loggedIn: false, toolHooks: null })), { login: true, sync: true });
  assert.deepEqual(setupSteps(listener({ hookPath: true, loggedIn: true, toolHooks: false })), { login: false, sync: true });
  assert.deepEqual(setupSteps(listener({ hookPath: true, loggedIn: true, toolHooks: true })), { login: false, sync: false });
  assert.deepEqual(setupSteps(listener({ hookPath: true, loggedIn: true, toolHooks: null })), { login: false, sync: false }, 'unknown hooks: nothing to ask');
  assert.equal(loginCommand('https://box.example:8080'), 't-attention login --url https://box.example:8080 --token <token>');
});

test('notifier chips: failed to load, configured, not configured, none', async () => {
  const { notifierChips } = await load();
  assert.deepEqual(keys(notifierChips({ name: 'x', loaded: false, error: 'boom', configured: true })), ['error:Failed to load:error'], 'a failed plugin shows only that');
  assert.deepEqual(keys(notifierChips({ name: 'telegram', loaded: true, configured: true })), ['configured:Configured:success']);
  assert.deepEqual(keys(notifierChips({ name: 'telegram', loaded: true, configured: false })), ['configured:Not configured:warning']);
  assert.deepEqual(notifierChips({ name: 'plain', loaded: true, configured: null }), []);
});

test('modes summary: the statuses that are not off, in the settings order', async () => {
  const { modesSummary } = await load();
  assert.equal(modesSummary({ review: 'message', waiting_user: 'call', done: 'off', failed: 'message' }), 'Needs you: Call · Failed: Message · Review: Message');
  assert.equal(modesSummary({ waiting_user: 'off', review: 'off' }), 'Sends nothing: every status is off');
  assert.equal(modesSummary({}), '');
  assert.equal(modesSummary(null), '');
  assert.equal(modesSummary({ waiting_user: 'call', later: 'message' }), 'Needs you: Call · later: Message', 'an unknown status comes last with its key');
  const t = text => ({ 'Needs you': 'NY', Call: 'C' })[text] || text;
  assert.equal(modesSummary({ waiting_user: 'call' }, { t }), 'NY: C');
});

test('installAction, canUninstall and showManualSteps follow the local state of an installable listener', async () => {
  const { installAction, canUninstall, showManualSteps } = await load();
  const ready = { hookPath: true, loggedIn: true, toolHooks: true, hooksCurrent: true, installable: true };
  assert.equal(installAction(listener(ready)), null, 'set up: nothing to do');
  assert.equal(installAction(listener({ ...ready, hooksCurrent: false })), 'update');
  assert.equal(installAction(listener({ ...ready, toolHooks: false })), 'install');
  assert.equal(installAction(listener({ ...ready, toolHooks: null })), 'install', 'an unreadable settings file: the install says why');
  assert.equal(installAction(listener({ ...ready, loggedIn: false })), 'install');
  assert.equal(installAction(listener({ ...ready, installable: false })), null);
  assert.equal(installAction({ ...listener(ready), error: 'broken' }), null);
  assert.equal(installAction(null), null);
  assert.equal(canUninstall(listener(ready)), true);
  assert.equal(canUninstall(listener({ installable: true, hookPath: false, toolHooks: false })), false);
  assert.equal(canUninstall(listener({ installable: true, hookPath: false, toolHooks: true })), true);
  assert.equal(canUninstall(listener({ hookPath: true })), false, 'no installer: no uninstall');
  assert.equal(showManualSteps(listener(ready)), false);
  assert.equal(showManualSteps(listener({ hookPath: false })), true);
});

test('installSummary, secondsLeft, countdownText and codeGroups', async () => {
  const { installSummary, secondsLeft, countdownText, codeGroups } = await load();
  const t = text => `[${text}]`;
  assert.equal(installSummary({ changed: true, client: 'written' }, { t }), '[Claude Code hooks added to ~/.claude/settings.json]; [a token "claude listener (this machine)" was made and saved].');
  assert.equal(installSummary({ changed: false, client: 'kept' }, { t }), '[The Claude Code hooks were already in place]; [the saved login still works].');
  assert.equal(installSummary(null), '');
  assert.equal(secondsLeft('2026-11-08T12:10:00.000Z', NOW), 600);
  assert.equal(secondsLeft('2026-11-08T12:00:00.500Z', NOW), 1);
  assert.equal(secondsLeft('2026-11-08T11:00:00Z', NOW), 0);
  assert.equal(secondsLeft(undefined, NOW), 0);
  assert.equal(countdownText(545), '9:05');
  assert.equal(countdownText(0), '0:00');
  assert.equal(countdownText(-3), '0:00');
  assert.equal(codeGroups('123456'), '123 456');
  assert.equal(codeGroups('12'), '12');
});

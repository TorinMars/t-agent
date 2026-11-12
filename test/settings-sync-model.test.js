// The model behind the scope labels of the settings sheet (scripts/h5-shell/settings-sync.mjs): which label a part gets, the details line, the
// outcome of a shared save and the peer status line. The real sheet is scripts/test-h5-settings-scope-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'settings-sync.mjs')).href);
const NOW = Date.parse('2026-11-12T10:00:00Z');
const answer = (extra = {}) => ({
  supported: true,
  scopes: { translate: 'shared', workdir: 'device', telegram: 'telegram', bogus: 'everywhere' },
  keys: [
    { key: 'translate', scope: 'shared', updated_at: '2026-11-12T09:55:00Z', updated_by_name: 'K01', synced_peers: ['K01'], pending_peers: [] },
    { key: 'oss', scope: 'shared', updated_at: '2026-11-12T09:59:00Z', updated_by_name: 'Mac', synced_peers: [], pending_peers: ['K02'] },
  ],
  peers: [{ name: 'K01', online: true, supported: true, last_sync_at: '2026-11-12T09:58:00Z', last_error: null }, { name: 'K02', online: false, supported: true, last_sync_at: null, last_error: null }],
  ...extra,
});

test('labels show only for a server that knows settings sync and has a linked device', async () => {
  const { normalizeSync, labelsShown } = await load();
  assert.equal(labelsShown(normalizeSync(null)), false, 'an older server (404)');
  assert.equal(labelsShown(normalizeSync({ supported: false })), false);
  assert.equal(labelsShown(normalizeSync(answer({ peers: [] }))), false, 'one machine: nothing to tell apart');
  assert.equal(labelsShown(normalizeSync(answer())), true);
});

test('the scope comes from the server, else from the page; unknown scopes are dropped', async () => {
  const { normalizeSync, scopeOf, scopeText, scopeTitle } = await load();
  const sync = normalizeSync(answer());
  assert.equal(scopeOf(sync, 'translate', 'device'), 'shared');
  assert.equal(scopeOf(sync, 'bogus', 'device'), 'device');
  assert.equal(scopeOf(sync, null, 'device'), 'device');
  assert.equal(scopeText('shared'), 'Shared across devices');
  assert.equal(scopeText('device'), 'This device only');
  assert.equal(scopeText('telegram'), 'Telegram: one device sends');
  assert.equal(scopeText('telegram', normalizeSync(answer({ telegram: { sender_name: 'K01' } })).sender), 'Sent through K01');
  assert.equal(scopeText('telegram', normalizeSync(answer({ telegram: { sender_name: 'K01', self: false, conflict: false } })).telegram), 'Sent through K01');
  assert.equal(scopeText('telegram', normalizeSync(answer({ telegram: { sender_name: 'T01', self: true, conflict: false } })).telegram), 'Sent through this device (T01)');
  assert.equal(scopeText('telegram', normalizeSync(answer({ telegram: { sender_name: 'T01', self: true, conflict: true } })).telegram), 'Telegram: choose a sender');
  assert.equal(scopeText('telegram', normalizeSync(answer({ telegram: null })).telegram), 'Telegram: one device sends', 'nobody has Telegram');
  assert.equal(scopeText('telegram', normalizeSync(answer()).telegram), 'Telegram: one device sends', 'an older server says nothing');
  assert.equal(scopeText('telegram', normalizeSync(null).telegram), 'Telegram: one device sends');
  assert.equal(scopeTitle('shared'), 'Changes here are copied to every linked device');
  assert.equal(scopeTitle('device'), 'Only this device uses this');
});

test('the details line names the devices still waiting, or the other device that changed it last', async () => {
  const { normalizeSync, detailLine } = await load();
  const sync = normalizeSync(answer());
  assert.equal(detailLine(sync, 'translate', { now: NOW }), 'Changed on K01, 5 min ago');
  assert.equal(detailLine(sync, 'oss', { now: NOW }), 'Waiting to reach K02');
  assert.equal(detailLine(sync, 'voice', { now: NOW }), '', 'no entry, nothing to say');
  const recent = normalizeSync(answer({ keys: [{ key: 'translate', updated_at: '2026-11-12T09:59:50Z', updated_by_name: 'K01', pending_peers: [] }] }));
  assert.equal(detailLine(recent, 'translate', { now: NOW }), 'Changed on K01 just now');
  const mine = normalizeSync(answer({ keys: [{ key: 'translate', updated_at: '2026-11-12T09:55:00Z', updated_by_name: 'Mac', pending_peers: [] }] }));
  assert.equal(detailLine(mine, 'translate', { now: NOW }), '', 'a change made here is not news');
  const nested = normalizeSync(answer({ keys: [{ key: 'notify-rules.quiet', updated_at: '2026-11-12T09:00:00Z', pending_peers: ['K01'] }, { key: 'notify-rules.limits', updated_at: '2026-11-12T09:30:00Z', pending_peers: ['K01', 'K02'] }] }));
  assert.equal(detailLine(nested, 'notify-rules', { now: NOW }), 'Waiting to reach K01, K02', 'keys under one setting are merged');
});

test('a shared save is copied, waits for an offline device, or is too early to tell', async () => {
  const { normalizeSync, saveOutcome, outcomeText } = await load();
  const before = '2026-11-12T09:55:00Z';
  const same = normalizeSync(answer());
  assert.equal(saveOutcome(same, 'translate', { before, attempt: 0 }), null, 'the first look may not know the save yet');
  assert.deepEqual(saveOutcome(same, 'translate', { before, attempt: 1 }), { state: 'copied', peers: [] });
  const fresh = normalizeSync(answer({ keys: [{ key: 'translate', updated_at: '2026-11-12T10:00:00Z', pending_peers: [] }] }));
  assert.equal(saveOutcome(fresh, 'translate', { before, attempt: 0 }).state, 'copied');
  const offline = normalizeSync(answer({ keys: [{ key: 'translate', updated_at: '2026-11-12T10:00:00Z', pending_peers: ['K02'] }] }));
  const waiting = saveOutcome(offline, 'translate', { before, attempt: 0 });
  assert.deepEqual(waiting, { state: 'waiting', peers: ['K02'], offline: true });
  assert.equal(outcomeText(waiting), 'Will be copied when K02 is online');
  const online = normalizeSync(answer({ keys: [{ key: 'translate', updated_at: '2026-11-12T10:00:00Z', pending_peers: ['K01'] }] }));
  assert.equal(saveOutcome(online, 'translate', { before, attempt: 2 }), null, 'an online device gets until the last look');
  assert.equal(outcomeText(saveOutcome(online, 'translate', { before, attempt: 4, last: true })), 'Waiting to reach K01');
  assert.equal(outcomeText({ state: 'copied' }), 'Copied to linked devices');
  assert.equal(outcomeText({ state: 'copying' }), 'Copying to linked devices…');
});

test('the status of a peer: online, last sync, older version, error', async () => {
  const { normalizeSync, peerStatus } = await load();
  const [k01, k02] = normalizeSync(answer()).peers;
  assert.equal(peerStatus(k01, { now: NOW }), 'Online · Synced 2 min ago');
  assert.equal(peerStatus(k02, { now: NOW }), 'Offline · Not synced yet');
  assert.equal(peerStatus({ ...k01, last_sync_at: '2026-11-12T09:59:50Z' }, { now: NOW }), 'Online · Synced just now');
  assert.equal(peerStatus({ ...k01, supported: false }, { now: NOW }), 'Online · Needs an update to share settings');
  assert.equal(peerStatus({ ...k01, last_error: 'HTTP 502' }, { now: NOW }), 'Online · Synced 2 min ago · Error: HTTP 502');
});

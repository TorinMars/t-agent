// The pure logic of the plugin marketplace page (scripts/h5-shell/market-model.mjs): the listing entries with badges and actions, the search
// and kind filter, the Git URL and index source checks, the prepare / remove requests and the install preview with its expiry.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'market-model.mjs')).href);
const NOW = Date.parse('2026-11-08T12:00:00Z');

const ANSWER = {
  plugins: [
    { name: 'telegram', kind: 'notifier', description: 'Telegram messages and calls', version: '1.2.0', builtIn: true, installed: true, origin: 'builtin', tags: ['chat'] },
    { name: 'slack', kind: 'notifier', description: 'Slack messages', version: '0.3.0', author: 'Ann', tags: ['chat', 'work'], installed: false, origin: null, homepage: 'https://example.test/slack' },
    { name: 'codex', kind: 'listener', description: 'Codex hooks', version: '2.0.0', installed: true, installedVersion: '1.0.0', origin: 'index', updateAvailable: true },
    'junk',
  ],
  installed: [
    { name: 'codex', kind: 'listener', version: '1.0.0', origin: 'index' },
    { name: 'mine', kind: 'notifier', version: '0.0.1', description: 'My dev notifier', origin: 'link', dev: true, source: { type: 'link', url: '/home/me/mine' } },
    { name: 'gitty', kind: 'listener', version: '0.1.0', origin: 'git', source: { type: 'git', url: 'https://example.test/g.git', commit: 'abc' }, updateAvailable: true },
  ],
  sources: [{ url: 'https://raw.example.test/marketplace.json', official: true, ok: true }, { url: 'https://other.test/index.json', ok: false, stale: true, error: 'INDEX_UNAVAILABLE' }],
};

test('normalizeMarket merges the index entries with user plugins that no index lists, and reports failed sources', async () => {
  const { normalizeMarket } = await load();
  const market = normalizeMarket(ANSWER);
  assert.deepEqual(market.plugins.map(entry => entry.name), ['telegram', 'slack', 'codex', 'mine', 'gitty'], 'a non-object entry is dropped');
  const mine = market.plugins.find(entry => entry.name === 'mine');
  assert.equal(mine.installed, true);
  assert.equal(mine.inIndex, false);
  assert.equal(mine.dev, true);
  assert.equal(mine.installedVersion, '0.0.1');
  assert.deepEqual(market.errors, ['https://other.test/index.json: INDEX_UNAVAILABLE']);
  assert.equal(market.sources[0].official, true);
  assert.deepEqual(normalizeMarket(null), { plugins: [], sources: [], errors: [] });
  // The added user plugins follow the same search and kind as the index entries the server filtered.
  assert.deepEqual(normalizeMarket({ plugins: [], installed: ANSWER.installed }, { kind: 'listener' }).plugins.map(entry => entry.name), ['codex', 'gitty']);
  assert.deepEqual(normalizeMarket({ plugins: [], installed: ANSWER.installed }, { q: 'dev' }).plugins.map(entry => entry.name), ['mine']);
});

test('badges and actions: built-in has none to do, an index entry installs, an update shows, a linked plugin is Dev and unlinks', async () => {
  const { normalizeMarket, entryBadges, entryActions, versionText } = await load();
  const byName = Object.fromEntries(normalizeMarket(ANSWER).plugins.map(entry => [entry.name, entry]));
  const keys = entry => entryBadges(entry).map(badge => `${badge.key}:${badge.label}`);
  assert.deepEqual(keys(byName.telegram), ['builtIn:Built-in']);
  assert.deepEqual(entryActions(byName.telegram), { install: false, update: false, remove: false });
  assert.deepEqual(keys(byName.slack), []);
  assert.deepEqual(entryActions(byName.slack), { install: true, update: false, remove: false });
  assert.deepEqual(keys(byName.codex), ['installed:Installed', 'update:Update available']);
  assert.deepEqual(entryActions(byName.codex), { install: false, update: true, remove: true });
  assert.equal(versionText(byName.codex), '1.0.0 → 2.0.0');
  assert.equal(versionText(byName.slack), '0.3.0');
  assert.deepEqual(keys(byName.mine), ['installed:Installed', 'dev:Dev']);
  assert.deepEqual(entryActions(byName.mine), { install: false, update: false, remove: true });
  assert.deepEqual(entryActions(byName.gitty), { install: false, update: true, remove: true }, 'a Git install not in an index can be updated');
  assert.equal(byName.slack.homepage, 'https://example.test/slack');
  assert.equal(normalizeMarket({ plugins: [{ name: 'x', homepage: 'javascript:alert(1)' }] }).plugins[0].homepage, '', 'only http(s) home pages are links');
});

test('applyUpdates marks entries the update check found, and updatesSummary says what it found', async () => {
  const { normalizeMarket, applyUpdates, updatesSummary } = await load();
  const entries = normalizeMarket(ANSWER).plugins;
  const checked = { updates: [{ name: 'mine', updateAvailable: true }, { name: 'slack', updateAvailable: true }, { name: 'gitty', updateAvailable: false, error: 'GIT_FAILED' }, { name: 'telegram', updateAvailable: true }] };
  const after = Object.fromEntries(applyUpdates(entries, checked).map(entry => [entry.name, entry.updateAvailable]));
  assert.deepEqual(after, { telegram: false, slack: false, codex: true, mine: true, gitty: true }, 'only installed user plugins; nothing is taken away');
  assert.equal(applyUpdates(entries, null).length, entries.length);
  assert.equal(updatesSummary(checked), '3 updates available. Could not check: gitty');
  assert.equal(updatesSummary({ updates: [{ name: 'a', updateAvailable: true }] }), '1 update available');
  assert.equal(updatesSummary({ updates: [] }), 'Everything is up to date');
});

test('filterEntries matches every word in name, description, author or tags, and the kind', async () => {
  const { normalizeMarket, filterEntries, marketQuery } = await load();
  const entries = normalizeMarket(ANSWER).plugins;
  const names = filter => filterEntries(entries, filter).map(entry => entry.name);
  assert.deepEqual(names({ q: 'CHAT' }), ['telegram', 'slack']);
  assert.deepEqual(names({ q: 'chat ann' }), ['slack']);
  assert.deepEqual(names({ q: 'work', kind: 'listener' }), []);
  assert.deepEqual(names({ kind: 'listener' }), ['codex', 'gitty']);
  assert.equal(names({}).length, entries.length);
  assert.equal(marketQuery({ q: '  tele gram ', kind: 'notifier' }), '?q=tele+gram&kind=notifier');
  assert.equal(marketQuery({}), '');
});

test('parseGitSource reads https and git@ addresses with #ref and :subfolder, and refuses the rest', async () => {
  const { parseGitSource } = await load();
  assert.deepEqual(parseGitSource(' https://github.com/a/b.git '), { url: 'https://github.com/a/b.git', repo: 'https://github.com/a/b.git', subfolder: '', ref: '' });
  assert.deepEqual(parseGitSource('https://github.com/a/b.git#v1.2:plugins/x/'), { url: 'https://github.com/a/b.git#v1.2:plugins/x/', repo: 'https://github.com/a/b.git', subfolder: 'plugins/x', ref: 'v1.2' });
  assert.deepEqual(parseGitSource('git@github.com:o/r.git#main'), { url: 'git@github.com:o/r.git#main', repo: 'git@github.com:o/r.git', subfolder: '', ref: 'main' });
  assert.deepEqual(parseGitSource('https://git.example.test:8443/o/r:sub'), { url: 'https://git.example.test:8443/o/r:sub', repo: 'https://git.example.test:8443/o/r', subfolder: 'sub', ref: '' });
  assert.equal(parseGitSource('').error, 'Enter a Git URL');
  assert.equal(parseGitSource('http://github.com/a/b').error, 'Use an https:// or git@ address');
  assert.equal(parseGitSource('file:///etc').error, 'Use an https:// or git@ address');
  assert.equal(parseGitSource('https://github.com/a b').error, 'A Git URL has no spaces');
  assert.equal(parseGitSource('https://github.com/a/b#v1;rm').error, 'The #ref is not a valid tag, branch or commit');
  assert.equal(parseGitSource('https://github.com/a/b#v1:../up').error, 'The :subfolder is not valid');
  assert.equal(parseGitSource('https://github.com/').error, 'The address has no repository path');
});

test('sourceProblem accepts only new https index URLs, at most 10', async () => {
  const { sourceProblem, normalizeSources } = await load();
  assert.equal(sourceProblem('https://example.test/marketplace.json'), '');
  assert.equal(sourceProblem(''), 'Enter an index URL');
  assert.equal(sourceProblem('not a url'), 'This is not a valid URL');
  assert.equal(sourceProblem('http://example.test/m.json'), 'Index URLs must start with https://');
  assert.equal(sourceProblem('https://a.test/m.json', ['https://a.test/m.json']), 'This index is already in the list');
  assert.equal(sourceProblem('https://new.test/m.json', Array.from({ length: 10 }, (_, i) => `https://s${i}.test/m.json`)), 'At most 10 extra indexes');
  assert.deepEqual(normalizeSources({ official: 'https://o.test/m.json', extra: ['https://a.test/m.json', 3, ''] }), { official: 'https://o.test/m.json', extra: ['https://a.test/m.json'] });
  assert.deepEqual(normalizeSources(null), { official: '', extra: [] });
});

test('prepareBody and removeRequest follow the market API', async () => {
  const { prepareBody, removeRequest } = await load();
  assert.deepEqual(prepareBody({ mode: 'install', name: 'slack' }), { source: { name: 'slack' } });
  assert.deepEqual(prepareBody({ mode: 'git', url: ' https://h.test/r.git#v1 ' }), { source: 'https://h.test/r.git#v1' });
  assert.deepEqual(prepareBody({ mode: 'update', name: 'codex' }), { update: 'codex' });
  assert.equal(prepareBody(null), null);
  assert.deepEqual(removeRequest({ name: 'codex' }), { method: 'DELETE', path: '/market/plugins/codex' });
  assert.deepEqual(removeRequest({ name: 'codex' }, { purge: true }), { method: 'DELETE', path: '/market/plugins/codex?purge=1' });
  assert.deepEqual(removeRequest({ name: 'mine', dev: true }, { purge: true }), { method: 'DELETE', path: '/market/link/mine' }, 'a link is only unlinked');
});

test('previewModel flattens the prepare answer, flags dependencies and expires after 10 minutes', async () => {
  const { previewModel, previewExpired, capabilityText, filesText, formatBytes, shortSha, isExpiredError, PREPARE_TTL_MS } = await load();
  const preview = {
    prepareId: 'p1', name: 'slack', kind: 'notifier',
    manifest: { name: 'slack', version: '0.3.0', kind: 'notifier', description: 'Slack messages' },
    source: { type: 'index', url: 'https://github.com/x/slack.git', ref: 'v0.3.0', path: 'plugin', commit: '0123456789abcdef0123456789abcdef01234567' },
    commit: '0123456789abcdef0123456789abcdef01234567', events: ['waiting_user', 'failed'],
    config: [{ key: 'webhook', label: 'Webhook URL', type: 'secret', required: true }, { nope: 1 }],
    files: { count: 3, totalBytes: 12800, list: [{ path: 'index.js', size: 12000 }, { path: 'manifest.json', size: 800 }] },
    hasPackageJson: true, dependencies: ['axios'], warnings: ['Uses network modules: https'], update: null,
  };
  const model = previewModel(preview, { receivedAt: NOW });
  assert.equal(model.prepareId, 'p1');
  assert.equal(model.shortCommit, '0123456');
  assert.equal(model.sourceUrl, 'https://github.com/x/slack.git');
  assert.equal(model.subfolder, 'plugin');
  assert.equal(model.ref, 'v0.3.0');
  assert.deepEqual(model.configFields, [{ key: 'webhook', label: 'Webhook URL', type: 'secret', required: true }]);
  assert.deepEqual(model.fileList, ['index.js', 'manifest.json']);
  assert.equal(model.dependencyWarning, true, 'dependencies the server did not warn about get their own warning');
  assert.equal(previewModel({ ...preview, warnings: ['needs dependencies; not supported'] }).dependencyWarning, false);
  assert.equal(capabilityText(model), 'Notifier · Events: waiting_user, failed');
  assert.equal(filesText(model), '3 files, 12.5 KB');
  assert.equal(filesText(previewModel({ files: { count: 1 } })), '1 file');
  assert.equal(model.expiresAt, NOW + PREPARE_TTL_MS, 'without expiresAt the page counts 10 minutes from receipt');
  assert.equal(previewExpired(model, NOW + PREPARE_TTL_MS - 1), false);
  assert.equal(previewExpired(model, NOW + PREPARE_TTL_MS), true);
  assert.equal(previewExpired(null), true);
  assert.equal(previewModel({ ...preview, expiresAt: '2026-11-08T12:05:00Z' }, { receivedAt: NOW }).expiresAt, NOW + 5 * 60000, 'the server expiry wins');
  // An update: version from -> to and the changed files.
  const update = previewModel({ ...preview, shortCommit: 'fedcba9', update: { from: { version: '0.2.0', commit: 'aaa' }, to: { version: '0.3.0', commit: 'bbb' }, filesChanged: 2 } });
  assert.deepEqual(update.update, { fromVersion: '0.2.0', toVersion: '0.3.0', filesChanged: 2 });
  assert.equal(update.shortCommit, 'fedcba9');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(3 * 1024 * 1024 / 2), '1.5 MB');
  assert.equal(formatBytes(-1), '');
  assert.equal(shortSha('nothex'), 'nothex');
  const failure = (code, message) => Object.assign(new Error(code), { data: { error: code, message } });
  assert.equal(isExpiredError(failure('PREPARE_EXPIRED', 'The prepared install expired')), true);
  assert.equal(isExpiredError(failure('GIT_FAILED', 'clone failed')), false);
  assert.equal(isExpiredError(null), false);
});

// The plugin marketplace on the MUI page (Settings → T-Attention → Plugins → Marketplace: scripts/h5-shell/PluginMarket.jsx, MarketDialogs.jsx,
// market-model.mjs) in real Chromium, with the API (/api/attention*) stubbed by Playwright routes after the contract "H — final API":
// - phone 390x844 (touch): the Installed / Marketplace tabs (the market is read only when its tab is chosen); cards with version, kind,
//   description, author, tags and the Built-in / Installed / Update available / Dev badges; the debounced search (one request after typing)
//   and the kind filter; Install opens the confirmation with the prepared preview (source, short commit, what it can do, settings, files,
//   warnings and the dependency warning) and nothing is installed before its Install button (Cancel installs nothing); after an install the
//   Installed tab is read again; Update shows old → new version; Remove with "Also delete its saved settings" (?purge=1); a Dev plugin is
//   unlinked; "Install from Git URL…" checks the address, shows a prepare error inline, and offers "Prepare again" when the preview is older
//   than its expiry and when the server answers PREPARE_EXPIRED; "Check for updates"; "Link local folder…"; "Sources" (https only, add and remove).
// - phone 320x640 (touch): the market tab and the confirmation dialog fit the width, the buttons are 44px.
// - computer 1440x900 (mouse): the tabs and an install through the dialog.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OFFICIAL = 'https://raw.githubusercontent.com/example/t-agent/main/marketplace.json';

const OVERVIEW = () => ({
  listeners: [{ name: 'claude', version: '1.0.0', description: 'Claude Code hooks', origin: 'builtin', dev: false, local: { hookPath: true, loggedIn: true, toolHooks: true, installable: false, itemCount: 0 } }],
  notifiers: [{ name: 'telegram', version: '1.0.0', description: 'Telegram message or call', loaded: true, enabled: true, configured: true, origin: 'builtin', dev: false, statuses: {} }],
});
// The index entries and the user plugins of the stubbed server (GET /api/attention/market).
const INDEX = () => [
  { name: 'telegram', kind: 'notifier', description: 'Telegram message or call', version: '1.0.0', author: 'T-Agent', tags: ['chat', 'call'], builtIn: true, installed: true, installedVersion: '1.0.0', origin: 'builtin', dev: false, updateAvailable: false },
  { name: 'slack', kind: 'notifier', description: 'Slack channel messages', version: '0.3.0', author: 'Ann Example', tags: ['chat', 'work'], repo: 'https://github.com/ann/slack-notifier.git', ref: 'v0.3.0', builtIn: false, installed: false, installedVersion: null, origin: null, dev: false, updateAvailable: false },
  { name: 'codex', kind: 'listener', description: 'Codex notify hook', version: '2.0.0', author: 'Bob', tags: ['agent'], repo: 'https://github.com/bob/codex.git', ref: 'main', builtIn: false, installed: true, installedVersion: '1.0.0', origin: 'index', dev: false, updateAvailable: true },
];
const USER = () => [
  { name: 'codex', kind: 'listener', version: '1.0.0', description: 'Codex notify hook', origin: 'index', dev: false, source: { type: 'index', url: 'https://github.com/bob/codex.git', ref: 'main', commit: 'aaaaaaa' }, updateAvailable: true },
  { name: 'gitty', kind: 'listener', version: '0.1.0', description: 'A listener from a Git URL', origin: 'git', dev: false, source: { type: 'git', url: 'https://example.test/gitty.git', ref: '', commit: 'bbbbbbb' }, updateAvailable: false },
  { name: 'mine', kind: 'notifier', version: '0.0.1', description: 'My notifier in development', origin: 'link', dev: true, source: { type: 'link', url: '/home/me/mine' }, updateAvailable: false },
];

async function openPage(browser, { viewport, touch = true }) {
  const scale = SHOTS && touch ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  const errors = [];
  const calls = []; // { method, path, body } of every /api/attention request
  const db = { index: INDEX(), user: USER(), extra: [], prepared: new Map(), next: 1, expireNext: 0, failInstallOnce: false };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; this.readyState = 1; } close() { this.readyState = 2; } };
    window.confirm = () => true;
  });
  const listing = (q, kind) => {
    const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const plugins = db.index.filter(entry => (!kind || entry.kind === kind) && words.every(word => [entry.name, entry.description, entry.author, ...entry.tags].join(' ').toLowerCase().includes(word)));
    return { plugins, installed: db.user, sources: [{ url: OFFICIAL, official: true, ok: true, stale: false, count: db.index.length }, ...db.extra.map(url => ({ url, official: false, ok: false, stale: true, error: 'INDEX_UNAVAILABLE' }))] };
  };
  const preview = body => {
    const prepareId = `p${db.next++}`;
    const ttl = db.expireNext || 600000;
    db.expireNext = 0;
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const base = { prepareId, expiresAt, commit: SHA, shortCommit: SHA.slice(0, 7), hasPackageJson: false, dependencies: [], warnings: [], update: null, events: [], config: [] };
    if (body.update) {
      const entry = db.index.find(item => item.name === body.update);
      db.prepared.set(prepareId, { name: entry.name, update: true });
      return { ...base, name: entry.name, kind: entry.kind, manifest: { name: entry.name, version: entry.version, kind: entry.kind, description: entry.description },
        source: { type: 'index', url: entry.repo, ref: entry.ref, path: '', commit: SHA }, files: { count: 4, totalBytes: 2048, list: [] },
        update: { from: { version: entry.installedVersion, commit: 'aaaaaaa' }, to: { version: entry.version, commit: SHA }, filesChanged: 2 } };
    }
    if (typeof body.source === 'string') {
      db.prepared.set(prepareId, { name: 'fromgit', git: body.source });
      return { ...base, name: 'fromgit', kind: 'notifier', manifest: { name: 'fromgit', version: '1.0.0', kind: 'notifier', description: 'Installed from Git' },
        source: { type: 'git', url: body.source.split('#')[0], ref: 'v1', path: '', commit: SHA }, files: { count: 1, totalBytes: 300, list: [{ path: 'index.js', size: 300 }] } };
    }
    const entry = db.index.find(item => item.name === body.source.name);
    db.prepared.set(prepareId, { name: entry.name });
    return { ...base, name: entry.name, kind: entry.kind, manifest: { name: entry.name, version: entry.version, kind: entry.kind, description: entry.description },
      source: { type: 'index', url: entry.repo, ref: entry.ref, path: 'plugin', commit: SHA },
      events: ['waiting_user', 'failed'], config: [{ key: 'webhook', label: 'Webhook URL', type: 'secret', required: true }, { key: 'channel', label: 'Channel', type: 'string' }],
      files: { count: 3, totalBytes: 12800, list: [{ path: 'index.js', size: 12000 }] },
      hasPackageJson: true, dependencies: ['axios'], warnings: ['Uses network modules: https'] };
  };
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 't1', title: 'Terminal 1' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p.startsWith('/api/attention')) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      calls.push({ method, path: p + url.search, body });
      if (p === '/api/attention' && method === 'GET') return json({ items: [], host: 'mac' });
      if (p === '/api/attention/tokens' && method === 'GET') return json({ tokens: [] });
      if (p === '/api/attention/plugins' && method === 'GET') return json(OVERVIEW());
      if (p === '/api/attention/market' && method === 'GET') return json(listing(url.searchParams.get('q'), url.searchParams.get('kind')));
      if (p === '/api/attention/market/updates' && method === 'GET') return json({ updates: db.user.filter(entry => entry.origin !== 'link').map(entry => ({ name: entry.name, kind: entry.kind, version: entry.version, updateAvailable: entry.name === 'gitty' || entry.updateAvailable === true, error: null })) });
      if (p === '/api/attention/market/sources' && method === 'GET') return json({ official: OFFICIAL, extra: db.extra });
      if (p === '/api/attention/market/sources' && method === 'PUT') { db.extra = body.extra; return json({ official: OFFICIAL, extra: db.extra }); }
      if (p === '/api/attention/market/prepare' && method === 'POST') {
        if (typeof body.source === 'string' && body.source.includes('broken')) return json({ error: 'GIT_FAILED', message: 'git clone failed: repository not found' }, 502);
        return json(preview(body));
      }
      if (p === '/api/attention/market/install' && method === 'POST') {
        if (!body.confirm) return json({ error: 'CONFIRM_REQUIRED', message: 'Confirm the install' }, 400);
        if (db.failInstallOnce) { db.failInstallOnce = false; return json({ error: 'PREPARE_EXPIRED', message: 'The prepared install expired; prepare it again' }, 410); }
        const job = db.prepared.get(body.prepareId);
        if (!job) return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
        const entry = db.index.find(item => item.name === job.name);
        if (entry) Object.assign(entry, { installed: true, installedVersion: entry.version, origin: 'index', updateAvailable: false });
        const user = db.user.find(item => item.name === job.name);
        if (user && entry) Object.assign(user, { version: entry.version, updateAvailable: false });
        if (job.git) db.user.push({ name: job.name, kind: 'notifier', version: '1.0.0', description: 'Installed from Git', origin: 'git', dev: false, source: { type: 'git', url: job.git }, updateAvailable: false });
        return json({ ok: true, plugin: { name: job.name, kind: entry ? entry.kind : 'notifier', version: entry ? entry.version : '1.0.0', origin: job.git ? 'git' : 'index' } });
      }
      const removed = p.match(/^\/api\/attention\/market\/(plugins|link)\/([^/]+)$/);
      if (removed && method === 'DELETE') {
        const name = decodeURIComponent(removed[2]);
        db.user = db.user.filter(entry => entry.name !== name);
        const entry = db.index.find(item => item.name === name);
        if (entry) Object.assign(entry, { installed: false, installedVersion: null, origin: null, updateAvailable: false });
        return json(removed[1] === 'link' ? { ok: true, name } : { ok: true, name, purged: url.searchParams.get('purge') === '1' });
      }
      if (p === '/api/attention/market/link' && method === 'POST') {
        db.user.push({ name: 'linked', kind: 'listener', version: '0.0.1', description: 'A linked listener', origin: 'link', dev: true, source: { type: 'link', url: body.path }, updateAvailable: false });
        return json({ ok: true, plugin: { name: 'linked', kind: 'listener', origin: 'link', dev: true } });
      }
      return json({ error: 'not mocked' }, 404);
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const row = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await row.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await row[how]();
  await page.waitForFunction(() => window.sockets.length >= 1 && window.sockets.at(-1).readyState === 1);
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open'));
  return { context, page, how, errors, calls, db };
}

// Opens Settings → T-Attention, waits for the Installed rows, then chooses the Marketplace tab and waits for its cards.
async function openMarket(page, how, calls) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await page.locator('#h5-set-attention .MuiAccordionSummary-root')[how]();
  await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-attention .MuiCollapse-entered')));
  await page.locator('#h5-plugins .h5-plugin').first().waitFor();
  assert.equal(calls.filter(call => call.path.startsWith('/api/attention/market')).length, 0, 'the market is not read before its tab is chosen');
  assert.equal(await page.locator('#h5-plugins-tab-installed').getAttribute('aria-selected'), 'true');
  await page.locator('#h5-plugins-tab-market')[how]();
  await page.locator('#h5-market .h5-market-card').first().waitFor();
  assert.equal(await page.locator('#h5-plugins-tab-market').getAttribute('aria-selected'), 'true');
  assert.ok(!(await page.locator('#h5-plugins').isVisible()), 'the Installed panel is hidden on the Marketplace tab');
}
const names = page => page.locator('#h5-market .h5-market-card').evaluateAll(nodes => nodes.map(node => node.dataset.name));
const card = (page, name) => page.locator(`#h5-market .h5-market-card[data-name="${name}"]`);
const badges = (page, name) => card(page, name).locator('.h5-market-badge').evaluateAll(nodes => nodes.map(node => node.dataset.badge));
const marketCalls = calls => calls.filter(call => call.method === 'GET' && call.path.startsWith('/api/attention/market') && !call.path.includes('/sources')).map(call => call.path);
const installs = calls => calls.filter(call => call.path === '/api/attention/market/install');
const prepares = calls => calls.filter(call => call.path === '/api/attention/market/prepare');
// Nothing in the market panel or an open dialog is wider than the viewport, and no box scrolls sideways.
const overflow = page => page.evaluate(() => [...document.querySelectorAll('#h5-market *, .MuiDialog-paper, .MuiDialog-paper *')]
  .filter(node => node.getBoundingClientRect().width && (node.getBoundingClientRect().right > innerWidth + 0.5 || (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'visible' && node.tagName !== 'INPUT')))
  .map(node => `${node.tagName}.${String(node.className).slice(0, 60)}`));
const smallButtons = (page, selector) => page.evaluate(sel => [...document.querySelectorAll(sel)].map(node => node.getBoundingClientRect()).filter(r => r.width && (r.width < 44 || r.height < 44)).map(r => [r.width, r.height]), selector);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844, touch ──
    {
      const { context, page, errors, calls, db } = await openPage(browser, { viewport: { width: 390, height: 844 } });
      await openMarket(page, 'tap', calls);
      assert.deepEqual(marketCalls(calls), ['/api/attention/market']);
      assert.deepEqual(await names(page), ['telegram', 'slack', 'codex', 'gitty', 'mine'], 'index entries, then user plugins no index lists');
      assert.deepEqual(await badges(page, 'telegram'), ['builtIn']);
      assert.deepEqual(await badges(page, 'slack'), []);
      assert.deepEqual(await badges(page, 'codex'), ['installed', 'update']);
      assert.deepEqual(await badges(page, 'mine'), ['installed', 'dev']);
      assert.equal(await card(page, 'telegram').locator('button').count(), 0, 'a built-in plugin has no actions');
      assert.equal(await card(page, 'codex').locator('.h5-market-version').textContent(), '1.0.0 → 2.0.0');
      assert.equal(await card(page, 'codex').locator('.h5-market-kind').textContent(), 'Listener');
      assert.equal(await card(page, 'slack').locator('.h5-market-meta').textContent(), 'By Ann Example · #chat #work');
      assert.equal(await card(page, 'mine').locator('.h5-market-remove').textContent(), 'Unlink');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-market-390.png') });

      // Search: typing asks the server once, after the pause; the kind chips ask at once.
      await page.locator('#h5-market-search').pressSequentially('slack', { delay: 30 });
      await page.waitForFunction(() => document.querySelectorAll('#h5-market .h5-market-card').length === 1);
      await page.waitForTimeout(450);
      assert.deepEqual(marketCalls(calls), ['/api/attention/market', '/api/attention/market?q=slack'], 'one request for the whole word');
      assert.deepEqual(await names(page), ['slack']);
      await page.locator('#h5-market-search').fill('nothing-like-this');
      await page.locator('#h5-market-empty', { hasText: 'No plugins match the search' }).waitFor();
      await page.locator('#h5-market-search').fill('');
      await page.locator('.h5-market-kind-filter[data-kind="listener"]').tap();
      await page.waitForFunction(() => { const cards = [...document.querySelectorAll('#h5-market .h5-market-card')]; return cards.length > 0 && cards.every(node => node.dataset.kind === 'listener'); });
      assert.equal(await page.locator('.h5-market-kind-filter[data-kind="listener"]').getAttribute('aria-pressed'), 'true');
      assert.ok(marketCalls(calls).includes('/api/attention/market?kind=listener'));
      assert.deepEqual(await names(page), ['codex', 'gitty']);
      await page.locator('.h5-market-kind-filter[data-kind=""]').tap();
      await page.waitForFunction(() => document.querySelectorAll('#h5-market .h5-market-card').length === 5);

      // Install from the index: the preview, Cancel installs nothing, then Install.
      await card(page, 'slack').locator('.h5-market-install').tap();
      const dialog = page.locator('#h5-market-confirm');
      await dialog.locator('#h5-market-confirm-name').waitFor();
      assert.deepEqual(prepares(calls).at(-1).body, { source: { name: 'slack' } });
      const fact = name => dialog.locator(`.h5-market-fact[data-fact="${name}"]`).textContent();
      assert.equal(await fact('source'), 'Source:https://github.com/ann/slack-notifier.git : plugin');
      assert.equal(await fact('commit'), 'Commit:0123456 (v0.3.0)');
      assert.equal(await fact('kind'), 'What it can do:Notifier · Events: waiting_user, failed');
      assert.equal(await fact('config'), 'Settings:Webhook URL, Channel');
      assert.equal(await fact('files'), 'Files:3 files, 12.5 KB');
      assert.deepEqual(await dialog.locator('.h5-market-warning').allTextContents(), ['Uses network modules: https', 'It lists dependencies that are not installed: axios']);
      assert.equal(await dialog.locator('#h5-market-warnings').getAttribute('role'), 'alert', 'warnings are highlighted');
      assert.equal(installs(calls).length, 0, 'nothing is installed by the preview');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-market-confirm-390.png') });
      await page.locator('#h5-market-confirm-cancel').tap();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(installs(calls).length, 0, 'Cancel installs nothing');
      const overviewReads = calls.filter(call => call.path === '/api/attention/plugins').length;
      await card(page, 'slack').locator('.h5-market-install').tap();
      await dialog.locator('#h5-market-confirm-name').waitFor();
      await page.locator('#h5-market-confirm-install').tap();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(installs(calls).map(call => call.body), [{ prepareId: 'p2', confirm: true }]);
      await page.locator('#h5-market-feedback', { hasText: 'Installed: slack' }).waitFor();
      await page.waitForFunction(() => document.querySelector('#h5-market .h5-market-card[data-name="slack"] .h5-market-badge[data-badge="installed"]'));
      assert.ok(calls.filter(call => call.path === '/api/attention/plugins').length > overviewReads, 'the Installed tab is read again');

      // Update: version old → new, files changed, then Update.
      await card(page, 'codex').locator('.h5-market-update').tap();
      await dialog.locator('#h5-market-confirm-name').waitFor();
      assert.deepEqual(prepares(calls).at(-1).body, { update: 'codex' });
      assert.equal(await page.locator('#h5-market-confirm-title').textContent(), 'Update plugin');
      assert.equal(await page.locator('#h5-market-confirm-version').textContent(), '1.0.0 → 2.0.0');
      assert.equal(await fact('changed'), 'Files changed:2');
      assert.equal(await page.locator('#h5-market-confirm-install').textContent(), 'Update');
      await page.locator('#h5-market-confirm-install').tap();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#h5-market-feedback', { hasText: 'Updated: codex' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('#h5-market .h5-market-card[data-name="codex"] .h5-market-update'));

      // "Check for updates": the server's ls-remote result is laid over the list (gitty gets Update).
      assert.equal(await card(page, 'gitty').locator('.h5-market-update').count(), 0);
      await page.locator('#h5-market-updates').tap();
      await page.locator('#h5-market-feedback', { hasText: '1 update available' }).waitFor();
      await card(page, 'gitty').locator('.h5-market-update').waitFor();
      assert.deepEqual(await badges(page, 'gitty'), ['installed', 'update']);

      // Remove with purge; a Dev plugin is only unlinked.
      await card(page, 'gitty').locator('.h5-market-remove').tap();
      await page.locator('#h5-market-remove-purge').check();
      await page.locator('#h5-market-remove-confirm').tap();
      await page.locator('#h5-market-remove').waitFor({ state: 'hidden' });
      assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/attention/market/plugins/gitty?purge=1'));
      await card(page, 'gitty').waitFor({ state: 'detached' });
      await card(page, 'mine').locator('.h5-market-remove').tap();
      assert.equal(await page.locator('#h5-market-remove-title').textContent(), 'Unlink plugin');
      assert.equal(await page.locator('#h5-market-remove-purge').count(), 0, 'no purge for a link');
      await page.locator('#h5-market-remove-confirm').tap();
      await card(page, 'mine').waitFor({ state: 'detached' });
      assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/attention/market/link/mine'));

      // Git URL: a bad address is refused here; a failing clone shows its error in the dialog; an expired preview offers "Prepare again".
      await page.locator('#h5-market-git-open').tap();
      await page.locator('#h5-market-git-url').fill('http://example.test/x.git');
      await page.locator('#h5-market-git-next').tap();
      await page.locator('#h5-market-git-error', { hasText: 'Use an https:// or git@ address' }).waitFor();
      const before = prepares(calls).length;
      await page.locator('#h5-market-git-url').fill('https://example.test/broken.git');
      await page.locator('#h5-market-git-next').tap();
      await page.locator('#h5-market-confirm-error', { hasText: 'git clone failed: repository not found' }).waitFor();
      assert.equal(await page.locator('#h5-market-confirm-install').isDisabled(), true);
      await page.locator('#h5-market-confirm-cancel').tap();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#h5-market-git-open').tap();
      await page.locator('#h5-market-git-url').fill('https://example.test/fromgit.git#v1:plugin');
      await page.locator('#h5-market-git-parsed', { hasText: 'Version: v1' }).waitFor();
      db.expireNext = 1500;
      await page.locator('#h5-market-git-next').tap();
      await dialog.locator('#h5-market-confirm-name').waitFor();
      assert.deepEqual(prepares(calls).at(-1).body, { source: 'https://example.test/fromgit.git#v1:plugin' });
      assert.equal(prepares(calls).length, before + 2);
      await page.locator('#h5-market-expired').waitFor({ timeout: 4000 });
      assert.equal(await page.locator('#h5-market-confirm-install').isDisabled(), true, 'an expired preview cannot be installed');
      await page.locator('#h5-market-prepare-again').tap();
      await page.locator('#h5-market-expired').waitFor({ state: 'detached' });
      // The server's PREPARE_EXPIRED also turns the dialog to "Prepare again".
      db.failInstallOnce = true;
      await page.locator('#h5-market-confirm-install').tap();
      await page.locator('#h5-market-expired').waitFor();
      await page.locator('#h5-market-prepare-again').tap();
      await page.locator('#h5-market-expired').waitFor({ state: 'detached' });
      await page.locator('#h5-market-confirm-install').tap();
      await dialog.waitFor({ state: 'hidden' });
      await card(page, 'fromgit').waitFor();
      assert.equal(installs(calls).filter(call => call.body.confirm === true).length, installs(calls).length, 'every install carries the confirmation');

      // Link local folder.
      await page.locator('#h5-market-link-open').tap();
      await page.locator('#h5-market-link-path').fill('relative/path');
      await page.locator('#h5-market-link-save').tap();
      await page.locator('#h5-market-link-error', { hasText: 'Enter the absolute path of the folder' }).waitFor();
      await page.locator('#h5-market-link-path').fill('/home/me/linked');
      await page.locator('#h5-market-link-save').tap();
      await page.locator('#h5-market-link').waitFor({ state: 'hidden' });
      assert.deepEqual(calls.find(call => call.path === '/api/attention/market/link').body, { path: '/home/me/linked' });
      await card(page, 'linked').waitFor();
      assert.deepEqual(await badges(page, 'linked'), ['installed', 'dev']);

      // Sources: the official one is fixed; http is refused; an https index is added and removed again.
      await page.locator('#h5-market-sources-open').tap();
      await page.locator('#h5-market-sources .h5-market-source[data-official="true"]').waitFor();
      await page.locator('#h5-market-source-url').fill('http://plain.test/m.json');
      await page.locator('#h5-market-source-add').tap();
      await page.locator('#h5-market-sources-error', { hasText: 'Index URLs must start with https://' }).waitFor();
      await page.locator('#h5-market-source-url').fill('https://mine.test/marketplace.json');
      await page.locator('#h5-market-source-add').tap();
      await page.locator('#h5-market-sources .h5-market-source[data-url="https://mine.test/marketplace.json"]').waitFor();
      assert.deepEqual(calls.filter(call => call.method === 'PUT').at(-1).body, { extra: ['https://mine.test/marketplace.json'] });
      const remove = page.locator('#h5-market-sources .h5-market-source-remove');
      assert.equal(await remove.getAttribute('aria-label'), 'Remove source');
      assert.equal(await remove.getAttribute('title'), 'Remove source');
      const reads = marketCalls(calls).length;
      await page.locator('#h5-market-sources-close').tap();
      await page.waitForFunction(count => document.querySelector('#h5-market-source-errors'), reads);
      assert.ok(marketCalls(calls).length > reads, 'the listing is read again after the sources changed');
      assert.match(await page.locator('#h5-market-source-errors').textContent(), /mine\.test.*INDEX_UNAVAILABLE/);
      await page.locator('#h5-market-sources-open').tap();
      await page.locator('#h5-market-sources .h5-market-source-remove').tap();
      await page.locator('#h5-market-sources .h5-market-source-remove').waitFor({ state: 'detached' });
      assert.deepEqual(calls.filter(call => call.method === 'PUT').at(-1).body, { extra: [] });
      await page.locator('#h5-market-sources-close').tap();

      // Back to Installed: the overview is still there.
      await page.locator('#h5-plugins-tab-installed').tap();
      await page.locator('#h5-plugins .h5-plugin').first().waitFor({ state: 'visible' });
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 320x640, touch: everything fits and the buttons are 44px ──
    {
      const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 320, height: 640 } });
      await openMarket(page, 'tap', calls);
      assert.deepEqual(await overflow(page), []);
      assert.deepEqual(await smallButtons(page, '#h5-market button, #h5-plugins-tab-installed, #h5-plugins-tab-market'), []);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-market-320.png') });
      await card(page, 'slack').locator('.h5-market-install').tap();
      await page.locator('#h5-market-confirm-name').waitFor();
      assert.deepEqual(await overflow(page), []);
      assert.deepEqual(await smallButtons(page, '#h5-market-confirm button'), []);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-market-confirm-320.png') });
      await page.locator('#h5-market-confirm-cancel').tap();
      await page.locator('#h5-market-sources-open').tap();
      await page.locator('#h5-market-source-url').waitFor();
      assert.deepEqual(await overflow(page), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Computer 1440x900, mouse ──
    {
      const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false });
      await openMarket(page, 'click', calls);
      await card(page, 'slack').locator('.h5-market-install').click();
      await page.locator('#h5-market-confirm-name').waitFor();
      assert.equal(installs(calls).length, 0);
      await page.locator('#h5-market-confirm-install').click();
      await page.locator('#h5-market-confirm').waitFor({ state: 'hidden' });
      assert.equal(installs(calls).length, 1);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-market.png') });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 market browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

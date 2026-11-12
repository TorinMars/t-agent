// Settings "Rules and skills sync" (scripts/h5-shell/RuleSync.jsx) in real Chromium at 390px (touch) and 1440px (mouse), against a mocked /api/rule-sync:
// the role echo and change, the source part (shared file path, Create it, skill checkboxes, receivers, Sync now, a cap error), the receiver part (the
// followed source, Reset, conflicts), the leftover import line when off, and an error notice. H5_SHOT_DIR=<dir> saves screenshots at 390px there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR;
const REV = 'a1b2c3d4e5f6'.padEnd(64, '0');
const pageErrors = [];

const base = (fields = {}) => ({
  role: 'off', codex: true, shared_rules_path: '/Users/me/.claude/shared/CLAUDE.shared.md', shared_rules_exists: true,
  import_line: '@~/.claude/shared/CLAUDE.shared.md', import_line_present: false, claude_md_path: '/Users/me/.claude/CLAUDE.md',
  codex_agents_path: '/Users/me/.codex/AGENTS.md', codex_block_present: false, skills: [], following: null,
  received: { revision: null, synced_at: null, conflicts: [] }, revision: null, bundle_error: null, warnings: [], local_error: null, last_change_at: null, targets: [],
  ...fields,
});
const sourceView = (fields = {}) => base({
  role: 'source', import_line_present: true, revision: REV, last_change_at: '2026-11-12T08:00:00Z',
  skills: [{ name: 'deploy', shared: true, synced: false }, { name: 'notes', shared: false, synced: false }, { name: 'linked-skill', symlink: true, shared: false }],
  targets: [
    { id: 'l1', name: 'Office computer with a very long name that must wrap or cut', online: true, status: 'up-to-date', role: 'receive', revision: REV, last_push_at: '2026-11-12T08:00:05Z', last_error: null, conflicts: [{ skill: 'company', reason: 'local' }] },
    { id: 'l2', name: 'Laptop', online: true, status: 'not-receiving', role: 'off', revision: null, last_push_at: null, last_error: null, conflicts: [] },
    { id: 'l3', name: 'Old box', online: false, status: 'offline', role: null, revision: null, last_push_at: null, last_error: 'REMOTE_TIMEOUT', conflicts: [] },
  ],
  ...fields,
});
const receiveView = (fields = {}) => base({
  role: 'receive', import_line_present: true, following: { instance_id: '11111111-1111-4111-8111-111111111111', name: 'Home Mac', since: '2026-11-10T00:00:00Z' },
  received: { revision: REV, synced_at: '2026-11-12T08:00:05Z', conflicts: [{ skill: 'company', reason: 'local' }] },
  ...fields,
});

async function openPage(browser, { wide = false, model }) {
  const context = await browser.newContext({ viewport: wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/service-links') return json({ links: [], supported: true });
    if (pathname === '/api/system/version') return json({ app_version: '2.106.0' });
    if (pathname === '/api/tasks') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json([]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname.startsWith('/api/rule-sync')) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      model.calls.push({ method, pathname, body });
      if (model.fail && model.fail[pathname]) return json({ error: model.fail[pathname] }, 403);
      if (pathname === '/api/rule-sync' && method === 'GET') return json(model.view);
      if (pathname === '/api/rule-sync' && method === 'PUT') {
        if (body.role) model.view = { source: sourceView, receive: receiveView, off: base }[body.role]({ import_line_present: model.view.import_line_present });
        if (body.skills) model.view = { ...model.view, skills: model.view.skills.map(skill => ({ ...skill, shared: body.skills.includes(skill.name) })) };
        if (body.codex !== undefined) model.view = { ...model.view, codex: body.codex };
        return json(model.view);
      }
      if (pathname === '/api/rule-sync/create-shared') { model.view = { ...model.view, shared_rules_exists: true }; return json(model.view); }
      if (pathname === '/api/rule-sync/push') return json(model.view);
      if (pathname === '/api/rule-sync/reset-source') { model.view = { ...model.view, following: null, received: { revision: null, synced_at: null, conflicts: [] } }; return json(model.view); }
      if (pathname === '/api/rule-sync/remove-import') { model.view = { ...model.view, import_line_present: false, codex_block_present: false }; return json(model.view); }
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().sources.length > 0);
  return { context, page };
}

function helpers(page, wide) {
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  const open = async () => {
    await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
    await page.locator('#h5-settings').waitFor({ state: 'visible' });
    await settled();
    const summary = page.locator('#h5-set-rule-sync .MuiAccordionSummary-root');
    await summary.scrollIntoViewIfNeeded();
    await press(summary);
    await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-rule-sync .MuiCollapse-entered')));
    await page.locator('#h5-rule-sync-role').waitFor();
  };
  const tap = async selector => { const target = page.locator(selector); await target.scrollIntoViewIfNeeded(); await settled(); await press(target); };
  const shot = async (name, selector) => { if (SHOTS) { if (selector) await page.locator(selector).scrollIntoViewIfNeeded(); await settled(); await page.screenshot({ path: path.join(SHOTS, `rule-sync-${name}.png`), fullPage: false }); } };
  return { press, tap, settled, open, shot };
}

async function assertFits(page, label, touch) {
  const result = await page.evaluate(() => {
    const scope = document.querySelector('#h5-set-rule-sync');
    const inner = document.documentElement.clientWidth;
    const outside = [...scope.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > inner + 0.5 || r.left < -0.5); }).map(el => el.id || el.className || el.tagName);
    const small = [...scope.querySelectorAll('button, label')].filter(el => el.getBoundingClientRect().width > 0).map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, height: r.height }; }).filter(item => item.height < 44);
    return { outside, small };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  if (touch) assert.deepEqual(result.small, [], `${label}: every button and choice is at least 44px high`);
}

const lastCall = model => model.calls.at(-1);
const waitCall = (page, model, predicate) => page.waitForFunction(() => true).then(async () => {
  const deadline = Date.now() + 5000;
  while (!model.calls.some(predicate)) { if (Date.now() > deadline) throw new Error('call not seen'); await page.waitForTimeout(20); }
});

async function testSource(browser, { wide = false } = {}) {
  const model = { view: sourceView(), calls: [] };
  const { context, page } = await openPage(browser, { wide, model });
  const { tap, open, shot } = helpers(page, wide);
  await open();
  assert.equal(await page.locator('#h5-rule-sync-role-source').isChecked(), true, 'the saved role is echoed');
  assert.equal(await page.locator('#h5-rule-sync-codex').isChecked(), true);
  assert.equal(await page.locator('#h5-rule-sync-path').innerText(), '/Users/me/.claude/shared/CLAUDE.shared.md');
  assert.equal(await page.locator('#h5-rule-sync-create').count(), 0, 'an existing file has no Create button');
  assert.equal(await page.locator('#h5-rule-sync-skill-deploy').isChecked(), true);
  assert.equal(await page.locator('#h5-rule-sync-skill-notes').isChecked(), false);
  assert.equal(await page.locator('#h5-rule-sync-skill-linked-skill').isDisabled(), true, 'a symlinked skill cannot be chosen');
  assert.match(await page.locator('.h5-rule-sync-skill[data-skill="linked-skill"]').innerText(), /a link, cannot be shared/);
  assert.equal(await page.locator('.h5-rule-sync-target').count(), 3);
  assert.equal(await page.locator('.h5-rule-sync-target[data-target="l1"] .h5-rule-sync-status').innerText(), 'Up to date');
  assert.match(await page.locator('.h5-rule-sync-target[data-target="l1"]').innerText(), /Revision a1b2c3d4/);
  assert.match(await page.locator('.h5-rule-sync-target[data-target="l1"] .h5-rule-sync-conflicts').innerText(), /company: a local skill has this name/);
  assert.equal(await page.locator('.h5-rule-sync-target[data-target="l2"] .h5-rule-sync-status').innerText(), 'Not receiving');
  assert.equal(await page.locator('.h5-rule-sync-target[data-target="l3"] .h5-rule-sync-error').innerText(), 'Timed out');
  assert.match(await page.locator('#h5-rule-sync-import').innerText(), /@~\/\.claude\/shared\/CLAUDE\.shared\.md/);
  await assertFits(page, wide ? 'source wide' : 'source 390', !wide);
  if (!wide) { await shot('source'); await shot('source-targets', '#h5-rule-sync-push'); }

  await tap('#h5-rule-sync-skill-notes');
  await waitCall(page, model, call => call.method === 'PUT' && call.body.skills);
  assert.deepEqual(lastCall(model).body, { skills: ['deploy', 'notes'] });
  await page.waitForFunction(() => document.querySelector('#h5-rule-sync-skill-notes').checked);
  await tap('#h5-rule-sync-codex');
  await waitCall(page, model, call => call.method === 'PUT' && call.body.codex === false);
  await page.waitForFunction(() => !document.querySelector('#h5-rule-sync-codex').checked);

  await tap('#h5-rule-sync-push');
  await waitCall(page, model, call => call.pathname === '/api/rule-sync/push');
  await page.waitForFunction(() => /Sync finished/.test(document.querySelector('#h5-rule-sync-feedback').textContent));

  // A cap on the source, and a missing shared file.
  model.view = sourceView({ shared_rules_exists: false, bundle_error: { code: 'RULE_SYNC_TOO_LARGE', limit: 'file', item: 'deploy/big.bin' }, warnings: [{ skill: 'deploy', path: 'leak.txt', warning: 'symlink' }] });
  model.fail = { '/api/rule-sync/push': 'RULE_SYNC_NOT_SOURCE' };
  await tap('#h5-rule-sync-push');
  await page.waitForFunction(() => /Only a source can sync/.test(document.querySelector('#h5-rule-sync-feedback').textContent));
  model.fail = null;
  await tap('#h5-rule-sync-skill-notes'); // any save reads the view again
  await page.locator('#h5-rule-sync-bundle-error').waitFor();
  assert.equal(await page.locator('#h5-rule-sync-bundle-error').innerText(), 'A file is over 1 MiB: deploy/big.bin. Nothing is sent until it is fixed.');
  assert.match(await page.locator('#h5-rule-sync-warnings').innerText(), /deploy\/leak\.txt \(a link, not sent\)/);
  await tap('#h5-rule-sync-create');
  await waitCall(page, model, call => call.pathname === '/api/rule-sync/create-shared');
  await page.locator('#h5-rule-sync-create').waitFor({ state: 'detached' });
  await assertFits(page, wide ? 'source errors wide' : 'source errors 390', !wide);
  await context.close();
}

async function testReceiveAndOff(browser, { wide = false } = {}) {
  const model = { view: receiveView(), calls: [] };
  const { context, page } = await openPage(browser, { wide, model });
  const { tap, open, shot } = helpers(page, wide);
  await open();
  assert.equal(await page.locator('#h5-rule-sync-role-receive').isChecked(), true);
  assert.equal(await page.locator('#h5-rule-sync-following').innerText(), 'Follows Home Mac');
  assert.match(await page.locator('#h5-rule-sync-conflicts').innerText(), /company: a local skill has this name/);
  assert.equal(await page.locator('#h5-rule-sync-push').count(), 0, 'a receiver has no Sync now');
  assert.equal(await page.locator('.h5-rule-sync-target').count(), 0);
  await assertFits(page, wide ? 'receive wide' : 'receive 390', !wide);
  if (!wide) await shot('receive', '#h5-rule-sync-conflicts');
  await tap('#h5-rule-sync-reset');
  await waitCall(page, model, call => call.pathname === '/api/rule-sync/reset-source');
  await page.waitForFunction(() => /No source yet/.test(document.querySelector('#h5-rule-sync-following').textContent));

  // Off: the leftover import line can be removed.
  await tap('#h5-rule-sync-role-off');
  await waitCall(page, model, call => call.method === 'PUT' && call.body.role === 'off');
  await page.locator('#h5-rule-sync-remove-import').waitFor();
  assert.equal(await page.locator('#h5-rule-sync-role-off').isChecked(), true);
  assert.equal(await page.locator('#h5-rule-sync-following').count(), 0);
  if (!wide) await shot('off', '#h5-rule-sync-remove-import');
  await tap('#h5-rule-sync-remove-import');
  await waitCall(page, model, call => call.pathname === '/api/rule-sync/remove-import');
  await page.locator('#h5-rule-sync-remove-import').waitFor({ state: 'detached' });
  await tap('#h5-rule-sync-role-source');
  await waitCall(page, model, call => call.method === 'PUT' && call.body.role === 'source');
  await page.locator('#h5-rule-sync-push').waitFor();
  await context.close();
}

async function testChinese(browser) {
  const model = { view: sourceView(), calls: [] };
  const { context, page } = await openPage(browser, { model });
  await page.evaluate(() => { localStorage.setItem('ta-lang', 'zh'); });
  await page.reload();
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().sources.length > 0);
  const { open } = helpers(page, false);
  assert.equal(await page.evaluate(() => I18n.get()), 'zh');
  await open();
  assert.match(await page.locator('#h5-set-rule-sync').innerText(), /\u89c4\u5219\u548c\u6280\u80fd\u540c\u6b65/);
  await assertFits(page, 'Chinese 390', true);
  await context.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await testSource(browser);
    await testSource(browser, { wide: true });
    await testReceiveAndOff(browser);
    await testReceiveAndOff(browser, { wide: true });
    await testChinese(browser);
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 rule sync: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

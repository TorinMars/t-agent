// Browser test of the environment page: the tab below "File sync", the report drawn with problems first, and what happens on re-check.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

const report = {
  checked_at: Date.UTC(2026, 9, 26, 10, 0, 0),
  machine: { platform: 'Darwin 22.6.0', arch: 'x64', node: 'v24.22.0', user: 'torin' },
  summary: { ok: 2, warn: 1, fail: 1 },
  features: [
    { id: 'terminal', name: 'Terminals', description: 'Task terminals', status: 'ok', checks: [{ id: 'pty', name: 'Terminal engine (node-pty)', status: 'ok', detail: 'A terminal starts' }] },
    { id: 'codex-chat', name: 'Codex agent chat', description: 'The Codex conversation view', status: 'fail', checks: [
      { id: 'engine', name: 'Codex app server and account', status: 'fail', detail: 'The codex command was not found <img src=x onerror="window.pwned=1">', fix: 'Install Codex, or set `CODEX_PATH` in .env to its full path, then restart the Client', impact: 'The Codex chat view cannot start' },
    ] },
    { id: 'apps', name: 'App list (PM2)', description: 'Starting and stopping services', status: 'warn', checks: [
      { id: 'pm2', name: 'pm2', status: 'warn', detail: 'pm2 was not found', fix: 'Install it with `npm install -g pm2`', impact: 'The PM2 actions of the app list are unavailable' },
    ] },
    { id: 'tunnel', name: 'Public tunnel (frpc)', description: 'Reaching the Client from the internet', status: 'info', checks: [{ id: 'frpc', name: 'frpc', status: 'info', detail: 'Not installed' }] },
  ],
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8') });
    await page.evaluate(report => {
      const quiet = { setActive() {}, setEngine() {} };
      window.Apps = window.AgentConfig = window.Frp = window.FileSyncUI = quiet;
      window.fetched = 0;
      window.next = () => Promise.resolve(report);
      window.API = { get: async url => { fetched++; if (url !== '/api/environment/check') throw new Error(`unexpected ${url}`); return next(); } };
    }, report);
    for (const file of ['environment-check.js', 'tools.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });

    // The tab is right below "File sync" in the navigation.
    assert.deepEqual(await page.locator('.main-nav-item').evaluateAll(items => items.map(item => item.id)), ['tab-tasks', 'tab-tools', 'tab-apps', 'tab-agent-config', 'tab-frp', 'tab-file-sync', 'tab-environment']);
    assert.equal(await page.locator('#tab-environment .main-nav-label').textContent(), 'Environment');
    assert.equal(await page.locator('#environment-panel').isHidden(), true);
    assert.equal(await page.evaluate(() => fetched), 0, 'nothing is checked until the page is opened');

    // Opening it runs the check and shows what will not work first.
    await page.click('#tab-environment');
    await page.waitForSelector('.env-feature');
    assert.equal(await page.evaluate(() => fetched), 1);
    assert.equal(await page.locator('#environment-panel').isVisible(), true);
    assert.equal(await page.evaluate(() => document.body.classList.contains('environment-open')), true);
    for (const other of ['tools-panel', 'apps-panel', 'agent-config-panel', 'frp-panel', 'file-sync-panel']) assert.equal(await page.locator(`#${other}`).isHidden(), true, other);
    assert.equal(await page.locator('#tab-environment').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.locator('.env-feature .env-feature-name').allTextContents(), ['Codex agent chat', 'App list (PM2)', 'Terminals', 'Public tunnel (frpc)'], 'will not work, needs attention, works, not in use');
    assert.equal(await page.locator('.env-headline').textContent(), '1 feature will not work');
    assert.equal(await page.locator('.env-counts').textContent(), '1 will not work · 1 need attention · 2 fine');
    assert.equal(await page.locator('#env-summary').getAttribute('class'), 'env-summary fail');
    assert.match(await page.locator('#env-machine').textContent(), /^Darwin 22\.6\.0 · Node v24\.22\.0 · x64 · user torin · checked /);

    // The features with a problem are open, the others folded.
    assert.deepEqual(await page.locator('.env-feature').evaluateAll(nodes => nodes.map(node => [node.dataset.feature, node.open])), [['codex-chat', true], ['apps', true], ['terminal', false], ['tunnel', false]]);
    const codex = page.locator('.env-feature[data-feature="codex-chat"]');
    assert.equal(await codex.locator('.env-feature-state').textContent(), 'Will not work');
    assert.equal(await codex.locator('.env-affects-title').textContent(), 'What will not work');
    assert.deepEqual(await codex.locator('.env-affects li').allTextContents(), ['The Codex chat view cannot start']);
    assert.equal(await codex.locator('.env-impact').textContent(), 'Affects: The Codex chat view cannot start');
    assert.equal(await codex.locator('.env-fix').textContent(), 'What to do: Install Codex, or set CODEX_PATH in .env to its full path, then restart the Client');
    assert.equal(await codex.locator('.env-fix code').textContent(), 'CODEX_PATH', 'text between backticks is shown as code');
    assert.equal(await codex.locator('.env-feature-head .env-badge.fail').getAttribute('aria-label'), 'Will not work');
    assert.equal(await codex.locator('.env-check .env-badge.fail').count(), 1, 'and the failed check has its own');
    assert.equal(await page.locator('.env-feature[data-feature="apps"] .env-affects-title').textContent(), 'What may not work');
    assert.equal(await page.locator('.env-feature[data-feature="terminal"] .env-affects').count(), 0, 'a feature that works lists nothing that fails');
    // What a check says is text, never markup.
    assert.equal(await codex.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.match(await codex.locator('.env-check-detail').textContent(), /<img src=x onerror="window\.pwned=1">/);
    await page.locator('.env-feature[data-feature="terminal"] summary').click();
    assert.equal(await page.locator('.env-feature[data-feature="terminal"] .env-check-detail').isVisible(), true, 'a folded feature opens with a click');

    // Opening the page again does not check again; the button does, and is busy meanwhile.
    await page.click('#tab-tasks');
    assert.equal(await page.locator('#environment-panel').isHidden(), true);
    await page.click('#tab-environment');
    assert.equal(await page.evaluate(() => fetched), 1);
    await page.evaluate(() => { window.release = null; window.next = () => new Promise(resolve => { window.release = resolve; }); });
    await page.click('#env-recheck');
    assert.equal(await page.locator('#env-recheck').isDisabled(), true);
    assert.equal(await page.locator('#env-recheck').textContent(), 'Checking…');
    await page.click('#env-recheck', { force: true }).catch(() => {});
    assert.equal(await page.evaluate(() => fetched), 2, 'a second click while it runs starts nothing');
    await page.evaluate(report => window.release({ ...report, summary: { ok: 4, warn: 0, fail: 0 }, features: report.features.map(feature => ({ ...feature, status: 'ok', checks: feature.checks.map(check => ({ ...check, status: 'ok', fix: '', impact: '' })) })) }), report);
    await page.waitForFunction(() => !document.getElementById('env-recheck').disabled);
    assert.equal(await page.locator('#env-recheck').textContent(), 'Check again');
    assert.equal(await page.locator('.env-headline').textContent(), 'Everything checked works');
    assert.equal(await page.locator('.env-counts').count(), 0);
    assert.equal(await page.locator('#env-summary').getAttribute('class'), 'env-summary ok');

    // A check that cannot be run says so, and the button tries again.
    await page.evaluate(() => { window.next = () => Promise.reject(new Error('The environment check failed')); });
    await page.click('#env-recheck');
    await page.waitForFunction(() => document.querySelector('.env-headline').textContent === 'The check could not be run');
    assert.equal(await page.locator('.env-counts').textContent(), 'The environment check failed');
    assert.equal(await page.locator('#env-summary').getAttribute('class'), 'env-summary fail');

    // On a remote engine the page says that it checks the machine running the Client.
    await page.evaluate(() => EnvironmentCheck.setEngine({ local: false, label: 'Shanghai' }));
    assert.equal(await page.locator('#env-engine').textContent(), 'This page checks the machine running the Client, not the remote engine Shanghai');
    await page.evaluate(() => EnvironmentCheck.setEngine({ local: true, label: 'Default' }));
    assert.equal(await page.locator('#env-engine').textContent(), '');
    assert.deepEqual(errors, []);
    console.log('Environment page: tab below File sync, report sorted with problems open, safe text, busy button, error state and remote note passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Settings -> T-Attention -> "Agent skill" (scripts/h5-shell/AttentionSkillSettings.jsx) in real Chromium, against a mocked /api/attention/skill:
// - phone 390x844 (touch): not installed for either agent, the old task-tracker skill found for both: the chips, the paths, the note; "Replace the old
//   task-tracker skill" calls POST /install and then POST /remove-old, and the lines say what happened; the old note goes; the button says "Up to date".
//   Everything fits the width, the buttons are 44px high.
// - computer 1440x900 (mouse): Claude is out of date, Codex is managed by the rules and skills sync: "Update" installs, the refused one is reported.
// - phone 390x844 in Chinese: the texts of the card are translated.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const CLAUDE = '/Users/me/.claude/skills/t-attention/SKILL.md';
const CODEX = '/Users/me/.codex/skills/t-attention/SKILL.md';

const state = (fields = {}) => ({ installed: false, path: CLAUDE, current: false, conflict: null, ...fields });
const view = (claude, codex, old = { claude: false, codex: false }) => ({ claude: state(claude), codex: state({ path: CODEX, ...codex }), old_task_tracker: old, cli: { path: '/opt/t-agent/scripts/t-attention.js', found: true }, user: null });

async function openPage(browser, { wide = false, chinese = false, model }) {
  const context = await browser.newContext({ viewport: wide ? { width: 1440, height: 900 } : { width: 390, height: 844 }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(SHOTS && !wide ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(language => {
    if (language) localStorage.setItem('ta-lang', language);
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } };
    window.WebSocket.OPEN = 1;
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; } close() {} };
  }, chinese ? 'zh' : null);
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/service-links') return json({ links: [], supported: true });
    if (pathname === '/api/tasks') return json([{ id: 1, title: 'Alpha', status: 'doing' }]);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (/^\/api\/tasks\/\d+\/terminals$/.test(pathname)) return json([]);
    if (pathname.startsWith('/api/attention/skill')) {
      model.calls.push(`${method} ${pathname}`);
      if (pathname === '/api/attention/skill' && method === 'GET') return json(model.view);
      if (pathname === '/api/attention/skill/install' && method === 'POST') { const answer = model.install(); model.view = answer.status; return json(answer); }
      if (pathname === '/api/attention/skill/remove-old' && method === 'POST') { const answer = model.removeOld(); model.view = answer.status; return json(answer); }
    }
    if (pathname === '/api/attention' && method === 'GET') return json({ items: [], host: 'mac' });
    if (pathname === '/api/attention/plugins') return json({ listeners: [], notifiers: [] });
    if (pathname === '/api/attention/settings/guide') return json({ dismissed: true, pageOnly: false, paired: false, tested: false, updatedAt: null });
    if (pathname === '/api/attention/tokens') return json({ tokens: [] });
    if (pathname === '/api/attention/settings/summary') return json({ enabled: false, provider: 'deepseek', model: '', providers: [] });
    if (pathname === '/api/attention/market') return json({ plugins: [] });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.H5UI && window.H5UI.get().sources.length > 0);
  const press = locator => (wide ? locator.click() : locator.tap());
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await settled();
  const summary = page.locator('#h5-set-attention .MuiAccordionSummary-root');
  await summary.scrollIntoViewIfNeeded();
  await press(summary);
  await page.locator('#h5-skill .h5-skill-agent').first().waitFor();
  const tap = async selector => { const target = page.locator(selector); await target.scrollIntoViewIfNeeded(); await settled(); await press(target); };
  const shot = async name => { if (SHOTS) { await page.locator('#h5-skill-install').scrollIntoViewIfNeeded(); await settled(); await page.screenshot({ path: path.join(SHOTS, `attention-skill-${name}.png`) }); } };
  return { context, page, errors, tap, shot };
}

const chip = (page, agent) => page.locator(`.h5-skill-agent[data-agent="${agent}"] .h5-skill-chip`).innerText();

async function assertFits(page) {
  const result = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-slot="skill"], [data-slot="skill"] *')];
    const inner = document.documentElement.clientWidth;
    const outside = nodes.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > inner + 0.5 || r.left < -0.5); }).map(el => el.id || el.className || el.tagName);
    const small = [...document.querySelectorAll('[data-slot="skill"] button')].filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height < 43.99).map(el => el.id);
    return { outside, small };
  });
  assert.deepEqual(result.outside, [], 'nothing is wider than the screen');
  assert.deepEqual(result.small, [], 'every button is at least 44px high');
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844: nothing installed, the old skill for both; replace it ──
    {
      const installed = view({ installed: true, current: true }, { installed: true, current: true }, { claude: true, codex: true });
      const model = {
        calls: [],
        view: view({}, {}, { claude: true, codex: true }),
        install: () => ({ ok: true, results: { claude: { action: 'installed', path: CLAUDE }, codex: { action: 'installed', path: CODEX } }, status: installed }),
        removeOld: () => ({ ok: true, backup: '/Users/me/.tagent/backups/task-tracker-2026-11-12T10-20-30-456Z', moved: [
          { agent: 'claude', from: '/Users/me/.claude/skills/task-tracker', to: '/Users/me/.tagent/backups/task-tracker-2026-11-12T10-20-30-456Z/claude/task-tracker' },
          { agent: 'codex', from: '/Users/me/.codex/skills/task-tracker', to: '/Users/me/.tagent/backups/task-tracker-2026-11-12T10-20-30-456Z/codex/task-tracker' },
        ], skipped: [], status: view({ installed: true, current: true }, { installed: true, current: true }) }),
      };
      const { context, page, errors, tap, shot } = await openPage(browser, { model });
      assert.equal(await chip(page, 'claude'), 'Not installed');
      assert.equal(await chip(page, 'codex'), 'Not installed');
      assert.equal(await page.locator('.h5-skill-agent[data-agent="codex"] .h5-skill-path').innerText(), CODEX);
      assert.equal(await page.locator('#h5-skill-install').innerText(), 'Install');
      assert.match(await page.locator('#h5-skill-old').innerText(), /old task-tracker skill is still installed[\s\S]*Claude Code, Codex/);
      await assertFits(page);
      await shot('phone-before');
      await tap('#h5-skill-replace-old');
      await page.locator('#h5-skill-old').waitFor({ state: 'detached' });
      assert.deepEqual(model.calls, ['GET /api/attention/skill', 'POST /api/attention/skill/install', 'POST /api/attention/skill/remove-old'], 'install first, then move the old one');
      const said = await page.locator('#h5-skill-feedback').innerText();
      assert.match(said, /^Claude Code: Installed\nCodex: Installed\nClaude Code: The old task-tracker skill was moved to \/Users\/me\/\.tagent\/backups\/task-tracker-[^\n]+\/claude\/task-tracker\nCodex: /);
      assert.equal(await chip(page, 'claude'), 'Installed');
      assert.equal(await page.locator('#h5-skill-install').isDisabled(), true);
      assert.equal(await page.locator('#h5-skill-install').innerText(), 'Up to date');
      await assertFits(page);
      await shot('phone-after');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Computer 1440x900: Claude out of date, Codex owned by the sync ──
    {
      const model = {
        calls: [],
        view: view({ installed: true, current: false }, { installed: true, current: false, conflict: 'rule-sync', sync_source: 'Studio' }),
        install: () => ({ ok: false, results: { claude: { action: 'updated', path: CLAUDE }, codex: { action: 'refused', path: CODEX, conflict: 'rule-sync', sync_source: 'Studio' } },
          status: view({ installed: true, current: true }, { installed: true, current: false, conflict: 'rule-sync', sync_source: 'Studio' }) }),
        removeOld: () => { throw new Error('not expected'); },
      };
      const { context, page, errors, tap } = await openPage(browser, { wide: true, model });
      assert.equal(await chip(page, 'claude'), 'Update available');
      assert.equal(await chip(page, 'codex'), 'Managed by the rules and skills sync');
      assert.ok(await page.locator('#h5-skill-sync-note').isVisible());
      assert.equal(await page.locator('#h5-skill-old').count(), 0, 'no old skill, no note');
      assert.equal(await page.locator('#h5-skill-install').innerText(), 'Update');
      await tap('#h5-skill-install');
      await page.locator('#h5-skill-feedback', { hasText: 'Codex' }).waitFor();
      assert.equal(await page.locator('#h5-skill-feedback').innerText(), 'Claude Code: Updated\nCodex: Not changed: this folder is managed elsewhere');
      assert.equal(await page.locator('#h5-skill-feedback').evaluate(node => getComputedStyle(node).color !== getComputedStyle(document.querySelector('#h5-skill .h5-skill-path')).color), true, 'a refusal is shown as an error');
      assert.equal(await chip(page, 'claude'), 'Installed');
      assert.equal(await page.locator('#h5-skill-install').isDisabled(), true, 'the only writable one is up to date');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 390x844 in Chinese ──
    {
      const model = { calls: [], view: view({ installed: true, current: true }, {}, { claude: true, codex: false }), install: () => ({ ok: true, results: { claude: { action: 'unchanged', path: CLAUDE }, codex: { action: 'installed', path: CODEX } }, status: view({ installed: true, current: true }, { installed: true, current: true }, { claude: true, codex: false }) }), removeOld: () => { throw new Error('not expected'); } };
      const { context, page, errors, tap, shot } = await openPage(browser, { chinese: true, model });
      const card = await page.locator('[data-slot="skill"]').innerText();
      assert.ok(card.includes('\u667a\u80fd\u4f53\u6280\u80fd'), 'the heading is translated');
      assert.equal(await chip(page, 'claude'), '\u5df2\u5b89\u88c5');
      assert.ok(card.includes('\u66ff\u6362\u65e7\u7684 task-tracker \u6280\u80fd'), 'the replace button is translated');
      assert.ok(!/The t-attention skill teaches|old task-tracker skill is still|Agent skill|Not installed/.test(card), `no English left: ${card}`);
      await assertFits(page);
      await shot('phone-zh');
      await tap('#h5-skill-install');
      await page.locator('#h5-skill-feedback', { hasText: 'Codex' }).waitFor();
      const said = await page.locator('#h5-skill-feedback').innerText();
      assert.ok(said.startsWith('Claude Code: ') && !/Already up to date|Installed/.test(said), `translated lines: ${said}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 attention skill browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

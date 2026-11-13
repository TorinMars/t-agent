// Settings -> Tasks and files -> "Agent skills" (scripts/h5-shell/AgentSkillsSettings.jsx), the pointer to it in T-Attention (AttentionSkillSettings.jsx)
// and the tcli switch of "Image and file upload" (Settings.jsx OssAgentAccess) in real Chromium, against a mocked /api/agent-skills and /api/oss/agent-access:
// - phone 390x844 (touch): both skills listed in order, nothing installed, the old task-tracker skill found for both: chips, paths, the note; "Replace
//   the old task-tracker skill" installs t-attention and then moves the old one; Install of tcli installs only tcli; the OSS switch is on, turning it off
//   sends PUT { enabled: false }, a failed PUT shows the error and what is really in effect. Everything fits, the buttons are 44px high.
// - phone 320x700: everything still fits.
// - computer 1440x900 (mouse): tcli is out of date for Claude and managed by the rules and skills sync for Codex: Update reports the refusal; an older
//   server without /api/oss/agent-access (404): no switch; the pointer in T-Attention opens Tasks and files at "Agent skills".
// - phone 390x844 in Chinese: the texts of the part, the descriptions and the switch are translated.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const DESCRIPTIONS = {
  't-attention': 'Teaches Claude Code and Codex to register their work and their sub-agents in T-Attention, to ask you when they need you, and to wait for your confirmation of finished work.',
  tcli: 'Teaches Claude Code and Codex to list, upload, download, copy, move and delete files in the bucket of "Image and file upload" with the tcli command.',
};
const where = (agent, name) => `/Users/me/.${agent}/skills/${name}/SKILL.md`;

const state = (agent, name, fields = {}) => ({ installed: false, path: where(agent, name), current: false, conflict: null, ...fields });
const skill = (name, claude = {}, codex = {}) => ({ name, description: DESCRIPTIONS[name], claude: state('claude', name, claude), codex: state('codex', name, codex), cli: { path: `/opt/t-agent/scripts/${name}.js`, found: true } });
const view = (skills, old = { claude: false, codex: false }) => ({ skills, old_task_tracker: old, user: null });
const done = { installed: true, current: true };

async function openPage(browser, { width = 390, height = 844, wide = false, chinese = false, model }) {
  const context = await browser.newContext({ viewport: wide ? { width: 1440, height: 900 } : { width, height }, ...(wide ? {} : { isMobile: true, hasTouch: true }), ...(SHOTS && !wide ? { deviceScaleFactor: 3 } : {}) });
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
    if (pathname === '/auth/me') return json({ work_dir: null, effective_work_dir: '/Users/me/tasks' });
    if (pathname === '/api/oss/config') return json({ enabled: true, region: 'oss-cn-hangzhou', bucket: 'my-bucket', accessKeyId: 'AK', hasAccessKeySecret: true, prefix: 'terminal-images/', publicBaseUrl: '' });
    if (pathname === '/api/oss/agent-access') {
      model.calls.push(`${method} ${pathname}${method === 'PUT' ? ` ${request.postData()}` : ''}`);
      if (!model.access) return json({ error: 'NOT_FOUND' }, 404);
      if (method === 'GET') return json({ enabled: model.access.enabled });
      if (method === 'PUT') {
        if (model.access.failPut) return json({ error: 'SAVE_FAILED', message: 'Could not save' }, 500);
        model.access.enabled = JSON.parse(request.postData()).enabled;
        return json({ enabled: model.access.enabled });
      }
    }
    if (pathname.startsWith('/api/agent-skills')) {
      model.calls.push(`${method} ${pathname}`);
      if (pathname === '/api/agent-skills' && method === 'GET') return json(model.view);
      const install = /^\/api\/agent-skills\/([^/]+)\/install$/.exec(pathname);
      if (install && method === 'POST') { const answer = model.install(install[1]); model.view = answer.status; return json(answer); }
      if (pathname === '/api/agent-skills/t-attention/remove-old' && method === 'POST') { const answer = model.removeOld(); model.view = answer.status; return json(answer); }
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
  const openGroup = async id => {
    const summary = page.locator(`#h5-set-${id} .MuiAccordionSummary-root`);
    await summary.scrollIntoViewIfNeeded();
    await press(summary);
    await page.waitForFunction(groupId => Boolean(document.querySelector(`#h5-set-${groupId} > .MuiCollapse-entered`)), id);
    await settled();
  };
  const tap = async selector => { const target = page.locator(selector); await target.scrollIntoViewIfNeeded(); await settled(); await press(target); };
  const shot = async (name, selector = '#h5-sec-agent-skills') => { if (SHOTS) { await page.locator(selector).scrollIntoViewIfNeeded(); await settled(); await page.screenshot({ path: path.join(SHOTS, `agent-skills-${name}.png`) }); } };
  return { context, page, errors, tap, shot, openGroup, settled };
}

const chip = (page, name, agent) => page.locator(`.h5-agent-skill[data-skill="${name}"] .h5-skill-agent[data-agent="${agent}"] .h5-skill-chip`).innerText();
const button = (name) => `#h5-agent-skill-install-${name}`;

async function assertFits(page, label) {
  const result = await page.evaluate(() => {
    const scope = ['#h5-sec-agent-skills', '#h5-oss-agent'].map(id => document.querySelector(id)).filter(Boolean);
    const nodes = scope.flatMap(node => [node, ...node.querySelectorAll('*')]);
    const inner = document.documentElement.clientWidth;
    const outside = nodes.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > inner + 0.5 || r.left < -0.5); }).map(el => el.id || String(el.className).slice(0, 60) || el.tagName);
    const small = scope.flatMap(node => [...node.querySelectorAll('button')]).filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height < 43.99).map(el => el.id);
    return { outside, small, scroll: document.documentElement.scrollWidth - innerWidth };
  });
  assert.deepEqual(result.outside, [], `${label}: nothing is wider than the screen`);
  assert.ok(result.scroll <= 0, `${label}: no horizontal page scroll`);
  assert.deepEqual(result.small, [], `${label}: every button is at least 44px high`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844: nothing installed, the old skill for both; replace it, install tcli, the OSS switch ──
    {
      let skills = [skill('t-attention'), skill('tcli')];
      const model = {
        calls: [],
        access: { enabled: true },
        view: view(skills, { claude: true, codex: true }),
        install: name => {
          skills = skills.map(item => (item.name === name ? skill(name, done, done) : item));
          return { ok: true, name, results: { claude: { action: 'installed', path: where('claude', name) }, codex: { action: 'installed', path: where('codex', name) } }, status: view(skills, model.view.old_task_tracker) };
        },
        removeOld: () => ({ ok: true, backup: '/Users/me/.tagent/backups/task-tracker-2026-11-12T10-20-30-456Z', moved: [
          { agent: 'claude', from: '/Users/me/.claude/skills/task-tracker', to: '/Users/me/.tagent/backups/task-tracker-2026-11-12T10-20-30-456Z/claude/task-tracker' },
          { agent: 'codex', from: '/Users/me/.codex/skills/task-tracker', to: '/Users/me/.tagent/backups/task-tracker-2026-11-12T10-20-30-456Z/codex/task-tracker' },
        ], skipped: [], status: view(skills) }),
      };
      const { context, page, errors, tap, shot, openGroup } = await openPage(browser, { model });
      await openGroup('tasks-files');
      await page.locator('#h5-agent-skills .h5-agent-skill').first().waitFor();
      assert.deepEqual(await page.locator('#h5-agent-skills .h5-agent-skill').evaluateAll(nodes => nodes.map(node => node.dataset.skill)), ['t-attention', 'tcli']);
      assert.equal(await page.locator('#h5-sec-agent-skills-title').innerText(), 'Agent skills');
      assert.equal(await page.locator('.h5-agent-skill[data-skill="tcli"] .h5-agent-skill-description').innerText(), DESCRIPTIONS.tcli);
      for (const name of ['t-attention', 'tcli']) for (const agent of ['claude', 'codex']) assert.equal(await chip(page, name, agent), 'Not installed');
      assert.equal(await page.locator('.h5-agent-skill[data-skill="tcli"] .h5-skill-agent[data-agent="codex"] .h5-skill-path').innerText(), where('codex', 'tcli'));
      assert.equal(await page.locator(button('tcli')).innerText(), 'Install');
      assert.match(await page.locator('#h5-skill-old').innerText(), /old task-tracker skill is still installed[\s\S]*Claude Code, Codex/);
      // The OSS switch, in "Image and file upload".
      await page.waitForFunction(() => document.getElementById('h5-oss-agent-enabled') && !document.getElementById('h5-oss-agent-enabled').disabled);
      assert.equal(await page.locator('#h5-oss-agent-enabled').isChecked(), true);
      assert.equal(await page.locator('#h5-oss-agent-enabled').evaluate(node => node.closest('#h5-sec-oss') !== null), true, 'the switch is a part of Image and file upload');
      assert.match(await page.locator('#h5-oss-agent').innerText(), /^Let agent sessions manage OSS files \(tcli\)\n+Claude and Codex sessions in T-Agent terminals can manage files in this bucket with tcli \(list, upload, download, copy, move, delete\)\. The access key stays on this server\./);
      await assertFits(page, 'phone before');
      await shot('phone-before');
      await shot('phone-oss', '#h5-oss-agent');

      await tap('#h5-skill-replace-old');
      await page.locator('#h5-skill-old').waitFor({ state: 'detached' });
      assert.deepEqual(model.calls.filter(call => call.includes('agent-skills')), ['GET /api/agent-skills', 'POST /api/agent-skills/t-attention/install', 'POST /api/agent-skills/t-attention/remove-old'], 'install first, then move the old one');
      const said = await page.locator('#h5-agent-skills-feedback').innerText();
      assert.match(said, /^t-attention · Claude Code: Installed\nt-attention · Codex: Installed\nClaude Code: The old task-tracker skill was moved to \/Users\/me\/\.tagent\/backups\/task-tracker-[^\n]+\/claude\/task-tracker\nCodex: /);
      assert.equal(await chip(page, 't-attention', 'claude'), 'Installed');
      assert.equal(await chip(page, 'tcli', 'claude'), 'Not installed', 'only t-attention was installed');
      assert.equal(await page.locator(button('t-attention')).innerText(), 'Up to date');
      assert.equal(await page.locator(button('t-attention')).isDisabled(), true);

      await tap(button('tcli'));
      await page.locator('#h5-agent-skills-feedback', { hasText: 'tcli · Codex' }).waitFor();
      assert.equal(await page.locator('#h5-agent-skills-feedback').innerText(), 'tcli · Claude Code: Installed\ntcli · Codex: Installed');
      assert.equal(await chip(page, 'tcli', 'codex'), 'Installed');
      assert.equal(await page.locator(button('tcli')).isDisabled(), true);

      // Off, then a failed save shows the error and what is in effect.
      await tap('#h5-oss-agent-enabled');
      await page.locator('#h5-oss-agent-feedback', { hasText: 'Saved' }).waitFor();
      assert.ok(model.calls.includes('PUT /api/oss/agent-access {"enabled":false}'), model.calls.join(', '));
      assert.equal(await page.locator('#h5-oss-agent-enabled').isChecked(), false);
      model.access.failPut = true;
      await tap('#h5-oss-agent-enabled');
      await page.locator('#h5-oss-agent-feedback', { hasText: 'Failed' }).waitFor();
      await page.waitForFunction(() => !document.getElementById('h5-oss-agent-enabled').disabled);
      assert.equal(await page.locator('#h5-oss-agent-enabled').isChecked(), false, 'the switch shows what is in effect');
      await assertFits(page, 'phone after');
      await shot('phone-after');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 320x700: it still fits ──
    {
      const model = { calls: [], access: { enabled: false }, view: view([skill('t-attention', done, { installed: true, current: false }), skill('tcli', {}, { conflict: 'rule-sync', installed: true, sync_source: 'Studio' })], { claude: true, codex: false }), install: () => { throw new Error('not expected'); }, removeOld: () => { throw new Error('not expected'); } };
      const { context, page, errors, openGroup, shot } = await openPage(browser, { width: 320, height: 700, model });
      await openGroup('tasks-files');
      await page.locator('#h5-agent-skills .h5-agent-skill').first().waitFor();
      await page.locator('#h5-oss-agent-enabled').waitFor();
      assert.equal(await page.locator('#h5-oss-agent-enabled').isChecked(), false);
      assert.equal(await chip(page, 'tcli', 'codex'), 'Managed by the rules and skills sync');
      assert.ok(await page.locator('#h5-skill-sync-note').isVisible());
      await assertFits(page, 'phone 320');
      await shot('phone-320');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Computer 1440x900: an update with a refusal, no switch on an older server, the pointer in T-Attention ──
    {
      const after = view([skill('t-attention', done, done), skill('tcli', done, { installed: true, current: false, conflict: 'rule-sync', sync_source: 'Studio' })]);
      const model = {
        calls: [],
        access: null,
        view: view([skill('t-attention', done, done), skill('tcli', { installed: true, current: false }, { installed: true, current: false, conflict: 'rule-sync', sync_source: 'Studio' })]),
        install: name => ({ ok: false, name, results: { claude: { action: 'updated', path: where('claude', name) }, codex: { action: 'refused', path: where('codex', name), conflict: 'rule-sync', sync_source: 'Studio' } }, status: after }),
        removeOld: () => { throw new Error('not expected'); },
      };
      const { context, page, errors, tap, openGroup, settled } = await openPage(browser, { wide: true, model });
      // The pointer in T-Attention opens Tasks and files at Agent skills.
      await openGroup('attention');
      assert.equal(await page.locator('[data-slot="skill"]').innerText().then(text => text.replace(/\s+/g, ' ').trim()), 'Agent skill: Settings → Tasks and files → Agent skills Open');
      assert.equal(await page.locator('[data-slot="skill"] .h5-agent-skill').count(), 0, 'no card in T-Attention any more');
      await tap('#h5-skill-open');
      await page.waitForFunction(() => Boolean(document.querySelector('#h5-set-tasks-files > .MuiCollapse-entered')));
      await settled();
      await page.locator('#h5-agent-skills .h5-agent-skill').first().waitFor();
      const shown = await page.evaluate(() => {
        const body = document.querySelector('#h5-settings .h5-settings-body').getBoundingClientRect();
        const box = document.getElementById('h5-sec-agent-skills').getBoundingClientRect();
        return box.top >= body.top - 1 && box.top < body.bottom - 20;
      });
      assert.ok(shown, 'the part Agent skills is scrolled into view');

      assert.equal(await chip(page, 'tcli', 'claude'), 'Update available');
      assert.equal(await chip(page, 'tcli', 'codex'), 'Managed by the rules and skills sync');
      assert.equal(await page.locator('#h5-skill-old').count(), 0, 'no old skill, no note');
      assert.equal(await page.locator(button('t-attention')).innerText(), 'Up to date');
      assert.equal(await page.locator(button('tcli')).innerText(), 'Update');
      await tap(button('tcli'));
      await page.locator('#h5-agent-skills-feedback', { hasText: 'Codex' }).waitFor();
      assert.equal(await page.locator('#h5-agent-skills-feedback').innerText(), 'tcli · Claude Code: Updated\ntcli · Codex: Not changed: this folder is managed elsewhere');
      assert.equal(await page.locator('#h5-agent-skills-feedback').evaluate(node => getComputedStyle(node).color !== getComputedStyle(document.querySelector('#h5-agent-skills .h5-skill-path')).color), true, 'a refusal is shown as an error');
      assert.equal(await page.locator(button('tcli')).isDisabled(), true, 'the only writable one is up to date');
      // An older server: no switch, and nothing else is missing from the upload settings.
      assert.equal(await page.locator('#h5-oss-agent-enabled').count(), 0);
      assert.equal(await page.locator('#h5-oss-agent').isHidden(), true);
      assert.ok(await page.locator('#h5-oss-save').isVisible());
      assert.deepEqual(model.calls.filter(call => call.includes('agent-access')), ['GET /api/oss/agent-access']);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 390x844 in Chinese ──
    {
      const model = { calls: [], access: { enabled: true }, view: view([skill('t-attention', done, done), skill('tcli')], { claude: true, codex: false }), install: name => ({ ok: true, name, results: { claude: { action: 'installed', path: where('claude', name) }, codex: { action: 'installed', path: where('codex', name) } }, status: view([skill('t-attention', done, done), skill('tcli', done, done)], { claude: true, codex: false }) }), removeOld: () => { throw new Error('not expected'); } };
      const { context, page, errors, tap, shot, openGroup } = await openPage(browser, { chinese: true, model });
      await openGroup('tasks-files');
      await page.locator('#h5-agent-skills .h5-agent-skill').first().waitFor();
      await page.locator('#h5-oss-agent-enabled').waitFor();
      const part = await page.locator('#h5-sec-agent-skills').innerText();
      assert.ok(part.includes('\u667a\u80fd\u4f53\u6280\u80fd'), 'the heading is translated');
      assert.equal(await chip(page, 't-attention', 'claude'), '\u5df2\u5b89\u88c5');
      assert.ok(part.includes('\u66ff\u6362\u65e7\u7684 task-tracker \u6280\u80fd'), 'the replace button is translated');
      assert.ok(part.includes('tcli') && part.includes('t-attention') && part.includes('Claude Code'), 'names stay as they are');
      assert.ok(!/Teaches|Skills teach|old task-tracker skill is still|Agent skills|Not installed|Up to date|Install\b/.test(part), `no English left: ${part}`);
      const access = await page.locator('#h5-oss-agent').innerText();
      assert.ok(access.includes('\u5141\u8bb8\u667a\u80fd\u4f53\u4f1a\u8bdd\u7ba1\u7406 OSS \u6587\u4ef6\uff08tcli\uff09'), `the switch is translated: ${access}`);
      assert.ok(!/Let agent sessions|The access key never/.test(access), access);
      await assertFits(page, 'phone zh');
      await shot('phone-zh');
      await tap(button('tcli'));
      await page.locator('#h5-agent-skills-feedback', { hasText: 'Codex' }).waitFor();
      const said = await page.locator('#h5-agent-skills-feedback').innerText();
      assert.ok(said.startsWith('tcli · Claude Code: ') && !/Installed/.test(said), `translated lines: ${said}`);
      // The pointer in T-Attention.
      await openGroup('attention');
      const pointer = await page.locator('[data-slot="skill"]').innerText();
      assert.ok(pointer.includes('\u667a\u80fd\u4f53\u6280\u80fd\uff1a\u8bbe\u7f6e') && !/Agent skill|Open/.test(pointer), `the pointer is translated: ${pointer}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 agent skills browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

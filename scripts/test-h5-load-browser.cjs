// How the phone / computer page (/h5) loads, in real Chromium: the scripts are deferred and run in their order, a static skeleton is painted before
// they run and has the same bars as the shell, the start requests go out together and the remembered terminal's socket opens before its list
// arrives (and is closed when that terminal is gone), and the Chinese dictionaries are loaded only for Chinese (also after a language switch).
// The page is served through lib/static-assets.js, like server.js does (content-hash URLs, dictionaries by the ta-lang cookie).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createStaticAssets } = require('../lib/static-assets');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5-load.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css' };
const assets = createStaticAssets({ publicDir: path.join(root, 'public') });
const pageErrors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// delays: url path -> ms before the mocked answer; terminals: the terminal list of task 1.
async function openPage(browser, { viewport = { width: 390, height: 844 }, touch = viewport.width < 900, saved = { task: 1, terminal: 'h5-default' }, delays = {}, terminals = [{ terminal_id: 'h5-default', title: 'Terminal 1' }, { terminal_id: 'h5-other', title: 'Terminal 2' }], lang = null, cookie = null, holdScripts = false } = {}) {
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  if (cookie) await context.addCookies([{ name: 'ta-lang', value: cookie, url: ORIGIN }]);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const log = []; // { at, what } in the order things happened (requests asked, answers sent, sockets made)
  const t0 = Date.now();
  const mark = what => log.push({ at: Date.now() - t0, what });
  await page.exposeFunction('markSocket', url => mark(`WS ${new URL(url).search}`));
  await page.addInitScript(({ saved, lang }) => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      if (saved) { localStorage.setItem('h5-task:local', String(saved.task)); localStorage.setItem(`h5-terminal:local:${saved.task}`, saved.terminal); }
      if (lang) localStorage.setItem('ta-lang', lang);
    }
    window.sockets = [];
    window.FakeSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closedWith = null; window.sockets.push(this); window.markSocket(url); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
      send(data) { this.sent.push(data); }
      close(code) { this.readyState = 3; this.closedWith = code === undefined ? 'none' : code; }
    };
    window.FakeSocket.OPEN = 1;
    window.FakeSocket.CONNECTING = 0;
    window.WebSocket = window.FakeSocket;
  }, { saved, lang });
  const requests = [];
  let release = null;
  const scriptsHeld = holdScripts ? new Promise(resolve => { release = resolve; }) : null;
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const json = async body => { if (delays[url.pathname]) await wait(delays[url.pathname]); mark(`done ${url.pathname}`); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }); };
    if (url.pathname === '/h5') {
      const zh = /(?:^|;\s*)ta-lang=zh(?:;|$)/.test(route.request().headers().cookie || '');
      return route.fulfill({ contentType: 'text/html', body: assets.rewritePage(fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8'), { zh }) });
    }
    if (/^\/(js|css|vendor)\//.test(url.pathname)) {
      if (scriptsHeld && url.pathname === '/js/h5-shell.js') await scriptsHeld;
      return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    }
    if (url.pathname.startsWith('/api/')) mark(`ask ${url.pathname}`);
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'todo' }]);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/tasks/1/terminals') return json(terminals);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
    if (url.pathname === '/api/tasks/terminal-activity') return json({});
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/system/check-update') return json({ status: 'current', is_update_admin: true, local_version: '1.0.0', remote_version: '1.0.0' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' });
  });
  const goto = page.goto(`${ORIGIN}/h5`, { waitUntil: holdScripts ? 'commit' : 'load' });
  return { context, page, requests, log, release, goto };
}
const at = (log, what) => { const hit = log.find(entry => entry.what === what); assert.ok(hit, `${what} happened: ${JSON.stringify(log)}`); return hit.at; };
const asked = (log, what) => at(log, `ask ${what}`);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // 1. Every script of the page is deferred, in the same order as before, and the inline skeleton is painted while they still load.
    const html = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8');
    const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
    const external = tags.filter(attrs => /\bsrc=/.test(attrs));
    assert.ok(external.length > 20, 'the page loads its scripts');
    assert.ok(external.every(attrs => /\bdefer\b/.test(attrs)), 'every script is deferred');
    const order = external.map(attrs => /src="([^"]+)"/.exec(attrs)[1]);
    for (const [before, after] of [['/js/i18n.js', '/js/i18n-zh-ui.js'], ['/js/i18n-zh-extra.js', '/js/h5-shell.js'], ['/vendor/xterm/xterm-5.5.0.js', '/js/h5.js'], ['/js/h5-shell.js', '/js/h5.js'], ['/js/agent-chat.js', '/js/h5.js']]) {
      assert.ok(order.indexOf(before) >= 0 && order.indexOf(before) < order.indexOf(after), `${before} runs before ${after}`);
    }
    assert.ok(tags.every(attrs => /\bsrc=/.test(attrs)), 'no inline script (it would run before the deferred ones)');

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const held = await openPage(browser, { viewport, holdScripts: true });
      await held.goto;
      await held.page.locator('.h5-skeleton').waitFor();
      assert.equal(await held.page.evaluate(() => typeof window.H5UI), 'undefined', 'painted while the scripts are still loading');
      const skeleton = await held.page.evaluate(() => {
        const box = selector => { const node = document.querySelector(selector); return node ? node.getBoundingClientRect().toJSON() : null; };
        return { header: box('.h5-skeleton-header'), side: box('.h5-skeleton-side'), background: getComputedStyle(document.body).backgroundColor };
      });
      assert.equal(skeleton.background, 'rgb(18, 18, 18)', 'the dark background is there before any style sheet or script');
      held.release();
      await held.page.locator('#h5-terminal').waitFor({ state: 'attached' });
      await held.page.locator('.h5-skeleton').waitFor({ state: 'detached' });
      const shell = await held.page.evaluate(() => {
        const box = selector => { const node = document.querySelector(selector); return node ? node.getBoundingClientRect().toJSON() : null; };
        return { header: box('.h5-header'), side: box('.MuiDrawer-paper') };
      });
      // The skeleton's bars are where the shell's are, so nothing jumps when the shell takes over.
      assert.ok(Math.abs(skeleton.header.top - shell.header.top) <= 1 && Math.abs(skeleton.header.height - shell.header.height) <= 1, `header ${JSON.stringify(skeleton.header)} vs ${JSON.stringify(shell.header)} at ${viewport.width}px`);
      assert.ok(Math.abs(skeleton.header.left - shell.header.left) <= 1 && Math.abs(skeleton.header.width - shell.header.width) <= 1, `header width at ${viewport.width}px`);
      if (viewport.width >= 900) assert.ok(Math.abs(skeleton.side.width - shell.side.width) <= 1, 'the sidebar edge is where the sidebar is');
      await held.context.close();
    }

    // 2. Start: the Engine list, the tasks and the groups are asked for together; the remembered task's terminals are asked for and the remembered
    // terminal's socket is opened before the Engine list answers (slow here), and that socket is the one the terminal uses.
    const slow = await openPage(browser, { delays: { '/api/remote-servers': 600, '/api/tasks': 300 } });
    await slow.page.locator('.xterm').waitFor();
    const servers = at(slow.log, 'done /api/remote-servers');
    for (const what of ['/api/tasks', '/api/task-groups', '/api/tasks/1/terminals', '/api/tasks/1/agent/conversations']) assert.ok(asked(slow.log, what) < servers, `${what} is asked for before the Engine list answers`);
    assert.ok(at(slow.log, slow.log.find(entry => entry.what.startsWith('WS ')).what) < servers, 'the socket opens before the Engine list answers');
    const sockets = await slow.page.evaluate(() => window.sockets.map(ws => ({ url: ws.url, closed: ws.closedWith })));
    assert.equal(sockets.length, 1, 'one socket: the early one is kept');
    assert.match(sockets[0].url, /taskId=1&terminalId=h5-default/);
    assert.equal(sockets[0].closed, null);
    assert.equal(slow.requests.filter(url => url === '/api/tasks/1/terminals').length, 1, 'the terminal list is asked for once');
    // The early socket works like any other: the history it got before the terminal existed is drawn, and typing reaches it.
    await slow.page.evaluate(() => { const ws = window.sockets[0]; ws.onmessage({ data: new TextEncoder().encode(JSON.stringify({ type: 'history', data: 'EARLY-HISTORY $ ', cols: 80, rows: 24 })).buffer }); });
    await slow.page.locator('.xterm-rows', { hasText: 'EARLY-HISTORY' }).waitFor();
    await slow.context.close();

    // A history sent before the page took the socket is not lost.
    const buffered = await openPage(browser, { delays: { '/api/tasks/1/terminals': 400 } });
    await buffered.page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
    await buffered.page.evaluate(() => { const ws = window.sockets[0]; ws.onmessage({ data: new TextEncoder().encode(JSON.stringify({ type: 'history', data: 'BUFFERED-HISTORY $ ', cols: 80, rows: 24 })).buffer }); });
    await buffered.page.locator('.xterm-rows', { hasText: 'BUFFERED-HISTORY' }).waitFor();
    await buffered.context.close();

    // The remembered terminal is gone: the early socket is closed cleanly and the first terminal of the task is opened.
    const gone = await openPage(browser, { saved: { task: 1, terminal: 'h5-deleted' } });
    await gone.page.waitForFunction(() => window.sockets.length === 2);
    const two = await gone.page.evaluate(() => window.sockets.map(ws => ({ url: ws.url, closed: ws.closedWith })));
    assert.match(two[0].url, /terminalId=h5-deleted/);
    assert.equal(two[0].closed, 1000, 'closed with a normal close');
    assert.match(two[1].url, /terminalId=h5-default/);
    assert.equal(two[1].closed, null);
    await gone.context.close();

    // Nothing remembered: no early socket and no terminal request; the task sheet opens.
    const fresh = await openPage(browser, { saved: null });
    await fresh.page.locator('#h5-tasks').waitFor({ state: 'visible' });
    assert.equal(await fresh.page.evaluate(() => window.sockets.length), 0);
    assert.ok(!fresh.requests.some(url => url.includes('/terminals')));
    await fresh.context.close();

    // 3. English (the default): the Chinese dictionaries are not loaded at all. A switch to Chinese loads them (the page reloads) and the page is in Chinese.
    const english = await openPage(browser, { viewport: { width: 1440, height: 900 } });
    await english.page.locator('#h5-terminal').waitFor({ state: 'attached' });
    assert.ok(!english.requests.some(url => url.includes('i18n-zh')), `no dictionary for English: ${english.requests.filter(url => url.includes('i18n')).join(', ')}`);
    assert.ok(english.requests.includes(english.requests.find(url => url.startsWith('/js/i18n.js?v='))), 'i18n.js itself is loaded, with its hash');
    await Promise.all([english.page.waitForEvent('load'), english.page.evaluate(() => I18n.toggle())]);
    await english.page.locator('#h5-terminal').waitFor({ state: 'attached' });
    const loaded = english.requests.filter(url => url.includes('i18n-zh'));
    assert.deepEqual(loaded.map(url => url.replace(/\?v=[0-9a-f]+$/, '')), ['/js/i18n-zh-ui.js', '/js/i18n-zh-server.js', '/js/i18n-zh-extra.js'], 'the dictionaries come with the page after the switch');
    assert.equal(await english.page.evaluate(() => I18n.get()), 'zh');
    assert.equal(await english.page.evaluate(() => I18n.t('Settings')), '\u8bbe\u7f6e');
    assert.ok(/[\u4e00-\u9fff]/.test(await english.page.locator('body').innerText()), 'the page is drawn in Chinese');
    // And back to English: the cookie is cleared, so the next page comes without them again.
    const before = english.requests.length;
    await Promise.all([english.page.waitForEvent('load'), english.page.evaluate(() => I18n.toggle())]);
    await english.page.locator('#h5-terminal').waitFor({ state: 'attached' });
    assert.ok(!english.requests.slice(before).some(url => url.includes('i18n-zh')), 'English again: no dictionaries');
    await english.context.close();

    // Chinese remembered from before this version (no cookie yet): the dictionaries are fetched after the start and the page is translated then.
    const old = await openPage(browser, { lang: 'zh' });
    await old.page.locator('#h5-terminal').waitFor({ state: 'attached' });
    await old.page.waitForFunction(() => I18n.t('Settings') !== 'Settings');
    await old.page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.body.innerText));
    assert.ok(await old.context.cookies(ORIGIN).then(list => list.some(item => item.name === 'ta-lang' && item.value === 'zh')), 'the cookie is set for the next page');
    await old.context.close();

    assert.deepEqual(pageErrors, [], 'no browser errors');
    console.log('Phone page loading: deferred scripts, skeleton, parallel start, early terminal socket and lazy Chinese dictionaries passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

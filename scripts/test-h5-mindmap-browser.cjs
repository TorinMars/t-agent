// The mind map view on the page in real Chromium, with the /api/mindmaps endpoints mocked here (the server is a separate module): the lazily loaded bundle, the list,
// the keyboard shortcuts, the on-screen bar and the touch gestures, autosave and conflicts, the back gesture, .xmind import and export, and the terminal staying connected.
// Runs in a computer context and in a touch phone context; each case collects its failures and all of them are printed at the end.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOT_DIR = process.env.MINDMAP_SHOTS || null;
const DOUBLE_TAP_GAP = 350; // ms: longer than the double-tap window of the view, so two taps count as two separate taps
const TASKS = [{ id: 1, title: 'Alpha', status: 'doing', work_dir: '/work/a' }];
const failures = [];
const pageErrors = [];
let currentCase = '';
const check = (ok, message) => { if (!ok) { failures.push(`${currentCase}: ${message}`); console.log(`  FAILED ${message}`); } };

// In-memory /api/mindmaps. `control` lets a case make the next requests fail.
function createServer() {
  let nextId = 1;
  const maps = new Map();
  const log = [];
  const control = { failPut: 0, conflictNext: false, bundleRequests: 0, inflight: 0, maxInflight: 0, putDelayMs: 0 };
  const stamp = () => new Date().toISOString();
  const make = (title, data) => { const id = `m${nextId++}`; const map = { id, title: title || 'Untitled map', data: data ?? null, revision: 1, created_at: stamp(), updated_at: stamp() }; maps.set(id, map); return map; };
  async function handle(route, request, pathname, json) {
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    log.push({ method, pathname, body });
    if (pathname === '/api/mindmaps' && method === 'GET') return json({ maps: [...maps.values()].reverse().map(({ data, ...rest }) => ({ ...rest, size: JSON.stringify(data || {}).length })) });
    if (pathname === '/api/mindmaps' && method === 'POST') { const map = make(body.title, body.data); return json(map, 201); }
    const m = pathname.match(/^\/api\/mindmaps\/([^/]+)$/);
    if (!m) return null;
    const map = maps.get(m[1]);
    if (!map) return json({ error: 'MINDMAP_NOT_FOUND' }, 404);
    if (method === 'GET') return json(map);
    if (method === 'DELETE') { maps.delete(map.id); return route.fulfill({ status: 204, body: '' }); }
    if (method === 'PUT') {
      control.inflight += 1;
      control.maxInflight = Math.max(control.maxInflight, control.inflight);
      if (control.putDelayMs) await new Promise(done => setTimeout(done, control.putDelayMs));
      control.inflight -= 1;
      if (control.failPut > 0) { control.failPut -= 1; return route.abort('failed'); }
      if (control.conflictNext || body.revision !== map.revision) {
        control.conflictNext = false;
        map.revision += 10;
        return json({ error: 'MINDMAP_CONFLICT', current_revision: map.revision }, 409);
      }
      map.revision += 1;
      if (body.title !== undefined) map.title = body.title;
      if (body.data !== undefined) map.data = body.data;
      map.updated_at = stamp();
      return json({ id: map.id, title: map.title, revision: map.revision, updated_at: map.updated_at });
    }
    return null;
  }
  return { maps, log, control, handle, make };
}

async function openPage(browser, { touch }) {
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: touch, hasTouch: touch, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => {});
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${currentCase}: ${error.message}`));
  const server = createServer();
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    localStorage.setItem('h5-task:local', '1');
    localStorage.setItem('h5-terminal:local:1', 'h5-default');
    // The visual viewport can be set by a case, to stand in for an on-screen keyboard.
    const realInner = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const viewport = new EventTarget();
    let visual = null;
    Object.defineProperties(viewport, {
      height: { get: () => visual ?? realInner.get.call(window) },
      width: { get: () => window.innerWidth }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setVisual = height => { visual = height; viewport.dispatchEvent(new Event('resize')); };
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) {
      if (pathname.endsWith('/mindmap-ui.js')) server.control.bundleRequests += 1;
      return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    }
    if (pathname.startsWith('/api/mindmaps')) { const answered = await server.handle(route, request, pathname, json); if (answered !== null) return answered; return json({ error: 'not mocked' }, 404); }
    if (pathname === '/api/remote-servers') return json([]);
    if (pathname === '/api/tasks') return json(TASKS);
    if (pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (pathname === '/api/tasks/terminal-activity' || pathname === '/api/tasks/terminal-subagents') return json({});
    if (pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
    if (pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (pathname === '/api/oss/config') return json({ enabled: false });
    if (pathname === '/api/system/check-update' || pathname === '/api/system/update-status') return json({ status: 'current', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets[0].readyState === 1);
  return { context, page, server };
}

const openView = async (page, touch) => {
  if (touch) {
    if (!await page.locator('#h5-tasks-mindmap').isVisible().catch(() => false)) {
      await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks-mindmap').waitFor({ state: 'visible' });
    }
    await page.locator('#h5-tasks-mindmap').tap();
  } else {
    await page.locator('#h5-tasks-mindmap').click();
  }
  await page.locator('#mm-new').waitFor();
};
const createMap = async (page, touch) => {
  const button = page.locator('#mm-new');
  await (touch ? button.tap() : button.click());
  await page.locator('.me-tpc').first().waitFor();
};
const topics = page => page.evaluate(() => [...document.querySelectorAll('.mm-canvas .me-tpc')].map(el => el.textContent));
const selected = page => page.evaluate(() => [...document.querySelectorAll('.mm-canvas .me-tpc.selected')].map(el => el.textContent));
const editing = page => page.evaluate(() => Boolean(document.querySelector('#input-box')));
const status = page => page.locator('.mm-status').textContent();
const waitSaved = page => page.locator('.mm-status[data-state="saved"]').waitFor();
const settled = page => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect.getComputedTiming().iterations !== Infinity));
const newTopic = async (page, text) => { await page.locator('#input-box').waitFor(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.querySelector('#input-box')); };

const CASES = {
  async 'computer: lazy bundle, list and keyboard editing'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    check(server.control.bundleRequests === 0, 'the bundle is not loaded with the page');
    const before = await page.evaluate(() => window.sockets[0].sent.length);
    await openView(page, false);
    check(server.control.bundleRequests === 1, 'the bundle is loaded when the view opens');
    await createMap(page, false);
    check((await topics(page)).length === 1, 'a new map starts with a root topic');

    // Tab adds a subtopic and opens the editor on it; typing goes into it, not to the terminal.
    await page.keyboard.press('Tab');
    await newTopic(page, 'First');
    await page.keyboard.press('Enter');
    await newTopic(page, 'Second');
    await page.keyboard.press('Shift+Enter');
    await newTopic(page, 'Before Second');
    check(JSON.stringify(await topics(page)).includes('Before Second'), 'Shift+Enter adds a topic before');
    const list = await topics(page);
    check(list.indexOf('Before Second') === list.indexOf('Second') - 1, `Shift+Enter places it before: ${list}`);

    // Insert a parent, delete, undo.
    await page.keyboard.press(`${mod}+Enter`);
    await newTopic(page, 'Parent');
    await page.keyboard.press('Delete');
    check(!(await topics(page)).includes('Parent'), 'Delete removes the topic');
    await page.keyboard.press(`${mod}+z`);
    check((await topics(page)).includes('Parent'), 'undo brings it back');
    await page.keyboard.press(`${mod}+Shift+z`);
    check(!(await topics(page)).includes('Parent'), 'redo removes it again');
    await page.keyboard.press(`${mod}+z`);

    // Arrows move the selection on the screen.
    await page.keyboard.press('Home');
    check((await selected(page))[0] === 'Untitled map', 'Home goes to the central topic');
    await page.keyboard.press('ArrowRight');
    const afterRight = await selected(page);
    await page.keyboard.press('ArrowLeft');
    check((await selected(page))[0] !== afterRight[0], 'Left leaves the topic reached by Right');

    // The edit keys and text behaviour.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('F2');
    check(await editing(page), 'F2 opens the editor');
    await page.keyboard.press('Escape');
    check(!(await editing(page)), 'Escape leaves the editor');
    await page.keyboard.press('Space');
    check(await editing(page), 'Space opens the editor');
    await page.keyboard.press('Escape');
    await page.keyboard.press('x');
    check(await editing(page), 'a character starts editing');
    await page.keyboard.type('yz');
    await page.keyboard.press('Enter');
    check((await topics(page)).includes('xyz'), `typing replaces the text: ${await topics(page)}`);

    // Enter during IME composition does not commit (isComposing, and keyCode 229 as Safari reports it).
    await page.keyboard.press('F2');
    await page.evaluate(() => {
      const box = document.querySelector('#input-box');
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true, isComposing: true }));
    });
    check(await editing(page), 'Enter with isComposing does not commit');
    await page.evaluate(() => {
      const box = document.querySelector('#input-box');
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, which: 229, bubbles: true, cancelable: true, composed: true }));
    });
    check(await editing(page), 'Enter with keyCode 229 does not commit');
    await page.keyboard.press('Escape');

    // Collapse a branch (the central topic has no fold, as in XMind), zoom, fit.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    await newTopic(page, 'Leaf');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press(`${mod}+/`);
    check(!(await topics(page)).includes('Leaf'), `Mod+/ folds the branch: ${await topics(page)}`);
    await page.keyboard.press(`${mod}+/`);
    check((await topics(page)).includes('Leaf'), 'and unfolds it');
    await page.keyboard.press('Home');
    const scale = () => page.evaluate(() => { const m = document.querySelector('.mm-canvas .map-canvas').style.transform.match(/scale\(([^)]+)\)/); return m ? Number(m[1]) : 1; });
    const zoom0 = await scale();
    await page.keyboard.press(`${mod}+=`);
    check((await scale()) > zoom0, 'zoom in');
    await page.keyboard.press(`${mod}+-`);
    await page.keyboard.press(`${mod}+-`);
    check((await scale()) < zoom0 + 0.0001, 'zoom out');
    await page.keyboard.press(`${mod}+0`);
    check(Math.abs((await scale()) - 1) < 0.001, 'Mod+0 is actual size');

    // Copy and paste of topics.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    const beforePaste = (await topics(page)).length;
    await page.keyboard.press(`${mod}+c`);
    await page.keyboard.press(`${mod}+v`);
    await page.waitForFunction(count => document.querySelectorAll('.mm-canvas .me-tpc').length > count, beforePaste);

    // The terminal received none of those keys, and Mod+K did not open the search.
    const after = await page.evaluate(() => window.sockets[0].sent.length);
    check(after === before, `no key reached the terminal (${before} -> ${after})`);
    await page.keyboard.press(`${mod}+k`);
    check(await page.evaluate(() => document.activeElement.id !== 'h5-task-search-input'), 'Mod+K does not open the search');
    await page.keyboard.press('Control+k');
    check((await page.evaluate(() => window.sockets[0].sent.length)) === before, 'no key reached the terminal after Ctrl+K');

    check(await page.evaluate(() => window.sockets[0].readyState === 1), 'the terminal socket stays open');
    if (SHOT_DIR) { await page.keyboard.press(`${mod}+9`); await page.waitForTimeout(150); await page.screenshot({ path: path.join(SHOT_DIR, 'desktop.png') }); }

    // Autosave: the save settles, the data reaches the mock, and the sends are one at a time.
    await waitSaved(page);
    const saved = [...server.maps.values()][0];
    check(JSON.stringify(saved.data).includes('First'), 'the map reaches the service');
    check(server.control.maxInflight === 1, 'one save at a time');

    // Escape in the editor goes back to the list, and from the list closes the view.
    await page.keyboard.press('Escape');
    await page.locator('.mm-row-open').first().waitFor();
    check(await page.evaluate(() => document.querySelectorAll('.mm-row').length === 1), 'Escape returns to the list');
    await page.keyboard.press('Escape');
    await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
    await context.close();
  },

  async 'computer: list actions'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    server.make('One', null);
    server.make('Two', null);
    await openView(page, false);
    await page.locator('.mm-row').nth(1).waitFor();
    // Rename
    await page.locator('.mm-row', { hasText: 'Two' }).locator('[aria-label="Rename"]').click();
    await page.locator('.mm-dialog input').fill('Renamed');
    await page.keyboard.press('Enter');
    await page.locator('.mm-row', { hasText: 'Renamed' }).waitFor();
    // Delete needs a confirmation
    await page.locator('.mm-row', { hasText: 'One' }).locator('[aria-label="Delete"]').click();
    await page.locator('.mm-dialog', { hasText: 'Delete this map' }).waitFor();
    await page.locator('.mm-dialog .mm-btn').first().click(); // Cancel
    check(await page.locator('.mm-row', { hasText: 'One' }).count() === 1, 'Cancel keeps the map');
    await page.locator('.mm-row', { hasText: 'One' }).locator('[aria-label="Delete"]').click();
    await page.locator('.mm-dialog .mm-btn-danger').click();
    await page.locator('.mm-row', { hasText: 'One' }).waitFor({ state: 'detached' });
    check(server.maps.size === 1, 'the map is deleted on the service');
    await context.close();
  },

  async 'computer: conflict, retry and draft'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const mapA = server.make('Conflict map', { nodeData: { id: 'r', topic: 'Root', children: [{ id: 'c', topic: 'A', children: [] }] }, arrows: [], summaries: [], direction: 2 });
    await openView(page, false);
    await page.locator('.mm-row-open').first().click();
    await page.locator('.me-tpc').nth(1).waitFor();

    // A failed request does not lose the edit; the status says so and a retry succeeds without a new edit.
    server.control.failPut = 2;
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await newTopic(page, 'After outage');
    await page.locator('.mm-status[data-state="retrying"]').waitFor({ timeout: 8000 });
    check(/retrying/.test(await status(page)), 'the status says it is retrying');
    await page.locator('.mm-status[data-state="saved"]').waitFor({ timeout: 15000 });
    check(JSON.stringify(server.maps.get(mapA.id).data).includes('After outage'), 'the edit made during the outage reached the service');

    // Conflict: the stale save is not overwritten; the person chooses.
    server.control.conflictNext = true;
    await page.keyboard.press('Tab');
    await newTopic(page, 'Lost update');
    await page.locator('.mm-dialog', { hasText: 'changed elsewhere' }).waitFor({ timeout: 8000 });
    check(await page.locator('.mm-status[data-state="conflict"]').count() === 1, 'the status shows the conflict');
    const stored = JSON.stringify(server.maps.get(mapA.id).data);
    check(!stored.includes('Lost update'), 'the conflicting save did not overwrite the map');
    await page.locator('.mm-dialog .mm-btn-primary').click();
    await page.waitForFunction(() => document.querySelector('.mm-title') && /copy/.test(document.querySelector('.mm-title').value));
    check(server.maps.size === 2, 'a new copy was created');
    check(JSON.stringify([...server.maps.values()][1].data).includes('Lost update'), 'the copy has the edits');
    await context.close();
  },

  async 'computer: a save whose answer was lost is not called a conflict'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const map = server.make('Lost answer', { nodeData: { id: 'r', topic: 'Root', children: [] }, arrows: [], summaries: [], direction: 2 });
    await openView(page, false);
    await page.locator('.mm-row-open').first().click();
    await page.locator('.me-tpc').first().waitFor();
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await newTopic(page, 'Kept');
    await waitSaved(page);
    // The next save lands on the service but its answer does not come back: the retry then gets 409 with data identical to what was sent.
    let lost = false;
    await page.route(`${ORIGIN}/api/mindmaps/${map.id}`, async route => {
      if (route.request().method() === 'PUT' && !lost) {
        lost = true;
        const body = JSON.parse(route.request().postData());
        const stored = server.maps.get(map.id);
        stored.revision += 1;
        stored.title = body.title;
        stored.data = body.data;
        return route.abort('failed');
      }
      return route.fallback();
    });
    await page.keyboard.press('Tab');
    await newTopic(page, 'Answer lost');
    await page.waitForFunction(() => document.querySelector('.mm-status').dataset.state === 'saved', null, { timeout: 15000 });
    check(await page.locator('.mm-dialog').count() === 0, 'no conflict dialog');
    await context.close();
  },

  async 'computer: unsaved edits survive a reload as a draft'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const map = server.make('Draft map', { nodeData: { id: 'r', topic: 'Root', children: [] }, arrows: [], summaries: [], direction: 2 });
    await openView(page, false);
    await page.locator('.mm-row-open').first().click();
    await page.locator('.me-tpc').first().waitFor();
    server.control.failPut = 1000;
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await newTopic(page, 'Only in the draft');
    await page.waitForFunction(id => Boolean(localStorage.getItem(`h5-mindmap-draft:${id}`)), map.id);
    await page.reload();
    server.control.failPut = 0;
    await page.waitForFunction(() => window.sockets.length > 0);
    await openView(page, false);
    await page.locator('.mm-row-open').first().click();
    await page.locator('.me-tpc', { hasText: 'Only in the draft' }).waitFor({ timeout: 8000 });
    await waitSaved(page);
    check(JSON.stringify(server.maps.get(map.id).data).includes('Only in the draft'), 'the restored draft is saved');
    check(await page.evaluate(id => localStorage.getItem(`h5-mindmap-draft:${id}`), map.id) === null, 'the draft is gone after the save');
    await context.close();
  },

  async 'computer: back button goes from the editor to the list, then closes'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    server.make('Back map', { nodeData: { id: 'r', topic: 'Root', children: [] }, arrows: [], summaries: [], direction: 2 });
    await openView(page, false);
    await page.locator('.mm-row-open').first().click();
    await page.locator('.me-tpc').first().waitFor();
    await page.waitForFunction(() => history.state && history.state.h5Layer >= 2);
    await page.goBack();
    await page.locator('.mm-row').first().waitFor();
    check(await page.locator('.mm-editor').isHidden(), 'the back press leaves the editor');
    await page.goBack();
    await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
    check(page.url().startsWith(`${ORIGIN}/h5`), 'the page did not navigate away');
    await context.close();
  },

  async 'computer: import and export round trip'(browser) {
    const { context, page, server } = await openPage(browser, { touch: false });
    const { unzipSync, strFromU8, zipSync, strToU8 } = await import('fflate');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-test-'));
    try {
      await openView(page, false);
      // A real zip with the current format.
      const sheet = [{ id: 's', class: 'sheet', title: 'Sheet', rootTopic: { id: 'r', class: 'topic', title: 'Imported root', structureClass: 'org.xmind.ui.logic.right', children: { attached: [{ id: 'a', title: 'Child \u4e2d\u6587', notes: { plain: { content: 'My note' } }, labels: ['one'], href: 'https://example.com/', markers: [{ markerId: 'priority-1' }] }, { id: 'b', title: 'Bad link', href: 'javascript:alert(1)' }] } }, relationships: [{ id: 'x', end1Id: 'a', end2Id: 'b', title: 'rel <b>' }] }];
      const file = path.join(dir, 'Workbook.xmind');
      fs.writeFileSync(file, zipSync({ 'content.json': strToU8(JSON.stringify(sheet)), 'metadata.json': strToU8('{}'), 'manifest.json': strToU8('{"file-entries":{}}') }));
      const notXmind = path.join(dir, 'not.xmind');
      fs.writeFileSync(notXmind, 'hello');

      await page.locator('.mm-file').setInputFiles(notXmind);
      await page.waitForFunction(() => /not a \.xmind/.test(document.body.textContent));
      check(server.maps.size === 0, 'a file that is not a zip creates nothing');

      await page.locator('.mm-file').setInputFiles(file);
      await page.locator('.me-tpc', { hasText: 'Imported root' }).waitFor();
      const list = await topics(page);
      check(list.includes('Imported root') && list.some(text => text.includes('Child \u4e2d\u6587')), `the topics are kept: ${list}`);
      check(await page.locator('.mm-canvas .tags span', { hasText: 'one' }).count() === 1, 'labels are shown');
      check(await page.locator('.mm-canvas .me-tpc[data-note="1"]').count() === 1, 'the note is marked');
      check(await page.evaluate(() => [...document.querySelectorAll('.mm-canvas .hyper-link')].every(a => a.href.startsWith('https:'))), 'only the safe link is kept');
      check(await page.locator('.mm-canvas .me-tpc b, .mm-canvas .svg-label b').count() === 0, 'an HTML label stays text');
      check(await page.locator('.mm-canvas .svg-label', { hasText: 'rel <b>' }).count() === 1, 'the relationship label is shown as written');

      // Export it again and look inside the file.
      const download = page.waitForEvent('download');
      await page.locator('#mm-export').click();
      const saved = await (await download).path();
      const entries = unzipSync(new Uint8Array(fs.readFileSync(saved)));
      for (const name of ['content.json', 'metadata.json', 'manifest.json']) check(entries[name], `the export has ${name}`);
      const content = JSON.parse(strFromU8(entries['content.json']));
      const exportRoot = content[0].rootTopic;
      check(content[0].class === 'sheet' && exportRoot.class === 'topic' && exportRoot.title === 'Imported root', 'the workbook has the format of content.json');
      check(exportRoot.structureClass === 'org.xmind.ui.logic.right', 'the layout survives');
      const child = exportRoot.children.attached.find(topic => topic.title === 'Child \u4e2d\u6587');
      check(child && child.notes.plain.content === 'My note' && child.labels[0] === 'one' && child.href === 'https://example.com/' && child.markers[0].markerId === 'priority-1', `the topic details survive: ${JSON.stringify(child)}`);
      check(content[0].relationships && content[0].relationships.length === 1, 'the relationship survives');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await context.close();
  },

  async 'phone: open from the drawer, touch editing with the bar'(browser) {
    const { context, page, server } = await openPage(browser, { touch: true });
    const beforeSent = await page.evaluate(() => window.sockets[0].sent.length);
    check(server.control.bundleRequests === 0, 'the bundle is not loaded with the page');
    await openView(page, true);
    check(server.control.bundleRequests === 1, 'the bundle is loaded when the view opens');
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await createMap(page, true);
    await settled(page);

    // The bar: 44px targets, fitted in the width, nothing to scroll sideways.
    const bar = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.mm-bar .mm-icon')].map(button => button.getBoundingClientRect());
      return { sizes: buttons.map(r => [Math.round(r.width), Math.round(r.height)]), right: Math.max(...buttons.map(r => r.right)), page: document.documentElement.scrollWidth, width: window.innerWidth };
    });
    check(bar.sizes.every(([w, h]) => w >= 44 && h >= 44), `the buttons are at least 44px: ${bar.sizes}`);
    check(bar.right <= bar.width && bar.page <= bar.width, `no sideways overflow: ${JSON.stringify(bar)}`);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.mm-canvas')).touchAction === 'none'), 'the canvas takes all gestures (touch-action: none)');

    // Select the root and add a child: the editor is focused at once, inside the tap, which is what raises the iOS keyboard.
    const center = async text => page.evaluate(label => { const el = [...document.querySelectorAll('.mm-canvas .me-tpc')].find(n => n.textContent === label); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, text);
    let p = await center('Untitled map');
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => document.querySelectorAll('.mm-canvas .me-tpc.selected').length === 1);
    await page.locator('#mm-action-child').tap();
    check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'input-box'), 'the topic editor has the focus right after the tap');
    await page.keyboard.type('Phone child');
    await page.keyboard.press('Enter');
    check((await topics(page)).includes('Phone child'), 'the child was added');

    // Sibling, edit, delete from the bar.
    await page.locator('#mm-action-sibling').tap();
    check(await editing(page), 'add sibling opens the editor');
    await page.keyboard.type('Sibling');
    await page.keyboard.press('Enter');
    await page.locator('#mm-action-edit').tap();
    check(await editing(page), 'edit opens the editor');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Enter');
    check((await topics(page)).some(text => text === 'Sibling!' || text.endsWith('!')), `the edit was kept: ${await topics(page)}`);
    await page.locator('#mm-action-delete').tap();
    check(!(await topics(page)).some(text => text.endsWith('!')), 'delete removes the topic');
    await page.locator('#mm-action-undo').tap();
    check((await topics(page)).some(text => text.endsWith('!')), 'undo restores it');
    await page.locator('#mm-action-redo').tap();
    await page.locator('#mm-action-undo').tap();

    // Tap on the selected topic edits; tap elsewhere ends it.
    await page.locator('#mm-action-fit').tap();
    await settled(page);
    p = await center('Phone child');
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => [...document.querySelectorAll('.me-tpc.selected')].some(el => el.textContent === 'Phone child'));
    await page.waitForTimeout(DOUBLE_TAP_GAP);
    p = await center('Phone child');
    await page.touchscreen.tap(p.x, p.y);
    await page.locator('#input-box').waitFor();
    check(await page.evaluate(() => document.activeElement.id === 'input-box'), 'tap on a selected topic edits');
    await page.touchscreen.tap(30, 300);
    await page.waitForFunction(() => !document.querySelector('#input-box'));

    // Collapse a topic that has children, from the bar, and expand it back.
    p = await center('Phone child');
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => [...document.querySelectorAll('.me-tpc.selected')].some(el => el.textContent === 'Phone child'));
    await page.locator('#mm-action-child').tap();
    await page.keyboard.type('Grandchild');
    await page.keyboard.press('Enter');
    p = await center('Phone child');
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => document.querySelector('#mm-action-fold') && !document.querySelector('#mm-action-fold').disabled);
    await page.locator('#mm-action-fold').tap();
    check(!(await topics(page)).includes('Grandchild'), 'collapse from the bar');
    await page.locator('#mm-action-fold').tap();
    check((await topics(page)).includes('Grandchild'), 'expand from the bar');
    await page.locator('#mm-action-fit').tap();

    // The on-screen keyboard: the view shortens to the visual viewport, and the bar and the edited topic stay visible.
    const full = (await page.locator('#h5-mindmap').boundingBox()).height;
    await settled(page);
    p = await center('Phone child');
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => document.querySelector('.me-tpc.selected'));
    await page.locator('#mm-action-edit').tap();
    await page.evaluate(() => window.setVisual(480));
    await page.waitForFunction(() => Math.round(document.getElementById('h5-mindmap').getBoundingClientRect().height) === 480);
    const up = await page.evaluate(() => ({ bar: document.querySelector('.mm-bar').getBoundingClientRect().bottom, box: document.querySelector('#input-box').getBoundingClientRect(), attr: document.getElementById('h5-mindmap').hasAttribute('data-keyboard') }));
    check(up.bar <= 480 + 1, `the bar stays above the keyboard: ${up.bar}`);
    check(up.box.top >= 0 && up.box.bottom <= 480, `the edited topic stays visible: ${JSON.stringify(up.box)}`);
    check(up.attr, 'the view knows the keyboard is up (no safe-area padding under the bar)');
    await page.evaluate(() => window.setVisual(null));
    await page.keyboard.press('Enter');
    await page.waitForFunction(h => Math.round(document.getElementById('h5-mindmap').getBoundingClientRect().height) === h, Math.round(full));

    // A small, wrong reading without a keyboard is not believed.
    await page.evaluate(() => window.setVisual(200));
    await page.waitForTimeout(150);
    check(Math.round((await page.locator('#h5-mindmap').boundingBox()).height) === Math.round(full), 'a small reading without a keyboard does not shrink the view');
    await page.evaluate(() => window.setVisual(null));

    // The terminal saw nothing and stays connected.
    check(await page.evaluate(() => window.sockets[0].readyState === 1), 'the terminal socket stays open');
    const afterSent = await page.evaluate(() => window.sockets[0].sent.length);
    check(afterSent === beforeSent, `no input reached the terminal (${beforeSent} -> ${afterSent})`);
    if (SHOT_DIR) { await page.locator('#mm-action-fit').tap(); await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOT_DIR, 'phone.png') }); }
    await waitSaved(page);
    await page.locator('#mm-back').tap();
    await page.locator('.mm-row').first().waitFor();
    await context.close();
  },

  async 'phone: gestures on the canvas, and the back gesture'(browser) {
    const { context, page, server } = await openPage(browser, { touch: true });
    const map = server.make('Touch map', { nodeData: { id: 'r', topic: 'Root', children: [{ id: 'a', topic: 'Alpha', children: [{ id: 'a1', topic: 'Leaf', children: [] }] }, { id: 'b', topic: 'Beta', children: [] }] }, arrows: [], summaries: [], direction: 1 });
    await openView(page, true);
    await page.locator('.mm-row-open').first().tap();
    await page.locator('.me-tpc').nth(3).waitFor();
    await settled(page);
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const center = text => page.evaluate(label => { const el = [...document.querySelectorAll('.me-tpc')].find(n => n.textContent === label); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, text);
    const emptySpot = () => page.evaluate(() => { const box = document.querySelector('.mm-canvas').getBoundingClientRect(); return { x: box.left + 12, y: box.bottom - 12 }; });
    const transform = () => page.evaluate(() => document.querySelector('.mm-canvas .map-canvas').style.transform);

    // One finger on empty canvas pans.
    const before = await transform();
    const spot = await emptySpot();
    await touch('touchStart', [spot]);
    for (let i = 1; i <= 6; i += 1) await touch('touchMove', [{ x: spot.x + i * 8, y: spot.y - i * 6 }]);
    await touch('touchEnd', []);
    check((await transform()) !== before, 'one finger on empty canvas pans');
    check(await page.evaluate(() => document.querySelectorAll('.mm-canvas .me-tpc.selected').length === 0), 'a pan does not select');

    // Two fingers zoom.
    const scale = () => page.evaluate(() => Number(document.querySelector('.mm-canvas .map-canvas').style.transform.match(/scale\(([^)]+)\)/)[1]));
    const scale0 = await scale();
    await touch('touchStart', [{ x: 150, y: 500, id: 1 }, { x: 240, y: 500, id: 2 }]);
    for (let i = 1; i <= 10; i += 1) await touch('touchMove', [{ x: 150 - i * 6, y: 500, id: 1 }, { x: 240 + i * 6, y: 500, id: 2 }]);
    await touch('touchEnd', []);
    check((await scale()) > scale0, 'a pinch zooms in');
    await page.locator('#mm-action-fit').tap();
    await settled(page);

    // Drag a topic onto another: it becomes its child, and the map is saved.
    const from = await center('Beta');
    const to = await center('Alpha');
    await touch('touchStart', [from]);
    for (let i = 1; i <= 10; i += 1) await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / 10, y: from.y + (to.y - from.y) * i / 10 }]);
    await page.waitForFunction(() => document.querySelector('.mm-ghost'));
    await touch('touchEnd', []);
    await page.waitForFunction(() => !document.querySelector('.mm-ghost'));
    await page.locator('.mm-status[data-state="saved"]').waitFor({ timeout: 8000 });
    const tree = server.maps.get(map.id).data.nodeData;
    const alpha = tree.children.find(node => node.topic === 'Alpha');
    check(alpha.children.some(node => node.topic === 'Beta'), `Beta moved under Alpha: ${JSON.stringify(tree)}`);

    // The back gesture: editor to list, list to terminal, and the page stays.
    await page.waitForFunction(() => history.state && history.state.h5Layer >= 2);
    await page.goBack();
    await page.locator('.mm-row').first().waitFor();
    await page.goBack();
    await page.locator('#h5-mindmap').waitFor({ state: 'hidden' });
    check(await page.evaluate(() => document.getElementById('h5-mindmap').hidden && window.sockets[0].readyState === 1), 'back to the terminal, still connected');
    await context.close();
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [name, run] of Object.entries(CASES)) {
      if (process.env.MINDMAP_ONLY && !name.includes(process.env.MINDMAP_ONLY)) continue;
      currentCase = name;
      console.log(`case: ${name}`);
      await run(browser);
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'all checks pass');
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('The mind map view passed.');
})().catch(error => { console.error(error); console.error(failures); process.exit(1); });

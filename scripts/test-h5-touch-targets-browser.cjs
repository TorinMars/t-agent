// Phone page (/h5) touch targets in real Chromium (touch mode) at 320, 360 and 390px: every control that a finger can tap must own a 44px circle
// (a fingertip) around its centre (the size of a fingertip). The check asks the browser what is under the finger (`elementFromPoint`) at nine points
// of that circle, so it counts what really takes the tap: the element's own box, a larger `::after` hit area, and no neighbour lying over it.
// It walks the main screen, the draft box, the saved commands menu, the task sheet, the terminal and session menus, the settings sheet,
// the update dialog and the design sheet. Inline text links (a link inside a sentence) are the one exception (WCAG 2.5.8 allows them).
// H5_SHOT_DIR=<dir> saves screenshots of each state there.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const pageErrors = [];
const MIN = 44;

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'todo' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }, { terminal_id: 'c1', title: 'Claude work', agent: 'claude' }], 2: [{ terminal_id: 'h5-docs', title: 'Docs terminal' }] };

async function openPage(browser, viewport) {
  const scale = process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, ...scale });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }, { key: 'todo', name: 'To do', sort_order: 2 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json({ 1: { 'h5-default': 'running' } });
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (url.pathname === '/api/tasks/1/agent/conversations') return json([{ id: 'k1', agent: 'claude', title: 'A chat', running: false, pending: false, opened: { web: null, h5: null } }]);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/tasks/1/files/content') return json({ path: 'DESIGN.md', content: '# Design\n\nA [web link](https://example.test/doc).\n' });
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    const update = { status: 'available', local_version: '1.0.0', remote_version: '1.0.1', install_type: 'git', is_update_admin: true, remote_manifest: { release_url: 'https://example.test/releases', published_at: '2026-01-01T00:00:00Z' }, last_checked_at: '2026-01-01T00:00:00Z', version_url: 'https://example.test/VERSION.json' };
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json(update);
    if (url.pathname === '/api/system/update-notified') return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page };
}

// In the page: every visible control that is not covered (by a backdrop, a sheet) and the points of its 44px circle that land on something else.
function measure(min) {
  const SEL = 'button, a[href], input:not([type=hidden]):not([type=file]), textarea, select, [role=button], [role=menuitem], [role=checkbox], [role=switch], [role=tab], label.MuiButtonBase-root';
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (el.closest('.xterm, [inert], [aria-hidden="true"], [hidden]')) continue; // the terminal's own input; whatever sits behind a modal
    const control = el.closest('.MuiInputBase-root, .MuiButtonBase-root, .MuiFormControlLabel-root') || el;
    if (seen.has(control)) continue;
    seen.add(control);
    const style = getComputedStyle(control);
    const box = control.getBoundingClientRect();
    if (style.visibility === 'hidden' || box.width === 0 || box.height === 0) continue;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    const owns = node => Boolean(node) && (node === control || control.contains(node));
    if (!owns(document.elementFromPoint(cx, cy))) continue; // covered, or scrolled out of a scrolling row
    // A link inside a sentence is exempt (WCAG 2.5.8 "inline"); a link that is a button (MUI Button with href) is not.
    if (control.tagName === 'A' && !control.classList.contains('MuiButtonBase-root')) { out.push({ name: control.textContent.trim().slice(0, 40), inline: true }); continue; }
    // The visible part of a scrolling row: points outside it are not tested (that part is scrolled away; the row's own box is checked).
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let node = control.parentElement; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll|hidden)/.test(cs.overflowX + cs.overflowY)) {
        const r = node.getBoundingClientRect();
        clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
      }
    }
    // A fingertip is round: the centre, four points on a 44px circle and four on its diagonals. 1.5px is kept free for the browser's rounding of points.
    const r = min / 2 - 1.5;
    const d = r * Math.SQRT1_2;
    const misses = [];
    for (const [dx, dy] of [[0, 0], [-r, 0], [r, 0], [0, -r], [0, r], [-d, -d], [d, -d], [-d, d], [d, d]]) {
      {
        const x = cx + dx;
        const y = cy + dy;
        if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) continue;
        const hit = document.elementFromPoint(x, y);
        if (!owns(hit)) misses.push(`(${Math.round(dx)},${Math.round(dy)})->${hit ? (hit.id || hit.getAttribute('aria-label') || hit.className.toString().split(' ')[0] || hit.tagName) : 'nothing'}`);
      }
    }
    const name = control.getAttribute('aria-label') || control.querySelector('[aria-label]')?.getAttribute('aria-label') || control.id || control.textContent.trim().slice(0, 40) || control.className.toString().split(' ')[0];
    out.push({ name, w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10, misses, clipped: clip.left > box.left + 0.5 || clip.right < box.right - 0.5 });
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const failures = [];
  const report = [];
  try {
    for (const viewport of [{ width: 320, height: 640 }, { width: 360, height: 780 }, { width: 390, height: 844 }]) {
      const { context, page } = await openPage(browser, viewport);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'touch', 'a phone is in touch mode');
      const check = async state => {
        await page.waitForTimeout(450); // sheets and menus finish their slide
        if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, `touch-${viewport.width}-${state}.png`) });
        const rows = await page.evaluate(measure, MIN);
        assert.ok(rows.length > 0, `${state}: some controls were measured`);
        for (const row of rows) {
          if (row.inline) { report.push(`${viewport.width} ${state}: inline link "${row.name}" (exempt)`); continue; }
          if (row.misses.length) failures.push(`${viewport.width}px ${state}: "${row.name}" ${row.w}x${row.h} misses ${row.misses.join(' ')}`);
        }
        return rows;
      };
      // The task sheet is open at the start (no task yet): open Terminal 1 of task 1.
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
      await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).tap();
      await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
      const main = await check('main');
      // Row 2 at rest: eight buttons from 360px (seven at 320px, where Docs is left out: the saved commands list has a Docs entry), every one at least
      // 44px wide, inside the screen, none on top of another.
      const row2 = await page.evaluate(() => [...document.querySelectorAll('#h5-actions > button, #h5-actions > label')].map(b => b.getBoundingClientRect()).filter(b => b.width > 0).map(b => ({ left: b.left, right: b.right, width: b.width, height: b.height })));
      const count = viewport.width < 360 ? 7 : 8;
      assert.equal(row2.length, count, `${viewport.width}px: ${count} buttons in row 2`);
      assert.ok(row2.every((b, i) => b.width >= MIN - 0.01 && b.height >= MIN - 0.01 && b.left >= 0 && b.right <= viewport.width && (i === 0 || row2[i - 1].right <= b.left + 0.01)), `${viewport.width}px: row 2 has ${count} 44px buttons in the screen: ${JSON.stringify(row2.map(b => Math.round(b.width * 10) / 10))}`);
      // Row 1: 44px high keys with 8px between them.
      const keys = await page.evaluate(() => [...document.querySelectorAll('#h5-keys > button')].map(b => b.getBoundingClientRect()).map(b => ({ left: b.left, right: b.right, width: b.width, height: b.height })));
      assert.ok(keys.every((b, i) => b.height >= MIN && b.width >= MIN && (i === 0 || b.left - keys[i - 1].right >= 7.99)), `${viewport.width}px: row 1 keys are 44px with 8px gaps`);
      assert.ok(main.length >= 10, 'the main screen has its controls');
      // The draft box is shown (its keyboard key): send and translate-and-send join row 2, which still fits with 44px buttons.
      await page.locator('[data-action="draft"]').tap();
      await page.locator('#h5-translate-send').waitFor({ state: 'visible' });
      await check('draft');
      const drafting = await page.evaluate(() => [...document.querySelectorAll('#h5-actions > button, #h5-actions > label')].map(b => b.getBoundingClientRect()).filter(b => b.width > 0).map(b => ({ left: b.left, right: b.right, width: b.width })));
      assert.ok(drafting.length === 7 && drafting.every((b, i) => b.width >= MIN - 0.01 && b.right <= viewport.width && (i === 0 || drafting[i - 1].right <= b.left + 0.01)), `${viewport.width}px: row 2 with the draft box: seven 44px buttons: ${JSON.stringify(drafting.map(b => Math.round(b.width * 10) / 10))}`);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.locator('#h5-translate-send').waitFor({ state: 'hidden' });
      // The saved commands menu (the open terminal is a plain shell: its list has notes under the commands).
      await page.locator('#h5-commands').tap();
      await page.locator('.h5-add-menu').waitFor();
      await check('commands-menu');
      const menu = await page.evaluate(() => { const m = document.querySelector('.h5-add-menu').getBoundingClientRect(); const notes = [...document.querySelectorAll('.h5-add-menu-note')].map(n => { const r = n.getBoundingClientRect(); return { right: r.right, overflow: n.scrollWidth > n.clientWidth + 1 }; }); return { left: m.left, right: m.right, notes }; });
      assert.ok(menu.left >= 0 && menu.right <= viewport.width, `${viewport.width}px: the menu is inside the screen`);
      assert.ok(menu.notes.every(n => n.right <= menu.right && !n.overflow), `${viewport.width}px: the notes wrap inside the menu`);
      await page.locator('#h5-commands').tap();
      await page.locator('.h5-add-menu').waitFor({ state: 'detached' });
      // The design sheet (Docs; under 360px from the saved commands list).
      if (viewport.width < 360) { await page.locator('#h5-commands').tap(); await page.locator('#h5-commands-docs').tap(); } else await page.locator('#h5-design').tap();
      await page.locator('#h5-design-close').waitFor();
      await check('design-sheet');
      await page.locator('#h5-design-close').tap();
      await page.locator('.h5-design-panel').waitFor({ state: 'hidden' });
      // The update dialog (an update is available).
      await page.locator('#h5-update').tap();
      await page.locator('#h5-update-now').waitFor();
      await check('update-dialog');
      await page.locator('#h5-update-dismiss').tap();
      await page.locator('#h5-update-dialog').waitFor({ state: 'hidden' });
      // The task sheet (the selected task has its "⋯" and "+"), the terminal menu, the session menu.
      await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await page.locator('#h5-tasks .h5-terminal-more').first().waitFor();
      await check('task-sheet');
      await page.locator('#h5-tasks .h5-terminal-more').first().tap();
      await page.locator('#h5-term-menu-actions').waitFor();
      await check('terminal-menu');
      await page.locator('#h5-term-menu-cancel').tap();
      await page.locator('#h5-term-menu-actions').waitFor({ state: 'detached' });
      if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks .h5-task-add').first().tap();
      await page.locator('#h5-new-name-input').waitFor();
      await check('session-menu');
      await page.locator('#h5-term-menu-cancel').tap();
      await page.locator('#h5-new-name-input').waitFor({ state: 'detached' });
      // The settings sheet, from the gear of the task sheet.
      if (!(await page.locator('#h5-tasks').isVisible())) await page.locator('#h5-open-tasks').tap();
      await page.locator('#h5-tasks').waitFor({ state: 'visible' });
      await page.locator('#h5-tasks-settings').tap();
      await page.locator('#h5-close-settings').waitFor();
      await check('settings');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  for (const line of report) console.log(line);
  assert.deepEqual(failures, [], `controls without a 44px touch target:\n${failures.join('\n')}`);
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('h5 touch targets: ok (320, 360 and 390px; every control owns a 44px circle)');
})().catch(error => { console.error(error); process.exit(1); });

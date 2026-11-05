// File links in the phone terminal (/h5) in Chromium at phone size with touch: a tap on a path inside the working directory opens the file in the
// sheet from the bottom (Markdown rendered, other files as text with the named line marked), read through the task file API only at the tap.
// A path outside the working directory is no link, a double tap on a path selects the word and opens nothing, the keyboard closes and the
// terminal is not resized (no resize message reaches the PTY). H5_SHOT_DIR=<dir> saves screenshots at 3x.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const FILES = {
  'src/app.js': Array.from({ length: 80 }, (_, i) => `const line${i + 1} = '<b>${i + 1}</b>';`).join('\n') + '\n',
  'docs/设计.md': '# 设计\n\nSome **bold** text.\n',
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const errors = [];
  const reads = [];
  try {
    const scale = process.env.H5_SHOT_DIR ? { deviceScaleFactor: 3 } : {};
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...scale });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sockets = [];
      window.FakeSocket = class {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
        send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
        close() { this.readyState = 3; }
        emit(data) { this.onmessage?.({ data }); }
      };
      window.FakeSocket.OPEN = 1;
      window.FakeSocket.CONNECTING = 0;
      window.WebSocket = window.FakeSocket;
    });
    await page.route(`${ORIGIN}/**`, async route => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
      if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
      if (url.pathname === '/api/remote-servers') return json([]);
      if (url.pathname === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
      if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
      if (url.pathname === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
      if (url.pathname === '/api/tasks/1/agent/conversations') return json([]);
      if (url.pathname.startsWith('/api/tasks/1/files')) {
        const file = url.searchParams.get('path');
        reads.push(`${url.pathname.endsWith('/content') ? 'read' : 'list'} ${file}`);
        if (url.pathname.endsWith('/content')) {
          if (file === 'src') return json({ error: 'FILE_UNSUPPORTED' }, 415);
          return FILES[file] ? json({ path: file, content: FILES[file], revision: 'r1', eol: '\n', bom: false }) : json({ error: 'FILE_NOT_FOUND' }, 404);
        }
        return file === 'src' ? json({ entries: [], nextOffset: null, root: '/work/fix-login' }) : json({ error: 'FILE_NOT_DIRECTORY' }, 400);
      }
      return json({ error: 'not mocked' }, 404);
    });
    await page.goto(`${ORIGIN}/h5`);
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first().tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '$ ', cols: 50, rows: 24 })));
    await page.evaluate(() => window.sockets[0].emit('\r\nA1 ● Read(src/app.js:42)\r\nA2 see docs/设计.md\r\nA3 /etc/hosts and ../up.md\r\nA4 src/ folder\r\nA5 missing/gone.js\r\n'));
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('A5 missing'));
    assert.deepEqual(reads, [], 'printing paths reads nothing');
    const resizes = () => page.evaluate(() => window.sockets[0].sent.filter(data => data.includes('"resize"')).length);
    const resizesBefore = await resizes();

    // The centre of `text` in the row that starts with `prefix`, counted in cells (the CJK characters are two cells wide).
    const pointOf = (prefix, text) => page.evaluate(({ prefix, text }) => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const row = rows.find(node => node.textContent.startsWith(prefix));
      const screen = document.querySelector('.h5-xterm .xterm-screen').getBoundingClientRect();
      const before = row.textContent.slice(0, row.textContent.indexOf(text));
      const cells = [...before].reduce((sum, ch) => sum + (/[⺀-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
      const box = row.getBoundingClientRect();
      const cellWidth = screen.width / 50;
      return { x: screen.left + (cells + 1.5) * cellWidth, y: box.top + box.height / 2 };
    }, { prefix, text });
    const tap = async point => page.touchscreen.tap(point.x, point.y);
    const sheet = page.locator('#h5-design-sheet .h5-design-panel');
    const closeSheet = async () => { await page.locator('#h5-design-close').tap(); await sheet.waitFor({ state: 'hidden' }); };

    // A code file: plain text with line numbers, line 42 marked and in view; HTML in the file stays text.
    await tap(await pointOf('A1 ', 'src/app.js'));
    await sheet.waitFor({ state: 'visible' });
    await page.locator('#h5-design-body .h5-file-line.is-target').waitFor();
    assert.deepEqual(reads, ['read src/app.js']);
    assert.equal(await page.locator('#h5-design-title').textContent(), 'app.js');
    assert.equal(await page.locator('#h5-design-path').textContent(), '/work/fix-login/src/app.js');
    assert.equal(await page.locator('#h5-design-body .h5-file-line.is-target').getAttribute('data-line'), '42');
    assert.equal(await page.locator('#h5-design-body b').count(), 0, 'file text is never HTML');
    await page.waitForFunction(() => { const panel = document.querySelector('.h5-design-panel'); return panel && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(panel).transform); }, null, { timeout: 3000 });
    const inView = await page.evaluate(() => { const body = document.querySelector('#h5-design-body').getBoundingClientRect(); const line = document.querySelector('.h5-file-line.is-target').getBoundingClientRect(); return line.top >= body.top && line.bottom <= body.bottom; });
    assert.ok(inView, 'the named line is scrolled into view');
    if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-file-link-code.png') });
    await closeSheet();

    // A Markdown file with a Chinese name is rendered.
    await tap(await pointOf('A2 ', 'docs/'));
    await page.locator('#h5-design-body h1', { hasText: '设计' }).waitFor();
    assert.equal(await page.locator('#h5-design-title').textContent(), '设计.md');
    if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-file-link-markdown.png') });
    await closeSheet();

    // A folder: the sheet says it cannot be shown here; no file read is tried for a trailing slash.
    await tap(await pointOf('A4 ', 'src/'));
    await page.locator('#h5-design-empty', { hasText: 'Folders cannot be shown on the phone' }).waitFor();
    await closeSheet();
    // A missing file says so.
    await tap(await pointOf('A5 ', 'missing/gone.js'));
    await page.locator('#h5-design-empty', { hasText: 'Not found in the working directory: missing/gone.js' }).waitFor();
    await closeSheet();

    // Outside the working directory: not a link, the tap opens and reads nothing.
    const readsBefore = reads.length;
    for (const text of ['/etc/hosts', '../up.md']) {
      await tap(await pointOf('A3 ', text));
      await page.waitForTimeout(700);
      assert.equal(await sheet.isVisible(), false, `${text} opens nothing`);
    }
    // A double tap on a path selects the word (Copy bar) and opens nothing.
    const point = await pointOf('A1 ', 'src/app.js');
    await tap(point); await page.waitForTimeout(80); await tap(point);
    await page.locator('.h5-selection-bar').waitFor();
    await page.waitForTimeout(700);
    assert.equal(await sheet.isVisible(), false, 'a double tap does not open the file');
    assert.equal(reads.length, readsBefore, 'outside paths and the double tap read nothing');
    assert.equal(await resizes(), resizesBefore, 'the link taps send no resize to the PTY');
    assert.deepEqual(errors, []);
    console.log('h5 file links browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

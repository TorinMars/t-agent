// File links in the phone terminal (/h5) in Chromium at phone size with touch: a tap on a path inside the working directory opens the file in the
// sheet from the bottom (Markdown rendered, other files as text with the named line marked), read through the task file API only at the tap.
// A path outside the working directory (absolute, ~/, above the root, from a live directory outside it) opens through the any-path read
// (`/api/fs/content`, mocked here: the server side is tested on its own) on the local Client and on a remote Engine with 'fs:read-any'
// (`/api/remote-servers/:id/fs/content`); on a remote Engine without it such a path is no link (the old rule). A double tap on a path selects the
// word and opens nothing, the keyboard closes and the terminal is not resized (no resize message reaches the PTY). H5_SHOT_DIR=<dir> saves
// screenshots at 3x.
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
  'sub/a.md': '# In sub\n',
  'other/x.js': 'const other = 1;\n',
  // A large log (about 4.5 MB, 200 000 lines): only the lines in view are drawn.
  'big/log.txt': Array.from({ length: 200000 }, (_, i) => `${i + 1} log line with some text ${'x'.repeat(i % 7)}`).join('\n') + '\n',
  // Relative images resolve through the file API; one that does not load shows its text.
  // Long paths over two or more rows of the 50-column terminal (soft-wrapped by xterm, or hard-wrapped the way Claude Code prints them).
  'deep/f5bcf118-e52a-4af7-b324-e791d46313f4/scratchpad/soft-test.md': '# Soft long path\n',
  'deep/f5bcf118-e52a-4af7-b324-e791d46313f4/scratchpad/hard-test.md': '# Hard long path\n',
  'docs/pic.md': '# Pictures\n\n![the shot](img/shot.png)\n\n![gone picture](img/missing.png)\n\n![outside](../../etc/x.png)\n',
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const images = [];
const reads = []; // the task file API reads: `read <path>` / `list <path>`
// The shell's live directory as the server reads it (GET .../terminals/:tid/cwd); the shell here sends no OSC 7 unless the test prints one.
let liveCwd = { cwd: '/work/fix-login', relative: '' };
let cwdAsks = 0;

// Files outside the working directory, as the any-path read answers them (`path` is the Engine's normalized absolute path).
const SCRATCH = '/private/tmp/claude-501/-Users-me/f5bc/scratchpad';
const FS_FILES = {
  '/etc/hosts': '127.0.0.1 localhost\n',
  '/work/up.md': '# Up one\n',
  '/elsewhere/x.js': 'const elsewhere = 1;\n',
  '~/notes.md': { path: '/home/me/notes.md', content: '# Home notes\n' },
  [`${SCRATCH}/plan.md`]: '# Plan\n\n![the plan](img/p.png)\n\n![missing](../gone.png)\n',
};
const FS_ERRORS = {
  '/etc/secret.txt': [403, 'PERMISSION_DENIED'],
  '/etc': [400, 'IS_DIRECTORY'],
  '/dev/tty0': [400, 'NOT_A_REGULAR_FILE'],
  '/var/log/huge.log': [413, 'FILE_TOO_LARGE'],
  '/var/log/app.bin': [415, 'FILE_UNSUPPORTED'],
  '/mnt/slow.txt': [504, 'READ_TIMEOUT'],
  '/etc/odd.txt': [500, 'FS_READ_FAILED'],
  // The proxy's answer for a remote Engine without 'fs:read-any' (it said otherwise, or was downgraded).
  '/etc/old.txt': [501, 'FS_READ_UNSUPPORTED'],
};
const fsReads = []; // `${pathname} ${path}` of each any-path read
const fsImages = [];
// The remote Engines (through the proxy, /api/remote-servers/:id/...) and the capabilities of their /info: 7 is older, 8 reads any path.
const REMOTES = { 7: [], 8: ['fs:read-any'] };

// The fake server of every page: the local Client (/api/...) and the remote Engines, all with the same task. The any-path read (/fs/content,
// /fs/image) answers from FS_FILES / FS_ERRORS.
async function serve(route) {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
  if (url.pathname === '/api/remote-servers') return json(Object.keys(REMOTES).map(id => ({ id: Number(id), name: `Engine ${id}`, status: 'online' })));
  const remote = /^\/api\/remote-servers\/(\d+)\//.exec(url.pathname);
  const p = remote ? url.pathname.replace(remote[0], '/api/') : url.pathname;
  if (remote && p === '/api/info') return json({ api_version: 1, capabilities: REMOTES[remote[1]] || [] });
  if (p === '/api/fs/content') {
    const file = url.searchParams.get('path');
    fsReads.push(`${url.pathname} ${file}`);
    if (FS_ERRORS[file]) return json({ error: FS_ERRORS[file][1], message: `Error ${FS_ERRORS[file][1]}`, ...(FS_ERRORS[file][1] === 'IS_DIRECTORY' ? { path: file } : {}) }, FS_ERRORS[file][0]);
    const entry = FS_FILES[file];
    if (entry === undefined) return json({ error: 'NOT_FOUND', message: 'File not found' }, 404);
    const { path: filePath, content } = typeof entry === 'string' ? { path: file, content: entry } : entry;
    return json({ path: filePath, realPath: filePath, content, revision: 'r1', eol: '\n', bom: false });
  }
  if (p === '/api/fs/image') {
    fsImages.push(`${url.pathname} ${url.searchParams.get('path')}`);
    return url.searchParams.get('path') === `${SCRATCH}/img/p.png` ? route.fulfill({ contentType: 'image/png', body: PNG }) : json({ error: 'NOT_FOUND', message: 'File not found' }, 404);
  }
  if (p === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
  if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 'h5-default', title: 'Terminal 1' }]);
  if (p === '/api/tasks/1/agent/conversations') return json([]);
  if (p === '/api/tasks/1/terminals/h5-default/cwd') { cwdAsks += 1; return json(liveCwd); }
  if (p === '/api/tasks/1/files/image') {
    images.push(url.searchParams.get('path'));
    return url.searchParams.get('path') === 'docs/img/shot.png' ? route.fulfill({ contentType: 'image/png', body: PNG }) : json({ error: 'FILE_NOT_FOUND' }, 404);
  }
  if (p.startsWith('/api/tasks/1/files')) {
    const file = url.searchParams.get('path');
    reads.push(`${p.endsWith('/content') ? 'read' : 'list'} ${file}`);
    if (p.endsWith('/content')) {
      if (file === 'src') return json({ error: 'FILE_UNSUPPORTED' }, 415);
      return FILES[file] ? json({ path: file, content: FILES[file], revision: 'r1', eol: '\n', bom: false }) : json({ error: 'FILE_NOT_FOUND' }, 404);
    }
    return file === 'src' ? json({ entries: [], nextOffset: null, root: '/work/fix-login' }) : json({ error: 'FILE_NOT_DIRECTORY' }, 400);
  }
  return json({ error: 'not mocked' }, 404);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const errors = [];
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
    await page.route(`${ORIGIN}/**`, serve);
    await page.goto(`${ORIGIN}/h5`);
    await page.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first().tap();
    await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '$ ', cols: 50, rows: 24 })));
    await page.evaluate(() => window.sockets[0].emit('\r\nA1 ● Read(src/app.js:42)\r\nA2 see docs/设计.md\r\nA3 /etc/hosts and ../up.md\r\nA4 src/ folder\r\nA5 missing/gone.js\r\n'));
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('A5 missing'));
    assert.deepEqual(reads, [], 'printing paths reads nothing');
    const resizes = () => page.evaluate(() => window.sockets[0].sent.filter(data => data.includes('"resize"')).length);
    let resizesBefore = await resizes();

    // The centre of `text` in the row that starts with `prefix`, counted in cells (the CJK characters are two cells wide).
    const pointOf = (prefix, text) => page.evaluate(({ prefix, text }) => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const row = rows.find(node => node.textContent.startsWith(prefix));
      const screen = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect();
      const before = row.textContent.slice(0, row.textContent.indexOf(text));
      const cells = [...before].reduce((sum, ch) => sum + (/[⺀-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
      const box = row.getBoundingClientRect();
      const cellWidth = screen.width / 50;
      return { x: screen.left + (cells + 1.5) * cellWidth, y: box.top + box.height / 2 };
    }, { prefix, text });
    const tap = async point => page.touchscreen.tap(point.x, point.y);
    const sheet = page.locator('#h5-design-sheet .h5-design-panel');
    const closeSheet = async () => { await page.locator('#h5-design-close').tap(); await sheet.waitFor({ state: 'hidden' }); };

    // A pan that starts on a link is not a tap: sideways, up, down and diagonal pans from the path open nothing and read nothing
    // (public/js/terminal-gestures.js; real CDP touches, which the browser turns into touch, pointer and, for a tap only, mouse and click events).
    {
      const cdp = await context.newCDPSession(page);
      const pan = async (from, dx, dy) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
        for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + dx * i / 6, y: from.y + dy * i / 6 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const link = await pointOf('A1 ', 'src/app.js');
      for (const [dx, dy] of [[80, 0], [-60, 0], [0, -60], [0, 60], [40, 25]]) await pan(link, dx, dy);
      await page.waitForTimeout(700); // past the double-tap wait a link tap has
      assert.equal(await sheet.isVisible(), false, 'a pan from a file link opens no file');
      assert.deepEqual(reads, [], 'a pan from a file link reads nothing');
      await cdp.detach();
    }

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

    // Long paths over several rows: a tap on the wrapped part opens the file. C1 is one line that xterm wraps; C2 is cut at the last column with
    // real newlines and an indent, as Claude Code prints a tool result ("  \u23bf  " in front, five spaces on the next rows). The terminal is
    // as wide as the phone screen fits (not the 50 columns of the snapshot): the full first row of C1 gives the width.
    const longPath = name => `/work/fix-login/deep/f5bcf118-e52a-4af7-b324-e791d46313f4/scratchpad/${name}`;
    await page.evaluate(text => window.sockets[0].emit(text), `C1 ${longPath('soft-test.md')}\r\n`);
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('soft-test.md'));
    const cols = await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].find(node => node.textContent.startsWith('C1 ')).textContent.length);
    assert.ok(cols > 30 && `C1 ${longPath('soft-test.md')}`.length > cols, `the soft-wrapped path spans two rows (${cols} columns)`);
    const hard = `C2 \u23bf  ${longPath('hard-test.md')}`;
    const hardRows = [hard.slice(0, cols)];
    for (let rest = hard.slice(cols); rest; rest = rest.slice(cols - 5)) hardRows.push(`     ${rest.slice(0, cols - 5)}`);
    await page.evaluate(text => window.sockets[0].emit(text), `${hardRows.join('\r\n')}\r\n`);
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('hard-test.md'));
    // The centre of `text` in the one row that holds it (ASCII only).
    const pointIn = text => page.evaluate(({ text, cols }) => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')].filter(node => node.textContent.includes(text));
      if (rows.length !== 1) return null;
      const screen = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect();
      const box = rows[0].getBoundingClientRect();
      return { x: screen.left + (rows[0].textContent.indexOf(text) + 1.5) * (screen.width / cols), y: box.top + box.height / 2 };
    }, { text, cols });
    for (const [name, heading] of [['soft-test.md', 'Soft long path'], ['hard-test.md', 'Hard long path']]) {
      const point = await pointIn(name);
      assert.ok(point, `${name} is on one row`);
      await tap(point);
      await page.locator('#h5-design-body h1', { hasText: heading }).waitFor();
      assert.equal(await page.locator('#h5-design-title').textContent(), name);
      await closeSheet();
    }
    await tap(await pointOf('C2 ', '/work'));
    await page.locator('#h5-design-body h1', { hasText: 'Hard long path' }).waitFor();
    await closeSheet();

    // A large file: only a window of lines exists, the named line is marked and in view, and scrolling draws the lines that come into view.
    await page.evaluate(() => window.sockets[0].emit('B1 big/log.txt:150000\r\nB2 docs/pic.md\r\n'));
    await page.waitForFunction(text => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.startsWith(text)), 'B2 ');
    const opened = await page.evaluate(() => performance.now());
    await tap(await pointOf('B1 ', 'big/log.txt'));
    await page.locator('#h5-design-body .h5-file-line.is-target').waitFor();
    const big = await page.evaluate(started => {
      const body = document.querySelector('#h5-design-body').getBoundingClientRect();
      const target = document.querySelector('.h5-file-line.is-target');
      const box = target.getBoundingClientRect();
      return { ms: performance.now() - started, lines: document.querySelectorAll('#h5-design-body .h5-file-line').length, line: target.dataset.line, text: target.textContent, inView: box.top >= body.top && box.bottom <= body.bottom };
    }, opened);
    assert.equal(big.line, '150000');
    assert.match(big.text, /^150000 log line/);
    assert.ok(big.inView, 'the named line is in view');
    assert.ok(big.lines < 400, `only a window of lines is drawn: ${big.lines}`);
    console.log(`large file: ${big.lines} line elements for 200000 lines, shown ${Math.round(big.ms)} ms after the tap`);
    await page.evaluate(() => { document.querySelector('#h5-design-body').scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('#h5-design-body .h5-file-line')?.dataset.line === '1');
    await page.evaluate(() => { const body = document.querySelector('#h5-design-body'); body.scrollTop = body.scrollHeight; });
    await page.waitForFunction(() => [...document.querySelectorAll('#h5-design-body .h5-file-line')].at(-1)?.dataset.line === '200000');
    await closeSheet();
    // Markdown with relative images: the one in the folder loads from the file API, a missing one and one outside show their text.
    await tap(await pointOf('B2 ', 'docs/pic.md'));
    await page.locator('#h5-design-body h1', { hasText: 'Pictures' }).waitFor();
    await page.waitForFunction(() => { const img = document.querySelector('#h5-design-body img[alt="the shot"]'); return img && img.complete && img.naturalWidth === 1; });
    await page.locator('#h5-design-body .h5-design-image', { hasText: 'gone picture' }).waitFor();
    assert.equal(await page.locator('#h5-design-body .h5-design-image', { hasText: 'outside' }).count(), 1, 'a path outside the working directory is not asked for');
    assert.deepEqual(images.sort(), ['docs/img/missing.png', 'docs/img/shot.png']);
    if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-file-link-images.png') });
    await closeSheet();

    // After "cd sub" (no OSC 7): the tap asks the server for the shell's directory and opens the file from there.
    liveCwd = { cwd: '/work/fix-login/sub', relative: 'sub' };
    await page.evaluate(() => window.sockets[0].emit('A6 a.md\r\n'));
    await page.waitForFunction(text => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.startsWith(text)), 'A6 ');
    await tap(await pointOf('A6 ', 'a.md'));
    await page.locator('#h5-design-body h1', { hasText: 'In sub' }).waitFor();
    assert.equal(reads[reads.length - 1], 'read sub/a.md');
    await closeSheet();
    // The shell reports its directory with OSC 7 (ST terminator here): relative paths come from it, the server is not asked.
    const asksBefore = cwdAsks;
    await page.evaluate(() => window.sockets[0].emit('\x1b]7;file://engine-host/work/fix-login/other\x1b\\A7 x.js\r\n'));
    await page.waitForFunction(text => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.startsWith(text)), 'A7 ');
    await tap(await pointOf('A7 ', 'x.js'));
    await page.locator('#h5-design-body .h5-file-line').first().waitFor();
    assert.equal(reads[reads.length - 1], 'read other/x.js');
    assert.equal(cwdAsks, asksBefore, 'a reported directory needs no request');
    await closeSheet();
    // A reported directory outside the working directory: relative paths there are links read with the any-path read (the local Client has it).
    let readsBefore = reads.length;
    await page.evaluate(() => window.sockets[0].emit('\x1b]7;file://engine-host/elsewhere\x07A8 x.js\r\n'));
    await page.waitForFunction(text => [...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent.startsWith(text)), 'A8 ');
    await tap(await pointOf('A8 ', 'x.js'));
    await page.locator('#h5-design-body .h5-file-line', { hasText: 'const elsewhere' }).waitFor();
    assert.equal(fsReads.at(-1), '/api/fs/content /elsewhere/x.js');
    assert.equal(await page.locator('#h5-design-title').textContent(), 'x.js');
    assert.equal(await page.locator('#h5-design-path').textContent(), '/elsewhere/x.js');
    assert.equal(reads.length, readsBefore, 'the task file API is not asked for an outside path');
    await closeSheet();
    // The screen is restored (a reconnect, maybe a new shell): the reported directory is forgotten. The server says the shell is outside: the
    // file opens from there (no "Outside the working directory" note any more).
    assert.equal(await resizes(), resizesBefore, 'the link taps so far send no resize to the PTY');
    liveCwd = { cwd: '/elsewhere', relative: null };
    await page.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '$ \r\nA9 x.js\r\n', cols: 50, rows: 24 })));
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('A9 x.js'));
    const fsBefore = fsReads.length;
    await tap(await pointOf('A9 ', 'x.js'));
    await page.locator('#h5-design-body .h5-file-line', { hasText: 'const elsewhere' }).waitFor();
    assert.deepEqual(fsReads.slice(fsBefore), ['/api/fs/content /elsewhere/x.js']);
    assert.equal(await page.getByText('Outside the working directory: x.js').count(), 0, 'no outside note');
    assert.equal(reads.length, readsBefore, 'nothing is read through the task file API when the shell is outside');
    await closeSheet();
    liveCwd = { cwd: '/work/fix-login', relative: '' };
    await page.evaluate(lines => window.sockets[0].emit(lines), ['', 'A1 ● Read(src/app.js:42)', 'A3 /etc/hosts and ../up.md', 'D1 see ~/notes.md', `D2 ${SCRATCH}/plan.md`,
      'D3 /etc/secret.txt', 'D4 /etc and /dev/tty0', 'D5 /var/log/huge.log', 'D6 /nope/gone.md', 'D7 /var/log/app.bin and /mnt/slow.txt', 'D8 /etc/odd.txt', ''].join('\r\n'));
    await page.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('D6 /nope'));
    resizesBefore = await resizes(); // a restored screen sends its size once; the taps below must send none

    // Outside the working directory: an absolute path, one above the root (placed from the live directory) and a ~/ path open in the sheet; the
    // title is the file name and the second line the full path (for ~/ the Engine's normalized path).
    readsBefore = reads.length;
    for (const [prefix, text, request, title, shown, check] of [
      ['A3 ', '/etc/hosts', '/etc/hosts', 'hosts', '/etc/hosts', page.locator('#h5-design-body .h5-file-line', { hasText: '127.0.0.1' })],
      ['A3 ', '../up.md', '/work/up.md', 'up.md', '/work/up.md', page.locator('#h5-design-body h1', { hasText: 'Up one' })],
      ['D1 ', '~/notes.md', '~/notes.md', 'notes.md', '/home/me/notes.md', page.locator('#h5-design-body h1', { hasText: 'Home notes' })],
    ]) {
      await tap(await pointOf(prefix, text));
      await check.waitFor();
      assert.equal(fsReads.at(-1), `/api/fs/content ${request}`, text);
      assert.equal(await page.locator('#h5-design-title').textContent(), title);
      assert.equal(await page.locator('#h5-design-path').textContent(), shown);
      assert.equal(await page.locator('#h5-design-path').getAttribute('title'), shown, 'the full path is the tooltip too');
      await closeSheet();
    }
    // Markdown outside the root: its relative images are read with /fs/image from the file's folder; one that does not load shows its text.
    await tap(await pointOf('D2 ', '/private'));
    await page.locator('#h5-design-body h1', { hasText: 'Plan' }).waitFor();
    await page.waitForFunction(() => { const img = document.querySelector('#h5-design-body img[alt="the plan"]'); return img && img.complete && img.naturalWidth === 1; });
    await page.locator('#h5-design-body .h5-design-image', { hasText: 'missing' }).waitFor();
    assert.deepEqual(fsImages.sort(), [`/api/fs/image /private/tmp/claude-501/-Users-me/f5bc/gone.png`, `/api/fs/image ${SCRATCH}/img/p.png`]);
    if (process.env.H5_SHOT_DIR) await page.screenshot({ path: path.join(process.env.H5_SHOT_DIR, 'h5-file-link-outside.png') });
    await closeSheet();
    // Errors of the any-path read show a note in the sheet.
    for (const [prefix, text, note] of [
      ['D3 ', '/etc/secret.txt', 'The file cannot be read'],
      ['D4 ', '/etc', 'Folders cannot be shown on the phone'],
      ['D4 ', '/dev/tty0', 'This is not a plain file'],
      ['D5 ', '/var/log/huge.log', 'The file is larger than 5 MB'],
      ['D6 ', '/nope/gone.md', 'Not found: /nope/gone.md'],
      ['D7 ', '/var/log/app.bin', 'This is not a plain text file'],
      ['D7 ', '/mnt/slow.txt', 'Reading the file took too long'],
      ['D8 ', '/etc/odd.txt', 'Could not open the file'],
    ]) {
      await tap(await pointOf(prefix, text));
      await page.locator('#h5-design-empty', { hasText: note }).waitFor();
      assert.equal(fsReads.at(-1), `/api/fs/content ${text}`);
      await closeSheet();
    }
    assert.equal(reads.length, readsBefore, 'outside paths never reach the task file API');
    // A double tap on a path selects and copies the word and opens nothing; a triple tap selects and copies the line.
    const fsBeforeDouble = fsReads.length;
    const point = await pointOf('A1 ', 'src/app.js');
    // Plain HTTP here: the copy goes through the legacy copy command from a temporary field; record what it copies.
    await page.evaluate(() => { window.copied = null; document.execCommand = command => { if (command === 'copy') window.copied = document.activeElement.value; return command === 'copy'; }; });
    const copiedNow = () => page.evaluate(() => window.copied);
    await tap(point); await page.waitForTimeout(80); await tap(point);
    await page.waitForFunction(() => window.copied === 'src/app.js:42', null, { timeout: 3000 })
      .catch(async error => { throw new Error(`double tap copied ${JSON.stringify(await copiedNow())}`, { cause: error }); });
    await page.waitForTimeout(700);
    assert.equal(await sheet.isVisible(), false, 'a double tap does not open the file');
    assert.equal(await page.locator('#h5-clipboard-bar').count(), 0, 'no bar after the copy');
    await page.getByText('Copied 13 characters').first().waitFor();
    await page.waitForTimeout(500);
    await tap(point); await page.waitForTimeout(80); await tap(point); await page.waitForTimeout(80); await tap(point);
    await page.waitForFunction(() => (window.copied || '').trim() === 'A1 ● Read(src/app.js:42)', null, { timeout: 3000 })
      .catch(async error => { throw new Error(`triple tap copied ${JSON.stringify(await copiedNow())}`, { cause: error }); });
    await page.waitForTimeout(700);
    assert.equal(await sheet.isVisible(), false, 'a triple tap does not open the file');
    assert.equal(reads.length, readsBefore, 'outside paths never reach the task file API, and the double and triple taps read nothing');
    assert.equal(fsReads.length, fsBeforeDouble);
    assert.equal(await resizes(), resizesBefore, 'the link taps send no resize to the PTY');
    assert.deepEqual(errors, []);
    await context.close();

    // Remote Engines. 8 has 'fs:read-any': an outside path is read through the proxy. 7 is older: outside paths are no links and a shell outside
    // the root still says "Outside the working directory".
    for (const id of [8, 7]) {
      const remoteContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const remotePage = await remoteContext.newPage();
      remotePage.on('pageerror', error => errors.push(error.message));
      await remotePage.addInitScript(key => {
        try { localStorage.setItem('h5-source', key); } catch { /* ignore */ }
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
      }, `remote:${id}`);
      await remotePage.route(`${ORIGIN}/**`, serve);
      const infoAsked = remotePage.waitForRequest(request => request.url().endsWith(`/api/remote-servers/${id}/info`));
      await remotePage.goto(`${ORIGIN}/h5`);
      await remotePage.locator('.h5-task-item', { hasText: 'Fix login' }).tap();
      await remotePage.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first().tap();
      await remotePage.locator('#h5-tasks').waitFor({ state: 'hidden' });
      await remotePage.waitForFunction(() => window.sockets.length === 1 && window.sockets[0].readyState === 1);
      assert.match(await remotePage.evaluate(() => window.sockets[0].url), new RegExp(`/api/remote-servers/${id}/terminal/ws`));
      await infoAsked;
      await remotePage.evaluate(() => window.sockets[0].emit(JSON.stringify({ type: 'history', data: '$ \r\nR1 /etc/hosts\r\nR2 ~/notes.md\r\nR3 x.js\r\nR4 /etc/old.txt\r\n', cols: 50, rows: 24 })));
      await remotePage.waitForFunction(() => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows')?.textContent.includes('R3 x.js'));
      await remotePage.waitForTimeout(100);
      const remotePoint = (prefix, text) => remotePage.evaluate(({ prefix, text }) => {
        const row = [...document.querySelectorAll('.xterm-rows > div')].find(node => node.textContent.startsWith(prefix));
        const screen = document.querySelector('.h5-xterm:not([hidden]) .xterm-screen').getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return { x: screen.left + (row.textContent.indexOf(text) + 1.5) * (screen.width / 50), y: box.top + box.height / 2 };
      }, { prefix, text });
      const remoteSheet = remotePage.locator('#h5-design-sheet .h5-design-panel');
      const fsStart = fsReads.length;
      const readsStart = reads.length;
      if (id === 8) {
        for (const [prefix, text, check] of [['R1 ', '/etc/hosts', '127.0.0.1'], ['R2 ', '~/notes.md', 'Home notes']]) {
          const p = await remotePoint(prefix, text);
          await remotePage.touchscreen.tap(p.x, p.y);
          await remotePage.locator('#h5-design-body', { hasText: check }).waitFor();
          assert.equal(fsReads.at(-1), `/api/remote-servers/8/fs/content ${text}`, `${text} through the proxy`);
          await remotePage.locator('#h5-design-close').tap(); await remoteSheet.waitFor({ state: 'hidden' });
        }
        // The shell outside the root (server cwd): the file opens from there through the proxy.
        liveCwd = { cwd: '/elsewhere', relative: null };
        const p = await remotePoint('R3 ', 'x.js');
        await remotePage.touchscreen.tap(p.x, p.y);
        await remotePage.locator('#h5-design-body', { hasText: 'const elsewhere' }).waitFor();
        assert.equal(fsReads.at(-1), '/api/remote-servers/8/fs/content /elsewhere/x.js');
        liveCwd = { cwd: '/work/fix-login', relative: '' };
        await remotePage.locator('#h5-design-close').tap(); await remoteSheet.waitFor({ state: 'hidden' });
        // The proxy answers 501 FS_READ_UNSUPPORTED: the old note, no sheet, and outside paths are no links any more on this Engine.
        const old = await remotePoint('R4 ', '/etc/old.txt');
        await remotePage.touchscreen.tap(old.x, old.y);
        await remotePage.getByText('Outside the working directory: /etc/old.txt').first().waitFor();
        await remoteSheet.waitFor({ state: 'hidden' });
        const readsAfter = fsReads.length;
        const hosts = await remotePoint('R1 ', '/etc/hosts');
        await remotePage.touchscreen.tap(hosts.x, hosts.y);
        await remotePage.waitForTimeout(700);
        assert.equal(await remoteSheet.isVisible(), false, 'no link after FS_READ_UNSUPPORTED');
        assert.equal(fsReads.length, readsAfter);
      } else {
        for (const [prefix, text] of [['R1 ', '/etc/hosts'], ['R2 ', '~/notes.md']]) {
          const p = await remotePoint(prefix, text);
          await remotePage.touchscreen.tap(p.x, p.y);
          await remotePage.waitForTimeout(700);
          assert.equal(await remoteSheet.isVisible(), false, `${text} is no link on an older Engine`);
        }
        liveCwd = { cwd: '/elsewhere', relative: null };
        const p = await remotePoint('R3 ', 'x.js');
        await remotePage.touchscreen.tap(p.x, p.y);
        await remotePage.getByText('Outside the working directory: x.js').first().waitFor();
        assert.equal(await remoteSheet.isVisible(), false);
        liveCwd = { cwd: '/work/fix-login', relative: '' };
        assert.equal(fsReads.length, fsStart, 'an older Engine is never asked for an any-path read');
      }
      assert.equal(reads.length, readsStart, 'outside paths never reach the task file API');
      await remoteContext.close();
    }
    assert.deepEqual(errors, []);
    console.log('h5 file links browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

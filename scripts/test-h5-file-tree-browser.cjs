// The read-only file tree of the MUI page (scripts/h5-shell/FileTree.jsx, Headless Tree) in real Chromium:
// - phone 390x844 (touch): "Docs" in row 2 opens the design document, whose "Files" button opens the tree in a bottom sheet (the tree's
//   "Design document" button leads back); the root is read on open, a folder only when it is expanded (one request each), a
//   folder of 450 entries is read in pages of 200 with a "Load more" row; a missing folder and an empty folder show a note; a tap on a file opens it in
//   the file viewer over the tree with a back arrow; the back arrow and the Android back button (history back) return to the tree with its folders and
//   its scroll position kept; Close closes both; the tree is drawn again for another task; every row is 44px high; nothing is resized on the PTY.
// - phone 320x640 (touch): eight buttons do not fit, so "Docs" is left out of row 2 (the saved commands list has it); its Files button leads to the tree.
// - computer 1440x900 (mouse): the tree is the right side panel (`html[data-side-panel]`); a file opens in the panel over it, back and Escape return one
//   layer; a remote Engine's tree is read through `/api/remote-servers/:id/tasks/:task/files`.
// H5_SHOT_DIR=<dir> saves screenshots (phone at 3x). Chinese names are written with \u escapes (test/i18n.test.js).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const DESIGN = '\u8bbe\u8ba1.md'; // a Chinese file name
const PAGE = 200; // the page size of services/task-files.js

const pad = n => String(n).padStart(4, '0');
// The working directories, as the server would list them (folders first, then by name). A value of null is a folder that is gone (404).
const TREES = {
  '/api/tasks/1/files': {
    '': [['big', 'directory'], ['docs', 'directory'], ['gone', 'directory'], ['src', 'directory'], ['README.md', 'file'], ['link', 'symlink']],
    big: Array.from({ length: 450 }, (_, i) => [`f-${pad(i)}.txt`, 'file']),
    docs: [['empty', 'directory'], ['a.md', 'file'], [DESIGN, 'file']],
    'docs/empty': [],
    gone: null,
    src: [['app.js', 'file']],
  },
  '/api/tasks/2/files': { '': [['notes.md', 'file']] },
  '/api/remote-servers/7/tasks/5/files': { '': [['srv', 'directory'], ['remote.txt', 'file']], srv: [['deep.txt', 'file']] },
};
const CONTENT = {
  'README.md': '# Read me\n\nHello.\n',
  'docs/a.md': '# Doc A\n\nText of A.\n',
  [`docs/${DESIGN}`]: '# Design\n',
  'src/app.js': 'const app = 1;\n',
  'remote.txt': 'remote text\n',
};
for (let i = 0; i < 450; i += 1) CONTENT[`big/f-${pad(i)}.txt`] = `file ${i}\n`;

async function openPage(browser, { viewport, touch = true }) {
  const scale = SHOTS && touch ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  const errors = [];
  const lists = []; // "<base> <path>@<offset>" of every list request
  const reads = [];
  page.on('pageerror', error => errors.push(error.message));
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
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([{ id: 7, name: 'Lab', status: 'online' }]);
    if (p === '/api/tasks' && route.request().method() === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }, { id: 2, title: 'Write docs', status: 'doing', work_dir: '/work/docs' }]);
    if (p === '/api/remote-servers/7/tasks') return json([{ id: 5, title: 'Remote job', status: 'doing', work_dir: '/srv/job' }]);
    if (/^\/api(\/remote-servers\/7)?\/task-groups$/.test(p)) return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    const terms = p.match(/^\/api(?:\/remote-servers\/7)?\/tasks\/(\d+)\/terminals$/);
    if (terms) return json([{ terminal_id: `t${terms[1]}`, title: 'Terminal 1' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/remote-servers/7/info') return json({ capabilities: [] });
    const content = p.match(/^(.*\/files)\/content$/);
    if (content && TREES[content[1]]) {
      const file = url.searchParams.get('path');
      reads.push(file);
      return CONTENT[file] !== undefined ? json({ path: file, content: CONTENT[file], revision: 'r1', eol: '\n', bom: false }) : json({ error: 'FILE_NOT_FOUND' }, 404);
    }
    if (TREES[p]) {
      const folder = url.searchParams.get('path') || '';
      const offset = Number(url.searchParams.get('offset') || 0);
      lists.push(`${p} ${folder || '.'}@${offset}`);
      const entries = TREES[p][folder];
      if (entries === undefined || entries === null) return json({ error: 'FILE_NOT_FOUND' }, 404);
      const pageEntries = entries.slice(offset, offset + PAGE).map(([name, type]) => ({ name, path: folder ? `${folder}/${name}` : name, type }));
      await new Promise(resolve => setTimeout(resolve, 60)); // a request takes some time: the loading state is drawn
      return json({ entries: pageEntries, nextOffset: offset + pageEntries.length < entries.length ? offset + pageEntries.length : null, root: '/work', writable: false });
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const row = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await row.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await row[how]();
  await page.waitForFunction(() => window.sockets.length >= 1 && window.sockets.at(-1).readyState === 1);
  return { context, page, how, errors, lists, reads };
}

const rowOf = (page, filePath) => page.locator(`#h5-files-tree [data-path="${filePath}"]`);
const names = page => page.evaluate(() => [...document.querySelectorAll('#h5-files-tree [role="treeitem"]')].map(node => node.textContent));
const resizes = page => page.evaluate(() => window.sockets.reduce((sum, socket) => sum + socket.sent.filter(data => data.includes('"resize"')).length, 0));
// The sheet has stopped sliding (its transform is none or the identity).
// The tree is reached from the Docs button (the design document sheet) and its Files button; under 360px Docs is in the saved commands list.
async function openTree(page, how = 'tap') {
  if (await page.locator('#h5-design').isVisible()) await page.locator('#h5-design')[how]();
  else { await page.locator('#h5-commands')[how](); await page.locator('#h5-commands-docs')[how](); }
  await page.locator('#h5-design-files')[how]();
  await page.locator('#h5-files-sheet .h5-files-panel').waitFor({ state: 'visible' });
}
const settled = (page, selector) => page.waitForFunction(sel => { const node = document.querySelector(sel); return node && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(node).transform); }, selector, { timeout: 3000 });

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844, touch ──
    {
      const { context, page, errors, lists, reads } = await openPage(browser, { viewport: { width: 390, height: 844 } });
      const resizesBefore = await resizes(page);
      assert.equal(await page.locator('#h5-files').count(), 0, 'no Files button in row 2: Docs leads to the tree');
      assert.equal(await page.locator('#h5-files-sheet').count(), 0, 'the sheet is not drawn before it is opened');
      assert.deepEqual(lists, [], 'nothing is listed before the tree is opened');
      await page.locator('#h5-design').tap();
      const viewerFiles = page.locator('#h5-design-files');
      assert.equal(await viewerFiles.getAttribute('aria-label'), 'Files');
      assert.equal(await viewerFiles.getAttribute('title'), 'Files');
      await viewerFiles.tap();
      const sheet = page.locator('#h5-files-sheet .h5-files-panel');
      await sheet.waitFor({ state: 'visible' });
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' }); // the design document makes way for the tree
      await rowOf(page, 'README.md').waitFor();
      assert.deepEqual(lists, ['/api/tasks/1/files .@0'], 'only the root is read');
      assert.deepEqual(await names(page), ['big', 'docs', 'gone', 'src', 'README.md', 'link​link'.replace('​', '')], 'folders first, the symbolic link marked');
      assert.equal(await page.locator('#h5-files-path').textContent(), '/work/fix-login');
      assert.equal(await page.locator('#h5-files-tree').getAttribute('role'), 'tree');
      assert.equal(await rowOf(page, 'docs').getAttribute('role'), 'treeitem');
      assert.equal(await rowOf(page, 'docs').getAttribute('aria-expanded'), 'false');
      // 44px rows in touch mode.
      const heights = await page.evaluate(() => [...document.querySelectorAll('#h5-files-tree .MuiListItemButton-root')].map(node => node.getBoundingClientRect().height));
      assert.ok(heights.every(h => h >= 44), `rows are 44px high (${heights})`);
      for (const id of ['h5-files-design', 'h5-files-reload', 'h5-files-close']) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `${id} is a 44px target`);
        assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), await page.locator(`#${id}`).getAttribute('title'));
      }
      await settled(page, '#h5-files-sheet .h5-files-panel');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-file-tree-phone.png') });

      // A folder is read when it is expanded, once.
      await rowOf(page, 'docs').tap();
      await rowOf(page, `docs/${DESIGN}`).waitFor();
      assert.equal(await rowOf(page, 'docs').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(lists.slice(1), ['/api/tasks/1/files docs@0']);
      await rowOf(page, 'docs/empty').tap();
      await page.locator('#h5-files-tree .h5-files-note', { hasText: 'Empty folder' }).waitFor();
      await rowOf(page, 'docs/empty').tap(); // closed again: nothing is read again when it opens
      await rowOf(page, 'docs/empty').tap();
      await page.locator('#h5-files-tree .h5-files-note', { hasText: 'Empty folder' }).waitFor();
      assert.equal(lists.filter(entry => entry.includes('docs/empty')).length, 1, 'a folder is read once');
      // A folder that is gone shows a note.
      await rowOf(page, 'gone').tap();
      await page.locator('#h5-files-tree .h5-files-note[data-error="true"]', { hasText: 'This folder no longer exists' }).waitFor();
      // A symbolic link is not opened.
      const readsBefore = reads.length;
      await rowOf(page, 'link').tap({ force: true }); // aria-disabled: Playwright would wait for it to be enabled
      await page.getByText('Symbolic links are not opened').first().waitFor();
      assert.equal(reads.length, readsBefore);

      // Paging: 450 entries in pages of 200, with a "Load more" row.
      await rowOf(page, 'big').tap();
      await rowOf(page, 'big/f-0199.txt').waitFor();
      assert.equal(await rowOf(page, 'big/f-0200.txt').count(), 0);
      const more = page.locator('#h5-files-tree .h5-files-more');
      assert.equal(await more.count(), 1);
      assert.equal(await more.textContent(), 'Load more');
      await more.scrollIntoViewIfNeeded();
      await more.tap();
      await rowOf(page, 'big/f-0399.txt').waitFor();
      await more.scrollIntoViewIfNeeded();
      await more.tap();
      await rowOf(page, 'big/f-0449.txt').waitFor();
      assert.equal(await more.count(), 0, 'no "Load more" after the last page');
      assert.deepEqual(lists.filter(entry => entry.includes(' big@')), ['/api/tasks/1/files big@0', '/api/tasks/1/files big@200', '/api/tasks/1/files big@400']);
      assert.equal(await page.locator('#h5-files-tree [data-path^="big/"]').count(), 450);

      // Open a file deep in the list: the viewer lies over the tree with a back arrow.
      const target = rowOf(page, 'big/f-0300.txt');
      await target.scrollIntoViewIfNeeded();
      const scrollBefore = await page.evaluate(() => document.getElementById('h5-files-body').scrollTop);
      assert.ok(scrollBefore > 1000, `the tree is scrolled (${scrollBefore})`);
      const listsBefore = lists.length;
      await target.tap();
      const viewer = page.locator('#h5-design-sheet .h5-design-panel');
      await viewer.waitFor({ state: 'visible' });
      await page.locator('#h5-design-body .h5-file-line').first().waitFor();
      assert.equal(await page.locator('#h5-design-title').textContent(), 'f-0300.txt');
      assert.equal(await page.locator('#h5-design-path').textContent(), '/work/fix-login/big/f-0300.txt');
      const back = page.locator('#h5-design-back');
      assert.equal(await back.getAttribute('aria-label'), 'Back to files');
      assert.equal(await back.getAttribute('title'), 'Back to files');
      assert.equal(await page.locator('#h5-design-files').count(), 0, 'no Files button when the tree is under the viewer');
      await back.tap();
      await viewer.waitFor({ state: 'hidden' });
      assert.ok(await sheet.isVisible(), 'the tree is shown again');
      assert.equal(await page.evaluate(() => document.getElementById('h5-files-body').scrollTop), scrollBefore, 'the scroll position is kept');
      assert.equal(await rowOf(page, 'docs').getAttribute('aria-expanded'), 'true', 'the expanded folders are kept');
      assert.equal(await rowOf(page, 'big/f-0300.txt').getAttribute('aria-selected'), 'false');
      assert.equal(lists.length, listsBefore, 'nothing is listed again');

      // A Markdown file is rendered; the Android back button returns to the tree, then closes it.
      await rowOf(page, 'docs/a.md').scrollIntoViewIfNeeded();
      await rowOf(page, 'docs/a.md').tap();
      await page.locator('#h5-design-body h1', { hasText: 'Doc A' }).waitFor();
      await settled(page, '#h5-design-sheet .h5-design-panel');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-file-tree-phone-viewer.png') });
      await page.waitForTimeout(100); // the history entries of the layers are pushed
      await page.goBack();
      await viewer.waitFor({ state: 'hidden' });
      assert.ok(await sheet.isVisible(), 'back returns to the tree');
      await page.waitForTimeout(100);
      await page.goBack();
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).pathname, '/h5', 'the page is not left');

      // Opened again: as it was left. Close in the viewer closes both.
      await openTree(page);
      assert.equal(await rowOf(page, 'docs').getAttribute('aria-expanded'), 'true');
      await rowOf(page, 'README.md').scrollIntoViewIfNeeded();
      await rowOf(page, 'README.md').tap();
      await page.locator('#h5-design-body h1', { hasText: 'Read me' }).waitFor();
      await page.locator('#h5-design-close').tap();
      await viewer.waitFor({ state: 'hidden' });
      await sheet.waitFor({ state: 'hidden' });

      assert.equal(await resizes(page), resizesBefore, 'the tree and the viewer send no resize to the PTY');

      // Another task: a new tree from its own working directory.
      await page.locator('#h5-open-tasks').tap();
      await page.locator('.h5-task-item', { hasText: 'Write docs' }).tap();
      await page.locator('#h5-tasks .h5-terminal-list[aria-label="Write docs"] .h5-terminal-main').first().tap();
      await page.locator('#h5-tasks').waitFor({ state: 'hidden' });
      await openTree(page);
      await rowOf(page, 'notes.md').waitFor();
      // The tree's Design document button: DESIGN.md over the tree, its back arrow returns to the tree.
      await page.locator('#h5-files-design').tap();
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'visible' });
      await page.locator('#h5-design-back').tap();
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      assert.ok(await sheet.isVisible(), 'back from the design document returns to the tree');
      assert.equal(await rowOf(page, 'docs').count(), 0, 'the old tree is gone');
      assert.equal(await page.locator('#h5-files-path').textContent(), '/work/docs');
      assert.equal(lists.at(-1), '/api/tasks/2/files .@0');
      await page.locator('#h5-files-close').tap();
      await sheet.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 320x640, touch: Files is left out of row 2, the viewer leads to the tree ──
    {
      const { context, page, errors, lists } = await openPage(browser, { viewport: { width: 320, height: 640 } });
      assert.equal(await page.locator('#h5-design').isVisible(), false, 'no room for an eighth button at 320px: Docs is left out');
      const widths = await page.evaluate(() => [...document.querySelectorAll('#h5-actions > button, #h5-actions > label')].filter(node => getComputedStyle(node).display !== 'none').map(node => Math.round(node.getBoundingClientRect().width)));
      assert.ok(widths.every(w => w >= 44), `row 2 keeps 44px buttons (${widths})`);
      await page.locator('#h5-commands').tap();
      await page.locator('#h5-commands-docs').tap();
      const viewerFiles = page.locator('#h5-design-files');
      await viewerFiles.waitFor();
      assert.equal(await viewerFiles.getAttribute('aria-label'), 'Files');
      await viewerFiles.tap();
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      await rowOf(page, 'README.md').waitFor();
      assert.deepEqual(lists, ['/api/tasks/1/files .@0']);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Computer 1440x900, mouse ──
    {
      const { context, page, errors, lists } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false });
      await openTree(page, 'click');
      const panel = page.locator('#h5-files-sheet .h5-files-panel');
      await panel.waitFor({ state: 'visible' });
      await rowOf(page, 'src').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.hasAttribute('data-side-panel')), 'the page makes room for the panel');
      await page.waitForFunction(() => { const p = document.querySelector('.h5-files-panel'); return p && Math.abs(p.getBoundingClientRect().right - innerWidth) <= 1; });
      const rowHeight = (await rowOf(page, 'src').boundingBox()).height;
      assert.ok(rowHeight >= 34 && rowHeight < 44, `compact rows with a mouse (${rowHeight})`);
      // Keyboard: the arrows move in the tree, ArrowRight opens a folder, Enter opens a file.
      await rowOf(page, 'src').click();
      await rowOf(page, 'src/app.js').waitFor();
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.path === 'src/app.js', null, { timeout: 3000 }); // the focus moves after a frame
      await page.keyboard.press('Enter');
      const viewer = page.locator('#h5-design-sheet .h5-design-panel');
      await viewer.waitFor({ state: 'visible' });
      await page.locator('#h5-design-body .h5-file-line').first().waitFor();
      assert.equal(await page.locator('#h5-design-title').textContent(), 'app.js');
      assert.ok(await page.locator('#h5-design-back').isVisible());
      await page.waitForFunction(() => { const p = document.querySelector('.h5-design-side'); return p && Math.abs(p.getBoundingClientRect().right - innerWidth) <= 1; });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-file-tree-viewer.png') });
      // Escape returns one layer: the viewer, then the tree.
      await page.locator('#h5-design-body').click();
      await page.keyboard.press('Escape');
      await viewer.waitFor({ state: 'hidden' });
      assert.ok(await panel.isVisible());
      assert.equal(await rowOf(page, 'src').getAttribute('aria-expanded'), 'true');
      assert.equal(await rowOf(page, 'src/app.js').getAttribute('aria-selected'), 'false');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-file-tree.png') });
      // The back arrow too; Close hides the panel.
      await rowOf(page, 'README.md').click();
      await page.locator('#h5-design-body h1', { hasText: 'Read me' }).waitFor();
      await page.locator('#h5-design-back').click();
      await viewer.waitFor({ state: 'hidden' });
      await page.locator('#h5-files-close').click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-side-panel')), false);
      await openTree(page, 'click');
      await page.locator('#h5-files-tree [data-path="README.md"]').click();
      await page.locator('#h5-design-body h1', { hasText: 'Read me' }).waitFor();
      await page.keyboard.press('Escape');
      await viewer.waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });

      // A remote Engine: the tree is read through the remote proxy, and it is a new tree.
      await openTree(page, 'click');
      await page.locator('#h5-engine').selectOption('remote:7');
      await page.locator('.h5-task-item', { hasText: 'Remote job' }).click();
      const remoteRow = page.locator('#h5-tasks .h5-terminal-list[aria-label="Remote job"] .h5-terminal-main').first();
      await remoteRow.waitFor();
      await remoteRow.click();
      await rowOf(page, 'remote.txt').waitFor();
      assert.equal(await page.locator('#h5-files-path').textContent(), '/srv/job');
      await rowOf(page, 'srv').click();
      await rowOf(page, 'srv/deep.txt').waitFor();
      assert.deepEqual(lists.filter(entry => entry.startsWith('/api/remote-servers/')), ['/api/remote-servers/7/tasks/5/files .@0', '/api/remote-servers/7/tasks/5/files srv@0']);
      await rowOf(page, 'remote.txt').click();
      await page.locator('#h5-design-body .h5-file-line', { hasText: 'remote text' }).waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 file tree browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

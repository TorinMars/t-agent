// File links in the desktop terminal: real task routes, xterm, Monaco and a real shell. A path printed by the shell is a link; Cmd/Ctrl + click
// opens it in the file browser above the terminal (the folders expanded, the file in a tab, the line of "file:line" in view and marked).
// A plain click opens nothing, a path outside the working directory is not a link, and a missing path gives a notice without opening the panel.
// SHOT_DIR=<dir> saves a screenshot of the opened file there.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const express = require('express');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
// The real path: a shell that reports its directory (OSC 7) names the physical one (/private/var/... on macOS), which must match the work dir text.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-file-links-')));
process.env.T_AGENT_DATA_DIR = path.join(scratch, 'data');
process.env.TASKS_BASE_DIR = path.join(scratch, 'tasks');
const auth = require.resolve('../middleware/auth');
require.cache[auth] = { id: auth, filename: auth, loaded: true, exports: (req, res, next) => { req.session = { user: { login: 'owner' } }; next(); } };
const db = require('../db');
const engine = require('../services/engine-tasks');
const terminal = require('../routes/terminal');
const task = engine.createTask('owner', { title: 'Links fixture' });
fs.mkdirSync(path.join(task.work_dir, 'src'));
fs.mkdirSync(path.join(task.work_dir, 'docs'));
fs.writeFileSync(path.join(task.work_dir, 'src/app.js'), Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n');
fs.writeFileSync(path.join(task.work_dir, 'docs/设计.md'), '# Design\n');
fs.writeFileSync(path.join(scratch, 'outside.md'), '# Outside\n');
// The lines the shell prints. They are read from a file with a short command: typing the long paths key by key into a real
// interactive shell on a busy machine sometimes damaged them (a space inside the path), which broke the links under test.
fs.writeFileSync(path.join(scratch, 'lines.txt'), ['L1 src/app.js:42 and docs/设计.md', `L2 ${path.join(task.work_dir, 'src')}/`,
  `L4 ${path.join(scratch, 'outside.md')}`, 'L5 ../outside.md', 'L3 missing/nothing.js https://example.com/x/y.js', ''].join('\n'));
process.env.TFL_LINES = path.join(scratch, 'lines.txt'); // the terminal shell gets this environment
// The live directory: a file only in sub/ (the shell does "cd sub"), one only in other/ (an OSC 7 report names it), one outside the work dir.
fs.mkdirSync(path.join(task.work_dir, 'sub'));
fs.mkdirSync(path.join(task.work_dir, 'other'));
fs.writeFileSync(path.join(task.work_dir, 'sub/a.md'), '# In sub\n');
fs.writeFileSync(path.join(task.work_dir, 'other/b.md'), '# In other\n');
fs.writeFileSync(path.join(scratch, 'c.md'), '# Outside\n');
const osc7 = dir => `\x1b]7;file://engine-host${dir.split('/').map(encodeURIComponent).join('/')}\x07`;
// Short commands on the shell's PATH print them (long typed commands are flaky on a busy machine). "sleep" keeps the shell from reporting its own
// directory at the next prompt, which would replace the printed report.
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
const script = (name, text, wait) => { fs.writeFileSync(path.join(scratch, `${name}.txt`), text); fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncat '${path.join(scratch, `${name}.txt`)}'\n${wait ? 'sleep 60\n' : ''}`, { mode: 0o755 }); };
script('tfl6', 'L6 a.md\n', false);
script('tfl7', `${osc7(path.join(task.work_dir, 'other'))}L7 b.md\n`, true);
script('tfl8', `${osc7(scratch)}L8 c.md\n`, true);
process.env.PATH = `${bin}:${process.env.PATH}`;
const app = express(); app.use(express.json({ limit: '32mb' }));
app.use('/api/tasks', require('../routes/tasks'));
app.get('/js/app.js', (req, res) => res.type('js').send(fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8').split('// app.js loads before the other feature scripts')[0]));
app.get('/', (req, res) => res.type('html').sendFile(path.join(root, 'public/index.html')));
app.use(express.static(path.join(root, 'public')));
let server; let browser; let wss;
(async () => {
  try {
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => terminal.handleWs(ws, req, { login: 'owner' }));
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const fileRequests = [];
    page.on('request', request => { if (request.url().includes('/files')) fileRequests.push(decodeURIComponent(request.url())); });
    await page.addInitScript(id => localStorage.setItem('selectedTaskId', String(id)), task.id);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => { const Original = window.Terminal; window.__testTerms = []; window.Terminal = class extends Original { constructor(...args) { super(...args); window.__testTerms.push(this); } }; return Tasks.load(); });
    await page.locator('#content-tabs [data-tab="shell"]').click();
    await page.waitForFunction(() => document.querySelector('#xterm-container .xterm-screen')?.clientHeight > 10);
    const input = page.locator('#xterm-container .xterm-helper-textarea');
    await input.focus();
    await page.keyboard.type('clear; cat "$TFL_LINES"');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const b = window.__testTerms[0]?.buffer.active; return b && Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).some(line => line?.startsWith('L3 ')); }, undefined, { timeout: 90000 });
    assert.equal(fileRequests.length, 0, 'printing paths sends nothing to the file API');
    const printed = await page.evaluate(() => { const b = window.__testTerms[0].buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true)); });
    for (const line of fs.readFileSync(process.env.TFL_LINES, 'utf8').split('\n').filter(Boolean)) assert.ok(printed.includes(line), `the shell printed the fixture line unchanged: ${line}`);

    // The pixel centre of `text` on the row that starts with `prefix` (cells counted with xterm, so the wide CJK characters are right).
    const pointOf = (prefix, text) => page.evaluate(({ prefix, text }) => {
      const term = window.__testTerms[0];
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y += 1) {
        const line = buffer.getLine(y);
        const value = line.translateToString(true);
        if (!value.trimStart().startsWith(prefix)) continue; // zsh may leave a space in front of a program's first line
        const index = value.indexOf(text);
        if (index < 0) return null;
        let column = 0; let seen = 0;
        for (let x = 0; x < line.length && seen < index; x += 1) { const cell = line.getCell(x); if (!cell.getWidth()) continue; seen += cell.getChars().length || 1; column = x + cell.getWidth(); }
        if (y < buffer.viewportY || y >= buffer.viewportY + term.rows) term.scrollToLine(Math.max(0, y - Math.floor(term.rows / 2))); // the panel made the terminal short
        const screen = document.querySelector('#xterm-container .xterm-screen').getBoundingClientRect();
        const cellWidth = screen.width / term.cols; const cellHeight = screen.height / term.rows;
        return { x: screen.left + (column + 1.5) * cellWidth, y: screen.top + (y - buffer.viewportY + 0.5) * cellHeight };
      }
      return null;
    }, { prefix, text });
    const hover = async point => { await page.mouse.move(point.x, point.y - 3); await page.mouse.move(point.x, point.y); await page.waitForTimeout(150); };
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    // xterm finds the link under the mouse a little after the move; on a busy machine wait for it (the pointer cursor) before clicking.
    const modClick = async (point, link = true) => { await hover(point); if (link) await page.waitForFunction(() => document.querySelector('#xterm-container .xterm-screen')?.classList.contains('xterm-cursor-pointer')); await page.keyboard.down(modifier); await page.mouse.click(point.x, point.y); await page.keyboard.up(modifier); };
    const underlined = () => page.evaluate(() => document.querySelector('#xterm-container .xterm-screen')?.classList.contains('xterm-cursor-pointer'));

    // A plain click on a path selects text as before; it opens nothing.
    const appPoint = await pointOf('L1 ', 'src/app.js:42');
    await hover(appPoint);
    assert.equal(await underlined(), true, 'a path inside the working directory is a link on hover');
    assert.equal(fileRequests.length, 0, 'hovering sends nothing to the file API');
    await page.mouse.click(appPoint.x, appPoint.y);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#file-panel').count(), 0, 'a plain click does not open the file browser');

    // Cmd/Ctrl + click: the file browser opens on src/app.js at line 42.
    await modClick(appPoint);
    await page.locator('#file-panel').waitFor({ state: 'visible' });
    await page.locator('.file-tree-row.is-selected[data-path="src/app.js"]').waitFor();
    await page.locator('.file-editor-tab.is-active[data-tab-path="src/app.js"]').waitFor();
    await page.waitForFunction(() => monaco.editor.getEditors()[0]?.getPosition()?.lineNumber === 42);
    await page.waitForFunction(() => document.querySelectorAll('#file-panel-editor .file-panel-line-mark').length === 1, undefined, { timeout: 3000 }).catch(() => {});
    const view = await page.evaluate(() => { const editor = monaco.editor.getEditors()[0]; const ranges = editor.getVisibleRanges(); return { first: ranges[0].startLineNumber, last: ranges[ranges.length - 1].endLineNumber, marks: document.querySelectorAll('#file-panel-editor .file-panel-line-mark').length }; });
    assert.ok(view.first <= 42 && view.last >= 42, `line 42 is in view (${JSON.stringify(view)})`);
    assert.equal(view.marks, 1, 'the target line is marked');
    assert.equal(await page.locator('.file-tree-row[data-path="src"]').getAttribute('aria-expanded'), 'true', 'the folder above the file is expanded');
    if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'terminal-file-link-desktop.png') });

    // A Chinese file name (wide cells) opens too, in the panel that is already open.
    await modClick(await pointOf('L1 ', 'docs/'));
    await page.locator('.file-editor-tab.is-active[data-tab-path="docs/设计.md"]').waitFor();

    // An absolute folder inside the working directory opens as the folder in the tree.
    await modClick(await pointOf('L2 ', 'src/'));
    await page.waitForFunction(() => document.querySelector('.file-tree-row.is-selected')?.dataset.path === 'src');

    // Outside the working directory (absolute or ../): not a link, so a click does nothing and asks nothing.
    const before = fileRequests.length;
    for (const [prefix, text] of [['L4 ', path.join(scratch, 'outside.md')], ['L5 ', '../outside.md']]) {
      const point = await pointOf(prefix, text);
      await hover(point);
      assert.equal(await underlined(), false, `${text} is not a link`);
      await modClick(point, false);
    }
    // A web link stays a web link (the web links addon opens it in a new tab).
    await page.evaluate(() => { window.__opened = []; window.open = (...args) => { window.__opened.push(args[0]); return null; }; });
    await modClick(await pointOf('L3 ', 'example.com/x/y.js'));
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://example.com/x/y.js']);
    await page.waitForTimeout(300);
    assert.equal(fileRequests.length, before, 'outside paths and web links do not reach the file API');

    // A missing path: one read, then a notice; the panel keeps its file.
    await modClick(await pointOf('L3 ', 'missing/nothing.js'));
    await page.locator('.toast', { hasText: 'Not found in the working directory: missing/nothing.js' }).waitFor();
    assert.equal(await page.locator('.file-editor-tab').count(), 2);

    // The shell's live directory. After "cd sub" a relative path opens from sub/ (the server reads the shell's directory, or the shell's own
    // OSC 7 report names it when its configuration sends one).
    const runInShell = async (command, prefix) => {
      await input.focus();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await page.waitForFunction(text => { const b = window.__testTerms[0]?.buffer.active; return b && Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).some(line => line?.trimStart().startsWith(text)); }, prefix, { timeout: Number(process.env.TFL_WAIT) || 90000 })
        .catch(async error => { if (process.env.TFL_DEBUG) console.log(await page.evaluate(() => { const b = window.__testTerms[0].buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true)).filter(Boolean).join('\n'); })); throw error; });
    };
    await runInShell('cd sub;tfl6', 'L6 ');
    await modClick(await pointOf('L6 ', 'a.md'));
    await page.locator('.file-editor-tab.is-active[data-tab-path="sub/a.md"]').waitFor();
    // An OSC 7 report printed by a program names other/.
    await runInShell('tfl7', 'L7 ');
    await modClick(await pointOf('L7 ', 'b.md'));
    await page.locator('.file-editor-tab.is-active[data-tab-path="other/b.md"]').waitFor();
    // A reported directory outside the work dir: relative paths there are no links and open nothing.
    await input.focus(); await page.keyboard.press('Control+C'); // the opened file took the focus
    await runInShell('tfl8', 'L8 ');
    const outsideBefore = fileRequests.length;
    const cPoint = await pointOf('L8 ', 'c.md');
    await hover(cPoint);
    assert.equal(await underlined(), false, 'c.md from an outside directory is not a link');
    await modClick(cPoint, false);
    await page.waitForTimeout(300);
    assert.equal(fileRequests.length, outsideBefore, 'nothing is asked for a path from an outside directory');
    await input.focus(); await page.keyboard.press('Control+C'); // the opened file took the focus
    assert.deepEqual(errors, []);
    console.log('terminal file links browser test passed');
  } finally {
    if (browser) await browser.close();
    terminal.closeTaskTerminals(task.id);
    if (wss) { for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); }
    if (server) await new Promise(r => server.close(r));
    db.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

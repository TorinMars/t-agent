// File links in the page's terminal on a computer (1440x900, mouse): the page at `/` (public/h5.html) with the real task routes, the real terminal
// WebSocket handler, xterm and a real shell. A path the shell prints is a link on hover; a click opens it in the top sheet (the line of
// "file:line" marked), a missing path says so, and relative paths follow the shell's live directory (after "cd", read by the server; or an OSC 7
// report). A path outside the working directory (absolute, ~/, above the root, from a reported directory outside it) is a link too on the local
// Client, read with `GET /api/fs/content` (a fake here that reads the disk: the server side is tested on its own) and never with the task file API.
// Replaces the old desktop-page version (Monaco file browser), removed in 2.88.0.
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
fs.mkdirSync(path.join(scratch, 'home'));
fs.writeFileSync(path.join(scratch, 'home/notes.md'), '# Home notes\n');
fs.writeFileSync(path.join(scratch, 'lines.txt'), ['L1 src/app.js:42 and docs/设计.md', `L4 ${path.join(scratch, 'outside.md')}`, 'L5 ../outside.md', 'L11 ~/notes.md', 'L3 missing/nothing.js', ''].join('\n'));
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
// Long paths over several rows: L10 is printed as one line (xterm wraps it, soft), L9 is cut at the terminal width with an indent on the next rows
// as Claude Code and other programs that wrap text themselves print it (hard: real newlines). Both are one link. The hard rows leave the last
// column free (a box with a right padding; zsh may also put a space in front of the first row, which then fills it).
const deep = path.join(task.work_dir, '-Users-torin-Documents-torin-t-agent-data-SELF-TAGENT-t-agent/f5bcf118-e52a-4af7-b324-e791d46313f4/scratchpad', 'a-long-folder-name-'.repeat(6));
fs.mkdirSync(deep, { recursive: true });
fs.writeFileSync(path.join(deep, 'soft-target.md'), '# Soft wrapped\n');
fs.writeFileSync(path.join(deep, 'hard-target.md'), '# Hard wrapped\n');
script('tfl10', `L10 ${path.join(deep, 'soft-target.md')}\n`, false);
fs.writeFileSync(path.join(scratch, 'tfl9.txt'), `L9 ${path.join(deep, 'hard-target.md')}`);
fs.writeFileSync(path.join(bin, 'tfl9'), `#!/bin/bash\nline="$(cat '${path.join(scratch, 'tfl9.txt')}')"; c=$(( $(tput cols) - 1 )); printf '%s\\n' "\${line:0:c}"; rest="\${line:c}"\nwhile [ -n "$rest" ]; do printf '   %s\\n' "\${rest:0:c-3}"; rest="\${rest:c-3}"; done\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const app = express(); app.use(express.json({ limit: '32mb' }));
app.use('/api/tasks', require('../routes/tasks'));
app.use('/api/task-groups', require('../routes/task-groups'));
// What the page asks for besides tasks and terminals: no remote Engines, no update, no chats.
app.get('/api/remote-servers', (req, res) => res.json([]));
app.get('/auth/me', (req, res) => res.json({ work_dir: null, effective_work_dir: process.env.TASKS_BASE_DIR }));
app.get('/api/system/version', (req, res) => res.json({ app_version: '0.0.0', boot_id: 'b1' }));
app.all('/api/system/*', (req, res) => res.json({ status: 'current', is_update_admin: false }));
app.get('/api/agent-chat/summary', (req, res) => res.json({ running: 0, queued: 0, submitted: 0 }));
// The any-path read (the contract of /api/fs/content): absolute or ~/ (here the home is scratch/home), regular files only.
const fsReads = [];
app.get('/api/fs/content', (req, res) => {
  const requested = String(req.query.path || '');
  fsReads.push(requested);
  const file = requested.startsWith('~/') ? path.join(scratch, 'home', requested.slice(2)) : requested;
  if (!path.isAbsolute(file)) return res.status(400).json({ error: 'BAD_PATH', message: 'Bad path' });
  let stat;
  try { stat = fs.statSync(file); } catch { return res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' }); }
  if (stat.isDirectory()) return res.status(400).json({ error: 'IS_DIRECTORY', message: 'This is a directory', path: path.resolve(file) });
  return res.json({ path: path.resolve(file), realPath: fs.realpathSync(file), content: fs.readFileSync(file, 'utf8'), revision: 'r1', eol: '\n', bom: false });
});
app.get('/', (req, res) => res.type('html').sendFile(path.join(root, 'public/h5.html')));
app.use(express.static(path.join(root, 'public'), { index: false }));
app.use((req, res) => res.status(404).json({ error: 'not mocked' }));
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
    await page.addInitScript(() => { window.__testTerms = []; Object.defineProperty(window, 'Terminal', { configurable: true, set(Original) { delete window.Terminal; window.Terminal = class extends Original { constructor(...args) { super(...args); window.__testTerms.push(this); } }; }, get() { return undefined; } }); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'pointer', 'a computer with a mouse: pointer mode');
    await page.locator('.h5-task-item', { hasText: 'Links fixture' }).click();
    await page.locator('#h5-tasks .h5-terminal-list[aria-label="Links fixture"] .h5-terminal-main').first().click();
    await page.waitForFunction(() => document.querySelector('.h5-xterm .xterm-screen')?.clientHeight > 10);
    const input = page.locator('.h5-xterm .xterm-helper-textarea');
    const runInShell = async (command, prefix) => {
      await input.focus();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await page.waitForFunction(text => { const b = window.__testTerms.at(-1)?.buffer.active; return b && Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).some(line => line?.trimStart().startsWith(text)); }, prefix, { timeout: 90000 });
    };
    await runInShell('clear; cat "$TFL_LINES"', 'L3 ');
    assert.equal(fileRequests.length, 0, 'printing paths sends nothing to the file API');

    // The pixel centre of `text` on the row that starts with `prefix` (cells counted with xterm, so the wide CJK characters are right).
    const pointOf = (prefix, text) => page.evaluate(({ prefix, text }) => {
      const term = window.__testTerms.at(-1);
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y += 1) {
        const line = buffer.getLine(y);
        const value = line.translateToString(true);
        if (!value.trimStart().startsWith(prefix)) continue; // zsh may leave a space in front of a program's first line
        const index = value.indexOf(text);
        if (index < 0) return null;
        let column = 0; let seen = 0;
        for (let x = 0; x < line.length && seen < index; x += 1) { const cell = line.getCell(x); if (!cell.getWidth()) continue; seen += cell.getChars().length || 1; column = x + cell.getWidth(); }
        if (y < buffer.viewportY || y >= buffer.viewportY + term.rows) term.scrollToLine(Math.max(0, y - Math.floor(term.rows / 2)));
        const screen = document.querySelector('.h5-xterm .xterm-screen').getBoundingClientRect();
        const cellWidth = screen.width / term.cols; const cellHeight = screen.height / term.rows;
        return { x: screen.left + (column + 1.5) * cellWidth, y: screen.top + (y - buffer.viewportY + 0.5) * cellHeight };
      }
      return null;
    }, { prefix, text });
    // The pixel centre of `text` on the one row that holds it (any row: a wrapped part of a path does not start with a prefix).
    const pointIn = text => page.evaluate(text => {
      const term = window.__testTerms.at(-1);
      const buffer = term.buffer.active;
      const rows = [];
      for (let y = 0; y < buffer.length; y += 1) { const index = buffer.getLine(y).translateToString(true).indexOf(text); if (index >= 0) rows.push({ y, index }); }
      if (rows.length !== 1) return null;
      const { y, index } = rows[0];
      if (y < buffer.viewportY || y >= buffer.viewportY + term.rows) term.scrollToLine(Math.max(0, y - Math.floor(term.rows / 2)));
      const screen = document.querySelector('.h5-xterm .xterm-screen').getBoundingClientRect();
      const cellWidth = screen.width / term.cols; const cellHeight = screen.height / term.rows;
      return { x: screen.left + (index + 1.5) * cellWidth, y: screen.top + (y - buffer.viewportY + 0.5) * cellHeight, cols: term.cols };
    }, text);
    const hover = async point => { await page.mouse.move(point.x, point.y - 3); await page.mouse.move(point.x, point.y); await page.waitForTimeout(150); };
    const underlined = () => page.evaluate(() => document.querySelector('.h5-xterm .xterm-screen')?.classList.contains('xterm-cursor-pointer'));
    // xterm finds the link under the mouse a little after the move; on a busy machine wait for it (the pointer cursor) before clicking.
    const click = async (point, link = true) => { await hover(point); if (link) await page.waitForFunction(() => document.querySelector('.h5-xterm .xterm-screen')?.classList.contains('xterm-cursor-pointer')); await page.mouse.click(point.x, point.y); };
    const panel = page.locator('#h5-design-sheet .h5-design-panel');
    const closePanel = async () => { await page.locator('#h5-design-close').click(); await panel.waitFor({ state: 'hidden' }); };

    // A click on a path opens it in the top sheet at line 42.
    const appPoint = await pointOf('L1 ', 'src/app.js:42');
    await hover(appPoint);
    assert.equal(await underlined(), true, 'a path inside the working directory is a link on hover');
    assert.equal(fileRequests.length, 0, 'hovering sends nothing to the file API');
    await click(appPoint);
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.evaluate(node => Boolean(node.closest('.MuiDrawer-anchorTop'))), true, 'on a wide screen too the file opens in the sheet from the top');
    await page.locator('#h5-design-body .h5-file-line.is-target').waitFor();
    assert.equal(await page.locator('#h5-design-title').textContent(), 'app.js');
    assert.equal(await page.locator('#h5-design-body .h5-file-line.is-target').getAttribute('data-line'), '42');
    if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'terminal-file-link-pc.png') });
    await closePanel();

    // A Chinese file name (wide cells) opens too.
    await click(await pointOf('L1 ', 'docs/'));
    await page.locator('#h5-design-body h1', { hasText: 'Design' }).waitFor();
    assert.equal(await page.locator('#h5-design-title').textContent(), '设计.md');
    await closePanel();

    // Outside the working directory: an absolute path and a ~/ path open with the any-path read; one above the root is placed from the work dir
    // (here missing, which the panel says). None of them reaches the task file API.
    const before = fileRequests.length;
    const outside = path.join(scratch, 'outside.md');
    await click(await pointOf('L4 ', outside));
    await page.locator('#h5-design-body h1', { hasText: 'Outside' }).waitFor();
    assert.equal(fsReads.at(-1), outside);
    assert.equal(await page.locator('#h5-design-title').textContent(), 'outside.md');
    assert.equal(await page.locator('#h5-design-path').getAttribute('title'), outside, 'the full path');
    await closePanel();
    await click(await pointOf('L11 ', '~/notes.md'));
    await page.locator('#h5-design-body h1', { hasText: 'Home notes' }).waitFor();
    assert.equal(fsReads.at(-1), '~/notes.md');
    assert.equal(await page.locator('#h5-design-path').getAttribute('title'), path.join(scratch, 'home/notes.md'), 'the path the Engine resolved');
    await closePanel();
    const above = path.join(path.dirname(task.work_dir), 'outside.md');
    await click(await pointOf('L5 ', '../outside.md'));
    await page.locator('#h5-design-empty', { hasText: `Not found: ${above}` }).waitFor();
    assert.equal(fsReads.at(-1), above);
    await closePanel();
    assert.equal(fileRequests.length, before, 'outside paths do not reach the task file API');

    // A missing path says so.
    await click(await pointOf('L3 ', 'missing/nothing.js'));
    await page.locator('#h5-design-empty', { hasText: 'Not found in the working directory: missing/nothing.js' }).waitFor();
    await closePanel();

    // Long paths over two or more rows: a click on the first or the last row opens the file.
    await runInShell('clear; tfl10', 'L10 ');
    const softEnd = await pointIn('soft-target.md');
    assert.ok(softEnd, 'the end of the soft-wrapped path is on the screen');
    assert.ok(path.join(deep, 'soft-target.md').length + 4 > softEnd.cols * 2, `the path spans three rows or more (${softEnd.cols} columns)`);
    for (const point of [await pointOf('L10 ', '/'), softEnd]) {
      await click(point);
      await page.locator('#h5-design-body h1', { hasText: 'Soft wrapped' }).waitFor();
      await closePanel();
    }
    await runInShell('clear; tfl9', 'L9 ');
    const nextWrapped = await page.evaluate(() => { const b = window.__testTerms.at(-1).buffer.active; for (let y = 0; y < b.length; y += 1) if (b.getLine(y).translateToString().trimStart().startsWith('L9 ')) return b.getLine(y + 1).isWrapped || b.getLine(y + 2).isWrapped; return null; });
    assert.equal(nextWrapped, false, 'the hard-wrapped rows are separate lines for xterm');
    for (const point of [await pointOf('L9 ', '/'), await pointIn('hard-target.md')]) {
      assert.ok(point, 'the hard-wrapped path is on the screen');
      await click(point);
      await page.locator('#h5-design-body h1', { hasText: 'Hard wrapped' }).waitFor();
      assert.equal(await page.locator('#h5-design-title').textContent(), 'hard-target.md');
      await closePanel();
    }

    // The shell's live directory. After "cd sub" a relative path opens from sub/ (the server reads the shell's directory).
    await runInShell('cd sub;tfl6', 'L6 ');
    await click(await pointOf('L6 ', 'a.md'));
    await page.locator('#h5-design-body h1', { hasText: 'In sub' }).waitFor();
    await closePanel();
    // An OSC 7 report printed by a program names other/.
    await runInShell('tfl7', 'L7 ');
    await click(await pointOf('L7 ', 'b.md'));
    await page.locator('#h5-design-body h1', { hasText: 'In other' }).waitFor();
    await closePanel();
    // A reported directory outside the work dir: relative paths there open from it with the any-path read.
    await input.focus(); await page.keyboard.press('Control+C');
    await runInShell('tfl8', 'L8 ');
    const outsideBefore = fileRequests.length;
    await click(await pointOf('L8 ', 'c.md'));
    await page.locator('#h5-design-body h1', { hasText: 'Outside' }).waitFor();
    assert.equal(fsReads.at(-1), path.join(scratch, 'c.md'));
    assert.equal(fileRequests.length, outsideBefore, 'the task file API is not asked for a path from an outside directory');
    await closePanel();
    await input.focus(); await page.keyboard.press('Control+C');
    assert.deepEqual(errors, []);
    console.log('terminal file links browser test (computer) passed');
  } finally {
    if (browser) await browser.close();
    terminal.closeTaskTerminals(task.id);
    if (wss) { for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); }
    if (server) await new Promise(r => server.close(r));
    db.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

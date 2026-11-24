// The shell notebook in the page ("Shell notebook: the page" in docs/design/shell-notebook-page.md), in real headless Chromium against a stand-in
// engine (express on a free port) that implements the notebook API and stream of the contract with a scripted shell (no real PTY):
// - New session: Shell notebook after New Terminal with its flask and caption; its sub-list (New notebook, the task's .ipynb files with file and
//   time, Back); New notebook makes a notebook row and opens its view (no terminal socket).
// - Typing (sent 400 ms after typing stops, flushed before a run), Shift+Enter runs and makes a new cell, output streams in, the meta line, the
//   kernel chip and the task list's "Notebook · Running cell N"; queued cells; the input field sends what is typed; Stop; Run all stops at a
//   failed cell; the restart dialog; a long output shows its last 200 lines (Show all, Download); a full-screen program offers a terminal; SGR
//   colours; ops from another device; the header's menu (Download .ipynb); long cells fold (Show all / Show less, Z, opening to edit, Run,
//   remote ops, text cells); a deleted row closes the view.
// - 1440x900 with a mouse and 390x844 touch: 44px targets, the action bar above the bottom navigation, the 44px run button of each cell.
// SCREENSHOTS=<dir> saves pictures of each step.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const express = require('express');
const { settled } = require('./browser-test-wait.cjs');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-notebook-browser-')); // nothing here can reach the person's data
const root = path.resolve(__dirname, '..');
const SHOTS = process.env.SCREENSHOTS || '';
const WAIT = { timeout: 10000 };
const ESC = '\u001b';
const CHOICES = ['Claude session', 'Codex session', 'OpenCode session', 'New Terminal', 'Shell notebook'];
const AT_1 = new Date(2026, 10, 23, 14, 21).getTime();
const AT_2 = new Date(2026, 10, 20, 9, 5).getTime();

// ── The stand-in engine ──
function createEngine() {
  const state = { terminals: [], notebooks: new Map(), posts: [], inputs: [], opsPosts: [], runs: [], seq: 0 };
  const code = (id, source = '') => ({ id, type: 'code', source, count: null, state: 'idle', exit: null, duration_ms: null, started_at: null, ended_at: null, lines: [], dropped: 0 });
  function makeNotebook(tid, title, file, cells) {
    const nb = { id: tid, task_id: 1, title, path: file, folder: '/home/t/tasks/self', revision: 1,
      kernel: { state: 'stopped', shell: 'zsh', running: null, queue: [], waiting_input: false, counter: 0 }, cells, clients: new Set(), waiter: null };
    state.notebooks.set(tid, nb);
    return nb;
  }
  const doc = nb => ({ id: nb.id, task_id: nb.task_id, title: nb.title, path: nb.path, folder: nb.folder, revision: nb.revision, kernel: nb.kernel, cells: nb.cells });
  const send = (nb, event) => { for (const res of nb.clients) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const cellOf = (nb, id) => nb.cells.find(cell => cell.id === id);
  const patch = (nb, id, change) => { Object.assign(cellOf(nb, id), change); send(nb, { type: 'cell', id, patch: change }); };
  const output = (nb, id, from, lines) => { const cell = cellOf(nb, id); cell.lines = cell.lines.slice(0, from).concat(lines); send(nb, { type: 'output', id, from, lines, dropped: cell.dropped }); };
  const kernel = (nb, change) => { Object.assign(nb.kernel, change); send(nb, { type: 'kernel', kernel: nb.kernel }); };
  const later = ms => new Promise(resolve => setTimeout(resolve, ms));

  function finish(nb, id, exit, end) {
    const cell = cellOf(nb, id);
    const ended = Date.now();
    patch(nb, id, { state: end, exit, ended_at: ended, duration_ms: ended - cell.started_at });
    const cleared = end === 'failed' || end === 'stopped' || end === 'interrupted';
    if (cleared) for (const other of nb.kernel.queue) patch(nb, other, { state: 'idle' });
    kernel(nb, { running: null, waiting_input: false, queue: cleared ? [] : nb.kernel.queue, state: nb.kernel.state === 'stopped' ? 'stopped' : 'idle' });
    nb.waiter = null;
    setTimeout(() => pump(nb), 10);
  }
  async function execute(nb, cell) {
    const id = cell.id;
    const [word, arg] = cell.source.trim().split(/\s+/);
    const running = () => cellOf(nb, id) && cellOf(nb, id).state === 'running' && nb.kernel.running === id;
    if (word === 'echo') { await later(150); if (!running()) return; output(nb, id, 0, cell.source.trim().split('\n').map(line => line.replace(/^echo\s*/, ''))); finish(nb, id, 0, 'done'); return; }
    if (word === 'color') { output(nb, id, 0, [`${ESC}[31mred${ESC}[0m and ${ESC}[1;32mbold green`, `still green${ESC}[0m plain`, `${ESC}[38;5;208morange${ESC}[0m ${ESC}[7minverse${ESC}[0m`]); finish(nb, id, 0, 'done'); return; }
    if (word === 'progress') { output(nb, id, 0, ['Downloading 10%']); await later(100); output(nb, id, 0, ['Downloading 100%', 'done']); finish(nb, id, 0, 'done'); return; }
    if (word === 'stream') {
      const total = Number(arg) || 1000;
      for (let at = 0; at < total; at += 250) {
        if (!running()) return;
        output(nb, id, at, Array.from({ length: Math.min(250, total - at) }, (_, k) => `line ${at + k + 1}`));
        await later(20);
      }
      finish(nb, id, 0, 'done');
      return;
    }
    if (word === 'fail') { await later(80); output(nb, id, 0, ['! [rejected] main -> main (fetch first)', 'error: failed to push some refs']); finish(nb, id, 1, 'failed'); return; }
    if (word === 'htop' || word === 'vim') { await later(50); const cellNow = cellOf(nb, id); cellNow.program = word; patch(nb, id, { state: 'fullscreen', exit: 130, program: word, ended_at: Date.now(), duration_ms: 50 }); kernel(nb, { running: null, queue: [], state: 'idle' }); for (const other of nb.kernel.queue) patch(nb, other, { state: 'idle' }); setTimeout(() => pump(nb), 10); return; }
    if (word === 'read') {
      output(nb, id, 0, ['Release now? [y/N] ']);
      kernel(nb, { waiting_input: true });
      const text = await new Promise(resolve => { nb.waiter = { input: resolve, stop: () => resolve(null) }; });
      if (text === null) return;
      output(nb, id, 0, [`Release now? [y/N] ${text}`, `got ${text}`]);
      finish(nb, id, 0, 'done');
      return;
    }
    if (word === 'wait') { await new Promise(resolve => { nb.waiter = { input: () => {}, stop: resolve }; }); return; }
    await later(30);
    if (running()) finish(nb, id, 0, 'done');
  }
  function pump(nb) {
    if (nb.kernel.running || !nb.kernel.queue.length || nb.kernel.state === 'starting' || nb.kernel.state === 'stopped') return;
    const id = nb.kernel.queue[0];
    const counter = nb.kernel.counter + 1;
    patch(nb, id, { state: 'running', count: counter, started_at: Date.now(), exit: null, ended_at: null, duration_ms: null });
    kernel(nb, { state: 'busy', running: id, queue: nb.kernel.queue.slice(1), counter });
    void execute(nb, cellOf(nb, id));
  }
  function applyOps(nb, list) {
    for (const op of list) {
      const at = nb.cells.findIndex(cell => cell.id === op.id);
      if (op.op === 'insert') nb.cells.splice(Math.min(op.index, nb.cells.length), 0, op.cell.type === 'code' ? code(op.cell.id || `s${++state.seq}`, op.cell.source) : { id: op.cell.id, type: 'markdown', source: op.cell.source });
      else if (op.op === 'set' && at >= 0) nb.cells[at].source = op.source;
      else if (op.op === 'type' && at >= 0) nb.cells[at] = op.type === 'code' ? code(nb.cells[at].id, nb.cells[at].source) : { id: nb.cells[at].id, type: 'markdown', source: nb.cells[at].source };
      else if (op.op === 'delete' && at >= 0) nb.cells.splice(at, 1);
      else if (op.op === 'move' && at >= 0) { const [cell] = nb.cells.splice(at, 1); nb.cells.splice(op.index, 0, cell); }
    }
    nb.revision += 1;
  }

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.get(['/', '/h5'], (req, res) => res.type('html').sendFile(path.join(root, 'public/h5.html')));
  app.use(express.static(path.join(root, 'public'), { index: false }));
  app.get('/auth/me', (req, res) => res.json({ effective_work_dir: '/home/t/tasks' }));
  app.get('/api/remote-servers', (req, res) => res.json([]));
  app.get('/api/task-groups', (req, res) => res.json([{ key: 'doing', name: 'Doing', sort_order: 1 }]));
  app.get('/api/tasks', (req, res) => res.json([{ id: 1, title: 'SELF-TAGENT', status: 'doing', work_dir: '/home/t/tasks/self' }]));
  app.get('/api/system/version', (req, res) => res.json({ app_version: '0.0.0', boot_id: 'b1' }));
  app.all('/api/system/*', (req, res) => res.json({ status: 'current', is_update_admin: false }));
  app.get('/api/tasks/1/terminals', (req, res) => res.json(state.terminals));
  app.post('/api/tasks/1/terminals', (req, res) => {
    const body = req.body || {};
    state.posts.push(body);
    if (body.agent === 'notebook') {
      const file = body.session_id || `notebooks/notebook${state.terminals.filter(row => row.agent === 'notebook').length ? `-${state.terminals.length}` : ''}.ipynb`;
      const existing = state.terminals.find(row => row.agent === 'notebook' && row.notebook === file);
      if (existing) return res.json({ ...existing, existing: true });
      const tid = `nb${++state.seq}`;
      const title = body.title || (body.session_id ? path.basename(file, '.ipynb') : `Notebook ${state.terminals.filter(row => row.agent === 'notebook').length + 1}`);
      const row = { terminal_id: tid, title, agent: 'notebook', notebook: file, work_dir: '/home/t/tasks/self' };
      state.terminals.push(row);
      makeNotebook(tid, title, file, [code(`c${++state.seq}`)]);
      return res.status(201).json(row);
    }
    const row = { terminal_id: `t${++state.seq}`, title: body.title || `Terminal ${state.terminals.length + 1}`, agent: body.agent || null };
    state.terminals.push(row);
    return res.status(201).json(row);
  });
  app.get('/api/tasks/1/agent-sessions', (req, res) => res.json(req.query.agent === 'notebook'
    ? [{ id: 'notebooks/release-check.ipynb', title: 'release-check', updated_at: AT_1 }, { id: 'notebooks/disk-cleanup.ipynb', title: 'disk-cleanup', updated_at: AT_2 }] : []));
  app.post('/api/tasks/1/terminal/ack', (req, res) => res.json({ success: true }));
  const nbOf = (req, res) => { const nb = state.notebooks.get(req.params.tid); if (!nb) res.status(404).json({ error: 'NOTEBOOK_NOT_FOUND' }); return nb; };
  app.get('/api/tasks/1/notebooks/:tid', (req, res) => { const nb = nbOf(req, res); if (nb) res.json(doc(nb)); });
  app.get('/api/tasks/1/notebooks/:tid/events', (req, res) => {
    const nb = nbOf(req, res);
    if (!nb) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', notebook: doc(nb) })}\n\n`);
    nb.clients.add(res);
    req.on('close', () => nb.clients.delete(res));
  });
  app.post('/api/tasks/1/notebooks/:tid/ops', (req, res) => {
    const nb = nbOf(req, res);
    if (!nb) return;
    state.opsPosts.push(req.body);
    applyOps(nb, req.body.ops || []);
    send(nb, { type: 'ops', revision: nb.revision, ops: req.body.ops, by: req.body.client });
    res.json({ revision: nb.revision });
  });
  app.post('/api/tasks/1/notebooks/:tid/run', (req, res) => {
    const nb = nbOf(req, res);
    if (!nb) return;
    state.runs.push({ ids: req.body.ids, sources: req.body.ids.map(id => (cellOf(nb, id) || {}).source) });
    for (const id of req.body.ids) {
      const cell = cellOf(nb, id);
      if (!cell || cell.type !== 'code' || nb.kernel.queue.includes(id) || nb.kernel.running === id) continue;
      nb.kernel.queue.push(id);
      patch(nb, id, { state: 'queued' });
    }
    if (nb.kernel.state === 'stopped') { kernel(nb, { state: 'starting' }); setTimeout(() => { kernel(nb, { state: 'idle' }); pump(nb); }, 60); }
    else { send(nb, { type: 'kernel', kernel: nb.kernel }); pump(nb); }
    res.json({ kernel: nb.kernel });
  });
  const stopRunning = (nb, end) => {
    const id = nb.kernel.running;
    const waiter = nb.waiter;
    if (id) finish(nb, id, end === 'stopped' ? 130 : null, end);
    if (waiter) waiter.stop();
  };
  app.post('/api/tasks/1/notebooks/:tid/interrupt', (req, res) => { const nb = nbOf(req, res); if (!nb) return; stopRunning(nb, 'stopped'); res.json({ kernel: nb.kernel }); });
  app.post('/api/tasks/1/notebooks/:tid/restart', (req, res) => {
    const nb = nbOf(req, res);
    if (!nb) return;
    stopRunning(nb, 'interrupted');
    kernel(nb, { state: 'starting', queue: [] });
    setTimeout(() => kernel(nb, { state: 'idle' }), 60);
    res.json({ kernel: nb.kernel });
  });
  app.post('/api/tasks/1/notebooks/:tid/stop', (req, res) => { const nb = nbOf(req, res); if (!nb) return; kernel(nb, { state: 'stopped' }); stopRunning(nb, 'interrupted'); res.json({ kernel: nb.kernel }); });
  app.post('/api/tasks/1/notebooks/:tid/input', (req, res) => {
    const nb = nbOf(req, res);
    if (!nb) return;
    if (!nb.kernel.running) return res.status(409).json({ error: 'NO_RUNNING_CELL' });
    state.inputs.push(req.body.text);
    if (nb.waiter) nb.waiter.input(req.body.text);
    return res.json({ ok: true });
  });
  app.post('/api/tasks/1/notebooks/:tid/clear', (req, res) => {
    const nb = nbOf(req, res);
    if (!nb) return;
    for (const cell of nb.cells) if (cell.type === 'code') { output(nb, cell.id, 0, []); patch(nb, cell.id, { state: 'idle', exit: null, duration_ms: null, started_at: null, ended_at: null }); }
    res.json({ revision: nb.revision });
  });
  app.use((req, res) => res.status(404).json({ error: 'not mocked' }));
  return { app, state, code, makeNotebook, doc, send, applyOps,
    // Deletes a notebook row: its stream ends normally, as the engine does.
    remove(tid) { const nb = state.notebooks.get(tid); state.notebooks.delete(tid); state.terminals = state.terminals.filter(row => row.terminal_id !== tid); for (const res of nb.clients) res.end(); } };
}

// ── The page ──
async function openPage(browser, base, wide) {
  const context = await browser.newContext(wide
    ? { viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...(SHOTS ? { deviceScaleFactor: 2 } : {}) }
    : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true, ...(SHOTS ? { deviceScaleFactor: 3 } : {}) });
  const page = await context.newPage();
  const errors = [];
  const sockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto(`${base}/h5`);
  return { context, page, errors, sockets, wide, press: locator => (wide ? locator.click() : locator.tap()) };
}
// Waits for a condition of the stand-in engine (polled; the page's requests arrive on their own time).
async function until(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
const cellsOf = page => page.locator('#h5-notebook .nb-cell');
const codeCell = (page, n) => page.locator('#h5-notebook .nb-cell[data-type="code"]').nth(n);
async function typeInto(page, cell, text) {
  await cell.locator('textarea.nb-input').click();
  await page.keyboard.type(text);
}
const metaText = cell => cell.locator('.nb-meta-text').textContent();
async function openSheet(t) {
  if (!t.wide && !(await t.page.locator('#h5-tasks').isVisible())) await t.page.locator('#h5-open-tasks').tap();
  await t.page.locator('#h5-tasks .h5-task-item', { hasText: 'SELF-TAGENT' }).waitFor(WAIT);
  if (!t.wide) await settled(t.page);
}
async function openDialog(t) {
  const { page, wide } = t;
  await openSheet(t);
  const row = '#h5-tasks .h5-task-row:has(.h5-task-title:text-is("SELF-TAGENT"))';
  if (wide) await page.locator(`${row} .h5-task-add`).click();
  else {
    await page.locator(`${row} .h5-task-more`).tap();
    await page.locator('#h5-session-menu-actions [role="menuitem"]', { hasText: 'New session' }).tap();
  }
  await page.locator('#h5-new-session #h5-term-menu-actions button').first().waitFor(WAIT);
  await settled(page);
}
const choiceLabels = page => page.locator('#h5-new-session #h5-term-menu-actions button .h5-choice-label').allTextContents();

async function computer(browser, base, engine) {
  const t = await openPage(browser, base, true);
  const { page } = t;
  const label = 'computer';
  // New session: Shell notebook after New Terminal, with its flask and its caption.
  await openDialog(t);
  assert.deepEqual(await choiceLabels(page), CHOICES, `${label}: the kinds, Shell notebook last`);
  const row = page.locator('#h5-new-session #h5-term-menu-actions button').nth(4);
  assert.equal(await row.locator('.h5-choice-mark').getAttribute('data-mark'), 'notebook');
  assert.equal(await row.locator('.h5-choice-mark svg path').getAttribute('stroke-width'), '1.5', `${label}: the self-drawn flask`);
  assert.equal(await row.locator('.h5-choice-note').textContent(), 'Cells of shell commands that share one shell');
  await shot(page, 'computer-1-new-session.png');
  await row.click();
  await page.locator('#h5-new-session #h5-term-menu-actions button', { hasText: 'release-check' }).waitFor(WAIT);
  assert.deepEqual(await choiceLabels(page), ['New notebook', 'release-check', 'disk-cleanup', 'Back'], `${label}: the sub-list`);
  const notes = await page.locator('#h5-new-session #h5-term-menu-actions button .h5-choice-note').allTextContents();
  assert.deepEqual(notes, ['release-check.ipynb · 11-23 14:21', 'disk-cleanup.ipynb · 11-20 09:05'], `${label}: each file with when it changed`);
  await shot(page, 'computer-2-notebooks.png');
  // New notebook: a notebook row, its view, no terminal socket.
  await page.locator('#h5-new-session #h5-term-menu-actions button', { hasText: 'New notebook' }).click();
  await page.locator('#h5-new-session').waitFor({ state: 'detached', ...WAIT });
  assert.deepEqual(engine.state.posts.at(-1), { agent: 'notebook' });
  await page.locator('#h5-notebook .nb-root').waitFor(WAIT);
  await cellsOf(page).first().waitFor(WAIT);
  assert.equal(await page.locator('#h5-notebook').isVisible(), true);
  assert.equal(await page.locator('.h5-header-notebook #h5-session-name').textContent(), 'Notebook 1', `${label}: the header names the notebook`);
  await page.waitForFunction(() => (document.getElementById('h5-notebook-sub') || {}).textContent === 'SELF-TAGENT · notebooks/notebook.ipynb · Saved', null, WAIT);
  assert.equal(await page.locator('#h5-notebook-chip').textContent(), 'Shell stopped');
  assert.equal(await page.locator('.h5-header-notebook svg path[stroke-width="1.5"]').count() >= 1, true, `${label}: the flask in the header`);
  assert.equal(await page.locator('#h5-term-width').count(), 0, `${label}: no Wide terminal for a notebook`);
  assert.equal(t.sockets.filter(url => url.includes('terminalId=nb')).length, 0, `${label}: no terminal socket for the notebook`);
  const tid = engine.state.terminals.at(-1).terminal_id;
  const nb = engine.state.notebooks.get(tid);
  const box = await page.locator('#h5-notebook').boundingBox();
  const header = await page.locator('.h5-header').boundingBox();
  assert.ok(Math.abs(box.y - (header.y + header.height)) <= 1 && box.x >= 376 - 1 && Math.abs(box.y + box.height - 900) <= 1, `${label}: the view lies over the terminal area (${JSON.stringify(box)})`);

  // Typing: the text goes 400 ms after typing stops; Shift+Enter flushes it, runs the cell and makes a new one at the end.
  const first = codeCell(page, 0);
  await typeInto(page, first, 'echo hello');
  await page.waitForFunction(() => document.querySelector('#h5-notebook-sub').textContent.endsWith('Saved'), null, WAIT);
  assert.equal(nb.cells[0].source, 'echo hello', `${label}: the text reached the engine`);
  const before = engine.state.opsPosts.length;
  await first.locator('textarea').press('Shift+Enter');
  await page.locator('#h5-notebook .nb-cell[data-type="code"]').nth(1).waitFor(WAIT);
  assert.deepEqual(engine.state.runs.at(-1), { ids: [nb.cells[0].id], sources: ['echo hello'] });
  await page.waitForFunction(() => document.activeElement && document.activeElement.closest('.nb-cell') === document.querySelectorAll('#h5-notebook .nb-cell')[1], null, WAIT);
  await first.locator('.nb-line', { hasText: 'hello' }).waitFor(WAIT);
  await page.waitForFunction(cell => /^Exit 0 · \d\.\d s · \d\d:\d\d$/.test(cell.querySelector('.nb-meta-text')?.textContent || ''), await first.elementHandle(), WAIT);
  assert.equal(await first.locator('.nb-meta svg').count(), 1, `${label}: a check for exit 0`);
  assert.equal(await first.locator('.nb-count').textContent(), '[1]');
  assert.ok(engine.state.opsPosts.length > before, `${label}: the new cell was sent`);
  await page.waitForFunction(() => document.getElementById('h5-notebook-chip')?.textContent === 'zsh · Idle', null, WAIT);

  // Colours and a progress line that ends as its last state.
  const second = codeCell(page, 1);
  await page.keyboard.type('color');
  await page.keyboard.press('Control+Enter');
  await second.locator('.nb-line').nth(2).waitFor(WAIT);
  const spans = await second.locator('.nb-line').evaluateAll(lines => lines.map(line => [...line.querySelectorAll('span')].map(span => [span.textContent, span.style.color, span.style.fontWeight, span.style.backgroundColor])));
  assert.deepEqual(spans[0][0], ['red', 'rgb(204, 0, 0)', '', '']);
  assert.deepEqual(spans[0][1], ['bold green', 'rgb(78, 154, 6)', '700', '']);
  assert.deepEqual(spans[1][0], ['still green', 'rgb(78, 154, 6)', '700', ''], `${label}: the style carries over to the next line`);
  assert.deepEqual(spans[2][0], ['orange', 'rgb(255, 135, 0)', '', '']);
  assert.equal(spans[2][1][3], 'rgb(224, 224, 224)', `${label}: inverse`);
  assert.equal(await second.locator('textarea').evaluate(node => node === document.activeElement), true, `${label}: Ctrl+Enter runs in place`);
  // The highlighted copy matches the editor.
  assert.equal(await second.locator('.nb-hl').evaluate(node => node.textContent), 'color\n');

  // Queued cells, the input field, the kernel chip and the task list's line.
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('read');
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo after');
  await page.waitForFunction(() => document.querySelector('#h5-notebook-sub').textContent.endsWith('Saved'), null, WAIT);
  assert.equal(await cellsOf(page).count(), 4);
  const reader = codeCell(page, 2);
  const after = codeCell(page, 3);
  await reader.click({ position: { x: 4, y: 4 } });
  await reader.locator('textarea').click();
  const runAll = engine.state.runs.length;
  await page.keyboard.press('Control+Shift+Enter');
  await until(() => engine.state.runs.length === runAll + 1, `${label}: Ctrl+Shift+Enter runs all`);
  assert.equal(engine.state.runs.at(-1).ids.length, 4);
  await reader.locator('.nb-stdin input.nb-stdin-input').waitFor(WAIT);
  await page.waitForFunction(() => document.getElementById('h5-notebook-chip')?.textContent === 'zsh · Waiting for input', null, WAIT);
  assert.equal(await reader.locator('.nb-stdin-caption').textContent(), 'The command asks for input');
  assert.equal(await reader.locator('.nb-count').textContent(), '[*]');
  assert.equal(await after.locator('.nb-count').textContent(), '[ ]');
  assert.equal(await metaText(after), 'Queued · runs after cell 3', `${label}: a queued cell says what it waits for`);
  assert.match(await metaText(reader), /^Running · 0:0\d · Ctrl\+C stops it$/);
  await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Notebook 1' }).locator('.h5-terminal-sub', { hasText: 'Notebook · Running cell 3' }).waitFor(WAIT);
  await shot(page, 'computer-3-running.png');
  await reader.locator('.nb-stdin-hide input').check();
  assert.equal(await reader.locator('.nb-stdin-input').getAttribute('type'), 'password', `${label}: Hide what I type`);
  await reader.locator('.nb-stdin-input').fill('y');
  await reader.locator('.nb-stdin-input').press('Enter');
  await reader.locator('.nb-line', { hasText: 'got y' }).waitFor(WAIT);
  assert.deepEqual(engine.state.inputs, ['y']);
  await after.locator('.nb-line', { hasText: 'after' }).waitFor(WAIT);
  await reader.locator('.nb-stdin').waitFor({ state: 'detached', ...WAIT });
  await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Notebook 1' }).locator('.h5-terminal-sub', { hasText: 'Notebook · Idle' }).waitFor(WAIT);

  // Stop: a waiting cell is stopped (Ctrl+C), the queued one goes back to idle.
  await setSources(page, engine, nb, ['wait', 'echo never']);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Run all' }).click();
  await page.waitForFunction(() => document.getElementById('h5-notebook-chip')?.textContent === 'zsh · Running cell 1', null, WAIT);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Stop' }).click();
  await page.waitForFunction(cell => /^Stopped \(Ctrl\+C\) · \d\.\d s · the shell keeps its state$/.test(cell.querySelector('.nb-meta-text')?.textContent || ''), await codeCell(page, 0).elementHandle(), WAIT);
  assert.equal(await codeCell(page, 0).locator('.nb-meta').getAttribute('data-tone'), 'stopped');
  assert.equal(await codeCell(page, 1).getAttribute('data-state'), 'idle', `${label}: the queue was cleared`);

  // Run all stops at a failed cell.
  await setSources(page, engine, nb, ['echo a', 'fail', 'echo c']);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Run all' }).click();
  await page.waitForFunction(cell => /Run all stopped here$/.test(cell.querySelector('.nb-meta-text')?.textContent || ''), await codeCell(page, 1).elementHandle(), WAIT);
  assert.match(await metaText(codeCell(page, 1)), /^Exit 1 · /);
  assert.equal(await codeCell(page, 1).locator('.nb-meta').evaluate(node => getComputedStyle(node).color), 'rgb(229, 115, 115)', `${label}: the exit in the error colour`);
  assert.equal(await codeCell(page, 2).getAttribute('data-state'), 'idle', `${label}: the cell after it did not run`);
  await shot(page, 'computer-4-failed.png');

  // The restart dialog: Cancel keeps the shell, Restart ends the running cell.
  await setSources(page, engine, nb, ['wait']);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Run all' }).click();
  await page.waitForFunction(() => document.getElementById('h5-notebook-chip')?.textContent === 'zsh · Running cell 1', null, WAIT);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Restart shell' }).click();
  await page.locator('#nb-restart').waitFor(WAIT);
  assert.equal(await page.locator('#nb-restart-title').textContent(), 'Restart the shell?');
  assert.equal(await page.locator('#nb-restart-text').textContent(), 'Variables, the working directory and the running cell 1 are lost. The outputs stay in the notebook.');
  assert.deepEqual(await page.locator('#nb-restart button').allTextContents(), ['Cancel', 'Restart'], `${label}: the dismissive action first`);
  assert.equal(await page.locator('#nb-restart button.nb-danger').evaluate(node => getComputedStyle(node).color), 'rgb(244, 67, 54)');
  await shot(page, 'computer-5-restart.png');
  await page.keyboard.press('Escape');
  await page.locator('#nb-restart').waitFor({ state: 'detached', ...WAIT });
  assert.equal(nb.kernel.state, 'busy', `${label}: Escape keeps the shell`);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Restart shell' }).click();
  await page.locator('#nb-restart button', { hasText: 'Restart' }).click();
  await page.waitForFunction(cell => cell.querySelector('.nb-meta-text')?.textContent === 'Not finished: the shell was restarted', await codeCell(page, 0).elementHandle(), WAIT);

  // A long output: the last 200 lines, Show all, Download.
  await setSources(page, engine, nb, ['stream 1500']);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Run all' }).click();
  const long = codeCell(page, 0);
  await page.waitForFunction(cell => (cell.querySelector('.nb-out-count')?.textContent || '') === 'Last 200 of 1,500 lines', await long.elementHandle(), WAIT);
  await page.waitForFunction(cell => cell.querySelector('.nb-meta-text')?.textContent?.startsWith('Exit 0'), await long.elementHandle(), WAIT);
  assert.equal(await long.locator('.nb-line').count(), 200);
  assert.equal(await long.locator('.nb-line').first().textContent(), 'line 1301');
  assert.equal(await long.locator('.nb-line').last().textContent(), 'line 1500');
  await long.locator('.nb-show-all').click();
  await page.waitForFunction(cell => cell.querySelectorAll('.nb-line').length === 1500, await long.elementHandle(), WAIT);
  assert.equal(await long.locator('.nb-show-all').textContent(), 'Show less');
  const download = page.waitForEvent('download');
  await long.locator('.nb-download').click();
  const file = await download;
  assert.equal(file.suggestedFilename(), 'notebook-cell-1.txt');
  const text = fs.readFileSync(await file.path(), 'utf8');
  assert.equal(text.split('\n').length, 1501);
  await long.locator('.nb-show-all').click();
  await page.waitForFunction(cell => cell.querySelectorAll('.nb-line').length === 200, await long.elementHandle(), WAIT);

  // A full-screen program: stopped, with a way to a terminal of the task.
  await setSources(page, engine, nb, ['htop']);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Run all' }).click();
  const full = codeCell(page, 0).locator('.nb-full');
  await full.waitFor(WAIT);
  assert.equal(await full.locator('.nb-full-text').textContent(), 'htop draws a full screen, which a cell cannot show. It was stopped.');
  await shot(page, 'computer-6-fullscreen.png');

  // Ops from another device appear: a text cell (Markdown) and a changed command.
  const remoteId = 'feedbeef';
  await postOps(engine, nb, 'phone', [{ op: 'insert', index: 0, cell: { id: remoteId, type: 'markdown', source: '# Release check\nRun **before** each release.' } }, { op: 'set', id: nb.cells[0].id, source: 'htop -d 5' }]);
  await page.locator(`#h5-notebook .nb-cell[data-id="${remoteId}"] .nb-md h1`, { hasText: 'Release check' }).waitFor(WAIT);
  assert.equal(await page.locator(`#h5-notebook .nb-cell[data-id="${remoteId}"] .nb-md strong`).textContent(), 'before');
  await page.waitForFunction(() => document.querySelectorAll('#h5-notebook .nb-cell[data-type="code"] textarea')[0].value === 'htop -d 5', null, WAIT);
  // Raw HTML in a text cell is shown as text.
  await postOps(engine, nb, 'phone', [{ op: 'set', id: remoteId, source: '<img src=x onerror="window.pwned=1">' }]);
  await page.waitForFunction(id => (document.querySelector(`#h5-notebook .nb-cell[data-id="${id}"] .nb-md`)?.textContent || '').includes('<img'), remoteId, WAIT);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator(`#h5-notebook .nb-cell[data-id="${remoteId}"] .nb-md img`).count(), 0);

  // The header's menu: the notebook's actions; Download .ipynb.
  await page.locator('#h5-header-more').click();
  await page.locator('#h5-header-more-menu .h5-notebook-action').first().waitFor(WAIT);
  assert.deepEqual(await page.locator('#h5-header-more-menu .h5-notebook-action').allTextContents(), ['Rename', 'Download .ipynb', 'Clear outputs', 'Stop shell', 'Restart shell']);
  assert.equal(await page.locator('#h5-header-more').getAttribute('aria-label'), 'Notebook menu');
  await shot(page, 'computer-7-menu.png');
  const ipynb = page.waitForEvent('download');
  await page.locator('#h5-header-more-menu .h5-notebook-action', { hasText: 'Download .ipynb' }).click();
  const saved = await ipynb;
  assert.equal(saved.suggestedFilename(), 'notebook.ipynb');
  const json = JSON.parse(fs.readFileSync(await saved.path(), 'utf8'));
  assert.equal(json.nbformat, 4);
  assert.equal(json.cells[0].cell_type, 'markdown');
  // Clear outputs from the menu.
  await page.locator('#h5-header-more').click();
  await page.locator('#h5-header-more-menu .h5-notebook-action', { hasText: 'Clear outputs' }).click();
  await page.waitForFunction(() => !document.querySelector('#h5-notebook .nb-full:not([hidden])'), null, WAIT);

  // Keys in command mode: M makes text, Y code again, D D deletes.
  const count = await cellsOf(page).count();
  await codeCell(page, 0).locator('textarea').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await page.waitForFunction(n => document.querySelectorAll('#h5-notebook .nb-cell').length === n + 1, count, WAIT);
  await page.keyboard.press('m');
  await page.waitForFunction(() => document.activeElement?.dataset?.type === 'markdown', null, WAIT);
  await page.keyboard.press('y');
  await page.waitForFunction(() => document.activeElement?.dataset?.type === 'code', null, WAIT);
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.waitForFunction(n => document.querySelectorAll('#h5-notebook .nb-cell').length === n, count, WAIT);
  await page.waitForFunction(() => document.querySelector('#h5-notebook-sub').textContent.endsWith('Saved'), null, WAIT);
  assert.equal(nb.cells.length, count, `${label}: the engine has the same cells`);

  await folding(t, engine, nb);

  // A plain terminal of the task: the notebook view goes away.
  await page.locator('#h5-header-more').waitFor();
  await full.waitFor({ state: 'detached' }).catch(() => {});
  await setSources(page, engine, nb, ['vim']);
  await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Run all' }).click();
  await page.locator('#h5-notebook .nb-full button', { hasText: 'Open in a terminal' }).click();
  await page.locator('#h5-notebook').waitFor({ state: 'hidden', ...WAIT });
  assert.deepEqual(engine.state.posts.at(-1), {}, `${label}: Open in a terminal makes a New Terminal in the task`);
  assert.equal(await page.locator('.h5-header-notebook').count(), 0, `${label}: the header is a terminal's again`);

  // Back to the notebook, then its row is deleted elsewhere: the view closes.
  await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Notebook 1' }).locator('.h5-terminal-main').click();
  await page.locator('#h5-notebook .nb-cell').first().waitFor(WAIT);
  engine.remove(tid);
  await page.locator('#h5-notebook').waitFor({ state: 'hidden', ...WAIT });
  assert.equal(await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Notebook 1' }).count(), 0);
  assert.deepEqual(t.errors, [], `${label}: no page errors`);
  await t.context.close();
}

// The cells of a notebook set by this test as another device would (through the engine), then the page waits until it shows them.
async function setSources(page, engine, nb, sources) {
  const ops = nb.cells.map(cell => ({ op: 'delete', id: cell.id }));
  sources.forEach((source, index) => ops.push({ op: 'insert', index, cell: { id: `x${++engine.state.seq}`, type: 'code', source } }));
  await postOps(engine, nb, 'test', ops);
  await page.waitForFunction(list => {
    const values = [...document.querySelectorAll('#h5-notebook .nb-cell textarea.nb-input')].map(node => node.value);
    return JSON.stringify(values) === JSON.stringify(list);
  }, sources, WAIT);
}
// Long cells fold by themselves ("Long cells fold" in docs/design/shell-notebook-page.md): more than 12 screen lines show the first 8 with a fade and
// "Show all N lines"; Show all / Show less, Z in command mode, a click into the folded code, Enter in command mode and the cursor arriving from the
// cell above open it; a short cell never folds; Run keeps it folded and runs every line; an op from another device folds a cell unless its editor
// has the focus; a text cell folds when rendered.
async function folding(t, engine, nb) {
  const { page, wide } = t;
  const label = wide ? 'computer fold' : 'phone fold';
  const long = Array.from({ length: 42 }, (_, i) => `echo line ${i + 1}`).join('\n');
  await setSources(page, engine, nb, ['echo above', long, 'echo short']);
  const cell = codeCell(page, 1);
  const btn = cell.locator('.nb-fold');
  const folded = node => node.evaluate(one => one.hasAttribute('data-folded'));
  const shownLines = node => node.evaluate(one => {
    const hl = one.querySelector('.nb-hl');
    const lh = parseFloat(getComputedStyle(hl).lineHeight);
    return Math.round((one.querySelector('.nb-code').clientHeight - 16) / lh);
  });
  await page.waitForFunction(node => node.hasAttribute('data-folded'), await cell.elementHandle(), WAIT);
  assert.equal(await btn.textContent(), 'Show all 42 lines', `${label}: the button names the lines`);
  assert.equal(await btn.getAttribute('aria-expanded'), 'false');
  assert.equal(await shownLines(cell), 8, `${label}: the first 8 lines show`);
  assert.notEqual(await cell.locator('.nb-code').evaluate(node => getComputedStyle(node, '::after').content), 'none', `${label}: the end fades`);
  assert.equal(await cell.locator('textarea').inputValue(), long, `${label}: the editor keeps every line`);
  const height = (await btn.boundingBox()).height;
  assert.ok(wide ? Math.abs(height - 32) <= 1 : height >= 44, `${label}: the button is ${wide ? 32 : 44}px high (${height})`);
  // A short cell never folds.
  assert.equal(await folded(codeCell(page, 0)), false);
  assert.equal(await codeCell(page, 2).locator('.nb-fold').isVisible(), false, `${label}: no button on a short cell`);
  await shot(page, `${wide ? 'computer' : 'phone'}-8-folded.png`);

  // Show all / Show less (the button is a Tab stop: Enter presses it).
  if (wide) { await btn.focus(); await page.keyboard.press('Enter'); } else await btn.tap();
  await page.waitForFunction(node => !node.hasAttribute('data-folded'), await cell.elementHandle(), WAIT);
  assert.equal(await btn.textContent(), 'Show less');
  assert.equal(await btn.getAttribute('aria-expanded'), 'true');
  assert.equal(await shownLines(cell), 42, `${label}: every line when open`);
  await shot(page, `${wide ? 'computer' : 'phone'}-9-opened.png`);
  await t.press(btn);
  await page.waitForFunction(node => node.hasAttribute('data-folded'), await cell.elementHandle(), WAIT);
  assert.equal(await btn.textContent(), 'Show all 42 lines');

  // Z in command mode opens and folds the selected long cell; on a short cell it does nothing.
  await cell.focus();
  await page.keyboard.press('z');
  assert.equal(await folded(cell), false, `${label}: Z opens`);
  await page.keyboard.press('z');
  assert.equal(await folded(cell), true, `${label}: Z folds`);
  await codeCell(page, 2).focus();
  await page.keyboard.press('z');
  assert.equal(await folded(codeCell(page, 2)), false);
  assert.equal(await codeCell(page, 2).locator('.nb-fold').isVisible(), false);

  // Run of a folded cell: it stays folded and every line runs.
  await cell.focus();
  const runs = engine.state.runs.length;
  await t.press(cell.locator('.nb-run'));
  await until(() => engine.state.runs.length === runs + 1, `${label}: the folded cell runs`);
  assert.deepEqual(engine.state.runs.at(-1).sources, [long], `${label}: every line of the folded cell runs`);
  await page.waitForFunction(node => node.querySelectorAll('.nb-line').length === 42, await cell.elementHandle(), WAIT);
  assert.equal(await folded(cell), true, `${label}: still folded after the run`);
  assert.equal(await cell.locator('.nb-line').last().textContent(), 'line 42');

  // A click or tap into the folded code opens it to edit; leaving the editor does not fold it again.
  await t.press(cell.locator('textarea'));
  await page.waitForFunction(node => !node.hasAttribute('data-folded') && document.activeElement === node.querySelector('textarea'), await cell.elementHandle(), WAIT);
  assert.equal(await btn.textContent(), 'Show less');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('nb-cell')), true, `${label}: command mode`);
  assert.equal(await folded(cell), false, `${label}: an opened cell stays open`);
  // Enter on a folded cell in command mode opens it to edit.
  await page.keyboard.press('z');
  assert.equal(await folded(cell), true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(node => !node.hasAttribute('data-folded') && document.activeElement === node.querySelector('textarea'), await cell.elementHandle(), WAIT);
  await page.keyboard.press('Escape');
  await page.keyboard.press('z');
  assert.equal(await folded(cell), true);
  // The cursor arriving from the cell above (Shift+Enter there) opens it.
  await t.press(codeCell(page, 0).locator('textarea'));
  await page.keyboard.press('Shift+Enter');
  await page.waitForFunction(node => !node.hasAttribute('data-folded') && document.activeElement === node.querySelector('textarea'), await cell.elementHandle(), WAIT);
  await page.keyboard.press('Escape');

  // An op from another device that makes a cell long folds it, unless its editor has the focus.
  const short = codeCell(page, 2);
  const shortId = await short.getAttribute('data-id');
  const thirty = Array.from({ length: 30 }, (_, i) => `echo remote ${i + 1}`).join('\n');
  await postOps(engine, nb, 'phone', [{ op: 'set', id: shortId, source: thirty }]);
  await page.waitForFunction(node => node.hasAttribute('data-folded'), await short.elementHandle(), WAIT);
  assert.equal(await short.locator('.nb-fold').textContent(), 'Show all 30 lines');
  await postOps(engine, nb, 'phone', [{ op: 'set', id: shortId, source: 'echo short' }]);
  await page.waitForFunction(node => !node.hasAttribute('data-folded') && node.querySelector('.nb-fold').hidden, await short.elementHandle(), WAIT);
  await t.press(short.locator('textarea'));
  await postOps(engine, nb, 'phone', [{ op: 'set', id: shortId, source: thirty }]);
  await page.waitForFunction(text => document.activeElement?.value === text, thirty, WAIT);
  await page.waitForFunction(node => !node.querySelector('.nb-fold').hidden, await short.elementHandle(), WAIT);
  assert.equal(await folded(short), false, `${label}: a focused cell is never folded`);
  assert.equal(await short.locator('.nb-fold').textContent(), 'Show less');
  await page.keyboard.press('Escape');
  assert.equal(await folded(short), false, `${label}: leaving its editor does not fold it`);

  // A text cell folds when rendered; a click into the folded text opens it.
  const textId = 'fold0text';
  await postOps(engine, nb, 'phone', [{ op: 'insert', index: 3, cell: { id: textId, type: 'markdown', source: Array.from({ length: 30 }, (_, i) => `- item ${i + 1}`).join('\n') } }]);
  const text = page.locator(`#h5-notebook .nb-cell[data-id="${textId}"]`);
  await text.locator('.nb-md li').nth(29).waitFor({ state: 'attached', ...WAIT });
  await page.waitForFunction(node => node.hasAttribute('data-folded'), await text.elementHandle(), WAIT);
  assert.equal(await text.locator('.nb-fold').textContent(), 'Show all 30 lines');
  await t.press(text.locator('.nb-md li').first());
  await page.waitForFunction(node => !node.hasAttribute('data-folded'), await text.elementHandle(), WAIT);
  assert.equal(await text.locator('.nb-fold').textContent(), 'Show less');
  await t.press(text.locator('.nb-fold'));
  await page.waitForFunction(node => node.hasAttribute('data-folded'), await text.elementHandle(), WAIT);
  await postOps(engine, nb, 'test', [{ op: 'delete', id: textId }]);
  await text.waitFor({ state: 'detached', ...WAIT });
}

async function postOps(engine, nb, client, ops) {
  engine.applyOps(nb, ops);
  engine.send(nb, { type: 'ops', revision: nb.revision, ops, by: client });
}

async function phone(browser, base, engine) {
  // A notebook that is already there, opened from the task list.
  const tid = `nb${++engine.state.seq}`;
  engine.state.terminals.unshift({ terminal_id: tid, title: 'Release check', agent: 'notebook', notebook: 'notebooks/release-check.ipynb' });
  const nb = engine.makeNotebook(tid, 'Release check', 'notebooks/release-check.ipynb', [engine.code('p1', 'echo 2.155.0'), engine.code('p2', 'read')]);
  const t = await openPage(browser, base, false);
  const { page } = t;
  const label = 'phone';
  await openSheet(t);
  const listShown = await page.locator('#h5-tasks .h5-terminal-list').first().isVisible().catch(() => false);
  if (!listShown) await page.locator('#h5-tasks .h5-task-item', { hasText: 'SELF-TAGENT' }).tap();
  await page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Release check' }).locator('.h5-terminal-main').tap();
  await page.locator('#h5-notebook .nb-cell').nth(1).waitFor(WAIT);
  await page.locator('#h5-tasks').waitFor({ state: 'hidden', ...WAIT });
  await settled(page);
  assert.equal(await page.locator('.h5-header-notebook #h5-session-name').textContent(), 'Release check');
  assert.equal(await page.locator('#h5-notebook-kernel').textContent(), 'Shell stopped');
  // The action bar sits right above the bottom navigation; the view ends there.
  const bar = await page.locator('#h5-notebook .nb-actionbar').boundingBox();
  const nav = await page.locator('#h5-bnav').boundingBox();
  assert.ok(nav, `${label}: the bottom navigation is shown`);
  assert.ok(Math.abs(bar.y + bar.height - nav.y) <= 1, `${label}: the action bar ends at the bottom navigation (${bar.y + bar.height} / ${nav.y})`);
  assert.deepEqual(await page.locator('#h5-notebook .nb-actionbar button').allTextContents(), ['Run', 'Run all', 'Stop', '+ Cell']);
  assert.equal(await page.locator('#h5-notebook .nb-toolbar').isVisible(), false, `${label}: no wide toolbar`);
  // The run button of each cell: 44px, at the top right.
  const cell = await page.locator('#h5-notebook .nb-cell').nth(1).boundingBox();
  const run = await page.locator('#h5-notebook .nb-cell').nth(1).locator('.nb-run').boundingBox();
  assert.ok(run.width >= 44 && run.height >= 44, `${label}: 44px run button`);
  assert.ok(Math.abs(run.x + run.width - (cell.x + cell.width)) <= 1 && run.y - cell.y <= 1, `${label}: at the top right of the cell`);
  // Run all from the action bar; the second cell asks for input.
  await page.locator('#h5-notebook .nb-actionbar button', { hasText: 'Run all' }).tap();
  const reader = page.locator('#h5-notebook .nb-cell').nth(1);
  await reader.locator('.nb-stdin-input').waitFor(WAIT);
  await page.waitForFunction(() => document.getElementById('h5-notebook-kernel')?.textContent === 'zsh · Waiting for input', null, WAIT);
  await settled(page);
  await shot(page, 'phone-1-input.png');
  // Every target of the view is at least 44 x 44 px.
  const small = await page.evaluate(() => [...document.querySelectorAll('#h5-notebook button, #h5-notebook input, #h5-notebook .nb-stdin-hide')].filter(node => {
    const r = node.getBoundingClientRect();
    if (!r.width || node.closest('[hidden]') || getComputedStyle(node).display === 'none' || node.type === 'checkbox') return false;
    return r.height < 44 || (node.tagName === 'BUTTON' && r.width < 44);
  }).map(node => `${node.className}:${node.textContent}:${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`));
  assert.deepEqual(small, [], `${label}: 44px targets`);
  await reader.locator('.nb-stdin-input').tap();
  await page.keyboard.type('n');
  await reader.locator('.nb-send').tap();
  await reader.locator('.nb-line', { hasText: 'got n' }).waitFor(WAIT);
  assert.deepEqual(engine.state.inputs.at(-1), 'n');
  // + Cell makes a code cell below the selected one and edits it.
  await page.locator('#h5-notebook .nb-actionbar button', { hasText: '+ Cell' }).tap();
  await page.waitForFunction(() => document.querySelectorAll('#h5-notebook .nb-cell').length === 3, null, WAIT);
  await page.waitForFunction(() => document.activeElement?.classList.contains('nb-input'), null, WAIT);
  assert.equal(await page.locator('#h5-notebook .nb-cell textarea').nth(2).evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 16, `${label}: 16px in the editor (no zoom on iOS)`);
  await page.keyboard.type('echo phone');
  await until(() => nb.cells[2] && nb.cells[2].source === 'echo phone', `${label}: the new cell's text reached the engine`);
  await shot(page, 'phone-2-cells.png');
  await folding(t, engine, nb);

  // The header's menu on the phone keeps Update.
  await page.locator('#h5-header-more').tap();
  await page.locator('#h5-header-more-menu .h5-notebook-action').first().waitFor(WAIT);
  assert.equal(await page.locator('#h5-header-update').count(), 1);
  await page.keyboard.press('Escape');
  assert.deepEqual(t.errors, [], `${label}: no page errors`);
  await t.context.close();
}

(async () => {
  const engine = createEngine();
  const server = engine.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    await computer(browser, base, engine);
    console.log('ok computer: New session, run, queue, input, stop, run all, restart, long output, full screen, remote ops, menu, keys, folding long cells, delete');
    await phone(browser, base, engine);
    console.log('ok phone: open from the list, action bar above the bottom navigation, 44px targets, input, + Cell, folding long cells');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

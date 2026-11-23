#!/usr/bin/env node
// Shell notebook end to end: the real server (its own data folder and port) and the real page, headless. A notebook is made from the New session
// dialog, its cells run in one shell (state carries over), a failed cell, Stop, input to a running cell, a second page that sees the same live
// output, and the .ipynb on disk. See docs/design/shell-notebook.md and docs/design/shell-notebook-page.md.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const WAIT = { timeout: 20000 };
const LIMIT_MS = 180000;

async function startServer(temp) {
  const data = path.join(temp, 'server-data');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', ACCESS_MODE: 'local', SESSION_SECRET: 'notebook-e2e-test-secret-'.repeat(3),
      T_AGENT_DATA_DIR: data, TAGENT_HOME: data, T_AGENT_DB_PATH: path.join(data, 'db.sqlite'), TASKS_BASE_DIR: path.join(temp, 'tasks'),
      SINGLE_USER_ID: 'local', UPDATE_CHECK_ENABLED: 'false', HOME: path.join(temp, 'home'), ZDOTDIR: path.join(temp, 'home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 20000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`server exited: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  return { base: `http://127.0.0.1:${port}`, child, log: () => output };
}

async function openPage(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/h5`);
  return { context, page, errors };
}

const codeCell = (page, n) => page.locator('#h5-notebook .nb-cell[data-type="code"]').nth(n);
const outputOf = cell => cell.locator('.nb-line').allTextContents().then(lines => lines.join('\n'));
async function waitOutput(cell, pattern, message) {
  const end = Date.now() + WAIT.timeout;
  for (;;) {
    const text = await outputOf(cell);
    if (pattern.test(text)) return text;
    if (Date.now() > end) throw new Error(`${message}: output was ${JSON.stringify(text)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function waitMeta(cell, pattern, message) {
  const end = Date.now() + WAIT.timeout;
  for (;;) {
    const text = (await cell.locator('.nb-meta-text').allTextContents()).join(' ');
    if (pattern.test(text)) return text;
    if (Date.now() > end) throw new Error(`${message}: meta was ${JSON.stringify(text)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function runInCell(page, n, text) {
  const cell = codeCell(page, n);
  await cell.waitFor(WAIT);
  await cell.locator('textarea.nb-input').click();
  await page.keyboard.type(text);
  await cell.locator('textarea.nb-input').press('Shift+Enter');
  return cell;
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-notebook-e2e-'));
  fs.mkdirSync(path.join(temp, 'home'), { recursive: true });
  // A noisy shell start file with a fancy prompt: none of it may reach a cell's output.
  fs.writeFileSync(path.join(temp, 'home', '.zshrc'), "echo 'zshrc says hello'\nPROMPT='%F{red}fancy>%f '\nRPROMPT='[right]'\n");
  fs.writeFileSync(path.join(temp, 'home', '.bashrc'), "echo 'bashrc says hello'\nPS1='fancy> '\n");
  const folder = path.join(temp, 'work');
  fs.mkdirSync(folder, { recursive: true });
  const server = await startServer(temp);
  const browser = await chromium.launch({ headless: true });
  try {
    const one = await openPage(browser, server.base);
    const { page } = one;
    const task = await page.evaluate(async work => {
      const res = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ title: 'NB-E2E', work_dir: work }) });
      return { status: res.status, body: await res.json() };
    }, folder);
    assert.ok(task.status === 200 || task.status === 201, `the task was made: ${JSON.stringify(task)}`);
    await page.reload();

    // New session -> Shell notebook -> New notebook.
    const row = '#h5-tasks .h5-task-row:has(.h5-task-title:text-is("NB-E2E"))';
    await page.locator(row).waitFor(WAIT);
    await page.locator(`${row} .h5-task-add`).click();
    await page.locator('#h5-new-session #h5-term-menu-actions button', { hasText: 'Shell notebook' }).click();
    await page.locator('#h5-new-session #h5-term-menu-actions button', { hasText: 'New notebook' }).click();
    await page.locator('#h5-new-session').waitFor({ state: 'detached', ...WAIT });
    await page.locator('#h5-notebook .nb-root').waitFor(WAIT);

    // State carries over between cells; the start file's noise and prompt stay out.
    const c1 = await runInCell(page, 0, 'export GREETING=hello-from-cell-1; cd /; mkdir -p "$OLDPWD/sub"; cd "$OLDPWD/sub"');
    await waitMeta(c1, /Exit 0/, 'cell 1 ends with exit 0');
    const c2 = await runInCell(page, 1, 'echo "$GREETING"; basename "$PWD"; printf "\\033[31mred\\033[0m\\n"');
    const out2 = await waitOutput(c2, /hello-from-cell-1\nsub\nred/, 'cell 2 sees the variable and the directory of cell 1');
    assert.ok(!/says hello|fancy|\[right\]/.test(out2), `no start file noise or prompt in the output: ${out2}`);
    assert.equal(await c2.locator('.nb-line span[style*="color"], .nb-line [class*="sgr"], .nb-line span').count() > 0, true, 'the red text is coloured');

    // A failed cell.
    const c3 = await runInCell(page, 2, 'echo failing >&2; false');
    await waitMeta(c3, /Exit 1/, 'cell 3 fails with exit 1');

    // A second page on the same notebook sees the same cells and the live output.
    const two = await openPage(browser, server.base);
    await two.page.locator(row).waitFor(WAIT);
    const listed = two.page.locator('#h5-tasks .h5-terminal-row', { hasText: 'Notebook' }).first();
    if (!(await listed.isVisible())) await two.page.locator(`${row} .h5-task-title`).click();
    await listed.click(WAIT);
    await two.page.locator('#h5-notebook .nb-root').waitFor(WAIT);
    await waitOutput(codeCell(two.page, 1), /hello-from-cell-1/, 'the second page shows the outputs');

    // Input to a running cell.
    const c4 = await runInCell(page, 3, 'printf "Name? "; read -r who; echo "hi $who"');
    await c4.locator('.nb-stdin-input').waitFor(WAIT);
    await c4.locator('.nb-stdin-input').fill('bob');
    await c4.locator('.nb-stdin-input').press('Enter');
    await waitOutput(c4, /hi bob/, 'the input reached the running cell');
    await waitOutput(codeCell(two.page, 3), /hi bob/, 'the second page saw the live output');

    // Stop a long cell: it ends as stopped, and the shell keeps its state.
    const c5 = await runInCell(page, 4, 'echo started; sleep 30');
    await waitOutput(c5, /started/, 'the long cell started');
    await page.locator('#h5-notebook .nb-toolbar button', { hasText: 'Stop' }).click();
    await waitMeta(c5, /Stopped/, 'Stop ends the cell');
    const c6 = await runInCell(page, 5, 'echo "still $GREETING"');
    await waitOutput(c6, /still hello-from-cell-1/, 'the shell kept its state after Stop');

    // The file on disk: nbformat 4 with the outputs.
    const file = path.join(folder, 'notebooks', 'notebook.ipynb');
    const end = Date.now() + 10000;
    let doc = null;
    for (;;) {
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { doc = null; }
      const text = doc ? JSON.stringify(doc.cells) : '';
      if (text.includes('still hello-from-cell-1')) break;
      if (Date.now() > end) throw new Error(`the .ipynb did not get the outputs: ${text.slice(0, 2000)}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(doc.nbformat, 4);
    assert.equal(doc.metadata.kernelspec.name, 'bash');
    assert.ok(doc.cells[1].outputs[0].text.join('').includes('hello-from-cell-1'));

    // A reload shows the same notebook with its outputs.
    await page.reload();
    await page.locator('#h5-notebook .nb-root').waitFor(WAIT);
    await waitOutput(codeCell(page, 1), /hello-from-cell-1/, 'the outputs are there after a reload');

    assert.deepEqual(one.errors, [], 'no page errors (first page)');
    assert.deepEqual(two.errors, [], 'no page errors (second page)');
    console.log('notebook e2e: all checks passed');
  } finally {
    await browser.close();
    server.child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const limit = setTimeout(() => { console.error(`notebook e2e: over ${LIMIT_MS / 1000} s`); process.exit(1); }, LIMIT_MS);
main().then(() => { clearTimeout(limit); }, error => { console.error(error); process.exit(1); });

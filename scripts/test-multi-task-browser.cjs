// Browser test of the multi-task page: the tab below "Environment", picking a task / agent / session, at most four chats that exactly fill the page.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://app.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://app.test/');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8') });
    await page.evaluate(() => {
      const quiet = { setActive() {}, setEngine() {} };
      window.Apps = window.AgentConfig = window.Frp = window.FileSyncUI = window.EnvironmentCheck = quiet;
      window.errors = [];
      window.Toast = { error: message => errors.push(message) };
      window.created = [];
      window.API = {
        get: async url => {
          if (/\/conversations$/.test(url)) return [{ id: 7, agent: 'claude', title: 'Old chat', running: false }];
          if (/\/sessions\?/.test(url)) return [];
          throw new Error(`unexpected ${url}`);
        },
        post: async (url, body) => { const row = { id: 100 + created.length, agent: body.agent, title: `Chat ${created.length + 1}` }; created.push(url); return row; },
        patch: async () => ({}), delete: async () => ({}),
      };
      window.Tasks = {
        getActiveKey: () => 'local', problemOf: () => null, onSourceChange() {},
        getSource: () => ({ key: 'local', local: true, label: 'Default', tasksBase: '/api/tasks', tasks: [{ id: 1, title: 'Alpha' }, { id: 2, title: 'Beta' }] }),
      };
      window.AgentChat = {
        AGENTS: { claude: { label: 'Claude' }, codex: { label: 'Codex' } },
        icon: () => document.createTextNode('*'),
        choices: async (api, base, agent) => (await api.get(`${base}/conversations`)).filter(row => row.agent === agent).map(row => ({ title: row.title, running: row.running, conversation: row })),
        open: async (api, base, agent, choice) => (choice && choice.conversation) || api.post(`${base}/conversations`, { agent }),
        mount: (container, options) => { container.innerHTML = '<div class="agent-chat">chat</div>'; return { focus() {}, destroy() { container.innerHTML = ''; } }; },
      };
    });
    for (const file of ['multi-task.js', 'tools.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });

    assert.equal(await page.locator('.main-nav-item').last().getAttribute('id'), 'tab-multi-task', 'the tab is below Environment');
    await page.click('#tab-multi-task');
    assert.equal(await page.locator('#multi-task-panel').isVisible(), true);
    assert.equal(await page.locator('#mt-empty-add').isVisible(), true, 'an empty page offers to add a session');

    // Pick a task, an agent and an existing session.
    await page.click('#mt-add');
    assert.deepEqual(await page.locator('.mt-picker-select option').allTextContents(), ['Alpha', 'Beta']);
    await page.selectOption('.mt-picker-select', '2');
    await page.waitForSelector('.mt-picker-item');
    assert.deepEqual(await page.locator('.mt-picker-item-title').allTextContents(), ['New Claude chat', 'Old chat']);
    await page.click('.mt-picker-agent:has-text("Codex")');
    await page.waitForFunction(() => document.querySelectorAll('.mt-picker-item').length === 1);
    await page.click('.mt-picker-agent:has-text("Claude")');
    await page.waitForFunction(() => document.querySelectorAll('.mt-picker-item').length === 2);
    await page.click('.mt-picker-item:has-text("Old chat")');
    assert.equal(await page.locator('.mt-cell').count(), 1);
    assert.equal(await page.locator('.mt-cell-task').textContent(), 'Beta');

    // The same session cannot be opened twice; new chats of other tasks and agents can.
    await page.click('#mt-add');
    await page.selectOption('.mt-picker-select', '2');
    await page.waitForSelector('.mt-picker-item');
    await page.click('.mt-picker-item:has-text("Old chat")');
    assert.equal(await page.evaluate(() => errors.at(-1)), 'This session is already open here.');
    await page.selectOption('.mt-picker-select', '1');
    await page.waitForFunction(() => document.querySelectorAll('.mt-picker-item').length >= 1);
    await page.click('.mt-picker-agent:has-text("Codex")');
    await page.click('.mt-picker-item:has-text("New Codex chat")');
    assert.equal(await page.locator('.mt-cell').count(), 2);
    assert.deepEqual(await page.evaluate(() => created), ['/api/tasks/1/agent/conversations']);
    for (let i = 0; i < 2; i++) {
      await page.click('#mt-add');
      await page.waitForSelector('.mt-picker-item');
      await page.click('.mt-picker-item:has-text("New Claude chat")');
    }
    assert.equal(await page.locator('.mt-cell').count(), 4);
    assert.equal(await page.locator('#mt-add').isDisabled(), true, 'at most four');
    assert.equal(await page.locator('#mt-count').textContent(), '4 / 4');

    // Four columns exactly fill the page below the bar.
    const box = await page.evaluate(() => {
      const grid = document.getElementById('mt-grid').getBoundingClientRect();
      const cells = [...document.querySelectorAll('.mt-cell')].map(cell => cell.getBoundingClientRect());
      const panel = document.getElementById('multi-task-panel').getBoundingClientRect();
      return { grid, cells, panel, overflow: document.documentElement.scrollHeight - innerHeight };
    });
    assert.equal(box.cells.length, 4);
    assert.ok(Math.abs(box.cells[0].left - box.grid.left) < 1 && Math.abs(box.cells[3].right - box.grid.right) < 1, 'columns span the grid width');
    for (const cell of box.cells) assert.ok(Math.abs(cell.height - box.grid.height) < 1 && Math.abs(cell.width - box.cells[0].width) < 2, 'equal columns of full height');
    assert.ok(Math.abs(box.grid.bottom - box.panel.bottom) < 1, 'the grid reaches the bottom of the page');

    // Closing one gives its space to the others; the open chats are remembered.
    await page.locator('.mt-cell-close').first().click();
    assert.equal(await page.locator('.mt-cell').count(), 3);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('multiTaskSessions')).length), 3);
    await page.click('#tab-tasks');
    assert.equal(await page.locator('#multi-task-panel').isHidden(), true);
    assert.equal(await page.locator('.mt-cell').count(), 3, 'the chats stay mounted while the page is hidden');

    // A refresh restores the remembered chats from the stored bases (no doubled "/agent"), and a failed list is not forgotten.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('multiTaskSessions')));
    assert.ok(stored.every(item => /\/agent$/.test(item.base)));
    const source = fs.readFileSync(path.join(root, 'public/js/multi-task.js'), 'utf8').replace('const MultiTask = ', 'window.MultiTask2 = ');
    const boot = async fail => page.evaluate(async ({ source, stored, fail }) => {
      document.getElementById('mt-grid').replaceChildren();
      localStorage.setItem('multiTaskSessions', JSON.stringify(stored));
      window.requested = [];
      const get = window.API.get;
      window.API.get = async url => { requested.push(url); if (fail) throw new Error('down'); return get(url); };
      (0, eval)(source);
      MultiTask2.setActive(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      window.API.get = get;
      return { cells: document.querySelectorAll('.mt-cell').length, requested, stored: JSON.parse(localStorage.getItem('multiTaskSessions')) };
    }, { source, stored, fail });
    const down = await boot(true);
    assert.equal(down.cells, 0);
    assert.equal(down.stored.length, stored.length, 'a failed request keeps the remembered sessions');
    const restoredPage = await boot(false);
    assert.ok(restoredPage.requested.every(url => /\/api\/tasks\/\d+\/agent\/conversations$/.test(url)), restoredPage.requested.join());
    assert.equal(restoredPage.cells, stored.filter(item => item.id === 7).length, 'chats found on the server are mounted again');
    assert.deepEqual(errors, []);
    console.log('multi-task page: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

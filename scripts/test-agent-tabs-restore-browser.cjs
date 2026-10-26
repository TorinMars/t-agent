// Browser test: the chat tabs open on a task come back after a page refresh. Which chats are open is kept by the server (the open flag of
// each conversation); the shown tab is kept by the browser. The real app.js and terminal-tabs.js run against a stand-in server.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const SCOPE = '/api/tasks/7';
const KEY = `agent-tabs:${SCOPE}`;

// The server: the conversations of the task with where each is open, and what the page asked.
const server = { conversations: [], patches: [], requests: [], listFails: false };
const reset = (opened = {}) => {
  server.conversations = [
    { id: 'c1', agent: 'codex', title: 'First chat', opened: { web: opened.c1 || null, h5: null } },
    { id: 'c2', agent: 'claude', title: 'Second chat', opened: { web: opened.c2 || null, h5: null } },
    { id: 'c3', agent: 'codex', title: 'Not open', opened: { web: opened.c3 || null, h5: null } },
  ];
  server.patches = [];
  server.requests = [];
  server.listFails = false;
};

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('http://app.test/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      server.requests.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === `${SCOPE}/agent/conversations` || url.pathname === `/api/remote-servers/9/tasks/7/agent/conversations`) {
        return server.listFails ? json(route, { error: 'down' }, 500) : json(route, server.conversations);
      }
      const patch = /\/agent\/conversations\/([^/]+)$/.exec(url.pathname);
      if (patch && request.method() === 'PATCH') {
        const body = request.postDataJSON();
        server.patches.push([patch[1], body]);
        const row = server.conversations.find(entry => entry.id === patch[1]);
        if (row) row.opened[body.surface] = body.opened ? row.opened[body.surface] || Date.now() : null;
        return json(route, row || {});
      }
      if (url.pathname.endsWith('/terminals')) return json(route, [{ terminal_id: 'default', title: 'Terminal 1' }]);
      return json(route, {});
    });

    // Loads the page's scripts (init() runs as soon as app.js is added, so terminal-tabs.js comes first here); the other feature modules
    // are stubs.
    async function boot() {
      await page.goto('http://app.test/');
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8') });
      await page.evaluate(() => {
        document.querySelector('#terminal-pane').style.display = 'flex';
        window.TerminalImages = { load: async () => {}, showSettings() {} };
        window.Bookmarks = window.Engines = { load: async () => {} };
        window.Tasks = { load: async () => { window.appReady = true; } }; // init() loads the tasks right after AgentView.start()
        window.mounted = [];
        window.AgentChat = {
          AGENTS: { claude: { label: 'Claude' }, codex: { label: 'Codex' } },
          icon: () => document.createTextNode('*'),
          mount: (holder, { conversation }) => { mounted.push(conversation.id); holder.textContent = `chat ${conversation.id}`; return { focus() {}, destroy() {} }; },
          choices: async () => [], open: async () => ({ id: 'c3', agent: 'codex', title: 'Not open' }),
        };
      });
      for (const file of ['terminal-tabs.js', 'app.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
      await page.waitForFunction(() => window.appReady, null, { timeout: 5000 }).catch(() => { throw new Error(`app.js did not start: ${errors.join('; ')}`); });
    }
    const mount = sourceKey => page.evaluate(([scope, sourceKey]) => TerminalTabs.show(scope, () => {}, { taskId: 7, sourceKey }), [SCOPE, sourceKey]);
    const tabs = () => page.locator('.agent-tab').evaluateAll(nodes => nodes.map(node => [node.textContent.replace(/^\*/, '').trim(), node.classList.contains('active')]));
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
    const patches = () => server.patches.map(([id, body]) => `${id} ${body.surface} ${body.opened}`);
    const settle = () => page.waitForTimeout(150);

    // Opening a chat tells the server; only the shown tab is kept in the browser.
    reset();
    await boot();
    await mount('local');
    assert.deepEqual(await tabs(), [], 'nothing was open yet');
    await page.evaluate(() => AgentView.open('codex', null)); // opens c3
    await page.waitForSelector('.agent-tab');
    await settle();
    assert.deepEqual(patches(), ['c3 web true']);
    assert.deepEqual(await stored(), { active: 'c3' }, 'the browser keeps only which tab is shown');
    assert.ok(server.conversations.find(row => row.id === 'c3').opened.web > 0, 'the server has it as open');

    // A refresh brings the open chats back, in the order they were opened, with the tab that was shown; a deleted chat does not matter.
    reset({ c2: 1000, c1: 2000 });
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ active: 'c2' })), KEY);
    await boot();
    await mount('local');
    await page.waitForFunction(() => mounted.length === 2);
    assert.deepEqual(await tabs(), [['Second chat', true], ['First chat', false]]);
    assert.deepEqual(await page.evaluate(() => mounted), ['c2', 'c1']);
    assert.equal(await page.locator('#agent-pane').isVisible(), true);
    assert.deepEqual(patches(), [], 'restoring tells the server nothing');

    // Selecting and leaving change what the browser remembers; closing tells the server.
    await page.locator('.agent-tab').nth(1).click();
    assert.deepEqual(await stored(), { active: 'c1' });
    await page.locator('.terminal-tab:not(.agent-tab)').first().click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY), null);
    await page.locator('.agent-tab .terminal-tab-close').first().click();
    await settle();
    assert.deepEqual(patches(), ['c2 web false']);
    await page.locator('.agent-tab .terminal-tab-close').first().click();
    await settle();
    assert.deepEqual(patches(), ['c2 web false', 'c1 web false']);
    assert.deepEqual(server.conversations.map(row => row.opened.web), [null, null, null], 'closed everywhere');

    // Another browser (nothing in its storage) shows the same open chats, with the terminal in front.
    reset({ c1: 1000, c3: 2000 });
    await boot();
    await mount('local');
    await page.waitForFunction(() => mounted.length === 2);
    assert.deepEqual(await tabs(), [['First chat', false], ['Not open', false]]);
    assert.equal(await page.locator('#agent-pane').isVisible(), false, 'no tab was shown there, so the terminal is');

    // What an earlier version kept only in this browser moves to the server, once.
    reset();
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ ids: ['c1', 'gone', 'c2'], active: 'c2' })), KEY);
    await boot();
    await mount('local');
    await page.waitForFunction(() => mounted.length === 2);
    await settle();
    assert.deepEqual(await tabs(), [['First chat', false], ['Second chat', true]]);
    assert.deepEqual(patches().sort(), ['c1 web true', 'c2 web true'], 'the deleted one is not sent');
    assert.deepEqual(await stored(), { active: 'c2' }, 'the list no longer lives in the browser');
    await boot();
    await mount('local');
    await page.waitForFunction(() => mounted.length === 2);
    assert.equal(server.patches.length, 2, 'and is not sent again');

    // Another engine never asks for conversations; a list that cannot be read opens nothing and changes nothing.
    reset({ c1: 1000 });
    await boot();
    await mount('remote-9');
    await page.waitForTimeout(150);
    assert.deepEqual(await tabs(), []);
    assert.equal(server.requests.some(request => request.endsWith('/agent/conversations')), false);
    reset({ c1: 1000 });
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ ids: ['c1'], active: 'c1' })), KEY);
    await boot();
    server.listFails = true;
    await mount('local');
    await page.waitForTimeout(200);
    assert.deepEqual(await tabs(), []);
    assert.deepEqual(server.patches, []);
    assert.deepEqual(await stored(), { ids: ['c1'], active: 'c1' }, 'nothing is lost when the list cannot be read');
    assert.deepEqual(errors, []);
    console.log('Agent chat tabs: saved by the server, restored in order after a refresh and in another browser, old browser records moved over, failures lose nothing.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

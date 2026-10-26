// Browser test: the chat tabs open on a task come back after a page refresh (the real app.js and terminal-tabs.js, with the chat view and the network stubbed).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const SCOPE = '/api/tasks/7';
const KEY = `agent-tabs:${SCOPE}`;

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://app.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));

    // Loads the page's scripts (init() runs as soon as app.js is added, so terminal-tabs.js comes first here); the other feature modules and the network are stubs.
    async function boot() {
      await page.goto('http://app.test/');
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8') });
      await page.evaluate(scope => {
        document.querySelector('#terminal-pane').style.display = 'flex';
        window.TerminalImages = { load: async () => {}, showSettings() {} };
        window.Bookmarks = window.Engines = { load: async () => {} };
        window.Tasks = { load: async () => { window.appReady = true; } }; // init() loads the tasks right after AgentView.start()
        window.requests = [];
        window.mounted = [];
        window.destroyed = [];
        const conversations = [
          { id: 'c1', agent: 'codex', title: 'First chat' },
          { id: 'c2', agent: 'claude', title: 'Second chat' },
          { id: 'c3', agent: 'codex', title: 'Not open' },
        ];
        window.fetch = async (url, options = {}) => {
          requests.push(String(url));
          const body = url === `${scope}/agent/conversations` ? conversations : url.endsWith('/terminals') ? [{ terminal_id: 'default', title: 'Terminal 1' }] : {};
          return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
        };
        window.AgentChat = {
          AGENTS: { claude: { label: 'Claude' }, codex: { label: 'Codex' } },
          icon: () => document.createTextNode('*'),
          mount: (holder, { conversation }) => { mounted.push(conversation.id); holder.textContent = `chat ${conversation.id}`; return { focus() {}, destroy() { destroyed.push(conversation.id); } }; },
          choices: async () => [], open: async () => ({ id: 'c3', agent: 'codex', title: 'Not open' }),
        };
      }, SCOPE);
      for (const file of ['terminal-tabs.js', 'app.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js', file), 'utf8') });
      await page.waitForFunction(() => window.appReady, null, { timeout: 5000 }).catch(() => { throw new Error(`app.js did not start: ${errors.join('; ')}`); });
    }
    const mount = sourceKey => page.evaluate(([scope, sourceKey]) => TerminalTabs.show(scope, () => {}, { taskId: 7, sourceKey }), [SCOPE, sourceKey]);
    const tabs = () => page.locator('.agent-tab').evaluateAll(nodes => nodes.map(node => [node.textContent.replace(/^\*/, '').trim(), node.classList.contains('active')]));
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);

    // Open a chat, switch tabs, refresh: the tabs and the shown chat come back.
    await boot();
    await mount('local');
    assert.deepEqual(await tabs(), [], 'nothing was open yet');
    await page.evaluate(() => AgentView.open('codex', null)); // opens c3
    await page.waitForSelector('.agent-tab');
    assert.deepEqual(await stored(), { ids: ['c3'], active: 'c3' });
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ ids: ['c1', 'gone', 'c2'], active: 'c2' })), KEY);

    await boot(); // the refresh
    await mount('local');
    await page.waitForSelector('.agent-tab');
    await page.waitForFunction(() => mounted.length === 2);
    assert.deepEqual(await tabs(), [['First chat', false], ['Second chat', true]], 'the open chats are back and the shown one is active; a deleted conversation is dropped');
    assert.deepEqual(await page.evaluate(() => mounted), ['c1', 'c2']);
    assert.equal(await page.locator('#agent-pane').isVisible(), true);
    assert.deepEqual(await stored(), { ids: ['c1', 'c2'], active: 'c2' }, 'the stored list no longer has the deleted conversation');

    // Selecting, leaving for a terminal and closing keep the stored list current.
    await page.locator('.agent-tab').first().click();
    assert.deepEqual(await stored(), { ids: ['c1', 'c2'], active: 'c1' });
    await page.locator('.terminal-tab:not(.agent-tab)').first().click();
    assert.deepEqual(await stored(), { ids: ['c1', 'c2'], active: null });
    await page.locator('.agent-tab .terminal-tab-close').first().click();
    assert.deepEqual(await stored(), { ids: ['c2'], active: null });
    await page.locator('.agent-tab .terminal-tab-close').first().click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY), null, 'closing the last chat clears the stored list');

    // A task is restored once per page; another engine never asks for conversations.
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ ids: ['c1'], active: null })), KEY);
    await boot();
    await mount('remote-1');
    await page.waitForTimeout(150);
    assert.deepEqual(await tabs(), []);
    assert.equal(await page.evaluate(scope => requests.some(url => url.includes(`${scope}/agent/conversations`)), SCOPE), false);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY) !== null, true, 'a remote mount leaves the stored list alone');

    // A failed load keeps the stored list for the next refresh.
    await boot();
    await page.evaluate(() => { const ok = window.fetch; window.fetch = async (url, options) => (String(url).endsWith('/agent/conversations') ? { ok: false, text: async () => 'down' } : ok(url, options)); });
    await mount('local');
    await page.waitForTimeout(150);
    assert.deepEqual(await stored(), { ids: ['c1'], active: null });
    assert.deepEqual(errors, []);
    console.log('Agent chat tabs: restored after a refresh, deleted chats dropped, selection and close persisted, remote and failed loads leave the list alone.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

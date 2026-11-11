// The keyboard flow of the New session dialog, in real headless Chromium on a computer (1440x900, pointer), with the routes mocked. Twice: a macOS-like page
// (navigator.platform MacIntel: Cmd+Shift+O, the "+" title "New session (⌘⇧O)") and another system (Win32: Ctrl+Shift+O, "(Ctrl+Shift+O)").
// - Cmd/Ctrl+Shift+O, pressed with the real key combination (Playwright keyboard.press) while the focus is in the terminal, opens the dialog for the task shown;
//   the browser default is prevented (the event's defaultPrevented) and nothing reaches the terminal. With no task shown, with another dialog open, or as a
//   key repeat it opens nothing.
// - The choices are Claude session, Codex session, New Terminal (a listbox); Claude is highlighted. In the name field Enter makes a NEW Claude session with the
//   default name, Down + Enter Codex, Down Down + Enter a terminal, Up from the first wraps to the last, a typed name is used, an IME composing Enter or arrow
//   does nothing.
// - The focus starts in the name field; Tab goes to the highlighted choice (roving tabIndex), the arrows move the highlight and the focus there with wrap-around,
//   Enter makes the focused kind with the typed name, Shift+Tab goes back to the field with the text kept, and a further Tab reaches Cancel.
// What headless Chromium cannot show: whether a real Chrome window lets the page have Cmd/Ctrl+Shift+O before its own bookmarks manager (a browser shortcut
// handled by the window, outside the page). Here the key reaches the page and its default is prevented.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const CHOICES = ['Claude session', 'Codex session', 'New Terminal'];
const TASKS = [{ id: 1, title: 'Alpha', status: 'doing' }, { id: 2, title: 'Beta', status: 'doing' }];
const SHORT = { timeout: 2000 };

async function openPage(browser, apple) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(platform => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform, configurable: true });
    window.sent = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { window.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // Every keydown of the O key, seen first (capture on window, before the page's own handler on document): its defaultPrevented is read afterwards.
    window.oKeys = [];
    window.addEventListener('keydown', event => { if (event.code === 'KeyO') window.oKeys.push(event); }, true);
  }, apple ? 'MacIntel' : 'Win32');
  const server = { posts: [] };
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const { pathname } = url;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(pathname)) return route.fulfill({ contentType: TYPES[path.extname(pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', pathname)) });
    if (pathname === '/auth/me') return json({ effective_work_dir: '/home/t/tasks' });
    if (pathname === '/api/remote-servers') return json([]);
    if (/\/task-groups$/.test(pathname)) return json([{ key: 'doing', name: 'Doing', sort_order: 1 }]);
    if (pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    const terminals = pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'POST') {
      const body = route.request().postDataJSON();
      server.posts.push([pathname, body]);
      return json({ terminal_id: `fresh-${server.posts.length}`, title: body.title || 'Terminal 9', agent: body.agent || null }, 201);
    }
    if (terminals && method === 'GET') return json([{ terminal_id: 'default', title: 'Terminal 1' }]);
    if (/\/agent-sessions$/.test(pathname)) return json([{ id: 's1', title: 'Older session' }]);
    if (/\/terminal\/ack$/.test(pathname)) return json({ success: true });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  return { context, page, server, pageErrors };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const apple of [true, false]) {
      const label = apple ? 'macOS-like' : 'other system';
      const combo = apple ? 'Meta+Shift+O' : 'Control+Shift+O';
      const { context, page, server, pageErrors } = await openPage(browser, apple);
      const dialog = page.locator('#h5-new-session');
      const choices = page.locator('#h5-new-session #h5-term-menu-actions button');
      const nameField = page.locator('#h5-new-name-input');
      const terminal = page.locator('#h5-terminal .h5-xterm:not([hidden]) .xterm-helper-textarea');
      const activeId = () => page.evaluate(() => document.activeElement && document.activeElement.id);
      const lastO = () => page.evaluate(() => { const event = window.oKeys.at(-1); return event ? { prevented: event.defaultPrevented, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey } : null; });
      const gone = async text => { await dialog.waitFor({ state: 'detached', ...SHORT }).catch(() => assert.fail(`${label}: ${text}: the dialog is still open`)); };
      const highlighted = () => page.evaluate(() => {
        const field = document.getElementById('h5-new-name-input');
        const on = [...document.querySelectorAll('#h5-term-menu-actions [role="option"][aria-selected="true"]')];
        return { active: field && field.getAttribute('aria-activedescendant'), on: on.map(node => node.id), text: on.map(node => node.textContent) };
      });
      // Opens the dialog with the real key combination, with the focus in the terminal; checks the defaults of a new opening.
      const openByKeys = async () => {
        await terminal.focus();
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea')), true, `${label}: the terminal has the focus`);
        const sentBefore = await page.evaluate(() => window.sent.length);
        await page.keyboard.press(combo);
        await choices.first().waitFor(SHORT);
        await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'h5-new-name-input', null, SHORT).catch(() => {});
        const seen = await lastO();
        assert.ok(seen && seen.shift && (apple ? seen.meta && !seen.ctrl : seen.ctrl && !seen.meta), `${label}: the real ${combo} reached the page (${JSON.stringify(seen)})`);
        assert.equal(seen.prevented, true, `${label}: the browser default of ${combo} is prevented`);
        assert.deepEqual(await page.evaluate(n => window.sent.slice(n), sentBefore), [], `${label}: nothing of ${combo} reaches the terminal`);
        assert.deepEqual(await choices.allTextContents(), CHOICES, `${label}: the choices, in order`);
        assert.equal(await page.locator('#h5-new-session-task').textContent(), 'Alpha', `${label}: the dialog is for the task shown`);
        assert.equal(await activeId(), 'h5-new-name-input', `${label}: the name field has the focus on open`);
        assert.deepEqual((await highlighted()).text, ['Claude session'], `${label}: Claude session is highlighted first`);
      };
      const created = async (want, text) => {
        await gone(text);
        assert.deepEqual(server.posts, [['/api/tasks/1/terminals', want]], `${label}: ${text}`);
        server.posts.length = 0;
        await terminal.waitFor({ state: 'attached' });
      };

      // No task shown: the key does nothing.
      await page.locator('#h5-tasks .h5-task-item', { hasText: 'Alpha' }).waitFor();
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press(combo);
      await page.waitForTimeout(300);
      assert.equal(await dialog.count(), 0, `${label}: with no task shown nothing opens`);
      assert.equal((await lastO()).prevented, false, `${label}: with no task shown the key is not taken`);

      // Alpha is shown, with its terminal.
      await page.locator('#h5-tasks .h5-task-item', { hasText: 'Alpha' }).click();
      await page.locator('#h5-tasks .h5-terminal-list .h5-terminal-main').first().click();
      await page.waitForFunction(() => document.getElementById('h5-task-name').textContent === 'Alpha');
      await terminal.waitFor({ state: 'attached' });

      // The "+" title names the shortcut.
      const plus = page.locator('#h5-tasks .h5-task-row:has(.h5-task-title:text-is("Alpha")) .h5-task-add');
      assert.equal(await plus.getAttribute('title'), apple ? 'New session (⌘⇧O)' : 'New session (Ctrl+Shift+O)', `${label}: the "+" title`);
      assert.equal(await plus.getAttribute('aria-label'), 'New session', `${label}: the "+" aria-label`);

      // Enter: a new Claude session with the default name.
      await openByKeys();
      assert.equal(await page.locator('#h5-term-menu-actions').getAttribute('role'), 'listbox', `${label}: the choices are a listbox`);
      assert.deepEqual(await choices.evaluateAll(nodes => nodes.map(node => [node.getAttribute('role'), node.tabIndex])), [['option', 0], ['option', -1], ['option', -1]], `${label}: options, only the highlighted one in the tab order`);
      assert.equal(await nameField.getAttribute('role'), 'combobox', `${label}: the field owns the list`);
      assert.equal(await page.locator('#h5-new-session-keys').textContent(), 'Enter to create · ↑↓ to choose', `${label}: the hint`);
      assert.equal((await highlighted()).active, (await highlighted()).on[0], `${label}: aria-activedescendant names the highlighted option`);
      const sentBefore = await page.evaluate(() => window.sent.length);
      await page.keyboard.press('Enter');
      await created({ agent: 'claude' }, 'Enter makes a new Claude session with the default name');
      assert.deepEqual(await page.evaluate(n => window.sent.slice(n).filter(data => data.includes('\r')), sentBefore), [], `${label}: the Enter is not sent to the terminal`);

      // A held key opens it once: a repeat with the dialog closed opens nothing (and is still kept from the browser).
      await terminal.focus();
      await page.evaluate(() => {
        const target = document.activeElement;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', shiftKey: true, metaKey: navigator.platform === 'MacIntel', ctrlKey: navigator.platform !== 'MacIntel', repeat: true, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(250);
      assert.equal(await dialog.count(), 0, `${label}: a key repeat opens nothing`);
      assert.equal((await lastO()).prevented, true, `${label}: a key repeat is kept from the browser too`);

      // Down + Enter: Codex.
      await openByKeys();
      await page.keyboard.press('ArrowDown');
      assert.deepEqual((await highlighted()).text, ['Codex session'], `${label}: Down highlights Codex session`);
      assert.equal(await activeId(), 'h5-new-name-input', `${label}: the focus stays in the field`);
      await page.keyboard.press('Enter');
      await created({ agent: 'codex' }, 'Down then Enter makes a new Codex session');

      // Down twice + Enter: a terminal, with a typed name.
      await openByKeys();
      await page.keyboard.type('Build');
      assert.equal(await nameField.inputValue(), 'Build', `${label}: typing goes into the field`);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      assert.deepEqual((await highlighted()).text, ['New Terminal'], `${label}: Down twice highlights New Terminal`);
      await page.keyboard.press('Enter');
      await created({ title: 'Build' }, 'Down twice then Enter makes a terminal with the typed name');

      // Up from the first wraps to the last, Down from the last wraps to the first.
      await openByKeys();
      await page.keyboard.press('ArrowUp');
      assert.deepEqual((await highlighted()).text, ['New Terminal'], `${label}: Up from the first wraps to the last`);
      await page.keyboard.press('ArrowDown');
      assert.deepEqual((await highlighted()).text, ['Claude session'], `${label}: Down from the last wraps to the first`);
      await page.keyboard.type('Named claude');
      await page.keyboard.press('Enter');
      await created({ agent: 'claude', title: 'Named claude' }, 'a typed name is used');

      // IME composition: Enter and the arrows do nothing.
      await openByKeys();
      {
        const cdp = await context.newCDPSession(page);
        const raw = async (key, keyCode) => {
          await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
        };
        await page.evaluate(() => {
          window.imeKeys = [];
          document.getElementById('h5-new-name-input').addEventListener('keydown', event => window.imeKeys.push({ key: event.key, isComposing: event.isComposing, keyCode: event.keyCode }));
        });
        await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
        assert.equal(await nameField.inputValue(), 'ni', `${label}: the composition is in the field`);
        await raw('Enter', 229);
        await raw('Enter', 13);
        await raw('ArrowDown', 229);
        const keys = await page.evaluate(() => window.imeKeys.slice());
        assert.equal(keys.length, 3, `${label}: the composing keys reached the field (${JSON.stringify(keys)})`);
        assert.ok(keys.every(key => key.isComposing), `${label}: a real composition (${JSON.stringify(keys)})`);
        await page.waitForTimeout(250);
        assert.equal(await dialog.count(), 1, `${label}: a composing Enter does not create`);
        assert.deepEqual(server.posts, [], `${label}: nothing was made during the composition`);
        assert.deepEqual((await highlighted()).text, ['Claude session'], `${label}: a composing arrow does not move the highlight`);
        await cdp.send('Input.insertText', { text: '\u4f60\u597d' });
        assert.equal(await nameField.inputValue(), '\u4f60\u597d', `${label}: the text is committed`);
        await cdp.detach();
      }
      await page.keyboard.press('Escape');
      await gone('Escape');

      // Tab into the choices: the focus goes to the highlighted option; arrows move inside; Shift+Tab back to the field; a further Tab reaches Cancel.
      await openByKeys();
      await page.keyboard.type('abc');
      assert.equal(await nameField.inputValue(), 'abc', `${label}: typing goes into the field`);
      await page.keyboard.press('Tab');
      assert.equal(await activeId(), 'h5-new-session-option-0', `${label}: Tab lands on the highlighted option (Claude session)`);
      const ring = () => page.evaluate(() => {
        const node = document.activeElement;
        const style = getComputedStyle(node);
        return { outline: style.outlineStyle, width: style.outlineWidth, filled: node.classList.contains('MuiButton-contained') };
      });
      assert.deepEqual(await ring(), { outline: 'solid', width: '2px', filled: true }, `${label}: the focused option has a focus ring besides the highlight`);
      const steps = [['ArrowDown', 1, 'Codex session'], ['ArrowDown', 2, 'New Terminal'], ['ArrowDown', 0, 'Claude session'], ['ArrowUp', 2, 'New Terminal'], ['ArrowUp', 1, 'Codex session']];
      for (const [key, index, text] of steps) {
        await page.keyboard.press(key);
        assert.equal(await activeId(), `h5-new-session-option-${index}`, `${label}: ${key} in the list moves the focus to ${text}`);
        assert.deepEqual((await highlighted()).text, [text], `${label}: ${key} in the list moves the highlight to ${text}`);
        assert.deepEqual(await choices.evaluateAll(nodes => nodes.map(node => node.tabIndex)), [0, 1, 2].map(i => (i === index ? 0 : -1)), `${label}: roving tabIndex after ${key}`);
      }
      await page.keyboard.press('Shift+Tab');
      assert.equal(await activeId(), 'h5-new-name-input', `${label}: Shift+Tab goes back to the field`);
      assert.equal(await nameField.inputValue(), 'abc', `${label}: the text is kept`);
      assert.deepEqual((await highlighted()).text, ['Codex session'], `${label}: the highlight is kept`);
      assert.deepEqual(await page.evaluate(() => getComputedStyle(document.getElementById('h5-new-session-option-1')).outlineStyle), 'none', `${label}: no focus ring on the highlighted option while the field has the focus`);
      await page.keyboard.press('Tab');
      assert.equal(await activeId(), 'h5-new-session-option-1', `${label}: Tab lands on the highlighted option again`);
      await page.keyboard.press('Tab');
      assert.equal(await activeId(), 'h5-term-menu-cancel', `${label}: a further Tab reaches Cancel`);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await activeId(), 'h5-new-session-option-1', `${label}: Shift+Tab from Cancel returns to the option`);
      await page.keyboard.press('Enter');
      await created({ agent: 'codex', title: 'abc' }, 'Enter on a focused option makes that kind with the typed name');

      // The pointer way is unchanged: a press on Claude session opens its sub-list (Enter there runs New Claude session).
      await openByKeys();
      await choices.filter({ hasText: 'Claude session' }).click();
      await choices.filter({ hasText: 'Older session' }).waitFor();
      assert.deepEqual(await choices.allTextContents(), ['New Claude session', 'Older session', 'Back'], `${label}: the Claude sub-list`);
      assert.equal(await page.locator('#h5-new-session-keys').count(), 0, `${label}: no keyboard hint in a sub-list`);
      await nameField.focus();
      await page.keyboard.press('Enter');
      await created({ agent: 'claude' }, 'Enter in the sub-list runs New Claude session');

      // Another dialog open (New task): the key opens nothing and is left alone.
      await page.locator('#h5-add-task').click();
      await page.locator('#h5-new-task-title').waitFor();
      await page.waitForTimeout(250);
      await page.keyboard.press(combo);
      await page.waitForTimeout(300);
      assert.equal(await dialog.count(), 0, `${label}: with another dialog open nothing opens`);
      assert.equal((await lastO()).prevented, false, `${label}: with another dialog open the key is not taken`);
      assert.equal(await page.locator('#h5-new-task-dialog').count(), 1, `${label}: the other dialog stays`);
      await page.keyboard.press('Escape');
      await page.locator('#h5-new-task-dialog').waitFor({ state: 'detached', ...SHORT });

      assert.deepEqual(server.posts, [], `${label}: nothing else was made`);
      assert.deepEqual(pageErrors, [], `${label}: no page errors`);
      console.log(`  ok   ${label}: ${combo}, Enter / arrows in the field, Tab into the choices, IME, no task, another dialog`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log('The New session keyboard flow works (Cmd/Ctrl+Shift+O, the highlighted choice, Tab into the list).');
})().catch(error => { console.error(error); process.exit(1); });

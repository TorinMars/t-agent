// Translate-and-send next to text that is already on the terminal's input line, in real Chromium with the real xterm. The screen is written into xterm
// through a mocked terminal socket; the translator is mocked. The owner's rule: an empty input line gets the translation and Enter, as before; a line that
// already has text gets a line break and the translation after it (one bracketed paste starting with a carriage return, or, without bracketed paste, a
// space and the translation), and then the same Enter sends the whole input. The send arrow is unchanged. The server is mocked (no data folder is used).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const TRANSLATIONS = { one: 'Translated text', two: 'Line one\nLine two' };
const pageErrors = [];
const translations = [];

const TASKS = [{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }];
const TERMINALS = { 1: [{ terminal_id: 'h5-default', title: 'Terminal 1' }] };
const CLAUDE = '❯';
const CODEX = '›';
const RULE = '─'.repeat(30);

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
      emit(data) { this.onmessage?.({ data }); }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
  });
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(url.pathname)) return route.fulfill({ contentType: TYPES[path.extname(url.pathname)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', url.pathname)) });
    if (url.pathname === '/api/translate' && method === 'POST') {
      const text = route.request().postDataJSON().text;
      translations.push(text);
      return json({ text: TRANSLATIONS[text] || 'Translated text' });
    }
    if (url.pathname === '/api/remote-servers') return json([]);
    if (url.pathname === '/api/tasks' && method === 'GET') return json(TASKS);
    if (url.pathname === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (url.pathname === '/api/tasks/terminal-activity') return json({});
    if (url.pathname === '/api/tasks/terminal-subagents') return json({});
    const terminals = url.pathname.match(/^\/api\/tasks\/(\d+)\/terminals$/);
    if (terminals && method === 'GET') return json(TERMINALS[terminals[1]] || []);
    if (/^\/api\/tasks\/\d+\/agent\/conversations$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/agent-chat/summary') return json({ running: 0, queued: 0, submitted: 0 });
    if (url.pathname === '/api/oss/config') return json({ enabled: false });
    if (url.pathname === '/api/system/check-update' || url.pathname === '/api/system/update-status') return json({ status: 'up_to_date', local_version: '1.0.0' });
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  await page.locator('#h5-tasks').waitFor({ state: 'visible' });
  await page.locator('.h5-task-item', { hasText: 'Fix login' }).click();
  await page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main', { hasText: 'Terminal 1' }).click();
  await page.waitForFunction(() => window.sockets.length > 0 && window.sockets.at(-1).readyState === 1 && document.querySelector('.h5-xterm:not([hidden]) .xterm-rows'));
  return { context, page, input: page.locator('#h5-translate-input') };
}

const typedToTerminal = page => page.evaluate(() => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')));
// Draws a screen: clears it, writes the rows, puts the cursor at [column, row] (0-based) and sets bracketed paste. The last row carries a sentinel that is
// cleared again, so the test knows xterm has parsed everything once that row is drawn.
let screens = 0;
async function draw(page, rows, [column, row], bracketed) {
  const sentinel = `SCREEN${++screens}`;
  const body = rows.map(text => `${text}\x1b[K`).join('\r\n');
  const data = `\x1b[?2004${bracketed ? 'h' : 'l'}\x1b[H\x1b[2J${body}\r\n${sentinel}`;
  await page.evaluate(text => window.sockets.at(-1).emit(text), data);
  await page.waitForFunction(text => document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.includes(text), sentinel);
  await page.evaluate(([x, y]) => window.sockets.at(-1).emit(`\r\x1b[2K\x1b[${y + 1};${x + 1}H`), [column, row]);
  await page.waitForFunction(text => !document.querySelector('.h5-xterm:not([hidden]) .xterm-rows').textContent.includes(text), sentinel);
}
async function press(page, input, button, text) {
  const before = (await typedToTerminal(page)).length;
  await input.click();
  await input.fill(text);
  await page.locator(button).click();
  await page.waitForFunction(count => window.sockets.at(-1).sent.filter(item => !item.startsWith('{')).length >= count + 2, before);
  await page.waitForTimeout(250); // nothing more follows
  const sent = (await typedToTerminal(page)).slice(before);
  assert.equal(await input.inputValue(), '', 'the box is emptied');
  return sent;
}
const translate = (page, input, text = 'one') => press(page, input, '#h5-translate-button', text);

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const { context, page, input } = await openPage(browser);
    const claudeEmpty = ['previous answer', RULE, `${CLAUDE} \x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[22m`, RULE, '  \x1b[2m? for shortcuts\x1b[22m'];
    const claudeFilled = ['previous answer', RULE, `${CLAUDE} fix the login page\x1b[7m \x1b[27m`, RULE, '  \x1b[2mesc to clear\x1b[22m'];
    const claudeMulti = ['previous answer', RULE, `${CLAUDE} first line`, '  second line\x1b[7m \x1b[27m', RULE];

    // Empty input lines: the translation and Enter, exactly as before.
    await draw(page, claudeEmpty, [2, 2], true);
    assert.deepEqual(await translate(page, input), ['Translated text', '\r'], 'Claude Code, empty box with a placeholder: typed, then Enter');
    await draw(page, ['me % '], [5, 0], false);
    assert.deepEqual(await translate(page, input), ['Translated text', '\r'], 'empty shell prompt: typed, then Enter');
    await draw(page, ['me % '], [5, 0], true);
    assert.deepEqual(await translate(page, input, 'two'), ['\x1b[200~Line one\rLine two\x1b[201~', '\r'], 'empty line, two-line translation: the old paste, then Enter');
    await draw(page, ['some output', 'with no prompt'], [0, 1], true);
    assert.deepEqual(await translate(page, input), ['Translated text', '\r'], 'a line that cannot be understood counts as empty');

    // Text on the input line with bracketed paste: ONE paste that starts with a carriage return, then Enter sends the whole input.
    await draw(page, claudeFilled, [20, 2], true);
    assert.deepEqual(await translate(page, input), ['\x1b[200~\rTranslated text\x1b[201~', '\r'], 'Claude Code with text: a new line, the translation, then Enter');
    await draw(page, claudeMulti, [13, 3], true);
    assert.deepEqual(await translate(page, input, 'two'), ['\x1b[200~\rLine one\rLine two\x1b[201~', '\r'], 'multi-line Claude input: a new line and the lines in one paste, then Enter');
    await draw(page, ['', `${CODEX} write the tests`, '', '  \x1b[2m? for shortcuts\x1b[22m'], [17, 1], true);
    assert.deepEqual(await translate(page, input), ['\x1b[200~\rTranslated text\x1b[201~', '\r'], 'Codex with text');
    await draw(page, ['me % git status'], [15, 0], true);
    assert.deepEqual(await translate(page, input), ['\x1b[200~\rTranslated text\x1b[201~', '\r'], 'zsh with text and bracketed paste');

    // Text on the input line without bracketed paste: a space and the translation (lines joined), then Enter.
    await draw(page, ['user@host:~/work$ git commit -m'], [31, 0], false);
    assert.deepEqual(await translate(page, input), [' Translated text', '\r'], 'shell with text, no bracketed paste: a space, the translation, then Enter');
    assert.deepEqual(await translate(page, input, 'two'), [' Line one Line two', '\r'], 'no bracketed paste: the lines are joined with spaces');

    // The send arrow is unchanged: what was typed, as typed, then Enter, whatever is on the input line.
    await draw(page, claudeFilled, [20, 2], true);
    const asked = translations.length;
    assert.deepEqual(await press(page, input, '#h5-translate-send', 'as typed'), ['as typed', '\r'], 'send arrow next to text: unchanged');
    await draw(page, ['user@host:~/work$ git commit -m'], [31, 0], false);
    assert.deepEqual(await press(page, input, '#h5-translate-send', 'as typed'), ['as typed', '\r'], 'send arrow next to shell text: unchanged');
    assert.equal(translations.length, asked, 'the send arrow makes no translate request');

    await context.close();
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log('h5 translate-and-send next to existing input: all checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

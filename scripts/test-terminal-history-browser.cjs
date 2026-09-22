const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
    await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
    await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
    for (const file of [require.resolve('@xterm/xterm'), require.resolve('@xterm/addon-fit'), 'public/js/terminal-viewport.js', 'public/js/terminal-clipboard.js', 'public/js/terminal-history.js']) {
      await page.addScriptTag({ path: file.startsWith('public/') ? path.join(root, file) : file });
    }
    const result = await page.evaluate(async () => {
      document.getElementById('terminal-pane').style.display = 'flex';
      const el = document.createElement('div'); el.className = 'xterm-host'; document.getElementById('xterm-container').append(el);
      const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
      const fitAddon = new FitAddon.FitAddon(); term.loadAddon(fitAddon); term.open(el);
      window.sent = [];
      const ws = { readyState: WebSocket.OPEN, send: data => { const frame = JSON.parse(data); if (frame.type === 'history-page') sent.push(frame); } };
      window.inst = { term, ws, el, fitAddon, clipboard: TerminalClipboard.attach(term, el) };
      inst.history = TerminalHistory.attach(inst); inst.history.bind(ws); TerminalHistory.activate(inst);
      let replies = ''; term.onData(data => { if (!inst.paused) replies += data; });
      const lines = Array.from({ length: 500 }, (_, index) => `recent-${index}`).join('\r\n') + '\r\n';
      inst.history.handle(JSON.stringify({ type: 'history', cols: 80, rows: 24, data: lines + '\x1b[31mREADY\x1b[0m\x1b[6n\x1b]52;c;c2VjcmV0\x07', archive: { id: 'a', before: 999, hasMore: true, limit: 500 } }), ws);
      term.write('-LIVE');
      await new Promise(done => term.write('', done));
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const buffer = term.buffer.active;
      const output = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n');
      return { output, paused: inst.paused, replies, length: buffer.length, requests: sent.length, dialogs: document.querySelectorAll('[role="dialog"]').length };
    });
    assert.match(result.output, /READY-LIVE/); assert.equal((result.output.match(/-LIVE/g) || []).length, 1);
    assert.equal(result.paused, false); assert.equal(result.replies, ''); assert.ok(result.length <= 524);
    assert.equal(result.requests, 0);
    await page.click('#btn-terminal-history');
    await page.evaluate(() => {
      inst.history.handle(JSON.stringify({ ...sent[0], before: 500, hasMore: true, data: 'recent archive\n'.repeat(500) }), inst.ws);
    });
    await page.locator('#terminal-history-text').evaluate(el => { el.scrollTop = 200; });
    const before = await page.locator('#terminal-history-text').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
    await page.click('#terminal-history-earlier');
    await page.evaluate(() => inst.history.handle(JSON.stringify({ ...sent[1], before: 0, hasMore: false, data: '<script>bad()</script>\n' + 'older\n'.repeat(499) }), inst.ws));
    const after = await page.locator('#terminal-history-text').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, first: el.textContent.slice(0, 22), scripts: el.querySelectorAll('script').length }));
    assert.equal(after.top, before.top + after.height - before.height); assert.equal(after.scripts, 0); assert.match(after.first, /<script>/);
    await page.evaluate(() => { inst.term.write('\x1b[?1049hTUI'); });
    await page.waitForFunction(() => inst.term.buffer.active.type === 'alternate');
    assert.equal(await page.evaluate(() => inst.term.buffer.active.type), 'alternate');
    await page.evaluate(() => TerminalHistory.activate(null));
    assert.equal(await page.locator('.terminal-history-dialog').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Real xterm snapshot/live ordering, query suppression, safe paging and scroll anchoring passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

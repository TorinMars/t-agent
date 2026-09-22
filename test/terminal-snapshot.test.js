const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { TerminalSnapshot, createHistoryArchive, archiveText, PAGE_BYTES } = require('../lib/terminal-snapshot');
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const lines = buffer => Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true));

async function replay(snapshot) {
  let frame;
  await snapshot.snapshot(value => { frame = value; });
  const terminal = new Terminal({ cols: frame.cols, rows: frame.rows, scrollback: 500, allowProposedApi: true });
  await write(terminal, frame.data);
  return { terminal, frame };
}

test('snapshot retains latest 500 rendered scrollback lines and restores wrapped color output', async () => {
  const snapshot = new TerminalSnapshot(40, 10);
  await snapshot.write('\x1b[31m' + Array.from({ length: 10000 }, (_, i) => `row-${i}\r\n`).join(''));
  const { terminal, frame } = await replay(snapshot);
  assert.equal(terminal.buffer.normal.length, 510);
  assert.deepEqual(lines(terminal.buffer.normal), lines(snapshot.terminal.buffer.normal));
  assert.ok(frame.data.length < 15000);
  assert.doesNotMatch(frame.data, /row-100\r/);
  assert.equal(terminal.buffer.normal.getLine(0).getCell(0).getFgColor(), 1);
  terminal.dispose(); await snapshot.dispose();
});

test('replay preserves alternate screen, cursor, paste/mouse modes and scrolling margins', async () => {
  const snapshot = new TerminalSnapshot(40, 10);
  await snapshot.write('shell\r\n\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[2;8r\x1b[4;3H\x1b[32mTUI');
  const { terminal, frame } = await replay(snapshot);
  assert.equal(terminal.buffer.active.type, 'alternate');
  assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
  assert.equal(terminal.buffer.active.cursorX, snapshot.terminal.buffer.active.cursorX);
  assert.equal(terminal.buffer.active.cursorY, snapshot.terminal.buffer.active.cursorY);
  assert.equal(terminal.modes.bracketedPasteMode, true);
  assert.equal(terminal.modes.mouseTrackingMode, 'drag');
  assert.equal(terminal._core.coreService.isCursorHidden, true);
  assert.equal(terminal._core.coreMouseService.activeEncoding, 'SGR');
  assert.equal(terminal._core._bufferService.buffer.scrollTop, 1);
  assert.equal(terminal._core._bufferService.buffer.scrollBottom, 7);
  assert.doesNotMatch(frame.data, /\x1b\][0-9]*;|\x1b\[[0-9;?]*[cn]/);
  await write(terminal, '\x1b[?1049l');
  assert.ok(lines(terminal.buffer.active).includes('shell'));
  terminal.dispose(); await snapshot.dispose();
});

test('queued snapshot is an exact boundary before subsequent output and resize', async () => {
  const snapshot = new TerminalSnapshot(80, 24);
  const events = [];
  snapshot.write('BEFORE');
  const captured = snapshot.snapshot(frame => events.push(frame));
  snapshot.write('AFTER', () => events.push('live'));
  snapshot.resize(100, 30);
  await captured; await snapshot.pending;
  assert.match(events[0].data, /BEFORE/);
  assert.doesNotMatch(events[0].data, /AFTER/);
  assert.equal(events[0].cols, 80);
  assert.equal(events[1], 'live');
  assert.equal(snapshot.terminal.cols, 100);
  await snapshot.dispose();
});

test('archive pages are chronological, immutable, bounded, and strip controls before slicing', () => {
  const raw = Array.from({ length: 1200 }, (_, i) => `\x1b[31m${i} 中文\x1b[0m\r\n`).join('') + '\x1b]52;c;secret\x1b\\END';
  const archive = createHistoryArchive(raw);
  const pages = [];
  let meta = archive.metadata();
  while (meta.hasMore) {
    const page = archive.page({ ...meta, requestId: 'r' });
    assert.ok(Buffer.byteLength(page.data) <= PAGE_BYTES);
    assert.ok(page.data.split('\n').filter(Boolean).length <= 500);
    assert.doesNotMatch(page.data, /[\x00-\x08\x0b-\x1f\x7f-\x9f]|secret/);
    assert.ok(page.before < meta.before);
    pages.unshift(page.data); meta = page;
  }
  assert.equal(pages.join(''), archiveText(raw));
  assert.equal(archive.page({ ...meta, requestId: 'r' }).error, 'INVALID_HISTORY_REQUEST');
});

test('long Unicode archive lines obey byte caps and retry/reopen returns identical pages', () => {
  const raw = '😀'.repeat(PAGE_BYTES) + '\x1b]52;c;' + 'secret'.repeat(PAGE_BYTES) + '\x07tail';
  const archive = createHistoryArchive(raw);
  const meta = archive.metadata();
  assert.equal(archive.page({ ...meta, id: 'foreign', requestId: 'r' }).error, 'INVALID_HISTORY_REQUEST');
  const page = archive.page({ ...meta, requestId: 'r' });
  assert.ok(Buffer.byteLength(page.data) <= PAGE_BYTES);
  assert.ok(!page.data.includes('\ufffd'));
  assert.equal(archive.page({ ...meta, requestId: 'repeat' }).data, page.data);
  assert.equal(archive.page({ ...meta, before: meta.before - 1, requestId: 'invalid' }).error, 'INVALID_HISTORY_REQUEST');
  assert.doesNotMatch(page.data, /secret|52;c/);
});

test('reconnect in a split ANSI command resumes color and never executes historical OSC 52', async () => {
  const snapshot = new TerminalSnapshot(40, 10);
  await snapshot.write('hello\x1b[3');
  const { terminal } = await replay(snapshot);
  await snapshot.write('1mRED'); await write(terminal, '1mRED');
  assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
  assert.equal(terminal.buffer.active.getLine(0).getCell(5).getFgColor(), 1);
  await snapshot.write('\x1b]52;c;Y2xpcG');
  const resumed = await replay(snapshot);
  let clipboard = 0;
  resumed.terminal.parser.registerOscHandler(52, () => { clipboard++; return true; });
  await snapshot.write('JvYXJk\x07AFTER'); await write(resumed.terminal, 'JvYXJk\x07AFTER');
  assert.deepEqual(lines(resumed.terminal.buffer.active), lines(snapshot.terminal.buffer.active));
  assert.equal(clipboard, 0);
  terminal.dispose(); resumed.terminal.dispose(); await snapshot.dispose();
});

test('rate limits repeated archive requests without disabling later retry', () => {
  const archive = createHistoryArchive('retained');
  const request = { ...archive.metadata(), requestId: 'r' };
  for (let i = 0; i < 32; i++) assert.equal(archive.page(request).data, 'retained');
  assert.equal(archive.page(request).error, 'HISTORY_RATE_LIMIT');
});

test('scroll margin restoration preserves pending right-edge wrap for ASCII and wide glyphs', async () => {
  for (const line of ['abcdefghij', '中文中文中']) {
    const snapshot = new TerminalSnapshot(10, 5);
    await snapshot.write('\x1b[2;4r\x1b[31m' + line + '\x1b[32m');
    const { terminal } = await replay(snapshot);
    assert.equal(terminal.buffer.active.cursorX, 10);
    assert.equal(terminal.buffer.active.getLine(0).getCell(8).getFgColor(), 1);
    await snapshot.write('Z'); await write(terminal, 'Z');
    assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
    assert.equal(terminal.buffer.active.getLine(1).getCell(0).getFgColor(), 2);
    terminal.dispose(); await snapshot.dispose();
  }
});

test('snapshot restores saved cursor and rendition for DECSC/DECRC and CSI s/u', async () => {
  for (const [save, restore] of [['\x1b7', '\x1b8'], ['\x1b[s', '\x1b[u']]) {
    for (const alternate of [false, true]) {
      const snapshot = new TerminalSnapshot(10, 5);
      await snapshot.write('\x1b[31mnormal' + save + (alternate ? '\x1b[?1049h' : '') + 'hello\x1b[32m' + save + '\x1b[34m\x1b[3;1Hstatus');
      const { terminal } = await replay(snapshot);
      await snapshot.write(restore + 'X'); await write(terminal, restore + 'X');
      assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
      const a = terminal.buffer.active, b = snapshot.terminal.buffer.active;
      assert.equal(a.getLine(a.cursorY).getCell(a.cursorX - 1).getFgColor(), b.getLine(b.cursorY).getCell(b.cursorX - 1).getFgColor());
      if (alternate) {
        await snapshot.write('\x1b[?1049lY'); await write(terminal, '\x1b[?1049lY');
        assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
      }
      terminal.dispose(); await snapshot.dispose();
    }
  }
});

test('alternate snapshot starts with default SGR independently of active cursor rendition', async () => {
  const snapshot = new TerminalSnapshot(10, 5);
  await snapshot.write('\x1b[31mnormal\x1b[?1049h\x1b[0mhello\x1b[32m');
  const { terminal } = await replay(snapshot);
  const source = snapshot.terminal.buffer.active;
  const target = terminal.buffer.active;
  for (let row = 0; row < source.length; row++) {
    for (let col = 0; col < 10; col++) {
      assert.equal(target.getLine(row).getCell(col).getFgColor(), source.getLine(row).getCell(col).getFgColor());
    }
  }
  await snapshot.write('X'); await write(terminal, 'X');
  assert.equal(target.getLine(target.cursorY).getCell(target.cursorX - 1).getFgColor(), 2);
  terminal.dispose(); await snapshot.dispose();
});

test('DEC line drawing continues after replay and saved charset restores independently', async () => {
  for (const initial of ['\x1b(0qq', '\x1b)0\x0eqq']) {
    const snapshot = new TerminalSnapshot(10, 5);
    await snapshot.write(initial);
    const { terminal } = await replay(snapshot);
    await snapshot.write('q'); await write(terminal, 'q');
    assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '───');
    terminal.dispose(); await snapshot.dispose();
  }
  for (const alternate of [false, true]) {
    const snapshot = new TerminalSnapshot(10, 5);
    await snapshot.write((alternate ? '\x1b[?1049h' : '') + '\x1b(0qq\x1b7\x1b(B\x1b[3;1Hstatus');
    const { terminal } = await replay(snapshot);
    await snapshot.write('\x1b8q'); await write(terminal, '\x1b8q');
    assert.deepEqual(lines(terminal.buffer.active), lines(snapshot.terminal.buffer.active));
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '───');
    terminal.dispose(); await snapshot.dispose();
  }
});

// TerminalInputLine.read: does the input line under the cursor already hold typed text? Fake xterm buffers (the xterm 5.5 buffer API) stand for the screens
// of Claude Code, Codex and shells; a few cases go through a real headless xterm to prove the API is used the way xterm provides it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { read } = require('../public/js/terminal-input-line');

const CLAUDE = '❯';
const CODEX = '›';
const RULE = '─'.repeat(40);

// A row is a string with optional styled parts: [[d:dim text]], [[i:inverse text]], [[g:palette color 8 text]].
function parseRow(text, cols) {
  const cells = [];
  const pattern = /\[\[([dig]):([^\]]*)\]\]|([^[]+|\[)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const style = match[1] || '';
    for (const ch of match[2] !== undefined ? match[2] : match[3]) cells.push({ ch, dim: style === 'd', inverse: style === 'i', fg: style === 'g' ? 8 : -1 });
  }
  while (cells.length < cols) cells.push({ ch: '', dim: false, inverse: false, fg: -1 });
  return cells.slice(0, cols);
}
function fakeBuffer(rows, { cursor, wrapped = [], cols = 40, baseY = 0 }) {
  const lines = rows.map((row, y) => {
    const cells = parseRow(row, cols);
    return {
      isWrapped: wrapped.includes(y),
      length: cols,
      getCell: x => {
        const c = cells[x];
        return c && {
          getChars: () => c.ch, getWidth: () => 1, isDim: () => (c.dim ? 1 : 0), isInverse: () => (c.inverse ? 1 : 0),
          isFgPalette: () => c.fg >= 0, getFgColor: () => c.fg,
        };
      },
    };
  });
  return { baseY, cursorY: cursor[1] - baseY, cursorX: cursor[0], length: lines.length, getLine: y => lines[y] };
}

test('Claude Code: an empty box with a dim placeholder is empty', () => {
  // What Claude Code 2.x draws: a rule above and below (borderStyle round without left and right), the pointer, and the placeholder as
  // invert(first letter) + dim(rest).
  const rows = ['previous answer', RULE, `${CLAUDE} [[i:T]][[d:ry "fix lint errors"]]`, RULE, '  [[d:? for shortcuts]]'];
  assert.deepEqual(read(fakeBuffer(rows, { cursor: [2, 2] })), { known: true, hasText: false });
  // The pointer itself is dim while the box is empty: it is still the marker.
  const dimPointer = ['', RULE, `[[d:${CLAUDE}]] [[i:T]][[d:ry "refactor x"]]`, RULE];
  assert.deepEqual(read(fakeBuffer(dimPointer, { cursor: [2, 2] })), { known: true, hasText: false });
  // An empty box without a placeholder, the cursor drawn as an inverse space.
  assert.deepEqual(read(fakeBuffer(['', RULE, `${CLAUDE} [[i: ]]`, RULE], { cursor: [2, 2] })), { known: true, hasText: false });
});

test('Claude Code: typed text in the box counts', () => {
  const rows = ['', RULE, `${CLAUDE} fix the login page[[i: ]]`, RULE, '  [[d:esc to clear]]'];
  assert.deepEqual(read(fakeBuffer(rows, { cursor: [20, 2] })), { known: true, hasText: true });
  // One letter with the caret drawn on it (inverse, nothing dim after it) is text, not a placeholder.
  assert.deepEqual(read(fakeBuffer(['', RULE, `${CLAUDE} [[i:a]]`, RULE], { cursor: [2, 2] })), { known: true, hasText: true });
  // The old boxed layout: a side border, ">" and the right border.
  const boxed = ['╭' + RULE + '╮', `│ > hello                │`, '╰' + RULE + '╯'];
  assert.deepEqual(read(fakeBuffer(boxed, { cursor: [9, 1] })), { known: true, hasText: true });
  const boxedEmpty = ['╭' + RULE + '╮', `│ > [[i:T]][[d:ry "how does x work?"]]   │`, '╰' + RULE + '╯'];
  assert.deepEqual(read(fakeBuffer(boxedEmpty, { cursor: [4, 1] })), { known: true, hasText: false });
});

test('Claude Code: multi-line input is read from its marker row, wherever the cursor is', () => {
  const rows = ['old message', RULE, `${CLAUDE} first line`, '  second line', '  third[[i: ]]', RULE, '  [[d:? for shortcuts]]'];
  assert.deepEqual(read(fakeBuffer(rows, { cursor: [7, 4] })), { known: true, hasText: true }, 'cursor on the last row');
  assert.deepEqual(read(fakeBuffer(rows, { cursor: [2, 3] })), { known: true, hasText: true }, 'cursor on a middle row');
  // Only the first row holds text and the cursor is on an empty row below it.
  const trailing = ['', RULE, `${CLAUDE} text`, '  [[i: ]]', RULE];
  assert.deepEqual(read(fakeBuffer(trailing, { cursor: [2, 3] })), { known: true, hasText: true });
  // The cursor on a later line of the box, the marker row above it holding only text: text below the cursor row is found too.
  const below = ['', RULE, `${CLAUDE} [[i: ]]`, '  later text', RULE];
  assert.deepEqual(read(fakeBuffer(below, { cursor: [2, 2] })), { known: true, hasText: true });
  // A user message of the transcript above the box's top border is not part of the input.
  const transcript = [`${CLAUDE} an older prompt`, RULE, '', RULE];
  assert.deepEqual(read(fakeBuffer(transcript, { cursor: [0, 2] })), { known: false, hasText: false });
});

test('Codex: empty with a dim placeholder, and with text', () => {
  const empty = ['> earlier output', '', `${CODEX} [[d:Ask Codex to do anything]]`, '', '  [[d:? for shortcuts]]   [[d:100% context left]]'];
  assert.deepEqual(read(fakeBuffer(empty, { cursor: [2, 2] })), { known: true, hasText: false });
  const filled = ['', '', `${CODEX} write the tests`, '', '  [[d:? for shortcuts]]'];
  assert.deepEqual(read(fakeBuffer(filled, { cursor: [17, 2] })), { known: true, hasText: true });
  // Multi-line Codex input: the cursor on the second row; footer hints below never count.
  const multi = ['', `${CODEX} first`, '  second', '', '  footer text that is not dim'];
  assert.deepEqual(read(fakeBuffer(multi, { cursor: [8, 2] })), { known: true, hasText: true });
  const emptyFooter = ['', `${CODEX} `, '', '  footer text that is not dim'];
  assert.deepEqual(read(fakeBuffer(emptyFooter, { cursor: [2, 1] })), { known: true, hasText: false });
});

test('shells: "$", "%", "#" and starship prompts, empty and with text', () => {
  assert.deepEqual(read(fakeBuffer(['ls', 'a b', 'user@host:~/work$ '], { cursor: [18, 2] })), { known: true, hasText: false });
  assert.deepEqual(read(fakeBuffer(['user@host:~/work$ git status'], { cursor: [28, 0] })), { known: true, hasText: true });
  assert.deepEqual(read(fakeBuffer(['torin@mac t-agent % '], { cursor: [20, 0] })), { known: true, hasText: false });
  assert.deepEqual(read(fakeBuffer(['root@box:/# make'], { cursor: [16, 0] })), { known: true, hasText: true });
  assert.deepEqual(read(fakeBuffer(['~/work on main', `${CLAUDE} `], { cursor: [2, 1] })), { known: true, hasText: false });
  assert.deepEqual(read(fakeBuffer(['~/work on main', `${CLAUDE} npm test`], { cursor: [10, 1] })), { known: true, hasText: true });
  // A zsh-autosuggestions suggestion (palette color 8) is not typed text.
  assert.deepEqual(read(fakeBuffer(['me % [[g:git status]]'], { cursor: [5, 0] })), { known: true, hasText: false });
  // A right prompt (RPROMPT) at the end of the row is not typed text.
  const rprompt = 'me % ' + ' '.repeat(25) + '[main 12:00]';
  assert.equal(rprompt.length, 42);
  assert.deepEqual(read(fakeBuffer([rprompt.slice(0, 40)], { cursor: [5, 0] })), { known: true, hasText: false });
  // Typed text that reaches the last column is still text.
  assert.deepEqual(read(fakeBuffer(['me % ' + 'x'.repeat(35)], { cursor: [39, 0] })), { known: true, hasText: true });
});

test('a long line that wraps is one line', () => {
  const rows = ['user@host:~$ echo aaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaa'];
  assert.deepEqual(read(fakeBuffer(rows, { cursor: [7, 1], wrapped: [1] })), { known: true, hasText: true }, 'the cursor on the wrapped row');
  // The prompt alone fills the first row and the cursor sits on the wrapped row: still empty.
  const longPrompt = ['/a/very/long/working/directory/name/here', '$ '];
  assert.deepEqual(read(fakeBuffer(longPrompt, { cursor: [2, 1], wrapped: [1] })), { known: true, hasText: false });
  // Without the wrap flag, the second row is a row of its own without a marker.
  assert.deepEqual(read(fakeBuffer(['user@host:~$ echo', 'aaaaaaa'], { cursor: [7, 1] })), { known: false, hasText: false });
});

test('no marker, a border or no buffer gives "unknown", which the page treats as empty', () => {
  assert.deepEqual(read(fakeBuffer(['some output', 'more output'], { cursor: [0, 1] })), { known: false, hasText: false });
  assert.deepEqual(read(fakeBuffer(['', RULE], { cursor: [3, 1] })), { known: false, hasText: false });
  assert.deepEqual(read(null), { known: false, hasText: false });
  assert.deepEqual(read({}), { known: false, hasText: false });
  // A blockquote line of output starting with ">" is not taken as a prompt above the cursor.
  assert.deepEqual(read(fakeBuffer(['> quoted text', 'output'], { cursor: [0, 1] })), { known: false, hasText: false });
});

test('scrollback: the cursor row is baseY + cursorY', () => {
  const rows = ['me % old command', 'output', 'me % '];
  assert.deepEqual(read(fakeBuffer(rows, { cursor: [5, 2], baseY: 1 })), { known: true, hasText: false });
});

// The same rules on a real xterm screen (the headless build of the xterm the page loads), written with real escape sequences.
async function realScreen(data, { cols = 40, rows = 8 } = {}) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 });
  await new Promise(resolve => term.write(data, resolve));
  return term;
}
test('a real xterm screen: dim placeholder, inverse cursor, wrap and scrollback', async () => {
  const rule = '─'.repeat(30);
  let term = await realScreen(`${rule}\r\n${CLAUDE} \x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[22m\r\n${rule}\r\n\x1b[2;3H`);
  assert.deepEqual(read(term.buffer.active), { known: true, hasText: false }, 'Claude Code placeholder');
  term.dispose();
  term = await realScreen(`${rule}\r\n${CLAUDE} hello\x1b[7m \x1b[27m\r\n${rule}\r\n\x1b[2;8H`);
  assert.deepEqual(read(term.buffer.active), { known: true, hasText: true }, 'Claude Code with text');
  term.dispose();
  term = await realScreen(`me % \x1b[90mgit status\x1b[39m\x1b[1;6H`);
  assert.deepEqual(read(term.buffer.active), { known: true, hasText: false }, 'a bright black suggestion (SGR 90 is palette color 8)');
  term.dispose();
  term = await realScreen(`me % ${'y'.repeat(50)}`, { cols: 40 });
  assert.equal(term.buffer.active.getLine(1).isWrapped, true);
  assert.deepEqual(read(term.buffer.active), { known: true, hasText: true }, 'a soft-wrapped line');
  term.dispose();
  term = await realScreen(`${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\r\n')}\r\nme % `, { rows: 5 });
  assert.ok(term.buffer.active.baseY > 0, 'the screen has scrolled');
  assert.deepEqual(read(term.buffer.active), { known: true, hasText: false }, 'after scrolling');
  term.dispose();
  term = await realScreen(`${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\r\n')}\r\nme % ls`, { rows: 5 });
  assert.deepEqual(read(term.buffer.active), { known: true, hasText: true }, 'after scrolling, with text');
  term.dispose();
});

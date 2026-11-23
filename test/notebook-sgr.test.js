// The SGR renderer of the shell notebook's output (scripts/notebook/sgr.mjs, "Output" in docs/design/shell-notebook-page.md): 16, 256 and truecolour
// colours in both parameter forms, bold / dim / italic / underline / inverse and their resets, the style carried from line to line, other escapes
// dropped, and the window of the last 200 lines.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/notebook/sgr.mjs');
const ESC = '\u001b';

test('a line without escapes is one plain run; an empty line has none', async () => {
  const { parseLine, isPlain } = await load();
  const { runs, end } = parseLine('hello world');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'hello world');
  assert.ok(isPlain(runs[0].style));
  assert.ok(isPlain(end));
  assert.deepEqual(parseLine('').runs, []);
});

test('16 colours, bright colours, backgrounds and the resets', async () => {
  const { parseLine } = await load();
  const { runs } = parseLine(`${ESC}[31mred${ESC}[0m plain ${ESC}[92;44mgreen on blue${ESC}[39mdefault fg${ESC}[49m none`);
  assert.deepEqual(runs.map(run => run.text), ['red', ' plain ', 'green on blue', 'default fg', ' none']);
  assert.equal(runs[0].style.fg, '#cc0000');
  assert.equal(runs[1].style.fg, null);
  assert.equal(runs[2].style.fg, '#8ae234');
  assert.equal(runs[2].style.bg, '#3465a4');
  assert.equal(runs[3].style.fg, null);
  assert.equal(runs[3].style.bg, '#3465a4');
  assert.equal(runs[4].style.bg, null);
  assert.equal(parseLine(`${ESC}[101mx`).runs[0].style.bg, '#ef2929', 'bright background');
  assert.equal(parseLine(`${ESC}[mx`).runs[0].style.fg, null, 'ESC[m is a reset');
});

test('256 colours and truecolour, with ; and : separators', async () => {
  const { parseLine, color256 } = await load();
  assert.equal(color256(1), '#cc0000');
  assert.equal(color256(16), '#000000');
  assert.equal(color256(196), '#ff0000');
  assert.equal(color256(231), '#ffffff');
  assert.equal(color256(232), '#080808');
  assert.equal(color256(255), '#eeeeee');
  assert.equal(color256(256), null);
  assert.equal(parseLine(`${ESC}[38;5;208mx`).runs[0].style.fg, '#ff8700');
  assert.equal(parseLine(`${ESC}[48;5;22mx`).runs[0].style.bg, '#005f00');
  assert.equal(parseLine(`${ESC}[38;2;10;20;30mx`).runs[0].style.fg, '#0a141e');
  assert.equal(parseLine(`${ESC}[48;2;255;128;0mx`).runs[0].style.bg, '#ff8000');
  assert.equal(parseLine(`${ESC}[38:5:208mx`).runs[0].style.fg, '#ff8700');
  assert.equal(parseLine(`${ESC}[38:2::10:20:30mx`).runs[0].style.fg, '#0a141e', 'with the empty colour space id');
  assert.equal(parseLine(`${ESC}[38:2:10:20:30mx`).runs[0].style.fg, '#0a141e', 'without it');
  // The parameters after an extended colour are still read.
  const after = parseLine(`${ESC}[38;5;208;1mx`).runs[0].style;
  assert.equal(after.fg, '#ff8700');
  assert.equal(after.bold, true);
  assert.equal(parseLine(`${ESC}[38;2;300;0;0mx`).runs[0].style.fg, null, 'an out-of-range value is ignored');
});

test('bold, dim, italic, underline, inverse and their own resets', async () => {
  const { parseLine } = await load();
  const runs = parseLine(`${ESC}[1;2;3;4;7mall${ESC}[22mnot bold${ESC}[23;24mplain shape${ESC}[27mnot inverse`).runs;
  assert.deepEqual(runs[0].style, { fg: null, bg: null, bold: true, dim: true, italic: true, underline: true, inverse: true });
  assert.equal(runs[1].style.bold, false);
  assert.equal(runs[1].style.dim, false);
  assert.equal(runs[2].style.italic, false);
  assert.equal(runs[2].style.underline, false);
  assert.equal(runs[3].style.inverse, false);
  assert.equal(parseLine(`${ESC}[4:0mx`).runs[0].style.underline, false, '4:0 is no underline');
  assert.equal(parseLine(`${ESC}[4:3mx`).runs[0].style.underline, true, 'a curly underline is drawn as an underline');
});

test('the CSS of a style, inverse swapping the colours (the defaults too)', async () => {
  const { styleCss, plainStyle, DEFAULT_BG } = await load();
  assert.deepEqual(styleCss(plainStyle()), {});
  assert.deepEqual(styleCss({ ...plainStyle(), fg: '#cc0000', bold: true, italic: true, underline: true, dim: true }),
    { color: '#cc0000', fontWeight: '700', fontStyle: 'italic', textDecoration: 'underline', opacity: '0.6' });
  assert.deepEqual(styleCss({ ...plainStyle(), fg: '#cc0000', bg: '#3465a4', inverse: true }), { color: '#3465a4', backgroundColor: '#cc0000' });
  assert.deepEqual(styleCss({ ...plainStyle(), inverse: true }), { color: DEFAULT_BG, backgroundColor: '#e0e0e0' });
});

test('the style carries over to the next line, as in a terminal', async () => {
  const { parseLine, styleAfter } = await load();
  const lines = [`${ESC}[32mgreen starts`, 'still green', `${ESC}[0mplain`, 'plain too'];
  const first = parseLine(lines[0]);
  const second = parseLine(lines[1], first.end);
  assert.equal(second.runs[0].style.fg, '#4e9a06');
  assert.equal(styleAfter(lines, 0, 1).fg, '#4e9a06');
  assert.equal(styleAfter(lines, 0, 2).fg, '#4e9a06');
  assert.equal(styleAfter(lines, 0, 3).fg, null);
  assert.equal(styleAfter(lines, 1, 2, first.end).fg, '#4e9a06', 'from a known style part way');
});

test('text is never markup, and leftover escapes lose their ESC', async () => {
  const { parseLine, stripSgr } = await load();
  const { runs } = parseLine(`<img src=x onerror=alert(1)> ${ESC}]0;title${ESC}\\ ${ESC}[2Kgone`);
  const text = runs.map(run => run.text).join('');
  assert.ok(text.startsWith('<img src=x onerror=alert(1)> '), 'the text is kept as text (the view uses textContent)');
  assert.ok(!text.includes(ESC), 'no ESC reaches the page');
  assert.equal(stripSgr(`${ESC}[1;31merror${ESC}[0m: boom`), 'error: boom');
});

test('the output window: the last 200 lines, all of them on Show all, the dropped lines counted', async () => {
  const { outputWindow, WINDOW_LINES } = await load();
  assert.equal(WINDOW_LINES, 200);
  assert.deepEqual(outputWindow(50), { start: 0, end: 50, total: 50, shown: 50, windowed: false, dropped: 0 });
  assert.deepEqual(outputWindow(200), { start: 0, end: 200, total: 200, shown: 200, windowed: false, dropped: 0 });
  assert.deepEqual(outputWindow(10000, 2408), { start: 9800, end: 10000, total: 12408, shown: 200, windowed: true, dropped: 2408 });
  assert.deepEqual(outputWindow(10000, 2408, true), { start: 0, end: 10000, total: 12408, shown: 10000, windowed: true, dropped: 2408 });
  assert.deepEqual(outputWindow(0), { start: 0, end: 0, total: 0, shown: 0, windowed: false, dropped: 0 });
});

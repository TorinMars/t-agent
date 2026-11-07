const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/terminal-viewport.js'), 'utf8') + '\nthis.viewport = TerminalViewport;', context);
const viewport = context.viewport;
function setup(y = 100) {
  const buffer = { type: 'normal', baseY: 100, viewportY: y, cursorY: 10 };
  const marker = { line: y, dispose() { this.isDisposed = true; } };
  const term = { buffer: { active: buffer }, cols: 80, rows: 24,
    scrollToBottom() { buffer.viewportY = buffer.baseY; }, scrollToLine(y) { buffer.viewportY = y; }, registerMarker() { return marker; } };
  let fits = 0;
  term.resize = (cols, rows) => { fits++; term.cols = cols; term.rows = rows; buffer.baseY = 112; buffer.viewportY = 0; marker.line += 3; };
  const addon = { proposeDimensions: () => ({ cols: 80, rows: 12 }) };
  return { term, addon, marker, buffer, fits: () => fits };
}
test('keyboard resize keeps bottom followers at the live output', () => {
  const s = setup(); viewport.fit(s.term, s.addon, { clientWidth: 300, clientHeight: 200 });
  assert.equal(s.buffer.viewportY, 112);
});
test('resize preserves a reader anchor instead of jumping to the top or bottom', () => {
  const s = setup(40); viewport.fit(s.term, s.addon, { clientWidth: 300, clientHeight: 200 });
  assert.equal(s.buffer.viewportY, 43);
  assert.ok(s.marker.isDisposed);
});
test('hidden terminals and redundant resize notifications do not trigger fit', () => {
  const s = setup(); viewport.fit(s.term, s.addon, { clientWidth: 0, clientHeight: 0 });
  s.addon.proposeDimensions = () => ({ cols: 80, rows: 24 });
  viewport.fit(s.term, s.addon, { clientWidth: 300, clientHeight: 200 });
  assert.equal(s.fits(), 0);
});
test('history replay restores reading distance and leaves alternate screens alone', () => {
  const s = setup(40); const saved = viewport.capture(s.term);
  s.buffer.baseY = 200; s.buffer.viewportY = 0;
  viewport.restore(s.term, saved); assert.equal(s.buffer.viewportY, 140);
  s.buffer.type = 'alternate'; viewport.restore(s.term, { bottom: true });
  assert.equal(s.buffer.viewportY, 140);
});

// A host whose viewport has the given scrollbar room (offsetWidth - clientWidth) and a term whose measured glyph width is `cell`.
function sized(width, scrollbar, cell = 6.62255859375) {
  const s = setup();
  s.term._core = { _charSizeService: { width: cell } };
  s.term.options = { scrollback: 5000 };
  const viewport = { offsetWidth: width, clientWidth: width - scrollbar };
  s.host = { clientWidth: width, clientHeight: 200, getBoundingClientRect: () => ({ width }), querySelector: selector => selector === '.xterm-viewport' ? viewport : null };
  return s;
}
test('an overlay scrollbar takes no columns, although FitAddon would take off its 15px fallback', () => {
  const s = sized(404, 0);
  s.addon.proposeDimensions = () => ({ cols: Math.floor((404 - 15) / 6.62255859375), rows: 12 }); // what xterm 5.5 + FitAddon propose: 58
  viewport.fit(s.term, s.addon, s.host);
  assert.equal(s.term.cols, 61); // round(61 * 6.6226) = 404 fits
  assert.equal(s.term.rows, 12);
});
test('a classic scrollbar keeps its live room, also when it changed after start', () => {
  const s = sized(160, 40, 2);
  viewport.fit(s.term, s.addon, s.host);
  assert.equal(s.term.cols, 60);
});
test('one column less when the rounded screen would pass the edge, and no flip on a width just short of a pixel', () => {
  assert.equal(viewport.columns(sized(403.6, 0).term, sized(403.6, 0).host), 60); // round(61 * 6.6226) = 404 > 403.6
  const s = sized(403.99997, 0);
  assert.equal(viewport.columns(s.term, s.host), 61);
});
test('without xterm internals the drawn screen gives the cell width', () => {
  const s = setup();
  s.term.options = { scrollback: 5000 };
  const host = { clientWidth: 160, clientHeight: 200, querySelector: selector => selector === '.xterm-viewport' ? { offsetWidth: 160, clientWidth: 120 } : { clientWidth: 160 } };
  viewport.fit(s.term, s.addon, host);
  assert.equal(s.term.cols, 60); // cell 160 / 80 = 2, 120px visible
  assert.equal(s.term.rows, 12);
});

test('keyboard shift keeps a cursor near the top visible and a bottom cursor fully shifted', () => {
  const term = { rows: 20, buffer: { active: { cursorY: 0 } } };
  assert.equal(viewport.keyboardShift(term, 400, 150), 4);
  term.buffer.active.cursorY = 3;
  assert.equal(viewport.keyboardShift(term, 400, 150), 64);
  term.buffer.active.cursorY = 18;
  assert.equal(viewport.keyboardShift(term, 400, 150), 150);
  assert.equal(viewport.keyboardShift(term, 400, 0), 0);
  assert.equal(viewport.keyboardShift(term, 0, 150), 150);
});

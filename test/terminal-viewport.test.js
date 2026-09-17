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

test('actual viewport width clamps columns when cached scrollbar width is stale', () => {
  const s = setup();
  viewport.fit(s.term, s.addon, { clientWidth: 160, clientHeight: 200,
    querySelector: selector => ({ clientWidth: selector === '.xterm-screen' ? 160 : 120 }) });
  assert.equal(s.term.cols, 59);
  assert.equal(s.term.rows, 12);
});

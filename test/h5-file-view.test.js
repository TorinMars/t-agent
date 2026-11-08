// The file sheet's plain-text window and the relative image paths of its Markdown view (scripts/h5-shell/file-view.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');

test('only the lines in view and a buffer around them are drawn', async () => {
  const { visibleRange, BUFFER } = await import('../scripts/h5-shell/file-view.mjs');
  assert.deepEqual(visibleRange(0, 600, 20, 100000), [0, 30 + BUFFER]);
  assert.deepEqual(visibleRange(20000, 600, 20, 100000), [1000 - BUFFER, 1030 + BUFFER]);
  assert.deepEqual(visibleRange(1e9, 600, 20, 100), [100, 100], 'past the end: nothing');
  assert.deepEqual(visibleRange(0, 600, 20, 10), [0, 10], 'a short file is drawn whole');
  const [first, end] = visibleRange(123456, 900, 19.2, 300000);
  assert.ok(end - first <= 47 + 2 * BUFFER + 1, 'bounded by the view, not by the file');
});

test('lines are split on every line end, without an empty last line', async () => {
  const { splitLines } = await import('../scripts/h5-shell/file-view.mjs');
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines('\u4e2d\u6587\n'), ['\u4e2d\u6587'], 'any script');
});

test('relative image paths resolve from the folder of the document and never leave the working directory', async () => {
  const { imagePath } = await import('../scripts/h5-shell/file-view.mjs');
  assert.equal(imagePath('DESIGN.md', 'img/a.png'), 'img/a.png');
  assert.equal(imagePath('docs/guide/readme.md', '../shots/b%20c.JPG?x=1#top'), 'docs/shots/b c.JPG');
  assert.equal(imagePath('docs/readme.md', './a.webp'), 'docs/a.webp');
  assert.equal(imagePath('docs/readme.md', '../../etc/x.png'), null, 'outside the working directory');
  assert.equal(imagePath('readme.md', '/abs/x.png'), null, 'absolute');
  assert.equal(imagePath('readme.md', 'file:///x.png'), null);
  assert.equal(imagePath('readme.md', '//host/x.png'), null);
  assert.equal(imagePath('readme.md', 'logo.svg'), 'logo.svg', 'SVG too (only ever shown through <img>, so its scripts never run)');
  assert.equal(imagePath('readme.md', 'a.avif'), 'a.avif');
  assert.equal(imagePath('readme.md', 'a.ICO'), 'a.ICO');
  assert.equal(imagePath('readme.md', 'movie.mp4'), null, 'images only');
  assert.equal(imagePath('readme.md', 'notes.txt'), null);
  assert.equal(imagePath('readme.md', '%E0%A4%A.png'), null, 'broken escape');
  assert.equal(imagePath('readme.md', '\u56fe/\u622a\u56fe.png'), '\u56fe/\u622a\u56fe.png', 'Chinese names');
});

// The outline of the design document sheet (scripts/h5-shell/outline.mjs): heading slugs in any language, unique ids and the section being read.
// Chinese headings are written with \u escapes (see test/i18n.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const DESIGN = '\u8bbe\u8ba1'; // "design" in Chinese
const OVERVIEW = '\u6982\u89c8'; // "overview" in Chinese

test('slugs keep letters and digits of every script', async () => {
  const { slugify } = await import('../scripts/h5-shell/outline.mjs');
  assert.equal(slugify('1. Goals & Non-goals'), '1-goals-non-goals');
  assert.equal(slugify(`  ${DESIGN} ${OVERVIEW}\uff08v2\uff09`), `${DESIGN}-${OVERVIEW}v2`);
  assert.equal(slugify('Caf\u00e9 \u00fcber'), 'caf\u00e9-\u00fcber');
  assert.equal(slugify('\u041f\u043b\u0430\u043d'), '\u043f\u043b\u0430\u043d');
  assert.equal(slugify('snake_case -- name'), 'snake-case-name');
  assert.equal(slugify('!!!'), 'section', 'nothing left: a fixed word');
  assert.equal(slugify(''), 'section');
});

test('ids are unique in document order and carry the prefix', async () => {
  const { uniqueIds, ID_PREFIX } = await import('../scripts/h5-shell/outline.mjs');
  assert.equal(ID_PREFIX, 'h5-doc-');
  assert.deepEqual(uniqueIds(['Notes', 'Notes', 'Notes 1', 'Notes', DESIGN, DESIGN, '?']),
    ['h5-doc-notes', 'h5-doc-notes-1', 'h5-doc-notes-1-1', 'h5-doc-notes-2', `h5-doc-${DESIGN}`, `h5-doc-${DESIGN}-1`, 'h5-doc-section']);
  assert.deepEqual(uniqueIds(['Notes 1', 'Notes', 'Notes']), ['h5-doc-notes-1', 'h5-doc-notes', 'h5-doc-notes-2'], 'a suffix already taken is skipped');
});

test('the section being read is the last heading above the line', async () => {
  const { currentIndex } = await import('../scripts/h5-shell/outline.mjs');
  assert.equal(currentIndex([], 40), -1);
  assert.equal(currentIndex([100, 500, 900], 40), 0, 'before the first heading: the first');
  assert.equal(currentIndex([-300, 20, 600], 40), 1);
  assert.equal(currentIndex([-900, -500, -100], 40), 2);
  assert.equal(currentIndex([-900, 40, 41], 40), 1, 'a heading exactly on the line counts');
});

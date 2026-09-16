const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Mermaid modal zoom has no fixed maximum scale', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tasks.js'), 'utf8');
  const start = source.indexOf('function openMermaidModal');
  const end = source.indexOf('function closeMermaidModal', start);
  const modal = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(modal, /Math\.min\s*\(\s*8\s*,/);
  assert.match(modal, /zoomAt\(scale \* factor, e\.clientX, e\.clientY\)/);
  assert.match(modal, /zoomAt\(scale \* dist \/ lastTouchDist, lastTouchMidX, lastTouchMidY\)/);
  assert.match(modal, /Math\.max\(0\.2, nextScale\)/);
});

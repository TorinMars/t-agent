'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('desktop sidebar tasks have no selected style', () => {
  for (const file of ['public/css/style.css', 'public/css/themes.css']) {
    const css = read(file);
    assert.doesNotMatch(css, /\.task-nav-item\.active/, `${file} styles the active task`);
    assert.doesNotMatch(css, /\.task-nav-item:not\(\.active\)/, `${file} dims tasks that are not active`);
  }
  assert.match(read('public/css/style.css'), /\.task-nav-item:hover\s*\{/, 'hover feedback is kept');
});

test('phone task list does not paint the open task as selected', () => {
  const jsx = read('scripts/h5-shell/TaskDrawer.jsx');
  assert.doesNotMatch(jsx, /task\.selected\s*\?\s*'action\.selected'/);
  assert.doesNotMatch(jsx, /className="h5-task-item"[^\n]*\sselected=/);
  assert.match(jsx, /className="h5-task-item"[^\n]*aria-current/, 'aria-current stays as a hook');
});

test('desktop sidebar keeps the active class as a script hook', () => {
  assert.match(read('public/js/tasks.js'), /task-nav-item\$\{task\.id === selectedId \? ' active' : ''\}/);
});

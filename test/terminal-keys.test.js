const test = require('node:test');
const assert = require('node:assert/strict');
const { encode } = require('../public/js/terminal-keys');
test('terminal keys encode escape, navigation and Option+Up', () => {
  assert.equal(encode('Escape'), '\x1b');
  assert.equal(encode('ArrowUp'), '\x1b[A');
  assert.equal(encode('ArrowUp', {alt:true}), '\x1b[1;3A');
  assert.equal(encode('ArrowUp', {alt:true,ctrl:true}), '\x1b[1;7A');
  assert.equal(encode('Tab', {shift:true}), '\x1b[Z');
});
test('modifier combinations encode control characters and Command', () => {
  assert.equal(encode('c', {ctrl:true}), '\x03');
  assert.equal(encode('c', {ctrl:true,alt:true}), '\x1b\x03');
  assert.equal(encode(' ', {ctrl:true}), '\x00');
  assert.equal(encode('a', {meta:true}), '\x1b[97;9u');
  assert.equal(encode('ArrowUp', {meta:true,shift:true}), '\x1b[1;10A');
  assert.equal(encode('a', {shift:true}), 'A');
  assert.equal(encode('Unidentified'), null);
});

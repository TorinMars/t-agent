const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const TerminalOwner = require('../public/js/terminal-owner.js');

test('the client id is stable and the query only asks for a takeover on request', () => {
  const id = TerminalOwner.clientId();
  assert.equal(TerminalOwner.clientId(), id);
  assert.equal(TerminalOwner.query(false), `&clientId=${encodeURIComponent(id)}`);
  assert.equal(TerminalOwner.query(true), `&clientId=${encodeURIComponent(id)}&takeover=1`);
});

test('only the in-use and taken-over close codes show the prompt', () => {
  assert.deepEqual([4009, 4010, 1000, 1006, 1008].map(TerminalOwner.isBlocked), [true, true, false, false, false]);
});

test('the prompt explains why and its button takes the terminal over once', () => {
  const { document } = parseHTML('<div id="host"></div>');
  const host = document.getElementById('host');
  let taken = 0;
  TerminalOwner.prompt(host, TerminalOwner.IN_USE, () => { taken += 1; });
  TerminalOwner.prompt(host, TerminalOwner.TAKEN, () => { taken += 1; });
  assert.equal(host.querySelectorAll('.terminal-owner-prompt').length, 1, 'a new prompt replaces the old one');
  assert.match(host.textContent, /used by another device/);
  assert.equal(taken, 0, 'nothing is taken without a click');
  host.querySelector('button').click();
  assert.equal(taken, 1);
  assert.equal(host.querySelector('.terminal-owner-prompt'), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareTerminalHistoryBuffer } = require('../lib/terminal-history');

test('replays terminal history without changing its final cursor row', () => {
  const history = 'prompt> codex\x1b[2;1Hinput';
  assert.equal(prepareTerminalHistoryBuffer(history), history);
  assert.equal(prepareTerminalHistoryBuffer(history).endsWith('\r\n'), false);
});

test('preserves full-screen and cursor modes while removing terminal queries', () => {
  const history = [
    '\x1b[?1049h', // alternate screen
    '\x1b[?25l',   // hide cursor
    '\x1b[c',      // device attributes query
    '\x1b[6n',     // cursor position query
    'Codex',
    '\x1b[?25h',   // show cursor
  ].join('');

  assert.equal(
    prepareTerminalHistoryBuffer(history),
    '\x1b[?1049h\x1b[?25lCodex\x1b[?25h',
  );
});

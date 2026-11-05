const test = require('node:test');
const assert = require('node:assert/strict');
const { logUpdate, recentLog, clearLog } = require('../lib/update-command');

test('Update log: records by line, hides credentials, keeps only the latest lines, and can be cleared before a new round starts', () => {
  const original = console.log;
  console.log = () => {};
  try {
    clearLog();
    logUpdate('installing', 'stdout: added 1 package\nstdout: https://user:secret@example.com/x');
    const lines = recentLog();
    assert.equal(lines.length, 2);
    assert.equal(lines[0].stage, 'installing');
    assert.match(lines[1].text, /\[redacted\]@/);
    assert.doesNotMatch(JSON.stringify(lines), /secret/);
    for (let index = 0; index < 400; index += 1) logUpdate('x', `line ${index}`);
    const kept = recentLog();
    assert.equal(kept.length, 300);
    assert.equal(kept[kept.length - 1].text, 'line 399');
    clearLog();
    assert.deepEqual(recentLog(), []);
  } finally { console.log = original; }
});

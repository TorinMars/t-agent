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

test('Update log: a line that is not printed still reaches the buffer the Update dialog reads', () => {
  const original = console.log;
  const printed = [];
  console.log = line => printed.push(line);
  try {
    clearLog();
    logUpdate('installing', 'stderr: npm http fetch GET 200 https://user:secret@registry.npmjs.org/a 12ms', { print: false });
    logUpdate('installing', 'Finished in 12ms');
    assert.deepEqual(recentLog().map(entry => entry.text), ['stderr: npm http fetch GET 200 https://[redacted]@registry.npmjs.org/a 12ms', 'Finished in 12ms']);
    assert.equal(printed.length, 1);
    assert.match(printed[0], /^\[update\] \S+ \[installing\] Finished in 12ms$/);
  } finally { console.log = original; clearLog(); }
});

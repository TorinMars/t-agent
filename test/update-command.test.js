const test = require('node:test');
const assert = require('node:assert/strict');
const { runUpdateCommand, runWithProgress, formatProgress, printable, recentLog, clearLog } = require('../lib/update-command');

test('update commands record every output line for the Update dialog, print only the start, warnings and the end, and redact credentials', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  clearLog();
  const result = await runUpdateCommand(process.execPath, ['-e',
    "process.stdout.write('installed\\n'); process.stderr.write('https://user:secret@example.com token=private\\n'); process.stderr.write('npm warn deprecated https://user:secret@example.com/old\\n');",
  ], {}, { stage: 'installing', errorCode: 'INSTALL_FAILED', streamOutput: true });
  assert.equal(result, 'installed');
  const buffer = recentLog().map(entry => entry.text);
  assert.ok(buffer.includes('stdout: installed'), 'the dialog still gets plain output');
  assert.ok(buffer.includes('stderr: https://[redacted]@example.com token=[redacted]'));
  assert.ok(buffer.includes('stderr: npm warn deprecated https://[redacted]@example.com/old'));
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^\[update\] \S+ \[installing\] Started: /);
  assert.match(lines[1], /\[installing\] stderr: npm warn deprecated https:\/\/\[redacted\]@example\.com\/old$/);
  assert.match(lines[2], /\[installing\] Finished in \d+ms \(2 progress lines not printed\)$/);
  assert.ok([...lines, ...buffer].every(line => !line.includes('secret') && !line.includes('private')));
});

test('printable: npm lines go by their level, other output by whether it reads as a warning or an error', () => {
  const kept = [
    'npm warn deprecated yaeti@0.0.6: Package no longer supported.',
    'npm WARN deprecated yaeti@0.0.6',
    'npm error code ENOTFOUND',
    'npm ERR! network request to https://registry.npmjs.org/x failed',
    'gyp ERR! build error',
    "Error: Cannot find module 'node-pty'",
    'make: *** [Release/obj.target/pty.node] Error 1',
    'warning: unused variable',
    'fatal: unable to access the repository',
    'prebuild-install failed, building from source',
  ];
  const left = [
    'npm http fetch GET 200 https://registry.npmjs.org/express 12ms (cache miss)',
    'npm http fetch GET 200 https://registry.npmjs.org/error-ex 8ms', // the level decides, not a package name
    'npm http fetch GET 200 https://registry.npmjs.org/warning/-/warning-4.0.3.tgz 30ms',
    'npm info run node-pty@1.1.0 install node_modules/node-pty node scripts/prebuild.js',
    'npm verbose cli /usr/local/bin/node',
    'npm sill idealTree buildDeps',
    'npm timing reify:loadTrees Completed in 100ms',
    'npm notice New minor version of npm available!',
    'npm audit fix',
    'added 328 packages, and audited 329 packages in 41s',
    '60 packages are looking for funding',
    'found 0 vulnerabilities',
    'node-pty OK',
    '',
  ];
  for (const line of kept) assert.equal(printable(line), true, line);
  for (const line of left) assert.equal(printable(line), false, line);
});

// The size of the problem: `npm ci` at the http log level prints a line for every download (664 for one update of this project). They were two thirds of
// the PM2 log; the Update dialog still needs them, for its log and for the "last output line" of the progress text.
test('an install as noisy as npm ci prints a handful of lines, while the buffer and onOutput still get every line', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  clearLog();
  const seen = [];
  await runUpdateCommand(process.execPath, ['-e', `
    for (let index = 0; index < 664; index += 1) console.error('npm http fetch GET 200 https://registry.npmjs.org/package-' + index + ' 12ms (cache miss)');
    console.error('npm warn deprecated yaeti@0.0.6: Package no longer supported.');
    console.error('npm warn deprecated prebuild-install@7.1.3: No longer maintained.');
    console.log('added 328 packages, and audited 329 packages in 41s');
    console.log('found 0 vulnerabilities');
  `], {}, { stage: 'installing', errorCode: 'NPM_INSTALLING_FAILED', streamOutput: true, onOutput: line => seen.push(line) });
  assert.equal(seen.length, 668, 'the progress text sees every line, so a stalled download still shows as "no output"');
  assert.equal(seen.filter(line => line.startsWith('npm http fetch')).length, 664);
  assert.equal(lines.length, 4, 'start, two warnings, end');
  assert.match(lines[0], /\[installing\] Started: /);
  assert.equal(lines.filter(line => /\] std(?:out|err): npm http/.test(line)).length, 0);
  assert.equal(lines.filter(line => /\] stderr: npm warn deprecated/.test(line)).length, 2);
  assert.match(lines.at(-1), /Finished in \d+ms \(666 progress lines not printed\)$/);
  const buffer = recentLog();
  assert.equal(buffer.length, 300, 'the dialog keeps its latest 300 lines');
  assert.ok(buffer.filter(entry => entry.text.startsWith('stderr: npm http fetch')).length > 250, 'and they include the download lines');
  assert.match(buffer.at(-1).text, /^Finished in/);
});

test('a quiet command leaves its start and end out of the service log but not out of the buffer; its failure is still printed', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  clearLog();
  assert.equal(await runUpdateCommand(process.execPath, ['-e', "console.log('abc123')"], {}, { stage: 'git:rev-parse', errorCode: 'GIT_REV-PARSE_FAILED', quiet: true }), 'abc123');
  assert.deepEqual(lines, []);
  const buffer = recentLog();
  assert.equal(buffer.length, 2);
  assert.match(buffer[0].text, /^Started: /);
  assert.match(buffer[1].text, /^Finished in \d+ms$/);

  await assert.rejects(runUpdateCommand(process.execPath, ['-e', "console.error('fatal: unable to access'); process.exit(128)"], {}, { stage: 'git:fetch', errorCode: 'GIT_FETCH_FAILED', quiet: true }), /GIT_FETCH_FAILED/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[git:fetch\] Failed after \d+ms: code=128/);
  assert.match(lines[0], /fatal: unable to access/);
});

test('failed commands preserve exit code and diagnostic output', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  await assert.rejects(runUpdateCommand(process.execPath, ['-e',
    "console.error('esbuild: command not found'); process.exit(127);",
  ], {}, { stage: 'building', errorCode: 'NPM_BUILDING_FAILED', streamOutput: true }), error => {
    assert.equal(error.message, 'NPM_BUILDING_FAILED');
    assert.match(error.details, /code=127/);
    assert.match(error.details, /esbuild: command not found/);
    return true;
  });
  assert.ok(lines.at(-1).includes('Failed after'));
});

test('missing executable reports ENOENT even without stdout or stderr', async t => {
  t.mock.method(console, 'log', () => {});
  await assert.rejects(runUpdateCommand('/nonexistent/t-agent-npm', [], {}, {
    stage: 'installing', errorCode: 'NPM_INSTALLING_FAILED',
  }), error => error.message === 'NPM_INSTALLING_FAILED' && /ENOENT/.test(error.details));
});

test('onOutput receives every redacted output line from stdout and stderr', async t => {
  t.mock.method(console, 'log', () => {});
  const seen = [];
  await runUpdateCommand(process.execPath, ['-e',
    "console.log('first'); console.error('npm http fetch GET 200 https://user:secret@registry.npmjs.org/a 12ms'); console.log('last');",
  ], {}, { stage: 'installing', errorCode: 'INSTALL_FAILED', streamOutput: true, onOutput: line => seen.push(line) });
  assert.deepEqual([...seen].sort(), ['first', 'last', 'npm http fetch GET 200 https://[redacted]@registry.npmjs.org/a 12ms'].sort());
});

test('formatProgress shows elapsed time and the last line, and warns when the command goes quiet', () => {
  assert.equal(formatProgress('Installing dependencies', 5_000, '', 5_000), 'Installing dependencies · elapsed 5s · waiting for output');
  assert.equal(formatProgress('Installing dependencies', 83_000, 'http fetch GET 200 x', 2_000), 'Installing dependencies · elapsed 1 min 23s · http fetch GET 200 x');
  const quiet = formatProgress('Installing dependencies', 95_000, 'http fetch GET 200 x', 45_000);
  assert.match(quiet, /no output for 45s; the network may be down/);
  assert.equal(formatProgress('x', 1000, 'a'.repeat(300), 0).length < 140, true, 'long lines are truncated');
});

test('runWithProgress reports progress while the command runs and stops after it finishes or fails', async () => {
  const messages = [];
  let emit;
  const done = runWithProgress('Installing dependencies', onOutput => new Promise(resolve => { emit = onOutput; setTimeout(resolve, 120); }),
    message => messages.push(message), { intervalMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 50));
  emit('http fetch GET 200 pkg');
  await done;
  assert.match(messages[0], /^Installing dependencies · elapsed 0s · waiting for output$/);
  assert.ok(messages.length >= 3, 'ticks while running');
  assert.ok(messages.some(message => message.endsWith('http fetch GET 200 pkg')), 'last output line is shown');
  const count = messages.length;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(messages.length, count, 'no ticks after the command ended');

  const failed = [];
  await assert.rejects(runWithProgress('x', () => Promise.reject(new Error('NPM_INSTALLING_FAILED')), message => failed.push(message), { intervalMs: 20 }), /NPM_INSTALLING_FAILED/);
  const afterFailure = failed.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(failed.length, afterFailure, 'timer is cleared when the command fails');
});

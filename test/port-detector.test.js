const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortDetector, parseLsof, parseSs, parseChildren, descendants, isLoopback } = require('../services/port-detector');

const LSOF = ['p100', 'n*:3000', 'n127.0.0.1:9229', 'p200', 'n[::1]:5173', 'n[::]:5173', 'p300', 'n10.0.0.5:8080', ''].join('\n');
const SS = [
  'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=100,fd=19))',
  'LISTEN 0 128 127.0.0.1:9229 0.0.0.0:* users:(("node",pid=100,fd=20))',
  'LISTEN 0 511 [::]:8080 [::]:* users:(("nginx",pid=300,fd=6),("nginx",pid=301,fd=6))',
  'LISTEN 0 4096 [::1]:631 [::]:*',
].join('\n');
const PS = ['    1     0', '  100     1', '  101   100', '  102   101', '  200     1', '  300     1', 'garbage'].join('\n');

test('Parse lsof / ss listening output, telling local-only listeners apart', () => {
  assert.deepEqual(parseLsof(LSOF), [
    { pid: 100, port: 3000, local_only: false }, { pid: 100, port: 9229, local_only: true },
    { pid: 200, port: 5173, local_only: true }, { pid: 200, port: 5173, local_only: false },
    { pid: 300, port: 8080, local_only: false },
  ]);
  assert.deepEqual(parseSs(SS), [
    { pid: 100, port: 3000, local_only: false }, { pid: 100, port: 9229, local_only: true },
    { pid: 300, port: 8080, local_only: false }, { pid: 301, port: 8080, local_only: false },
  ]);
  assert.equal(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('[::1]'), true);
  assert.equal(isLoopback('0.0.0.0') || isLoopback('*') || isLoopback('10.0.0.5'), false);
});

test('Process tree: includes descendants, limits the count, ignores lines that cannot be parsed', () => {
  const children = parseChildren(PS);
  assert.deepEqual([...descendants(100, children)].sort((a, b) => a - b), [100, 101, 102]);
  assert.deepEqual([...descendants(999, children)], [999]);
});

test('Detect the ports of PM2 processes and their children; a port that listens both on loopback and externally counts as external', async () => {
  const calls = [];
  const exec = (file, args, options, callback) => {
    calls.push(file);
    if (file === 'ps') return callback(null, PS);
    if (file === 'lsof') return callback(null, [LSOF, 'p102', 'n*:7000'].join('\n'));
    callback(new Error('unexpected'));
  };
  const detector = createPortDetector({ exec, cacheMs: 0 });
  const result = await detector.detect([100, 200, 777, 100, 0, -1, 'x']);
  assert.deepEqual(result.get(100), [{ port: 3000, local_only: false }, { port: 7000, local_only: false }, { port: 9229, local_only: true }], 'Port 7000 of descendant process 102 counts under 100');
  assert.deepEqual(result.get(200), [{ port: 5173, local_only: false }]);
  assert.deepEqual(result.get(777), []);
  assert.equal(result.has(0), false);
});

test('Falls back to ss without lsof; returns an empty result instead of an error when neither is available; the result is cached for a short time', async () => {
  const viaSs = createPortDetector({ cacheMs: 0, exec: (file, args, options, callback) => {
    if (file === 'ps') return callback(null, PS);
    if (file === 'ss') return callback(null, SS);
    callback(new Error('ENOENT'));
  } });
  assert.deepEqual((await viaSs.detect([100])).get(100), [{ port: 3000, local_only: false }, { port: 9229, local_only: true }]);

  const none = createPortDetector({ cacheMs: 0, exec: (file, args, options, callback) => callback(new Error('ENOENT')) });
  assert.deepEqual((await none.detect([100])).get(100), []);

  let runs = 0;
  const cached = createPortDetector({ cacheMs: 60_000, exec: (file, args, options, callback) => { runs += 1; callback(null, file === 'ps' ? PS : LSOF); } });
  await cached.detect([100]); const afterFirst = runs;
  await cached.detect([100]);
  assert.equal(runs, afterFirst, 'ps is not run again within the cache period/lsof');
  await cached.detect([100, 200]);
  assert.ok(runs > afterFirst, 'Detect again when the queried processes change');
});

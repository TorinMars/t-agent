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

test('解析 lsof / ss 的监听输出，区分仅本机监听', () => {
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

test('进程树：包含子孙进程，限制数量，忽略无法解析的行', () => {
  const children = parseChildren(PS);
  assert.deepEqual([...descendants(100, children)].sort((a, b) => a - b), [100, 101, 102]);
  assert.deepEqual([...descendants(999, children)], [999]);
});

test('检测 PM2 进程及其子进程的端口；同一端口既有回环又有对外监听时算对外', async () => {
  const calls = [];
  const exec = (file, args, options, callback) => {
    calls.push(file);
    if (file === 'ps') return callback(null, PS);
    if (file === 'lsof') return callback(null, [LSOF, 'p102', 'n*:7000'].join('\n'));
    callback(new Error('unexpected'));
  };
  const detector = createPortDetector({ exec, cacheMs: 0 });
  const result = await detector.detect([100, 200, 777, 100, 0, -1, 'x']);
  assert.deepEqual(result.get(100), [{ port: 3000, local_only: false }, { port: 7000, local_only: false }, { port: 9229, local_only: true }], '子孙进程 102 的 7000 端口算在 100 名下');
  assert.deepEqual(result.get(200), [{ port: 5173, local_only: false }]);
  assert.deepEqual(result.get(777), []);
  assert.equal(result.has(0), false);
});

test('没有 lsof 时改用 ss；两者都不可用时返回空结果而不是报错；结果短时间内缓存', async () => {
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
  assert.equal(runs, afterFirst, '缓存期内不重复执行 ps/lsof');
  await cached.detect([100, 200]);
  assert.ok(runs > afterFirst, '查询的进程变了就重新检测');
});

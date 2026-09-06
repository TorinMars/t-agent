const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('app.js 在业务模块加载前不会立即执行初始化', () => {
  const listeners = new Map();
  const element = { addEventListener() {} };
  const document = {
    readyState: 'loading',
    getElementById() { return element; },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

  assert.doesNotThrow(() => vm.runInNewContext(source, {
    document,
    console,
    window: {},
    fetch() { throw new Error('初始化不应在脚本解析阶段发起请求'); },
    requestAnimationFrame() {},
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
  }));
  assert.equal(typeof listeners.get('DOMContentLoaded'), 'function');
});

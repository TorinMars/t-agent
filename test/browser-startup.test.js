const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('app.js does not run its initialization before the feature modules are loaded', () => {
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
    window: { addEventListener() {} },
    fetch() { throw new Error('Initialization must not make requests while the script is being parsed'); },
    requestAnimationFrame() {},
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
  }));
  assert.equal(typeof listeners.get('DOMContentLoaded'), 'function');
});

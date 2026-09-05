const test = require('node:test');
const assert = require('node:assert/strict');
const { isSendableCloseCode, closeWebSocket } = require('../lib/websocket-close');

test('filters WebSocket close codes that cannot be sent on the wire', () => {
  assert.equal(isSendableCloseCode(1000), true);
  assert.equal(isSendableCloseCode(1011), true);
  assert.equal(isSendableCloseCode(4001), true);
  assert.equal(isSendableCloseCode(1005), false);
  assert.equal(isSendableCloseCode(1006), false);
  assert.equal(isSendableCloseCode(5000), false);
});

test('forwards valid close codes and omits reserved close codes', () => {
  const calls = [];
  const socket = { readyState: 1, close: (...args) => calls.push(args) };

  assert.equal(closeWebSocket(socket, 1000, 'done'), true);
  assert.deepEqual(calls.pop(), [1000, 'done']);

  assert.equal(closeWebSocket(socket, 1005, 'reserved'), true);
  assert.deepEqual(calls.pop(), []);

  socket.readyState = 3;
  assert.equal(closeWebSocket(socket, 1000), false);
  assert.equal(calls.length, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalTicket, consumeTerminalTicket } = require('../services/terminal-tickets');

test('终端 ticket 只能消费一次', () => {
  const created = createTerminalTicket({ principalId: 'owner', taskId: 42 });
  assert.match(created.ticket, /^tat_/);
  const consumed = consumeTerminalTicket(created.ticket);
  assert.equal(consumed.principalId, 'owner');
  assert.equal(consumed.taskId, 42);
  assert.equal(typeof consumed.expiresAt, 'number');
  assert.equal(consumeTerminalTicket(created.ticket), null);
});

 test('终端 ticket 绑定具体终端，不能通过 URL 改写目标', () => {
  const created = createTerminalTicket({ principalId: 'owner', taskId: 42, terminalId: 'second' });
  assert.equal(consumeTerminalTicket(created.ticket).terminalId, 'second');
 });

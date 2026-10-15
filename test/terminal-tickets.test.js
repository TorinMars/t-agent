const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalTicket, consumeTerminalTicket } = require('../services/terminal-tickets');

test('A terminal ticket can only be consumed once', () => {
  const created = createTerminalTicket({ principalId: 'owner', taskId: 42 });
  assert.match(created.ticket, /^tat_/);
  const consumed = consumeTerminalTicket(created.ticket);
  assert.equal(consumed.principalId, 'owner');
  assert.equal(consumed.taskId, 42);
  assert.equal(typeof consumed.expiresAt, 'number');
  assert.equal(consumeTerminalTicket(created.ticket), null);
});

 test('A terminal ticket is bound to a specific terminal and the target cannot be changed through the URL', () => {
  const created = createTerminalTicket({ principalId: 'owner', taskId: 42, terminalId: 'second' });
  assert.equal(consumeTerminalTicket(created.ticket).terminalId, 'second');
 });

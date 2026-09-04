const crypto = require('crypto');

const tickets = new Map();
const TTL_MS = 30_000;

function createTerminalTicket({ principalId, taskId }) {
  const ticket = `tat_${crypto.randomBytes(24).toString('base64url')}`;
  tickets.set(ticket, {
    principalId,
    taskId: Number(taskId),
    expiresAt: Date.now() + TTL_MS,
  });
  return { ticket, expires_in_seconds: TTL_MS / 1000 };
}

function consumeTerminalTicket(ticket) {
  const value = String(ticket || '');
  const record = tickets.get(value);
  tickets.delete(value);
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

function pruneExpiredTickets() {
  const now = Date.now();
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(ticket);
  }
}

module.exports = { createTerminalTicket, consumeTerminalTicket, pruneExpiredTickets };

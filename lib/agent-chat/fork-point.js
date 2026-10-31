// Where in a conversation a fork starts. The messages of a conversation are the items the service keeps (a `user` item per message of the person, the agent's
// items after it); the agent keeps its own record of the same conversation (Claude: the session file, Codex: the turns of the thread). A fork is made in the
// agent's record, so the item has to be found there: by counting the person's messages. The count is checked against the text of the message, and a fork that
// cannot be placed with certainty is refused instead of made at a wrong place.
//
//   locateFork(items, itemId, { countSteered })
//     -> { turn, user }   `turn`: the number (1-based) of the person's message the item belongs to (a user item is that message itself, an item of the agent
//                         belongs to the message it answers); `user`: the user item of that turn, and `own`: true when the item is that user item.
//     -> null             the item is not in the list, or it comes before any message of the person.
//   A message sent while the agent works (a `steered` item) starts a turn for Claude (it is a message of its own in the session) but not for Codex (it joins the
//   running turn), hence `countSteered`.
function locateFork(items, itemId, { countSteered = true } = {}) {
  const users = [];
  for (const item of items) {
    if (item.kind === 'user' && (countSteered || !item.steered)) users.push(item);
    if (item.id === itemId) {
      if (!users.length) return null;
      return { turn: users.length, user: users[users.length - 1], own: item.kind === 'user' && users[users.length - 1] === item, users };
    }
  }
  return null;
}

// The text the page showed and the text the agent recorded can differ in white space and in what is added for attachments, so one containing the other is
// the same message; a message with no text (only images) is the same as any other that has none.
function same(a, b) {
  const x = String(a || '').replace(/\s+/g, ' ').trim();
  const y = String(b || '').replace(/\s+/g, ' ').trim();
  if (!x || !y) return !x && !y;
  return x === y || x.includes(y) || y.includes(x);
}

module.exports = { locateFork, same };

// The in-process bus of things worth a memory ("Memories" in docs/design/usage-time.md): the places that already know something happened tell it
// here, and services/usage-memory-hooks.js turns it into an event line. Telling never throws and never waits; without a listener it does nothing.
//   task-created { task_id, title }   task-archived { task_id, title }   update-applied { version, previous }
//   practice-finished { right, total, done, title }
const listeners = new Set();

function emitUsageEvent(name, payload = {}) {
  for (const listener of listeners) {
    try { listener(name, payload); } catch { /* a memory is never the caller's problem */ }
  }
}

function onUsageEvent(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { emitUsageEvent, onUsageEvent };

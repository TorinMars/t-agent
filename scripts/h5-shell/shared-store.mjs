// The shell's door to the shared page state (public/js/page-state.js; docs/design/shared-page-state.md): a localStorage-like store whose keys are
// the same on every device and engine. Without TAPageState (a harness that loads the shell alone) it is this browser's own storage. Guarded.
const door = () => { try { return globalThis.TAPageState ? globalThis.TAPageState.store : globalThis.localStorage || null; } catch { return null; } };
export const sharedStore = door;
export function readShared(key) { try { const store = door(); return store ? store.getItem(key) : null; } catch { return null; } }
export function writeShared(key, value) {
  try { const store = door(); if (store) { if (value === null || value === undefined) store.removeItem(key); else store.setItem(key, String(value)); } } catch { /* not remembered */ }
}
// Calls `listener` when a shared value changed (on another device, in another frame); returns the function that stops it.
export const onShared = listener => { try { return globalThis.TAPageState ? globalThis.TAPageState.subscribe(listener) : () => {}; } catch { return () => {}; } };

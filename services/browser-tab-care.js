// T-Agent's care of the browser tabs agents opened ("Closing T-Agent's tabs" in docs/design/browser-extension.md). The bridge
// (services/browser-bridge.js) tells it which tab each tcli command used and from which terminal (task id + terminal id); it closes a tab through
// the extension's `tabs.close` with `auto: true` (which closes only an owned tab that is not kept) when:
//  - the terminal's Claude / Codex turn ended (routes/terminal.js onAgentTurnEnd) and the tab has had no command for TURN_END_IDLE_MS (checked
//    again when that time has passed; a new command on the tab cancels it until the next turn end);
//  - the terminal was closed, deleted or restarted, or its shell ended;
//  - in any case after IDLE_MS without a command on the tab.
// Never: a tab opened with `keep` (tcli browser open --keep), a handed tab, a tab the person used (the extension's `tab.used`: it is forgotten,
// or kept when it records). A close that is due while the browser is offline waits in a bounded list until the browser connects again.
// A tab that a recorded tab opened (a popup, target=_blank, window.open: the extension's `tab.opened`) is owned too and closes by the same rules
// as its opener: it gets the opener's terminal, or none (IDLE_MS only) when the opener has no entry, e.g. a handed tab.
// Memory only: after a T-Agent restart the extension's hello lists the tabs it owns, and they are adopted without a terminal (IDLE_MS applies).
const TURN_END_IDLE_MS = 2 * 60_000;
const IDLE_MS = 30 * 60_000;
const MAX_TABS = 1000;
const MAX_PENDING = 200;

const terminalKey = context => (context && context.task_id !== undefined && context.task_id !== null && context.terminal_id
  ? `${Number(context.task_id)}:${String(context.terminal_id)}` : null);

function createTabCare({
  close, // (browserId, tabId) -> Promise; rejects with code BROWSER_NOT_CONNECTED / BROWSER_TIMEOUT when the browser cannot be reached
  now = Date.now,
  setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); return timer; },
  clearTimer = timer => clearTimeout(timer),
  turnEndIdleMs = TURN_END_IDLE_MS,
  idleMs = IDLE_MS,
  log = () => {},
} = {}) {
  if (typeof close !== 'function') throw new Error('createTabCare needs close');
  const tabs = new Map(); // `${browserId}:${tabId}` -> { browserId, tabId, terminal, keep, lastCommandAt, turnEnded, timer }
  const pending = new Map(); // browserId -> tab ids whose close is due
  const keyOf = (browserId, tabId) => `${browserId}:${tabId}`;

  function arm(entry) {
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    if (entry.keep) return;
    const due = Math.min(entry.lastCommandAt + idleMs, entry.turnEnded ? entry.lastCommandAt + turnEndIdleMs : Infinity);
    const wait = due - now();
    if (wait <= 0) { closeNow(entry, entry.turnEnded && entry.lastCommandAt + turnEndIdleMs <= now() ? 'turn ended' : 'idle'); return; }
    entry.timer = setTimer(() => { entry.timer = null; if (tabs.get(keyOf(entry.browserId, entry.tabId)) === entry) arm(entry); }, wait);
  }

  function drop(entry) {
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    tabs.delete(keyOf(entry.browserId, entry.tabId));
  }

  function addPending(browserId, tabId) {
    const list = pending.get(browserId) || [];
    if (!list.includes(tabId)) list.push(tabId);
    while (list.length > MAX_PENDING) list.shift();
    pending.set(browserId, list);
  }

  function closeNow(entry, reason) {
    drop(entry);
    const { browserId, tabId } = entry;
    Promise.resolve().then(() => close(browserId, tabId)).then(
      () => log(`Browser tab ${tabId} closed (${reason})`),
      error => {
        if (error && (error.code === 'BROWSER_NOT_CONNECTED' || error.code === 'BROWSER_TIMEOUT')) addPending(browserId, tabId);
        // Anything else (the tab is gone, was handed over or kept, the person used it): nothing more to do.
      },
    );
  }

  // A command used this tab (or opened it). `how` is the extension's: 'group' (owned by T-Agent) or 'handed' (never closed, so not cared for).
  function noteTab(browserId, tabId, { context = null, how = 'group', keep = false } = {}) {
    if (typeof browserId !== 'string' || !Number.isInteger(tabId)) return;
    const key = keyOf(browserId, tabId);
    if (how !== 'group') { const old = tabs.get(key); if (old) drop(old); return; }
    let entry = tabs.get(key);
    if (!entry) {
      if (tabs.size >= MAX_TABS) drop(tabs.values().next().value); // the oldest is forgotten (not closed)
      entry = { browserId, tabId, terminal: null, keep: false, lastCommandAt: now(), turnEnded: false, timer: null };
      tabs.set(key, entry);
    }
    const list = pending.get(browserId);
    if (list && list.includes(tabId)) pending.set(browserId, list.filter(id => id !== tabId));
    const terminal = terminalKey(context);
    if (terminal) entry.terminal = terminal;
    if (keep) entry.keep = true;
    entry.lastCommandAt = now();
    entry.turnEnded = false;
    arm(entry);
  }

  // The extension's `tab.opened`: a tab the recorded tab `openerTabId` opened joined its recording and is owned by T-Agent. It belongs to the
  // opener's terminal (never kept, even when the opener is) and its turn state (a turn that already ended closes it TURN_END_IDLE_MS after it
  // opened), counted from now; without an opener entry only IDLE_MS applies.
  function opened(browserId, tabId, openerTabId) {
    if (typeof browserId !== 'string' || !Number.isInteger(tabId)) return;
    const opener = Number.isInteger(openerTabId) ? tabs.get(keyOf(browserId, openerTabId)) : null;
    const key = keyOf(browserId, tabId);
    const old = tabs.get(key);
    if (old) drop(old);
    if (tabs.size >= MAX_TABS) drop(tabs.values().next().value); // the oldest is forgotten (not closed)
    const entry = { browserId, tabId, terminal: opener ? opener.terminal : null, keep: false, lastCommandAt: now(), turnEnded: Boolean(opener && opener.turnEnded), timer: null };
    tabs.set(key, entry);
    const list = pending.get(browserId);
    if (list && list.includes(tabId)) pending.set(browserId, list.filter(id => id !== tabId));
    arm(entry);
  }

  // The tab closed, was released or the person used it: never closed by T-Agent.
  function forget(browserId, tabId) {
    const entry = tabs.get(keyOf(browserId, tabId));
    if (entry) drop(entry);
    const list = pending.get(browserId);
    if (list) pending.set(browserId, list.filter(id => id !== tabId));
  }

  function keep(browserId, tabId) {
    const entry = tabs.get(keyOf(browserId, tabId));
    if (!entry) return;
    entry.keep = true;
    arm(entry);
  }

  const ofTerminal = context => {
    const terminal = terminalKey(context);
    return terminal ? [...tabs.values()].filter(entry => entry.terminal === terminal) : [];
  };

  // The terminal's agent finished its turn: its tabs close once they had no command for TURN_END_IDLE_MS.
  function turnEnded(context) {
    for (const entry of ofTerminal(context)) {
      if (entry.keep) continue;
      entry.turnEnded = true;
      arm(entry);
    }
  }

  // The terminal was closed, deleted or restarted: its tabs close now.
  function terminalEnded(context) {
    for (const entry of ofTerminal(context)) if (!entry.keep) closeNow(entry, 'terminal closed');
  }

  // A browser connected: the tabs its extension owns (`owned_tabs` of the hello, when it sends them) are adopted, tabs it no longer owns are
  // forgotten, and the closes that waited for it are sent.
  function connected(browserId, ownedTabs) {
    if (Array.isArray(ownedTabs)) {
      const owned = new Map();
      for (const item of ownedTabs.slice(0, MAX_TABS)) if (item && Number.isInteger(item.tab_id)) owned.set(item.tab_id, item.keep === true);
      for (const entry of [...tabs.values()]) if (entry.browserId === browserId && !owned.has(entry.tabId)) drop(entry);
      const due = new Set(pending.get(browserId) || []);
      for (const [tabId, kept] of owned) {
        if (due.has(tabId)) continue; // closed below
        const entry = tabs.get(keyOf(browserId, tabId));
        if (!entry) noteTab(browserId, tabId, { keep: kept });
        else if (kept && !entry.keep) keep(browserId, tabId);
      }
      const list = pending.get(browserId);
      if (list) pending.set(browserId, list.filter(id => owned.has(id)));
    }
    const due = pending.get(browserId) || [];
    pending.delete(browserId);
    for (const tabId of due) closeNow({ browserId, tabId, timer: null }, 'due while offline');
  }

  function snapshot() {
    return {
      tabs: [...tabs.values()].map(({ browserId, tabId, terminal, keep: kept, lastCommandAt, turnEnded: ended }) => ({ browser_id: browserId, tab_id: tabId, terminal, keep: kept, last_command_at: lastCommandAt, turn_ended: ended })),
      pending: Object.fromEntries([...pending].map(([browserId, list]) => [browserId, list.slice()])),
    };
  }

  function stop() { for (const entry of [...tabs.values()]) drop(entry); pending.clear(); }

  return { noteTab, opened, forget, keep, turnEnded, terminalEnded, connected, snapshot, stop };
}

module.exports = { createTabCare, TURN_END_IDLE_MS, IDLE_MS, MAX_PENDING, MAX_TABS };

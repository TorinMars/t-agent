// Waiting for this machine's service to come back after it restarts: the manual update (`monitor` in Update.jsx) and "Restart T-Agent" (Restart.jsx).
// See "Automatic refresh after an update" in DESIGN.md: the version number cannot tell the new process from the old one, the `boot_id` can.

// Once the old process said it is restarting, any answer this much later comes from the new one (it exits about 0.75 s after saying so).
export const RESTART_GRACE_MS = 4000;
// The restart takes this long: offer "Refresh now".
export const SLOW_RESTART_MS = 20000;
export const RESTART_POLL_MS = 1000;

// Whether `next` (an answer of `/api/system/version` or `update-status`) comes from a new process. With a `boot_id` on both sides only a different one counts;
// without one, an answer after a failed read, or one more than RESTART_GRACE_MS after `since`, does.
export function fromNewProcess({ bootId, next, down = false, since = null, now = Date.now() }) {
  if (!next) return false;
  if (bootId && next.boot_id) return next.boot_id !== bootId;
  return down || (since !== null && now - since > RESTART_GRACE_MS);
}

// Reads `read()` every RESTART_POLL_MS until a new process answers (`onBack(next)`), calls `onSlow()` once after SLOW_RESTART_MS, and returns `stop`.
export function watchRestart({ bootId, read, onBack, onSlow, pollMs = RESTART_POLL_MS }) {
  const since = Date.now();
  let down = false;
  let stopped = false;
  let timer = 0;
  const slow = setTimeout(() => { if (!stopped && onSlow) onSlow(); }, SLOW_RESTART_MS);
  const stop = () => { stopped = true; clearTimeout(timer); clearTimeout(slow); };
  const poll = async () => {
    let next = null;
    try { next = await read(); } catch { down = true; }
    if (stopped) return;
    if (fromNewProcess({ bootId, next, down, since })) { stop(); onBack(next); return; }
    timer = setTimeout(poll, pollMs);
  };
  timer = setTimeout(poll, pollMs);
  return stop;
}

// The beat sender of page time ("Page time" in docs/design/usage-time-page.md), a chunk of its own: usage-time.mjs loads it once the server says
// that "Record time" is on. While the page is visible and the person did something in the last 2 minutes, a beat of 15 seconds is queued every 15
// seconds (usage-beats.mjs has the rules) and the beats go to POST /api/usage-time/beats in batches (at most 40), with a beacon when the page is
// hidden or left. No text is read: the beat names the surface, the kind of the shown session and engine-neutral ids.
// - Several tabs: only the one with the newest activity beats (a BroadcastChannel carries each tab's last activity), and never a hidden one.
// - A batch the server refuses (the switch was turned off elsewhere) turns `state.usageTimeRecording` off; while it is off nothing is queued or sent.
import { ACTIVITY, MESSAGE, STEP_MS, beatOf, clientOf, flushDue, isActive, isOwner, takeBatch } from './usage-beats.mjs';

const CHANNEL = 't-agent-usage-time';

export function startSender(ui, { doc = document, win = window, url = '/api/usage-time', now = () => Date.now(), last: before = 0 } = {}) {
  let last = before;
  const hear = () => { last = now(); };
  for (const type of ACTIVITY) doc.addEventListener(type, hear, { capture: true, passive: true });
  win.addEventListener('message', event => {
    if (event.origin === win.location.origin && event.data && event.data.type === MESSAGE) hear();
  });
  // The other tabs of this browser: their newest activity, so only one tab counts.
  const id = `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const others = {};
  let channel = null;
  let shared = 0;
  try { channel = typeof win.BroadcastChannel === 'function' ? new win.BroadcastChannel(CHANNEL) : null; } catch { channel = null; }
  if (channel) {
    channel.onmessage = event => {
      const data = event.data || {};
      if (typeof data.id === 'string' && data.id !== id && Number.isFinite(data.last)) {
        if (data.gone) delete others[data.id]; else others[data.id] = data.last;
      }
    };
  }
  const share = () => {
    if (!channel || !last || last === shared) return;
    shared = last;
    try { channel.postMessage({ id, last }); } catch { /* closed */ }
  };
  const visible = () => doc.visibilityState === 'visible';
  const client = clientOf(win.navigator && win.navigator.userAgent);
  let queue = [];
  // `sent` is the page's clock at sending: the server moves the beats' times by the difference to its own clock, so a device whose clock is off
  // still counts its time in the right hour (and its beats are not dropped as too far ahead or too old).
  const body = batch => JSON.stringify({ client, sent: now(), beats: batch });
  const off = () => { queue = []; };
  const refused = answer => answer && (answer.ok === false || answer.enabled === false);
  const send = () => {
    if (!queue.length || ui.get().usageTimeRecording !== true) return;
    const [batch, rest] = takeBatch(queue);
    queue = rest;
    win.fetch(`${url}/beats`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body(batch) })
      .then(res => (res.status === 403 || res.status === 409 ? { ok: false } : res.ok ? res.json() : null))
      .then(answer => { if (refused(answer)) ui.set({ usageTimeRecording: false }); })
      .catch(() => { /* lost: page time is best effort */ });
    if (queue.length) send();
  };
  const leave = () => {
    if (!queue.length || ui.get().usageTimeRecording !== true) return;
    while (queue.length) {
      const [batch, rest] = takeBatch(queue);
      queue = rest;
      try { if (!win.navigator.sendBeacon(`${url}/beats`, new Blob([body(batch)], { type: 'application/json' }))) throw new Error('refused'); } catch { /* lost */ }
    }
  };
  const tick = () => {
    const at = now();
    share();
    if (ui.get().usageTimeRecording !== true) { off(); return; }
    if (isActive(at, last, visible()) && isOwner({ id, last }, others)) queue.push(beatOf(ui.get(), at));
    if (flushDue(queue, at)) send();
  };
  win.setInterval(tick, STEP_MS);
  win.addEventListener('pagehide', () => {
    leave();
    if (channel) try { channel.postMessage({ id, last: 0, gone: true }); } catch { /* closed */ }
  });
  // Hidden: the clock stops (a hidden tab never beats) and what is queued goes with a beacon. Shown again: the person brought it up, which counts
  // as activity (so this tab, not the one left behind, is the one that counts).
  doc.addEventListener('visibilitychange', () => { if (!visible()) leave(); else hear(); });
  ui.subscribe(() => { if (ui.get().usageTimeRecording !== true) off(); });
  return { queued: () => queue.length };
}

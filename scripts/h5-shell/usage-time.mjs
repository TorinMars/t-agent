// Page time ("Page time" in docs/design/usage-time-page.md): the small part of the first screen. It reads the switch "Record time"
// (`state.usageTimeRecording`: null until GET /api/usage-time/settings answered, then true or false; the Settings tab Time sets it) and loads the
// beat sender (usage-time-sender.mjs, a chunk of its own) only while it is on. It keeps the time of the last activity until then, so the sender
// starts with it.
// - A column of the multi-column view (a pane) sends nothing: it tells its top page that the person is active in it (`t-agent-activity`, at most
//   every 5 s), and the top page beats for the focused column. A page framed by anything else (an embed) does nothing at all.
// The same two as usage-beats.mjs `ACTIVITY` and `MESSAGE` (test/h5-usage-beats.test.js checks it); not imported, so the sender chunk stays its own.
export const ACTIVITY = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'];
export const MESSAGE = 't-agent-activity';

export function startUsageTime(ui, { doc = document, win = window, url = '/api/usage-time', now = () => Date.now(), load = () => import('./usage-time-sender.mjs') } = {}) {
  const framed = (() => { try { return win.top !== win; } catch { return true; } })();
  const pane = Boolean(ui.get().pane);
  if (framed && !pane) return null; // an embed: nothing is measured
  const listen = fn => { for (const type of ACTIVITY) doc.addEventListener(type, fn, { capture: true, passive: true }); };
  if (pane) {
    let told = 0;
    listen(() => {
      const at = now();
      if (at - told < 5000) return;
      told = at;
      try { win.parent.postMessage({ type: MESSAGE }, win.location.origin); } catch { /* the top page went away */ }
    });
    return { pane: true };
  }
  let last = 0;
  let early = true; // until the sender is there
  listen(() => { if (early) last = now(); });
  let loading = null;
  const start = () => {
    if (loading) return loading;
    loading = load().then(module => { early = false; return module.startSender(ui, { doc, win, url, now, last }); }).catch(() => { loading = null; return null; });
    return loading;
  };
  ui.subscribe(() => { if (ui.get().usageTimeRecording === true) void start(); });
  // The switch: read once the first screen is up, and again when the page comes back after ten minutes or more (it may have changed elsewhere).
  let checked = 0;
  const read = () => {
    checked = now();
    win.fetch(`${url}/settings`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(res => (res.ok ? res.json() : null))
      .then(answer => ui.set({ usageTimeRecording: Boolean(answer && answer.usage_time_record) }), () => ui.set({ usageTimeRecording: false }));
  };
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && now() - checked > 600000) read(); });
  win.setTimeout(read, 1500);
  return { pane: false, start };
}

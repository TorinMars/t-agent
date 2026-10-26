// What the agents are doing, in the top bar of the pages: how many messages sent to agents have not finished ("submitted": the turns running now and
// the messages queued behind them) and how many agent turns are running now, over all the tasks of the person (GET /api/agent-chat/summary).
// It refreshes every few seconds while the page is visible, and at once when the page becomes visible again.
const AgentActivity = (() => {
  const REFRESH_MS = 5000;
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);

  // The two counters as they are written: [{ key, count, label }], from a summary { submitted, running }.
  function counters(summary) {
    const count = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    return [
      { key: 'submitted', count: count(summary && summary.submitted), label: 'submitted' },
      { key: 'running', count: count(summary && summary.running), label: 'running' },
    ];
  }

  // element: the container with two children, .agent-activity-submitted and .agent-activity-running, each with a .count and a .label inside.
  function attach(element, { fetchImpl = (...args) => fetch(...args), documentImpl = document, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    let timer = null;
    let latest = 0; // an older answer that arrives late must not overwrite a newer one
    function render(summary) {
      for (const { key, count, label } of counters(summary)) {
        const part = element.querySelector(`.agent-activity-${key}`);
        if (!part) continue;
        part.querySelector('.count').textContent = String(count);
        part.querySelector('.label').textContent = tr(label);
        part.classList.toggle('idle', count === 0);
      }
      element.hidden = false;
    }
    async function refresh() {
      const mine = ++latest;
      try {
        const response = await fetchImpl('/api/agent-chat/summary', { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' });
        if (!response.ok) return;
        const summary = await response.json();
        if (mine === latest) render(summary);
      } catch { /* the numbers stay as they were */ }
    }
    function tick() { if (!documentImpl.hidden) void refresh(); }
    function start() {
      if (timer === null) timer = setIntervalImpl(tick, REFRESH_MS);
      void refresh();
    }
    function stop() {
      if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    }
    documentImpl.addEventListener('visibilitychange', () => { if (!documentImpl.hidden) void refresh(); });
    start();
    return { refresh, stop, render };
  }

  if (typeof document !== 'undefined') {
    const element = document.getElementById('agent-activity');
    if (element) attach(element);
  }
  return { attach, counters };
})();
if (typeof window !== 'undefined') window.AgentActivity = AgentActivity;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentActivity;

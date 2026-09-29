// Send only page readiness, never session data, to the embedding switcher.
(() => {
  if (window.parent === window || !document.referrer) return;
  let origin;
  try { origin = new URL(document.referrer).origin; } catch { return; }
  window.parent.postMessage({ type: 't-agent:client-frame', status: document.body.dataset.clientFrame || 'ready' }, origin);
})();

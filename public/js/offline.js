// The view while this engine is down (public/offline.html, served by public/sw.js for / and /h5 when the engine does not answer). See "The page while
// its engine is down" in docs/design/failover-and-one-login.md.
//
// - Names: this engine and its linked engines, with their web addresses, as the page last saw them while it was up (`ta-linked-engines` in
//   public/js/local-keys.js, written by public/js/h5.js from GET /api/sign-in-handover/peers). Nothing here is live data of an engine.
// - Each remembered address is tried with a request without credentials (`/health`, no-cors: only "it answered" is learnt); the first that answers
//   per engine gets a contained "Continue on <engine>" button, which opens that engine's page at the same page path (/ or /h5). There this browser is
//   signed in when it has that engine's cookie (for example after "Sign in on <engine> too" in Settings → Devices); this engine cannot hand a login
//   over while it is down, so otherwise that engine asks for its own code.
// - This engine is asked (`/health`) every 5 s and on "Try again"; once it answers, the page loads again by itself (the normal page, or the login).
(function (global) {
  const KEY = 'ta-linked-engines';
  const POLL_MS = 5000;
  const PROBE_TIMEOUT_MS = 4000;
  const tr = (text, ...args) => {
    const translated = global.I18n && typeof global.I18n.t === 'function' ? global.I18n.t(text) : text;
    // {1}, {2} ... stay in the translation; names go in after it (never translated).
    return args.reduce((out, value, index) => out.split(`{${index + 1}}`).join(value), translated);
  };
  // What was remembered: { self: { name }, peers: [{ instance_id, name, addresses }] }, or an empty one.
  function remembered(keys) {
    try {
      const value = JSON.parse((keys && keys.get(KEY)) || 'null');
      return value && typeof value === 'object' ? { self: value.self || {}, peers: Array.isArray(value.peers) ? value.peers : [] } : { self: {}, peers: [] };
    } catch { return { self: {}, peers: [] }; }
  }
  const joinNames = names => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${tr('and')} ${names[names.length - 1]}`);

  // The words and buttons for a state (pure, test/offline-view.test.js). `reachable`: [{ name, address }] of the engines that answered; `probing`:
  // the tries are still running.
  function view({ selfName, reachable, probing }) {
    const self = selfName || tr('This engine');
    const title = selfName ? tr("{1} can't be reached", selfName) : tr("This engine can't be reached");
    if (reachable.length) {
      const names = joinNames(reachable.map(entry => entry.name));
      return { title, text: tr('Your tasks on {1} are still running. Continue there; this page comes back by itself when {2} answers.', names, self), buttons: reachable.map(entry => ({ label: tr('Continue on {1}', entry.name), address: entry.address, name: entry.name })) };
    }
    if (probing) return { title, text: tr('Looking for your other devices…'), buttons: [] };
    return { title, text: tr('No other device answers either. This page comes back by itself when {1} answers.', self), buttons: [] };
  }

  // One engine's first address that answers, or null. `fetchImpl` answers for any reply (an opaque one too) and fails when nothing answered.
  async function firstAnswering(addresses, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS) {
    for (const address of addresses) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        await fetchImpl(`${address}/health`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller ? controller.signal : undefined });
        return address;
      } catch { /* not this one */ } finally { if (timer) clearTimeout(timer); }
    }
    return null;
  }

  const api = { view, firstAnswering, remembered, KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !document.getElementById('offline-view')) return;

  const known = remembered(global.TALocalKeys);
  const pagePath = location.pathname === '/h5' ? '/h5' : '/';
  const title = document.getElementById('offline-title');
  const text = document.getElementById('offline-text');
  const actions = document.getElementById('offline-continue');
  const retry = document.getElementById('offline-retry');
  retry.textContent = tr('Try again');
  let reachable = [];
  let probing = false;

  function draw() {
    const shown = view({ selfName: known.self.name || '', reachable, probing });
    title.textContent = shown.title;
    text.textContent = shown.text;
    document.title = shown.title;
    actions.replaceChildren(...shown.buttons.map(button => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'offline-button';
      element.dataset.address = button.address;
      element.textContent = button.label;
      element.addEventListener('click', () => { location.href = button.address + pagePath; });
      return element;
    }));
  }

  async function probeLinked() {
    probing = true;
    draw();
    const found = await Promise.all(known.peers.map(async peer => {
      const addresses = Array.isArray(peer.addresses) ? peer.addresses.filter(value => typeof value === 'string' && /^https?:\/\//.test(value)) : [];
      const address = await firstAnswering(addresses, (url, options) => fetch(url, options));
      return address ? { name: String(peer.name || ''), address } : null;
    }));
    reachable = found.filter(Boolean);
    probing = false;
    draw();
  }

  // This engine is back: the page loads again (the service worker passes the answer on as it is).
  async function selfAnswers() {
    try {
      const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
      return response.ok;
    } catch { return false; }
  }
  async function check() {
    if (await selfAnswers()) { location.reload(); return true; }
    return false;
  }

  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try { if (!(await check())) await probeLinked(); } finally { retry.disabled = false; }
  });
  setInterval(() => { if (document.visibilityState === 'visible') void check(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  draw();
  void probeLinked();
}(typeof window !== 'undefined' ? window : globalThis));

(() => {
  const originalFetch = window.fetch.bind(window);
  const meta = document.querySelector('meta[name="t-agent-login-path"]');
  const loginPath = (meta && meta.content) || '/auth/login';
  window.TAgentLoginPath = loginPath;
  let redirecting = false;
  // When logged out the server answers 404 for every protected address (it never exposes 401), so a 404 must first be checked against the login entrance to see whether the session has expired,
  // otherwise a real "resource not found" would be mistaken for being logged out.
  async function sessionLost() {
    try {
      const response = await originalFetch(...withDevice([`${loginPath}/status`, { cache: 'no-store', credentials: 'same-origin' }]));
      if (!response.ok) return false;
      const status = await response.json();
      return status.authenticated === false;
    } catch { return false; }
  }
  // Every same-origin request carries the id of this browser (`X-TA-Device`, `TALocalKeys.deviceId()` of public/js/local-keys.js) for the access
  // log ("Devices and sign-ins" in docs/design/page-files-and-settings.md). An explicit X-TA-Device is kept; a cross-origin request gets nothing.
  function withDevice(args) {
    try {
      const keys = window.TALocalKeys;
      const id = keys && typeof keys.deviceId === 'function' ? keys.deviceId() : '';
      if (!id) return args;
      const [input, init] = args;
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      const target = new URL(isRequest ? input.url : String(input), location.href);
      if (target.origin !== location.origin) return args;
      const headers = new Headers((init && init.headers) || (isRequest ? input.headers : undefined));
      if (headers.has('X-TA-Device')) return args;
      headers.set('X-TA-Device', id);
      return [input, { ...(init || {}), headers }, ...args.slice(2)];
    } catch { return args; }
  }
  window.fetch = async (...args) => {
    const response = await originalFetch(...withDevice(args));
    const input = args[0];
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    const guarded = url.origin === location.origin && (url.pathname.startsWith('/api/') || ['/auth/me', '/auth/settings'].includes(url.pathname));
    if (!redirecting && guarded && [401, 403, 404].includes(response.status)) {
      let lost = false;
      if (response.status === 404) lost = await sessionLost();
      else {
        const data = await response.clone().json().catch(() => ({}));
        lost = ['AUTH_REQUIRED', 'AUTHENTICATOR_BINDING_REQUIRED'].includes(data.error);
      }
      if (lost && !redirecting) {
        redirecting = true;
        location.replace(`${loginPath}?return_to=${encodeURIComponent((/^\/h5(\/|$)/.test(location.pathname) ? '/h5' : '/') + location.search)}`); // back to the page that was open
      }
    }
    return response;
  };
  // Restoring from browser back/forward cache must recheck server authorization.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();

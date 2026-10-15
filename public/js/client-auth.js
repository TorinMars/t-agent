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
      const response = await originalFetch(`${loginPath}/status`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return false;
      const status = await response.json();
      return status.authenticated === false;
    } catch { return false; }
  }
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
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
        location.replace(`${loginPath}?return_to=${encodeURIComponent('/web')}`);
      }
    }
    return response;
  };
  // Restoring from browser back/forward cache must recheck server authorization.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();

(() => {
  const originalFetch = window.fetch.bind(window);
  let redirecting = false;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const input = args[0];
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    if (!redirecting && url.origin === location.origin && (url.pathname.startsWith('/api/') || ['/auth/me', '/auth/settings'].includes(url.pathname)) && [401, 403].includes(response.status)) {
      const data = await response.clone().json().catch(() => ({}));
      if (['AUTH_REQUIRED', 'AUTHENTICATOR_BINDING_REQUIRED'].includes(data.error)) {
        redirecting = true;
        const target = data.error === 'AUTHENTICATOR_BINDING_REQUIRED' ? '/auth/setup' : '/auth/login';
        const returnTo = '/web';
        location.replace(`${target}?return_to=${encodeURIComponent(returnTo)}`);
      }
    }
    return response;
  };
  // Restoring from browser back/forward cache must recheck server authorization.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();

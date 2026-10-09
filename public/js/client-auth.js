(() => {
  const originalFetch = window.fetch.bind(window);
  const meta = document.querySelector('meta[name="t-agent-login-path"]');
  const loginPath = (meta && meta.content) || '/auth/login';
  window.TAgentLoginPath = loginPath;
  let redirecting = false;
  // 未登录时服务端对所有受保护地址返回 404（不暴露 401），所以 404 要先向登录入口确认会话是否已失效，
  // 避免把真正的“资源不存在”误判为掉线。
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

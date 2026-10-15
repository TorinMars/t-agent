// Hidden login entrance: when logged out, every address except the login entrance and machine endpoints returns the same 404 as a non-existent route.
const DEFAULT_LOGIN_PATH = '/torin/hide/login';
const RESERVED_FIRST_SEGMENTS = new Set([
  'api', 'auth', 'v1', 'health', 'share', 'hooks', 'terminal', 'web', 'h5',
  'css', 'js', 'vendor', 'icons', 'favicon.svg', 'favicon.ico', 'manifest.json', 'sw.js',
]);

function resolveLoginPath(value, warn = () => {}) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_LOGIN_PATH;
  const normalized = raw.replace(/\/+$/, '');
  const firstSegment = normalized.split('/')[1] || '';
  if (!/^\/[A-Za-z0-9\-._~]+(?:\/[A-Za-z0-9\-._~]+)*$/.test(normalized) || normalized.length < 6 || RESERVED_FIRST_SEGMENTS.has(firstSegment) || normalized.split('/').includes('..')) {
    warn(`CLIENT_LOGIN_PATH is invalid (it must start with /, have at least 6 characters, contain no special characters and not use a built-in path such as ${[...RESERVED_FIRST_SEGMENTS].slice(0, 6).join(', ')}); the default ${DEFAULT_LOGIN_PATH} is used`);
    return DEFAULT_LOGIN_PATH;
  }
  return normalized;
}

// Matches Express's default response for unmatched routes so the two cannot be told apart.
function sendNotFound(req, res) {
  const escaped = `${req.method} ${req.path}`.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.status(404)
    .set({ 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
    .type('html')
    .send(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${escaped}</pre>\n</body>\n</html>\n`);
}

// Addresses reachable without logging in: the login entrance and its endpoints, Bearer-token machine endpoints, the health check,
// public share pages with the scripts and styles they depend on, and the login page's own static files.
const OPEN_STATIC = new Set(['/favicon.svg', '/css/auth.css', '/js/auth.js', '/js/i18n.js', '/js/i18n-zh-ui.js', '/js/i18n-zh-server.js', '/css/markdown.css', '/js/markdown-view.js']);
function isOpenPath(pathname, loginPath) {
  if (pathname === loginPath || pathname.startsWith(`${loginPath}/`)) return true;
  if (pathname === '/health') return true;
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return true;
  if (pathname === '/api/remote/v1' || pathname.startsWith('/api/remote/v1/')) return true;
  if (pathname.startsWith('/share/')) return true;
  if (/^\/vendor\/(?:marked|mermaid)\/[^/]+$/.test(pathname)) return true;
  return OPEN_STATIC.has(pathname);
}

function createLoginGate({ loginPath, isAuthenticated }) {
  return function loginGate(req, res, next) {
    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch { return sendNotFound(req, res); }
    // Encoding bypass: check both the decoded path and the raw path; if either is not on the allowlist the address is treated as closed.
    if (isAuthenticated(req.session) || (isOpenPath(pathname, loginPath) && isOpenPath(req.path, loginPath))) return next();
    return sendNotFound(req, res);
  };
}

module.exports = { DEFAULT_LOGIN_PATH, resolveLoginPath, isOpenPath, createLoginGate, sendNotFound };

// 隐藏登录入口：未登录时除登录入口和机器接口外，所有地址都返回与“路由不存在”相同的 404。
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
    warn(`CLIENT_LOGIN_PATH 无效（需以 / 开头、至少 6 个字符、不含特殊字符且不占用 ${[...RESERVED_FIRST_SEGMENTS].slice(0, 6).join('、')} 等内置路径），已使用默认值 ${DEFAULT_LOGIN_PATH}`);
    return DEFAULT_LOGIN_PATH;
  }
  return normalized;
}

// 与 Express 对未匹配路由的默认响应保持一致，避免被区分。
function sendNotFound(req, res) {
  const escaped = `${req.method} ${req.path}`.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.status(404)
    .set({ 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
    .type('html')
    .send(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${escaped}</pre>\n</body>\n</html>\n`);
}

// 未登录也要能访问的地址：登录入口及其接口、Bearer 令牌的机器接口、健康检查、
// 公开分享页及它依赖的脚本样式，以及登录页自身的静态文件。
const OPEN_STATIC = new Set(['/favicon.svg', '/css/auth.css', '/js/auth.js', '/css/markdown.css', '/js/markdown-view.js']);
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
    // 编码绕过：以解码后的路径和原始路径同时判断，任一不在白名单都视为未开放。
    if (isAuthenticated(req.session) || (isOpenPath(pathname, loginPath) && isOpenPath(req.path, loginPath))) return next();
    return sendNotFound(req, res);
  };
}

module.exports = { DEFAULT_LOGIN_PATH, resolveLoginPath, isOpenPath, createLoginGate, sendNotFound };

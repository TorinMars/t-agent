function parseFrameOrigins(value = '') {
  return [...new Set(value.split(',').map(value => value.trim()).filter(Boolean).map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('CLIENT_FRAME_ORIGINS must contain HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CLIENT_FRAME_ORIGINS must contain HTTP(S) origins without paths or credentials');
    }
    return url.origin;
  }))];
}

function frameAncestors(origins) {
  return `frame-ancestors 'self'${origins.length ? ` ${origins.join(' ')}` : ''}`;
}

// Cross-site embedding is opt-in and only uses None on HTTPS. HTTP keeps the
// original Strict cookie boundary; browser APIs still require same-origin proof.
function clientCookieSameSite(req, origins) {
  return req.secure && origins.length ? 'none' : 'strict';
}

module.exports = { parseFrameOrigins, frameAncestors, clientCookieSameSite };

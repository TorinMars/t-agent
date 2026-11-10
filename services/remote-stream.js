const http = require('http');
const https = require('https');
const { TUNNEL_PROTOCOL, getHub } = require('../lib/service-link-tunnel');

const FORWARDED_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag'];
// A raw file (PDF, audio, video) also keeps what the browser's viewer and players need to seek.
const RAW_HEADERS = ['content-range', 'accept-ranges', 'content-disposition', 'cache-control'];

// The media type of a Content-Type header, without parameters, in lower case.
function mediaType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

// Pipes a GET from a remote Engine straight to the browser without buffering,
// for binary task files and server-sent events. The Engine token stays here.
// `raw`: a PDF, audio or video file. The Range header is sent on, the range headers come back, and once the answer has started there is no idle
// limit (a paused video must not be cut). Its sandbox is kept for every type except application/pdf, which Chrome does not show when sandboxed.
function streamRemote(req, res, baseUrl, token, pathname, { sse = false, sandbox = false, raw = false } = {}) {
  let target;
  try { target = new URL(pathname, `${baseUrl}/`); } catch { return res.status(400).json({ error: 'INVALID_REMOTE_URL' }); }
  // A service link's Engine answers over its tunnel, through the same calls.
  const client = target.protocol === TUNNEL_PROTOCOL ? getHub() : target.protocol === 'https:' ? https : http;
  const upstream = client.request(target, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: sse ? 'text/event-stream' : '*/*',
      ...(raw && typeof req.headers.range === 'string' ? { Range: req.headers.range } : {}),
    },
    // Event streams stay open on purpose; everything else must respond promptly.
    ...(sse ? {} : { timeout: 15_000 }),
  }, response => {
    res.status(response.statusCode);
    for (const name of FORWARDED_HEADERS) if (response.headers[name]) res.setHeader(name, response.headers[name]);
    if (raw) {
      for (const name of RAW_HEADERS) if (response.headers[name]) res.setHeader(name, response.headers[name]);
      upstream.setTimeout(0);
    }
    if (sse) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }
    if (sandbox) {
      // Remote files must not run script in the Client's origin. The one exception is a raw PDF, shown by the browser's own viewer.
      if (!(raw && mediaType(response.headers['content-type']) === 'application/pdf')) res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    response.pipe(res);
    response.on('error', () => res.end());
  });
  upstream.on('timeout', () => upstream.destroy(new Error('REMOTE_TIMEOUT')));
  upstream.on('error', error => {
    if (!res.headersSent) res.status(502).json({ error: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'REMOTE_CONNECTION_FAILED' });
    else res.end();
  });
  res.on('close', () => upstream.destroy());
  upstream.end();
}

module.exports = { streamRemote, mediaType };

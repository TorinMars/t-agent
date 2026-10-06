const http = require('http');
const https = require('https');

const FORWARDED_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag'];

// Pipes a GET from a remote Engine straight to the browser without buffering,
// for binary task files and server-sent events. The Engine token stays here.
function streamRemote(req, res, baseUrl, token, pathname, { sse = false, sandbox = false } = {}) {
  let target;
  try { target = new URL(pathname, `${baseUrl}/`); } catch { return res.status(400).json({ error: 'INVALID_REMOTE_URL' }); }
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(target, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: sse ? 'text/event-stream' : '*/*' },
    // Event streams stay open on purpose; everything else must respond promptly.
    ...(sse ? {} : { timeout: 15_000 }),
  }, response => {
    res.status(response.statusCode);
    for (const name of FORWARDED_HEADERS) if (response.headers[name]) res.setHeader(name, response.headers[name]);
    if (sse) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }
    if (sandbox) {
      // Remote files must not run script in the Client's origin.
      res.setHeader('Content-Security-Policy', 'sandbox');
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

module.exports = { streamRemote };

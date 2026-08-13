const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_BYTES = 6 * 1024 * 1024;

function normalizeBaseUrl(urlValue, port) {
  let url;
  try { url = new URL(urlValue); } catch { throw new Error('INVALID_REMOTE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_REMOTE_URL');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('REMOTE_URL_MUST_NOT_HAVE_PATH');
  if (port !== undefined && port !== null && port !== '') {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('INVALID_REMOTE_PORT');
    url.port = String(number);
  }
  url.pathname = '/';
  return url.toString().replace(/\/$/, '');
}

function request(baseUrl, pathname, token, { expectText = false } = {}) {
  const target = new URL(pathname, `${baseUrl}/`);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(target, {
      headers: { Authorization: `Bearer ${token}`, Accept: expectText ? 'text/plain' : 'application/json' },
      timeout: 10_000,
    }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_BYTES) return req.destroy(new Error('REMOTE_RESPONSE_TOO_LARGE'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`REMOTE_HTTP_${res.statusCode}`);
          error.statusCode = res.statusCode;
          return reject(error);
        }
        if (expectText) return resolve(body);
        try { resolve(JSON.parse(body)); } catch { reject(new Error('INVALID_REMOTE_RESPONSE')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('REMOTE_TIMEOUT')));
    req.on('error', reject);
  });
}

module.exports = { normalizeBaseUrl, request };

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { enroll } = require('../scripts/client-auth-setup');

test('container setup forwards session cookie, confirms OTP, and displays recovery codes', async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, cookie: req.headers.cookie, requested: req.headers['x-requested-with'], body: Buffer.concat(chunks).toString() });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/status') return res.end(JSON.stringify({ bound: false }));
    if (req.url === '/auth/setup/start') {
      res.setHeader('Set-Cookie', 'connect.sid=setup; Path=/; HttpOnly');
      return res.end(JSON.stringify({ secret: 'TESTSECRET', uri: 'otpauth://test' }));
    }
    assert.equal(req.url, '/auth/setup/confirm');
    res.end(JSON.stringify({ recovery_codes: ['abcd1234-efab5678'] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const lines = [];
  await enroll({ baseUrl: `http://127.0.0.1:${server.address().port}`, ask: async () => '123456', write: value => lines.push(value), qr: async () => 'QR' });
  assert.equal(seen[2].cookie, 'connect.sid=setup');
  assert.equal(seen[2].requested, 'XMLHttpRequest');
  assert.equal(JSON.parse(seen[2].body).code, '123456');
  assert.match(lines.join('\n'), /TESTSECRET/);
  assert.match(lines.join('\n'), /abcd1234-efab5678/);
});

test('container setup refuses to reset an already bound authenticator', async t => {
  let count = 0;
  const server = http.createServer((req, res) => { count++; res.end('{"bound":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await assert.rejects(enroll({ baseUrl: `http://127.0.0.1:${server.address().port}`, ask: async () => assert.fail('must not prompt'), write: () => {} }), /ALREADY_BOUND/);
  assert.equal(count, 1);
});

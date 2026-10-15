const QRCode = require('qrcode');

// Run on the Client host or inside its container: calls the local HTTP API
// over loopback and issues a normal session.
// authBase: when logged out only the hidden login entrance is usable (see lib/login-gate.js); the command-line entry passes it in.
async function enroll({ baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`, authBase = '/auth', ask, write = console.log,
  qr = uri => QRCode.toString(uri, { type: 'terminal', small: true }) } = {}) {
  let cookie = '';
  async function request(route, body) {
    const response = await fetch(baseUrl + route, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return result;
  }
  if ((await request(`${authBase}/status`)).bound) throw new Error('AUTHENTICATOR_ALREADY_BOUND: already bound; replace it in the web settings. This command does not reset an existing binding.');
  const setup = await request(`${authBase}/setup/start`, {});
  write(await qr(setup.uri));
  write(`Scan the QR code above with your authenticator, or add the key manually: ${setup.secret}`);
  write('Type: time-based (TOTP), 6 digits, 30 seconds. Do not share this key.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = (await ask('Enter the 6-digit code from your authenticator:')).trim();
    try {
      const result = await request(`${authBase}/setup/confirm`, { code });
      write('Binding complete. Save the following one-time recovery codes now (shown only once):');
      for (const recovery of result.recovery_codes) write(recovery);
      write('Open the configured HTTPS domain to log in; wait for the authenticator to generate the next code.');
      return;
    } catch (error) {
      if (error.message !== 'AUTH_CODE_INVALID' || attempt === 2) throw error;
      write('The code is incorrect; try again.');
    }
  }
}

if (require.main === module) {
  const readline = require('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
  const { resolveLoginPath } = require('../lib/login-gate');
  enroll({ authBase: resolveLoginPath(process.env.CLIENT_LOGIN_PATH), ask: question => terminal.question(question) })
    .catch(error => { console.error(`Binding failed: ${error.message}`); process.exitCode = 1; })
    .finally(() => terminal.close());
}
module.exports = { enroll };

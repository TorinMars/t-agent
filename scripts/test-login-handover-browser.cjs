// Browser test of the login page taking a sign-in handed over by a linked engine (public/js/auth.js; "One login for linked engines" in
// docs/design/failover-and-one-login.md): the fragment is taken off the address at once, the token and nonce are posted to <login path>/handover
// and the page goes where the answer says; a refused hand-over shows the code login with the reason; a browser already signed in uses no token.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const LOGIN = '/hidden/door';
const file = name => fs.readFileSync(path.join(root, 'public', name), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const scenario of ['accepted', 'refused', 'signed-in']) {
      const context = await browser.newContext();
      const tab = await context.newPage();
      const posts = [];
      await tab.route('http://k01.test/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === LOGIN) return route.fulfill({ contentType: 'text/html', body: file('login.html') });
        if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) {
          return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: file(url.pathname.slice(1)) });
        }
        if (url.pathname === `${LOGIN}/status`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mode: 'remote', bound: true, authenticated: scenario === 'signed-in' }) });
        if (url.pathname === `${LOGIN}/handover`) {
          posts.push({ body: JSON.parse(request.postData()), requestedWith: request.headers()['x-requested-with'] });
          return scenario === 'accepted'
            ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, from: 'T01', redirect: '/h5' }) })
            : route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'HANDOVER_USED' }) });
        }
        if (url.pathname === '/h5') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1 id="page">page</h1>' });
        return route.fulfill({ status: 404, body: 'no' });
      });
      await tab.goto(`http://k01.test${LOGIN}?return_to=%2Fh5#handover=TOKEN.PART&n=${'n'.repeat(43)}`);
      if (scenario === 'accepted') {
        await tab.waitForSelector('#page');
        assert.deepEqual(posts, [{ body: { token: 'TOKEN.PART', nonce: 'n'.repeat(43), return_to: '/h5' }, requestedWith: 'XMLHttpRequest' }]);
        assert.equal(new URL(tab.url()).pathname, '/h5');
      } else if (scenario === 'refused') {
        await tab.waitForSelector('#login-form');
        assert.equal(new URL(tab.url()).hash, '', 'the fragment is gone from the address');
        assert.equal(await tab.textContent('#auth-error'), 'The sign-in from your other device was already used. Log in with your code here.');
        assert.equal(posts.length, 1);
      } else {
        await tab.waitForSelector('#page');
        assert.equal(posts.length, 0, 'signed in already: the token is not used');
      }
      await context.close();
    }
    console.log('Login hand-over: the fragment is removed, the token is posted once, a refusal shows the code login, a signed-in browser uses none.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

// Browser test of what happens when the login expires while a page is open: the phone page and the desktop page both go to the login entrance and come back
// to the page that was open; a real "not found" does not log anyone out.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const clientAuth = fs.readFileSync(path.join(root, 'public/js/client-auth.js'), 'utf8');
const LOGIN = '/torin/hide/login';

// The phone page loads client-auth.js, ahead of its own script.
const h5 = fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8');
assert.ok(h5.indexOf('/js/client-auth.js') > 0 && h5.indexOf('/js/client-auth.js') < h5.indexOf('/js/h5.js'), 'h5.html loads client-auth.js before h5.js');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [page, back] of [['/h5', '%2Fh5'], ['/web', '%2Fweb']]) {
      for (const authenticated of [false, true]) {
        const context = await browser.newContext();
        const tab = await context.newPage();
        await tab.route('http://app.test/**', route => {
          const url = new URL(route.request().url());
          if (url.pathname === page) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="t-agent-login-path" content="${LOGIN}"><script>${clientAuth}</script><body>page</body>` });
          if (url.pathname === `${LOGIN}/status`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated }) });
          if (url.pathname === LOGIN) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>login</body>' });
          if (url.pathname === '/api/tasks') return route.fulfill({ status: 404, contentType: 'text/html', body: 'Cannot GET /api/tasks' });
          if (url.pathname === '/api/other') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'AUTH_REQUIRED' }) });
          return route.fulfill({ status: 404, body: 'no' });
        });
        await tab.goto(`http://app.test${page}`);
        await tab.evaluate(() => fetch('/api/tasks'));
        if (authenticated) {
          // The 404 is a real "not found" (the session is fine): the page stays where it is.
          await tab.waitForTimeout(300);
          assert.equal(new URL(tab.url()).pathname, page, `${page}: a missing resource does not log out`);
        } else {
          await tab.waitForURL(url => url.pathname === LOGIN, { timeout: 5000 });
          assert.equal(new URL(tab.url()).search, `?return_to=${back}`, `${page}: the login brings the person back to the page that was open`);
        }
        if (!authenticated) {
          // A 401 that says the login is required leads there too.
          const second = await context.newPage();
          await second.route('http://app.test/**', route => (new URL(route.request().url()).pathname === page
            ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="t-agent-login-path" content="${LOGIN}"><script>${clientAuth}</script>` })
            : new URL(route.request().url()).pathname === LOGIN ? route.fulfill({ contentType: 'text/html', body: 'login' }) : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'AUTH_REQUIRED' }) })));
          await second.goto(`http://app.test${page}`);
          await second.evaluate(() => fetch('/api/other'));
          await second.waitForURL(url => url.pathname === LOGIN, { timeout: 5000 });
          assert.equal(new URL(second.url()).search, `?return_to=${back}`);
        }
        await context.close();
      }
    }
    console.log('Session redirect: the phone page and the desktop page go to the login entrance and back, and a missing resource does not log anyone out.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

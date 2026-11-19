// For the browser tests that draw the page shell into a page of their own (Playwright, the API mocked in the page): public/js/h5-shell.js is an ES
// module that imports its chunks from /js/chunks/ (scripts/build-page-bundles.js), so it cannot be added as inline text. `addShell(page)` serves the
// bundle and its chunks from public/js on the page's own origin and adds it as a module script; it resolves once the module has run (window.H5UI is
// set and the shell is drawn), like the inline script did. The screens that open on demand (Settings, T-Attention, the design sheet) load their
// chunks the same way when they open.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_JS = path.resolve(__dirname, '..', 'public', 'js');

async function serveBundles(page) {
  const origin = new URL(page.url()).origin;
  const serve = route => {
    const file = path.join(PUBLIC_JS, new URL(route.request().url()).pathname.replace(/^\/js\//, ''));
    if (!file.startsWith(`${PUBLIC_JS}${path.sep}`) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file) });
  };
  await page.route(`${origin}/js/h5-shell.js`, serve);
  await page.route(`${origin}/js/chunks/**`, serve);
}

// The page's registry of browser storage (public/js/local-keys.js) runs before the shell, as on the page; a test that added it already keeps that one.
async function addShell(page) {
  await serveBundles(page);
  if (!(await page.evaluate(() => Boolean(window.TALocalKeys)))) await page.addScriptTag({ content: fs.readFileSync(path.join(PUBLIC_JS, 'local-keys.js'), 'utf8') });
  await page.addScriptTag({ url: '/js/h5-shell.js', type: 'module' });
}

module.exports = { addShell, serveBundles };

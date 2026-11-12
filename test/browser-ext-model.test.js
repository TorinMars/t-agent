// The pure parts of Settings → Tasks and files → Browser extension (scripts/h5-shell/browser-ext-model.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'browser-ext-model.mjs')).href);

test('the code in two groups of four; anything else as it is', async () => {
  const { pairCodeText } = await load();
  assert.equal(pairCodeText('ABCD2345'), 'ABCD 2345');
  assert.equal(pairCodeText('ABC'), 'ABC');
  assert.equal(pairCodeText(null), '');
});

test('the detail line of a browser', async () => {
  const { browserDetail } = await load();
  assert.equal(browserDetail({ version: '1.0.0', browser: { name: 'Chrome' }, online: true }), 'Extension 1.0.0 · Chrome · Connected now');
  assert.equal(browserDetail({ version: '1.0.0', online: false, last_seen_at: '2026-11-12T10:04:59.000Z' }), 'Extension 1.0.0 · Last seen 2026-11-12 10:04');
  assert.equal(browserDetail({ online: false, last_seen_at: null }), 'Never connected');
  assert.equal(browserDetail({ online: true }, { t: text => `[${text}]` }), '[Connected now]');
  assert.equal(browserDetail(null), '');
});

test('the browser the code just paired, and the normalised answer', async () => {
  const { newlyPaired, normalizeStatus } = await load();
  assert.equal(newlyPaired(['br_a'], [{ browser_id: 'br_a' }, { browser_id: 'br_b', name: 'New' }]).name, 'New');
  assert.equal(newlyPaired(['br_a'], [{ browser_id: 'br_a' }]), null);
  assert.equal(newlyPaired(null, null), null);
  assert.deepEqual(normalizeStatus(null), { browsers: [], connected: false, extensionDir: '', extensionPresent: false, serverUrl: '' });
  const status = normalizeStatus({ browsers: [{ browser_id: 'br_a' }, { nope: 1 }], connected: true, extension_dir: '/opt/t/extensions/chrome', extension_present: true, server_url: 'http://127.0.0.1:3000' });
  assert.deepEqual(status, { browsers: [{ browser_id: 'br_a' }], connected: true, extensionDir: '/opt/t/extensions/chrome', extensionPresent: true, serverUrl: 'http://127.0.0.1:3000' });
});

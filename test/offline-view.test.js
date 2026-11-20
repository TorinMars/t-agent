// The offline view's words (public/js/offline.js `view`, pure), its address probe, and the service worker text the server sends (lib/service-worker.js):
// "The page while its engine is down" in docs/design/failover-and-one-login.md. The browser side is scripts/test-offline-view-browser.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-offline-view-'));
const { view, firstAnswering, remembered } = require('../public/js/offline');
const { createServiceWorkerSource, OFFLINE_FILES, PLACEHOLDER } = require('../lib/service-worker');

test('the view names the engine that is down and offers each linked engine that answered', () => {
  assert.deepEqual(view({ selfName: 'T01', reachable: [{ name: 'K01', address: 'http://k01:3000' }], probing: false }), {
    title: "T01 can't be reached",
    text: 'Your tasks on K01 are still running. Continue there; this page comes back by itself when T01 answers.',
    buttons: [{ label: 'Continue on K01', address: 'http://k01:3000', name: 'K01' }],
  });
  const two = view({ selfName: 'T01', reachable: [{ name: 'K01', address: 'a' }, { name: 'K02', address: 'b' }], probing: false });
  assert.match(two.text, /^Your tasks on K01 and K02 are still running/);
  assert.equal(two.buttons.length, 2);
  assert.deepEqual(view({ selfName: 'T01', reachable: [], probing: true }).buttons, []);
  assert.equal(view({ selfName: 'T01', reachable: [], probing: true }).text, 'Looking for your other devices…');
  assert.equal(view({ selfName: 'T01', reachable: [], probing: false }).text, 'No other device answers either. This page comes back by itself when T01 answers.');
  // Nothing remembered (the page never ran here, or storage was blocked): it still says what is going on.
  assert.equal(view({ selfName: '', reachable: [], probing: false }).title, "This engine can't be reached");
});

test('the probe takes the first address that answers, without credentials, and none when nothing answers', async () => {
  const asked = [];
  const fetchImpl = async (url, options) => { asked.push([url, options.credentials, options.mode]); if (!url.startsWith('http://b')) throw new TypeError('down'); return {}; };
  assert.equal(await firstAnswering(['http://a:1', 'http://b:2', 'http://c:3'], fetchImpl), 'http://b:2');
  assert.deepEqual(asked, [['http://a:1/health', 'omit', 'no-cors'], ['http://b:2/health', 'omit', 'no-cors']]);
  assert.equal(await firstAnswering(['http://a:1'], fetchImpl), null);
});

test('what was remembered is read defensively', () => {
  assert.deepEqual(remembered({ get: () => 'not json' }), { self: {}, peers: [] });
  assert.deepEqual(remembered(null), { self: {}, peers: [] });
  assert.deepEqual(remembered({ get: () => JSON.stringify({ self: { name: 'T01' }, peers: [{ name: 'K01' }] }) }), { self: { name: 'T01' }, peers: [{ name: 'K01' }] });
});

test('the service worker carries the hash of the offline files, and a change of one gives it new bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-sw-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'sw.js'), `const OFFLINE_VERSION = '${PLACEHOLDER}';`);
  for (const file of OFFLINE_FILES) fs.writeFileSync(path.join(dir, file), `content of ${file}`);
  const source = createServiceWorkerSource({ publicDir: dir });
  const first = source();
  assert.match(first, /^const OFFLINE_VERSION = '[0-9a-f]{16}';$/);
  assert.equal(source(), first);
  fs.writeFileSync(path.join(dir, 'js/offline.js'), 'changed, and longer than before');
  assert.notEqual(source(), first);
  // The real worker has the placeholder exactly once, and lists the same files.
  const real = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.equal(real.split(PLACEHOLDER).length, 2);
  for (const file of OFFLINE_FILES) assert.ok(real.includes(`'/${file}'`), file);
  assert.ok(!/notificationclick|showNotification/.test(real), 'the worker shows no notifications');
});

// The page's side of "Sign in on <engine> too" (scripts/h5-shell/sign-in-handover.mjs): the SHA-256 that stands in where crypto.subtle is missing,
// the address probe, and the whole flow with fakes: the nonce stays in the browser (only its hash is posted), the tab opens the address with the
// token and nonce in the fragment, and a failure closes the tab. "One login for linked engines" in docs/design/failover-and-one-login.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-h5-sign-in-'));
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'sign-in-handover.mjs')).href);

test('the SHA-256 matches Node\'s for short, block-sized and long texts, and Chinese text', async () => {
  const { sha256Base64url } = await load();
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000), '登录', crypto.randomBytes(32).toString('base64url')]) {
    assert.equal(sha256Base64url(text), crypto.createHash('sha256').update(text, 'utf8').digest('base64url'), `length ${text.length}`);
  }
});

test('the hand-over posts only the nonce hash and opens the first answering address with the token and nonce in the fragment', async () => {
  const { signInOn } = await load();
  const posts = [];
  const win = { opener: {}, location: { href: 'about:blank' }, closed: false, close() { this.closed = true; } };
  const fetchImpl = async url => { if (url.startsWith('http://dead')) throw new TypeError('down'); return {}; };
  const address = await signInOn({
    peer: { instance_id: 'inst-k01', name: 'K01', addresses: ['http://dead:1', 'http://k01.lan:3000'] },
    api: async (method, url, body) => { posts.push([method, url, body]); return { token: 'BODY.MAC' }; },
    win, pagePath: '/h5', fetchImpl, navigate: () => assert.fail('the opened tab is used'),
  });
  assert.equal(address, 'http://k01.lan:3000');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].slice(0, 2), ['POST', '/api/sign-in-handover']);
  assert.equal(posts[0][2].target, 'inst-k01');
  const target = new URL(win.location.href);
  assert.equal(target.origin + target.pathname, 'http://k01.lan:3000/h5');
  assert.equal(target.search, '', 'nothing in a query a server would log');
  const fragment = new URLSearchParams(target.hash.slice(1));
  assert.equal(fragment.get('handover'), 'BODY.MAC');
  const nonce = fragment.get('n');
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(posts[0][2].nonce_hash, crypto.createHash('sha256').update(nonce).digest('base64url'));
  assert.ok(!JSON.stringify(posts).includes(nonce), 'the nonce itself never goes to this engine');
  assert.equal(win.opener, null);
});

test('no answering address, or a refusal, closes the tab and says why', async () => {
  const { signInOn, handoverError } = await load();
  const win = { location: {}, closed: false, close() { this.closed = true; } };
  await assert.rejects(signInOn({ peer: { instance_id: 'i', name: 'K01', addresses: ['http://dead:1'] }, api: async () => assert.fail('no request'), win, pagePath: '/', fetchImpl: async () => { throw new TypeError('down'); }, navigate: () => {} }), /HANDOVER_NO_ADDRESS/);
  assert.equal(win.closed, true);
  const refused = { location: {}, closed: false, close() { this.closed = true; } };
  await assert.rejects(signInOn({ peer: { instance_id: 'i', name: 'K01', addresses: ['http://k01:1'] }, api: async () => { throw new Error('HANDOVER_OFF_THERE'); }, win: refused, pagePath: '/', fetchImpl: async () => ({}), navigate: () => {} }), /HANDOVER_OFF_THERE/);
  assert.equal(refused.closed, true);
  assert.equal(handoverError('HANDOVER_OFF_THERE', 'K01'), 'K01 does not accept sign-in from linked devices');
  assert.equal(handoverError('SOMETHING_ELSE', 'K01'), null);
  // A blocked pop-up: this tab goes instead.
  let went = null;
  await signInOn({ peer: { instance_id: 'i', name: 'K01', addresses: ['http://k01:1'] }, api: async () => ({ token: 'T.M' }), win: null, pagePath: '/', fetchImpl: async () => ({}), navigate: url => { went = url; } });
  assert.match(went, /^http:\/\/k01:1\/#handover=T\.M&n=/);
});

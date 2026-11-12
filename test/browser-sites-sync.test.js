// The site library as a synced setting (services/settings-sync.js registry entry 'browser-sites', scope 'shared'): two in-process sync services joined
// by one link, each backed by its own browser-sites store, exchanging values through the real engine handlers (as settings-sync.test.js does). An entry
// made on A reaches B, a change on B reaches A, and a delete propagates as a tombstone. The per-site merge keeps both when A and B edit different sites.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createSettingsSync, CAPABILITY } = require('../services/settings-sync');
const { createBrowserSites } = require('../services/browser-sites');

const LINK = '0b9a2f7c-1d2e-4f3a-8b4c-5d6e7f8a9b0c';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_TO_B = `tae_${'a'.repeat(43)}`;
const TOKEN_TO_A = `tae_${'b'.repeat(43)}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function sitesDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
}

function pair() {
  const wire = [];
  const make = (name, instanceId, peerName, token, ownHash) => {
    const clock = { now: 1000 };
    const sites = createBrowserSites({ db: sitesDb(), now: () => clock.now, deviceName: () => name, settingChanged: () => {} });
    const peer = { id: LINK, name: peerName, online: true, remoteServerId: 1, instanceId: null, baseUrl: `fake://${peerName}`, token };
    const links = { peers: () => [peer], onChange: () => () => {}, noteUnauthorized() {} };
    const registry = [{
      key: 'browser-sites', secret: false,
      read: () => sites.exportForSync(),
      write: (owner, value) => sites.importFromSync(value),
    }];
    const side = { name, instanceId, clock, sites, peer };
    side.service = createSettingsSync({
      db: sitesDb(), sessionSecret: `${name}-session-secret`, serviceLinks: links, registry, owner: () => 'owner',
      identity: () => ({ instance_id: instanceId, name }), issuedTokenHash: () => ownHash,
      request: (...args) => dispatch(side, ...args), now: () => clock.now, log: { warn() {}, error() {}, info() {} }, intervalMs: 0, debounceMs: 5,
    });
    return side;
  };
  const a = make('A', ID_A, 'B', TOKEN_TO_B, sha(TOKEN_TO_A));
  const b = make('B', ID_B, 'A', TOKEN_TO_A, sha(TOKEN_TO_B));
  a.other = b; b.other = a;
  async function dispatch(from, baseUrl, route, token, opts = {}) {
    const target = from.other;
    const body = opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body));
    const method = opts.method || 'GET';
    wire.push(`${from.name} ${method} ${route.split('?')[0]}`);
    const link = { id: LINK, revoked: false, peer_instance_id: from.instanceId };
    const url = new URL(route, 'http://peer');
    let answer;
    if (url.pathname === '/v1/info') answer = { capabilities: [CAPABILITY] };
    else if (method === 'GET' && url.pathname === '/v1/settings-sync') answer = target.service.engineDescribe(link, url.searchParams.get('public_key'));
    else if (method === 'POST' && url.pathname === '/v1/settings-sync/pull') answer = target.service.enginePull(link, body);
    else if (method === 'PUT' && url.pathname === '/v1/settings-sync') answer = target.service.enginePush(link, body);
    else throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
    return JSON.parse(JSON.stringify(answer));
  }
  return { a, b, wire };
}

test('an entry made on A appears on B, an edit on B reaches A, and a delete propagates', async () => {
  const { a, b } = pair();

  // A saves a site at t=2000, then syncs: B should receive it.
  a.clock.now = 2000;
  a.sites.save('github.com', { title: 'GitHub', summary: 'Code host' });
  await a.service.syncAll();
  assert.ok(b.sites.get('github.com'), 'B received the entry');
  assert.equal(b.sites.get('github.com').title, 'GitHub');

  // B edits the same site at t=3000, then syncs: A should see the newer title.
  b.clock.now = 3000;
  b.sites.edit('github.com', { title: 'GitHub (edited on B)' });
  await b.service.syncAll();
  assert.equal(a.sites.get('github.com').title, 'GitHub (edited on B)', 'A received B’s edit');

  // A deletes the site at t=4000, then syncs: B should delete it too (tombstone).
  a.clock.now = 4000;
  a.sites.remove('github.com');
  await a.service.syncAll();
  assert.equal(b.sites.get('github.com'), null, 'the delete propagated to B');
});

test('a different site on each device: the merge accumulates, converging on the next change (self-healing)', async () => {
  const { a, b } = pair();
  // Edited at different times (the usual case): each device keeps both after the exchange.
  a.clock.now = 2000; a.sites.save('github.com', { title: 'GitHub' });
  await a.service.syncAll();
  b.clock.now = 3000; b.sites.save('example.com', { title: 'Example' });
  await b.service.syncAll();
  for (const side of [a, b]) {
    assert.ok(side.sites.get('github.com'), `${side.name} has github.com`);
    assert.ok(side.sites.get('example.com'), `${side.name} has example.com`);
  }

  // A device that pulled a peer's set holds the union at once; the peer catches up on its next change. (The whole set is exchanged, merged per site
  // on import, so the only lag is a device whose last edit lost the set-level tie; any later save / delete there re-stamps the union and propagates.)
  const { a: c, b: d } = pair();
  c.clock.now = 2000; c.sites.save('alpha.com', { title: 'Alpha' });
  d.clock.now = 2000; d.sites.save('beta.com', { title: 'Beta' });   // same tick: a set-level tie
  await c.service.syncAll();
  const union = s => Boolean(s.sites.get('alpha.com')) && Boolean(s.sites.get('beta.com'));
  assert.ok(union(c) || union(d), 'the device that pulled holds the union right away');
  // A later change on either device re-stamps its whole set newer, so both converge to the union.
  (union(c) ? c : d).clock.now = 5000;
  (union(c) ? c : d).sites.save('gamma.com', { title: 'Gamma' });
  await (union(c) ? c : d).service.syncAll();
  for (const side of [c, d]) {
    assert.ok(side.sites.get('alpha.com'), `${side.name} has alpha.com after self-heal`);
    assert.ok(side.sites.get('beta.com'), `${side.name} has beta.com after self-heal`);
  }
});

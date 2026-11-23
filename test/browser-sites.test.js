// The site capability library service (services/browser-sites.js): host normalisation, validation and size limits, redaction and the SITE_HAS_SECRET
// refusal, list / get / search, delete with tombstones, and the per-site merge of the settings-sync adapters (exportForSync / importFromSync).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createBrowserSites, BrowserSiteError, ENTRY_SCHEMA, ENTRY_EXAMPLE, validateEntry, buildEntry } = require('../services/browser-sites');

function store() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  let clock = 1000;
  const changes = [];
  const service = createBrowserSites({ db, now: () => clock, deviceName: () => 'DevA', settingChanged: group => changes.push(group) });
  return { db, service, changes, tick: (ms = 1) => { clock += ms; return clock; }, setClock: v => { clock = v; } };
}

test('host normalisation: lowercases, drops www. and a URL / port / path', () => {
  const { service } = store();
  const n = s => service.normalizeHost(s);
  assert.equal(n('GitHub.com'), 'github.com');
  assert.equal(n('www.GitHub.com'), 'github.com');
  assert.equal(n('https://www.github.com/foo?x=1'), 'github.com');
  assert.equal(n('API.example.com:8443'), 'api.example.com');
  assert.equal(n('localhost'), 'localhost');
  assert.equal(n('127.0.0.1'), '127.0.0.1');
  for (const bad of ['', '   ', 'not a host', 'http://', 'a..b']) assert.throws(() => n(bad), e => e instanceof BrowserSiteError && e.code === 'INVALID_SITE', `should reject ${JSON.stringify(bad)}`);
});

test('save validates the shape, stamps the sync clock and notifies settings-sync', () => {
  const { service, changes } = store();
  const entry = service.save('www.github.com', {
    title: 'GitHub', summary: '# GitHub\nCode host',
    pages: [{ pattern: 'https://github.com/{o}/{r}', purpose: 'A repo' }],
    actions: [{ name: 'search', description: 'Search', steps: ['tcli browser type css:#q hi --submit'], selectors: { box: '#q' } }],
    apis: [{ name: 'repos', method: 'get', url: 'https://api.github.com/users/{u}/repos', auth: 'page cookies', params: [{ name: 'u', required: true }] }],
    notes: 'Needs sign in',
    unknownTopLevelKey: 'dropped',
  });
  assert.equal(entry.site, 'github.com');
  assert.equal(entry.title, 'GitHub');
  assert.equal(entry.apis[0].method, 'GET');
  assert.equal(entry.version, 1);
  assert.ok(entry.updated_at >= 1000);
  assert.equal(entry.updated_by, 'DevA');
  assert.equal(entry.unknownTopLevelKey, undefined, 'unknown top-level keys are dropped');
  assert.deepEqual(changes, ['browser-sites']);
  assert.equal(service.get('github.com').title, 'GitHub');
});

test('invalid shapes and oversize fields are refused', () => {
  const { service } = store();
  assert.throws(() => service.save('x.com', { pages: [{ purpose: 'no pattern' }] }), e => e.code === 'INVALID_SITE');
  assert.throws(() => service.save('x.com', { actions: [{ steps: ['s'] }] }), e => e.code === 'INVALID_SITE', 'action needs a name');
  assert.throws(() => service.save('x.com', { title: 'x'.repeat(201) }), e => e.code === 'SITE_TOO_LARGE');
  assert.throws(() => service.save('x.com', { summary: 'y'.repeat(256 * 1024 + 1) }), e => e.code === 'SITE_TOO_LARGE');
  assert.throws(() => service.save('x.com', 'not an object'), e => e.code === 'INVALID_SITE');
});

test('a save reports every problem at once, "field: problem", with the error code kept', () => {
  const { service } = store();
  let caught;
  try {
    service.save('x.com', { title: 7, pages: [{ purpose: 'no pattern' }, 'nope'], actions: [{ steps: ['ok', 3] }], apis: [{ name: 'a', params: 'id', method: ['GET'] }], sources: ['rec_1', { at: 'soon' }] });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof BrowserSiteError);
  assert.equal(caught.code, 'INVALID_SITE');
  assert.deepEqual(caught.problems.map(item => `${item.field}: ${item.problem}`), [
    'title: must be text',
    'pages[0].pattern: is required',
    'pages[1]: must be an object',
    'actions[0].name: is required',
    'actions[0].steps[1]: must be text',
    'apis[0].method: must be text',
    'apis[0].params: must be a list',
    'sources[0]: must be an object',
    'sources[1].at: must be a time (milliseconds since 1970)',
  ]);
  assert.match(caught.message, /^The entry has 9 problems \(the entry format: tcli site schema\):\n {2}title: must be text\n {2}pages\[0\]\.pattern: is required\n/);
  assert.equal(service.get('x.com'), null, 'nothing saved');
  // Only sizes wrong: SITE_TOO_LARGE, still every one.
  assert.throws(() => service.save('x.com', { title: 'x'.repeat(201), notes: 'n'.repeat(64 * 1024 + 1) }), e => e.code === 'SITE_TOO_LARGE' && e.problems.length === 2);
  // A size among other problems: INVALID_SITE.
  assert.throws(() => service.save('x.com', { title: 'x'.repeat(201), pages: 'p' }), e => e.code === 'INVALID_SITE' && e.problems.length === 2);
  // One problem: one line.
  assert.throws(() => service.save('x.com', { pages: {} }), e => e.message === 'pages: must be a list (the entry format: tcli site schema)');
  assert.throws(() => service.edit('x.com', { pages: [{}], apis: [{}] }), e => e.problems.length === 2, 'edit validates the same way');
});

test('ENTRY_SCHEMA is what the validator checks: the example passes unchanged, every schema field is kept, other keys are dropped', () => {
  assert.deepEqual(validateEntry(ENTRY_EXAMPLE), []);
  assert.deepEqual(buildEntry('github.com', ENTRY_EXAMPLE), { site: 'github.com', ...ENTRY_EXAMPLE });
  // Every field the schema names (top level and inside the example's objects) is in the example, so the round trip above covers each.
  const walk = (spec, value, where) => {
    if (spec.type === 'object') for (const name of Object.keys(spec.fields)) { assert.ok(value && name in value, `${where}${name} is in the example`); walk(spec.fields[name], value[name], `${where}${name}.`); }
    if (spec.type === 'list' && value.length) {
      const objectSpec = spec.items.type === 'one_of' ? spec.items.options.find(option => option.type === 'object') : spec.items;
      walk(objectSpec, spec.items.type === 'one_of' ? value.find(item => typeof item === 'object') : value[0], `${where}[0].`);
    }
  };
  walk(ENTRY_SCHEMA, ENTRY_EXAMPLE, '');
  const extra = buildEntry('a.com', { title: 'A', bogus: 1, pages: [{ pattern: '/x', bogus: 2 }] });
  assert.deepEqual(extra, { site: 'a.com', title: 'A', pages: [{ pattern: '/x' }], actions: [], apis: [], sources: [] });
  // A required field of the schema is the one the validator asks for.
  const required = [];
  const collect = (spec, where) => {
    if (spec.required) required.push(where);
    if (spec.type === 'object') for (const [name, child] of Object.entries(spec.fields)) collect(child, where ? `${where}.${name}` : name);
    if (spec.type === 'list') collect(spec.items, `${where}[0]`);
    if (spec.type === 'one_of') for (const option of spec.options) if (option.type === 'object') collect(option, where);
  };
  collect(ENTRY_SCHEMA, '');
  const missing = validateEntry({ pages: [{}], actions: [{ steps: [''] }], apis: [{ params: [{}] }] }).filter(item => item.problem === 'is required').map(item => item.field);
  assert.deepEqual(missing.sort(), required.sort());
});

test('redaction rewrites secret-named keys and JWT / bearer values', () => {
  const { service } = store();
  const entry = service.save('ok.com', {
    apis: [{ name: 'a', url: 'https://ok.com', request_example: 'Authorization: Bearer abcdef1234567890xyz', params: [{ name: 'session_token', description: 'eyJhbGciOiJ.eyJzdWIiOiIxIn0.sig' }] }],
  });
  assert.match(entry.apis[0].request_example, /^<redacted:\d+>$/, 'a bearer value is redacted');
  assert.match(entry.apis[0].params[0].description, /^<redacted:\d+>$/, 'a value under a secret-named key is redacted');
});

test('an entry that still holds a token is refused with SITE_HAS_SECRET', () => {
  const { service } = store();
  assert.throws(() => service.save('evil.com', { notes: 'the key is NOTAREALKEY0000testfixture1234567890abcd' }),
    e => e instanceof BrowserSiteError && e.code === 'SITE_HAS_SECRET');
  assert.equal(service.get('evil.com'), null, 'nothing is stored when it is refused');
});

test('edit merges fields, bumps the version, and null clears a field', () => {
  const { service, tick } = store();
  service.save('github.com', { title: 'GitHub', notes: 'old' });
  tick();
  const edited = service.edit('github.com', { notes: 'new', summary: '# Hi' });
  assert.equal(edited.version, 2);
  assert.equal(edited.notes, 'new');
  assert.equal(edited.title, 'GitHub', 'untouched fields stay');
  const cleared = service.edit('github.com', { notes: null });
  assert.equal(cleared.notes, undefined);
});

test('list returns light summaries sorted by host; search finds text across fields', () => {
  const { service } = store();
  service.save('github.com', { title: 'GitHub', summary: 'Code hosting for teams', actions: [{ name: 'search repos', steps: ['do it'] }] });
  service.save('example.com', { title: 'Example', summary: 'A demo site' });
  const list = service.list();
  assert.deepEqual(list.map(i => i.site), ['example.com', 'github.com']);
  assert.equal(list.find(i => i.site === 'github.com').actions, 1);
  assert.deepEqual(service.list({ query: 'demo' }).map(i => i.site), ['example.com']);
  const hits = service.search('repos');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].site, 'github.com');
  assert.ok(hits[0].matches.some(m => m.where.startsWith('action:')));
  assert.throws(() => service.search('   '), e => e.code === 'INVALID_SEARCH');
});

test('remove deletes the entry, records a tombstone, and notifies settings-sync', () => {
  const { service, changes, tick } = store();
  service.save('github.com', { title: 'GitHub' });
  changes.length = 0;
  tick();
  const result = service.remove('www.github.com');
  assert.deepEqual(result, { removed: true, site: 'github.com' });
  assert.equal(service.get('github.com'), null);
  assert.deepEqual(changes, ['browser-sites']);
  const exported = service.exportForSync();
  assert.ok(exported.tombstones['github.com'], 'the deletion is a tombstone in the shared set');
  assert.equal(exported.sites['github.com'], undefined);
  // Removing a host that has no entry still records a tombstone but reports removed:false.
  assert.deepEqual(service.remove('absent.com'), { removed: false, site: 'absent.com' });
});

test('importFromSync merges per site: a newer peer entry wins, a tombstone deletes, an older peer value is ignored', () => {
  const { service, setClock } = store();
  setClock(5000);
  service.save('github.com', { title: 'local GitHub' }); // updated_at ~5000, by DevA

  // A peer's newer entry for the same host wins.
  assert.equal(service.importFromSync({ sites: { 'github.com': { site: 'github.com', title: 'peer GitHub', updated_at: 9000, updated_by: 'DevB', version: 1 } }, tombstones: {} }), true);
  assert.equal(service.get('github.com').title, 'peer GitHub');

  // An older peer value for the same host is ignored.
  assert.equal(service.importFromSync({ sites: { 'github.com': { site: 'github.com', title: 'stale', updated_at: 1, updated_by: 'DevB' } }, tombstones: {} }), false);
  assert.equal(service.get('github.com').title, 'peer GitHub');

  // A brand-new host from the peer is added.
  assert.equal(service.importFromSync({ sites: { 'news.com': { site: 'news.com', title: 'News', updated_at: 100, updated_by: 'DevB' } }, tombstones: {} }), true);
  assert.equal(service.get('news.com').title, 'News');

  // A newer tombstone deletes a local entry.
  assert.equal(service.importFromSync({ sites: {}, tombstones: { 'github.com': { updated_at: 20000, updated_by: 'DevB' } } }), true);
  assert.equal(service.get('github.com'), null);

  // A peer entry older than our tombstone does not resurrect the host.
  assert.equal(service.importFromSync({ sites: { 'github.com': { site: 'github.com', title: 'back', updated_at: 100, updated_by: 'DevB' } }, tombstones: {} }), false);
  assert.equal(service.get('github.com'), null);
});

test('importFromSync drops a peer entry that still leaks a secret, and ignores an empty / null value', () => {
  const { service } = store();
  assert.equal(service.importFromSync(null), false);
  assert.equal(service.importFromSync({ sites: { 'evil.com': { site: 'evil.com', notes: 'NOTAREALKEY0000testfixture1234567890abcd', updated_at: 9000, updated_by: 'DevB' } }, tombstones: {} }), false);
  assert.equal(service.get('evil.com'), null);
});

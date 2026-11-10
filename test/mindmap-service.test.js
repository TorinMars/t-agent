const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMindmapService, MindmapError, LIMITS } = require('../services/mindmap');

const SECRET_WORD = 'do-not-log-this-content';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';

// A temporary data folder, a clock the test moves, and the log lines the service wrote.
function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-10T10:00:00.000Z');
  const logs = [];
  const service = createMindmapService({ dataDir, now: () => new Date(clock), log: line => logs.push(line), ...options });
  return { dataDir, service, logs, dir: path.join(dataDir, 'mindmaps'), tick: (ms = 1000) => { clock += ms; } };
}

const fails = (promise, code) => assert.rejects(promise, error => error instanceof MindmapError && error.code === code);
const modeOf = file => fs.statSync(file).mode & 0o777;
const mapFiles = dir => fs.readdirSync(dir).filter(name => name.endsWith('.json'));

test('create, read, update and list a map', async t => {
  const { service, tick } = setup(t);
  const created = await service.create({ title: '  Plan  ', data: { root: { topic: 'A' } } });
  assert.equal(created.title, 'Plan');
  assert.deepEqual(created.data, { root: { topic: 'A' } });
  assert.equal(created.revision, 1);
  assert.equal(created.created_at, created.updated_at);
  assert.deepEqual(Object.keys(created).sort(), ['created_at', 'data', 'id', 'revision', 'title', 'updated_at']);
  assert.deepEqual(await service.get(created.id), created);

  tick();
  const updated = await service.update(created.id, { revision: 1, data: { root: { topic: 'B' } } });
  assert.deepEqual(Object.keys(updated).sort(), ['id', 'revision', 'title', 'updated_at']);
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'Plan', 'a data-only save keeps the title');
  assert.notEqual(updated.updated_at, created.updated_at);
  const renamed = await service.update(created.id, { revision: 2, title: 'Renamed' });
  assert.equal(renamed.revision, 3);
  const stored = await service.get(created.id);
  assert.equal(stored.title, 'Renamed');
  assert.deepEqual(stored.data, { root: { topic: 'B' } }, 'a title-only save keeps the data');
  assert.equal(stored.created_at, created.created_at);

  const [summary, ...rest] = await service.list();
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(summary).sort(), ['created_at', 'id', 'revision', 'size', 'title', 'updated_at'], 'the list has no data');
  assert.equal(summary.revision, 3);
  assert.equal(summary.size, fs.statSync(path.join(service.dir, `${created.id}.json`)).size);
});

test('a missing title and missing data use the defaults', async t => {
  const { service } = setup(t);
  for (const body of [{}, undefined]) {
    const created = await service.create(body);
    assert.equal(created.title, 'Untitled map');
    assert.equal(created.data, null);
  }
});

test('the list is ordered by newest update and sees changes', async t => {
  const { service, tick } = setup(t);
  const first = await service.create({ title: 'First' });
  tick();
  const second = await service.create({ title: 'Second' });
  tick();
  const third = await service.create({ title: 'Third' });
  assert.deepEqual((await service.list()).map(map => map.title), ['Third', 'Second', 'First']);
  tick();
  await service.update(first.id, { revision: 1, title: 'First again' });
  assert.deepEqual((await service.list()).map(map => map.id), [first.id, third.id, second.id]);
  tick();
  await service.update(second.id, { revision: 1, data: { grown: 'x'.repeat(500) } });
  const [top] = await service.list();
  assert.equal(top.id, second.id);
  assert.equal(top.revision, 2);
  assert.ok(top.size > 500, 'the size follows the new content');
});

test('a stale revision is a conflict and writes nothing', async t => {
  const { service, tick } = setup(t);
  const created = await service.create({ title: 'One', data: { n: 1 } });
  await service.update(created.id, { revision: 1, data: { n: 2 } });
  const file = path.join(service.dir, `${created.id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  tick();
  await assert.rejects(service.update(created.id, { revision: 1, data: { n: 3 }, title: 'Lost' }), error => {
    assert.equal(error.code, 'MINDMAP_CONFLICT');
    assert.equal(error.statusCode, 409);
    assert.deepEqual(error.extra, { current_revision: 2 });
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('concurrent saves of one map cannot interleave: one wins per revision', async t => {
  const { service, dir } = setup(t);
  const { id } = await service.create({ title: 'Race', data: { n: 0 } });
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, n) => service.update(id, { revision: 1, data: { n: n + 1, fill: 'x'.repeat(20000) } })));
  const won = results.filter(result => result.status === 'fulfilled');
  assert.equal(won.length, 1, 'exactly one save at revision 1 wins');
  assert.equal(won[0].value.revision, 2);
  for (const lost of results.filter(result => result.status === 'rejected')) {
    assert.equal(lost.reason.code, 'MINDMAP_CONFLICT');
    assert.equal(lost.reason.extra.current_revision, 2);
  }
  const stored = await service.get(id);
  assert.equal(stored.revision, 2);
  assert.equal(stored.data.fill.length, 20000);

  // Saves that each know the revision they follow all land, in order.
  await Promise.all(Array.from({ length: 10 }, (_, n) => service.update(id, { revision: 2 + n, data: { n: 100 + n } })));
  const last = await service.get(id);
  assert.equal(last.revision, 12);
  assert.deepEqual(last.data, { n: 109 });
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no temp file is left');
});

test('a save and a delete of one map run one after the other', async t => {
  const { service } = setup(t);
  const { id } = await service.create({ title: 'Gone' });
  const [saved, removed, late] = await Promise.allSettled([
    service.update(id, { revision: 1, title: 'Saved first' }),
    service.remove(id),
    service.update(id, { revision: 2, title: 'Too late' }),
  ]);
  assert.equal(saved.status, 'fulfilled');
  assert.equal(removed.status, 'fulfilled');
  assert.equal(late.reason.code, 'MINDMAP_NOT_FOUND');
});

test('ids that are not UUIDs never reach a path', async t => {
  const { service, dataDir, logs } = setup(t);
  fs.writeFileSync(path.join(dataDir, 'db.sqlite'), 'keep');
  const bad = [
    '../db.sqlite', '../../etc/passwd', '..', '.', '', 'trash', '/etc/passwd', 'a/b', '%2e%2e', `${OTHER_ID}.json`, `${OTHER_ID}/..`, `${OTHER_ID}\n`, `${OTHER_ID}\u0000`,
    OTHER_ID.toUpperCase(), '11111111-1111-1111-8111-111111111111', null, undefined, 7, {}, ['x'],
  ];
  for (const id of bad) {
    await fails(service.get(id), 'MINDMAP_NOT_FOUND');
    await fails(service.update(id, { revision: 1, title: 'x' }), 'MINDMAP_NOT_FOUND');
    await fails(service.remove(id), 'MINDMAP_NOT_FOUND');
  }
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.sqlite'), 'utf8'), 'keep');
  assert.deepEqual(logs, []);
});

test('a well-formed id with no file is not found', async t => {
  const { service } = setup(t);
  await fails(service.get(OTHER_ID), 'MINDMAP_NOT_FOUND');
  await fails(service.update(OTHER_ID, { revision: 1, title: 'x' }), 'MINDMAP_NOT_FOUND');
  await fails(service.remove(OTHER_ID), 'MINDMAP_NOT_FOUND');
});

test('bad bodies are refused and write nothing', async t => {
  const { service, dir } = setup(t);
  const { id } = await service.create({ title: 'Keep' });
  const bad = [
    ...[null, [], 'text', 3].map(body => [body]),
    [{ title: '' }], [{ title: '   ' }], [{ title: 7 }], [{ title: null }], [{ title: 'a\nb' }], [{ title: 'a\rb' }], [{ title: 'a\u2028b' }], [{ title: 'x'.repeat(201) }],
    [{ data: [] }], [{ data: 'text' }], [{ data: 5 }], [{ data: null }], [{ data: true }],
  ];
  for (const [body] of bad) await fails(service.create(body), 'INVALID_MINDMAP');
  assert.equal(mapFiles(dir).length, 1);

  for (const body of [null, [], { title: 'x' }, { revision: '1', title: 'x' }, { revision: 1.5, title: 'x' }, { revision: -1, title: 'x' }, { revision: 1 }, { revision: 1, title: 'a\nb' }, { revision: 1, data: [] }, { revision: 1, data: null }]) {
    await fails(service.update(id, body), 'INVALID_MINDMAP');
  }
  assert.equal((await service.get(id)).revision, 1);
});

test('title length counts characters, not UTF-16 units', async t => {
  const { service } = setup(t);
  assert.equal((await service.create({ title: '\u{1F600}'.repeat(200) })).title.length, 400);
  assert.equal([...(await service.create({ title: '\u601d'.repeat(200) })).title].length, 200);
  await fails(service.create({ title: '\u601d'.repeat(201) }), 'INVALID_MINDMAP');
});

test('data nested too deep to serialise is a bad body, not a crash', async t => {
  const { service } = setup(t);
  let deep = {};
  for (let depth = 0; depth < 200000; depth += 1) deep = { a: deep };
  await fails(service.create({ data: deep }), 'INVALID_MINDMAP');
});

test('the serialised data limit gives MINDMAP_TOO_LARGE', async t => {
  const { service, dir } = setup(t);
  assert.equal(LIMITS.dataBytes, 8 * 1024 * 1024);
  const wrap = '{"x":""}'.length;
  const atLimit = await service.create({ data: { x: 'a'.repeat(LIMITS.dataBytes - wrap) } });
  assert.equal(atLimit.data.x.length, LIMITS.dataBytes - wrap);
  await fails(service.create({ data: { x: 'a'.repeat(LIMITS.dataBytes - wrap + 1) } }), 'MINDMAP_TOO_LARGE');
  await fails(service.update(atLimit.id, { revision: 1, data: { x: 'a'.repeat(LIMITS.dataBytes) } }), 'MINDMAP_TOO_LARGE');
  // Measured in UTF-8 bytes: three bytes per one of these characters.
  await fails(service.create({ data: { x: '\u601d'.repeat(Math.ceil(LIMITS.dataBytes / 3) + 1) } }), 'MINDMAP_TOO_LARGE');
  assert.equal(mapFiles(dir).length, 1);
  assert.equal((await service.get(atLimit.id)).revision, 1);
});

test('the map limit holds under concurrent creates', async t => {
  const { service, dir } = setup(t, { maxMaps: 3 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => service.create({ title: `Map ${n}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  for (const refused of results.filter(result => result.status === 'rejected')) {
    assert.equal(refused.reason.code, 'MINDMAP_LIMIT');
    assert.equal(refused.reason.statusCode, 409);
  }
  assert.equal(mapFiles(dir).length, 3);
  const [first] = await service.list();
  await service.remove(first.id);
  await service.create({ title: 'After a delete' });
  assert.equal(mapFiles(dir).length, 3, 'deleted maps do not count');
});

test('Chinese titles and content round trip through the file', async t => {
  const { service, dir } = setup(t);
  const title = '\u601d\u7ef4\u5bfc\u56fe \u{1F600}';
  const data = { root: { topic: '\u6839\u8282\u70b9', children: [{ topic: '\u5b50\u8282\u70b9 "\u5f15\u53f7"\n\u6362\u884c' }] } };
  const created = await service.create({ title, data });
  assert.equal(created.title, title);
  assert.deepEqual((await service.get(created.id)).data, data);
  assert.equal((await service.list())[0].title, title);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${created.id}.json`), 'utf8')).title, title);
  await service.update(created.id, { revision: 1, title: '\u65b0\u6807\u9898' });
  assert.equal((await service.get(created.id)).title, '\u65b0\u6807\u9898');
});

test('a corrupt file is skipped by the list and logged once with its id only', async t => {
  const { service, dir, logs } = setup(t);
  const good = await service.create({ title: 'Good' });
  const corrupted = await service.create({ title: 'Will break' });
  const wrongId = await service.create({ title: 'Wrong id' });
  const file = path.join(dir, `${corrupted.id}.json`);
  fs.writeFileSync(file, `{"title":"${SECRET_WORD}"`);
  fs.writeFileSync(path.join(dir, `${wrongId.id}.json`), JSON.stringify({ ...wrongId, id: OTHER_ID }));

  assert.deepEqual((await service.list()).map(map => map.id), [good.id]);
  assert.equal(logs.length, 2);
  assert.ok(logs.some(line => line.includes(corrupted.id)));
  assert.ok(logs.every(line => !line.includes(SECRET_WORD) && !line.includes(dir)), 'only ids are logged');
  await service.list();
  assert.equal(logs.length, 2, 'an unchanged corrupt file is not logged again');

  // It reads as absent, and a save cannot overwrite it.
  await fails(service.get(corrupted.id), 'MINDMAP_NOT_FOUND');
  await fails(service.update(corrupted.id, { revision: 1, title: 'x' }), 'MINDMAP_NOT_FOUND');
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(SECRET_WORD));
});

test('files that are not maps are ignored by the list', async t => {
  const { service, dir, logs } = setup(t);
  await service.create({ title: 'Real' });
  fs.writeFileSync(path.join(dir, 'notes.json'), 'not a map');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  assert.equal((await service.list()).length, 1);
  assert.deepEqual(logs, []);
});

test('delete moves the map to the trash, from where it can be restored by hand', async t => {
  const { service, dir, tick } = setup(t);
  const created = await service.create({ title: 'Keep me', data: { n: 1 } });
  tick();
  await service.remove(created.id);
  assert.deepEqual(mapFiles(dir), []);
  assert.deepEqual(await service.list(), []);
  await fails(service.get(created.id), 'MINDMAP_NOT_FOUND');
  await fails(service.remove(created.id), 'MINDMAP_NOT_FOUND');

  const trashed = fs.readdirSync(path.join(dir, 'trash'));
  assert.equal(trashed.length, 1);
  assert.match(trashed[0], new RegExp(`^${created.id}-2026-11-10T10-00-01-000Z\\.json$`));
  const inTrash = path.join(dir, 'trash', trashed[0]);
  assert.equal(modeOf(inTrash) & 0o077, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(inTrash, 'utf8')).data, { n: 1 });

  fs.renameSync(inTrash, path.join(dir, `${created.id}.json`));
  assert.deepEqual((await service.list()).map(map => map.id), [created.id]);
  assert.deepEqual((await service.get(created.id)).data, { n: 1 });
});

test('a corrupt file can still be deleted', async t => {
  const { service, dir } = setup(t);
  const created = await service.create({ title: 'Break' });
  fs.writeFileSync(path.join(dir, `${created.id}.json`), 'garbage');
  await service.remove(created.id);
  assert.deepEqual(mapFiles(dir), []);
  assert.equal(fs.readdirSync(path.join(dir, 'trash')).length, 1);
});

test('the folders are 0700 and the files 0600, and an open folder is tightened', { skip: process.platform === 'win32' }, async t => {
  const { service, dir, dataDir } = setup(t);
  const created = await service.create({ title: 'Private' });
  assert.equal(modeOf(dir), 0o700);
  assert.equal(modeOf(path.join(dir, 'trash')), 0o700);
  const file = path.join(dir, `${created.id}.json`);
  assert.equal(modeOf(file), 0o600);
  await service.update(created.id, { revision: 1, title: 'Still private' });
  assert.equal(modeOf(file), 0o600, 'a rewrite stays private');

  fs.chmodSync(dir, 0o755);
  const later = createMindmapService({ dataDir });
  await later.list();
  assert.equal(modeOf(dir), 0o700);
});

test('temp files left by a crash are removed, and maps are kept', async t => {
  const { service, dir, dataDir, logs } = setup(t);
  const created = await service.create({ title: 'Survivor' });
  fs.writeFileSync(path.join(dir, `.${created.id}.1.abc.tmp`), 'half written');
  const restarted = createMindmapService({ dataDir, log: line => logs.push(line) });
  assert.equal((await restarted.list()).length, 1);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(logs, []);
});

test('the factory needs a data folder, and creating one touches nothing on disk', t => {
  assert.throws(() => createMindmapService({}), /data folder/);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-mindmap-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createMindmapService({ dataDir });
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

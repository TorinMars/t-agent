// services/oss-files.js with a fake ali-oss client (test/helpers/fake-oss.js): every operation, the key rules, the active-content rule, the size
// caps, the error mapping, and that no answer, error or log line holds the AccessKey secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createOssImages } = require('../services/oss-images');
const { createOssFiles, OssFilesError, errorBody, MAX_PUT_BYTES, MAX_GET_BYTES } = require('../services/oss-files');
const { createFakeOss, memoryDb, CONFIG, SECRET, KEY_ID } = require('./helpers/fake-oss');

const OWNER = 'owner';
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const original = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); original.apply(console, args); };
}

function setup({ config = CONFIG } = {}) {
  const db = memoryDb();
  const fake = createFakeOss();
  const images = createOssImages({ db, sessionSecret: 'test-secret', createClient: options => fake.createClient(options) });
  if (config) images.saveConfig(OWNER, config);
  const files = createOssFiles({ images });
  return { db, fake, images, files };
}

async function rejects(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof OssFilesError, `expected OssFilesError, got ${error && error.stack}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.statusCode, status);
    assert.equal(String(error.message).includes(SECRET), false);
    return true;
  });
}

test('not configured, or upload not enabled: OSS_NOT_CONFIGURED (409) for every operation', async () => {
  const { files, images } = setup({ config: null });
  assert.equal(files.isConfigured(OWNER), false);
  await rejects(files.list(OWNER), 'OSS_NOT_CONFIGURED', 409);
  await rejects(files.stat(OWNER, 'a.txt'), 'OSS_NOT_CONFIGURED', 409);
  await rejects(files.get(OWNER, 'a.txt'), 'OSS_NOT_CONFIGURED', 409);
  await rejects(files.put(OWNER, 'a.txt', Readable.from([Buffer.from('x')]), { size: 1 }), 'OSS_NOT_CONFIGURED', 409);
  await rejects(files.copy(OWNER, 'a', 'b'), 'OSS_NOT_CONFIGURED', 409);
  await rejects(files.remove(OWNER, ['a']), 'OSS_NOT_CONFIGURED', 409);
  await rejects(files.sign(OWNER, 'a'), 'OSS_NOT_CONFIGURED', 409);
  images.saveConfig(OWNER, { ...CONFIG, enabled: false });
  await rejects(files.list(OWNER), 'OSS_NOT_CONFIGURED', 409);
});

test('the client gets the stored configuration; keys are relative to the bucket root (the upload prefix is not added)', async () => {
  const { files, fake } = setup();
  fake.store('top.txt', Buffer.from('hello'));
  const stat = await files.stat(OWNER, 'top.txt');
  assert.equal(stat.key, 'top.txt');
  assert.deepEqual(fake.calls.at(-1), ['head', 'top.txt']);
  const given = fake.options[0];
  assert.equal(given.bucket, 'tcli-bucket');
  assert.equal(given.region, 'oss-cn-hangzhou');
  assert.equal(given.accessKeyId, KEY_ID);
  assert.equal(given.accessKeySecret, SECRET, 'the secret reaches the SDK client only');
  assert.equal(given.secure, true);
});

test('key validation: 1..1023 bytes, no leading slash, no .. segment, no control characters, valid UTF-8', async () => {
  const { files } = setup();
  for (const key of ['', '/abs', 'a/../b', '..', 'a/..', 'tab\there', 'nl\n', 'del\u007f', 'c1\u0085', 'x'.repeat(1024), '\u4e2d'.repeat(342), 'lone\ud800', 42, null, ['a']]) {
    await rejects(files.stat(OWNER, key), 'INVALID_KEY', 400);
  }
  // Allowed: 1023 bytes, non-ASCII names, dots that are not a whole segment, spaces, a trailing slash.
  for (const key of ['x'.repeat(1023), '\u4e2d'.repeat(341), 'docs/\u8bbe\u8ba1 v2.md', 'a/.hidden', 'a/...b', 'folder/']) {
    await rejects(files.stat(OWNER, key), 'NOT_FOUND', 404);
  }
  await rejects(files.list(OWNER, { prefix: '/x' }), 'INVALID_ARGUMENT', 400);
  await rejects(files.list(OWNER, { prefix: 'a/../' }), 'INVALID_ARGUMENT', 400);
  await rejects(files.list(OWNER, { marker: 'm\n' }), 'INVALID_ARGUMENT', 400);
  await rejects(files.copy(OWNER, 'ok', '../bad'), 'INVALID_KEY', 400);
  await rejects(files.remove(OWNER, ['ok', '/bad']), 'INVALID_KEY', 400);
});

test('list: one level with prefixes, recursive without a delimiter, markers, max 1..1000', async () => {
  const { files, fake } = setup();
  for (const key of ['docs/a.md', 'docs/b.md', 'docs/sub/c.md', 'img/x.png', 'readme.txt']) fake.store(key, Buffer.from(key));
  const root = await files.list(OWNER);
  assert.deepEqual(root.prefixes.sort(), ['docs/', 'img/']);
  assert.deepEqual(root.objects.map(object => object.key), ['readme.txt']);
  assert.deepEqual(Object.keys(root.objects[0]).sort(), ['etag', 'key', 'last_modified', 'size', 'storage_class']);
  assert.equal(root.objects[0].size, 10);
  assert.equal(root.objects[0].last_modified, '2026-11-12T08:30:00.000Z');
  assert.match(root.objects[0].etag, /^[0-9A-F]{32}$/, 'quotes taken off the etag');
  assert.equal(root.truncated, false);
  assert.equal(root.next_marker, null);
  assert.deepEqual(fake.calls.at(-1), ['list', { 'max-keys': 100, delimiter: '/' }]);

  const docs = await files.list(OWNER, { prefix: 'docs/' });
  assert.deepEqual(docs.objects.map(object => object.key), ['docs/a.md', 'docs/b.md']);
  assert.deepEqual(docs.prefixes, ['docs/sub/']);

  const all = await files.list(OWNER, { prefix: 'docs/', delimiter: '' });
  assert.deepEqual(all.objects.map(object => object.key), ['docs/a.md', 'docs/b.md', 'docs/sub/c.md']);
  assert.equal(fake.calls.at(-1)[1].delimiter, undefined, 'recursive: no delimiter is sent');

  const page = await files.list(OWNER, { delimiter: '', max: '2' });
  assert.equal(page.objects.length, 2);
  assert.equal(page.truncated, true);
  const next = await files.list(OWNER, { delimiter: '', max: 2, marker: page.next_marker });
  assert.deepEqual(next.objects.map(object => object.key), ['docs/sub/c.md', 'img/x.png']);

  for (const max of [0, 1001, -1, 'ten', 1.5]) await rejects(files.list(OWNER, { max }), 'INVALID_ARGUMENT', 400);
  await rejects(files.list(OWNER, { delimiter: ',' }), 'INVALID_ARGUMENT', 400);
  assert.equal((await files.list(OWNER, { max: 1000 })).objects.length, 1);
});

test('stat: size, type, disposition, metadata; a missing key is NOT_FOUND (404)', async () => {
  const { files, fake } = setup();
  fake.store('a.pdf', Buffer.alloc(1234), { type: 'application/pdf', disposition: 'attachment; filename="a.pdf"', meta: { owner: 'agent' } });
  const stat = await files.stat(OWNER, 'a.pdf');
  assert.equal(stat.size, 1234);
  assert.equal(stat.content_type, 'application/pdf');
  assert.equal(stat.content_disposition, 'attachment; filename="a.pdf"');
  assert.deepEqual(stat.meta, { owner: 'agent' });
  assert.equal(stat.last_modified, '2026-11-12T08:30:00.000Z');
  await rejects(files.stat(OWNER, 'missing.pdf'), 'NOT_FOUND', 404);
});

test('get: a stream with its headers; over 2 GiB is TOO_LARGE (413)', async () => {
  const { files, fake } = setup();
  const body = Buffer.alloc(200 * 1024, 7);
  fake.store('big.bin', body);
  const object = await files.get(OWNER, 'big.bin');
  assert.equal(object.size, body.length);
  assert.equal(object.content_type, 'application/octet-stream');
  const chunks = [];
  for await (const chunk of object.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), body);
  await rejects(files.get(OWNER, 'nope'), 'NOT_FOUND', 404);

  let destroyed = false;
  fake.client.getStream = async () => ({ stream: { destroy() { destroyed = true; } }, res: { headers: { 'content-length': String(MAX_GET_BYTES + 1) } } });
  await rejects(files.get(OWNER, 'huge.iso'), 'TOO_LARGE', 413);
  assert.equal(destroyed, true, 'the OSS stream is closed');
});

test('put: streams with the size, keeps harmless types, stores active types as application/octet-stream, answers a signed URL', async () => {
  const { files, fake } = setup();
  const answer = await files.put(OWNER, 'out/report.pdf', Readable.from([Buffer.from('%PDF-'), Buffer.from('1.7')]), { size: 8, contentType: 'application/pdf' });
  assert.equal(answer.key, 'out/report.pdf');
  assert.equal(answer.size, 8);
  assert.equal(answer.content_type, 'application/pdf');
  assert.match(answer.etag, /^[0-9A-F]{32}$/);
  assert.match(answer.url, /^https:\/\/tcli-bucket\.oss-cn-hangzhou\.aliyuncs\.com\/out\/report\.pdf\?/);
  assert.ok(Date.parse(answer.url_expires_at) > Date.now() + 3500 * 1000);
  const put = fake.calls.find(call => call[0] === 'putStream');
  assert.equal(put[2].contentLength, 8);
  assert.equal(put[2].headers['Content-Type'], 'application/pdf', 'the type is always set, so the SDK never guesses it from the key');
  assert.deepEqual(fake.calls.find(call => call[0] === 'signatureUrlV4').slice(1), ['GET', 3600, 'out/report.pdf']);
  assert.equal(fake.objects.get('out/report.pdf').body.toString(), '%PDF-1.7');

  for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'text/css', 'multipart/related', 'text/plain; charset=utf-8', 'garbage', '']) {
    const stored = await files.put(OWNER, 'page.html', Readable.from([Buffer.from('<b>')]), { size: 3, contentType: type });
    assert.equal(stored.content_type, 'application/octet-stream', type);
    assert.equal(fake.objects.get('page.html').type, 'application/octet-stream', type);
  }
  for (const type of ['text/plain', 'image/png', 'application/zip', 'application/json']) {
    assert.equal((await files.put(OWNER, 'ok.bin', Readable.from([Buffer.from('x')]), { size: 1, contentType: type })).content_type, type);
  }
  // An empty file is allowed.
  assert.equal((await files.put(OWNER, 'empty.txt', Readable.from([]), { size: 0, contentType: 'text/plain' })).size, 0);
});

test('put: a public address gives the public URL with each segment encoded', async () => {
  const { files, images } = setup();
  images.saveConfig(OWNER, { ...CONFIG, publicBaseUrl: 'https://cdn.example.com/files/' });
  const answer = await files.put(OWNER, 'docs/\u8bbe\u8ba1 v2.md', Readable.from([Buffer.from('#')]), { size: 1, contentType: 'text/markdown' });
  assert.equal(answer.url, `https://cdn.example.com/files/docs/${encodeURIComponent('\u8bbe\u8ba1 v2.md')}`);
  assert.equal(answer.url_expires_at, null);
  assert.deepEqual(files.publicUrl(OWNER, 'a b/c'), { key: 'a b/c', url: 'https://cdn.example.com/files/a%20b/c' });
});

test('put: the size caps and a body that does not match its size', async () => {
  const { files, fake } = setup();
  await rejects(files.put(OWNER, 'big.iso', Readable.from([]), { size: MAX_PUT_BYTES + 1 }), 'TOO_LARGE', 413);
  assert.equal(fake.calls.some(call => call[0] === 'putStream'), false, 'refused before OSS is called');
  await rejects(files.put(OWNER, 'short.bin', Readable.from([Buffer.from('abc')]), { size: 10 }), 'INCOMPLETE_BODY', 400);
  await rejects(files.put(OWNER, 'long.bin', Readable.from([Buffer.from('abcdef')]), { size: 3 }), 'INVALID_ARGUMENT', 400);
  await rejects(files.put(OWNER, 'neg.bin', Readable.from([]), { size: -1 }), 'INVALID_ARGUMENT', 400);
  await rejects(files.put(OWNER, 'disp.bin', Readable.from([]), { size: 0, contentDisposition: 'attachment\r\nX: y' }), 'INVALID_ARGUMENT', 400);
  // Without a size: chunked, at most the cap (checked on the bytes).
  const chunked = await files.put(OWNER, 'chunked.bin', Readable.from([Buffer.from('12345')]), { contentType: 'application/octet-stream' });
  assert.equal(chunked.size, 5);
  assert.equal(fake.calls.filter(call => call[0] === 'putStream').at(-1)[2].contentLength, undefined);
  // A source that fails halfway (the caller went away).
  const broken = new Readable({ read() { this.push(Buffer.from('ab')); this.destroy(new Error('aborted')); } });
  await rejects(files.put(OWNER, 'broken.bin', broken, { size: 10 }), 'INCOMPLETE_BODY', 400);
});

test('copy keeps the object; an active source type becomes plain bytes in the copy; move deletes the source', async () => {
  const { files, fake } = setup();
  fake.store('a.txt', Buffer.from('A'), { type: 'text/plain', meta: { k: 'v' } });
  const copied = await files.copy(OWNER, 'a.txt', 'b/a.txt');
  assert.equal(copied.src, 'a.txt');
  assert.equal(copied.dst, 'b/a.txt');
  assert.match(copied.etag, /^[0-9A-F]{32}$/);
  assert.equal(fake.objects.get('b/a.txt').type, 'text/plain');
  assert.deepEqual(fake.calls.find(call => call[0] === 'copy')[3].headers, undefined, 'a harmless type is copied as it is');

  fake.store('old.html', Buffer.from('<script>'), { type: 'text/html; charset=utf-8', disposition: 'inline', meta: { k: 'v' } });
  await files.copy(OWNER, 'old.html', 'new.html');
  assert.equal(fake.objects.get('new.html').type, 'application/octet-stream');
  assert.deepEqual(fake.objects.get('new.html').meta, { k: 'v' }, 'metadata kept when the type is replaced');

  const moved = await files.move(OWNER, 'a.txt', 'c.txt');
  assert.equal(moved.moved, true);
  assert.equal(fake.objects.has('a.txt'), false);
  assert.equal(fake.objects.get('c.txt').body.toString(), 'A');

  await rejects(files.copy(OWNER, 'missing', 'x'), 'NOT_FOUND', 404);
  await rejects(files.move(OWNER, 'c.txt', 'c.txt'), 'INVALID_ARGUMENT', 400);
  assert.equal(fake.objects.has('c.txt'), true, 'a move onto itself never deletes the object');
});

test('remove: 1..1000 keys with deleteMulti, deleted and failed lists, duplicates once', async () => {
  const { files, fake } = setup();
  fake.store('a', Buffer.from('1'));
  fake.store('locked/b', Buffer.from('2'));
  const answer = await files.remove(OWNER, ['a', 'locked/b', 'a', 'never-existed']);
  assert.deepEqual(answer, { deleted: ['a', 'never-existed'], failed: ['locked/b'] });
  assert.deepEqual(fake.calls.at(-1).slice(0, 2), ['deleteMulti', ['a', 'locked/b', 'never-existed']]);
  assert.equal(fake.calls.at(-1)[2].quiet, false);
  await rejects(files.remove(OWNER, []), 'INVALID_ARGUMENT', 400);
  await rejects(files.remove(OWNER, 'a'), 'INVALID_ARGUMENT', 400);
  await rejects(files.remove(OWNER, Array.from({ length: 1001 }, (_, i) => `k${i}`)), 'INVALID_ARGUMENT', 400);
  assert.equal((await files.remove(OWNER, Array.from({ length: 1000 }, (_, i) => `k${i}`))).deleted.length, 1000);
});

test('sign: GET by default, 60..604800 seconds, GET or HEAD only', async () => {
  const { files, fake } = setup();
  const answer = await files.sign(OWNER, 'a.txt');
  assert.equal(answer.method, 'GET');
  assert.match(answer.url, /x-oss-expires=3600/);
  assert.ok(Math.abs(Date.parse(answer.expires_at) - (Date.now() + 3600 * 1000)) < 5000);
  assert.equal((await files.sign(OWNER, 'a.txt', { expires: 60, method: 'head' })).method, 'HEAD');
  assert.deepEqual(fake.calls.at(-1).slice(1), ['HEAD', 60, 'a.txt']);
  assert.match((await files.sign(OWNER, 'a.txt', { expires: '604800' })).url, /x-oss-expires=604800/);
  for (const expires of [59, 604801, 'soon', 1.5]) await rejects(files.sign(OWNER, 'a.txt', { expires }), 'INVALID_ARGUMENT', 400);
  for (const method of ['PUT', 'POST', 'DELETE']) await rejects(files.sign(OWNER, 'a.txt', { method }), 'INVALID_ARGUMENT', 400);
  fake.client.signatureUrlV4 = async () => 'http://insecure.example/x';
  await rejects(files.sign(OWNER, 'a.txt'), 'OSS_REQUEST_FAILED', 502);
});

test('upstream errors: only the OSS code is kept, never the message (which may hold the key id or the signed string)', async () => {
  const { files, fake } = setup();
  const leaky = Object.assign(new Error(`The request signature we calculated does not match. OSSAccessKeyId=${KEY_ID} secret=${SECRET}`), {
    name: 'SignatureDoesNotMatchError', status: 403, code: 'SignatureDoesNotMatch', requestId: 'r1', hostId: 'tcli-bucket.oss-cn-hangzhou.aliyuncs.com',
  });
  fake.failWith(leaky);
  await assert.rejects(files.list(OWNER), error => {
    assert.equal(error.code, 'OSS_REQUEST_FAILED');
    assert.equal(error.statusCode, 502);
    assert.equal(error.ossCode, 'SignatureDoesNotMatch');
    const { status, body } = errorBody(error);
    assert.equal(status, 502);
    assert.deepEqual(body, { error: 'OSS_REQUEST_FAILED', message: 'The OSS request failed (SignatureDoesNotMatch)', oss_code: 'SignatureDoesNotMatch' });
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.equal(JSON.stringify(body).includes(KEY_ID), false);
    return true;
  });
  fake.failWith(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  await rejects(files.stat(OWNER, 'a'), 'OSS_REQUEST_FAILED', 502);
  fake.failWith(Object.assign(new Error('x'), { status: 404, code: 'NoSuchBucket' }));
  await rejects(files.list(OWNER), 'OSS_REQUEST_FAILED', 502);
  fake.failWith(Object.assign(new Error(`weird ${SECRET}`), { code: 'not a code!' }));
  await assert.rejects(files.list(OWNER), error => {
    assert.deepEqual(errorBody(error).body, { error: 'OSS_REQUEST_FAILED', message: 'The OSS request failed' });
    return true;
  });
  assert.deepEqual(errorBody(new Error(SECRET)), { status: 502, body: { error: 'OSS_REQUEST_FAILED', message: 'The OSS request failed' } });
});

test('no answer of any operation and no log line holds the secret', async () => {
  const { files, fake } = setup();
  fake.store('a.txt', Buffer.from('A'), { type: 'text/plain' });
  const answers = [
    await files.list(OWNER), await files.stat(OWNER, 'a.txt'), await files.sign(OWNER, 'a.txt'),
    await files.put(OWNER, 'b.txt', Readable.from([Buffer.from('B')]), { size: 1, contentType: 'text/plain' }),
    await files.copy(OWNER, 'a.txt', 'c.txt'), await files.move(OWNER, 'c.txt', 'd.txt'), await files.remove(OWNER, ['d.txt']),
  ];
  const { stream, ...object } = await files.get(OWNER, 'a.txt');
  stream.destroy();
  answers.push(object);
  // (A real signed URL names the AccessKey ID in x-oss-credential, as the page's upload links do; the ID is not a secret.)
  const text = JSON.stringify(answers);
  assert.equal(text.includes(SECRET), false);
  assert.equal(logged.some(line => line.includes(SECRET)), false);
});

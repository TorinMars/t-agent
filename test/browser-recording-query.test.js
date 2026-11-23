// lib/browser-recording-query.js: the filters of `tcli browser record items` (kinds and the net alias, resource type, source with the user
// default, url substring and /regex/, status classes, offset and limit, refused values) and the merge of `record requests` (request + response
// per req_id, a request without a response, a response without a request, redirect hops, static files left out, --all and --type, WebSocket frames).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseItemFilter, itemMatches, filterLines, parseRequestOptions, mergeRequests, QueryError } = require('../lib/browser-recording-query');

const ITEMS = [
  { seq: 1, kind: 'nav', url: 'https://shop.test/' },
  { seq: 2, kind: 'request', req_id: 'r1', method: 'GET', url: 'https://shop.test/api/cart', type: 'XHR', status: 0 },
  { seq: 3, kind: 'click', url: 'https://shop.test/', target: { tag: 'button' } },
  { seq: 4, kind: 'click', url: 'https://shop.test/', source: 'agent', target: { tag: 'a' } },
  { seq: 5, kind: 'response', req_id: 'r1', method: 'GET', url: 'https://shop.test/api/cart', type: 'XHR', status: 200 },
  { seq: 6, kind: 'request', req_id: 'r2', method: 'GET', url: 'https://cdn.test/app.js', type: 'Script', status: 0 },
  { seq: 7, kind: 'response', req_id: 'r2', url: 'https://cdn.test/app.js', type: 'Script', status: 404 },
  { seq: 8, kind: 'console', level: 'error', text: 'x' },
];
const pick = (query, items = ITEMS) => { const filter = parseItemFilter(query); return items.filter(item => itemMatches(filter, item)).map(item => item.seq); };
const lines = list => list.map(item => JSON.stringify(item));

test('item filters: kinds (net = request, response, ws), type ignoring case, source (none = user), url, status', () => {
  assert.equal(parseItemFilter({}), null, 'no filter: the file can be sent as it is');
  assert.deepEqual(pick({ kind: 'net' }), [2, 5, 6, 7]);
  assert.deepEqual(pick({ kind: 'click,nav' }), [1, 3, 4]);
  assert.deepEqual(pick({ kind: ['click', 'console'] }), [3, 4, 8], 'a repeated parameter is a list');
  assert.deepEqual(pick({ type: 'xhr' }), [2, 5]);
  assert.deepEqual(pick({ type: 'XHR,script', kind: 'response' }), [5, 7]);
  assert.deepEqual(pick({ source: 'agent' }), [4]);
  assert.deepEqual(pick({ source: 'user', kind: 'click' }), [3], 'an item without a source is the person\'s');
  assert.deepEqual(pick({ url: '/api/' }), [2, 5]);
  assert.deepEqual(pick({ url: '/\\.JS$/i' }), [6, 7], '/regex/flags');
  assert.deepEqual(pick({ status: '4xx' }), [7]);
  assert.deepEqual(pick({ status: '200,404' }), [5, 7]);
  assert.deepEqual(pick({ status: '400-499' }), [7]);
  assert.deepEqual(pick({ status: '0' }), [2, 6], '0: no response yet');
});

test('item filters: refused values are QueryError BAD_FILTER (400)', () => {
  for (const query of [{ kind: 'no spaces' }, { source: 'robot' }, { status: '6xx' }, { status: 'ok' }, { status: '500-400' }, { url: '/(/' }, { url: '/a/g' },
    { limit: '0' }, { limit: '-1' }, { offset: 'x' }, { kind: '' }, { kind: { a: 1 } }, { url: 'x'.repeat(1001) }]) {
    assert.throws(() => parseItemFilter(query), error => error instanceof QueryError && error.code === 'BAD_FILTER' && error.status === 400, JSON.stringify(query));
  }
});

test('filterLines: offset and limit after the filter; lines that are not JSON are skipped', async () => {
  const out = [];
  for await (const line of filterLines([...lines(ITEMS), 'not json', ''], parseItemFilter({ kind: 'net', offset: '1', limit: '2' }))) out.push(JSON.parse(line).seq);
  assert.deepEqual(out, [5, 6]);
  const all = [];
  for await (const line of filterLines(lines(ITEMS).map(line => `${line}\n`), parseItemFilter({ kind: 'click' }))) all.push(line);
  assert.deepEqual(all.map(line => JSON.parse(line).seq), [3, 4], 'the newline is removed');
});

const HEADERS = { request: { headers: { Accept: 'application/json', Cookie: '<redacted:8>' }, post_data: '{"q":1}' } };
const RECORDING = [
  { seq: 1, at: 1000, kind: 'request', req_id: 'a', method: 'POST', url: 'https://shop.test/api/search', type: 'Fetch', status: 0, tab_id: 4 },
  { seq: 2, at: 1000, kind: 'request', req_id: 's', method: 'GET', url: 'https://cdn.test/site.css', type: 'Stylesheet', status: 0 },
  { seq: 3, at: 1001, kind: 'request', req_id: 'img', method: 'GET', url: 'https://cdn.test/logo.png', type: 'Image', status: 0 },
  { seq: 4, at: 1040, kind: 'response', req_id: 'a', method: 'POST', url: 'https://shop.test/api/search', type: 'Fetch', status: 200, ...HEADERS,
    response: { headers: { 'content-type': 'application/json' }, mime: 'application/json', size: 20, body: '{"hits":[]}' }, timing: { started_at: 1000, finished_at: 1040 } },
  { seq: 5, at: 1050, kind: 'response', req_id: 's', url: 'https://cdn.test/site.css', type: 'Stylesheet', status: 200, response: { body: 'body{}' } },
  // A redirect: the old hop's response (302), then the new hop's request with the same req_id.
  { seq: 6, at: 1100, kind: 'request', req_id: 'd', method: 'GET', url: 'https://shop.test/old', type: 'Document', status: 0 },
  { seq: 7, at: 1110, kind: 'response', req_id: 'd', method: 'GET', url: 'https://shop.test/old', type: 'Document', status: 302, response: { headers: { location: '/new' } }, timing: { started_at: 1100 } },
  { seq: 8, at: 1111, kind: 'request', req_id: 'd', method: 'GET', url: 'https://shop.test/new', type: 'Document', status: 0 },
  { seq: 9, at: 1150, kind: 'response', req_id: 'd', method: 'GET', url: 'https://shop.test/new', type: 'Document', status: 200, response: { mime: 'text/html', size: 900 }, timing: { started_at: 1111, finished_at: 1150 } },
  // Still running when the recording stopped.
  { seq: 10, at: 1200, kind: 'request', req_id: 'p', method: 'GET', url: 'https://shop.test/api/poll', type: 'XHR', status: 0 },
  // Its request was not recorded (it started before the recording).
  { seq: 11, at: 1300, kind: 'response', req_id: 'late', method: 'GET', url: 'https://shop.test/api/me', type: 'XHR', status: 401, response: { body: '{}' } },
  { seq: 12, at: 1400, kind: 'request', req_id: 'w', method: 'GET', url: 'wss://shop.test/live', type: 'WebSocket', status: 0 },
  { seq: 13, at: 1410, kind: 'response', req_id: 'w', url: 'wss://shop.test/live', type: 'WebSocket', status: 101 },
  { seq: 14, at: 1420, kind: 'ws', url: 'wss://shop.test/live', dir: 'recv', data: 'hi' },
  { seq: 15, at: 1430, kind: 'ws', url: 'wss://shop.test/live', dir: 'sent', data: 'yo' },
  { seq: 16, kind: 'click', url: 'https://shop.test/' },
];

test('mergeRequests: one entry per request and hop, static files left out, the missing half named', async () => {
  const { requests, left_out: leftOut } = await mergeRequests(lines(RECORDING));
  assert.equal(leftOut, 2, 'the stylesheet and the image');
  assert.deepEqual(requests.map(entry => `${entry.req_id} ${entry.url.split('/').pop()} ${entry.status}`), ['a search 200', 'd old 302', 'd new 200', 'p poll null', 'late me 401', 'w live 101']);
  const [search, oldHop, newHop, poll, late, socket] = requests;
  assert.equal(search.method, 'POST');
  assert.deepEqual(search.request, HEADERS.request, 'the request headers and body come from the response item');
  assert.equal(search.response.body, '{"hits":[]}');
  assert.deepEqual([search.mime, search.size, search.started_at, search.finished_at, search.duration_ms, search.tab_id], ['application/json', 20, 1000, 1040, 40, 4]);
  assert.equal(search.missing, undefined);
  assert.equal(search.answered, undefined, 'no bookkeeping field leaks');
  assert.deepEqual([oldHop.redirected_to, newHop.redirected_from], ['https://shop.test/new', 'https://shop.test/old']);
  assert.equal(oldHop.response.headers.location, '/new');
  assert.equal(newHop.duration_ms, 39);
  assert.equal(poll.missing, 'response');
  assert.equal(late.missing, 'request');
  assert.equal(socket.ws_frames, 2);
});

test('mergeRequests: --all keeps static files, --type overrides, url / status / offset / limit on the merged requests', async () => {
  const all = await mergeRequests(RECORDING, parseRequestOptions({ all: '1' }));
  assert.equal(all.left_out, 0);
  assert.deepEqual(all.requests.map(entry => entry.req_id), ['a', 's', 'img', 'd', 'd', 'p', 'late', 'w']);
  assert.equal(all.requests[1].response.body, 'body{}');
  assert.equal(all.requests[2].missing, 'response');
  const images = await mergeRequests(RECORDING, parseRequestOptions({ type: 'image,xhr' }));
  assert.deepEqual(images.requests.map(entry => entry.req_id), ['img', 'p', 'late']);
  assert.equal(images.left_out, 0, '--type names what it keeps: nothing is "left out" by default');
  assert.deepEqual((await mergeRequests(RECORDING, parseRequestOptions({ status: '4xx' }))).requests.map(entry => entry.req_id), ['late']);
  assert.deepEqual((await mergeRequests(RECORDING, parseRequestOptions({ status: '3xx,0' }))).requests.map(entry => entry.url), ['https://shop.test/old', 'https://shop.test/api/poll']);
  assert.deepEqual((await mergeRequests(RECORDING, parseRequestOptions({ url: '/api/' }))).requests.map(entry => entry.req_id), ['a', 'p', 'late']);
  assert.deepEqual((await mergeRequests(RECORDING, parseRequestOptions({ url: '/api/', offset: '1', limit: '1' }))).requests.map(entry => entry.req_id), ['p']);
  assert.throws(() => parseRequestOptions({ status: 'bad' }), { code: 'BAD_FILTER' });
});

test('mergeRequests: a second response without its request item becomes its own hop; a source is kept', async () => {
  const { requests } = await mergeRequests([
    { kind: 'request', req_id: 'x', url: 'https://a.test/1', type: 'Fetch', source: 'agent', at: 1 },
    { kind: 'response', req_id: 'x', url: 'https://a.test/1', type: 'Fetch', status: 301, at: 2 },
    { kind: 'response', req_id: 'x', url: 'https://a.test/2', type: 'Fetch', status: 200, at: 3 },
  ]);
  assert.deepEqual(requests.map(entry => [entry.url, entry.status, entry.missing]), [['https://a.test/1', 301, undefined], ['https://a.test/2', 200, 'request']]);
  assert.equal(requests[0].source, 'agent');
  assert.equal(requests[0].redirected_to, 'https://a.test/2');
});

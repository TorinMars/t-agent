// The `t-agent-peers` MCP server (scripts/peer-mcp.js), spawned as Claude Code / Codex would, against a mock of the relay
// (`/api/peer-fs/*`). Checks the stdio protocol, the tools and how each call reaches the relay.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/peer-mcp.js');
const TOKEN = 'a'.repeat(64);

// The mock relay: records each request and answers from `routes` (a function per path, or the default below).
const seen = [];
let routes = {};
const relay = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://relay');
  seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), task: req.headers['x-t-agent-task'], terminal: req.headers['x-t-agent-terminal'], token: req.headers['x-t-agent-token'] });
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = routes[url.pathname];
  if (handler) return handler(url, reply, res);
  reply(404, { error: 'NOT_FOUND', message: 'no such route in the mock' });
});
let base;
test.before(async () => {
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${relay.address().port}/api/peer-fs`;
});
const children = new Set();
test.after(() => {
  for (const child of children) child.kill(); // a failed test leaves its server running
  relay.closeAllConnections();
  relay.close();
});
test.beforeEach(() => { seen.length = 0; routes = {}; });

// One server process with a line-based client.
function start(extraEnv = {}) {
  const env = { PATH: process.env.PATH, TA_PEER_URL: base, TA_PEER_TASK: '7', TA_PEER_TERMINAL: 'term-1', TA_HOOK_TOKEN: TOKEN, ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const messages = [];
  const waiting = [];
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line); // every stdout line must be JSON
      messages.push(message);
      for (const wait of [...waiting]) if (wait.match(message)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(message); }
    }
  });
  const next = match => {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer; got ${JSON.stringify(messages)}; stderr ${stderr}`)), 5000);
      waiting.push({ match, resolve: message => { clearTimeout(timer); resolve(message); } });
    });
  };
  let id = 0;
  const client = {
    child, messages, get stderr() { return stderr; },
    write: line => child.stdin.write(`${line}\n`),
    send: message => client.write(JSON.stringify(message)),
    request: (method, params) => { const ask = ++id; client.send({ jsonrpc: '2.0', id: ask, method, params }); return next(message => message.id === ask); },
    call: (name, args) => client.request('tools/call', { name, arguments: args }).then(message => message.result),
    next,
    close: () => new Promise(resolve => { child.on('close', code => resolve(code)); child.stdin.end(); }),
  };
  return client;
}

test('initialize answers the client\'s protocol version, the server name and the tools capability; ping and notifications', async () => {
  const mcp = start();
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const { result } = await mcp.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(result.protocolVersion, version);
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(result.serverInfo.name, 't-agent-peers');
    assert.match(result.instructions, /list_engines/);
  }
  const unknown = await mcp.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknown.result.protocolVersion, '2025-06-18', 'an unknown version gets the newest one');
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await mcp.request('ping')).result, {});
  assert.equal(mcp.messages.filter(message => message.id === undefined).length, 0, 'a notification gets no answer');
  assert.equal(await mcp.close(), 0, 'the end of stdin ends the server');
  assert.equal(mcp.stderr, '');
});

test('tools/list: four read-only tools with schemas, and a description that names other computers', async () => {
  const mcp = start();
  const { result } = await mcp.request('tools/list', {});
  assert.deepEqual(result.tools.map(tool => tool.name), ['list_engines', 'list_dir', 'read_file', 'search']);
  for (const tool of result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} is read-only`);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 80);
  }
  const byName = Object.fromEntries(result.tools.map(tool => [tool.name, tool]));
  assert.match(byName.list_engines.description, /OTHER computers/);
  assert.match(byName.list_engines.description, /K01/);
  assert.match(byName.list_engines.description, /read/);
  assert.deepEqual(byName.list_dir.inputSchema.required, ['engine']);
  assert.deepEqual(byName.read_file.inputSchema.required, ['engine', 'path']);
  assert.deepEqual(Object.keys(byName.read_file.inputSchema.properties), ['engine', 'path', 'offset', 'limit']);
  assert.deepEqual(byName.search.inputSchema.required, ['engine', 'path', 'pattern']);
  assert.deepEqual(Object.keys(byName.search.inputSchema.properties), ['engine', 'path', 'pattern', 'glob', 'ignore_case', 'regex']);
  await mcp.close();
});

test('list_engines forwards to /engines with the terminal\'s headers and lists names, state, home and tasks', async () => {
  routes['/api/peer-fs/engines'] = (url, reply) => reply(200, { engines: [
    { id: 'remote:3', name: 'K01', online: true, supported: true, home: '/Users/kim', platform: 'darwin', tasks: [{ id: 4, title: 'Billing service', work_dir: '/Users/kim/work/billing' }] },
    { id: 'remote:5', name: 'K02', online: false, supported: true, home: '/home/lee', platform: 'linux', tasks: [] },
    { id: 'remote:6', name: 'Old box', online: true, supported: false, disabled: true, home: '', platform: 'linux', tasks: [], error: 'PEER_FS_UNSUPPORTED' },
    { id: 'remote:8', name: 'Gone', online: true, supported: true, disabled: false, home: '', platform: '', tasks: [], error: 'ENGINE_UNAUTHORIZED' },
  ] });
  const mcp = start();
  const result = await mcp.call('list_engines', {});
  assert.deepEqual(seen, [{ method: 'GET', path: '/api/peer-fs/engines', query: {}, task: '7', terminal: 'term-1', token: TOKEN }]);
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const text = result.content[0].text;
  assert.match(text, /K01 \(id remote:3\): online/);
  assert.match(text, /home: \/Users\/kim/);
  assert.match(text, /Billing service \(work_dir: \/Users\/kim\/work\/billing\)/);
  assert.match(text, /K02 \(id remote:5\): offline/);
  assert.match(text, /Old box .*file access not supported.*switched off/);
  assert.ok(!/Old box .*error/.test(text), 'a known error is said once');
  assert.match(text, /Gone \(id remote:8\): online, the link is not accepted there any more/);
  assert.match(text, /read-only/);
  routes['/api/peer-fs/engines'] = (url, reply) => reply(200, { engines: [] });
  assert.match((await mcp.call('list_engines', {})).content[0].text, /No other computers/);
  await mcp.close();
});

test('list_dir, read_file and search forward their arguments as the query', async () => {
  routes['/api/peer-fs/list'] = (url, reply) => reply(200, { path: '/Users/kim/work', entries: [{ name: 'src', type: 'dir', size: 0, mtime: '2026-11-01T10:00:00.000Z' }, { name: 'README.md', type: 'file', size: 2048, mtime: 1762000000000 }], truncated: true });
  // The relay's next_offset wins over the bytes received (it may stop before a split UTF-8 character); null means the file is done.
  const reads = { '/Users/kim/work/README.md': 4321, 'notes.txt': null };
  routes['/api/peer-fs/read'] = (url, reply) => reply(200, { path: url.searchParams.get('path'), content: 'line one\nline two \u4e2d\n', size: 5000, offset: Number(url.searchParams.get('offset') || 0), next_offset: reads[url.searchParams.get('path')], truncated: reads[url.searchParams.get('path')] !== null, encoding: 'utf8' });
  routes['/api/peer-fs/search'] = (url, reply) => reply(200, { matches: [{ path: '/Users/kim/work/src/a.js', line: 12, text: 'const total = sum(items);' }], truncated: false });
  const mcp = start();

  const listed = await mcp.call('list_dir', { engine: 'K01', path: '~/work' });
  assert.deepEqual(seen.pop().query, { engine: 'K01', path: '~/work' });
  assert.match(listed.content[0].text, /^\/Users\/kim\/work on K01: 2 entries/);
  assert.match(listed.content[0].text, /^dir +src\/ +2026-11-01T10:00:00Z$/m);
  assert.match(listed.content[0].text, /^file +README\.md +2\.0 KiB +2025-/m);
  assert.match(listed.content[0].text, /cut off/);
  await mcp.call('list_dir', { engine: 'K01' });
  assert.deepEqual(seen.pop().query, { engine: 'K01' }, 'no path: the home folder');

  const read = await mcp.call('read_file', { engine: 'remote:3', path: '/Users/kim/work/README.md', offset: 100, limit: 4000 });
  assert.deepEqual(seen.pop().query, { engine: 'remote:3', path: '/Users/kim/work/README.md', offset: '100', limit: '4000' });
  const text = read.content[0].text;
  assert.ok(text.startsWith('[/Users/kim/work/README.md on remote:3, 5000 bytes, bytes 100-4321]\nline one\nline two \u4e2d\n'), text);
  assert.match(text, /Cut off at byte 4321 of 5000\. Call read_file again with offset 4321 to read the next part\.\]$/);
  const done = await mcp.call('read_file', { engine: 'K01', path: 'notes.txt' });
  assert.deepEqual(seen.pop().query, { engine: 'K01', path: 'notes.txt' }, 'offset and limit are left out when not given');
  assert.equal(done.content[0].text, '[notes.txt on K01, 5000 bytes]\nline one\nline two \u4e2d\n', 'next_offset null: the whole rest was read, no hint');
  // An answer without next_offset falls back to the bytes received.
  routes['/api/peer-fs/read'] = (url, reply) => reply(200, { path: 'a.txt', content: 'abc', size: 10, offset: 0, truncated: true });
  assert.match((await mcp.call('read_file', { engine: 'K01', path: 'a.txt' })).content[0].text, /offset 3 to read/);

  const found = await mcp.call('search', { engine: 'K01', path: '~/work', pattern: 'sum(', glob: '*.js', ignore_case: true, regex: false });
  assert.deepEqual(seen.pop().query, { engine: 'K01', path: '~/work', pattern: 'sum(', glob: '*.js', ignore_case: 'true' });
  assert.match(found.content[0].text, /1 match for "sum\(" under ~\/work on K01/);
  assert.match(found.content[0].text, /\/Users\/kim\/work\/src\/a\.js:12: const total = sum\(items\);/);
  await mcp.call('search', { engine: 'K01', path: '~', pattern: 'a.b', regex: true });
  assert.deepEqual(seen.pop().query, { engine: 'K01', path: '~', pattern: 'a.b', regex: 'true' });
  for (const call of seen) assert.equal(call.token, TOKEN);
  await mcp.close();
});

test('relay errors become isError results with a clear sentence', async () => {
  const errors = {
    PATH_NOT_ALLOWED: [403, /sensitive/], PEER_FS_DISABLED: [403, /switched off/], ENGINE_NOT_FOUND: [404, /list_engines/], NOT_FOUND: [404, /does not exist/],
    PEER_FS_UNSUPPORTED: [501, /older T-Agent/], ENGINE_OFFLINE: [502, /offline/], BINARY_FILE: [415, /binary/], IS_DIRECTORY: [400, /list_dir/],
    PEER_FS_AUTH_REQUIRED: [401, /identity/], PEER_FS_AUTH_INVALID: [403, /did not accept this session/], ENGINE_REQUIRED: [400, /Name the engine/],
    ENGINE_UNAUTHORIZED: [502, /link/], INVALID_ARGUMENT: [400, /not valid/], NOT_A_DIRECTORY: [400, /read_file/], NOT_A_REGULAR_FILE: [400, /not a regular file/],
    PERMISSION_DENIED: [403, /no permission/], PEER_FS_READ_FAILED: [500, /could not read/], READ_TIMEOUT: [504, /too long/],
  };
  let current = null;
  routes['/api/peer-fs/read'] = (url, reply) => reply(errors[current][0], { error: current, message: `relay says ${current}` });
  const mcp = start();
  for (const code of Object.keys(errors)) {
    current = code;
    const result = await mcp.call('read_file', { engine: 'K01', path: '~/.ssh/id_rsa' });
    assert.equal(result.isError, true, code);
    assert.match(result.content[0].text, new RegExp(`^Error ${code}: `));
    assert.match(result.content[0].text, errors[code][1]);
    assert.match(result.content[0].text, new RegExp(`relay says ${code}`), 'the relay\'s own message is kept');
  }
  routes['/api/peer-fs/engines'] = (url, reply, res) => { res.writeHead(401); res.end('no'); };
  const refused = await mcp.call('list_engines', {});
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^Error UNAUTHORIZED: /);
  const missing = await mcp.call('read_file', { engine: 'K01' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /"path" is required/);
  const badOffset = await mcp.call('read_file', { engine: 'K01', path: 'a', offset: -1 });
  assert.equal(badOffset.isError, true);
  const unknownTool = await mcp.request('tools/call', { name: 'write_file', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  await mcp.close();
});

test('a relay that does not answer in time, or cannot be reached, or a session without the variables', async () => {
  routes['/api/peer-fs/list'] = () => { /* never answers */ };
  const slow = start({ TA_PEER_TIMEOUT_MS: '300' });
  const started = Date.now();
  const timedOut = await slow.call('list_dir', { engine: 'K01' });
  assert.ok(Date.now() - started < 3000);
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /^Error TIMEOUT: .*did not answer in time/);
  await slow.close();

  const gone = start({ TA_PEER_URL: 'http://127.0.0.1:9/api/peer-fs' });
  const unreachable = await gone.call('list_engines', {});
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.content[0].text, /^Error UNREACHABLE: /);
  await gone.close();

  const outside = start({ TA_PEER_URL: undefined, TA_HOOK_TOKEN: undefined });
  const result = await outside.call('list_engines', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error NOT_CONFIGURED: /);
  assert.equal(seen.filter(call => call.path === '/api/peer-fs/engines').length, 0);
  await outside.close();
});

test('malformed lines, invalid requests, unknown methods and batches', async () => {
  routes['/api/peer-fs/engines'] = (url, reply) => reply(200, { engines: [] });
  const mcp = start();
  mcp.write('{not json');
  const parse = await mcp.next(message => message.error && message.error.code === -32700);
  assert.equal(parse.id, null);
  mcp.write('');
  mcp.send({ id: 50, method: 'ping' }); // no jsonrpc field
  assert.equal((await mcp.next(message => message.id === 50)).error.code, -32600);
  const unknown = await mcp.request('resources/list', {});
  assert.deepEqual(unknown.error, { code: -32601, message: 'Method not found: resources/list' });
  mcp.write(JSON.stringify([{ jsonrpc: '2.0', id: 60, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'list_engines' } }]));
  const batch = await mcp.next(message => Array.isArray(message));
  assert.deepEqual(batch.map(message => message.id), [60, 61]);
  assert.match(batch[1].result.content[0].text, /No other computers/);
  // A request split over two writes is read as one line.
  mcp.child.stdin.write('{"jsonrpc":"2.0","id":70,');
  mcp.child.stdin.write('"method":"ping"}\n');
  assert.deepEqual((await mcp.next(message => message.id === 70)).result, {});
  // Still working after all of that.
  assert.equal((await mcp.request('tools/list')).result.tools.length, 4);
  await mcp.close();
});

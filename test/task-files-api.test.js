const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-file-api-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'tasks');
process.env.SESSION_SECRET = 'task-files-test-secret-task-files-test-secret';

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports(req, res, next) { req.session = { user: { login: 'owner' } }; next(); },
};

function createEngineApp() {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use('/v1', require('../routes/engine-v1'));
  return app;
}
const db = require('../db');
const { createAccessToken } = require('../services/engine-auth');
const { encryptToken } = require('../lib/token-crypto');

let localServer;
let engineServer;
let localBase;
let engineBase;
let task;
let operator;
let reader;

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function jsonRequest(base, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

test.before(async () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'one\n');
  const id = db.prepare('INSERT INTO tasks (title, user_id, work_dir, md_path) VALUES (?, ?, ?, ?)')
    .run('files', 'owner', workspace, path.join(workspace, 'DESIGN.md')).lastInsertRowid;
  task = { id, workspace };
  operator = createAccessToken(db, { role: 'operator', principalId: 'owner' }).token;
  reader = createAccessToken(db, { role: 'readonly', principalId: 'owner' }).token;

  const localApp = express();
  localApp.use(express.json({ limit: '6mb' }));
  localApp.use('/api/tasks', require('../routes/tasks'));
  localApp.use('/api/remote-servers', require('../routes/remote-servers'));
  localServer = await listen(localApp);
  localBase = `http://127.0.0.1:${localServer.address().port}`;

  engineServer = await listen(createEngineApp());
  engineBase = `http://127.0.0.1:${engineServer.address().port}`;
});

test.after(async () => {
  if (localServer) await new Promise(resolve => localServer.close(resolve));
  if (engineServer) await new Promise(resolve => engineServer.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('local task file endpoints expose the locked contract and structured errors', async () => {
  const listed = await jsonRequest(localBase, `/api/tasks/${task.id}/files`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.root, task.workspace);
  assert.equal(listed.payload.writable, true);
  assert.equal(listed.payload.entries.find(entry => entry.name === 'notes.txt').type, 'file');

  const opened = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content?path=notes.txt`);
  assert.equal(opened.response.status, 200);
  assert.equal(opened.payload.content, 'one\n');

  const saved = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content`, {
    method: 'PUT', body: { path: 'notes.txt', content: 'two\n', revision: opened.payload.revision },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.content, 'two\n');

  const conflict = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content`, {
    method: 'PUT', body: { path: 'notes.txt', content: 'three\n', revision: opened.payload.revision },
  });
  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.payload, { error: 'FILE_CONFLICT' });

  const traversal = await jsonRequest(localBase, `/api/tasks/${task.id}/files/content?path=${encodeURIComponent('../secret')}`);
  assert.equal(traversal.response.status, 400);
  assert.deepEqual(traversal.payload, { error: 'FILE_PATH_INVALID' });
  assert.equal((await jsonRequest(localBase, '/api/tasks/999999/files')).response.status, 404);
});

test('Engine advertises file capabilities and every token can read and write files', async () => {
  const info = await jsonRequest(engineBase, '/v1/info', { token: reader });
  assert.equal(info.payload.capabilities.includes('files:read'), true);
  assert.equal(info.payload.capabilities.includes('files:write'), true);

  // every connection has admin rights: even a token requested as readonly can write files.
  for (const [name, token] of [['reader', reader], ['operator', operator]]) {
    const list = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, { token });
    assert.equal(list.payload.writable, true, name);
    const created = await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`, {
      method: 'POST', token, body: { path: `created-by-${name}.txt`, type: 'file' },
    });
    assert.equal(created.response.status, 201, name);
    assert.deepEqual(created.payload, { path: `created-by-${name}.txt` });
  }
  assert.equal((await jsonRequest(engineBase, `/v1/tasks/${task.id}/files`)).response.status, 401);
});

test('remote proxy forwards supported file APIs and returns FILES_UNSUPPORTED for old Engines', async () => {
  const supportedId = db.prepare(`INSERT INTO remote_servers
    (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)`)
    .run('owner', 'supported', engineBase, encryptToken(operator, process.env.SESSION_SECRET)).lastInsertRowid;
  const proxied = await jsonRequest(localBase, `/api/remote-servers/${supportedId}/tasks/${task.id}/files`);
  assert.equal(proxied.response.status, 200);
  assert.equal(proxied.payload.entries.some(entry => entry.name === 'notes.txt'), true);

  const largeContent = '\n'.repeat(5 * 1024 * 1024);
  fs.writeFileSync(path.join(task.workspace, 'large.txt'), largeContent);
  const large = await jsonRequest(localBase, `/api/remote-servers/${supportedId}/tasks/${task.id}/files/content?path=large.txt`);
  assert.equal(large.response.status, 200);
  assert.equal(large.payload.content, largeContent);

  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['tasks:read'] }));
  const oldServer = await listen(oldApp);
  try {
    const oldBase = `http://127.0.0.1:${oldServer.address().port}`;
    const oldId = db.prepare(`INSERT INTO remote_servers
      (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)`)
      .run('owner', 'old', oldBase, encryptToken('old-token', process.env.SESSION_SECRET)).lastInsertRowid;
    const unsupported = await jsonRequest(localBase, `/api/remote-servers/${oldId}/tasks/1/files`);
    assert.equal(unsupported.response.status, 501);
    assert.deepEqual(unsupported.payload, { error: 'FILES_UNSUPPORTED' });
  } finally {
    await new Promise(resolve => oldServer.close(resolve));
  }
});

test('images of the working directory are served for Markdown previews: local, Engine and proxy; only real images, no links, size-limited', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.mkdirSync(path.join(task.workspace, 'docs', 'img'), { recursive: true });
  fs.writeFileSync(path.join(task.workspace, 'docs', 'img', 'shot.png'), png);
  fs.writeFileSync(path.join(task.workspace, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(task.workspace, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(task.workspace, 'big.png'), Buffer.concat([png, Buffer.alloc(20 * 1024 * 1024)]));
  fs.writeFileSync(path.join(task.workspace, 'medium.png'), Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]));
  fs.symlinkSync(path.join(task.workspace, 'docs', 'img', 'shot.png'), path.join(task.workspace, 'link.png'));
  const known = db.prepare('SELECT id FROM remote_servers WHERE owner_id = ? AND base_url = ?').get('owner', engineBase);
  const supportedId = known ? known.id : db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'images', engineBase, encryptToken(operator, process.env.SESSION_SECRET)).lastInsertRowid;
  const bases = [
    [`${localBase}/api/tasks/${task.id}/files/image`, {}],
    [`${engineBase}/v1/tasks/${task.id}/files/image`, { Authorization: `Bearer ${reader}` }],
    [`${localBase}/api/remote-servers/${supportedId}/tasks/${task.id}/files/image`, {}],
  ];
  for (const [base, headers] of bases) {
    const ok = await fetch(`${base}?path=${encodeURIComponent('docs/img/shot.png')}`, { headers });
    assert.equal(ok.status, 200, base);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('content-security-policy'), 'sandbox');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    const status = async name => { const response = await fetch(`${base}?path=${encodeURIComponent(name)}`, { headers }); await response.arrayBuffer(); return response.status; };
    assert.equal(await status('fake.png'), 415, 'the content must be an image');
    assert.equal(await status('logo.svg'), 200, 'an SVG is served sandboxed (the page shows it only through <img>)');
    assert.equal(await status('medium.png'), 200, 'the image limit is 20 MiB, above the 5 MiB text limit');
    assert.equal(await status('notes.txt'), 415);
    assert.equal(await status('big.png'), 413, 'size limit');
    assert.equal(await status('link.png'), 415, 'no symbolic links');
    assert.equal(await status('../secret.png'), 400, 'inside the working directory only');
    assert.equal(await status('missing.png'), 404);
  }
  // A new endpoint is declared in /v1/info (API version unchanged), so a Client can tell an Engine that has it.
  const info = await (await fetch(`${engineBase}/v1/info`, { headers: { Authorization: `Bearer ${reader}` } })).json();
  assert.ok(info.capabilities.includes('files:image'));
  assert.equal(info.api_version, 1);
});

const fixture = (...parts) => Buffer.concat(parts.map(part => (Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'))));
const ftyp = (major, ...compatible) => {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const box = Buffer.alloc(8 + brands.length);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brands, 8, 'latin1');
  return box;
};

function proxiedEngineId() {
  const known = db.prepare('SELECT id FROM remote_servers WHERE owner_id = ? AND base_url = ?').get('owner', engineBase);
  return known ? known.id : db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
    .run('owner', 'engine', engineBase, encryptToken(operator, process.env.SESSION_SECRET)).lastInsertRowid;
}

const fileBases = suffix => {
  const id = proxiedEngineId();
  return [
    ['local', `${localBase}/api/tasks/${task.id}/files/${suffix}`, {}],
    ['engine', `${engineBase}/v1/tasks/${task.id}/files/${suffix}`, { Authorization: `Bearer ${reader}` }],
    ['proxy', `${localBase}/api/remote-servers/${id}/tasks/${task.id}/files/${suffix}`, {}],
  ];
};

test('images: SVG, BMP, ICO and AVIF are sniffed by content; a mismatched name or content is refused', async () => {
  const dir = path.join(task.workspace, 'pics');
  fs.mkdirSync(dir, { recursive: true });
  const images = {
    'a.svg': ['image/svg+xml', fixture(Buffer.from([0xef, 0xbb, 0xbf]), '<?xml version="1.0"?>\n<!-- drawn -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"/>')],
    'b.bmp': ['image/bmp', fixture('BM', Buffer.alloc(30))],
    'c.ico': ['image/x-icon', fixture(Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16))],
    'd.avif': ['image/avif', fixture(ftyp('mif1', 'avif', 'miaf'), Buffer.alloc(8))],
    'e.AVIF': ['image/avif', fixture(ftyp('avis'), Buffer.alloc(8))],
  };
  for (const [name, [, bytes]] of Object.entries(images)) fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(path.join(dir, 'text.svg'), '<html><svg></svg></html>');
  fs.writeFileSync(path.join(dir, 'png.bmp'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  fs.writeFileSync(path.join(dir, 'icon.bmp'), fixture(Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)));
  fs.writeFileSync(path.join(dir, 'heic.avif'), fixture(ftyp('heic', 'mif1'), Buffer.alloc(8)));
  fs.writeFileSync(path.join(dir, 'video.avif'), fixture(ftyp('isom', 'mp41'), Buffer.alloc(8)));
  fs.writeFileSync(path.join(dir, 'plain.ico'), 'not an icon at all');
  for (const [route, base, headers] of fileBases('image')) {
    for (const [name, [type, bytes]] of Object.entries(images)) {
      const response = await fetch(`${base}?path=${encodeURIComponent(`pics/${name}`)}`, { headers });
      assert.equal(response.status, 200, `${route} ${name}`);
      assert.equal(response.headers.get('content-type'), type, `${route} ${name}`);
      assert.equal(response.headers.get('content-security-policy'), 'sandbox', `${route} ${name}`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${route} ${name}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, `${route} ${name}`);
    }
    for (const name of ['text.svg', 'png.bmp', 'icon.bmp', 'heic.avif', 'video.avif', 'plain.ico']) {
      const response = await fetch(`${base}?path=${encodeURIComponent(`pics/${name}`)}`, { headers });
      assert.equal(response.status, 415, `${route} ${name}`);
      if (route !== 'proxy') assert.deepEqual(await response.json(), { error: 'FILE_NOT_IMAGE' });
      else await response.arrayBuffer();
    }
  }
});

test('raw files: PDF, audio and video stream with Range support, signature checks, limits and the right headers', async () => {
  const dir = path.join(task.workspace, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const pdf = fixture('%PDF-1.7\n', Buffer.alloc(1000, 0x41), '\n%%EOF\n');
  const mp4 = fixture(ftyp('isom', 'mp41'), Buffer.alloc(4096, 7));
  const samples = {
    'doc.pdf': ['application/pdf', pdf],
    'clip.mp4': ['video/mp4', mp4],
    'clip.webm': ['video/webm', fixture(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64))],
    'clip.mov': ['video/quicktime', fixture(ftyp('qt  '), Buffer.alloc(64))],
    'tune.mp3': ['audio/mpeg', fixture('ID3', Buffer.alloc(64))],
    'frame.mp3': ['audio/mpeg', fixture(Buffer.from([0xff, 0xfb, 0x90]), Buffer.alloc(64))],
    'tune.m4a': ['audio/mp4', fixture(ftyp('M4A '), Buffer.alloc(64))],
    'tune.aac': ['audio/aac', fixture(Buffer.from([0xff, 0xf1, 0x50]), Buffer.alloc(64))],
    'tune.wav': ['audio/wav', fixture('RIFF', Buffer.alloc(4), 'WAVEfmt ', Buffer.alloc(64))],
    'tune.ogg': ['audio/ogg', fixture('OggS', Buffer.alloc(64))],
    'tune.flac': ['audio/flac', fixture('fLaC', Buffer.alloc(64))],
    'film.ogv': ['video/ogg', fixture('OggS', Buffer.alloc(64))],
  };
  for (const [name, [, bytes]] of Object.entries(samples)) fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(path.join(dir, 'fake.pdf'), '<html>not a pdf</html>');
  fs.writeFileSync(path.join(dir, 'pdf.mp4'), pdf);
  fs.writeFileSync(path.join(dir, 'text.mp3'), 'hello');
  fs.writeFileSync(path.join(dir, 'empty.webm'), '');
  {
    const descriptor = fs.openSync(path.join(dir, 'huge.pdf'), 'w');
    fs.writeSync(descriptor, '%PDF-1.7\n');
    fs.ftruncateSync(descriptor, 200 * 1024 * 1024 + 1);
    fs.closeSync(descriptor);
  }
  fs.symlinkSync(path.join(dir, 'doc.pdf'), path.join(dir, 'link.pdf'));

  for (const [route, base, headers] of fileBases('raw')) {
    const get = (name, extra = {}, method = 'GET') => fetch(`${base}?path=${encodeURIComponent(name)}`, { method, headers: { ...headers, ...extra } });
    for (const [name, [type, bytes]] of Object.entries(samples)) {
      const response = await get(`media/${name}`);
      assert.equal(response.status, 200, `${route} ${name}`);
      assert.equal(response.headers.get('content-type'), type, `${route} ${name}`);
      assert.equal(response.headers.get('content-length'), String(bytes.length), `${route} ${name}`);
      assert.equal(response.headers.get('accept-ranges'), 'bytes', `${route} ${name}`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${route} ${name}`);
      assert.equal(response.headers.get('cache-control'), 'private, no-cache', `${route} ${name}`);
      assert.equal(response.headers.get('content-disposition'), 'inline', `${route} ${name}`);
      // Chrome refuses to show a sandboxed PDF: only the PDF goes without the CSP sandbox, also through the proxy.
      assert.equal(response.headers.get('content-security-policy'), type === 'application/pdf' ? null : 'sandbox', `${route} ${name}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, `${route} ${name}`);
    }

    const ranged = await get('media/clip.mp4', { Range: 'bytes=100-199' });
    assert.equal(ranged.status, 206, route);
    assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${mp4.length}`, route);
    assert.equal(ranged.headers.get('content-length'), '100', route);
    assert.equal(ranged.headers.get('content-security-policy'), 'sandbox', route);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), mp4.subarray(100, 200), route);
    const open = await get('media/clip.mp4', { Range: `bytes=${mp4.length - 10}-` });
    assert.equal(open.status, 206, route);
    assert.deepEqual(Buffer.from(await open.arrayBuffer()), mp4.subarray(mp4.length - 10), route);
    const suffix = await get('media/doc.pdf', { Range: 'bytes=-7' });
    assert.equal(suffix.status, 206, route);
    assert.equal(suffix.headers.get('content-range'), `bytes ${pdf.length - 7}-${pdf.length - 1}/${pdf.length}`, route);
    assert.equal(suffix.headers.get('content-security-policy'), null, route);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), pdf.subarray(pdf.length - 7), route);
    const clipped = await get('media/clip.mp4', { Range: 'bytes=0-999999' });
    assert.equal(clipped.status, 206, route);
    assert.equal(clipped.headers.get('content-range'), `bytes 0-${mp4.length - 1}/${mp4.length}`, route);
    await clipped.arrayBuffer();
    for (const bad of [`bytes=${mp4.length}-`, 'bytes=50-10', 'bytes=x-y', 'bytes=-0']) {
      const response = await get('media/clip.mp4', { Range: bad });
      assert.equal(response.status, 416, `${route} ${bad}`);
      assert.equal(response.headers.get('content-range'), `bytes */${mp4.length}`, `${route} ${bad}`);
      assert.deepEqual(await response.json(), { error: 'RANGE_NOT_SATISFIABLE' }, `${route} ${bad}`);
    }
    const whole = await get('media/clip.mp4', { Range: 'bytes=0-1,5-6' });
    assert.equal(whole.status, 200, `${route}: several ranges are ignored`);
    await whole.arrayBuffer();

    const head = await get('media/clip.mp4', {}, 'HEAD');
    assert.equal(head.status, 200, route);
    assert.equal(head.headers.get('content-length'), String(mp4.length), route);

    const status = async (name, code) => {
      const response = await get(name);
      assert.equal(response.status, code, `${route} ${name}`);
      return response.json();
    };
    assert.deepEqual(await status('media/fake.pdf', 415), { error: 'FILE_UNSUPPORTED' }, 'the signature must match');
    assert.deepEqual(await status('media/pdf.mp4', 415), { error: 'FILE_UNSUPPORTED' });
    assert.deepEqual(await status('media/text.mp3', 415), { error: 'FILE_UNSUPPORTED' });
    assert.deepEqual(await status('media/empty.webm', 415), { error: 'FILE_UNSUPPORTED' });
    assert.deepEqual(await status('notes.txt', 415), { error: 'FILE_UNSUPPORTED' }, 'only the raw types');
    assert.deepEqual(await status('docs/img/shot.png', 415), { error: 'FILE_UNSUPPORTED' }, 'images use /image');
    assert.deepEqual(await status('media/huge.pdf', 413), { error: 'FILE_TOO_LARGE' }, 'limit 200 MiB');
    assert.deepEqual(await status('media/link.pdf', 415), { error: 'FILE_UNSUPPORTED' }, 'no symbolic links');
    assert.deepEqual(await status('media/missing.pdf', 404), { error: 'FILE_NOT_FOUND' });
    assert.deepEqual(await status('../outside.pdf', 400), { error: 'FILE_PATH_INVALID' });
  }
});

test('raw files: the Engine advertises files:raw, needs a token, and the proxy answers RAW_UNSUPPORTED for an Engine without it', async () => {
  const info = await jsonRequest(engineBase, '/v1/info', { token: reader });
  assert.ok(info.payload.capabilities.includes('files:raw'));
  assert.equal(info.payload.api_version, 1);
  const anonymous = await fetch(`${engineBase}/v1/tasks/${task.id}/files/raw?path=media/doc.pdf`);
  assert.equal(anonymous.status, 401);
  await anonymous.arrayBuffer();

  const oldApp = express();
  oldApp.get('/v1/info', (req, res) => res.json({ capabilities: ['files:read', 'files:image', 'fs:read-any'] }));
  oldApp.get('/v1/tasks/:id/files/raw', (req, res) => res.status(500).json({ error: 'MUST_NOT_BE_CALLED' }));
  const oldServer = await listen(oldApp);
  try {
    const oldBase = `http://127.0.0.1:${oldServer.address().port}`;
    const oldId = db.prepare('INSERT INTO remote_servers (owner_id, name, base_url, token_cipher) VALUES (?, ?, ?, ?)')
      .run('owner', 'old-raw', oldBase, encryptToken('old-token', process.env.SESSION_SECRET)).lastInsertRowid;
    for (const route of [`/api/remote-servers/${oldId}/tasks/${task.id}/files/raw?path=media/doc.pdf`, `/api/remote-servers/${oldId}/fs/raw?path=/x.pdf`]) {
      const response = await jsonRequest(localBase, route);
      assert.equal(response.response.status, 501, route);
      assert.deepEqual(response.payload, { error: 'RAW_UNSUPPORTED' }, route);
    }
  } finally {
    await new Promise(resolve => oldServer.close(resolve));
  }
});

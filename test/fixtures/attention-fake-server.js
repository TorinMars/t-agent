// A small fake T-Attention server (/api/attention) for the CLI and listener tests: items in memory, Bearer auth and
// the status codes of the contract (400 for a create without a title, 409 for a duplicate external_ref, 404, 401).
// `handler` may answer a request itself (return anything but false). `legacy: true` acts like a server from before
// GET /api/attention/by-ref/:ref: an HTML 404 for it, as Express answers an unknown route.
const http = require('node:http');

const TOKEN = 'tatt_test-token';

function fakeServer({ token = TOKEN, handler, legacy = false } = {}) {
  const requests = [];
  const items = new Map();
  let nextId = 1;
  const make = body => {
    const at = new Date().toISOString();
    const item = { id: nextId++, title: body.title, notes: body.notes ?? null, status: body.status || 'todo', priority: body.priority || 'none', due_date: body.due_date ?? null, source: body.source || 'user', external_ref: body.external_ref ?? null, attention_reason: body.attention_reason ?? null, link_url: body.link_url ?? null, link_label: body.link_label ?? null, meta: body.meta ?? null, created_at: at, updated_at: at };
    items.set(item.id, item);
    return item;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const send = (status, value) => {
        res.statusCode = status;
        if (value === undefined) { res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (handler && handler(req, res, { url, body, send }) !== false) return;
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'UNAUTHORIZED', message: 'Invalid token' });
      const parts = url.pathname.replace(/^\/api\/attention\/?/, '').split('/').filter(Boolean);
      if (!url.pathname.startsWith('/api/attention')) return send(404, { error: 'NOT_FOUND', message: 'Not found' });
      if (!parts.length && req.method === 'GET') {
        let list = [...items.values()];
        const statuses = url.searchParams.get('status');
        if (statuses) list = list.filter(item => statuses.split(',').includes(item.status));
        else if (!url.searchParams.get('include_done')) list = list.filter(item => !['done', 'failed', 'cancelled'].includes(item.status));
        return send(200, { items: list });
      }
      if (!parts.length && req.method === 'POST') {
        if (!body.title) return send(400, { error: 'INVALID', message: 'title cannot be empty' });
        const existing = [...items.values()].find(item => body.external_ref && item.external_ref === body.external_ref);
        if (existing) return send(409, { error: 'EXTERNAL_REF_EXISTS', message: 'A task with this external_ref already exists', id: existing.id });
        return send(201, make(body));
      }
      if (parts[0] === 'by-ref' && req.method === 'GET') {
        if (legacy) { res.statusCode = 404; res.setHeader('Content-Type', 'text/html'); res.end('<pre>Cannot GET</pre>'); return; }
        const found = [...items.values()].find(item => item.external_ref === decodeURIComponent(parts[1]));
        if (!found) return send(404, { error: 'NOT_FOUND', message: 'Task not found' });
        return send(200, { item: found, events: [{ id: 1, item_id: found.id, at: found.created_at, actor: 'cli', type: 'created', from_status: null, to_status: found.status }] });
      }
      if (parts[0] === 'by-ref' && req.method === 'PUT') {
        const ref = decodeURIComponent(parts[1]);
        const existing = [...items.values()].find(item => item.external_ref === ref);
        if (existing) { Object.assign(existing, body); return send(200, existing); }
        if (!body.title) return send(400, { error: 'INVALID', message: 'title cannot be empty' });
        return send(201, make({ ...body, external_ref: ref }));
      }
      const item = items.get(Number(parts[0]));
      if (!item) return send(404, { error: 'NOT_FOUND', message: 'Task not found' });
      if (req.method === 'GET') return send(200, { item, events: [{ id: 1, item_id: item.id, at: item.created_at, actor: 'cli', type: 'created', from_status: null, to_status: item.status }] });
      if (req.method === 'PATCH') { Object.assign(item, body); return send(200, item); }
      if (req.method === 'DELETE') { items.delete(item.id); return send(204); }
      return send(405, { error: 'METHOD', message: 'Method not allowed' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, requests, items, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) });
  }));
}

module.exports = { fakeServer, TOKEN };

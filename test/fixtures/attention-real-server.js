// The real T-Attention service and routes on an in-memory database, behind the Bearer entry (routes/attention.js `bearer`), for the CLI and
// importer tests: the requests go through the same validation, tree rules and ordering as on a T-Agent server.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionService } = require('../../services/attention');
const { createAttentionRoutes } = require('../../routes/attention');

function realServer() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));
  const service = createAttentionService({ db });
  const routes = createAttentionRoutes({ service });
  const app = express();
  const requests = [];
  app.use((req, res, next) => { requests.push({ method: req.method, path: req.path }); next(); });
  app.use('/api/attention', routes.bearer);
  const { token } = service.createToken({ name: 'test' });
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`, token, service, db, requests,
        close: () => new Promise(done => { routes.closeStreams(); server.close(() => { db.close(); done(); }); }),
      });
    });
  });
}

module.exports = { realServer };

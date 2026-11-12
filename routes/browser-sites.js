'use strict';
// The site capability library routes (browser feature; "Site library" in DESIGN.md). Two routers:
//  - page router (/api/browser-sites, behind the Client login like the other settings pages): list, read, delete and edit the entries the Settings
//    "Site library" viewer shows. Read-only viewing plus delete is what the viewer needs; editing is normally done by agents through `tcli site`.
//  - tcli relay (/api/tcli/site/*, terminal hook token, this machine only, mounted like /api/tcli/oss before the body parsers and the gates): the
//    commands `tcli site list | show | save | edit | rm | search` run against it. A request without the X-T-Agent-* headers is passed on untouched.
// The service (services/browser-sites.js) validates, redacts and refuses a secret-looking value (SITE_HAS_SECRET). Errors are JSON { error, message }.
const express = require('express');
const { BrowserSiteError } = require('../services/browser-sites');
const { fromThisMachine, isTerminalRequest, verifyTerminalRequest } = require('../lib/terminal-relay-auth');

const RELAY_ERRORS = {
  TCLI_AUTH_REQUIRED: [401, 'The terminal headers X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token are required'],
  TCLI_AUTH_INVALID: [403, 'The terminal token is not valid'],
};
const JSON_LIMIT = '2mb'; // a whole entry is at most ~1 MiB

function sendError(res, error) {
  const status = error instanceof BrowserSiteError ? error.statusCode : 500;
  const code = error instanceof BrowserSiteError ? error.code : 'INTERNAL';
  const message = error instanceof BrowserSiteError ? error.message : 'The request failed';
  res.status(status).set('Cache-Control', 'no-store').json({ error: code, message });
}

const defaultSites = () => require('../services/browser-sites').getBrowserSites();

// ---- Page router (logged in) ----
function createBrowserSitesRouter({ sites = defaultSites } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: JSON_LIMIT }));
  const service = () => sites();

  router.get('/', (req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ sites: service().list({ query: typeof req.query.query === 'string' ? req.query.query : undefined }) }); }
    catch (error) { sendError(res, error); }
  });
  router.get('/search', (req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ results: service().search(typeof req.query.q === 'string' ? req.query.q : '') }); }
    catch (error) { sendError(res, error); }
  });
  router.get('/:site', (req, res) => {
    try {
      const entry = service().get(req.params.site);
      if (!entry) return sendError(res, new BrowserSiteError('SITE_NOT_FOUND', `No entry for ${req.params.site}`, 404));
      res.set('Cache-Control', 'no-store').json({ site: entry });
    } catch (error) { sendError(res, error); }
  });
  // Edit from the page (not used by the read-only viewer, kept for completeness): a partial entry merged in.
  router.patch('/:site', (req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ site: service().edit(req.params.site, req.body && typeof req.body === 'object' ? req.body : {}) }); }
    catch (error) { sendError(res, error); }
  });
  router.delete('/:site', (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(service().remove(req.params.site)); }
    catch (error) { sendError(res, error); }
  });
  router.use((error, req, res, next) => { // a body the JSON parser refused
    if (error && error.type) return sendError(res, new BrowserSiteError('INVALID_SITE', 'Invalid JSON body', 400));
    next(error);
  });
  return router;
}

// ---- tcli relay (/api/tcli/site, this machine only) ----
function createSiteRelayRouter({
  db = require('../db'),
  verifyToken = (...args) => require('./terminal').verifyHookToken(...args),
  isLocal = fromThisMachine,
  sites = defaultSites,
} = {}) {
  const router = express.Router();
  const service = () => sites();

  router.use('/site', (req, res, next) => {
    if (!isTerminalRequest(req, isLocal)) return next('router');
    const { error } = verifyTerminalRequest(req, { db, verifyToken });
    if (error) {
      const [status, message] = RELAY_ERRORS[`TCLI_${error}`];
      if (!req.complete) res.set('Connection', 'close');
      return res.status(status).json({ error: `TCLI_${error}`, message });
    }
    next();
  });

  const site = express.Router();
  site.use(express.json({ limit: JSON_LIMIT }));
  const answer = run => (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(run(service(), req)); }
    catch (error) { if (!req.complete) res.set('Connection', 'close'); sendError(res, error); }
  };

  site.get('/list', answer((s, req) => ({ sites: s.list({ query: typeof req.query.query === 'string' ? req.query.query : undefined }) })));
  site.get('/search', answer((s, req) => ({ results: s.search(typeof req.query.q === 'string' ? req.query.q : (typeof req.query.text === 'string' ? req.query.text : '')) })));
  site.get('/show', answer((s, req) => {
    const entry = s.get(typeof req.query.site === 'string' ? req.query.site : '');
    if (!entry) throw new BrowserSiteError('SITE_NOT_FOUND', `No entry for ${req.query.site}`, 404);
    return { site: entry };
  }));
  site.post('/save', answer((s, req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.site !== 'string') throw new BrowserSiteError('INVALID_SITE', 'A site host is required');
    return { site: s.save(body.site, body.entry && typeof body.entry === 'object' ? body.entry : {}) };
  }));
  site.post('/edit', answer((s, req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.site !== 'string') throw new BrowserSiteError('INVALID_SITE', 'A site host is required');
    const changes = body.changes && typeof body.changes === 'object' ? body.changes : (body.entry && typeof body.entry === 'object' ? body.entry : {});
    return { site: s.edit(body.site, changes) };
  }));
  site.post('/rm', answer((s, req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.site !== 'string') throw new BrowserSiteError('INVALID_SITE', 'A site host is required');
    if (body.confirm !== true) throw new BrowserSiteError('CONFIRM_REQUIRED', 'rm needs confirm: true (it deletes the entry for good)');
    return s.remove(body.site);
  }));
  site.use((req, res) => res.status(404).json({ error: 'UNKNOWN_ROUTE', message: 'tcli has no such site route; update tcli or T-Agent' }));
  site.use((error, req, res, next) => { // a body the JSON parser refused
    if (error && error.type) return sendError(res, new BrowserSiteError('INVALID_SITE', 'Invalid JSON body', 400));
    next(error);
  });
  router.use('/site', site);
  return router;
}

module.exports = { createBrowserSitesRouter, createSiteRelayRouter, RELAY_ERRORS };

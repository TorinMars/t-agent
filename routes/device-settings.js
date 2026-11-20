'use strict';
// Settings of a linked device, changed from this device's page ("Settings of a linked device" in docs/design/linked-device-settings.md). The settings sheet has a selector
// "Settings for: This device | K01 | ..."; with a linked device chosen, every part labelled "This device only" reads and writes that device's own
// values through the link. Shared parts and Telegram are one set already and never go this way.
//
// Two sides:
//  - The device that is changed (the peer, capability `settings:device` in /v1/info): /v1/device-settings/<path>, mounted in routes/engine-v1.js.
//    Only a token issued for a live service link gets in (403 LINKED_ONLY for any other Engine token, admin or not), and only the requests in
//    ALLOWLIST below (method + exact path; anything else is 404 DEVICE_SETTING_NOT_ALLOWED, before any handler). A body is cut down to the fields the
//    entry names. The handlers are the page's own routers (the same services and answers as /api/...), so the peer answers exactly what its own page
//    would get: no route that holds a secret (OSS keys, translator keys, tokens, the Telegram session) is on the list.
//  - The device the page runs on: GET /api/device-settings/devices lists the linked devices and whether each supports it, and
//    /api/device-settings/<server id>/<path> forwards one allowlisted call to that device with the link's stored token (services/remote-client.js,
//    `tunnel://` included). Behind the browser session and the same-origin gate of /api, like every setting.
//
// The path of a call is the page's own path without its leading `/api`: the page's GET /api/peer-fs/settings is GET /v1/device-settings/peer-fs/settings,
// and GET /auth/me (the working directory) is GET /v1/device-settings/auth/me, which answers only { work_dir, effective_work_dir }.
const express = require('express');

const CAPABILITY = 'settings:device';
const SKILL_NAME = '[a-z0-9][a-z0-9-]{0,63}';
const RULE_SYNC_ACTIONS = 'create-shared|push|reset-source|remove-import|dismiss-local-changes';

// method, path pattern (anchored, case-sensitive; a path is checked as the request wrote it, so `..`, `%2e`, a trailing slash or another case never
// match), the body fields passed on (null: no body), and how long the device on the page waits for the answer.
const ALLOWLIST = Object.freeze([
  { method: 'GET', path: /^\/auth\/me$/, body: null },
  { method: 'PUT', path: /^\/auth\/settings$/, body: ['work_dir'] },
  { method: 'GET', path: /^\/peer-fs\/settings$/, body: null },
  { method: 'PUT', path: /^\/peer-fs\/settings$/, body: ['enabled'] },
  { method: 'GET', path: /^\/agent-skills$/, body: null },
  { method: 'POST', path: new RegExp(`^/agent-skills/${SKILL_NAME}/install$`), body: [], timeoutMs: 60_000 },
  { method: 'POST', path: /^\/agent-skills\/t-attention\/remove-old$/, body: [], timeoutMs: 60_000 },
  { method: 'GET', path: /^\/rule-sync$/, body: null },
  { method: 'PUT', path: /^\/rule-sync$/, body: ['role', 'codex', 'skills', 'claude_settings_keys', 'keep_local'], timeoutMs: 30_000 },
  { method: 'POST', path: new RegExp(`^/rule-sync/(?:${RULE_SYNC_ACTIONS})$`), body: [], timeoutMs: 60_000 },
  { method: 'GET', path: /^\/rule-sync\/shared$/, body: null, timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 },
  { method: 'PUT', path: /^\/rule-sync\/shared$/, body: ['content', 'base_revision'], timeoutMs: 20_000 },
  { method: 'GET', path: /^\/attention\/widget\/settings$/, body: null },
  // The window switch and its preferences only: its language is a shared setting (settings sync), changed on this device's page.
  { method: 'PUT', path: /^\/attention\/widget\/settings$/, body: ['enabled', 'hotkeys', 'dim_when_idle', 'show_activity'], timeoutMs: 20_000 },
  // The "Company computer" flag (routes/device-tier.js, services/device-tier.js).
  { method: 'GET', path: /^\/device-tier$/, body: null },
  { method: 'PUT', path: /^\/device-tier$/, body: ['company_computer'] },
  // The tools agent sessions rely on, for Settings → Devices → Environment (routes/environment.js; capability `environment:tools`). Read only;
  // POST probes again. The probes take a few seconds (a login shell may be asked where a program is).
  { method: 'GET', path: /^\/environment\/tools$/, body: null, timeoutMs: 30_000 },
  { method: 'POST', path: /^\/environment\/tools$/, body: [], timeoutMs: 30_000 },
]);

// The entry for a request, or null. `path` must be a plain path of printable ASCII.
function allowedRoute(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string' || !/^\/[\x21-\x7e]*$/.test(path)) return null;
  return ALLOWLIST.find(entry => entry.method === method && entry.path.test(path)) || null;
}

// Only the fields the entry names, and only from a plain object.
function bodyFor(entry, body) {
  if (!entry || entry.body === null) return undefined;
  const given = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return Object.fromEntries(entry.body.filter(key => Object.hasOwn(given, key)).map(key => [key, given[key]]));
}

const pass = (req, res, next) => next();
const notAllowed = res => res.status(404).json({ error: 'DEVICE_SETTING_NOT_ALLOWED' });

// The desktop window's settings router for a peer (routes/attention-widget.js `peerSettings`); server.js registers it, since the window's launcher
// and settings are made there. Without it the two widget paths answer 404 WIDGET_UNAVAILABLE.
let widgetRouter = null;
function registerWidgetSettings(router) { widgetRouter = router; }

// ---- The device that is changed: /v1/device-settings ----
function createEngineDeviceSettingsRouter(options = {}) {
  const {
    serviceLinks = require('../services/service-links').getServiceLinks(),
    requireEngineAuth = require('../middleware/engine-auth'),
    db = require('../db'),
    owner = () => require('../services/single-user').ensureSingleUser(),
    peerFsSettings = () => require('./peer-fs').createPeerFsSettingsRouter(),
    agentSkills = () => require('./agent-skills').createAgentSkillsRouter({ requireAuth: pass, clientOrigin: pass }),
    ruleSync = () => require('./rule-sync').createBrowserRouter({ requireAuth: pass, clientOrigin: pass }),
    widget = () => widgetRouter,
    deviceTier = () => require('./device-tier').createDeviceTierRouter(),
    environment = () => require('./environment').createEnvironmentToolsRouter(),
  } = options;
  const { effectiveWorkDir, saveWorkDir } = require('../services/work-dir');
  const router = express.Router();
  // An Engine token with admin first, then a live link: the same rule as /v1/settings-sync.
  router.use(requireEngineAuth('engine:admin'), (req, res, next) => {
    const link = serviceLinks.linkForToken(req.engineAuth.tokenId);
    if (!link || link.revoked) return res.status(403).json({ error: 'LINKED_ONLY' });
    next();
  });
  router.use((req, res, next) => {
    const entry = allowedRoute(req.method, req.path);
    if (!entry) return notAllowed(res);
    req.body = bodyFor(entry, req.body) || {};
    res.set('Cache-Control', 'no-store');
    next();
  });
  // The working directory only: /auth/me of the page also holds the account and the access mode, which stay on that device's own page.
  const workDir = () => { const user = owner(); return { work_dir: user.work_dir || null, effective_work_dir: effectiveWorkDir(user.work_dir) }; };
  router.get('/auth/me', (req, res) => res.json(workDir()));
  router.put('/auth/settings', (req, res) => {
    try { const saved = saveWorkDir(db, owner().login, req.body.work_dir); res.json({ success: true, work_dir: saved }); }
    catch (error) { res.status(error.status || 400).json(error.body || { error: 'INVALID_WORK_DIRECTORY' }); }
  });
  router.use('/peer-fs', peerFsSettings());
  router.use('/agent-skills', agentSkills());
  router.use('/rule-sync', ruleSync());
  router.use('/device-tier', deviceTier());
  router.use('/environment', environment());
  router.use('/attention/widget/settings', (req, res, next) => {
    const target = widget();
    if (!target) return res.status(404).json({ error: 'WIDGET_UNAVAILABLE' });
    return target(req, res, next);
  });
  router.use((req, res) => notAllowed(res));
  return router;
}

// ---- The device the page runs on: /api/device-settings ----
const INFO_TTL_MS = 60_000;
const INFO_TIMEOUT_MS = 3_000;
const CODE = /^[A-Z0-9_]{1,64}$/;

function createDeviceSettingsRouter(options = {}) {
  const {
    db = require('../db'),
    serviceLinks = require('../services/service-links').getServiceLinks(),
    request = (...args) => require('../services/remote-client').request(...args),
    readInfo = (row, token) => require('../services/remote-info').readRemoteInfo({ baseUrl: row.base_url, token, serverId: row.id }, { timeoutMs: INFO_TIMEOUT_MS }),
    decrypt = cipher => require('../lib/token-crypto').decryptToken(cipher, require('../config').sessionSecret),
    now = Date.now,
  } = options;
  const router = express.Router();
  const owner = req => req.session.user.login;
  // server id -> { at, supported, company, environment } from the last /v1/info that answered (`company`: its `company_computer`, null from an older
  // version; `environment`: whether it lists `environment:tools`).
  const known = new Map();

  // The linked devices of this page's owner: a link that is not revoked, with its row.
  const linkedRows = req => {
    const rows = db.prepare('SELECT * FROM remote_servers WHERE owner_id = ? ORDER BY created_at ASC, id ASC').all(owner(req));
    return rows.map(row => ({ row, link: serviceLinks.linkForServer(row.id) })).filter(({ link }) => link && !link.revoked);
  };
  const tokenOf = row => decrypt(row.token_cipher);

  // { supported, company, environment } of a device: from the cache, else its /v1/info when it is online. Unknown parts are null.
  async function supportOf(row, online) {
    const cached = known.get(row.id);
    const unknown = { supported: null, company: null, environment: null };
    if (cached && now() - cached.at < INFO_TTL_MS) return cached;
    if (!online) return cached || unknown;
    try {
      const info = await readInfo(row, tokenOf(row));
      const capabilities = info && Array.isArray(info.capabilities) ? info.capabilities : [];
      const entry = {
        at: now(), supported: capabilities.includes(CAPABILITY),
        company: capabilities.includes(require('../services/device-tier').CAPABILITY) ? info.company_computer === true : null,
        environment: capabilities.includes(require('../services/environment-check').TOOLS_CAPABILITY),
      };
      known.set(row.id, entry);
      return entry;
    } catch { return cached || unknown; }
  }

  // { devices: [{ id, name, online, supported, company_computer, environment }] }: `id` is the remote_servers row; `supported` is true, false (an
  // older version) or null (not known: offline and never read); `company_computer` is the device's "Company computer" flag, null when not known (an
  // older version, or offline and never read); `environment` whether its tools list can be read (true, false, or null when not known). No address,
  // token or link id.
  router.get('/devices', async (req, res) => {
    const entries = linkedRows(req);
    const devices = await Promise.all(entries.map(async ({ row }) => {
      const online = row.status === 'online';
      const { supported, company, environment } = await supportOf(row, online);
      return { id: row.id, name: row.name, online, supported, company_computer: company, environment: environment === undefined ? null : environment };
    }));
    res.set('Cache-Control', 'no-store').json({ devices });
  });

  // One call of the page, forwarded to the chosen device.
  router.all(/^\/([1-9]\d{0,14})(\/.*)$/, async (req, res) => {
    const serverId = Number(req.params[0]);
    const path = req.params[1];
    const entry = allowedRoute(req.method, path);
    if (!entry) return notAllowed(res);
    const found = linkedRows(req).find(({ row }) => row.id === serverId);
    if (!found) return res.status(404).json({ error: 'DEVICE_NOT_LINKED' });
    let token;
    try { token = tokenOf(found.row); } catch { return res.status(502).json({ error: 'ENGINE_UNAUTHORIZED' }); }
    const body = bodyFor(entry, req.body);
    try {
      const answer = await request(found.row.base_url, `/v1/device-settings${path}`, token, {
        method: entry.method, ...(body === undefined ? {} : { body }), timeoutMs: entry.timeoutMs || 15_000, ...(entry.maxBytes ? { maxBytes: entry.maxBytes } : {}),
      });
      // A changed flag shows in the device list at once instead of after the cache's minute.
      if (path === '/device-tier' && entry.method === 'PUT') known.delete(serverId);
      res.set('Cache-Control', 'no-store').json(answer);
    } catch (error) {
      const status = error.statusCode;
      if (status === 401) {
        try { serviceLinks.noteUnauthorized(found.row.id); } catch { /* the next read notes it */ }
        return res.status(502).json({ error: 'ENGINE_UNAUTHORIZED' });
      }
      const peerCode = Boolean(error.peerBody && typeof error.peerBody.error === 'string');
      // A device from before this feature: its /v1 has no such path, and the answer is a plain 404 or a redirect to its page, without a JSON error.
      if (!peerCode && (status === 404 || (status >= 300 && status < 400))) {
        known.set(found.row.id, { at: now(), supported: false, company: null, environment: false });
        return res.status(501).json({ error: 'DEVICE_SETTINGS_UNSUPPORTED' });
      }
      // The device's own answer, as its page would get it (an allowlisted route of the page; none of them carries a secret).
      if (Number.isInteger(status) && status >= 400 && status < 600) {
        return res.status(status).json(peerCode ? error.peerBody : { error: CODE.test(error.message || '') ? error.message : 'REMOTE_REQUEST_FAILED' });
      }
      res.status(502).json({ error: CODE.test(error.message || '') ? error.message : 'ENGINE_OFFLINE' });
    }
  });
  return router;
}

module.exports = { CAPABILITY, ALLOWLIST, allowedRoute, bodyFor, registerWidgetSettings, createEngineDeviceSettingsRouter, createDeviceSettingsRouter };

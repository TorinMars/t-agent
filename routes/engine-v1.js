const express = require('express');
const db = require('../db');
const config = require('../config');
const requireEngineAuth = require('../middleware/engine-auth');
const tasks = require('../services/engine-tasks');
const taskGroups = require('../services/task-groups');
const taskArchive = require('../services/task-archive');
const taskRename = require('../services/task-rename');
const { exchangePairingCode, createAccessToken, hasScope } = require('../services/engine-auth');
const { getEngineIdentity } = require('../services/engine-identity');
const engineName = require('../services/engine-name');
const { getServiceLinks, CAPABILITY: SERVICE_LINKS } = require('../services/service-links');
const { getTaskVisibility } = require('../services/task-visibility');
const { createTaskVisibilityGuard } = require('../middleware/task-visibility');
const { CAPABILITY: LINKED_SERVICES } = require('../services/linked-capabilities');
const { createTerminalTicket } = require('../services/terminal-tickets');
const updates = require('../services/update-manager');
const terminal = require('./terminal');
const { createTaskFilesRouter } = require('./task-files');
const { createFsReadRouter } = require('./fs-read');
const documents = require('../services/task-documents');
const { resolveAsset, validateMdPath } = require('../services/task-assets');
const { serveFileWatch } = require('../lib/file-watch-sse');
const { createPm2Handlers } = require('./pm2');
const { Pm2Error } = require('../services/pm2-manager');
const { createAppsHandlers, mountAppsRoutes, defaultService: defaultAppsService } = require('./apps');

const MINDMAPS = 'mindmaps';

const router = express.Router();
// Before every route, so that a route added later under /tasks/:id is covered too (middleware/task-visibility.js).
const taskVisibility = getTaskVisibility();
router.use(createTaskVisibilityGuard({ visibility: taskVisibility, db, serviceLinks: getServiceLinks() }));
router.use('/file-sync', require('./file-sync').engine);
router.use('/linked-services', require('./linked-services').createLinkedServicesRouter());
// The shared task order between linked services (routes/task-order.js), link tokens only. It holds keys, not tasks, so per-task visibility leaves it alone.
router.use('/task-order', require('./task-order').createEngineTaskOrderRouter());
// Mind maps of this service, for the other services connected to it (routes/mindmap.js, the same router and service as /api/mindmaps). The token is checked
// before any body is read; server.js keeps the global JSON parser off this path. Maps belong to no task, so per-task visibility does not apply to them.
router.use('/mindmaps', require('./mindmap').createMindmapRouter({ getService: require('../services/mindmap').getMindmapService, authenticate: requireEngineAuth() }));
const pairingAttempts = new Map();

function errorResponse(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'ENGINE_REQUEST_FAILED';
  res.status(error.statusCode || 400).json({ error: code, ...(error.reason ? { reason: error.reason } : {}) });
}

function principal(req) {
  return req.engineAuth.principalId;
}

// The service link this token was issued for, or null: only such a token is subject to per-task visibility.
function linkIdOf(req) {
  const link = getServiceLinks().linkForToken(req.engineAuth.tokenId);
  return link ? link.id : null;
}
const visibleTo = (req, items, idOf) => taskVisibility.visible(linkIdOf(req), items, idOf);
const hiddenFrom = req => taskVisibility.hiddenFrom(linkIdOf(req));
// A group's task_count leaves out the tasks this link may not see.
function withVisibleCounts(req, groups) {
  const hidden = taskVisibility.hiddenStatusCounts(linkIdOf(req));
  return groups.map(group => ({ ...group, task_count: group.task_count - (hidden.get(group.key) || 0) }));
}

function rateLimitPairing(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (pairingAttempts.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'PAIRING_RATE_LIMITED' });
  recent.push(now);
  pairingAttempts.set(key, recent);
  next();
}

// `capabilities` lets a joining service see, before it has any token, that this one can link (/v1/info needs a token).
router.get('/health', (req, res) => {
  res.json({ ok: true, capabilities: [SERVICE_LINKS] });
});

router.post('/pair', rateLimitPairing, (req, res) => {
  try {
    const created = exchangePairingCode(db, req.body.code, {
      clientName: req.body.client_name || 'Client',
    });
    res.status(201).json({
      access_token: created.token,
      token_type: 'Bearer',
      role: created.role,
      scopes: created.scopes.split(','),
      ...getEngineIdentity(),
    });
  } catch (error) { errorResponse(res, error); }
});

// Service links (services/service-links.js). Join has no token: the 6-digit code is its only credential, and only a browser session can make one
// (POST /api/service-links/code), so a linked peer cannot use /v1 to create another link.
router.post('/service-links/join', rateLimitPairing, (req, res) => {
  try { res.status(201).json(getServiceLinks().acceptJoin(req.body)); }
  catch (error) { errorResponse(res, error); }
});

// The peer unlinked. Two paths, one handler: the joiner calls the first directly, the initiator calls the second through the tunnel, whose allowlist refuses
// /v1/service-links so that requests through it can never reach the join route.
for (const route of ['service-links', 'service-link-notice']) {
  router.post(`/${route}/:id/unlink`, requireEngineAuth(), (req, res) => {
    try { getServiceLinks().peerUnlink(req.params.id, req.engineAuth.tokenId); res.status(204).end(); }
    catch (error) { errorResponse(res, error); }
  });
}

function infoHandler(req, res) {
  let version = {};
  try { version = updates.readLocalManifest(); } catch {}
  res.json({
    ...getEngineIdentity(),
    engine_version: version.app_version || require('../package.json').version,
    api_version: 1,
    role: req.engineAuth.role,
    capabilities: [
      'tasks:read', 'tasks:write',
      'task-groups:read', 'task-groups:write',
      'documents:read', 'documents:write',
      'files:read', 'files:write',
      // Parity with the Client's own task routes; older Engines simply lack these.
      // tasks:archive: GET /v1/tasks?archived=1, POST /v1/tasks/:id/archive and /restore. An older Engine ignores `archived`, so the Client checks for this first.
      'tasks:archive',
      // tasks:rename-folder: POST /v1/tasks/:id/rename-folder renames the task's folder and moves its Claude Code and Codex sessions with it.
      'tasks:rename-folder',
      'tasks:reorder', 'documents:create', 'documents:watch', 'files:assets', 'files:image', 'paths:validate', 'terminal:activity', 'terminal:activity-stream',
      'todos:read', 'todos:write',
      'terminal:interactive', 'terminal:control', 'terminal:multiple', 'token:pairing',
      // fs:read-any: GET /v1/fs/content and /v1/fs/image read a file at any path (read only, as the terminal user).
      'fs:read-any',
      // files:raw: GET /v1/tasks/:id/files/raw and /v1/fs/raw stream a PDF, audio or video file with Range support.
      'files:raw',
      // service-links: POST /v1/service-links/join and the reverse tunnel at /v1/service-links/tunnel.
      SERVICE_LINKS,
      // linked-services: /v1/linked-services, a linked service's use of this service's translation, voice input and OSS upload. A peer without it is never used.
      LINKED_SERVICES,
      // mindmaps: GET|POST /v1/mindmaps and GET|PUT|DELETE /v1/mindmaps/:id, the same API as /api/mindmaps. A Client proxies another service's maps only when it has this.
      MINDMAPS,
      // engine-name: PUT /v1/engine-name renames this Engine; `name` above is the current one.
      engineName.CAPABILITY,
      // task-order: GET|PUT /v1/task-order, the shared task order of linked services (link tokens only).
      'task-order',
      'engine:update', 'pm2:manage', 'apps:manage', 'agent-config:manage', 'file-sync:manage', 'workspace:manage', 'agent-chat:manage',
    ],
  });
}

router.get('/info', requireEngineAuth(), infoHandler);
router.get('/capabilities', requireEngineAuth(), infoHandler);

// Rename this Engine from another machine, a host administration operation like the ones below (a service link's token has it too).
// `{ name }`: 1 to 60 characters, or empty / null for the default. Answer `{ name, default_name, custom }`.
router.put('/engine-name', requireEngineAuth('engine:admin'), (req, res) => {
  try { res.json(engineName.setEngineName(db, engineName.nameFromBody(req.body))); }
  catch (error) { errorResponse(res, error); }
});

// Engine self-update is a host administration operation and only allowed for owner (* / engine:admin) tokens.
router.get('/update/status', requireEngineAuth('engine:admin'), (req, res) => {
  res.json(updates.publicState());
});

router.post('/update/check', requireEngineAuth('engine:admin'), async (req, res) => {
  try { res.json(await updates.check({ force: true })); }
  catch (error) {
    res.status(502).json({ error: error.message || 'UPDATE_CHECK_FAILED', status: updates.publicState() });
  }
});

router.post('/update/apply', requireEngineAuth('engine:admin'), (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'UPDATE_CONFIRMATION_REQUIRED' });
  }
  updates.apply().catch(error => console.error('[engine-apply-update]', error.message));
  res.status(202).json({ accepted: true, status: updates.publicState() });
});

// PM2 manages processes on the machine this Engine runs on; it is also a host administration operation and only allowed for owner tokens.
// Errors only return an error code (the Client proxy shows the message for it) and never expose pm2's raw output.
const pm2 = createPm2Handlers();
const pm2Route = handler => async (req, res) => {
  try { res.json(await handler(req)); }
  catch (error) {
    if (error instanceof Pm2Error) return res.status(error.statusCode).json({ error: error.code });
    res.status(500).json({ error: 'PM2_UNAVAILABLE' });
  }
};
router.get('/pm2/status', requireEngineAuth('engine:admin'), pm2Route(pm2.status));
router.get('/pm2/:id/logs', requireEngineAuth('engine:admin'), pm2Route(pm2.logs));
router.post('/pm2/:id/:action', requireEngineAuth('engine:admin'), pm2Route(pm2.control));

// App list (service registry): a token lets a program self-register at startup (POST /v1/apps/register, idempotent by name).
// Also a host administration capability, owner tokens only; errors only return an error code and a message.
const appsRouter = express.Router();
mountAppsRoutes(appsRouter, createAppsHandlers(defaultAppsService()), requireEngineAuth('engine:admin'));
router.use('/apps', appsRouter);

// Agent (Claude / Codex) default configuration: pushed from the Client's "Agent config" page, owner tokens only.
router.use('/agent-config', require('./agent-config').createEngineRouter({ guard: requireEngineAuth('engine:admin') }));
// Workspace tools (import unmanaged directories, clean up code directories): shared with the local /api/tasks/workspace/* via services/workspace-tools.
const workspaceTools = require('../services/workspace-tools');
const workspaceError = (res, error) => res.status(error.statusCode || 500).json({
  error: error.message, ...(error.reason ? { reason: error.reason } : {}), ...(error.path ? { path: error.path } : {}),
});
const workspaceWrite = requireEngineAuth('tasks:write');
router.get('/workspace/unmanaged', requireEngineAuth('tasks:read'), (req, res) => {
  try { res.json(workspaceTools.listUnmanaged(db, principal(req), tasks.DEFAULT_BASE)); }
  catch (error) { workspaceError(res, error); }
});
router.post('/workspace/import', workspaceWrite, (req, res) => {
  try { res.status(201).json(workspaceTools.importDirs(db, principal(req), tasks.DEFAULT_BASE, req.body && req.body.paths)); }
  catch (error) { workspaceError(res, error); }
});
router.get('/workspace/cleanup', requireEngineAuth('tasks:read'), async (req, res) => {
  try { res.json(await workspaceTools.cleanupOverview(db, principal(req), tasks.DEFAULT_BASE, hiddenFrom(req))); }
  catch (error) { workspaceError(res, error); }
});
router.post('/workspace/cleanup', workspaceWrite, async (req, res) => {
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'CONFIRM_REQUIRED' });
  try { res.json(await workspaceTools.cleanupRepos(db, principal(req), tasks.DEFAULT_BASE, req.body.repos, id => terminal.closeTaskTerminals(id), hiddenFrom(req))); }
  catch (error) { workspaceError(res, error); }
});
router.post('/workspace/restore', workspaceWrite, async (req, res) => {
  try { res.json(await workspaceTools.restoreRepo(db, principal(req), req.body && req.body.id, hiddenFrom(req))); }
  catch (error) { workspaceError(res, error); }
});

// Reuse the local conversation API with token authentication and the token's task owner.
router.use('/tasks/:id/agent', require('./agent-chat').createAgentChatRouter({
  authenticate: requireEngineAuth('terminal:execute'),
  ownerOf: principal,
}));

router.get('/tasks', requireEngineAuth('tasks:read'), (req, res) => {
  try { res.json(visibleTo(req, tasks.listTasks(principal(req), req.query.status, { archived: req.query.archived === '1' }), task => task.id)); }
  catch (error) { errorResponse(res, error); }
});

router.use('/tasks/:id/files', requireEngineAuth(), createTaskFilesRouter({
  getTask: req => tasks.ownedTask(principal(req), req.params.id),
  canRead: req => hasScope(req.engineAuth.scopes, 'files:read'),
  canWrite: req => hasScope(req.engineAuth.scopes, 'files:write'),
}));

// A file at any path on this machine, read only and with the terminal user's identity (services/fs-read.js).
router.use('/fs', requireEngineAuth('files:read'), createFsReadRouter());

router.get('/task-groups', requireEngineAuth('tasks:read'), (req, res) => {
  try { res.json(withVisibleCounts(req, taskGroups.listGroups(db, principal(req)))); }
  catch (error) { errorResponse(res, error); }
});

router.post('/task-groups', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.status(201).json(taskGroups.createGroup(db, principal(req), req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/task-groups/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(withVisibleCounts(req, [taskGroups.updateGroup(db, principal(req), req.params.id, req.body)])[0]); }
  catch (error) { errorResponse(res, error); }
});

router.delete('/task-groups/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { taskGroups.deleteGroup(db, principal(req), req.params.id); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

// Declared before /tasks/:id so "reorder" and "validate-path" are not read as task ids.
router.put('/tasks/reorder', requireEngineAuth('tasks:write'), (req, res) => {
  try { tasks.reorderTasks(principal(req), req.body); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.post('/tasks/validate-path', requireEngineAuth('tasks:read'), (req, res) => {
  const result = validateMdPath(req.body && req.body.md_path);
  if (result.status) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

router.post('/tasks', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.status(201).json(tasks.createTask(principal(req), req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.patch('/tasks/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.updateTask(principal(req), req.params.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.updateTask(principal(req), req.params.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

// Rename the task's working folder, with its sessions (services/task-rename.js): `{ name, title? }`, capability tasks:rename-folder.
router.post('/tasks/:id/rename-folder', requireEngineAuth('tasks:write'), (req, res) => {
  try {
    const result = taskRename.renameTaskFolder({ db, owner: principal(req), taskId: req.params.id, body: req.body || {}, workRoot: tasks.DEFAULT_BASE });
    res.json({ ...result, task: tasks.publicTask(result.task) });
  } catch (error) { res.status(error.statusCode || 500).json(taskRename.errorBody(error)); }
});

router.post('/tasks/:id/archive', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.archiveTask(principal(req), req.params.id)); }
  catch (error) { errorResponse(res, error); }
});

router.post('/tasks/:id/restore', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.restoreTask(principal(req), req.params.id)); }
  catch (error) { errorResponse(res, error); }
});

router.delete('/tasks/:id', requireEngineAuth('tasks:write'), (req, res) => {
  try { res.json(tasks.deleteTask(principal(req), req.params.id, { deleteDirectory: req.query.delete_directory === '1' })); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/documents/:kind', requireEngineAuth('documents:read'), (req, res) => {
  try { res.type('text/plain').send(tasks.readDocument(principal(req), req.params.id, req.params.kind)); }
  catch (error) { errorResponse(res, error); }
});

// Singular "document" path kept for compatibility with existing clients.
router.get('/tasks/:id/document/:kind', requireEngineAuth('documents:read'), (req, res) => {
  try { res.type('text/plain').send(tasks.readDocument(principal(req), req.params.id, req.params.kind)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id/documents/:kind', requireEngineAuth('documents:write'), (req, res) => {
  try { tasks.writeDocument(principal(req), req.params.id, req.params.kind, req.body.content); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id/document/:kind', requireEngineAuth('documents:write'), (req, res) => {
  try { tasks.writeDocument(principal(req), req.params.id, req.params.kind, req.body.content); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.post('/tasks/:id/document/:kind', requireEngineAuth('documents:write'), (req, res) => {
  try { tasks.createDocument(principal(req), req.params.id, req.params.kind); res.status(201).json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/document/:kind/watch', requireEngineAuth('documents:read'), (req, res) => {
  const row = tasks.ownedTask(principal(req), req.params.id);
  const file = row && documents.documentPath(documents.resolveTask(row), req.params.kind);
  if (!file) return res.status(404).end();
  serveFileWatch(req, res, file);
});

router.get('/tasks/:id/file', requireEngineAuth('documents:read'), (req, res) => {
  const row = tasks.ownedTask(principal(req), req.params.id);
  if (!row) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  const result = resolveAsset(documents.resolveTask(row), req.query.path);
  if (result.error) return res.status(result.status).json({ error: result.error });
  // Never let a task file run script in the Engine's or Client's origin.
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(result.file);
});

router.get('/tasks/:id/todos', requireEngineAuth('todos:read'), (req, res) => {
  try { res.json(tasks.listTodos(principal(req), req.params.id)); }
  catch (error) { errorResponse(res, error); }
});

router.post('/tasks/:id/todos', requireEngineAuth('todos:write'), (req, res) => {
  try { res.status(201).json(tasks.createTodo(principal(req), req.params.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.patch('/tasks/:id/todos/:todoId', requireEngineAuth('todos:write'), (req, res) => {
  try { res.json(tasks.updateTodo(principal(req), req.params.id, req.params.todoId, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.put('/tasks/:id/todos/:todoId', requireEngineAuth('todos:write'), (req, res) => {
  try { res.json(tasks.updateTodo(principal(req), req.params.id, req.params.todoId, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.delete('/tasks/:id/todos/:todoId', requireEngineAuth('todos:write'), (req, res) => {
  try { tasks.deleteTodo(principal(req), req.params.id, req.params.todoId); res.json({ success: true }); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/terminals', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  res.status(200).json(terminal.listTerminals(task.id));
});

router.post('/tasks/:id/terminals', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try { res.status(201).json(terminal.createTerminal(task.id, req.body)); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/agent-sessions', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try { res.json(terminal.listAgentSessions(task, req.query.agent)); }
  catch (error) { errorResponse(res, error); }
});

router.patch('/tasks/:id/terminals/:terminalId', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try { res.json(terminal.renameTerminal(task.id, req.params.terminalId, req.body && req.body.title)); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tasks/:id/terminals/:terminalId/cwd', requireEngineAuth('terminal:execute'), async (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try { res.json(await terminal.terminalCwd(task, req.params.terminalId)); }
  catch (error) { errorResponse(res, error); }
});

router.get('/terminal-activity', requireEngineAuth('terminal:execute'), (req, res) => {
  res.json(terminal.activitySnapshot(visibleTo(req, taskArchive.activeTaskIds(db, principal(req)))));
});

router.get('/terminal-activity/stream', requireEngineAuth('terminal:execute'), (req, res) => {
  const owner = principal(req);
  const linkId = linkIdOf(req);
  // The task list is read again for every message, so each connection follows its own link. The stream covers all tasks, so it ends when the link loses any of them;
  // the reader reconnects and gets a picture without that task.
  if (linkId) res.on('close', taskVisibility.track(linkId, null, () => res.end()));
  terminal.serveActivityStream(req, res, () => taskVisibility.visible(linkId, taskArchive.activeTaskIds(db, owner)));
});

router.get('/terminal-subagents', requireEngineAuth('terminal:execute'), (req, res) => {
  res.json(terminal.subagentSnapshot(visibleTo(req, taskArchive.activeTaskIds(db, principal(req)))));
});

router.post('/tasks/:id/terminal/ack', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try { res.json(terminal.acknowledgeActivity(task.id, req.body && req.body.terminal_id)); }
  catch (error) { errorResponse(res, error); }
});

router.post('/terminal-sessions', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.body.task_id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  if (task.archived_at) return res.status(409).json({ error: 'TASK_ARCHIVED' });
  let terminalId;
  try { terminalId = terminal.assertTerminal(task.id, req.body.terminal_id); }
  catch (error) { return errorResponse(res, error); }
  const created = createTerminalTicket({ principalId: principal(req), taskId: task.id, terminalId, linkId: linkIdOf(req) });
  res.status(201).json({
    session_id: String(task.id),
    ...created,
    websocket_path: `/v1/terminal-sessions/${task.id}/stream?ticket=${encodeURIComponent(created.ticket)}`,
  });
});

router.post('/terminal-sessions/:id/control', requireEngineAuth('terminal:execute'), (req, res) => {
  const task = tasks.ownedTask(principal(req), req.params.id);
  if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
  try { res.json(terminal.controlSession(task.id, req.body && req.body.action, req.body && req.body.terminal_id)); }
  catch (error) { errorResponse(res, error); }
});

router.get('/tokens', requireEngineAuth('engine:admin'), (req, res) => {
  const rows = db.prepare(`SELECT id, name, token_prefix, role, scopes, last_used_at, created_at
    FROM engine_access_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`).all();
  res.json(getServiceLinks().markTokens(rows));
});

router.post('/tokens', requireEngineAuth('engine:admin'), (req, res) => {
  const created = createAccessToken(db, {
    name: req.body.name,
    principalId: config.engineOwnerId,
  });
  res.status(201).json(created);
});

router.delete('/tokens/:id', requireEngineAuth('engine:admin'), async (req, res) => {
  if (Number(req.params.id) === Number(req.engineAuth.tokenId)) {
    return res.status(400).json({ error: 'CANNOT_REVOKE_CURRENT_TOKEN' });
  }
  // A token issued for a service link ends the whole link, not only the token.
  const link = getServiceLinks().linkForToken(req.params.id);
  if (link) {
    try { await getServiceLinks().unlink(link.id); }
    catch (error) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'LINK_UNLINK_FAILED' }); }
    return res.json({ success: true });
  }
  const result = db.prepare(`UPDATE engine_access_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revoked_at IS NULL`).run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
  res.json({ success: true });
});

module.exports = router;

// The HTTP API of Shell notebooks ("HTTP API" in docs/design/shell-notebook.md): /api/tasks/:id/notebooks/:tid/... on this machine and
// /v1/tasks/:id/notebooks/:tid/... on an Engine (token auth, the token's owner), with the same handlers. Every write is a POST, because some network
// paths only pass GET and POST. The work is done by services/notebook-kernels.js.
const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { getNotebookKernels } = require('../services/notebook-kernels');

const HEARTBEAT_MS = 20000;

function createNotebookRouter({ service = null, authenticate = requireAuth, ownerOf = req => req.session.user.login } = {}) {
  const kernels = () => service || getNotebookKernels();
  const router = express.Router({ mergeParams: true });
  router.use(authenticate);

  const taskOf = req => db.prepare('SELECT id, work_dir, md_path, archived_at FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, ownerOf(req));
  const sendError = (res, error) => {
    const code = /^[A-Z0-9_]+$/.test(String(error && error.message)) ? error.message : 'NOTEBOOK_FAILED';
    if (!error.statusCode) console.warn(`[notebook] ${error && error.stack ? error.stack : error}`);
    res.status(error.statusCode || 500).json({ error: code });
  };
  const handle = run => (req, res) => {
    const task = taskOf(req);
    if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    try { res.set('Cache-Control', 'no-store').json(run(task, req)); } catch (error) { sendError(res, error); }
  };

  router.get('/:tid', handle((task, req) => kernels().get(task, req.params.tid)));
  router.post('/:tid/ops', handle((task, req) => {
    // What would change a notebook of an archived task is refused, like a new terminal (reading it is not).
    if (task.archived_at) throw Object.assign(new Error('TASK_ARCHIVED'), { statusCode: 409 });
    return kernels().applyOps(task, req.params.tid, req.body || {});
  }));
  router.post('/:tid/run', handle((task, req) => kernels().run(task, req.params.tid, req.body || {})));
  router.post('/:tid/interrupt', handle((task, req) => kernels().interrupt(task, req.params.tid)));
  router.post('/:tid/restart', handle((task, req) => kernels().restart(task, req.params.tid)));
  router.post('/:tid/stop', handle((task, req) => kernels().stop(task, req.params.tid)));
  router.post('/:tid/input', handle((task, req) => kernels().input(task, req.params.tid, req.body || {})));
  router.post('/:tid/clear', handle((task, req) => {
    if (task.archived_at) throw Object.assign(new Error('TASK_ARCHIVED'), { statusCode: 409 });
    return kernels().clear(task, req.params.tid, req.body || {});
  }));

  // Server-Sent Events: { type: 'snapshot', notebook } first, then every change ("Events" in docs/design/shell-notebook.md); `: ping` every 20 s.
  router.get('/:tid/events', (req, res) => {
    const task = taskOf(req);
    if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
    let unsubscribe = null;
    let heartbeat = null;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
      if (!res.writableEnded) res.end();
    };
    try {
      unsubscribe = kernels().subscribe(task, req.params.tid, text => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
        }
        res.write(`data: ${text}\n\n`);
      }, finish);
    } catch (error) {
      return sendError(res, error);
    }
    heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on('close', finish);
  });

  return router;
}

module.exports = { createNotebookRouter };

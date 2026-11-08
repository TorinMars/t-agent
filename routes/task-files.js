const express = require('express');
const files = require('../services/task-files');
const { IMAGE_HEADERS, sendRaw } = require('../services/file-content');

function errorResponse(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'FILE_OPERATION_FAILED';
  res.status(error.statusCode || 500).json({ error: code });
}

function createTaskFilesRouter({ getTask, canRead = () => true, canWrite = () => true } = {}) {
  if (typeof getTask !== 'function') throw new TypeError('getTask is required');
  const router = express.Router({ mergeParams: true });

  // `?terminal=<id>` on a read (GET): the root is that terminal's own directory instead of the task's working directory (a file link of a
  // terminal that kept its directory after the task's directory changed). Only a terminal of this task; writes always use the task root.
  function taskFor(req, res) {
    const task = getTask(req);
    if (!task) {
      res.status(404).json({ error: 'TASK_NOT_FOUND' });
      return null;
    }
    if (req.method !== 'GET' || req.query.terminal === undefined) return task;
    try {
      const terminal = require('./terminal');
      const id = terminal.assertTerminal(task.id, String(req.query.terminal));
      const dir = terminal.terminalWorkDir(task, id);
      return dir ? { ...task, work_dir: dir } : task;
    } catch (error) {
      errorResponse(res, error);
      return null;
    }
  }

  function requireScope(scope, predicate) {
    return (req, res, next) => {
      if (!predicate(req)) return res.status(403).json({ error: 'ENGINE_SCOPE_REQUIRED', required_scope: scope });
      next();
    };
  }

  router.get('/content', requireScope('files:read', canRead), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    try { res.json(files.read(task, req.query.path)); }
    catch (error) { errorResponse(res, error); }
  });

  // An image of the working directory (a relative image of a Markdown preview), as the image itself. It never runs in the page's origin as a document.
  router.get('/image', requireScope('files:read', canRead), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    let image;
    try { image = files.readImage(task, req.query.path); }
    catch (error) { errorResponse(res, error); return; }
    res.set({ 'Content-Type': image.type, 'Content-Length': String(image.data.length), ...IMAGE_HEADERS });
    res.end(image.data);
  });

  // A PDF, audio or video file of the working directory, streamed with Range support (206 / 416) for the browser's viewer and players.
  router.get('/raw', requireScope('files:read', canRead), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    let file;
    try { file = files.openRaw(task, req.query.path, { range: req.headers.range, head: req.method === 'HEAD' }); }
    catch (error) { errorResponse(res, error); return; }
    sendRaw(res, file);
  });

  router.put('/content', requireScope('files:write', canWrite), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.json(files.write(task, body.path, body.content, body.revision, body.force === true)); }
    catch (error) { errorResponse(res, error); }
  });

  router.get('/', requireScope('files:read', canRead), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    try {
      res.json(files.list(task, {
        path: req.query.path,
        offset: req.query.offset,
        hidden: req.query.hidden,
        writable: canWrite(req),
      }));
    } catch (error) { errorResponse(res, error); }
  });

  router.post('/', requireScope('files:write', canWrite), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.status(201).json(files.create(task, body.path, body.type)); }
    catch (error) { errorResponse(res, error); }
  });

  router.patch('/', requireScope('files:write', canWrite), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.json(files.rename(task, body.path, body.newPath)); }
    catch (error) { errorResponse(res, error); }
  });

  router.delete('/', requireScope('files:write', canWrite), (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.json(files.remove(task, body.path, body.recursive === true)); }
    catch (error) { errorResponse(res, error); }
  });

  return router;
}

module.exports = { createTaskFilesRouter, errorResponse };

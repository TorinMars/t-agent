const express = require('express');
const files = require('../services/task-files');

function errorResponse(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'FILE_OPERATION_FAILED';
  res.status(error.statusCode || 500).json({ error: code });
}

function createTaskFilesRouter({ getTask } = {}) {
  if (typeof getTask !== 'function') throw new TypeError('getTask is required');
  const router = express.Router({ mergeParams: true });

  function taskFor(req, res) {
    const task = getTask(req);
    if (!task) {
      res.status(404).json({ error: 'TASK_NOT_FOUND' });
      return null;
    }
    return task;
  }

  router.get('/content', (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    try { res.json(files.read(task, req.query.path)); }
    catch (error) { errorResponse(res, error); }
  });

  router.put('/content', (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.json(files.write(task, body.path, body.content, body.revision, body.force === true)); }
    catch (error) { errorResponse(res, error); }
  });

  router.get('/', (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    try {
      res.json(files.list(task, {
        path: req.query.path,
        offset: req.query.offset,
        hidden: req.query.hidden,
        writable: true,
      }));
    } catch (error) { errorResponse(res, error); }
  });

  router.post('/', (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.status(201).json(files.create(task, body.path, body.type)); }
    catch (error) { errorResponse(res, error); }
  });

  router.patch('/', (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.json(files.rename(task, body.path, body.newPath)); }
    catch (error) { errorResponse(res, error); }
  });

  router.delete('/', (req, res) => {
    const task = taskFor(req, res);
    if (!task) return;
    const body = req.body || {};
    try { res.json(files.remove(task, body.path, body.recursive === true)); }
    catch (error) { errorResponse(res, error); }
  });

  return router;
}

module.exports = { createTaskFilesRouter, errorResponse };

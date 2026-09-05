const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const groups = require('../services/task-groups');

const router = express.Router();
router.use(requireAuth);

const owner = req => req.session.user.login;

function respondError(res, error) {
  const code = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'TASK_GROUP_REQUEST_FAILED';
  res.status(error.statusCode || 400).json({ error: code });
}

router.get('/', (req, res) => {
  try { res.json(groups.listGroups(db, owner(req))); }
  catch (error) { respondError(res, error); }
});

router.post('/', (req, res) => {
  try { res.status(201).json(groups.createGroup(db, owner(req), req.body)); }
  catch (error) { respondError(res, error); }
});

router.put('/:id', (req, res) => {
  try { res.json(groups.updateGroup(db, owner(req), req.params.id, req.body)); }
  catch (error) { respondError(res, error); }
});

router.delete('/:id', (req, res) => {
  try { groups.deleteGroup(db, owner(req), req.params.id); res.json({ success: true }); }
  catch (error) { respondError(res, error); }
});

module.exports = router;

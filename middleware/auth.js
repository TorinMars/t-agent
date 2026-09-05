const { ensureSingleUser } = require('../services/single-user');

module.exports = function requireAuth(req, res, next) {
  if (!req.session) return res.status(500).json({ error: 'SESSION_UNAVAILABLE' });
  req.session.user = ensureSingleUser();
  next();
};

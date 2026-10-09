const { ensureSingleUser } = require('../services/single-user');
const { getClientAuth } = require('../services/client-auth');
const config = require('../config');

module.exports = function requireAuth(req, res, next) {
  if (!req.session) return res.status(500).json({ error: 'SESSION_UNAVAILABLE' });
  const auth = getClientAuth();
  if (!auth.status(req.session).bound) return res.status(403).json({ error: 'AUTHENTICATOR_BINDING_REQUIRED', redirect: `${config.loginPath}/setup` });
  if (!auth.authenticated(req.session)) return res.status(401).json({ error: 'AUTH_REQUIRED', redirect: config.loginPath });
  req.session.user = ensureSingleUser();
  next();
};

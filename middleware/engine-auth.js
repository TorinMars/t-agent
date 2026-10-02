const db = require('../db');
const { authenticateAccessToken, hasScope } = require('../services/engine-auth');

module.exports = function requireEngineAuth(requiredScope) {
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'ENGINE_TOKEN_REQUIRED' });
    const token = authenticateAccessToken(db, match[1]);
    if (!token) return res.status(401).json({ error: 'ENGINE_TOKEN_INVALID' });
    if (!hasScope(token.scopes, requiredScope)) {
      return res.status(403).json({ error: 'ENGINE_SCOPE_REQUIRED', required_scope: requiredScope });
    }
    req.engineAuth = {
      tokenId: token.id,
      principalId: token.principal_id,
      name: token.name,
      role: token.role,
      scopes: token.scopes,
    };
    next();
  };
};

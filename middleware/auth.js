const config = require('../config');

module.exports = function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.redirect('/login.html');
};

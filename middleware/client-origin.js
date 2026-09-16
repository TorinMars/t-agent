// Browser-session mutations need same-origin proof. Engine Bearer APIs remain
// separate so machine-to-machine clients keep their existing authentication.
module.exports = function clientOrigin(req, res, next) {
  const origin = req.get('origin');
  const expected = `${req.protocol}://${req.get('host')}`;
  if ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'CLIENT_ORIGIN_REQUIRED' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origin && req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(403).json({ error: 'CLIENT_ORIGIN_REQUIRED' });
  res.set('Cache-Control', 'no-store');
  next();
};

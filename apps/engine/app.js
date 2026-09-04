const express = require('express');
const engineV1 = require('../../routes/engine-v1');

function createEngineApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/v1', engineV1);
  app.get('/health', (req, res) => res.redirect(307, '/v1/health'));
  app.use((req, res) => res.status(404).json({ error: 'ENGINE_ROUTE_NOT_FOUND' }));
  return app;
}

module.exports = { createEngineApp };

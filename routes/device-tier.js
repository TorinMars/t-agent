// The "Company computer" flag of this machine (services/device-tier.js; "Device tier" in docs/design/linked-device-settings.md).
//   GET /api/device-tier                          -> { company_computer }
//   PUT /api/device-tier { company_computer }     -> { company_computer }   (400 VALIDATION_FAILED unless it is true or false)
// Behind the page login and the same-origin gate of /api (server.js). A linked device's page reaches the same router at
// /v1/device-settings/device-tier (routes/device-settings.js).
const express = require('express');

function createDeviceTierRouter({ tier = () => require('../services/device-tier').getDeviceTier() } = {}) {
  const router = express.Router();
  router.get('/', (req, res) => res.set('Cache-Control', 'no-store').json({ company_computer: tier().isCompany() }));
  router.put('/', (req, res) => {
    const value = req.body && req.body.company_computer;
    if (typeof value !== 'boolean') return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'company_computer must be true or false' });
    res.set('Cache-Control', 'no-store').json({ company_computer: tier().setCompany(value) });
  });
  return router;
}

module.exports = { createDeviceTierRouter };

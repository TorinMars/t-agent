const db = require('../db');
const config = require('../config');

function getEngineIdentity() {
  const row = db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get();
  return {
    engine_id: row.value,
    name: config.engineName,
  };
}

module.exports = { getEngineIdentity };

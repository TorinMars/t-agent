const db = require('../db');
const { engineNameState } = require('./engine-name');

// `name` is the name this Engine was given (services/engine-name.js), or the default when it was never renamed or was reset.
function getEngineIdentity() {
  const row = db.prepare("SELECT value FROM engine_identity WHERE key = 'instance_id'").get();
  return {
    engine_id: row.value,
    name: engineNameState(db).name,
  };
}

module.exports = { getEngineIdentity };

const { ensureClientSecret } = require('../services/docker-client');
process.env.SESSION_SECRET = ensureClientSecret(process.env.T_AGENT_DATA_DIR || '/var/lib/t-agent', process.env.SESSION_SECRET);
require('../server');

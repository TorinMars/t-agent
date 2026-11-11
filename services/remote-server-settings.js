const { decryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl, request } = require('./remote-client');
const { isTunnelBase } = require('../lib/service-link-tunnel');
const { readRemoteInfo } = require('./remote-info');
const { reportedName } = require('./engine-name');

async function inspectRemoteAddress(row, body, secret, requestFn = request) {
  // A service link has no address to edit: its tunnel:// base stays, whatever the form sends.
  const baseUrl = isTunnelBase(row.base_url) ? row.base_url : normalizeBaseUrl(body.url, body.port);
  const token = decryptToken(row.token_cipher, secret);
  // The answer is synced into the row only when the address is the saved one: a new address is not this row's Engine until it is saved.
  const serverId = baseUrl === row.base_url ? row.id : null;
  const capabilities = await readRemoteInfo({ baseUrl, token, serverId }, { request: requestFn });
  return { baseUrl, capabilities };
}

// An Engine with the capability `engine-name` keeps its own name (services/engine-name.js): the form's name applies only to one without it.
function persistRemoteServerEdit(db, row, ownerId, body, baseUrl, capabilities) {
  const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
  const name = (reportedName(capabilities) || requestedName || row.name || new URL(baseUrl).hostname).slice(0, 80);
  return db.prepare(`UPDATE remote_servers SET name = ?, base_url = ?, status = 'online', remote_version = ?,
    last_checked_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?`).run(
    name,
    baseUrl,
    capabilities.engine_version || capabilities.app_version || null,
    row.id,
    ownerId,
  );
}

module.exports = { inspectRemoteAddress, persistRemoteServerEdit };

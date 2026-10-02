const { decryptToken } = require('../lib/token-crypto');
const { normalizeBaseUrl, request } = require('./remote-client');

async function inspectRemoteAddress(row, body, secret, requestFn = request) {
  const baseUrl = normalizeBaseUrl(body.url, body.port);
  const token = decryptToken(row.token_cipher, secret);
  const capabilities = await requestFn(baseUrl, '/v1/info', token);
  return { baseUrl, capabilities };
}

function persistRemoteServerEdit(db, row, ownerId, body, baseUrl, capabilities) {
  const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
  const name = (requestedName || row.name || new URL(baseUrl).hostname).slice(0, 80);
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

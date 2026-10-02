const { decryptToken } = require('../lib/token-crypto');
const { request } = require('./remote-client');

function remoteCredential(server, secret) {
  return decryptToken(server.token_cipher, secret);
}

async function getStatus(server, secret, requestFn = request) {
  return requestFn(server.base_url, '/v1/update/status', remoteCredential(server, secret));
}

async function check(server, secret, requestFn = request) {
  return requestFn(server.base_url, '/v1/update/check', remoteCredential(server, secret), {
    method: 'POST',
    body: {},
    // Git 安装会先 fetch，允许使用 update-manager 的 120 秒上限。
    timeoutMs: 150_000,
  });
}

async function apply(server, secret, requestFn = request) {
  return requestFn(server.base_url, '/v1/update/apply', remoteCredential(server, secret), {
    method: 'POST',
    body: { confirm: true },
  });
}

function localVersion(status) {
  return status && (status.local_version || (status.local_manifest && status.local_manifest.app_version)) || null;
}

function syncServerVersion(database, serverId, status) {
  const version = localVersion(status);
  if (!version) return;
  database.prepare(`UPDATE remote_servers SET remote_version = ?, status = 'online',
    last_checked_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(version, serverId);
}

module.exports = { apply, check, getStatus, localVersion, syncServerVersion };

// The T-Attention items of a connected service, read and changed on that service's /v1/attention. One helper for the two callers: the browser proxy
// /api/remote-servers/:id/attention (routes/remote-servers.js) and the merged list of the desktop window (routes/attention-widget.js).
//
// An Engine without the capability 'attention:remote' answers 501 ATTENTION_REMOTE_UNSUPPORTED before anything is sent (the answer of /v1/info is kept
// for INFO_MS per row, so a page that polls or reconnects its stream does not read it every time); an offline one 502 with the code `request` gives
// (REMOTE_OFFLINE through a tunnel, REMOTE_CONNECTION_FAILED or REMOTE_TIMEOUT otherwise). An error of the owning service keeps its status, code,
// message and the `id` / `children` of its 409s. Every failure is a RemoteAttentionError with the status and the JSON body to answer.
const config = require('../config');
const { decryptToken } = require('../lib/token-crypto');
const { request: defaultRequest } = require('./remote-client');
const { readRemoteInfo } = require('./remote-info');

const CAPABILITY = 'attention:remote';
const INFO_MS = 30_000;
const safeError = error => (/^[A-Z0-9_]+$/.test((error && error.message) || '') ? error.message : 'REMOTE_CONNECTION_FAILED');

class RemoteAttentionError extends Error {
  constructor(statusCode, body) {
    super(body && body.error ? body.error : 'REMOTE_CONNECTION_FAILED');
    this.name = 'RemoteAttentionError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

function createRemoteAttention({ request = defaultRequest, readInfo = (row, token, options) => readRemoteInfo({ baseUrl: row.base_url, token, serverId: row.id }, options), now = Date.now } = {}) {
  const support = new Map(); // row id -> { at, supported, baseUrl }
  const tokenOf = row => decryptToken(row.token_cipher, config.sessionSecret);

  // Whether the row's Engine has the capability; a failed /v1/info read is a RemoteAttentionError (its status, else 502).
  async function supported(row, token = tokenOf(row), { timeoutMs } = {}) {
    const cached = support.get(Number(row.id));
    if (cached && cached.baseUrl === row.base_url && now() - cached.at < INFO_MS) return cached.supported;
    let info;
    try { info = await readInfo(row, token, timeoutMs ? { timeoutMs } : undefined); }
    catch (error) { throw new RemoteAttentionError(error.statusCode || 502, { error: safeError(error) }); }
    const value = Boolean(info && Array.isArray(info.capabilities) && info.capabilities.includes(CAPABILITY));
    support.set(Number(row.id), { at: now(), supported: value, baseUrl: row.base_url });
    return value;
  }

  // One request to the row's /v1/attention<path>. DELETE answers 204 with no body (null here).
  async function call(row, { method = 'GET', path = '', body, token = tokenOf(row), timeoutMs } = {}) {
    if (!(await supported(row, token, { timeoutMs }))) throw new RemoteAttentionError(501, { error: 'ATTENTION_REMOTE_UNSUPPORTED' });
    try {
      const result = await request(row.base_url, `/v1/attention${path}`, token, {
        method,
        ...(['POST', 'PATCH'].includes(method) ? { body: body ?? {} } : {}),
        ...(method === 'DELETE' ? { expectText: true } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return method === 'DELETE' ? null : result;
    } catch (error) {
      const peer = error.peerBody || {};
      throw new RemoteAttentionError(error.statusCode || 502, {
        error: safeError(error),
        ...(typeof peer.message === 'string' ? { message: peer.message } : {}),
        ...(Number.isSafeInteger(peer.id) ? { id: peer.id } : {}),
        ...(Array.isArray(peer.children) ? { children: peer.children.filter(Number.isSafeInteger) } : {}),
      });
    }
  }

  return { supported, call, forget: id => support.delete(Number(id)) };
}

let singleton = null;
const getRemoteAttention = () => (singleton || (singleton = createRemoteAttention()));

module.exports = { createRemoteAttention, getRemoteAttention, RemoteAttentionError, CAPABILITY };

// The T-Attention items of a connected service, read and changed on that service's /v1/attention. One helper for the two callers: the browser proxy
// /api/remote-servers/:id/attention (routes/remote-servers.js) and the merged list of the desktop window (routes/attention-widget.js).
//
// An Engine without the capability 'attention:remote' answers 501 ATTENTION_REMOTE_UNSUPPORTED before anything is sent (the answer of /v1/info is kept
// for INFO_MS per row, so a page that polls or reconnects its stream does not read it every time; an older answer is still used while it is read again in
// the background, so only the first request to a row ever waits for /v1/info, and `warm` reads it ahead of that; see "Fast actions on a connected
// service" in docs/design/attention-desktop-window.md); an offline one 502 with the code `request` gives
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
  const support = new Map(); // row id -> { at, supported, baseUrl, capabilities }
  const refreshing = new Set(); // row ids whose stale answer is being read again in the background
  const tokenOf = row => decryptToken(row.token_cipher, config.sessionSecret);

  async function readSupport(row, token, timeoutMs) {
    let info;
    try { info = await readInfo(row, token, timeoutMs ? { timeoutMs } : undefined); }
    catch (error) { throw new RemoteAttentionError(error.statusCode || 502, { error: safeError(error) }); }
    const capabilities = info && Array.isArray(info.capabilities) ? info.capabilities.filter(name => typeof name === 'string') : [];
    const value = capabilities.includes(CAPABILITY);
    support.set(Number(row.id), { at: now(), supported: value, baseUrl: row.base_url, capabilities });
    return value;
  }
  // The answer kept for the row (same address), fresh or not; null when there is none.
  const kept = row => { const cached = support.get(Number(row.id)); return cached && cached.baseUrl === row.base_url ? cached : null; };

  // Whether the row's Engine has the capability; a failed /v1/info read is a RemoteAttentionError (its status, else 502). An answer older than INFO_MS is
  // used as it is while one background read brings it up to date (a failed one keeps it; the next call tries again): an action never waits for it.
  async function supported(row, token = tokenOf(row), { timeoutMs } = {}) {
    const cached = kept(row);
    if (cached && now() - cached.at < INFO_MS) return cached.supported;
    if (cached) {
      const id = Number(row.id);
      if (!refreshing.has(id)) {
        refreshing.add(id);
        readSupport(row, token, timeoutMs).catch(() => {}).finally(() => refreshing.delete(id));
      }
      return cached.supported;
    }
    return readSupport(row, token, timeoutMs);
  }
  // Reads the capability in the background when nothing is known of the row yet, so that its first action does not wait for /v1/info (the desktop
  // window's copied engines, which are listed from the copies and never read here otherwise). Never waits and never rejects.
  function warm(row, token) {
    const id = Number(row.id);
    if (kept(row) || refreshing.has(id)) return;
    refreshing.add(id);
    Promise.resolve().then(() => readSupport(row, token === undefined ? tokenOf(row) : token)).catch(() => {}).finally(() => refreshing.delete(id));
  }
  // Whether the row's Engine lists another capability too (read with the same cached /v1/info answer); false when it cannot be read.
  async function has(row, name, token = tokenOf(row)) {
    try { await supported(row, token); } catch { return false; }
    const cached = support.get(Number(row.id));
    return Boolean(cached && cached.capabilities && cached.capabilities.includes(name));
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

  return { supported, has, call, warm, forget: id => support.delete(Number(id)) };
}

let singleton = null;
const getRemoteAttention = () => (singleton || (singleton = createRemoteAttention()));

module.exports = { createRemoteAttention, getRemoteAttention, RemoteAttentionError, CAPABILITY };

// Every read of a remote Engine's /v1/info goes through `read`, so that the name the Engine reports follows into its remote_servers row and its link
// record (services/engine-name.js). See "Engine names" in DESIGN.md.
//
// `refreshStale` is the light refresh of GET /api/remote-servers: rows not read in the last REFRESH_MS are read again in the background, after the
// answer, and only their names are taken from it.
const REFRESH_MS = 60_000;
const BACKGROUND_TIMEOUT_MS = 5_000;

function defaultRequest(...args) {
  return require('./remote-client').request(...args);
}

// The write path for a successful read: services/service-links.js holds the database and the link records.
function defaultSync(serverId, info) {
  require('./service-links').getServiceLinks().syncEngineInfo(serverId, info);
}

function createRemoteInfo({ request = defaultRequest, sync = defaultSync, now = Date.now, defer = fn => setImmediate(fn) } = {}) {
  // serverId -> time of the last read that was started, successful or not.
  const lastRead = new Map();

  // `serverId` is the row the answer belongs to; without it (an address that is only tested, a row not saved yet) nothing is synced.
  // The sync is bookkeeping: a failure there never replaces the answer.
  async function read({ baseUrl, token, serverId = null }, { request: requestFn = request, sync: syncFn = sync, timeoutMs } = {}) {
    if (serverId !== null && serverId !== undefined) lastRead.set(Number(serverId), now());
    const info = timeoutMs ? await requestFn(baseUrl, '/v1/info', token, { timeoutMs }) : await requestFn(baseUrl, '/v1/info', token);
    if (serverId !== null && serverId !== undefined) {
      try { syncFn(Number(serverId), info); } catch { /* the next read tries again */ }
    }
    return info;
  }

  // `targetOf(row)` gives { baseUrl, token } and may throw (a token that cannot be decrypted), which skips the row. Never waits and never rejects.
  function refreshStale(rows, targetOf) {
    const due = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      const at = lastRead.get(Number(row.id));
      if (at !== undefined && now() - at < REFRESH_MS) continue;
      lastRead.set(Number(row.id), now());
      due.push(row);
    }
    if (!due.length) return 0;
    defer(() => {
      for (const row of due) {
        let target;
        try { target = targetOf(row); } catch { continue; }
        read({ ...target, serverId: row.id }, { timeoutMs: BACKGROUND_TIMEOUT_MS }).catch(() => { /* an offline Engine keeps its last name */ });
      }
    });
    return due.length;
  }

  return { read, refreshStale, forget: serverId => lastRead.delete(Number(serverId)) };
}

let singleton = null;
const getRemoteInfo = () => (singleton || (singleton = createRemoteInfo()));
const readRemoteInfo = (target, options) => getRemoteInfo().read(target, options);

module.exports = { createRemoteInfo, getRemoteInfo, readRemoteInfo, REFRESH_MS, BACKGROUND_TIMEOUT_MS };

#!/usr/bin/env node
// Runs one peer file operation for services/peer-fs.js, as the dropped terminal user when the parent spawned it with that uid/gid.
// Usage: peer-fs-child.js <list|read|search> <JSON { policy: { home, deniedRoots }, value, options }>
// Writes JSON lines: for a search one `{ match }` line per match as it is found (the parent keeps them when it has to stop the child), then
// `{ result }` or `{ error: CODE }`. Always exits 0 after an answer.
const { makePolicy, list, read, runSearch } = require('../services/peer-fs');

const [op, payload] = process.argv.slice(2);
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const codeOf = error => (/^[A-Z0-9_]+$/.test(error && error.message || '') ? error.message : 'PEER_FS_READ_FAILED');

(async () => {
  let request;
  try { request = JSON.parse(payload); } catch { request = null; }
  if (!request || !request.policy || typeof request.policy.home !== 'string' || !request.policy.home.startsWith('/') || !['list', 'read', 'search'].includes(op)) {
    write({ error: 'INVALID_PATH' });
    return;
  }
  const policy = makePolicy(request.policy);
  const value = request.value === null ? undefined : request.value;
  const options = request.options || {};
  try {
    let result;
    if (op === 'list') result = await list(policy, value);
    else if (op === 'read') result = await read(policy, value, options);
    else {
      const timeMs = Number.isSafeInteger(options.timeMs) && options.timeMs > 0 ? options.timeMs : 10_000;
      result = await runSearch(policy, value, options, {
        emit: match => write({ match }),
        rgPath: typeof options.rgPath === 'string' && options.rgPath.startsWith('/') ? options.rgPath : null,
        deadline: Date.now() + timeMs,
      });
    }
    write({ result });
  } catch (error) {
    write({ error: codeOf(error) });
  }
})();

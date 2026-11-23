// `tcli browser record items` and `tcli browser record requests`: reading a recording ("Reading recordings" in docs/design/tcli.md). Both ask the
// relay (routes/browser-ext.js) to filter or merge on the server, so a large recording is not sent whole; the filters and the merge are
// lib/browser-recording-query.js, which tcli also runs itself when the T-Agent it talks to is older (no X-T-Agent-Filtered answer for items, or
// UNKNOWN_ROUTE for requests), so the answer is the same either way. Loaded by scripts/tcli-browser.js with its helpers. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { parseItemFilter, filterLines, parseRequestOptions, mergeRequests, QueryError } = require('../lib/browser-recording-query');

const OPEN_TIMEOUT_MS = 45_000; // until the answer starts; reading it has no time limit

function createRecordCommands({ send, readJson, failureOf, networkFailure, CliError, usage, EXIT, humanSize }) {
  const checked = parseFn => {
    try { return parseFn(); } catch (error) { if (error instanceof QueryError) throw usage(error.message); throw error; }
  };
  const queryString = query => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== false) params.set(name, value === true ? '1' : String(value));
    const text = params.toString();
    return text ? `?${text}` : '';
  };

  // GET a route and resolve with the response once it answered 200; anything else rejects with the server's error.
  function open(ctx, route) {
    return new Promise((resolve, reject) => {
      const req = send(ctx.relay(), 'GET', route, { timeoutMs: OPEN_TIMEOUT_MS, headers: { Accept: 'application/x-ndjson, application/json' } });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })));
      req.on('error', error => reject(error instanceof CliError ? error : networkFailure(error)));
      req.on('response', async response => {
        if (response.statusCode !== 200) {
          try { reject(failureOf(response.statusCode, await readJson(response))); } catch (error) { reject(networkFailure(error)); }
          return;
        }
        req.setTimeout(0);
        resolve(response);
      });
      req.end();
    });
  }
  const linesOf = response => readline.createInterface({ input: response, crlfDelay: Infinity });

  // -o file: written to <file>.tcli-part-<pid> and renamed when complete; an existing file needs --force.
  function outputFile(ctx, flags) {
    if (!flags.output || flags.output === '-') return null;
    const file = path.resolve(ctx.cwd, flags.output);
    if (fs.existsSync(file) && !flags.force) throw usage(`${file} exists; add --force to overwrite it`);
    return file;
  }
  async function writeLines(target, lines) {
    for await (const line of lines) {
      if (!target.write(`${line}\n`)) await new Promise(resolve => target.once('drain', resolve));
    }
  }
  async function toFile(file, produce) {
    const part = `${file}.tcli-part-${process.pid}`;
    const target = fs.createWriteStream(part, { mode: 0o600 });
    const failed = new Promise((_, reject) => target.on('error', error => reject(new CliError(`Cannot write: ${error.message}`, EXIT.usage))));
    try {
      await Promise.race([produce(target), failed]);
      await Promise.race([new Promise(resolve => target.end(resolve)), failed]);
    } catch (error) { target.destroy(); fs.rmSync(part, { force: true }); throw error; }
    fs.renameSync(part, file);
    return fs.statSync(file).size;
  }

  const ITEM_FILTERS = ['kind', 'type', 'source', 'url', 'status', 'limit', 'offset'];
  const items = {
    values: ['output', ...ITEM_FILTERS], bools: ['force'],
    async run(ctx, flags, positional) {
      if (positional.length !== 1) throw usage('Usage: tcli browser record items <id> [--kind K] [--type T] [--source agent|user] [--url U] [--status S] [--limit N] [--offset N] [-o file.jsonl]');
      const query = Object.fromEntries(ITEM_FILTERS.map(name => [name, flags[name]]));
      const filter = checked(() => parseItemFilter(query));
      const file = outputFile(ctx, flags);
      const response = await open(ctx, `/browser/recordings/${encodeURIComponent(positional[0])}/items${filter ? queryString(query) : ''}`);
      // An older T-Agent sends every item: filter here.
      const lines = filter && !response.headers['x-t-agent-filtered'] ? filterLines(linesOf(response), filter) : null;
      const copy = async target => {
        if (lines) { await writeLines(target, lines); return; }
        await new Promise((resolve, reject) => {
          response.on('error', error => reject(networkFailure(error)));
          response.on('end', resolve);
          response.pipe(target, { end: false });
        });
      };
      if (file) {
        const size = await toFile(file, copy);
        ctx.out(flags.json ? JSON.stringify({ file, size }) : `Saved ${file} (${humanSize(size)})`);
        return EXIT.ok;
      }
      await copy(ctx.stdout);
      return EXIT.ok;
    },
  };

  const pad = (value, width, end = false) => (end ? String(value).padStart(width) : String(value).padEnd(width));
  function requestText(entry) {
    const size = Number.isFinite(entry.size) ? humanSize(entry.size) : '-';
    const duration = Number.isFinite(entry.duration_ms) ? `${Math.round(entry.duration_ms)}ms` : '-';
    const status = entry.failed ? 'FAIL' : Number.isFinite(entry.status) && entry.status > 0 ? String(entry.status) : '...';
    const marks = [];
    if (entry.from_cache) marks.push('cache');
    if (entry.missing === 'response') marks.push('no response');
    if (entry.missing === 'request') marks.push('request not recorded');
    if (entry.redirected_to) marks.push('redirect');
    if (Number.isFinite(entry.ws_frames)) marks.push(`${entry.ws_frames} frames`);
    const body = entry.request && typeof entry.request.post_data === 'string' ? ` body ${humanSize(Buffer.byteLength(entry.request.post_data))}` : '';
    return `${pad(entry.req_id, 8)} ${pad(entry.method || '', 6)} ${pad(status, 4, true)} ${pad(entry.type || '', 9)} ${pad(size, 7, true)} ${pad(duration, 7, true)}${body}${marks.length ? ` (${marks.join(', ')})` : ''}  ${entry.url || ''}`;
  }

  const REQUEST_FILTERS = ['type', 'url', 'status', 'limit', 'offset'];
  const requests = {
    values: ['output', ...REQUEST_FILTERS], bools: ['all', 'force'],
    async run(ctx, flags, positional) {
      if (positional.length !== 1) throw usage('Usage: tcli browser record requests <id> [--all] [--type T] [--url U] [--status S] [--limit N] [--offset N] [-o file.jsonl] [--json]');
      const query = { ...Object.fromEntries(REQUEST_FILTERS.map(name => [name, flags[name]])), all: flags.all ? true : undefined };
      const options = checked(() => parseRequestOptions(query));
      const file = outputFile(ctx, flags);
      const id = encodeURIComponent(positional[0]);
      let result;
      try {
        const response = await open(ctx, `/browser/recordings/${id}/requests${queryString(query)}`);
        const list = [];
        for await (const line of linesOf(response)) if (line.trim()) list.push(JSON.parse(line));
        result = { requests: list, left_out: Number(response.headers['x-t-agent-left-out']) || 0 };
      } catch (error) {
        // An older T-Agent has no requests route: merge its items here.
        if (!(error instanceof CliError && error.body && error.body.error === 'UNKNOWN_ROUTE')) throw error instanceof CliError ? error : networkFailure(error);
        result = await mergeRequests(linesOf(await open(ctx, `/browser/recordings/${id}/items`)), options);
      }
      const jsonLines = result.requests.map(entry => JSON.stringify(entry));
      if (file) {
        const size = await toFile(file, target => writeLines(target, jsonLines));
        ctx.out(flags.json ? JSON.stringify({ file, size, requests: result.requests.length, left_out: result.left_out }) : `Saved ${file} (${result.requests.length} requests, ${humanSize(size)})`);
        return EXIT.ok;
      }
      if (flags.json) { await writeLines(ctx.stdout, jsonLines); return EXIT.ok; }
      const lines = result.requests.length ? result.requests.map(requestText) : ['No requests match (the recording may have none: record start without --no-network)'];
      if (result.left_out) lines.push(`(${result.left_out} static files left out: --all keeps them)`);
      if (result.requests.length) lines.push('Headers and bodies: --json or -o file.jsonl');
      ctx.out(lines.join('\n'));
      return EXIT.ok;
    },
  };

  return { items, requests, requestText };
}

module.exports = { createRecordCommands };

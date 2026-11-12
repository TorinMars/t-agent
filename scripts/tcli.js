#!/usr/bin/env node
// tcli: the command line of agent sessions in T-Agent terminals. It talks to the T-Agent that started the terminal, through the local relay
// /api/tcli (routes/tcli.js) on the origin of TA_HOOK_URL, with the terminal's hook token (TA_HOOK_TOKEN). The T-Agent makes the real calls, so no
// cloud key is ever in this process. Groups of commands live in GROUPS below; `oss` works on the bucket of "Image and file upload".
// See "tcli (agent command line)" in DESIGN.md. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const EXIT = { ok: 0, usage: 1, auth: 2, notFound: 3, server: 4 };
const META_TIMEOUT_MS = 30_000;
const LIST_ALL_LIMIT = 10_000;
const LIST_PAGE = 1000;

class CliError extends Error {
  constructor(message, exit = EXIT.usage, body = null) { super(message); this.exit = exit; this.body = body; }
}
const usage = message => new CliError(message, EXIT.usage);

const HELP = `tcli: the T-Agent command line for agent sessions

Usage: tcli <group> <command> [options]

Groups
  oss    objects in the OSS bucket of
         "Image and file upload"
         (tcli oss help)

  help   this text

tcli works inside a T-Agent terminal: it uses
TA_HOOK_URL and TA_HOOK_TOKEN, which T-Agent
sets in every shell it starts.

Exit codes: 0 ok, 1 usage or request error,
2 not in a T-Agent terminal or refused,
3 not found, 4 server or network error.
`;

const OSS_HELP = `tcli oss: objects in the OSS bucket of
"Image and file upload" (keys are relative to
the bucket root)

Usage: tcli oss <command> [options]

Commands
  ls [prefix]            list one level
    --recursive          every key below prefix
    --all                follow pages (up to
                         ${LIST_ALL_LIMIT} objects)
    --max N              objects per page (100)
    --marker M           start after key M
  stat <key>             size, type, metadata
  get <key>              download to ./<name>
    -o <file>            save as <file>
    -o -                 write to stdout
    --force              overwrite a file
  put <file> [key]       upload (key: file name)
    --prefix P           put the key under P/
    --content-type T     default: from the name
  cp <src> <dst>         copy an object
  mv <src> <dst>         move (copy, then delete)
  rm <key...> --yes      delete objects
  url <key>              a signed download URL
    --expires S          seconds (3600; 60 to
                         604800)

Options
  --json                 print the JSON answer

Limits: uploads up to 1 GiB (64 MiB through a
service link tunnel), downloads up to 2 GiB.
Types a browser would run as a page (HTML,
SVG, XML, JS, CSS) are stored as
application/octet-stream.
`;

// Content types guessed from the file name for `put` (anything else is application/octet-stream; the server stores active types as bytes).
const TYPES = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', json: 'application/json', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const guessType = file => TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

// ── Arguments ──
// `values`: flags that take a value; `bools`: switches. -o is --output. A lone `-` is a positional value.
function parseArgs(argv, { values = [], bools = [] } = {}) {
  const flags = {};
  const positional = [];
  const allowedValues = new Set(values);
  const allowedBools = new Set([...bools, 'json', 'help']);
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg === '-o') arg = '--output';
    if (arg === '-h') arg = '--help';
    if (!arg.startsWith('--') || arg === '-') { positional.push(arg); continue; }
    let name = arg.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (allowedBools.has(name)) {
      if (value !== undefined) throw usage(`--${name} takes no value`);
      flags[name] = true;
    } else if (allowedValues.has(name)) {
      if (value === undefined) {
        if (i + 1 >= argv.length) throw usage(`--${name} needs a value`);
        value = argv[i += 1];
      }
      flags[name] = value;
    } else throw usage(`Unknown option --${name}`);
  }
  return { flags, positional };
}

function relayFromEnv(env) {
  const notHere = () => new CliError('tcli works inside a T-Agent terminal (TA_HOOK_URL and TA_HOOK_TOKEN are not set)', EXIT.auth);
  if (!env.TA_HOOK_URL || !env.TA_HOOK_TOKEN) throw notHere();
  let url;
  try { url = new URL(env.TA_HOOK_URL); } catch { throw notHere(); }
  const task = url.searchParams.get('task');
  const terminal = url.searchParams.get('terminal');
  if (!['http:', 'https:'].includes(url.protocol) || !task || !terminal) throw notHere();
  return {
    origin: url.origin,
    headers: { 'X-T-Agent-Task': task, 'X-T-Agent-Terminal': terminal, 'X-T-Agent-Token': env.TA_HOOK_TOKEN },
  };
}

// ── HTTP ──
const exitForStatus = status => (status === 401 || status === 403 ? EXIT.auth : status === 404 ? EXIT.notFound : status >= 500 ? EXIT.server : EXIT.usage);

function failureOf(status, body) {
  const code = body && typeof body.error === 'string' ? body.error : `HTTP_${status}`;
  const message = body && typeof body.message === 'string' ? body.message : `The request failed with status ${status}`;
  const extra = body && body.oss_code && !message.includes(body.oss_code) ? ` [${body.oss_code}]` : '';
  const provider = body && typeof body.provider === 'string' ? ` (linked service ${body.provider})` : '';
  return new CliError(`${message}${extra}${provider} (${code})`, exitForStatus(status), body || { error: code, message });
}
const networkFailure = error => new CliError(`Cannot reach T-Agent: ${error.code || error.message}`, EXIT.server, { error: 'NETWORK', message: String(error.code || error.message) });

function send(relay, method, route, { query, headers = {}, timeoutMs } = {}) {
  const url = new URL(`/api/tcli${route}`, relay.origin);
  for (const [name, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  const client = url.protocol === 'https:' ? https : http;
  return client.request(url, { method, headers: { ...relay.headers, ...headers }, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
}

function readJson(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : null); } catch { resolve(null); }
    });
    response.on('error', reject);
  });
}

// A JSON call: resolves with the answer, rejects with a CliError.
function callJson(relay, method, route, { query, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = send(relay, method, route, {
      query, timeoutMs: META_TIMEOUT_MS,
      headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })));
    req.on('error', error => reject(networkFailure(error)));
    req.on('response', async response => {
      try {
        const answer = await readJson(response);
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(answer);
        else reject(failureOf(response.statusCode, answer));
      } catch (error) { reject(networkFailure(error)); }
    });
    req.end(payload || undefined);
  });
}

// Progress on a terminal only (stderr is a TTY), at most once a second.
function progress(stderr, label, total) {
  if (!stderr.isTTY || !total || total < 8 * 1024 * 1024) return { add() {}, done() {} };
  let bytes = 0;
  let last = 0;
  return {
    add(count) {
      bytes += count;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      stderr.write(`\r${label} ${Math.floor((bytes / total) * 100)}% of ${humanSize(total)}`);
    },
    done() { if (last) stderr.write('\n'); },
  };
}

// ── Output ──
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
const shortDate = value => (typeof value === 'string' && value.length >= 16 ? value.slice(0, 16).replace('T', ' ') : '-');

function formatList(answer, prefix) {
  const lines = [];
  for (const item of answer.prefixes || []) lines.push(`     dir  ${item}`);
  for (const object of answer.objects || []) lines.push(`${humanSize(object.size).padStart(8)}  ${shortDate(object.last_modified)}  ${object.key}`);
  if (!lines.length) lines.push(prefix ? `Nothing under ${prefix}` : 'The bucket is empty');
  if (answer.truncated) lines.push(`More: --all, or --marker ${answer.next_marker || '<last key>'}`);
  return lines.join('\n');
}

function formatStat(answer) {
  const lines = [
    answer.key,
    `  size      ${humanSize(answer.size)} (${answer.size} bytes)`,
    `  type      ${answer.content_type || '-'}`,
    `  modified  ${answer.last_modified || '-'}`,
    `  etag      ${answer.etag || '-'}`,
  ];
  if (answer.content_disposition) lines.push(`  disposition ${answer.content_disposition}`);
  for (const [name, value] of Object.entries(answer.meta || {})) lines.push(`  meta ${name}: ${value}`);
  return lines.join('\n');
}

// ── Commands ──
const needs = (positional, count, text) => {
  if (positional.length < count) throw usage(`Usage: ${text}`);
};

async function ossLs({ relay, flags, positional, out }) {
  if (positional.length > 1) throw usage('Usage: tcli oss ls [prefix] [--recursive] [--all] [--max N]');
  const prefix = positional[0] || '';
  if (flags.max !== undefined && !/^\d+$/.test(flags.max)) throw usage('--max must be a whole number');
  const query = { prefix, max: flags.max, marker: flags.marker };
  if (flags.recursive) query.delimiter = '';
  if (!flags.all) {
    const answer = await callJson(relay, 'GET', '/oss/list', { query });
    out(flags.json ? JSON.stringify(answer, null, 2) : formatList(answer, prefix));
    return EXIT.ok;
  }
  const merged = { objects: [], prefixes: [], next_marker: null, truncated: false };
  let marker = flags.marker;
  for (;;) {
    const answer = await callJson(relay, 'GET', '/oss/list', { query: { ...query, max: flags.max || LIST_PAGE, marker } });
    merged.objects.push(...(answer.objects || []));
    merged.prefixes.push(...(answer.prefixes || []));
    merged.next_marker = answer.next_marker || null;
    merged.truncated = Boolean(answer.truncated);
    if (!answer.truncated || !answer.next_marker || answer.next_marker === marker) break;
    if (merged.objects.length >= LIST_ALL_LIMIT) break;
    marker = answer.next_marker;
  }
  if (merged.objects.length > LIST_ALL_LIMIT) {
    merged.next_marker = merged.objects[LIST_ALL_LIMIT - 1].key;
    merged.objects.length = LIST_ALL_LIMIT;
    merged.truncated = true;
  }
  merged.prefixes = [...new Set(merged.prefixes)];
  out(flags.json ? JSON.stringify(merged, null, 2) : formatList(merged, prefix));
  return EXIT.ok;
}

async function ossStat({ relay, flags, positional, out }) {
  needs(positional, 1, 'tcli oss stat <key>');
  const answer = await callJson(relay, 'GET', '/oss/stat', { query: { key: positional[0] } });
  out(flags.json ? JSON.stringify(answer, null, 2) : formatStat(answer));
  return EXIT.ok;
}

async function ossGet({ relay, flags, positional, out, stdout, stderr, cwd }) {
  needs(positional, 1, 'tcli oss get <key> [-o <file>|-] [--force]');
  const key = positional[0];
  const toStdout = flags.output === '-';
  let file = null;
  if (!toStdout) {
    const name = flags.output || key.split('/').pop();
    if (!name) throw usage('The key ends with "/"; name the file with -o <file>');
    file = path.resolve(cwd, name);
    if (fs.existsSync(file) && !flags.force) throw usage(`${file} exists; add --force to overwrite it`);
  }
  const part = file ? `${file}.tcli-part-${process.pid}` : null;
  const result = await new Promise((resolve, reject) => {
    const req = send(relay, 'GET', '/oss/object', { query: { key }, timeoutMs: META_TIMEOUT_MS, headers: { Accept: '*/*' } });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })));
    req.on('error', error => reject(networkFailure(error)));
    req.on('response', async response => {
      if (response.statusCode !== 200) {
        reject(failureOf(response.statusCode, await readJson(response).catch(() => null)));
        return;
      }
      // The answer started: no time limit from here on, a long download is not cut.
      req.setTimeout(0);
      const expected = response.headers['content-length'] === undefined ? null : Number(response.headers['content-length']);
      const meter = progress(stderr, 'Downloading', expected);
      let bytes = 0;
      const sink = file ? fs.createWriteStream(part, { mode: 0o644 }) : stdout;
      const fail = error => {
        meter.done();
        if (part) fs.rm(part, { force: true }, () => {});
        reject(error instanceof CliError ? error : networkFailure(error));
      };
      response.on('data', chunk => { bytes += chunk.length; meter.add(chunk.length); });
      response.on('aborted', () => fail(new CliError('The download was cut off', EXIT.server, { error: 'INCOMPLETE_DOWNLOAD', message: 'The download was cut off' })));
      response.on('error', fail);
      sink.on('error', fail);
      const finished = () => {
        meter.done();
        if (expected !== null && bytes !== expected) {
          fail(new CliError(`The download ended after ${bytes} of ${expected} bytes`, EXIT.server, { error: 'INCOMPLETE_DOWNLOAD', message: 'The download was cut off' }));
          return;
        }
        try { if (part) fs.renameSync(part, file); } catch (error) { fail(new CliError(`Cannot save ${file}: ${error.message}`, EXIT.usage)); return; }
        resolve({ key, file: file || '-', size: bytes, etag: (response.headers.etag || '').replace(/^"|"$/g, '') || null, content_type: response.headers['content-type'] || null });
      };
      if (file) {
        sink.on('finish', finished);
        response.pipe(sink);
      } else {
        response.on('end', finished);
        response.pipe(sink, { end: false });
      }
    });
    req.end();
  });
  if (toStdout) return EXIT.ok;
  out(flags.json ? JSON.stringify(result, null, 2) : `Saved ${result.file} (${humanSize(result.size)})`);
  return EXIT.ok;
}

async function ossPut({ relay, flags, positional, out, stderr, cwd }) {
  needs(positional, 1, 'tcli oss put <file> [key] [--prefix P] [--content-type T]');
  if (positional.length > 2) throw usage('Usage: tcli oss put <file> [key] [--prefix P] [--content-type T]');
  const file = path.resolve(cwd, positional[0]);
  let stat;
  try { stat = fs.statSync(file); } catch { throw usage(`${file} does not exist`); }
  if (!stat.isFile()) throw usage(`${file} is not a file`);
  let key = positional[1] || path.basename(file);
  if (flags.prefix) key = `${flags.prefix.replace(/\/+$/, '')}/${key}`;
  const contentType = flags['content-type'] || guessType(positional[1] || file);
  const answer = await new Promise((resolve, reject) => {
    const req = send(relay, 'PUT', '/oss/object', {
      query: { key }, headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), Accept: 'application/json' },
    });
    // A server that refuses the upload answers and closes while the body is still being sent: its answer wins over the broken pipe.
    let answered = false;
    req.on('error', error => setTimeout(() => { if (!answered) reject(networkFailure(error)); }, 300));
    req.on('response', async response => {
      answered = true;
      try {
        const body = await readJson(response);
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(body);
        else reject(failureOf(response.statusCode, body));
      } catch (error) { reject(networkFailure(error)); }
    });
    const meter = progress(stderr, 'Uploading', stat.size);
    const source = fs.createReadStream(file);
    source.on('data', chunk => meter.add(chunk.length));
    source.on('end', () => meter.done());
    source.on('error', error => { req.destroy(); reject(new CliError(`Cannot read ${file}: ${error.message}`, EXIT.usage)); });
    source.pipe(req);
  });
  out(flags.json ? JSON.stringify(answer, null, 2) : `Uploaded ${answer.key} (${humanSize(answer.size)})\n${answer.url}`);
  return EXIT.ok;
}

const ossCopy = (route, verb) => async ({ relay, flags, positional, out }) => {
  if (positional.length !== 2) throw usage(`Usage: tcli oss ${route === '/oss/copy' ? 'cp' : 'mv'} <src> <dst>`);
  const answer = await callJson(relay, 'POST', route, { body: { src: positional[0], dst: positional[1] } });
  out(flags.json ? JSON.stringify(answer, null, 2) : `${verb} ${positional[0]} -> ${positional[1]}`);
  return EXIT.ok;
};

async function ossRm({ relay, flags, positional, out }) {
  needs(positional, 1, 'tcli oss rm <key...> --yes');
  if (!flags.yes) throw usage('rm needs --yes (it deletes the objects for good)');
  const answer = await callJson(relay, 'POST', '/oss/remove', { body: { keys: positional, confirm: true } });
  const failed = answer.failed || [];
  if (flags.json) out(JSON.stringify(answer, null, 2));
  else {
    const lines = (answer.deleted || []).map(key => `Removed ${key}`);
    for (const key of failed) lines.push(`Not removed ${key}`);
    out(lines.join('\n'));
  }
  return failed.length ? EXIT.server : EXIT.ok;
}

async function ossUrl({ relay, flags, positional, out, stderr }) {
  needs(positional, 1, 'tcli oss url <key> [--expires S]');
  if (flags.expires !== undefined && !/^\d+$/.test(flags.expires)) throw usage('--expires must be a whole number of seconds');
  const answer = await callJson(relay, 'POST', '/oss/sign', { body: { key: positional[0], ...(flags.expires ? { expires: Number(flags.expires) } : {}) } });
  if (flags.json) out(JSON.stringify(answer, null, 2));
  else {
    out(answer.url);
    stderr.write(`Valid until ${answer.expires_at}\n`);
  }
  return EXIT.ok;
}

// The command table: tcli <group> <command>. A new group adds an entry with its help and commands.
const GROUPS = {
  oss: {
    help: OSS_HELP,
    commands: {
      ls: { run: ossLs, values: ['max', 'marker'], bools: ['all', 'recursive'] },
      stat: { run: ossStat },
      get: { run: ossGet, values: ['output'], bools: ['force'] },
      put: { run: ossPut, values: ['content-type', 'prefix'] },
      cp: { run: ossCopy('/oss/copy', 'Copied') },
      mv: { run: ossCopy('/oss/move', 'Moved') },
      rm: { run: ossRm, bools: ['yes'] },
      url: { run: ossUrl, values: ['expires'] },
    },
  },
};

async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const out = text => stdout.write(`${text}\n`);
  const json = argv.includes('--json');
  const [groupName, commandName, ...rest] = argv;
  try {
    if (!groupName || groupName === '--help' || groupName === '-h') { (groupName ? stdout : stderr).write(HELP); return groupName ? EXIT.ok : EXIT.usage; }
    if (groupName === 'help') { stdout.write(HELP); return EXIT.ok; }
    const group = GROUPS[groupName];
    if (!group) throw usage(`Unknown group "${groupName}"; see tcli help`);
    if (!commandName) { stderr.write(group.help); return EXIT.usage; }
    if (commandName === 'help' || commandName === '--help' || commandName === '-h') { stdout.write(group.help); return EXIT.ok; }
    const command = group.commands[commandName];
    if (!command) throw usage(`Unknown command "${groupName} ${commandName}"; see tcli ${groupName} help`);
    const { flags, positional } = parseArgs(rest, command);
    if (flags.help) { stdout.write(group.help); return EXIT.ok; }
    const relay = relayFromEnv(env);
    return await command.run({ relay, flags, positional, out, stdout, stderr, cwd });
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError(error && error.message ? error.message : String(error), EXIT.server);
    if (json) stderr.write(`${JSON.stringify({ ...(failure.body || { error: failure.exit === EXIT.usage ? 'USAGE' : 'ERROR', message: failure.message }), exit: failure.exit })}\n`);
    else stderr.write(`tcli: ${failure.message}\n`);
    return failure.exit;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { main, parseArgs, relayFromEnv, formatList, formatStat, humanSize, GROUPS, EXIT };

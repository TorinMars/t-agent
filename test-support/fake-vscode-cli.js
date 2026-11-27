#!/usr/bin/env node
// A fake `code` CLI for the tests of "Open in VS Code" (services/vscode-web.js, routes/vscode-web-engine.js). No test ever runs the real VS Code
// CLI, downloads anything or opens the network: the tests write a `code` shim into a temp folder that runs this file (writeCodeShim below).
//
// `code serve-web --help` prints the flags of a recent CLI. `code serve-web ...` listens on `--socket-path` (or `--host` / `--port`, printing the
// address like the real CLI), checks the `vscode-tkn` cookie against `--connection-token-file` and serves, under `--server-base-path`:
//   <base>/             HTML, with a Set-Cookie and a Service-Worker-Allowed header (the engine must strip both)
//   <base>/static/a.txt a static file with Range support
//   <base>/headers      the request headers it got, as JSON (cookies by name only)
//   <base>/echo         POST: the body it got and its length, as JSON
//   <base>/redirect     302 to <base>/?tkn=<token>&x=1 (the engine must take the token out of Location)
//   <base>/ws           a WebSocket echo
//   ?tkn=<token>        on any path: sets the cookie and redirects without it, like the real CLI
// Environment switches:
//   FAKE_VSCODE_OLD=1            --help lacks --server-base-path (an old CLI)
//   FAKE_VSCODE_NO_SOCKET=1      --help lacks --socket-path (the engine falls back to --host / --port)
//   FAKE_VSCODE_NO_SERVE_WEB=1   `serve-web` is an unknown command (exit 1)
//   FAKE_VSCODE_DELAY_MS=<ms>    wait before listening (a slow first start)
//   FAKE_VSCODE_NOT_READY_MS=<ms> answer 503 to <base>/ for this long after listening
//   FAKE_VSCODE_EXIT=1           print an error (with the token in it) and exit 1
//   FAKE_VSCODE_EXIT_AFTER_MS=<ms> exit 3 that long after listening (a crash while running)
//   FAKE_VSCODE_LEAK_TOKEN=1     print the token on stderr at start (the engine must redact it)
//   FAKE_VSCODE_IGNORE_TERM=1    ignore SIGTERM (the engine must escalate to SIGKILL)
//   FAKE_VSCODE_PID_FILE=<file>  write the pid there
//   FAKE_VSCODE_ARGS_FILE=<file> write the arguments there, as JSON
const fs = require('fs');
const http = require('http');
const path = require('path');

// Writes an executable `code` into `dir` that runs this fake with the node of the test, and returns its path.
function writeCodeShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'code');
  const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

if (require.main === module) run();
else module.exports = { writeCodeShim };

function run() {
  const argv = process.argv.slice(2);
  const env = process.env;

  const HELP = [
    'Runs a local web version of Visual Studio Code',
    '',
    'Usage: code serve-web [OPTIONS]',
    '',
    'Options:',
    '      --host <HOST>                   Host to listen on, defaults to \'localhost\'',
    env.FAKE_VSCODE_NO_SOCKET ? null : '      --socket-path <SOCKET_PATH>',
    '      --port <PORT>                   Port to listen on. If 0 is passed a random free port is picked [default: 8000]',
    '      --connection-token <CONNECTION_TOKEN>',
    '      --connection-token-file <CONNECTION_TOKEN_FILE>',
    '      --without-connection-token',
    '      --accept-server-license-terms',
    env.FAKE_VSCODE_OLD ? null : '      --server-base-path <SERVER_BASE_PATH>',
    '      --server-data-dir <SERVER_DATA_DIR>',
    '      --cli-data-dir <CLI_DATA_DIR>',
    '      --disable-telemetry',
    '  -h, --help                          Print help',
  ].filter(line => line !== null).join('\n');

  if (argv[0] !== 'serve-web' || env.FAKE_VSCODE_NO_SERVE_WEB) {
    process.stderr.write(`error: unrecognized subcommand '${argv[0] || ''}'\n`);
    process.exit(1);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  const flag = name => {
    const at = argv.indexOf(name);
    return at < 0 ? null : argv[at + 1];
  };
  if (env.FAKE_VSCODE_ARGS_FILE) fs.writeFileSync(env.FAKE_VSCODE_ARGS_FILE, JSON.stringify(argv));
  if (env.FAKE_VSCODE_PID_FILE) fs.writeFileSync(env.FAKE_VSCODE_PID_FILE, String(process.pid));
  if (env.FAKE_VSCODE_IGNORE_TERM) process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => process.exit(0));

  const tokenFile = flag('--connection-token-file');
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  const base = flag('--server-base-path') || '';
  if (!argv.includes('--accept-server-license-terms')) {
    process.stderr.write('The license terms must be accepted\n');
    process.exit(2);
  }
  if (env.FAKE_VSCODE_LEAK_TOKEN) process.stderr.write(`starting with token ${token} and url http://localhost/?tkn=${token}\n`);
  if (env.FAKE_VSCODE_EXIT) {
    process.stderr.write(`error: could not start the server (token ${token})\n`);
    process.exit(1);
  }

  let listeningAt = 0;
  const cookieOk = req => String(req.headers.cookie || '').split(';').map(part => part.trim()).includes(`vscode-tkn=${token}`);

  function handle(req, res) {
    const url = new URL(req.url, 'http://fake.local');
    if (url.searchParams.get('tkn') === token) {
      url.searchParams.delete('tkn');
      res.writeHead(302, { 'Set-Cookie': `vscode-tkn=${token}; Path=/; HttpOnly`, Location: `${url.pathname}${url.search}` });
      return res.end();
    }
    if (!cookieOk(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Forbidden'); }
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) { res.writeHead(404); return res.end('Not found'); }
    const rest = url.pathname.slice(base.length) || '/';
    if (rest === '/') {
      if (Date.now() - listeningAt < Number(env.FAKE_VSCODE_NOT_READY_MS || 0)) { res.writeHead(503); return res.end('starting'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `vscode-tkn=${token}; Path=/`, 'Service-Worker-Allowed': '/' });
      return res.end(`<!doctype html><title>Fake VS Code</title><p>folder=${url.searchParams.get('folder') || ''}</p>`);
    }
    if (rest === '/static/a.txt') {
      const body = Buffer.from('0123456789abcdefghij');
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      const headers = { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes', ETag: '"fake-etag"' };
      if (range) {
        const part = body.subarray(Number(range[1]), Number(range[2]) + 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range[1]}-${range[2]}/${body.length}`, 'Content-Length': part.length });
        return res.end(req.method === 'HEAD' ? undefined : part);
      }
      res.writeHead(200, { ...headers, 'Content-Length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (rest === '/headers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // The cookie by name only, so that no test answer carries the token.
      const cookieNames = String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')[0]).filter(Boolean);
      return res.end(JSON.stringify({ ...req.headers, cookie: undefined, cookie_names: cookieNames, token_ok: cookieOk(req) }));
    }
    if (rest === '/echo' && req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ length: body.length, text: body.length < 1024 ? body.toString('utf8') : '', type: req.headers['content-type'] || '' }));
      });
      return undefined;
    }
    if (rest === '/redirect') {
      res.writeHead(302, { Location: `http://localhost${base}/?tkn=${token}&x=1` });
      return res.end();
    }
    res.writeHead(404);
    return res.end('Not found');
  }

  const server = http.createServer(handle);
  let WebSocketServer = null;
  try { ({ WebSocketServer } = require('ws')); } catch { /* no WebSocket echo without ws */ }
  if (WebSocketServer) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://fake.local');
      if (!cookieOk(req) || url.pathname !== `${base}/ws`) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      return wss.handleUpgrade(req, socket, head, ws => {
        ws.send(JSON.stringify({ hello: true, origin: req.headers.origin || '', forwarded_host: req.headers['x-forwarded-host'] || '' }));
        ws.on('message', (data, binary) => ws.send(data, { binary }));
      });
    });
  }

  const start = () => {
    const listening = () => {
      listeningAt = Date.now();
      const address = server.address();
      if (typeof address === 'object' && address) process.stdout.write(`Web UI available at http://127.0.0.1:${address.port}${base}/?tkn=${token}\n`);
      if (env.FAKE_VSCODE_EXIT_AFTER_MS) setTimeout(() => process.exit(3), Number(env.FAKE_VSCODE_EXIT_AFTER_MS));
    };
    const socketPath = flag('--socket-path');
    if (socketPath) {
      try { fs.rmSync(socketPath, { force: true }); } catch { /* not there */ }
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      server.listen(socketPath, listening);
    } else {
      server.listen(Number(flag('--port') || 0), flag('--host') || '127.0.0.1', listening);
    }
  };
  setTimeout(start, Number(env.FAKE_VSCODE_DELAY_MS || 0));
}

#!/usr/bin/env node
// Claude Code SessionStart hook for t-agent terminals (see "Claude terminals follow their current session" in DESIGN.md).
// Claude starts it on startup, resume, /clear, compact and fork with { session_id, source, cwd, ... } on stdin.
// It tells the t-agent server which session the terminal now runs, so a respawned shell resumes that one.
// It must never disturb Claude: it prints nothing (SessionStart stdout would become context), gives up after
// a short time, and always exits 0. The token comes from the environment, never from the command line.
const http = require('http');

const url = process.env.TA_HOOK_URL;
const token = process.env.TA_HOOK_TOKEN;
const done = () => process.exit(0);
setTimeout(done, 2000);
process.on('uncaughtException', done);

if (!url || !token) done();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 256 * 1024) done();
});
process.stdin.on('error', done);
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(input); } catch { done(); return; }
  const body = JSON.stringify({ session_id: event.session_id, source: event.source, cwd: event.cwd });
  let target;
  try { target = new URL(`${url}&event=session`); } catch { done(); return; }
  if (target.protocol !== 'http:') { done(); return; }
  const req = http.request(target, {
    method: 'POST',
    timeout: 1500,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-TA-Token': token },
  }, res => { res.resume(); res.on('end', done); res.on('error', done); });
  req.on('timeout', () => { req.destroy(); done(); });
  req.on('error', done);
  req.end(body);
});

#!/usr/bin/env node
// T-Attention listener for Claude Code: one task per Claude session (external_ref 'claude:<session_id>').
// Claude Code runs this as a command hook with the hook JSON on stdin (hook_event_name, session_id, cwd, ...).
// It must never block or break Claude: it prints nothing, gives up after about 2 s, always exits 0, writes errors to
// <data folder>/listeners/claude.log, and does nothing without a config (lib/attention-client.js resolveConfig).
// Mapping: see "T-Attention: CLI and Claude listener" in DESIGN.md and plugins/README.md.
// <data folder>/listeners/claude-state/<session>.json remembers the last status this hook set for a session, so the
// tool hooks (PostToolUse, PostToolUseFailure: they run on every tool call) only make a request after a prompt
// left the task waiting_user, and otherwise return without touching the network.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUDGET_MS = Number(process.env.TA_ATTENTION_HOOK_TIMEOUT_MS) > 0 ? Number(process.env.TA_ATTENTION_HOOK_TIMEOUT_MS) : 2000;
// Tool events carry the tool output, which can be large; past this the event is skipped without a log line.
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_LOG = 256 * 1024;
const TITLE_MAX = 80;
const STATE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
const REASON_MAX = 500;
// Notification types that mean Claude waits for the user (Claude Code 2.1.x). idle_prompt is left out on purpose:
// it fires after a finished turn has waited, and the task is already in review then.
const WAITING_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt']);

const exit = () => process.exit(0);
const hardStop = setTimeout(exit, BUDGET_MS + 500);
process.on('uncaughtException', error => { log(`uncaught: ${error && error.message}`); exit(); });
process.on('unhandledRejection', error => { log(`unhandled: ${error && error.message}`); exit(); });

let client = null;
try { client = require('../../../lib/attention-client'); } catch { exit(); }

function log(message) {
  try {
    if (!client) return;
    const dir = path.join(client.dataHome(), 'listeners');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'claude.log');
    try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch { /* logging must never fail the hook */ }
}

function stateDir() {
  return path.join(client.dataHome(), 'listeners', 'claude-state');
}

function stateFile(sessionId) {
  const id = String(sessionId);
  const name = /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.startsWith('.') ? id : crypto.createHash('sha256').update(id).digest('hex');
  return path.join(stateDir(), `${name}.json`);
}

function readState(sessionId) {
  try { return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8')); } catch { return null; }
}

function writeState(sessionId, status) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const file = stateFile(sessionId);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ status, at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(temp, file);
    pruneStates();
  } catch (error) {
    log(`state ${sessionId}: ${error && error.message}`);
  }
}

function dropState(sessionId) {
  try { fs.unlinkSync(stateFile(sessionId)); } catch { /* already gone */ }
}

// Sessions that ended without SessionEnd (a crash, a closed terminal) leave a file behind; drop those older than 2 days.
function pruneStates(now = Date.now()) {
  let names;
  try { names = fs.readdirSync(stateDir()); } catch { return; }
  for (const name of names) {
    const file = path.join(stateDir(), name);
    try { if (now - fs.statSync(file).mtimeMs > STATE_MAX_AGE_MS) fs.unlinkSync(file); } catch { /* raced with another hook */ }
  }
}

function clip(text, max) {
  const chars = Array.from(String(text || ''));
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : chars.join('');
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function fallbackTitle(event) {
  const folder = event.cwd ? path.basename(String(event.cwd)) : '';
  return folder ? `Claude session in ${folder}` : 'Claude session';
}

// The first prompt names the task; prompts that are only a slash command or empty use the fallback.
function titleFrom(event) {
  const prompt = oneLine(event.prompt);
  return prompt ? clip(prompt, TITLE_MAX) : fallbackTitle(event);
}

function meta(event) {
  const out = { host: os.hostname() };
  if (event.cwd) out.cwd = String(event.cwd);
  return out;
}

// Returns {kind: 'upsert', body, title} | {kind: 'session-end'} | null for an event that changes nothing.
function plan(event) {
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
      return { kind: 'upsert', body: { status: 'working', attention_reason: null, meta: meta(event) }, title: titleFrom(event) };
    case 'Notification': {
      const type = event.notification_type;
      if (type && !WAITING_TYPES.has(type)) return null;
      const reason = clip(String(event.message || event.title || 'Claude is waiting for you').trim(), REASON_MAX);
      return { kind: 'upsert', body: { status: 'waiting_user', attention_reason: reason }, title: fallbackTitle(event) };
    }
    case 'Stop': {
      const last = String(event.last_assistant_message || '').trim();
      return { kind: 'upsert', body: { status: 'review', attention_reason: last ? clip(last, REASON_MAX) : null }, title: fallbackTitle(event) };
    }
    case 'StopFailure': {
      const details = oneLine(event.error_details);
      const reason = `API error: ${event.error || 'unknown'}${details ? ` (${details})` : ''}`;
      return { kind: 'upsert', body: { status: 'failed', attention_reason: clip(reason, REASON_MAX) }, title: fallbackTitle(event) };
    }
    case 'SessionEnd':
      return { kind: 'session-end' };
    case 'PostToolUse':
    case 'PostToolUseFailure':
      // Claude goes on after the user answered: back to working. Only reached when the state says waiting_user.
      return { kind: 'resume', body: { status: 'working', attention_reason: null } };
    default:
      return null;
  }
}

async function handle(event, api, deadline) {
  const step = plan(event);
  if (!step) return;
  const ref = `claude:${event.session_id}`;
  const opts = { deadline };
  if (step.kind === 'session-end') {
    dropState(event.session_id);
    // Only a session that still looks busy goes to review; review, done, failed and cancelled stay as they are.
    const found = await api.getByRef(ref, opts);
    const item = found && found.item;
    if (item && (item.status === 'working' || item.status === 'waiting_user')) await api.update(item.id, { status: 'review', source: 'claude' }, opts);
    return;
  }
  const body = { ...step.body, source: 'claude' };
  if (step.kind === 'resume') {
    try {
      await api.upsertByRef(ref, body, opts);
    } catch (error) {
      // The task is gone (400: it cannot be created without a title): forget the session instead of creating it.
      if (error && error.kind === 'invalid' && error.status === 400) { dropState(event.session_id); return; }
      throw error;
    }
    writeState(event.session_id, body.status);
    return;
  }
  // The title is sent only when the task is created: an update without a title keeps the one the user may have edited.
  const existing = await api.getByRef(ref, opts);
  try {
    await api.upsertByRef(ref, existing ? body : { ...body, title: step.title }, opts);
  } catch (error) {
    // Deleted between the lookup and the update (400: no title for a create): send it again with one.
    if (existing && error && error.kind === 'invalid' && error.status === 400) await api.upsertByRef(ref, { ...body, title: step.title }, opts);
    else throw error;
  }
  writeState(event.session_id, body.status);
}

function main() {
  if (process.env.TA_ATTENTION_LISTENER === '0') exit();
  const config = client.resolveConfig();
  if (!config.url || !config.token) exit();
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.length > MAX_INPUT) exit();
  });
  process.stdin.on('error', exit);
  process.stdin.on('end', async () => {
    let event;
    try { event = JSON.parse(input); } catch { log('hook input is not JSON; ignored'); exit(); return; }
    if (!event || typeof event !== 'object' || !event.session_id || !event.hook_event_name) { exit(); return; }
    if (TOOL_EVENTS.has(event.hook_event_name)) {
      const state = readState(event.session_id);
      if (!state || state.status !== 'waiting_user') { exit(); return; }
    }
    const deadline = Date.now() + BUDGET_MS;
    try {
      const api = client.createClient({ url: config.url, token: config.token, timeoutMs: BUDGET_MS });
      await handle(event, api, deadline);
    } catch (error) {
      log(`${event.hook_event_name} ${event.session_id}: ${error && error.kind ? `${error.kind} ` : ''}${error && error.message}`);
    }
    clearTimeout(hardStop);
    exit();
  });
}

if (require.main === module) main();

module.exports = { plan, titleFrom, pruneStates, WAITING_TYPES };

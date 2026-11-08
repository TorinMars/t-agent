#!/usr/bin/env node
// T-Attention listener for Claude Code: one task per Claude session (external_ref 'claude:<session_id>').
// Claude Code runs this as a command hook with the hook JSON on stdin (hook_event_name, session_id, cwd, ...).
// It must never block or break Claude: it prints nothing, gives up after about 2 s, always exits 0, writes errors to
// <data folder>/listeners/claude.log, and does nothing without a config (lib/attention-client.js resolveConfig).
// Besides the status it fills the task's `context` (goal, latest prompt, last reply, what is pending, changed files,
// branch, resume command), sends one `activity` per event for the timeline, and on a transition to waiting_user or
// review an `excerpt` (the last ~8 KiB of readable transcript text; the server never stores it).
// <data folder>/listeners/claude-state/<session>.json remembers the last status this hook set, the turn count and the
// tool of a pending permission dialog, so the tool hooks (PostToolUse, PostToolUseFailure: every tool call) only
// make a request after a prompt left the task waiting_user, and PermissionRequest never makes one.
// Mapping: see "T-Attention: CLI and Claude listener" in DESIGN.md and plugins/README.md.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BUDGET_MS = Number(process.env.TA_ATTENTION_HOOK_TIMEOUT_MS) > 0 ? Number(process.env.TA_ATTENTION_HOOK_TIMEOUT_MS) : 2000;
const GIT_TIMEOUT_MS = 1500;
// Tool events carry the tool output, which can be large; past this the event is skipped without a log line.
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_LOG = 256 * 1024;
const TITLE_MAX = 80;
const REASON_MAX = 500;
const TEXT_MAX = 2000;
const PENDING_MAX = 1000;
const ACTIVITY_MAX = 500;
const EXCERPT_BYTES = 8 * 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const FILES_MAX = 50;
const PENDING_TOOL_FRESH_MS = 2 * 60 * 1000;
const STATE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
// Notification types that mean Claude waits for the user (Claude Code 2.1.x). idle_prompt is left out on purpose:
// it fires after a finished turn has waited, and the task is already in review then.
const WAITING_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt']);
const PERMISSION_TYPES = new Set(['permission_prompt', 'worker_permission_prompt']);

const exit = () => process.exit(0);

let client = null;
try { client = require('../../../lib/attention-client'); } catch { client = null; }

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

// ---------- older hook entry ----------
// The current listener entry of rules/claude/settings.json runs `TA_ATTENTION_ENTRY=2 node <hook>` (it also accepts $TA_ATTENTION_HOOK).
// `ta` merges it into ~/.claude/settings.json next to an older entry synced before, and Claude Code then runs both for one event. A run
// without the mark is the older entry: it does nothing when the same event in the user's Claude settings also has the current entry.
function supersededEntry(eventName) {
  if (process.env.TA_ATTENTION_ENTRY === '2') return false;
  try {
    const dir = String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const groups = settings && settings.hooks && Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    return groups.some(group => group && Array.isArray(group.hooks) && group.hooks.some(hook => hook && typeof hook.command === 'string' && hook.command.includes('TA_ATTENTION_ENTRY=2')));
  } catch {
    return false;
  }
}

// ---------- session state ----------
function stateDir() {
  return path.join(client.dataHome(), 'listeners', 'claude-state');
}

function stateFile(sessionId) {
  const id = String(sessionId);
  const name = /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.startsWith('.') ? id : crypto.createHash('sha256').update(id).digest('hex');
  return path.join(stateDir(), `${name}.json`);
}

function readState(sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function writeState(sessionId, patch) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const file = stateFile(sessionId);
    const next = { ...(readState(sessionId) || {}), ...patch, at: new Date().toISOString() };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
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

// ---------- text helpers ----------
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// What a tool is about to do, in one string: the Bash command, else the path or URL, else its input as JSON.
function commandOf(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query']) {
    if (typeof input[key] === 'string' && input[key].trim()) return clip(input[key].trim(), PENDING_MAX);
  }
  try { return clip(JSON.stringify(input), PENDING_MAX); } catch { return ''; }
}

// T-Agent terminals set TA_HOOK_URL=<server>/hooks/terminal-activity?task=<id>&terminal=<id> (routes/terminal.js). Only ids T-Agent can have are
// kept (a task number, a terminal id of routes/terminal.js: letters, digits, '_' and '-', at most 64), so the core never cuts one (64 characters).
const TASK_ID = /^\d{1,15}$/;
const TERMINAL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
function tagentFrom(env = process.env) {
  if (!env.TA_HOOK_URL) return null;
  try {
    const url = new URL(env.TA_HOOK_URL);
    const task = url.searchParams.get('task');
    const terminal = url.searchParams.get('terminal');
    return task && terminal && TASK_ID.test(task) && TERMINAL_ID.test(terminal) ? { task_id: task, terminal_id: terminal } : null;
  } catch {
    return null;
  }
}

// ---------- git (time-boxed) ----------
// The branch comes from .git/HEAD (no process); a worktree's .git file points at its git dir.
function branchOf(cwd) {
  if (!cwd) return '';
  let dir = path.resolve(String(cwd));
  for (let depth = 0; depth < 40; depth += 1) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* not here */ }
    if (stat) {
      try {
        let gitDir = dotGit;
        if (stat.isFile()) {
          const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (!match) return '';
          gitDir = path.resolve(dir, match[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return clip(ref ? ref[1] : head.slice(0, 12), 200);
      } catch {
        return '';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
  return '';
}

// Changed files of the session folder against HEAD: [{path, added, deleted}] or null (not a repo, no git, too slow).
function changedFiles(cwd, timeoutMs = GIT_TIMEOUT_MS) {
  if (!cwd) return Promise.resolve(null);
  return new Promise(resolve => {
    let child;
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    // Our own timer: a child of git that keeps the pipe open would otherwise delay the callback past the timeout.
    const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, Math.max(50, timeoutMs));
    try {
      child = execFile('git', ['-C', String(cwd), 'diff', '--numstat', 'HEAD'], {
        timeout: Math.max(50, timeoutMs), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      }, (error, stdout) => {
        if (error) { finish(null); return; }
        const files = [];
        for (const line of String(stdout).split('\n')) {
          const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
          if (!match) continue;
          files.push({ path: clip(match[3], 300), added: match[1] === '-' ? 0 : Number(match[1]), deleted: match[2] === '-' ? 0 : Number(match[2]) });
          if (files.length >= FILES_MAX) break;
        }
        finish(files);
      });
    } catch {
      finish(null);
      return;
    }
    child.on('error', () => finish(null));
  });
}

// ---------- transcript (tail only) ----------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}

// Reads at most the last 256 KiB of the JSONL transcript and returns {excerpt, lastTool}: the readable user and
// assistant text (newest last, at most 8 KiB, whole lines cut from the start) and the last tool_use {name, input}.
// Tool results, meta lines and command wrappers (<command-name>, <system-reminder>, ...) are skipped.
function readTranscript(file) {
  const out = { excerpt: '', lastTool: null };
  if (!file || !String(file).endsWith('.jsonl')) return out;
  let fd;
  try {
    fd = fs.openSync(String(file), 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let lines = buffer.toString('utf8').split('\n');
    if (length < size) lines = lines.slice(1); // the first line is cut
    const parts = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && bytes < EXCERPT_BYTES; i -= 1) {
      const line = lines[i];
      if (!line || line[0] !== '{') continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || !entry.message) continue;
      const content = entry.message.content;
      if (entry.type === 'assistant' && !out.lastTool && Array.isArray(content)) {
        const tool = [...content].reverse().find(block => block && block.type === 'tool_use' && block.name);
        if (tool) out.lastTool = { name: String(tool.name), input: tool.input };
      }
      const text = textOf(content).replace(/\n{3,}/g, '\n\n').trim();
      if (!text || text.startsWith('<')) continue;
      const piece = `${entry.type === 'user' ? 'User' : 'Claude'}: ${clip(text, TEXT_MAX)}`;
      parts.unshift(piece);
      bytes += Buffer.byteLength(piece) + 2;
    }
    // Each piece is at most 2000 characters (< 8 KiB), so dropping whole pieces from the start is enough.
    while (parts.length > 1 && Buffer.byteLength(parts.join('\n\n')) > EXCERPT_BYTES) parts.shift();
    let excerpt = parts.join('\n\n');
    if (Buffer.byteLength(excerpt) > EXCERPT_BYTES) excerpt = '';
    out.excerpt = excerpt;
  } catch {
    /* unreadable transcript: no excerpt */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return out;
}

// ---------- event mapping ----------
function meta(event) {
  const out = { host: os.hostname() };
  if (event.cwd) out.cwd = String(event.cwd);
  return out;
}

function sessionInfo(event) {
  const resume = event.cwd ? `cd ${shellQuote(event.cwd)} && claude --resume ${event.session_id}` : `claude --resume ${event.session_id}`;
  return { agent: 'claude', id: String(event.session_id), resume };
}

// Returns null for an event that changes nothing, else
// {kind: 'upsert' | 'resume' | 'session-end', body, context, activity, title, transition, files}.
// transition: the task enters waiting_user or review (then the excerpt is sent); files: run git diff.
function plan(event, state = null, now = new Date()) {
  const previous = state && state.status;
  const at = now.toISOString();
  switch (event.hook_event_name) {
    case 'UserPromptSubmit': {
      const prompt = String(event.prompt || '').trim();
      const turns = (Number(state && state.turns) || 0) + 1;
      const context = {
        latest_prompt: clip(prompt, TEXT_MAX), turn_started_at: at, turns, pending: null,
        cwd: event.cwd ? String(event.cwd) : undefined, host: os.hostname(), branch: branchOf(event.cwd) || undefined,
        session: sessionInfo(event), tagent: tagentFrom(),
      };
      if (!state || !state.goal) context.goal = clip(prompt, TEXT_MAX) || undefined;
      if (!state || !state.started_at) context.started_at = at;
      return {
        kind: 'upsert', title: titleFrom(event), transition: false, files: false,
        body: { status: 'working', attention_reason: null, meta: meta(event) }, context,
        activity: { kind: 'prompt', text: clip(oneLine(prompt) || '(empty prompt)', ACTIVITY_MAX) },
        state: { status: 'working', turns, goal: Boolean(prompt) || Boolean(state && state.goal), started_at: (state && state.started_at) || at, pending: null },
      };
    }
    case 'Notification': {
      const type = event.notification_type;
      if (type && !WAITING_TYPES.has(type)) return null;
      const text = clip(String(event.message || event.title || 'Claude is waiting for you').trim(), PENDING_MAX);
      const kind = PERMISSION_TYPES.has(type) ? 'permission' : 'question';
      const pending = { kind, text };
      const known = state && state.pending_tool;
      if (kind === 'permission' && known && now - new Date(known.at) < PENDING_TOOL_FRESH_MS) {
        pending.tool = known.tool;
        if (known.command) pending.command = known.command;
      }
      return {
        kind: 'upsert', title: fallbackTitle(event), transition: previous !== 'waiting_user', files: previous !== 'waiting_user',
        body: { status: 'waiting_user', attention_reason: clip(text, REASON_MAX) },
        context: { pending, branch: branchOf(event.cwd) || undefined },
        activity: { kind, text: clip(pending.command ? `${text}: ${oneLine(pending.command)}` : text, ACTIVITY_MAX) },
        state: { status: 'waiting_user', pending },
      };
    }
    case 'Stop': {
      const last = String(event.last_assistant_message || '').trim();
      return {
        kind: 'upsert', title: fallbackTitle(event), transition: previous !== 'review', files: true,
        body: { status: 'review', attention_reason: last ? clip(last, REASON_MAX) : null },
        context: { last_reply: clip(last, TEXT_MAX) || undefined, pending: null, branch: branchOf(event.cwd) || undefined },
        activity: { kind: 'turn_end', text: clip(oneLine(last) || 'The turn ended', ACTIVITY_MAX) },
        state: { status: 'review', pending: null, pending_tool: null },
      };
    }
    case 'StopFailure': {
      const details = oneLine(event.error_details);
      const reason = clip(`API error: ${event.error || 'unknown'}${details ? ` (${details})` : ''}`, REASON_MAX);
      const last = String(event.last_assistant_message || '').trim();
      return {
        kind: 'upsert', title: fallbackTitle(event), transition: false, files: true,
        body: { status: 'failed', attention_reason: reason },
        context: { pending: { kind: 'error', text: clip(reason, PENDING_MAX) }, last_reply: clip(last, TEXT_MAX) || undefined, branch: branchOf(event.cwd) || undefined },
        activity: { kind: 'error', text: clip(reason, ACTIVITY_MAX) },
        state: { status: 'failed', pending_tool: null },
      };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      // Claude goes on after the user answered: back to working. Only reached when the state says waiting_user.
      return {
        kind: 'resume', body: { status: 'working', attention_reason: null }, context: { pending: null },
        activity: { kind: 'resumed', text: clip(event.tool_name ? `Claude continued (${event.tool_name})` : 'Claude continued', ACTIVITY_MAX) },
        state: { status: 'working', pending: null, pending_tool: null },
      };
    case 'SessionEnd':
      return { kind: 'session-end', activity: { kind: 'session_end', text: clip(`Session ended${event.reason ? ` (${event.reason})` : ''}`, ACTIVITY_MAX) } };
    default:
      return null;
  }
}

function dropUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

// Adds the excerpt and, for a permission without a known tool, the transcript's last tool_use.
function withTranscript(event, body) {
  const { excerpt, lastTool } = readTranscript(event.transcript_path);
  if (excerpt) body.excerpt = excerpt;
  const pending = body.context && body.context.pending;
  if (pending && pending.kind === 'permission' && !pending.tool && lastTool) {
    pending.tool = clip(lastTool.name, 200);
    const command = commandOf(lastTool.input);
    if (command) pending.command = command;
  }
}

async function handle(event, api, deadline, state) {
  const step = plan(event, state);
  if (!step) return;
  const ref = `claude:${event.session_id}`;
  const opts = { deadline };
  const gitBudget = () => Math.min(GIT_TIMEOUT_MS, Math.max(50, deadline - Date.now() - 300));

  if (step.kind === 'session-end') {
    dropState(event.session_id);
    const found = await api.getByRef(ref, opts);
    const item = found && found.item;
    if (!item) return;
    // Only a session that still looks busy goes to review; review, done, failed and cancelled stay as they are.
    if (item.status === 'working' || item.status === 'waiting_user') {
      const files = await changedFiles(event.cwd, gitBudget());
      const body = { status: 'review', source: 'claude', activity: step.activity, context: dropUndefined({ pending: null, files: files || undefined }) };
      withTranscript(event, body);
      await api.update(item.id, body, opts);
    } else {
      await api.update(item.id, { source: 'claude', activity: step.activity }, opts);
    }
    return;
  }

  const body = { ...step.body, source: 'claude', activity: step.activity, context: dropUndefined(step.context) };
  if (step.kind === 'resume') {
    try {
      await api.upsertByRef(ref, body, opts);
    } catch (error) {
      // The task is gone (400: it cannot be created without a title): forget the session instead of creating it.
      if (error && error.kind === 'invalid' && error.status === 400) { dropState(event.session_id); return; }
      throw error;
    }
    writeState(event.session_id, step.state);
    return;
  }

  // The lookup and git run side by side; the title (and the session identity) are sent only when the task is created.
  const [existing, files] = await Promise.all([
    api.getByRef(ref, opts),
    step.files ? changedFiles(event.cwd, gitBudget()) : Promise.resolve(null),
  ]);
  if (files) body.context.files = files;
  if (step.transition) withTranscript(event, body);
  const createBody = () => {
    const context = { ...body.context };
    if (!context.session) context.session = sessionInfo(event);
    if (!context.started_at) context.started_at = new Date().toISOString();
    if (!context.cwd && event.cwd) context.cwd = String(event.cwd);
    if (!context.host) context.host = os.hostname();
    if (context.tagent === undefined) context.tagent = tagentFrom();
    return { ...body, meta: body.meta || meta(event), context, title: step.title };
  };
  try {
    await api.upsertByRef(ref, existing ? body : createBody(), opts);
  } catch (error) {
    // Deleted between the lookup and the update (400: no title for a create): send it again with one.
    if (existing && error && error.kind === 'invalid' && error.status === 400) await api.upsertByRef(ref, createBody(), opts);
    else throw error;
  }
  writeState(event.session_id, { ...step.state, started_at: (state && state.started_at) || step.state.started_at || new Date().toISOString() });
}

function main() {
  const hardStop = setTimeout(exit, BUDGET_MS + 500);
  process.on('uncaughtException', error => { log(`uncaught: ${error && error.message}`); exit(); });
  process.on('unhandledRejection', error => { log(`unhandled: ${error && error.message}`); exit(); });
  if (!client) exit();
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
    if (supersededEntry(event.hook_event_name)) { exit(); return; }
    const state = readState(event.session_id);
    if (TOOL_EVENTS.has(event.hook_event_name) && (!state || state.status !== 'waiting_user')) { exit(); return; }
    if (event.hook_event_name === 'PermissionRequest') {
      // Runs before the dialog shows, so it only remembers the tool for the permission Notification; no request.
      writeState(event.session_id, { pending_tool: { tool: clip(String(event.tool_name || ''), 200), command: commandOf(event.tool_input), at: new Date().toISOString() } });
      exit();
      return;
    }
    const deadline = Date.now() + BUDGET_MS;
    try {
      const api = client.createClient({ url: config.url, token: config.token, timeoutMs: BUDGET_MS });
      await handle(event, api, deadline, state);
    } catch (error) {
      log(`${event.hook_event_name} ${event.session_id}: ${error && error.kind ? `${error.kind} ` : ''}${error && error.message}`);
    }
    clearTimeout(hardStop);
    exit();
  });
}

if (require.main === module) main();

module.exports = { supersededEntry, plan, titleFrom, readTranscript, tagentFrom, branchOf, changedFiles, commandOf, WAITING_TYPES };

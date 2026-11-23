const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { TerminalSnapshot, createHistoryArchive } = require('../lib/terminal-snapshot');
const { RESET_INPUT_MODES, watchShellReturn } = require('../lib/terminal-input-modes');
const { createActivityTracker, foregroundCommand, isShellForeground, baseName } = require('../lib/terminal-activity');
const { noteTerminalInput } = require('../lib/terminal-recent-input');
const { createActivityStream } = require('../lib/terminal-activity-stream');
const { repairSpawnHelperPermissions } = require('../lib/node-pty-runtime');
const { utf8LocaleEnv } = require('../lib/terminal-locale');
const { clipboardShimEnv } = require('../lib/clipboard-shims');
const { listSessions, startupCommand, newClaudeCommand, runningSubagents, SESSION_ID } = require('../lib/agent-sessions');
const { resolveTerminalUser, userCanEnter, terminalEnvFor } = require('../lib/terminal-user');
const { processCwd, cwdInRoot } = require('../lib/terminal-cwd');
const { peerFsSettings } = require('../services/peer-fs-settings');
const { createPresence } = require('../lib/terminal-presence');
const { reap, reapSync } = require('../services/terminal-reaper');
const { sharedClock } = require('../lib/terminal-poll');
const { createAgentRenamer } = require('../lib/agent-rename');
const { createTurnEndWatch } = require('../lib/agent-turn-end');
const notebookFormat = require('../lib/notebook-format');

// Shell notebooks (docs/design/shell-notebook.md): a task_terminals row with agent 'notebook' is a notebook, not a terminal. Its shell (the kernel) is
// run by services/notebook-kernels.js, which registers itself here when it is first used; the feeds below then include running cells. Nothing in
// this file binds an agent session, types a command or opens a WebSocket shell for such a row.
let notebookKernels = null;
function setNotebookKernels(service) { notebookKernels = service || null; }
const kernels = () => notebookKernels || require('../services/notebook-kernels').getNotebookKernels();
function isNotebookRow(taskId, id) {
  if (id === 'default') return false;
  const row = prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(Number(taskId), id);
  return Boolean(row && row.agent === 'notebook');
}

// The home whose agent files list an agent's sessions: OpenCode's database is in the home of the user the shells run as (a root service drops to
// TERMINAL_USER, whose opencode writes it); Claude and Codex are read from the service's home (undefined: os.homedir()).
function sessionHome(agent) {
  if (agent !== 'opencode') return undefined;
  const dropped = resolveTerminalUser().user;
  return dropped ? dropped.home : undefined;
}

// The statements of the hot paths (the terminal list, the activity helpers, the desktop window's lookups, the socket's access check) are
// prepared once, at their first use, and reused: db.prepare compiles the SQL again on every call. Cold paths keep their inline db.prepare.
const statements = new Map();
function prepared(sql) {
  let statement = statements.get(sql);
  if (!statement) statements.set(sql, statement = db.prepare(sql));
  return statement;
}

// Who hears that a Claude or Codex turn ended in a terminal (server.js: the plan usage bars, services/agent-usage.js `turnEnded`).
let agentTurnEndListener = null;
function onAgentTurnEnd(listener) { agentTurnEndListener = typeof listener === 'function' ? listener : null; }
// The agent a terminal runs: its row's agent, else claude or codex when one of them holds the foreground (started by hand in a plain shell).
function terminalAgent(s) {
  const row = s.terminalId === 'default' ? null : prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(s.taskId, s.terminalId);
  if (row && row.agent) return row.agent;
  const names = foregroundCommand(s.pty);
  return names.includes('claude') ? 'claude' : names.includes('codex') ? 'codex' : null;
}

// The agents (claude, codex, ...) of the terminals whose activity is 'running' now, for the plan usage bars (services/agent-usage.js).
function runningAgents() {
  const agents = new Set();
  for (const s of sessions.values()) {
    if (s.exiting || !s.activity || s.activity.state() !== 'running') continue;
    try { const agent = terminalAgent(s); if (agent) agents.add(agent); } catch { /* the next tick asks again */ }
  }
  return [...agents];
}

// Sessions are keyed by task ID and terminal ID; omitted IDs name the implicit `default` terminal, which only older tasks have (lib/task-default-terminal.js).
const sessions = new Map();
// Shells taken out of `sessions` that wait for the reaper's look at the process table before they are killed (endShells).
const ending = new Set();
// Close codes the browser uses to tell "someone else is using this terminal" from a lost connection.
const TERMINAL_IN_USE_CLOSE = 4009;
const TERMINAL_TAKEN_CLOSE = 4010;

const MAX_BUFFER = 5 * 1024 * 1024;   // 5MB
// Flow control: pause the PTY while this much output is unsent (socket buffer) or unparsed (headless xterm queue).
const FLOW_HIGH = 1024 * 1024;
const FLOW_LOW = 256 * 1024;
const FLOW_POLL_MS = 20;
const AUTH_CACHE_MS = 1000;            // how long a successful access check is trusted
// Which terminals are on screen: the page reports { type: 'presence', foreground } per socket (lib/terminal-presence.js); the
// T-Attention notifiers send nothing for a session that is in the foreground (services/attention-notify.js, wired in server.js).
const presence = createPresence();

// Agent hooks (Claude Code / Codex) report activity back through this endpoint.
// The token is an HMAC of task + terminal, so it needs no storage and is only
// ever present in the environment of that terminal's PTY.
const hookSecret = crypto.randomBytes(32);
let hookEndpoint = null;

function setHookEndpoint(url) { hookEndpoint = url; }

function hookToken(taskId, id) {
  return crypto.createHmac('sha256', hookSecret).update(`${Number(taskId)}:${id}`).digest('hex');
}

// Whether `token` is the hook token of this task's terminal (the X-T-Agent-* headers of the peer file relay, routes/peer-fs.js).
function verifyHookToken(taskId, id, token) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof token !== 'string') return false;
  const expected = Buffer.from(hookToken(taskId, id));
  const given = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Claude terminals follow the session Claude really runs (after /clear, /resume, a fork): Claude is started with
// `--settings "$TA_CLAUDE_SETTINGS"`, a JSON string in the PTY environment that adds one SessionStart hook for that
// process only (the person's own Claude settings and hooks are not touched and still apply). The hook
// (scripts/claude-session-hook.js) posts { session_id, source, cwd } to the hook endpoint with event=session.
const SESSION_HOOK_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'claude-session-hook.js');
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
// With peer file access on, the same settings also allow the read-only tools of the `t-agent-peers` MCP server, so reading
// a linked engine's file does not ask each time.
// On a machine that receives the rules and skills sync, the shared Claude settings (<claude>/shared/claude-settings.json, without the keys kept
// local; "Shared Claude settings (injected at session start)" in docs/design/rules-and-skills-sync.md) come first and T-Agent's own parts go on top, so the hook and the
// peer permission are never lost. Shared settings cannot hold hooks or permission rules; `permissions.defaultMode` shares the `permissions` object.
function sharedClaudeSettings() {
  try { return require('../services/rule-sync').sessionClaudeSettings({ db }); } catch (error) {
    console.warn(`[terminal] could not read the shared Claude settings: ${error.message}`);
    return {};
  }
}
// The same settings carry the terminal activity hooks of rules/claude/settings.json (the groups whose every command posts to $TA_HOOK_URL:
// start, stop, the questions with their waiting kind, end), so the state of a T-Agent terminal does not depend on what ~/.claude/settings.json
// holds ("Activity hooks come with the terminal" in docs/design/terminals.md). That file gets them only from scripts/agent-sync.py, which `ta`
// runs and T-Agent's own terminals do not. Claude Code runs the hooks of every settings source; an identical command in the person's file
// runs once, and an older copy there (another command) only reports the same event again.
const RULES_SETTINGS = path.resolve(__dirname, '..', 'rules', 'claude', 'settings.json');
let activityHooks = null;
function claudeActivityHooks() {
  if (activityHooks) return activityHooks;
  const out = {};
  try {
    const rules = JSON.parse(fs.readFileSync(RULES_SETTINGS, 'utf8'));
    for (const [event, groups] of Object.entries((rules && rules.hooks) || {})) {
      const mine = (Array.isArray(groups) ? groups : []).filter(group => group && Array.isArray(group.hooks) && group.hooks.length
        && group.hooks.every(hook => hook && typeof hook.command === 'string' && hook.command.includes('$TA_HOOK_URL')));
      if (mine.length) out[event] = mine;
    }
  } catch (error) {
    console.warn(`[terminal] could not read the activity hooks of rules/claude/settings.json: ${error.message}`);
  }
  activityHooks = out;
  return out;
}
function claudeSettings(peer = false) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(SESSION_HOOK_SCRIPT)} >/dev/null 2>&1 || true`;
  const shared = sharedClaudeSettings();
  const activity = claudeActivityHooks();
  const settings = { ...shared, hooks: { ...activity, SessionStart: [...(activity.SessionStart || []), { hooks: [{ type: 'command', command, timeout: 10 }] }] } };
  if (peer) settings.permissions = { ...(shared.permissions || {}), allow: [`mcp__${PEER_MCP_NAME}`] };
  return JSON.stringify(settings);
}

// Peer file access ("Peer file access" in docs/design/peer-file-access.md, MCP part): when the switch of services/peer-fs-settings.js is on and the hook endpoint
// is known, every Claude and Codex session started here gets the read-only `t-agent-peers` MCP server (scripts/peer-mcp.js), added for
// that process only on its command line (the person's own MCP servers and config files are not touched and still apply). The server
// calls this Engine's relay at TA_PEER_URL with TA_PEER_TASK, TA_PEER_TERMINAL and the terminal's TA_HOOK_TOKEN. The token is only
// ever in the environment: the command lines reference variables, so `ps` shows no secret.
//  - Claude: `--mcp-config "$TA_MCP_CONFIG"` (a JSON string). Claude starts stdio MCP servers with its whole environment, so the
//    TA_* variables reach the server as they are. `--mcp-config` takes several values, so it stays the last option of the line.
//  - Codex: three `-c` overrides. command and args come from TA_PEER_MCP_COMMAND / TA_PEER_MCP_ARGS (TOML values, so paths need no
//    quoting in the typed line); Codex starts MCP servers with a filtered environment, so `env_vars` names the variables it passes on.
const PEER_MCP_NAME = 't-agent-peers';
const PEER_MCP_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'peer-mcp.js');
const PEER_FORWARDED_ENV = ['TA_PEER_URL', 'TA_PEER_TASK', 'TA_PEER_TERMINAL', 'TA_HOOK_TOKEN'];
const CLAUDE_PEER_FLAGS = '--mcp-config "$TA_MCP_CONFIG"';
const CODEX_PEER_FLAGS = [
  `-c "mcp_servers.${PEER_MCP_NAME}.command=$TA_PEER_MCP_COMMAND"`,
  `-c "mcp_servers.${PEER_MCP_NAME}.args=$TA_PEER_MCP_ARGS"`,
  `-c 'mcp_servers.${PEER_MCP_NAME}.env_vars=${JSON.stringify(PEER_FORWARDED_ENV)}'`,
].join(' ');
// A TOML basic string (JSON's escapes are TOML's, but TOML also wants DEL and the other control characters escaped).
const tomlString = value => `"${String(value).replace(/[\\"\u0000-\u001f\u007f]/g, ch => (ch === '\\' || ch === '"' ? `\\${ch}` : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`))}"`;

// Whether new sessions get the peer tools: only with a known hook endpoint (the relay is on the same server) and the switch on.
function peerFsOn() {
  if (!hookEndpoint) return false;
  try { return peerFsSettings().enabled(); } catch (error) {
    console.warn(`[terminal] could not read the peer file access switch: ${error.message}`);
    return false;
  }
}

function peerEnv(taskId, id) {
  return {
    TA_PEER_URL: `${hookEndpoint.replace(/^([a-z]+:\/\/[^/]+).*$/i, '$1')}/api/peer-fs`, // the hook endpoint's origin
    TA_PEER_TASK: String(Number(taskId)),
    TA_PEER_TERMINAL: String(id),
    TA_MCP_CONFIG: JSON.stringify({ mcpServers: { [PEER_MCP_NAME]: { type: 'stdio', command: process.execPath, args: [PEER_MCP_SCRIPT] } } }),
    TA_PEER_MCP_COMMAND: tomlString(process.execPath),
    TA_PEER_MCP_ARGS: `[${tomlString(PEER_MCP_SCRIPT)}]`,
  };
}

// OpenCode terminals (docs/design/opencode-terminals.md): opencode is started as `OPENCODE_CONFIG_CONTENT="$TA_OPENCODE_CONFIG" opencode`.
// opencode reads OPENCODE_CONFIG_CONTENT as one more config source on top of the person's own (their config files and plugins still load, and
// T-Agent writes nothing to ~/.config/opencode); TA_OPENCODE_CONFIG (a JSON string in the PTY environment only) loads scripts/opencode-session-plugin.js, which
// reports the session and the activity to the hook endpoint, and with peer file access on it also adds the `t-agent-peers` MCP server (opencode starts
// a local MCP server with its whole environment, so the TA_* variables reach it). A value of OPENCODE_CONFIG_CONTENT that the server itself was started
// with (the person's) is merged in, its plugins first, so the typed prefix does not lose it; one set only in a shell profile cannot be seen here and is
// replaced for that command. A value that is not a JSON object is left out (with a warning).
const OPENCODE_PLUGIN = path.resolve(__dirname, '..', 'scripts', 'opencode-session-plugin.js');
const OPENCODE_PLUGIN_SPEC = `file://${OPENCODE_PLUGIN}`;
const OPENCODE_PREFIX = 'OPENCODE_CONFIG_CONTENT="$TA_OPENCODE_CONFIG"';
function opencodeConfig(peer = false, inherited = process.env.OPENCODE_CONFIG_CONTENT) {
  let own = {};
  if (typeof inherited === 'string' && inherited.trim()) {
    try {
      const parsed = JSON.parse(inherited);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) own = parsed;
      else throw new Error('not a JSON object');
    } catch (error) {
      console.warn(`[terminal] OPENCODE_CONFIG_CONTENT of the server could not be merged into OpenCode terminals: ${error.message}`);
    }
  }
  // A server started from inside a T-Agent OpenCode terminal inherits that terminal's value: its copy of this plugin is not added twice.
  const plugins = (Array.isArray(own.plugin) ? own.plugin : []).filter(spec => spec !== OPENCODE_PLUGIN_SPEC);
  const config = { ...own, plugin: [...plugins, OPENCODE_PLUGIN_SPEC] };
  if (peer) config.mcp = { ...(own.mcp && typeof own.mcp === 'object' ? own.mcp : {}), [PEER_MCP_NAME]: { type: 'local', command: [process.execPath, PEER_MCP_SCRIPT] } };
  return JSON.stringify(config);
}

// The command typed for an agent terminal. Claude gets the session hook when the hook endpoint is known (the same condition that
// puts TA_CLAUDE_SETTINGS into the PTY environment); with `peer` (the same value hookEnv got for this shell) Claude and Codex also
// get the `t-agent-peers` MCP server. OpenCode gets its config prefix (the plugin, and the MCP server inside the same config).
function withSessionHook(agent, command, peer = peerFsOn()) {
  if (!command || !hookEndpoint) return command;
  const on = Boolean(peer);
  if (agent === 'claude') return `${command} --settings "$TA_CLAUDE_SETTINGS"${on ? ` ${CLAUDE_PEER_FLAGS}` : ''}`;
  if (agent === 'codex' && on) return `${command} ${CODEX_PEER_FLAGS}`;
  if (agent === 'opencode') return `${OPENCODE_PREFIX} ${command}`;
  return command;
}

// A Claude terminal the person named (at creation or by a rename: title_custom) starts Claude with that name as the session's display name
// ("Agent terminals" in docs/design/terminals.md): `--name "$TA_SESSION_NAME"`, the name itself only in the PTY environment, so quotes, `$` or backticks in it are
// never parsed by the shell. Claude writes it to the session file as its custom-title (a resume with a new name appends one), so the name shows in
// Claude's prompt box, its /resume picker and the terminal title. It goes right after the base command: --settings and --mcp-config follow
// (--mcp-config takes several values, so it stays last). Codex has no option to name a session at start, so it gets none. OpenCode has none either:
// its T-Agent plugin reads TA_SESSION_NAME and sets the title itself (scripts/opencode-session-plugin.js), so an OpenCode terminal gets the variable
// but nothing on its command line.
const CLAUDE_NAME_FLAG = '--name "$TA_SESSION_NAME"';
const NAMED_AGENTS = new Set(['claude', 'opencode']);
function sessionName(taskId, id) {
  if (id === 'default') return null;
  const row = db.prepare('SELECT agent, title, title_custom FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  return row && NAMED_AGENTS.has(row.agent) && row.title_custom && row.title ? row.title : null;
}
function withSessionName(agent, command, name) {
  return command && name && agent === 'claude' ? `${command} ${CLAUDE_NAME_FLAG}` : command;
}

const HOOK_ENV_KEYS = ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_CLAUDE_SETTINGS', 'TA_OPENCODE_CONFIG', 'TA_ATTENTION_URL', 'TA_ATTENTION_TOKEN', 'TA_ATTENTION_HOOK', 'TA_ATTENTION_CLI',
  'TA_PEER_URL', 'TA_PEER_TASK', 'TA_PEER_TERMINAL', 'TA_MCP_CONFIG', 'TA_PEER_MCP_COMMAND', 'TA_PEER_MCP_ARGS', 'TA_TCLI', 'TA_SESSION_NAME'];
// The server's own environment may already hold these (a server started from inside a t-agent terminal): they belong to
// that outer terminal and are never passed on.
function withoutInheritedHookEnv(env) {
  const next = { ...env };
  for (const key of HOOK_ENV_KEYS) delete next[key];
  return next;
}

// tcli (scripts/tcli.js, "tcli (agent command line)" in docs/design/tcli.md): the agent command line of this install. It reads TA_HOOK_URL and TA_HOOK_TOKEN
// and calls the relay /api/tcli on the hook endpoint's origin, so it is set in every shell that has them.
const TCLI = path.resolve(__dirname, '..', 'scripts', 'tcli.js');

// `inherited`: the shell's environment without the hook variables, whose OPENCODE_CONFIG_CONTENT (the person's) goes into TA_OPENCODE_CONFIG.
function hookEnv(taskId, id, peer = peerFsOn(), inherited = process.env) {
  if (!hookEndpoint) return {};
  return {
    TA_HOOK_URL: `${hookEndpoint}?task=${Number(taskId)}&terminal=${encodeURIComponent(id)}`,
    TA_HOOK_TOKEN: hookToken(taskId, id),
    TA_TCLI: TCLI,
    TA_CLAUDE_SETTINGS: claudeSettings(peer),
    TA_OPENCODE_CONFIG: opencodeConfig(peer, inherited && inherited.OPENCODE_CONFIG_CONTENT),
    ...(peer ? peerEnv(taskId, id) : {}),
  };
}

// T-Attention in T-Agent terminals (B in "T-Attention: easy listener install"): every shell this server starts, where TA_HOOK_URL is set,
// also gets TA_ATTENTION_URL (this Client's loopback address), TA_ATTENTION_TOKEN (a token for this terminal only, held in memory by
// services/attention.js and ended when the shell ends) and TA_ATTENTION_HOOK (this install's Claude listener hook, which the hook command
// in rules/claude/settings.json uses when <data folder>/listeners/claude-hook.path is missing), plus TA_ATTENTION_CLI (this install's
// scripts/t-attention.js, the command the t-attention agent skill runs, see "T-Attention agent skill"). So Claude started in such a terminal reports
// with no setup once ~/.claude/settings.json has the hooks. When the terminal user's attention-client.json points to another server
// (`t-attention pair` / `login` to a central Client), the URL and token are left out, so that choice wins; the hook path is still set.
// Set by server.js when it listens: { url, issue(taskId, terminalId) -> token, revoke(taskId, terminalId) }.
const ATTENTION_HOOK = path.resolve(__dirname, '..', 'plugins', 'listeners', 'claude', 'hook.js');
const ATTENTION_CLI = path.resolve(__dirname, '..', 'scripts', 't-attention.js');
let attentionTerminals = null;
function setAttentionTerminals(provider) { attentionTerminals = provider || null; }

function pairedElsewhere(env) {
  try {
    const client = require('../lib/attention-client');
    const stored = client.readConfigFile(client.configPath({ env, homedir: () => env.HOME || os.homedir() }));
    const url = stored && typeof stored.url === 'string' ? client.normalizeUrl(stored.url) : null;
    return Boolean(url && stored.token && url !== client.normalizeUrl(attentionTerminals.url));
  } catch {
    return false;
  }
}

// The T-Attention variables of a new shell; env is the shell's environment without them (its HOME and data folder variables).
function attentionEnv(taskId, id, env) {
  if (!hookEndpoint || !attentionTerminals) return {};
  const out = { TA_ATTENTION_HOOK: ATTENTION_HOOK, TA_ATTENTION_CLI: ATTENTION_CLI };
  if (pairedElsewhere(env)) return out;
  try {
    out.TA_ATTENTION_TOKEN = attentionTerminals.issue(taskId, id);
    out.TA_ATTENTION_URL = attentionTerminals.url;
  } catch (error) {
    console.warn(`[terminal] could not make a T-Attention token for terminal ${id} of task ${taskId}: ${error.message}`);
  }
  return out;
}

function endAttentionToken(taskId, id) {
  if (!attentionTerminals) return;
  try { attentionTerminals.revoke(taskId, id); } catch { /* the service is gone */ }
}

function realDir(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

// Each terminal keeps the directory it was started in (option A of the start-directory change, schema 8): a change of the task's working
// directory only affects terminals created afterwards. task_terminals.work_dir is set when the terminal is created (NULL on a row that has
// none: it follows the task); the default terminal (only tasks made before tasks stopped getting one have it), which has no row, records its directory in task_default_terminal_dirs the first time its
// shell starts (before that it follows the task). Answers the configured directory (null when neither the terminal nor the task has one).
function terminalWorkDir(task, id) {
  const row = id === 'default'
    ? prepared('SELECT work_dir FROM task_default_terminal_dirs WHERE task_id = ?').get(task.id)
    : prepared('SELECT work_dir FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(task.id, id);
  return (row && row.work_dir) || task.work_dir || null;
}

// event=session: the Claude or OpenCode session the terminal now runs (Claude's SessionStart hook, scripts/opencode-session-plugin.js). Only a Claude
// or OpenCode terminal of this task takes it, only a well-formed id, and only one that the agent started in the directory the terminal's shell starts
// in (its own directory, or the directory its live shell really started in when that one was missing and the shell fell back to the task's).
// Claude's `/clear` (source `clear`) and OpenCode's `/new` (source `new`) do not move the binding: the terminal stays on its original
// conversation, so a new shell resumes that one (a terminal that is not bound yet takes it).
// The id Claude really runs is kept on the live shell (`currentAgentSessionId`) for the per-process facts (the sub-agent count) and is
// dropped with that shell. Every other source (`startup`, `resume`, `compact`, a fork) rebinds as before.
const REPORTING_AGENTS = new Set(['claude', 'opencode']);
const KEEPING_SOURCES = new Set(['clear', 'new']);
function bindReportedSession(taskId, id, report) {
  if (!report || typeof report !== 'object') return 400;
  const sessionId = report.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return 400;
  const row = db.prepare('SELECT t.agent, t.agent_session_id, COALESCE(t.work_dir, k.work_dir) AS work_dir FROM task_terminals t JOIN tasks k ON k.id = t.task_id WHERE t.task_id = ? AND t.terminal_id = ?').get(taskId, id);
  if (!row || !REPORTING_AGENTS.has(row.agent)) return 404;
  if (typeof report.cwd !== 'string' || !path.isAbsolute(report.cwd)) return 400;
  const live = sessions.get(sessionKey(taskId, id));
  const allowed = [row.work_dir || os.homedir(), live && live.startDir].filter(Boolean).map(realDir);
  if (!allowed.includes(realDir(report.cwd))) return 400;
  const rebind = !(KEEPING_SOURCES.has(report.source) && row.agent_session_id) && row.agent_session_id !== sessionId;
  const running = live ? liveAgentSessionId(live, row.agent_session_id) : row.agent_session_id;
  if (live) live.currentAgentSessionId = sessionId;
  if (rebind) db.prepare('UPDATE task_terminals SET agent_session_id = ? WHERE task_id = ? AND terminal_id = ?').run(sessionId, taskId, id);
  if (rebind || running !== sessionId) activityStream.notify(); // the sub-agent count now follows the new session
  if (rebind) sessionNames.delete(Number(taskId)); // the terminal's name now follows the new session
  return 204;
}

// The Claude session a live shell really runs: the one its SessionStart hook reported last (after /clear it differs from the binding),
// else the bound one.
const liveAgentSessionId = (live, bound) => (live && live.currentAgentSessionId) || bound;

/** Handles one hook report; returns an HTTP status code. `body` is the parsed JSON body (event=session only). `options` (event=attention):
 *  { kind: 'select' | 'accept', via: 'tool' } from the hook's query ("Two waiting kinds" in docs/design/terminals.md). */
function reportHook(taskId, requestedTerminalId, token, event, body, options = {}) {
  let id;
  try { id = terminalId(requestedTerminalId); } catch { return 400; }
  const expected = Buffer.from(hookToken(taskId, id));
  const given = Buffer.from(String(token || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 403;
  if (event === 'session') return bindReportedSession(Number(taskId), id, body);
  const session = sessions.get(sessionKey(taskId, id));
  if (!session || !session.activity) return 404;
  const report = event === 'attention' ? { kind: options.kind || null, tool: options.via === 'tool' } : undefined;
  return session.activity.report(event, report) ? 204 : 400;
}

function terminalId(value) {
  const id = value == null ? 'default' : value;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw Object.assign(new Error('INVALID_TERMINAL_ID'), { statusCode: 400 });
  }
  return id;
}

function sessionKey(taskId, id = 'default') { return `${Number(taskId)}:${id}`; }

function defaultRemoved(taskId) {
  return Boolean(prepared('SELECT 1 FROM task_default_terminal_removed WHERE task_id = ?').get(taskId));
}

function assertTerminal(taskId, value) {
  const id = terminalId(value);
  const exists = id === 'default'
    ? !defaultRemoved(taskId)
    : prepared('SELECT 1 FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  if (!exists) {
    throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { statusCode: 404 });
  }
  return id;
}

const MAX_TERMINAL_TITLE = 40;

// Every open page (computer or phone) and other Clients share the same terminals; only one client at a time may be attached to each (see handleWs).
// Terminals whose ids start with "h5-" were phone-only shells from earlier versions: they are no longer listed.

// Agent terminals show the name of their session (unless the person named the terminal: title_custom), read from the agent's own files on every listing so a rename done inside Claude / Codex follows.
// A Codex session only gets an id once it has a first message, so it is bound here: the oldest unbound Codex terminal takes the oldest unclaimed
// session of the terminal's own directory that started after the terminal did. Sessions are read per directory: each terminal keeps the
// directory it was started in (terminalWorkDir), which may differ from the task's current one.
// `names` (a Map, optional) gets terminal id -> session name for every terminal that shows its session's name.
function withAgentSessions(taskId, rows, names) {
  const meta = prepared("SELECT t.terminal_id, t.agent, t.agent_session_id, t.agent_started_at, t.title_custom, COALESCE(t.work_dir, k.work_dir) AS work_dir FROM task_terminals t JOIN tasks k ON k.id = t.task_id WHERE t.task_id = ? AND t.agent IS NOT NULL AND t.agent != 'notebook' ORDER BY t.rowid").all(taskId);
  if (!meta.length) return rows;
  const lists = new Map();
  const sessionsOf = (agent, dir) => {
    const key = `${agent}\0${dir || ''}`;
    if (!lists.has(key)) lists.set(key, listSessions(agent, dir, sessionHome(agent), 200));
    return lists.get(key);
  };
  const claimed = new Set(meta.map(item => item.agent_session_id).filter(Boolean));
  const info = new Map(meta.map(item => [item.terminal_id, item]));
  for (const item of meta) {
    if (item.agent_session_id || item.agent !== 'codex') continue;
    const found = sessionsOf('codex', item.work_dir).filter(row => !claimed.has(row.id) && row.started_at >= item.agent_started_at - 2000).sort((x, y) => x.started_at - y.started_at)[0];
    if (!found) continue;
    claimed.add(found.id);
    item.agent_session_id = found.id;
    db.prepare('UPDATE task_terminals SET agent_session_id = ? WHERE task_id = ? AND terminal_id = ?').run(found.id, taskId, item.terminal_id);
  }
  return rows.map(row => {
    const item = info.get(row.terminal_id);
    if (!item) return row;
    if (item.title_custom) return { ...row, agent: item.agent }; // a name the person gave (at creation or by a rename) wins over the session's name
    // An OpenCode session that still has opencode's default title is no name: the terminal keeps its own ("OpenCode 2").
    const found = item.agent_session_id && sessionsOf(item.agent, item.work_dir).find(entry => entry.id === item.agent_session_id);
    const session = found && !found.untitled ? found : null;
    if (session && names) names.set(row.terminal_id, session.title);
    return { ...row, agent: item.agent, title: session ? session.title : row.title };
  });
}

// The session names of a task's agent terminals as its last terminal listing found them: task id -> { at, names: Map(terminal id -> name) }.
// The desktop window's activity list (liveTerminalActivity, read every 5 s) takes the names from here instead of the agents' session files,
// and asks for a new listing only when they are older than SESSION_NAMES_MS; the page's own listings (every 8 s while its task list is open)
// keep them fresh for free. At most SESSION_NAMES_MAX tasks, the oldest listing dropped first.
const SESSION_NAMES_MS = 15000;
const SESSION_NAMES_MAX = 200;
const sessionNames = new Map();
function rememberSessionNames(taskId, names) {
  const key = Number(taskId);
  sessionNames.delete(key);
  sessionNames.set(key, { at: Date.now(), names });
  if (sessionNames.size > SESSION_NAMES_MAX) sessionNames.delete(sessionNames.keys().next().value);
}

// Each row also has work_dir: the terminal's own directory (terminalWorkDir), so the page can resolve file links against it and show it
// when it is not the task's current one.
// The rows are in the order the person put them in (setTerminalOrder); terminals that order does not name (new ones) come after, oldest first.
function listTerminals(taskId) {
  const stored = prepared('SELECT title FROM task_default_terminal_titles WHERE task_id = ?').get(taskId);
  const task = prepared('SELECT id, work_dir FROM tasks WHERE id = ?').get(taskId) || { id: taskId, work_dir: null };
  const removed = defaultRemoved(taskId);
  const defaultDir = removed ? null : terminalWorkDir(task, 'default');
  const names = new Map();
  const rows = withAgentSessions(taskId, inStoredOrder(taskId, [...(removed ? [] : [{ terminal_id: 'default', title: stored ? stored.title : 'Terminal 1', work_dir: defaultDir }]), ...prepared(
    "SELECT terminal_id, title, work_dir FROM task_terminals WHERE task_id = ? AND substr(terminal_id, 1, 3) != 'h5-' ORDER BY rowid"
  ).all(taskId).map(row => ({ ...row, work_dir: row.work_dir || task.work_dir || null }))]), names);
  rememberSessionNames(taskId, names);
  return withNotebooks(taskId, rows);
}

// Notebook rows carry agent 'notebook' and `notebook`, the path of their file relative to their folder ("Identity and storage" in docs/design/shell-notebook.md).
function withNotebooks(taskId, rows) {
  const notebooks = new Map(prepared("SELECT terminal_id, agent_session_id FROM task_terminals WHERE task_id = ? AND agent = 'notebook'").all(taskId).map(row => [row.terminal_id, row.agent_session_id]));
  if (!notebooks.size) return rows;
  return rows.map(row => (notebooks.has(row.terminal_id) ? { ...row, agent: 'notebook', notebook: notebooks.get(row.terminal_id) } : row));
}

// The order of a task's terminals, as the person dragged them (PUT …/tasks/:id/terminals/order, see "Terminal order" in docs/design/terminals.md). One system_state
// row per task, `terminal_order_v1:<task id>`, holding a JSON list of terminal ids; no schema change. Every device and linked service lists the
// terminals in this order. A write keeps only terminals that exist, a deleted terminal is taken out and a deleted task's row is removed, so the list
// never holds more than the task's terminals.
const MAX_TERMINAL_ORDER = 500;
const MAX_TERMINAL_ID = 128;
const orderKey = taskId => `terminal_order_v1:${Number(taskId)}`;

function storedOrder(taskId) {
  const row = prepared('SELECT value FROM system_state WHERE key = ?').get(orderKey(taskId));
  if (!row) return [];
  try {
    const value = JSON.parse(row.value);
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
  } catch { return []; }
}

function writeOrder(taskId, ids) {
  if (!ids.length) { forgetTerminalOrder(taskId); return; }
  db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(orderKey(taskId), JSON.stringify(ids));
}

function forgetTerminalOrder(taskId) {
  db.prepare('DELETE FROM system_state WHERE key = ?').run(orderKey(taskId));
}

// `rows` (with terminal_id) sorted by the stored order; rows it does not name keep their relative order after the named ones.
function inStoredOrder(taskId, rows) {
  const order = storedOrder(taskId);
  if (!order.length) return rows;
  const rank = new Map();
  order.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  const position = (row, index) => (rank.has(row.terminal_id) ? rank.get(row.terminal_id) : order.length + index);
  return rows.map((row, index) => ({ row, at: position(row, index) })).sort((a, b) => a.at - b.at).map(entry => entry.row);
}

// `value`: terminal ids in the wanted order. Ids that are not terminals of the task are ignored; terminals it leaves out keep their relative order after
// the listed ones. Answers { order }, the whole stored order after the change. 400 INVALID_TERMINAL_ORDER when `value` is not a list of strings (at most
// MAX_TERMINAL_ORDER, each at most MAX_TERMINAL_ID long); 409 TASK_ARCHIVED like a new terminal.
function setTerminalOrder(taskId, value) {
  if (!Array.isArray(value) || value.length > MAX_TERMINAL_ORDER || !value.every(id => typeof id === 'string' && id.length <= MAX_TERMINAL_ID)) {
    throw Object.assign(new Error('INVALID_TERMINAL_ORDER'), { statusCode: 400 });
  }
  assertTaskNotArchived(taskId);
  const current = listedTerminalIds(taskId);
  const present = new Set(current);
  const listed = [...new Set(value)].filter(id => present.has(id));
  const named = new Set(listed);
  const order = [...listed, ...current.filter(id => !named.has(id))];
  writeOrder(taskId, order);
  return { order };
}

// The ids listTerminals answers, in the same order, without reading the agents' session files.
function listedTerminalIds(taskId) {
  const rows = db.prepare("SELECT terminal_id FROM task_terminals WHERE task_id = ? AND substr(terminal_id, 1, 3) != 'h5-' ORDER BY rowid").all(taskId);
  return inStoredOrder(taskId, [...(defaultRemoved(taskId) ? [] : [{ terminal_id: 'default' }]), ...rows]).map(row => row.terminal_id);
}

function dropFromOrder(taskId, id) {
  const order = storedOrder(taskId);
  if (order.includes(id)) writeOrder(taskId, order.filter(item => item !== id));
}

// A terminal created for an agent session types its command once, when its shell is first spawned.
const pendingStartup = new Map();
const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

// A terminal name as the person typed it: control characters and runs of whitespace become one space, the ends are trimmed. Any script is kept.
function cleanTitle(value) {
  const title = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (title.length > MAX_TERMINAL_TITLE) throw Object.assign(new Error('TERMINAL_TITLE_TOO_LONG'), { statusCode: 400 });
  return title;
}

// An archived task is inert until it is restored (services/task-archive.js): no terminal is made for it.
// A task being moved to another engine (services/task-move.js) gets no new terminal either: its terminals were closed for the move.
function assertTaskNotArchived(taskId) {
  const task = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(taskId);
  if (task && task.archived_at) throw Object.assign(new Error('TASK_ARCHIVED'), { statusCode: 409 });
  if (require('../services/task-move').isMoving(taskId)) throw Object.assign(new Error('TASK_MOVING'), { statusCode: 409 });
}

// options.title: an optional name, validated like a rename and kept like one (title_custom); empty keeps the default "Terminal N" / "Claude N".
function createTerminal(taskId, options = {}) {
  assertTaskNotArchived(taskId);
  const id = require('crypto').randomUUID();
  const agent = options && options.agent;
  const named = cleanTitle(options && typeof options.title === 'string' ? options.title : '');
  if (agent === 'notebook') return createNotebook(taskId, id, named, options);
  let sessionId = options && options.session_id ? String(options.session_id) : null;
  let command = startupCommand(agent, sessionId);
  if (command && !sessionId && agent === 'claude') {
    sessionId = crypto.randomUUID();
    command = newClaudeCommand(sessionId);
  }
  const count = listTerminals(taskId).length + 1;
  const title = named || (command ? `${AGENT_LABELS[agent]} ${count}` : `Terminal ${count}`);
  // The agent's options are added when the shell starts (getOrCreateSession), from the same switch reading as its environment.
  if (command) pendingStartup.set(sessionKey(taskId, id), { agent, command });
  // The terminal keeps the task's working directory of this moment, whatever the task's directory becomes later.
  const task = db.prepare('SELECT work_dir FROM tasks WHERE id = ?').get(taskId);
  const workDir = (task && task.work_dir) || null;
  db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id, agent_started_at, title_custom, work_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, id, title, command ? agent : null, sessionId, command ? Date.now() : null, named ? 1 : null, workDir);
  return { terminal_id: id, title, agent: command ? agent : null, work_dir: workDir };
}

// A Shell notebook ("Identity and storage" in docs/design/shell-notebook.md): a row with agent 'notebook', its file path relative to its folder in
// agent_session_id and that folder in work_dir. Without session_id a new notebooks/<slug>.ipynb is made (title "Notebook N" unless named); with one,
// that existing .ipynb file of the folder is opened (titled after the file), and a notebook row of the task that already has it is answered instead
// of a second one, so two shells never write the same file. No folder: 409 TASK_HAS_NO_FOLDER; a path outside it, not .ipynb or missing: 400
// INVALID_NOTEBOOK_PATH. No shell starts here: the kernel starts on the first run.
function createNotebook(taskId, id, named, options) {
  const task = db.prepare('SELECT id, work_dir, md_path FROM tasks WHERE id = ?').get(taskId);
  const folder = notebookFormat.notebookFolder(task, null);
  if (!folder) throw Object.assign(new Error('TASK_HAS_NO_FOLDER'), { statusCode: 409 });
  const requested = options && options.session_id != null ? String(options.session_id) : null;
  let relative;
  if (requested) {
    relative = notebookFormat.resolveNotebookPath(folder, requested).relative;
    const existing = db.prepare("SELECT terminal_id, title, work_dir, agent_session_id FROM task_terminals WHERE task_id = ? AND agent = 'notebook'").all(taskId)
      .find(row => row.agent_session_id === relative && (row.work_dir || folder) === folder);
    if (existing) return { terminal_id: existing.terminal_id, title: existing.title, agent: 'notebook', work_dir: existing.work_dir || folder, notebook: relative, existing: true };
  } else {
    const user = resolveTerminalUser().user;
    const owner = user && process.getuid && process.getuid() === 0 ? { uid: user.uid, gid: user.gid } : null;
    relative = notebookFormat.createNotebookFile(folder, named, { owner }).relative;
  }
  // The file's base name, cut (by whole characters) to the longest terminal title.
  let fromFile = '';
  if (requested) {
    const chars = Array.from(path.basename(relative).replace(/\.ipynb$/i, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim());
    while (chars.join('').length > MAX_TERMINAL_TITLE) chars.pop();
    fromFile = cleanTitle(chars.join(''));
  }
  const title = named || fromFile || `Notebook ${listTerminals(taskId).length + 1}`;
  db.prepare('INSERT INTO task_terminals (task_id, terminal_id, title, agent, agent_session_id, agent_started_at, title_custom, work_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, id, title, 'notebook', relative, Date.now(), named ? 1 : null, folder);
  return { terminal_id: id, title, agent: 'notebook', work_dir: folder, notebook: relative };
}

// A new shell for an agent terminal that was closed or restarted resumes the session it is bound to.
// A Claude session that never got a message has no file to resume, and a Codex session that was never bound starts fresh.
// `workDir` is the directory the new shell starts in (the terminal's own directory), where the agent looks for the session.
// A Claude terminal the person named passes that name again (so a rename done in T-Agent reaches Claude at the next start; the shell's
// TA_SESSION_NAME holds the same sessionName() value).
function reopenCommand(taskId, id, workDir, peer = peerFsOn()) {
  const row = id === 'default' ? null : db.prepare('SELECT agent, agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  if (!row || !row.agent) return null;
  if (!row.agent_session_id) {
    withAgentSessions(taskId, [{ terminal_id: id, title: '' }]); // binds a Codex session that has appeared since
    const bound = db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
    row.agent_session_id = bound && bound.agent_session_id;
  }
  const name = sessionName(taskId, id);
  const typed = command => withSessionHook(row.agent, withSessionName(row.agent, command, name), peer);
  if (!row.agent_session_id) return typed(startupCommand(row.agent));
  const exists = listSessions(row.agent, workDir, sessionHome(row.agent), 200).some(entry => entry.id === row.agent_session_id);
  if (exists) return typed(startupCommand(row.agent, row.agent_session_id));
  return typed(row.agent === 'claude' ? newClaudeCommand(row.agent_session_id) : startupCommand(row.agent));
}

// Sessions of an agent CLI that were run in the task's working directory (newest first). A new terminal starts there, so the list of
// sessions to resume is read from the task's current directory.
// agent 'notebook': the .ipynb files of the task's folder that a new notebook can open (lib/notebook-format.js listNotebookFiles).
function listAgentSessions(task, agent) {
  if (agent === 'notebook') {
    const folder = notebookFormat.notebookFolder(task, null);
    return folder ? notebookFormat.listNotebookFiles(folder) : [];
  }
  return listSessions(agent, task && task.work_dir, sessionHome(agent));
}

// The live current directory of a terminal's shell, for file links (read-only). `task` has work_dir / md_path. Answers
// { cwd, relative }: cwd null when no shell runs (or it cannot be read), relative null when the directory is outside the terminal's root (real
// paths, so a symbolic link out of the root is outside). The root is the terminal's own directory (terminalWorkDir; the task's when it has none).
// The browser then resolves relative paths against that directory, or opens nothing when outside.
async function terminalCwd(task, value) {
  const id = assertTerminal(task.id, value);
  const s = sessions.get(sessionKey(task.id, id));
  const cwd = s && s.pty && !s.startupError ? await processCwd(s.pty.pid) : null;
  if (!cwd) return { cwd: null, relative: null };
  const configured = terminalWorkDir(task, id) || (task.md_path && path.dirname(task.md_path));
  return { cwd, relative: configured && path.isAbsolute(configured) ? cwdInRoot(cwd, configured) : null };
}

function renameTerminal(taskId, value, requestedTitle) {
  const id = assertTerminal(taskId, value);
  const title = cleanTitle(requestedTitle);
  if (!title) throw Object.assign(new Error('TERMINAL_TITLE_REQUIRED'), { statusCode: 400 });
  if (id === 'default') {
    db.prepare(`
      INSERT INTO task_default_terminal_titles (task_id, title) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET title = excluded.title
    `).run(taskId, title);
  } else {
    db.prepare('UPDATE task_terminals SET title = ?, title_custom = 1 WHERE task_id = ? AND terminal_id = ?').run(title, taskId, id);
    const row = db.prepare('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
    // The agent in a running Claude / Codex terminal is renamed too (typed at once, or after a permission question is answered).
    if (row && row.agent && row.agent !== 'notebook') agentRenames.request(sessionKey(taskId, id), row.agent, title);
  }
  return { terminal_id: id, title };
}

// "Rename reaches the agent" in docs/design/terminals.md: the live shell of a terminal as lib/agent-rename.js sees it. The shell object itself
// is the token, so a rename that waits is dropped when the terminal gets another shell (it then starts Claude with --name anyway).
const agentRenames = createAgentRenamer({
  probe(key) {
    const s = sessions.get(key);
    if (!s || !s.pty || s.startupError || s.exiting) return null;
    return {
      token: s,
      state: s.activity ? s.activity.state() : 'idle',
      awaiting: Boolean(s.activity && s.activity.awaitingAnswer()),
      foreground: foregroundCommand(s.pty),
    };
  },
  write(key, token, data) {
    const s = sessions.get(key);
    if (s !== token || s.exiting) return false;
    s.activity?.noteInput();
    s.pty.write(data);
    return true;
  },
  log: message => console.warn(`[terminal] ${message}`),
});

// The history is a list of chunks, so a PTY chunk is an O(1) push. Whole chunks
// are dropped from the front once the total is well above the limit; the exact
// MAX_BUFFER cut is made only when the text is read (snapshot archive). The history lives in memory only; it is never written to the database.
function bufferText(s) {
  if (s.chunks.length !== 1) s.chunks = [s.chunks.join('')];
  if (s.chunks[0].length > MAX_BUFFER) s.chunks[0] = s.chunks[0].slice(s.chunks[0].length - MAX_BUFFER);
  s.size = s.chunks[0].length;
  return s.chunks[0];
}

function appendBuffer(taskId, data) {
  const s = sessions.get(taskId);
  if (!s) return;
  s.chunks.push(data);
  s.size += data.length;
  if (s.size > MAX_BUFFER * 1.25) {
    let drop = 0;
    while (drop < s.chunks.length - 1 && s.size - s.chunks[drop].length >= MAX_BUFFER) s.size -= s.chunks[drop++].length;
    s.chunks.splice(0, drop);
  }
}

// The shell a terminal of this server runs: zsh on macOS, bash or sh where zsh is missing (many Linux servers), so node-pty does not fail on a fixed
// /bin/zsh path. Throws when none of them exists.
function terminalShell() {
  const shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => fs.existsSync(candidate));
  if (!shell) throw new Error('No usable shell found (/bin/zsh, /bin/bash, /bin/sh)');
  return shell;
}

// How a shell of terminal `id` of a task is started: { shell, cwd, runAs, env }. Shared by the terminals (getOrCreateSession) and the kernels of Shell
// notebooks (services/notebook-kernels.js), so both get the same environment: the PATH additions, the terminal user drop of a root service, the clipboard
// shims, a UTF-8 locale, the hook / tcli variables and a T-Attention token for this task and terminal (attentionEnv issues it: whoever starts the
// shell ends it with endAttentionToken). `peer`: the peer file access reading (peerFsOn); `name`: TA_SESSION_NAME, or null.
function terminalLaunch(ownerTaskId, id, workDir, { peer = peerFsOn(), name = null } = {}) {
  // A LaunchAgent starts with a slim PATH, so add the common paths by hand to make sure node/brew/tools are available
  const fullPath = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    process.env.PATH,
  ].filter(Boolean).join(':');
  const shell = terminalShell();

  // When the service runs as root, drop to TERMINAL_USER (default dev), otherwise Claude Code refuses the mode that skips permission prompts.
  const dropped = resolveTerminalUser();
  if (!dropped.user && (dropped.reason === 'missing-explicit' || dropped.reason === 'missing-default')) {
    console.warn(`[terminal] terminal user ${dropped.name} does not exist; the terminal still runs as the service user (root). Create that user or set TERMINAL_USER= in .env to silence this message`);
  }
  const runAs = dropped.user;
  let cwd = workDir || os.homedir();
  if (runAs && !userCanEnter(cwd, runAs)) {
    console.warn(`[terminal] user ${runAs.name} cannot enter ${cwd}; the terminal starts from its home directory ${runAs.home} instead. Adjust the owner or permissions of that directory`);
    cwd = runAs.home;
  }
  const baseEnv = withoutInheritedHookEnv(runAs ? { ...terminalEnvFor(runAs, process.env), SHELL: shell } : process.env);
  const env = {
    ...baseEnv,
    TERM: 'xterm-256color',
    // The clipboard shims come first, so a copy by a program in the terminal (`| pbcopy`, Neovim, Claude Code)
    // also reaches the browser clipboard as OSC 52, and a web link it opens (`open`, `xdg-open`, $BROWSER) goes to the
    // page that shows this terminal (lib/clipboard-shims.js, routes/open-link.js).
    ...clipboardShimEnv(fullPath, runAs, { env: baseEnv }),
    // Pick UTF-8 from the locales actually installed on this machine (C.UTF-8 / en_US / zh_CN ...),
    // otherwise zsh shows Chinese directory names as \M-^ garbage.
    ...utf8LocaleEnv(process.env),
    ...hookEnv(ownerTaskId, id, peer, baseEnv),
    ...attentionEnv(ownerTaskId, id, baseEnv),
    ...(name ? { TA_SESSION_NAME: name } : {}),
  };
  return { shell, cwd, runAs, env };
}

function getOrCreateSession(ownerTaskId, workDir, dirWarning, id = 'default') {
  const taskId = sessionKey(ownerTaskId, id);
  if (sessions.has(taskId)) return sessions.get(taskId);

  // The history is not persisted: after a service restart (or a close / restart) a terminal starts empty with a new shell.
  // No old text is replayed, so the stale mouse/focus mode reset of a restored history is not needed here.
  const savedBuffer = dirWarning || '';

  let pty;
  let shell;
  const peer = peerFsOn(); // one reading for the shell's environment and its startup command
  const name = sessionName(ownerTaskId, id); // the same for the environment and the command (reopenCommand reads it again, in the same tick)
  try {
    repairSpawnHelperPermissions(path.resolve(__dirname, '..'));
    const nodePty = require('node-pty');
    const launch = terminalLaunch(ownerTaskId, id, workDir, { peer, name });
    shell = launch.shell;
    pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: launch.cwd,
      ...(launch.runAs ? { uid: launch.runAs.uid, gid: launch.runAs.gid } : {}),
      env: launch.env,
    });
  } catch (e) {
    endAttentionToken(ownerTaskId, id);
    console.error('[terminal] node-pty spawn error:', e.message, '\ncwd:', workDir, '\nenv.HOME:', process.env.HOME);
    return { startupError: e };
  }

  const pending = pendingStartup.get(taskId);
  const startup = pending ? withSessionHook(pending.agent, withSessionName(pending.agent, pending.command, name), peer) : reopenCommand(ownerTaskId, id, workDir, peer);
  pendingStartup.delete(taskId);
  if (startup) pty.write(`${startup}\r`);

  const s = {
    taskId: ownerTaskId,
    terminalId: id,
    pty,
    chunks: [savedBuffer],
    size: savedBuffer.length,
    get buffer() { return bufferText(this); },
    ws: null,
    snapshot: new TerminalSnapshot(),
    ready: false,
    startDir: workDir, // the directory this shell was started in (the hook check also accepts it)
    shellName: baseName(shell),
  };
  sessions.set(taskId, s);
  s.snapshot.write(savedBuffer);

  // Backpressure: bytes the browser socket has not sent yet plus bytes the parser has not consumed.
  const backlog = () => (s.ws && s.ws.readyState === 1 ? s.ws.bufferedAmount || 0 : 0) + s.snapshot.pendingBytes;
  const stopFlowWatch = () => { clearInterval(s.flowTimer); s.flowTimer = null; };
  s.stopFlowWatch = stopFlowWatch;
  const updateFlow = () => {
    if (s.flowTimer || sessions.get(taskId) !== s || backlog() <= FLOW_HIGH || typeof pty.pause !== 'function') return;
    try { pty.pause(); } catch { return; }
    // A closed socket reports no backlog, so a socket that dies while paused also ends the pause.
    s.flowTimer = setInterval(() => {
      const gone = sessions.get(taskId) !== s;
      if (!gone && backlog() > FLOW_LOW) return;
      stopFlowWatch();
      if (!gone) { try { pty.resume(); } catch {} }
    }, FLOW_POLL_MS);
  };
  const deliver = batch => {
    if (s.ready && s.ws && s.authorized && s.authorized()) s.ws.send(batch);
    updateFlow();
  };
  const emit = data => {
    if (sessions.get(taskId) !== s) return;
    appendBuffer(taskId, data);
    s.snapshot.write(data, deliver);
    updateFlow();
  };
  pty.onData(data => {
    s.activity?.noteOutput();
    emit(data);
  });
  // Also goes through the history buffer so replays do not re-enable mouse reporting.
  s.stopShellWatch = watchShellReturn(pty, shell, () => emit(RESET_INPUT_MODES));
  const turnEnd = createTurnEndWatch({ agentOf: () => terminalAgent(s), onTurnEnd: agent => { if (agentTurnEndListener) agentTurnEndListener(agent); } });
  s.activity = createActivityTracker(pty, shell, () => {
    activityStream.notify();
    agentRenames.poke(taskId); // a rename that waits for a permission question to be answered
    if (s.activity) turnEnd(s.activity.state()); // the plan usage bars read the agent's plan after its turn (services/agent-usage.js)
  });

  pty.onExit(() => {
    // The parser queue also owns live delivery. Drain its last bytes before
    // closing a naturally exited shell; explicit control remains immediate.
    s.exiting = true;
    stopFlowWatch();
    s.stopShellWatch();
    s.activity.stop();
    s.snapshot.enqueue(() => {
      if (sessions.get(taskId) !== s) return;
      sessions.delete(taskId);
      endAttentionToken(ownerTaskId, id);
      activityStream.notify(); // a terminal that ends is idle from now on
      s.snapshot.dispose();
      const activeWs = s.ws;
      s.ws = null;
      if (activeWs && activeWs.readyState === 1) activeWs.close(1000, 'terminal exited');
    });
  });

  return s;
}

// Takes a terminal's live session out of the map: from this moment the terminal has no shell for every caller (the activity, the page, and
// a new connection starts a new shell). Answers the session, or null when the terminal has none. Its shell still runs: endShells() ends it.
function detachSession(taskId, id, reason) {
  const key = sessionKey(taskId, id);
  const session = sessions.get(key);
  if (!session) return null;
  sessions.delete(key);
  agentRenames.cancel(key);
  endAttentionToken(taskId, id);
  activityStream.notify();
  session.snapshot.dispose();
  session.stopShellWatch?.();
  session.stopFlowWatch?.();
  session.activity?.stop();
  const activeWs = session.ws;
  session.ws = null;
  if (activeWs && activeWs.readyState === 1) activeWs.close(1000, reason);
  return session;
}

// Ends the shells of detached sessions. pty.kill() only sends SIGHUP to the shell, and Codex in the foreground ignores it and keeps its
// session lock, so the foreground jobs are ended first (services/terminal-reaper.js). The reaper must see the process table while the shells
// still run; it reads one table for all of them without blocking the server, and the shells are killed as soon as their foreground groups
// got SIGTERM (at once for shells that have no process id). Until then the sessions wait in `ending`, so a server that exits meanwhile still
// ends them (shutdownTerminals). A reaper that settles without having said so does not leave a shell behind either.
function endShells(list) {
  const live = list.filter(Boolean);
  if (!live.length) return;
  for (const session of live) ending.add(session);
  const kill = () => {
    for (const session of live) {
      if (!ending.delete(session)) continue; // killed already
      try { session.pty.kill(); } catch {}
    }
  };
  try {
    const pending = reap(live.map(session => session.pty && session.pty.pid), { signalled: kill });
    if (pending && typeof pending.then === 'function') pending.then(kill, kill);
    else kill();
  } catch { kill(); }
}

/**
 * Terminate the task's server-side PTY. restart-workdir: the next connection creates a brand-new shell in the
 * terminal's own directory (terminalWorkDir: the task work_dir when the terminal was created); close also ends the shell (the history lives in memory only, so every action leaves the next terminal empty); delete also removes the terminal record (the default terminal is marked removed instead).
 */
function controlSession(taskId, action, requestedTerminalId) {
  const id = Number.parseInt(taskId, 10);
  if (!id || !['close', 'restart-workdir', 'delete'].includes(action)) {
    const error = new Error('INVALID_TERMINAL_ACTION');
    error.statusCode = 400;
    throw error;
  }

  const selectedId = assertTerminal(id, requestedTerminalId);
  // A notebook row has no terminal shell: close stops its kernel, restart-workdir starts a fresh one, delete stops it and forgets the notebook (its
  // file stays).
  if (isNotebookRow(id, selectedId)) {
    const service = kernels();
    if (action === 'restart-workdir') service.restartKernel(id, selectedId);
    else if (action === 'close') service.stopKernel(id, selectedId);
    else {
      service.forget(id, selectedId);
      db.prepare('DELETE FROM task_terminals WHERE task_id = ? AND terminal_id = ?').run(id, selectedId);
      dropFromOrder(id, selectedId);
    }
    return { success: true, action, had_session: false };
  }
  const session = detachSession(id, selectedId, `terminal ${action}`);
  endShells([session]);

  if (action === 'delete' && selectedId === 'default') {
    db.prepare('INSERT OR IGNORE INTO task_default_terminal_removed (task_id) VALUES (?)').run(id);
    db.prepare('DELETE FROM task_default_terminal_titles WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM task_default_terminal_dirs WHERE task_id = ?').run(id);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM task_terminals WHERE task_id = ? AND terminal_id = ?').run(id, selectedId);
  }
  if (action === 'delete') dropFromOrder(id, selectedId);
  return { success: true, action, had_session: Boolean(session) };
}

/**
 * Handle WebSocket upgrade for /terminal/ws?taskId=:id
 * Called from server.js with (ws, req, sessionData)
 */
function handleWs(ws, req, sessionUser, requestedTaskId = null, requestedTerminalId = null) {
  const taskId = parseInt(requestedTaskId || new URL(req.url, 'http://x').searchParams.get('taskId'));
  if (!taskId) { ws.close(1008, 'missing taskId'); return; }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, sessionUser.login);
  if (!task) {
    console.error('[terminal] task not found, taskId:', taskId, 'user:', sessionUser.login);
    ws.send('\r\n\x1b[31m[Task does not exist or access denied]\x1b[0m\r\n');
    ws.close(1008, 'task not found');
    return;
  }
  // No shell for an archived task, also not for a page's early socket. 1008 is the close the page does not reconnect after (a 4xxx would retry for ever).
  if (task.archived_at) {
    ws.close(1008, 'TASK_ARCHIVED');
    return;
  }
  if (require('../services/task-move').isMoving(task.id)) {
    ws.close(1008, 'TASK_MOVING');
    return;
  }

  let selectedId;
  try {
    selectedId = assertTerminal(taskId, requestedTerminalId ?? new URL(req.url, 'http://x').searchParams.get('terminalId'));
  } catch (error) {
    ws.close(1008, error.message);
    return;
  }
  // A notebook row is not a terminal: no shell is started for it (its kernel runs through /notebooks). 1008, so the page does not reconnect.
  if (isNotebookRow(taskId, selectedId)) {
    ws.close(1008, 'NOTEBOOK_NOT_A_TERMINAL');
    return;
  }
  const key = sessionKey(taskId, selectedId);
  // The shell starts in the terminal's own directory. When that one is gone (and it is not the task's current one), the task's directory is
  // used; when that is missing too, $HOME. Each fallback is logged and shown in the terminal.
  const ownDir = terminalWorkDir(task, selectedId) || os.homedir();
  let actualDir = ownDir;
  let dirWarning = null;
  if (!sessions.has(key) && !fs.existsSync(ownDir)) {
    const taskDir = task.work_dir || os.homedir();
    if (taskDir !== ownDir && fs.existsSync(taskDir)) {
      actualDir = taskDir;
      console.warn(`[terminal] the directory of terminal ${selectedId} of task ${taskId} does not exist (${ownDir}); its shell starts in the task's working directory ${taskDir}`);
      dirWarning = `\r\n\x1b[33m[⚠ Session directory does not exist: ${ownDir}]\x1b[0m\r\n\x1b[33m[Started in the task's working directory ${taskDir}]\x1b[0m\r\n\r\n`;
    } else {
      actualDir = os.homedir();
      dirWarning = `\r\n\x1b[33m[⚠ Working directory does not exist: ${ownDir}]\x1b[0m\r\n\x1b[33m[Fell back to ${actualDir}; edit the task to update the working path]\x1b[0m\r\n\r\n`;
    }
  }
  // The default terminal has no row: it keeps the directory its shell first started in from now on.
  if (selectedId === 'default' && !sessions.has(key) && task.work_dir && actualDir === task.work_dir) {
    db.prepare('INSERT OR IGNORE INTO task_default_terminal_dirs (task_id, work_dir) VALUES (?, ?)').run(taskId, task.work_dir);
  }
  const s = getOrCreateSession(taskId, actualDir, dirWarning, selectedId);
  if (s.startupError) {
    const details = String(s.startupError.message || 'unknown error')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 500);
    ws.send(`\r\n\x1b[31m[Terminal failed to start]\x1b[0m\r\n${details}\r\n`);
    ws.close();
    return;
  }

  // One client owns a terminal at a time. A different client is refused until it asks to take over;
  // the same client (page refresh, reconnect after a dropped network) simply replaces its old socket.
  const query = new URL(req.url, 'http://x').searchParams;
  const clientId = (query.get('clientId') || '').slice(0, 64);
  const takeover = query.get('takeover') === '1';
  if (s.ws && s.ws.readyState === 1) {
    const sameClient = Boolean(clientId) && s.wsClientId === clientId;
    if (!sameClient && !takeover) {
      ws.close(TERMINAL_IN_USE_CLOSE, 'terminal in use');
      return;
    }
    s.ws.close(sameClient ? 1000 : TERMINAL_TAKEN_CLOSE, sameClient ? 'replaced by new connection' : 'terminal taken over');
  }
  s.ws = ws;
  s.wsClientId = clientId;
  s.linkControl = null; // set below once this socket can take control messages (offerLink)
  sharedClock.wake(); // someone is watching: the terminals are polled at full speed again

  s.ready = false;
  // proto=2: control messages are binary frames; every text frame is terminal input (see public/js/terminal-protocol.js).
  const binaryControl = query.get('proto') === '2';
  const sendControl = message => ws.send(binaryControl ? Buffer.from(JSON.stringify(message)) : JSON.stringify(message));
  // Links from programs (offerLink) go only to a page that speaks the binary protocol: an old page would print the JSON.
  if (binaryControl) s.linkControl = { ws, send: sendControl };
  // Drop connections that vanished without a close (a phone that went to sleep), so they do not keep the terminal owned.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const aliveTimer = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, 30000);
  aliveTimer.unref?.();
  ws.on('close', () => clearInterval(aliveTimer));
  const archive = createHistoryArchive(s.buffer);
  let checkedAt = 0;
  const authorized = () => {
    if (ws.readyState !== 1 || sessions.get(key) !== s || s.ws !== ws) return false;
    // The database and session checks run at most once per AUTH_CACHE_MS, not per PTY chunk.
    const now = Date.now();
    if (checkedAt && now - checkedAt < AUTH_CACHE_MS) return true;
    if (req.sessionID && !require('../services/client-auth').getClientAuth().sessionActive(req.sessionID)) {
      ws.close(1008, 'Authentication required');
      return false;
    }
    if (!prepared('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(taskId, sessionUser.login)) {
      ws.close(1008, 'task not found');
      return false;
    }
    checkedAt = now;
    return true;
  };
  s.authorized = authorized;
  s.snapshot.snapshot(snapshot => {
    if (!authorized()) return;
    sendControl({ type: 'history', ...snapshot, archive: archive.metadata() });
    s.ready = true;
  });

  // Returns true when the message was a control message and must not reach the shell.
  const handleControl = data => {
    if (!data || typeof data.type !== 'string') return false;
    if (data.type.startsWith('history')) {
      if (data.type === 'history-page') sendControl(archive.page(data));
      return true;
    }
    if (data.type === 'ping' && binaryControl) { sendControl({ type: 'pong' }); return true; }
    if (data.type === 'presence') { presence.report(key, ws, data.foreground); return true; }
    if (data.type === 'open-link-result') { settleLinkOffer(data.id, ws, data.shown === true); return true; }
    if (data.type === 'resize') {
      if (!Number.isInteger(data.cols) || !Number.isInteger(data.rows) || data.cols < 1 || data.rows < 1 || data.cols > 1000 || data.rows > 1000) return true;
      s.activity?.noteInput();
      s.pty.resize(data.cols, data.rows);
      s.snapshot.resize(data.cols, data.rows);
      return true;
    }
    return false;
  };

  ws.on('message', (msg, isBinary) => {
    if (!authorized()) return;
    presence.touch(key, ws); // the page is alive (it pings every 15 s), so its presence report still holds
    const str = msg.toString();
    if (binaryControl) {
      // Only binary frames are control messages; text is always terminal input, whatever it looks like.
      if (isBinary) {
        try { handleControl(JSON.parse(str)); } catch { /* malformed control: ignore */ }
        return;
      }
    } else if (/^\s*\{/.test(str)) {
      // Old clients: control messages are text frames. Only try messages starting with '{' (digits are valid JSON too).
      try {
        if (handleControl(JSON.parse(str))) return;
      } catch {
        // Malformed history controls must never become shell input.
        if (/\"type\"\s*:\s*\"history/.test(str)) return;
      }
    }
    if (!s.exiting) {
      s.activity?.noteInput();
      noteTerminalInput(`local:${key}`);
      s.pty.write(str);
    }
  });

  ws.on('close', () => {
    presence.drop(key, ws);
    dropLinkOffers(ws);
    if (s.ws === ws) {
      s.ws = null;
      s.linkControl = null;
    }
  });

  ws.on('error', (err) => {
    console.error('[terminal] ws error:', err.message);
  });
}

// Links opened by programs ("Links opened by programs" in docs/design/terminals.md, docs/design/open-links.md): the link shims of the
// terminal call routes/open-link.js, which calls offerLink. The link goes, as the control message { type: 'open-link', id, url, agent },
// to the page attached to this terminal (one socket at a time; a page on another device attached through a service link has its socket
// end here too). The page answers { type: 'open-link-result', id, shown }: shown is true when this terminal is the one it shows and the
// person is using the page, and then the page opens the link or shows its bar. No page, an old page, a page that says no or no answer
// within LINK_OFFER_MS: { delivered: false }, and the shim opens the link on this machine as before.
const LINK_OFFER_MS = 2000;
const linkOffers = new Map(); // id -> { ws, done(shown), timer }
let linkOfferIds = 0;
function settleLinkOffer(id, ws, shown) {
  const offer = linkOffers.get(id);
  if (!offer || offer.ws !== ws) return;
  offer.done(shown);
}
function dropLinkOffers(ws) {
  for (const offer of [...linkOffers.values()]) if (offer.ws === ws) offer.done(false, 'no-viewer');
}
function offerLink(taskId, requestedTerminalId, url, { timeoutMs = LINK_OFFER_MS } = {}) {
  let id;
  try { id = terminalId(requestedTerminalId); } catch { return Promise.resolve({ delivered: false, reason: 'no-viewer' }); }
  const s = sessions.get(sessionKey(taskId, id));
  const control = s && s.linkControl;
  if (!control || s.ws !== control.ws || control.ws.readyState !== 1 || !s.ready || !s.authorized || !s.authorized()) {
    return Promise.resolve({ delivered: false, reason: 'no-viewer' });
  }
  const row = id === 'default' ? null : prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(Number(taskId), id);
  const offerId = `l${++linkOfferIds}`;
  return new Promise(resolve => {
    const offer = {
      ws: control.ws,
      timer: setTimeout(() => offer.done(false, 'no-answer'), timeoutMs),
      done(shown, reason = shown ? undefined : 'not-shown') {
        if (linkOffers.get(offerId) !== offer) return;
        linkOffers.delete(offerId);
        clearTimeout(offer.timer);
        resolve(shown ? { delivered: true } : { delivered: false, reason });
      },
    };
    offer.timer.unref?.();
    linkOffers.set(offerId, offer);
    try { control.send({ type: 'open-link', id: offerId, url, agent: (row && row.agent) || null }); } catch { offer.done(false, 'no-viewer'); }
  });
}

// Whether listTerminals would list this terminal: the default terminal unless it was removed, a row that is not a legacy phone shell (h5-...).
function isListedTerminal(taskId, id) {
  if (id === 'default') return !defaultRemoved(taskId);
  return !id.startsWith('h5-') && Boolean(prepared('SELECT 1 FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id));
}

/** Activity of every live terminal of the given tasks: { [taskId]: { [terminalId]: state } } (idle terminals are left out).
 *  Read from the live shells: only a shell can be busy, so no terminal list and no agent session file is read (this runs for every open
 *  activity stream on every change). A shell that is not idle counts when its terminal is still listed (one row lookup). */
function activitySnapshot(taskIds) {
  const wanted = new Set();
  for (const taskId of taskIds) wanted.add(Number(taskId));
  const result = {};
  for (const s of sessions.values()) {
    if (!wanted.has(s.taskId)) continue;
    const state = s.activity ? s.activity.state() : 'idle';
    if (state === 'idle' || !isListedTerminal(s.taskId, s.terminalId)) continue;
    (result[s.taskId] ||= {})[s.terminalId] = state;
  }
  // A notebook that runs a cell is a running terminal (its kernel is no session here).
  if (notebookKernels) {
    for (const [taskId, terminals] of Object.entries(notebookKernels.activity(wanted))) Object.assign(result[taskId] ||= {}, terminals);
  }
  return result;
}

/** The kind of every open question of the given tasks' listed terminals ("Two waiting kinds" in docs/design/terminals.md):
 *  { [taskId]: { [terminalId]: 'select' | 'accept' } }. Such a terminal is 'done' in activitySnapshot (what an older page reads as "needs you"). */
function waitingKindSnapshot(taskIds) {
  const wanted = new Set();
  for (const taskId of taskIds) wanted.add(Number(taskId));
  const result = {};
  for (const s of sessions.values()) {
    if (!wanted.has(s.taskId) || !s.activity) continue;
    const kind = s.activity.waitingKind();
    if (!kind || !isListedTerminal(s.taskId, s.terminalId)) continue;
    (result[s.taskId] ||= {})[s.terminalId] = kind;
  }
  return result;
}

/** Running sub-agents of the live Claude terminals of the given tasks: { [taskId]: { [terminalId]: count } } (terminals with none are left out).
 *  Only a terminal whose shell is alive and that is bound to a Claude session (agent_session_id) can have one; see runningSubagents.
 *  The count reads the session the live shell really runs (after /clear, the cleared one), not only the binding. */
function subagentSnapshot(taskIds, home) {
  const result = {};
  const wanted = taskIds ? new Set(taskIds.map(String)) : null; // null: every task (the push stream's shared refresh)
  // The sub-agent logs live under the directory the terminal's Claude runs in (its own directory, not the task's current one).
  const rows = prepared("SELECT t.task_id, t.terminal_id, t.agent_session_id, COALESCE(t.work_dir, k.work_dir) AS work_dir FROM task_terminals t JOIN tasks k ON k.id = t.task_id WHERE t.agent = 'claude' AND t.agent_session_id IS NOT NULL").all();
  for (const row of rows) {
    const live = sessions.get(sessionKey(row.task_id, row.terminal_id));
    if ((wanted && !wanted.has(String(row.task_id))) || !live) continue;
    const count = runningSubagents(live.startDir || row.work_dir, liveAgentSessionId(live, row.agent_session_id), home);
    if (count) (result[row.task_id] ||= {})[row.terminal_id] = count;
  }
  return result;
}

// Whether reopenCommand() would really bring this terminal's agent back after a restart: the terminal is bound to a session and that session's file is
// where a new shell will look for it. A Claude session that never got a message has no file, and an id alone is not proof of what runs in the terminal.
function agentResumable(s, agent) {
  try {
    let row = db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(s.taskId, s.terminalId);
    if (row && !row.agent_session_id) {
      withAgentSessions(s.taskId, [{ terminal_id: s.terminalId, title: '' }]); // binds a Codex session that has appeared since
      row = db.prepare('SELECT agent_session_id FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(s.taskId, s.terminalId);
    }
    if (!row || !row.agent_session_id) return false;
    const task = db.prepare('SELECT id, work_dir FROM tasks WHERE id = ?').get(s.taskId);
    const dir = task && (terminalWorkDir(task, s.terminalId) || os.homedir());
    return Boolean(dir) && fs.existsSync(dir) && listSessions(agent, dir, sessionHome(agent), 200).some(entry => entry.id === row.agent_session_id);
  } catch { return false; }
}

// What every live terminal is doing, for lib/update-idle.js.
function updateIdleTerminals() {
  const subagents = subagentSnapshot(null);
  const terminals = [];
  for (const s of sessions.values()) {
    if (s.exiting) continue;
    const foreground = foregroundCommand(s.pty);
    const row = s.terminalId === 'default' ? null : prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(s.taskId, s.terminalId);
    const agent = (row && row.agent) || null;
    terminals.push({
      state: s.activity ? s.activity.state() : 'idle',
      subagents: (subagents[s.taskId] && subagents[s.taskId][s.terminalId]) || 0,
      awaiting: Boolean(s.activity && s.activity.awaitingAnswer()),
      foreground,
      shell: s.shellName,
      agent,
      resumable: Boolean(agent) && foreground.includes(agent) && agentResumable(s, agent),
    });
  }
  if (notebookKernels) terminals.push(...notebookKernels.idleTerminals());
  return terminals;
}

// Pushed activity (lib/terminal-activity-stream.js): GET /api/tasks/terminal-activity/stream and Engine /v1/terminal-activity/stream.
// The sub-agent counts of all live Claude terminals are read once per refresh, whatever the number of open streams.
const activityStream = createActivityStream({
  activity: activitySnapshot,
  waitingKinds: waitingKindSnapshot,
  subagents: () => subagentSnapshot(null),
});
// The notebook kernels tell the feeds when a cell starts or ends (services/notebook-kernels.js).
function notifyActivity() { activityStream.notify(); }
function serveActivityStream(req, res, taskIds, options) {
  activityStream.serve(req, res, taskIds, options);
  sharedClock.wake();
}

// Whether someone is looking at this server's terminals: a page has a terminal open (its WebSocket is attached), an activity stream is open,
// or the desktop window read the activity a moment ago (it reads it every 5 s). While nobody is, the clock that polls every terminal
// (lib/terminal-poll.js) runs every 2 s instead of every 500 ms; the first watcher brings the full speed back at once (sharedClock.wake()).
// Hook reports and PTY output still reach the trackers the moment they happen, so only what a poll decides comes later.
const WIDGET_WATCH_MS = 15000;
let widgetReadAt = 0;
function watched() {
  if (activityStream.size() > 0 || Date.now() - widgetReadAt < WIDGET_WATCH_MS) return true;
  for (const s of sessions.values()) if (s.ws && s.ws.readyState === 1) return true;
  return false;
}
sharedClock.watchedBy(watched);

function acknowledgeActivity(taskId, requestedTerminalId) {
  const id = assertTerminal(taskId, requestedTerminalId);
  const session = sessions.get(sessionKey(taskId, id));
  if (session && session.activity) session.activity.acknowledge();
  return { success: true };
}

// The terminals of a task whose shell is running (a session in memory with a PTY). Such a shell, and an agent in it, has the task's folder open, so the
// folder cannot be renamed under it (services/task-rename.js).
function liveTerminalIds(taskId) {
  const prefix = `${Number(taskId)}:`;
  const ids = [];
  for (const [key, s] of sessions) if (key.startsWith(prefix) && s.pty && !s.startupError) ids.push(s.terminalId);
  if (notebookKernels) ids.push(...notebookKernels.liveIds(taskId)); // a notebook's shell has the folder open too
  return ids;
}

// The T-Attention desktop window (routes/attention-widget.js; "T-Attention desktop window (macOS)" in docs/design/attention-desktop-window.md) reads and writes this machine's
// terminals through the three functions below.
const liveSession = (taskId, requestedTerminalId) => {
  if (!Number.isInteger(Number(taskId)) || Number(taskId) < 1 || typeof requestedTerminalId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestedTerminalId)) return null;
  const s = sessions.get(sessionKey(taskId, requestedTerminalId));
  return s && s.pty && !s.startupError && !s.exiting ? s : null;
};

// What the window shows about a terminal named by an item's context.tagent: { agent: 'claude' | 'codex' | 'opencode' | null (the task_terminals row), live (its shell runs) }.
function terminalInfo(taskId, requestedTerminalId) {
  const live = Boolean(liveSession(taskId, requestedTerminalId)) || Boolean(notebookKernels && notebookKernels.isLive(taskId, requestedTerminalId));
  let agent = null;
  if (Number.isInteger(Number(taskId)) && Number(taskId) > 0 && typeof requestedTerminalId === 'string' && requestedTerminalId !== 'default') {
    try {
      const row = prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(Number(taskId), requestedTerminalId);
      agent = (row && row.agent) || null;
    } catch { agent = null; }
  }
  return { agent, live };
}

// A reply typed in the window, sent to a live terminal as the person would paste it: a bracketed paste (ESC[200~ ... ESC[201~, line breaks as \r, other
// control characters removed so the text cannot end the paste itself), then Enter on its own after enterDelayMs (Codex takes keys that come quickly after
// each other as a paste burst, so an Enter in the same write would be part of the text). False when the terminal has no live shell.
const REPLY_ENTER_DELAY_MS = 150;
function sendToTerminal(taskId, requestedTerminalId, text, { enterDelayMs = REPLY_ENTER_DELAY_MS } = {}) {
  const s = liveSession(taskId, requestedTerminalId);
  if (!s) return false;
  const body = String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n/g, '\r');
  const key = sessionKey(taskId, requestedTerminalId);
  const type = data => {
    s.activity?.noteInput();
    noteTerminalInput(`local:${key}`);
    s.pty.write(data);
  };
  type(`\x1b[200~${body}\x1b[201~`);
  const timer = setTimeout(() => { if (sessions.get(key) === s && !s.exiting) type('\r'); }, enterDelayMs);
  timer.unref?.();
  return true;
}

// T-Attention scheduled prompts ("Firing" in docs/design/attention-schedules.md): whether a session of this machine takes a prompt
// now. 'gone': no such task or terminal; 'stopped': it has no running shell; 'busy': it works, waits for an answer, or something other than its
// agent (an agent terminal) or its shell prompt (a shell terminal) has the foreground, so typed text would go elsewhere; 'idle': it takes it.
function promptState(taskId, requestedTerminalId) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1 || typeof requestedTerminalId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestedTerminalId)) return 'gone';
  if (!prepared('SELECT id FROM tasks WHERE id = ?').get(id)) return 'gone';
  let agent = null;
  if (requestedTerminalId !== 'default') {
    const row = prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(id, requestedTerminalId);
    if (!row) return 'gone';
    agent = row.agent || null;
  }
  const s = liveSession(id, requestedTerminalId);
  if (!s) return 'stopped';
  if (s.activity && (s.activity.state() === 'running' || s.activity.awaitingAnswer())) return 'busy';
  const names = foregroundCommand(s.pty);
  if (agent ? !names.includes(agent) : !isShellForeground(names, s.shellName)) return 'busy';
  return 'idle';
}
// Types a scheduled prompt into an idle session: an agent gets it as a paste with Enter on its own (sendToTerminal, the window's reply path); a plain
// shell gets the text as typed keys and Enter (a shell without bracketed paste would show the paste markers). False when it has no running shell.
function sendPrompt(taskId, requestedTerminalId, text) {
  const agent = requestedTerminalId === 'default' ? null : (prepared('SELECT agent FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(Number(taskId), requestedTerminalId) || {}).agent;
  if (agent) return sendToTerminal(taskId, requestedTerminalId, text);
  const s = liveSession(taskId, requestedTerminalId);
  if (!s) return false;
  const key = sessionKey(taskId, requestedTerminalId);
  s.activity?.noteInput();
  noteTerminalInput(`local:${key}`);
  s.pty.write(`${String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n/g, '\r')}\r`);
  return true;
}

// T-Attention scheduled scripts ("Run a script" in docs/design/attention-schedules.md): each run is a NEW terminal of the task, made and started the way
// a terminal the person opens is (createTerminal, getOrCreateSession: the task's folder, the user's shell, the same environment and tokens). The
// server writes two files to a private folder: the person's script, and a wrapper that prints an invisible marker with its own process id, runs the
// script with the terminal's shell and prints a second marker with the exit status (OSC 7771 with a random nonce; xterm ignores an unknown OSC). The
// wrapper is typed into the new shell as its first line, so the script runs as the foreground job of an ordinary shell and the terminal stays open at
// its prompt afterwards, with the output, until the person or the cleanup (the last 5 runs of an item are kept) closes it. The server reads the markers
// from the terminal's output. The time limit sends SIGTERM to the script's process group (the wrapper's pid: an interactive shell puts each job in a
// group of its own), SIGKILL 3 s later; a shell that ends first (closed, deleted) ends the run too. onEnd({ outcome: 'exit' | 'timeout' | 'ended',
// exit, duration_ms, terminal_id }) is called once.
const SCRIPT_MARK = /\x1b\]7771;([0-9a-f]{16});(start|exit);(\d{1,10})\x07/g;
const SCRIPT_KILL_GRACE_MS = 3000;
// The files live in the data folder (<data home>/attention-scripts, private to the service user), or, when the shells run as another user (a root
// service dropping to TERMINAL_USER, who cannot enter the data folder), in a folder of the temporary directory owned by that user.
function scriptFolder(runAs) {
  const dropping = Boolean(runAs && process.getuid && process.getuid() === 0);
  const dir = dropping ? path.join(os.tmpdir(), `t-agent-scripts-${runAs.uid}`) : path.join(require('../lib/data-home').paths().root, 'attention-scripts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (runAs && process.getuid && process.getuid() === 0) { try { fs.chownSync(dir, runAs.uid, runAs.gid); } catch { /* the shell may not read it: the run fails */ } }
  return dir;
}
function runScript(taskId, { title, script, timeoutMs = 30 * 60 * 1000, onEnd = () => {} } = {}) {
  const id = Number(taskId);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
  const created = createTerminal(id, { title });
  const terminalId = created.terminal_id;
  const nonce = crypto.randomBytes(8).toString('hex');
  const runAs = resolveTerminalUser().user;
  const shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => fs.existsSync(candidate)) || '/bin/sh';
  const dir = scriptFolder(runAs);
  const scriptFile = path.join(dir, `${nonce}-script`);
  const wrapperFile = path.join(dir, `${nonce}-run`);
  fs.writeFileSync(scriptFile, String(script).replace(/\r\n?/g, '\n'), { mode: 0o600 });
  fs.writeFileSync(wrapperFile, [
    `printf '\\033]7771;${nonce};start;%s\\007' "$$"`,
    `${shellQuote(shell)} ${shellQuote(scriptFile)}`,
    '__ta_status=$?',
    `rm -f ${shellQuote(scriptFile)} ${shellQuote(wrapperFile)}`,
    `printf '\\033]7771;${nonce};exit;%s\\007' "$__ta_status"`,
    '',
  ].join('\n'), { mode: 0o600 });
  if (runAs && process.getuid && process.getuid() === 0) {
    for (const file of [scriptFile, wrapperFile]) { try { fs.chownSync(file, runAs.uid, runAs.gid); } catch { /* see scriptFolder */ } }
  }
  const removeFiles = () => { for (const file of [scriptFile, wrapperFile]) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } } };
  // The leading space keeps the line out of the shell's history (zsh HIST_IGNORE_SPACE, bash ignorespace).
  pendingStartup.set(sessionKey(id, terminalId), { agent: null, command: ` ${shellQuote(shell)} ${shellQuote(wrapperFile)}` });
  const workDir = terminalWorkDir(task, terminalId) || os.homedir();
  const s = getOrCreateSession(id, fs.existsSync(workDir) ? workDir : os.homedir(), null, terminalId);
  if (s.startupError) {
    pendingStartup.delete(sessionKey(id, terminalId));
    removeFiles();
    throw Object.assign(new Error(`The terminal could not start: ${s.startupError.message}`), { statusCode: 500 });
  }
  const started = Date.now();
  let pid = null;
  let tail = '';
  let done = false;
  let killTimer = null;
  const finish = (outcome, exit = null) => {
    if (done) return;
    done = true;
    clearTimeout(limit);
    try { dataListener.dispose(); } catch { /* ended */ }
    try { exitListener.dispose(); } catch { /* ended */ }
    if (outcome !== 'timeout') removeFiles();
    try { onEnd({ outcome, exit, duration_ms: Date.now() - started, terminal_id: terminalId }); } catch (error) { console.warn(`[terminal] a script run could not be recorded: ${error.message}`); }
  };
  const dataListener = s.pty.onData(chunk => {
    tail = (tail + chunk).slice(-512);
    SCRIPT_MARK.lastIndex = 0;
    let match;
    while ((match = SCRIPT_MARK.exec(tail))) {
      if (match[1] !== nonce) continue;
      if (match[2] === 'start') pid = Number(match[3]);
      else { tail = ''; return finish('exit', Number(match[3])); }
    }
    return undefined;
  });
  const exitListener = s.pty.onExit(() => finish('ended'));
  const limit = setTimeout(() => {
    const group = pid && pid !== s.pty.pid ? pid : null;
    const signal = name => {
      if (group) { try { process.kill(-group, name); } catch { /* already gone */ } } else if (name === 'SIGTERM') { try { s.pty.write('\x03'); } catch { /* ended */ } }
    };
    signal('SIGTERM');
    killTimer = setTimeout(() => { signal('SIGKILL'); removeFiles(); }, SCRIPT_KILL_GRACE_MS);
    killTimer.unref?.();
    finish('timeout');
  }, Math.max(1, timeoutMs));
  limit.unref?.();
  return { terminal_id: terminalId, title: created.title };
}
// The task a script runs in: 'ok', 'archived' or 'gone'.
function scriptTaskState(taskId) {
  const row = Number.isSafeInteger(Number(taskId)) ? prepared('SELECT archived_at FROM tasks WHERE id = ?').get(Number(taskId)) : null;
  if (!row) return 'gone';
  return row.archived_at ? 'archived' : 'ok';
}
// Removes an old script terminal (its shell ends and its row goes); nothing when it is gone already.
function removeScriptTerminal(taskId, terminalId) {
  try { controlSession(taskId, 'delete', terminalId); return true; } catch { return false; }
}

// The live terminals of every task that are not idle, for the window's activity list: [{ task_id, task_title, terminal_id, title, agent, state, since }],
// state 'running' | 'waiting' (done at a question: awaitingAnswer, with waiting_kind 'select' | 'accept') | 'done' (finished, not acknowledged yet);
// since: ms of the last state change.
// The title and agent are the ones the task's terminal list shows (listTerminals: an agent terminal is named after its session). They are read
// from the terminal's own row; only the name of an agent session comes from the last terminal listing (sessionNames), which is made again here
// when it is older than SESSION_NAMES_MS, so a call inside that time reads no session file and lists no folder.
function liveTerminalActivity() {
  widgetReadAt = Date.now();
  sharedClock.wake();
  const byTask = new Map();
  for (const s of sessions.values()) {
    if (!s.pty || s.startupError || s.exiting || !s.activity) continue;
    const state = s.activity.state();
    if (state === 'idle') continue;
    if (!byTask.has(s.taskId)) byTask.set(s.taskId, []);
    byTask.get(s.taskId).push({ s, state: state === 'done' && s.activity.awaitingAnswer() ? 'waiting' : state, kind: s.activity.waitingKind() });
  }
  const out = [];
  for (const [taskId, live] of byTask) {
    const task = prepared('SELECT title FROM tasks WHERE id = ?').get(taskId);
    if (!task) continue;
    let rows = [];
    try { rows = live.map(({ s }) => listedTerminal(taskId, s.terminalId)); } catch { rows = []; }
    const names = rows.some(row => row && row.follows) ? currentSessionNames(taskId) : null;
    live.forEach(({ s, state, kind }, index) => {
      const row = rows[index];
      if (!row) return; // a legacy phone shell (h5-...) or a terminal deleted meanwhile
      const title = (row.follows && names && names.get(s.terminalId)) || row.title;
      out.push({ task_id: String(taskId), task_title: task.title || '', terminal_id: s.terminalId, title: title || '', agent: row.agent || null, state, ...(state === 'waiting' && kind ? { waiting_kind: kind } : {}), since: s.activity.since() });
    });
  }
  // Notebooks that run a cell are listed as running, under the notebook's own title.
  for (const item of notebookKernels ? notebookKernels.running() : []) {
    const task = prepared('SELECT title FROM tasks WHERE id = ?').get(item.task_id);
    const row = task && listedTerminal(item.task_id, item.terminal_id);
    if (!row) continue;
    out.push({ task_id: String(item.task_id), task_title: task.title || '', terminal_id: item.terminal_id, title: row.title || '', agent: 'notebook', state: 'running', since: item.since });
  }
  return out;
}

// One terminal as the terminal list shows it, without its session: { title, agent, follows }, or null when the list does not have it.
// `follows`: an agent terminal the person did not name, which shows its session's name when that is known.
function listedTerminal(taskId, id) {
  if (id === 'default') {
    if (defaultRemoved(taskId)) return null;
    const stored = prepared('SELECT title FROM task_default_terminal_titles WHERE task_id = ?').get(taskId);
    return { title: stored ? stored.title : 'Terminal 1', agent: null, follows: false };
  }
  if (id.startsWith('h5-')) return null;
  const row = prepared('SELECT title, agent, title_custom FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  return row ? { title: row.title, agent: row.agent || null, follows: Boolean(row.agent) && !row.title_custom } : null;
}

// The session names of a task's agent terminals, at most SESSION_NAMES_MS old (a Map; empty when the listing fails).
function currentSessionNames(taskId) {
  const known = sessionNames.get(Number(taskId));
  if (known && Date.now() - known.at < SESSION_NAMES_MS) return known.names;
  try { listTerminals(taskId); } catch { return new Map(); }
  const fresh = sessionNames.get(Number(taskId));
  return fresh ? fresh.names : new Map();
}

// True while a page shows this terminal in the foreground (see lib/terminal-presence.js); false for an unknown terminal. With `since` (a time in
// ms): also true when it was in the foreground at some moment since then (a delayed notification asks whether the person could see it meanwhile).
function isTerminalForeground(taskId, requestedTerminalId, since) {
  if (!Number.isInteger(Number(taskId)) || Number(taskId) < 1 || typeof requestedTerminalId !== 'string') return false;
  const key = sessionKey(taskId, requestedTerminalId);
  return since === undefined ? presence.isForeground(key) : presence.seenSince(key, Number(since));
}
// The terminal belongs to this server: its shell runs here, or it is a terminal row of the task (terminal ids are UUIDs, so another machine's
// terminal never matches). The T-Attention notifiers use it instead of comparing host names (services/attention-notify.js onScreen).
function isLocalTerminal(taskId, requestedTerminalId) {
  if (!Number.isInteger(Number(taskId)) || Number(taskId) < 1 || typeof requestedTerminalId !== 'string' || !requestedTerminalId) return false;
  if (sessions.has(sessionKey(taskId, requestedTerminalId))) return true;
  if (requestedTerminalId === 'default') return false; // every task has one: the id alone says nothing
  try { return Boolean(prepared('SELECT 1 FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(Number(taskId), requestedTerminalId)); } catch { return false; }
}
const presenceSnapshot = () => presence.snapshot();

// Closes every shell of a task (legacy phone-only shells included: they are not listed any more, but one may still run). The shells are
// taken from the live sessions, so no terminal list and no session file is read, and one look at the process table serves all of them.
function closeTaskTerminals(taskId) {
  const prefix = `${Number(taskId)}:`;
  const closed = [];
  for (const [key, session] of [...sessions]) {
    if (key.startsWith(prefix)) closed.push(detachSession(session.taskId, session.terminalId, 'terminal close'));
  }
  sessionNames.delete(Number(taskId));
  endShells(closed);
  if (notebookKernels) notebookKernels.closeTask(taskId);
}

// On server exit (signal, update restart): end every terminal's foreground job (see endShells), then the shells; the shells of terminals
// closed a moment ago that still wait for the reaper are included. Synchronous, so it works inside process.on('exit'); idempotent and
// never throws.
function shutdownTerminals() {
  try {
    const live = [...sessions.values(), ...ending];
    agentRenames.stop();
    sessions.clear();
    ending.clear();
    reapSync(live.map(session => session.pty && session.pty.pid));
    for (const session of live) { try { session.pty.kill(); } catch {} }
  } catch {}
  try { if (notebookKernels) notebookKernels.shutdown(); } catch {}
}

module.exports = { terminalLaunch, terminalShell, onAgentTurnEnd, runningAgents, endAttentionToken, setNotebookKernels, notifyActivity, isNotebookRow, offerLink, terminalWorkDir, shutdownTerminals, setHookEndpoint, setAttentionTerminals, attentionEnv, reportHook, verifyHookToken, activitySnapshot, waitingKindSnapshot, subagentSnapshot, serveActivityStream, acknowledgeActivity, controlSession, handleWs, listTerminals, createTerminal, listAgentSessions, reopenCommand, renameTerminal, terminalCwd, assertTerminal, closeTaskTerminals, liveTerminalIds, updateIdleTerminals, setTerminalOrder, forgetTerminalOrder, isTerminalForeground, isLocalTerminal, presenceSnapshot, terminalInfo, sendToTerminal, liveTerminalActivity, promptState, sendPrompt, runScript, scriptTaskState, removeScriptTerminal };

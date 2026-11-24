// The Claude engine of the English coach ("The Claude engine" in docs/design/learn-english-coach.md): one coach turn on the Claude Agent SDK
// (@anthropic-ai/claude-agent-sdk), with the person's own Claude sign-in on this computer. The SDK runs the agent loop; the coach's tools are its
// ONLY tools (an in-process MCP server named `coach`), and the tool bodies are those of services/learn-coach.js, so the SQL sandbox, the caps, the
// memory and the proposals behave exactly as with the translation service.
//
// The lock (every option below is checked by test/learn-coach-claude.test.js):
// - `tools: []` (no built-in tool in the model's context), `disallowedTools`: every built-in name the SDK knows plus a fixed list, `allowedTools`:
//   only the coach tools, `permissionMode: 'dontAsk'` (anything not pre-approved is denied, nobody is asked) and a `canUseTool` that denies
//   everything that is not a coach tool; `strictMcpConfig: true` and `mcpServers: { coach }` only.
// - `settingSources: []`, `plugins: []`, `skills: []`, `agents: {}`, `hooks: {}`: no CLAUDE.md, settings, hooks, plugins, skills, agents or MCP
//   servers of the person. `persistSession: false`: nothing is written to the session folder.
// - A throw-away empty `cwd` under the data folder's tmp/, removed after the turn; `env` is an allow-list (no T-Agent secrets); `maxTurns` 8; a
//   hard timeout and the page's abort both abort the query and close it.
// - The init message must list only coach tools: a turn whose session has any other tool is ended at once (fail closed).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = 'coach';
const PREFIX = `mcp__${SERVER}__`;
const MAX_TURNS = 8;
const TIMEOUT_MS = 120_000; // under the 160 s a company computer waits for its home
const FOLD_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const READY_TTL_MS = 10 * 60_000;
const NOT_READY_TTL_MS = 60_000;
const QUOTA_PAUSE_MS = 30 * 60_000;
const MODEL = 'sonnet';
// Built-in tools named here as well as the SDK's own list (BUILTIN_TOOL_NAMES, "not complete" by its own words), so an SDK without the export is locked too.
const BUILT_IN = [
  'Agent', 'Task', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'LSP',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'SlashCommand', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'Monitor', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskStop', 'TaskUpdate', 'TaskOutput', 'SendMessage', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'EnterWorktree', 'ExitWorktree',
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup', 'Workflow', 'Artifact', 'SendUserFile', 'SendUserMessage', 'PushNotification',
];
// The environment Claude Code gets: what it needs to run and to find the person's sign-in, nothing of T-Agent (no secrets, no data folder).
const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TZ|TERM|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|ANTHROPIC_[A-Z_]+)$/;
const ENV_SET = {
  CLAUDE_AGENT_SDK_CLIENT_APP: 't-agent-coach', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1',
};
// Why Claude cannot answer (`reason`), in one line for the page; the notice when the translation service answered instead; the error when none can.
const REASONS = {
  no_sdk: 'Claude Code is not installed on this computer',
  signed_out: 'Claude is not signed in on this computer',
  quota: 'Your Claude plan has reached its usage limit for now',
  unsafe: 'Claude offered tools the coach does not allow',
  failed: 'Claude could not answer',
};
const FALLBACK = {
  no_sdk: 'Claude Code is not installed on this computer. The translation service answered this time.',
  signed_out: 'Claude is not signed in on this computer. The translation service answered this time.',
  quota: 'Your Claude plan has reached its usage limit for now. The translation service answered this time.',
  unsafe: 'Claude offered tools the coach does not allow. The translation service answered this time.',
  failed: 'Claude could not answer. The translation service answered this time.',
};
const NO_FALLBACK = {
  no_sdk: 'Claude Code is not installed on this computer. Set up a translation service or choose it for the coach.',
  signed_out: 'Claude is not signed in on this computer. Sign in to Claude Code or set up a translation service.',
  quota: 'Your Claude plan has reached its usage limit for now. Try again later or set up a translation service.',
  unsafe: 'Claude offered tools the coach does not allow. Try again later or set up a translation service.',
  failed: 'Claude could not answer. Try again later or set up a translation service.',
};
const TOO_SLOW = 'Claude took too long to answer';

class ClaudeUnavailable extends Error {
  constructor(reason, detail = '') {
    super(REASONS[reason] || REASONS.failed);
    this.reason = REASONS[reason] ? reason : 'failed';
    this.detail = String(detail || '').slice(0, 300);
    this.code = 'CLAUDE_UNAVAILABLE';
  }
}

function scrubEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (ENV_KEEP.test(key) && typeof value === 'string') out[key] = value;
  return { ...out, ...ENV_SET };
}

// The reason of an error text from Claude Code (a result's text or a thrown error).
function reasonOf(text, prefixes = []) {
  const value = String(text || '');
  if (prefixes.some(prefix => value.startsWith(prefix)) || /usage limit|rate limit|out of usage|credit balance|quota|limit reached|hit your limit/i.test(value)) return 'quota';
  if (/not logged in|log ?in|sign ?in|authenticat|oauth|invalid api key|api key|unauthori[sz]ed|401|403/i.test(value)) return 'signed_out';
  if (/ENOENT|not found|cannot find|spawn/i.test(value) && /claude/i.test(value)) return 'no_sdk';
  return 'failed';
}

const loadSdkDefault = () => import('@anthropic-ai/claude-agent-sdk');

// The zod shapes of the coach tools (the SDK's tool() takes a zod raw shape). Kept loose: services/learn-coach.js checks every value itself, so a
// wrong value reaches the tool and comes back as its usual error result instead of an SDK validation error.
function shapes(z) {
  return {
    learn_schema: {},
    learn_sql: { query: z.string() },
    propose_practice: { kind: z.string(), words: z.array(z.union([z.number(), z.string()])).optional(), count: z.number().optional() },
    propose_settings: { changes: z.record(z.string(), z.any()) },
    propose_cards: { add: z.array(z.any()).optional(), update: z.array(z.any()).optional(), remove: z.array(z.any()).optional() },
    propose_reminder: { time: z.string(), days: z.array(z.number()).optional(), text: z.string() },
    remember: { text: z.string(), until: z.string().optional() },
    open_screen: { screen: z.string() },
  };
}

// `deps`: { loadSdk, zod, executable, dataRoot, env, now, timeoutMs, model, mkTemp } (tests hand in a mocked SDK; nothing here calls Claude by itself).
function createClaudeCoach(deps = {}) {
  const loadSdk = deps.loadSdk || loadSdkDefault;
  const zod = deps.zod || (() => require('zod'));
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const model = deps.model === undefined ? MODEL : deps.model;
  const env = () => scrubEnv(deps.env || process.env);
  const executable = () => {
    if (deps.executable !== undefined) return deps.executable;
    try { return require('../lib/agent-chat/claude').executablePath(); } catch { return undefined; }
  };
  const dataRoot = () => {
    if (deps.dataRoot) return deps.dataRoot;
    try { return require('../lib/data-home').paths().root; } catch { return os.tmpdir(); }
  };
  // A new empty folder for one query, removed after it.
  function tempCwd() {
    const base = path.join(dataRoot(), 'tmp');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(base, 'coach-claude-'));
  }
  const removeDir = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

  // ---- Availability ----
  let state = { ready: null, reason: 'checking', at: 0 };
  let probing = null;
  let quotaUntil = 0;
  const set = (ready, reason) => { state = { ready, reason, at: now() }; return state; };
  // The status as known now: { ready: true | false | null (not checked yet), reason }.
  function status() {
    if (quotaUntil > now()) return { ready: false, reason: 'quota' };
    return { ready: state.ready, reason: state.ready ? '' : state.reason };
  }
  // A turn that failed for a reason that says something about the account.
  function noteFailure(reason, resetsAt = 0) {
    if (reason === 'quota') quotaUntil = resetsAt > now() ? resetsAt : now() + QUOTA_PAUSE_MS;
    else if (reason === 'no_sdk' || reason === 'signed_out') set(false, reason);
  }
  function noteSuccess() { quotaUntil = 0; set(true, ''); }
  // Starts Claude Code without running a turn (no request to the model, no quota) and reads its account: signed in or not. Cached.
  async function probe({ force = false } = {}) {
    const fresh = state.at && now() - state.at < (state.ready ? READY_TTL_MS : NOT_READY_TTL_MS);
    if (!force && fresh) return status();
    if (probing) return probing;
    probing = (async () => {
      let sdk;
      try { sdk = await loadSdk(); } catch { return set(false, 'no_sdk'); }
      const cwd = tempCwd();
      const idle = (async function* none() { await new Promise(() => {}); }());
      let query = null;
      let timer = null;
      try {
        const exe = executable();
        query = sdk.query({
          prompt: idle,
          options: { cwd, settingSources: [], tools: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, env: env(), permissionMode: 'dontAsk', ...(exe ? { pathToClaudeCodeExecutable: exe } : {}) },
        });
        const account = await Promise.race([
          query.accountInfo(),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('The check timed out')), deps.probeTimeoutMs || PROBE_TIMEOUT_MS); }),
        ]);
        const signedIn = account && (account.email || account.subscriptionType || account.apiKeySource || account.tokenSource || (account.apiProvider && account.apiProvider !== 'firstParty'));
        return signedIn ? set(true, '') : set(false, 'signed_out');
      } catch (error) {
        const reason = reasonOf(error && error.message);
        return set(false, reason === 'failed' ? 'no_sdk' : reason);
      } finally {
        clearTimeout(timer);
        try { if (query && typeof query.close === 'function') query.close(); } catch { /* closed */ }
        removeDir(cwd);
      }
    })().then(() => status()).finally(() => { probing = null; });
    return probing;
  }

  // ---- One query ----
  // The options of a coach query. `server`: the coach MCP server or null (a fold has no tools).
  function options({ system, cwd, abortController, server, toolNames, maxTurns, builtIns = [] }) {
    const allowed = new Set(toolNames);
    const exe = executable();
    return {
      systemPrompt: system,
      cwd,
      ...(model ? { model } : {}),
      tools: [],
      allowedTools: [...allowed],
      disallowedTools: [...new Set([...BUILT_IN, ...builtIns])],
      mcpServers: server ? { [SERVER]: server } : {},
      strictMcpConfig: true,
      settingSources: [],
      plugins: [],
      skills: [],
      agents: {},
      hooks: {},
      permissionMode: 'dontAsk',
      canUseTool: async (name, input) => (allowed.has(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Only the coach tools may be used here.', interrupt: false }),
      persistSession: false,
      maxTurns,
      thinking: { type: 'disabled' },
      includePartialMessages: true,
      abortController,
      env: env(),
      ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
    };
  }

  // Runs one query to its result. `onText(roundId, piece)`: the streamed answer text, per model request (a round). Returns
  // { rounds: [{ id, text }], usage: { calls, tool_rounds, prompt_tokens, completion_tokens, engine }, text }.
  async function runQuery({ system, prompt, tools = [], onText = null, signal = null, maxTurns = MAX_TURNS, limitMs = timeoutMs }) {
    let sdk;
    try { sdk = await loadSdk(); } catch (error) { noteFailure('no_sdk'); throw new ClaudeUnavailable('no_sdk', error && error.message); }
    const z = tools.length ? zod() : null;
    const toolNames = tools.map(item => `${PREFIX}${item.name}`);
    const server = tools.length ? sdk.createSdkMcpServer({
      name: SERVER, version: '1.0.0',
      tools: tools.map(item => sdk.tool(item.name, item.description, shapes(z)[item.name] || {}, async args => {
        const text = await item.run(args || {});
        return { content: [{ type: 'text', text: String(text) }] };
      })),
    }) : null;
    const cwd = tempCwd();
    const abortController = new AbortController();
    let query = null;
    let why = ''; // 'timeout' | 'cancelled' | 'unsafe'
    const stop = reason => { if (!why) why = reason; abortController.abort(); try { if (query && typeof query.close === 'function') query.close(); } catch { /* closed */ } };
    const onAbort = () => stop('cancelled');
    if (signal) { if (signal.aborted) why = 'cancelled'; else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => stop('timeout'), limitMs);
    const order = [];
    const finals = new Map(); // round id -> text of its complete assistant messages
    const toolRounds = new Set();
    let round = '';
    let result = null;
    let resetsAt = 0;
    let rejected = false;
    try {
      if (why) throw new ClaudeUnavailable('failed');
      query = sdk.query({ prompt, options: options({ system, cwd, abortController, server, toolNames, maxTurns, builtIns: [...(sdk.BUILTIN_TOOL_NAMES || []), ...Object.keys(sdk.LEGACY_TOOL_NAME_ALIASES || {})] }) });
      for await (const message of query) {
        if (!message || message.parent_tool_use_id) continue;
        if (message.type === 'system' && message.subtype === 'init') {
          const extra = (Array.isArray(message.tools) ? message.tools : []).filter(name => !toolNames.includes(name));
          if (extra.length) { console.warn(`Learn coach: Claude offered other tools (${extra.slice(0, 5).join(', ')}); the turn is ended.`); stop('unsafe'); break; }
        } else if (message.type === 'stream_event' && message.event) {
          const event = message.event;
          if (event.type === 'message_start') round = (event.message && event.message.id) || message.uuid || `r${order.length + 1}`;
          else if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta' && event.delta.text) {
            if (!round) round = message.uuid || 'r1';
            if (!order.includes(round)) order.push(round);
            if (onText) onText(round, event.delta.text);
          }
        } else if (message.type === 'assistant' && message.message) {
          const id = message.message.id || round || `r${order.length + 1}`;
          if (!order.includes(id)) order.push(id);
          for (const block of Array.isArray(message.message.content) ? message.message.content : []) {
            if (block.type === 'text' && block.text) finals.set(id, (finals.get(id) || '') + block.text);
            else if (block.type === 'tool_use') toolRounds.add(id);
          }
        } else if (message.type === 'rate_limit_event' && message.rate_limit_info) {
          const info = message.rate_limit_info;
          if (info.status === 'rejected') { rejected = true; resetsAt = info.resetsAt ? info.resetsAt * 1000 : 0; }
        } else if (message.type === 'result') {
          result = message;
          break;
        }
      }
    } catch (error) {
      if (why === 'cancelled') throw Object.assign(new Error('The question was cancelled'), { statusCode: 499 });
      if (why === 'timeout') throw Object.assign(new Error(TOO_SLOW), { statusCode: 504 });
      if (why === 'unsafe') throw new ClaudeUnavailable('unsafe');
      if (error instanceof ClaudeUnavailable) throw error;
      const reason = reasonOf(error && error.message, sdk.USAGE_LIMIT_ERROR_PREFIXES || []);
      noteFailure(reason, resetsAt);
      throw new ClaudeUnavailable(reason, error && error.message);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { if (query && typeof query.close === 'function') query.close(); } catch { /* closed */ }
      removeDir(cwd);
    }
    if (why === 'cancelled') throw Object.assign(new Error('The question was cancelled'), { statusCode: 499 });
    if (why === 'timeout') throw Object.assign(new Error(TOO_SLOW), { statusCode: 504 });
    if (why === 'unsafe') throw new ClaudeUnavailable('unsafe');
    const rounds = order.map(id => ({ id, text: finals.get(id) || '' })).filter(item => item.text);
    const text = rounds.map(item => item.text).join('\n\n');
    // The end of the turn: an error result is an error, unless it only ran out of turns after writing an answer.
    if (!result || (result.is_error && !(result.subtype === 'error_max_turns' && text))) {
      const said = result ? (typeof result.result === 'string' ? result.result : (result.errors || []).join(' ')) || String(result.subtype || '') : 'The agent ended without a result';
      const reason = rejected ? 'quota' : reasonOf(said, sdk.USAGE_LIMIT_ERROR_PREFIXES || []);
      noteFailure(reason, resetsAt);
      throw new ClaudeUnavailable(reason, said);
    }
    noteSuccess();
    const u = result.usage || {};
    const usage = {
      calls: Number.isInteger(result.num_turns) && result.num_turns > 0 ? result.num_turns : Math.max(1, order.length),
      tool_rounds: toolRounds.size,
      prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      completion_tokens: u.output_tokens || 0,
      engine: 'claude',
    };
    return { rounds, text: text || (typeof result.result === 'string' ? result.result : ''), usage };
  }

  // A plain completion (the rolling summary): no tools, one turn.
  async function complete({ system, prompt, signal = null }) {
    const done = await runQuery({ system, prompt, tools: [], signal, maxTurns: 1, limitMs: Math.min(timeoutMs, FOLD_TIMEOUT_MS) });
    return done.text;
  }

  return { status, probe, run: runQuery, complete, noteFailure };
}

module.exports = {
  createClaudeCoach, scrubEnv, reasonOf, ClaudeUnavailable, REASONS, FALLBACK, NO_FALLBACK, TOO_SLOW, SERVER, PREFIX, BUILT_IN, MAX_TURNS, TIMEOUT_MS, MODEL, ENV_SET,
};

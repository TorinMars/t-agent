// Claude Code adapter for the chat mode: turns Claude Agent SDK messages into chat items and runs one turn per prompt.
//
// Items (see services/agent-chat.js): { id, kind: 'user' | 'text' | 'thinking' | 'tool' | 'notice' | 'error', text, name, input, output, status }.
// A streamed block is shown as it arrives under the id `<message id>:<block ordinal>`; the final assistant message upserts the same id, so the
// complete text replaces the partial one without a second pass. Tool calls use the tool_use id, and the matching tool_result fills in the output.
const fs = require('fs');
const path = require('path');

const MODES = {
  ask: { permissionMode: 'default' },
  edits: { permissionMode: 'acceptEdits' },
  plan: { permissionMode: 'plan' },
  full: { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
};
const DEFAULT_MODE = 'ask';
const CAPABILITIES = { models: true };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const CLIP = 20000;
const clip = text => (text.length > CLIP ? `${text.slice(0, CLIP)}\n… (${text.length - CLIP} more characters)` : text);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part && part.type === 'text' ? part.text : part && part.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

// Text of a user message that the person typed (not tool results, not injected context such as local command output).
function userText(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part && part.type === 'text').map(part => part.text).join('\n') : '';
  return /^\s*</.test(text) ? '' : text.trim();
}

// What the person may want to know about a session that has just started: shown collapsed as "Initialized session".
function initItem(message) {
  const servers = (message.mcp_servers || []).map(server => `${server.name}${server.status ? ` (${server.status})` : ''}`).join(', ');
  const rows = [
    ['Model', message.model], ['Working directory', message.cwd], ['Permission mode', message.permissionMode],
    ['Tools', Array.isArray(message.tools) ? String(message.tools.length) : ''], ['MCP servers', servers], ['Session', message.session_id],
  ].filter(([, value]) => value);
  return { id: `init:${message.session_id}`, kind: 'init', text: 'Initialized session', details: rows };
}

// Tokens held by the context window after a request: everything the request carried plus what it answered.
const contextTokens = usage => (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
// The window of the usual models is 200k; a request that held more ran on the 1M variant. A finished turn reports the real size (modelUsage).
const guessWindow = used => (used > 200000 ? 1000000 : 200000);

// `announce`: the turn starts a new session, so its init message is shown.
function createNormalizer(ctx, { announce = false } = {}) {
  let windowSize = 0;
  let usedNow = 0;
  const ordinals = new Map(); // message id -> number of blocks seen so far
  const streaming = new Map(); // `${message id}:${index}` -> kind of the partial block being streamed
  const next = messageId => { const n = ordinals.get(messageId) || 0; ordinals.set(messageId, n + 1); return n; };

  function assistant(message) {
    if (message && message.usage && ctx.setMeta) {
      usedNow = contextTokens(message.usage);
      if (!windowSize || usedNow > windowSize) windowSize = guessWindow(usedNow);
      ctx.setMeta({ model: message.model, context: { used: usedNow, window: windowSize } });
    }
    if (!message || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        ctx.upsert({ id: `${message.id}:${next(message.id)}`, kind: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        ctx.upsert({ id: `${message.id}:${next(message.id)}`, kind: 'thinking', text: block.thinking });
      } else if (block.type === 'tool_use') {
        next(message.id);
        ctx.upsert({ id: block.id, kind: 'tool', name: block.name, input: block.input || {}, output: '', status: 'running' });
      } else {
        next(message.id);
      }
    }
  }

  // A plan window the account is in: five hours or seven days. Utilization arrives as a fraction of the window.
  const WINDOWS = { five_hour: '5h', seven_day: '7d' };
  function limits(info) {
    const label = info && WINDOWS[info.rateLimitType];
    if (!label || !ctx.setMeta || !Number.isFinite(info.utilization)) return;
    ctx.setMeta({ limits: [{ id: label, label, usedPercent: info.utilization * 100, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null }] });
  }

  function user(message) {
    if (!message) return;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue;
        const item = ctx.getItem(block.tool_use_id);
        if (item) ctx.upsert({ ...item, output: clip(resultText(block.content)), status: block.is_error ? 'error' : 'done' });
      }
    }
  }

  function stream(message) {
    const event = message.event;
    const messageId = message.api_message_id;
    if (!event || !messageId || message.parent_tool_use_id) return;
    if (event.type === 'content_block_start' && event.content_block) {
      const kind = event.content_block.type === 'thinking' ? 'thinking' : event.content_block.type === 'text' ? 'text' : null;
      if (!kind) return;
      const id = `${messageId}:${event.index}`;
      streaming.set(id, kind);
      ctx.upsert({ id, kind, text: '' });
    } else if (event.type === 'content_block_delta' && event.delta) {
      const id = `${messageId}:${event.index}`;
      if (!streaming.has(id)) return;
      const text = event.delta.type === 'text_delta' ? event.delta.text : event.delta.type === 'thinking_delta' ? event.delta.thinking : '';
      if (text) ctx.append(id, text);
    }
  }

  return {
    handle(message) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init' && message.session_id) {
            ctx.setSession(message.session_id);
            if (ctx.setMeta && message.model) ctx.setMeta({ model: message.model });
            if (announce) ctx.upsert(initItem(message));
          }
          break;
        case 'stream_event': stream(message); break;
        case 'rate_limit_event': limits(message.rate_limit_info); break;
        case 'assistant': if (!message.parent_tool_use_id) assistant(message.message); break;
        case 'user': if (!message.parent_tool_use_id) user(message.message); break;
        case 'result':
          if (message.session_id) ctx.setSession(message.session_id);
          if (ctx.setMeta && message.modelUsage) {
            const windows = Object.values(message.modelUsage).map(entry => entry && entry.contextWindow).filter(size => size > 0);
            if (windows.length && usedNow) { windowSize = Math.max(...windows); ctx.setMeta({ context: { used: usedNow, window: windowSize } }); }
          }
          return {
            ok: message.subtype === 'success' && !message.is_error,
            error: message.subtype === 'success' ? (message.is_error ? resultText(message.result) || 'The turn failed' : '') : `The turn ended: ${String(message.subtype || 'error').replace(/_/g, ' ')}`,
            cost: message.total_cost_usd,
            usage: message.usage && { input: message.usage.input_tokens, output: message.usage.output_tokens },
          };
        default: break;
      }
      return null;
    },
  };
}

// The prompt as the SDK expects it: a plain string, or one streaming user message when images are attached.
function buildPrompt({ text, images = [] }) {
  if (!images.length) return text;
  const content = [
    ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
    { type: 'text', text },
  ];
  return (async function* single() {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
  }());
}

function executablePath(env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).concat([path.join(env.HOME || '', '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])) {
    if (!dir) continue;
    const file = path.join(dir, 'claude');
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* keep looking */ }
  }
  return undefined; // the SDK falls back to the binary it ships with
}

const loadSdk = () => import('@anthropic-ai/claude-agent-sdk');

// The agent asks the person to choose (AskUserQuestion: up to 4 questions with 2-4 options each, one or several may be picked, and the person
// can always write another answer). The answers go back as `answers`: question text -> the picked labels, several joined with ", ".
async function askQuestions(input, requestPermission) {
  const asked = (Array.isArray(input && input.questions) ? input.questions : []).slice(0, 4);
  const questions = asked.map((entry, index) => ({
    id: String(index), header: String(entry.header || '').slice(0, 40), question: String(entry.question || ''), multiSelect: entry.multiSelect === true, isOther: true, isSecret: false,
    options: (Array.isArray(entry.options) ? entry.options : []).slice(0, 6).map(option => ({
      label: String(option.label || ''), description: String(option.description || ''), ...(option.preview ? { preview: String(option.preview).slice(0, 4000) } : {}),
    })),
  }));
  const answer = await requestPermission({ kind: 'question', tool: 'AskUserQuestion', input: {}, title: 'Claude has a question', description: '', questions });
  if (!answer.allow) return { behavior: 'deny', message: answer.message || 'The person skipped the question' };
  const answers = {};
  for (const [index, entry] of asked.entries()) {
    const value = (answer.answers || {})[String(index)];
    const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value || '');
    if (text) answers[entry.question] = text;
  }
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}

// Plan mode ends when the person approves the plan (ExitPlanMode); declining keeps the agent planning, with what the person wrote as guidance.
async function reviewPlan(input, requestPermission) {
  const plan = typeof (input && input.plan) === 'string' ? input.plan : '';
  const answer = await requestPermission({ kind: 'plan', tool: 'ExitPlanMode', input: {}, plan, title: 'Review the plan', description: '' });
  return answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: answer.message || 'The person wants the plan revised' };
}

const INTERRUPT_GRACE_MS = 3000;

async function runTurn({ cwd, sessionId, mode, prompt, signal, ctx, requestPermission, model, effort, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)();
  const abortController = new AbortController();
  // Stop aborts the query; if Claude Code does not end by itself soon (it can be stuck in a tool), the query is closed, which kills its process.
  let graceTimer = null;
  const onAbort = () => {
    abortController.abort();
    graceTimer = setTimeout(() => { try { if (typeof query.close === 'function') query.close(); } catch { /* already closed */ } }, deps.interruptGraceMs === undefined ? INTERRUPT_GRACE_MS : deps.interruptGraceMs);
  };
  if (signal.aborted) abortController.abort(); else signal.addEventListener('abort', onAbort, { once: true });
  const normalizer = createNormalizer(ctx, { announce: !sessionId });
  const settings = MODES[mode] || MODES[DEFAULT_MODE];
  const query = sdk.query({
    prompt: buildPrompt(prompt),
    options: {
      cwd,
      ...(sessionId ? { resume: sessionId } : {}),
      ...settings,
      ...(model ? { model } : {}),
      ...(EFFORTS.includes(effort) ? { effort } : {}),
      includePartialMessages: true,
      abortController,
      // The same user, project and local settings (CLAUDE.md, permissions, MCP) as the terminal session.
      settingSources: ['user', 'project', 'local'],
      ...(deps.executable !== undefined ? { pathToClaudeCodeExecutable: deps.executable } : (executablePath() ? { pathToClaudeCodeExecutable: executablePath() } : {})),
      canUseTool: async (tool, input, options = {}) => {
        if (tool === 'AskUserQuestion') return askQuestions(input, requestPermission);
        if (tool === 'ExitPlanMode') return reviewPlan(input, requestPermission);
        const answer = await requestPermission({ tool, input, title: options.title || '', description: options.description || '', toolUseId: options.toolUseID });
        return answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: answer.message || 'The person denied this action' };
      },
    },
  });
  let outcome = null;
  try {
    for await (const message of query) {
      const result = normalizer.handle(message);
      if (result) outcome = result;
    }
  } finally {
    clearTimeout(graceTimer);
    signal.removeEventListener('abort', onAbort);
  }
  return outcome || { ok: !signal.aborted, error: signal.aborted ? '' : 'The agent ended without a result' };
}

// The earlier messages of a session, shown when a session from the task directory is opened in chat mode.
async function loadHistory({ cwd, sessionId, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)();
  const rows = await sdk.getSessionMessages(sessionId, { dir: cwd });
  const items = new Map();
  const ctx = {
    upsert: item => items.set(item.id, item),
    append: () => {},
    getItem: id => items.get(id),
    setSession: () => {},
  };
  const normalizer = createNormalizer(ctx);
  for (const row of rows) {
    if (row.type === 'assistant') normalizer.handle({ type: 'assistant', message: row.message });
    else if (row.type === 'user') {
      const text = userText(row.message && row.message.content);
      if (text) items.set(`user:${row.uuid}`, { id: `user:${row.uuid}`, kind: 'user', text });
      normalizer.handle({ type: 'user', message: row.message });
    }
  }
  return [...items.values()];
}

// The models Claude Code offers the account, from a query that never runs a turn: { value, label, description, efforts, defaultEffort }.
async function withIdleQuery(deps, run) {
  const sdk = await (deps.loadSdk || loadSdk)();
  const idle = (async function* none() { await new Promise(() => {}); }());
  const query = sdk.query({
    prompt: idle,
    options: { settingSources: [], ...(deps.executable !== undefined ? { pathToClaudeCodeExecutable: deps.executable } : (executablePath() ? { pathToClaudeCodeExecutable: executablePath() } : {})) },
  });
  try { return await run(query); } finally { query.close(); }
}

async function listModels({ deps = {} } = {}) {
  return withIdleQuery(deps, async query => (await query.supportedModels()).map(row => ({
    value: row.value === 'default' ? '' : row.value, label: row.displayName || row.value, description: row.description || '',
    efforts: row.supportsEffort === false ? [] : (row.supportedEffortLevels || []), defaultEffort: '',
  })));
}

// The plan windows of the account (5 hours, 7 days), read from a query that never runs a turn, so they show before the first message.
// Claude only reports them in a turn when a window is close to its limit. The usage call is marked experimental in the SDK, so any failure
// (an SDK without it, an API-key or third-party account where plan limits do not apply) gives no limits instead of an error.
async function loadLimits({ deps = {} } = {}) {
  return withIdleQuery(deps, async query => {
    if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return [];
    const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const windows = (usage && usage.rate_limits_available && usage.rate_limits) || {};
    return [['five_hour', '5h'], ['seven_day', '7d']].flatMap(([key, label]) => {
      const entry = windows[key];
      if (!entry || !Number.isFinite(entry.utilization)) return [];
      const resetsAt = entry.resets_at ? Date.parse(entry.resets_at) : NaN; // utilization is already a percent here
      return [{ id: label, label, usedPercent: entry.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }];
    });
  });
}

// Starts Claude Code without running a turn and asks what it can do for this account: { models, account } (account: what accountInfo() says,
// {} when it says nothing, which is what a machine that was never logged in does).
async function probe({ deps = {} } = {}) {
  return withIdleQuery(deps, async query => {
    const models = await query.supportedModels();
    let account = {};
    try { account = (await query.accountInfo()) || {}; } catch { /* no account */ }
    return { models: models.length, account };
  });
}

// The model and context use after the latest request of a session, for a chat opened later.
async function loadMeta({ cwd, sessionId, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)();
  const rows = await sdk.getSessionMessages(sessionId, { dir: cwd });
  for (let index = rows.length - 1; index >= 0; index--) {
    const message = rows[index] && rows[index].type === 'assistant' ? rows[index].message : null;
    if (!message || !message.usage) continue;
    const used = contextTokens(message.usage);
    return { model: message.model, context: { used, window: guessWindow(used) } };
  }
  return null;
}

module.exports = { MODES, DEFAULT_MODE, CAPABILITIES, createNormalizer, listModels, loadLimits, probe, buildPrompt, runTurn, loadHistory, loadMeta, userText, resultText };

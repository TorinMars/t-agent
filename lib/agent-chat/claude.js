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

function createNormalizer(ctx) {
  const ordinals = new Map(); // message id -> number of blocks seen so far
  const streaming = new Map(); // `${message id}:${index}` -> kind of the partial block being streamed
  const next = messageId => { const n = ordinals.get(messageId) || 0; ordinals.set(messageId, n + 1); return n; };

  function assistant(message) {
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
          if (message.subtype === 'init' && message.session_id) ctx.setSession(message.session_id);
          break;
        case 'stream_event': stream(message); break;
        case 'assistant': if (!message.parent_tool_use_id) assistant(message.message); break;
        case 'user': if (!message.parent_tool_use_id) user(message.message); break;
        case 'result':
          if (message.session_id) ctx.setSession(message.session_id);
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

async function runTurn({ cwd, sessionId, mode, prompt, signal, ctx, requestPermission, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)();
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal.aborted) abortController.abort(); else signal.addEventListener('abort', onAbort, { once: true });
  const normalizer = createNormalizer(ctx);
  const settings = MODES[mode] || MODES[DEFAULT_MODE];
  const query = sdk.query({
    prompt: buildPrompt(prompt),
    options: {
      cwd,
      ...(sessionId ? { resume: sessionId } : {}),
      ...settings,
      includePartialMessages: true,
      abortController,
      // The same user, project and local settings (CLAUDE.md, permissions, MCP) as the terminal session.
      settingSources: ['user', 'project', 'local'],
      // Questions to the person are not supported in this view; the agent is told to ask in plain text instead.
      disallowedTools: ['AskUserQuestion'],
      ...(deps.executable !== undefined ? { pathToClaudeCodeExecutable: deps.executable } : (executablePath() ? { pathToClaudeCodeExecutable: executablePath() } : {})),
      canUseTool: async (tool, input, options = {}) => {
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

module.exports = { MODES, DEFAULT_MODE, createNormalizer, buildPrompt, runTurn, loadHistory, userText, resultText };

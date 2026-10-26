// Codex adapter for the chat mode: turns Codex SDK thread events into chat items and runs one turn per prompt.
// The Codex SDK runs `codex exec`, which has no interactive approval step, so the access level is chosen up front through the sandbox mode.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = {
  readonly: { sandboxMode: 'read-only' },
  write: { sandboxMode: 'workspace-write' },
  full: { sandboxMode: 'danger-full-access' },
};
const DEFAULT_MODE = 'write';

const CLIP = 20000;
const clip = text => (text.length > CLIP ? `${text.slice(0, CLIP)}\n… (${text.length - CLIP} more characters)` : text);
const STATUS = { in_progress: 'running', completed: 'done', failed: 'error' };

function itemFor(raw) {
  switch (raw.type) {
    case 'agent_message': return { id: raw.id, kind: 'text', text: raw.text || '' };
    case 'reasoning': return raw.text ? { id: raw.id, kind: 'thinking', text: raw.text } : null;
    case 'command_execution': {
      const status = STATUS[raw.status] || 'done';
      return { id: raw.id, kind: 'tool', name: 'Shell', input: { command: raw.command }, output: clip(raw.aggregated_output || ''), status: status === 'done' && raw.exit_code ? 'error' : status };
    }
    case 'file_change':
      return { id: raw.id, kind: 'tool', name: 'Edit files', input: { changes: raw.changes }, output: (raw.changes || []).map(change => `${change.kind} ${change.path}`).join('\n'), status: STATUS[raw.status] || 'done' };
    case 'mcp_tool_call': {
      const output = raw.error ? raw.error.message : (raw.result && Array.isArray(raw.result.content) ? raw.result.content.map(part => part.text || '').filter(Boolean).join('\n') : '');
      return { id: raw.id, kind: 'tool', name: `${raw.server}: ${raw.tool}`, input: raw.arguments || {}, output: clip(output), status: raw.error ? 'error' : (STATUS[raw.status] || 'done') };
    }
    case 'web_search': return { id: raw.id, kind: 'tool', name: 'Web search', input: { query: raw.query }, output: '', status: 'done' };
    case 'todo_list':
      return { id: raw.id, kind: 'tool', name: 'Plan', input: {}, output: (raw.items || []).map(entry => `${entry.completed ? '[x]' : '[ ]'} ${entry.text}`).join('\n'), status: 'done' };
    case 'error': return { id: raw.id, kind: 'error', text: raw.message || 'Codex reported an error' };
    default: return null;
  }
}

function createNormalizer(ctx) {
  return {
    handle(event) {
      switch (event.type) {
        case 'thread.started': ctx.setSession(event.thread_id); break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = itemFor(event.item);
          if (item) ctx.upsert(item);
          break;
        }
        case 'turn.completed':
          return { ok: true, error: '', usage: event.usage && { input: event.usage.input_tokens, output: event.usage.output_tokens } };
        case 'turn.failed':
          return { ok: false, error: (event.error && event.error.message) || 'The turn failed' };
        case 'error':
          return { ok: false, error: event.message || 'Codex reported an error' };
        default: break;
      }
      return null;
    },
  };
}

// Images are passed to Codex as files; they are written to a temporary directory and removed when the turn ends.
function writeImages(images) {
  if (!images.length) return { inputs: [], cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-'));
  const inputs = images.map((image, index) => {
    const file = path.join(dir, `image-${index}.${image.mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    return { type: 'local_image', path: file };
  });
  return { inputs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const loadSdk = () => import('@openai/codex-sdk');

async function runTurn({ cwd, sessionId, mode, prompt, signal, ctx, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)();
  const codex = new sdk.Codex();
  const options = { workingDirectory: cwd, skipGitRepoCheck: true, approvalPolicy: 'never', ...(MODES[mode] || MODES[DEFAULT_MODE]) };
  const thread = sessionId ? codex.resumeThread(sessionId, options) : codex.startThread(options);
  const { inputs, cleanup } = writeImages(prompt.images || []);
  const normalizer = createNormalizer(ctx);
  let outcome = null;
  try {
    const input = inputs.length ? [{ type: 'text', text: prompt.text }, ...inputs] : prompt.text;
    const { events } = await thread.runStreamed(input, { signal });
    for await (const event of events) {
      const result = normalizer.handle(event);
      if (result) outcome = result;
    }
    if (thread.id) ctx.setSession(thread.id);
  } finally {
    cleanup();
  }
  return outcome || { ok: !signal.aborted, error: signal.aborted ? '' : 'The agent ended without a result' };
}

// ── History of an existing session, read from its rollout file ──
function findRollout(sessionId, home = os.homedir()) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) walk(full, depth - 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`${sessionId}.jsonl`)) found.push(full);
    }
  };
  walk(path.join(home, '.codex', 'sessions'), 3);
  return found[0] || null;
}

// Context the CLI injects before the first prompt (environment block, AGENTS.md instructions) is not something the person wrote.
const injected = text => /^\s*</.test(text) || /^#\s*AGENTS\.md instructions/.test(text) || text.includes('<INSTRUCTIONS>');

function historyFromRollout(file) {
  const items = new Map();
  const calls = new Map();
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  let n = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row.type === 'response_item' && row.payload;
    if (!payload) continue;
    const id = `h${n++}`;
    const text = Array.isArray(payload.content) ? payload.content.map(part => part.text || '').join('\n').trim() : '';
    if (payload.type === 'message' && text && !injected(text)) {
      if (payload.role === 'user') items.set(id, { id, kind: 'user', text });
      else if (payload.role === 'assistant') items.set(id, { id, kind: 'text', text });
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      let input = payload.arguments || payload.input || {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
      const item = { id, kind: 'tool', name: payload.name === 'shell' || payload.name === 'exec_command' ? 'Shell' : payload.name, input, output: '', status: 'done' };
      items.set(id, item);
      calls.set(payload.call_id, id);
    } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && calls.has(payload.call_id)) {
      const target = items.get(calls.get(payload.call_id));
      let output = payload.output;
      if (output && typeof output === 'object') output = output.output || JSON.stringify(output);
      target.output = clip(String(output || ''));
    }
  }
  return [...items.values()];
}

async function loadHistory({ sessionId, home }) {
  const file = findRollout(sessionId, home);
  return file ? historyFromRollout(file) : [];
}

module.exports = { MODES, DEFAULT_MODE, createNormalizer, runTurn, loadHistory, findRollout, historyFromRollout };

#!/usr/bin/env node
// `t-agent-peers`: a small MCP server (stdio, JSON-RPC 2.0, one JSON message per line) that the Claude Code and Codex
// sessions of a T-Agent terminal get (routes/terminal.js, "Peer file access" in DESIGN.md). Its tools let the agent see
// the other T-Agent Engines linked to this one and READ their files; nothing can be written. Every call goes to this
// Engine's local relay (`/api/peer-fs/*`), which forwards it to the Engine named in the call.
//
// Environment (set by routes/terminal.js in the terminal's PTY and passed on by Claude / Codex):
//   TA_PEER_URL       the relay, e.g. http://127.0.0.1:3000/api/peer-fs
//   TA_PEER_TASK      the task of the terminal          (header X-T-Agent-Task)
//   TA_PEER_TERMINAL  the terminal                      (header X-T-Agent-Terminal)
//   TA_HOOK_TOKEN     that terminal's hook token        (header X-T-Agent-Token)
//   TA_PEER_TIMEOUT_MS / TA_PEER_SEARCH_TIMEOUT_MS  optional, the relay timeouts (default 10 s, and 30 s for search)
// stdout carries only protocol messages; anything else goes to stderr.

const SERVER_INFO = { name: 't-agent-peers', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const env = process.env;
const timeoutOf = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};
const TIMEOUT_MS = timeoutOf(env.TA_PEER_TIMEOUT_MS, 10000);
const SEARCH_TIMEOUT_MS = timeoutOf(env.TA_PEER_SEARCH_TIMEOUT_MS, 30000);

const INSTRUCTIONS = 'This T-Agent is linked to other computers ("Engines", often named like K01 or after their owner). '
  + 'When the user mentions another machine by name, or asks about files, code, logs or tasks that live on another computer, '
  + 'call list_engines first, then list_dir, read_file and search with that engine\'s name. Access is read-only, limited to the '
  + 'home folder of that computer, and sensitive files (such as ~/.ssh or .env files) are left out.';

const engineArg = { type: 'string', description: 'The engine to read from: its name as list_engines shows it (for example "K01"), or its id.' };
const TOOLS = [
  {
    name: 'list_engines',
    title: 'List linked computers',
    description: 'List the OTHER computers (T-Agent "Engines") linked to this T-Agent, with their names (often like K01), whether they are online, '
      + 'their home folder, platform, and the tasks on them (title and working directory). Use this first whenever the user mentions '
      + 'another machine or computer by name, or wants to look at code, files, logs or results on another computer, or compare something '
      + 'with another machine. Files on these computers can only be read (list_dir, read_file, search), never changed. Only the home '
      + 'folder is reachable, and sensitive files such as ~/.ssh or .env files are left out.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List linked computers', ...READ_ONLY },
  },
  {
    name: 'list_dir',
    title: 'List a folder on a linked computer',
    description: 'List the entries (files and folders, with size and modification time) of a folder on another computer linked to this '
      + 'T-Agent. Read-only. Use the engine name from list_engines; a task\'s work_dir there is a good place to start. Without a path the '
      + 'home folder of that computer is listed. A path can be absolute or start with ~/.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: engineArg,
        path: { type: 'string', description: 'The folder to list (absolute, or relative to the home folder, or starting with ~/). Default: the home folder.' },
      },
      required: ['engine'],
      additionalProperties: false,
    },
    annotations: { title: 'List a folder on a linked computer', ...READ_ONLY },
  },
  {
    name: 'read_file',
    title: 'Read a file on a linked computer',
    description: 'Read a text file on another computer linked to this T-Agent. Read-only. A large file comes in parts: when the answer says '
      + 'it was cut, call again with the offset it gives to read the next part. Binary files cannot be read.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: engineArg,
        path: { type: 'string', description: 'The file to read (absolute, or relative to the home folder, or starting with ~/).' },
        offset: { type: 'integer', minimum: 0, description: 'Where to start reading, in bytes from the start of the file. Default 0.' },
        limit: { type: 'integer', minimum: 1, description: 'The most bytes to read in this call (at most 1 MiB; more is cut to that). Default: the engine\'s own limit.' },
      },
      required: ['engine', 'path'],
      additionalProperties: false,
    },
    annotations: { title: 'Read a file on a linked computer', ...READ_ONLY },
  },
  {
    name: 'search',
    title: 'Search files on a linked computer',
    description: 'Search the text of the files under a folder on another computer linked to this T-Agent, like grep: answers the matching '
      + 'lines with their file and line number. Read-only. Narrow it with glob (for example "*.js") and a folder close to what you need; '
      + 'searching a whole home folder can be slow and is cut off.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: engineArg,
        path: { type: 'string', description: 'The folder (or one file) to search in (absolute, or relative to the home folder, or starting with ~/).' },
        pattern: { type: 'string', description: 'The text to look for (plain text unless regex is true).' },
        glob: { type: 'string', description: 'Only search files whose name matches this glob, for example "*.py" or "*.{ts,tsx}".' },
        ignore_case: { type: 'boolean', description: 'Match without regard to upper and lower case. Default false.' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default false.' },
      },
      required: ['engine', 'path', 'pattern'],
      additionalProperties: false,
    },
    annotations: { title: 'Search files on a linked computer', ...READ_ONLY },
  },
];

// The sentence for the agent for each error code of the relay (its own `message` is added when it sent one).
const ERROR_TEXT = {
  PATH_NOT_ALLOWED: 'This path cannot be read: only the home folder of that computer is reachable, and sensitive files and folders (such as ~/.ssh, keys and .env files) are left out.',
  PEER_FS_DISABLED: 'Reading files of linked computers is switched off (in T-Agent Settings, on this computer or on that one).',
  ENGINE_NOT_FOUND: 'There is no linked computer with that name or id. Call list_engines to see the names.',
  NOT_FOUND: 'That file or folder does not exist on that computer.',
  PEER_FS_UNSUPPORTED: 'That computer runs an older T-Agent that cannot share its files yet.',
  ENGINE_OFFLINE: 'That computer is offline (or cannot be reached) right now. Try again later.',
  BINARY_FILE: 'That is a binary file; only text files can be read.',
  IS_DIRECTORY: 'That path is a folder, not a file. Use list_dir for folders.',
  NOT_A_DIRECTORY: 'That path is a file, not a folder. Use read_file for files.',
  NOT_A_REGULAR_FILE: 'That path is not a regular file (a device, socket or pipe) and cannot be read.',
  PERMISSION_DENIED: 'That computer does not allow reading this path (no permission for the T-Agent user there).',
  INVALID_ARGUMENT: 'An argument of the call is not valid.',
  ENGINE_REQUIRED: 'Name the engine to read from (engine: its name from list_engines).',
  ENGINE_UNAUTHORIZED: 'That computer did not accept this T-Agent\'s link any more (it was unlinked or its token revoked there).',
  PEER_FS_READ_FAILED: 'That computer could not read the path.',
  READ_TIMEOUT: 'That computer took too long to read it. For search, try a narrower folder or a glob.',
  TIMEOUT: 'The linked computer did not answer in time.',
  NOT_CONFIGURED: 'Linked computers are not available in this session (it was not started by T-Agent with file access to linked computers switched on). A new session started from T-Agent gets them.',
  UNREACHABLE: 'The local T-Agent service could not be reached. It may have been restarted; a new session gets a fresh connection.',
  PEER_FS_AUTH_REQUIRED: 'The local T-Agent service did not get this session\'s identity (the session was not started by a T-Agent terminal with file access to linked computers).',
  PEER_FS_AUTH_INVALID: 'The local T-Agent service did not accept this session (it was restarted, or the terminal or task was closed). A new session started from T-Agent works again.',
  UNAUTHORIZED: 'The local T-Agent service did not accept this session (it was restarted, or the terminal was closed). A new session started from T-Agent works again.',
};

class ToolError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function relay(route, query, timeoutMs) {
  const base = String(env.TA_PEER_URL || '').replace(/\/+$/, '');
  if (!base || !env.TA_HOOK_TOKEN) throw new ToolError('NOT_CONFIGURED');
  const url = new URL(`${base}/${route}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-T-Agent-Task': String(env.TA_PEER_TASK || ''),
        'X-T-Agent-Terminal': String(env.TA_PEER_TERMINAL || ''),
        'X-T-Agent-Token': String(env.TA_HOOK_TOKEN || ''),
      },
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new ToolError('TIMEOUT', `No answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new ToolError('UNREACHABLE', error && error.message);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    const code = data && typeof data.error === 'string' ? data.error : response.status === 401 ? 'UNAUTHORIZED' : `HTTP_${response.status}`;
    const message = data && typeof data.message === 'string' ? data.message : '';
    throw new ToolError(code, message);
  }
  if (!data || typeof data !== 'object') throw new ToolError('BAD_ANSWER', 'The relay answered something that is not JSON.');
  return data;
}

const required = (args, key) => {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolError('INVALID_ARGUMENT', `"${key}" is required.`);
  return value;
};
const optionalInt = (args, key, min) => {
  if (args[key] === undefined || args[key] === null) return undefined;
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < min) throw new ToolError('INVALID_ARGUMENT', `"${key}" must be a whole number of at least ${min}.`);
  return value;
};
const flag = value => (value === true || value === 'true' ? 'true' : undefined);
const sizeText = size => {
  if (typeof size !== 'number' || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
};
const timeText = mtime => {
  if (mtime === undefined || mtime === null || mtime === '') return '';
  const date = new Date(typeof mtime === 'number' && mtime < 1e12 ? mtime * 1000 : mtime);
  return Number.isNaN(date.getTime()) ? String(mtime) : date.toISOString().replace(/\.\d+Z$/, 'Z');
};

async function listEngines() {
  const data = await relay('engines', {}, TIMEOUT_MS);
  const engines = Array.isArray(data.engines) ? data.engines : [];
  if (!engines.length) return 'No other computers are linked to this T-Agent.';
  const lines = [`${engines.length} linked computer${engines.length === 1 ? '' : 's'} (files are read-only):`];
  for (const engine of engines) {
    const state = [engine.online ? 'online' : 'offline'];
    if (engine.supported === false) state.push('older T-Agent: file access not supported');
    if (engine.disabled) state.push('file access switched off there');
    if (engine.error && engine.error !== 'ENGINE_OFFLINE' && engine.error !== 'PEER_FS_UNSUPPORTED') state.push(engine.error === 'ENGINE_UNAUTHORIZED' ? 'the link is not accepted there any more' : `error ${engine.error}`);
    lines.push('', `- ${engine.name || engine.id} (id ${engine.id}): ${state.join(', ')}`);
    if (engine.platform) lines.push(`  platform: ${engine.platform}`);
    if (engine.home) lines.push(`  home: ${engine.home}`);
    const tasks = Array.isArray(engine.tasks) ? engine.tasks : [];
    if (tasks.length) {
      lines.push('  tasks:');
      for (const task of tasks) lines.push(`    - ${task.title || `task ${task.id}`}${task.work_dir ? ` (work_dir: ${task.work_dir})` : ''}`);
    }
  }
  lines.push('', 'Use list_dir, read_file or search with engine set to one of these names.');
  return lines.join('\n');
}

async function listDir(args) {
  const engine = required(args, 'engine');
  const data = await relay('list', { engine, path: typeof args.path === 'string' ? args.path : undefined }, TIMEOUT_MS);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const lines = [`${data.path || args.path || '~'} on ${engine}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`];
  for (const entry of entries) {
    const dir = entry.type === 'dir' || entry.type === 'directory';
    const kind = dir ? 'dir ' : entry.type === 'symlink' ? 'link' : entry.type === 'file' || !entry.type ? 'file' : String(entry.type).slice(0, 4);
    const details = [dir ? '' : sizeText(entry.size), timeText(entry.mtime)].filter(Boolean).join('  ');
    lines.push(`${kind}  ${entry.name}${dir ? '/' : ''}${details ? `  ${details}` : ''}`);
  }
  if (data.truncated) lines.push('(The list was cut off; not every entry is shown.)');
  return lines.join('\n');
}

async function readFile(args) {
  const engine = required(args, 'engine');
  const filePath = required(args, 'path');
  const offset = optionalInt(args, 'offset', 0);
  const limit = optionalInt(args, 'limit', 1);
  const data = await relay('read', { engine, path: filePath, offset, limit }, TIMEOUT_MS);
  const content = typeof data.content === 'string' ? data.content : '';
  const start = Number.isInteger(data.offset) ? data.offset : offset || 0;
  const read = start + Buffer.byteLength(content, 'utf8');
  // The relay's next_offset says where the next part starts (it may stop before a UTF-8 character that was split), null when the
  // file is done; an answer without it falls back to the bytes received.
  const next = Number.isInteger(data.next_offset) ? data.next_offset
    : data.next_offset === null ? null
      : data.truncated ? read : null;
  const size = Number.isFinite(data.size) ? data.size : null;
  const header = [`${data.path || filePath} on ${engine}`];
  if (size !== null) header.push(`${size} bytes`);
  if (start > 0 || next !== null) header.push(`bytes ${start}-${next !== null ? next : read}`);
  if (data.encoding && data.encoding !== 'utf8' && data.encoding !== 'utf-8') header.push(`encoding ${data.encoding}`);
  let text = `[${header.join(', ')}]\n${content}`;
  if (next !== null) text += `${content.endsWith('\n') ? '' : '\n'}[Cut off at byte ${next}${size !== null ? ` of ${size}` : ''}. Call read_file again with offset ${next} to read the next part.]`;
  return text;
}

async function search(args) {
  const engine = required(args, 'engine');
  const where = required(args, 'path');
  const pattern = required(args, 'pattern');
  const data = await relay('search', {
    engine, path: where, pattern,
    glob: typeof args.glob === 'string' ? args.glob : undefined,
    ignore_case: flag(args.ignore_case),
    regex: flag(args.regex),
  }, SEARCH_TIMEOUT_MS);
  const matches = Array.isArray(data.matches) ? data.matches : [];
  if (!matches.length) return `No matches for ${JSON.stringify(pattern)} under ${where} on ${engine}.${data.truncated ? ' (The search was cut off before it finished; try a narrower folder or a glob.)' : ''}`;
  const lines = [`${matches.length} match${matches.length === 1 ? '' : 'es'} for ${JSON.stringify(pattern)} under ${where} on ${engine}:`];
  for (const match of matches) lines.push(`${match.path}:${match.line}: ${match.text}`);
  if (data.truncated) lines.push('(Cut off: there are more matches. Narrow the folder, the pattern or the glob.)');
  return lines.join('\n');
}

const HANDLERS = { list_engines: listEngines, list_dir: listDir, read_file: readFile, search };

async function callTool(params) {
  const name = params && params.name;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, name)) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  try {
    return { content: [{ type: 'text', text: await HANDLERS[name](args) }] };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const known = ERROR_TEXT[error.code];
    const detail = error.message && error.message !== error.code && error.message !== known ? error.message : '';
    const text = `${known || `The request failed (${error.code}).`}${detail ? ` (${detail})` : ''}`;
    return { content: [{ type: 'text', text: `Error ${error.code}: ${text}` }], isError: true };
  }
}

async function handle(message) {
  const { method, params } = message;
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call': return callTool(params);
    default: throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

const send = message => { process.stdout.write(`${JSON.stringify(message)}\n`); };

// One message: a request gets one answer; a notification (no id) gets none.
async function answer(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: message && message.id !== undefined ? message.id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isRequest = message.id !== undefined && message.id !== null;
  if (typeof message.method !== 'string') return isRequest ? { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid Request' } } : null; // a response to us: ignored
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...
  try {
    return { jsonrpc: '2.0', id: message.id, result: await handle(message) };
  } catch (error) {
    if (!error.rpcCode) console.error('[t-agent-peers]', error && error.stack ? error.stack : error);
    return { jsonrpc: '2.0', id: message.id, error: { code: error.rpcCode || -32603, message: error.rpcCode ? error.message : 'Internal error' } };
  }
}

async function onLine(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(message)) { // a JSON-RPC batch (allowed by the 2025-03-26 protocol)
    if (!message.length) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); return; }
    const replies = (await Promise.all(message.map(answer))).filter(Boolean);
    if (replies.length) send(replies);
    return;
  }
  const reply = await answer(message);
  if (reply) send(reply);
}

function main() {
  let buffered = '';
  const pending = new Set();
  const track = promise => { pending.add(promise); promise.catch(() => {}).then(() => pending.delete(promise)); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).replace(/\r$/, '');
      buffered = buffered.slice(index + 1);
      track(onLine(line));
    }
  });
  process.stdin.on('end', async () => {
    if (buffered.trim()) track(onLine(buffered));
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
  process.stdout.on('error', () => process.exit(0)); // the client went away
}

if (require.main === module) main();

module.exports = { TOOLS, PROTOCOL_VERSIONS, handle, answer };

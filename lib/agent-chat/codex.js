// Codex adapter for the chat mode, on top of `codex app-server` (lib/agent-chat/codex-app-server.js).
//
// One app-server process serves one turn: it starts or resumes the thread, starts the turn, turns the notifications into chat items and
// answers the requests Codex sends back while it works (command / file / permission approvals, questions to the person, MCP elicitations).
// While the turn runs the person can add input to it (`turn/steer`) or stop it (`turn/interrupt`).
//
// Items (see services/agent-chat.js): { id, kind: 'user' | 'text' | 'thinking' | 'tool' | 'notice' | 'error', text, name, input, output, status }.
// Item ids are prefixed with the turn id because Codex numbers items per turn.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppServerClient, executablePath } = require('./codex-app-server');

// The access level sets the sandbox; Codex asks when it needs to go beyond it (approvalPolicy "on-request"). The person answers in the chat
// even when the machine's Codex configuration routes approvals to an automatic reviewer (`approvals_reviewer`).
const MODES = {
  readonly: { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  write: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  full: { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' },
};
const DEFAULT_MODE = 'write';
// What the service may offer on a running conversation.
const CAPABILITIES = { steer: true, questions: true };

const CLIP = 20000;
const DIFF_CLIP = 4000;
const INTERRUPT_GRACE_MS = 4000;
const clip = (text, length = CLIP) => (text.length > length ? `${text.slice(0, length)}\n… (${text.length - length} more characters)` : text);
const STATUS = { inProgress: 'running', completed: 'done', failed: 'error', declined: 'error' };

const contentText = content => (Array.isArray(content)
  ? content.map(part => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
  : '');

function itemFor(raw, turnId) {
  const id = `${turnId}:${raw.id}`;
  switch (raw.type) {
    case 'agentMessage': return { id, kind: 'text', text: raw.text || '' };
    case 'reasoning': return { id, kind: 'thinking', text: [...(raw.summary && raw.summary.length ? raw.summary : raw.content || [])].join('\n\n') };
    case 'commandExecution': {
      const status = STATUS[raw.status] || 'done';
      const output = raw.status === 'declined' && !raw.aggregatedOutput ? 'Declined' : raw.aggregatedOutput || '';
      return { id, kind: 'tool', name: 'Shell', input: { command: raw.command, cwd: raw.cwd }, output: clip(output), status: status === 'done' && raw.exitCode ? 'error' : status };
    }
    case 'fileChange': {
      const changes = (raw.changes || []).map(change => ({ path: change.path, kind: change.kind && change.kind.type, diff: clip(change.diff || '', DIFF_CLIP) }));
      return { id, kind: 'tool', name: 'Edit files', input: { changes }, output: changes.map(change => `${change.kind} ${change.path}`).join('\n'), status: STATUS[raw.status] || 'done' };
    }
    case 'mcpToolCall': {
      const result = raw.result && contentText(raw.result.content);
      return { id, kind: 'tool', name: `${raw.server}: ${raw.tool}`, input: raw.arguments || {}, output: clip(raw.error ? raw.error.message : result || ''), status: raw.error ? 'error' : (STATUS[raw.status] || 'done') };
    }
    case 'dynamicToolCall':
      return { id, kind: 'tool', name: raw.namespace ? `${raw.namespace}: ${raw.tool}` : raw.tool, input: raw.arguments || {}, output: clip(contentText(raw.contentItems)), status: raw.success === false ? 'error' : (STATUS[raw.status] || 'done') };
    case 'webSearch': return { id, kind: 'tool', name: 'Web search', input: { query: raw.query || (raw.action && raw.action.query) || '' }, output: '', status: 'done' };
    case 'plan': return { id, kind: 'tool', name: 'Plan', input: {}, output: raw.text || '', status: 'done' };
    case 'imageView': return { id, kind: 'tool', name: 'View image', input: { path: raw.path }, output: '', status: 'done' };
    case 'collabAgentToolCall': return { id, kind: 'tool', name: 'Sub-agent', input: { tool: raw.tool }, output: '', status: STATUS[raw.status] || 'done' };
    case 'contextCompaction': return { id, kind: 'notice', text: 'The conversation context was compacted' };
    default: return null; // userMessage (the service shows what the person sent), hooks, review markers ...
  }
}

const planText = plan => (plan || []).map(entry => `${entry.status === 'completed' ? '[x]' : entry.status === 'inProgress' ? '[~]' : '[ ]'} ${entry.step}`).join('\n');

// Turns app-server notifications into items. `handle` returns the outcome of the turn once it has completed, otherwise null.
function createNormalizer(ctx) {
  let usage = null;
  let warnings = 0;
  const grow = (id, text, field) => {
    const item = ctx.getItem(id);
    if (!item || !text) return false;
    if (field === 'text') ctx.append(id, text);
    else ctx.upsert({ ...item, [field]: clip((item[field] || '') + text) });
    return true;
  };
  return {
    handle(method, params) {
      switch (method) {
        case 'item/started':
        case 'item/completed': {
          const item = itemFor(params.item, params.turnId);
          if (!item) break;
          // A finished item carries the full content; a started one only what is known so far.
          if (method === 'item/started' && ctx.getItem(item.id)) break;
          ctx.upsert(item);
          break;
        }
        case 'item/agentMessage/delta': grow(`${params.turnId}:${params.itemId}`, params.delta, 'text'); break;
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta': {
          const id = `${params.turnId}:${params.itemId}`;
          const item = ctx.getItem(id);
          // Summary parts and raw reasoning are both streamed; show the summary when there is one.
          if (!item || (method === 'item/reasoning/textDelta' && item.summaryStreamed)) break;
          if (method === 'item/reasoning/summaryTextDelta') item.summaryStreamed = true;
          ctx.append(id, params.delta);
          break;
        }
        case 'item/reasoning/summaryPartAdded': {
          const item = ctx.getItem(`${params.turnId}:${params.itemId}`);
          if (item && item.text) ctx.append(item.id, '\n\n');
          break;
        }
        case 'item/commandExecution/outputDelta': grow(`${params.turnId}:${params.itemId}`, params.delta, 'output'); break;
        case 'turn/plan/updated':
          ctx.upsert({ id: `${params.turnId}:plan`, kind: 'tool', name: 'Plan', input: {}, output: [params.explanation, planText(params.plan)].filter(Boolean).join('\n'), status: 'done' });
          break;
        case 'thread/tokenUsage/updated': {
          const last = params.tokenUsage && params.tokenUsage.last;
          if (last) usage = { input: last.inputTokens, output: last.outputTokens };
          break;
        }
        case 'warning':
          ctx.upsert({ id: `warning-${warnings++}`, kind: 'notice', text: params.message || 'Codex reported a warning' });
          break;
        case 'turn/completed': {
          const turn = params.turn || {};
          if (turn.status === 'failed') return { ok: false, error: (turn.error && turn.error.message) || 'The turn failed', usage };
          if (turn.status === 'interrupted') return { ok: false, error: '', usage };
          return { ok: true, error: '', usage };
        }
        default: break;
      }
      return null;
    },
  };
}

// Images are passed to Codex as files; they are written to a temporary directory that is removed when the turn ends.
function imageFiles() {
  let dir = null;
  let count = 0;
  return {
    add(images = []) {
      return images.map(image => {
        if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-chat-'));
        const file = path.join(dir, `image-${count++}.${image.mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
        fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
        return { type: 'localImage', path: file };
      });
    },
    cleanup() { if (dir) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const userInput = (prompt, files) => [{ type: 'text', text: prompt.text, text_elements: [] }, ...files.add(prompt.images)];

// ── Requests from Codex ──
// The answer {allow, remember, answers} comes from the person through ctx / requestPermission (services/agent-chat.js).
const approval = (answer, remember = 'acceptForSession') => (answer.allow ? (answer.remember ? remember : 'accept') : 'decline');

// The fields of an MCP form, shown as questions.
function formQuestions(schema) {
  const properties = schema && typeof schema.properties === 'object' && schema.properties ? schema.properties : {};
  return Object.entries(properties).slice(0, 10).map(([id, spec]) => {
    const labels = Array.isArray(spec.enum) ? spec.enum.map(String)
      : Array.isArray(spec.oneOf) ? spec.oneOf.map(option => String(option.title || option.const))
        : spec.type === 'boolean' ? ['true', 'false'] : null;
    return { id, header: spec.title || id, question: spec.description || spec.title || id, isOther: !labels, isSecret: false, options: labels && labels.map(label => ({ label, description: '' })), type: spec.type };
  });
}

function formContent(questions, answers = {}) {
  const content = {};
  for (const question of questions) {
    const raw = [].concat(answers[question.id] === undefined ? [] : answers[question.id])[0];
    if (raw === undefined || raw === '') continue;
    if (question.type === 'boolean') content[question.id] = raw === true || raw === 'true';
    else if (question.type === 'number' || question.type === 'integer') { const number = Number(raw); if (Number.isFinite(number)) content[question.id] = number; }
    else content[question.id] = String(raw);
  }
  return content;
}

async function answerRequest(method, params, { ctx, requestPermission }) {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const answer = await requestPermission({
        tool: 'Shell', input: { command: params.command, cwd: params.cwd }, canRemember: true,
        title: params.reason || 'Run this command?', description: [params.reason, params.command].filter(Boolean).join('\n'),
      });
      return { decision: approval(answer) };
    }
    case 'item/fileChange/requestApproval': {
      const item = ctx.getItem(`${params.turnId}:${params.itemId}`);
      const answer = await requestPermission({
        tool: 'Edit files', input: item ? item.input : {}, canRemember: true,
        title: params.reason || 'Apply these file changes?', description: [params.reason, params.grantRoot && `Write access to ${params.grantRoot}`].filter(Boolean).join('\n'),
      });
      return { decision: approval(answer) };
    }
    case 'item/permissions/requestApproval': {
      const answer = await requestPermission({
        tool: 'Permissions', input: params.permissions || {}, canRemember: true,
        title: 'Grant extra permissions?', description: [params.reason, params.cwd].filter(Boolean).join('\n'),
      });
      if (!answer.allow) return { permissions: {}, scope: 'turn' };
      const granted = {};
      for (const key of ['network', 'fileSystem']) if (params.permissions && params.permissions[key]) granted[key] = params.permissions[key];
      return { permissions: granted, scope: answer.remember ? 'session' : 'turn' };
    }
    case 'item/tool/requestUserInput': {
      const questions = (params.questions || []).map(({ id, header, question, options, isOther, isSecret }) => ({ id, header, question, options, isOther, isSecret }));
      const answer = await requestPermission({ kind: 'question', tool: 'Question', input: {}, title: 'Codex has a question', description: '', questions });
      const answers = {};
      if (answer.allow) for (const [id, value] of Object.entries(answer.answers || {})) answers[id] = { answers: [].concat(value).map(String) };
      return { answers };
    }
    case 'mcpServer/elicitation/request': {
      const form = params.mode !== 'url' && params.requestedSchema;
      const questions = form ? formQuestions(params.requestedSchema) : [];
      const answer = await requestPermission({
        kind: questions.length ? 'question' : 'approval', tool: `${params.serverName} asks`, input: params.url ? { url: params.url } : {},
        title: params.message || `${params.serverName} needs your input`, description: params.url || '', questions,
      });
      if (!answer.allow) return { action: 'decline', content: null, _meta: null };
      return { action: 'accept', content: questions.length ? formContent(questions, answer.answers) : null, _meta: null };
    }
    case 'item/tool/call':
      return { contentItems: [{ type: 'inputText', text: 'Dynamic tools are not available in T-Agent chat' }], success: false };
    default:
      throw Object.assign(new Error(`Unsupported request: ${method}`), { code: -32601 });
  }
}

async function runTurn({ cwd, sessionId, mode, prompt, signal, ctx, requestPermission, deps = {} }) {
  const command = deps.executable !== undefined ? deps.executable : executablePath();
  if (!command && !deps.createClient) return { ok: false, error: 'The Codex CLI was not found. Install it and make sure `codex` is on PATH' };
  const settings = MODES[mode] || MODES[DEFAULT_MODE];
  const client = deps.createClient ? deps.createClient({ cwd }) : new AppServerClient({ command, cwd });
  const files = imageFiles();
  const normalizer = createNormalizer(ctx);
  let threadId = null;
  let turnId = null;
  let aborted = signal.aborted;
  let graceTimer = null;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });

  client.onNotification = (method, params) => {
    if (params.threadId && threadId && params.threadId !== threadId) return; // another thread (a sub-agent)
    const result = normalizer.handle(method, params);
    if (result) finish(result);
  };
  client.onRequest = (method, params) => answerRequest(method, params, { ctx, requestPermission });
  client.onExit = error => finish({ ok: false, error: aborted ? '' : error.message });

  const interrupt = () => {
    aborted = true;
    if (!threadId || !turnId) return; // runTurn interrupts as soon as the turn exists
    client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    // The turn normally reports `interrupted`; if the process does not, stop waiting for it.
    graceTimer = setTimeout(() => finish({ ok: false, error: '' }), INTERRUPT_GRACE_MS);
  };
  signal.addEventListener('abort', interrupt, { once: true });

  let outcome;
  try {
    await client.start();
    const options = { cwd, ...settings };
    const started = sessionId
      ? await client.request('thread/resume', { threadId: sessionId, ...options, excludeTurns: true })
      : await client.request('thread/start', options);
    threadId = started.thread.id;
    ctx.setSession(threadId);
    if (ctx.setMeta) ctx.setMeta({ model: started.model, effort: started.reasoningEffort });
    if (!sessionId) {
      const rows = [
        ['Model', started.model], ['Reasoning effort', started.reasoningEffort], ['Working directory', started.cwd || cwd],
        ['Sandbox', settings.sandbox], ['Approvals', settings.approvalPolicy], ['Session', threadId],
      ].filter(([, value]) => value);
      ctx.upsert({ id: `init:${threadId}`, kind: 'init', text: 'Initialized session', details: rows });
    }
    if (aborted) return { ok: false, error: '' };
    const response = await client.request('turn/start', { threadId, input: userInput(prompt, files) });
    turnId = response.turn.id;
    // Input the person adds while the turn runs goes into the same turn.
    ctx.setControl({ steer: next => client.request('turn/steer', { threadId, expectedTurnId: turnId, input: userInput(next, files) }) });
    if (aborted) interrupt();
    outcome = await done;
  } catch (error) {
    outcome = { ok: false, error: aborted ? '' : error.message || 'Codex failed' };
  } finally {
    clearTimeout(graceTimer);
    signal.removeEventListener('abort', interrupt);
    ctx.setControl(null);
    client.close();
    files.cleanup();
  }
  return outcome;
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

module.exports = { MODES, DEFAULT_MODE, CAPABILITIES, createNormalizer, answerRequest, runTurn, loadHistory, findRollout, historyFromRollout };

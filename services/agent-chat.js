// Chat-style Claude / Codex conversations of a task. A conversation lives in memory while the server runs (items, pending permission requests,
// the running turn) and in `agent_conversations` (agent, session id, title, mode), so it can be listed and resumed after a restart.
//
// Clients load a snapshot (`snapshot()`), then follow `events` (`subscribe()`); every event carries a sequence number, and a client that
// reconnects asks for the events after the last one it saw.
const fs = require('fs');
const { randomUUID } = require('crypto');
const claude = require('../lib/agent-chat/claude');
const codex = require('../lib/agent-chat/codex');

const ADAPTERS = { claude, codex };
const MAX_EVENTS = 2000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_CHARS = 200 * 1024;
const MAX_TEXT = 100 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_TITLE = 'New chat';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

function createAgentChat({ db, adapters = ADAPTERS }) {
  const runtimes = new Map(); // conversation id -> runtime

  const rowOf = (taskId, id) => db.prepare('SELECT * FROM agent_conversations WHERE id = ? AND task_id = ?').get(id, taskId);
  const publicRow = (row, rt) => ({
    id: row.id, agent: row.agent, session_id: row.session_id, title: row.title, mode: row.mode,
    updated_at: row.updated_at, running: Boolean(rt && rt.status === 'running'),
  });

  function runtimeFor(row, task) {
    let rt = runtimes.get(row.id);
    if (!rt) {
      rt = {
        id: row.id, taskId: row.task_id, agent: row.agent, sessionId: row.session_id, mode: row.mode, title: row.title,
        items: new Map(), seq: 0, events: [], subscribers: new Set(), status: 'idle', abort: null, pending: new Map(), loaded: false, counter: 0,
      };
      runtimes.set(row.id, rt);
    }
    rt.workDir = task.work_dir;
    return rt;
  }

  function emit(rt, event) {
    const full = { ...event, seq: ++rt.seq };
    rt.events.push(full);
    if (rt.events.length > MAX_EVENTS) rt.events.splice(0, rt.events.length - MAX_EVENTS);
    for (const send of rt.subscribers) send(full);
    return full;
  }

  function touch(rt, fields = {}) {
    const sets = ['updated_at = CURRENT_TIMESTAMP'];
    const values = [];
    for (const [column, value] of Object.entries(fields)) { sets.push(`${column} = ?`); values.push(value); }
    db.prepare(`UPDATE agent_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values, rt.id);
  }

  // The earlier messages of a resumed session are loaded once, the first time the conversation is opened.
  async function loadHistory(rt) {
    if (rt.loaded) return;
    rt.loaded = true;
    if (!rt.sessionId) return;
    try {
      const items = await adapters[rt.agent].loadHistory({ cwd: rt.workDir, sessionId: rt.sessionId });
      for (const item of items) rt.items.set(item.id, item);
    } catch (error) {
      rt.items.set('history-error', { id: 'history-error', kind: 'notice', text: `Could not load the earlier messages: ${error.message}` });
    }
  }

  function pendingList(rt) { return [...rt.pending.values()].map(entry => entry.request); }

  async function snapshot(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimeFor(row, task);
    await loadHistory(rt);
    return { conversation: publicRow(db.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id), rt), items: [...rt.items.values()], pending: pendingList(rt), status: rt.status, seq: rt.seq };
  }

  // Calls `send` for every event after `after`; returns the unsubscribe function, or null when events were dropped and the client must reload.
  function subscribe(task, id, after, send) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimeFor(row, task);
    const oldest = rt.events.length ? rt.events[0].seq : rt.seq + 1;
    if (after + 1 < oldest && after < rt.seq) return null;
    for (const event of rt.events) if (event.seq > after) send(event);
    rt.subscribers.add(send);
    return () => rt.subscribers.delete(send);
  }

  function list(taskId) {
    return db.prepare('SELECT * FROM agent_conversations WHERE task_id = ? ORDER BY updated_at DESC, rowid DESC').all(taskId)
      .map(row => publicRow(row, runtimes.get(row.id)));
  }

  function create(task, { agent, session_id: sessionId, mode, title } = {}) {
    if (!adapters[agent]) throw fail('INVALID_AGENT');
    if (sessionId !== undefined && sessionId !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{7,80}$/.test(String(sessionId))) throw fail('INVALID_SESSION_ID');
    if (sessionId) {
      const existing = db.prepare('SELECT * FROM agent_conversations WHERE task_id = ? AND agent = ? AND session_id = ?').get(task.id, agent, sessionId);
      if (existing) return publicRow(existing, runtimes.get(existing.id));
    }
    const modes = adapters[agent].MODES;
    const chosen = modes[mode] ? mode : adapters[agent].DEFAULT_MODE;
    const id = randomUUID();
    const label = clip(String(title || '').replace(/\s+/g, ' ').trim(), 60) || DEFAULT_TITLE;
    db.prepare('INSERT INTO agent_conversations (id, task_id, agent, session_id, title, mode) VALUES (?, ?, ?, ?, ?, ?)').run(id, task.id, agent, sessionId || null, label, chosen);
    return publicRow(rowOf(task.id, id), null);
  }

  function setMode(task, id, mode) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    if (!adapters[row.agent].MODES[mode]) throw fail('INVALID_MODE');
    const rt = runtimeFor(row, task);
    rt.mode = mode;
    touch(rt, { mode });
    emit(rt, { op: 'meta', mode });
    return publicRow(rowOf(task.id, id), rt);
  }

  function rename(task, id, title) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const label = clip(String(title || '').replace(/\s+/g, ' ').trim(), 60);
    if (!label) throw fail('TITLE_REQUIRED');
    const rt = runtimeFor(row, task);
    rt.title = label;
    touch(rt, { title: label });
    emit(rt, { op: 'meta', title: label });
    return publicRow(rowOf(task.id, id), rt);
  }

  // Validates what the person attached and builds the prompt: images go to the agent as images, text files are quoted into the prompt.
  function buildPrompt(body) {
    const text = String(body.text || '').trim();
    if (text.length > MAX_TEXT) throw fail('MESSAGE_TOO_LONG');
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES + 1);
    if (images.length > MAX_IMAGES) throw fail('TOO_MANY_IMAGES');
    const checked = images.map(image => {
      const mediaType = String(image && image.type || '');
      const data = String(image && image.data || '');
      if (!IMAGE_TYPES.has(mediaType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw fail('INVALID_IMAGE');
      if (data.length * 0.75 > MAX_IMAGE_BYTES) throw fail('IMAGE_TOO_LARGE');
      return { mediaType, data, name: clip(String(image.name || 'image'), 80) };
    });
    const files = (Array.isArray(body.files) ? body.files : []).slice(0, 10).map(file => ({
      name: clip(String(file && file.name || 'file'), 120),
      text: String(file && file.text || '').slice(0, MAX_FILE_CHARS),
    }));
    if (!text && !checked.length && !files.length) throw fail('EMPTY_MESSAGE');
    const quoted = files.map(file => `\n\nAttached file ${file.name}:\n\`\`\`\n${file.text}\n\`\`\``).join('');
    return { text: `${text || (checked.length ? 'See the attached image.' : 'See the attached file.')}${quoted}`, images: checked, display: text, names: [...checked.map(image => image.name), ...files.map(file => file.name)] };
  }

  function turnContext(rt) {
    return {
      upsert(item) { rt.items.set(item.id, item); emit(rt, { op: 'upsert', item }); },
      append(id, text) {
        const item = rt.items.get(id);
        if (!item) return;
        item.text = (item.text || '') + text;
        emit(rt, { op: 'append', id, text });
      },
      getItem: id => rt.items.get(id),
      setSession(sessionId) {
        if (!sessionId || sessionId === rt.sessionId) return;
        rt.sessionId = sessionId;
        touch(rt, { session_id: sessionId });
        emit(rt, { op: 'session', session_id: sessionId });
      },
    };
  }

  function requestPermission(rt) {
    return request => new Promise(resolve => {
      const full = { id: randomUUID(), tool: request.tool, input: request.input, title: request.title, description: request.description };
      rt.pending.set(full.id, { request: full, resolve });
      emit(rt, { op: 'permission', request: full });
    });
  }

  function settlePending(rt, allow, message) {
    for (const [id, entry] of rt.pending) {
      entry.resolve({ allow, message });
      emit(rt, { op: 'permission_done', id, allow });
    }
    rt.pending.clear();
  }

  async function sendMessage(task, id, body, deps = {}) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimeFor(row, task);
    if (rt.status === 'running') throw fail('CONVERSATION_BUSY', 409);
    if (!task.work_dir || !fs.existsSync(task.work_dir)) throw fail('WORKING_DIRECTORY_MISSING');
    const prompt = buildPrompt(body);
    await loadHistory(rt);
    const ctx = turnContext(rt);
    const userItem = { id: `u${Date.now().toString(36)}${rt.counter++}`, kind: 'user', text: prompt.display, attachments: prompt.names };
    ctx.upsert(userItem);
    if (rt.title === DEFAULT_TITLE && prompt.display) {
      rt.title = clip(prompt.display.replace(/\s+/g, ' '), 40);
      touch(rt, { title: rt.title });
      emit(rt, { op: 'meta', title: rt.title });
    }
    const controller = new AbortController();
    rt.abort = controller;
    rt.status = 'running';
    emit(rt, { op: 'status', status: 'running' });
    // The turn runs in the background; the request returns once it has started.
    void (async () => {
      let outcome;
      try {
        outcome = await adapters[rt.agent].runTurn({
          cwd: rt.workDir, sessionId: rt.sessionId, mode: rt.mode, prompt, signal: controller.signal, ctx,
          requestPermission: requestPermission(rt), deps: deps[rt.agent],
        });
      } catch (error) {
        outcome = { ok: false, error: controller.signal.aborted ? '' : (error.message || 'The agent failed') };
      }
      settlePending(rt, false, 'The turn ended');
      rt.abort = null;
      rt.status = 'idle';
      if (controller.signal.aborted) ctx.upsert({ id: `n${rt.counter++}`, kind: 'notice', text: 'Stopped' });
      else if (outcome && outcome.error) ctx.upsert({ id: `e${rt.counter++}`, kind: 'error', text: outcome.error });
      touch(rt);
      emit(rt, { op: 'status', status: 'idle', ok: Boolean(outcome && outcome.ok), usage: outcome && outcome.usage, cost: outcome && outcome.cost });
    })();
    return { success: true };
  }

  function interrupt(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimes.get(id);
    if (!rt || rt.status !== 'running' || !rt.abort) return { success: true, running: false };
    settlePending(rt, false, 'Stopped by the person');
    rt.abort.abort();
    return { success: true, running: true };
  }

  function answerPermission(task, id, requestId, { allow, message } = {}) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimes.get(id);
    const entry = rt && rt.pending.get(requestId);
    if (!entry) throw fail('REQUEST_NOT_FOUND', 404);
    rt.pending.delete(requestId);
    entry.resolve({ allow: allow === true, message: typeof message === 'string' ? message.slice(0, 500) : undefined });
    emit(rt, { op: 'permission_done', id: requestId, allow: allow === true });
    return { success: true };
  }

  function remove(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimes.get(id);
    if (rt) {
      settlePending(rt, false, 'The conversation was deleted');
      if (rt.abort) rt.abort.abort();
      runtimes.delete(id);
    }
    db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(id);
    return { success: true };
  }

  // Stops every running turn (a task was deleted, or the server is shutting down).
  function stopTask(taskId) {
    for (const rt of runtimes.values()) {
      if (rt.taskId !== taskId) continue;
      settlePending(rt, false, 'The task was closed');
      if (rt.abort) rt.abort.abort();
    }
  }

  return { list, create, snapshot, subscribe, sendMessage, interrupt, answerPermission, setMode, rename, remove, stopTask };
}

let shared = null;
// The instance the server uses; created on first use so tests can build their own with another database.
function getAgentChat() {
  if (!shared) shared = createAgentChat({ db: require('../db') });
  return shared;
}

module.exports = { createAgentChat, getAgentChat, IMAGE_TYPES };

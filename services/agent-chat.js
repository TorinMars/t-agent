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
    opened: { web: row.opened_web || null, h5: row.opened_h5 || null },
    ...(rt && rt.model ? { model: rt.model } : {}), ...(rt && rt.effort ? { effort: rt.effort } : {}), ...(rt && rt.context ? { context: rt.context } : {}),
    ...(rt && rt.limits ? { limits: rt.limits } : {}),
  });

  // The plan limits of an account are shared by its chats: the last values seen per agent, and the refresh that is under way.
  const agentLimits = new Map(); // agent -> { limits, at }
  const refreshing = new Map(); // agent -> promise
  const LIMITS_TTL_MS = 60 * 1000;
  const cleanLimits = list => (Array.isArray(list) ? list : []).slice(0, 8).map(entry => ({
    id: clip(String(entry && entry.id || ''), 20), label: clip(String(entry && entry.label || ''), 20),
    usedPercent: Number(entry && entry.usedPercent), resetsAt: Number.isFinite(Number(entry && entry.resetsAt)) && entry.resetsAt !== null ? Math.round(Number(entry.resetsAt)) : null,
  })).filter(entry => entry.id && entry.label && Number.isFinite(entry.usedPercent) && entry.usedPercent >= 0)
    .map(entry => ({ ...entry, usedPercent: Math.min(100, Math.round(entry.usedPercent * 10) / 10) }));

  // What the agent says about itself: { model, effort, context: { used, window } } (tokens in the context window and its size).
  // `keep`: only fill what is not known yet (what the session files say must not replace a live report). Returns what changed.
  function mergeMeta(rt, meta = {}, { keep = false } = {}) {
    const changed = {};
    for (const key of ['model', 'effort']) {
      const value = typeof meta[key] === 'string' ? clip(meta[key].trim(), 80) : '';
      if (value && value !== rt[key] && !(keep && rt[key])) { rt[key] = value; changed[key] = value; }
    }
    const context = meta.context;
    if (context && Number.isFinite(context.used) && context.used >= 0 && Number.isFinite(context.window) && context.window > 0 && !(keep && rt.context)) {
      const next = { used: Math.round(context.used), window: Math.round(context.window) };
      if (!rt.context || rt.context.used !== next.used || rt.context.window !== next.window) { rt.context = next; changed.context = next; }
    }
    if (Array.isArray(meta.limits) && !keep) {
      // Updates can be partial (one window of two): merge by id.
      const merged = new Map((rt.limits || []).map(entry => [entry.id, entry]));
      for (const entry of cleanLimits(meta.limits)) merged.set(entry.id, entry);
      const next = [...merged.values()];
      if (JSON.stringify(next) !== JSON.stringify(rt.limits || [])) { rt.limits = next; changed.limits = next; }
    }
    return changed;
  }

  function runtimeFor(row, task) {
    let rt = runtimes.get(row.id);
    if (!rt) {
      rt = {
        id: row.id, taskId: row.task_id, agent: row.agent, sessionId: row.session_id, mode: row.mode, title: row.title,
        choice: { model: row.model || '', effort: row.effort || '' }, model: row.model || undefined, effort: row.effort || undefined,
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
      // A chat opened after a restart (or from a session of the terminal) knows its model and context from the session itself.
      if (adapters[rt.agent].loadMeta) {
        try { mergeMeta(rt, await adapters[rt.agent].loadMeta({ cwd: rt.workDir, sessionId: rt.sessionId }), { keep: true }); } catch { /* the footer just stays empty */ }
      }
    } catch (error) {
      rt.items.set('history-error', { id: 'history-error', kind: 'notice', text: `Could not load the earlier messages: ${error.message}` });
    }
  }

  function pendingList(rt) { return [...rt.pending.values()].map(entry => entry.request); }

  // Reads the account's plan limits again when the last reading is old; chats of that agent get them as a meta event.
  function refreshLimits(agent) {
    const adapter = adapters[agent];
    const known = agentLimits.get(agent);
    if (!adapter.loadLimits || refreshing.has(agent) || (known && Date.now() - known.at < LIMITS_TTL_MS)) return refreshing.get(agent) || Promise.resolve();
    const job = (async () => {
      try {
        const limits = await adapter.loadLimits();
        agentLimits.set(agent, { limits: cleanLimits(limits), at: Date.now() });
        for (const rt of runtimes.values()) {
          if (rt.agent !== agent) continue;
          const changed = mergeMeta(rt, { limits });
          if (changed.limits) emit(rt, { op: 'meta', limits: changed.limits });
        }
      } catch { agentLimits.set(agent, { limits: (known && known.limits) || [], at: Date.now() }); } // try again after the interval
      finally { refreshing.delete(agent); }
    })();
    refreshing.set(agent, job);
    return job;
  }

  async function snapshot(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimeFor(row, task);
    await loadHistory(rt);
    const known = agentLimits.get(rt.agent);
    if (!rt.limits && known && known.limits.length) rt.limits = known.limits;
    void refreshLimits(rt.agent);
    return {
      conversation: publicRow(db.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id), rt),
      items: [...rt.items.values()], pending: pendingList(rt), status: rt.status, seq: rt.seq,
      runningMs: rt.status === 'running' && rt.startedAt ? Date.now() - rt.startedAt : 0,
      capabilities: adapters[rt.agent].CAPABILITIES || {},
    };
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

  // The model and thinking effort the person picked for the next turns; '' (or null) goes back to the agent's own default.
  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/;
  const EFFORT_ID = /^[a-z]{2,16}$/;
  function setPreferences(task, id, { model, effort } = {}) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const clean = (value, pattern, code) => {
      if (value === undefined) return undefined;
      const text = value === null ? '' : String(value).trim();
      if (text && !pattern.test(text)) throw fail(code);
      return text;
    };
    const nextModel = clean(model, MODEL_ID, 'INVALID_MODEL');
    const nextEffort = clean(effort, EFFORT_ID, 'INVALID_EFFORT');
    const rt = runtimeFor(row, task);
    const fields = {};
    const event = { op: 'meta' };
    for (const [key, value] of [['model', nextModel], ['effort', nextEffort]]) {
      if (value === undefined) continue;
      rt.choice[key] = value;
      rt[key] = value || undefined; // the footer shows the choice until a turn reports what it ran with
      fields[key] = value || null;
      event[key] = value; // '' clears it on the page
    }
    // The effort a turn reported belongs to the model it ran with: a new model starts from the effort chosen for it (or the default).
    if (nextModel !== undefined && nextEffort === undefined) { rt.effort = rt.choice.effort || undefined; event.effort = rt.choice.effort; }
    if (Object.keys(fields).length) { touch(rt, fields); emit(rt, event); }
    return publicRow(rowOf(task.id, id), rt);
  }

  // The models an agent offers (with the effort levels each supports); the list is read from the agent and kept for a while.
  const modelLists = new Map(); // agent -> { at, models } | { promise }
  const MODELS_TTL_MS = 10 * 60 * 1000;
  async function listModels(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const adapter = adapters[row.agent];
    if (!adapter.listModels) throw fail('MODELS_UNAVAILABLE', 404);
    let entry = modelLists.get(row.agent);
    if (!entry || (entry.models && Date.now() - entry.at > MODELS_TTL_MS)) {
      entry = { promise: adapter.listModels().then(models => { modelLists.set(row.agent, { at: Date.now(), models }); return models; }, () => { modelLists.delete(row.agent); throw fail('MODELS_UNAVAILABLE', 502); }) };
      modelLists.set(row.agent, entry);
    }
    const offered = entry.models || await entry.promise;
    // The first entry is always "Default" (no choice): the model the agent would use on its own.
    const efforts = [...new Set(offered.flatMap(model => model.efforts))];
    const models = offered.some(model => model.value === '') ? offered : [{ value: '', label: 'Default', description: '', efforts, defaultEffort: '' }, ...offered];
    const rt = runtimeFor(row, task);
    return { models, current: { model: rt.model || '', effort: rt.effort || '' }, chosen: { ...rt.choice } };
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
      // What the running turn offers while it runs: `steer(prompt)` adds the person's input to it.
      setControl(control) { rt.control = control || null; },
      // What the agent reports about itself ({ model, effort, context }); shown under the composer.
      setMeta(meta) {
        const changed = mergeMeta(rt, meta);
        if (changed.limits) agentLimits.set(rt.agent, { limits: rt.limits, at: Date.now() });
        if (Object.keys(changed).length) emit(rt, { op: 'meta', ...changed });
      },
      setSession(sessionId) {
        if (!sessionId || sessionId === rt.sessionId) return;
        rt.sessionId = sessionId;
        touch(rt, { session_id: sessionId });
        emit(rt, { op: 'session', session_id: sessionId });
      },
    };
  }

  // A request from the agent: an approval (allow / deny, optionally "for the session"), or `kind: 'question'` with `questions`
  // ({ id, header, question, options: [{ label, description }] | null, isOther, isSecret }) that the person answers.
  function requestPermission(rt) {
    return request => new Promise(resolve => {
      const full = {
        id: randomUUID(), kind: request.kind === 'question' ? 'question' : 'approval', tool: request.tool, input: request.input,
        title: request.title, description: request.description, canRemember: Boolean(request.canRemember), questions: request.questions,
      };
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

  // A message sent while the agent works goes into the running turn (the agent decides when to take it into account).
  async function steer(rt, ctx, prompt) {
    const control = rt.control;
    try { await control.steer(prompt); }
    catch (error) { throw fail(rt.status === 'running' ? 'STEER_FAILED' : 'CONVERSATION_BUSY', 409); }
    ctx.upsert({ id: `u${Date.now().toString(36)}${rt.counter++}`, kind: 'user', text: prompt.display, attachments: prompt.names });
    return { success: true, steered: true };
  }

  async function sendMessage(task, id, body, deps = {}) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimeFor(row, task);
    if (rt.status === 'running' && !(rt.control && rt.control.steer)) throw fail('CONVERSATION_BUSY', 409);
    if (!task.work_dir || !fs.existsSync(task.work_dir)) throw fail('WORKING_DIRECTORY_MISSING');
    const prompt = buildPrompt(body);
    await loadHistory(rt);
    const ctx = turnContext(rt);
    if (rt.status === 'running') return steer(rt, ctx, prompt);
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
    rt.startedAt = Date.now();
    emit(rt, { op: 'status', status: 'running', runningMs: 0 });
    // The turn runs in the background; the request returns once it has started.
    void (async () => {
      let outcome;
      try {
        outcome = await adapters[rt.agent].runTurn({
          cwd: rt.workDir, sessionId: rt.sessionId, mode: rt.mode, prompt, signal: controller.signal, ctx,
          model: rt.choice.model || undefined, effort: rt.choice.effort || undefined,
          requestPermission: requestPermission(rt), deps: deps[rt.agent],
        });
      } catch (error) {
        outcome = { ok: false, error: controller.signal.aborted ? '' : (error.message || 'The agent failed') };
      }
      settlePending(rt, false, 'The turn ended');
      rt.abort = null;
      rt.control = null;
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

  // `answers` of a question: { [question id]: string | string[] }, bounded so a client cannot park large payloads in the runtime.
  function cleanAnswers(answers) {
    const out = {};
    if (!answers || typeof answers !== 'object') return out;
    for (const [key, value] of Object.entries(answers).slice(0, 20)) {
      const list = [].concat(value).filter(entry => ['string', 'number', 'boolean'].includes(typeof entry)).slice(0, 20).map(entry => clip(String(entry), 2000));
      out[clip(key, 80)] = Array.isArray(value) ? list : list[0] === undefined ? '' : list[0];
    }
    return out;
  }

  function answerPermission(task, id, requestId, { allow, message, remember, answers } = {}) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimes.get(id);
    const entry = rt && rt.pending.get(requestId);
    if (!entry) throw fail('REQUEST_NOT_FOUND', 404);
    rt.pending.delete(requestId);
    entry.resolve({
      allow: allow === true, remember: allow === true && remember === true && entry.request.canRemember,
      message: typeof message === 'string' ? message.slice(0, 500) : undefined,
      answers: entry.request.kind === 'question' && allow === true ? cleanAnswers(answers) : undefined,
    });
    emit(rt, { op: 'permission_done', id: requestId, allow: allow === true });
    return { success: true };
  }

  // Marks a chat as open (or not) on a page: 'web' is the desktop page, which shows every open chat as a tab; 'h5' is the phone page, which
  // shows one at a time, so opening a chat there closes the others of the task. Opening does not change the order of the list.
  const SURFACES = { web: 'opened_web', h5: 'opened_h5' };
  function setOpened(task, id, { surface, opened } = {}) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const column = SURFACES[surface];
    if (!column) throw fail('INVALID_SURFACE');
    if (typeof opened !== 'boolean') throw fail('INVALID_OPENED');
    if (opened) {
      if (surface === 'h5') db.prepare(`UPDATE agent_conversations SET ${column} = NULL WHERE task_id = ? AND id != ?`).run(task.id, id);
      // Opening again keeps the place among the tabs.
      db.prepare(`UPDATE agent_conversations SET ${column} = COALESCE(${column}, ?) WHERE id = ?`).run(Date.now(), id);
    } else {
      db.prepare(`UPDATE agent_conversations SET ${column} = NULL WHERE id = ?`).run(id);
    }
    return publicRow(rowOf(task.id, id), runtimes.get(id));
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

  return { list, create, snapshot, subscribe, sendMessage, interrupt, answerPermission, setMode, setPreferences, listModels, setOpened, rename, remove, stopTask, refreshLimits };
}

let shared = null;
// The instance the server uses; created on first use so tests can build their own with another database.
function getAgentChat() {
  if (!shared) shared = createAgentChat({ db: require('../db') });
  return shared;
}

module.exports = { createAgentChat, getAgentChat, IMAGE_TYPES };

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
const MAX_QUEUE = 20; // messages waiting in one chat
const MAX_QUEUE_BYTES = 28 * 1024 * 1024; // as saved (JSON); a request is 32 MB at most
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_TITLE = 'New chat';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode });
const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// After Stop the adapter gets this long to end the turn by itself; then the turn is ended here, so a stuck agent cannot leave the chat running for good.
const STOP_GRACE_MS = 5000;

function createAgentChat({ db, adapters = ADAPTERS, stopGraceMs = STOP_GRACE_MS }) {
  const runtimes = new Map(); // conversation id -> runtime

  const rowOf = (taskId, id) => db.prepare('SELECT * FROM agent_conversations WHERE id = ? AND task_id = ?').get(id, taskId);
  const publicRow = (row, rt) => ({
    id: row.id, agent: row.agent, session_id: row.session_id, title: row.title, mode: row.mode,
    updated_at: row.updated_at, running: Boolean(rt && rt.status === 'running'), translate: row.translate === 1, collapseKeyboard: row.collapse_keyboard !== 0,
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
  // `force` (a click on the usage) skips the wait; it resolves to false when the reading failed.
  function refreshLimits(agent, { force = false } = {}) {
    const adapter = adapters[agent];
    const known = agentLimits.get(agent);
    if (!adapter.loadLimits || refreshing.has(agent) || (!force && known && Date.now() - known.at < LIMITS_TTL_MS)) return refreshing.get(agent) || Promise.resolve(true);
    const job = (async () => {
      try {
        const limits = await adapter.loadLimits();
        agentLimits.set(agent, { limits: cleanLimits(limits), at: Date.now() });
        for (const rt of runtimes.values()) {
          if (rt.agent !== agent) continue;
          const changed = mergeMeta(rt, { limits });
          if (changed.limits) emit(rt, { op: 'meta', limits: changed.limits });
        }
        return true;
      } catch { agentLimits.set(agent, { limits: (known && known.limits) || [], at: Date.now() }); return false; } // try again after the interval
      finally { refreshing.delete(agent); }
    })();
    refreshing.set(agent, job);
    return job;
  }

  // The slash commands of a chat. Starting the agent to ask takes a few seconds, so the list is kept per agent and working directory for a while, and an
  // old one is answered at once while a new one is read.
  const COMMANDS_TTL_MS = 5 * 60 * 1000;
  const commandCache = new Map(); // `${agent}:${cwd}` -> { list, at, reading }
  async function listCommands(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const adapter = adapters[row.agent];
    if (!adapter.listCommands) return { supported: false, commands: [] };
    const key = `${row.agent}:${task.work_dir || ''}`;
    let entry = commandCache.get(key);
    const read = () => {
      if (entry && entry.reading) return entry.reading;
      const reading = adapter.listCommands({ cwd: task.work_dir || undefined })
        .then(list => { commandCache.set(key, { list, at: Date.now(), reading: null }); return list; })
        .catch(error => { const kept = commandCache.get(key); if (kept) kept.reading = null; throw error; });
      entry = entry || { list: null, at: 0, reading: null };
      entry.reading = reading;
      commandCache.set(key, entry);
      return reading;
    };
    if (entry && entry.list) {
      if (Date.now() - entry.at > COMMANDS_TTL_MS) void read().catch(() => {}); // refreshed for the next time
      return { supported: true, commands: entry.list };
    }
    try { return { supported: true, commands: await read() }; }
    catch { throw fail('COMMANDS_UNAVAILABLE', 502); }
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
      items: [...rt.items.values()], pending: pendingList(rt), status: rt.status, seq: rt.seq, queue: readQueue(id),
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

  // In the order the chats were created, which never changes: a chat that gets a message does not jump in the lists that show them in this order
  // (the phone task sheet). A list that wants the latest first sorts by `updated_at`.
  function list(taskId) {
    return db.prepare('SELECT * FROM agent_conversations WHERE task_id = ? ORDER BY rowid ASC').all(taskId)
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

  // The messages the person queued in the chat while the agent works. The page decides when each one goes out; they are kept here so a refresh (or
  // another page that shows the chat) does not lose them. The page replaces the whole list each time it changes.
  function readQueue(id) {
    const row = db.prepare('SELECT queue FROM agent_conversations WHERE id = ?').get(id);
    if (!row || !row.queue) return [];
    try { const list = JSON.parse(row.queue); return Array.isArray(list) ? list : []; } catch { return []; }
  }
  function setQueue(task, id, queue) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    if (!Array.isArray(queue)) throw fail('INVALID_QUEUE');
    if (queue.length > MAX_QUEUE) throw fail('QUEUE_TOO_LONG');
    const seen = new Set();
    const clean = queue.map(entry => {
      const body = entry && entry.body && typeof entry.body === 'object' ? entry.body : null;
      const key = Number(entry && entry.id);
      if (!body || !Number.isSafeInteger(key) || seen.has(key)) throw fail('INVALID_QUEUE');
      seen.add(key);
      buildPrompt(body); // the same checks as a message that is sent (size, image type, empty): a queued message must be one that can be sent
      return {
        id: key,
        label: clip(String(entry.label || '').replace(/\s+/g, ' '), 80),
        body: {
          text: String(body.text || ''),
          images: (Array.isArray(body.images) ? body.images : []).map(image => ({ name: String(image && image.name || ''), type: String(image && image.type || ''), data: String(image && image.data || '') })),
          files: (Array.isArray(body.files) ? body.files : []).map(file => ({ name: String(file && file.name || ''), text: String(file && file.text || '') })),
        },
      };
    });
    const json = JSON.stringify(clean);
    if (json.length > MAX_QUEUE_BYTES) throw fail('QUEUE_TOO_LARGE');
    db.prepare('UPDATE agent_conversations SET queue = ? WHERE id = ?').run(clean.length ? json : null, id);
    return { success: true, count: clean.length };
  }

  // What the agents of one person are doing, for the status bar of the pages: the turns running now and the messages queued behind them (the queue is kept
  // here, see setQueue); "submitted" is both, the messages sent to an agent that have not finished. Chats of every task of the person count.
  function summary(owner) {
    const rows = db.prepare(`SELECT c.id, CASE WHEN c.queue IS NOT NULL AND json_valid(c.queue) THEN json_array_length(c.queue) ELSE 0 END AS queued
      FROM agent_conversations c JOIN tasks t ON t.id = c.task_id WHERE t.user_id = ?`).all(owner);
    let running = 0;
    let queued = 0;
    for (const row of rows) {
      const rt = runtimes.get(row.id);
      if (rt && rt.status === 'running') running += 1;
      queued += row.queued;
    }
    return { running, queued, submitted: running + queued };
  }

  // The state of the chat's translation switch, kept per chat; the other pages that show this chat follow it through a meta event.
  function setTranslate(task, id, value) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    if (typeof value !== 'boolean') throw fail('INVALID_TRANSLATE');
    db.prepare('UPDATE agent_conversations SET translate = ? WHERE id = ?').run(value ? 1 : 0, id);
    emit(runtimeFor(row, task), { op: 'meta', translate: value });
    return publicRow(rowOf(task.id, id), runtimes.get(id));
  }

  // The person clicked the usage: read it again now and answer with the chat as it is after that.
  async function refreshUsage(task, id) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    const rt = runtimeFor(row, task);
    const ok = await refreshLimits(rt.agent, { force: true });
    if (!ok) throw fail('LIMITS_UNAVAILABLE', 502);
    return publicRow(rowOf(task.id, id), rt);
  }

  // Whether the input box lets go of the keyboard after a message is sent, kept per chat (on unless turned off).
  function setCollapseKeyboard(task, id, value) {
    const row = rowOf(task.id, id);
    if (!row) throw fail('CONVERSATION_NOT_FOUND', 404);
    if (typeof value !== 'boolean') throw fail('INVALID_COLLAPSE_KEYBOARD');
    db.prepare('UPDATE agent_conversations SET collapse_keyboard = ? WHERE id = ?').run(value ? 1 : 0, id);
    emit(runtimeFor(row, task), { op: 'meta', collapseKeyboard: value });
    return publicRow(rowOf(task.id, id), runtimes.get(id));
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
      // /clear: the chat starts again from nothing; the pages (and the ones that come later) drop what was said before.
      resetConversation() { rt.items.clear(); emit(rt, { op: 'reset' }); },
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
        id: randomUUID(), kind: ['question', 'plan'].includes(request.kind) ? request.kind : 'approval', tool: request.tool, input: request.input,
        title: request.title, description: request.description, canRemember: Boolean(request.canRemember), questions: request.questions,
        ...(request.kind === 'plan' ? { plan: clip(String(request.plan || ''), 60000) } : {}),
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
    // The turn runs in the background; the request returns once it has started. It ends once: when the adapter returns, or, after Stop, when the
    // adapter has not returned within the grace time (finishTurn does nothing the second time).
    let ended = false;
    const finishTurn = outcome => {
      if (ended) return;
      ended = true;
      clearTimeout(rt.stopTimer);
      rt.stopTimer = null;
      rt.forceEnd = null;
      settlePending(rt, false, 'The turn ended');
      rt.abort = null;
      rt.control = null;
      rt.status = 'idle';
      if (controller.signal.aborted) ctx.upsert({ id: `n${rt.counter++}`, kind: 'notice', text: 'Stopped' });
      else if (outcome && outcome.error) ctx.upsert({ id: `e${rt.counter++}`, kind: 'error', text: outcome.error });
      touch(rt);
      emit(rt, { op: 'status', status: 'idle', ok: Boolean(outcome && outcome.ok), usage: outcome && outcome.usage, cost: outcome && outcome.cost });
    };
    rt.forceEnd = () => finishTurn({ ok: false, error: '' });
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
      finishTurn(outcome);
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
    // The adapter is asked to end the turn; if it does not (a stuck process), the turn is ended here after the grace time.
    if (!rt.stopTimer && rt.forceEnd) rt.stopTimer = setTimeout(() => { if (rt.forceEnd) rt.forceEnd(); }, stopGraceMs);
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
    // Approving the plan ends plan mode: the next messages of the chat are no longer "plan only".
    if (entry.request.kind === 'plan' && allow === true && rt.mode === 'plan') {
      rt.mode = adapters[rt.agent].DEFAULT_MODE;
      touch(rt, { mode: rt.mode });
      emit(rt, { op: 'meta', mode: rt.mode });
    }
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

  return { list, create, snapshot, subscribe, sendMessage, interrupt, answerPermission, setMode, setPreferences, listModels, setOpened, setTranslate, setCollapseKeyboard, refreshUsage, setQueue, summary, listCommands, rename, remove, stopTask, refreshLimits };
}

let shared = null;
// The instance the server uses; created on first use so tests can build their own with another database.
function getAgentChat() {
  if (!shared) shared = createAgentChat({ db: require('../db') });
  return shared;
}

module.exports = { createAgentChat, getAgentChat, IMAGE_TYPES };

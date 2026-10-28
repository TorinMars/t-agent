// State of one agent conversation, kept apart from React so the event handling can be tested without a browser.
//
// The server sends a snapshot (`GET <base>/conversations/<id>`), then server-sent events after the snapshot's sequence number:
//   upsert { item } | append { id, text } | status { status, ok } | permission { request } | permission_done { id } | meta { title, mode, model, effort, context, limits, suggestion }
// `getState()` returns an immutable snapshot that changes identity on every update, so it can feed useSyncExternalStore.
//
// Messages the person queues while the agent works ("⌘⏎ to queue for later") are kept here, not on the server: when a turn ends normally, or the
// person stops it, the next one is sent; after a failure they wait until the person sends or removes them.

// A message that is a slash command: "/", a name, then nothing or a space.
const COMMAND = /^\/[A-Za-z][\w:.-]*(\s|$)/;

const RETRY_EVENTS_MS = 2000;
const RETRY_LOAD_MS = 4000;

export function createChatStore({ api, base, conversation, notify = () => {}, EventSourceImpl = globalThis.EventSource }) {
  const url = suffix => `${base}/conversations/${conversation.id}${suffix}`;
  const listeners = new Set();
  let items = new Map();
  let state = {
    items: [], pending: [], status: 'idle', canSteer: false, loaded: false, title: conversation.title, mode: conversation.mode,
    model: conversation.model || '', effort: conversation.effort || '', context: conversation.context || null, limits: conversation.limits || [],
    lastTurn: null, // the latest turn that ended while this page watched: { n, ok, stopped } (the host page may tell the person)
    translate: conversation.translate === true, // the translation switch of this chat
    collapseKeyboard: conversation.collapseKeyboard !== false, // leave the input box after sending (on by default), also per chat
    runningSince: null, queue: [], suggestion: '',
    // What the person picked (the agent reports what it ran with, which can differ: an alias, a default) and the models on offer.
    canChoose: false, choice: { model: '', effort: '' }, models: { status: 'idle', list: [] },
    // The slash commands of the chat (when the agent has them): the list is read once, in the background, when the chat has loaded.
    commandsSupported: false, commands: { status: 'idle', list: [] },
  };
  let queued = 0;
  let queueTouched = false; // the queue was changed on this page: what the server has is older
  let queueSaving = Promise.resolve();
  let queueWarned = false;
  let forceTarget = null; // a queued message to send as soon as the turn the person stopped for it has ended
  let stopping = false; // the person pressed Stop and the turn has not ended yet: its end sends the next queued message
  let seq = 0;
  let source = null;
  let retry = null;
  let disposed = false;

  function publish(patch = {}) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  const publishItems = () => publish({ items: [...items.values()] });

  function apply(event) {
    if (event.seq <= seq) return;
    seq = event.seq;
    switch (event.op) {
      case 'upsert':
        items.set(event.item.id, event.item);
        publishItems();
        break;
      case 'append': {
        const item = items.get(event.id);
        if (!item) break;
        items.set(event.id, { ...item, text: (item.text || '') + event.text });
        publishItems();
        break;
      }
      case 'status': {
        // `runningMs` is how long the turn has run already; the page counts from its own clock so the two machines need not agree on the time.
        const wasRunning = state.status === 'running';
        const byPerson = stopping; // the person pressed Stop for this turn
        publish({ status: event.status, runningSince: event.status === 'running' ? Date.now() - (event.runningMs || 0) : null, ...(event.status === 'running' ? { suggestion: '' } : {}) });
        if (event.status === 'idle') {
          const proceed = event.ok === true || stopping;
          const target = forceTarget;
          stopping = false;
          forceTarget = null;
          if (wasRunning) publish({ lastTurn: { n: (state.lastTurn ? state.lastTurn.n : 0) + 1, ok: event.ok === true, stopped: byPerson } });
          if (target !== null) void sendQueued(target); // the message the person chose goes first, not the head of the queue
          else if (proceed) void sendNext();
        } else stopping = false;
        break;
      }
      case 'reset': // /clear: everything said so far is gone
        items = new Map();
        publishItems();
        break;
      case 'permission':
        if (!state.pending.some(request => request.id === event.request.id)) publish({ pending: [...state.pending, event.request] });
        break;
      case 'permission_done': publish({ pending: state.pending.filter(request => request.id !== event.id) }); break;
      case 'meta':
        publish({
          ...(event.title ? { title: event.title } : {}), ...(event.mode ? { mode: event.mode } : {}),
          ...(event.model !== undefined ? { model: event.model } : {}), ...(event.effort !== undefined ? { effort: event.effort } : {}),
          ...(event.context ? { context: event.context } : {}), ...(event.limits ? { limits: event.limits } : {}),
          ...(typeof event.translate === 'boolean' ? { translate: event.translate } : {}),
          ...(typeof event.collapseKeyboard === 'boolean' ? { collapseKeyboard: event.collapseKeyboard } : {}),
          ...(event.suggestion !== undefined ? { suggestion: typeof event.suggestion === 'string' ? event.suggestion : '' } : {}),
        });
        break;
      default: break;
    }
  }

  function follow() {
    if (disposed) return;
    source = new EventSourceImpl(`${url('/events')}?after=${seq}`);
    source.onmessage = message => { try { apply(JSON.parse(message.data)); } catch { /* a malformed frame is skipped */ } };
    source.addEventListener('reset', () => { source.close(); void load(); });
    source.addEventListener('gone', () => { source.close(); notify('This chat no longer exists'); });
    // EventSource would reconnect to the same URL with an old `after`; reconnect by hand so no event is applied twice or missed.
    source.onerror = () => { source.close(); source = null; if (!disposed) retry = setTimeout(follow, RETRY_EVENTS_MS); };
  }

  async function load() {
    try {
      const snapshot = await api.get(url(''));
      if (disposed) return;
      items = new Map(snapshot.items.map(item => [item.id, item]));
      seq = snapshot.seq;
      publish({
        items: [...items.values()], pending: snapshot.pending || [], status: snapshot.status, loaded: true,
        canSteer: Boolean(snapshot.capabilities && snapshot.capabilities.steer),
        runningSince: snapshot.status === 'running' ? Date.now() - (snapshot.runningMs || 0) : null,
        ...(snapshot.conversation && snapshot.conversation.model ? { model: snapshot.conversation.model } : {}),
        ...(snapshot.conversation && snapshot.conversation.effort ? { effort: snapshot.conversation.effort } : {}),
        ...(snapshot.conversation && snapshot.conversation.context ? { context: snapshot.conversation.context } : {}),
        ...(snapshot.conversation && snapshot.conversation.limits ? { limits: snapshot.conversation.limits } : {}),
        ...(snapshot.conversation && typeof snapshot.conversation.translate === 'boolean' ? { translate: snapshot.conversation.translate } : {}),
        ...(snapshot.conversation && typeof snapshot.conversation.collapseKeyboard === 'boolean' ? { collapseKeyboard: snapshot.conversation.collapseKeyboard } : {}),
        suggestion: typeof snapshot.suggestion === 'string' ? snapshot.suggestion : '',
        canChoose: Boolean(snapshot.capabilities && snapshot.capabilities.models),
        commandsSupported: Boolean(snapshot.capabilities && snapshot.capabilities.commands),
        // The queue kept with the chat (not when this page already changed it: that is newer).
        ...(!queueTouched && Array.isArray(snapshot.queue) && snapshot.queue.length ? { queue: snapshot.queue.map(entry => ({ id: entry.id, body: entry.body, label: entry.label })) } : {}),
      });
      for (const entry of state.queue) queued = Math.max(queued, entry.id);
      follow();
      if (state.commandsSupported) void loadCommands();
    } catch (error) {
      if (!disposed) { notify(`Could not load the chat: ${error.message}`); retry = setTimeout(load, RETRY_LOAD_MS); }
    }
  }

  // Translation always uses the Client, including when this conversation belongs to a remote Engine.
  async function prepareMessage(body, translate) {
    if (!translate || !body.text || COMMAND.test(body.text)) return body; // a slash command is not prose: translated, it would stop being one
    const result = await api.post('/api/translate', { text: body.text });
    if (disposed) return null;
    if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('Translation result is empty');
    return { ...body, text: result.text };
  }

  // Resolves to true when the server took the message.
  async function send(body) {
    try {
      await api.post(url('/messages'), body);
      if (state.suggestion) publish({ suggestion: '' }); // what was suggested is out of date once the person has said something
      return true;
    } catch (error) {
      notify(error.message === 'CONVERSATION_BUSY' ? 'The agent is still working' : `Could not send: ${error.message}`);
      return false;
    }
  }

  const dismissSuggestion = () => { if (state.suggestion) publish({ suggestion: '' }); };

  const label = body => (body.text || [...(body.images || []), ...(body.files || [])].map(file => file.name).join(', ')).replace(/\s+/g, ' ').slice(0, 80);
  // The queue is kept on the server with the chat, so a refresh does not lose it. Every change saves the whole list; the saves go one after the other,
  // so the last change is the one that stays. A failure is shown once.
  function saveQueue() {
    queueTouched = true;
    const queue = state.queue.map(({ id, body, label: text }) => ({ id, body, label: text }));
    queueSaving = queueSaving
      .then(() => api.post(url('/queue'), { queue }))
      .catch(error => {
        if (queueWarned) return;
        queueWarned = true;
        notify(`Could not keep the queued messages: ${error.message}`);
      });
  }
  function enqueue(body) {
    publish({ queue: [...state.queue, { id: ++queued, body, label: label(body) }] });
    saveQueue();
  }
  function unqueue(id) {
    publish({ queue: state.queue.filter(entry => entry.id !== id) });
    saveQueue();
  }
  // Changes the text of a queued message (its attachments stay). Resolves to false when nothing would be left of it: the person removes it instead.
  function editQueued(id, text) {
    const entry = state.queue.find(item => item.id === id);
    if (!entry) return false;
    const body = { ...entry.body, text: String(text).trim() };
    if (!body.text && !(body.images || []).length && !(body.files || []).length) return false;
    publish({ queue: state.queue.map(item => (item.id === id ? { ...item, body, label: label(body) } : item)) });
    saveQueue();
    return true;
  }
  // Sends a queued message now whatever the agent is doing. An agent that takes input mid-turn gets it into the running turn (as "send now"); one that
  // cannot is stopped first, and the message goes out when the stopped turn has ended, ahead of the rest of the queue.
  async function forceSend(id) {
    if (!state.queue.some(item => item.id === id)) return false;
    if (state.status !== 'running' || state.canSteer) return sendQueued(id);
    forceTarget = id;
    const result = await stop();
    if (result === 'failed') { forceTarget = null; return false; }
    if (result === 'idle') { forceTarget = null; return sendQueued(id); } // the turn had already ended
    return true;
  }
  // Sends one queued message now (the agent takes it into the running turn when it can, otherwise it starts the next one).
  async function sendQueued(id) {
    const entry = state.queue.find(item => item.id === id);
    if (!entry) return false;
    unqueue(id);
    const sent = await send(entry.body);
    if (!sent) { publish({ queue: [entry, ...state.queue] }); saveQueue(); } // it stays in the list for another try
    return sent;
  }
  async function sendNext() {
    if (state.queue.length && !disposed) await sendQueued(state.queue[0].id);
  }

  // The slash commands the agent offers; read once, and again when the last read failed. Starting the agent to ask takes a few seconds.
  async function loadCommands() {
    if (state.commands.status === 'loading' || state.commands.status === 'ready') return;
    publish({ commands: { status: 'loading', list: [] } });
    try {
      const answer = await api.get(url('/commands'));
      if (!disposed) publish({ commands: { status: 'ready', list: Array.isArray(answer.commands) ? answer.commands : [] } });
    } catch {
      if (!disposed) publish({ commands: { status: 'error', list: [] } });
    }
  }
  // The models the agent offers; read when the picker is opened, and again if the last read failed.
  async function loadModels() {
    if (state.models.status === 'loading' || state.models.status === 'ready') return;
    publish({ models: { status: 'loading', list: [] } });
    try {
      const answer = await api.get(url('/models'));
      if (disposed) return;
      publish({ models: { status: 'ready', list: answer.models || [] }, choice: { model: (answer.chosen && answer.chosen.model) || '', effort: (answer.chosen && answer.chosen.effort) || '' } });
    } catch {
      if (!disposed) publish({ models: { status: 'error', list: [] } });
    }
  }

  // Picks the model and / or the effort for the next messages; resolves to true when the server took it.
  async function choose(next) {
    try {
      const row = await api.patch(url(''), next);
      publish({
        choice: { ...state.choice, ...(next.model !== undefined ? { model: next.model || '' } : {}), ...(next.effort !== undefined ? { effort: next.effort || '' } : {}) },
        model: (row && row.model) || '', effort: (row && row.effort) || '',
      });
      return true;
    } catch (error) {
      notify(`Could not change the model: ${error.message}`);
      return false;
    }
  }

  // Turns the translation switch of this chat on or off. The switch moves at once; when the server cannot save it, it goes back.
  // Reads the plan usage again now (a click on it). The new numbers also arrive as a meta event; false when it could not be read.
  async function refreshLimits() {
    try {
      const row = await api.post(url('/limits/refresh'), {});
      if (row && Array.isArray(row.limits)) publish({ limits: row.limits });
      return true;
    } catch (error) {
      notify(`Could not refresh the usage: ${error.message}`);
      return false;
    }
  }

  async function setCollapseKeyboard(value) {
    const before = state.collapseKeyboard;
    publish({ collapseKeyboard: value });
    try {
      await api.patch(url(''), { collapseKeyboard: value });
      return true;
    } catch (error) {
      publish({ collapseKeyboard: before });
      notify(`Could not save the keyboard switch: ${error.message}`);
      return false;
    }
  }

  async function setTranslate(value) {
    const before = state.translate;
    publish({ translate: value });
    try {
      await api.patch(url(''), { translate: value });
      return true;
    } catch (error) {
      publish({ translate: before });
      notify(`Could not save the translation switch: ${error.message}`);
      return false;
    }
  }

  async function rename(title) {
    try {
      await api.patch(url(''), { title });
      return true;
    } catch (error) {
      notify(`Could not rename the chat: ${error.message}`);
      return false;
    }
  }

  // Resolves to 'stopping' (the turn was asked to end), 'idle' (nothing was running) or 'failed'.
  async function stop() {
    stopping = true;
    try {
      const answer = await api.post(url('/interrupt'), {});
      if (answer && answer.running === false) { stopping = false; return 'idle'; }
      return 'stopping';
    } catch (error) {
      stopping = false;
      notify(`Could not stop: ${error.message}`);
      return 'failed';
    }
  }

  // Resolves to true when answered; on failure the request stays pending so the person can try again.
  async function answer(requestId, body) {
    try {
      await api.post(url(`/permissions/${requestId}`), body);
      return true;
    } catch (error) {
      notify(`Could not answer: ${error.message}`);
      return false;
    }
  }

  async function setMode(next) {
    try {
      await api.patch(url(''), { mode: next });
      conversation.mode = next;
      publish({ mode: next });
      return true;
    } catch (error) {
      notify(`Could not change the access level: ${error.message}`);
      return false;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    prepareMessage, dismissSuggestion, load, send, stop, answer, setMode, loadModels, choose, loadCommands, setTranslate, setCollapseKeyboard, refreshLimits, rename, enqueue, unqueue, editQueued, forceSend, sendQueued, apply,
    destroy() {
      disposed = true;
      clearTimeout(retry);
      if (source) source.close();
      listeners.clear();
    },
  };
}

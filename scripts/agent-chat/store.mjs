// State of one agent conversation, kept apart from React so the event handling can be tested without a browser.
//
// The server sends a snapshot (`GET <base>/conversations/<id>`), then server-sent events after the snapshot's sequence number:
//   upsert { item } | append { id, text } | status { status, ok } | permission { request } | permission_done { id } | meta { title, mode, model, effort }
// `getState()` returns an immutable snapshot that changes identity on every update, so it can feed useSyncExternalStore.
//
// Messages the person queues while the agent works ("⌘⏎ to queue for later") are kept here, not on the server: when a turn ends normally the
// next one is sent; after a stop or a failure they wait until the person sends or removes them.

const RETRY_EVENTS_MS = 2000;
const RETRY_LOAD_MS = 4000;

export function createChatStore({ api, base, conversation, notify = () => {}, EventSourceImpl = globalThis.EventSource }) {
  const url = suffix => `${base}/conversations/${conversation.id}${suffix}`;
  const listeners = new Set();
  let items = new Map();
  let state = {
    items: [], pending: [], status: 'idle', canSteer: false, loaded: false, title: conversation.title, mode: conversation.mode,
    model: conversation.model || '', effort: conversation.effort || '', runningSince: null, queue: [],
  };
  let queued = 0;
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
      case 'status':
        // `runningMs` is how long the turn has run already; the page counts from its own clock so the two machines need not agree on the time.
        publish({ status: event.status, runningSince: event.status === 'running' ? Date.now() - (event.runningMs || 0) : null });
        if (event.status === 'idle' && event.ok === true) void sendNext();
        break;
      case 'permission':
        if (!state.pending.some(request => request.id === event.request.id)) publish({ pending: [...state.pending, event.request] });
        break;
      case 'permission_done': publish({ pending: state.pending.filter(request => request.id !== event.id) }); break;
      case 'meta':
        publish({
          ...(event.title ? { title: event.title } : {}), ...(event.mode ? { mode: event.mode } : {}),
          ...(event.model ? { model: event.model } : {}), ...(event.effort ? { effort: event.effort } : {}),
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
      });
      follow();
    } catch (error) {
      if (!disposed) { notify(`Could not load the chat: ${error.message}`); retry = setTimeout(load, RETRY_LOAD_MS); }
    }
  }

  // Resolves to true when the server took the message.
  async function send(body) {
    try {
      await api.post(url('/messages'), body);
      return true;
    } catch (error) {
      notify(error.message === 'CONVERSATION_BUSY' ? 'The agent is still working' : `Could not send: ${error.message}`);
      return false;
    }
  }

  const label = body => (body.text || [...(body.images || []), ...(body.files || [])].map(file => file.name).join(', ')).replace(/\s+/g, ' ').slice(0, 80);
  function enqueue(body) {
    publish({ queue: [...state.queue, { id: ++queued, body, label: label(body) }] });
  }
  function unqueue(id) { publish({ queue: state.queue.filter(entry => entry.id !== id) }); }
  // Sends one queued message now (the agent takes it into the running turn when it can, otherwise it starts the next one).
  async function sendQueued(id) {
    const entry = state.queue.find(item => item.id === id);
    if (!entry) return false;
    unqueue(id);
    const sent = await send(entry.body);
    if (!sent) publish({ queue: [entry, ...state.queue] }); // it stays in the list for another try
    return sent;
  }
  async function sendNext() {
    if (state.queue.length && !disposed) await sendQueued(state.queue[0].id);
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

  async function stop() {
    try { await api.post(url('/interrupt'), {}); } catch (error) { notify(`Could not stop: ${error.message}`); }
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
    load, send, stop, answer, setMode, rename, enqueue, unqueue, sendQueued, apply,
    destroy() {
      disposed = true;
      clearTimeout(retry);
      if (source) source.close();
      listeners.clear();
    },
  };
}

// State of one agent conversation, kept apart from React so the event handling can be tested without a browser.
//
// The server sends a snapshot (`GET <base>/conversations/<id>`), then server-sent events after the snapshot's sequence number:
//   upsert { item } | append { id, text } | status { status } | permission { request } | permission_done { id } | meta { title, mode }
// `getState()` returns an immutable snapshot that changes identity on every update, so it can feed useSyncExternalStore.

const RETRY_EVENTS_MS = 2000;
const RETRY_LOAD_MS = 4000;

export function createChatStore({ api, base, conversation, notify = () => {}, EventSourceImpl = globalThis.EventSource }) {
  const url = suffix => `${base}/conversations/${conversation.id}${suffix}`;
  const listeners = new Set();
  let items = new Map();
  let state = { items: [], pending: [], status: 'idle', canSteer: false, loaded: false, title: conversation.title, mode: conversation.mode };
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
      case 'status': publish({ status: event.status }); break;
      case 'permission':
        if (!state.pending.some(request => request.id === event.request.id)) publish({ pending: [...state.pending, event.request] });
        break;
      case 'permission_done': publish({ pending: state.pending.filter(request => request.id !== event.id) }); break;
      case 'meta': publish({ ...(event.title ? { title: event.title } : {}), ...(event.mode ? { mode: event.mode } : {}) }); break;
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
    load, send, stop, answer, setMode, apply,
    destroy() {
      disposed = true;
      clearTimeout(retry);
      if (source) source.close();
      listeners.clear();
    },
  };
}

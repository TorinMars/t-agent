// Entry of the chat view bundle (public/js/agent-chat-ui.js). public/js/agent-chat.js loads it on the first chat that is opened and
// calls `mount`; build it with `npm run build:agent-chat`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createChatStore } from './store.mjs';
import { Chat } from './ui.jsx';

export function mount(container, { api, base, conversation, agent, onClose, onTitle = () => {}, onTurn = () => {}, onOpenChat = () => {}, draft = null, notify = () => {} }) {
  const store = createChatStore({ api, base, conversation, agent, notify });
  // The page that holds the chat shows its name too (the phone header), so it is told whenever the title changes (a rename, or the first message).
  let title = conversation.title;
  // The host is also told when a turn ends (not when the person stopped it), with the last thing the agent said, so it can notify the person.
  let turn = null;
  const lastText = items => { for (let index = items.length - 1; index >= 0; index -= 1) if (items[index].kind === 'text' && items[index].text) return items[index].text; return ''; };
  store.subscribe(() => {
    const state = store.getState();
    if (state.title !== title) { title = state.title; onTitle(title); }
    if (state.lastTurn && state.lastTurn !== turn) { turn = state.lastTurn; onTurn({ ...turn, title: state.title, summary: lastText(state.items) }); }
  });
  const host = document.createElement('div');
  host.className = 'agent-chat-host';
  container.replaceChildren(host);
  const root = createRoot(host);
  const handle = React.createRef();
  flushSync(() => root.render(<Chat ref={handle} store={store} agent={agent} conversation={conversation} onClose={onClose} notify={notify} onOpenChat={onOpenChat} draft={draft ? { text: draft } : null} />));
  void store.load();
  return {
    root: host,
    focus: () => { if (handle.current) handle.current.focus(); },
    destroy() {
      store.destroy();
      root.unmount();
      host.remove();
    },
  };
}

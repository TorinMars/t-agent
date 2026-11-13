// Entry of the chat view bundle (public/js/agent-chat-ui.js). public/js/agent-chat.js loads it on the first chat that is opened and
// calls `mount`; build it with `npm run build:agent-chat`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createChatStore } from './store.mjs';
import { Chat } from './ui.jsx';

export function mount(container, { api, base, conversation, agent, onClose, onTitle = () => {}, onOpenChat = () => {}, draft = null, notify = () => {}, hostTabs = false, onViews = () => {} }) {
  const store = createChatStore({ api, base, conversation, agent, notify });
  // The page that holds the chat shows its name too (the phone header), so it is told whenever the title changes (a rename, or the first message).
  let title = conversation.title;
  store.subscribe(() => {
    const state = store.getState();
    if (state.title !== title) { title = state.title; onTitle(title); }
  });
  const host = document.createElement('div');
  host.className = 'agent-chat-host';
  container.replaceChildren(host);
  const root = createRoot(host);
  const handle = React.createRef();
  flushSync(() => root.render(<Chat ref={handle} store={store} agent={agent} conversation={conversation} onClose={onClose} notify={notify} onOpenChat={onOpenChat} draft={draft ? { text: draft } : null} hostTabs={hostTabs} onViews={onViews} />));
  void store.load();
  return {
    root: host,
    focus: () => { if (handle.current) handle.current.focus(); },
    setView: id => { if (handle.current) handle.current.setView(id); },
    setForeground: value => store.setForeground(value), // the page shows the chat on a screen the person uses (presence for the notifiers)
    destroy() {
      store.destroy();
      root.unmount();
      host.remove();
    },
  };
}

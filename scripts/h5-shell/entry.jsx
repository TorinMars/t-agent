// The Material UI shell of the phone page (/h5). It is drawn at once, while the page is still being parsed (flushSync), so that the scripts after it
// (voice-input.js, agent-activity.js, h5.js ...) find #h5-translate-input, #h5-voice, #agent-activity and the rest where they have always been.
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createStore, initialState } from './store.mjs';

const ui = createStore({ ...initialState(), wide: window.matchMedia('(min-width: 900px)').matches });
let notices = 0;
ui.notify = (message, type = 'info') => {
  const text = String(message === undefined || message === null ? '' : message).trim();
  if (text) ui.set({ notice: { id: ++notices, message: text, type } });
};
window.H5UI = ui;
// The floating notices of every script of the page (voice input, chat, uploads) go through the shell.
window.notify = (message, type) => ui.notify(message, type);
window.Toast = { show: (message, options = {}) => ui.notify(message, options.type), error: message => ui.notify(message, 'error'), success: message => ui.notify(message, 'success') };

const root = createRoot(document.getElementById('h5-root'));
flushSync(() => root.render(<App ui={ui} />));

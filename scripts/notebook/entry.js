// The shell notebook view, loaded by public/js/notebook.js the first time a notebook session is opened (build: npm run build:notebook, an IIFE with
// the global NotebookUI). The styles are in the bundle, as text, so nothing is loaded before a notebook is opened.
import css from './notebook.css';
import { mountView } from './view.js';

function addStyles() {
  if (document.getElementById('nb-styles')) return;
  const style = document.createElement('style');
  style.id = 'nb-styles';
  style.textContent = css;
  document.head.append(style);
}

// NotebookUI.mount(host, { api, base, notebookId, title, notify, onTitle, embedded }) -> { destroy(), flush(), setActive(on) } (and action(name), used
// by the page header's menu). See "Mount" in docs/design/shell-notebook-page.md for the options the page adds.
export function mount(host, options) {
  addStyles();
  return mountView(host, options || {});
}

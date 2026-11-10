// The heavy part of the mind map view, loaded by public/js/mindmap.js when the view is first opened (build: npm run build:mindmap). The styles are in the bundle, as text, so
// that nothing is loaded before the person asks for the view.
import libraryCss from 'mind-elixir/style.css';
import viewCss from './mindmap.css';
import { mountApp } from './app.js';

function addStyles() {
  if (document.getElementById('mm-styles')) return;
  const style = document.createElement('style');
  style.id = 'mm-styles';
  style.textContent = `${libraryCss}\n${viewCss}`;
  document.head.append(style);
}

export function mount(root, options) {
  addStyles();
  return mountApp(root, options);
}

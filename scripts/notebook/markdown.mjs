// Text cells: the page's Markdown renderer (marked and css/markdown.css, the same files and the same safety rules as the design document sheet,
// scripts/h5-shell/Design.jsx). They are loaded the first time a text cell is drawn, asked for by the hash of their content when the page carries it
// (window.TAAsset, lib/static-assets.js). Raw HTML is shown as text; only web and mail links and web images are live.
const MARKED_SRC = '/vendor/marked/marked-15.0.12.min.js';
const MARKDOWN_CSS = '/css/markdown.css';
const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^(https?:|data:image\/(png|jpeg|gif|webp);)/i;

const assetUrl = path => (typeof window.TAAsset === 'function' ? window.TAAsset(path) : path);
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const loads = new Map();
function loadOnce(src, css = false) {
  if (!loads.has(src)) {
    const done = new Promise((resolve, reject) => {
      const node = document.createElement(css ? 'link' : 'script');
      const url = assetUrl(src);
      if (css) { node.rel = 'stylesheet'; node.href = url; } else node.src = url;
      node.onload = resolve;
      node.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(node);
    });
    done.catch(() => loads.delete(src)); // tried again next time
    loads.set(src, done);
  }
  return loads.get(src);
}

let marked = null;
function renderer() {
  if (marked || !window.marked) return marked;
  marked = new window.marked.Marked({
    renderer: {
      html({ text }) { return escapeHtml(text); },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (!SAFE_LINK.test(href || '')) return `<span class="nb-md-link">${inner}</span>`;
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
      },
      image({ href, title, text }) {
        if (!SAFE_IMAGE.test(href || '')) return `<span class="nb-md-image">${escapeHtml(text || href || '')}</span>`;
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
    },
  });
  return marked;
}

// Draws `source` into `node`: at once when the renderer is here, else as plain text first and as Markdown when it has loaded (unless the node
// was given another text meanwhile).
export function renderMarkdown(node, source) {
  node.dataset.source = source;
  const ready = renderer();
  if (ready) { node.innerHTML = ready.parse(source); return; }
  const plain = document.createElement('div');
  plain.className = 'nb-md-plain';
  plain.textContent = source;
  node.replaceChildren(plain);
  Promise.all([loadOnce(MARKED_SRC), loadOnce(MARKDOWN_CSS, true)]).then(() => {
    const later = renderer();
    if (later && node.isConnected && node.dataset.source === source) node.innerHTML = later.parse(source);
  }).catch(() => { /* the plain text stays */ });
}

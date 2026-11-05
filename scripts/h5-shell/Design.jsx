import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { imagePath, renderText } from './file-view.mjs';

// The Markdown renderer the app already ships (the desktop document view uses the same files). They are loaded the first time the sheet shows a
// document, from this server; mermaid (about 5 MB) only when the document has a diagram. Keep the versions in step with scripts/vendor-libs.json.
const MARKED_SRC = '/vendor/marked/marked-15.0.12.min.js';
const MARKDOWN_VIEW_SRC = '/js/markdown-view.js';
const MARKDOWN_CSS = '/css/markdown.css';
const MERMAID_SRC = '/vendor/mermaid/mermaid-12.1.0.min.js';

const loads = new Map();
function loadOnce(src, css = false) {
  if (!loads.has(src)) {
    const done = new Promise((resolve, reject) => {
      const node = document.createElement(css ? 'link' : 'script');
      if (css) { node.rel = 'stylesheet'; node.href = src; } else node.src = src;
      node.onload = resolve;
      node.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(node);
    });
    done.catch(() => loads.delete(src)); // a failed load is tried again next time
    loads.set(src, done);
  }
  return loads.get(src);
}
let mermaidReady = null;
function ensureMermaid() {
  if (!mermaidReady) {
    mermaidReady = loadOnce(MERMAID_SRC).then(() => window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' }));
    mermaidReady.catch(() => { mermaidReady = null; });
  }
  return mermaidReady;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^(https?:|data:image\/(png|jpeg|gif|webp);)/i;
// The document is shown, not trusted: raw HTML is shown as text, and only web / mail links and web images are live (a relative link shows its text).
// A relative image inside the working directory is read through the task file API (`imageUrl(path)`: PNG, JPEG, GIF or WebP, at most 5 MB); one that
// cannot be shown (outside the folder, another type, missing, an older Engine) shows its text.
function renderMarkdown(source, docPath, imageUrl) {
  const marked = new window.marked.Marked({
    renderer: {
      html({ text }) { return escapeHtml(text); },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (!SAFE_LINK.test(href || '')) return `<span class="h5-design-link">${inner}</span>`;
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
      },
      image({ href, title, text }) {
        const local = !SAFE_IMAGE.test(href || '') && imageUrl ? imagePath(docPath, href) : null;
        if (local) return `<img src="${escapeHtml(imageUrl(local))}" alt="${escapeHtml(text || '')}" data-h5-local="${escapeHtml(href || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
        if (!SAFE_IMAGE.test(href || '')) return `<span class="h5-design-image">${escapeHtml(text || href || '')}</span>`;
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
    },
  });
  return marked.parse(source);
}

const ERRORS = {
  FILE_TOO_LARGE: 'DESIGN.md is larger than 5 MB',
  FILE_UNSUPPORTED: 'DESIGN.md is not a plain text file',
  FILE_FORBIDDEN: 'DESIGN.md cannot be read',
};
// The same for a file opened from a terminal link.
const FILE_ERRORS = {
  FILE_TOO_LARGE: 'The file is larger than 5 MB',
  FILE_UNSUPPORTED: 'This is not a plain text file',
  FILE_FORBIDDEN: 'The file cannot be read',
};
const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

// A file that is not Markdown is shown as plain text with line numbers (renderText, scripts/h5-shell/file-view.mjs: only the lines in view are drawn).
// A relative image that does not load shows its text instead.
const localImageFailed = event => {
  const img = event.target;
  if (!img || !img.dataset || img.dataset.h5Local === undefined) return;
  const span = document.createElement('span');
  span.className = 'h5-design-image';
  span.textContent = img.alt || img.dataset.h5Local;
  img.replaceWith(span);
};

// A swipe down closes the bottom sheet (what MUI's SwipeableDrawer did, in a few lines and without its 7 KB). The finger moves the sheet with it;
// letting go after 25% of the sheet's height, or after a quick flick down, closes it, else it slides back. A swipe that starts on the document
// while it is scrolled away from its top scrolls the document instead. The sheet's closing slide starts from where the finger left it.
function useSwipeDown(onClose) {
  const drag = useRef(null);
  const paper = event => event.currentTarget;
  const onTouchStart = event => {
    if (event.touches.length !== 1) { drag.current = null; return; }
    const body = event.target.closest('.h5-design-body');
    if (body && body.scrollTop > 0) { drag.current = null; return; }
    drag.current = { y: event.touches[0].clientY, x: event.touches[0].clientX, t: performance.now(), dy: 0, active: false };
  };
  const onTouchMove = event => {
    const d = drag.current;
    if (!d) return;
    const dy = event.touches[0].clientY - d.y;
    const dx = event.touches[0].clientX - d.x;
    if (!d.active) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { drag.current = null; return; } // up or sideways: a scroll, not a swipe
      d.active = true;
    }
    d.dy = Math.max(0, dy);
    const node = paper(event);
    node.style.transition = 'none';
    node.style.transform = `translateY(${d.dy}px)`;
  };
  const onTouchEnd = event => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.active) return;
    const node = paper(event);
    const speed = d.dy / Math.max(1, performance.now() - d.t); // px per ms
    node.style.transition = '';
    if (d.dy > node.offsetHeight * 0.25 || (speed > 0.6 && d.dy > 40)) { onClose(); return; } // the closing slide starts from here
    node.style.transition = 'transform 200ms cubic-bezier(0, 0, 0.2, 1)';
    node.style.transform = 'none';
  };
  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd };
}

// The design document of the task, in a sheet that slides up from the bottom (h5.js `openDesign` reads `DESIGN.md` from the task's working directory
// through the task file API and writes `state.design`). Closes with the close button, a tap on the dimmed page, Escape or a swipe down.
// The page behind is not resized: no scroll lock (it would change the body padding), and the terminal keeps its size, so no PTY resize is sent.
export function DesignSheet({ state, ui }) {
  const design = state.design;
  const open = Boolean(design && design.open);
  const side = Boolean(state.wide); // a wide screen shows the file beside the terminal, a narrow one in a sheet from the bottom
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [node, setNode] = useState(null); // the content box; it is mounted again each time the sheet opens, so the document is drawn again
  const [render, setRender] = useState({ status: 'idle' }); // the rendering of a loaded document: idle | rendering | done | failed
  const content = design && design.status === 'ready' ? design.content : null;
  const filePathInDir = (design && design.path) || 'DESIGN.md';
  const fromLink = Boolean(design && design.link);
  const markdown = !fromLink || MARKDOWN_FILE.test(filePathInDir);
  const line = (design && design.line) || null;
  const imageBase = (design && design.imageBase) || null; // `${files}/image?path=` of the task (h5.js openFileSheet)

  useEffect(() => {
    if (content === null || !node) return undefined;
    let cancelled = false;
    let view = null; // the plain-text view, which listens to the scrolling of the box
    setRender({ status: 'rendering' });
    (async () => {
      try {
        if (!markdown) { view = renderText(node, content, line); setRender({ status: 'done' }); return; }
        await Promise.all([loadOnce(MARKED_SRC), loadOnce(MARKDOWN_VIEW_SRC), loadOnce(MARKDOWN_CSS, true)]);
        if (cancelled) return;
        node.innerHTML = renderMarkdown(content, filePathInDir, imageBase ? path => `${imageBase}${encodeURIComponent(path)}` : null);
        for (const img of node.querySelectorAll('img[data-h5-local]')) img.addEventListener('error', localImageFailed);
        window.MarkdownView.enhance(node);
        node.scrollTop = 0;
        setRender({ status: 'done' });
        const diagrams = [...node.querySelectorAll('.mermaid')];
        if (diagrams.length) {
          await ensureMermaid();
          if (!cancelled) await window.mermaid.run({ nodes: diagrams }).catch(() => { /* a broken diagram keeps its source text */ });
        }
      } catch {
        if (!cancelled) setRender({ status: 'failed' });
      }
    })();
    return () => { cancelled = true; if (view) view.dispose(); };
  }, [content, node, markdown, line, filePathInDir, imageBase]);

  const close = () => ui.actions.closeDesign();
  const swipe = useSwipeDown(close);
  const dir = design && design.dir;
  let note = null;
  const name = filePathInDir.replace(/\/+$/, '').split('/').pop() || filePathInDir;
  if (design && fromLink) {
    if (design.status === 'no-task') note = t('Choose a task first');
    else if (design.status === 'no-dir') note = t('This task has no working directory');
    else if (design.status === 'folder') note = t('Folders cannot be shown on the phone');
    else if (design.status === 'missing') note = t(`Not found in the working directory: ${filePathInDir}`);
    else if (design.status === 'error') note = t(FILE_ERRORS[design.message] || 'Could not open the file');
    else if (design.status === 'ready' && render.status === 'failed') note = t('Could not show the file');
  } else if (design) {
    if (design.status === 'no-task') note = t('Choose a task first');
    else if (design.status === 'no-dir') note = t('This task has no working directory');
    else if (design.status === 'missing') note = dir ? t(`No DESIGN.md in ${dir}`) : t('No DESIGN.md in the working directory of this task');
    else if (design.status === 'error') note = t(ERRORS[design.message] || 'Could not open DESIGN.md');
    else if (design.status === 'ready' && render.status === 'failed') note = t('Could not show DESIGN.md');
  }
  const loading = design && (design.status === 'loading' || (design.status === 'ready' && render.status === 'rendering'));
  const filePath = dir ? `${dir.replace(/\/+$/, '')}/${filePathInDir}` : filePathInDir;

  const contents = (
    <>
      {side ? null : (
        <Box className="h5-design-handle" aria-hidden="true" sx={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', pt: 1, pb: 0.5 }}>
          <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'text.disabled' }} />
        </Box>
      )}
      <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, pb: 1, pt: side ? 1 : 0, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography id="h5-design-title" variant="subtitle1" component="h2" sx={{ fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} translate={fromLink ? 'no' : undefined}>{fromLink ? name : t('Design document')}</Typography>
          <Typography id="h5-design-path" variant="caption" component="div" color="text.secondary" translate="no" title={filePath}
            sx={{ fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}
          ><bdi>{filePath}</bdi></Typography>
        </Box>
        <IconButton id="h5-design-close" {...named(t('Close'))} onClick={close}><Icon name="close" size={22} /></IconButton>
      </Box>
      {loading ? <LinearProgress id="h5-design-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto' }} /> : null}
      {note ? (
        <Box id="h5-design-empty" role="status" sx={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, textAlign: 'center', color: 'text.secondary', overflowWrap: 'anywhere' }}>{note}</Box>
      ) : null}
      <Box
        ref={setNode} id="h5-design-body" className="h5-design-body" tabIndex={0}
        sx={{ display: note || content === null ? 'none' : 'block', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', px: 2, pt: 2, pb: 4 }}
      />
    </>
  );
  if (side) {
    // A wide screen: a panel on the right beside the terminal (a persistent drawer: the page is not dimmed and stays usable). h5.css narrows the page
    // while it is open (`html[data-side-panel]`), so the terminal refits once to the width that is left. Escape inside the panel closes it.
    return (
      <Drawer
        variant="persistent" anchor="right" id="h5-design-sheet" open={open} transitionDuration={reduced ? 0 : undefined}
        slotProps={{ paper: { className: 'h5-design-panel h5-design-side', role: 'complementary', 'aria-labelledby': 'h5-design-title', onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }, sx: { width: 'var(--h5-side-width)', height: '100%', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: 1, borderColor: 'divider' } } }}
      >
        {contents}
      </Drawer>
    );
  }
  return (
    <Drawer
      anchor="bottom" id="h5-design-sheet" open={open} onClose={close} transitionDuration={reduced ? 0 : undefined}
      ModalProps={{ disableScrollLock: true }}
      slotProps={{ paper: { className: 'h5-design-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-design-title', ...swipe, sx: { height: '88dvh', maxWidth: 960, width: '100%', mx: 'auto', borderRadius: '16px 16px 0 0', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      {contents}
    </Drawer>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { imagePath, renderText, splitHighlighted } from './file-view.mjs';
import { RAW_KINDS, kindOf, languageOf } from './file-kinds.mjs';
import { formatJson } from './file-formats.mjs';
import { CsvTable, HtmlPreview, ImageView, MediaView, PdfView } from './FileViewers.jsx';
import { buildOutline, currentIndex } from './outline.mjs';
import { ImageViewer } from './ImageViewer.jsx';

// The Markdown renderer the app ships (the /share/:token pages use the same files). They are loaded the first time the sheet shows a
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
// A relative image inside the working directory is read through the task file API (`imageUrl(path)`: PNG, JPEG, GIF, WebP, SVG, BMP, ICO or AVIF, at
// most 20 MB); one that cannot be shown (outside the folder, another type, missing, an older Engine) shows its text.
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
// The any-path read of a file outside the working directory (`/fs/content`) has codes of its own. IS_DIRECTORY and NOT_FOUND are states
// (h5.js openAnyFile); FS_READ_UNSUPPORTED (an Engine without 'fs:read-any') closes the sheet with the old note.
const FS_ERRORS = {
  BAD_PATH: 'This path cannot be opened',
  NOT_A_REGULAR_FILE: 'This is not a plain file',
  PERMISSION_DENIED: 'The file cannot be read',
  FILE_TOO_LARGE: 'The file is larger than 5 MB',
  FILE_UNSUPPORTED: 'This is not a plain text file',
  FILE_PATH_CHANGED: 'The file changed while it was read',
  READ_TIMEOUT: 'Reading the file took too long',
};
// An image, PDF, audio or video file has notes of its own for some codes (its limits are not the text read's 5 MB).
const IMAGE_ERRORS = {
  FILE_TOO_LARGE: 'The image is larger than 20 MB',
  FILE_UNSUPPORTED: 'This image type cannot be shown',
  FILE_NOT_IMAGE: 'This image type cannot be shown',
  MEDIA_ERROR: 'This image cannot be shown',
};
const RAW_ERRORS = {
  FILE_TOO_LARGE: 'The file is larger than 200 MB',
  FILE_UNSUPPORTED: 'This file type cannot be shown',
  RAW_UNSUPPORTED: 'This Engine cannot show this file type',
  MEDIA_ERROR: 'This browser cannot play this file',
};

// A file that is not Markdown is shown by its kind (file-kinds.mjs): text with line numbers (renderText, scripts/h5-shell/file-view.mjs: only the lines
// in view are drawn), syntax-highlighted by highlight.js up to HIGHLIGHT_LIMIT characters (larger files stay plain: highlighting them would hold the
// phone up for seconds); JSON pretty-printed, CSV / TSV as a table, HTML as its source with a sandboxed preview; images, PDF, audio and video in their
// viewers (FileViewers.jsx).
const HIGHLIGHT_LIMIT = 1024 * 1024;
// The views a kind can switch between (the toggle under the header); the first is the default.
const MODES = {
  json: [['formatted', 'Formatted'], ['source', 'Raw']],
  csv: [['table', 'Table'], ['source', 'Raw']],
  html: [['source', 'Code'], ['preview', 'Preview']],
};
// A relative image that does not load shows its text instead.
const localImageFailed = event => {
  const img = event.target;
  if (!img || !img.dataset || img.dataset.h5Local === undefined) return;
  const span = document.createElement('span');
  span.className = 'h5-design-image';
  span.textContent = img.alt || img.dataset.h5Local;
  img.replaceWith(span);
};

// The file sheets (the design document, the file viewer and the file tree) slide down from the top on every screen width: one look, 88% of the height, at
// most 1200px wide and centred. They are modals, so the page behind (sidebar, terminal, bottom bar) is dimmed and not resized.
export const TOP_SHEET_PAPER = { height: '88dvh', maxWidth: 1200, width: '100%', mx: 'auto', borderRadius: '0 0 16px 16px', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', pt: 'env(safe-area-inset-top)' };

// The grip at the bottom edge of a top sheet (phone only: a computer has the Close button, Escape and a click beside the sheet).
export function SheetHandle() {
  return (
    <Box className="h5-design-handle" aria-hidden="true" sx={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', pt: 0.5, pb: 1 }}>
      <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'text.disabled' }} />
    </Box>
  );
}

// True when the touch began inside something that can still scroll further down (the document, the tree, a table), so a swipe up there is reading on.
function scrollsFurther(node, paper) {
  for (let el = node; el && el !== paper; el = el.parentElement) {
    if (el.scrollHeight - el.clientHeight - el.scrollTop > 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

// A swipe up closes the top sheet (what MUI's SwipeableDrawer did, in a few lines and without its 7 KB). The finger moves the sheet with it; letting go
// after 25% of the sheet's height, or after a quick flick up, closes it, else it slides back. A swipe that starts on content that can still scroll down
// scrolls that content instead. The sheet's closing slide starts from where the finger left it.
export function useSwipeUp(onClose) {
  const drag = useRef(null);
  const paper = event => event.currentTarget;
  const onTouchStart = event => {
    if (event.touches.length !== 1) { drag.current = null; return; }
    // A touch in the outline list (a drawer of its own, whose React events still bubble through the sheet) never drags the sheet.
    if (!event.currentTarget.contains(event.target)) { drag.current = null; return; }
    if (scrollsFurther(event.target, event.currentTarget)) { drag.current = null; return; }
    drag.current = { y: event.touches[0].clientY, x: event.touches[0].clientX, t: performance.now(), dy: 0, active: false };
  };
  const onTouchMove = event => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - event.touches[0].clientY; // how far up the finger has moved
    const dx = event.touches[0].clientX - d.x;
    if (!d.active) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { drag.current = null; return; } // down or sideways: a scroll, not a swipe
      d.active = true;
    }
    d.dy = Math.max(0, dy);
    const node = paper(event);
    node.style.transition = 'none';
    node.style.transform = `translateY(${-d.dy}px)`;
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

// The outline of a Markdown document: its h1-h3 headings (outline.mjs), indented by level, the section being read marked (`aria-current`). A click
// scrolls the document to that heading. Heading texts are the document's own, so the translation layer leaves them alone (translate="no").
const SECTION_LINE = 40; // px from the top of the document view: a heading above this line has started the section being read
const JUMP_GAP = 8; // px left above a heading the outline scrolled to
const OUTLINE_KEY = 'h5-design-outline'; // wide screens: the outline column shown ('1') or folded away ('0'); unset: shown
const readColumnOpen = () => {
  try { return localStorage.getItem(OUTLINE_KEY) !== '0'; } catch { return true; } // the sheet is at least 900px wide, so the column always fits
};
function OutlineList({ outline, current, onPick, sx }) {
  const nav = useRef(null);
  const top = Math.min(...outline.map(item => item.level));
  useEffect(() => { // keeps the marked entry in view inside the list (only the list scrolls, never the page)
    const box = nav.current;
    const item = box && box.querySelector('[aria-current="location"]');
    if (!item) return;
    const itemTop = item.offsetTop - box.offsetTop;
    if (itemTop < box.scrollTop) box.scrollTop = itemTop - 8;
    else if (itemTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = itemTop + item.offsetHeight - box.clientHeight + 8;
  }, [current, outline]);
  return (
    <Box ref={nav} component="nav" id="h5-design-outline-list" aria-label={t('Outline')} sx={{ overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', position: 'relative', ...sx }}>
      <List dense disablePadding translate="no" sx={{ py: 0.5 }}>
        {outline.map(item => {
          const here = item.id === current;
          return (
            <ListItemButton
              key={item.id} component="a" href={`#${item.id}`} data-target={item.id} data-level={item.level} selected={here} aria-current={here ? 'location' : undefined}
              onClick={event => { event.preventDefault(); onPick(item.id); }}
              sx={{ pl: 1.5 + (item.level - top) * 1.75, pr: 1.5, py: 0.75, alignItems: 'center', borderLeft: 2, borderColor: here ? 'primary.main' : 'transparent', color: here ? 'primary.light' : item.level === top ? 'text.primary' : 'text.secondary' }}
            >
              <Box component="span" sx={{ fontSize: item.level === top ? 14 : 13, fontWeight: item.level === top ? 600 : 400, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>{item.text}</Box>
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}

// The design document of the task, in a sheet that slides down from the top on every screen width (h5.js `openDesign` reads `DESIGN.md` from the task's
// working directory through the task file API and writes `state.design`). Closes with the close button, a tap on the dimmed page, Escape or a swipe up.
// The page behind is not resized: no scroll lock (it would change the body padding), and the terminal keeps its size, so no PTY resize is sent.
export function DesignSheet({ state, ui }) {
  const design = state.design;
  const open = Boolean(design && design.open);
  const wide = Boolean(state.wide); // only the outline (a column, or a drawer on a narrow screen) and the handle differ by width
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [node, setNode] = useState(null); // the content box; it is mounted again each time the sheet opens, so the document is drawn again
  const [render, setRender] = useState({ status: 'idle' }); // the rendering of a loaded document: idle | rendering | done | failed
  const [outline, setOutline] = useState([]); // the h1-h3 headings of the rendered Markdown: [{ id, level, text }]
  const [current, setCurrent] = useState(null); // the id of the heading whose section is being read
  const [listOpen, setListOpen] = useState(false); // a narrow screen: the outline drawer is open
  const [columnOpen, setColumnOpen] = useState(readColumnOpen); // a wide screen: the outline column is shown
  const pinned = useRef(null); // the heading the outline scrolled to: it stays marked until the reader scrolls by hand
  const [viewer, setViewer] = useState(null); // the picture or diagram shown full screen (ImageViewer.jsx)
  const content = design && design.status === 'ready' && typeof design.content === 'string' ? design.content : null; // none for an image, PDF, audio or video file
  const filePathInDir = (design && design.path) || 'DESIGN.md';
  const fromLink = Boolean(design && design.link);
  const kind = (design && design.kind) || (fromLink ? kindOf(filePathInDir) : 'markdown'); // h5.js decides it (the same table); DESIGN.md is Markdown
  const markdown = kind === 'markdown';
  const line = (design && design.line) || null;
  const imageBase = (design && design.imageBase) || null; // `${files}/image?path=` of the task (h5.js openFileSheet)
  const src = (design && design.status === 'ready' && design.src) || null; // the address of an image, PDF, audio or video file (h5.js fileByUrl)
  const name = filePathInDir.replace(/\/+$/, '').split('/').pop() || filePathInDir;
  // One token per shown file: the chosen view (Formatted / Source ...) and a failure belong to it, so another file starts at its default view.
  const fileToken = useMemo(() => ({}), [content, src, filePathInDir]);
  const [picked, setPicked] = useState(null); // { token, mode }
  const [failed, setFailed] = useState(null); // { token, code }: the image or media file could not be shown
  const failure = failed && failed.token === fileToken ? failed.code : null;
  const formatted = useMemo(() => (kind === 'json' && content !== null ? formatJson(content) : null), [kind, content]);
  // A link that names a line shows the source, whose lines it counts.
  const modes = kind === 'json' ? (formatted !== null ? MODES.json : null) : MODES[kind] || null;
  const defaultMode = modes ? (line && modes.some(([value]) => value === 'source') ? 'source' : modes[0][0]) : null;
  const mode = picked && picked.token === fileToken && modes && modes.some(([value]) => value === picked.mode) ? picked.mode : defaultMode;
  // What the content box draws: Markdown, or lines of text in a language; null when a viewer of FileViewers.jsx shows the file instead.
  const plan = useMemo(() => {
    if (content === null) return null;
    if (markdown) return { type: 'markdown' };
    if (kind === 'json') return mode === 'formatted' ? { type: 'text', text: formatted, language: 'json', line: null } : { type: 'text', text: content, language: 'json', line };
    if (kind === 'csv') return mode === 'source' ? { type: 'text', text: content, language: null, line } : null;
    if (kind === 'html') return mode === 'source' ? { type: 'text', text: content, language: 'xml', line } : null;
    return { type: 'text', text: content, language: languageOf(filePathInDir), line };
  }, [content, markdown, kind, mode, formatted, line, filePathInDir]);

  useEffect(() => {
    if (!plan || !node) return undefined;
    let cancelled = false;
    let view = null; // the plain-text view, which listens to the scrolling of the box
    setRender({ status: 'rendering' });
    setOutline([]);
    (async () => {
      try {
        if (plan.type === 'text') {
          let html = null;
          if (plan.language && plan.text.length <= HIGHLIGHT_LIMIT) {
            try {
              await loadOnce(MARKDOWN_VIEW_SRC);
              if (cancelled) return;
              const marked = window.MarkdownView.highlight(plan.text.replace(/\r\n?/g, '\n'), plan.language);
              if (marked !== null && marked !== undefined) html = splitHighlighted(marked);
            } catch { /* the highlighter did not load: plain text */ }
          }
          if (cancelled) return;
          view = renderText(node, plan.text, plan.line, { html });
          setRender({ status: 'done' });
          return;
        }
        await Promise.all([loadOnce(MARKED_SRC), loadOnce(MARKDOWN_VIEW_SRC), loadOnce(MARKDOWN_CSS, true)]);
        if (cancelled) return;
        node.innerHTML = renderMarkdown(content, filePathInDir, imageBase ? path => `${imageBase}${encodeURIComponent(path)}` : null);
        for (const img of node.querySelectorAll('img[data-h5-local]')) img.addEventListener('error', localImageFailed);
        for (const img of node.querySelectorAll('img')) { img.tabIndex = 0; img.setAttribute('aria-haspopup', 'dialog'); } // a tap or Enter shows it full screen
        window.MarkdownView.enhance(node);
        node.scrollTop = 0;
        pinned.current = null;
        setOutline(buildOutline(node));
        setRender({ status: 'done' });
        const diagrams = [...node.querySelectorAll('.mermaid')];
        if (diagrams.length) {
          await ensureMermaid();
          if (!cancelled) await window.mermaid.run({ nodes: diagrams }).catch(() => { /* a broken diagram keeps its source text */ });
          for (const diagram of diagrams) {
            if (cancelled || !diagram.querySelector('svg')) continue;
            diagram.tabIndex = 0;
            diagram.setAttribute('role', 'button');
            diagram.setAttribute('aria-label', t('View diagram'));
            diagram.setAttribute('aria-haspopup', 'dialog');
          }
        }
      } catch {
        if (!cancelled) setRender({ status: 'failed' });
      }
    })();
    return () => { cancelled = true; if (view) view.dispose(); };
  }, [plan, content, node, filePathInDir, imageBase]);

  // The section being read follows the scrolling of the document (once per frame).
  useEffect(() => {
    if (!node || !outline.length) { setCurrent(null); return undefined; }
    let frame = 0;
    const heads = outline.map(item => node.querySelector(`#${CSS.escape(item.id)}`));
    const update = () => {
      frame = 0;
      if (pinned.current) return;
      const top = node.getBoundingClientRect().top;
      const index = currentIndex(heads.map(head => (head ? head.getBoundingClientRect().top - top : Infinity)), SECTION_LINE);
      setCurrent(index >= 0 ? outline[index].id : null);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const byHand = () => { pinned.current = null; };
    node.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) node.addEventListener(type, byHand, { passive: true });
    // A picture that loads or a diagram that is drawn after a jump moves the headings below it: the heading jumped to is put back in place.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const head = pinned.current && node.querySelector(`#${CSS.escape(pinned.current)}`);
      if (head) node.scrollTo({ top: Math.max(0, head.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - JUMP_GAP), behavior: 'auto' });
    }) : null;
    if (resized) for (const child of node.children) resized.observe(child);
    update();
    return () => {
      if (resized) resized.disconnect();
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) node.removeEventListener(type, byHand);
    };
  }, [node, outline]);
  useEffect(() => { if (!open) { setListOpen(false); setViewer(null); } }, [open]);

  // A tap (or Enter) on a picture or a rendered diagram of the document shows it full screen: the picture at its own resolution (the same src), the
  // diagram as a clone of its SVG.
  useEffect(() => {
    if (!node) return undefined;
    const pick = target => {
      if (!target || !target.closest) return null;
      const img = target.closest('img');
      if (img && node.contains(img)) return { kind: 'img', src: img.getAttribute('src') || img.currentSrc, alt: img.alt };
      const diagram = target.closest('.mermaid');
      const svg = diagram && node.contains(diagram) ? diagram.querySelector('svg') : null;
      return svg ? { kind: 'svg', svg } : null;
    };
    const onClick = event => {
      const item = pick(event.target);
      if (!item) return;
      event.preventDefault(); // a picture inside a link shows the picture
      setViewer(item);
    };
    const onKey = event => {
      if ((event.key !== 'Enter' && event.key !== ' ') || !(event.target.matches && event.target.matches('img, .mermaid'))) return;
      const item = pick(event.target);
      if (!item) return;
      event.preventDefault();
      setViewer(item);
    };
    node.addEventListener('click', onClick);
    node.addEventListener('keydown', onKey);
    return () => { node.removeEventListener('click', onClick); node.removeEventListener('keydown', onKey); };
  }, [node]);

  // Scrolls the document so the heading sits just below the top of the document view (the sheet's header is outside the scrolling box).
  const jump = id => {
    setListOpen(false);
    const head = node && node.querySelector(`#${CSS.escape(id)}`);
    if (!head) return;
    pinned.current = id;
    setCurrent(id);
    const top = head.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - JUMP_GAP;
    node.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
  };
  const toggleColumn = () => setColumnOpen(value => {
    try { localStorage.setItem(OUTLINE_KEY, value ? '0' : '1'); } catch { /* no storage */ }
    return !value;
  });
  // Opened from the file tree (FileTree.jsx), the file lies over the tree: the back arrow, Escape, the back button and a swipe up go back to the tree
  // (one layer); Close and a tap beside the sheet close both. Otherwise the header has a Files button that shows the tree instead.
  const fromTree = Boolean(state.files && state.files.open);
  const close = () => ui.actions.closeDesign();
  const closeAll = () => { if (fromTree) ui.actions.closeFiles(); ui.actions.closeDesign(); };
  const swipe = useSwipeUp(close);
  const dir = design && design.dir;
  let note = null;
  const kindErrors = kind === 'image' ? IMAGE_ERRORS : RAW_KINDS.has(kind) ? RAW_ERRORS : {};
  if (design && fromLink) {
    if (design.status === 'no-task') note = t('Choose a task first');
    else if (design.status === 'no-dir') note = t('This task has no working directory');
    else if (design.status === 'folder') note = t('Folders cannot be shown on the phone');
    else if (design.status === 'missing') note = design.absolute ? t(`Not found: ${filePathInDir}`) : t(`Not found in the working directory: ${filePathInDir}`);
    else if (design.status === 'error') note = t(kindErrors[design.message] || (design.absolute ? FS_ERRORS : FILE_ERRORS)[design.message] || 'Could not open the file');
    else if (design.status === 'ready' && failure) {
      if (failure === 'FILE_NOT_FOUND' || failure === 'NOT_FOUND') note = design.absolute ? t(`Not found: ${filePathInDir}`) : t(`Not found in the working directory: ${filePathInDir}`);
      else note = t(kindErrors[failure] || (design.absolute ? FS_ERRORS : FILE_ERRORS)[failure] || 'Could not show the file');
    } else if (design.status === 'ready' && render.status === 'failed') note = t('Could not show the file');
  } else if (design) {
    if (design.status === 'no-task') note = t('Choose a task first');
    else if (design.status === 'no-dir') note = t('This task has no working directory');
    else if (design.status === 'missing') note = dir ? t(`No DESIGN.md in ${dir}`) : t('No DESIGN.md in the working directory of this task');
    else if (design.status === 'error') note = t(ERRORS[design.message] || 'Could not open DESIGN.md');
    else if (design.status === 'ready' && render.status === 'failed') note = t('Could not show DESIGN.md');
  }
  const loading = design && (design.status === 'loading' || (design.status === 'ready' && plan && render.status === 'rendering'));
  const filePath = dir ? `${dir.replace(/\/+$/, '')}/${filePathInDir}` : filePathInDir;
  const hasOutline = markdown && outline.length > 0 && !note && content !== null;
  const showColumn = wide && hasOutline && columnOpen;
  const ready = Boolean(design && design.status === 'ready' && !note);
  const onFailed = code => setFailed({ token: fileToken, code });
  let viewerBox = null; // a file shown by a viewer of FileViewers.jsx
  if (ready && !plan) {
    if (kind === 'image' && src) viewerBox = <ImageView src={src} name={name} onView={setViewer} onFailed={onFailed} />;
    else if (kind === 'pdf' && src) viewerBox = <PdfView src={src} name={name} />;
    else if ((kind === 'audio' || kind === 'video') && src) viewerBox = <MediaView kind={kind} src={src} name={name} onFailed={onFailed} />;
    else if (kind === 'csv' && content !== null) viewerBox = <CsvTable content={content} path={filePathInDir} />;
    else if (kind === 'html' && content !== null) viewerBox = <HtmlPreview content={content} name={name} />;
  }
  const toolbar = ready && (modes || (kind === 'pdf' && src)) ? (
    <Box id="h5-file-toolbar" sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
      {modes ? (
        <ToggleButtonGroup id="h5-file-modes" size="small" exclusive value={mode} aria-label={t('View')} onChange={(event, value) => { if (value) setPicked({ token: fileToken, mode: value }); }}>
          {modes.map(([value, label]) => <ToggleButton key={value} value={value} data-mode={value} sx={{ px: 1.5, py: 0.25, fontSize: 13 }}>{t(label)}</ToggleButton>)}
        </ToggleButtonGroup>
      ) : null}
      {kind === 'pdf' && src ? <Button id="h5-file-open-tab" size="small" variant="outlined" component="a" href={src} target="_blank" rel="noopener noreferrer">{t('Open in new tab')}</Button> : null}
    </Box>
  ) : null;

  const contents = (
    <>
      <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, pl: fromTree ? 0.5 : 2, pr: 1, pb: 1, pt: 1, borderBottom: 1, borderColor: 'divider' }}>
        {fromTree ? <IconButton id="h5-design-back" {...named(t('Back to files'))} onClick={close}><Icon name="back" size={22} /></IconButton> : null}
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography id="h5-design-title" variant="subtitle1" component="h2" sx={{ fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} translate={fromLink ? 'no' : undefined}>{fromLink ? name : t('Design document')}</Typography>
          <Typography id="h5-design-path" variant="caption" component="div" color="text.secondary" translate="no" title={filePath}
            sx={{ fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}
          ><bdi>{filePath}</bdi></Typography>
        </Box>
        {hasOutline ? (
          wide ? (
            <IconButton id="h5-design-outline" {...named(t('Outline'))} aria-controls="h5-design-outline-list" aria-expanded={columnOpen} color={columnOpen ? 'primary' : 'default'} onClick={toggleColumn}><Icon name="outline" size={22} /></IconButton>
          ) : (
            <IconButton id="h5-design-outline" {...named(t('Outline'))} aria-haspopup="dialog" aria-expanded={listOpen} onClick={() => setListOpen(true)}><Icon name="outline" size={22} /></IconButton>
          )
        ) : null}
        {fromTree ? null : <IconButton id="h5-design-files" {...named(t('Files'))} onClick={() => ui.actions.openFiles()}><Icon name="folder" size={22} /></IconButton>}
        <IconButton id="h5-design-close" {...named(t('Close'))} onClick={closeAll}><Icon name="close" size={22} /></IconButton>
      </Box>
      {toolbar}
      {loading ? <LinearProgress id="h5-design-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto' }} /> : null}
      {note ? (
        <Box id="h5-design-empty" role="status" sx={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, textAlign: 'center', color: 'text.secondary', overflowWrap: 'anywhere' }}>{note}</Box>
      ) : null}
      {viewerBox ? <Box sx={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>{viewerBox}</Box> : null}
      <Box sx={{ display: note || !plan ? 'none' : 'flex', flex: '1 1 auto', minHeight: 0 }}>
        <Box
          ref={setNode} id="h5-design-body" className="h5-design-body" tabIndex={0}
          sx={{ display: 'block', flex: '1 1 auto', minWidth: 0, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', px: 2, pt: 2, pb: 4 }}
        />
        {showColumn ? (
          // A wide screen: the outline is a column on the right of the document, scrolling on its own.
          <OutlineList outline={outline} current={current} onPick={jump} sx={{ flex: '0 0 clamp(140px, 32%, 220px)', borderLeft: 1, borderColor: 'divider' }} />
        ) : null}
      </Box>
      {wide ? null : <SheetHandle />}
      {!wide && hasOutline ? (
        // A narrow screen: the outline is a drawer from the right, over the sheet (a modal of its own: Escape, a tap beside it and the back button close it).
        <Drawer
          anchor="right" open={listOpen} onClose={() => setListOpen(false)} transitionDuration={reduced ? 0 : undefined} ModalProps={{ disableScrollLock: true }}
          slotProps={{ paper: { id: 'h5-design-outline-panel', role: 'dialog', 'aria-labelledby': 'h5-design-outline-title', sx: { width: 'min(86vw, 360px)', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } } }}
        >
          <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
            <Typography id="h5-design-outline-title" variant="subtitle1" component="h2" sx={{ flex: '1 1 auto', fontWeight: 600 }}>{t('Outline')}</Typography>
            <IconButton id="h5-design-outline-close" {...named(t('Close outline'))} onClick={() => setListOpen(false)}><Icon name="close" size={22} /></IconButton>
          </Box>
          <OutlineList outline={outline} current={current} onPick={jump} sx={{ flex: '1 1 auto', minHeight: 0 }} />
        </Drawer>
      ) : null}
      <ImageViewer item={viewer} onClose={() => setViewer(null)} />
    </>
  );
  return (
    <Drawer
      anchor="top" id="h5-design-sheet" open={open} onClose={(event, reason) => (reason === 'backdropClick' ? closeAll() : close())} transitionDuration={reduced ? 0 : undefined}
      ModalProps={{ disableScrollLock: true }}
      slotProps={{ backdrop: fromTree ? { sx: { bgcolor: 'transparent' } } : undefined, paper: { className: 'h5-design-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-design-title', ...swipe, sx: TOP_SHEET_PAPER } }}
    >
      {contents}
    </Drawer>
  );
}

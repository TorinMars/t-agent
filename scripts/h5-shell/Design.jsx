import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { imagePath, renderText } from './file-view.mjs';
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
    // A touch in the outline list (a drawer of its own, whose React events still bubble through the sheet) never drags the sheet.
    if (!event.currentTarget.contains(event.target)) { drag.current = null; return; }
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

// The outline of a Markdown document: its h1-h3 headings (outline.mjs), indented by level, the section being read marked (`aria-current`). A click
// scrolls the document to that heading. Heading texts are the document's own, so the translation layer leaves them alone (translate="no").
const SECTION_LINE = 40; // px from the top of the document view: a heading above this line has started the section being read
const JUMP_GAP = 8; // px left above a heading the outline scrolled to
const OUTLINE_KEY = 'h5-design-outline'; // wide screens: the outline column shown ('1') or folded away ('0'); unset: shown when the panel is wide enough
const readColumnOpen = () => {
  try { const saved = localStorage.getItem(OUTLINE_KEY); if (saved === '1' || saved === '0') return saved === '1'; } catch { /* no storage */ }
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1140px)').matches; // the side panel (42vw) is then about 480px or more
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
  const [outline, setOutline] = useState([]); // the h1-h3 headings of the rendered Markdown: [{ id, level, text }]
  const [current, setCurrent] = useState(null); // the id of the heading whose section is being read
  const [listOpen, setListOpen] = useState(false); // a narrow screen: the outline drawer is open
  const [columnOpen, setColumnOpen] = useState(readColumnOpen); // a wide screen: the outline column is shown
  const pinned = useRef(null); // the heading the outline scrolled to: it stays marked until the reader scrolls by hand
  const [viewer, setViewer] = useState(null); // the picture or diagram shown full screen (ImageViewer.jsx)
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
    setOutline([]);
    (async () => {
      try {
        if (!markdown) { view = renderText(node, content, line); setRender({ status: 'done' }); return; }
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
  }, [content, node, markdown, line, filePathInDir, imageBase]);

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
  const hasOutline = markdown && outline.length > 0 && !note && content !== null;
  const showColumn = side && hasOutline && columnOpen;

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
        {hasOutline ? (
          side ? (
            <IconButton id="h5-design-outline" {...named(t('Outline'))} aria-controls="h5-design-outline-list" aria-expanded={columnOpen} color={columnOpen ? 'primary' : 'default'} onClick={toggleColumn}><Icon name="outline" size={22} /></IconButton>
          ) : (
            <IconButton id="h5-design-outline" {...named(t('Outline'))} aria-haspopup="dialog" aria-expanded={listOpen} onClick={() => setListOpen(true)}><Icon name="outline" size={22} /></IconButton>
          )
        ) : null}
        <IconButton id="h5-design-close" {...named(t('Close'))} onClick={close}><Icon name="close" size={22} /></IconButton>
      </Box>
      {loading ? <LinearProgress id="h5-design-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto' }} /> : null}
      {note ? (
        <Box id="h5-design-empty" role="status" sx={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, textAlign: 'center', color: 'text.secondary', overflowWrap: 'anywhere' }}>{note}</Box>
      ) : null}
      <Box sx={{ display: note || content === null ? 'none' : 'flex', flex: '1 1 auto', minHeight: 0 }}>
        <Box
          ref={setNode} id="h5-design-body" className="h5-design-body" tabIndex={0}
          sx={{ display: 'block', flex: '1 1 auto', minWidth: 0, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', px: 2, pt: 2, pb: 4 }}
        />
        {showColumn ? (
          // A wide screen: the outline is a column on the right of the document, scrolling on its own.
          <OutlineList outline={outline} current={current} onPick={jump} sx={{ flex: '0 0 clamp(140px, 32%, 220px)', borderLeft: 1, borderColor: 'divider' }} />
        ) : null}
      </Box>
      {!side && hasOutline ? (
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
  if (side) {
    // A wide screen: a panel on the right beside the terminal (a persistent drawer: the page is not dimmed and stays usable). h5.css narrows the page
    // while it is open (`html[data-side-panel]`), so the terminal refits once to the width that is left. Escape inside the panel closes it.
    return (
      <Drawer
        variant="persistent" anchor="right" id="h5-design-sheet" open={open} transitionDuration={reduced ? 0 : undefined}
        slotProps={{ paper: { className: 'h5-design-panel h5-design-side', role: 'complementary', 'aria-labelledby': 'h5-design-title', onKeyDown: event => { if (event.key === 'Escape' && event.currentTarget.contains(event.target)) { event.stopPropagation(); close(); } }, sx: { width: 'var(--h5-side-width)', height: '100%', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: 1, borderColor: 'divider' } } }}
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

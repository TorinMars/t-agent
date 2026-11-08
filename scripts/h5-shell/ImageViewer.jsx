import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { FIT, actualScale, clampView, detailScale, maxScale, pinch, stepScale, zoomAt, zoomPercent } from './zoom.mjs';

const PAD = 16; // px around a diagram at fit size
const TAP_MOVE = 10; // px a finger may move and still tap
const TAP_TIME = 350; // ms: the longest tap, and the longest gap between the two taps of a double tap
const DOUBLE_DISTANCE = 40; // px between the two taps of a double tap
const PAN_STEP = 0.15; // an arrow key pans a zoomed view by this part of the stage

const BAR_BUTTON = { width: 44, height: 44, color: '#fff', borderRadius: '22px', '&.Mui-disabled': { color: 'rgba(255, 255, 255, .35)' } };
const BAR_TEXT = { ...BAR_BUTTON, fontSize: 14, fontWeight: 500, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }; // text labels sized like the icons

// The natural width of `item.natural` (a number, or { w } / { width }), or 0.
const naturalWidth = natural => (typeof natural === 'number' ? natural : (natural && (natural.w || natural.width)) || 0);

// The full-screen viewer of a picture or a diagram of the design document sheet (Design.jsx). `item` is { kind: 'img', src, alt, natural, download, name }
// or { kind: 'svg', svg } (a clone of a rendered mermaid diagram: vector, so it stays sharp at any zoom). `natural` (optional) is the picture's natural
// width (or { w, h }) until the picture has loaded; `download` (optional, a URL: a file, not a picture of a Markdown document) adds a Download button,
// `name` its file name. A bottom toolbar has Zoom out, the zoom in percent (of the actual pixels when known, else of the fit size; a tap fits), Zoom in,
// 1:1 (actual pixels) and Download; keys: + or = zoom in, - zoom out, 0 fit, 1 actual size, the arrows pan. The largest zoom is 8x the fit size or 4x
// the actual pixels, whichever is larger (zoom.mjs maxScale). Zoom and pan are done here with pointer events
// and a CSS transform, never by the browser (the Home Screen app may not allow page zoom): two fingers pinch and move, one finger pans a zoomed view,
// a double tap (or double click) switches between fit and detail, the wheel or a trackpad pinch zooms at the pointer, a mouse drags. A tap on the black
// background closes it while it is not zoomed; so do the close button, Escape and the back button (it is a MUI modal: back.mjs sees it).
export function ImageViewer({ item, onClose }) {
  const open = Boolean(item);
  const [stage, setStage] = useState(null);
  const content = useRef(null);
  const [view, setView] = useState(FIT);
  const viewRef = useRef(FIT);
  const [svgFit, setSvgFit] = useState(null); // the fit size of a diagram: { w, h }
  const gesture = useRef({ pointers: new Map(), pinch: null, tap: null, lastTap: null, multi: false });
  const [size, setSize] = useState({ natural: 0, shown: 0 }); // a picture: its natural width and its width at fit
  const [smooth, setSmooth] = useState(false); // a button or key zoom animates; a gesture follows the fingers at once
  const natural = size.natural || (item && item.kind === 'img' ? naturalWidth(item.natural) : 0);
  const actual = item && item.kind === 'img' ? actualScale(natural, size.shown) : null;
  const max = item && item.kind === 'img' ? maxScale(natural, size.shown) : maxScale(0, 0);
  const limits = useRef({ actual, max });
  limits.current = { actual, max };

  const sizes = () => {
    const box = content.current;
    return { content: { w: box ? box.offsetWidth : 0, h: box ? box.offsetHeight : 0 }, stage: { w: stage ? stage.clientWidth : 0, h: stage ? stage.clientHeight : 0 } };
  };
  const apply = next => {
    const { content: c, stage: st } = sizes();
    const v = next.s <= 1.001 ? FIT : clampView(next, c, st, limits.current.max);
    viewRef.current = v;
    setView(v);
  };
  const point = event => { // px from the centre of the stage
    const r = stage.getBoundingClientRect();
    return { x: event.clientX - r.left - r.width / 2, y: event.clientY - r.top - r.height / 2 };
  };

  useEffect(() => { viewRef.current = FIT; setView(FIT); setSize({ natural: 0, shown: 0 }); setSmooth(false); gesture.current = { pointers: new Map(), pinch: null, tap: null, lastTap: null, multi: false }; }, [item]);

  // A picture: its natural width and its width at fit (the layout width, not changed by the transform), read when it loads and on resize.
  const measure = () => {
    const box = content.current;
    if (!item || item.kind !== 'img' || !box) return;
    const next = { natural: box.naturalWidth || 0, shown: box.offsetWidth || 0 };
    setSize(old => (old.natural === next.natural && old.shown === next.shown ? old : next));
  };
  useEffect(() => {
    if (!item || item.kind !== 'img' || !stage) return undefined;
    if (content.current && content.current.complete) measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [item, stage]);

  // A diagram: its clone is put in as a node (not as HTML text) and sized to fit the stage, keeping its aspect ratio.
  useLayoutEffect(() => {
    if (!item || item.kind !== 'svg' || !stage || !content.current) { setSvgFit(null); return undefined; }
    const box = content.current;
    const svg = item.svg.cloneNode(true);
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const ratio = vb && vb.width && vb.height ? vb.width / vb.height : (item.ratio || 1);
    svg.removeAttribute('style'); // mermaid sets a fixed max-width
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.display = 'block';
    box.replaceChildren(svg);
    const fit = () => {
      const w = Math.max(1, stage.clientWidth - 2 * PAD);
      const h = Math.max(1, stage.clientHeight - 2 * PAD);
      const width = Math.min(w, h * ratio);
      setSvgFit({ w: width, h: width / ratio });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [item, stage]);

  // The wheel (and a trackpad pinch, which arrives as a wheel with ctrlKey) zooms at the pointer; it must not scroll or zoom the page.
  useEffect(() => {
    if (!stage) return undefined;
    const onWheel = event => {
      event.preventDefault();
      setSmooth(false);
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      apply(zoomAt(viewRef.current, viewRef.current.s * factor, point(event), limits.current.max));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  });

  const toggle = at => {
    const v = viewRef.current;
    if (v.s > 1.01) { apply(FIT); return; }
    const box = content.current;
    const target = item && item.kind === 'img' && box ? detailScale(box.naturalWidth, box.offsetWidth, limits.current.max) : 2;
    apply(zoomAt(v, target, at, limits.current.max));
  };

  // The toolbar and the keys: zoom at the centre of the stage, animated.
  const zoomTo = s => { setSmooth(true); apply(zoomAt(viewRef.current, s, { x: 0, y: 0 }, limits.current.max)); };
  const zoomStep = direction => zoomTo(stepScale(viewRef.current.s, direction, limits.current.actual, limits.current.max));
  const fit = () => { setSmooth(true); apply(FIT); };
  const actualSize = () => { if (limits.current.actual) zoomTo(Math.max(1, limits.current.actual)); };
  const pan = (dx, dy) => {
    if (viewRef.current.s <= 1.001 || !stage) return;
    setSmooth(true);
    apply({ ...viewRef.current, x: viewRef.current.x + dx * stage.clientWidth * PAN_STEP, y: viewRef.current.y + dy * stage.clientHeight * PAN_STEP });
  };
  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const act = {
        '+': () => zoomStep(1), '=': () => zoomStep(1), '-': () => zoomStep(-1), _: () => zoomStep(-1), 0: fit, 1: actualSize,
        ArrowLeft: () => pan(1, 0), ArrowRight: () => pan(-1, 0), ArrowUp: () => pan(0, 1), ArrowDown: () => pan(0, -1), // the arrow shows more on that side
      }[event.key];
      if (!act) return;
      event.preventDefault();
      act();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointerDown = event => {
    if (event.target.closest && event.target.closest('button, a')) return;
    setSmooth(false);
    const g = gesture.current;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer */ }
    g.pointers.set(event.pointerId, point(event));
    if (g.pointers.size === 1) {
      g.multi = false;
      g.tap = { id: event.pointerId, start: point(event), t: performance.now(), onContent: Boolean(content.current && content.current.contains(event.target)), from: viewRef.current };
    } else {
      g.multi = true;
      g.tap = null;
      const [a, b] = [...g.pointers.values()];
      g.pinch = { start: viewRef.current, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  };
  const onPointerMove = event => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    const p = point(event);
    const previous = g.pointers.get(event.pointerId);
    g.pointers.set(event.pointerId, p);
    if (g.pointers.size >= 2 && g.pinch) {
      const [a, b] = [...g.pointers.values()];
      apply(pinch(g.pinch.start, g.pinch.mid, g.pinch.distance, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.hypot(a.x - b.x, a.y - b.y)));
      return;
    }
    if (g.tap && Math.hypot(p.x - g.tap.start.x, p.y - g.tap.start.y) > TAP_MOVE) g.tap = null;
    if (!g.tap && viewRef.current.s > 1.001) apply({ ...viewRef.current, x: viewRef.current.x + p.x - previous.x, y: viewRef.current.y + p.y - previous.y });
  };
  const onPointerUp = event => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.delete(event.pointerId);
    if (g.pointers.size < 2) g.pinch = null;
    if (g.pointers.size === 1) { // one finger left after a pinch: it pans from where it is
      g.tap = null;
      return;
    }
    const tap = g.tap;
    g.tap = null;
    if (event.type !== 'pointerup' || g.multi || !tap || tap.id !== event.pointerId || performance.now() - tap.t > TAP_TIME) return;
    const now = performance.now();
    const last = g.lastTap;
    if (last && now - last.t < TAP_TIME && Math.hypot(tap.start.x - last.x, tap.start.y - last.y) < DOUBLE_DISTANCE) {
      g.lastTap = null;
      toggle(tap.start);
      return;
    }
    g.lastTap = { t: now, x: tap.start.x, y: tap.start.y };
    if (!tap.onContent && tap.from.s <= 1.001) onClose();
  };

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  const shared = { id: 'h5-viewer-content', 'data-scale': view.s.toFixed(3), draggable: false, className: smooth ? 'h5-viewer-smooth' : undefined };
  const percent = zoomPercent(view.s, actual);
  return (
    <Dialog
      fullScreen open={open} onClose={onClose} disableScrollLock aria-label={t('Image viewer')}
      slotProps={{ paper: { id: 'h5-viewer', sx: { bgcolor: '#000', backgroundImage: 'none', overflow: 'hidden' } } }}
    >
      {item ? (
        <Box
          ref={setStage} className="h5-viewer-stage"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDragStart={event => event.preventDefault()}
          sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: view.s > 1.001 ? 'grab' : 'zoom-in', overscrollBehavior: 'none', '& .h5-viewer-smooth': { transition: 'transform .2s ease-out' }, '@media (prefers-reduced-motion: reduce)': { '& .h5-viewer-smooth': { transition: 'none' } } }}
        >
          {item.kind === 'img' ? (
            <img ref={content} src={item.src} alt={item.alt || ''} {...shared} onLoad={measure} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform, transformOrigin: 'center', display: 'block' }} />
          ) : (
            <Box ref={content} {...shared} className={`h5-viewer-svg${smooth ? ' h5-viewer-smooth' : ''}`} style={{ width: svgFit ? svgFit.w : 0, height: svgFit ? svgFit.h : 0, transform, transformOrigin: 'center', flex: '0 0 auto' }} />
          )}
        </Box>
      ) : null}
      <IconButton
        id="h5-viewer-close" {...named(t('Close'))} onClick={onClose}
        sx={{ position: 'absolute', top: 'calc(env(safe-area-inset-top) + 8px)', right: 'calc(env(safe-area-inset-right) + 8px)', color: '#fff', bgcolor: 'rgba(0, 0, 0, .55)', '&:hover': { bgcolor: 'rgba(40, 40, 40, .8)' }, zIndex: 1 }}
      >
        <Icon name="close" size={22} />
      </IconButton>
      {item ? (
        <Box
          id="h5-viewer-bar" role="toolbar" aria-label={t('Zoom')}
          sx={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(env(safe-area-inset-bottom) + 12px)', zIndex: 1, display: 'flex', alignItems: 'center', gap: '2px', p: '2px', maxWidth: 'calc(100% - 16px - env(safe-area-inset-left) - env(safe-area-inset-right))', borderRadius: '24px', bgcolor: 'rgba(0, 0, 0, .55)', color: '#fff', '& > *': { flex: '0 0 auto' } }}
        >
          <IconButton id="h5-viewer-zoom-out" {...named(t('Zoom out'))} onClick={() => zoomStep(-1)} disabled={view.s <= 1.001} sx={BAR_BUTTON}><Icon name="zoomOut" size={22} /></IconButton>
          <ButtonBase id="h5-viewer-zoom-level" {...named(t('Fit to screen'))} onClick={fit} sx={{ ...BAR_TEXT, width: 'auto', minWidth: 60, px: 1 }}>{`${percent}%`}</ButtonBase>
          <IconButton id="h5-viewer-zoom-in" {...named(t('Zoom in'))} onClick={() => zoomStep(1)} disabled={view.s >= max - 0.001} sx={BAR_BUTTON}><Icon name="zoomIn" size={22} /></IconButton>
          <ButtonBase id="h5-viewer-actual" {...named(t('Actual size'))} onClick={actualSize} disabled={!actual} sx={BAR_TEXT}>1:1</ButtonBase>
          {item.download ? (
            <IconButton id="h5-viewer-download" {...named(t('Download original'))} component="a" href={item.download} download={item.name || ''} target="_blank" rel="noopener" sx={BAR_BUTTON}><Icon name="download" size={22} /></IconButton>
          ) : null}
        </Box>
      ) : null}
    </Dialog>
  );
}

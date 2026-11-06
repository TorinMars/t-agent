import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { FIT, clampView, detailScale, pinch, zoomAt } from './zoom.mjs';

const PAD = 16; // px around a diagram at fit size
const TAP_MOVE = 10; // px a finger may move and still tap
const TAP_TIME = 350; // ms: the longest tap, and the longest gap between the two taps of a double tap
const DOUBLE_DISTANCE = 40; // px between the two taps of a double tap

// The full-screen viewer of a picture or a diagram of the design document sheet (Design.jsx). `item` is { kind: 'img', src, alt, natural } or
// { kind: 'svg', svg } (a clone of a rendered mermaid diagram: vector, so it stays sharp at any zoom). Zoom and pan are done here with pointer events
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

  const sizes = () => {
    const box = content.current;
    return { content: { w: box ? box.offsetWidth : 0, h: box ? box.offsetHeight : 0 }, stage: { w: stage ? stage.clientWidth : 0, h: stage ? stage.clientHeight : 0 } };
  };
  const apply = next => {
    const { content: c, stage: st } = sizes();
    const v = next.s <= 1.001 ? FIT : clampView(next, c, st);
    viewRef.current = v;
    setView(v);
  };
  const point = event => { // px from the centre of the stage
    const r = stage.getBoundingClientRect();
    return { x: event.clientX - r.left - r.width / 2, y: event.clientY - r.top - r.height / 2 };
  };

  useEffect(() => { viewRef.current = FIT; setView(FIT); gesture.current = { pointers: new Map(), pinch: null, tap: null, lastTap: null, multi: false }; }, [item]);

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
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      apply(zoomAt(viewRef.current, viewRef.current.s * factor, point(event)));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  });

  const toggle = at => {
    const v = viewRef.current;
    if (v.s > 1.01) { apply(FIT); return; }
    const box = content.current;
    const target = item && item.kind === 'img' && box ? detailScale(box.naturalWidth, box.offsetWidth) : 2;
    apply(zoomAt(v, target, at));
  };

  const onPointerDown = event => {
    if (event.target.closest && event.target.closest('button')) return;
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
  const shared = { id: 'h5-viewer-content', 'data-scale': view.s.toFixed(3), draggable: false };
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
          sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: view.s > 1.001 ? 'grab' : 'zoom-in', overscrollBehavior: 'none' }}
        >
          {item.kind === 'img' ? (
            <img ref={content} src={item.src} alt={item.alt || ''} {...shared} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform, transformOrigin: 'center', display: 'block' }} />
          ) : (
            <Box ref={content} {...shared} className="h5-viewer-svg" style={{ width: svgFit ? svgFit.w : 0, height: svgFit ? svgFit.h : 0, transform, transformOrigin: 'center', flex: '0 0 auto' }} />
          )}
        </Box>
      ) : null}
      <IconButton
        id="h5-viewer-close" {...named(t('Close'))} onClick={onClose}
        sx={{ position: 'absolute', top: 'calc(env(safe-area-inset-top) + 8px)', right: 'calc(env(safe-area-inset-right) + 8px)', color: '#fff', bgcolor: 'rgba(0, 0, 0, .55)', '&:hover': { bgcolor: 'rgba(40, 40, 40, .8)' }, zIndex: 1 }}
      >
        <Icon name="close" size={22} />
      </IconButton>
    </Dialog>
  );
}

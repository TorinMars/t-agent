import { useEffect, useLayoutEffect, useRef } from 'react';
import { DRAG_MOVE_PX, HOLD_MS, HOLD_SLOP_PX, SETTLE_MS, SHIFT_MS, reducedMotion } from './list-drag.jsx';

// Sorting the columns of the multi-column view by dragging their headers sideways (`useTabDrag`, Columns.jsx), and sliding a row of boxes to their new
// places after an order change (`useFlipX`, the columns themselves). The feel is the one of the vertical lists (list-drag.jsx): a finger held still for
// HOLD_MS picks a header up (a short vibration), a finger that moves more than HOLD_SLOP_PX before that scrolls the strip and a short tap is a tap; a
// mouse picks it up after HOLD_MS or a move of DRAG_MOVE_PX. While dragging, a lifted copy of the header follows the pointer along the strip, the
// column's place is dimmed with a dashed outline and a primary line shows where it would land; the columns themselves do not move until the drop (an
// iframe is never moved, so nothing reloads), and then slide to their new places (useFlipX). Near an edge of the strip it scrolls. The drop calls
// `drop(id, index)`; Escape puts the column back; the click after a drag is swallowed. `prefers-reduced-motion: reduce` makes every move instant.
const EDGE_PX = 32;
const MAX_SCROLL_PX = 12;

const unslide = node => { node.style.transition = ''; node.style.transform = ''; };
// The slide after an order change (FLIP) is a Web Animation, as in list-drag.jsx: React may move a tab's element in the DOM, which would cancel a CSS
// transition on it, while an animation goes on. A change that comes while the last one slides starts each box from where it is seen (`slidBy`).
const flips = new WeakMap(); // element -> { animation, from }
const unflip = node => { const running = flips.get(node); if (running) { running.animation.cancel(); flips.delete(node); } };
function flipFrom(node, from) {
  unflip(node);
  if (typeof node.animate !== 'function') return;
  const animation = node.animate([{ transform: `translate3d(${from}px, 0, 0)` }, { transform: 'none' }], { duration: SHIFT_MS, easing: 'ease-out' });
  flips.set(node, { animation, from });
  animation.onfinish = () => { if (flips.get(node)?.animation === animation) flips.delete(node); };
}
const slidBy = node => {
  const running = flips.get(node);
  if (!running || running.animation.playState === 'finished' || running.animation.playState === 'idle') return 0;
  const progress = running.animation.effect.getComputedTiming().progress;
  return running.from * (1 - (typeof progress === 'number' ? progress : 1));
};

// After every commit: when the order of the boxes that stayed changed, each slides from where it was seen to its new place. Places are `offsetLeft` in
// the container (which must be their offsetParent, `position: relative`): a running slide does not count, and scrolling does not change them. `spec`:
// `items(container)` (the boxes shown, in any DOM order: the order is read from their places), `key(el)`, and optionally `takeDropped()` (where the boxes
// were shown when a drag ended, { at: Map(key -> left), nodes }, their drag slides cleared here) and `busy()` (a drag is going on: nothing slides).
export function useFlipX(ref, spec) {
  const memo = useRef({ at: new Map(), order: [] });
  useLayoutEffect(() => {
    const box = ref.current;
    const m = memo.current;
    const dropped = spec.busy && spec.busy() ? null : (spec.takeDropped ? spec.takeDropped() : null);
    if (!box) { m.at = new Map(); m.order = []; return; }
    const now = new Map(spec.items(box).filter(el => el.offsetParent).map(el => [spec.key(el), { el, left: el.offsetLeft }]));
    const order = [...now.keys()].sort((a, b) => now.get(a).left - now.get(b).left);
    const before = m.at;
    const was = m.order;
    const shown = new Map([...before].map(([key, item]) => [key, item.left]));
    if (dropped) {
      for (const node of dropped.nodes) unslide(node);
      for (const [key, left] of dropped.at) shown.set(key, left);
    }
    m.at = now;
    m.order = order;
    if ((spec.busy && spec.busy()) || reducedMotion()) return;
    const common = order.filter(key => before.has(key) && before.get(key).el === now.get(key).el);
    const old = was.filter(key => common.includes(key));
    if (common.every((key, index) => key === old[index])) return; // boxes that came, went or changed width do not slide
    const seen = new Map(common.map(key => [key, shown.get(key) + slidBy(now.get(key).el)])); // read all first
    for (const key of common) {
      const delta = seen.get(key) - now.get(key).left;
      if (Math.abs(delta) < 1) unflip(now.get(key).el);
      else flipFrom(now.get(key).el, delta);
    }
  });
}

// The drag of one column of `rowRef` (the scrolling strip, the columns' offsetParent; each column is `.h5-column[data-pane-id]` and its header
// `.h5-column-head`). The lifted copy of the header is put in `hostRef`, the insertion line in the strip. `drop(id, index)`: the column was dropped at
// `index` (a new place); `say(text)`: the live region. Returns the props of a header (`hold()`) and `busy` (a drag is going on), for useFlipX.
export function useTabDrag(rowRef, hostRef, { drop, say, ignore = '.h5-column-act' }) {
  const live = useRef(null);
  useEffect(() => () => { if (live.current) live.current.abort(); }, []);
  // A header held until it was picked up keeps the finger: the strip must not scroll under it.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const keep = event => { if (live.current && live.current.picked && event.cancelable) event.preventDefault(); };
    row.addEventListener('touchmove', keep, { passive: false });
    return () => row.removeEventListener('touchmove', keep);
  });

  const begin = (head, pointer) => {
    if (live.current) live.current.abort();
    const row = rowRef.current;
    const host = hostRef.current;
    const column = head.closest('.h5-column');
    if (!row || !host || !column) return;
    const id = column.dataset.paneId;
    const s = { id, picked: false, frame: 0, timer: 0, cols: [], from: 0, index: 0, x: pointer.x, motion: !reducedMotion() };
    live.current = s;
    const place = (left, animate) => {
      s.float.style.transition = animate && s.motion ? `transform ${SETTLE_MS}ms ease-out` : 'none';
      s.float.style.transform = `translate3d(${left - s.originX}px, ${s.top}px, 0)`;
    };
    // Where the column would start (in the strip's content) at `index`, and where the line goes: before the column it takes the place of, or after it.
    const landing = index => {
      const cols = s.cols;
      if (index === s.from) return { left: cols[s.from].left, line: null };
      if (index < s.from) return { left: cols[index].left, line: cols[index].left };
      return { left: cols[index].left + cols[index].width - cols[s.from].width, line: cols[index].left + cols[index].width };
    };
    const showLine = () => {
      const { line } = landing(s.index);
      s.line.hidden = line === null;
      if (line !== null) s.line.style.transform = `translate3d(${Math.round(line - 1.5)}px, 0, 0)`;
    };
    // The copy follows the pointer inside the strip; the column lands where the copy's left edge passed the middle of a column before it, or its right
    // edge the middle of a column after it.
    const aim = () => {
      const left = Math.min(Math.max(s.x - s.grab, s.box.left - s.width / 2), s.box.right - s.width / 2);
      place(left, false);
      const start = left - s.box.left - row.clientLeft + row.scrollLeft;
      const end = start + s.width;
      let index = 0;
      s.cols.forEach((item, j) => {
        const middle = item.left + item.width / 2;
        if ((j < s.from && start >= middle) || (j > s.from && end > middle)) index += 1;
      });
      if (index !== s.index) { s.index = index; showLine(); }
    };
    // Near an edge of the strip it scrolls, faster the closer the pointer is.
    const scroll = () => {
      s.frame = 0;
      if (!s.picked) return;
      const before = s.x - s.box.left;
      const after = s.box.right - s.x;
      const step = before < EDGE_PX ? -Math.ceil(MAX_SCROLL_PX * (1 - Math.max(before, 0) / EDGE_PX)) : after < EDGE_PX ? Math.ceil(MAX_SCROLL_PX * (1 - Math.max(after, 0) / EDGE_PX)) : 0;
      if (!step) return;
      const was = row.scrollLeft;
      row.scrollLeft += step;
      if (row.scrollLeft !== was) aim();
      s.frame = requestAnimationFrame(scroll);
    };
    const pick = () => {
      s.cols = [...row.querySelectorAll(':scope > .h5-column[data-pane-id]')].filter(el => el.offsetParent && !el.hasAttribute('data-railed'))
        .map(el => ({ el, id: el.dataset.paneId, left: el.offsetLeft, width: el.offsetWidth })).sort((a, b) => a.left - b.left);
      for (const item of s.cols) unflip(item.el);
      s.from = s.index = s.cols.findIndex(item => item.el === column);
      if (s.from < 0 || s.cols.length < 2) { stop(); live.current = null; return; }
      s.picked = true;
      s.box = row.getBoundingClientRect();
      const box = head.getBoundingClientRect();
      s.width = box.width;
      s.grab = s.x - box.left;
      // The lifted copy: `position: fixed`, where its (0, 0) really is gets measured (an ancestor may make a containing block).
      const float = document.createElement('div');
      float.className = 'h5-column-head-float';
      float.setAttribute('aria-hidden', 'true');
      float.inert = true;
      const body = document.createElement('div');
      body.className = 'h5-column-head-float-body';
      const copy = head.cloneNode(true);
      for (const node of copy.querySelectorAll('.MuiTouchRipple-root')) node.remove();
      for (const node of copy.querySelectorAll('.Mui-focusVisible')) node.classList.remove('Mui-focusVisible');
      for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
      body.appendChild(copy);
      float.appendChild(body);
      float.style.width = `${box.width}px`;
      float.style.height = `${box.height}px`;
      host.appendChild(float);
      const origin = float.getBoundingClientRect();
      s.originX = origin.left;
      s.top = box.top - origin.top;
      s.float = float;
      s.body = body;
      const line = document.createElement('div');
      line.className = 'h5-column-drop-line';
      line.setAttribute('aria-hidden', 'true');
      line.hidden = true;
      row.appendChild(line);
      s.line = line;
      place(box.left, false);
      column.setAttribute('data-drag-slot', 'true');
      row.setAttribute('data-dragging', 'true');
      document.documentElement.setAttribute('data-column-drag', '');
      void body.offsetWidth;
      body.classList.add('h5-column-head-float-lifted');
    };
    const stop = () => {
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
      if (s.timer) clearTimeout(s.timer);
      s.timer = 0;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onMenu, true);
      row.removeAttribute('data-dragging');
      document.documentElement.removeAttribute('data-column-drag');
      if (s.line) { s.line.remove(); s.line = null; }
    };
    // The end of the settle: the copy goes, the column shows again in full.
    const clear = () => {
      if (s.float) s.float.remove();
      column.removeAttribute('data-drag-slot');
      if (live.current === s) live.current = null;
    };
    // Drop (`save`) or put back: the copy settles where the column lands, the order is saved at once and the columns slide there (useFlipX).
    const end = save => {
      if (!s.picked) { stop(); if (live.current === s) live.current = null; return; }
      if (!save) s.index = s.from;
      const target = landing(s.index).left;
      const left = s.box.left + row.clientLeft + target - row.scrollLeft;
      stop();
      s.picked = false;
      place(left, true);
      s.body.classList.remove('h5-column-head-float-lifted');
      if (save && s.index !== s.from) drop(id, s.index);
      setTimeout(clear, s.motion ? SETTLE_MS + 20 : 0);
    };
    s.abort = () => { stop(); s.picked = false; clear(); };
    // The click after a drag (a mouse, or the release of a held finger) lands on the header: it is swallowed once.
    const swallowClick = () => {
      const eat = event => { event.preventDefault(); event.stopPropagation(); };
      const done = () => { window.removeEventListener('click', eat, { capture: true }); window.removeEventListener('pointerdown', done, { capture: true }); };
      window.addEventListener('click', eat, { capture: true, once: true });
      window.addEventListener('pointerdown', done, { capture: true, once: true });
      setTimeout(done, 400);
    };
    function onMove(event) {
      if (event.pointerId !== pointer.id) return;
      s.x = event.clientX;
      if (!s.picked) {
        const far = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
        if (!pointer.mouse) { if (far > HOLD_SLOP_PX) { stop(); live.current = null; } return; } // the finger scrolls the strip
        if (far <= DRAG_MOVE_PX) return;
        pick();
        if (!s.picked) return;
      }
      aim();
      if (!s.frame) s.frame = requestAnimationFrame(scroll);
    }
    function onUp(event) {
      if (event.pointerId !== pointer.id) return;
      if (s.picked) swallowClick();
      end(true);
    }
    function onCancel(event) { if (event.pointerId === pointer.id) end(false); }
    function onKey(event) {
      if (event.key !== 'Escape' || !s.picked) return;
      event.preventDefault();
      event.stopPropagation();
      end(false);
      say('Reorder cancelled');
    }
    function onMenu(event) { event.preventDefault(); } // a long press would open the context menu of a touch browser
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    if (!pointer.mouse) window.addEventListener('contextmenu', onMenu, true);
    s.timer = setTimeout(() => {
      s.timer = 0;
      if (live.current !== s || s.picked) return;
      pick();
      if (!s.picked) return;
      if (!pointer.mouse && typeof navigator.vibrate === 'function') { try { navigator.vibrate(10); } catch { /* not allowed here */ } }
      aim();
    }, HOLD_MS);
  };
  const primary = event => event.isPrimary && !(event.pointerType === 'mouse' && event.button !== 0);
  // The props of a header: the whole header is held, except its action buttons (fit, maximize, "⋯", close).
  const hold = () => ({
    onPointerDown: event => {
      if (!primary(event) || (event.target.closest && event.target.closest(ignore))) return;
      begin(event.currentTarget, { id: event.pointerId, x: event.clientX, y: event.clientY, mouse: event.pointerType === 'mouse' });
    },
    onContextMenu: event => { if (live.current) event.preventDefault(); },
  });
  return { hold, busy: () => Boolean(live.current && live.current.picked) };
}

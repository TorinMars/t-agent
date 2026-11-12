import { useEffect, useLayoutEffect, useRef } from 'react';
import { DRAG_MOVE_PX, HOLD_MS, HOLD_SLOP_PX, SETTLE_MS, SHIFT_MS, reducedMotion } from './list-drag.jsx';

// Sorting a row of tabs by dragging them sideways (`useTabDrag`, the column tabs of the multi-column view, Columns.jsx), and sliding a row of boxes to
// their new places after an order change (`useFlipX`, the tabs and the columns themselves). The feel is the one of the vertical lists (list-drag.jsx):
// a finger held still for HOLD_MS picks a tab up (a short vibration), a finger that moves more than HOLD_SLOP_PX before that scrolls the tab row and a
// short tap is a tap; a mouse picks it up after HOLD_MS or a move of DRAG_MOVE_PX. While dragging, a lifted copy of the tab follows the pointer along the
// row, the tab's place is an empty dashed slot of the same width and the other tabs slide out of the way (transforms only: the tabs are measured once when
// the drag starts). Near an edge of the row it scrolls. The drop calls `drop(id, index)`; Escape puts the tab back; the click after a drag is swallowed.
// `prefers-reduced-motion: reduce` makes every move instant.
const EDGE_PX = 32;
const MAX_SCROLL_PX = 12;

const slide = (node, x, ms) => {
  node.style.transition = ms ? `transform ${ms}ms ease-out` : 'none';
  node.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
};
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

// The drag of one tab of `rowRef` (the scrolling tab row, the tabs' offsetParent; each tab is `.h5-column-tab[data-pane-id]`). The lifted copy is put in
// `hostRef`. `drop(id, index)`: the tab was dropped at `index` (a new place); `say(text)`: the live region. Returns the props of a tab and, for useFlipX,
// `takeDropped` and `busy`.
export function useTabDrag(rowRef, hostRef, { drop, say, ignore = '.h5-column-tab-close' }) {
  const live = useRef(null);
  const dropped = useRef(null);
  useEffect(() => () => { if (live.current) live.current.abort(); }, []);
  // A tab held until it was picked up keeps the finger: the row must not scroll under it.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const keep = event => { if (live.current && live.current.picked && event.cancelable) event.preventDefault(); };
    row.addEventListener('touchmove', keep, { passive: false });
    return () => row.removeEventListener('touchmove', keep);
  }, [rowRef]);

  const begin = (tab, pointer) => {
    if (live.current) live.current.abort();
    const row = rowRef.current;
    const host = hostRef.current;
    if (!row || !host) return;
    const id = tab.dataset.paneId;
    const s = { id, picked: false, frame: 0, timer: 0, tabs: [], from: 0, index: 0, x: pointer.x, motion: !reducedMotion() };
    live.current = s;
    const place = (left, animate) => {
      s.float.style.transition = animate && s.motion ? `transform ${SETTLE_MS}ms ease-out` : 'none';
      s.float.style.transform = `translate3d(${left - s.originX}px, ${s.top}px, 0)`;
    };
    function set(item, shift) {
      if (item.shift === shift) return;
      item.shift = shift;
      slide(item.el, shift, s.motion ? SHIFT_MS : 0);
    }
    // The slot moves to `s.index` (the number of the other tabs before it); the tabs it passed slide by its width and the gap.
    const arrange = () => {
      const moved = s.tabs[s.from].width + s.gap;
      let slot = 0;
      s.tabs.forEach((item, j) => {
        if (j === s.from) return;
        let shift = 0;
        if (j < s.from && j >= s.index) { shift = moved; slot -= item.width + s.gap; }
        if (j > s.from && j <= s.index) { shift = -moved; slot += item.width + s.gap; }
        set(item, shift);
      });
      set(s.tabs[s.from], slot);
    };
    const slotLeft = () => { const slot = s.tabs[s.from]; return s.box.left + row.clientLeft + slot.left + slot.shift - row.scrollLeft; };
    // The copy follows the pointer inside the row; the slot goes where the copy's left edge passed the middle of a tab before it, or its right edge the
    // middle of a tab after it.
    const aim = () => {
      const left = Math.min(Math.max(s.x - s.grab, s.box.left - s.width / 2), s.box.right - s.width / 2);
      place(left, false);
      const start = left - s.box.left - row.clientLeft + row.scrollLeft;
      const end = start + s.width;
      let index = 0;
      s.tabs.forEach((item, j) => {
        const middle = item.left + item.width / 2;
        if ((j < s.from && start >= middle) || (j > s.from && end > middle)) index += 1;
      });
      if (index !== s.index) { s.index = index; arrange(); }
    };
    // Near an edge of the row it scrolls, faster the closer the pointer is.
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
      s.tabs = [...row.querySelectorAll('.h5-column-tab[data-pane-id]')].map(el => ({ el, id: el.dataset.paneId, left: el.offsetLeft, width: el.offsetWidth, shift: 0 }));
      for (const item of s.tabs) unflip(item.el);
      s.from = s.index = s.tabs.findIndex(item => item.el === tab);
      if (s.from < 0) { stop(); live.current = null; return; }
      s.picked = true;
      s.gap = s.tabs.length > 1 ? Math.max(0, s.tabs[1].left - s.tabs[0].left - s.tabs[0].width) : 0;
      s.box = row.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      s.width = box.width;
      s.grab = s.x - box.left;
      // The lifted copy: `position: fixed`, where its (0, 0) really is gets measured (an ancestor may make a containing block).
      const float = document.createElement('div');
      float.className = 'h5-column-tab-float';
      float.setAttribute('aria-hidden', 'true');
      float.inert = true;
      const body = document.createElement('div');
      body.className = 'h5-column-tab-float-body';
      const copy = tab.cloneNode(true);
      copy.removeAttribute('data-drag-slot');
      for (const node of copy.querySelectorAll('.MuiTouchRipple-root')) node.remove();
      for (const node of copy.querySelectorAll('.Mui-focusVisible')) node.classList.remove('Mui-focusVisible');
      for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');
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
      place(box.left, false);
      tab.setAttribute('data-drag-slot', 'true');
      row.setAttribute('data-dragging', 'true');
      document.documentElement.setAttribute('data-column-drag', '');
      void body.offsetWidth;
      body.classList.add('h5-column-tab-float-lifted');
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
    };
    // The end of the settle: the copy goes, the tab shows again in its place.
    const clear = () => {
      if (s.float) s.float.remove();
      tab.removeAttribute('data-drag-slot');
      if (dropped.current && dropped.current.owner === s) { // no commit moved the tabs (nothing changed): their slides end here
        for (const node of dropped.current.nodes) unslide(node);
        dropped.current = null;
      }
      if (live.current === s) live.current = null;
    };
    // Drop (`save`) or put back: the copy settles into the slot, the order is saved at once, and the commit that moves the tabs clears their slides from
    // where they are shown (useFlipX), so nothing jumps.
    const end = save => {
      stop();
      if (!s.picked) { if (live.current === s) live.current = null; return; }
      if (!save && s.index !== s.from) { s.index = s.from; arrange(); }
      s.picked = false;
      place(slotLeft(), true);
      s.body.classList.remove('h5-column-tab-float-lifted');
      dropped.current = { owner: s, nodes: s.tabs.map(item => item.el), at: new Map(s.tabs.map(item => [item.id, item.left + item.shift])) };
      if (save && s.index !== s.from) drop(id, s.index);
      setTimeout(clear, s.motion ? SETTLE_MS + 20 : 0);
    };
    s.abort = () => { stop(); if (s.picked) { s.picked = false; for (const item of s.tabs) unslide(item.el); } clear(); };
    // The click after a drag (a mouse, or the release of a held finger) lands on the tab: it is swallowed once.
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
        if (!pointer.mouse) { if (far > HOLD_SLOP_PX) { stop(); live.current = null; } return; } // the finger scrolls the row
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
  // The props of a tab: the whole tab is held, except its close button.
  const hold = () => ({
    onPointerDown: event => {
      if (!primary(event) || (event.target.closest && event.target.closest(ignore))) return;
      begin(event.currentTarget, { id: event.pointerId, x: event.clientX, y: event.clientY, mouse: event.pointerType === 'mouse' });
    },
    onContextMenu: event => { if (live.current) event.preventDefault(); },
  });
  const takeDropped = () => {
    const value = dropped.current;
    if (!value) return null;
    dropped.current = null;
    return value;
  };
  return { hold, takeDropped, busy: () => Boolean(live.current && live.current.picked) };
}

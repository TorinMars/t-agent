import { useEffect, useLayoutEffect, useRef } from 'react';
import { alpha } from '@mui/material/styles';
import { t } from './common.jsx';

// Sorting a list by dragging its rows (`useListDrag`), shared by the task list and its sessions (TaskDrawer.jsx, where the behaviour is described) and by
// the T-Attention list (Attention.jsx). A spec says what differs (see TASK_DRAG in TaskDrawer.jsx): `rows`, `key`, `group`, `row`, `peers`, `head`,
// `floatClass`, `clamp`, `hold`, `focus`, `dragging`, `tap`, `drop`, and optionally `ignore` (a selector of controls inside a held row that never start
// a drag), `targets(list, row)` (elements a row can be dropped ON, such as the title of another group; the pointer over one marks it with
// `data-drop-over` and puts the row back in its place) and `dropOn(ui, s, target, say)` (the row was dropped on a target).
export const DRAG_MOVE_PX = 4;
export const HOLD_MS = 400;
const HOLD_SLOP_PX = 8;
const EDGE_PX = 40;
const MAX_SCROLL_PX = 14;
export const SHIFT_MS = 180; // the rows sliding out of the way, and to their new places after an order change
export const SETTLE_MS = 160; // the floating copy settling into the slot
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const slide = (node, y, ms) => {
  node.style.transition = ms ? `transform ${ms}ms ease-out` : 'none';
  node.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
};
const unslide = node => { node.style.transition = ''; node.style.transform = ''; };
// Where a row is in the scrolling list's own coordinates: offsets, so a slide in progress does not count, and scrolling does not change it.
function topIn(el, list) {
  let top = 0;
  let node = el;
  while (node && node !== list) { top += node.offsetTop; node = node.offsetParent; }
  return node === list ? top : el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
}

export function useListDrag(listRef, hostRef, liveRef, ui, spec) {
  const live = useRef(null); // the drag in progress (pressed, picked up, or settling)
  // `rows`: key -> { el, top, group } at the last commit; `dropped`: the places the rows were shown at when a drag ended (its slides are cleared at the
  // commit that moves them, or when it settles), and the grip to focus again after a drop from the keyboard (moving a row's element takes the focus away).
  const flip = useRef({ rows: new Map(), order: [], dropped: null });
  useEffect(() => () => { if (live.current) live.current.abort(); }, []);
  // A row that was held until it was picked up keeps the finger: the list must not scroll under it (a passive or a late listener could not stop that).
  useEffect(() => {
    const list = listRef.current;
    if (!list || !spec.hold) return undefined;
    const keep = event => { if (live.current && live.current.picked && event.cancelable) event.preventDefault(); };
    list.addEventListener('touchmove', keep, { passive: false });
    return () => list.removeEventListener('touchmove', keep);
  }, [listRef, spec.hold]);
  const say = text => { if (liveRef.current) liveRef.current.textContent = text; };
  const markDragging = on => { if (spec.dragging) spec.dragging(ui, on); };

  useLayoutEffect(() => {
    const memo = flip.current;
    const list = listRef.current;
    if (!list) { memo.rows = new Map(); memo.order = []; return; }
    const els = spec.rows(list);
    const now = new Map(els.map(el => [spec.key(el), { el, top: topIn(el, list), group: spec.group(el) }]));
    const order = [...now.keys()];
    const before = memo.rows;
    const was = memo.order;
    const shownAt = new Map([...before].map(([ref, row]) => [ref, row.top]));
    const dropped = memo.dropped;
    const dragging = live.current && live.current.picked;
    if (dropped && !dragging) {
      memo.dropped = null;
      for (const node of dropped.nodes) unslide(node);
      for (const [ref, top] of dropped.at) shownAt.set(ref, top);
      if (dropped.focus) { const grip = spec.focus(list, dropped.focus); if (grip && document.activeElement !== grip) grip.focus({ preventScroll: true }); }
    }
    memo.rows = now;
    memo.order = order;
    if (dragging || reducedMotion()) return;
    // Only a change of the order inside a group moves its rows; rows that came or went (a search, a new task) and a row that opened do not.
    const common = order.filter(ref => before.has(ref) && before.get(ref).el === now.get(ref).el);
    const old = was.filter(ref => common.includes(ref));
    const inGroups = refs => {
      const groups = new Map();
      for (const ref of refs) { const group = now.get(ref).group; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(ref); }
      return groups;
    };
    const oldGroups = inGroups(old);
    const changed = new Set([...inGroups(common)].filter(([group, refs]) => refs.some((ref, index) => ref !== (oldGroups.get(group) || [])[index])).map(([group]) => group));
    if (!changed.size) return;
    const moved = [];
    for (const ref of common) {
      if (!changed.has(now.get(ref).group)) continue;
      const delta = shownAt.get(ref) - now.get(ref).top;
      if (Math.abs(delta) < 1) continue;
      slide(now.get(ref).el, delta, 0);
      moved.push(now.get(ref).el);
    }
    if (!moved.length) return;
    void list.offsetHeight; // one style flush for all of them, then they slide from where they were shown to where they are
    for (const node of moved) slide(node, 0, SHIFT_MS);
    setTimeout(() => { for (const node of moved) if (!node.style.transform) node.style.transition = ''; }, SHIFT_MS + 60);
  });

  const begin = (handle, pointer) => {
    if (live.current) live.current.abort();
    const list = listRef.current;
    const host = hostRef.current;
    const row = spec.row(handle);
    if (!list || !host || !row) return;
    const ref = spec.key(row);
    const keyboard = !pointer;
    const s = { ref, picked: false, frame: 0, timer: 0, rows: [], from: 0, index: 0, y: pointer ? pointer.y : 0, motion: !reducedMotion(), targets: [], target: null };
    live.current = s;
    const rowsShown = () => s.rows.length;
    const place = (top, animate) => {
      s.float.style.transition = animate && s.motion ? `transform ${SETTLE_MS}ms ease-out` : 'none';
      s.float.style.transform = `translate3d(${s.left}px, ${top - s.originY}px, 0)`;
    };
    // The slot moves to `s.index` (the number of the other rows that come before it), the rows it passed slide by its height.
    const arrange = () => {
      const height = s.rows[s.from].height;
      let slot = 0;
      s.rows.forEach((item, j) => {
        if (j === s.from) return;
        let shift = 0;
        if (j < s.from && j >= s.index) { shift = height; slot -= item.height; }
        if (j > s.from && j <= s.index) { shift = -height; slot += item.height; }
        set(item, shift);
      });
      set(s.rows[s.from], slot);
    };
    function set(item, shift) {
      if (item.shift === shift) return;
      item.shift = shift;
      slide(item.el, shift, s.motion ? SHIFT_MS : 0);
    }
    const slotTop = () => { const slot = s.rows[s.from]; return s.box.top + slot.top + slot.shift - list.scrollTop; };
    const first = () => s.rows[0];
    const last = () => s.rows[s.rows.length - 1];
    // Pointer: the copy follows the pointer inside the list (and, `clamp`, inside its own rows); the slot goes where the copy's top edge passed the middle
    // of a row above it, or its bottom edge the middle of a row below it (the places measured at the start, in the list's own coordinates).
    const aim = () => {
      let top = Math.min(Math.max(s.y - s.grab, s.box.top - s.headHeight / 2), s.box.bottom - s.headHeight / 2);
      if (spec.clamp) {
        const base = s.box.top - list.scrollTop;
        top = Math.min(Math.max(top, base + first().top), base + last().top + last().height - s.headHeight);
      }
      place(top, false);
      // Over a drop target (`targets`, for example the title of another group): the row goes back to its place and the target is marked.
      const over = s.targets.find(el => { const box = el.getBoundingClientRect(); return box.height && s.y >= box.top && s.y <= box.bottom; }) || null;
      if (over !== s.target) {
        if (s.target) s.target.removeAttribute('data-drop-over');
        s.target = over;
        if (over) over.setAttribute('data-drop-over', 'true');
        s.float.classList.toggle('h5-task-float-over', Boolean(over)); // see-through, so the target under the finger shows
      }
      if (over) { if (s.index !== s.from) { s.index = s.from; arrange(); } return; }
      const upper = top - s.box.top + list.scrollTop;
      const lower = upper + s.headHeight;
      let index = 0;
      s.rows.forEach((item, j) => {
        const middle = item.top + item.height / 2;
        if ((j < s.from && upper >= middle) || (j > s.from && lower > middle)) index += 1;
      });
      if (index !== s.index) { s.index = index; arrange(); }
    };
    // Near an edge of the list it scrolls, faster the closer the pointer is; the slot follows. Rows kept inside their group scroll only while part of
    // the group is out of view on that side.
    const scroll = () => {
      s.frame = 0;
      if (!s.picked || keyboard) return;
      const top = s.y - s.box.top;
      const bottom = s.box.bottom - s.y;
      let step = top < EDGE_PX ? -Math.ceil(MAX_SCROLL_PX * (1 - Math.max(top, 0) / EDGE_PX)) : bottom < EDGE_PX ? Math.ceil(MAX_SCROLL_PX * (1 - Math.max(bottom, 0) / EDGE_PX)) : 0;
      if (spec.clamp && ((step < 0 && first().top >= list.scrollTop) || (step > 0 && last().top + last().height <= list.scrollTop + list.clientHeight))) step = 0;
      if (!step) return;
      const was = list.scrollTop;
      list.scrollTop += step;
      if (list.scrollTop !== was) aim();
      s.frame = requestAnimationFrame(scroll);
    };
    const position = () => `${s.index + 1}`;
    const pick = () => {
      s.rows = spec.peers(list, row).map(el => ({ el, ref: spec.key(el), top: topIn(el, list), height: el.offsetHeight, shift: 0 }));
      s.from = s.index = s.rows.findIndex(item => item.el === row);
      if (s.from < 0) { stop(); live.current = null; return; }
      s.picked = true;
      s.targets = !keyboard && spec.targets ? spec.targets(list, row) : [];
      s.box = list.getBoundingClientRect();
      const head = spec.head(row);
      const box = head.getBoundingClientRect();
      s.headHeight = box.height;
      s.grab = keyboard ? 0 : s.y - box.top;
      // The floating copy: the row's own line (not a task's sessions), lifted. It is `position: fixed`; where its (0, 0) really is gets measured, so an
      // ancestor that makes a containing block (a transformed sheet) cannot move it off the pointer.
      const float = document.createElement('div');
      float.className = spec.floatClass;
      float.setAttribute('aria-hidden', 'true');
      float.inert = true;
      const body = document.createElement('div');
      body.className = 'h5-task-float-body';
      const copy = head.cloneNode(true);
      for (const node of copy.querySelectorAll('.MuiTouchRipple-root')) node.remove(); // no ripple or focus ring frozen in the copy
      for (const node of copy.querySelectorAll('.Mui-focusVisible')) node.classList.remove('Mui-focusVisible');
      body.appendChild(copy);
      float.appendChild(body);
      float.style.width = `${box.width}px`;
      host.appendChild(float);
      const origin = float.getBoundingClientRect();
      s.left = box.left - origin.left;
      s.originY = origin.top;
      s.float = float;
      s.body = body;
      place(box.top, false);
      row.setAttribute('data-drag-slot', 'true');
      list.setAttribute('data-dragging', 'true');
      document.documentElement.setAttribute('data-task-drag', keyboard ? 'keyboard' : 'pointer');
      markDragging(true);
      void body.offsetWidth;
      body.classList.add('h5-task-float-lifted');
      if (keyboard) say(t(`Picked up at position ${position()} of ${rowsShown()}. Press Up or Down to move, Space to drop, Escape to cancel.`));
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
      handle.removeEventListener('blur', onBlur);
      list.removeEventListener('scroll', onScroll);
      if (s.target) s.target.removeAttribute('data-drop-over');
      list.removeAttribute('data-dragging');
      document.documentElement.removeAttribute('data-task-drag');
    };
    // The end of the settle: the copy goes, the row shows again in its place.
    const clear = () => {
      if (s.float) s.float.remove();
      row.removeAttribute('data-drag-slot');
      const memo = flip.current;
      if (memo.dropped && memo.dropped.owner === s) { // no commit moved the rows (nothing changed): their slides end here
        for (const node of memo.dropped.nodes) unslide(node);
        memo.dropped = null;
      }
      if (s.refocus) { const again = spec.focus(list, ref); if (again && document.activeElement !== again) again.focus({ preventScroll: true }); }
      if (live.current === s) live.current = null;
    };
    // Drop (`save`) or put back. The copy settles into the slot; the order is saved at once, and the commit that moves the rows clears their slides,
    // starting from where they are shown, so nothing jumps.
    const end = save => {
      const target = save ? s.target : null;
      stop();
      if (!s.picked) { if (live.current === s) live.current = null; return; }
      if (!save && s.index !== s.from) { s.index = s.from; arrange(); }
      s.picked = false;
      s.refocus = keyboard && save;
      place(slotTop(), true);
      s.body.classList.remove('h5-task-float-lifted');
      const others = s.rows.filter((_, j) => j !== s.from);
      flip.current.dropped = {
        owner: s, nodes: s.rows.map(item => item.el), focus: s.refocus ? ref : null,
        at: new Map(s.rows.map(item => [item.ref, item.top + item.shift])),
      };
      if (target && spec.dropOn) spec.dropOn(ui, s, target, say);
      else if (save && s.index !== s.from) spec.drop(ui, s, others, say);
      else markDragging(false);
      setTimeout(clear, s.motion ? SETTLE_MS + 20 : 0);
    };
    // Keyboard: one row per press; the list scrolls to keep the slot in view, and the copy sits on the slot.
    const step = by => {
      const index = Math.min(Math.max(s.index + by, 0), s.rows.length - 1);
      if (index === s.index) { say(t(`Moved to position ${position()} of ${rowsShown()}`)); return; }
      s.index = index;
      arrange();
      const slot = s.rows[s.from];
      const top = slot.top + slot.shift;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + slot.height > list.scrollTop + list.clientHeight) list.scrollTop = top + slot.height - list.clientHeight;
      place(slotTop(), true);
      say(t(`Moved to position ${position()} of ${rowsShown()}`));
    };
    s.abort = () => { stop(); if (s.picked) { s.picked = false; for (const item of s.rows) unslide(item.el); markDragging(false); } clear(); };
    // The click a mouse button sends after a drag lands on what is under it, and so may the release of a finger that held a row still: it is swallowed
    // once (it comes right after the pointerup). When none comes (a finger that moved sends none), the click of the next press is not the drag's.
    const swallowClick = () => {
      const eat = event => { event.preventDefault(); event.stopPropagation(); };
      const done = () => { window.removeEventListener('click', eat, { capture: true }); window.removeEventListener('pointerdown', done, { capture: true }); };
      window.addEventListener('click', eat, { capture: true, once: true });
      window.addEventListener('pointerdown', done, { capture: true, once: true });
      setTimeout(done, 400);
    };
    function onMove(event) {
      if (event.pointerId !== pointer.id) return;
      s.y = event.clientY;
      if (!s.picked) {
        const far = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
        if (spec.hold && !pointer.mouse) { if (far > HOLD_SLOP_PX) { stop(); live.current = null; } return; } // the finger is scrolling the list
        if (far <= DRAG_MOVE_PX) return;
        pick();
        if (!s.picked) return;
      }
      aim();
      if (!s.frame) s.frame = requestAnimationFrame(scroll);
    }
    // A press that never became a drag is a tap: on a task's tag it opens or closes the task's sessions, like the row; on a session row its own click runs.
    function onUp(event) {
      if (event.pointerId !== pointer.id) return;
      const tap = !s.picked;
      if (s.picked && (pointer.mouse || spec.hold)) swallowClick();
      end(true);
      if (tap && spec.tap) spec.tap(ui, ref);
    }
    function onCancel(event) { if (event.pointerId === pointer.id) end(false); }
    function onKey(event) {
      if (event.key === 'Escape') {
        if (!s.picked) return;
        event.preventDefault();
        event.stopPropagation(); // the sheet stays open
        end(false);
        if (keyboard) say(t('Reorder cancelled'));
        return;
      }
      if (!keyboard) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); step(event.key === 'ArrowUp' ? -1 : 1); }
      else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        say(t(`Dropped at position ${position()} of ${rowsShown()}`));
        end(true);
      }
    }
    function onBlur() { if (live.current === s && s.picked) { end(false); say(t('Reorder cancelled')); } }
    function onScroll() { if (s.picked) place(slotTop(), true); } // the same target as the move that scrolled, so its slide goes on
    // A long press would open the context menu of a touch browser (Android Chrome).
    function onMenu(event) { event.preventDefault(); }
    window.addEventListener('keydown', onKey, true);
    if (keyboard) {
      handle.addEventListener('blur', onBlur);
      list.addEventListener('scroll', onScroll);
      pick();
      return;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    if (!pointer.mouse) window.addEventListener('contextmenu', onMenu, true);
    // A held press picks the row up where it is.
    if (spec.hold) {
      s.timer = setTimeout(() => {
        s.timer = 0;
        if (live.current !== s || s.picked) return;
        pick();
        if (!s.picked) return;
        if (!pointer.mouse && typeof navigator.vibrate === 'function') { try { navigator.vibrate(10); } catch { /* not allowed here */ } }
        aim();
      }, HOLD_MS);
    }
  };
  const pressed = event => ({ id: event.pointerId, x: event.clientX, y: event.clientY, mouse: event.pointerType === 'mouse' });
  const primary = event => event.isPrimary && !(event.pointerType === 'mouse' && event.button !== 0);
  // The props of the tag of a task row that can be moved.
  const grip = () => ({
    onPointerDown: event => {
      if (!primary(event)) return;
      event.preventDefault(); // no text selection, and a mouse does not move the focus to the tag
      begin(event.currentTarget, pressed(event));
    },
    onKeyDown: event => {
      if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat || (live.current && live.current.picked)) return;
      event.preventDefault();
      event.stopPropagation();
      begin(event.currentTarget, null);
    },
    onContextMenu: event => event.preventDefault(),
  });
  // The props of a row that is held to move it (a session row, a T-Attention row): the whole row except its "⋯" (`spec.ignore`: the controls in the row). Nothing is cancelled here, so a press that is not held stays a tap or a
  // scroll; a context menu is cancelled only while the row is pressed.
  const hold = () => ({
    onPointerDown: event => {
      if (!primary(event) || (event.target.closest && event.target.closest(spec.ignore || '.h5-terminal-more'))) return;
      begin(event.currentTarget, pressed(event));
    },
    onContextMenu: event => { if (live.current) event.preventDefault(); },
  });
  return { grip, hold };
}

// The drag (useListDrag): the row's place is an empty slot (dashed, softly tinted), and the copy that floats under the pointer is lifted: a raised
// background, a soft shadow with a faint primary outline, 2% larger, its engine tag picked out (a solid ring in the tag's colour and a shadow under it).
export const DRAG_SX = theme => ({
  // Not `visibility: hidden`: that would take the focus from the grip of a task moved with the keyboard.
  '& .h5-task[data-drag-slot] > *': { opacity: 0, pointerEvents: 'none' },
  '& .h5-task[data-drag-slot]::before': {
    content: '""', position: 'absolute', inset: '3px 2px', borderRadius: '8px', pointerEvents: 'none',
    border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.55)}`, backgroundColor: alpha(theme.palette.primary.main, 0.08),
  },
  // A session row being dragged (SESSION_DRAG): the same slot, inside the row's own rounded box, and the same lifted copy.
  '& .h5-terminal-row[data-drag-slot]': { position: 'relative', backgroundColor: 'transparent', borderColor: 'transparent' },
  '& .h5-terminal-row[data-drag-slot] > *': { opacity: 0, pointerEvents: 'none' },
  '& .h5-terminal-row[data-drag-slot]::before': {
    content: '""', position: 'absolute', inset: '2px 0', borderRadius: '8px', pointerEvents: 'none',
    border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.55)}`, backgroundColor: alpha(theme.palette.primary.main, 0.08),
  },
  // A T-Attention row (Attention.jsx): its whole block (the row and its sub-tasks) is the slot.
  '& .h5-attention-node[data-drag-slot]': { position: 'relative' },
  '& .h5-attention-node[data-drag-slot] > *': { opacity: 0, pointerEvents: 'none' },
  '& .h5-attention-node[data-drag-slot]::before': {
    content: '""', position: 'absolute', inset: '2px 4px', borderRadius: '8px', pointerEvents: 'none',
    border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.55)}`, backgroundColor: alpha(theme.palette.primary.main, 0.08),
  },
  '& .h5-task-float': { position: 'fixed', left: 0, top: 0, zIndex: 5, pointerEvents: 'none', willChange: 'transform' },
  '& .h5-task-float-body': {
    borderRadius: '8px', backgroundColor: theme.palette.background.paper, backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.1))',
    boxShadow: 'none', transformOrigin: '50% 50%', transition: `transform ${SETTLE_MS}ms ease-out, box-shadow ${SETTLE_MS}ms ease-out`,
  },
  '& .h5-task-float-over .h5-task-float-body': { opacity: 0.55 },
  '& .h5-task-float-lifted': { transform: 'scale(1.02)', boxShadow: `${theme.shadows[8]}, 0 0 0 1px ${alpha(theme.palette.primary.main, 0.35)}` },
  '& .h5-task-float .h5-device-tag': { borderColor: 'currentColor', borderStyle: 'solid', boxShadow: theme.shadows[4] },
  '@media (prefers-reduced-motion: reduce)': { '& .h5-task-float-body': { transition: 'none' } },
});

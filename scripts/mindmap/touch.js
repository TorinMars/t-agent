// Finger and pen gestures on the map. The library's own touch handling starts a topic drag only after a long press, so these gestures are handled here and the
// library never sees a touch pointer: a tap selects, a tap on the selected topic or a double tap edits, a drag on a topic moves it, one finger on empty canvas pans,
// two fingers pinch. A mouse is left to the library.
const MOVE_THRESHOLD = 8; // px before a press counts as a drag
const DOUBLE_TAP_MS = 320;
const EDGE = 40; // px from the canvas edge where a dragged topic scrolls the map
const EDGE_SPEED = 6;

const topicOf = el => (el && el.closest ? el.closest('.me-tpc') : null);
const insideOf = (node, other) => { for (let n = other; n; n = n.parent) if (n === node) return true; return false; };

export function attachTouch(mind, { editing, finishEdit, requestEdit, onDragEnd }) {
  const box = mind.container;
  const pointers = new Map();
  let mode = 'idle';
  let press = null;
  let pinch = null;
  let ghost = null;
  let drop = null;
  let frame = 0;
  let lastTap = { time: 0, id: null };
  let pendingEdit = null;

  const point = e => ({ x: e.clientX, y: e.clientY });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function reset() {
    mode = 'idle';
    press = null;
    pinch = null;
    if (ghost) { ghost.remove(); ghost = null; }
    clearDrop();
    cancelAnimationFrame(frame);
    frame = 0;
  }
  function clearDrop() {
    if (drop) drop.el.classList.remove('mm-drop-in', 'mm-drop-before', 'mm-drop-after');
    drop = null;
  }

  function startDrag(e) {
    mode = 'drag';
    if (!mind.currentNodes.includes(press.topic)) mind.selectNode(press.topic);
    ghost = document.createElement('div');
    ghost.className = 'mm-ghost';
    ghost.setAttribute('translate', 'no');
    ghost.textContent = press.topic.nodeObj.topic;
    box.append(ghost);
    moveGhost(e);
    frame = requestAnimationFrame(edgeScroll);
  }
  function moveGhost(e) {
    const rect = box.getBoundingClientRect();
    ghost.style.left = `${e.clientX - rect.left}px`;
    ghost.style.top = `${e.clientY - rect.top}px`;
    press.last = point(e);
    updateDrop(e.clientX, e.clientY);
  }
  function updateDrop(x, y) {
    const el = topicOf(document.elementFromPoint(x, y));
    clearDrop();
    if (!el || !el.nodeObj || el === press.topic || insideOf(press.topic.nodeObj, el.nodeObj)) return;
    const rect = el.getBoundingClientRect();
    const ratio = (y - rect.top) / rect.height;
    const type = !el.nodeObj.parent || (ratio > 0.3 && ratio < 0.7) ? 'in' : ratio <= 0.3 ? 'before' : 'after';
    el.classList.add(`mm-drop-${type}`);
    drop = { el, type };
  }
  function edgeScroll() {
    if (mode !== 'drag' || !press.last) return;
    const rect = box.getBoundingClientRect();
    const { x, y } = press.last;
    const dx = x < rect.left + EDGE ? EDGE_SPEED : x > rect.right - EDGE ? -EDGE_SPEED : 0;
    const dy = y < rect.top + EDGE ? EDGE_SPEED : y > rect.bottom - EDGE ? -EDGE_SPEED : 0;
    if (dx || dy) { mind.move(dx, dy); updateDrop(x, y); }
    frame = requestAnimationFrame(edgeScroll);
  }
  function finishDrag() {
    const target = drop;
    const moving = [press.topic];
    reset();
    if (!target) return;
    if (target.type === 'in') mind.moveNodesIn(moving, target.el);
    else if (target.type === 'before') mind.moveNodesBefore(moving, target.el);
    else mind.moveNodesAfter(moving, target.el);
    onDragEnd();
  }

  function onDown(e) {
    if (e.pointerType === 'mouse') return;
    if (e.target.closest && e.target.closest('#input-box')) { e.stopImmediatePropagation(); return; } // the caret and text selection of the topic being edited; not a pan of the map
    e.stopImmediatePropagation();
    pointers.set(e.pointerId, point(e));
    if (pointers.size >= 2) {
      if (mode === 'drag') { if (ghost) ghost.remove(); ghost = null; clearDrop(); }
      const [a, b] = [...pointers.values()];
      mode = 'pinch';
      press = null;
      pinch = { dist: distance(a, b), mid: midpoint(a, b) };
      return;
    }
    if (mode !== 'idle') return;
    const topic = topicOf(e.target);
    press = { id: e.pointerId, start: point(e), last: point(e), topic, selectedBefore: Boolean(topic && mind.currentNodes.includes(topic)) };
    mode = 'press';
  }

  function onMove(e) {
    if (e.pointerType === 'mouse' || !pointers.has(e.pointerId)) return;
    e.stopImmediatePropagation();
    const previous = pointers.get(e.pointerId);
    const now = point(e);
    pointers.set(e.pointerId, now);
    if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = distance(a, b);
      const mid = midpoint(a, b);
      if (pinch.dist > 0 && dist > 0) mind.scale(mind.scaleVal * (dist / pinch.dist), mid);
      mind.move(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
      pinch = { dist, mid };
      return;
    }
    if (mode === 'press' && press && e.pointerId === press.id && distance(press.start, now) > MOVE_THRESHOLD) {
      if (editing()) finishEdit();
      if (press.topic && press.topic.nodeObj && press.topic.nodeObj.parent) startDrag(e);
      else mode = 'pan';
      return;
    }
    if (mode === 'pan' && press && e.pointerId === press.id) { mind.move(now.x - previous.x, now.y - previous.y); return; }
    if (mode === 'drag' && press && e.pointerId === press.id) moveGhost(e);
  }

  function onUp(e) {
    if (e.pointerType === 'mouse' || !pointers.has(e.pointerId)) return;
    e.stopImmediatePropagation();
    pointers.delete(e.pointerId);
    if (mode === 'drag' && press && e.pointerId === press.id) { finishDrag(); return; }
    if (mode === 'press' && press && e.pointerId === press.id) { tap(e); return; }
    if (!pointers.size) reset();
  }

  function tap() {
    const { topic, selectedBefore } = press;
    reset();
    if (editing()) { finishEdit(); return; }
    if (!topic || !topic.nodeObj) { mind.clearSelection(); return; }
    const now = Date.now();
    const double = lastTap.id === topic.nodeObj.id && now - lastTap.time < DOUBLE_TAP_MS;
    lastTap = { time: now, id: topic.nodeObj.id };
    if (selectedBefore || double) { pendingEdit = topic; return; } // the click that follows this tap opens the editor, inside the user gesture (iOS needs it to raise the keyboard)
    mind.selectNode(topic);
  }

  // Focus must move inside a gesture the browser trusts: the click is the one iOS accepts.
  function onClick(e) {
    if (!pendingEdit) return;
    const topic = pendingEdit;
    pendingEdit = null;
    if (topic.isConnected && !e.target.closest('a,.me-epd')) requestEdit(topic);
  }

  function onCancel(e) {
    if (e.pointerType === 'mouse') return;
    pointers.delete(e.pointerId);
    if (!pointers.size) reset();
  }

  box.addEventListener('pointerdown', onDown, true);
  box.addEventListener('pointermove', onMove, true);
  box.addEventListener('pointerup', onUp, true);
  box.addEventListener('pointercancel', onCancel, true);
  box.addEventListener('click', onClick, true);
  return () => {
    reset();
    box.removeEventListener('pointerdown', onDown, true);
    box.removeEventListener('pointermove', onMove, true);
    box.removeEventListener('pointerup', onUp, true);
    box.removeEventListener('pointercancel', onCancel, true);
    box.removeEventListener('click', onClick, true);
  };
}

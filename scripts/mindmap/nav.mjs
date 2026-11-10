// Arrow keys move the selection to the topic that lies in that direction on the screen (as XMind does), not by tree order.
// rects: [{ id, left, top, right, bottom }]; returns the id, or null when nothing lies that way.
const center = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

export function pickDirectional(rects, currentId, dir) {
  const cur = rects.find(r => r.id === currentId);
  if (!cur) return null;
  const from = center(cur);
  let best = null;
  let bestScore = Infinity;
  for (const r of rects) {
    if (r.id === currentId) continue;
    const to = center(r);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const horizontal = dir === 'left' || dir === 'right';
    // Must really be on that side: the middle of the other topic is past this topic's middle in the direction asked, by more than rounding.
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    if (along <= 1) continue;
    const across = horizontal ? Math.abs(dy) : Math.abs(r.left - cur.left); // the topics of a column share their left edge, not their middle
    // Moving sideways costs more than moving along, so the next topic on the same row or column wins over a nearer one that is off to the side.
    const score = along + across * 3;
    if (score < bestScore) { bestScore = score; best = r.id; }
  }
  return best;
}

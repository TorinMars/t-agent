// The math of the full-screen image viewer (scripts/h5-shell/ImageViewer.jsx). A view is { s, x, y }: the content, laid out centred at its fit size,
// is drawn with `translate(x, y) scale(s)` around its centre. Points are in px from the centre of the stage.

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const FIT = Object.freeze({ s: 1, x: 0, y: 0 });

const clampScale = s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// Keeps the content over the stage: a side smaller than the stage stays centred, a larger one cannot leave a gap at its edges.
// `content` is the fit size { w, h }, `stage` the stage size { w, h }.
export function clampView(view, content, stage) {
  const s = clampScale(view.s);
  const limX = Math.max(0, (content.w * s - stage.w) / 2);
  const limY = Math.max(0, (content.h * s - stage.h) / 2);
  return { s, x: Math.min(limX, Math.max(-limX, view.x)), y: Math.min(limY, Math.max(-limY, view.y)) };
}

// Zooms `from` to scale `s` keeping the content point under `point` where it is (a wheel step, a double tap).
export function zoomAt(from, s, point) {
  const next = clampScale(s);
  const k = next / from.s;
  return { s: next, x: point.x - (point.x - from.x) * k, y: point.y - (point.y - from.y) * k };
}

// A pinch: the content point that was under the fingers' first midpoint `startMid` follows their midpoint `mid`, scaled by the change of their distance.
export function pinch(start, startMid, startDistance, mid, distance) {
  const s = clampScale(start.s * (distance / Math.max(1, startDistance)));
  const k = s / start.s;
  return { s, x: mid.x - (startMid.x - start.x) * k, y: mid.y - (startMid.y - start.y) * k };
}

// The scale a double tap zooms to: 2x, or the image's natural size when that is larger (a big picture shown small), at most MAX_SCALE.
export function detailScale(natural, shown) {
  const ratio = natural && shown ? natural / shown : 0;
  return Math.min(MAX_SCALE, Math.max(2, ratio));
}

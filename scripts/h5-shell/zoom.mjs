// The math of the full-screen image viewer (scripts/h5-shell/ImageViewer.jsx). A view is { s, x, y }: the content, laid out centred at its fit size,
// is drawn with `translate(x, y) scale(s)` around its centre. Points are in px from the centre of the stage. Scales are relative to the fit size
// (1 = fit). The functions take an optional `max` (the largest scale, see maxScale); it defaults to MAX_SCALE.

export const MIN_SCALE = 1;
export const MAX_SCALE = 8; // the smallest largest scale: a picture can always be zoomed to 8x its fit size
export const ACTUAL_ZOOM = 4; // and also to 4x its actual pixels, so a big photo shown small reaches full detail
export const STEP = 1.5; // one press of Zoom in / Zoom out
export const FIT = Object.freeze({ s: 1, x: 0, y: 0 });

const clampScale = (s, max = MAX_SCALE) => Math.min(Math.max(MIN_SCALE, max), Math.max(MIN_SCALE, s));

// The scale at which one pixel of the picture is one CSS pixel (the "1:1" button), or null when it is unknown (a diagram, or a size not known yet).
// `natural` is the picture's natural width, `shown` its width at fit.
export function actualScale(natural, shown) {
  return natural > 0 && shown > 0 ? natural / shown : null;
}

// The largest scale: MAX_SCALE, or enough for ACTUAL_ZOOM times the actual pixels when that is larger.
export function maxScale(natural, shown) {
  const actual = actualScale(natural, shown);
  return Math.max(MAX_SCALE, actual ? actual * ACTUAL_ZOOM : 0);
}

// The zoom shown in the toolbar, in percent: relative to the actual pixels when known, else to the fit size.
export function zoomPercent(s, actual) {
  return Math.round((actual ? s / actual : s) * 100);
}

// The next scale of Zoom in (`direction` 1) or Zoom out (-1): one STEP further, landing on the actual size when a step would pass it, within 1 to max.
export function stepScale(s, direction, actual, max = MAX_SCALE) {
  const next = direction > 0 ? s * STEP : s / STEP;
  if (actual && actual > MIN_SCALE && (direction > 0 ? s < actual * 0.999 && next > actual * 1.001 : s > actual * 1.001 && next < actual * 0.999)) return clampScale(actual, max);
  return clampScale(next, max);
}

// Keeps the content over the stage: a side smaller than the stage stays centred, a larger one cannot leave a gap at its edges.
// `content` is the fit size { w, h }, `stage` the stage size { w, h }.
export function clampView(view, content, stage, max = MAX_SCALE) {
  const s = clampScale(view.s, max);
  const limX = Math.max(0, (content.w * s - stage.w) / 2);
  const limY = Math.max(0, (content.h * s - stage.h) / 2);
  return { s, x: Math.min(limX, Math.max(-limX, view.x)), y: Math.min(limY, Math.max(-limY, view.y)) };
}

// Zooms `from` to scale `s` keeping the content point under `point` where it is (a wheel step, a double tap, a toolbar button at the centre).
export function zoomAt(from, s, point, max = MAX_SCALE) {
  const next = clampScale(s, max);
  const k = next / from.s;
  return { s: next, x: point.x - (point.x - from.x) * k, y: point.y - (point.y - from.y) * k };
}

// A pinch: the content point that was under the fingers' first midpoint `startMid` follows their midpoint `mid`, scaled by the change of their distance.
export function pinch(start, startMid, startDistance, mid, distance, max = MAX_SCALE) {
  const s = clampScale(start.s * (distance / Math.max(1, startDistance)), max);
  const k = s / start.s;
  return { s, x: mid.x - (startMid.x - start.x) * k, y: mid.y - (startMid.y - start.y) * k };
}

// The scale a double tap zooms to: 2x, or the image's natural size when that is larger (a big picture shown small), at most `max`.
export function detailScale(natural, shown, max = MAX_SCALE) {
  const ratio = natural && shown ? natural / shown : 0;
  return Math.min(max, Math.max(2, ratio));
}

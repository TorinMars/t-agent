// The math of the full-screen image viewer of the design document sheet (scripts/h5-shell/zoom.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');

test('zooming at a point keeps that point still, within 1x to 8x', async () => {
  const { zoomAt, FIT, MAX_SCALE } = await import('../scripts/h5-shell/zoom.mjs');
  assert.deepEqual(zoomAt(FIT, 2, { x: 100, y: -50 }), { s: 2, x: -100, y: 50 });
  assert.deepEqual(zoomAt({ s: 2, x: -100, y: 50 }, 1, { x: 100, y: -50 }), { s: 1, x: 0, y: 0 }, 'back to fit');
  assert.equal(zoomAt(FIT, 100, { x: 0, y: 0 }).s, MAX_SCALE);
  assert.equal(zoomAt(FIT, 0.2, { x: 0, y: 0 }).s, 1, 'never smaller than fit');
});

test('a pinch scales by the change of the finger distance and follows the midpoint', async () => {
  const { pinch, FIT } = await import('../scripts/h5-shell/zoom.mjs');
  assert.deepEqual(pinch(FIT, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 300), { s: 3, x: 0, y: 0 });
  assert.deepEqual(pinch(FIT, { x: 50, y: 0 }, 100, { x: 70, y: 10 }, 200), { s: 2, x: -30, y: 10 });
});

test('the view cannot leave a gap at the edges', async () => {
  const { clampView } = await import('../scripts/h5-shell/zoom.mjs');
  const content = { w: 390, h: 260 };
  const stage = { w: 390, h: 844 };
  assert.deepEqual(clampView({ s: 2, x: 999, y: 999 }, content, stage), { s: 2, x: 195, y: 0 }, 'a side still smaller than the stage stays centred');
  assert.deepEqual(clampView({ s: 4, x: -999, y: 999 }, content, stage), { s: 4, x: -585, y: 98 });
});

test('a double tap zooms to 2x or to the natural size', async () => {
  const { detailScale } = await import('../scripts/h5-shell/zoom.mjs');
  assert.equal(detailScale(1200, 390).toFixed(2), '3.08');
  assert.equal(detailScale(300, 300), 2);
  assert.equal(detailScale(9000, 300), 8);
  assert.equal(detailScale(0, 0), 2);
});

test('actual pixels: the 1:1 scale and the largest scale', async () => {
  const { actualScale, maxScale, MAX_SCALE } = await import('../scripts/h5-shell/zoom.mjs');
  assert.equal(actualScale(1200, 400), 3);
  assert.equal(actualScale(0, 400), null, 'unknown natural size');
  assert.equal(actualScale(1200, 0), null, 'not laid out yet');
  assert.equal(maxScale(0, 0), MAX_SCALE, 'a diagram: 8x');
  assert.equal(maxScale(800, 400), 8, 'a small picture: still 8x');
  assert.equal(maxScale(6000, 300), 80, 'a big photo: 4x its actual pixels (20 x 4)');
});

test('the zoom percent is of the actual pixels when known, else of the fit size', async () => {
  const { zoomPercent } = await import('../scripts/h5-shell/zoom.mjs');
  assert.equal(zoomPercent(1, 3), 33);
  assert.equal(zoomPercent(3, 3), 100);
  assert.equal(zoomPercent(6, 3), 200);
  assert.equal(zoomPercent(1, null), 100);
  assert.equal(zoomPercent(2.5, null), 250);
});

test('zoom steps are 1.5x, land on the actual size when passing it, and stay within 1 to max', async () => {
  const { stepScale, STEP } = await import('../scripts/h5-shell/zoom.mjs');
  assert.equal(STEP, 1.5);
  assert.equal(stepScale(1, 1, null), 1.5);
  assert.equal(stepScale(1.5, -1, null), 1);
  assert.equal(stepScale(2, 1, 2.5, 10), 2.5, 'stops at 1:1 on the way in');
  assert.equal(stepScale(2.5, 1, 2.5, 10), 3.75, 'and goes on from it');
  assert.equal(stepScale(3, -1, 2.5, 10), 2.5, 'stops at 1:1 on the way out');
  assert.equal(stepScale(1.2, -1, null), 1, 'never below fit');
  assert.equal(stepScale(7, 1, null), 8, 'at most 8x by default');
  assert.equal(stepScale(70, 1, 20, 80), 80, 'at most the given max');
  assert.equal(stepScale(1, 1, 1), 1.5, 'a picture at its natural size at fit');
});

test('a larger max lets zoom, pinch, the clamp and a double tap go further', async () => {
  const { zoomAt, pinch, clampView, detailScale, FIT } = await import('../scripts/h5-shell/zoom.mjs');
  assert.equal(zoomAt(FIT, 30, { x: 0, y: 0 }, 80).s, 30);
  assert.equal(zoomAt(FIT, 300, { x: 0, y: 0 }, 80).s, 80);
  assert.equal(pinch(FIT, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 500, 80).s, 50);
  assert.equal(clampView({ s: 50, x: 0, y: 0 }, { w: 10, h: 10 }, { w: 100, h: 100 }, 80).s, 50);
  assert.equal(detailScale(6000, 300, 80), 20, 'a big photo: the double tap reaches its natural size');
});

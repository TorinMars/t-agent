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

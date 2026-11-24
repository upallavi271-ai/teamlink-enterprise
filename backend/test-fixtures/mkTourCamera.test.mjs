// AI Marketing > AI Video: the free DASHBOARD TOUR camera (slideshow.js tourAt / tourRect): glides across a screenshot and never leaves the picture.
//   node backend/test-fixtures/mkTourCamera.test.mjs     (pure maths, no database, nothing is sent anywhere)
import assert from 'node:assert/strict';
import { tourAt, tourRect, MOTIONS } from '../../frontend/src/components/omni/marketing/slideshow.js';
assert.ok(MOTIONS.tour, 'tour option is listed');
let c = tourAt(0); assert.deepEqual([c.z, c.cx, c.cy], [1, 0.5, 0.5], 'starts on the whole picture');
c = tourAt(1); assert.deepEqual([c.z, c.cx, c.cy], [1, 0.5, 0.5], 'ends pulled back');
c = tourAt(0.05); assert.equal(c.z, 1, 'first rest');
c = tourAt(0.38); assert.ok(Math.abs(c.z - 1.6) < 1e-9 && Math.abs(c.cx - 0.27) < 1e-9 && Math.abs(c.cy - 0.30) < 1e-9, 'rests on the top left');
c = tourAt(0.61); assert.ok(Math.abs(c.cx - 0.73) < 1e-9, 'rests on the top right');
c = tourAt(0.80); assert.ok(Math.abs(c.z - 1.5) < 1e-9 && Math.abs(c.cy - 0.72) < 1e-9, 'rests on the lower part');
assert.ok(Math.abs(tourAt(0.38, 1).cx - 0.73) < 1e-9, 'an odd picture is mirrored');
// smooth: no jump bigger than a small step between neighbouring frames (30 fps, 6 s)
let prev = tourAt(0); for (let i = 1; i <= 180; i++) { const n = tourAt(i / 180); assert.ok(Math.abs(n.z - prev.z) < 0.05 && Math.abs(n.cx - prev.cx) < 0.05 && Math.abs(n.cy - prev.cy) < 0.05, `jump at frame ${i}`); prev = n; }
assert.deepEqual([tourAt(-3).z, tourAt(7).z, tourAt(NaN).z, tourAt(undefined).z], [1, 1, 1, 1], 'odd input is safe');
// the camera never leaves the picture, for every shape and every moment
for (const [W, H] of [[1080, 1080], [1080, 1350], [720, 1280], [1280, 720]]) for (const [iw, ih] of [[1920, 1080], [1024, 576], [768, 960], [1080, 1080]]) for (let i = 0; i <= 120; i++) for (const idx of [0, 1]) {
  const r = tourRect(W, H, iw, ih, tourAt(i / 120, idx));
  assert.ok(r.x <= 1e-9 && r.y <= 1e-9 && r.x + r.w >= W - 1e-6 && r.y + r.h >= H - 1e-6, `edge shows: ${W}x${H} on ${iw}x${ih} at ${i}`);
}
console.log('tour camera: all passed');

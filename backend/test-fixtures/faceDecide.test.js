// The face decision (utils/faceEngine.js decide): identity, one face, and the LIVE move - a blink (eye-aspect-ratio OR eye contrast) or a head turn.
//   node backend/test-fixtures/faceDecide.test.js
// Synthetic frames only: { faces: [{ box, descriptor, yaw, ear, eyeContrast }] }. No camera, no model.
const assert = require('node:assert/strict');
const F = require('../src/utils/faceEngine');

const D = (v) => Array.from({ length: 128 }, (_, i) => (i === 0 ? v : 0)); // a descriptor, distance = |v - w|
const box = { x: 100, y: 80, width: 200, height: 240 };
const photo = [{ box, descriptor: D(0), yaw: 0, ear: 0.3 }];
const frame = (o = {}) => ({ faces: [{ box, descriptor: D(0.05), yaw: 0.0, ear: 0.3, eyeContrast: 30, ...o }] });
const noisy = (i, a) => a * Math.sin(i * 2.1); // landmark jitter
const run = (frames, action = 'blink', diffs = null) => F.decide({ photoFaces: photo, frames, diffs: diffs || frames.slice(1).map((_, i) => 3 + (i % 2)), action, threshold: 0.45 });

// 1. a normal blink at the EAR level: 0.30 -> 0.20 for two frames, then open again -> VERIFIED by a blink
let fr = Array.from({ length: 16 }, (_, i) => frame({ ear: (i === 6 || i === 7 ? 0.2 : 0.3) + noisy(i, 0.008), yaw: noisy(i, 0.004) }));
let d = run(fr);
assert.equal(d.ok, true, JSON.stringify(d)); assert.equal(d.liveness.how, 'blink');

// 2. a blink the landmarks barely saw (EAR 0.30 -> 0.27) but the eyes lost their contrast -> still a blink
fr = Array.from({ length: 16 }, (_, i) => frame({ ear: 0.3 + noisy(i, 0.006), eyeContrast: i === 8 ? 12 : 30 + noisy(i, 1), yaw: noisy(i, 0.004) }));
d = run(fr); assert.equal(d.ok, true, JSON.stringify(d));

// 3. no blink, no turn (a person staring, pictures differ a little by noise) -> LIVENESS, with the plain sentence
fr = Array.from({ length: 16 }, (_, i) => frame({ ear: 0.3 + noisy(i, 0.008), yaw: noisy(i, 0.004), eyeContrast: 30 + noisy(i, 1) }));
d = run(fr); assert.equal(d.ok, false); assert.equal(d.code, 'LIVENESS'); assert.match(d.reason, /blink/i);

// 4. a blink challenge answered with a clear head turn instead -> accepted (either move proves a live person)
fr = Array.from({ length: 16 }, (_, i) => frame({ yaw: -0.09 + i * 0.012, ear: 0.3 + noisy(i, 0.006) }));
d = run(fr, 'blink'); assert.equal(d.ok, true, JSON.stringify(d)); assert.equal(d.liveness.how, 'turn');

// 5. a turn challenge answered with a blink -> accepted
fr = Array.from({ length: 10 }, (_, i) => frame({ ear: (i === 4 ? 0.19 : 0.3) + noisy(i, 0.006), yaw: noisy(i, 0.004) }));
d = run(fr, 'turn'); assert.equal(d.ok, true, JSON.stringify(d));

// 6. identical pictures AND landmarks that never move (a photo held up) -> still, refused
fr = Array.from({ length: 16 }, () => frame({ ear: 0.3 }));
d = run(fr, 'blink', Array(15).fill(0.2)); assert.equal(d.ok, false); assert.equal(d.liveness.still, true);

// 7. a live face with a LOW thumbnail difference (a good camera in good light) but moving landmarks is NOT called still any more
fr = Array.from({ length: 16 }, (_, i) => frame({ ear: (i === 6 ? 0.2 : 0.3) + noisy(i, 0.008), yaw: noisy(i, 0.004) }));
d = run(fr, 'blink', Array(15).fill(0.3)); assert.equal(d.liveness.still, false); assert.equal(d.ok, true, JSON.stringify(d));

// 8. a dip at the very first / last frame is not a blink (no open eye on one side)
fr = Array.from({ length: 16 }, (_, i) => frame({ ear: (i === 0 || i === 15 ? 0.2 : 0.3) + noisy(i, 0.004), yaw: noisy(i, 0.003), eyeContrast: 30 }));
d = run(fr); assert.equal(d.ok, false); assert.equal(d.code, 'LIVENESS');

// 9. the wrong person is still refused, whatever the blink
fr = Array.from({ length: 16 }, (_, i) => frame({ descriptor: D(0.9), ear: (i === 6 ? 0.2 : 0.3) }));
d = run(fr); assert.equal(d.ok, false); assert.equal(d.code, 'NO_MATCH');

// 10. a second face is still refused
fr = Array.from({ length: 16 }, (_, i) => ({ faces: [frame({ ear: (i === 6 ? 0.2 : 0.3) }).faces[0], { box: { x: 400, y: 100, width: 190, height: 220 }, descriptor: D(0.7), yaw: 0, ear: 0.3 }] }));
d = run(fr); assert.equal(d.code, 'MULTIPLE_FACES');

// 11. the burst the screen takes: 16 pictures, 100 ms apart (about 1.6 s) for a blink
assert.equal(F.ACTIONS.blink.frames, 16); assert.equal(F.ACTIONS.blink.intervalMs, 100); assert.ok(F.ACTIONS.blink.frames <= F.MAX_FRAMES);

// 12. the verdict names a missed blink (it used to say "The face check was not available") and strict does not accept it
const CS = require('../src/utils/checkinSettings');
let v = CS.faceVerdict({ mode: 'required', code: 'LIVENESS', distance: 0.1 });
assert.equal(v.record, false); assert.match(v.reason, /blink/i);
v = CS.faceVerdict({ mode: 'strict', code: 'LIVENESS', distance: 0.1 });
assert.equal(v.record, false); assert.equal(v.matched, false);
v = CS.faceVerdict({ mode: 'required', code: 'VERIFIED', distance: 0.1 });
assert.equal(v.record, true); assert.equal(v.matched, true);
console.log('faceDecide: all checks passed');

// ---------------------------------------------------------------------------
// Face analysis worker (HRMS-24 §5). Runs in a worker_thread so the model's
// CPU work never blocks the API's event loop.
//
// Open-source model: @vladmandic/face-api (face-api.js) on TensorFlow.js with
// the WASM backend — pure WebAssembly, no native build, so it installs on
// Windows where tfjs-node does not. The model weights are read from the npm
// package on THIS server's disk (node_modules/@vladmandic/face-api/model); no
// CDN is contacted at runtime.
//
// Input : { id, mode: 'burst' | 'single', images: [{ data: Int32Array (RGB), width, height }] }
// Output: { id, results: [{ faces: [{ score, tracked?, box, yaw, roll, ear, descriptor }] }] }
// Decisions (match / liveness) are made by utils/faceEngine.js, not here.
// ---------------------------------------------------------------------------

const path = require('path');
const { parentPort } = require('worker_threads');

let tf;
let faceapi;
let ready = null;

function init() {
  if (!ready) {
    ready = (async () => {
      tf = require('@tensorflow/tfjs');
      require('@tensorflow/tfjs-backend-wasm');
      faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      await tf.setBackend('wasm');
      await tf.ready();
      const modelDir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
      // The small, fast detector: used only to START a chunk of a burst that is
      // split between workers (the first and last frames always use SSD).
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
    })();
  }
  return ready;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Eye aspect ratio (Soukupová & Čech): falls sharply when the eye closes.
function eyeAspect(p) {
  return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]));
}

function geometry(landmarks) {
  const p = landmarks.positions;
  // Yaw proxy: where the nose tip sits between the two jaw ends, 0 = centred.
  const yaw = (p[30].x - p[0].x) / Math.max(1, p[16].x - p[0].x) - 0.5;
  // Roll: the angle of the line through the outer eye corners, in degrees.
  const roll = (Math.atan2(p[45].y - p[36].y, p[45].x - p[36].x) * 180) / Math.PI;
  const ear = (eyeAspect(p.slice(36, 42)) + eyeAspect(p.slice(42, 48))) / 2;
  return { yaw: Number(yaw.toFixed(4)), roll: Number(roll.toFixed(2)), ear: Number(ear.toFixed(4)) };
}

// The two eye boxes from the landmarks (points 36-41 and 42-47), and how much CONTRAST the eyes show in the real picture.
// An open eye is a dark pupil in a light white: high grey spread. A closed lid is smooth skin: the spread drops. The 68-point landmarks come from a
// 112-pixel crop of the face, so the eye-aspect-ratio alone is noisy; this second signal reads the full-size pixels and does not depend on it.
function eyeBoxes(landmarks) {
  const p = landmarks.positions;
  const box = (pts) => {
    const xs = pts.map((q) => q.x); const ys = pts.map((q) => q.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  return [box(p.slice(36, 42)), box(p.slice(42, 48))];
}
function eyeContrast(img, boxes) {
  if (!boxes || !boxes.length) return null;
  const vals = [];
  for (const b of boxes) {
    const w = b.x1 - b.x0; const h = b.y1 - b.y0;
    const x0 = Math.max(0, Math.floor(b.x0 - 0.15 * w)); const x1 = Math.min(img.width - 1, Math.ceil(b.x1 + 0.15 * w));
    const y0 = Math.max(0, Math.floor(b.y0 - 0.3 * h)); const y1 = Math.min(img.height - 1, Math.ceil(b.y1 + 0.3 * h));
    if (x1 - x0 < 4 || y1 - y0 < 2) continue; // eslint-disable-line no-continue
    let n = 0; let sum = 0; let sum2 = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const i = (y * img.width + x) * 3;
        const g = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        n += 1; sum += g; sum2 += g * g;
      }
    }
    if (n) { const m = sum / n; vals.push(Math.sqrt(Math.max(0, sum2 / n - m * m))); }
  }
  return vals.length ? Number((vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(3)) : null;
}

const box4 = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });

function euclid(a, b) {
  let s = 0; for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// Full detection: SSD MobileNet -> 68 landmarks -> 128-d descriptor.
async function detectFull(tensor) {
  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 5 });
  const found = await faceapi.detectAllFaces(tensor, options).withFaceLandmarks().withFaceDescriptors();
  return found.map((f) => ({
    score: Number(f.detection.score.toFixed(3)),
    box: box4(f.detection.box),
    ...geometry(f.landmarks),
    descriptor: Array.from(f.descriptor),
    lmBox: landmarkBox(f.landmarks),
    eyes: eyeBoxes(f.landmarks),
  }));
}

function landmarkBox(landmarks) {
  const xs = landmarks.positions.map((p) => p.x); const ys = landmarks.positions.map((p) => p.y);
  const x0 = Math.min(...xs); const y0 = Math.min(...ys);
  return { cx: (x0 + Math.max(...xs)) / 2, cy: (y0 + Math.max(...ys)) / 2 };
}

// Fast detection for the first frame of a worker's chunk: the tiny detector,
// and SSD only when it finds nothing (so a hard frame is never lost).
async function detectFast(tensor, inputSize = 416, scoreThreshold = 0.5) {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold });
  const found = await faceapi.detectAllFaces(tensor, options).withFaceLandmarks().withFaceDescriptors();
  if (!found.length) return detectFull(tensor);
  return found.map((f) => ({
    score: Number(f.detection.score.toFixed(3)),
    box: box4(f.detection.box),
    ...geometry(f.landmarks),
    descriptor: Array.from(f.descriptor),
    lmBox: landmarkBox(f.landmarks),
    eyes: eyeBoxes(f.landmarks),
  }));
}

// Tracking: the detector box of the previous frame, re-centred on where the
// landmarks moved, fed straight to the landmark and descriptor nets. About
// five times cheaper than a fresh SSD pass. A crop that has lost the face
// yields a descriptor far from the anchor, and that frame is re-detected.
async function landmarksAt(tensor, W, H, cx, cy, w, h) {
  // Clipped at the image border exactly as the detector's own box is.
  const x0 = Math.max(0, cx - w / 2); const y0 = Math.max(0, cy - h / 2);
  const x1 = Math.min(W, cx + w / 2); const y1 = Math.min(H, cy + h / 2);
  if (x1 - x0 < 16 || y1 - y0 < 16) throw new Error('face left the frame');
  const rect = new faceapi.Rect(x0, y0, x1 - x0, y1 - y0);
  const [faceT] = await faceapi.extractFaceTensors(tensor, [rect]);
  try {
    return { rect, landmarks: (await faceapi.nets.faceLandmark68Net.detectLandmarks(faceT)).shiftBy(rect.x, rect.y) };
  } finally { faceT.dispose(); }
}

async function track(tensor, W, H, prev) {
  const w = prev.box.width; const h = prev.box.height;
  // Two passes: the second crop is re-centred on the first pass's landmarks,
  // so the crop sits on the face the way the detector's box did and the same
  // picture always yields the same landmarks (no jitter from crop placement).
  const first = await landmarksAt(tensor, W, H, prev.cx + prev.dx, prev.cy + prev.dy, w, h);
  const c = landmarkBox(first.landmarks);
  const { landmarks } = await landmarksAt(tensor, W, H, c.cx + prev.dx, c.cy + prev.dy, w, h);
  const aligned = landmarks.align(null, { useDlibAlignment: true });
  const [alignedT] = await faceapi.extractFaceTensors(tensor, [aligned]);
  let descriptor;
  try { descriptor = await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(alignedT); } finally { alignedT.dispose(); }
  return {
    // The nominal (unclipped) box, so its size carries to the next frame.
    score: null, tracked: true, box: box4({ x: c.cx + prev.dx - w / 2, y: c.cy + prev.dy - h / 2, width: w, height: h }), ...geometry(landmarks),
    descriptor: Array.from(descriptor), lmBox: landmarkBox(landmarks), eyes: eyeBoxes(landmarks),
  };
}

// images[0] and images[last] always get a full detection (so a second face
// anywhere in the scene is seen at the start and the end); the frames between
// are tracked from the previous one, falling back to a full detection when
// tracking drifts.
async function analyse(images, mode, opts = {}) {
  await init();
  const results = [];
  let prev = null;
  let anchor = null;
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    const tensor = tf.tensor3d(img.data, [img.height, img.width, 3], 'int32');
    try {
      let faces = null;
      // A chunk of a split burst may start with the fast detector (opts.fastFirst);
      // the LAST frame of the whole burst (opts.lastFull) always gets SSD.
      const lastFull = opts.lastFull !== false && i === images.length - 1;
      const fastStart = mode === 'burst' && i === 0 && opts.fastFirst && !lastFull;
      const full = mode !== 'burst' || i === 0 || lastFull || !prev;
      if (!full) {
        const t = await track(tensor, img.width, img.height, prev).catch(() => null);
        if (t && anchor && euclid(t.descriptor, anchor) <= 0.55) faces = [t];
      }
      // opts.quick (single frames of the fast check-in): the tiny detector at a small input size, SSD only if it finds nothing.
      if (!faces) faces = opts.quick ? await detectFast(tensor, opts.inputSize || 224, 0.4) : (fastStart ? await detectFast(tensor) : await detectFull(tensor));
      const main = [...faces].sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))[0];
      if (main) {
        if (!anchor) anchor = main.descriptor;
        const b = main.box;
        // Offset between the detector box centre and the landmark centre,
        // carried forward so a tracked crop sits where the detector's would.
        const dx = prev && main.tracked ? prev.dx : (b.x + b.width / 2) - main.lmBox.cx;
        const dy = prev && main.tracked ? prev.dy : (b.y + b.height / 2) - main.lmBox.cy;
        prev = { box: b, cx: main.lmBox.cx, cy: main.lmBox.cy, dx, dy };
      }
      results.push({ faces: faces.map(({ lmBox, eyes, ...f }) => ({ ...f, eyeContrast: eyeContrast(img, eyes) })) });
    } finally {
      tensor.dispose();
    }
  }
  return results;
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'warm') { await init(); parentPort.postMessage({ id: msg.id, ok: true }); return; }
    const results = await analyse(msg.images, msg.mode, msg.opts || {});
    parentPort.postMessage({ id: msg.id, results });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: String((err && err.message) || err) });
  }
});

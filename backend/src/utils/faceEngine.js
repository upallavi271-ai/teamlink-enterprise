// ---------------------------------------------------------------------------
// HRMS-24 §5 — LIVE FACE VERIFICATION FOR WEB / MOBILE CHECK-IN, on the server.
//
//   1. GET  /attendance/face/challenge  -> a signed, one-use, 2-minute token
//      naming a random liveness action (turn the head, or blink).
//   2. The browser opens the camera (a live stream only — there is no file
//      input anywhere in the flow) and captures a burst of frames while the
//      person performs the action.
//   3. POST /attendance/punches/verified with the token + frames. HERE, on
//      the server, every frame is decoded and run through face-api.js
//      (detection, 68 landmarks, 128-d descriptor) and compared with the
//      employee's registered Photo document. The browser's opinion is never
//      asked for; it only supplies pixels.
//
// Decision (decide(), pure and unit-tested):
//   * the registered photo must contain a face;
//   * every usable frame must contain exactly one face, and most frames must
//     contain one at all;
//   * IDENTITY: the median descriptor distance from the frames to the photo
//     must be <= threshold (HrConfig.faceMatchThreshold, default 0.45), and
//     the frames must all be the same person as each other;
//   * LIVENESS: across the burst the head must visibly turn (yaw range) or the
//     eyes must visibly close and reopen (eye-aspect-ratio dip), per the
//     challenge; identical frames (a still picture held up) fail.
//
// HONEST LIMITS: this is a mid-sized open-source model (dlib-style ResNet
// descriptors, ~99% on the LFW benchmark) with a heuristic liveness check. It
// raises the bar well above "a camera was on", but it is not certified
// anti-spoofing: a good video of the employee performing the same action, or
// a close relative, can still pass; poor light, a very turned or tilted
// registered photo, or a low-quality webcam raise the false-reject rate.
// ---------------------------------------------------------------------------

const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const ACTIONS = {
  turn: {
    prompt: 'Look at the camera, then slowly turn your head to one side and back.',
    frames: 8, intervalMs: 300,
  },
  blink: {
    prompt: 'Look at the camera and blink slowly two or three times.',
    frames: 10, intervalMs: 150,
  },
};
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MIN_FRAMES = 6;
const MAX_FRAMES = 16;
const FRAME_MAX_WIDTH = 640;

// Liveness thresholds (see decide()).
const TURN_MIN_YAW_RANGE = 0.1;
const BLINK_MAX_RATIO = 0.75;
const BLINK_MIN_OPEN_EAR = 0.18;
const STATIC_MAX_DIFF = 1.5; // mean absolute grey-level difference, 0..255

// --- the worker -------------------------------------------------------------

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'faceWorker.js'));
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
  });
  const fail = (err) => {
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(err instanceof Error ? err : new Error('Face engine stopped')); });
    pending.clear();
    worker = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code !== 0) fail(new Error(`Face engine exited (${code})`)); else worker = null; });
  // The engine is only needed at check-in; it must not keep the API alive.
  worker.unref();
  return worker;
}

function call(message, timeoutMs = 90000) {
  const w = getWorker();
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Face engine timed out')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const transfer = (message.images || []).map((i) => i.data.buffer);
    w.postMessage({ ...message, id }, transfer);
  });
}

// --- images -------------------------------------------------------------

// Any JPEG / PNG / WebP -> RGB pixels, EXIF-rotated, at most maxWidth wide.
async function decode(buffer, maxWidth = FRAME_MAX_WIDTH) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.length);
  return { data: new Int32Array(rgb), width: info.width, height: info.height, grey: greyThumb(rgb, info.width, info.height) };
}

// A 32x24 grey thumbnail, for the "is this the same still picture?" check.
function greyThumb(rgb, w, h) {
  const tw = 32; const th = 24; const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      const sx = Math.floor((x * w) / tw); const sy = Math.floor((y * h) / th);
      const i = (sy * w + sx) * 3;
      out[y * tw + x] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
    }
  }
  return out;
}
function thumbDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0; for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// --- the registered photo, cached by stored file name ---------------------

const photoCache = new Map();
async function analysePhoto(photoKey, buffer) {
  if (photoKey && photoCache.has(photoKey)) return photoCache.get(photoKey);
  const img = await decode(buffer, 800);
  const { results } = await call({ mode: 'single', images: [{ data: img.data, width: img.width, height: img.height }] });
  const faces = results[0].faces;
  if (photoKey) {
    if (photoCache.size > 300) photoCache.delete(photoCache.keys().next().value);
    photoCache.set(photoKey, faces);
  }
  return faces;
}

async function analyseFrames(frameBuffers) {
  const imgs = [];
  for (const b of frameBuffers) imgs.push(await decode(b));
  const { results } = await call({
    mode: 'burst',
    images: imgs.map((i) => ({ data: i.data, width: i.width, height: i.height })),
  });
  const diffs = [];
  for (let i = 1; i < imgs.length; i += 1) diffs.push(thumbDiff(imgs[i - 1].grey, imgs[i].grey));
  return { results, diffs };
}

// --- the decision (pure) ----------------------------------------------------

function euclid(a, b) {
  let s = 0; for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const largest = (faces) => [...faces].sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))[0];

// photoFaces: faces found in the registered photo. frames: [{ faces }].
// diffs: consecutive-frame thumbnail differences. Returns
// { ok, reason, code, score, distance, liveness, ... }.
function decide({ photoFaces, frames, diffs = [], action, threshold = 0.45 }) {
  const out = { ok: false, action, threshold };
  if (!photoFaces || !photoFaces.length) return { ...out, code: 'NO_FACE_IN_PHOTO', reason: 'No face could be found in the registered photo.' };
  const ref = largest(photoFaces);
  if (!ref.descriptor) return { ...out, code: 'NO_FACE_IN_PHOTO', reason: 'The registered photo could not be read.' };

  // A second SUBSTANTIAL face (at least a quarter the area of the main one)
  // anywhere in the burst refuses the check-in; a tiny face far behind does not.
  const area = (b) => b.width * b.height;
  const multi = frames.some((f) => {
    if (f.faces.length < 2) return false;
    const big = area(largest(f.faces).box);
    return f.faces.filter((x) => area(x.box) >= big * 0.25).length > 1;
  });
  if (multi) return { ...out, code: 'MULTIPLE_FACES', reason: 'More than one face was in the camera. Only you should be in the frame.' };
  const withFace = frames.map((f, i) => (f.faces.length ? { ...largest(f.faces), index: i } : null)).filter((f) => f && f.descriptor);
  out.framesWithFace = withFace.length;
  out.frames = frames.length;
  if (withFace.length < Math.max(MIN_FRAMES - 2, Math.ceil(frames.length * 0.6))) {
    return { ...out, code: 'NO_FACE', reason: 'Your face was not clearly visible in the camera. Face the camera in good light.' };
  }

  // Identity: every frame against the photo, and every frame against the first.
  const distances = withFace.map((f) => euclid(f.descriptor, ref.descriptor));
  const distance = median(distances);
  const closeShare = distances.filter((d) => d <= threshold + 0.05).length / distances.length;
  out.distance = Number(distance.toFixed(4));
  out.score = Number(Math.max(0, 1 - distance).toFixed(4));
  out.closeShare = Number(closeShare.toFixed(2));
  const anchor = withFace[0].descriptor;
  const selfSpread = Math.max(...withFace.map((f) => euclid(f.descriptor, anchor)));
  out.selfSpread = Number(selfSpread.toFixed(4));

  // Liveness.
  const still = diffs.length > 0 && Math.max(...diffs) < STATIC_MAX_DIFF;
  const yaws = withFace.map((f) => f.yaw);
  const ears = withFace.map((f) => f.ear);
  const yawRange = Math.max(...yaws) - Math.min(...yaws);
  const yawMid = median(yaws);
  const earOpen = median(ears);
  const earMin = Math.min(...ears);
  // A BLINK is a frame whose eyes are clearly more closed than usual, with the
  // head roughly where it usually is (turning the head also narrows the eye
  // outline, which must not count), and open eyes both before AND after it.
  const blinkAt = withFace.findIndex((f, k) => k > 0 && k < withFace.length - 1
    && f.ear <= earOpen * BLINK_MAX_RATIO
    && Math.abs(f.yaw - yawMid) <= 0.06
    && Math.max(...ears.slice(0, k)) >= earOpen * 0.9
    && Math.max(...ears.slice(k + 1)) >= earOpen * 0.9);
  out.liveness = {
    action, still, yawRange: Number(yawRange.toFixed(4)), earOpen: Number(earOpen.toFixed(4)), earMin: Number(earMin.toFixed(4)),
    blinkFrame: blinkAt >= 0 ? withFace[blinkAt].index : null,
    maxFrameDiff: diffs.length ? Number(Math.max(...diffs).toFixed(2)) : null,
  };
  let live = false;
  if (!still) {
    if (action === 'turn') live = yawRange >= TURN_MIN_YAW_RANGE;
    else if (action === 'blink') live = earOpen >= BLINK_MIN_OPEN_EAR && blinkAt >= 0;
  }
  out.liveness.passed = live;

  if (selfSpread > 0.7) return { ...out, code: 'INCONSISTENT', reason: 'The camera frames did not all show the same person.' };
  if (distance > threshold || closeShare < 0.5) return { ...out, code: 'NO_MATCH', reason: 'The face does not match the registered photo.' };
  if (!live) {
    return {
      ...out,
      code: 'LIVENESS',
      reason: action === 'blink' ? 'No blink was seen. Blink slowly while the camera is capturing.' : 'No head turn was seen. Turn your head slowly to one side and back while the camera is capturing.',
    };
  }
  return { ...out, ok: true, code: 'VERIFIED', bestFrame: withFace[distances.indexOf(Math.min(...distances))].index };
}

// --- signed challenges ------------------------------------------------------

const used = new Map(); // nonce -> expiry
function secret() { return `${process.env.JWT_SECRET || 'teamlink'}|face-challenge`; }
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('base64url'); }

function issueChallenge(userId, direction) {
  const keys = Object.keys(ACTIONS);
  const action = keys[crypto.randomInt(keys.length)];
  const exp = Date.now() + CHALLENGE_TTL_MS;
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ u: userId, a: action, d: direction, n: nonce, e: exp })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, action, direction, expiresAt: new Date(exp).toISOString(), ...ACTIONS[action] };
}

// Returns { action, direction } or { error }. One use only.
function consumeChallenge(token, userId) {
  const [payload, mac] = String(token || '').split('.');
  if (!payload || !mac) return { error: 'The check-in session is missing. Start again.' };
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return { error: 'The check-in session is not valid. Start again.' };
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { error: 'The check-in session is not valid. Start again.' }; }
  if (body.u !== userId) return { error: 'The check-in session belongs to another login.' };
  if (!(body.e > Date.now())) return { error: 'The check-in session expired. Start again.' };
  const now = Date.now();
  used.forEach((exp, n) => { if (exp < now) used.delete(n); });
  if (used.has(body.n)) return { error: 'This check-in session was already used. Start again.' };
  used.set(body.n, body.e);
  return { action: body.a, direction: body.d };
}

async function warm() { await call({ type: 'warm' }); }

module.exports = {
  ACTIONS, MIN_FRAMES, MAX_FRAMES, TURN_MIN_YAW_RANGE, BLINK_MAX_RATIO,
  decode, analysePhoto, analyseFrames, decide, euclid,
  issueChallenge, consumeChallenge, warm,
};

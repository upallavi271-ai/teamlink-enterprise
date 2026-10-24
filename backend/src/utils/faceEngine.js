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
    prompt: 'Look at the camera, then slowly turn your head a little to one side and back.',
    frames: 10, intervalMs: 250,
  },
  // A blink lasts about a tenth of a second, so the pictures come every 100 ms (16 of them, about 1.6 s) - at 150 ms the closed eye fell between two pictures.
  blink: {
    prompt: 'Look straight at the camera and blink slowly 2 or 3 times. Keep your head still.',
    frames: 16, intervalMs: 100,
  },
};
// Easy / Record-anyway check-in: no liveness challenge, just look at the camera (3 small pictures, about half a second).
const LOOK = { prompt: 'Look at the camera.', frames: 3, intervalMs: 200 };
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MIN_FRAMES = 6;
const MAX_FRAMES = 16;
const FRAME_MAX_WIDTH = 720; // the eyes are small: more pixels on them is what makes a blink readable

// Liveness thresholds (see decide()).
const TURN_MIN_YAW_RANGE = 0.1;
const BLINK_MAX_RATIO = 0.82; // the eye-aspect-ratio of a closing eye, against the open level (the 75th percentile of the burst)
const BLINK_MIN_DROP = 0.025; // ... and it must really drop by this much (not landmark jitter)
const BLINK_MIN_OPEN_EAR = 0.15;
const BLINK_CONTRAST_RATIO = 0.78; // the grey spread inside the eyes of a closing eye, against the open level
const BLINK_YAW_TOL = 0.1; // the head may drift this much while blinking (turning it narrows the eye outline too)
const BLINK_TURN_ALSO = 1.3; // on a blink challenge a clear head turn (this many times the minimum) also proves a live person
const STATIC_MAX_DIFF = 0.6; // mean absolute grey-level difference, 0..255: only practically IDENTICAL pictures
const STATIC_MAX_LM = 0.004; // ... AND landmarks that do not move at all (a live face always jitters a little)

// --- the worker -------------------------------------------------------------

// A small POOL (default 2 workers on a machine with 3+ cores and enough free
// memory; FACE_WORKERS=1..3 overrides): a burst is split between them, which
// roughly halves the wait. The second worker is only started when the first
// is busy and memory allows, so a small server keeps working with one.
const workers = [];
let seq = 0;
const pending = new Map();

function poolSize() {
  const env = Number(process.env.FACE_WORKERS);
  if (env >= 1 && env <= 3) return Math.floor(env);
  const os = require('os');
  return os.cpus().length >= 3 && os.totalmem() >= 3.5e9 ? 2 : 1;
}

function getWorker(slot = 0) {
  if (workers[slot]) return workers[slot];
  const worker = new Worker(path.join(__dirname, 'faceWorker.js'));
  workers[slot] = worker;
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
  });
  const fail = (err) => {
    pending.forEach((p) => { if (p.worker === worker) { clearTimeout(p.timer); p.reject(err instanceof Error ? err : new Error('Face engine stopped')); pending.delete(p.id); } });
    if (workers[slot] === worker) workers[slot] = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code !== 0) fail(new Error(`Face engine exited (${code})`)); else if (workers[slot] === worker) workers[slot] = null; });
  // The engine is only needed at check-in; it must not keep the API alive.
  worker.unref();
  return worker;
}

function call(message, timeoutMs = 90000, slot = 0) {
  const w = getWorker(slot);
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Face engine timed out')); }, timeoutMs);
    pending.set(id, { id, worker: w, resolve, reject, timer });
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
  const plain = imgs.map((i) => ({ data: i.data, width: i.width, height: i.height }));
  // Split the burst between the workers (each gets a run of consecutive
  // frames, which is what the frame-to-frame tracking needs). The very first
  // frame and the very last frame of the whole burst always get the full
  // detector, as before, so a second face is still looked for at both ends.
  const slots = Math.min(poolSize(), Math.floor(plain.length / 4)) || 1;
  const per = Math.ceil(plain.length / slots);
  const jobs = [];
  for (let s = 0; s < slots; s += 1) {
    const part = plain.slice(s * per, (s + 1) * per);
    if (!part.length) continue;
    jobs.push(call({
      mode: 'burst', images: part,
      opts: { fastFirst: s > 0, lastFull: (s + 1) * per >= plain.length },
    }, 90000, s).then((r) => r.results));
  }
  const results = (await Promise.all(jobs)).flat();
  const diffs = [];
  for (let i = 1; i < imgs.length; i += 1) diffs.push(thumbDiff(imgs[i - 1].grey, imgs[i].grey));
  return { results, diffs };
}

// --- the FAST path (check-in with the easy / record-anyway modes) --------------
// One small frame at a time (320 px wide, tiny detector at 224 px), stopping at the FIRST frame whose face is
// within the threshold; at most `maxFrames`, and nothing starts after `deadlineAt`. No liveness challenge.
// Returns { faces: [best face or null], best: distance|null, tried, timedOut, multiple }.
async function analyseQuick(photoFace, frameBuffers, { threshold = 0.7, maxFrames = 3, deadlineAt = Date.now() + 3500 } = {}) {
  let best = null; let bestIdx = -1; let tried = 0; let timedOut = false; let multiple = false; let sawFace = false;
  for (let i = 0; i < Math.min(frameBuffers.length, maxFrames); i += 1) {
    if (Date.now() > deadlineAt) { timedOut = true; break; }
    const img = await decode(frameBuffers[i], 320);
    const { results } = await call({ mode: 'single', images: [{ data: img.data, width: img.width, height: img.height }], opts: { quick: true, inputSize: 224 } });
    tried += 1;
    const faces = results[0].faces || [];
    if (!faces.length) continue;
    sawFace = true;
    if (faces.length > 1) multiple = multiple || faces.filter((x) => x.box.width * x.box.height >= largest(faces).box.width * largest(faces).box.height * 0.25).length > 1;
    const d = euclid(largest(faces).descriptor, photoFace.descriptor);
    if (best == null || d < best) { best = d; bestIdx = i; }
    if (d <= threshold) break;
  }
  return { best: best == null ? null : Number(best.toFixed(4)), bestIdx, tried, timedOut, sawFace, multiple };
}

// Seed the in-memory reference cache from the stored one (faceRef.js) so the photo is not analysed again.
function seedPhoto(photoKey, faces) { if (photoKey && faces && !photoCache.has(photoKey)) photoCache.set(photoKey, faces); }

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
  const yaws = withFace.map((f) => f.yaw);
  const ears = withFace.map((f) => f.ear);
  const yawRange = Math.max(...yaws) - Math.min(...yaws);
  const earRange = Math.max(...ears) - Math.min(...ears);
  const yawMid = median(yaws);
  // "Still" = the pictures are practically identical AND the landmarks do not move: a photo held up. A real face blinking changes only a few
  // eye pixels, which a coarse thumbnail average can hide, so the thumbnails alone must never call a live face "still".
  const still = diffs.length > 0 && Math.max(...diffs) < STATIC_MAX_DIFF && yawRange < STATIC_MAX_LM && earRange < 0.01;
  const pct = (xs, p) => { const q = [...xs].sort((x, y) => x - y); return q[Math.min(q.length - 1, Math.floor(p * (q.length - 1) + 0.5))]; };
  const earOpen = pct(ears, 0.75); // the eyes-open level (a slow blinker spends many frames closed, so the median would be too low)
  const earMin = Math.min(...ears);
  const contrasts = withFace.map((f) => (Number.isFinite(f.eyeContrast) ? f.eyeContrast : null));
  const haveContrast = contrasts.filter((c) => c != null).length >= Math.ceil(withFace.length * 0.8);
  const cOpen = haveContrast ? pct(contrasts.filter((c) => c != null), 0.75) : null;
  const openBefore = (arr, k, base, share) => Math.max(...arr.slice(0, k).filter((v) => v != null)) >= base * share;
  const openAfter = (arr, k, base, share) => Math.max(...arr.slice(k + 1).filter((v) => v != null)) >= base * share;
  // A BLINK: a frame (not the first or last) whose eyes are clearly more closed than the open level - by the eye-aspect-ratio OR by the loss of
  // contrast in the eyes - with the head about where it was, and open eyes both before AND after it. Two shallow frames in a row also count
  // (the camera caught the lid half way down twice).
  const dipEar = (k) => ears[k] <= earOpen * BLINK_MAX_RATIO && earOpen - ears[k] >= BLINK_MIN_DROP;
  const dipEarSoft = (k) => ears[k] <= earOpen * 0.9 && earOpen - ears[k] >= 0.018;
  const dipCon = (k) => haveContrast && contrasts[k] != null && contrasts[k] <= cOpen * BLINK_CONTRAST_RATIO;
  const still0 = (k) => Math.abs(yaws[k] - yawMid) <= BLINK_YAW_TOL;
  const openAround = (k) => (
    (openBefore(ears, k, earOpen, 0.92) && openAfter(ears, k, earOpen, 0.92))
    || (haveContrast && openBefore(contrasts, k, cOpen, 0.9) && openAfter(contrasts, k, cOpen, 0.9)));
  let blinkAt = -1;
  for (let k = 1; k < withFace.length - 1 && blinkAt < 0; k += 1) {
    if (!still0(k) || !openAround(k)) continue; // eslint-disable-line no-continue
    if (dipEar(k) || dipCon(k) || (dipEarSoft(k) && k + 1 < withFace.length - 1 && dipEarSoft(k + 1))) blinkAt = k;
  }
  const blinkOk = earOpen >= BLINK_MIN_OPEN_EAR && blinkAt >= 0;
  const turnOk = yawRange >= TURN_MIN_YAW_RANGE;
  out.liveness = {
    action, still, yawRange: Number(yawRange.toFixed(4)), earOpen: Number(earOpen.toFixed(4)), earMin: Number(earMin.toFixed(4)),
    contrastOpen: cOpen == null ? null : Number(cOpen.toFixed(2)),
    blinkFrame: blinkAt >= 0 ? withFace[blinkAt].index : null,
    maxFrameDiff: diffs.length ? Number(Math.max(...diffs).toFixed(2)) : null,
  };
  // EITHER move proves a live person (a photo shaken at the camera is judged exactly as before): on a turn challenge a blink is enough, and on a
  // blink challenge a clear head movement is enough - so a person who did the other move, or both, is not refused for it.
  let live = false;
  if (!still) {
    if (action === 'turn') live = turnOk || blinkOk;
    else if (action === 'blink') live = blinkOk || yawRange >= TURN_MIN_YAW_RANGE * BLINK_TURN_ALSO;
    else live = turnOk || blinkOk;
  }
  out.liveness.how = !live ? null : (blinkOk && !(action === 'turn' && turnOk)) ? 'blink' : 'turn';
  out.liveness.passed = live;

  if (selfSpread > 0.7) return { ...out, code: 'INCONSISTENT', reason: 'The camera frames did not all show the same person.' };
  if (distance > threshold || closeShare < 0.5) return { ...out, code: 'NO_MATCH', reason: 'The face does not match the registered photo.' };
  if (!live) {
    return {
      ...out,
      code: 'LIVENESS',
      reason: action === 'blink'
        ? 'No blink was seen. Look straight at the camera and blink slowly 2 or 3 times while it captures, with your eyes and forehead in good light (no glare on glasses).'
        : 'No head turn was seen. Turn your head a little to one side and back, slowly, while it captures.',
    };
  }
  return { ...out, ok: true, code: 'VERIFIED', bestFrame: withFace[distances.indexOf(Math.min(...distances))].index };
}

// --- signed challenges ------------------------------------------------------

const used = new Map(); // nonce -> expiry
function secret() { return `${process.env.JWT_SECRET || 'teamlink'}|face-challenge`; }
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('base64url'); }

function issueChallenge(userId, direction, forced) {
  const keys = Object.keys(ACTIONS);
  const action = forced === 'look' ? 'look' : keys[crypto.randomInt(keys.length)];
  const exp = Date.now() + CHALLENGE_TTL_MS;
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ u: userId, a: action, d: direction, n: nonce, e: exp })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, action, direction, expiresAt: new Date(exp).toISOString(), ...(action === 'look' ? LOOK : ACTIONS[action]) };
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

async function warm() {
  const n = poolSize();
  const all = [];
  for (let s = 0; s < n; s += 1) all.push(call({ type: 'warm' }, 90000, s));
  await Promise.all(all);
}

module.exports = {
  ACTIONS, MIN_FRAMES, MAX_FRAMES, TURN_MIN_YAW_RANGE, BLINK_MAX_RATIO, BLINK_CONTRAST_RATIO,
  decode, analysePhoto, analyseFrames, analyseQuick, seedPhoto, decide, euclid, poolSize,
  issueChallenge, consumeChallenge, warm,
};

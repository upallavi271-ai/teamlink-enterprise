'use strict';
// ---------------------------------------------------------------------------
// Web check-in settings that Admin can change in plain words (AppSetting
// "attendance.checkin", no schema change) and the PURE face decision.
//
//   Face check:  strict  - the face must match (distance <= the strict number, 0.45
//                          by default); only a face that was seen and does NOT match
//                          is refused. Everything technical (no face found, no photo,
//                          camera off, timeout, engine down) is recorded as "Face not checked".
//                easy    - a weak match is fine (distance <= 0.70). A face that is clearly
//                          somebody else (distance >= 0.85) is refused; every other
//                          problem is recorded and flagged for HR.
//                record  - (DEFAULT, the founder's request) never refuse because of the face:
//                          a weak match counts as matched (<= 0.70), anything else is
//                          recorded at once and flagged "Face not matched / not checked".
//   A failed face check never causes LOP / late: it only flags the punch for HR.
// ---------------------------------------------------------------------------

const prisma = require('../db');

const KEY = 'attendance.checkin';
const MODES = ['required', 'strict', 'easy', 'record'];
const EASY_THRESHOLD = 0.7;
const EASY_REFUSE_AT = 0.85;
const DEFAULTS = {
  faceMode: 'required', // founder, 2026-10-22: no check-in unless the live face is the profile photo's face
  accuracyCounts: true, // allow for the phone's GPS accuracy
  accuracyCapM: 300, // the most GPS accuracy ever allowed for (was a fixed 100 m)
  noLocation: 'block', // block | record : a punch with no location at all
  selfieRetentionDays: 30,
  analysisMs: 3500, // the face check may take this long before the punch is recorded as "not checked yet"
  // QUICK BY DEFAULT (founder, 2026-10-23: "check-in and check-out must be quick, like the old version"): look at the camera, 3 small pictures, compared with the
  // profile photo (about a second). The blink / head-turn challenge (16 pictures, a few seconds) is OFF unless an Admin switches it on.
  livenessCheck: false,
};

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function clean(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    faceMode: MODES.includes(r.faceMode) ? r.faceMode : DEFAULTS.faceMode,
    accuracyCounts: r.accuracyCounts === undefined ? DEFAULTS.accuracyCounts : !!r.accuracyCounts,
    accuracyCapM: Math.round(clamp(r.accuracyCapM, 0, 2000, DEFAULTS.accuracyCapM)),
    noLocation: r.noLocation === 'record' ? 'record' : 'block',
    selfieRetentionDays: Math.round(clamp(r.selfieRetentionDays, 1, 3650, DEFAULTS.selfieRetentionDays)),
    analysisMs: Math.round(clamp(r.analysisMs, 1000, 20000, DEFAULTS.analysisMs)),
    livenessCheck: r.livenessCheck === undefined ? DEFAULTS.livenessCheck : !!r.livenessCheck,
  };
}

let cache = { at: 0, value: null };
async function load() {
  if (cache.value && Date.now() - cache.at < 10000) return cache.value;
  let raw = null;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    raw = row ? JSON.parse(row.value) : null;
  } catch { raw = null; }
  cache = { at: Date.now(), value: clean(raw) };
  return cache.value;
}

async function save(patch, userId) {
  const next = clean({ ...(await load()), ...(patch || {}) });
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedById: userId || null }, update: { value, updatedById: userId || null } });
  cache = { at: Date.now(), value: next };
  return next;
}
const resetCache = () => { cache = { at: 0, value: null }; };

// The distance a face must be within to count as matched (face-api: 0 = same picture, ~0.6 = usual limit).
const thresholdFor = (mode, strictThreshold = 0.45) => (mode === 'strict' || mode === 'required' ? Number(strictThreshold) || 0.45 : EASY_THRESHOLD);

const REASON = {
  NO_MATCH: 'The face did not match the profile photo.',
  MULTIPLE_FACES: 'More than one face was in the picture.',
  INCONSISTENT: 'The pictures did not show the same person.',
  NO_FACE: 'No face was found in the camera picture.',
  LIVENESS: 'We could not see a blink or a head turn. Blink slowly 2 or 3 times, or turn your head a little to one side and back, while it captures.',
  NO_FACE_IN_PHOTO: 'No face could be found in the profile photo.',
  NO_PHOTO: 'There is no profile photo to compare with. Ask HR to add your photo to your profile.',
  NO_CAMERA: 'The camera was not available.',
  TIMEOUT: 'The face check took too long.',
  ENGINE: 'The face check was not available.',
};
const TECHNICAL = ['NO_FACE', 'NO_FACE_IN_PHOTO', 'NO_PHOTO', 'NO_CAMERA', 'TIMEOUT', 'ENGINE'];

// outcome: { code, distance } where distance is the best face distance found (null when no face was compared).
// Returns { record, status, reason, matched }.
function faceVerdict({ mode = 'required', code, distance = null, strictThreshold = 0.45 }) {
  const m = MODES.includes(mode) ? mode : 'required';
  const threshold = thresholdFor(m, strictThreshold);
  const hasDistance = distance != null && Number.isFinite(Number(distance));
  // REQUIRED: only a face that was seen AND matches the profile photo is accepted. No photo, no face, a wrong face, a still picture, the camera off,
  // a timeout: every one is refused with its plain reason, nothing is recorded as present.
  if (m === 'required') {
    if (hasDistance && Number(distance) <= threshold && !TECHNICAL.includes(code) && code === 'VERIFIED') return { record: true, matched: true, status: 'Verified', reason: '', threshold };
    return { record: false, matched: false, status: code === 'NO_MATCH' || code === 'INCONSISTENT' || code === 'MULTIPLE_FACES' ? 'Face not matched' : 'Face not checked', reason: REASON[code] || REASON.ENGINE, threshold };
  }
  // STRICT also needs the live move: a face that matches but showed no blink / head turn is refused (it used to pass on the distance alone).
  if (m === 'strict' && code === 'LIVENESS') return { record: false, matched: false, status: 'Face not checked', reason: REASON.LIVENESS, threshold };
  if (hasDistance && Number(distance) <= threshold && !TECHNICAL.includes(code)) {
    return { record: true, matched: true, status: 'Verified', reason: '', threshold };
  }
  if (TECHNICAL.includes(code) || (!hasDistance && !['MULTIPLE_FACES', 'INCONSISTENT', 'NO_MATCH'].includes(code))) {
    return { record: true, matched: false, status: 'Face not checked', reason: REASON[code] || REASON.ENGINE, threshold };
  }
  // A face WAS seen and it is not (close enough to) the profile photo.
  const d = hasDistance ? Number(distance) : null;
  const refuse = (m === 'strict' && code === 'NO_MATCH') || (m === 'easy' && code === 'NO_MATCH' && d != null && d >= EASY_REFUSE_AT);
  return { record: !refuse, matched: false, status: 'Face not matched', reason: REASON[code] || REASON.NO_MATCH, threshold };
}

// What a missing / invalid location does, per the setting.
function locationRule({ valid, setting }) {
  if (valid) return { record: true, status: null };
  return setting === 'record' ? { record: true, status: 'Location not captured' } : { record: false, status: null };
}

module.exports = { MODES, DEFAULTS, EASY_THRESHOLD, EASY_REFUSE_AT, REASON, load, save, clean, resetCache, thresholdFor, faceVerdict, locationRule };

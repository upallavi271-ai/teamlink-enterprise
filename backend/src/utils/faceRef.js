'use strict';
// ---------------------------------------------------------------------------
// The reference face of each employee (computed ONCE from the profile photo, then
// kept): AppSetting "face.ref.<employeeId>" = { key, face }, key = "<photoId>:<file>".
// A new profile photo has a new key, so the old reference is ignored and replaced the
// next time (invalidated by itself). Biometric-like data: only the server reads it,
// no route returns it. The profile photo is the source; a changed photo replaces it.
// ---------------------------------------------------------------------------

const prisma = require('../db');

const keyOf = (employeeId) => `face.ref.${employeeId}`;
const photoKey = (photo) => `${photo.id}:${photo.file}`;

// Pure: is the stored reference still for this photo?
const isCurrent = (stored, key) => !!(stored && stored.key === key && stored.face && Array.isArray(stored.face.descriptor) && stored.face.descriptor.length === 128);

async function get(employeeId, key) {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: keyOf(employeeId) } });
    const stored = row ? JSON.parse(row.value) : null;
    return isCurrent(stored, key) ? stored.face : null;
  } catch { return null; }
}

async function put(employeeId, key, face) {
  if (!face || !Array.isArray(face.descriptor) || face.descriptor.length !== 128) return;
  const value = JSON.stringify({ key, face: { score: face.score, box: face.box, descriptor: face.descriptor } });
  try {
    await prisma.appSetting.upsert({ where: { key: keyOf(employeeId) }, create: { key: keyOf(employeeId), value }, update: { value } });
  } catch { /* the cache is an optimisation only */ }
}

module.exports = { keyOf, photoKey, isCurrent, get, put };

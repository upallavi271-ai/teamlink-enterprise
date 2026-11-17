// ---------------------------------------------------------------------------
// SCREENSHOTS (founder 2026-11-17): a clear (not blurred) picture of the whole screen about every 10 minutes, taken by the agent
// ONLY while the person is clocked in / recording and the PC is in use (not idle, not locked, not on lunch / break / pause, and
// not before the notice is accepted). The picture is uploaded straight away and NEVER kept on the PC.
//
// Here on the server:
//   * the bytes live on disk under the upload dir (utils/attachments.js uploadDir() + '/monitoring-shots/<employeeId>/<day>/<id>.jpg'),
//     never in the database. A small raw table "MonitoringScreenshot" (self-provisioned, CREATE TABLE IF NOT EXISTS) holds id,
//     deviceId, employeeId, day, takenAt, file, bytes, appName and title at that moment.
//   * only Super Admin, Admin and HR may list or open a screenshot (routes/monitoring.js checks the role; every open is in the read
//     log, utils/readLog.js). Images are served through an authenticated route with Cache-Control: private, no-store.
//   * a daily cleanup deletes files + rows older than the retention (default 30 days), in batches so the DB is never locked for long.
//
// Settings (company-wide, kept in AppSetting so no schema change is needed, like the weekly breaks):
//   monitoring.screenshots = { enabled, intervalMinutes, retentionDays }   default { true, 10, 30 }
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const { uploadDir } = require('./attachments');

const IST = 330 * 60000;
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const MAX_BYTES = 2 * 1024 * 1024; // a 10-minute JPEG is well under 300 KB; 2 MB is a generous hard cap
const STORED = /^[A-Za-z0-9_-]{6,}\/\d{4}-\d{2}-\d{2}\/shot[a-f0-9]{8,}\.jpg$/; // <employeeId>/<day>/<id>.jpg (employeeId is a cuid)

// --- the table -------------------------------------------------------------
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringScreenshot" (
        "id" TEXT PRIMARY KEY, "deviceId" TEXT, "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "takenAt" TEXT NOT NULL,
        "file" TEXT NOT NULL, "bytes" INTEGER NOT NULL DEFAULT 0, "appName" TEXT, "title" TEXT, "createdAt" TEXT NOT NULL)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MonitoringScreenshot_emp" ON "MonitoringScreenshot" ("employeeId","day","takenAt")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MonitoringScreenshot_taken" ON "MonitoringScreenshot" ("takenAt")');
      return true;
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// --- settings --------------------------------------------------------------
const SHOTS_KEY = 'monitoring.screenshots';
const DEFAULT_SHOTS = { enabled: true, intervalMinutes: 10, retentionDays: 30 };
function cleanShotSettings(v) {
  const o = v && typeof v === 'object' ? v : {};
  const n = (x, lo, hi, d) => { const k = Math.round(Number(x)); return Number.isFinite(k) && k >= lo && k <= hi ? k : d; };
  return {
    enabled: o.enabled !== false, // founder: ON by default
    intervalMinutes: n(o.intervalMinutes, 1, 120, 10),
    retentionDays: n(o.retentionDays, 1, 365, 30),
  };
}
async function shotSettings() {
  try { const w = await prisma.appSetting.findUnique({ where: { key: SHOTS_KEY } }); if (w && w.value) return cleanShotSettings(JSON.parse(w.value)); } catch { /* the default */ }
  return { ...DEFAULT_SHOTS };
}
async function saveShotSettings(user, patch = {}) {
  const cur = await shotSettings();
  const next = cleanShotSettings({ ...cur, ...patch });
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: SHOTS_KEY },
    create: { key: SHOTS_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null },
  });
  return next;
}

// --- the folder on disk ----------------------------------------------------
function shotsDir() {
  const dir = path.join(uploadDir(), 'monitoring-shots');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}
function resolveFile(file) {
  if (!file || !STORED.test(String(file))) return null;
  const dir = shotsDir();
  const full = path.resolve(dir, file);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null; // stays inside the shots folder
  return full;
}
const isJpeg = (buf) => Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const clip = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null);

// --- save one upload -------------------------------------------------------
// device: the agent's device row; buf: the JPEG bytes; meta: { appName, title, takenAt }. Returns { id } or { error, status }.
async function saveScreenshot(device, buf, meta = {}) {
  if (!isJpeg(buf)) return { status: 400, error: 'A screenshot must be a JPEG image.' };
  if (buf.length > MAX_BYTES) return { status: 413, error: 'That screenshot is too large.' };
  await ensure();
  const takenMs = Date.parse(meta.takenAt);
  const takenAt = new Date(Number.isFinite(takenMs) && takenMs <= Date.now() + 5 * 60000 ? takenMs : Date.now());
  const day = istDay(takenAt);
  const id = `shot${crypto.randomBytes(12).toString('hex')}`;
  const rel = `${device.employeeId}/${day}/${id}.jpg`;
  const full = path.join(shotsDir(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf, { mode: 0o600 });
  await prisma.$executeRawUnsafe(
    'INSERT INTO "MonitoringScreenshot" ("id","deviceId","employeeId","day","takenAt","file","bytes","appName","title","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, device.id || null, device.employeeId, day, takenAt.toISOString(), rel, buf.length, clip(meta.appName, 80), clip(meta.title, 200), new Date().toISOString(),
  );
  return { id, bytes: buf.length };
}

// --- read ------------------------------------------------------------------
// The screenshots of one person on one day, newest-looking order by time. [{ id, takenAt, appName, title, bytes }]
async function listForDay(employeeId, day) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "id","takenAt","appName","title","bytes" FROM "MonitoringScreenshot" WHERE "employeeId" = ? AND "day" = ? ORDER BY "takenAt" ASC',
    String(employeeId), String(day),
  );
  return rows.map((r) => ({ id: r.id, takenAt: r.takenAt, appName: r.appName || null, title: r.title || null, bytes: Number(r.bytes) || 0 }));
}
// Which days this person has screenshots for, in a range, with a count each. [{ day, count }]
async function daysFor(employeeId, from, to) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "day", COUNT(*) AS n FROM "MonitoringScreenshot" WHERE "employeeId" = ? AND "day" >= ? AND "day" <= ? GROUP BY "day" ORDER BY "day" DESC',
    String(employeeId), String(from), String(to),
  );
  return rows.map((r) => ({ day: r.day, count: Number(r.n) || 0 }));
}
// One screenshot's row + its absolute path on disk, or null.
async function openOne(id) {
  await ensure();
  const [row] = await prisma.$queryRawUnsafe('SELECT * FROM "MonitoringScreenshot" WHERE "id" = ?', String(id || ''));
  if (!row) return null;
  const full = resolveFile(row.file);
  if (!full || !fs.existsSync(full)) return null;
  return { id: row.id, employeeId: row.employeeId, takenAt: row.takenAt, appName: row.appName || null, title: row.title || null, path: full };
}

// --- cleanup (batched, idempotent) -----------------------------------------
async function cleanupShots(retentionDays) {
  await ensure();
  const days = Math.max(1, Math.round(Number(retentionDays) || DEFAULT_SHOTS.retentionDays));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let removed = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe('SELECT "id","file" FROM "MonitoringScreenshot" WHERE "takenAt" < ? LIMIT 5000', cutoff);
    if (!rows.length) break;
    rows.forEach((r) => { const full = resolveFile(r.file); if (full) { try { fs.unlinkSync(full); } catch { /* already gone */ } } });
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(`DELETE FROM "MonitoringScreenshot" WHERE "id" IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
    removed += rows.length;
    if (rows.length < 5000) break;
  }
  return removed;
}

module.exports = {
  ensure, shotSettings, saveShotSettings, DEFAULT_SHOTS, SHOTS_KEY,
  saveScreenshot, listForDay, daysFor, openOne, cleanupShots, shotsDir, MAX_BYTES,
};

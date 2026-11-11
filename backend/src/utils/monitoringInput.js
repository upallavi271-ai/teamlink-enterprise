// ---------------------------------------------------------------------------
// THE SAME KEY OR BUTTON, OVER AND OVER (founder 2026-11-11: "employee monitoring lo, ekkuva sepu ey button use chesthunnaro kuda
// teliyali.... constant ga"; chose "catch fake activity").
// Agent 2.5 sends only the MINUTES in which nearly all the input was one thing again and again (backend/agent/TeamLinkMonitor.ps1,
// Check-Input):
//   key       one key is 85%+ of 30+ presses (a key held down / tapped again and again)  - key = that key's name ("Space")
//   click     one mouse button is 95%+ of 20+ clicks with hardly any typing (an auto-clicker)
//   mouse     only small moves inside a 40-pixel spot (a mouse mover / jiggler)
//   software  80%+ of the input came from a program, not a real keyboard / mouse (auto-clickers, mover apps, remote control)
// Nothing typed is ever sent. Here the minutes are kept (table MonitoringInputFlag, raw SQL like the CRM's) and joined into
// STRETCHES: the same kind and key, minute after minute (a gap of up to 2 minutes still counts as the same stretch). A stretch of
// MIN_STRETCH minutes or more is what HR and the team lead see. Kept as long as the activity records (retentionDays).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const KINDS = ['key', 'click', 'mouse', 'software'];
const MIN_STRETCH = 10; // minutes in a row before it is shown
const GAP_MIN = 2;
const IST = 330 * 60000;
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const hm = (ms) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringInputFlag" (
        "id" TEXT PRIMARY KEY, "employeeId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "day" TEXT NOT NULL, "minuteAt" TEXT NOT NULL,
        "kind" TEXT NOT NULL, "keyName" TEXT, "cnt" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL
      )`);
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "MonitoringInputFlag_one" ON "MonitoringInputFlag" ("deviceId", "minuteAt", "kind")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MonitoringInputFlag_day" ON "MonitoringInputFlag" ("day", "employeeId")');
      return true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

/** The agent's flagged minutes: [{ at, kind, key, count }] (at most 300 at a time; a minute already saved is not saved twice). */
async function save(device, minutes) {
  await ensure();
  const list = (Array.isArray(minutes) ? minutes : []).slice(0, 300);
  const now = Date.now();
  let saved = 0;
  for (const m of list) {
    const t = Date.parse(m && m.at);
    const kind = String(m && m.kind || '');
    if (!Number.isFinite(t) || !KINDS.includes(kind)) continue; // eslint-disable-line no-continue
    if (t > now + 5 * 60000 || t < now - 14 * 86400000) continue; // eslint-disable-line no-continue
    const minuteAt = new Date(Math.floor(t / 60000) * 60000).toISOString();
    const cnt = Math.max(0, Math.min(100000, Math.round(Number(m.count) || 0)));
    // eslint-disable-next-line no-await-in-loop
    const n = await prisma.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "MonitoringInputFlag" ("id","employeeId","deviceId","day","minuteAt","kind","keyName","cnt","createdAt") VALUES (?,?,?,?,?,?,?,?,?)',
      `mif${crypto.randomBytes(9).toString('hex')}`, device.employeeId, device.id, istDay(t), minuteAt, kind, clip(m.key, 60) || null, cnt, new Date().toISOString(),
    );
    saved += Number(n) || 0;
  }
  return { saved, skipped: list.length - saved };
}

const LABEL = {
  key: (k) => `"${k || 'One key'}" pressed again and again`,
  click: (k) => `${k || 'One mouse button'} again and again (like an auto-clicker)`,
  mouse: () => 'Mouse moving by itself in one small spot (like a mouse mover)',
  software: () => 'Keyboard / mouse input sent by a program, not by hand (auto-clicker, mover app or remote control)',
};

/** Stretches per employee for the days given: Map(employeeId -> [{ kind, key, label, from, to, fromTime, toTime, minutes, presses }]). */
async function stretches(employeeIds, fromDay, toDay = fromDay, { min = MIN_STRETCH } = {}) {
  await ensure();
  const ids = (employeeIds || []).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const rows = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    rows.push(...await prisma.$queryRawUnsafe(
      `SELECT "employeeId", "minuteAt", "kind", "keyName", "cnt" FROM "MonitoringInputFlag" WHERE "day" >= ? AND "day" <= ? AND "employeeId" IN (${part.map(() => '?').join(',')}) ORDER BY "employeeId", "kind", "keyName", "minuteAt"`,
      fromDay, toDay, ...part,
    ));
  }
  let cur = null;
  const close = () => {
    if (cur && cur.minutes >= min) {
      if (!out.has(cur.employeeId)) out.set(cur.employeeId, []);
      out.get(cur.employeeId).push({
        kind: cur.kind, key: cur.key, label: LABEL[cur.kind](cur.key), day: istDay(cur.fromMs),
        from: new Date(cur.fromMs).toISOString(), to: new Date(cur.toMs + 60000).toISOString(),
        fromTime: hm(cur.fromMs), toTime: hm(cur.toMs + 60000), minutes: cur.minutes, presses: cur.presses,
      });
    }
    cur = null;
  };
  rows.forEach((r) => {
    const ms = Date.parse(r.minuteAt);
    const same = cur && cur.employeeId === r.employeeId && cur.kind === r.kind && (cur.key || '') === (r.keyName || '') && ms - cur.toMs <= (GAP_MIN + 1) * 60000;
    if (!same) {
      close();
      cur = { employeeId: r.employeeId, kind: r.kind, key: r.keyName || '', fromMs: ms, toMs: ms, minutes: 0, presses: 0 };
    }
    cur.toMs = ms; cur.minutes += 1; cur.presses += Number(r.cnt) || 0;
  });
  close();
  out.forEach((list) => list.sort((a, b) => a.from.localeCompare(b.from)));
  return out;
}

/** One line per person for a list: total flagged minutes and the biggest stretch. */
function summaryOf(list) {
  if (!list || !list.length) return null;
  const minutes = list.reduce((n, s) => n + s.minutes, 0);
  const big = [...list].sort((a, b) => b.minutes - a.minutes)[0];
  return { minutes, stretches: list.length, top: `${big.label} · ${big.fromTime}–${big.toTime} (${big.minutes} min)` };
}

// ---------------------------------------------------------------------------
// HOW MANY TIMES EACH KEY / BUTTON (agent 2.6, founder 2026-11-11: "evaru ey buttons enni times press chesthunnaro teliyali").
// Per person per day: { 'Space': 1200, 'Enter': 300, 'Letter keys': 9000, 'Left click': 2500, ... }. Letter keys and number keys
// arrive as ONE count each (the agent groups them), so nothing typed can be rebuilt. Table MonitoringKeyCount, added to as it comes.
let readyCounts = null;
function ensureCounts() {
  if (!readyCounts) {
    readyCounts = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringKeyCount" (
        "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "keyName" TEXT NOT NULL, "cnt" INTEGER NOT NULL DEFAULT 0, "updatedAt" TEXT NOT NULL,
        PRIMARY KEY ("employeeId", "day", "keyName")
      )`);
      return true;
    })().catch((e) => { readyCounts = null; throw e; });
  }
  return readyCounts;
}
const KEY_NAME = /^[A-Za-z0-9 ()\-.]{1,40}$/;
async function addCounts(device, day, counts) {
  await ensureCounts();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { status: 400, error: 'Which day?' };
  const today = istDay(Date.now());
  if (day > today || day < istDay(Date.now() - 14 * 86400000)) return { saved: 0 };
  const now = new Date().toISOString();
  let saved = 0;
  for (const [k, v] of Object.entries(counts && typeof counts === 'object' ? counts : {}).slice(0, 80)) {
    const n = Math.round(Number(v));
    if (!KEY_NAME.test(k) || !(n > 0) || n > 200000) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      'INSERT INTO "MonitoringKeyCount" ("employeeId","day","keyName","cnt","updatedAt") VALUES (?,?,?,?,?) ON CONFLICT("employeeId","day","keyName") DO UPDATE SET "cnt" = "cnt" + excluded."cnt", "updatedAt" = excluded."updatedAt"',
      device.employeeId, day, k, n, now,
    );
    saved += 1;
  }
  return { saved };
}
// the grouped keys shown first, then the rest by count
const MOUSE = ['Left click', 'Right click', 'Middle click', 'Mouse wheel'];
/** Map(employeeId -> { keys: [{ name, count }], mouse: [{ name, count }], keyTotal, clickTotal }) for the days given. */
async function countsOf(employeeIds, fromDay, toDay = fromDay) {
  await ensureCounts();
  const ids = (employeeIds || []).filter(Boolean);
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "employeeId", "keyName", SUM("cnt") AS "n" FROM "MonitoringKeyCount" WHERE "day" >= ? AND "day" <= ? AND "employeeId" IN (${part.map(() => '?').join(',')}) GROUP BY "employeeId", "keyName"`,
      fromDay, toDay, ...part,
    );
    rows.forEach((r) => {
      if (!out.has(r.employeeId)) out.set(r.employeeId, { keys: [], mouse: [], keyTotal: 0, clickTotal: 0 });
      const o = out.get(r.employeeId);
      const n = Number(r.n) || 0;
      if (MOUSE.includes(r.keyName)) { o.mouse.push({ name: r.keyName, count: n }); if (r.keyName !== 'Mouse wheel') o.clickTotal += n; } else { o.keys.push({ name: r.keyName, count: n }); o.keyTotal += n; }
    });
  }
  out.forEach((o) => { o.keys.sort((a, b) => b.count - a.count); o.mouse.sort((a, b) => MOUSE.indexOf(a.name) - MOUSE.indexOf(b.name)); });
  return out;
}

async function cleanup(retentionDays) {
  await ensure();
  await ensureCounts();
  const cutoff = istDay(Date.now() - Math.max(7, Number(retentionDays) || 90) * 86400000);
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringInputFlag" WHERE "day" < ?', cutoff);
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringKeyCount" WHERE "day" < ?', cutoff);
}

module.exports = { ensure, save, stretches, summaryOf, cleanup, addCounts, countsOf, MIN_STRETCH, KINDS };

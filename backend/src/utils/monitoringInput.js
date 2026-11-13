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
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringMisuseNote" (
        "id" TEXT PRIMARY KEY, "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "fromAt" TEXT NOT NULL, "note" TEXT, "byName" TEXT, "at" TEXT NOT NULL
      )`);
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "MonitoringMisuseNote_one" ON "MonitoringMisuseNote" ("employeeId", "fromAt")');
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
  mouse: () => 'Only the mouse moved - no typing, clicks or scrolling (possible fake presence)',
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
// THE MISUSE LIST (founder 2026-11-12: "ilaanti unwanted misuse chesnavi anni, oka tab lo remark or else edhaina oka name tho oka
// tab meedha vundali"). Every stretch of continuous single-button use across the people the viewer may see, with a remark the admin
// or team lead can add. The employee is warned on their own screen by the agent while it happens (agent 3.0). Nothing typed is kept.
// allowedIds: an array limits it to those people (a team lead's team); null means everyone (HR / Admin).
async function misuse(allowedIds, fromDay, toDay, { min = 2 } = {}) {
  await ensure();
  const useFilter = Array.isArray(allowedIds);
  if (useFilter && !allowedIds.length) return [];
  let empIds = [];
  if (useFilter) {
    for (let i = 0; i < allowedIds.length; i += 400) {
      const part = allowedIds.slice(i, i + 400).filter(Boolean);
      if (!part.length) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const rows = await prisma.$queryRawUnsafe(`SELECT DISTINCT "employeeId" FROM "MonitoringInputFlag" WHERE "day" >= ? AND "day" <= ? AND "employeeId" IN (${part.map(() => '?').join(',')})`, fromDay, toDay, ...part);
      empIds.push(...rows.map((r) => r.employeeId));
    }
  } else {
    const rows = await prisma.$queryRawUnsafe('SELECT DISTINCT "employeeId" FROM "MonitoringInputFlag" WHERE "day" >= ? AND "day" <= ?', fromDay, toDay);
    empIds = rows.map((r) => r.employeeId);
  }
  empIds = [...new Set(empIds)];
  if (!empIds.length) return [];
  const [map, notes] = await Promise.all([stretches(empIds, fromDay, toDay, { min }), misuseNotes(empIds, fromDay, toDay)]);
  const out = [];
  map.forEach((list, employeeId) => list.forEach((snip) => {
    const key = `${employeeId}|${snip.from}`;
    const n = notes.get(key) || null;
    out.push({
      id: key, employeeId, kind: snip.kind, key: snip.key, label: snip.label, day: snip.day,
      from: snip.from, to: snip.to, fromTime: snip.fromTime, toTime: snip.toTime, minutes: snip.minutes, presses: snip.presses,
      note: n ? n.note : '', noteBy: n ? n.byName : '', noteAt: n ? n.at : '',
    });
  }));
  out.sort((a, b) => b.day.localeCompare(a.day) || b.minutes - a.minutes || a.from.localeCompare(b.from));
  return out;
}
async function misuseNotes(ids, fromDay, toDay) {
  await ensure();
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(`SELECT "employeeId", "fromAt", "note", "byName", "at" FROM "MonitoringMisuseNote" WHERE "day" >= ? AND "day" <= ? AND "employeeId" IN (${part.map(() => '?').join(',')})`, fromDay, toDay, ...part);
    rows.forEach((r) => out.set(`${r.employeeId}|${r.fromAt}`, { note: r.note || '', byName: r.byName || '', at: r.at }));
  }
  return out;
}
async function setMisuseNote(employeeId, day, fromAt, note, byName) {
  await ensure();
  const clean = clip(note, 400);
  if (!clean) { await prisma.$executeRawUnsafe('DELETE FROM "MonitoringMisuseNote" WHERE "employeeId" = ? AND "fromAt" = ?', employeeId, fromAt); return { note: '', noteBy: '' }; }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MonitoringMisuseNote" ("id","employeeId","day","fromAt","note","byName","at") VALUES (?,?,?,?,?,?,?)
     ON CONFLICT("employeeId","fromAt") DO UPDATE SET "note" = excluded."note", "byName" = excluded."byName", "at" = excluded."at"`,
    `mmn${crypto.randomBytes(9).toString('hex')}`, employeeId, day, fromAt, clean, clip(byName, 80) || null, new Date().toISOString(),
  );
  return { note: clean, noteBy: clip(byName, 80) };
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

// ---------------------------------------------------------------------------
// WHERE AND WHEN EACH KEY / BUTTON WAS PRESSED (agent 2.7, founder 2026-11-12: "ey time nunchi ey time varaku, ey platform or app or
// website lo"). The same grouped counts as MonitoringKeyCount, split by the app in front (and the website, for a browser) and by
// the IST hour. Letter keys stay ONE count and number keys ONE count here too: never split into single letters.
let readyBuckets = null;
function ensureBuckets() {
  if (!readyBuckets) {
    readyBuckets = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringKeyBucket" (
        "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "app" TEXT NOT NULL, "site" TEXT NOT NULL DEFAULT '', "hour" INTEGER NOT NULL,
        "keyName" TEXT NOT NULL, "cnt" INTEGER NOT NULL DEFAULT 0, "updatedAt" TEXT NOT NULL,
        PRIMARY KEY ("employeeId", "day", "app", "site", "hour", "keyName")
      )`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MonitoringKeyBucket_key" ON "MonitoringKeyBucket" ("employeeId", "keyName", "day")');
      return true;
    })().catch((e) => { readyBuckets = null; throw e; });
  }
  return readyBuckets;
}
const APP_NAME = /^[^\u0000-\u001f]{1,60}$/;
async function addBuckets(device, day, rows) {
  await ensureBuckets();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { status: 400, error: 'Which day?' };
  const today = istDay(Date.now());
  if (day > today || day < istDay(Date.now() - 14 * 86400000)) return { saved: 0 };
  const now = new Date().toISOString();
  let saved = 0;
  for (const r of (Array.isArray(rows) ? rows : []).slice(0, 700)) {
    const app = clip(r && r.app, 60);
    const site = clip(r && r.site, 60);
    const hour = Math.round(Number(r && r.hour));
    if (!APP_NAME.test(app) || !(hour >= 0 && hour <= 23)) continue; // eslint-disable-line no-continue
    for (const [k, v] of Object.entries(r.counts && typeof r.counts === 'object' ? r.counts : {}).slice(0, 40)) {
      const n = Math.round(Number(v));
      if (!KEY_NAME.test(k) || !(n > 0) || n > 200000) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(
        'INSERT INTO "MonitoringKeyBucket" ("employeeId","day","app","site","hour","keyName","cnt","updatedAt") VALUES (?,?,?,?,?,?,?,?) ON CONFLICT("employeeId","day","app","site","hour","keyName") DO UPDATE SET "cnt" = "cnt" + excluded."cnt", "updatedAt" = excluded."updatedAt"',
        device.employeeId, day, app, site, hour, k, n, now,
      );
      saved += 1;
    }
  }
  return { saved };
}
/** One key / button of one person over the days given: where (app + website) and when (hour), most first. */
async function keyDetail(employeeId, fromDay, toDay, keyName) {
  await ensureBuckets();
  const key = String(keyName || '');
  if (!KEY_NAME.test(key)) return { status: 400, error: 'Which key?' };
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "day", "app", "site", "hour", SUM("cnt") AS "n" FROM "MonitoringKeyBucket" WHERE "employeeId" = ? AND "keyName" = ? AND "day" >= ? AND "day" <= ? GROUP BY "day", "app", "site", "hour"',
    employeeId, key, fromDay, toDay,
  );
  const byApp = new Map(); const byHour = new Map(); const cells = [];
  let total = 0;
  rows.forEach((r) => {
    const n = Number(r.n) || 0; total += n;
    const a = `${r.app}\t${r.site || ''}`;
    byApp.set(a, (byApp.get(a) || 0) + n);
    byHour.set(Number(r.hour), (byHour.get(Number(r.hour)) || 0) + n);
    cells.push({ day: r.day, app: r.app, site: r.site || '', hour: Number(r.hour), count: n });
  });
  return {
    key, from: fromDay, to: toDay, total,
    byApp: [...byApp.entries()].map(([k, n]) => { const [app, site] = k.split('\t'); return { app, site, count: n }; }).sort((x, y) => y.count - x.count),
    byHour: [...byHour.entries()].map(([hour, n]) => ({ hour, count: n })).sort((x, y) => x.hour - y.hour),
    // each hour with the apps in it, in time order: "2 pm - 3 pm: Excel 400, Chrome · WhatsApp 120"
    cells: cells.sort((x, y) => x.day.localeCompare(y.day) || x.hour - y.hour || y.count - x.count),
    grouped: ['Letter keys', 'Number keys'].includes(key),
  };
}

// ---------------------------------------------------------------------------
// ACTIVE TYPING TIME + TYPING INTENSITY (agent 2.8, founder 2026-11-12, the privacy-safe spec): per app and hour, how many minutes
// the keyboard / mouse were actually in use, and whether each typing minute was light / moderate / heavy, plus the key and click
// totals to work out the typing speed. Minutes and counts only - never a character. Table MonitoringActivityBucket, added to.
let readyActivity = null;
function ensureActivity() {
  if (!readyActivity) {
    readyActivity = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringActivityBucket" (
        "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "app" TEXT NOT NULL, "site" TEXT NOT NULL DEFAULT '', "hour" INTEGER NOT NULL,
        "kbMin" INTEGER NOT NULL DEFAULT 0, "mouseMin" INTEGER NOT NULL DEFAULT 0, "light" INTEGER NOT NULL DEFAULT 0,
        "mod" INTEGER NOT NULL DEFAULT 0, "heavy" INTEGER NOT NULL DEFAULT 0, "keys" INTEGER NOT NULL DEFAULT 0, "clicks" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" TEXT NOT NULL, PRIMARY KEY ("employeeId", "day", "app", "site", "hour")
      )`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MonitoringActivityBucket_day" ON "MonitoringActivityBucket" ("employeeId", "day")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MonitoringDayStat" (
        "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "longestTypingMin" INTEGER NOT NULL DEFAULT 0, "updatedAt" TEXT NOT NULL,
        PRIMARY KEY ("employeeId", "day")
      )`); // agent 2.9: longest run of minutes typed without a break, per day
      return true;
    })().catch((e) => { readyActivity = null; throw e; });
  }
  return readyActivity;
}
const NUMS = ['kbMin', 'mouseMin', 'light', 'mod', 'heavy', 'keys', 'clicks'];
async function addActivity(device, day, rows, longestTypingMin) {
  await ensureActivity();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { status: 400, error: 'Which day?' };
  const today = istDay(Date.now());
  if (day > today || day < istDay(Date.now() - 14 * 86400000)) return { saved: 0 };
  const now = new Date().toISOString();
  const longest = Math.max(0, Math.min(1440, Math.round(Number(longestTypingMin) || 0)));
  if (longest > 0) {
    // keep the biggest run seen for the day (a restart resets the agent's running count, never the saved max)
    await prisma.$executeRawUnsafe(
      'INSERT INTO "MonitoringDayStat" ("employeeId","day","longestTypingMin","updatedAt") VALUES (?,?,?,?) ON CONFLICT("employeeId","day") DO UPDATE SET "longestTypingMin" = MAX("longestTypingMin", excluded."longestTypingMin"), "updatedAt" = excluded."updatedAt"',
      device.employeeId, day, longest, now,
    );
  }
  let saved = 0;
  for (const r of (Array.isArray(rows) ? rows : []).slice(0, 700)) {
    const app = clip(r && r.app, 60); const site = clip(r && r.site, 60); const hour = Math.round(Number(r && r.hour));
    if (!APP_NAME.test(app) || !(hour >= 0 && hour <= 23)) continue; // eslint-disable-line no-continue
    const v = {}; NUMS.forEach((k) => { v[k] = Math.max(0, Math.min(100000, Math.round(Number(r[k]) || 0))); });
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MonitoringActivityBucket" ("employeeId","day","app","site","hour",${NUMS.map((k) => `"${k}"`).join(',')},"updatedAt")
       VALUES (?,?,?,?,?,${NUMS.map(() => '?').join(',')},?)
       ON CONFLICT("employeeId","day","app","site","hour") DO UPDATE SET ${NUMS.map((k) => `"${k}" = "${k}" + excluded."${k}"`).join(', ')}, "updatedAt" = excluded."updatedAt"`,
      device.employeeId, day, app, site, hour, ...NUMS.map((k) => v[k]), now,
    );
    saved += 1;
  }
  return { saved };
}
const speedOf = (keys, kbMin) => (kbMin > 0 ? Math.round(keys / kbMin) : 0);
/** Map(employeeId -> { kbMin, mouseMin, light, mod, heavy, keys, clicks, speed, perApp:[...], perHour:[...] }) for the days given. */
async function activityOf(employeeIds, fromDay, toDay = fromDay) {
  await ensureActivity();
  const ids = (employeeIds || []).filter(Boolean);
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "employeeId", "app", "site", "hour", ${NUMS.map((k) => `SUM("${k}") AS "${k}"`).join(', ')} FROM "MonitoringActivityBucket" WHERE "day" >= ? AND "day" <= ? AND "employeeId" IN (${part.map(() => '?').join(',')}) GROUP BY "employeeId", "app", "site", "hour"`,
      fromDay, toDay, ...part,
    );
    rows.forEach((r) => {
      if (!out.has(r.employeeId)) out.set(r.employeeId, { kbMin: 0, mouseMin: 0, light: 0, mod: 0, heavy: 0, keys: 0, clicks: 0, _app: new Map(), _hour: new Map() });
      const o = out.get(r.employeeId);
      NUMS.forEach((k) => { o[k] += Number(r[k]) || 0; });
      const ak = `${r.app}\t${r.site || ''}`;
      const a = o._app.get(ak) || { app: r.app, site: r.site || '', kbMin: 0, mouseMin: 0, keys: 0, clicks: 0 };
      a.kbMin += Number(r.kbMin) || 0; a.mouseMin += Number(r.mouseMin) || 0; a.keys += Number(r.keys) || 0; a.clicks += Number(r.clicks) || 0;
      o._app.set(ak, a);
      const h = o._hour.get(Number(r.hour)) || { hour: Number(r.hour), kbMin: 0, keys: 0 };
      h.kbMin += Number(r.kbMin) || 0; h.keys += Number(r.keys) || 0;
      o._hour.set(Number(r.hour), h);
    });
  }
  out.forEach((o) => {
    o.speed = speedOf(o.keys, o.kbMin);
    o.perApp = [...o._app.values()].map((a) => ({ ...a, speed: speedOf(a.keys, a.kbMin) })).sort((x, y) => y.kbMin - x.kbMin || y.keys - x.keys);
    o.perHour = [...o._hour.values()].sort((x, y) => x.hour - y.hour);
    o.longestTypingMin = 0;
    delete o._app; delete o._hour;
  });
  if (out.size) {
    const stat = await prisma.$queryRawUnsafe(
      `SELECT "employeeId", MAX("longestTypingMin") AS "m" FROM "MonitoringDayStat" WHERE "day" >= ? AND "day" <= ? AND "employeeId" IN (${ids.map(() => '?').join(',')}) GROUP BY "employeeId"`,
      fromDay, toDay, ...ids,
    ).catch(() => []);
    stat.forEach((r) => { if (out.has(r.employeeId)) out.get(r.employeeId).longestTypingMin = Number(r.m) || 0; });
  }
  return out;
}

/** One app / website of one person: its key / button counts and hourly typing - a click on an app row in the app-wise table. */
async function appKeys(employeeId, fromDay, toDay, app, site = '') {
  await ensureBuckets();
  const a = String(app || '');
  if (!APP_NAME.test(a)) return { status: 400, error: 'Which app?' };
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "keyName", "hour", SUM("cnt") AS "n" FROM "MonitoringKeyBucket" WHERE "employeeId" = ? AND "app" = ? AND "site" = ? AND "day" >= ? AND "day" <= ? GROUP BY "keyName", "hour"',
    employeeId, a, String(site || ''), fromDay, toDay,
  );
  const byKey = new Map(); const byHour = new Map(); let total = 0;
  rows.forEach((r) => {
    const n = Number(r.n) || 0; total += n;
    byKey.set(r.keyName, (byKey.get(r.keyName) || 0) + n);
    byHour.set(Number(r.hour), (byHour.get(Number(r.hour)) || 0) + n);
  });
  const MOUSE = ['Left click', 'Right click', 'Middle click', 'Mouse wheel'];
  return {
    app: a, site: String(site || ''), total,
    keys: [...byKey.entries()].filter(([k]) => !MOUSE.includes(k)).map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count),
    mouse: [...byKey.entries()].filter(([k]) => MOUSE.includes(k)).map(([name, count]) => ({ name, count })).sort((x, y) => MOUSE.indexOf(x.name) - MOUSE.indexOf(y.name)),
    byHour: [...byHour.entries()].map(([hour, count]) => ({ hour, count })).sort((x, y) => x.hour - y.hour),
  };
}

async function cleanup(retentionDays) {
  await ensure();
  await ensureCounts();
  const cutoff = istDay(Date.now() - Math.max(7, Number(retentionDays) || 90) * 86400000);
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringInputFlag" WHERE "day" < ?', cutoff);
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringKeyCount" WHERE "day" < ?', cutoff);
  await ensureBuckets();
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringKeyBucket" WHERE "day" < ?', cutoff);
  await ensureActivity();
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringActivityBucket" WHERE "day" < ?', cutoff);
  await prisma.$executeRawUnsafe('DELETE FROM "MonitoringDayStat" WHERE "day" < ?', cutoff);
}

module.exports = { ensure, save, stretches, summaryOf, misuse, misuseNotes, setMisuseNote, cleanup, addCounts, countsOf, addBuckets, keyDetail, addActivity, activityOf, appKeys, MIN_STRETCH, KINDS };

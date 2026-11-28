// ---------------------------------------------------------------------------
// THE SEAT A PROFILE BELONGS TO (founder 2026-11-28: "ahh positions lo ey recruiters vacharo, ahh recruiters logins lo ee profiles
// display avvali, evari profiles vallakey display avvali, tl ki andhari profiles display avvali" - and, for a profile worked from two
// seats: "Latest seat only").
//
// A profile's seat is the seat on its LATEST recruiter follow-up (ApplicationFollowUp.ownerPositionCode; a BDE's or a TL's follow-up
// does not move it). Whoever sits in that seat today sees it in their login - the previous holder's work too - and no other recruiter
// does. A profile with no seat on any recruiter follow-up keeps the old rule (assigned jobs, own work).
//
// The imported sheets spell the seats many ways ("Med 3", "MED 3", "Med3", "Med 03", "Non It -03", "EDU 3"): they are read as the seat
// they mean (MED-3, MFG-3, EDU-3). The stored text is never changed.
//
// Education also gets its TEAM from the seat: EDU-1..5 = Team A, EDU-6..10 = Team B (founder 2026-11-28: "both TLs can see, but it
// needs to be clearly visible that it belongs to Team A or Team B").
// ---------------------------------------------------------------------------
function normSeat(code) {
  const s = String(code == null ? '' : code).trim();
  if (!s) return null;
  let m = s.match(/^(edu|med|mfg)\s*[-_ ]?\s*tl$/i);
  if (m) return `${m[1].toUpperCase()}-TL`;
  m = s.match(/^(edu|med|mfg)\s*[-_ ]*\s*0*(\d{1,2})$/i);
  if (m) return `${m[1].toUpperCase()}-${Number(m[2])}`;
  m = s.match(/^non\s*it\s*[-_ ]*\s*0*(\d{1,2})$/i);
  if (m) return `MFG-${Number(m[1])}`;
  return null;
}
function eduTeamOfSeat(seat) {
  const m = /^EDU-(\d+)$/.exec(seat || '');
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 1 && n <= 5) return 'Team A';
  if (n >= 6 && n <= 10) return 'Team B';
  return null;
}

const NOT_RECRUITER = ['BDE', 'TL', 'bde', 'tl', 'Bde', 'Tl'];
// Prisma piece on Application: "no recruiter follow-up carries a seat" (these keep the old rule).
const UNSEATED_WHERE = { followUps: { none: { ownerPositionCode: { not: null }, OR: [{ ownerRole: null }, { ownerRole: { notIn: NOT_RECRUITER } }] } } };

const TTL = 60 * 1000;
let MAP = null; // { at, seatOf: Map appId -> seat (normalised; null when the code is not a seat), byCode: Map seat -> [appId] }
let JOB = null;
function load() {
  if (JOB) return JOB;
  const prisma = require('../db'); // eslint-disable-line global-require
  const seatsOfPeople = prisma.$queryRawUnsafe(`SELECT e."userId" AS uid, p."code" AS code, pa."fromDate" AS f FROM "PositionAssignment" pa
      JOIN "Position" p ON p."id" = pa."positionId" JOIN "Employee" e ON e."id" = pa."employeeId"
      WHERE e."userId" IS NOT NULL AND p."code" LIKE 'EDU-%' ORDER BY pa."fromDate" ASC`).catch(() => []);
  JOB = prisma.$queryRawUnsafe(`SELECT f."applicationId" AS id, f."ownerPositionCode" AS code, f."createdAt" AS t FROM "ApplicationFollowUp" f
      WHERE f."ownerPositionCode" IS NOT NULL AND UPPER(COALESCE(f."ownerRole", '')) NOT IN ('BDE', 'TL')`)
    .then((rows) => {
      const last = new Map();
      rows.forEach((r) => {
        const t = Number(r.t instanceof Date ? r.t.getTime() : r.t);
        const was = last.get(r.id);
        if (!was || t >= was.t) last.set(r.id, { t, code: r.code });
      });
      const seatOf = new Map();
      const byCode = new Map();
      last.forEach((v, id) => {
        const seat = normSeat(v.code);
        seatOf.set(id, seat);
        if (seat) { if (!byCode.has(seat)) byCode.set(seat, []); byCode.get(seat).push(id); }
      });
      return seatsOfPeople.then((ps) => {
        const eduSeatOfUser = new Map(); // the person's latest Education seat (a profile with no seat yet takes its owner's team)
        ps.forEach((r) => eduSeatOfUser.set(r.uid, normSeat(r.code)));
        MAP = { at: Date.now(), seatOf, byCode, eduSeatOfUser };
        return MAP;
      });
    })
    .catch(() => MAP)
    .finally(() => { JOB = null; });
  return JOB;
}
async function seatMap() {
  if (MAP) { if (Date.now() - MAP.at > TTL) load(); return MAP; }
  return load();
}
function seatMapSync() {
  if (!MAP || Date.now() - MAP.at > TTL) load();
  return MAP;
}
// A follow-up was just written: read the seats again on the next request.
function invalidate() { if (MAP) MAP.at = 0; }

// The profiles whose latest seat is one of these seats.
async function idsOnSeats(codes) {
  const m = await seatMap();
  if (!m) return [];
  const out = [];
  (codes || []).map(normSeat).filter(Boolean).forEach((c) => (m.byCode.get(c) || []).forEach((id) => out.push(id)));
  return out;
}
// For one loaded application: 'none' (no seat recorded - old rule), or whether its seat is one of `codes`.
function seatVerdict(appId, codes) {
  const m = seatMapSync();
  if (!m || !m.seatOf.has(appId)) return 'none';
  const seat = m.seatOf.get(appId);
  if (!seat) return 'none';
  return (codes || []).map(normSeat).includes(seat) ? 'mine' : 'other';
}
function seatOfApp(appId) {
  const m = seatMapSync();
  return m ? (m.seatOf.get(appId) || null) : null;
}

// Team A / Team B of an Education profile: its seat, else its owner recruiter's Education seat. null when neither says.
function eduTeamOfApp(appId, ownerUserId) {
  const m = seatMapSync();
  if (!m) return null;
  return eduTeamOfSeat(m.seatOf.get(appId)) || (ownerUserId && m.eduSeatOfUser ? eduTeamOfSeat(m.eduSeatOfUser.get(ownerUserId)) : null);
}

module.exports = { normSeat, eduTeamOfSeat, UNSEATED_WHERE, seatMap, seatMapSync, invalidate, idsOnSeats, seatVerdict, seatOfApp, eduTeamOfApp };

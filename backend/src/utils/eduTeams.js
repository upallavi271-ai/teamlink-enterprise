// ---------------------------------------------------------------------------
// EDUCATION TEAM A / TEAM B DO NOT SEE EACH OTHER'S PROFILES (founder 2026-11-11: "team a profiles team b ki kanipinchakudadhu,
// team b profiles team a ki kanipinchakudadhu"). Super Admin / Admin still see both, and pick one with the Section filter
// (Department Education -> Section Team A / Team B) on Candidates.
//
// The team comes from the seats (Position.team on the Education seats: EDU-1..5 + "EDU TL" = Team A, EDU-6..10 + "EDU-TL" = Team B):
//   * a login's team = the team of the Education seat they sit in now, else the last one they sat in;
//   * an application's team = its owner recruiter's team; with no owner, the job's seat (positionCode) or the job's recruiter.
// Used by utils/identity.js (viewOf, once per request) and utils/scope.js (the rule itself). Read every two minutes.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const TTL = 2 * 60 * 1000;
let cache = { at: 0, data: null };

const isEdu = (d) => /^edu/i.test(String(d || '').trim());

async function load() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  const seats = await prisma.position.findMany({ select: { id: true, code: true, department: true, team: true } });
  const eduSeats = seats.filter((p) => isEdu(p.department) && p.team && String(p.team).trim());
  const seatTeam = new Map(eduSeats.map((p) => [p.code, String(p.team).trim()]));
  const teams = [...new Set(seatTeam.values())];
  const userTeam = new Map();
  if (teams.length > 1) {
    const rows = await prisma.positionAssignment.findMany({
      where: { positionId: { in: eduSeats.map((p) => p.id) } },
      select: { fromDate: true, toDate: true, position: { select: { code: true } }, employee: { select: { userId: true } } },
    });
    const best = new Map(); // userId -> the seat now, else the latest one
    rows.forEach((r) => {
      const u = r.employee && r.employee.userId;
      if (!u) return;
      const rank = `${r.toDate ? '0' : '1'}${r.fromDate || ''}`;
      const cur = best.get(u);
      if (!cur || rank > cur.rank) best.set(u, { rank, code: r.position.code });
    });
    best.forEach((v, u) => userTeam.set(u, seatTeam.get(v.code)));
  }
  const data = { teams, seatTeam, userTeam };
  cache = { at: Date.now(), data };
  return data;
}

/** The viewer's side: their team, and the other team's people and seats (what they must not see). null = not in an Education team. */
async function viewOf(userId) {
  if (!userId) return null;
  const d = await load();
  const team = d.userTeam.get(userId);
  if (!team || d.teams.length < 2) return null;
  const otherUserIds = [...d.userTeam].filter(([, t]) => t !== team).map(([u]) => u);
  const otherSeats = [...d.seatTeam].filter(([, t]) => t !== team).map(([c]) => c);
  return { team, otherUserIds, otherSeats };
}

/** The team an application belongs to (for the Super Admin's filter), from a loaded snapshot. */
function teamOfApplication(d, a) {
  if (!a) return null;
  if (a.ownerRecruiterId && d.userTeam.has(a.ownerRecruiterId)) return d.userTeam.get(a.ownerRecruiterId);
  const r = a.requirement || {};
  if (r.positionCode && d.seatTeam.has(r.positionCode)) return d.seatTeam.get(r.positionCode);
  if (r.recruiterId && d.userTeam.has(r.recruiterId)) return d.userTeam.get(r.recruiterId);
  return null;
}

const reset = () => { cache = { at: 0, data: null }; };

module.exports = { load, viewOf, teamOfApplication, reset };

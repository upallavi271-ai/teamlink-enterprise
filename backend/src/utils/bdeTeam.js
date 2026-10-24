// ---------------------------------------------------------------------------
// THE BDE TEAM — one helper, from HRMS (user, 2026-10-12).
//
// "BDE team were separate; take the data properly from HRMS." The BDE team is
// the ACTIVE employees of the BDE department in HRMS (Employee.department is
// BDE), plus anyone who holds a BDE seat (BDE-EDU-1, BDE-MED, BDE-MFG ...: the
// first word of the seat code is BDE), WITHOUT the BDE team lead herself (the
// BDE-TL seat / a TL of the BDE department). It never contains
//   * a recruiter, or anyone who is not a client manager by login,
//   * a person of another department (HR, Recruitment ...),
//   * anyone who merely reports to the BDE TL by the free-text Employee.tl field
//     (HR / Recruitment people carry her name there from the old trackers).
// Everything that draws "the BDE TL's team" — the Team page, the dashboard
// "BDE team" box, the people pickers — reads THIS list, so a recruiter can never
// appear under a BDE TL.
//
//   bdeTeamMembers() -> {
//     members     [{ userId, employeeId, name, seat, seatLabel, department, designation }]
//                 active, with a login and ATS role BDE: the people shown
//     noLogin     in the BDE department / on a BDE seat but with no login (not shown)
//     notBdeRole  in the BDE department / on a BDE seat, login present, ATS role not BDE
//     seatOnly    on a BDE seat but HRMS department is not BDE
//     noSeat      in the BDE department, active, no BDE seat yet
//   }
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { isBdeDepartment, parseBdeSeat } = require('./bdeDesk');

const LEFT = ['Relieved', 'Exited', 'Exit Process'];
const isTestPerson = (u) => !!u && /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);

async function bdeTeamMembers({ includeTest = false } = {}) {
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: LEFT } },
    select: {
      id: true, name: true, userId: true, department: true, designation: true, employmentStatus: true,
      positionAssignments: { where: { toDate: null }, select: { position: { select: { code: true, department: true } } } },
    },
  });
  const cand = rows.map((e) => {
    const seats = e.positionAssignments.map((a) => a.position).filter(Boolean);
    const bdeSeat = seats.map((p) => ({ code: p.code, ...parseBdeSeat(p) })).find((p) => p.isBde) || null;
    return { e, bdeSeat, inDept: isBdeDepartment([e.department]) };
  }).filter((c) => c.inDept || c.bdeSeat);

  const userIds = cand.map((c) => c.e.userId).filter(Boolean);
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, status: true, atsRole: true, role: true } })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const out = { members: [], noLogin: [], notBdeRole: [], seatOnly: [], noSeat: [] };
  cand.forEach(({ e, bdeSeat, inDept }) => {
    const u = e.userId ? userById.get(e.userId) : null;
    if (u && isTestPerson(u) && !includeTest) return;
    // The lead herself: the BDE TL seat, or a team lead / manager of the BDE department.
    if ((bdeSeat && bdeSeat.isTl) || (u && ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(u.atsRole))) return;
    const info = {
      userId: e.userId || null, employeeId: e.id, name: e.name, department: e.department || null, designation: e.designation || null,
      seat: bdeSeat ? bdeSeat.code : null, seatLabel: bdeSeat ? bdeSeat.label : null,
    };
    if (!inDept) out.seatOnly.push(info);
    if (inDept && !bdeSeat) out.noSeat.push(info);
    if (!u) { out.noLogin.push(info); return; }
    if (u.status && u.status !== 'Active') return;
    if (u.atsRole !== 'BDE') { out.notBdeRole.push({ ...info, atsRole: u.atsRole }); return; }
    out.members.push(info);
  });
  out.members.sort((a, b) => String(a.seatLabel || 'ZZZ').localeCompare(String(b.seatLabel || 'ZZZ')) || a.name.localeCompare(b.name));
  return out;
}

// Just the user ids of the people shown.
async function bdeTeamUserIds(opts) {
  return (await bdeTeamMembers(opts)).members.map((m) => m.userId);
}

module.exports = { bdeTeamMembers, bdeTeamUserIds };

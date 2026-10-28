// ---------------------------------------------------------------------------
// WHY DOES AN EMPLOYEE'S OWN LOGIN SHOW NO ATTENDANCE? (founder 2026-10-28: "employee logins lo attendance inka update kaledu";
// the Super Admin sees everyone's days.) READ-ONLY - nothing is written.
//
// For every active employee it prints, side by side:
//   * LOGIN    is a login linked to the employee (Employee.userId)? My Attendance answers "no employee record linked"
//              without it (utils/ownEmployee.js links by the same e-mail only when exactly one employee has it);
//   * DATA     the attendance rows / punches / imported-history days stored for them from --from;
//   * SCREEN   what My Attendance shows them (the same D.loadDays call as GET /api/attendance/my-days).
// Problems are listed first.
//
//   node scripts/check-employee-attendance.js [--from 2026-10-13] [--to 2026-10-28] [--code TL306]
// ---------------------------------------------------------------------------
const prisma = require('../src/db');
const D = require('../src/utils/attendanceDays');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FROM = arg('--from') || '2026-10-13';
const TO = arg('--to') || D.localDate();
const CODE = arg('--code');
const pad = (s, n) => String(s ?? '').slice(0, n - 1).padEnd(n);

(async () => {
  const cfg = await prisma.hrConfig.findFirst().catch(() => null);
  const emps = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: ['Exited', 'Relieved', 'Terminated', 'Absconding'] }, ...(CODE ? { employeeCode: CODE } : {}) },
    include: { user: { select: { id: true, email: true, status: true } } },
    orderBy: { employeeCode: 'asc' },
  });
  const ids = emps.map((e) => e.id);
  const where = { employeeId: { in: ids }, date: { gte: FROM, lte: TO } };
  const [att, pun, hist] = await Promise.all([
    prisma.attendance.groupBy({ by: ['employeeId'], where, _count: { _all: true } }),
    prisma.attendancePunch.groupBy({ by: ['employeeId'], where, _count: { _all: true } }),
    prisma.attendanceHistory.groupBy({ by: ['employeeId'], where, _count: { _all: true } }),
  ]);
  const n = (list) => new Map(list.map((x) => [x.employeeId, x._count._all]));
  const A = n(att); const P = n(pun); const H = n(hist);
  // logins whose e-mail matches an unlinked employee (the self-link would pick them up on first open)
  const users = await prisma.user.findMany({ select: { id: true, email: true, status: true } });
  const byEmail = new Map(users.map((u) => [String(u.email || '').trim().toLowerCase(), u]));
  const linkedUserIds = new Set(emps.map((e) => e.userId).filter(Boolean));

  const { days } = await D.loadDays(prisma, { employees: emps, from: FROM, to: TO, cfg: cfg || {}, preview: true });
  const rows = emps.map((e) => {
    const shown = days(e).filter((d) => !['Upcoming', 'Not Joined'].includes(d.status));
    const count = (s) => shown.filter((d) => d.status === s).length;
    const present = shown.filter((d) => /Present|Late|Half/i.test(d.status)).length;
    const stored = (A.get(e.id) || 0) + (P.get(e.id) || 0) + (H.get(e.id) || 0);
    const match = byEmail.get(String(e.email || '').trim().toLowerCase());
    let login = e.userId ? (e.user && e.user.status !== 'Active' ? `linked (${e.user.status})` : 'linked') : 'NOT linked';
    if (!e.userId && match && !linkedUserIds.has(match.id)) login = 'NOT linked (same-email login exists: links on first open)';
    const problem = !e.userId ? 'login not linked'
      : stored > 0 && present === 0 ? 'data stored but no present day on the screen'
        : stored === 0 ? 'no attendance stored for this period' : '';
    return { e, login, a: A.get(e.id) || 0, p: P.get(e.id) || 0, h: H.get(e.id) || 0, present, absent: count('Absent'), problem };
  });

  console.log(`EMPLOYEE LOGINS vs ATTENDANCE, ${FROM} to ${TO} (read-only)\n`);
  const head = () => console.log(`  ${pad('CODE', 9)}${pad('NAME', 24)}${pad('LOGIN', 22)}${pad('ROWS', 6)}${pad('PUNCH', 7)}${pad('IMPORT', 8)}${pad('SCREEN P/A', 12)}PROBLEM`);
  const line = (r) => console.log(`  ${pad(r.e.employeeCode, 9)}${pad(r.e.name, 24)}${pad(r.login, 22)}${pad(r.a, 6)}${pad(r.p, 7)}${pad(r.h, 8)}${pad(`${r.present}/${r.absent}`, 12)}${r.problem}`);
  const bad = rows.filter((r) => r.problem);
  console.log(`PROBLEMS (${bad.length})`); head(); bad.forEach(line);
  console.log(`\nALL (${rows.length})`); head(); rows.forEach(line);
  const latest = await prisma.attendance.findFirst({ where: { date: { gte: FROM } }, orderBy: { date: 'desc' }, select: { date: true } });
  const latestP = await prisma.attendancePunch.findFirst({ where: { date: { gte: FROM } }, orderBy: { date: 'desc' }, select: { date: true } });
  console.log(`\nLatest stored day: attendance ${latest ? latest.date : '-'}, punches ${latestP ? latestP.date : '-'}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

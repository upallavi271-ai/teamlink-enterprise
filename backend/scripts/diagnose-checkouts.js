// ---------------------------------------------------------------------------
// WHY IS A CHECK-OUT MISSING? (founder 2026-10-28: "15-26 Oct konni check-outs update kaledu") - READ-ONLY, nothing is written.
// For every employee-day in the range that My Attendance shows WITHOUT a check-out it prints what each source holds:
//   FILE    the imported PulseHRM day (first check-in / last check-out / punch times), if any
//   PUNCH   every punch TeamLink has (time, In / Out, how: Biometric / GPS / Web, device key)
//   DAY     the attendance row (status, check-in / check-out, set by HR?)
// and sorts the days into reasons, so the fix can be exact.
//
//   node scripts/diagnose-checkouts.js [--from 2026-10-15] [--to 2026-10-26] [--code TL511]
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = process.env.TL_BACKEND || path.resolve(__dirname, '..');
const prisma = require(path.join(BACK, 'src/db'));
const D = require(path.join(BACK, 'src/utils/attendanceDays'));

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FROM = arg('--from') || '2026-10-15';
const TO = arg('--to') || '2026-10-26';
const CODE = arg('--code');
const secs = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t || '')); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null; };

(async () => {
  const cfg = await prisma.hrConfig.findFirst().catch(() => null);
  const emps = await prisma.employee.findMany({ where: { employmentStatus: { notIn: ['Exited', 'Relieved', 'Terminated', 'Absconding'] }, ...(CODE ? { employeeCode: CODE } : {}) }, orderBy: { employeeCode: 'asc' } });
  const { days } = await D.loadDays(prisma, { employees: emps, from: FROM, to: TO, cfg: cfg || {}, preview: true });
  const ids = emps.map((e) => e.id);
  const w = { employeeId: { in: ids }, date: { gte: FROM, lte: TO } };
  const [punches, recs, hist] = await Promise.all([
    prisma.attendancePunch.findMany({ where: w, orderBy: [{ date: 'asc' }, { time: 'asc' }] }),
    prisma.attendance.findMany({ where: w }),
    prisma.attendanceHistory.findMany({ where: w }),
  ]);
  const k = (id, d) => `${id}|${d}`;
  const P = new Map(); punches.forEach((p) => { const x = k(p.employeeId, p.date); if (!P.has(x)) P.set(x, []); P.get(x).push(p); });
  const R = new Map(recs.map((r) => [k(r.employeeId, r.date), r]));
  const H = new Map(hist.map((h) => [k(h.employeeId, h.date), h]));

  const reasons = {};
  const lines = [];
  for (const e of emps) {
    for (const d of days(e)) {
      if (d.checkOut || !d.checkIn) continue; // only "came in, no check-out"
      const key = k(e.id, d.date);
      const ps = P.get(key) || []; const r = R.get(key); const h = H.get(key);
      const outs = ps.filter((p) => p.direction === 'Out');
      const lastP = ps.map((p) => secs(p.clockTime || p.time)).filter((x) => x != null).sort((a, b) => b - a)[0];
      let why;
      if (!h || !h.lastCheckOut) why = h ? 'file has this day but NO check-out (exported before evening / punches only)' : 'no file for this day, no Out punch';
      else if (r && r.timesSetBy) why = 'times set by hand (HR / Super Admin) stand';
      else if (outs.length) why = 'an Out punch exists but is not used (earlier than the check-in?)';
      else if (lastP != null && lastP >= secs(h.lastCheckOut)) why = 'a punch LATER than the file check-out is marked In (device key / app) - the file check-out was not added';
      else why = 'file has the check-out but it did not reach the day (other)';
      reasons[why] = (reasons[why] || 0) + 1;
      lines.push(`${e.employeeCode.padEnd(7)} ${d.date}  screen ${d.status} in ${d.checkIn}\n`
        + `    FILE  ${h ? `in ${h.firstCheckIn || '-'} out ${h.lastCheckOut || '-'} log ${h.punchTimes || '-'}` : '-'}\n`
        + `    PUNCH ${ps.map((p) => `${p.clockTime || p.time} ${p.direction} ${p.method || ''}${p.deviceState != null ? ` key${p.deviceState}` : ''}${p.source ? ` (${p.source})` : ''}`).join(' ; ') || '-'}\n`
        + `    DAY   ${r ? `${r.status} in ${r.checkIn || '-'} out ${r.checkOut || '-'}${r.timesSetBy ? ` set by ${r.timesSetBy}` : ''}` : '-'}\n    WHY   ${why}`);
    }
  }
  console.log(`DAYS WITH A CHECK-IN BUT NO CHECK-OUT, ${FROM} to ${TO}: ${lines.length}\n`);
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`  ${String(n).padStart(3)}  ${r}`));
  console.log(`\nBY DATE: ${Object.entries(lines.reduce((m, l) => { const d = l.slice(8, 18); m[d] = (m[d] || 0) + 1; return m; }, {})).map(([d, n]) => `${d.slice(5)}:${n}`).join('  ')}\n`);
  lines.forEach((l) => console.log(l));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

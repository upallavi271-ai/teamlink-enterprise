// ---------------------------------------------------------------------------
// recon-pulsehrm-dump.js - READ-ONLY. Dumps what TeamLink holds for a window
// (punches, marked days, imported history, leave, holidays, policy) AND what its
// day engine (utils/attendanceDays.js loadDays, preview:true = the rule the KPI
// screens use) reports, to one JSON file, so the reconciliation can be computed
// offline and repeated against more than one database copy.
//
//   node scripts/recon-pulsehrm-dump.js --db <copy.db> --out <dump.json> [--from 2026-09-27] [--to 2026-10-09]
//
// --db must be a COPY (a snapshot). The real prisma/dev.db is refused.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const L = require('./recon-pulsehrm-lib');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('--db');
const OUT = arg('--out');
const FROM = arg('--from', '2026-09-27');
const TO = arg('--to', '2026-10-09');
const ASOF = arg('--asof', null); // read the days as if today were this date (the user's "today" = 2026-10-09)
if (!DB || !OUT) { console.error('usage: --db <copy.db> --out <dump.json> [--from] [--to]'); process.exit(2); }
const dbAbs = path.resolve(DB).replace(/\\/g, '/');
L.assertNotRealDb(dbAbs);
const realDb = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/').toLowerCase();
if (dbAbs.toLowerCase() === realDb) { console.error('Refusing the real dev.db'); process.exit(2); }
process.env.DATABASE_URL = `file:${dbAbs}`;

const prisma = require('../src/db');
const D = require('../src/utils/attendanceDays');
const { withExtras } = require('../src/utils/attendancePolicy');

(async () => {
  const employees = await prisma.employee.findMany({
    select: { id: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true, dateOfJoining: true, biometricPin: true, tl: true, stl: true, team: true },
  });
  const [punches, attendance, history, leaves, holidays, cfg, balances, regs] = await Promise.all([
    prisma.attendancePunch.findMany({ where: { date: { gte: L.shiftDay(FROM, -3), lte: L.shiftDay(TO, 3) } } }),
    prisma.attendance.findMany({ where: { date: { gte: L.shiftDay(FROM, -3), lte: L.shiftDay(TO, 3) } } }),
    prisma.attendanceHistory.findMany({ where: { date: { gte: L.shiftDay(FROM, -3), lte: L.shiftDay(TO, 3) } } }),
    prisma.leaveRequest.findMany({ where: { toDate: { gte: L.shiftDay(FROM, -60) }, fromDate: { lte: L.shiftDay(TO, 60) } } }),
    prisma.holiday.findMany({ orderBy: { date: 'asc' } }),
    prisma.hrConfig.findFirst(),
    prisma.leaveBalance.findMany(),
    prisma.attendanceRegularization.findMany({ where: { date: { gte: FROM, lte: TO } } }),
  ]);
  const fullCfg = await withExtras(cfg || {});

  // The same roster the Attendance screens use (utils/attendanceDays.js rollOf).
  const roll = await D.rollOf(prisma, employees);
  const { days } = await D.loadDays(prisma, { employees: roll.employees, from: FROM, to: TO, cfg: cfg || {}, lastDayOf: roll.lastDayOf, preview: true, ...(ASOF ? { asOf: ASOF } : {}) });
  const dayRows = [];
  for (const e of roll.employees) {
    for (const r of days(e)) {
      dayRows.push({
        employeeId: e.id, date: r.date, status: r.status, checkIn: r.checkIn || null, checkOut: r.checkOut || null, hours: r.hours ?? null,
        kpi: r.kpi || null, present: r.present || 0, leave: r.leave || 0, absent: r.absent || 0, pending: r.pending || 0, paid: r.paid || 0,
        unpaidLeave: r.unpaidLeave || 0, counted: r.counted !== false, late: !!r.late, earlyLogout: !!r.earlyLogout, session: r.session || null,
        punches: r.punches || 0, how: r.how || null, reason: r.reason || '', leaveType: r.leaveType || null, sandwich: !!r.sandwich,
        pendingHalf: !!r.pendingHalf, leaveId: r.leaveId || null, leaveHalf: r.leaveHalf || null, workedOnOff: r.workedOnOff || null, doublePunch: !!r.doublePunch, rule: r.rule || null,
      });
    }
  }
  const out = {
    meta: { db: path.basename(dbAbs), from: FROM, to: TO, takenAt: new Date().toISOString(), today: ASOF || D.localDate(), asof: ASOF },
    cfg: fullCfg,
    employees: employees.map((e) => ({ ...e, dateOfJoining: e.dateOfJoining ? e.dateOfJoining.toISOString().slice(0, 10) : null })),
    lastDayOf: [...roll.lastDayOf.entries()],
    punches, attendance, history,
    leaves: leaves.map((l) => ({ ...l, createdAt: l.createdAt && l.createdAt.toISOString(), decidedAt: l.decidedAt && l.decidedAt.toISOString() })),
    holidays, balances: balances.map((b) => ({ employeeId: b.employeeId, type: b.type, total: b.total, taken: b.taken, updatedAt: b.updatedAt && b.updatedAt.toISOString() })), regs,
    dayRows,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`dump ${OUT}: employees ${employees.length}, punches ${punches.length}, attendance ${attendance.length}, history ${history.length}, leaves ${leaves.length}, dayRows ${dayRows.length}`);
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });

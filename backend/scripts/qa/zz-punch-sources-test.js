const TLT = require('./tl-target');
// Proves every attendance payload carries source labels for BOTH web check-in and biometric import punches.
// Usage: TL_API=http://localhost:4011 NODE_PATH=<backend>/node_modules node zz-punch-sources-test.js [keep]
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const API = TLT.API;
const stamp = Date.now().toString(36);
const DATE = '2026-10-05';
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m); } };
const made = {};

async function get(tok, p, params) {
  const r = await fetch(`${API}${p}${params ? `?${new URLSearchParams(params)}` : ''}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function clean() {
  const u = made.user; const e = made.emp;
  if (e) {
    await prisma.attendancePunch.deleteMany({ where: { employeeId: e.id } });
    await prisma.attendanceHistory.deleteMany({ where: { employeeRef: e.employeeCode } });
    await prisma.attendance.deleteMany({ where: { employeeId: e.id } });
    await prisma.notification.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.employee.delete({ where: { id: e.id } }).catch(() => {});
  }
  if (u) await prisma.user.delete({ where: { id: u.id } }).catch((x) => console.log('user delete', x.message.slice(0, 80)));
}

(async () => {
  try {
    const u = await prisma.user.create({ data: { name: `ZZTEST Punch ${stamp}`, email: `zztest.punch.${stamp}@example.test`, passwordHash: 'x'.repeat(40), status: 'Active', role: 'HR', hrmsRole: 'HR', atsRole: 'HR', hrmsAccess: true, atsAccess: false, accountsAccess: false } });
    made.user = u;
    const e = await prisma.employee.create({ data: { userId: u.id, employeeCode: `ZZT-PS-${stamp}`, name: u.name, email: u.email, department: 'ZZTEST-PS', designation: 'Tester' } });
    made.emp = e;
    const tok = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    if (process.argv[2] === 'clean') { await clean(); return; }
    // one WEB check-in (Face, inside office, 40 m) + imported BIOMETRIC punches the same minute and later
    await prisma.attendancePunch.create({ data: { employeeId: e.id, date: DATE, time: '09:05', direction: 'In', method: 'Face Recognition', source: 'Web', latitude: 17.4, longitude: 78.4, distanceM: 40, locationStatus: 'Inside geofence', verificationStatus: 'Verified' } });
    const base = { employeeId: e.id, date: DATE, source: 'PulseHRM import', verificationStatus: 'Imported' };
    await prisma.attendancePunch.create({ data: { ...base, time: '09:05', clockTime: '09:05:20', direction: 'In', method: 'Biometric' } });
    await prisma.attendancePunch.create({ data: { ...base, time: '18:02', clockTime: '18:02:10', direction: 'Out', method: 'Biometric' } });
    await prisma.attendanceHistory.create({ data: { employeeRef: e.employeeCode, employeeId: e.id, matchStatus: 'Matched', date: DATE, firstCheckIn: '09:05:20', lastCheckOut: '18:02:10', punchTimes: '09:05:20|13:00:00|13:30:00|18:02:10', sources: 'report,logs', result: 'ZZTEST', importBatch: `ZZTEST-${stamp}` } });
    made.keep = true;

    // ---- Punch Log
    const pl = await get(tok, '/attendance/punch-log', { from: DATE, to: DATE, department: 'ZZTEST-PS' });
    ok(pl.status === 200, `punch-log 200 (${pl.status})`);
    const row = pl.body && pl.body.rows.find((x) => x.employeeId === e.id);
    ok(!!row, 'punch-log has the ZZTEST person-day');
    const labels = row ? row.rawPunches.map((p) => p.sourceLabel) : [];
    console.log('  rawPunches:', row && row.rawPunches.map((p) => `${p.time} ${p.direction} ${p.sourceLabel}${p.usedAs ? ` [${p.usedAs}]` : ''}${p.distanceM != null ? ` ${p.distanceM}m` : ''}`).join(' | '));
    ok(labels.includes('Web check-in'), 'punch-log carries a Web check-in punch');
    ok(labels.includes('Biometric import'), 'punch-log carries Biometric import punches');
    ok(row && row.rawPunches.length === 5, `all 5 raw punches listed, none merged (${row && row.rawPunches.length})`);
    ok(row && row.rawPunches.filter((p) => p.time.startsWith('09:05')).length === 2, 'web 09:05 and biometric 09:05:20 both shown (same minute)');
    ok(row && row.rawPunches.some((p) => p.usedAs === 'first-in'), 'first-in marked');
    ok(row && row.sourceCounts.web === 1 && row.sourceCounts.biometric === 4, `sourceCounts web=1 biometric=4 (${JSON.stringify(row && row.sourceCounts)})`);
    ok(pl.body.sourceTotals && pl.body.sourceTotals.web >= 1 && pl.body.sourceTotals.biometric >= 1, `sourceTotals ${JSON.stringify(pl.body.sourceTotals)}`);
    const plW = await get(tok, '/attendance/punch-log', { from: DATE, to: DATE, department: 'ZZTEST-PS', punchSource: 'web' });
    ok(plW.body.rows.some((x) => x.employeeId === e.id), 'filter punchSource=web keeps the person');
    const plP = await get(tok, '/attendance/punch-log', { from: DATE, to: DATE, department: 'ZZTEST-PS', punchSource: 'pulse' });
    ok(!plP.body.rows.some((x) => x.employeeId === e.id), 'filter punchSource=pulse drops the person (no pulse-typed punch)');

    // ---- First check-in / last check-out report
    const bio = await get(tok, '/attendance/biometric', { date: DATE, department: 'ZZTEST-PS', all: '1' });
    const br = bio.body && bio.body.rows && bio.body.rows.find((x) => x.employeeId === e.id);
    ok(!!br && br.rawPunches.length === 5 && br.sourceCounts.web === 1, 'biometric report row carries both kinds');
    ok(bio.body && bio.body.sourceTotals && bio.body.sourceTotals.all >= 1, `biometric sourceTotals ${JSON.stringify(bio.body && bio.body.sourceTotals)}`);

    // ---- KPI report (also feeds the monthly calendar)
    const kpi = await get(tok, '/attendance/kpi-report', { from: DATE, to: DATE, department: 'ZZTEST-PS' });
    const kr = kpi.body && kpi.body.rows && kpi.body.rows.find((x) => x.employeeId === e.id);
    ok(!!kr && kr.punchList.length === 5 && kr.sourceCounts.web === 1, 'kpi-report row carries punchList + sourceCounts');
    ok(kpi.body && kpi.body.facets && kpi.body.facets.punchSource, 'kpi-report facets.punchSource present');

    // ---- My attendance (own employee) and team-days
    const my = await get(tok, '/attendance/my-days', { from: DATE, to: DATE });
    const mr = my.body && my.body.rows && my.body.rows.find((x) => x.date === DATE);
    ok(!!mr && mr.punchList.some((p) => p.sourceLabel === 'Web check-in') && mr.punchList.some((p) => p.sourceLabel === 'Biometric import'), 'my-days carries both Web check-in and Biometric import');
    const td = await get(tok, '/attendance/team-days', { from: DATE, to: DATE });
    const tr = td.body && td.body.rows && td.body.rows.find((x) => x.employeeId === e.id);
    ok(!!tr && tr.sourceCounts && tr.sourceCounts.web === 1, 'team-days carries sourceCounts');

    // ---- raw /punches list
    const pu = await get(tok, '/attendance/punches', { employeeId: e.id, date: DATE });
    const kinds = new Set((pu.body || []).map((p) => p.sourceLabel));
    ok(kinds.has('Web check-in') && kinds.has('Biometric import'), `/punches rows labelled: ${[...kinds].join(', ')}`);

    // ---- export column
    const ex = await fetch(`${API}/attendance/punch-log?${new URLSearchParams({ from: DATE, to: DATE, department: 'ZZTEST-PS', format: 'csv' })}`, { headers: { Authorization: `Bearer ${tok}` } });
    const csv = await ex.text();
    ok(/Punches by source/.test(csv) && /Web check-in 1, Biometric 4/.test(csv), 'punch-log CSV has the Punches by source column');
    console.log(`\n${pass} passed, ${fail} failed`);
    if (process.argv[2] === 'keep') { console.log('KEPT; user', u.id, 'emp', e.employeeCode, 'date', DATE); process.exitCode = fail ? 1 : 0; return; }
    await clean();
    process.exitCode = fail ? 1 : 0;
  } catch (x) {
    console.log('ERROR', x); await clean(); process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
})();

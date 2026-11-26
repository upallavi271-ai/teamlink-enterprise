// EMPLOYEE MONITORING - OVERTIME, TRENDS, ALERT RULES (utils/monitoringPlus.js): on a COPY of a database, never the live one.
//   TEST_SOURCE_DB=<a .db file> node scripts/monitoring-plus-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `monplus-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;

let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

(async () => {
  const prisma = require('../src/db');
  const M = require('../src/utils/monitoring');
  const P = require('../src/utils/monitoringPlus');
  try {
    // --- the notice: the pre-overtime notice is upgraded once, and the new one mentions overtime
    const before = await prisma.monitoringSetting.findUnique({ where: { id: 'default' } });
    const s0 = await M.settings();
    check('the notice now mentions overtime', /overtime/i.test(s0.policyText));
    if (before && !/overtime/i.test(before.policyText || '')) check('an old standard notice gets a new version (everyone accepts once)', s0.policyVersion === (before.policyVersion || 1) + 1 || s0.policyText !== before.policyText, [before.policyVersion, s0.policyVersion]);
    check('overtime is on by default: 60 min before, 240 after', s0.overtime && s0.overtime.enabled && s0.overtime.beforeMinutes === 60 && s0.overtime.afterMinutes === 240, s0.overtime);
    check('the agent is told the overtime window only while the notice mentions it', P.otLive(s0.overtime, s0.policyText) && !P.otLive(s0.overtime, 'Only work hours are recorded.'));

    // --- a person, a PC, consent
    const emp = await prisma.employee.findFirst({ where: { employmentStatus: 'Active' }, select: { id: true, department: true } });
    const dev = await prisma.monitoringDevice.create({ data: { employeeId: emp.id, deviceName: 'ZZ-MONPLUS', tokenHash: `zz-${Date.now()}`, approved: true } });
    await M.recordConsent(emp.id, s0.policyVersion, null, 'test');
    const cfg = M.effective(s0, await M.overrideIndex(), { id: emp.id, department: emp.department });
    const day = M.todayIst();
    const at = (hm) => new Date(`${day}T${hm}:00+05:30`);
    // a record running across the end of work, an after-hours one, one far too late, and one before work
    const end = cfg.workEnd; const start = cfg.workStart;
    const mins = (hm, d) => { const [h, m] = hm.split(':').map(Number); const t = h * 60 + m + d; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
    const recs = [
      { appName: 'EXCEL', windowTitle: 'Budget.xlsx', start: at(mins(end, -10)).toISOString(), end: at(mins(end, 20)).toISOString(), isIdle: false },
      { appName: 'chrome', windowTitle: 'YouTube - funny', start: at(mins(end, 60)).toISOString(), end: at(mins(end, 90)).toISOString(), isIdle: false },
      { appName: 'chrome', windowTitle: 'x', start: at(mins(end, 60)).toISOString(), end: at(mins(end, 90)).toISOString(), isIdle: false },
      { appName: 'Locked', windowTitle: '', start: at(mins(end, 90)).toISOString(), end: at(mins(end, 100)).toISOString(), isIdle: true },
      { appName: 'notepad', windowTitle: 'late', start: at(mins(end, 300)).toISOString(), end: at(mins(end, 310)).toISOString(), isIdle: false },
      { appName: 'OUTLOOK', windowTitle: 'early', start: at(mins(start, -30)).toISOString(), end: at(mins(start, -10)).toISOString(), isIdle: false },
    ];
    const future = at(mins(end, 310)).getTime() > Date.now() + 5 * 60000;
    if (future) {
      console.log('  (the after-hours records lie in the future today, so the day before is used)');
    }
    const useDay = future ? M.addDays(day, -1) : day;
    const at2 = (hm) => new Date(`${useDay}T${hm}:00+05:30`);
    const recs2 = future ? recs.map((r) => ({ ...r, start: new Date(new Date(r.start).getTime() - 86400000).toISOString(), end: new Date(new Date(r.end).getTime() - 86400000).toISOString() })) : recs;
    const out = await M.ingest({ ...dev, employee: { id: emp.id, department: emp.department } }, recs2);
    check('the batch is accepted', out.status === 200, out);
    const work = await prisma.activityLog.findMany({ where: { deviceId: dev.id }, select: { appName: true, durationSeconds: true, endTime: true } });
    check('the work-hours part stays in the normal records (10 minutes of Excel)', work.length === 1 && work[0].appName === 'EXCEL' && Math.abs(work[0].durationSeconds - 600) <= 2, work);
    check('nothing after work end is in the normal records', work.every((w) => new Date(w.endTime) <= at2(end)));
    const ot = await prisma.$queryRawUnsafe('SELECT * FROM "MonitoringOvertime" WHERE "deviceId" = ? ORDER BY "startTime"', dev.id);
    const apps = ot.map((r) => `${r.appName}:${r.seconds}:${r.isIdle}`);
    check('overtime kept: 20 min Excel after work, 30 min chrome, 10 min idle, 20 min Outlook before work', ot.length === 4 && apps.includes('EXCEL:1200:0') && apps.includes('chrome:1800:0') && apps.includes('Locked:600:1') && apps.includes('OUTLOOK:1200:0'), apps);
    check('the same overtime piece sent twice counts once (two chrome records at one time)', ot.filter((r) => r.appName === 'chrome').length === 1);
    check('beyond the 4-hour window nothing is kept (notepad 5 h after)', !ot.some((r) => r.appName === 'notepad'));
    check('overtime has no window title column at all', !Object.keys(ot[0] || {}).some((k) => /title/i.test(k)));
    const again = await M.ingest({ ...dev, employee: { id: emp.id, department: emp.department } }, recs2);
    const ot2 = await prisma.$queryRawUnsafe('SELECT count(*) n FROM "MonitoringOvertime" WHERE "deviceId" = ?', dev.id);
    check('the same batch again adds nothing', Number(ot2[0].n) === 4 && again.overtime === 0, [ot2[0].n, again.overtime]);

    // switched off -> nothing more
    await P.saveOtSettings({ enabled: false });
    const s1 = await M.settings();
    const out3 = await M.ingest({ ...dev, employee: { id: emp.id, department: emp.department } }, [{ appName: 'WORD', windowTitle: 'x', start: at2(mins(end, 120)).toISOString(), end: at2(mins(end, 130)).toISOString() }]);
    check('overtime switched off: nothing kept, and the agent is told 0 / 0', out3.overtime === 0 && !P.otLive(s1.overtime, s1.policyText));
    await P.saveOtSettings({ enabled: true, beforeMinutes: 60, afterMinutes: 240 });

    // --- the Overtime report
    const rep = await P.overtimeReport(useDay, useDay, { admin: true, ids: null }, '', null);
    const mine = rep.rows.find((r) => r.employeeId === emp.id);
    check('Overtime report: 70 minutes in use, 10 idle, 1 day', mine && Math.abs(mine.activeHours - 70 / 60) < 0.02 && Math.abs(mine.idleHours - 10 / 60) < 0.02 && mine.daysWithOvertime === 1, mine);
    const repP = await P.overtimeReport(useDay, useDay, { admin: false, lead: true, ids: ['someone-else'] }, '', emp.id);
    check('a team lead cannot open someone outside the team', repP.status === 403);

    // --- trends
    const tr = await P.trends({ weeks: 4 }, { admin: true, ids: null });
    check('trends: 4 weeks, a selection line and a company line', tr.weeks.length === 4 && tr.selection.length === 4 && tr.company.length === 4, tr);
    check('trends: the overtime of this week shows', tr.company[tr.company.length - (future && P.weekStart(useDay) !== P.weekStart(day) ? 2 : 1)].overtimeHoursPerPerson > 0, tr.company);
    const trp = await P.trends({ weeks: 4, employeeId: emp.id }, { admin: false, lead: true, ids: ['someone-else'] });
    check('trends: a team lead cannot pick someone outside the team', trp.status === 403);

    // --- alert rules
    check('a rule with no name is refused', (await P.saveRule({ metric: 'app_minutes', target: 'youtube', minutes: 30 })).status === 400);
    check('an app rule with no app is refused', (await P.saveRule({ name: 'x', metric: 'app_minutes', minutes: 30 })).status === 400);
    check('minutes out of range are refused', (await P.saveRule({ name: 'x', metric: 'idle_minutes', minutes: 2 })).status === 400);
    const r1 = await P.saveRule({ name: 'YouTube', metric: 'app_minutes', target: 'youtube', minutes: 20 });
    const r2 = await P.saveRule({ name: 'Late work', metric: 'overtime_minutes', minutes: 60 });
    const r3 = await P.saveRule({ name: 'After 9', metric: 'active_after', time: '00:01' });
    const r4 = await P.saveRule({ name: 'Other dept', metric: 'idle_minutes', minutes: 5, departments: ['ZZ No Such Dept'] });
    check('four rules saved', (await P.listRules()).length >= 4 && r1.rule && r2.rule && r3.rule && r4.rule);
    const mineLogs = [{ appName: 'chrome', windowTitle: 'YouTube', durationSeconds: 1500, isIdle: false, isBreak: false }];
    const hits = P.evalRules(await P.listRules(), {
      employeeId: emp.id, department: emp.department || '', day: useDay, mine: mineLogs, catOf: await M.categoryIndex(), totalsOf: M.totalsOf,
      otMinutes: await P.overtimeMinutesOn(useDay), otLast: await P.lastActiveOn(useDay), now: Date.now(),
    });
    const kinds = hits.map((h) => h.kind);
    check('YouTube 25 min over a 20-min rule rings', kinds.includes(`rule:${r1.rule.id}`), hits);
    check('70 min of overtime over a 60-min rule rings', kinds.includes(`rule:${r2.rule.id}`), hits);
    check('working after a time rings', kinds.includes(`rule:${r3.rule.id}`), hits);
    check('a rule for another department does not ring', !kinds.includes(`rule:${r4.rule.id}`));
    await P.saveRule({ ...r1.rule, enabled: false });
    const hits2 = P.evalRules(await P.listRules(), { employeeId: emp.id, department: emp.department || '', day: useDay, mine: mineLogs, catOf: await M.categoryIndex(), totalsOf: M.totalsOf, otMinutes: new Map(), otLast: new Map(), now: Date.now() });
    check('a switched-off rule does not ring', !hits2.some((h) => h.kind === `rule:${r1.rule.id}`));
    check('the alert scan runs with rules in place', Array.isArray(await require('../src/utils/monitoringAlerts').scan(Date.now())));
    await P.removeRule(r4.rule.id);
    check('a rule can be removed', !(await P.listRules()).some((r) => r.id === r4.rule.id));
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.stack || e.message}`);
  } finally {
    await prisma.$disconnect();
    try { fs.unlinkSync(COPY); } catch { /* in use */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();

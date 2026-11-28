'use strict';
// Extra salary structures (utils/salaryTemplates.js), through the API of a RUNNING SANDBOX (never live):
//   TL_API=http://localhost:4097 node -r dotenv/config scripts/salary-structures-test.js     (DATABASE_URL = the sandbox db)
// Makes its own ZZTEST people and structures and removes them again.
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const ST = require('../src/utils/salaryTemplates');
const SL = require('../src/utils/payrollSalaryLines');

const API = `${process.env.TL_API || 'http://localhost:4011'}/api`;
let pass = 0;
let fail = 0;
const ok = (id, cond, info = '') => { if (cond) { pass += 1; } else { fail += 1; console.log(`FAIL ${id} ${info}`); } };

(async () => {
  if (!/sandbox/i.test(String(process.env.DATABASE_URL || ''))) throw new Error('Refusing to run: DATABASE_URL is not a sandbox database.');
  const stamp = Date.now().toString(36);
  const mkUser = (role, tag) => prisma.user.create({
    data: {
      name: `ZZTEST Structure ${tag}`, email: `zztest-struct-${tag}-${stamp}@example.test`, passwordHash: '!zztest-no-login!', role, hrmsRole: role,
      atsRole: 'RECRUITER', accountsRole: role === 'SUPER_ADMIN' ? role : null, hrmsAccess: true, atsAccess: false, accountsAccess: role === 'SUPER_ADMIN', status: 'Active',
    },
  });
  const admin = await mkUser('SUPER_ADMIN', 'sa');
  const plainUser = await mkUser('EMPLOYEE', 'emp');
  const emp = await prisma.employee.create({ data: { employeeCode: `ZZS${stamp}`.toUpperCase(), name: 'ZZTEST Structure Person', email: `zztest-struct-p-${stamp}@example.test`, department: 'ZZTEST', employmentStatus: 'Active', dateOfJoining: new Date('2025-01-01T00:00:00Z'), userId: plainUser.id } });
  const made = [];
  const tok = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const token = tok(admin.id);
  const empToken = tok(plainUser.id);
  const call = async (method, path, body, t = token) => {
    const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };

  const DEF = {
    name: `ZZ Field ${stamp}`,
    components: [
      { name: 'Basic', kind: 'earning', calc: 'pctCtc', value: 50 },
      { name: 'HRA', kind: 'earning', calc: 'pctBasic', value: 40 },
      { name: 'Travel allowance', kind: 'earning', calc: 'fixed', value: 1600 },
      { name: 'Medical allowance', kind: 'earning', calc: 'pctCtc', value: 5 },
      { name: 'Other allowance', kind: 'earning', calc: 'rest' },
      { name: 'Insurance', kind: 'deduction', calc: 'fixed', value: 300 },
    ],
    pf: { on: true, employeePct: 12, employerPct: 12, cap: 3000 },
    gratuity: { on: false },
    pt: { on: true },
  };

  try {
    // ---- rules of a definition
    const bad = async (id, change, words) => {
      const r = await call('POST', '/payroll/structures', { ...DEF, ...change });
      ok(id, r.status === 400 && new RegExp(words, 'i').test(r.data.error || ''), JSON.stringify(r.data));
    };
    await bad('V01', { name: '' }, 'name');
    await bad('V02', { name: 'Standard' }, 'Standard');
    await bad('V03', { components: DEF.components.filter((c) => c.name !== 'Basic') }, 'Basic');
    await bad('V04', { components: DEF.components.filter((c) => c.calc !== 'rest') }, 'exactly one');
    await bad('V05', { components: [...DEF.components, { name: 'travel allowance', kind: 'earning', calc: 'fixed', value: 1 }] }, 'twice');
    await bad('V06', { components: [...DEF.components, { name: 'PF', kind: 'deduction', calc: 'fixed', value: 1 }] }, 'own setting');
    await bad('V07', { components: [...DEF.components, { name: 'Big', kind: 'earning', calc: 'pctCtc', value: 140 }] }, 'percentage');
    await bad('V08', { components: [...DEF.components, { name: 'Zero', kind: 'earning', calc: 'fixed', value: '' }] }, 'amount');

    const created = await call('POST', '/payroll/structures', DEF);
    ok('A01', created.status === 200 && created.data.id, JSON.stringify(created.data));
    const id = created.data.id; made.push(id);
    const dup = await call('POST', '/payroll/structures', { ...DEF, name: DEF.name.toUpperCase() });
    ok('A02', dup.status === 409, JSON.stringify(dup.data));

    // ---- preview: CTC 25,000 -> basic 12,500, HRA 5,000, travel 1,600, medical 1,250, PF 1,500, rest 3,150
    const pv = await call('POST', '/payroll/structures/preview', { structureId: id, monthlyCtc: 25000 });
    const b = pv.data.breakup || {};
    ok('P01', b.basic === 12500 && b.hra === 5000 && b.employerPf === 1500 && b.employeePf === 1500 && b.gratuity === 0, JSON.stringify(b));
    ok('P02', b.special === 1600 + 1250 + (25000 - 12500 - 5000 - 1600 - 1250 - 1500), `${b.special}`);
    ok('P03', b.gross === 23500 && b.professionalTax === 200 && b.otherDeductions === 300 && b.net === 23500 - 1500 - 200 - 300, JSON.stringify([b.gross, b.net]));
    ok('P04', b.ctcCheck === 25000 && b.lines.earnings.map((x) => x.label).join('|') === 'Basic|HRA|Travel allowance|Medical allowance|Other allowance', JSON.stringify(b.lines));
    const small = await call('POST', '/payroll/structures/preview', { structureId: id, monthlyCtc: 2000 });
    ok('P05', !!small.data.error, JSON.stringify(small.data.error));

    // ---- permissions: a plain employee
    ok('R01', (await call('GET', '/payroll/structures', null, empToken)).status === 403);
    ok('R02', (await call('POST', '/payroll/structures', { ...DEF, name: 'ZZ nope' }, empToken)).status === 403);
    ok('R03', (await call('DELETE', `/payroll/structures/${id}`, null, empToken)).status === 403);

    // ---- put the person on it
    const tooSmall = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 2000, structureId: id, effectiveFrom: '2026-11' });
    ok('E01', tooSmall.status === 400, JSON.stringify(tooSmall.data));
    const typed = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 25000, structureId: id, effectiveFrom: '2026-11', components: { basic: 1 } });
    ok('E02', typed.status === 400, JSON.stringify(typed.data));
    const set = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 25000, structureId: id, effectiveFrom: '2026-11', otherDeductions: 100 });
    ok('E03', set.status === 200, JSON.stringify(set.data));
    const v1 = set.data.version || {};
    ok('E04', v1.basic === 12500 && v1.hra === 5000 && v1.specialAllowance === 6000 && v1.bonus === 0 && v1.conveyance === 0 && v1.employeePf === 1500 && v1.otherDeductions === 400, JSON.stringify(v1));
    ok('E05', set.data.breakup.structureName === DEF.name, JSON.stringify(set.data.breakup));
    const one = await call('GET', `/payroll/structure/${emp.id}`);
    ok('E06', one.data.custom && one.data.custom.structureId === id && one.data.custom.extraOther === 100, JSON.stringify(one.data.custom));
    const mine = await call('GET', '/payroll/my-structure', null, empToken);
    ok('E07', mine.data.breakup && mine.data.breakup.lines.earnings.length === 5 && mine.data.breakup.lines.deductions[0].label === 'Insurance', JSON.stringify(mine.data.breakup));
    const list = await call('GET', '/payroll/structures');
    ok('E08', list.data.structures.find((x) => x.id === id).usedBy === 1, JSON.stringify(list.data.structures));

    // saving again without choosing a structure keeps it; the extra deduction is not doubled
    const again = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 30000, effectiveFrom: '2026-11' });
    ok('E09', again.status === 200 && again.data.version.basic === 15000 && again.data.version.otherDeductions === 400, JSON.stringify(again.data.version));
    await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 25000, effectiveFrom: '2026-11' });

    // ---- editing the structure changes no saved salary
    const edited = await call('PUT', `/payroll/structures/${id}`, { ...DEF, components: DEF.components.map((c) => (c.name === 'Basic' ? { ...c, value: 60 } : c)).filter((c) => c.name !== 'Medical allowance') });
    ok('M01', edited.status === 200 && edited.data.components.length === 5, JSON.stringify(edited.data));
    const after = await call('GET', `/payroll/structure/${emp.id}`);
    ok('M02', after.data.structure.basic === 12500 && after.data.breakup.lines.earnings.length === 5, JSON.stringify(after.data.breakup));
    // ... but a save with no new CTC keeps the saved parts, and a new CTC uses the structure as it is now
    const keep = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', effectiveFrom: '2026-11', tds: 50 });
    ok('M03', keep.status === 200 && keep.data.version.basic === 12500 && keep.data.version.tds === 50 && keep.data.version.otherDeductions === 400, JSON.stringify(keep.data.version));
    const next = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 25000, effectiveFrom: '2026-12', tds: 0 });
    ok('M04', next.status === 200 && next.data.version.basic === 15000 && next.data.breakup.lines.earnings.length === 4, JSON.stringify(next.data.version));
    const jan = (await call('GET', `/payroll/structure/${emp.id}`)).data.versions.find((x) => x.effectiveFrom === '2026-11-01');
    ok('M05', jan.breakup.lines.earnings.length === 5 && jan.basic === 12500, JSON.stringify(jan.breakup));

    // ---- payroll: calculate a month on it, the Details lines carry the names and add up
    const E = require('../src/utils/payrollEngine');
    await prisma.payrollAttendance.create({ data: { employeeId: emp.id, month: '2026-11', year: 2026, monthNum: 11, workingDays: 31, daysPresent: 28, daysLop: 3, reason: 'ZZTEST', overriddenByName: 'ZZTEST', overriddenAt: new Date() } });
    await E.calculateMonth({ month: '2026-11', employeeIds: [emp.id], actor: { id: admin.id, name: admin.name } });
    const run = await prisma.employeePayrollRun.findFirst({ where: { employeeId: emp.id, month: '2026-11' } });
    ok('C01', !!run && run.basic === 12500 && run.specialAllowance === 6000 && run.grossPay === 23500, JSON.stringify(run));
    if (run) {
      const det = await call('GET', `/payroll/entries/${run.id}`);
      const lines = det.data.lines || {};
      const labels = (lines.earnings || []).map((x) => x.label);
      ok('C02', ['Basic', 'HRA', 'Travel allowance', 'Medical allowance', 'Other allowance'].every((l) => labels.includes(l)), JSON.stringify(labels));
      const sum = (k) => Math.round((lines.earnings || []).reduce((n, x) => n + x[k], 0) * 100) / 100;
      ok('C03', sum('full') === run.grossPay && sum('cut') === run.lopDeduction && sum('earned') === run.earnedGross && lines.addsUp === true, JSON.stringify([sum('full'), sum('cut'), sum('earned'), run.grossPay, run.lopDeduction, run.earnedGross]));
      ok('C04', (lines.deductions || []).some((x) => x.label === 'Insurance' && x.amount === 300) && lines.deductions.some((x) => x.label === 'Other deductions' && x.amount === 100), JSON.stringify(lines.deductions));
      // the payslip an employee sees right after Calculate
      const slips = await call('GET', '/payroll?month=2026-11', null, empToken);
      const slip = Array.isArray(slips.data) ? slips.data.find((x) => x.month === '2026-11') : null;
      if (slip) {
        const p = await call('GET', `/payroll/payslips/${slip.id}`, null, empToken);
        const names = (p.data.earnings || []).map((x) => x.label);
        ok('C05', names.includes('Travel allowance') && (p.data.deductions || []).some((x) => x.label === 'Insurance'), JSON.stringify(p.data));
      } else console.log('note: no own payslip listed for the test month (the pay period has not ended) - payslip names checked below');
      // a figure typed by hand: the names give way to the standard labels instead of showing a wrong split
      const typedOver = SL.salaryLines({ ...run, specialAllowance: run.specialAllowance + 10 }, { note: await ST.linesOf(run.salaryVersionId) });
      ok('C06', typedOver.earnings.some((x) => x.label === 'Special allowance') && !typedOver.earnings.some((x) => x.label === 'Travel allowance'), JSON.stringify(typedOver.earnings));
    }

    // ---- delete the structure: saved salaries stay, the editor can still save on its own copy
    const del = await call('DELETE', `/payroll/structures/${id}`);
    ok('D01', del.status === 200, JSON.stringify(del.data));
    const stays = await call('GET', `/payroll/structure/${emp.id}`);
    ok('D02', stays.data.structure.basic === 15000 && stays.data.custom.structureName === DEF.name && stays.data.breakup.lines.earnings.length === 4, JSON.stringify(stays.data.custom));
    const resave = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 40000, effectiveFrom: '2026-12' });
    ok('D03', resave.status === 200 && resave.data.version.basic === 24000, JSON.stringify(resave.data));
    const gone = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 25000, structureId: 'st_nothere', effectiveFrom: '2026-12' });
    ok('D04', gone.status === 400, JSON.stringify(gone.data));

    // ---- the Excel import keeps a person on their structure (here one that was deleted: the saved copy is used)
    const IO = require('../src/io/payroll-salary');
    const me = await prisma.user.findUnique({ where: { id: admin.id } });
    const ctx = { req: { user: me, query: {}, body: {} }, user: me };
    const exported = (await IO.exportRows(ctx, { employeeIds: [emp.id], filters: { employeeId: emp.id, current: '1' } })).map((r, i) => ({ ...r, line: i + 2 }));
    const same = await IO.validate(exported, ctx);
    ok('I01', same.length === 1 && same[0].action === 'nochange', JSON.stringify(same));
    const more = await IO.validate([{ ...exported[0], monthlyCtc: 30000 }], ctx);
    ok('I02', more[0].action === 'update' && more[0].changes.some((c) => c.field === 'Basic' && Number(c.to) === 18000), JSON.stringify(more));
    const wrote = await IO.apply(more, ctx);
    const dec = await prisma.salaryStructureVersion.findFirst({ where: { employeeId: emp.id, effectiveFrom: '2026-12-01' } });
    const decNote = await ST.linesOf(dec.id);
    ok('I03', wrote.updated === 1 && dec.basic === 18000 && dec.otherDeductions === 400 && ST.matches(decNote, dec), JSON.stringify([wrote, dec.basic, dec.otherDeductions]));
    const bonusTyped = await IO.validate([{ ...exported[0], monthlyCtc: 30000, bonus: 500 }], ctx);
    ok('I04', bonusTyped[0].action === 'error' && /bonus/i.test(JSON.stringify(bonusTyped[0].errors)), JSON.stringify(bonusTyped));

    // ---- back to the Standard Package
    const std = await call('PUT', `/payroll/structure/${emp.id}`, { payMode: 'Package', monthlyCtc: 25000, structureId: 'standard', effectiveFrom: '2026-12', bonus: 1000, components: {} });
    const sv = std.data.version || {};
    ok('S01', std.status === 200 && sv.basic === 10000 && sv.hra === 4000 && sv.bonus === 1000 && sv.conveyance === 0 && sv.otherDeductions === 100, JSON.stringify(sv)); // the typed extra stays, the structure's own deduction goes
    ok('S02', std.data.breakup && !std.data.breakup.lines, JSON.stringify(std.data.breakup));
    ok('S03', (await ST.linesOf(sv.id)) === null);
  } finally {
    const versions = await prisma.salaryStructureVersion.findMany({ where: { employeeId: emp.id }, select: { id: true } });
    for (const v of versions) await ST.setLines(v.id, null); // eslint-disable-line no-await-in-loop
    for (const t of made) await ST.remove(t); // eslint-disable-line no-await-in-loop
    await prisma.employeePayrollRun.deleteMany({ where: { employeeId: emp.id } });
    await prisma.payrollAttendance.deleteMany({ where: { employeeId: emp.id } });
    await prisma.payslip.deleteMany({ where: { employeeId: emp.id } });
    await prisma.salaryStructure.deleteMany({ where: { employeeId: emp.id } });
    await prisma.salaryStructureVersion.deleteMany({ where: { employeeId: emp.id } });
    await prisma.employee.delete({ where: { id: emp.id } }).catch((e) => console.log('cleanup', e.message.split('\n').pop()));
    for (const u of [admin, plainUser]) await prisma.user.delete({ where: { id: u.id } }).catch(() => {}); // eslint-disable-line no-await-in-loop
    await prisma.$disconnect();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

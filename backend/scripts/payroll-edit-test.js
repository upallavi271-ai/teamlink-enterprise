#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYROLL EDIT AND RECALCULATE TEST (item 5, 2026-10-13) - SANDBOX ONLY.
//   node scripts/payroll-edit-test.js     (needs the sandbox API on :4011 and prisma/sandbox.db)
// ZZTEST users / employees / months 2031-04..2031-07 only; every row it makes is removed at the end.
// Refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB)) { console.error('No prisma/sandbox.db - start the sandbox first.'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const API = 'http://localhost:4011/api';
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const { payrollCalc } = require('../src/utils/payrollCalc');
const E = require('../src/utils/payrollEngine');
const PEdit = require('../src/utils/payrollEdit');
const { monthlyPayrollTotals } = require('../src/utils/payrollTotals');

let pass = 0; let fail = 0;
const ok = (c, name, extra) => { if (c) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''}`); } };
const tok = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function http(uid, method, url, body) {
  // the sandbox restarts whenever anybody edits backend/src: retry a dropped connection for ~60 s
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${tok(uid)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      // the sandbox shares one SQLite file with other agents' tests: a 500 "Something went wrong" is a DB timeout (nothing was written) - try again
      if (r.status === 500 && i < 8 && json && json.error === 'Something went wrong') { await new Promise((res) => setTimeout(res, 3000)); continue; }
      return { status: r.status, body: json, text };
    } catch (e) { if (i === 19) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  return null;
}
const S = {};
const M_PAID = '2031-04'; const M_OPEN = '2031-05'; const M_IMPORTED = '2031-03'; const M_APPROVED = '2031-07';
const MONTHS = [M_IMPORTED, M_PAID, M_OPEN, M_APPROVED, '2031-06'];

async function mkUser(role, tag, extra = {}) {
  return prisma.user.create({
    data: {
      name: `ZZTEST PE ${tag}`, email: `zztest.pe-${tag.toLowerCase()}@example.test`, passwordHash: '!zztest-no-login!',
      role, hrmsRole: role, atsRole: ['HR', 'TL'].includes(role) ? role : 'RECRUITER', accountsRole: ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'].includes(role) ? role : null,
      hrmsAccess: true, atsAccess: false, accountsAccess: ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'].includes(role), status: 'Active', ...extra,
    },
  });
}
const ver = (employeeId, o) => prisma.salaryStructureVersion.create({ data: { employeeId, effectiveFrom: '2031-01-01', payMode: 'Package', ctc: 300000, ...o } });
const rowOf = (employeeId, month, status, o = {}) => prisma.employeePayrollRun.create({
  data: {
    employeeId, month, year: 2031, monthNum: Number(month.slice(5)), status, workingDays: 26, daysPresent: 26, basic: 10000, hra: 4000, bonus: 1000, specialAllowance: 8319,
    grossPay: 23319, earnedGross: 23319, pfEmployee: 1200, professionalTax: 200, totalDeductions: 1400, netPay: 21919, pfEmployer: 1200, gratuity: 481, ...o,
  },
});

// the client-side preview: the SAME calc on the editor payload
function clientTotals(p, over = {}) {
  const c = p.components;
  const comps = {
    workingDays: c.workingDays, daysLop: c.daysLop, basic: c.basic, hra: c.hra, conveyance: c.conveyance, specialAllowance: c.specialAllowance, bonus: c.bonus, incentive: c.incentive,
    arrears: c.arrears, stipend: c.stipend, loan: c.loan, otherDeductions: c.otherDeductions, pfEmployee: c.pfEmployee, esiEmployee: c.esiEmployee, professionalTax: c.professionalTax,
    tds: c.tds, lopDeduction: c.lopDeduction, pfEmployer: c.pfEmployer, esiEmployer: c.esiEmployer, gratuity: c.gratuity,
    manual: over.manual || c.manual, extraEarn: (over.earnings || c.earnings).map((x) => x.amount), extraDed: (over.deductions || c.deductions).map((x) => x.amount), ...over.fields,
  };
  const res = payrollCalc(comps, p.rules);
  return { grossPay: res.grossPay, totalDeductions: res.totalDeductions, netPay: res.netPay, ctc: res.ctc, res };
}
const saveBody = (p, fields, extra = {}) => {
  const t = clientTotals(p, { fields, earnings: extra.earnings, deductions: extra.deductions });
  return { fields, reason: 'ZZTEST attendance correction', totals: { grossPay: t.grossPay, totalDeductions: t.totalDeductions, netPay: t.netPay, ctc: t.ctc }, manual: extra.manual || p.components.manual, earnings: extra.earnings || p.components.earnings.filter((x) => !x.adj), deductions: extra.deductions || p.components.deductions.filter((x) => !x.adj), ...extra.body };
};

async function setup() {
  S.sa = (await mkUser('SUPER_ADMIN', 'SA')).id;
  S.admin = (await mkUser('ADMIN', 'ADMIN')).id;
  S.hr = (await mkUser('HR', 'HR')).id;
  S.acct = (await mkUser('ACCOUNTANT', 'ACCT')).id;
  S.mgr = (await mkUser('MANAGER', 'MGR')).id;
  S.tl = (await mkUser('TL', 'TL')).id;
  const empUser = await mkUser('EMPLOYEE', 'EMP');
  S.empUser = empUser.id;
  const mkEmp = (n, extra) => prisma.employee.create({ data: { employeeCode: `ZZTEST-PE-${n}`, name: `ZZTEST PE Emp ${n}`, email: `zztest.pe-e${n}@example.test`, department: 'ZZTEST', ...extra } });
  const e1 = await mkEmp(1, { userId: empUser.id });
  const e2 = await mkEmp(2); const e3 = await mkEmp(3);
  S.e1 = e1.id; S.e2 = e2.id; S.e3 = e3.id; S.emps = [e1.id, e2.id, e3.id];
  await ver(e1.id, { basic: 10000, hra: 4000, bonus: 1000, specialAllowance: 8319, employeePf: 1200, employerPf: 1200, gratuity: 481, professionalTax: 200 });
  await ver(e2.id, { basic: 8000, hra: 3200, bonus: 1000, specialAllowance: 6800, employeePf: 960, employerPf: 960, gratuity: 385, professionalTax: 150 });
  await ver(e3.id, { basic: 10000, hra: 4000, bonus: 1000, specialAllowance: 8319, employeePf: 1200, employerPf: 1200, gratuity: 481, professionalTax: 200 });
  // history months made straight in the database (the real months are never touched)
  await rowOf(e1.id, M_PAID, 'PAID', { paidBy: 'ZZTEST', paidAt: new Date() });
  await rowOf(e1.id, M_IMPORTED, 'PAID', { importNote: 'ZZTEST import', importedBreakup: '{}', attendanceSource: 'OVERRIDE' });
  await rowOf(e2.id, M_PAID, 'PAID', { paidBy: 'ZZTEST', paidAt: new Date(), basic: 8000, hra: 3200, bonus: 1000, specialAllowance: 6800, grossPay: 19000, earnedGross: 19000, netPay: 17890, totalDeductions: 1110, pfEmployee: 960, professionalTax: 150 });
  await rowOf(e3.id, M_APPROVED, 'APPROVED', { approvedBy: 'ZZTEST', approvedAt: new Date() });
}

async function main() {
  await setup();
  console.log('--- calculate the open month (HR)');
  const calc = await http(S.hr, 'POST', '/payroll/calculate', { month: M_OPEN, employeeIds: [S.e1, S.e3] });
  ok(calc.status === 201 && calc.body.created === 2, 'T01 HR calculates two Draft records', calc.body && { s: calc.status, c: calc.body.created, e: calc.body.error });
  const ent = (id) => prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: id, month: M_OPEN } } });
  let e1r = await ent(S.e1);
  ok(e1r && e1r.grossPay === 23319 && e1r.netPay === 21919 && e1r.status === 'DRAFT', 'T02 the engine row is the CTC 25,000 record (gross 23,319 / net 21,919)', e1r && { g: e1r.grossPay, n: e1r.netPay });

  console.log('--- the editor');
  let ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  ok(ed.status === 200 && ed.body.canEdit && !ed.body.lock && ed.body.rules && ed.body.components.basic === 10000, 'T03 HR opens the editor: canEdit, no lock, rules + components', ed.body && { s: ed.status, lock: ed.body.lock });
  ok(ed.body.drift.length === 0, 'T04 a freshly calculated record has no hand-typed lines (the rules reproduce every stored figure)', ed.body.drift);
  const ct0 = clientTotals(ed.body);
  ok(ct0.grossPay === e1r.grossPay && ct0.totalDeductions === e1r.totalDeductions && ct0.netPay === e1r.netPay && ct0.ctc === 25000, 'T05 the shared calc on the stored components gives the stored totals + CTC 25,000', ct0);

  console.log('--- save: recompute + persist');
  let body = saveBody(ed.body, { basic: 12000, specialAllowance: 6319 });
  let sv = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, body);
  e1r = await ent(S.e1);
  ok(sv.status === 200 && e1r.basic === 12000 && e1r.pfEmployee === 1440 && e1r.grossPay === 23319 && e1r.totalDeductions === 1440 + 200 && e1r.netPay === 23319 - 1640, 'T06 Basic 10,000 -> 12,000: PF recomputed to 1,440, totals saved', e1r && { s: sv.status, err: sv.body && sv.body.error, pf: e1r.pfEmployee, net: e1r.netPay });
  ok(sv.body.after.ctc === 23319 + 1440 + 481 - 481 + 0 || sv.body.after.ctc === e1r.earnedGross + e1r.pfEmployer + e1r.esiEmployer + e1r.gratuity, 'T07 CTC in the answer = earned gross + employer PF + ESI + gratuity', sv.body.after);
  ok(sv.body.before.netPay === 21919 && sv.body.after.netPay === e1r.netPay, 'T08 the answer carries Before -> After', sv.body.before);
  const run = await prisma.payrollRun.findUnique({ where: { month: M_OPEN } });
  ok(run && run.totalNet === (await prisma.employeePayrollRun.findMany({ where: { month: M_OPEN } })).reduce((n, x) => n + x.netPay, 0), 'T09 the run totals were recomputed after the edit', run && run.totalNet);

  console.log('--- tampering and bad input');
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const bad = saveBody(ed.body, { hra: 5000 }); bad.totals.netPay += 1000;
  const tam = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, bad);
  ok(tam.status === 422 && tam.body.code === 'TOTALS_MISMATCH' && (await ent(S.e1)).hra === 4000, 'T10 totals that do not match the server calc are REJECTED and nothing is saved', tam.body);
  const noTot = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, { fields: { hra: 5000 }, reason: 'ZZTEST x' });
  ok(noTot.status === 400, 'T11 a payload without totals is refused', noTot.body);
  const noReason = saveBody(ed.body, { hra: 5000 }); noReason.reason = '';
  ok((await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, noReason)).status === 400, 'T12 a save without a reason is refused');
  const neg = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, { ...saveBody(ed.body, { hra: -5 }), totals: { grossPay: 1, totalDeductions: 1, netPay: 1, ctc: 1 } });
  ok(neg.status === 422, 'T13 a negative amount is refused', neg.body);
  const negNet = saveBody(ed.body, {}, { deductions: [{ label: 'ZZTEST recovery', amount: 90000 }] });
  const nn = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, negNet);
  ok(nn.status === 422 && /below 0/.test(nn.body.error), 'T14 negative net pay is refused without a reason', nn.body);
  const lopBig = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, { ...saveBody(ed.body, {}), fields: { daysLop: 40 } });
  ok(lopBig.status >= 400 && lopBig.status < 500, 'T15 LOP days above the working days refused', lopBig.status);
  const same = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, saveBody(ed.body, {}));
  ok(same.status === 400 && /Nothing/.test(same.body.error), 'T16 saving with no change says nothing changed', same.body);

  console.log('--- rows, days, manual lines');
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const rows = { earnings: [{ label: 'ZZTEST spot award', amount: 1500 }], deductions: [{ label: 'ZZTEST canteen', amount: 300 }] };
  const b2 = saveBody(ed.body, { daysLop: 2, loan: 500 }, { ...rows, manual: { ...ed.body.components.manual, professionalTax: true }, body: { allowNegative: false } });
  b2.fields.professionalTax = 0;
  b2.totals = (() => { const t = clientTotals(ed.body, { fields: { daysLop: 2, loan: 500, professionalTax: 0 }, manual: { professionalTax: true }, ...rows }); b2.manual = { professionalTax: true }; return { grossPay: t.grossPay, totalDeductions: t.totalDeductions, netPay: t.netPay, ctc: t.ctc }; })();
  const sv2 = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, b2);
  e1r = await ent(S.e1);
  ok(sv2.status === 200 && e1r.daysLop === 2 && e1r.lopDeduction === Math.round(23319 * 2 / e1r.workingDays) && e1r.arrears === 1500 && e1r.otherDeductions === 800 && e1r.professionalTax === 0 && e1r.grossPay === 23319 + 1500, 'T17 days (LOP 2) recompute the LOP amount with the engine formula; added rows land in Other earnings / Other deductions; typed PT 0 kept', sv2.body && { s: sv2.status, err: sv2.body.error, row: e1r && { lop: e1r.lopDeduction, arr: e1r.arrears, od: e1r.otherDeductions, pt: e1r.professionalTax, g: e1r.grossPay } });
  const st = await PEdit.readState(e1r.id);
  ok(st.edited && st.manual.professionalTax && st.loan === 500 && st.extras.earnings.length === 1, 'T18 the edit state keeps the manual flag, loan and rows', st);
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  ok(ed.body.components.manual.professionalTax === true && ed.body.components.loan === 500 && ed.body.components.daysLop === 2, 'T19 reopening the editor shows the kept values (manual PT with pencil flag)', ed.body.components.manual);

  console.log('--- audit + history');
  const fieldRows = await prisma.auditLog.findMany({ where: { entityId: e1r.id, entity: 'PayrollEditField' } });
  const sums = await prisma.auditLog.findMany({ where: { entityId: e1r.id, entity: 'EmployeePayrollRun', action: { contains: 'edited' } } });
  ok(fieldRows.some((r) => r.field === 'basic' && r.fromValue === '10000' && r.toValue === '12000' && r.reason && r.actorName && /IP/.test(r.fieldLabel || '')), 'T20 one audit row per changed field (field, old -> new, reason, who, IP)', fieldRows.slice(0, 2));
  ok(fieldRows.some((r) => r.field === 'daysLop') && fieldRows.some((r) => r.field === 'loan') && fieldRows.some((r) => /earn:/.test(r.field)), 'T21 days, loan and added rows are audited too', fieldRows.map((r) => r.field));
  ok(sums.length === 2 && /Gross \d+ \| Deductions \d+ \| Net \d+ \| CTC \d+/.test(sums[0].fromValue) && /Net/.test(sums[0].toValue), 'T22 a summary row per save with before / after Gross, Deductions, Net, CTC', sums.map((s) => s.toValue));
  const hist = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/history`);
  ok(hist.status === 200 && hist.body.versions.length === 3 && hist.body.versions[0].kind === 'calculated' && hist.body.versions[2].after.totals.netPay === e1r.netPay, 'T23 history: versions 0 (as calculated), 1, 2 with who / when / why and the figures of each', hist.body.versions && hist.body.versions.map((v) => v.n));
  ok(hist.body.versions[1].changes.some((c) => c.field === 'basic') && hist.body.versions[1].before.totals.netPay === 21919, 'T24 each version lists its changes and the before totals ("View as of" compare)', null);

  console.log('--- who may edit');
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const probe = saveBody(ed.body, { hra: 4500 });
  const tryPut = async (uid, label, code) => {
    const r = await http(uid, 'PUT', `/payroll/entries/${e1r.id}/edit`, probe);
    // (a sandbox restart can drop the answer of a save that DID happen; the retry then says "Nothing was changed")
    const dup = code === 200 && r.status === 400 && /Nothing/.test((r.body || {}).error || '') && (await ent(S.e1)).hra === 4500;
    ok(r.status === code || dup, `T25 ${label}: ${code}`, r.body); return r;
  };
  await tryPut(S.mgr, 'Manager cannot edit', 403);
  await tryPut(S.tl, 'TL cannot edit', 403);
  await tryPut(S.empUser, 'an employee cannot edit', 403);
  const viewMgr = await http(S.mgr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  // (permissions.js no longer gives Manager / AM the Payroll 'export' read grant as of 2026-10-13: then the board is closed to them = 403; with the grant it is read only)
  ok((viewMgr.status === 200 && viewMgr.body.canEdit === false) || viewMgr.status === 403, 'T26 Manager never gets an editable editor (read only, or no access at all)', { s: viewMgr.status, canEdit: viewMgr.body && viewMgr.body.canEdit });
  ok((await http(S.tl, 'GET', `/payroll/entries/${e1r.id}/edit`)).status === 403, 'T27 TL cannot even read it');
  await tryPut(S.acct, 'Accountant can edit', 200);
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const probe2 = saveBody(ed.body, { hra: 4400 });
  const adm = await http(S.admin, 'PUT', `/payroll/entries/${e1r.id}/edit`, probe2);
  // (a sandbox restart can drop the answer of a save that DID happen; the retry then says "Nothing was changed")
  ok(adm.status === 200 || (adm.status === 400 && /Nothing/.test(adm.body.error) && (await ent(S.e1)).hra === 4400), 'T25 Admin can edit: 200', adm.body);
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const dbl = saveBody(ed.body, { hra: 4450 });
  const both = await Promise.all([http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, dbl), http(S.acct, 'PUT', `/payroll/entries/${e1r.id}/edit`, dbl)]);
  const hist4 = await PEdit.readState(e1r.id);
  ok(both.filter((r) => r.status === 200).length === 1 && both.some((r) => r.status === 409 || r.status === 400), 'T25b two identical saves at the same moment: one wins, the other is refused (no double version)', both.map((r) => r.status));
  ok(hist4.versions.filter((v) => v.changes && v.changes.some((c) => c.field === 'hra' && c.new === 4450)).length === 1, 'T25c only one version carries the 4,450 change', null);
  ok((await http(S.mgr, 'POST', `/payroll/entries/${e1r.id}/edit/recalc`, { apply: true })).status === 403, 'T28 Manager cannot recalculate from attendance');
  ok((await http(S.mgr, 'POST', '/payroll/adjustments', { employeeId: S.e1, sourceMonth: M_PAID, kind: 'ARREARS', amount: 100, reason: 'ZZTEST' })).status === 403, 'T29 Manager cannot add an adjustment');

  console.log('--- recalculate from attendance');
  const cmp = await http(S.hr, 'POST', `/payroll/entries/${e1r.id}/edit/recalc`, {});
  ok(cmp.status === 200 && !cmp.body.same && cmp.body.changes.length > 0 && cmp.body.after.netPay === 21919, 'T30 "Recalculate from attendance" first SHOWS what would change (engine net 21,919)', cmp.body);
  const calcSkip = await http(S.hr, 'POST', '/payroll/calculate', { month: M_OPEN, employeeIds: [S.e1, S.e3] });
  ok(calcSkip.status === 201 && calcSkip.body.edited.length === 1 && (await ent(S.e1)).hra === 4450, 'T31 a normal "Recalculate drafts" leaves an EDITED record alone and reports it', calcSkip.body.edited);
  const ap0 = await http(S.hr, 'POST', `/payroll/entries/${e1r.id}/edit/recalc`, { apply: true, reason: 'ZZTEST back to attendance' });
  e1r = await ent(S.e1);
  ok(ap0.status === 200 && e1r.grossPay === 23319 && e1r.netPay === 21919 && e1r.basic === 10000 && e1r.arrears === 0 && e1r.otherDeductions === 0, 'T32 applying it resets to the engine numbers (and clears typed lines / rows)', e1r && { net: e1r.netPay });
  const st2 = await PEdit.readState(e1r.id);
  ok(!st2.edited && st2.versions[st2.versions.length - 1].kind === 'recalculated' && st2.editors.length >= 3, 'T33 the reset is a version too; the editors stay recorded for maker-checker', { kinds: st2.versions.map((v) => `${v.kind}:${v.byName}:${(v.changes || []).map((c) => c.field + '=' + c.new).join(',')}`), editors: st2.editors.length });

  console.log('--- maker-checker, pending edits, approve');
  ed = await http(S.admin, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const adminEdit = await http(S.admin, 'PUT', `/payroll/entries/${e1r.id}/edit`, saveBody(ed.body, { bonus: 1500 }));
  ok(adminEdit.status === 200, 'T34 Admin edits the draft', adminEdit.body);
  const sub = await http(S.hr, 'POST', '/payroll/entries/submit', { month: M_OPEN });
  ok(sub.status === 200, 'T35 the draft records are submitted (an edited record passes the stale checks)', sub.body);
  const own = await http(S.admin, 'POST', '/payroll/entries/approve', { ids: [e1r.id] });
  ok(own.status === 403 && /another approver/i.test(JSON.stringify(own.body)), 'T36 maker-checker: the editor cannot approve the same record', own.body);
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const pendEdit = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, saveBody(ed.body, { bonus: 1000 }));
  ok(pendEdit.status === 200 && (await ent(S.e1)).status === 'DRAFT', 'T37 editing a record under review sends it back to Draft', pendEdit.body && pendEdit.body.status);
  for (let i = 0; i < 4; i += 1) { // (retried if the sandbox was restarted by somebody's edit in the middle)
    await http(S.hr, 'POST', '/payroll/entries/submit', { month: M_OPEN });
    const pend = await prisma.employeePayrollRun.count({ where: { month: M_OPEN, employeeId: { in: [S.e1, S.e3] }, status: 'PENDING_APPROVAL' } });
    if (pend === 2) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  const chg = await http(S.sa, 'GET', `/payroll/runs/${M_OPEN}/changes`);
  ok(chg.status === 200 && chg.body.rows.length === 1 && chg.body.rows[0].employeeCode === 'ZZTEST-PE-1' && chg.body.totals.employees === 1 && chg.body.rows[0].changes.length > 0 && chg.body.rows[0].delta, 'T38 "Changes in this run" lists the edited employee with deltas and totals', chg.body);
  ok((await http(S.tl, 'GET', `/payroll/runs/${M_OPEN}/changes`)).status === 403, 'T39 TL cannot see the changes list');
  const apSa = await http(S.sa, 'POST', '/payroll/entries/approve', { month: M_OPEN });
  // (a sandbox restart caused by another agent's edit can drop the answer; then the retry finds them already approved)
  const apDone = (await prisma.employeePayrollRun.findMany({ where: { month: M_OPEN, employeeId: { in: [S.e1, S.e3] } } })).every((x) => ['APPROVED', 'SYNCED_TO_ACCOUNTS'].includes(x.status));
  ok((apSa.status === 200 && apSa.body.ok === 2) || apDone, 'T40 another approver (Super Admin) approves both records', apSa.body);
  const st3 = await PEdit.readState(e1r.id);
  ok(st3.editors.includes(S.sa) === false, 'T41 the approver is not among the editors', null);

  console.log('--- locked months');
  e1r = await ent(S.e1);
  ok(['SYNCED_TO_ACCOUNTS', 'APPROVED'].includes(e1r.status), 'T42 the month is Approved / Posted now', e1r.status);
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  ok(ed.body.lock && !ed.body.canEdit && /(Approved|posted)/i.test(ed.body.lock.message), 'T43 the editor says why it is locked in plain words', ed.body.lock);
  const lockedPut = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, saveBody(ed.body, { hra: 4600 }));
  ok(lockedPut.status === 409 && (await ent(S.e1)).hra === 4000, 'T44 the server refuses an edit of a posted / approved month', lockedPut.body);
  const e3a = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: S.e3, month: M_APPROVED } } });
  const edA = await http(S.hr, 'GET', `/payroll/entries/${e3a.id}/edit`);
  ok(edA.body.lock && edA.body.lock.code === 'APPROVED' && /Ask the Super Admin to reopen/.test(edA.body.lock.message), 'T45 Approved month: "Ask the Super Admin to reopen it."', edA.body.lock);
  ok((await http(S.hr, 'PUT', `/payroll/entries/${e3a.id}/edit`, saveBody(edA.body, { hra: 4600 }))).status === 409, 'T46 Approved month cannot be edited');
  const pd = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: S.e1, month: M_PAID } } });
  const edP = await http(S.sa, 'GET', `/payroll/entries/${pd.id}/edit`);
  ok(edP.body.lock && edP.body.lock.code === 'PAID' && (await http(S.sa, 'PUT', `/payroll/entries/${pd.id}/edit`, saveBody(edP.body, { hra: 4600 }))).status === 409, 'T47 a Paid month cannot be edited in place - not even by the Super Admin', edP.body.lock);
  const im = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: S.e1, month: M_IMPORTED } } });
  const edI = await http(S.sa, 'GET', `/payroll/entries/${im.id}/edit`);
  ok(edI.body.lock && edI.body.lock.code === 'IMPORTED' && (await http(S.sa, 'PUT', `/payroll/entries/${im.id}/edit`, saveBody(edI.body, { hra: 4600 }))).status === 409, 'T48 an imported pay-register month is read-only', edI.body.lock);
  ok((await http(S.sa, 'POST', `/payroll/entries/${pd.id}/edit/recalc`, { apply: true })).status === 409, 'T49 "Recalculate from attendance" is refused on a Paid month too');

  console.log('--- reports, payslip, voucher read the edited numbers');
  const rep = await http(S.sa, 'GET', `/payroll/reports/compliance?month=${M_OPEN}&includeDraft=1`);
  const repRow = rep.body && rep.body.rows ? rep.body.rows.find((r) => r.employeeCode === 'ZZTEST-PE-1') : null;
  e1r = await ent(S.e1);
  ok(repRow && repRow.pfEmployee === e1r.pfEmployee && repRow.earnedGross === e1r.earnedGross, 'T50 the compliance (PF / ESI / PT) report reads the stored (edited) record', repRow);
  const tot = await monthlyPayrollTotals(M_OPEN, { statuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'] });
  const all = await prisma.employeePayrollRun.findMany({ where: { month: M_OPEN } });
  ok(tot.net === all.reduce((n, x) => n + x.netPay, 0) && tot.grossPay === all.reduce((n, x) => n + x.grossPay, 0), 'T51 the month totals (Accounts payroll rows) are the sums of the stored records', tot);
  let md = await http(S.sa, 'GET', `/payroll/runs/${M_OPEN}/accounts`);
  if (md.body && !md.body.journalEntry) { await http(S.sa, 'POST', `/payroll/runs/${M_OPEN}/post`); md = await http(S.sa, 'GET', `/payroll/runs/${M_OPEN}/accounts`); }
  const je = md.body && md.body.journalEntry;
  if (je) {
    const sp = je.lines.find((l) => l.accountCode === '2100' && l.credit > 0);
    ok(je.totalDebit === je.totalCredit && sp && sp.credit === all.reduce((n, x) => n + x.netPay, 0), 'T52 the posted month voucher uses the edited numbers (Salary Payable = sum of net pay)', { sp: sp && sp.credit, net: all.reduce((n, x) => n + x.netPay, 0) });
  } else ok(false, 'T52 the month is posted to Accounts', md.body);
  const slip = await prisma.payslip.findUnique({ where: { employeeId_month: { employeeId: S.e1, month: M_OPEN } } });
  ok(slip && slip.netPay === e1r.netPay && slip.gross === e1r.grossPay, 'T53 the payslip row carries the approved (edited) figures', slip && { n: slip.netPay, e: e1r.netPay });
  const pay = await http(S.sa, 'GET', `/payroll/payslips/${slip.id}`);
  ok(pay.status === 200 && pay.body.netPay === e1r.netPay && pay.body.editInfo && pay.body.editInfo.edited, 'T54 the payslip view shows the edited figures and an Edited marker to the payroll desk', pay.body && pay.body.editInfo);
  const payEmp = await http(S.empUser, 'GET', `/payroll/payslips/${slip.id}`);
  ok(payEmp.status === 200 && payEmp.body.netPay === e1r.netPay && payEmp.body.editInfo === undefined && !/Edited|edited/.test(JSON.stringify(payEmp.body)), 'T55 the employee sees the same figures, but NO edited badge / edit info', payEmp.body && Object.keys(payEmp.body));
  const pdf = await fetch(`${API}/payroll/payslips/${slip.id}/pdf`, { headers: { Authorization: `Bearer ${tok(S.sa)}` } });
  ok(pdf.status === 200 && (pdf.headers.get('content-type') || '').includes('pdf'), 'T56 the payslip PDF still renders after an edit', pdf.status);

  console.log('--- reopen (Super Admin only), superseded payslip');
  const roAcct = await http(S.acct, 'POST', `/payroll/runs/${M_OPEN}/reopen`, { reason: 'ZZTEST fix' });
  ok(roAcct.status === 403 && /Super Admin/.test(roAcct.body.error), 'T57 the Accountant cannot reopen an approved month', roAcct.body);
  ok((await http(S.hr, 'POST', `/payroll/runs/${M_OPEN}/reopen`, { reason: 'ZZTEST fix' })).status === 403, 'T58 HR cannot reopen');
  const roNo = await http(S.sa, 'POST', `/payroll/runs/${M_OPEN}/reopen`, {});
  ok(roNo.status === 400, 'T59 reopening needs a reason', roNo.body);
  const ro = await http(S.sa, 'POST', `/payroll/runs/${M_OPEN}/reopen`, { reason: 'ZZTEST wrong bonus' });
  ok(ro.status === 200 && (await ent(S.e1)).status === 'DRAFT', 'T60 the Super Admin reopens it to Draft with a reason', ro.body && (ro.body.error || ro.status));
  ok(await prisma.auditLog.count({ where: { action: 'Payroll month re-opened', reason: 'ZZTEST wrong bonus' } }) >= 1, 'T61 the reopen is audited with the reason');
  ok(await prisma.notification.count({ where: { title: 'Payroll re-opened', message: { contains: 'ZZTEST wrong bonus' } } }) >= 1, 'T62 Accounts + Admin are notified of the reopen (real Admin / Accountant users; test users are never notified)');
  ed = await http(S.hr, 'GET', `/payroll/entries/${e1r.id}/edit`);
  const oldNet = (await ent(S.e1)).netPay;
  const edAgain = await http(S.hr, 'PUT', `/payroll/entries/${e1r.id}/edit`, saveBody(ed.body, { bonus: 2000 }));
  ok(edAgain.status === 200, 'T63 the reopened Draft can be edited again', edAgain.body);
  const hist2 = await http(S.sa, 'GET', `/payroll/entries/${e1r.id}/history`);
  ok(hist2.body.superseded.length === 1 && hist2.body.superseded[0].netPay === oldNet, 'T64 the payslip issued earlier is archived as Superseded (both versions kept for Admin)', hist2.body.superseded);
  const pay2 = await http(S.sa, 'GET', `/payroll/payslips/${slip.id}`);
  ok(pay2.body.editInfo && pay2.body.editInfo.superseded.length === 1, 'T65 the payslip view shows Admin the superseded version', pay2.body.editInfo && pay2.body.editInfo.superseded.length);
  console.log('--- adjustments land in the next open month');
  const a1 = await http(S.hr, 'POST', '/payroll/adjustments', { employeeId: S.e1, sourceMonth: M_PAID, kind: 'ARREARS', amount: 1200, label: 'ZZTEST arrears', reason: 'ZZTEST salary revision' });
  ok(a1.status === 201 && a1.body.targetMonth === M_OPEN && a1.body.applied, 'T68 an adjustment for a Paid month is applied in the NEXT open month (Draft record gets a line)', a1.body);
  ok((await prisma.employeePayrollRun.findUnique({ where: { id: pd.id } })).grossPay === 23319, 'T69 the Paid month itself is not touched', null);
  const tgt = await ent(S.e1);
  const tgtState = await PEdit.readState(tgt.id);
  ok(tgtState.extras.earnings.some((x) => x.adj) && tgt.arrears >= 1200, 'T70 the target record carries the adjustment as its own line', tgtState.extras.earnings);
  ok(await prisma.auditLog.count({ where: { entity: 'PayrollAdjustment', action: 'Payroll adjustment added' } }) >= 1, 'T71 the adjustment has its own audit line');
  const a2 = await http(S.hr, 'POST', '/payroll/adjustments', { employeeId: S.e1, sourceMonth: M_OPEN, kind: 'RECOVERY', amount: 50, reason: 'ZZTEST x' });
  ok(a2.status === 409 && /Edit/.test(a2.body.error), 'T72 an adjustment on a month that is still open is refused (use Edit)', a2.body);
  const a3 = await http(S.hr, 'POST', '/payroll/adjustments', { employeeId: S.e1, sourceMonth: M_PAID, kind: 'RECOVERY', amount: 0, reason: 'ZZTEST x' });
  ok(a3.status === 400, 'T73 a zero amount is refused');
  const a4 = await http(S.hr, 'POST', '/payroll/adjustments', { employeeId: S.e1, sourceMonth: M_IMPORTED, kind: 'RECOVERY', amount: 70, label: 'ZZTEST recovery', reason: 'ZZTEST wrong recovery' });
  ok(a4.status === 201 && a4.body.targetMonth, 'T74 an imported month can take an adjustment too (applied in the next open month)', a4.body);
  const lst = await http(S.hr, 'GET', `/payroll/adjustments?month=${a1.body.targetMonth}`);
  ok(lst.status === 200 && lst.body.length >= 1 && lst.body[0].employeeName, 'T75 the adjustments of a month can be listed', lst.body);

  console.log('--- AWL snapshot');
  const snapKey = `payroll.snapshot:${M_OPEN}`;
  const sRow = await prisma.appSetting.findUnique({ where: { key: snapKey } });
  const snap = sRow ? JSON.parse(sRow.value) : { people: {} };
  snap.people = snap.people || {}; snap.people[S.e3] = { awl: { days: 2, dates: ['2031-05-04', '2031-05-05'], halfDays: 0, perDay: 2, perHalf: 1, lop: 4 }, lastWorkingDate: null };
  await prisma.appSetting.upsert({ where: { key: snapKey }, update: { value: JSON.stringify(snap) }, create: { key: snapKey, value: JSON.stringify(snap) } });
  const e3r = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: S.e3, month: M_OPEN } } });
  await prisma.employeePayrollRun.update({ where: { id: e3r.id }, data: { status: 'DRAFT' } });
  const ed3 = await http(S.hr, 'GET', `/payroll/entries/${e3r.id}/edit`);
  ok(ed3.body.awl && ed3.body.awl.days === 2, 'T76 the editor shows the absent-without-leave days from the snapshot', ed3.body.awl);
  const aw = await http(S.hr, 'PUT', `/payroll/entries/${e3r.id}/edit`, saveBody(ed3.body, { awlDays: 1, daysLop: 3 }));
  const snap2 = JSON.parse((await prisma.appSetting.findUnique({ where: { key: snapKey } })).value);
  ok(aw.status === 200 && snap2.people[S.e3].awl.days === 1 && snap2.people[S.e3].awl.lop === 2 && (await prisma.employeePayrollRun.findUnique({ where: { id: e3r.id } })).daysLop === 3, 'T77 changing the AWL days / LOP days updates the snapshot (LOP summary + payslip lines agree)', snap2.people[S.e3]);

  console.log('--- the adjustment is picked up when a month is calculated later');
  const a5 = await http(S.hr, 'POST', '/payroll/adjustments', { employeeId: S.e2, sourceMonth: M_PAID, kind: 'ARREARS', amount: 900, label: 'ZZTEST arrears 2', reason: 'ZZTEST x' });
  ok(a5.status === 201 && a5.body.targetMonth === M_OPEN && !a5.body.applied, 'T78 an employee with no record yet in the next open month: the adjustment waits for that month to be calculated', a5.body);
  const cal6 = await http(S.hr, 'POST', '/payroll/calculate', { month: M_OPEN, employeeIds: [S.e2] });
  const r6 = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId: S.e2, month: M_OPEN } } });
  ok(cal6.status === 201 && r6 && r6.arrears === 900 && r6.grossPay === 19000 + 900, 'T79 when that month is calculated the adjustment is picked up as its own line (arrears 900 in gross)', r6 && { s: cal6.status, a: r6.arrears, g: r6.grossPay, e: cal6.body && cal6.body.error });
  const st6 = await PEdit.readState(r6.id);
  ok(st6.extras.earnings.length === 1 && st6.extras.earnings[0].adj && !st6.edited, 'T80 its edit state carries the line, not marked as a hand edit', st6.extras);
  const ed6 = await http(S.hr, 'GET', `/payroll/entries/${r6.id}/edit`);
  ok(ed6.body.components.earnings[0].adj && ed6.body.drift.length === 0, 'T81 the editor shows the adjustment as a read-only line; no drift', ed6.body.drift);
  const cal6b = await http(S.hr, 'POST', '/payroll/calculate', { month: M_OPEN, employeeIds: [S.e2] });
  ok(cal6b.status === 201 && (await prisma.employeePayrollRun.findUnique({ where: { id: r6.id } })).arrears === 900, 'T82 recalculating again does not double the adjustment', cal6b.body && cal6b.body.error);

  console.log('--- re-approval regenerates the payslip (Draft month -> new payslip), adjustment line labelled');
  await http(S.hr, 'POST', '/payroll/entries/submit', { month: M_OPEN });
  const reApprove = await http(S.sa, 'POST', '/payroll/entries/approve', { month: M_OPEN });
  const slip2 = await prisma.payslip.findUnique({ where: { employeeId_month: { employeeId: S.e1, month: M_OPEN } } });
  const fin = await ent(S.e1);
  ok(reApprove.status === 200 && slip2.netPay === fin.netPay && slip2.netPay !== oldNet, 'T66 after re-approval the payslip carries the NEW edited figures', { n: slip2.netPay, old: oldNet, s: reApprove.status });
  const pay3 = await http(S.empUser, 'GET', `/payroll/payslips/${slip2.id}`);
  ok(pay3.status === 200 && pay3.body.earnings.some((x) => x.label === 'ZZTEST arrears' && x.amount === 1200), 'T67 the payslip prints the adjustment under its own name (arrears 1,200)', pay3.body && pay3.body.earnings);
  const pay4 = await http(S.sa, 'GET', `/payroll/payslips/${slip2.id}`);
  ok(pay4.body.editInfo && pay4.body.editInfo.superseded.length === 1, 'T67b Admin still sees the superseded older payslip', pay4.body.editInfo && pay4.body.editInfo.superseded.length);
}

async function cleanup() {
  const out = [];
  const del = async (label, fn) => { try { const r = await fn(); out.push(`${label}:${r && r.count != null ? r.count : 'ok'}`); } catch (e) { out.push(`${label}: ERR ${e.message}`); } };
  const users = [S.sa, S.admin, S.hr, S.acct, S.mgr, S.tl, S.empUser].filter(Boolean);
  const entries = await prisma.employeePayrollRun.findMany({ where: { employeeId: { in: S.emps || [] } } });
  const entryIds = entries.map((e) => e.id);
  const slips = await prisma.payslip.findMany({ where: { employeeId: { in: S.emps || [] } }, select: { id: true } });
  const runs = await prisma.payrollRun.findMany({ where: { month: { in: MONTHS } } });
  for (const run of runs) {
    // eslint-disable-next-line no-await-in-loop
    await del('je', () => prisma.journalEntry.deleteMany({ where: { OR: [{ referenceId: run.id }, { idempotencyKey: { contains: run.id } }] } }));
    // eslint-disable-next-line no-await-in-loop
    await del('logs', () => prisma.payrollSyncLog.deleteMany({ where: { OR: [{ employeePayrollRunId: run.id }, { month: run.month }] } }));
  }
  await del('vouchers', () => prisma.payrollVoucherEmployee.deleteMany({ where: { employeeId: { in: S.emps || [] } } }).catch(() => ({ count: 0 })));
  const adjIds = [];
  for (const m of MONTHS) {
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.appSetting.findUnique({ where: { key: `payroll.adj:${m}` } });
    if (row) { try { JSON.parse(row.value).forEach((a) => adjIds.push(a.id)); } catch { /* skip */ } }
  }
  await del('audit', () => prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...entryIds, ...runs.map((r) => r.id), ...adjIds] } }, { userId: { in: users } }, { actorName: { contains: 'ZZTEST PE' } }] } }));
  await del('settings', () => prisma.appSetting.deleteMany({ where: { OR: [{ key: { in: [...entryIds.map((i) => `payroll.edit:${i}`), ...slips.map((s) => `payroll.payslipLines:${s.id}`), ...MONTHS.map((m) => `payroll.snapshot:${m}`), ...MONTHS.map((m) => `payroll.adj:${m}`)] } }] } }));
  await del('payslips', () => prisma.payslip.deleteMany({ where: { employeeId: { in: S.emps || [] } } }));
  await del('entries', () => prisma.employeePayrollRun.deleteMany({ where: { employeeId: { in: S.emps || [] } } }));
  for (const run of runs) {
    // eslint-disable-next-line no-await-in-loop
    await del('run', () => prisma.payrollRun.deleteMany({ where: { id: run.id } }));
  }
  await del('versions', () => prisma.salaryStructureVersion.deleteMany({ where: { employeeId: { in: S.emps || [] } } }));
  await del('structures', () => prisma.salaryStructure.deleteMany({ where: { employeeId: { in: S.emps || [] } } }));
  await del('notif', () => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { message: { contains: 'ZZTEST PE' } }] } }));
  await del('emps', () => prisma.employee.deleteMany({ where: { id: { in: S.emps || [] } } }));
  await del('users', () => prisma.user.deleteMany({ where: { id: { in: users } } }));
  console.log('cleanup', out.join(' '));
}

main().catch((e) => { fail += 1; console.error('ERROR', e); }).finally(async () => {
  await cleanup().catch((e) => console.error('cleanup error', e));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
});

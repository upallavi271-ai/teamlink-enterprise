#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HR AUDIT CHECKS - utils/hrAuditChecks.js. It plants known problems for a few ZZ-AUDIT people in the SANDBOX database, runs every
// check, and removes everything it made. It refuses to run outside the test sandbox.
//   cd backend && TEST_MODE=1 DATABASE_URL="file:./sandbox.db" node -r dotenv/config scripts/hr-audit-test.js
// ---------------------------------------------------------------------------
/* eslint-disable no-console, global-require */
const assert = require('assert');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
if (!truthy(process.env.TEST_MODE) && !truthy(process.env.TEAMLINK_SANDBOX)) {
  console.error('Refusing to run: this test writes to the database. Run it with TEST_MODE=1 against the sandbox.');
  process.exit(2);
}
const prisma = require('../src/db');
const checks = require('../src/utils/hrAuditChecks');

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const now = Date.now();
const made = { employees: [], users: [], records: [], details: [], regs: [], steps: [], runs: [], docs: [], acks: [] };
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const rowsOf = async (key) => (await checks.detail(key)).rows;
const has = (rows, name) => rows.some((r) => r.name === name);

async function cleanup() {
  const del = async (fn) => { try { await fn(); } catch { /* already gone */ } };
  if (made.steps.length) await del(() => prisma.approvalStep.deleteMany({ where: { id: { in: made.steps } } }));
  if (made.regs.length) await del(() => prisma.attendanceRegularization.deleteMany({ where: { id: { in: made.regs } } }));
  if (made.runs.length) await del(() => prisma.employeePayrollRun.deleteMany({ where: { id: { in: made.runs } } }));
  if (made.details.length) await del(() => prisma.resignationDetail.deleteMany({ where: { id: { in: made.details } } }));
  if (made.records.length) await del(() => prisma.employeeRecord.deleteMany({ where: { id: { in: made.records } } }));
  if (made.acks.length) await del(() => prisma.acknowledgment.deleteMany({ where: { id: { in: made.acks } } }));
  if (made.docs.length) await del(() => prisma.policyDocument.deleteMany({ where: { id: { in: made.docs } } }));
  if (made.employees.length) await del(() => prisma.employee.deleteMany({ where: { id: { in: made.employees } } }));
  if (made.users.length) await del(() => prisma.user.deleteMany({ where: { id: { in: made.users } } }));
}

(async () => {
  console.log('HR audit checks');
  const stamp = String(now).slice(-6);
  try {
    const mkUser = async (tag, extra = {}) => {
      const u = await prisma.user.create({ data: { name: `ZZ Audit ${tag}`, email: `zzaudit-${tag}-${stamp}@example.test`, passwordHash: 'x', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', status: 'Active', ...extra } });
      made.users.push(u.id); return u;
    };
    const mkEmp = async (tag, extra = {}) => {
      const e = await prisma.employee.create({ data: { employeeCode: `ZZA-${tag}-${stamp}`, name: `ZZ Audit ${tag}`, department: 'ZZ Audit Dept', designation: 'Executive', employmentStatus: 'Active', dateOfJoining: new Date(now - 400 * DAY), ...extra } });
      made.employees.push(e.id); return e;
    };
    const uA = await mkUser('A');
    const uGone = await mkUser('Gone', { lastLoginAt: new Date(now - 30 * DAY) });
    const uAdmin = await mkUser('Admin', { role: 'ADMIN', hrmsRole: 'ADMIN' });
    const gone = await mkEmp('Gone', { employmentStatus: 'Relieved', userId: uGone.id });
    const adminEmp = await mkEmp('Admin', { userId: uAdmin.id });
    const a = await mkEmp('A', { userId: uA.id, phone: '9876500001', bankAccountNumber: '123456789012', dateOfBirth: new Date('1990-05-05'), reportingManagerId: gone.id });
    const b = await mkEmp('B', { phone: '98765 00001', bankAccountNumber: '1234-5678-9012', dateOfBirth: new Date('1991-06-06') });
    const notice = await mkEmp('Notice', { employmentStatus: 'Notice Period', offboardingStatus: 'Serving Notice' });

    await t('a person with no manager is listed, and a person with a manager is not', async () => {
      const r = await rowsOf('no-manager');
      assert.ok(has(r, b.name)); assert.ok(!has(r, a.name));
    });
    await t('a reporting manager who has left is found', async () => {
      const r = await rowsOf('manager-left');
      assert.ok(has(r, a.name)); assert.ok(/Relieved/.test(r.find((x) => x.name === a.name).detail));
    });
    await t('the same phone number (even typed with spaces) marks both as possible duplicates', async () => {
      const r = await rowsOf('duplicate-people');
      assert.ok(has(r, a.name) && has(r, b.name));
    });
    await t('the same bank account (even typed with dashes) is found and only the last four digits are shown', async () => {
      const r = await rowsOf('duplicate-bank');
      assert.ok(has(r, a.name) && has(r, b.name));
      const text = r.find((x) => x.name === a.name).detail;
      assert.ok(/ending 9012/.test(text)); assert.ok(!/123456789012/.test(text));
    });
    await t('missing details are listed by name of the detail', async () => {
      const r = await rowsOf('missing-info');
      assert.ok(/PAN/.test(r.find((x) => x.name === a.name).detail));
    });
    await t('a person who left but still has an active login is found, an active person is not', async () => {
      const r = await rowsOf('left-with-access');
      assert.ok(has(r, gone.name)); assert.ok(!has(r, a.name));
    });
    await t('an Admin login outside HR / IT is listed', async () => {
      const r = await rowsOf('admin-rights');
      assert.ok(has(r, 'ZZ Audit Admin'));
    });
    await t('a mandatory policy nobody acknowledged is listed per person, and an acknowledgement removes the person', async () => {
      const doc = await prisma.policyDocument.create({ data: { title: `ZZ Audit Policy ${stamp}`, mandatory: true, published: true, approvalStatus: 'Approved', target: 'All Employees', uploadedDate: iso(now) } });
      made.docs.push(doc.id);
      let r = await rowsOf('policy-not-acknowledged');
      assert.ok(has(r, a.name) && /ZZ Audit Policy/.test(r.find((x) => x.name === a.name).detail));
      const ack = await prisma.acknowledgment.create({ data: { documentId: doc.id, employeeId: a.id } });
      made.acks.push(ack.id);
      checks.resetCache();
      r = await rowsOf('policy-not-acknowledged');
      assert.ok(!/ZZ Audit Policy/.test((r.find((x) => x.name === a.name) || { detail: '' }).detail));
    });
    await t('a Help Desk ticket open for 10 days is found', async () => {
      const rec = await prisma.employeeRecord.create({ data: { type: 'HELPDESK', employeeId: a.id, title: 'ZZ Audit laptop ticket', status: 'Open', category: 'IT Support', priority: 'High', createdAt: new Date(now - 10 * DAY) } });
      made.records.push(rec.id);
      const r = await rowsOf('helpdesk-overdue');
      assert.ok(/ZZ Audit laptop ticket/.test(r.find((x) => x.name === a.name).detail));
    });
    await t('a correction approved by the same person it was for is found', async () => {
      const reg = await prisma.attendanceRegularization.create({ data: { employeeId: a.id, date: iso(now - 5 * DAY), reason: 'ZZ audit', status: 'Approved' } });
      made.regs.push(reg.id);
      const st = await prisma.approvalStep.create({ data: { workflow: 'regularization', recordId: reg.id, level: 'SUPER_ADMIN', seq: 7, mode: 'required', status: 'Approved', approverUserId: uA.id, actedByUserId: uA.id, actedAt: new Date(now - 4 * DAY) } });
      made.steps.push(st.id);
      const r = await rowsOf('self-approved');
      assert.ok(has(r, a.name));
    });
    await t('salary with no day present is found, an imported register line is not', async () => {
      const ym = iso(now).slice(0, 7);
      const mk = (extra) => prisma.employeePayrollRun.create({ data: { employeeId: a.id, month: ym, year: Number(ym.slice(0, 4)), monthNum: Number(ym.slice(5, 7)), netPay: 15000, daysPresent: 0, status: 'APPROVED', ...extra } });
      const run = await mk({});
      made.runs.push(run.id);
      let r = await rowsOf('salary-no-attendance');
      assert.ok(has(r, a.name));
      await prisma.employeePayrollRun.delete({ where: { id: run.id } }); made.runs.pop();
      const imported = await mk({ importedBreakup: '{}' });
      made.runs.push(imported.id);
      r = await rowsOf('salary-no-attendance');
      assert.ok(!has(r, a.name));
    });
    await t('salary for a month after the last working day is found', async () => {
      const lastDay = iso(now - 70 * DAY);
      const rec = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: gone.id, title: 'ZZ audit exit', status: 'Relieved', date: lastDay } });
      made.records.push(rec.id);
      const after = iso(now - 5 * DAY).slice(0, 7);
      const run = await prisma.employeePayrollRun.create({ data: { employeeId: gone.id, month: after, year: Number(after.slice(0, 4)), monthNum: Number(after.slice(5, 7)), netPay: 9000, daysPresent: 20, status: 'APPROVED' } });
      made.runs.push(run.id);
      const r = await rowsOf('salary-after-exit');
      assert.ok(has(r, gone.name) && /last working day/.test(r.find((x) => x.name === gone.name).detail));
    });
    await t('exit clearance still open after the last working day is found', async () => {
      const rec = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: notice.id, title: 'ZZ audit notice', status: 'Approved', date: iso(now - 10 * DAY) } });
      made.records.push(rec.id);
      const r = await rowsOf('exit-clearance-pending');
      assert.ok(has(r, notice.name));
    });
    await t('the headline numbers are worked out and the notes explain them', async () => {
      checks.resetCache();
      const s = await checks.summary({ refresh: true });
      assert.ok(!s.kpiError); assert.ok(s.kpis.headcount > 0);
      assert.strictEqual(s.checks.length, checks.CHECKS.length);
      assert.ok(s.checks.every((c) => c.count !== null), `a check failed: ${s.checks.filter((c) => c.count === null).map((c) => c.key).join(', ')}`);
      assert.ok(/Attrition/.test(s.kpis.notes));
    });
    await t('an unknown check name is refused and every check carries question numbers', async () => {
      assert.strictEqual(await checks.detail('nope'), null);
      assert.ok(checks.CHECKS.every((c) => c.questions.length && c.title && c.why));
    });
  } finally {
    await cleanup();
    const left = await prisma.employee.count({ where: { employeeCode: { startsWith: 'ZZA-' } } });
    console.log(left === 0 ? '  (test data removed)' : `  WARNING: ${left} test employees left behind`);
    await prisma.$disconnect();
  }
  console.log(`${passed} checks passed${process.exitCode ? ', with failures' : ''}`);
})();

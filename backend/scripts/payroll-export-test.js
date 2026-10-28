#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYROLL RECORDS EXPORT (founder 2026-10-27: "process payroll lo export option pettu"). SANDBOX ONLY. Read-only.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/payroll-export-test.js
// Proves: the month's calculated payroll comes out as Excel and CSV, one row per record + a TOTAL row, net pay adding up;
// no bank / PAN / UAN numbers in the file; an employee without the export right is refused; the records list says who may export.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('PEX');

(async () => {
  const { prisma } = Z;
  try {
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const S = await Z.mint(sa);
    const top = await prisma.employeePayrollRun.groupBy({ by: ['month'], _count: { _all: true }, orderBy: { month: 'desc' }, take: 1 });
    if (!top.length) { Z.check('E0 (no payroll records in this copy - nothing to export)', true); return; }
    const month = top[0].month;
    const list = await Z.call('GET', `/api/payroll/entries?month=${month}`, S);
    Z.check('E1 the records list tells the screen the Super Admin may export', list.status === 200 && list.body.access && list.body.access.export === true, list.body && list.body.access);
    const API = String(process.env.TL_API).replace(/\/+$/, '');
    const csv = await fetch(`${API}/api/payroll/runs/${month}/export?format=csv`, { headers: { Authorization: `Bearer ${S}` } });
    const text = await csv.text();
    const lines = text.trim().split(/\r?\n/);
    const head = lines[0].split(',');
    Z.check('E2 CSV: one row per record + the TOTAL row', csv.status === 200 && lines.length === list.body.entries.length + 2 && /TOTAL/.test(lines[lines.length - 1]), [csv.status, lines.length, list.body.entries.length]);
    Z.check('E3 the file has the pay columns and no bank / PAN / UAN numbers', head.includes('Net pay') && head.includes('Gross') && !/bank|pan|uan|ifsc/i.test(lines[0]), lines[0].slice(0, 200));
    const netCol = head.indexOf('Net pay');
    const sumNet = lines.slice(1, -1).reduce((n, l) => n + Number((l.split(',')[netCol] || '0').replace(/"/g, '')), 0);
    const totNet = Number(lines[lines.length - 1].split(',')[netCol]);
    Z.check('E4 the TOTAL row adds up', Math.abs(sumNet - totNet) < 1, [sumNet, totNet]);
    const x = await fetch(`${API}/api/payroll/runs/${month}/export?format=xlsx`, { headers: { Authorization: `Bearer ${S}` } });
    const buf = Buffer.from(await x.arrayBuffer());
    Z.check('E5 Excel comes out as a real .xlsx', x.status === 200 && /spreadsheetml/.test(x.headers.get('content-type') || '') && buf.slice(0, 2).toString() === 'PK', [x.status, x.headers.get('content-type')]);
    const emp = await Z.mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Employee', department: 'R&D' });
    const no = await Z.call('GET', `/api/payroll/runs/${month}/export?format=csv`, await Z.mint(emp));
    Z.check('E6 an employee cannot export the payroll', no.status === 403, no.status);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { action: { startsWith: 'Payroll exported' }, createdAt: { gte: new Date(Date.now() - 600000) } } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();

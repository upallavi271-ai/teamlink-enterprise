#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYSLIP IN EVERYBODY'S LOGIN ONCE PAYROLL IS CALCULATED (founder 2026-11-24) - no database, nothing is touched.
//
//   cd backend
//   node scripts/payslip-provisional-test.js
//
// utils/payslipProvisional.js: the id of a provisional payslip, the payslip-shaped object made from a calculated record, and the
// newest-month-first merge with the issued payslips. The list / view / PDF routes are checked against a sandbox database separately.
// ---------------------------------------------------------------------------
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'utils', 'payslipProvisional'));
const E = require(path.join(__dirname, '..', 'src', 'utils', 'payrollEngine'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d)}` : ''}`); };

// the ids
check('1 id round trip', P.entryIdOf(P.idFor('abc123')) === 'abc123' && P.isProvisionalId(P.idFor('abc123')));
check('2 an issued payslip id is not provisional', !P.isProvisionalId('cmabc123xyz') && P.entryIdOf('cmabc123xyz') === null);
check('3 the bare prefix, empty and non-strings are not provisional', !P.isProvisionalId('draft-') && !P.isProvisionalId('') && !P.isProvisionalId(null) && !P.isProvisionalId(undefined) && !P.isProvisionalId(42));

// only a calculated, not-yet-approved record is shown as provisional
check('4 Draft and Sent for approval are provisional; Approved / Synced / Paid are not (they have the issued payslip)',
  JSON.stringify(P.PROVISIONAL_STATUSES) === JSON.stringify(['DRAFT', 'PENDING_APPROVAL']), P.PROVISIONAL_STATUSES);

// the figures come from the SAME function the issued payslip uses
const entry = {
  id: 'run1', employeeId: 'emp1', month: '2026-11', employee: { id: 'emp1', name: 'Test Person' },
  basic: 20000, hra: 8000, bonus: 1000, specialAllowance: 11000, conveyance: 0, arrears: 500, incentive: 0,
  pfEmployee: 2400, pfEmployer: 2400, esiEmployee: 0, esiEmployer: 0, professionalTax: 200, tds: 0, otherDeductions: 100, gratuity: 962,
  grossPay: 40500, lopDeduction: 1350, netPay: 36450, daysLop: 1, workingDays: 30, payMode: 'Package', importedBreakup: null,
  calculatedAt: new Date('2026-11-24T10:00:00Z'), updatedAt: new Date('2026-11-24T10:05:00Z'), createdAt: new Date('2026-11-24T09:00:00Z'),
};
const fields = E.slipFieldsOf(entry);
check('5 the slip figures: net, gross, LOP, allowances (bonus + special + conveyance + arrears), deductions (PF + PT + ESI + TDS + other)',
  fields.netPay === 36450 && fields.gross === 40500 && fields.lopDays === 1 && fields.lopDeduction === 1350
  && fields.allowances === 12500 && fields.deductions === 2700 && fields.employeePf === 2400 && fields.payrollEntryId === 'run1', fields);
check('6 the fields carry no generatedAt of their own (the issued payslip stamps its own)', !('generatedAt' in fields), Object.keys(fields));

const slip = P.slipLike(entry, fields, { earnings: [{ label: 'Arrears', amount: 500 }], deductions: [] });
check('7 the provisional slip: its own id, the person, the month, flagged provisional', slip.id === 'draft-run1' && slip.employeeId === 'emp1' && slip.month === '2026-11' && slip.provisional === true && slip.employee.name === 'Test Person', slip);
check('8 its date is when the record was calculated', new Date(slip.generatedAt).toISOString() === '2026-11-24T10:00:00.000Z', slip.generatedAt);
check('9 the labelled rows ride along as _lines; without rows there is no _lines key at all', slip._lines && slip._lines.earnings[0].label === 'Arrears' && !('_lines' in P.slipLike(entry, fields)), Object.keys(P.slipLike(entry, fields)));
check('10 same money as the issued payslip would carry', ['basic', 'hra', 'bonus', 'specialAllowance', 'netPay', 'gross', 'deductions', 'lopDays', 'workingDays', 'payMode'].every((k) => slip[k] === fields[k]));

// the merge
const merged = P.newestFirst([
  { id: 'draft-a', month: '2026-11' }, { id: 'p-oct', month: '2026-10' }, { id: 'p-nov-old', month: '2026-11' }, { id: 'p-sep', month: '2026-09' },
]);
check('11 newest month first; inside a month the order given is kept (the provisional one first)', merged.map((x) => x.id).join() === 'draft-a,p-nov-old,p-oct,p-sep', merged.map((x) => x.id));
check('12 nothing to merge is fine', P.newestFirst([]).length === 0);

// only once the pay period is over (a month calculated while its period still runs would show a loss of pay that is not real)
check('13 a period that ended yesterday is shown', P.periodEnded('2026-11-15', '2026-11-16') === true);
check('14 on the last day itself it is still running: not shown yet', P.periodEnded('2026-11-15', '2026-11-15') === false);
check('15 a period still running (ends 15 Dec, today 24 Nov) is not shown', P.periodEnded('2026-12-15', '2026-11-24') === false);
check('16 a long finished period is shown; no end date at all is not', P.periodEnded('2026-10-15', '2026-11-24') === true && P.periodEnded(null, '2026-11-24') === false && P.periodEnded('', '2026-11-24') === false);
check('17 a full timestamp end date is read by its date part', P.periodEnded('2026-11-15T00:00:00.000Z', '2026-11-24T08:00:00.000Z') === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

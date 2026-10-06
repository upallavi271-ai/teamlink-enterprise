// ---------------------------------------------------------------------------
// PAYROLL REPORTS (SPEC B §8)
//
//   reconciliation(month) — HRMS payroll (what the approved runs say should be
//     booked) vs the Accounts ledger (what JournalLine actually holds), per
//     employee and per account, to the paisa. Anything that is not an exact
//     match is flagged: NOT_BOOKED (approved, no journal yet), MISMATCH (an
//     account's amount differs), UNBALANCED (a journal's own lines do not
//     balance), PAYMENT_MISSING (paid, no bank payment journal), ORPHAN (a
//     payroll journal with no approved run behind it).
//   compliance(month | year) — PF / ESI / TDS / PT by employee and by month.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { accountIndex, paise } = require('./ledger');
const { buildAccrualPayload, buildPaymentPayload } = require('./payrollSync');
const { monthlyPayrollTotals, FINAL_STATUSES } = require('./payrollTotals');
const { monthLabel } = require('./attendanceMath');

const r2 = (p) => p / 100;

function addTo(map, code, name, debit, credit) {
  const row = map.get(code) || { code, name, debit: 0, credit: 0 };
  row.debit += debit; row.credit += credit;
  map.set(code, row);
}

async function expectedLines(payload, index) {
  const m = new Map();
  (payload.debit || []).forEach((l) => { const a = index.get(String(l.account).toLowerCase()); if (a && paise(l.amount)) addTo(m, a.code, a.name, paise(l.amount), 0); });
  (payload.credit || []).forEach((l) => { const a = index.get(String(l.account).toLowerCase()); if (a && paise(l.amount)) addTo(m, a.code, a.name, 0, paise(l.amount)); });
  return m;
}

function bookedLines(journals) {
  const m = new Map();
  journals.forEach((j) => j.lines.forEach((l) => addTo(m, l.accountCode, l.accountName, paise(l.debit), paise(l.credit))));
  return m;
}

function compare(expected, booked) {
  const codes = new Set([...expected.keys(), ...booked.keys()]);
  const diffs = [];
  codes.forEach((code) => {
    const e = expected.get(code) || { debit: 0, credit: 0, name: (booked.get(code) || {}).name };
    const b = booked.get(code) || { debit: 0, credit: 0 };
    if (e.debit !== b.debit || e.credit !== b.credit) {
      diffs.push({
        accountCode: code, accountName: e.name || b.name,
        expectedDebit: r2(e.debit), bookedDebit: r2(b.debit), expectedCredit: r2(e.credit), bookedCredit: r2(b.credit),
      });
    }
  });
  return diffs;
}

// SPEC B's per-employee comparison (one journal per record). Kept for months
// booked that way; S3 books one journal per month — see reconciliation().
async function legacyReconciliation(month) {
  const [entries, journals, index] = await Promise.all([
    prisma.employeePayrollRun.findMany({ where: { month }, include: { employee: true }, orderBy: { employee: { name: 'asc' } } }),
    prisma.journalEntry.findMany({ where: { month, referenceType: { in: ['PAYROLL_RUN', 'PAYROLL_PAYMENT'] } }, include: { lines: true } }),
    accountIndex(),
  ]);
  const byRef = new Map();
  journals.forEach((j) => {
    const k = `${j.referenceType}|${j.referenceId}`;
    if (!byRef.has(k)) byRef.set(k, []);
    byRef.get(k).push(j);
  });
  const used = new Set();
  const rows = [];
  const accountExpected = new Map();
  const accountBooked = new Map();

  for (const e of entries) {
    const accr = byRef.get(`PAYROLL_RUN|${e.id}`) || [];
    const pay = byRef.get(`PAYROLL_PAYMENT|${e.id}`) || [];
    accr.concat(pay).forEach((j) => used.add(j.id));
    const final = FINAL_STATUSES.includes(e.status);
    const expected = final ? await expectedLines(buildAccrualPayload(e, e.employee), index) : new Map();
    if (e.status === 'PAID') {
      const pm = await expectedLines(buildPaymentPayload(e, e.employee), index);
      pm.forEach((v, k) => addTo(expected, k, v.name, v.debit, v.credit));
    }
    const booked = bookedLines(accr.concat(pay));
    expected.forEach((v, k) => addTo(accountExpected, k, v.name, v.debit, v.credit));
    booked.forEach((v, k) => addTo(accountBooked, k, v.name, v.debit, v.credit));

    const flags = [];
    if (!final && (accr.length || pay.length)) flags.push('ORPHAN');
    if (final && !accr.length) flags.push('NOT_BOOKED');
    if (e.status === 'PAID' && !pay.length) flags.push('PAYMENT_MISSING');
    accr.concat(pay).forEach((j) => {
      const dr = j.lines.reduce((n, l) => n + paise(l.debit), 0);
      const cr = j.lines.reduce((n, l) => n + paise(l.credit), 0);
      if (dr !== cr) flags.push('UNBALANCED');
    });
    const diffs = final || accr.length || pay.length ? compare(expected, booked) : [];
    if (diffs.length && !flags.includes('NOT_BOOKED')) flags.push('MISMATCH');
    if (!final && !accr.length && !pay.length) continue; // a draft nobody booked: nothing to reconcile yet
    const expDr = [...expected.values()].reduce((n, v) => n + v.debit, 0);
    const bkDr = [...booked.values()].reduce((n, v) => n + v.debit, 0);
    rows.push({
      entryId: e.id, employeeId: e.employeeId, employeeCode: e.employee.employeeCode, name: e.employee.name,
      status: e.status, netPay: e.netPay, costToCompany: e.earnedGross + e.pfEmployer + e.esiEmployer,
      expectedDebit: r2(expDr), bookedDebit: r2(bkDr), difference: r2(bkDr - expDr),
      journals: accr.concat(pay).map((j) => j.id),
      flags: [...new Set(flags)], ok: flags.length === 0, diffs,
    });
  }
  journals.filter((j) => !used.has(j.id)).forEach((j) => {
    const dr = j.lines.reduce((n, l) => n + paise(l.debit), 0);
    bookedLines([j]).forEach((v, k) => addTo(accountBooked, k, v.name, v.debit, v.credit));
    rows.push({
      entryId: j.referenceId, employeeId: j.employeeId, employeeCode: null, name: j.employeeName || '(no payroll record)',
      status: null, netPay: 0, costToCompany: 0, expectedDebit: 0, bookedDebit: r2(dr), difference: r2(dr),
      journals: [j.id], flags: ['ORPHAN'], ok: false, diffs: [],
    });
  });

  const byAccount = [...new Set([...accountExpected.keys(), ...accountBooked.keys()])].sort().map((code) => {
    const e = accountExpected.get(code) || { debit: 0, credit: 0 };
    const b = accountBooked.get(code) || { debit: 0, credit: 0 };
    return {
      accountCode: code, accountName: e.name || b.name,
      expectedDebit: r2(e.debit), bookedDebit: r2(b.debit), expectedCredit: r2(e.credit), bookedCredit: r2(b.credit),
      ok: e.debit === b.debit && e.credit === b.credit,
    };
  });
  const hrms = await monthlyPayrollTotals(month);
  const salaryExpense = accountBooked.get('5100') || { debit: 0 };
  const payable = accountBooked.get('2100') || { credit: 0, debit: 0 };
  const legacy = hrms.source === 'legacy-run';
  return {
    month, period: monthLabel(month),
    source: hrms.source,
    note: legacy ? `${monthLabel(month)} was processed as a month run before per-employee payroll and the ledger existed; nothing was booked to the journal for it, so there is nothing to reconcile.` : null,
    hrms: {
      employees: hrms.employees, grossPay: hrms.grossPay, earnedGross: hrms.earnedGross, net: hrms.net,
      employerContributions: hrms.employerContributions, totalCost: hrms.totalCost, paid: hrms.paid,
    },
    ledger: {
      salaryExpense: r2(salaryExpense.debit), payableToEmployees: r2(payable.credit), paidFromPayable: r2(payable.debit),
      journals: journals.length,
    },
    difference: legacy ? null : r2(salaryExpense.debit - Math.round(hrms.totalCost * 100)),
    mismatches: rows.filter((r) => !r.ok).length,
    rows,
    byAccount,
  };
}

// S3 (2026-10-05): HRMS vs ledger for a month booked as ONE journal.
// Expected = the approved records' totals on the mapped ledgers (+ the salary
// payment once paid); booked = every HRMS-payroll journal line of the month,
// reversals included (so a reversed posting nets to zero).
async function reconciliation(month) {
  // eslint-disable-next-line global-require
  const P = require('./payrollPosting');
  const legacyJournals = await prisma.journalEntry.count({ where: { month, referenceType: { in: ['PAYROLL_RUN', 'PAYROLL_PAYMENT'] } } });
  if (legacyJournals) return legacyReconciliation(month);
  const [entries, st, { map }, index] = await Promise.all([
    prisma.employeePayrollRun.findMany({ where: { month }, include: { employee: true }, orderBy: { employee: { name: 'asc' } } }),
    P.monthState(month),
    P.getMapping(),
    accountIndex(),
  ]);
  const journals = st.runId ? await prisma.journalEntry.findMany({
    where: {
      source: 'HRMS_PAYROLL',
      OR: [
        { referenceType: { in: ['PAYROLL_MONTH', 'PAYROLL_MONTH_PAYMENT'] }, referenceId: st.runId },
        { referenceType: 'REVERSAL', idempotencyKey: { startsWith: `payroll-month:${st.runId}:` } },
      ],
    },
    include: { lines: true },
  }) : [];
  const codeOf = (k) => { const a = index.get(String(map[k]).toLowerCase()); return a ? a : { code: map[k], name: map[k] }; };
  const final = entries.filter((e) => FINAL_STATUSES.includes(e.status));
  const expected = new Map();
  P.COMPONENTS.forEach((c) => {
    const amt = final.reduce((n, e) => n + paise(c.amount(e) || 0), 0);
    if (!amt) return;
    const a = codeOf(c.key);
    addTo(expected, a.code, a.name, c.side === 'debit' ? amt : 0, c.side === 'credit' ? amt : 0);
  });
  const paidNet = entries.filter((e) => e.status === 'PAID').reduce((n, e) => n + paise(e.netPay), 0);
  const payJe = journals.find((j) => j.referenceType === 'PAYROLL_MONTH_PAYMENT');
  if (paidNet) {
    const sp = codeOf('salaryPayable');
    addTo(expected, sp.code, sp.name, paidNet, 0);
    const bankLine = payJe && payJe.lines.find((l) => l.credit > 0);
    const bk = bankLine ? { code: bankLine.accountCode, name: bankLine.accountName } : codeOf('bank');
    addTo(expected, bk.code, bk.name, 0, paidNet);
  }
  const booked = bookedLines(journals);
  const byAccount = [...new Set([...expected.keys(), ...booked.keys()])].sort().map((code) => {
    const e = expected.get(code) || { debit: 0, credit: 0 };
    const b = booked.get(code) || { debit: 0, credit: 0 };
    // Compare the NET movement (a reversal books the mirror on both sides).
    const eNet = e.debit - e.credit;
    const bNet = b.debit - b.credit;
    return {
      accountCode: code, accountName: e.name || b.name,
      expectedDebit: r2(Math.max(eNet, 0)), bookedDebit: r2(Math.max(bNet, 0)), expectedCredit: r2(Math.max(-eNet, 0)), bookedCredit: r2(Math.max(-bNet, 0)),
      ok: eNet === bNet,
    };
  });
  const rows = entries.filter((e) => FINAL_STATUSES.includes(e.status)).map((e) => {
    const cost = paise(e.earnedGross + e.pfEmployer + e.esiEmployer);
    const flags = [];
    if (!st.posted) flags.push('NOT_BOOKED');
    if (e.status === 'PAID' && !st.payment) flags.push('PAYMENT_MISSING');
    return {
      entryId: e.id, employeeId: e.employeeId, employeeCode: e.employee.employeeCode, name: e.employee.name,
      status: e.status, netPay: e.netPay, costToCompany: r2(cost),
      expectedDebit: r2(cost), bookedDebit: st.posted ? r2(cost) : 0, difference: st.posted ? 0 : r2(-cost),
      journals: st.journalEntry ? [st.journalEntry.id] : [], flags, ok: flags.length === 0, diffs: [],
    };
  });
  const hrms = await monthlyPayrollTotals(month);
  const expenseCodes = ['salary', 'employerPf', 'employerEsi'].map((k) => codeOf(k).code);
  const bookedExpense = expenseCodes.reduce((n, c) => { const b = booked.get(c); return n + (b ? b.debit - b.credit : 0); }, 0);
  const sp = booked.get(codeOf('salaryPayable').code) || { debit: 0, credit: 0 };
  const legacy = hrms.source === 'legacy-run';
  return {
    month, period: monthLabel(month), source: hrms.source, mode: 'month',
    note: legacy ? `${monthLabel(month)} was processed as a month run before per-employee payroll and the ledger existed; nothing was booked to the journal for it, so there is nothing to reconcile.`
      : st.records && !st.finalized ? `${st.blockReason}` : null,
    posted: st.posted, journalEntryId: st.journalEntry ? st.journalEntry.id : null,
    hrms: {
      employees: hrms.employees, grossPay: hrms.grossPay, earnedGross: hrms.earnedGross, net: hrms.net,
      employerContributions: hrms.employerContributions, totalCost: hrms.totalCost, paid: hrms.paid,
    },
    ledger: { salaryExpense: r2(bookedExpense), payableToEmployees: r2(sp.credit), paidFromPayable: r2(sp.debit), journals: journals.length },
    difference: legacy ? null : r2(bookedExpense - Math.round(hrms.totalCost * 100)),
    mismatches: rows.filter((r) => !r.ok).length + byAccount.filter((a) => !a.ok).length,
    rows,
    byAccount,
  };
}

// ---- Compliance -------------------------------------------------------------
async function compliance({ month = null, year = null, includeDraft = false }) {
  const statuses = includeDraft ? ['DRAFT', 'PENDING_APPROVAL', ...FINAL_STATUSES] : FINAL_STATUSES;
  if (month) {
    const entries = await prisma.employeePayrollRun.findMany({
      where: { month, status: { in: statuses } }, include: { employee: true }, orderBy: { employee: { name: 'asc' } },
    });
    const rows = entries.map((e) => ({
      entryId: e.id, employeeCode: e.employee.employeeCode, name: e.employee.name, department: e.employee.department,
      uan: e.employee.uanNumber || null, pfNumber: e.employee.pfNumber || null, esiNumber: e.employee.esiNumber || null, pan: e.employee.panNumber || null,
      status: e.status, earnedGross: e.earnedGross,
      pfEmployee: e.pfEmployee, pfEmployer: e.pfEmployer, pfTotal: e.pfEmployee + e.pfEmployer,
      esiEmployee: e.esiEmployee, esiEmployer: e.esiEmployer, esiTotal: e.esiEmployee + e.esiEmployer,
      tds: e.tds, professionalTax: e.professionalTax,
    }));
    const keys = ['earnedGross', 'pfEmployee', 'pfEmployer', 'pfTotal', 'esiEmployee', 'esiEmployer', 'esiTotal', 'tds', 'professionalTax'];
    const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((n, r) => n + r[k], 0)]));
    totals.employees = rows.length;
    totals.esiEmployees = rows.filter((r) => r.esiTotal > 0).length;
    totals.pfEmployees = rows.filter((r) => r.pfTotal > 0).length;
    return { month, period: monthLabel(month), statuses, rows, totals };
  }
  const y = Number(year) || new Date().getFullYear();
  const entries = await prisma.employeePayrollRun.findMany({ where: { year: y, status: { in: statuses } } });
  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const list = entries.filter((e) => e.month === key);
    const s = (k) => list.reduce((n, e) => n + e[k], 0);
    months.push({
      month: key, period: monthLabel(key), employees: list.length, earnedGross: s('earnedGross'),
      pfEmployee: s('pfEmployee'), pfEmployer: s('pfEmployer'), pfTotal: s('pfEmployee') + s('pfEmployer'),
      esiEmployee: s('esiEmployee'), esiEmployer: s('esiEmployer'), esiTotal: s('esiEmployee') + s('esiEmployer'),
      tds: s('tds'), professionalTax: s('professionalTax'),
    });
  }
  const keys = ['employees', 'earnedGross', 'pfEmployee', 'pfEmployer', 'pfTotal', 'esiEmployee', 'esiEmployer', 'esiTotal', 'tds', 'professionalTax'];
  const totals = Object.fromEntries(keys.map((k) => [k, months.reduce((n, r) => n + r[k], 0)]));
  return { year: y, statuses, months, totals };
}

module.exports = { reconciliation, legacyReconciliation, compliance };

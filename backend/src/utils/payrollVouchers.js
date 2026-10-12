// ---------------------------------------------------------------------------
// EMPLOYEE-WISE SALARY IN THE ACCOUNTS JOURNAL (user spec 2026-10-09).
//
//   PAYROLL voucher     ONE per payroll run (month), "Payroll October 2026".
//                       Per employee, one group of lines that balances on its own:
//                         Dr Salary Expense (earned gross)
//                         Dr Employer PF / ESI expense (if booked)
//                            Cr PF payable, ESI payable, TDS payable, PT payable,
//                            Cr Other deductions payable, Cr Salary payable (net)
//                       every line carries employee id / name / department / run id.
//   PAYMENT voucher     per payment batch: per employee Dr Salary payable /
//                       Cr Bank (or Cash). Paid on, mode and UTR per employee.
//                       Employee status: Paid / Unpaid / Partially paid.
//   ADJUSTMENT voucher  a posted voucher is never edited: arrears or a changed
//                       deduction is booked as a separate signed voucher.
//
// Amounts are whole paise in every sum (never floats added up). The voucher
// and its PayrollVoucherEmployee rows are written in ONE transaction by
// ledger.postJournal (which also refuses a voucher whose employee group, or
// the voucher itself, does not balance).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const L = require('./ledger');
const { monthLabel } = require('./attendanceMath');
const { logAudit } = require('./audit');
const { PayrollError } = require('./payrollEngine');

const P = (n) => Math.round((Number(n) || 0) * 100);
const R = (p) => p / 100;
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

const VOUCHER = { PAYROLL: 'Payroll', PAYMENT: 'Payment', ADJUSTMENT: 'Payroll adjustment' };
const SALARY_TYPES = [VOUCHER.PAYROLL, VOUCHER.PAYMENT, VOUCHER.ADJUSTMENT];
const STATUS_LABEL = { UNPAID: 'Unpaid', PARTIAL: 'Partially paid', PAID: 'Paid' };
const MODES = ['Bank transfer', 'Cash', 'Cheque'];

const LABEL = {
  salary: 'Salary expense', employerPf: 'Employer PF expense', employerEsi: 'Employer ESI expense', pfPayable: 'PF payable',
  esiPayable: 'ESI payable', tdsPayable: 'TDS payable', ptPayable: 'Professional tax payable', otherPayable: 'Other deductions payable',
  salaryPayable: 'Salary payable',
};

const normMode = (m) => {
  const s = String(m || '').trim().toLowerCase();
  if (!s) return 'Bank transfer';
  if (s.startsWith('cash')) return 'Cash';
  if (s.startsWith('cheq') || s.startsWith('chec')) return 'Cheque';
  if (s.startsWith('bank') || s === 'neft' || s === 'rtgs' || s === 'imps' || s === 'upi') return 'Bank transfer';
  return null;
};

// Accounts and Admin roles only see who got how much (checked on the ROLE, not
// only on the Journal & Ledger permission, so a custom rule cannot widen it).
function isPrivileged(user) {
  // eslint-disable-next-line global-require
  const { roleForProduct, SET } = require('./permissions');
  const role = roleForProduct(user, 'accounts');
  return !!role && SET.ACCOUNTS.includes(role);
}

// A view of someone's salary leaves an audit row (at most one a minute per user and subject).
const seen = new Map();
async function auditView(user, action, entity, entityId, toValue) {
  if (!user) return;
  const k = `${user.id}|${action}|${entityId || ''}|${toValue || ''}`;
  const now = Date.now();
  if (seen.has(k) && now - seen.get(k) < 60000) return;
  seen.set(k, now);
  if (seen.size > 2000) seen.clear();
  await logAudit({ userId: user.id, actorName: user.name, action, entity, entityId: entityId || null, toValue: toValue || null });
}

// Voucher numbers: an entry's position in the (append-only) journal.
async function voucherMap() {
  const all = await prisma.journalEntry.findMany({ select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return new Map(all.map((e, i) => [e.id, `JV-${String(i + 1).padStart(5, '0')}`]));
}

// Which of these entries have been reversed (their ":reversal" twin exists).
async function reversedSet(entries) {
  if (!entries.length) return new Set();
  const keys = entries.map((e) => `${e.idempotencyKey}:reversal`);
  const revs = await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } });
  const have = new Set(revs.map((r) => r.idempotencyKey.replace(/:reversal$/, '')));
  return new Set(entries.filter((e) => have.has(e.idempotencyKey)).map((e) => e.id));
}

// ---- 1. THE PURE BUILDER ---------------------------------------------------------------------
// entry: an EmployeePayrollRun (with .employee { name, employeeCode, department }) or any
// object with the same numeric fields. accounts: the resolved payroll mapping (key -> ledger).
function employeeGroup(e, accounts, { includeEmployer = true, plug = false } = {}) {
  const emp = e.employee || {};
  const name = emp.name || e.employeeName || 'Employee';
  const earned = P(e.earnedGross);
  const pf = P(e.pfEmployee); const esi = P(e.esiEmployee); const tds = P(e.tds);
  const pt = P(e.professionalTax); const other = P(e.otherDeductions); const net = P(e.netPay);
  const erPf = includeEmployer ? P(e.pfEmployer) : 0;
  const erEsi = includeEmployer ? P(e.esiEmployer) : 0;
  // Positive: the credits fall short of the debits (the register paid more than gross less deductions explain).
  const diff = earned - (pf + esi + tds + pt + other + net);
  const ref = { employee_id: e.employeeId, employee_name: name, department: emp.department || null };
  const lines = [];
  const add = (side, key, p, label) => {
    if (!p) return;
    lines.push({ side, account: accounts[key].code, amount: R(p), memo: `${label} - ${name}`, ...ref });
  };
  add('debit', 'salary', earned, LABEL.salary);
  add('debit', 'employerPf', erPf, LABEL.employerPf);
  add('debit', 'employerEsi', erEsi, LABEL.employerEsi);
  add('credit', 'pfPayable', pf + erPf, LABEL.pfPayable);
  add('credit', 'esiPayable', esi + erEsi, LABEL.esiPayable);
  add('credit', 'tdsPayable', tds, LABEL.tdsPayable);
  add('credit', 'ptPayable', pt, LABEL.ptPayable);
  add('credit', 'otherPayable', other, LABEL.otherPayable);
  if (diff !== 0 && plug) add(diff > 0 ? 'credit' : 'debit', 'otherPayable', Math.abs(diff), 'Pay register difference');
  add('credit', 'salaryPayable', net, LABEL.salaryPayable);
  const dr = lines.filter((l) => l.side === 'debit').reduce((n, l) => n + P(l.amount), 0);
  const cr = lines.filter((l) => l.side === 'credit').reduce((n, l) => n + P(l.amount), 0);
  return {
    name, lines, diff, balanced: dr === cr, dr, cr,
    row: {
      kind: 'PAYROLL', employeeId: e.employeeId, employeeCode: emp.employeeCode || e.employeeCode || null, employeeName: name,
      department: emp.department || null, entryId: e.id || null, payslipId: e.payslipId || null,
      fullGross: R(P(e.grossPay)), lossOfPay: R(P(e.lopDeduction)), earnedGross: R(earned),
      pf: R(pf), esi: R(esi), tds: R(tds), professionalTax: R(pt), otherDeductions: R(other),
      registerDifference: plug ? R(diff) : 0, netPay: R(net), employerPf: R(erPf), employerEsi: R(erEsi),
      payStatus: 'UNPAID', paidAmount: 0,
    },
  };
}

const codeKey = (c) => String(c || '').replace(/(\d+)/g, (m) => m.padStart(8, '0')).toLowerCase();

function buildVoucher({ entries, accounts, includeEmployer = true, plug = false }) {
  const sorted = [...entries].sort((a, b) => {
    const ca = codeKey((a.employee || {}).employeeCode); const cb = codeKey((b.employee || {}).employeeCode);
    return ca < cb ? -1 : ca > cb ? 1 : String((a.employee || {}).name || '').localeCompare(String((b.employee || {}).name || ''));
  });
  const groups = sorted.map((e) => employeeGroup(e, accounts, { includeEmployer, plug }));
  const problems = groups.filter((g) => !g.balanced).map((g) => ({
    employeeId: g.row.employeeId, name: g.name, code: g.row.employeeCode, differencePaise: g.diff,
  }));
  const lines = groups.flatMap((g) => g.lines);
  const rows = groups.map((g) => g.row);
  const sum = (k) => rows.reduce((n, r) => n + P(r[k]), 0);
  const totals = {
    employees: rows.length,
    debitPaise: groups.reduce((n, g) => n + g.dr, 0),
    creditPaise: groups.reduce((n, g) => n + g.cr, 0),
    grossPaise: sum('earnedGross'), netPaise: sum('netPay'),
    deductionsPaise: sum('pf') + sum('esi') + sum('tds') + sum('professionalTax') + sum('otherDeductions') + sum('registerDifference'),
    employerPaise: sum('employerPf') + sum('employerEsi'),
  };
  return { lines, rows, totals, problems };
}

function problemText(problems, month) {
  const list = problems.slice(0, 4).map((p) => `${p.name}${p.code ? ` (${p.code})` : ''}: ₹${(Math.abs(p.differencePaise) / 100).toFixed(2)} ${p.differencePaise > 0 ? 'less pay than gross less deductions' : 'more pay than gross less deductions'}`).join('; ');
  return `${monthLabel(month)} cannot be posted: ${problems.length} employee(s) do not balance (${list}${problems.length > 4 ? '; …' : ''}). Recalculate those records or book the difference on purpose.`;
}

// ---- 2. POSTING THE RUN -----------------------------------------------------------------------
async function assertOpenPeriod(dateStr) {
  const month = String(dateStr).slice(0, 7);
  if (await L.isClosedMonth(month)) {
    const c = await L.closedUpTo();
    throw new PayrollError(409, `The books are closed up to ${monthLabel(c)}, so nothing can be booked on ${dateStr}. Open the month in Journal & Ledger → Payroll Mapping → Books closed up to, or use a later date.`);
  }
}

// opts: { key, version, actor, plug, includeEmployer, dateOverride, skipClosedCheck }
async function postRunVoucher({ month, run, entries, accounts, actor, key, plug = false, includeEmployer = true, skipClosedCheck = false, extra = null }) {
  const built = buildVoucher({ entries, accounts, includeEmployer, plug });
  if (built.problems.length) throw new PayrollError(422, problemText(built.problems, month), { problems: built.problems });
  if (!built.totals.debitPaise) throw new PayrollError(422, `The payroll for ${monthLabel(month)} has no amount to post.`);
  const date = L.monthEnd(month);
  if (!skipClosedCheck) await assertOpenPeriod(date);
  const [year, monthNum] = month.split('-').map(Number);
  const rows = built.rows.map((r) => ({ ...r, payrollRunId: run.id, month }));
  const payload = {
    month: monthNum, year, date,
    narration: `Payroll ${monthLabel(month)}`,
    voucher_type: VOUCHER.PAYROLL,
    source: 'HRMS_PAYROLL', reference_type: 'PAYROLL_MONTH', reference_id: run.id, payroll_run_id: run.id,
    idempotency_key: key, employees: built.rows.length,
    posted_by: actor ? actor.name : 'System',
    ...(extra || {}),
    lines: built.lines,
  };
  const result = await L.postJournal(payload, { actor: actor || { id: null, name: 'System' }, employeeRows: rows });
  return { ...result, built };
}

// ---- 3. THE CURRENT VOUCHER OF A RUN -----------------------------------------------------------
async function currentAccrual(runId) {
  const postings = await prisma.journalEntry.findMany({ where: { referenceType: 'PAYROLL_MONTH', referenceId: runId }, orderBy: { createdAt: 'asc' } });
  const rev = await reversedSet(postings);
  return [...postings].reverse().find((p) => !rev.has(p.id)) || null;
}

// Rows of a voucher + the run's live adjustments, per employee.
async function runPosition(runId, accrual) {
  const rows = await prisma.payrollVoucherEmployee.findMany({ where: { journalEntryId: accrual.id, kind: 'PAYROLL' } });
  const adjRows = await prisma.payrollVoucherEmployee.findMany({ where: { payrollRunId: runId, kind: 'ADJUSTMENT' } });
  const adjEntries = adjRows.length ? await prisma.journalEntry.findMany({ where: { id: { in: [...new Set(adjRows.map((a) => a.journalEntryId))] } }, select: { id: true, idempotencyKey: true } }) : [];
  const adjRev = await reversedSet(adjEntries);
  const live = adjRows.filter((a) => !adjRev.has(a.journalEntryId));
  const adjOf = new Map();
  live.forEach((a) => adjOf.set(a.employeeId, (adjOf.get(a.employeeId) || 0) + P(a.netPay)));
  return rows.map((r) => {
    const adjP = adjOf.get(r.employeeId) || 0;
    const duePaise = P(r.netPay) + adjP;
    const paidPaise = P(r.paidAmount);
    return { ...r, adjustmentPaise: adjP, duePaise, paidPaise, balancePaise: duePaise - paidPaise };
  });
}

const statusFor = (duePaise, paidPaise) => (paidPaise <= 0 && duePaise > 0 ? 'UNPAID' : paidPaise >= duePaise ? 'PAID' : 'PARTIAL');

// ---- 4. PAYING SALARY ---------------------------------------------------------------------------
// opts: { items: [{ employeeId, amount?, reference? }] | null (everyone unpaid), date, mode, reference,
//         bankAccountId, bankTransactionId, hooks: { onStart(key, payload), onFinish(result) } }
async function payRun(month, actor, opts = {}) {
  // eslint-disable-next-line global-require
  const PP = require('./payrollPosting');
  const st = await PP.monthState(month);
  if (!st.runId) throw new PayrollError(404, `There is no payroll run for ${monthLabel(month)}.`);
  if (!st.posted) throw new PayrollError(409, `Post ${monthLabel(month)} to Accounts first - the salary payment clears the Salary Payable it books.`);
  const accrual = st.journalEntry;
  const position = await runPosition(st.runId, accrual);
  if (!position.length) return null; // an older, totals-only voucher: the caller uses the whole-month path
  const mode = normMode(opts.mode);
  if (!mode) throw new PayrollError(400, 'Pick how it was paid: Bank transfer, Cash or Cheque.');
  const date = isDate(opts.date) ? opts.date : new Date().toISOString().slice(0, 10);
  const byEmp = new Map(position.map((p) => [p.employeeId, p]));
  let targets;
  if (opts.items) {
    targets = [];
    for (const it of opts.items) {
      const p = byEmp.get(it.employeeId);
      if (!p) throw new PayrollError(400, 'One of the employees is not in this payroll voucher.');
      const amount = it.amount == null || it.amount === '' ? p.balancePaise : P(it.amount);
      if (!(amount > 0)) throw new PayrollError(400, `${p.employeeName}: enter an amount above 0.`);
      if (amount > p.balancePaise) throw new PayrollError(409, `${p.employeeName}: ₹${R(amount).toFixed(2)} is more than the ₹${R(p.balancePaise).toFixed(2)} still owed.`);
      targets.push({ p, amount, reference: it.reference ? String(it.reference).slice(0, 120) : (opts.reference ? String(opts.reference).slice(0, 120) : null) });
    }
  } else {
    targets = position.filter((p) => p.balancePaise > 0).map((p) => ({ p, amount: p.balancePaise, reference: opts.reference ? String(opts.reference).slice(0, 120) : null }));
  }
  if (!targets.length) {
    if (position.every((p) => p.balancePaise <= 0)) return { ok: true, already: true, state: await PP.monthState(month) };
    throw new PayrollError(409, 'Pick at least one employee to pay.');
  }
  const dup = new Set();
  targets.forEach((t) => { if (dup.has(t.p.employeeId)) throw new PayrollError(400, `${t.p.employeeName} is listed twice.`); dup.add(t.p.employeeId); });
  if (!opts.skipClosedCheck) await assertOpenPeriod(date);
  // The records of the people paid must be posted (Synced) or already Paid.
  const eprs = await prisma.employeePayrollRun.findMany({ where: { month, employeeId: { in: targets.map((t) => t.p.employeeId) } }, select: { id: true, employeeId: true, status: true } });
  if (eprs.some((e) => !['SYNCED_TO_ACCOUNTS', 'PAID'].includes(e.status))) throw new PayrollError(409, 'Every record being paid must be posted to Accounts first.');
  const eprOf = new Map(eprs.map((e) => [e.employeeId, e]));

  const { map } = await PP.getMapping();
  const accounts = await PP.resolveMapping(map);
  let creditAcct;
  if (mode === 'Cash') creditAcct = await L.ensureAccount({ code: '1000', name: 'Cash', type: 'ASSET', description: 'Cash in hand' });
  else creditAcct = opts.bankAccountId ? await PP.bankLedger(opts.bankAccountId) : accounts.bank;
  const totalP = targets.reduce((n, t) => n + t.amount, 0);

  let txn = null;
  if (opts.bankTransactionId) {
    txn = await prisma.bankTransaction.findUnique({ where: { id: opts.bankTransactionId } });
    if (!txn) throw new PayrollError(400, 'That bank statement line does not exist.');
    if (txn.type !== 'Debit') throw new PayrollError(400, 'A salary payment is money going out (a Debit) on the statement.');
    if (txn.matched || txn.reconStatus !== 'Unmatched') throw new PayrollError(409, 'That bank statement line is already matched to something else.');
    if (Math.round(Number(txn.amount) * 100) !== totalP) throw new PayrollError(400, `The bank line (₹${txn.amount}) is not the total being paid (₹${R(totalP).toFixed(2)}).`);
    if (opts.bankAccountId && txn.bankAccountId && txn.bankAccountId !== opts.bankAccountId) throw new PayrollError(400, 'That statement line belongs to another bank account.');
  }

  const baseKey = PP.paymentKey(st.runId, st.journalEntry.version);
  // The first payment has the base key, a later batch adds ":<n>" (matched exactly, so v1 never counts v10).
  const existingPays = await prisma.journalEntry.count({ where: { referenceType: 'PAYROLL_MONTH_PAYMENT', referenceId: st.runId, OR: [{ idempotencyKey: baseKey }, { idempotencyKey: { startsWith: `${baseKey}:` } }] } });
  const key = existingPays === 0 ? baseKey : `${baseKey}:${existingPays + 1}`;
  const lines = [];
  targets.forEach((t) => {
    const ref = { employee_id: t.p.employeeId, employee_name: t.p.employeeName, department: t.p.department || null };
    lines.push({ side: 'debit', account: accounts.salaryPayable.code, amount: R(t.amount), memo: `Salary payable - ${t.p.employeeName}`, ...ref });
    lines.push({ side: 'credit', account: creditAcct.code, amount: R(t.amount), memo: `Salary paid - ${t.p.employeeName} · ${mode}${t.reference ? ` · ${t.reference}` : ''}`, ...ref });
  });
  const [y, m] = date.split('-').map(Number);
  const everyone = position.filter((p) => p.balancePaise > 0).length;
  const payload = {
    month: m, year: y, date,
    narration: `Salary paid for ${monthLabel(month)}${targets.length < everyone ? ` (${targets.length} of ${everyone} unpaid employees)` : ''}${opts.reference ? ` (ref ${String(opts.reference).slice(0, 80)})` : ''}`,
    voucher_type: VOUCHER.PAYMENT, source: 'HRMS_PAYROLL',
    reference_type: 'PAYROLL_MONTH_PAYMENT', reference_id: st.runId, payroll_run_id: st.runId, idempotency_key: key,
    bank_account_id: opts.bankAccountId || null, bank_transaction_id: txn ? txn.id : null,
    posted_by: actor ? actor.name : 'System', ...(opts.extra || {}), lines,
  };
  if (opts.hooks && opts.hooks.onStart) await opts.hooks.onStart(key, payload);
  const who = actor ? actor.name : 'System';
  let result;
  try {
    result = await L.postJournal(payload, {
      actor: actor || { id: null, name: 'System' },
      afterBook: async (tx, je) => {
        for (const t of targets) {
          // eslint-disable-next-line no-await-in-loop
          await tx.payrollVoucherPayment.create({
            data: {
              journalEntryId: je.id, accrualEntryId: accrual.id, payrollRunId: st.runId, month, employeeId: t.p.employeeId, employeeName: t.p.employeeName,
              amount: R(t.amount), paidOn: date, mode, reference: t.reference, bankAccountId: opts.bankAccountId || null, createdByName: who,
            },
          });
          const paidNow = t.p.paidPaise + t.amount;
          const status = statusFor(t.p.duePaise, paidNow);
          // eslint-disable-next-line no-await-in-loop
          await tx.payrollVoucherEmployee.update({
            where: { id: t.p.id },
            data: { paidAmount: R(paidNow), payStatus: status, paidOn: date, payMode: mode, payRef: t.reference, paymentJournalEntryId: je.id },
          });
          const epr = eprOf.get(t.p.employeeId);
          if (epr && status === 'PAID' && epr.status !== 'PAID') {
            // eslint-disable-next-line no-await-in-loop
            await tx.employeePayrollRun.update({
              where: { id: epr.id },
              data: { status: 'PAID', paidBy: who, paidAt: new Date(`${date}T12:00:00`), paymentJournalEntryId: je.id, bankTransactionId: txn ? txn.id : null, paymentReference: t.reference },
            });
          }
        }
        if (txn) {
          await tx.bankTransaction.update({
            where: { id: txn.id },
            data: {
              matched: true, reconStatus: 'Matched', category: 'Salary', categoryKind: 'expense',
              counterparty: `Salary ${monthLabel(month)} (${targets.length} employee(s))`.slice(0, 190), matchedBy: who, matchedDate: new Date().toISOString().slice(0, 10),
            },
          });
        }
      },
    });
  } catch (err) {
    if (opts.hooks && opts.hooks.onFinish) await opts.hooks.onFinish({ ok: false, error: err.message });
    throw err;
  }
  if (opts.hooks && opts.hooks.onFinish) await opts.hooks.onFinish({ ok: true, entry: result.entry });
  // eslint-disable-next-line global-require
  const { refreshMonthRun } = require('./payrollEngine');
  await refreshMonthRun(month);
  if (!result.replay) {
    await logAudit({
      userId: actor && actor.id ? actor.id : null, actorName: who, action: 'Payroll salary paid (booked in Accounts)', entity: 'PayrollRun', entityId: st.runId,
      fromValue: 'Posted', toValue: `${targets.length} employee(s) · ₹${R(totalP).toFixed(2)} · ${creditAcct.name} · ${mode}${opts.reference ? ` · ${opts.reference}` : ''}`, reason: monthLabel(month),
    });
  }
  return { ok: true, entry: result.entry, replay: result.replay, paid: targets.length, state: await PP.monthState(month) };
}

// ---- 5. ADJUSTMENT VOUCHER ------------------------------------------------------------------------
const DELTA_KEYS = ['earnedGross', 'pf', 'esi', 'tds', 'professionalTax', 'otherDeductions'];
async function adjust(month, actor, { employeeId, deltas = {}, reason, date }) {
  // eslint-disable-next-line global-require
  const PP = require('./payrollPosting');
  const why = String(reason || '').trim();
  if (!why) throw new PayrollError(400, 'Say why this correction is needed.');
  const st = await PP.monthState(month);
  if (!st.runId || !st.posted) throw new PayrollError(409, `${monthLabel(month)} is not posted to Accounts yet - change the payroll record instead.`);
  const accrual = st.journalEntry;
  const position = await runPosition(st.runId, accrual);
  const p = position.find((x) => x.employeeId === employeeId);
  if (!p) throw new PayrollError(404, 'That employee is not in this payroll voucher.');
  const d = {};
  let any = false;
  DELTA_KEYS.forEach((k) => {
    const v = Number(deltas[k] || 0);
    if (!Number.isFinite(v)) throw new PayrollError(400, `${k} must be a number.`);
    if (Math.abs(P(v) - v * 100) > 1e-6) throw new PayrollError(400, 'Amounts can have at most 2 decimals.');
    d[k] = P(v);
    if (d[k]) any = true;
  });
  if (!any) throw new PayrollError(400, 'Enter at least one amount to change.');
  const netP = d.earnedGross - d.pf - d.esi - d.tds - d.professionalTax - d.otherDeductions;
  const when = isDate(date) ? date : new Date().toISOString().slice(0, 10);
  await assertOpenPeriod(when);
  const { map } = await PP.getMapping();
  const accounts = await PP.resolveMapping(map);
  const ref = { employee_id: p.employeeId, employee_name: p.employeeName, department: p.department || null };
  const lines = [];
  // A signed amount: positive on its natural side, negative on the other.
  const add = (natural, key, signed, label) => {
    if (!signed) return;
    const side = signed > 0 ? natural : (natural === 'debit' ? 'credit' : 'debit');
    lines.push({ side, account: accounts[key].code, amount: R(Math.abs(signed)), memo: `${label} (correction) - ${p.employeeName}`, ...ref });
  };
  add('debit', 'salary', d.earnedGross, LABEL.salary);
  add('credit', 'pfPayable', d.pf, LABEL.pfPayable);
  add('credit', 'esiPayable', d.esi, LABEL.esiPayable);
  add('credit', 'tdsPayable', d.tds, LABEL.tdsPayable);
  add('credit', 'ptPayable', d.professionalTax, LABEL.ptPayable);
  add('credit', 'otherPayable', d.otherDeductions, LABEL.otherPayable);
  add('credit', 'salaryPayable', netP, LABEL.salaryPayable);
  const n = (await prisma.payrollVoucherEmployee.count({ where: { payrollRunId: st.runId, employeeId, kind: 'ADJUSTMENT' } })) + 1;
  const key = `payroll-adj:${st.runId}:${employeeId}:${n}`;
  const [y, m] = when.split('-').map(Number);
  const who = actor ? actor.name : 'System';
  const payload = {
    month: m, year: y, date: when,
    narration: `Payroll adjustment ${monthLabel(month)} - ${p.employeeName}: ${why}`.slice(0, 480),
    voucher_type: VOUCHER.ADJUSTMENT, source: 'HRMS_PAYROLL', reference_type: 'PAYROLL_ADJUSTMENT', reference_id: st.runId, payroll_run_id: st.runId,
    idempotency_key: key, posted_by: who, lines,
  };
  const row = {
    kind: 'ADJUSTMENT', payrollRunId: st.runId, month, employeeId, employeeCode: p.employeeCode, employeeName: p.employeeName, department: p.department,
    entryId: p.entryId, payslipId: p.payslipId, fullGross: 0, lossOfPay: 0,
    earnedGross: R(d.earnedGross), pf: R(d.pf), esi: R(d.esi), tds: R(d.tds), professionalTax: R(d.professionalTax), otherDeductions: R(d.otherDeductions),
    registerDifference: 0, netPay: R(netP), employerPf: 0, employerEsi: 0, payStatus: 'UNPAID', paidAmount: 0, note: why.slice(0, 500),
  };
  const result = await L.postJournal(payload, {
    actor: actor || { id: null, name: 'System' },
    employeeRows: [row],
    afterBook: async (tx) => {
      const newDue = p.duePaise + netP;
      await tx.payrollVoucherEmployee.update({ where: { id: p.id }, data: { payStatus: statusFor(newDue, p.paidPaise) } });
    },
  });
  if (!result.replay) {
    await logAudit({
      userId: actor && actor.id ? actor.id : null, actorName: who, action: 'Payroll adjustment voucher booked', entity: 'JournalEntry', entityId: result.entry.id,
      toValue: `${p.employeeName} · ${monthLabel(month)} · net ${R(netP).toFixed(2)}`, reason: why,
    });
  }
  return { ok: true, entry: result.entry, replay: result.replay, voucherNo: (await voucherMap()).get(result.entry.id) || null };
}

// ---- 6. READS ------------------------------------------------------------------------------------
const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The employee-wise table of one voucher (Payroll / Payment / Adjustment).
function shapeRow(r, extra = {}) {
  const other = R(P(r.professionalTax) + P(r.otherDeductions) + P(r.registerDifference));
  return {
    id: r.id, employeeId: r.employeeId, employeeCode: r.employeeCode, name: r.employeeName, department: r.department,
    gross: r.earnedGross, fullGross: r.fullGross, lossOfPay: r.lossOfPay, pf: r.pf, esi: r.esi, tds: r.tds, other,
    professionalTax: r.professionalTax, otherOnly: r.otherDeductions, registerDifference: r.registerDifference,
    deductions: R(P(r.pf) + P(r.esi) + P(r.tds) + P(r.professionalTax) + P(r.otherDeductions) + P(r.registerDifference)),
    net: r.netPay, employerPf: r.employerPf, employerEsi: r.employerEsi, payslipId: r.payslipId, kind: r.kind, note: r.note,
    ...extra,
  };
}

function totalsOfRows(rows) {
  const keys = ['gross', 'pf', 'esi', 'tds', 'other', 'deductions', 'net', 'employerPf', 'employerEsi'];
  const t = { employees: rows.length };
  keys.forEach((k) => { t[k] = R(rows.reduce((n, r) => n + P(r[k]), 0)); });
  return t;
}

async function voucherDetail(entryId) {
  const entry = await prisma.journalEntry.findUnique({ where: { id: entryId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  if (!entry) return null;
  const vno = await voucherMap();
  const rev = await reversedSet([entry]);
  const base = {
    id: entry.id, voucherNo: vno.get(entry.id), voucherType: entry.voucherType || null, date: entry.date, month: entry.month, narration: entry.narration,
    totalDebit: entry.totalDebit, totalCredit: entry.totalCredit, reversed: rev.has(entry.id), isReversal: entry.referenceType === 'REVERSAL',
    payrollRunId: entry.payrollRunId, createdByName: entry.createdByName, createdAt: entry.createdAt,
  };
  const lines = entry.lines.map((l) => ({
    id: l.id, lineNo: l.lineNo, accountCode: l.accountCode, accountName: l.accountName, debit: l.debit, credit: l.credit, memo: l.memo,
    employeeId: l.employeeId || null, employeeName: l.employeeName || null, department: l.department || null,
  }));
  if (entry.voucherType === VOUCHER.PAYMENT) {
    const pays = await prisma.payrollVoucherPayment.findMany({ where: { journalEntryId: entry.id }, orderBy: { employeeName: 'asc' } });
    const eprs = await prisma.payrollVoucherEmployee.findMany({ where: { employeeId: { in: pays.map((p) => p.employeeId) }, kind: 'PAYROLL', journalEntryId: { in: [...new Set(pays.map((p) => p.accrualEntryId).filter(Boolean))] } } });
    const slip = new Map(eprs.map((r) => [r.employeeId, r]));
    const rows = pays.map((p) => {
      const r = slip.get(p.employeeId);
      return {
        id: p.id, employeeId: p.employeeId, employeeCode: r ? r.employeeCode : null, name: p.employeeName, department: r ? r.department : null,
        amount: p.amount, paidOn: p.paidOn, mode: p.mode, reference: p.reference, month: p.month, payslipId: r ? r.payslipId : null,
        status: r ? r.payStatus : null, statusLabel: r ? STATUS_LABEL[r.payStatus] : null,
      };
    });
    return { voucher: base, kind: 'PAYMENT', payments: rows, totals: { employees: rows.length, amount: R(rows.reduce((n, r) => n + P(r.amount), 0)) }, lines };
  }
  if (entry.voucherType === VOUCHER.ADJUSTMENT) {
    const rows = await prisma.payrollVoucherEmployee.findMany({ where: { journalEntryId: entry.id }, orderBy: { employeeName: 'asc' } });
    const shaped = rows.map((r) => shapeRow(r));
    return { voucher: base, kind: 'ADJUSTMENT', rows: shaped, totals: totalsOfRows(shaped), lines };
  }
  const rows = await prisma.payrollVoucherEmployee.findMany({ where: { journalEntryId: entry.id, kind: 'PAYROLL' } });
  if (!rows.length) return { voucher: base, kind: 'TOTALS_ONLY', rows: [], totals: null, lines: [] };
  const [adjAll, pays] = await Promise.all([
    prisma.payrollVoucherEmployee.findMany({ where: { payrollRunId: entry.payrollRunId, kind: 'ADJUSTMENT' } }),
    prisma.payrollVoucherPayment.findMany({ where: { accrualEntryId: entry.id } }),
  ]);
  const adjEntries = adjAll.length ? await prisma.journalEntry.findMany({ where: { id: { in: [...new Set(adjAll.map((a) => a.journalEntryId))] } }, select: { id: true, idempotencyKey: true, date: true } }) : [];
  const adjRev = await reversedSet(adjEntries);
  const liveAdj = adjAll.filter((a) => !adjRev.has(a.journalEntryId));
  const adjP = new Map();
  liveAdj.forEach((a) => adjP.set(a.employeeId, (adjP.get(a.employeeId) || 0) + P(a.netPay)));
  const payEntries = pays.length ? await prisma.journalEntry.findMany({ where: { id: { in: [...new Set(pays.map((p) => p.journalEntryId))] } }, select: { id: true } }) : [];
  const sorted = rows.map((r) => {
    const due = P(r.netPay) + (adjP.get(r.employeeId) || 0);
    return shapeRow(r, {
      adjustments: R(adjP.get(r.employeeId) || 0), due: R(due), paid: r.paidAmount, balance: R(due - P(r.paidAmount)),
      status: r.payStatus, statusLabel: STATUS_LABEL[r.payStatus] || r.payStatus, paidOn: r.paidOn, mode: r.payMode, reference: r.payRef,
      paymentVoucherNo: r.paymentJournalEntryId ? vno.get(r.paymentJournalEntryId) || null : null,
    });
  }).sort((a, b) => {
    const ca = codeKey(a.employeeCode); const cb = codeKey(b.employeeCode);
    return ca < cb ? -1 : ca > cb ? 1 : String(a.name).localeCompare(String(b.name));
  });
  const totals = totalsOfRows(sorted);
  totals.due = R(sorted.reduce((n, r) => n + P(r.due), 0));
  totals.paid = R(sorted.reduce((n, r) => n + P(r.paid), 0));
  totals.balance = R(sorted.reduce((n, r) => n + P(r.balance), 0));
  totals.paidEmployees = sorted.filter((r) => r.status === 'PAID').length;
  const adjustments = liveAdj.map((a) => ({
    id: a.id, journalEntryId: a.journalEntryId, voucherNo: vno.get(a.journalEntryId) || null, employeeId: a.employeeId, name: a.employeeName,
    gross: a.earnedGross, pf: a.pf, esi: a.esi, tds: a.tds, other: R(P(a.professionalTax) + P(a.otherDeductions)), net: a.netPay, note: a.note,
    date: (adjEntries.find((e) => e.id === a.journalEntryId) || {}).date || null,
  }));
  const payVouchers = payEntries.map((e) => ({ id: e.id, voucherNo: vno.get(e.id) || null }));
  return { voucher: base, kind: 'PAYROLL', rows: sorted, totals, adjustments, paymentVouchers: payVouchers, lines };
}

// ---- Filters (employee / department / payroll month / payment status) -------------------------
// The accrual rows that are live (their voucher is not reversed).
async function liveAccrualRows(where = {}) {
  const rows = await prisma.payrollVoucherEmployee.findMany({ where: { kind: 'PAYROLL', ...where } });
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map((r) => r.journalEntryId))];
  const entries = await prisma.journalEntry.findMany({ where: { id: { in: ids } }, select: { id: true, idempotencyKey: true } });
  const rev = await reversedSet(entries);
  return rows.filter((r) => !rev.has(r.journalEntryId));
}

const matchRow = (r, f, skip = '') => (
  (skip === 'employee' || !f.employeeId || r.employeeId === f.employeeId)
  && (skip === 'department' || !f.department || (r.department || 'Not set') === f.department)
  && (skip === 'month' || !f.payrollMonth || r.month === f.payrollMonth)
  && (skip === 'status' || !f.paymentStatus || r.payStatus === f.paymentStatus)
);

async function facets(f = {}) {
  const rows = await liveAccrualRows();
  const count = (list, keyOf) => { const m = new Map(); list.forEach((r) => { const k = keyOf(r); m.set(k, (m.get(k) || 0) + 1); }); return m; };
  const employees = new Map();
  rows.filter((r) => matchRow(r, f, 'employee')).forEach((r) => {
    const e = employees.get(r.employeeId) || { value: r.employeeId, label: r.employeeName, code: r.employeeCode, department: r.department, count: 0 };
    e.count += 1; employees.set(r.employeeId, e);
  });
  const deptC = count(rows.filter((r) => matchRow(r, f, 'department')), (r) => r.department || 'Not set');
  const monthC = count(rows.filter((r) => matchRow(r, f, 'month')), (r) => r.month);
  const statC = count(rows.filter((r) => matchRow(r, f, 'status')), (r) => r.payStatus);
  return {
    employees: [...employees.values()].sort((a, b) => String(a.label).localeCompare(String(b.label))),
    departments: [...deptC.entries()].map(([value, c]) => ({ value, label: value, count: c })).sort((a, b) => a.label.localeCompare(b.label)),
    months: [...monthC.entries()].map(([value, c]) => ({ value, label: monthLabel(value), count: c })).sort((a, b) => (a.value < b.value ? 1 : -1)),
    statuses: ['PAID', 'UNPAID', 'PARTIAL'].map((value) => ({ value, label: STATUS_LABEL[value], count: statC.get(value) || 0 })),
  };
}

// Which vouchers contain the filtered employees, plus the cards for that selection.
async function matching(f = {}) {
  const rows = (await liveAccrualRows()).filter((r) => matchRow(r, f));
  const accrualIds = new Set(rows.map((r) => r.journalEntryId));
  const runIds = [...new Set(rows.map((r) => r.payrollRunId).filter(Boolean))];
  const empIds = new Set(rows.map((r) => r.employeeId));
  // Adjustments and payments of the same people in the same runs.
  const adjRows = runIds.length ? await prisma.payrollVoucherEmployee.findMany({ where: { kind: 'ADJUSTMENT', payrollRunId: { in: runIds }, employeeId: { in: [...empIds] } } }) : [];
  const adjEntries = adjRows.length ? await prisma.journalEntry.findMany({ where: { id: { in: [...new Set(adjRows.map((a) => a.journalEntryId))] } }, select: { id: true, idempotencyKey: true } }) : [];
  const adjRev = await reversedSet(adjEntries);
  const liveAdj = adjRows.filter((a) => !adjRev.has(a.journalEntryId) && rows.some((r) => r.payrollRunId === a.payrollRunId && r.employeeId === a.employeeId));
  const payRows = runIds.length ? await prisma.payrollVoucherPayment.findMany({ where: { payrollRunId: { in: runIds }, employeeId: { in: [...empIds] } } }) : [];
  const livePays = payRows.filter((p) => rows.some((r) => r.payrollRunId === p.payrollRunId && r.employeeId === p.employeeId));
  const ids = new Set(accrualIds);
  if (!f.paymentStatus) {
    liveAdj.forEach((a) => ids.add(a.journalEntryId));
    livePays.forEach((p) => ids.add(p.journalEntryId));
  }
  // Per-voucher scope: only the filtered employees' amounts count in a voucher's totals.
  const scope = new Map();
  const bump = (id, net, gross, ded, n, amount, paid = 0) => {
    const s = scope.get(id) || { employees: new Set(), net: 0, gross: 0, deductions: 0, paid: 0, amount: 0 };
    s.net += net; s.gross += gross; s.deductions += ded; s.amount += amount; s.paid += paid; if (n) s.employees.add(n);
    scope.set(id, s);
  };
  // amount = what the voucher moves for the people in scope: gross + employer cost, a payment, or a correction's net.
  rows.forEach((r) => bump(r.journalEntryId, P(r.netPay), P(r.earnedGross), P(r.pf) + P(r.esi) + P(r.tds) + P(r.professionalTax) + P(r.otherDeductions) + P(r.registerDifference), r.employeeId, P(r.earnedGross) + P(r.employerPf) + P(r.employerEsi)));
  liveAdj.forEach((a) => bump(a.journalEntryId, P(a.netPay), P(a.earnedGross), P(a.pf) + P(a.esi) + P(a.tds) + P(a.professionalTax) + P(a.otherDeductions), a.employeeId, P(a.netPay)));
  livePays.forEach((p) => bump(p.journalEntryId, 0, 0, 0, p.employeeId, P(p.amount), P(p.amount)));
  // Cards
  let due = 0; let paid = 0; let net = 0;
  const monthsPaid = new Set();
  const pendingMonths = new Set();
  rows.forEach((r) => {
    const adj = liveAdj.filter((a) => a.payrollRunId === r.payrollRunId && a.employeeId === r.employeeId).reduce((n, a) => n + P(a.netPay), 0);
    const d = P(r.netPay) + adj;
    net += d; due += d; paid += P(r.paidAmount);
    if (r.payStatus === 'PAID') monthsPaid.add(r.month); else pendingMonths.add(r.month);
  });
  return {
    ids, rows, scope, accrualIds,
    cards: { netPay: R(net), monthsPaid: monthsPaid.size, months: new Set(rows.map((r) => r.month)).size, pending: R(Math.max(0, due - paid)), pendingMonths: pendingMonths.size, employees: empIds.size },
  };
}

// A summary of employee-wise vouchers for the Journal list: id -> { employees, net, deductions, gross, paid }
async function summariesFor(entries, scope = null) {
  const out = new Map();
  const ids = entries.filter((e) => SALARY_TYPES.includes(e.voucherType)).map((e) => e.id);
  if (!ids.length) return out;
  const rows = await prisma.payrollVoucherEmployee.findMany({ where: { journalEntryId: { in: ids } } });
  const pays = await prisma.payrollVoucherPayment.findMany({ where: { journalEntryId: { in: ids } } });
  ids.forEach((id) => out.set(id, { employees: new Set(), net: 0, deductions: 0, gross: 0, paid: 0, paidEmployees: new Set(), unpaid: 0 }));
  rows.forEach((r) => {
    const s = out.get(r.journalEntryId);
    if (!s) return;
    s.employees.add(r.employeeId); s.net += P(r.netPay); s.gross += P(r.earnedGross);
    s.deductions += P(r.pf) + P(r.esi) + P(r.tds) + P(r.professionalTax) + P(r.otherDeductions) + P(r.registerDifference);
    if (r.kind === 'PAYROLL') { if (r.payStatus === 'PAID') s.paidEmployees.add(r.employeeId); else s.unpaid += 1; }
  });
  pays.forEach((p) => { const s = out.get(p.journalEntryId); if (s) { s.employees.add(p.employeeId); s.paid += P(p.amount); } });
  return out;
}

// ---- 7. THE EMPLOYEE'S MONTHS: sub-ledger and salary statement ---------------------------------------
async function employeeMonths(employeeId, { from = null, to = null } = {}) {
  const monthWhere = {};
  if (from) monthWhere.gte = from;
  if (to) monthWhere.lte = to;
  const mw = Object.keys(monthWhere).length ? { month: monthWhere } : {};
  const [rowsAll, paysAll, vno] = await Promise.all([
    prisma.payrollVoucherEmployee.findMany({ where: { employeeId, ...mw }, orderBy: { month: 'asc' } }),
    prisma.payrollVoucherPayment.findMany({ where: { employeeId, ...mw }, orderBy: { paidOn: 'asc' } }),
    voucherMap(),
  ]);
  const entryIds = [...new Set([...rowsAll.map((r) => r.journalEntryId), ...paysAll.map((p) => p.journalEntryId)])];
  const entries = entryIds.length ? await prisma.journalEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, idempotencyKey: true, date: true, voucherType: true } }) : [];
  const rev = await reversedSet(entries);
  const rows = rowsAll.filter((r) => !rev.has(r.journalEntryId));
  const pays = paysAll.filter((p) => !rev.has(p.journalEntryId));
  const months = new Map();
  const slot = (m) => {
    if (!months.has(m)) months.set(m, { month: m, label: monthLabel(m), gross: 0, pf: 0, esi: 0, tds: 0, other: 0, net: 0, adjustments: 0, paid: 0, vouchers: [], paymentVouchers: [], paidOn: null, mode: null, reference: null, payslipId: null });
    return months.get(m);
  };
  rows.forEach((r) => {
    const s = slot(r.month);
    const ded = P(r.professionalTax) + P(r.otherDeductions) + P(r.registerDifference);
    s.gross += P(r.earnedGross); s.pf += P(r.pf); s.esi += P(r.esi); s.tds += P(r.tds); s.other += ded; s.net += P(r.netPay);
    if (r.kind === 'ADJUSTMENT') s.adjustments += P(r.netPay);
    else if (r.payslipId) s.payslipId = r.payslipId;
    s.vouchers.push({ id: r.journalEntryId, voucherNo: vno.get(r.journalEntryId) || null, kind: r.kind, note: r.note || null });
  });
  pays.forEach((p) => {
    const s = slot(p.month);
    s.paid += P(p.amount);
    s.paymentVouchers.push({ id: p.journalEntryId, voucherNo: vno.get(p.journalEntryId) || null, amount: p.amount, paidOn: p.paidOn, mode: p.mode, reference: p.reference });
    if (!s.paidOn || p.paidOn >= s.paidOn) { s.paidOn = p.paidOn; s.mode = p.mode; s.reference = p.reference; }
  });
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((s) => ({
    ...s, gross: R(s.gross), pf: R(s.pf), esi: R(s.esi), tds: R(s.tds), other: R(s.other), net: R(s.net), adjustments: R(s.adjustments),
    paid: R(s.paid), balance: R(s.net - s.paid),
    status: s.paid <= 0 && s.net > 0 ? 'UNPAID' : s.paid >= s.net ? 'PAID' : 'PARTIAL',
  })).map((s) => ({ ...s, statusLabel: STATUS_LABEL[s.status] }));
  const name = (rowsAll[0] || paysAll[0] || {}).employeeName || null;
  const department = (rowsAll[rowsAll.length - 1] || {}).department || null;
  const code = (rowsAll[rowsAll.length - 1] || {}).employeeCode || null;
  return { employeeId, name, department, code, months: list };
}

module.exports = {
  VOUCHER, SALARY_TYPES, STATUS_LABEL, MODES, normMode, isPrivileged, auditView, voucherMap, reversedSet,
  employeeGroup, buildVoucher, problemText, postRunVoucher, currentAccrual, runPosition, payRun, adjust,
  voucherDetail, facets, matching, summariesFor, employeeMonths, liveAccrualRows, matchRow, shapeRow, totalsOfRows, statusFor, assertOpenPeriod,
  P, R, money2, isMonth, isDate,
};

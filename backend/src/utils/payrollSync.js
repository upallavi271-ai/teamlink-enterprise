// ---------------------------------------------------------------------------
// HRMS -> ACCOUNTS SYNC (SPEC B §6/§7).
//
// Payroll calculation and ledger booking are separate modules connected by
// ONE contract: an HTTP POST of the journal payload to the Accounts module's
// /api/accounts/journal-entries (routes/journal.js), authenticated with the
// internal service token (utils/ledger.js serviceToken()).
//
// THE PAYLOAD — the spec's shape, per employee, made to BALANCE:
//   { employee_id, month, year,
//     debit:  [{ account: 'Salary Expense', amount: earnedGross + PF_employer + ESI_employer }],
//     credit: [{ account: 'PF Payable',   amount: PF_employer + PF_employee },
//              { account: 'ESI Payable',  amount: ESI_employer + ESI_employee }   (when non-zero)
//              { account: 'PT Payable',   amount: PT }                             (when non-zero)
//              { account: 'TDS Payable',  amount: TDS },
//              { account: 'Other Deductions Payable', amount: other }             (when non-zero)
//              { account: 'Bank/Payable to Employee', amount: net_pay }] }
//   plus the envelope: payroll_run_id, idempotency_key, reference_type,
//   date (last day of the month), narration, employee_code / employee_name.
//
// WHY THE DEBIT IS NOT gross_pay: the spec credits PF Payable with employer +
// employee PF, and the employer's share is a cost of the company, not a
// deduction from the employee — so it has to appear on the debit side too or
// the entry cannot balance. And LOP is money never owed, so the expense is the
// EARNED gross. Credits = PF(emp+er) + ESI(emp+er) + PT + TDS + other + net
//                       = earnedGross + PF_er + ESI_er = the debit, to the paisa.
//
// IDEMPOTENCY: key "payroll-run:<EmployeePayrollRun.id>" for the salary
// journal and "payroll-payment:<id>" for the bank payment journal. The ledger
// refuses to book a key twice, so a retry — by hand, by the sweep, or two at
// once — can never double-book.
//
// RETRY: every attempt is logged in PayrollSyncLog (PENDING / SUCCESS /
// FAILED, attempts, lastError, nextAttemptAt). A failed row is retried from
// the screen, and automatically by the sweep (every PAYROLL_SYNC_SWEEP_MS,
// default 5 min; 0 turns it off) with backoff, up to MAX_AUTO_ATTEMPTS.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { serviceToken } = require('./ledger');
const { transition, refreshMonthRun, PayrollError } = require('./payrollEngine');
const { lastDayOf } = require('./salaryVersions');
const { monthLabel } = require('./attendanceMath');
const { logAudit } = require('./audit');

const MAX_AUTO_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 15, 60, 360, 720];

const accrualKey = (id) => `payroll-run:${id}`;
const paymentKey = (id) => `payroll-payment:${id}`;

function journalUrl() {
  const base = process.env.ACCOUNTS_API_URL || `http://127.0.0.1:${process.env.PORT || 4000}`;
  return `${base.replace(/\/$/, '')}/api/accounts/journal-entries`;
}

// The spec payload for one employee's month.
function buildAccrualPayload(entry, employee) {
  const credit = [{ account: 'PF Payable', amount: entry.pfEmployer + entry.pfEmployee }];
  if (entry.esiEmployee + entry.esiEmployer > 0) credit.push({ account: 'ESI Payable', amount: entry.esiEmployee + entry.esiEmployer });
  if (entry.professionalTax > 0) credit.push({ account: 'PT Payable', amount: entry.professionalTax });
  credit.push({ account: 'TDS Payable', amount: entry.tds });
  if (entry.otherDeductions > 0) credit.push({ account: 'Other Deductions Payable', amount: entry.otherDeductions });
  credit.push({ account: 'Bank/Payable to Employee', amount: entry.netPay });
  return {
    employee_id: entry.employeeId,
    month: entry.monthNum,
    year: entry.year,
    debit: [{ account: 'Salary Expense', amount: entry.earnedGross + entry.pfEmployer + entry.esiEmployer }],
    credit,
    // envelope
    payroll_run_id: entry.id,
    idempotency_key: accrualKey(entry.id),
    reference_type: 'PAYROLL_RUN',
    date: lastDayOf(entry.month),
    employee_code: employee ? employee.employeeCode : null,
    employee_name: employee ? employee.name : null,
    narration: `Salary ${monthLabel(entry.month)} — ${employee ? employee.name : entry.employeeId}`,
  };
}

function buildPaymentPayload(entry, employee, { paidDate, bankTransactionId, reference } = {}) {
  return {
    employee_id: entry.employeeId,
    month: entry.monthNum,
    year: entry.year,
    debit: [{ account: 'Payable to Employee', amount: entry.netPay }],
    credit: [{ account: 'Bank', amount: entry.netPay }],
    payroll_run_id: entry.id,
    idempotency_key: paymentKey(entry.id),
    reference_type: 'PAYROLL_PAYMENT',
    reference_id: entry.id,
    date: paidDate || new Date().toISOString().slice(0, 10),
    employee_code: employee ? employee.employeeCode : null,
    employee_name: employee ? employee.name : null,
    bank_transaction_id: bankTransactionId || null,
    narration: `Salary paid ${monthLabel(entry.month)} — ${employee ? employee.name : entry.employeeId}${reference ? ` (ref ${reference})` : ''}`,
  };
}

// THE contract call. Resolves { ok, status, entry, error } — never throws.
async function postToAccounts(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(journalUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': serviceToken(),
        'Idempotency-Key': payload.idempotency_key,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 200 || res.status === 201) return { ok: true, status: res.status, entry: data && data.entry, replay: !!(data && data.replay) };
    return { ok: false, status: res.status, error: (data && data.error) || `Accounts answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'Accounts did not answer within 15s' : `Accounts unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLog(kind, entry, payload) {
  const key = kind === 'PAYMENT' ? paymentKey(entry.id) : accrualKey(entry.id);
  const existing = await prisma.payrollSyncLog.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    // A payment may be re-attempted with a different date / bank line; the
    // accrual payload is rebuilt from the frozen run, so it is identical.
    if (existing.status !== 'SUCCESS' && payload) {
      return prisma.payrollSyncLog.update({ where: { id: existing.id }, data: { payload: JSON.stringify(payload) } });
    }
    return existing;
  }
  try {
    return await prisma.payrollSyncLog.create({
      data: {
        kind, employeePayrollRunId: entry.id, employeeId: entry.employeeId, month: entry.month,
        // Queued: the automatic sweep picks it up after a short grace period,
        // so Accounts' own "Sync" (or the approver's immediate sync) goes first.
        idempotencyKey: key, status: 'PENDING', payload: payload ? JSON.stringify(payload) : null, nextAttemptAt: new Date(Date.now() + 2 * 60000),
      },
    });
  } catch (err) {
    if (err && err.code === 'P2002') return prisma.payrollSyncLog.findUnique({ where: { idempotencyKey: key } });
    throw err;
  }
}

// Called on approval: build the payload and queue it.
async function queueAccrual(entryId) {
  const entry = await prisma.employeePayrollRun.findUnique({ where: { id: entryId }, include: { employee: true } });
  return ensureLog('ACCRUAL', entry, buildAccrualPayload(entry, entry.employee));
}

async function attempt(log) {
  const payload = JSON.parse(log.payload || '{}');
  const started = new Date();
  const result = await postToAccounts(payload);
  const attempts = log.attempts + 1;
  const data = { attempts, lastAttemptAt: started };
  if (result.ok) {
    Object.assign(data, { status: 'SUCCESS', lastError: null, nextAttemptAt: null, journalEntryId: result.entry ? result.entry.id : log.journalEntryId });
  } else {
    const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
    Object.assign(data, {
      status: 'FAILED', lastError: String(result.error || 'Unknown error').slice(0, 1000),
      nextAttemptAt: attempts >= MAX_AUTO_ATTEMPTS ? null : new Date(started.getTime() + wait * 60000),
    });
  }
  const updated = await prisma.payrollSyncLog.update({ where: { id: log.id }, data });
  return { ok: result.ok, log: updated, error: result.error, replay: result.replay };
}

// APPROVED -> (journal booked) -> SYNCED_TO_ACCOUNTS.
async function syncEntry(entryId, actor) {
  const entry = await prisma.employeePayrollRun.findUnique({ where: { id: entryId }, include: { employee: true } });
  if (!entry) throw new PayrollError(404, 'Payroll record not found');
  if (entry.status !== 'APPROVED') {
    throw new PayrollError(409, `Only an Approved record can be synced to Accounts — this one is ${entry.status}.`, { status: entry.status });
  }
  let log = await ensureLog('ACCRUAL', entry, buildAccrualPayload(entry, entry.employee));
  if (log.status !== 'SUCCESS') {
    const r = await attempt(log);
    log = r.log;
    if (!r.ok) {
      await logAudit({
        userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Payroll sync to Accounts failed',
        entity: 'EmployeePayrollRun', entityId: entry.id, toValue: `attempt ${log.attempts}`, reason: log.lastError,
      });
      return { ok: false, log, entry };
    }
  }
  let updated;
  try {
    updated = await transition(entry.id, 'sync', actor, { data: { journalEntryId: log.journalEntryId } });
  } catch (err) {
    // Somebody else completed the move in the meantime; the booking stands once.
    if (err.status !== 409) throw err;
    updated = await prisma.employeePayrollRun.findUnique({ where: { id: entry.id } });
  }
  return { ok: true, log, entry: updated };
}

// A bank statement debit that is this salary payment, if exactly one fits:
// an unmatched Debit of exactly the net pay, dated in or after the payroll
// month, whose narration names the employee or ends with their account number.
async function findBankMatch(entry, employee) {
  const cands = await prisma.bankTransaction.findMany({
    where: { type: 'Debit', matched: false, reconStatus: 'Unmatched', date: { gte: `${entry.month}-01` } },
  });
  const net = Math.round(entry.netPay * 100);
  const name = String(employee.name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const acct = String(employee.bankAccountNumber || '').replace(/\D/g, '');
  const tail = acct.length >= 4 ? acct.slice(-4) : null;
  const hits = cands.filter((t) => Math.round(Number(t.amount) * 100) === net).filter((t) => {
    const text = `${t.description || ''} ${t.counterparty || ''} ${t.reference || ''}`.toLowerCase();
    return (name.length && name.every((w) => text.includes(w))) || (tail && text.replace(/\D/g, '').includes(tail));
  });
  return hits.length === 1 ? hits[0] : null;
}

async function linkBankTransaction(txnId, employeeNames, actor) {
  await prisma.bankTransaction.update({
    where: { id: txnId },
    data: {
      matched: true, reconStatus: 'Matched', category: 'Salary', categoryKind: 'expense',
      counterparty: employeeNames.slice(0, 190), matchedBy: actor ? actor.name : 'System',
      matchedDate: new Date().toISOString().slice(0, 10),
    },
  });
}

// SYNCED_TO_ACCOUNTS -> (payment journal booked) -> PAID.
// opts: { paidDate, bankTransactionId, reference, autoMatch (default true),
//         batchTxn (one bank debit for several records — the caller links it),
//         skipTxnChecks (a retry of a payment that was already validated) }
async function payEntry(entryId, actor, opts = {}) {
  const entry = await prisma.employeePayrollRun.findUnique({ where: { id: entryId }, include: { employee: true } });
  if (!entry) throw new PayrollError(404, 'Payroll record not found');
  if (entry.status !== 'SYNCED_TO_ACCOUNTS') {
    throw new PayrollError(409, `Only a record synced to Accounts can be marked paid — this one is ${entry.status}.`, { status: entry.status });
  }
  let txn = null;
  if (opts.bankTransactionId) {
    txn = await prisma.bankTransaction.findUnique({ where: { id: opts.bankTransactionId } });
    if (!txn) throw new PayrollError(400, 'That bank transaction does not exist');
    if (txn.type !== 'Debit') throw new PayrollError(400, 'A salary payment is a Debit on the bank statement');
    if (!opts.batchTxn && !opts.skipTxnChecks) {
      if (txn.matched || txn.reconStatus !== 'Unmatched') throw new PayrollError(409, 'That bank transaction is already matched');
      if (Math.round(txn.amount * 100) !== Math.round(entry.netPay * 100)) {
        throw new PayrollError(400, `The bank debit (${txn.amount}) is not this net pay (${entry.netPay})`);
      }
    }
  } else if (opts.autoMatch !== false) {
    txn = await findBankMatch(entry, entry.employee);
  }
  const payload = buildPaymentPayload(entry, entry.employee, { paidDate: opts.paidDate, bankTransactionId: txn ? txn.id : null, reference: opts.reference });
  let log = await ensureLog('PAYMENT', entry, payload);
  if (log.status !== 'SUCCESS') {
    const r = await attempt(log);
    log = r.log;
    if (!r.ok) {
      await logAudit({
        userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Payroll payment booking failed',
        entity: 'EmployeePayrollRun', entityId: entry.id, toValue: `attempt ${log.attempts}`, reason: log.lastError,
      });
      return { ok: false, log, entry };
    }
  }
  const booked = JSON.parse(log.payload || '{}');
  const txnId = booked.bank_transaction_id || null;
  let updated;
  try {
    updated = await transition(entry.id, 'pay', actor, {
      data: {
        paymentJournalEntryId: log.journalEntryId, bankTransactionId: txnId,
        paymentReference: opts.reference || null,
        paidAt: booked.date ? new Date(`${booked.date}T12:00:00`) : new Date(),
      },
    });
  } catch (err) {
    if (err.status !== 409) throw err;
    updated = await prisma.employeePayrollRun.findUnique({ where: { id: entry.id } });
  }
  if (txnId && !opts.batchTxn) {
    const t = await prisma.bankTransaction.findUnique({ where: { id: txnId } });
    if (t && !t.matched) await linkBankTransaction(txnId, entry.employee.name, actor);
  }
  return { ok: true, log, entry: updated, bankTransactionId: txnId };
}

// Retry one log row (the screen's Retry, and the sweep).
async function retryLog(logId, actor) {
  const log = await prisma.payrollSyncLog.findUnique({ where: { id: logId } });
  if (!log) throw new PayrollError(404, 'Sync log row not found');
  if (log.status === 'SUCCESS') {
    const entry = await prisma.employeePayrollRun.findUnique({ where: { id: log.employeePayrollRunId } });
    // Booked, but the status move was lost (e.g. a crash in between): finish it.
    if (entry && log.kind === 'ACCRUAL' && entry.status === 'APPROVED') return syncEntry(entry.id, actor);
    if (entry && log.kind === 'PAYMENT' && entry.status === 'SYNCED_TO_ACCOUNTS') return payEntry(entry.id, actor, { autoMatch: false });
    return { ok: true, log, entry };
  }
  if (log.kind === 'PAYMENT') {
    const p = JSON.parse(log.payload || '{}');
    return payEntry(log.employeePayrollRunId, actor, { paidDate: p.date, bankTransactionId: p.bank_transaction_id || null, autoMatch: false, skipTxnChecks: true });
  }
  return syncEntry(log.employeePayrollRunId, actor);
}

// The automatic retry sweep.
let sweeping = false;
async function sweepOnce() {
  if (sweeping) return { skipped: true };
  sweeping = true;
  const out = { tried: 0, succeeded: 0, failed: 0 };
  try {
    const due = await prisma.payrollSyncLog.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        attempts: { lt: MAX_AUTO_ATTEMPTS },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const system = { id: null, name: 'Payroll sync (automatic retry)' };
    for (const log of due) {
      // eslint-disable-next-line no-await-in-loop
      const entry = await prisma.employeePayrollRun.findUnique({ where: { id: log.employeePayrollRunId } });
      const ready = entry && ((log.kind === 'ACCRUAL' && entry.status === 'APPROVED') || (log.kind === 'PAYMENT' && entry.status === 'SYNCED_TO_ACCOUNTS'));
      if (!ready) continue;
      out.tried += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await retryLog(log.id, system);
        if (r.ok) out.succeeded += 1; else out.failed += 1;
      } catch (err) {
        out.failed += 1;
        // eslint-disable-next-line no-console
        console.error('[payroll-sync] sweep:', err.message);
      }
    }
  } finally {
    sweeping = false;
  }
  return out;
}

let timer = null;
function startSweep() {
  const ms = process.env.PAYROLL_SYNC_SWEEP_MS != null ? Number(process.env.PAYROLL_SYNC_SWEEP_MS) : 5 * 60 * 1000;
  if (!ms || timer) return;
  timer = setInterval(() => { sweepOnce().catch((e) => console.error('[payroll-sync] sweep failed:', e.message)); }, ms);
  if (timer.unref) timer.unref();
}

module.exports = {
  accrualKey, paymentKey, buildAccrualPayload, buildPaymentPayload, postToAccounts,
  queueAccrual, syncEntry, payEntry, retryLog, sweepOnce, startSweep, findBankMatch, linkBankTransaction,
  refreshMonthRun, MAX_AUTO_ATTEMPTS,
};

// ---------------------------------------------------------------------------
// HRMS PAYROLL -> ACCOUNTS, ONE JOURNAL PER MONTH (Accounts spec S3, 2026-10-05).
//
// Only payroll posts — never attendance, leave, profile or ATS data. The
// month's payroll run (PayrollRun, one per YYYY-MM) is FINALIZED when every
// per-employee record of the month is Approved (or later). Then ONE balanced
// journal entry is booked for the month's totals:
//
//   Dr Salary Expense        earned gross (Basic + HRA + allowances + bonus, after LOP)
//   Dr Employer PF Expense   employer PF
//   Dr Employer ESI Expense  employer ESI
//      Cr PF Payable            employee + employer PF
//      Cr ESI Payable           employee + employer ESI
//      Cr TDS Payable           TDS
//      Cr Professional Tax Payable
//      Cr Other Deductions Payable
//      Cr Salary Payable        net pay
//
// Zero lines are skipped; it must balance to the paisa or nothing is booked.
// Date = the month end; narration "Payroll for <Month Year>"; voucher type
// Journal; source HRMS_PAYROLL; referenceType PAYROLL_MONTH, referenceId =
// the PayrollRun id (the link back); every record keeps journalEntryId (the
// link forward).
//
// IDEMPOTENT by the payroll run id: key "payroll-month:<runId>:v<n>". A month
// is posted at most once per version. RE-OPEN never edits the booked entry:
// a reversal "Reversal of Payroll <Month Year>" is booked (ledger.js
// reverseJournal, key "<key>:reversal"), the records go back to Draft, and
// the next finalize books v<n+1>.
//
// SALARY PAYMENT: Dr Salary Payable / Cr the chosen bank's ledger, key
// "payroll-month-payment:<runId>:v<n>", optionally linked to the bank
// statement debit it matches (Bank & Reconciliation).
//
// Every booking goes through the one contract — POST
// /api/accounts/journal-entries (and /:id/reverse) with the service token —
// and every attempt is logged in PayrollSyncLog (kind MONTH / MONTH_PAYMENT /
// MONTH_REVERSAL; employeePayrollRunId holds the PayrollRun id).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  serviceToken, ensureChart, accountIndex, paise, ensureAccount, monthEnd,
} = require('./ledger');
const { monthLabel } = require('./attendanceMath');
const { logAudit } = require('./audit');
const { PayrollError, refreshMonthRun, FINAL_STATUSES } = require('./payrollEngine');

const MAPPING_KEY = 'accounts.payrollLedgerMapping';

// The payroll components and their default ledgers (S3.2 / S3.3).
const COMPONENTS = [
  { key: 'salary', label: 'Salary (gross earned)', side: 'debit', expects: 'EXPENSE', group: 'Expenses', def: '5100', amount: (e) => e.earnedGross },
  { key: 'employerPf', label: 'Employer PF', side: 'debit', expects: 'EXPENSE', group: 'Expenses', def: '5110', amount: (e) => e.pfEmployer },
  { key: 'employerEsi', label: 'Employer ESI', side: 'debit', expects: 'EXPENSE', group: 'Expenses', def: '5120', amount: (e) => e.esiEmployer },
  { key: 'pfPayable', label: 'PF payable (employee + employer)', side: 'credit', expects: 'LIABILITY', group: 'Current Liabilities', def: '2210', amount: (e) => e.pfEmployee + e.pfEmployer },
  { key: 'esiPayable', label: 'ESI payable (employee + employer)', side: 'credit', expects: 'LIABILITY', group: 'Current Liabilities', def: '2220', amount: (e) => e.esiEmployee + e.esiEmployer },
  { key: 'tdsPayable', label: 'TDS payable', side: 'credit', expects: 'LIABILITY', group: 'Current Liabilities', def: '2230', amount: (e) => e.tds },
  { key: 'ptPayable', label: 'Professional tax payable', side: 'credit', expects: 'LIABILITY', group: 'Current Liabilities', def: '2240', amount: (e) => e.professionalTax },
  { key: 'otherPayable', label: 'Other deductions payable', side: 'credit', expects: 'LIABILITY', group: 'Current Liabilities', def: '2250', amount: (e) => e.otherDeductions },
  { key: 'salaryPayable', label: 'Salary payable (net pay)', side: 'credit', expects: 'LIABILITY', group: 'Current Liabilities', def: '2100', amount: (e) => e.netPay },
];
// The default bank ledger a salary payment is credited to when no bank
// account is picked.
const BANK_COMPONENT = { key: 'bank', label: 'Bank (salary paid from)', expects: 'ASSET', group: 'Cash & Bank', def: '1100' };
const ALL_COMPONENTS = [...COMPONENTS, BANK_COMPONENT];

const monthKey = (runId, v) => `payroll-month:${runId}:v${v}`;
const paymentKey = (runId, v) => `payroll-month-payment:${runId}:v${v}`;

function journalUrl(path = '') {
  const base = process.env.ACCOUNTS_API_URL || `http://127.0.0.1:${process.env.PORT || 4000}`;
  return `${base.replace(/\/$/, '')}/api/accounts/journal-entries${path}`;
}

// THE contract call. Resolves { ok, status, entry, error } — never throws.
async function callAccounts(path, payload, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(journalUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': serviceToken(), ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 200 || res.status === 201) return { ok: true, status: res.status, entry: data && data.entry, replay: !!(data && data.replay) };
    return { ok: false, status: res.status, error: (data && data.error) || `Accounts answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'Accounts did not answer within 15 seconds' : `Accounts could not be reached: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- The mapping (Journal & Ledger -> Payroll Mapping tab) -------------------
async function getMapping() {
  await ensureChart();
  const row = await prisma.appSetting.findUnique({ where: { key: MAPPING_KEY } }).catch(() => null);
  let saved = {};
  try { saved = row ? JSON.parse(row.value) || {} : {}; } catch { saved = {}; }
  const map = {};
  ALL_COMPONENTS.forEach((c) => { map[c.key] = saved[c.key] || c.def; });
  return { map, updatedByName: row ? row.updatedByName : null, updatedAt: row ? row.updatedAt : null, custom: !!row };
}

// Every component must point at an existing, active ledger of the right
// kind. Returns the resolved accounts, or throws naming the component.
async function resolveMapping(map) {
  const index = await accountIndex();
  const out = {};
  for (const c of ALL_COMPONENTS) {
    const code = map[c.key];
    const acct = code ? index.get(String(code).toLowerCase()) : null;
    if (!acct) throw new PayrollError(422, `No ledger is mapped for "${c.label}". Set it in Accounts → Journal & Ledger → Payroll Mapping.`, { component: c.key });
    if (!acct.isActive) throw new PayrollError(422, `The ledger mapped for "${c.label}" (${acct.name}) is switched off. Pick another in Payroll Mapping.`, { component: c.key });
    if (c.expects && acct.type !== c.expects) {
      throw new PayrollError(422, `"${c.label}" must go to ${c.expects === 'EXPENSE' ? 'an Expenses' : c.expects === 'LIABILITY' ? 'a Current Liabilities' : 'a Cash & Bank'} ledger — ${acct.name} is ${acct.type}.`, { component: c.key });
    }
    out[c.key] = acct;
  }
  return out;
}

async function saveMapping(patch, actor) {
  const { map } = await getMapping();
  const next = { ...map };
  Object.keys(patch || {}).forEach((k) => { if (ALL_COMPONENTS.some((c) => c.key === k) && patch[k]) next[k] = String(patch[k]); });
  await resolveMapping(next); // refuses a wrong mapping before saving it
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: MAPPING_KEY },
    update: { value, updatedById: actor.id || null, updatedByName: actor.name || null },
    create: { key: MAPPING_KEY, value, updatedById: actor.id || null, updatedByName: actor.name || null },
  });
  const changed = ALL_COMPONENTS.filter((c) => map[c.key] !== next[c.key]);
  if (changed.length) {
    await logAudit({
      userId: actor.id || null, actorName: actor.name, action: 'Payroll ledger mapping changed', entity: 'AppSetting', entityId: MAPPING_KEY,
      fromValue: changed.map((c) => `${c.label}: ${map[c.key]}`).join('; ').slice(0, 1000),
      toValue: changed.map((c) => `${c.label}: ${next[c.key]}`).join('; ').slice(0, 1000),
    });
  }
  return getMapping();
}

// ---- The month's state -------------------------------------------------------
async function monthState(month) {
  const run = await prisma.payrollRun.findUnique({ where: { month } });
  const entries = await prisma.employeePayrollRun.findMany({ where: { month } });
  const byStatus = {};
  entries.forEach((e) => { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });
  const finalized = entries.length > 0 && entries.every((e) => FINAL_STATUSES.includes(e.status));
  const notFinal = entries.filter((e) => !FINAL_STATUSES.includes(e.status)).length;
  const postings = run ? await prisma.journalEntry.findMany({
    where: { referenceType: 'PAYROLL_MONTH', referenceId: run.id }, orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { lineNo: 'asc' } } },
  }) : [];
  const keys = postings.map((p) => `${p.idempotencyKey}:reversal`);
  const reversals = keys.length ? await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: keys } } }) : [];
  const reversedKey = new Set(reversals.map((r) => r.idempotencyKey.replace(/:reversal$/, '')));
  const current = [...postings].reverse().find((p) => !reversedKey.has(p.idempotencyKey)) || null;
  const version = current ? Number(String(current.idempotencyKey).split(':v').pop()) || postings.length : null;
  const payment = run && current ? await prisma.journalEntry.findUnique({ where: { idempotencyKey: paymentKey(run.id, version) } }) : null;
  const lastLog = run ? await prisma.payrollSyncLog.findFirst({
    where: { employeePayrollRunId: run.id, kind: { in: ['MONTH', 'MONTH_PAYMENT', 'MONTH_REVERSAL'] } }, orderBy: { updatedAt: 'desc' },
  }) : null;
  const paidCount = byStatus.PAID || 0;
  const net = entries.reduce((n, e) => n + paise(e.netPay), 0) / 100;
  return {
    month, period: monthLabel(month), runId: run ? run.id : null, records: entries.length, byStatus, net,
    finalized, notFinal,
    posted: !!current,
    journalEntry: current ? {
      id: current.id, date: current.date, narration: current.narration, totalDebit: current.totalDebit, totalCredit: current.totalCredit,
      idempotencyKey: current.idempotencyKey, version, createdAt: current.createdAt, createdByName: current.createdByName, lines: current.lines,
    } : null,
    history: postings.map((p) => ({ id: p.id, key: p.idempotencyKey, date: p.date, total: p.totalDebit, reversed: reversedKey.has(p.idempotencyKey), createdAt: p.createdAt })),
    reversals: reversals.map((r) => ({ id: r.id, key: r.idempotencyKey, date: r.date, total: r.totalDebit, createdAt: r.createdAt })),
    nextVersion: postings.length + 1,
    payment: payment ? { id: payment.id, date: payment.date, amount: payment.totalDebit, narration: payment.narration } : null,
    paid: paidCount > 0 && paidCount === entries.length,
    // What is wrong right now, in words (the button's error reason).
    lastError: lastLog && lastLog.status === 'FAILED' ? lastLog.lastError : null,
    lastLog: lastLog ? { kind: lastLog.kind, status: lastLog.status, attempts: lastLog.attempts, lastError: lastLog.lastError, updatedAt: lastLog.updatedAt } : null,
    canPost: finalized && !current && entries.every((e) => e.status === 'APPROVED'),
    blockReason: !entries.length ? `No payroll records for ${monthLabel(month)} yet.`
      : !finalized ? `${notFinal} record(s) are still Draft / Pending approval — the month posts when every record is approved.`
        : null,
  };
}

// ---- Build the month's journal -------------------------------------------------
function totalsOf(entries) {
  const t = {};
  COMPONENTS.forEach((c) => { t[c.key] = entries.reduce((n, e) => n + paise(c.amount(e) || 0), 0); });
  return t;
}

function buildMonthPayload({ month, run, entries, accounts, version }) {
  const t = totalsOf(entries);
  const [year, monthNum] = month.split('-').map(Number);
  const n = entries.length;
  const line = (c) => ({ account: accounts[c.key].code, amount: t[c.key] / 100, memo: `${c.label} — ${n} employee(s)` });
  const debit = COMPONENTS.filter((c) => c.side === 'debit' && t[c.key] > 0).map(line);
  const credit = COMPONENTS.filter((c) => c.side === 'credit' && t[c.key] > 0).map(line);
  const dr = debit.reduce((s, l) => s + paise(l.amount), 0);
  const cr = credit.reduce((s, l) => s + paise(l.amount), 0);
  if (!dr) throw new PayrollError(422, `The payroll for ${monthLabel(month)} has no amount to post.`);
  if (dr !== cr) {
    throw new PayrollError(422, `The payroll for ${monthLabel(month)} does not balance — debits ₹${(dr / 100).toFixed(2)} vs credits ₹${(cr / 100).toFixed(2)}. Recalculate the records, then post again.`);
  }
  return {
    month: monthNum, year,
    date: monthEnd(month),
    narration: `Payroll for ${monthLabel(month)}`,
    voucher_type: 'Journal',
    source: 'HRMS_PAYROLL',
    reference_type: 'PAYROLL_MONTH',
    reference_id: run.id,
    payroll_run_id: run.id,
    idempotency_key: monthKey(run.id, version),
    employees: n,
    debit, credit,
  };
}

// One employee's share of the month's journal (the record's detail view).
async function employeeShare(entry) {
  const { map } = await getMapping();
  const index = await accountIndex();
  const nameOf = (k) => { const a = index.get(String(map[k]).toLowerCase()); return a ? `${a.code} · ${a.name}` : map[k]; };
  const pick = (side) => COMPONENTS.filter((c) => c.side === side && paise(c.amount(entry)) > 0).map((c) => ({ account: nameOf(c.key), amount: c.amount(entry) }));
  return { debit: pick('debit'), credit: pick('credit'), note: 'Part of the one journal entry booked for the whole month.' };
}

async function logRow(kind, run, month, key, payload) {
  const existing = await prisma.payrollSyncLog.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    if (existing.status !== 'SUCCESS' && payload) return prisma.payrollSyncLog.update({ where: { id: existing.id }, data: { payload: JSON.stringify(payload) } });
    return existing;
  }
  try {
    return await prisma.payrollSyncLog.create({
      data: { kind, employeePayrollRunId: run.id, month, idempotencyKey: key, status: 'PENDING', payload: payload ? JSON.stringify(payload) : null },
    });
  } catch (err) {
    if (err && err.code === 'P2002') return prisma.payrollSyncLog.findUnique({ where: { idempotencyKey: key } });
    throw err;
  }
}

async function finishLog(log, result) {
  const data = { attempts: log.attempts + 1, lastAttemptAt: new Date() };
  if (result.ok) Object.assign(data, { status: 'SUCCESS', lastError: null, nextAttemptAt: null, journalEntryId: result.entry ? result.entry.id : log.journalEntryId });
  else {
    const wait = [5, 15, 60, 360, 720][Math.min(log.attempts, 4)];
    Object.assign(data, { status: 'FAILED', lastError: String(result.error || 'Unknown error').slice(0, 1000), nextAttemptAt: log.attempts + 1 >= 6 ? null : new Date(Date.now() + wait * 60000) });
  }
  return prisma.payrollSyncLog.update({ where: { id: log.id }, data });
}

// The voucher number of an entry: its position in the journal (append-only).
async function voucherNo(entry) {
  if (!entry) return null;
  const n = await prisma.journalEntry.count({ where: { createdAt: { lte: entry.createdAt } } });
  return `JV-${String(n).padStart(5, '0')}`;
}

// A failure is recorded on the log row (so the screen shows it) and raised.
async function failOn(kind, run, month, key, err, actor) {
  const log = await logRow(kind, run, month, key, null);
  await finishLog(log, { ok: false, error: err.message });
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Payroll posting to Accounts failed',
    entity: 'PayrollRun', entityId: run.id, toValue: monthLabel(month), reason: String(err.message).slice(0, 900),
  });
}

// ---- Post the month ------------------------------------------------------------
// opts.auto: called by the approval that finalized the month.
async function postMonth(month, actor, { auto = false } = {}) {
  const st = await monthState(month);
  if (!st.runId) throw new PayrollError(404, `There is no payroll run for ${monthLabel(month)}.`);
  if (st.posted) return { ok: true, already: true, state: st };
  if (!st.finalized) throw new PayrollError(409, st.blockReason || 'The payroll is not finalized yet.');
  const run = await prisma.payrollRun.findUnique({ where: { id: st.runId } });
  const entries = await prisma.employeePayrollRun.findMany({ where: { month } });
  if (entries.some((e) => e.status !== 'APPROVED')) {
    throw new PayrollError(409, 'Some records are already synced or paid without a journal on file — reopen the month and finalize it again.');
  }
  const key = monthKey(run.id, st.nextVersion);
  let payload;
  try {
    const { map } = await getMapping();
    const accounts = await resolveMapping(map);
    payload = buildMonthPayload({ month, run, entries, accounts, version: st.nextVersion });
  } catch (err) {
    if (err instanceof PayrollError) await failOn('MONTH', run, month, key, err, actor);
    throw err;
  }
  payload.posted_by = actor ? actor.name : 'System';
  const log = await logRow('MONTH', run, month, key, payload);
  const result = await callAccounts('', payload, key);
  await finishLog(log, result);
  if (!result.ok) {
    await logAudit({
      userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Payroll posting to Accounts failed',
      entity: 'PayrollRun', entityId: run.id, toValue: monthLabel(month), reason: String(result.error).slice(0, 900),
    });
    return { ok: false, error: result.error, state: await monthState(month) };
  }
  const je = result.entry;
  await prisma.employeePayrollRun.updateMany({
    where: { month, status: 'APPROVED' },
    data: { status: 'SYNCED_TO_ACCOUNTS', syncedAt: new Date(), journalEntryId: je.id },
  });
  await refreshMonthRun(month);
  const vno = await voucherNo(je);
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System',
    action: auto ? 'Payroll posted to Accounts (on finalize)' : 'Payroll posted to Accounts',
    entity: 'PayrollRun', entityId: run.id, fromValue: 'Not posted', toValue: `${vno} · ₹${je.totalDebit.toFixed(2)} · v${st.nextVersion}`,
    reason: `${monthLabel(month)} · ${entries.length} record(s) · JE ${je.id}`,
  });
  return { ok: true, entry: je, voucherNo: vno, state: await monthState(month) };
}

// ---- Reverse the month's journal ---------------------------------------------------
// toStatus: 'DRAFT' (HRMS re-open, to correct) or 'APPROVED' (Accounts
// reverses; the month waits as finalized-but-unposted).
async function reverseMonth(month, actor, { toStatus = 'DRAFT', reason = '' } = {}) {
  const st = await monthState(month);
  if (!st.runId) throw new PayrollError(404, `There is no payroll run for ${monthLabel(month)}.`);
  if ((st.byStatus.PAID || 0) > 0 || st.payment) {
    throw new PayrollError(409, `Salary for ${monthLabel(month)} is already marked paid, so it cannot be re-opened. Put the correction in next month's payroll.`);
  }
  if (toStatus === 'APPROVED' && !st.posted) throw new PayrollError(409, `${monthLabel(month)} is not posted to Accounts.`);
  if (toStatus === 'DRAFT' && !st.posted && !st.records) throw new PayrollError(409, 'Nothing to re-open.');
  const run = await prisma.payrollRun.findUnique({ where: { id: st.runId } });
  let reversal = null;
  if (st.posted) {
    const key = `${st.journalEntry.idempotencyKey}:reversal`;
    const log = await logRow('MONTH_REVERSAL', run, month, key, { reverses: st.journalEntry.id });
    const result = await callAccounts(`/${st.journalEntry.id}/reverse`, { narration: `Reversal of Payroll ${monthLabel(month)}`, reason }, key);
    await finishLog(log, result);
    if (!result.ok) return { ok: false, error: result.error, state: await monthState(month) };
    reversal = result.entry;
  }
  const from = toStatus === 'DRAFT' ? ['APPROVED', 'SYNCED_TO_ACCOUNTS', 'PENDING_APPROVAL'] : ['SYNCED_TO_ACCOUNTS'];
  const moving = await prisma.employeePayrollRun.findMany({ where: { month, status: { in: from } }, select: { id: true, status: true } });
  const data = { status: toStatus, journalEntryId: null, syncedAt: null };
  if (toStatus === 'DRAFT') Object.assign(data, { rejectionReason: `Re-opened${reason ? `: ${reason}` : ''}`.slice(0, 500), submittedBy: null, submittedAt: null });
  await prisma.employeePayrollRun.updateMany({ where: { month, status: { in: from } }, data });
  const who = actor ? actor.name : 'System';
  if (moving.length) {
    await prisma.auditLog.createMany({
      data: moving.map((m) => ({
        userId: actor && actor.id ? actor.id : null, actorName: who, action: toStatus === 'DRAFT' ? 'Payroll re-opened' : 'Payroll journal reversed in Accounts',
        entity: 'EmployeePayrollRun', entityId: m.id, fromValue: m.status, toValue: toStatus, reason: reason || monthLabel(month),
      })),
    }).catch(() => {});
  }
  await refreshMonthRun(month);
  const vno = reversal ? await voucherNo(reversal) : null;
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: who,
    action: toStatus === 'DRAFT' ? 'Payroll month re-opened' : 'Payroll journal reversed',
    entity: 'PayrollRun', entityId: run.id, fromValue: st.posted ? `Posted v${st.journalEntry.version}` : 'Not posted',
    toValue: reversal ? `Reversal ${vno} · ₹${reversal.totalDebit.toFixed(2)}` : 'No journal to reverse', reason: reason || monthLabel(month),
  });
  return { ok: true, reversal, voucherNo: vno, moved: moving.length, state: await monthState(month) };
}

// ---- Salary payment ------------------------------------------------------------------
// The ledger of one bank account (made on demand, "Bank · HDFC ·4796").
async function bankLedger(bankAccountId) {
  const ba = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!ba) throw new PayrollError(400, 'That bank account does not exist.');
  const tag = `bank:${ba.id}`;
  const all = await prisma.ledgerAccount.findMany({ where: { code: { startsWith: '11' } } });
  const mine = all.find((a) => String(a.aliases || '').split(',').includes(tag));
  if (mine) return mine;
  const used = new Set(all.map((a) => a.code));
  let n = 1101;
  while (used.has(String(n)) && n < 1199) n += 1;
  const last4 = String(ba.accNo || '').replace(/\D/g, '').slice(-4);
  let name = `Bank · ${ba.bank}${last4 ? ` ·${last4}` : ''}`;
  if (await prisma.ledgerAccount.findUnique({ where: { name } })) name = `${name} (${ba.id.slice(-4)})`;
  return ensureAccount({ code: String(n), name, type: 'ASSET', aliases: tag, description: `Bank account ${ba.bank}${ba.accNo ? ` ${ba.accNo}` : ''} (Bank & Reconciliation)` });
}

// Statement debits that could be this month's salary payment.
async function bankMatches(month, bankAccountId) {
  const st = await monthState(month);
  const net = Math.round(st.net * 100);
  const where = { type: 'Debit', matched: false, reconStatus: 'Unmatched', date: { gte: `${month}-01` } };
  if (bankAccountId) where.bankAccountId = bankAccountId;
  const cands = await prisma.bankTransaction.findMany({ where, orderBy: { date: 'asc' }, take: 500 });
  const exact = cands.filter((t) => Math.round(Number(t.amount) * 100) === net);
  return {
    net: st.net,
    candidates: exact.map((t) => ({ id: t.id, date: t.date, description: t.description, amount: t.amount, reference: t.reference, bankAccountId: t.bankAccountId })),
    suggested: exact.length === 1 ? exact[0].id : null,
  };
}

async function payMonth(month, actor, { bankAccountId = null, paidDate = null, bankTransactionId = null, reference = null } = {}) {
  const st = await monthState(month);
  if (!st.runId) throw new PayrollError(404, `There is no payroll run for ${monthLabel(month)}.`);
  if (!st.posted) throw new PayrollError(409, `Post ${monthLabel(month)} to Accounts first — the salary payment clears the Salary Payable it books.`);
  if (st.payment) return { ok: true, already: true, state: st };
  const entries = await prisma.employeePayrollRun.findMany({ where: { month }, include: { employee: { select: { name: true } } } });
  if (entries.some((e) => e.status !== 'SYNCED_TO_ACCOUNTS')) throw new PayrollError(409, 'Every record of the month must be posted (Synced) before it is marked paid.');
  const run = await prisma.payrollRun.findUnique({ where: { id: st.runId } });
  const { map } = await getMapping();
  const accounts = await resolveMapping(map);
  const bank = bankAccountId ? await bankLedger(bankAccountId) : accounts.bank;
  const amountP = entries.reduce((n, e) => n + paise(e.netPay), 0);
  if (!amountP) throw new PayrollError(422, 'The net pay of this month is zero — nothing to pay.');
  let txn = null;
  if (bankTransactionId) {
    txn = await prisma.bankTransaction.findUnique({ where: { id: bankTransactionId } });
    if (!txn) throw new PayrollError(400, 'That bank statement line does not exist.');
    if (txn.type !== 'Debit') throw new PayrollError(400, 'A salary payment is money going out (a Debit) on the statement.');
    if (txn.matched || txn.reconStatus !== 'Unmatched') throw new PayrollError(409, 'That bank statement line is already matched to something else.');
    if (Math.round(Number(txn.amount) * 100) !== amountP) throw new PayrollError(400, `The bank line (₹${txn.amount}) is not this month's total net pay (₹${(amountP / 100).toFixed(2)}).`);
    if (bankAccountId && txn.bankAccountId && txn.bankAccountId !== bankAccountId) throw new PayrollError(400, 'That statement line belongs to another bank account.');
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(paidDate || '')) ? paidDate : (txn ? txn.date : new Date().toISOString().slice(0, 10));
  const [y, m] = date.split('-').map(Number);
  const key = paymentKey(run.id, st.journalEntry.version);
  const payload = {
    month: m, year: y, date,
    narration: `Salary paid for ${monthLabel(month)}${reference ? ` (ref ${reference})` : ''}`,
    voucher_type: 'Payment', source: 'HRMS_PAYROLL',
    reference_type: 'PAYROLL_MONTH_PAYMENT', reference_id: run.id, payroll_run_id: run.id, idempotency_key: key,
    bank_account_id: bankAccountId || null, bank_transaction_id: txn ? txn.id : null,
    debit: [{ account: accounts.salaryPayable.code, amount: amountP / 100, memo: `Net pay — ${entries.length} employee(s)` }],
    credit: [{ account: bank.code, amount: amountP / 100, memo: txn ? `Statement line ${txn.date} · ${String(txn.description || '').slice(0, 120)}` : 'Salary payment' }],
  };
  payload.posted_by = actor ? actor.name : 'System';
  const log = await logRow('MONTH_PAYMENT', run, month, key, payload);
  const result = await callAccounts('', payload, key);
  await finishLog(log, result);
  if (!result.ok) return { ok: false, error: result.error, state: await monthState(month) };
  const je = result.entry;
  const who = actor ? actor.name : 'System';
  await prisma.employeePayrollRun.updateMany({
    where: { month, status: 'SYNCED_TO_ACCOUNTS' },
    data: { status: 'PAID', paidBy: who, paidAt: new Date(`${date}T12:00:00`), paymentJournalEntryId: je.id, bankTransactionId: txn ? txn.id : null, paymentReference: reference || null },
  });
  if (txn) {
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        matched: true, reconStatus: 'Matched', category: 'Salary', categoryKind: 'expense',
        counterparty: `Salary ${monthLabel(month)} (${entries.length} employee(s))`.slice(0, 190), matchedBy: who, matchedDate: new Date().toISOString().slice(0, 10),
      },
    });
  }
  await refreshMonthRun(month);
  const vno = await voucherNo(je);
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: who, action: 'Payroll salary paid (booked in Accounts)', entity: 'PayrollRun', entityId: run.id,
    fromValue: 'Posted', toValue: `${vno} · ₹${je.totalDebit.toFixed(2)} · ${bank.name}${txn ? ` · statement line ${txn.date}` : ''}`, reason: monthLabel(month),
  });
  return { ok: true, entry: je, voucherNo: vno, state: await monthState(month) };
}

// After an approval: post every month it finalized (the automatic trigger).
async function postIfFinalized(months, actor) {
  const out = [];
  for (const month of [...new Set(months)]) {
    // eslint-disable-next-line no-await-in-loop
    const st = await monthState(month);
    if (!st.canPost) { out.push({ month, posted: st.posted, skipped: true, reason: st.blockReason }); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await postMonth(month, actor, { auto: true });
      out.push({ month, posted: r.ok, error: r.ok ? null : r.error, voucherNo: r.voucherNo || null });
    } catch (err) {
      if (!err.status) throw err;
      out.push({ month, posted: false, error: err.message });
    }
  }
  return out;
}

// The automatic retry (called by payrollSync's sweep): a finalized month
// whose posting failed is tried again.
async function sweepMonths() {
  const failed = await prisma.payrollSyncLog.findMany({
    where: { kind: 'MONTH', status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: 6 }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    take: 20,
  });
  const months = [...new Set(failed.map((l) => l.month).filter(Boolean))];
  return postIfFinalized(months, { id: null, name: 'Payroll posting (automatic retry)' });
}

module.exports = {
  COMPONENTS, ALL_COMPONENTS, MAPPING_KEY, monthKey, paymentKey,
  getMapping, saveMapping, resolveMapping, monthState, buildMonthPayload, totalsOf, employeeShare,
  postMonth, reverseMonth, payMonth, bankMatches, bankLedger, postIfFinalized, sweepMonths, voucherNo, callAccounts,
};

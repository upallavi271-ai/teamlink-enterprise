// ---------------------------------------------------------------------------
// THE LEDGER — Accounts module (SPEC B §7).
//
// A minimal chart of accounts and a double-entry journal. Nothing outside the
// Accounts module writes JournalEntry / JournalLine: HRMS payroll reaches it
// only through POST /api/accounts/journal-entries (routes/journal.js), which
// calls postJournal() below.
//
// postJournal() guarantees:
//   * every account named exists and is active (else 422 — nothing booked);
//   * debits = credits to the paisa (else 422 — nothing booked);
//   * ONE entry per idempotency key: a replay of the same key returns the
//     entry already booked (200, replay: true) and never books twice — also
//     under a race, because the key is UNIQUE in the database. A replay whose
//     amounts differ from what was booked is refused (409).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

// The minimal chart (also seeded by migration 20260926020000). ensureChart()
// re-creates any system account that has gone missing.
const CHART = [
  { code: '1100', name: 'Bank', type: 'ASSET', aliases: null, description: 'Company bank account(s) — salary disbursements are credited here' },
  { code: '2100', name: 'Salary Payable', type: 'LIABILITY', aliases: 'Payable to Employee,Bank/Payable to Employee', description: 'Net salary owed to employees until the bank payment is made' },
  { code: '2210', name: 'PF Payable', type: 'LIABILITY', aliases: null, description: 'Employee + employer provident fund due to EPFO' },
  { code: '2220', name: 'ESI Payable', type: 'LIABILITY', aliases: null, description: 'Employee + employer ESI due to ESIC' },
  { code: '2230', name: 'TDS Payable', type: 'LIABILITY', aliases: null, description: 'Tax deducted at source from salaries (Sec 192)' },
  { code: '2240', name: 'PT Payable', type: 'LIABILITY', aliases: null, description: 'Professional tax due to the state' },
  { code: '2250', name: 'Other Deductions Payable', type: 'LIABILITY', aliases: null, description: 'Other salary deductions / recoveries held for settlement' },
  { code: '5100', name: 'Salary Expense', type: 'EXPENSE', aliases: null, description: 'Earned gross salary (Basic + HRA + allowances + bonus, after loss of pay)' },
  // S3 (2026-10-05): the employer's PF / ESI are their own expense ledgers.
  { code: '5110', name: 'Employer PF Expense', type: 'EXPENSE', aliases: null, description: "The company's own provident fund contribution" },
  { code: '5120', name: 'Employer ESI Expense', type: 'EXPENSE', aliases: null, description: "The company's own ESI contribution" },
];

// The ledger GROUP an account sits in (S3.3 / S2.4), from its type and code
// range — no column needed: 10xx/11xx Cash & Bank, 14xx Current Assets
// (Input GST), 15xx Fixed Assets, 16xx Accumulated Depreciation (a contra
// asset: credit balance), other assets Current Assets; liabilities Current
// Liabilities; expenses Expenses; income Income; equity Capital.
function groupOf(a) {
  const code = String((a && a.code) || '');
  const type = String((a && a.type) || '').toUpperCase();
  if (type === 'ASSET') {
    if (/^1[01]/.test(code)) return 'Cash & Bank';
    if (/^15/.test(code)) return 'Fixed Assets';
    if (/^16/.test(code)) return 'Accumulated Depreciation';
    return 'Current Assets';
  }
  if (type === 'LIABILITY') return 'Current Liabilities';
  if (type === 'EXPENSE') return 'Expenses';
  if (type === 'INCOME') return 'Income';
  if (type === 'EQUITY') return 'Capital';
  return 'Other';
}

// Debit-natured accounts (assets, expenses) carry a Dr balance; the rest Cr.
// Accumulated depreciation is an ASSET-type contra account, so it is shown
// as a negative (credit) asset balance — the Balance Sheet nets it.
const debitNatured = (a) => ['ASSET', 'EXPENSE'].includes(String((a && a.type) || '').toUpperCase());

// Create an account if it is missing (by code). Used for the per-category
// fixed-asset ledgers and the per-bank ledgers, which are made on demand.
async function ensureAccount({ code, name, type, aliases = null, description = null }) {
  const byCode = await prisma.ledgerAccount.findUnique({ where: { code } });
  if (byCode) return byCode;
  try {
    return await prisma.ledgerAccount.create({ data: { code, name, type, aliases, description, isSystem: true } });
  } catch (err) {
    if (err && err.code === 'P2002') {
      const again = await prisma.ledgerAccount.findFirst({ where: { OR: [{ code }, { name }] } });
      if (again) return again;
    }
    throw err;
  }
}

class LedgerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function ensureChart() {
  for (const a of CHART) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await prisma.ledgerAccount.findUnique({ where: { code: a.code } });
    // eslint-disable-next-line no-await-in-loop
    if (!exists) await prisma.ledgerAccount.create({ data: { ...a, isSystem: true } }).catch(() => {});
    // S3: 2100 is "Salary Payable" now; the old name stays as an alias.
    // eslint-disable-next-line no-await-in-loop
    else if (exists.isSystem && ((a.code === '2100' && exists.name === 'Payable to Employee') || (a.code === '5100' && /employer PF/.test(exists.description || '')))) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.ledgerAccount.update({ where: { id: exists.id }, data: { name: a.name, aliases: a.aliases, description: a.description } }).catch(() => {});
    }
  }
}

const norm = (s) => String(s || '').trim().toLowerCase();

async function accountIndex() {
  const accounts = await prisma.ledgerAccount.findMany();
  const byKey = new Map();
  accounts.forEach((a) => {
    byKey.set(norm(a.code), a);
    byKey.set(norm(a.name), a);
    String(a.aliases || '').split(',').map(norm).filter(Boolean).forEach((al) => byKey.set(al, a));
  });
  return byKey;
}

const paise = (n) => Math.round(Number(n) * 100);

// The service token the HRMS payroll module presents. ACCOUNTS_SERVICE_TOKEN
// wins; otherwise it is derived from JWT_SECRET, so no new secret has to be
// configured for the two modules of this one server to talk.
function serviceToken() {
  if (process.env.ACCOUNTS_SERVICE_TOKEN) return process.env.ACCOUNTS_SERVICE_TOKEN;
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || 'teamlink')).update('teamlink:accounts-journal:v1').digest('hex');
}
function isServiceToken(given) {
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(serviceToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normaliseMonth(body) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(body.month || ''))) return String(body.month);
  const m = Number(body.month);
  const y = Number(body.year);
  if (Number.isInteger(m) && m >= 1 && m <= 12 && Number.isInteger(y) && y > 1900) return `${y}-${String(m).padStart(2, '0')}`;
  return null;
}

// payload: the SPEC B shape —
//   { employee_id, month, year, debit: [{account, amount}], credit: [{account, amount}] }
// plus the envelope: idempotency_key (or the Idempotency-Key header),
// payroll_run_id / reference_type / reference_id, date, narration.
async function postJournal(payload, { idempotencyKey: headerKey = null, actor = null } = {}) {
  const body = payload || {};
  const key = String(body.idempotency_key || headerKey || '').trim();
  if (!key) throw new LedgerError(400, 'idempotency_key is required');
  if (key.length > 200) throw new LedgerError(400, 'idempotency_key is too long');
  const month = normaliseMonth(body);
  if (!month) throw new LedgerError(400, 'month (1-12) and year are required');
  const debit = Array.isArray(body.debit) ? body.debit : null;
  const credit = Array.isArray(body.credit) ? body.credit : null;
  if (!debit || !credit || !debit.length || !credit.length) throw new LedgerError(400, 'debit and credit lines are required');

  const index = await accountIndex();
  const lines = [];
  const take = (side, arr) => {
    arr.forEach((l, i) => {
      const amount = Number(l && l.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new LedgerError(422, `${side} line ${i + 1}: amount must be a number of 0 or more`);
      if (Math.abs(paise(amount) - amount * 100) > 1e-6) throw new LedgerError(422, `${side} line ${i + 1}: amount has more than 2 decimals`);
      const acct = index.get(norm(l.account)) || index.get(norm(l.code));
      if (!acct) throw new LedgerError(422, `Unknown account "${l.account || l.code}"`);
      if (!acct.isActive) throw new LedgerError(422, `Account "${acct.name}" is inactive`);
      if (paise(amount) === 0) return; // a zero line (e.g. TDS 0) is not booked
      lines.push({
        accountId: acct.id, accountCode: acct.code, accountName: acct.name,
        debit: side === 'debit' ? paise(amount) / 100 : 0,
        credit: side === 'credit' ? paise(amount) / 100 : 0,
        memo: l.memo ? String(l.memo).slice(0, 300) : null,
        // A line may name its own record (e.g. one asset in a depreciation run).
        lineRefType: l.reference_type ? String(l.reference_type).slice(0, 60) : null,
        lineRefId: l.reference_id ? String(l.reference_id).slice(0, 100) : null,
      });
    });
  };
  take('debit', debit);
  take('credit', credit);
  const dr = lines.reduce((n, l) => n + paise(l.debit), 0);
  const cr = lines.reduce((n, l) => n + paise(l.credit), 0);
  if (dr === 0) throw new LedgerError(422, 'The entry has no amount');
  if (dr !== cr) throw new LedgerError(422, `Unbalanced entry: debits ${(dr / 100).toFixed(2)} vs credits ${(cr / 100).toFixed(2)}`);

  const referenceType = body.reference_type || (body.payroll_run_id ? 'PAYROLL_RUN' : null);
  const referenceId = body.reference_id || body.payroll_run_id || null;

  const existing = await prisma.journalEntry.findUnique({ where: { idempotencyKey: key }, include: { lines: true } });
  if (existing) {
    if (paise(existing.totalDebit) !== dr) {
      throw new LedgerError(409, `Idempotency key ${key} was already booked with a different amount (${existing.totalDebit.toFixed(2)})`);
    }
    return { status: 200, replay: true, entry: existing };
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : new Date().toISOString().slice(0, 10);
  try {
    const entry = await prisma.journalEntry.create({
      data: {
        date, month,
        narration: body.narration ? String(body.narration).slice(0, 500) : null,
        source: body.source || (referenceType && referenceType.startsWith('PAYROLL') ? 'HRMS_PAYROLL' : 'MANUAL'),
        referenceType, referenceId, idempotencyKey: key,
        employeeId: body.employee_id || null, employeeName: body.employee_name || null,
        totalDebit: dr / 100, totalCredit: cr / 100,
        payload: JSON.stringify(body).slice(0, 20000),
        createdBy: actor && actor.id ? actor.id : null,
        createdByName: actor ? actor.name : null,
        lines: {
          create: lines.map(({ lineRefType, lineRefId, ...l }, i) => ({
            ...l, lineNo: i + 1, referenceType: lineRefType || referenceType, referenceId: lineRefId || referenceId,
          })),
        },
      },
      include: { lines: true },
    });
    return { status: 201, replay: false, entry };
  } catch (err) {
    if (err && err.code === 'P2002') {
      // Lost a race on the same key: the other request booked it.
      const again = await prisma.journalEntry.findUnique({ where: { idempotencyKey: key }, include: { lines: true } });
      if (again) return { status: 200, replay: true, entry: again };
    }
    throw err;
  }
}

// A REVERSAL: never edit or delete a booked entry — book its mirror image
// (every Dr becomes a Cr and back) under the key "<original key>:reversal",
// so one entry can be reversed once only. Dated like the original by default
// (so the original's month nets to zero), referenceType REVERSAL /
// referenceId = the original entry's id.
const reversalKey = (key) => `${key}:reversal`;

async function reverseJournal(entryId, { actor = null, narration = null, date = null } = {}) {
  const orig = await prisma.journalEntry.findUnique({ where: { id: entryId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  if (!orig) throw new LedgerError(404, 'Journal entry not found');
  if (orig.referenceType === 'REVERSAL') throw new LedgerError(409, 'A reversal cannot itself be reversed');
  const key = reversalKey(orig.idempotencyKey);
  const existing = await prisma.journalEntry.findUnique({ where: { idempotencyKey: key }, include: { lines: true } });
  if (existing) return { status: 200, replay: true, entry: existing };
  const [y, m] = orig.month.split('-').map(Number);
  return postJournal({
    month: m, year: y,
    date: date || orig.date,
    narration: narration || `Reversal of ${orig.narration || orig.idempotencyKey}`,
    source: orig.source,
    reference_type: 'REVERSAL',
    reference_id: orig.id,
    idempotency_key: key,
    employee_id: orig.employeeId, employee_name: orig.employeeName,
    reverses: orig.id,
    // Mirror the lines (each keeps its own record reference).
    debit: orig.lines.filter((l) => l.credit > 0).map((l) => ({ account: l.accountCode, amount: l.credit, memo: l.memo, reference_type: l.referenceType, reference_id: l.referenceId })),
    credit: orig.lines.filter((l) => l.debit > 0).map((l) => ({ account: l.accountCode, amount: l.debit, memo: l.memo, reference_type: l.referenceType, reference_id: l.referenceId })),
  }, { actor });
}

// Is this entry reversed? (its ":reversal" twin exists)
async function reversalOf(entry) {
  if (!entry) return null;
  return prisma.journalEntry.findUnique({ where: { idempotencyKey: reversalKey(entry.idempotencyKey) } });
}

// The month of a date string (YYYY-MM-DD -> YYYY-MM).
const monthOfDate = (d) => String(d || '').slice(0, 7);

// The last day of a YYYY-MM month (YYYY-MM-DD).
function monthEnd(month) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

// BOOKS CLOSED UP TO (S2.3 "a closed period → a warning"): an Accounts
// setting, YYYY-MM or null. A change that would touch a closed month is
// refused with a warning unless the caller confirms it.
const CLOSED_KEY = 'accounts.booksClosedUpTo';
async function closedUpTo() {
  const row = await prisma.appSetting.findUnique({ where: { key: CLOSED_KEY } }).catch(() => null);
  if (!row) return null;
  try { const v = JSON.parse(row.value); return /^\d{4}-\d{2}$/.test(String(v || '')) ? v : null; } catch { return null; }
}
async function isClosedMonth(month) {
  const c = await closedUpTo();
  return !!(c && String(month) <= c);
}

module.exports = {
  CHART, LedgerError, ensureChart, ensureAccount, accountIndex, serviceToken, isServiceToken, postJournal, paise,
  groupOf, debitNatured, reverseJournal, reversalOf, reversalKey, monthOfDate, monthEnd, closedUpTo, isClosedMonth, CLOSED_KEY,
};

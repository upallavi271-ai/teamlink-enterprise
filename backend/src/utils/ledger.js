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
  { code: '2100', name: 'Payable to Employee', type: 'LIABILITY', aliases: 'Bank/Payable to Employee', description: 'Net salary owed to employees until the bank payment is made' },
  { code: '2210', name: 'PF Payable', type: 'LIABILITY', aliases: null, description: 'Employee + employer provident fund due to EPFO' },
  { code: '2220', name: 'ESI Payable', type: 'LIABILITY', aliases: null, description: 'Employee + employer ESI due to ESIC' },
  { code: '2230', name: 'TDS Payable', type: 'LIABILITY', aliases: null, description: 'Tax deducted at source from salaries (Sec 192)' },
  { code: '2240', name: 'PT Payable', type: 'LIABILITY', aliases: null, description: 'Professional tax due to the state' },
  { code: '2250', name: 'Other Deductions Payable', type: 'LIABILITY', aliases: null, description: 'Other salary deductions / recoveries held for settlement' },
  { code: '5100', name: 'Salary Expense', type: 'EXPENSE', aliases: null, description: 'Earned gross salary plus employer PF / ESI' },
];

class LedgerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function ensureChart() {
  for (const a of CHART) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await prisma.ledgerAccount.findUnique({ where: { code: a.code } });
    // eslint-disable-next-line no-await-in-loop
    if (!exists) await prisma.ledgerAccount.create({ data: { ...a, isSystem: true } }).catch(() => {});
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
        lines: { create: lines.map((l, i) => ({ ...l, lineNo: i + 1, referenceType, referenceId })) },
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

module.exports = {
  CHART, LedgerError, ensureChart, accountIndex, serviceToken, isServiceToken, postJournal, paise,
};

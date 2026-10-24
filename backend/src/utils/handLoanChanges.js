// HAND LOANS - edit and remove (Accounts, 2026-10-19). Pure rules plus the one small table that keeps removed entries.
//
// What a "hand entry" is: one HandLoan row (a person, the amount taken, the date taken, a note). Its movements are
// HandLoanLink rows pointing at bank statement lines: the credit it was taken on and every repayment. The statement
// lines themselves are never edited here.
//
// EDIT   changes the entry's own words and numbers (name, lender, amount, date taken, notes) and refuses a change that
//        would disagree with the bank statement (see planEdit).
// REMOVE never deletes history. The entry is moved, with who / when / why, into HandLoanRemoved (a snapshot of the
//        whole row) and the row leaves HandLoan, so every total and every list that reads HandLoan drops it at once.
//        An entry that still has a statement line linked cannot be removed: unlink the lines first (the existing
//        reversal), so no reconciled line is ever left pointing at nothing.
//
// HandLoanRemoved is created here when missing (CREATE TABLE IF NOT EXISTS, the same self-provisioning the job flow and
// join drop tables use). It is only ever created by the first removal; reading it before that is safe.
const prisma = require('../db');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const BANK_TOL = 20; // the same slack the statement matching uses

const NAME_MAX = 120;
const NOTES_MAX = 1000;
const REASON_MIN = 3;
const REASON_MAX = 300;
const AMOUNT_MAX = 100000000000; // ₹10,000 crore - anything above is a typing slip

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Today as YYYY-MM-DD in the server's own calendar.
function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// A real calendar date written YYYY-MM-DD (2026-02-30 and 2026-13-01 are not).
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1990 || mo < 1 || mo > 12 || d < 1) return false;
  const last = new Date(y, mo, 0).getDate();
  return d <= last;
}

// The amount as a number, or null when it is not a plain positive money figure. Numbers and plain strings only
// ("12,500.50" is fine; "12abc", "", true, [5], Infinity and "1e9" are not).
function parseAmount(v) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const t = v.replace(/[,\s]/g, '').replace(/^₹/, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    n = Number(t);
  } else return null;
  if (!Number.isFinite(n)) return null;
  return n;
}

// Field-by-field problems of an entry as typed. `{}` means it is fine.
function loanProblems(b, { today = todayIso(), checkDate = true } = {}) {
  const e = {};
  const name = String(b.name == null ? '' : b.name).trim();
  if (!name) e.name = 'Give the loan a name.';
  else if (name.length > NAME_MAX) e.name = `The name is too long (${NAME_MAX} letters at most).`;
  if (b.lender != null && String(b.lender).trim().length > NAME_MAX) e.lender = `The lender is too long (${NAME_MAX} letters at most).`;
  const amt = parseAmount(b.amount);
  if (amt == null || !(amt > 0)) e.amount = 'Enter the amount taken, as a number above zero.';
  else if (amt > AMOUNT_MAX) e.amount = 'That amount is too big - check the zeros.';
  else if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-4) e.amount = 'Use rupees and paise only (two numbers after the dot).';
  if (checkDate) {
    if (!isRealDate(b.dateTaken)) e.dateTaken = 'Enter the date taken (a real date).';
    else if (String(b.dateTaken) > today) e.dateTaken = 'The date taken cannot be in the future.';
  }
  if (b.notes != null && String(b.notes).length > NOTES_MAX) e.notes = `The notes are too long (${NOTES_MAX} letters at most).`;
  return e;
}

const clean = (b) => ({
  name: String(b.name).trim().slice(0, NAME_MAX),
  lender: String(b.lender || '').trim().slice(0, NAME_MAX) || null,
  amount: ROUND(parseAmount(b.amount)),
  dateTaken: String(b.dateTaken).slice(0, 10),
  notes: String(b.notes || '').trim().slice(0, NOTES_MAX) || null,
});

const LABEL = { name: 'name', lender: 'lender', amount: 'amount', dateTaken: 'date taken', notes: 'notes' };
const show = (k, v) => (v == null || v === '' ? '(empty)' : k === 'amount' ? money(v) : String(v));

// What an edit would do. `loan` is the stored entry, `links` its statement movements, `figures` bank.js loanFigures(loan),
// `others` every other entry (for the duplicate check), `closedUpTo` the books-closed month (YYYY-MM) or null.
// Returns { error, status } or { data, changes, summary: {from, to}, unchanged }.
function planEdit({
  loan, figures, others = [], body = {}, today = todayIso(), closedUpTo = null,
}) {
  const merged = { ...loan, ...body };
  // An old entry whose date is already in the future (or odd) may still have its notes fixed: the date is only
  // checked when the edit changes it.
  const dateChanged = body.dateTaken !== undefined && String(body.dateTaken).slice(0, 10) !== loan.dateTaken;
  const problems = loanProblems(merged, { today, checkDate: dateChanged });
  if (Object.keys(problems).length) return { status: 400, error: 'Some fields need attention.', fields: problems };

  const next = clean(merged);
  const norm1 = (k, o) => (k === 'amount' ? ROUND(o[k]) : (o[k] === '' || o[k] == null ? null : o[k]));
  const changes = Object.keys(LABEL).filter((k) => norm1(k, next) !== norm1(k, loan));
  if (!changes.length) return { unchanged: true, data: next, changes, summary: { from: '', to: '' } };

  const taken = figures.taken;
  const money1 = changes.includes('amount');
  const date1 = changes.includes('dateTaken');

  if (money1 && next.amount < figures.repaid - 0.5) {
    return { status: 400, error: `${money(figures.repaid)} is already paid back on this entry, so the amount cannot be lower than that.`, fields: { amount: `At least ${money(figures.repaid)} (already paid back).` } };
  }
  if (money1 && taken && Math.abs(next.amount - Number(taken.amount)) > BANK_TOL) {
    return { status: 400, error: `The bank statement shows ${money(taken.amount)} coming in for this entry. Unlink that statement line first if the amount really changed.`, fields: { amount: `The statement line says ${money(taken.amount)}.` } };
  }
  if (date1 && figures.repayments.length) {
    const first = figures.repayments.map((r) => String(r.date)).sort()[0];
    if (next.dateTaken > first) {
      return { status: 400, error: `A repayment is dated ${first}, so the date taken cannot be after it.`, fields: { dateTaken: `On or before ${first}.` } };
    }
  }
  if ((money1 || date1) && closedUpTo) {
    const months = [String(loan.dateTaken).slice(0, 7), next.dateTaken.slice(0, 7)];
    if (months.some((m) => m <= closedUpTo)) {
      return { status: 400, error: `The books are closed up to ${closedUpTo}. The amount and date of an entry in a closed month cannot be changed.` };
    }
  }
  if (changes.some((k) => ['name', 'lender', 'amount', 'dateTaken'].includes(k))) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const dup = others.find((o) => o.id !== loan.id && norm(o.name) === norm(next.name) && ROUND(o.amount) === next.amount && o.dateTaken === next.dateTaken);
    if (dup) return { status: 400, error: 'Another entry already has the same name, amount and date - this would be a duplicate.' };
  }
  const from = changes.map((k) => `${LABEL[k]} ${show(k, loan[k])}`).join('; ');
  const to = changes.map((k) => `${LABEL[k]} ${show(k, next[k])}`).join('; ');
  return { data: next, changes, summary: { from, to }, unchanged: false };
}

// ---- removal ---------------------------------------------------------------
const CREATE_SQL = `CREATE TABLE IF NOT EXISTS "HandLoanRemoved" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "loanId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "lender" TEXT,
  "amount" REAL NOT NULL,
  "dateTaken" TEXT NOT NULL,
  "notes" TEXT,
  "createdAt" DATETIME,
  "removedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedById" TEXT,
  "removedByName" TEXT,
  "reason" TEXT NOT NULL,
  "snapshot" TEXT
)`;
let ready = false;
async function ensureRemovedTable() {
  if (ready) return;
  await prisma.$executeRawUnsafe(CREATE_SQL);
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "HandLoanRemoved_loanId_key" ON "HandLoanRemoved"("loanId")');
  ready = true;
}
async function removedTableExists() {
  const r = await prisma.$queryRawUnsafe('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'HandLoanRemoved\'');
  return r.length > 0;
}

function reasonProblem(reason) {
  const t = String(reason == null ? '' : reason).trim();
  if (t.length < REASON_MIN) return 'Say why you are removing it, in a few words.';
  if (t.length > REASON_MAX) return `The reason is too long (${REASON_MAX} letters at most).`;
  return null;
}

// The entries that were removed, newest first. Never throws when nothing was ever removed.
async function listRemoved() {
  if (!(await removedTableExists())) return [];
  const rows = await prisma.$queryRawUnsafe('SELECT "id", "loanId", "name", "lender", "amount", "dateTaken", "notes", "removedAt", "removedByName", "reason" FROM "HandLoanRemoved" ORDER BY "removedAt" DESC, "id" DESC LIMIT 200');
  return rows.map((r) => ({
    id: r.id, loanId: r.loanId, name: r.name, lender: r.lender, amount: ROUND(r.amount), dateTaken: r.dateTaken, notes: r.notes,
    removedAt: new Date(Number(r.removedAt) || r.removedAt).toISOString(), removedByName: r.removedByName, reason: r.reason,
  }));
}

async function wasRemoved(loanId) {
  if (!(await removedTableExists())) return null;
  const r = await prisma.$queryRawUnsafe('SELECT "id", "name", "reason" FROM "HandLoanRemoved" WHERE "loanId" = ?', loanId);
  return r[0] || null;
}

// Move one entry to the removed list, in one transaction. Outcomes:
//   { removed: true }                       done now
//   { already: true, ... }                  it had been removed before (a double click, a second tab): nothing changes
//   { notFound: true }                      no such entry, ever
//   { blocked: true, links, repayments }    statement lines are still linked: unlink them first
async function removeLoan(loanId, { reason, user }) {
  await ensureRemovedTable();
  return prisma.$transaction(async (tx) => {
    const loan = await tx.handLoan.findUnique({ where: { id: loanId }, include: { links: true } });
    if (!loan) {
      const was = await tx.$queryRawUnsafe('SELECT "id", "name", "reason" FROM "HandLoanRemoved" WHERE "loanId" = ?', loanId);
      return was[0] ? { already: true, name: was[0].name } : { notFound: true };
    }
    if (loan.links.length) {
      return { blocked: true, links: loan.links.length, repayments: loan.links.filter((l) => l.kind === 'repayment').length, hasTaken: loan.links.some((l) => l.kind === 'taken'), loan };
    }
    const id = `hlr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await tx.$executeRawUnsafe(
      'INSERT INTO "HandLoanRemoved" ("id","loanId","name","lender","amount","dateTaken","notes","createdAt","removedAt","removedById","removedByName","reason","snapshot") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, loan.id, loan.name, loan.lender, loan.amount, loan.dateTaken, loan.notes, loan.createdAt.getTime(), Date.now(), user.id || null, user.name || user.email || null, String(reason).trim(), JSON.stringify(loan),
    );
    const del = await tx.handLoan.deleteMany({ where: { id: loan.id } });
    if (del.count !== 1) throw new Error('HAND_LOAN_GONE'); // lost a race: roll the snapshot back
    return { removed: true, loan };
  });
}

module.exports = {
  ROUND, BANK_TOL, money, todayIso, isRealDate, parseAmount, loanProblems, clean, planEdit,
  ensureRemovedTable, removedTableExists, reasonProblem, listRemoved, wasRemoved, removeLoan,
  REASON_MIN, REASON_MAX,
};

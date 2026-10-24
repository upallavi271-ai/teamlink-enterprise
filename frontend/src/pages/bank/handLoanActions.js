// Pure helpers for the Hand loans Edit / Remove buttons (no React, no network) - tested by backend/scripts/hand-loan-edit-remove-test.js.
// The server repeats every rule (utils/handLoanChanges.js); these only give the answer before the round trip.

export const REASON_MIN = 3;
export const REASON_CHIPS = ['Entered by mistake', 'Duplicate entry', 'Loan was cancelled'];

const p2 = (n) => String(n).padStart(2, '0');
export const localToday = (now = new Date()) => `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;

export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1990 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(y, mo, 0).getDate();
}

// A plain positive money figure, or null ("12,500.50" is fine; "", "abc", "-5", "1e9", "Infinity" are not).
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[,\s]/g, '').replace(/^₹/, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Field messages for the form. {} = fine. Same words as the server.
export function entryProblems(f, today = localToday()) {
  const e = {};
  if (!String(f.name || '').trim()) e.name = 'Give the loan a name.';
  else if (String(f.name).trim().length > 120) e.name = 'The name is too long (120 letters at most).';
  const a = parseAmount(f.amount);
  if (a == null || !(a > 0)) e.amount = 'Enter the amount taken, as a number above zero.';
  else if (a > 100000000000) e.amount = 'That amount is too big - check the zeros.';
  else if (Math.abs(a * 100 - Math.round(a * 100)) > 1e-4) e.amount = 'Use rupees and paise only (two numbers after the dot).';
  if (!isRealDate(f.dateTaken)) e.dateTaken = 'Enter the date taken (a real date).';
  else if (String(f.dateTaken) > today) e.dateTaken = 'The date taken cannot be in the future.';
  return e;
}

export const reasonProblem = (r) => (String(r || '').trim().length < REASON_MIN ? 'Say why you are removing it, in a few words.' : null);

// The list the "which entry?" window shows: every entry, filtered by what was typed (name, lender, notes, amount, date),
// grouped by person (A-Z) and newest first inside a person.
export function pickerRows(loans, query = '') {
  const q = String(query || '').trim().toLowerCase().replace(/[,₹\s]+/g, ' ').trim();
  const hay = (l) => `${l.name || ''} ${l.lender || ''} ${l.notes || ''} ${l.dateTaken || ''} ${Number(l.amount || 0)}`.toLowerCase();
  return (loans || [])
    .filter((l) => !q || q.split(' ').every((w) => hay(l).includes(w)))
    .sort((a, b) => String(a.lender || a.name).localeCompare(String(b.lender || b.name)) || String(b.dateTaken || '').localeCompare(String(a.dateTaken || '')));
}

// How many entries one person has - the window says so when it is more than one.
export function entriesOfPerson(loans, loan) {
  const who = (l) => String(l.lender || l.name || '').trim().toLowerCase();
  return (loans || []).filter((l) => who(l) === who(loan)).length;
}

// Remove: can it go ahead, and if not, in plain words why.
export function removeBlock(loan) {
  const n = Number(loan && loan.linkCount) || 0;
  if (!n) return null;
  const rep = ((loan.repayments) || []).length;
  const parts = [loan.taken && 'the line it was taken on', rep && `${rep} repayment line${rep === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  return `${n} bank statement line${n === 1 ? ' is' : 's are'} still linked to this entry (${parts || 'linked lines'}). Unlink them first in "Every movement" (Remove on each line). The statement itself is never changed.`;
}

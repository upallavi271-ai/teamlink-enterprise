// ---------------------------------------------------------------------------
// BANK IMPORT CORE (Accounts reconciliation spec, 2026-10-09)
//
// The rules every statement import shares, whichever door the file came in by
// (POST /api/bank/import with pasted CSV, or the "Import any file" screen):
//
//   1. validateRows   every row is checked (real date, positive amount, one
//                     direction, something to read in it). A row that fails is
//                     LISTED with its line number and reason - never dropped
//                     silently - and the rest still import.
//   2. planDuplicates what is already on file. Strongest evidence first:
//                       a) the bank's own transaction id (unique per account)
//                       b) a real reference / UTR / cheque no. + date + amount + direction
//                       c) date + amount + direction + narration (+ balance when the
//                          statement prints one), COUNTED: two identical lines in one
//                          file are two transactions; they are only duplicates when
//                          the account already holds that many of them.
//                     A line that matches only on (c) beyond what is on file is
//                     imported but flagged "Needs Review" (possible duplicate).
//   3. checkBalances  opening + credits - debits = closing, and the running
//                     balance line by line, where the statement gives them.
//                     Nothing is ever changed to force a tie.
//
// Money is stored as Float rounded to 2 dp elsewhere in this app; here every
// comparison is done in integer paise so 0.1 + 0.2 style noise cannot matter.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const fromPaise = (p) => p / 100;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const normNarr = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// A reference worth trusting as an identity: not blank filler like 0 or 000000.
function strongRef(ref) {
  const t = String(ref || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length < 6 || !/\d/.test(t)) return null;
  if (/^(.)\1+$/.test(t) || /^0+$/.test(t.replace(/[A-Z]/g, ''))) return null;
  return t;
}

const clean = (v, max) => {
  const t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
};

// ---- 1. validation ---------------------------------------------------------
// rows: [{ line?, date, valueDate?, description?, reference?, externalId?, amount, type?, credit?, debit?, balance?, raw? }]
function validateRows(rows, { today = istToday() } = {}) {
  const ok = [];
  const failed = [];
  const lastOk = new Date(`${today}T00:00:00Z`);
  lastOk.setUTCDate(lastOk.getUTCDate() + 1);
  const limit = lastOk.toISOString().slice(0, 10);
  rows.forEach((r, i) => {
    const line = r.line != null ? r.line : i + 1;
    const fail = (reason) => failed.push({ line, reason, row: r.raw || { date: r.date, description: r.description, reference: r.reference, amount: r.amount, type: r.type, balance: r.balance } });
    const date = String(r.date || '').slice(0, 10);
    if (!date) return fail('No date');
    if (!isRealDate(date)) return fail(`"${date}" is not a real date`);
    if (date > limit) return fail(`Date ${date} is in the future`);
    let type = r.type;
    const cr = Number(r.credit);
    const dr = Number(r.debit);
    if (!type && (cr > 0 || dr > 0)) {
      if (cr > 0 && dr > 0) return fail('Both a debit and a credit amount on one line');
      type = cr > 0 ? 'Credit' : 'Debit';
    }
    if (type !== 'Credit' && type !== 'Debit') return fail('Could not tell if the line is a debit or a credit');
    let amount = r.amount != null ? Number(r.amount) : (cr > 0 ? cr : dr);
    if (!Number.isFinite(amount)) return fail('The amount is not a number');
    amount = Math.abs(amount);
    if (!(amount > 0)) return fail('The amount is zero');
    const p = amount * 100;
    if (Math.abs(p - Math.round(p)) > 0.0001) return fail(`The amount ${amount} has more than 2 decimals`);
    let balance = null;
    if (r.balance != null && r.balance !== '') {
      balance = Number(r.balance);
      if (!Number.isFinite(balance)) return fail('The balance is not a number');
    }
    const description = clean(r.description, 500);
    const reference = clean(r.reference, 120) || null;
    const externalId = clean(r.externalId, 80) || null;
    if (!description && !reference && !externalId) return fail('No narration, reference or transaction id to identify the line');
    let valueDate = null;
    const warnings = [];
    if (r.valueDate) {
      const v = String(r.valueDate).slice(0, 10);
      if (isRealDate(v)) valueDate = v; else warnings.push(`value date "${v}" ignored`);
    }
    ok.push({
      line,
      date,
      valueDate,
      description: description || '—',
      reference,
      externalId,
      type,
      amount: fromPaise(Math.round(p)),
      paise: Math.round(p),
      balance: balance == null ? null : fromPaise(toPaise(balance)),
      raw: r.raw || null,
      warnings,
    });
  });
  return { ok, failed };
}

// ---- 2. duplicates ---------------------------------------------------------
// existing: BankTransaction rows already on the account.
// Returns { fresh: [row + reviewReason?], duplicates: [{ row, why, of }] }
function planDuplicates(rows, existing) {
  const byExt = new Map();
  const byRef = new Map();
  const byWeak = new Map();
  const weakKey = (t) => [t.date, t.type, toPaise(t.amount), normNarr(t.description)].join('|');
  const refKey = (t, ref) => [t.date, t.type, toPaise(t.amount), ref].join('|');
  existing.forEach((t) => {
    if (t.externalId) { if (!byExt.has(t.externalId)) byExt.set(t.externalId, []); byExt.get(t.externalId).push(t); }
    const sr = strongRef(t.reference);
    if (sr) {
      const k = refKey(t, sr);
      if (!byRef.has(k)) byRef.set(k, []);
      byRef.get(k).push(t);
    }
    const w = weakKey(t);
    if (!byWeak.has(w)) byWeak.set(w, []);
    byWeak.get(w).push(t);
  });
  const consumed = new Set(); // existing ids already accounted for by a file row
  const seenExt = new Map(); // bank id -> file rows already accepted
  const fileRefs = new Map(); // refKey -> rows of this file already accepted
  const fresh = [];
  const duplicates = [];
  const sameBal = (a, b) => a == null || b == null || Math.abs(Number(a) - Number(b)) < 0.005;
  const bothBal = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
  // An older import that mistook the "Transaction Date" column for the narration left the DATE as the narration.
  const damaged = (t) => /^\d{1,2}[\/-][A-Za-z]{3}[\/-]\d{4}$/.test(String(t.description || '').trim());
  // A bank's own id is only an identity together with the rest of the line: ICICI prints ONE Tran. Id for the
  // several lines of a posting (a charge and its GST), so the id + date + amount + direction + (balance or narration).
  const sameLine = (a, b) => a.date === b.date && a.type === b.type && toPaise(a.amount) === toPaise(b.amount)
    && (bothBal(a.balance, b.balance) || normNarr(a.description) === normNarr(b.description));

  rows.forEach((row) => {
    let r = row;
    // a) the bank's own id
    if (r.externalId) {
      const onFile = (byExt.get(r.externalId) || []).filter((t) => !consumed.has(t.id));
      const hit = onFile.find((t) => sameLine(t, r));
      if (hit) { consumed.add(hit.id); duplicates.push({ row: r, why: 'Same bank transaction id and the same line are already on file', of: hit.id, strong: true }); return; }
      const earlier = (seenExt.get(r.externalId) || []).find((x) => sameLine(x, r));
      if (earlier) { duplicates.push({ row: r, why: `Same bank transaction id and line as line ${earlier.line} of this file`, of: null, strong: true }); return; }
      if ((byExt.get(r.externalId) || []).length || (seenExt.get(r.externalId) || []).length) {
        // the id is shared by a DIFFERENT line (one posting, several lines): keep the line, do not use the id as its key
        r = { ...r, externalId: null };
      } else {
        if (!seenExt.has(r.externalId)) seenExt.set(r.externalId, []);
        seenExt.get(r.externalId).push(r);
      }
    }
    // b) a real reference
    const sr = strongRef(r.reference);
    if (sr) {
      const hits = (byRef.get(refKey(r, sr)) || []).filter((t) => !consumed.has(t.id) && sameBal(t.balance, r.balance));
      if (hits.length) { consumed.add(hits[0].id); duplicates.push({ row: r, why: 'Same date, amount and reference are already on file', of: hits[0].id, strong: true }); return; }
      const fk = refKey(r, sr);
      const earlier = (fileRefs.get(fk) || []).find((x) => sameBal(x.balance, r.balance));
      if (earlier) { duplicates.push({ row: r, why: `Same date, amount and reference as line ${earlier.line} of this file`, of: null, strong: true }); return; }
      if (!fileRefs.has(fk)) fileRefs.set(fk, []);
      fileRefs.get(fk).push(r);
    }
    // b2) the same line imported before by the old importer, which lost its narration: recognised by balance
    if (r.balance != null) {
      const old = existing.find((t) => !consumed.has(t.id) && damaged(t) && t.type === r.type && toPaise(t.amount) === r.paise && bothBal(t.balance, r.balance));
      if (old) { consumed.add(old.id); duplicates.push({ row: r, why: 'Already on file from an older import that lost its narration (run the narration repair, do not import again)', of: old.id, strong: true, legacy: true }); return; }
    }
    // c) counted weak match
    const cands = (byWeak.get(weakKey(r)) || []).filter((t) => !consumed.has(t.id));
    const balanced = cands.filter((t) => sameBal(t.balance, r.balance));
    if (balanced.length) {
      // prefer an exact balance match, so identical twins pair off with the right copy
      const exact = r.balance != null ? balanced.find((t) => t.balance != null && Math.abs(Number(t.balance) - r.balance) < 0.005) : null;
      const pick = exact || balanced[0];
      consumed.add(pick.id);
      duplicates.push({ row: r, why: 'Same date, amount and narration are already on file', of: pick.id, strong: r.balance != null && pick.balance != null });
      return;
    }
    // not on file (or on file with a DIFFERENT balance = a different transaction)
    const sameLooking = (byWeak.get(weakKey(r)) || []);
    const possible = sameLooking.length > 0 && r.balance == null;
    fresh.push(possible
      ? { ...r, reviewReason: 'Possible duplicate: same date, amount and narration as a line already on file - check before relying on it' }
      : r);
  });
  // Twin lines inside the file itself are both kept (they are two transactions);
  // when the statement prints no balance and no reference to tell them apart,
  // say so on the second one.
  const seenFile = new Map();
  fresh.forEach((r) => {
    if (r.reviewReason || r.externalId || strongRef(r.reference) || r.balance != null) return;
    const k = weakKey(r);
    seenFile.set(k, (seenFile.get(k) || 0) + 1);
    if (seenFile.get(k) > 1) r.reviewReason = 'Identical to another line in this file (same date, amount, narration) and the statement gives nothing to tell them apart - confirm both are real';
  });
  return { fresh, duplicates };
}

// ---- 3. balances -----------------------------------------------------------
// rows: validated rows in FILE order. stated: { opening?, closing? } numbers from the file's own summary lines.
function checkBalances(rows, stated = {}) {
  const signedP = (r) => (r.type === 'Credit' ? r.paise : -r.paise);
  const withBal = rows.filter((r) => r.balance != null);
  const out = {
    checked: false, ok: null, order: null, opening: null, closing: null, expected: null, diff: null, breaks: [], limitation: null,
    credits: fromPaise(rows.filter((r) => r.type === 'Credit').reduce((s, r) => s + r.paise, 0)),
    debits: fromPaise(rows.filter((r) => r.type === 'Debit').reduce((s, r) => s + r.paise, 0)),
  };
  if (withBal.length < 1 && stated.opening == null && stated.closing == null) {
    out.limitation = 'The statement carries no balance column and no opening / closing balance, so the totals could not be checked.';
    return out;
  }
  // Which way is time running in the file? Pick the order in which the printed balances chain.
  const chain = (list) => {
    let hits = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].balance == null || list[i - 1].balance == null) continue;
      if (toPaise(list[i - 1].balance) + signedP(list[i]) === toPaise(list[i].balance)) hits += 1;
    }
    return hits;
  };
  const fwd = chain(rows);
  const rev = chain([...rows].reverse());
  const ordered = rev > fwd ? [...rows].reverse() : rows;
  out.order = rev > fwd ? 'newest first' : 'oldest first';
  // Break list: wherever the printed balance does not follow from the one before.
  for (let i = 1; i < ordered.length; i += 1) {
    const a = ordered[i - 1];
    const b = ordered[i];
    if (a.balance == null || b.balance == null) continue;
    const expect = toPaise(a.balance) + signedP(b);
    if (expect !== toPaise(b.balance)) {
      out.breaks.push({
        afterLine: a.line, atLine: b.line, date: b.date, expected: fromPaise(expect), printed: b.balance, gap: fromPaise(toPaise(b.balance) - expect),
      });
    }
  }
  // Opening: the file's own figure, else worked back from the first line's balance.
  let openP = null;
  let openFrom = null;
  if (stated.opening != null) { openP = toPaise(stated.opening); openFrom = 'stated in the file'; } else if (ordered.length && ordered[0].balance != null) {
    openP = toPaise(ordered[0].balance) - signedP(ordered[0]);
    openFrom = 'worked back from the first line';
  }
  let closeP = null;
  let closeFrom = null;
  if (stated.closing != null) { closeP = toPaise(stated.closing); closeFrom = 'stated in the file'; } else {
    const last = [...ordered].reverse().find((r) => r.balance != null);
    if (last) { closeP = toPaise(last.balance); closeFrom = 'the last printed balance'; }
  }
  if (openP == null || closeP == null) {
    out.limitation = 'Not enough balance information in the file to check opening + credits - debits = closing.';
    out.opening = openP == null ? null : { value: fromPaise(openP), from: openFrom };
    out.closing = closeP == null ? null : { value: fromPaise(closeP), from: closeFrom };
    out.checked = out.breaks.length === 0 && withBal.length > 1;
    out.ok = out.breaks.length ? false : null;
    return out;
  }
  const net = ordered.reduce((s, r) => s + signedP(r), 0);
  const expectedP = openP + net;
  out.checked = true;
  out.opening = { value: fromPaise(openP), from: openFrom };
  out.closing = { value: fromPaise(closeP), from: closeFrom };
  out.expected = fromPaise(expectedP);
  out.diff = fromPaise(closeP - expectedP);
  out.ok = closeP === expectedP && out.breaks.length === 0;
  // Opening worked back from the first line + last printed balance only tie if
  // every line between them is present; say that this is the (weaker) meaning.
  if (openFrom !== 'stated in the file' || closeFrom !== 'stated in the file') {
    out.note = 'Opening / closing were taken from the printed balances, so this proves no line is missing between the first and last printed balance.';
  }
  return out;
}

// Pick the transaction-date and value-date columns out of a header row.
// heads: lower-case header texts. Returns { date, valueDate } indexes (-1 if none).
function pickDateColumns(heads) {
  const idx = (re, skip = []) => heads.findIndex((h, i) => !skip.includes(i) && re.test(h));
  let date = idx(/^(txn|tran|trans|transaction|posting|post|booking)\W*(date|dt)\b/);
  if (date < 0) date = idx(/^date\b/);
  if (date < 0) date = idx(/^(?!.*(value|val\b|due|maturity|cheque|chq)).*(date|\bdt\b)/);
  let valueDate = idx(/(value|val)\W*(date|dt)\b|^value\b/, date >= 0 ? [date] : []);
  if (date < 0 && valueDate >= 0) { date = valueDate; valueDate = -1; } // only a value date is given: it is the date printed
  return { date, valueDate };
}

module.exports = {
  toPaise, fromPaise, sha256, istToday, isRealDate, normNarr, strongRef,
  validateRows, planDuplicates, checkBalances, pickDateColumns,
};

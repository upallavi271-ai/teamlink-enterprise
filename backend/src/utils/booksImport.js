// ---------------------------------------------------------------------------
// ACCOUNTS -> JOURNAL & LEDGER -> IMPORT (Accounts fixes spec, 2026-10-09).
//
// ONE importer behind the Import button of both tabs, with two rule sets:
//
//   journal   CSV / Excel, one row per journal LINE, grouped into entries by the
//             Entry No. Every entry must balance (total debit = total credit, to
//             the paisa) or it is not posted. Each good entry is booked through
//             ledger.postJournal() - the one booking contract - as a MANUAL entry.
//
//   ledger    OPENING BALANCES only. HOW THE LEDGER IS MADE: the Ledger tab is not
//             a table of its own - routes/journal.js builds every account's
//             opening / debit / credit / closing from JournalLine rows. So a
//             "ledger import" that wrote ledger rows would either be invisible or
//             double-post. Instead each as-on date in the file becomes ONE balanced
//             journal entry ("Opening balances as on <date>", referenceType
//             OPENING_BALANCE): the ledger then shows the balances as the Opening
//             of every later period, the trial balance still balances (an entry
//             always does), and nothing is counted twice. If the file's debits and
//             credits differ, the difference can go to "Opening Balance Equity"
//             (the usual accountant's plug) - only when the person ticks it.
//
// Shared by both: file -> PREVIEW (every row checked, row-level errors, nothing
// written) -> the person edits cells or re-uploads -> CHECK again -> COMMIT.
// The server re-validates on commit and trusts nothing from the browser.
// Never silently drops a row: every row ends as imported / skipped (duplicate,
// sample) / failed, with the reason.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const XLSX = require('xlsx');
const prisma = require('../db');
const {
  postJournal, LedgerError, ensureChart, ensureAccount, accountIndex, closedUpTo, monthOfDate, groupOf,
} = require('./ledger');
const { logAudit } = require('./audit');
const { toCsv, toXlsxBook } = require('./tabularExport');

const MAX_ROWS = 5000;
const OPENING_EQUITY = { code: '3900', name: 'Opening Balance Equity', type: 'EQUITY', description: 'Holds the difference when opening balances are imported without a matching entry' };
const TYPES = ['ASSET', 'LIABILITY', 'EXPENSE', 'INCOME', 'EQUITY'];

class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- small parsers ------------------------------------------------------------
const squash = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
const key = (s) => squash(s).toLowerCase();
const paise = (n) => Math.round(Number(n) * 100);
const money = (p) => (p / 100).toFixed(2);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function iso(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Dates: 2026-04-01 · 01/04/2026 · 1-4-26 · 01.04.2026 · 1 Apr 2026 · Apr 1, 2026 · an Excel serial.
function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  const s = squash(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]); // day first (India)
  const mon = (t) => MONTHS[String(t).toLowerCase().slice(0, 3)];
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,.-]+(\d{2}|\d{4})$/.exec(s);
  if (m && mon(m[2])) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon(m[2]), +m[1]);
  m = /^([A-Za-z]{3,9})[ ,.-]+(\d{1,2})[ ,.-]+(\d{4})$/.exec(s);
  if (m && mon(m[1])) return iso(+m[3], mon(m[1]), +m[2]);
  return null;
}
// Amounts: 1200 · "1,200.50" · "₹ 1,200" · blank = 0. NaN when it is not a number.
function parseAmount(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = squash(v).replace(/[₹$,]/g, '').replace(/^(rs\.?|inr)\s*/i, '').replace(/\s+/g, '');
  if (s === '' || s === '-' || s === '—') return 0;
  if (/^\(.*\)$/.test(s)) s = `-${s.slice(1, -1)}`;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
const cleanAmountText = (v) => {
  const n = parseAmount(v);
  if (Number.isNaN(n)) return squash(v);
  return n === 0 ? '' : String(Math.round(n * 1e6) / 1e6);
};

// ---- the two layouts ------------------------------------------------------------
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SYN = {
  entryNo: ['entryno', 'entrynumber', 'entry', 'entryid', 'voucher', 'voucherno', 'vouchernumber', 'vchno', 'jvno', 'jv', 'journalno', 'journalentryno', 'journalnumber', 'refno1'],
  date: ['date', 'entrydate', 'voucherdate', 'txndate', 'transactiondate', 'postingdate', 'asondate', 'ason', 'openingdate', 'openingasondate'],
  account: ['account', 'accountcodeorname', 'ledger', 'ledgeraccount', 'accountname', 'ledgername', 'particulars'],
  accountCode: ['accountcode', 'code', 'ledgercode', 'acno', 'accountno'],
  debit: ['debit', 'dr', 'debitamount', 'debitinr', 'openingdebit', 'opendebit', 'drbalance', 'openingdr'],
  credit: ['credit', 'cr', 'creditamount', 'creditinr', 'openingcredit', 'opencredit', 'crbalance', 'openingcr'],
  narration: ['narration', 'description', 'entrynarration', 'remarks', 'details'],
  note: ['linenote', 'memo', 'linememo', 'linenarration', 'note'],
  reference: ['reference', 'ref', 'referenceno', 'refnumber', 'chequeno', 'utr'],
  accountType: ['accounttype', 'type'],
};
const LAYOUT = {
  journal: {
    label: 'Journal',
    columns: [
      ['entryNo', 'Entry No', 'Same number on every line of one entry'],
      ['date', 'Date', 'YYYY-MM-DD or DD/MM/YYYY'],
      ['account', 'Account', 'Code or name from the Accounts sheet'],
      ['debit', 'Debit', 'Amount, or blank'],
      ['credit', 'Credit', 'Amount, or blank'],
      ['narration', 'Narration', 'What the entry is for'],
      ['note', 'Line note', 'Optional'],
      ['reference', 'Reference', 'Optional: cheque / bill no'],
    ],
    required: ['entryNo', 'date', 'debit', 'credit'],
  },
  ledger: {
    label: 'Opening balances',
    columns: [
      ['date', 'As on date', 'The day the balances are as of'],
      ['account', 'Account Code', 'Code or name from the Accounts sheet'],
      ['accountName', 'Account Name', 'Needed only for a new account'],
      ['debit', 'Opening Debit', 'Amount, or blank'],
      ['credit', 'Opening Credit', 'Amount, or blank'],
      ['reference', 'Reference', 'Optional'],
      ['accountType', 'Account Type', 'Only for a new account: ASSET LIABILITY INCOME EXPENSE EQUITY'],
    ],
    required: ['date', 'debit', 'credit'],
  },
};
const FIELDS = { journal: LAYOUT.journal.columns.map((c) => c[0]), ledger: LAYOUT.ledger.columns.map((c) => c[0]) };

// ---- reading the file -------------------------------------------------------------
function readSheet(buffer, fileName) {
  let wb;
  try {
    const isCsv = /\.(csv|txt|tsv)$/i.test(fileName || '');
    wb = isCsv
      ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });
  } catch (err) {
    throw new ImportError(400, 'That file could not be opened. Please save it as .xlsx or .csv and try again.');
  }
  const names = wb.SheetNames || [];
  if (!names.length) throw new ImportError(400, 'The file has no sheets.');
  const pick = names.find((n) => /^(journal|ledger|opening)/i.test(n)) || names[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[pick], { header: 1, raw: true, defval: '', blankrows: true });
  return { aoa, sheet: pick };
}

function parseFile(kind, buffer, fileName) {
  const layout = LAYOUT[kind];
  if (!layout) throw new ImportError(404, 'Unknown import');
  const { aoa, sheet } = readSheet(buffer, fileName);
  // The header row: the first row that names at least two of our columns.
  let h = -1;
  for (let i = 0; i < Math.min(aoa.length, 30); i += 1) {
    const hits = (aoa[i] || []).filter((c) => Object.values(SYN).some((list) => list.includes(norm(c)))).length;
    if (hits >= 3) { h = i; break; }
  }
  if (h < 0) throw new ImportError(400, 'The first rows of the file do not look like the sample (no header row with Date, Debit, Credit…). Download the sample file and copy your rows into it.');
  const colOf = {};
  (aoa[h] || []).forEach((c, ci) => {
    const n = norm(c);
    if (!n) return;
    Object.entries(SYN).forEach(([field, list]) => {
      // Ledger layout: "Account Code" is the main account column and "Account Name" the name one.
      if (list.includes(n) && colOf[field] === undefined) colOf[field] = ci;
    });
  });
  if (kind === 'ledger') {
    // "Account Code" / "Account Name" are two separate columns here.
    const codeIdx = (aoa[h] || []).findIndex((c) => ['accountcode', 'code', 'ledgercode', 'acno', 'accountno'].includes(norm(c)));
    const nameIdx = (aoa[h] || []).findIndex((c) => ['accountname', 'ledgername', 'ledger', 'account', 'particulars'].includes(norm(c)));
    colOf.account = codeIdx >= 0 ? codeIdx : nameIdx;
    colOf.accountName = codeIdx >= 0 && nameIdx >= 0 ? nameIdx : undefined;
  } else if (colOf.account === undefined && colOf.accountCode !== undefined) {
    colOf.account = colOf.accountCode; colOf.accountCode = undefined;
  }
  const missing = [];
  layout.required.forEach((f) => { if (colOf[f] === undefined) missing.push(layout.columns.find((c) => c[0] === f)[1]); });
  if (colOf.account === undefined) missing.push('Account');
  if (missing.length) throw new ImportError(400, `The file has no "${missing.join('", "')}" column. Download the sample file and copy your rows into it.`);
  const rows = [];
  let sampleSkipped = 0;
  for (let r = h + 1; r < aoa.length; r += 1) {
    const raw = aoa[r] || [];
    const cell = (f) => (colOf[f] === undefined ? '' : raw[colOf[f]]);
    if (!raw.some((c) => squash(c) !== '')) continue; // an empty spreadsheet row
    const rowObj = { line: r + 1 };
    const entryNo = squash(cell('entryNo'));
    if (/^example/i.test(entryNo)) { sampleSkipped += 1; continue; }
    FIELDS[kind].forEach((f) => {
      const v = cell(f);
      if (f === 'date') rowObj.date = parseDate(v) || (typeof v === 'number' ? String(v) : squash(v));
      else if (f === 'debit' || f === 'credit') rowObj[f] = cleanAmountText(v);
      else rowObj[f] = squash(v);
    });
    // Journal files may carry both a code and a name column: cross-check once, here.
    if (kind === 'journal' && colOf.accountCode !== undefined && colOf.account !== undefined) {
      const code = squash(cell('accountCode'));
      const name = squash(cell('account'));
      if (code && name) { rowObj.account = code; rowObj._nameHint = name; } else if (code) rowObj.account = code;
    }
    rows.push(rowObj);
    if (rows.length > MAX_ROWS) throw new ImportError(413, `The file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  }
  if (!rows.length && !sampleSkipped) throw new ImportError(400, 'The file has a header but no data rows.');
  return { rows, sampleSkipped, sheet, sheetsRead: 1 };
}

// ---- the sample files -----------------------------------------------------------------
async function sampleTable(kind) {
  await ensureChart();
  const accounts = await prisma.ledgerAccount.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
  const by = (code, type, fallbackIdx = 0) => accounts.find((a) => a.code === code) || accounts.filter((a) => !type || a.type === type)[fallbackIdx] || accounts[fallbackIdx];
  const a1 = by('5400', 'EXPENSE');
  const a2 = by('1000', 'ASSET');
  const a3 = by('5100', 'EXPENSE', 1);
  const a4 = by('1100', 'ASSET', 1);
  const today = new Date().toISOString().slice(0, 10);
  const layout = LAYOUT[kind];
  const headers = layout.columns.map((c) => c[1]);
  let rows;
  if (kind === 'journal') {
    rows = [
      ['EXAMPLE-1', today, a1.code, 1500, '', 'Printer repair paid in cash (example - delete these rows)', '', 'Bill 118'],
      ['EXAMPLE-1', today, a2.code, '', 1500, '', '', ''],
      ['EXAMPLE-2', today, a3.name, 25000, '', 'Salary advance by bank (example)', '', ''],
      ['EXAMPLE-2', today, a4.name, '', 25000, '', '', ''],
    ];
  } else {
    rows = [
      [today, a2.code, a2.name, 50000, '', 'Cash in hand (example - delete these rows)', ''],
      [today, a4.code, a4.name, 250000, '', 'Bank statement', ''],
      [today, '2100', 'Salary Payable', '', 300000, 'Example', ''],
    ];
    rows[0][1] = a2.code; rows[2][1] = '2100';
  }
  const help = kind === 'journal'
    ? [
      ['1', 'One row = one line of an entry. Give every line of the same entry the SAME Entry No.'],
      ['2', 'Every entry must balance: the Debit total must equal the Credit total. Unbalanced entries are not posted.'],
      ['3', 'Put the amount in Debit OR Credit on a line - never both.'],
      ['4', 'Account: type the code (like 5400) or the name (like Repairs & Maintenance) from the Accounts sheet.'],
      ['5', 'Dates: 2026-04-01 or 01/04/2026 (day first). Books that are closed cannot be changed.'],
      ['6', 'Rows whose Entry No starts with EXAMPLE are ignored - delete them or keep them, as you like.'],
      ['7', 'Importing the same file twice is safe: entries that are already there are skipped.'],
    ]
    : [
      ['1', 'This file sets the OPENING balance of each account on one date. It does not add history.'],
      ['2', 'Put an account\'s balance in Opening Debit OR Opening Credit (assets and expenses are usually debit, the rest credit).'],
      ['3', 'Debits and credits should add up to the same total. If they do not, you can choose to put the difference in "Opening Balance Equity".'],
      ['4', 'Account Code or Account Name must match the Accounts sheet. A new account needs Code, Name and Account Type and the "Create new accounts" tick.'],
      ['5', 'An account can have one opening balance only. To change it, reverse the earlier opening entry in the Journal first.'],
    ];
  return {
    headers,
    rows,
    book: [
      { name: layout.label, headers, rows },
      { name: 'Accounts', headers: ['Code', 'Name', 'Type', 'Group'], rows: accounts.map((a) => [a.code, a.name, a.type, groupOf(a)]) },
      { name: 'How to fill', headers: ['Step', 'What to do'], rows: help },
    ],
  };
}
async function sampleFile(kind, format) {
  const t = await sampleTable(kind);
  if (format === 'csv') return { buffer: Buffer.from(`﻿${toCsv(t.headers, t.rows)}`, 'utf8'), type: 'text/csv; charset=utf-8', ext: 'csv' };
  return { buffer: toXlsxBook(t.book), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}

// ---- validation ---------------------------------------------------------------------------
const hashOf = (lines) => crypto.createHash('sha1')
  .update(JSON.stringify(lines.map((l) => `${l.code}|${l.dr}|${l.cr}`).sort()))
  .digest('hex').slice(0, 12);

async function voucherNos(ids) {
  if (!ids.length) return new Map();
  const all = await prisma.journalEntry.findMany({ select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const want = new Set(ids);
  const out = new Map();
  all.forEach((e, i) => { if (want.has(e.id)) out.set(e.id, `JV-${String(i + 1).padStart(5, '0')}`); });
  return out;
}

// Which of these booked keys have been reversed (their ":reversal" twin exists)?
async function reversedKeys(keys) {
  const out = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const twins = await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: keys.slice(i, i + 500).map((k) => k + ':reversal') } }, select: { idempotencyKey: true } });
    twins.forEach((t) => out.add(t.idempotencyKey.replace(/:reversal$/, '')));
  }
  return out;
}
// The key is unique in the database; a re-import of a reversed entry gets ":again<n>".
function freeKey(base, used) {
  if (!used.has(base)) return base;
  for (let n = 1; n < 50; n += 1) { const k = base + ':again' + n; if (!used.has(k)) return k; }
  return base + ':again' + Date.now();
}

function suggest(index, text) {
  const t = key(text);
  if (t.length < 2) return [];
  const seen = new Set();
  const out = [];
  index.forEach((a) => {
    if (seen.has(a.id)) return;
    if (key(a.name).includes(t) || t.includes(key(a.name)) || key(a.code).startsWith(t)) { seen.add(a.id); out.push(`${a.code} ${a.name}`); }
  });
  return out.slice(0, 3);
}

// Row-level checks shared by both kinds. Fills row.errors / row.resolved.
function checkCommon(row, ctx, { dateLabel }) {
  const e = row.errors;
  // date
  const d = parseDate(row.date);
  if (!squash(row.date)) e.date = `${dateLabel} is required.`;
  else if (!d) e.date = `"${row.date}" is not a date. Use YYYY-MM-DD or DD/MM/YYYY.`;
  else {
    row.date = d;
    if (d < '2000-01-01' || d > ctx.maxDate) e.date = `${d} looks wrong (the year must be between 2000 and next year).`;
  }
  // amounts
  const dr = parseAmount(row.debit);
  const cr = parseAmount(row.credit);
  if (Number.isNaN(dr)) e.debit = `"${row.debit}" is not an amount.`;
  if (Number.isNaN(cr)) e.credit = `"${row.credit}" is not an amount.`;
  const bad = (n) => !Number.isNaN(n) && (n < 0 || n > 1e11 || Math.abs(paise(n) - n * 100) > 1e-6);
  if (!e.debit && bad(dr)) e.debit = dr < 0 ? 'Debit cannot be negative - put it under Credit instead.' : dr > 1e11 ? 'That amount is too large.' : 'Use at most 2 decimals.';
  if (!e.credit && bad(cr)) e.credit = cr < 0 ? 'Credit cannot be negative - put it under Debit instead.' : cr > 1e11 ? 'That amount is too large.' : 'Use at most 2 decimals.';
  if (!e.debit && !e.credit) {
    if (dr > 0 && cr > 0) { e.debit = 'Fill Debit or Credit - not both.'; e.credit = 'Fill Debit or Credit - not both.'; }
    else if (dr === 0 && cr === 0) { e.debit = 'Enter a Debit or a Credit amount.'; e.credit = 'Enter a Debit or a Credit amount.'; }
    else { row._dr = paise(dr); row._cr = paise(cr); }
  }
  // closed books
  if (d && !e.date && ctx.closed && monthOfDate(d) <= ctx.closed) e.date = `Books are closed up to ${ctx.closed}. This date is in a closed month.`;
}

function resolveAccount(row, ctx) {
  const text = squash(row.account);
  if (!text) { row.errors.account = 'Account is required.'; return null; }
  const a = ctx.index.get(key(text)) || ctx.index.get(key(text.split(/\s+[·\-–—]\s+/)[0]));
  if (!a) {
    const hint = suggest(ctx.index, text);
    row.errors.account = `"${text}" is not in the chart of accounts.${hint.length ? ` Did you mean ${hint.join(' / ')}?` : ''}`;
    return null;
  }
  if (!a.isActive) { row.errors.account = `Account "${a.name}" is switched off.`; return null; }
  row.resolved = { code: a.code, name: a.name, type: a.type };
  return a;
}

async function context(options = {}) {
  await ensureChart();
  const index = await accountIndex();
  const closed = await closedUpTo();
  const y = new Date().getFullYear() + 1;
  return { index, closed, maxDate: `${y}-12-31`, options };
}

const blankRow = (r) => ({ ...r, errors: {}, state: 'ok' });

// ---- journal --------------------------------------------------------------------------------
async function validateJournal(inputRows, options = {}) {
  const ctx = await context(options);
  const rows = inputRows.map((r) => {
    const o = blankRow(FIELDS.journal.reduce((acc, f) => ({ ...acc, [f]: r[f] === undefined || r[f] === null ? '' : String(r[f]) }), { line: r.line, _nameHint: r._nameHint }));
    o.entryNo = squash(o.entryNo);
    return o;
  });
  rows.forEach((row) => {
    if (!row.entryNo) row.errors.entryNo = 'Entry No is required - it groups the lines of one entry.';
    if (row.entryNo.length > 60) row.errors.entryNo = 'Entry No is too long (60 letters at most).';
    checkCommon(row, ctx, { dateLabel: 'Date' });
    const a = resolveAccount(row, ctx);
    if (a && row._nameHint && key(row._nameHint) !== key(a.name) && !ctx.index.get(key(row._nameHint))) {
      row.errors.account = `Code ${a.code} is "${a.name}", but the file says "${row._nameHint}".`;
    } else if (a && row._nameHint) {
      const b = ctx.index.get(key(row._nameHint));
      if (b && b.id !== a.id) row.errors.account = `Code ${a.code} is "${a.name}", but the file says "${row._nameHint}" (${b.code}).`;
    }
  });
  // group into entries
  const groups = new Map();
  rows.forEach((row) => {
    const k = key(row.entryNo) || `__row${row.line}`;
    if (!groups.has(k)) groups.set(k, { key: k, entryNo: row.entryNo, rows: [] });
    groups.get(k).rows.push(row);
  });
  const entries = [];
  for (const g of groups.values()) {
    const problems = [];
    // dates must agree inside one entry
    const okDates = [...new Set(g.rows.filter((r) => !r.errors.date && parseDate(r.date)).map((r) => r.date))];
    if (okDates.length > 1) {
      problems.push(`The lines of entry ${g.entryNo} have different dates (${okDates.join(', ')}). One entry has one date.`);
      g.rows.forEach((r) => { if (!r.errors.date) r.errors.date = 'Not the same date as the other lines of this entry.'; });
    }
    const dr = g.rows.reduce((n, r) => n + (r._dr || 0), 0);
    const cr = g.rows.reduce((n, r) => n + (r._cr || 0), 0);
    const allFine = g.rows.every((r) => !Object.keys(r.errors).length);
    const hasBoth = g.rows.some((r) => r._dr > 0) && g.rows.some((r) => r._cr > 0);
    if (g.rows.length < 2) problems.push(`Entry ${g.entryNo} has only one line. An entry needs at least a debit line and a credit line.`);
    else if (allFine && !hasBoth) problems.push(`Entry ${g.entryNo} has only ${g.rows.some((r) => r._dr > 0) ? 'debit' : 'credit'} lines.`);
    if (allFine && dr !== cr) problems.push(`Entry ${g.entryNo} does not balance: debit ${money(dr)}, credit ${money(cr)} (difference ${money(Math.abs(dr - cr))}). It will not be posted.`);
    const date = okDates[0] || null;
    const ent = {
      key: g.key, entryNo: g.entryNo, date, lines: g.rows.length, debit: dr / 100, credit: cr / 100, difference: Math.abs(dr - cr) / 100,
      rowLines: g.rows.map((r) => r.line), status: 'ready', message: '', problems,
      narration: (g.rows.find((r) => r.narration) || {}).narration || '',
      _rows: g.rows,
    };
    if (problems.length || !allFine) {
      ent.status = 'error';
      ent.message = problems[0] || firstRowProblem(g.rows);
    } else {
      const lines = g.rows.map((r) => ({ code: r.resolved.code, dr: r._dr, cr: r._cr }));
      ent.hash = hashOf(lines);
      ent.idemKey = `import:${g.key}:${date}:${ent.hash}`.slice(0, 200);
    }
    entries.push(ent);
  }
  // duplicates: inside the file, and against the books
  const ready = entries.filter((e) => e.status === 'ready');
  const seen = new Map();
  ready.forEach((e) => {
    const sig = `${e.date}|${e.hash}`;
    if (seen.has(sig)) { e.status = 'duplicate'; e.message = `Same date and amounts as entry ${seen.get(sig)} in this file - skipped.`; } else seen.set(sig, e.entryNo);
  });
  const stillReady = entries.filter((e) => e.status === 'ready');
  if (stillReady.length) {
    const prior = await prisma.journalEntry.findMany({
      where: { OR: [{ idempotencyKey: { startsWith: 'import:' } }, { date: { in: [...new Set(stillReady.map((e) => e.date))] } }] },
      select: { id: true, idempotencyKey: true, date: true, lines: { select: { accountCode: true, debit: true, credit: true } } },
    });
    // An entry that has been REVERSED no longer counts: its number and content may be imported again.
    const rev = await reversedKeys(prior.map((p) => p.idempotencyKey));
    const live = prior.filter((p) => !rev.has(p.idempotencyKey));
    const usedKeys = new Set(prior.map((p) => p.idempotencyKey));
    const byKey = new Map(live.map((p) => [p.idempotencyKey, p]));
    const byEntryNo = new Map();
    live.forEach((p) => {
      const m = /^import:(.+?):(\d{4}-\d{2}-\d{2}):([0-9a-f]{12})(?::again\d+)?$/.exec(p.idempotencyKey);
      if (m) byEntryNo.set(m[1], p);
    });
    const byContent = new Map();
    live.forEach((p) => byContent.set(p.date + '|' + hashOf(p.lines.map((l) => ({ code: l.accountCode, dr: paise(l.debit), cr: paise(l.credit) }))), p));
    const dupIds = [];
    stillReady.forEach((e) => {
      const same = byKey.get(e.idemKey);
      const sameNo = byEntryNo.get(e.key);
      const sameContent = byContent.get(e.date + '|' + e.hash);
      if (same) { e.status = 'duplicate'; e._dup = same.id; dupIds.push(same.id); } else if (sameNo) {
        e.status = 'error'; e._dup = sameNo.id; dupIds.push(sameNo.id);
        e.message = 'Entry No ' + e.entryNo + ' was already imported with a different date or amounts. Use a new Entry No for a new entry.';
        e.problems.push(e.message);
      } else if (sameContent) { e.status = 'duplicate'; e._dup = sameContent.id; dupIds.push(sameContent.id); } else e.idemKey = freeKey(e.idemKey, usedKeys);
    });
    if (dupIds.length) {
      const v = await voucherNos(dupIds);
      stillReady.forEach((e) => {
        if (e.status === 'duplicate' && e._dup) e.message = `Already in the journal as ${v.get(e._dup) || 'an earlier entry'} (same date and amounts) - skipped.`;
        if (e.status === 'error' && e._dup) e.message = `${e.message} (Earlier import: ${v.get(e._dup) || 'in the journal'}.)`;
      });
    }
  }
  finishRows(entries);
  return finish('journal', rows, entries, inputRows.length);
}

// ---- ledger (opening balances) --------------------------------------------------------------
async function validateLedger(inputRows, options = {}) {
  const ctx = await context(options);
  const createAccounts = !!options.createAccounts;
  const plug = !!options.plugDifference;
  const rows = inputRows.map((r) => {
    const o = blankRow(FIELDS.ledger.reduce((acc, f) => ({ ...acc, [f]: r[f] === undefined || r[f] === null ? '' : String(r[f]) }), { line: r.line }));
    o.accountType = squash(o.accountType).toUpperCase();
    o.accountName = squash(o.accountName);
    return o;
  });
  const wantNew = new Set();
  rows.forEach((row) => {
    checkCommon(row, ctx, { dateLabel: 'As on date' });
    const text = squash(row.account);
    const nameText = row.accountName;
    if (!text && !nameText) { row.errors.account = 'Account is required (code or name).'; return; }
    const byCode = text ? ctx.index.get(key(text)) : null;
    const byName = nameText ? ctx.index.get(key(nameText)) : null;
    const found = byCode || byName || (text ? ctx.index.get(key(text.split(/\s+[·\-–—]\s+/)[0])) : null);
    if (found) {
      if (byCode && byName && byCode.id !== byName.id) row.errors.account = `Code ${byCode.code} is "${byCode.name}" but the name column says "${nameText}" (${byName.code}). Fix one of them.`;
      else if (text && nameText && byCode && !byName && key(nameText) !== key(byCode.name)) row.errors.accountName = `Code ${byCode.code} is "${byCode.name}", not "${nameText}".`;
      else if (!found.isActive) row.errors.account = `Account "${found.name}" is switched off.`;
      else row.resolved = { code: found.code, name: found.name, type: found.type };
      return;
    }
    // unknown account
    if (!createAccounts) {
      const hint = suggest(ctx.index, text || nameText);
      row.errors.account = `"${text || nameText}" is not in the chart of accounts.${hint.length ? ` Did you mean ${hint.join(' / ')}?` : ''} To add it, give Code, Name and Account Type and tick "Create new accounts".`;
      return;
    }
    if (!text || !nameText || !row.accountType) {
      row.errors.account = 'To create a new account fill Account Code, Account Name and Account Type.';
      return;
    }
    if (!/^[0-9A-Za-z-]{2,12}$/.test(text)) { row.errors.account = 'The new account code must be 2-12 letters or digits.'; return; }
    if (nameText.length < 2 || nameText.length > 80) { row.errors.accountName = 'The new account name must be 2-80 letters.'; return; }
    if (!TYPES.includes(row.accountType)) { row.errors.accountType = `Account Type must be one of ${TYPES.join(', ')}.`; return; }
    if (ctx.index.get(key(nameText)) || ctx.index.get(key(text))) { row.errors.account = 'That code or name is already used by another account.'; return; }
    const sig = `${key(text)}|${key(nameText)}`;
    wantNew.add(sig);
    row.resolved = { code: text, name: nameText, type: row.accountType, isNew: true };
  });
  // groups by as-on date
  const groups = new Map();
  rows.forEach((row) => {
    const k = row.date && !row.errors.date ? row.date : `__bad${row.line}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  });
  // an account twice on one date
  groups.forEach((list) => {
    const seen = new Map();
    list.forEach((r) => {
      if (!r.resolved) return;
      const k = r.resolved.code;
      if (seen.has(k)) r.errors.account = `This account is already on line ${seen.get(k)} for the same date. Give it one row.`;
      else seen.set(k, r.line);
    });
  });
  // accounts that already have an opening balance
  const codes = [...new Set(rows.filter((r) => r.resolved && !r.resolved.isNew).map((r) => r.resolved.code))];
  const openings = codes.length ? await prisma.journalEntry.findMany({
    where: { referenceType: 'OPENING_BALANCE', lines: { some: { accountCode: { in: codes } } } },
    include: { lines: true },
  }) : [];
  const reversedOpen = await reversedKeys(openings.map((o) => o.idempotencyKey));
  const liveOpenings = openings.filter((o) => !reversedOpen.has(o.idempotencyKey));
  const entries = [];
  for (const [k, list] of groups.entries()) {
    const date = k.startsWith('__bad') ? null : k;
    const problems = [];
    const dr = list.reduce((n, r) => n + (r._dr || 0), 0);
    const cr = list.reduce((n, r) => n + (r._cr || 0), 0);
    // existing opening for any account?
    let dupRows = 0;
    list.forEach((r) => {
      if (!r.resolved || r.resolved.isNew || r.errors.account || r.errors.debit) return;
      const hit = liveOpenings.find((o) => o.lines.some((l) => l.accountCode === r.resolved.code));
      if (!hit) return;
      const line = hit.lines.find((l) => l.accountCode === r.resolved.code);
      if (hit.date === date && paise(line.debit) === r._dr && paise(line.credit) === r._cr) { r.state = 'duplicate'; dupRows += 1; r.dupNote = 'Already has this opening balance.'; } else {
        r.errors.account = `${r.resolved.name} already has an opening balance (${line.debit ? `Dr ${line.debit}` : `Cr ${line.credit}`} on ${hit.date}). Reverse that entry in the Journal first.`;
      }
    });
    const allFine = list.every((r) => !Object.keys(r.errors).length);
    const diff = dr - cr;
    const ent = {
      key: `opening:${date || k}`, entryNo: date ? `Opening balances ${date}` : 'Rows without a valid date', date, lines: list.length,
      debit: dr / 100, credit: cr / 100, difference: Math.abs(diff) / 100, rowLines: list.map((r) => r.line),
      status: 'ready', message: '', problems, plug: 0, narration: date ? `Opening balances as on ${date}` : '', _rows: list,
    };
    if (!allFine) {
      ent.status = 'error';
      ent.message = `${firstRowProblem(list)} (The balances of ${date || 'this date'} are posted together or not at all.)`;
    } else if (dupRows === list.length) {
      ent.status = 'duplicate'; ent.message = 'These opening balances are already in the books - skipped.';
    } else if (dupRows > 0) {
      ent.status = 'error';
      ent.message = `${dupRows} account(s) here already have this opening balance and the rest do not. Remove the ones already imported, then import the rest.`;
    } else if (diff !== 0 && !plug) {
      ent.status = 'error';
      ent.message = `Debits ${money(dr)} and credits ${money(cr)} differ by ${money(Math.abs(diff))}. Fix the amounts, or tick "Put the difference in Opening Balance Equity".`;
      problems.push(ent.message);
    } else {
      const lines = list.map((r) => ({ code: r.resolved.code, dr: r._dr, cr: r._cr }));
      if (diff !== 0) { ent.plug = diff; lines.push({ code: OPENING_EQUITY.code, dr: diff < 0 ? -diff : 0, cr: diff > 0 ? diff : 0 }); }
      ent.hash = hashOf(lines);
      ent.idemKey = `opening:${date}:${ent.hash}`;
      const existing = await prisma.journalEntry.findUnique({ where: { idempotencyKey: ent.idemKey }, select: { id: true, idempotencyKey: true } });
      if (existing) {
        const rv = await reversedKeys([existing.idempotencyKey]);
        if (!rv.has(existing.idempotencyKey)) { ent.status = 'duplicate'; ent.message = 'These opening balances are already in the books - skipped.'; } else {
          const used = new Set((await prisma.journalEntry.findMany({ where: { idempotencyKey: { startsWith: ent.idemKey } }, select: { idempotencyKey: true } })).map((x) => x.idempotencyKey));
          ent.idemKey = freeKey(ent.idemKey, used);
        }
      }
    }
    entries.push(ent);
  }
  finishRows(entries);
  return finish('ledger', rows, entries, inputRows.length, { newAccounts: [...new Set(rows.filter((r) => r.resolved && r.resolved.isNew).map((r) => `${r.resolved.code} ${r.resolved.name}`))] });
}

// "Row 7 - Account: ..." for the first row of a group that has a problem, plus how many more.
function firstRowProblem(list) {
  const bad = list.filter((r) => Object.keys(r.errors).length);
  if (!bad.length) return 'The entry has a problem.';
  const [, msg] = Object.entries(bad[0].errors)[0];
  const more = bad.length > 1 ? ` (and ${bad.length - 1} more row${bad.length > 2 ? 's' : ''})` : '';
  return `Row ${bad[0].line}: ${msg}${more}`;
}

// Every row ends in a state the screen can show.
function finishRows(entries) {
  entries.forEach((e) => {
    (e._rows || []).forEach((r) => {
      const own = Object.keys(r.errors).length > 0;
      if (own) r.state = 'error';
      else if (e.status === 'error') { r.state = 'error'; r.errors._entry = e.message; } else if (e.status === 'duplicate' || r.state === 'duplicate') { r.state = 'duplicate'; r.dupNote = r.dupNote || e.message; } else r.state = 'ok';
      r.entryKey = e.key;
    });
  });
}

function finish(kind, rows, entries, inputCount, extra = {}) {
  const sum = (st) => entries.filter((e) => e.status === st);
  const slim = entries.map(({ _rows, _dup, idemKey, hash, ...e }) => e);
  return {
    kind,
    rows: rows.map(({ _dr, _cr, _nameHint, ...r }) => r),
    entries: slim,
    summary: {
      rows: inputCount, entries: entries.length, ready: sum('ready').length, duplicates: sum('duplicate').length, errors: sum('error').length,
      readyRows: rows.filter((r) => r.state === 'ok').length,
      totalDebit: entries.reduce((n, e) => n + e.debit, 0), totalCredit: entries.reduce((n, e) => n + e.credit, 0),
      ...extra,
    },
    _entries: entries,
  };
}

// ---- commit ---------------------------------------------------------------------------------------
async function commit(kind, rows, options, actor, { fileName = null, req = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new ImportError(400, 'There are no rows to import.');
  if (rows.length > MAX_ROWS) throw new ImportError(413, `More than ${MAX_ROWS} rows - split the file.`);
  const checked = kind === 'journal' ? await validateJournal(rows, options) : await validateLedger(rows, options);
  const batch = `import-${Date.now().toString(36)}`;
  const results = [];
  const noteTail = fileName ? ` [${String(fileName).slice(0, 60)}]` : '';
  for (const e of checked._entries) {
    const base = { entryNo: e.entryNo, date: e.date, amount: e.debit, lines: e.lines, rowLines: e.rowLines };
    if (e.status === 'duplicate') { results.push({ ...base, status: 'skipped', reason: e.message }); continue; }
    if (e.status === 'error') { results.push({ ...base, status: 'failed', reason: e.message || 'The entry has errors.' }); continue; }
    try {
      const payload = { debit: [], credit: [] };
      if (kind === 'journal') {
        e._rows.forEach((r) => {
          const memo = [r.note, r.reference ? `Ref ${r.reference}` : ''].filter(Boolean).join(' · ') || undefined;
          const line = { account: r.resolved.code, amount: (r._dr || r._cr) / 100, memo };
          (r._dr ? payload.debit : payload.credit).push(line);
        });
      } else {
        // new accounts are created only now, only for entries that are going to post
        for (const r of e._rows) {
          if (r.resolved && r.resolved.isNew) {
            // eslint-disable-next-line no-await-in-loop
            await ensureAccount({ code: r.resolved.code, name: r.resolved.name, type: r.resolved.type, description: 'Created by an opening-balance import' });
          }
        }
        e._rows.forEach((r) => {
          const line = { account: r.resolved.code, amount: (r._dr || r._cr) / 100, memo: r.reference ? `Ref ${r.reference}` : undefined };
          (r._dr ? payload.debit : payload.credit).push(line);
        });
        if (e.plug) {
          await ensureAccount({ ...OPENING_EQUITY });
          const line = { account: OPENING_EQUITY.code, amount: Math.abs(e.plug) / 100, memo: 'Difference of the imported opening balances' };
          (e.plug < 0 ? payload.debit : payload.credit).push(line);
        }
      }
      const [y, m] = e.date.split('-').map(Number);
      // eslint-disable-next-line no-await-in-loop
      const out = await postJournal({
        month: m, year: y, date: e.date,
        narration: (e.narration || (kind === 'journal' ? `Imported entry ${e.entryNo}` : `Opening balances as on ${e.date}`)).slice(0, 480),
        source: 'MANUAL',
        reference_type: kind === 'journal' ? 'JOURNAL_IMPORT' : 'OPENING_BALANCE',
        reference_id: batch,
        voucher_type: kind === 'journal' ? 'Journal' : 'Opening balance',
        entry_no: kind === 'journal' ? e.entryNo : undefined,
        imported_from: fileName || undefined,
        idempotency_key: e.idemKey,
        debit: payload.debit, credit: payload.credit,
      }, { actor });
      if (out.replay) { results.push({ ...base, status: 'skipped', reason: 'Already in the journal - skipped.' }); continue; }
      results.push({ ...base, status: 'imported', entryId: out.entry.id, reason: '' });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: actor.id, actorName: actor.name, action: kind === 'journal' ? 'Journal entry imported' : 'Opening balances imported', entity: 'JournalEntry',
        entityId: out.entry.id, toValue: `${e.entryNo} · ${out.entry.totalDebit.toFixed(2)}${noteTail}`,
      });
    } catch (err) {
      const reason = err instanceof LedgerError ? err.message : `Could not be saved (${err && err.message ? String(err.message).slice(0, 160) : 'unknown error'}). Nothing of this entry was booked.`;
      results.push({ ...base, status: 'failed', reason });
    }
  }
  const imported = results.filter((r) => r.status === 'imported');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');
  const rowsOf = (list) => list.reduce((n, r) => n + (r.lines || 0), 0);
  const summary = {
    entries: results.length, imported: imported.length, skipped: skipped.length, failed: failed.length,
    rowsImported: rowsOf(imported), rowsSkipped: rowsOf(skipped), rowsFailed: rowsOf(failed), rows: rows.length,
  };
  await logAudit({
    userId: actor.id, actorName: actor.name, action: kind === 'journal' ? 'Journal import' : 'Opening balances import', entity: 'JournalImport', entityId: batch,
    toValue: `${fileName || 'file'} · imported ${summary.imported}, skipped ${summary.skipped}, failed ${summary.failed} (${summary.rows} rows)`.slice(0, 480),
    reason: failed.slice(0, 5).map((f) => `${f.entryNo}: ${f.reason}`).join(' | ').slice(0, 900) || null,
  });
  if (req) {
    try {
      // eslint-disable-next-line global-require
      const { notifyDataIo } = require('./dataIoNotify');
      await notifyDataIo(req, {
        kind: 'import', module: kind === 'journal' ? 'Journal' : 'Ledger', count: rows.length, created: summary.imported, updated: 0, skipped: summary.skipped + summary.failed,
        what: kind === 'journal' ? 'journal entries' : 'opening balances', format: /\.csv$/i.test(fileName || '') ? 'csv' : 'xlsx', detail: `${fileName || 'file'} · ${summary.failed} failed`,
      });
    } catch { /* a notification never blocks an import */ }
  }
  return { batch, summary, results, ok: failed.length === 0 };
}

// What the browser gets for a preview / check.
function publicResult(out, extra = {}) {
  const { _entries, ...rest } = out;
  return { ...rest, ...extra };
}

async function validate(kind, rows, options) {
  if (!Array.isArray(rows)) throw new ImportError(400, 'rows are required');
  if (rows.length > MAX_ROWS) throw new ImportError(413, `More than ${MAX_ROWS} rows - split the file.`);
  return publicResult(kind === 'journal' ? await validateJournal(rows, options) : await validateLedger(rows, options));
}

module.exports = {
  ImportError, parseFile, validate, commit, sampleFile, sampleTable, parseDate, parseAmount, LAYOUT, FIELDS, OPENING_EQUITY, MAX_ROWS,
};

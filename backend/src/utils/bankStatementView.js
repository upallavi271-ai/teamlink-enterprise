// ---------------------------------------------------------------------------
// "VIEW STATEMENT" (Accounts prompt 2026-10-27): the ACTUAL bank statement a line came from, with that line highlighted
// and every other entry of the statement still visible. READ ONLY - nothing is written here.
//
// For a bank line it returns:
//   statement  which import it came from: bank account, file name, imported on / by, period, opening / closing balance
//   original   the uploaded file itself, read again from the server's copy (BankImport.originalFile, kept by Auto-Reconcile
//              since it was installed): every row of the sheet as the bank printed it, the line's own row highlighted (the
//              row number saved at import, checked against the amount). Absent when the file is not on this server.
//   imported   the rows of that SAME import as they are in the books, in the bank's own columns (BankTransaction.sourceRow),
//              in file order - "imported records, not the bank's own document" - with what each row is matched to.
// Nothing is invented: a line added by hand has no statement ("Bank Statement Not Available"), a missing file says so.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const prisma = require('../db');

const STORED = /^[a-f0-9]{32}\.(csv|xlsx|xls|txt|tsv|bin)$/;
const MAX_ROWS = 3000;
const MAX_COLS = 24;
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const paise = (n) => Math.round((Number(n) || 0) * 100);

function originalsDir() {
  const base = process.env.UPLOAD_DIR || pathMod.join(os.homedir() || os.tmpdir(), '.teamlink-uploads');
  return pathMod.resolve(pathMod.join(base, 'bank-statements'));
}

// a cell holding exactly this amount ("90,000.00", 90000, "₹ 90,000")
function cellIsAmount(c, p) {
  const s = String(c == null ? '' : c).replace(/[₹,\s]/g, '').replace(/(CR|DR)$/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return false;
  return Math.abs(paise(Math.abs(Number(s))) - p) <= 0;
}

// The uploaded file, read again. Returns null when it is not on this server or cannot be read.
function readOriginal(imp, txn) {
  if (!imp || !imp.originalFile || !STORED.test(imp.originalFile)) return null;
  const full = pathMod.resolve(originalsDir(), imp.originalFile);
  if (pathMod.dirname(full) !== originalsDir() || !fs.existsSync(full)) return null;
  let XLSX;
  try { XLSX = require('xlsx'); } catch { return null; } // eslint-disable-line global-require
  let wb;
  try { wb = XLSX.read(fs.readFileSync(full), { type: 'buffer', raw: true, cellDates: false, dense: true }); } catch { return null; }
  const p = paise(txn.amount);
  const sheets = wb.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true }) }));
  // the sheet whose row (the row number saved at import) holds this line's amount; else the one where exactly one row does
  let pick = null;
  let row = null;
  let verified = false;
  for (const s of sheets) {
    const r = txn.sourceLine ? s.rows[txn.sourceLine - 1] : null;
    if (Array.isArray(r) && r.some((c) => cellIsAmount(c, p))) { pick = s; row = txn.sourceLine; verified = true; break; }
  }
  if (!pick) {
    const refText = String(txn.externalId || txn.reference || '').trim();
    for (const s of sheets) {
      const hits = s.rows.map((r, i) => ({ r, i })).filter(({ r }) => Array.isArray(r) && r.some((c) => cellIsAmount(c, p)) && (!refText || r.some((c) => String(c).includes(refText))));
      if (hits.length === 1) { pick = s; row = hits[0].i + 1; verified = true; break; }
    }
  }
  if (!pick) pick = sheets.find((s) => s.rows.length) || null;
  if (!pick) return null;
  const width = Math.min(MAX_COLS, Math.max(0, ...pick.rows.map((r) => (Array.isArray(r) ? r.length : 0))));
  const rows = [];
  pick.rows.forEach((r, i) => {
    if (!Array.isArray(r) || !r.some((c) => String(c == null ? '' : c).trim() !== '')) return;
    if (rows.length < MAX_ROWS || i + 1 === row) rows.push({ n: i + 1, cells: Array.from({ length: width }, (_, k) => String(r[k] == null ? '' : r[k])) });
  });
  return {
    sheet: pick.name, sheets: sheets.length, rows, highlightRow: verified ? row : null, truncated: pick.rows.length > MAX_ROWS,
  };
}

async function importRecord(id) {
  if (!id) return null;
  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe('SELECT "id","bankAccountId","date","file","recordedBy","lines","skipped","fromDate","toDate","openingBalance","closingBalance","originalFile","originalName" FROM "BankImport" WHERE "id" = ?', id);
  } catch {
    // a database where Auto-Reconcile (originalFile) is not installed yet
    rows = await prisma.$queryRawUnsafe('SELECT "id","bankAccountId","date","file","recordedBy","lines","skipped","fromDate","toDate","openingBalance","closingBalance" FROM "BankImport" WHERE "id" = ?', id);
  }
  return rows[0] || null;
}

// txnState: routes/bank.js txnState (the state word the bank screen shows).
async function statementOf(txnId, { txnState }) {
  const txn = await prisma.bankTransaction.findUnique({ where: { id: txnId } });
  if (!txn) return { status: 404, error: 'Bank Statement Not Available - this bank line is no longer on file.' };
  const accounts = await prisma.bankAccount.findMany({ select: { id: true, bank: true, name: true, accNo: true }, orderBy: { createdAt: 'asc' } });
  const acc = accounts.find((a) => a.id === txn.bankAccountId) || (txn.bankAccountId ? null : accounts[0]) || null;
  const accountLabel = acc ? `${acc.bank}${acc.name ? ` · ${acc.name}` : ''}${acc.accNo ? ` · xxxx${String(acc.accNo).slice(-4)}` : ''}` : null;
  const line = {
    id: txn.id, date: txn.date, valueDate: txn.valueDate || null, narration: txn.description, reference: txn.reference || null, type: txn.type,
    amount: R2(txn.amount), balance: txn.balance, sourceLine: txn.sourceLine || null, state: txnState(txn),
  };
  if (!txn.importBatch) {
    return {
      available: false, reason: 'Bank Statement Not Available - this line was added by hand; no bank statement was imported for it.', line, account: accountLabel ? { id: acc.id, label: accountLabel } : null,
    };
  }
  const imp = await importRecord(txn.importBatch);
  const siblings = await prisma.bankTransaction.findMany({ where: { importBatch: txn.importBatch } });
  siblings.sort((a, b) => (Number(a.sourceLine) || 1e9) - (Number(b.sourceLine) || 1e9) || String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const pays = await prisma.invoicePayment.findMany({ where: { bankTxnId: { in: siblings.map((t) => t.id) } }, select: { bankTxnId: true, invoiceId: true, amount: true, invoice: { select: { invoiceNumber: true } } } });
  const parse = (s) => { try { const o = s ? JSON.parse(s) : null; return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  // the bank's own column names, in the order the file has them
  const columns = [];
  siblings.forEach((t) => { const o = parse(t.sourceRow); if (o) Object.keys(o).forEach((k) => { if (!columns.includes(k) && columns.length < MAX_COLS) columns.push(k); }); });
  const rows = siblings.slice(0, MAX_ROWS).map((t) => {
    const o = parse(t.sourceRow);
    const mine = pays.filter((p) => p.bankTxnId === t.id);
    return {
      txnId: t.id, rowNo: t.sourceLine || null, highlight: t.id === txn.id,
      cells: o ? columns.map((k) => (o[k] == null ? '' : String(o[k]))) : null,
      date: t.date, valueDate: t.valueDate || null, narration: t.description, reference: t.reference || null,
      debit: t.type === 'Debit' ? R2(t.amount) : null, credit: t.type === 'Credit' ? R2(t.amount) : null, balance: t.balance, state: txnState(t),
      invoices: mine.map((p) => ({ invoiceId: p.invoiceId, invoiceNumber: p.invoice ? p.invoice.invoiceNumber : null, amount: R2(p.amount) })),
    };
  });
  const original = readOriginal(imp, txn);
  return {
    available: true,
    line,
    statement: {
      importId: txn.importBatch,
      file: imp ? imp.file : null,
      importedOn: imp ? imp.date : null,
      importedBy: imp ? imp.recordedBy : null,
      from: imp ? imp.fromDate : null,
      to: imp ? imp.toDate : null,
      openingBalance: imp ? imp.openingBalance : null,
      closingBalance: imp ? imp.closingBalance : null,
      lines: siblings.length,
      skipped: imp ? Number(imp.skipped || 0) : 0,
      recordMissing: !imp,
      account: accountLabel ? { id: acc.id, label: accountLabel } : null,
    },
    original: {
      name: imp ? (imp.originalName || imp.file || null) : null,
      kept: !!(imp && imp.originalFile),
      onServer: !!original,
      download: imp && imp.originalFile && original ? `/bank/auto/imports/${encodeURIComponent(imp.id)}/original` : null,
      view: original,
    },
    imported: { columns, rows, truncated: siblings.length > MAX_ROWS },
  };
}

module.exports = { statementOf, readOriginal, originalsDir };

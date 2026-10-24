// ---------------------------------------------------------------------------
// BANK STATEMENT DUPLICATE DETECTION + SELECTIVE IMPORT (Accounts, 2026-10-19)
//
// One classifier, used by the preview AND by the import, so what the screen showed is what the import acts on.
//
//   Every uploaded transaction gets ONE status:
//     Already Imported             it is on file already (any earlier file, any earlier day)
//     Not Imported                 it is not on file: eligible for "Import New Transactions"
//     Duplicate in Current Upload  the same transaction appears more than once in THIS file (the repeats)
//     Needs Review                 part of the evidence agrees and part does not: a person decides
//   and, after an import, its result: Imported | Failed (with the reason) | Skipped.
//
//   THE RULES (amount alone or date alone NEVER decides anything)
//   Two lines on the SAME bank account are the same transaction when:
//     a) STRONG  both carry a real reference / UTR / cheque no. / bank transaction id and one is shared, and the
//                date, direction (credit / debit) and amount agree. The narration may be worded differently.
//     b) COMPOSITE  the date, direction, amount and the NORMALISED narration agree (case, spacing and punctuation
//                ignored), neither side's id contradicts the other, and the running balance does not contradict
//                (when both print one it must be equal).
//   They are DIFFERENT transactions when both carry ids and no id is shared, when both print a running balance
//   and the balances differ, or when the narration is unrelated (two payments of the same amount on the same day
//   to two different parties).
//   They are NEEDS REVIEW when only part agrees: same date + amount + direction and a similar narration, same
//   balance with different wording, a reference on one side only, or the same reference + amount on another date.
//   Never imported and never skipped by itself: the person chooses per row.
//
//   Inside one file, lines with the same identity are the same transaction written twice: the first stays, the
//   repeats are "Duplicate in Current Upload" and are skipped. A genuine same-day twin can still be saved with an
//   explicit "Import this one anyway", which is recorded.
//
//   DATABASE-LEVEL PROTECTION: every saved line owns rows in BankTxnKey, whose UNIQUE index
//   (bankAccountId, key, ordinal) is the final word. The line, its keys and the batch row are written in ONE
//   transaction per line; a second writer that gets there first makes the unique index refuse, the whole line is
//   rolled back and reported "already imported". Nothing here checks-then-inserts without that constraint.
//   Old lines (before this feature) get their keys written, non-destructively, the first time an import runs; a
//   twin among them simply takes ordinal 2, so no existing data is ever changed, merged or deleted.
//
// Tables (raw SQL, created on first use; the migration 20261019120000_bank_statement_dedupe holds the same
// statements and a rollback): BankStmtBatch, BankStmtRow, BankTxnKey (+ a trigger that drops a line's keys when
// the line is deleted, so a removed line can be imported again).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const BIC = require('./bankImportCore');

const STATUS = {
  AI: 'Already Imported',
  NI: 'Not Imported',
  DUP: 'Duplicate in Current Upload',
  NR: 'Needs Review',
  BAD: 'Unreadable',
};
const RESULT = { IMPORTED: 'Imported', FAILED: 'Failed', SKIPPED: 'Skipped' };

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID().replace(/-/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- schema -----------------------------------------------------------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS "BankStmtBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT,
    "file" TEXT,
    "sourceHash" TEXT,
    "sheet" TEXT,
    "source" TEXT,
    "uploadedById" TEXT,
    "uploadedByName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Preview',
    "importId" TEXT,
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "statedJson" TEXT,
    "balanceCheckJson" TEXT,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "lastRunAt" TEXT,
    "lastRunById" TEXT,
    "lastRunByName" TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS "BankStmtBatch_account" ON "BankStmtBatch"("bankAccountId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "BankStmtBatch_hash" ON "BankStmtBatch"("sourceHash")',
  `CREATE TABLE IF NOT EXISTS "BankStmtRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "line" INTEGER,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "matchTxnId" TEXT,
    "decision" TEXT,
    "result" TEXT,
    "error" TEXT,
    "txnId" TEXT,
    "dedupeKey" TEXT,
    "txnRef" TEXT,
    "date" TEXT,
    "type" TEXT,
    "paise" INTEGER,
    "narration" TEXT,
    "rowJson" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "importedAt" TEXT,
    "updatedAt" TEXT
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "BankStmtRow_batch_row" ON "BankStmtRow"("batchId", "rowNo")',
  'CREATE INDEX IF NOT EXISTS "BankStmtRow_batch_status" ON "BankStmtRow"("batchId", "status")',
  'CREATE INDEX IF NOT EXISTS "BankStmtRow_txn" ON "BankStmtRow"("txnId")',
  `CREATE TABLE IF NOT EXISTS "BankTxnKey" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "txnId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 1,
    "batchId" TEXT,
    "note" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "BankTxnKey_unique" ON "BankTxnKey"("bankAccountId", "key", "ordinal")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "BankTxnKey_txn_key" ON "BankTxnKey"("txnId", "key")',
  'CREATE INDEX IF NOT EXISTS "BankTxnKey_txn" ON "BankTxnKey"("txnId")',
  `CREATE TRIGGER IF NOT EXISTS "BankTxnKey_cleanup" AFTER DELETE ON "BankTransaction"
   BEGIN
     DELETE FROM "BankTxnKey" WHERE "txnId" = OLD."id";
   END`,
];

let ensured = null;
function ensureSchema() {
  if (!ensured) {
    ensured = (async () => {
      for (const sql of DDL) await run(sql);
      return true;
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

// ---- normalising ------------------------------------------------------------
// Case, accents, spacing and punctuation never make two lines different.
const normText = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const normId = (s) => BIC.strongRef(s);

// Words every bank narration is full of: they say nothing about WHO the money moved to or from.
const NOISE = new Set(('NEFT IMPS UPI RTGS PAYMENT PAYMENTS TRANSFER TRF TO FROM BY FOR THE OF AND A IN ON AT CR DR CREDIT DEBIT TXN '
  + 'TRANSACTION REF NO NUMBER ID MOB MOBILE BANK ATM CASH CHQ CHEQUE ACH ECS INB MB NET BANKING INTERNET ONLINE AMT AMOUNT').split(' '));
const sigTokens = (n) => n.split(' ').filter((t) => t && !NOISE.has(t) && !/^\d{1,3}$/.test(t));

// "similar enough that a person should look": shares a long id-like word, one contains the other, or most
// of the meaningful words are the same. Unrelated narrations are NOT similar.
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.length >= 8 && longer.includes(shorter)) return true;
  const A = new Set(sigTokens(a));
  const B = new Set(sigTokens(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) {
      inter += 1;
      if (t.length >= 8 && /\d/.test(t)) return true; // an embedded UTR / reference number
    }
  }
  return inter / (A.size + B.size - inter) >= 0.6;
}

// What identifies a line, whichever side it came from (an uploaded row or a BankTransaction row).
function profile(r) {
  const ids = [];
  [r.externalId, r.reference].forEach((v) => { const n = normId(v); if (n && !ids.includes(n)) ids.push(n); });
  const paise = r.paise != null ? r.paise : BIC.toPaise(r.amount);
  const bal = r.balance == null || r.balance === '' ? null : BIC.toPaise(r.balance);
  return {
    date: String(r.date || '').slice(0, 10),
    type: r.type,
    paise,
    narr: normText(r.description),
    ids,
    bal,
    base: `${String(r.date || '').slice(0, 10)}|${r.type}|${paise}`,
  };
}

// The keys a line owns in the database. A line with a real id is identified by it (S); a line without one by its
// composite (C). Every line is also tied to the file row it came from (F), so the same file row can never be saved twice.
function dbKeys(p, { sourceHash, line } = {}) {
  const keys = [];
  if (p.ids.length) p.ids.forEach((id) => keys.push({ kind: 'S', key: `S|${p.base}|${id}` }));
  else keys.push({ kind: 'C', key: `C|${p.base}|${p.narr}|${p.bal == null ? '' : p.bal}` });
  if (sourceHash && line != null) keys.push({ kind: 'F', key: `F|${sourceHash}|${line}` });
  return keys;
}

function relation(r, e) {
  if (r.ids.length && e.ids.length) return r.ids.some((i) => e.ids.includes(i)) ? 'same' : 'diff';
  const balBoth = r.bal != null && e.bal != null;
  if (balBoth && r.bal !== e.bal) return 'diff';
  const oneSideIds = (r.ids.length > 0) !== (e.ids.length > 0);
  if (r.narr === e.narr) {
    if (oneSideIds) return balBoth ? 'same' : 'review';
    return 'same';
  }
  if (balBoth) return 'review';
  return similar(r.narr, e.narr) ? 'review' : 'diff';
}

const day = (d) => String(d || '').slice(0, 10);
const money = (p) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// rows: validated rows in FILE order ({ line, date, type, amount|paise, description, reference, externalId, balance }).
// existing: BankTransaction rows already on the same account (id, date, type, amount, description, reference, externalId, balance, importFile).
// Returns one entry per row: { status, reason, matchTxnId, dedupeKey }.
function classifyRows(rows, existing) {
  const ex = existing.map((t) => ({ t, p: profile(t) }));
  const byBase = new Map();
  const byIdAmt = new Map();
  ex.forEach((e) => {
    if (!byBase.has(e.p.base)) byBase.set(e.p.base, []);
    byBase.get(e.p.base).push(e);
    e.p.ids.forEach((id) => {
      const k = `${e.p.type}|${e.p.paise}|${id}`;
      if (!byIdAmt.has(k)) byIdAmt.set(k, []);
      byIdAmt.get(k).push(e);
    });
  });
  const consumed = new Set();
  const seen = new Map(); // group key -> row number of the first line of the file
  const out = [];
  const fileOf = (t) => (t.importFile ? ` (file ${t.importFile})` : '');

  rows.forEach((row, i) => {
    const p = profile(row);
    const rowNo = i + 1;
    const groupKeys = p.ids.length ? p.ids.map((id) => `S|${p.base}|${id}`) : [`C|${p.base}|${p.narr}|${p.bal == null ? '' : p.bal}`];
    const dedupeKey = groupKeys[0];
    const cands = (byBase.get(p.base) || []).filter((e) => !consumed.has(e.t.id));
    const rel = cands.map((e) => ({ e, r: relation(p, e.p) }));
    const same = rel.filter((x) => x.r === 'same');
    let res;
    if (same.length) {
      // prefer the copy whose balance and narration agree, so identical twins pair off with the right one
      const score = (x) => (p.bal != null && x.e.p.bal === p.bal ? 2 : 0) + (x.e.p.narr === p.narr ? 1 : 0);
      same.sort((a, b) => score(b) - score(a));
      const hit = same[0].e;
      consumed.add(hit.t.id);
      const strong = p.ids.length && hit.p.ids.some((id) => p.ids.includes(id));
      res = {
        status: STATUS.AI,
        matchTxnId: hit.t.id,
        reason: strong
          ? `Already imported: same reference ${p.ids.find((id) => hit.p.ids.includes(id))}, date, amount and direction${fileOf(hit.t)}`
          : `Already imported: same date, amount, direction and narration${fileOf(hit.t)}`,
      };
    } else if (groupKeys.some((k) => seen.has(k))) {
      const first = seen.get(groupKeys.find((k) => seen.has(k)));
      res = { status: STATUS.DUP, matchTxnId: null, reason: `Same transaction as row ${first} of this upload (repeat)` };
    } else {
      let review = rel.filter((x) => x.r === 'review');
      // the same reference and amount, but on another date
      if (!review.length && p.ids.length) {
        const other = [];
        p.ids.forEach((id) => (byIdAmt.get(`${p.type}|${p.paise}|${id}`) || []).forEach((e) => {
          if (e.p.date !== p.date && !consumed.has(e.t.id)) other.push({ e, r: 'review', dateOnly: true });
        }));
        review = other;
      }
      if (review.length) {
        const hit = review[0].e;
        let why;
        if (review[0].dateOnly) why = `same reference and amount, but the date on file is ${day(hit.t.date)}`;
        else if ((p.ids.length > 0) !== (hit.p.ids.length > 0)) why = 'a reference number is missing on one side';
        else if (p.bal != null && hit.p.bal === p.bal) why = 'same balance, but the narration is worded differently';
        else why = 'the narration is similar but not the same';
        res = {
          status: STATUS.NR,
          matchTxnId: hit.t.id,
          reason: `May already be on file: ${why} - on file: "${String(hit.t.description || '').slice(0, 80)}"${fileOf(hit.t)}. Check it, then choose.`,
        };
      } else {
        res = { status: STATUS.NI, matchTxnId: null, reason: null };
      }
    }
    groupKeys.forEach((k) => { if (!seen.has(k)) seen.set(k, rowNo); });
    out.push({ ...res, dedupeKey });
  });
  return out;
}

// ---- existing lines ----------------------------------------------------------
const SELECT_EXISTING = { id: true, date: true, type: true, amount: true, description: true, reference: true, externalId: true, balance: true, importBatch: true, importFile: true, createdAt: true };

async function loadExisting(accountId, firstId) {
  const where = accountId === firstId ? { OR: [{ bankAccountId: accountId }, { bankAccountId: null }] } : { bankAccountId: accountId };
  return prisma.bankTransaction.findMany({ where, select: SELECT_EXISTING });
}

// Write the keys of old lines that have none. Non-destructive: only adds rows to BankTxnKey, never touches a transaction.
async function ensureKeys(accountId, firstId) {
  await ensureSchema();
  const orFirst = accountId === firstId ? ' OR t."bankAccountId" IS NULL' : '';
  const old = await q(
    `SELECT t."id", t."date", t."type", t."amount", t."description", t."reference", t."externalId", t."balance"
       FROM "BankTransaction" t
      WHERE (t."bankAccountId" = ?${orFirst})
        AND NOT EXISTS (SELECT 1 FROM "BankTxnKey" k WHERE k."txnId" = t."id")
      ORDER BY t."createdAt", t."id"`, accountId,
  );
  let added = 0;
  for (const t of old) {
    const keys = dbKeys(profile({ ...t, amount: Number(t.amount), balance: t.balance == null ? null : Number(t.balance) }));
    for (const k of keys) {
      for (let ord = 1; ord < 200; ord += 1) {
        const n = await run(
          'INSERT INTO "BankTxnKey" ("txnId","bankAccountId","kind","key","ordinal","batchId","note","createdAt") VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          t.id, accountId, k.kind, k.key, ord, null, 'legacy', nowIso(),
        );
        if (n === 1) { added += 1; break; }
      }
    }
  }
  return added;
}

// ---- batches -----------------------------------------------------------------
// A preview that was never imported is only a look at a file: it is cleared after a few days (the rows are re-created by choosing the file again).
const PREVIEW_KEEP_DAYS = 3;

async function purgeOldPreviews() {
  const cutoff = new Date(Date.now() - PREVIEW_KEEP_DAYS * 86400000).toISOString();
  const old = await q("SELECT \"id\" FROM \"BankStmtBatch\" WHERE \"status\" = 'Preview' AND \"createdAt\" < ?", cutoff);
  for (const b of old) {
    await run('DELETE FROM "BankStmtRow" WHERE "batchId" = ?', b.id);
    await run('DELETE FROM "BankStmtBatch" WHERE "id" = ? AND "status" = \'Preview\'', b.id);
  }
}

const ROW_COLS = ['id', 'batchId', 'rowNo', 'line', 'status', 'reason', 'matchTxnId', 'decision', 'result', 'error', 'txnId', 'dedupeKey', 'txnRef', 'date', 'type', 'paise', 'narration', 'rowJson', 'attempts', 'importedAt', 'updatedAt'];

async function insertRows(batchId, list) {
  const CH = 40;
  for (let i = 0; i < list.length; i += CH) {
    const part = list.slice(i, i + CH);
    const vals = part.map(() => `(${ROW_COLS.map(() => '?').join(',')})`).join(',');
    const args = [];
    part.forEach((r) => ROW_COLS.forEach((c) => args.push(r[c] === undefined ? null : r[c])));
    await run(`INSERT INTO "BankStmtRow" (${ROW_COLS.map((c) => `"${c}"`).join(',')}) VALUES ${vals}`, ...args);
  }
}

// ok: validated rows (BIC.validateRows().ok); unreadable: [{ line, reason, row }] rows that could not be read.
// Writes only the batch + its rows (status "Preview"); never a BankTransaction.
async function createBatch({
  accountId, firstId, file, sourceHash, sheet, source = 'upload', user = {}, ok, unreadable = [], stated = {}, balanceCheck = null,
}) {
  await ensureSchema();
  await purgeOldPreviews();
  const existing = await loadExisting(accountId, firstId);
  const ordered = [...ok].sort((a, b) => (a.line || 0) - (b.line || 0));
  const cls = classifyRows(ordered, existing);
  const id = `STM-${Date.now().toString(36)}-${uid().slice(0, 6)}`;
  const at = nowIso();
  const items = [
    ...ordered.map((r, i) => ({ line: r.line, kind: 'ok', r, c: cls[i] })),
    ...unreadable.map((f) => ({ line: f.line, kind: 'bad', f })),
  ].sort((a, b) => (a.line || 0) - (b.line || 0));
  const rows = items.map((it, i) => {
    const base = { id: uid(), batchId: id, rowNo: i + 1, line: it.line == null ? null : it.line, attempts: 0, updatedAt: at };
    if (it.kind === 'bad') {
      return {
        ...base, status: STATUS.BAD, reason: it.f.reason, result: RESULT.FAILED, error: it.f.reason, narration: '', rowJson: JSON.stringify({ unreadable: true, row: it.f.row || null }),
      };
    }
    const r = it.r;
    return {
      ...base,
      status: it.c.status,
      reason: it.c.reason,
      matchTxnId: it.c.matchTxnId,
      dedupeKey: it.c.dedupeKey,
      txnRef: r.externalId || r.reference || null,
      date: r.date,
      type: r.type,
      paise: r.paise,
      narration: String(r.description || '').slice(0, 500),
      rowJson: JSON.stringify(r),
    };
  });
  const eligible = rows.filter((r) => r.status === STATUS.NI).length;
  await run(
    `INSERT INTO "BankStmtBatch" ("id","bankAccountId","file","sourceHash","sheet","source","uploadedById","uploadedByName","status","eligible","statedJson","balanceCheckJson","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,'Preview',?,?,?,?,?)`,
    id, accountId, file, sourceHash || null, sheet || null, source, user.id || null, user.name || null, eligible, JSON.stringify(stated || {}), balanceCheck ? JSON.stringify(balanceCheck) : null, at, at,
  );
  await insertRows(id, rows);
  return { batchId: id, counts: await countsOf(id) };
}

async function getBatch(id) {
  await ensureSchema();
  const b = (await q('SELECT * FROM "BankStmtBatch" WHERE "id" = ?', id))[0];
  if (!b) return null;
  return { ...b, eligible: num(b.eligible), runs: num(b.runs) };
}

// The status strip: each uploaded transaction is in exactly one bucket.
async function countsOf(batchId) {
  const g = await q('SELECT "status", "result", "decision", COUNT(*) AS n FROM "BankStmtRow" WHERE "batchId" = ? GROUP BY "status", "result", "decision"', batchId);
  const b = (await q('SELECT "eligible" FROM "BankStmtBatch" WHERE "id" = ?', batchId))[0];
  const c = {
    total: 0, alreadyImported: 0, notImported: 0, duplicateInUpload: 0, needsReview: 0, newlyImported: 0, failed: 0, unreadable: 0, leftOut: 0,
    chosenImport: 0, retryable: 0, eligible: b ? num(b.eligible) : 0,
  };
  g.forEach((x) => {
    const n = num(x.n);
    c.total += n;
    if (x.result === RESULT.IMPORTED) { c.newlyImported += n; return; }
    if (x.result === RESULT.FAILED) {
      c.failed += n;
      if (x.status === STATUS.BAD) c.unreadable += n; else c.retryable += n;
      return;
    }
    if (x.result === RESULT.SKIPPED) { c.leftOut += n; return; }
    if (x.status === STATUS.AI) c.alreadyImported += n;
    else if (x.status === STATUS.DUP) { if (x.decision === 'import') c.chosenImport += n; c.duplicateInUpload += n; } else if (x.status === STATUS.NR) { if (x.decision === 'import') c.chosenImport += n; c.needsReview += n; } else if (x.status === STATUS.NI) {
      if (x.decision === 'skip') c.leftOut += n; else c.notImported += n;
    }
  });
  return c;
}

const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function viewRow(x, match) {
  const row = parseJson(x.rowJson, {});
  const display = x.result === RESULT.IMPORTED ? 'Imported'
    : x.result === RESULT.FAILED ? 'Failed'
      : x.result === RESULT.SKIPPED ? 'Left out'
        : (x.status === STATUS.NI && x.decision === 'skip' ? 'Left out' : x.status);
  return {
    rowNo: num(x.rowNo),
    line: x.line == null ? null : num(x.line),
    status: x.status,
    display,
    reason: x.status === STATUS.BAD ? x.error : x.reason,
    error: x.result === RESULT.FAILED ? x.error : null,
    result: x.result || null,
    decision: x.decision || null,
    date: x.date || row.date || null,
    type: x.type || row.type || null,
    amount: x.paise != null ? num(x.paise) / 100 : (row.amount != null ? row.amount : null),
    description: x.narration || row.description || '',
    reference: row.reference || null,
    externalId: row.externalId || null,
    balance: row.balance == null ? null : row.balance,
    txnId: x.txnId || null,
    match: match ? { id: match.id, date: match.date, description: match.description, file: match.importFile || null, createdAt: match.createdAt } : null,
    importedAt: x.importedAt || null,
  };
}

const FILTERS = {
  'Already Imported': { status: STATUS.AI },
  'Not Imported': { status: STATUS.NI, pending: true },
  'Duplicate in Current Upload': { status: STATUS.DUP, notDone: true },
  'Needs Review': { status: STATUS.NR, notDone: true },
  Imported: { result: RESULT.IMPORTED },
  Failed: { result: RESULT.FAILED },
  'Left out': { leftOut: true },
};

async function listRows(batchId, { filter = '', page = 1, limit = 50 } = {}) {
  await ensureSchema();
  const f = FILTERS[filter];
  const where = ['"batchId" = ?'];
  const args = [batchId];
  if (f) {
    if (f.result) { where.push('"result" = ?'); args.push(f.result); } else if (f.leftOut) where.push('("result" = \'Skipped\' OR ("status" = \'Not Imported\' AND "decision" = \'skip\' AND "result" IS NULL))');
    else {
      where.push('"status" = ?'); args.push(f.status);
      if (f.pending) where.push('"result" IS NULL AND ("decision" IS NULL OR "decision" <> \'skip\')');
      if (f.notDone) where.push('"result" IS NULL');
    }
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const total = num((await q(`SELECT COUNT(*) AS n FROM "BankStmtRow" WHERE ${where.join(' AND ')}`, ...args))[0].n);
  const pg = Math.max(Number(page) || 1, 1);
  const rows = await q(`SELECT * FROM "BankStmtRow" WHERE ${where.join(' AND ')} ORDER BY "rowNo" LIMIT ? OFFSET ?`, ...args, lim, (pg - 1) * lim);
  const ids = [...new Set(rows.map((r) => r.matchTxnId).filter(Boolean))];
  const matches = ids.length ? await prisma.bankTransaction.findMany({ where: { id: { in: ids } }, select: SELECT_EXISTING }) : [];
  const byId = new Map(matches.map((m) => [m.id, m]));
  return { total, page: pg, limit: lim, rows: rows.map((r) => viewRow(r, byId.get(r.matchTxnId))) };
}

// Re-read the batch against the CURRENT database (the account may have changed, or lines were added since the preview).
async function reclassify(batch, { accountId, firstId, force = false }) {
  const rows = await q('SELECT * FROM "BankStmtRow" WHERE "batchId" = ? ORDER BY "rowNo"', batch.id);
  const valid = rows.filter((r) => r.status !== STATUS.BAD);
  const importId = batch.importId;
  const own = new Set(valid.filter((r) => r.txnId).map((r) => r.txnId));
  let existing = await loadExisting(accountId, firstId);
  existing = existing.filter((t) => !own.has(t.id) && !(importId && t.importBatch === importId));
  const parsed = valid.map((r) => parseJson(r.rowJson, {}));
  const cls = classifyRows(parsed, existing);
  let changed = 0;
  for (let i = 0; i < valid.length; i += 1) {
    const r = valid[i];
    const c = cls[i];
    if (r.result && !(force && r.result === RESULT.SKIPPED)) continue;
    if (r.status === c.status && (r.reason || null) === (c.reason || null) && (r.matchTxnId || null) === (c.matchTxnId || null)) continue;
    const n = await run(
      'UPDATE "BankStmtRow" SET "status" = ?, "reason" = ?, "matchTxnId" = ?, "dedupeKey" = ?, "updatedAt" = ? WHERE "id" = ? AND "result" IS NULL',
      c.status, c.reason, c.matchTxnId, c.dedupeKey, nowIso(), r.id,
    );
    changed += n;
  }
  return changed;
}

// The account the batch is for can be changed until something has been imported.
async function recheck(batchId, { accountId, firstId }) {
  const batch = await getBatch(batchId);
  if (!batch) return { error: 'That upload is no longer available. Choose the file again.', status: 404 };
  const done = num((await q('SELECT COUNT(*) AS n FROM "BankStmtRow" WHERE "batchId" = ? AND "result" = \'Imported\'', batchId))[0].n);
  if (done && accountId !== (batch.bankAccountId || firstId)) return { error: 'Lines of this upload are already imported into another account.', status: 400 };
  if (accountId !== batch.bankAccountId) {
    await run('UPDATE "BankStmtBatch" SET "bankAccountId" = ?, "updatedAt" = ? WHERE "id" = ?', accountId, nowIso(), batchId);
    batch.bankAccountId = accountId;
  }
  await reclassify(batch, { accountId, firstId });
  if (!done) {
    const eligible = num((await q('SELECT COUNT(*) AS n FROM "BankStmtRow" WHERE "batchId" = ? AND "status" = ?', batchId, STATUS.NI))[0].n);
    await run('UPDATE "BankStmtBatch" SET "eligible" = ? WHERE "id" = ?', eligible, batchId);
  }
  return { counts: await countsOf(batchId) };
}

// decisions: [{ rowNo, decision: 'import' | 'skip' | null }]. Only a row that is waiting for a person can be given one.
async function setDecisions(batchId, decisions) {
  await ensureSchema();
  let set = 0;
  const refused = [];
  for (const d of decisions || []) {
    const rowNo = Number(d.rowNo);
    const dec = d.decision === 'import' || d.decision === 'skip' ? d.decision : null;
    const row = (await q('SELECT "status", "result" FROM "BankStmtRow" WHERE "batchId" = ? AND "rowNo" = ?', batchId, rowNo))[0];
    if (!row) { refused.push({ rowNo, reason: 'No such row' }); continue; }
    if (row.result) { refused.push({ rowNo, reason: 'This row is already finished' }); continue; }
    if (dec === 'import' && ![STATUS.NR, STATUS.DUP, STATUS.NI].includes(row.status)) { refused.push({ rowNo, reason: 'A transaction that is already imported is never imported again' }); continue; }
    if (row.status === STATUS.BAD) { refused.push({ rowNo, reason: 'This row could not be read' }); continue; }
    set += await run('UPDATE "BankStmtRow" SET "decision" = ?, "updatedAt" = ? WHERE "batchId" = ? AND "rowNo" = ? AND "result" IS NULL', dec, nowIso(), batchId, rowNo);
  }
  return { set, refused, counts: await countsOf(batchId) };
}

// ---- saving ------------------------------------------------------------------
const isUnique = (e) => /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|Unique constraint failed/i.test(`${e && e.message}${JSON.stringify((e && e.meta) || {})}`);
const isBusy = (e) => /database is locked|SQLITE_BUSY|timed out|Timed out|Transaction API error|socket timeout|P1008|P2034/i.test(`${e && e.message}${e && e.code}`);
function plainError(e) {
  const lines = String((e && e.message) || e || 'Unknown error').split('\n').map((l) => l.trim()).filter(Boolean);
  let msg = lines[lines.length - 1] || 'Unknown error';
  msg = msg.replace(/^(Raw query failed\.|Invalid `[^`]*` invocation:)\s*/i, '').replace(/Code: \d+\. Message: /i, '');
  // Prisma hides the database's own words behind a generic "constraint violated": say what it means in plain words
  if (/Foreign key constraint|constraint failed|constraint violated/i.test(msg)) msg = 'The database refused to save this line (a rule on the database stopped it)';
  else if (/database is locked|busy|timed out/i.test(msg)) msg = 'The database was busy and did not answer in time - retry';
  return msg.slice(0, 300);
}

async function saveOne({ rec, row, accountId, importId, anyway }) {
  const p = profile(row);
  const keys = dbKeys(p, { sourceHash: rec.sourceHash, line: row.line });
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const claimed = await tx.$executeRawUnsafe('UPDATE "BankStmtRow" SET "result" = \'Importing\', "updatedAt" = ? WHERE "id" = ? AND "result" IS NULL', nowIso(), rec.id);
        if (!claimed) return { state: 'busy' };
        // Looked at again INSIDE the write transaction, immediately before saving.
        for (const k of keys) {
          if (anyway && k.kind !== 'F') continue;
          const hit = await tx.$queryRawUnsafe('SELECT "txnId" FROM "BankTxnKey" WHERE "bankAccountId" = ? AND "key" = ? AND "ordinal" = 1', accountId, k.key);
          if (hit.length) {
            await tx.$executeRawUnsafe(
              'UPDATE "BankStmtRow" SET "result" = NULL, "status" = ?, "reason" = ?, "matchTxnId" = ?, "updatedAt" = ? WHERE "id" = ?',
              STATUS.AI, 'Already imported a moment ago (found just before saving)', hit[0].txnId, nowIso(), rec.id,
            );
            return { state: 'exists' };
          }
        }
        const created = await tx.bankTransaction.create({
          data: {
            date: row.date,
            valueDate: row.valueDate || null,
            description: row.description,
            type: row.type,
            amount: row.amount,
            reference: row.reference || null,
            externalId: row.externalId || null,
            balance: row.balance == null ? null : row.balance,
            importBatch: importId,
            importFile: rec.file,
            bankAccountId: accountId,
            sourceLine: row.line,
            sourceRow: JSON.stringify(row.raw || {
              date: row.date, valueDate: row.valueDate, description: row.description, reference: row.reference, externalId: row.externalId, type: row.type, amount: row.amount, balance: row.balance,
            }),
            reviewReason: null,
          },
        });
        for (const k of keys) {
          let ord = 1;
          if (anyway && k.kind !== 'F') {
            const m = await tx.$queryRawUnsafe('SELECT COALESCE(MAX("ordinal"), 0) AS m FROM "BankTxnKey" WHERE "bankAccountId" = ? AND "key" = ?', accountId, k.key);
            ord = num(m[0].m) + 1;
          }
          await tx.$executeRawUnsafe(
            'INSERT INTO "BankTxnKey" ("txnId","bankAccountId","kind","key","ordinal","batchId","note","createdAt") VALUES (?,?,?,?,?,?,?,?)',
            created.id, accountId, k.kind, k.key, ord, rec.batchId, anyway ? 'imported anyway (chosen by a person)' : null, nowIso(),
          );
        }
        await tx.$executeRawUnsafe(
          'UPDATE "BankStmtRow" SET "result" = \'Imported\', "txnId" = ?, "error" = NULL, "importedAt" = ?, "updatedAt" = ?, "attempts" = "attempts" + 1 WHERE "id" = ?',
          created.id, nowIso(), nowIso(), rec.id,
        );
        return { state: 'imported', txn: created };
      }, { timeout: 30000, maxWait: 30000 });
    } catch (e) {
      lastErr = e;
      const uniq = isUnique(e);
      // "import anyway" takes the next free ordinal; two writers can pick the same one, so the loser looks again
      if (uniq && anyway && attempt < 3) { await sleep(60 * (attempt + 1)); continue; }
      if (!uniq && isBusy(e) && attempt < 3) { await sleep(150 * (attempt + 1)); continue; }
      break;
    }
  }
  if (isUnique(lastErr)) {
    // someone else saved the same transaction first: the database refused ours and rolled it back
    await run(
      'UPDATE "BankStmtRow" SET "result" = NULL, "status" = ?, "reason" = ?, "updatedAt" = ? WHERE "id" = ? AND "result" IS NULL',
      STATUS.AI, 'Already imported a moment ago (the database refused a second copy)', nowIso(), rec.id,
    );
    return { state: 'exists' };
  }
  const reason = plainError(lastErr);
  await run('UPDATE "BankStmtRow" SET "result" = \'Failed\', "error" = ?, "attempts" = "attempts" + 1, "updatedAt" = ? WHERE "id" = ? AND "result" IS NULL', reason, nowIso(), rec.id);
  return { state: 'failed', error: reason };
}

// Save the importable rows of a batch.
//   mode 'new'    every "Not Imported" row, plus the rows a person chose to import
//   mode 'retry'  only the rows that failed on an earlier run
// Returns the lines created and what happened to the rest. The caller does the matching of the new lines.
async function runBatch(batchId, {
  mode = 'new', accountId, firstId, user = {},
}) {
  await ensureSchema();
  let batch = await getBatch(batchId);
  if (!batch) return { error: 'That upload is no longer available. Choose the file again.', status: 404 };
  if (batch.bankAccountId && accountId && batch.bankAccountId !== accountId) {
    const done = num((await q('SELECT COUNT(*) AS n FROM "BankStmtRow" WHERE "batchId" = ? AND "result" = \'Imported\'', batchId))[0].n);
    if (done) return { error: 'Lines of this upload are already imported into another account.', status: 400 };
  }
  accountId = accountId || batch.bankAccountId || firstId;
  if (accountId !== batch.bankAccountId) {
    await run('UPDATE "BankStmtBatch" SET "bankAccountId" = ? WHERE "id" = ?', accountId, batchId);
    batch.bankAccountId = accountId;
  }

  // One BankImport record per batch (the "Statements imported" history), created once even if runs overlap.
  if (!batch.importId) {
    let cand = `IMP-${Date.now()}`;
    while (await prisma.bankImport.findUnique({ where: { id: cand } })) cand += 'x';
    await run('UPDATE "BankStmtBatch" SET "importId" = ? WHERE "id" = ? AND "importId" IS NULL', cand, batchId);
    batch = await getBatch(batchId);
  }
  const importId = batch.importId;

  // A retry first puts the failed rows back in the queue.
  let retryIds = null;
  if (mode === 'retry') {
    const failed = await q('SELECT "id" FROM "BankStmtRow" WHERE "batchId" = ? AND "result" = \'Failed\' AND "status" <> ?', batchId, STATUS.BAD);
    retryIds = new Set(failed.map((r) => r.id));
    for (const r of failed) await run('UPDATE "BankStmtRow" SET "result" = NULL, "updatedAt" = ? WHERE "id" = ? AND "result" = \'Failed\'', nowIso(), r.id);
  }

  // Keys for old lines, then a fresh look at everything still waiting (the database may have changed since the preview).
  await ensureKeys(accountId, firstId);
  await reclassify(batch, { accountId, firstId });

  const rows = await q('SELECT * FROM "BankStmtRow" WHERE "batchId" = ? AND "result" IS NULL ORDER BY "rowNo"', batchId);
  const todo = rows.filter((r) => {
    if (retryIds) return retryIds.has(r.id) && (r.status === STATUS.NI || r.decision === 'import') && r.decision !== 'skip';
    if (r.decision === 'skip') return false;
    return r.status === STATUS.NI || (r.decision === 'import' && (r.status === STATUS.NR || r.status === STATUS.DUP));
  });

  if (todo.length && !(await prisma.bankImport.findUnique({ where: { id: importId } }))) {
    await prisma.bankImport.create({
      data: {
        id: importId, bankAccountId: accountId, date: BIC.istToday(), file: batch.file, recordedBy: user.name || null, lines: 0, skipped: 0, sourceHash: batch.sourceHash, status: 'Partial',
      },
    }).catch(async (e) => { if (!/Unique constraint/i.test(String(e.message))) throw e; });
  }

  const created = [];
  const failedNow = [];
  const existedNow = [];
  for (const rec of todo) {
    const row = parseJson(rec.rowJson, null);
    if (!row) {
      await run('UPDATE "BankStmtRow" SET "result" = \'Failed\', "error" = ?, "updatedAt" = ? WHERE "id" = ? AND "result" IS NULL', 'The saved copy of this row could not be read', nowIso(), rec.id);
      failedNow.push({ rowNo: num(rec.rowNo), line: rec.line, reason: 'The saved copy of this row could not be read' });
      continue;
    }
    const anyway = rec.decision === 'import' && (rec.status === STATUS.NR || rec.status === STATUS.DUP);
    const out = await saveOne({
      rec: { ...rec, file: batch.file, sourceHash: batch.sourceHash, batchId }, row, accountId, importId, anyway,
    });
    if (out.state === 'imported') created.push(out.txn);
    else if (out.state === 'failed') failedNow.push({ rowNo: num(rec.rowNo), line: rec.line, reason: out.error });
    else if (out.state === 'exists') existedNow.push(num(rec.rowNo));
  }

  // rows the person chose to leave out are finished as "Left out"
  await run(
    'UPDATE "BankStmtRow" SET "result" = \'Skipped\', "error" = ?, "updatedAt" = ? WHERE "batchId" = ? AND "result" IS NULL AND "decision" = \'skip\'',
    'You chose to leave this one out', nowIso(), batchId,
  );

  const counts = await countsOf(batchId);
  const saved = await q('SELECT "date", "type", "paise" FROM "BankStmtRow" WHERE "batchId" = ? AND "result" = \'Imported\'', batchId);
  const status = counts.newlyImported > 0 ? (counts.failed > 0 ? 'Partial' : 'Done') : (counts.retryable > 0 ? 'Failed' : 'Done');
  await run(
    'UPDATE "BankStmtBatch" SET "status" = ?, "runs" = "runs" + 1, "lastRunAt" = ?, "lastRunById" = ?, "lastRunByName" = ?, "updatedAt" = ? WHERE "id" = ?',
    status, nowIso(), user.id || null, user.name || null, nowIso(), batchId,
  );
  return {
    batch: await getBatch(batchId), importId, accountId, counts, created, failedNow, existedNow, saved, status,
  };
}

// Final numbers on the BankImport history row (called after the run).
async function finishHistory(batch, { counts, failedRows, balanceCheck, summary, saved }) {
  const credits = saved.filter((r) => r.type === 'Credit').reduce((s, r) => s + num(r.paise), 0) / 100;
  const debits = saved.filter((r) => r.type === 'Debit').reduce((s, r) => s + num(r.paise), 0) / 100;
  const dates = saved.map((r) => r.date).sort();
  const imp = await prisma.bankImport.findUnique({ where: { id: batch.importId } });
  if (!imp) return null;
  if (!counts.newlyImported) {
    await prisma.bankImport.delete({ where: { id: batch.importId } }).catch(() => {});
    return null;
  }
  return prisma.bankImport.update({
    where: { id: batch.importId },
    data: {
      lines: counts.newlyImported,
      skipped: counts.alreadyImported + counts.duplicateInUpload + counts.needsReview + counts.leftOut + counts.failed,
      credits: Math.round(credits * 100) / 100,
      debits: Math.round(debits * 100) / 100,
      fromDate: dates[0] || null,
      toDate: dates[dates.length - 1] || null,
      openingBalance: balanceCheck && balanceCheck.opening ? balanceCheck.opening.value : null,
      closingBalance: balanceCheck && balanceCheck.closing ? balanceCheck.closing.value : null,
      balanceCheck: balanceCheck ? JSON.stringify(balanceCheck) : null,
      failedRows: failedRows && failedRows.length ? JSON.stringify(failedRows.slice(0, 500)) : null,
      summary: JSON.stringify(summary),
      status: counts.newlyImported ? (counts.failed ? 'Partial' : 'Done') : 'Failed',
    },
  });
}

// Every failed / unreadable row of a batch with its reason.
async function failedRowsOf(batchId) {
  const rows = await q('SELECT "rowNo", "line", "status", "error" FROM "BankStmtRow" WHERE "batchId" = ? AND "result" = \'Failed\' ORDER BY "rowNo"', batchId);
  return rows.map((r) => ({ rowNo: num(r.rowNo), line: r.line == null ? null : num(r.line), reason: r.error || 'Could not be saved', unreadable: r.status === STATUS.BAD }));
}

// importId -> { uploadBatchId, counts } for the "Statements imported" history.
async function countsByImport(importIds) {
  const out = new Map();
  if (!importIds.length) return out;
  await ensureSchema();
  const list = await q(`SELECT "id","importId" FROM "BankStmtBatch" WHERE "importId" IN (${importIds.map(() => '?').join(',')})`, ...importIds);
  for (const b of list) out.set(b.importId, { uploadBatchId: b.id, counts: await countsOf(b.id) });
  return out;
}

async function recentBatches(accountId, limit = 20) {
  await ensureSchema();
  const list = await q('SELECT * FROM "BankStmtBatch" WHERE "status" <> \'Preview\' AND ("bankAccountId" = ? OR ? IS NULL) ORDER BY "createdAt" DESC LIMIT ?', accountId || null, accountId || null, limit);
  const out = [];
  for (const b of list) out.push({ ...b, runs: num(b.runs), eligible: num(b.eligible), counts: await countsOf(b.id) });
  return out;
}

module.exports = {
  STATUS, RESULT, FILTERS,
  ensureSchema, normText, similar, profile, dbKeys, relation, classifyRows, loadExisting, ensureKeys,
  createBatch, getBatch, countsOf, listRows, recheck, setDecisions, runBatch, finishHistory, failedRowsOf, recentBatches, countsByImport, isUnique, plainError,
};

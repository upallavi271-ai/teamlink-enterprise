// ---------------------------------------------------------------------------
// ACCOUNTS > JOURNAL & LEDGER > FIXED ASSETS  -  the "Import" button of the four
// sections (Pending from HRMS / Assets / Asset summary / Repair cost).
// Routes: routes/assetAccountsImport.js (mounted at /api/accounts/fixed-assets/import).
//
// WHAT THIS IS (and is not). HRMS owns the Asset and AssetRepair rows; the Accounts
// "register" is those same rows read together with the journal (utils/assetPosting.js).
// So there is NO second asset system and nothing is copied into a separate table:
//
//   source "hrms"  = bring the HRMS records into the BOOKS. It runs the EXISTING
//                    posting workflow (assetPosting.postItem - the same call as the
//                    "Post" button) for every record that is Not posted / Changed in
//                    HRMS. Whether a record is "already imported" is read from the
//                    journal (idempotency key per record), never from a flag we could
//                    set by mistake, so a source is "imported" only when the journal
//                    entry really exists. The original link stays: every journal line
//                    carries the HRMS asset id (and the entry key carries the repair id).
//   source "file"  = an Excel (.xlsx) or CSV file in the SAME contract as the other
//                    HRMS imports (utils/moduleIo.js: a sample file is the contract,
//                    header row must match). Assets -> new Asset rows; Repair cost ->
//                    new AssetRepair rows. Nothing is posted to the journal by a file
//                    import: the new records show in "Pending from HRMS" where Accounts
//                    posts them (the approval workflow is not bypassed).
//
// Every run is: PREVIEW (reads only, writes nothing) -> CONFIRM (re-checks everything
// on the server, writes, answers with the real counts). Confirm takes an idempotency
// key (a double click / a retry gets the first answer back) and runs one at a time.
// Re-running the same import adds nothing: records are matched by their reliable ids
// (asset code, serial number, repair number, invoice number, the journal key) - never
// by display name.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { canonicalCategory } = require('./assetCategory');
const path = require('path');
const prisma = require('../db');
const io = require('./moduleIo');
const A = require('./assetPosting');
const { closedUpTo, monthOfDate } = require('./ledger');
const { logAudit } = require('./audit');
const { withoutSystemAccounts } = require('./systemAccounts');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILE_ROWS = 2000;
const MAX_LIST = 1500; // rows sent back to the screen
const KIND_LABEL = { purchase: 'Purchase', repair: 'Repair', disposal: 'Sale / write-off' };
const KIND_ORDER = { purchase: 0, repair: 1, disposal: 2 };
const STATUSES = ['Available', 'Assigned', 'In Repair', 'Retired'];
const REPAIR_TYPES = ['Repair', 'Service', 'AMC', 'Replacement of part'];
const REPAIR_STATUSES = ['Reported', 'In Repair', 'Completed', 'Cancelled'];
const PAID_VIA = ['Bank', 'Cash', 'Payable'];
const DEFAULT_CATEGORIES = ['Laptop', 'Monitor', 'Mobile Phone', 'Headset', 'Mouse', 'Keyboard', 'Furniture', 'Other'];

const SECTIONS = {
  pending: { label: 'Pending from HRMS', kinds: ['purchase', 'repair', 'disposal'], sources: ['hrms'] },
  assets: { label: 'Assets', kinds: ['purchase'], sources: ['hrms', 'file'], fileKind: 'assets' },
  summary: { label: 'Asset summary', kinds: ['purchase', 'repair', 'disposal'], sources: ['hrms'] },
  repairs: { label: 'Repair cost', kinds: ['repair'], sources: ['hrms', 'file'], fileKind: 'repairs' },
};

class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- small helpers -------------------------------------------------------------------
const r2 = A.r2;
const str = io.str;
const today = () => new Date().toISOString().slice(0, 10);
function realDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const twoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
const looksLikeFormula = (v) => /^[=@]/.test(str(v)) || /^[+-]\s*[A-Za-z(]/.test(str(v));
const FORMULA_FIX = 'Remove the leading = or @ (a cell that starts like that is treated as a formula and is never accepted).';
const problem = (field, message, fix, extra = {}) => ({ field, message, fix: fix || '', ...extra });
const safeName = (n) => path.basename(String(n || 'upload')).replace(/[^\w .()-]/g, '_').slice(0, 120);
const tidy = (err) => String((err && err.message) || err || 'Unknown problem').split('\n').filter(Boolean).pop().slice(0, 220);

// ---- ONE IMPORT AT A TIME (the writes check-then-insert) --------------------------------
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---- IDEMPOTENCY KEY (double click / retry) ----------------------------------------------
const IDEM_PREFIX = 'idem.fa-import.';
const KEEP_MS = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function claim(key, user) {
  try {
    await prisma.appSetting.create({ data: { key, value: JSON.stringify({ state: 'pending', at: Date.now() }), updatedById: user.id, updatedByName: user.name || null } });
    return true;
  } catch (err) {
    if (err && err.code === 'P2002') return false;
    throw err;
  }
}
// work() -> { status, body }. The first call with a key does the work; the same key again
// (a double click, a retry after a lost answer) gets the SAME answer, flagged duplicateRequest.
async function idempotently(user, rawKey, work) {
  const raw = String(rawKey || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(raw)) throw new ImportError(400, 'This import cannot be sent safely. Close the window, open Import again and press Preview, then Confirm.');
  const key = `${IDEM_PREFIX}${user.id}.${raw}`;
  let mine = await claim(key, user);
  if (!mine) {
    const until = Date.now() + 25000;
    while (Date.now() < until && !mine) {
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.appSetting.findUnique({ where: { key } });
      if (!row) {
        // eslint-disable-next-line no-await-in-loop
        mine = await claim(key, user);
      } else {
        let v = null;
        try { v = JSON.parse(row.value); } catch { v = null; }
        if (v && v.state === 'done') return { status: v.status || 200, body: { ...(v.body || {}), duplicateRequest: true } };
        // eslint-disable-next-line no-await-in-loop
        await sleep(250);
      }
    }
    if (!mine) throw new ImportError(409, 'This import is still running. Wait a moment, then look at the table - it is saved only once.');
  }
  try {
    const out = await work();
    await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify({ state: 'done', status: out.status, body: out.body }) } }).catch(() => {});
    prisma.appSetting.deleteMany({ where: { key: { startsWith: IDEM_PREFIX }, updatedAt: { lt: new Date(Date.now() - KEEP_MS) } } }).catch(() => {});
    return out;
  } catch (err) {
    await prisma.appSetting.delete({ where: { key } }).catch(() => {}); // a failed run lets go of its key
    throw err;
  }
}

// ---- BEFORE / AFTER FIGURES (recomputed from the saved records) ---------------------------
async function figures() {
  const assets = await prisma.asset.findMany({ select: { id: true } });
  const f = await A.bookFigures(assets.map((a) => a.id));
  let gross = 0; let accDep = 0; let inBooks = 0;
  f.forEach((x) => { gross += x.gross; accDep += x.accDep; if (x.gross > 0) inBooks += 1; });
  const rep = await prisma.journalLine.findMany({ where: { referenceType: 'ASSET_REPAIR' }, select: { accountCode: true, debit: true, credit: true } });
  const repairBooked = rep.filter((l) => /^(54|15)/.test(l.accountCode)).reduce((n, l) => n + l.debit - l.credit, 0);
  return {
    assets: assets.length, assetsInBooks: inBooks, costInBooks: r2(gross), accumulatedDepreciation: r2(accDep), bookValue: r2(gross - accDep), repairBooked: r2(repairBooked),
  };
}

// ===========================================================================================
//  SOURCE "hrms"  -  the pending records of HRMS, through the existing posting workflow
// ===========================================================================================
const HRMS_COLUMNS = [
  { key: 'ref', label: 'Source ID' }, { key: 'what', label: 'What' }, { key: 'name', label: 'Asset' }, { key: 'category', label: 'Category' },
  { key: 'date', label: 'Date' }, { key: 'cost', label: 'Amount', num: true }, { key: 'holder', label: 'Assigned to' }, { key: 'department', label: 'Department' },
  { key: 'sourceStatus', label: 'HRMS status' },
];

function holdsAmount(n) { return n == null || (Number.isFinite(Number(n)) && Number(n) >= 0); }

// Reads only: inside A.dryRun the ledger helpers never create a ledger (so a Preview saves nothing).
const hrmsRows = (section) => A.dryRun(() => hrmsRowsRaw(section));
async function hrmsRowsRaw(section) {
  const cfg = SECTIONS[section];
  const assets = await prisma.asset.findMany({ include: { assignedTo: { select: { id: true, name: true, employeeCode: true, department: true } } } });
  const aById = new Map(assets.map((a) => [a.id, a]));
  const full = await A.pendingList({ includePosted: true });
  const list = full.filter((r) => cfg.kinds.includes(r.kind));
  const repairs = await A.loadRepairs(assets);
  const repById = new Map(repairs.map((r) => [r.id, r]));
  const closed = await closedUpTo();
  const purchaseOf = new Map(full.filter((r) => r.kind === 'purchase').map((r) => [r.assetId, r]));
  const out = [];
  const eligiblePurchase = new Set(); // assets whose purchase WILL be imported earlier in this run

  const closedProblem = (date) => (closed && date && monthOfDate(date) <= closed
    ? problem('Date', `${date} is in a closed month (books closed up to ${closed}).`, 'Open that month in Journal & Ledger > Payroll Mapping > Books closed up to, or post this one from the table with "Yes, post it".') : null);

  function base(r, a) {
    const h = a && a.assignedTo;
    return {
      key: `${r.kind}:${r.id}`, kind: r.kind, recordId: r.id, assetId: r.assetId,
      cells: {
        ref: r.ref || r.assetCode, what: KIND_LABEL[r.kind], name: r.assetName, category: r.category, date: r.date || '', cost: r.amount,
        holder: r.holder || '', department: (h && h.department) || '', sourceStatus: r.assetStatus || '',
      },
      problems: [], notes: [], action: 'create', existing: null,
    };
  }
  function commonProblems(row, a) {
    if (!str(a.name)) row.problems.push(problem('Asset name', 'The asset has no name in HRMS.', 'Open the asset in HRMS and type its name.'));
    if (!str(a.category)) row.problems.push(problem('Category', 'The asset has no category in HRMS.', 'Open the asset in HRMS and pick a category.'));
    if (a.assignedToId && !a.assignedTo) row.problems.push(problem('Assigned to', 'The employee this asset is assigned to no longer exists.', 'Open the asset in HRMS and assign it to a current employee, or hand it back.'));
  }
  function stateOnly(row, r) {
    if (r.state === 'Posted') { row.action = 'duplicate'; row.existing = { label: `Journal entry ${r.journalEntryId || ''}`.trim(), id: r.journalEntryId || null }; row.reason = 'Already in the books - the journal entry exists and matches HRMS. Nothing new to add.'; return true; }
    if (r.state === 'Covered by warranty') { row.action = 'skip'; row.reason = 'Covered by warranty - there is no cost, so nothing is posted.'; return true; }
    return false;
  }

  // 1) purchases first (repairs / disposals depend on them)
  for (const r of list.filter((x) => x.kind === 'purchase')) {
    const a = aById.get(r.assetId);
    const row = base(r, a);
    if (!a) { row.problems.push(problem('Asset', 'The asset is no longer in HRMS.', 'Nothing to import - it was deleted in HRMS.')); } else if (!stateOnly(row, r)) {
      commonProblems(row, a);
      if (!(Number(a.purchaseCost) >= 0)) row.problems.push(problem('Purchase cost', 'The purchase cost is not a valid amount.', 'Type the cost (0 or more) in HRMS.'));
      else if (!twoDecimals(Number(a.purchaseCost)) || !twoDecimals(Number(a.gstPaid) || 0)) row.problems.push(problem('Purchase cost', 'The amount has more than 2 decimals.', 'Round the cost and GST to paise in HRMS.'));
      if (!holdsAmount(a.gstPaid)) row.problems.push(problem('GST paid', 'GST is negative.', 'Type the GST (0 or more) in HRMS.'));
      if (!realDate(a.purchaseDate)) row.problems.push(problem('Purchase date', a.purchaseDate ? `"${a.purchaseDate}" is not a real date.` : 'The purchase date is empty.', 'Type the purchase date (YYYY-MM-DD) in HRMS.'));
      else { const c = closedProblem(a.purchaseDate); if (c) row.problems.push(c); }
      if (a.status === 'Assigned' && !a.assignedToId) row.notes.push('Status is Assigned but no employee is recorded in HRMS.');
      if (r.state === 'Changed in HRMS') row.action = 'update';
      if (!row.problems.length) eligiblePurchase.add(r.assetId);
    }
    if (row.problems.length) row.action = 'error';
    out.push(row);
  }
  // an asset with a NEGATIVE cost is never in the pending list (no posting is possible): show it so it is not silently ignored
  if (cfg.kinds.includes('purchase')) {
    assets.filter((a) => Number(a.purchaseCost) < 0).forEach((a) => {
      const row = base({ kind: 'purchase', id: a.id, assetId: a.id, ref: a.assetCode, assetCode: a.assetCode, assetName: a.name, category: a.category, holder: a.assignedTo ? a.assignedTo.name : '', assetStatus: a.status, date: a.purchaseDate, amount: a.purchaseCost }, a);
      row.problems.push(problem('Purchase cost', `The purchase cost is negative (${a.purchaseCost}).`, 'Correct the cost in HRMS (it must be 0 or more).'));
      row.action = 'error';
      out.push(row);
    });
  }
  const purchaseCovered = (assetId) => {
    const p = purchaseOf.get(assetId);
    return !!p && (p.state === 'Posted' || eligiblePurchase.has(assetId));
  };
  // 2) repairs
  for (const r of list.filter((x) => x.kind === 'repair')) {
    const a = aById.get(r.assetId);
    const rep = repById.get(r.id);
    const row = base(r, a);
    if (!a || !rep) { row.problems.push(problem('Repair', 'The repair or its asset is no longer in HRMS.', 'Nothing to import - it was removed in HRMS.')); } else if (!stateOnly(row, r)) {
      commonProblems(row, a);
      if (!(Number(rep.cost) >= 0) || !holdsAmount(rep.gstPaid)) row.problems.push(problem('Amount', 'The repair amount or GST is not a valid amount.', 'Type the amounts (0 or more) on the repair in HRMS.'));
      else if (!twoDecimals(Number(rep.cost)) || !twoDecimals(Number(rep.gstPaid) || 0)) row.problems.push(problem('Amount', 'The amount has more than 2 decimals.', 'Round the amounts to paise in HRMS.'));
      const d = realDate(rep.repairDate) ? rep.repairDate : (realDate(rep.dateReported) ? rep.dateReported : null);
      if (!d) row.problems.push(problem('Date', 'The repair has no valid date.', 'Type the repair date (YYYY-MM-DD) on the repair in HRMS.'));
      else { const c = closedProblem(d); if (c) row.problems.push(c); }
      const p = purchaseOf.get(r.assetId);
      if (p && !purchaseCovered(r.assetId)) {
        row.problems.push(problem('Asset', `Asset ${a.assetCode} is not in the books yet (its purchase is ${p.state === 'Posted' ? 'posted' : 'not imported'}).`, 'Import the asset first (Assets > Import), then import this repair.', { dependency: true }));
      } else if (p && p.state !== 'Posted') row.notes.push('The asset purchase is imported first, in the same run.');
      if (rep.capitalise) row.notes.push('Marked "capitalise" in HRMS - it is added to the asset cost exactly as HRMS says.');
      if (r.state === 'Changed in HRMS') row.action = 'update';
    }
    if (row.problems.length) row.action = 'error';
    out.push(row);
  }
  // 3) sale / write-off
  for (const r of list.filter((x) => x.kind === 'disposal')) {
    const a = aById.get(r.assetId);
    const row = base(r, a);
    if (!a) row.problems.push(problem('Asset', 'The asset is no longer in HRMS.', 'Nothing to import.'));
    else if (!stateOnly(row, r)) {
      commonProblems(row, a);
      if (r.state === 'Blocked' && !eligiblePurchase.has(r.assetId)) row.problems.push(problem('Asset', r.reason || 'The asset is not in the books.', 'Import the asset first (Assets > Import), then import the sale / write-off.', { dependency: true }));
      else if (r.state === 'Blocked') row.notes.push('The asset purchase is imported first, in the same run.');
      if (!realDate(a.disposalDate)) row.problems.push(problem('Date', a.disposalDate ? `"${a.disposalDate}" is not a real date.` : 'The sale / write-off date is empty.', 'Type the date (YYYY-MM-DD) in HRMS.'));
      else { const c = closedProblem(a.disposalDate); if (c) row.problems.push(c); }
      if (!holdsAmount(a.disposalAmount)) row.problems.push(problem('Amount', 'The sale amount is negative.', 'Type the sale amount (0 or more) in HRMS.'));
      if (r.state === 'Changed in HRMS') row.action = 'update';
    }
    if (row.problems.length) row.action = 'error';
    out.push(row);
  }
  out.sort((x, y) => (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || String(x.cells.ref).localeCompare(String(y.cells.ref)));
  const noCost = cfg.kinds.includes('purchase') ? assets.filter((a) => !(Number(a.purchaseCost) > 0) && !(Number(a.purchaseCost) < 0)).length : 0;
  return { rows: out, noCost };
}

function countsOf(rows) {
  const c = {
    total: rows.length, willImport: 0, willUpdate: 0, duplicates: 0, skipped: 0, errors: 0,
  };
  rows.forEach((r) => {
    if (r.action === 'create') c.willImport += 1;
    else if (r.action === 'update') c.willUpdate += 1;
    else if (r.action === 'duplicate') c.duplicates += 1;
    else if (r.action === 'skip') c.skipped += 1;
    else if (r.action === 'error') c.errors += 1;
  });
  return c;
}

function byCategory(rows) {
  const m = new Map();
  rows.filter((r) => ['create', 'update'].includes(r.action)).forEach((r) => {
    const k = r.cells.category || '(none)';
    const x = m.get(k) || { category: k, rows: 0, amount: 0 };
    x.rows += 1; x.amount = r2(x.amount + (Number(r.cells.cost) || 0));
    m.set(k, x);
  });
  return [...m.values()].sort((a, b) => a.category.localeCompare(b.category));
}

async function previewHrms(section) {
  const { rows, noCost } = await hrmsRows(section);
  const counts = countsOf(rows);
  return {
    section, source: 'hrms', columns: HRMS_COLUMNS, counts, byCategory: byCategory(rows),
    info: { noCost, shownRows: Math.min(rows.length, MAX_LIST) },
    rows: rows.slice(0, MAX_LIST).map((r) => ({
      key: r.key, line: null, action: r.action, cells: r.cells, problems: r.problems, notes: r.notes, reason: r.reason || '', existing: r.existing,
    })),
  };
}

async function confirmHrms(section, user, selected) {
  const before = await figures();
  const { rows } = await hrmsRows(section);
  const actor = { id: user.id, name: user.name || user.email };
  const pickKeys = selected && selected.size ? selected : null;
  const considered = pickKeys ? rows.filter((r) => pickKeys.has(r.key)) : rows;
  const res = {
    total: considered.length, imported: 0, updated: 0, skipped: 0, duplicates: 0, failed: 0, failures: [], duplicateList: [], skippedList: [], created: [],
  };
  const ref = (r) => `${r.cells.ref} (${r.cells.what.toLowerCase()})`;
  if (pickKeys) {
    const have = new Set(rows.map((r) => r.key));
    pickKeys.forEach((k) => {
      if (!have.has(k)) {
        res.total += 1; res.failed += 1;
        res.failures.push({ ref: k, name: '', reason: 'This record is no longer in the list - it was changed or removed in HRMS after the preview.', fix: 'Open Import again and preview the current list.' });
      }
    });
  }
  const failedAssets = new Map(); // assetId -> why its purchase did not go in
  const todo = [];
  considered.forEach((r) => {
    if (r.action === 'duplicate') { res.duplicates += 1; res.duplicateList.push({ ref: ref(r), name: r.cells.name, existing: r.existing ? r.existing.label : '', reason: r.reason }); } else if (r.action === 'skip') { res.skipped += 1; res.skippedList.push({ ref: ref(r), name: r.cells.name, reason: r.reason }); } else if (r.action === 'error') {
      res.failed += 1;
      const p = r.problems[0] || {};
      res.failures.push({ ref: ref(r), name: r.cells.name, reason: r.problems.map((x) => x.message).join(' '), fix: p.fix || '', dependency: r.problems.some((x) => x.dependency) });
      if (r.kind === 'purchase') failedAssets.set(r.assetId, 'its purchase has a problem');
    } else todo.push(r);
  });
  todo.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
  for (const r of todo) {
    if (r.kind !== 'purchase' && failedAssets.has(r.assetId)) {
      res.failed += 1;
      res.failures.push({ ref: ref(r), name: r.cells.name, reason: `The asset purchase was not imported (${failedAssets.get(r.assetId)}), so this record cannot go in.`, fix: 'Fix the asset purchase first, then import again.', dependency: true });
      continue; // eslint-disable-line no-continue
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await A.postItem({ kind: r.kind, id: r.recordId }, actor, { confirmClosed: false });
      if (out.status === 'posted') res.imported += 1;
      else if (out.status === 'updated') res.updated += 1;
      else { res.duplicates += 1; res.duplicateList.push({ ref: ref(r), name: r.cells.name, existing: out.entry ? `Journal entry ${out.entry.id}` : '', reason: 'Already in the books and the same as HRMS. Nothing new was added.' }); }
    } catch (err) {
      res.failed += 1;
      const known = err && err.status && err.message;
      res.failures.push({
        ref: ref(r),
        name: r.cells.name,
        reason: known ? err.message : `The database could not save this record (${tidy(err)}). Nothing was saved for it.`,
        fix: known ? (err.status === 409 ? 'Open the closed month, or post it from the table and confirm the closed-month question.' : 'Correct it in HRMS, then import again.') : 'Try again in a moment. Nothing was saved for this record.',
        dependency: false,
      });
      if (r.kind === 'purchase') failedAssets.set(r.assetId, tidy(err));
    }
  }
  const after = await figures();
  return { ...res, figures: { before, after } };
}

// ===========================================================================================
//  SOURCE "file"  -  Excel / CSV in the HRMS import contract (a sample file + exact headers)
// ===========================================================================================
const ASSET_SPEC = {
  key: 'fixed-assets', label: 'Fixed assets', module: 'Accounts - Fixed Assets', what: 'fixed assets', sheet: 'Assets', entity: 'Asset',
  columns: [
    { key: 'assetCode', label: 'Asset ID', required: true, example: 'AST-0901', note: 'Your own unique ID for the asset. It is how the file is matched when you load it again, so the same file never adds a second copy.' },
    { key: 'name', label: 'Asset Name', required: true, example: 'Dell Latitude 5440' },
    { key: 'category', label: 'Category', required: true, example: 'Laptop', note: 'The categories in use are on the Lists sheet. A new name is allowed; its ledgers are made when the purchase is posted.' },
    { key: 'assetType', label: 'Asset Type', example: 'Latitude 5440 i5 16GB', note: 'The finer type or model (there is no separate description field).' },
    { key: 'purchaseDate', label: 'Purchase Date', required: true, type: 'date', example: '2026-01-15', note: 'Not in the future.' },
    { key: 'purchaseCost', label: 'Purchase Cost', required: true, type: 'number', example: '65000', note: 'Rupees, before GST, 0 or more, at most 2 decimals.' },
    { key: 'gstPaid', label: 'GST Paid', type: 'number', example: '11700', note: 'Rupees, 0 or more.' },
    { key: 'paidVia', label: 'Paid Via', list: 'Paid via', example: 'Bank', note: 'Blank = Bank (as for the assets already on file).' },
    { key: 'vendor', label: 'Vendor', example: 'ABC Computers' },
    { key: 'invoiceNo', label: 'Invoice No', example: 'INV-1021' },
    { key: 'serialNumber', label: 'Serial Number', example: 'SN-9F3K21', note: 'If given it must be unique across all assets.' },
    { key: 'holder', label: 'Assigned To (Employee ID)', example: 'TL101', note: 'Employee ID (or email) of the holder. Blank = not assigned.' },
    { key: 'location', label: 'Location', example: 'Hyderabad office' },
    { key: 'usefulLifeYears', label: 'Useful Life (Years)', type: 'number', example: '3', note: 'More than 0. Blank = the default for the category.' },
    { key: 'depreciationMethod', label: 'Depreciation Method', list: 'Depreciation method', example: 'SL', note: 'SL (straight line) or WDV (written down value). Blank = SL.' },
    { key: 'salvageValue', label: 'Residual Value', type: 'number', example: '5000', note: 'What it is worth at the end of its life. 0 or more and not above the cost.' },
    { key: 'status', label: 'Status', list: 'Status', example: 'Available', note: 'Blank = Assigned when an employee is given, otherwise Available.' },
    { key: 'warrantyUntil', label: 'Warranty Until', type: 'date', example: '2029-01-14' },
  ],
  instructions: [
    'One row = one asset. Asset ID is needed on every row so loading the same file again changes nothing.',
    'An Asset ID or Serial Number that already exists is NOT changed: the row is listed as a duplicate with the existing asset. Edit existing assets in HRMS.',
    'This import adds the asset to the register only. Its purchase is posted to the journal from "Pending from HRMS".',
    'Formulas, macros and anything else that is not plain data are never run or accepted.',
  ],
  lists: async () => {
    const rows = await prisma.asset.findMany({ select: { category: true }, distinct: ['category'] });
    return {
      Status: STATUSES, 'Paid via': PAID_VIA, 'Depreciation method': ['SL', 'WDV'],
      'Categories in use': [...new Set([...rows.map((r) => r.category).filter(Boolean), ...DEFAULT_CATEGORIES])].sort(),
    };
  },
};

const REPAIR_SPEC = {
  key: 'fixed-asset-repairs', label: 'Repair costs', module: 'Accounts - Fixed Assets', what: 'repair costs', sheet: 'Repairs', entity: 'AssetRepair',
  columns: [
    { key: 'repairNo', label: 'Repair Record ID', example: '', note: 'Leave blank for a new repair (the system numbers it RP-00001...). A number that already exists is treated as a duplicate.' },
    { key: 'assetCode', label: 'Asset ID', required: true, example: 'AST-0101', note: 'The asset must already be in the register (Assets > Import first).' },
    { key: 'assetName', label: 'Asset Name', readOnly: true, example: 'Dell Latitude 5440' },
    { key: 'dateReported', label: 'Date Reported', type: 'date', example: '2026-03-12' },
    { key: 'repairDate', label: 'Repair Date', type: 'date', example: '2026-03-20', note: 'The day it was fixed. Give this or Date Reported.' },
    { key: 'issue', label: 'Description', required: true, example: 'Screen flickering' },
    { key: 'repairType', label: 'Repair Category', list: 'Repair category', example: 'Repair', note: 'Blank = Repair.' },
    { key: 'vendor', label: 'Vendor', example: 'ABC Service Centre' },
    { key: 'invoiceNo', label: 'Invoice No', example: 'INV-221', note: 'Same asset + vendor + invoice number is treated as the same repair.' },
    { key: 'cost', label: 'Amount (before tax)', required: true, type: 'number', example: '2500', note: 'Rupees, 0 or more, at most 2 decimals.' },
    { key: 'gstPaid', label: 'Tax (GST)', type: 'number', example: '450' },
    { key: 'total', label: 'Total', type: 'number', example: '2950', note: 'Optional. If given it must equal Amount + Tax.' },
    { key: 'status', label: 'Status', list: 'Status', example: 'Completed', note: 'Blank = Completed when there is a Repair Date, else Reported.' },
    { key: 'paidVia', label: 'Paid Via', list: 'Paid via', example: 'Bank' },
    { key: 'underWarranty', label: 'Under Warranty', example: 'No', note: 'Yes or No.' },
    { key: 'notes', label: 'Notes', example: '' },
  ],
  instructions: [
    'One row = one repair of one asset. The asset is found by Asset ID; a row whose asset is not in the register is listed as a missing dependency and nothing is created for it.',
    'The same repair (same Repair Record ID, or same asset + vendor + invoice, or the same asset + reported day + description) is never added twice.',
    'A repair is never added to the purchase cost by this import. It is posted to the journal from "Pending from HRMS".',
    'There is no payment-status or document field on a repair in the system, so those are not part of this file.',
  ],
  lists: async () => ({ 'Repair category': REPAIR_TYPES, Status: REPAIR_STATUSES, 'Paid via': PAID_VIA }),
};
const SPECS = { assets: ASSET_SPEC, repairs: REPAIR_SPEC };

function sampleFor(section, format) {
  const cfg = SECTIONS[section];
  if (!cfg || !cfg.fileKind) throw new ImportError(400, 'This section has no file import.');
  return io.sampleFile(SPECS[cfg.fileKind], {}, format === 'csv' ? 'csv' : 'xlsx');
}

// type + size + content check BEFORE anything is parsed (an extension alone proves nothing)
function checkUpload(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImportError(400, 'The file is empty. Choose the filled-in sample file (.xlsx or .csv).');
  if (buffer.length > MAX_BYTES) throw new ImportError(413, `The file is too big (${(buffer.length / 1048576).toFixed(1)} MB). The most allowed is 5 MB.`);
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.xlsm' || ext === '.xlsb' || ext === '.xltm') throw new ImportError(415, 'Macro-enabled Excel files are not accepted. Save the sheet as a normal .xlsx or .csv file.');
  if (!['.xlsx', '.csv'].includes(ext)) throw new ImportError(415, `"${safeName(fileName)}" is not a supported file. Use the sample file as .xlsx or .csv.`);
  if (ext === '.xlsx') {
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new ImportError(415, 'This file is not a real .xlsx workbook (its content does not match its name). Open it in Excel and save it again as .xlsx.');
    if (buffer.includes(Buffer.from('vbaProject.bin'))) throw new ImportError(415, 'This workbook contains macros, which are never accepted. Save a copy without macros.');
  } else if (buffer.includes(0)) {
    throw new ImportError(415, 'This does not look like a text CSV file (it holds binary data). Save the sheet as CSV again.');
  }
  return ext;
}

function parseUpload(section, buffer, fileName) {
  checkUpload(buffer, fileName);
  const spec = SPECS[SECTIONS[section].fileKind];
  const parsed = io.parseFile(spec, buffer, fileName);
  if (parsed.error) {
    const e = new ImportError(400, parsed.error);
    e.headerMismatch = parsed.headerMismatch || null;
    throw e;
  }
  if (parsed.rows.length > MAX_FILE_ROWS) throw new ImportError(400, `Import at most ${MAX_FILE_ROWS} rows at a time (this file has ${parsed.rows.length}).`);
  return { spec, parsed };
}

const ASSET_COLUMNS_OUT = [
  { key: 'line', label: 'Row' }, { key: 'assetCode', label: 'Asset ID' }, { key: 'name', label: 'Asset' }, { key: 'category', label: 'Category' }, { key: 'date', label: 'Purchase date' },
  { key: 'cost', label: 'Cost', num: true }, { key: 'holder', label: 'Assigned to' }, { key: 'department', label: 'Department' }, { key: 'serial', label: 'Serial no.' },
];
const REPAIR_COLUMNS_OUT = [
  { key: 'line', label: 'Row' }, { key: 'asset', label: 'Asset' }, { key: 'date', label: 'Date' }, { key: 'issue', label: 'Description' }, { key: 'vendor', label: 'Vendor' },
  { key: 'invoiceNo', label: 'Invoice' }, { key: 'cost', label: 'Amount', num: true }, { key: 'gst', label: 'Tax', num: true }, { key: 'total', label: 'Total', num: true },
];

function numberOf(v, problems, field, { min = 0, required = false, decimals = true } = {}) {
  const p = io.parseNumber(v);
  if (p.empty) { if (required) problems.push(problem(field, `${field} is empty.`, `Type the ${field.toLowerCase()} (a number, ${min} or more).`)); return null; }
  if (p.error) { problems.push(problem(field, `"${v}" is not a number.`, 'Use digits only, for example 2500 or 2500.50.')); return null; }
  if (p.value < min) { problems.push(problem(field, `${field} cannot be below ${min}.`, `Type ${min} or more.`)); return null; }
  if (decimals && !twoDecimals(p.value)) { problems.push(problem(field, `${field} has more than 2 decimals.`, 'Round it to paise (2 decimals).')); return null; }
  return p.value;
}
function dateOf(v, problems, field, { required = false, notFuture = false } = {}) {
  const p = io.parseDate(v);
  if (p.empty) { if (required) problems.push(problem(field, `${field} is empty.`, 'Type the date as YYYY-MM-DD.')); return null; }
  if (p.error) { problems.push(problem(field, `"${v}" is not a date.`, 'Use YYYY-MM-DD, for example 2026-03-20.')); return null; }
  if (notFuture && p.value > today()) { problems.push(problem(field, `${p.value} is in the future.`, 'Use a date up to today.')); return null; }
  return p.value;
}
function guardText(r, keys, problems, labels) {
  keys.forEach((k) => { if (looksLikeFormula(r[k])) problems.push(problem(labels[k], `${labels[k]} starts like a formula ("${str(r[k]).slice(0, 20)}").`, FORMULA_FIX)); });
}

async function validateAssetRows(rows) {
  const existing = await prisma.asset.findMany({ select: { id: true, assetCode: true, name: true, serialNumber: true } });
  const byCode = new Map(existing.map((a) => [a.assetCode.toLowerCase(), a]));
  const bySerial = new Map(existing.filter((a) => str(a.serialNumber)).map((a) => [str(a.serialNumber).toLowerCase(), a]));
  const emps = await prisma.employee.findMany({ where: withoutSystemAccounts({}), select: { id: true, employeeCode: true, name: true, email: true, department: true } });
  const eByCode = new Map(emps.map((e) => [str(e.employeeCode).toUpperCase(), e]));
  const eByMail = new Map(emps.filter((e) => e.email).map((e) => [str(e.email).toLowerCase(), e]));
  const usedCategories = new Set((await prisma.asset.findMany({ select: { category: true }, distinct: ['category'] })).map((c) => str(c.category).toLowerCase()));
  const seenCode = new Map(); const seenSerial = new Map();
  const L = {
    assetCode: 'Asset ID', name: 'Asset Name', category: 'Category', assetType: 'Asset Type', vendor: 'Vendor', invoiceNo: 'Invoice No', serialNumber: 'Serial Number', location: 'Location',
  };
  return rows.map((r) => {
    const problems = []; const notes = [];
    const code = str(r.assetCode);
    const out = {
      line: r.line, action: 'create', problems, notes, existing: null, reason: '', data: null,
      cells: {
        line: r.line, assetCode: code, name: str(r.name), category: str(r.category), date: str(r.purchaseDate), cost: str(r.purchaseCost), holder: '', department: '', serial: str(r.serialNumber),
      },
    };
    if (!code) problems.push(problem('Asset ID', 'Asset ID is empty.', 'Give every asset its own ID, so the same file can be loaded again without adding copies.'));
    if (!str(r.name)) problems.push(problem('Asset Name', 'Asset Name is empty.', 'Type the asset name.'));
    if (!str(r.category)) problems.push(problem('Category', 'Category is empty.', 'Pick or type a category (see the Lists sheet).'));
    guardText(r, Object.keys(L), problems, L);
    if (code.length > 80) problems.push(problem('Asset ID', 'Asset ID is longer than 80 characters.', 'Use a shorter ID.'));
    if (str(r.name).length > 200) problems.push(problem('Asset Name', 'Asset Name is longer than 200 characters.', 'Shorten the name.'));
    if (str(r.category).length > 80) problems.push(problem('Category', 'Category is longer than 80 characters.', 'Shorten the category.'));
    const date = dateOf(r.purchaseDate, problems, 'Purchase Date', { required: true, notFuture: true });
    const warranty = dateOf(r.warrantyUntil, problems, 'Warranty Until');
    const cost = numberOf(r.purchaseCost, problems, 'Purchase Cost', { required: true });
    const gst = numberOf(r.gstPaid, problems, 'GST Paid');
    const life = numberOf(r.usefulLifeYears, problems, 'Useful Life (Years)', { decimals: false });
    if (life !== null && !(life > 0)) problems.push(problem('Useful Life (Years)', 'Useful life must be more than 0.', 'Type the number of years, for example 3.'));
    const salvage = numberOf(r.salvageValue, problems, 'Residual Value');
    if (salvage !== null && cost !== null && salvage > cost) problems.push(problem('Residual Value', 'Residual value is more than the cost.', 'It must be 0 or more and not above the purchase cost.'));
    let method = null;
    if (str(r.depreciationMethod)) {
      const m = io.loose(r.depreciationMethod);
      if (['sl', 'slm', 'straightline', 'straightlinemethod'].includes(m)) method = 'SL';
      else if (['wdv', 'writtendownvalue', 'reducingbalance'].includes(m)) method = 'WDV';
      else problems.push(problem('Depreciation Method', `"${r.depreciationMethod}" is not SL or WDV.`, 'Use SL (straight line) or WDV (written down value).'));
    }
    let paidVia = null;
    if (str(r.paidVia)) { paidVia = io.pick(PAID_VIA, r.paidVia); if (!paidVia) problems.push(problem('Paid Via', `"${r.paidVia}" is not one of ${PAID_VIA.join(', ')}.`, 'Pick Bank, Cash or Payable.')); }
    let holder = null;
    if (str(r.holder)) {
      holder = eByCode.get(str(r.holder).toUpperCase()) || eByMail.get(str(r.holder).toLowerCase()) || null;
      if (!holder) problems.push(problem('Assigned To (Employee ID)', `Employee "${str(r.holder)}" was not found.`, 'Use the Employee ID shown in Employees, or leave it blank.'));
      else { out.cells.holder = holder.name; out.cells.department = holder.department || ''; }
    }
    let status = null;
    if (str(r.status)) { status = io.pick(STATUSES, r.status); if (!status) problems.push(problem('Status', `"${r.status}" is not one of ${STATUSES.join(', ')}.`, 'Pick one of those four.')); }
    if (holder && !status) status = 'Assigned';
    if (holder && ['Available', 'Retired'].includes(status)) problems.push(problem('Status', `An ${status} asset cannot also be assigned to somebody.`, 'Make the status Assigned, or clear Assigned To.'));
    if (status === 'Assigned' && !holder && !problems.some((p) => p.field === 'Assigned To (Employee ID)')) problems.push(problem('Status', 'Status is Assigned but no employee is given.', 'Give the Employee ID of the holder, or make the status Available.'));
    if (!status) status = 'Available';
    // duplicates - by reliable ids only
    const serial = str(r.serialNumber);
    const k = code.toLowerCase();
    const hit = k ? byCode.get(k) : null;
    const sHit = serial ? bySerial.get(serial.toLowerCase()) : null;
    if (k && seenCode.has(k)) { out.action = 'duplicate'; out.reason = `Asset ID repeated in this file (row ${seenCode.get(k)}). Only the first one is used.`; out.existing = { label: `Row ${seenCode.get(k)} of this file` }; } else if (hit) { out.action = 'duplicate'; out.reason = `Asset ID ${hit.assetCode} is already in the register. It was not changed - edit existing assets in HRMS.`; out.existing = { label: `${hit.assetCode} - ${hit.name}`, id: hit.id }; } else if (serial && seenSerial.has(serial.toLowerCase())) { out.action = 'duplicate'; out.reason = `Serial number ${serial} is repeated in this file (row ${seenSerial.get(serial.toLowerCase())}).`; out.existing = { label: `Row ${seenSerial.get(serial.toLowerCase())} of this file` }; } else if (sHit) { out.action = 'duplicate'; out.reason = `Serial number ${serial} already belongs to ${sHit.assetCode}. It was not changed.`; out.existing = { label: `${sHit.assetCode} - ${sHit.name}`, id: sHit.id }; }
    if (out.action === 'duplicate' && problems.length) out.action = 'error'; // a broken row is a problem first
    else if (out.action === 'duplicate') { /* listed, not an error */ } else if (!problems.length) {
      if (k) seenCode.set(k, r.line);
      if (serial) seenSerial.set(serial.toLowerCase(), r.line);
    }
    if (problems.length) out.action = 'error';
    if (out.action === 'create') {
      if (cost === 0) notes.push('Cost is 0 - nothing will be posted to the books for it.');
      if (!usedCategories.has(str(r.category).toLowerCase())) notes.push(`New category "${str(r.category)}" - its ledgers are made when the purchase is posted.`);
      out.data = {
        assetCode: code, name: str(r.name), category: canonicalCategory(str(r.category)), assetType: str(r.assetType) || null, purchaseDate: date, purchaseCost: cost, gstPaid: gst, paidVia,
        vendor: str(r.vendor) || null, invoiceNo: str(r.invoiceNo) || null, serialNumber: serial || null, location: str(r.location) || null, usefulLifeYears: life,
        depreciationMethod: method, salvageValue: salvage, status, warrantyUntil: warranty, holder,
      };
    }
    return out;
  });
}

async function validateRepairRows(rows) {
  const assets = await prisma.asset.findMany({ select: { id: true, assetCode: true, name: true, purchaseCost: true } });
  const byCode = new Map(assets.map((a) => [a.assetCode.toLowerCase(), a]));
  const ids = [...new Set(rows.map((r) => byCode.get(str(r.assetCode).toLowerCase())).filter(Boolean).map((a) => a.id))];
  const existing = ids.length ? await prisma.assetRepair.findMany({ where: { assetId: { in: ids } } }) : [];
  const allNos = new Map((await prisma.assetRepair.findMany({ select: { repairNo: true, assetId: true, issue: true } })).map((x) => [x.repairNo.toLowerCase(), x]));
  const codeOf = new Map(assets.map((a) => [a.id, a]));
  const seen = new Map();
  const L = { repairNo: 'Repair Record ID', assetCode: 'Asset ID', issue: 'Description', vendor: 'Vendor', invoiceNo: 'Invoice No', notes: 'Notes' };
  return rows.map((r) => {
    const problems = []; const notes = [];
    const code = str(r.assetCode);
    const a = code ? byCode.get(code.toLowerCase()) : null;
    const out = {
      line: r.line, action: 'create', problems, notes, existing: null, reason: '', data: null,
      cells: {
        line: r.line, asset: a ? `${a.assetCode} - ${a.name}` : code, date: str(r.repairDate) || str(r.dateReported), issue: str(r.issue), vendor: str(r.vendor), invoiceNo: str(r.invoiceNo), cost: str(r.cost), gst: str(r.gstPaid), total: str(r.total),
      },
    };
    if (!code) problems.push(problem('Asset ID', 'Asset ID is empty.', 'Give the Asset ID of the asset that was repaired.'));
    else if (!a) problems.push(problem('Asset ID', `No asset with ID "${code}" is in the register, so this repair has nothing to belong to.`, 'Import the asset first (Assets > Import), then load this file again.', { dependency: true }));
    if (!str(r.issue)) problems.push(problem('Description', 'Description is empty.', 'Say what was repaired.'));
    guardText(r, Object.keys(L), problems, L);
    const reported = dateOf(r.dateReported, problems, 'Date Reported', { notFuture: true });
    const done = dateOf(r.repairDate, problems, 'Repair Date', { notFuture: true });
    if (!reported && !done && !problems.some((p) => /Date/.test(p.field))) problems.push(problem('Repair Date', 'Both dates are empty.', 'Give the Repair Date (or the Date Reported).'));
    if (reported && done && done < reported) problems.push(problem('Repair Date', 'The Repair Date is before the Date Reported.', 'Swap or correct the dates.'));
    const cost = numberOf(r.cost, problems, 'Amount (before tax)', { required: true });
    const gst = numberOf(r.gstPaid, problems, 'Tax (GST)');
    const total = numberOf(r.total, problems, 'Total');
    if (total !== null && cost !== null && Math.abs(total - (cost + (gst || 0))) > 0.011) problems.push(problem('Total', `Total ${total} is not Amount ${cost} + Tax ${gst || 0}.`, 'Correct the Total (or leave it blank).'));
    const type = str(r.repairType) ? io.pick(REPAIR_TYPES, r.repairType) : 'Repair';
    if (str(r.repairType) && !type) problems.push(problem('Repair Category', `"${r.repairType}" is not one of ${REPAIR_TYPES.join(', ')}.`, 'Pick one of those.'));
    const st = str(r.status) ? io.pick(REPAIR_STATUSES, r.status) : null;
    if (str(r.status) && !st) problems.push(problem('Status', `"${r.status}" is not one of ${REPAIR_STATUSES.join(', ')}.`, 'Pick one of those.'));
    let paidVia = null;
    if (str(r.paidVia)) { paidVia = io.pick(PAID_VIA, r.paidVia); if (!paidVia) problems.push(problem('Paid Via', `"${r.paidVia}" is not one of ${PAID_VIA.join(', ')}.`, 'Pick Bank, Cash or Payable.')); }
    let warranty = false;
    if (str(r.underWarranty)) {
      if (/^(yes|y|true|1)$/i.test(str(r.underWarranty))) warranty = true;
      else if (!/^(no|n|false|0)$/i.test(str(r.underWarranty))) problems.push(problem('Under Warranty', `"${r.underWarranty}" is not Yes or No.`, 'Type Yes or No.'));
    }
    if (str(r.issue).length > 500) problems.push(problem('Description', 'Description is longer than 500 characters.', 'Shorten it.'));
    if (!problems.length && a) {
      const data = {
        assetId: a.id, dateReported: reported, issue: str(r.issue), repairType: type, vendor: str(r.vendor).slice(0, 120) || null, repairDate: done, cost: cost || 0, gstPaid: gst || 0,
        invoiceNo: str(r.invoiceNo).slice(0, 80) || null, paidVia, underWarranty: warranty, status: st || (done ? 'Completed' : 'Reported'), notes: str(r.notes).slice(0, 1000) || null,
      };
      // the same fingerprint as the HRMS "Asset repair history" import, so a file loaded there is recognised here
      const fp = `import:${crypto.createHash('sha1').update([a.id, data.dateReported || '', str(r.issue).toLowerCase(), str(data.vendor).toLowerCase(), data.repairDate || '', cost == null ? '' : cost].join('|')).digest('hex').slice(0, 24)}`;
      const dup = existing.find((x) => x.legacyEntryId === fp
        || (x.assetId === a.id && (x.dateReported || '') === (data.dateReported || '') && str(x.issue).toLowerCase() === data.issue.toLowerCase())
        || (data.invoiceNo && x.assetId === a.id && str(x.vendor).toLowerCase() === str(data.vendor).toLowerCase() && str(x.invoiceNo).toLowerCase() === data.invoiceNo.toLowerCase()));
      const noHit = str(r.repairNo) ? allNos.get(str(r.repairNo).toLowerCase()) : null;
      const key = fp;
      const invKey = data.invoiceNo ? `inv:${a.id}|${str(data.vendor).toLowerCase()}|${data.invoiceNo.toLowerCase()}` : null;
      if (noHit) {
        out.action = 'duplicate'; out.reason = `Repair record ${str(r.repairNo)} already exists (${noHit.assetId && codeOf.get(noHit.assetId) ? codeOf.get(noHit.assetId).assetCode : 'another asset'}). It was not changed.`;
        out.existing = { label: str(r.repairNo) };
      } else if (dup) {
        out.action = 'duplicate'; out.reason = `Already recorded as ${dup.repairNo} for ${a.assetCode} (same ${dup.legacyEntryId === fp ? 'record' : (data.invoiceNo && str(dup.invoiceNo).toLowerCase() === data.invoiceNo.toLowerCase() ? 'vendor and invoice' : 'reported day and description')}). It was not added again.`;
        out.existing = { label: `${dup.repairNo} - ${a.assetCode}`, id: dup.id };
      } else if (seen.has(key) || (invKey && seen.has(invKey))) {
        out.action = 'duplicate'; out.reason = `The same repair is repeated in this file (row ${seen.get(key) || seen.get(invKey)}). It is added once.`;
        out.existing = { label: `Row ${seen.get(key) || seen.get(invKey)} of this file` };
      } else {
        seen.set(key, r.line); if (invKey) seen.set(invKey, r.line);
        if (a.purchaseCost > 0) notes.push('The repair is added to the record only. Post it from "Pending from HRMS" (the asset must be in the books first).');
        out.data = { ...data, legacyEntryId: fp };
      }
    }
    if (problems.length) out.action = 'error';
    return out;
  });
}

function previewOfFile(section, rows, parsed, fileName) {
  const counts = countsOf(rows);
  return {
    section, source: 'file', fileName: safeName(fileName), columns: section === 'assets' ? ASSET_COLUMNS_OUT : REPAIR_COLUMNS_OUT, counts: { ...counts, exampleRowsSkipped: parsed.examples || 0 },
    info: { sheet: parsed.sheetName, ignoredReadOnly: parsed.ignoredReadOnly || [], shownRows: Math.min(rows.length, MAX_LIST) },
    mapping: SPECS[SECTIONS[section].fileKind].columns.filter((c) => !c.readOnly).map((c) => ({ column: c.label, field: c.key, required: !!c.required })),
    rows: rows.slice(0, MAX_LIST).map((r) => ({
      key: `row:${r.line}`, line: r.line, action: r.action, cells: r.cells, problems: r.problems, notes: r.notes, reason: r.reason, existing: r.existing,
    })),
  };
}

async function validateFile(section, buffer, fileName) {
  const { parsed } = parseUpload(section, buffer, fileName);
  const rows = section === 'assets' ? await validateAssetRows(parsed.rows) : await validateRepairRows(parsed.rows);
  return { rows, parsed };
}

// ---- the writes ---------------------------------------------------------------------------
async function applyAssets(rows, user) {
  const res = { created: [], failures: [] };
  const actor = user.name || user.email || 'import';
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const v of rows) {
    const x = v.data;
    try {
      // eslint-disable-next-line no-await-in-loop
      const asset = await prisma.$transaction(async (tx) => {
        const clash = await tx.asset.findFirst({ where: { OR: [{ assetCode: x.assetCode }, ...(x.serialNumber ? [{ serialNumber: x.serialNumber }] : [])] }, select: { assetCode: true } });
        if (clash) throw Object.assign(new Error(`${clash.assetCode} appeared while importing`), { duplicate: true });
        const hist = [{ at: stamp(), by: actor, text: 'Added by Accounts import (Fixed Assets)' }];
        if (x.holder) hist.unshift({ at: stamp(), by: actor, text: `Assigned to ${x.holder.name} (import)` });
        const created = await tx.asset.create({
          data: {
            assetCode: x.assetCode, name: x.name, category: x.category, status: x.status, purchaseDate: x.purchaseDate, purchaseCost: x.purchaseCost, gstPaid: x.gstPaid, paidVia: x.paidVia,
            vendor: x.vendor, invoiceNo: x.invoiceNo, serialNumber: x.serialNumber, assetType: x.assetType, location: x.location, usefulLifeYears: x.usefulLifeYears,
            depreciationMethod: x.depreciationMethod, salvageValue: x.salvageValue, warrantyUntil: x.warrantyUntil, history: JSON.stringify(hist),
            ...(x.holder ? { assignedToId: x.holder.id, assignedAt: new Date(), assignedById: user.id, assignedByName: actor } : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            userId: user.id, actorName: actor, action: 'Asset imported (Accounts)', entity: 'Asset', entityId: created.id,
            toValue: `${created.assetCode} ${created.name} · ${created.status}`,
          },
        });
        return created;
      });
      res.created.push({ id: asset.id, assetCode: asset.assetCode, name: asset.name });
    } catch (err) {
      res.failures.push({
        line: v.line, ref: v.cells.assetCode, name: v.cells.name, duplicate: !!(err && err.duplicate),
        reason: err && err.duplicate ? `${tidy(err)} - this row was not added.` : `The database could not save this row (${tidy(err)}). Nothing was saved for it.`,
        fix: err && err.duplicate ? 'It is already in the register.' : 'Try again in a moment. Nothing was saved for this row.',
      });
    }
  }
  return res;
}

async function applyRepairs(rows, user) {
  const res = { created: [], failures: [] };
  const actor = user.name || user.email || 'import';
  const batch = `FA-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  for (const v of rows) {
    const x = v.data;
    try {
      let row = null;
      for (let i = 0; i < 6 && !row; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const last = await prisma.assetRepair.findMany({ select: { repairNo: true }, orderBy: { repairNo: 'desc' }, take: 1 });
        const n = (last.length ? Number(String(last[0].repairNo).replace(/\D/g, '')) || 0 : 0) + 1 + i;
        try {
          // eslint-disable-next-line no-await-in-loop
          row = await prisma.$transaction(async (tx) => {
            const made = await tx.assetRepair.create({ data: { repairNo: `RP-${String(n).padStart(5, '0')}`, reportedByName: `Accounts import (${batch})`, ...x } });
            await tx.auditLog.create({
              data: {
                userId: user.id, actorName: actor, action: 'Asset repair imported (Accounts)', entity: 'AssetRepair', entityId: made.id,
                toValue: `${made.repairNo} · ${x.issue} · ${x.status}`, reason: `batch ${batch}`,
              },
            });
            return made;
          });
        } catch (err) {
          if (!(err && err.code === 'P2002' && String(err.meta && err.meta.target).includes('repairNo'))) throw err;
        }
      }
      if (!row) throw new Error('Could not number the repair');
      res.created.push({ id: row.id, repairNo: row.repairNo, assetId: x.assetId });
    } catch (err) {
      res.failures.push({ line: v.line, ref: v.cells.asset, name: v.cells.issue, reason: `The database could not save this row (${tidy(err)}). Nothing was saved for it.`, fix: 'Try again in a moment. Nothing was saved for this row.' });
    }
  }
  return res;
}

async function confirmFile(section, user, buffer, fileName) {
  const { rows } = await validateFile(section, buffer, fileName);
  const res = {
    total: rows.length, imported: 0, updated: 0, skipped: 0, duplicates: 0, failed: 0, failures: [], duplicateList: [], skippedList: [], created: [],
  };
  const todo = [];
  rows.forEach((r) => {
    const ref = section === 'assets' ? r.cells.assetCode : r.cells.asset;
    if (r.action === 'duplicate') { res.duplicates += 1; res.duplicateList.push({ ref: `Row ${r.line}: ${ref}`, name: r.cells.name || r.cells.issue || '', existing: r.existing ? r.existing.label : '', reason: r.reason }); } else if (r.action === 'error') {
      res.failed += 1;
      res.failures.push({ ref: `Row ${r.line}: ${ref}`, name: r.cells.name || r.cells.issue || '', reason: r.problems.map((p) => `${p.field}: ${p.message}`).join(' | '), fix: r.problems.map((p) => p.fix).filter(Boolean)[0] || '', dependency: r.problems.some((p) => p.dependency) });
    } else todo.push(r);
  });
  const w = section === 'assets' ? await applyAssets(todo, user) : await applyRepairs(todo, user);
  res.imported = w.created.length;
  w.failures.forEach((f) => {
    if (f.duplicate) { res.duplicates += 1; res.duplicateList.push({ ref: `Row ${f.line}: ${f.ref}`, name: f.name, existing: '', reason: f.reason }); } else { res.failed += 1; res.failures.push({ ref: `Row ${f.line}: ${f.ref}`, name: f.name, reason: f.reason, fix: f.fix, dependency: false }); }
  });
  res.created = section === 'assets' ? w.created : [];
  return res;
}

// ===========================================================================================
//  The two entry points the router calls
// ===========================================================================================
function need(section, source) {
  const cfg = SECTIONS[section];
  if (!cfg) throw new ImportError(400, 'Unknown section.');
  if (!cfg.sources.includes(source)) throw new ImportError(400, `${cfg.label} has no "${source}" import.`);
  return cfg;
}

async function runPreview({ section, source, buffer, fileName }) {
  need(section, source);
  if (source === 'hrms') return previewHrms(section);
  const { rows, parsed } = await validateFile(section, buffer, fileName);
  return previewOfFile(section, rows, parsed, fileName);
}

function messageOf(r) {
  if (!r.total) return 'There was nothing to import.';
  const ok = r.imported + r.updated;
  const bits = [];
  if (r.imported) bits.push(`${r.imported} imported`);
  if (r.updated) bits.push(`${r.updated} updated`);
  if (r.duplicates) bits.push(`${r.duplicates} already there`);
  if (r.skipped) bits.push(`${r.skipped} skipped`);
  if (r.failed) bits.push(`${r.failed} not imported`);
  if (!ok && r.failed) return `Nothing was saved. ${bits.join(', ')}. See the list below.`;
  if (!ok) return `Nothing new was added - ${bits.join(', ')}.`;
  if (r.failed) return `Partly done: ${bits.join(', ')}. The rows that failed were NOT saved - see the list below.`;
  return `Done: ${bits.join(', ')}.`;
}

// Confirm = lock + idempotency key + audit. Returns { status, body }.
async function runConfirm({ section, source, buffer, fileName, user, idempotencyKey, items }) {
  need(section, source);
  return idempotently(user, idempotencyKey, () => withLock(async () => {
    const started = new Date();
    const r = source === 'hrms' ? await confirmHrms(section, user, Array.isArray(items) && items.length ? new Set(items.map(String)) : null) : await confirmFile(section, user, buffer, fileName);
    const batchId = `FAI-${started.toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
    const body = {
      ok: true, batchId, section, source, fileName: source === 'file' ? safeName(fileName) : null, at: started.toISOString(),
      total: r.total, imported: r.imported, updated: r.updated, skipped: r.skipped, duplicates: r.duplicates, failed: r.failed,
      failures: r.failures.slice(0, 2000), duplicateList: r.duplicateList.slice(0, 500), skippedList: r.skippedList.slice(0, 500), created: r.created.slice(0, 50),
      figures: r.figures || null, nothingSaved: r.imported + r.updated === 0,
    };
    body.message = messageOf(body);
    await logAudit({
      userId: user.id, actorName: user.name || user.email, action: `Fixed assets import - ${SECTIONS[section].label}`, entity: 'FixedAssetImport', entityId: batchId,
      fromValue: source === 'file' ? `file ${safeName(fileName)}` : 'HRMS records',
      toValue: `total ${r.total} · imported ${r.imported} · updated ${r.updated} · skipped ${r.skipped} · duplicates ${r.duplicates} · failed ${r.failed}`,
    });
    return { status: 200, body };
  }));
}

module.exports = {
  SECTIONS, ImportError, runPreview, runConfirm, sampleFor, checkUpload, figures, ASSET_SPEC, REPAIR_SPEC, MAX_BYTES, safeName,
};

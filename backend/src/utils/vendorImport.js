// ---------------------------------------------------------------------------
// VENDOR IMPORT - the "Import" button of the vendor portals (2026-10-19). Route: routes/vendorIo.js (/api/vendor-portal/vendor-io/import/*).
//
// WHAT "IMPORT" MEANS FOR A VENDOR (and what it never means):
//   The COMPANY's assets are NEVER imported by anybody: they arrive by themselves from HRMS and Accounts (utils/assetHrmsScope.js reads the one
//   Asset table live). So a vendor's Import is only a faster way to do, from an Excel / CSV file, what the same login may already do one row at a
//   time on its own screens - through the SAME functions and the SAME rules:
//
//     repair-updates  (Assets portal, needs "Allow editing")   Repair ID + Status / Estimate / Expected date / Final cost / GST / Invoice number
//                     / Remarks  ->  utils/assetVendorPortal.js updateRepair (one step forward, no skipping, no going back; cost and invoice
//                     rules; nothing once Accounts has the bill under check). It only UPDATES the company's own repairs: it never creates a
//                     repair or an asset, and it can never touch a repair that is not in this vendor's Repairs list.
//     order-status    (Assets portal "Allow editing"; ID Card portal "Update order status")   Order reference + next Status + Remarks
//                     ->  the same one-step-forward move as the Orders / Requests screens (updateOrderStatus / moveOrder).
//     bills           (finance vendors with "Raise invoices"; Airtel with "Send a bill")   one row = one bill (no file)  ->  the SAME
//                     checks and the SAME insert as "Send a bill" (routes/vendorModulePortal.js saveBill): same duplicate protection, same review
//                     queue in Accounts, still never paid or posted. Provider is the vendor itself.
//   A vendor can never set a payment status, a paid amount or a date paid: such a column is not in the sample, so the file is refused.
//
// THE FLOW (same as the staff imports, e.g. Fixed Assets): sample file (xlsx / csv) = the contract, strict headers -> Preview (NOTHING is saved,
// every row is checked with the real rules in "dry" mode) -> Confirm (needs an Idempotency-Key; each row is its own transaction; a failed row never
// stops the others and the answer says exactly how many were saved / skipped / already there / failed). The same key again returns the first
// answer (VendorImportRun is UNIQUE on vendor login + key). Running the same file twice changes nothing the second time.
// FILE SAFETY: .xlsx or .csv only, real content checked (an .xlsx must be a real zip workbook, a .csv must be text), 5 MB, 2000 rows, formulas are
// never evaluated and a file that contains one is refused, a text cell that starts with = or @ is refused (a row error).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const XLSX = require('xlsx');
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./assetVendorSchema');
const IO = require('./moduleIo');
const VP = require('./vendorPortal');
const HS = require('./assetHrmsScope');
const AVP = require('./assetVendorPortal');
const IDC = require('./idCardVendorPortal');
const R = require('./vendorRecords');
const ATB = require('./airtelBillsPortal');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const str = IO.str;
const nowIso = () => new Date().toISOString();
const looksLikeFormula = (v) => /^[=@]/.test(str(v)) || /^[+-]\s*[A-Za-z(]/.test(str(v));

class ImportError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

// ---- the three sample files ---------------------------------------------------------------------------------------
const col = (key, label, o = {}) => ({ key, label, ...o });
const SPECS = {
  'repair-updates': {
    key: 'repair-updates', label: 'Repair updates', module: 'Assets portal', sheet: 'Repair updates',
    columns: [
      col('repairNo', 'Repair ID', { required: true, note: 'Copy it from the Repairs page, like RP-00012. One line for each repair.' }),
      col('stage', 'Status', { list: 'Status', note: 'The NEXT step only: steps cannot be skipped or taken back. Leave it empty to keep the step as it is.' }),
      col('estimateCost', 'Estimate', { type: 'number', note: 'Your estimate in rupees. Empty = leave as it is.' }),
      col('expectedDate', 'Expected date', { type: 'date', note: 'The day you expect to finish.' }),
      col('finalCost', 'Final cost', { type: 'number', note: 'The final cost in rupees, after the asset has reached you.' }),
      col('finalGst', 'GST', { type: 'number', note: 'The GST on the final cost.' }),
      col('invoiceNo', 'Invoice number', { note: 'Your invoice number for this repair.' }),
      col('remarks', 'Remarks', { note: 'A short note for the company.' }),
    ],
    examples: [{ repairNo: 'RP-00001', stage: 'Sent for repair', estimateCost: 1500, expectedDate: '2026-11-05', finalCost: '', finalGst: '', invoiceNo: '', remarks: 'Asset received' }],
    instructions: [
      'This file only updates the repairs the company has already given you. It never creates a repair or an asset.',
      'You can not set a payment status or a paid amount here: Accounts pays, and the bank statement confirms it.',
    ],
    lists: () => ({ Status: AVP.STAGES }),
  },
  'order-status': {
    key: 'order-status', label: 'Order status', module: 'Orders', sheet: 'Order status',
    columns: [
      col('orderRef', 'Order reference', { required: true, note: 'Copy it from the Orders page, like ICO-0004.' }),
      col('status', 'Status', { required: true, list: 'Status', note: 'The NEXT step only: New, Received, Printing, Ready, Delivered (one step at a time).' }),
      col('remarks', 'Remarks', { note: 'A short note for the company.' }),
    ],
    examples: [{ orderRef: 'ICO-0001', status: 'Received', remarks: '' }],
    instructions: ['Each order can move one step forward. The same status again changes nothing.'],
    lists: () => ({ Status: AVP.ORDER_FLOW }),
  },
  'bills-finance': {
    key: 'bills-finance', label: 'Invoices', module: 'Invoices', sheet: 'Invoices',
    columns: [
      col('billNumber', 'Invoice number', { required: true, note: 'Your own invoice number. An invoice number you already sent is shown as "already there", not sent again.' }),
      col('billDate', 'Invoice date', { required: true, type: 'date', note: 'Not in the future.' }),
      col('amount', 'Amount', { required: true, type: 'number', note: 'Before GST, in rupees. More than 0.' }),
      col('gst', 'GST', { type: 'number', note: 'The GST amount. Empty = 0.' }),
      col('remarks', 'Description', { note: 'What the invoice is for.' }),
      col('dueDate', 'Due date', { type: 'date', note: 'Optional.' }),
    ],
    examples: [{ billNumber: 'INV-2026-001', billDate: '2026-10-01', amount: 10000, gst: 1800, remarks: 'Service for October', dueDate: '2026-10-31' }],
    instructions: [
      'Each line is one invoice sent to Accounts for checking, the same as "Send an invoice" on the Invoices page, but without the PDF. You can add the copy later with Accounts.',
      'You can not set a payment status or a paid amount here: Accounts pays, and the bank statement confirms it.',
    ],
  },
  'bills-telecom': {
    key: 'bills-telecom', label: 'Airtel bills', module: 'Bills', sheet: 'Bills',
    columns: [
      col('billNumber', 'Bill number', { required: true, note: 'The invoice number printed on the bill.' }),
      col('period', 'Billing month', { required: true, note: 'Like 2026-10 (year-month). One bill for each month.' }),
      col('billDate', 'Bill date', { type: 'date', note: 'Optional. Empty = today.' }),
      col('dueDate', 'Due date', { required: true, type: 'date', note: 'The payment due date.' }),
      col('amount', 'Amount', { required: true, type: 'number', note: 'Before tax, in rupees. More than 0.' }),
      col('gst', 'GST', { type: 'number', note: 'The tax amount. Empty = 0.' }),
      col('remarks', 'Remarks', { note: 'Optional.' }),
    ],
    examples: [{ billNumber: 'AIR-2026-10', period: '2026-10', billDate: '2026-10-05', dueDate: '2026-10-25', amount: 20000, gst: 3600, remarks: '' }],
    instructions: [
      'Each line is one monthly bill sent to Accounts for checking, the same as "Send a bill", but without the PDF. The provider is you (Airtel).',
      'A bill Accounts already holds (same bill number, or the same month and amount) is shown as "already there" and not sent again.',
      'You can not set a payment status or a paid amount here: Accounts pays, and the bank statement confirms it.',
    ],
  },
};

// Which imports exist for which kind of vendor, and which tick allows each (the route evaluates `allow`).
const KIND_IMPORTS = {
  assets: [
    { key: 'repair-updates', spec: 'repair-updates', title: 'Import repair updates', help: 'Update many repairs at once from Excel or CSV: step, estimate, expected date, final cost, GST, invoice number, remarks.', needs: 'Allow editing' },
    { key: 'order-status', spec: 'order-status', title: 'Import order status', help: 'Move many orders one step forward from Excel or CSV.', needs: 'Allow editing' },
  ],
  idcards: [{ key: 'order-status', spec: 'order-status', title: 'Import order status', help: 'Move many ID card orders one step forward from Excel or CSV.', needs: 'Update order status' }],
  finance: [{ key: 'bills', spec: 'bills-finance', title: 'Import invoices', help: 'Send many invoices to Accounts from Excel or CSV (one line = one invoice).', needs: 'Raise / upload invoices' }],
  telecom: [{ key: 'bills', spec: 'bills-telecom', title: 'Import bills', help: 'Send many monthly bills to Accounts from Excel or CSV (one line = one bill).', needs: 'Send a bill' }],
};
const importsOf = (kind) => KIND_IMPORTS[kind] || [];
const importOf = (kind, key) => importsOf(kind).find((i) => i.key === key) || null;
const specOf = (imp) => SPECS[imp.spec];

async function sampleFor(kind, key, format) {
  const imp = importOf(kind, key);
  if (!imp) throw new ImportError(404, 'There is no Import for this page.');
  const spec = specOf(imp);
  const buf = await IO.sampleFile({ ...spec, lists: spec.lists ? spec.lists() : undefined }, {}, format === 'csv' ? 'csv' : 'xlsx');
  return { buffer: buf, filename: `${imp.key}-import-sample.${format === 'csv' ? 'csv' : 'xlsx'}`, mime: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

// ---- reading the file safely --------------------------------------------------------------------------------------
const PAYMENT_HEADER = /^(status|paid|paid amount|payment|payment status|status of payment|paid on|payment date|balance|utr|bank|bank reference|paid by|approved|approval|approval status)$/i;
function checkFile(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImportError(400, 'Choose the file first. The file is empty.');
  if (buffer.length > MAX_BYTES) throw new ImportError(413, 'The file is too big. The most allowed is 5 MB.');
  const name = String(fileName || '');
  const isCsv = /\.csv$/i.test(name);
  const isXlsx = /\.xlsx$/i.test(name);
  if (!isCsv && !isXlsx) throw new ImportError(400, 'Only an Excel file (.xlsx) or a CSV file (.csv) can be imported. Download the sample file and fill it in.');
  if (isXlsx) {
    // a real .xlsx is a zip: it starts with PK. (An old .xls, a renamed picture or a CSV with the wrong ending is refused.)
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) throw new ImportError(400, 'This is not a real Excel (.xlsx) file. Open it in Excel and use Save as > Excel Workbook (.xlsx), or use the CSV sample.');
  } else {
    if (buffer.includes(0)) throw new ImportError(400, 'This is not a plain CSV text file. Use the CSV sample, or the Excel sample.');
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) throw new ImportError(400, 'This looks like an Excel file but its name ends in .csv. Rename it to .xlsx or save it as CSV.');
  }
  return { isCsv };
}
// A workbook that holds a formula is refused (formulas are never evaluated here); the cells are named so the vendor can fix them.
function scanFormulas(buffer) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellHTML: false, bookVBA: false }); } catch (err) { throw new ImportError(400, `That file could not be read as Excel (${String(err.message || err).slice(0, 80)}).`); }
  const hits = [];
  wb.SheetNames.forEach((n) => {
    const ws = wb.Sheets[n];
    Object.keys(ws).forEach((k) => { if (k[0] !== '!' && ws[k] && ws[k].f) hits.push(`${n}!${k}`); });
  });
  if (hits.length) throw new ImportError(400, `This file contains ${hits.length} formula${hits.length === 1 ? '' : 's'} (${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', ...' : ''}). Formulas are never read. Copy the cells and paste them as values only, then try again.`, { formulas: hits.slice(0, 20) });
}
function parse(spec, buffer, fileName) {
  const { isCsv } = checkFile(buffer, fileName);
  if (!isCsv) scanFormulas(buffer);
  const lists = spec.lists ? spec.lists() : undefined;
  const parsed = IO.parseFile({ ...spec, lists }, buffer, fileName);
  if (parsed.error) {
    const pay = parsed.headerMismatch && (parsed.headerMismatch.unknown || []).some((h) => PAYMENT_HEADER.test(String(h).trim()));
    throw new ImportError(400, pay ? 'A vendor cannot set a payment status or a paid amount. Accounts pays, and the bank statement confirms it. Remove that column and use the sample file as it is.' : parsed.error, parsed.headerMismatch ? { headerMismatch: parsed.headerMismatch } : {});
  }
  if (parsed.rows.length > MAX_ROWS) throw new ImportError(400, `Import at most ${MAX_ROWS} rows at a time (this file has ${parsed.rows.length}).`);
  return parsed;
}

// ---- one row = one action, through the real functions --------------------------------------------------------------
const norm = (s) => str(s).toUpperCase().replace(/\s+/g, '');
const rowErr = (message, fix, field) => ({ outcome: 'error', message, fix: fix || '', field: field || null });

// Each handler: { prepare(ctx) -> prep, key(row) -> string for the "twice in the file" check, run(ctx, prep, row, dry) -> { outcome, message, changes? } }
// outcome: 'ok' (a change is made / would be made) | 'unchanged' | 'duplicate' | 'error'
const HANDLERS = {
  'repair-updates': {
    async prepare(ctx) {
      const ids = [...await AVP.visibleRepairIds(ctx.v)];
      const rows = ids.length ? await prisma.assetRepair.findMany({ where: { id: { in: ids } }, select: { id: true, repairNo: true } }) : [];
      return { byNo: new Map(rows.map((r) => [norm(r.repairNo), r.id])) };
    },
    key: (row) => norm(row.repairNo),
    async run(ctx, prep, row, dry) {
      const id = prep.byNo.get(norm(row.repairNo));
      if (!id) return rowErr(`There is no repair "${row.repairNo}" in your Repairs list.`, 'Copy the Repair ID from the Repairs page. A repair that is not yours cannot be changed.', 'Repair ID');
      const body = {};
      if (str(row.stage)) {
        const st = IO.pick(AVP.STAGES, row.stage);
        if (!st) return rowErr(`"${row.stage}" is not a repair step.`, `Use one of: ${AVP.STAGES.join(', ')}.`, 'Status');
        body.stage = st;
      }
      const put = (k, v) => { if (str(v) !== '') body[k] = typeof v === 'number' ? String(v) : str(v); };
      put('estimateCost', row.estimateCost); put('finalCost', row.finalCost); put('finalGst', row.finalGst); put('invoiceNo', row.invoiceNo); put('remarks', row.remarks);
      if (str(row.expectedDate)) body.expectedDate = str(row.expectedDate);
      if (!Object.keys(body).length) return { outcome: 'unchanged', message: 'Nothing to change on this line.' };
      const r = await AVP.updateRepair(ctx.v, ctx.req, id, body, { dry, quiet: true });
      if (r.status !== 200) return rowErr(r.body.error || 'This update was refused.', r.body.expected ? `The next step is "${r.body.expected}".` : '', r.body.field || null);
      if (r.body.unchanged || (r.body.changed && !r.body.changed.length)) return { outcome: 'unchanged', message: 'Already as it is.' };
      return { outcome: 'ok', message: `${(r.body.changed || []).join(', ')} ${dry ? 'will change' : 'changed'}.`, changes: r.body.changed || [] };
    },
  },
  'order-status': {
    async prepare(ctx) {
      if (ctx.kind === 'idcards') {
        const rows = (await DB.ready()) ? await DB.q('SELECT "id","orderCode" FROM "IdCardOrder" WHERE "vendorId" = ?', [ctx.v.vendorId]) : [];
        return { byNo: new Map(rows.map((r) => [norm(r.orderCode), r.id])) };
      }
      const orders = (await R.purchaseOrders(ctx.v.vendorId)).filter((o) => o.kind === 'order');
      return { byNo: new Map(orders.map((o) => [norm(o.poNumber), o.id])) };
    },
    key: (row) => norm(row.orderRef),
    async run(ctx, prep, row, dry) {
      const id = prep.byNo.get(norm(row.orderRef));
      if (!id) return rowErr(`There is no order "${row.orderRef}" in your Orders.`, 'Copy the order reference from the Orders page. An order that is not yours cannot be changed.', 'Order reference');
      const status = IO.pick(AVP.ORDER_FLOW, row.status);
      if (!status) return rowErr(`"${row.status}" is not an order status.`, `Use one of: ${AVP.ORDER_FLOW.join(', ')}.`, 'Status');
      let r;
      if (ctx.kind === 'idcards') r = await IDC.moveOrder(ctx.v, ctx.req, ctx.perms, id, status, str(row.remarks), { quiet: true, dry });
      else r = await AVP.updateOrderStatus(ctx.v, ctx.req, id, { status, ...(str(row.remarks) ? { remarks: str(row.remarks) } : {}) }, { dry, quiet: true });
      if (r.status !== 200) return rowErr(r.body.error || 'This update was refused.', r.body.expected ? `The next step is "${r.body.expected}".` : '', r.body.field || 'Status');
      if (r.body.unchanged) return { outcome: 'unchanged', message: `Already ${status}.` };
      return { outcome: 'ok', message: dry ? `Will move to ${status}.` : `Moved to ${status}.`, changes: ['Status'] };
    },
  },
  bills: {
    async prepare() { return {}; },
    key: (row, ctx) => (ctx.kind === 'telecom' ? `${norm(row.billNumber)}|${str(row.period)}` : norm(row.billNumber)),
    async run(ctx, prep, row, dry) {
      const monthly = ctx.kind === 'telecom';
      let period = str(row.period);
      if (monthly) {
        if (/^\d{5}$/.test(period)) { const d = IO.dateFromSerial(Number(period)); period = d ? d.slice(0, 7) : period; } // Excel turned 2026-10 into a date
        period = period.replace(/^(\d{4})[/.](\d{1,2})$/, (m, y, mo) => `${y}-${String(mo).padStart(2, '0')}`);
      }
      const fields = {
        billNumber: str(row.billNumber), billDate: str(row.billDate), dueDate: str(row.dueDate), amount: str(row.amount), gst: str(row.gst), remarks: str(row.remarks),
        ...(monthly ? { period } : {}),
      };
      const create = require('../routes/vendorModulePortal').saveBill; // eslint-disable-line global-require
      const r = await create(ctx.req, monthly ? 'monthly_bill' : 'invoice', fields, null, {
        noFile: true, dry, quiet: true, remarksPrefix: '[Excel import]',
        extraCheck: monthly ? (d) => ATB.duplicateInAccounts(ctx.v, d) : undefined,
      });
      if (r.status === 409 && r.duplicate) return { outcome: 'duplicate', message: r.body.error };
      if (r.status !== 200 && r.status !== 201) return rowErr(r.body.error || 'This bill was refused.', '', r.body.field || null);
      return { outcome: 'ok', message: dry ? 'Will be sent to Accounts.' : `Sent to Accounts (${r.body.bill ? r.body.bill.billCode : ''}).`, changes: ['New bill'] };
    },
  },
};

// ---- the engine ---------------------------------------------------------------------------------------------------
// ctx = { req, kind, v, perms, importKey }
async function processRows(ctx, imp, rows, dry) {
  const spec = specOf(imp);
  const h = HANDLERS[imp.key];
  const prep = await h.prepare(ctx);
  const seen = new Map();
  const out = [];
  for (const row of rows) {
    const label = str(row[spec.columns[0].key]);
    const rec = { line: row.line, label, outcome: 'error', message: '', fix: '', field: null, changes: [] };
    out.push(rec);
    // 1. the file's own rules (required, formula text)
    const missing = IO.requiredErrors(spec, row);
    if (missing.length) { Object.assign(rec, rowErr(missing.map((m) => m.message).join(' '), 'Fill the cell and try again.', missing[0].field)); continue; } // eslint-disable-line no-continue
    const bad = spec.columns.find((c) => looksLikeFormula(row[c.key]));
    if (bad) { Object.assign(rec, rowErr(`${bad.label} starts with = or @, which looks like a formula.`, 'Remove the leading = or @ (a cell that starts like that is treated as a formula and is never accepted).', bad.label)); continue; } // eslint-disable-line no-continue
    const badNum = spec.columns.find((c) => c.type === 'number' && str(row[c.key]) !== '' && IO.parseNumber(row[c.key]).error);
    if (badNum) { Object.assign(rec, rowErr(`${badNum.label} must be a number like 1500.`, 'Type the amount in rupees, without text.', badNum.label)); continue; } // eslint-disable-line no-continue
    const badDate = spec.columns.find((c) => c.type === 'date' && str(row[c.key]) !== '' && (IO.parseDate(row[c.key]).error));
    if (badDate) { Object.assign(rec, rowErr(`${badDate.label} is not a real date.`, 'Use YYYY-MM-DD, like 2026-11-05.', badDate.label)); continue; } // eslint-disable-line no-continue
    // normalise dates the way the real functions expect (YYYY-MM-DD)
    const r2 = { ...row };
    spec.columns.filter((c) => c.type === 'date').forEach((c) => { if (str(r2[c.key]) !== '') r2[c.key] = IO.parseDate(r2[c.key]).value; });
    // 2. the same thing twice in one file
    const k = h.key(r2, ctx);
    if (seen.has(k)) { Object.assign(rec, rowErr(`This line repeats line ${seen.get(k)} of the file.`, 'Keep one line for each item and put all its changes on that line.', spec.columns[0].label)); continue; } // eslint-disable-line no-continue
    seen.set(k, row.line);
    // 3. the real rules
    try {
      if (!dry && process.env.TEST_MODE === '1' && process.env.VENDOR_IMPORT_FAIL_LINE && Number(process.env.VENDOR_IMPORT_FAIL_LINE) === Number(row.line)) throw new Error('injected test failure');
      // eslint-disable-next-line no-await-in-loop
      const res = await h.run(ctx, prep, r2, dry);
      Object.assign(rec, res);
    } catch (err) {
      console.error('[vendor-import] row %s: %s', row.line, err && err.message); // eslint-disable-line no-console
      Object.assign(rec, rowErr('This line could not be saved because of a technical problem.', 'Run the import again with the same file: lines already saved are not repeated.'));
      rec.technical = true;
    }
  }
  return out;
}
const tally = (recs) => ({
  total: recs.length,
  willChange: recs.filter((r) => r.outcome === 'ok').length,
  unchanged: recs.filter((r) => r.outcome === 'unchanged').length,
  duplicate: recs.filter((r) => r.outcome === 'duplicate').length,
  failed: recs.filter((r) => r.outcome === 'error').length,
});
const slimRows = (recs) => recs.map((r) => ({ line: r.line, label: r.label, outcome: r.outcome, message: r.message, fix: r.fix || '', field: r.field || null, changes: (r.changes || []).slice(0, 12) }));

// PREVIEW: reads and checks every row with the real rules in dry mode. Writes NOTHING.
async function preview(ctx, buffer, fileName) {
  const imp = importOf(ctx.kind, ctx.importKey);
  if (!imp) throw new ImportError(404, 'There is no Import for this page.');
  const parsed = parse(specOf(imp), buffer, fileName);
  const recs = await HS.withScopeCache(() => processRows(ctx, imp, parsed.rows, true));
  const t = tally(recs);
  return {
    preview: true, importKey: imp.key, title: imp.title, fileName: String(fileName || '').slice(0, 120), rowCount: t.total, examplesSkipped: parsed.examples || 0,
    willChange: t.willChange, unchanged: t.unchanged, alreadyThere: t.duplicate, failed: t.failed, rows: slimRows(recs),
    canConfirm: t.willChange > 0,
    note: t.willChange ? `${t.willChange} line${t.willChange === 1 ? '' : 's'} will be saved. Nothing has been saved yet.` : 'Nothing in this file needs saving.',
  };
}

// ---- idempotent, one at a time per vendor -------------------------------------------------------------------------
const chains = new Map();
function withLock(vendorId, fn) {
  const prev = chains.get(vendorId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(vendorId, tail);
  tail.then(() => { if (chains.get(vendorId) === tail) chains.delete(vendorId); });
  return run;
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function claim(ctx, idem, fileName, hash) {
  try {
    await DB.run('INSERT INTO "VendorImportRun" ("id","vendorId","vendorUserId","idemKey","importKey","fileName","fileHash","state","createdAt") VALUES (?,?,?,?,?,?,?,?,?)',
      [`vir${crypto.randomBytes(10).toString('hex')}`, ctx.v.vendorId, ctx.v.userId, idem, `${ctx.kind}:${ctx.importKey}`, String(fileName || '').slice(0, 120), hash, 'running', nowIso()]);
    return true;
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) return false;
    throw err;
  }
}

// CONFIRM: applies the valid rows through the real functions, each in its own transaction. Honest counts.
async function confirm(ctx, buffer, fileName, rawKey) {
  const idem = String(rawKey || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(idem)) throw new ImportError(400, 'This import cannot be sent safely. Close the window, open Import again and press Preview, then Confirm.');
  const imp = importOf(ctx.kind, ctx.importKey);
  if (!imp) throw new ImportError(404, 'There is no Import for this page.');
  const parsed = parse(specOf(imp), buffer, fileName); // refuses a bad file before the key is used
  await SCH.ensure();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  let mine = await claim(ctx, idem, fileName, hash);
  if (!mine) {
    const until = Date.now() + 120000;
    while (Date.now() < until && !mine) {
      // eslint-disable-next-line no-await-in-loop
      const row = await DB.one('SELECT * FROM "VendorImportRun" WHERE "vendorUserId" = ? AND "idemKey" = ?', [ctx.v.userId, idem]);
      if (!row) { mine = await claim(ctx, idem, fileName, hash); } // eslint-disable-line no-await-in-loop
      else if (row.state === 'done') {
        let body = null; try { body = JSON.parse(row.resultJson); } catch { body = null; }
        return { status: row.status || 200, body: { ...(body || {}), duplicateRequest: true } };
      } else await sleep(250); // eslint-disable-line no-await-in-loop
    }
    if (!mine) throw new ImportError(409, 'This import is still running. Wait a moment, then look at the list: nothing is saved twice.');
  }
  try {
    const recs = await withLock(ctx.v.vendorId, () => HS.withScopeCache(() => processRows(ctx, imp, parsed.rows, false)));
    const imported = recs.filter((r) => r.outcome === 'ok' && imp.key === 'bills').length;
    const updated = recs.filter((r) => r.outcome === 'ok' && imp.key !== 'bills').length;
    const unchanged = recs.filter((r) => r.outcome === 'unchanged').length;
    const dup = recs.filter((r) => r.outcome === 'duplicate').length;
    const failed = recs.filter((r) => r.outcome === 'error').length;
    const body = {
      importKey: imp.key, title: imp.title, fileName: String(fileName || '').slice(0, 120), total: recs.length, imported, updated, skipped: unchanged, alreadyThere: dup, failed,
      complete: failed === 0, rows: slimRows(recs),
      message: failed === 0
        ? `Done. ${imported + updated} saved${unchanged ? `, ${unchanged} already as they were` : ''}${dup ? `, ${dup} already there` : ''}.`
        : `${imported + updated} saved, ${failed} could not be saved${unchanged ? `, ${unchanged} already as they were` : ''}${dup ? `, ${dup} already there` : ''}. Download the report to see each line. Fix the lines that failed and import the file again: lines already saved are not repeated.`,
    };
    await DB.run('UPDATE "VendorImportRun" SET "state" = ?, "status" = ?, "resultJson" = ?, "finishedAt" = ? WHERE "vendorUserId" = ? AND "idemKey" = ?', ['done', 200, JSON.stringify(body), nowIso(), ctx.v.userId, idem]);
    await VP.auditReq(ctx.req, {
      vendorId: ctx.v.vendorId, vendorUserId: ctx.v.userId, actorName: `${ctx.v.name} (vendor ${ctx.v.vendorName})`, role: 'Vendor', action: 'Import confirmed',
      documentName: String(fileName || '').slice(0, 120), newValue: `${imp.key} · ${recs.length} line(s): ${imported} new, ${updated} updated, ${unchanged} unchanged, ${dup} already there, ${failed} failed`, status: failed ? 'Partly saved' : 'Saved',
    });
    await summaryNotice(ctx, imp, body);
    return { status: 200, body };
  } catch (err) {
    await DB.run('DELETE FROM "VendorImportRun" WHERE "vendorUserId" = ? AND "idemKey" = ? AND "state" = ?', [ctx.v.userId, idem, 'running']).catch(() => {}); // a failed run lets go of its key
    throw err;
  }
}
// ONE bell to the company for the whole file (the single-row screens send one bell per row; an import would drown them).
async function summaryNotice(ctx, imp, body) {
  if (!body.imported && !body.updated) return;
  try {
    const title = `${ctx.v.vendorName}: ${imp.title.replace('Import ', '')} imported from a file`;
    const message = `${ctx.v.vendorName} saved ${body.imported + body.updated} line${body.imported + body.updated === 1 ? '' : 's'} from an Excel / CSV file (${imp.key === 'bills' ? 'bills now waiting for Accounts to check' : 'updates'}).${body.failed ? ` ${body.failed} line(s) were not saved.` : ''}`;
    if (imp.key === 'bills') {
      const list = await require('./vendorConfig').billReviewers(); // eslint-disable-line global-require
      await require('./notify').notifyUsers(list.map((u) => u.id), { title, message }); // eslint-disable-line global-require
    } else {
      await require('./vendorModules').notifyCompany({ creatorId: null, title, message }); // eslint-disable-line global-require
    }
  } catch (e) { console.error('[vendor-import notify]', e && e.message); } // eslint-disable-line no-console
}

module.exports = {
  ImportError, MAX_BYTES, MAX_ROWS, SPECS, KIND_IMPORTS, importsOf, importOf, specOf, sampleFor, preview, confirm, checkFile, parse,
};

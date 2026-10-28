#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BILL IMPORT TAKES EXCEL / CSV TOO (founder 2026-10-28: "pdf, excel, photos adhi upload chesina tisukovali"). NO SERVER, NO DATABASE.
//   cd backend && node scripts/bill-excel-upload-test.js
// Proves: .xlsx / .xls / .csv bills pass the file checks by their real bytes; a PDF renamed .xlsx, a binary renamed .csv, an empty sheet
// and a .xlsm are refused; they are stored only for the bill import (allowSheet) and read back; their cells become the text the AI reads.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-xls-'));
process.env.UPLOAD_DIR = tmp;
const BACK = path.join(__dirname, '..');
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const F = require(path.join(BACK, 'src/utils/billUploadFiles'));
const A = require(path.join(BACK, 'src/utils/attachments'));

let pass = 0; let fail = 0;
const check = (name, ok, info) => { if (ok) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`, info === undefined ? '' : JSON.stringify(info).slice(0, 300)); } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

(async () => {
  try {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Invoice', 'INV-778'], ['Date', '2026-10-20'], ['Item', 'Dell keyboard SN ZZK123', 'Qty', 1, 'Amount', 1500], ['Total', 1770]]), 'Bill');
    const xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const xls = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
    const csv = Buffer.from('Invoice,INV-779\nDate,2026-10-21\nItem,HP mouse,1,450\nTotal,531\n');
    const max = 10 * 1048576;
    const ix = await F.inspect({ filename: 'bill.xlsx', contentType: 'application/octet-stream', data: xlsx }, { maxBytes: max });
    check('X1 an .xlsx bill passes (by its bytes, whatever type the browser sent)', ix.mime === F.SHEETS.xlsx && ix.pages === 1, ix);
    const il = await F.inspect({ filename: 'bill.xls', contentType: 'application/vnd.ms-excel', data: xls }, { maxBytes: max });
    check('X2 an old .xls bill passes', il.mime === F.SHEETS.xls, il);
    const ic = await F.inspect({ filename: 'bill.csv', contentType: 'application/vnd.ms-excel', data: csv }, { maxBytes: max });
    check('X3 a .csv bill passes (Windows sends it as ms-excel)', ic.mime === 'text/csv', ic);
    check('X4 a PDF renamed .xlsx is refused', (await codeOf(F.inspect({ filename: 'x.xlsx', contentType: '', data: Buffer.from('%PDF-1.4 fake') }, { maxBytes: max }))) === 'CONTENT_MISMATCH');
    check('X5 a binary file renamed .csv is refused', (await codeOf(F.inspect({ filename: 'x.csv', contentType: 'text/csv', data: Buffer.from([0, 1, 2, 3, 0, 5, 6, 7, 8, 9, 10, 11, 12]) }, { maxBytes: max }))) === 'CONTENT_MISMATCH');
    check('X6 an empty CSV is refused', (await codeOf(F.inspect({ filename: 'x.csv', contentType: 'text/csv', data: Buffer.from('\n\n') }, { maxBytes: max }))) === 'BAD_SHEET');
    check('X7 a macro file (.xlsm) is refused', (await codeOf(F.inspect({ filename: 'x.xlsm', contentType: '', data: xlsx }, { maxBytes: max }))) !== null);
    // storing: only for a caller that asks
    let refused = null;
    try { A.store({ filename: 'bill.xlsx', contentType: F.SHEETS.xlsx, data: xlsx }); } catch (e) { refused = e.code; }
    check('X8 other uploads of the app still refuse spreadsheets', refused === 'BAD_TYPE', refused);
    const st = A.store({ filename: 'bill.xlsx', contentType: F.SHEETS.xlsx, data: xlsx }, { allowSheet: true });
    const sc = A.store({ filename: 'bill.csv', contentType: 'text/csv', data: csv }, { allowSheet: true });
    check('X9 the bill import stores Excel / CSV and reads them back', /\.xlsx$/.test(st.billFile) && /\.csv$/.test(sc.billFile) && !!A.resolveStored(st.billFile) && !!A.resolveStored(sc.billFile), [st.billFile, sc.billFile]);
    const t1 = F.sheetText(xlsx, F.SHEETS.xlsx);
    const t2 = F.sheetText(csv, 'text/csv');
    check('X10 the cells become the text the AI reads (invoice no., item, serial, total)', /INV-778/.test(t1) && /ZZK123/.test(t1) && /1770/.test(t1) && /INV-779/.test(t2), [t1.slice(0, 120), t2.slice(0, 80)]);
  } catch (err) {
    fail += 1; console.log('  ERROR', err && err.stack);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\nExcel bills: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

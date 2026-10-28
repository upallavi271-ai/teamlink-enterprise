#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BILL IMPORT FROM ANY EXCEL / CSV (founder 2026-10-28: "alanti file upload chesina tisukovali, rules undakudadhu"). NO SERVER, NO DATABASE.
//   cd backend && node scripts/vendor-bill-flex-import-test.js
// Proves utils/vendorBillFlexImport.js reads a messy real file: title lines above the header, other column names in another order, extra
// columns, Indian dates, "Rs. 1,234" amounts, Amount + Total (GST = the difference), a Total line and blank lines skipped, missing bill number /
// month / due date filled from the same line (never invented); .xls and CSV too; the sample file still reads; a file without any amount
// column says so in plain words.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.join(__dirname, '..');
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const FX = require(path.join(BACK, 'src/utils/vendorBillFlexImport'));

let pass = 0; let fail = 0;
const check = (name, ok, info) => { if (ok) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`, info === undefined ? '' : JSON.stringify(info).slice(0, 400)); } };
const book = (aoa, type = 'xlsx') => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1'); return XLSX.write(wb, { type: 'buffer', bookType: type }); };
const TODAY = '2026-10-28';

try {
  const messy = book([
    ['Bharti Airtel Ltd - Statement of bills'],
    ['Account: 1-ABCD'],
    [],
    ['S.No', 'Invoice No.', 'Bill Date', 'Billing Period', 'Due Date', 'Amount (Rs)', 'Total', 'Particulars', 'Circle'],
    [1, 'MF2736I000398195', '05/04/2026', 'Apr 2026', '25-04-2026', 'Rs. 18,750.00', 22125, 'Mobile postpaid', 'AP'],
    [2, 'MF2736I001328039', '05-05-2026', '2026-05', '25 May 2026', 18750, 22125, '', 'AP'],
    [],
    [3, '', '05/06/2026', '', '', '19000', '', 'no number on this line', 'AP'],
    ['', 'Grand Total', '', '', '', 56500, 66250, '', ''],
  ]);
  const r = FX.readAny(messy, 'airtel statement.xlsx', { today: TODAY });
  const L = (no) => r.rows.find((x) => x.billNumber === no);
  check('F1 the header is found below the title lines; extra columns (S.No, Circle) ignored', r.rows.length === 3 && r.header.billNumber === 'Invoice No.' && r.header.amount === 'Amount (Rs)', [r.rows.length, r.header]);
  check('F2 "05/04/2026" (day first), "Apr 2026", "25-04-2026", "Rs. 18,750.00" are read', L('MF2736I000398195') && L('MF2736I000398195').billDate === '2026-04-05' && L('MF2736I000398195').period === '2026-04' && L('MF2736I000398195').dueDate === '2026-04-25' && L('MF2736I000398195').amount === 18750, L('MF2736I000398195'));
  check('F3 Amount + Total on the line: GST is the difference (3375)', L('MF2736I000398195').gst === 3375, L('MF2736I000398195').gst);
  check('F4 "25 May 2026" is a date', L('MF2736I001328039') && L('MF2736I001328039').dueDate === '2026-05-25', L('MF2736I001328039'));
  const noNo = r.rows.find((x) => /^ROW-/.test(x.billNumber));
  check('F5 a line without a bill number is still taken: ROW-<line>, month from its own bill date, no due date (not invented), the note says so', noNo && noNo.period === '2026-06' && noNo.dueDate === null && noNo.notes.includes('no bill number in the file'), noNo);
  check('F6 the Grand Total line and the blank lines are skipped, not errors', !r.rows.some((x) => /total/i.test(x.billNumber)) && r.skipped >= 1, r.skipped);

  const plain = book([['Bill No', 'Date', 'Net Payable'], ['B-1', 46300, 1500], ['B-2', '2026-10-20', '2,000']], 'biff8');
  const p = FX.readAny(plain, 'bills.xls', { today: TODAY });
  check('F7 an old .xls with an Excel day number and "Net Payable" is read; the month comes from the date', p.rows.length === 2 && p.rows[0].billDate === '2026-10-05' && p.rows[0].period === '2026-10' && p.rows[1].amount === 2000, p.rows);

  const csv = Buffer.from('﻿invoice number,invoice date,amount,gst,remarks\nINV-9,2026-10-01,1000,180,Oct\n,,,,\n');
  const c = FX.readAny(csv, 'x.csv', { today: TODAY });
  check('F8 a CSV with lower-case headers is read; blank lines skipped', c.rows.length === 1 && c.rows[0].gst === 180 && c.rows[0].remarks === 'Oct', c.rows);

  const sample = book([['Bill number ✱', 'Billing month ✱', 'Bill date', 'Due date ✱', 'Amount ✱', 'GST', 'Remarks'], ['AIR-1', '2026-10', '2026-10-05', '2026-10-25', 20000, 3600, '']]);
  const s = FX.readAny(sample, 'bills-import-sample.xlsx', { today: TODAY });
  check('F9 the old sample file (with its ✱ headers) still reads', s.rows.length === 1 && s.rows[0].billNumber === 'AIR-1' && s.rows[0].dueDate === '2026-10-25' && s.rows[0].gst === 3600, s.rows);

  const onlyTotal = book([['Bill No', 'Bill date', 'Total'], ['T-1', '2026-10-02', '11800']]);
  const t = FX.readAny(onlyTotal, 't.xlsx', { today: TODAY });
  check('F10 a file with only a Total column: the total is the amount', t.rows.length === 1 && t.rows[0].amount === 11800, t.rows);

  let msg = '';
  try { FX.readAny(book([['Name', 'City'], ['A', 'B']]), 'x.xlsx'); } catch (e) { msg = e.message; }
  check('F11 a file with no amount column at all: a plain message, not a crash', /amount/i.test(msg), msg);
  msg = '';
  try { FX.readAny(Buffer.from('%PDF-1.4'), 'x.pdf'); } catch (e) { msg = e.message; }
  check('F12 a PDF in the Excel import says to choose Excel / CSV', /Excel/.test(msg), msg);
  check('F13 "Bill date (dd/mm/yyyy)" is a bill date, not a bill number', FX.columnsOf(['Bill No', 'Bill date (dd/mm/yyyy)', 'Amount']).billDate === 1, FX.columnsOf(['Bill No', 'Bill date (dd/mm/yyyy)', 'Amount']));
} catch (err) {
  fail += 1; console.log('  ERROR', err && err.stack);
}
console.log(`\nAny-file bill import: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

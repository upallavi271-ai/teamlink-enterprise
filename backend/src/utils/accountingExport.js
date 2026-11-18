// ---------------------------------------------------------------------------
// ACCOUNTING SOFTWARE EXPORT (founder ATS audit, 2026-11-17): the placement invoices shown on Invoices, as a file the
// accounts team imports into
//   Tally       an XML envelope of Sales vouchers (Gateway of Tally -> Import Data -> Vouchers)
//   Zoho Books  the invoice-import CSV (Sales -> Invoices -> Import Invoices)
// File download only: no API keys, nothing is sent anywhere. Built from the Invoices register rows (routes/invoices.js
// buildRegister), so every figure is the one the screen shows. Cancelled invoices are left out.
// Voucher per invoice: party (client) Dr = before GST + GST; fee ledger Cr = before GST; CGST / SGST or IGST Cr.
// TDS is not booked here — the client deducts it when paying (it is in the narration).
// ---------------------------------------------------------------------------

const DEFAULT_LEDGERS = {
  sales: 'Placement Fees', cgst: 'Output CGST', sgst: 'Output SGST', igst: 'Output IGST', gst: 'Output GST',
};
const SAC = '998512'; // permanent placement services
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const amt = (n) => r2(n).toFixed(2);

// XML text: the five entities escaped and the characters XML 1.0 forbids dropped.
function xml(v) {
  return String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
const tallyDate = (d) => String(d || '').slice(0, 10).replace(/-/g, '');
const ledgerName = (v, def) => {
  const s = String(v || '').trim().slice(0, 100);
  return s || def;
};

function ledgersOf(opts = {}) {
  const out = {};
  Object.keys(DEFAULT_LEDGERS).forEach((k) => { out[k] = ledgerName(opts[k], DEFAULT_LEDGERS[k]); });
  return out;
}

// The tax lines of one register row, always adding up to its GST.
function taxLines(r, L) {
  const gst = r2(r.gst);
  if (gst <= 0) return [];
  const c = r2(r.cgst); const s = r2(r.sgst); const i = r2(r.igst);
  if (i > 0 && Math.abs(i - gst) < 0.02) return [[L.igst, gst]];
  if (c > 0 && s > 0 && Math.abs(c + s - gst) < 0.02) return [[L.cgst, c], [L.sgst, r2(gst - c)]];
  return [[L.gst, gst]];
}
const narrationOf = (r) => [
  'Placement fee',
  r.candidateName && `candidate ${r.candidateName}`,
  r.role && `role ${r.role}`,
  r.joiningDate && `joined ${r.joiningDate}`,
  Number(r.tds) > 0 && `TDS ${r.tdsPercent || ''}% ₹${amt(r.tds)} to be deducted by the client`,
].filter(Boolean).join(' · ');

function tallyXml(rows, opts = {}) {
  const L = ledgersOf(opts.ledgers);
  const company = String(opts.company || '').trim().slice(0, 100);
  const live = rows.filter((r) => r.status !== 'Cancelled');
  const vouchers = live.map((r) => {
    const party = String(r.client || 'Unknown client').trim();
    const fee = r2(r.billing);
    const taxes = taxLines(r, L);
    const total = r2(fee + taxes.reduce((a, [, v]) => a + v, 0));
    const line = (name, amount, debit) => [
      '      <ALLLEDGERENTRIES.LIST>',
      `       <LEDGERNAME>${xml(name)}</LEDGERNAME>`,
      `       <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
      `       <ISPARTYLEDGER>${name === party ? 'Yes' : 'No'}</ISPARTYLEDGER>`,
      `       <AMOUNT>${debit ? '-' : ''}${amt(amount)}</AMOUNT>`,
      '      </ALLLEDGERENTRIES.LIST>',
    ].join('\n');
    return [
      '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
      `     <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
      `      <DATE>${tallyDate(r.invoiceDate)}</DATE>`,
      `      <EFFECTIVEDATE>${tallyDate(r.invoiceDate)}</EFFECTIVEDATE>`,
      '      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>',
      `      <VOUCHERNUMBER>${xml(r.invoiceNumber)}</VOUCHERNUMBER>`,
      `      <REFERENCE>${xml(r.invoiceNumber)}</REFERENCE>`,
      `      <PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME>`,
      `      <PARTYNAME>${xml(party)}</PARTYNAME>`,
      r.clientGstin ? `      <PARTYGSTIN>${xml(r.clientGstin)}</PARTYGSTIN>` : null,
      '      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>',
      `      <NARRATION>${xml(narrationOf(r))}</NARRATION>`,
      line(party, total, true),
      line(L.sales, fee, false),
      ...taxes.map(([n, v]) => line(n, v, false)),
      '     </VOUCHER>',
      '    </TALLYMESSAGE>',
    ].filter(Boolean).join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    ' <HEADER>',
    '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
    ' </HEADER>',
    ' <BODY>',
    '  <IMPORTDATA>',
    '   <REQUESTDESC>',
    '    <REPORTNAME>Vouchers</REPORTNAME>',
    company ? `    <STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : null,
    '   </REQUESTDESC>',
    '   <REQUESTDATA>',
    ...vouchers,
    '   </REQUESTDATA>',
    '  </IMPORTDATA>',
    ' </BODY>',
    '</ENVELOPE>',
    '',
  ].filter((x) => x !== null).join('\n');
}

// ---------------------------------------------------------------- Zoho Books
const ZOHO_HEAD = [
  'Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'GST Treatment', 'GST Identification Number (GSTIN)',
  'Place of Supply', 'Currency Code', 'Due Date', 'Item Name', 'Item Desc', 'SAC', 'Quantity', 'Item Price',
  'Item Tax', 'Item Tax %', 'Item Tax Type', 'Is Inclusive Tax', 'TDS Amount', 'Notes',
];
// A CSV cell: quoted when needed; a text cell starting like a formula is made harmless.
function csvCell(v, isText = true) {
  let s = v == null ? '' : String(v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function zohoCsv(rows, opts = {}) {
  const stateOf = typeof opts.stateOf === 'function' ? opts.stateOf : () => '';
  const live = rows.filter((r) => r.status !== 'Cancelled');
  const lines = [ZOHO_HEAD.map((h) => csvCell(h)).join(',')];
  live.forEach((r) => {
    const gstin = String(r.clientGstin || '').trim().toUpperCase();
    const pct = Number(r.gstPercent) || 0;
    const igst = r2(r.igst) > 0;
    const hasTax = r2(r.gst) > 0 && pct > 0;
    // eslint-disable-next-line no-nested-ternary
    const tax = hasTax ? (igst ? `IGST${pct}` : `GST${pct}`) : '';
    const status = /paid/i.test(r.status || '') && !/partial/i.test(r.status || '') ? 'Paid' : 'Sent';
    const cells = [
      [r.invoiceDate || '', false], [r.invoiceNumber, true], [status, true], [r.client, true],
      [gstin ? 'business_gst' : 'consumer', true], [gstin, true], [gstin ? stateOf(gstin) || '' : '', true], ['INR', false],
      [r.dueDate || '', false], ['Placement fee', true], [narrationOf(r), true], [SAC, false], ['1', false], [amt(r.billing), false],
      [tax, true], [hasTax ? String(pct) : '', false], [hasTax ? (igst ? 'Tax' : 'Tax Group') : '', true], ['false', false], [amt(r.tds), false],
      [r.notes || '', true],
    ];
    lines.push(cells.map(([v, t]) => csvCell(v, t)).join(','));
  });
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- receipts (payments)
// The payments recorded on the invoices shown, as Tally RECEIPT vouchers (party Cr, bank / cash Dr) and as the Zoho Books customer-payments CSV.
const BANK_DEFAULT = 'Bank Account';
const CASH_DEFAULT = 'Cash';
const paymentsOf = (rows) => rows.filter((r) => r.status !== 'Cancelled').flatMap((r) => (r.payments || []).filter((p) => Number(p.amount) > 0 && p.date).map((p, i) => ({ r, p, i })));
function tallyReceiptsXml(rows, opts = {}) {
  const company = String(opts.company || '').trim().slice(0, 100);
  const bank = ledgerName(opts.ledgers && opts.ledgers.bank, BANK_DEFAULT);
  const cash = ledgerName(opts.ledgers && opts.ledgers.cash, CASH_DEFAULT);
  const vouchers = paymentsOf(rows).map(({ r, p, i }) => {
    const party = String(r.client || 'Unknown client').trim();
    const deposit = /cash/i.test(p.method || '') ? cash : bank;
    const no = `RCPT-${r.invoiceNumber || r.id}-${i + 1}`;
    const line = (name, amount, debit, isParty) => [
      '      <ALLLEDGERENTRIES.LIST>',
      `       <LEDGERNAME>${xml(name)}</LEDGERNAME>`,
      `       <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
      `       <ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER>`,
      `       <AMOUNT>${debit ? '-' : ''}${amt(amount)}</AMOUNT>`,
      '      </ALLLEDGERENTRIES.LIST>',
    ].join('\n');
    return [
      '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
      '     <VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">',
      `      <DATE>${tallyDate(p.date)}</DATE>`,
      `      <EFFECTIVEDATE>${tallyDate(p.date)}</EFFECTIVEDATE>`,
      '      <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>',
      `      <VOUCHERNUMBER>${xml(no)}</VOUCHERNUMBER>`,
      `      <REFERENCE>${xml(p.reference || r.invoiceNumber || '')}</REFERENCE>`,
      `      <PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME>`,
      '      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>',
      `      <NARRATION>${xml(`Receipt against invoice ${r.invoiceNumber || ''} (${p.method || 'Bank Transfer'}${p.reference ? `, ref ${p.reference}` : ''})`)}</NARRATION>`,
      line(deposit, p.amount, true, false),
      line(party, p.amount, false, true),
      '     </VOUCHER>',
      '    </TALLYMESSAGE>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<ENVELOPE>', ' <HEADER>', '  <TALLYREQUEST>Import Data</TALLYREQUEST>', ' </HEADER>', ' <BODY>', '  <IMPORTDATA>', '   <REQUESTDESC>', '    <REPORTNAME>Vouchers</REPORTNAME>',
    company ? `    <STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : null,
    '   </REQUESTDESC>', '   <REQUESTDATA>', ...vouchers, '   </REQUESTDATA>', '  </IMPORTDATA>', ' </BODY>', '</ENVELOPE>', '',
  ].filter((x) => x !== null).join('\n');
}
const ZOHO_PAY_HEAD = ['Payment Date', 'Payment Number', 'Customer Name', 'Payment Mode', 'Amount', 'Reference#', 'Invoice Number', 'Amount Applied to Invoice', 'Deposit To', 'Notes'];
function zohoPaymentsCsv(rows, opts = {}) {
  const lines = [ZOHO_PAY_HEAD.map((h) => csvCell(h)).join(',')];
  paymentsOf(rows).forEach(({ r, p, i }) => {
    const mode = /cash/i.test(p.method || '') ? 'Cash' : (/cheque|check/i.test(p.method || '') ? 'Check' : 'Bank Transfer');
    const cells = [[p.date, false], [`PAY-${r.invoiceNumber || r.id}-${i + 1}`, true], [r.client, true], [mode, true], [amt(p.amount), false], [p.reference || '', true], [r.invoiceNumber, true], [amt(p.amount), false], [mode === 'Cash' ? 'Petty Cash' : (opts.depositTo || 'Bank'), true], [`Recorded in TeamLink${p.recordedBy ? ` by ${p.recordedBy}` : ''}`, true]];
    lines.push(cells.map(([v, t]) => csvCell(v, t)).join(','));
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = {
  tallyReceiptsXml, zohoPaymentsCsv, ZOHO_PAY_HEAD, tallyXml, zohoCsv, DEFAULT_LEDGERS, ZOHO_HEAD, xml, csvCell, taxLines, ledgersOf,
};

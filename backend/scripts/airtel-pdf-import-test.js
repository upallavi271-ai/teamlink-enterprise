#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AIRTEL BILLS PORTAL - "IMPORT BILLS" FROM THE AIRTEL PDF BILL (founder 2026-10-28: "aa file upload chesina adhi tisukovali"). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/airtel-pdf-import-test.js
// A PDF like Airtel's (made here with pdfkit: two bills, the first over two pages, labels and values on the same or the next line) goes
// through the real vendor login and the real import (preview -> confirm). Proves:
//   P1 preview reads BOTH bills: bill number, period (from the bill period), due date, amount before GST and GST, nothing saved yet
//   P2 confirm sends both to Accounts as monthly bills with the PDF attached as each bill's copy
//   P3 the same PDF again: both "already there", nothing new
//   P4 a scanned PDF (no text) with AI reading off: a plain message, nothing saved
//   P5 a PDF that is not a bill: a plain message, nothing saved
//   P6 the reader alone: CGST + SGST added, IGST used, total without GST -> GST 0 with a note; never a guessed bill number
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const Z = require('./lib/zzfix')('APDF');

const pdfOf = (draw) => new Promise((resolve) => {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const parts = [];
  doc.on('data', (b) => parts.push(b));
  doc.on('end', () => resolve(Buffer.concat(parts)));
  draw(doc);
  doc.end();
});

(async () => {
  const { prisma } = Z;
  const made = { vendors: [], vusers: [] };
  try {
    const R = Z.RUN.toUpperCase();
    const PDF = require('../src/utils/vendorBillPdfImport'); // eslint-disable-line global-require
    // P6 - the reader on its own
    const t1 = PDF.billFrom(`Bill No. : XB${R}1\nBill Date: 05/10/2026\nBilling Cycle 05 Sep 2026 to 04 Oct 2026\nCGST @9% 90.00\nSGST @ 9% 90.00\nTotal Amount Payable\nRs. 1,180.00`, 1, '2026-10-28');
    const t2 = PDF.billFrom(`Invoice Number: XB${R}2\nInvoice Date 01-Oct-2026\nIGST 18% 36.00\nAmount Due 236.00`, 1, '2026-10-28');
    const t3 = PDF.billFrom(`Bill No: XB${R}3\nBill Date 01-Oct-2026\nTotal Amount Payable Rs 500.00`, 1, '2026-10-28');
    const t4 = PDF.billFrom('Bill Date 01-Oct-2026\nTotal Amount Payable Rs 500.00', 1, '2026-10-28');
    Z.check('P6 reader: CGST + SGST added (1,000 + 180), IGST used (200 + 36), no GST -> 500 + 0 with a note, no bill number -> no bill', t1 && t1.amount === 1000 && t1.gst === 180 && t1.period === '2026-10' && t1.billDate === '2026-10-05'
      && t2 && t2.amount === 200 && t2.gst === 36 && t3 && t3.amount === 500 && t3.gst === 0 && t3.notes.some((n) => /GST not found/.test(n)) && t4 === null, [t1, t2, t3, t4]);

    // an Airtel vendor login with "Send a bill"
    const v = await prisma.officeVendor.create({ data: { name: `ZZTEST APDF Airtel Mobile ${Z.RUN}`, companyName: 'ZZTEST APDF Airtel', isActive: true } });
    made.vendors.push(v.id);
    const pw = `Qv#7pdf${Z.RUN}Lm!9`;
    const u = await prisma.vendorUser.create({ data: { vendorId: v.id, name: 'ZZTEST APDF contact', email: `zz-apdf-${Z.RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit: false, canViewCost: false } });
    made.vusers.push(u.id);
    const nowMs = Date.now();
    await prisma.$executeRawUnsafe('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzapdf${u.id}`.slice(0, 44), u.id, 'airtel_bills', JSON.stringify({ sendBill: true }), nowMs, nowMs);
    const login = await Z.call('POST', '/api/vendor-portal/login', null, { email: u.email, password: pw });
    const tok = login.body && login.body.token;
    if (!tok) throw new Error(`vendor login failed: ${login.status} ${JSON.stringify(login.body).slice(0, 200)}`);
    const send = async (kind, buf, name, key) => {
      const h = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': `10.6.${Math.floor(Math.random() * 250)}.1` };
      if (key) h['Idempotency-Key'] = key;
      const r = await fetch(`${Z.API}/api/vendor-portal/vendor-io/import/bills/${kind}?fileName=${encodeURIComponent(name)}`, { method: 'POST', headers: h, body: buf });
      let body = null; try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    };
    const billsOf = () => prisma.$queryRawUnsafe('SELECT "billNumber","period","dueDate","amount","gst","total","documentFile","documentMime","documentName","status" FROM "VendorModuleBill" WHERE "vendorId" = ? ORDER BY "billNumber"', v.id);

    // the PDF: bill A over pages 1-2 (value under its label), bill B on page 3
    const pdf = await pdfOf((d) => {
      d.fontSize(14).text('Bharti Airtel Limited');
      d.fontSize(10).text('Postpaid Bill');
      d.text(`Bill No.: AB${R}10`);
      d.text('Bill Date: 05-Oct-2026');
      d.text('Bill Period: 05-Sep-2026 to 04-Oct-2026');
      d.text('Account No.: 1234567890');
      d.text('Mobile No.: 98480 12345');
      d.text('Due Date');
      d.text('25-Oct-2026');
      d.addPage();
      d.text('Usage details continued');
      d.text('CGST @ 9% 900.00');
      d.text('SGST @ 9% 900.00');
      d.text('Total Amount Payable');
      d.text('Rs. 11,800.00');
      d.addPage();
      d.text('Bharti Airtel Limited');
      d.text(`Bill No.: AB${R}09`);
      d.text('Bill Date: 05-Sep-2026');
      d.text('Bill Period: 05-Aug-2026 to 04-Sep-2026');
      d.text('Pay by: 25-Sep-2026');
      d.text('IGST @ 18% 360.00');
      d.text('Amount Due Rs. 2,360.00');
    });
    const p = await send('preview', pdf, 'airtel-bill-oct.pdf');
    const okRows = p.body && p.body.rows ? p.body.rows.filter((r) => r.outcome === 'ok') : [];
    Z.check('P1 preview reads both bills from the PDF (number, period, due date, amount + GST); nothing saved yet', p.status === 200 && p.body.willChange === 2 && okRows.some((r) => r.message.includes(`AB${R}10`) && r.message.includes('2026-10') && r.message.includes('10000') && r.message.includes('1800') && r.message.includes('2026-10-25'))
      && okRows.some((r) => r.message.includes(`AB${R}09`) && r.message.includes('2026-09') && r.message.includes('2000') && r.message.includes('360') && r.message.includes('2026-09-25')) && (await billsOf()).length === 0, [p.status, p.body && (p.body.rows || p.body.error)]);

    const c = await send('confirm', pdf, 'airtel-bill-oct.pdf', `zzapdf${Z.RUN}a`);
    const bills = await billsOf();
    const A = bills.find((b) => b.billNumber === `AB${R}10`); const B = bills.find((b) => b.billNumber === `AB${R}09`);
    Z.check('P2 confirm: both sent to Accounts as monthly bills with the PDF attached as each one\'s copy', c.status === 200 && c.body.imported === 2 && bills.length === 2 && A && B
      && A.period === '2026-10' && Number(A.amount) === 10000 && Number(A.gst) === 1800 && A.dueDate === '2026-10-25' && B.period === '2026-09' && Number(B.total) === 2360
      && bills.every((b) => b.documentFile && b.documentMime === 'application/pdf' && /\.pdf$/i.test(b.documentName)), [c.status, c.body && c.body.message, bills]);

    const again = await send('confirm', pdf, 'airtel-bill-oct.pdf', `zzapdf${Z.RUN}b`);
    Z.check('P3 the same PDF again: both "already there", nothing new', again.status === 200 && again.body.imported === 0 && again.body.alreadyThere === 2 && (await billsOf()).length === 2, [again.status, again.body && again.body.message]);

    const scan = await pdfOf((d) => { d.rect(40, 40, 300, 200).fill('#888888'); });
    const s = await send('preview', scan, 'scan.pdf');
    Z.check('P4 a scanned PDF (no text) with AI reading off: a plain message, nothing saved', s.status === 400 && /scanned/i.test(s.body && s.body.error) && (await billsOf()).length === 2, [s.status, s.body]);
    const other = await pdfOf((d) => { d.text('Minutes of the meeting held on 5 October. Attendees: the team. Nothing about money here at all.'); });
    const o = await send('preview', other, 'minutes.pdf');
    Z.check('P5 a PDF that is not a bill: a plain message, nothing saved', o.status === 400 && /No bill could be read/i.test(o.body && o.body.error) && (await billsOf()).length === 2, [o.status, o.body]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      for (const id of made.vendors) {
        // eslint-disable-next-line no-await-in-loop
        for (const sql of ['DELETE FROM "VendorModuleBill" WHERE "vendorId" = ?', 'DELETE FROM "AssetAuditLog" WHERE "vendorId" = ?']) await prisma.$executeRawUnsafe(sql, id).catch(() => {});
      }
      for (const id of made.vusers) {
        // eslint-disable-next-line no-await-in-loop
        for (const sql of ['DELETE FROM "VendorImportRun" WHERE "vendorUserId" = ?', 'DELETE FROM "VendorLoginModule" WHERE "vendorUserId" = ?', 'DELETE FROM "VendorSession" WHERE "vendorUserId" = ?']) await prisma.$executeRawUnsafe(sql, id).catch(() => {});
      }
      await prisma.vendorUser.deleteMany({ where: { id: { in: made.vusers } } });
      await prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } });
    } catch (e) { console.log('cleanup failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();

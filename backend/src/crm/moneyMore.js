// ---------------------------------------------------------------------------
// THE CRM MONEY GAPS (2026-11-26, "crm lo kaani ... inka em ayina pending vuntey ... implement cheyyu"). All in the CRM's own raw-SQL tables
// (crm/schema.js) - never the ATS Accounts Invoice / Client. What is here:
//   RECEIPTS      every payment line gets a receipt (PDF, its own number RCT-0001 given the first time it is made): download, email it with the PDF
//                 attached, or WhatsApp click-to-chat with a signed link (30 days, no login). TeamLink sends nothing on WhatsApp: the person presses Send.
//   CREDIT / DEBIT NOTES on a Sent invoice (a Sales manager / Admin, with a reason): CN-0001 / DN-0001, the value before GST + GST at the invoice's own
//                 rate, a PDF each. The printed invoice total never changes; the balance and Paid / Partly paid follow the notes (service.netTotalOf).
//                 A credit note is at most what is still unpaid (money already received goes back as a refund, outside TeamLink); crediting the whole
//                 of an unpaid invoice is a Cancel instead. A note can be cancelled (with the same limits).
//   REPEATING INVOICES  an invoice repeats every month / quarter / year: the next one is made as a DRAFT on its date (copy of the lines and the
//                 customer), the owner gets a bell, a person checks and sends it. OFF by default: nothing is made by itself until a Sales manager
//                 turns "Repeating invoices" on; "Make the next one now" always works by hand.
//   COMMISSION    a % per salesperson (or one % for all) on the money COLLECTED in a month (the value before GST of each payment line on their
//                 invoices). The monthly statement is worked out live; a Sales manager approves a finished month (the figures are then frozen),
//                 then marks it paid. A salesperson sees only their own.
//   SLA HOURS     how many hours a support ticket has, per priority (were fixed at 4 / 24 / 48 / 120) - crm/support.js reads them from here.
// Settings: one AppSetting row, crm.moneyMore.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const KEY = 'crm.moneyMore';
const cents = (n) => Math.round(Number(n || 0) * 100) / 100;
const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const DEFAULTS = {
  recurringOn: false,
  commission: { percent: 0, byUser: {} },
  slaHours: { Urgent: 4, High: 24, Medium: 48, Low: 120 },
};

// ---- settings ------------------------------------------------------------------------------------------------------
let cache = null; let cacheAt = 0;
function clean(raw = {}) {
  const c = raw.commission || {};
  const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 50 ? Math.round(n * 100) / 100 : null; };
  const byUser = {};
  Object.entries(c.byUser || {}).forEach(([k, v]) => { const n = pct(v); if (n != null && /^[\w-]{1,60}$/.test(k)) byUser[k] = n; });
  const sla = {};
  PRIORITIES.forEach((p) => { const h = Number((raw.slaHours || {})[p]); sla[p] = Number.isFinite(h) && h >= 1 && h <= 720 ? Math.round(h) : DEFAULTS.slaHours[p]; });
  return { recurringOn: raw.recurringOn === true, commission: { percent: pct(c.percent) || 0, byUser }, slaHours: sla };
}
async function load({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let v = {}; try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  cache = clean(v); cacheAt = Date.now();
  return cache;
}
const current = () => cache || clean({});
async function slaHours() { return (await load()).slaHours; }
const onlyManagers = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'Only a Sales manager or an Admin can change this.'));
async function getSettings(user) {
  const st = await load({ fresh: true });
  const r = S.roleOf(user);
  // a salesperson sees their own commission % only
  if (!S.mayAssign(r)) return S.okBody({ settings: { recurringOn: st.recurringOn, slaHours: st.slaHours, commission: { percent: percentOf(st, user.id) } }, canChange: false });
  return S.okBody({ settings: st, canChange: true, team: (await S.ownerOptions()).map((o) => ({ id: o.id, name: o.name })) });
}
async function saveSettings(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const cur = await load({ fresh: true });
  if (body.slaHours) {
    for (const p of PRIORITIES) {
      const h = Number(body.slaHours[p]);
      if (body.slaHours[p] !== undefined && !(Number.isFinite(h) && h >= 1 && h <= 720)) return S.fail(400, `The ${p} SLA is between 1 and 720 hours.`);
    }
  }
  if (body.commission) {
    const all = [body.commission.percent, ...Object.values(body.commission.byUser || {})].filter((v) => v !== undefined && v !== null && v !== '');
    if (all.some((v) => !(Number(v) >= 0 && Number(v) <= 50))) return S.fail(400, 'A commission % is between 0 and 50.');
  }
  const next = clean({ ...cur, ...body, commission: body.commission ? { ...cur.commission, ...body.commission } : cur.commission, slaHours: { ...cur.slaHours, ...(body.slaHours || {}) } });
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  cache = next; cacheAt = Date.now();
  const changed = [];
  if (next.recurringOn !== cur.recurringOn) changed.push(`repeating invoices ${next.recurringOn ? 'on' : 'off'}`);
  if (JSON.stringify(next.commission) !== JSON.stringify(cur.commission)) changed.push('commission %');
  if (JSON.stringify(next.slaHours) !== JSON.stringify(cur.slaHours)) changed.push(`SLA hours ${PRIORITIES.map((p) => `${p} ${next.slaHours[p]}h`).join(', ')}`);
  if (changed.length) await S.audit(user, 'CRM money settings changed', 'AppSetting', KEY, changed.join('; '));
  return S.okBody({ ok: true, settings: next });
}

// ---- small pieces --------------------------------------------------------------------------------------------------
const inr = (v) => `Rs. ${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (ymd) => (ymd ? new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '-');
const parse = (j) => { try { return j ? JSON.parse(j) : {}; } catch { return {}; } };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function upTo99(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function upTo999(n) { const h = Math.floor(n / 100); const r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r ? upTo99(r) : ''].filter(Boolean).join(' '); }
/** 123456.5 -> "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only" (the Indian way: crore, lakh, thousand) */
function rupeesInWords(v) {
  const total = Math.round(Math.abs(Number(v) || 0) * 100);
  let n = Math.floor(total / 100); const paise = total % 100;
  if (n === 0 && paise === 0) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${crore > 999 ? String(crore) : upTo999(crore)} Crore`);
  if (lakh) parts.push(`${upTo99(lakh)} Lakh`);
  if (thousand) parts.push(`${upTo99(thousand)} Thousand`);
  if (n) parts.push(upTo999(n));
  return `Rupees ${parts.join(' ') || 'Zero'}${paise ? ` and ${upTo99(paise)} Paise` : ''} Only`;
}
async function invoiceRow(user, id, { edit = false, manager = false } = {}) {
  const r = S.roleOf(user);
  const row = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!row || !S.canSeeRow(user, r, row)) return { err: S.fail(404, 'This invoice is not there.') };
  if (edit && !S.canEditRow(user, r, row)) return { err: S.fail(403, 'You cannot change this invoice.') };
  if (manager && !S.mayAssign(r)) return { err: S.fail(403, 'A credit / debit note is issued by a Sales manager or an Admin.') };
  return { row };
}
async function note(row, subject, text, user) {
  const now = DB.nowIso();
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject, note: text || null, at: now, dealId: row.dealId || null, accountId: row.accountId || null, byId: user ? user.id : null, byName: user ? user.name || null : 'TeamLink', createdAt: now }).catch(() => null);
}
// one PDF page in the CRM's own look (logo + colour from CRM branding, else TeamLink's) - receipts and notes
async function pdfDoc(title, draw) {
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { LOGO } = require('../utils/agreementPdf'); // eslint-disable-line global-require
  const fs = require('fs'); // eslint-disable-line global-require
  const BR = require('./plus/admin').brandSync(); // eslint-disable-line global-require
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: 'TeamLink Consultants' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const logo = BR.logoPath && fs.existsSync(BR.logoPath) ? BR.logoPath : (fs.existsSync(LOGO) ? LOGO : null);
    if (logo) { try { doc.image(logo, 50, 40, { height: 28 }); } catch { /* optional */ } }
    draw(doc, { W: doc.page.width - 100, NAVY: BR.color || '#1b2a4a', MUTED: '#5b6474' });
    doc.end();
  });
}
function partyBlock(doc, x, y, w, label, o, MUTED) {
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text(label, x, y);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(o.name || '-', x, y + 14, { width: w });
  doc.font('Helvetica').fontSize(9.5).fillColor('#333').text([o.address, o.state, o.gstin ? `GSTIN: ${o.gstin}` : '', o.email, o.phone].filter(Boolean).join('\n'), x, doc.y, { width: w });
  return doc.y;
}
function sumLine(doc, W, y, label, v, { bold = false, NAVY = '#1b2a4a' } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10.5).fillColor(bold ? NAVY : '#222').text(label, 50 + W - 280, y, { width: 170 }).text(inr(v), 50 + W - 110, y, { width: 110, align: 'right' });
  return y + (bold ? 20 : 16);
}

// signed links a customer opens without a login (same scheme as the invoice link, its own purpose word so one can never open the other)
const secret = () => String(process.env.JWT_SECRET || 'teamlink-crm');
const sigOf = (purpose, v) => crypto.createHmac('sha256', secret()).update(`crm-${purpose}-link:${v}`).digest('base64url').slice(0, 24);
function tokenFor(purpose, id, days = 30) {
  const body = `${id}.${Math.floor(Date.now() / 1000) + days * 86400}`;
  return `${Buffer.from(body).toString('base64url')}.${sigOf(purpose, body)}`;
}
function idOfToken(purpose, token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  let body = ''; try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const a = Buffer.from(sigOf(purpose, body)); const c = Buffer.from(sig);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  const [id, exp] = body.split('.');
  return id && Number(exp) > Math.floor(Date.now() / 1000) ? id : null;
}
async function customerContact(inv) {
  const billTo = parse(inv.billToJson);
  let email = String(billTo.email || '').trim(); let phone = billTo.phone || ''; let name = '';
  if (inv.accountId) {
    const ct = await DB.one('SELECT "name", "email", "phone" FROM "CrmContact" WHERE "accountId" = ? ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 WHEN \'HR\' THEN 1 ELSE 2 END LIMIT 1', inv.accountId).catch(() => null);
    if (ct) { name = ct.name || ''; if (!email) email = String(ct.email || '').trim(); if (!phone) phone = ct.phone || ''; }
  }
  return { billTo, email, phone, name };
}
async function sendPdfMail(user, { to, cc, subject, text, pdf, filename, personName, purpose }) {
  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
  const addr = S.clip(to, 200);
  if (!addr || !EMAIL_RE.test(addr)) return S.fail(400, addr ? 'That email address does not look right.' : 'Write the customer\'s email address in the To box.');
  const ccList = [...new Set(String(cc || '').split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean))].filter((v) => v.toLowerCase() !== addr.toLowerCase());
  if (ccList.length > 5 || ccList.some((v) => !EMAIL_RE.test(v))) return S.fail(400, 'At most 5 CC addresses, each a real email address.');
  if (await require('./campaigns').optedOut('email', addr).catch(() => false)) return S.fail(409, 'This address asked not to be emailed (unsubscribed). TeamLink does not send to it.'); // eslint-disable-line global-require
  const own = await require('../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
  const result = await require('../utils/messaging').send('Email', { // eslint-disable-line global-require
    to: addr, cc: ccList, subject: S.clip(subject, 200), text: S.clip(text, 4000), senderEmail: own.email || undefined, senderName: own.name || user.name, actorUserId: user.id,
    attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
    meta: { audience: 'crm', personName: personName || '', senderUserId: user.id, senderName: user.name, purpose },
  });
  if (!result.ok) {
    if (result.notConfigured) return S.fail(409, `Email is not set up yet, so nothing was sent. Connect it in Administration > Integrations > Email (${result.error}). You can download the PDF and send it yourself.`, { notConfigured: true });
    return S.fail(result.invalid || result.creditsBlocked || result.reserved ? 400 : 502, `The email was not sent: ${result.error || 'unknown problem'}`);
  }
  return { ok: true, to: addr, cc: ccList };
}

// ==================================================================================================== RECEIPTS
async function paymentOf(user, invoiceId, paymentId, { signed = false } = {}) {
  let row;
  if (signed) row = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(invoiceId, 60));
  else { const got = await invoiceRow(user, invoiceId); if (got.err) return got; row = got.row; }
  if (!row) return { err: S.fail(404, 'This invoice is not there.') };
  const pay = await DB.one('SELECT * FROM "CrmPayment" WHERE "id" = ? AND "invoiceId" = ?', S.clip(paymentId, 60), row.id);
  if (!pay) return { err: S.fail(404, 'This payment is not there.') };
  return { row, pay };
}
// the receipt number: RCT-0001, RCT-0002 ... given once, the first time the receipt is made (a deleted line never frees its number)
async function receiptNoOf(pay) {
  if (pay.receiptNo) return pay.receiptNo;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const top = await DB.one('SELECT MAX(CAST(SUBSTR("receiptNo", 5) AS INTEGER)) AS "n" FROM "CrmPayment" WHERE "receiptNo" LIKE \'RCT-%\'');
    const no = `RCT-${String((Number(top && top.n) || 0) + 1 + i).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = await DB.one('SELECT 1 AS "x" FROM "CrmPayment" WHERE "receiptNo" = ?', no);
    if (!taken) {
      // eslint-disable-next-line no-await-in-loop
      const n = await DB.run('UPDATE "CrmPayment" SET "receiptNo" = ? WHERE "id" = ? AND "receiptNo" IS NULL', no, pay.id);
      if (Number(n) === 1) return no;
      // eslint-disable-next-line no-await-in-loop
      const again = await DB.one('SELECT "receiptNo" FROM "CrmPayment" WHERE "id" = ?', pay.id);
      if (again && again.receiptNo) return again.receiptNo;
    }
  }
  throw new Error('No receipt number could be given. Try again.');
}
async function receiptPdf(user, invoiceId, paymentId, { signed = false } = {}) {
  const got = await paymentOf(user, invoiceId, paymentId, { signed });
  if (got.err) return got.err;
  const { row, pay } = got;
  await SETTINGS.load().catch(() => null);
  const no = await receiptNoOf(pay);
  const inv = S.invoiceOut(row);
  const pays = await S.paymentsOf(row.id);
  // what was still owed right after THIS line (the lines in the order they came)
  let settledTill = 0;
  for (const p of pays) { settledTill += Number(p.amount || 0) + Number(p.tdsAmount || 0); if (p.id === pay.id) break; }
  const after = cents(Math.max(0, inv.netTotal - settledTill));
  const pdf = await pdfDoc(`Receipt ${no}`, (doc, { W, NAVY, MUTED }) => {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text('PAYMENT RECEIPT', 50, 40, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(no, { width: W, align: 'right' }).text(`Date: ${longDate(pay.paidOn)}`, { width: W, align: 'right' });
    doc.moveDown(2);
    const top = doc.y;
    const l = partyBlock(doc, 50, top, 240, 'FROM', inv.from, MUTED);
    const r = partyBlock(doc, 310, top, 235, 'RECEIVED FROM', { ...inv.billTo, name: inv.billTo.name || inv.accountName }, MUTED);
    let y = Math.max(l, r) + 22;
    doc.font('Helvetica').fontSize(11).fillColor('#222').text(`Received with thanks ${inr(pay.amount)} (${rupeesInWords(pay.amount)})`, 50, y, { width: W });
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(10.5).fillColor('#333').text(`against invoice ${inv.code || ''} dated ${longDate(inv.issueDate)}, by ${pay.mode || 'payment'}${pay.reference ? ` (ref. ${pay.reference})` : ''}.`, 50, y, { width: W });
    y = doc.y + 18;
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#d9dee8').stroke(); y += 10;
    y = sumLine(doc, W, y, 'Amount received', pay.amount);
    if (Number(pay.tdsAmount) > 0) y = sumLine(doc, W, y, `TDS deducted by you${pay.tdsPercent ? ` (${pay.tdsPercent}%)` : ''}`, pay.tdsAmount);
    if (Number(pay.tdsAmount) > 0) y = sumLine(doc, W, y, 'Settled on the invoice', cents(Number(pay.amount) + Number(pay.tdsAmount)), { bold: true, NAVY });
    y += 6;
    y = sumLine(doc, W, y, `Invoice ${inv.code || ''} total`, inv.netTotal);
    y = sumLine(doc, W, y, 'Balance after this payment', after, { bold: true, NAVY });
    if (pay.tdsRef) { doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`TDS certificate / reference: ${pay.tdsRef}`, 50, y + 4, { width: W }); y = doc.y; }
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('This is a computer-generated receipt and needs no signature.', 50, y + 30, { width: W });
  });
  return { status: 200, pdf, name: `${no}.pdf`, receiptNo: no };
}
async function shareReceipt(user, invoiceId, paymentId, req) {
  const got = await paymentOf(user, invoiceId, paymentId);
  if (got.err) return got.err;
  const { row, pay } = got;
  if (!S.canEditRow(user, S.roleOf(user), row)) return S.fail(403, 'You cannot send this receipt.');
  const no = await receiptNoOf(pay);
  const c = await customerContact(row);
  const W = require('../utils/waLink'); // eslint-disable-line global-require
  const number = W.cleanNumber(c.phone);
  const url = `${require('../utils/offerLink').publicBase(req)}/api/crm-public/receipt/${tokenFor('receipt', pay.id)}`; // eslint-disable-line global-require
  const text = [`Hello${c.name ? ` ${String(c.name).split(/\s+/)[0]}` : ''},`, `Thank you for your payment of ${inr(pay.amount)} on ${longDate(pay.paidOn)} against invoice ${row.code || ''}.`, `Your receipt ${no} (PDF): ${url}`, 'Thank you.'].join('\n');
  await note(row, `Receipt ${no} sent on WhatsApp (link opened)`, number.valid ? `to ${number.digits}` : 'no number on the customer: the person picked the chat', user);
  await S.audit(user, 'CRM receipt shared on WhatsApp', 'CrmPayment', pay.id, `${no} for ${row.code || row.id}`);
  return S.okBody({ ok: true, url, waUrl: `https://wa.me/${number.valid ? number.digits : ''}?text=${encodeURIComponent(text)}`, text, number: number.valid ? number.digits : null, receiptNo: no });
}
async function receiptMailDraft(user, invoiceId, paymentId) {
  const got = await paymentOf(user, invoiceId, paymentId);
  if (got.err) return got.err;
  const { row, pay } = got;
  const c = await customerContact(row);
  const from = parse(row.fromJson);
  return S.okBody({
    ok: true, to: c.email, cc: '', subject: `Payment receipt for invoice ${row.code || ''} from ${from.name || 'TeamLink Consultants'}`,
    text: [`Dear ${c.name ? String(c.name).split(/\s+/)[0] : (c.billTo.name || 'Sir / Madam')},`, '', `Thank you for your payment of ${inr(pay.amount)} on ${longDate(pay.paidOn)} against invoice ${row.code || ''}. The receipt is attached.`, '', 'Regards,'].join('\n'),
  });
}
async function emailReceipt(user, invoiceId, paymentId, body = {}) {
  const got = await paymentOf(user, invoiceId, paymentId);
  if (got.err) return got.err;
  const { row, pay } = got;
  if (!S.canEditRow(user, S.roleOf(user), row)) return S.fail(403, 'You cannot send this receipt.');
  if (!S.clip(body.subject, 200) || !S.clip(body.text, 4000)) return S.fail(400, 'Write the subject and the message.');
  const out = await receiptPdf(user, row.id, pay.id);
  if (!out.pdf) return out;
  const sent = await sendPdfMail(user, { ...body, pdf: out.pdf, filename: out.name, personName: row.accountName, purpose: 'CRM payment receipt' });
  if (!sent.ok) return sent;
  await note(row, `Receipt ${out.receiptNo} emailed`, `To ${sent.to}${sent.cc.length ? `\nCC ${sent.cc.join(', ')}` : ''}`, user);
  await S.audit(user, 'CRM receipt emailed', 'CrmPayment', pay.id, `${out.receiptNo} to ${sent.to}`);
  return S.okBody({ ok: true, to: sent.to, receiptNo: out.receiptNo });
}

// ==================================================================================================== CREDIT / DEBIT NOTES
const KIND = { credit: { prefix: 'CN', word: 'Credit note', pdf: 'CREDIT NOTE' }, debit: { prefix: 'DN', word: 'Debit note', pdf: 'DEBIT NOTE' } };
const noteOut = (n) => ({ id: n.id, kind: n.kind, code: n.code, noteDate: n.noteDate, reason: n.reason, amount: n.amount, taxPercent: n.taxPercent, taxAmount: n.taxAmount, total: n.total, status: n.status, byName: n.createdByName, cancelledByName: n.cancelledByName || null, createdAt: n.createdAt });
async function notesOf(user, invoiceId) {
  const got = await invoiceRow(user, invoiceId);
  if (got.err) return got.err;
  const rows = await DB.all('SELECT * FROM "CrmInvoiceNote" WHERE "invoiceId" = ? ORDER BY "createdAt" ASC', got.row.id);
  return S.okBody({ notes: rows.map(noteOut), canIssue: S.mayAssign(S.roleOf(user)) && S.canEditRow(user, S.roleOf(user), got.row) && ['Sent', 'Partly paid', 'Paid'].includes(got.row.status) });
}
// the invoice follows its notes: credit / debit totals, then Paid / Partly paid again (service.settleInvoice)
async function recount(invoiceId) {
  const s = await DB.one('SELECT COALESCE(SUM(CASE WHEN "kind" = \'credit\' THEN "total" ELSE 0 END), 0) AS "cr", COALESCE(SUM(CASE WHEN "kind" = \'debit\' THEN "total" ELSE 0 END), 0) AS "dr" FROM "CrmInvoiceNote" WHERE "invoiceId" = ? AND "status" = \'Issued\'', invoiceId);
  await S.update('CrmInvoice', invoiceId, { creditAmount: cents(s.cr), debitAmount: cents(s.dr), updatedAt: DB.nowIso() });
  const fresh = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', invoiceId);
  return S.settleInvoice(fresh);
}
async function addNote(user, invoiceId, body = {}) {
  const got = await invoiceRow(user, invoiceId, { edit: true, manager: true });
  if (got.err) return got.err;
  const row = got.row;
  const kind = String(body.kind || '');
  if (!KIND[kind]) return S.fail(400, 'Pick a credit note or a debit note.');
  if (!['Sent', 'Partly paid', 'Paid'].includes(row.status)) return S.fail(400, row.status === 'Draft' ? 'This invoice is still a Draft: change the invoice itself instead.' : 'This invoice is cancelled.');
  const amount = cents(S.num(body.amount));
  if (!(amount > 0)) return S.fail(400, 'Write the value before GST.');
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 3) return S.fail(400, 'Write the reason (it is printed on the note).');
  const noteDate = body.noteDate ? String(body.noteDate).slice(0, 10) : S.istToday();
  if (!YMD.test(noteDate) || Number.isNaN(Date.parse(noteDate))) return S.fail(400, 'Write the date like 2026-11-26.');
  if (noteDate > S.istToday()) return S.fail(400, 'The note date cannot be in the future.');
  if (noteDate < row.issueDate) return S.fail(400, 'The note date cannot be before the invoice date.');
  const taxPercent = Number(row.taxPercent) || 0;
  const taxAmount = cents((amount * taxPercent) / 100);
  const total = cents(amount + taxAmount);
  const inv = S.invoiceOut(row);
  if (kind === 'credit') {
    const settled = cents(Number(row.paidAmount || 0) + Number(row.tdsAmount || 0));
    if (settled <= 0.004 && total >= inv.netTotal - 0.004) return S.fail(400, 'That credits the whole invoice and nothing is received: cancel the invoice instead.');
    if (total > inv.balance + 0.005) return S.fail(400, `Only ${inr(inv.balance)} is still unpaid, so a credit note can be at most that (this one is ${inr(total)} with GST). Money already received goes back as a refund.`, { left: inv.balance });
  }
  const n = Number(((await DB.one('SELECT COUNT(*) AS "n" FROM "CrmInvoiceNote" WHERE "kind" = ?', kind)) || {}).n) + 1;
  let code = `${KIND[kind].prefix}-${String(n).padStart(4, '0')}`;
  if (await DB.one('SELECT 1 AS "x" FROM "CrmInvoiceNote" WHERE "code" = ?', code)) code = `${code}-${crypto.randomBytes(2).toString('hex')}`;
  const now = DB.nowIso();
  const saved = await S.insert('CrmInvoiceNote', { id: S.newId('note'), invoiceId: row.id, kind, code, noteDate, reason, amount, taxPercent, taxAmount, total, status: 'Issued', createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now });
  const after = await recount(row.id);
  await note(row, `${KIND[kind].word} ${code} on ${row.code || 'the invoice'}: ${kind === 'credit' ? '-' : '+'}${total}`, reason, user);
  await S.audit(user, `CRM ${KIND[kind].word.toLowerCase()} issued`, 'CrmInvoice', row.id, `${code} on ${row.code || row.id}: ${amount} + GST ${taxAmount} = ${total} (${reason})`);
  return S.okBody({ ok: true, note: noteOut(saved), invoice: await S.invoiceFull(after) });
}
async function cancelNote(user, invoiceId, noteId) {
  const got = await invoiceRow(user, invoiceId, { edit: true, manager: true });
  if (got.err) return got.err;
  const row = got.row;
  const n = await DB.one('SELECT * FROM "CrmInvoiceNote" WHERE "id" = ? AND "invoiceId" = ?', S.clip(noteId, 60), row.id);
  if (!n) return S.fail(404, 'This note is not there.');
  if (n.status !== 'Issued') return S.fail(400, 'This note is already cancelled.');
  if (n.kind === 'debit') {
    const settled = cents(Number(row.paidAmount || 0) + Number(row.tdsAmount || 0));
    if (settled > S.netTotalOf(row) - n.total + 0.005) return S.fail(400, 'More is already received than the invoice would be worth without this debit note. Remove a payment line first.');
  }
  const now = DB.nowIso();
  await S.update('CrmInvoiceNote', n.id, { status: 'Cancelled', cancelledAt: now, cancelledByName: user.name || null, updatedAt: now });
  const after = await recount(row.id);
  await note(row, `${KIND[n.kind].word} ${n.code} cancelled`, null, user);
  await S.audit(user, `CRM ${KIND[n.kind].word.toLowerCase()} cancelled`, 'CrmInvoice', row.id, `${n.code} on ${row.code || row.id}`);
  return S.okBody({ ok: true, invoice: await S.invoiceFull(after) });
}
async function notePdf(user, invoiceId, noteId) {
  const got = await invoiceRow(user, invoiceId);
  if (got.err) return got.err;
  await SETTINGS.load().catch(() => null);
  const inv = S.invoiceOut(got.row);
  const n = await DB.one('SELECT * FROM "CrmInvoiceNote" WHERE "id" = ? AND "invoiceId" = ?', S.clip(noteId, 60), got.row.id);
  if (!n) return S.fail(404, 'This note is not there.');
  const K = KIND[n.kind];
  const MONEY = require('./money'); // eslint-disable-line global-require
  const gst = MONEY.gstSplit({ tax: n.taxAmount, taxPercent: n.taxPercent, from: inv.from, billTo: inv.billTo });
  const pdf = await pdfDoc(`${K.word} ${n.code}`, (doc, { W, NAVY, MUTED }) => {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(K.pdf, 50, 40, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(n.code, { width: W, align: 'right' }).text(`Date: ${longDate(n.noteDate)}`, { width: W, align: 'right' }).text(`Against invoice ${inv.code || ''} of ${longDate(inv.issueDate)}`, { width: W, align: 'right' });
    if (n.status === 'Cancelled') doc.font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c').text('CANCELLED', { width: W, align: 'right' });
    doc.moveDown(2);
    const top = doc.y;
    const l = partyBlock(doc, 50, top, 240, 'FROM', inv.from, MUTED);
    const r = partyBlock(doc, 310, top, 235, 'TO', { ...inv.billTo, name: inv.billTo.name || inv.accountName }, MUTED);
    let y = Math.max(l, r) + 20;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Reason', 50, y);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(n.reason || '-', 50, doc.y + 2, { width: W });
    y = doc.y + 16;
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#d9dee8').stroke(); y += 10;
    y = sumLine(doc, W, y, 'Value before GST', n.amount);
    if (gst.mode === 'intra') { y = sumLine(doc, W, y, `CGST @ ${gst.halfRate}%`, gst.cgst); y = sumLine(doc, W, y, `SGST @ ${gst.halfRate}%`, gst.sgst); } else y = sumLine(doc, W, y, `IGST @ ${n.taxPercent || 0}%`, n.taxAmount);
    y = sumLine(doc, W, y + 4, n.kind === 'credit' ? 'Total credited' : 'Total debited', n.total, { bold: true, NAVY });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(rupeesInWords(n.total), 50, y + 4, { width: W });
  });
  return { status: 200, pdf, name: `${n.code}.pdf` };
}

// ==================================================================================================== REPEATING INVOICES
const EVERY = { month: 1, quarter: 3, year: 12 };
const EVERY_WORD = { month: 'every month', quarter: 'every quarter', year: 'every year' };
function addMonths(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
const repeatOut = (x) => (x ? { id: x.id, every: x.every, everyWord: EVERY_WORD[x.every], nextDate: x.nextDate, untilDate: x.untilDate || null, active: !!x.active, made: Number(x.made) || 0, lastMadeAt: x.lastMadeAt || null } : null);
async function repeatOf(user, invoiceId) {
  const got = await invoiceRow(user, invoiceId);
  if (got.err) return got.err;
  const src = got.row.repeatOfId ? await DB.one('SELECT "id", "code" FROM "CrmInvoice" WHERE "id" = ?', got.row.repeatOfId) : null;
  const rep = await DB.one('SELECT * FROM "CrmInvoiceRepeat" WHERE "invoiceId" = ?', got.row.id);
  const made = await DB.all('SELECT "id", "code", "issueDate", "status", "total" FROM "CrmInvoice" WHERE "repeatOfId" = ? ORDER BY "issueDate" DESC LIMIT 60', got.row.id);
  return S.okBody({ repeat: repeatOut(rep), made, madeFrom: src, autoOn: (await load()).recurringOn, canEdit: S.canEditRow(user, S.roleOf(user), got.row) && !got.row.repeatOfId });
}
async function setRepeat(user, invoiceId, body = {}) {
  const got = await invoiceRow(user, invoiceId, { edit: true });
  if (got.err) return got.err;
  const row = got.row;
  if (row.repeatOfId) return S.fail(400, 'This invoice was made from a repeating one. Change the repeat on the first invoice.');
  if (row.status === 'Cancelled') return S.fail(400, 'This invoice is cancelled.');
  const now = DB.nowIso();
  const cur = await DB.one('SELECT * FROM "CrmInvoiceRepeat" WHERE "invoiceId" = ?', row.id);
  if (body.active === false) {
    if (!cur) return S.okBody({ ok: true, repeat: null });
    await S.update('CrmInvoiceRepeat', cur.id, { active: 0, updatedAt: now });
    await note(row, `Invoice ${row.code || ''} stops repeating`, null, user);
    await S.audit(user, 'CRM invoice repeat stopped', 'CrmInvoice', row.id, row.code || row.id);
    return S.okBody({ ok: true, repeat: repeatOut({ ...cur, active: 0 }) });
  }
  const every = String(body.every || (cur && cur.every) || '');
  if (!EVERY[every]) return S.fail(400, 'Pick every month, every quarter or every year.');
  const nextDate = body.nextDate ? String(body.nextDate).slice(0, 10) : addMonths(row.issueDate, EVERY[every]);
  if (!YMD.test(nextDate) || Number.isNaN(Date.parse(nextDate))) return S.fail(400, 'Write the next invoice date like 2026-12-01.');
  if (nextDate <= row.issueDate) return S.fail(400, 'The next invoice comes after this one\'s date.');
  const untilDate = body.untilDate ? String(body.untilDate).slice(0, 10) : null;
  if (untilDate && (!YMD.test(untilDate) || untilDate < nextDate)) return S.fail(400, 'The last date is on or after the next invoice date.');
  const data = { every, nextDate, untilDate, active: 1, updatedAt: now };
  const saved = cur ? await S.update('CrmInvoiceRepeat', cur.id, data) : await S.insert('CrmInvoiceRepeat', { id: S.newId('rep'), invoiceId: row.id, made: 0, createdById: user.id, createdByName: user.name || null, createdAt: now, ...data });
  await note(row, `Invoice ${row.code || ''} repeats ${EVERY_WORD[every]}`, `Next on ${nextDate}${untilDate ? `, until ${untilDate}` : ''}`, user);
  await S.audit(user, 'CRM invoice repeat set', 'CrmInvoice', row.id, `${row.code || row.id}: ${every}, next ${nextDate}${untilDate ? `, until ${untilDate}` : ''}`);
  return S.okBody({ ok: true, repeat: repeatOut(saved), autoOn: (await load()).recurringOn });
}
// the next invoice of a repeat: a DRAFT copy (lines, customer, amounts) dated the repeat's next date; the repeat moves on
async function makeNext(rep, user = null) {
  const src = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', rep.invoiceId);
  if (!src || src.status === 'Cancelled') { await S.update('CrmInvoiceRepeat', rep.id, { active: 0, updatedAt: DB.nowIso() }); return null; }
  const st = await SETTINGS.load();
  const issue = rep.nextDate;
  const MONEY = require('./money'); // eslint-disable-line global-require
  const code = await MONEY.nextInvoiceCode(issue);
  const now = DB.nowIso();
  const row = await S.insert('CrmInvoice', {
    id: S.newId('inv'), code: code || null, dealId: null, repeatOfId: src.id, accountId: src.accountId, accountName: src.accountName, title: src.title, status: 'Draft',
    issueDate: issue, dueDate: st.invoiceDueDays ? (() => { const d = new Date(`${issue}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(st.invoiceDueDays)); return d.toISOString().slice(0, 10); })() : null,
    amount: src.amount, discountPercent: src.discountPercent, taxPercent: src.taxPercent, taxAmount: src.taxAmount, total: src.total, paidAmount: 0, paidAt: null,
    fromJson: src.fromJson, billToJson: src.billToJson, notes: src.notes, linesJson: src.linesJson, tdsAmount: 0, creditAmount: 0, debitAmount: 0,
    ownerId: src.ownerId, ownerName: src.ownerName, createdById: user ? user.id : null, createdByName: user ? user.name || null : 'TeamLink (repeat)', createdAt: now, updatedAt: now,
  });
  const next = addMonths(rep.nextDate, EVERY[rep.every] || 1);
  const stillOn = !rep.untilDate || next <= rep.untilDate;
  await S.update('CrmInvoiceRepeat', rep.id, { nextDate: next, made: (Number(rep.made) || 0) + 1, lastMadeAt: now, lastInvoiceId: row.id, active: stillOn ? 1 : 0, updatedAt: now });
  await note(src, `Repeat: invoice ${row.code || ''} made as a Draft (${issue})`, stillOn ? `Next on ${next}` : 'That was the last one.', user);
  await S.audit(user || { id: null, name: 'TeamLink' }, 'CRM repeat invoice made', 'CrmInvoice', row.id, `${row.code || row.id} from ${src.code || src.id} for ${issue}`);
  if (src.ownerId) {
    await require('../utils/notify').notifyUsers([src.ownerId], { title: `Invoice ${row.code || ''} is ready to check`, message: `The repeat of ${src.code || 'an invoice'} for ${src.accountName || 'a customer'} (${inr(row.total)}, dated ${issue}) is a Draft: check it and send it.\nOpen: /crm/deals?view=invoices` }).catch(() => null); // eslint-disable-line global-require
  }
  return row;
}
async function makeNextNow(user, invoiceId) {
  const got = await invoiceRow(user, invoiceId, { edit: true });
  if (got.err) return got.err;
  const rep = await DB.one('SELECT * FROM "CrmInvoiceRepeat" WHERE "invoiceId" = ? AND "active" = 1', got.row.id);
  if (!rep) return S.fail(400, 'This invoice does not repeat. Set the repeat first.');
  const claimed = await DB.run('UPDATE "CrmInvoiceRepeat" SET "updatedAt" = ? WHERE "id" = ? AND "nextDate" = ? AND "active" = 1', DB.nowIso(), rep.id, rep.nextDate);
  if (Number(claimed) !== 1) return S.fail(409, 'It was just made. Look again.');
  const made = await makeNext(rep, user);
  return made ? S.okBody({ ok: true, invoice: S.invoiceOut(made) }) : S.fail(400, 'The first invoice is cancelled, so the repeat has stopped.');
}
/** Once a day (and on start): repeats whose date has come get their Draft - only while "Repeating invoices" is on. -> how many were made */
async function repeatTick({ today = S.istToday() } = {}) {
  if (!(await load({ fresh: true })).recurringOn) return 0;
  const due = await DB.all('SELECT * FROM "CrmInvoiceRepeat" WHERE "active" = 1 AND "nextDate" <= ? ORDER BY "nextDate" LIMIT 100', today);
  let made = 0;
  for (const rep of due) {
    // claimed first: two passes never make the same invoice twice
    // eslint-disable-next-line no-await-in-loop
    const claimed = await DB.run('UPDATE "CrmInvoiceRepeat" SET "updatedAt" = ? WHERE "id" = ? AND "nextDate" = ? AND "active" = 1', DB.nowIso(), rep.id, rep.nextDate);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (await makeNext(rep).catch((e) => { console.error('[crm] repeat invoice:', e.message); return null; })) made += 1; // eslint-disable-line no-console
  }
  return made;
}

// ==================================================================================================== COMMISSION
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthNow = () => S.istToday().slice(0, 7);
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
function percentOf(st, ownerId) { const v = st.commission.byUser[ownerId]; return v != null ? v : st.commission.percent; }
// collected in the month on each person's invoices: the cash, and its value before GST (each line x the invoice's amount / total)
async function collectedBy(month, ownerId = null) {
  const from = `${month}-01`; const to = `${nextMonth(month)}-01`;
  return DB.all(`SELECT p."ownerId" AS "ownerId", MAX(p."ownerName") AS "ownerName", COUNT(*) AS "n", COALESCE(SUM(p."amount"), 0) AS "collected",
    COALESCE(SUM(p."amount" * CASE WHEN i."total" > 0 THEN i."amount" / i."total" ELSE 1 END), 0) AS "base"
    FROM "CrmPayment" p JOIN "CrmInvoice" i ON i."id" = p."invoiceId"
    WHERE p."paidOn" >= ? AND p."paidOn" < ? AND p."amount" > 0 AND p."ownerId" IS NOT NULL${ownerId ? ' AND p."ownerId" = ?' : ''} GROUP BY p."ownerId"`, from, to, ...(ownerId ? [ownerId] : []));
}
async function statement(user, q = {}) {
  const r = S.roleOf(user);
  const month = MONTH.test(String(q.month || '')) ? String(q.month) : monthNow();
  const st = await load({ fresh: true });
  const all = S.mayAssign(r);
  const live = await collectedBy(month, all ? null : user.id);
  const frozen = await DB.all(`SELECT * FROM "CrmCommission" WHERE "month" = ?${all ? '' : ' AND "ownerId" = ?'}`, month, ...(all ? [] : [user.id]));
  const ids = [...new Set([...live.map((x) => x.ownerId), ...frozen.map((x) => x.ownerId)])];
  const team = await S.ownerOptions();
  const rows = ids.map((id) => {
    const l = live.find((x) => x.ownerId === id) || { n: 0, collected: 0, base: 0 };
    const f = frozen.find((x) => x.ownerId === id);
    const percent = f ? f.percent : percentOf(st, id);
    const base = f ? f.base : cents(l.base);
    return {
      ownerId: id, ownerName: (f && f.ownerName) || l.ownerName || ((team.find((o) => o.id === id) || {}).name) || '-', payments: Number(l.n) || 0,
      collected: f ? f.collected : cents(l.collected), base, percent, amount: f ? f.amount : cents((base * percent) / 100),
      status: f ? f.status : 'Not approved', approvedByName: f ? f.approvedByName : null, approvedAt: f ? f.approvedAt : null, paidOn: f ? f.paidOn : null, paidRef: f ? f.paidRef : null,
      changedSince: !!f && Math.abs(cents(l.base) - f.base) > 0.5,
    };
  }).sort((a, b) => b.amount - a.amount);
  return S.okBody({ month, rows, finished: month < monthNow(), canApprove: all, totals: { collected: cents(rows.reduce((n, x) => n + x.collected, 0)), amount: cents(rows.reduce((n, x) => n + x.amount, 0)) } });
}
async function statementLines(user, q = {}) {
  const r = S.roleOf(user);
  const month = MONTH.test(String(q.month || '')) ? String(q.month) : monthNow();
  const ownerId = S.mayAssign(r) ? S.clip(q.ownerId, 60) : user.id;
  const rows = await DB.all(`SELECT p."id", p."paidOn", p."amount", p."mode", p."reference", i."code", i."accountName", i."amount" AS "invAmount", i."total" AS "invTotal" FROM "CrmPayment" p JOIN "CrmInvoice" i ON i."id" = p."invoiceId"
    WHERE p."ownerId" = ? AND p."paidOn" >= ? AND p."paidOn" < ? AND p."amount" > 0 ORDER BY p."paidOn" ASC`, ownerId, `${month}-01`, `${nextMonth(month)}-01`);
  return S.okBody({ rows: rows.map((x) => ({ id: x.id, paidOn: x.paidOn, amount: x.amount, mode: x.mode, reference: x.reference, invoice: x.code, account: x.accountName, base: cents(x.invTotal > 0 ? (x.amount * x.invAmount) / x.invTotal : x.amount) })) });
}
async function approve(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const month = String(body.month || '');
  if (!MONTH.test(month)) return S.fail(400, 'Pick the month.');
  if (month >= monthNow()) return S.fail(400, 'A month is approved once it is over (the money of this month is still coming).');
  const ownerId = S.clip(body.ownerId, 60);
  if (await DB.one('SELECT 1 AS "x" FROM "CrmCommission" WHERE "ownerId" = ? AND "month" = ?', ownerId, month)) return S.fail(409, 'This month is already approved for this person.');
  const st = await load({ fresh: true });
  const percent = percentOf(st, ownerId);
  if (!(percent > 0)) return S.fail(400, 'No commission % is set for this person. Set it in the commission rules first.');
  const l = (await collectedBy(month, ownerId))[0];
  if (!l) return S.fail(400, 'Nothing was collected on this person\'s invoices in that month.');
  const base = cents(l.base); const amount = cents((base * percent) / 100);
  const name = l.ownerName || ((await S.ownerOptions()).find((o) => o.id === ownerId) || {}).name || null;
  const now = DB.nowIso();
  await S.insert('CrmCommission', { id: S.newId('com'), ownerId, ownerName: name, month, collected: cents(l.collected), base, percent, amount, status: 'Approved', approvedById: user.id, approvedByName: user.name || null, approvedAt: now, createdAt: now, updatedAt: now });
  await S.audit(user, 'CRM commission approved', 'CrmCommission', `${ownerId}:${month}`, `${name || ownerId} ${month}: ${percent}% of ${base} = ${amount}`);
  await require('../utils/notify').notifyUsers([ownerId], { title: `Commission for ${month} approved`, message: `${inr(amount)} (${percent}% of ${inr(base)} collected before GST). Open: /crm/deals?view=commission` }).catch(() => null); // eslint-disable-line global-require
  return statement(user, { month });
}
async function undoApprove(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const row = await DB.one('SELECT * FROM "CrmCommission" WHERE "ownerId" = ? AND "month" = ?', S.clip(body.ownerId, 60), String(body.month || ''));
  if (!row) return S.fail(404, 'This month is not approved.');
  if (row.status === 'Paid') return S.fail(400, 'It is marked paid already, so it cannot be undone.');
  await DB.run('DELETE FROM "CrmCommission" WHERE "id" = ?', row.id);
  await S.audit(user, 'CRM commission approval undone', 'CrmCommission', `${row.ownerId}:${row.month}`, `${row.ownerName || row.ownerId} ${row.month}: ${row.amount}`);
  return statement(user, { month: row.month });
}
async function markPaid(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const row = await DB.one('SELECT * FROM "CrmCommission" WHERE "ownerId" = ? AND "month" = ?', S.clip(body.ownerId, 60), String(body.month || ''));
  if (!row) return S.fail(400, 'Approve the month first.');
  if (row.status === 'Paid') return S.fail(400, 'It is marked paid already.');
  const paidOn = body.paidOn ? String(body.paidOn).slice(0, 10) : S.istToday();
  if (!YMD.test(paidOn) || paidOn > S.istToday()) return S.fail(400, 'Write the date it was paid (not in the future).');
  await S.update('CrmCommission', row.id, { status: 'Paid', paidOn, paidRef: S.clip(String(body.reference || '').trim(), 80) || null, paidByName: user.name || null, updatedAt: DB.nowIso() });
  await S.audit(user, 'CRM commission paid', 'CrmCommission', `${row.ownerId}:${row.month}`, `${row.ownerName || row.ownerId} ${row.month}: ${row.amount} on ${paidOn}`);
  return statement(user, { month: row.month });
}

module.exports = {
  DEFAULTS, PRIORITIES, load, current, slaHours, getSettings, saveSettings, rupeesInWords, addMonths, tokenFor, idOfToken,
  receiptPdf, shareReceipt, receiptMailDraft, emailReceipt, notesOf, addNote, cancelNote, notePdf,
  repeatOf, setRepeat, makeNextNow, makeNext, repeatTick, statement, statementLines, approve, undoApprove, markPaid,
};

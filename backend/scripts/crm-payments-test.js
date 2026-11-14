#!/usr/bin/env node
/**
 * The PAYMENT LOG of a CRM invoice (crm/service.js: addPayment, deletePayment, settleInvoice, setInvoiceStatus) - founder 2026-11-14, build order 1.
 * Every amount received is a line (date, amount, mode, reference); the invoice's paid amount and its Partly paid / Paid status come FROM the lines.
 * No TDS / GST (waits for the CA). Never touches the ATS Accounts tables.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4053. Nothing real is called.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-payments-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-payments-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4053;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-payments-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 360)}` : ''}`); } };
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j, headers: r.headers };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const istDay = (plus = 0) => new Date(Date.now() + 5.5 * 3600000 + plus * 86400000).toISOString().slice(0, 10);

(async () => {
  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  await SETTINGS.load({ fresh: true });
  const atsInvoicesBefore = await prisma.invoice.count();
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const token = jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const auth = { Authorization: `Bearer ${token}` };

  // a Won deal: 100,000 + 18% tax = an invoice of 118,000
  const acc = await call('POST', '/crm/accounts', { name: 'Zz Payment Traders', gstin: '36ABCDE1234F1Z5', address: '1 Pay Road' }, auth);
  const deal = await call('POST', '/crm/deals', { title: 'Zz Payment Deal', accountId: acc.body.account.id, value: '100000' }, auth);
  const won = await call('POST', `/crm/deals/${deal.body.deal.id}/stage`, { stage: 'Won' }, auth);
  const inv = won.body.invoice;
  const dealId = deal.body.deal.id;
  check('the invoice is 118,000 and starts as a Draft with nothing received', inv && inv.total === 118000 && inv.status === 'Draft' && inv.paidAmount === 0, inv && [inv.total, inv.status, inv.paidAmount]);
  const P = `/crm/invoices/${inv.id}/payments`;

  console.log('The first payment makes it Partly paid');
  const p1 = await call('POST', P, { amount: 50000, paidOn: istDay(-2), mode: 'UPI', reference: 'UTR123456', note: 'first part' }, auth);
  check('it is saved', p1.status === 200 && p1.body.ok === true, p1.body);
  check('the invoice is Partly paid, 50,000 in, 68,000 left', p1.body.invoice.status === 'Partly paid' && p1.body.invoice.paidAmount === 50000 && p1.body.invoice.balance === 68000, p1.body.invoice && [p1.body.invoice.status, p1.body.invoice.paidAmount, p1.body.invoice.balance]);
  const l1 = p1.body.invoice.payments;
  check('the log has the line with its date, mode, reference and who recorded it', l1.length === 1 && l1[0].paidOn === istDay(-2) && l1[0].mode === 'UPI' && l1[0].reference === 'UTR123456' && l1[0].note === 'first part' && !!l1[0].byName, l1);

  console.log('A payment that makes no sense is refused');
  check('no amount', (await call('POST', P, { amount: '' }, auth)).status === 400);
  check('zero', (await call('POST', P, { amount: 0 }, auth)).status === 400);
  check('not a number', (await call('POST', P, { amount: 'abc' }, auth)).status === 400);
  const more = await call('POST', P, { amount: 68001 }, auth);
  check('more than what is left, and it says how much is left', more.status === 400 && more.body.left === 68000, more.body);
  check('a date in the future', (await call('POST', P, { amount: 100, paidOn: istDay(2) }, auth)).status === 400);
  check('a date that is not a date', (await call('POST', P, { amount: 100, paidOn: '31/12/2026' }, auth)).status === 400);
  check('a mode that is not in the list', (await call('POST', P, { amount: 100, mode: 'Bitcoin' }, auth)).status === 400);
  check('an invoice that is not there', (await call('POST', '/crm/invoices/inv_nope/payments', { amount: 100 }, auth)).status === 404);
  check('nobody logged in', (await call('POST', P, { amount: 100 })).status === 401);
  check('none of those left a line behind', (await call('GET', `/crm/invoices/${inv.id}`, null, auth)).body.invoice.payments.length === 1);

  console.log('More payments, in date order; the last one makes it Paid');
  const p2 = await call('POST', P, { amount: 18000, mode: 'Cash' }, auth);
  check('a second payment with no date is dated today, and with the mode it was given', p2.status === 200 && p2.body.invoice.payments[1].paidOn === istDay(0) && p2.body.invoice.payments[1].mode === 'Cash', p2.body.invoice && p2.body.invoice.payments);
  check('still Partly paid, 68,000 in', p2.body.invoice.status === 'Partly paid' && p2.body.invoice.paidAmount === 68000, p2.body.invoice && [p2.body.invoice.status, p2.body.invoice.paidAmount]);
  const p0 = await call('POST', P, { amount: 1000, paidOn: istDay(-5), mode: 'Cheque', reference: 'CHQ-77' }, auth);
  check('a payment dated earlier lands before the others in the log', p0.status === 200 && p0.body.invoice.payments[0].paidOn === istDay(-5) && p0.body.invoice.payments.length === 3, p0.body.invoice && p0.body.invoice.payments.map((x) => x.paidOn));
  const p3 = await call('POST', P, { amount: 49000, paidOn: istDay(0), mode: 'Bank transfer' }, auth);
  check('the last 49,000 settles it: Paid, 118,000 in, nothing left', p3.status === 200 && p3.body.invoice.status === 'Paid' && p3.body.invoice.paidAmount === 118000 && p3.body.invoice.balance === 0, p3.body.invoice && [p3.body.invoice.status, p3.body.invoice.paidAmount, p3.body.invoice.balance]);
  check('and it has the date it was paid', !!p3.body.invoice.paidAt && p3.body.invoice.paidAt.slice(0, 10) === istDay(0), p3.body.invoice.paidAt);
  const full = await call('POST', P, { amount: 1 }, auth);
  check('nothing more can be added once it is paid in full', full.status === 400, full.body);

  console.log('Where it shows');
  const det = await call('GET', `/crm/invoices/${inv.id}`, null, auth);
  check('the invoice detail carries the log (4 lines)', det.body.invoice.payments.length === 4, det.body.invoice.payments);
  const byDeal = await call('GET', `/crm/invoices?dealId=${dealId}`, null, auth);
  check('the deal\'s invoice list carries the log too', byDeal.body.invoices.length === 1 && byDeal.body.invoices[0].payments.length === 4, byDeal.body.invoices[0] && byDeal.body.invoices[0].payments);
  const dd = await call('GET', `/crm/deals/${dealId}`, null, auth);
  check('the deal timeline says each payment received', dd.body.activities && dd.body.activities.some((a) => /Payment of 50000 received on INV-\d{4} \(UPI, UTR123456\)/.test(a.subject || '')), dd.body.activities && dd.body.activities.map((a) => a.subject));
  const pdf = await fetch(`${API}/crm/invoices/${inv.id}/pdf`, { headers: auth });
  const buf = Buffer.from(await pdf.arrayBuffer());
  check('the PDF still opens', pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', [pdf.status, buf.length]);

  console.log('A wrong line is removed and the invoice follows');
  const logIds = det.body.invoice.payments.map((x) => x.id);
  const rm1 = await call('DELETE', `${P}/${logIds[3]}`, null, auth);
  check('removing the last 49,000 takes it back to Partly paid, 69,000 in', rm1.status === 200 && rm1.body.invoice.status === 'Partly paid' && rm1.body.invoice.paidAmount === 69000 && !rm1.body.invoice.paidAt, rm1.body.invoice && [rm1.body.invoice.status, rm1.body.invoice.paidAmount, rm1.body.invoice.paidAt]);
  check('removing one that is not there is a 404', (await call('DELETE', `${P}/pay_nope`, null, auth)).status === 404);
  const other = await call('POST', '/crm/deals', { title: 'Zz Other Deal', accountId: acc.body.account.id, value: '1000' }, auth);
  const wonOther = await call('POST', `/crm/deals/${other.body.deal.id}/stage`, { stage: 'Won' }, auth);
  check('a line of another invoice cannot be removed through this one', (await call('DELETE', `/crm/invoices/${wonOther.body.invoice.id}/payments/${logIds[0]}`, null, auth)).status === 404);
  const rmTl = await call('GET', `/crm/deals/${dealId}`, null, auth);
  check('removing is on the timeline too', rmTl.body.activities.some((a) => /Payment of 49000 \(.*\) removed from INV-/.test(a.subject || '')), rmTl.body.activities.map((a) => a.subject));

  console.log('Status choices stay in step with the log');
  const toSent = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, auth);
  check('Sent is refused while payments are recorded, and says why', toSent.status === 409 && toSent.body.hasPayments === true, toSent.body);
  check('so is Draft and Cancelled', (await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Draft' }, auth)).status === 409 && (await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Cancelled' }, auth)).status === 409);
  const lower = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Partly paid', paidAmount: 10000 }, auth);
  check('Partly paid with less than the log already holds is refused (delete a line instead)', lower.status === 400, lower.body);
  const upTo = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Partly paid', paidAmount: 90000 }, auth);
  check('Partly paid with more writes the difference as a line (21,000, mode Other)', upTo.status === 200 && upTo.body.invoice.paidAmount === 90000 && upTo.body.invoice.payments.some((x) => x.amount === 21000 && x.mode === 'Other'), upTo.body.invoice && upTo.body.invoice.payments);
  const asPaid = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Paid' }, auth);
  check('Paid writes the rest as a line (28,000) and the log adds up to the total', asPaid.status === 200 && asPaid.body.invoice.status === 'Paid' && asPaid.body.invoice.payments.reduce((n, x) => n + x.amount, 0) === 118000 && asPaid.body.invoice.payments.some((x) => x.amount === 28000 && /Marked as paid/.test(x.note || '')), asPaid.body.invoice && asPaid.body.invoice.payments);
  let left = asPaid.body.invoice.payments;
  for (const l of left) { await call('DELETE', `${P}/${l.id}`, null, auth); } // eslint-disable-line no-await-in-loop
  const empty = await call('GET', `/crm/invoices/${inv.id}`, null, auth);
  check('with every line removed it goes back to Sent, nothing received', empty.body.invoice.status === 'Sent' && empty.body.invoice.paidAmount === 0 && empty.body.invoice.payments.length === 0, empty.body.invoice && [empty.body.invoice.status, empty.body.invoice.paidAmount]);
  const canc = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Cancelled' }, auth);
  check('with nothing recorded it can be cancelled', canc.status === 200 && canc.body.invoice.status === 'Cancelled', canc.body);
  check('a cancelled invoice takes no payment', (await call('POST', P, { amount: 100 }, auth)).status === 400);
  check('and cannot be marked paid until it is set back', (await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Paid' }, auth)).status === 400);
  left = null;

  console.log('Kept apart from ATS Accounts');
  check('no ATS Accounts invoice was made', (await prisma.invoice.count()) === atsInvoicesBefore);
  const cols = await DB.all('PRAGMA table_info("CrmPayment")');
  check('the payment table has no TDS / GST columns (they wait for the CA)', !cols.some((c) => /tds|gst/i.test(c.name)), cols.map((c) => c.name));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

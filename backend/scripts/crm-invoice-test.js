#!/usr/bin/env node
/**
 * The CRM's own invoice (crm/service.js: createInvoiceForDeal, invoices, setInvoiceStatus; crm/extra.js: invoicePdf).
 * Won -> a CRM-native CrmInvoice. It must NEVER touch the ATS Accounts Invoice / Client tables (founder 2026-11-13).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4046. Nothing real is called.
 *   node scripts/crm-invoice-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-invoice-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4046;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-invoice-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 320)}` : ''}`); } };
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

(async () => {
  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  await SETTINGS.load({ fresh: true });
  const atsInvoicesBefore = await prisma.invoice.count();
  const atsClientsBefore = await prisma.client.count();
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

  console.log('Won raises the CRM invoice');
  const acc = await call('POST', '/crm/accounts', { name: 'Zz Invoice Traders', gstin: '36ABCDE1234F1Z5', address: '12 Main Road', state: 'Telangana', pincode: '500001', email: 'acct@zzinvoice.test' }, auth);
  check('a customer account is added with GSTIN and address', acc.status === 200 && acc.body.account && acc.body.account.gstin === '36ABCDE1234F1Z5', acc.body);
  const accountId = acc.body.account.id;
  const deal = await call('POST', '/crm/deals', { title: 'Zz Invoice Deal', accountId, value: '100000', discountPercent: '5' }, auth);
  check('a deal is added', deal.status === 200 && deal.body.deal, deal.body);
  const dealId = deal.body.deal.id;
  const early = await call('POST', `/crm/deals/${dealId}/invoice`, null, auth);
  check('an invoice cannot be raised before the deal is Won', early.status === 400, early.body);
  const won = await call('POST', `/crm/deals/${dealId}/stage`, { stage: 'Won' }, auth);
  const inv = won.body && won.body.invoice;
  check('Won comes back with an invoice', won.status === 200 && !!inv, won.body);
  check('the invoice has a code INV-0001 style', inv && /^INV-\d{4}$/.test(inv.code), inv && inv.code);
  check('the amount is the value after the 5% discount (95,000)', inv && inv.amount === 95000, inv && inv.amount);
  check('18% tax on it (17,100) and a total of 112,100', inv && inv.taxAmount === 17100 && inv.total === 112100, inv && { tax: inv.taxAmount, total: inv.total });
  check('it starts as a Draft with an issue date and a due date', inv && inv.status === 'Draft' && /^\d{4}-\d{2}-\d{2}$/.test(inv.issueDate) && inv.dueDate > inv.issueDate, inv && [inv.status, inv.issueDate, inv.dueDate]);
  check('the customer is on it: name, GSTIN, address', inv && inv.billTo.name === 'Zz Invoice Traders' && inv.billTo.gstin === '36ABCDE1234F1Z5' && inv.billTo.address === '12 Main Road', inv && inv.billTo);
  check('our details are on it', inv && inv.from && inv.from.name, inv && inv.from);

  console.log('One invoice per deal');
  const again = await call('POST', `/crm/deals/${dealId}/invoice`, null, auth);
  check('asking again returns the same invoice, not a second one', again.status === 200 && again.body.invoice.id === inv.id, again.body);
  const count = await DB.one('SELECT COUNT(*) AS n FROM "CrmInvoice" WHERE "dealId" = ?', dealId);
  check('only one row is stored for the deal', Number(count.n) === 1, count);

  console.log('The list, the detail and the PDF');
  const list = await call('GET', '/crm/invoices', null, auth);
  check('the invoice is in the list', list.status === 200 && list.body.invoices.some((x) => x.id === inv.id), list.body && list.body.invoices && list.body.invoices.length);
  const byAcc = await call('GET', `/crm/invoices?accountId=${accountId}`, null, auth);
  check('it can be filtered by customer', byAcc.body.invoices.length === 1 && byAcc.body.invoices[0].id === inv.id, byAcc.body);
  const det = await call('GET', `/crm/invoices/${inv.id}`, null, auth);
  check('the detail opens', det.status === 200 && det.body.invoice.id === inv.id, det.body);
  const pdf = await fetch(`${API}/crm/invoices/${inv.id}/pdf`, { headers: auth });
  const buf = Buffer.from(await pdf.arrayBuffer());
  check('the PDF is a PDF', pdf.status === 200 && /pdf/.test(pdf.headers.get('content-type') || '') && buf.slice(0, 4).toString() === '%PDF' && buf.length > 1500, [pdf.status, buf.length]);
  check('a missing invoice is 404', (await call('GET', '/crm/invoices/inv_nope', null, auth)).status === 404);

  console.log('Status and payment');
  check('a status that does not exist is refused', (await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Nonsense' }, auth)).status === 400);
  const sent = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, auth);
  check('Sent', sent.status === 200 && sent.body.invoice.status === 'Sent', sent.body);
  const part = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Partly paid', paidAmount: 50000 }, auth);
  check('Partly paid keeps the amount received', part.status === 200 && part.body.invoice.paidAmount === 50000, part.body);
  const over = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Partly paid', paidAmount: 999999999 }, auth);
  check('the amount received cannot be more than the total', over.body.invoice.paidAmount === 112100, over.body);
  const paid = await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Paid' }, auth);
  check('Paid takes the whole total and the date', paid.status === 200 && paid.body.invoice.paidAmount === 112100 && !!paid.body.invoice.paidAt, paid.body);
  const byStatus = await call('GET', '/crm/invoices?status=Paid', null, auth);
  check('the Paid filter finds it', byStatus.body.invoices.some((x) => x.id === inv.id));

  console.log('The deal and the timeline');
  const dd = await call('GET', `/crm/deals/${dealId}`, null, auth);
  check('the invoice being raised is on the deal timeline', dd.body.activities && dd.body.activities.some((a) => /Invoice INV-\d{4} raised/.test(a.subject || '')), dd.body.activities && dd.body.activities.map((a) => a.subject));

  console.log('A deal with no discount');
  const d2 = await call('POST', '/crm/deals', { title: 'Zz Plain Deal', accountId, value: '10000' }, auth);
  const w2 = await call('POST', `/crm/deals/${d2.body.deal.id}/stage`, { stage: 'Won' }, auth);
  check('the invoice is the full value with tax (10,000 + 1,800)', w2.body.invoice && w2.body.invoice.amount === 10000 && w2.body.invoice.total === 11800, w2.body.invoice);
  check('the next invoice has the next number', w2.body.invoice && w2.body.invoice.code !== inv.code, [inv.code, w2.body.invoice && w2.body.invoice.code]);

  console.log('Kept apart from ATS Accounts');
  check('no ATS Accounts invoice was made', (await prisma.invoice.count()) === atsInvoicesBefore);
  check('no ATS client was made', (await prisma.client.count()) === atsClientsBefore);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

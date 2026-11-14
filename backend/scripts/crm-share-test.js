#!/usr/bin/env node
/**
 * THE INVOICE ON WHATSAPP (crm/extra.js shareInvoice, routes/crmPublic.js GET /invoice/:token) - the pasted build order: "WhatsApp click-to-chat easy, PDF link tho".
 * TeamLink sends nothing: it makes a signed 30-day link to the PDF and the message with the customer's number; the person presses Send in WhatsApp.
 * The link must open that one PDF without a login, and no other (not another invoice, not after it expires, not if the signature is changed).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4058.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-share-test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-share-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4058;
const API = `http://localhost:${PORT}/api`;
const SECRET = 'crm-share-test';
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${PORT}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 420)}` : ''}`); } };
let auth = {};
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
// the same signing the server does (the contract of the link): the body "<invoiceId>.<expires>" signed with the server secret
const sign = (body) => crypto.createHmac('sha256', SECRET).update(`crm-invoice-link:${body}`).digest('base64url').slice(0, 24);
const tokenFor = (id, exp) => { const body = `${id}.${exp}`; return `${Buffer.from(body).toString('base64url')}.${sign(body)}`; };

(async () => {
  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  await SETTINGS.load({ fresh: true });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };

  const win = async (account, title, value) => {
    const d = await call('POST', '/crm/deals', { title, accountId: account.id, value: String(value) });
    const w = await call('POST', `/crm/deals/${d.body.deal.id}/stage`, { stage: 'Won' });
    return { deal: d.body.deal, inv: w.body.invoice };
  };
  const accWithPhone = (await call('POST', '/crm/accounts', { name: 'ZZ Share With Phone', phone: '+91 98765 43210', gstin: '36ABCDE1234F1Z5', address: '1 Road' })).body.account;
  const A = await win(accWithPhone, 'ZZ Share A', 100000);
  check('an invoice of 118,000 exists for a customer whose number is +91 98765 43210', A.inv && A.inv.total === 118000, A.inv);

  console.log('1. The link and the message');
  const sh = await call('POST', `/crm/invoices/${A.inv.id}/share`);
  check('a link is made', sh.status === 200 && sh.body.ok && /^http:\/\/localhost:4058\/api\/crm-public\/invoice\/[\w-]+\.[\w-]+$/.test(sh.body.url), sh.body);
  check('the WhatsApp address is the customer\'s number with the country code and the message (+91 and spaces cleaned)', sh.body.waUrl.startsWith('https://wa.me/919876543210?text='), sh.body.waUrl.slice(0, 60));
  check('the message has the invoice number, the amount, the due date and the link', sh.body.text.includes(A.inv.code) && /Rs\. 1,18,000/.test(sh.body.text) && /due /.test(sh.body.text) && sh.body.text.includes(sh.body.url), sh.body.text);
  check('it is a Draft until the person marks it Sent', sh.body.status === 'Draft' && (await call('GET', `/crm/invoices/${A.inv.id}`)).body.invoice.status === 'Draft');
  check('it is on the deal timeline', (await call('GET', `/crm/deals/${A.deal.id}`)).body.activities.some((a) => /sent on WhatsApp/.test(a.subject || '')));
  check('and in the audit log', (await prisma.auditLog.count({ where: { action: 'CRM invoice shared on WhatsApp', entityId: A.inv.id } })) === 1);

  console.log('2. The customer opens the link (no login)');
  const path1 = new URL(sh.body.url).pathname;
  const pub = await fetch(`http://localhost:${PORT}${path1}`);
  const buf = Buffer.from(await pub.arrayBuffer());
  check('it opens the PDF with no login', pub.status === 200 && /pdf/.test(pub.headers.get('content-type') || '') && buf.slice(0, 4).toString() === '%PDF' && buf.length > 1500, [pub.status, buf.length]);
  check('and says not to keep or index it', /no-store/.test(pub.headers.get('cache-control') || '') && /noindex/.test(pub.headers.get('x-robots-tag') || ''));
  const tok = path1.split('/').pop();
  const [b, sig] = tok.split('.');
  check('a link whose signature is changed does not open', (await fetch(`http://localhost:${PORT}/api/crm-public/invoice/${b}.${sig.slice(0, -2)}xx`)).status === 404);
  check('a link made for another invoice cannot be built from this one (the id changed, the signature kept)', (await fetch(`http://localhost:${PORT}/api/crm-public/invoice/${Buffer.from(`inv_other.${Math.floor(Date.now() / 1000) + 99999}`).toString('base64url')}.${sig}`)).status === 404);
  check('an expired link does not open', (await fetch(`http://localhost:${PORT}/api/crm-public/invoice/${tokenFor(A.inv.id, Math.floor(Date.now() / 1000) - 10)}`)).status === 404);
  check('a link that is still in date and correctly signed opens (the contract)', (await fetch(`http://localhost:${PORT}/api/crm-public/invoice/${tokenFor(A.inv.id, Math.floor(Date.now() / 1000) + 3600)}`)).status === 200);
  check('nonsense does not open and does not crash', (await fetch(`http://localhost:${PORT}/api/crm-public/invoice/abc`)).status === 404 && (await fetch(`http://localhost:${PORT}/api/crm-public/invoice/.`)).status === 404);
  check('the normal invoice PDF still needs a login', (await fetch(`${API}/crm/invoices/${A.inv.id}/pdf`)).status === 401);

  console.log('3. The number');
  const accNoPhone = (await call('POST', '/crm/accounts', { name: 'ZZ Share Contact Phone' })).body.account;
  await call('POST', '/crm/contacts', { accountId: accNoPhone.id, name: 'Meera Rao', role: 'Decision maker', phone: '098111 22233', email: 'meera@example.test' });
  const B = await win(accNoPhone, 'ZZ Share B', 50000);
  const shB = await call('POST', `/crm/invoices/${B.inv.id}/share`);
  check('a customer with no number: the decision maker\'s number is used (a leading 0 cleaned) and the message greets them by first name', shB.body.number === '919811122233' && /^Hello Meera,/.test(shB.body.text) && shB.body.waUrl.startsWith('https://wa.me/919811122233?'), [shB.body.number, shB.body.text.slice(0, 20)]);
  const accNone = (await call('POST', '/crm/accounts', { name: 'ZZ Share Nobody' })).body.account;
  const C = await win(accNone, 'ZZ Share C', 10000);
  const shC = await call('POST', `/crm/invoices/${C.inv.id}/share`);
  check('nobody has a number: the message is still made, the person picks the chat', shC.status === 200 && shC.body.number === null && shC.body.waUrl.startsWith('https://wa.me/?text='), shC.body);

  console.log('4. A part-paid invoice asks for the balance; a cancelled one is not sent');
  await call('POST', `/crm/invoices/${A.inv.id}/status`, { status: 'Sent' });
  await call('POST', `/crm/invoices/${A.inv.id}/payments`, { amount: 40000, mode: 'UPI' });
  const shP = await call('POST', `/crm/invoices/${A.inv.id}/share`);
  check('the message says the balance (78,000), not the whole total', /Rs\. 78,000 balance/.test(shP.body.text), shP.body.text);
  await call('POST', `/crm/invoices/${C.inv.id}/status`, { status: 'Cancelled' });
  check('a cancelled invoice is not sent', (await call('POST', `/crm/invoices/${C.inv.id}/share`)).status === 400);
  check('an invoice that is not there', (await call('POST', '/crm/invoices/inv_nope/share')).status === 404);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

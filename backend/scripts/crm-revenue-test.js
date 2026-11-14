#!/usr/bin/env node
/**
 * BOOKED / INVOICED / COLLECTED on the CRM dashboard (crm/extra.js overview().cash) - founder 2026-11-14, build order 2.
 *   booked = deals WON in the period; invoiced = invoices that went out (not Draft, not Cancelled) dated in the period, with tax;
 *   collected = money that came in the period (payment log, by the date it came); still to collect = owed now on invoices that went out (+ overdue part).
 * Measured as the CHANGE the new records make on a copy of the sandbox database, so whatever the sandbox already holds does not matter.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4054.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-revenue-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-revenue-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4054;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-revenue-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const istDay = (plus = 0) => new Date(Date.now() + 5.5 * 3600000 + plus * 86400000).toISOString().slice(0, 10);
const near = (a, b) => Math.abs(a - b) < 0.01;

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
  const token = jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const auth = { Authorization: `Bearer ${token}` };
  const cash = async (period = 'month') => (await call('GET', `/crm/overview?period=${period}`, null, auth)).body.cash;

  const base = await cash();
  check('the dashboard carries the money block', base && base.booked && base.invoiced && base.collected && base.toCollect && base.drafts && base.wonNoInvoice != null, base);
  const baseLast = await cash('last_month');

  const acc = await call('POST', '/crm/accounts', { name: 'Zz Revenue Traders', gstin: '36ABCDE1234F1Z5', address: '1 Money Road' }, auth);
  const accountId = acc.body.account.id;
  const win = async (title, value) => {
    const d = await call('POST', '/crm/deals', { title, accountId, value: String(value) }, auth);
    const w = await call('POST', `/crm/deals/${d.body.deal.id}/stage`, { stage: 'Won' }, auth);
    return { deal: d.body.deal, inv: w.body.invoice };
  };
  // A: 100,000 (118,000 with tax) - sent, 50,000 received today.  B: 10,000 (11,800) - stays a Draft.  C: 20,000 (23,600) - sent, due yesterday, nothing received.
  const A = await win('Zz Rev A', 100000);
  const B = await win('Zz Rev B', 10000);
  const C = await win('Zz Rev C', 20000);
  check('three deals won, three invoices raised', A.inv && B.inv && C.inv && A.inv.total === 118000 && B.inv.total === 11800 && C.inv.total === 23600, [A.inv && A.inv.total, B.inv && B.inv.total, C.inv && C.inv.total]);

  let c = await cash();
  check('BOOKED rises by the three deal values (130,000), 3 deals', near(c.booked.value - base.booked.value, 130000) && c.booked.deals - base.booked.deals === 3, [c.booked, base.booked]);
  check('INVOICED does not move while all three are Drafts (not sent yet)', near(c.invoiced.value - base.invoiced.value, 0) && c.invoiced.invoices === base.invoiced.invoices, [c.invoiced, base.invoiced]);
  check('the three Drafts are said apart: 153,400 in 3 drafts', near(c.drafts.value - base.drafts.value, 153400) && c.drafts.invoices - base.drafts.invoices === 3, [c.drafts, base.drafts]);
  check('COLLECTED has not moved', near(c.collected.value - base.collected.value, 0), [c.collected, base.collected]);
  check('and the three show as Won with their invoices (nothing "Won, no invoice yet" added)', c.wonNoInvoice === base.wonNoInvoice, [c.wonNoInvoice, base.wonNoInvoice]);

  await call('POST', `/crm/invoices/${A.inv.id}/status`, { status: 'Sent' }, auth);
  await call('POST', `/crm/invoices/${C.inv.id}/status`, { status: 'Sent' }, auth);
  c = await cash();
  check('INVOICED counts the two that went out, with tax (141,600)', near(c.invoiced.value - base.invoiced.value, 141600) && c.invoiced.invoices - base.invoiced.invoices === 2, [c.invoiced, base.invoiced]);
  check('only B is a Draft now (11,800)', near(c.drafts.value - base.drafts.value, 11800) && c.drafts.invoices - base.drafts.invoices === 1, [c.drafts, base.drafts]);
  check('STILL TO COLLECT is what the two owe (141,600)', near(c.toCollect.value - base.toCollect.value, 141600) && c.toCollect.invoices - base.toCollect.invoices === 2, [c.toCollect, base.toCollect]);

  const pay = await call('POST', `/crm/invoices/${A.inv.id}/payments`, { amount: 50000, paidOn: istDay(0), mode: 'UPI' }, auth);
  check('50,000 is received on A', pay.status === 200, pay.body);
  c = await cash();
  check('COLLECTED rises by 50,000, 1 payment', near(c.collected.value - base.collected.value, 50000) && c.collected.payments - base.collected.payments === 1, [c.collected, base.collected]);
  check('STILL TO COLLECT falls by it (91,600 more than before)', near(c.toCollect.value - base.toCollect.value, 91600), [c.toCollect, base.toCollect]);
  check('INVOICED is unchanged by a payment (still 141,600)', near(c.invoiced.value - base.invoiced.value, 141600));

  // C is past its due date: the overdue part of "still to collect"
  await DB.run('UPDATE "CrmInvoice" SET "dueDate" = ? WHERE "id" = ?', istDay(-1), C.inv.id);
  c = await cash();
  check('C, due yesterday, is the overdue part: 23,600, 1 invoice', near(c.toCollect.overdueValue - base.toCollect.overdueValue, 23600) && c.toCollect.overdueInvoices - base.toCollect.overdueInvoices === 1, [c.toCollect, base.toCollect]);

  // money that came LAST month counts last month, not this month, whatever month the invoice is from
  await DB.run('INSERT INTO "CrmPayment" ("id","invoiceId","dealId","accountId","amount","paidOn","mode","ownerId","ownerName","createdById","createdByName","createdAt","updatedAt") SELECT ?, "id", "dealId", "accountId", ?, ?, ?, "ownerId", "ownerName", "ownerId", "ownerName", ?, ? FROM "CrmInvoice" WHERE "id" = ?', 'pay_zz_last', 5000, (() => { const d = new Date(Date.now() + 5.5 * 3600000); d.setUTCDate(1); d.setUTCDate(0); return d.toISOString().slice(0, 10); })(), 'Cash', new Date().toISOString(), new Date().toISOString(), A.inv.id);
  const c2 = await cash();
  const last = await cash('last_month');
  check('a payment dated last month is NOT in this month\'s collected', near(c2.collected.value, c.collected.value), [c2.collected, c.collected]);
  check('but it is in last month\'s', near(last.collected.value - baseLast.collected.value, 5000), [last.collected, baseLast.collected]);
  check('the dashboard period changes the money: this quarter holds at least this month\'s', (await cash('quarter')).collected.value >= c2.collected.value - 0.01);

  // a cancelled invoice is not invoiced and not owed
  const D = await win('Zz Rev D', 1000);
  await call('POST', `/crm/invoices/${D.inv.id}/status`, { status: 'Sent' }, auth);
  const withD = await cash();
  await call('POST', `/crm/invoices/${D.inv.id}/status`, { status: 'Cancelled' }, auth);
  const noD = await cash();
  check('a cancelled invoice leaves invoiced and still-to-collect (1,180 each)', near(withD.invoiced.value - noD.invoiced.value, 1180) && near(withD.toCollect.value - noD.toCollect.value, 1180), [withD, noD]);

  // a Won deal whose invoice is missing
  await DB.run('DELETE FROM "CrmInvoice" WHERE "id" = ?', B.inv.id);
  const missing = await cash();
  check('a Won deal with no invoice is counted ("Won, no invoice yet")', missing.wonNoInvoice === noD.wonNoInvoice + 1, [missing.wonNoInvoice, noD.wonNoInvoice]);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

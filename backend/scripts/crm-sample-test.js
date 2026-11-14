#!/usr/bin/env node
/**
 * REMOVING THE SAMPLE DATA before go-live (crm/sample.js remove) - founder's checklist 2026-11-14: "Sample data cleanup, go-live ki ventane mundu".
 * It must take with it everything the sample records grew (an invoice raised on a sample deal, its payments), leave every REAL record and
 * every real money number alone, and give the numbers back so the first real invoice is the next number after the last real one (no gap).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4057.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-sample-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-sample-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4057;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-sample-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
const near = (a, b) => Math.abs(a - b) < 0.01;
const num = (code) => Number(String(code || '').split('-')[1]) || 0;

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
  const cash = async () => (await call('GET', '/crm/overview?period=month')).body.cash;
  const maxCode = async (table) => (await DB.all(`SELECT "code" FROM "${table}" WHERE "code" IS NOT NULL`)).reduce((m, x) => Math.max(m, num(x.code)), 0);

  // a REAL customer, deal, invoice and payment first
  const acc = await call('POST', '/crm/accounts', { name: 'ZZ Real Customer', gstin: '36ABCDE1234F1Z5', address: '1 Real Road' });
  const dReal = await call('POST', '/crm/deals', { title: 'ZZ Real Deal', accountId: acc.body.account.id, value: '50000' });
  const wReal = await call('POST', `/crm/deals/${dReal.body.deal.id}/stage`, { stage: 'Won' });
  const realInv = wReal.body.invoice;
  await call('POST', `/crm/invoices/${realInv.id}/status`, { status: 'Sent' });
  const realPay = await call('POST', `/crm/invoices/${realInv.id}/payments`, { amount: 10000, mode: 'UPI' });
  check('a real invoice with a real payment exists', realInv && realPay.status === 200, [realInv, realPay.body]);
  const lastReal = { invoice: num(realInv.code), lead: await maxCode('CrmLead'), deal: await maxCode('CrmDeal'), account: await maxCode('CrmAccount') };
  const cashReal = await cash();

  console.log('1. Sample data goes in, and the sample deals are worked on like real ones');
  const load = await call('POST', '/crm/sample');
  check('the sample data is loaded', load.status === 200 && load.body.ok, load.body);
  const st = await call('GET', '/crm/sample');
  check('and it says so (the banner reads this)', st.body.loaded === true && st.body.counts.deals > 0, st.body);
  const sampleDeals = (await call('GET', '/crm/deals')).body.rows.filter((d) => /^Sample · /.test(d.title) && !['Won', 'Lost'].includes(d.stage));
  check('there are open sample deals', sampleDeals.length > 0, sampleDeals.length);
  const sd = sampleDeals[0];
  const wSample = await call('POST', `/crm/deals/${sd.id}/stage`, { stage: 'Won' });
  const sInv = wSample.body.invoice;
  check('someone wins a sample deal: it gets an invoice, the next number', wSample.status === 200 && sInv && num(sInv.code) === lastReal.invoice + 1, sInv && sInv.code);
  await call('POST', `/crm/invoices/${sInv.id}/status`, { status: 'Sent' });
  const sPay = await call('POST', `/crm/invoices/${sInv.id}/payments`, { amount: 1000, mode: 'Cash' });
  check('and a payment on it', sPay.status === 200, sPay.body);
  const withSample = await cash();
  check('while the sample is there, the money numbers include it', withSample.collected.value > cashReal.collected.value && withSample.invoiced.value > cashReal.invoiced.value, [withSample, cashReal]);

  console.log('2. Removing it');
  const rm = await call('DELETE', '/crm/sample');
  check('the sample data is removed', rm.status === 200 && rm.body.ok && rm.body.invoicesRemoved >= 1, rm.body);
  check('its invoice and payment are gone', !(await DB.one('SELECT 1 AS x FROM "CrmInvoice" WHERE "id" = ?', sInv.id)) && !(await DB.one('SELECT 1 AS x FROM "CrmPayment" WHERE "invoiceId" = ?', sInv.id)));
  check('no invoice or payment is left pointing at a deal that is not there', Number(((await DB.one('SELECT COUNT(*) AS n FROM "CrmInvoice" i WHERE i."dealId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CrmDeal" d WHERE d."id" = i."dealId")')) || {}).n) === 0 && Number(((await DB.one('SELECT COUNT(*) AS n FROM "CrmPayment" p WHERE NOT EXISTS (SELECT 1 FROM "CrmInvoice" i WHERE i."id" = p."invoiceId")')) || {}).n) === 0);
  const after = await cash();
  check('the money numbers are the real ones again (nothing of the sample left)', near(after.invoiced.value, cashReal.invoiced.value) && near(after.collected.value, cashReal.collected.value) && near(after.toCollect.value, cashReal.toCollect.value) && near(after.booked.value, cashReal.booked.value), [after, cashReal]);
  check('the real invoice and its payment are untouched', !!(await DB.one('SELECT 1 AS x FROM "CrmInvoice" WHERE "id" = ?', realInv.id)) && !!(await DB.one('SELECT 1 AS x FROM "CrmPayment" WHERE "invoiceId" = ?', realInv.id)));
  check('the real customer and deal are untouched', !!(await DB.one('SELECT 1 AS x FROM "CrmAccount" WHERE "id" = ?', acc.body.account.id)) && !!(await DB.one('SELECT 1 AS x FROM "CrmDeal" WHERE "id" = ?', dReal.body.deal.id)));
  check('the banner is gone (nothing marked as sample any more)', (await call('GET', '/crm/sample')).body.loaded === false);
  check('and removing twice says there is nothing to remove', (await call('DELETE', '/crm/sample')).status === 400);

  console.log('3. The numbers come back');
  const d2 = await call('POST', '/crm/deals', { title: 'ZZ Real Deal 2', accountId: acc.body.account.id, value: '20000' });
  const w2 = await call('POST', `/crm/deals/${d2.body.deal.id}/stage`, { stage: 'Won' });
  check('the next real invoice is the number right after the last real one (no gap left by the sample)', w2.body.invoice && num(w2.body.invoice.code) === lastReal.invoice + 1, [w2.body.invoice && w2.body.invoice.code, lastReal.invoice]);
  check('the next real deal code follows the last real deal', num(d2.body.deal.code) === lastReal.deal + 1, [d2.body.deal.code, lastReal.deal]);
  const l2 = await call('POST', '/crm/leads', { company: 'ZZ Real Lead After', phone: '9855500001' });
  check('the next real lead code follows the last real lead', num(l2.body.lead.code) === lastReal.lead + 1, [l2.body.lead.code, lastReal.lead]);
  check('no two invoices share a code', Number(((await DB.one('SELECT COUNT(*) AS n FROM (SELECT "code" FROM "CrmInvoice" GROUP BY "code" HAVING COUNT(*) > 1)')) || {}).n) === 0);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

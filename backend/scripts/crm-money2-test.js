#!/usr/bin/env node
/**
 * THE CRM MONEY PATH, SLICE 2 (crm/money.js + crm/service.js + crm/extra.js), 2026-11-17:
 *   GST split (CGST + SGST in our state, IGST outside, unknown state -> IGST flagged; paise add up to the total; old invoices split on read),
 *   invoice number format with the Indian financial year (the March / April boundary), TDS on a payment line (balance = total - paid - TDS),
 *   a Draft invoice edited then locked once Sent, the invoice by email (not set up -> said plainly; set up -> PDF attached, CC, Draft -> Sent),
 *   the overdue invoice alert (once, then again only after 3 days), a quotation file on a deal (size / type limits), Lost -> one re-check follow-up.
 * Never touches the ATS Accounts Invoice / Client tables.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4091. Mail goes to the sandbox's fake transport (captured to a file).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-money2-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-money2-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" = 'email'");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" = 'email'"); // email NOT set up to start with
dbx.close();

const MAILS = path.join(os.tmpdir(), `zz-crm-money2-mails-${process.pid}.jsonl`);
const UPLOADS = path.join(os.tmpdir(), `zz-crm-money2-uploads-${process.pid}`);
const PORT = Number(process.env.TEST_PORT) || 4091; // TEST_PORT when 4091 is taken by another run
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-money2-test', INTEGRATION_SECRET_KEY: 'zz-crm-money2-test-integration-key',
  TL_COMM_SEND_LIMIT: '500', TEST_MAIL_CAPTURE: MAILS, UPLOAD_DIR: UPLOADS, APP_BASE_URL: `http://localhost:${PORT}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');
const MONEY = require('../src/crm/money');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 460)}` : ''}`); } };
let auth = {};
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
const upload = async (dealId, bytes, name, type, kind) => {
  const fd = new FormData();
  if (kind) fd.append('kind', kind);
  fd.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(`${API}/crm/deals/${dealId}/files`, { method: 'POST', headers: { ...auth }, body: fd }).catch((e) => ({ status: 0, json: async () => ({ error: e.message }) }));
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
const mails = () => (fs.existsSync(MAILS) ? fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const setRow = async (id, fields, enabled = true) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' } });
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const istDay = (plus = 0) => new Date(Date.now() + 5.5 * 3600000 + plus * 86400000).toISOString().slice(0, 10);
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.unlinkSync(MAILS); } catch { /* none */ }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}

(async () => {
  console.log('0. The pure rules (no server)');
  check('FY: 31 March 2026 is in 2025-26', MONEY.fyOf('2026-03-31') === '2025-26');
  check('FY: 1 April 2026 starts 2026-27', MONEY.fyOf('2026-04-01') === '2026-27');
  check('FY: January 2027 is still 2026-27, April 2099 is 2099-00', MONEY.fyOf('2027-01-15') === '2026-27' && MONEY.fyOf('2099-04-01') === '2099-00');
  check('the format INV/{FY}/{0000} with number 7 is INV/2026-27/0007', MONEY.formatInvoiceCode('INV/{FY}/{0000}', { fy: '2026-27', n: 7 }) === 'INV/2026-27/0007');
  check('{FY2} is 26-27 and the zeros are the width', MONEY.formatInvoiceCode('TL-{FY2}-{000}', { fy: '2026-27', n: 12 }) === 'TL-26-27-012');
  check('a format with no running number, two numbers or an unknown token is refused', !MONEY.validInvoiceFormat('INV/{FY}') && !MONEY.validInvoiceFormat('{00}-{00}') && !MONEY.validInvoiceFormat('INV/{YEAR}/{00}') && MONEY.validInvoiceFormat('INV/{FY}/{0000}'));
  check('the state code comes from the GSTIN (36 = Telangana)', MONEY.gstinStateCode('36ABCDE1234F1Z5') === '36' && MONEY.stateName('36') === 'Telangana');
  check('a state written as a name, a short form or a code', MONEY.stateCodeOf('Karnataka') === '29' && MONEY.stateCodeOf('TS') === '36' && MONEY.stateCodeOf('07') === '07' && MONEY.stateCodeOf('Orissa') === '21' && MONEY.stateCodeOf('Atlantis') === null);
  const odd = MONEY.gstSplit({ tax: 180.01, taxPercent: 18, from: { gstin: '36ABCDE1234F1Z5' }, billTo: { state: 'Telangana' } });
  check('same state: CGST + SGST, the odd paisa goes to CGST and the halves add up to the tax exactly', odd.mode === 'intra' && odd.cgst === 90.01 && odd.sgst === 90 && near(odd.cgst + odd.sgst, 180.01) && odd.igst === 0, odd);
  const inter = MONEY.gstSplit({ tax: 180.01, taxPercent: 18, from: { gstin: '36ABCDE1234F1Z5' }, billTo: { gstin: '29ABCDE1234F1Z5', state: 'Telangana' } });
  check('the customer\'s GSTIN decides over a state typed on the account: Karnataka -> IGST, place of supply Karnataka', inter.mode === 'inter' && inter.igst === 180.01 && inter.placeOfSupply.code === '29' && !inter.flag, inter);
  const unk = MONEY.gstSplit({ tax: 180, taxPercent: 18, from: { state: 'Telangana' }, billTo: {} });
  check('the customer\'s state unknown: IGST and flagged', unk.mode === 'inter' && unk.igst === 180 && !!unk.flag && unk.placeOfSupply === null, unk);
  const noOurs = MONEY.gstSplit({ tax: 180, taxPercent: 18, from: {}, billTo: { state: 'Telangana' } });
  check('our own state not set: IGST and flagged', noOurs.mode === 'inter' && !!noOurs.flag, noOurs);
  check('TDS 10% on Rs 1,00,000 + 18% GST paid as Rs 1,08,000 is Rs 10,000', MONEY.tdsFromPercent({ cash: 108000, percent: 10, amount: 100000, total: 118000 }) === 10000);

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
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };
  const P = process.pid;
  const mkAccount = async (name, extra = {}) => (await call('POST', '/crm/accounts', { name: `${name} ${P}`, address: '1 Road', ...extra })).body.account;
  const win = async (account, title, value) => {
    const d = await call('POST', '/crm/deals', { title: `${title} ${P}`, accountId: account.id, value: String(value) });
    const w = await call('POST', `/crm/deals/${d.body.deal.id}/stage`, { stage: 'Won' });
    return { deal: d.body.deal, inv: w.body.invoice };
  };
  const detail = async (id) => (await call('GET', `/crm/invoices/${id}`)).body.invoice;

  console.log('1. Our GSTIN, state and SAC in CRM settings');
  check('a wrong GSTIN is refused with the reason', (await call('PUT', '/crm/settings', { invoiceFrom: { name: 'TeamLink Consultants', gstin: '36BAD' } })).status === 400);
  check('a state that does not match the GSTIN is refused', (await call('PUT', '/crm/settings', { invoiceFrom: { name: 'TeamLink Consultants', gstin: '36AAACT1234A1Z5', state: 'Karnataka' } })).status === 400);
  check('an invoice number format without a running number is refused', (await call('PUT', '/crm/settings', { invoiceNumberFormat: 'INV/{FY}' })).status === 400);
  check('a SAC that is not digits is refused', (await call('PUT', '/crm/settings', { invoiceSac: 'abc' })).status === 400);
  const saved = await call('PUT', '/crm/settings', { invoiceFrom: { name: 'TeamLink Consultants', gstin: '36AAACT1234A1Z5', state: 'Telangana', address: 'Hyderabad' }, invoiceSac: '998314', invoiceTaxPercent: 18 });
  check('our GSTIN + state + SAC are saved', saved.status === 200 && saved.body.settings.invoiceFrom.gstin === '36AAACT1234A1Z5' && saved.body.settings.invoiceSac === '998314', saved.body);
  const me = (await call('GET', '/crm/me')).body;
  check('the screen reads the SAC, the format (empty: INV-0001) and the two switches', me.invoiceSac === '998314' && me.invoiceNumberFormat === '' && me.overdueInvoiceAlert === true && me.lostRecheck === true, [me.invoiceSac, me.invoiceNumberFormat, me.overdueInvoiceAlert, me.lostRecheck]);
  await new Promise((r) => { setTimeout(r, 300); });

  console.log('2. GST split on real invoices');
  const accTs = await mkAccount('ZZ Money Telangana', { state: 'Telangana' }); // no GSTIN: the state decides
  const A = await win(accTs, 'ZZ Money Intra', 1000.05);
  check('the default numbering is still INV-0001 style', /^INV-\d{4}$/.test(A.inv.code), A.inv.code);
  check('the invoice carries one line with the SAC 998314', A.inv.lines && A.inv.lines.length === 1 && A.inv.lines[0].sac === '998314' && near(A.inv.lines[0].amount, 1000.05), A.inv.lines);
  const gA = A.inv.gst;
  check('same state (Telangana, from the account): CGST + SGST at 9% each', gA.mode === 'intra' && gA.halfRate === 9 && gA.igst === 0, gA);
  check('the paise add up: CGST 90.01 + SGST 90.00 = tax 180.01, and amount + CGST + SGST = total', gA.cgst === 90.01 && gA.sgst === 90 && near(A.inv.taxAmount, 180.01) && near(A.inv.amount + gA.cgst + gA.sgst, A.inv.total), [gA.cgst, gA.sgst, A.inv.taxAmount, A.inv.total]);
  check('both GSTINs, the place of supply and the SAC are on it', gA.ourGstin === '36AAACT1234A1Z5' && gA.customerGstin === null && gA.placeOfSupply.code === '36' && gA.sac === '998314', gA);
  const accKa = await mkAccount('ZZ Money Karnataka', { gstin: '29ABCDE1234F1Z5', state: 'Karnataka' });
  const B = await win(accKa, 'ZZ Money Inter', 100000);
  check('another state (GSTIN 29): IGST 18% = the whole tax 18,000, no CGST / SGST', B.inv.gst.mode === 'inter' && B.inv.gst.igst === 18000 && B.inv.gst.cgst === 0 && B.inv.gst.placeOfSupply.name === 'Karnataka' && !B.inv.gst.flag, B.inv.gst);
  const accNone = await mkAccount('ZZ Money Nowhere');
  const C = await win(accNone, 'ZZ Money Unknown', 5000);
  check('no GSTIN and no state: IGST, with the warning on the invoice', C.inv.gst.mode === 'inter' && C.inv.gst.igst === 900 && /not known/.test(C.inv.gst.flag || ''), C.inv.gst);
  const pdfA = await fetch(`${API}/crm/invoices/${A.inv.id}/pdf`, { headers: auth });
  const bufA = Buffer.from(await pdfA.arrayBuffer());
  check('the PDF with the split still opens', pdfA.status === 200 && bufA.slice(0, 4).toString() === '%PDF' && bufA.length > 1500, [pdfA.status, bufA.length]);
  // an invoice made before this slice: no lines, an old from-copy without state / SAC
  const now = new Date().toISOString();
  await DB.run(`INSERT INTO "CrmInvoice" ("id", "code", "dealId", "accountId", "accountName", "title", "status", "issueDate", "dueDate", "amount", "taxPercent", "taxAmount", "total", "paidAmount", "fromJson", "billToJson", "ownerId", "ownerName", "createdById", "createdAt", "updatedAt")
    VALUES (?, ?, NULL, ?, ?, 'Old style invoice', 'Sent', ?, ?, 10000, 18, 1800, 11800, 0, ?, ?, ?, ?, ?, ?, ?)`, `inv_old_${P}`, `INV-OLD-${P}`, accTs.id, accTs.name, istDay(-20), istDay(10), JSON.stringify({ name: 'TeamLink Consultants', gstin: '' }), JSON.stringify({ name: accTs.name, state: 'Telangana' }), admin.id, admin.name, admin.id, now, now);
  const old = await detail(`inv_old_${P}`);
  check('an OLD invoice is split on read with our state from today\'s settings: CGST 900 + SGST 900', old && old.gst.mode === 'intra' && old.gst.cgst === 900 && old.gst.sgst === 900, old && old.gst);
  check('it shows a line made from its title, with today\'s SAC', old.lines.length === 1 && old.lines[0].description === 'Old style invoice' && old.lines[0].sac === '998314');
  const oldRaw = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', `inv_old_${P}`);
  check('and nothing on the old row was rewritten (amounts, code, no lines stored)', oldRaw.total === 11800 && oldRaw.taxAmount === 1800 && oldRaw.code === `INV-OLD-${P}` && oldRaw.linesJson == null, oldRaw);

  console.log('3. Invoice numbering by financial year');
  check('the format is saved', (await call('PUT', '/crm/settings', { invoiceNumberFormat: 'INV/{FY}/{0000}' })).status === 200);
  await new Promise((r) => { setTimeout(r, 300); });
  const F1 = await win(accTs, 'ZZ Money FY one', 1000);
  const F2 = await win(accTs, 'ZZ Money FY two', 1000);
  const fyNow = MONEY.fyOf(istDay(0));
  const n1 = Number(String(F1.inv.code).split('/').pop());
  check(`a new invoice is INV/${fyNow}/0001 style`, new RegExp(`^INV/${fyNow}/\\d{4}$`).test(F1.inv.code), F1.inv.code);
  check('the next one has the next number', F2.inv.code === `INV/${fyNow}/${String(n1 + 1).padStart(4, '0')}`, [F1.inv.code, F2.inv.code]);
  check('the invoices made before keep their INV-0001 style codes', (await detail(A.inv.id)).code === A.inv.code && /^INV-\d{4}$/.test(A.inv.code));
  // Won deals with no invoice yet, won on 31 March and on 1 April: "Create missing invoices" dates each the day it was won
  const mkWonNoInvoice = async (title, wonAt) => {
    const d = (await call('POST', '/crm/deals', { title: `${title} ${P}`, accountId: accTs.id, value: '2000' })).body.deal;
    await DB.run('UPDATE "CrmDeal" SET "stage" = \'Won\', "wonAt" = ? WHERE "id" = ?', wonAt, d.id);
    return d;
  };
  const march = await mkWonNoInvoice('ZZ Money March', '2026-03-31T09:00:00.000Z');
  const april = await mkWonNoInvoice('ZZ Money April', '2026-04-01T06:00:00.000Z');
  const bf = await call('POST', '/crm/invoices/backfill');
  check('the missing invoices are made', bf.status === 200 && bf.body.created >= 2, bf.body);
  const invMarch = (await call('GET', `/crm/invoices?dealId=${march.id}`)).body.invoices[0];
  const invApril = (await call('GET', `/crm/invoices?dealId=${april.id}`)).body.invoices[0];
  check('won 31 March 2026: numbered in FY 2025-26', invMarch && invMarch.issueDate === '2026-03-31' && /^INV\/2025-26\/\d{4}$/.test(invMarch.code), invMarch && [invMarch.issueDate, invMarch.code]);
  check('won 1 April 2026: numbered in FY 2026-27 (the number started again for the new year)', invApril && invApril.issueDate === '2026-04-01' && /^INV\/2026-27\/\d{4}$/.test(invApril.code), invApril && [invApril.issueDate, invApril.code]);
  check('the two years keep their own counters (2025-26 starts at 0001)', invMarch && invMarch.code === 'INV/2025-26/0001', invMarch && invMarch.code);
  check('the format can be cleared: INV-0001 style again', (await call('PUT', '/crm/settings', { invoiceNumberFormat: '' })).status === 200);
  await new Promise((r) => { setTimeout(r, 300); });
  const F3 = await win(accTs, 'ZZ Money Back to INV', 1000);
  check('the next invoice is INV-0001 style again', /^INV-\d{4}$/.test(F3.inv.code), F3.inv.code);

  console.log('4. A Draft is edited; once Sent it is read-only');
  const E = await win(accTs, 'ZZ Money Edit', 5000);
  const PUTE = `/crm/invoices/${E.inv.id}`;
  check('a line with no description is refused', (await call('PUT', PUTE, { lines: [{ description: '', qty: 1, rate: 10 }] })).status === 400);
  check('a bad SAC is refused', (await call('PUT', PUTE, { lines: [{ description: 'X', sac: '12', qty: 1, rate: 10 }] })).status === 400);
  check('a quantity of 0 is refused', (await call('PUT', PUTE, { lines: [{ description: 'X', qty: 0, rate: 10 }] })).status === 400);
  check('a due date before the invoice date is refused', (await call('PUT', PUTE, { dueDate: '2000-01-01' })).status === 400);
  const ed = await call('PUT', PUTE, { lines: [{ description: 'Website design', sac: '998314', qty: 2, rate: 1000.5 }, { description: 'Hosting setup', sac: '998315', qty: 1, rate: 99.99 }], notes: 'Thank you for your business', dueDate: istDay(30) });
  const ei = ed.body && ed.body.invoice;
  check('the lines are saved and the totals worked out again: 2,100.99 + 18% (378.18) = 2,479.17', ed.status === 200 && ei.lines.length === 2 && near(ei.amount, 2100.99) && near(ei.taxAmount, 378.18) && near(ei.total, 2479.17), ei && [ei.amount, ei.taxAmount, ei.total]);
  check('notes, due date and both SACs are on it, and the split still adds up', ei.notes === 'Thank you for your business' && ei.dueDate === istDay(30) && ei.gst.sac === '998314, 998315' && near(ei.gst.cgst + ei.gst.sgst, ei.taxAmount), ei && [ei.notes, ei.dueDate, ei.gst]);
  check('the edit is in the audit log', (await prisma.auditLog.count({ where: { action: 'CRM invoice draft changed', entityId: E.inv.id } })) === 1);
  await call('POST', `/crm/invoices/${E.inv.id}/status`, { status: 'Sent' });
  const locked = await call('PUT', PUTE, { notes: 'changed after sending' });
  check('once Sent the invoice cannot be edited (409, locked)', locked.status === 409 && locked.body.locked === true, locked.body);
  check('and nothing changed', (await detail(E.inv.id)).notes === 'Thank you for your business');

  console.log('5. TDS on a payment line');
  const accTds = await mkAccount('ZZ Money TDS', { gstin: '36ABCDE1234F1Z5' });
  const T = await win(accTds, 'ZZ Money TDS deal', 100000);
  await call('POST', `/crm/invoices/${T.inv.id}/status`, { status: 'Sent' });
  const cash0 = (await call('GET', '/crm/overview?period=month')).body.cash;
  const PAY = `/crm/invoices/${T.inv.id}/payments`;
  check('a TDS % over 30 is refused', (await call('POST', PAY, { amount: 108000, tdsPercent: 45 })).status === 400);
  const tooMuch = await call('POST', PAY, { amount: 110000, tdsAmount: 10000 });
  check('cash + TDS more than what is owed is refused, and says how much is left', tooMuch.status === 400 && tooMuch.body.left === 118000, tooMuch.body);
  const t1 = await call('POST', PAY, { amount: 108000, tdsPercent: 10, tdsRef: 'Form16A-Q3-0042', mode: 'Bank transfer', reference: 'UTR998' });
  const ti = t1.body && t1.body.invoice;
  check('Rs 1,08,000 received with 10% TDS: TDS is Rs 10,000 and the invoice is settled (Paid, balance 0)', t1.status === 200 && ti.status === 'Paid' && ti.paidAmount === 108000 && ti.tdsAmount === 10000 && ti.balance === 0, ti && [ti.status, ti.paidAmount, ti.tdsAmount, ti.balance]);
  check('the line keeps the TDS, its % and the certificate', ti.payments[0].tdsAmount === 10000 && ti.payments[0].tdsPercent === 10 && ti.payments[0].tdsRef === 'Form16A-Q3-0042', ti.payments[0]);
  const cash1 = (await call('GET', '/crm/overview?period=month')).body.cash;
  check('COLLECTED rises by the cash only (1,08,000), TDS deducted by 10,000', near(cash1.collected.value - cash0.collected.value, 108000) && near(cash1.tds.value - cash0.tds.value, 10000), [cash1.collected, cash0.collected, cash1.tds, cash0.tds]);
  check('nothing is left to collect on it (TDS counts as settled)', near(cash1.toCollect.value - cash0.toCollect.value, -118000), [cash1.toCollect, cash0.toCollect]);
  await call('DELETE', `${PAY}/${ti.payments[0].id}`);
  const t2 = await call('POST', PAY, { amount: 50000, tdsAmount: 5000 });
  check('a part payment with Rs 5,000 TDS in rupees: Partly paid, balance = 1,18,000 - 50,000 - 5,000 = 63,000', t2.status === 200 && t2.body.invoice.status === 'Partly paid' && t2.body.invoice.balance === 63000 && t2.body.invoice.tdsAmount === 5000, t2.body.invoice && [t2.body.invoice.status, t2.body.invoice.balance]);
  const tl = (await call('GET', `/crm/deals/${T.deal.id}`)).body.activities;
  check('the timeline says the TDS', tl.some((a) => /Payment of 50000 received .*TDS 5000 deducted/.test(a.subject || '')), tl.map((a) => a.subject));
  const markPaid = await call('POST', `/crm/invoices/${T.inv.id}/status`, { status: 'Paid' });
  check('Mark as paid writes only the cash still due (63,000), the TDS stays', markPaid.status === 200 && markPaid.body.invoice.status === 'Paid' && markPaid.body.invoice.paidAmount === 113000 && markPaid.body.invoice.tdsAmount === 5000 && markPaid.body.invoice.balance === 0, markPaid.body.invoice && [markPaid.body.invoice.paidAmount, markPaid.body.invoice.tdsAmount]);
  const tdsOnly = await win(accTds, 'ZZ Money TDS only', 1000);
  check('a line of TDS alone (no cash) is accepted', (await call('POST', `/crm/invoices/${tdsOnly.inv.id}/payments`, { amount: 0, tdsAmount: 100 })).body.invoice.balance === 1080);
  check('a line with neither cash nor TDS is refused', (await call('POST', `/crm/invoices/${tdsOnly.inv.id}/payments`, { amount: 0 })).status === 400);
  const cols = await DB.all('PRAGMA table_info("CrmPayment")');
  check('the payment table has its TDS columns', ['tdsAmount', 'tdsPercent', 'tdsRef'].every((c) => cols.some((x) => x.name === c)));

  console.log('6. The invoice by email');
  const M = await win(accTs, 'ZZ Money Mail', 20000);
  await call('POST', '/crm/contacts', { accountId: accTs.id, name: 'Kiran Rao', role: 'Decision maker', email: `kiran.${P}@zz-money2-test.in` });
  const dr0 = (await call('GET', `/crm/invoices/${M.inv.id}/email-draft`)).body;
  check('the email starts with the decision maker\'s address and says mail is not set up', dr0.to === `kiran.${P}@zz-money2-test.in` && dr0.mailReady === false && !!dr0.mailReason, dr0);
  const e0 = await call('POST', `/crm/invoices/${M.inv.id}/email`, { to: dr0.to, subject: dr0.subject, text: dr0.text });
  check('sending is refused with a plain "not set up" (409), nothing pretended', e0.status === 409 && e0.body.notConfigured === true && /not set up/.test(e0.body.error), e0.body);
  check('and the invoice is still a Draft', (await detail(M.inv.id)).status === 'Draft');
  await setRow('email', { 'SMTP host': 'smtp.zz-money2.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'crm@zz-money2.invalid', 'Default from name': 'TeamLink' });
  await new Promise((r) => { setTimeout(r, 400); });
  check('now the draft says mail is ready', (await call('GET', `/crm/invoices/${M.inv.id}/email-draft`)).body.mailReady === true);
  check('a CC that is not an address is refused', (await call('POST', `/crm/invoices/${M.inv.id}/email`, { to: dr0.to, cc: 'not-an-address', subject: 'S', text: 'T' })).status === 400);
  const e1 = await call('POST', `/crm/invoices/${M.inv.id}/email`, { to: dr0.to, cc: `accounts.${P}@zz-money2-test.in`, subject: `Invoice ${M.inv.code} for you`, text: 'Please find the invoice attached.' });
  check('the email goes', e1.status === 200 && e1.body.ok && e1.body.status === 'Sent', e1.body);
  const sentMail = mails().filter((m) => m.subject === `Invoice ${M.inv.code} for you`);
  check('the mail server was handed it once: To, CC, and the invoice PDF attached', sentMail.length === 1 && String(sentMail[0].to).includes(dr0.to) && sentMail[0].cc.some((c) => c.includes(`accounts.${P}@`)) && sentMail[0].attachments.length === 1 && sentMail[0].attachments[0].pdf === true && /\.pdf$/.test(sentMail[0].attachments[0].filename), sentMail[0]);
  check('the Draft became Sent', (await detail(M.inv.id)).status === 'Sent');
  const mtl = (await call('GET', `/crm/deals/${M.deal.id}`)).body.activities;
  check('it is on the deal\'s timeline with the CC', mtl.some((a) => a.kind === 'email' && /emailed/.test(a.subject || '') && /CC accounts\./.test(a.note || '')), mtl.map((a) => a.subject));
  check('a sent invoice can be emailed again and stays Sent', (await call('POST', `/crm/invoices/${M.inv.id}/email`, { to: dr0.to, subject: 'Reminder', text: 'Reminder' })).body.status === 'Sent');

  console.log('7. Overdue invoice -> one alert');
  const O = await win(accTs, 'ZZ Money Overdue', 30000);
  await call('POST', `/crm/invoices/${O.inv.id}/status`, { status: 'Sent' });
  await DB.run('UPDATE "CrmInvoice" SET "dueDate" = ? WHERE "id" = ?', istDay(-5), O.inv.id);
  const paidLate = await win(accTs, 'ZZ Money Overdue Paid', 1000);
  await call('POST', `/crm/invoices/${paidLate.inv.id}/status`, { status: 'Paid' });
  await DB.run('UPDATE "CrmInvoice" SET "dueDate" = ? WHERE "id" = ?', istDay(-5), paidLate.inv.id);
  const draftLate = await win(accTs, 'ZZ Money Overdue Draft', 1000);
  await DB.run('UPDATE "CrmInvoice" SET "dueDate" = ? WHERE "id" = ?', istDay(-5), draftLate.inv.id);
  const listed = (await call('GET', '/crm/invoices')).body.invoices;
  check('the list marks it overdue (red), and not the paid one', listed.find((x) => x.id === O.inv.id).overdue === true && listed.find((x) => x.id === paidLate.inv.id).overdue === false);
  await SETTINGS.load({ fresh: true });
  const bells = [];
  const stub = async (to, msg) => { bells.push({ to, ...msg }); };
  await MONEY.escalateOverdueInvoices({ notify: stub });
  const ours = bells.filter((b) => b.title.includes(O.inv.code));
  check('one bell for the overdue invoice, to its owner (and the Sales managers), with the balance and the days late', ours.length === 1 && ours[0].to.includes(O.inv.ownerId) && /Rs\. 35,400 still to come/.test(ours[0].message) && /5 days late/.test(ours[0].message) && ours[0].message.includes(`/crm/deals?open=deal:${O.deal.id}`), ours);
  check('nothing for the paid one or the draft', !bells.some((b) => b.title.includes(paidLate.inv.code) || b.title.includes(draftLate.inv.code)));
  bells.length = 0;
  await MONEY.escalateOverdueInvoices({ notify: stub });
  check('a second pass the same day tells nothing again', !bells.some((b) => b.title.includes(O.inv.code)), bells.map((b) => b.title));
  await MONEY.escalateOverdueInvoices({ notify: stub, now: Date.now() + 2 * 86400000 });
  check('two days on: still nothing (once per 3 days)', !bells.some((b) => b.title.includes(O.inv.code)));
  await MONEY.escalateOverdueInvoices({ notify: stub, now: Date.now() + 3 * 86400000 + 60000 });
  check('three days on: told again, once', bells.filter((b) => b.title.includes(O.inv.code)).length === 1, bells.map((b) => b.title));
  await call('POST', `/crm/invoices/${O.inv.id}/status`, { status: 'Paid' });
  bells.length = 0;
  await MONEY.escalateOverdueInvoices({ notify: stub, now: Date.now() + 9 * 86400000 });
  check('once it is paid it is never told again', !bells.some((b) => b.title.includes(O.inv.code)));

  console.log('8. A quotation file on a deal');
  const Q = (await call('POST', '/crm/deals', { title: `ZZ Money Quote ${P}`, accountId: accTs.id, value: '1000' })).body.deal;
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF')]);
  const up = await upload(Q.id, pdfBytes, 'Quotation v1.pdf', 'application/pdf', 'Quotation');
  check('a PDF quotation is kept', up.status === 200 && up.body.file && up.body.file.name === 'Quotation v1.pdf' && up.body.file.kind === 'Quotation' && up.body.file.size === pdfBytes.length, up.body);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500, 1)]);
  const up2 = await upload(Q.id, docx, 'quote.docx', 'application/octet-stream');
  check('a Word file the browser did not name is known by its .docx and kept', up2.status === 200 && /wordprocessingml/.test(up2.body.file.mime), up2.body);
  check('an HTML file is refused (type)', (await upload(Q.id, Buffer.from('<html><body>hi</body></html>'), 'quote.html', 'text/html')).status === 400);
  check('an exe is refused', (await upload(Q.id, Buffer.from('MZ\x90\x00'), 'setup.exe', 'application/x-msdownload')).status === 400);
  const fake = await upload(Q.id, Buffer.from('<html>not a pdf</html>'), 'fake.pdf', 'application/pdf');
  check('a "PDF" whose bytes are not a PDF is refused', fake.status === 400 && /do not match/.test(fake.body.error || ''), fake.body);
  const big = await upload(Q.id, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 100, 0x20)]), 'huge.pdf', 'application/pdf');
  check('a file over 10 MB is refused with the limit said (413)', big.status === 413 && /10 MB/.test(big.body && big.body.error), big);
  const lst = await call('GET', `/crm/deals/${Q.id}/files`);
  check('the deal lists the two files kept, nothing of the refused ones', lst.status === 200 && lst.body.files.length === 2 && lst.body.canEdit === true, lst.body);
  const dl = await fetch(`${API}/crm/deal-files/${up.body.file.id}`, { headers: auth });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  check('the download gives the same bytes, as an attachment', dl.status === 200 && dlBuf.equals(pdfBytes) && /attachment; filename="Quotation v1.pdf"/.test(dl.headers.get('content-disposition') || ''), [dl.status, dlBuf.length]);
  check('the download needs a login', (await fetch(`${API}/crm/deal-files/${up.body.file.id}`)).status === 401);
  check('the upload is on the deal timeline', (await call('GET', `/crm/deals/${Q.id}`)).body.activities.some((a) => /Quotation uploaded: Quotation v1\.pdf/.test(a.subject || '')));
  const del = await call('DELETE', `/crm/deal-files/${up.body.file.id}`);
  check('it can be deleted', del.status === 200 && (await call('GET', `/crm/deals/${Q.id}/files`)).body.files.length === 1);
  check('a deleted file does not download', (await fetch(`${API}/crm/deal-files/${up.body.file.id}`, { headers: auth })).status === 404);
  check('a deal that is not there has no files', (await call('GET', '/crm/deals/deal_nope/files')).status === 404);

  console.log('9. Lost -> a re-check follow-up 3 months on');
  const L = (await call('POST', '/crm/deals', { title: `ZZ Money Lost ${P}`, accountId: accKa.id, value: '1000' })).body.deal;
  check('Lost still needs the reason', (await call('POST', `/crm/deals/${L.id}/stage`, { stage: 'Lost' })).status === 400);
  const lost = await call('POST', `/crm/deals/${L.id}/stage`, { stage: 'Lost', lostReason: 'Price / fee too high' });
  const rc = lost.body && lost.body.recheck;
  const in90 = new Date(Date.parse(`${istDay(0)}T00:00:00Z`) + 90 * 86400000).toISOString().slice(0, 10);
  check('the move answers with the re-check follow-up, 90 days on, for the deal owner', lost.status === 200 && rc && rc.dueDate === in90 && rc.ownerId === L.ownerId && rc.dealId === L.id && rc.origin === 'lost-recheck', rc);
  check('its title names the account and the reason', rc && rc.title === `Re-check ${accKa.name}: lost because Price / fee too high`, rc && rc.title);
  await call('POST', `/crm/deals/${L.id}/stage`, { stage: 'Meeting' });
  await call('POST', `/crm/deals/${L.id}/stage`, { stage: 'Lost', lostReason: 'No response' });
  const rcs = await DB.all('SELECT * FROM "CrmTask" WHERE "dealId" = ? AND "origin" = \'lost-recheck\'', L.id);
  check('lost again: still exactly one open re-check (idempotent)', rcs.length === 1 && rcs[0].status === 'Open', rcs.map((t) => [t.title, t.status]));
  check('turned off in CRM settings', (await call('PUT', '/crm/settings', { lostRecheck: false })).status === 200);
  await new Promise((r) => { setTimeout(r, 300); });
  const L2 = (await call('POST', '/crm/deals', { title: `ZZ Money Lost Off ${P}`, accountId: accKa.id, value: '1000' })).body.deal;
  const lost2 = await call('POST', `/crm/deals/${L2.id}/stage`, { stage: 'Lost', lostReason: 'Hiring on hold' });
  check('with it off, Lost makes no re-check', lost2.status === 200 && !lost2.body.recheck && Number((await DB.one('SELECT COUNT(*) AS n FROM "CrmTask" WHERE "dealId" = ?', L2.id)).n) === 0);
  await call('PUT', '/crm/settings', { lostRecheck: true });

  console.log('10. Kept apart from ATS Accounts');
  check('no ATS Accounts invoice was made', (await prisma.invoice.count()) === atsInvoicesBefore);
  check('no ATS client was made', (await prisma.client.count()) === atsClientsBefore);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

#!/usr/bin/env node
/**
 * CRM WAVE D (2026-11-24): Deals & Pipeline, Products / Quotes / Invoicing, Collaboration & Security, India must-haves.
 * One section per gap ID of crm-gaps-D.tsv. Wrong-role refusals and the sales-team scope are checked in each.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database (TEST_PORT, default 4561). No real message, call or payment:
 * the Razorpay link is the sandbox stub, the webhook is signed here with a test secret.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> node scripts/crm-D-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-D-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"AppSetting\" WHERE \"key\" LIKE 'crm.plus.%'");
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" = 'payments'");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" = 'payments'");
dbx.close();
const PORT = Number(process.env.TEST_PORT) || 4561;
const API = `http://localhost:${PORT}/api`;
const MAILS = path.join(os.tmpdir(), `zz-crm-D-mails-${process.pid}.jsonl`);
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-D-test', INTEGRATION_SECRET_KEY: 'zz-crm-D-test-integration-key',
  TEST_MAIL_CAPTURE: MAILS, APP_BASE_URL: `http://localhost:${PORT}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, body, token, extraHeaders = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  let j = null; let text = null;
  if (/json/.test(type)) { try { j = await r.json(); } catch { /* none */ } } else text = await r.text();
  return { status: r.status, body: j, text, type };
};
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const P = process.pid;
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ D ${tag} ${P}`, email: `zz.crmd.${tag}.${P}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
let qrAvailable = true; try { require.resolve('qrcode', { paths: [BACK] }); } catch { qrAvailable = false; } // the QR picture needs the qrcode package
const thisMonth = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
const inMonth = `${thisMonth}-25`;
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.unlinkSync(MAILS); } catch { /* none */ } process.exit(code); }, 800);
}

(async () => {
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const T = await mkUser('teamlead', { role: 'EMPLOYEE' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const V = await mkUser('viewer', { role: 'EMPLOYEE' });
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const O = await mkUser('outsider', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const tk = {}; for (const [k, u] of Object.entries({ A, B, T, M, V, X, O })) tk[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  await new Promise((r) => { setTimeout(r, 800); });

  const own = { create: true, edit: true, delete: false, import: false, export: true, reports: false };
  const put = await call('PUT', '/crm/settings', { salesTeam: [
    { userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own }, { userId: T.id, name: T.name, role: 'rep', rights: { ...own, export: false } },
    { userId: M.id, name: M.name, role: 'manager' }, { userId: V.id, name: V.name, role: 'viewer' },
  ] }, tk.X);
  check('setup: the Admin lists two salespeople, a salesperson who will lead a sub-team, a Sales manager and a Viewer', put.status === 200, put.body);
  await new Promise((r) => { setTimeout(r, 300); });
  check('a BDE who is not on the CRM list cannot reach any wave-D screen', (await call('GET', '/crm/plus/config', null, tk.O)).status === 403);
  const acc = async (name, extra = {}, token = tk.A) => (await call('POST', '/crm/accounts', { name: `${name} ${P}`, address: '1 Road', ...extra }, token)).body.account;
  const deal = async (title, accountId, extra = {}, token = tk.A) => call('POST', '/crm/deals', { title: `${title} ${P}`, accountId, ...extra }, token);
  const move = (id, stage, token = tk.A, lostReason) => call('POST', `/crm/deals/${id}/stage`, { stage, lostReason }, token);

  console.log('03.02 / 03.03 Several pipelines, admin-defined stages');
  const cfg0 = await call('GET', '/crm/plus/config', null, tk.A);
  check('the first pipeline is the Sales pipeline with the six open stages the reports use', cfg0.status === 200 && cfg0.body.pipelines.length === 1 && cfg0.body.pipelines[0].stages.length === 6 && cfg0.body.pipelines[0].allStages.includes('Won'), cfg0.body && cfg0.body.pipelines);
  const defStages = cfg0.body.pipelines[0].stages.map((s) => ({ name: s.name, required: [], checklist: [] }));
  const withDemo = [...defStages.slice(0, 3), { name: 'Demo given', probability: 45, required: ['value'], checklist: ['Demo recorded', 'Pricing shared'], mustTick: true }, ...defStages.slice(3)];
  const pls = [{ id: 'default', name: 'Sales pipeline', stages: withDemo }, { id: 'products', name: 'Products', stages: [{ name: 'Enquiry' }, { name: 'Demo' }, { name: 'Quote', required: ['lines', 'expectedClose'] }, { name: 'Closing', probability: 85 }] }];
  check('a Salesperson cannot change the pipelines', (await call('PUT', '/crm/plus/pipelines', { pipelines: pls }, tk.A)).status === 403);
  const savedPl = await call('PUT', '/crm/plus/pipelines', { pipelines: pls }, tk.M);
  check('the Sales manager adds a stage "Demo given" to the Sales pipeline and a second pipeline "Products" with its own stages', savedPl.status === 200 && savedPl.body.pipelines.length === 2 && savedPl.body.pipelines[0].stages.some((s) => s.name === 'Demo given') && savedPl.body.pipelines[1].stages.map((s) => s.name).join(',') === 'Enquiry,Demo,Quote,Closing', savedPl.body);
  const reorder = await call('PUT', '/crm/plus/pipelines', { pipelines: [{ id: 'default', name: 'Sales pipeline', stages: [...withDemo].reverse() }, pls[1]] }, tk.M);
  check('the core stages of the first pipeline keep their order even when sent reversed (reports read them)', reorder.status === 200 && reorder.body.pipelines[0].stages.filter((s) => s.core).map((s) => s.name).join(',') === 'Prospecting,Contacted,Meeting,Requirement discussed,Proposal sent,Negotiation', reorder.body.pipelines[0].stages.map((s) => s.name));
  await call('PUT', '/crm/plus/pipelines', { pipelines: pls }, tk.M);
  const a1 = await acc('ZZ D Alpha', { state: 'Karnataka', city: 'Bengaluru', industry: 'IT' });
  const pd = await deal('ZZ D Products deal', a1.id, { pipelineId: 'products' });
  check('a deal made in the Products pipeline stands on its first stage', pd.status === 200 && pd.body.deal.pipelineId === 'products' && pd.body.deal.stage === 'Enquiry', pd.body);
  check('a stage of another pipeline is refused for it', (await move(pd.body.deal.id, 'Prospecting')).status === 400);
  check('an unknown pipeline is refused on a new deal', (await deal('ZZ D Bad pipeline', a1.id, { pipelineId: 'nope' })).status === 400);
  const pdDemo = await move(pd.body.deal.id, 'Demo');
  check('it moves along its own stages, with the probability of that pipeline\'s stage', pdDemo.status === 200 && pdDemo.body.deal.stage === 'Demo' && pdDemo.body.deal.probability > 0, pdDemo.body);

  console.log('03.10 Required fields and checklists per stage (guided selling)');
  const toQuote = await move(pd.body.deal.id, 'Quote');
  check('entering "Quote" without product lines and a close date is refused, naming what is missing', toQuote.status === 400 && (toQuote.body.missing || []).includes('Product lines') && (toQuote.body.missing || []).includes('Expected close date'), toQuote.body);
  const dd = await deal('ZZ D Default deal', a1.id, { value: 0 });
  const D1 = dd.body.deal;
  await move(D1.id, 'Meeting');
  const toDemo = await move(D1.id, 'Demo given');
  check('entering "Demo given" needs the deal value', toDemo.status === 400 && (toDemo.body.missing || []).includes('Deal value'), toDemo.body);
  await call('PUT', `/crm/deals/${D1.id}`, { value: 200000 }, tk.A);
  check('with the value filled in it moves', (await move(D1.id, 'Demo given')).status === 200);
  const rm = await call('PUT', '/crm/plus/pipelines', { pipelines: [{ id: 'default', name: 'Sales pipeline', stages: defStages }, pls[1]] }, tk.M);
  check('a stage that still has an open deal cannot be removed', rm.status === 400 && /still has/.test(rm.body.error), rm.body);
  const fwd = await move(D1.id, 'Requirement discussed');
  check('leaving "Demo given" forward needs its checklist ticked (a must for this stage)', fwd.status === 400 && (fwd.body.checklist || []).length === 2, fwd.body);
  check('a wrong checklist item is refused', (await call('POST', `/crm/plus/deals/${D1.id}/checklist`, { stage: 'Demo given', item: 'Nope', done: true }, tk.A)).status === 400);
  check('B cannot tick A\'s checklist', (await call('POST', `/crm/plus/deals/${D1.id}/checklist`, { stage: 'Demo given', item: 'Demo recorded', done: true }, tk.B)).status === 404);
  await call('POST', `/crm/plus/deals/${D1.id}/checklist`, { stage: 'Demo given', item: 'Demo recorded', done: true }, tk.A);
  const tk2 = await call('POST', `/crm/plus/deals/${D1.id}/checklist`, { stage: 'Demo given', item: 'Pricing shared', done: true }, tk.A);
  check('A ticks both items (who and when kept)', tk2.status === 200 && tk2.body.ticks['Demo given']['Pricing shared'].by === A.name, tk2.body);
  check('then the deal moves on', (await move(D1.id, 'Requirement discussed')).status === 200);
  check('Lost is always allowed (with its reason)', (await move(pd.body.deal.id, 'Lost', tk.A, 'No response')).status === 200);

  console.log('03.15 Stage history and time in stage');
  const hist = await call('GET', `/crm/plus/deals/${D1.id}/stages`, null, tk.A);
  check('the deal\'s stage history lists every stage it stood on, in order, with days and who moved it', hist.status === 200 && hist.body.history.map((h) => h.stage).join('>') === 'Prospecting>Meeting>Demo given>Requirement discussed' && hist.body.history.every((h) => typeof h.days === 'number') && hist.body.history[1].byName === A.name, hist.body && hist.body.history);
  check('the current stage and since when', hist.body.history[hist.body.history.length - 1].current === true && !!hist.body.stageSince && hist.body.daysInStage >= 0);
  const list = await call('GET', '/crm/deals', null, tk.A);
  check('the deal list carries "on this stage since" for the board', list.status === 200 && list.body.rows.find((x) => x.id === D1.id).stageSince === hist.body.stageSince, list.body.rows && list.body.rows.find((x) => x.id === D1.id));
  // an old deal (before the stage log): its history comes from the "Stage:" lines of its timeline
  const oldId = `deal_old_${P}`;
  const t0 = new Date(Date.now() - 20 * 86400e3).toISOString(); const t1 = new Date(Date.now() - 12 * 86400e3).toISOString();
  await prisma.$executeRawUnsafe('INSERT INTO "CrmDeal" ("id","title","accountId","stage","value","probability","ownerId","ownerName","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)', oldId, `ZZ D Old ${P}`, a1.id, 'Meeting', 1000, 40, A.id, A.name, A.id, t0, t1);
  await prisma.$executeRawUnsafe('INSERT INTO "CrmActivity" ("id","kind","subject","at","dealId","byId","byName","createdAt") VALUES (?,?,?,?,?,?,?,?)', `act_old_${P}`, 'note', 'Stage: Prospecting → Meeting', t1, oldId, A.id, A.name, t1);
  const oh = await call('GET', `/crm/plus/deals/${oldId}/stages`, null, tk.A);
  check('an old deal\'s history is worked out from its timeline: 8 days on Prospecting, then Meeting', oh.status === 200 && oh.body.history.length === 2 && Math.round(oh.body.history[0].days) === 8 && oh.body.history[1].stage === 'Meeting', oh.body && oh.body.history);
  check('B cannot read A\'s deal history', (await call('GET', `/crm/plus/deals/${D1.id}/stages`, null, tk.B)).status === 404);

  console.log('03.14 Bulk edit of deals');
  const d2 = (await deal('ZZ D Bulk 2', a1.id, { value: 50000 })).body.deal;
  const bB = await acc('ZZ D Beta', { state: 'Telangana', city: 'Hyderabad' }, tk.B);
  const dB = (await deal('ZZ D B deal', bB.id, { value: 70000, expectedClose: inMonth }, tk.B)).body.deal;
  const bulk = await call('POST', '/crm/plus/deals/bulk', { ids: [D1.id, d2.id], set: { expectedClose: inMonth, forecastCategory: 'Commit' } }, tk.A);
  check('A changes the close date and forecast category of two deals at once', bulk.status === 200 && bulk.body.changed === 2, bulk.body);
  check('both are changed', (await call('GET', `/crm/deals/${d2.id}`, null, tk.A)).body.deal.forecastCategory === 'Commit');
  const bulkMix = await call('POST', '/crm/plus/deals/bulk', { ids: [d2.id, dB.id], set: { probability: 55 } }, tk.A);
  check('a deal that is not A\'s is skipped and named, the rest is changed', bulkMix.status === 200 && bulkMix.body.changed === 1 && bulkMix.body.failed.length === 1 && bulkMix.body.failed[0].id === dB.id, bulkMix.body);
  check('a Salesperson cannot hand deals to someone else in bulk', (await call('POST', '/crm/plus/deals/bulk', { ids: [d2.id], set: { ownerId: B.id } }, tk.A)).status === 403);
  check('a Viewer cannot bulk edit', (await call('POST', '/crm/plus/deals/bulk', { ids: [d2.id], set: { probability: 20 } }, tk.V)).status === 403);
  const bulkStage = await call('POST', '/crm/plus/deals/bulk', { ids: [d2.id], set: { stage: 'Contacted' } }, tk.M);
  check('the manager moves stages in bulk (through the same stage rules)', bulkStage.status === 200 && bulkStage.body.changed === 1, bulkStage.body);
  check('a bad forecast category is refused', (await call('POST', '/crm/plus/deals/bulk', { ids: [d2.id], set: { forecastCategory: 'Maybe' } }, tk.A)).status === 400);

  console.log('04.02 / 04.03 / 04.12 Price books, product lines on a deal, CPQ rules');
  const cat = await call('GET', '/crm/plus/catalogue', null, tk.A);
  const growth = cat.body.catalogue.find((c) => c.productKey === 'HRMS' && c.plan === 'Growth');
  check('the catalogue lists our products\' plans with list prices and billing (HRMS Growth Rs 99 a month)', cat.status === 200 && growth && growth.listPrice === 99 && growth.billing === 'Monthly', growth);
  check('a Salesperson cannot change price books', (await call('PUT', '/crm/plus/pricebooks', { books: [] }, tk.A)).status === 403);
  const pb = await call('PUT', '/crm/plus/pricebooks', { books: [{ id: 'south', name: 'South India', states: ['Karnataka'], entries: [{ productKey: 'HRMS', plan: 'Growth', price: 89 }] }, { id: 'std', name: 'Standard', isDefault: true, entries: [] }] }, tk.M);
  check('the manager makes a South India price book (Karnataka) and a default one', pb.status === 200 && pb.body.books.length === 2, pb.body);
  const cpq = await call('PUT', '/crm/plus/cpq', { requires: [{ productKey: 'OMNI', needs: 'ATS', message: 'Omni-Channel is sold with an ATS plan.' }], volume: [{ productKey: 'HRMS', minQty: 100, discountPercent: 5 }], bundles: [{ id: 'starter', name: 'Starter pack', discountPercent: 10, items: [{ productKey: 'HRMS', plan: 'Starter', qty: 50 }, { productKey: 'ATS', plan: 'Starter', qty: 1 }] }] }, tk.M);
  check('the manager sets a needs-rule, a volume discount and a bundle', cpq.status === 200 && cpq.body.cpq.bundles.length === 1 && cpq.body.cpq.volume.length === 1, cpq.body);
  const D3 = (await deal('ZZ D Lines', a1.id, { billing: 'Monthly', termMonths: 12, expectedClose: inMonth })).body.deal;
  const ln0 = await call('GET', `/crm/plus/deals/${D3.id}/lines`, null, tk.A);
  check('a Karnataka customer\'s deal is priced from the South India book (HRMS Growth Rs 89)', ln0.status === 200 && ln0.body.priceBook && ln0.body.priceBook.id === 'south' && ln0.body.catalogue.find((c) => c.productKey === 'HRMS' && c.plan === 'Growth').price === 89, ln0.body && ln0.body.priceBook);
  const needs = await call('PUT', `/crm/plus/deals/${D3.id}/lines`, { lines: [{ productKey: 'OMNI', plan: 'Starter', name: 'Omni Starter', qty: 1, unitPrice: 2999, billing: 'Monthly' }] }, tk.A);
  check('Omni-Channel without an ATS line is refused by the needs-rule', needs.status === 400 && /ATS/.test(needs.body.error), needs.body);
  const ln1 = await call('PUT', `/crm/plus/deals/${D3.id}/lines`, { lines: [{ productKey: 'HRMS', plan: 'Growth', name: 'HRMS - Growth', qty: 120, unitPrice: 89, billing: 'Monthly' }, { name: 'Setup and training', qty: 1, unitPrice: 15000, billing: 'One-time' }] }, tk.A);
  const hl = ln1.body && ln1.body.lines && ln1.body.lines.find((l) => l.productKey === 'HRMS');
  check('120 HRMS users get the 5% volume discount by itself', ln1.status === 200 && hl && hl.discountPercent === 5 && hl.rule === 'volume 100+', ln1.body);
  const dv = (await call('GET', `/crm/deals/${D3.id}`, null, tk.A)).body.deal;
  check('the deal\'s value is the sum of its lines (120 x 89 less 5% + 15,000 = 25,146)', Math.abs(dv.value - 25146) < 0.01, dv.value);
  check('the value of a deal with lines cannot be typed over', (await call('PUT', `/crm/deals/${D3.id}`, { value: 1 }, tk.A)).status === 400);
  check('B cannot change A\'s lines', (await call('PUT', `/crm/plus/deals/${D3.id}/lines`, { lines: [] }, tk.B)).status === 404);
  const bundle = await call('POST', `/crm/plus/deals/${D3.id}/bundle`, { bundleId: 'starter' }, tk.A);
  check('adding the Starter pack bundle puts its products on at the bundle discount', bundle.status === 200 && bundle.body.lines.filter((l) => l.bundle === 'Starter pack').length === 2 && bundle.body.lines.filter((l) => l.bundle).every((l) => l.discountPercent === 10), bundle.body && bundle.body.lines);
  const omniOk = await call('PUT', `/crm/plus/deals/${D3.id}/lines`, { lines: [...bundle.body.lines, { productKey: 'OMNI', plan: 'Starter', name: 'Omni Starter', qty: 1, unitPrice: 2999, billing: 'Monthly' }] }, tk.A);
  check('with an ATS line on the deal, Omni-Channel is allowed', omniOk.status === 200, omniOk.body);
  const overLine = await call('PUT', `/crm/plus/deals/${d2.id}/lines`, { lines: [{ name: 'Consulting', qty: 1, unitPrice: 50000, discountPercent: 25 }] }, tk.A);
  check('a line discount above the 10% limit sends the deal for a manager\'s approval', overLine.status === 200 && overLine.body.approvalStatus === 'Pending', overLine.body && overLine.body.approvalStatus);

  console.log('03.12 Recurring revenue: MRR / ARR and the renewal deal');
  const linesNow = (await call('GET', `/crm/plus/deals/${D3.id}/lines`, null, tk.A)).body;
  check('the deal\'s MRR comes from its monthly lines (not the one-time setup)', linesNow.mrr > 0 && linesNow.mrr < linesNow.subtotal, [linesNow.mrr, linesNow.subtotal]);
  const won3 = await move(D3.id, 'Won');
  check('the deal is won', won3.status === 200, won3.body);
  const inv3 = won3.body.invoice;
  check('04.03: its invoice carries the product lines, adding up to the invoice amount', inv3 && inv3.lines.length === linesNow.lines.length && Math.abs(inv3.lines.reduce((n, l) => n + l.amount, 0) - inv3.amount) < 0.005, inv3 && [inv3.amount, inv3.lines]);
  const rec = await call('GET', '/crm/plus/recurring', null, tk.A);
  check('MRR and ARR (12 x MRR) of the won recurring deals', rec.status === 200 && Math.abs(rec.body.mrr - linesNow.mrr) < 0.01 && Math.abs(rec.body.arr - rec.body.mrr * 12) < 0.05 && rec.body.deals[0].renewalDate, rec.body);
  check('B does not count A\'s recurring revenue', (await call('GET', '/crm/plus/recurring', null, tk.B)).body.mrr === 0);
  const ren = await call('POST', `/crm/plus/deals/${D3.id}/renewal`, null, tk.A);
  check('a renewal deal is made: same account, the lines copied, closing on the renewal date', ren.status === 200 && ren.body.deal.renewalOfId === D3.id && ren.body.deal.expectedClose === rec.body.deals[0].renewalDate && ren.body.deal.accountId === a1.id, ren.body);
  check('its lines are copied', (await call('GET', `/crm/plus/deals/${ren.body.deal.id}/lines`, null, tk.A)).body.lines.length === linesNow.lines.length);
  check('asking again gives the same renewal deal', (await call('POST', `/crm/plus/deals/${D3.id}/renewal`, null, tk.A)).body.already === true);
  check('a renewal is only made from a won deal', (await call('POST', `/crm/plus/deals/${D1.id}/renewal`, null, tk.A)).status === 400);
  const tick = await call('POST', '/crm/plus/renewals/run', null, tk.M);
  check('renewal deals by themselves are OFF until turned on', tick.status === 200 && tick.body.off === true, tick.body);

  console.log('03.13 Deal splits');
  const sp0 = await call('GET', `/crm/plus/deals/${D3.id}/splits`, null, tk.A);
  check('without a split, the owner has 100%', sp0.status === 200 && sp0.body.splits.length === 1 && sp0.body.splits[0].percent === 100);
  check('shares that do not add up to 100 are refused', (await call('PUT', `/crm/plus/deals/${D3.id}/splits`, { splits: [{ userId: A.id, percent: 50 }, { userId: B.id, percent: 40 }] }, tk.A)).status === 400);
  check('a person who is not on the sales team is refused', (await call('PUT', `/crm/plus/deals/${D3.id}/splits`, { splits: [{ userId: A.id, percent: 50 }, { userId: O.id, percent: 50 }] }, tk.A)).status === 400);
  check('the Viewer cannot split a deal', (await call('PUT', `/crm/plus/deals/${D3.id}/splits`, { splits: [{ userId: A.id, percent: 100 }] }, tk.V)).status === 403);
  const sp = await call('PUT', `/crm/plus/deals/${D3.id}/splits`, { splits: [{ userId: A.id, percent: 60, role: 'Owner' }, { userId: B.id, percent: 40, role: 'Demo' }] }, tk.A);
  check('A shares the credit 60 / 40 with B', sp.status === 200 && sp.body.custom && sp.body.splits.length === 2, sp.body);

  console.log('03.16 Win / loss, cycle length and pipeline velocity');
  const an = await call('GET', '/crm/plus/analysis', null, tk.M);
  const s = an.body && an.body.summary;
  check('the analysis gives win rate, average and median cycle, average won value and velocity', an.status === 200 && s.won >= 1 && typeof s.winRate === 'number' && typeof s.avgCycleDays === 'number' && typeof s.velocityPerDay === 'number' && s.avgWonValue > 0, s);
  check('per stage: deals that entered, moved on, conversion % and average days', an.body.stages.length === 7 && an.body.stages.find((x) => x.stage === 'Demo given').entered >= 1 && an.body.stages.find((x) => x.stage === 'Demo given').conversion === 100, an.body.stages);
  const cred = an.body.credit.find((c) => c.userId === B.id);
  check('won credit follows the split (B gets 40% of the won deal)', cred && Math.abs(cred.credit - Math.round(won3.body.deal.finalValue * 40) / 100) < 0.02, an.body.credit);
  const anP = await call('GET', '/crm/plus/analysis?pipeline=products', null, tk.M);
  check('the analysis can be read per pipeline (Products: one lost deal)', anP.status === 200 && anP.body.pipeline.id === 'products' && anP.body.summary.lost === 1 && anP.body.stages.length === 4, anP.body && anP.body.summary);
  const anA = await call('GET', '/crm/plus/analysis', null, tk.B);
  check('B\'s analysis holds only B\'s deals', anA.status === 200 && anA.body.summary.won === 0, anA.body && anA.body.summary);

  console.log('03.08 Forecast categories, submission and manager adjustment');
  const fc0 = await call('GET', `/crm/plus/forecast?month=${thisMonth}`, null, tk.A);
  const rowA = fc0.body.rows.find((x) => x.ownerId === A.id);
  check('A\'s month: won, commit (deals set to Commit) and the auto commit', fc0.status === 200 && rowA && rowA.won > 0 && rowA.commit > 0 && rowA.autoCommit === Math.round((rowA.won + rowA.commit) * 100) / 100, rowA);
  check('best case below commit is refused', (await call('POST', '/crm/plus/forecast', { month: thisMonth, commit: 100, bestCase: 50 }, tk.A)).status === 400);
  const sub = await call('POST', '/crm/plus/forecast', { month: thisMonth, commit: 150000, bestCase: 250000, note: 'Two closings' }, tk.A);
  check('A submits a forecast', sub.status === 200 && sub.body.rows.find((x) => x.ownerId === A.id).submission.commit === 150000 && sub.body.rows.find((x) => x.ownerId === A.id).final === 150000, sub.body.rows);
  check('A cannot adjust a forecast', (await call('PUT', '/crm/plus/forecast/adjust', { month: thisMonth, ownerId: A.id, managerCommit: 1 }, tk.A)).status === 403);
  const adj = await call('PUT', '/crm/plus/forecast/adjust', { month: thisMonth, ownerId: A.id, managerCommit: 120000, managerNote: 'One will slip' }, tk.M);
  const rA = adj.body.rows.find((x) => x.ownerId === A.id);
  check('the manager adjusts it: the final number is the manager\'s, A\'s own stays visible', adj.status === 200 && rA.final === 120000 && rA.submission.commit === 150000 && rA.submission.adjustedByName === M.name, rA);
  check('the Viewer does not submit a forecast', (await call('POST', '/crm/plus/forecast', { month: thisMonth, commit: 1 }, tk.V)).status === 403);
  check('B sees only B\'s line', (await call('GET', `/crm/plus/forecast?month=${thisMonth}`, null, tk.B)).body.rows.every((x) => x.ownerId === B.id));

  console.log('04.05 Quote templates and versions');
  check('a Salesperson cannot change the quote templates', (await call('PUT', '/crm/plus/quote-settings', { templates: [] }, tk.A)).status === 403);
  const qs = await call('PUT', '/crm/plus/quote-settings', { templates: [{ id: 'quotation', title: 'Quotation', intro: 'Our prices for you.', terms: 'Prices in INR\nGST extra' }, { name: 'Annual licence quote', title: 'Annual Licence Quotation', intro: 'Licences for one year.', terms: ['Billed yearly in advance'], accent: '#0f766e' }], approval: { mode: 'over-limit', minFeePercent: 7 } }, tk.M);
  check('the manager edits the quotation text and adds an "Annual licence quote" template', qs.status === 200 && qs.body.templates.length === 3 && qs.body.templates.some((t) => t.name === 'Annual licence quote'), qs.body && qs.body.templates);
  const tplId = qs.body.templates.find((t) => t.name === 'Annual licence quote').id;
  const D4 = (await deal('ZZ D Quotes', a1.id, { expectedClose: inMonth })).body.deal;
  await call('PUT', `/crm/plus/deals/${D4.id}/lines`, { lines: [{ productKey: 'ATS', plan: 'Growth', name: 'ATS - Growth', qty: 5, unitPrice: 2499, billing: 'Monthly' }] }, tk.A);
  const q1 = await call('POST', `/crm/deals/${D4.id}/proposals`, { templateId: tplId, toEmail: 'buyer@example.test', toName: 'Buyer' }, tk.A);
  check('a quote is made from the template with the deal\'s lines: version 1, total with GST', q1.status === 200 && q1.body.proposal.version === 1 && q1.body.proposal.templateId === tplId && q1.body.proposal.totalAmount > 12495, q1.body);
  const pdf = await fetch(`${API}/crm/proposals/${q1.body.proposal.id}/pdf`, { headers: { Authorization: `Bearer ${tk.A}` } });
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  check('its PDF is drawn from the template', pdf.status === 200 && /pdf/.test(pdf.headers.get('content-type')) && pdfBuf.slice(0, 4).toString() === '%PDF', pdf.status);
  const q2 = await call('POST', `/crm/plus/proposals/${q1.body.proposal.id}/revise`, null, tk.A);
  check('"Revise" makes version 2 of the same template', q2.status === 200 && q2.body.proposal.version === 2 && q2.body.proposal.revisionOf === q1.body.proposal.id, q2.body);
  const ql = await call('GET', `/crm/plus/deals/${D4.id}/quotes`, null, tk.A);
  check('the old version is marked Replaced, the list shows both with their template', ql.status === 200 && ql.body.quotes.length === 2 && ql.body.quotes.find((x) => x.id === q1.body.proposal.id).status === 'Replaced' && ql.body.quotes.every((x) => x.templateName === 'Annual licence quote'), ql.body);
  check('a replaced version cannot be emailed', (await call('POST', `/crm/proposals/${q1.body.proposal.id}/send`, { to: 'buyer@example.test' }, tk.A)).status === 409);
  const rp = await call('POST', `/crm/deals/${D4.id}/proposals`, { roles: [{ title: 'Developer', openings: 2, ctc: 900000 }], feePercent: 8.33 }, tk.A);
  check('the built-in recruitment proposal still works and is version 3 of this deal', rp.status === 200 && rp.body.proposal.version === 3 && rp.body.proposal.templateId === 'recruitment', rp.body);
  check('a quote template with no lines on the deal and none written is refused plainly', (await call('POST', `/crm/deals/${D1.id}/proposals`, { templateId: 'quotation' }, tk.A)).status === 400);

  console.log('04.06 Quote approval');
  const low = await call('POST', `/crm/deals/${D4.id}/proposals`, { roles: [{ title: 'Tester', openings: 1 }], feePercent: 5 }, tk.A);
  check('a recruitment fee under the 7% floor waits for approval', low.status === 200 && low.body.proposal.approvalStatus === 'Pending', low.body.proposal);
  const disc = await call('POST', `/crm/deals/${D4.id}/proposals`, { templateId: 'quotation', discountPercent: 20 }, tk.A);
  check('a product quote with a 20% discount (limit 10%) waits for approval', disc.status === 200 && disc.body.proposal.approvalStatus === 'Pending', disc.body.proposal);
  const blocked = await call('POST', `/crm/proposals/${disc.body.proposal.id}/send`, { to: 'buyer@example.test' }, tk.A);
  check('it cannot be emailed while it waits', blocked.status === 409 && /approval/.test(blocked.body.error), blocked.body);
  check('the Salesperson cannot approve it', (await call('POST', `/crm/plus/proposals/${disc.body.proposal.id}/approval`, { decision: 'approve' }, tk.A)).status === 403);

  console.log('11.14 The approvals inbox');
  const inbox = await call('GET', '/crm/plus/approvals', null, tk.M);
  const types = inbox.body.items.map((x) => x.type);
  check('the manager sees in one list the deal discount and the quotes waiting', inbox.status === 200 && inbox.body.canDecide && types.includes('Deal discount') && inbox.body.items.filter((x) => x.type === 'Quote').length >= 2, inbox.body.items);
  const inboxA = await call('GET', '/crm/plus/approvals', null, tk.A);
  check('A sees their own items waiting, without the right to decide', inboxA.status === 200 && !inboxA.body.canDecide && inboxA.body.items.length >= 3 && inboxA.body.items.every((x) => x.mine), inboxA.body);
  check('B sees none of A\'s', (await call('GET', '/crm/plus/approvals', null, tk.B)).body.items.length === 0);
  const ok1 = await call('POST', `/crm/plus/proposals/${disc.body.proposal.id}/approval`, { decision: 'approve', note: 'Fine for a 2-year deal' }, tk.M);
  check('the manager approves the quote from the inbox', ok1.status === 200 && ok1.body.approvalStatus === 'Approved', ok1.body);
  const sendAfter = await call('POST', `/crm/proposals/${disc.body.proposal.id}/send`, { to: 'buyer@example.test' }, tk.A);
  check('then it is no longer held back for approval', sendAfter.status !== 409, sendAfter.body);
  await call('POST', `/crm/plus/proposals/${low.body.proposal.id}/approval`, { decision: 'reject', note: 'Fee too low' }, tk.M);
  check('a rejected quote is not emailed', (await call('POST', `/crm/proposals/${low.body.proposal.id}/send`, { to: 'buyer@example.test' }, tk.A)).status === 409);
  const dApprove = await call('POST', `/crm/deals/${d2.id}/approval`, { decision: 'approve' }, tk.M);
  check('the deal discount is approved on the deal as before, and leaves the inbox', dApprove.status === 200 && !(await call('GET', '/crm/plus/approvals', null, tk.M)).body.items.some((x) => x.dealId === d2.id && x.type === 'Deal discount'));

  console.log('04.11 Sales orders and contracts with renewal dates');
  const renewOn = new Date(Date.now() + 5.5 * 3600e3 + 300 * 86400e3).toISOString().slice(0, 10);
  check('a contract needs proper dates', (await call('POST', `/crm/plus/deals/${D3.id}/contracts`, { startDate: '2026-13-01' }, tk.A)).status === 400);
  check('the end date is after the start date', (await call('POST', `/crm/plus/deals/${D3.id}/contracts`, { startDate: '2026-12-01', endDate: '2026-11-01' }, tk.A)).status === 400);
  const ct = await call('POST', `/crm/plus/deals/${D3.id}/contracts`, { kind: 'Contract', status: 'Active', startDate: '2026-12-01', endDate: renewOn, renewalDate: renewOn, terms: '12 months, renews yearly', poNumber: 'PO-77', remindDays: 30 }, tk.A);
  check('A makes a contract from the won deal: a number, the deal\'s lines and value, the renewal date', ct.status === 200 && /^CT-\d{4}$/.test(ct.body.contract.code) && ct.body.contract.lines.length > 0 && ct.body.contract.value === won3.body.deal.finalValue && ct.body.contract.renewalDate === renewOn, ct.body);
  const task = await prisma.$queryRawUnsafe('SELECT * FROM "CrmTask" WHERE "id" = ?', ct.body.contract.renewalTaskId);
  check('a follow-up for the owner 30 days before the renewal', task.length === 1 && task[0].ownerId === A.id && task[0].origin === 'contract-renewal' && task[0].dueDate === new Date(Date.parse(`${renewOn}T00:00:00Z`) - 30 * 86400e3).toISOString().slice(0, 10), task[0]);
  const so = await call('POST', `/crm/plus/deals/${D4.id}/contracts`, { kind: 'Sales order', title: 'ATS order' }, tk.A);
  check('a sales order gets its own number series', so.status === 200 && /^SO-\d{4}$/.test(so.body.contract.code) && so.body.contract.status === 'Draft', so.body);
  check('B cannot change A\'s contract', (await call('PUT', `/crm/plus/contracts/${ct.body.contract.id}`, { status: 'Cancelled' }, tk.B)).status === 404);
  const upd = await call('PUT', `/crm/plus/contracts/${so.body.contract.id}`, { status: 'Active', signedOn: '2026-11-20' }, tk.A);
  check('A activates the order', upd.status === 200 && upd.body.contract.status === 'Active', upd.body);
  const cl = await call('GET', '/crm/plus/contracts', null, tk.M);
  check('the manager lists every contract and order', cl.status === 200 && cl.body.contracts.filter((c) => [ct.body.contract.id, so.body.contract.id].includes(c.id)).length === 2);
  check('B lists none of A\'s', (await call('GET', '/crm/plus/contracts', null, tk.B)).body.contracts.every((c) => c.ownerId === B.id));

  console.log('04.10 / IN.09 Online payment link (Razorpay) and UPI');
  const inv = (await call('GET', `/crm/invoices?dealId=${D3.id}`, null, tk.A)).body.invoices[0];
  check('a payment link is refused while online payment is off (the default)', (await call('POST', `/crm/plus/invoices/${inv.id}/pay-link`, null, tk.A)).status === 400);
  check('a Sales manager (not Admin) cannot turn it on', (await call('PUT', '/crm/plus/paylink-settings', { enabled: true }, tk.M)).status === 403);
  check('a bad UPI ID is refused', (await call('PUT', '/crm/plus/paylink-settings', { enabled: true, upiId: 'not-a-vpa' }, tk.X)).status === 400);
  const pls2 = await call('PUT', '/crm/plus/paylink-settings', { enabled: true, upiId: 'teamlink@icici', payeeName: 'TeamLink' }, tk.X);
  check('the Admin turns it on with the company UPI ID', pls2.status === 200 && pls2.body.enabled, pls2.body);
  check('a Draft invoice gets no link yet', (await call('POST', `/crm/plus/invoices/${inv.id}/pay-link`, null, tk.A)).status === 400);
  await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, tk.A);
  const upi = await call('POST', `/crm/plus/invoices/${inv.id}/pay-link`, null, tk.A);
  check('without Razorpay: a UPI link for the exact balance and its QR code', upi.status === 200 && /^upi:\/\/pay\?pa=teamlink%40icici/.test(upi.body.upi) && upi.body.upi.includes(`am=${inv.total.toFixed(2)}`) && (qrAvailable ? /^data:image\/png;base64,/.test(upi.body.qr || '') : upi.body.qr === null) && upi.body.links.length === 0, upi.body);
  const st = await call('GET', '/crm/plus/paylink-settings', null, tk.X);
  check('the settings say Razorpay is not connected and show the webhook address', st.status === 200 && st.body.razorpay.configured === false && /\/api\/crm-public\/razorpay\/webhook$/.test(st.body.webhookUrl), st.body);
  const SECRET = 'zz-whsec-test';
  const w = await writeValues('payments', { Provider: 'Razorpay', 'Key ID': 'rzp_test_zz', 'Key secret': 'zz-secret', 'Webhook secret': SECRET });
  await prisma.integration.upsert({ where: { id: 'payments' }, create: { id: 'payments', values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' }, update: { values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' } });
  const rz = await call('POST', `/crm/plus/invoices/${inv.id}/pay-link`, null, tk.A);
  const link = rz.body && rz.body.links && rz.body.links[0];
  check('with Razorpay keys: a payment link for the balance (the sandbox stub - nothing leaves the server)', rz.status === 200 && link && /^plink_test_/.test(link.providerId) && Math.abs(link.amount - inv.total) < 0.01 && link.status === 'created', rz.body);
  check('asking again does not make a second link for the same amount', (await call('POST', `/crm/plus/invoices/${inv.id}/pay-link`, null, tk.A)).body.links.length === 1);
  check('B cannot make a link on A\'s invoice', (await call('POST', `/crm/plus/invoices/${inv.id}/pay-link`, null, tk.B)).status === 404);
  const ev = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link.providerId, status: 'paid' } }, payment: { entity: { id: `pay_zz${P}`, amount: Math.round(inv.total * 100), method: 'upi' } } } });
  const hook = (body, sig) => fetch(`${API}/crm-public/razorpay/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig }, body }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  check('a webhook with a wrong signature is refused', (await hook(ev, 'bad')).status === 401);
  const good = await hook(ev, crypto.createHmac('sha256', SECRET).update(ev).digest('hex'));
  check('the signed "paid" webhook records the payment', good.status === 200 && good.body.ok && Math.abs(good.body.amount - inv.total) < 0.01, good.body);
  const paid = (await call('GET', `/crm/invoices/${inv.id}`, null, tk.A)).body.invoice;
  check('the invoice turns Paid by itself, with a UPI payment line naming the Razorpay payment', paid.status === 'Paid' && paid.payments.length === 1 && paid.payments[0].mode === 'UPI' && /Razorpay pay_zz/.test(paid.payments[0].reference), paid);
  const again = await hook(ev, crypto.createHmac('sha256', SECRET).update(ev).digest('hex'));
  check('the same webhook twice records nothing more', again.status === 200 && again.body.already === true && (await call('GET', `/crm/invoices/${inv.id}`, null, tk.A)).body.invoice.payments.length === 1, again.body);
  const bell = await prisma.notification.findFirst({ where: { userId: A.id, title: { contains: 'paid online' } } });
  check('the owner gets a bell that it was paid online', !!bell);

  console.log('IN.10 CRM invoices for Tally / Zoho Books (a file; nothing is posted to Accounts)');
  const atsInvoices = await prisma.invoice.count();
  const tally = await call('GET', '/crm/plus/invoices/export?format=tally', null, tk.M);
  check('a Tally XML of the sent invoices: a Sales voucher per invoice with the party and the GST ledgers', tally.status === 200 && /xml/.test(tally.type) && tally.text.includes('<VOUCHER VCHTYPE="Sales"') && tally.text.includes(inv.code), tally.text && tally.text.slice(0, 300));
  const zoho = await call('GET', '/crm/plus/invoices/export?format=zoho', null, tk.M);
  check('a Zoho Books invoice CSV, one row per invoice line', zoho.status === 200 && zoho.text.includes('Invoice Number') && zoho.text.includes(inv.code), zoho.text && zoho.text.slice(0, 200));
  check('a person without the download right is refused', (await call('GET', '/crm/plus/invoices/export?format=tally', null, tk.T)).status === 403);
  check('the ATS Accounts invoices are untouched', (await prisma.invoice.count()) === atsInvoices);

  console.log('11.02 / 11.13 Comments with @mentions, and the deal room');
  const cm = await call('POST', `/crm/plus/comments/deal/${D1.id}`, { body: `@${M.name} can you join the call on Friday?`, mentions: [M.id] }, tk.A);
  check('A mentions the manager on a deal: the manager is told', cm.status === 200 && cm.body.told.includes(M.name), cm.body);
  const n = await prisma.notification.findFirst({ where: { userId: M.id, title: { contains: 'mentioned you' } } });
  check('the manager\'s bell says who mentioned them, with a link to the deal', !!n && n.message.includes(`/crm/deals?open=deal:${D1.id}`), n);
  const cm2 = await call('POST', `/crm/plus/comments/deal/${D1.id}`, { body: `@${B.name} FYI` }, tk.A);
  check('a teammate who may not open the deal is not told, and the writer is told so', cm2.status === 200 && cm2.body.cannotSee.includes(B.name) && cm2.body.told.length === 0, cm2.body);
  check('B cannot read the thread of A\'s deal', (await call('GET', `/crm/plus/comments/deal/${D1.id}`, null, tk.B)).status === 404);
  const th = await call('GET', `/crm/plus/comments/deal/${D1.id}`, null, tk.M);
  check('the deal room: the thread in order and who is in it', th.status === 200 && th.body.comments.length === 2 && th.body.participants.some((p) => p.id === A.id) && th.body.people.some((p) => p.id === M.id), th.body);
  const after = await call('GET', `/crm/plus/comments/deal/${D1.id}?after=${encodeURIComponent(th.body.comments[0].createdAt)}`, null, tk.M);
  check('the live read asks only for what came after', after.status === 200 && after.body.comments.length === 1);
  check('an empty comment is refused', (await call('POST', `/crm/plus/comments/deal/${D1.id}`, { body: ' ' }, tk.A)).status === 400);
  check('the manager\'s mention shows in their approvals inbox', (await call('GET', '/crm/plus/approvals', null, tk.M)).body.mentions.some((x) => x.recordId === D1.id));
  check('a comment on a lead works too', (await call('POST', `/crm/plus/comments/account/${a1.id}`, { body: 'Key account' }, tk.A)).status === 200);
  check('B cannot delete A\'s comment', (await call('DELETE', `/crm/plus/comments/${cm.body.comment.id}`, null, tk.B)).status === 403);
  check('the writer can', (await call('DELETE', `/crm/plus/comments/${cm2.body.comment.id}`, null, tk.A)).status === 200);
  check('mention emails are off until turned on', (await call('GET', '/crm/plus/collab-settings', null, tk.M)).body.mentionEmail === false);

  console.log('11.09 Field history');
  await call('PUT', `/crm/deals/${D1.id}`, { nextStep: 'Send the proposal', probability: 55 }, tk.A);
  const fh = await call('GET', `/crm/plus/history/deal/${D1.id}`, null, tk.A);
  const ns = fh.body.history.find((h) => h.field === 'nextStep');
  check('each changed field is kept: from, to, who, when', fh.status === 200 && ns && ns.toValue === 'Send the proposal' && ns.byName === A.name && fh.body.history.some((h) => h.field === 'probability'), fh.body);
  check('the value set earlier is in the history too', fh.body.history.some((h) => h.field === 'value' && h.toValue === '200000'));
  const aud = await prisma.auditLog.findFirst({ where: { action: 'CRM deal fields changed', entityId: D1.id }, orderBy: { createdAt: 'desc' } });
  check('and one line in Administration > Audit Logs', !!aud && /Next step/.test(aud.toValue || ''), aud);
  check('B cannot read the history of A\'s deal', (await call('GET', `/crm/plus/history/deal/${D1.id}`, null, tk.B)).status === 404);

  console.log('11.06 Field-level security');
  check('a Sales manager cannot change field security (Admin only)', (await call('PUT', '/crm/plus/fieldsec', { rules: {} }, tk.M)).status === 403);
  const lead = (await call('POST', '/crm/leads', { company: `ZZ D Lead ${P}`, contactName: 'Ravi', phone: `98${String(P).padStart(8, '1').slice(0, 8)}`, email: `zzdlead${P}@example.test`, city: 'Mysuru' }, tk.A)).body.lead;
  const fsec = await call('PUT', '/crm/plus/fieldsec', { rules: { rep: { deal: { value: 'hide' }, lead: { phone: 'read' } } } }, tk.X);
  check('the Admin hides the deal value from Salespeople and makes the lead phone read-only for them', fsec.status === 200 && fsec.body.rules.rep.deal.value === 'hide', fsec.body);
  const lA = await call('GET', '/crm/deals', null, tk.A);
  const rD1 = lA.body.rows.find((x) => x.id === D1.id);
  check('a Salesperson\'s deal list has no value', rD1 && rD1.value === null && (rD1.hiddenFields || []).includes('value'), rD1);
  check('nor the deal itself', (await call('GET', `/crm/deals/${D1.id}`, null, tk.A)).body.deal.value === null);
  check('the manager still sees it', (await call('GET', `/crm/deals/${D1.id}`, null, tk.M)).body.deal.value === 200000);
  const csv = await call('GET', '/crm/export/deals', null, tk.A);
  check('a Salesperson\'s CSV download has no value column', csv.status === 200 && !csv.text.includes('Value (₹)') && csv.text.includes('Stage'), csv.text && csv.text.slice(0, 200));
  const phoneTry = await call('PUT', `/crm/leads/${lead.id}`, { phone: '9000000001' }, tk.A);
  check('a read-only field cannot be changed by a Salesperson', phoneTry.status === 403 && /Phone/.test(phoneTry.body.error), phoneTry.body);
  check('sending it unchanged with other edits is fine', (await call('PUT', `/crm/leads/${lead.id}`, { phone: lead.phone, notes: 'Called' }, tk.A)).status === 200);
  check('the hidden value sent back blank does not wipe it', (await call('PUT', `/crm/deals/${D1.id}`, { value: '', nextStep: 'x' }, tk.A)).status === 200 && (await call('GET', `/crm/deals/${D1.id}`, null, tk.M)).body.deal.value === 200000);
  check('the config tells the screen which fields are hidden / read only', (await call('GET', '/crm/plus/config', null, tk.A)).body.fieldRules.lead.phone === 'read');
  await call('PUT', '/crm/plus/fieldsec', { rules: {} }, tk.X);

  console.log('11.07 Territories');
  check('a Salesperson cannot change territories', (await call('PUT', '/crm/plus/territories', { territories: [] }, tk.A)).status === 403);
  const ter = await call('PUT', '/crm/plus/territories', { autoAssign: true, territories: [{ id: 'south', name: 'South', states: ['Karnataka', 'Telangana'] }, { id: 'blr', name: 'Bengaluru', parentId: 'south', states: ['Karnataka'], cities: ['Bengaluru'], ownerIds: [A.id, B.id] }] }, tk.M);
  check('the manager makes South with Bengaluru under it (two salespeople), new leads by territory turned on', ter.status === 200 && ter.body.territories.length === 2 && ter.body.autoAssign, ter.body);
  check('a territory cannot sit under itself', (await call('PUT', '/crm/plus/territories', { territories: [{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }] }, tk.M)).status === 400);
  const a2 = await acc('ZZ D Gamma', { state: 'Karnataka', city: 'Bengaluru' });
  check('a new Bengaluru account gets the deepest territory that fits', (await call('GET', `/crm/accounts/${a2.id}`, null, tk.A)).body.account.territoryId === 'blr');
  const a3 = await acc('ZZ D Delta', { state: 'Telangana', city: 'Warangal' });
  check('a Telangana account gets South', (await call('GET', `/crm/accounts/${a3.id}`, null, tk.A)).body.account.territoryId === 'south');
  const mkL = (co, city) => call('POST', '/crm/leads', { company: `${co} ${P}`, contactName: 'X', phone: `97${String(Math.random()).slice(2, 10)}`, city, state: 'Karnataka' }, tk.M);
  const l1 = (await mkL('ZZ D Terr one', 'Bengaluru')).body.lead; const l2 = (await mkL('ZZ D Terr two', 'Bengaluru')).body.lead;
  const o1 = (await call('GET', `/crm/leads/${l1.id}`, null, tk.M)).body.lead; const o2 = (await call('GET', `/crm/leads/${l2.id}`, null, tk.M)).body.lead;
  check('leads a manager adds without an owner go to the territory\'s salespeople in turn', o1.territoryId === 'blr' && o2.territoryId === 'blr' && [o1.ownerId, o2.ownerId].sort().join() === [A.id, B.id].sort().join(), [o1.ownerName, o2.ownerName, o1.territoryId]);
  const ap = await call('POST', '/crm/plus/territories/apply', null, tk.M);
  check('"Work out territories" sets them on older records', ap.status === 200 && ap.body.set >= 1, ap.body);
  const tr = await call('GET', '/crm/plus/territories', null, tk.M);
  check('the territory list counts accounts, leads and open deals of each', tr.status === 200 && tr.body.territories.find((t) => t.id === 'blr').accounts >= 2 && tr.body.territories.find((t) => t.id === 'blr').depth === 1, tr.body.territories);
  check('a territory can be set by hand on a record', (await call('POST', `/crm/plus/territory/account/${a3.id}`, { territoryId: 'blr' }, tk.A)).status === 200);
  check('only from the list', (await call('POST', `/crm/plus/territory/account/${a3.id}`, { territoryId: 'nope' }, tk.A)).status === 400);
  await call('PUT', '/crm/plus/territories', { autoAssign: false, territories: ter.body.territories }, tk.M);

  console.log('11.08 Sub-teams with their own manager');
  check('a team member must be on the CRM sales team', (await call('PUT', '/crm/plus/teams', { teams: [{ name: 'Bad', managerId: T.id, memberIds: [O.id] }] }, tk.M)).status === 400);
  const tm = await call('PUT', '/crm/plus/teams', { teams: [{ id: 'north', name: 'North team', managerId: T.id, memberIds: [B.id] }] }, tk.M);
  check('the manager makes "North team": T leads it, B is in it', tm.status === 200 && tm.body.teams[0].managerId === T.id, tm.body);
  const tList = (await call('GET', '/crm/deals', null, tk.T)).body.rows.map((x) => x.id);
  check('T (a Salesperson) now reads B\'s deals', tList.includes(dB.id) && !tList.includes(D1.id), tList.length);
  check('T opens B\'s deal but cannot change it', (await call('GET', `/crm/deals/${dB.id}`, null, tk.T)).status === 200 && (await call('PUT', `/crm/deals/${dB.id}`, { nextStep: 'x' }, tk.T)).status === 403);
  check('A still does not see B\'s deal', (await call('GET', `/crm/deals/${dB.id}`, null, tk.A)).status === 404);
  check('a Salesperson cannot change the teams', (await call('PUT', '/crm/plus/teams', { teams: [] }, tk.A)).status === 403);

  console.log('11.11 IP restriction');
  check('a Sales manager cannot turn on the IP restriction (Admin only)', (await call('PUT', '/crm/plus/access', { ipRestrict: true, allowed: ['10.9.9.9'] }, tk.M)).status === 403);
  check('a bad address is refused', (await call('PUT', '/crm/plus/access', { ipRestrict: true, allowed: ['10.9.9'] }, tk.X)).status === 400);
  const ipOn = await call('PUT', '/crm/plus/access', { ipRestrict: true, allowed: ['10.9.9.0/24'] }, tk.X);
  check('the Admin allows only the office range', ipOn.status === 200 && ipOn.body.ipRestrict, ipOn.body);
  await new Promise((r) => { setTimeout(r, 100); });
  const blockedMe = await call('GET', '/crm/plus/config', null, tk.A);
  check('a Salesperson outside the office range is kept out, with their address named', blockedMe.status === 403 && /office network/.test(blockedMe.body.error), blockedMe.body);
  check('the Super Admin is never locked out', (await call('GET', '/crm/plus/config', null, tk.X)).status === 200);
  await call('PUT', '/crm/plus/access', { ipRestrict: true, allowed: ['10.9.9.0/24', '127.0.0.1', '::1'] }, tk.X);
  check('with this computer\'s address on the list, A gets in again', (await call('GET', '/crm/plus/config', null, tk.A)).status === 200);
  await call('PUT', '/crm/plus/access', { ipRestrict: false, allowed: [] }, tk.X);

  console.log('11.12 Ownership transfer (someone leaves)');
  check('a Salesperson cannot hand over records', (await call('POST', '/crm/plus/transfer', { fromId: A.id, toId: B.id }, tk.A)).status === 403);
  const pv = await call('GET', `/crm/plus/transfer/preview?fromId=${A.id}`, null, tk.M);
  check('the preview counts A\'s records (all and open)', pv.status === 200 && pv.body.counts.deal.open >= 2 && pv.body.counts.account.all >= 3, pv.body.counts);
  check('the new owner must be on the sales team', (await call('POST', '/crm/plus/transfer', { fromId: A.id, toId: O.id }, tk.M)).status === 400);
  const ac4 = await acc('ZZ D Epsilon', {}, tk.A);
  const bo = await call('POST', '/crm/plus/bulk-owner', { kind: 'account', ids: [ac4.id], ownerId: B.id }, tk.M);
  check('many accounts can be given at once', bo.status === 200 && bo.body.changed === 1 && (await call('GET', `/crm/accounts/${ac4.id}`, null, tk.B)).status === 200, bo.body);
  const trf = await call('POST', '/crm/plus/transfer', { fromId: A.id, toId: B.id, kinds: ['deal', 'task', 'lead'], openOnly: true }, tk.M);
  check('the manager hands A\'s open deals, follow-ups and leads to B in one go', trf.status === 200 && trf.body.moved.deal >= 2, trf.body);
  check('A\'s open deal is now B\'s; A\'s won deal stays A\'s', (await call('GET', `/crm/deals/${D1.id}`, null, tk.B)).status === 200 && (await call('GET', `/crm/deals/${D3.id}`, null, tk.A)).status === 200);

  console.log('IN.08 DPDP Act: notice, consent, withdrawal, access, erasure');
  check('a Salesperson cannot change the privacy notice', (await call('PUT', '/crm/plus/privacy', { noticeText: 'x' }, tk.A)).status === 403);
  const pr = await call('PUT', '/crm/plus/privacy', { noticeText: 'We keep your details to talk about our services.', grievanceName: 'Grievance Officer', grievanceEmail: 'privacy@example.test', purposes: 'Sales calls and emails\nWhatsApp messages' }, tk.M);
  check('the manager writes the notice and the grievance officer: a new notice version', pr.status === 200 && pr.body.noticeVersion === '2' && pr.body.purposes.length === 2, pr.body);
  const page = await fetch(`${API}/crm-public/privacy-notice`).then(async (r) => ({ status: r.status, text: await r.text() }));
  check('the public notice page shows it without a login', page.status === 200 && page.text.includes('We keep your details') && page.text.includes('privacy@example.test'));
  const leadB = (await call('POST', '/crm/leads', { company: `ZZ D Consent ${P}`, contactName: 'Asha', phone: '9876501234', email: `asha${P}@example.test` }, tk.B)).body.lead;
  const c1 = await call('POST', `/crm/plus/consent/lead/${leadB.id}`, { purpose: 'all', status: 'Given', channel: 'Phone call', note: 'Said yes on the call' }, tk.B);
  check('B records consent on a call: every purpose Given, with the notice version', c1.status === 200 && c1.body.current.every((x) => x.status === 'Given' && x.noticeVersion === '2'), c1.body.current);
  check('A cannot record consent on B\'s lead', (await call('POST', `/crm/plus/consent/lead/${leadB.id}`, { purpose: 'all', status: 'Given' }, tk.A)).status === 404);
  check('a purpose outside the list is refused', (await call('POST', `/crm/plus/consent/lead/${leadB.id}`, { purpose: 'Spam', status: 'Given' }, tk.B)).status === 400);
  const c2 = await call('POST', `/crm/plus/consent/lead/${leadB.id}`, { purpose: 'WhatsApp messages', status: 'Withdrawn', channel: 'WhatsApp' }, tk.B);
  check('withdrawing one purpose keeps the other', c2.status === 200 && c2.body.current.find((x) => x.purpose === 'WhatsApp messages').status === 'Withdrawn' && c2.body.current.find((x) => x.purpose === 'Sales calls and emails').status === 'Given');
  const opt = await prisma.$queryRawUnsafe('SELECT * FROM "CrmOptOut" WHERE "value" IN (?, ?)', `asha${P}@example.test`, '9876501234');
  check('the withdrawal puts the email and phone on the opt-out list (campaigns skip them)', opt.length === 2, opt);
  const ex = await call('GET', `/crm/plus/consent/lead/${leadB.id}/export`, null, tk.B);
  check('the person\'s data as a file: the record, activities and every consent', ex.status === 200 && ex.body.record.id === leadB.id && ex.body.consents.length >= 3, ex.body && Object.keys(ex.body));
  check('a Salesperson cannot erase', (await call('POST', `/crm/plus/consent/lead/${leadB.id}/erase`, { confirm: 'ERASE' }, tk.B)).status === 403);
  check('erasing needs the word ERASE', (await call('POST', `/crm/plus/consent/lead/${leadB.id}/erase`, {}, tk.M)).status === 400);
  const er = await call('POST', `/crm/plus/consent/lead/${leadB.id}/erase`, { confirm: 'ERASE' }, tk.M);
  const gone = (await call('GET', `/crm/leads/${leadB.id}`, null, tk.M)).body.lead;
  check('the manager erases the personal details; the record stays as Erased', er.status === 200 && gone.contactName === 'Erased (DPDP request)' && !gone.phone && !gone.email && gone.company, gone);
  const key = (await call('POST', '/crm/website/key', null, tk.M)).body.key;
  const web = await fetch(`${API}/crm/leads/public`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ name: 'Web Person', company: `ZZ D Web ${P}`, email: `web${P}@example.test`, phone: '9811122233', consent: '1', page_url: 'https://example.test/contact' }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const wc = web.body && web.body.id ? await prisma.$queryRawUnsafe('SELECT * FROM "CrmConsent" WHERE "recordId" = ?', web.body.id) : [];
  check('a website form sent with consent=1 records the consent by itself (source page, address)', web.status === 200 && wc.length === 2 && wc.every((x) => x.channel === 'Website form' && x.status === 'Given' && x.source === 'https://example.test/contact'), [web.body, wc.length]);

  console.log('IN.07 Indian telephony');
  check('the Exotel connector is there (utils/callGateway.js) and waits for an Exotel account', fs.existsSync(path.join(BACK, 'src', 'utils', 'callGateway.js')));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

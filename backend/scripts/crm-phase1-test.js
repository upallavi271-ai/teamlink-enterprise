#!/usr/bin/env node
/**
 * CRM Phase 1 hardening (founder review 2026-11-14): a lead needs something logged before it is Contacted / Qualified, closed deals on the board are the
 * last 30 days, "Closing in 30 days" no longer holds dates that have passed (they are their own list), and invoices can be made for old Won deals.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4049. Nothing real is called.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-phase1-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-phase1-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4049;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-phase1-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const ymd = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const isoAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

(async () => {
  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
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

  console.log('A lead needs something logged before Contacted / Qualified');
  const mk = async (company, phone) => (await call('POST', '/crm/leads', { company, contactName: 'Asha', phone }, auth)).body.lead;
  const l1 = await mk('Zz Gate One', '9000111101');
  const e1 = await call('PUT', `/crm/leads/${l1.id}`, { status: 'Qualified' }, auth);
  check('Qualified is refused on a lead nobody has touched', e1.status === 409 && /Log a call/.test(e1.body.error), e1.body);
  const e2 = await call('PUT', `/crm/leads/${l1.id}`, { status: 'Contacted' }, auth);
  check('Contacted is refused too', e2.status === 409, e2.body);
  const m1 = await call('POST', `/crm/leads/${l1.id}/stage`, { stage: 'Qualified' }, auth);
  check('moving it to a later stage is refused', m1.status === 409, m1.body);
  const m0 = await call('POST', `/crm/leads/${l1.id}/stage`, { stage: 'Lost', lostReason: 'No response' }, auth);
  check('Lost is still allowed (a dead lead needs no call)', m0.status === 200, m0.body);
  const l2 = await mk('Zz Gate Two', '9000111102');
  await call('POST', '/crm/activities', { kind: 'call', leadId: l2.id, subject: 'Spoke to the owner' }, auth);
  const ok1 = await call('PUT', `/crm/leads/${l2.id}`, { status: 'Qualified' }, auth);
  check('after a call is logged, Qualified works', ok1.status === 200 && ok1.body.lead.status === 'Qualified', ok1.body);
  const l3 = await mk('Zz Gate Three', '9000111103');
  const ft = (await call('POST', '/crm/tasks', { title: 'Ring', dueDate: ymd(0), leadId: l3.id }, auth)).body.task;
  await call('POST', `/crm/tasks/${ft.id}/done`, { outcome: 'Spoke', note: 'Interested' }, auth);
  check('a follow-up finished with an outcome counts as work done', (await call('POST', `/crm/leads/${l3.id}/stage`, { stage: 'Qualified' }, auth)).status === 200);
  const l4 = await mk('Zz Gate Four', '9000111104');
  await call('POST', `/crm/leads/${l4.id}/stage`, { stage: 'Lost', lostReason: 'x' }, auth); // writes a system "Stage:" line
  check('a stage move written by the system does not count as work', (await call('POST', `/crm/leads/${l4.id}/stage`, { stage: 'Contacted' }, auth)).status === 409);
  const l5 = await mk('Zz Gate Five', '9000111105'); const l6 = await mk('Zz Gate Six', '9000111106');
  await call('POST', '/crm/activities', { kind: 'note', leadId: l5.id, subject: 'Looked at their site' }, auth);
  const bulk = await call('POST', '/crm/leads/bulk', { ids: [l5.id, l6.id], status: 'Contacted' }, auth);
  check('bulk: only the lead with a logged note changes, the other is skipped with the reason', bulk.status === 200 && bulk.body.changed === 1 && bulk.body.skipped.length === 1 && /nothing logged/.test(bulk.body.skipped[0].reason), bulk.body);
  check('the first stage and a New lead are unaffected', (await call('PUT', `/crm/leads/${l6.id}`, { notes: 'a note on the lead record' }, auth)).status === 200);

  console.log('Closed deals on the board: the last 30 days');
  const acc = (await call('POST', '/crm/accounts', { name: 'Zz Phase1 Traders', gstin: '', address: '' }, auth)).body.account;
  const deal = async (title, extra = {}) => (await call('POST', '/crm/deals', { title, accountId: acc.id, value: '50000', ...extra }, auth)).body.deal;
  const dNew = await deal('Zz Won Recently'); const dOld = await deal('Zz Won Long Ago');
  await call('POST', `/crm/deals/${dNew.id}/stage`, { stage: 'Won' }, auth);
  await call('POST', `/crm/deals/${dOld.id}/stage`, { stage: 'Won' }, auth);
  await DB.run('UPDATE "CrmDeal" SET "wonAt" = ? WHERE "id" = ?', isoAgo(60), dOld.id);
  const board = await call('GET', '/crm/deals', null, auth);
  check('a deal won today is on the board', board.body.rows.some((d) => d.id === dNew.id));
  check('a deal won 60 days ago is not (it was, with 90 days)', !board.body.rows.some((d) => d.id === dOld.id));
  const wide = await call('GET', '/crm/deals?closedDays=120', null, auth);
  check('a list can ask for a longer window', wide.body.rows.some((d) => d.id === dOld.id));

  console.log('Closing in 30 days vs close date passed');
  const dLate = await deal('Zz Close Passed', { expectedClose: ymd(-9) });
  const dSoon = await deal('Zz Close Soon', { expectedClose: ymd(10) });
  const dFar = await deal('Zz Close Far', { expectedClose: ymd(90) });
  const dash = await call('GET', '/crm/dashboard', null, auth);
  const soonIds = dash.body.closingSoon.map((d) => d.id); const lateIds = dash.body.overdueClose.map((d) => d.id);
  check('"closing soon" holds only dates still to come', soonIds.includes(dSoon.id) && !soonIds.includes(dLate.id) && !dash.body.closingSoon.some((d) => d.late), soonIds);
  check('a date that has passed is in "overdue close date"', lateIds.includes(dLate.id) && dash.body.overdueClose.every((d) => d.late), lateIds);
  check('a date 90 days away is in neither', !soonIds.includes(dFar.id) && !lateIds.includes(dFar.id));
  check('the count of passed dates is given', dash.body.overdueCloseCount >= 1, dash.body.overdueCloseCount);

  console.log('Invoices for deals won before invoices existed');
  // a Won deal with no invoice: as the old data is (inserted directly, never went through the Won move)
  const old = await deal('Zz Old Won Deal', { discountPercent: '10' });
  await DB.run('UPDATE "CrmDeal" SET "stage" = \'Won\', "wonAt" = ?, "probability" = 100 WHERE "id" = ?', isoAgo(25), old.id);
  const before = await call('GET', '/crm/invoices', null, auth);
  check('the invoices list says how many Won deals have none', before.body.missing >= 1, before.body.missing);
  const bf = await call('POST', '/crm/invoices/backfill', null, auth);
  check('one press makes them', bf.status === 200 && bf.body.created >= 1, bf.body);
  const after = await call('GET', `/crm/invoices?dealId=${old.id}`, null, auth);
  const inv = after.body.invoices[0];
  check('the invoice of the old deal exists', !!inv && /^INV-\d{4}$/.test(inv.code), after.body);
  check('it is dated the day the deal was won, not today', inv && inv.issueDate === new Date(Date.now() - 25 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10), inv && inv.issueDate);
  check('its due date follows that date', inv && inv.dueDate > inv.issueDate, inv && [inv.issueDate, inv.dueDate]);
  check('the discount is in the amount (50,000 less 10%)', inv && inv.amount === 45000, inv && inv.amount);
  check('it says the customer has no GSTIN and no address', inv && inv.missing.includes('GSTIN') && inv.missing.includes('address'), inv && inv.missing);
  const bf2 = await call('POST', '/crm/invoices/backfill', null, auth);
  check('pressing it again makes nothing more', bf2.status === 200 && bf2.body.created === 0, bf2.body);
  check('and nothing is missing any more', (await call('GET', '/crm/invoices', null, auth)).body.missing === 0);
  const wonNow = await call('POST', `/crm/deals/${dFar.id}/stage`, { stage: 'Won' }, auth);
  check('Won now says what is blank on the customer', wonNow.body.invoice && wonNow.body.invoice.missing.length === 2, wonNow.body.invoice && wonNow.body.invoice.missing);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

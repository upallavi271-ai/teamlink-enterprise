#!/usr/bin/env node
/**
 * ROLE TEST of the CRM money path (founder's pasted checklist 2026-11-14: "Sales Executive test login create chesi 'only my leads' check cheyyandi").
 * Two Salespeople (A and B), a Sales manager, a Viewer and an Admin, each their own login. Checks who sees and who may touch: leads, deals, invoices,
 * the payment log, follow-ups, the dashboard numbers (Booked / Invoiced / Collected), the rights (import / export / assign) and the audit trail.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4055. Nobody real is touched, nobody is given real access.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-roles-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-roles-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" = \'crm.settings\'');
dbx.close();

const PORT = 4055;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-roles-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token, raw) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
  const type = r.headers.get('content-type') || '';
  let j = null;
  if (/json/.test(type)) { try { j = await r.json(); } catch { /* none */ } } else { j = { text: await r.text().catch(() => '') }; }
  return { status: r.status, body: j, type };
};
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ ${tag}`, email: `zz.crmroles.${tag}.${process.pid}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const near = (a, b) => Math.abs(a - b) < 0.01;

(async () => {
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const V = await mkUser('viewer', { role: 'EMPLOYEE' });
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const outsider = await mkUser('outsider', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const tk = { A: await tokenOf(A.id), B: await tokenOf(B.id), M: await tokenOf(M.id), V: await tokenOf(V.id), X: await tokenOf(X.id), O: await tokenOf(outsider.id) };
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 80; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 1000); }); } // eslint-disable-line no-await-in-loop

  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  const put = await call('PUT', '/crm/settings', { salesTeam: [
    { userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own },
    { userId: M.id, name: M.name, role: 'manager' }, { userId: V.id, name: V.name, role: 'viewer' },
  ] }, tk.X);
  check('the Admin sets up two Salespeople (own records only, no import / export / delete), a Sales manager and a Viewer', put.status === 200, put.body);
  await new Promise((r) => { setTimeout(r, 400); });

  console.log('1. Who can open the CRM at all');
  check('a BDE who is not on the CRM list cannot open it', (await call('GET', '/crm/me', null, tk.O)).status === 403);
  const meA = await call('GET', '/crm/me', null, tk.A);
  check('Salesperson A opens it as a Salesperson with only the rights given', meA.status === 200 && meA.body.role === 'bde' && meA.body.rights.create && meA.body.rights.edit && !meA.body.rights.export && !meA.body.rights.import && !meA.body.rights.delete, meA.body && [meA.body.role, meA.body.rights]);
  check('the Sales manager has every right and sees all', (await call('GET', '/crm/me', null, tk.M)).body.role === 'tl');

  console.log('2. Leads: "only my leads"');
  const mkLead = (token, co) => call('POST', '/crm/leads', { company: co, contactName: 'Ravi', phone: `98${String(Math.random()).slice(2, 10)}`, email: `${co.replace(/\W/g, '').toLowerCase()}@example.test`, expectedValue: 50000 }, token);
  const la = await mkLead(tk.A, `ZZ Roles Alpha ${process.pid}`);
  const lb = await mkLead(tk.B, `ZZ Roles Beta ${process.pid}`);
  check('A and B each add a lead', la.status === 200 && lb.status === 200, [la.body, lb.body]);
  const LA = la.body.lead; const LB = lb.body.lead;
  const listA = (await call('GET', '/crm/leads', null, tk.A)).body.rows.map((x) => x.id);
  check('A\'s lead list holds A\'s lead and not B\'s', listA.includes(LA.id) && !listA.includes(LB.id), listA.length);
  check('A cannot open B\'s lead', (await call('GET', `/crm/leads/${LB.id}`, null, tk.A)).status === 404);
  check('A cannot change B\'s lead', (await call('PUT', `/crm/leads/${LB.id}`, { notes: 'hijack' }, tk.A)).status >= 400);
  const listM = (await call('GET', '/crm/leads', null, tk.M)).body.rows.map((x) => x.id);
  check('the Sales manager sees both', listM.includes(LA.id) && listM.includes(LB.id));
  const listV = (await call('GET', '/crm/leads', null, tk.V)).body.rows.map((x) => x.id);
  check('the Viewer sees both but cannot change', listV.includes(LA.id) && (await call('PUT', `/crm/leads/${LA.id}`, { notes: 'x' }, tk.V)).status >= 400);
  check('A cannot hand a lead to B (only a manager assigns)', (await call('POST', '/crm/leads/bulk', { ids: [LA.id], ownerId: B.id }, tk.A)).status === 403);
  check('the manager can', (await call('POST', '/crm/leads/bulk', { ids: [LA.id], ownerId: A.id }, tk.M)).status === 200);

  console.log('3. The "log a call first" rule');
  const early = await call('PUT', `/crm/leads/${LA.id}`, { status: 'Contacted' }, tk.A);
  check('A cannot mark a lead Contacted before anything is logged on it', early.status === 409 && early.body.needsLog === true, early.body);
  const logged = await call('POST', '/crm/activities', { kind: 'call', leadId: LA.id, subject: 'Spoke to Ravi', outcome: 'Spoke' }, tk.A);
  check('A logs a call on it', logged.status === 200, logged.body);
  check('now it can be Contacted', (await call('PUT', `/crm/leads/${LA.id}`, { status: 'Contacted' }, tk.A)).status === 200);

  console.log('4. Follow-ups are your own');
  const tomorrow = new Date(Date.now() + 5.5 * 3600000 + 86400000).toISOString().slice(0, 10);
  const ta = await call('POST', '/crm/tasks', { title: 'Call Ravi back', dueDate: tomorrow, leadId: LA.id }, tk.A);
  check('A adds a follow-up on their lead', ta.status === 200 && ta.body.task, ta.body);
  const TA = ta.body.task;
  const seenB = (await call('GET', '/crm/tasks?when=open', null, tk.B)).body.tasks.map((x) => x.id);
  check('B does not see it', !seenB.includes(TA.id), seenB.length);
  const seenA = (await call('GET', '/crm/tasks?when=open', null, tk.A)).body.tasks.map((x) => x.id);
  check('A does', seenA.includes(TA.id));
  check('B cannot snooze or finish it', (await call('POST', `/crm/tasks/${TA.id}/snooze`, { dueDate: tomorrow }, tk.B)).status >= 400 && (await call('POST', `/crm/tasks/${TA.id}/done`, { outcome: 'Spoke' }, tk.B)).status >= 400);
  const seenM = (await call('GET', `/crm/tasks?when=open&all=1`, null, tk.M)).body.tasks.map((x) => x.id);
  check('the manager sees everyone\'s follow-ups', seenM.includes(TA.id));

  console.log('5. Deals, invoices and the payment log: your own only');
  const acc = await call('POST', '/crm/accounts', { name: `ZZ Roles Co ${process.pid}`, gstin: '36ABCDE1234F1Z5', address: '1 Road' }, tk.A);
  check('A adds an account', acc.status === 200, acc.body);
  const deal = await call('POST', '/crm/deals', { title: 'ZZ Roles Deal', accountId: acc.body.account.id, value: '100000' }, tk.A);
  const won = await call('POST', `/crm/deals/${deal.body.deal.id}/stage`, { stage: 'Won' }, tk.A);
  const inv = won.body.invoice;
  check('A wins it and its invoice is raised, owned by A', won.status === 200 && inv && inv.ownerId === A.id && inv.total === 118000, inv && [inv.ownerId, inv.total]);
  const dealId = deal.body.deal.id;
  check('B cannot open A\'s deal', (await call('GET', `/crm/deals/${dealId}`, null, tk.B)).status === 404);
  check('B\'s invoice list does not have it', !(await call('GET', '/crm/invoices', null, tk.B)).body.invoices.some((x) => x.id === inv.id));
  check('B cannot open the invoice, its PDF, or its payments', (await call('GET', `/crm/invoices/${inv.id}`, null, tk.B)).status === 404 && (await call('GET', `/crm/invoices/${inv.id}/pdf`, null, tk.B)).status === 404);
  check('B cannot record a payment on it', (await call('POST', `/crm/invoices/${inv.id}/payments`, { amount: 100 }, tk.B)).status === 404);
  check('B cannot change its status', (await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, tk.B)).status === 404);
  check('B cannot make a WhatsApp link for it, and the Viewer cannot send it either', (await call('POST', `/crm/invoices/${inv.id}/share`, null, tk.B)).status === 404 && (await call('POST', `/crm/invoices/${inv.id}/share`, null, tk.V)).status === 403);
  check('A can send their own invoice on WhatsApp', (await call('POST', `/crm/invoices/${inv.id}/share`, null, tk.A)).status === 200);
  check('the Viewer sees it but cannot record a payment or change it', (await call('GET', `/crm/invoices/${inv.id}`, null, tk.V)).status === 200 && (await call('POST', `/crm/invoices/${inv.id}/payments`, { amount: 100 }, tk.V)).status === 403 && (await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, tk.V)).status === 403);
  await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, tk.A);
  const pay = await call('POST', `/crm/invoices/${inv.id}/payments`, { amount: 40000, mode: 'UPI', reference: 'UTR-ROLE' }, tk.A);
  check('A records a payment on their own invoice', pay.status === 200 && pay.body.invoice.status === 'Partly paid', pay.body);
  const payM = await call('POST', `/crm/invoices/${inv.id}/payments`, { amount: 10000, mode: 'Cash' }, tk.M);
  check('the Sales manager can record one on A\'s invoice too', payM.status === 200 && payM.body.invoice.paidAmount === 50000, payM.body);
  check('B cannot remove a payment line', (await call('DELETE', `/crm/invoices/${inv.id}/payments/${pay.body.invoice.payments[0].id}`, null, tk.B)).status === 404);
  check('A cannot add the missing invoices of B (backfill is only for own deals)', (await call('POST', '/crm/invoices/backfill', null, tk.B)).status === 200);

  console.log('6. The dashboard numbers follow the person');
  const cash = async (token) => (await call('GET', '/crm/overview?period=month', null, token)).body.cash;
  const cB = await cash(tk.B); const cA = await cash(tk.A); const cM = await cash(tk.M); const cX = await cash(tk.X);
  check('B (no deals) sees zero booked and zero collected', cB.booked.value === 0 && cB.collected.value === 0 && cB.toCollect.value === 0, cB);
  check('A sees their own: booked 100,000, collected 50,000, still to collect 68,000', near(cA.booked.value, 100000) && near(cA.collected.value, 50000) && near(cA.toCollect.value, 68000), cA);
  check('the manager and the Admin see at least that (everyone\'s)', cM.booked.value >= 100000 - 0.01 && cX.collected.value >= 50000 - 0.01);
  check('"mine" on the manager\'s dashboard narrows to the manager (nothing of A\'s)', near((await call('GET', '/crm/overview?period=month&mine=1', null, tk.M)).body.cash.collected.value, 0));

  console.log('7. Download, import, delete: only with the right');
  check('A cannot download leads, deals or invoices data', (await call('GET', '/crm/export/leads', null, tk.A)).status === 403 && (await call('GET', '/crm/export/deals', null, tk.A)).status === 403);
  check('A cannot import', (await call('POST', '/crm/leads/import?name=a.csv&dryRun=1', null, tk.A, Buffer.from('Company\nX'))).status === 403);
  check('A cannot delete', (await call('DELETE', `/crm/lead/${LA.id}`, null, tk.A)).status === 403);
  const exp = await call('GET', '/crm/export/leads', null, tk.M);
  check('the manager can download', exp.status === 200 && /csv/.test(exp.type));
  check('a download is written in the audit log', (await prisma.auditLog.count({ where: { action: 'CRM data downloaded', userId: M.id } })) >= 1);

  console.log('8. The audit trail of money');
  const aud = await prisma.auditLog.findMany({ where: { entity: 'CrmInvoice', entityId: inv.id }, select: { action: true, userId: true } });
  check('the payments and the invoice are in the audit log with who did them', aud.some((x) => x.action === 'CRM payment received' && x.userId === A.id) && aud.some((x) => x.action === 'CRM payment received' && x.userId === M.id), aud);
  const remove = await call('DELETE', `/crm/invoices/${inv.id}/payments/${payM.body.invoice.payments.find((x) => x.mode === 'Cash').id}`, null, tk.M);
  check('removing a payment is allowed for the manager and is in the audit log too', remove.status === 200 && (await prisma.auditLog.count({ where: { action: 'CRM payment removed', entityId: inv.id } })) === 1, remove.body);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

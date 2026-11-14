#!/usr/bin/env node
/**
 * THE CRM STANDS ALONE (founder 2026-11-11: "ats ni crm loki integrate cheyyaku, crm completely separate, dhenitho combine cheyyoddhu"),
 * with its own sales team and rights, its own invoices, one conversation per lead, import column mapping, the booking link,
 * mail tracking and paged leads. SANDBOX ONLY: a private server on a COPY of the sandbox database (port 4071). Nothing real is mailed.
 *   node scripts/crm-separate-test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-separate-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
// the CRM's own list starts empty: everything about the team is set up by this test (and the one-time copy of the old ATS-based access)
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" = \'crm.settings\'');
dbx.close();

const MAILS = path.join(os.tmpdir(), `zz-crm-separate-mails-${process.pid}.jsonl`);
const PORT = 4071;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-separate-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, TEST_MAIL_CAPTURE: MAILS, AI_VOICE_GATEWAY: '0', FRONTEND_URL: 'http://localhost:5173' };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token, raw) => {
  const r = await fetch(API + url, { method, headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const type = r.headers.get('content-type') || '';
  let j = null;
  if (/json/.test(type)) { try { j = await r.json(); } catch { /* none */ } } else { j = { text: await r.text().catch(() => '') }; }
  return { status: r.status, body: j, type };
};
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mails = () => (fs.existsSync(MAILS) ? fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.unlinkSync(MAILS); } catch { /* none */ } process.exit(code); }, 800);
}
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ ${tag}`, email: `zz.crmsep.${tag}.${process.pid}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });

(async () => {
  // users BEFORE the server first reads the CRM settings: the one-time copy of the old access takes them in
  const bde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const rec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT' });
  const fresh = await mkUser('fresh', { role: 'EMPLOYEE' });
  const viewer = await mkUser('viewer', { role: 'EMPLOYEE' });
  const admin = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const tk = { admin: await tokenOf(admin.id), bde: await tokenOf(bde.id), rec: await tokenOf(rec.id), fresh: await tokenOf(fresh.id), viewer: await tokenOf(viewer.id) };

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 1000); }); } // eslint-disable-line no-await-in-loop

  console.log('1. The CRM has its own team; ATS roles open nothing');
  const meBde = await call('GET', '/crm/me', null, tk.bde);
  check('a BDE who used the CRM before no longer has it: the list the old access filled was narrowed once (founder 2026-11-14), so a BDE is shut out until an Admin adds them', meBde.status === 403, meBde.body);
  check('a recruiter (ATS role) cannot open the CRM', (await call('GET', '/crm/me', null, tk.rec)).status === 403);
  check('a login not on the list cannot open the CRM', (await call('GET', '/crm/me', null, tk.fresh)).status === 403);
  const meAdmin = await call('GET', '/crm/me', null, tk.admin);
  check('Super Admin opens it with every right', meAdmin.status === 200 && meAdmin.body.role === 'admin' && Object.values(meAdmin.body.rights || {}).every(Boolean), { status: meAdmin.status, body: meAdmin.body });
  const team = meAdmin.body.salesTeam.filter((m) => m.userId !== fresh.id && m.userId !== viewer.id);
  const put = await call('PUT', '/crm/settings', { salesTeam: [...team, { userId: fresh.id, name: fresh.name, role: 'rep', rights: { create: true, edit: true, delete: false, import: false, export: false, reports: false } }, { userId: viewer.id, name: viewer.name, role: 'viewer' }, { userId: bde.id, name: bde.name, role: 'rep' }] }, tk.admin);
  check('Admin adds a person as a Salesperson, another as a Viewer, and the BDE back as a Salesperson on purpose', put.status === 200, put.body);
  check('the BDE the Admin added opens it, as a Salesperson', (await call('GET', '/crm/me', null, tk.bde)).body.role === 'bde');
  await new Promise((r) => { setTimeout(r, 300); });
  const meFresh = await call('GET', '/crm/me', null, tk.fresh);
  check('the new Salesperson opens the CRM, with only the rights given', meFresh.status === 200 && meFresh.body.rights.create && !meFresh.body.rights.export && !meFresh.body.rights.delete && !meFresh.body.rights.import, meFresh.body.rights);

  console.log('2. Rights, one by one');
  const lead = await call('POST', '/crm/leads', { company: `ZZ Sep Co ${process.pid}`, contactName: 'Ravi', phone: `98${String(Date.now()).slice(-8)}`, email: `ravi.${process.pid}@example.test`, expectedValue: 120000 }, tk.fresh);
  check('the Salesperson adds a lead', lead.status === 200 && lead.body.lead && lead.body.lead.id, lead.body);
  const L = lead.body.lead || {};
  check('...but cannot download (no export right)', (await call('GET', '/crm/export/leads', null, tk.fresh)).status === 403);
  check('...cannot import (no import right)', (await call('POST', '/crm/leads/import?name=a.csv&dryRun=1', null, tk.fresh, Buffer.from('Company\nX'))).status === 403);
  check('...cannot delete their lead (no delete right)', (await call('DELETE', `/crm/lead/${L.id}`, null, tk.fresh)).status === 403);
  check('the Viewer cannot add', (await call('POST', '/crm/leads', { company: 'ZZ Viewer Co' }, tk.viewer)).status === 403);
  const vexp = await call('GET', '/crm/export/leads', null, tk.viewer);
  check('the Viewer can download (a viewer has the download right)', vexp.status === 200 && /csv/.test(vexp.type), vexp.status);
  check('the Viewer sees the Salesperson\'s lead (reads everything)', (await call('GET', `/crm/leads/${L.id}`, null, tk.viewer)).status === 200);
  check('a BDE Salesperson does not see another\'s lead', (await call('GET', `/crm/leads/${L.id}`, null, tk.bde)).status === 404);

  console.log('3. Nothing from ATS');
  const client = await prisma.client.findFirst({ select: { name: true } });
  const dup = await call('POST', '/crm/duplicates', { company: client ? client.name : 'x' }, tk.admin);
  check('the duplicate check never looks at ATS clients', dup.status === 200 && !(dup.body.duplicates || dup.body.rows || []).some((d) => d.where === 'TeamLink client'), dup.body);
  check('the ATS client list is gone from the CRM', (await call('GET', '/crm/client-options', null, tk.admin)).status === 404);
  const acc = await call('POST', '/crm/accounts', { name: `ZZ Sep Account ${process.pid}` }, tk.admin);
  const deal = await call('POST', '/crm/deals', { title: 'ZZ Sep deal', accountId: acc.body.account.id, value: 75000, openings: 3, avgCtc: 500000, feePercent: 10 }, tk.admin);
  check('a deal is worth the value typed (no openings x CTC x fee)', deal.status === 200 && deal.body.deal.value === 75000, deal.body);
  const won = await call('POST', `/crm/deals/${deal.body.deal.id}/stage`, { stage: 'Won' }, tk.admin);
  const accNow = await call('GET', `/crm/accounts/${acc.body.account.id}`, null, tk.admin);
  check('a won deal makes its account a customer, inside the CRM', won.status === 200 && accNow.body.account.kind === 'Client', accNow.body.account);

  // later parts of the build add their checks here (invoices, conversation, import mapping, booking, tracking, paging)
  if (typeof global.moreChecks === 'function') await global.moreChecks({ call, check, tk, L, deal: deal.body.deal, acc: acc.body.account, mails, prisma, fresh, admin, bde });
  const extra = path.join(__dirname, 'crm-separate-more.js');
  if (fs.existsSync(extra)) await require(extra)({ call, check, tk, L, deal: deal.body.deal, acc: acc.body.account, mails, prisma, fresh, admin, bde, API }); // eslint-disable-line global-require

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

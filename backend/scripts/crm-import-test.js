#!/usr/bin/env node
/**
 * LEAD IMPORT: column mapping and the duplicate check (crm/extra.js importLeads) - founder's pasted checklist 2026-11-14:
 * "real leads Excel nundi vastayi; duplicates mundu ravadam valla BDE lu rendu sarlu call chese risk undi".
 * A phone written as +91 98765 43210, 098765 43210 or 9876543210 is ONE number; a duplicate says whose lead it already is; a file whose headings
 * are not the usual ones can be mapped by hand (map = which heading is which field).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4056.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-import-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-import-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4056;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-import-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 420)}` : ''}`); } };
let auth = {};
const call = async (method, url, body, raw) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...auth }, body: raw || (body ? JSON.stringify(body) : undefined) });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const csv = (rows) => Buffer.from(rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
const imp = (rows, query = '') => call('POST', `/crm/leads/import?name=t.csv${query}`, null, csv(rows));

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
  const tag = String(process.pid);

  // already in the CRM: a lead (phone 9876501234, email), an account (by name)
  const lead = await call('POST', '/crm/leads', { company: `ZZ Import Existing ${tag}`, contactName: 'Old Contact', phone: '9876501234', email: `old.${tag}@example.test` });
  const acct = await call('POST', '/crm/accounts', { name: `ZZ Import Account ${tag} Pvt Ltd`, phone: '9123400000' });
  check('a lead and an account are already in the CRM', lead.status === 200 && acct.status === 200, [lead.body, acct.body]);

  console.log('1. The duplicate check');
  const H = ['Company Name', 'HR Name', 'Mobile No', 'Email ID', 'City'];
  const dry = await imp([H,
    [`ZZ Import Fresh ${tag}`, 'Asha', '9811100001', `fresh.${tag}@example.test`, 'Hyderabad'], // new
    [`ZZ Import Other ${tag}`, 'Ravi', '+91 98765 01234', '', 'Pune'], // same phone as the existing lead, written with +91 and spaces
    [`ZZ Import Third ${tag}`, 'Kiran', '098765 01234', '', 'Pune'], // ... and with a leading 0
    [`ZZ Import Mail ${tag}`, 'Mira', '9811100002', `OLD.${tag}@EXAMPLE.TEST`, 'Delhi'], // same email, other case
    [`zz import account ${tag}`, 'Sam', '9811100003', '', 'Delhi'], // same company as the account, other case and without Pvt Ltd
    [`ZZ Import Fresh ${tag}`, 'Asha again', '9811100001', '', 'Hyderabad'], // twice in the same file
    [`ZZ Import Late ${tag}`, 'Nina', '+91-9811100004', '', 'Goa'], // new, phone with +91 and a dash
    ['', 'No Company', '9811100005', '', 'Goa'], // no company
  ], '&dryRun=1');
  check('the file is read: 8 rows, 2 ready (the fresh one and the one with +91-)', dry.status === 200 && dry.body.rows === 8 && dry.body.ready === 2, dry.body && [dry.body.rows, dry.body.ready]);
  const why = (n) => (dry.body.skipped.find((s) => s.row === n) || {}).reason || '';
  check('+91 98765 01234 is the same number as 9876501234 - left out, and it says whose lead it is', /Already in TeamLink: lead ZZ Import Existing/.test(why(3)), why(3));
  check('098765 01234 (a leading 0) is the same number too', /Already in TeamLink/.test(why(4)), why(4));
  check('the same email in other letters is a duplicate', /Already in TeamLink/.test(why(5)), why(5));
  check('the same company as an account (other case, no "Pvt Ltd") is a duplicate', /Already in TeamLink: (account|lead)/.test(why(6)), why(6));
  check('the same person twice in the file: the second is left out', /of this file/.test(why(7)), why(7));
  check('a row with no company is left out and says so', /No company/.test(why(9)), why(9));
  check('the skipped list carries the row number, company and reason for each', dry.body.skipped.length === 6 && dry.body.skipped.every((s) => s.row && s.reason), dry.body.skipped);
  check('the check changes nothing (dry run)', Number(((await DB.one('SELECT COUNT(*) AS n FROM "CrmLead" WHERE "company" LIKE ?', `ZZ Import%${tag}%`)) || {}).n) === 1);

  console.log('2. Importing for real');
  const real = await imp([H, [`ZZ Import Fresh ${tag}`, 'Asha', '9811100001', `fresh.${tag}@example.test`, 'Hyderabad'], [`ZZ Import Late ${tag}`, 'Nina', '+91-9811100004', '', 'Goa'], [`ZZ Import Other ${tag}`, 'Ravi', '+91 98765 01234', '', 'Pune']]);
  check('2 are added, 1 left out', real.status === 200 && real.body.created === 2 && real.body.skipped.length === 1, real.body);
  const again = await imp([H, [`ZZ Import Fresh ${tag}`, 'Asha', '9811100001', '', 'Hyderabad']]);
  check('importing the same file again adds nothing (the second time it is all duplicates)', again.status === 200 && again.body.created === 0 && again.body.skipped.length === 1, again.body);
  const stored = await DB.one('SELECT "phone" FROM "CrmLead" WHERE "company" = ?', `ZZ Import Late ${tag}`);
  check('the lead is kept with its phone', !!stored && /9811100004/.test(String(stored.phone).replace(/\D/g, '')), stored);
  const aud = await prisma.auditLog.findMany({ where: { action: 'CRM leads imported' }, select: { toValue: true } });
  check('the import is in the audit log with how many were duplicates', aud.some((x) => /2 added, 1 skipped \(1 duplicates\)/.test(x.toValue || '')), aud);

  console.log('3. Column mapping');
  const odd = [['Org', 'Cell', 'Mail', 'Contact Person'], [`ZZ Odd Heads ${tag}`, '9822200001', `odd.${tag}@example.test`, 'Tara']];
  const bad = await imp(odd, '&dryRun=1');
  check('headings it does not know: it says so and hands back the file\'s headings to choose from', bad.status === 400 && Array.isArray(bad.body.headings) && bad.body.headings.includes('Org') && bad.body.headings.includes('Cell'), bad.body);
  const m1 = encodeURIComponent(JSON.stringify({ company: 'Org', phone: 'Cell', email: 'Mail' }));
  const ok = await imp(odd, `&dryRun=1&map=${m1}`);
  check('with the company, phone and email picked, the file is read', ok.status === 200 && ok.body.ready === 1 && ok.body.columns.company === 'Org' && ok.body.columns.phone === 'Cell' && ok.body.columns.email === 'Mail', ok.body);
  check('the contact person was still found by its own heading', ok.body.columns.contactName === 'Contact Person');
  check('the choices come back with all the headings for the dropdowns', ok.body.headings && ok.body.headings.length === 4);
  const none = await imp([H, [`ZZ Nophone ${tag}`, 'Nia', '9833300001', '', 'X']], `&dryRun=1&map=${encodeURIComponent(JSON.stringify({ phone: '' }))}`);
  check('a column can be switched off ("not in this file")', none.status === 200 && !none.body.columns.phone && none.body.ready === 1, none.body.columns);
  check('a heading that is not in the file is ignored, not trusted', (await imp(odd, `&dryRun=1&map=${encodeURIComponent(JSON.stringify({ company: 'Nope' }))}`)).status === 400);
  const done = await imp(odd, `&map=${m1}`);
  check('the mapped file imports for real', done.status === 200 && done.body.created === 1, done.body);
  check('a map that is not JSON is ignored (the headings are read as usual)', (await imp([H, [`ZZ Plain ${tag}`, 'P', '9844400001', '', 'Y']], '&dryRun=1&map=not-json')).body.ready === 1);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

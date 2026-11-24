#!/usr/bin/env node
/**
 * CRM WAVE C (2026-11-24): Contacts & Accounts, Admin & Customisation, Data & Compliance, Leads - one section per feature ID of the
 * market benchmark (reports/TeamLink-CRM-Market-Comparison-2026-11-24.xlsx). SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=<port> node scripts/crm-C-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-C-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" IN (\'crm.settings\', \'crm.plus\')');
dbx.close();

const PORT = Number(process.env.TEST_PORT) || 4561;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-C-test', INTEGRATION_SECRET_KEY: 'crm-c-test-secret-key', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token, { raw, type, headers } = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': type || (raw ? 'application/octet-stream' : 'application/json'), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') || '';
  let j = null;
  if (/json/.test(ct)) { const t = await r.text(); try { j = JSON.parse(t); } catch { j = { text: t }; } } else { const b = Buffer.from(await r.arrayBuffer()); j = { text: b.toString('utf8'), bytes: b.length }; }
  return { status: r.status, body: j || {}, type: ct };
};
const multipart = (field, name, mime, data, extra = {}) => {
  const b = `----zzC${crypto.randomBytes(6).toString('hex')}`;
  const parts = [];
  Object.entries(extra).forEach(([k, v]) => parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  return { raw: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ C ${tag}`, email: `zz.crmc.${tag}.${process.pid}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const q1 = async (sql, ...a) => (await prisma.$queryRawUnsafe(sql, ...a))[0] || null;
const n = async (sql, ...a) => Number(((await prisma.$queryRawUnsafe(sql, ...a))[0] || {}).n || 0);
const phone = () => `9${String(Math.random()).slice(2, 11)}`;
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;

(async () => {
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const V = await mkUser('viewer', { role: 'EMPLOYEE' });
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const tk = { A: await tokenOf(A.id), B: await tokenOf(B.id), M: await tokenOf(M.id), V: await tokenOf(V.id), X: await tokenOf(X.id) };
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 120; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await wait(700); } // eslint-disable-line no-await-in-loop
  await wait(800);
  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  const put = await call('PUT', '/crm/settings', { salesTeam: [
    { userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own },
    { userId: M.id, name: M.name, role: 'manager' }, { userId: V.id, name: V.name, role: 'viewer' },
  ] }, tk.X);
  check('setup: two Salespeople, a Sales manager and a Viewer', put.status === 200, put.body);
  await wait(300);
  const mkLead = (t, body) => call('POST', '/crm/leads', { contactName: 'Asha', phone: phone(), ...body }, t);
  const mkAccount = (t, body) => call('POST', '/crm/accounts', { phone: phone(), ...body }, t);

  console.log('02.04 custom fields');
  const f1 = await call('POST', '/crm/plusc/fields', { kind: 'lead', label: 'Budget band', type: 'select', options: 'Small\nLarge' }, tk.X);
  const fReq = await call('POST', '/crm/plusc/fields', { kind: 'lead', label: 'Head count', type: 'number', required: true }, tk.M);
  check('an Admin and a Sales manager add lead fields (pick one, a required number)', f1.status === 200 && f1.body.field.key === 'cf_budget_band' && fReq.status === 200, [f1.body, fReq.body]);
  check('a Salesperson cannot add a field', (await call('POST', '/crm/plusc/fields', { kind: 'lead', label: 'Nope' }, tk.A)).status === 403);
  const noReq = await mkLead(tk.A, { company: `ZZ C Lead NoReq ${P}` });
  check('a lead without the required custom field is refused', noReq.status === 400 && /Head count/.test(noReq.body.error), noReq.body);
  const badPick = await mkLead(tk.A, { company: `ZZ C Lead Bad ${P}`, custom: { cf_head_count: 10, cf_budget_band: 'Huge' } });
  check('a value not in the pick list is refused', badPick.status === 400, badPick.body);
  const L1 = await mkLead(tk.A, { company: `ZZ C Lead One ${P}`, custom: { cf_head_count: '120', cf_budget_band: 'Large' }, tags: 'VIP, hot list, vip' });
  const ex1 = await call('GET', `/crm/plusc/record/lead/${L1.body.lead && L1.body.lead.id}`, null, tk.A);
  check('the lead keeps its custom values (number shaped) and shows them on its record', L1.status === 200 && ex1.body.custom.cf_head_count === 120 && ex1.body.custom.cf_budget_band === 'Large', [L1.body, ex1.body]);
  const setup = await call('GET', '/crm/plusc/setup', null, tk.A);
  check('every CRM person reads the field definitions', setup.status === 200 && setup.body.fields.some((f) => f.key === 'cf_budget_band'));
  // later sections create leads without thinking of the required field: it is switched off again (values stay)
  await call('DELETE', `/crm/plusc/fields/${fReq.body.field.id}`, null, tk.X);
  check('a removed field is switched off, its values stay on the record', (await n('SELECT COUNT(*) n FROM "CrmLead" WHERE "id" = ? AND "customJson" LIKE \'%cf_head_count%\'', L1.body.lead.id)) === 1);

  console.log('02.07 tags on leads / contacts / deals + the tag filter');
  check('tags are cleaned (no duplicates)', L1.body.lead.tags === 'VIP, hot list', L1.body.lead.tags);
  const byTag = await call('GET', '/crm/leads?tag=vip', null, tk.A);
  check('the lead list filters by tag', byTag.status === 200 && byTag.body.rows.some((x) => x.id === L1.body.lead.id) && byTag.body.rows.every((x) => /vip/i.test(x.tags || '')), byTag.body.rows && byTag.body.rows.length);
  const tagList = await call('GET', '/crm/plusc/tags?kind=lead', null, tk.A);
  check('the tags in use are listed with counts', tagList.body.tags.some((t) => t.tag === 'VIP'));

  console.log('16.08 validation rules');
  const r1 = await call('POST', '/crm/plusc/rules', { kind: 'lead', field: 'city', op: 'required', whenField: 'source', whenValue: 'Referral', message: 'A referral lead needs its city.' }, tk.X);
  const r2 = await call('POST', '/crm/plusc/rules', { kind: 'lead', field: 'email', op: 'pattern', value: '@(?!gmail\\.com$)', message: 'Use the work email, not Gmail.' }, tk.X);
  check('an Admin adds two rules (conditional required, a pattern)', r1.status === 200 && r2.status === 200, [r1.body, r2.body]);
  const v1 = await mkLead(tk.A, { company: `ZZ C Ref ${P}`, source: 'Referral' });
  check('the conditional rule blocks a referral lead with no city', v1.status === 400 && v1.body.error === 'A referral lead needs its city.', v1.body);
  const v2 = await mkLead(tk.A, { company: `ZZ C Ref2 ${P}`, source: 'Referral', city: 'Hyderabad', email: `ravi${P}@gmail.com` });
  check('the pattern rule blocks a Gmail address', v2.status === 400 && /work email/.test(v2.body.error), v2.body);
  const v3 = await mkLead(tk.A, { company: `ZZ C Ref3 ${P}`, source: 'Referral', city: 'Hyderabad', email: `ravi${P}@acme-example.in` });
  check('a lead that passes the rules is saved', v3.status === 200, v3.body);
  check('a rule checks an edit too', (await call('PUT', `/crm/leads/${v3.body.lead.id}`, { city: '' }, tk.A)).status === 400);
  await call('DELETE', `/crm/plusc/rules/${r2.body.rule.id}`, null, tk.X);

  console.log('17.02 page layouts');
  const lay = await call('PUT', '/crm/plusc/layouts/lead', { sections: [{ name: 'Company', fields: ['company', 'industry', 'cf_budget_band'] }, { name: 'Person', fields: ['contactName', 'phone', 'email'] }], hidden: { viewer: ['expectedValue'] }, readOnly: { rep: ['rating'] } }, tk.M);
  check('a Sales manager saves a lead layout (sections, hidden for viewers, read-only for salespeople)', lay.status === 200 && lay.body.layout.sections.length === 2 && lay.body.layout.readOnly.rep[0] === 'rating', lay.body);
  const ro = await call('PUT', `/crm/leads/${L1.body.lead.id}`, { rating: 'Hot' }, tk.A);
  check('a Salesperson cannot change a read-only field on their own lead', ro.status === 400 && /Sales manager/.test(ro.body.error), ro.body);
  check('the Sales manager can', (await call('PUT', `/crm/leads/${L1.body.lead.id}`, { rating: 'Hot' }, tk.M)).status === 200);
  check('the layout reaches every screen', (await call('GET', '/crm/plusc/setup', null, tk.V)).body.layouts.lead.hidden.viewer.includes('expectedValue'));

  console.log('16.09 encrypted (sensitive) fields');
  const fs1 = await call('POST', '/crm/plusc/fields', { kind: 'contact', label: 'PAN', type: 'text', sensitive: true }, tk.X);
  const AC = await mkAccount(tk.A, { name: `ZZ C Acme Group ${P}`, website: 'acme-example.in' });
  const C1 = await call('POST', '/crm/contacts', { name: 'Ravi Kumar', accountId: AC.body.account.id, phone: phone(), email: `ravi.k${P}@acme-example.in`, custom: { cf_pan: 'ABCDE1234F' } }, tk.A);
  const stored = await q1('SELECT "customJson" FROM "CrmContact" WHERE "id" = ?', C1.body.contact && C1.body.contact.id);
  check('the PAN is kept encrypted in the database', fs1.status === 200 && C1.status === 200 && /enc:v1:/.test(stored.customJson) && !/ABCDE1234F/.test(stored.customJson), [fs1.body, C1.body, stored]);
  const plainA = await call('GET', `/crm/plusc/record/contact/${C1.body.contact.id}`, null, tk.A);
  const maskedV = await call('GET', `/crm/plusc/record/contact/${C1.body.contact.id}`, null, tk.V);
  check('the owner reads it, a Viewer sees it masked', plainA.body.custom.cf_pan === 'ABCDE1234F' && maskedV.status === 200 && /^•+234F$/.test(maskedV.body.custom.cf_pan), [plainA.body.custom, maskedV.body]);
  const exp = await call('GET', '/crm/export/contacts', null, tk.M);
  check('a download leaves the sensitive field out', exp.status === 200 && !/ABCDE1234F/.test(exp.body.text) && !/PAN/.test(exp.body.text.split('\n')[0]));

  console.log('17.01 record types of your own');
  const ob = await call('POST', '/crm/plusc/objects', { name: 'Branch', linkTo: 'account', fields: [{ label: 'City', type: 'text', required: true }, { label: 'Staff', type: 'number' }] }, tk.X);
  check('an Admin makes a "Branch" record type linked to accounts', ob.status === 200 && ob.body.object.fields.length === 2, ob.body);
  const ob1 = await call('POST', `/crm/plusc/objects/${ob.body.object.id}/records`, { name: 'Gachibowli office', accountId: AC.body.account.id, values: { city: 'Hyderabad', staff: '40' } }, tk.A);
  const obNo = await call('POST', `/crm/plusc/objects/${ob.body.object.id}/records`, { name: 'No city', values: {} }, tk.A);
  check('a Salesperson adds a branch to their account; a required value is checked', ob1.status === 200 && ob1.body.record.accountId === AC.body.account.id && obNo.status === 400, [ob1.body, obNo.body]);
  const obA = await call('GET', `/crm/plusc/objects/${ob.body.object.id}/records?accountId=${AC.body.account.id}`, null, tk.A);
  const obB = await call('GET', `/crm/plusc/objects/${ob.body.object.id}/records`, null, tk.B);
  check('the owner lists it on the account; another Salesperson does not see it', obA.body.rows.length === 1 && obA.body.rows[0].values.staff === 40 && !obB.body.rows.some((x) => x.id === ob1.body.record.id), [obA.body, obB.body.rows.length]);
  check('the account\'s More tab counts its branches', (await call('GET', `/crm/plusc/record/account/${AC.body.account.id}`, null, tk.A)).body.objects.some((o) => o.name === 'Branch' && o.count === 1));

  console.log('02.02 parent / child companies');
  const AC2 = await mkAccount(tk.A, { name: `ZZ C Acme Labs ${P}`, parentId: AC.body.account.id });
  check('a subsidiary is added under its parent', AC2.status === 200 && AC2.body.account.parentId === AC.body.account.id, AC2.body);
  const loop = await call('PUT', `/crm/accounts/${AC.body.account.id}`, { parentId: AC2.body.account.id }, tk.A);
  check('a company cannot sit under its own subsidiary', loop.status === 400, loop.body);
  const H = await call('GET', `/crm/plusc/hierarchy/${AC2.body.account.id}`, null, tk.A);
  check('the group shows the parent at the top with the subsidiary under it', H.status === 200 && H.body.chain[0].id === AC.body.account.id && H.body.tree.children.some((c) => c.id === AC2.body.account.id && c.here), H.body);
  check('the account list filters by parent', (await call('GET', `/crm/accounts?parentId=${AC.body.account.id}`, null, tk.A)).body.rows.map((x) => x.id).join() === AC2.body.account.id);

  console.log('02.08 several contacts with roles on one deal');
  const C2 = await call('POST', '/crm/contacts', { name: 'Meera Rao', accountId: AC.body.account.id, phone: phone() }, tk.A);
  const D1 = await call('POST', '/crm/deals', { title: `ZZ C Deal ${P}`, accountId: AC.body.account.id, contactId: C1.body.contact.id, value: 100000 }, tk.A);
  const dc = await call('POST', `/crm/plusc/deal-contacts/${D1.body.deal.id}`, { contactId: C2.body.contact.id, role: 'Billing contact' }, tk.A);
  check('a second contact is added to the deal as the billing contact; the deal contact stays primary', dc.status === 200 && dc.body.contacts.length === 2 && dc.body.contacts.some((c) => c.contactId === C2.body.contact.id && c.role === 'Billing contact') && dc.body.contacts.find((c) => c.contactId === C1.body.contact.id).primary, dc.body);
  check('another Salesperson cannot add people to it', (await call('POST', `/crm/plusc/deal-contacts/${D1.body.deal.id}`, { contactId: C2.body.contact.id, role: 'User' }, tk.B)).status === 404);
  const dcr = await call('DELETE', `/crm/plusc/deal-contacts/${D1.body.deal.id}/${C2.body.contact.id}`, null, tk.A);
  check('and is taken off again', dcr.status === 200 && dcr.body.contacts.length === 1);

  console.log('02.09 the org chart of an account');
  const rep = await call('PUT', `/crm/contacts/${C2.body.contact.id}`, { reportsToId: C1.body.contact.id }, tk.A);
  const back = await call('PUT', `/crm/contacts/${C1.body.contact.id}`, { reportsToId: C2.body.contact.id }, tk.A);
  const oc = await call('GET', `/crm/plusc/org-chart/${AC.body.account.id}`, null, tk.A);
  check('Meera reports to Ravi; the loop back is refused; the chart has Ravi at the top', rep.status === 200 && back.status === 400 && oc.body.roots.length === 1 && oc.body.roots[0].id === C1.body.contact.id && oc.body.roots[0].reports[0].id === C2.body.contact.id, [rep.body, back.body, oc.body]);

  console.log('02.11 the account team');
  const tm = await call('POST', `/crm/plusc/team/${AC.body.account.id}`, { userId: B.id, role: 'Pre-sales' }, tk.M);
  check('a Sales manager puts Salesperson B on A\'s account team', tm.status === 200 && tm.body.members.some((m) => m.userId === B.id && m.role === 'Pre-sales'), tm.body);
  const bOpen = await call('GET', `/crm/accounts/${AC.body.account.id}`, null, tk.B);
  check('B now opens the account, read only', bOpen.status === 200 && bOpen.body.onTeam === true && bOpen.body.canEdit === false, bOpen.body && [bOpen.status, bOpen.body.onTeam, bOpen.body.canEdit]);
  check('B cannot change it', [403, 404].includes((await call('PUT', `/crm/accounts/${AC.body.account.id}`, { city: 'Pune' }, tk.B)).status));
  check('B sees it in the account list and the search', (await call('GET', '/crm/accounts', null, tk.B)).body.rows.some((x) => x.id === AC.body.account.id) && (await call('GET', `/crm/plusc/search?q=${encodeURIComponent(`Acme Group ${P}`)}`, null, tk.B)).body.groups.some((g) => g.id === 'crm-accounts'));
  check('B cannot change the team', (await call('POST', `/crm/plusc/team/${AC.body.account.id}`, { userId: M.id }, tk.B)).status === 403);
  await call('DELETE', `/crm/plusc/team/${AC.body.account.id}/${B.id}`, null, tk.A);
  check('once taken off, B cannot open it', (await call('GET', `/crm/accounts/${AC.body.account.id}`, null, tk.B)).status === 404);

  console.log('02.12 files on leads, accounts and contacts');
  const up = multipart('file', 'visiting-card.png', 'image/png', PNG, { category: 'Picture' });
  const fu = await call('POST', `/crm/plusc/files/lead/${L1.body.lead.id}`, null, tk.A, up);
  check('a picture is kept on a lead', fu.status === 200 && fu.body.file.category === 'Picture', fu.body);
  const fl = await call('GET', `/crm/plusc/files/lead/${L1.body.lead.id}`, null, tk.A);
  const dl = await call('GET', `/crm/plusc/file/${fu.body.file.id}`, null, tk.A);
  check('it is listed and downloads', fl.body.files.length === 1 && dl.status === 200 && dl.body.bytes === PNG.length, [fl.body, dl.status]);
  check('another Salesperson cannot download it', (await call('GET', `/crm/plusc/file/${fu.body.file.id}`, null, tk.B)).status === 404);
  const fc = await call('POST', `/crm/plusc/files/contact/${C1.body.contact.id}`, null, tk.A, multipart('file', 'kyc.png', 'image/png', PNG, { category: 'ID / KYC' }));
  const fa = await call('POST', `/crm/plusc/files/account/${AC.body.account.id}`, null, tk.A, multipart('file', 'contract.png', 'image/png', PNG, { category: 'Contract' }));
  check('files go on a contact and an account too', fc.status === 200 && fa.status === 200);
  check('a file of the wrong type is refused', (await call('POST', `/crm/plusc/files/lead/${L1.body.lead.id}`, null, tk.A, multipart('file', 'x.exe', 'application/x-msdownload', Buffer.from('MZ....')))).status === 400);
  check('the file is deleted', (await call('DELETE', `/crm/plusc/file/${fu.body.file.id}`, null, tk.A)).status === 200 && (await n('SELECT COUNT(*) n FROM "CrmRecordFile" WHERE "id" = ?', fu.body.file.id)) === 0);

  console.log('02.13 customer health');
  await prisma.$executeRawUnsafe('UPDATE "CrmAccount" SET "kind" = \'Client\' WHERE "id" = ?', AC.body.account.id);
  await prisma.$executeRawUnsafe('INSERT INTO "CrmInvoice" ("id", "code", "accountId", "accountName", "title", "status", "issueDate", "dueDate", "amount", "taxPercent", "taxAmount", "total", "paidAmount", "ownerId", "ownerName", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, \'Sent\', ?, ?, 1000, 0, 0, 1000, 0, ?, ?, ?, ?)', `inv_zzc${P}`, `INV-ZZ${P}`, AC.body.account.id, 'Acme', 'Old invoice', '2026-01-01', '2026-01-15', A.id, A.name, new Date().toISOString(), new Date().toISOString());
  const hh = await call('GET', `/crm/plusc/health/${AC.body.account.id}`, null, tk.A);
  check('an account with an overdue invoice and nothing logged scores low, with its reasons', hh.status === 200 && hh.body.score < 70 && hh.body.signals.some((s) => /overdue/.test(s.text)) && hh.body.signals.some((s) => /logged|Quiet/.test(s.text)), hh.body);
  const hl = await call('GET', '/crm/plusc/health', null, tk.M);
  check('the customer health list has it, worst first', hl.status === 200 && hl.body.rows.some((x) => x.id === AC.body.account.id) && hl.body.rows.every((x, i, arr) => i === 0 || arr[i - 1].score <= x.score), hl.body.counts);

  console.log('02.14 one search for every CRM record');
  const sA = await call('GET', `/crm/plusc/search?q=${encodeURIComponent(`Lead One ${P}`)}`, null, tk.A);
  const sB = await call('GET', `/crm/plusc/search?q=${encodeURIComponent(`Lead One ${P}`)}`, null, tk.B);
  check('the owner finds the lead; another Salesperson does not', sA.body.groups.some((g) => g.id === 'crm-leads' && g.rows[0].to.includes(L1.body.lead.id)) && !sB.body.groups.some((g) => g.id === 'crm-leads'), [sA.body, sB.body]);
  const sPh = await call('GET', `/crm/plusc/search?q=${C1.body.contact.phone}`, null, tk.A);
  check('a phone number finds the contact', sPh.body.groups.some((g) => g.id === 'crm-contacts'), sPh.body);
  check('someone not on the CRM team gets nothing', (await call('GET', '/crm/plusc/search?q=Acme', null, await tokenOf((await mkUser('outsider', { role: 'EMPLOYEE' })).id))).status === 403);

  console.log('02.05 enrichment');
  const en = await call('POST', `/crm/plusc/enrich/${AC.body.account.id}`, null, tk.A);
  check('"Fill from the web" reads the company website (a stub on a test server): industry, social links', en.status === 200 && en.body.suggestions.industry && /linkedin/.test(en.body.suggestions.social || ''), en.body);
  const ap = await call('POST', `/crm/plusc/enrich/${AC.body.account.id}/apply`, { fields: { industry: en.body.suggestions.industry, social: en.body.suggestions.social } }, tk.A);
  check('the ticked values are filled in', ap.status === 200 && ap.body.account.industry === en.body.suggestions.industry && !!ap.body.account.enrichedAt, ap.body);
  await prisma.integration.upsert({ where: { id: 'crm-enrichment' }, create: { id: 'crm-enrichment', values: JSON.stringify({ 'Lookup URL (use {domain})': 'https://api.example.test/c?d={domain}', 'Key header name': 'X-Key', 'API key': 'k' }) }, update: { values: JSON.stringify({ 'Lookup URL (use {domain})': 'https://api.example.test/c?d={domain}', 'Key header name': 'X-Key', 'API key': 'k' }) } });
  const en2 = await call('POST', `/crm/plusc/enrich/${AC.body.account.id}`, null, tk.A);
  check('with the provider key saved, the company size comes too (stub)', en2.status === 200 && en2.body.provider && en2.body.provider.configured && en2.body.suggestions.employees === '51-200', en2.body);
  check('another Salesperson cannot enrich it', (await call('POST', `/crm/plusc/enrich/${AC.body.account.id}`, null, tk.B)).status === 404);

  console.log('02.10 import accounts and contacts');
  const accCsv = Buffer.from(`Company,City,GSTIN,Tags,Parent\nZZ C Imp One ${P},Pune,,Retail,\nZZ C Imp Two ${P},Chennai,,,ZZ C Imp One ${P}\nZZ C Acme Group ${P},Hyd,,,\n`);
  check('a Salesperson without the import right is refused', (await call('POST', '/crm/plusc/import/accounts?dryRun=1', null, tk.A, { raw: accCsv })).status === 403);
  const dry = await call('POST', '/crm/plusc/import/accounts?dryRun=1', null, tk.M, { raw: accCsv });
  check('a dry run says 2 ready, 1 already in the CRM', dry.status === 200 && dry.body.ready === 2 && dry.body.skipped.length === 1, dry.body);
  const imp = await call('POST', '/crm/plusc/import/accounts?name=a.csv', null, tk.M, { raw: accCsv });
  const two = await q1('SELECT * FROM "CrmAccount" WHERE "name" = ?', `ZZ C Imp Two ${P}`);
  const one = await q1('SELECT * FROM "CrmAccount" WHERE "name" = ?', `ZZ C Imp One ${P}`);
  check('accounts are imported with codes, tags and the parent from the file', imp.status === 200 && imp.body.created === 2 && two && one && two.parentId === one.id && /^C-/.test(one.code || '') && one.tags === 'Retail', [imp.body, two, one && one.code]);
  const conCsv = Buffer.from(`Name,Company,Phone,Role\nKiran ${P},ZZ C Imp One ${P},9${String(P).padStart(9, '7').slice(-9)},Finance\nNew Person ${P},ZZ C Brand New ${P},,\n`);
  const cdry = await call('POST', '/crm/plusc/import/contacts?dryRun=1', null, tk.M, { raw: conCsv });
  const cimp = await call('POST', '/crm/plusc/import/contacts?createAccounts=1', null, tk.M, { raw: conCsv });
  check('contacts: without "add missing companies" the unknown company is skipped; with it, the company is made', cdry.body.ready === 1 && cimp.body.created === 2 && cimp.body.accountsMade === 1, [cdry.body, cimp.body]);

  console.log('16.06 the recycle bin');
  const Lbin = await mkLead(tk.A, { company: `ZZ C Bin Lead ${P}` });
  await call('POST', '/crm/activities', { kind: 'call', subject: 'Called them', leadId: Lbin.body.lead.id }, tk.A);
  const del = await call('DELETE', `/crm/lead/${Lbin.body.lead.id}`, null, tk.M);
  const binList = await call('GET', '/crm/plusc/bin', null, tk.M);
  const item = binList.body.rows.find((x) => x.recordId === Lbin.body.lead.id);
  check('a deleted lead goes to the recycle bin', del.status === 200 && item && item.kind === 'lead', binList.body);
  check('the Salesperson who owned it sees it in their bin; another does not', (await call('GET', '/crm/plusc/bin', null, tk.A)).body.rows.some((x) => x.id === item.id) && !(await call('GET', '/crm/plusc/bin', null, tk.B)).body.rows.some((x) => x.id === item.id));
  const res = await call('POST', `/crm/plusc/bin/${item.id}/restore`, null, tk.M);
  const backLead = await call('GET', `/crm/leads/${Lbin.body.lead.id}`, null, tk.A);
  check('it is put back with its call', res.status === 200 && backLead.status === 200 && backLead.body.activities.some((a) => a.subject === 'Called them'), [res.body, backLead.status]);
  check('a deleted deal can come back too', (await call('DELETE', `/crm/deal/${D1.body.deal.id}`, null, tk.M)).status === 200 && (await call('POST', `/crm/plusc/bin/${(await call('GET', '/crm/plusc/bin?kind=deal', null, tk.M)).body.rows[0].id}/restore`, null, tk.M)).status === 200 && (await call('GET', `/crm/deals/${D1.body.deal.id}`, null, tk.A)).status === 200);

  console.log('16.05 data retention');
  check('off by default', (await call('GET', '/crm/plusc/retention', null, tk.M)).body.retention.on === false);
  const Ljunk = await mkLead(tk.A, { company: `ZZ C Junk ${P}` });
  await prisma.$executeRawUnsafe('UPDATE "CrmLead" SET "status" = \'Junk\', "updatedAt" = ? WHERE "id" = ?', new Date(Date.now() - 40 * 86400000).toISOString(), Ljunk.body.lead.id);
  await prisma.$executeRawUnsafe('INSERT INTO "CrmRecycle" ("id", "kind", "recordId", "name", "rowJson", "deletedAt") VALUES (?, \'lead\', ?, \'old\', \'{}\', ?)', `bin_old${P}`, `lead_old${P}`, new Date(Date.now() - 90 * 86400000).toISOString());
  check('a Salesperson cannot set it', (await call('PUT', '/crm/plusc/retention', { on: true }, tk.A)).status === 403);
  const rs = await call('PUT', '/crm/plusc/retention', { on: true, binDays: 60, junkLeadDays: 30 }, tk.M);
  check('the preview says what would go', rs.status === 200 && rs.body.preview.junk >= 1 && rs.body.preview.bin >= 1, rs.body);
  const run = await call('POST', '/crm/plusc/retention/run', null, tk.M);
  check('"Run now": the old Junk lead moves to the bin and the old bin item is gone for good', run.status === 200 && run.body.result.leadsToBin >= 1 && (await n('SELECT COUNT(*) n FROM "CrmLead" WHERE "id" = ?', Ljunk.body.lead.id)) === 0 && (await n('SELECT COUNT(*) n FROM "CrmRecycle" WHERE "id" = ?', `bin_old${P}`)) === 0 && (await n('SELECT COUNT(*) n FROM "CrmRecycle" WHERE "recordId" = ?', Ljunk.body.lead.id)) === 1, run.body);
  await call('PUT', '/crm/plusc/retention', { on: false }, tk.M);

  console.log('01.04 duplicates and merge');
  const ph = phone();
  const Ld1 = await mkLead(tk.A, { company: `ZZ C Dup Co ${P}`, phone: ph, city: 'Pune' });
  const Ld2 = await mkLead(tk.A, { company: `ZZ C Dup Company ${P}`, phone: ph, email: `dup${P}@dup-example.in`, force: true });
  await call('POST', '/crm/activities', { kind: 'call', subject: 'Call on the copy', leadId: Ld2.body.lead.id }, tk.A);
  const dups = await call('GET', '/crm/plusc/duplicates?kind=lead', null, tk.A);
  check('the duplicates finder shows the two leads with the same phone', dups.status === 200 && dups.body.groups.some((g) => g.why === 'Same phone' && g.rows.length === 2 && g.rows.some((r) => r.id === Ld1.body.lead.id)), dups.body.groups && dups.body.groups.length);
  check('a Salesperson without the delete right cannot merge', (await call('POST', '/crm/plusc/merge', { kind: 'lead', keepId: Ld1.body.lead.id, mergeId: Ld2.body.lead.id }, tk.A)).status === 403);
  const mg = await call('POST', '/crm/plusc/merge', { kind: 'lead', keepId: Ld1.body.lead.id, mergeId: Ld2.body.lead.id, pick: { company: 'other' } }, tk.M);
  const kept = await call('GET', `/crm/leads/${Ld1.body.lead.id}`, null, tk.A);
  check('merged: the picked name, the blank email filled, the call moved over, the copy in the bin', mg.status === 200 && kept.body.lead.company === `ZZ C Dup Company ${P}` && kept.body.lead.email === `dup${P}@dup-example.in` && kept.body.lead.city === 'Pune' && kept.body.activities.some((a) => a.subject === 'Call on the copy') && (await n('SELECT COUNT(*) n FROM "CrmLead" WHERE "id" = ?', Ld2.body.lead.id)) === 0 && (await n('SELECT COUNT(*) n FROM "CrmRecycle" WHERE "recordId" = ? AND "why" LIKE \'Merged into%\'', Ld2.body.lead.id)) === 1, [mg.body, kept.body.lead]);
  const Am = await mkAccount(tk.A, { name: `ZZ C Acme Group Pvt Ltd ${P}`, force: true });
  await call('POST', '/crm/contacts', { name: 'Third Person', accountId: Am.body.account.id, phone: phone() }, tk.A);
  const ma = await call('POST', '/crm/plusc/merge', { kind: 'account', keepId: AC.body.account.id, mergeId: Am.body.account.id }, tk.M);
  check('two accounts merge: the contacts move to the kept one', ma.status === 200 && (await n('SELECT COUNT(*) n FROM "CrmContact" WHERE "accountId" = ? AND "name" = \'Third Person\'', AC.body.account.id)) === 1, ma.body);

  console.log('16.07 mass update and mass delete');
  const bl1 = await mkLead(tk.A, { company: `ZZ C Bulk A ${P}` }); const bl2 = await mkLead(tk.B, { company: `ZZ C Bulk B ${P}` });
  const bu = await call('POST', '/crm/plusc/bulk', { kind: 'lead', ids: [bl1.body.lead.id, bl2.body.lead.id], action: 'update', set: { city: 'Mumbai', custom: { cf_budget_band: 'Small' } } }, tk.M);
  check('a Sales manager changes the city and a custom field of two leads at once', bu.status === 200 && bu.body.changed === 2 && (await q1('SELECT "city", "customJson" FROM "CrmLead" WHERE "id" = ?', bl2.body.lead.id)).city === 'Mumbai', bu.body);
  const bt = await call('POST', '/crm/plusc/bulk', { kind: 'lead', ids: [bl1.body.lead.id, bl2.body.lead.id], action: 'tagAdd', tags: 'Expo 2026' }, tk.A);
  check('a Salesperson tags in bulk only their own lead (the other is skipped)', bt.status === 200 && bt.body.changed === 1 && bt.body.skipped.length === 1, bt.body);
  const ab = await call('POST', '/crm/plusc/bulk', { kind: 'account', ids: [one.id, two.id], action: 'update', set: { industry: 'Retail' } }, tk.M);
  check('accounts too', ab.status === 200 && ab.body.changed === 2);
  check('a Salesperson without the delete right cannot mass delete', (await call('POST', '/crm/plusc/bulk', { kind: 'lead', ids: [bl1.body.lead.id], action: 'delete' }, tk.A)).status === 403);
  const bd = await call('POST', '/crm/plusc/bulk', { kind: 'lead', ids: [bl1.body.lead.id, bl2.body.lead.id], action: 'delete' }, tk.M);
  check('a mass delete sends them to the recycle bin', bd.status === 200 && bd.body.changed === 2 && (await n('SELECT COUNT(*) n FROM "CrmRecycle" WHERE "recordId" IN (?, ?) AND "restoredAt" IS NULL', bl1.body.lead.id, bl2.body.lead.id)) === 2, bd.body);

  console.log('16.03 consent per channel');
  const Lc = await mkLead(tk.A, { company: `ZZ C Consent ${P}`, email: `consent${P}@consent-example.in` });
  const cw = await call('POST', `/crm/plusc/consent/lead/${Lc.body.lead.id}`, { channel: 'email', status: 'withdrawn', source: 'Told us on a call' }, tk.A);
  check('withdrawn for email: recorded, and the address is opted out of every CRM email', cw.status === 200 && cw.body.channels.email.status === 'Withdrawn' && (await n('SELECT COUNT(*) n FROM "CrmOptOut" WHERE "value" = ? AND "channel" = \'email\'', `consent${P}@consent-example.in`)) === 1, cw.body.channels);
  const cg = await call('POST', `/crm/plusc/consent/lead/${Lc.body.lead.id}`, { channel: 'whatsapp', status: 'given', purpose: 'Product updates', source: 'Website form' }, tk.A);
  check('given for WhatsApp, with purpose and source; the other channels say "Not asked"', cg.body.channels.whatsapp.status === 'Given' && cg.body.channels.whatsapp.purpose === 'Product updates' && cg.body.channels.sms.status === 'Not asked', cg.body.channels);
  check('a Viewer cannot change consent', (await call('POST', `/crm/plusc/consent/lead/${Lc.body.lead.id}`, { channel: 'sms', status: 'given' }, tk.V)).status === 403);

  console.log('16.04 data-subject requests');
  check('a Salesperson cannot open one', (await call('POST', '/crm/plusc/dsr', { type: 'export', person: `consent${P}@consent-example.in` }, tk.A)).status === 403);
  const dx = await call('POST', '/crm/plusc/dsr', { type: 'export', person: `consent${P}@consent-example.in` }, tk.M);
  const dxf = await call('GET', `/crm/plusc/dsr/${dx.body.request.id}/export`, null, tk.M);
  let exported = {}; try { exported = JSON.parse(dxf.body.text || JSON.stringify(dxf.body)); } catch { exported = {}; }
  check('an export request finds the lead and gives everything as a file', dx.status === 200 && dx.body.request.detail.found.leads === 1 && exported.leads && exported.leads[0].id === Lc.body.lead.id && exported.consent.length >= 1, [dx.body, Object.keys(exported)]);
  const de = await call('POST', '/crm/plusc/dsr', { type: 'erase', person: `consent${P}@consent-example.in` }, tk.M);
  check('an erase needs the confirm', (await call('POST', `/crm/plusc/dsr/${de.body.request.id}/erase`, {}, tk.M)).status === 400);
  const der = await call('POST', `/crm/plusc/dsr/${de.body.request.id}/erase`, { confirm: true }, tk.M);
  const gone = await q1('SELECT * FROM "CrmLead" WHERE "id" = ?', Lc.body.lead.id);
  check('erased: name, phone, email gone, the address stays opted out on every channel', der.status === 200 && gone.contactName === 'Erased person' && !gone.email && !gone.phone && (await n('SELECT COUNT(*) n FROM "CrmOptOut" WHERE "value" = ?', `consent${P}@consent-example.in`)) >= 1, [der.body, gone]);

  console.log('16.10 Do-Not-Disturb');
  const dndNum = `98${String(P).padStart(8, '1').slice(-8)}`;
  check('a Salesperson cannot upload the DND list', (await call('POST', '/crm/plusc/dnd/upload', null, tk.A, { raw: Buffer.from(dndNum) })).status === 403);
  const dup = await call('POST', '/crm/plusc/dnd/upload', null, tk.M, { raw: Buffer.from(`Number\n+91 ${dndNum}\n12345\n`) });
  check('the uploaded DND file keeps its 10-digit numbers', dup.status === 200 && dup.body.added === 1, dup.body);
  check('the number checks as DND', (await call('GET', `/crm/plusc/dnd/check?phone=${dndNum}`, null, tk.A)).body.dnd === true);
  const Ld = await mkLead(tk.A, { company: `ZZ C DND ${P}`, phone: dndNum });
  const cl = await call('POST', '/crm/contact/call', { kind: 'lead', id: Ld.body.lead.id }, tk.A);
  check('a CRM call to a DND number is refused', cl.status === 409 && cl.body.dnd === true, cl.body);
  await call('POST', '/crm/plusc/dnd/clear', { phone: dndNum }, tk.M);
  const cl2 = await call('POST', '/crm/contact/call', { kind: 'lead', id: Ld.body.lead.id }, tk.A);
  check('cleared by a Sales manager: the call is no longer stopped for DND', !(cl2.body && cl2.body.dnd), cl2.body);
  await prisma.integration.upsert({ where: { id: 'crm-dnd' }, create: { id: 'crm-dnd', values: JSON.stringify({ 'Check URL (use {number})': 'https://dnd.example.test/{number}', 'API key': 'k' }) }, update: { values: JSON.stringify({ 'Check URL (use {number})': 'https://dnd.example.test/{number}', 'API key': 'k' }) } });
  await call('PUT', '/crm/plusc/dnd', { providerOn: true }, tk.M);
  check('with the provider switched on, its answer is used (stub: a number ending 0000 is DND)', (await call('GET', '/crm/plusc/dnd/check?phone=9876500000', null, tk.A)).body.dnd === true && (await call('GET', '/crm/plusc/dnd/check?phone=9876512345', null, tk.A)).body.dnd === false);

  console.log('01.06 lead assignment rules');
  const ar = await call('POST', '/crm/plusc/assign-rules', { name: 'Portal leads', match: [{ field: 'source', op: 'is', value: 'IndiaMART, TradeIndia' }], ownerIds: [B.id] }, tk.M);
  const ar2 = await call('POST', '/crm/plusc/assign-rules', { name: 'Hyderabad', match: [{ field: 'city', op: 'contains', value: 'hyderabad' }], ownerIds: [A.id, B.id] }, tk.M);
  check('a Sales manager adds two rules', ar.status === 200 && ar2.status === 200 && ar2.body.rules.length === 2, ar2.body);
  check('routing is off until switched on', ar2.body.on === false);
  const tst = await call('POST', '/crm/plusc/assign-rules/test', { source: 'IndiaMART', city: 'Pune' }, tk.M);
  check('"Test" says who would get a lead', tst.body.owner && tst.body.owner.id === B.id, tst.body);
  await call('PUT', '/crm/plusc/assign-rules/switch', { on: true }, tk.M);
  const h1 = await call('POST', '/crm/leads', { company: `ZZ C Hyd One ${P}`, city: 'Hyderabad', phone: phone() }, tk.M);
  const h2 = await call('POST', '/crm/leads', { company: `ZZ C Hyd Two ${P}`, city: 'Old Hyderabad', phone: phone() }, tk.M);
  check('a "+ Lead" with the owner left empty goes by the rule, in turn', h1.body.lead.ownerId === A.id && h2.body.lead.ownerId === B.id, [h1.body.lead && h1.body.lead.ownerName, h2.body.lead && h2.body.lead.ownerName]);
  check('a Salesperson\'s own new lead stays theirs', (await mkLead(tk.A, { company: `ZZ C Mine ${P}`, city: 'Hyderabad' })).body.lead.ownerId === A.id);

  console.log('01.11 leads from email / chat / social / ads');
  const cap = await call('GET', '/crm/plusc/capture', null, tk.M);
  const KEY = cap.body.key;
  check('the capture key is made; every source is off', cap.status === 200 && /^tlcap_/.test(KEY) && !Object.values(cap.body.on).some(Boolean), cap.body);
  check('a Salesperson cannot see the capture settings', (await call('GET', '/crm/plusc/capture', null, tk.A)).status === 403);
  const off = await call('POST', `/crm/capture/chat?key=${KEY}`, { name: 'Chat Person', phone: phone(), message: 'Hi' });
  check('a source that is off refuses', off.status === 403, off.body);
  check('a wrong key is refused', (await call('POST', '/crm/capture/chat?key=nope', { name: 'X', phone: phone() })).status === 401);
  await call('PUT', '/crm/plusc/capture', { on: { chat: true, email: true, google: true, linkedin: true, facebook: true, justdial: true, webhook: true } }, tk.M);
  const chatPh = phone();
  const ch1 = await call('POST', `/crm/capture/chat?key=${KEY}`, { name: `Chat Person ${P}`, phone: chatPh, message: 'Need a demo of HRMS', page_url: 'https://site.example/pricing' });
  const ch2 = await call('POST', `/crm/capture/chat?key=${KEY}`, { name: `Chat Person ${P}`, phone: chatPh, message: 'Hello again' });
  const chatLead = ch1.body.id ? await q1('SELECT * FROM "CrmLead" WHERE "id" = ?', ch1.body.id) : null;
  check('the chat box makes a lead (source Chat); the same phone again is a note', ch1.status === 200 && chatLead && chatLead.source === 'Chat' && ch2.body.duplicate === true, [ch1.body, chatLead && chatLead.source, ch2.body]);
  const em = await call('POST', `/crm/capture/email?key=${KEY}`, { from: `"Priya Shah" <priya${P}@globex-example.in>`, subject: 'Quote for ATS', text: `Please call me on 98765 4${String(P).slice(-4).padStart(4, '0')}` }, null, { type: 'application/json' });
  const emLead = em.body.id ? await q1('SELECT * FROM "CrmLead" WHERE "id" = ?', em.body.id) : null;
  check('an inbound email (SendGrid / Mailgun shape) makes a lead with the company from the email domain', em.status === 200 && emLead && emLead.company === 'Globex-example' && emLead.contactName === 'Priya Shah' && emLead.source === 'Email', [em.body, emLead && [emLead.company, emLead.contactName]]);
  const gg = await call('POST', '/crm/capture/google', { google_key: KEY, lead_id: `g${P}`, user_column_data: [{ column_id: 'FULL_NAME', string_value: `Gopal ${P}` }, { column_id: 'PHONE_NUMBER', string_value: phone() }, { column_id: 'COMPANY_NAME', string_value: `Google Lead Co ${P}` }] });
  const gg2 = await call('POST', '/crm/capture/google', { google_key: KEY, lead_id: `g${P}`, user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Again' }, { column_id: 'PHONE_NUMBER', string_value: phone() }] });
  check('a Google Ads lead form makes a lead; the same lead id twice is kept once', gg.status === 200 && !!gg.body.id && gg2.body.already === true, [gg.body, gg2.body]);
  const li = await call('POST', `/crm/capture/linkedin?key=${KEY}`, { firstName: 'Lata', lastName: `L${P}`, emailAddress: `lata${P}@initech-example.in`, companyName: `Initech ${P}`, jobTitle: 'HR Head', formName: 'Demo form' });
  check('a LinkedIn lead-gen form (webhook / Zapier) makes a lead', li.status === 200 && (await q1('SELECT "source", "designation" FROM "CrmLead" WHERE "id" = ?', li.body.id)).designation === 'HR Head', li.body);
  await prisma.integration.upsert({ where: { id: 'crm-lead-ads' }, create: { id: 'crm-lead-ads', values: JSON.stringify({ 'Page access token': 'EAAtest', 'App secret': 'fb-secret', 'Verify token': 'verify-me' }) }, update: { values: JSON.stringify({ 'Page access token': 'EAAtest', 'App secret': 'fb-secret', 'Verify token': 'verify-me' }) } });
  const fv = await fetch(`${API}/crm/capture/facebook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`).then(async (r) => [r.status, await r.text()]);
  check('Meta\'s subscribe check is answered with the challenge', fv[0] === 200 && fv[1] === '12345', fv);
  const fbBody = JSON.stringify({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: `fb${P}`, field_data: [{ name: 'full_name', values: [`Farah ${P}`] }, { name: 'phone_number', values: [phone()] }, { name: 'company_name', values: [`FB Co ${P}`] }, { name: 'budget', values: ['5 lakh'] }] } }] }] });
  const badSig = await call('POST', '/crm/capture/facebook', null, null, { raw: Buffer.from(fbBody), type: 'application/json', headers: { 'X-Hub-Signature-256': 'sha256=00' } });
  const sig = `sha256=${crypto.createHmac('sha256', 'fb-secret').update(fbBody).digest('hex')}`;
  const fb = await call('POST', '/crm/capture/facebook', null, null, { raw: Buffer.from(fbBody), type: 'application/json', headers: { 'X-Hub-Signature-256': sig } });
  const fbLead = await q1('SELECT * FROM "CrmLead" WHERE "company" = ?', `FB Co ${P}`);
  check('a lead-ads webhook with a bad signature is refused; a signed one makes the lead (extra answers in its notes)', badSig.status === 401 && fb.status === 200 && fb.body.added === 1 && fbLead && fbLead.source === 'Facebook lead ads' && /budget: 5 lakh/.test(fbLead.notes || ''), [badSig.status, fb.body, fbLead && fbLead.notes]);

  console.log('01.14 India portals');
  const jd = await fetch(`${API}/crm/capture/justdial?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ leadid: `jd${P}`, name: `JD Buyer ${P}`, mobile: phone(), city: 'Vizag', category: 'Payroll software' }).toString() }).then(async (r) => [r.status, await r.text()]);
  check('a JustDial push makes a lead and is answered RECEIVED', jd[0] === 200 && jd[1] === 'RECEIVED' && (await q1('SELECT "source" FROM "CrmLead" WHERE "contactName" = ?', `JD Buyer ${P}`)).source === 'JustDial', jd);
  const pullNo = await call('POST', '/crm/plusc/capture/pull/indiamart', null, tk.M);
  check('IndiaMART without its key says it is not connected', pullNo.status === 409 && pullNo.body.notConfigured, pullNo.body);
  await prisma.integration.upsert({ where: { id: 'crm-india-portals' }, create: { id: 'crm-india-portals', values: JSON.stringify({ 'IndiaMART CRM key': 'im-key', 'TradeIndia user ID': 'u', 'TradeIndia profile ID': 'p', 'TradeIndia key': 'k' }) }, update: { values: JSON.stringify({ 'IndiaMART CRM key': 'im-key', 'TradeIndia user ID': 'u', 'TradeIndia profile ID': 'p', 'TradeIndia key': 'k' }) } });
  const pIm = await call('POST', '/crm/plusc/capture/pull/indiamart', null, tk.M);
  const imLead = await q1('SELECT * FROM "CrmLead" WHERE "company" = \'Portal Buyer Traders\'');
  check('"Pull now" reads IndiaMART (a stub on a test server); the portal-source rule gives it to Salesperson B', pIm.status === 200 && pIm.body.added === 1 && imLead && imLead.source === 'IndiaMART' && imLead.ownerId === B.id, [pIm.body, imLead && [imLead.source, imLead.ownerName]]);
  const pIm2 = await call('POST', '/crm/plusc/capture/pull/indiamart', null, tk.M);
  check('the same enquiry read again is not added twice', pIm2.status === 200 && pIm2.body.added === 0 && (await n('SELECT COUNT(*) n FROM "CrmLead" WHERE "company" = \'Portal Buyer Traders\'')) === 1, pIm2.body);
  const pTi = await call('POST', '/crm/plusc/capture/pull/tradeindia', null, tk.M);
  check('TradeIndia too', pTi.status === 200 && pTi.body.added === 1 && (await q1('SELECT "source" FROM "CrmLead" WHERE "company" = \'Trade Buyer Exports\'')).source === 'TradeIndia', pTi.body);
  const snip = await call('GET', '/crm/plusc/capture/snippet', null, tk.M);
  check('the chat-box snippet and the addresses for each source are given', snip.status === 200 && snip.body.snippet.includes('/api/crm/capture/chat?key=') && snip.body.urls.justdial.includes(KEY), snip.body.urls);
  check('the CRM sources list now has the portal sources', (await call('GET', '/crm/me', null, tk.M)).body.lists.sources.includes('IndiaMART'));

  console.log('17.04 multi-currency deals');
  const usd = await call('POST', '/crm/deals', { title: `ZZ C USD Deal ${P}`, accountId: AC.body.account.id, currency: 'USD', amountForeign: 1000 }, tk.A);
  check('a deal priced in US dollars keeps the amount and the rate; its value is in rupees', usd.status === 200 && usd.body.deal.currency === 'USD' && usd.body.deal.amountForeign === 1000 && usd.body.deal.fxRate === 84 && usd.body.deal.value === 84000, usd.body);
  await call('PUT', '/crm/plusc/prefs', { currencies: [{ code: 'USD', symbol: '$', rate: 90 }, { code: 'EUR', symbol: '€', rate: 95 }] }, tk.M);
  const usd2 = await call('PUT', `/crm/deals/${usd.body.deal.id}`, { amountForeign: 2000 }, tk.A);
  check('a rate change later does not move a deal already priced (the deal keeps its rate)', usd2.status === 200 && usd2.body.deal.value === 168000 && usd2.body.deal.fxRate === 84, usd2.body.deal);
  check('an unknown currency is refused', (await call('POST', '/crm/deals', { title: 'x', accountId: AC.body.account.id, currency: 'XYZ', amountForeign: 5 }, tk.A)).status === 400);
  check('the deal list filters by currency', (await call('GET', '/crm/deals?currency=USD', null, tk.A)).body.rows.every((d) => d.currency === 'USD'));

  console.log('17.05 business units');
  const pu = await call('PUT', '/crm/plusc/prefs', { unitsOn: true, units: [{ id: 'unit_staffing', name: 'TeamLink Staffing', gstin: '36ABCDE1234F1Z5', address: 'Hyderabad', state: 'Telangana' }, { id: 'unit_soft', name: 'TeamLink Software' }] }, tk.X);
  check('an Admin adds two business units', pu.status === 200 && pu.body.units.length === 2, pu.body);
  check('a wrong GSTIN on a unit is refused', (await call('PUT', '/crm/plusc/prefs', { units: [{ name: 'Bad', gstin: 'XX' }] }, tk.X)).status === 400);
  const ud = await call('POST', '/crm/deals', { title: `ZZ C Unit Deal ${P}`, accountId: AC2.body.account.id, value: 50000, unitId: 'unit_staffing' }, tk.A);
  const won = await call('POST', `/crm/deals/${ud.body.deal.id}/stage`, { stage: 'Won' }, tk.A);
  const inv = won.body.invoice || {};
  check('a deal of a unit is invoiced from that unit (its name and GSTIN)', ud.body.deal.unitId === 'unit_staffing' && won.status === 200 && inv.from && inv.from.name === 'TeamLink Staffing' && inv.from.gstin === '36ABCDE1234F1Z5', [ud.body.deal && ud.body.deal.unitId, inv.from]);
  check('lists filter by unit', (await call('GET', '/crm/deals?unit=unit_staffing', null, tk.A)).body.rows.map((d) => d.id).join() === ud.body.deal.id);

  console.log('17.06 localisation');
  const loc = await call('PUT', '/crm/plusc/prefs', { locale: { numbers: 'en-US' } }, tk.M);
  check('the number format is set and reaches every screen', loc.status === 200 && (await call('GET', '/crm/plusc/setup', null, tk.A)).body.locale.numbers === 'en-US');
  await call('PUT', '/crm/plusc/prefs', { locale: { numbers: 'en-IN' } }, tk.M);

  console.log('17.07 the configuration package (test copy)');
  const pkg = await call('GET', '/crm/plusc/package', null, tk.M);
  let pk = null; try { pk = JSON.parse(pkg.body.text || JSON.stringify(pkg.body)); } catch { pk = null; }
  check('a Sales manager downloads the whole CRM set-up as one file (no capture key, no team)', pkg.status === 200 && pk && pk.kind === 'teamlink-crm-config' && pk.fields.length >= 2 && !pk.plus.capture.key && !pk.settings.salesTeam, pk && Object.keys(pk));
  check('a Salesperson cannot', (await call('GET', '/crm/plusc/package', null, tk.A)).status === 403);
  pk.fields.push({ id: `cfd_new${P}`, kind: 'deal', key: 'cf_po_number', label: 'PO number', type: 'text', optionsJson: '[]', required: 0, sensitive: 0, position: 99, active: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const pd = await call('POST', '/crm/plusc/package', null, tk.M, { raw: Buffer.from(JSON.stringify(pk)) });
  check('loading it again: the dry run says one new field and nothing else new', pd.status === 200 && pd.body.dryRun && pd.body.plan.fields.add === 1, pd.body);
  const pa = await call('POST', '/crm/plusc/package?apply=1', null, tk.M, { raw: Buffer.from(JSON.stringify(pk)) });
  check('applied: the new field is there', pa.status === 200 && (await call('GET', '/crm/plusc/fields?kind=deal', null, tk.A)).body.fields.some((f) => f.key === 'cf_po_number'), pa.body);

  console.log('17.08 financial year and holidays');
  const fy = await call('PUT', '/crm/plusc/prefs', { fiscal: { startMonth: 4, holidays: [{ date: '2026-12-25', name: 'Christmas' }] } }, tk.M);
  await wait(200);
  const ov = await call('GET', '/crm/overview?period=fyear', null, tk.M);
  const chq = await call('GET', '/crm/charts?period=fquarter', null, tk.M);
  check('the reports work on the financial year and quarter', fy.status === 200 && ov.status === 200 && /financial year 2026-27/.test(JSON.stringify(ov.body)) && chq.status === 200, [ov.status, JSON.stringify(ov.body).match(/financial year[^"]*/), chq.status]);
  check('holidays are kept for the calendar', (await call('GET', '/crm/plusc/setup', null, tk.A)).body.fiscal.holidays[0].name === 'Christmas');

  console.log('17.09 branding');
  const lg = await call('POST', '/crm/plusc/prefs/logo', null, tk.M, multipart('file', 'logo.png', 'image/png', PNG));
  await call('PUT', '/crm/plusc/prefs', { branding: { color: '#0f766e', tagline: 'People first' } }, tk.M);
  check('a logo and a colour are set', lg.status === 200 && lg.body.branding.logo && (await call('GET', '/crm/plusc/prefs', null, tk.A)).body.branding.color === '#0f766e', lg.body);
  check('a logo that is not a picture is refused', (await call('POST', '/crm/plusc/prefs/logo', null, tk.M, multipart('file', 'x.pdf', 'application/pdf', Buffer.from('%PDF-1.4')))).status === 400);
  const pdf = await call('GET', `/crm/invoices/${inv.id}/pdf`, null, tk.A);
  check('the invoice PDF is made with the new branding', pdf.status === 200 && /pdf/.test(pdf.type) && pdf.body.bytes > 1000, [pdf.status, pdf.type]);

  console.log('17.12 adoption');
  const ad = await call('GET', '/crm/plusc/adoption?days=7', null, tk.M);
  const rowA = ad.body.rows && ad.body.rows.find((x) => x.userId === A.id);
  check('the adoption report shows each person\'s days, changes and work', ad.status === 200 && rowA && rowA.daysActive >= 1 && rowA.changes >= 1 && rowA.recordsAdded >= 1 && ad.body.daily.length >= 1, rowA);
  check('the Viewer (never opened) is flagged as not using it... or counted', ad.body.rows.some((x) => x.userId === V.id));
  check('a Salesperson cannot read it', (await call('GET', '/crm/plusc/adoption', null, tk.A)).status === 403);

  console.log('regressions');
  check('a plain lead still saves with nothing extra', (await mkLead(tk.A, { company: `ZZ C Plain ${P}` })).status === 200);
  check('the lead export still works and carries the custom field column', /Budget band/.test((await call('GET', '/crm/export/leads', null, tk.M)).body.text.split('\n')[0]));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

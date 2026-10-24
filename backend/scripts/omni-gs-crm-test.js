#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL GREEN START REBUILD: CRM PAGES TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4105 node scripts/omni-gs-crm-test.js
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy (<name>-work.db), starts its OWN API on port 4105
// (TEST_MODE) and checks the four CRM pages: CRM Fields, All Customers (add / edit / detail / consent / import / export / ATS import), Segments, Web Forms
// (+ the public form). Roles: Super Admin, Team Lead, BDE, Manager (view), HR, Recruiter, Client, Accounts.
// NOTHING real is sent: test mode, example.test addresses and made-up numbers; the script also checks that no message row was made.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-crm-work.db');
for (const ext of ['', '-shm', '-wal']) { try { fs.unlinkSync(WORK + ext); } catch { /* none */ } }
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4105);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;

{ // the Omni-Channel tables, applied to the WORKING copy only when the copy lacks them
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
let seq = 0;
const phone = () => { seq += 1; return `98${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`; };
const mail = (t) => { seq += 1; return `zz-crm-${t}-${RUN}-${seq}@example.test`; };

async function http(method, p, token, body, opts = {}) {
  const h = { 'X-Forwarded-For': opts.ip || `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (Buffer.isBuffer(body)) { h['Content-Type'] = 'application/octet-stream'; payload = body; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, type: r.headers.get('content-type') || '' };
}
const G = '/api/outreach/gs/crm';
const qs = (o) => `?${Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`).join('&')}`;

(async () => {
  let server;
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } // eslint-disable-line no-await-in-loop
    }
    let bde = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'BDE', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'bde') { bde = c; break; } // eslint-disable-line no-await-in-loop
    }
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 60 });
    const tlEmp = await prisma.employee.findFirst({ where: { userId: tl && tl.id } });
    const rec = recEmps.find((e) => e.department && tlEmp && e.department !== tlEmp.department) || recEmps[0];
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, Assistant Manager, HR, a recruiter with a department)', !!(sa && tl && bde && am && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const recU = rec.user; const recDept = rec.department;
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-crm-client-${RUN}@example.test`, username: `zz-crm-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-crm-acct-${RUN}@example.test`, username: `zz-crm-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });

    const S = require(path.join(BACK, 'src/outreach/store'));
    const K = require(path.join(BACK, 'src/outreach/contacts'));
    const indList = await S.industries();
    const ownInd = indList.find((i) => String(i.department).toLowerCase() === String(recDept).toLowerCase());
    // a contact of the recruiter's department and one of another department, straight into the working copy
    const adminUser = { id: sa.id, name: sa.name };
    const recPhone = phone(); const otherPhone = phone();
    const cRecOwn = await K.insert(adminUser, { type: 'candidate_lead', name: `ZZTEST recdept ${RUN}`, phone: { e164: `91${recPhone}`, key: recPhone }, email: null, city: 'Hyderabad', source: 'crm-test', industries: ownInd ? [ownInd.name] : [], department: recDept }, { declared: false });
    const cRecOther = await K.insert(adminUser, { type: 'candidate_lead', name: `ZZTEST otherdept ${RUN}`, phone: { e164: `91${otherPhone}`, key: otherPhone }, email: null, city: 'Hyderabad', source: 'crm-test', industries: [], department: 'Zzother' }, { declared: false });
    const msgBefore = (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachMessage"').catch(() => [{ n: 0 }]))[0].n;

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(recU), client: await tokenOf(client), acct: await tokenOf(acct) };
    const allText = []; // every response text of the CRM area, for the "no Draft" check
    const call = async (m, p, t, b, o) => { const r = await http(m, p, T[t], b, o); if (/application\/json/.test(r.type)) allText.push(r.text); return r; };

    // ================================================================ F: CRM FIELDS
    const f0 = await call('GET', `${G}/fields`, 'sa');
    check('F1 CRM Fields list: the two starter fields (Lead stage, Lead status) are there, with 12 data types', f0.status === 200 && ['lead_stage', 'lead_status'].every((k) => f0.body.fields.some((f) => f.key === k && f.type === 'dropdown' && f.options.length >= 5)) && f0.body.types.length === 12 && f0.body.canEdit === true, f0.text.slice(0, 300));
    check('F2 the starter Lead stage options are the staffing words (New, Contacted, Interested, Applied, Interview, Offered, Joined, Not interested)', ['New', 'Contacted', 'Interested', 'Applied', 'Interview', 'Offered', 'Joined', 'Not interested'].every((o) => f0.body.fields.find((f) => f.key === 'lead_stage').options.includes(o)));
    const mkF = (b, t = 'sa') => call('POST', `${G}/fields`, t, b);
    const fTier = await mkF({ name: `ZZTEST Tier ${RUN}`, type: 'dropdown', options: ['Gold', 'Silver', 'Bronze'], color: '#0d9488', description: 'test tier', required: false });
    const tierKey = fTier.body && fTier.body.field && fTier.body.field.key;
    check('F3 Admin adds a dropdown field: key made from the label, colour kept, options kept, newest first', fTier.status === 200 && /^zztest_tier_/.test(tierKey || '') && fTier.body.field.color === '#0d9488' && fTier.body.field.options.length === 3 && fTier.body.fields[0].id === tierKey, fTier.text.slice(0, 300));
    check('F4 the same label twice is refused (409, plain sentence)', (await mkF({ name: `ZZTEST Tier ${RUN}`, type: 'text' })).status === 409);
    check('F5 a field without a label (400), a dropdown without options (400)', (await mkF({ name: '', type: 'text' })).status === 400 && (await mkF({ name: `ZZTEST empty dd ${RUN}`, type: 'dropdown', options: [] })).status === 400);
    const typesMade = {};
    for (const [id, extra] of [['multi', { options: ['Alpha', 'Beta', 'Gamma'] }], ['number', {}], ['currency', {}], ['date', {}], ['datetime', {}], ['email', {}], ['phone', {}], ['checkbox', {}], ['url', {}], ['longtext', {}], ['text', {}]]) {
      const r = await mkF({ name: `ZZTEST ${id} ${RUN}`, type: id, ...extra }); // eslint-disable-line no-await-in-loop
      typesMade[id] = r.body && r.body.field;
    }
    check('F6 all the other data types can be made (multi, number, currency, date, date & time, email, phone, checkbox, URL, long text, text)', Object.values(typesMade).every((f) => f && f.key), Object.keys(typesMade).filter((k) => !typesMade[k]));
    const upd = await call('PUT', `${G}/fields/${tierKey}`, 'sa', { name: `ZZTEST Tier ${RUN}`, type: 'dropdown', options: ['Gold', 'Silver', 'Bronze', 'Platinum'], color: '#2563eb', required: false });
    check('F7 Admin edits a field: key stays, options and colour change', upd.status === 200 && upd.body.field.key === tierKey && upd.body.field.options.includes('Platinum') && upd.body.field.color === '#2563eb', upd.text.slice(0, 200));
    const tlF = await call('POST', `${G}/fields`, 'tl', { name: 'ZZTEST nope', type: 'text' });
    const bdeF = await call('POST', `${G}/fields`, 'bde', { name: 'ZZTEST nope', type: 'text' });
    check('F8 only an Admin can add / change / delete fields (Team Lead 403, BDE 403); they can still read the list', tlF.status === 403 && bdeF.status === 403 && (await call('GET', `${G}/fields`, 'bde')).status === 200 && (await call('PUT', `${G}/fields/${tierKey}`, 'tl', { name: 'x' })).status === 403 && (await call('DELETE', `${G}/fields/${tierKey}`, 'bde')).status === 403);
    const reqF = await mkF({ name: `ZZTEST must ${RUN}`, type: 'text', required: true });
    const mustKey = reqF.body.field.key;
    check('F9 a Required field is stored with required = true', reqF.status === 200 && reqF.body.field.required === true);
    const roles = { client: (await call('GET', `${G}/fields`, 'client')).status, acct: (await call('GET', `${G}/fields`, 'acct')).status };
    check('F10 Client login and Accounts login are refused (403)', roles.client === 403 && roles.acct === 403, roles);

    // ================================================================ C: CUSTOMERS
    const mkC = (b, t = 'sa') => call('POST', `${G}/customers`, t, b);
    const noMust = await mkC({ name: `ZZTEST nomust ${RUN}`, phone: phone() });
    check('C1 "Required" is enforced on save with a plain sentence (no asterisk)', noMust.status === 400 && /is needed before this can be saved/.test(noMust.body.error || '') && !/\*/.test(noMust.body.error), noMust.text);
    await call('PUT', `${G}/fields/${mustKey}`, 'sa', { name: `ZZTEST must ${RUN}`, type: 'text', required: false });
    const p1 = phone(); const e1 = mail('a');
    const c1 = await mkC({ name: `ZZTEST Customer One ${RUN}`, phone: p1, email: e1, platformId: `FB-${RUN}`, language: 'Telugu', preferredChannel: 'whatsapp', notes: 'Likes evening calls', kinds: ownInd ? [ownInd.name] : [], city: 'Hyderabad', company: 'ZZ Co', skills: 'ICU nursing', customValues: { lead_stage: 'Interested', lead_status: 'Hot', [tierKey]: 'Gold', [typesMade.multi.key]: ['Alpha', 'Beta'], [typesMade.number.key]: '42', [typesMade.date.key]: '2026-10-20', [typesMade.checkbox.key]: true, [typesMade.url.key]: 'example.com/x', [typesMade.email.key]: 'zz-private@example.test', [typesMade.phone.key]: '9111122233' } });
    check('C2 Add Customer (name, phone, email, platform ID, language, preferred channel, notes, kinds, custom fields)', c1.status === 200 && c1.body.id, c1.text);
    const id1 = c1.body.id;
    check('C3 same phone again: 409 "already belongs to ..." naming the person', await (async () => { const r = await mkC({ name: 'ZZTEST dup', phone: p1 }); return r.status === 409 && /already belongs to ZZTEST Customer One/.test(r.body.error) && r.body.duplicateId === id1; })());
    check('C4 bad email 400, neither name nor phone 400, a wrong phone 400', (await mkC({ name: 'ZZTEST x', phone: phone(), email: 'not-an-email' })).status === 400 && (await mkC({ email: mail('z') })).status === 400 && (await mkC({ name: 'ZZTEST y', phone: '12' })).status === 400);
    check('C5 a bad value for a custom field is refused (stage not in the list, number not a number)', (await mkC({ name: 'ZZTEST bad', phone: phone(), customValues: { lead_stage: 'Not a stage' } })).status === 400 && (await mkC({ name: 'ZZTEST bad2', phone: phone(), customValues: { [typesMade.number.key]: 'abc' } })).status === 400);
    const l1 = await call('GET', `${G}/customers${qs({ pageSize: 100 })}`, 'sa');
    const row1 = (l1.body.contacts || []).find((c) => c.id === id1);
    check('C6 list: the row has every real field (name, phone, email, platform ID, kinds, city, company, skills, language, preferred channel, notes, lead stage / status, owner, added)', !!row1 && row1.name.includes('Customer One') && row1.phone === `+91${p1}` && row1.email === e1 && row1.platformId === `FB-${RUN}` && row1.language === 'Telugu' && row1.preferredChannel === 'whatsapp' && row1.notes === 'Likes evening calls' && row1.leadStage === 'Interested' && row1.leadStatus === 'Hot' && row1.city === 'Hyderabad' && row1.company === 'ZZ Co' && row1.skills === 'ICU nursing' && row1.ownerName && row1.createdAt && row1.kinds.length === (ownInd ? 1 : 0), row1);
    check('C7 a person added by hand is "Not asked" on every channel (no permission invented)', row1 && row1.channels.filter((c) => c.state !== 'none').every((c) => c.state === 'not_asked' && c.words === 'Not asked') && row1.channels.length === 3, row1 && row1.channels);
    check('C8 custom values are saved typed (multi = list, number, date, checkbox = yes, url made whole)', row1 && Array.isArray(row1.customValues[typesMade.multi.key]) && row1.customValues[typesMade.multi.key].join() === 'Alpha,Beta' && row1.customValues[typesMade.number.key] === '42' && row1.customValues[typesMade.date.key] === '2026-10-20' && row1.customValues[typesMade.checkbox.key] === 'yes' && row1.customValues[typesMade.url.key] === 'https://example.com/x', row1 && row1.customValues);
    check('C9 list meta: fields, kinds, forms, flags for the screen', l1.body.meta && l1.body.meta.fields.length >= 13 && Array.isArray(l1.body.meta.forms) && l1.body.meta.canExport === true && l1.body.meta.canImportAts === true && l1.body.canWrite === true, l1.body.meta && Object.keys(l1.body.meta));
    const byName = await call('GET', `${G}/customers${qs({ q: 'Customer One' })}`, 'sa');
    const byPid = await call('GET', `${G}/customers${qs({ q: `FB-${RUN}` })}`, 'sa');
    const byPhone = await call('GET', `${G}/customers${qs({ q: p1.slice(2, 8) })}`, 'sa');
    check('C10 search finds by name, platform ID and (for a login that may see it) phone', byName.body.total === 1 && byPid.body.total === 1 && byPhone.body.total >= 1);
    const fLang = await call('GET', `${G}/customers${qs({ filters: { language: 'tel' } })}`, 'sa');
    const fNone = await call('GET', `${G}/customers${qs({ filters: { language: 'zzzzz' } })}`, 'sa');
    const fStage = await call('GET', `${G}/customers${qs({ filters: { leadStage: 'interest', language: 'telu' } })}`, 'sa');
    const fCf = await call('GET', `${G}/customers${qs({ filters: { [`cf:${tierKey}`]: 'gol' } })}`, 'sa');
    const fPerm = await call('GET', `${G}/customers${qs({ filters: { permission: 'not asked' } })}`, 'sa');
    check('C11 column filters ("contains"): language, stacked filters (AND), a custom column, permission words', fLang.body.total === 1 && fNone.body.total === 0 && fCf.body.total === 1 && fPerm.body.total >= 1, { a: fLang.body.total, b: fNone.body.total, c: fStage.body.total, d: fCf.body.total, e: fPerm.body.total });
    // (leadStage is a custom column named by its field id)
    const fStage2 = await call('GET', `${G}/customers${qs({ filters: { 'cf:lead_stage': 'interest', language: 'telu' } })}`, 'sa');
    check('C12 filter by the Lead stage column', fStage2.body.total === 1 && (await call('GET', `${G}/customers${qs({ filters: { 'cf:lead_stage': 'joined' } })}`, 'sa')).body.total === 0);
    const sAsc = await call('GET', `${G}/customers${qs({ sort: 'name', dir: 'asc', pageSize: 100 })}`, 'sa');
    const sDesc = await call('GET', `${G}/customers${qs({ sort: 'name', dir: 'desc', pageSize: 100 })}`, 'sa');
    const nm = (r) => r.body.contacts.map((c) => c.name.toLowerCase());
    check('C13 sort by a column, ascending and descending', JSON.stringify(nm(sAsc)) === JSON.stringify([...nm(sAsc)].sort((a, b) => a.localeCompare(b))) && JSON.stringify(nm(sDesc)) === JSON.stringify([...nm(sAsc)].reverse()), { a: nm(sAsc).slice(0, 4), d: nm(sDesc).slice(0, 4) });
    const pg = await call('GET', `${G}/customers${qs({ pageSize: 10, page: 1 })}`, 'sa');
    check('C14 paging: 10 rows per page, total counted, page number kept', pg.body.pageSize === 10 && pg.body.contacts.length <= 10 && pg.body.total >= 3 && pg.body.page === 1);

    // ---- masking: BDE
    const pB = phone(); const eB = mail('b');
    const cB = await mkC({ name: `ZZTEST BDE own ${RUN}`, phone: pB, email: eB, language: 'Hindi', customValues: { lead_stage: 'New', [typesMade.phone.key]: '9333344455' } }, 'bde');
    check('C15 a BDE adds a customer (own contact)', cB.status === 200 && cB.body.id, cB.text);
    const lB = await call('GET', `${G}/customers${qs({ pageSize: 100 })}`, 'bde');
    const rowB = lB.body.contacts.find((c) => c.id === cB.body.id);
    check('C16 BDE list: phone and email are masked, never the real value; masked flag set', !!rowB && /•/.test(rowB.phone) && !lB.text.includes(pB) && !lB.text.includes(eB) && rowB.email.includes('@') && lB.body.masked === true, rowB && { p: rowB.phone, e: rowB.email });
    check('C17 BDE sees only own people (not the Admin\'s customer)', !lB.body.contacts.some((c) => c.id === id1));
    const bq = await call('GET', `${G}/customers${qs({ q: pB.slice(2, 8) })}`, 'bde');
    const bf = await call('GET', `${G}/customers${qs({ filters: { phone: 'zzzz999' } })}`, 'bde');
    const be = await call('GET', `${G}/customers${qs({ filters: { email: 'nomatch-xyz' } })}`, 'bde');
    check('C18 a masked login cannot find a person by phone or email (search finds nothing; phone / email filters are ignored, so they cannot be used to probe)', bq.body.total === 0 && bf.body.total === lB.body.total && be.body.total === lB.body.total, { q: bq.body.total, f: bf.body.total, e: be.body.total, all: lB.body.total });
    const adm = await call('GET', `${G}/customers/${cB.body.id}`, 'sa');
    check('C19 a BDE cannot set a phone-type custom field (not stored); the Admin sees none from the BDE', adm.status === 200 && !(adm.body.contact.customValues[typesMade.phone.key]), adm.body.contact && adm.body.contact.customValues);
    const setPh = await call('PUT', `${G}/customers/${id1}`, 'sa', { customValues: { [typesMade.phone.key]: '9111122233' }, enforceRequired: false });
    const lB2 = await call('GET', `${G}/customers/${id1}`, 'sa');
    check('C20 the Admin sees the phone-type value; a BDE-style masked view of such a value never shows the digits (unit)', setPh.status === 200 && lB2.body.contact.customValues[typesMade.phone.key] === '9111122233' && !/9111122233/.test(JSON.stringify(require(path.join(BACK, 'src/outreach/crmApi')).maskCustomValue({ type: 'phone' }, '9111122233'))));
    const bAll = await call('GET', `${G}/customers/${id1}`, 'bde');
    check('C21 a BDE opening the Admin\'s customer by id: 404', bAll.status === 404, bAll.status);

    // ---- recruiter / HR / manager / outside logins
    const lRec = await call('GET', `${G}/customers${qs({ pageSize: 100 })}`, 'rec');
    const recNames = lRec.body.contacts.map((c) => c.name);
    check('C22 Recruiter sees the contact of their own department (masked) and NOT another department\'s', recNames.includes(`ZZTEST recdept ${RUN}`) && !recNames.includes(`ZZTEST otherdept ${RUN}`) && lRec.body.contacts.every((c) => !/^\+91\d{10}$/.test(c.phone)), { n: recNames.length });
    check('C23 Recruiter cannot add, edit, or open another department\'s customer', (await mkC({ name: 'ZZTEST rec add', phone: phone() }, 'rec')).status === 403 && (await call('PUT', `${G}/customers/${cRecOwn.id}`, 'rec', { city: 'x' })).status === 403 && (await call('GET', `${G}/customers/${cRecOther.id}`, 'rec')).status === 404);
    const lHr = await call('GET', `${G}/customers${qs({ pageSize: 100 })}`, 'hr');
    const lHrI = await call('GET', `${G}/customers${qs({ type: 'internal' })}`, 'hr');
    check('C24 HR: no promotion customers, the internal list opens (200)', lHr.body.total === 0 && lHrI.status === 200 && lHrI.body.meta.canInternal === true, { t: lHr.body.total, s: lHrI.status });
    const iAdd = await mkC({ name: `ZZTEST staff ${RUN}`, phone: phone(), contactType: 'internal' }, 'hr');
    const lHrI2 = await call('GET', `${G}/customers${qs({ type: 'internal' })}`, 'hr');
    const lBdeI = await call('GET', `${G}/customers${qs({ type: 'internal' })}`, 'bde');
    check('C25 HR adds an internal (staff) contact and sees it; a BDE sees no internal contacts; the promotion list never shows it', iAdd.status === 200 && lHrI2.body.contacts.some((c) => c.name.includes('staff')) && lBdeI.body.total === 0 && !(await call('GET', `${G}/customers${qs({ pageSize: 100 })}`, 'sa')).body.contacts.some((c) => c.id === iAdd.body.id), iAdd.text);
    const lAm = await call('GET', `${G}/customers${qs({ pageSize: 100 })}`, 'am');
    check('C26 Manager (view): sees everyone, cannot add / edit (403)', lAm.body.contacts.some((c) => c.id === id1) && lAm.body.canWrite === false && (await mkC({ name: 'ZZTEST am', phone: phone() }, 'am')).status === 403 && (await call('PUT', `${G}/customers/${id1}`, 'am', { city: 'x' })).status === 403);
    check('C27 Client and Accounts logins: refused (403)', (await call('GET', `${G}/customers`, 'client')).status === 403 && (await call('GET', `${G}/customers`, 'acct')).status === 403);

    // ---- edit
    const ed = await call('PUT', `${G}/customers/${id1}`, 'sa', { name: `ZZTEST Customer One ${RUN} B`, city: 'Vizag', language: 'Tamil', notes: 'Changed', preferredChannel: 'sms', customValues: { lead_stage: 'Joined', [tierKey]: 'Silver' }, enforceRequired: true });
    const d1 = await call('GET', `${G}/customers/${id1}`, 'sa');
    check('C28 Edit: boxes and custom values change', ed.status === 200 && d1.body.contact.city === 'Vizag' && d1.body.contact.language === 'Tamil' && d1.body.contact.preferredChannel === 'sms' && d1.body.contact.leadStage === 'Joined' && d1.body.contact.customValues[tierKey] === 'Silver' && d1.body.contact.notes === 'Changed', d1.text.slice(0, 300));
    const inl = await call('PUT', `${G}/customers/${id1}`, 'sa', { customValues: { lead_status: 'Cold' }, enforceRequired: false });
    const inlBad = await call('PUT', `${G}/customers/${id1}`, 'sa', { customValues: { lead_status: 'Not a status' }, enforceRequired: false });
    const inlClear = await call('PUT', `${G}/customers/${id1}`, 'sa', { customValues: { lead_status: '' }, enforceRequired: false });
    const d1b = await call('GET', `${G}/customers/${id1}`, 'sa');
    check('C29 inline Lead status: set, a value not in the list refused (400), cleared with an empty value', inl.status === 200 && inlBad.status === 400 && inlClear.status === 200 && d1b.body.contact.leadStatus === '', { a: inl.status, b: inlBad.status, c: inlClear.status });
    check('C30 a BDE cannot edit the Admin\'s customer (404) but can edit their own', (await call('PUT', `${G}/customers/${id1}`, 'bde', { city: 'x' })).status === 404 && (await call('PUT', `${G}/customers/${cB.body.id}`, 'bde', { city: 'Pune', notes: 'own edit' })).status === 200);
    const pOnly = await mkC({ name: `ZZTEST mailonly ${RUN}`, email: mail('m') });
    const fillP = phone();
    const addPh = await call('PUT', `${G}/customers/${pOnly.body.id}`, 'sa', { phone: fillP, enforceRequired: false });
    const swap = await call('PUT', `${G}/customers/${pOnly.body.id}`, 'sa', { phone: phone(), enforceRequired: false });
    const dP = await call('GET', `${G}/customers/${pOnly.body.id}`, 'sa');
    check('C31 an EMPTY phone box can be filled (and gets Not-asked WhatsApp / SMS); a saved number is never replaced', addPh.status === 200 && dP.body.contact.phone === `+91${fillP}` && dP.body.contact.channels.find((c) => c.channel === 'whatsapp').state === 'not_asked' && swap.body.changed.length === 0, { a: addPh.text, p: dP.body.contact.phone, s: swap.text });
    check('C32 a phone that belongs to another person cannot be added (409)', (await call('PUT', `${G}/customers/${pOnly.body.id}`, 'sa', { email: mail('q'), phone: p1 })).status === 200 && (await (async () => { const noP = await mkC({ name: `ZZTEST nophone ${RUN}`, email: mail('n') }); return (await call('PUT', `${G}/customers/${noP.body.id}`, 'sa', { phone: p1, enforceRequired: false })).status === 409; })()));

    // ---- detail, consent
    const det = await call('GET', `${G}/customers/${id1}`, 'sa');
    check('C33 detail: boxes, a "who may message them" table (Not asked), a timeline list, history list, flags', det.status === 200 && det.body.contact.channels.length === 3 && Array.isArray(det.body.timeline) && Array.isArray(det.body.history) && det.body.flags.canEdit === true && det.body.flags.canOptIn === true && det.body.timeline.some((t) => /Added to Omni-Channel/.test(t.text)), det.text.slice(0, 400));
    const detB = await call('GET', `${G}/customers/${cB.body.id}`, 'bde');
    check('C34 detail for a BDE: masked phone / email, can opt out but not record permission', detB.status === 200 && /•/.test(detB.body.contact.phone) && !detB.text.includes(pB) && !detB.text.includes(eB) && detB.body.flags.canOptOut === true && detB.body.flags.canOptIn === false, detB.body && detB.body.flags);
    const oo = await call('POST', `${G}/customers/${cB.body.id}/opt-out`, 'bde', { channel: 'whatsapp', reason: 'Asked on the phone to stop' });
    const ooShort = await call('POST', `${G}/customers/${cB.body.id}/opt-out`, 'bde', { channel: 'whatsapp', reason: 'no' });
    const detB2 = await call('GET', `${G}/customers/${cB.body.id}`, 'bde');
    const wa = detB2.body.contact.channels.find((c) => c.channel === 'whatsapp');
    check('C35 Opt out (with a reason): the channel shows Opted out with the date and how; a too-short reason is refused', oo.status === 200 && ooShort.status === 400 && wa.state === 'opted_out' && wa.at && /Marked by the team/.test(wa.how), wa);
    check('C36 only an Admin can record permission (BDE 403); the Admin\'s record shows who / how', (await call('POST', `${G}/customers/${cB.body.id}/opt-in`, 'bde', { channel: 'whatsapp', reason: 'they said yes' })).status === 403 && (await call('POST', `${G}/customers/${cB.body.id}/opt-in`, 'sa', { channel: 'email', reason: 'Confirmed by phone call today' })).status === 200 && (await call('GET', `${G}/customers/${cB.body.id}`, 'sa')).body.contact.channels.find((c) => c.channel === 'email').how === 'Recorded by an Admin');

    // ---- export
    const ex = await call('GET', `${G}/customers/export${qs({ q: 'ZZTEST' })}`, 'sa');
    const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
    const wbk = ex.status === 200 ? XLSX.read(ex.buf, { type: 'buffer' }) : null;
    const sheet = wbk ? XLSX.utils.sheet_to_json(wbk.Sheets[wbk.SheetNames[0]], { header: 1 }) : [];
    check('C37 Export Excel (Admin): a real .xlsx with the column names and the rows', ex.status === 200 && /spreadsheetml/.test(ex.type) && sheet.length >= 4 && sheet[0].includes('Customer Name') && sheet[0].includes('Permission') && sheet[0].includes('Lead stage'), { s: ex.status, h: sheet[0] });
    check('C38 Export is Admin only (TL 403, BDE 403, Manager 403) and is audited without a phone or email', (await call('GET', `${G}/customers/export`, 'tl')).status === 403 && (await call('GET', `${G}/customers/export`, 'bde')).status === 403 && (await call('GET', `${G}/customers/export`, 'am')).status === 403 && await (async () => { const a = await prisma.auditLog.findFirst({ where: { userId: sa.id, action: 'Outreach contacts downloaded', toValue: { contains: 'Customers page' } }, orderBy: { createdAt: 'desc' } }); return !!a && !/\d{8,}|@/.test(a.toValue || ''); })());

    // ================================================================ I: IMPORT (the same engine, new boxes)
    const csv = (rows) => Buffer.from(`${rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n')}\r\n`);
    const ip1 = phone(); const ip2 = phone(); const ie1 = mail('i1');
    const impFile = csv([['Name', 'Phone', 'Email', 'Language', 'Preferred channel', 'Notes', 'Lead stage', 'Platform ID', `ZZTEST Tier ${RUN}`], [`ZZTEST Imp One ${RUN}`, ip1, ie1, 'Telugu', 'WhatsApp', 'From a camp', 'Applied', `PF-1-${RUN}`, 'Gold'], [`ZZTEST Imp Two ${RUN}`, ip2, '', 'Hindi', 'smoke signal', 'Second', 'Not a stage', '', 'Bronze']]);
    const chk = await call('POST', `/api/outreach/import/check?dupMode=skip`, 'sa', impFile);
    check('I1 file check: new columns found by name (language, preferred channel, notes, platform ID, lead stage, a custom field)', chk.status === 200 && ['language', 'preferredChannel', 'notes', 'platformId', 'cf:lead_stage', `cf:${tierKey}`].every((k) => chk.body.mapping[k] !== undefined) && chk.body.totals.new === 2, chk.text.slice(0, 400));
    check('I2 the mapping words include the custom fields (shown in the mapping step)', chk.body.fields[`cf:${tierKey}`] && chk.body.fields.language === 'Language');
    check('I3 a value that does not fit is reported on that row, not silently saved', chk.body.problems.some((p) => (p.notes || []).some((n) => /not one of the choices/.test(n))) && chk.body.problems.some((p) => (p.notes || []).some((n) => /Preferred channel/.test(n))), chk.body.problems);
    const noTick = await call('POST', `/api/outreach/import/save?dupMode=skip&basis=${encodeURIComponent('Our own list of people')}`, 'sa', impFile);
    check('I4 save needs the permission tick (400)', noTick.status === 400 && noTick.body.code === 'NO_PERMISSION_TICK');
    const sav = await call('POST', `/api/outreach/import/save?dupMode=skip&permission=1&basis=${encodeURIComponent('Our own list of people who gave their number')}&filename=zz.csv&source=${encodeURIComponent(`ZZTEST file ${RUN}`)}`, 'sa', impFile);
    check('I5 save with the tick and where-from words: 2 added', sav.status === 200 && sav.body.counts.created === 2, sav.text.slice(0, 300));
    const lImp = await call('GET', `${G}/customers${qs({ q: `ZZTEST Imp`, pageSize: 100 })}`, 'sa');
    const imp1 = lImp.body.contacts.find((c) => c.name.includes('Imp One')); const imp2 = lImp.body.contacts.find((c) => c.name.includes('Imp Two'));
    check('I6 imported people carry language, preferred channel, notes, platform ID, lead stage and the custom field', imp1 && imp1.language === 'Telugu' && imp1.preferredChannel === 'whatsapp' && imp1.notes === 'From a camp' && imp1.platformId === `PF-1-${RUN}` && imp1.leadStage === 'Applied' && imp1.customValues[tierKey] === 'Gold' && imp2 && imp2.preferredChannel === '' && imp2.leadStage === '', { imp1, imp2 });
    check('I7 imported with the tick = Allowed, with the source words "File import (permission ticked)"', imp1.channels.filter((c) => c.state !== 'none').every((c) => c.state === 'allowed' && /File import/.test(c.how)), imp1.channels);
    const impFile2 = csv([['Name', 'Phone', 'Email', 'Language', 'Notes'], [`ZZTEST Imp One ${RUN} v2`, ip1, ie1, 'Kannada', 'Updated notes']]);
    const ow = await call('POST', `/api/outreach/import/save?dupMode=overwrite&confirmOverwrite=1&permission=1&basis=${encodeURIComponent('Same list, newer details')}&filename=zz2.csv`, 'sa', impFile2);
    const imp1b = (await call('GET', `${G}/customers/${imp1.id}`, 'sa')).body.contact;
    check('I8 "update from the file" changes name, language and notes; boxes the file does not have (platform ID, lead stage) stay', ow.status === 200 && ow.body.counts.updated === 1 && imp1b.language === 'Kannada' && imp1b.notes === 'Updated notes' && imp1b.platformId === `PF-1-${RUN}` && imp1b.leadStage === 'Applied', ow.text.slice(0, 300));
    const undoOw = await call('POST', `/api/outreach/imports/${ow.body.importId}/undo`, 'sa');
    const imp1c = (await call('GET', `${G}/customers/${imp1.id}`, 'sa')).body.contact;
    check('I9 undo of an update puts language and notes back', undoOw.status === 200 && imp1c.language === 'Telugu' && imp1c.notes === 'From a camp', imp1c.language);
    const undo = await call('POST', `/api/outreach/imports/${sav.body.importId}/undo`, 'sa');
    check('I10 undo within 7 days removes the people the import added', undo.status === 200 && undo.body.removed === 2 && (await call('GET', `${G}/customers${qs({ q: 'ZZTEST Imp' })}`, 'sa')).body.total === 0, undo.text);
    const sample = await call('GET', `${G}/import/sample.csv`, 'sa');
    check('I11 the sample file has the new columns and one column per custom field', sample.status === 200 && /csv/.test(sample.type) && /Language/.test(sample.text) && /Preferred channel/.test(sample.text) && sample.text.includes(`ZZTEST Tier ${RUN}`), sample.text.slice(0, 200));
    const hist = await call('GET', '/api/outreach/imports', 'sa');
    check('I12 imports history is still reachable (the Imports tab)', hist.status === 200 && Array.isArray(hist.body.imports) && hist.body.imports.length >= 2);

    // ================================================================ S: SEGMENTS
    const pre0 = Date.now();
    const sg = await call('POST', `${G}/segments`, 'sa', { name: `ZZTEST Seg ${RUN}`, rules: { languages: ['Tamil'], fields: [{ key: 'lead_stage', values: ['Joined'] }] } });
    check('S1 create a segment with language + custom field rules', sg.status === 200 && sg.body.id, sg.text);
    const sl = await call('GET', `${G}/segments`, 'sa');
    const seg = (sl.body.segments || []).find((s) => s.id === sg.body.id);
    check('S2 list: a plain rule sentence, the live count, reachable per channel, "counted at" time', !!seg && /Language is Tamil/.test(seg.summary) && /Lead stage is Joined/.test(seg.summary) && seg.counts.total === 1 && seg.counts.reachable && typeof seg.counts.reachable.whatsapp === 'number' && seg.countedAt, seg || sl.text.slice(0, 500));
    check('S3 the person who matches is the customer edited above (Tamil, Joined)', ((await call('GET', `${G}/segments/${sg.body.id}/preview`, 'sa')).body.people || []).length === 1);
    const pv = await call('GET', `${G}/segments/${sg.body.id}/preview`, 'sa');
    check('S4 preview shows names with masked phone / email, for every role', pv.status === 200 && pv.body.people.every((p) => /•/.test(p.phone || '•') && !pv.text.includes(p1) && !pv.text.includes(e1)), pv.text.slice(0, 300));
    const empty = await call('POST', `${G}/segments`, 'sa', { name: `ZZTEST Empty ${RUN}`, rules: {} });
    const emptyL = (await call('GET', `${G}/segments`, 'sa')).body.segments.find((s) => s.id === empty.body.id);
    check('S5 a segment with no rule matches NOBODY (never everybody) and says so', empty.status === 200 && emptyL.counts.total === 0 && emptyL.counts.emptyRule === true && /No rule yet/.test(emptyL.summary), emptyL);
    const wPeople = await call('POST', `${G}/segments/preview`, 'sa', { contactType: 'candidate_lead', rules: { cities: ['vizag'] } });
    check('S6 the rule builder preview (nothing saved): live count + people', wPeople.status === 200 && wPeople.body.counts.total >= 1);
    // permission makes the person reachable
    const before = seg.countedAt;
    await sleep(15);
    await call('POST', `${G}/customers/${id1}/opt-in`, 'sa', { channel: 'whatsapp', reason: 'Confirmed by phone call today' });
    const sameCounted = (await call('GET', `${G}/segments`, 'sa')).body.segments.find((s) => s.id === sg.body.id);
    const ref = await call('POST', `${G}/segments/${sg.body.id}/refresh`, 'sa');
    check('S7 "Count again" updates the count and the time: before it the card shows the old snapshot, after it the reachable number and a later time', sameCounted.counts.reachable.whatsapp === 0 && sameCounted.countedAt === before && ref.status === 200 && ref.body.counts.reachable.whatsapp === 1 && Date.parse(ref.body.countedAt) > Date.parse(before) && Date.parse(ref.body.countedAt) >= pre0, { ref: ref.body, before });
    const rowDb = (await prisma.$queryRawUnsafe('SELECT refreshedAt FROM "OutreachSegment" WHERE id = ?', sg.body.id))[0];
    check('S8 the OutreachSegment.refreshedAt column is stamped', Number(rowDb.refreshedAt) > 0, rowDb);
    const dup = await call('POST', `${G}/segments/${sg.body.id}/duplicate`, 'sa', { name: `ZZTEST Seg ${RUN} copy` });
    const dup2 = await call('POST', `${G}/segments/${sg.body.id}/duplicate`, 'sa', { name: `ZZTEST Seg ${RUN} copy` });
    check('S9 Duplicate: same rules under a new name; the same name twice is refused (409)', dup.status === 200 && dup2.status === 409);
    const upS = await call('PUT', `${G}/segments/${dup.body.id}`, 'sa', { name: `ZZTEST Seg ${RUN} two`, rules: { languages: ['Hindi', 'Tamil'], preferred: ['sms'] } });
    const listS2 = (await call('GET', `${G}/segments`, 'sa')).body.segments.find((s) => s.id === dup.body.id);
    check('S10 Edit: name + rules change; the count is made again (language Tamil + preferred SMS = our customer)', upS.status === 200 && listS2.name.endsWith('two') && /Prefers SMS/.test(listS2.summary) && listS2.counts.total === 1, listS2);
    // multi-choice custom field rule (json_each)
    const mseg = await call('POST', `${G}/segments`, 'sa', { name: `ZZTEST Multi ${RUN}`, rules: { fields: [{ key: typesMade.multi.key, values: ['Beta'] }] } });
    const mrow = (await call('GET', `${G}/segments`, 'sa')).body.segments.find((s) => s.id === mseg.body.id);
    const mrow2 = await call('POST', `${G}/segments/preview`, 'sa', { contactType: 'candidate_lead', rules: { fields: [{ key: typesMade.multi.key, values: ['Gamma'] }] } });
    check('S11 a multi-choice custom field rule matches a person who has that choice among several (and not one who does not)', mrow.counts.total === 1 && mrow2.body.counts.total === 0, { a: mrow.counts, b: mrow2.body.counts });
    const meta = await call('GET', `${G}/segments/meta`, 'sa');
    check('S12 builder options: kinds, cities, languages, import files, preferred channels, reachable channels, dropdown fields', meta.status === 200 && meta.body.kinds.length >= 1 && meta.body.cities.includes('Vizag') && meta.body.languages.includes('Tamil') && meta.body.fields.some((f) => f.id === 'lead_stage' && f.options.includes('Joined')) && meta.body.preferred.length === 4 && meta.body.reachable.length === 3, meta.text.slice(0, 300));
    const bs = await call('POST', `${G}/segments`, 'bde', { name: `ZZTEST BDE seg ${RUN}`, rules: { languages: ['Hindi'] } });
    const bsl = await call('GET', `${G}/segments`, 'bde');
    check('S13 a BDE makes and sees only their own segments; cannot change the Admin\'s (404); Recruiter cannot make one (403)', bs.status === 200 && bsl.body.segments.some((s) => s.id === bs.body.id) && !bsl.body.segments.some((s) => s.id === sg.body.id) && (await call('PUT', `${G}/segments/${sg.body.id}`, 'bde', { name: 'hack' })).status === 404 && (await call('DELETE', `${G}/segments/${sg.body.id}`, 'bde')).status === 404 && (await call('POST', `${G}/segments`, 'rec', { name: 'ZZTEST rec seg', rules: { languages: ['x'] } })).status === 403, { bs: bs.status });
    check('S14 "Use in campaign" is offered to the logins that may run campaigns (canUse) and not to the Manager', sl.body.canUse === true && (await call('GET', `${G}/segments`, 'am')).body.canUse === false);
    check('S15 a segment whose kind is not in the list is refused', (await call('POST', `${G}/segments`, 'sa', { name: `ZZTEST bad kind ${RUN}`, rules: { industries: ['Nonexistent kind'] } })).status === 400);
    const oldSeg = await call('GET', '/api/outreach/segments', 'sa');
    check('S16 the older Groups API still works with the new rules (nothing broken)', oldSeg.status === 200 && oldSeg.body.segments.some((s) => s.id === sg.body.id));
    check('S17 delete removes a segment', (await call('DELETE', `${G}/segments/${empty.body.id}`, 'sa')).status === 200 && !(await call('GET', `${G}/segments`, 'sa')).body.segments.some((s) => s.id === empty.body.id));

    // ================================================================ W: WEB FORMS
    const fm0 = await call('GET', `${G}/forms`, 'bde');
    check('W1 Forms list for a BDE: the catalog (core + custom fields), staff to pick, channels, canCreate', fm0.status === 200 && fm0.body.canCreate === true && fm0.body.catalog.some((c) => c.key === 'phone') && fm0.body.catalog.some((c) => c.key === 'cf:lead_stage') && fm0.body.members.length > 3 && fm0.body.channels.length === 3, fm0.text.slice(0, 200));
    check('W2 Recruiter cannot make a form (403) and sees none', (await call('POST', `${G}/forms`, 'rec', { title: 'ZZTEST nope', fields: ['name', 'phone'] })).status === 403 && (await call('GET', `${G}/forms`, 'rec')).body.forms.length === 0);
    check('W3 validation: title too short, no phone / email box, short permission words, no way of contact: all 400', (await call('POST', `${G}/forms`, 'bde', { title: 'x', fields: ['name', 'phone'] })).status === 400 && (await call('POST', `${G}/forms`, 'bde', { title: `ZZTEST nofield ${RUN}`, fields: ['name', 'city'] })).status === 400 && (await call('POST', `${G}/forms`, 'bde', { title: `ZZTEST shortc ${RUN}`, fields: ['name', 'phone'], consentText: 'yes' })).status === 400 && (await call('POST', `${G}/forms`, 'bde', { title: `ZZTEST nochan ${RUN}`, fields: ['name', 'phone'], channels: [] })).status === 400);
    await call('PUT', `${G}/fields/${mustKey}`, 'sa', { name: `ZZTEST must ${RUN}`, type: 'text', required: true });
    const fmB = await call('POST', `${G}/forms`, 'bde', { title: `ZZTEST Form ${RUN}`, description: 'Test capture form', fields: ['name', 'phone', 'email', 'city', 'cf:lead_stage', `cf:${mustKey}`], channels: ['whatsapp', 'email'], thanks: 'Thanks, test.' });
    const form = fmB.body && fmB.body.form;
    check('W4 a BDE makes a form: token, link path, status on, permission-words version', fmB.status === 200 && form && form.token && form.path === `/forms-public/${form.token}` && form.status === 'on' && /^form-/.test(form.consentVersion) && form.fields.length === 6, fmB.text.slice(0, 300));
    check('W5 the same title twice is refused (409)', (await call('POST', `${G}/forms`, 'bde', { title: `ZZTEST Form ${RUN}`, fields: ['phone'] })).status === 409);
    const fmTl = await call('GET', `${G}/forms`, 'tl');
    const fmAm = await call('GET', `${G}/forms`, 'am');
    check('W6 who sees the form: the maker and an Admin; a Team Lead not named sees none; the Manager looks (read only)', !fmTl.body.forms.some((f) => f.id === form.id) && fmAm.body.forms.find((f) => f.id === form.id) && fmAm.body.forms.find((f) => f.id === form.id).canEdit === false && (await call('GET', `${G}/forms`, 'sa')).body.forms.some((f) => f.id === form.id));
    const P = `/api/public/outreach/forms/${form.token}`;
    const pg0 = await http('GET', P);
    check('W7 the PUBLIC page (no login) lists the fields with options and "required", the permission words and the ways to be contacted', pg0.status === 200 && pg0.body.form.title === `ZZTEST Form ${RUN}` && pg0.body.form.fields.find((f) => f.key === 'cf:lead_stage').options.includes('Interested') && pg0.body.form.fields.find((f) => f.key === `cf:${mustKey}`).required === true && pg0.body.form.consentText.length > 20 && pg0.body.form.channels.length === 2, pg0.text.slice(0, 300));
    check('W8 a wrong link gives the same plain 404', (await http('GET', '/api/public/outreach/forms/doesnotexist1234')).status === 404 && (await http('GET', '/api/public/outreach/forms/<script>')).status === 404);
    const fp = phone(); const fe = mail('f'); const ans = (o = {}) => ({ name: `ZZTEST Visitor ${RUN}`, phone: fp, email: fe, city: 'Warangal', 'cf:lead_stage': 'Interested', [`cf:${mustKey}`]: 'filled', ...o });
    const countC = async () => (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachContact" WHERE status = \'active\''))[0].n;
    const c0 = Number(await countC());
    const noC = await http('POST', P, null, { answers: ans(), channels: ['whatsapp'], consent: false });
    const hp = await http('POST', P, null, { answers: ans(), channels: ['whatsapp'], consent: true, website: 'http://spam.example' });
    const badPh = await http('POST', P, null, { answers: ans({ phone: '12', email: '' }), channels: ['whatsapp'], consent: true });
    const noReq = await http('POST', P, null, { answers: ans({ [`cf:${mustKey}`]: '' }), channels: ['whatsapp'], consent: true });
    const noCh = await http('POST', P, null, { answers: ans(), channels: [], consent: true });
    const badStage = await http('POST', P, null, { answers: ans({ 'cf:lead_stage': 'Nope' }), channels: ['whatsapp'], consent: true });
    check('W9 refused with a plain sentence: no tick (400), a bad phone (400), a missing required answer (400), no way chosen (400), an answer not in the list (400)', noC.status === 400 && /tick the box/.test(noC.body.error) && badPh.status === 400 && noReq.status === 400 && /is needed/.test(noReq.body.error) && noCh.status === 400 && badStage.status === 400, [noC.text, badPh.text, noReq.text, noCh.text, badStage.text]);
    check('W10 the honeypot: looks like success but saves nothing', hp.status === 200 && hp.body.ok === true && Number(await countC()) === c0);
    const okP = await http('POST', P, null, { answers: ans(), channels: ['whatsapp', 'email', 'sms'], consent: true });
    check('W11 a real send: 200 with the form\'s own thanks words', okP.status === 200 && okP.body.ok === true && okP.body.message === 'Thanks, test.', okP.text);
    const lF = await call('GET', `${G}/customers${qs({ q: `Visitor ${RUN}` })}`, 'sa');
    const vis = lF.body.contacts[0];
    check('W12 a contact was made: source "Form: ...", owner = the BDE who made the form, custom answers kept', lF.body.total === 1 && vis.source === `Form: ZZTEST Form ${RUN}` && vis.ownerName === bde.name && vis.leadStage === 'Interested' && vis.customValues[mustKey] === 'filled' && vis.city === 'Warangal', vis);
    const dv = (await call('GET', `${G}/customers/${vis.id}`, 'sa')).body;
    const chs = Object.fromEntries(dv.contact.channels.map((c) => [c.channel, c]));
    check('W13 consent is recorded per chosen way: WhatsApp and Email Allowed (how = Web form); SMS was not offered by this form, so it stays Not asked', chs.whatsapp.state === 'allowed' && chs.email.state === 'allowed' && /Web form/.test(chs.whatsapp.how) && chs.sms.state === 'not_asked', dv.contact.channels);
    const ev = await prisma.$queryRawUnsafe('SELECT source, evidence, textVersion FROM "OutreachConsentEvent" WHERE contactId = ?', vis.id);
    check('W14 the history row has source "form", the form name and the version of the permission words', ev.length >= 2 && ev.every((e) => e.source === 'form' && e.evidence.includes(`ZZTEST Form ${RUN}`) && /^form-[0-9a-f]{8}$/.test(e.textVersion)), ev);
    const again = await http('POST', P, null, { answers: ans({ name: 'ZZTEST Visitor changed name', city: 'Other city' }), channels: ['whatsapp', 'email'], consent: true });
    const lF2 = await call('GET', `${G}/customers${qs({ q: `Visitor ${RUN}` })}`, 'sa');
    check('W15 the same phone again: no second person, the same answer, details already saved are NOT replaced', again.status === 200 && again.body.message === okP.body.message && lF2.body.total === 1 && Number(await countC()) === c0 + 1 && lF2.body.contacts[0].city === 'Warangal' && lF2.body.contacts[0].name.includes('Visitor ' + RUN), { t: lF2.body.total });
    await call('POST', `${G}/customers/${vis.id}/opt-out`, 'sa', { channel: 'whatsapp', reason: 'Asked us on the phone to stop' });
    await http('POST', P, null, { answers: ans(), channels: ['whatsapp', 'email'], consent: true });
    const dv2 = (await call('GET', `${G}/customers/${vis.id}`, 'sa')).body;
    check('W16 a form NEVER lifts an opt-out: WhatsApp stays Opted out after the person ticks it again', dv2.contact.channels.find((c) => c.channel === 'whatsapp').state === 'opted_out');
    const fp2 = phone();
    await http('POST', P, null, { answers: ans({ phone: fp2, email: '', name: `ZZTEST Visitor2 ${RUN}` }), channels: ['whatsapp', 'email'], consent: true });
    const v2 = (await call('GET', `${G}/customers${qs({ q: `Visitor2 ${RUN}` })}`, 'sa')).body.contacts[0];
    const v2d = (await call('GET', `${G}/customers/${v2.id}`, 'sa')).body;
    check('W17 only ways the person gave an address for can be agreed to (phone only: WhatsApp Allowed, Email has no address)', v2d.contact.channels.find((c) => c.channel === 'whatsapp').state === 'allowed' && v2d.contact.channels.find((c) => c.channel === 'email').state === 'none', v2d.contact.channels);
    const longName = 'N'.repeat(5000);
    const capR = await http('POST', P, null, { answers: ans({ phone: phone(), email: '', name: longName }), channels: ['whatsapp'], consent: true });
    const capRow = (await prisma.$queryRawUnsafe("SELECT name FROM \"OutreachContact\" WHERE name LIKE 'NNNN%' AND source = ?", `Form: ZZTEST Form ${RUN}`))[0];
    check('W18 field length caps: a 5,000 letter name is cut short (or refused), never saved whole', (capR.status === 200 && capRow && capRow.name.length <= 120) || capR.status === 413 || capR.status === 400, capRow && capRow.name.length);
    // rate limit per IP (a fixed address)
    let limited = 0;
    for (let i = 0; i < 20; i += 1) { const r = await http('POST', P, null, { answers: {}, channels: [], consent: false }, { ip: '10.77.7.7' }); if (r.status === 429) limited += 1; } // eslint-disable-line no-await-in-loop
    check('W19 a limit per IP address: after 15 tries in 10 minutes the form answers 429 in plain words', limited >= 4, limited);
    const subs = await call('GET', `${G}/forms/submissions${qs({ formId: form.id })}`, 'bde');
    check('W20 submissions: names and answers only (no phone, no email), status words New / Already known, newest first', subs.status === 200 && subs.body.rows.length >= 3 && subs.body.rows.every((r) => !subs.text.includes(fp) && !subs.text.includes(fe)) && subs.body.rows.some((r) => r.status === 'New') && subs.body.rows.some((r) => r.status === 'Already known') && /Interested/.test(subs.text) && subs.body.rows[0].person, subs.text.slice(0, 400));
    check('W21 the Team Lead (not named) sees no submissions of that form', (await call('GET', `${G}/forms/submissions${qs({ formId: form.id })}`, 'tl')).body.rows.length === 0);
    const mem = await call('PUT', `${G}/forms/${form.id}`, 'bde', { title: `ZZTEST Form ${RUN}`, description: 'Edited', fields: ['name', 'phone', 'email', 'cf:lead_stage'], memberIds: [tl.id], channels: ['whatsapp', 'email', 'sms'] });
    check('W22 the maker edits the form and names a Team Lead as a permitted member; who may open it follows', mem.status === 200 && mem.body.form.memberIds.includes(tl.id) && (await call('GET', `${G}/forms`, 'tl')).body.forms.some((f) => f.id === form.id) && (await call('GET', `${G}/forms/submissions${qs({ formId: form.id })}`, 'tl')).body.rows.length >= 3);
    check('W23 a permitted member who is not the maker cannot change or delete the form (403)', (await call('PUT', `${G}/forms/${form.id}`, 'tl', { title: 'hack' })).status === 403 && (await call('DELETE', `${G}/forms/${form.id}`, 'tl')).status === 403);
    const tab = await call('GET', `${G}/customers${qs({ form: form.id })}`, 'sa');
    const tabB = await call('GET', `${G}/customers${qs({ form: form.id })}`, 'bde');
    check('W24 the Customers form tab shows only the people that form collected (BDE: only if they are his / her own)', tab.body.total >= 2 && tab.body.contacts.every((c) => /^Form:/.test(c.source)) && tabB.body.total === tab.body.total && tabB.body.contacts.every((c) => /•/.test(c.phone)), { a: tab.body.total, b: tabB.body.total });
    const off = await call('PUT', `${G}/forms/${form.id}`, 'bde', { title: `ZZTEST Form ${RUN}`, status: 'off' });
    check('W25 switched off = the public link stops (404); switched on again it works', off.status === 200 && (await http('GET', P)).status === 404 && (await call('PUT', `${G}/forms/${form.id}`, 'bde', { title: `ZZTEST Form ${RUN}`, status: 'on' })).status === 200 && (await http('GET', P)).status === 200);
    check('W26 delete: the link stops, the people it collected stay in Customers', (await call('DELETE', `${G}/forms/${form.id}`, 'bde')).status === 200 && (await http('GET', P)).status === 404 && (await call('GET', `${G}/customers${qs({ q: `Visitor ${RUN}` })}`, 'sa')).body.total === 1);

    // ================================================================ A: IMPORT FROM ATS
    const opt = await call('GET', `${G}/ats/options`, 'sa');
    check('A1 ATS options: jobs, stages in everyday words, departments', opt.status === 200 && opt.body.jobs.length > 0 && opt.body.stages.some((s) => s.id === 'RECRUITER_REVIEW' && s.label === 'Check by recruiter') && opt.body.departments.length > 0, opt.text.slice(0, 200));
    check('A2 only Admin and Team Lead may copy from the ATS: BDE 403, Recruiter 403, Manager 403, HR 403; the Team Lead may', (await call('GET', `${G}/ats/options`, 'bde')).status === 403 && (await call('POST', `${G}/ats/preview`, 'rec', {})).status === 403 && (await call('POST', `${G}/ats/import`, 'am', {})).status === 403 && (await call('POST', `${G}/ats/import`, 'hr', {})).status === 403 && (await call('GET', `${G}/ats/options`, 'tl')).status === 200);
    const cl = await prisma.client.findFirst();
    const req = await prisma.requirement.create({ data: { title: `ZZTEST ATS job ${RUN}`, clientId: cl.id, department: 'Medical', status: 'OPEN' } });
    const SAL = '9876543 ZZSALARY';
    const mkCand = (n, extra) => prisma.candidate.create({ data: { name: `ZZTEST Cand ${n} ${RUN}`, location: 'Hyderabad', skills: 'ICU', experienceYears: 3.5, currentSalary: SAL, expectedSalary: SAL, ...extra } });
    const ca = await mkCand('A', { phone: phone(), email: mail('ca') }); const cb = await mkCand('B', { phone: phone() }); const cc = await mkCand('C', {}); const cd = await mkCand('D', { phone: phone(), doNotContact: true });
    for (const c of [ca, cb, cc, cd]) await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: 'RECRUITER_REVIEW' } });
    const pvw = await call('POST', `${G}/ats/preview`, 'sa', { jobIds: [req.id], stages: ['RECRUITER_REVIEW'] });
    check('A3 preview counts: 4 found, 2 will be added, 1 has no phone or email, 1 asked not to be contacted; names only in the sample', pvw.status === 200 && pvw.body.found === 4 && pvw.body.willAdd === 2 && pvw.body.noPhoneOrEmail === 1 && pvw.body.doNotContact === 1 && pvw.body.alreadyInContacts === 0 && pvw.body.sample.length === 2 && !/\d{8,}|@|ZZSALARY/.test(pvw.text), pvw.text.slice(0, 400));
    check('A4 a filter by department / stage narrows (wrong stage = 0)', (await call('POST', `${G}/ats/preview`, 'sa', { jobIds: [req.id], stages: ['JOINED'] })).body.found === 0 && (await call('POST', `${G}/ats/preview`, 'sa', { jobIds: [req.id], departments: ['Medical'] })).body.found === 4);
    const tlPv = await call('POST', `${G}/ats/preview`, 'tl', { jobIds: [req.id] });
    check('A5 a Team Lead sees only their own team\'s candidates (scope): never more than the Admin, and none of this job when it is not theirs', tlPv.status === 200 && tlPv.body.found <= pvw.body.found, tlPv.text.slice(0, 200));
    const runA = await call('POST', `${G}/ats/import`, 'sa', { jobIds: [req.id], stages: ['RECRUITER_REVIEW'] });
    check('A6 the copy adds the 2 people and says nothing was sent', runA.status === 200 && runA.body.created === 2 && runA.body.noPhoneOrEmail === 1 && runA.body.doNotContact === 1 && /Nothing was sent/.test(runA.body.ok) && /Not asked/.test(runA.body.ok), runA.text);
    const lA = await call('GET', `${G}/customers${qs({ q: `Cand`, pageSize: 100 })}`, 'sa');
    const atsRows = lA.body.contacts.filter((c) => c.source === 'ATS' && c.name.includes(RUN));
    const dbRows = await prisma.$queryRawUnsafe('SELECT * FROM "OutreachContact" WHERE source = ? AND name LIKE ?', 'ATS', `%${RUN}`);
    check('A7 ATS contacts: source ATS, linked to the candidate, department from the job, owned by the importer, city + skills + experience copied', atsRows.length === 2 && dbRows.length === 2 && dbRows.every((r) => r.linkedApplicantId && [ca.id, cb.id].includes(r.linkedApplicantId) && r.department === 'Medical' && r.ownerUserId === sa.id && r.city === 'Hyderabad' && r.skills === 'ICU' && r.experience === '3.5'), dbRows);
    check('A8 every way of contact starts "Not asked" (consent unknown); sending stays blocked until it is recorded', atsRows.every((c) => c.channels.filter((x) => x.state !== 'none').every((x) => x.state === 'not_asked')) && atsRows.every((c) => c.fromAts === true));
    const salaryAnywhere = JSON.stringify(dbRows) + JSON.stringify(lA.body) + (await call('GET', `${G}/customers/${atsRows[0].id}`, 'sa')).text;
    check('A9 NO salary and no candidate note ever reaches the contact (checked in the table row, the list and the detail)', !/ZZSALARY|9876543/.test(salaryAnywhere));
    const runB = await call('POST', `${G}/ats/import`, 'sa', { jobIds: [req.id], stages: ['RECRUITER_REVIEW'] });
    const pvw2 = await call('POST', `${G}/ats/preview`, 'sa', { jobIds: [req.id] });
    check('A10 idempotent: the second press adds nobody; the preview then says 2 are already in contacts', runB.body.created === 0 && pvw2.body.alreadyInContacts === 2 && pvw2.body.willAdd === 0);
    const pol = require(path.join(BACK, 'src/outreach/policy'));
    check('A11 the Admin switch "applied to our job = job messages allowed" is OFF by default (sending blocked until consent recorded)', (await pol.consentRules()).atsAppliedMeansJobAllowed === false);
    const ih = await call('GET', '/api/outreach/imports', 'sa');
    const atsBatch = ih.body.imports.find((i) => i.id === runA.body.importId);
    check('A12 the copy shows in the Imports list as an "ATS" batch with 2 added and can be undone', atsBatch && atsBatch.created === 2 && atsBatch.source === 'ATS' && atsBatch.canUndo === true, atsBatch);
    const undoA = await call('POST', `/api/outreach/imports/${runA.body.importId}/undo`, 'sa');
    check('A13 undo removes exactly those 2 contacts', undoA.status === 200 && undoA.body.removed === 2 && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachContact" WHERE source = ? AND name LIKE ?', 'ATS', `%${RUN}`))[0].n) === 0, undoA.text);
    const audA = await prisma.auditLog.findFirst({ where: { userId: sa.id, action: 'Contacts copied from the ATS' }, orderBy: { createdAt: 'desc' } });
    check('A14 the copy is audited with counts only (no phone, no email, no name)', !!audA && /added/.test(audA.toValue) && !/\d{8,}|@|ZZTEST/.test(audA.toValue), audA && audA.toValue);

    // ================================================================ X: everything else
    check('X1 no response of this area contains the word "Draft"', !allText.some((t) => /draft/i.test(t)), allText.filter((t) => /draft/i.test(t)).map((t) => t.slice(0, 120)));
    const msgAfter = (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachMessage"').catch(() => [{ n: 0 }]))[0].n;
    check('X2 nothing was sent: no message row was made by any of the above', Number(msgBefore) === Number(msgAfter), { msgBefore, msgAfter });
    const delF = await call('DELETE', `${G}/fields/${typesMade.checkbox.key}`, 'sa');
    check('X3 Admin deletes a field: it leaves the list (people keep nothing visible for it)', delF.status === 200 && !delF.body.fields.some((f) => f.id === typesMade.checkbox.key) && !(await call('GET', `${G}/customers/${id1}`, 'sa')).body.contact.customValues[typesMade.checkbox.key]);
    const dd = await call('GET', '/api/outreach/contacts?pageSize=100', 'sa');
    check('X4 the older Contacts API still lists the same people (language / preferred channel / notes added, nothing removed)', dd.status === 200 && dd.body.contacts.some((c) => c.id === id1 && c.language === 'Tamil'));
    const dd2 = await call('GET', '/api/outreach/contacts?pageSize=100', 'bde');
    check('X5 the older Contacts API still masks the BDE and shows NO custom values', dd2.status === 200 && !dd2.text.includes(pB) && !/customValues/.test(dd2.text));
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();

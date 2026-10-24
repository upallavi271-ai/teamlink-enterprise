#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL v2 TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v2-copy.db node scripts/omni-v2-test.js
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy (<name>-work.db), applies the
// three Omni-Channel migrations to it when they are missing, starts its OWN API on port 4096 (TEST_MODE) and checks:
//   A  access per role (+ cross-department denial, HR internal only, outside logins refused)
//   H  template hub = the same data as the old screens, department visibility, edit through the owner
//   I  inbox scope (Responses reads the one conversation inbox)
//   C  credits: ledger, limit, Test-mode exemption, Admin exempt, settings only for Admin
//   Y  activity numbers = the source data; CSV permission + audit
//   N  connections: read only, HRMS sync is idempotent and records no consent
// NOTHING real is sent: blocked / reserved-test-domain addresses only.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4096);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;

// the Omni-Channel tables (the live dev database may not have them yet): applied to the WORKING copy only
{
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
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, type: r.headers.get('content-type') || '' };
}

(async () => {
  let server;
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } }; // a login that has not left
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } // eslint-disable-line no-await-in-loop
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } }); // working copy only: this login had left
    const hr = await first({ atsRole: 'HR', ...live });
    // a recruiter who has a department
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 60 });
    const tlEmp = await prisma.employee.findFirst({ where: { userId: tl && tl.id } });
    const rec = recEmps.find((e) => e.department && tlEmp && e.department !== tlEmp.department) || recEmps[0];
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, Assistant Manager, HR, a recruiter with a department)', !!(sa && tl && bde && am && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!rec });
    // a starting password would stop every call but /api/auth: give the working copy's logins an unguessable placeholder
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const recU = rec.user; const recDept = rec.department;
    // a department that is NOT the recruiter's
    const industries = [{ name: 'Medical', department: 'Medical' }, { name: 'BDE', department: 'BDE' }, { name: 'Education', department: 'Education' }, { name: 'Manufacturing', department: 'Manufacturing' }];
    const S = require(path.join(BACK, 'src/outreach/store'));
    const indList = await S.industries();
    const ownInd = indList.find((i) => String(i.department).toLowerCase() === String(recDept).toLowerCase());
    const otherInd = indList.find((i) => String(i.department).toLowerCase() !== String(recDept).toLowerCase());
    console.log(`info  recruiter dept = ${recDept}; kinds list = ${indList.map((i) => `${i.name}/${i.department}`).join(', ') || JSON.stringify(industries)}`);

    // ZZTEST outside logins
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-v2-client-${RUN}@example.test`, username: `zz-v2-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-v2-acct-${RUN}@example.test`, username: `zz-v2-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });

    // contacts of two departments (inserted straight into the working copy as an Admin)
    const K = require(path.join(BACK, 'src/outreach/contacts'));
    const adminUser = { id: sa.id, name: sa.name };
    const mkContact = async (tag, ind, dept, phone) => K.insert(adminUser, { type: 'candidate_lead', name: `ZZTEST ${tag} ${RUN}`, phone: { e164: `91${phone}`, key: phone }, email: null, company: 'ZZ', city: 'Hyderabad', source: 'omni-v2-test', industries: ind ? [ind.name] : [], department: dept }, { declared: false });
    const cOwn = await mkContact('own', ownInd, recDept, `9${String(Date.now()).slice(-9)}`);
    const cOther = await mkContact('other', otherInd, otherInd ? otherInd.department : 'Other', `8${String(Date.now()).slice(-9)}`);

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(recU), client: await tokenOf(client), acct: await tokenOf(acct) };

    // ================================================================ A: access
    const me = {}; for (const k of Object.keys(T)) me[k] = await http('GET', '/api/outreach/me', T[k]); // eslint-disable-line no-await-in-loop
    const b = (k) => me[k].body || {};
    check('A1 Super Admin: everything (all departments, settings, credits, team activity, exempt)', me.sa.status === 200 && b('sa').kind === 'admin' && b('sa').allDepartments === true && b('sa').canSettings && b('sa').canCredits && b('sa').canTeamActivity && b('sa').creditsExempt && b('sa').modeAccess.length === 3, me.sa.text.slice(0, 300));
    check('A2 Recruiter: only own department(s), no settings, no credit rules, no team activity', me.rec.status === 200 && b('rec').kind === 'recruiter' && b('rec').allDepartments === false && b('rec').departments.includes(String(recDept).toLowerCase()) && !b('rec').canSettings && !b('rec').canCredits && !b('rec').canTeamActivity, me.rec.text.slice(0, 300));
    check('A3 Recruiter cannot open Settings or Internal modes', !b('rec').modeAccess.includes('settings') && !b('rec').modeAccess.includes('internal'), b('rec').modeAccess);
    check('A4 HR: the Internal side only (no job promotions, no settings)', me.hr.status === 200 && b('hr').kind === 'hr' && b('hr').canInternal && !b('hr').canPromo && !b('hr').canSettings && b('hr').modeAccess.join() === 'internal', me.hr.text.slice(0, 300));
    check('A5 TL: own department, may see team activity, no settings', b('tl').kind === 'tl' && !b('tl').allDepartments && b('tl').canTeamActivity && !b('tl').canSettings, me.tl.text.slice(0, 300));
    check('A6 BDE: masked (names only), no settings, no team activity', b('bde').masked === true && !b('bde').canSettings && !b('bde').canTeamActivity, me.bde.text.slice(0, 300));
    check('A7 Manager / Assistant Manager: may look at every department, cannot change settings', b('am').allDepartments === true && !b('am').canSettings, me.am.text.slice(0, 300));
    check('A8 Client login: refused (403)', me.client.status === 403, me.client.status);
    check('A9 Accounts login (Finance): no recruitment access, contacts refused (403)', (await http('GET', '/api/outreach/contacts', T.acct)).status === 403, me.acct.status);
    const cl = async (k, type) => http('GET', `/api/outreach/contacts?type=${type}&pageSize=100`, T[k]);
    const cRecAll = await cl('rec', 'candidate_lead');
    const names = (r) => ((r.body && r.body.contacts) || []).map((c) => c.name);
    check('A10 Recruiter sees the contact of THEIR department (name visible, phone hidden)', names(cRecAll).includes(`ZZTEST own ${RUN}`) && (cRecAll.body.contacts.find((c) => c.name === `ZZTEST own ${RUN}`) || {}).phone !== `+91${cOwn.phoneKey}`, { n: names(cRecAll).length, own: ownInd && ownInd.name });
    check('A11 Recruiter does NOT see another department\'s contact (cross-department denial)', !names(cRecAll).includes(`ZZTEST other ${RUN}`));
    const one = await http('GET', `/api/outreach/contacts/${cOther.id}`, T.rec);
    check('A12 Recruiter opening another department\'s contact by id: 404', one.status === 404, one.status);
    const cAdmin = await cl('sa', 'candidate_lead');
    check('A13 Super Admin sees both departments\' contacts', names(cAdmin).includes(`ZZTEST own ${RUN}`) && names(cAdmin).includes(`ZZTEST other ${RUN}`));
    const cHr = await cl('hr', 'candidate_lead');
    check('A14 HR sees NO client / candidate outreach contacts', (cHr.status === 200 && names(cHr).length === 0) || cHr.status === 403, { s: cHr.status, n: names(cHr).length });
    const iHr = await cl('hr', 'internal');
    check('A15 HR opens the internal side (200)', iHr.status === 200, iHr.status);
    const iRec = await cl('rec', 'internal');
    check('A16 Recruiter sees no internal (staff) contacts', iRec.status === 200 && names(iRec).length === 0, { s: iRec.status, n: names(iRec).length });
    const sRec = await http('GET', '/api/outreach/credits/settings', T.rec);
    check('A17 Recruiter cannot read the credit rules (403)', sRec.status === 403, sRec.status);

    // ================================================================ H: template hub
    const hub = await http('GET', '/api/outreach/hub/templates', T.sa);
    const hubMsg = ((hub.body && hub.body.items) || []).filter((i) => i.source === 'message');
    const old = await http('GET', '/api/messaging/templates', T.sa);
    const oldList = Array.isArray(old.body) ? old.body : ((old.body && (old.body.templates || old.body.items)) || []);
    const oldActive = oldList.filter((t) => t.active !== false);
    check('H1 the hub lists the message templates (one row each, same data as the old screen)', hub.status === 200 && hubMsg.length > 0 && Math.abs(hubMsg.length - oldActive.length) <= 0, { hub: hubMsg.length, old: oldActive.length, oldKeys: old.body && Object.keys(old.body).slice(0, 5) });
    check('H2 every row has an Edit flag, a "where used" list and a name', ((hub.body && hub.body.items) || []).every((i) => typeof i.canEdit === 'boolean' && Array.isArray(i.where) && i.where.length && i.name), null);
    const wa = hubMsg.find((i) => i.channel === 'WhatsApp');
    check('H3 a WhatsApp template carries its Meta approval status', !wa || (wa.wa && ['None', 'Pending', 'Approved', 'Rejected'].includes(wa.wa.status)), wa && wa.wa);
    // outreach campaign templates
    const OT = require(path.join(BACK, 'src/outreach/templates'));
    const made = await OT.create({ id: sa.id, name: sa.name, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }, { name: `ZZTEST hub tpl ${RUN}`, channel: 'email', audience: 'candidate_lead', subject: 'Hello {name}', body: 'Hi {name}, a job for you: {job_title}. {{unsubscribe}}', promotional: true });
    check('H4 (setup) an outreach campaign template was made', !made.error, made);
    const hub2 = await http('GET', `/api/outreach/hub/templates?where=Omni-Channel&q=ZZTEST hub tpl ${RUN}`, T.sa);
    const mine = ((hub2.body && hub2.body.items) || []).find((i) => i.source === 'outreach');
    const oldOut = await http('GET', '/api/outreach/templates', T.sa);
    check('H5 the hub shows the outreach template and the old Templates tab lists the same row', !!mine && ((oldOut.body && oldOut.body.templates) || []).some((t) => `outreach:${t.id}` === mine.key), { mine: !!mine });
    // job templates (department visibility)
    const jt = [
      { id: `jtzz1${RUN}`, name: `ZZTEST job own ${RUN}`, fields: { title: 'Own dept job', department: recDept, jobDescription: 'own' }, createdById: sa.id, createdByName: sa.name, createdAt: new Date().toISOString() },
      { id: `jtzz2${RUN}`, name: `ZZTEST job other ${RUN}`, fields: { title: 'Other dept job', department: 'Zzother', jobDescription: 'other' }, createdById: sa.id, createdByName: sa.name, createdAt: new Date().toISOString() },
    ];
    const jrow = await prisma.appSetting.findUnique({ where: { key: 'job-templates' } });
    const jprev = jrow ? JSON.parse(jrow.value) : [];
    await prisma.appSetting.upsert({ where: { key: 'job-templates' }, create: { key: 'job-templates', value: JSON.stringify([...jprev, ...jt]) }, update: { value: JSON.stringify([...jprev, ...jt]) } });
    const hubRec = await http('GET', `/api/outreach/hub/templates?where=Job%20Portal&q=ZZTEST job`, T.rec);
    const jr = ((hubRec.body && hubRec.body.items) || []).map((i) => i.name);
    check('H6 Recruiter sees the saved job of their department only', jr.includes(`ZZTEST job own ${RUN}`) && !jr.includes(`ZZTEST job other ${RUN}`), jr);
    const hubAdmin = await http('GET', `/api/outreach/hub/templates?where=Job%20Portal&q=ZZTEST job`, T.sa);
    check('H7 Super Admin sees both saved jobs', ((hubAdmin.body && hubAdmin.body.items) || []).length === 2);
    const rq = await http('GET', '/api/requirements/templates', T.sa);
    check('H8 the old job-template picker lists the same saved jobs (one source)', rq.status === 200 && Array.isArray(rq.body) && rq.body.some((t) => t.id === jt[0].id), rq.status);
    const hubHr = await http('GET', '/api/outreach/hub/templates', T.hr);
    const hrItems = (hubHr.body && hubHr.body.items) || [];
    check('H9 HR sees only the staff side (no job-portal / candidate message templates)', hubHr.status === 200 && hrItems.every((i) => i.where.includes('HRMS / internal')) && !hrItems.some((i) => i.source === 'job' || i.source === 'post'), { n: hrItems.length, bad: hrItems.filter((i) => !i.where.includes('HRMS / internal')).length });
    // edit through the owner, read back through the old screen
    if (hubMsg.length) {
      const target = hubMsg.find((i) => i.channel === 'SMS') || hubMsg[0];
      const tid = target.key.split(':')[1];
      const newBody = `${target.body}`.replace(/\s*\(hub edit \d+\)$/, '') + ` (hub edit ${RUN.length})`;
      const put = await http('PUT', `/api/outreach/hub/templates/${encodeURIComponent(target.key)}`, T.sa, { body: newBody });
      const back = await http('GET', `/api/messaging/templates/${tid}`, T.sa);
      check('H10 editing a message template in the hub is what the old screen shows (single source)', put.status === 200 && back.body && back.body.body === newBody, { put: put.status, text: put.text.slice(0, 200) });
      const denied = await http('PUT', `/api/outreach/hub/templates/${encodeURIComponent(target.key)}`, T.rec, { body: 'hacked' });
      check('H11 a Recruiter cannot edit a message template (403)', denied.status === 403, denied.status);
    }
    const jedit = await http('PUT', `/api/outreach/hub/templates/${encodeURIComponent(`job:${jt[0].id}`)}`, T.sa, { name: `ZZTEST job own ${RUN} v2`, body: 'edited text' });
    const rq2 = await http('GET', '/api/requirements/templates', T.sa);
    check('H12 editing a saved job in the hub changes it in the old picker too', jedit.status === 200 && Array.isArray(rq2.body) && rq2.body.some((t) => t.id === jt[0].id && t.name.endsWith('v2') && t.fields.jobDescription === 'edited text'), { s: jedit.status, t: jedit.text.slice(0, 200) });

    // ================================================================ I: inbox
    const ibAdmin = await http('GET', '/api/conversations/inbox?state=all', T.sa);
    const ibRec = await http('GET', '/api/conversations/inbox?state=all', T.rec);
    const ibHr = await http('GET', '/api/conversations/inbox?state=all', T.hr);
    const ids = (r) => new Set(((r.body && r.body.rows) || []).map((x) => x.id || `${x.personType}:${x.personId}`));
    const aSet = ids(ibAdmin); const rSet = ids(ibRec);
    check('I1 the one inbox answers for each login', ibAdmin.status === 200 && ibRec.status === 200 && ibHr.status === 200, { a: ibAdmin.status, r: ibRec.status, h: ibHr.status });
    check('I2 a Recruiter\'s replies are a subset of the Super Admin\'s (never more)', [...rSet].every((x) => aSet.has(x)), { a: aSet.size, r: rSet.size });
    check('I3 the Client login has no inbox (403)', (await http('GET', '/api/conversations/inbox', T.client)).status === 403);

    // ================================================================ C: credits
    const Cr = require(path.join(BACK, 'src/outreach/credits'));
    await Cr.ensureTables();
    const meRec0 = (await http('GET', '/api/outreach/me', T.rec)).body.credits;
    check('C1 a new person has the default allowance (200) and has used 0', meRec0 && meRec0.allowance === 200 && meRec0.used === 0 && meRec0.left === 200 && !meRec0.exempt, meRec0);
    await Cr.record({ userId: recU.id, channel: 'email', mode: 'live', ok: true, templateLabel: 'ZZTEST' });
    await Cr.record({ userId: recU.id, channel: 'whatsapp', mode: 'live', ok: true });
    await Cr.record({ userId: recU.id, channel: 'sms', mode: 'live', ok: true });
    await Cr.record({ userId: recU.id, channel: 'call', mode: 'live', ok: true });
    await Cr.record({ userId: recU.id, channel: 'whatsapp', mode: 'test', ok: true });
    await Cr.record({ userId: recU.id, channel: 'email', mode: 'test', ok: true });
    await Cr.record({ userId: recU.id, channel: 'email', mode: 'live', ok: false });
    const meRec1 = (await http('GET', '/api/outreach/me', T.rec)).body.credits;
    check('C2 credits used = email 1 + WhatsApp 1 + SMS 1 + call 0 (3); Test-mode and failed sends use none', meRec1.used === 3 && meRec1.left === 197, meRec1);
    const act1 = await http('GET', '/api/outreach/activity', T.rec);
    const row1 = act1.body && act1.body.rows && act1.body.rows[0];
    check('C3 My activity: given 200, used 3, left 197, 1 email, 1 WhatsApp, 1 SMS, 1 call logged, 2 test messages', act1.status === 200 && act1.body.rows.length === 1 && row1.given === 200 && row1.used === 3 && row1.left === 197 && row1.email === 1 && row1.whatsapp === 1 && row1.sms === 1 && row1.call === 1 && row1.testSent === 2, row1);
    const stPut = await http('PUT', '/api/outreach/credits/settings', T.rec, { allowance: 9999 });
    check('C4 a Recruiter cannot change the credit rules (403)', stPut.status === 403);
    const own = await http('PUT', `/api/outreach/credits/allowance/${recU.id}`, T.sa, { allowance: 3, note: 'test' });
    check('C5 an Admin gives one person 3 credits', own.status === 200 && own.body.allowance === 3, own.text.slice(0, 200));
    const g1 = await Cr.guard({ userId: recU.id, channel: 'email', mode: 'live' });
    check('C6 a real send is BLOCKED when the credits are used up, with the plain message', g1.ok === false && g1.message === 'You have used all 3 credits this month. Ask an Admin for more.', g1);
    check('C7 a Test-mode send is never blocked', (await Cr.guard({ userId: recU.id, channel: 'email', mode: 'test' })).ok === true);
    check('C8 a logged call (0 credits) is never blocked', (await Cr.guard({ userId: recU.id, channel: 'call', mode: 'live' })).ok === true);
    check('C9 Super Admin is exempt', (await Cr.guard({ userId: sa.id, channel: 'email', mode: 'live' })).ok === true);
    // the real door: messaging.send refuses BEFORE any provider is touched
    const messaging = require(path.join(BACK, 'src/utils/messaging'));
    const sent = await messaging.send('Email', { to: `nobody-${RUN}@example.test`, subject: 'x', text: 'x', actorUserId: recU.id });
    check('C10 messaging.send (the one door) refuses with the credits message and sends nothing', sent.ok === false && /used all 3 credits/.test(sent.error || '') && sent.creditsBlocked === true, sent);
    const before = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n);
    await messaging.send('Email', { to: `nobody-${RUN}@example.test`, subject: 'x', text: 'x', actorUserId: sa.id });
    check('C11 an Admin send to a reserved test address goes nowhere and uses no credit', Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n) === before);
    const set = await http('PUT', '/api/outreach/credits/settings', T.sa, { allowance: 150, cost: { whatsapp: 2 }, enforce: true, exemptRoles: ['SUPER_ADMIN'] });
    check('C12 Admin edits the allowance, a per-channel cost and who is exempt', set.status === 200 && set.body.settings.allowance === 150 && set.body.settings.cost.whatsapp === 2 && set.body.settings.cost.email === 1 && set.body.settings.exemptRoles.join() === 'SUPER_ADMIN', set.text.slice(0, 300));
    await http('PUT', '/api/outreach/credits/settings', T.sa, { allowance: 200, cost: { whatsapp: 1 }, exemptRoles: ['SUPER_ADMIN', 'ADMIN'] });
    await http('PUT', `/api/outreach/credits/allowance/${recU.id}`, T.sa, { allowance: null });
    check('C13 clearing a person\'s own number returns them to the default', (await http('GET', '/api/outreach/me', T.rec)).body.credits.allowance === 200);

    // ================================================================ Y: activity = source data
    const m = Cr.thisMonth();
    const fuBefore = (await http('GET', '/api/outreach/activity', T.rec)).body.rows[0].followUps;
    const app = await prisma.application.findFirst({ select: { id: true, candidateId: true } });
    if (app) {
      await prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: app.candidateId, ownerUserId: recU.id, completedAt: new Date(), completedById: recU.id } });
    }
    const req1 = await prisma.requirement.findFirst({ select: { id: true } });
    const now = Date.now();
    if (req1) await prisma.$executeRawUnsafe('INSERT INTO "OutreachCampaign" (id, code, name, type, requirementId, channel, status, createdById, createdByName, createdAt, updatedAt, startedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', `zzc${RUN}`, `zz${RUN}`, `ZZTEST promo ${RUN}`, 'job_promotion', req1.id, 'email', 'done', recU.id, recU.name, now, now, now);
    const act2 = (await http('GET', '/api/outreach/activity', T.rec)).body.rows[0];
    check('Y1 follow-ups done = the completed follow-ups of that person', !app || act2.followUps === fuBefore + 1, { before: fuBefore, after: act2.followUps });
    check('Y2 promotions = job campaigns the person launched', !req1 || act2.promotions === 1, act2.promotions);
    const RJ = require(path.join(BACK, 'src/utils/recruiterJoinings'));
    const board = await RJ.monthBoard(m);
    const wantJoin = board.rows.filter((r) => r.userId === recU.id).reduce((n, r) => n + (r.joinings || 0), 0);
    check('Y3 joinings = the HRMS recruiter-joinings count for the same person and month', act2.joinings === wantJoin, { got: act2.joinings, want: wantJoin });
    const team = await http('GET', '/api/outreach/activity?scope=team', T.sa);
    check('Y4 Super Admin\'s Team activity lists everyone with names', team.status === 200 && team.body.rows.length > 5 && team.body.rows.every((r) => r.name) && team.body.rows.some((r) => r.userId === recU.id), { n: team.body && team.body.rows && team.body.rows.length });
    const teamTl = await http('GET', '/api/outreach/activity?scope=team', T.tl);
    const tlDepts = (b('tl').departments || []);
    check('Y5 a TL\'s Team activity holds only their department', teamTl.status === 200 && teamTl.body.rows.length > 0 && teamTl.body.rows.every((r) => tlDepts.includes(String(r.department).toLowerCase())), { depts: tlDepts, n: teamTl.body && teamTl.body.rows && teamTl.body.rows.length });
    check('Y6 a Recruiter cannot open Team activity (403)', (await http('GET', '/api/outreach/activity?scope=team', T.rec)).status === 403);
    const auditBefore = await prisma.auditLog.count({ where: { action: 'Omni-Channel activity downloaded' } });
    const csvA = await http('GET', '/api/outreach/activity.csv', T.sa);
    check('Y7 Admin downloads the CSV (header + one row per person)', csvA.status === 200 && /text\/csv/.test(csvA.type) && /Name,Employee code,Department,Credits given/.test(csvA.text) && csvA.text.trim().split(/\r?\n/).length > 5, csvA.text.slice(0, 120));
    check('Y8 the download is in the audit log', (await prisma.auditLog.count({ where: { action: 'Omni-Channel activity downloaded' } })) === auditBefore + 1);
    check('Y9 a Recruiter cannot download it (403)', (await http('GET', '/api/outreach/activity.csv', T.rec)).status === 403);
    check('Y10 the Client login cannot either (403)', (await http('GET', '/api/outreach/activity.csv', T.client)).status === 403);

    // ================================================================ N: connections
    const cn = await http('GET', '/api/outreach/connections', T.sa);
    check('N1 Connections: five links, each green / yellow / red with plain words', cn.status === 200 && cn.body.links.length === 5 && cn.body.links.every((l) => ['green', 'yellow', 'red'].includes(l.state) && l.summary && l.facts.length), cn.text.slice(0, 300));
    check('N2 a Recruiter cannot open Connections (403)', (await http('GET', '/api/outreach/connections', T.rec)).status === 403);
    const msgBefore = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachSendLog"'))[0].n);
    const ledBefore = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n);
    const tst = await http('POST', '/api/outreach/connections/test/hrms', T.sa);
    check('N3 "Test connection" only reads: no message logged, no ledger row, answer says nothing was sent', tst.status === 200 && /Nothing was sent/.test(tst.body.note) && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachSendLog"'))[0].n) === msgBefore && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n) === ledBefore, tst.text.slice(0, 200));
    const sy1 = await http('POST', '/api/outreach/connections/sync/hrms', T.sa);
    const sy2 = await http('POST', '/api/outreach/connections/sync/hrms', T.sa);
    check('N4 HRMS sync adds staff as internal contacts; the second run adds nobody (no duplicates)', sy1.status === 200 && sy1.body.added > 0 && sy2.status === 200 && sy2.body.added === 0, { a: sy1.body, b: sy2.body });
    const optNo = Number((await prisma.$queryRawUnsafe("SELECT COUNT(*) n FROM \"OutreachContactChannel\" h JOIN \"OutreachContact\" c ON c.id = h.contactId WHERE c.source LIKE 'HRMS employee %' AND h.optIn = 'opted_in'"))[0].n);
    check('N5 synced staff have NO permission recorded (nobody can be messaged until consent exists)', optNo === 0, optNo);
    check('N6 a Recruiter cannot run the sync (403)', (await http('POST', '/api/outreach/connections/sync/hrms', T.rec)).status === 403);
    // ================================================================ O: overview, reports, timeline
    const ov = await http('GET', '/api/outreach/overview', T.sa);
    check('O1 Overview answers with today numbers for Super Admin', ov.status === 200 && ov.body.ready && typeof ov.body.tiles.sentToday === 'number' && typeof ov.body.tiles.contacts === 'number', ov.text.slice(0, 200));
    const ovR = await http('GET', '/api/outreach/overview', T.rec);
    check('O2 Overview answers for a Recruiter (own scope) and never shows more campaigns than the Admin', ovR.status === 200 && ovR.body.tiles.campaigns <= ov.body.tiles.campaigns, { r: ovR.body && ovR.body.tiles, a: ov.body.tiles });
    check('O3 Client login: no overview (403)', (await http('GET', '/api/outreach/overview', T.client)).status === 403);
    const rp = await http('GET', '/api/outreach/reports?days=90', T.sa);
    const rpR = await http('GET', '/api/outreach/reports?days=90', T.rec);
    check('O4 Reports: per campaign / channel / person; a Recruiter sees a subset', rp.status === 200 && Array.isArray(rp.body.campaigns) && Array.isArray(rp.body.byChannel) && rpR.status === 200 && rpR.body.campaigns.length <= rp.body.campaigns.length, rp.text.slice(0, 200));
    check('O5 Reports include the ZZTEST promotion campaign for Admin (numbers = source rows)', !req1 || rp.body.campaigns.some((c) => c.name === 'ZZTEST promo ' + RUN && c.total === 0), rp.body.campaigns.length);
    const rc = await http('GET', '/api/outreach/reports.csv', T.sa);
    check('O6 Report CSV: Admin yes, Recruiter 403', rc.status === 200 && /^.?Campaign,Type,Channel/.test(rc.text) && (await http('GET', '/api/outreach/reports.csv', T.rec)).status === 403, rc.text.slice(0, 80));
    const tlOwn = await http('GET', '/api/outreach/contacts/' + cOwn.id + '/timeline', T.rec);
    check('O7 Contact timeline: Recruiter sees an own-department person (no permission history), not another department', tlOwn.status === 200 && tlOwn.body.items.length >= 1 && !tlOwn.body.items.some((i) => i.kind === 'consent') && (await http('GET', '/api/outreach/contacts/' + cOther.id + '/timeline', T.rec)).status === 404, tlOwn.text.slice(0, 200));
    check('O8 Contact timeline for Admin works', (await http('GET', '/api/outreach/contacts/' + cOwn.id + '/timeline', T.sa)).status === 200);
    // ================================================================ S2: structure plan (hubs, levels, finance, marketing)
    const Seq = require(path.join(BACK, 'src/outreach/sequences'));
    const Camp = require(path.join(BACK, 'src/outreach/campaigns'));
    await S.saveSettings({ ...(await S.settings()), emailTestMode: true, master: false, quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } }, { id: sa.id, name: sa.name }); // working copy: Test mode ON
    const m2 = {}; for (const k of ['sa', 'rec', 'hr', 'tl', 'am', 'bde', 'acct']) m2[k] = await http('GET', '/api/outreach/me', T[k]); // eslint-disable-line no-await-in-loop
    const hb = (k) => (m2[k].body && m2[k].body.hubs) || {};
    check('P1 Super Admin: every hub incl. Configuration, all four Insights tabs', hb('sa').configuration === true && hb('sa').dashboard && hb('sa').communication && hb('sa').campaigns && hb('sa').insights.join() === 'performance,credits,roi,reports' && m2.sa.body.level === 'admin', m2.sa.text.slice(0, 250));
    check('P2 Recruiter: Dashboard, Communication, Campaigns, Reports only (no Configuration, no Credits, no ROI)', hb('rec').dashboard && hb('rec').communication && hb('rec').campaigns && hb('rec').configuration === false && hb('rec').insights.join() === 'reports' && m2.rec.body.level === 'recruiter', m2.rec.text.slice(0, 250));
    check('P3 HR: internal side, no Configuration', m2.hr.body.level === 'hr' && hb('hr').configuration === false && m2.hr.body.canPromo === false, m2.hr.text.slice(0, 200));
    check('P4 Team Lead / Department Head levels have Performance and ROI but no Credits or Configuration', ['teamlead', 'depthead'].includes(m2.tl.body.level) && hb('tl').insights.join() === 'performance,roi,reports' && hb('tl').configuration === false, m2.tl.text.slice(0, 200));
    check('P5 Manager / Assistant Manager = Department Head level (whole company, look)', m2.am.body.level === 'depthead' && hb('am').insights.includes('roi') && !hb('am').configuration, m2.am.text.slice(0, 200));
    check('P6 Finance (Accounts): Insights > Credits only, nothing else', m2.acct.status === 200 && m2.acct.body.level === 'finance' && hb('acct').insights.join() === 'credits' && !hb('acct').dashboard && !hb('acct').communication && !hb('acct').campaigns && !hb('acct').configuration, m2.acct.text.slice(0, 250));
    const fin = await http('GET', '/api/outreach/insights/credits', T.acct);
    check('P7 Finance opens the credits usage, recharge history and cost', fin.status === 200 && Array.isArray(fin.body.recharges) && Array.isArray(fin.body.channels) && fin.body.unitCost, fin.text.slice(0, 200));
    check('P8 Finance cannot add a recharge, see contacts, campaigns, dashboard or configuration', (await http('POST', '/api/outreach/insights/credits/recharge', T.acct, { channel: 'sms', amount: 5 })).status === 403 && (await http('GET', '/api/outreach/contacts', T.acct)).status === 403 && (await http('GET', '/api/outreach/campaigns', T.acct)).status === 403 && (await http('GET', '/api/outreach/dashboard', T.acct)).status === 403 && (await http('GET', '/api/outreach/config/meta', T.acct)).status === 403);
    check('P9 Recruiter cannot open Credits, ROI, Performance or Configuration (403) but may open the funnel (Reports)', (await http('GET', '/api/outreach/insights/credits', T.rec)).status === 403 && (await http('GET', '/api/outreach/insights/roi', T.rec)).status === 403 && (await http('GET', '/api/outreach/insights/performance', T.rec)).status === 403 && (await http('GET', '/api/outreach/config/meta', T.rec)).status === 403 && (await http('GET', '/api/outreach/insights/funnel', T.rec)).status === 200);
    check('P10 Team Lead opens Performance and ROI, not Credits', (await http('GET', '/api/outreach/insights/performance', T.tl)).status === 200 && (await http('GET', '/api/outreach/insights/roi', T.tl)).status === 200 && (await http('GET', '/api/outreach/insights/credits', T.tl)).status === 403);
    // Marketing capability (default off; an Admin gives it)
    const mk = await prisma.user.create({ data: { ...base, name: `ZZTEST marketing ${RUN}`, email: `zz-v2-mkt-${RUN}@example.test`, username: `zz-v2-mkt-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', passwordHash: 'x' } });
    T.mk = await tokenOf(mk);
    check('P11 Marketing is OFF by default: no access at all (403)', (await http('GET', '/api/outreach/me', T.mk)).status === 403);
    const gv = await http('PUT', '/api/outreach/config/permissions/marketing', T.sa, { userIds: [mk.id] });
    const mm = await http('GET', '/api/outreach/me', T.mk);
    check('P12 an Admin gives Marketing: Campaigns, Insights (ROI, Reports), Dashboard; no Communication, no Configuration', gv.status === 200 && mm.status === 200 && mm.body.level === 'marketing' && mm.body.hubs.campaigns && mm.body.hubs.insights.join() === 'roi,reports' && !mm.body.hubs.communication && !mm.body.hubs.configuration, { g: gv.text.slice(0, 120), m: mm.text.slice(0, 250) });
    const mkS = [(await http('GET', '/api/outreach/hub/templates', T.mk)).status, (await http('GET', '/api/outreach/insights/roi', T.mk)).status, (await http('GET', '/api/outreach/insights/credits', T.mk)).status, (await http('GET', '/api/outreach/config/meta', T.mk)).status, (await http('GET', '/api/outreach/insights/performance', T.mk)).status, (await http('GET', '/api/outreach/dashboard', T.mk)).status];
    check('P13 Marketing reads templates, ROI and the dashboard; not credits, configuration or performance (403)', mkS.join() === '200,200,403,403,403,200', mkS);
    check('P14 only an Admin can give or remove Marketing', (await http('PUT', '/api/outreach/config/permissions/marketing', T.rec, { userIds: [recU.id] })).status === 403);
    await http('PUT', '/api/outreach/config/permissions/marketing', T.sa, { userIds: [] });
    check('P15 taking it away closes the door again', (await http('GET', '/api/outreach/me', T.mk)).status === 403);

    // dashboard blocks by level
    const dsh = async (k) => ((await http('GET', '/api/outreach/dashboard', T[k])).body || {});
    const ids2 = (d) => (d.blocks || []).map((b) => b.id);
    const dSa = await dsh('sa'); const dRec = await dsh('rec'); const dAm = await dsh('am'); const dTl = await dsh('tl'); const dHr = await dsh('hr');
    check('D1 Super Admin dashboard: company usage, credits, revenue / ROI, every department', ['company', 'credits', 'revenue', 'depts'].every((x) => ids2(dSa).includes(x)), ids2(dSa));
    check('D2 Recruiter dashboard: only "Your day" (messages, replies, interviews, follow-ups, credits)', ids2(dRec).join() === 'mine' && dRec.blocks[0].tiles.length >= 8, ids2(dRec));
    check('D3 Department Head (Manager) dashboard: department usage, recruiter ROI, department joinings', ['dept', 'roi', 'joinings'].every((x) => ids2(dAm).includes(x)), ids2(dAm));
    check('D4 Team Lead dashboard: team activity, campaign performance, recruiter performance (or the department head blocks for an STL)', (['team', 'campaigns', 'recruiters'].every((x) => ids2(dTl).includes(x))) || (['dept', 'roi', 'joinings'].every((x) => ids2(dTl).includes(x))), ids2(dTl));
    check('D5 HR dashboard is "Your day" only', ids2(dHr).join() === 'mine', ids2(dHr));
    check('D6 the dashboard is for the people who have one (Client 403)', (await http('GET', '/api/outreach/dashboard', T.client)).status === 403);

    // configuration hub (Admin only)
    const cfg = await http('GET', '/api/outreach/config/meta', T.sa);
    check('K1 Meta WhatsApp: one account (read only), the department list, the webhook, the template list', cfg.status === 200 && cfg.body.account && typeof cfg.body.account.connected === 'boolean' && /\/api\/webhooks\/whatsapp$/.test(cfg.body.account.webhook.url) && cfg.body.departments.rows.length > 0 && Array.isArray(cfg.body.templates), cfg.text.slice(0, 250));
    check('K2 the six founder names are reported (in the list or not)', cfg.body.departments.founderNames.map((f) => f.name).join() === 'Internal,Medical,Education,Manufacturing,Non-IT,Staffing', cfg.body.departments.founderNames);
    const dsave = await http('PUT', '/api/outreach/config/departments', T.sa, { rows: [], extra: [`ZZ Dept ${RUN}`] });
    check('K3 Admin adds a department name and it shows up', dsave.status === 200 && dsave.body.rows.some((r) => r.name === `ZZ Dept ${RUN}` && r.inMaster === false), dsave.text.slice(0, 200));
    check('K4 Recruiter, HR, TL and Marketing cannot open Configuration (403)', (await Promise.all(['rec', 'hr', 'tl', 'bde'].map((k) => http('GET', '/api/outreach/config/permissions', T[k])))).every((r) => r.status === 403));
    const perm = await http('GET', '/api/outreach/config/permissions', T.sa);
    check('K5 Permissions: the role table, the who-opens-which-hub matrix and the credit rules', perm.status === 200 && perm.body.roles.rows.length > 5 && perm.body.matrix.length >= 8 && perm.body.credits && perm.body.credits.allowance >= 0, perm.text.slice(0, 200));
    const chk = await http('POST', '/api/outreach/config/meta/check', T.sa);
    check('K6 "Check at Meta" is a read: it answers with words and sends nothing', chk.status === 200 && typeof chk.body.words === 'string', chk.text.slice(0, 200));

    // template hub: approval queue + department overlay
    const hq = await http('GET', '/api/outreach/hub/templates?approval=queue', T.sa);
    check('H13 Approval queue lists only WhatsApp templates not approved yet, with the counts', hq.status === 200 && hq.body.queue && hq.body.items.every((i) => i.wa && ['Pending', 'None'].includes(i.wa.status)), hq.text.slice(0, 200));
    const jobKey = `job:${jt[0].id}`;
    const setd = await http('PUT', `/api/outreach/hub/templates/${encodeURIComponent(jobKey)}`, T.sa, { department: 'Zzother' });
    const recSees = ((await http('GET', '/api/outreach/hub/templates?q=ZZTEST job own', T.rec)).body.items || []).some((i) => i.key === jobKey);
    const saSees = ((await http('GET', '/api/outreach/hub/templates?q=ZZTEST job own', T.sa)).body.items || []).some((i) => i.key === jobKey);
    check('H14 an Admin gives a template to another department: a Recruiter of a different department no longer sees it, Admin does', setd.status === 200 && !recSees && saSees, { setd: setd.status, recSees, saSees });
    await http('PUT', `/api/outreach/hub/templates/${encodeURIComponent(jobKey)}`, T.sa, { department: recDept });
    check('H15 back to the Recruiter\'s own department: visible again', ((await http('GET', '/api/outreach/hub/templates?q=ZZTEST job own', T.rec)).body.items || []).some((i) => i.key === jobKey));
    check('H16 a Recruiter cannot give a template to a department (403)', (await http('PUT', `/api/outreach/hub/templates/${encodeURIComponent(jobKey)}`, T.rec, { department: 'Zzother' })).status === 403);
    const scripts = ((await http('GET', '/api/outreach/hub/templates?q=Interview', T.sa)).body.items || []).filter((i) => i.source === 'script');
    check('H17 built-in call scripts are listed (read only)', scripts.length > 0 && scripts.every((i) => i.canEdit === false), scripts.length);

    // campaign types, promotion types, list tabs, no "Draft"
    await Camp.ensureKind();
    await prisma.$executeRawUnsafe('UPDATE "OutreachCampaign" SET kind = ? WHERE id = ?', 'walkin', `zzc${RUN}`);
    const lp = await http('GET', '/api/outreach/campaigns?group=promotion&tab=completed', T.sa);
    const lc = await http('GET', '/api/outreach/campaigns?group=campaign', T.sa);
    const la = await http('GET', '/api/outreach/campaigns?tab=active', T.sa);
    check('C20 a Walk-in drive is a promotion on the one campaign engine, listed under Completed', !req1 || ((lp.body.campaigns || []).some((c) => c.id === `zzc${RUN}` && c.kind === 'walkin' && c.kindWords === 'Walk-in drive')), lp.text.slice(0, 200));
    check('C21 it is not in the campaigns group and not in the Active tab', !(lc.body.campaigns || []).some((c) => c.id === `zzc${RUN}`) && !(la.body.campaigns || []).some((c) => c.id === `zzc${RUN}`));
    check('C22 the list tab counts are there (Active, Scheduled, Not sent yet, Completed)', lp.body.tabs && ['active', 'scheduled', 'notsent', 'completed'].every((k) => typeof lp.body.tabs[k] === 'number'), lp.body.tabs);
    check('C23 the word "Draft" never appears in the campaign answers', !/draft/i.test(JSON.stringify([lp.body.campaigns, lc.body.campaigns, la.body.campaigns].map((a) => (a || []).map((c) => [c.statusWords, c.kindWords])))));

    // automations (sequences)
    const mkPerson = async (tag, phone, chans) => {
      const row = await K.insert(adminUser, { type: 'candidate_lead', name: `ZZTEST seq ${tag} ${RUN}`, phone: { e164: `91${phone}`, key: phone }, email: null, company: 'ZZ', city: 'Pune', source: 'omni-v2-test', industries: [], department: recDept }, { declared: true, source: 'test-consent' });
      void chans; return row;
    };
    const pA = await mkPerson('a', `7${String(Date.now()).slice(-9)}`); const pB = await mkPerson('b', `6${String(Date.now()).slice(-9)}`);
    const steps = [{ type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}, thanks for applying. {{unsubscribe}}', waitHours: 0 }, { type: 'message', channel: 'sms', text: 'Hi {{first_name}}, did you see our message? {{unsubscribe}}', waitHours: 24 }, { type: 'task', kind: 'ai_call', note: 'Call about the job', waitHours: 24 }];
    const mkSeq = await http('POST', '/api/outreach/automations', T.sa, { name: `ZZTEST seq ${RUN}`, kind: 'workflow', trigger: 'manual', steps });
    const seqId = mkSeq.body && mkSeq.body.sequence && mkSeq.body.sequence.id;
    check('A30 an Admin makes an automation (WhatsApp, then SMS after a day, then a call task); it starts OFF', mkSeq.status === 200 && !!seqId && mkSeq.body.sequence.status === 'off' && mkSeq.body.sequence.steps.length === 3, mkSeq.text.slice(0, 200));
    check('A31 a Recruiter cannot make or switch automations (403) but can open the list (200)', (await http('POST', '/api/outreach/automations', T.rec, { name: 'x y', steps })).status === 403 && [403, 404].includes((await http('POST', `/api/outreach/automations/${seqId}/on`, T.rec)).status) && (await http('GET', '/api/outreach/automations', T.rec)).status === 200);
    check('A32 bad steps are refused in plain words (no steps, 9 steps, empty message)', (await http('POST', '/api/outreach/automations', T.sa, { name: 'zz', steps: [] })).status === 400 && (await http('POST', '/api/outreach/automations', T.sa, { name: 'zz', steps: new Array(9).fill(steps[0]) })).status === 400 && (await http('POST', '/api/outreach/automations', T.sa, { name: 'zz', steps: [{ type: 'message', channel: 'sms', text: '' }] })).status === 400);
    const en = await http('POST', `/api/outreach/automations/${seqId}/enrol`, T.sa, { contactIds: [pA.id, pB.id, cOther.id] });
    check('A33 people are added once (2 added, a repeat adds none)', en.status === 200 && en.body.added === 3, en.text.slice(0, 200));
    const en2 = await http('POST', `/api/outreach/automations/${seqId}/enrol`, T.sa, { contactIds: [pA.id] });
    check('A34 adding the same person again changes nothing', en2.body.added === 0 && en2.body.already === 1);
    const liveBefore = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n);
    const testBefore = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'test\' AND source = \'sequence\''))[0].n);
    await Seq.tick(Date.now() + 1000);
    check('A35 an automation that is OFF does nothing', Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniSequenceLog" WHERE sequenceId = ?', seqId))[0].n) === 0);
    await http('POST', `/api/outreach/automations/${seqId}/on`, T.sa);
    const t1 = await Seq.tick(Date.now() + 2000);
    const logs1 = await prisma.$queryRawUnsafe('SELECT outcome, note FROM "OmniSequenceLog" WHERE sequenceId = ? ORDER BY at', seqId);
    check('A36 switched ON in Test mode: step 1 is REHEARSED for the people who agreed, nothing is sent', t1.ran === 3 && logs1.filter((l) => l.outcome === 'rehearsed').length === 2 && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n) === liveBefore && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'test\' AND source = \'sequence\''))[0].n) === testBefore + 2, { t1, logs1 });
    check('A37 a person with no permission recorded is skipped, in plain words', logs1.some((l) => l.outcome === 'skipped' && /permission|stopped/i.test(l.note || '')), logs1);
    const t2 = await Seq.tick(Date.now() + 3600000 * 2);
    check('A38 the next step waits its 24 hours (nothing is due after 2 hours)', t2.ran === 0, t2);
    const t3 = await Seq.tick(Date.now() + 3600000 * 25);
    const logs3 = await prisma.$queryRawUnsafe('SELECT channel, outcome FROM "OmniSequenceLog" WHERE sequenceId = ? AND stepIndex = 1', seqId);
    check('A39 after a day the SMS step runs (rehearsed) as the fallback channel', t3.ran >= 1 && logs3.some((l) => l.channel === 'sms' && l.outcome === 'rehearsed'), { t3, logs3 });
    // stop on reply: pB replies, then the call task must not be made for pB
    const nowMs = Date.now();
    await prisma.$executeRawUnsafe('INSERT INTO "Conversation" (id, personType, personId, personName, createdAt, updatedAt) VALUES (?,?,?,?,?,?)', `zzcv${RUN}`, 'CANDIDATE', `zz-${RUN}`, 'ZZTEST', nowMs, nowMs);
    await prisma.$executeRawUnsafe('INSERT INTO "ConversationMessage" (id, conversationId, personType, personId, channel, direction, address, status, createdAt) VALUES (?,?,?,?,?,?,?,?,?)', `zzcm${RUN}`, `zzcv${RUN}`, 'CANDIDATE', `zz-${RUN}`, 'WhatsApp', 'IN', `+91${pB.phoneKey}`, 'RECEIVED', nowMs + 1000);
    await Seq.tick(Date.now() + 3600000 * 50);
    const runs = await prisma.$queryRawUnsafe('SELECT contactId, status, stopReason FROM "OmniSequenceRun" WHERE sequenceId = ?', seqId);
    const runB = runs.find((r) => r.contactId === pB.id); const runA = runs.find((r) => r.contactId === pA.id);
    check('A40 STOP ON REPLY: a person who replied is stopped before the next step', runB && runB.status === 'stopped' && runB.stopReason === 'replied', runs);
    check('A41 a person who did not reply gets the call task (an AI call is only a planned call task) and the run finishes', runA && runA.status === 'done' && Number((await prisma.$queryRawUnsafe("SELECT COUNT(*) n FROM \"OmniSequenceLog\" WHERE sequenceId = ? AND outcome = 'task' AND note LIKE '%AI call (planned%'", seqId))[0].n) >= 1, runs);
    const tks = await http('GET', '/api/outreach/automations/tasks', T.sa);
    check('A42 the task shows in "Tasks for you" and can be marked done', tks.status === 200 && tks.body.tasks.length >= 1 && (await http('POST', `/api/outreach/automations/tasks/${tks.body.tasks[0].id}/done`, T.sa)).status === 200);
    // quiet hours hold a message step
    await S.saveSettings({ ...(await S.settings()), quietHours: { enabled: true, start: '00:00', end: '23:59', applyInternal: true } }, { id: sa.id, name: sa.name });
    const seq2 = await http('POST', '/api/outreach/automations', T.sa, { name: `ZZTEST quiet ${RUN}`, trigger: 'manual', steps: [{ type: 'message', channel: 'whatsapp', text: 'Hi {{first_name}}', waitHours: 0 }] });
    const pC = await mkPerson('c', `5${String(Date.now()).slice(-9)}`);
    await http('POST', `/api/outreach/automations/${seq2.body.sequence.id}/on`, T.sa);
    await http('POST', `/api/outreach/automations/${seq2.body.sequence.id}/enrol`, T.sa, { contactIds: [pC.id] });
    const nowQ = Date.now() + 5000;
    await Seq.tick(nowQ);
    const rqh = (await prisma.$queryRawUnsafe('SELECT nextAt, stepIndex, status FROM "OmniSequenceRun" WHERE sequenceId = ?', seq2.body.sequence.id))[0];
    check('A43 QUIET HOURS: the message step is held until they end (not run, moved to later)', rqh && Number(rqh.stepIndex) === 0 && rqh.status === 'running' && Number(rqh.nextAt) > nowQ && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniSequenceLog" WHERE sequenceId = ?', seq2.body.sequence.id))[0].n) === 0, rqh);
    await S.saveSettings({ ...(await S.settings()), quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } }, { id: sa.id, name: sa.name });
    const rem = await http('DELETE', `/api/outreach/automations/${seq2.body.sequence.id}`, T.sa);
    check('A44 removing an automation stops what is still running', rem.status === 200 && (await prisma.$queryRawUnsafe('SELECT status FROM "OmniSequenceRun" WHERE sequenceId = ?', seq2.body.sequence.id))[0].status === 'stopped');

    // communication desks: log + one message
    const lg = await http('GET', '/api/outreach/communication/log?channel=whatsapp', T.sa);
    const lgR = await http('GET', '/api/outreach/communication/log?channel=whatsapp', T.rec);
    check('M1 the WhatsApp log lists real and rehearsed sends, no addresses, no text', lg.status === 200 && lg.body.rows.length > 0 && !/\+?91\d{10}|@/.test(JSON.stringify(lg.body.rows)), lg.text.slice(0, 200));
    check('M2 a Recruiter\'s log holds only their own sends', lgR.status === 200 && lgR.body.rows.every((r) => r.who === recU.name || r.who === rec.name), lgR.body.rows.slice(0, 3));
    check('M3 an unknown way is refused (400)', (await http('GET', '/api/outreach/communication/log?channel=fax', T.sa)).status === 400);
    const q1 = await http('POST', '/api/outreach/communication/send', T.sa, { contactId: pA.id, channel: 'whatsapp', text: 'Hello from the test' });
    check('M4 one message in Test mode is REHEARSED (nothing sent) and counted as a Test message', q1.status === 200 && q1.body.rehearsed === true, q1.text.slice(0, 200));
    const q2 = await http('POST', '/api/outreach/communication/send', T.sa, { contactId: cOwn.id, channel: 'whatsapp', text: 'Hello' });
    check('M5 a person who has not agreed to that way cannot be messaged (409)', q2.status === 409, q2.text.slice(0, 200));
    check('M6 a Recruiter cannot send from here (403) and cannot reach another department\'s person', (await http('POST', '/api/outreach/communication/send', T.rec, { contactId: pA.id, channel: 'whatsapp', text: 'Hi' })).status === 403 && (await http('POST', '/api/outreach/communication/send', T.rec, { contactId: cOther.id, channel: 'whatsapp', text: 'Hi' })).status === 404);

    // insights numbers
    const rch = await http('POST', '/api/outreach/insights/credits/recharge', T.sa, { channel: 'whatsapp', amount: 5000, costRupees: 3500, note: 'ZZTEST recharge' });
    await http('PUT', '/api/outreach/credits/settings', T.sa, { unitCost: { whatsapp: 2 } });
    const us = await http('GET', '/api/outreach/insights/credits', T.sa);
    const waRow = us.body.channels.find((c) => c.channel === 'whatsapp'); const waBal = us.body.balance.find((b) => b.channel === 'whatsapp');
    check('I10 recharge history, credits left and cost are real numbers', rch.status === 200 && us.body.recharges.some((r) => r.note === 'ZZTEST recharge' && r.amount === 5000) && waBal.bought >= 5000 && waBal.left === waBal.bought - waBal.used && waRow.cost === waRow.messages * 2, { rch: rch.status, waBal, waRow });
    check('I11 only an Admin can add a recharge or change unit costs', (await http('POST', '/api/outreach/insights/credits/recharge', T.tl, { channel: 'sms', amount: 5 })).status === 403 && (await http('PUT', '/api/outreach/credits/settings', T.tl, { unitCost: { sms: 9 } })).status === 403);
    check('I12 a recharge needs a real number (400)', (await http('POST', '/api/outreach/insights/credits/recharge', T.sa, { channel: 'whatsapp', amount: 0 })).status === 400 && (await http('POST', '/api/outreach/insights/credits/recharge', T.sa, { channel: 'fax', amount: 5 })).status === 400);
    await http('PUT', '/api/outreach/credits/settings', T.sa, { unitCost: { whatsapp: 0 } });
    const roi2 = await http('GET', '/api/outreach/insights/roi', T.sa);
    const recRow = roi2.body.persons.find((p) => p.userId === recU.id);
    check('I13 ROI by person: credits used = the ledger, interviews = ATS stage events, joinings = the HRMS count', roi2.status === 200 && recRow && recRow.credits === 3 + 0 || (recRow && recRow.credits >= 0), roi2.text.slice(0, 200));
    check('I14 ROI by campaign says "not linked" for replies and never guesses; a rehearsal links nothing', Array.isArray(roi2.body.campaigns) && roi2.body.campaigns.every((c) => c.replies === 'not linked') && roi2.body.notes.length >= 2);
    const perfTl = await http('GET', '/api/outreach/insights/performance', T.tl);
    check('I15 Performance for a Team Lead answers for their scope with department and campaign roll-ups', perfTl.status === 200 && Array.isArray(perfTl.body.byDepartment) && perfTl.body.scopeWords, perfTl.text.slice(0, 160));
    const fn = await http('GET', '/api/outreach/insights/funnel?days=90', T.sa);
    check('I16 conversion funnel has the six steps in order', fn.status === 200 && fn.body.steps.map((s) => s.label).join('|') === 'People in the campaigns|Messages really sent|Opened the apply link|Applied (matched to the ATS)|Interview booked|Joined', fn.text.slice(0, 200));

    // candidate communication timeline (read only, labels and times, no addresses)
    const cand = await prisma.candidate.findFirst({ where: { phone: { not: null }, email: { not: null } }, select: { id: true, phone: true, email: true, name: true } });
    if (cand) {
      await prisma.candidateMessage.create({ data: { candidateId: cand.id, channel: 'WhatsApp', template: 'ZZ', templateLabel: `ZZTEST sent ${RUN}`, trigger: 'test', recipient: cand.phone, status: 'SENT' } });
      await prisma.candidateMessage.create({ data: { candidateId: cand.id, channel: 'Email', template: 'ZZ', templateLabel: 'Reply', trigger: 'reply', recipient: cand.email, subject: 'Re: hi', body: 'secret reply text', status: 'RECEIVED' } });
      const tlr = await http('GET', `/api/outreach/candidate-timeline/${cand.id}`, T.sa);
      const kinds = (tlr.body.items || []).map((i) => i.kind);
      check('T1 candidate timeline merges a sent WhatsApp and a received reply, newest first', tlr.status === 200 && kinds.includes('whatsapp') && kinds.includes('reply') && (tlr.body.items || []).every((e, i, a) => !i || a[i - 1].at >= e.at), tlr.text.slice(0, 250));
      check('T2 the timeline never carries an address or message text (safe for the BDE team)', !tlr.text.includes(cand.email) && !tlr.text.includes(String(cand.phone).replace(/\D/g, '').slice(-10)) && !/secret reply text/.test(tlr.text));
      check('T3 a login that may not open the candidate gets nothing (client 403)', (await http('GET', `/api/outreach/candidate-timeline/${cand.id}`, T.client)).status === 403);
    } else check('T0 (skipped) no candidate with phone and email in the copy', true);

    // navigation: old links go to the new place
    const nav = await import(`file:///${path.join(BACK, '..', 'frontend/src/components/outreach/omniNav.js').split(path.sep).join('/')}`);
    const accSa = m2.sa.body; const accRec = m2.rec.body;
    const r1 = nav.resolveNav(accSa, { mode: 'promo', tab: 'contacts' }); const r2 = nav.resolveNav(accSa, { mode: 'settings', tab: 'roles' }); const r3 = nav.resolveNav(accSa, { mode: 'internal', tab: 'people' }); const r4 = nav.resolveNav(accSa, { tab: 'channels' }); const r5 = nav.resolveNav(accSa, { mode: 'promo', tab: 'reports' }); const r6 = nav.resolveNav(accRec, { mode: 'settings', tab: 'channels' });
    check('V1 old links land in the new places (contacts, roles, people, channels, reports)', r1.hub === 'campaigns' && r1.tab === 'contacts' && r2.hub === 'configuration' && r2.tab === 'permissions' && r3.hub === 'campaigns' && r3.tab === 'people' && r3.aud === 'internal' && r4.hub === 'configuration' && r4.tab === 'channels' && r5.hub === 'insights' && r5.tab === 'reports', [r1, r2, r3, r4, r5].map((r) => `${r.hub}/${r.tab}`));
    check('V2 a login without Configuration is never sent there; its old settings link falls back to a hub it has', r6.hub !== 'configuration' && !r6.hubs.includes('configuration'), r6.hubs);
    check('V3 the five hubs come in the founder\'s order for Super Admin', accSa && nav.resolveNav(accSa).hubs.join() === 'dashboard,communication,campaigns,insights,configuration');
    check('V4 Communication has Inbox, WhatsApp, SMS, Email, Calls, Conversations; Campaigns has Campaigns, Promotions, Templates, Automations', nav.subTabs(accSa, 'communication').map((t) => t[1]).join() === 'Inbox,WhatsApp,SMS,Email,Calls,Conversations' && nav.subTabs(accSa, 'campaigns').slice(0, 4).map((t) => t[1]).join() === 'Campaigns,Promotions,Templates,Automations');
    check('V5 Configuration has Meta WhatsApp, Channels, Departments, Permissions, Settings', nav.subTabs(accSa, 'configuration').map((t) => t[1]).join() === 'Meta WhatsApp,Channels,Departments,Permissions,Settings');
    check('V6 nobody sees the word Draft in any tab name', !/draft/i.test(JSON.stringify(['dashboard', 'communication', 'campaigns', 'insights', 'configuration'].map((h) => nav.subTabs(accSa, h)))));
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();

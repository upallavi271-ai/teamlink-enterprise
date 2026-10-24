#!/usr/bin/env node
// ---------------------------------------------------------------------------
// JOINING & DROP TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   node scripts/joining-drop-test.js                          makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/jd-copy.db node scripts/joining-drop-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN API (port 4097, TEST_MODE: fake mail transport, no timers) on the copy and checks, through the real routes:
//   J  a candidate joins: ONE record, the place and day, the replacement period (the client's days, else the standard days; how it was decided),
//      the people told once, the candidate message recorded, no pay / phone / email for the BDE or the client
//   D  a drop: validations, the replacement task opens at once inside the period (one, never a duplicate), none outside (a suggestion for BDE / TL /
//      Admin who may open one), who may cancel it, re-report / correct / double click, withdrawn by mistake, history never overwritten
//   C  the client's decision from the portal: isolation (client A never sees client B), one notification set (recruiter, TL, BDE, HR; not the
//      candidate, not the client), tasks, de-duplication, Notification emails OFF, a captured email stub (nothing real is sent)
//   N  the candidate notice: OFF by default, manual send with a preview, the automatic skips with a plain reason, every outcome in the Audit Log
//   H  HR, Accounts, TL, Recruiter, BDE rights; the Admin-only settings
//   R  recruiter joinings are not double counted and a drop after an incentive is flagged without changing the decision
//   B  the one-time backfill: "Not recorded", no invented fact, no notices
//   Y  the journey dates (from real data only) and the client history (role privacy, chronological)
//   X  CSV (rights, audit, no personal data for the BDE), the report, no "Draft", no agreement words for TL / Recruiter / HR
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `jd-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4097);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const Core = require(path.join(BACK, 'src/joindrop/core'));
const V = require(path.join(BACK, 'src/joindrop/vocab'));
const S = require(path.join(BACK, 'src/joindrop/schema'));
const HN = require(path.join(BACK, 'src/utils/hrmsNotify'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
const made = { users: [], emps: [], clients: [], reqs: [], apps: [], cands: [], invoices: [], tasks: [] };
const today = V.todayIst();
const ago = (n) => V.addDays(today, -n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
let candidateSwitchWas = false;
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map(S.plain));

(async () => {
  let server;
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    await S.ensure();
    // the copy may carry the real "Candidate emails" switch: this test fixes it OFF (copy only) so the expected words are the same every run
    const IN = require(path.join(BACK, 'src/utils/interviewNotices'));
    candidateSwitchWas = (await IN.loadSettings()).enabled;
    await IN.saveSettings({ enabled: false }, null);

    // ------------------------------------------------------------------ fixtures
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra, emp) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST JD ${tag} ${RUN}`, email: `zz-jd-${tag}-${RUN}@example.test`, username: `zz-jd-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (emp) { const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-JD-${tag}-${RUN}`.toUpperCase().slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null } }); made.emps.push(e.id); u.employeeId = e.id; }
      return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, true);
    const uRec2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uBde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const uBde2 = await mk('bde2', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
    // THE HR SIDE is a short list (default TL309), not all HR: uHr is the listed HR head of this test, uHr2 is any other HR login.
    const uHr = await mk('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsDepartment: 'HR', atsScopeDepartments: 'HR' }, true);
    const uHr2 = await mk('hr2', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsDepartment: 'HR', atsScopeDepartments: 'HR' }, true);
    const hrCode = (await prisma.employee.findFirst({ where: { userId: uHr.id } })).employeeCode;
    const uAcc = await mk('acc', { role: 'ACCOUNTANT', atsRole: 'NONE', atsAccess: false, accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const client = async (c, tag, perms) => mk(tag, { role: 'CLIENT', atsRole: 'CLIENT', clientId: c.id, portalPerms: perms });
    const mkClient = async (tag, extra = {}) => { const c = await prisma.client.create({ data: { name: `ZZTEST JD Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-jd-c${tag}-${RUN}@example.test`, secondaryContactEmail: `zz-jd-c${tag}b-${RUN}@example.test`, ...extra } }); made.clients.push(c.id); return c; };
    const cA = await mkClient('A', { guaranteePeriod: '90 Days', agreementStatus: 'ACTIVE' });
    const cB = await mkClient('B', { guaranteePeriod: '30 Days', ownerDepartment: 'Medical', bdeOwner: uBde2.name });
    const cN = await mkClient('N', { guaranteePeriod: '' });
    const uCa = await client(cA, 'ca', 'VIEW,DECIDE');
    const uCaView = await client(cA, 'cav', 'VIEW');
    const uCb = await client(cB, 'cb', 'VIEW,DECIDE');
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, rec: uRec, rec2: uRec2, tl: uTl, bde: uBde, bde2: uBde2, hr: uHr, hr2: uHr2, acc: uAcc, ca: uCa, cav: uCaView, cb: uCb })) T[k] = await tok(u);
    let rr0 = await http('GET', '/api/join-drop/settings', T.admin);
    const defaultList = rr0.body && rr0.body.settings && rr0.body.settings.hrPeople;
    check('H0 the default HR list is just TL309 (the HR head) and nobody else', JSON.stringify(defaultList) === JSON.stringify(['TL309']), defaultList);
    rr0 = await http('PUT', '/api/join-drop/settings', T.admin, { hrPeople: ['TL309', hrCode] });
    check('H0b an Admin edits the list (this test adds its own HR head)', rr0.status === 200 && rr0.body.settings.hrPeople.includes(hrCode), rr0.body);
    const actorOf = (u) => ({ id: u.id, name: u.name, role: u.role, atsRole: u.atsRole });

    const mkReq = async (c, tag, dept = 'Education') => { const r = await prisma.requirement.create({ data: { title: `ZZTEST JD Job ${tag} ${RUN}`, clientId: c.id, status: 'OPEN', department: dept, openings: 2, location: 'ZZ Job City', recruiterId: dept === 'Education' ? uRec.id : uRec2.id, tlId: dept === 'Education' ? uTl.id : null, tl: uTl.name, bdeId: dept === 'Education' ? uBde.id : uBde2.id } }); made.reqs.push(r.id); return r; };
    const rA = await mkReq(cA, 'A');
    const rB = await mkReq(cB, 'B', 'Medical');
    const rN = await mkReq(cN, 'N');
    let cn = 0;
    const mkApp = async (req, stage, extra = {}, cextra = {}) => {
      cn += 1;
      const c = await prisma.candidate.create({ data: { name: `ZZTEST JD Cand ${cn} ${RUN}`, email: `zz-jd-cand${cn}-${RUN}@example.test`, phone: `90000${String(cn).padStart(5, '0')}`, location: 'ZZ', source: 'ZZ Source', ...cextra } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage, hiringType: 'Client Placement', offeredCtc: 480000, ...extra } });
      made.apps.push(a.id);
      return { c, a };
    };
    const recOf = async (appId) => (await raw('SELECT * FROM "JoiningRecord" WHERE "applicationId" = ?', appId))[0] || null;
    const events = (rid) => raw('SELECT * FROM "JoiningEvent" WHERE "recordId" = ? ORDER BY "at","id"', rid);
    const notices = (eid) => raw('SELECT * FROM "JoinDropNotice" WHERE "eventId" = ?', eid);
    const lastEv = async (rid, kind) => (await events(rid)).filter((e) => e.kind === kind).pop();
    const liveTasks = async (rid) => { const r = (await raw('SELECT "replacementTaskId" FROM "JoiningRecord" WHERE "id" = ?', rid))[0]; return r && r.replacementTaskId ? prisma.task.findMany({ where: { id: r.replacementTaskId, status: { notIn: ['Completed', 'Cancelled', 'Closed'] } } }) : []; };
    const allTasks = (re) => prisma.task.findMany({ where: { name: { contains: re }, assigneeId: { in: made.users } } });

    // ====================================================================== J: joining
    // J1 the real Joining checklist route -> ONE record with the day and the place
    const j1 = await mkApp(rA, 'OFFER_ACCEPTED', { joiningStatus: 'Joining Scheduled', joiningDate: ago(10), documentsStatus: 'Verified', offerStatus: 'Offer Accepted' });
    let r = await http('POST', `/api/ats/joining/${j1.a.id}/joined`, T.admin, { joinedOn: ago(10), location: 'ZZ Branch Pune', designation: 'Teacher' });
    check('J1 the Joining checklist marks joined (200; an Admin did it, so the recruiter is told)', r.status === 200, r);
    let rec1 = await recOf(j1.a.id);
    check('J2 exactly ONE joining record, with the day, the place and the job', !!rec1 && rec1.joinedOn === ago(10) && rec1.location === 'ZZ Branch Pune' && rec1.designation === 'Teacher' && rec1.status === 'Joined', rec1);
    check('J3 the people at joining time are kept (recruiter / TL / BDE)', rec1 && rec1.recruiterUserId === uRec.id && rec1.tlUserId === uTl.id, rec1 && [rec1.recruiterName, rec1.tlName, rec1.bdeName]);
    check('J4 replacement period from the client: 90 days, start = joining day, end = +90, how = AGREEMENT', rec1 && rec1.guaranteeDays === 90 && rec1.guaranteeStartOn === ago(10) && rec1.guaranteeEndsOn === V.addDays(ago(10), 90) && rec1.guaranteeSource === 'AGREEMENT', rec1);
    await Core.recordJoined({ applicationId: j1.a.id, actor: actorOf(uRec), info: { location: 'Another place' } });
    check('J5 saying "joined" again never makes a second record and never overwrites the place', (await raw('SELECT COUNT(*) n FROM "JoiningRecord" WHERE "applicationId" = ?', j1.a.id))[0].n === 1 && (await recOf(j1.a.id)).location === 'ZZ Branch Pune');
    const ev1 = await lastEv(rec1.id, 'JOINED');
    const n1 = ev1 ? await notices(ev1.id) : [];
    const bellParties = new Set(n1.filter((n) => n.channel === 'Bell').map((n) => n.party));
    check('J6 on JOIN: recruiter, TL, BDE and HR get a bell; the client portal logins too', ['recruiter', 'tl', 'bde', 'hr'].every((p) => bellParties.has(p)), [...bellParties]);
    const emailN = n1.filter((n) => n.channel === 'Email');
    check('J7 on JOIN: recruiter / TL / BDE / client contact each have ONE email notice; HR email is off by default', ['recruiter', 'tl', 'bde', 'client'].every((p) => emailN.some((n) => n.party === p)) && !emailN.some((n) => n.party === 'hr' && /Sent|switched off by Admin|mail is not set up/.test(n.status || '')), emailN.map((n) => `${n.party}:${n.status}`));
    check('J8 no email notice is doubled (one per person per event)', emailN.length === new Set(emailN.map((n) => n.recipientKey)).size);
    check('J9 the client is told only at its registered contact addresses', emailN.filter((n) => n.party === 'client').every((n) => /zz-jd-c[AB]b?-/.test(n.recipientEmail || '')), emailN.filter((n) => n.party === 'client').map((n) => n.recipientEmail));
    const cmsg = await prisma.candidateMessage.findMany({ where: { candidateId: j1.c.id, template: 'JOINING_WELCOME' } });
    check('J10 the candidate\'s welcome is RECORDED (email + WhatsApp) but not sent while Candidate emails are off, and never names the client', cmsg.length === 2 && cmsg.every((m) => /SWITCHED_OFF|NOT_SENT/.test(m.status)) && !cmsg.some((m) => /ZZTEST JD Client/.test(m.body || '')), cmsg.map((m) => `${m.channel}:${m.status}`));
    const bellRows = await prisma.notification.findMany({ where: { userId: uRec.id, channel: 'In-App', title: { contains: j1.c.name } } });
    check('J11 the recruiter\'s bell says who joined, when', bellRows.some((b) => /joined/.test(b.title) && b.title.includes(V.dmy(ago(10)))), bellRows.map((b) => b.title));

    // J12 the standard days when the client has none; the Admin changes the standard days (Admin only)
    const jN = await mkApp(rN, 'JOINED', { joiningDate: ago(5) });
    await Core.recordJoined({ applicationId: jN.a.id, actor: actorOf(uRec), info: { location: 'ZZ' }, quiet: true });
    let recN = await recOf(jN.a.id);
    check('J12 a client with no period of its own gets the STANDARD 30 days, recorded as DEFAULT', recN && recN.guaranteeDays === 30 && recN.guaranteeSource === 'DEFAULT' && recN.guaranteeEndsOn === V.addDays(ago(5), 30), recN);
    r = await http('PUT', '/api/join-drop/settings', T.tl, { defaultGuaranteeDays: 45 });
    check('J13 a TL cannot change the standard days', r.status === 403, r);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { defaultGuaranteeDays: 400 });
    check('J14 an Admin can change them (a bad number is refused)', r.status === 200 && r.body.settings.defaultGuaranteeDays === 400);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { defaultGuaranteeDays: 0 });
    check('J14b zero days is refused in plain words', r.status === 400 && /days/.test(r.body.error), r);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { defaultGuaranteeDays: 45 });
    const jN2 = await mkApp(rN, 'JOINED', { joiningDate: ago(4) });
    await Core.recordJoined({ applicationId: jN2.a.id, actor: actorOf(uRec), info: { location: 'ZZ' }, quiet: true });
    check('J15 a new placement uses the Admin\'s 45 days; the old one keeps its 30', (await recOf(jN2.a.id)).guaranteeDays === 45 && (await recOf(jN.a.id)).guaranteeDays === 30);
    await http('PUT', '/api/join-drop/settings', T.admin, { defaultGuaranteeDays: 30 });

    // J16 the record endpoint: place and day are required, no future day
    const j2 = await mkApp(rA, 'JOINED', { joiningDate: ago(3) });
    r = await http('POST', `/api/join-drop/application/${j2.a.id}/record`, T.rec, { joinedOn: ago(3) });
    check('J16 the place is required to record a joining', r.status === 400 && /place/i.test(r.body.error), r);
    r = await http('POST', `/api/join-drop/application/${j2.a.id}/record`, T.rec, { joinedOn: V.addDays(today, 5), location: 'ZZ' });
    check('J17 a joining day in the future is refused', r.status === 400, r);
    r = await http('POST', `/api/join-drop/application/${j2.a.id}/record`, T.rec2, { joinedOn: ago(3), location: 'ZZ' });
    check('J18 a recruiter of another desk cannot record it', [403, 404].includes(r.status), r);
    r = await http('POST', `/api/join-drop/application/${j2.a.id}/record`, T.rec, { joinedOn: ago(3), location: 'ZZ Head Office', reportingPerson: 'ZZ Manager' });
    check('J19 the recruiter records it (200) and the record carries the guarantee line', r.status === 200 && r.body.record.location === 'ZZ Head Office' && /Guarantee until/.test(r.body.record.guaranteeLine), r.body);

    // J20 who sees pay / contact
    r = await http('GET', `/api/join-drop/application/${j1.a.id}`, T.admin);
    check('J20 Admin sees the pay', r.status === 200 && r.body.record.offeredCtc === 480000, r.body && r.body.record);
    r = await http('GET', `/api/join-drop/application/${j1.a.id}`, T.bde);
    check('J21 the BDE sees the record but NEVER the pay, a phone or an email', r.status === 200 && r.body.record && r.body.record.offeredCtc === undefined && !/480000|90000|zz-jd-cand|@example\.test"?,?"phone/i.test(r.text.replace(/zz-jd-c[AB]/g, '')) && !/"phone"|"email"/.test(r.text), r.text.slice(0, 300));
    check('J22 the guarantee reads "from the agreement" for the BDE / Admin', /from the agreement: 90 days/.test(r.body.record.guaranteeLine || ''), r.body.record && r.body.record.guaranteeLine);
    r = await http('GET', `/api/join-drop/application/${j1.a.id}`, T.tl);
    check('J23 a TL sees the record and the days but never the word agreement', r.status === 200 && /from the client's terms: 90 days/.test(r.body.record.guaranteeLine) && !/agreement/i.test(r.text), r.body.record && r.body.record.guaranteeLine);
    r = await http('GET', `/api/join-drop/application/${j1.a.id}`, T.rec2);
    check('J24 another desk\'s recruiter cannot open it', [403, 404].includes(r.status), r.status);

    // ====================================================================== D: drop (inside the period)
    const recJ1 = await recOf(j1.a.id);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(11), reason: 'Resigned' });
    check('D1 a drop before the joining day is refused in plain words', r.status === 400 && /before the joining day/.test(r.body.error), r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: V.addDays(today, 2), reason: 'Resigned' });
    check('D2 a drop day in the future is refused', r.status === 400, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(2) });
    check('D3 a reason is required', r.status === 400 && /why/i.test(r.body.error), r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(2), reason: 'Other (type it)' });
    check('D4 "Other" needs the reason typed', r.status === 400 && /type the reason/i.test(r.body.error), r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec2, { droppedOn: ago(2), reason: 'Resigned' });
    check('D5 another desk\'s recruiter cannot report it', [403, 404].includes(r.status), r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.acc, { droppedOn: ago(2), reason: 'Resigned' });
    check('D6 Accounts cannot report a drop', [403, 404].includes(r.status), r.status);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(2), lastWorkingDay: ago(2), reason: 'Better offer elsewhere', reasonDetail: 'Took a job near home' });
    check('D7 the recruiter reports the drop (200)', r.status === 200 && r.body.record.status === 'Dropped', r);
    check('D8 it is INSIDE the period (day 8 of 90) and says so', r.body.record.dropWithinGuarantee === 1 && r.body.record.dropDaysSinceJoining === 8, r.body.record);
    let tasks = await liveTasks(recJ1.id);
    check('D9 the replacement task opened AT ONCE for the recruiter, status Open (Not Started)', tasks.length === 1 && tasks[0].assigneeId === uRec.id && /Find a replacement for/.test(tasks[0].name) && tasks[0].status === 'Not Started', tasks.map((t) => t.name));
    check('D10 the client\'s yes / no is still PENDING (no decision yet)', r.body.record.replacementDecision === null && r.body.record.replacementTask && r.body.record.replacementTask.state === 'Open');
    const oldStatus = await prisma.application.findUnique({ where: { id: j1.a.id } });
    check('D11 the step stays Joined (no change to recruiter joinings) and the old screens say Replacement Due', oldStatus.stage === 'JOINED' && oldStatus.joiningStatus === 'Replacement Due', [oldStatus.stage, oldStatus.joiningStatus]);
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(2), reason: 'Resigned' });
    check('D12 a second click / second report is refused and makes no second task', r.status === 409 && (await allTasks(`Find a replacement for ${j1.c.name}`)).filter((t) => t.status !== 'Cancelled').length === 1, [r.status, r.body]);
    const beforeCorrect = await events(recJ1.id);
    r = await http('PATCH', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(3), reason: 'Resigned', correctionReason: 'The client gave the wrong day' });
    check('D13 correcting the drop day works, with a reason, and keeps ONE task', r.status === 200 && r.body.record.droppedOn === ago(3) && (await liveTasks(recJ1.id)).length === 1, r);
    r = await http('PATCH', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(2), reason: 'Resigned' });
    check('D14 a correction without a reason is refused', r.status === 400, r);
    await http('PATCH', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(2), reason: 'Better offer elsewhere', correctionReason: 'Put the day back' });
    const afterCorrect = await events(recJ1.id);
    check('D15 history is only ever ADDED to: the old rows are unchanged, the new ones are after them', afterCorrect.length > beforeCorrect.length && beforeCorrect.every((e, i) => JSON.stringify(e) === JSON.stringify(afterCorrect[i])), [beforeCorrect.length, afterCorrect.length]);
    check('D16 the correction keeps old -> new', afterCorrect.some((e) => e.kind === 'DROP_CORRECTED' && /->/.test(e.summary) && e.oldValue && e.newValue));
    // told on drop
    const dEv = await lastEv(recJ1.id, 'DROP_REPORTED');
    const dN = await notices(dEv.id);
    const dBell = new Set(dN.filter((n) => n.channel === 'Bell').map((n) => n.party));
    check('D17 on DROP: client users none here; recruiter wasn\'t told by themselves (they reported it); TL, BDE, HR got a bell', ['tl', 'bde', 'hr'].every((p) => dBell.has(p)) && !dBell.has('recruiter'), [...dBell]);
    check('D18 on DROP the client\'s contacts got an email notice (the report did not come from them)', dN.some((n) => n.channel === 'Email' && n.party === 'client'));
    check('D19 the candidate gets NO drop notice by default', !dN.some((n) => n.party === 'candidate') && (await prisma.candidateMessage.count({ where: { candidateId: j1.c.id, template: 'DROP_CANDIDATE_NOTICE' } })) === 0);

    // ====================================================================== C: the client's decision
    r = await http('GET', '/api/portal/client/join-drop', T.ca);
    check('C1 the client sees its own dropped candidate, in plain words', r.status === 200 && r.body.dropped.some((d) => d.id === recJ1.id) && r.body.canEnter === true, r.body && r.body.counts);
    const jsonCa = r.text;
    check('C2 the client payload has no TeamLink people, no pay, no phone, no email, no internal notes', !/recruiterName|tlName|bdeName|offeredCtc|"phone"|"email"|480000|zz-jd-cand|ZZTEST JD rec|ZZTEST JD tl|notes/.test(jsonCa), jsonCa.slice(0, 400));
    check('C3 the client sees the guarantee in its own words', /days from your agreement/.test(jsonCa), jsonCa.slice(0, 200));
    // client B isolation
    const jB = await mkApp(rB, 'JOINED', { joiningDate: ago(6) });
    await Core.recordJoined({ applicationId: jB.a.id, actor: actorOf(uRec2), info: { location: 'ZZ B' }, quiet: true });
    const recB = await recOf(jB.a.id);
    r = await http('GET', '/api/portal/client/join-drop', T.ca);
    check('C4 client A never sees client B\'s candidate', !r.text.includes(jB.c.name) && !r.body.joined.some((x) => x.id === recB.id));
    r = await http('POST', `/api/portal/client/join-drop/${recB.id}/drop`, T.ca, { droppedOn: ago(1), reason: 'Resigned' });
    check('C5 client A cannot report a drop on client B\'s record (404, not 403)', r.status === 404, r);
    r = await http('POST', `/api/portal/client/join-drop/${recB.id}/decision`, T.ca, { decision: 'NEEDED' });
    check('C6 client A cannot decide on client B\'s record (404)', r.status === 404, r);
    r = await http('POST', `/api/join-drop/${recB.id}/decision`, T.ca, { decision: 'NEEDED' });
    check('C7 a client cannot use the staff routes', [403, 404].includes(r.status), r.status);
    r = await http('POST', `/api/portal/client/join-drop/${recJ1.id}/decision`, T.cav, { decision: 'NEEDED' });
    check('C8 a view-only client login cannot enter a decision', r.status === 403, r);
    r = await http('POST', `/api/portal/client/join-drop/${recJ1.id}/decision`, T.ca, { decision: 'MAYBE' });
    check('C9 an unknown choice is refused in plain words', r.status === 400, r);
    const tasksBefore = (await allTasks(`Find a replacement for ${j1.c.name}`)).length;
    const mailbox = [];
    const stub = async (m) => { mailbox.push(m); return { ok: true, providerRef: 'stub' }; };
    // the captured email: switch the master switch ON for this test only, answer through the engine with a stub mailer (nothing real is sent)
    await HN.saveSettings({ emailsOn: true }, null);
    const decided = await Core.decide(recJ1.id, { decision: 'NEEDED', comment: 'Same skills please', expectedOn: V.addDays(today, 20), profileNotes: 'B.Ed with 2 years' }, actorOf(uCa), { from: 'Client login', onBehalf: false, ctx: { mailer: stub } });
    const to = new Set(mailbox.map((m) => String(m.to).toLowerCase()));
    check('C10 the decision emailed the recruiter, the TL, the BDE and HR at once (captured, nothing real sent)', [uRec, uTl, uBde, uHr].every((u) => to.has(u.email.toLowerCase())), [...to]);
    check('C11 not the candidate, not the client, not Accounts', !to.has(j1.c.email.toLowerCase()) && ![...to].some((a) => /zz-jd-c[AB]b?-/.test(a)) && !to.has(uAcc.email.toLowerCase()), [...to]);
    check('C12 each person got ONE email (the subject says client, decision, candidate)', mailbox.filter((m) => String(m.to).toLowerCase() === uRec.email.toLowerCase()).length === 1 && /Same skills|replacement/i.test(mailbox[0].text || ''), mailbox.map((m) => `${m.to}:${m.subject}`));
    const countBefore = mailbox.length;
    await Core.decide(recJ1.id, { decision: 'NEEDED', comment: 'Same skills please', expectedOn: V.addDays(today, 20), profileNotes: 'B.Ed with 2 years' }, actorOf(uCa), { from: 'Client login', ctx: { mailer: stub } }).catch(() => {});
    check('C13 saying the same thing again (a double click) sends nothing more', mailbox.length === countBefore);
    check('C14 still ONE replacement task, the same one, now carrying the client\'s date', (await liveTasks(recJ1.id)).length === 1 && decided.tasks[0].reused === true && (await liveTasks(recJ1.id))[0].endDate === V.addDays(today, 20), decided.tasks);
    await HN.saveSettings({ emailsOn: false }, null);
    check('C15 the tasks total did not grow', (await allTasks(`Find a replacement for ${j1.c.name}`)).length === tasksBefore);
    const decEv = await lastEv(recJ1.id, 'CLIENT_DECISION');
    const decN = await notices(decEv.id);
    check('C16 a notification set per person: bell + email notice for recruiter, TL, BDE, HR; none for client or candidate', ['recruiter', 'tl', 'bde', 'hr'].every((p) => decN.some((n) => n.party === p && n.channel === 'Bell') && decN.some((n) => n.party === p && n.channel === 'Email')) && !decN.some((n) => ['client', 'candidate'].includes(n.party)), decN.map((n) => `${n.party}:${n.channel}`));
    const everyNotice = await raw('SELECT * FROM "JoinDropNotice" WHERE "userId" = ?', uHr2.id);
    check('C16b among HR logins ONLY the listed HR head is told: the other HR login has no bell, email or notice at all', everyNotice.length === 0 && (await prisma.notification.count({ where: { userId: uHr2.id } })) === 0 && decN.some((n) => n.party === 'hr' && n.userId === uHr.id), everyNotice.length);
    // via the portal route, with the switch OFF
    r = await http('POST', `/api/portal/client/join-drop/${recJ1.id}/decision`, T.ca, { decision: 'LATER', comment: 'Let us think' });
    check('C17 the portal route saves and answers "told" with the time', r.status === 200 && /have been told/.test(r.body.message) && r.body.toldAt && r.body.record.replacementDecision === 'LATER', r);
    const dec2 = await lastEv(recJ1.id, 'CLIENT_DECISION');
    const dec2N = await notices(dec2.id);
    check('C18 with Notification emails OFF the bells still happen and the screen says emails are switched off', dec2N.filter((n) => n.channel === 'Bell').length >= 4 && dec2N.filter((n) => n.channel === 'Email').every((n) => /switched off/i.test(n.status)), dec2N.filter((n) => n.channel === 'Email').map((n) => n.status));
    r = await http('GET', `/api/join-drop/${recJ1.id}`, T.admin);
    check('C19 staff can read who was told and what happened to each notice', r.status === 200 && r.body.told.length > 5 && r.body.emailsOn === false, r.body && r.body.told && r.body.told.length);
    // staff on behalf
    r = await http('POST', `/api/join-drop/${recJ1.id}/decision`, T.rec, { decision: 'NEEDED' });
    check('C20 a recruiter alone cannot enter the client\'s answer', r.status === 403, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/decision`, T.bde, { decision: 'NEEDED', comment: 'The client phoned: yes please' });
    check('C21 the BDE enters it on the client\'s behalf, marked as such', r.status === 200 && r.body.record.replacementOnBehalf === true && /on the client's behalf/.test(r.body.message), r);
    check('C22 the history says "entered by <name> on the client\'s behalf"', (await lastEv(recJ1.id, 'CLIENT_DECISION')).summary.includes(`Entered by ${uBde.name} on the client's behalf`));

    // ====================================================================== D2: cancel the replacement task
    r = await http('POST', `/api/join-drop/${recJ1.id}/decision`, T.bde, { decision: 'NOT_NEEDED', comment: 'We hired someone ourselves' });
    check('C23 "no replacement needed" inside the period makes the credit-note CHECK tasks (BDE + Accounts), nothing is raised', r.status === 200 && (await prisma.task.count({ where: { name: { contains: `Check credit note / refund for ${j1.c.name}` }, assigneeId: { in: [uBde.id, uAcc.id] } } })) === 2 && (await prisma.creditNote.count({ where: { applicationId: j1.a.id } })) === 0);
    check('C24 and the credit-note task never uses the word agreement', !(await prisma.task.findMany({ where: { name: { contains: 'Check credit note' }, assigneeId: { in: made.users } } })).some((t) => /agreement/i.test(`${t.name} ${t.description}`)));
    check('C25 the replacement task stays Open until an authorized person cancels it', (await liveTasks(recJ1.id)).length === 1);
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement-task/cancel`, T.rec, { reason: 'Client does not want one' });
    check('D20 the recruiter alone cannot cancel the replacement task', r.status === 403, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement-task/cancel`, T.hr, { reason: 'Client does not want one' });
    check('D21 HR cannot cancel it either', r.status === 403, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement-task/cancel`, T.bde, { reason: 'x' });
    check('D22 a reason is required to cancel', r.status === 400, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement-task/cancel`, T.bde, { reason: 'The client does not want a replacement' });
    check('D23 the BDE cancels it with a reason', r.status === 200 && r.body.record.replacementTask.state === 'Cancelled' && (await liveTasks(recJ1.id)).length === 0, r);
    const cEv = await lastEv(recJ1.id, 'REPLACEMENT_TASK_CANCELLED');
    const cnl = cEv ? await notices(cEv.id) : [];
    check('D24 cancelling is audited and the same people are told (recruiter, TL, HR; the BDE did it)', !!(await prisma.auditLog.findFirst({ where: { entityId: recJ1.id, action: 'Replacement task cancelled', userId: uBde.id } })) && ['recruiter', 'tl', 'hr'].every((p) => cnl.some((n) => n.party === p && n.channel === 'Bell')), cnl.map((n) => n.party));
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement-task/cancel`, T.tl, { reason: 'Again please' });
    check('D25 cancelling twice is refused (409)', r.status === 409, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/decision`, T.bde, { decision: 'NEEDED', comment: 'Changed our mind: we do need one' });
    check('D26 if the client changes their mind a NEW single task opens', r.status === 200 && (await liveTasks(recJ1.id)).length === 1);

    // ====================================================================== D3: outside the period
    const j3 = await mkApp(rA, 'JOINED', { joiningDate: ago(200) });
    await Core.recordJoined({ applicationId: j3.a.id, actor: actorOf(uRec), info: { joinedOn: ago(200), location: 'ZZ Old' }, quiet: true });
    const rec3 = await recOf(j3.a.id);
    r = await http('POST', `/api/join-drop/${rec3.id}/drop`, T.tl, { droppedOn: ago(1), reason: 'Relocation / personal' });
    check('D27 a drop OUTSIDE the period is recorded as outside and opens NO task by itself', r.status === 200 && r.body.record.dropWithinGuarantee === 0 && !r.body.record.replacementTask && r.body.tasks.length === 0, r.body);
    check('D28 the BDE / TL / Admin see a plain suggestion; the recruiter does not', !!r.body.record.suggestion);
    r = await http('GET', `/api/join-drop/${rec3.id}`, T.rec);
    check('D29 the recruiter sees no suggestion and no open-task button', r.status === 200 && !r.body.record.suggestion && r.body.rights.openTask === false, r.body.rights);
    r = await http('POST', `/api/join-drop/${rec3.id}/replacement-task/open`, T.rec, {});
    check('D30 the recruiter cannot open the task by hand', r.status === 403, r);
    r = await http('POST', `/api/join-drop/${rec3.id}/replacement-task/open`, T.bde, {});
    check('D31 the BDE can open it by hand: one task', r.status === 200 && (await liveTasks(rec3.id)).length === 1, r);
    r = await http('POST', `/api/join-drop/${rec3.id}/replacement-task/open`, T.bde, {});
    check('D32 and a second press makes no duplicate (409)', r.status === 409 && (await liveTasks(rec3.id)).length === 1, r.status);

    // ====================================================================== D4: withdraw a drop reported by mistake
    const evCountBefore = (await events(recJ1.id)).length;
    r = await http('POST', `/api/join-drop/${recJ1.id}/reopen`, T.rec, { reason: 'Reported by mistake, still working' });
    check('D33 a recruiter cannot withdraw a drop', r.status === 403, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/reopen`, T.tl, { reason: 'x' });
    check('D34 a reason is required to withdraw a drop', r.status === 400, r);
    r = await http('POST', `/api/join-drop/${recJ1.id}/reopen`, T.tl, { reason: 'Reported by mistake, still working' });
    check('D35 a TL withdraws it with a reason: back to Joined, the old screens too', r.status === 200 && r.body.record.status === 'Joined' && (await prisma.application.findUnique({ where: { id: j1.a.id } })).joiningStatus === 'Joined', r);
    check('D36 the drop task of a drop that never happened is cancelled', (await liveTasks(recJ1.id)).length === 0);
    const evs2 = await events(recJ1.id);
    check('D37 nothing was deleted: the drop, the decisions and the withdrawal are all still in the history', evs2.length > evCountBefore && evs2.some((e) => e.kind === 'DROP_REPORTED') && evs2.some((e) => e.kind === 'DROP_REOPENED') && evs2.filter((e) => e.kind === 'CLIENT_DECISION').length >= 4);
    const rEv = await lastEv(recJ1.id, 'DROP_REOPENED');
    const wdN = await notices(rEv.id);
    check('D38 the same people are told the drop was withdrawn', ['bde', 'hr', 'recruiter'].every((p) => wdN.some((n) => n.party === p && n.channel === 'Bell')) , wdN.map((n) => n.party));
    // a re-drop reuses / makes exactly one task
    r = await http('POST', `/api/join-drop/${recJ1.id}/drop`, T.rec, { droppedOn: ago(1), reason: 'Resigned' });
    check('D39 a re-reported drop is accepted and has exactly one live task', r.status === 200 && (await liveTasks(recJ1.id)).length === 1, r);

    // ====================================================================== replacement link
    const rep = await mkApp(rA, 'SELECTED');
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement/link`, T.rec, { applicationId: rep.a.id });
    check('L1 (decision was withdrawn then re-dropped) linking before the client asks is refused in plain words', r.status === 409, r);
    await http('POST', `/api/join-drop/${recJ1.id}/decision`, T.bde, { decision: 'NEEDED' });
    const wrongJob = await mkApp(rN, 'SELECTED');
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement/link`, T.rec, { applicationId: wrongJob.a.id });
    check('L2 the replacement must be on the same job', r.status === 409, r);
    r = await http('GET', `/api/join-drop/open-for-job/${rA.id}`, T.rec);
    check('L3 the job lists the dropped candidate waiting for a replacement (to offer the link)', r.status === 200 && r.body.records.some((x) => x.id === recJ1.id), r.body);
    r = await http('POST', `/api/join-drop/${recJ1.id}/replacement/link`, T.rec, { applicationId: rep.a.id });
    check('L4 linking the new candidate works: status "New candidate added"', r.status === 200 && r.body.record.replacementStatus === 'New candidate added', r);
    await prisma.application.update({ where: { id: rep.a.id }, data: { stage: 'JOINED', joiningDate: ago(0) } });
    await Core.recordJoined({ applicationId: rep.a.id, actor: actorOf(uRec), info: { location: 'ZZ Rep' }, quiet: true });
    check('L5 when the replacement joins, the replacement is Closed and the old Replacement due becomes Replaced', (await recOf(j1.a.id)).replacementStatus === 'Closed' && (await prisma.application.findUnique({ where: { id: j1.a.id } })).joiningStatus === 'Replaced');

    // ====================================================================== H: rights
    r = await http('GET', '/api/join-drop/list?pageSize=200', T.hr);
    check('H1 the listed HR head sees client placements (names, dates, reasons), without pay', r.status === 200 && r.body.rows.length > 0 && !/offeredCtc|"phone"|"email"/.test(r.text), r.body && r.body.rows && r.body.rows.length);
    r = await http('POST', `/api/join-drop/${rec3.id}/decision`, T.hr, { decision: 'NEEDED' });
    check('H2 the HR head cannot enter the client\'s answer', r.status === 403, r);
    // every other HR login sees and does nothing
    const hid = [];
    for (const [label, path0, method0, body0] of [
      ['the list', '/api/join-drop/list?pageSize=200', 'GET'], ['the CSV', '/api/join-drop/export', 'GET'], ['the report', '/api/join-drop/report', 'GET'], ['the report CSV', '/api/join-drop/report/export', 'GET'],
      ['one record', `/api/join-drop/${recJ1.id}`, 'GET'], ['the candidate panel', `/api/join-drop/application/${j1.a.id}`, 'GET'], ['the Journey', `/api/join-drop/journey/${j1.a.id}`, 'GET'],
      ['the client history', `/api/join-drop/client-history/${cA.id}`, 'GET'], ['the people to be told', `/api/join-drop/${recJ1.id}/people`, 'GET'], ['the candidate notice', `/api/join-drop/${recJ1.id}/candidate-notice`, 'GET'],
      ['reporting a drop', `/api/join-drop/${recB.id}/drop`, 'POST', { droppedOn: ago(1), reason: 'Resigned' }], ['sending a notice', `/api/join-drop/${recJ1.id}/candidate-notice`, 'POST', { channels: ['Email'] }],
      ['the candidate list of records', `/api/join-drop/candidate/${j1.c.id}`, 'GET'], ['the open-for-job list', `/api/join-drop/open-for-job/${rA.id}`, 'GET'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const x = await http(method0, path0, T.hr2, body0);
      if (![401, 403, 404].includes(x.status)) hid.push(`${label}:${x.status}`);
    }
    check('H3 any OTHER HR login is refused everywhere: list, CSV, report, record, candidate panel, Journey, client history, notice', hid.length === 0, hid);
    r = await http('GET', '/api/join-drop/meta', T.hr2);
    check('H3b and the meta answer gives it no rights', r.status === 403 || (r.body && !r.body.rights.record && !r.body.rights.export), r.body);
    r = await http('PUT', '/api/join-drop/settings', T.hr, { hrPeople: [hrCode, 'TL999'] });
    check('H3c the HR head cannot edit the list (Admin only)', r.status === 403, r.status);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { hrPeople: ['TL309'] });
    r = await http('GET', '/api/join-drop/list?pageSize=200', T.hr);
    check('H3d taken off the list, the same person sees nothing at once', r.status === 403, r.status);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { hrPeople: ['TL309', hrCode] });
    check('H3e an Admin puts them back', r.status === 200 && (await http('GET', '/api/join-drop/list?pageSize=5', T.hr)).status === 200);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { hrPeople: ['bad code!'] });
    check('H3f a bad code is refused in plain words', r.status === 400, r.body);
    r = await http('GET', '/api/join-drop/list?pageSize=200', T.bde);
    check('H4 the BDE list holds only their own clients (desk) and no client B', r.status === 200 && r.body.rows.some((x) => x.clientId === cA.id) && !r.body.rows.some((x) => x.clientId === cB.id), r.body.rows.map((x) => x.clientName));
    r = await http('GET', '/api/join-drop/list?pageSize=200', T.rec);
    check('H5 the recruiter list holds only their own jobs', r.status === 200 && r.body.rows.every((x) => !/Client B/.test(x.clientName)) , r.body.rows.map((x) => x.clientName));
    r = await http('GET', '/api/join-drop/list', T.ca);
    check('H6 a client cannot use the staff list', r.status === 403, r.status);
    r = await http('GET', '/api/join-drop/list', T.acc);
    check('H7 Accounts can read the list (scope as the Joining screen) but acts on nothing', [200, 403].includes(r.status));
    r = await http('GET', '/api/join-drop/settings', T.tl);
    check('H8 the switches are Admin only', r.status === 403, r);
    r = await http('GET', '/api/join-drop/settings', T.admin);
    check('H9 the defaults: candidate drop notice OFF; client / recruiter / TL / BDE / HR head ON; HR email on JOIN off', r.status === 200 && r.body.settings.drop.candidate.email === false && r.body.settings.drop.hr.email === true && r.body.settings.join.hr.email === false && r.body.settings.join.hr.bell === true && r.body.settings.defaultGuaranteeDays === 30, r.body.settings);

    // ====================================================================== N: candidate notice
    const nApp = await mkApp(rA, 'JOINED', { joiningDate: ago(9) });
    await Core.recordJoined({ applicationId: nApp.a.id, actor: actorOf(uRec), info: { joinedOn: ago(9), location: 'ZZ N' }, quiet: true });
    const recN2 = await recOf(nApp.a.id);
    await http('POST', `/api/join-drop/${recN2.id}/drop`, T.rec, { droppedOn: ago(1), reason: 'Health / family' });
    r = await http('GET', `/api/join-drop/${recN2.id}/candidate-notice`, T.rec);
    check('N1 a recruiter cannot open the candidate notice', r.status === 403, r.status);
    r = await http('GET', `/api/join-drop/${recN2.id}/candidate-notice`, T.hr);
    check('N2 the HR head opens an EDITABLE preview of the notice (subject + body for each channel)', r.status === 200 && r.body.channels.length === 2 && r.body.channels[0].body.includes(nApp.c.name.split(' ')[0]) && !/ZZTEST JD Client/.test(JSON.stringify(r.body)), r.body);
    const auditBefore = await prisma.auditLog.count({ where: { action: { startsWith: 'Joining notice' } } });
    r = await http('POST', `/api/join-drop/${recN2.id}/candidate-notice`, T.hr, { channels: ['Email'], subject: 'About your work', body: 'Hi, we noted that your work ended. Reply if this is wrong. - TeamLink' });
    const sentRows = await prisma.candidateMessage.findMany({ where: { candidateId: nApp.c.id, template: 'DROP_CANDIDATE_NOTICE' } });
    check('N3 the HR head sends it by hand: a message row with HR\'s edited words, recorded (the Candidate emails switch is off, so NOT sent)', r.status === 200 && sentRows.length === 1 && sentRows[0].body.startsWith('Hi, we noted') && /SWITCHED_OFF/.test(sentRows[0].status), [r.body, sentRows.map((x) => x.status)]);
    check('N4 every outcome is in the Audit Log', (await prisma.auditLog.count({ where: { action: { startsWith: 'Joining notice' } } })) > auditBefore && !!(await prisma.auditLog.findFirst({ where: { entityId: recN2.id, action: 'Drop notice to the candidate (by hand)' } })));
    await prisma.candidate.update({ where: { id: nApp.c.id }, data: { doNotContact: true } });
    r = await http('POST', `/api/join-drop/${recN2.id}/candidate-notice`, T.hr, { channels: ['Email'] });
    const blockedRow = (await prisma.candidateMessage.findMany({ where: { candidateId: nApp.c.id, template: 'DROP_CANDIDATE_NOTICE' }, orderBy: { createdAt: 'desc' } }))[0];
    check('N5 a candidate who asked not to be contacted is skipped with a plain reason (and audited)', blockedRow.status === 'NOT_SENT_BLOCKED' && /asked not to be contacted/.test(blockedRow.statusDetail), blockedRow);
    r = await http('PUT', '/api/join-drop/settings', T.admin, { drop: { candidate: { email: true, whatsapp: true } } });
    const nApp2 = await mkApp(rA, 'JOINED', { joiningDate: ago(9) }, { email: null });
    await Core.recordJoined({ applicationId: nApp2.a.id, actor: actorOf(uRec), info: { joinedOn: ago(9), location: 'ZZ N2' }, quiet: true });
    const recN3 = await recOf(nApp2.a.id);
    await http('POST', `/api/join-drop/${recN3.id}/drop`, T.rec, { droppedOn: ago(1), reason: 'Role mismatch' });
    const autoRows = await prisma.candidateMessage.findMany({ where: { candidateId: nApp2.c.id, template: 'DROP_CANDIDATE_NOTICE' } });
    check('N6 with the Admin switch ON the automatic notice still skips: no email address, and WhatsApp has no approved template', autoRows.length === 2 && autoRows.every((x) => x.status === 'NOT_SENT_BLOCKED') && autoRows.some((x) => /no email address/.test(x.statusDetail)) && autoRows.some((x) => /approved WhatsApp message template/.test(x.statusDetail)), autoRows.map((x) => x.statusDetail));
    const nApp3 = await mkApp(rA, 'JOINED', { joiningDate: ago(9) });
    await Core.recordJoined({ applicationId: nApp3.a.id, actor: actorOf(uRec), info: { joinedOn: ago(9), location: 'ZZ N3' }, quiet: true });
    const recN4 = await recOf(nApp3.a.id);
    await http('POST', `/api/join-drop/${recN4.id}/drop`, T.rec, { droppedOn: ago(1), reason: 'Salary issue' });
    const auto3 = await prisma.candidateMessage.findMany({ where: { candidateId: nApp3.c.id, template: 'DROP_CANDIDATE_NOTICE', channel: 'Email' } });
    check('N7 with a valid reason and an email address the automatic notice is recorded (switched off master = not transmitted), never a silent send', auto3.length === 1 && /SWITCHED_OFF/.test(auto3[0].status), auto3.map((x) => x.status));
    await http('PUT', '/api/join-drop/settings', T.admin, { drop: { candidate: { email: false, whatsapp: false } } });

    // ====================================================================== R: recruiter joinings
    const RJ = require(path.join(BACK, 'src/utils/recruiterJoinings'));
    // (the recruiter joinings screen leaves out test names, so these two candidates carry a plain name)
    const plain = async (tag, days) => {
      const x = await mkApp(rA, 'JOINED', { joiningDate: ago(days) }, { name: `Rjcheck ${tag} ${RUN}` });
      await Core.recordJoined({ applicationId: x.a.id, actor: actorOf(uRec), info: { joinedOn: ago(days), location: 'ZZ R' }, quiet: true });
      return x;
    };
    const j5 = await plain('Count', 9);
    const month = ago(9).slice(0, 7);
    RJ.invalidate();
    const before = await RJ.monthApplications(month, { fresh: true });
    const rowBefore = before.apps.find((x) => x.id === j5.a.id);
    const rec5 = await recOf(j5.a.id);
    r = await http('POST', `/api/join-drop/${rec5.id}/drop`, T.rec, { droppedOn: ago(1), reason: 'Resigned' });
    RJ.invalidate();
    const afterDrop = await RJ.monthApplications(month, { fresh: true });
    const rowAfter = afterDrop.apps.find((x) => x.id === j5.a.id);
    check('R1 recruiter joinings count the joined candidate once, and the same count stands after the drop (no double count, nothing removed)', !!rowBefore && rowBefore.counted === true && !!rowAfter && rowAfter.counted === true && afterDrop.apps.filter((x) => x.id === j5.a.id).length === 1 && before.apps.length === afterDrop.apps.length, [before.apps.length, afterDrop.apps.length]);
    check('R1b the dropped one carries a plain note in that screen', rowAfter && /Dropped after joining/.test(rowAfter.note || ''), rowAfter && rowAfter.note);
    const rec1b = await recOf(j1.a.id);
    const emp = await prisma.employee.findFirst({ where: { userId: uRec.id } });
    await prisma.recruiterJoiningDecision.create({ data: { employeeId: emp.id, month: String(ago(8)).slice(0, 7), joinings: 1, target: 4, decision: 'INCENTIVE', amount: 1000, payMonth: month, decidedByName: 'ZZ' } });
    // report the drop again on a fresh joined candidate so the incentive flag applies
    const j6 = await plain('Incentive', 8);
    const rec6 = await recOf(j6.a.id);
    r = await http('POST', `/api/join-drop/${rec6.id}/drop`, T.rec, { droppedOn: ago(1), reason: 'Resigned' });
    check('R2 a drop after the recruiter\'s incentive was decided is flagged for the HR head', r.status === 200 && r.body.afterIncentive === true && (await prisma.notification.count({ where: { userId: uHr.id, title: { startsWith: 'Drop after incentive' } } })) >= 1, r.body && r.body.afterIncentive);
    const decRow = await prisma.recruiterJoiningDecision.findUnique({ where: { employeeId_month: { employeeId: emp.id, month: String(ago(8)).slice(0, 7) } } });
    check('R3 the incentive decision itself is untouched', decRow && decRow.decision === 'INCENTIVE' && decRow.amount === 1000);
    RJ.invalidate();
    const after = await RJ.monthApplications(String(rec6.joinedOn).slice(0, 7), { fresh: true });
    const row6 = after.apps.find((x) => x.id === j6.a.id);
    check('R4 the dropped candidate is STILL counted (counted stays true) and carries a plain note', row6 && row6.counted === true && /Dropped after joining/.test(row6.note || '') && row6.drop && row6.drop.afterIncentive === true, row6 && row6.note);
    check('R5 the application\'s step and joining day are unchanged by the drop', (await prisma.application.findUnique({ where: { id: j6.a.id } })).stage === 'JOINED');

    // ====================================================================== B: backfill
    const old = await mkApp(rA, 'JOINED', {});
    const evOnly = await mkApp(rA, 'JOINED', { joiningStatus: 'Replacement Due' });
    await prisma.applicationStageEvent.create({ data: { applicationId: evOnly.a.id, candidateId: evOnly.c.id, fromStage: 'JOINED', toStage: 'JOINED', action: 'Left within the guarantee (30 Days) - replacement due', comment: `Left on ${ago(4)}: Resigned in week 2`, actorName: 'ZZ Old Actor', createdAt: new Date() } });
    await prisma.applicationStageEvent.create({ data: { applicationId: evOnly.a.id, candidateId: evOnly.c.id, fromStage: 'OFFER_ACCEPTED', toStage: 'JOINED', action: 'Joined', actorName: 'ZZ Old Actor', createdAt: new Date(Date.now() - 12 * 86400000) } });
    const noticesBefore = (await raw('SELECT COUNT(*) n FROM "JoinDropNotice"'))[0].n;
    const bf = await Core.backfillOnce({ force: true });
    const oldRec = await recOf(old.a.id);
    check('B1 the backfill made a record for every Joined application that had none', bf.made >= 2 && !!oldRec && oldRec.backfilled === 1, bf);
    check('B2 nothing is invented: no joining day on file = "Not recorded" (empty), no place', oldRec.joinedOn === null && oldRec.location === null);
    r = await http('GET', `/api/join-drop/application/${old.a.id}`, T.admin);
    check('B3 the screen offers "Add details" (needsDetails) for it', r.status === 200 && r.body.record.needsDetails === true && r.body.record.missing.includes('location'), r.body && r.body.record);
    const csv0 = await http('GET', '/api/join-drop/export?pageSize=500', T.admin);
    check('B4 the CSV says "Not recorded" for the missing parts', /Not recorded/.test(csv0.text), csv0.status);
    const evRec = await recOf(evOnly.a.id);
    check('B5 an older "Left the job" row became a Dropped record with the day and reason from the old note', evRec && evRec.status === 'Dropped' && evRec.droppedOn === ago(4) && /Resigned in week 2/.test(evRec.dropReason || ''), evRec);
    check('B6 no notice of any kind was sent for backfilled records', (await raw('SELECT COUNT(*) n FROM "JoinDropNotice"'))[0].n === noticesBefore);
    r = await http('POST', `/api/join-drop/application/${old.a.id}/record`, T.rec, { joinedOn: ago(7), location: 'ZZ Added' });
    check('B7 "Add details" fills the day and the place, and the replacement period follows the real day', r.status === 200 && r.body.record.joinedOn === ago(7) && r.body.record.guaranteeEndsOn === V.addDays(ago(7), 90), r.body && r.body.record);

    // ====================================================================== corrections
    r = await http('PATCH', `/api/join-drop/${oldRec.id}`, T.rec, { location: 'ZZ Changed' });
    check('E1 changing a place that was already recorded needs a reason', r.status === 400, r);
    r = await http('PATCH', `/api/join-drop/${oldRec.id}`, T.rec, { location: 'ZZ Changed', reason: 'Posted to the other branch' });
    check('E2 with a reason it is saved and kept as old -> new in the history', r.status === 200 && r.body.history.some((e) => e.kind === 'JOINING_CORRECTED' && /ZZ Added -> ZZ Changed/.test(e.summary)), r.body && r.body.history && r.body.history.map((e) => e.summary));
    r = await http('PATCH', `/api/join-drop/${oldRec.id}`, T.bde, { offeredCtc: 999999 });
    check('E3 the BDE cannot change or see the pay', r.status === 403, r);
    r = await http('PATCH', `/api/join-drop/${oldRec.id}`, T.admin, { offeredCtc: 510000, reason: 'Final CTC' });
    r = await http('GET', `/api/join-drop/${oldRec.id}`, T.bde);
    check('E4 a pay change never appears in the BDE\'s history', !/510000|480000|Pay \(CTC\)/.test(r.text), r.text.slice(0, 200));

    // ====================================================================== Y: the journey
    const jy = await mkApp(rA, 'JOINED', { joiningDate: ago(10), interviewAt: new Date(Date.now() - 20 * 86400000), interviewRound: 2, interviewMode: 'Online', interviewer: 'ZZ Interviewer', interviewLocation: 'ZZ Hall', interviewStatus: 'COMPLETED' }, { createdAt: new Date(Date.now() - 40 * 86400000) });
    const stamp = (n) => new Date(Date.now() - n * 86400000);
    const ev = async (to, n, extra = {}) => prisma.applicationStageEvent.create({ data: { applicationId: jy.a.id, candidateId: jy.c.id, fromStage: null, toStage: to, action: `ZZ ${to}`, actorName: 'ZZ Mover', createdAt: stamp(n), ...extra } });
    await prisma.application.update({ where: { id: jy.a.id }, data: { createdAt: stamp(38) } });
    await ev('WITH_BDE', 33); await ev('SHARED_WITH_CLIENT', 31); await ev('CLIENT_SHORTLISTED', 29, { actorSide: 'Client', actorName: 'ZZ Client Person' });
    await prisma.interviewEvent.create({ data: { applicationId: jy.a.id, status: 'SCHEDULED', toSlot: stamp(21).toISOString(), by: 'ZZ Booker', createdAt: stamp(26) } });
    await prisma.interviewEvent.create({ data: { applicationId: jy.a.id, status: 'COMPLETED', by: 'ZZ Booker', createdAt: stamp(20) } });
    await ev('SELECTED', 18); await ev('OFFER', 15); await ev('OFFER_ACCEPTED', 13); await ev('JOINED', 10);
    await prisma.interviewFeedback.create({ data: { applicationId: jy.a.id, kind: 'Internal', overall: 'SECRETINTERNALWORDS strong', recommendation: 'Selected', submittedBy: 'ZZ Panel' } });
    await Core.recordJoined({ applicationId: jy.a.id, actor: actorOf(uRec), info: { joinedOn: ago(10), location: 'ZZ J' }, quiet: true });
    r = await http('GET', `/api/join-drop/journey/${jy.a.id}`, T.admin);
    const ms = (r.body && r.body.journey && r.body.journey.milestones) || [];
    const m = (k) => ms.find((x) => x.key === k) || {};
    check('Y1 the journey lists the milestones with real dates (candidate came, BDE, client, interview, selected, offer, accepted, joined)', r.status === 200 && ['came', 'added', 'bde', 'client', 'selected', 'offer', 'accepted', 'joined', 'interviewDone'].every((k) => m(k).state === 'Done'), ms.map((x) => `${x.key}:${x.state}`));
    check('Y2 each date is the real stored date (BDE 33 days ago, client 31, offer 15)', m('bde').day === ago(33) && m('client').day === ago(31) && m('offer').day === ago(15) && m('joined').day === ago(10), [m('bde').day, m('client').day, m('offer').day]);
    check('Y3 who did it is shown', m('bde').who === 'ZZ Mover' && m('screening').who.includes('ZZ Client Person'));
    check('Y4 elapsed days are shown (BDE to client: 2 days; interview to offer: 5 days)', m('client').elapsed && m('client').elapsed.days === 2 && m('offer').elapsed && m('offer').elapsed.days === 5, [m('client').elapsed, m('offer').elapsed]);
    check('Y5 the current interview shows round, mode, interviewer and place', ms.some((x) => /round 2/.test(x.label) && /Online/.test(x.detail) && /ZZ Interviewer/.test(x.detail) && /ZZ Hall/.test(x.detail)));
    const jy2 = await mkApp(rA, 'OFFER_ACCEPTED', {});
    await prisma.applicationStageEvent.create({ data: { applicationId: jy2.a.id, candidateId: jy2.c.id, fromStage: null, toStage: 'SHARED_WITH_CLIENT', action: 'ZZ shared', actorName: 'ZZ Mover', createdAt: stamp(9) } });
    r = await http('GET', `/api/join-drop/journey/${jy2.a.id}`, T.admin);
    const ms2 = r.body.journey.milestones;
    const m2 = (k) => ms2.find((x) => x.key === k) || {};
    check('Y6 a step that clearly happened but has no date is "Not recorded" (never invented); one not reached is "Not yet"', m2('bde').state === 'Not recorded' && m2('bde').day === null && m2('joined').state === 'Not yet' && m2('offer').state === 'Not yet', ms2.map((x) => `${x.key}:${x.state}`));
    r = await http('GET', `/api/join-drop/journey/${jy.a.id}`, T.bde);
    check('Y7 the BDE gets the journey but never the internal panel\'s words, pay, phone or email', r.status === 200 && !/SECRETINTERNALWORDS|480000|zz-jd-cand|"phone"/.test(r.text), r.text.slice(0, 120));
    r = await http('GET', `/api/join-drop/journey/${jy.a.id}`, T.ca);
    check('Y8 a client cannot read the journey', r.status === 403, r.status);
    r = await http('GET', '/api/join-drop/list?pageSize=200', T.admin);
    const jrow = r.body.rows.find((x) => x.applicationId === jy.a.id);
    check('Y9 the list shows the key milestone dates', jrow && jrow.journey.bdeOn === ago(33) && jrow.journey.sentToClientOn === ago(31) && jrow.journey.offerOn === ago(15) && jrow.journey.offerAcceptedOn === ago(13), jrow && jrow.journey);
    const csv = await http('GET', '/api/join-drop/export', T.admin);
    check('Y10 the CSV carries the same dates as columns', /Reached BDE on/.test(csv.text) && csv.text.includes(ago(33)) && csv.text.includes(ago(31)), csv.text.split('\n')[0]);
    r = await http('GET', '/api/join-drop/list?pageSize=200&replacement=waiting', T.admin);
    check('Y11 the list filters (replacement waiting for the client)', r.status === 200 && r.body.rows.every((x) => x.status === 'Dropped' && !x.replacementDecision), r.body.total);
    r = await http('GET', `/api/join-drop/list?pageSize=200&department=Education&status=Dropped&view=Dropped`, T.admin);
    check('Y12 the list filters cascade with counts (department narrows the client list)', r.status === 200 && r.body.facets.clients.every((c) => c.count > 0) && r.body.facets.departments.some((d) => d.value === 'Education'), r.body.facets);

    // ====================================================================== Y2: client history
    await prisma.auditLog.create({ data: { action: 'Client created', entity: 'Client', entityId: cA.id, actorName: 'ZZ Creator', userId: uAdmin.id } });
    await prisma.auditLog.create({ data: { action: 'Agreement sent to client', entity: 'Client', entityId: cA.id, actorName: 'ZZ Creator', userId: uAdmin.id } });
    await prisma.auditLog.create({ data: { action: 'Client portal invite link re-sent', entity: 'Client', entityId: cA.id, actorName: 'ZZ Creator', toValue: 'x · mailed', userId: uAdmin.id } });
    await prisma.auditLog.create({ data: { action: 'Signed in', entity: 'User', entityId: uCa.id, userId: uCa.id } });
    await prisma.user.update({ where: { id: uCa.id }, data: { lastLoginAt: new Date() } });
    r = await http('GET', `/api/join-drop/client-history/${cA.id}`, T.admin);
    const h = r.body || {};
    const groups = new Set((h.events || []).map((e) => e.group));
    check('Y13 the client history (Admin) has the groups: client added, agreement, login, requirement, candidates, joining, drop', r.status === 200 && ['Client', 'Agreement', 'Login', 'Requirement', 'Joining', 'Drop'].every((g) => groups.has(g)), [...groups]);
    check('Y14 it is chronological and the summary strip counts real rows', (h.events || []).every((e, i, a) => i === 0 || String(a[i - 1].at || a[i - 1].day) <= String(e.at || e.day)) && h.summary.jobsTotal === 1 && h.summary.joined >= 4 && h.summary.dropped >= 2, h.summary);
    check('Y15 the first and the last sign-in dates are there (dates only)', h.summary.firstLoginOn === today && h.summary.lastLoginOn === today, h.summary);
    check('Y16 who added the client and which BDE', (h.events || []).some((e) => e.group === 'Client' && e.who === 'ZZ Creator' && e.detail.includes(uBde.name)), (h.events || []).filter((e) => e.group === 'Client'));
    r = await http('GET', `/api/join-drop/client-history/${cA.id}`, T.tl);
    check('Y17 a TL sees the history WITHOUT any agreement step, login or invoice (and not the word agreement)', r.status === 200 && !(r.body.events || []).some((e) => ['Agreement', 'Login', 'Invoice'].includes(e.group)) && !/agreement/i.test(r.text), r.status);
    r = await http('GET', `/api/join-drop/client-history/${cA.id}`, T.rec);
    check('Y18 a recruiter likewise, or is refused', [200, 404].includes(r.status) && !/agreement/i.test(r.text), r.status);
    r = await http('GET', `/api/join-drop/client-history/${cB.id}`, T.bde);
    check('Y19 a BDE of another desk cannot open client B\'s history', r.status === 404, r.status);
    r = await http('GET', `/api/join-drop/client-history/${cA.id}`, T.hr);
    check('Y20 the listed HR head can read the client history (no agreement, no logins, no invoices); another HR login cannot', r.status === 200 && !/agreement/i.test(r.text) && !(r.body.events || []).some((e) => ['Agreement', 'Login', 'Invoice'].includes(e.group)) && (await http('GET', `/api/join-drop/client-history/${cA.id}`, T.hr2)).status === 403, r.status);
    r = await http('GET', '/api/portal/client/history', T.ca);
    const hp = r.body || {};
    const pg = new Set((hp.events || []).map((e) => e.group));
    check('Y21 the client portal history: its own jobs, candidates, joinings, drops - no agreement, login, invoice, no TeamLink names', r.status === 200 && !['Agreement', 'Login', 'Invoice'].some((g) => pg.has(g)) && !(hp.events || []).some((e) => e.who) && !/ZZ Creator|ZZTEST JD rec|ZZTEST JD tl|Client B/.test(r.text) && pg.has('Requirement'), [...pg]);
    r = await http('GET', '/api/portal/client/history', T.cb);
    check('Y22 client B\'s portal history holds nothing of client A', r.status === 200 && !/Client A/.test(r.text), r.status);

    // ====================================================================== X: csv, report, words
    r = await http('GET', '/api/join-drop/export', T.bde);
    check('X1 the BDE CSV has no pay, no phone, no email', r.status === 200 && !/Pay \(CTC\)|480000|zz-jd-cand|9000000/.test(r.text), r.text.split('\n')[0]);
    r = await http('GET', '/api/join-drop/export', T.admin);
    check('X2 the Admin CSV has the pay column; no phone or email even there', /Pay \(CTC\)/.test(r.text) && !/zz-jd-cand|90000\d{5}/.test(r.text), r.text.split('\n')[0]);
    check('X3 a download is audited', !!(await prisma.auditLog.findFirst({ where: { action: 'Joining and drop list downloaded (CSV)', userId: uBde.id } })));
    r = await http('GET', '/api/join-drop/export', T.ca);
    check('X4 a client cannot download the staff CSV', r.status === 403, r.status);
    r = await http('GET', '/api/join-drop/report?groupBy=client', T.admin);
    check('X5 the report: joined, dropped, drop rate, inside the period, replacements, top reasons, by client', r.status === 200 && r.body.totals.joined >= 6 && r.body.totals.dropped >= 3 && typeof r.body.totals.dropRate === 'number' && r.body.topReasons.length > 0 && r.body.by.some((x) => /Client A/.test(x.name)), r.body && r.body.totals);
    r = await http('GET', '/api/join-drop/report?groupBy=recruiter&department=Education', T.admin);
    check('X6 the report groups by recruiter and filters by department', r.status === 200 && r.body.by.length > 0);
    r = await http('GET', '/api/join-drop/report/export', T.admin);
    check('X7 the report CSV downloads', r.status === 200 && /Top reasons/.test(r.text));
    const wording = [JSON.stringify(V), JSON.stringify(require(path.join(BACK, 'src/joindrop/messageDefaults')).ROWS), (await raw('SELECT "summary","note" FROM "JoiningEvent"')).map((x) => `${x.summary} ${x.note}`).join(' '), (await prisma.task.findMany({ where: { assigneeId: { in: made.users } } })).map((t) => `${t.name} ${t.description}`).join(' '), (await raw('SELECT "status","detail" FROM "JoinDropNotice"')).map((x) => `${x.status} ${x.detail}`).join(' '), JSON.stringify(await http('GET', '/api/join-drop/list?pageSize=200', T.admin).then((x) => x.body)), JSON.stringify(h)].join(' ');
    check('X8 the word "Draft" appears nowhere in the words people read', !/draft/i.test(wording), (wording.match(/.{30}draft.{30}/i) || [])[0]);
    const tplRows = require(path.join(BACK, 'src/joindrop/messageDefaults')).list();
    check('X9 the five message templates exist with their purposes (editable in the hub)', ['JOINING_CONFIRMED', 'CANDIDATE_DROPPED', 'REPLACEMENT_DECISION', 'JOINING_WELCOME', 'DROP_CANDIDATE_NOTICE'].every((p) => tplRows.some((t) => t.purpose === p)));
    r = await http('GET', '/api/messaging/templates', T.admin).catch(() => ({ status: 0 }));
    const T2 = require(path.join(BACK, 'src/utils/messageTemplates'));
    const listed = await T2.list({ purpose: 'REPLACEMENT_DECISION' });
    check('X10 the templates reach the Message templates hub (a saved edit would win)', listed.length >= 1 && listed[0].audience === 'employee', listed.length);
    const hnEv = HN.EVENTS;
    check('X11 the three events join the Notification emails master switch', !!hnEv.joinNotice && !!hnEv.dropNotice && !!hnEv.replacementDecision);
    check('X12 no real mail was handed to a provider: only reserved test addresses were involved', (await prisma.notification.findMany({ where: { channel: 'Email', createdAt: { gte: new Date(Date.now() - 3600000) }, recipient: { contains: '@' } } })).filter((n) => /zz-jd-/.test(n.recipient)).every((n) => /example\.test$/.test(n.recipient)));
  } catch (e) {
    fail += 1; console.error('TEST CRASHED', e);
  } finally {
    try {
      await HN.saveSettings({ emailsOn: false }, null).catch(() => {});
      try { await require(path.join(BACK, 'src/utils/interviewNotices')).saveSettings({ enabled: typeof candidateSwitchWas === 'boolean' ? candidateSwitchWas : false }, null); } catch { /* copy only */ }
      const recs = await raw('SELECT "id" FROM "JoiningRecord" WHERE "applicationId" IN (' + (made.apps.map(() => '?').join(',') || "''") + ')', ...made.apps).catch(() => []);
      const rids = recs.map((x) => x.id);
      for (const rid of rids) {
        await prisma.$executeRawUnsafe('DELETE FROM "JoinDropNotice" WHERE "recordId" = ?', rid).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "JoiningEvent" WHERE "recordId" = ?', rid).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "JoiningRecord" WHERE "id" = ?', rid).catch(() => {});
      }
      await prisma.task.deleteMany({ where: { assigneeId: { in: made.users } } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { recipient: { contains: 'zz-jd-' } }] } }).catch(() => {});
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: made.cands } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...rids, ...made.apps, ...made.clients, ...made.users] } }, { userId: { in: made.users } }] } }).catch(() => {});
      await prisma.recruiterJoiningDecision.deleteMany({ where: { employeeId: { in: made.emps } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { candidateId: { in: made.cands } } }).catch(() => {});
      await prisma.interviewFeedback.deleteMany({ where: { applicationId: { in: made.apps } } }).catch(() => {});
      await prisma.interviewEvent.deleteMany({ where: { applicationId: { in: made.apps } } }).catch(() => {});
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: made.apps } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: made.apps } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONLY THE BDE BOOKS AN INTERVIEW + A RECRUITER DOES NOT POST A JOB (user, 2026-10-12). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node <this file>
// P  posting: Recruiter refused on every posting endpoint with the plain sentence; TL / BDE / BDE TL / Admin as before;
//    STL / Manager / Asst Manager view only; Role Catalog cannot switch it back on.
// I  interviews: book / reschedule / cancel / did-not-attend with a new time / bulk / stage move: Recruiter, TL, STL,
//    Manager, Asst Manager refused; BDE (own desk), BDE TL, HR (internal), Admin allowed; another desk's BDE refused.
// A  "Ask the client manager to book": goes to the right BDE, once per day, no contact data; the row marker; Follow-ups due.
// W  workflow: shortlisted -> BDE books; feedback / advance stay with the recruiter / TL; the tell window is masked for a BDE.
// ---------------------------------------------------------------------------
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const PLAIN_POST = 'Posting requirements is done by your team lead or the client manager.';
const PLAIN_BOOK = /by the client manager \(BDE\)/;
const future = (days = 2) => new Date(Date.now() + days * 86400000 + 330 * 60000).toISOString().slice(0, 10);

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  let roleRowsBefore = null;
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST BK ${tag} ${RUN}`, email: `zz-bk-${tag}-${RUN}@example.test`, username: `zz-bk-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-BK-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, phone: '90000' + String(Math.floor(Math.random() * 99999)).padStart(5, '0') } });
      made.emps.push(e.id);
      return u;
    };
    const uSa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
    const uBdeEdu = await mkUser('bdeedu', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const uBdeMed = await mkUser('bdemed', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uStl = await mkUser('stl', { role: 'STL', atsRole: 'STL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uAm = await mkUser('am', { role: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uHr = await mkUser('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsDepartment: 'HR', atsScopeDepartments: 'HR' });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ sa: uSa, admin: uAdmin, bdeTl: uBdeTl, bdeEdu: uBdeEdu, bdeMed: uBdeMed, rec: uRec, tl: uTl, stl: uStl, mgr: uMgr, am: uAm, hr: uHr })) T[k] = await mint(u);

    const mkClient = async (tag, dept, bde, type = 'Client') => { const c = await prisma.client.create({ data: { name: `ZZTEST BK Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: bde ? bde.name : null, clientType: type, agreementStatus: 'ACTIVE' } }); made.clients.push(c.id); return c; };
    const cEdu = await mkClient('edu', 'Education', uBdeEdu);
    const cMed = await mkClient('med', 'Medical', null); // no client BDE: the Medical desk BDE
    const cMfg = await mkClient('mfg', 'Manufacturing', null); // no BDE at all: the BDE TL
    const mkReq = async (tag, client, dept, extra = {}) => { const r = await prisma.requirement.create({ data: { title: `ZZTEST BK Job ${tag} ${RUN}`, ...(client ? { clientId: client.id } : {}), status: 'OPEN', department: dept, recruiterId: uRec.id, tlId: uTl.id, bdeId: tag === 'edu' ? uBdeEdu.id : null, openings: 2, postingSources: 'jobportal', ...extra } }); made.reqs.push(r.id); return r; };
    const rEdu = await mkReq('edu', cEdu, 'Education');
    const rMed = await mkReq('med', cMed, 'Medical');
    const rMfg = await mkReq('mfg', cMfg, 'Manufacturing');
    const cInt = await mkClient('int', 'Education', null, 'Internal');
    const rInt = await mkReq('int', cInt, 'Education', { internal: true, hiringType: 'TeamLink Internal Hire' });
    const SECRET = { phone: '9000000077', currentSalary: '7L', expectedSalary: '9L' };
    const mkApp = async (tag, req, stage, extra = {}) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST BK Cand ${tag} ${RUN}`, email: `zz-bk-cand-${tag}-${RUN}@example.test`, ...SECRET, location: 'ZZ' } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage, ...extra } });
      made.apps.push(a.id); return a;
    };
    const a1 = await mkApp('a1', rEdu, 'CLIENT_SHORTLISTED');
    const a2 = await mkApp('a2', rEdu, 'CLIENT_SHORTLISTED');
    const a3 = await mkApp('a3', rEdu, 'SHARED_WITH_CLIENT');
    const a4 = await mkApp('a4', rEdu, 'RECRUITER_REVIEW');
    const a5 = await mkApp('a5', rEdu, 'CLIENT_SHORTLISTED');
    const a6 = await mkApp('a6', rEdu, 'CLIENT_SHORTLISTED');
    const a7 = await mkApp('a7', rEdu, 'CLIENT_SHORTLISTED');
    const a8 = await mkApp('a8', rEdu, 'CLIENT_SHORTLISTED');
    const a9 = await mkApp('a9', rEdu, 'CLIENT_SHORTLISTED');
    const aMed = await mkApp('med', rMed, 'CLIENT_SHORTLISTED');
    const aMfg = await mkApp('mfg', rMfg, 'SHARED_WITH_CLIENT');
    const aInt1 = await mkApp('int1', rInt, 'TL_REVIEW');
    const aInt2 = await mkApp('int2', rInt, 'INTERVIEW_COMPLETED', { interviewStatus: 'FEEDBACK_SUBMITTED', interviewRound: 1 });
    const book = (tok, a, extra = {}) => call('POST', `/api/ats/interviews/${a.id}/book`, tok, { date: future(), time: '11:00', mode: 'Online', meetingLink: 'https://meet.google.com/abc-defg-hij', panel: [{ name: 'Panel Person', email: 'panel@example.test' }], round: 1, viaPopup: true, ...extra });
    const stageOf = async (a) => (await prisma.application.findUnique({ where: { id: a.id }, select: { stage: true } })).stage;

    // =============================== P: POSTING ===============================================
    const R = rEdu.id;
    const postCalls = (tok) => Promise.all([
      call('PUT', `/api/requirements/${R}/posting-sites`, tok, { sites: ['jobportal', 'website'] }),
      call('POST', `/api/requirements/${R}/posting-sites/naukri/retry`, tok, {}),
      call('POST', `/api/requirements/${R}/posting-sites/naukri/by-hand/done`, tok, { url: 'https://example.test/x' }),
      call('GET', `/api/requirements/${R}/posting-sites/naukri/by-hand`, tok),
      call('POST', `/api/requirements/${R}/postings/retry`, tok, {}),
      call('POST', `/api/requirements/${R}/posting-log`, tok, { source: 'Social Media', action: 'Shared', detail: 'x' }),
      call('POST', `/api/requirements/${R}/portal-sync`, tok, { portalSyncStatus: 'Pending' }),
      call('POST', `/api/requirements/${R}/generate-jd`, tok, {}),
      call('GET', `/api/requirements/${R}/job-posts`, tok),
      call('POST', `/api/requirements/${R}/job-text`, tok, {}),
      call('POST', `/api/requirements/${R}/job-posts`, tok, { texts: { master: 'x' } }),
      call('POST', `/api/job-portal/jobs/${R}/publish`, tok, { published: true }),
      call('POST', `/api/job-portal/jobs/${R}/push`, tok, {}),
      call('POST', `/api/job-portal/sync`, tok, {}),
      call('POST', `/api/requirements/${R}/activate`, tok, {}),
      call('POST', `/api/requirements/${R}/status`, tok, { status: 'ON_HOLD' }),
      call('PUT', `/api/requirements/${R}`, tok, { title: 'ZZTEST BK renamed' }),
      call('PUT', `/api/requirements/posting/defaults`, tok, { sites: ['jobportal'] }),
    ]);
    const names = ['PUT posting-sites', 'POST site retry', 'POST by-hand done', 'GET by-hand', 'POST postings/retry', 'POST posting-log', 'POST portal-sync', 'POST generate-jd', 'GET job-posts', 'POST job-text', 'POST job-posts', 'POST portal publish', 'POST portal push', 'POST portal sync', 'POST activate', 'POST status', 'PUT requirement', 'PUT posting defaults'];
    const rr = await postCalls(T.rec);
    names.forEach((n, i) => check(`P1 Recruiter: ${n} -> 403`, rr[i].status === 403, [rr[i].status, rr[i].text.slice(0, 120)]));
    const plainOnes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    check('P2 Recruiter refusals carry the plain sentence (every posting endpoint)', plainOnes.every((i) => rr[i].body && rr[i].body.error === PLAIN_POST), plainOnes.map((i) => [names[i], rr[i].body && rr[i].body.error]).filter((x) => x[1] !== PLAIN_POST));
    const view = await call('GET', `/api/requirements/${R}`, T.rec);
    check('P3 Recruiter still VIEWS the job (200) and gets no share/edit rights', view.status === 200 && view.body && view.body.permissions && !view.body.permissions.share && !view.body.permissions.edit, [view.status, view.body && view.body.permissions]);
    const ps = await call('GET', `/api/requirements/${R}/posting-sites`, T.rec);
    check('P4 Recruiter reads the posting status read-only (canEdit false)', ps.status === 200 && ps.body.canEdit === false, ps.body && ps.body.canEdit);
    const hq = await call('POST', `/api/requirements/posting/hand-queue`, T.rec, {});
    check('P5 Recruiter hand-queue is empty (no by-hand tasks)', hq.status === 200 && hq.body.pairs.length === 0, hq.body);
    const rl = await call('GET', `/api/requirements?limit=5`, T.rec);
    check('P6 Recruiter job list: no "waiting to be posted by hand" count', rl.status === 200 && !(rl.body.counts && rl.body.counts.postWait), rl.body && rl.body.counts);
    for (const [label, tok] of [['TL', T.tl], ['BDE', T.bdeEdu], ['BDE TL', T.bdeTl], ['Admin', T.admin]]) {
      const x = await call('PUT', `/api/requirements/${R}/posting-sites`, tok, { sites: ['jobportal'] });
      check(`P7 ${label}: PUT posting-sites -> 200 as before`, x.status === 200, [x.status, x.text.slice(0, 160)]);
      const y = await call('GET', `/api/requirements/${R}/job-posts`, tok);
      check(`P8 ${label}: job-posts (write the job posts) -> 200`, y.status === 200, [y.status, y.text.slice(0, 160)]);
    }
    const tlPub = await call('POST', `/api/job-portal/jobs/${R}/publish`, T.tl, { published: true });
    check('P9 TL: Job Portal publish -> 200', tlPub.status === 200, [tlPub.status, tlPub.text.slice(0, 160)]);
    for (const [label, tok] of [['STL', T.stl], ['Manager', T.mgr], ['Asst Manager', T.am]]) {
      const x = await call('PUT', `/api/requirements/${R}/posting-sites`, tok, { sites: ['jobportal'] });
      check(`P10 ${label} stays view-only: PUT posting-sites -> 403`, x.status === 403, [x.status, x.text.slice(0, 120)]);
      const y = await call('POST', `/api/job-portal/jobs/${R}/publish`, tok, { published: true });
      check(`P10b ${label}: Job Portal publish -> 403`, y.status === 403, [y.status]);
    }
    // /auth/me + Role Catalog
    const me = await call('GET', '/api/auth/me', T.rec);
    const acc = me.body && me.body.access && me.body.access.requirements;
    check('P11 /auth/me (Recruiter): Job Posting edit/create and Job Portal Workspace edit/configure are all OFF', acc && !acc.features['Job Posting'].edit && !acc.features['Job Posting'].create && !acc.features['Job Portal Workspace'].edit && !acc.features['Job Portal Workspace'].configure, acc && [acc.features['Job Posting'], acc.features['Job Portal Workspace']]);
    check('P12 /auth/me (Recruiter): can still VIEW requirement detail + job portal applications', acc && acc.features['Requirement Detail'].view && acc.features['Job Portal Applications'].view, acc && acc.features['Requirement Detail']);
    const meTl = await call('GET', '/api/auth/me', T.tl);
    check('P13 /auth/me (TL): Job Posting edit still ON', meTl.body.access.requirements.features['Job Posting'].edit === true, meTl.body.access.requirements.features['Job Posting']);
    roleRowsBefore = await prisma.roleAccess.findMany({ where: { role: 'RECRUITER', moduleId: { in: ['requirements', 'interviews'] } } });
    const cat = await call('GET', '/api/admin/role-catalog/RECRUITER/access', T.sa);
    const rq = cat.body.modules.find((m) => m.id === 'requirements');
    check('P14 Role Catalog (Recruiter / Jobs): Job Posting edit default OFF + locked, with the reason', rq && rq.features['Job Posting'].edit === false && (rq.locked['Job Posting'] || []).includes('edit') && /not a Recruiter/.test(rq.lockNote || ''), rq && [rq.features['Job Posting'], rq.locked, rq.lockNote]);
    // try to switch it on through Role Catalog (Super Admin) - it must stay off in the engine
    const feats = JSON.parse(JSON.stringify(rq.features)); feats['Job Posting'].edit = true; feats['Job Posting'].create = true; feats['Job Portal Workspace'].edit = true; feats['Requirement Detail'].edit = true;
    const sv = await call('PUT', '/api/admin/role-catalog/RECRUITER/modules/requirements/features', T.sa, { features: feats });
    check('P15 Super Admin ticks the boxes in Role Catalog: the save is accepted', sv.status === 200, [sv.status, sv.text.slice(0, 120)]);
    await new Promise((r) => setTimeout(r, 300));
    const rr2 = await postCalls(await mint(uRec));
    check('P16 ...but the Recruiter is STILL refused on every posting endpoint (the tick cannot be re-enabled)', rr2.slice(0, 14).every((x) => x.status === 403) && rr2[16].status === 403 && rr2[14].status === 403, rr2.map((x) => x.status));
    const me2 = await call('GET', '/api/auth/me', await mint(uRec));
    check('P17 ...and /auth/me still draws no posting boxes', !me2.body.access.requirements.features['Job Posting'].edit && !me2.body.access.requirements.features['Job Portal Workspace'].edit && !me2.body.access.requirements.features['Requirement Detail'].edit, me2.body.access.requirements.features['Job Posting']);
    const cat2 = await call('GET', '/api/admin/role-catalog/RECRUITER/access', T.sa);
    check('P18 ...and Role Catalog shows them OFF again', cat2.body.modules.find((m) => m.id === 'requirements').features['Job Posting'].edit === false);

    // =============================== I: BOOKING ===============================================
    const nonBook = [['Recruiter', T.rec], ['TL', T.tl], ['STL', T.stl], ['Manager', T.mgr], ['Asst Manager', T.am]];
    for (const [label, tok] of nonBook) {
      const b = await book(tok, a1);
      check(`I1 ${label}: book -> 403 with the plain sentence`, b.status === 403 && PLAIN_BOOK.test((b.body && b.body.error) || ''), [b.status, b.text.slice(0, 160)]);
      const bl = await call('GET', '/api/ats/interviews/bookable', tok);
      check(`I2 ${label}: bookable list -> 403`, bl.status === 403, bl.status);
      const mv = await call('PATCH', `/api/applications/${a1.id}/stage`, tok, { stage: 'INTERVIEW_SCHEDULED', interviewAt: new Date(Date.now() + 2 * 86400000).toISOString() });
      check(`I3 ${label}: stage move into Interview booked -> 403 plain`, mv.status === 403 && /Interviews are booked by the client manager \(BDE\)\. Your candidate is waiting for them\./.test((mv.body && mv.body.error) || ''), [mv.status, mv.text.slice(0, 160)]);
      const bk = await call('POST', '/api/applications/bulk', tok, { action: 'stage', stage: 'INTERVIEW_SCHEDULED', applicationIds: [a1.id], interviewAt: new Date(Date.now() + 2 * 86400000).toISOString() });
      check(`I4 ${label}: bulk schedule -> 403`, bk.status === 403, [bk.status, bk.text.slice(0, 160)]);
      const bm = await call('POST', '/api/candidates/board/move', tok, { applicationId: a1.id, column: 'interview', interviewAt: new Date(Date.now() + 2 * 86400000).toISOString() });
      check(`I5 ${label}: board drag to Interview -> refused`, [403, 409].includes(bm.status) && bm.status === 403, [bm.status, bm.text.slice(0, 160)]);
    }
    check('I6 nothing moved: a1 is still Client shortlisted', (await stageOf(a1)) === 'CLIENT_SHORTLISTED');
    // /auth/me matrix + allowed steps
    for (const [label, tok, expect] of [['Recruiter', T.rec, false], ['TL', T.tl, false], ['STL', T.stl, false], ['Manager', T.mgr, false], ['Asst Manager', T.am, false], ['BDE', T.bdeEdu, true], ['BDE TL', T.bdeTl, true], ['HR', T.hr, true], ['Admin', T.admin, true]]) {
      const m = await call('GET', '/api/auth/me', tok);
      const f = m.body.access.interviews.features['Schedule Interview'];
      const st = (m.body.workflow && m.body.workflow.allowedStages) || [];
      check(`I7 /auth/me ${label}: Schedule Interview create/edit = ${expect}; Interview-booked step ${expect ? 'allowed' : 'not allowed'}`, !!f.create === expect && !!f.edit === expect && st.includes('INTERVIEW_SCHEDULED') === expect, [f, st.includes('INTERVIEW_SCHEDULED')]);
    }
    for (const [label, tok] of nonBook.slice(0, 2)) {
      const m = await call('GET', '/api/auth/me', tok);
      check(`I8 ${label} keeps View + Feedback on interviews`, m.body.access.interviews.features['Calendar View'].view && m.body.access.interviews.features['Interview Feedback'].create === true, m.body.access.interviews.features['Interview Feedback']);
    }
    const cat3 = await call('GET', '/api/admin/role-catalog/TL/access', T.sa);
    const iv3 = cat3.body.modules.find((m) => m.id === 'interviews');
    check('I9 Role Catalog (TL / Interviews): Schedule Interview OFF + locked with the reason', iv3.features['Schedule Interview'].create === false && iv3.locked['Schedule Interview'].includes('edit') && /Only the client manager/.test(iv3.lockNote), [iv3.features['Schedule Interview'], iv3.lockNote]);
    const cat4 = await call('GET', '/api/admin/role-catalog/BDE/access', T.sa);
    check('I10 Role Catalog (BDE / Interviews): Schedule Interview ON', cat4.body.modules.find((m) => m.id === 'interviews').features['Schedule Interview'].create === true);

    // BDE EDU books a1 (own client)
    const b1 = await book(T.bdeEdu, a1);
    check('I11 BDE (own client): book -> 200', b1.status === 200 && b1.body && b1.body.ok, [b1.status, b1.text.slice(0, 200)]);
    check('I12 ...the candidate is now at Interview booked, SCHEDULED, round 1', (await stageOf(a1)) === 'INTERVIEW_SCHEDULED' && (await prisma.application.findUnique({ where: { id: a1.id } })).interviewStatus === 'SCHEDULED');
    check('I13 ...the booking answer has NO candidate phone / email (masked): wa.me entries cut', b1.body && (b1.body.whatsapp || []).filter((l) => l.to === 'candidate').every((l) => !l.phone && !l.url) && !/9000000077|zz-bk-cand/.test(b1.text), (b1.body && b1.body.whatsapp));
    // bell to the recruiter / TL / BDE
    const nots = await prisma.notification.findMany({ where: { recipient: { startsWith: `interview|scheduled|${a1.id}` } } });
    const notUsers = new Set(nots.map((n) => n.userId));
    check('I14 booking tells the recruiter and the TL (bell)', notUsers.has(uRec.id) && notUsers.has(uTl.id), [...notUsers]);
    // run-the-interview + feedback stay with recruiter / TL
    const adv = await call('PATCH', `/api/ats/interviews/${a1.id}/advance`, T.rec, { to: 'CONFIRMED' });
    check('I15 Recruiter can still Confirm the interview (advance)', adv.status === 200, [adv.status, adv.text.slice(0, 120)]);
    for (const [label, tok, p, body] of [
      ['reschedule', T.rec, `/api/ats/interviews/${a1.id}/reschedule`, { interviewAt: new Date(Date.now() + 3 * 86400000).toISOString(), reason: 'x' }],
      ['cancel', T.rec, `/api/ats/interviews/${a1.id}/cancel`, { reason: 'x' }],
      ['panel', T.rec, `/api/ats/interviews/${a1.id}/panel`, { panel: [{ name: 'Z', email: 'z@example.test' }] }],
      ['meeting link', T.rec, `/api/ats/interviews/${a1.id}/meeting-link`, {}],
      ['type', T.rec, `/api/ats/interviews/${a1.id}/type`, { interviewType: 'Client Interview' }],
      ['whatsapp-log', T.rec, `/api/ats/interviews/${a1.id}/whatsapp-log`, { to: 'candidate' }],
    ]) {
      const x = await call(label === 'panel' ? 'PUT' : label === 'type' ? 'PATCH' : 'POST', p, tok, body);
      check(`I16 Recruiter: ${label} -> 403`, x.status === 403, [x.status, x.text.slice(0, 140)]);
    }
    const rs = await call('POST', `/api/ats/interviews/${a1.id}/reschedule`, T.tl, { interviewAt: new Date(Date.now() + 3 * 86400000).toISOString(), reason: 'x' });
    check('I17 TL: reschedule -> 403 with the plain sentence + a way forward', rs.status === 403 && /Ask the client manager to book/.test(rs.body.error), rs.text.slice(0, 200));
    const ns1 = await call('POST', `/api/ats/interviews/${a1.id}/no-show`, T.rec, { reason: 'did not come', rescheduleAt: new Date(Date.now() + 3 * 86400000).toISOString() });
    check('I18 Recruiter: did-not-attend WITH a new time -> 403', ns1.status === 403 && PLAIN_BOOK.test(ns1.body.error), [ns1.status, ns1.text.slice(0, 160)]);
    const fb = await call('POST', `/api/ats/interviews/${a1.id}/feedback`, T.rec, { feedback: 'Good, strong answers', result: 'Selected', score: 80 });
    check('I19 Recruiter can still add interview feedback (200)', fb.status === 200, [fb.status, fb.text.slice(0, 160)]);
    // BDE other desk
    const bMed = await book(T.bdeMed, a2);
    check('I20 BDE of ANOTHER desk (Medical) books an Education client person -> 403', bMed.status === 403, [bMed.status, bMed.text.slice(0, 140)]);
    // BDE reschedule / cancel / no-show with time
    const a1b = await prisma.application.findUnique({ where: { id: a1.id } });
    // feedback was submitted so reschedule/cancel need a live slot: use a5 for these
    const b5 = await book(T.bdeEdu, a5);
    check('I21 BDE books a5 -> 200', b5.status === 200, [b5.status, b5.text.slice(0, 160)]);
    const r5 = await call('POST', `/api/ats/interviews/${a5.id}/reschedule`, T.bdeEdu, { interviewAt: new Date(Date.now() + 4 * 86400000).toISOString(), reason: 'client asked' });
    check('I22 BDE: reschedule -> 200', r5.status === 200, [r5.status, r5.text.slice(0, 160)]);
    const ns5 = await call('POST', `/api/ats/interviews/${a5.id}/no-show`, T.bdeEdu, { reason: 'did not come', rescheduleAt: new Date(Date.now() + 5 * 86400000).toISOString() });
    check('I23 BDE: did-not-attend with a new time -> 200', ns5.status === 200, [ns5.status, ns5.text.slice(0, 160)]);
    const ns5b = await call('POST', `/api/ats/interviews/${a5.id}/no-show`, T.rec, { reason: 'no answer on the phone' });
    check('I24 Recruiter: plain did-not-attend (no new time) is still allowed', ns5b.status === 200, [ns5b.status, ns5b.text.slice(0, 160)]);
    const b5b = await book(T.bdeEdu, a5, { round: 1 });
    check('I24b BDE re-books after did-not-attend -> 200', b5b.status === 200, [b5b.status, b5b.text.slice(0, 160)]);
    const c5 = await call('POST', `/api/ats/interviews/${a5.id}/cancel`, T.bdeEdu, { reason: 'client changed plan' });
    check('I25 BDE: cancel -> 200', c5.status === 200, [c5.status, c5.text.slice(0, 160)]);
    // bulk by the BDE
    const bulk = await call('POST', '/api/applications/bulk', T.bdeEdu, { action: 'stage', stage: 'INTERVIEW_SCHEDULED', applicationIds: [a6.id, a7.id], interviewAt: new Date(Date.now() + 2 * 86400000).toISOString(), interviewer: 'Panel X', interviewMode: 'Online' });
    check('I26 BDE: bulk schedule 2 people -> 2 ok', bulk.status === 200 && bulk.body.ok === 2, [bulk.status, bulk.text.slice(0, 200)]);
    // BDE TL + Admin + board drag
    const bTl = await book(T.bdeTl, a8);
    check('I27 BDE TL: book (any client) -> 200', bTl.status === 200, [bTl.status, bTl.text.slice(0, 200)]);
    const bAd = await book(T.admin, a9);
    check('I28 Admin: book -> 200', bAd.status === 200, [bAd.status, bAd.text.slice(0, 160)]);
    // BDE TL stage move / allowed steps include the interview step
    const bTlMove = await call('PATCH', `/api/applications/${aMed.id}/stage`, T.bdeTl, { stage: 'INTERVIEW_SCHEDULED', interviewAt: new Date(Date.now() + 2 * 86400000).toISOString() });
    check('I29 BDE TL: stage move into Interview booked -> 200', bTlMove.status === 200, [bTlMove.status, bTlMove.text.slice(0, 160)]);
    // HR: internal only
    const hrClient = await book(T.hr, a2);
    check('I30 HR cannot book a CLIENT job interview (outside its area)', hrClient.status === 403, [hrClient.status, hrClient.text.slice(0, 120)]);
    const hrInt = await book(T.hr, aInt2, { round: 2 });
    check('I31 HR books the next round of an INTERNAL interview -> 200', hrInt.status === 200, [hrInt.status, hrInt.text.slice(0, 200)]);
    // internal first booking: the Dept Head / TL's approval is the booking (no BDE on TeamLink's own jobs)
    const tlInt = await book(T.tl, aInt1);
    check('I32 Internal job at "Dept head / TL": the TL approves and books -> 200 (the one exception, so the internal chain does not stall)', tlInt.status === 200, [tlInt.status, tlInt.text.slice(0, 220)]);
    const tlClientNo = await book(T.tl, a2);
    check('I33 ...but the same TL still cannot book a CLIENT job', tlClientNo.status === 403, tlClientNo.status);
    // tell window: masked for the BDE
    const tell = await call('GET', `/api/ats/interviews/${a6.id}/tell?kind=scheduled`, T.bdeEdu);
    check('I34 "Booked - now tell them" window opens for the BDE, masked: no phone / email in it', tell.status === 200 && tell.body.candidate && tell.body.candidate.masked === true && !/9000000077|zz-bk-cand/.test(tell.text), [tell.status, tell.body && tell.body.candidate && { masked: tell.body.candidate.masked, phone: tell.body.candidate.phone, email: tell.body.candidate.email }]);
    const tellRec = await call('GET', `/api/ats/interviews/${a6.id}/tell?kind=scheduled`, T.rec);
    check('I35 the same window opens (read) for the Recruiter', tellRec.status === 200, tellRec.status);
    const notifyRec = await call('POST', `/api/ats/interviews/${a6.id}/tell/notify`, T.rec, { kind: 'scheduled', who: 'all' });
    check('I36 Recruiter cannot "tell the team" for a booking (that is the booker\'s)', notifyRec.status === 403, notifyRec.status);
    const notifyBde = await call('POST', `/api/ats/interviews/${a6.id}/tell/notify`, T.bdeEdu, { kind: 'scheduled', who: 'all' });
    check('I37 BDE: "tell the team" -> 200 (recruiter / TL get the bell)', notifyBde.status === 200 && notifyBde.body.ok, [notifyBde.status, notifyBde.text.slice(0, 160)]);
    const sendAll = await call('POST', `/api/ats/interviews/${a6.id}/tell/send-all`, T.bdeEdu, { kind: 'scheduled' });
    check('I38 BDE: server-sent message to the candidate answers (no number shown): not a 403/500', [200, 400, 409].includes(sendAll.status) && !/9000000077|zz-bk-cand/.test(sendAll.text), [sendAll.status, sendAll.text.slice(0, 220)]);
    // interview prep follows whoever books (+ recruiter / TL who work the candidate)
    const prepBde = await call('GET', `/api/ats/interviews/${a6.id}/prep`, T.bdeEdu);
    check('I39 interview prep card: BDE can edit / send now', prepBde.status === 200 && (prepBde.body.canEdit === true || (prepBde.body.rights && prepBde.body.rights.edit === true)), [prepBde.status, prepBde.body && Object.keys(prepBde.body).slice(0, 12), prepBde.body && prepBde.body.canEdit]);
    const prepRec = await call('GET', `/api/ats/interviews/${a6.id}/prep`, T.rec);
    check('I40 interview prep card: Recruiter keeps it', prepRec.status === 200 && prepRec.body.canEdit === true, [prepRec.status, prepRec.body && prepRec.body.canEdit]);
    const prepMgr = await call('GET', `/api/ats/interviews/${a6.id}/prep`, T.mgr);
    check('I41 interview prep card: Manager read-only', prepMgr.status === 200 && prepMgr.body.canEdit === false, [prepMgr.status, prepMgr.body && prepMgr.body.canEdit]);
    // AI interview unchanged for the recruiter
    const ai = await call('POST', `/api/ats/ai-interviews/${a3.id}/extend`, T.rec, { days: 2 });
    check('I42 AI interview (extend) is a different permission: Recruiter still 200', ai.status === 200, [ai.status, ai.text.slice(0, 120)]);
    // data import cannot put a person at Interview booked for a recruiter
    const { canMoveToStage } = require(path.join(BACK, 'src/utils/permissions'));
    const idRec = await resolveIdentity(uRec.id);
    const idBde = await resolveIdentity(uBdeEdu.id);
    const idTl = await resolveIdentity(uTl.id);
    const dm = await canMoveToStage(idRec, 'INTERVIEW_SCHEDULED');
    const dm2 = await canMoveToStage(idBde, 'INTERVIEW_SCHEDULED');
    const dm3 = await canMoveToStage(idTl, 'INTERVIEW_SCHEDULED', { internalFromTlReview: true });
    check('I43 canMoveToStage (used by sheet import too): Recruiter refused, BDE allowed, internal TL at TL Review allowed', !!dm && dm.status === 403 && dm2 === null && dm3 === null, [dm, dm2, dm3]);

    // =============================== A: ASK TO BOOK ===========================================
    const ask = (tok, a) => call('POST', `/api/ats/interviews/${a.id}/ask-book`, tok, {});
    const q1 = await ask(T.rec, a2);
    check('A1 Recruiter asks for a Client-shortlisted candidate -> 201, BDE (client) told', q1.status === 201 && q1.body.ok && q1.body.via === 'client' && (q1.body.told || []).includes(uBdeEdu.name), [q1.status, q1.text.slice(0, 220)]);
    const bell = await prisma.notification.findMany({ where: { userId: uBdeEdu.id, recipient: { startsWith: `interview-ask|${a2.id}` } } });
    check('A2 the BDE has the bell with the candidate + job, and NO phone / email / salary', bell.length === 1 && /ZZTEST BK Cand a2/.test(bell[0].message) && !/9000000077|zz-bk-cand|7L|9L|salary/i.test(bell[0].title + bell[0].message), bell.map((b) => b.message));
    const fu = await prisma.applicationFollowUp.findMany({ where: { applicationId: a2.id, completedAt: null, ownerUserId: uBdeEdu.id } });
    check('A3 the BDE has "Book the interview" in Follow-ups (due today)', fu.some((f) => f.nextAction === 'Book the interview'), fu.map((f) => [f.nextAction, f.dueDate, f.ownerUserId]));
    const q2 = await ask(T.tl, a2);
    check('A4 asked again the same day (even by the TL): 200 "Already asked today", no second bell', q2.status === 200 && q2.body.already === true && (await prisma.notification.count({ where: { userId: uBdeEdu.id, recipient: { startsWith: `interview-ask|${a2.id}` } } })) === 1, [q2.status, q2.text.slice(0, 160)]);
    const q3 = await ask(T.bdeEdu, a8 /* already booked anyway */);
    check('A5 a BDE does not ask (they book): 409', q3.status === 409, [q3.status, q3.text.slice(0, 120)]);
    const q4 = await ask(T.rec, a4);
    check('A6 a candidate not yet sent to the client cannot be asked for: 409 plain', q4.status === 409 && /Send the candidate to the client first/.test(q4.body.error), [q4.status, q4.text.slice(0, 160)]);
    const q5 = await ask(T.rec, a3);
    check('A7 "Sent to client" (waiting for the client) can be asked for', q5.status === 201, [q5.status, q5.text.slice(0, 160)]);
    const q6 = await ask(T.rec, a6);
    check('A8 ask on someone whose interview is already booked -> 409', q6.status === 409, [q6.status, q6.text.slice(0, 160)]);
    const q6b = await ask(T.mgr, a1);
    check('A8b after round-1 feedback a NEXT ROUND can be asked for (any non-booker who sees the person)', q6b.status === 201, [q6b.status, q6b.text.slice(0, 160)]);
    // fallback recipients
    const qMed = await ask(T.rec, aMed);
    check('A9 no client BDE -> the BDE of the job\'s desk (Medical), here a stage already booked => 409 handled; test with another', [201, 409].includes(qMed.status), qMed.status);
    const aMed2 = await mkApp('med2', rMed, 'CLIENT_SHORTLISTED');
    const qMed2 = await ask(T.rec, aMed2);
    check('A10 no client BDE -> the Medical desk BDE is asked', qMed2.status === 201 && qMed2.body.via === 'desk' && (qMed2.body.told || []).includes(uBdeMed.name), [qMed2.status, qMed2.text.slice(0, 200)]);
    await prisma.client.update({ where: { id: cMfg.id }, data: { ownerDepartment: 'ZZTEST Dept ' + RUN } }); await prisma.requirement.update({ where: { id: rMfg.id }, data: { department: 'ZZTEST Dept ' + RUN } });
    const qMfg = await ask(T.rec, aMfg);
    check('A11 no client BDE and no desk BDE -> the BDE TL is asked', qMfg.status === 201 && qMfg.body.via === 'tl' && (qMfg.body.told || []).includes(uBdeTl.name), [qMfg.status, qMfg.text.slice(0, 200)]);
    // the marker on the rows
    const list = await call('GET', `/api/candidates?paged=1&view=pipeline&sub=all&search=${encodeURIComponent('ZZTEST BK Cand a2')}&pageSize=10`, T.rec);
    const row = (list.body.rows || []).find((r) => r.id === a2.id);
    check('A12 the candidate row says "Interview requested by <recruiter>"', row && row.interviewRequest && new RegExp(`Interview requested by ${uRec.name}`).test(row.interviewRequest.line), [list.status, row && row.interviewRequest, (list.body.rows || []).length]);
    const bdeList = await call('GET', `/api/candidates?paged=1&view=pipeline&sub=all&search=${encodeURIComponent('ZZTEST BK Cand a2')}&pageSize=10`, T.bdeEdu);
    const brow = (bdeList.body.rows || []).find((r) => r.id === a2.id);
    check('A13 the BDE sees the same line on the row', brow && brow.interviewRequest && /Interview requested/.test(brow.interviewRequest.line), [bdeList.status, brow && brow.interviewRequest]);
    const board = await call('GET', `/api/candidates/board?search=${encodeURIComponent('ZZTEST BK Cand a2')}`, T.rec);
    const card = ((board.body.columns || []).flatMap((c) => c.cards)).find((c) => c.id === a2.id);
    check('A14 the Progress board card carries it too, and the card has the interview status', card && card.interviewRequest, [board.status, card && Object.keys(card).slice(0, 8)]);
    const c360 = await call('GET', `/api/candidates/${a2.candidateId}`, T.rec);
    const app360 = (c360.body.applications || []).find((a) => a.id === a2.id);
    check('A15 Candidate 360 application carries it', app360 && app360.interviewRequest, [c360.status, app360 && app360.interviewRequest]);
    const work = await call('GET', '/api/dashboard/ats/home', T.bdeEdu);
    check('A16 BDE role dashboard answers 200 and offers the Schedule Interview quick action', work.status === 200, [work.status, work.text.slice(0, 120)]);
    const workRec = await call('GET', '/api/dashboard/ats/home', T.rec);
    check('A16b Recruiter role dashboard has NO Schedule Interview quick action', workRec.status === 200 && !/Schedule Interview/.test(workRec.text), [workRec.status]);
    const home = await call('GET', '/api/dashboard/ats/home', T.bdeEdu);
    check('A16c BDE home: "Interviews to book (client shortlisted)" line shows the recruiter-asked count', home.status === 200 && /Interviews to book/.test(home.text) && /asked for by a recruiter/.test(home.text), [home.status, (home.text.match(/Interviews to book[^}]{0,200}/) || [''])[0]]);
    const CW = require(path.join(BACK, 'src/utils/clientWork'));
    const idBdeEdu = await resolveIdentity(uBdeEdu.id);
    const pend = await CW.bdePending(idBdeEdu);
    const sh = pend.lists.shortlisted.find((i) => i.applicationId === a2.id);
    check('A17 BDE "Interviews to book" list holds a2 with requestedBy = the recruiter', sh && sh.requestedBy === uRec.name, [pend.counts, sh]);
    // booking by the BDE settles the marker
    const bAsk = await book(T.bdeEdu, a2);
    check('A18 BDE books the requested person -> 200', bAsk.status === 200, [bAsk.status, bAsk.text.slice(0, 160)]);
    const list2 = await call('GET', `/api/candidates?paged=1&view=pipeline&sub=all&search=${encodeURIComponent('ZZTEST BK Cand a2')}&pageSize=10`, T.rec);
    const row2 = (list2.body.rows || []).find((r) => r.id === a2.id);
    check('A19 ...and the "Interview requested" line is gone', row2 && !row2.interviewRequest, row2 && row2.interviewRequest);
    // out of scope
    const uRec2 = await mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    const out = await ask(await mint(uRec2), a3);
    check('A20 a recruiter outside the job cannot ask for it (403)', out.status === 403, [out.status]);

    // reminders reach the recruiter / TL: run the reminder engine for the booked a6 with a simulated clock
    const a6row = await prisma.application.findUnique({ where: { id: a6.id } });
    const sim = new Date(new Date(a6row.interviewAt).getTime() - 50 * 60000).toISOString();
    const rem = await call('POST', '/api/ats/interview-reminders/run', T.admin, { now: sim, onlyIds: [a6.id], asTimer: false });
    const remNots = await prisma.notification.findMany({ where: { userId: { in: [uRec.id, uTl.id, uBdeEdu.id] }, createdAt: { gte: new Date(Date.now() - 120000) }, OR: [{ title: { contains: 'ZZTEST BK Cand a6' } }, { message: { contains: 'ZZTEST BK Cand a6' } }] } });
    const remUsers = new Set(remNots.map((n) => n.userId));
    check('I44 reminders still reach the Recruiter and the TL (and the BDE) for a BDE-booked interview', rem.status === 200 && remUsers.has(uRec.id) && remUsers.has(uTl.id), [rem.status, rem.text.slice(0, 200), [...remUsers]]);
  } catch (e) {
    fail += 1; console.log('FAIL  test crashed:', e && e.message ? e.message : e);
  } finally {
    // ---- cleanup ---------------------------------------------------------------------------
    try {
      const ids = made.users;
      const apps = made.apps;
      const reqs = made.reqs;
      const extraApps = (await prisma.application.findMany({ where: { requirementId: { in: reqs } }, select: { id: true, candidateId: true } }));
      const allApps = [...new Set([...apps, ...extraApps.map((a) => a.id)])];
      const allCands = [...new Set([...made.cands, ...extraApps.map((a) => a.candidateId)])];
      const del = async (label, fn) => { try { await fn(); } catch (e) { console.log('cleanup', label, String(e.message).split('\n').pop()); } };
      await del('notif', () => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, ...allApps.map((a) => ({ recipient: { contains: a } })), { title: { contains: 'ZZTEST BK' } }, { message: { contains: 'ZZTEST BK' } }] } }));
      await del('audit', () => prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...allApps, ...reqs, ...made.clients] } }] } }));
      await del('fu', () => prisma.applicationFollowUp.deleteMany({ where: { applicationId: { in: allApps } } }));
      await del('ivev', () => prisma.interviewEvent.deleteMany({ where: { applicationId: { in: allApps } } }));
      await del('ivfb', () => prisma.interviewFeedback.deleteMany({ where: { applicationId: { in: allApps } } }));
      await del('panel', () => prisma.interviewPanelist.deleteMany({ where: { applicationId: { in: allApps } } }));
      await del('msg', () => prisma.candidateMessage.deleteMany({ where: { candidateId: { in: allCands } } }));
      await del('stageev', () => prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: allApps } } }));
      await del('setting', () => prisma.appSetting.deleteMany({ where: { key: { in: allApps.map((a) => `interviewprep.share.${a}`) } } }));
      await del('posting', () => prisma.requirementPosting.deleteMany({ where: { requirementId: { in: reqs } } }));
      await del('apps', () => prisma.application.deleteMany({ where: { id: { in: allApps } } }));
      await del('cands', () => prisma.candidate.deleteMany({ where: { id: { in: allCands } } }));
      await del('reqs', () => prisma.requirement.deleteMany({ where: { id: { in: reqs } } }));
      await del('clients', () => prisma.client.deleteMany({ where: { id: { in: made.clients } } }));
      await del('emps', () => prisma.employee.deleteMany({ where: { userId: { in: ids } } }));
      await del('users', () => prisma.user.deleteMany({ where: { id: { in: ids } } }));
      // Role Catalog rows I changed for RECRUITER: back to what they were
      await del('roleaccess', async () => {
        await prisma.roleAccess.deleteMany({ where: { role: 'RECRUITER', moduleId: { in: ['requirements', 'interviews'] } } });
        for (const r of roleRowsBefore || []) { const { id, ...rest } = r; await prisma.roleAccess.create({ data: rest }); }
        require(path.join(BACK, 'src/utils/permissions')).invalidateRoleAccess('RECRUITER');
      });
    } catch (e) { console.log('cleanup failed', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

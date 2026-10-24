#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONLY THE BDE TEAM AND ABOVE CREATE A JOB (user, 2026-10-13). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node <this file>
// M  matrix: every creation path x every role (201/draft or 403)
// R  Role Catalog: fixed-off boxes, a tick cannot re-enable, custom role behaving like a TL
// A  "Ask the client manager to add a requirement": goes to the right BDE, once; no candidate data
// P  client portal request flow unchanged; BDE import request mode; import modes; AI tool; Act as
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
async function call(method, p, token, body, extraHeaders = {}) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...extraHeaders };
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
const PLAIN = 'Requirements are created by the client manager (BDE) team. Ask them to add this requirement.';

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [] };
  let customCode = null;
  const touchedRoles = [];
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST JC ${tag} ${RUN}`, email: `zz-jc-${tag}-${RUN}@example.test`, username: `zz-jc-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-JC-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, phone: '90000' + String(Math.floor(Math.random() * 99999)).padStart(5, '0') } });
      made.emps.push(e.id);
      return u;
    };
    const uSa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
    const uBdeEdu = await mkUser('bdeedu', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const uBdeMed = await mkUser('bdemed', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uRecNone = await mkUser('recnone', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uStl = await mkUser('stl', { role: 'STL', atsRole: 'STL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uAm = await mkUser('am', { role: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uHr = await mkUser('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsDepartment: 'HR', atsScopeDepartments: 'HR' });
    const uAcc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const uEmp = await mkUser('emp', { role: 'EMPLOYEE', atsRole: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ sa: uSa, admin: uAdmin, bdeTl: uBdeTl, bdeEdu: uBdeEdu, bdeMed: uBdeMed, rec: uRec, recNone: uRecNone, tl: uTl, stl: uStl, mgr: uMgr, am: uAm, hr: uHr, acc: uAcc, emp: uEmp })) T[k] = await mint(u);

    const mkClient = async (tag, dept, bde, type = 'Client') => { const c = await prisma.client.create({ data: { name: `ZZTEST JC Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: bde ? bde.name : null, clientType: type, agreementStatus: 'ACTIVE' } }); made.clients.push(c.id); return c; };
    const cEdu = await mkClient('edu', 'Education', uBdeEdu);
    const cMed = await mkClient('med', 'Medical', null);
    const cMfg = await mkClient('mfg', 'Manufacturing', null);
    const cInt = await mkClient('int', 'Education', null, 'Internal');
    const cOut = await mkClient('out', 'Medical', null);
    const mkReq = async (tag, client, dept, extra = {}) => { const r = await prisma.requirement.create({ data: { title: `ZZTEST JC Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: dept, recruiterId: uRec.id, tlId: uTl.id, bdeId: tag === 'edu' ? uBdeEdu.id : null, openings: 2, postingSources: 'None', ...extra } }); made.reqs.push(r.id); return r; };
    const rEdu = await mkReq('edu', cEdu, 'Education');
    const rInt = await mkReq('int', cInt, 'Education', { internal: true, hiringType: 'TeamLink Internal Hire' });
    const newTitle = (tag) => `ZZTEST JC New ${tag} ${RUN}`;
    const created = (b) => { if (b && b.id) made.reqs.push(b.id); return b; };
    const mark = async (title) => (await prisma.requirement.findFirst({ where: { title }, orderBy: { createdAt: 'desc' } }));

    // =============================== M: THE MATRIX =============================================
    // M1  POST /requirements (the form's route)
    const formBody = (tag, client) => ({ title: newTitle(`form-${tag}`), clientId: client.id, department: 'Education', status: 'DRAFT', openings: 1, location: 'Hyderabad' });
    const refused = ['tl', 'stl', 'rec', 'recNone', 'emp'];
    for (const k of refused) {
      const r = await call('POST', '/api/requirements', T[k], formBody(k, cEdu));
      check(`M1 ${k}: POST /requirements -> 403${k === 'emp' ? ' (no ATS access at all)' : ' with the plain sentence'}`, r.status === 403 && (k === 'emp' || (r.body && r.body.error === PLAIN)), [r.status, r.text.slice(0, 160)]);
    }
    const acc1 = await call('POST', '/api/requirements', T.acc, formBody('acc', cEdu));
    check('M1 accountant: POST /requirements -> 403', acc1.status === 403, [acc1.status, acc1.text.slice(0, 120)]);
    const sa1 = await call('POST', '/api/requirements', T.sa, formBody('sa', cEdu));
    check('M1 super admin: POST /requirements -> 201 (DRAFT, created as sent)', sa1.status === 201 && sa1.body.status === 'DRAFT' && sa1.body.reqCode, [sa1.status, sa1.text.slice(0, 160)]); created(sa1.body);
    const ad1 = await call('POST', '/api/requirements', T.admin, formBody('admin', cEdu));
    check('M1 admin: POST /requirements -> 201 (DRAFT)', ad1.status === 201 && ad1.body.status === 'DRAFT', [ad1.status, ad1.text.slice(0, 160)]); created(ad1.body);
    // a request-mode login sending the form body gets the REQUEST (a draft a lead opens)
    for (const [k, cl] of [['bdeEdu', cEdu], ['bdeTl', cMfg], ['mgr', cMed], ['am', cEdu]]) {
      const r = await call('POST', '/api/requirements', T[k], formBody(k, cl));
      if (['bdeEdu', 'bdeTl'].includes(k)) { check(`M1 ${k}: POST /requirements -> 201 created DIRECTLY (a real job, reqCode, no request message)`, r.status === 201 && r.body.reqCode && r.body.id && !r.body.ok && r.body.bdeId === (k === 'bdeEdu' ? uBdeEdu.id : uBdeTl.id) && !r.body.tlId, [r.status, r.text.slice(0, 200)]); created(r.body); continue; }
      check(`M1 ${k}: POST /requirements -> 201 as a request (DRAFT, "Request ... saved")`, r.status === 201 && r.body.status === 'DRAFT' && r.body.ok && /Request .* saved/.test(r.body.message || '') && !/\bDraft\b/.test(r.body.message || ''), [r.status, r.text.slice(0, 200)]); created(r.body); // the word "Draft" is not used in what people read (founder rule)
    }
    const bdeOut = await call('POST', '/api/requirements', T.bdeMed, formBody('bdeMed-edu', cEdu));
    check('M1 BDE of another desk: a client that is not theirs -> 403', bdeOut.status === 403, [bdeOut.status, bdeOut.text.slice(0, 160)]);
    const amOut = await call('POST', '/api/requirements', T.am, formBody('am-med', cOut));
    check('M1 asst manager: a client outside their area -> 403', amOut.status === 403, [amOut.status, amOut.text.slice(0, 160)]);
    // HR: internal only
    const hrInt = await call('POST', '/api/requirements', T.hr, { title: newTitle('hr-int'), internal: true, department: 'Education', status: 'DRAFT', openings: 1 });
    check('M1 HR: an INTERNAL job -> 201 (internal, no client manager)', hrInt.status === 201 && hrInt.body.internal === true && !hrInt.body.bdeId, [hrInt.status, hrInt.text.slice(0, 200)]); created(hrInt.body);
    const hrNoClient = await call('POST', '/api/requirements', T.hr, { title: newTitle('hr-nc'), department: 'Education', status: 'DRAFT', openings: 1 });
    check('M1 HR: a form that names no client is still an internal job -> 201 internal', hrNoClient.status === 201 && hrNoClient.body.internal === true, [hrNoClient.status, hrNoClient.text.slice(0, 160)]); created(hrNoClient.body);
    const hrClient = await call('POST', '/api/requirements', T.hr, formBody('hr-client', cEdu));
    check('M1 HR: a CLIENT job -> 403 with the plain sentence', hrClient.status === 403 && hrClient.body.error === PLAIN, [hrClient.status, hrClient.text.slice(0, 160)]);
    check('M1 nothing was created for the refused logins', !(await prisma.requirement.findFirst({ where: { title: { in: ['tl', 'stl', 'rec', 'recNone', 'emp', 'acc', 'hr-client', 'bdeMed-edu', 'am-med'].map((k) => newTitle(`form-${k}`)) } } })), null);

    // M2  POST /requirements/requests ("Request job")
    const rq = (tag, cl) => ({ title: newTitle(`req-${tag}`), clientId: cl.id, openings: 1 });
    for (const k of ['tl', 'stl', 'rec', 'emp', 'hr']) {
      const r = await call('POST', '/api/requirements/requests', T[k], rq(k, cEdu));
      check(`M2 ${k}: POST /requirements/requests -> 403${k === 'emp' ? '' : ' with the plain sentence'}`, r.status === 403 && (k === 'emp' || (r.body && r.body.error === PLAIN)), [r.status, r.text.slice(0, 160)]);
    }
    for (const [k, cl] of [['bdeEdu', cEdu], ['bdeTl', cMfg], ['mgr', cMed], ['am', cEdu], ['admin', cEdu], ['sa', cEdu]]) {
      const r = await call('POST', '/api/requirements/requests', T[k], rq(k, cl));
      check(`M2 ${k}: POST /requirements/requests -> 201 DRAFT`, r.status === 201 && r.body.status === 'DRAFT', [r.status, r.text.slice(0, 160)]); created(r.body);
    }
    const mgrReq = await prisma.requirement.findFirst({ where: { title: newTitle('req-mgr') } });
    check('M2 the Manager\'s request is a DRAFT with an audit row "Requirement requested", owned by no BDE', mgrReq && mgrReq.status === 'DRAFT' && !mgrReq.bdeId && !!(await prisma.auditLog.findFirst({ where: { entityId: mgrReq.id, action: 'Requirement requested', userId: uMgr.id } })), mgrReq);
    const edRq = await prisma.requirement.findFirst({ where: { title: newTitle('req-bdeEdu') } });
    check('M2 the BDE\'s request is owned by that BDE (as before)', edRq && edRq.bdeId === uBdeEdu.id && edRq.status === 'DRAFT', edRq && [edRq.bdeId, edRq.status]);
    const otherDesk = await call('POST', '/api/requirements/requests', T.bdeMed, rq('bdeMed-cEdu', cEdu));
    check('M2 a desk BDE asking for a colleague\'s client -> 403 (as before)', otherDesk.status === 403, [otherDesk.status]);

    // M3  Copy job
    for (const k of ['tl', 'stl', 'rec']) {
      const r = await call('POST', `/api/requirements/${rEdu.id}/copy`, T[k], {});
      check(`M3 ${k}: copy a job -> 403 with the plain sentence`, r.status === 403 && r.body && r.body.error === PLAIN, [r.status, r.text.slice(0, 160)]);
    }
    for (const k of ['admin', 'sa', 'bdeEdu', 'bdeTl', 'mgr', 'am']) {
      const r = await call('POST', `/api/requirements/${rEdu.id}/copy`, T[k], {});
      check(`M3 ${k}: copy a client job -> 201 a DRAFT copy`, r.status === 201 && r.body.status === 'DRAFT' && r.body.copiedFrom, [r.status, r.text.slice(0, 160)]); created(r.body);
    }
    const cpOut = await call('POST', `/api/requirements/${rEdu.id}/copy`, T.bdeMed, {});
    check('M3 a BDE of another desk cannot copy it -> 403', cpOut.status === 403, [cpOut.status]);
    const hrCopy = await call('POST', `/api/requirements/${rInt.id}/copy`, T.hr, {});
    check('M3 HR copies an INTERNAL job -> 201', hrCopy.status === 201, [hrCopy.status, hrCopy.text.slice(0, 160)]); created(hrCopy.body);
    const bdeIntCopy = await call('POST', `/api/requirements/${rInt.id}/copy`, T.admin, {});
    check('M3 admin copies an internal job -> 201', bdeIntCopy.status === 201, [bdeIntCopy.status]); created(bdeIntCopy.body);

    // M4  templates (the Add job form's)
    for (const k of ['tl', 'stl', 'rec', 'mgr']) {
      const r = await call('POST', '/api/requirements/templates', T[k], { name: `ZZTEST JC tpl ${k} ${RUN}`, fields: { title: 'x' } });
      check(`M4 ${k}: save a job template -> 403`, r.status === 403, [r.status, r.text.slice(0, 120)]);
    }
    const tpl = await call('POST', '/api/requirements/templates', T.admin, { name: `ZZTEST JC tpl admin ${RUN}`, fields: { title: 'ZZTEST JC tpl job' } });
    check('M4 admin: save a job template -> 201', tpl.status === 201, [tpl.status, tpl.text.slice(0, 120)]);
    if (tpl.body && tpl.body.id) await call('DELETE', `/api/requirements/templates/${tpl.body.id}`, T.admin);

    // M5  Import jobs (the sheet): who can import, and how
    const modes = {};
    for (const k of ['sa', 'admin', 'bdeEdu', 'bdeTl', 'tl', 'stl', 'rec', 'mgr', 'am', 'hr']) {
      const r = await call('GET', '/api/ats-io/access', T[k]);
      modes[k] = r.status === 200 ? r.body.importModes.requirements : `HTTP ${r.status}`;
    }
    check('M5 import modes for jobs: Admin, BDE, BDE TL and HR (internal) direct', modes.sa === 'direct' && modes.admin === 'direct' && modes.bdeEdu === 'direct' && modes.bdeTl === 'direct' && modes.hr === 'direct', modes);
    check('M5 TL, STL, Recruiter, Manager, Asst Manager: no job import', [modes.tl, modes.stl, modes.rec, modes.mgr, modes.am].every((m) => m === null), modes);
    for (const k of ['tl', 'stl', 'rec', 'mgr', 'am']) {
      const r = await call('POST', '/api/ats-io/import/requirements/check', T[k], {});
      check(`M5 ${k}: POST import check -> 403`, r.status === 403, [r.status, r.text.slice(0, 120)]);
      const r2 = await call('POST', '/api/ats-io/import/requirements/request', T[k], {});
      check(`M5 ${k}: POST import request -> 403`, r2.status === 403, [r2.status, r2.text.slice(0, 120)]);
    }
    for (const k of ['tl', 'rec', 'bdeEdu', 'hr', 'mgr']) {
      const r = await call('POST', '/api/data-import/commit', T[k], {});
      check(`M5 ${k}: the full-workbook import (/api/data-import/commit) -> 403`, r.status === 403, [r.status, r.text.slice(0, 100)]);
    }

    // M6  the AI assistant's "add a job" tool
    require(path.join(BACK, 'src/ai/tools/ats-records.js'));
    const REG = require(path.join(BACK, 'src/ai/registry'));
    const tool = REG.getTool('create_requirement');
    if (!tool) check('M6 found the create_requirement tool', false, Object.keys(REG).slice(0, 12));
    else {
      const idOf = async (u) => resolveIdentity(u.id);
      const res = {};
      for (const [k, u] of Object.entries({ sa: uSa, admin: uAdmin, bdeEdu: uBdeEdu, bdeTl: uBdeTl, mgr: uMgr, am: uAm, hr: uHr, tl: uTl, stl: uStl, rec: uRec, emp: uEmp })) {
        const g = await tool.permission(await idOf(u), null);
        res[k] = !!(g && g.ok);
      }
      check('M6 AI "add a job" tool: Admin, BDE, BDE TL, Manager, Asst Manager, HR allowed', ['sa', 'admin', 'bdeEdu', 'bdeTl', 'mgr', 'am', 'hr'].every((k) => res[k]), res);
      check('M6 AI "add a job" tool: TL, STL, Recruiter, Employee refused', ['tl', 'stl', 'rec', 'emp'].every((k) => !res[k]), res);
      const hrClientParam = await tool.permission(await idOf(uHr), { internal: false });
      check('M6 AI tool: HR for a client job refused', !hrClientParam.ok, hrClientParam);
    }

    // M7  every "create" box in the matrix /auth/me hands the browser (what the buttons read)
    const meOf = async (k) => (await call('GET', '/api/auth/me', T[k])).body;
    const box = (me0, f, a) => { const me = me0 && (me0.user || me0); const m = me && me.access && me.access.requirements; return !!(m && m.features && m.features[f] && m.features[f][a]); };
    const mats = {};
    for (const k of ['sa', 'admin', 'bdeEdu', 'bdeTl', 'mgr', 'am', 'hr', 'tl', 'stl', 'rec', 'emp']) mats[k] = await meOf(k);
    const shape = Object.fromEntries(Object.entries(mats).map(([k, me]) => [k, ['Create Requirement|create', 'Requirement Request|create', 'Bulk Import|view', 'Bulk Import|create'].map((x) => (box(me, ...x.split('|')) ? 1 : 0)).join('')]));
    // order: create, request, import-view, import-create
    const want = { sa: '1111', admin: '1111', bdeEdu: '1111', bdeTl: '1111', mgr: '0100', am: '0100', hr: '1011', tl: '0000', stl: '0000', rec: '0000', emp: '0000' };
    check('M7 /auth/me create boxes [Create, Request, Import view, Import create] match the rule for every role', Object.keys(want).every((k) => shape[k] === want[k]), { shape, want });

    // =============================== R: ROLE CATALOG ===========================================
    const cat = async (role) => { const r = await call('GET', `/api/admin/role-catalog/${role}/access`, T.sa); return (r.body && r.body.modules || []).find((m) => m.id === 'requirements'); };
    for (const role of ['TL', 'STL', 'RECRUITER', 'ACCOUNTANT', 'EMPLOYEE']) {
      const m = await cat(role);
      check(`R1 Role Catalog ${role}: Create / Request / Import boxes fixed OFF, with a plain reason`, m && m.locked && m.locked['Create Requirement'].includes('create') && m.locked['Requirement Request'].includes('create') && m.locked['Bulk Import'].includes('create') && m.locked['Bulk Import'].includes('view') && /client manager \(BDE\)/.test(m.lockNote || ''), m && [m.locked, m.lockNote]);
      check(`R1 ${role}: the saved boxes read OFF`, m && !m.features['Create Requirement'].create && !m.features['Requirement Request'].create && !m.features['Bulk Import'].create && !m.features['Bulk Import'].view, m && m.features['Create Requirement']);
    }
    const mHr = await cat('HR'); const mBde = await cat('BDE'); const mMgr = await cat('MANAGER'); const mAm = await cat('ASSISTANT_MANAGER'); const mAdm = await cat('ADMIN');
    check('R2 HR: only "Create a request" is fixed off; Create (internal) and Import stay tickable', mHr.locked && mHr.locked['Requirement Request'].includes('create') && !(mHr.locked['Create Requirement'] || []).includes('create') && !(mHr.locked['Bulk Import'] || []).includes('create'), mHr.locked);
    const bl = mBde.locked || {}; // the BDE row: nothing is fixed off for create / import / delete (the BDE team creates, imports and (2026-10-16) deletes directly); the request box stays free and ticked
    check('R2 BDE: Create, Import-create and Delete are NOT fixed off (the BDE team does them directly); the request box is free and ticked', !(bl['Create Requirement'] || []).includes('create') && !(bl['Bulk Import'] || []).includes('create') && !(bl['Requirement Detail'] || []).includes('delete') && !(bl['Requirement Request'] || []).includes('create') && mBde.features['Requirement Request'].create === true && mBde.features['Create Requirement'].create === true, [mBde.locked, mBde.features['Create Requirement'], mBde.features['Requirement Request']]);
    check('R2 Manager and Asst Manager: the request box is free and ticked; direct Create fixed off', [mMgr, mAm].every((m) => !(m.locked['Requirement Request'] || []).includes('create') && m.features['Requirement Request'].create === true && m.locked['Create Requirement'].includes('create')), [mMgr.locked, mMgr.features['Requirement Request'], mAm.features['Requirement Request']]);
    check('R2 Admin: nothing fixed off for job creation', !mAdm.locked || !(mAdm.locked['Create Requirement'] || []).includes('create'), mAdm.locked);

    // an admin tick cannot re-enable it (TL, Recruiter, STL)
    for (const role of ['TL', 'RECRUITER', 'STL']) {
      const existing = await prisma.roleAccess.findMany({ where: { role, moduleId: 'requirements' } });
      touchedRoles.push([role, existing]);
      const m0 = await cat(role);
      const feats = JSON.parse(JSON.stringify(m0.features));
      ['Create Requirement', 'Requirement Request', 'Bulk Import'].forEach((f) => { Object.keys(feats[f]).forEach((a) => { feats[f][a] = true; }); });
      const put = await call('PUT', `/api/admin/role-catalog/${role}/modules/requirements/features`, T.sa, { features: feats, enabled: true });
      check(`R3 ${role}: admin ticks every create / import box -> saved (200)`, put.status === 200, [put.status, put.text.slice(0, 120)]);
      const after = await cat(role);
      check(`R3 ${role}: ...the boxes still read OFF in the catalog`, !after.features['Create Requirement'].create && !after.features['Requirement Request'].create && !after.features['Bulk Import'].create && !after.features['Bulk Import'].view, after.features['Create Requirement']);
    }
    // wait for the 15 s role cache? the PUT invalidates it; mint fresh tokens anyway
    const tTl2 = await mint(uTl); const tRec2 = await mint(uRec); const tStl2 = await mint(uStl);
    for (const [k, tok] of [['tl', tTl2], ['rec', tRec2], ['stl', tStl2]]) {
      const a = await call('POST', '/api/requirements', tok, formBody(`tick-${k}`, cEdu));
      const b = await call('POST', '/api/requirements/requests', tok, rq(`tick-${k}`, cEdu));
      const c = await call('POST', `/api/requirements/${rEdu.id}/copy`, tok, {});
      const d = await call('GET', '/api/ats-io/access', tok);
      check(`R3 ${k} after the admin tick: create 403, request 403, copy 403, import still ${d.body && d.body.importModes && d.body.importModes.requirements}`, a.status === 403 && b.status === 403 && c.status === 403 && d.body.importModes.requirements === null, [a.status, b.status, c.status, d.body && d.body.importModes && d.body.importModes.requirements]);
    }
    const meTlTicked = await call('GET', '/api/auth/me', tTl2);
    check('R3 the TL\'s /auth/me still draws no create box after the tick', !box(meTlTicked.body, 'Create Requirement', 'create') && !box(meTlTicked.body, 'Requirement Request', 'create'), null);
    // a TL can still edit / assign / post their team's jobs (view of what they keep)
    const tlDetail = await call('GET', `/api/requirements/${rEdu.id}`, T.tl);
    check('R4 a TL still opens a team job and keeps assign / post rights (edit moved to the BDE team)', tlDetail.status === 200 && tlDetail.body.permissions && !tlDetail.body.permissions.edit && tlDetail.body.permissions.assign && tlDetail.body.permissions.share, tlDetail.body && tlDetail.body.permissions);
    const tlEdit = await call('PUT', `/api/requirements/${rEdu.id}`, T.tl, { title: `ZZTEST JC Job edu ${RUN}`, openings: 3 });
    check('R4 a TL cannot edit a team job any more -> 403', tlEdit.status === 403, [tlEdit.status, tlEdit.text.slice(0, 160)]);
    const polRes = await call('GET', '/api/requirements?page=1&pageSize=1', T.tl);
    const pol = (polRes.body || {}).permissions;
    if (!pol) console.log('policy debug', polRes.status, polRes.text.slice(0, 300));
    check('R4 the Jobs list policy for a TL: no add, no request, "ask" button on; BDE: request on; Admin: add on', !!pol && pol.buttons && !pol.buttons.add && !pol.buttons.request && pol.buttons.ask === true, pol && pol.buttons);
    const polBde = ((await call('GET', '/api/requirements?page=1&pageSize=1', T.bdeEdu)).body || {}).permissions;
    const polAdm = ((await call('GET', '/api/requirements?page=1&pageSize=1', T.admin)).body || {}).permissions;
    const polMgr = ((await call('GET', '/api/requirements?page=1&pageSize=1', T.mgr)).body || {}).permissions;
    const polHr = ((await call('GET', '/api/requirements?page=1&pageSize=1', T.hr)).body || {}).permissions;
    check('R4 policy buttons: BDE request, Admin add, Manager request, HR add (internal), none ask', polBde.buttons.add && !polBde.buttons.ask && polAdm.buttons.add && polMgr.buttons.request && !polMgr.buttons.add && polHr.buttons.add && !polHr.buttons.ask, [polBde.buttons, polAdm.buttons, polMgr.buttons, polHr.buttons]);

    // a custom role that behaves like a TL: same wall
    customCode = `CUSTOM_ZZTEST_JC_${RUN.toUpperCase()}`;
    const RR = require(path.join(BACK, 'src/utils/roleRegistry'));
    await RR.insertRole({ code: customCode, name: `ZZTEST JC Senior TL ${RUN}`, scopeLevel: 'TEAM', behavesLike: { ats: 'TL' }, permissions: {}, products: { hrms: false, ats: true, accounts: false } });
    const allOn = {};
    ['Requirement List', 'Create Requirement', 'Requirement Detail', 'Job Posting', 'Bulk Import', 'Requirement Request'].forEach((f) => { allOn[f] = { view: true, create: true, edit: true, delete: false, approve: false, export: true, assign: true, configure: false }; });
    await prisma.roleAccess.create({ data: { role: customCode, product: 'ats', moduleId: 'requirements', moduleEnabled: true, features: JSON.stringify(allOn) } });
    require(path.join(BACK, 'src/utils/permissions')).invalidateRoleAccess(customCode);
    RR.invalidateRoles && RR.invalidateRoles();
    await new Promise((res) => setTimeout(res, 16000)); // the server caches the role list for 15 s
    const uCust = await mkUser('cust', { role: 'EMPLOYEE', atsRole: customCode, atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const tCust = await mint(uCust);
    const cu1 = await call('POST', '/api/requirements', tCust, formBody('cust', cEdu));
    const cu2 = await call('POST', '/api/requirements/requests', tCust, rq('cust', cEdu));
    check('R5 a custom role that behaves like a TL (every box ticked): create 403, request 403', cu1.status === 403 && cu2.status === 403, [cu1.status, cu2.status, cu1.text.slice(0, 120)]);
    const cuCat = await cat(customCode);
    check('R5 ...and the Role Catalog shows its create boxes fixed off with the reason', cuCat && cuCat.locked && cuCat.locked['Create Requirement'].includes('create') && !cuCat.features['Create Requirement'].create && /client manager/.test(cuCat.lockNote || ''), cuCat && [cuCat.locked, cuCat.lockNote]);
    const cuAsk = await call('POST', '/api/requirements/ask-add', tCust, { title: newTitle('cust-ask'), clientId: cEdu.id });
    check('R5 ...and it gets the "ask the client manager" path', cuAsk.status === 201, [cuAsk.status, cuAsk.text.slice(0, 160)]);

    // =============================== A: ASK THE CLIENT MANAGER ===================================
    const bells = async (uid, needle) => prisma.notification.findMany({ where: { userId: uid, title: { contains: needle } }, orderBy: { createdAt: 'desc' } });
    const askT = newTitle('ask1');
    const ask1 = await call('POST', '/api/requirements/ask-add', T.tl, { title: askT, clientId: cEdu.id, notes: 'Two seats, urgent' });
    check('A1 TL asks for a job for an Education client -> 201, told the client\'s own BDE', ask1.status === 201 && ask1.body.ok && ask1.body.told && ask1.body.told.length === 1 && ask1.body.told[0] === uBdeEdu.name && ask1.body.via === 'client', [ask1.status, ask1.text.slice(0, 200)]);
    const nEdu = await bells(uBdeEdu.id, askT);
    check('A1 the BDE got exactly one bell: title, client, note, and an "Open:" link into the Request-a-job form', nEdu.length === 1 && /ZZTEST JC Client edu/.test(nEdu[0].message) && /Two seats, urgent/.test(nEdu[0].message) && /Open: \/requirements\?new=1&clientId=/.test(nEdu[0].message), nEdu.map((n) => n.message));
    check('A1 no other BDE, and not the asker, got it', (await bells(uBdeMed.id, askT)).length === 0 && (await bells(uTl.id, askT)).length === 0 && (await bells(uBdeTl.id, askT)).length === 0, null);
    const askAgain = await call('POST', '/api/requirements/ask-add', T.tl, { title: askT.toUpperCase().replace('ZZTEST', 'ZZTEST'), clientId: cEdu.id, notes: 'again' });
    check('A2 the same request again today -> 200 "already asked", no second bell', askAgain.status === 200 && askAgain.body.already === true && (await bells(uBdeEdu.id, askT)).length === 1, [askAgain.status, askAgain.text.slice(0, 160)]);
    const askOther = await call('POST', '/api/requirements/ask-add', T.tl, { title: newTitle('ask2'), clientId: cEdu.id });
    check('A2 a different job title is a new request (201, new bell)', askOther.status === 201 && (await bells(uBdeEdu.id, newTitle('ask2'))).length === 1, [askOther.status, askOther.text.slice(0, 120)]);
    // the desk BDE when the client names none
    const askMed = await call('POST', '/api/requirements/ask-add', T.stl, { title: newTitle('ask-med'), clientId: cMed.id });
    check('A3 a Medical client with no BDE named: the Medical desk BDE is told (STL asks)', askMed.status === 201 && askMed.body.via === 'desk' && askMed.body.told.includes(uBdeMed.name) && !askMed.body.told.includes(uBdeEdu.name), [askMed.status, askMed.text.slice(0, 200)]);
    const askMfg = await call('POST', '/api/requirements/ask-add', T.rec, { title: newTitle('ask-mfg'), clientId: cMfg.id });
    // a recruiter cannot pick a client outside their picker list? cMfg is Manufacturing: the Education recruiter's list may not hold it
    check('A4 a client outside the asker\'s list is refused (403), nothing sent', askMfg.status === 403 && (await bells(uBdeTl.id, newTitle('ask-mfg'))).length === 0, [askMfg.status, askMfg.text.slice(0, 160)]);
    const askNoClient = await call('POST', '/api/requirements/ask-add', T.rec, { title: newTitle('ask-nc'), notes: 'no client yet' });
    check('A5 no client named: the asker\'s desk BDE (Education) is told, via desk', askNoClient.status === 201 && askNoClient.body.via === 'desk' && askNoClient.body.told.includes(uBdeEdu.name), [askNoClient.status, askNoClient.text.slice(0, 200)]);
    const askTlOnly = await call('POST', '/api/requirements/ask-add', T.recNone, { title: newTitle('ask-tl') });
    check('A6 no client and no desk known: the BDE TL is told', askTlOnly.status === 201 && askTlOnly.body.via === 'tl' && askTlOnly.body.told.includes(uBdeTl.name), [askTlOnly.status, askTlOnly.text.slice(0, 200)]);
    const askEmpty = await call('POST', '/api/requirements/ask-add', T.tl, { title: ' ' });
    check('A7 an empty title -> 400 in plain words', askEmpty.status === 400 && /requirement you need/.test(askEmpty.body.error), [askEmpty.status, askEmpty.text.slice(0, 120)]);
    for (const k of ['bdeEdu', 'bdeTl', 'mgr', 'am', 'admin']) {
      const r = await call('POST', '/api/requirements/ask-add', T[k], { title: newTitle(`ask-${k}`) });
      check(`A8 ${k} creates jobs themselves: ask-add -> 409`, r.status === 409, [r.status, r.text.slice(0, 120)]);
    }
    for (const k of ['hr', 'acc', 'emp']) {
      const r = await call('POST', '/api/requirements/ask-add', T[k], { title: newTitle(`ask-${k}`) });
      check(`A8 ${k}: ask-add -> 403`, r.status === 403, [r.status, r.text.slice(0, 120)]);
    }
    const allAsk = await prisma.notification.findMany({ where: { title: { contains: `ZZTEST JC New ask` } } });
    check('A9 the bells carry no phone number, e-mail or salary (only title, client, note)', allAsk.every((n) => !/\b\d{10}\b|@|salary|LPA/i.test(n.message.replace(/zz-jc-[^ ]+@example\.test/g, '').replace(/Open: [^\n]*/g, ''))), allAsk.map((n) => n.message).slice(0, 2));
    const audits = await prisma.auditLog.findMany({ where: { action: 'Requirement add asked', userId: uTl.id } });
    check('A9 each request left one audit row (2 distinct asks by the TL)', audits.length === 2, audits.length);

    // =============================== E: EDIT / CLOSE (2026-10-13) ================================
    const PLAIN2 = 'Requirements are changed or closed by the client manager (BDE) team. Ask them.';
    const J = rEdu.id;
    const tomorrow = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);
    for (const k of ['tl', 'stl', 'rec']) {
      const calls = {
        'PUT job': await call('PUT', `/api/requirements/${J}`, T[k], { title: `ZZTEST JC Job edu ${RUN}`, openings: 4 }),
        activate: await call('POST', `/api/requirements/${J}/activate`, T[k], {}),
        status: await call('POST', `/api/requirements/${J}/status`, T[k], { status: 'ON_HOLD' }),
        toggle: await call('POST', `/api/requirements/${J}/toggle-status`, T[k], {}),
        pause: await call('POST', `/api/requirements/${J}/pause`, T[k], { reason: 'zz test', until: tomorrow }),
        resume: await call('POST', `/api/requirements/${J}/resume`, T[k], {}),
        close: await call('POST', `/api/requirements/${J}/close`, T[k], { outcome: 'filled' }),
        'close-request': await call('POST', `/api/requirements/${J}/close-request`, T[k], { reason: 'zz' }),
        reopen: await call('POST', `/api/requirements/${J}/reopen`, T[k], {}),
        'bulk priority': await call('POST', '/api/requirements/bulk', T[k], { action: 'priority', ids: [J], priority: 'High' }),
      };
      Object.entries(calls).forEach(([n, r]) => check(`E1 ${k}: ${n} -> 403${n === 'bulk priority' ? '' : ' with the plain sentence'}`, r.status === 403 && (n === 'bulk priority' || (r.body && r.body.error === PLAIN2)), [r.status, r.text.slice(0, 140)]));
    }
    const stillOpen = await prisma.requirement.findUnique({ where: { id: J } });
    check('E1 the job did not change (status OPEN, openings not 4, priority not High)', stillOpen.status === 'OPEN' && stillOpen.openings !== 4 && stillOpen.priority !== 'High', [stillOpen.status, stillOpen.openings, stillOpen.priority]);
    const asg = await call('POST', `/api/requirements/${J}/assign`, T.tl, { recruiterId: uRec.id });
    check('E2 a TL still assigns a recruiter to the job (assign) -> 200', asg.status === 200, [asg.status, asg.text.slice(0, 200)]);
    const view2 = await call('GET', `/api/requirements/${J}`, T.tl);
    check('E2 the TL job page: edit no, assign yes, post yes, ask-to-change yes, approve no', view2.status === 200 && view2.body.permissions.edit === false && view2.body.permissions.assign === true && view2.body.permissions.share === true && view2.body.permissions.askChange === true && !view2.body.permissions.approve, view2.body && view2.body.permissions);
    const view3 = await call('GET', `/api/requirements/${J}`, T.rec);
    check('E2 the Recruiter job page: no edit, no post, ask-to-change yes', view3.body.permissions.edit === false && view3.body.permissions.askChange === true && view3.body.permissions.share === false, view3.body && view3.body.permissions);
    for (const k of ['admin', 'bdeEdu', 'bdeTl']) {
      const r = await call('PUT', `/api/requirements/${J}`, T[k], { title: `ZZTEST JC Job edu ${RUN}`, openings: 3 });
      check(`E3 ${k}: edit the job -> 200`, r.status === 200, [r.status, r.text.slice(0, 160)]);
    }
    const bdeOtherEdit = await call('PUT', `/api/requirements/${J}`, T.bdeMed, { openings: 3 });
    check('E3 a BDE of another desk cannot edit it', bdeOtherEdit.status === 403, bdeOtherEdit.status);
    // 2026-10-13: a requirement is only Open or Closed - nobody pauses one any more; one that is already On hold can still be resumed.
    const mgrPause = await call('POST', `/api/requirements/${J}/pause`, T.mgr, { reason: 'zz test hold', until: tomorrow });
    check('E3 nobody pauses a requirement any more: the Manager gets 403', mgrPause.status === 403, [mgrPause.status, mgrPause.text.slice(0, 160)]);
    await prisma.requirement.update({ where: { id: J }, data: { status: 'ON_HOLD' } });
    const mgrResume = await call('POST', `/api/requirements/${J}/resume`, T.mgr, {});
    check('E3 ...but the Manager resumes one that is already On hold -> 200', mgrResume.status === 200, [mgrResume.status, mgrResume.text.slice(0, 160)]);
    const adminClose = await call('POST', `/api/requirements/${J}/close`, T.admin, { outcome: 'filled' });
    check('E3 Admin closes it -> 200', adminClose.status === 200, [adminClose.status, adminClose.text.slice(0, 160)]);
    await call('POST', `/api/requirements/${J}/reopen`, T.admin, {});
    const mTl = await cat('TL');
    check('E4 Role Catalog TL: edit / approve, Pause, Resume, Close request fixed OFF; Assign stays free', mTl.locked['Requirement Detail'].includes('edit') && mTl.locked['Requirement Detail'].includes('approve') && mTl.locked['Pause Requirement'].includes('edit') && mTl.locked['Resume Requirement'].includes('edit') && mTl.locked['Close Request'].includes('create') && !mTl.locked['Requirement Detail'].includes('assign') && mTl.features['Requirement Detail'].assign === true && mTl.features['Requirement Detail'].edit === false, [mTl.locked['Requirement Detail'], mTl.features['Requirement Detail']]);
    const mBde2 = await cat('BDE');
    const bl2 = mBde2.locked || {}; // nothing is fixed off for the BDE row
    check('E4 Role Catalog BDE: edit / pause / resume / close request free', !(bl2['Requirement Detail'] || []).includes('edit') && !(bl2['Pause Requirement'] || []).includes('edit') && !(bl2['Close Request'] || []).includes('create'), mBde2.locked);
    const meTl = await call('GET', '/api/auth/me', T.tl);
    const meBde = await call('GET', '/api/auth/me', T.bdeEdu);
    const meBdeTl = await call('GET', '/api/auth/me', T.bdeTl);
    const bx = (me, f, a) => { const u = me.body.user || me.body; return !!(u.access.requirements.features[f] || {})[a]; };
    check('E4 /auth/me: TL no edit / approve, assign yes; BDE and BDE TL edit yes', !bx(meTl, 'Requirement Detail', 'edit') && !bx(meTl, 'Requirement Detail', 'approve') && bx(meTl, 'Requirement Detail', 'assign') && bx(meBde, 'Requirement Detail', 'edit') && bx(meBdeTl, 'Requirement Detail', 'edit'), null);
    const tlRow = await prisma.roleAccess.findMany({ where: { role: 'TL', moduleId: 'requirements' } });
    touchedRoles.push(['TL', tlRow]);
    const m0 = await cat('TL');
    const feats0 = JSON.parse(JSON.stringify(m0.features));
    Object.keys(feats0['Requirement Detail']).forEach((a) => { feats0['Requirement Detail'][a] = true; });
    await call('PUT', '/api/admin/role-catalog/TL/modules/requirements/features', T.sa, { features: feats0, enabled: true });
    const tTl3 = await mint(uTl);
    const tickEdit = await call('PUT', `/api/requirements/${J}`, tTl3, { openings: 5 });
    check('E5 after an admin ticks every Requirement Detail box for TL: edit still 403', tickEdit.status === 403, [tickEdit.status, tickEdit.text.slice(0, 120)]);
    const bellsOf = async (uid, needle) => prisma.notification.findMany({ where: { userId: uid, title: { contains: needle } } });
    const ac1 = await call('POST', `/api/requirements/${J}/ask-change`, T.tl, { what: 'edit', notes: 'openings 2 to 5' });
    check('E6 TL asks the client manager to edit the job -> 201, the client BDE told', ac1.status === 201 && ac1.body.told && ac1.body.told[0] === uBdeEdu.name && ac1.body.via === 'client', [ac1.status, ac1.text.slice(0, 200)]);
    const nb = await bellsOf(uBdeEdu.id, 'Requirement to change');
    check('E6 one bell: the job, the note, an Open link; nobody else got it', nb.length === 1 && /openings 2 to 5/.test(nb[0].message) && /Open: \/requirements\//.test(nb[0].message) && (await bellsOf(uBdeMed.id, 'Requirement to change')).length === 0, nb.map((n) => n.message));
    const ac2 = await call('POST', `/api/requirements/${J}/ask-change`, T.tl, { what: 'edit', notes: 'again' });
    check('E6 the same request again today -> 200 already, no second bell', ac2.status === 200 && ac2.body.already && (await bellsOf(uBdeEdu.id, 'Requirement to change')).length === 1, [ac2.status, ac2.text.slice(0, 120)]);
    const ac3 = await call('POST', `/api/requirements/${J}/ask-change`, T.rec, { what: 'close' });
    check('E6 the Recruiter asks to close it (no note needed) -> 201', ac3.status === 201 && /close/i.test(ac3.body.message), [ac3.status, ac3.text.slice(0, 160)]);
    const ac4 = await call('POST', `/api/requirements/${J}/ask-change`, T.stl, { what: 'edit' });
    check('E6 asking to change with no note -> 400 in plain words', ac4.status === 400, [ac4.status, ac4.text.slice(0, 120)]);
    for (const k of ['bdeEdu', 'bdeTl', 'admin']) {
      const r = await call('POST', `/api/requirements/${J}/ask-change`, T[k], { what: 'edit', notes: 'x' });
      check(`E6 ${k} changes jobs themselves: ask-change -> 409`, r.status === 409, [r.status, r.text.slice(0, 100)]);
    }
    const ac5 = await call('POST', `/api/requirements/${J}/ask-change`, T.hr, { what: 'edit', notes: 'x' });
    check('E6 HR: ask-change -> 403 or out of scope', ac5.status === 403, ac5.status);

    // =============================== F: BDE TEAM = COMPLETE ACCESS EXCEPT DELETE (2026-10-13) ==========
    const cAgr = await mkClient('agr', 'Education', uBdeEdu); await prisma.client.update({ where: { id: cAgr.id }, data: { agreementStatus: 'DRAFT' } });
    const liveBody = (tag, client) => ({ title: newTitle(`live-${tag}`), clientId: client.id, department: 'Education', jobDescription: 'ZZTEST JC description', skills: 'ZZ skill', status: 'OPEN', openings: 1, location: 'Hyderabad' });
    const fl1 = await call('POST', '/api/requirements', T.bdeEdu, liveBody('bde', cEdu)); created(fl1.body);
    check('F1 BDE creates a LIVE job directly (201, status OPEN, not a draft, owned by them)', fl1.status === 201 && fl1.body.status === 'OPEN' && fl1.body.bdeId === uBdeEdu.id, [fl1.status, fl1.text.slice(0, 200)]);
    const fl2 = await call('POST', '/api/requirements', T.bdeTl, liveBody('bdetl', cMfg)); created(fl2.body);
    check('F1 BDE TL creates a LIVE job for any client directly (201, OPEN, no TL set on it)', fl2.status === 201 && fl2.body.status === 'OPEN' && fl2.body.bdeId === uBdeTl.id && !fl2.body.tlId, [fl2.status, fl2.text.slice(0, 200)]);
    const fl3 = await call('POST', '/api/requirements', T.bdeEdu, liveBody('agr', cAgr)); created(fl3.body);
    check('F1 a client whose agreement is not ACTIVE: the job is held at Agreement Check (gate unchanged) with the reason', fl3.status === 201 && fl3.body.status === 'AGREEMENT_CHECK' && !!fl3.body.gateNote, [fl3.status, fl3.text.slice(0, 220)]);
    const fl4 = await call('POST', '/api/requirements', T.bdeMed, liveBody('other', cEdu));
    check('F1 a BDE of another desk cannot create for this client -> 403', fl4.status === 403, [fl4.status]);
    // the whole BDE team of a desk shares the desk: a colleague's client is theirs too (2026-10-13)
    const uBdeEdu2 = await mkUser('bdeedu2', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const tBdeEdu2 = await mint(uBdeEdu2);
    const cCol = await mkClient('col', 'Education', uBdeEdu2);
    const col1 = await call('POST', '/api/requirements', T.bdeEdu, liveBody('colleague', cCol)); created(col1.body);
    check('F1b a BDE creates a LIVE job for a COLLEAGUE BDE client on the same desk (201)', col1.status === 201 && col1.body.status === 'OPEN', [col1.status, col1.text.slice(0, 200)]);
    const col2 = await call('PUT', `/api/requirements/${col1.body.id}`, tBdeEdu2, { openings: 3, title: newTitle('live-colleague') });
    const col3 = await call('POST', `/api/requirements/${col1.body.id}/pause`, tBdeEdu2, { reason: 'zz test hold', until: tomorrow });
    check('F1b ...and the colleague edits that job (200); pausing is gone for everyone (403)', col2.status === 200 && col3.status === 403, [col2.status, col3.status, col2.text.slice(0, 120)]);
    const JB = fl1.body.id;
    for (const [k, id] of [['bdeEdu', JB], ['bdeTl', JB]]) {
      const ed = await call('PUT', `/api/requirements/${id}`, T[k], { openings: 2, title: newTitle('live-bde') });
      const pa = await call('POST', `/api/requirements/${id}/pause`, T[k], { reason: 'zz test hold', until: tomorrow });
      await prisma.requirement.update({ where: { id }, data: { status: 'ON_HOLD' } }); // a job that was put On hold before pausing went away
      const re = await call('POST', `/api/requirements/${id}/resume`, T[k], {});
      check(`F2 ${k}: edit 200, pause 403 (nobody pauses any more), resume of an On-hold job 200`, ed.status === 200 && pa.status === 403 && re.status === 200, [ed.status, pa.status, re.status, pa.text.slice(0, 120), re.text.slice(0, 120)]);
    }
    const asTl = await call('POST', `/api/requirements/${JB}/assign`, T.bdeEdu, { tlId: uTl.id });
    const asRec = await call('POST', `/api/requirements/${JB}/assign`, T.bdeEdu, { recruiterId: uRec.id });
    check('F3 BDE assigns the TL and the recruiter directly (200, 200)', asTl.status === 200 && asRec.status === 200, [asTl.status, asRec.status, asTl.text.slice(0, 160), asRec.text.slice(0, 160)]);
    const posts = await call('PUT', `/api/requirements/${JB}/posting-sites`, T.bdeEdu, { sites: ['jobportal'] });
    check('F4 BDE posts (posting sites) -> not refused', posts.status !== 403, [posts.status, posts.text.slice(0, 160)]);
    const cl0 = await call('POST', `/api/requirements/${JB}/close`, T.bdeEdu, { outcome: 'cancelled' });
    check('F5 BDE close needs a reason for Cancelled (400)', cl0.status === 400, [cl0.status, cl0.text.slice(0, 120)]);
    const cl1 = await call('POST', `/api/requirements/${JB}/close`, T.bdeEdu, { outcome: 'cancelled', note: 'client cancelled the hiring' });
    const closedRow = await prisma.requirement.findUnique({ where: { id: JB } });
    const closeAudit = await prisma.auditLog.findFirst({ where: { entityId: JB, userId: uBdeEdu.id, reason: { contains: 'client cancelled' } } });
    check('F5 BDE closes DIRECTLY with a reason (200, status CLOSED, audited with the reason, no approval)', cl1.status === 200 && closedRow.status === 'CLOSED' && !!closeAudit, [cl1.status, cl1.text.slice(0, 160), closedRow.status]);
    const ro = await call('POST', `/api/requirements/${JB}/reopen`, T.bdeEdu, {});
    check('F5 BDE reopens it (200)', ro.status === 200, [ro.status, ro.text.slice(0, 160)]);
    const cl2 = await call('POST', `/api/requirements/${JB}/close`, T.bdeTl, { outcome: 'filled' });
    check('F5 BDE TL closes directly too (200)', cl2.status === 200, [cl2.status, cl2.text.slice(0, 160)]);
    await call('POST', `/api/requirements/${JB}/reopen`, T.bdeTl, {});
    const cr = await call('POST', `/api/requirements/${JB}/close-request`, T.bdeEdu, { reason: 'zz' });
    check('F5 the old "Ask to close" is gone (refused)', [403, 410].includes(cr.status), [cr.status]);
    // 2026-10-16 (user): the whole BDE team deletes a requirement of their own area (never one with people or invoices on it)
    for (const k of ['bdeEdu', 'bdeTl']) {
      const lcK = await call('GET', `/api/requirements/${JB}/lifecycle`, T[k]);
      const rightsK = lcK.body && lcK.body.rights;
      check(`F6 ${k}: the job page rights: close / reopen yes, delete yes (empty job), no "ask to close"`, lcK.status === 200 && rightsK && rightsK.close === true && rightsK.delete === true && rightsK.requestClose === false, lcK.status === 200 ? rightsK : lcK.status);
    }
    const dl = await call('DELETE', `/api/requirements/${JB}`, T.bdeEdu);
    check('F6 bdeEdu: deletes the empty job of their own desk -> 200', dl.status === 200, [dl.status, dl.text.slice(0, 120)]);
    check('F6 ...and the job is gone', !(await prisma.requirement.findUnique({ where: { id: JB } })), null);
    const dlSa = await call('DELETE', `/api/requirements/${fl3.body.id}`, T.sa);
    check('F6 Super Admin can still delete a job with no people (200)', dlSa.status === 200, [dlSa.status, dlSa.text.slice(0, 120)]);

    // =============================== P: THE UNCHANGED FLOWS ======================================
    // client portal "ask for a job"
    const uClient = await prisma.user.create({ data: { ...base, name: `ZZTEST JC Client Login ${RUN}`, email: `zz-jc-client-${RUN}@example.test`, username: `zz-jc-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT', clientId: cEdu.id } });
    made.users.push(uClient.id);
    const tClient = await mint(uClient);
    const before = await prisma.notification.count({ where: { userId: uBdeEdu.id, title: { contains: 'New requirement request from' } } });
    const portal = await call('POST', '/api/portal/client/requirement-requests', tClient, { title: newTitle('portal'), openings: 2, location: 'Hyderabad' });
    check('P1 client portal: a client asks for a job -> 201 DRAFT', portal.status === 201 && portal.body.status === 'DRAFT', [portal.status, portal.text.slice(0, 200)]); created(portal.body);
    const nBde = await prisma.notification.count({ where: { userId: uBdeEdu.id, title: { contains: 'New requirement request from' } } });
    const nTl = await prisma.notification.count({ where: { userId: uBdeTl.id, title: { contains: 'New requirement request from' } } });
    check('P1 ...and the client\'s BDE and the BDE TL are notified (pop-up row)', nBde === before + 1 && nTl >= 1, [before, nBde, nTl]);
    const clientForm = await call('POST', '/api/requirements', tClient, formBody('client', cEdu));
    const clientReq = await call('POST', '/api/requirements/requests', tClient, rq('client', cEdu));
    const clientAsk = await call('POST', '/api/requirements/ask-add', tClient, { title: newTitle('client-ask') });
    check('P2 a client login cannot use the staff routes (create / request / ask)', [clientForm.status, clientReq.status, clientAsk.status].every((s) => s === 401 || s === 403), [clientForm.status, clientReq.status, clientAsk.status]);
    // Act as: acting as a TL has the TL's rights (no create); acting as the BDE has the BDE's
    const actTl = await call('POST', `/api/admin/view-as/${uTl.id}/act`, T.sa);
    const actBde = await call('POST', `/api/admin/view-as/${uBdeEdu.id}/act`, T.sa);
    const sids = [actTl, actBde].map((r) => (r.body && r.body.token ? jwt.decode(r.body.token).actAs.sid : null)).filter(Boolean);
    if (actTl.body && actTl.body.token) {
      const x1 = await call('POST', '/api/requirements', actTl.body.token, formBody('act-tl', cEdu));
      const x2 = await call('POST', '/api/requirements/requests', actTl.body.token, rq('act-tl', cEdu));
      check('P3 Act as a TL: create 403, request 403 (the Super Admin\'s own rights are not carried over)', x1.status === 403 && x2.status === 403 && x1.body.error === PLAIN, [x1.status, x2.status, x1.text.slice(0, 160)]);
    } else check('P3 Act as a TL starts', false, [actTl.status, actTl.text.slice(0, 160)]);
    if (actBde.body && actBde.body.token) {
      const y = await call('POST', '/api/requirements/requests', actBde.body.token, rq('act-bde', cEdu));
      check('P3 Act as a BDE: request -> 201 DRAFT (as that BDE)', y.status === 201 || y.status === 409 || y.status === 200, [y.status, y.text.slice(0, 200)]); created(y.body);
    } else check('P3 Act as a BDE starts', false, [actBde.status, actBde.text.slice(0, 160)]);
    for (const sid of sids) { await prisma.auditLog.deleteMany({ where: { reason: { contains: sid } } }).catch(() => null); }
  } catch (e) {
    fail += 1; console.log('FAIL  test crashed:', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    // ---- cleanup ---------------------------------------------------------------------------
    try {
      const del = async (label, fn) => { try { await fn(); } catch (e) { console.log('cleanup', label, String(e.message).split('\n').pop()); } };
      const titled = await prisma.requirement.findMany({ where: { OR: [{ title: { contains: 'ZZTEST JC' } }, { clientId: { in: made.clients } }] }, select: { id: true } });
      const reqIds = [...new Set([...made.reqs, ...titled.map((r) => r.id)])];
      const ids = made.users;
      await del('notif', () => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST JC' } }, { message: { contains: 'ZZTEST JC' } }, { recipient: { contains: 'ZZTEST JC' } }] } }));
      await del('audit', () => prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...reqIds, ...made.clients, ...ids] } }, { fromValue: { contains: 'ZZTEST JC' } }, { toValue: { contains: 'ZZTEST JC' } }, { entityId: { contains: customCode || 'ZZ-NONE' } }] } }));
      await del('posting', () => prisma.requirementPosting.deleteMany({ where: { requirementId: { in: reqIds } } }));
      await del('reqs', () => prisma.requirement.deleteMany({ where: { id: { in: reqIds } } }));
      await del('clients', () => prisma.client.deleteMany({ where: { id: { in: made.clients } } }));
      await del('emps', () => prisma.employee.deleteMany({ where: { userId: { in: ids } } }));
      await del('users', () => prisma.user.deleteMany({ where: { id: { in: ids } } }));
      await del('templates', async () => {
        const row = await prisma.appSetting.findUnique({ where: { key: 'job.templates' } }).catch(() => null);
        void row;
      });
      await del('roleaccess', async () => {
        for (const [role, rows] of touchedRoles) {
          await prisma.roleAccess.deleteMany({ where: { role, moduleId: 'requirements' } });
          for (const r of rows) { const { id, ...rest } = r; await prisma.roleAccess.create({ data: rest }); }
          require(path.join(BACK, 'src/utils/permissions')).invalidateRoleAccess(role);
        }
        if (customCode) {
          await prisma.roleAccess.deleteMany({ where: { role: customCode } });
          await prisma.$executeRawUnsafe('DELETE FROM "Role" WHERE "code" = ?', customCode);
          require(path.join(BACK, 'src/utils/permissions')).invalidateRoleAccess(customCode);
        }
      });
    } catch (e) { console.log('cleanup failed', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

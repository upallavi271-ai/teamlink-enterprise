#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BDE TL TEAM + BDE-DEPARTMENT EDIT RIGHTS acceptance tests (2026-10-10). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/bdetl-team-test.js
//
//   T  Team list (Recruiter & BDE): BDE TL / BDE / recruiter / TL / Manager / Admin
//        - the BDE TL leads the BDE TEAM ONLY: the client managers of the BDE desk with
//          their numbers; NO recruiter of any department, no recruiting-TL row for her
//          (no Team-leads table of any viewer contains her), no company numbers on her
//        - a BDE sees only their own row
//        - no salary / bank / PAN / candidate contact in any team payload
//   M  /auth/me matrix: the BDE TL's buttons equal what the API accepts; the
//        "Candidate Contact & Salary" switch reads OFF for the BDE TL
//   W  real logins (not "View as"): BDE TL and BDE can save (client, job, notes,
//        posting sites); Manager and Recruiter still cannot
//   V  "View as" stays read-only
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const { can, effectiveMatrix } = require(path.join(BACK, 'src/utils/permissions'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''}`);
}
async function call(method, p, token, body, headers) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(headers || {}) };
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
// Keys that must never appear in a team payload (employee money / ID papers, candidate pay / contact).
const BANNED_KEYS = /^(salary|ctc|currentsalary|expectedsalary|offeredctc|offernotes|bankaccount|bankaccountnumber|bankname|ifsc|ifsccode|pan|pannumber|aadhaar|aadhaarnumber|uan|pfnumber|esinumber|phone|mobile|candidateemail|resumescore|matchscore|dob|currentcompany)$/i;
function bannedKeys(o, acc = new Set()) {
  if (Array.isArray(o)) o.forEach((x) => bannedKeys(x, acc));
  else if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (BANNED_KEYS.test(k)) acc.add(k); bannedKeys(o[k], acc); });
  return [...acc];
}
const sum = (c) => Object.values(c || {}).reduce((n, v) => n + (Number(v) || 0), 0);

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST BT ${tag} ${RUN}`, email: `zz-bt-${tag}-${RUN}@example.test`, username: `zz-bt-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({
          data: { employeeCode: `ZZTEST-BT-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra },
        });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsAccess: true, hrmsRole: 'MANAGER' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBdeEdu = await mkUser('bdeedu', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uBdeMed = await mkUser('bdemed', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: uBdeTl.name });
    const uRecEdu = await mkUser('recedu', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uRecMed = await mkUser('recmed', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    const uRecMfg = await mkUser('recmfg', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' }, {});
    const uRecIdle = await mkUser('recidle', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    const uTlEdu = await mkUser('tledu', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, bdeTl: uBdeTl, bdeEdu: uBdeEdu, bdeMed: uBdeMed, recEdu: uRecEdu, recMed: uRecMed, recMfg: uRecMfg, tlEdu: uTlEdu })) T[k] = await mint(u);

    // ---- clients + jobs + people in process --------------------------------------------------
    const mkClient = async (tag, dept, bde) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST BT Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: bde ? bde.name : null, clientType: 'Client' } });
      made.clients.push(c.id); return c;
    };
    const cEdu = await mkClient('edu', 'Education', uBdeEdu);
    const cMed = await mkClient('med', 'Medical', uBdeMed);
    const cMfg = await mkClient('mfg', 'Manufacturing', null);
    const mkReq = async (tag, client, dept, rec, bde, tl) => {
      const r = await prisma.requirement.create({
        data: { title: `ZZTEST BT Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: dept, recruiterId: rec.id, bdeId: bde ? bde.id : null, tlId: tl ? tl.id : null, openings: 1 },
      });
      made.reqs.push(r.id); return r;
    };
    const rEdu = await mkReq('edu', cEdu, 'Education', uRecEdu, uBdeEdu, uTlEdu);
    const rMed = await mkReq('med', cMed, 'Medical', uRecMed, uBdeMed, null);
    const rMfg = await mkReq('mfg', cMfg, 'Manufacturing', uRecMfg, null, null);
    const SECRET = { email: `zz-bt-cand-${RUN}@example.test`, phone: '9000000077', currentSalary: '7L', expectedSalary: '9L' };
    const mkApp = async (tag, req, stage) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST BT Cand ${tag} ${RUN}`, ...SECRET, location: 'ZZ' } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage } });
      made.apps.push(a.id); return a;
    };
    await mkApp('edu1', rEdu, 'WITH_BDE');
    await mkApp('edu2', rEdu, 'SHARED_WITH_CLIENT');
    await mkApp('edu3', rEdu, 'INTERVIEW_SCHEDULED');
    await mkApp('med1', rMed, 'SHARED_WITH_CLIENT');
    await mkApp('mfg1', rMfg, 'OFFER');
    await mkApp('mfg0', rMfg, 'RECRUITER_REVIEW'); // before the BDE step: the BDE team never sees it

    // =============================== T: the Team list ===================================
    // THE BDE TL LEADS THE BDE TEAM ONLY (user, 2026-10-10): the client managers of the BDE desk.
    // No recruiters, no recruiting-TL row for her, no company-wide numbers on a person row.
    const teamOf = async (tok) => call('GET', '/api/ats/team?shape=v2&fresh=1', tok);
    const tBdeTl = await teamOf(T.bdeTl);
    const rows = (tBdeTl.body && tBdeTl.body.rows) || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    check('T1 BDE TL opens the Team list', tBdeTl.status === 200 && rows.length > 0, tBdeTl.status);
    check('T2 BDE TL sees the BDE desk (BDE EDU, BDE MED)', byId.has(uBdeEdu.id) && byId.has(uBdeMed.id), rows.map((r) => r.name));
    check('T3 NO recruiter of any department is in the BDE TL\'s Team list (not Education, Medical, Manufacturing)',
      !rows.some((r) => r.role === 'RECRUITER') && !byId.has(uRecEdu.id) && !byId.has(uRecMed.id) && !byId.has(uRecMfg.id) && !byId.has(uRecIdle.id), rows.filter((r) => r.role !== 'BDE').map((r) => [r.name, r.role]));
    check('T4 every row of the BDE TL\'s list is a client manager (BDE); no TL / STL row', rows.every((r) => r.role === 'BDE' && r.roleGroup === 'BDE'), rows.map((r) => [r.name, r.role]));
    check('T5 she has no person row (no company-wide numbers on her) and the list says she leads the BDE team',
      !byId.has(uBdeTl.id) && !!tBdeTl.body.bdeTl && tBdeTl.body.bdeTl.clientManagers >= 2, tBdeTl.body && tBdeTl.body.bdeTl);
    const edu = byId.get(uBdeEdu.id);
    check('T6 a client manager row: name, clients, open jobs, sent to client, interviews, in process, last activity',
      !!edu && edu.counts.clients >= 1 && edu.counts.openRequirements >= 1 && edu.counts.activeCandidates >= 3 && edu.counts.submitted >= 2 && edu.counts.interviews >= 1 && !!edu.lastActiveAt, edu);
    const med = byId.get(uBdeMed.id);
    check('T7 the other desk member has his own numbers (Medical client)', !!med && med.counts.clients >= 1 && med.counts.openRequirements >= 1 && med.counts.submitted >= 1, med && med.counts);
    check('T8 nobody who has data shows a row of empty numbers', [edu, med].every((r) => Object.values(r.counts).some((v) => v > 0)));
    const bad = bannedKeys(tBdeTl.body);
    check('T10 no salary / bank / PAN / contact key in the BDE TL team payload', bad.length === 0, bad);
    check('T11 no candidate e-mail / phone / salary value in the team payload', !/9000000077|zz-bt-cand-|7L|9L/.test(tBdeTl.text), tBdeTl.text.length);
    const d360 = await call('GET', `/api/ats/team/${uBdeEdu.id}`, T.bdeTl);
    check('T12 the BDE TL opens a client manager\'s 360', d360.status === 200 && d360.body && d360.body.person && d360.body.person.id === uBdeEdu.id, d360.status);
    check('T13 the 360 has no salary / bank / contact', bannedKeys(d360.body).length === 0 && !/9000000077|zz-bt-cand-|7L|9L/.test(d360.text), bannedKeys(d360.body));
    for (const metric of ['clients', 'openRequirements', 'submitted', 'interviews', 'activeCandidates']) {
      const l = await call('GET', `/api/ats/team/${uBdeEdu.id}?metric=${metric}`, T.bdeTl);
      check(`T14 list "${metric}" opens and carries no contact / pay`, l.status === 200 && bannedKeys(l.body).length === 0 && !/9000000077|zz-bt-cand-|7L|9L/.test(l.text), [l.status, bannedKeys(l.body)]);
    }
    const recOpen = await call('GET', `/api/ats/team/${uRecEdu.id}`, T.bdeTl);
    check('T15 a recruiter is outside the BDE TL\'s team: opening their 360 is refused', recOpen.status === 403, recOpen.status);
    const selfOpen = await call('GET', `/api/ats/team/${uBdeTl.id}`, T.bdeTl);
    check('T16 the BDE TL has no "team lead" 360 of company numbers either', selfOpen.status === 403 || selfOpen.status === 404, selfOpen.status);
    for (const view of ['assignments', 'pending']) {
      const v = await call('GET', `/api/ats/team?view=${view}`, T.bdeTl);
      check(`T16b the ${view} tab opens for the BDE TL`, v.status === 200, v.status);
    }
    // Team-leads tables never carry the BDE TL (dashboard + Team page), for any viewer.
    // (the dashboard hides ZZTEST people by design, so these read the real BDE TL of the copied data)
    const realTl = await prisma.user.findFirst({ where: { atsRole: 'TL', atsDepartment: 'BDE', status: 'Active', NOT: { email: { endsWith: '@example.test' } } }, select: { id: true, name: true } });
    if (realTl) {
      const tReal = await mint(realTl);
      const realTeam = await call('GET', '/api/ats/team?shape=v2&fresh=1', tReal);
      const realRows = (realTeam.body && realTeam.body.rows) || [];
      check('T17 the real BDE TL\'s Team list is the BDE desk only (no recruiter, no TL row, not herself)',
        realTeam.status === 200 && realRows.length > 0 && realRows.every((r) => r.role === 'BDE') && !realRows.some((r) => r.id === realTl.id), realRows.map((r) => [r.name, r.role]));
      check('T18 the real BDE TL line: she leads the client managers', !!realTeam.body.bdeTl && realTeam.body.bdeTl.clientManagers >= 1, realTeam.body.bdeTl);
      const fm = await call('GET', '/api/ats/team?view=former', tReal);
      check('T18b the "Former" filter of the BDE TL holds client managers only (no former recruiter)', fm.status === 200 && (fm.body.rows || []).every((r) => r.roleGroup === 'BDE'), (fm.body.rows || []).map((r) => [r.name, r.role]));
      for (const [who, tok] of [['BDE TL', tReal], ['Admin', T.admin], ['Manager', T.mgr]]) {
        const tls = await call('GET', '/api/dashboard/ats/home/list?set=__tls', tok);
        const inTable = tls.body && JSON.stringify(tls.body).includes(realTl.id);
        check(`T19 the "Team leads" table of the ${who} does not contain the BDE TL (${realTl.name})`, tls.status === 200 && !inTable, [tls.status, tls.body && (tls.body.rows || []).map((r) => r.name)]);
      }
      const rowsAs = async (tok) => ((await call('GET', '/api/ats/team?shape=v2', tok)).body || {}).rows || [];
      const adminRows = await rowsAs(T.admin);
      const mgrRows = await rowsAs(T.mgr);
      check('T20 Admin and Manager: no row for the BDE TL in the Team page (no "TL" row with 2,501 jobs)',
        !adminRows.some((r) => r.id === realTl.id) && !mgrRows.some((r) => r.id === realTl.id) && !adminRows.some((r) => r.roleGroup === 'TL' && /BDE/i.test(r.department || '')), []);
      const dash = await call('GET', '/api/dashboard/ats/home', tReal);
      const tw = dash.body && (dash.body.widgets || []).find((w) => w.id === 'team');
      const names = tw ? tw.groups.flatMap((g) => g.rows.map((r) => r.name)) : [];
      check('T21 the BDE TL dashboard "BDE team" box lists the BDE desk (name + seat) and no recruiter',
        !!tw && tw.title === 'BDE team' && tw.groups.length === 1 && /BDE/i.test(tw.groups[0].title) && names.length >= 1 && names.every((n) => /BDE/.test(n)) && !JSON.stringify(tw).includes('Recruiters'), names);
      // ---- every dashboard variant: the "BDE team" box and the whole page carry no recruiter / TL ----
      const staff = (await prisma.user.findMany({ where: { atsRole: { in: ['RECRUITER', 'TL', 'STL'] }, status: 'Active', NOT: [{ id: realTl.id }, { email: { endsWith: '@example.test' } }] }, select: { name: true } }))
        .map((u) => u.name.trim()).filter((n) => n.length > 4);
      const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const staffIn = (text) => [...new Set(staff.filter((n) => new RegExp(`(^|[^A-Za-z])${esc(n)}([^A-Za-z]|$)`).test(text)))];
      let firstDrills = null;
      for (const q of ['', '?v3=1', '?v3=0', '?range=this_week', '?range=all', '?recruiterId=u:none&tl=x']) {
        const d = await call('GET', `/api/dashboard/ats/home${q}`, tReal);
        const w = d.body && (d.body.widgets || []).find((x) => x.id === 'team');
        const page = d.body ? JSON.stringify({ ...d.body, filterOptions: undefined }) : '';
        check(`T22 dashboard ${q || '(default)'}: "BDE team" lists the client managers only, no recruiter / TL anywhere on the page`,
          d.status === 200 && !!w && w.title === 'BDE team' && w.groups.length === 1 && !/ecruiters/.test(JSON.stringify(w)) && staffIn(page).length === 0
          && (d.body.filtersHidden || []).includes('recruiter') && (d.body.filtersHidden || []).includes('tl') && !(d.body.filterOptions || {}).recruiter && !(d.body.filterOptions || {}).tl,
          { title: w && w.title, groups: w && w.groups.map((g) => g.title), names: staffIn(page), hidden: d.body && d.body.filtersHidden });
        if (!firstDrills) firstDrills = [...new Set([...page.matchAll(/"drill":"([^"]+)"/g)].map((m) => m[1]))];
      }
      for (const id of firstDrills) {
        const l = await call('GET', `/api/dashboard/ats/home/list?set=${encodeURIComponent(id)}`, tReal);
        check(`T23 click-open list "${id}" shows no recruiter / TL name or column`, l.status === 200 && staffIn(l.text).length === 0 && !/"recruiter":"|"tl":"|"d_rec"|"d_tl"/.test(l.text), staffIn(l.text));
      }
      for (const v of ['assignments', 'pending']) {
        const t = await call('GET', `/api/ats/team?view=${v}`, tReal);
        check(`T24 Team page ${v} tab for the BDE TL: no recruiter / TL name or column`, t.status === 200 && staffIn(t.text).length === 0 && !/"recruiters?":|"tl":|"tlUserId"/.test(t.text), staffIn(t.text));
      }
    } else console.log('SKIP  T17-T24 (no real BDE TL in this sandbox copy)');
    // the same cut on the ZZTEST BDE TL (fixture): the Team tabs name no recruiter
    for (const v of ['assignments', 'pending']) {
      const t = await call('GET', `/api/ats/team?view=${v}`, T.bdeTl);
      check(`T25 (fixture) ${v} tab: no ZZTEST recruiter / TL named`, t.status === 200 && !t.text.includes('ZZTEST BT recedu') && !t.text.includes('ZZTEST BT tledu') && !/"recruiters?":|"tl":|"tlUserId"/.test(t.text));
    }
    const asg = await call('GET', '/api/ats/team?view=assignments', T.bdeTl);
    check('T26 (fixture) the jobs of every client are listed with their client manager', asg.status === 200 && (asg.body.rows || []).length >= 3 && asg.body.rows.every((r) => !('recruiters' in r) && !('tl' in r)) && asg.body.rows.some((r) => r.bde && r.bde.id === uBdeEdu.id));

    // BDE (desk seat): only their own row and numbers
    const tBdeEdu = await teamOf(T.bdeEdu);
    const bRows = (tBdeEdu.body && tBdeEdu.body.rows) || [];
    check('T22 a BDE sees only their own row (no recruiter, no other BDE, no BDE TL)', tBdeEdu.status === 200 && bRows.length === 1 && bRows[0].id === uBdeEdu.id, bRows.map((r) => r.name));
    check('T23 no salary / bank / contact in the BDE payload', bannedKeys(tBdeEdu.body).length === 0 && !/9000000077|zz-bt-cand-|7L|9L/.test(tBdeEdu.text));
    const bdeOpensRec = await call('GET', `/api/ats/team/${uRecEdu.id}`, T.bdeEdu);
    check('T24 a BDE cannot open a recruiter\'s 360 (403)', bdeOpensRec.status === 403, bdeOpensRec.status);
    const bdeOpensSelf = await call('GET', `/api/ats/team/${uBdeEdu.id}`, T.bdeEdu);
    check('T25 a BDE opens their own 360', bdeOpensSelf.status === 200, bdeOpensSelf.status);

    // Recruiter: only themselves
    const tRec = await teamOf(T.recEdu);
    check('T30 a recruiter sees only their own row', tRec.status === 200 && tRec.body.rows.length === 1 && tRec.body.rows[0].id === uRecEdu.id, tRec.body && tRec.body.rows && tRec.body.rows.map((r) => r.name));

    // TL of Education: unchanged — own department's recruiters, not Medical's
    const tTl = await teamOf(T.tlEdu);
    const tlBy = new Map(((tTl.body && tTl.body.rows) || []).map((r) => [r.id, r]));
    check('T31 an Education TL sees the Education recruiter, not the Medical or Manufacturing one', tTl.status === 200 && tlBy.has(uRecEdu.id) && !tlBy.has(uRecMed.id) && !tlBy.has(uRecMfg.id), [...tlBy.values()].map((r) => r.name));
    check('T32 an Education TL does not get the BDE desk or the BDE TL', !tlBy.has(uBdeTl.id) && !tlBy.has(uBdeMed.id), [...tlBy.values()].map((r) => r.name));

    // Manager + Admin: everything (the whole Team list), the BDE TL is not a row
    for (const [who, tok] of [['Manager', T.mgr], ['Admin', T.admin]]) {
      const t = await teamOf(tok);
      const rs = (t.body && t.body.rows) || [];
      check(`T33 ${who} sees the recruiters and the BDE desk, and the BDE TL is not a team-lead row`,
        t.status === 200 && [uRecEdu, uRecMed, uRecMfg, uBdeEdu, uBdeMed].every((u) => rs.some((r) => r.id === u.id)) && !rs.some((r) => r.id === uBdeTl.id),
        { n: rs.length, missing: [uRecEdu, uRecMed, uRecMfg, uBdeEdu, uBdeMed].filter((u) => !rs.some((r) => r.id === u.id)).map((u) => u.name) });
    }

    // =============================== M: the matrix =============================================
    const meTl = await call('GET', '/api/auth/me', T.bdeTl);
    const acc = (meTl.body && meTl.body.access) || {};
    const f = (m, feat, a) => !!(acc[m] && acc[m].features && acc[m].features[feat] && acc[m].features[feat][a]);
    const BTL = [
      ['clients', 'Add Client', 'create'], ['clients', 'Client Detail', 'edit'], ['clients', 'Client Detail', 'assign'], ['clients', 'Client Notes', 'create'],
      ['clients', 'Client Portal Logins', 'create'], ['clients', 'Pause / Reactivate Client', 'create'],
      ['requirements', 'Requirement Request', 'create'], ['requirements', 'Requirement Detail', 'edit'], ['requirements', 'Requirement Detail', 'approve'],
      ['requirements', 'Job Posting', 'create'], ['requirements', 'Job Posting', 'edit'],
    ];
    check('M1 /auth/me draws every right the API gives the BDE TL (Add client, Edit client, Notes, Portal login, Pause, Job request, Edit job, Approve job, Job posting)',
      BTL.every(([m, ft, a]) => f(m, ft, a)), BTL.filter(([m, ft, a]) => !f(m, ft, a)));
    const identTl = await resolveIdentity(uBdeTl.id);
    const diff = [];
    for (const [m, ft, a] of BTL) { if ((await can(identTl, 'ats', m, ft, a)) !== f(m, ft, a)) diff.push([m, ft, a]); }
    check('M2 the drawn matrix equals can() on those cells', diff.length === 0, diff);
    const effTl = await effectiveMatrix(identTl);
    let cellDiff = 0; let cells = 0;
    for (const m of ['clients', 'requirements', 'candidates', 'interviews', 'recruiterbde']) {
      const feats = (effTl[m] && effTl[m].features) || {};
      for (const ft of Object.keys(feats)) {
        for (const a of Object.keys(feats[ft])) {
          cells += 1;
          // eslint-disable-next-line no-await-in-loop
          if (!!feats[ft][a] !== await can(identTl, 'ats', m, ft, a)) { cellDiff += 1; console.log('   cell differs:', m, ft, a, feats[ft][a]); }
        }
      }
    }
    check(`M3 the BDE TL's matrix equals can() on every ATS cell I compared (${cells} cells)`, cellDiff === 0, cellDiff);
    check('M4 "Candidate Contact & Salary" reads OFF for the BDE TL (the data is cut by role)', !f('candidates', 'Candidate Contact & Salary', 'view') && meTl.body.caps && meTl.body.caps.candidateContact === false, meTl.body.caps);
    const meTlEdu = await call('GET', '/api/auth/me', T.tlEdu);
    const accEdu = (meTlEdu.body && meTlEdu.body.access) || {};
    check('M5 an ordinary TL keeps the switch ON and gains no client-desk right',
      accEdu.candidates.features['Candidate Contact & Salary'].view === true && !accEdu.clients.features['Add Client'].create && !accEdu.clients.features['Client Detail'].edit);
    const meMgr = await call('GET', '/api/auth/me', T.mgr);
    const accMgr = (meMgr.body && meMgr.body.access) || {};
    const mf = (m, ft, a) => !!(accMgr[m] && accMgr[m].features && accMgr[m].features[ft] && accMgr[m].features[ft][a]);
    check('M6 a Manager is still view + approve (+ client notes, by design): no Add client, Edit client, Edit job, Job request, Job posting',
      !mf('clients', 'Add Client', 'create') && !mf('clients', 'Client Detail', 'edit') && !mf('requirements', 'Requirement Detail', 'edit')
      && !mf('requirements', 'Requirement Request', 'create') && !mf('requirements', 'Job Posting', 'edit') && !mf('clients', 'Client Portal Logins', 'create'));
    const meBde = await call('GET', '/api/auth/me', T.bdeEdu);
    const accBde = (meBde.body && meBde.body.access) || {};
    check('M7 a BDE draws Add client, Edit client, Notes, Job request, Job posting', ['clients|Add Client|create', 'clients|Client Detail|edit', 'clients|Client Notes|create', 'requirements|Requirement Request|create', 'requirements|Job Posting|edit']
      .every((k) => { const [m, ft, a] = k.split('|'); return accBde[m].features[ft][a] === true; }));
    check('M8 a BDE still has the Candidate Contact & Salary switch OFF', accBde.candidates.features['Candidate Contact & Salary'].view === false);

    // =============================== W: real writes ===========================================
    const rawBdeTlMe = await call('GET', '/api/auth/me', T.bdeTl);
    check('W0 the BDE TL is a real login, not "View as"', rawBdeTlMe.status === 200 && !rawBdeTlMe.body.viewAs, rawBdeTlMe.body && rawBdeTlMe.body.viewAs);
    // BDE TL
    const newC = await call('POST', '/api/clients', T.bdeTl, { name: `ZZTEST BT New Client ${RUN}`, mode: 'draft', ownerDepartment: 'Education' });
    if (newC.body && (newC.body.id || (newC.body.client && newC.body.client.id))) made.clients.push(newC.body.id || newC.body.client.id);
    check('W1 BDE TL adds a client (POST /clients)', [200, 201].includes(newC.status), [newC.status, newC.body]);
    const putOwn = await call('PUT', `/api/clients/${cEdu.id}`, T.bdeTl, { location: 'ZZ Pune' });
    check('W2 BDE TL edits an Education client (PUT /clients/:id)', putOwn.status === 200, [putOwn.status, putOwn.body]);
    const putOther = await call('PUT', `/api/clients/${cMed.id}`, T.bdeTl, { location: 'ZZ Chennai' });
    check('W3 BDE TL edits a Medical client too (they cover every client)', putOther.status === 200, [putOther.status, putOther.body]);
    const note = await call('POST', `/api/clients/${cMfg.id}/notes`, T.bdeTl, { note: `ZZTEST note ${RUN}` });
    check('W4 BDE TL adds a note on any client', note.status === 201, [note.status, note.body]);
    const putJob = await call('PUT', `/api/requirements/${rMed.id}`, T.bdeTl, { title: `ZZTEST BT Job med edited ${RUN}` });
    check('W5 BDE TL edits a client job (PUT /requirements/:id)', putJob.status === 200, [putJob.status, putJob.body]);
    const sites = await call('PUT', `/api/requirements/${rEdu.id}/posting-sites`, T.bdeTl, { sites: ['jobportal'] });
    check('W6 BDE TL saves where a job is posted (Save & Post)', sites.status === 200, [sites.status, sites.body]);
    const request = await call('POST', '/api/requirements/requests', T.bdeTl, { title: `ZZTEST BT Request ${RUN}`, clientId: cEdu.id });
    if (request.body && request.body.id) made.reqs.push(request.body.id);
    check('W7 BDE TL asks for a new job (Requirement Request)', [200, 201].includes(request.status), [request.status, request.body]);
    const link = await call('GET', `/api/clients/${cEdu.id}/link`, T.bdeTl);
    check('W8 BDE TL may send the agreement link of any client (GET link answers, not 403)', link.status !== 403, [link.status, link.body]);
    // BDE (desk seat)
    const bPut = await call('PUT', `/api/clients/${cEdu.id}`, T.bdeEdu, { location: 'ZZ Hyderabad' });
    check('W10 a BDE edits their own client', bPut.status === 200, [bPut.status, bPut.body]);
    const bOther = await call('PUT', `/api/clients/${cMed.id}`, T.bdeEdu, { location: 'ZZ Nope' });
    check('W11 a BDE cannot edit another desk\'s client', bOther.status !== 200, bOther.status);
    const bNote = await call('POST', `/api/clients/${cEdu.id}/notes`, T.bdeEdu, { note: `ZZTEST bde note ${RUN}` });
    check('W12 a BDE adds a note on their client', bNote.status === 201, [bNote.status, bNote.body]);
    const bJob = await call('PUT', `/api/requirements/${rEdu.id}`, T.bdeEdu, { title: `ZZTEST BT Job edu edited ${RUN}` });
    check('W13 a BDE edits their own client\'s job', bJob.status === 200, [bJob.status, bJob.body]);
    const bSites = await call('PUT', `/api/requirements/${rEdu.id}/posting-sites`, T.bdeEdu, { sites: [] });
    check('W14 a BDE saves where their job is posted', bSites.status === 200, [bSites.status, bSites.body]);
    // read-only roles
    const mPut = await call('PUT', `/api/clients/${cEdu.id}`, T.mgr, { location: 'ZZ Mgr' });
    check('W20 a Manager cannot edit a client (403)', mPut.status === 403, mPut.status);
    const mNote = await call('POST', `/api/clients/${cEdu.id}/notes`, T.mgr, { note: `ZZTEST mgr note ${RUN}` });
    check('W21 a Manager can still add a client note (the one write the Manager rule keeps)', mNote.status === 201, mNote.status);
    const mJob = await call('PUT', `/api/requirements/${rEdu.id}`, T.mgr, { title: 'ZZTEST nope' });
    check('W22 a Manager cannot edit a job (403)', mJob.status === 403, mJob.status);
    const mAdd = await call('POST', '/api/clients', T.mgr, { name: `ZZTEST BT Mgr Client ${RUN}`, mode: 'draft' });
    check('W23 a Manager cannot add a client (403)', mAdd.status === 403, mAdd.status);
    const rPut = await call('PUT', `/api/clients/${cEdu.id}`, T.recEdu, { location: 'ZZ Rec' });
    check('W24 a recruiter cannot edit a client (403)', rPut.status === 403, rPut.status);
    const tlPut = await call('PUT', `/api/clients/${cEdu.id}`, T.tlEdu, { location: 'ZZ TL' });
    check('W25 an ordinary TL still cannot edit a client (403)', tlPut.status === 403, tlPut.status);
    const mTeam = await call('PUT', `/api/requirements/${rEdu.id}/assign`, T.mgr, {});
    check('W26 a Manager still cannot assign (not a write route they hold)', [403, 404].includes(mTeam.status), mTeam.status);

    // =============================== V: View as stays read-only ===============================
    const va = await call('POST', `/api/admin/view-as/${uBdeTl.id}`, await (async () => {
      const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true } });
      return sa ? jwt.sign(tokenPayload(await resolveIdentity(sa.id)), process.env.JWT_SECRET, { expiresIn: '10m' }) : null;
    })());
    if (va.status === 200 && va.body && va.body.token) {
      const vTok = va.body.token;
      const vGet = await call('GET', '/api/ats/team?shape=v2', vTok);
const mine = (r) => !/ZZTEST/.test(r.name) || r.name.includes(RUN); // other agents' fixtures may come and go in the sandbox
      const vNames = vGet.body && vGet.body.rows ? vGet.body.rows.filter(mine).map((r) => r.name).sort() : null;
      const myNames = rows.filter(mine).map((r) => r.name).sort();
      check('V1 "View as" the BDE TL shows the same team rows', vGet.status === 200 && JSON.stringify(vNames) === JSON.stringify(myNames), [vNames, myNames]);
      const vPut = await call('PUT', `/api/clients/${cEdu.id}`, vTok, { location: 'ZZ View' });
      check('V2 "View as" cannot save anything (read-only by design: 403)', vPut.status === 403, [vPut.status, vPut.body]);
      await call('POST', '/api/admin/view-as/exit', vTok);
    } else {
      console.log('SKIP  V (no Super Admin in this sandbox copy to start View as):', va.status);
    }
  } catch (e) {
    fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      const ids = made.users;
      const allIds = [...ids, ...made.cands, ...made.clients, ...made.reqs, ...made.apps, ...made.emps];
      // jobs the tests created through the API (requests) are matched by title
      const apiReqs = await prisma.requirement.findMany({ where: { title: { contains: `ZZTEST BT` }, id: { notIn: made.reqs } }, select: { id: true } });
      const reqIds = [...made.reqs, ...apiReqs.map((r) => r.id)];
      const appIds = (await prisma.application.findMany({ where: { OR: [{ id: { in: made.apps } }, { requirementId: { in: reqIds } }] }, select: { id: true } })).map((x) => x.id);
      await prisma.applicationFollowUp.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: appIds } } });
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
      await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: reqIds } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } });
      const apiClients = await prisma.client.findMany({ where: { name: { contains: `ZZTEST BT` }, id: { notIn: made.clients } }, select: { id: true } });
      const clientIds = [...made.clients, ...apiClients.map((c) => c.id)];
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...allIds, ...reqIds, ...clientIds] } }, { reason: { contains: 'ZZTEST' } }] } });
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } });
      await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      const left = {
        users: await prisma.user.count({ where: { email: { endsWith: '@example.test' }, name: { contains: 'ZZTEST BT' } } }),
        clients: await prisma.client.count({ where: { name: { contains: 'ZZTEST BT' } } }),
        reqs: await prisma.requirement.count({ where: { title: { contains: 'ZZTEST BT' } } }),
        cands: await prisma.candidate.count({ where: { name: { contains: 'ZZTEST BT' } } }),
        audit: await prisma.auditLog.count({ where: { reason: { contains: 'ZZTEST' } } }),
      };
      console.log('leftovers after cleanup:', JSON.stringify(left));
      check('Z cleanup: nothing ZZTEST BT is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

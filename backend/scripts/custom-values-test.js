#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "TYPE YOUR OWN VALUE" acceptance test (2026-10-14). SANDBOX ONLY, light, run once.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/custom-values-test.js
//
//   job create/edit with an unknown Specialization / Qualification / Education / Employment type is saved and returned;
//   Admin and BDE typed values join the shared list (audit 'Added to list'); a team lead's value stays on that job only;
//   duplicates that differ by case collapse; HTML is stripped; closed fields (client, TL ids) still reject junk;
//   candidate + client forms keep typed Education / Industry (cleaned, one spelling).
// Builds ZZTEST CV fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
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
const DEPT = `ZZCV Dept ${RUN}`;
const TAG = `ZZTEST CV ${RUN}`;
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
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

(async () => {
  const made = { users: [], clients: [], reqs: [], cands: [], dept: null, listKeys: [] };
  const listRow = (key) => prisma.appSetting.findUnique({ where: { key } });
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST CV ${tag} ${RUN}`, email: `zz-cv-${tag}-${RUN}@example.test`, username: `zz-cv-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      return u;
    };
    const dept = await prisma.department.create({ data: { name: DEPT } });
    made.dept = dept.id;
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT });
    const uHr = await mk('hr', { role: 'HR', atsRole: 'HR', atsDepartment: DEPT, atsScopeDepartments: DEPT });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = { admin: await mint(uAdmin), tl: await mint(uTl), hr: await mint(uHr) };
    const client = await prisma.client.create({ data: { name: `${TAG} Client`, location: 'ZZ Town', ownerDepartment: DEPT, clientType: 'Client', agreementStatus: 'ACTIVE', industry: `ZZCV Industry ${RUN}` } });
    made.clients.push(client.id);

    // ---- job create with unknown everything (Admin = adds to the shared lists) ---------------------------------
    let jobN = 0;
    const job = (extra) => ({
      title: `${TAG} Job ${++jobN}`, clientId: client.id, status: 'OPEN', department: DEPT, openings: 1, priority: 'Medium',
      jobDescription: `${TAG} description`, skills: 'react, React ,  Node', employmentType: 'Full Time', workMode: 'Work From Office', location: 'Hyderabad',
      preferredLocation: 'Hyderabad', joiningTimeline: 'Within 15 Days', experience: '1-3 yrs', postingSources: 'None', tlId: uTl.id, duplicateOverride: true, duplicateReason: 'ZZTEST CV fixture', ...extra,
    });
    const c1 = await call('POST', '/api/requirements', T.admin, job({
      qualificationCustom: `ZZCV <b>Qual</b>  ${RUN}`, specialisationCustom: `ZZCV React ${RUN}`, education: `ZZCV Degree ${RUN}`, employmentType: `ZZCV Gig ${RUN}`,
    }));
    check('Admin creates a job with a typed Qualification / Specialization / Education / Employment type', c1.status === 201 && c1.body && c1.body.id, c1.body || c1.text);
    const j1 = c1.body || {};
    if (j1.id) made.reqs.push(j1.id);
    const g1 = await call('GET', `/api/requirements/${j1.id}`, T.admin);
    const r1 = g1.body || {};
    check('education and employment type are saved as typed', r1.education === `ZZCV Degree ${RUN}` && r1.employmentType === `ZZCV Gig ${RUN}`, [r1.education, r1.employmentType]);
    check('skills: duplicates differing by case collapse and spaces are tidied', r1.skills === 'react, Node', r1.skills);
    const q1 = await prisma.qualification.findFirst({ where: { departmentId: dept.id } });
    const s1 = await prisma.specialisation.findFirst({ where: { departmentId: dept.id } });
    check('Admin value joins the shared master (Qualification, HTML stripped)', q1 && q1.name === `ZZCV Qual ${RUN}`, q1);
    check('Admin value joins the shared master (Specialization, under that qualification)', s1 && s1.name === `ZZCV React ${RUN}` && s1.isMaster === true && s1.qualificationId === (q1 && q1.id), s1);
    check('the job points at the master rows', r1.qualificationId === (q1 && q1.id) && r1.specialisationId === (s1 && s1.id), [r1.qualificationId, r1.specialisationId]);
    const aud = await prisma.auditLog.findMany({ where: { action: 'Added to list', OR: [{ entityId: q1 && q1.id }, { entityId: s1 && s1.id }, { entityId: 'education' }, { entityId: 'employmentType' }] } });
    check("audit entries 'Added to list' exist for qualification, specialization, education, employment type", aud.length >= 4, aud.map((a) => `${a.entity}:${a.toValue}`));

    // ---- case-insensitive duplicate collapses to the existing master -------------------------------------------
    const c2 = await call('POST', '/api/requirements', T.admin, job({ qualificationCustom: `zzcv qual ${RUN}`, specialisationCustom: `ZZCV REACT ${RUN}`, education: `zzcv degree ${RUN}` }));
    const j2 = c2.body || {};
    if (j2.id) made.reqs.push(j2.id);
    const g2 = (await call('GET', `/api/requirements/${j2.id}`, T.admin)).body || {};
    check('same value in other capitals reuses the existing Qualification / Specialization rows', c2.status === 201 && g2.qualificationId === r1.qualificationId && g2.specialisationId === r1.specialisationId, [g2.qualificationId, g2.specialisationId]);
    check('same Education in other capitals uses the shared spelling', g2.education === `ZZCV Degree ${RUN}`, g2.education);
    check('no duplicate master rows were created', (await prisma.qualification.count({ where: { departmentId: dept.id } })) === 1 && (await prisma.specialisation.count({ where: { departmentId: dept.id } })) === 1);

    // ---- HR raises an INTERNAL job (not the BDE team / Admin): the typed value stays on the job and is flagged -------
    const e1 = await call('POST', '/api/requirements', T.hr, job({ internal: true, clientId: undefined, bdeId: undefined, tlId: undefined, specialisationCustom: `ZZCV HR Own ${RUN}`, qualificationCustom: `ZZCV HR Qual ${RUN}`, education: `ZZCV HR Degree ${RUN}` }));
    check('HR (not BDE team) can save typed values on an internal job', e1.status === 201 && e1.body && e1.body.id, e1.body || e1.text);
    if (e1.body && e1.body.id) made.reqs.push(e1.body.id);
    const g3 = (await call('GET', `/api/requirements/${e1.body && e1.body.id}`, T.admin)).body || {};
    check("HR's Specialization stays on the job as text (no master id)", g3.specialisationId == null && g3.specialisation === `ZZCV HR Own ${RUN}`, [g3.specialisationId, g3.specialisation]);
    check("HR's Qualification stays on the job text", g3.qualificationId == null && String(g3.qualifications || '').includes(`ZZCV HR Qual ${RUN}`), [g3.qualificationId, g3.qualifications]);
    check("HR's value is NOT added to the shared master", (await prisma.specialisation.count({ where: { departmentId: dept.id, name: `ZZCV HR Own ${RUN}` } })) === 0 && (await prisma.qualification.count({ where: { departmentId: dept.id, name: `ZZCV HR Qual ${RUN}` } })) === 0);
    const lst = await call('GET', '/api/requirements/open-lists', T.hr);
    check("HR's Education is not in the shared list, Admin's is", lst.status === 200 && !(lst.body.lists.education || []).includes(`ZZCV HR Degree ${RUN}`) && (lst.body.lists.education || []).includes(`ZZCV Degree ${RUN}`) && lst.body.canAdd === false, lst.body && lst.body.canAdd);

    // ---- HTML stripped on a free field --------------------------------------------------------------------------
    const h1 = await call('PUT', `/api/requirements/${j1.id}`, T.admin, { education: `<script>alert(1)</script>ZZCV Safe ${RUN}`, goodToHaveSkills: '<b>aws</b>, AWS' });
    const g4 = (await call('GET', `/api/requirements/${j1.id}`, T.admin)).body || {};
    check('HTML is stripped from typed values', h1.status === 200 && !/[<>]/.test(`${g4.education}${g4.goodToHaveSkills}`) && /ZZCV Safe/.test(g4.education), [g4.education, g4.goodToHaveSkills]);
    check('typed value is capped at 80 characters', (await call('PUT', `/api/requirements/${j1.id}`, T.admin, { education: 'E'.repeat(200) })).status === 200 && ((await call('GET', `/api/requirements/${j1.id}`, T.admin)).body.education || '').length === 80);

    // ---- locations: shared list rules (Admin adds, audit, canonical spelling) --------------------------------------
    const l0 = await call('GET', '/api/requirements/locations', T.admin);
    const names = ((l0.body && l0.body.locations) || []).map((x) => x.name);
    check('Hyderabad, Secunderabad, Bengaluru, Vijayawada, Kottayam, Gajwel are in the shared place list', ['Hyderabad', 'Secunderabad', 'Bengaluru', 'Vijayawada', 'Kottayam', 'Gajwel'].every((n) => names.includes(n)), names.slice(0, 20));
    check('Bangalore is Bengaluru, not a second entry', !names.includes('Bangalore'));
    const la = await call('POST', '/api/requirements/locations', T.admin, { name: `ZZCV Town ${RUN}` });
    const lb = await call('POST', '/api/requirements/locations', T.hr, { name: `ZZCV Other ${RUN}` });
    made.listKeys.push('ats.jobLocations');
    check('Admin adds a place (shared list, audited)', la.status === 200 && (await prisma.auditLog.count({ where: { action: 'Added to list', toValue: `ZZCV Town ${RUN}` } })) === 1, la.body);
    check('HR cannot add to the shared place list (value stays on the job)', lb.status === 403, lb.status);
    await call('POST', '/api/requirements/locations', T.admin, { name: `zzcv town ${RUN}` });
    const l1 = await call('GET', '/api/requirements/locations', T.admin);
    check('the same place in other capitals is not duplicated', ((l1.body.locations || []).filter((x) => x.name.toLowerCase() === `zzcv town ${RUN}`.toLowerCase())).length === 1);

    // ---- open list endpoint ---------------------------------------------------------------------------------------
    const ol = await call('POST', '/api/requirements/open-lists/education', T.admin, { value: `ZZCV Diploma ${RUN}` });
    check('open-list endpoint adds for Admin and reports added', ol.status === 200 && ol.body.added === true, ol.body);
    const ol2 = await call('POST', '/api/requirements/open-lists/education', T.hr, { value: `ZZCV TL List ${RUN}` });
    check('open-list endpoint: a team lead is flagged, not added', ol2.status === 200 && ol2.body.flagged === true && ol2.body.added === false, ol2.body);
    check('open-list endpoint: unknown list is refused', (await call('POST', '/api/requirements/open-lists/__proto__x', T.admin, { value: 'abc' })).status === 404);

    // ---- closed fields still reject junk ----------------------------------------------------------------------------
    const bad1 = await call('POST', '/api/requirements', T.admin, job({ clientId: 'not-a-client-id' }));
    check('client (an id) still rejects an unknown value', bad1.status === 400 && /client/i.test(JSON.stringify(bad1.body)), bad1.body);
    const bad2 = await call('POST', '/api/requirements', T.admin, job({ tlIds: ['not-a-user-id'], tlId: undefined }));
    check('team lead ids still reject an unknown value', bad2.status >= 400, [bad2.status, bad2.body]);
    if (bad2.body && bad2.body.id) made.reqs.push(bad2.body.id);

    // ---- candidate + client forms --------------------------------------------------------------------------------------
    const cc = await call('POST', '/api/candidates', T.admin, { name: `${TAG} Candidate`, phone: '9000000001', currentSalary: '0', expectedSalary: '1', email: `zz-cv-cand-${RUN}@example.test`, education: `  ZZCV <i>MSc</i>  Robotics ${RUN}`, specialization: `ZZCV Spec ${RUN}`, skills: 'go, Go, <b>rust</b>' });
    check('candidate saved with typed Education / Specialization / skills (cleaned)', (cc.status === 201 || cc.status === 200) && cc.body && cc.body.id, cc.body || cc.text);
    if (cc.body && cc.body.id) {
      made.cands.push(cc.body.id);
      const row = await prisma.candidate.findUnique({ where: { id: cc.body.id } });
      check('candidate Education: HTML gone, spaces collapsed, case kept', row.education === `ZZCV MSc Robotics ${RUN}`, row.education);
      check('candidate skills: duplicates collapse and HTML is gone', row.skills === 'go, rust', row.skills);
    }
    const cl2 = await call('PUT', `/api/clients/${client.id}`, T.admin, { industry: `zzcv industry ${RUN}` });
    const clRow = await prisma.client.findUnique({ where: { id: client.id } });
    check('client Industry typed in other capitals keeps the existing spelling', cl2.status < 400 && clRow.industry === `ZZCV Industry ${RUN}`, [cl2.status, clRow.industry]);
    const cl3 = await call('PUT', `/api/clients/${client.id}`, T.admin, { industry: `ZZCV New Sector ${RUN}` });
    check('client Industry with a brand new typed value is saved', cl3.status < 400 && (await prisma.client.findUnique({ where: { id: client.id } })).industry === `ZZCV New Sector ${RUN}`, [cl3.status, cl3.body]);
  } catch (e) {
    fail += 1; console.log('FAIL  test crashed', e && e.stack);
  } finally {
    // ---- cleanup: only rows this run made ------------------------------------------------------------------------
    try {
      const uids = made.users;
      const reqIds = made.reqs.slice();
      const mine = await prisma.requirement.findMany({ where: { OR: [{ title: { contains: 'ZZTEST CV' } }, { id: { in: reqIds } }] }, select: { id: true } });
      const ids = [...new Set([...reqIds, ...mine.map((r) => r.id)])];
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: uids } }, { link: { in: ids.map((i) => `/requirements/${i}`) } }] } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: uids } }, { entityId: { in: ids } }, { toValue: { contains: RUN } }, { fromValue: { contains: RUN } }] } }).catch(() => {});
      await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: ids } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { requirementId: { in: ids } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.log('req cleanup', e.message));
      await prisma.candidateNote.deleteMany({ where: { candidateId: { in: made.cands } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch((e) => console.log('client cleanup', e.message));
      if (made.dept) {
        await prisma.specialisation.deleteMany({ where: { departmentId: made.dept } }).catch(() => {});
        await prisma.qualification.deleteMany({ where: { departmentId: made.dept } }).catch(() => {});
        await prisma.department.deleteMany({ where: { id: made.dept } }).catch(() => {});
      }
      // shared lists: remove only the values this run typed
      for (const key of ['ats.openList.education', 'ats.openList.employmentType', 'ats.jobLocations']) {
        const row = await listRow(key).catch(() => null);
        if (row) {
          let arr = []; try { arr = JSON.parse(row.value); } catch { arr = []; }
          const keep = arr.filter((x) => !String(x).includes(RUN) && !String(x).toLowerCase().includes(RUN));
          if (keep.length !== arr.length) await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify(keep) } });
        }
      }
      await prisma.user.deleteMany({ where: { id: { in: uids } } }).catch((e) => console.log('user cleanup', e.message));
    } catch (e) { console.log('cleanup problem', e.message); }
    const left = await prisma.requirement.count({ where: { title: { contains: 'ZZTEST CV' } } });
    console.log(`\n${pass} passed, ${fail} failed; leftover ZZTEST CV jobs: ${left}`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

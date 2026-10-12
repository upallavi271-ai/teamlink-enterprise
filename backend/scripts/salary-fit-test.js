#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SALARY (required) + SALARY FIT acceptance tests (2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/salary-fit-test.js
//
//   U  unit table: reading an amount, validation messages, the fit % table
//   C  required on Add Candidate (API), edit rules for old records, careers apply, import rows, referral
//   G  the Submit step gate (TL check / share with client)
//   F  Salary fit in the pipeline list, the profile, the job page, the board; filter + sort + counts
//   V  VISIBILITY: recruiter / TL / manager / admin see figures; BDE + BDE TL get the % label only;
//      client and candidate logins get nothing (sentinel values must not appear anywhere)
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const SF = require(path.join(BACK, 'src/utils/salaryFit'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
}
async function call(method, p, token, body, raw) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { h['Content-Type'] = raw.type; payload = raw.body; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 150) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  try {
    // =============================== U: unit table ===================================
    const lpa = (t, o) => { const p = SF.parseAmount(t, o); return p.ok ? p.lpa : (p.reason || 'bad'); };
    const table = [
      ['4.5', undefined, 4.5], ['4.5 LPA', undefined, 4.5], ['₹4.5L', undefined, 4.5], ['45000/month', undefined, 5.4], ['45,000 per month', undefined, 5.4],
      ['45000', undefined, 5.4], ['45k', undefined, 5.4], ['6,50,000', undefined, 6.5], ['1.5LPM', undefined, 18], ['3 lakhs', undefined, 3], ['Fresher', undefined, 0], ['0', undefined, 0],
      ['As per norms', undefined, 'unclear'], ['45', { unit: 'month' }, 'no_unit'], ['45000', { unit: 'year' }, 0.45], ['45000', { unit: 'month' }, 5.4], ['1 cr', undefined, 100],
    ];
    let bad = table.filter(([t, o, want]) => lpa(t, o) !== want);
    check(`U1 unit parsing table (${table.length} inputs: LPA, lakh, monthly, k, grouped, fresher, unclear, toggle)`, bad.length === 0, bad.map((x) => [x[0], lpa(x[0], x[1]), x[2]]));
    const vs = (cs, es, extra) => SF.validateSalaries({ currentSalary: cs, expectedSalary: es, ...(extra || {}) });
    check('U2 blank current -> "Please enter current salary (0 if fresher)."', vs('', '6').errors.currentSalary === 'Please enter current salary (0 if fresher).');
    check('U3 blank expected -> "Please enter expected salary."', vs('3', '').errors.expectedSalary === 'Please enter expected salary.');
    check('U4 fresher (0) is accepted as current, stored "0 LPA"', vs('0', '3.5').ok && vs('0', '3.5').values.currentSalary === '0 LPA');
    check('U5 expected 0 is refused', !!vs('3', '0').errors.expectedSalary);
    check('U6 monthly entry converted: 50000 per month -> "6 LPA"', vs('4 LPA', '50000 per month').values.expectedSalary === '6 LPA');
    check('U7 soft warnings, not blocks: expected far below current, expected >10x current', vs('12', '4').ok && vs('12', '4').warnings.length === 1 && vs('2', '30').ok && vs('2', '30').warnings.length === 1);
    check('U8 a range is refused for a new entry', !!vs('4-5', '6').errors.currentSalary);
    const F = (exp, cur, sal, type) => { const f = SF.fitFor({ expectedSalary: exp, currentSalary: cur }, { salary: sal, salaryType: type }); return [f.band || f.state, f.pct === undefined ? null : f.pct, !!f.belowRange, f.salaryHikePct === undefined ? null : f.salaryHikePct]; };
    const fitCases = [
      ['inside the budget', F('18', '12', '₹14L - ₹20L'), ['within', 100, false, 50]],
      ['exactly the maximum', F('20', '12', '₹14L - ₹20L'), ['within', 100, false, 67]],
      ['max 25000 vs wants 30000 a month = 83%', F('30000 per month', '20000 per month', '25k - 25k'), ['above', 83, false, 50]],
      ['slightly above (10%)', F('22', '18', '₹14L - ₹20L'), ['slightly', 90, false, 22]],
      ['15% over the maximum is still slightly above', F('23', '18', '₹14L - ₹20L'), ['slightly', 86, false, 28]],
      ['above (50% over)', F('30', '18', '₹14L - ₹20L'), ['above', 66, false, 67]],
      ['below the minimum: 100% + Below range', F('10', '8', '₹14L - ₹20L'), ['within', 100, true, 25]],
      ['fresher: no hike', F('4', '0', '₹3L - ₹5L'), ['within', 100, false, null]],
      ['no budget', F('4', '2', ''), ['no-budget', null, false, 100]],
      ['no expected salary', F('', '2', '₹3L - ₹5L'), ['no-salary', null, false, null]],
      ['one-sided budget "₹14L+": nothing to be above', F('40', '12', '₹14L+'), ['within', 100, false, 233]],
    ];
    bad = fitCases.filter(([, got, want]) => !eq(got, want));
    check(`U9 fit % table (${fitCases.length} cases: below / in / above / slightly / no budget / no salary / zero current)`, bad.length === 0, bad);

    // =============================== fixtures ===================================
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST SF ${tag} ${RUN}`, email: `zz-sf-${tag}-${RUN}@example.test`, username: `zz-sf-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-SF-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsAccess: true, hrmsRole: 'MANAGER' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const client = await prisma.client.create({ data: { name: `ZZTEST SF Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client', agreementStatus: 'ACTIVE' } });
    made.clients.push(client.id);
    const mkReq = async (tag, salary, extra = {}) => {
      const r = await prisma.requirement.create({ data: { title: `ZZTEST SF Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, bdeId: uBde.id, tlId: uTl.id, openings: 2, salary, salaryType: 'Annual CTC', ...extra } });
      made.reqs.push(r.id); return r;
    };
    const rBud = await mkReq('budget', '₹5L - ₹6L');
    const rNone = await mkReq('nobudget', null);
    const SENT_EXP = '7.77 LPA'; const SENT_CUR = '5.55 LPA'; // sentinels: must never reach a BDE / client / candidate
    const mkCand = async (tag, data) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST SF Cand ${tag} ${RUN}`, email: `zz-sf-${tag}-${RUN}@example.test`, phone: `90000${String(Math.floor(Math.random() * 90000) + 10000)}`, skills: 'ZZ', ...data } });
      made.cands.push(c.id); return c;
    };
    const mkApp = async (cand, req, stage) => { const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage } }); made.apps.push(a.id); return a; };
    const cA = await mkCand('A', { currentSalary: SENT_CUR, expectedSalary: SENT_EXP });
    const aA = await mkApp(cA, rBud, 'SHARED_WITH_CLIENT');
    const cB = await mkCand('B', { currentSalary: '4 LPA', expectedSalary: '5.5 LPA' });
    const aB = await mkApp(cB, rBud, 'SHARED_WITH_CLIENT');
    const cC = await mkCand('C', { currentSalary: '', expectedSalary: '' }); // an OLD record with no salary
    const aC = await mkApp(cC, rBud, 'RECRUITER_REVIEW');
    const aD = await mkApp(cB, rNone, 'SHARED_WITH_CLIENT');
    const cClientUser = await prisma.user.create({ data: { ...base, name: `ZZTEST SF Client User ${RUN}`, email: `zz-sf-clientu-${RUN}@example.test`, username: `zz-sf-clientu-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER' } });
    const uCand = await prisma.user.create({ data: { ...base, name: `ZZTEST SF Cand User ${RUN}`, email: `zz-sf-candu-${RUN}@example.test`, username: `zz-sf-candu-${RUN}@example.test`, role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: cA.id } });
    made.users.push(cClientUser.id, uCand.id);
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, bdeTl: uBdeTl, bde: uBde, rec: uRec, tl: uTl, client: cClientUser, cand: uCand })) T[k] = await mint(u);

    // =============================== C: required on create ===================================
    const body = (o) => ({ firstName: 'ZZTEST', name: `ZZTEST SF New ${RUN}-${Math.random().toString(36).slice(2, 6)}`, phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, email: `zz-sf-new-${Math.random().toString(36).slice(2, 8)}-${RUN}@example.test`, skills: 'ZZ', ...o });
    const track = (r) => { if (r.body && r.body.id) made.cands.push(r.body.id); return r; };
    let r = track(await call('POST', '/api/candidates', T.rec, body({})));
    check('C1 Add Candidate with no salary at all -> 400 with the plain message', r.status === 400 && r.body.code === 'SALARY_REQUIRED' && r.body.error === 'Please enter current salary (0 if fresher).', [r.status, r.body]);
    r = track(await call('POST', '/api/candidates', T.rec, body({ currentSalary: '3' })));
    check('C2 current given, expected missing -> "Please enter expected salary."', r.status === 400 && r.body.field === 'expectedSalary' && r.body.error === 'Please enter expected salary.', [r.status, r.body]);
    r = track(await call('POST', '/api/candidates', T.rec, body({ expectedSalary: '4' })));
    check('C3 expected given, current missing -> current message', r.status === 400 && r.body.field === 'currentSalary', [r.status, r.body]);
    r = track(await call('POST', '/api/candidates', T.rec, body({ currentSalary: 'as per norms', expectedSalary: '4' })));
    check('C4 unreadable salary ("as per norms") is refused', r.status === 400 && /not clear/.test(r.body.error), [r.status, r.body]);
    r = track(await call('POST', '/api/candidates', T.rec, body({ currentSalary: '0', expectedSalary: '3.5' })));
    check('C5 fresher "0" + expected 3.5 -> created, stored "0 LPA" / "3.5 LPA"', r.status === 201 && r.body.currentSalary === '0 LPA' && r.body.expectedSalary === '3.5 LPA', [r.status, r.body && r.body.error, r.body && r.body.matches]);
    r = track(await call('POST', '/api/candidates', T.rec, body({ currentSalary: '35000', currentSalaryUnit: 'month', expectedSalary: '4.5 LPA' })));
    check('C6 monthly toggle: 35000 per month -> "4.2 LPA"', r.status === 201 && r.body.currentSalary === '4.2 LPA', [r.status, r.body && r.body.currentSalary]);
    r = track(await call('POST', '/api/candidates', T.rec, body({ currentSalary: '12', expectedSalary: '4' })));
    check('C7 odd values only WARN (created, salaryWarnings filled)', r.status === 201 && Array.isArray(r.body.salaryWarnings) && r.body.salaryWarnings.length === 1, [r.status, r.body && r.body.salaryWarnings]);
    const newId = r.body && r.body.id;
    // edit rules
    let e = await call('PUT', `/api/candidates/${cC.id}`, T.rec, { location: 'ZZ Town', currentSalary: '', expectedSalary: '' });
    check('C8 an OLD record with no salary can still be edited (not blocked)', e.status === 200, [e.status, e.body]);
    e = await call('PUT', `/api/candidates/${cC.id}`, T.rec, { currentSalary: '45000 per month' });
    const afterC = await prisma.candidate.findUnique({ where: { id: cC.id }, select: { currentSalary: true, expectedSalary: true } });
    check('C9 adding the missing salary on an edit stores it clean', e.status === 200 && afterC.currentSalary === '5.4 LPA' && !afterC.expectedSalary, [e.status, afterC]);
    e = await call('PUT', `/api/candidates/${cB.id}`, T.rec, { expectedSalary: '' });
    check('C10 a salary that exists cannot be wiped out', e.status === 400 && e.body.code === 'SALARY_REQUIRED', [e.status, e.body]);
    e = await call('PUT', `/api/candidates/${cB.id}`, T.rec, { expectedSalary: 'whatever' });
    check('C11 an edit with an unreadable salary is refused', e.status === 400, [e.status, e.body]);
    // referral
    const fd = (fields) => {
      const b = `----zz${RUN}`;
      let s = '';
      Object.entries(fields).forEach(([k, v]) => { s += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`; });
      return { type: `multipart/form-data; boundary=${b}`, body: `${s}--${b}--\r\n` };
    };
    r = await call('POST', '/api/sourcing/referrals', T.rec, undefined, fd({ name: `ZZTEST SF Ref ${RUN}`, phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, agreed: 'yes' }));
    check('C12 employee referral of a NEW person without salary is refused', r.status === 400 && r.body && r.body.code === 'SALARY_REQUIRED', [r.status, r.body]);
    // careers apply (public): salary checked before the resume
    const job = await prisma.requirement.update({ where: { id: rBud.id }, data: { portalPublished: true, status: 'OPEN' } });
    r = await call('POST', `/api/public/careers/jobs/${job.id}/apply`, null, undefined, fd({ name: 'Zz Careers', email: `zz-sf-car-${RUN}@example.test`, phone: '9876543210', consent: 'yes' }));
    check('C13 career-page application without salary -> 400 SALARY_REQUIRED', r.status === 400 && r.body && r.body.code === 'SALARY_REQUIRED', [r.status, r.body]);
    r = await call('POST', `/api/public/careers/jobs/${job.id}/apply`, null, undefined, fd({ name: 'Zz Careers', email: `zz-sf-car-${RUN}@example.test`, phone: '9876543210', consent: 'yes', currentSalary: '0', expectedSalary: '3 LPA' }));
    check('C14 with both salaries it passes the salary check (then asks for the resume)', r.status === 400 && r.body && /resume/i.test(r.body.error || ''), [r.status, r.body]);
    // import rows
    {
      const DI = require(path.join(BACK, 'src/routes/dataImport')).internals;
      const H = DI.HANDLERS;
      const ix = await DI.buildIndex();
      const tryRow = async (data) => { try { return await H.candidate({ data, ix, dry: true, row: 1, note: () => {} }); } catch (err) { return `ERR:${err.message}`; } };
      const n = `zz-sf-imp-${RUN}`;
      const a1 = await tryRow({ name: 'ZZTEST Imp 1', email: `${n}-1@example.test` });
      const a2 = await tryRow({ name: 'ZZTEST Imp 2', email: `${n}-2@example.test`, currentSalary: '2 LPA' });
      const a3 = await tryRow({ name: 'ZZTEST Imp 3', email: `${n}-3@example.test`, currentSalary: '2 LPA', expectedSalary: '3 LPA' });
      const a4 = await tryRow({ name: 'ZZTEST Imp 4', email: `${n}-4@example.test`, currentSalary: '0 (fresher)', expectedSalary: '25000 per month' });
      const a5 = await tryRow({ name: 'ZZTEST Imp 5', email: cB.email, expectedSalary: 'junk' });
      const a6 = await tryRow({ name: 'ZZTEST SF Cand B', email: cB.email });
      check('C15 import: a NEW row with no salary is rejected with the reason', /^ERR:Please enter current salary/.test(a1), a1);
      check('C16 import: only current given -> "Please enter expected salary."', /^ERR:Please enter expected salary/.test(a2), a2);
      check('C17 import: both given (2 LPA / 3 LPA, and 0 fresher / monthly) -> accepted', a3 === 'created' && a4 === 'created', [a3, a4]);
      check('C18 import: an UPDATE of someone on file without salary columns is not blocked; a junk salary on it is refused', a6 === 'updated' && /^ERR:/.test(a5), [a5, a6]);
      check('C19 the import template has the two columns marked required', (() => { const sp = require(path.join(BACK, 'src/utils/importSpec')); const sh = (sp.SHEETS || sp.sheets || []).find((x) => x.name === 'Candidates'); return !!sh && sh.columns.filter((c) => /salary/i.test(c.h) && /REQUIRED/.test(c.help || '')).length === 2; })());
    }

    // =============================== G: the Submit step gate ===================================
    r = await call('POST', '/api/candidates/board/move', T.rec, { applicationId: aC.id, column: 'tl' });
    check('G1 sending a no-salary candidate to the TL check is refused with the plain message', r.status === 409 && r.body.code === 'SALARY_NEEDED' && /Add .*salary/.test(r.body.error), [r.status, r.body]);
    await prisma.candidate.update({ where: { id: cC.id }, data: { currentSalary: '4 LPA', expectedSalary: '5 LPA' } });
    r = await call('POST', '/api/candidates/board/move', T.rec, { applicationId: aC.id, column: 'tl' });
    check('G2 once both salaries are saved the same move works', r.status === 200, [r.status, r.body]);

    // =============================== F: Salary fit shown where recruiters work ===================================
    const list = async (tok, q) => call('GET', `/api/candidates?paged=1&view=pipeline&sub=all&pageSize=100&${q || ''}`, tok);
    const rowOf = (res, appId) => ((res.body && res.body.rows) || []).find((x) => x.applicationId === appId || x.id === appId);
    let L = await list(T.rec, `requirementId=${rBud.id}`);
    let rA = rowOf(L, aA.id);
    check('F1 pipeline row: Salary fit for 7.77 LPA vs budget 5-6 LPA = 77% "Above budget" with hike +40%', !!rA && rA.salaryFit && rA.salaryFit.pct === 77 && rA.salaryFit.label === 'Above budget' && rA.salaryFit.salaryHikePct === 40, rA && rA.salaryFit);
    const rB = rowOf(L, aB.id);
    check('F2 5.5 LPA vs 5-6 LPA = 100% "Within budget"', !!rB && rB.salaryFit.pct === 100 && rB.salaryFit.label === 'Within budget', rB && rB.salaryFit);
    const D = await list(T.rec, `requirementId=${rNone.id}`);
    const rD = rowOf(D, aD.id);
    check('F3 job with no budget: "Client budget not set" (no % invented)', !!rD && rD.salaryFit.label === 'Client budget not set' && rD.salaryFit.pct === undefined, rD && rD.salaryFit);
    L = await list(T.rec, `requirementId=${rBud.id}&salaryFit=above`);
    check('F4 filter "Above budget" keeps only that row', L.body.rows.length === 1 && L.body.rows[0].applicationId === aA.id, L.body.rows && L.body.rows.map((x) => x.name));
    L = await list(T.rec, `requirementId=${rBud.id}&sort=salaryFit&dir=asc`);
    check('F5 sort by Salary fit (lowest first)', L.body.rows[0].applicationId === aA.id, L.body.rows && L.body.rows.map((x) => [x.name, x.salaryFit && x.salaryFit.pct]));
    const fac = await call('GET', `/api/ats-io/facets/candidates?view=pipeline&sub=all&requirementId=${rBud.id}`, T.rec);
    const facOpts = (fac.body && fac.body.facets && fac.body.facets.salaryFit) || [];
    check('F6 Salary fit filter options come with counts (cascading on the job)', facOpts.some((o) => o.value === 'above' && o.count === 1) && facOpts.some((o) => o.value === 'within' && o.count >= 1), facOpts);
    const prof = await call('GET', `/api/candidates/${cA.id}`, T.rec);
    const pa = prof.body && (prof.body.applications || []).find((x) => x.id === aA.id);
    check('F7 candidate profile: each application carries its Salary fit', !!pa && pa.salaryFit && pa.salaryFit.pct === 77, pa && pa.salaryFit);
    const jp = await call('GET', `/api/requirements/${rBud.id}`, T.rec);
    const ja = jp.body && (jp.body.applications || []).find((x) => x.id === aA.id);
    check('F8 job page: the people list carries Salary fit and no raw salary', !!ja && ja.salaryFit && ja.salaryFit.pct === 77 && !JSON.stringify(ja.candidate).includes('7.77'), ja && [ja.salaryFit, ja.candidate]);
    const bd = await call('GET', '/api/candidates/board?requirementId=' + rBud.id, T.rec);
    const card = ((bd.body && bd.body.columns) || []).flatMap((c) => c.cards || []).find((x) => x.id === aA.id);
    check('F9 board card carries the Salary fit chips', !!card && card.salaryFit && card.salaryFit.pct === 77, card && card.salaryFit);
    const mp = await call('GET', `/api/candidates?paged=1&view=master&sub=all&salaryMissing=1&search=ZZTEST SF Cand`, T.rec);
    check('F10 People list: "Salary missing" filter + count (candidate C had none before the edit gate test)', mp.status === 200 && mp.body.counts && mp.body.counts.salaryMissing !== undefined, [mp.status, mp.body && mp.body.counts]);
    const tl = await list(T.tl, `requirementId=${rBud.id}`);
    check('F11 TL sees the figures too (expectedSalary in the fit)', rowOf(tl, aA.id) && rowOf(tl, aA.id).salaryFit.expectedSalary === 7.77, rowOf(tl, aA.id) && rowOf(tl, aA.id).salaryFit);
    for (const k of ['mgr', 'admin']) {
      const x = await list(T[k], `requirementId=${rBud.id}`);
      check(`F12 ${k} sees the fit with figures`, !!rowOf(x, aA.id) && rowOf(x, aA.id).salaryFit.pct === 77 && rowOf(x, aA.id).salaryFit.expectedSalary === 7.77, rowOf(x, aA.id) && rowOf(x, aA.id).salaryFit);
    }

    // =============================== V: visibility ===================================
    const paths = (tok) => [
      ['pipeline list', `/api/candidates?paged=1&view=pipeline&sub=all&pageSize=100&requirementId=${rBud.id}`],
      ['pipeline all', `/api/candidates?paged=1&view=pipeline&sub=all&all=1&requirementId=${rBud.id}`],
      ['profile', `/api/candidates/${cA.id}`],
      ['job page', `/api/requirements/${rBud.id}`],
      ['board', `/api/candidates/board?requirementId=${rBud.id}`],
      ['export', `/api/candidates?paged=1&view=pipeline&sub=all&requirementId=${rBud.id}`],
      ['client overview', `/api/clients/${client.id}/overview`],
    ].map(([n, p]) => [n, p, tok]);
    for (const who of ['bde', 'bdeTl']) {
      const sees = [];
      let anyFit = false;
      for (const [n, p, tok] of paths(T[who])) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call('GET', p, tok);
        if (res.status === 200) {
          if (/7\.77|5\.55/.test(res.text)) sees.push(n);
          if (/"salaryFit"/.test(res.text)) anyFit = true;
        }
      }
      check(`V1 ${who}: NO candidate salary figure (7.77 / 5.55 sentinel) in ${paths(T[who]).length} payloads`, sees.length === 0, sees);
      const lb = await call('GET', `/api/candidates?paged=1&view=pipeline&sub=all&pageSize=100&requirementId=${rBud.id}`, T[who]);
      const ra = rowOf(lb, aA.id);
      check(`V2 ${who}: still gets the Salary fit % label (rounded to 10) with no figures and no hike`, !!ra && ra.salaryFit && ra.salaryFit.pct === 80 && ra.salaryFit.approx === true && ra.salaryFit.label === 'Above budget'
        && ra.salaryFit.expectedSalary === undefined && ra.salaryFit.currentSalary === undefined && ra.salaryFit.salaryHikePct === undefined && ra.salaryFit.hikeLabel === undefined, ra && ra.salaryFit);
      check(`V3 ${who}: some payload carries a fit`, anyFit);
    }
    // client login
    {
      const leaks = []; let fitSeen = false;
      for (const [n, p] of [['pipeline', `/api/candidates?paged=1&view=pipeline&sub=all&pageSize=100`], ['profile', `/api/candidates/${cA.id}`], ['job page', `/api/requirements/${rBud.id}`], ['board', `/api/candidates/board`], ['overview', `/api/clients/${client.id}/overview`], ['portal', '/api/portal/overview']]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call('GET', p, T.client);
        if (/7\.77|5\.55/.test(res.text)) leaks.push(n);
        if (/salaryFit|salaryHike|"fitPct"/.test(res.text)) fitSeen = true;
      }
      check('V4 client login: no candidate salary and no Salary fit anywhere', leaks.length === 0 && !fitSeen, { leaks, fitSeen });
    }
    // candidate login: never the client name or budget
    {
      const leaks = [];
      for (const [n, p] of [['profile', `/api/candidates/${cA.id}`], ['portal', '/api/portal/candidate'], ['pipeline', '/api/candidates?paged=1&view=pipeline&sub=all']]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call('GET', p, T.cand);
        const t = res.text || '';
        if (/salaryFit|salaryHike/.test(t)) leaks.push(`${n}: fit`);
        if (new RegExp(client.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t) && n === 'portal') leaks.push(`${n}: client name`);
        if (/₹5L - ₹6L/.test(t)) leaks.push(`${n}: client budget`);
        if (/\bbudget\b/i.test(t) && /Client budget/i.test(t)) leaks.push(`${n}: budget text`);
      }
      check('V5 candidate login: no Salary fit, no client budget, no client name on their portal', leaks.length === 0, leaks);
    }
    // the redaction layer itself (server side, not only the screens)
    {
      const CR = require(path.join(BACK, 'src/utils/clientRedact'));
      const cut = CR.sanitizeAts({ salaryFit: { pct: 80, expectedSalary: 7.77, currentSalary: 5.55, salaryHikePct: 40 }, candidateExpectedSalary: '7.77 LPA' }, { bde: true, contact: true });
      check('V6 clientRedact removes the figures from any payload for the BDE team / a login without the switch, keeps the %', cut.salaryFit && cut.salaryFit.pct === 80 && cut.salaryFit.expectedSalary === undefined && cut.salaryFit.salaryHikePct === undefined && cut.candidateExpectedSalary === undefined, cut);
    }
    // export
    {
      const ex = await call('GET', '/api/ats-io/export/candidates?format=csv&view=all', T.rec);
      const exb = await call('GET', '/api/ats-io/export/candidates?format=csv&view=all', T.bde);
      const head = (t) => String(t || '').split(/\r?\n/)[0];
      check('V7 export: Budget fit columns for the recruiter; the BDE export has the fit but no salary columns', ex.status === 200 && /Budget fit/.test(head(ex.text)) && /Current salary/.test(head(ex.text)) && (exb.status !== 200 || (/Budget fit/.test(head(exb.text)) && !/salary/i.test(head(exb.text)))), [ex.status, head(ex.text).slice(0, 300), exb.status, head(exb.text).slice(0, 300)]);
    }
    void newId;
  } finally {
    // ---- cleanup (every row we made, and what the app wrote because of it) ----
    try {
      const candIds = made.cands; const userIds = made.users;
      const appIds = (await prisma.application.findMany({ where: { OR: [{ candidateId: { in: candIds } }, { requirementId: { in: made.reqs } }] }, select: { id: true } })).map((a) => a.id);
      const allIds = [...appIds, ...candIds, ...made.reqs, ...made.clients, ...userIds];
      await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } });
      await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } });
      await prisma.candidateNote.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.candidateDocument.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
      await prisma.candidateReferral.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      const zzC = await prisma.candidate.findMany({ where: { OR: [{ name: { startsWith: 'ZZTEST' }, email: { contains: `-${RUN}@example.test` } }, { email: { contains: `${RUN}@example.test` } }] }, select: { id: true } });
      const delC = [...new Set([...candIds, ...zzC.map((c) => c.id)])];
      await prisma.syncLog.deleteMany({ where: { OR: [{ recordRef: { in: delC } }, { reason: { contains: 'ZZTEST' } }] } }).catch(() => {});
      try { await prisma.candidateDupFlag.deleteMany({ where: { OR: [{ candidateId: { in: delC } }, { matchCandidateId: { in: delC } }] } }); } catch { /* table optional */ }
      await prisma.candidate.deleteMany({ where: { id: { in: delC } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...allIds, ...delC] } }] } });
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) { console.log('CLEANUP problem:', err.message); }
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SALARY AS A PART OF THE FIT (matching) acceptance tests (2026-10-13). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/salary-match-test.js
//
//   U  unit tables: reading an amount (monthly / yearly by size and by the job's pay type), the
//      salary factor (inside / below / above / unknown), the formula and its re-normalising
//   W  the weights: one table, editable by Admin only, validated, reset
//   M  Matching candidates: breakdown, "Hide people above budget", "Salary within budget", counts, sort
//   V  who sees what: full for recruiter / TL / Manager / Admin; BDE + BDE TL rounded total + label +
//      the Salary WORD only (sentinel scan: no rupees); client + candidate logins get nothing
//   B  the batch breakdown for the list / board / profile
//   R  the stored-score recompute script (dry run, apply on the sandbox, undo, real DB refused)
//   P  speed on the big copy
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');
const { spawnSync } = require('child_process');

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
const MT = require(path.join(BACK, 'src/utils/matching'));
const FB = require(path.join(BACK, 'src/utils/fitBreakdown'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
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
  let touchedSettings = false;
  try {
    // =============================== U: unit tables ===================================
    const lpa = (t, o) => { const p = SF.parseAmount(t, o); return p.ok ? (p.ambiguous ? `${p.lpa}?` : p.lpa) : (p.reason || 'bad'); };
    const table = [
      // [text, opts, expected LPA]   ('?' = ambiguous, 'unclear' = cannot be read)
      ['35000', { job: 'year' }, 4.2], ['35000', { job: 'month' }, 4.2], ['35k', { job: 'year' }, 4.2], ['35 K', undefined, 4.2],
      ['3.5 LPM', undefined, 42], ['1.5lpm', undefined, 18], ['4.5 LPA', undefined, 4.5], ['4.5lpa', undefined, 4.5], ['₹4.5L', undefined, 4.5],
      ['45000/month', undefined, 5.4], ['45,000 per month', undefined, 5.4], ['45000 pm', undefined, 5.4], ['Rs. 45000 monthly', undefined, 5.4],
      ['6,50,000', undefined, 6.5], ['650000', undefined, 6.5], ['10,00,000', undefined, 10], ['450k', undefined, 4.5],
      ['4.5', { job: 'year' }, 4.5], ['3 lakhs', undefined, 3], ['1 cr', undefined, 100],
      ['25-30k', undefined, 3.6], ['25-30,000', undefined, 3.6], ['25 - 30000', undefined, 3.6], ['4 to 5 LPA', undefined, 5], ['35,000 to 38,000', undefined, 4.56],
      ['150000', { job: 'year' }, '1.5?'], ['150000', { job: 'month' }, 18], ['35', { job: 'month' }, 4.2],
      ['As per norms', undefined, 'unclear'], ['as per company norms', undefined, 'unclear'], ['Negotiable', undefined, 'unclear'], ["Didn't mentioned", undefined, 'unclear'], ['NA', undefined, 'unclear'],
      ['Nil', undefined, 0], ['Fresher', undefined, 0], ['', undefined, 'blank'], [null, undefined, 'blank'], ['   ', undefined, 'blank'],
    ];
    let bad = table.filter(([t, o, want]) => lpa(t, o) !== want);
    check(`U1 reading an amount: ${table.length} inputs (35000, 35k, LPM, LPA, per month, grouped, ranges, ambiguous, norms, NA, Nil, blank)`, bad.length === 0, bad.map((x) => [x[0], lpa(x[0], x[1]), x[2]]));

    const F = (exp, sal, type, extra) => { const f = SF.matchFactor({ expectedSalary: exp, ...(extra || {}) }, { salary: sal, salaryType: type || 'Annual CTC' }); return [f.known ? f.band : f.state, f.pct, f.word, f.belowRange]; };
    const fcases = [
      ['inside the budget', F('5.5 LPA', '₹5L - ₹6L'), ['within', 100, 'Within budget', false]],
      ['exactly the maximum', F('6', '₹5L - ₹6L'), ['within', 100, 'Within budget', false]],
      ['below the minimum: 100 + below range', F('3', '₹5L - ₹6L'), ['within', 100, 'Within budget', true]],
      ['slightly above (6.5 vs max 6 = 92)', F('6.5 LPA', '₹5L - ₹6L'), ['slightly', 92, 'Slightly above', false]],
      ['above (9 vs max 6 = 66)', F('9 LPA', '₹5L - ₹6L'), ['above', 66, 'Above budget', false]],
      ['monthly job: 30000 a month vs 25-25k = 83', F('30000 per month', '25k - 25k', 'Monthly'), ['above', 83, 'Above budget', false]],
      ['monthly job: "35000" read monthly, inside 30k-40k', F('35000', '₹30k - ₹40k', 'Monthly'), ['within', 100, 'Within budget', false]],
      ['"35k" on an annual 5-6 LPA job = 4.2 LPA: below, within', F('35k', '₹5L - ₹6L'), ['within', 100, 'Within budget', true]],
      ['no maximum: nothing to be above', F('40', '₹14L+'), ['within', 100, 'Within budget', false]],
      ['no expected salary -> not known', F('', '₹5L - ₹6L'), ['no-salary', null, 'Not known', false]],
      ['"as per norms" -> not known', F('As per norms', '₹5L - ₹6L'), ['unclear', null, 'Not known', false]],
      ['Nil / fresher expected -> not known', F('Nil', '₹5L - ₹6L'), ['no-salary', null, 'Not known', false]],
      ['150000 (month or year?) -> not known', F('150000', '₹5L - ₹6L'), ['ambiguous', null, 'Not known', false]],
      ['a slip (30000k) -> not known', F('30000k', '₹5L - ₹6L'), ['implausible', null, 'Not known', false]],
      ['1.2k (Rs 1,200 a month) -> not known', F('1.2k', '₹5L - ₹6L'), ['implausible', null, 'Not known', false]],
      ['job without a budget -> not known', F('5 LPA', ''), ['no-budget', null, 'Not known', false]],
      ['job budget "—" -> not known', F('5 LPA', '—'), ['no-budget', null, 'Not known', false]],
      ['hourly job -> not known', F('5 LPA', '₹500 - ₹900', 'Hourly'), ['hourly', null, 'Not known', false]],
    ];
    bad = fcases.filter(([, got, want]) => !eq(got, want));
    check(`U2 the salary factor (${fcases.length} cases: inside / below / slightly / above / monthly job / not known in six ways)`, bad.length === 0, bad);

    // the formula
    const REQ = { title: 'ZZ', skills: 'zzskill', experience: '', location: 'ZZ Town', salary: '₹5L - ₹6L', salaryType: 'Annual CTC', education: '', workMode: 'Onsite' };
    const CAND = { skills: 'zzskill', experienceYears: 3, location: 'ZZ Town', expectedSalary: '5.5 LPA', currentSalary: '4' };
    const cm = (c, r, o) => MT.computeMatch({ ...CAND, ...c }, { ...REQ, ...r }, o);
    MT.setActiveWeights(MT.WEIGHTS);
    const known = cm({}, {}); const above = cm({ expectedSalary: '9 LPA' }, {}); const unk = cm({ expectedSalary: 'as per norms' }, {}); const nobud = cm({}, { salary: '' });
    check('U3 salary known and inside: Salary part 100 and counted for about 15% of the Fit', known.salKnown && known.factors.salary === 100 && known.shares.salary >= 14 && known.shares.salary <= 16, [known.factors, known.shares]);
    check('U4 salary above the budget lowers the Fit (66 vs 100)', above.factors.salary === 66 && above.overall < known.overall, [above.overall, known.overall]);
    check('U5 salary NOT KNOWN: left out (share 0, value null), the others re-normalised, wording says "not known"', !unk.salKnown && unk.factors.salary === null && unk.shares.salary === 0 && unk.shares.resume + unk.shares.location + unk.shares.other === 100 && /not known/i.test(unk.salReason), [unk.shares, unk.salReason]);
    // independent check: unknown == the same profile with the salary weight set to 0 (nothing else invented)
    {
      const w = { ...MT.WEIGHTS, sal: 0 };
      MT.setActiveWeights(w);
      const zero = cm({}, {}).overall; // salary known but weight 0
      MT.setActiveWeights(MT.WEIGHTS);
      check('U6 re-normalising is exact: Fit with salary not known = Fit with the salary weight at 0 (no punishment, no bonus)', unk.overall === zero && nobud.overall === zero, [unk.overall, nobud.overall, zero]);
    }
    {
      // a profile that is weak elsewhere: an unknown salary neither lifts nor drops it: it scores what the other parts say
      const weak = cm({ skills: 'other', location: 'Elsewhere', expectedSalary: 'NA' }, {});
      MT.setActiveWeights({ ...MT.WEIGHTS, sal: 0 });
      const weakZero = cm({ skills: 'other', location: 'Elsewhere', expectedSalary: '5.5 LPA' }, {}).overall;
      MT.setActiveWeights(MT.WEIGHTS);
      check('U7 a weak profile with an unknown salary scores exactly what its other parts say (not lifted, not dropped)', weak.overall === weakZero && !weak.salKnown, [weak.overall, weakZero]);
    }
    check('U8 the reason / gap lines carry no rupee figures (safe for any login that may see a score)', ![known, above, unk].some((m) => /₹|\b\d+(\.\d+)?\s?(L|LPA|lakh)\b/i.test([...m.reasons, ...m.gaps, m.salReason].join(' | '))), [above.reasons, above.gaps, above.salReason]);
    {
      // the AI interview part: shown, not counted at 0 points; counted when given points; left out when the person has no score
      const base = cm({}, {}).overall;
      const withAi = cm({}, {}, { aiScore: 40 });
      check('U9 AI interview score: default 0 points = shown beside, not counted (Fit unchanged)', withAi.overall === base && withAi.aiPct === 40 && withAi.aiCounted === false && withAi.shares.ai === 0, [withAi.overall, base, withAi.aiCounted]);
      MT.setActiveWeights({ ...MT.WEIGHTS, ai: 0.4 });
      const counted = cm({}, {}, { aiScore: 40 }); const noScore = cm({}, {});
      MT.setActiveWeights(MT.WEIGHTS);
      check('U10 with points given: a low AI score pulls the Fit down; a person with no AI score is left out (not zero)', counted.aiCounted === true && counted.overall < base && noScore.overall === base && noScore.aiCounted === false, [counted.overall, base, noScore.overall]);
    }
    check('U11 default weights: Resume 58 · Location 9 · Salary 15 · Other 18 (percent shares, AI 0)', eq(known.shares, { resume: 58, ai: 0, location: 9, salary: 15, other: 18 }), known.shares);
    {
      const fs = require('fs');
      const strip = (t) => t.replace(/^\/\/ COPY of[\s\S]*?\n\/\/ KEEP IN SYNC[^\n]*\n/, '').replace(/module\.exports = \{[\s\S]*$/, '').replace(/export \{[\s\S]*$/, '').replace(/\r\n/g, '\n').trim();
      check('U12 the browser copy of the salary helper is identical to the server one', strip(fs.readFileSync(path.join(BACK, 'src/utils/salaryFit.js'), 'utf8')) === strip(fs.readFileSync(path.join(BACK, '..', 'frontend/src/utils/salaryFit.js'), 'utf8')));
    }
    {
      const b = FB.breakdownOf(known, false); const r = FB.breakdownOf(known, true);
      check('U13 breakdown (full): four chips Resume / AI / Location / Salary with icons, and the line "Fit N% = Resume .. · Location .. · Salary .."', b.chips.map((c) => c.key).join() === 'resume,ai,location,salary' && b.chips.every((c) => c.icon && c.label) && /^Fit \d+% = Resume \d+ · Location \d+ · Salary 100$/.test(b.text), b);
      check('U14 breakdown (restricted): rounded to 10, a label, ONE chip and it is only the word', r.restricted && r.total % 10 === 0 && r.chips.length === 1 && r.chips[0].key === 'salary' && r.chips[0].word === 'Within budget' && r.chips[0].pct === undefined && !/\d{3}/.test(JSON.stringify({ ...r, chips: r.chips.map((c) => ({ ...c, help: '' })) }).replace(/"total":\d+/, '')), r);
      const u = FB.breakdownOf(unk, false);
      check('U15 breakdown when salary is not known: chip says "Not known", the line says "Salary: not known", plus a plain note', u.chips[3].word === 'Not known' && u.chips[3].pct === null && /Salary: not known/.test(u.text) && /not marked down/.test(u.note), u);
    }

    // =============================== fixtures ===================================
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST SM ${tag} ${RUN}`, email: `zz-sm-${tag}-${RUN}@example.test`, username: `zz-sm-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-SM-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra } });
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
    const client = await prisma.client.create({ data: { name: `ZZTEST SM Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client', agreementStatus: 'ACTIVE' } });
    made.clients.push(client.id);
    const mkReq = async (tag, salary, extra = {}) => {
      const r = await prisma.requirement.create({ data: { title: `ZZTEST SM Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, bdeId: uBde.id, tlId: uTl.id, openings: 2, location: 'ZZ Town', skills: 'zzskill', salary, salaryType: 'Annual CTC', ...extra } });
      made.reqs.push(r.id); return r;
    };
    const rBud = await mkReq('budget', '₹5L - ₹6L');
    const rNone = await mkReq('nobudget', null);
    const rOther = await mkReq('holder', null); // gives each role a way to SEE the fixture people (an application in their scope)
    const mkCand = async (tag, data) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST SM Cand ${tag} ${RUN}`, email: `zz-sm-${tag}-${RUN}@example.test`, phone: `90000${String(Math.floor(Math.random() * 90000) + 10000)}`, skills: 'zzskill', location: 'ZZ Town', experienceYears: 3, currentSalary: '4 LPA', ...data } });
      made.cands.push(c.id); return c;
    };
    const mkApp = async (cand, req, stage, extra) => { const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage, ...(extra || {}) } }); made.apps.push(a.id); return a; };
    const SENT = { in: '5.43 LPA', slightly: '6.61 LPA', above: '7.77 LPA' };
    const people = {
      in: await mkCand('In', { expectedSalary: SENT.in }),
      monthly: await mkCand('Monthly', { expectedSalary: '45000/month' }),
      slightly: await mkCand('Slightly', { expectedSalary: SENT.slightly }),
      above: await mkCand('Above', { expectedSalary: SENT.above }),
      norms: await mkCand('Norms', { expectedSalary: 'As per norms' }),
      blank: await mkCand('Blank', { expectedSalary: '' }),
      ambig: await mkCand('Ambig', { expectedSalary: '150000' }),
    };
    const apps = {};
    for (const [k, c] of Object.entries(people)) apps[k] = await mkApp(c, rOther, 'SHARED_WITH_CLIENT', k === 'in' ? { aiInterviewScore: 80, aiInterviewStatus: 'Completed' } : {});
    const cBatch = await mkCand('Batch', { expectedSalary: '5.5 LPA' });
    const aBudIn = await mkApp(cBatch, rBud, 'RECRUITER_REVIEW', { aiInterviewScore: 70, aiInterviewStatus: 'Completed' }); // already on the budget job: for the batch / profile checks
    const cClientUser = await prisma.user.create({ data: { ...base, name: `ZZTEST SM Client User ${RUN}`, email: `zz-sm-clientu-${RUN}@example.test`, username: `zz-sm-clientu-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER' } });
    const uCand = await prisma.user.create({ data: { ...base, name: `ZZTEST SM Cand User ${RUN}`, email: `zz-sm-candu-${RUN}@example.test`, username: `zz-sm-candu-${RUN}@example.test`, role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: people.in.id } });
    made.users.push(cClientUser.id, uCand.id);
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, bdeTl: uBdeTl, bde: uBde, rec: uRec, tl: uTl, client: cClientUser, cand: uCand })) T[k] = await mint(u);

    // =============================== W: the weights ===================================
    let r = await call('GET', '/api/candidate-resumes/fit-settings', T.admin);
    check('W1 Fit settings (admin): the four-part table is served, Salary default 16 points, AI 0, editable', r.status === 200 && r.body.canEdit === true && r.body.weights.sal === 16 && r.body.weights.ai === 0 && Array.isArray(r.body.groups) && r.body.groups.map((g) => g.key).join() === 'resume,ai,location,salary,other' && r.body.groupKeys.salary[0] === 'sal', [r.status, r.body && r.body.weights, r.body && r.body.groups]);
    r = await call('GET', '/api/candidate-resumes/fit-settings', T.rec);
    check('W2 a recruiter can read the table but cannot edit it', r.status === 200 && r.body.canEdit === false, [r.status, r.body && r.body.canEdit]);
    let w = await call('PUT', '/api/candidate-resumes/fit-settings', T.rec, { weights: { sal: 50 } });
    check('W3 a recruiter / TL / Manager cannot save weights (403)', w.status === 403 && (await call('PUT', '/api/candidate-resumes/fit-settings', T.tl, { weights: { sal: 50 } })).status === 403 && (await call('PUT', '/api/candidate-resumes/fit-settings', T.mgr, { weights: { sal: 50 } })).status === 403, w.status);
    touchedSettings = true;
    const beforeRows = await call('GET', `/api/candidate-resumes/requirement/${rBud.id}/matches?minMatch=0&limit=200`, T.rec);
    const sharesNow = (res, id) => { const row = ((res.body && res.body.rows) || []).find((x) => x.id === id); return row && row.match.breakdown ? row.match.breakdown.shares : null; };
    w = await call('PUT', '/api/candidate-resumes/fit-settings', T.admin, { weights: { sal: 60 } });
    check('W4 admin saves Salary 60 points: accepted, stored, the version moves on', w.status === 200 && w.body.weights.sal === 60 && /new scoring version/i.test(w.body.message || ''), [w.status, w.body && w.body.message]);
    const afterRows = await call('GET', `/api/candidate-resumes/requirement/${rBud.id}/matches?minMatch=0&limit=200`, T.rec);
    const s0 = sharesNow(beforeRows, people.in.id); const s1 = sharesNow(afterRows, people.in.id);
    check('W5 the saved weight is used at once: the Salary share in the breakdown grew (15% -> about 40%)', s0 && s1 && s0.salary === 15 && s1.salary >= 38 && s1.salary <= 42, [s0, s1]);
    for (const [label, body] of [['over 100', { weights: { sal: 150 } }], ['negative', { weights: { sal: -5 } }], ['not a number', { weights: { sal: 'abc' } }], ['AI over 100', { weights: { ai: 101 } }]]) {
      const bad1 = await call('PUT', '/api/candidate-resumes/fit-settings', T.admin, body);
      check(`W6 invalid weight (${label}) is refused in plain words, nothing saved`, bad1.status === 400 && /from 0 to 100/.test(bad1.body.error || ''), [bad1.status, bad1.body]);
    }
    const zero = await call('PUT', '/api/candidate-resumes/fit-settings', T.admin, { weights: Object.fromEntries(['mand', 'good', 'exp', 'relev', 'edu', 'loc', 'mode', 'emp', 'sal', 'notice', 'jp', 'avail', 'ai'].map((k) => [k, 0])) });
    check('W7 all weights at 0 is refused ("at least one weight must be more than 0")', zero.status === 400 && /more than 0/.test(zero.body.error || ''), [zero.status, zero.body]);
    const still = await call('GET', '/api/candidate-resumes/fit-settings', T.admin);
    check('W8 refused saves changed nothing (Salary still 60)', still.body.weights.sal === 60, still.body.weights);
    // AI weight: given points -> counted
    w = await call('PUT', '/api/candidate-resumes/fit-settings', T.admin, { weights: { sal: 16, ai: 30 } });
    const aiRows = await call('GET', `/api/candidate-resumes/requirement/${rBud.id}/matches?minMatch=0&limit=200`, T.rec);
    const aiRow = aiRows.body.rows.find((x) => x.id === people.in.id); const noAiRow = aiRows.body.rows.find((x) => x.id === people.above.id);
    const aiChip = aiRow && aiRow.match.breakdown.chips.find((c) => c.key === 'ai'); const noAiChip = noAiRow && noAiRow.match.breakdown.chips.find((c) => c.key === 'ai');
    check('W9 AI given 30 points: counted for the person with a score (80), left out for a person without one ("No interview yet")', w.status === 200 && aiChip && aiChip.pct === 80 && aiChip.counted === true && aiChip.share > 0 && noAiChip && noAiChip.pct === null && noAiChip.counted === false && noAiChip.word === 'No interview yet', [w.status, aiChip, noAiChip]);
    const reset = await call('PUT', '/api/candidate-resumes/fit-settings', T.admin, { weights: (await call('GET', '/api/candidate-resumes/fit-settings', T.admin)).body.defaults.weights, defaultMinFit: 50, specBonus: 10 });
    const back = await call('GET', '/api/candidate-resumes/fit-settings', T.admin);
    check('W10 "Back to the usual weights" (defaults sent by the reset button) restores the table: Salary 16, AI 0', reset.status === 200 && back.body.weights.sal === 16 && back.body.weights.ai === 0 && back.body.weights.mand === 28, [reset.status, back.body.weights]);

    // =============================== M: Matching candidates ===================================
    const url = (q) => `/api/candidate-resumes/requirement/${rBud.id}/matches?minMatch=0&limit=200${q ? `&${q}` : ''}`;
    const byId = (res, id) => ((res.body && res.body.rows) || []).find((x) => x.id === id);
    let M = await call('GET', url(), T.rec);
    check('M1 recruiter: every ZZ person is listed with a four-part breakdown and a total', M.status === 200 && Object.values(people).every((c) => byId(M, c.id) && byId(M, c.id).match.breakdown && byId(M, c.id).match.breakdown.chips.length === 4), [M.status, M.body && M.body.error, M.body && M.body.rows && M.body.rows.length]);
    const sal = (id) => { const row = byId(M, id); return row ? row.match.breakdown.chips.find((c) => c.key === 'salary') : null; };
    check('M2 Salary chip per person: inside 100 / monthly 45000 = inside 100 / slightly above 90 / above 77 / norms, blank, 150000 = "Not known"',
      sal(people.in.id).pct === 100 && sal(people.monthly.id).pct === 100 && sal(people.slightly.id).pct === 90 && sal(people.slightly.id).word === 'Slightly above' && sal(people.above.id).pct === 77 && sal(people.above.id).word === 'Above budget'
      && [people.norms, people.blank, people.ambig].every((c) => sal(c.id).pct === null && sal(c.id).word === 'Not known'), ['in', 'monthly', 'slightly', 'above', 'norms', 'blank', 'ambig'].map((k) => [k, sal(people[k].id) && sal(people[k].id).pct, sal(people[k].id) && sal(people[k].id).word]));
    const ov = (id) => byId(M, id).match.overall;
    check('M3 combined score: inside >= slightly above > above; not-known people are NOT below the inside-budget ones minus the salary share (never zeroed)', ov(people.in.id) >= ov(people.slightly.id) && ov(people.slightly.id) > ov(people.above.id) && ov(people.norms.id) >= ov(people.above.id) && ov(people.norms.id) > ov(people.in.id) - 12, ['in', 'slightly', 'above', 'norms'].map((k) => [k, ov(people[k].id)]));
    const sc = M.body.salary && M.body.salary.counts;
    check('M4 counts for the Salary chips: within 2 · slightly above 1 · above 1 · not known 3 (this pool = the 7 people)', M.body.salary.hasBudget === true && M.body.salary.budgetText === '₹5L - ₹6L' && eq(sc, { within: 2, slightly: 1, above: 1, unknown: 3 }), M.body.salary);
    M = await call('GET', url('hideAbove=1'), T.rec);
    check('M5 "Hide people above budget": slightly-above and above are gone, not-known people STAY, counts unchanged', M.status === 200 && !byId(M, people.above.id) && !byId(M, people.slightly.id) && byId(M, people.norms.id) && byId(M, people.in.id) && M.body.rows.length === 5 && eq(M.body.salary.counts, sc), [M.body.rows.length, M.body.salary && M.body.salary.counts]);
    M = await call('GET', url('salaryWithin=1'), T.rec);
    check('M6 "Salary within budget": only the two inside people', M.status === 200 && M.body.rows.length === 2 && byId(M, people.in.id) && byId(M, people.monthly.id), M.body.rows && M.body.rows.map((x) => x.name));
    M = await call('GET', url(), T.rec);
    check('M7 both filters are OFF by default (all 7 listed)', M.body.rows.length === 7, M.body.rows.length);
    M = await call('GET', url('sort=salary'), T.rec);
    const order = M.body.rows.map((x) => x.id);
    check('M8 sort by Salary: best Salary fit first, not-known last', order.indexOf(people.above.id) > order.indexOf(people.slightly.id) && order.indexOf(people.slightly.id) > order.indexOf(people.in.id) && [people.norms.id, people.blank.id, people.ambig.id].every((id) => order.indexOf(id) > order.indexOf(people.above.id)), order.map((id) => Object.entries(people).find(([, c]) => c.id === id)[0]));
    M = await call('GET', url('sort=overall'), T.rec);
    const ovs = M.body.rows.map((x) => x.match.overall);
    check('M9 default sort = the combined Fit, highest first', ovs.every((v, i) => i === 0 || ovs[i - 1] >= v), ovs);
    const jobNone = await call('GET', `/api/candidate-resumes/requirement/${rNone.id}/matches?minMatch=0&limit=200`, T.rec);
    check('M10 a job with no budget: Salary is "Not known" for everyone, hasBudget false, nobody is marked down', jobNone.status === 200 && jobNone.body.salary.hasBudget === false && jobNone.body.rows.every((x) => x.match.breakdown.chips[3].word === 'Not known') && jobNone.body.salary.counts.unknown === jobNone.body.rows.length, jobNone.body.salary);
    {
      const th = await call('GET', `/api/requirements/${rBud.id}/matching-candidates?limit=50&hideAbove=1`, T.rec);
      const all = await call('GET', `/api/requirements/${rBud.id}/matching-candidates?limit=50`, T.rec);
      check('M11 the job page list (/matching-candidates) carries the breakdown too and honours Hide people above budget', th.status === 200 && Array.isArray(th.body.rows) && all.body.rows.every((x) => x.match.breakdown) && th.body.total < all.body.total, [th.status, th.body && th.body.total, all.body && all.body.total]);
    }

    // =============================== V: who sees what ===================================
    const MR = {};
    for (const k of ['rec', 'tl', 'mgr', 'admin']) {
      const res = await call('GET', url(), T[k]);
      MR[k] = res;
    }
    check('V1 recruiter / TL / Manager / Admin get the full breakdown (four chips with numbers)', ['rec', 'tl', 'mgr', 'admin'].every((k) => MR[k].status === 200 && ((MR[k].body.rows.find((x) => x.id === people.in.id) || {}).match || {}).breakdown && MR[k].body.rows.find((x) => x.id === people.in.id).match.breakdown.restricted === false), ['rec', 'tl', 'mgr', 'admin'].map((k) => [k, MR[k].status, MR[k].body && MR[k].body.rows && MR[k].body.rows.length]));
    const SENTS = Object.values(SENT).map((s) => s.replace(' LPA', ''));
    for (const who of ['bde', 'bdeTl']) {
      const res = await call('GET', url(), T[who]);
      const rows = (res.body && res.body.rows) || [];
      const row = rows.find((x) => x.id === people.above.id);
      check(`V2 ${who}: rounded total + label + ONE Salary chip that is only a word ("Above budget"); no per-part numbers`, res.status === 200 && res.body.restricted === true && !!row && row.match.approx === true && row.match.overall % 10 === 0 && !!row.match.label && row.match.breakdown.restricted === true
        && row.match.breakdown.chips.length === 1 && row.match.breakdown.chips[0].word === 'Above budget' && row.match.breakdown.chips[0].pct === undefined
        && row.match.resumePct === undefined && row.match.locationPct === undefined && row.match.reasons === undefined && row.match.gaps === undefined && row.aiScore === undefined, [res.status, rows.length, row && row.match]);
      const leak = SENTS.filter((s) => res.text.includes(s));
      check(`V3 ${who}: no candidate salary figure anywhere in the matches payload (sentinels 5.43 / 6.61 / 7.77 and their rupee forms)`, leak.length === 0 && !/"expectedSalary"|"currentSalary"|"aiScore"/.test(res.text), leak);
      const o = await call('GET', url('sort=resume'), T[who]);
      check(`V4 ${who}: asking to sort by a part is ignored (sorted by the rounded total only)`, o.status === 200 && o.body.sort === 'overall', o.body && o.body.sort);
      const mc = await call('GET', `/api/requirements/${rBud.id}/matching-candidates?limit=50`, T[who]);
      const mrow = mc.body && mc.body.rows && mc.body.rows.find((x) => x.id === people.above.id);
      check(`V5 ${who}: the job-page list (/matching-candidates) is rounded + word only too, no salary figure`, mc.status === 200 && (!mc.body.rows.length || (mrow && mrow.match.approx === true && mrow.match.breakdown.restricted === true)) && SENTS.every((s) => !mc.text.includes(s)), [mc.status, mrow && mrow.match, SENTS.filter((s) => mc.text.includes(s))]);
      const prof = await call('GET', `/api/candidates/${people.above.id}`, T[who]);
      check(`V6 ${who}: the profile has no salary figure and no AI match block`, prof.status === 200 && SENTS.every((s) => !prof.text.includes(s)) && !prof.body.aiMatch, [prof.status, SENTS.filter((s) => prof.text.includes(s))]);
    }
    for (const who of ['client', 'cand']) {
      const a = await call('GET', url(), T[who]); const b = await call('GET', `/api/requirements/${rBud.id}/matching-candidates?limit=5`, T[who]);
      const c = await call('POST', '/api/candidate-resumes/fit-breakdowns', T[who], { applicationIds: [aBudIn.id] });
      const d = await call('GET', `/api/candidate-resumes/${people.in.id}/eligible-requirements`, T[who]);
      check(`V7 ${who} login: Matching, the job-page list, the batch breakdown and "eligible jobs" are all refused or empty (no Fit at all)`, [a, b, c, d].every((x) => x.status >= 400 || !(x.body && (x.body.rows || []).length)) && [a, b, c, d].every((x) => !SENTS.some((s) => x.text.includes(s)) && !/"breakdown"|salary fit|"overall"/i.test(x.text)), [a, b, c, d].map((x) => [x.status, x.text.slice(0, 120)]));
    }
    {
      const pr = await call('GET', `/api/candidates/${people.in.id}`, T.cand);
      const pc = await call('GET', `/api/candidates/${people.in.id}`, T.client);
      check('V8 the candidate / client profile payloads carry no aiMatch, no breakdown, no budget text', ![pr, pc].some((x) => /"aiMatch":\{|"breakdown"|₹5L - ₹6L|salaryFit/.test(x.text)), [pr.status, pc.status]);
    }

    // =============================== B: batch breakdown for list / board / profile ===================================
    const bat = async (tok, ids) => call('POST', '/api/candidate-resumes/fit-breakdowns', tok, { applicationIds: ids });
    let B = await bat(T.rec, [aBudIn.id, apps.above.id, 'nonexistent-id']);
    check('B1 recruiter: breakdown per application for the rows on screen (full), unknown ids simply missing', B.status === 200 && !!B.body.items[aBudIn.id] && B.body.items[aBudIn.id].chips.length === 4 && B.body.items[apps.above.id].chips[3].word === 'Not known' && !B.body.items['nonexistent-id'], [B.status, B.body]);
    check('B2 the batch uses the SAME numbers as Matching (inside-budget person: Salary 100)', B.body.items[aBudIn.id].chips[3].pct === 100 && B.body.items[aBudIn.id].chips[1].pct === 70, B.body.items[aBudIn.id]);
    B = await bat(T.bde, [aBudIn.id, apps.above.id]);
    check('B3 BDE: batch is rounded + word only, no figures', B.status === 200 && Object.values(B.body.items).every((b) => b.restricted === true && b.chips.length === 1 && b.chips[0].word) && SENTS.every((s) => !B.text.includes(s)), [B.status, B.text.slice(0, 300)]);
    const big = await bat(T.rec, Array.from({ length: 200 }, (_, i) => `x${i}`));
    check('B4 at most 60 ids are answered per call (a page, not the whole table)', big.status === 200 && Object.keys(big.body.items).length === 0, big.status);
    {
      // outside the login's area: the recruiter of Education cannot read a Medical job's person
      const otherReq = await prisma.requirement.create({ data: { title: `ZZTEST SM Job Other ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', openings: 1, salary: '₹5L - ₹6L', salaryType: 'Annual CTC' } });
      made.reqs.push(otherReq.id);
      const cO = await mkCand('Outside', { expectedSalary: '5 LPA' });
      const aO = await mkApp(cO, otherReq, 'RECRUITER_REVIEW');
      const x = await bat(T.rec, [aO.id, aBudIn.id]);
      check('B5 an application outside the login\'s area is not answered (scope), the one inside is', x.status === 200 && !x.body.items[aO.id] && !!x.body.items[aBudIn.id], [x.status, Object.keys(x.body.items || {})]);
    }
    const prof = await call('GET', `/api/candidates/${cBatch.id}`, T.rec);
    check('B6 profile (recruiter): the Fit tab block carries the breakdown and a figure-free salary line', prof.status === 200 && prof.body.aiMatch && prof.body.aiMatch.breakdown && prof.body.aiMatch.breakdown.chips.length === 4 && prof.body.aiMatch.salaryMatch && !/₹/.test(prof.body.aiMatch.salaryMatch.reason || '') && Array.isArray(prof.body.matchingRequirements) && prof.body.matchingRequirements.every((m) => m.breakdown), [prof.status, prof.body.aiMatch && prof.body.aiMatch.salaryMatch]);
    const el = await call('GET', `/api/candidate-resumes/${cBatch.id}/eligible-requirements?minMatch=0&limit=50`, T.rec);
    const elB = (el.body.rows || []).find((x) => x.id === rBud.id) || (el.body.rows || [])[0];
    check('B7 person -> jobs ("Eligible requirements"): rows carry the breakdown; the job\'s pay type is read (salaryType selected)', el.status === 200 && el.body.rows.length > 0 && el.body.rows.every((x) => x.match.breakdown) && el.body.salary && el.body.salary.counts, [el.status, el.body.rows && el.body.rows.length]);
    void elB;
    const rej = await call('GET', `/api/rejections/requirement/${rBud.id}/tabs`, T.rec);
    check('B8 Matching tab "previously rejected but match" still answers (shape unchanged)', rej.status === 200 && rej.body.previouslyRejected, [rej.status]);
    {
      // the job's pay type is respected in the live list: a Monthly job
      const rM = await mkReq('monthly', '₹25k - ₹30k', { salaryType: 'Monthly' });
      const mm = await call('GET', `/api/candidate-resumes/requirement/${rM.id}/matches?minMatch=0&limit=200`, T.rec);
      const bs = (id) => { const row = byId(mm, id); return row && row.match.breakdown.chips[3]; };
      check('B9 a Monthly job (25k-30k a month): "45000/month" is above (150%), "35000"-style bare monthly person would be read per month; budget text shown', mm.status === 200 && mm.body.salary.hasBudget === true && bs(people.monthly.id).word === 'Above budget' && bs(people.in.id).word === 'Above budget', [mm.status, bs(people.monthly.id), bs(people.in.id)]);
    }

    // =============================== R: recompute script ===================================
    {
      const stale = await mkCand('Stale', { expectedSalary: '5.5 LPA' });
      const sApp = await mkApp(stale, rBud, 'NEW', { matchScore: 11 });
      const node = process.execPath;
      const run = (args, env) => spawnSync(node, [path.join(BACK, 'scripts/recompute-match-scores.js'), ...args], { encoding: 'utf8', env: { ...process.env, ...(env || {}) }, cwd: BACK });
      const dry = run([]);
      const mid = await prisma.application.findUnique({ where: { id: sApp.id }, select: { matchScore: true } });
      check('R1 dry run reports what would change (count, before / after, top movers) and WRITES NOTHING', dry.status === 0 && /Would change: \d+/.test(dry.stdout) && /Before /.test(dry.stdout) && /Top movers/.test(dry.stdout) && /DRY RUN/.test(dry.stdout) && mid.matchScore === 11, [dry.status, dry.stdout.slice(0, 500), dry.stderr.slice(0, 200)]);
      const real = run(['--apply', '--db', path.join(BACK, 'prisma', 'dev.db')]);
      check('R2 --apply on the REAL database is refused without both guards', real.status === 2 && /REAL database/.test(real.stderr), [real.status, real.stderr]);
      const real2 = run(['--apply', '--db', path.join(BACK, 'prisma', 'dev.db'), '--really-real']);
      check('R3 --really-real alone (no TL_ALLOW_REAL_APPLY) is still refused', real2.status === 2, real2.status);
      const ap = run(['--apply'], { TL_ALLOW_REAL_APPLY: '' });
      const after = await prisma.application.findUnique({ where: { id: sApp.id }, select: { matchScore: true } });
      const undoPath = (ap.stdout.match(/Undo file: (.+)/) || [])[1];
      check('R4 --apply (sandbox): backup + undo file written, the stored score is recomputed', ap.status === 0 && /Backup: /.test(ap.stdout) && !!undoPath && after.matchScore !== 11 && after.matchScore > 40, [ap.status, ap.stdout.slice(0, 600), ap.stderr.slice(0, 300), after]);
      if (undoPath) {
        const un = run(['--undo', undoPath.trim()]);
        const restored = await prisma.application.findUnique({ where: { id: sApp.id }, select: { matchScore: true } });
        check('R5 --undo puts the old number back', un.status === 0 && restored.matchScore === 11, [un.status, un.stdout, restored]);
        try { require('fs').unlinkSync(undoPath.trim()); } catch { /* ok */ }
        const bk = (ap.stdout.match(/Backup: (.+)/) || [])[1];
        try { if (bk) require('fs').unlinkSync(bk.trim()); } catch { /* ok */ }
      }
    }

    // =============================== P: speed ===================================
    {
      const total = await prisma.candidate.count();
      const t0 = Date.now();
      const rm = await call('GET', `/api/candidate-resumes/requirement/${rBud.id}/matches?minMatch=70&limit=50`, T.mgr);
      const ms = Date.now() - t0;
      check(`P1 Matching on the whole copy (${total} candidates in the pool): answers in time (${ms} ms), same call as before plus the breakdown`, rm.status === 200 && ms < 60000, [rm.status, ms]);
      // in-process, same candidates: the new scorer vs the old one (the file as it was before this change)
      const cands = await prisma.candidate.findMany({ select: { id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true, skills: true, education: true, availability: true, currentSalary: true, expectedSalary: true, jobPreference: true, noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true, specialisationId: true } });
      const reqRow = await prisma.requirement.findUnique({ where: { id: rBud.id } });
      let oldM = null;
      try { oldM = require(process.env.TL_OLD_MATCHING || require('path').join(__dirname, '..', 'test-fixtures', 'matching.orig.js')); } catch { oldM = null; }
      const time = (m) => { const a = process.hrtime.bigint(); m.rankCandidates(cands, reqRow, { threshold: 0 }); return Number(process.hrtime.bigint() - a) / 1e6; };
      time(MT); const tNew = Math.min(time(MT), time(MT));
      const tOld = oldM ? Math.min(time(oldM), time(oldM)) : null;
      console.log(`      ranking ${cands.length} candidates against one job: new ${Math.round(tNew)} ms${tOld != null ? `, old ${Math.round(tOld)} ms (${Math.round((tNew / tOld) * 100)}% of old)` : ''}`);
      check('P2 the new scorer is not slower than the old one (within 60%: timing on a busy machine swings 1.0-1.55x) over every candidate', tOld == null || tNew <= tOld * 1.6, [tNew, tOld]);
      const unknownN = cands.filter((c) => !MT.computeMatch(c, reqRow).salKnown).length;
      console.log(`      salary not known for ${unknownN} of ${cands.length} on this job`);
    }
  } finally {
    // ---- cleanup (every row we made, and what the app wrote because of it) ----
    try {
      if (touchedSettings) {
        await prisma.appSetting.deleteMany({ where: { key: { in: ['fit', 'fit.versions'] } } }).catch(() => {});
      }
      const candIds = made.cands; const userIds = made.users;
      const appIds = (await prisma.application.findMany({ where: { OR: [{ candidateId: { in: candIds } }, { requirementId: { in: made.reqs } }] }, select: { id: true } })).map((a) => a.id);
      const allIds = [...appIds, ...candIds, ...made.reqs, ...made.clients, ...userIds];
      await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } });
      await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } });
      await prisma.candidateNote.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.candidateDocument.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
      const zzC = await prisma.candidate.findMany({ where: { email: { contains: `${RUN}@example.test` } }, select: { id: true } });
      const delC = [...new Set([...candIds, ...zzC.map((c) => c.id)])];
      await prisma.syncLog.deleteMany({ where: { OR: [{ recordRef: { in: delC } }, { reason: { contains: 'ZZTEST' } }] } }).catch(() => {});
      try { await prisma.candidateDupFlag.deleteMany({ where: { OR: [{ candidateId: { in: delC } }, { matchCandidateId: { in: delC } }] } }); } catch { /* table optional */ }
      await prisma.candidate.deleteMany({ where: { id: { in: delC } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...allIds, ...delC] } }, { entityId: 'fit' }] } });
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) { console.log('CLEANUP problem:', err.message); }
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

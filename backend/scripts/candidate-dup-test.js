#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CANDIDATE DUPLICATES acceptance tests (2026-10-10). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/candidate-dup-test.js
//
//   F  fingerprints: phone / e-mail / date-of-birth variants, resume hash, resume-text similarity, classification
//   D  detection at the entry doors (Add candidate, edit, import-style create, portal-style create, resume stored),
//      imports are flagged but silent, a corrected phone closes the flag
//   G  THE GATE: a flagged person cannot leave the first step (PATCH stage, bulk, Send to ATS) — 409 in plain words —
//      Hold / Reject stay possible, POSSIBLE never holds, people past the first step are not held, settings switch
//   R  resolutions: Not a duplicate (reason, remembered) · Same person different job (+ alias, same-job refused) ·
//      Reject duplicate · merge (preview, field choices, undo, undo window) · maker-checker (recruiter asks, TL approves,
//      wrong TL 403, decline)
//   W  worklist: counts equal the database, facets, badge, bulk, auto-merge proposals (dry list), first-load time
//   P  privacy: BDE / BDE TL / Manager / out-of-area payloads carry no phone / e-mail
//   X  performance on the full copy: detection per candidate, worklist first load
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');
const crypto = require('crypto');

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
const FP = require(path.join(BACK, 'src/utils/candidateFingerprint'));
const DUP = require(path.join(BACK, 'src/utils/candidateDupes'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => String(Math.floor(1000000000 + Math.random() * 8999999999)).replace(/^(\d)/, (d) => (d === '0' ? '9' : d)).slice(0, 10).replace(/^([0-5])/, '9');
const words = 'java spring boot microservices kubernetes docker react node sql oracle mysql python django flask testing selenium agile scrum jira teaching curriculum lesson physics maths chemistry nursing patient ward ICU theatre welding lathe cnc fitter turner quality audit iso sales marketing seo content design figma'.split(' ');
const resumeText = (seed, n = 220) => { let x = seed * 7919 + 13; const out = []; for (let i = 0; i < n; i += 1) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; out.push(`w${(x % 900000).toString(36)}`); } return out.join(' '); };

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: new Set(), apps: [] };
  const trackCand = (id) => { if (id) made.cands.add(id); return id; };
  const T = {};
  try {
    // ============================== F: fingerprints (pure) ==============================
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check('F1 phone variants agree', same(FP.normPhones('+91 90123 45678'), FP.normPhones('09012345678')) && same(FP.normPhones('090123-45678'), FP.normPhones('9012345678')) && FP.normPhones('90123 45678')[0] === '9012345678');
    check('F2 junk phones are no key', FP.normPhones('9999999999').length === 0 && FP.normPhones('1234567890').length === 0 && FP.normPhones('0000000000').length === 0);
    check('F3 two numbers in one cell give two keys', FP.normPhones('9012345678, 9112345678').length === 2);
    check('F4 gmail dots and +tag are ignored', FP.normEmail('Ra.hul.Kumar+jobs@Gmail.com') === 'rahulkumar@gmail.com' && FP.normEmail('rahulkumar@googlemail.com') === 'rahulkumar@gmail.com');
    check('F5 other domains: +tag ignored, dots kept', FP.normEmail('a.b+x@corp.in') === 'a.b@corp.in');
    check('F6 date of birth formats', ['1995-03-12', '12/03/1995', '12-3-1995', '12.03.95', '12 Mar 1995', 'March 12, 1995'].every((d) => FP.normDob(d) === '1995-03-12') && FP.normDob('31/02/1800') === '' && FP.normDob('abc') === '');
    check('F7 name order does not matter', FP.normName('Rahul Kumar') === FP.normName('Kumar  RAHUL') && FP.normName('C. Pravalika') === FP.normName('Pravalika C'));
    const a1 = FP.fingerprintsOf({ name: 'Rahul Kumar', phone: '+91 90123 45678', email: 'Rahul.Kumar@gmail.com', dob: '12/03/1995', location: 'Hyderabad, Telangana', institute: 'JNTU Hyderabad', currentCompany: 'Infosys' });
    const kinds = new Set(a1.map((k) => k.kind));
    check('F8 a full profile yields phone, email, name+dob, name+city, name+college, name+company keys', ['PHONE', 'EMAIL', 'NAME_DOB', 'NAME_CITY', 'NAME_COLLEGE', 'NAME_COMPANY'].every((k) => kinds.has(k)), [...kinds]);
    check('F9 same resume bytes -> same SHA-256 key', FP.sha256(Buffer.from('abc')) === FP.sha256(Buffer.from('abc')) && FP.fingerprintsOf({ name: 'Zed' }, { shas: ['ABCD'] }).some((k) => k.kind === 'RESUME_HASH' && k.value === 'abcd'));
    const t1 = resumeText(11); const t2 = t1.split(' ').map((w, i) => (i % 25 === 0 ? 'changed' + i : w)).join(' '); const t3 = resumeText(97);
    const s1 = FP.resumeSignature(t1); const s2 = FP.resumeSignature(t2); const s3 = FP.resumeSignature(t3);
    check('F10 near-identical resume text: high similarity and a shared LSH band', FP.sigSimilarity(s1.sig, s2.sig) >= 0.75 && FP.bandKeys(s1.sig).some((b) => FP.bandKeys(s2.sig).includes(b)), FP.sigSimilarity(s1.sig, s2.sig));
    check('F11 different resumes: low similarity', FP.sigSimilarity(s1.sig, s3.sig) < 0.5, FP.sigSimilarity(s1.sig, s3.sig));
    check('F12 too little text gives no signature', FP.resumeSignature('short text') === null);
    check('F13 classify: phone/email -> CERTAIN', FP.classify(new Set(['PHONE'])).level === 'CERTAIN' && FP.classify(new Set(['EMAIL', 'NAME_CITY'])).level === 'CERTAIN');
    check('F14 classify: name+dob / resume hash -> LIKELY; name+city -> POSSIBLE', FP.classify(new Set(['NAME_DOB'])).level === 'LIKELY' && FP.classify(new Set(['RESUME_HASH'])).level === 'LIKELY' && FP.classify(new Set(['NAME_CITY'])).level === 'POSSIBLE');
    check('F15 classify: resume-like + same name -> LIKELY; different name -> POSSIBLE; weak similarity ignored',
      FP.classify(new Set(['RESUME_BAND']), { similarity: 0.9, nameAgreement: 'same' }).level === 'LIKELY'
      && FP.classify(new Set(['RESUME_BAND']), { similarity: 0.9, nameAgreement: 'different' }).level === 'POSSIBLE'
      && FP.classify(new Set(['RESUME_BAND']), { similarity: 0.4, nameAgreement: 'same' }) === null);

    // ============================== fixtures ==============================
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST DUP ${tag} ${RUN}`, email: `zz-dup-${tag}-${RUN}@example.test`, username: `zz-dup-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsAccess: true, hrmsRole: 'MANAGER' });
    const uRecA = await mkUser('reca', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uRecA2 = await mkUser('reca2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uRecB = await mkUser('recb', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    const uTlA = await mkUser('tla', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uTlB = await mkUser('tlb', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, recA: uRecA, recA2: uRecA2, recB: uRecB, tlA: uTlA, tlB: uTlB, bde: uBde, bdeTl: uBdeTl })) T[k] = await mint(u);

    // the candidate list's in-memory copy is built on first use (minutes on a busy machine): warm it once, so no check below waits for it
    await call('GET', '/api/candidates?paged=1&view=master&sub=all&pageSize=25', T.admin);
    const cEdu = await prisma.client.create({ data: { name: `ZZTEST DUP Client edu ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client' } });
    const cMed = await prisma.client.create({ data: { name: `ZZTEST DUP Client med ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Medical', clientType: 'Client' } });
    made.clients.push(cEdu.id, cMed.id);
    const mkReq = async (tag, client, dept, rec, bde, tl) => {
      const r = await prisma.requirement.create({ data: { title: `ZZTEST DUP Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: dept, recruiterId: rec.id, bdeId: bde ? bde.id : null, tlId: tl ? tl.id : null, tl: tl ? tl.name : null, openings: 3 } });
      made.reqs.push(r.id); return r;
    };
    const rEdu1 = await mkReq('edu1', cEdu, 'Education', uRecA, uBde, uTlA);
    const rEdu2 = await mkReq('edu2', cEdu, 'Education', uRecA, uBde, uTlA);
    const rEdu3 = await mkReq('edu3', cEdu, 'Education', uRecA, uBde, uTlA);
    const rMed = await mkReq('med', cMed, 'Medical', uRecB, null, uTlB);

    const P = () => rnd();
    const mkCand = async (label, data = {}) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST DUP ${label} ${RUN}`, source: 'Naukri', currentSalary: '0', expectedSalary: '100000', ...data } });
      trackCand(c.id); return c;
    };
    const mkApp = async (cand, req, stage = 'NEW', extra = {}) => {
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage, ...extra } });
      made.apps.push(a.id); return a;
    };
    const flagsBetween = async (a, b) => (await DUP.q('SELECT * FROM CandidateDupFlag WHERE pairKey = ?', DUP.pairKeyOf(a, b))).map(DUP.flagOut);
    const flagOf = async (a, b) => (await flagsBetween(a, b))[0] || null;
    const stageOf = async (appId) => (await prisma.application.findUnique({ where: { id: appId } })).stage;
    const move = (tok, appId, stage, extra) => call('PATCH', `/api/applications/${appId}/stage`, tok, { stage, ...(extra || {}) });

    await sleep(500);
    check('S0 the duplicate tables exist in this database', await DUP.supported());

    // ============================== D: detection at the doors ==============================
    // an existing, established profile (older), at a later step
    const phoneOld = P(); const emailOld = `zz.dup.old.${RUN}@gmail.com`;
    const old = await mkCand('Rahul Kumar', { phone: `+91 ${phoneOld.slice(0, 5)} ${phoneOld.slice(5)}`, email: emailOld, dob: '12/03/1995', location: 'Hyderabad', institute: 'ZZ College' });
    const oldApp = await mkApp(old, rEdu1, 'RECRUITER_REVIEW');
    await sleep(100);

    // D1: Add candidate (HTTP) with the same phone written differently — refused for a recruiter (409), allowed for an Admin (flag CERTAIN)
    const addBody = (over) => ({ name: `ZZTEST DUP Rahul K ${RUN}`, phone: phoneOld, email: `other.${RUN}@example.test`, skills: 'java', currentSalary: '0', expectedSalary: '100000', ...over });
    const dupAdd = await call('POST', '/api/candidates', T.recA, addBody({}));
    check('D1 Add candidate: same phone is refused for a recruiter (409, existing check kept)', dupAdd.status === 409 && dupAdd.body && dupAdd.body.duplicate === true, dupAdd.status);
    const adminAdd = await call('POST', '/api/candidates', T.admin, addBody({ overrideDuplicate: true, overrideReason: 'test' }));
    trackCand(adminAdd.body && adminAdd.body.id);
    check('D2 Add candidate by an Admin with "Create new profile": created and flagged CERTAIN against the older profile', adminAdd.status === 201, adminAdd.body);
    const f2 = adminAdd.body && adminAdd.body.id ? await flagOf(old.id, adminAdd.body.id) : null;
    check('D3 the flag holds the NEWER profile, level CERTAIN, reason phone, door recorded', !!f2 && f2.candidateId === adminAdd.body.id && f2.matchCandidateId === old.id && f2.level === 'CERTAIN' && f2.reasons.includes('phone') && f2.status === 'OPEN', f2);
    check('D4 the Add response tells the screen it is held (dup.level)', adminAdd.body && adminAdd.body.dup && adminAdd.body.dup.level === 'CERTAIN' && adminAdd.body.dup.holds === true, adminAdd.body && adminAdd.body.dup);
    check('D5 who entered it is recorded on the flag', f2 && f2.enteredById === uAdmin.id, f2 && f2.enteredById);

    // D6: e-mail variants (gmail dots / +tag) caught by an import-style create
    const viaEmail = await mkCand('Email Variant', { email: `zzdupold${RUN}+jobs@GMAIL.com`, phone: P() });
    await sleep(150);
    const f6 = await flagOf(old.id, viaEmail.id);
    check('D6 import-style create with a gmail-variant e-mail is flagged CERTAIN (email)', !!f6 && f6.level === 'CERTAIN' && f6.reasons.includes('email'), f6);

    // D7: name + date of birth (different phone/email) -> LIKELY
    const viaDob = await mkCand('Rahul Kumar', { name: 'Kumar Rahul', phone: P(), email: `d.${RUN}@example.test`, dob: '1995-03-12' });
    await sleep(150);
    // names differ by run-tag in mkCand; make the name identical to the old one
    await prisma.candidate.update({ where: { id: viaDob.id }, data: { name: old.name } });
    await sleep(150);
    const f7 = await flagOf(old.id, viaDob.id);
    check('D7 same name + date of birth (other formats) is LIKELY', !!f7 && f7.level === 'LIKELY' && f7.reasons.includes('name_dob'), f7);

    // D8: Job-portal style create (careers / public apply / partner) with the same phone
    const viaPortal = await mkCand('Portal Person', { source: 'Job Portal', phone: `0${phoneOld}`, email: null });
    await sleep(150);
    const f8 = await flagOf(old.id, viaPortal.id);
    check('D8 portal-style create (source Job Portal), phone with a leading 0: CERTAIN', !!f8 && f8.level === 'CERTAIN' && f8.door === 'Job Portal', f8);

    // D9: resume stored with the same file hash -> LIKELY; near-identical text, same name -> LIKELY
    const sha = crypto.createHash('sha256').update(`resume-${RUN}`).digest('hex');
    const rOld = await mkCand('Resume Holder', { phone: P() });
    await prisma.candidateResume.create({ data: { candidateId: rOld.id, kind: 'ORIGINAL', fileName: 'a.pdf', sha256: sha, text: resumeText(5) } });
    const rNew = await mkCand('Resume Copy', { phone: P() });
    await prisma.candidateResume.create({ data: { candidateId: rNew.id, kind: 'ORIGINAL', fileName: 'b.pdf', sha256: sha, text: resumeText(5) } });
    await sleep(200);
    const f9 = await flagOf(rOld.id, rNew.id);
    check('D9 the same resume file stored on another profile is LIKELY (resume file)', !!f9 && f9.level === 'LIKELY' && f9.reasons.includes('resume_same'), f9);
    const sameName = `ZZTEST DUP Sameresume ${RUN}`;
    const rl1 = await mkCand('x1', { name: sameName, phone: P() });
    await prisma.candidateResume.create({ data: { candidateId: rl1.id, kind: 'ORIGINAL', fileName: 'c.pdf', sha256: crypto.randomBytes(16).toString('hex'), text: t1 } });
    const rl2 = await mkCand('x2', { name: sameName, phone: P() });
    await prisma.candidateResume.create({ data: { candidateId: rl2.id, kind: 'ORIGINAL', fileName: 'd.pdf', sha256: crypto.randomBytes(16).toString('hex'), text: t2 } });
    await sleep(200);
    const f9b = await flagOf(rl1.id, rl2.id);
    check('D9b near-identical resume text + same name is LIKELY (resume text)', !!f9b && f9b.level === 'LIKELY' && f9b.reasons.includes('resume_like'), f9b);
    const rl3 = await mkCand('x3', { name: `ZZTEST DUP Other ${RUN}`, phone: P() });
    await prisma.candidateResume.create({ data: { candidateId: rl3.id, kind: 'ORIGINAL', fileName: 'e.pdf', sha256: crypto.randomBytes(16).toString('hex'), text: t3 } });
    await sleep(150);
    check('D9c a different resume is not flagged', !(await flagOf(rl1.id, rl3.id)));

    // D10: POSSIBLE (same name + city) warns only
    const pName = `ZZTEST DUP Possible Person ${RUN}`;
    const p1 = await mkCand('p1', { name: pName, phone: P(), location: 'Warangal' });
    const p2 = await mkCand('p2', { name: pName, phone: P(), location: 'Warangal, Telangana' });
    await sleep(150);
    const f10 = await flagOf(p1.id, p2.id);
    check('D10 same name + city is POSSIBLE', !!f10 && f10.level === 'POSSIBLE' && f10.reasons.includes('name_city'), f10);

    // D11: phone corrected -> the open flag closes by itself; a different candidate (unique phone) is not flagged at all
    const uniq = await mkCand('Unique One', { phone: P(), email: `u.${RUN}@example.test` });
    await sleep(100);
    check('D11 a unique candidate gets keys but no flag', (await DUP.q('SELECT COUNT(*) n FROM CandidateDupFlag WHERE candidateId = ? OR matchCandidateId = ?', uniq.id, uniq.id))[0].n === 0 && (await DUP.q('SELECT COUNT(*) n FROM CandidateDupKey WHERE candidateId = ?', uniq.id))[0].n >= 2);
    const edit = await call('PUT', `/api/candidates/${viaPortal.id}`, T.admin, { phone: P() });
    await sleep(150);
    const f11 = await flagOf(old.id, viaPortal.id);
    check('D12 correcting the phone (edit) closes the flag (AUTO_CLOSED)', edit.status === 200 && f11 && f11.status === 'AUTO_CLOSED', [edit.status, f11 && f11.status]);
    const back = await call('PUT', `/api/candidates/${viaPortal.id}`, T.admin, { phone: phoneOld, overrideDuplicate: true });
    await sleep(150);
    const f11b = await flagOf(old.id, viaPortal.id);
    check('D13 the same phone again: the pair is checked again (not hidden by the old closed flag silently)', back.status === 200 && !!f11b, [back.status, f11b && f11b.status]);

    // D14: an import burst is flagged but nobody is notified
    const before = await prisma.notification.count({ where: { OR: [{ userId: uRecA.id }, { userId: uTlA.id }], title: { startsWith: 'Duplicate profile' } } });
    const burst = [];
    for (let i = 0; i < 8; i += 1) burst.push(await mkCand(`Burst ${i}`, { phone: phoneOld, source: 'Excel import' }));
    await sleep(300);
    const burstFlags = await DUP.q(`SELECT COUNT(*) n FROM CandidateDupFlag WHERE candidateId IN (${burst.map(() => '?').join(',')}) AND status = 'OPEN'`, ...burst.map((b) => b.id));
    const after = await prisma.notification.count({ where: { OR: [{ userId: uRecA.id }, { userId: uTlA.id }], title: { startsWith: 'Duplicate profile' } } });
    check('D14 an import-style burst is flagged (placeholder numbers shared by many are ignored beyond the limit) but silent', after === before, [before, after, burstFlags[0].n]);

    // ============================== G: the gate ==============================
    // a recruiter's own new profile with a duplicate flag, two applications at the first step
    const gA = await mkCand('Gate A', { phone: P(), email: `gate.a.${RUN}@example.test`, name: `ZZTEST DUP Gate Person ${RUN}` });
    const gOld = await mkCand('Gate Old', { phone: gA.phone, email: null, name: `ZZTEST DUP Gate Person ${RUN}` });
    // gOld is created AFTER gA (same phone) -> gOld is the newer = the held one
    await sleep(200);
    const gFlag = await flagOf(gA.id, gOld.id);
    check('G0 fixture: pair flagged, the newer one is held', !!gFlag && gFlag.candidateId === gOld.id && gFlag.level === 'CERTAIN', gFlag);
    const gApp1 = await mkApp(gOld, rEdu1, 'NEW', { source: 'Naukri' });
    const gApp2 = await mkApp(gOld, rEdu2, 'RECRUITER_REVIEW', { source: 'Naukri' });
    const ctl = await mkCand('Control', { phone: P() });
    const ctlApp = await mkApp(ctl, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' });
    const ctlMove = await move(T.recA, ctlApp.id, 'TL_REVIEW');
    check('G1 control: an unflagged person moves on from Recruiter review', ctlMove.status === 200, ctlMove.body);
    const m1 = await move(T.recA, gApp2.id, 'TL_REVIEW');
    check('G2 the flagged person is refused (409, code DUPLICATE_OPEN, plain words)', m1.status === 409 && m1.body.code === 'DUPLICATE_OPEN' && /Duplicate: resolve first/.test(m1.body.error) && /Check duplicates/.test(m1.body.error), m1.body);
    check('G3 and stays where they were', (await stageOf(gApp2.id)) === 'RECRUITER_REVIEW');
    const m2 = await move(T.admin, gApp2.id, 'TL_REVIEW');
    check('G4 an Admin is held too (no exceptions: resolve it)', m2.status === 409 && m2.body.code === 'DUPLICATE_OPEN', m2.body);
    const m3 = await move(T.recA, gApp1.id, 'RECRUITER_REVIEW');
    check('G5 moving WITHIN the first step is allowed (New -> Recruiter review)', m3.status === 200, m3.body);
    const bulk = await call('POST', '/api/applications/bulk', T.recA, { action: 'stage', stage: 'TL_REVIEW', applicationIds: [gApp1.id, gApp2.id] });
    check('G6 bulk move: each flagged row refused with the duplicate message', bulk.status === 200 && bulk.body.failed === 2 && bulk.body.results.every((r) => /Duplicate: resolve first/.test(r.error || '')), bulk.body);
    const board = await call('POST', '/api/candidates/board/move', T.recA, { applicationId: gApp2.id, column: 'tl_check' });
    check('G7 board drag: refused, not moved', (await stageOf(gApp2.id)) === 'RECRUITER_REVIEW' && board.status !== 200, [board.status, board.body]);
    const hold = await move(T.recA, gApp2.id, 'HOLD', { reasonCategory: 'Other', comment: 'waiting' });
    check('G8 Hold stays possible', hold.status === 200, hold.body);
    const resume = await move(T.recA, gApp2.id, 'TL_REVIEW');
    check('G9 resuming from Hold into a later step is held as well', resume.status === 409 && resume.body.code === 'DUPLICATE_OPEN', resume.body);
    await move(T.recA, gApp2.id, 'RECRUITER_REVIEW');
    const rej = await move(T.recA, gApp1.id, 'REJECTED', { rejectedBy: 'Internal', reasonCategory: 'Not suitable', reasonDetail: 'x' });
    check('G10 Reject stays possible', rej.status === 200, rej.body);
    // possible does not hold
    const pApp = await mkApp(p2, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' });
    const pm = await move(T.recA, pApp.id, 'TL_REVIEW');
    check('G11 a POSSIBLE flag never holds', pm.status === 200, pm.body);
    // past the first step is not held
    const lateOld = await mkCand('Late', { phone: gA.phone });
    await sleep(150);
    const lateApp = await mkApp(lateOld, rEdu3, 'TL_REVIEW', { source: 'Naukri' });
    const lateMove = await move(T.tlA, lateApp.id, 'WITH_BDE');
    check('G12 a flagged person already past the first step is not held (no mass blocking)', lateMove.status !== 409 || !(lateMove.body && lateMove.body.code === 'DUPLICATE_OPEN'), lateMove.body);
    // settings switch
    const off = await call('POST', '/api/candidate-duplicates/settings', T.admin, { gate: false });
    const offMove = await move(T.recA, gApp2.id, 'TL_REVIEW');
    const on = await call('POST', '/api/candidate-duplicates/settings', T.admin, { gate: true });
    check('G13 Admin can switch the hold off and on (flags keep being raised); a recruiter cannot', off.status === 200 && offMove.status === 200 && on.status === 200 && (await call('POST', '/api/candidate-duplicates/settings', T.recA, { gate: false })).status === 403, [off.status, offMove.status, offMove.body]);
    await prisma.application.update({ where: { id: gApp2.id }, data: { stage: 'RECRUITER_REVIEW' } });
    await sleep(100);

    // ============================== R: resolutions ==============================
    // R1 Not a duplicate: reason needed, remembered
    const rn = await call('POST', `/api/candidate-duplicates/flags/${gFlag.id}/not-duplicate`, T.recA, { reason: '' });
    check('R1 Not a duplicate needs a reason (400)', rn.status === 400, rn.body);
    const rn2 = await call('POST', `/api/candidate-duplicates/flags/${gFlag.id}/not-duplicate`, T.recA, { reason: 'Father and son share a phone' });
    check('R2 Not a duplicate by the owner recruiter works', rn2.status === 200 && rn2.body.status === 'NOT_DUPLICATE', rn2.body);
    const gm = await move(T.recA, gApp2.id, 'TL_REVIEW');
    check('R3 the person can move on right after', gm.status === 200, gm.body);
    // remembered: edit the phone away and back; the pair is not flagged again
    await call('PUT', `/api/candidates/${gOld.id}`, T.admin, { phone: P() });
    await call('PUT', `/api/candidates/${gOld.id}`, T.admin, { phone: gA.phone, overrideDuplicate: true });
    await sleep(250);
    const again = await flagOf(gA.id, gOld.id);
    check('R4 remembered: the pair stays "not a duplicate" and is not flagged again', again && again.status === 'NOT_DUPLICATE', again && again.status);

    // R5 Same person, different job -> merge keeping both applications; alias
    const sOld = await mkCand('Same Person', { phone: P(), email: `sp.${RUN}@example.test`, location: 'Guntur' });
    await mkApp(sOld, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' });
    const sNew = await mkCand('Same Person Dup', { name: sOld.name, phone: sOld.phone, email: `sp2.${RUN}@example.test`, location: null });
    const sNewApp = await mkApp(sNew, rEdu2, 'NEW', { source: 'Naukri' });
    await sleep(200);
    const sFlag = await flagOf(sOld.id, sNew.id);
    check('R5 fixture: flagged, new profile held', !!sFlag && sFlag.candidateId === sNew.id && sFlag.status === 'OPEN', sFlag);
    const sp = await call('POST', `/api/candidate-duplicates/flags/${sFlag.id}/same-person`, T.recA);
    check('R6 Same person, different job: done by the recruiter', sp.status === 200 && sp.body.masterId === sOld.id && sp.body.mergeLogId, sp.body);
    const appsAfter = await prisma.application.findMany({ where: { candidateId: sOld.id } });
    check('R7 both applications now sit on the existing profile', appsAfter.length === 2 && appsAfter.some((a) => a.id === sNewApp.id), appsAfter.length);
    check('R8 the new duplicate profile is gone and its old id still opens the kept profile (alias)',
      !(await prisma.candidate.findUnique({ where: { id: sNew.id } })) && (await call('GET', `/api/candidates/${sNew.id}`, T.recA)).body?.id === sOld.id, (await call('GET', `/api/candidates/${sNew.id}`, T.recA)).status);
    const sFlagAfter = await DUP.getFlag(sFlag.id);
    check('R9 flag closed as SAME_PERSON_OTHER_JOB with the merge log id', sFlagAfter.status === 'SAME_PERSON_OTHER_JOB' && !!sFlagAfter.mergeLogId, sFlagAfter);
    // same job on both -> refused
    const jOld = await mkCand('Samejob', { phone: P() });
    await mkApp(jOld, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' });
    const jNew = await mkCand('Samejob dup', { name: jOld.name, phone: jOld.phone });
    await mkApp(jNew, rEdu1, 'NEW', { source: 'Naukri' });
    await sleep(200);
    const jFlag = await flagOf(jOld.id, jNew.id);
    const jsp = await call('POST', `/api/candidate-duplicates/flags/${jFlag.id}/same-person`, T.recA);
    check('R10 both applied to the SAME job: "different job" is refused (409), nothing changed', jsp.status === 409 && jsp.body.code === 'SAME_JOB' && !!(await prisma.candidate.findUnique({ where: { id: jNew.id } })), jsp.body);

    // R11 Reject duplicate
    const xOld = await mkCand('Reject Me', { phone: P() });
    const xNew = await mkCand('Reject Me dup', { name: xOld.name, phone: xOld.phone });
    const xApp = await mkApp(xNew, rEdu3, 'NEW', { source: 'Naukri' });
    await sleep(200);
    const xFlag = await flagOf(xOld.id, xNew.id);
    const rj = await call('POST', `/api/candidate-duplicates/flags/${xFlag.id}/reject`, T.recA, { reason: 'Same person' });
    const xEv = await prisma.applicationStageEvent.findFirst({ where: { applicationId: xApp.id, toStage: 'REJECTED' } });
    check('R11 Reject duplicate rejects the application with the reason "Duplicate"', rj.status === 200 && (await stageOf(xApp.id)) === 'REJECTED' && xEv && xEv.reasonCategory === 'Duplicate', [rj.body, xEv && xEv.reasonCategory]);
    check('R12 the flag is closed as REJECTED', (await DUP.getFlag(xFlag.id)).status === 'REJECTED');

    // R13 maker-checker: recruiter asks, still held; recruiter cannot merge; wrong TL 403; right TL approves
    const mOld = await mkCand('Merge Me', { phone: P(), email: `mm.${RUN}@example.test`, location: 'Vizag', currentCompany: 'Old Co', skills: 'java' });
    const mOldApp = await mkApp(mOld, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' });
    await prisma.candidateNote.create({ data: { candidateId: mOld.id, body: 'old note', authorName: 'ZZ' } });
    const mNew = await mkCand('Merge Me dup', { name: mOld.name, phone: mOld.phone, email: `mm2.${RUN}@example.test`, location: 'Vijayawada', currentCompany: 'New Co', skills: 'java, spring' });
    const mNewApp = await mkApp(mNew, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' }); // same job as mOld -> conflict, the more advanced is kept
    await prisma.candidateNote.create({ data: { candidateId: mNew.id, body: 'new note', authorName: 'ZZ' } });
    const mNewApp2 = await mkApp(mNew, rEdu2, 'NEW', { source: 'Naukri' });
    await sleep(250);
    const mFlag = await flagOf(mOld.id, mNew.id);
    const pv = await call('GET', `/api/candidate-duplicates/flags/${mFlag.id}/preview`, T.recA);
    check('R13 preview: field by field, with what moves', pv.status === 200 && pv.body.fields.some((f) => f.field === 'location' && f.differs) && pv.body.plan.counts.applications === 1 && pv.body.plan.counts.conflicts === 1, pv.body && pv.body.plan);
    const rm0 = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.recA, { confirm: true });
    check('R14 a recruiter cannot merge (403) — only ask', rm0.status === 403, rm0.body);
    const req = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/request-merge`, T.recA, { masterId: mOld.id, fieldChoices: { location: 'donor', currentCompany: 'donor' }, note: 'same person' });
    check('R15 the recruiter asks for a merge', req.status === 200 && req.body.status === 'MERGE_REQUESTED', req.body);
    const hm = await move(T.recA, mNewApp2.id, 'RECRUITER_REVIEW');
    const hm2 = await prisma.application.update({ where: { id: mNewApp2.id }, data: { stage: 'RECRUITER_REVIEW' } });
    const hm3 = await move(T.recA, mNewApp2.id, 'TL_REVIEW');
    check('R16 while the merge waits for the TL, the person is still held', hm3.status === 409 && /already asked for|merge was already/.test(hm3.body.error), hm3.body);
    const wrong = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.tlB, { confirm: true });
    check('R17 a TL of ANOTHER team cannot approve (403)', wrong.status === 403, wrong.body);
    const bdeTry = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.bdeTl, { confirm: true });
    check('R18 the BDE TL cannot (403)', bdeTry.status === 403, bdeTry.body);
    const mgrTry = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.mgr, { confirm: true });
    check('R19 a Manager (view only) cannot (403)', mgrTry.status === 403, mgrTry.body);
    const noConfirm = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.tlA, {});
    check('R20 a merge needs the confirm (400)', noConfirm.status === 400, noConfirm.body);
    const notesBefore = await prisma.candidateNote.count({ where: { candidateId: { in: [mOld.id, mNew.id] } } });
    const appr = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.tlA, { confirm: true });
    check('R21 the TL of the team approves and merges (the recruiter\'s choices are used)', appr.status === 200 && appr.body.status === 'MERGED' && appr.body.masterId === mOld.id, appr.body);
    const mAfter = await prisma.candidate.findUnique({ where: { id: mOld.id } });
    check('R22 kept profile: the recruiter\'s chosen values (location, company) were applied', mAfter.location === 'Vijayawada' && mAfter.currentCompany === 'New Co', [mAfter.location, mAfter.currentCompany]);
    const appsM = await prisma.application.findMany({ where: { candidateId: mOld.id } });
    check('R23 applications: the same-job pair folded to one (more advanced kept), the other job moved', appsM.length === 2 && appsM.some((a) => a.requirementId === rEdu2.id), appsM.map((a) => a.stage));
    check('R24 notes of both profiles are on the kept one (+ the merge notes)', (await prisma.candidateNote.count({ where: { candidateId: mOld.id } })) >= 2 && !(await prisma.candidate.findUnique({ where: { id: mNew.id } })));
    const log = (await DUP.q('SELECT * FROM CandidateMergeLog WHERE id = ?', appr.body.mergeLogId))[0];
    check('R25 the merge is logged with an undo window', !!log && log.status === 'DONE' && DUP.ms(log.undoUntil) > Date.now() + 5 * 86400000, log && log.undoUntil);
    check('R26 audit rows exist for the request and the merge', (await prisma.auditLog.count({ where: { action: { startsWith: 'Duplicate: ' }, userId: { in: [uRecA.id, uTlA.id] } } })) >= 2);
    const notified = await prisma.notification.count({ where: { userId: uRecA.id, title: 'Merge approved' } });
    check('R27 the recruiter who asked is told it was approved', notified >= 1, notified);
    // undo
    const mgrUndo = await call('POST', `/api/candidate-duplicates/merges/${appr.body.mergeLogId}/undo`, T.recB);
    check('R28 someone else cannot undo (403)', mgrUndo.status === 403, mgrUndo.body);
    const und = await call('POST', `/api/candidate-duplicates/merges/${appr.body.mergeLogId}/undo`, T.tlA);
    check('R29 the TL undoes the merge', und.status === 200 && und.body.ok, und.body);
    const backNew = await prisma.candidate.findUnique({ where: { id: mNew.id } });
    const backApps = await prisma.application.findMany({ where: { candidateId: mNew.id } });
    const oldApps = await prisma.application.findMany({ where: { candidateId: mOld.id } });
    check('R30 undo: the merged profile is back with its fields and BOTH its applications; the kept profile is as before',
      !!backNew && backNew.location === 'Vijayawada' && backApps.length === 2 && oldApps.length === 1 && oldApps[0].id === mOldApp.id && (await prisma.candidate.findUnique({ where: { id: mOld.id } })).location === 'Vizag',
      [backNew && backNew.location, backApps.length, oldApps.length]);
    check('R31 undo: the new application ids are the same ones (history re-pointed), notes back where they were',
      backApps.some((a) => a.id === mNewApp.id) && (await prisma.candidateNote.count({ where: { candidateId: mNew.id, body: 'new note' } })) === 1 && (await prisma.candidateNote.count({ where: { candidateId: mOld.id, body: 'old note' } })) === 1);
    check('R32 undo: the alias is removed and the flag is open again', !(await DUP.resolveAlias(mNew.id)) && ['OPEN'].includes((await DUP.getFlag(mFlag.id)).status), (await DUP.getFlag(mFlag.id)).status);
    const und2 = await call('POST', `/api/candidate-duplicates/merges/${appr.body.mergeLogId}/undo`, T.tlA);
    check('R33 undo twice is refused (409)', und2.status === 409, und2.body);
    // decline + undo window
    const dReq = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/request-merge`, T.recA, { note: 'again' });
    const dDec = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/decline`, T.tlA, { note: 'not the same person' });
    check('R34 the TL can send a request back with a reason; it is open again', dReq.status === 200 && dDec.status === 200 && (await DUP.getFlag(mFlag.id)).status === 'OPEN', [dReq.status, dDec.status]);
    const m2flag = await call('POST', `/api/candidate-duplicates/flags/${mFlag.id}/merge`, T.admin, { confirm: true, masterId: mNew.id });
    check('R35 an Admin merges directly, choosing the NEWER profile as the one to keep', m2flag.status === 200 && m2flag.body.masterId === mNew.id && !!(await DUP.resolveAlias(mOld.id)), m2flag.body);
    await prisma.$executeRawUnsafe('UPDATE CandidateMergeLog SET undoUntil = ? WHERE id = ?', Date.now() - 1000, m2flag.body.mergeLogId);
    const late = await call('POST', `/api/candidate-duplicates/merges/${m2flag.body.mergeLogId}/undo`, T.admin);
    check('R36 after the undo window the merge cannot be undone (409)', late.status === 409, late.body);
    // legacy admin merge route still works and logs
    const lOld = await mkCand('Legacy', { phone: P() }); const lNew = await mkCand('Legacy dup', { name: lOld.name, phone: lOld.phone });
    await sleep(150);
    const legacy = await call('POST', '/api/candidates/duplicates/merge', T.admin, { masterId: lOld.id, donorIds: [lNew.id], confirm: true });
    check('R37 the older Admin merge route still works (same engine)', legacy.status === 200 && legacy.body.mergeLogId, legacy.body);

    // ============================== W: worklist ==============================
    const wl = await call('GET', '/api/candidate-duplicates/worklist?tab=must', T.admin);
    check('W1 the worklist opens for an Admin', wl.status === 200 && wl.body.supported && Array.isArray(wl.body.rows), wl.status);
    const open = await DUP.q("SELECT * FROM CandidateDupFlag WHERE status IN ('OPEN','MERGE_REQUESTED')");
    const alive = new Set((await DUP.q("SELECT id FROM Candidate WHERE id IN (SELECT candidateId FROM CandidateDupFlag WHERE status IN ('OPEN','MERGE_REQUESTED') UNION SELECT matchCandidateId FROM CandidateDupFlag WHERE status IN ('OPEN','MERGE_REQUESTED'))")).map((r) => r.id));
    // flags whose profiles other tests deleted behind our back are not shown (and are swept on the next delete)
    const flagsOut = open.map(DUP.flagOut).filter((f) => alive.has(f.candidateId) && alive.has(f.matchCandidateId));
    const firstStepIds = new Set((await prisma.application.findMany({ where: { stage: { in: DUP.FIRST_STAGES } }, select: { candidateId: true } })).map((a) => a.candidateId));
    const withApps = new Set((await prisma.application.findMany({ select: { candidateId: true } })).map((a) => a.candidateId));
    const inFirst = (f) => firstStepIds.has(f.candidateId) || !withApps.has(f.candidateId);
    const expMust = flagsOut.filter((f) => f.status === 'OPEN' && DUP.BLOCKING_LEVELS.includes(f.level) && inFirst(f)).length;
    const expMaybe = flagsOut.filter((f) => f.status === 'OPEN' && f.level === 'POSSIBLE').length;
    const expOlder = flagsOut.filter((f) => f.status === 'OPEN' && DUP.BLOCKING_LEVELS.includes(f.level) && !inFirst(f)).length;
    const expReq = flagsOut.filter((f) => f.status === 'MERGE_REQUESTED').length;
    check('W2 tab counts equal the database (Must sort out / Maybe / Older / Waiting for TL)', wl.body.counts.must === expMust && wl.body.counts.maybe === expMaybe && wl.body.counts.older === expOlder && wl.body.counts.requests === expReq,
      [wl.body.counts, { expMust, expMaybe, expOlder, expReq }]);
    check('W3 each row has both profiles, what matched, and the buttons the viewer may use', wl.body.rows.length > 0 && wl.body.rows.every((r) => r.flag && r.newer && r.existing && Array.isArray(r.matchedOn) && r.caps), wl.body.rows[0]);
    check('W4 facets carry counts and every option has results', wl.body.facets.level.every((o) => o.count > 0) && wl.body.facets.department.every((o) => o.count > 0));
    const lvl = await call('GET', '/api/candidate-duplicates/worklist?tab=must&level=LIKELY', T.admin);
    check('W5 filtering by level narrows rows and facets (cascading)', lvl.body.rows.every((r) => r.flag.level === 'LIKELY') && lvl.body.total <= wl.body.total, [lvl.body.total, wl.body.total]);
    const st = await call('GET', '/api/candidate-duplicates/status', T.admin);
    check('W6 the header badge counts what waits at the first step', st.status === 200 && st.body.waiting === expMust && st.body.show === true, [st.body, expMust]);
    const recWl = await call('GET', '/api/candidate-duplicates/worklist?tab=must', T.recA);
    check('W7 a recruiter sees only duplicates among profiles in their area', recWl.status === 200 && recWl.body.rows.every((r) => r.newer.inScope || r.existing.inScope), recWl.body.total);
    const auto = await call('GET', '/api/candidate-duplicates/auto-merge', T.tlA);
    check('W8 auto-merge proposals are a dry list (same phone + same name, different jobs) — nothing merged', auto.status === 200 && Array.isArray(auto.body.proposals) && auto.body.proposals.every((p) => p.keep && p.merge), auto.body);
    // bulk not-duplicate
    const b1 = await mkCand('Bulk 1', { phone: P() }); const b1d = await mkCand('Bulk 1 dup', { name: b1.name, phone: b1.phone });
    const b2 = await mkCand('Bulk 2', { phone: P() }); const b2d = await mkCand('Bulk 2 dup', { name: b2.name, phone: b2.phone });
    await mkApp(b1d, rEdu1, 'NEW', { source: 'Naukri' }); await mkApp(b2d, rEdu2, 'NEW', { source: 'Naukri' });
    await sleep(250);
    const bf = [await flagOf(b1.id, b1d.id), await flagOf(b2.id, b2d.id)];
    const bn = await call('POST', '/api/candidate-duplicates/bulk', T.recA, { action: 'not-duplicate', flagIds: bf.map((f) => f.id), reason: '' });
    const bn2 = await call('POST', '/api/candidate-duplicates/bulk', T.recA, { action: 'not-duplicate', flagIds: bf.map((f) => f.id), reason: 'Different people' });
    check('W9 bulk "Not duplicates": needs one reason, then applies to all selected', bn.status === 400 && bn2.status === 200 && bn2.body.done === 2, [bn.status, bn2.body]);
    const bm = await call('POST', '/api/candidate-duplicates/bulk', T.recA, { action: 'merge', flagIds: [bf[0].id] });
    check('W10 bulk merge by a recruiter is refused row by row', bm.status === 200 && bm.body.failed === 1, bm.body);
    const ar = await call('POST', '/api/candidate-duplicates/auto-merge/approve', T.recA, { flagIds: ['x'] });
    check('W11 a recruiter cannot approve auto-merge proposals', ar.status === 403, ar.body);

    // ============================== P: privacy ==============================
    // a flagged pair in Education, seen by BDE/BDE TL/Manager/recB
    const privPhone = P();
    const pvOld = await mkCand('Privacy Person', { phone: privPhone, email: `priv.${RUN}@example.test` });
    await mkApp(pvOld, rEdu1, 'SHARED_WITH_CLIENT', { source: 'Naukri' });
    const pvNew = await mkCand('Privacy Person dup', { name: pvOld.name, phone: privPhone, email: `priv2.${RUN}@example.test` });
    await mkApp(pvNew, rEdu2, 'SHARED_WITH_CLIENT', { source: 'Naukri' });
    await sleep(250);
    const panelBde = await call('GET', `/api/candidate-duplicates/candidate/${pvNew.id}`, T.bde);
    check('P1 BDE: panel shows what matched but not a single phone / e-mail value', panelBde.status === 200 && panelBde.body.items.length > 0 && !panelBde.text.includes(privPhone) && !panelBde.text.includes('priv.') && !panelBde.text.includes('priv2.') && panelBde.body.items[0].matchedOn.every((m) => m.value === undefined), panelBde.text.slice(0, 300));
    check('P2 BDE cannot resolve anything', panelBde.body.items.every((i) => !i.caps.canResolve && !i.caps.canMerge));
    const wlBde = await call('GET', '/api/candidate-duplicates/worklist', T.bde);
    check('P3 BDE / BDE TL: the worklist is not for them (403)', wlBde.status === 403 && (await call('GET', '/api/candidate-duplicates/worklist', T.bdeTl)).status === 403, wlBde.status);
    const panelBdeTl = await call('GET', `/api/candidate-duplicates/candidate/${pvNew.id}`, T.bdeTl);
    check('P4 BDE TL: no values either', (panelBdeTl.status === 200 || panelBdeTl.status === 403) && !panelBdeTl.text.includes(privPhone), panelBdeTl.status);
    const panelRec = await call('GET', `/api/candidate-duplicates/candidate/${pvNew.id}`, T.recA);
    check('P5 the recruiter of the team sees the full match details', panelRec.status === 200 && panelRec.text.includes(privPhone), panelRec.status);
    const panelOther = await call('GET', `/api/candidate-duplicates/candidate/${pvNew.id}`, T.recB);
    check('P6 a recruiter of ANOTHER team cannot open the panel (403) and learns no value', panelOther.status === 403 && !panelOther.text.includes(privPhone));
    // cross-team: a Medical profile with the same phone as an Education profile
    const xtOld = await mkCand('Cross Team', { phone: P() });
    await mkApp(xtOld, rMed, 'RECRUITER_REVIEW', { source: 'Naukri' });
    await sleep(3500); // a burst of creates (an import) is silent by design: let it pass so this one rings the bells
    const xtNew = await mkCand('Cross Team dup', { name: xtOld.name, phone: xtOld.phone });
    const xtApp = await mkApp(xtNew, rEdu1, 'NEW', { source: 'Naukri' });
    await sleep(300);
    const xtPanel = await call('GET', `/api/candidate-duplicates/candidate/${xtNew.id}`, T.recA);
    const it = xtPanel.body && xtPanel.body.items && xtPanel.body.items[0];
    check('P7 cross-team: the Education recruiter sees only "a profile exists with the same phone (owner: …)" for the Medical profile — no name, phone, e-mail',
      xtPanel.status === 200 && it && it.existing.inScope === false && /same phone/.test(it.existing.text) && it.existing.name === null && !JSON.stringify(it.existing).includes(xtOld.phone) && !JSON.stringify(it.existing).includes(xtOld.name), it && it.existing);
    const xtNotes = await prisma.notification.count({ where: { userId: { in: [uRecB.id, uTlB.id] }, title: { startsWith: 'Duplicate profile' } } });
    check('P8 cross-team: the owner of the other profile and their TL are told', xtNotes >= 1, xtNotes);
    const mgrWl = await call('GET', '/api/candidate-duplicates/worklist?tab=must', T.mgr);
    check('P9 a Manager may look (read only) and has no buttons', mgrWl.status === 200 && mgrWl.body.rows.every((r) => !r.caps.canResolve && !r.caps.canMerge));
    const scanKeys = /("phone"|"email")\s*:\s*"[^"]+"/;
    check('P10 the BDE payload carries no phone / email fields with values at all', !scanKeys.test(panelBde.text), panelBde.text.match(scanKeys));
    // the list chip (rows carry dup)
    const lst = await call('GET', '/api/candidates?paged=1&view=pipeline&sub=all&pageSize=100&search=Privacy', T.recA);
    const lstDup = await call('GET', `/api/candidates?paged=1&view=master&sub=all&pageSize=100&search=${encodeURIComponent(xtOld.name)}`, T.recA);
    check('P11 the people list carries the duplicate chip (dup.level) on a flagged row', lstDup.status === 200 && (lstDup.body.rows || []).some((r) => r.dup && r.dup.level === 'CERTAIN'), lstDup.body && (lstDup.body.rows || []).slice(0, 2));
    const detail = await call('GET', `/api/candidates/${xtNew.id}`, T.recA);
    check('P12 the candidate page carries dup too (and nothing for a BDE)', detail.status === 200 && detail.body.dup && detail.body.dup.level === 'CERTAIN' && !((await call('GET', `/api/candidates/${pvNew.id}`, T.bde)).body || {}).dup, detail.body && detail.body.dup);

    // ============================== J: Job Portal <-> ATS ==============================
    const jpOld = await mkCand('Portal Existing', { phone: P(), email: `jp.${RUN}@example.test`, source: 'Naukri' });
    await mkApp(jpOld, rEdu1, 'RECRUITER_REVIEW', { source: 'Naukri' });
    const jpNew = await mkCand('Portal Existing dup', { name: jpOld.name, phone: jpOld.phone, source: 'Job Portal' });
    const jpApp = await mkApp(jpNew, rEdu2, 'NEW', { source: 'TeamLink Job Portal' });
    await sleep(250);
    const jpDup = await call('POST', `/api/job-portal/applications/${jpApp.id}/duplicate-check`, T.recA);
    check('J1 the Job Portal "Duplicate check" uses the same rules: the existing profile is listed as the same person (phone)',
      jpDup.status === 200 && jpDup.body.duplicates && jpDup.body.duplicates.strong.some((d) => d.id === jpOld.id && d.reasons.join().includes('phone')), jpDup.body && jpDup.body.duplicates);
    const jpList = await call('GET', '/api/job-portal/applications', T.recA);
    const jpRow = jpList.body && (jpList.body.applications || []).find((a) => a.id === jpApp.id);
    check('J2 the portal list row carries the red chip data (dup.level CERTAIN, holds)', !!jpRow && jpRow.dup && jpRow.dup.level === 'CERTAIN' && jpRow.dup.holds === true, jpRow && jpRow.dup);
    const gateJ = await DUP.gateCheck({ id: jpApp.id, candidateId: jpNew.id, stage: 'RECRUITER_REVIEW', candidate: { name: jpNew.name } }, 'TL_REVIEW');
    check('J3 "Send to ATS" is held by the same gate (409 DUPLICATE_OPEN)', gateJ && gateJ.status === 409 && gateJ.body.code === 'DUPLICATE_OPEN', gateJ);
    await DUP.noteAlreadyInAts({ candidate: jpOld, email: null, phone: jpOld.phone, portalApplicationId: 'pa-test' });
    const jpList2 = await call('GET', '/api/job-portal/applications', T.recA);
    const panelJ = await call('GET', `/api/candidate-duplicates/candidate/${jpOld.id}`, T.recA);
    check('J4 an applicant who was already in the ATS says "Already in ATS (matched by phone)" on the panel', panelJ.status === 200 && panelJ.body.portal && /matched by phone/.test(panelJ.body.portal.text), panelJ.body && panelJ.body.portal);
    const jpMerge = await call('POST', `/api/candidate-duplicates/flags/${(await flagOf(jpOld.id, jpNew.id)).id}/same-person`, T.recA);
    check('J5 merge-or-skip at the gate: "Same person, different job" adds the portal application to the existing ATS profile', jpMerge.status === 200 && (await prisma.application.findUnique({ where: { id: jpApp.id } })).candidateId === jpOld.id, jpMerge.body);
    const ping = await call('GET', '/api/candidate-duplicates/status', T.recA);
    check('J6 the badge endpoint answers for a recruiter and not for a BDE', ping.status === 200 && ping.body.show === true && (await call('GET', '/api/candidate-duplicates/status', T.bde)).body.show === false, ping.body);

    // ============================== X: performance on the full copy ==============================
    const total = (await DUP.q('SELECT COUNT(*) n FROM Candidate'))[0].n;
    const perfs = [];
    for (let i = 0; i < 10; i += 1) {
      const t0 = Date.now();
      const c = await mkCand(`Perf ${i}`, { phone: P(), email: `perf.${i}.${RUN}@example.test`, location: 'Hyderabad' });
      perfs.push(Date.now() - t0);
      // detection alone
      const t1 = Date.now(); await DUP.reindex(c.id, { door: 'Perf', quiet: true }); perfs.push(-(Date.now() - t1));
    }
    const detectMs = perfs.filter((x) => x < 0).map((x) => -x);
    const maxDetect = Math.max(...detectMs); const avgDetect = Math.round(detectMs.reduce((a, b) => a + b, 0) / detectMs.length);
    const medDetect = detectMs.slice().sort((x, y) => x - y)[Math.floor(detectMs.length / 2)];
    check(`X1 detection per candidate on a ${total}-row copy (machine shared with other agents): median ${medDetect} ms, avg ${avgDetect} ms, max ${maxDetect} ms (average < 100)`, avgDetect < 100 && medDetect < 100, detectMs);
    const tw0 = Date.now(); const w1 = await call('GET', '/api/candidate-duplicates/worklist?tab=must', T.admin);
    const first = Date.now() - tw0;
    const tw2 = Date.now(); await call('GET', '/api/candidate-duplicates/worklist?tab=must&level=CERTAIN', T.tlA);
    check(`X2 worklist first load over HTTP on the busy shared machine ${first} ms (< 6000; in-process cold ~1 s, warm ~0.1 s), a TL's ${Date.now() - tw2} ms`, w1.status === 200 && first < 6000 && Date.now() - tw2 < 6000);
    const tw3 = Date.now(); const move0 = await move(T.recA, ctlApp.id, 'WITH_BDE'); const gateMs = Date.now() - tw3;
    check(`X3 a stage move with the gate in place: ${gateMs} ms`, gateMs < 1500, move0.status);
  } catch (err) {
    fail += 1;
    console.log('FAIL  test run crashed:', err && err.stack ? err.stack : err);
  } finally {
    // ============================== cleanup ==============================
    try {
      const cands = [...made.cands];
      // everything created for a ZZTEST DUP profile (also profiles the app made, e.g. via Add)
      const byName = await prisma.candidate.findMany({ where: { name: { contains: `ZZTEST DUP` } }, select: { id: true } });
      byName.forEach((c) => cands.push(c.id));
      const ids = [...new Set(cands)];
      const apps = (await prisma.application.findMany({ where: { OR: [{ candidateId: { in: ids } }, { requirementId: { in: made.reqs } }] }, select: { id: true } })).map((a) => a.id);
      const all = [...ids, ...apps, ...made.reqs, ...made.clients, ...made.users];
      const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
      for (const part of chunk(ids, 400)) {
        const inC = { in: part };
        await prisma.applicationStageEvent.deleteMany({ where: { candidateId: inC } });
        await prisma.applicationFollowUp.deleteMany({ where: { candidateId: inC } });
        await prisma.candidateNote.deleteMany({ where: { candidateId: inC } });
        await prisma.candidateMessage.deleteMany({ where: { candidateId: inC } });
        await prisma.candidateDocument.deleteMany({ where: { candidateId: inC } });
        await prisma.candidateResume.deleteMany({ where: { candidateId: inC } });
        const ph = part.map(() => '?').join(',');
        await prisma.$executeRawUnsafe(`DELETE FROM CandidateDupKey WHERE candidateId IN (${ph})`, ...part);
        await prisma.$executeRawUnsafe(`DELETE FROM CandidateDupSig WHERE candidateId IN (${ph})`, ...part);
        await prisma.$executeRawUnsafe(`DELETE FROM CandidateDupFlag WHERE candidateId IN (${ph}) OR matchCandidateId IN (${ph})`, ...part, ...part);
        await prisma.$executeRawUnsafe(`DELETE FROM CandidateAlias WHERE oldId IN (${ph}) OR candidateId IN (${ph})`, ...part, ...part);
        await prisma.$executeRawUnsafe(`DELETE FROM CandidateMergeLog WHERE masterId IN (${ph})`, ...part);
      }
      for (const part of chunk(apps, 400)) {
        await prisma.interviewEvent.deleteMany({ where: { applicationId: { in: part } } });
        await prisma.interviewFeedback.deleteMany({ where: { applicationId: { in: part } } });
        await prisma.applicationFollowUp.deleteMany({ where: { applicationId: { in: part } } });
        await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: part } } });
      }
      await prisma.application.deleteMany({ where: { id: { in: apps } } });
      await prisma.candidate.deleteMany({ where: { id: { in: ids } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: all } }, { fromValue: { contains: 'ZZTEST DUP' } }] } });
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: 'ZZTEST DUP' } }, { message: { contains: 'ZZTEST DUP' } }] } });
      await prisma.syncLog.deleteMany({ where: { recordRef: { in: ids } } }).catch(() => null);
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      await prisma.$executeRawUnsafe("DELETE FROM AppSetting WHERE key = 'candidate-duplicates'");
      const left = await prisma.candidate.count({ where: { name: { contains: 'ZZTEST DUP' } } });
      const leftU = await prisma.user.count({ where: { email: { contains: `zz-dup-` } } });
      console.log(`cleanup: ${ids.length} candidates, ${apps.length} applications removed; left candidates=${left} users=${leftU}`);
    } catch (e) { console.log('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

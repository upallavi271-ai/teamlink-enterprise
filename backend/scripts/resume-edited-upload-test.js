#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EDITED RESUME MADE OUTSIDE TEAMLINK + WHO SEES THE ORIGINAL (founder, 2026-10-22). SANDBOX ONLY.
//
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/resume-edited-upload-test.js
//
//   C  the contact check (unit): phone / e-mail found, years and amounts are not contact
//   U  upload-edited: a clean PDF is taken as "Edited resume vN"; a PDF with the phone or e-mail is refused in plain words; a clean Word file is taken
//      and gets a PDF too; an old .doc is refused with the "save as .docx" hint
//   V  who sees the ORIGINAL: Recruiter, TL, Admin see it; Manager and BDE get the edited resume only (the original file is 403)
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');

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
const docs = require(path.join(BACK, 'src/utils/resumeDocs'));
const CC = require(path.join(BACK, 'src/utils/resumeContactCheck'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
}
async function call(method, p, token, body, form) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, body: json, bytes: buf };
}
const formOf = (name, buf, type) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); return fd; };

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  try {
    // ============================ C: the contact check ============================
    const none = CC.findContact('Staff Nurse, 6 years. Worked 2018-2023. Salary 4,50,000. Marks 87.5%. Batch 2019 2023.', { phone: '9876543210', email: 'a@b.com' });
    check('C1 a resume with no contact is clean', CC.isClean(none), none);
    check('C2 a mobile number is found', CC.findContact('Phone: 98765 43210').phones.length === 1 && CC.findContact('Call +91 9876543210').phones.length === 1 && CC.findContact('mob 09876543210').phones.length === 1);
    check('C3 an e-mail is found, and it is shown only in part', (() => { const f = CC.findContact('write to ravi.kumar@gmail.com'); return f.emails.length === 1 && !/ravi.kumar/.test(f.emails[0]); })());
    check('C4 the candidate\'s own number is found even when written oddly', CC.findContact('Contact: 9 8 7 6 5 4 3 2 1 0', { phone: '9876543210' }).phones.length === 1);
    check('C5 a 10-digit number starting 1-5 (not a mobile) and amounts are not contact', CC.isClean(CC.findContact('Ref 1234567890 Fee 25,00,000 PIN 500001')));

    // ============================ fixtures ============================
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST RE ${tag} ${RUN}`, email: `zz-re-${tag}-${RUN}@example.test`, username: `zz-re-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-RE-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsAccess: true, hrmsRole: 'MANAGER' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const client = await prisma.client.create({ data: { name: `ZZTEST RE Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client', agreementStatus: 'ACTIVE' } });
    made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `ZZTEST RE Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, bdeId: uBde.id, tlId: uTl.id, openings: 1, location: 'ZZ Town', skills: 'zzskill' } });
    made.reqs.push(req.id);
    const PHONE = '9000012345';
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST RE Cand ${RUN}`, email: `zz-re-cand-${RUN}@example.test`, phone: PHONE, skills: 'zzskill', location: 'ZZ Town', experienceYears: 3 } });
    made.cands.push(cand.id);
    const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'RECRUITER_REVIEW' } });
    made.apps.push(app.id);
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = { admin: await mint(uAdmin), mgr: await mint(uMgr), bde: await mint(uBde), rec: await mint(uRec), tl: await mint(uTl) };
    const P = `/api/candidate-resumes/${cand.id}`;

    // the ORIGINAL: a resume with the contact in it, uploaded by the recruiter
    const origPdf = await docs.buildPdf({ name: 'Original', sections: { headline: 'Staff Nurse', summary: `Contact ${PHONE} nurse@example.test`, skills: 'Nursing, ICU', experience: 'Five years at a hospital in ZZ Town.', education: 'B.Sc Nursing', other: '' }, versionLabel: 'Original' });
    // buildPdf strips contact for clients; the "original" here only needs to be a valid PDF
    let r = await call('POST', `${P}/upload`, T.rec, undefined, formOf('orig.pdf', origPdf, 'application/pdf'));
    check('V0 the recruiter uploads the original', r.status === 201, [r.status, r.body]);
    const origId = r.body && r.body.resume && r.body.resume.id;

    // ============================ U: upload-edited ============================
    const cleanPdf = await docs.buildPdf({ name: 'Edited', sections: { headline: 'Staff Nurse', summary: 'Experienced ICU nurse.', skills: 'Nursing, ICU, Ventilator care', experience: 'Five years at a hospital in ZZ Town.', education: 'B.Sc Nursing', other: '' }, versionLabel: 'Edited' });
    r = await call('POST', `${P}/upload-edited`, T.rec, undefined, formOf('edited.pdf', cleanPdf, 'application/pdf'));
    check('U1 a PDF without phone / e-mail is taken as Edited resume v1', r.status === 201 && r.body.resume && r.body.resume.kind === 'EDITED' && r.body.resume.label === 'Edited resume v1' && r.body.resume.hasPdf === true, [r.status, r.body]);
    const ed1 = r.body && r.body.resume && r.body.resume.id;

    // a PDF that still shows the phone number: build with raw pdfkit so the number really is in the file
    const PDFDocument = require(path.join(BACK, 'node_modules/pdfkit'));
    const rawPdf = (lines) => new Promise((resolve) => { const d = new PDFDocument(); const bufs = []; d.on('data', (b) => bufs.push(b)); d.on('end', () => resolve(Buffer.concat(bufs))); lines.forEach((l) => d.text(l)); d.end(); });
    const dirtyPhone = await rawPdf(['Staff Nurse', `Mobile: ${PHONE}`, 'Skills: Nursing, ICU']);
    r = await call('POST', `${P}/upload-edited`, T.rec, undefined, formOf('dirty.pdf', dirtyPhone, 'application/pdf'));
    check('U2 a PDF that still shows the phone number is refused (422) in plain words, number not repeated', r.status === 422 && /phone number/.test(r.body.error || '') && !(r.body.error || '').includes(PHONE) && !JSON.stringify(r.body).includes(PHONE), [r.status, r.body]);
    const dirtyMail = await rawPdf(['Staff Nurse', 'ravi.nurse@gmail.com', 'Skills: Nursing, ICU']);
    r = await call('POST', `${P}/upload-edited`, T.rec, undefined, formOf('dirty2.pdf', dirtyMail, 'application/pdf'));
    check('U3 a PDF with an e-mail address is refused (422)', r.status === 422 && /e-mail/.test(r.body.error || ''), [r.status, r.body]);
    const after = await call('GET', P, T.rec);
    check('U4 the refused files were not saved: still one edited version', after.body.edited.length === 1, after.body.edited.length);

    const cleanDocx = await docs.buildDocx({ name: 'Edited', sections: { headline: 'Staff Nurse', summary: 'Experienced ICU nurse in ZZ Town.', skills: 'Nursing, ICU', experience: 'Five years at a hospital.', education: 'B.Sc Nursing', other: '' }, versionLabel: 'Edited' });
    r = await call('POST', `${P}/upload-edited`, T.tl, undefined, formOf('edited.docx', cleanDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    check('U5 a clean Word file is taken (by a TL too) as Edited resume v2, with a PDF for viewing AND the Word file kept', r.status === 201 && r.body.resume.label === 'Edited resume v2' && r.body.resume.hasPdf === true && r.body.resume.hasDocx === true, [r.status, r.body]);
    const docHead = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    r = await call('POST', `${P}/upload-edited`, T.rec, undefined, formOf('old.doc', docHead, 'application/msword'));
    check('U6 an old .doc is refused with the "save as .docx" hint', r.status === 400 && /docx/i.test(r.body.error || ''), [r.status, r.body]);
    r = await call('POST', `${P}/upload-edited`, T.rec, undefined, formOf('x.pdf', Buffer.from('not a pdf at all'), 'application/pdf'));
    check('U7 a file that is not really a PDF is refused', r.status === 400, [r.status, r.body]);
    r = await call('POST', `${P}/upload-edited`, T.mgr, undefined, formOf('edited.pdf', cleanPdf, 'application/pdf'));
    check('U8 a Manager cannot upload an edited resume', r.status === 403, r.status);

    // ============================ V: who sees the original ============================
    for (const who of ['rec', 'tl', 'admin']) {
      const l = await call('GET', P, T[who]);
      const f = await call('GET', `${P}/file/${origId}?download=1`, T[who]);
      check(`V1 ${who}: sees the original in the list and can open the original file`, l.status === 200 && l.body.originals.length === 1 && f.status === 200, [l.status, l.body && l.body.originals && l.body.originals.length, f.status]);
    }
    const lb = await call('GET', P, T.bde);
    check('V5 a BDE (not on this candidate) gets nothing at all (403)', lb.status === 403 && (await call('GET', `${P}/file/${origId}`, T.bde)).status === 403, lb.status);
    for (const who of ['mgr']) {
      const l = await call('GET', P, T[who]);
      const f = await call('GET', `${P}/file/${origId}?download=1`, T[who]);
      const v = await call('GET', `${P}/version/${origId}`, T[who]);
      const e = await call('GET', `${P}/file/${ed1}`, T[who]);
      const latest = await call('GET', P, T.rec);
      const latestEdited = latest.body.edited[0].id;
      const e2 = await call('GET', `${P}/file/${latestEdited}`, T[who]);
      check(`V2 ${who}: no original in the list, the original file is 403, its text is 403`, l.status === 200 && l.body.originals.length === 0 && f.status === 403 && v.status === 403, [l.status, l.body && l.body.originals && l.body.originals.length, f.status, v.status]);
      check(`V3 ${who}: sees the LATEST edited resume only (older edited 403, latest 200 PDF)`, l.body.edited.length === 1 && l.body.edited[0].id === latestEdited && e.status === 403 && e2.status === 200, [l.body.edited.length, e.status, e2.status]);
      check(`V4 ${who}: no phone / e-mail / parsed contact anywhere in what they are sent`, !JSON.stringify(l.body).includes(PHONE) && !JSON.stringify(l.body).includes('nurse@example.test'), l.body);
    }
  } finally {
    try {
      const candIds = made.cands; const appIds = made.apps;
      await prisma.candidateResume.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
      await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { entityId: { in: candIds } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: candIds } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch (e) { console.log('cleanup problem:', e.message); }
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

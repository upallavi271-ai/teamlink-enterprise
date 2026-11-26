#!/usr/bin/env node
/**
 * HR LETTERS FOR ONE EMPLOYEE (utils/hrLetters.js + routes/hrLetters.js, 2026-11-26): appointment, experience, relieving, appraisal,
 * internship offer and completion. Runs on a THROW-AWAY COPY of a database with the current schema, with a FAKE mailer and file
 * store, so nothing is sent or written anywhere else:
 *   node scripts/hr-letters-send-test.js [database file, default prisma/sandbox.db] [folder to write sample PDFs]
 */
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hr-letters-send-')), 'copy.db');
fs.copyFileSync(path.resolve(process.argv[2] || path.join(BACK, 'prisma', 'sandbox.db')), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const SAMPLES = process.argv[3] || '';
const SRC = path.join(BACK, 'src');

const stub = (rel, exp) => { const p = require.resolve(path.join(SRC, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const sent = []; let mailResult = { ok: true };
stub('utils/mailer.js', { sendMail: async (m) => { sent.push(m); return mailResult; } });
const stored = [];
stub('utils/attachments.js', { store: ({ data, filename }) => { stored.push(filename); return { billFile: `mem/${stored.length}`, billName: filename, billMime: 'application/pdf', billSize: data.length }; }, remove: () => {}, safeDisplayName: (n) => String(n).replace(/["\r\n]/g, '') });
const audits = [];
stub('utils/audit.js', { logAudit: async (a) => { audits.push(a); } });
stub('utils/exitChecklist.js', { tick: async () => ({}) });
const users = {};
stub('middleware/auth.js', {
  requireAuth: (req, res, next) => { req.user = users[req.headers['x-user']]; if (!req.user) return res.status(401).end(); return next(); },
  can: async () => true,
});

const prisma = require(path.join(SRC, 'db'));
const HL = require(path.join(SRC, 'utils', 'hrLetters'));
const EL = require(path.join(SRC, 'utils', 'exitLetters'));
let passed = 0; const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };
const words = (m) => JSON.stringify({ ...m, sign: null, company: null });
const clean = (m) => { const w = words(m); for (const bad of [/undefined/, /NaN/, /\[●/, /\{\{/, /"[^"]*null[^"]*":?(?=[,\]}])/, /Ltd\.\./, /\[object /]) assert.ok(!bad.test(w), `the letter must not match ${bad}: ${w.slice(0, 900)}`); };

(async () => {
  const run = Date.now().toString(36);
  await prisma.appSetting.deleteMany({ where: { key: HL.SETTINGS_KEY } });
  if (!await prisma.company.findFirst()) await prisma.company.create({ data: { name: 'TeamLink Consultants', address: '606, 6th Floor, Manjeera Trinity Corporate, KPHB, Kukatpally, Hyderabad - 500072' } });
  const person = (code, data) => prisma.employee.create({ data: { employeeCode: `${code}-${run}`, city: 'Hyderabad', state: 'Telangana', postalCode: '500072', addressLine1: '12 Sample Street', branch: 'Hyderabad', employmentStatus: 'Active', employeeType: 'Full-time', ...data } });
  const boss = await person('B1', { name: 'Ravi Kumar', designation: 'Senior Team Leader', department: 'Recruitment' });
  const anu = await person('E1', { name: 'Anusha Reddy', designation: 'Recruiter', department: 'Recruitment', dateOfJoining: new Date('2025-04-07T00:00:00Z'), email: 'anusha@work.example', personalEmail: 'anusha@home.example', reportingManagerId: boss.id });
  const version = (employeeId, effectiveFrom, ctc, basic) => prisma.salaryStructureVersion.create({ data: { employeeId, effectiveFrom, ctc, basic, hra: basic * 0.4, specialAllowance: basic * 0.5, employerPf: 1800, gratuity: Math.round(basic * 0.048) } });
  await version(anu.id, '2025-04-01', 300000, 12000);
  await prisma.salaryStructure.create({ data: { employeeId: anu.id, ctc: 300000, basic: 12000 } });
  const intern = await person('I1', { name: 'Kiran Rao', designation: 'HR Intern', department: 'Human Resources', employeeType: 'Intern', dateOfJoining: new Date('2026-06-01T00:00:00Z'), personalEmail: 'kiran@home.example' });
  const leaver = await person('L1', { name: 'Sneha Varma', designation: 'Recruiter', department: 'Recruitment', dateOfJoining: new Date('2024-02-05T00:00:00Z'), employmentStatus: 'Relieved', personalEmail: 'sneha@home.example' });
  const rec = await prisma.employeeRecord.create({ data: { employeeId: leaver.id, type: 'RESIGNATION', title: 'Resignation', status: 'Relieved' } });
  await prisma.resignationDetail.create({ data: { recordId: rec.id, employeeId: leaver.id, resignationDate: '2026-09-30', approvedLastWorkingDate: '2026-10-30', reason: 'Other' } });
  const bare = await person('E2', { name: 'Imran Ali', designation: 'Recruiter', dateOfJoining: new Date('2026-11-23T00:00:00Z') });
  const zz = await person('Z1', { name: 'ZZ Test Person', designation: 'Recruiter', dateOfJoining: new Date('2026-11-02T00:00:00Z'), personalEmail: 'zz@home.example' });
  await version(zz.id, '2026-11-01', 240000, 10000);

  const samples = [];
  const make = async (emp, kind, fields) => { const out = await HL.pdfFor(emp.id, kind, fields); assert.ok(!out.error, `${kind}: ${out.error}`); assert.equal(out.pdf.subarray(0, 5).toString(), '%PDF-'); if (out.model) clean(out.model); samples.push([`${kind} - ${emp.name}.pdf`, out.pdf]); return out; };

  // 1. what the screen lists
  let list = await HL.listFor(anu.id); const of = (k) => list.letters.find((l) => l.key === k);
  assert.equal(list.letters.length, 6); assert.equal(list.sendOn, false, 'sending starts switched off');
  assert.equal(of('appointment').why, null); assert.equal(of('appraisal').why, null);
  assert.ok(/resignation or exit record/.test(of('experience').why) && /intern/i.test(of('internshipOffer').why));
  assert.equal(of('appointment').emailTo, 'anusha@home.example'); assert.equal(of('appraisal').emailTo, 'anusha@work.example');
  ok('the list: six letters, what each person can have and why not, sending off, the right address filled in');

  // 2. appointment
  let out = await make(anu, 'appointment', { acceptBy: '2025-04-10' }); let w = words(out.model);
  for (const t of ['Anusha Reddy', 'Appointment as Recruiter', '7 April 2025', 'Ravi Kumar, Senior Team Leader', '6 months from the date of joining', '15 days during probation / 1 month after confirmation', 'Rs. 3,00,000', '10 April 2025']) assert.ok(w.includes(t), `appointment: ${t}`);
  assert.ok(out.model.annexure.table.length >= 6 && out.model.accept === 'Anusha Reddy');
  assert.ok(/salary is not set/i.test((await HL.pdfFor(bare.id, 'appointment')).error));
  assert.ok(/intern/i.test((await HL.pdfFor(intern.id, 'appointment')).error));
  ok('appointment letter: name, designation, manager, joining date, probation, notice, pay and annexure from the record; refused without salary, for an intern');

  // 3. appraisal: never a pay Payroll does not hold
  assert.ok(/review period/.test((await HL.pdfFor(anu.id, 'appraisal')).error));
  assert.ok(/previous yearly CTC/.test((await HL.pdfFor(anu.id, 'appraisal', { reviewPeriod: 'FY 2025-26' })).error), 'one salary only: HR types the previous one');
  out = await make(anu, 'appraisal', { reviewPeriod: 'April 2025 to March 2026', previousCtc: '270000' }); assert.ok(words(out.model).includes('Rs. 2,70,000') && words(out.model).includes('Rs. 3,00,000'));
  await version(anu.id, '2026-11-01', 360000, 14400);
  out = await make(anu, 'appraisal', { reviewPeriod: 'April 2025 to October 2026', previousCtc: '1' }); w = words(out.model);
  assert.ok(w.includes('Rs. 3,00,000') && w.includes('Rs. 3,60,000') && !w.includes('"Rs. 1"') && w.includes('1 November 2026'), 'the earlier salary of Payroll wins over a typed one');
  assert.ok(/no salary in Payroll/.test((await HL.pdfFor(bare.id, 'appraisal', { reviewPeriod: 'x' })).error));
  ok('appraisal letter: previous and revised pay from Payroll versions, effective date, annexure; review period asked');

  // 4. internship
  assert.deepEqual([HL.endOfMonths('2026-12-01', 3), HL.endOfMonths('2026-06-15', 2), HL.endOfMonths('2026-01-31', 1), HL.endOfMonths('2026-11-30', 3)], ['2027-02-28', '2026-08-14', '2026-02-28', '2027-02-28']);
  assert.ok(/duration/i.test((await HL.pdfFor(intern.id, 'internshipOffer')).error));
  out = await make(intern, 'internshipOffer', { months: '3', stipend: '8000', noticeDays: '7' }); w = words(out.model);
  for (const t of ['Kiran Rao', 'HR Intern', '1 June 2026', 'ending on 31 August 2026', 'Rs. 8,000 per month', '7 days']) assert.ok(w.includes(t), `internship offer: ${t}`);
  assert.ok(words((await HL.pdfFor(intern.id, 'internshipOffer', { months: 2, stipend: 0, noticeDays: 0 })).model).includes('Unpaid'));
  assert.ok(/after the internship ends/.test((await HL.pdfFor(intern.id, 'internshipCertificate', { endDate: '2027-01-01' })).error));
  assert.ok(/before the start/.test((await HL.pdfFor(intern.id, 'internshipCertificate', { endDate: '2026-05-01' })).error));
  assert.ok(/end date/i.test((await HL.pdfFor(intern.id, 'internshipCertificate', { endDate: '2026-02-30' })).error), 'a date that does not exist is refused');
  out = await make(intern, 'internshipCertificate', { endDate: '2026-08-31', summary: 'During the internship, Kiran worked on candidate screening and interview coordination.' }); assert.ok(words(out.model).includes('31 August 2026'));
  ok('internship offer and completion certificate: end date worked out, unpaid shown, not before the internship ends, impossible dates refused');

  // 5. the exit letters TeamLink already has
  await make(leaver, 'experience'); await make(leaver, 'relieving');
  assert.ok(/resignation or exit record/.test((await HL.pdfFor(anu.id, 'relieving')).error));
  const exit = await EL.pdfFor(await prisma.employeeRecord.findUnique({ where: { id: rec.id }, include: { employee: true } }), 'service'); assert.ok(exit.pdf, 'the old exit letter call still works');
  ok('experience and relieving letters come from the existing exit letters');

  // 6. sending
  const hr = await prisma.user.create({ data: { name: 'HR Person', email: `hr-${run}@work.example`, passwordHash: 'x', role: 'HR' } });
  let s = await HL.send(anu.id, 'appointment', {}, hr); assert.equal(s.state, 'NOT_SENT'); assert.ok(/switched off/.test(s.message)); assert.equal(sent.length, 0);
  assert.equal(await prisma.employeeDocument.count({ where: { employeeId: anu.id } }), 0, 'nothing is filed while sending is off');
  await prisma.appSetting.create({ data: { key: HL.SETTINGS_KEY, value: JSON.stringify({ sendEnabled: true }) } });
  s = await HL.send(anu.id, 'appointment', {}, hr); assert.deepEqual([s.state, s.to], ['SENT', 'anusha@home.example']);
  assert.equal(sent[0].attachments[0].contentType, 'application/pdf'); assert.ok(sent[0].subject.includes('Appointment Letter') && sent[0].text.startsWith('Dear Anusha,') && !/Rs\./.test(sent[0].text) && sent[0].senderEmail === hr.email && sent[0].useEmployeeFrom === false);
  await HL.send(anu.id, 'appointment', {}, hr, { to: 'other@home.example' }); assert.equal(sent[1].to, 'other@home.example');
  assert.equal(await prisma.employeeDocument.count({ where: { employeeId: anu.id, docType: 'Appointment Letter' } }), 1, 'a newer copy replaces the older one');
  assert.ok(audits.every((a) => !/Rs\.|300000/.test(String(a.toValue))), 'the audit log never carries pay');
  assert.ok(/valid email/.test((await HL.send(anu.id, 'appointment', {}, hr, { to: 'a@b.example, c@d.example' })).message));
  assert.ok(/no email address/.test((await HL.send(bare.id, 'internshipCertificate', { role: 'x', startDate: '2026-01-01', endDate: '2026-02-01' }, hr)).message));
  assert.ok(/test person/i.test((await HL.send(zz.id, 'appointment', {}, hr)).message));
  const before = sent.length; assert.equal((await HL.send(leaver.id, 'relieving', {}, hr)).state, 'SENT'); assert.equal(sent.length, before + 1);
  assert.equal(await prisma.employeeDocument.count({ where: { employeeId: leaver.id, docType: 'Relieving Letter' } }), 1);
  mailResult = { ok: false, error: 'mail is not set up' }; s = await HL.send(anu.id, 'appraisal', { reviewPeriod: 'FY' }, hr); assert.equal(s.state, 'NOT_SENT'); assert.ok(/not sent: mail is not set up/.test(s.message)); mailResult = { ok: true };
  ok('send: off until switched on, one valid address, PDF attached, kept once in Documents, no pay in the mail text or audit log, test people and failures handled');

  // 7. who may use it
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/hr-letters', require(path.join(SRC, 'routes', 'hrLetters')));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/hr-letters`;
  users.hr = hr; users.stl = { ...hr, id: 'stl', role: 'STL' }; users.emp = { ...hr, id: anu.userId || 'emp', role: 'EMPLOYEE' };
  const call = (user, url, body) => fetch(`${base}${url}`, body ? { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'x-user': user } });
  let res = await call('hr', `/${anu.id}`); assert.equal(res.status, 200); assert.equal((await res.json()).letters.length, 6);
  for (const u of ['stl', 'emp']) { assert.equal((await call(u, `/${anu.id}`)).status, 403); assert.equal((await call(u, `/${anu.id}/appointment/send`, {})).status, 403); assert.equal((await call(u, `/${anu.id}/appointment/preview`, {})).status, 403); }
  res = await call('hr', `/${anu.id}/appointment/preview`, { fields: {} }); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal((await call('hr', `/${anu.id}/nothing/preview`, {})).status, 404); assert.equal((await call('hr', '/nobody')).status, 404);
  assert.equal((await call('hr', `/${anu.id}/internshipOffer/preview`, {})).status, 409);
  server.close();
  const doc = { docName: 'Generated by TeamLink', docType: 'Appraisal Letter' };
  assert.deepEqual([HL.payLetterHidden({ self: false, desk: false }, doc), HL.payLetterHidden({ self: true, desk: false }, doc), HL.payLetterHidden({ self: false, desk: true }, doc), HL.payLetterHidden({ self: false, desk: false }, { ...doc, docType: 'Relieving Letter' }), HL.payLetterHidden({ self: false, desk: false }, { ...doc, docName: 'uploaded' })], [true, false, false, false, false]);
  ok('only the HR desk may list, preview or send; a filed pay letter is hidden from managers and team leads');

  if (SAMPLES) { fs.mkdirSync(SAMPLES, { recursive: true }); for (const [name, pdf] of samples) fs.writeFileSync(path.join(SAMPLES, name), pdf); console.log(`samples: ${SAMPLES}`); }
  console.log(`hr letters send tests: ${passed} groups passed, ${sent.length} fake emails, nothing real sent`);
  await prisma.$disconnect(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

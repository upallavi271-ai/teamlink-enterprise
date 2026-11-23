#!/usr/bin/env node
/**
 * "EMAIL OFFER LETTER" ON AN EMPLOYEE (utils/offerLetterMail.js emailForEmployee, 2026-11-23): the offer letter on file goes to the employee as a PDF.
 * Stand-in records and a FAKE mailer, so nothing is sent anywhere:   node scripts/employee-offer-email-test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const SRC = process.argv[2] || path.resolve(__dirname, '..', 'src');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-offer-'));
const pdfBytes = Buffer.from('%PDF-1.3\nfake offer letter\n');
fs.writeFileSync(path.join(dir, 'abc123.pdf'), pdfBytes);
const docs = [];
const audits = [];
const sent = [];
let mailResult = { ok: true, providerRef: 'fake-1' };
const prisma = {
  company: { findFirst: async () => ({ legalName: 'Teamlink Consultants [OPC] Pvt. Ltd.' }) },
  employeeDocument: { findFirst: async ({ where }) => docs.filter((d) => d.employeeId === where.employeeId && d.docType === where.docType).pop() || null },
  user: { findUnique: async () => null },
  appSetting: { findUnique: async () => null },
};
const stub = (rel, exp) => { const p = require.resolve(path.join(SRC, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('db.js', prisma);
stub('utils/audit.js', { logAudit: async (a) => { audits.push(a); } });
stub('utils/attachments.js', { resolveStored: (n) => (n === 'abc123.pdf' ? path.join(dir, n) : null) });
stub('utils/mailer.js', { sendMail: async (m) => { sent.push(m); return mailResult; } });
stub('utils/candidateComms.js', { senderIdentity: async () => ({ senderEmail: 'hr@tmlink.in', senderName: 'Developer Team' }) });

let fails = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra).slice(0, 300)}`}`); if (!ok) fails += 1; };

(async () => {
  const O = require(path.join(SRC, 'utils/offerLetterMail.js'));
  const actor = { id: 'u-hr', name: 'Developer Team', email: 'dev@tmlink.in' };
  const emp = { id: 'e1', name: 'Sanjana Manthena', employeeCode: 'TL534', designation: 'Employee', email: 'sanjanam@tmlink.in', personalEmail: 'sanjana.home@gmail.com' };

  const none = await O.emailForEmployee(emp, actor);
  check('no offer letter on file: nothing sent, says to make one first', none.state === 'NOT_SENT' && /Make offer letter/.test(none.message) && sent.length === 0, none);

  docs.push({ id: 'd1', employeeId: 'e1', docType: 'Offer Letter', file: 'abc123.pdf', fileName: 'Offer-letter-TL534.pdf', mime: 'application/pdf' });
  const ok = await O.emailForEmployee(emp, actor);
  const m = sent[0] || {};
  check('sent to the WORK email (not the personal one)', ok.state === 'SENT' && ok.to === 'sanjanam@tmlink.in' && m.to === 'sanjanam@tmlink.in', [ok, m.to]);
  check('the saved PDF is attached, byte for byte, with its own file name', m.attachments && m.attachments.length === 1 && m.attachments[0].filename === 'Offer-letter-TL534.pdf' && Buffer.compare(m.attachments[0].content, pdfBytes) === 0 && m.attachments[0].contentType === 'application/pdf');
  check('subject and covering note: designation, company, how to accept; no salary', /Your offer letter - Employee at Teamlink Consultants/.test(m.subject) && /Dear Sanjana,/.test(m.text) && /I accept the offer/.test(m.text) && !/10,000|3,00,000|stipend|CTC/i.test(m.subject + m.text), m.text);
  check('sent as TeamLink HR, replies go to the HR person', m.fromName === 'TeamLink HR' && m.useEmployeeFrom === false && m.senderEmail === 'hr@tmlink.in', { fromName: m.fromName, senderEmail: m.senderEmail });
  const a = audits[audits.length - 1] || {};
  check('audited with who and the address, never the salary', /emailed to the employee/.test(a.action || '') && /sanjanam@tmlink.in/.test(a.toValue || '') && a.userId === 'u-hr' && !/10,000|CTC/.test(JSON.stringify(a)), a);

  sent.length = 0; audits.length = 0;
  const personal = await O.emailForEmployee({ ...emp, email: null }, actor);
  check('no work email: falls back to the personal address', personal.state === 'SENT' && sent[0].to === 'sanjana.home@gmail.com', personal);
  sent.length = 0;
  const noMail = await O.emailForEmployee({ ...emp, email: '', personalEmail: '' }, actor);
  check('no address at all: nothing sent, says what to add', noMail.state === 'NOT_SENT' && /email address/.test(noMail.message) && sent.length === 0, noMail);
  const bad = await O.emailForEmployee({ ...emp, email: 'not-an-address', personalEmail: null }, actor);
  check('a bad address is refused', bad.state === 'NOT_SENT' && sent.length === 0, bad);
  const test = await O.emailForEmployee({ ...emp, name: 'ZZTEST Person', email: 'zztest@tmlink.in' }, actor);
  check('a test person is never mailed', test.state === 'NOT_SENT' && sent.length === 0, test);
  docs[0].file = 'missing.pdf';
  const gone = await O.emailForEmployee(emp, actor);
  check('the stored file is missing: nothing sent, plain words', gone.state === 'NOT_SENT' && /could not be found/.test(gone.message) && sent.length === 0, gone);
  docs[0].file = 'abc123.pdf';
  audits.length = 0; mailResult = { ok: false, error: 'SMTP is down' };
  const fail = await O.emailForEmployee(emp, actor);
  check('the mail provider fails: reported, and written down as NOT sent with who, the address and why - never as sent, never the salary', fail.state === 'NOT_SENT' && /SMTP is down/.test(fail.message) && audits.length === 1 && /NOT sent/.test(audits[0].action) && /SMTP is down/.test(audits[0].toValue) && !/emailed to the employee/.test(audits[0].action) && !/10,000|CTC/.test(JSON.stringify(audits[0])), [fail, audits]);
  mailResult = { ok: false, notConfigured: true, error: 'No email channel is configured' };
  check('mail not set up: reported in plain words', /not configured|No email channel/i.test((await O.emailForEmployee(emp, actor)).message));

  // ---- the employee's own download rule (My Profile -> Download offer letter)
  const G = O.selfDownloadGate;
  const day = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
  const joinedEmp = { dateOfJoining: new Date(`${day(-14)}T00:00:00Z`), designation: 'Employee' };
  check('self download: joined, profile 100% -> ready', G(joinedEmp, 100).ok === true);
  check('self download: joined TODAY, profile 100% -> ready (the letter is available on the joining date)', G({ ...joinedEmp, dateOfJoining: new Date(`${day(0)}T00:00:00Z`) }, 100).ok === true);
  const future = G({ ...joinedEmp, dateOfJoining: new Date(`${day(3)}T00:00:00Z`) }, 100);
  check('self download: joining date still ahead -> not ready, says the date', future.ok === false && future.why.includes(day(3).split('-').reverse().join('-')), future);
  const part = G(joinedEmp, 78);
  check('self download: profile 78% -> not ready, says how far they are', part.ok === false && /78%/.test(part.why) && /100%/.test(part.why), part);
  check('self download: no joining date -> not ready, says HR will add it', G({ designation: 'Employee' }, 100).ok === false && /HR will add/.test(G({ designation: 'Employee' }, 100).why));
  check('self download: no designation -> not ready', G({ ...joinedEmp, designation: '' }, 100).ok === false);
  check('self download: a joining date still ahead is said before an incomplete profile', /joining date/.test(G({ ...joinedEmp, dateOfJoining: new Date(`${day(5)}T00:00:00Z`) }, 40).why));

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });

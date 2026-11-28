// ---------------------------------------------------------------------------
// INTERNAL HIRE -> EMPLOYEE: THE JOINING PACK (founder 2026-11-03: "internal hiring HRs cheskuntaru, same process. but
// candidate join ayyaka, HRMS employee kinda generate ipoyyi, thanaki offer letter, joining letter, onboarding & login
// credentials velthai. akkadi nunchi thanu employee kindha ipotharu").
//
// Runs right after utils/joining.js createHrmsEmployee() makes the HRMS employee for a TeamLink internal hire (never for a
// client placement), and again from "Send joining pack" (a retry; every step is idempotent):
//   1. reporting manager   the job's team lead (Requirement.tlId) becomes the employee's reporting manager, when not set
//   2. login               the same as Employees > Create login (routes/employees.js createLoginFor): role and reach from
//                          the designation, a single-use set-password link emailed (utils/employeeInvite.js)
//   3. joining letter      a PDF on TeamLink's letterhead (code, designation, department, joining date, place, CTC from the
//                          offer, reporting manager, probation, documents to bring) kept in the employee's documents as
//                          "Joining Letter"; the signed offer letter (when there is one) is kept as "Offer Letter"
//   4. welcome email       "Welcome to TeamLink": the joining details, the first-day checklist (the onboarding tasks) and the
//                          joining letter attached; the login link comes in its own email (step 2)
//   5. bells               HR (whoever marked the joining) and the reporting manager are told
// Every step's result is written to the audit log and returned, so the Joining screen can say what went out.
// ---------------------------------------------------------------------------
const fs = require('fs');
const prisma = require('../db');
const { logAudit } = require('./audit');

const TEMPLATE_KEY = 'joining-letter-template';
const DEFAULT_TEMPLATE = `Dear {{name}},

We are pleased to confirm your appointment with {{company}} as {{designation}} in the {{department}} team, with effect from {{joiningDate}}.

Employee code: {{employeeCode}}
Designation: {{designation}}
Department: {{department}}
Place of work: {{location}}
Employment type: {{employmentType}}
Reporting to: {{manager}}
Annual CTC: {{ctc}}

You will be on probation for {{probationMonths}} months from your date of joining. Your detailed salary break-up and the company policies are shared with you on the HRMS after you sign in.

On your first day please bring the originals and one copy of: your ID proof (Aadhaar), PAN card, education certificates, experience / relieving letters from previous employers, two passport-size photographs and your bank account details.

We welcome you to {{company}} and wish you a long and rewarding career with us.`;

const inr = (v) => (v ? `Rs. ${Math.round(Number(v)).toLocaleString('en-IN')}` : 'As per your offer letter');
const longDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

async function template() {
  const row = await prisma.appSetting.findUnique({ where: { key: TEMPLATE_KEY } }).catch(() => null);
  return (row && row.value && row.value.trim()) || DEFAULT_TEMPLATE;
}
const fill = (t, v) => String(t).replace(/\{\{(\w+)\}\}/g, (m, k) => (v[k] != null && v[k] !== '' ? String(v[k]) : '-'));

// The values printed in the letter and the email.
async function letterValues({ employee, application }) {
  const mgr = employee.reportingManagerId ? await prisma.employee.findUnique({ where: { id: employee.reportingManagerId }, select: { name: true, designation: true } }).catch(() => null) : null;
  const company = process.env.COMPANY_LEGAL_NAME || 'TeamLink Consultants OPC Pvt Ltd';
  // probation: 6 months, Team Leads 3 (founder 2026-11-28, utils/probationLength.js)
  const PL = require('./probationLength'); // eslint-disable-line global-require
  const length = await PL.getSettings();
  const login = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId }, select: { role: true, hrmsRole: true } }).catch(() => null) : null;
  return {
    company,
    name: employee.name,
    employeeCode: employee.employeeCode,
    designation: employee.designation || '-',
    department: employee.department || '-',
    joiningDate: longDate(employee.dateOfJoining || new Date()),
    location: employee.location || employee.branch || '-',
    employmentType: employee.employeeType || 'Full-time',
    manager: mgr ? `${mgr.name}${mgr.designation ? `, ${mgr.designation}` : ''}` : 'Will be introduced on your first day',
    ctc: inr(application && application.offeredCtc),
    probationMonths: PL.isLead({ designation: employee.designation, user: login }) ? length.leadMonths : length.months,
  };
}

// The joining letter as a PDF (pdfkit, A4, the TeamLink logo).
async function joiningLetterPdf({ employee, application }) {
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { LOGO } = require('./agreementPdf'); // eslint-disable-line global-require
  const v = await letterValues({ employee, application });
  const body = fill(await template(), v);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Joining letter - ${employee.name}`, Author: v.company } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 112; const NAVY = '#1b2a4a'; const MUTED = '#5b6474';
    if (fs.existsSync(LOGO)) { try { doc.image(LOGO, 56, 44, { height: 28 }); } catch { /* optional */ } }
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Ref: ${employee.employeeCode}/JL`, 56, 48, { width: W, align: 'right' }).text(longDate(new Date()), { width: W, align: 'right' });
    doc.moveDown(2.4);
    doc.font('Helvetica-Bold').fontSize(17).fillColor(NAVY).text('Joining Letter', 56);
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(body, { width: W, lineGap: 2.5 });
    doc.moveDown(2);
    doc.text(`For ${v.company}`);
    doc.moveDown(2.2);
    doc.font('Helvetica-Bold').text('Human Resources');
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`I accept the appointment on the terms above.\n\nSignature: ______________________     Date: ______________\n${employee.name}`, { width: W });
    doc.end();
  });
}

// File a PDF in the employee's documents (once per type; a newer one replaces the older one we made).
async function fileDocument(employeeId, docType, buf, fileName, byUserId) {
  const attachments = require('./attachments'); // eslint-disable-line global-require
  const old = await prisma.employeeDocument.findMany({ where: { employeeId, docType, docName: 'Generated by TeamLink' } });
  const stored = attachments.store({ data: buf, contentType: 'application/pdf', filename: fileName });
  const doc = await prisma.employeeDocument.create({ data: { employeeId, docType, docName: 'Generated by TeamLink', file: stored.billFile, fileName: stored.billName, mime: stored.billMime, size: stored.billSize, uploadedBy: byUserId || null } });
  for (const o of old) { await prisma.employeeDocument.delete({ where: { id: o.id } }).catch(() => null); attachments.remove(o.file); } // eslint-disable-line no-await-in-loop
  return doc;
}

async function onboardingList(employee) {
  try { return JSON.parse(employee.onboardingTasks || '[]').map((t) => t.task).filter(Boolean); } catch { return []; }
}

// The whole pack. actorId = who marked the joining (HR); returns what happened at each step.
async function sendJoiningPack({ employeeId, applicationId, actorId, resend = false }) {
  const out = { manager: null, login: null, joiningLetter: null, offerLetter: null, welcome: null };
  let employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return { ...out, error: 'The employee record is not there.' };
  const application = applicationId ? await prisma.application.findUnique({ where: { id: applicationId }, include: { requirement: true } }) : null;
  const requirement = application && application.requirement;

  // 1. reporting manager = the job's team lead
  try {
    if (!employee.reportingManagerId && requirement && requirement.tlId) {
      const mgr = await prisma.employee.findFirst({ where: { userId: requirement.tlId }, select: { id: true, name: true } });
      if (mgr && mgr.id !== employee.id) {
        employee = await prisma.employee.update({ where: { id: employee.id }, data: { reportingManagerId: mgr.id } });
        out.manager = mgr.name;
      }
    }
  } catch (e) { out.manager = `not set: ${e.message}`; }

  // 2. login + set-password email (as Employees > Create login)
  try {
    if (employee.userId) {
      out.login = resend ? await resendCredentials(employee, actorId) : 'already has a login';
    } else if (!employee.email) {
      out.login = 'not made: no email on the employee record - add it, then press Send joining pack';
    } else {
      const taken = await prisma.user.findFirst({ where: { email: employee.email }, select: { id: true, clientId: true, candidateId: true } });
      if (taken && (taken.clientId || taken.candidateId)) {
        out.login = 'not made: this email still belongs to a candidate / client login - free it in Administration > Users, then press Send joining pack';
      } else {
        const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
        const actor = actorId ? await resolveIdentity(actorId).catch(() => null) : null;
        if (!actor) {
          out.login = 'not made: nobody to make it as - press Create login on the employee';
        } else {
          const { createLoginFor } = require('../routes/employees'); // eslint-disable-line global-require
          const r = await createLoginFor({ user: actor, headers: {} }, employee);
          out.login = r.error ? `not made: ${r.error}` : `made; sign-in link: ${(r.credentials && r.credentials.status) || 'sent'}`;
          employee = await prisma.employee.findUnique({ where: { id: employee.id } });
        }
      }
    }
  } catch (e) { out.login = `not made: ${e.message}`; }

  // 3. joining letter (+ the signed offer letter, when there is one)
  let letter = null;
  try {
    letter = await joiningLetterPdf({ employee, application });
    await fileDocument(employee.id, 'Joining Letter', letter, `Joining-letter-${employee.employeeCode}.pdf`, actorId);
    out.joiningLetter = 'made and kept in the employee\'s documents';
  } catch (e) { out.joiningLetter = `not made: ${e.message}`; }
  try {
    if (application) {
      const ver = await prisma.offerVersion.findFirst({ where: { applicationId: application.id, signedAt: { not: null }, pdfFile: { not: null } }, orderBy: { createdAt: 'desc' } }).catch(() => null);
      const full = ver ? require('./attachments').resolveStored(ver.pdfFile) : null; // eslint-disable-line global-require
      if (full) { await fileDocument(employee.id, 'Offer Letter', fs.readFileSync(full), `Offer-letter-${employee.employeeCode}.pdf`, actorId); out.offerLetter = 'signed copy kept in the employee documents'; } else {
        // no e-signed copy: the offer letter in the company's format (utils/offerLetterMail.js, the same letter the candidate is mailed)
        // is made from the application and kept, so every new joiner has their offer letter on file (2026-11-23)
        const made = await require('./offerLetterMail').pdfOf(application.id); // eslint-disable-line global-require
        if (made && made.pdf) { await fileDocument(employee.id, 'Offer Letter', made.pdf, `Offer-letter-${employee.employeeCode}.pdf`, actorId); out.offerLetter = 'made and kept in the employee\'s documents'; } else out.offerLetter = 'no offer letter could be made';
      }
    }
  } catch (e) { out.offerLetter = `not kept: ${e.message}`; }

  // 4. welcome email with the joining letter and the first-day checklist
  try {
    if (!employee.email) {
      out.welcome = 'not sent: no email';
    } else {
      const v = await letterValues({ employee, application });
      const tasks = await onboardingList(employee);
      const text = [
        `Dear ${employee.name},`, '',
        `Welcome to ${v.company}! Your joining letter is attached.`, '',
        `Employee code: ${v.employeeCode}`, `Designation: ${v.designation}`, `Department: ${v.department}`, `Date of joining: ${v.joiningDate}`, `Place of work: ${v.location}`, `Reporting to: ${v.manager}`, '',
        'Your first days - HR will complete these with you:', ...tasks.map((t) => `  - ${t}`), '',
        'You will get a separate email with a link to set your TeamLink password. After you sign in you will find your attendance, leave, payslips and documents in HRMS.', '',
        'Regards,', 'HR, TeamLink',
      ].join('\n');
      const r = await require('./mailer').sendMail({ // eslint-disable-line global-require
        to: employee.email, subject: `Welcome to TeamLink - your joining letter (${employee.employeeCode})`, text,
        attachments: letter ? [{ filename: `Joining-letter-${employee.employeeCode}.pdf`, content: letter, contentType: 'application/pdf' }] : undefined,
      });
      out.welcome = r && r.ok ? `sent to ${employee.email}` : `not sent: ${(r && r.error) || 'mail is not set up'}`;
    }
  } catch (e) { out.welcome = `not sent: ${e.message}`; }

  // 5. bells for HR and the reporting manager
  try {
    const mgrUser = employee.reportingManagerId ? (await prisma.employee.findUnique({ where: { id: employee.reportingManagerId }, select: { userId: true } }) || {}).userId : null;
    await require('./notify').notifyUsers([actorId, mgrUser], { // eslint-disable-line global-require
      title: `New joiner: ${employee.name} (${employee.employeeCode})`,
      message: `${employee.designation || ''} · joins ${longDate(employee.dateOfJoining || new Date())}. Login: ${out.login}. Welcome email: ${out.welcome}.`,
    });
  } catch { /* bells never block */ }

  await logAudit({ userId: actorId || null, action: resend ? 'Joining pack sent again (internal hire)' : 'Joining pack sent (internal hire)', entity: 'Employee', entityId: employee.id, toValue: `login: ${out.login}; letter: ${out.joiningLetter}; welcome: ${out.welcome}`.slice(0, 500) }).catch(() => {});
  return out;
}

async function resendCredentials(employee, actorId) {
  const { sendCredentials } = require('./employeeInvite'); // eslint-disable-line global-require
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const actor = actorId ? await resolveIdentity(actorId).catch(() => null) : null;
  const fresh = await prisma.employee.findUnique({ where: { id: employee.id } });
  const r = await sendCredentials({ employee: fresh, userId: fresh.userId, actingUser: actor, req: { headers: {} } });
  return `sign-in link sent again: ${(r && r.status) || 'done'}`;
}

module.exports = { sendJoiningPack, joiningLetterPdf, fileDocument, DEFAULT_TEMPLATE, TEMPLATE_KEY };

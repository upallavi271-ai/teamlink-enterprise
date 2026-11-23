// ---------------------------------------------------------------------------
// THE OFFER LETTER, MAILED WITH THE JOINING DATE (founder 2026-11-17: "when a candidate receives a joining date mail then they have
// to receive an automatic offer letter through mail, so create a professional one").
//
// WHO GETS IT: a TeamLink INTERNAL HIRE (a new employee of TeamLink Consultants). For a client placement the CLIENT makes the offer
// and joining letters (utils/clientTrack.js), so nothing here is ever sent for one.
//
// WHAT GOES OUT: one email to the candidate with the letter in the mail itself (HTML) AND as a PDF (pdfkit, A4, the TeamLink logo).
// The wording is one editable template (Administration -> Company Setup -> Message templates -> Offer letter); every {{placeholder}}
// is filled from the application / candidate / job. A line that needs a detail nobody has (no reporting manager on file, no working hours typed in the editor)
// is LEFT OUT, never printed with a blank.
//
// WHEN (utils/offerLetterMail.js maybeSendAuto, called from three places, all wrapped so they can never break the real action):
//   * HR sets or changes the joining date          routes/interviewsJoining.js POST /joining/:id/schedule
//   * the candidate's joining reminder is sent     utils/clientTrack.js joiningReminderToCandidate (catches joinings set earlier)
//   * a recruiter sends a "joining" message        utils/omniSend.js (Contact: Joining Confirmation / Joining reminder)
// ONCE PER JOINING: the raw table "OfferLetterMail" has one row per application (primary key = applicationId). The row is CLAIMED
// before anything is sent, so two triggers at the same moment send one mail; a joining date that is changed or re-sent later sends
// nothing more. Only a person pressing "Send again" (resend) mails it a second time.
//
// SWITCHES: "Send the offer letter automatically" (this file, ships OFF - the wording is the founder's to check first) and, as for
// every automatic candidate mail, the one "Candidate emails" master switch (utils/interviewNotices.js). A person pressing Send / Send
// again is a human decision and does not need either switch (consent, a missing address and test people are still refused).
//
// THE RECORD: Candidate -> Communications (a CandidateMessage row, with the real result), the application's pipeline history and the
// Audit Log - none of them carries the salary. A mail that could not go says why in plain words, on the card, and the recruiter and
// the team lead get a bell. The salary is printed ONLY inside the letter that goes to the candidate and to staff who may open Offers.
// ---------------------------------------------------------------------------
const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../db');
const sandbox = require('./sandbox');
const { logAudit } = require('./audit');

const SETTINGS_KEY = 'offer-letter-mail';
const TEMPLATE_PURPOSE = 'OFFER_LETTER_MAIL';
const LABEL = 'Offer letter (with joining date)';
const STALE_MS = 10 * 60000; // a claim older than this is a crashed send: it may be taken again
const NAVY = '#1f2a44';
const MUTED = '#5b6474';
const TEST_RE = /zztest|example\.test/i;
const skipTestPerson = (...v) => !sandbox.isSandbox() && TEST_RE.test(v.filter(Boolean).join(' '));

// --- the placeholders ---------------------------------------------------------------------------------------------------
const TOKENS = [
  { key: 'name', label: 'Candidate full name', sample: 'Anita Rao' },
  { key: 'firstName', label: 'Candidate first name', sample: 'Anita' },
  { key: 'designation', label: 'Designation (the job title)', sample: 'Senior HR Executive' },
  { key: 'department', label: 'Department', sample: 'Human Resources' },
  { key: 'location', label: 'Place of work', sample: 'Hyderabad' },
  { key: 'joiningDate', label: 'Joining date', sample: '1 Dec 2026' },
  { key: 'joiningDay', label: 'Day of the week of joining', sample: 'Tuesday' },
  { key: 'monthlySalary', label: 'Trainee stipend per month (set below in the editor)', sample: '₹10,000/- per month' },
  { key: 'monthlySalaryWords', label: 'Trainee stipend in words', sample: 'Rupees Ten Thousand only' },
  { key: 'confirmedCtc', label: 'Annual CTC on confirmation (set below in the editor)', sample: '₹3,00,000/- per annum' },
  { key: 'confirmedCtcWords', label: 'Annual CTC on confirmation in words', sample: 'Rupees Three Lakhs only' },
  { key: 'workingHours', label: 'Working hours (set below in the editor)', sample: '9:30 am to 6:30 pm, Monday to Friday' },
  { key: 'ctc', label: 'Annual CTC from the offer (not used in the standard letter)', sample: '₹ 1,20,000 per annum' },
  { key: 'manager', label: 'Reporting manager (the job’s team lead)', sample: 'Ravi Kumar, Team Lead' },
  { key: 'company', label: 'Company name', sample: 'TeamLink Consultants' },
  { key: 'probationMonths', label: 'Trainee period in months (set below in the editor)', sample: '3' },
  { key: 'offerDate', label: 'Date of this letter', sample: '17 Nov 2026' },
  { key: 'refNo', label: 'Letter reference number', sample: 'TL/OL/2026/A1B2C3' },
];
const TOKEN_KEYS = new Set(TOKENS.map((t) => t.key));
const TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;
const tokensIn = (text) => [...String(text || '').matchAll(TOKEN_RE)].map((m) => m[1]);

// --- the starting wording. EVERYTHING here is editable; the terms are plain, common ones and are for the founder to check. --
const DEFAULT_TEMPLATE = {
  subject: 'Your offer letter - {{designation}} at {{company}}',
  coverNote: [
    'Dear {{firstName}},',
    '',
    'Greetings from {{company}}!',
    '',
    'We are happy to confirm that you join us on {{joiningDate}}. Your offer letter is below, and it is also attached as a PDF for your records.',
    '',
    'To accept, please reply to this email with the words "I accept the offer", or sign the attached letter and send it back to us. If you have any question, just reply to this email and we will help you.',
  ].join('\n'),
  // The letter follows the founder's reference offer letter (Offer_Letter_Teamlink_Divyasri.docx, 2026-11-23): OFFER LETTER,
  // the date, To / name / place, the opening paragraph, four numbered points, the welcome line, the signature and the acceptance.
  title: 'Offer Letter',
  intro: [
    'Dear {{name}},',
    '',
    'Further to your application and the subsequent interview, we are pleased to offer you the position of {{designation}} in the {{department}} Department at {{company}}, based at our Corporate Office in {{location}}, under the following terms and conditions:',
  ].join('\n'),
  termsHeading: '', // a heading over the numbered points; empty = none (the reference letter has none)
  // TeamLink pays one flat salary per month to every new and experienced employee (founder 2026-11-18): no CTC break-up.
  // showCtc is the old name of the "print the salary" tick; it switches the salary lines off when false.
  showCtc: true,
  monthlySalary: 10000, // the trainee stipend per month (the founder's reference offer letter, 2026-11-19)
  traineeMonths: 3, // the trainee period (probation) in months
  confirmedCtc: 300000, // the annual CTC on confirmation (the same reference letter)
  workingHours: '', // the founder types the real hours once; until then the working-hours lines are left out
  details: [], // the reference letter has no details table; rows can still be added in the editor
  terms: [
    { title: 'Date of Appointment', text: '{{joiningDate}}' },
    { title: 'Trainee Period & Stipend', text: 'Initial designation will be {{designation}} on a temporary/probationary basis with a stipend of {{monthlySalary}} ({{monthlySalaryWords}}). Standard regular employee benefits will not apply during this trainee phase.' },
    { title: 'Confirmation & CTC Enhancement', text: 'Upon successful evaluation and meeting required performance targets within {{probationMonths}} months, your employment will be confirmed as a permanent employee with an annual Cost to Company (CTC) of {{confirmedCtc}} ({{confirmedCtcWords}}).' },
    {
      title: 'Documents Required at Joining',
      text: [
        '• Relieving and Service Certificates from previous employers (if applicable).',
        '• Last 6 months’ pay slips from previous organization.',
        '• Photocopies of Academic Certificates.',
        '• Two passport-sized photographs.',
        '• Photocopies of Address & ID proofs (PAN Card & Aadhaar Card).',
      ].join('\n'),
    },
  ],
  closing: 'We welcome you to {{company}} for a long and fruitful association, and look forward to your valuable contributions towards the organization’s growth. We wish you the very best of luck!',
  signatoryName: '',
  signatoryTitle: 'HR Department',
  acceptanceLine: '', // the reference letter has only the signature line under "Acceptance of Offer"; words typed here print above it
  footerNote: '', // small print at the foot of the page; the reference letter has none
};
const LIMITS = {
  subject: 200, coverNote: 3000, title: 80, termsHeading: 80, intro: 2000, closing: 1000, signatoryName: 80, signatoryTitle: 120, acceptanceLine: 600, footerNote: 300,
  rowLabel: 60, rowValue: 200, termTitle: 80, termText: 1500, maxDetails: 12, maxTerms: 20, workingHours: 120, maxMonthlySalary: 1000000, maxConfirmedCtc: 100000000, maxTraineeMonths: 12,
};
// "₹10,000/- per month" and "Rupees Ten Thousand only", the way the reference offer letter writes money.
const monthlyText = (n) => (Number(n) > 0 ? `₹${Math.round(Number(n)).toLocaleString('en-IN')}/- per month` : '');
const yearlyText = (n) => (Number(n) > 0 ? `₹${Math.round(Number(n)).toLocaleString('en-IN')}/- per annum` : '');
function rupeeWords(n) {
  if (!(Number(n) > 0)) return '';
  const { wordsINR } = require('./accounts'); // eslint-disable-line global-require
  return wordsINR(Math.round(Number(n)))
    .replace(/^Indian Rupee /, 'Rupees ')
    .replace(/ Only$/, ' only')
    .replace(/\b(\w+) (Lakh|Crore)\b/g, (m, a, unit) => (a === 'One' ? m : `${a} ${unit}s`));
}

// --- settings (one AppSetting row: { enabled, template }) ---------------------------------------------------------------
function parse(row) {
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return v && typeof v === 'object' ? v : {};
}
async function loadSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  const v = parse(row);
  const saved = v.template && typeof v.template === 'object' ? v.template : null;
  // A letter saved before the heading became editable always printed "Terms of employment": it keeps it.
  const legacyHeading = saved && !('termsHeading' in saved) ? { termsHeading: 'Terms of employment' } : {};
  return {
    enabled: v.enabled === true,
    template: { ...DEFAULT_TEMPLATE, ...legacyHeading, ...(saved || {}) },
    custom: !!(v.template && typeof v.template === 'object'),
    updatedByName: row ? row.updatedByName : null,
    updatedAt: row ? row.updatedAt : null,
  };
}
async function writeSettings(patch, user) {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  const cur = parse(row);
  const next = { enabled: cur.enabled === true, template: cur.template, ...patch };
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  return loadSettings();
}
async function setAutomatic(enabled, user) {
  const before = (await loadSettings()).enabled;
  const out = await writeSettings({ enabled: enabled === true }, user);
  await logAudit({ userId: user ? user.id : null, action: `Automatic offer letter turned ${out.enabled ? 'ON' : 'OFF'}`, entity: 'AppSetting', entityId: SETTINGS_KEY, fromValue: before ? 'ON' : 'OFF', toValue: out.enabled ? 'ON' : 'OFF' });
  return out;
}

// Checks a template an Admin typed: { value } | { error }.
function cleanTemplate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = (v, n) => (v == null ? '' : String(v).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n));
  // the salary per month: one flat figure for everyone; blank / 0 = no salary line is printed
  const rawSalary = b.monthlySalary == null ? '' : String(b.monthlySalary).replace(/[,\s₹]/g, '');
  const salary = rawSalary === '' ? 0 : Number(rawSalary);
  if (!Number.isFinite(salary) || salary < 0 || salary > LIMITS.maxMonthlySalary) return { error: 'Write the trainee stipend per month as a number of rupees, for example 10000.' };
  // the annual CTC on confirmation (blank = no CTC line); the trainee period is 1 to 12 months (default 3)
  const rawCtc = b.confirmedCtc == null ? '' : String(b.confirmedCtc).replace(/[,\s₹]/g, '');
  const ctc = rawCtc === '' ? 0 : Number(rawCtc);
  if (!Number.isFinite(ctc) || ctc < 0 || ctc > LIMITS.maxConfirmedCtc) return { error: 'Write the annual CTC on confirmation as a number of rupees, for example 300000.' };
  const months = b.traineeMonths == null || b.traineeMonths === '' ? 3 : Math.round(Number(b.traineeMonths));
  if (!Number.isFinite(months) || months < 1 || months > LIMITS.maxTraineeMonths) return { error: 'The trainee period is 1 to 12 months.' };
  const value = {
    subject: s(b.subject, LIMITS.subject),
    coverNote: s(b.coverNote, LIMITS.coverNote),
    title: s(b.title, LIMITS.title),
    intro: s(b.intro, LIMITS.intro),
    termsHeading: s(b.termsHeading, LIMITS.termsHeading),
    showCtc: b.showCtc !== false,
    monthlySalary: Math.round(salary),
    traineeMonths: months,
    confirmedCtc: Math.round(ctc),
    workingHours: s(b.workingHours, LIMITS.workingHours),
    details: (Array.isArray(b.details) ? b.details : []).map((r) => ({ label: s(r && r.label, LIMITS.rowLabel), value: s(r && r.value, LIMITS.rowValue) })).filter((r) => r.label && r.value),
    terms: (Array.isArray(b.terms) ? b.terms : []).map((r) => ({ title: s(r && r.title, LIMITS.termTitle), text: s(r && r.text, LIMITS.termText) })).filter((r) => r.text),
    closing: s(b.closing, LIMITS.closing),
    signatoryName: s(b.signatoryName, LIMITS.signatoryName),
    signatoryTitle: s(b.signatoryTitle, LIMITS.signatoryTitle),
    acceptanceLine: s(b.acceptanceLine, LIMITS.acceptanceLine),
    footerNote: s(b.footerNote, LIMITS.footerNote),
  };
  if (!value.subject) return { error: 'Write the subject of the email.' };
  if (!value.title) return { error: 'Write the title of the letter (for example "Offer of Employment").' };
  if (!value.intro) return { error: 'Write the opening paragraph of the letter.' };
  if (!value.details.length && !value.terms.length) return { error: 'The letter needs its details table or at least one term.' };
  if ((Array.isArray(b.details) ? b.details.length : 0) > LIMITS.maxDetails) return { error: `Keep the details table to ${LIMITS.maxDetails} rows or fewer.` };
  if ((Array.isArray(b.terms) ? b.terms.length : 0) > LIMITS.maxTerms) return { error: `Keep the terms to ${LIMITS.maxTerms} or fewer.` };
  const all = [value.subject, value.coverNote, value.intro, value.termsHeading, value.closing, value.acceptanceLine, value.footerNote, value.signatoryName, value.signatoryTitle,
    ...value.details.flatMap((r) => [r.label, r.value]), ...value.terms.flatMap((r) => [r.title, r.text])];
  const bad = [...new Set(all.flatMap(tokensIn).filter((k) => !TOKEN_KEYS.has(k)))];
  if (bad.length) return { error: `These placeholders are not known: ${bad.map((k) => `{{${k}}}`).join(', ')}. Use the list beside the editor.` };
  return { value };
}
async function saveTemplate(body, user) {
  const c = cleanTemplate(body);
  if (c.error) return c;
  const before = await loadSettings();
  const out = await writeSettings({ template: c.value }, user);
  await logAudit({ userId: user ? user.id : null, action: 'Offer letter (joining mail) template changed', entity: 'AppSetting', entityId: SETTINGS_KEY, fromValue: before.custom ? 'edited' : 'starting words', toValue: 'edited' });
  return { settings: out };
}
async function resetTemplate(user) {
  const out = await writeSettings({ template: undefined }, user);
  await logAudit({ userId: user ? user.id : null, action: 'Offer letter (joining mail) template reset to the starting words', entity: 'AppSetting', entityId: SETTINGS_KEY });
  return out;
}

// --- the values a letter is filled with -------------------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isDay = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || ''));
const longDay = (d, opt = {}) => (isDay(d) ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC', ...opt }) : '');
// "23 Sep 2026", the way the reference offer letter writes a date
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // spelled out: newer ICU writes "Sept"
const shortDay = (d) => (isDay(d) ? `${Number(String(d).slice(8, 10))} ${MON[Number(String(d).slice(5, 7)) - 1]} ${String(d).slice(0, 4)}` : '');
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const inr = (v) => (Number(v) > 0 ? `₹ ${Math.round(Number(v)).toLocaleString('en-IN')} per annum` : '');

async function companyOf() {
  const c = await prisma.company.findFirst().catch(() => null);
  const name = (c && (c.legalName || c.name)) || process.env.COMPANY_LEGAL_NAME || 'TeamLink Consultants';
  const addr = [c && c.address, c && c.hq && c.hq !== (c && c.address) ? c.hq : null].filter(Boolean)[0] || '';
  return { name, address: addr, phone: (c && c.phone) || '', email: (c && c.email) || '' };
}

const APP_INCLUDE = { candidate: true, requirement: { include: { client: { select: { name: true } } } } };
const loadApp = (id) => prisma.application.findUnique({ where: { id: String(id) }, include: APP_INCLUDE });

async function managerOf(requirement) {
  if (!requirement || !requirement.tlId) return '';
  const u = await prisma.user.findUnique({ where: { id: requirement.tlId }, select: { name: true, employee: { select: { name: true, designation: true } } } }).catch(() => null);
  if (!u) return '';
  const name = (u.employee && u.employee.name) || u.name;
  return `${name}${u.employee && u.employee.designation ? `, ${u.employee.designation}` : ''}`;
}

const sampleValues = () => Object.fromEntries(TOKENS.map((t) => [t.key, t.sample]));

async function valuesFor(app, tpl) {
  const r = app.requirement || {};
  const c = app.candidate || {};
  const company = await companyOf();
  const year = (isDay(app.offerDate) ? app.offerDate : istToday()).slice(0, 4);
  return {
    name: c.name || '',
    firstName: String(c.name || '').trim().split(/\s+/)[0] || '',
    designation: r.title || '',
    department: r.department || '',
    location: r.location || c.location || '',
    joiningDate: shortDay(app.joiningDate),
    joiningDay: longDay(app.joiningDate, { day: undefined, month: undefined, year: undefined, weekday: 'long' }),
    ctc: tpl.showCtc === false ? '' : inr(app.offeredCtc),
    monthlySalary: tpl.showCtc === false ? '' : monthlyText(tpl.monthlySalary),
    monthlySalaryWords: tpl.showCtc === false ? '' : rupeeWords(tpl.monthlySalary),
    confirmedCtc: tpl.showCtc === false ? '' : yearlyText(tpl.confirmedCtc),
    confirmedCtcWords: tpl.showCtc === false ? '' : rupeeWords(tpl.confirmedCtc),
    workingHours: tpl.workingHours || '',
    manager: await managerOf(r),
    company: company.name,
    probationMonths: String(tpl.traineeMonths || 3),
    offerDate: shortDay(istToday()),
    refNo: `TL/OL/${year}/${String(app.id).slice(-6).toUpperCase()}`,
  };
}

// Fills {{x}}. A token with no value becomes ''. -> { text, missing: [keys] }
function fill(text, vals) {
  const missing = [];
  const out = String(text == null ? '' : text).replace(TOKEN_RE, (m, k) => {
    const v = vals[k];
    if (v == null || String(v).trim() === '') { missing.push(k); return ''; }
    return String(v);
  });
  return { text: out, missing };
}
// For a table row or a numbered term: kept only when EVERY detail it uses has a value.
function fillLine(text, vals) {
  const r = fill(text, vals);
  return { text: r.text.replace(/[ \t]+\n/g, '\n').trim(), skip: r.missing.length > 0, missing: r.missing };
}
const fillPlain = (text, vals) => fill(text, vals).text.replace(/\n{3,}/g, '\n\n').trim();

// Bold inside the letter's paragraphs: B_ON value B_OFF (control characters a template can never contain - cleanTemplate strips them).
const B_ON = '\u0001';
const B_OFF = '\u0002';
const BOLD_RE = /\u0001([^\u0002]*)\u0002/g;
const BOLD_TOKENS = ['name', 'designation', 'department', 'company', 'joiningDate', 'monthlySalary', 'confirmedCtc', 'probationMonths'];
const unmark = (s) => String(s == null ? '' : s).replace(BOLD_RE, '$1');
// -> [{ t, b }] runs of plain and bold text
function runsOf(s) {
  const str = String(s == null ? '' : s);
  const out = [];
  let last = 0;
  str.replace(BOLD_RE, (m, v, i) => {
    if (i > last) out.push({ t: str.slice(last, i), b: false });
    out.push({ t: v, b: true });
    last = i + m.length;
    return m;
  });
  if (last < str.length) out.push({ t: str.slice(last), b: false });
  return out;
}

// The whole letter as data; the HTML, the text and the PDF are all drawn from this.
async function buildModel(app, tpl, { sample = false } = {}) {
  const company = await companyOf();
  const vals = sample ? sampleValues() : await valuesFor(app, tpl);
  if (sample) vals.company = company.name;
  if (sample && tpl.showCtc === false) vals.ctc = '';
  // the salary and the working hours are typed once in the editor, so the sample shows exactly what the editor holds
  if (sample) {
    vals.monthlySalary = tpl.showCtc === false ? '' : monthlyText(tpl.monthlySalary);
    vals.monthlySalaryWords = tpl.showCtc === false ? '' : rupeeWords(tpl.monthlySalary);
    vals.confirmedCtc = tpl.showCtc === false ? '' : yearlyText(tpl.confirmedCtc);
    vals.confirmedCtcWords = tpl.showCtc === false ? '' : rupeeWords(tpl.confirmedCtc);
    vals.probationMonths = String(tpl.traineeMonths || 3);
    vals.workingHours = tpl.workingHours || '';
  }
  const why = (missing) => [...new Set(missing.map((k) => k.replace(/Words$/, '')))].map((k) => (k === 'monthlySalary' ? 'trainee stipend not written in the editor' : k === 'confirmedCtc' ? 'annual CTC on confirmation not written in the editor' : k === 'workingHours' ? 'working hours not written in the editor' : `no ${k} on file`)).join(', ');
  // the details the reference letter prints in bold (name, designation, department, company, dates, amounts) carry a bold mark
  // in the letter's body; the renderers turn it into bold, the plain text drops it
  const bold = { ...vals };
  BOLD_TOKENS.forEach((k) => { if (bold[k] != null && String(bold[k]).trim() !== '') bold[k] = `${B_ON}${bold[k]}${B_OFF}`; });
  const omitted = [];
  const details = [];
  (tpl.details || []).forEach((row) => {
    const v = fillLine(row.value, bold);
    if (v.skip) omitted.push(`${row.label} (${why(v.missing)})`); else details.push({ label: fillPlain(row.label, vals), value: v.text });
  });
  const terms = [];
  (tpl.terms || []).forEach((row) => {
    const v = fillLine(row.text, bold);
    const title = fillPlain(row.title, vals);
    if (v.skip) omitted.push(`${title || 'A term'} (${why(v.missing)})`); else terms.push({ title, text: v.text });
  });
  return {
    company,
    refNo: vals.refNo,
    dateLong: vals.offerDate,
    to: { name: vals.name, place: vals.location },
    title: fillPlain(tpl.title, vals),
    subjectLine: `${fillPlain(tpl.title, vals)}${vals.designation ? ` - ${vals.designation}` : ''}`,
    coverNote: fillPlain(tpl.coverNote, vals),
    intro: fillPlain(tpl.intro, bold),
    details,
    termsHeading: fillPlain(tpl.termsHeading, vals),
    terms,
    closing: fillPlain(tpl.closing, bold),
    signatory: { name: fillPlain(tpl.signatoryName, vals), title: fillPlain(tpl.signatoryTitle, vals), company: company.name },
    acceptance: { line: fillPlain(tpl.acceptanceLine, vals), name: vals.name },
    footerNote: fillPlain(tpl.footerNote, vals),
    subject: fillPlain(tpl.subject, vals),
    vals,
    omitted,
  };
}

// --- THE LAYOUT: the founder's reference offer letter (Offer_Letter_Teamlink_Divyasri.docx, 2026-11-23) ----------------------
// Plain black text, the key details in bold: OFFER LETTER (centred) / Date (right) / To, NAME, place / Dear NAME, / the opening
// paragraph / the points as bullets with a bold heading (a point written on several lines = a bold heading and its own bullets) /
// the welcome line / "Yours sincerely, For <company>, signature line, signatory" on the left and "Acceptance of Offer, signature
// line, Signature of Candidate, Date" on the right. No colours, boxes or reference number in the letter itself.
// "Date of Appointment:" - a point's heading ends with a colon, unless it already ends in . : ? !
const termLabel = (title) => (/[.:?!]$/.test(String(title).trim()) ? String(title).trim() : `${String(title).trim()}:`);
const listLines = (text) => String(text || '').split('\n').map((l) => l.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean);
const SIGN_LINE = '______________________';

// --- the HTML (the mail itself, and the preview on screen) -----------------------------------------------------------------
const hRuns = (s) => esc(s).replace(BOLD_RE, '<b>$1</b>'); // esc leaves the bold marks alone
const para = (text, mb = 12) => String(text || '').split(/\n{2,}/).map((p) => `<p style="margin:0 0 ${mb}px 0;line-height:1.5">${hRuns(p).replace(/\n/g, '<br>')}</p>`).join('');
function renderHtml(m, { logoSrc = null, withCover = true } = {}) {
  const font = "Calibri,Carlito,'Segoe UI',Arial,Helvetica,sans-serif";
  const ul = (items) => `<ul style="margin:0 0 10px 0;padding-left:24px">${items.map((i) => `<li style="margin:0 0 6px 0;line-height:1.5">${i}</li>`).join('')}</ul>`;
  // the points: one-line points share a bullet list; a point written on several lines is a bold heading and its own list
  const blocks = [];
  let run = [];
  const flush = () => { if (run.length) blocks.push(ul(run)); run = []; };
  m.terms.forEach((t) => {
    if (t.text.includes('\n')) {
      flush();
      if (t.title) blocks.push(`<p style="margin:12px 0 8px 0;line-height:1.5"><b>${esc(termLabel(t.title))}</b></p>`);
      blocks.push(ul(listLines(t.text).map(hRuns)));
    } else run.push(`${t.title ? `<b>${esc(termLabel(t.title))}</b> ` : ''}${hRuns(t.text)}`);
  });
  flush();
  const details = m.details.map((r) => `<p style="margin:0 0 6px 0;line-height:1.5"><b>${esc(termLabel(r.label))}</b> ${hRuns(r.value)}</p>`).join('');
  const cover = withCover && (logoSrc || m.coverNote)
    ? `<div style="font-size:14px;line-height:1.6;color:#222;padding:0 4px 18px 4px">${logoSrc ? `<img src="${esc(logoSrc)}" alt="${esc(m.company.name)}" height="36" style="display:block;height:36px;width:auto;border:0;margin:0 0 14px 0">` : ''}${m.coverNote ? para(m.coverNote) : ''}</div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.subjectLine)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:${font};color:#000">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:22px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px"><tr><td>
${cover}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d9dce1"><tr><td style="padding:44px 48px 40px 48px;font-family:${font};font-size:15px;color:#000">
<div style="text-align:center;font-size:24px;font-weight:700;margin:0 0 26px 0">${esc(m.title.toUpperCase())}</div>
<div style="text-align:right;font-weight:700;margin:0 0 18px 0">Date: ${esc(m.dateLong)}</div>
<div style="margin:0 0 18px 0;line-height:1.5"><b>To,</b><br><b>${esc(m.to.name)}</b>${m.to.place ? `<br>${esc(m.to.place)}` : ''}</div>
${para(m.intro)}
${details}
${m.termsHeading && m.terms.length ? `<p style="margin:6px 0 8px 0"><b>${esc(m.termsHeading)}</b></p>` : ''}
${blocks.join('')}
${m.closing ? `<div style="margin:14px 0 30px 0">${para(m.closing, 0)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  <td width="50%" style="vertical-align:top;line-height:1.5;font-size:15px">Yours sincerely,<br><b>For ${esc(m.signatory.company)}</b><br><br><br>${SIGN_LINE}<br><b>${esc(m.signatory.name || 'Authorized Signatory')}</b>${m.signatory.title ? `<br>${esc(m.signatory.title)}` : ''}</td>
  <td width="50%" style="vertical-align:top;text-align:right;line-height:1.5;font-size:15px">Acceptance of Offer${m.acceptance.line ? `<br><span style="font-size:13px">${esc(m.acceptance.line)}</span>` : ''}<br><br><br>${SIGN_LINE}<br><b>Signature of Candidate</b><br>Date: ______________</td>
</tr></table>
${m.footerNote ? `<div style="margin-top:26px;font-size:11px;color:#666;text-align:center">${esc(m.footerNote)}</div>` : ''}
</td></tr></table>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function renderText(m) {
  const lines = [];
  if (m.coverNote) lines.push(m.coverNote, '', '------------------------------------------------------------', '');
  lines.push(m.title.toUpperCase(), '', `Date: ${m.dateLong}`, '', 'To,', m.to.name, ...(m.to.place ? [m.to.place] : []), '', unmark(m.intro), '');
  m.details.forEach((r) => lines.push(`${termLabel(r.label)} ${unmark(r.value)}`));
  if (m.details.length) lines.push('');
  if (m.terms.length && m.termsHeading) lines.push(m.termsHeading);
  m.terms.forEach((t) => {
    if (t.text.includes('\n')) { if (t.title) lines.push('', termLabel(t.title)); listLines(t.text).forEach((l) => lines.push(`• ${unmark(l)}`)); } else lines.push(`• ${t.title ? `${termLabel(t.title)} ` : ''}${unmark(t.text)}`);
  });
  if (m.terms.length) lines.push('');
  if (m.closing) lines.push(unmark(m.closing), '');
  lines.push('Yours sincerely,', `For ${m.signatory.company}`, '', SIGN_LINE, m.signatory.name || 'Authorized Signatory', ...(m.signatory.title ? [m.signatory.title] : []));
  lines.push('', 'Acceptance of Offer', ...(m.acceptance.line ? [m.acceptance.line] : []), '', SIGN_LINE, `Signature of Candidate (${m.acceptance.name})`, 'Date: ______________');
  if (m.footerNote) lines.push('', m.footerNote);
  return lines.join('\n');
}

// --- the PDF (pdfkit, A4; Helvetica stands in for Calibri, which a Linux server does not have) ------------------------------
let logoCache = null;
async function logoPng() {
  if (logoCache !== null) return logoCache || null;
  try {
    // eslint-disable-next-line global-require
    const { LOGO } = require('./agreementPdf');
    if (!fs.existsSync(LOGO)) { logoCache = false; return null; }
    // eslint-disable-next-line global-require
    logoCache = await require('sharp')(LOGO).resize({ width: 560, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch { logoCache = false; }
  return logoCache || null;
}

async function renderPdf(m) {
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { pdfText } = require('./agreementPdf'); // eslint-disable-line global-require
  const t = (v) => pdfText(v);
  const SIZE = 10.5;
  const GAP = 3; // about the reference's 1.25 line spacing
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 64, bottom: 60, left: 66, right: 66 }, bufferPages: true,
      info: { Title: t(`${m.title} - ${m.to.name}`), Author: t(m.company.name), Subject: t(m.subjectLine) },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    const need = (h) => { if (doc.y + h > bottomLimit()) doc.addPage(); };
    const font = (b) => doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(SIZE).fillColor('#000');
    // one paragraph of plain and bold runs; pdfkit drops a space at the START of a continued run, so spaces stay at run ends
    const runsText = (runs, x, width, opts = {}) => {
      const rs = runs.map((r) => ({ ...r })).filter((r) => r.t !== '');
      for (let i = 1; i < rs.length; i += 1) {
        const lead = rs[i].t.match(/^[\s,.;:!?)]+/); // spaces and punctuation stay with the run before (pdfkit sets a gap before a lone ",")
        if (lead) { rs[i - 1].t += lead[0]; rs[i].t = rs[i].t.slice(lead[0].length); }
      }
      const kept = rs.filter((r) => r.t !== '');
      rs.length = 0; rs.push(...kept);
      if (!rs.length) return;
      rs.forEach((r, i) => {
        font(r.b);
        const o = { width, lineGap: GAP, ...opts, continued: i < rs.length - 1 };
        if (i === 0) doc.text(t(r.t), x, doc.y, o); else doc.text(t(r.t), o);
      });
      doc.x = L;
    };
    const heightOfRuns = (runs, width) => { font(false); return doc.heightOfString(t(runs.map((r) => r.t).join('')), { width, lineGap: GAP }); };
    const paragraphs = (text, after = 0.75) => String(text || '').split(/\n{2,}/).forEach((p) => {
      const runs = runsOf(p);
      need(Math.min(heightOfRuns(runs, W), 60));
      runsText(runs, L, W);
      doc.moveDown(after);
    });
    const bullet = (runs) => {
      need(Math.min(heightOfRuns(runs, W - 22), 50) + 4);
      const y = doc.y;
      font(false).text('•', L + 6, y, { width: 12, lineGap: GAP });
      doc.y = y;
      runsText(runs, L + 22, W - 22);
      doc.moveDown(0.35);
    };

    // title, date, addressee
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#000').text(t(m.title.toUpperCase()), L, doc.y, { width: W, align: 'center' });
    doc.moveDown(1.3);
    font(true).text(t(`Date: ${m.dateLong}`), L, doc.y, { width: W, align: 'right' });
    doc.moveDown(1.1);
    font(true).text('To,', L, doc.y, { width: W, lineGap: GAP });
    font(true).text(t(m.to.name), L, doc.y, { width: W, lineGap: GAP });
    if (m.to.place) font(false).text(t(m.to.place), L, doc.y, { width: W, lineGap: GAP });
    doc.moveDown(1.1);

    // body
    paragraphs(m.intro);
    m.details.forEach((r) => { runsText([{ t: `${termLabel(r.label)} `, b: true }, ...runsOf(r.value)], L, W); doc.moveDown(0.3); });
    if (m.details.length) doc.moveDown(0.4);
    if (m.termsHeading && m.terms.length) { font(true).text(t(m.termsHeading), L, doc.y, { width: W }); doc.moveDown(0.5); }
    m.terms.forEach((x) => {
      if (x.text.includes('\n')) {
        doc.moveDown(0.3);
        if (x.title) { need(40); font(true).text(t(termLabel(x.title)), L, doc.y, { width: W, lineGap: GAP }); doc.moveDown(0.4); }
        listLines(x.text).forEach((line) => bullet(runsOf(line)));
      } else bullet([...(x.title ? [{ t: `${termLabel(x.title)} `, b: true }] : []), ...runsOf(x.text)]);
    });
    doc.moveDown(0.6);

    // the welcome line, then the signature (left) and the acceptance (right), kept together on one page
    const closingH = m.closing ? heightOfRuns(runsOf(m.closing), W) + 16 : 0;
    font(false);
    const accH = m.acceptance.line ? doc.heightOfString(t(m.acceptance.line), { width: W / 2 - 10 }) : 0;
    need(closingH + 120 + accH);
    if (m.closing) { paragraphs(m.closing, 1.6); }
    const top = doc.y;
    const colW = W / 2 - 10;
    const lineH = SIZE + GAP + 2.5;
    // left: Yours sincerely, / For company / (space) / ____ / signatory / title
    font(false).text('Yours sincerely,', L, top, { width: colW });
    font(true).text(t(`For ${m.signatory.company}`), L, doc.y, { width: colW });
    const leftHead = doc.y;
    font(false);
    const rightHead = top + lineH + (m.acceptance.line ? doc.heightOfString(t(m.acceptance.line), { width: colW }) : 0);
    const signY = Math.max(leftHead, rightHead) + lineH * 2; // both signature lines on one row, as in the reference
    font(false).text(SIGN_LINE, L, signY, { width: colW });
    font(true).text(t(m.signatory.name || 'Authorized Signatory'), L, doc.y, { width: colW });
    if (m.signatory.title) font(false).text(t(m.signatory.title), L, doc.y, { width: colW });
    const leftEnd = doc.y;
    // right: Acceptance of Offer / (words) / (space) / ____ / Signature of Candidate / Date
    const R = L + W - colW;
    font(false).text('Acceptance of Offer', R, top, { width: colW, align: 'right' });
    if (m.acceptance.line) doc.font('Helvetica').fontSize(9).fillColor('#000').text(t(m.acceptance.line), R, doc.y, { width: colW, align: 'right' });
    font(false).text(SIGN_LINE, R, signY, { width: colW, align: 'right' });
    font(true).text('Signature of Candidate', R, doc.y, { width: colW, align: 'right' });
    font(false).text('Date: ______________', R, doc.y, { width: colW, align: 'right' });
    doc.y = Math.max(leftEnd, doc.y); doc.x = L;

    // the small print (only when the editor has some) and page numbers (only when the letter runs past one page)
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 40;
      if (m.footerNote) doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(t(m.footerNote), L, fy, { width: W * 0.75, lineBreak: false });
      if (range.count > 1) doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(`Page ${i - range.start + 1} of ${range.count}`, L + W * 0.75, fy, { width: W * 0.25, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// --- the once-per-joining table ---------------------------------------------------------------------------------------------
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "OfferLetterMail" (
      "applicationId" TEXT PRIMARY KEY, "candidateId" TEXT, "status" TEXT NOT NULL, "reason" TEXT, "joiningDate" TEXT, "trigger" TEXT,
      "toEmail" TEXT, "providerRef" TEXT, "sentAt" TEXT, "sentById" TEXT, "sentByName" TEXT, "auto" INTEGER NOT NULL DEFAULT 1,
      "sendCount" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`)
      .catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}
const q = async (sql, ...a) => { await ensureTable(); return prisma.$queryRawUnsafe(sql, ...a); };
const x = async (sql, ...a) => { await ensureTable(); return Number(await prisma.$executeRawUnsafe(sql, ...a)); };
async function rowOf(applicationId) { const r = await q('SELECT * FROM "OfferLetterMail" WHERE "applicationId" = ?', String(applicationId)); return r[0] || null; }

// Takes the right to send. true = this caller sends; false = somebody else has, or it is already sent.
async function claim(app, { auto, trigger, actor }) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const made = await x('INSERT OR IGNORE INTO "OfferLetterMail" ("applicationId","candidateId","status","joiningDate","trigger","auto","createdAt","updatedAt") VALUES (?,?,\'SENDING\',?,?,?,?,?)',
    app.id, app.candidateId, String(app.joiningDate || '').slice(0, 10), trigger, auto ? 1 : 0, now, now);
  if (made === 1) return true;
  // the row exists: an automatic send may retake a FAILED / SKIPPED / crashed one; a SENT one only a person's resend may
  const allowed = auto ? "(\"status\" IN ('FAILED','SKIPPED') OR (\"status\" = 'SENDING' AND \"updatedAt\" < ?))" : "(\"status\" IN ('FAILED','SKIPPED','SENT') OR (\"status\" = 'SENDING' AND \"updatedAt\" < ?))";
  const took = await x(`UPDATE "OfferLetterMail" SET "status" = 'SENDING', "trigger" = ?, "auto" = ?, "joiningDate" = ?, "updatedAt" = ? WHERE "applicationId" = ? AND ${allowed}`,
    trigger, auto ? 1 : 0, String(app.joiningDate || '').slice(0, 10), now, app.id, stale);
  return took === 1;
}
async function finish(applicationId, fields) {
  const keys = Object.keys(fields);
  await x(`UPDATE "OfferLetterMail" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, "updatedAt" = ? WHERE "applicationId" = ?`, ...keys.map((k) => fields[k]), new Date().toISOString(), String(applicationId));
}

// --- who may be sent to ----------------------------------------------------------------------------------------------------------
function isInternalHire(app) {
  // eslint-disable-next-line global-require
  return require('./joining').isInternalHire(app, app.requirement);
}
const DEAD_STAGES = ['REJECTED', 'HOLD'];

// What stops this application from getting the letter at all (not a switch): { code, why } | null.
function blocker(app) {
  if (!app) return { code: 'not_found', why: 'The application was not found.' };
  if (!isInternalHire(app)) return { code: 'client_job', why: 'This is a client placement: the client makes the offer letter, not TeamLink.' };
  if (DEAD_STAGES.includes(app.stage)) return { code: 'closed', why: 'This application is closed, so no offer letter is sent.' };
  if (!isDay(app.joiningDate)) return { code: 'no_date', why: 'Set the joining date first - the letter carries it.' };
  const c = app.candidate || {};
  if (skipTestPerson(c.name, c.email)) return { code: 'test_person', why: 'A test person is never mailed.' };
  if (c.doNotContact || c.consentStatus === 'WITHDRAWN') return { code: 'consent', why: 'The candidate asked not to be contacted, so no mail is sent.' };
  if (!c.email || !/^[^@\s]+@[^@\s]+$/.test(String(c.email).trim())) return { code: 'no_email', why: 'There is no email address on the candidate’s record. Add it, then press Send.' };
  return null;
}

// --- recording (the candidate's own timeline, Communications and the Audit Log; never the salary) ----------------------------
async function timelineEvent(app, actor, action, comment) {
  const r = app.requirement || {};
  try {
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: app.id, candidateId: app.candidateId, fromStage: app.stage, toStage: app.stage, action: String(action).slice(0, 240),
        comment: comment ? String(comment).slice(0, 1000) : null,
        actorUserId: actor && actor.id ? actor.id : null, actorName: (actor && actor.name) || 'TeamLink', actorRole: actor ? (actor.atsRole || actor.role || null) : null,
        actorSide: 'Internal', requirementId: app.requirementId, requirementTitle: r.title || null, clientId: r.clientId || null,
        clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
      },
    });
  } catch (e) { console.error('[offer-letter-mail] timeline:', e.message); } // eslint-disable-line no-console
}
async function messageRow(app, { status, detail, trigger, subject, actor, providerRef = null, sentAt = null, attempts = 0 }) {
  const c = app.candidate || {};
  const r = app.requirement || {};
  try {
    return await prisma.candidateMessage.create({
      data: {
        candidateId: app.candidateId, applicationId: app.id, channel: 'Email', template: TEMPLATE_PURPOSE, templateLabel: LABEL, trigger,
        recipient: c.email || '', subject: subject || null,
        // no salary here: staff who open Communications do not all see the salary
        body: `The offer letter for ${r.title || 'the job'}, joining ${longDay(app.joiningDate) || 'date to be confirmed'}, was sent as an email with the letter in the mail and attached as a PDF.`,
        status, statusDetail: String(detail || '').slice(0, 400),
        senderUserId: actor && actor.id ? actor.id : null, senderName: (actor && actor.name) || 'TeamLink',
        providerRef, sentAt, attempts, lastAttemptAt: attempts ? new Date() : null,
        lastError: status === 'FAILED' ? String(detail || '').slice(0, 400) : null,
      },
    });
  } catch (e) { console.error('[offer-letter-mail] message row:', e.message); return null; } // eslint-disable-line no-console
}
async function peopleToTell(app, actor) {
  const r = app.requirement || {};
  const ids = [actor && actor.id, r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim()), r.tlId].filter(Boolean);
  return [...new Set(ids)];
}

async function replyToFor(app, actor) {
  // answers to the mail ("I accept the offer") go to the person who runs this joining
  try {
    const CC = require('./candidateComms'); // eslint-disable-line global-require
    let user = actor && actor.id ? actor : null;
    if (!user) {
      const r = app.requirement || {};
      const uid = r.tlId || r.recruiterId || String(r.recruiterIds || '').split(',')[0].trim();
      if (uid) user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, name: true, email: true } });
    }
    if (!user) return {};
    const id = await CC.senderIdentity(user);
    return id.senderEmail ? { senderEmail: id.senderEmail, senderName: id.senderName } : {};
  } catch { return {}; }
}

// --- one real send --------------------------------------------------------------------------------------------------------------
async function deliver(app, { auto, trigger, actor }) {
  const settings = await loadSettings();
  const m = await buildModel(app, settings.template);
  const pdf = await renderPdf(m);
  const logo = await logoPng();
  const html = renderHtml(m, { logoSrc: logo ? 'cid:teamlink-logo' : null });
  const safe = String(m.to.name || 'Candidate').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Candidate';
  const reply = await replyToFor(app, actor);
  // eslint-disable-next-line global-require
  const out = await require('./mailer').sendMail({
    to: app.candidate.email.trim(), subject: m.subject, text: renderText(m), html,
    attachments: [
      { filename: `Offer-letter-${safe}.pdf`, content: pdf, contentType: 'application/pdf' },
      ...(logo ? [{ filename: 'teamlink-logo.png', content: logo, contentType: 'image/png', cid: 'teamlink-logo', contentDisposition: 'inline' }] : []),
    ],
    ...reply, useEmployeeFrom: false, fromName: 'TeamLink HR',
  });
  return { out, subject: m.subject, omitted: m.omitted, trigger, auto };
}

// The result a caller (the route, the tests) is told: { state, message, ... }
async function runSend(app, { auto, trigger, actor }) {
  const who = (actor && actor.name) || 'TeamLink';
  let res;
  try {
    res = await deliver(app, { auto, trigger, actor });
  } catch (e) {
    res = { out: { ok: false, error: `The letter could not be made: ${e.message}` }, subject: null, omitted: [] };
  }
  const ok = !!(res.out && res.out.ok);
  const now = new Date();
  if (ok) {
    await finish(app.id, { status: 'SENT', reason: null, toEmail: app.candidate.email.trim(), providerRef: res.out.providerRef || null, sentAt: now.toISOString(), sentById: actor && actor.id ? actor.id : null, sentByName: who, sendCount: Number((await rowOf(app.id)).sendCount || 0) + 1 });
    await messageRow(app, { status: 'SENT', detail: `Sent${res.out.deduped ? ' (not repeated: this address is shared by several logins)' : ''}.`, trigger: `${LABEL}: ${trigger}`, subject: res.subject, actor, providerRef: res.out.providerRef || null, sentAt: now, attempts: 1 });
    await timelineEvent(app, actor, auto ? 'Offer letter emailed to the candidate (automatic)' : 'Offer letter emailed to the candidate', `${trigger}. Letter in the mail and as a PDF.${res.omitted.length ? ` Left out for lack of details: ${res.omitted.join('; ')}.` : ''}`);
    await logAudit({ userId: actor && actor.id ? actor.id : null, actorName: actor ? undefined : 'TeamLink (automatic)', action: auto ? 'Offer letter emailed automatically' : 'Offer letter emailed', entity: 'Application', entityId: app.id, toValue: `Sent - ${trigger}`.slice(0, 200) });
    return { state: 'SENT', message: 'The offer letter was emailed to the candidate.', omitted: res.omitted, sentAt: now.toISOString() };
  }
  const why = String((res.out && (res.out.error || res.out.reason)) || 'The mail was not sent.').slice(0, 400);
  const notSetUp = !!(res.out && res.out.notConfigured);
  await finish(app.id, { status: 'FAILED', reason: why });
  await messageRow(app, { status: notSetUp ? 'NOT_SENT_NO_PROVIDER' : 'FAILED', detail: why, trigger: `${LABEL}: ${trigger}`, subject: res.subject, actor, attempts: notSetUp ? 0 : 1 });
  await timelineEvent(app, actor, 'Offer letter could NOT be emailed', `${why} Open the candidate’s Joining row and press Send offer letter to try again.`);
  await logAudit({ userId: actor && actor.id ? actor.id : null, actorName: actor ? undefined : 'TeamLink (automatic)', action: 'Offer letter email failed', entity: 'Application', entityId: app.id, toValue: why.slice(0, 200) });
  try {
    // eslint-disable-next-line global-require
    await require('./notify').notifyUsers(await peopleToTell(app, actor), {
      title: `⚠️ Offer letter not sent: ${(app.candidate && app.candidate.name) || 'Candidate'}`,
      message: `${why} Open Joining and press Send offer letter after fixing it.`,
      exceptUserId: auto ? undefined : (actor && actor.id),
    });
  } catch { /* a bell never blocks */ }
  return { state: 'FAILED', message: `The offer letter was not sent: ${why}`, omitted: res.omitted };
}

// --- the entry points -------------------------------------------------------------------------------------------------------------
// AUTOMATIC. Never throws; says what it did. { state: SENT | FAILED | SKIPPED | ALREADY | OFF | NOT_APPLICABLE, message }
async function maybeSendAuto(applicationId, { trigger = 'Joining date', actor = null } = {}) {
  try {
    const app = await loadApp(applicationId);
    const b = blocker(app);
    if (b && ['client_job', 'closed', 'not_found', 'test_person'].includes(b.code)) return { state: 'NOT_APPLICABLE', message: b.why };
    const settings = await loadSettings();
    if (!settings.enabled) return { state: 'OFF', message: 'The automatic offer letter is switched off.' };
    const prev = await rowOf(app.id);
    if (prev && prev.status === 'SENT') return { state: 'ALREADY', message: 'The offer letter was already sent for this joining.', sentAt: prev.sentAt };
    if (prev && prev.status === 'SENDING' && prev.updatedAt > new Date(Date.now() - STALE_MS).toISOString()) return { state: 'ALREADY', message: 'The offer letter is being sent right now.' };
    // blockers the candidate side decides (no date yet, no email, no consent): recorded so the person sees why, retried at the next trigger
    let skip = b ? b.why : null;
    if (!skip && !(await require('./interviewNotices').candidateEmailsOn())) skip = 'Candidate emails are switched off (Administration > Company Setup > Step timing), so the offer letter was held. Press Send offer letter to mail it yourself.'; // eslint-disable-line global-require
    if (skip) {
      if (b && b.code === 'no_date') return { state: 'SKIPPED', message: skip };
      const changed = !prev || prev.reason !== skip;
      if (!prev) await claim(app, { auto: true, trigger, actor }); // the row exists so the card can show the reason
      await finish(app.id, { status: 'SKIPPED', reason: skip });
      if (changed) {
        await timelineEvent(app, actor, 'Offer letter not sent yet', skip);
        await logAudit({ userId: actor && actor.id ? actor.id : null, actorName: actor ? undefined : 'TeamLink (automatic)', action: 'Offer letter held', entity: 'Application', entityId: app.id, toValue: skip.slice(0, 200) });
        if (b && b.code === 'no_email') {
          try { await require('./notify').notifyUsers(await peopleToTell(app, actor), { title: `⚠️ Offer letter not sent: ${(app.candidate && app.candidate.name) || 'Candidate'}`, message: skip }); } catch { /* none */ } // eslint-disable-line global-require
        }
      }
      return { state: 'SKIPPED', message: skip };
    }
    if (!(await claim(app, { auto: true, trigger, actor }))) return { state: 'ALREADY', message: 'The offer letter was already sent, or is being sent right now.' };
    return await runSend(app, { auto: true, trigger, actor });
  } catch (e) {
    console.error('[offer-letter-mail] automatic send:', e.message); // eslint-disable-line no-console
    return { state: 'FAILED', message: `The offer letter could not be started: ${e.message}` };
  }
}

// A PERSON presses Send / Send again. Needs no switch; consent, a missing address / date and test people still stop it.
async function sendNow(applicationId, actor, { trigger = 'Sent by hand' } = {}) {
  const app = await loadApp(applicationId);
  const b = blocker(app);
  if (b) return { state: 'BLOCKED', code: b.code, message: b.why, status: b.code === 'not_found' ? 404 : 409 };
  if (!(await claim(app, { auto: false, trigger, actor }))) return { state: 'BLOCKED', code: 'busy', message: 'The offer letter is being sent right now. Wait a moment.', status: 409 };
  const out = await runSend(app, { auto: false, trigger: `${trigger} by ${(actor && actor.name) || 'a team member'}`, actor });
  return { ...out, status: out.state === 'SENT' ? 200 : 409 };
}

// --- what the screens show -----------------------------------------------------------------------------------------------------
async function statusOf(applicationId) {
  const app = await loadApp(applicationId);
  if (!app) return null;
  const settings = await loadSettings();
  const row = await rowOf(app.id);
  const b = blocker(app);
  const masterOn = await require('./interviewNotices').candidateEmailsOn(); // eslint-disable-line global-require
  const changed = !!(row && row.status === 'SENT' && row.joiningDate && String(app.joiningDate || '').slice(0, 10) !== row.joiningDate);
  return {
    applicationId: app.id,
    applicable: !(b && ['client_job', 'closed'].includes(b.code)),
    notApplicableWhy: b && ['client_job', 'closed'].includes(b.code) ? b.why : null,
    canSend: !b,
    cannotSendWhy: b ? b.why : null,
    automatic: { enabled: settings.enabled, masterOn },
    state: row ? row.status : 'NOT_SENT',
    reason: row ? row.reason : null,
    sentAt: row ? row.sentAt : null,
    sentByName: row ? row.sentByName : null,
    wasAutomatic: row ? Number(row.auto) === 1 : null,
    sendCount: row ? Number(row.sendCount || 0) : 0,
    sentForJoiningDate: row ? row.joiningDate || null : null,
    joiningDateChangedSinceSent: changed,
    to: app.candidate && app.candidate.email ? app.candidate.email : null,
    joiningDate: app.joiningDate || null,
  };
}
async function previewOf(applicationId) {
  const app = await loadApp(applicationId);
  if (!app) return null;
  const settings = await loadSettings();
  const m = await buildModel(app, settings.template);
  const logo = await logoPng();
  return { html: renderHtml(m, { logoSrc: logo ? `data:image/png;base64,${logo.toString('base64')}` : null }), subject: m.subject, to: app.candidate ? app.candidate.email || null : null, omitted: m.omitted, blocker: blocker(app) };
}
async function pdfOf(applicationId) {
  const app = await loadApp(applicationId);
  if (!app) return null;
  const settings = await loadSettings();
  return { pdf: await renderPdf(await buildModel(app, settings.template)), name: `Offer-letter-${String((app.candidate && app.candidate.name) || 'candidate').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.pdf` };
}
// --- AN EMPLOYEE ADDED STRAIGHT IN HRMS (Employees -> Add employee, no application; 2026-11-23) ------------------------------
// The same letter, filled from the employee record: designation, department, place (branch / location + state), date of joining,
// reporting manager. Made by itself when HR adds a NEW joiner (joining date at most NEW_JOINER_DAYS ago, or still to come); an
// existing employee typed in later is not given a letter dated today. HR can still press "Make offer letter" on the documents.
const NEW_JOINER_DAYS = 30;
const OFFER_DOC_TYPE = 'Offer Letter';
const istDayOf = (d) => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : new Date(t + 330 * 60000).toISOString().slice(0, 10);
};
async function appFromEmployee(employee) {
  let tlId = null; // the reporting manager's login, so the "reporting manager" detail works as it does for a hire
  if (employee.reportingManagerId) {
    const mgr = await prisma.employee.findUnique({ where: { id: employee.reportingManagerId }, select: { userId: true } }).catch(() => null);
    tlId = (mgr && mgr.userId) || null;
  }
  const place = [employee.branch || employee.location || employee.city, employee.state].filter(Boolean).join(', ');
  return {
    id: employee.employeeCode || employee.id, // only the letter's reference uses it: TL/OL/<year>/<employee code>
    joiningDate: istDayOf(employee.dateOfJoining),
    offeredCtc: null,
    candidate: { name: employee.name || '', location: place },
    requirement: { title: employee.designation || '', department: employee.department || '', location: place, tlId },
  };
}
async function pdfForEmployee(employee) {
  const settings = await loadSettings();
  const m = await buildModel(await appFromEmployee(employee), settings.template);
  return { pdf: await renderPdf(m), name: `Offer-letter-${employee.employeeCode || 'employee'}.pdf`, omitted: m.omitted };
}
// Makes the letter and keeps it in the employee's documents. -> { state: 'MADE' | 'SKIPPED', message, omitted? }
// auto = the Add employee save (only a new joiner); without it = a person pressing "Make offer letter".
async function fileForEmployee(employee, actorId, { auto = false } = {}) {
  if (!employee) return { state: 'SKIPPED', message: 'The employee was not found.' };
  const joined = istDayOf(employee.dateOfJoining);
  if (!joined) return { state: 'SKIPPED', message: 'No date of joining on the record, so no offer letter was made. Add it, then press Make offer letter.' };
  if (!employee.designation) return { state: 'SKIPPED', message: 'No designation on the record, so no offer letter was made. Add it, then press Make offer letter.' };
  const oldest = new Date(Date.now() + 330 * 60000 - NEW_JOINER_DAYS * 86400000).toISOString().slice(0, 10);
  if (auto && joined < oldest) return { state: 'SKIPPED', message: `Joined more than ${NEW_JOINER_DAYS} days ago, so no offer letter was made by itself. Press Make offer letter on the documents if one is needed.` };
  const have = await prisma.employeeDocument.findFirst({ where: { employeeId: employee.id, docType: OFFER_DOC_TYPE } }).catch(() => null);
  if (have) return { state: 'SKIPPED', message: 'An offer letter is already in the documents.' };
  const made = await pdfForEmployee(employee);
  const { fileDocument } = require('./internalOnboarding'); // eslint-disable-line global-require
  await fileDocument(employee.id, OFFER_DOC_TYPE, made.pdf, made.name, actorId || null);
  await logAudit({ userId: actorId || null, action: `Offer letter made and kept in the documents${auto ? ' (automatic, new employee)' : ''}`, entity: 'Employee', entityId: employee.id, toValue: `${employee.name} (${employee.employeeCode})` });
  return { state: 'MADE', message: 'The offer letter was made and kept in the employee’s documents.', omitted: made.omitted };
}

// THE EMPLOYEE'S OWN DOWNLOAD (My Profile -> "Download offer letter", 2026-11-23): an employee may take their offer letter once
// (1) their profile is complete (the same 100% rule HR sees) and (2) their joining date has arrived (today or earlier).
// -> { ok: true } | { ok: false, why } (the plain words the screen shows)
function selfDownloadGate(employee, completionPct, today = istToday()) {
  const joined = istDayOf(employee && employee.dateOfJoining);
  if (!joined) return { ok: false, why: 'Your date of joining is not on your record yet. HR will add it.' };
  if (joined > today) return { ok: false, why: `Your offer letter can be downloaded from your joining date, ${joined.slice(8, 10)}-${joined.slice(5, 7)}-${joined.slice(0, 4)}.` };
  if (Number(completionPct) < 100) return { ok: false, why: `Complete your profile first (${Number(completionPct) || 0}% filled in). The offer letter unlocks at 100%.` };
  if (!employee.designation) return { ok: false, why: 'Your designation is not on your record yet. HR will add it.' };
  return { ok: true };
}

// The employee's OWN Documents list and file download: the Offer Letter HR / TeamLink made stays out of sight until My Profile would
// let them download it (selfDownloadGate), so "Your offer letter" is the one door and its rule always applies. HR always sees it, and
// so does a letter the employee uploaded themselves.
function offerLetterHiddenFromSelf({ isSelf, isHr, userId, doc, employee, completionPct }) {
  if (!isSelf || isHr || !doc || doc.docType !== OFFER_DOC_TYPE) return false;
  if (userId && doc.uploadedBy === userId) return false;
  return !selfDownloadGate(employee, completionPct).ok;
}

// "Email offer letter" (HR presses it on the employee's Documents): the offer letter that is ON FILE (the one made here, or an
// e-signed copy) goes to the employee as a PDF attachment, with a short covering note. It goes to the work email, or the personal
// one when there is no work email. -> { state: 'SENT', to } | { state: 'NOT_SENT', message }
async function emailForEmployee(employee, actor, { to: typedTo } = {}) {
  if (!employee) return { state: 'NOT_SENT', message: 'The employee was not found.' };
  const doc = await prisma.employeeDocument.findFirst({ where: { employeeId: employee.id, docType: OFFER_DOC_TYPE }, orderBy: { uploadedAt: 'desc' } }).catch(() => null);
  if (!doc) return { state: 'NOT_SENT', message: 'There is no offer letter on file. Press Make offer letter first.' };
  // HR may type another address (the work mailbox is not always the one the person reads): ONE address, checked here
  const typed = String(typedTo == null ? '' : typedTo).trim();
  if (typed && !/^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(typed)) return { state: 'NOT_SENT', message: `"${typed.slice(0, 80)}" is not a single, valid email address.` };
  const to = typed || String(employee.email || employee.personalEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(to)) return { state: 'NOT_SENT', message: 'There is no email address on this employee’s record. Type one, or add it to the record, then press Email offer letter.' };
  if (skipTestPerson(employee.name, to)) return { state: 'NOT_SENT', message: 'A test person is never mailed.' };
  const full = require('./attachments').resolveStored(doc.file); // eslint-disable-line global-require
  if (!full) return { state: 'NOT_SENT', message: 'The offer letter file could not be found on the server. Press Make offer letter again (delete the old one first).' };
  const company = (await companyOf()).name;
  const first = String(employee.name || '').trim().split(/\s+/)[0] || 'there';
  const subject = `Your offer letter${employee.designation ? ` - ${employee.designation}` : ''} at ${company}`;
  const text = [
    `Dear ${first},`, '',
    `Greetings from ${company}!`, '',
    'Your offer letter is attached as a PDF.', '',
    'To accept, please reply to this email with the words "I accept the offer", or sign the attached letter and send it back to us. If you have any question, just reply to this email and we will help you.', '',
    'Regards,', `HR, ${company}`,
  ].join('\n');
  const reply = await replyToFor({ requirement: {} }, actor);
  // eslint-disable-next-line global-require
  const out = await require('./mailer').sendMail({
    to, subject, text,
    attachments: [{ filename: doc.fileName || `Offer-letter-${employee.employeeCode || 'employee'}.pdf`, content: require('fs').readFileSync(full), contentType: doc.mime || 'application/pdf' }],
    ...reply, useEmployeeFrom: false, fromName: 'TeamLink HR',
  });
  if (!out || !out.ok) {
    const why = (out && out.error) || 'mail is not set up';
    // written down, so a send that did not go can be found later (who pressed it, which address, why); never the salary
    await logAudit({ userId: actor && actor.id ? actor.id : null, action: 'Offer letter email NOT sent', entity: 'Employee', entityId: employee.id, toValue: `${employee.name} (${employee.employeeCode}) <${to}>: ${String(why).slice(0, 300)}` }).catch(() => {});
    return { state: 'NOT_SENT', message: `The email was not sent: ${why}` };
  }
  // the audit log carries who and to which address, never the salary
  await logAudit({ userId: actor && actor.id ? actor.id : null, action: 'Offer letter emailed to the employee', entity: 'Employee', entityId: employee.id, toValue: `${employee.name} (${employee.employeeCode}) <${to}>${typed ? ' (address typed by HR)' : ''}` });
  return { state: 'SENT', to };
}

// The editor's preview: the Admin's unsaved wording filled with sample details.
async function previewTemplate(body) {
  const base = (await loadSettings()).template;
  const c = cleanTemplate({ ...base, ...(body && typeof body === 'object' ? body : {}) });
  if (c.error) return { error: c.error };
  const m = await buildModel(null, c.value, { sample: true });
  const logo = await logoPng();
  return { html: renderHtml(m, { logoSrc: logo ? `data:image/png;base64,${logo.toString('base64')}` : null }), subject: m.subject, omitted: m.omitted };
}

module.exports = {
  SETTINGS_KEY, TEMPLATE_PURPOSE, TOKENS, DEFAULT_TEMPLATE, LIMITS,
  loadSettings, setAutomatic, cleanTemplate, saveTemplate, resetTemplate,
  buildModel, renderHtml, renderText, renderPdf, valuesFor,
  maybeSendAuto, sendNow, statusOf, previewOf, pdfOf, previewTemplate, blocker, rowOf,
  pdfForEmployee, fileForEmployee, emailForEmployee, selfDownloadGate, offerLetterHiddenFromSelf, NEW_JOINER_DAYS,
};

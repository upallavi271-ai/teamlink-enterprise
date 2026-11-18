// ---------------------------------------------------------------------------
// THE OFFER LETTER, MAILED WITH THE JOINING DATE (founder 2026-11-17: "when a candidate receives a joining date mail then they have
// to receive an automatic offer letter through mail, so create a professional one").
//
// WHO GETS IT: a TeamLink INTERNAL HIRE (a new employee of TeamLink Consultants). For a client placement the CLIENT makes the offer
// and joining letters (utils/clientTrack.js), so nothing here is ever sent for one.
//
// WHAT GOES OUT: one email to the candidate with the letter in the mail itself (HTML) AND as a PDF (pdfkit, A4, the TeamLink logo).
// The wording is one editable template (Administration -> Company Setup -> Message templates -> Offer letter); every {{placeholder}}
// is filled from the application / candidate / job. A line that needs a detail nobody has (no reporting manager, no CTC on file)
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
// the team lead get a bell. The CTC is printed ONLY inside the letter that goes to the candidate and to staff who may open Offers.
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
  { key: 'joiningDate', label: 'Joining date', sample: '1 December 2026' },
  { key: 'joiningDay', label: 'Day of the week of joining', sample: 'Tuesday' },
  { key: 'ctc', label: 'Annual CTC (only if on file)', sample: '₹ 6,00,000 per annum' },
  { key: 'manager', label: 'Reporting manager (the job’s team lead)', sample: 'Ravi Kumar, Team Lead' },
  { key: 'company', label: 'Company name', sample: 'TeamLink Consultants' },
  { key: 'probationMonths', label: 'Probation (months)', sample: '6' },
  { key: 'offerDate', label: 'Date of this letter', sample: '17 November 2026' },
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
  title: 'Offer of Employment',
  intro: [
    'Dear {{name}},',
    '',
    'Further to your application and the discussions you had with us, we are pleased to offer you the position of {{designation}} at {{company}}, on the terms set out below.',
  ].join('\n'),
  showCtc: true,
  details: [
    { label: 'Designation', value: '{{designation}}' },
    { label: 'Department', value: '{{department}}' },
    { label: 'Date of joining', value: '{{joiningDate}} ({{joiningDay}})' },
    { label: 'Place of work', value: '{{location}}' },
    { label: 'Reporting to', value: '{{manager}}' },
    { label: 'Annual CTC', value: '{{ctc}}' },
  ],
  terms: [
    { title: 'Probation', text: 'You will be on probation for {{probationMonths}} months from your date of joining. Your employment will be confirmed in writing after a satisfactory review of your work and conduct.' },
    { title: 'Notice period', text: 'After confirmation, either you or the company may end the employment by giving 30 days’ written notice, or salary in lieu of the notice period. During probation, 7 days’ written notice from either side is enough.' },
    { title: 'Salary and benefits', text: 'Your annual cost to company (CTC) is {{ctc}}. Salary is paid every month into your bank account, after the deductions the law requires. Your detailed salary break-up is shared with you when you join.' },
    { title: 'Documents on your first day', text: 'Please bring the originals and one copy of: your ID proof (Aadhaar), PAN card, education certificates, experience / relieving letters from your earlier employers, two passport-size photographs and your bank account details.' },
    { title: 'Conduct and confidentiality', text: 'You will follow the policies of the company, and you will keep the information of the company and of its clients confidential, during your employment and after it.' },
    { title: 'Verification', text: 'This offer stands on the documents and details you gave us being true, and on a satisfactory verification of your background.' },
  ],
  closing: 'We look forward to welcoming you to {{company}} and wish you a long and rewarding career with us.',
  signatoryName: '',
  signatoryTitle: 'Human Resources',
  acceptanceLine: 'I have read and understood this offer letter, and I accept the offer on the terms above.',
  footerNote: 'This letter is confidential and meant only for {{name}}.',
};
const LIMITS = {
  subject: 200, coverNote: 3000, title: 80, intro: 2000, closing: 1000, signatoryName: 80, signatoryTitle: 120, acceptanceLine: 600, footerNote: 300,
  rowLabel: 60, rowValue: 200, termTitle: 80, termText: 1500, maxDetails: 12, maxTerms: 20,
};

// --- settings (one AppSetting row: { enabled, template }) ---------------------------------------------------------------
function parse(row) {
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return v && typeof v === 'object' ? v : {};
}
async function loadSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  const v = parse(row);
  return {
    enabled: v.enabled === true,
    template: { ...DEFAULT_TEMPLATE, ...(v.template && typeof v.template === 'object' ? v.template : {}) },
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
  const value = {
    subject: s(b.subject, LIMITS.subject),
    coverNote: s(b.coverNote, LIMITS.coverNote),
    title: s(b.title, LIMITS.title),
    intro: s(b.intro, LIMITS.intro),
    showCtc: b.showCtc !== false,
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
  const all = [value.subject, value.coverNote, value.intro, value.closing, value.acceptanceLine, value.footerNote, value.signatoryName, value.signatoryTitle,
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
    joiningDate: longDay(app.joiningDate),
    joiningDay: longDay(app.joiningDate, { day: undefined, month: undefined, year: undefined, weekday: 'long' }),
    ctc: tpl.showCtc === false ? '' : inr(app.offeredCtc),
    manager: await managerOf(r),
    company: company.name,
    probationMonths: String(Number(process.env.PROBATION_MONTHS) || 6),
    offerDate: longDay(istToday()),
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

// The whole letter as data; the HTML, the text and the PDF are all drawn from this.
async function buildModel(app, tpl, { sample = false } = {}) {
  const company = await companyOf();
  const vals = sample ? sampleValues() : await valuesFor(app, tpl);
  if (sample) vals.company = company.name;
  if (sample && tpl.showCtc === false) vals.ctc = '';
  const omitted = [];
  const details = [];
  (tpl.details || []).forEach((row) => {
    const v = fillLine(row.value, vals);
    if (v.skip) omitted.push(`${row.label} (no ${v.missing.join(', ')} on file)`); else details.push({ label: fillPlain(row.label, vals), value: v.text });
  });
  const terms = [];
  (tpl.terms || []).forEach((row) => {
    const v = fillLine(row.text, vals);
    const title = fillPlain(row.title, vals);
    if (v.skip) omitted.push(`${title || 'A term'} (no ${v.missing.join(', ')} on file)`); else terms.push({ title, text: v.text });
  });
  return {
    company,
    refNo: vals.refNo,
    dateLong: vals.offerDate,
    to: { name: vals.name, place: vals.location },
    title: fillPlain(tpl.title, vals),
    subjectLine: `${fillPlain(tpl.title, vals)}${vals.designation ? ` - ${vals.designation}` : ''}`,
    coverNote: fillPlain(tpl.coverNote, vals),
    intro: fillPlain(tpl.intro, vals),
    details,
    terms,
    closing: fillPlain(tpl.closing, vals),
    signatory: { name: fillPlain(tpl.signatoryName, vals), title: fillPlain(tpl.signatoryTitle, vals), company: company.name },
    acceptance: { line: fillPlain(tpl.acceptanceLine, vals), name: vals.name },
    footerNote: fillPlain(tpl.footerNote, vals),
    subject: fillPlain(tpl.subject, vals),
    vals,
    omitted,
  };
}

// --- the HTML (the mail itself, and the preview on screen) -----------------------------------------------------------------
const para = (text) => String(text || '').split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px 0">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
function renderHtml(m, { logoSrc = null, withCover = true } = {}) {
  const fontStack = "'Segoe UI',Calibri,Arial,Helvetica,sans-serif";
  const head = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:3px solid ${NAVY};padding-bottom:14px"><tr>
      <td style="vertical-align:middle">${logoSrc ? `<img src="${esc(logoSrc)}" alt="${esc(m.company.name)}" height="40" style="display:block;height:40px;width:auto;border:0">` : `<div style="font-size:20px;font-weight:700;color:${NAVY}">${esc(m.company.name)}</div>`}</td>
      <td style="vertical-align:middle;text-align:right;font-size:12px;line-height:1.5;color:${MUTED}">
        <div style="font-weight:700;color:${NAVY};font-size:13px">${esc(m.company.name)}</div>
        ${m.company.address ? `<div>${esc(m.company.address)}</div>` : ''}
        ${m.company.phone || m.company.email ? `<div>${[m.company.phone, m.company.email].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ')}</div>` : ''}
      </td></tr></table>`;
  const rows = m.details.map((r) => `<tr><td style="padding:9px 12px;width:34%;background:#eef1f7;border:1px solid #d5dbe5;font-size:13px;font-weight:600;color:${NAVY}">${esc(r.label)}</td><td style="padding:9px 12px;border:1px solid #d5dbe5;font-size:14px;color:#111">${esc(r.value)}</td></tr>`).join('');
  const terms = m.terms.map((t, i) => `<tr><td style="vertical-align:top;width:26px;padding:0 0 12px 0;font-size:14px;font-weight:700;color:${NAVY}">${i + 1}.</td><td style="padding:0 0 12px 0;font-size:14px;line-height:1.6;color:#222">${t.title ? `<b style="color:${NAVY}">${esc(t.title)}.</b> ` : ''}${esc(t.text).replace(/\n/g, '<br>')}</td></tr>`).join('');
  const cover = withCover && m.coverNote
    ? `<div style="font-size:14px;line-height:1.65;color:#222;padding:0 4px 18px 4px">${para(m.coverNote)}</div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.subjectLine)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:${fontStack};color:#222">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9"><tr><td align="center" style="padding:22px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px"><tr><td>
${cover}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #d5dbe5;border-radius:6px"><tr><td style="padding:30px 36px 28px 36px">
${head}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 4px 0"><tr>
  <td style="font-size:12px;color:${MUTED}">Ref: <b style="color:#111">${esc(m.refNo)}</b></td>
  <td style="font-size:12px;color:${MUTED};text-align:right">Date: <b style="color:#111">${esc(m.dateLong)}</b></td></tr></table>
<div style="margin:14px 0 2px 0;font-size:13px;color:#111;line-height:1.5"><b>${esc(m.to.name)}</b>${m.to.place ? `<br>${esc(m.to.place)}` : ''}</div>
<h1 style="margin:22px 0 4px 0;font-size:21px;letter-spacing:.6px;text-transform:uppercase;color:${NAVY};text-align:center;font-weight:700">${esc(m.title)}</h1>
<div style="height:2px;width:64px;background:${NAVY};margin:6px auto 20px auto"></div>
<div style="font-size:14px;line-height:1.65;color:#222">${para(m.intro)}</div>
${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 20px 0">${rows}</table>` : ''}
${terms ? `<div style="font-size:15px;font-weight:700;color:${NAVY};margin:6px 0 10px 0">Terms of employment</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${terms}</table>` : ''}
${m.closing ? `<div style="font-size:14px;line-height:1.65;color:#222;margin-top:6px">${para(m.closing)}</div>` : ''}
<div style="margin-top:18px;font-size:14px;color:#222;line-height:1.5">Yours sincerely,<br><b>For ${esc(m.signatory.company)}</b>
  <div style="height:46px"></div>
  <div style="border-top:1px solid #8b93a3;width:230px;padding-top:5px">${m.signatory.name ? `<b>${esc(m.signatory.name)}</b><br>` : ''}${esc(m.signatory.title)}</div></div>
${m.acceptance.line ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;border:1px solid #c3cbdb;border-radius:4px;background:#f8f9fc"><tr><td style="padding:16px 18px">
  <div style="font-size:13px;font-weight:700;color:${NAVY};text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Acceptance</div>
  <div style="font-size:13px;line-height:1.6;color:#222">${esc(m.acceptance.line)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;font-size:12px;color:${MUTED}"><tr>
    <td width="40%" style="border-top:1px solid #8b93a3;padding-top:4px">Name: ${esc(m.acceptance.name)}</td><td width="4%"></td>
    <td width="32%" style="border-top:1px solid #8b93a3;padding-top:4px">Signature</td><td width="4%"></td>
    <td width="20%" style="border-top:1px solid #8b93a3;padding-top:4px">Date</td></tr></table>
</td></tr></table>` : ''}
${m.footerNote ? `<div style="margin-top:22px;border-top:1px solid #d5dbe5;padding-top:10px;font-size:11px;color:${MUTED};text-align:center">${esc(m.footerNote)}</div>` : ''}
</td></tr></table>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function renderText(m) {
  const lines = [];
  if (m.coverNote) lines.push(m.coverNote, '', '------------------------------------------------------------', '');
  lines.push(m.company.name.toUpperCase());
  if (m.company.address) lines.push(m.company.address);
  lines.push('', `Ref: ${m.refNo}`, `Date: ${m.dateLong}`, '', m.to.name, ...(m.to.place ? [m.to.place] : []), '', m.title.toUpperCase(), '', m.intro, '');
  m.details.forEach((r) => lines.push(`${r.label}: ${r.value}`));
  if (m.details.length) lines.push('');
  if (m.terms.length) lines.push('TERMS OF EMPLOYMENT');
  m.terms.forEach((t, i) => lines.push(`${i + 1}. ${t.title ? `${t.title}. ` : ''}${t.text}`));
  if (m.terms.length) lines.push('');
  if (m.closing) lines.push(m.closing, '');
  lines.push('Yours sincerely,', `For ${m.signatory.company}`, '', ...(m.signatory.name ? [m.signatory.name] : []), m.signatory.title);
  if (m.acceptance.line) lines.push('', 'ACCEPTANCE', m.acceptance.line, `Name: ${m.acceptance.name}`);
  return lines.join('\n');
}

// --- the PDF (pdfkit; the same helpers as the agreement / joining letter) ---------------------------------------------------
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
  const logo = await logoPng();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 48, bottom: 64, left: 58, right: 58 }, bufferPages: true,
      info: { Title: t(`${m.title} - ${m.to.name}`), Author: t(m.company.name), Subject: t(m.subjectLine) },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    const need = (h) => { if (doc.y + h > bottomLimit()) doc.addPage(); };

    // letterhead
    const top = doc.y;
    if (logo) { try { doc.image(logo, L, top, { height: 36 }); } catch { /* optional */ } } else { doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text(t(m.company.name), L, top, { width: W / 2 }); }
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(t(m.company.name), L + W / 2, top, { width: W / 2, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    if (m.company.address) doc.text(t(m.company.address), L + W / 2, doc.y, { width: W / 2, align: 'right' });
    const contact = [m.company.phone, m.company.email].filter(Boolean).join('  |  ');
    if (contact) doc.text(t(contact), L + W / 2, doc.y, { width: W / 2, align: 'right' });
    const ruleY = Math.max(doc.y, top + 38) + 8;
    doc.moveTo(L, ruleY).lineTo(L + W, ruleY).lineWidth(2).strokeColor(NAVY).stroke();
    doc.y = ruleY + 14; doc.x = L;

    // reference and date
    const refY = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Ref: ', L, refY, { continued: true, lineBreak: false }).font('Helvetica-Bold').fillColor('#111').text(t(m.refNo), { lineBreak: false });
    // the date is placed by its measured width (a right-aligned "continued" run overprints)
    doc.font('Helvetica-Bold').fontSize(9);
    const dateW = doc.widthOfString(t(m.dateLong));
    doc.font('Helvetica').fontSize(9);
    const labelW2 = doc.widthOfString('Date: ');
    doc.fillColor(MUTED).text('Date: ', L + W - dateW - labelW2, refY, { lineBreak: false });
    doc.font('Helvetica-Bold').fillColor('#111').text(t(m.dateLong), L + W - dateW, refY, { lineBreak: false });
    doc.y = refY + 12; doc.x = L;
    doc.moveDown(0.9);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111').text(t(m.to.name), L, doc.y, { width: W });
    if (m.to.place) doc.font('Helvetica').fontSize(10).fillColor('#333').text(t(m.to.place), { width: W });

    // title
    doc.moveDown(1.1);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text(t(m.title.toUpperCase()), L, doc.y, { width: W, align: 'center', characterSpacing: 0.8 });
    const uy = doc.y + 3;
    doc.moveTo(L + W / 2 - 32, uy).lineTo(L + W / 2 + 32, uy).lineWidth(1.6).strokeColor(NAVY).stroke();
    doc.y = uy + 12; doc.x = L;

    const body = (text, size = 10.5) => String(text || '').split(/\n{2,}/).forEach((p) => {
      doc.font('Helvetica').fontSize(size).fillColor('#222').text(t(p), L, doc.y, { width: W, lineGap: 2.4 });
      doc.moveDown(0.55);
    });
    body(m.intro);

    // details table
    if (m.details.length) {
      doc.moveDown(0.2);
      const labelW = 150;
      m.details.forEach((r) => {
        doc.font('Helvetica-Bold').fontSize(9.5);
        const h1 = doc.heightOfString(t(r.label), { width: labelW - 20 });
        doc.font('Helvetica').fontSize(10.5);
        const h2 = doc.heightOfString(t(r.value), { width: W - labelW - 20 });
        const h = Math.max(h1, h2) + 14;
        need(h + 2);
        const y = doc.y;
        doc.rect(L, y, labelW, h).fillAndStroke('#eef1f7', '#d5dbe5');
        doc.rect(L + labelW, y, W - labelW, h).fillAndStroke('#ffffff', '#d5dbe5');
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text(t(r.label), L + 10, y + 7, { width: labelW - 20 });
        doc.font('Helvetica').fontSize(10.5).fillColor('#111').text(t(r.value), L + labelW + 10, y + 7, { width: W - labelW - 20 });
        doc.y = y + h; doc.x = L;
      });
      doc.moveDown(1);
    }

    // terms
    if (m.terms.length) {
      need(60);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Terms of employment', L, doc.y, { width: W });
      doc.moveDown(0.5);
      m.terms.forEach((x, i) => {
        doc.font('Helvetica').fontSize(10.5);
        const txt = `${x.title ? `${x.title}. ` : ''}${x.text}`;
        need(Math.min(doc.heightOfString(t(txt), { width: W - 22, lineGap: 2.4 }) + 8, 120));
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(`${i + 1}.`, L, y, { width: 20 });
        if (x.title) doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(t(`${x.title}. `), L + 22, y, { width: W - 22, continued: true, lineGap: 2.4 }).font('Helvetica').fillColor('#222').text(t(x.text), { lineGap: 2.4 });
        else doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(t(x.text), L + 22, y, { width: W - 22, lineGap: 2.4 });
        doc.moveDown(0.5); doc.x = L;
      });
    }
    // the closing line, the signature and the acceptance box stay together on one page
    doc.font('Helvetica').fontSize(10.5);
    const closingH = m.closing ? doc.heightOfString(t(m.closing), { width: W, lineGap: 2.4 }) + 12 : 0;
    need(closingH + (m.acceptance.line ? 270 : 130));
    if (m.closing) { doc.moveDown(0.3); body(m.closing); }
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text('Yours sincerely,', L, doc.y, { width: W });
    doc.font('Helvetica-Bold').text(t(`For ${m.signatory.company}`), { width: W });
    doc.moveDown(2.6);
    const sy = doc.y;
    doc.moveTo(L, sy).lineTo(L + 200, sy).lineWidth(0.8).strokeColor('#8b93a3').stroke();
    doc.y = sy + 4;
    if (m.signatory.name) doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111').text(t(m.signatory.name), L, doc.y, { width: W });
    doc.font('Helvetica').fontSize(10).fillColor('#333').text(t(m.signatory.title), L, doc.y, { width: W });

    if (m.acceptance.line) {
      doc.moveDown(1.6);
      const by = doc.y;
      doc.font('Helvetica').fontSize(10);
      const textH = doc.heightOfString(t(m.acceptance.line), { width: W - 28, lineGap: 2.4 });
      const boxH = textH + 86;
      doc.rect(L, by, W, boxH).fillAndStroke('#f8f9fc', '#c3cbdb');
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text('ACCEPTANCE', L + 14, by + 12, { width: W - 28, characterSpacing: 0.6 });
      doc.font('Helvetica').fontSize(10).fillColor('#222').text(t(m.acceptance.line), L + 14, by + 28, { width: W - 28, lineGap: 2.4 });
      const ly = by + textH + 64;
      const cols = [[L + 14, 190, `Name: ${m.acceptance.name}`], [L + 220, 150, 'Signature'], [L + 386, W - 400, 'Date']];
      cols.forEach(([x, w, label]) => {
        doc.moveTo(x, ly).lineTo(x + w, ly).lineWidth(0.8).strokeColor('#8b93a3').stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(t(label), x, ly + 3, { width: w });
      });
      doc.y = by + boxH + 6; doc.x = L;
    }

    // footer on every page (written below the bottom margin on purpose)
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 44;
      doc.moveTo(L, fy - 6).lineTo(L + W, fy - 6).lineWidth(0.5).strokeColor('#d5dbe5').stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
        .text(t(m.footerNote || `${m.company.name} - Private and confidential`), L, fy, { width: W * 0.7, lineBreak: false })
        .text(`Page ${i - range.start + 1} of ${range.count}`, L + W * 0.7, fy, { width: W * 0.3, align: 'right', lineBreak: false });
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
        // no salary here: staff who open Communications do not all see CTC
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
};

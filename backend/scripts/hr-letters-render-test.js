#!/usr/bin/env node
/**
 * THE HR LETTERS, RENDERED WITHOUT A DATABASE (2026-11-23): the offer letter (utils/offerLetterMail.js, the reference wording of
 * Offer_Letter_Teamlink_Divyasri.docx) and the exit letters (utils/exitLetters.js: service certificate + relieving letter).
 * Stand-in records replace the database, audit log, file store and checklist, so it runs anywhere pdfkit and sharp are installed.
 *   node scripts/hr-letters-render-test.js            (the PDFs are written to a temp folder, printed at the end)
 */
const path = require('path');
const fs = require('fs');

const SRC = process.argv[2] || path.resolve(__dirname, '..', 'src');
const OUT = process.argv[3] || fs.mkdtempSync(path.join(require('os').tmpdir(), 'hr-letters-'));
const state = { company: { name: 'TeamLink Consultants', legalName: null, email: 'hello@teamlink.test', phone: '+91 9032321414', address: 'Hyderabad, India', hq: '' }, settings: {}, docs: [], fnf: { status: 'Processed' }, detail: { resignationDate: '2026-10-01', approvedLastWorkingDate: '2026-11-14', designation: 'Team Leader' } };
const prisma = {
  // the LIVE company record as it was (2026-11-24): the short name, no legal name, the demo email, a real phone
  company: { findFirst: async () => state.company },
  appSetting: {
    findUnique: async ({ where }) => (state.settings[where.key] ? { value: state.settings[where.key], updatedByName: 'Test HR', updatedAt: new Date() } : null),
    upsert: async ({ where, create }) => { state.settings[where.key] = create.value; return {}; },
  },
  resignationDetail: { findUnique: async () => state.detail },
  fnfRequest: { findFirst: async () => state.fnf },
  employeeDocument: {
    findMany: async ({ where }) => state.docs.filter((d) => d.employeeId === where.employeeId && (!where.docType || (where.docType.in ? where.docType.in.includes(d.docType) : d.docType === where.docType))),
    create: async ({ data }) => { const d = { id: `doc${state.docs.length + 1}`, uploadedAt: new Date(), ...data }; state.docs.push(d); return d; },
    delete: async ({ where }) => { state.docs = state.docs.filter((d) => d.id !== where.id); },
  },
  user: { findUnique: async () => null, findMany: async () => [{ id: 'u1', name: 'Test HR' }] },
  employee: { findUnique: async () => null, update: async () => ({}) },
};
const stub = (rel, exp) => { const p = require.resolve(path.join(SRC, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('db.js', prisma);
const audits = [];
stub('utils/audit.js', { logAudit: async (a) => { audits.push(a.action); } });
stub('utils/attachments.js', { store: ({ data, filename }) => ({ billFile: `mem/${filename}`, billName: filename, billMime: 'application/pdf', billSize: data.length }), remove: () => {} });
const ticks = [];
stub('utils/exitChecklist.js', { tick: async (r, key) => { ticks.push(key); return { checklist: {} }; } });

let fails = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra).slice(0, 400)}`}`);
  if (!ok) fails += 1;
};
const parasText = (model) => model.paras.map((p) => p.map((r) => r.t).join('')).join('\n');

(async () => {
  // ---------------- offer letter
  const O = require(path.join(SRC, 'utils/offerLetterMail.js'));
  const s0 = await O.loadSettings();
  check('offer: starting template is Option 1: Date of Joining first, the documents point last, no heading', s0.template.terms[0].title === 'Date of Joining' && s0.template.terms[s0.template.terms.length - 1].title === 'Documents Required at Joining' && s0.template.termsHeading === '', s0.template.terms.map((x) => x.title));
  const legacyTpl = { ...O.DEFAULT_TEMPLATE };
  delete legacyTpl.termsHeading;
  state.settings['offer-letter-mail'] = JSON.stringify({ enabled: false, template: legacyTpl });
  check('offer: a letter saved before this change keeps its "Terms of employment" heading', (await O.loadSettings()).template.termsHeading === 'Terms of employment');
  delete state.settings['offer-letter-mail'];
  const c = O.cleanTemplate({ ...O.DEFAULT_TEMPLATE });
  check('offer: the starting template passes the editor checks (all placeholders known)', !c.error, c.error);

  const app = { id: 'cmapplication00a1b2c3', joiningDate: '2026-09-24', offeredCtc: null, candidate: { name: 'DIVYA SRI SIVATMIKA TONDAPU', location: 'Hyderabad, Telangana' }, requirement: { title: 'Internal HR', department: 'Human Resources', location: 'Hyderabad, Telangana', tlId: null } };
  const m = await O.buildModel(app, s0.template);
  const html = O.renderHtml(m);
  const text = O.renderText(m);
  check('offer: intro is the Option 1 opening paragraph', /interviews you attended, we are pleased to offer you the position of Internal HR in the Human Resources Department at Teamlink Consultants \[OPC\] Pvt\. Ltd\., based at our Corporate Office in Hyderabad, Telangana\. This offer is made on the following terms and conditions:/.test(m.intro.replace(/[\u0001\u0002]/g, '')), m.intro);
  check('offer: the reference bold details are bold in the letter (name, designation, department, company)', ['<b>DIVYA SRI SIVATMIKA TONDAPU</b>', '<b>Internal HR</b>', '<b>Human Resources</b>', '<b>Teamlink Consultants [OPC] Pvt. Ltd.</b>', '<b>₹10,000/- per month</b>', '<b>24 Sep 2026</b>'].every((x) => html.includes(x)), html.match(/Further.{0,300}/));
  check('offer: stipend and CTC in figures and in words', /₹10,000\/- per month \(Rupees Ten Thousand only\)/.test(text) && /₹3,00,000\/- per annum \(Rupees Three Lakhs only\)/.test(text), text.match(/stipend.{0,90}/));
  check('offer: the joining date is the first point, as a bullet, in the date style 24 Sep 2026', /• Date of Joining: 24 Sep 2026/.test(text), text.match(/Date of Joining.{0,40}/));
  check('offer: only the manager and working-hours points are left out (no manager on file, no hours typed); no {{ }} printed', m.omitted.every((x) => /no manager on file|working hours not written/.test(x)) && !/\{\{/.test(html + text), m.omitted);
  check('offer: reference layout: no heading, no reference number, To, / Acceptance of Offer / Signature of Candidate', !/Terms of employment/i.test(html) && !/Ref:/.test(html + text) && /<b>To,<\/b><br>/.test(html) && /Acceptance of Offer/.test(html) && /Signature of Candidate/.test(html) && /Date: 23 Nov 2026|Date: \d{1,2} [A-Z][a-z]{2} \d{4}/.test(html));
  check('offer: 13 bullet points, then the documents heading with its five bullets', (text.match(/^• /gm) || []).length === 18 && /\nDocuments Required at Joining:\n• Relieving/.test(text), text);
  const pdf = await O.renderPdf(m);
  check('offer: a real PDF', pdf.slice(0, 4).toString() === '%PDF' && pdf.length > 3000, pdf.length);
  fs.writeFileSync(path.join(OUT, 'offer-letter.pdf'), pdf);
  fs.writeFileSync(path.join(OUT, 'offer-letter.html'), html);
  const words = async (n) => (await O.buildModel(app, { ...s0.template, monthlySalary: n, confirmedCtc: n })).vals.monthlySalaryWords;
  const w = [await words(150000), await words(12500), await words(10000000), await words(100000)];
  check('offer: words for 1,50,000 / 12,500 / 1,00,00,000 / 1,00,000', w.join('|') === 'Rupees One Lakh Fifty Thousand only|Rupees Twelve Thousand Five Hundred only|Rupees One Crore only|Rupees One Lakh only', w);
  const noPay = await O.buildModel(app, { ...s0.template, showCtc: false });
  check('offer: "do not print the salary" leaves the stipend and CTC points out (and says why)', noPay.omitted.some((x) => /Trainee Period/.test(x)) && noPay.omitted.some((x) => /Confirmation/.test(x)) && !noPay.terms.some((x) => /Trainee Period|Confirmation/.test(x.title)), noPay.omitted);
  const legacyModel = await O.buildModel(app, { ...s0.template, termsHeading: 'Terms of employment' });
  check('offer: an editor heading is printed when set', /Terms of employment/.test(O.renderHtml(legacyModel)) && /\nTerms of employment\n/.test(O.renderText(legacyModel)));

  // ---------------- exit letters
  const X = require(path.join(SRC, 'utils/exitLetters.js'));
  const emp = { id: 'e1', name: 'Dara Mamatha', employeeCode: 'TL102', designation: 'Team Leader', dateOfJoining: new Date('2022-02-15T00:00:00Z'), branch: 'Hyderabad', state: 'Telangana', employmentStatus: 'Relieved' };
  const rec = { id: 'r1', type: 'RESIGNATION', status: 'Relieved', employeeId: 'e1', employee: emp, date: '2026-11-14' };
  const st = await X.statusOf(rec);
  check('exit: both letters ready for a relieved employee', st.letters.every((l) => l.ready), st.letters);
  const sv = await X.pdfFor(rec, 'service');
  const svText = parasText(sv.model);
  check('service: reference wording, dates and code', /This is to certify that Dara Mamatha \(Employee Code: TL102\) was employed with Teamlink Consultants \[OPC\] Pvt\. Ltd\. as Team Leader from 15 February 2022 to 14 November 2026\./.test(svText) && /on their own accord/.test(svText), svText);
  check('service: a real PDF', sv.pdf.slice(0, 4).toString() === '%PDF', sv.pdf.length);
  fs.writeFileSync(path.join(OUT, 'service-certificate.pdf'), sv.pdf);
  const rl = await X.pdfFor(rec, 'relieving');
  const rlText = parasText(rl.model);
  check('relieving: reference wording with resignation date, LWD and the F&F line', /resignation dated 01-10-2026/.test(rlText) && /close of office hours on 14-11-2026\./.test(rlText) && /full and final settlement/.test(rlText) && rl.model.to.join('|') === 'Dara Mamatha|Employee Code: TL102|Hyderabad, Telangana', [rlText, rl.model.to]);
  fs.writeFileSync(path.join(OUT, 'relieving-letter.pdf'), rl.pdf);
  state.fnf = { status: 'Pending' };
  const rl2 = await X.pdfFor(rec, 'relieving');
  check('relieving: F&F not processed -> the F&F line is left out and the screen says so', rl2.model.paras.length === 2 && !/full and final/.test(JSON.stringify(rl2.model.paras)) && !!(await X.statusOf(rec)).letters[1].note);
  state.fnf = { status: 'Processed' };

  state.detail = { ...state.detail, approvedLastWorkingDate: '2099-01-31' };
  const serving = { ...rec, status: 'Notice Period', date: '2099-01-31', employee: { ...emp, employmentStatus: 'Notice Period' } };
  const sts = await X.statusOf(serving);
  check('exit: still serving notice -> not ready, says the day it will be', sts.letters.every((l) => !l.ready && /31-01-2099/.test(l.why)), sts.letters.map((l) => l.why));
  check('exit: refused when asked anyway', (await X.pdfFor(serving, 'service')).status === 409);
  state.detail = { ...state.detail, approvedLastWorkingDate: '2026-11-14' };
  const noDoj = await X.statusOf({ ...rec, employee: { ...emp, dateOfJoining: null } });
  check('service: no date of joining -> not ready, says what to fix; relieving still ready', !noDoj.letters[0].ready && /date of joining/.test(noDoj.letters[0].why) && noDoj.letters[1].ready);
  check('exit: a withdrawn resignation has no letters', (await X.statusOf({ ...rec, status: 'Withdrawn', employee: { ...emp, employmentStatus: 'Active' } })).letters.every((l) => !l.ready));
  check('exit: unknown kind -> 404', (await X.pdfFor(rec, 'bogus')).status === 404);

  await X.issue(rec, 'service', { id: 'u1', name: 'Test HR' });
  const i2 = await X.issue(rec, 'service', { id: 'u1', name: 'Test HR' });
  await X.issue(rec, 'relieving', { id: 'u1', name: 'Test HR' });
  check('issue: filed once per type (a new one replaces the old), shown as issued by the HR person', state.docs.filter((d) => d.docType === 'Service Certificate').length === 1 && state.docs.filter((d) => d.docType === 'Relieving Letter').length === 1 && i2.status.letters[0].issued && i2.status.letters[0].issued.by === 'Test HR', state.docs.map((d) => d.docType));
  check('issue: audited, and "Experience letter given" ticked for the service certificate only', audits.filter((a) => /generated/.test(a)).length === 3 && ticks.length === 2 && ticks.every((k) => k === 'letter'), { audits, ticks });
  await X.saveSettings({ signatoryName: '  Priya   Sharma ', signatoryTitle: '' }, { id: 'u1', name: 'Test HR' });
  const s2 = await X.loadSettings();
  check('settings: signatory saved and tidied, title falls back to HR Department', s2.signatoryName === 'Priya Sharma' && s2.signatoryTitle === 'HR Department', s2);
  const docTypes = require(path.join(SRC, 'utils/employeeDocTypes.js')).DOC_TYPES;
  check('document types offer Service Certificate and Relieving Letter', docTypes.includes('Service Certificate') && docTypes.includes('Relieving Letter') && docTypes[docTypes.length - 1] === 'Other Documents');

  // ---- the company as the letters print it (the live record had the demo email and no legal name)
  const CC = require(path.join(SRC, 'utils/companyContact.js'));
  const live = await O.buildModel(app, s0.template);
  const liveHtml = O.renderHtml(live, { logoSrc: null });
  check('letters: the demo email hello@teamlink.test is NOT printed (letterhead, email text, html)', !/teamlink\.test/i.test(liveHtml + O.renderText(live) + JSON.stringify(live.company)), live.company);
  check('letters: the real phone still is', live.company.phone === '+91 9032321414' && /\+91 9032321414/.test(liveHtml), live.company);
  check('letters: the company signs with the legal name used on the reference letters', live.company.name === 'Teamlink Consultants [OPC] Pvt. Ltd.' && live.signatory.company === 'Teamlink Consultants [OPC] Pvt. Ltd.' && /For Teamlink Consultants \[OPC\] Pvt\. Ltd\./.test(O.renderText(live)), [live.company.name, live.signatory.company]);
  check('letters: the opening paragraph names the legal name too', /at Teamlink Consultants \[OPC\] Pvt\. Ltd\., based at/.test(live.intro.replace(/[]/g, '')), live.intro);
  state.company = { ...state.company, email: 'hr@tmlink.in' };
  const realMail = await O.buildModel(app, s0.template);
  check('letters: a real company email is printed once it is saved in Company Setup', realMail.company.email === 'hr@tmlink.in' && /hr@tmlink\.in/.test(O.renderHtml(realMail)), realMail.company);
  state.company = { ...state.company, legalName: 'Acme Staffing Pvt. Ltd.' };
  check('letters: a legal name saved on the company record wins', (await O.buildModel(app, s0.template)).company.name === 'Acme Staffing Pvt. Ltd.');
  state.company = { name: 'Acme Traders', legalName: null, email: null, phone: null, address: null };
  const other = await O.buildModel(app, s0.template);
  check('letters: another company keeps its own name; nothing invented for a missing phone / email / address', other.company.name === 'Acme Traders' && other.company.phone === '' && other.company.email === '' && other.company.address === '', other.company);
  check('contact rules: demo and reserved addresses refused, real ones kept', ['hello@teamlink.test', 'a@example.com', 'x@y.example', 'bad', '', null].every((v) => CC.realEmail(v) === null) && CC.realEmail(' hr@tmlink.in ') === 'hr@tmlink.in');
  check('contact rules: demo and made-up phones refused, real ones kept', ['+91 40 1234 5678', '12345', '', null, '+91 00000000'].every((v) => CC.realPhone(v) === null) && CC.realPhone('+91 9032321414') === '+91 9032321414');
  state.company = { name: 'TeamLink Consultants', legalName: null, email: 'hello@teamlink.test', phone: '+91 9032321414', address: 'Hyderabad, India', hq: '' };

  console.log(fails ? `\n${fails} FAILED` : `\nALL PASSED (PDFs in ${OUT})`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });

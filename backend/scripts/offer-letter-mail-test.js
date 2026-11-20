#!/usr/bin/env node
/**
 * THE OFFER LETTER MAILED WITH THE JOINING DATE (utils/offerLetterMail.js, routes/offerLetterMailRoutes.js) - founder 2026-11-17: "when a
 * candidate receives a joining date mail then they have to receive an automatic offer letter through mail".
 *   * the template (Admin edits, others read), the "send it by itself" switch (ships OFF), the master "Candidate emails" switch
 *   * HR sets the joining date -> ONE mail with the letter in the mail and as a PDF; a changed / re-sent date sends nothing more
 *   * two triggers at the same moment -> one mail; the joining reminder and a "Joining confirmation" message also bring it, once
 *   * a person can preview, open the PDF, Send, Send again; a failure says why (on the card, the timeline, a bell) and retries later
 *   * a line without data is left out; names are HTML-escaped; the salary is in the letter only, never in the log / timeline / message row
 *   * a client placement, a candidate who asked not to be contacted, and no email address are never mailed
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4098; the fake mail transport (nothing leaves the machine).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/offer-letter-mail-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-offer-letter-mail-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-offer-letter-mail-uploads-${process.pid}`);
const MAILS = path.join(os.tmpdir(), `zz-offer-letter-mail-mails-${process.pid}.jsonl`);
const FAIL = path.join(os.tmpdir(), `zz-offer-letter-mail-fail-${process.pid}.json`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = Number(process.env.TEST_PORT) || 4098;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'offer-letter-mail-test', UPLOAD_DIR: UPLOADS,
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, TEST_MAIL_CAPTURE: MAILS, TEST_MAIL_FAIL: FAIL,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const O = require('../src/utils/offerLetterMail');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.98.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text, raw: buf, type: r.headers.get('content-type') || '' };
};
const RUN = Date.now().toString(36);
const P = process.pid;
const day = (d = 0) => new Date(Date.now() + d * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
const longDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const readMails = () => { try { return fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const mailsTo = (email) => readMails().filter((m) => String(m.to).toLowerCase() === String(email).toLowerCase());
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const audited = async (entityId, re) => (await prisma.auditLog.findMany({ where: { entityId }, select: { action: true, toValue: true }, take: 300 })).filter((a) => re.test(a.action));
const events = async (appId, re) => (await prisma.applicationStageEvent.findMany({ where: { applicationId: appId }, take: 100 })).filter((e) => re.test(e.action));
const mkUser = async (tag, data, emp) => {
  const u = await prisma.user.create({
    data: {
      name: `ZZTEST OLM ${tag} ${RUN}`, email: `zz-olm-${tag}-${RUN}@example.test`, username: `zz-olm-${tag}-${RUN}@example.test`, passwordHash: 'x', status: 'Active',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
    },
  });
  if (emp) await prisma.employee.create({ data: { employeeCode: `ZZ-OLM-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', email: u.email, ...emp } });
  return u;
};
let seq = 0;
const mkCandidate = (extra = {}) => { seq += 1; return prisma.candidate.create({ data: { name: `ZZTEST Olm Person ${seq} ${RUN}`, email: `zz-olm-cand-${seq}-${RUN}@example.test`, phone: `7${String(P).padStart(5, '1').slice(-5)}${String(seq).padStart(4, '0')}`, location: 'Hyderabad', ...extra } }); };
const mkApp = (cand, reqId, extra = {}) => prisma.application.create({
  data: {
    candidateId: cand.id, requirementId: reqId, stage: 'OFFER_ACCEPTED', hiringType: 'TeamLink Internal Hire', offerStatus: 'Offer Accepted', documentsStatus: 'Verified',
    joiningStatus: 'Not Scheduled', offeredCtc: 612345, ...extra,
  },
});
const schedule = (token, appId, date) => call('POST', `/ats/joining/${appId}/schedule`, { joiningDate: date }, token);
const setMaster = (on) => prisma.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: JSON.stringify({ enabled: on }) }, update: { value: JSON.stringify({ enabled: on }) } });

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    for (const f of [MAILS, FAIL]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    process.exit(code);
  }, 800);
}

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const TL = await mkUser('tl', { role: 'EMPLOYEE', atsRole: 'TL', atsDepartment: 'HR' }, { designation: 'Team Lead', department: 'HR' });
  const candLogin = await prisma.candidate.create({ data: { name: `ZZTEST Olm Login ${RUN}`, email: `zz-olm-login-${RUN}@example.test` } });
  const CAND_USER = await mkUser('cand', { role: 'CANDIDATE', atsAccess: false, candidateId: candLogin.id });
  const internals = await prisma.requirement.findMany({ where: { internal: true }, take: 5 });
  const REQ = internals[0];
  const REQ2 = internals[1];
  await prisma.requirement.update({ where: { id: REQ.id }, data: { tlId: TL.id, department: 'HR', location: 'Hyderabad' } });
  await prisma.requirement.update({ where: { id: REQ2.id }, data: { tlId: null, department: 'Sales', location: 'Bengaluru' } });
  const clientReq = await prisma.requirement.findFirst({ where: { internal: false }, select: { id: true } });
  // the fake e-mail provider: connected, so a send reaches the fake transport (nothing leaves this machine)
  const emailValues = JSON.stringify({ 'SMTP host': 'smtp.example.test', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'From address': 'noreply@teamlink.example.test', 'Default from name': 'TeamLink' });
  await prisma.integration.upsert({ where: { id: 'email' }, update: { enabled: true, connected: true, state: 'Connected', values: emailValues }, create: { id: 'email', enabled: true, connected: true, state: 'Connected', values: emailValues } });
  await setMaster(false);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  await sleep(1100);
  const tA = await tokenOf(adminRow.id); const tTL = await tokenOf(TL.id); const tCand = await tokenOf(CAND_USER.id);

  // ================================================================ the template and the switches
  console.log('\n--- A. template, switches, who may change them');
  const t0 = await call('GET', '/ats/offer-letter-mail/template', null, tA);
  check('the Admin reads the template: switch OFF, starting words, the placeholder list', t0.status === 200 && t0.body.enabled === false && t0.body.custom === false && t0.body.canEdit === true && t0.body.template.terms.length >= 6 && t0.body.tokens.some((x) => x.key === 'joiningDate'), t0.body);
  check('the starting terms carry the trainee period and notice period as editable text', t0.body.template.terms.some((x) => /trainee/i.test(x.title)) && t0.body.template.terms.some((x) => /notice/i.test(x.title)));
  const dt = t0.body.template;
  check('the starting letter has the reference terms: a 3-month trainee period on a Rs 10,000 stipend, and Rs 3,00,000 CTC on confirmation', dt.monthlySalary === 10000 && dt.traineeMonths === 3 && dt.confirmedCtc === 300000 && dt.terms.some((r) => /trainee/i.test(r.title) && /\{\{monthlySalary\}\}/.test(r.text) && /\{\{probationMonths\}\}/.test(r.text)) && dt.terms.some((r) => /\{\{confirmedCtc\}\}/.test(r.text)) && dt.details.some((r) => /\{\{confirmedCtc\}\}/.test(r.value)), dt);
  check('working hours have a row and a term, and the hours are EMPTY until the founder writes them (no invented hours)', dt.workingHours === '' && dt.details.some((r) => r.label === 'Working hours') && dt.terms.some((r) => r.title === 'Working hours'));
  const t1 = await call('GET', '/ats/offer-letter-mail/template', null, tTL);
  check('a team lead may read it but not edit (canEdit false)', t1.status === 200 && t1.body.canEdit === false, t1.body);
  check('a team lead cannot save the template', (await call('PUT', '/ats/offer-letter-mail/template', t0.body.template, tTL)).status === 403);
  check('a team lead cannot flip the switch', (await call('PUT', '/ats/offer-letter-mail/automatic', { enabled: true }, tTL)).status === 403);
  check('a candidate login cannot read the template', (await call('GET', '/ats/offer-letter-mail/template', null, tCand)).status === 403);
  const bad1 = await call('PUT', '/ats/offer-letter-mail/template', { ...t0.body.template, intro: 'Dear {{name}}, your {{salaryInUsd}} is fine' }, tA);
  check('an unknown placeholder is refused and named', bad1.status === 400 && /salaryInUsd/.test(bad1.body.error), bad1.body);
  check('an empty subject is refused', (await call('PUT', '/ats/offer-letter-mail/template', { ...t0.body.template, subject: '  ' }, tA)).status === 400);
  check('a salary that is not a number is refused', (await call('PUT', '/ats/offer-letter-mail/template', { ...t0.body.template, monthlySalary: 'ten thousand' }, tA)).status === 400 && (await call('PUT', '/ats/offer-letter-mail/template', { ...t0.body.template, monthlySalary: -5 }, tA)).status === 400);
  const edited = {
    ...t0.body.template, signatoryName: 'Priya Sharma', signatoryTitle: 'Head of Human Resources', workingHours: '10 am to 7 pm, Monday to Saturday',
    terms: t0.body.template.terms.map((x) => (/notice/i.test(x.title) ? { ...x, text: 'Either side gives 45 days written notice after confirmation. <i>No tags</i>.' } : x)),
  };
  const sv = await call('PUT', '/ats/offer-letter-mail/template', edited, tA);
  check('the Admin saves new wording (notice period, signatory); it is audited', sv.status === 200 && sv.body.custom === true && sv.body.template.signatoryName === 'Priya Sharma' && (await audited('offer-letter-mail', /template changed/)).length === 1, sv.body && sv.body.error);
  const pv0 = await call('POST', '/ats/offer-letter-mail/template/preview', { ...edited, closing: 'Welcome {{firstName}}!' }, tA);
  check('the editor preview shows the UNSAVED words with sample details, letterhead and logo', pv0.status === 200 && /Welcome Anita!/.test(pv0.body.html) && /Priya Sharma/.test(pv0.body.html) && /45 days/.test(pv0.body.html) && /data:image\/png;base64/.test(pv0.body.html) && /TeamLink Consultants/.test(pv0.body.html), pv0.status);
  check('typed HTML in the wording is shown as text, never run', !/<i>No tags<\/i>/.test(pv0.body.html) && /&lt;i&gt;No tags&lt;\/i&gt;/.test(pv0.body.html));

  // ================================================================ joining date -> the letter
  console.log('\n--- B. the switch is OFF: the joining date sends nothing');
  const c1 = await mkCandidate(); const a1 = await mkApp(c1, REQ.id);
  const d1 = day(10); const d2 = day(12); const d3 = day(14); const d4 = day(16);
  const s1 = await schedule(tA, a1.id, d1);
  check('Save date works and says the offer letter is OFF', s1.status === 200 && s1.body.offerLetter && s1.body.offerLetter.state === 'OFF', s1.body && s1.body.offerLetter);
  check('no mail went to the candidate; no row was claimed', mailsTo(c1.email).length === 0 && !(await O.rowOf(a1.id)));
  const st1 = await call('GET', `/ats/offer-letter-mail/${a1.id}`, null, tA);
  check('the card says: not sent yet, automatic OFF, a person may send, joining date on file', st1.status === 200 && st1.body.state === 'NOT_SENT' && st1.body.automatic.enabled === false && st1.body.canSend === true && st1.body.joiningDate === d1, st1.body);

  console.log('\n--- C. automatic ON, master "Candidate emails" OFF: held with a clear reason');
  const on = await call('PUT', '/ats/offer-letter-mail/automatic', { enabled: true }, tA);
  check('the Admin turns the automatic offer letter ON (audited)', on.status === 200 && on.body.enabled === true && (await audited('offer-letter-mail', /Automatic offer letter turned ON/)).length === 1, on.body);
  const s2 = await schedule(tA, a1.id, d2);
  check('the joining date saves; the letter is HELD and says candidate emails are switched off', s2.status === 200 && s2.body.offerLetter.state === 'SKIPPED' && /switched off/i.test(s2.body.offerLetter.message), s2.body && s2.body.offerLetter);
  check('nothing was mailed', mailsTo(c1.email).length === 0);
  const st2 = await call('GET', `/ats/offer-letter-mail/${a1.id}`, null, tA);
  check('the card shows On hold with the reason; the timeline says it too', st2.body.state === 'SKIPPED' && /switched off/i.test(st2.body.reason) && (await events(a1.id, /Offer letter not sent yet/)).length === 1, st2.body);
  await schedule(tA, a1.id, day(13));
  check('the same reason is not written to the timeline a second time', (await events(a1.id, /Offer letter not sent yet/)).length === 1);

  console.log('\n--- D. master ON: the letter goes with the joining date');
  await setMaster(true);
  const s3 = await schedule(tA, a1.id, d3);
  check('the joining date saves and the answer says the offer letter was emailed', s3.status === 200 && s3.body.offerLetter.state === 'SENT', s3.body && s3.body.offerLetter);
  const m1 = mailsTo(c1.email);
  check('exactly one mail reached the candidate', m1.length === 1, m1.length);
  const mail = m1[0] || {};
  check('subject comes from the template (designation + company)', /Your offer letter - Talent Acquisition Executive at TeamLink Consultants/.test(mail.subject || ''), mail.subject);
  check('the letter is IN the mail: name, designation, department, joining date, place, reporting manager, monthly salary, working hours, signatory', [c1.name, 'Talent Acquisition Executive', 'HR', longDay(d3), 'Hyderabad', TL.name.replace(/ZZTEST /, ''), '10,000 per month', '3,00,000 per annum', 'trainee period', '10 am to 7 pm, Monday to Saturday', 'Priya Sharma', 'Terms of employment', 'acceptance'].every((s) => (mail.html || '').toLowerCase().includes(String(s).toLowerCase())), (mail.html || '').slice(0, 300));
  check('the edited notice period is in the mail (45 days), not the starting one', /45 days/.test(mail.html || '') && !/30 days/.test(mail.html || ''));
  check('the mail has a plain-text part too', /OFFER OF EMPLOYMENT/.test(mail.text || '') && (mail.text || '').includes(c1.name));
  const pdf = (mail.attachments || []).find((a) => a.pdf);
  check('a real PDF is attached (starts with %PDF, a sensible size, named for the candidate)', !!pdf && pdf.size > 4000 && /^Offer-letter-.*\.pdf$/.test(pdf.filename) && pdf.contentType === 'application/pdf', mail.attachments);
  check('the logo is inline (cid), the mail comes from the company address and replies go to a person', /cid:teamlink-logo/.test(mail.html || '') && /noreply@teamlink\.example\.test/.test(mail.from || '') && /@/.test(mail.replyTo || ''), { from: mail.from, replyTo: mail.replyTo });
  const row = await O.rowOf(a1.id);
  check('one record row: SENT, once, for this joining date, automatic', row && row.status === 'SENT' && Number(row.sendCount) === 1 && row.joiningDate === d3 && Number(row.auto) === 1, row);
  const msgs = await prisma.candidateMessage.findMany({ where: { applicationId: a1.id, template: 'OFFER_LETTER_MAIL' } });
  check('Candidate -> Communications shows one SENT row with the provider reference', msgs.length === 1 && msgs[0].status === 'SENT' && !!msgs[0].providerRef && msgs[0].recipient === c1.email, msgs.map((m) => [m.status, m.statusDetail]));
  check('the pipeline history says the letter was emailed (automatic) and the audit log too', (await events(a1.id, /Offer letter emailed to the candidate \(automatic\)/)).length === 1 && (await audited(a1.id, /Offer letter emailed automatically/)).length === 1);
  const everything = JSON.stringify([msgs, await prisma.applicationStageEvent.findMany({ where: { applicationId: a1.id } }), await prisma.auditLog.findMany({ where: { entityId: a1.id } }), await prisma.notification.findMany({ where: { message: { contains: 'offer letter' } }, take: 50 })]);
  check('the salary is in the letter only: not in Communications, the timeline, the audit log or any bell', !/10,000|10000/.test(everything), everything.match(/.{30}10,?000.{20}/));
  check('the annual CTC on the record (Rs 6,12,345) is NOT printed: the letter prints the reference stipend and CTC instead', !/6,12,345|612345/.test(mail.html + mail.text) && /10,000 per month/.test(mail.html || '') && /3,00,000 per annum/.test(mail.html || ''));

  console.log('\n--- E. once per joining');
  const s4 = await schedule(tA, a1.id, d4);
  check('a changed joining date sends nothing more', s4.status === 200 && s4.body.offerLetter.state === 'ALREADY' && mailsTo(c1.email).length === 1, s4.body.offerLetter);
  const st4 = await call('GET', `/ats/offer-letter-mail/${a1.id}`, null, tA);
  check('the card warns that the joining date changed after the letter went', st4.body.state === 'SENT' && st4.body.joiningDateChangedSinceSent === true && st4.body.sentForJoiningDate === d3 && st4.body.joiningDate === d4, st4.body);
  const again = await O.maybeSendAuto(a1.id, { trigger: 'Joining reminder (test)' });
  check('the joining reminder path finds it already sent', again.state === 'ALREADY' && mailsTo(c1.email).length === 1, again);
  const c2 = await mkCandidate(); const a2 = await mkApp(c2, REQ.id, { joiningDate: day(20) });
  const race = await Promise.all([O.maybeSendAuto(a2.id, { trigger: 'race 1' }), O.maybeSendAuto(a2.id, { trigger: 'race 2' }), O.maybeSendAuto(a2.id, { trigger: 'race 3' })]);
  check('three triggers at the same moment send ONE mail', race.filter((r) => r.state === 'SENT').length === 1 && mailsTo(c2.email).length === 1, race.map((r) => r.state));

  console.log('\n--- F. a person: preview, PDF, Send, Send again');
  const pv = await call('GET', `/ats/offer-letter-mail/${a1.id}/preview`, null, tA);
  check('preview returns the letter as HTML for this person, with the recipient', pv.status === 200 && (pv.body.html || '').includes(c1.name) && pv.body.to === c1.email && /Your offer letter/.test(pv.body.subject), pv.body && pv.body.subject);
  const pd = await call('GET', `/ats/offer-letter-mail/${a1.id}/pdf`, null, tA);
  check('the PDF endpoint serves a real PDF', pd.status === 200 && /application\/pdf/.test(pd.type) && pd.raw.slice(0, 4).toString('latin1') === '%PDF' && pd.raw.length > 4000, [pd.status, pd.type, pd.raw.length]);
  check('a candidate login cannot open a letter', (await call('GET', `/ats/offer-letter-mail/${a1.id}/preview`, null, tCand)).status === 403 && (await call('POST', `/ats/offer-letter-mail/${a1.id}/send`, {}, tCand)).status === 403);
  // the salary and the address are for logins that may see "Candidate Contact & Salary" (the BDE team may not)
  const BDE = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' }, { designation: 'BDE', department: 'BDE' });
  await prisma.requirement.update({ where: { id: REQ.id }, data: { bdeId: BDE.id } }); // the client manager of this job: inside the scope, but without the salary right
  const P2 = require('../src/utils/permissions');
  const bdeId = await resolveIdentity(BDE.id);
  const bdeView = !!(await P2.can(bdeId, 'ats', 'interviews', 'Offers', 'view') || await P2.can(bdeId, 'ats', 'interviews', 'Joining', 'view'));
  const bdePrivate = !!(await P2.can(bdeId, 'ats', 'candidates', 'Candidate Contact & Salary', 'view'));
  const tBde = await tokenOf(BDE.id);
  const bp = await call('GET', `/ats/offer-letter-mail/${a1.id}/preview`, null, tBde);
  const bf = await call('GET', `/ats/offer-letter-mail/${a1.id}/pdf`, null, tBde);
  check(`a login without "Candidate Contact & Salary" (BDE: sees offers ${bdeView}, sees private ${bdePrivate}) cannot read the letter or the PDF`, !bdePrivate && bp.status === 403 && bf.status === 403 && !/6,12,345/.test(bp.text + bf.text), [bp.status, bf.status]);
  if (bdeView) {
    const bs = await call('GET', `/ats/offer-letter-mail/${a1.id}`, null, tBde);
    check('...but still sees whether it was sent, with the address masked', bs.status === 200 && bs.body.state === 'SENT' && bs.body.maySeeLetter === false && bs.body.to !== c1.email && /•/.test(bs.body.to || ''), bs.body);
  } else {
    check('...and a login with no Offers / Joining view sees nothing at all', (await call('GET', `/ats/offer-letter-mail/${a1.id}`, null, tBde)).status === 403);
  }
  const sd = await call('POST', `/ats/offer-letter-mail/${a1.id}/send`, { again: true }, tA);
  check('Send again mails it a second time and says so', sd.status === 200 && sd.body.state === 'SENT' && sd.body.card.sendCount === 2 && sd.body.card.wasAutomatic === false && mailsTo(c1.email).length === 2, sd.body);
  check('that second mail carries the CURRENT joining date', longDay(d4) && (mailsTo(c1.email)[1].html || '').includes(longDay(d4)) && !(mailsTo(c1.email)[1].html || '').includes(longDay(d3)));
  check('Send again is audited and on the timeline', (await audited(a1.id, /^Offer letter emailed$/)).length === 1 && (await events(a1.id, /^Offer letter emailed to the candidate$/)).length === 1);

  console.log('\n--- G. failures say why, and recover');
  const c3 = await mkCandidate(); const a3 = await mkApp(c3, REQ.id, { joiningDate: day(21) });
  fs.writeFileSync(FAIL, JSON.stringify({ message: 'Mailbox unavailable (simulated)', responseCode: 550 }));
  const f1 = await O.maybeSendAuto(a3.id, { trigger: 'Joining date set', actor: { id: adminRow.id, name: adminRow.name } });
  check('an automatic send that the provider refuses is FAILED with the provider words', f1.state === 'FAILED' && /Mailbox unavailable/.test(f1.message), f1);
  const fr = await O.rowOf(a3.id);
  const fm = await prisma.candidateMessage.findMany({ where: { applicationId: a3.id, template: 'OFFER_LETTER_MAIL' } });
  check('the record says FAILED + the reason; Communications shows a FAILED row with the error', fr.status === 'FAILED' && /Mailbox unavailable/.test(fr.reason) && fm.length === 1 && fm[0].status === 'FAILED' && /Mailbox unavailable/.test(fm[0].lastError || ''), { fr, fm: fm.map((m) => m.status) });
  check('the timeline and the audit log say it could not be emailed', (await events(a3.id, /could NOT be emailed/)).length === 1 && (await audited(a3.id, /Offer letter email failed/)).length === 1);
  check('the team lead got a bell naming the problem', (await prisma.notification.findMany({ where: { userId: TL.id }, take: 30 })).some((n) => /Offer letter not sent/.test(n.title) && /Mailbox unavailable/.test(n.message)));
  const stF = await call('GET', `/ats/offer-letter-mail/${a3.id}`, null, tA);
  check('the card shows Could not be sent with the reason', stF.body.state === 'FAILED' && /Mailbox unavailable/.test(stF.body.reason), stF.body);
  const mf = await call('POST', `/ats/offer-letter-mail/${a3.id}/send`, {}, tA);
  check('a person pressing Send while the provider still refuses gets the plain reason (409)', mf.status === 409 && mf.body.state === 'FAILED' && /Mailbox unavailable/.test(mf.body.message), mf.body);
  fs.unlinkSync(FAIL);
  const retry = await O.maybeSendAuto(a3.id, { trigger: 'Joining reminder (retry)' });
  check('after the provider recovers, the next automatic trigger sends it (once)', retry.state === 'SENT' && mailsTo(c3.email).length === 1, retry);
  check('the record is SENT now', (await O.rowOf(a3.id)).status === 'SENT');

  console.log('\n--- H. who is never mailed');
  const c4 = await mkCandidate({ email: null }); const a4 = await mkApp(c4, REQ.id, { joiningDate: day(22) });
  const n1 = await O.maybeSendAuto(a4.id, { trigger: 'Joining date set', actor: { id: adminRow.id, name: adminRow.name } });
  check('no email address: held with the reason, and the recruiter / team lead get a bell', n1.state === 'SKIPPED' && /no email address/i.test(n1.message) && (await prisma.notification.findMany({ where: { userId: TL.id }, take: 40 })).some((n) => /Offer letter not sent/.test(n.title) && /no email address/i.test(n.message)), n1);
  const n1m = await call('POST', `/ats/offer-letter-mail/${a4.id}/send`, {}, tA);
  check('a person cannot send it either (409, no_email)', n1m.status === 409 && n1m.body.code === 'no_email', n1m.body);
  const c5 = await mkCandidate({ doNotContact: true }); const a5 = await mkApp(c5, REQ.id, { joiningDate: day(22) });
  const n2 = await O.maybeSendAuto(a5.id, { trigger: 'x' });
  const n2m = await call('POST', `/ats/offer-letter-mail/${a5.id}/send`, {}, tA);
  check('a candidate who asked not to be contacted: nothing automatic, nothing by hand', n2.state === 'SKIPPED' && n2m.status === 409 && n2m.body.code === 'consent' && mailsTo(c5.email).length === 0, [n2, n2m.body]);
  const c6 = await mkCandidate(); const a6 = await mkApp(c6, clientReq.id, { hiringType: 'Client Placement', joiningDate: day(22) });
  const n3 = await O.maybeSendAuto(a6.id, { trigger: 'x' });
  const n3m = await call('POST', `/ats/offer-letter-mail/${a6.id}/send`, {}, tA);
  const n3s = await call('GET', `/ats/offer-letter-mail/${a6.id}`, null, tA);
  check('a client placement: the client makes the letter - nothing sent, no row, the card says so', n3.state === 'NOT_APPLICABLE' && n3m.status === 409 && n3m.body.code === 'client_job' && n3s.body.applicable === false && !(await O.rowOf(a6.id)) && mailsTo(c6.email).length === 0, [n3, n3m.body]);
  const c7 = await mkCandidate(); const a7 = await mkApp(c7, REQ.id, { joiningDate: null });
  const n4 = await O.maybeSendAuto(a7.id, { trigger: 'x' });
  check('no joining date yet: nothing is sent and nothing is claimed', n4.state === 'SKIPPED' && !(await O.rowOf(a7.id)) && mailsTo(c7.email).length === 0, n4);
  const c8 = await mkCandidate(); const a8 = await mkApp(c8, REQ.id, { stage: 'REJECTED', joiningDate: day(22) });
  check('a rejected application is never mailed', (await O.maybeSendAuto(a8.id, { trigger: 'x' })).state === 'NOT_APPLICABLE' && mailsTo(c8.email).length === 0);

  console.log('\n--- I. the letter itself');
  const c9 = await mkCandidate({ name: `Zed <script>alert(1)</script> & Co ${RUN}` }); const a9 = await mkApp(c9, REQ2.id, { joiningDate: day(25), offeredCtc: null });
  const p9 = await call('GET', `/ats/offer-letter-mail/${a9.id}/preview`, null, tA);
  check('a name with HTML in it is escaped in the letter', /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(p9.body.html) && !/<script>alert/.test(p9.body.html), p9.status);
  check('a line with no data is left out: no reporting manager on this job -> "Reporting to" is not printed; the flat salary and the date still are', !/Reporting to/.test(p9.body.html) && /Date of joining/.test(p9.body.html) && /10,000 per month/.test(p9.body.html), p9.body.omitted);
  check('the preview names what was left out, so a person can fix the record', p9.body.omitted.some((x) => /Reporting to \(no manager on file\)/.test(x)), p9.body.omitted);
  const noHours = await call('PUT', '/ats/offer-letter-mail/template', { ...edited, workingHours: '' }, tA);
  const p9b = await call('GET', `/ats/offer-letter-mail/${a9.id}/preview`, null, tA);
  check('no working hours written in the editor -> the Working hours row and term are left out, and the preview says why', noHours.status === 200 && !/Working hours/.test(p9b.body.html) && p9b.body.omitted.some((x) => /Working hours \(working hours not written in the editor\)/.test(x)), p9b.body.omitted);
  await call('PUT', '/ats/offer-letter-mail/template', { ...edited }, tA);
  const sal = await call('PUT', '/ats/offer-letter-mail/template', { ...edited, monthlySalary: '12,500' }, tA);
  const p9c = await call('GET', `/ats/offer-letter-mail/${a9.id}/preview`, null, tA);
  check('the Admin can change the one monthly salary (12,500 typed with a comma) and the letter follows', sal.status === 200 && sal.body.template.monthlySalary === 12500 && /12,500 per month/.test(p9c.body.html) && !/10,000/.test(p9c.body.html), sal.body && sal.body.error);
  await call('PUT', '/ats/offer-letter-mail/template', { ...edited }, tA);
  check('a bad placeholder can never get into a sent letter: an unfilled {{ }} is never printed', !/\{\{/.test(p9.body.html));
  const noCtc = await call('PUT', '/ats/offer-letter-mail/template', { ...edited, showCtc: false }, tA);
  const p1 = await call('GET', `/ats/offer-letter-mail/${a1.id}/preview`, null, tA);
  check('"print the salary" switched off keeps the stipend and the CTC out of the letter', noCtc.status === 200 && !/10,000/.test(p1.body.html) && !/3,00,000/.test(p1.body.html) && !/Trainee period and stipend/.test(p1.body.html) && !/Confirmation and CTC/.test(p1.body.html), noCtc.body && noCtc.body.error);
  await call('PUT', '/ats/offer-letter-mail/template', { ...edited, showCtc: true }, tA);
  const rs = await call('POST', '/ats/offer-letter-mail/template/reset', {}, tA);
  check('"Back to the starting words" restores the starting template (audited)', rs.status === 200 && rs.body.custom === false && rs.body.template.signatoryName === '' && (await audited('offer-letter-mail', /reset to the starting words/)).length === 1, rs.body && rs.body.custom);

  console.log('\n--- J. the other triggers');
  const c10 = await mkCandidate(); const a10 = await mkApp(c10, REQ.id, { joiningDate: '2031-03-15' });
  // the reminder job, run as if it were 12 March 2031 (T-3 for this one joining only; nobody else in the copy joins that day)
  const r1 = await require('../src/utils/clientTrack').runReminders({ now: new Date('2031-03-12T06:00:00Z'), force: true });
  check('the T-3 joining reminder also brings the letter (catches joinings set before the feature), once', r1.joiningReminders >= 1 && mailsTo(c10.email).filter((m) => /offer letter/i.test(m.subject)).length === 1 && (await O.rowOf(a10.id)).status === 'SENT', { r1: r1.joiningReminders, mails: mailsTo(c10.email).map((m) => m.subject) });
  await require('../src/utils/clientTrack').runReminders({ now: new Date('2031-03-14T06:00:00Z'), force: true });
  check('the T-1 reminder sends no second letter', mailsTo(c10.email).filter((m) => /offer letter/i.test(m.subject)).length === 1);
  // a "Joining confirmation" sent from the Contact button
  // the Contact path refuses reserved test domains by itself, so this person has an ordinary-looking address; the fake transport still sends nothing
  const c11 = await mkCandidate({ email: `zz-olm-contact-${RUN}@olm-test.in` });
  const a11 = await mkApp(c11, REQ.id, { joiningDate: day(9) });
  const cs = await call('POST', '/messaging/send', { audience: 'candidates', id: c11.id, channel: 'Email', purposeKey: 'FU_JOINING_CONFIRMATION', language: 'English', applicationId: a11.id, requirementId: REQ.id }, tA);
  let viaContact = 0;
  for (let i = 0; i < 40 && !viaContact; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
    viaContact = mailsTo(c11.email).filter((m) => /offer letter/i.test(m.subject)).length;
  }
  check('a "Joining confirmation" message from the Contact button brings the letter with it (once)', viaContact === 1 && mailsTo(c11.email).length >= 2, { status: cs.status, body: cs.body && (cs.body.error || cs.body.result), mails: mailsTo(c11.email).map((m) => m.subject) });
  const other = await call('POST', '/messaging/send', { audience: 'candidates', id: c10.id, channel: 'Email', purposeKey: 'BULK_NEW_OPENING', language: 'English', applicationId: a10.id, requirementId: REQ.id }, tA);
  await sleep(2500);
  check('another kind of message (a job alert) does not trigger the letter', mailsTo(c10.email).filter((m) => /offer letter/i.test(m.subject)).length === 1, other.status);

  console.log(`\n${failed ? 'FAILED' : 'OK'}: ${total - failed}/${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

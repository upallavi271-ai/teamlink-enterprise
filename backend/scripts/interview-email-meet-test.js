#!/usr/bin/env node
// ---------------------------------------------------------------------------
// INTERVIEW: MEET LINK + E-MAIL ON SCHEDULE + START INTERVIEW (2026-10-14). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/interview-email-meet-test.js
//
//   U  unit (this process, sandbox.db, a FAKE mail transport): link check, e-mail content (no client name / no pay
//      for the candidate), .ics (valid, stable UID, SEQUENCE grows, CANCEL), mail not set up, the three switches,
//      resend, the Start rules (window, Admin, named interviewer, TL, recruiter)
//   H  API on the sandbox (its mail transport is fake too): booking, reschedule, cancel, resend, start, paste a link,
//      role gates, nobody outside the interview sees the link.
// Builds ZZTEST fixtures in sandbox.db and removes them again. Nothing is ever sent for real.
// ---------------------------------------------------------------------------
const path = require('path');

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
const IM = require(path.join(BACK, 'src/utils/interviewMeet'));

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
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 60) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const ymdIST = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const hmIST = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(11, 16);

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  let settingBefore = null;
  const CLIENT = `ZZTEST Meet Hospital ${RUN}`;
  const CAND_EMAIL = `zz.meet.${RUN}@zzmeet-sandbox.in`;
  const OUT_EMAIL = `zz.panel.${RUN}@zzmeet-sandbox.in`;
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST Meet ${tag} ${RUN}`, email: `zz-meet-${tag}-${RUN}@example.test`, username: `zz-meet-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-MT-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, phone: '9000000011', ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'TL' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    const uRecNamed = await mkUser('recnamed', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    const uRecOther = await mkUser('recother', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' }, {});
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, {});
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, tl: uTl, rec: uRec, recNamed: uRecNamed, recOther: uRecOther, bde: uBde })) T[k] = await mint(u);

    const client = await prisma.client.create({ data: { name: CLIENT, location: 'ZZ Town', ownerDepartment: 'Medical', bdeOwner: uBde.name, clientType: 'Client' } });
    made.clients.push(client.id);
    const req = await prisma.requirement.create({
      data: {
        title: `ZZTEST Staff Nurse ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: uRec.id, tlId: uTl.id, bdeId: uBde.id, openings: 2,
        skills: 'Nursing', experience: '2-5', location: 'Hyderabad', salary: '4L - 6L CTC', jobDescription: `${CLIENT} needs nurses. Salary 4L to 6L.`,
      },
    });
    made.reqs.push(req.id);
    const mkCand = async (n, email) => { const c = await prisma.candidate.create({ data: { name: `ZZTEST Meet Cand ${n} ${RUN}`, email, phone: '9000000077', currentSalary: '3L', expectedSalary: '5L' } }); made.cands.push(c.id); return c; };
    const mkApp = async (cand, data) => { const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ...data } }); made.apps.push(a.id); return a; };
    const soon = new Date(Date.now() + 5 * 60000);
    const cand1 = await mkCand('one', CAND_EMAIL);
    const app1 = await mkApp(cand1, { stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 30 * 3600000), interviewMode: 'Online', interviewMeetingLink: 'https://meet.google.com/abc-defg-hij', interviewer: uRecNamed.name, interviewRound: 1, interviewCreatedBy: uBde.name });
    await prisma.interviewPanelist.create({ data: { applicationId: app1.id, round: 1, userId: uRecNamed.id, name: uRecNamed.name, email: uRecNamed.email, position: 0 } });
    await prisma.interviewPanelist.create({ data: { applicationId: app1.id, round: 1, name: 'Dr Outside', email: OUT_EMAIL, position: 1 } });

    // ============================ U: unit =====================================
    const sBefore = await prisma.appSetting.findUnique({ where: { key: IM.KEY } });
    settingBefore = sBefore ? { value: sBefore.value } : null;
    await prisma.appSetting.deleteMany({ where: { key: IM.KEY } });
    const dflt = await IM.loadSettings();
    check('U1 defaults: three e-mail switches ON, copy OFF, auto-link OFF, window 15 min before / 2 h after', dflt.emailCandidate && dflt.emailInterviewer && dflt.emailChanges && !dflt.copyTeam && !dflt.calendarAutoLink && dflt.startBeforeMin === 15 && dflt.startAfterMin === 120, dflt);

    const c1 = IM.checkLink('https://meet.google.com/abc-defg-hij');
    const c2 = IM.checkLink('https://zoom.us/j/123456789');
    check('U2 link check: Meet accepted; other https accepted with a warning; http / words / half Meet refused',
      c1.ok && c1.kind === 'meet' && !c1.warning && c2.ok && c2.kind === 'other' && !!c2.warning
      && !IM.checkLink('http://meet.google.com/abc-defg-hij').ok && !IM.checkLink('hello there').ok && !IM.checkLink('https://meet.google.com/abc').ok && !IM.checkLink('').ok && !IM.checkLink('javascript:alert(1)').ok,
      [c1, c2]);

    const sent = [];
    IM.setMailer(async (m) => { sent.push(m); return { ok: true }; });
    const r1 = await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name, email: 'bde.person@zzmeet-sandbox.in' } });
    const toCand = sent.find((m) => m.to === CAND_EMAIL);
    const toOut = sent.find((m) => m.to === OUT_EMAIL);
    const toRec = sent.find((m) => m.to === uRecNamed.email);
    check('U3 booked: the candidate, the outside interviewer and the staff interviewer each get ONE mail', sent.length === 3 && !!toCand && !!toOut && !!toRec && r1.sent === 3, [sent.map((m) => m.to), r1.message]);
    const cText = `${toCand.subject}\n${toCand.text}`;
    check('U4 candidate mail: date, time (IST), mode, Join Meet link, who to ask; no client name, no salary / CTC, "our client"',
      /IST/.test(cText) && /Date: /.test(cText) && /Online \(Google Meet\)/.test(cText) && /Join Meet: https:\/\/meet\.google\.com\/abc-defg-hij/.test(cText) && /Reply to this email/.test(cText) && /our client/.test(cText)
      && !cText.includes(CLIENT) && !/ZZTEST Meet Hospital/i.test(cText) && !/salary|CTC|4L|6L|fee|₹/i.test(cText), cText);
    check('U5 interviewer mail names the job and the company', toRec.text.includes(CLIENT) && /Meet link: https:\/\/meet\.google\.com/.test(toRec.text), toRec.text);
    const ics1 = toCand.attachments[0];
    const body1 = ics1.content;
    const lines1 = body1.split('\r\n');
    const long = lines1.filter((l) => Buffer.byteLength(l) > 75);
    check('U6 .ics is valid: CRLF, folded lines, BEGIN/END, METHOD:REQUEST, UID, DTSTART in UTC, attendee, attachment is text/calendar', /^BEGIN:VCALENDAR\r\n/.test(body1) && /END:VCALENDAR\r\n$/.test(body1) && body1.includes('METHOD:REQUEST') && /UID:interview-.+-r1@teamlink/.test(body1) && /DTSTART:\d{8}T\d{6}Z/.test(body1) && body1.includes('ATTENDEE;') && body1.includes('STATUS:CONFIRMED') && long.length === 0 && /text\/calendar/.test(ics1.contentType) && ics1.filename === 'interview.ics' && !body1.includes(CLIENT), [long.slice(0, 2), body1.slice(0, 300)]);
    check('U7 the candidate\'s invite never holds the client name; the interviewer\'s may', !body1.includes(CLIENT));
    const uid1 = (body1.match(/UID:(\S+)/) || [])[1];
    const seq1 = Number((body1.match(/SEQUENCE:(\d+)/) || [])[1]);
    // reschedule
    sent.length = 0;
    const newAt = new Date(Date.now() + 52 * 3600000);
    await prisma.application.update({ where: { id: app1.id }, data: { interviewAt: newAt, interviewStatus: 'RESCHEDULED' } });
    await IM.sendInvites(app1.id, 'rescheduled', { actor: { id: uBde.id, name: uBde.name }, fromSlot: new Date(Date.now() + 30 * 3600000), reason: 'ZZ client busy' });
    const rc = sent.find((m) => m.to === CAND_EMAIL);
    const bodyR = rc.attachments[0].content;
    check('U8 reschedule: same UID, SEQUENCE one higher, new time, old time named, still REQUEST', (bodyR.match(/UID:(\S+)/) || [])[1] === uid1 && Number((bodyR.match(/SEQUENCE:(\d+)/) || [])[1]) === seq1 + 1 && /Old time:/.test(rc.text) && /new time/i.test(rc.text) && bodyR.includes('METHOD:REQUEST') && !/ZZ client busy/.test(rc.text), [uid1, bodyR.slice(0, 200)]);
    const staffR = sent.find((m) => m.to === uRecNamed.email);
    check('U9 the internal reason goes to staff only, never to the candidate', /ZZ client busy/.test(staffR.text) && !/ZZ client busy/.test(rc.text));
    // cancel
    sent.length = 0;
    await prisma.application.update({ where: { id: app1.id }, data: { interviewStatus: 'CANCELLED' } });
    await IM.sendInvites(app1.id, 'cancelled', { actor: { id: uBde.id, name: uBde.name }, reason: 'ZZ cancel reason' });
    const cc = sent.find((m) => m.to === CAND_EMAIL);
    const bodyC = cc.attachments[0].content;
    check('U10 cancel: mail says cancelled; .ics METHOD:CANCEL, STATUS:CANCELLED, same UID, higher SEQUENCE; no Meet link line for the candidate',
      /cancelled/i.test(cc.subject) && bodyC.includes('METHOD:CANCEL') && bodyC.includes('STATUS:CANCELLED') && (bodyC.match(/UID:(\S+)/) || [])[1] === uid1 && Number((bodyC.match(/SEQUENCE:(\d+)/) || [])[1]) === seq1 + 2 && !/Join Meet/.test(cc.text) && !/ZZ cancel reason/.test(cc.text), [cc.subject, bodyC.slice(0, 200)]);
    // status record
    const ms = await IM.mailStatus(app1.id);
    const candRow = ms.rows.find((x) => x.key === 'candidate');
    check('U11 the card has the status per person, the address is masked, nothing else leaks', ms.rows.length === 3 && candRow.status === 'sent' && /^z\*\*\*@zzmeet-sandbox\.in$/.test(candRow.toMasked) && !JSON.stringify(ms).includes(CAND_EMAIL), ms);
    const cm = await prisma.candidateMessage.findFirst({ where: { candidateId: cand1.id, template: 'INTERVIEW_SCHEDULED' } });
    check('U12 the candidate\'s Communications shows the e-mail (so "told" and the safety-net message are not doubled)', !!cm && cm.status === 'SENT', cm && cm.status);
    const au = await prisma.auditLog.findMany({ where: { entityId: app1.id, action: { startsWith: 'Interview email' } } });
    check('U13 every e-mail event is audited (who, to-masked, result) with no full address', au.length >= 3 && au.every((a) => a.toValue && !a.toValue.includes('@zzmeet-sandbox.in') || /\*\*\*@/.test(a.toValue)) && au.some((a) => /sent/.test(a.toValue)), au.map((a) => a.toValue));

    // mail not set up
    IM.setMailer(async () => ({ ok: false, notConfigured: true, error: 'The Email (SMTP) channel has never been configured.' }));
    await prisma.application.update({ where: { id: app1.id }, data: { interviewStatus: 'SCHEDULED' } });
    const rn = await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    check('U14 mail not set up: no throw, every row "not sent" with a plain reason, notConfigured flag, message points to Integrations > Email',
      rn.ok && rn.notConfigured && rn.rows.every((x) => x.status === 'not_sent' && /mail is not set up/.test(x.detail)) && /Integrations > Email/.test(rn.message), rn);
    const cm2 = await prisma.candidateMessage.findFirst({ where: { candidateId: cand1.id, status: 'NOT_SENT_NO_PROVIDER' } });
    check('U15 ...and the candidate\'s record says "not sent: no provider"', !!cm2);
    // mailer that throws
    IM.setMailer(async () => { throw new Error('socket exploded'); });
    const rt = await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    check('U16 a mailer that THROWS is caught: rows say the server problem, nothing propagates', rt.ok && rt.rows.length === 3 && rt.rows.every((x) => x.status === 'not_sent' && /socket exploded/.test(x.detail)), rt.rows.map((x) => x.detail));
    // no email address
    const candNoMail = await mkCand('nomail', null);
    const appNoMail = await mkApp(candNoMail, { stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 30 * 3600000), interviewMode: 'In Person', interviewLocation: 'ZZ Street 1', interviewer: 'ZZ Nobody', interviewRound: 1 });
    sent.length = 0;
    IM.setMailer(async (m) => { sent.push(m); return { ok: true }; });
    const rnm = await IM.sendInvites(appNoMail.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    check('U17 no e-mail address on the candidate: "Email not sent: no email address", nothing sent', sent.length === 0 && rnm.rows[0].status === 'not_sent' && /no email address/.test(rnm.rows[0].detail), rnm.rows);
    // in-person mail
    await prisma.interviewPanelist.create({ data: { applicationId: appNoMail.id, round: 1, name: 'Dr Walk', email: OUT_EMAIL, position: 0 } });
    sent.length = 0;
    await prisma.candidate.update({ where: { id: candNoMail.id }, data: { email: `zz.nm.${RUN}@zzmeet-sandbox.in` } });
    await IM.sendInvites(appNoMail.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    const ip = sent.find((m) => /zz\.nm\./.test(m.to));
    check('U18 in-person interview: the address is in the mail and the invite (LOCATION), no Meet line', ip && /In person at ZZ Street 1/.test(ip.text) && !/Join Meet/.test(ip.text) && /LOCATION:ZZ Street 1/.test(ip.attachments[0].content), ip && ip.text);
    // switches
    sent.length = 0;
    IM.setMailer(async (m) => { sent.push(m); return { ok: true }; });
    await prisma.appSetting.upsert({ where: { key: IM.KEY }, create: { key: IM.KEY, value: JSON.stringify({ emailCandidate: false }) }, update: { value: JSON.stringify({ emailCandidate: false }) } });
    const rs1 = await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    check('U19 switch "Email the candidate" OFF: the candidate gets nothing (row says switched off), the interviewers still do', !sent.some((m) => m.to === CAND_EMAIL) && sent.length === 2 && rs1.rows.find((x) => x.key === 'candidate').status === 'off', rs1.rows);
    await prisma.appSetting.update({ where: { key: IM.KEY }, data: { value: JSON.stringify({ emailInterviewer: false }) } });
    sent.length = 0;
    await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    check('U20 switch "Email the interviewer" OFF: only the candidate is mailed', sent.length === 1 && sent[0].to === CAND_EMAIL, sent.map((m) => m.to));
    await prisma.appSetting.update({ where: { key: IM.KEY }, data: { value: JSON.stringify({ emailChanges: false }) } });
    sent.length = 0;
    await IM.sendInvites(app1.id, 'rescheduled', { actor: { id: uBde.id, name: uBde.name } });
    const afterCh = sent.length;
    await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    check('U21 switch "Email on reschedule / cancel" OFF: a reschedule sends nothing, a new booking still does', afterCh === 0 && sent.length === 3, [afterCh, sent.length]);
    await prisma.appSetting.update({ where: { key: IM.KEY }, data: { value: JSON.stringify({ copyTeam: true }) } });
    sent.length = 0;
    await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name, email: 'bde.person@zzmeet-sandbox.in' } });
    // the TL and BDE logins here use example.test addresses: in the sandbox they are "test addresses" the real mailer refuses, the fake accepts
    check('U22 copy switch ON: the booker, the TL and the BDE are copied (one mail per address)', sent.length >= 4, sent.map((m) => m.to));
    await prisma.appSetting.deleteMany({ where: { key: IM.KEY } });

    // resend
    IM.setMailer(async (m) => (m.to === CAND_EMAIL ? { ok: false, error: 'ZZ mailbox full' } : { ok: true }));
    await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name } });
    const st0 = await IM.mailStatus(app1.id);
    sent.length = 0;
    IM.setMailer(async (m) => { sent.push(m); return { ok: true }; });
    const seqBefore = (await IM.readRecord(app1.id)).sequence;
    await IM.sendInvites(app1.id, 'scheduled', { actor: { id: uBde.id, name: uBde.name }, resend: true, only: ['candidate'] });
    const st1 = await IM.mailStatus(app1.id);
    check('U23 resend to ONE person: only that mail goes, the others keep their result, the calendar SEQUENCE does not grow', st0.rows.find((x) => x.key === 'candidate').status === 'not_sent' && sent.length === 1 && sent[0].to === CAND_EMAIL && st1.rows.find((x) => x.key === 'candidate').status === 'sent' && st1.rows.length === 3 && (await IM.readRecord(app1.id)).sequence === seqBefore, [st0.rows.map((x) => x.status), st1.rows.map((x) => x.status)]);
    IM.setMailer(null);

    // Start rules (pure)
    const ctxAdmin = { admin: true, bdeTeam: false, settings: dflt };
    const ctxBde = { admin: false, bdeTeam: true, settings: dflt };
    const ctxNone = { admin: false, bdeTeam: false, settings: dflt };
    const mk = (min, extra) => ({ id: 'x', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + min * 60000), interviewMode: 'Online', interviewMeetingLink: 'https://meet.google.com/abc-defg-hij', interviewer: 'Someone Else', interviewCreatedBy: 'Booker', requirement: { tlId: 'tlx' }, ...extra });
    const named = { id: 'u1', name: 'Pat Named' };
    check('U24 too early (60 min before): button shown, disabled, reason "Opens 15 minutes before the interview"', (() => { const s = IM.startState(ctxBde, { id: 'b' }, mk(60), []); return s.show && !s.can && s.reason === 'Opens 15 minutes before the interview'; })());
    check('U25 inside the window (10 min before / 90 min after): can start; 3 hours after: closed', IM.startState(ctxBde, { id: 'b' }, mk(10), []).can && IM.startState(ctxBde, { id: 'b' }, mk(-90), []).can && !IM.startState(ctxBde, { id: 'b' }, mk(-180), []).can);
    check('U26 Admin can always start (a day early, a day late)', IM.startState(ctxAdmin, { id: 'a', role: 'ADMIN' }, mk(1440), []).can && IM.startState(ctxAdmin, { id: 'a', role: 'ADMIN' }, mk(-1440), []).can);
    check('U27 no Meet link: label "Add the Meet link first"; in person: no link needed', (() => { const s = IM.startState(ctxBde, { id: 'b' }, mk(5, { interviewMeetingLink: null }), []); const p = IM.startState(ctxBde, { id: 'b' }, mk(5, { interviewMode: 'In Person', interviewMeetingLink: null }), []); return s.needsLink && s.label === 'Add the Meet link first' && !p.needsLink && p.label === 'Start interview'; })());
    check('U28 recruiter: sees no Start unless named (panel id or by name); the TL of the job and the booker can', !IM.startState(ctxNone, { id: 'r', name: 'Rita Rec' }, mk(5), []).show && IM.startState(ctxNone, named, mk(5), ['u1']).show && IM.startState(ctxNone, named, mk(5, { interviewer: 'Sam, Pat Named' }), []).show && IM.startState(ctxNone, { id: 'tlx', name: 'T' }, mk(5), []).show && IM.startState(ctxNone, { id: 'q', name: 'Booker' }, mk(5), []).show);
    check('U29 over / cancelled interviews show no Start; an already Started one stays "Join Meet"', !IM.startState(ctxBde, { id: 'b' }, mk(5, { interviewStatus: 'CANCELLED' }), []).show && !IM.startState(ctxBde, { id: 'b' }, mk(5, { interviewStatus: 'PENDING_FEEDBACK' }), []).show && IM.startState(ctxBde, { id: 'b' }, mk(-500, { interviewStatus: 'STARTED' }), []).label === 'Join Meet');

    // ============================ H: API ======================================
    await prisma.appSetting.deleteMany({ where: { key: IM.KEY } });
    const g0 = await call('GET', '/api/ats/interview-meet/settings', T.admin);
    check('H1 Admin reads the settings (defaults) and the mail state', g0.status === 200 && g0.body.canEdit === true && g0.body.settings.emailCandidate === true && typeof g0.body.mailReady === 'boolean', g0.text.slice(0, 200));
    const p1 = await call('PUT', '/api/ats/interview-meet/settings', T.rec, { emailCandidate: false });
    check('H2 a recruiter cannot change the settings (403)', p1.status === 403, p1.status);
    const p2 = await call('PUT', '/api/ats/interview-meet/settings', T.admin, { defaultMeetLink: 'not a link' });
    check('H3 a bad default Meet link is refused (400)', p2.status === 400, [p2.status, p2.text.slice(0, 120)]);
    const p3 = await call('PUT', '/api/ats/interview-meet/settings', T.admin, { defaultMeetLink: 'https://meet.google.com/zzz-yyyy-xxx', startBeforeMin: 15 });
    check('H4 Admin saves the standing default Meet link', p3.status === 200 && p3.body.settings.defaultMeetLink === 'https://meet.google.com/zzz-yyyy-xxx', p3.text.slice(0, 160));
    const g1 = await call('GET', '/api/ats/interview-meet/settings', T.bde);
    const g2 = await call('GET', '/api/ats/interview-meet/settings', T.rec);
    check('H5 the BDE sees the default link (one click); a recruiter does not', g1.body.settings.defaultMeetLink === 'https://meet.google.com/zzz-yyyy-xxx' && g2.body.settings.defaultMeetLink === '' && g2.body.canEdit === false, [g1.body && g1.body.settings, g2.body && g2.body.settings]);

    // booking
    const cand3 = await mkCand('book', `zz.book.${RUN}@zzmeet-sandbox.in`);
    const app3 = await mkApp(cand3, { stage: 'CLIENT_SHORTLISTED' });
    const dayAfter = new Date(Date.now() + 49 * 3600000);
    const bookBody = { date: ymdIST(dayAfter), time: hmIST(dayAfter), mode: 'Online', meetingLink: 'https://meet.google.com/abc-defg-hij', panel: [{ name: 'Dr Outside', email: OUT_EMAIL }] };
    const bRec = await call('POST', `/api/ats/interviews/${app3.id}/book`, T.rec, bookBody);
    check('H6 a recruiter still cannot book (403, unchanged rule)', bRec.status === 403, [bRec.status, bRec.text.slice(0, 120)]);
    const bBad = await call('POST', `/api/ats/interviews/${app3.id}/book`, T.bde, { ...bookBody, meetingLink: 'https://meet.google.com/abc' });
    check('H7 a half Meet link is refused with a plain message', bBad.status === 400 && /Meet link/i.test(bBad.text), [bBad.status, bBad.text.slice(0, 160)]);
    const bOk = await call('POST', `/api/ats/interviews/${app3.id}/book`, T.bde, bookBody);
    check('H8 the BDE books: 200, the Meet link is stored, the result says who was e-mailed', bOk.status === 200 && bOk.body.meetingLink === 'https://meet.google.com/abc-defg-hij' && bOk.body.invites && bOk.body.invites.sent >= 2 && /Email sent to/.test(bOk.body.message), [bOk.status, bOk.text.slice(0, 400)]);
    const row3 = await prisma.application.findUnique({ where: { id: app3.id } });
    check('H9 the link is on the interview (Online, Meet link saved)', row3.interviewMeetingLink === 'https://meet.google.com/abc-defg-hij' && row3.interviewMode === 'Online' && row3.interviewStatus === 'SCHEDULED', row3);
    const ml = await call('GET', `/api/ats/interviews/${app3.id}/mail`, T.bde);
    const mrows = (ml.body && ml.body.rows) || [];
    check('H10 the card shows "Email sent" per person (candidate + outside interviewer), addresses masked, Resend allowed for the BDE', ml.status === 200 && mrows.some((x) => x.key === 'candidate' && x.status === 'sent') && mrows.some((x) => x.role.includes('Interviewer') && x.status === 'sent') && !ml.text.includes(`zz.book.${RUN}@`) && ml.body.canResend === true, ml.text.slice(0, 400));
    const mCand = await prisma.candidateMessage.count({ where: { candidateId: cand3.id, channel: 'Email', template: 'INTERVIEW_SCHEDULED' } });
    check('H11 the candidate gets ONE booking e-mail record, not two', mCand === 1, mCand);
    const wBook = await call('POST', `/api/ats/interviews/${app3.id}/book`, T.bde, { ...bookBody, mode: 'Online', meetingLink: 'https://zoom.us/j/123' });
    check('H12 booking over a live slot is still refused (409), unchanged', wBook.status === 409, wBook.status);
    // other-mode booking with a non-Meet link on another app
    const cand4 = await mkCand('zoom', `zz.zoom.${RUN}@zzmeet-sandbox.in`);
    const app4 = await mkApp(cand4, { stage: 'CLIENT_SHORTLISTED' });
    const bZoom = await call('POST', `/api/ats/interviews/${app4.id}/book`, T.bde, { ...bookBody, meetingLink: 'https://zoom.us/j/123456' });
    check('H13 another https meeting link is accepted with a warning', bZoom.status === 200 && /not a Google Meet link/i.test(bZoom.body.linkWarning || ''), [bZoom.status, bZoom.body && bZoom.body.linkWarning]);
    // resend
    const rsR = await call('POST', `/api/ats/interviews/${app3.id}/mail/resend`, T.rec, {});
    const rsB = await call('POST', `/api/ats/interviews/${app3.id}/mail/resend`, T.bde, { key: 'candidate' });
    check('H14 Resend: a recruiter is refused (403); the BDE can resend to one person', rsR.status === 403 && rsB.status === 200 && rsB.body.rows.find((x) => x.key === 'candidate').status === 'sent', [rsR.status, rsB.status, rsB.text.slice(0, 200)]);

    // reschedule / cancel through the existing routes
    const resch = await call('POST', `/api/ats/interviews/${app3.id}/reschedule`, T.admin, { interviewAt: new Date(Date.now() + 75 * 3600000).toISOString(), reason: 'ZZ test move' });
    check('H15 reschedule: 200 and the e-mail result is in the reply', resch.status === 200 && resch.body.invites && resch.body.invites.sent >= 1, [resch.status, resch.text.slice(0, 300)]);
    const seqAfter = (await IM.readRecord(app3.id)).sequence;
    check('H16 the calendar SEQUENCE grew on the move (booking 0, resend same, move 1)', seqAfter === 1, seqAfter);
    const canc = await call('POST', `/api/ats/interviews/${app3.id}/cancel`, T.admin, { reason: 'ZZ test cancel' });
    const mAfter = await call('GET', `/api/ats/interviews/${app3.id}/mail`, T.admin);
    check('H17 cancel: 200, the cancel e-mail went (event cancelled, sent)', canc.status === 200 && canc.body.invites && canc.body.invites.sent >= 1 && mAfter.body.event === 'cancelled', [canc.status, canc.text.slice(0, 300)]);

    // start
    const app5Cand = await mkCand('start', `zz.start.${RUN}@zzmeet-sandbox.in`);
    const app5 = await mkApp(app5Cand, { stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 3 * 3600000), interviewMode: 'Online', interviewMeetingLink: 'https://meet.google.com/abc-defg-hij', interviewer: uRec.name, interviewRound: 1, interviewCreatedBy: uBde.name });
    await prisma.interviewPanelist.create({ data: { applicationId: app5.id, round: 1, userId: uRec.id, name: uRec.name, email: uRec.email, position: 0 } });
    const cal = await call('GET', '/api/ats/calendar', T.rec);
    const calRow = ((cal.body && cal.body.recruitment) || []).find((r) => r.id === app5.id);
    check('H18 the interview card knows: the named interviewer sees a disabled Start with the plain reason', cal.status === 200 && calRow && calRow.start && calRow.start.show === true && calRow.start.can === false && calRow.start.reason === 'Opens 15 minutes before the interview' && calRow.meetingLink === 'https://meet.google.com/abc-defg-hij', calRow && calRow.start);
    const calRec = await call('GET', '/api/ats/calendar', T.recNamed);
    const calRowRec = ((calRec.body && calRec.body.recruitment) || []).find((r) => r.id === app5.id);
    check('H19 another recruiter of the department has no Start button (card absent or Start hidden)', !calRowRec || (calRowRec.start && calRowRec.start.show === false), calRowRec && calRowRec.start);
    const sEarly = await call('POST', `/api/ats/interviews/${app5.id}/start`, T.rec, {});
    check('H20 start too early by the interviewer: 409 with the plain reason; nothing changes', sEarly.status === 409 && /Opens 15 minutes before/.test(sEarly.text) && (await prisma.application.findUnique({ where: { id: app5.id } })).interviewStatus === 'SCHEDULED', [sEarly.status, sEarly.text.slice(0, 200)]);
    const sRec = await call('POST', `/api/ats/interviews/${app5.id}/start`, T.recNamed, {});
    check('H21 a recruiter who is not the interviewer cannot start (403)', sRec.status === 403, sRec.status);
    const sOther = await call('POST', `/api/ats/interviews/${app5.id}/start`, T.recOther, {});
    const mOther = await call('GET', `/api/ats/interviews/${app5.id}/mail`, T.recOther);
    const calOther = await call('GET', '/api/ats/calendar', T.recOther);
    check('H22 an outsider (another department) cannot start, read the mail status or see the card / link (403 / absent)', [403, 404].includes(sOther.status) && [403, 404].includes(mOther.status) && !JSON.stringify(calOther.body || {}).includes('abc-defg-hij'), [sOther.status, mOther.status]);
    const sAdmin = await call('POST', `/api/ats/interviews/${app5.id}/start`, T.admin, {});
    const a5 = await prisma.application.findUnique({ where: { id: app5.id } });
    const ev5 = await prisma.interviewEvent.findMany({ where: { applicationId: app5.id, status: 'STARTED' } });
    const aud5 = await prisma.auditLog.findMany({ where: { entityId: app5.id, action: { startsWith: 'Interview started by' } } });
    check('H23 Admin starts a day-early... (3 h early): 200, link returned, status STARTED, started time stored, event "started by <name>" and audit written',
      sAdmin.status === 200 && sAdmin.body.meetingLink === 'https://meet.google.com/abc-defg-hij' && a5.interviewStatus === 'STARTED' && !!a5.interviewStartedAt && ev5.length === 1 && /Interview started by ZZTEST Meet admin/.test(ev5[0].reason) && aud5.length === 1, [sAdmin.status, sAdmin.text.slice(0, 200), ev5]);
    const sAgain = await call('POST', `/api/ats/interviews/${app5.id}/start`, T.rec, {});
    check('H24 pressing again (the named interviewer, "Join Meet"): 200, no second event / audit', sAgain.status === 200 && (await prisma.interviewEvent.count({ where: { applicationId: app5.id, status: 'STARTED' } })) === 1 && (await prisma.auditLog.count({ where: { entityId: app5.id, action: { startsWith: 'Interview started by' } } })) === 1, [sAgain.status, sAgain.text.slice(0, 150)]);

    // inside the window: named interviewer + TL + BDE
    const cand6 = await mkCand('window', `zz.win.${RUN}@zzmeet-sandbox.in`);
    const app6 = await mkApp(cand6, { stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: soon, interviewMode: 'Online', interviewMeetingLink: null, interviewer: uRec.name, interviewRound: 1, interviewCreatedBy: uBde.name });
    await prisma.interviewPanelist.create({ data: { applicationId: app6.id, round: 1, userId: uRec.id, name: uRec.name, email: uRec.email, position: 0 } });
    const sNoLink = await call('POST', `/api/ats/interviews/${app6.id}/start`, T.rec, {});
    check('H25 no Meet link: start answers "Add the Meet link first" (needsLink)', sNoLink.status === 409 && sNoLink.body.needsLink === true && /Add the Meet link first/.test(sNoLink.text), [sNoLink.status, sNoLink.text.slice(0, 150)]);
    const lkBad = await call('PUT', `/api/ats/interviews/${app6.id}/meet-link`, T.rec, { meetingLink: 'nope' });
    const lkRec = await call('PUT', `/api/ats/interviews/${app6.id}/meet-link`, T.recNamed, { meetingLink: 'https://meet.google.com/abc-defg-hij' });
    const lkOk = await call('PUT', `/api/ats/interviews/${app6.id}/meet-link`, T.rec, { meetingLink: 'https://meet.google.com/abc-defg-hij' });
    check('H26 paste the link: bad refused; a non-interviewer recruiter refused; the interviewer saves it', lkBad.status === 400 && lkRec.status === 403 && lkOk.status === 200 && lkOk.body.kind === 'meet', [lkBad.status, lkRec.status, lkOk.status]);
    const sTl = await call('POST', `/api/ats/interviews/${app6.id}/start`, T.tl, {});
    check('H27 inside the window the TL of the job starts it: 200, status Started', sTl.status === 200 && (await prisma.application.findUnique({ where: { id: app6.id } })).interviewStatus === 'STARTED', [sTl.status, sTl.text.slice(0, 200)]);

    // offline
    const cand7 = await mkCand('offline', `zz.off.${RUN}@zzmeet-sandbox.in`);
    const app7 = await mkApp(cand7, { stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: soon, interviewMode: 'In Person', interviewLocation: 'ZZ Clinic, Road 5', interviewer: uRec.name, interviewRound: 1, interviewCreatedBy: uBde.name });
    const sOff = await call('POST', `/api/ats/interviews/${app7.id}/start`, T.bde, {});
    check('H28 offline interview: start just marks it started and returns the address (no link)', sOff.status === 200 && sOff.body.online === false && sOff.body.meetingLink === null && sOff.body.address === 'ZZ Clinic, Road 5', [sOff.status, sOff.text.slice(0, 200)]);
    const sCancelled = await call('POST', `/api/ats/interviews/${app3.id}/start`, T.admin, {});
    check('H29 a cancelled interview cannot be started (409)', sCancelled.status === 409, sCancelled.status);
    const sNone = await call('POST', `/api/ats/interviews/${app5.id}/start`, null, {});
    check('H30 no login: 401', sNone.status === 401, sNone.status);
  } catch (e) {
    fail += 1; console.error('TEST CRASH', e);
  } finally {
    IM.setMailer(null);
    try {
      const appIds = made.apps; const candIds = made.cands; const reqIds = made.reqs;
      if (settingBefore) await prisma.appSetting.upsert({ where: { key: IM.KEY }, create: { key: IM.KEY, value: settingBefore.value }, update: { value: settingBefore.value } }).catch(() => {});
      else await prisma.appSetting.deleteMany({ where: { key: IM.KEY } }).catch(() => {});
      await prisma.appSetting.deleteMany({ where: { key: { in: appIds.map((id) => `${IM.MAIL_PREFIX}${id}`) } } }).catch(() => {});
      for (const id of candIds) {
        await prisma.$executeRawUnsafe('DELETE FROM "ConversationMessage" WHERE personId = ?', id).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Conversation" WHERE personId = ?', id).catch(() => {});
      }
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } }).catch(() => {});
      await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
      await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
      await prisma.interviewEvent.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.interviewPanelist.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: appIds } } });
      await prisma.candidate.deleteMany({ where: { id: { in: candIds } } });
      await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...appIds, ...reqIds, ...candIds, ...made.users, IM.KEY] } }] } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      const left = {
        users: await prisma.user.count({ where: { email: { contains: `-${RUN}@example.test` } } }),
        cands: await prisma.candidate.count({ where: { name: { contains: RUN } } }),
        reqs: await prisma.requirement.count({ where: { title: { contains: RUN } } }),
        clients: await prisma.client.count({ where: { name: { contains: RUN } } }),
        msgs: await prisma.candidateMessage.count({ where: { candidateId: { in: made.cands } } }),
        settings: await prisma.appSetting.count({ where: { key: { startsWith: IM.MAIL_PREFIX }, value: { contains: RUN } } }),
        events: await prisma.interviewEvent.count({ where: { applicationId: { in: made.apps } } }),
      };
      console.log('leftovers after cleanup:', JSON.stringify(left));
      check('Z cleanup: nothing ZZTEST of this run is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\nINTERVIEW EMAIL + MEET TESTS: ${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();

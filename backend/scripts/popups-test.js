#!/usr/bin/env node
/**
 * CLIENT UPDATES -> POP-UP + MAIL, INTERVIEW POP-UPS, THE UPDATES & REPORTS CENTRE, AUTO-SCREENING (founder 2026-11-23).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; nothing real is sent (the sandbox mailer is fake).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4512 node scripts/popups-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-popups-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4512;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'popups-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const RUN = Date.now().toString(36);
const mk = (tag, data) => prisma.user.create({ data: { name: `Pp ${tag} ${RUN}`, email: `pp.${tag}.${RUN}@pp-test.in`, username: `pp.${tag}.${RUN}@pp-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', accountsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const MAILED = ['sent', 'not-configured', 'failed', 'skipped'];

(async () => {
  const U = require('../src/utils/atsUpdates');
  await U.ensure();
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const ad2 = await mk('admin2', { role: 'ADMIN', atsRole: 'ADMIN' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const bdetl = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const recX = await mk('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const tlX = await mk('tlx', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const client = await prisma.client.create({ data: { name: `Ppnova Labs ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE', bdeOwner: bde.name } });
  const cu = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: client.id, portalType: 'REVIEWER', portalPerms: 'VIEW,AGREEMENT,REQUEST,DECIDE,INTERVIEW,FEEDBACK,OFFERS' });
  const req = await prisma.requirement.create({ data: { title: `Ppcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', priority: 'High', tlId: tl.id, tl: tl.name, recruiterId: rec.id, bdeId: bde.id, reqCode: `PP-${RUN}`.toUpperCase().slice(0, 14), openings: 2, skills: 'Kubernetes, Docker', experience: '2-5 years', noticePeriodMax: '30 days', location: 'Hyderabad' } });
  const mkCand = (tag, data = {}) => prisma.candidate.create({ data: { name: `Ppperson ${tag} ${RUN}`, phone: `9${String(Date.now() + Math.floor(Math.random() * 1e6)).slice(-9)}`, email: `pp.c.${tag}.${RUN}@pp-test.in`, ...data } });
  const cand = await mkCand('one', { skills: 'Kubernetes' });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'SHARED_WITH_CLIENT' } });
  await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: cand.id, fromStage: 'TL_REVIEW', toStage: 'SHARED_WITH_CLIENT', action: 'Shared with client', actorName: 'test' } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(500); // eslint-disable-line no-await-in-loop
  }
  await sleep(1200);
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {};
  for (const [k, u] of Object.entries({ sa, ad2, bde, bdetl, tl, rec, recX, tlX, cu })) T[k] = await tok(u); // eslint-disable-line no-await-in-loop
  const popups = async (k) => ((await call('GET', '/ats-updates/popups', null, T[k])).body || []);
  const recRow = async (eventId, userId) => (await prisma.$queryRawUnsafe('SELECT * FROM "AtsUpdateRecipient" WHERE "eventId" = ? AND "userId" = ?', eventId, userId))[0] || null;
  const waitEvent = async (pred, ms = 8000) => { for (let t = 0; t < ms; t += 250) { const rows = await prisma.$queryRawUnsafe('SELECT * FROM "AtsUpdateEvent" ORDER BY "createdAt" DESC LIMIT 5'); const e = rows.find(pred); if (e) return e; await sleep(250); } return null; }; // eslint-disable-line no-await-in-loop

  // ---- settings: defaults ON, Admin only
  const st0 = await call('GET', '/ats-updates/settings', null, T.sa);
  check('settings: every client event type has pop-up ON and mail ON by default', st0.status === 200 && Object.entries(st0.body.settings.types).filter(([k]) => k.startsWith('client_')).every(([, t]) => t.popup && t.mail) && Object.keys(st0.body.settings.types).filter((k) => k.startsWith('client_')).length === 7 /* + the 7 team kinds (2026-11-27): pop-up on, mail off */ && st0.body.settings.digestMinutes === 15, st0.body);
  check('settings: a recruiter cannot open them', (await call('GET', '/ats-updates/settings', null, T.rec)).status === 403);
  check('settings: a recruiter cannot change them', (await call('PUT', '/ats-updates/settings', { types: { client_feedback: { popup: false } } }, T.rec)).status === 403);

  // ---- 1. a client shortlists through the portal (the real door)
  const sl = await call('POST', `/job-portal/client/applications/${app.id}/decision`, { decision: 'SHORTLIST', comment: `Good profile, call me on 98765 43210 or boss@ppnova.in ${RUN}` }, T.cu);
  check('the client shortlists in the portal', [200, 201].includes(sl.status), sl.body);
  const e1 = await waitEvent((e) => e.applicationId === app.id && e.type === 'client_feedback');
  check('one client-update event is written (client_feedback)', !!e1, e1);

  const settle = async (ev) => { for (let t = 0; ev && t < 10000; t += 250) { const n = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsUpdateRecipient" WHERE "eventId" = ? AND "mail" = ?', ev.id, 'pending'); if (!Number(n[0].n)) return; await sleep(250); } }; // eslint-disable-line no-await-in-loop
  await settle(e1);
  const P = {};
  for (const k of ['rec', 'bde', 'tl', 'bdetl', 'sa', 'recX', 'tlX', 'ad2']) P[k] = (await popups(k)).filter((p) => e1 && p.eventId === e1.id); // eslint-disable-line no-await-in-loop
  check('pop-up: the recruiter of the job', P.rec.length === 1 && /shortlisted/.test(P.rec[0].title) && P.rec[0].title.includes(cand.name), P.rec);
  check('pop-up: the client BDE (owner)', P.bde.length === 1);
  check('pop-up: the job TL', P.tl.length === 1);
  check('pop-up: the BDE TL', P.bdetl.length === 1);
  check('pop-up: the Super Admin and the Admin', P.sa.length === 1 && P.ad2.length === 1);
  check('scope: a recruiter not on the job gets nothing', P.recX.length === 0);
  check('scope: a TL of another department gets nothing', P.tlX.length === 0);
  check('the client note never carries a phone number or e-mail (BDE limited view)', P.bde[0] && /\[number hidden\]/.test(P.bde[0].summary) && /\[e-mail hidden\]/.test(P.bde[0].summary) && !/98765/.test(P.bde[0].summary), P.bde[0]);
  check('who / what / when / Open are on the pop-up', P.rec[0] && /client/.test(P.rec[0].by) && P.rec[0].at && P.rec[0].open === `/candidates/${cand.id}?app=${app.id}`, P.rec[0]);
  const bell = await prisma.notification.findMany({ where: { recipient: `cu|${e1 && e1.id}` } });
  check('a bell row for each person (one per person)', bell.length >= 6 && new Set(bell.map((n) => n.userId)).size === bell.length && !bell.some((n) => n.userId === cu.id));
  if (!e1) { console.log('no event - stopping'); await stop(1); return; }
  const r1 = await recRow(e1.id, rec.id);
  check('mail: one mail per person for this event (sandbox send recorded)', r1 && MAILED.includes(r1.mail) && !!r1.mailAt, r1);
  check('scope (unit): mayHear says no for the other recruiter, yes for the job recruiter', !(await U.mayHear(recX, { type: 'client_feedback', applicationId: app.id })) && (await U.mayHear(rec, { type: 'client_feedback', applicationId: app.id })));

  // ---- ack / re-show at the next login
  const ack = await call('POST', '/ats-updates/popups/seen', { ids: [e1.id] }, T.rec);
  check('"Got it" hides the pop-up for that person', ack.status === 200 && (await popups('rec')).every((p) => p.eventId !== e1.id));
  check('it stays for the others until they press it (shows at the next login)', (await popups('bde')).some((p) => p.eventId === e1.id));
  const tokAgain = await tok(bde);
  check('a fresh login (new token) still sees the unseen pop-up', ((await call('GET', '/ats-updates/popups', null, tokAgain)).body || []).some((p) => p.eventId === e1.id));
  const r1b = await recRow(e1.id, rec.id);
  check('audit: seen time is kept on the person row', !!r1b.seenAt);
  const opened = await call('POST', '/ats-updates/popups/seen', { ids: [e1.id], opened: true }, T.bde);
  check('Open marks it seen + opened and the bell row read', opened.status === 200 && !!(await recRow(e1.id, bde.id)).openedAt && (await prisma.notification.findFirst({ where: { userId: bde.id, recipient: `cu|${e1.id}` } })).read === true);

  // ---- 2. request an interview -> client_interview; a concern -> client_message (client-level: BDE side + Admins only)
  const ri = await call('POST', `/job-portal/client/applications/${app.id}/decision`, { decision: 'REQUEST_INTERVIEW' }, T.cu);
  const e2 = await waitEvent((e) => e.applicationId === app.id && e.type === 'client_interview');
  await settle(e2);
  check('client asks for an interview -> a client_interview update', [200, 201].includes(ri.status) && !!e2, ri.body);
  const cc = await call('POST', '/portal/client/concerns', { subject: `Please call back ${RUN}`, details: 'We need faster profiles' }, T.cu);
  const e3 = await waitEvent((e) => e.type === 'client_message' && e.clientId === client.id);
  await settle(e3);
  check('client writes a concern -> a client_message update', cc.status === 201 && !!e3, cc.body);
  check('client message: the BDE gets it, the job recruiter does not (client-level)', e3 && !!(await recRow(e3.id, bde.id)) && !(await recRow(e3.id, rec.id)));

  // ---- digest: three updates within the window -> the first mailed, the next two wait for ONE digest
  const bdeFirst = await recRow(e2.id, bde.id);
  const bdeThird = await recRow(e3.id, bde.id);
  check('digest: updates soon after a mail wait for the digest', bdeFirst && bdeThird && bdeThird.mail === 'digest', [bdeFirst && bdeFirst.mail, bdeThird && bdeThird.mail]);
  const notYet = await U.flushDigests({ now: new Date() });
  check('digest: nothing goes before the 15 minutes', !notYet.some((d) => d.userId === bde.id));
  const flushed = await U.flushDigests({ now: new Date(Date.now() + 16 * 60000) });
  const mine = flushed.filter((d) => d.userId === bde.id);
  check('digest: after 15 minutes ONE mail with all the waiting updates', mine.length === 1 && mine[0].count >= 1, flushed.slice(0, 5));
  check('digest: the rows say they went in the digest', (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsUpdateRecipient" WHERE "userId" = ? AND "mail" = \'digest\'', bde.id))[0].n == 0); // eslint-disable-line eqeqeq
  check('digest: a second flush sends nothing more', !(await U.flushDigests({ now: new Date(Date.now() + 40 * 60000) })).some((d) => d.userId === bde.id));

  // ---- settings: pop-up OFF / mail OFF per type, mute, Admin off
  await call('PUT', '/ats-updates/settings', { types: { client_feedback: { popup: false, mail: false } } }, T.sa);
  const e4 = await U.publish({ type: 'client_feedback', applicationId: app.id, title: `${client.name} put ${cand.name} on hold`, summary: 'later', actor: { id: cu.id, name: 'X (client)' } });
  const r4 = e4 && await recRow(e4.id, rec.id);
  check('pop-up OFF for the type: no pop-up, still on the bell / centre', r4 && Number(r4.popup) === 0 && !(await popups('rec')).some((p) => p.eventId === e4.id) && !!(await prisma.notification.findFirst({ where: { userId: rec.id, recipient: `cu|${e4.id}` } })), r4);
  check('mail OFF for the type: no mail', r4 && r4.mail === 'off');
  await call('PUT', '/ats-updates/settings', { types: { client_feedback: { popup: true, mail: true } } }, T.sa);
  const mute = await call('PUT', '/ats-updates/me', { muteMail: true, adminOff: true }, T.rec);
  check('a person mutes their mails (a recruiter cannot switch themselves off)', mute.status === 200 && mute.body.muteMail === true && mute.body.adminOff === false, mute.body);
  const off = await call('PUT', '/ats-updates/me', { adminOff: true }, T.ad2);
  check('an Admin switches themselves off', off.body && off.body.adminOff === true);
  const e5 = await U.publish({ type: 'client_feedback', applicationId: app.id, title: `${client.name} rejected ${cand.name}`, actor: { id: cu.id, name: 'X (client)' } });
  check('muted: the pop-up still comes, the mail does not', (await recRow(e5.id, rec.id)).mail === 'muted' && Number((await recRow(e5.id, rec.id)).popup) === 1);
  check('Admin switched off: nothing for that Admin, the Super Admin still gets it', !(await recRow(e5.id, ad2.id)) && !!(await recRow(e5.id, sa.id)));
  await call('PUT', '/ats-updates/me', { muteMail: false }, T.rec);

  // ---- agreement signed: BDE side + Admins only
  const e6 = await U.publish({ type: 'client_agreement', clientId: client.id, title: `${client.name} signed the agreement`, actor: { id: null, name: 'Signer (client)' } });
  check('agreement: the BDE and the BDE TL get it', !!(await recRow(e6.id, bde.id)) && !!(await recRow(e6.id, bdetl.id)));
  check('agreement: never the TL or a recruiter', !(await recRow(e6.id, tl.id)) && !(await recRow(e6.id, rec.id)));
  const e7 = await U.publish({ type: 'client_requirement', requirementId: req.id, title: `${client.name} asked to change ${req.title}`, actor: { id: cu.id, name: 'X (client)' } });
  check('requirement change: the job TL and recruiter get it, a TL of another department does not', !!(await recRow(e7.id, tl.id)) && !!(await recRow(e7.id, rec.id)) && !(await recRow(e7.id, tlX.id)));
  check('the acting person is never told about their own action', !(await recRow(e7.id, cu.id)));

  // ---- 3. interviews: 60 and 15 minutes, no double pop-ups, today's list, the morning mail, the mail 60 minutes before
  const cand2 = await mkCand('two', { skills: 'Docker' });
  const at = new Date(Date.now() + 50 * 60000);
  const iv = await prisma.application.create({ data: { candidateId: cand2.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: at, interviewMode: 'Online', interviewMeetingLink: 'https://meet.example.org/pp', interviewRound: 1 } });
  const IN = require('../src/utils/interviewNotices');
  await IN.runInterviewReminders({ now: new Date(), onlyIds: [iv.id] });
  const ivp1 = (await call('GET', '/admin/notifications/interview-popups', null, T.rec)).body || [];
  check('60 minutes before: the interview pop-up for the recruiter', ivp1.length === 1 && ivp1[0].applicationId === iv.id, ivp1);
  check('60 minutes before: the BDE gets it too', ((await call('GET', '/admin/notifications/interview-popups', null, T.bde)).body || []).some((x) => x.applicationId === iv.id));
  await IN.runInterviewReminders({ now: new Date(at.getTime() - 10 * 60000), onlyIds: [iv.id] });
  const ivp2 = (await call('GET', '/admin/notifications/interview-popups', null, T.rec)).body || [];
  const min15 = await prisma.notification.findMany({ where: { userId: rec.id, recipient: { startsWith: `interview|min15|${iv.id}|` } } });
  check('15 minutes before: one more pop-up', min15.length === 1 && /minutes/.test(min15[0].title), min15.map((n) => n.title));
  check('no double pop-ups: still ONE card for the interview, showing the 15-minute note only', ivp2.length === 1 && ivp2[0].ids.length === 1 && ivp2[0].ids[0] === min15[0].id, ivp2);
  await IN.runInterviewReminders({ now: new Date(at.getTime() - 8 * 60000), onlyIds: [iv.id] });
  check('the 15-minute pop-up is written once', (await prisma.notification.count({ where: { userId: rec.id, recipient: { startsWith: `interview|min15|${iv.id}|` } } })) === 1);
  const today = await call('GET', '/ats-updates/interviews-today', null, T.rec);
  const ti = ((today.body && today.body.items) || []).find((i) => i.applicationId === iv.id);
  check('"Your interviews today": time, candidate, requirement, client, mode, link', ti && ti.time && ti.candidate === cand2.name && ti.job === req.title && ti.client === client.name && ti.mode === 'Online' && ti.link, today.body);
  check('"Your interviews today" pops up once at login', today.body.popup === true);
  check('"Your interviews today": the BDE and the TL see it, the other recruiter does not', ((await call('GET', '/ats-updates/interviews-today', null, T.bde)).body.items || []).some((i) => i.applicationId === iv.id)
    && ((await call('GET', '/ats-updates/interviews-today', null, T.tl)).body.items || []).some((i) => i.applicationId === iv.id)
    && !((await call('GET', '/ats-updates/interviews-today', null, T.recX)).body.items || []).some((i) => i.applicationId === iv.id));
  await call('POST', '/ats-updates/interviews-today/seen', {}, T.rec);
  check('"Got it" on today\'s list: no pop-up again today, the list stays on the dashboard', (await call('GET', '/ats-updates/interviews-today', null, T.rec)).body.popup === false && (await call('GET', '/ats-updates/interviews-today', null, T.rec)).body.items.length >= 1);
  const day = U.istDay(new Date());
  const morning = new Date(`${day}T08:05:00+05:30`);
  const m1 = await U.sweepInterviewMails({ now: morning > new Date(at.getTime() - 30 * 60000) ? new Date() : morning });
  const claimsDay = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsUpdateClaim" WHERE "key" = ?', `ivm|day|${rec.id}|${day}`);
  check('morning mail (08:00): the recruiter gets the day\'s list', m1.skipped ? true : Number(claimsDay[0].n) === 1, m1);
  await U.sweepInterviewMails({ now: new Date() });
  await U.sweepInterviewMails({ now: new Date() });
  const claimsHour = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsUpdateClaim" WHERE "key" LIKE ?', `ivm|hour|${iv.id}|%|${rec.id}`);
  const claimsDay2 = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsUpdateClaim" WHERE "key" = ?', `ivm|day|${rec.id}|${day}`);
  check('mail 60 minutes before: once per person, never twice; the morning mail never twice', m1.skipped ? true : (Number(claimsHour[0].n) === 1 && Number(claimsDay2[0].n) === 1), [claimsHour, claimsDay2]);

  // ---- 4. the Updates & Reports centre
  const { pushNotification } = require('../src/utils/notify');
  await pushNotification({ userId: rec.id, title: 'Alert: Overdue follow-ups above 5', message: 'It is 7 now', open: '/dashboard' });
  await pushNotification({ userId: rec.id, title: 'Follow-up overdue: Ppperson', message: 'Call back today', open: '/ats/followups' });
  await prisma.notification.create({ data: { userId: rec.id, title: 'Report: My dashboard', message: 'Your scheduled dashboard - mailed to you\nOpen: /ats/dashboard', channel: 'In-App', recipient: 'report|sched|x1', status: 'Sent' } });
  // NOT ATS (founder 2026-11-23): CRM, AI Marketing approvals, tasks / timesheets (HRMS), invoices (Accounts) stay in the bell only
  await pushNotification({ userId: rec.id, title: 'CRM follow-up late — Teamlink', message: 'TeamLink call at 11:00', open: '/crm/followups' });
  await pushNotification({ userId: rec.id, title: 'Client approved "Warmest Wishes · 1"', message: 'It is now Approved and can be used in the Content Calendar. Open Omni-Channel > AI Marketing > Approvals.' });
  await pushNotification({ userId: rec.id, title: '2 tasks you gave are late', message: '-Fill Tax & billing', open: '/employee-services?tab=timesheet' });
  await pushNotification({ userId: rec.id, title: 'Proof missing — invoice TY1', message: 'Upload the proof', open: '/accounts/dashboard#proof' });
  await pushNotification({ userId: rec.id, title: 'Requirement REQ-0999 assigned to you', message: 'Pharmacist', open: `/requirements/${req.id}` });
  const f = await call('GET', '/ats-updates/feed?limit=200', null, T.rec);
  const kinds = new Set(((f.body && f.body.rows) || []).map((r) => r.kind));
  check('centre: client updates, interviews, metric alerts, follow-ups and reports in one list', ['client', 'interview', 'alert', 'followup', 'report'].every((k) => kinds.has(k)), [...kinds]);
  check('centre: the reports of the day (daily report, follow-up report, reminders going out) are listed with links', f.body.rows.filter((r) => r.virtual).length >= 3 && f.body.rows.some((r) => r.open === '/reports/ats?tab=daily'));
  check('centre: CRM, AI Marketing, tasks and invoices are NOT on the ATS dashboard', !f.body.rows.some((r) => /CRM follow-up|Warmest Wishes|tasks you gave|Proof missing/.test(r.title)), f.body.rows.map((r) => r.title).slice(0, 12));
  check('centre: ATS notices (a requirement assigned) still are', f.body.rows.some((r) => /REQ-0999/.test(r.title)));
  check('centre: newest first', f.body.rows.every((r, i, a) => i === 0 || a[i - 1].at >= r.at));
  check('centre: unread counts per type', f.body.counts.client.unread >= 1 && f.body.counts.report.unread >= 3 && typeof f.body.unread === 'number', f.body.counts);
  const fc = await call('GET', '/ats-updates/feed?type=client', null, T.rec);
  check('centre filter: type', fc.body.rows.length >= 1 && fc.body.rows.every((r) => r.kind === 'client'));
  check('centre filter: date range (a future day = nothing)', (await call('GET', '/ats-updates/feed?from=2099-01-01', null, T.rec)).body.rows.length === 0);
  const unread0 = (await call('GET', '/ats-updates/feed?read=unread&type=alert', null, T.rec)).body.rows;
  check('centre filter: unread', unread0.length >= 1 && unread0.every((r) => !r.read));
  await call('POST', '/ats-updates/read', { ids: [unread0[0].id] }, T.rec);
  check('centre: mark one read', (await call('GET', '/ats-updates/feed?read=unread&type=alert', null, T.rec)).body.rows.every((r) => r.id !== unread0[0].id));
  await call('POST', '/ats-updates/read-all', { type: 'report' }, T.rec);
  check('centre: mark all read (one type)', (await call('GET', '/ats-updates/feed', null, T.rec)).body.counts.report.unread === 0);
  const clientItem = fc.body.rows.find((r) => r.sub === 'client_feedback' && /shortlisted/.test(r.title));
  check('centre: a client update opens its record', clientItem && clientItem.open && clientItem.open.startsWith('/candidates/'), clientItem);
  const fx = await call('GET', '/ats-updates/feed?type=client', null, T.recX);
  check('centre scope: the other recruiter has no client update of this job', !fx.body.rows.some((r) => r.title.includes(cand.name)));
  const readAll = await call('POST', '/ats-updates/read-all', {}, T.rec);
  check('centre: mark everything read', readAll.status === 200 && (await call('GET', '/ats-updates/feed', null, T.rec)).body.unread === 0);
  check('a client login cannot reach the centre', (await call('GET', '/ats-updates/feed', null, T.cu)).status === 403);

  // ---- 5. automatic screening
  const sj0 = await call('GET', `/ats-updates/screen/jobs/${req.id}`, null, T.tl);
  check('auto-screen: OFF by default for the job, Admin default OFF', sj0.status === 200 && sj0.body.enabled === false && sj0.body.own === false && (await call('GET', '/ats-updates/screen/settings', null, T.sa)).body.defaultOn === false, sj0.body);
  const addApp = async (c) => { const r = await call('POST', '/applications', { candidateId: c.id, requirementId: req.id, overrideReason: 'popups test setup' }, T.sa); return r.body && (r.body.id || (r.body.application && r.body.application.id)); };
  const cOff = await mkCand('off', { skills: 'Kubernetes, Docker', experienceYears: 3 });
  const aOff = await addApp(cOff);
  await sleep(3500);
  check('auto-screen OFF: a new application is not screened', !!aOff && (await call('GET', `/ats-updates/screen/applications/${aOff}`, null, T.tl)).body.result === null);
  check('auto-screen: a recruiter cannot switch it on', (await call('PUT', `/ats-updates/screen/jobs/${req.id}`, { enabled: true }, T.rec)).status === 403);
  check('auto-screen: a TL of another department cannot reach the job', (await call('PUT', `/ats-updates/screen/jobs/${req.id}`, { enabled: true }, T.tlX)).status === 404);
  const on = await call('PUT', `/ats-updates/screen/jobs/${req.id}`, { enabled: true }, T.tl);
  check('auto-screen: the job TL switches it on (suggest only)', on.status === 200 && on.body.enabled === true && on.body.act === false, on.body);
  const cPass = await mkCand('pass', { skills: 'Kubernetes, Docker', experienceYears: 3, noticePeriod: '15 days', location: 'Hyderabad', expectedSalary: '' });
  const cFail = await mkCand('fail', { skills: 'Excel', experienceYears: 0.5, noticePeriod: '90 days', location: 'Hyderabad' });
  const aPass = await addApp(cPass);
  const aFail = await addApp(cFail);
  await sleep(4500);
  const rPass = (await call('GET', `/ats-updates/screen/applications/${aPass}`, null, T.rec)).body.result;
  const rFail = (await call('GET', `/ats-updates/screen/applications/${aFail}`, null, T.rec)).body.result;
  check('auto-screen: a good fit -> Pass (or Review for unknown details) with reasons', rPass && ['Pass', 'Review'].includes(rPass.result) && rPass.checks.find((c) => c.key === 'skills').state === 'pass' && rPass.checks.find((c) => c.key === 'experience').state === 'pass', rPass);
  check('auto-screen: a poor fit -> Not suitable with the reasons (skills, experience, notice)', rFail && rFail.result === 'Not suitable' && rFail.reasons.some((x) => /Experience/.test(x)) && rFail.reasons.some((x) => /Notice/.test(x)), rFail);
  check('auto-screen: the reasons never carry pay amounts', rFail && !rFail.reasons.some((x) => /₹|\d+\s*(lpa|lakh)/i.test(x)));
  const stF = await prisma.application.findUnique({ where: { id: aFail }, select: { stage: true } });
  check('suggest only: nothing moves', stF.stage !== 'REJECTED' && stF.stage !== 'HOLD', stF);
  const list = await call('GET', '/candidates?paged=1&view=pipeline&sub=all&screening=notsuitable&pageSize=100&archived=1', null, T.sa);
  const lrows = (list.body && list.body.rows) || [];
  check('Candidates filter: Not suitable shows only those (with the chip)', list.status === 200 && lrows.length >= 1 && lrows.every((r) => r.screening && r.screening.result === 'Not suitable'), { status: list.status, n: lrows.length, first: lrows[0] && lrows[0].screening });
  const bdeRun = await call('POST', `/ats-updates/screen/applications/${app.id}/run`, null, T.bde);
  check('the BDE cannot run the screening', bdeRun.status === 403, bdeRun);
  const act = await call('PUT', `/ats-updates/screen/jobs/${req.id}`, { act: true, useFit: true }, T.tl);
  check('the TL ticks "act on the result"', act.body && act.body.act === true && act.body.useFit === true);
  const cPass2 = await mkCand('pass2', { skills: 'Kubernetes, Docker', experienceYears: 4, noticePeriod: 'Immediate', location: 'Hyderabad' });
  const cFail2 = await mkCand('fail2', { skills: 'Excel', experienceYears: 0, noticePeriod: '120 days', location: 'Pune' });
  const aPass2 = await addApp(cPass2);
  const aFail2 = await addApp(cFail2);
  await sleep(4500);
  const s2 = await prisma.application.findUnique({ where: { id: aFail2 }, select: { stage: true } });
  const rF2 = (await call('GET', `/ats-updates/screen/applications/${aFail2}`, null, T.tl)).body.result;
  check('act: Not suitable is put ON HOLD (auto-reject rule off), never rejected', s2.stage === 'HOLD' && rF2 && /hold/i.test(rF2.acted || ''), [s2, rF2 && rF2.acted]);
  check('act: the match score is an extra check when ticked', rF2 && rF2.checks.some((c) => c.key === 'fit'));
  const p2 = await prisma.application.findUnique({ where: { id: aPass2 }, select: { stage: true } });
  const rP2 = (await call('GET', `/ats-updates/screen/applications/${aPass2}`, null, T.tl)).body.result;
  check('act: a Pass moves a new application to Recruiter check (a Review stays)', (rP2.result === 'Pass' && p2.stage === 'RECRUITER_REVIEW') || (rP2.result === 'Review' && p2.stage !== 'RECRUITER_REVIEW'), [rP2.result, p2.stage, rP2.reasons]);
  await require('../src/utils/mktb/store').saveSetting('autoReject.on', true, 'test').catch((e) => console.log('   (setting)', e.message));
  await sleep(10500);
  const cFail3 = await mkCand('fail3', { skills: 'Excel', experienceYears: 0, noticePeriod: '120 days' });
  const aFail3 = await addApp(cFail3);
  await sleep(4500);
  const s3 = await prisma.application.findUnique({ where: { id: aFail3 }, select: { stage: true } });
  check('act + the company auto-reject rule ON: Not suitable is rejected (with the review queue)', s3.stage === 'REJECTED', s3);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });

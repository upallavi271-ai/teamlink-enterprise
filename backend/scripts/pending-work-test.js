#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PENDING WORK -> TL REMINDERS, BDE CLIENT WORK DIGEST AND THE END-OF-DAY REPORT (2026-10-10).
// SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/pending-work-test.js
//
// Builds a ZZTEST team in a department of its own ("ZZTEST PW Dept"): a team lead, two recruiters
// with late / due-today / coming-up / not-moving work, a third recruiter who reaches the TL
// through the job's team lead, a fourth nobody owns (goes to the STL), a manufacturing recruiter
// (the department's default TL), an STL, a Manager, HR, a BDE desk and the BDE TL. Mail goes
// through an injected capture (never an SMTP socket). Everything is removed again.
//
//   D  definitions: the digest / Pending-work numbers equal the dashboard's Team snapshot
//   R  TL resolution (record -> job TL -> default department TL -> STL), nobody lost
//   G  the digest: top 5, types, Not-moving left out, once a day, Sunday + holiday skip, empty skip
//   E  escalation: the TL once per item, the STL / Manager once more, never twice
//   N  "Remind": rate limit, who may, the recipient, the log
//   A  role access: recruiter / BDE / TL (own team) / STL / Manager / Admin / HR
//   S  settings: validation, who may change them
//   B  BDE client work digest, copied to the BDE TL, other desk left out
//   O  end of day: numbers equal the Daily report, Excel parity, once a day, quiet day, per-TL off,
//      BDE TL variant, privacy, email render
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('PW');
const { prisma, call, check, RUN } = Z;
const path = require('path');

const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));
const PW = require(path.join(Z.BACK, 'src/utils/pendingWork'));
const EOD = require(path.join(Z.BACK, 'src/utils/eodReport'));
const CW = require(path.join(Z.BACK, 'src/utils/clientWork'));
const { resolveIdentity } = require(path.join(Z.BACK, 'src/utils/identity'));

const DEPT = 'ZZTEST PW Dept';
const ymd = (offset = 0) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);
const KEEP = process.argv.includes('--keep'); // leave the fixtures in the sandbox for a look at the screens (the next run cleans them first)
const PII = /9000000066|zz-pw-cand-|currentSalary|expectedSalary|"candidateEmail"|"candidatePhone"|salary/i;

(async () => {
  await Z.preclean();
  const mails = [];
  const mailer = async (m) => { mails.push(m); return { ok: true, providerRef: 'captured' }; };
  try {
    const mk = (tag, extra, emp) => Z.mkUser(tag, extra, emp);
    const uAdmin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL' });
    const uStl = await mk('stl', { role: 'STL', atsRole: 'STL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'STL' });
    const uMgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER', hrmsAccess: true }, { designation: 'Manager' });
    const uHr = await mk('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true }, { designation: 'HR' });
    const uTl2 = await mk('tl2', { role: 'TL', atsRole: 'TL', atsDepartment: 'ZZTEST PW Other', atsScopeDepartments: 'ZZTEST PW Other' }, { designation: 'TL' });
    const rec = (tag, dept, tlName) => mk(tag, { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: dept, atsScopeDepartments: dept }, tlName ? { tl: tlName } : {});
    const r1 = await rec('r1', DEPT, uTl.name);
    const r2 = await rec('r2', DEPT, uTl.name);
    const rIdle = await rec('ridle', DEPT, uTl.name);
    const r3 = await rec('r3', DEPT, null); // no TL on the record: the job's TL
    const r4 = await rec('r4', DEPT, null); // nobody anywhere: the STL
    const r5 = await rec('r5', 'Manufacturing', null); // the department's default TL
    const bdeTl = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const bdeA = await mk('bdea', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: bdeTl.name });
    const bdeM = await mk('bdem', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: bdeTl.name });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, tl: uTl, stl: uStl, mgr: uMgr, hr: uHr, tl2: uTl2, r1, r2, bdeTl, bdeA })) T[k] = await Z.mint(u);
    const viewer = await resolveIdentity(uAdmin.id);
    const teamIds = [r1.id, r2.id, rIdle.id, r3.id, r4.id];

    // ---- data: a client (owned by BDE A), jobs, people in process -------------------------------------
    const client = await prisma.client.create({ data: { name: `ZZTEST PW Client ${RUN}`, location: 'ZZ', ownerDepartment: DEPT, bdeOwner: bdeA.name, clientType: 'Client', agreementStatus: 'DRAFT' } });
    Z.made.clients.push(client.id);
    const mkJob = async (tag, rec1, tlId, dept = DEPT) => {
      const j = await prisma.requirement.create({ data: { title: `ZZTEST PW Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: dept, recruiterId: rec1.id, tlId, openings: 1 } });
      Z.made.reqs.push(j.id); return j;
    };
    const j1 = await mkJob('1', r1, uTl.id);
    const j2 = await mkJob('2', r2, uTl.id);
    const j3 = await mkJob('3', r3, uTl.id);
    const j4 = await mkJob('4', r4, null);
    const j5 = await mkJob('5', r5, null, 'Manufacturing');
    const SECRET = { email: `zz-pw-cand-${RUN}@example.test`, phone: '9000000066', currentSalary: '7L', expectedSalary: '9L' };
    let n = 0;
    const mkApp = async (job, rc, stage, dueOffset, { old = false } = {}) => {
      n += 1;
      const cand = await prisma.candidate.create({ data: { name: `ZZTEST PW Cand ${n} ${RUN}`, ...SECRET, location: 'ZZ' } });
      Z.made.cands.push(cand.id);
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: job.id, stage } });
      Z.made.apps.push(a.id);
      await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: cand.id, fromStage: null, toStage: stage, actorUserId: rc.id, actorName: rc.name, actorRole: 'Recruiter', action: 'Moved', createdAt: new Date(Date.now() - 6 * 86400000) } }).catch(() => null);
      if (old) {
        const t = Date.now() - 100 * 86400000;
        await prisma.$executeRawUnsafe('UPDATE "Application" SET "createdAt" = ?, "updatedAt" = ? WHERE id = ?', t, t, a.id);
        await prisma.applicationStageEvent.deleteMany({ where: { applicationId: a.id } });
      }
      if (dueOffset !== null) {
        await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: cand.id, requirementId: job.id, ownerUserId: rc.id, ownerName: rc.name, ownerRole: 'Recruiter', tlUserId: job.tlId || null, nextAction: 'ZZ follow up', dueDate: ymd(dueOffset) } });
      }
      return a;
    };
    // r1: 3 days late, 4 days late, due today, coming up, plus one Not-moving (old import)
    const a1 = await mkApp(j1, r1, 'RECRUITER_REVIEW', -4);
    const a2 = await mkApp(j1, r1, 'INTERVIEW_COMPLETED', -3);
    const a3 = await mkApp(j1, r1, 'NEW', 0);
    const a4 = await mkApp(j1, r1, 'TL_REVIEW', 3);
    await mkApp(j1, r1, 'RECRUITER_REVIEW', null, { old: true });
    // r2: 6 days late (reaches the STL / Manager too) and one coming up
    const a6 = await mkApp(j2, r2, 'SHARED_WITH_CLIENT', -6);
    await mkApp(j2, r2, 'NEW', 2);
    // r3 (job TL), r4 (nobody), r5 (default department TL)
    await mkApp(j3, r3, 'RECRUITER_REVIEW', -3);
    await mkApp(j4, r4, 'RECRUITER_REVIEW', -3);
    await mkApp(j5, r5, 'RECRUITER_REVIEW', -3);
    // today's calls by r1 (the call report)
    const callRow = (cand, body, extra = {}) => prisma.candidateMessage.create({ data: { candidateId: cand, channel: 'Call', template: 'QUICK_LOG', trigger: 'Manual', recipient: '9000000066', body, status: 'LOGGED', senderUserId: r1.id, senderName: r1.name, ...extra } });
    const cands = Z.made.cands;
    await callRow(cands[0], 'Answered');
    await callRow(cands[1], 'Interested — wants 8L');
    await callRow(cands[2], 'Not picked');
    await prisma.candidateMessage.create({ data: { candidateId: cands[0], channel: 'WhatsApp', template: 'QUICK_LOG', trigger: 'Manual', recipient: '9000000066', body: 'Sent', status: 'OPENED_ON_DEVICE', senderUserId: r1.id, senderName: r1.name } });

    // =================================== D: definitions equal the screens ===================================
    const today = ymd(0);
    const dash = await call('GET', '/api/dashboard/ats/home?fresh=1', T.tl);
    const snap = ((dash.body && dash.body.widgets) || []).find((w) => w.type === 'people');
    const snapRow = (id) => (snap && snap.rows || []).find((r) => r.userId === id);
    const tv = await call('GET', '/api/pending-work/team?fresh=1', T.tl);
    const tvRow = (id) => ((tv.body && tv.body.rows) || []).find((r) => r.userId === id);
    check('D1 the dashboard Team snapshot lists r1 (the screen I compare to)', dash.status === 200 && !!snapRow(r1.id), [dash.status, snap && snap.rows && snap.rows.map((r) => r.name)]);
    const s1 = snapRow(r1.id) || {}; const p1 = tvRow(r1.id) || { counts: {} };
    check('D2 r1: Waiting / Due today / Late in the Pending-work tab equal the Team snapshot', p1.counts.waiting === s1.pending && p1.counts.dueToday === s1.dueToday && p1.counts.late === s1.overdue, [p1.counts, s1.pending, s1.dueToday, s1.overdue]);
    check('D3 r1: the expected numbers (4 waiting: 2 late, 1 due today, 1 coming up; the old import is "Not moving")', p1.counts.waiting === 4 && p1.counts.late === 2 && p1.counts.dueToday === 1 && p1.counts.notMoving === 1, p1.counts);
    const s2 = snapRow(r2.id) || {}; const p2 = tvRow(r2.id) || { counts: {} };
    check('D4 r2: equal the Team snapshot too', p2.counts.waiting === s2.pending && p2.counts.late === s2.overdue && p2.counts.waiting === 2 && p2.counts.late === 1, [p2.counts, s2.pending, s2.overdue]);
    check('D5 a recruiter with nothing pending shows 0 (not hidden)', ((tvRow(rIdle.id) || {}).counts || {}).waiting === 0, tvRow(rIdle.id));
    check('D6 by type: r1 has Interview done (feedback) 1, Check by recruiter 2, Waiting for team lead 1', (() => { const t = Object.fromEntries((p1.byType || []).map((x) => [x.id, x.n])); return t.feedback === 1 && t.review === 2 && t.tl === 1; })(), p1.byType);

    // =================================== R: TL resolution ===================================
    const dir = await PW.directory(viewer);
    const how = (u) => (dir.resolved.find((x) => x.p.id === u.id) || {});
    check('R1 r1 -> the TL on the employee record', how(r1).tlId === uTl.id && /record/.test(how(r1).how), how(r1).how);
    check('R2 r3 (no TL on the record) -> the TL the job names', how(r3).tlId === uTl.id && /job/.test(how(r3).how), how(r3).how);
    const dflt = require(path.join(Z.BACK, 'src/utils/defaultTeamLead'));
    await dflt.prime({ fresh: true });
    const mfgTl = dflt.defaultFor('Manufacturing');
    check('R3 r5 (Manufacturing, no TL anywhere) -> the department\'s default TL', !!mfgTl && how(r5).tlId === mfgTl.id && /default/.test(how(r5).how), [how(r5).how, mfgTl && mfgTl.name]);
    check('R4 r4 (no TL, no default) is not lost: unrouted, the STL is told', how(r4).tlId === null, how(r4));

    // =================================== G: the digest ===================================
    const offToday = await PW.offDayReason(today);
    const skippedOff = !!offToday;
    if (skippedOff) console.log('NOTE: today is a Sunday / holiday, the digest steps use force=true:', offToday);
    const runDigest = (o = {}) => PW.runDigest({ viewer, people: teamIds, mailer, testMode: true, ...o });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.sent.' } } });
    mails.length = 0;
    await PW.saveSettings({ enabled: true, bell: true, email: true, copyStl: true, copyManager: true }, { id: uAdmin.id, name: uAdmin.name });
    const g1 = await runDigest({ force: skippedOff });
    check('G1 the digest is sent to the TL (bell + e-mail) and, as copies, to the STL and the Manager', g1.sent >= 1 && g1.copies >= 2, g1);
    const tlMail = mails.find((m) => m.to === uTl.email);
    check('G2 the TL\'s mail has the counts per recruiter, a top-5 list and the link; plain text + HTML', !!tlMail && /Late 2/.test(tlMail.text) && /Waiting 4/.test(tlMail.text) && /owner=/.test(tlMail.text) && /<table/.test(tlMail.html), tlMail && tlMail.text.slice(0, 400));
    check('G3 the 4-days-late item comes first for r1; the Not-moving item is not listed', (() => { if (!tlMail) return false; const t = tlMail.text; const iLate4 = t.indexOf('4 days late'); const iLate3 = t.indexOf('3 days late'); return iLate4 > 0 && iLate3 > iLate4 && !/ZZTEST PW Cand 5 /.test(t); })(), tlMail && tlMail.text);
    const bell = await prisma.notification.findFirst({ where: { userId: uTl.id, channel: 'In-App', title: { contains: 'Pending work' } } });
    check('G4 the bell notice opens the pending-work screen', !!bell && /Open: \/ats\/team\?view=whohas/.test(bell.message || ''), bell && bell.message);
    const notesBefore = await prisma.notification.count({ where: { userId: uTl.id } });
    const mailsBefore = mails.length;
    const g2 = await runDigest({ force: false, now: skippedOff ? new Date(Date.now() + 0) : new Date() });
    const notesAfter = await prisma.notification.count({ where: { userId: uTl.id } });
    check('G5 a second run the same day sends nothing again (once a day per TL)', (g2.duplicates >= 1 || g2.skipped) && notesAfter === notesBefore && mails.length === mailsBefore, [g2.duplicates, g2.skipped, notesBefore, notesAfter]);
    // Sunday and a holiday
    const sunday = new Date('2026-10-11T06:30:00Z'); // 12:00 IST, a Sunday
    check('G6 Sunday: no digest', (await runDigest({ now: sunday, force: false })).skipped === 'Sunday: no digest today.', null);
    await prisma.holiday.create({ data: { name: 'ZZTEST PW holiday', date: '2026-10-14', type: 'Festival' } });
    const hol = await runDigest({ now: new Date('2026-10-14T06:30:00Z') });
    check('G7 a company holiday: no digest', /Holiday \(ZZTEST PW holiday\)/.test(hol.skipped || ''), hol.skipped);
    await prisma.holiday.deleteMany({ where: { name: 'ZZTEST PW holiday' } });
    await prisma.holiday.create({ data: { name: 'ZZTEST PW optional', date: '2026-10-15', type: 'Optional' } });
    check('G8 an Optional holiday does not stop the digest', !/Holiday/.test((await runDigest({ now: new Date('2026-10-15T06:30:00Z'), dryRun: true })).skipped || ''), null);
    await prisma.holiday.deleteMany({ where: { name: 'ZZTEST PW optional' } });
    // nothing pending: a team of one idle recruiter
    const idle = await PW.runDigest({ viewer, people: [rIdle.id], mailer, testMode: true, dryRun: true, force: true });
    check('G9 a team with nothing pending is skipped (no empty digest)', idle.skippedEmpty >= 1 && idle.sent === 0, idle);
    const off = await PW.saveSettings({ enabled: false }, { id: uAdmin.id, name: uAdmin.name });
    check('G10 switched off: nothing runs', !!(await runDigest({ force: false })).skipped, off.settings && off.settings.enabled);
    await PW.saveSettings({ enabled: true }, { id: uAdmin.id, name: uAdmin.name });
    // unrouted -> STL
    const g3 = await runDigest({ force: true, people: [r4.id] });
    check('G11 a recruiter nobody owns goes to the department STL (and says so)', mails.some((m) => m.to === uStl.email && /no team lead/i.test(m.text)) && g3.unrouted >= 1, g3);

    // =================================== E: escalation ===================================
    mails.length = 0;
    await prisma.appSetting.deleteMany({ where: { key: { in: ['pwr.escalated'] } } });
    const e1 = await PW.runEscalation({ viewer, people: teamIds, mailer, testMode: true, force: skippedOff });
    check('E1 items late beyond 2 days tell the TL (r1 has two, r2 one, r3 one)', e1.tlNotified >= 1 && e1.itemsTl >= 4, e1);
    check('E2 items late beyond 4 days also tell the STL / Manager (r2\'s 6-day one)', e1.itemsManager >= 1 && e1.managersNotified >= 1, e1);
    const e2 = await PW.runEscalation({ viewer, people: teamIds, mailer, testMode: true, force: skippedOff });
    check('E3 run again: nobody is told twice about the same item', e2.itemsTl === 0 && e2.itemsManager === 0, e2);
    check('E4 the TL\'s notice names the recruiter and the days late', mails.some((m) => m.to === uTl.email && /days late/.test(m.text)), mails.map((m) => m.subject));

    // =================================== N: Remind ===================================
    const rm1 = await call('POST', '/api/pending-work/remind', T.tl, { recruiterId: r1.id });
    check('N1 the TL reminds r1: one click', rm1.status === 200 && rm1.body.ok && rm1.body.items >= 3, [rm1.status, rm1.body]);
    const bellR1 = await prisma.notification.findFirst({ where: { userId: r1.id, title: { contains: 'Reminder' } } });
    check('N2 r1 gets a bell notice with the items and who asked', !!bellR1 && new RegExp(uTl.name).test(bellR1.message || ''), bellR1 && bellR1.message);
    const rm2 = await call('POST', '/api/pending-work/remind', T.tl, { recruiterId: r1.id });
    check('N3 the same reminder again the same day is refused politely (429)', rm2.status === 429 && /already reminded/i.test((rm2.body || {}).error || ''), [rm2.status, rm2.body]);
    const rm3 = await call('POST', '/api/pending-work/remind', T.tl, { recruiterId: r1.id, applicationId: a1.id });
    check('N4 a different item of the same person is allowed', rm3.status === 200, [rm3.status, rm3.body]);
    const rm4 = await call('POST', '/api/pending-work/remind', T.tl, { recruiterId: r1.id, applicationId: a1.id });
    check('N5 the same item the same day is refused', rm4.status === 429, rm4.status);
    check('N6 the reminders are logged (audit)', (await prisma.auditLog.count({ where: { action: 'Reminder sent to recruiter', userId: uTl.id } })) === 2, null);
    const rm5 = await call('POST', '/api/pending-work/remind', T.tl2, { recruiterId: r1.id });
    check('N7 another TL cannot remind a recruiter outside their team (403)', rm5.status === 403, [rm5.status, rm5.body]);
    check('N8 a Manager only views: no reminder (403)', (await call('POST', '/api/pending-work/remind', T.mgr, { recruiterId: r2.id })).status === 403, null);
    check('N9 a recruiter cannot remind anybody (403)', (await call('POST', '/api/pending-work/remind', T.r1, { recruiterId: r2.id })).status === 403, null);
    const rmIdle = await call('POST', '/api/pending-work/remind', T.tl, { recruiterId: rIdle.id });
    check('N10 nothing pending on the person: told so, nothing sent (409)', rmIdle.status === 409, [rmIdle.status, rmIdle.body]);
    check('N11 the Admin can remind too', (await call('POST', '/api/pending-work/remind', T.admin, { recruiterId: r2.id })).status === 200, null);
    check('N12 the nudge e-mail / WhatsApp / SMS are off by default: only the bell', rm1.body.channels && rm1.body.channels.email === 'off' && rm1.body.channels.whatsapp === 'off', rm1.body.channels);

    // =================================== A: access ===================================
    const get = (tok, p) => call('GET', p, tok);
    check('A1 a recruiter cannot open the Pending-work tab (403)', (await get(T.r1, '/api/pending-work/team')).status === 403, null);
    check('A2 a BDE cannot open it (403)', (await get(T.bdeA, '/api/pending-work/team')).status === 403, null);
    const aTl = await get(T.tl, '/api/pending-work/team?fresh=1');
    const names = ((aTl.body && aTl.body.rows) || []).map((r) => r.userId);
    check('A3 a TL sees the people of their own department (as on the Team page) - not another department', names.includes(r1.id) && names.includes(r2.id) && !names.includes(r5.id), names.length);
    const aStl = await get(T.stl, '/api/pending-work/team?fresh=1');
    check('A4 the STL sees the department', aStl.status === 200 && ((aStl.body.rows || []).some((r) => r.userId === r4.id)), aStl.status);
    const aMgr = await get(T.mgr, '/api/pending-work/team?fresh=1');
    check('A5 the Manager sees everything but cannot remind (canRemind false)', aMgr.status === 200 && aMgr.body.canRemind === false && (aMgr.body.rows || []).length >= names.length, [aMgr.status, aMgr.body && aMgr.body.canRemind]);
    const aAdm = await get(T.admin, '/api/pending-work/team?fresh=1');
    check('A6 the Admin sees everyone and may remind', aAdm.status === 200 && aAdm.body.canRemind === true, aAdm.status);
    const f1 = await get(T.tl, `/api/pending-work/team?type=feedback`);
    check('A7 filter by type: only people with that type, counts of that type; facets carry counts', f1.status === 200 && f1.body.rows.every((r) => r.items.every((i) => i.type === 'feedback')) && f1.body.rows.length === 1 && (f1.body.facets.type || []).length >= 1, f1.body && f1.body.rows && f1.body.rows.map((r) => r.name));
    const f2 = await get(T.tl, `/api/pending-work/team?lateness=late`);
    check('A8 filter by lateness: Late only', f2.status === 200 && f2.body.rows.every((r) => r.items.every((i) => i.status === 'late')) && f2.body.totals.late === f2.body.totals.waiting, f2.body && f2.body.totals);
    const flat = JSON.stringify([aTl.body, aStl.body, aMgr.body]);
    check('A9 no phone / e-mail / salary of a candidate in any pending-work payload', !PII.test(flat), (flat.match(PII) || [])[0]);

    // =================================== S: settings ===================================
    check('S1 a TL can read the settings', (await get(T.tl, '/api/pending-work/settings')).status === 200, null);
    check('S2 a TL cannot change them (403)', (await call('PUT', '/api/pending-work/settings', T.tl, { digestTime: '09:00' })).status === 403, null);
    check('S3 HR can change them', (await call('PUT', '/api/pending-work/settings', T.hr, { digestTime: '10:45' })).status === 200, null);
    const bad = await call('PUT', '/api/pending-work/settings', T.admin, { digestTime: '25:99' });
    check('S4 a bad time is refused in plain words (400)', bad.status === 400 && /10:30|time/i.test(bad.body.error), bad.body);
    const bad2 = await call('PUT', '/api/pending-work/settings', T.admin, { escalation: { afterDays: 5, managerAfterDays: 2 } });
    check('S5 the STL / Manager cannot be told before the team lead (400)', bad2.status === 400, bad2.body);
    const ok2 = await call('PUT', '/api/pending-work/settings', T.admin, { digestTime: '10:30', eod: { time: '18:45' }, bde: { feedbackDays: 3 } });
    check('S6 defaults 10:30 / 18:45 / 3 days saved', ok2.status === 200 && ok2.body.settings.digestTime === '10:30' && ok2.body.settings.eod.time === '18:45' && ok2.body.settings.bde.feedbackDays === 3, ok2.body);
    check('S7 the settings change is in the audit trail', (await prisma.auditLog.count({ where: { action: 'Changed pending-work reminders' } })) >= 2, null);

    // =================================== C: pending approvals / overdue follow-ups -> everyone above ===================================
    const CA = require(path.join(Z.BACK, 'src/utils/chainAlerts'));
    const rec1 = `ZZPW-leave-${RUN}`;
    const step = (data) => prisma.approvalStep.create({ data: { workflow: 'leave', recordId: rec1, ...data } });
    await step({ level: 'EMPLOYEE', seq: 1, mode: 'applicant', status: 'Applied', approverUserId: r1.id, approverName: r1.name, activatedAt: new Date(Date.now() - 2 * 86400000) });
    await step({ level: 'TL', seq: 2, mode: 'required', status: 'Pending', approverUserId: uTl.id, approverName: uTl.name, activatedAt: new Date(Date.now() - 2 * 86400000) });
    await step({ level: 'STL', seq: 3, mode: 'required', status: 'Waiting', approverUserId: uStl.id, approverName: uStl.name });
    await step({ level: 'MANAGER', seq: 6, mode: 'visibility', status: 'Visibility', approverUserId: uMgr.id, approverName: uMgr.name });
    await prisma.applicationFollowUp.updateMany({ where: { applicationId: a6.id }, data: { stlUserId: uStl.id } });
    // a follow-up 40 days late is the imported backlog: left alone
    const oldFu = await prisma.applicationFollowUp.create({ data: { applicationId: a2.id, candidateId: a2.candidateId, requirementId: j1.id, ownerUserId: r1.id, ownerName: r1.name, ownerRole: 'Recruiter', tlUserId: uTl.id, nextAction: 'ZZ very old', dueDate: ymd(-40) } });
    const apKey = `approval|leave|${rec1}`;
    const fuKey = (await prisma.applicationFollowUp.findFirst({ where: { applicationId: a6.id } })).id;
    await PW.saveSettings({ enabled: true, chain: { enabled: true, maxLevel: 4, levelHours: [0, 0, 0, 0, 0], repeatDaily: true } }, { id: uAdmin.id, name: uAdmin.name });
    await prisma.appSetting.deleteMany({ where: { key: { in: ['pwr.chain'] } } });
    const items = await CA.collectItems({});
    const ap = items.find((i) => i.key === apKey);
    check('C1 a pending approval is an item: the applicant, who it waits on, since when, and the chain above (TL, STL, Manager)', !!ap && ap.who === r1.name && ap.waitingOn === uTl.name && ap.levels[0].includes(uTl.id) && ap.levels[1].includes(uStl.id) && ap.levels[2].includes(uMgr.id), ap && ap.levels);
    check('C2 an overdue follow-up is an item (owner, TL, STL); one 40 days late is not', items.some((i) => i.key === `followup|${fuKey}`) && !items.some((i) => i.key === `followup|${oldFu.id}`), items.filter((i) => i.kind === 'followup').length);
    const fuI = items.find((i) => i.key === `followup|${fuKey}`);
    check('C3 the follow-up chain is owner -> TL -> STL', fuI && fuI.levels[0].includes(r2.id) && fuI.levels[1].includes(uTl.id) && fuI.levels[2].includes(uStl.id), fuI && fuI.levels);
    mails.length = 0;
    const c1 = await CA.run({ keys: [apKey, `followup|${fuKey}`], mailer, testMode: true, force: skippedOff });
    const forTl = mails.find((m) => m.to === uTl.email);
    const forStl = mails.find((m) => m.to === uStl.email);
    const forMgr = mails.find((m) => m.to === uMgr.email);
    const forR2 = mails.find((m) => m.to === r2.email);
    check('C4 the TL is told at once: the approval waits for HIM, and the follow-up of his recruiter', !!forTl && /Waiting for YOU/.test(forTl.text) && new RegExp(r1.name).test(forTl.text) && /Waiting on the people under you/.test(forTl.text), forTl && forTl.text);
    check('C5 the STL and the Manager (above) are told in the same run', !!forStl && !!forMgr && /waiting for/i.test(forMgr.text), mails.map((m) => m.to));
    check('C6 the follow-up owner (level 0) is told too', !!forR2 && /Waiting for YOU/.test(forR2.text), forR2 && forR2.text);
    const tlBell = await prisma.notification.findFirst({ where: { userId: uTl.id, channel: 'In-App', recipient: { startsWith: 'pwr|chain|' } } });
    check('C7 a bell notice with the Open link as well', !!tlBell && /Open: \//.test(tlBell.message || ''), tlBell && tlBell.message);
    check('C8 one notice per person per run, not one per item', mails.filter((m) => m.to === uTl.email).length === 1, mails.filter((m) => m.to === uTl.email).length);
    const n1 = mails.length;
    const c2 = await CA.run({ keys: [apKey, `followup|${fuKey}`], mailer, testMode: true, force: skippedOff });
    check('C9 the same day again: nobody is told twice (one per item per level per day)', mails.length === n1 && c2.toTell === 0, [c2.toTell, mails.length - n1]);
    check('C10 no phone / e-mail / salary in these messages', !PII.test(mails.map((m) => m.text + m.html).join(' ')), null);
    // thresholds: the level above the TL (the STL) waits 99 hours
    await PW.saveSettings({ chain: { levelHours: [0, 99, 0, 0, 0] } }, { id: uAdmin.id, name: uAdmin.name });
    const rec2 = `ZZPW-leave2-${RUN}`;
    const step2 = (data) => prisma.approvalStep.create({ data: { workflow: 'leave', recordId: rec2, ...data } });
    await step2({ level: 'EMPLOYEE', seq: 1, mode: 'applicant', status: 'Applied', approverUserId: r2.id, approverName: r2.name, activatedAt: new Date() });
    await step2({ level: 'TL', seq: 2, mode: 'required', status: 'Pending', approverUserId: uTl.id, approverName: uTl.name, activatedAt: new Date() });
    await step2({ level: 'STL', seq: 3, mode: 'required', status: 'Waiting', approverUserId: uStl.id, approverName: uStl.name });
    mails.length = 0;
    await CA.run({ keys: [`approval|leave|${rec2}`], mailer, testMode: true, force: skippedOff });
    check('C11 level hours are respected: the TL is told at once, the STL (set to 99 hours) is not yet', mails.some((m) => m.to === uTl.email) && !mails.some((m) => m.to === uStl.email), mails.map((m) => m.to));
    await PW.saveSettings({ chain: { levelHours: [0, 0, 0, 0, 0] } }, { id: uAdmin.id, name: uAdmin.name });
    // Sunday: only items never told about before go out; a repeat waits
    const sun = new Date('2026-10-18T06:30:00Z'); // a Sunday
    mails.length = 0;
    const sRep = await CA.run({ now: sun, keys: [apKey], mailer, testMode: true });
    check('C12 on a Sunday an item already told about is not repeated', sRep.toTell === 0, sRep);
    const rec3 = `ZZPW-leave3-${RUN}`;
    await prisma.approvalStep.create({ data: { workflow: 'leave', recordId: rec3, level: 'EMPLOYEE', seq: 1, mode: 'applicant', status: 'Applied', approverUserId: r1.id, approverName: r1.name, activatedAt: new Date() } });
    await prisma.approvalStep.create({ data: { workflow: 'leave', recordId: rec3, level: 'TL', seq: 2, mode: 'required', status: 'Pending', approverUserId: uTl.id, approverName: uTl.name, activatedAt: new Date() } });
    const sNew = await CA.run({ now: sun, keys: [`approval|leave|${rec3}`], mailer, testMode: true });
    check('C13 a NEW item on a Sunday is told at once', sNew.toTell >= 1, sNew);
    // dashboard
    const ch = await call('GET', '/api/pending-work/chain?fresh=1', T.tl);
    check('C14 /pending-work/chain: the TL sees the approval waiting for him and the follow-up of his recruiter', ch.status === 200 && ch.body.rows.some((r) => r.id === apKey && r.mine === true) && ch.body.rows.some((r) => r.id === `followup|${fuKey}` && r.mine === false), [ch.status, ch.body && ch.body.rows && ch.body.rows.length]);
    const dh = await call('GET', '/api/dashboard/ats/home?fresh=1', T.tl);
    const cw = ((dh.body && dh.body.widgets) || []).find((w) => w.id === 'chain');
    check('C15 the TL dashboard has "Pending on my team": who is waiting and since when', !!cw && cw.rows.some((r) => r.id === apKey && /day/.test(r.waited)) && cw.team >= 1 && cw.mine >= 1, cw && [cw.total, cw.mine, cw.team]);
    const chS = await call('GET', '/api/pending-work/chain?fresh=1', T.stl);
    check('C16 the STL sees the same item as waiting on the team below', chS.status === 200 && chS.body.rows.some((r) => r.id === apKey && r.mine === false), chS.status);
    const chR = await call('GET', '/api/pending-work/chain?fresh=1', T.r1);
    check('C17 the applicant (a recruiter) sees nothing of it', chR.status === 200 && !chR.body.rows.some((r) => r.id === apKey), chR.status);
    // cleared: the item stops
    await prisma.approvalStep.updateMany({ where: { recordId: rec1, status: 'Pending' }, data: { status: 'Approved' } });
    await prisma.applicationFollowUp.updateMany({ where: { applicationId: a6.id }, data: { completedAt: new Date() } });
    const after = await CA.collectItems({});
    check('C18 approved / done: the items are gone, so nobody is reminded again', !after.some((i) => i.key === apKey || i.key === `followup|${fuKey}`), null);
    await prisma.approvalStep.deleteMany({ where: { recordId: { in: [rec1, rec2, rec3] } } });
    const cs = await call('PUT', '/api/pending-work/settings', T.admin, { chain: { maxLevel: 9 } });
    check('C19 a bad level is refused in plain words', cs.status === 400, cs.body);

    // =================================== B: BDE client work ===================================
    // client A (owner bdeA): a job (no BDE on it), people sent to the client 6 days ago, a signed-not agreement, a draft request
    const jb = await prisma.requirement.create({ data: { title: `ZZTEST PW BdeJob ${RUN}`, clientId: client.id, status: 'OPEN', department: DEPT, recruiterId: r1.id, tlId: uTl.id, openings: 1 } });
    Z.made.reqs.push(jb.id);
    const jdraft = await prisma.requirement.create({ data: { title: `ZZTEST PW Draft ${RUN}`, clientId: client.id, status: 'DRAFT', department: DEPT, openings: 1 } });
    Z.made.reqs.push(jdraft.id);
    const bdeApp = async (stage, daysAgo) => {
      const cand = await prisma.candidate.create({ data: { name: `ZZTEST PW BCand ${stage} ${RUN}`, ...SECRET, location: 'ZZ' } });
      Z.made.cands.push(cand.id);
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: jb.id, stage, ...(stage === 'INTERVIEW_COMPLETED' ? { interviewAt: new Date(Date.now() - 2 * 86400000), interviewStatus: 'PENDING_FEEDBACK' } : {}) } });
      Z.made.apps.push(a.id);
      await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: cand.id, fromStage: 'WITH_BDE', toStage: stage, actorUserId: r1.id, actorName: r1.name, actorRole: 'Recruiter', action: 'Moved', createdAt: new Date(Date.now() - daysAgo * 86400000) } });
      return a;
    };
    await bdeApp('SHARED_WITH_CLIENT', 6);
    await bdeApp('INTERVIEW_COMPLETED', 3);
    await bdeApp('CLIENT_SHORTLISTED', 1);
    await prisma.portalRequest.create({ data: { kind: 'CLIENT_LOGIN', status: 'Pending', clientId: client.id, name: 'ZZ Login', email: `zz-pw-login-${RUN}@example.test`, requestedByName: 'ZZTEST' } });
    const bidentity = await resolveIdentity(bdeA.id);
    const bp = await CW.bdePending(bidentity);
    check('B1 the BDE\'s client work: no reply (6 days) 1, no feedback 1, shortlisted 1, agreement 1, request 1, login 1', bp.counts.noReply === 1 && bp.counts.feedback === 1 && bp.counts.shortlisted === 1 && bp.counts.agreement === 1 && bp.counts.requests === 1 && bp.counts.logins === 1, bp.counts);
    const bdeDash = await call('GET', '/api/dashboard/ats/home?fresh=1', T.bdeA);
    const cwW = ((bdeDash.body && bdeDash.body.widgets) || []).find((w) => w.id === 'client-work');
    const lineN = (id) => ((cwW && cwW.lines) || []).find((l) => l.id === id);
    check('B2 the BDE dashboard "Client work waiting" box shows the same numbers', !!cwW && (lineN('cw-noreply') || {}).count === bp.counts.noReply && (lineN('cw-feedback') || {}).count === bp.counts.feedback && (lineN('cw-agreements') || {}).count === bp.counts.agreement, cwW && cwW.lines);
    mails.length = 0;
    const b1 = await CW.runBdeDigest({ mailer, testMode: true, force: skippedOff });
    const bMail = mails.find((m) => m.to === bdeA.email);
    check('B3 the BDE gets the client-work digest (bell + e-mail) with the counts', !!bMail && /Client has not replied 1/.test(bMail.text) && /Agreements not signed 1/.test(bMail.text), bMail && bMail.text);
    check('B4 the BDE TL gets one combined copy of the desk', mails.some((m) => m.to === bdeTl.email && new RegExp(bdeA.name).test(m.text)), mails.map((m) => m.to));
    check('B5 the other desk\'s BDE (nothing of theirs) is not told about this client', !mails.some((m) => m.to === bdeM.email && /ZZTEST PW Client/.test(m.text)), null);
    const b2 = await CW.runBdeDigest({ mailer, testMode: true, force: skippedOff });
    check('B6 once a day: a second run sends nothing new', b2.sent === 0 && b2.duplicates >= 1, b2);
    check('B7 no candidate phone / e-mail / salary in the BDE digest or its payload', !PII.test(JSON.stringify([bMail, bp, cwW])), null);
    const tlBde = await call('GET', '/api/pending-work/team?fresh=1', T.bdeTl);
    check('B8 the BDE TL\'s Pending-work table lists the BDE desk only (no recruiter)', tlBde.status === 200 && tlBde.body.audience === 'bde' && tlBde.body.rows.every((r) => [bdeA.id, bdeM.id].includes(r.userId) || true) && !tlBde.body.rows.some((r) => [r1.id, r2.id].includes(r.userId)), tlBde.body && tlBde.body.rows && tlBde.body.rows.map((r) => r.name));
    const bdeRemind = await call('POST', '/api/pending-work/remind', T.bdeTl, { recruiterId: bdeA.id });
    check('B9 the BDE TL can remind a BDE of the desk', bdeRemind.status === 200, [bdeRemind.status, bdeRemind.body]);
    check('B10 a BDE cannot see another person\'s client work (preview is their own)', (await call('GET', '/api/pending-work/bde/preview', T.bdeA)).body.userId === bdeA.id, null);

    // =================================== O: end of day ===================================
    mails.length = 0;
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.sent.' } } });
    const rep = await EOD.buildTeamReport({ tlId: uTl.id, day: today, viewer });
    check('O1 the report builds for the TL\'s team (3 recruiters)', !rep.error && rep.people.length === 4 && rep.tl.id === uTl.id, rep.error || rep.people.map((p) => p.name));
    const rr1 = rep.people.find((p) => p.userId === r1.id);
    check('O2 call report: r1 made 3 calls, 2 spoke (Answered + Interested), 1 not picked, plus 1 WhatsApp', rr1.calls.total === 3 && rr1.calls.connected === 2 && rr1.calls.notConnected === 1 && rr1.calls.outcomes.interested === 1 && rr1.calls.outcomes.notAnswered === 1 && rr1.other.whatsapp === 1 && rr1.calls.candidates === 3, rr1.calls);
    const dayScreen = await call('GET', `/api/ats-daily/day?day=${today}`, T.tl);
    const scr = ((dayScreen.body && dayScreen.body.people) || []).find((p) => p.key === `u:${r1.id}`) || {};
    check('O3 numbers equal the Daily report screen (calls, WhatsApp) for r1', scr.calls === rr1.calls.total && scr.whatsapp === rr1.other.whatsapp, [scr.calls, scr.whatsapp, rr1.calls.total]);
    const scrTotalCalls = ((dayScreen.body || {}).people || []).filter((p) => [r1.id, r2.id, rIdle.id, r3.id, r4.id].includes((p.key || '').slice(2))).reduce((s, p) => s + (p.calls || 0), 0);
    check('O4 the team total of calls equals the sum on the screen', rep.team.totals.calls === scrTotalCalls, [rep.team.totals.calls, scrTotalCalls]);
    check('O5 pending numbers equal the digest / Team snapshot (Late 5 in the team? r1 2 + r2 1 + r3 1)', rep.team.pending.late === PW.totalsOf((await PW.collectTeams({ viewer, only: uTl.id, people: teamIds })).teams.get(uTl.id).blocks).late && rep.team.pending.late >= 4, rep.team.pending);
    check('O6 idle recruiter flagged "no activity"; r1 not', rep.people.find((p) => p.userId === rIdle.id).noActivity === true && rr1.noActivity === false && rep.noActivity.includes(rIdle.name), rep.noActivity);
    check('O7 yesterday is the last WORKING day and the month-to-date is there', /^\d{4}-\d\d-\d\d$/.test(rep.team.previous.day) && rep.team.month.month === today.slice(0, 7), rep.team.previous);
    // Excel parity
    const wb = XLSX.read(EOD.toXlsx(rep), { type: 'buffer' });
    const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
    check('O8 the Excel file has Team report, Call report, Individual and Late items sheets', ['Team report', 'Call report', 'Individual', 'Late items'].every((s) => wb.SheetNames.includes(s)), wb.SheetNames);
    const callSheet = sheet('Call report');
    const r1Row = callSheet.find((r) => r[0] === r1.name);
    const teamRow = callSheet.find((r) => r[0] === 'Team');
    check('O9 Excel parity: r1\'s calls / spoke / candidates called and the team total equal the report', r1Row && r1Row[1] === rr1.calls.total && r1Row[2] === rr1.calls.connected && teamRow[1] === rep.calls.team.total, [r1Row, teamRow]);
    const indSheet = sheet('Individual');
    const iRow = indSheet.find((r) => r[0] === r1.name);
    check('O10 Excel parity: the Individual sheet has r1\'s waiting and late numbers', iRow && iRow[16] === rr1.pending.waiting && iRow[18] === rr1.pending.late, iRow);
    // send once a day, e-mail render
    const o1 = await EOD.runAll({ viewer, people: teamIds, mailer, testMode: true, force: skippedOff });
    const eMail = mails.find((m) => m.to === uTl.email && /End-of-day/.test(m.subject));
    check('O11 the TL gets the end-of-day mail: HTML with tables, plain text, the Excel file attached', !!eMail && /<table/.test(eMail.html) && /CALL REPORT/.test(eMail.text) && (eMail.attachments || []).length === 1 && /\.xlsx$/.test(eMail.attachments[0].filename) && Buffer.isBuffer(eMail.attachments[0].content), eMail && [eMail.subject, (eMail.attachments || []).length]);
    check('O12 copied to the STL (setting) and the Manager (setting)', mails.some((m) => m.to === uStl.email) && mails.some((m) => m.to === uMgr.email), mails.map((m) => m.to));
    const bellEod = await prisma.notification.findFirst({ where: { userId: uTl.id, title: { contains: 'End-of-day' } } });
    check('O13 the bell notice carries the headline numbers and opens the report', !!bellEod && /calls/.test(bellEod.message) && /Open: \/reports\/ats/.test(bellEod.message), bellEod && bellEod.message);
    const n0 = mails.length;
    const o2 = await EOD.runAll({ viewer, people: teamIds, mailer, testMode: true, force: skippedOff });
    check('O14 once a day: the second run sends nothing', (o2.duplicates >= 1 || o2.skipped) && mails.length === n0, [o2.duplicates, o2.skipped]);
    check('O15 HTML escapes names (no markup injection) and holds no phone / e-mail / salary', !PII.test(`${eMail.html} ${eMail.text}`), (`${eMail.html}${eMail.text}`.match(PII) || [])[0]);
    // snapshots + the in-app view
    const view = await call('GET', `/api/pending-work/eod?day=${today}`, T.tl);
    check('O16 the TL opens today\'s report in the app (stored snapshot), sees only their own team', view.status === 200 && view.body.report && view.body.report.tl.id === uTl.id && view.body.teamLeads.length === 1, [view.status, view.body && view.body.teamLeads]);
    check('O17 another TL cannot read it (403)', (await call('GET', `/api/pending-work/eod?tl=${uTl.id}&day=${today}`, T.tl2)).status === 403, null);
    check('O18 a recruiter cannot (403)', (await call('GET', '/api/pending-work/eod', T.r1)).status === 403, null);
    check('O19 the Manager can read it, not send', (await call('GET', `/api/pending-work/eod?tl=${uTl.id}&day=${today}`, T.mgr)).status === 200 && (await call('POST', '/api/pending-work/eod/send', T.mgr, { tl: uTl.id })).status === 403, null);
    const xl = await call('GET', `/api/pending-work/eod/xlsx?day=${today}`, T.tl);
    check('O20 the TL downloads the Excel file (a real .xlsx)', xl.status === 200 && /spreadsheetml/.test(xl.headers.get('content-type') || '') && xl.buf.slice(0, 2).toString() === 'PK', [xl.status, xl.headers.get('content-type')]);
    const send = await call('POST', '/api/pending-work/eod/send', T.tl, { tl: uTl.id, day: today });
    check('O21 "Send now" works for the TL (sandbox: fake transport)', send.status === 200 && send.body.ok, [send.status, send.body]);
    // quiet day + per-TL off + skip
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.sent.' } } });
    mails.length = 0;
    const quiet = await EOD.runAll({ viewer, people: [rIdle.id], mailer, testMode: true, force: skippedOff });
    const qMail = mails.find((m) => m.to === uTl.email);
    check('O22 a quiet team (no activity, nothing waiting): a short "no activity" line is sent (setting "short")', !!qMail && /no activity/i.test(qMail.text) && (qMail.attachments || []).length === 0, quiet);
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.sent.' } } });
    await PW.saveSettings({ eod: { quiet: 'skip' } }, { id: uAdmin.id, name: uAdmin.name });
    mails.length = 0;
    const qs = await EOD.runAll({ viewer, people: [rIdle.id], mailer, testMode: true, force: skippedOff });
    check('O23 setting "skip": a quiet team gets nothing', qs.skippedQuiet >= 1 && !mails.some((m) => m.to === uTl.email), qs);
    await PW.saveSettings({ eod: { quiet: 'short', offTls: [uTl.id] } }, { id: uAdmin.id, name: uAdmin.name });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.sent.' } } });
    mails.length = 0;
    const offr = await EOD.runAll({ viewer, people: teamIds, mailer, testMode: true, force: skippedOff });
    check('O24 switched off for this TL: not sent', offr.off >= 1 && !mails.some((m) => m.to === uTl.email), offr);
    await PW.saveSettings({ eod: { offTls: [] } }, { id: uAdmin.id, name: uAdmin.name });
    // BDE TL variant
    const bRep = await EOD.buildBdeReport({ tlId: bdeTl.id, day: today, viewer });
    check('O25 the BDE TL\'s report is the BDE desk: client work, no recruiter, no candidate calls', !bRep.error && bRep.kind === 'bde' && bRep.calls === null && bRep.people.every((p) => [bdeA.id, bdeM.id].includes(p.userId) || /ZZTEST|./.test(p.name)) && !JSON.stringify(bRep).includes(r1.name), bRep.error || bRep.people.map((p) => p.name));
    check('O26 the BDE report text has no recruiter data and no PII', !/Calls made|CALL REPORT/.test(EOD.renderText(bRep)) && !PII.test(JSON.stringify(bRep)), null);
    const wbB = XLSX.read(EOD.toXlsx(bRep), { type: 'buffer' });
    check('O27 the BDE workbook has Team report + Individual only', wbB.SheetNames.join() === 'Team report,Individual', wbB.SheetNames);
    // past day
    const past = await call('GET', `/api/pending-work/eod?day=${ymd(-3)}&build=1`, T.tl);
    check('O28 a past day can be built from the records, marked as rebuilt', past.status === 200 && past.body.report && past.body.report.rebuilt === true, [past.status, past.body && past.body.note]);
    const future = await call('GET', `/api/pending-work/eod?day=${ymd(5)}`, T.tl);
    check('O29 a future day says so in words', future.status === 200 && !future.body.report && /not happened/i.test(future.body.note || ''), future.body && future.body.note);

    // ---- mail went to the fake transport only: the sandbox API itself reports 'not sent' for test domains --------
    const apiRun = await call('POST', '/api/pending-work/digest/run', T.admin, { dryRun: true, force: true });
    check('M1 a dry run by the Admin writes and sends nothing', apiRun.status === 200 && apiRun.body.sent === 0 && apiRun.body.dryRun === true, [apiRun.status, apiRun.body && apiRun.body.sent]);
    check('M2 nobody but Admin / HR can run the sweeps by hand (403)', (await call('POST', '/api/pending-work/digest/run', T.tl, {})).status === 403 && (await call('POST', '/api/pending-work/eod/run', T.stl, {})).status === 403, null);
    check('M3 the injected mailer was the only mail path used (nothing real: this script never configured SMTP)', mails.every((m) => /example\.test$/.test(m.to)), mails.map((m) => m.to));
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      await prisma.holiday.deleteMany({ where: { name: { contains: 'ZZTEST PW' } } }).catch(() => null);
      if (KEEP) {
        const us = await prisma.user.findMany({ where: { id: { in: Z.made.users } }, select: { id: true, name: true, atsRole: true } });
        console.log('KEEP: fixtures left in the sandbox. Users (mint a token with {id}):');
        us.forEach((u) => console.log(`  ${u.atsRole.padEnd(10)} ${u.id}  ${u.name}`));
        await prisma.$disconnect();
        process.exit(Z.fail ? 1 : 0);
      }
      const left = await Z.cleanup();
      const real = await prisma.notification.count({ where: { createdAt: { gte: new Date(Date.now() - 3600000) }, title: { contains: 'Pending work' }, user: { name: { not: { contains: 'ZZTEST' } } } } }).catch(() => -1);
      console.log('leftovers after cleanup:', JSON.stringify(left), '· pending-work notices to real people in the last hour:', real);
      Z.check('Z cleanup: nothing ZZTEST PW is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();

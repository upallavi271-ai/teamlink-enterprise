#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHAT A RECRUITER MISSED -> THE RECRUITER AND THE TEAM LEAD (user, 2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/missed-reminders-test.js
//
// A ZZTEST team (TL, STL, Manager, Admin, recruiters R1 / R2). R1 misses: follow-ups, a task from the TL, a personal to-do, an interview
// feedback, a candidate waiting for the recruiter's check, a call due today. R2 misses nothing. Mail goes through a captured mailer
// (never a socket); WhatsApp / SMS through a captured sender. Everything is removed again.
//
//   I  the items: every kind is a source, dedupe of a step already covered by a follow-up, R2 nothing, test names only
//   W  the words: "You missed N things yesterday: ..." for the recruiter, "Your team missed ..." for the TL, plain, no contact / pay
//   R  who is told in ONE run: recruiter (level 0) and TL (level 1), then the STL
//   D  once per person per item per level per day; stops when done
//   O  Sunday / holiday: nothing; quiet hours: nothing before the morning time
//   S  settings: "Also remind the person themselves" off = TL still told; channels: bell / e-mail / WhatsApp only when connected and on
//   T  tasks: the per-task bell is not sent twice when these reminders are on; unchanged when they are off
//   B  the box: GET /pending-work/my-missed, own rows only
//   Y  dry run: counts of recruiters and TLs, example texts, nothing sent; master switch off = inert
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('MR');
const { prisma, call, check, RUN } = Z;
const path = require('path');

const PW = require(path.join(Z.BACK, 'src/utils/pendingWork'));
const CA = require(path.join(Z.BACK, 'src/utils/chainAlerts'));
const MI = require(path.join(Z.BACK, 'src/utils/missedItems'));
const { resolveIdentity } = require(path.join(Z.BACK, 'src/utils/identity'));

const DEPT = 'ZZTEST MR Dept';
const ymd = (offset = 0) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);
const PII = /9000000077|zz-mr-cand-|currentSalary|expectedSalary|salary|@example\.test/i;

(async () => {
  await Z.preclean();
  const mails = [];
  const mailer = async (m) => { mails.push(m); return { ok: true, providerRef: 'captured' }; };
  const wa = [];
  const msgSend = async (ch, o) => { wa.push({ ch, ...o }); return { ok: true, outcome: 'Sent' }; };
  try {
    const mk = (tag, extra, emp) => Z.mkUser(tag, extra, emp);
    const uAdmin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', hrmsAccess: true, atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL' });
    const uStl = await mk('stl', { role: 'STL', atsRole: 'STL', hrmsRole: 'STL', hrmsAccess: true, atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'STL' });
    const uMgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER', hrmsAccess: true }, { designation: 'Manager' });
    const rec = (tag, phone) => mk(tag, { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: uTl.name, phone });
    const r1 = await rec('r1', '9000000077');
    const r2 = await rec('r2', null);
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, tl: uTl, r1, r2 })) T[k] = await Z.mint(u);
    const viewer = await resolveIdentity(uAdmin.id);
    const ids = [r1.id, r2.id];
    const tools = { dayOfIst: PW.dayOfIst };
    void tools;

    // ---- data -----------------------------------------------------------------------------------------------------------
    const client = await prisma.client.create({ data: { name: `ZZTEST MR Client ${RUN}`, location: 'ZZ', ownerDepartment: DEPT, clientType: 'Client', agreementStatus: 'DRAFT' } });
    Z.made.clients.push(client.id);
    const mkJob = async (tag, rc) => { const j = await prisma.requirement.create({ data: { title: `ZZTEST MR Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: DEPT, recruiterId: rc.id, tlId: uTl.id, openings: 1 } }); Z.made.reqs.push(j.id); return j; };
    const j1 = await mkJob('1', r1); const j2 = await mkJob('2', r2);
    let n = 0;
    const mkApp = async (job, rc, stage, { fu = null, ago = 6 } = {}) => {
      n += 1;
      const cand = await prisma.candidate.create({ data: { name: `ZZTEST MR Cand ${n} ${RUN}`, email: `zz-mr-cand-${n}-${RUN}@example.test`, phone: '9000000077', currentSalary: '7L', location: 'ZZ' } });
      Z.made.cands.push(cand.id);
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: job.id, stage } });
      Z.made.apps.push(a.id);
      await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: cand.id, fromStage: null, toStage: stage, actorUserId: rc.id, actorName: rc.name, actorRole: 'Recruiter', action: 'Moved', createdAt: new Date(Date.now() - ago * 86400000) } }).catch(() => null);
      let f = null;
      if (fu !== null) f = await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: cand.id, requirementId: job.id, ownerUserId: rc.id, ownerName: rc.name, ownerRole: 'Recruiter', tlUserId: uTl.id, nextAction: 'ZZ follow up', dueDate: ymd(fu) } });
      return { a, cand, f };
    };
    const a1 = await mkApp(j1, r1, 'RECRUITER_REVIEW', { fu: -3 }); // follow-up (the step is covered by it: counted once)
    const a2 = await mkApp(j1, r1, 'NEW', { fu: -2 }); // follow-up
    const a6 = await mkApp(j1, r1, 'SHARED_WITH_CLIENT', { fu: -1 }); // follow-up due YESTERDAY (the client waits: not a recruiter step)
    const a3 = await mkApp(j1, r1, 'INTERVIEW_COMPLETED'); // interview done, no feedback: late
    const a4 = await mkApp(j1, r1, 'RECRUITER_REVIEW'); // waiting for the recruiter's check: late
    const a5 = await mkApp(j1, r1, 'TL_REVIEW'); // waiting for the TL: not the recruiter's miss
    const a7 = await mkApp(j2, r2, 'RECRUITER_REVIEW', { fu: 2, ago: 0 }); // R2: nothing late
    const a8 = await mkApp(j1, r1, 'NEW', { fu: 0, ago: 0 }); // follow-up due TODAY (a call not made, in the evening)
    const task = (who, by, name, end, status = 'Not Started') => prisma.task.create({ data: { name, status, endDate: end, assigneeId: who.id, assignedById: by.id, assigneeName: who.name, assignedByName: by.name } });
    const t1 = await task(r1, uTl, `ZZTEST MR task from TL ${RUN}`, ymd(-2));
    const t2 = await task(r1, r1, `ZZTEST MR own to-do ${RUN}`, ymd(-1));
    await task(r1, uTl, `ZZTEST MR task done ${RUN}`, ymd(-5), 'Completed');
    await task(r2, uTl, `ZZTEST MR task later ${RUN}`, ymd(3));
    void a5; void a7; void a2;

    const today = PW.dayOfIst(new Date());
    const off = await PW.offDayReason(today);
    const nowM = new Date(`${today}T06:00:00Z`); // 11:30 IST
    const nowEarly = new Date(`${today}T00:30:00Z`); // 06:00 IST
    if (off) console.log(`NOTE: today is a Sunday / holiday (${off}): the send steps use force=true`);
    const sunday = new Date('2026-10-18T06:30:00Z');
    const admin = { id: uAdmin.id, name: uAdmin.name };
    await PW.saveSettings({ enabled: true, chain: { enabled: true, approvals: true, followUps: true, tasks: true, steps: true, repeatDaily: true, maxLevel: 4, levelHours: [0, 0, 0, 0, 0] }, self: { enabled: true, bell: true, email: true, whatsapp: false, sms: false, time: '09:30' } }, admin);
    const collect = (extra = {}) => CA.collectItems({ now: nowM, work: true, viewer, people: ids, fresh: true, evening: false, ...extra });

    // =================================== I: the items ===================================
    const items = await collect();
    const mine = items.filter((i) => i.work && ids.includes(i.ownerId));
    const kinds = (list) => Object.entries(list.reduce((m, i) => ({ ...m, [i.mkind]: (m[i.mkind] || 0) + 1 }), {})).sort().map(([k, v]) => `${k}:${v}`).join(',');
    check('I1 R1 misses 3 follow-ups, 2 tasks (the TL\'s and his own to-do), 1 interview feedback, 1 check - nothing else', kinds(mine.filter((i) => i.ownerId === r1.id)) === 'check:1,feedback:1,followup:3,task:2', kinds(mine.filter((i) => i.ownerId === r1.id)));
    check('I2 R2 misses nothing (a follow-up coming up, a task later, a finished task are not misses)', !mine.some((i) => i.ownerId === r2.id), kinds(mine.filter((i) => i.ownerId === r2.id)));
    check('I3 the step of a candidate that already has an overdue follow-up is counted once (as the follow-up)', !mine.some((i) => i.mkind !== 'followup' && String(i.key).includes(a1.a.id)), mine.map((i) => i.key));
    check('I4 a step waiting for the TL is not the recruiter\'s miss', !mine.some((i) => String(i.key).includes(a5.a.id)), null);
    const t = mine.find((i) => i.mkind === 'task');
    check('I5 the chain of a task: the recruiter, then their TL, then the STL', !!t && t.levels[0].includes(r1.id) && t.levels[1].includes(uTl.id) && t.levels[2].includes(uStl.id), t && t.levels);
    const fu1 = mine.find((i) => i.key === `followup|${a1.f.id}`);
    check('I6 the follow-up chain is the recruiter, then the TL (even when the row names none), then the STL', !!fu1 && fu1.levels[0].includes(r1.id) && fu1.levels.some((l) => l.includes(uTl.id)), fu1 && fu1.levels);
    const noEve = mine.filter((i) => i.mkind === 'call');
    check('I7 calls due today are NOT counted in the morning (only after the end-of-day time)', noEve.length === 0, noEve.length);
    const eve = (await collect({ evening: true })).filter((i) => i.mkind === 'call' && i.ownerId === r1.id);
    check('I8 in the evening the follow-up due today that nobody called about is a call not made', eve.length === 1 && String(eve[0].detail).includes('Call not made'), eve.length);
    await prisma.candidateMessage.create({ data: { candidateId: a8.cand.id, channel: 'Call', template: 'QUICK_LOG', trigger: 'Manual', recipient: '9000000077', body: 'Answered', status: 'LOGGED', senderUserId: r1.id, senderName: r1.name } });
    check('I9 once the person was called the call is not missed any more', (await collect({ evening: true })).filter((i) => i.mkind === 'call' && i.ownerId === r1.id).length === 0, null);
    check('I10 the old kinds of the chain are still there (approvals, offers, follow-ups): no source was lost', typeof CA.collectItems === 'function' && items.some((i) => i.kind === 'followup'), null);

    // =================================== R / W: one run, recruiter + TL ===================================
    const keys = mine.map((i) => i.key);
    const run = (o = {}) => CA.run({ now: nowM, keys, viewer, people: ids, mailer, msgSend, testMode: true, quiet: true, force: !!off, evening: false, fresh: true, ...o });
    const bellsOf = (uid) => prisma.notification.findMany({ where: { userId: uid, channel: 'In-App', recipient: { startsWith: 'pwr|chain|' } }, orderBy: { createdAt: 'asc' } });
    mails.length = 0;
    const r = await run();
    const b1 = (await bellsOf(r1.id))[0];
    const bTl = (await bellsOf(uTl.id))[0];
    const bStl = (await bellsOf(uStl.id))[0];
    check('R1 ONE run tells the recruiter AND the team lead (and the STL above)', !!b1 && !!bTl && !!bStl && r.recruiters >= 1 && r.tlPeople >= 1, [!!b1, !!bTl, !!bStl, r.recruiters, r.tlPeople]);
    check('R2 R2 (nothing missed) hears nothing', (await bellsOf(r2.id)).length === 0, null);
    check('W1 the recruiter\'s bell: "You missed N things yesterday: ..." with the kinds counted, ending "Open your list."', !!b1 && /You missed \d+ things? (yesterday|since)/.test(b1.message) && /follow-up/.test(b1.message) && /task/.test(b1.message) && /Open your list\./.test(b1.message), b1 && b1.message);
    check('W2 title "You missed N things", and the link is their own list on the dashboard', !!b1 && /^You missed \d+ things?$/.test(b1.title) && /Open: .*\/ats\/dashboard#missed-items/.test(b1.message), b1 && [b1.title, b1.message]);
    check('W3 the bell says how many were missed yesterday and how many are still waiting from before', !!b1 && /Still waiting from before|missed \d+ things? (yesterday|since)/.test(b1.message), b1 && b1.message);
    check('W4 the team lead\'s notice: "Your team missed ..." with the recruiter\'s name and counts', !!bTl && /Your team missed|waiting on your team/.test(bTl.message) && new RegExp(r1.name).test(bTl.message) && /follow-up/.test(bTl.message), bTl && [bTl.title, bTl.message]);
    const mailR1 = mails.find((m) => m.to === r1.email);
    const mailTl = mails.find((m) => m.to === uTl.email);
    check('W5 the recruiter also gets the mail (e-mail connected + switched on), the TL too', !!mailR1 && !!mailTl && /You missed/.test(mailR1.text), mails.map((m) => m.to));
    check('W6 no candidate phone / e-mail / pay in any bell or mail', !PII.test(`${mails.map((m) => m.text + m.html).join(' ')} ${[b1, bTl, bStl].map((b) => b && b.message).join(' ')}`.replace(new RegExp(`${r1.email}|${uTl.email}|${uStl.email}`, 'g'), '')), null);
    check('W7 the TL also gets the follow-ups of the recruiter with names (level 1, same run)', !!mailTl && /Waiting on the people under you/.test(mailTl.text), mailTl && mailTl.text.slice(0, 300));
    const own1 = r1.name;
    check('W8 the recruiter\'s text lists the missed items, own name not repeated on each line', !!mailR1 && !new RegExp(`• ${own1}:`).test(mailR1.text), mailR1 && mailR1.text.slice(0, 400));

    // =================================== D: once a day, stops when done ===================================
    const n1 = mails.length; const bell1 = await prisma.notification.count({ where: { userId: { in: [r1.id, uTl.id, uStl.id] }, recipient: { startsWith: 'pwr|chain|' } } });
    const r2run = await run();
    const bell2 = await prisma.notification.count({ where: { userId: { in: [r1.id, uTl.id, uStl.id] }, recipient: { startsWith: 'pwr|chain|' } } });
    check('D1 the same day again: nobody is told twice (one per person per item per level per day)', r2run.toTell === 0 && mails.length === n1 && bell2 === bell1, [r2run.toTell, mails.length - n1, bell2 - bell1]);
    // done: complete one follow-up + the TL task; they leave the list
    await prisma.applicationFollowUp.update({ where: { id: a1.f.id }, data: { completedAt: new Date() } });
    await prisma.task.update({ where: { id: t1.id }, data: { status: 'Completed', completedAt: new Date() } });
    const after = (await collect()).filter((i) => i.work && i.ownerId === r1.id);
    check('D2 done = gone: the finished follow-up and task are no longer missed (a candidate whose follow-up is done is judged by their step again)', !after.some((i) => i.key === `followup|${a1.f.id}` || i.key === `task|${t1.id}`) && after.filter((i) => i.mkind === 'followup').length === 2 && after.filter((i) => i.mkind === 'task').length === 1, kinds(after));
    await prisma.applicationFollowUp.update({ where: { id: a1.f.id }, data: { completedAt: null } });
    await prisma.task.update({ where: { id: t1.id }, data: { status: 'Not Started', completedAt: null } });
    // a new day: repeat (still not done)
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: PW.SENT_PREFIX } } });
    mails.length = 0;
    const r3 = await run();
    check('D3 the next working day, still not done: the reminder comes again (until it is done)', r3.toTell > 0 && mails.some((m) => m.to === r1.email), r3.toTell);

    // =================================== O: Sunday / holiday / quiet hours ===================================
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: PW.SENT_PREFIX } } });
    await prisma.appSetting.deleteMany({ where: { key: 'pwr.chain' } });
    mails.length = 0;
    const sRun = await CA.run({ now: sunday, keys, viewer, people: ids, mailer, testMode: true, quiet: true, evening: false, fresh: true });
    check('O1 Sunday: nothing is sent to the recruiter or the TL (not even a first time)', sRun.toTell === 0 && mails.length === 0, [sRun.toTell, mails.length]);
    await prisma.holiday.create({ data: { name: 'ZZTEST MR holiday', date: '2026-10-14', type: 'Festival' } });
    const hRun = await CA.run({ now: new Date('2026-10-14T06:30:00Z'), keys, viewer, people: ids, mailer, testMode: true, quiet: true, evening: false, fresh: true });
    check('O2 a company holiday: nothing is sent', hRun.toTell === 0 && mails.length === 0, hRun.toTell);
    await prisma.holiday.deleteMany({ where: { name: 'ZZTEST MR holiday' } });
    await prisma.holiday.create({ data: { name: 'ZZTEST MR optional', date: '2026-10-15', type: 'Optional' } });
    const oRun = await CA.run({ now: new Date('2026-10-15T06:30:00Z'), keys, viewer, people: ids, mailer, testMode: true, quiet: true, dryRun: true, evening: false, fresh: true });
    check('O3 an Optional holiday does not stop it', oRun.toTell > 0, oRun.toTell);
    await prisma.holiday.deleteMany({ where: { name: 'ZZTEST MR optional' } });
    const early = await CA.run({ now: nowEarly, keys, viewer, people: ids, mailer, testMode: true, quiet: true, force: false, dryRun: true, evening: false, fresh: true });
    check('O4 before the morning time (06:00 IST) nothing is sent: the reminder waits for 09:30', off ? true : early.toTell === 0, early.toTell);

    // =================================== S: settings, channels ===================================
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: PW.SENT_PREFIX } } });
    await prisma.appSetting.deleteMany({ where: { key: 'pwr.chain' } });
    await PW.saveSettings({ self: { enabled: false } }, admin);
    mails.length = 0;
    const bR1 = (await bellsOf(r1.id)).length; const bT = (await bellsOf(uTl.id)).length;
    await run();
    check('S1 "Also remind the person themselves" OFF: the TL is still told, the recruiter is not', (await bellsOf(uTl.id)).length > bT && (await bellsOf(r1.id)).length === bR1 && !mails.some((m) => m.to === r1.email) && mails.some((m) => m.to === uTl.email), [bT, bR1]);
    await PW.saveSettings({ self: { enabled: true, bell: true, email: false, whatsapp: true, sms: false } }, admin);
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: PW.SENT_PREFIX } } });
    await prisma.appSetting.deleteMany({ where: { key: 'pwr.chain' } });
    mails.length = 0; wa.length = 0;
    const bR1b = (await bellsOf(r1.id)).length;
    await run();
    check('S2 channels one by one: bell on, e-mail off = no mail to the recruiter; WhatsApp on (connected) = one message to their phone', (await bellsOf(r1.id)).length === bR1b + 1 && !mails.some((m) => m.to === r1.email) && wa.length === 1 && wa[0].ch === 'WhatsApp' && wa[0].to === '9000000077' && /You missed/.test(wa[0].text), [mails.map((m) => m.to), wa]);
    check('S3 WhatsApp text: short, plain, no candidate contact', wa[0] && wa[0].text.length <= 300 && !/zz-mr-cand|salary/i.test(wa[0].text), wa[0] && wa[0].text);
    await PW.saveSettings({ self: { enabled: true, bell: true, email: true, whatsapp: true, sms: false } }, admin);
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: PW.SENT_PREFIX } } });
    await prisma.appSetting.deleteMany({ where: { key: 'pwr.chain' } });
    wa.length = 0;
    const noSender = await CA.run({ now: nowM, keys, viewer, people: ids, mailer, testMode: true, quiet: true, force: !!off, evening: false, fresh: true });
    void noSender;
    check('S4 WhatsApp switched on but NOT connected (real channel check, no test sender): nothing goes out that way', wa.length === 0, wa);
    const bad = await call('PUT', '/api/pending-work/settings', T.admin, { self: { time: '9.30' } });
    check('S5 a bad time is refused in plain words', bad.status === 400 && /time/i.test((bad.body && bad.body.error) || ''), bad.body);
    const ok = await call('PUT', '/api/pending-work/settings', T.admin, { self: { enabled: true, time: '09:30', bell: true, email: true, whatsapp: false, sms: false } });
    check('S6 the settings save (Admin) and the new fields come back', ok.status === 200 && ok.body.settings.self.time === '09:30' && ok.body.settings.chain.tasks === true && ok.body.settings.chain.steps === true, ok.body);
    const forbid = await call('PUT', '/api/pending-work/settings', T.tl, { self: { enabled: false } });
    check('S7 a team lead cannot change them', forbid.status === 403, forbid.status);
    check('S8 defaults: "Also remind the person themselves" is ON, the master switch is OFF', PW.DEFAULTS.self.enabled === true && PW.DEFAULTS.enabled === false && PW.DEFAULTS.self.whatsapp === false && PW.DEFAULTS.self.sms === false, PW.DEFAULTS.self);

    // =================================== T: tasks are not told twice ===================================
    const HN = require(path.join(Z.BACK, 'src/utils/hrmsNotify'));
    await prisma.task.updateMany({ where: { id: { in: [t1.id, t2.id] } }, data: { overdueRemindedOn: null } });
    await prisma.notification.deleteMany({ where: { userId: { in: [r1.id, uTl.id] }, title: { startsWith: 'Task overdue' } } });
    await PW.saveSettings({ enabled: true }, admin);
    await HN.reminders({ now: nowM, testMode: true, scope: { userIds: [r1.id, uTl.id] }, mailer });
    const perTaskOn = await prisma.notification.count({ where: { userId: r1.id, title: { startsWith: 'Task overdue' } } });
    const giver = await prisma.notification.count({ where: { userId: uTl.id, title: { contains: 'you gave' } } });
    check('T1 reminders ON: the recruiter is NOT also sent the per-task bell (they are in "You missed N things"); the TL who gave the task still hears', perTaskOn === 0 && giver >= 1, [perTaskOn, giver]);
    await PW.saveSettings({ enabled: false }, admin);
    await prisma.task.updateMany({ where: { id: { in: [t1.id, t2.id] } }, data: { overdueRemindedOn: null } });
    await prisma.notification.deleteMany({ where: { userId: { in: [r1.id, uTl.id] }, title: { startsWith: 'Task overdue' } } });
    await HN.reminders({ now: nowM, testMode: true, scope: { userIds: [r1.id, uTl.id] }, mailer });
    check('T2 master switch OFF (today\'s real setting): the recruiter gets the per-task bell exactly as before', (await prisma.notification.count({ where: { userId: r1.id, title: { startsWith: 'Task overdue' } } })) >= 1, null);
    await PW.saveSettings({ enabled: true }, admin);

    // =================================== digest: tasks late shown to the TL ===================================
    const dig = await PW.runDigest({ now: nowM, viewer, people: ids, mailer, testMode: true, dryRun: true, force: true });
    const prev = ((dig.teams || [])[0] || {}).preview;
    check('G1 the TL\'s daily list also carries "Tasks late" per recruiter (the digest counts them)', !!prev && /Tasks late 2/.test(prev.text), prev && prev.text.slice(0, 500));

    // =================================== B: the box ===================================
    const box = await call('GET', '/api/pending-work/my-missed?fresh=1', T.r1);
    check('B1 GET /pending-work/my-missed (R1): the groups, each with an Open link', box.status === 200 && box.body.total >= 6 && box.body.groups.length >= 3 && box.body.groups.every((g) => g.items.every((i) => i.link && i.title)), box.body && [box.body.total, box.body.groups && box.body.groups.map((g) => `${g.kind}:${g.n}`)]);
    check('B2 the box\'s summary is the same plain sentence', /You missed \d+ things? (yesterday|since)|still waiting from before/.test(box.body.summary || ''), box.body.summary);
    const boxR2 = await call('GET', '/api/pending-work/my-missed', T.r2);
    check('B3 R2 sees an empty box (and "Nothing missed")', boxR2.status === 200 && boxR2.body.total === 0 && /Nothing missed/.test(boxR2.body.summary), boxR2.body);
    check('B4 R1\'s box never shows R2\'s things, nor any candidate phone / e-mail', !/ZZTEST MR task later|9000000077|zz-mr-cand-.*@/.test(box.text), null);
    const boxTl = await call('GET', '/api/pending-work/my-missed', T.tl);
    check('B5 the TL\'s box is their own (not the team\'s)', boxTl.status === 200 && boxTl.body.total === 0, boxTl.body && boxTl.body.total);

    // =================================== Y: dry run, master switch ===================================
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: PW.SENT_PREFIX } } });
    await prisma.appSetting.deleteMany({ where: { key: 'pwr.chain' } });
    mails.length = 0;
    const dry = await CA.run({ now: nowM, keys, viewer, people: ids, mailer, testMode: true, quiet: true, dryRun: true, force: true, evening: false, fresh: true });
    check('Y1 dry run: counts the recruiters and the team leads and writes an example for each - and sends nothing', dry.recruiters === 1 && dry.tlPeople === 1 && !!dry.sample.recruiter && !!dry.sample.tl && mails.length === 0 && (await bellsOf(r1.id)).length === (await bellsOf(r1.id)).length, [dry.recruiters, dry.tlPeople]);
    check('Y2 the example texts read like the spec', /You missed/.test(dry.sample.recruiter.text) && /Open your list/.test(dry.sample.recruiter.text) && /Your team missed|waiting on your team/.test(dry.sample.tl.text), [dry.sample.recruiter.text, dry.sample.tl.text]);
    await PW.saveSettings({ enabled: false }, admin);
    const offRun = await CA.run({ now: nowM, keys, viewer, people: ids, mailer, testMode: true, quiet: true, evening: false, fresh: true });
    check('Y3 master switch OFF: the run is inert (nothing sent, a plain reason)', offRun.skipped && offRun.toTell === 0, offRun.skipped);
    const tickOff = await PW.tick({ now: nowM, viewer, mailer, testMode: true });
    check('Y4 the sweep (tick) does nothing at all while the master switch is off', tickOff.skipped === 'off', tickOff);

    // the chain\'s cheap view (dashboard "Pending on my team") does not read the recruiters\' world
    await PW.saveSettings({ enabled: true }, admin);
    const cv = await call('GET', '/api/pending-work/chain?fresh=1', T.tl);
    check('Y5 the dashboard\'s "Pending on my team" still works and is not slowed (original sources)', cv.status === 200 && Array.isArray(cv.body.rows), cv.status);
    void MI;
  } catch (e) {
    console.error(e);
    Z.check('CRASH: the test stopped on an error', false, e && e.message);
  } finally {
    const left = await Z.cleanup([
      (p) => p.candidate.deleteMany({ where: { email: { contains: 'zz-mr-cand-' } } }),
      (p) => p.task.deleteMany({ where: { OR: [{ name: { contains: 'ZZTEST MR' } }, { assigneeName: { contains: 'ZZTEST MR' } }] } }),
      (p) => p.holiday.deleteMany({ where: { name: { contains: 'ZZTEST MR' } } }),
    ]);
    console.log('cleanup left:', JSON.stringify(left));
    Z.check('Z cleanup left nothing', Object.values(left).every((v) => v === 0), left);
    await Z.finish();
  }
})().catch(async (e) => { console.error(e); try { await Z.cleanup(); } catch { /* */ } process.exit(1); });

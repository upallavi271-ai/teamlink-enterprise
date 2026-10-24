// INTERVIEW REMINDERS - schedule math, dedupe, supersede, quiet hours, Sunday, switches (SANDBOX; simulated clock).
const { build, cleanup, L } = require('./iv-fx');
const E = require('./env');
const { check } = L;
const P = L.prisma;
const ENG = require(`${L.BACK}/src/utils/interviewEngine`);
const PLAN = require(`${L.BACK}/src/utils/interviewReminderPlan`);

const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;
const ist = (s) => new Date(`${s}:00+05:30`); // 'YYYY-MM-DDTHH:MM' India time
const T1 = ist('2026-10-14T11:00'); // a Wednesday
const TSUN = ist('2026-10-18T11:00'); // a Sunday

async function interview(W, label, at, { mode = 'Online', link = 'https://meet.google.com/zz-iv-test', bookedAgoMin = 3000, bookedAt = null, panel = true, status = 'SCHEDULED', phone } = {}) {
  const x = await W.mkc(label, 'INTERVIEW_SCHEDULED', phone ? { phone } : {});
  await P.application.update({ where: { id: x.a.id }, data: { interviewAt: at, interviewStatus: status, interviewMode: mode, interviewMeetingLink: mode === 'Online' ? link : null, interviewLocation: mode === 'In Person' ? 'ZZTEST IV Hall, Hyderabad' : null, interviewer: 'ZZTEST IV rec2', interviewRound: 1, interviewCode: `INT-${x.a.id.slice(-6).toUpperCase()}` } });
  await P.interviewEvent.create({ data: { applicationId: x.a.id, status: 'SCHEDULED', toSlot: at.toISOString(), by: 'ZZTEST', reason: 'Interview booked', createdAt: bookedAt || new Date(Date.now() - bookedAgoMin * MIN) } });
  if (panel) await P.interviewPanelist.create({ data: { applicationId: x.a.id, round: 1, userId: W.u.rec2.id, name: W.u.rec2.name, email: W.u.rec2.email, position: 0 } });
  return x;
}
const events = async (id, like) => (await P.interviewEvent.findMany({ where: { applicationId: id, status: { startsWith: like || 'REMINDER_' } }, orderBy: { createdAt: 'asc' } }));
const kinds = async (id) => (await events(id)).map((e) => e.status);
const cmsgs = (cid, label) => P.candidateMessage.findMany({ where: { candidateId: cid, ...(label ? { templateLabel: label } : {}) }, orderBy: { createdAt: 'asc' } });
const bells = (uid, title) => P.notification.findMany({ where: { userId: uid, title: { contains: title } }, orderBy: { createdAt: 'asc' } });

(async () => {
  let W; const saved = {};
  try {
    W = await build();
    const U = W.u;
    // other agents share this sandbox and flip these two switches: pin them before EVERY run
    const SW = { cand: true, staffOff: false };
    const pin = async () => {
      const v = JSON.stringify({ enabled: SW.cand });
      await P.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: v }, update: { value: v } });
      if (SW.staffOff) await P.appSetting.upsert({ where: { key: 'interview-staff-reminders' }, create: { key: 'interview-staff-reminders', value: JSON.stringify({ enabled: false }) }, update: { value: JSON.stringify({ enabled: false }) } });
      else await P.appSetting.deleteMany({ where: { key: 'interview-staff-reminders' } });
    };
    const run = async (now, ids, body) => {
      await pin();
      const r = await L.post(U.sa, '/ats/interview-reminders/run', { now: new Date(now).toISOString(), onlyIds: ids, asTimer: true, ...(body || {}) });
      if (r.status !== 200) console.log('RUN FAILED', r.status, r.text.slice(0, 300));
      return r.body || {};
    };
    const setPlan = (p) => L.put(U.sa, '/ats/interview-reminder-plan', p);
    saved.sw = await P.appSetting.findUnique({ where: { key: 'interview-reminders' } });
    saved.st = await P.appSetting.findUnique({ where: { key: 'interview-staff-reminders' } });
    await E.setup(U.sa); // fake SMS + WhatsApp accounts, candidate emails ON, quiet hours off, limits high
    await P.appSetting.deleteMany({ where: { key: 'interview-staff-reminders' } });
    // ===== 0. INERT UNTIL ARMED: a fresh plan sends nothing outside the app ================================================
    check('0 default plan: automatic sending is OFF', (await PLAN.load()).armed === false);
    const jobs0n = (await L.get(U.sa, '/messaging/bulk')).body.filter((j) => j.audience === 'employees').length;
    const Un = await interview(W, 'Unarmed', T1);
    const u1 = await run(T1.getTime() - 50 * MIN, [Un.a.id]);
    check('0 not armed: no message to the candidate, no safety net, no mail/WhatsApp/SMS to the team', (await cmsgs(Un.c.id)).length === 0 && u1.candidateHour === 0, u1);
    check('0 not armed: the in-app bell still goes to the team', (await bells(U.tl.id, 'Interview in 1 hour')).some((b) => /Unarmed/.test(b.message)));
    check('0 not armed: no messaging job to the team either', (await L.get(U.sa, '/messaging/bulk')).body.filter((j) => j.audience === 'employees').length === jobs0n);
    const u2 = await run(T1.getTime() - 50 * MIN, [Un.a.id], { asTimer: false });
    check('0 an Admin pressing "Run now" (force) is a deliberate action: it sends', (await cmsgs(Un.c.id)).length >= 1 || u2.candidateHour === 1, u2);
    await P.interviewEvent.deleteMany({ where: { applicationId: Un.a.id, status: { startsWith: 'REMINDER_' } } });
    await P.notification.deleteMany({ where: { message: { contains: 'Unarmed' } } });
    await P.candidateMessage.deleteMany({ where: { candidateId: Un.c.id } });
    await setPlan({ armed: true, candidate: { channels: ['Email'], strategy: 'first' } }); // Email only, unless a case says otherwise

    // ===== A. the time math (pure) =================================================================================
    const plan = PLAN.clean({});
    const due = (leftMin, bookedMin, o = {}) => ENG.candidateDue({ leftMs: leftMin * MIN, bookedAgoMs: bookedMin * MIN, online: o.online !== false, hasLink: o.hasLink !== false, plan: o.plan || plan });
    check('A 24 h before: day reminder inside (10 h, 24 h]', JSON.stringify(due(23 * 60 + 50, 5000)) === '["day"]' && due(24 * 60 + 1, 5000).length === 0 && JSON.stringify(due(10 * 60 + 1, 5000)) === '["day"]' && due(10 * 60, 5000).length === 0);
    check('A 1 hour before: (20 min, 60 min]', JSON.stringify(due(60, 5000)) === '["hour"]' && JSON.stringify(due(21, 5000)) === '["hour"]' && due(61, 5000).length === 0);
    check('A 15 minutes before (online with a link): (0, 20 min]', JSON.stringify(due(15, 5000)) === '["now"]' && JSON.stringify(due(1, 5000)) === '["now"]' && due(0, 5000).length === 0 && due(15, 5000, { online: false }).length === 0 && due(15, 5000, { hasLink: false }).length === 0);
    check('A just booked: no "tomorrow" 1 minute after booking, no hour reminder for a slot booked 10 minutes ago', due(23 * 60, 30).length === 0 && due(40, 10).length === 0 && JSON.stringify(due(40, 31)) === '["hour"]');
    check('A staff hour reminder: (0, 60 min], not for a fresh booking', ENG.staffHourDue({ leftMs: 59 * MIN, bookedAgoMs: HOUR }) && !ENG.staffHourDue({ leftMs: 61 * MIN, bookedAgoMs: HOUR }) && !ENG.staffHourDue({ leftMs: 30 * MIN, bookedAgoMs: 10 * MIN }) && !ENG.staffHourDue({ leftMs: -1, bookedAgoMs: HOUR }));
    check('A no-show nudge: from 30 min after the start to 6 h', !ENG.noShowDue({ sinceStartMs: 29 * MIN, plan }) && ENG.noShowDue({ sinceStartMs: 31 * MIN, plan }) && !ENG.noShowDue({ sinceStartMs: 7 * HOUR, plan }));
    check('A morning list: from 08:30 India time', !ENG.digestDue({ now: ist('2026-10-14T08:29'), plan }) && ENG.digestDue({ now: ist('2026-10-14T08:30'), plan }) && ENG.digestDue({ now: ist('2026-10-14T17:00'), plan }));

    // ===== B. the day reminder + dedupe ================================================================================
    const X = await interview(W, 'Xena', T1);
    const t1 = await run(T1.getTime() - 23 * HOUR - 50 * MIN, [X.a.id]);
    check('B 23 h 50 m before: candidate day reminder fires', t1.candidateDay === 1 && (await kinds(X.a.id)).includes('REMINDER_C_DAY'), t1);
    let ms = await cmsgs(X.c.id, 'Interview reminder (1 day before)');
    check('B ... a real Mail went through the messaging module (fake transport), no client name', ms.length === 1 && ms[0].channel === 'Email' && ms[0].status === 'SENT' && !ms[0].body.includes(W.client.name) && /Round: 1/.test(ms[0].body) && /meet\.google\.com\/zz-iv-test/.test(ms[0].body), ms.map((m) => `${m.status} ${m.body}`));
    const t1b = await run(T1.getTime() - 23 * HOUR - 40 * MIN, [X.a.id]);
    check('B same reminder is never sent twice (dedupe by slot)', t1b.candidateDay === 0 && (await cmsgs(X.c.id, 'Interview reminder (1 day before)')).length === 1, t1b);
    check('B nothing for the team yet (no digest that day, no hour reminder)', (await bells(U.tl.id, 'Interview in 1 hour')).length === 0 && (await bells(U.tl.id, "Today's interviews")).length === 0);

    // ===== C. the hour reminder (candidate + team) + the morning list ======================================================
    const t2 = await run(T1.getTime() - 50 * MIN, [X.a.id]);
    check('C 50 min before: candidate hour reminder + team hour reminder', t2.candidateHour === 1 && t2.staffHour === 1, t2);
    const k2 = await kinds(X.a.id);
    check('C ... markers written (survive a restart)', ['REMINDER_C_DAY', 'REMINDER_C_HOUR', 'REMINDER_HOUR'].every((k) => k2.includes(k)), k2);
    const who = [['recruiter', U.rec], ['tl', U.tl], ['bde', U.bde], ['interviewer', U.rec2]];
    for (const [nm, u] of who) {
      const b = await bells(u.id, 'Interview in 1 hour');
      check(`C ${nm}: bell "Interview in 1 hour" with candidate, time, job, link`, b.length === 1 && /ZZTEST IV Xena/.test(b[0].message) && /11:00 am/.test(b[0].message) && /ZZTEST IV Teacher/.test(b[0].message) && /meet\.google\.com/.test(b[0].message), b.map((x) => x.message));
    }
    const bb = (await bells(U.bde.id, 'Interview in 1 hour'))[0];
    check('C BDE bell: names the client, carries no candidate phone or email', bb.message.includes(W.client.name) && !bb.message.includes(X.c.phone) && !bb.message.includes(X.c.email), bb.message);
    ms = await cmsgs(X.c.id, 'Interview reminder (1 hour)');
    check('C candidate got the 1-hour Mail', ms.length === 1 && ms[0].status === 'SENT' && /starts in 1 hour/.test(ms[0].body), ms.map((m) => m.body));
    for (const [nm, u] of who) {
      const dg = await bells(u.id, "Today's interviews");
      check(`C ${nm}: morning list "Today's interviews: 1" (after 08:30)`, dg.length === 1 && /Today's interviews: 1/.test(dg[0].title) && /ZZTEST IV Xena/.test(dg[0].message) && /Round 1/.test(dg[0].message), dg.map((x) => x.title));
    }
    const dgB = (await bells(U.bde.id, "Today's interviews"))[0];
    check('C BDE list: no candidate phone or email', !dgB.message.includes(X.c.phone) && !dgB.message.includes(X.c.email), dgB.message);
    await run(T1.getTime() - 45 * MIN, [X.a.id]);
    check('C list and hour bell once only', (await bells(U.tl.id, "Today's interviews")).length === 1 && (await bells(U.tl.id, 'Interview in 1 hour')).length === 1);
    const beforeList = ist('2026-10-14T08:29');
    const Early = await interview(W, 'Early', ist('2026-10-14T10:00'));
    await run(beforeList, [Early.a.id]);
    check('C no morning list before 08:30', (await bells(U.tl.id, "Today's interviews")).length === 1 /* still only Xena's, none for Early */);

    // ===== D. the 15-minute reminder (online + link only) ======================================================================
    const t3 = await run(T1.getTime() - 12 * MIN, [X.a.id]);
    check('D 12 min before (online with link): 15-minute reminder with the join link', t3.candidateNow === 1, t3);
    ms = await cmsgs(X.c.id, 'Interview reminder (15 minutes, with link)');
    check('D ... Mail has the link and the interviewer', ms.length === 1 && /meet\.google\.com\/zz-iv-test/.test(ms[0].body) && /15 minutes/.test(ms[0].body), ms.map((m) => m.body));
    const Ip = await interview(W, 'Inpers', T1, { mode: 'In Person' });
    const t3b = await run(T1.getTime() - 12 * MIN, [Ip.a.id]);
    check('D in-person interview: no 15-minute online reminder', t3b.candidateNow === 0 && !(await kinds(Ip.a.id)).includes('REMINDER_C_NOW'), t3b);
    const Fresh = await interview(W, 'Fresh', T1, { bookedAt: new Date(T1.getTime() - 45 * MIN) }); // booked 5 minutes before the simulated clock
    const t3c = await run(T1.getTime() - 40 * MIN, [Fresh.a.id]);
    check('D booked 5 minutes ago and the slot is 40 minutes away: no reminder storm', t3c.candidateHour === 0 && t3c.staffHour === 0, t3c);

    // ===== E. "Did the candidate attend?" ======================================================================================
    const t4a = await run(T1.getTime() + 29 * MIN, [X.a.id]);
    check('E 29 min after the start: no nudge yet', t4a.noShow === 0);
    const t4 = await run(T1.getTime() + 31 * MIN, [X.a.id]);
    const nb = await bells(U.rec.id, 'attend?');
    check('E 31 min after the start, still Scheduled: the recruiter is asked "Did ... attend?"', t4.noShow === 1 && nb.length === 1 && /Did ZZTEST IV Xena attend\?/.test(nb[0].title), nb.map((x) => x.title));
    check('E the TL is not bothered (the recruiter owns it)', (await bells(U.tl.id, 'attend?')).length === 0);
    await run(T1.getTime() + 40 * MIN, [X.a.id]);
    check('E asked once only', (await bells(U.rec.id, 'attend?')).length === 1);
    await P.application.update({ where: { id: Ip.a.id }, data: { interviewStatus: 'STARTED' } });
    const t4c = await run(T1.getTime() + 31 * MIN, [Ip.a.id]);
    check('E a started interview is not nudged', t4c.noShow === 0);

    // ===== F. feedback pending ======================================================================================================
    const t5 = await run(T1.getTime() + 3 * HOUR, [X.a.id]);
    check('F 3 h after, no feedback: interviewer + recruiter + TL are reminded', t5.feedbackMissing === 1, t5);
    for (const [nm, u] of [['recruiter', U.rec], ['tl', U.tl], ['interviewer', U.rec2]]) {
      check(`F ${nm}: "Feedback missing" bell`, (await bells(u.id, 'Feedback missing')).length === 1, nm);
    }
    check('F BDE is not asked for feedback', (await bells(U.bde.id, 'Feedback missing')).length === 0);
    await run(T1.getTime() + 4 * HOUR, [X.a.id]);
    check('F once a day', (await bells(U.tl.id, 'Feedback missing')).length === 1);
    await run(T1.getTime() + 27 * HOUR, [X.a.id]);
    check('F ... and again the next day', (await bells(U.tl.id, 'Feedback missing')).length === 2);

    // ===== G. reschedule: old reminders die, new ones arm =================================================================================
    const Y = await interview(W, 'Yash', ist('2026-10-14T16:00'));
    await run(ist('2026-10-14T16:00').getTime() - 23 * HOUR - 50 * MIN, [Y.a.id]);
    check('G before the move: day reminder sent for the first slot', (await events(Y.a.id, 'REMINDER_C_DAY')).length === 1);
    const newSlot = ist('2026-10-16T15:00');
    const rs = await L.post(U.admin, `/ats/interviews/${Y.a.id}/reschedule`, { interviewAt: newSlot.toISOString(), reason: 'Panel busy', viaPopup: true });
    check('G reschedule ok', rs.status === 200, rs.body);
    await run(ist('2026-10-14T16:00').getTime() - 50 * MIN, [Y.a.id]);
    check('G the OLD slot gets no hour reminder any more', (await events(Y.a.id, 'REMINDER_HOUR')).length === 0 && (await bells(U.tl.id, 'Interview in 1 hour')).filter((b) => /Yash/.test(b.title)).length === 0);
    const g2 = await run(newSlot.getTime() - 23 * HOUR - 50 * MIN, [Y.a.id]);
    const dayEv = await events(Y.a.id, 'REMINDER_C_DAY');
    check('G the NEW slot arms a new day reminder', g2.candidateDay === 1 && dayEv.length === 2 && dayEv[1].toSlot === newSlot.toISOString(), dayEv.map((e) => e.toSlot));
    // ===== H. cancel: no more reminders, the cancellation notice goes once ================================================================
    const cx = await L.post(U.admin, `/ats/interviews/${Y.a.id}/cancel`, { reason: 'Client changed plan', viaPopup: true });
    check('H cancel ok', cx.status === 200, cx.body);
    const h1 = await run(newSlot.getTime() - 50 * MIN, [Y.a.id]);
    check('H cancelled interview: no hour reminders, no list', h1.candidateHour === 0 && h1.staffHour === 0 && h1.digests === 0, h1);
    const realNow = Date.now();
    const h2 = await run(realNow + 11 * MIN, [Y.a.id]);
    const cm = await cmsgs(Y.c.id, 'Interview cancelled');
    check('H nobody told the candidate: the cancellation goes by itself after 10 minutes, once', h2.netBooked === 1 && cm.length === 1 && /cancelled/.test(cm[0].body) && !cm[0].body.includes(W.client.name) && !/Client changed plan/.test(cm[0].body), { h2, bodies: cm.map((m) => m.body) });
    const h3 = await run(realNow + 20 * MIN, [Y.a.id]);
    check('H ... and not again', h3.netBooked === 0 && (await cmsgs(Y.c.id, 'Interview cancelled')).length === 1);

    // ===== I. the booking safety net =========================================================================================================
    const Z = await W.mkc('Zoya', 'CLIENT_SHORTLISTED');
    const bk = await L.post(U.admin, `/ats/interviews/${Z.a.id}/book`, { round: 1, date: new Date(Date.now() + 3 * DAY + 330 * MIN).toISOString().slice(0, 10), time: '11:45', mode: 'Online', meetingLink: 'https://meet.google.com/abc', panel: [{ userId: U.rec2.id }], viaPopup: true });
    check('I booked through the window (no automatic message)', bk.status === 200 && (await cmsgs(Z.c.id)).length === 0);
    const i0 = await run(Date.now() + 5 * MIN, [Z.a.id]);
    check('I 5 minutes later the window may still be open: nothing yet', i0.netBooked === 0);
    const i1 = await run(Date.now() + 11 * MIN, [Z.a.id]);
    const zm = await cmsgs(Z.c.id, 'Interview booked');
    check('I 11 minutes later nobody told her: the booked message goes by itself (Mail)', i1.netBooked === 1 && zm.length === 1 && zm[0].status === 'SENT' && /is booked/.test(zm[0].body) && !zm[0].body.includes(W.client.name), { i1, b: zm.map((m) => m.body) });
    const i2 = await run(Date.now() + 30 * MIN, [Z.a.id]);
    check('I ... only once', i2.netBooked === 0 && (await cmsgs(Z.c.id, 'Interview booked')).length === 1);
    const Z2 = await W.mkc('Zara', 'CLIENT_SHORTLISTED');
    await L.post(U.admin, `/ats/interviews/${Z2.a.id}/book`, { round: 1, date: new Date(Date.now() + 3 * DAY + 330 * MIN).toISOString().slice(0, 10), time: '11:45', mode: 'Online', meetingLink: 'https://meet.google.com/abc', panel: [{ userId: U.rec2.id }], viaPopup: true });
    await L.post(U.rec, `/ats/interviews/${Z2.a.id}/tell/copied`, { kind: 'scheduled', channel: 'SMS' });
    const i3 = await run(Date.now() + 11 * MIN, [Z2.a.id]);
    check('I a person told her by hand (copied the words): the safety net stays quiet', i3.netBooked === 0 && (await cmsgs(Z2.c.id, 'Interview booked')).filter((m) => m.status === 'SENT').length === 0, i3);
    // consent withdrawn: the net tries, is blocked, says why
    const Z3 = await W.mkc('Zubin', 'CLIENT_SHORTLISTED');
    await L.post(U.admin, `/ats/interviews/${Z3.a.id}/book`, { round: 1, date: new Date(Date.now() + 3 * DAY + 330 * MIN).toISOString().slice(0, 10), time: '11:45', mode: 'Online', meetingLink: 'https://meet.google.com/abc', panel: [{ userId: U.rec2.id }], viaPopup: true });
    await P.candidate.update({ where: { id: Z3.c.id }, data: { consentStatus: 'WITHDRAWN' } });
    const i4 = await run(Date.now() + 11 * MIN, [Z3.a.id]);
    const nev = (await events(Z3.a.id, 'REMINDER_NET'))[0];
    check('I consent withdrawn: nothing is sent, the history says why', i4.netBooked === 1 && (await cmsgs(Z3.c.id)).filter((m) => m.status === 'SENT').length === 0 && nev && /could not go by itself/.test(nev.reason), nev && nev.reason);

    // ===== J. quiet hours: urgent ones are exempt ========================================================================================
    await L.put(U.sa, '/messaging/limits', {});
    await P.appSetting.upsert({ where: { key: 'omni-quiet' }, create: { key: 'omni-quiet', value: JSON.stringify({ enabled: true, from: '00:00', to: '23:59' }) }, update: { value: JSON.stringify({ enabled: true, from: '00:00', to: '23:59' }) } });
    const Q = await interview(W, 'Quin', ist('2026-10-15T11:00'));
    const j1 = await run(ist('2026-10-15T11:00').getTime() - 23 * HOUR - 50 * MIN, [Q.a.id]);
    check('J inside quiet hours: the 1-day reminder waits for the morning', j1.candidateDay === 0 && !(await kinds(Q.a.id)).includes('REMINDER_C_DAY'), j1);
    const j2 = await run(ist('2026-10-15T11:00').getTime() - 50 * MIN, [Q.a.id]);
    check('J inside quiet hours: the 1-hour reminder (urgent) still goes', j2.candidateHour === 1 && (await cmsgs(Q.c.id, 'Interview reminder (1 hour)')).length === 1, j2);
    const j3 = await run(ist('2026-10-15T11:00').getTime() - 12 * MIN, [Q.a.id]);
    check('J inside quiet hours: the 15-minute reminder still goes', j3.candidateNow === 1);
    await P.appSetting.deleteMany({ where: { key: 'omni-quiet' } });

    // ===== K. Sunday: an appointment is an appointment ===========================================================================================
    const S = await interview(W, 'Sunil', TSUN);
    const k1 = await run(TSUN.getTime() - 23 * HOUR - 50 * MIN, [S.a.id]);
    const k2b = await run(ist('2026-10-18T08:40'), [S.a.id]);
    check('K Sunday interview: the day reminder, the 08:30 list and the hour reminder all still go', k1.candidateDay === 1 && (await bells(U.tl.id, "Today's interviews")).some((b) => /Sunil/.test(b.message)) && k2b.digests >= 1, { k1, k2b });
    const k3 = await run(TSUN.getTime() - 50 * MIN, [S.a.id]);
    check('K ... and the hour reminder', k3.staffHour === 1 && k3.candidateHour === 1, k3);

    // ===== L. settings ==============================================================================================================================
    await setPlan({ candidate: { dayBefore: false }, parties: { bde: { digest: false, hourBefore: false }, tl: { sms: true } } });
    const M = await interview(W, 'Mira', ist('2026-10-19T11:00'));
    const l1 = await run(ist('2026-10-19T11:00').getTime() - 23 * HOUR - 50 * MIN, [M.a.id]);
    check('L plan: candidate day reminder switched off', l1.candidateDay === 0);
    await run(ist('2026-10-19T09:00'), [M.a.id]);
    check('L plan: BDE list switched off (TL still gets it)', (await bells(U.bde.id, 'Mira')).length === 0 && (await bells(U.tl.id, "Today's interviews")).some((b) => /Mira/.test(b.message)));
    const l2 = await run(ist('2026-10-19T11:00').getTime() - 50 * MIN, [M.a.id]);
    check('L plan: BDE hour bell off, recruiter + TL on', (await bells(U.bde.id, 'Interview in 1 hour')).filter((b) => /Mira/.test(b.message)).length === 0 && (await bells(U.rec.id, 'Interview in 1 hour')).filter((b) => /Mira/.test(b.message)).length === 1 && l2.staffHour === 1, l2);
    const jobs = await L.get(U.sa, '/messaging/bulk');
    const smsJob = (jobs.body || []).find((j) => j.audience === 'employees' && j.channels.includes('SMS') && (j.createdAt || '') > new Date(Date.now() - 600000).toISOString());
    check('L plan: TL SMS on + SMS connected + phone on file -> an SMS job to the TL (fake transport)', !!smsJob, (jobs.body || []).slice(0, 3));
    await setPlan({ candidate: { dayBefore: true }, parties: { bde: { digest: true, hourBefore: true }, tl: { sms: false } } });
    // candidate emails OFF: nothing to the candidate, the team still gets its bell
    SW.cand = false;
    const N = await interview(W, 'Nita', ist('2026-10-20T11:00'));
    const n1 = await run(ist('2026-10-20T11:00').getTime() - 50 * MIN, [N.a.id]);
    check('L "Candidate emails" OFF: candidate gets nothing, team bell still goes', n1.candidateHour === 0 && n1.staffHour === 1 && (await cmsgs(N.c.id)).length === 0 && (await bells(U.tl.id, 'Interview in 1 hour')).some((b) => /Nita/.test(b.message)), { n1, plan: (await PLAN.load()).parties, parties: await P.interviewEvent.findMany({ where: { applicationId: N.a.id } }) });
    SW.cand = true;
    // team reminders OFF
    SW.staffOff = true;
    const O = await interview(W, 'Omar', ist('2026-10-21T11:00'));
    const o1 = await run(ist('2026-10-21T11:00').getTime() - 50 * MIN, [O.a.id]);
    check('L team reminders OFF: candidate still reminded, team gets no bell', o1.candidateHour === 1 && o1.staffHour === 0 && (await bells(U.tl.id, 'Interview in 1 hour')).filter((b) => /Omar/.test(b.message)).length === 0, o1);
    SW.staffOff = false;
    // consent withdrawn: marker, but no message
    const Pc = await interview(W, 'Pari', ist('2026-10-22T11:00'));
    await P.candidate.update({ where: { id: Pc.c.id }, data: { consentStatus: 'WITHDRAWN' } });
    await run(ist('2026-10-22T11:00').getTime() - 50 * MIN, [Pc.a.id]);
    const pe = (await events(Pc.a.id, 'REMINDER_C_HOUR'))[0];
    check('L consent withdrawn: no message to the candidate, the history says why; the team is still told', (await cmsgs(Pc.c.id)).filter((m) => m.status === 'SENT').length === 0 && pe && /not sent/i.test(pe.reason) && (await bells(U.rec.id, 'Interview in 1 hour')).some((b) => /Pari/.test(b.message)), pe && pe.reason);
    // channel plan: SMS first then Email, strategy "all"
    await setPlan({ candidate: { channels: ['SMS', 'Email'], strategy: 'all' } });
    const Rr = await interview(W, 'Rita', ist('2026-10-23T11:00'));
    await run(ist('2026-10-23T11:00').getTime() - 50 * MIN, [Rr.a.id]);
    const rm = await cmsgs(Rr.c.id, 'Interview reminder (1 hour)');
    check('L channel plan "every one that works": SMS and Mail both go', rm.filter((m) => m.channel === 'SMS' && m.status === 'SENT').length === 1 && rm.filter((m) => m.channel === 'Email' && m.status === 'SENT').length === 1, rm.map((m) => `${m.channel}:${m.status}`));
    await setPlan({ candidate: { channels: ['WhatsApp', 'SMS', 'Email'], strategy: 'first' } });
    const Ss = await interview(W, 'Sia', ist('2026-10-24T11:00'));
    await run(ist('2026-10-24T11:00').getTime() - 50 * MIN, [Ss.a.id]);
    const sm = await cmsgs(Ss.c.id, 'Interview reminder (1 hour)');
    check('L channel plan "first that works": WhatsApp has no approved wording -> SMS goes, only one message', sm.length >= 1 && sm.filter((m) => m.status === 'SENT').length === 1 && sm.some((m) => m.channel === 'SMS' && m.status === 'SENT'), sm.map((m) => `${m.channel}:${m.status}`));
    // restart-proof: a brand new run with the same clock does nothing more
    const again = await run(ist('2026-10-24T11:00').getTime() - 50 * MIN, [Ss.a.id]);
    check('L a repeat run (like after a restart) sends nothing more', again.candidateHour === 0 && again.staffHour === 0, again);
  } catch (e) { console.log('ERR', e); } finally {
    try {
      await E.restore();
      for (const k of ['sw', 'st']) { /* restored below */ }
      await P.appSetting.deleteMany({ where: { key: { in: ['interview-reminder-plan', 'omni-quiet'] } } });
      if (saved.st) await P.appSetting.upsert({ where: { key: 'interview-staff-reminders' }, create: { key: saved.st.key, value: saved.st.value }, update: { value: saved.st.value } }).catch(() => {}); else await P.appSetting.deleteMany({ where: { key: 'interview-staff-reminders' } });
    } catch (e) { console.log('restore', e.message); }
    console.log('CLEAN', JSON.stringify(await cleanup()));
    console.log('RESULT', JSON.stringify(L.results()));
    await P.$disconnect();
  }
})();

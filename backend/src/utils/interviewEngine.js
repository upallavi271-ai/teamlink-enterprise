// ---------------------------------------------------------------------------
// INTERVIEW REMINDER ENGINE — what runs every few minutes for every scheduled interview (user,
// 2026-10-10: "recruiter ki, aa TL ki, aa BDE ki, candidate ki reminder message").
// Called by interviewNotices.runInterviewReminders(); settings in utils/interviewReminderPlan.js.
//
//   WHO / WHEN (defaults)                         key written once (survives restarts)
//   candidate   about 1 day before                InterviewEvent REMINDER_C_DAY    (toSlot = the slot)
//   candidate   1 hour before                     InterviewEvent REMINDER_C_HOUR
//   candidate   15 minutes before, ONLINE + link  InterviewEvent REMINDER_C_NOW
//   recruiter / TL / BDE / interviewer   08:30 "Today's interviews" list   Notification interview|digest|<user>|<day>
//   recruiter / TL / BDE / interviewer   1 hour before                      InterviewEvent REMINDER_HOUR
//   recruiter   30 minutes after the start, no status   "Did the candidate attend?"   REMINDER_NOSHOW
//   interviewer / recruiter / TL   2 hours after, no feedback   once a day (Notification key)
//   candidate   10 minutes after a booking / move / cancel nobody told them about    REMINDER_NET
//
// A reschedule changes the slot, so every key (they carry the slot) is new: the old reminders are
// dead and the new ones arm themselves. A cancelled / decided interview is not scheduled any more,
// so nothing is sent for it. Weekends and holidays do not matter: an interview is an appointment.
// Markers are written BEFORE sending, so two overlapping passes cannot both send.
//
// The candidate's messages go through the normal one-person send (utils/omniSend.js ->
// utils/bulkMessaging.js): consent withdrawn, STOP, the "Candidate emails" switch, the WhatsApp
// template rule, daily caps, test records — all enforced there, none repeated here.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const IM = require('./interviewMessageDefaults');
const PLAN = require('./interviewReminderPlan');
const TELL = require('./interviewTell');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const LIVE = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
// The safety net acts only on bookings made after this feature went live (never on older ones).
const NET_FROM = new Date('2026-10-10T11:50:00Z');
const ROLE_KEY = { Recruiter: 'recruiter', 'Team lead': 'tl', 'Client manager (BDE)': 'bde', Interviewer: 'interviewer' };

const lazy = {
  IN: () => require('./interviewNotices'), // eslint-disable-line global-require
  omni: () => require('./omniSend'), // eslint-disable-line global-require
  bulk: () => require('./bulkMessaging'), // eslint-disable-line global-require
  messaging: () => require('./messaging'), // eslint-disable-line global-require
};

const APP_INCLUDE = { candidate: true, requirement: { include: { client: true } } };
const istDay = (d) => new Date(new Date(d).getTime() + 330 * MIN).toISOString().slice(0, 10);
const istMinutes = (d) => { const x = new Date(new Date(d).getTime() + 330 * MIN); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const hmToMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

// ---- pure time math (tested on its own) ---------------------------------------------------------------
// leftMs: time until the interview starts. bookedAgoMs: how long ago it was booked / moved.
function candidateDue({ leftMs, bookedAgoMs, online, hasLink, plan }) {
  const c = plan.candidate;
  const out = [];
  if (leftMs > 0) {
    if (c.dayBefore && leftMs > 10 * HOUR && leftMs <= DAY && bookedAgoMs > 3 * HOUR) out.push('day');
    if (c.hourBefore && leftMs > 20 * MIN && leftMs <= HOUR && bookedAgoMs > 30 * MIN) out.push('hour');
    if (c.nowOnline && online && hasLink && leftMs <= 20 * MIN && bookedAgoMs > 10 * MIN) out.push('now');
  }
  return out;
}
const staffHourDue = ({ leftMs, bookedAgoMs }) => leftMs > 0 && leftMs <= HOUR && bookedAgoMs > 30 * MIN;
const noShowDue = ({ sinceStartMs, plan }) => plan.noShow.on && sinceStartMs >= plan.noShow.afterMinutes * MIN && sinceStartMs <= 6 * HOUR;
const digestDue = ({ now, plan }) => istMinutes(now) >= hmToMin(plan.digestAt);

// ---- who sends the automatic messages ---------------------------------------------------------------------
// The job's recruiter (so the mail comes "from" them and replies reach them), else the TL, else an active
// Super Admin. The ID is real (audit, sender identity); the ROLE is lifted so that the system's own
// reminder is not stopped by that person's personal Contact switch: it is a company message.
async function systemIdentityFor(app) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const r = app.requirement || {};
  const sandbox = require('./sandbox').isSandbox(); // eslint-disable-line global-require
  const ids = [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim()), r.tlId].filter(Boolean);
  const admins = await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, select: { id: true, name: true, email: true }, take: 5 }).catch(() => []);
  admins.filter((u) => sandbox || !/zztest|example\.test/i.test(`${u.name} ${u.email}`)).forEach((u) => ids.push(u.id));
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const idn = await resolveIdentity(id).catch(() => null);
    if (idn && (!idn.status || idn.status === 'Active')) return { ...idn, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', caps: { ...(idn.caps || {}), candidateContact: true, contact: true } };
  }
  return null;
}

async function remindedFor(appId, status, slotIso) {
  const ev = await prisma.interviewEvent.findFirst({ where: { applicationId: appId, status, toSlot: slotIso }, select: { id: true } });
  return !!ev;
}
async function mark(appId, status, slotIso, reason) {
  return prisma.interviewEvent.create({ data: { applicationId: appId, status, toSlot: slotIso, by: 'System', reason } });
}

// ---- the candidate ---------------------------------------------------------------------------------------------
async function sendToCandidate(app, purposeKey, cp) {
  const sys = await systemIdentityFor(app);
  const sent = [];
  const reasons = [];
  if (!sys) return { sent, reasons: ['No sender could be found for this requirement.'] };
  for (const ch of cp.channels) {
    // eslint-disable-next-line no-await-in-loop
    const out = await lazy.omni().send(sys, {
      audience: 'candidates', id: app.candidateId, channel: ch, applicationId: app.id, purposeKey, purpose: IM.LABEL_OF[purposeKey], urgent: true,
    }).catch((e) => ({ ok: false, error: e.message }));
    if (out && out.ok) { sent.push(ch); if (cp.strategy === 'first') break; } else reasons.push(`${ch}: ${String((out && out.error) || 'not sent').replace(/\.$/, '')}`);
  }
  return { sent, reasons };
}

// ---- the staff -------------------------------------------------------------------------------------------------------
const flagOf = (plan, roles, flag) => roles.some((r) => plan.parties[ROLE_KEY[r]] && plan.parties[ROLE_KEY[r]][flag]);

// WhatsApp / SMS to a staff member (own words). The normal one-person send decides if it can go.
async function sendStaffText(app, party, channel, text, sysArg) {
  try {
    if (!party.userId) return { ok: false, reason: 'No login for this person.' };
    const status = await lazy.messaging().channelStatus().catch(() => ({}));
    if (!(status[channel] && status[channel].configured)) return { ok: false, reason: `${channel} is not connected.` };
    const emp = await prisma.employee.findUnique({ where: { userId: party.userId }, select: { id: true, phone: true } }).catch(() => null);
    if (!emp || !emp.phone) return { ok: false, reason: 'No phone number on file.' };
    const sys = sysArg || await systemIdentityFor(app);
    if (!sys) return { ok: false, reason: 'No sender.' };
    const out = await lazy.bulk().sendIndividual(sys, {
      audience: 'employees', id: emp.id, channel, purpose: 'Interview reminder', urgent: true, perChannel: { [channel]: { body: text } },
    });
    if (out.error) return { ok: false, reason: out.error };
    const row = out.result;
    return row && row.status === 'sent' ? { ok: true } : { ok: false, reason: (row && row.reason) || 'Not sent.' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// bell + mail (+ WhatsApp / SMS) to a list of parties, per their flags. -> { told, mails, texts }
async function tellStaff(app, parties, { title, text, mailText, key, flag, plan, emailsOn, sys }) {
  const IN = lazy.IN();
  const out = { told: 0, mails: 0, texts: 0 };
  for (const p of parties) {
    if (!flagOf(plan, p.roles, flag)) continue; // eslint-disable-line no-continue
    const fl = (f) => flagOf(plan, p.roles, f);
    if (p.userId && fl('bell')) {
      // one bell per person per key
      // eslint-disable-next-line no-await-in-loop
      const had = await prisma.notification.findFirst({ where: { userId: p.userId, recipient: `${key}|${p.userId}` }, select: { id: true } });
      if (!had) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.create({ data: { userId: p.userId, title, message: text, channel: 'In-App', recipient: `${key}|${p.userId}`, status: 'Sent' } });
        out.told += 1;
        if (p.email && fl('email') && emailsOn) {
          // eslint-disable-next-line no-await-in-loop
          const r = await IN.mailTo(p.email, title.replace(/^[^\w]+\s*/, ''), mailText || text);
          if (r && r.ok) out.mails += 1;
        }
        // eslint-disable-next-line no-await-in-loop
        if (fl('whatsapp') && (await sendStaffText(app, p, 'WhatsApp', text, sys)).ok) out.texts += 1;
        // eslint-disable-next-line no-await-in-loop
        if (fl('sms') && (await sendStaffText(app, p, 'SMS', text, sys)).ok) out.texts += 1;
      }
    } else if (!p.userId && p.email && emailsOn) {
      // an outside interviewer: mail only
      // eslint-disable-next-line no-await-in-loop
      const r = await IN.mailTo(p.email, title.replace(/^[^\w]+\s*/, ''), mailText || text);
      if (r && r.ok) out.mails += 1;
    }
  }
  return out;
}

// ---- THE RUN ----------------------------------------------------------------------------------------------------------
// ctx: { now, force, dryRun, onlyIds, summary, candOn, staffOn, staffSt }
async function run(ctx) {
  const {
    now, force, dryRun, onlyIds, summary, candOn, staffOn, staffSt,
  } = ctx;
  const IN = lazy.IN();
  const plan = await PLAN.load();
  const t = now.getTime();
  const idFilter = onlyIds ? { id: { in: onlyIds } } : {};
  // INERT UNTIL ARMED: without the plan's "automatic sending" switch (or an Admin pressing "Run now") nothing leaves the app:
  // no candidate message, no safety net, no mail / WhatsApp / SMS to the team. The in-app bell still goes.
  const armed = plan.armed === true || force === true;
  const emailsOn = candOn && armed; // the one company switch for interview emails, and the arming switch
  const outside = armed ? plan : { ...plan, parties: Object.fromEntries(Object.entries(plan.parties).map(([k, v]) => [k, { ...v, email: false, whatsapp: false, sms: false }])) };
  const skipP = (s) => IN.skipPerson(s);
  Object.assign(summary, { candidateDay: 0, candidateHour: 0, candidateNow: 0, staffHour: 0, digests: 0, noShow: 0, netBooked: 0, plan: undefined });

  // the next 24 hours' interviews, with how long ago each was booked / moved
  const soon = await prisma.application.findMany({
    where: { ...idFilter, interviewStatus: { in: LIVE }, interviewAt: { gt: now, lte: new Date(t + DAY) }, stage: { notIn: DECIDED } },
    include: APP_INCLUDE,
  });
  const evs = soon.length ? await prisma.interviewEvent.findMany({ where: { applicationId: { in: soon.map((a) => a.id) }, status: { in: ['SCHEDULED', 'RESCHEDULED'] } }, orderBy: { createdAt: 'desc' }, select: { applicationId: true, createdAt: true } }) : [];
  const bookedAt = new Map();
  evs.forEach((e) => { if (!bookedAt.has(e.applicationId)) bookedAt.set(e.applicationId, e.createdAt.getTime()); });

  const quietNow = plan.quiet ? await require('./omniRules').settings().then((s) => require('./omniRules').inQuiet(s, now)).catch(() => false) : false; // eslint-disable-line global-require

  for (const a of soon) {
    if (skipP(a.candidate && a.candidate.name)) continue; // eslint-disable-line no-continue
    const slot = a.interviewAt.toISOString();
    const left = a.interviewAt.getTime() - t;
    const booked = t - (bookedAt.get(a.id) || t - 365 * DAY);
    const online = !String(a.interviewMode || '').toLowerCase().includes('person') && !/tele|phone/i.test(String(a.interviewMode || ''));
    // --- the candidate
    if ((candOn && armed) || force) {
      const kinds = candidateDue({ leftMs: left, bookedAgoMs: booked, online, hasLink: !!a.interviewMeetingLink, plan });
      for (const k of kinds) {
        if (k === 'day' && quietNow && !force) continue; // eslint-disable-line no-continue
        const status = { day: 'REMINDER_C_DAY', hour: 'REMINDER_C_HOUR', now: 'REMINDER_C_NOW' }[k];
        // eslint-disable-next-line no-await-in-loop
        if (await remindedFor(a.id, status, slot)) continue; // eslint-disable-line no-continue
        summary.items.push({ applicationId: a.id, kind: status, slot });
        summary[{ day: 'candidateDay', hour: 'candidateHour', now: 'candidateNow' }[k]] += 1;
        if (dryRun) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const ev = await mark(a.id, status, slot, 'Reminder to the candidate');
        // eslint-disable-next-line no-await-in-loop
        const r = await sendToCandidate(a, IM.PURPOSE_OF[`reminder_${k === 'now' ? 'now' : k}`], plan.candidate);
        const txt = r.sent.length ? `Reminder sent to the candidate by ${r.sent.join(' and ')}` : `Reminder to the candidate was not sent: ${r.reasons.join('; ')}`;
        // eslint-disable-next-line no-await-in-loop
        await prisma.interviewEvent.update({ where: { id: ev.id }, data: { reason: txt.slice(0, 480) } }).catch(() => {});
      }
    }
    // --- recruiter / TL / BDE / interviewer: 1 hour before
    if ((staffOn || force) && staffHourDue({ leftMs: left, bookedAgoMs: booked }) && staffSt.hourBefore !== false) {
      // eslint-disable-next-line no-await-in-loop
      if (await remindedFor(a.id, 'REMINDER_HOUR', slot)) continue; // eslint-disable-line no-continue
      summary.items.push({ applicationId: a.id, kind: 'REMINDER_HOUR', slot });
      summary.staffHour += 1;
      if (dryRun) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await mark(a.id, 'REMINDER_HOUR', slot, 'Reminder sent to the team: 1 hour before');
      // eslint-disable-next-line no-await-in-loop
      const parties = await TELL.partiesOf(a);
      const missingLink = online && !a.interviewMeetingLink;
      const lines = IN.staffLines(a, 'reminder_hour');
      if (missingLink) lines.push('⚠ No meeting link yet - add it now (Interview Calendar → Create meeting link).');
      // eslint-disable-next-line no-await-in-loop
      const sys = await systemIdentityFor(a);
      // eslint-disable-next-line no-await-in-loop
      await tellStaff(a, parties, {
        title: `⏰ Interview in 1 hour: ${a.candidate ? a.candidate.name : 'Candidate'}`, text: lines.join(' · '),
        mailText: ['Hello,', '', ...lines, '', 'Open TeamLink → Interviews for the details.', '', '— TeamLink'].join('\n'),
        key: `interview|hour|${a.id}|${slot}`, flag: 'hourBefore', plan: outside, emailsOn, sys,
      });
    }
  }

  // --- the morning list --------------------------------------------------------------------------------------------------
  if ((staffOn || force) && digestDue({ now, plan })) {
    const dayStart = new Date(`${istDay(now)}T00:00:00+05:30`);
    const todays = await prisma.application.findMany({
      where: { ...idFilter, interviewStatus: { in: LIVE }, interviewAt: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY) }, stage: { notIn: DECIDED } },
      include: APP_INCLUDE, orderBy: { interviewAt: 'asc' },
    });
    const live = todays.filter((a) => a.interviewAt.getTime() >= t - 30 * MIN && !skipP(a.candidate && a.candidate.name));
    const perUser = new Map(); // key -> { party, apps: [] }
    const partyLists = new Map();
    for (const a of live) {
      // eslint-disable-next-line no-await-in-loop
      const ps = await TELL.partiesOf(a);
      partyLists.set(a.id, ps);
      ps.forEach((p) => {
        if (!flagOf(plan, p.roles, 'digest') || staffSt.dayBefore === false) return;
        const e = perUser.get(p.key) || { party: p, apps: [] };
        e.apps.push(a);
        perUser.set(p.key, e);
      });
    }
    for (const { party, apps } of perUser.values()) {
      const key = `interview|digest|${party.key}|${istDay(now)}`;
      // eslint-disable-next-line no-await-in-loop
      if (party.userId && (await prisma.notification.findFirst({ where: { recipient: key }, select: { id: true } }))) continue; // eslint-disable-line no-continue
      summary.items.push({ kind: 'DIGEST', to: party.name, count: apps.length });
      summary.digests += 1;
      if (dryRun) continue; // eslint-disable-line no-continue
      const row = (a) => {
        const r = a.requirement || {};
        const when = new Date(a.interviewAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
        const panel = a.interviewer ? ` · With ${a.interviewer}` : '';
        // BDE and everyone else: the name, never the candidate's phone or email
        return `${when} · ${a.candidate ? a.candidate.name : 'Candidate'} · Round ${a.interviewRound || 1} · ${r.title || 'Requirement'} (${r.internal ? 'TeamLink' : (r.client && r.client.name) || ''}) · ${IN.whereLine(a)}${panel}`;
      };
      const title = `📅 Today's interviews: ${apps.length}`;
      const text = apps.map(row).join('\n');
      // eslint-disable-next-line no-await-in-loop
      const sys = await systemIdentityFor(apps[0]);
      if (party.userId) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.create({ data: { userId: party.userId, title, message: text, channel: 'In-App', recipient: key, status: 'Sent' } });
        const fl = (f) => flagOf(outside, party.roles, f);
        // eslint-disable-next-line no-await-in-loop
        if (party.email && fl('email') && emailsOn) await IN.mailTo(party.email, title.replace(/^[^\w]+\s*/, ''), ['Hello,', '', 'Your interviews today:', '', ...apps.map((a) => `• ${row(a)}`), '', 'Open TeamLink → Interviews for the details.', '', '— TeamLink'].join('\n'));
        // eslint-disable-next-line no-await-in-loop
        if (fl('whatsapp')) await sendStaffText(apps[0], party, 'WhatsApp', `${title}\n${text}`, sys);
        // eslint-disable-next-line no-await-in-loop
        if (fl('sms')) await sendStaffText(apps[0], party, 'SMS', `${title}\n${text}`, sys);
      }
    }
  }

  // --- "Did the candidate attend?" -------------------------------------------------------------------------------------
  if ((staffOn || force) && plan.noShow.on) {
    const late = await prisma.application.findMany({
      where: { ...idFilter, interviewStatus: { in: LIVE }, interviewAt: { lte: new Date(t - plan.noShow.afterMinutes * MIN), gte: new Date(t - 6 * HOUR) }, stage: { notIn: DECIDED } },
      include: APP_INCLUDE,
    });
    for (const a of late) {
      if (skipP(a.candidate && a.candidate.name)) continue; // eslint-disable-line no-continue
      const slot = a.interviewAt.toISOString();
      if (!noShowDue({ sinceStartMs: t - a.interviewAt.getTime(), plan })) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (await remindedFor(a.id, 'REMINDER_NOSHOW', slot)) continue; // eslint-disable-line no-continue
      summary.items.push({ applicationId: a.id, kind: 'REMINDER_NOSHOW', slot });
      summary.noShow += 1;
      if (dryRun) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await mark(a.id, 'REMINDER_NOSHOW', slot, 'Asked the recruiter: did the candidate attend?');
      // eslint-disable-next-line no-await-in-loop
      const all = await TELL.partiesOf(a);
      const rec = all.filter((p) => p.roles.includes('Recruiter'));
      const to = rec.length ? rec : all.filter((p) => p.roles.includes('Team lead'));
      const name = a.candidate ? a.candidate.name : 'Candidate';
      const text = `${name}'s interview (${IN.when(a.interviewAt)}) is still marked "${a.interviewStatus === 'RESCHEDULED' ? 'Rescheduled' : 'Scheduled'}". Open Interview Calendar: press Started / Completed, or "Did not attend" (with the reason).`;
      // eslint-disable-next-line no-await-in-loop
      await tellStaff(a, to.map((p) => ({ ...p, roles: ['Recruiter'] })), {
        title: `❓ Did ${name} attend?`, text, key: `interview|noshow|${a.id}|${slot}`, flag: 'bell', plan: { ...outside, parties: { ...outside.parties, recruiter: { ...outside.parties.recruiter, bell: true } } }, emailsOn, sys: null,
      });
    }
  }

  // --- the booked / moved / cancelled message nobody sent -------------------------------------------------------------------
  if (((candOn && armed) || force) && plan.candidate.safetyNetMinutes > 0) {
    const cutoff = new Date(t - plan.candidate.safetyNetMinutes * MIN);
    const recent = await prisma.interviewEvent.findMany({
      where: { ...(onlyIds ? { applicationId: { in: onlyIds } } : {}), status: { in: ['SCHEDULED', 'RESCHEDULED', 'CANCELLED'] }, createdAt: { lte: cutoff, gte: new Date(Math.max(t - DAY, NET_FROM.getTime())) } },
      orderBy: { createdAt: 'desc' },
    });
    const seenApp = new Set();
    for (const ev of recent) {
      if (seenApp.has(ev.applicationId)) continue; // eslint-disable-line no-continue
      seenApp.add(ev.applicationId); // only the LATEST event of an interview matters
      // eslint-disable-next-line no-await-in-loop
      const a = await prisma.application.findUnique({ where: { id: ev.applicationId }, include: APP_INCLUDE });
      if (!a || !a.candidate || skipP(a.candidate.name)) continue; // eslint-disable-line no-continue
      const kind = ev.status === 'CANCELLED' ? 'cancelled' : (ev.status === 'RESCHEDULED' ? 'rescheduled' : 'scheduled');
      // still true? (a cancelled interview that was re-booked is not "cancelled" any more)
      if (kind === 'cancelled' ? a.interviewStatus !== 'CANCELLED' : !LIVE.includes(a.interviewStatus)) continue; // eslint-disable-line no-continue
      if (kind !== 'cancelled' && (!a.interviewAt || a.interviewAt.getTime() < t)) continue; // eslint-disable-line no-continue
      const tag = `${kind}:${ev.createdAt.toISOString()}`;
      // eslint-disable-next-line no-await-in-loop
      if (await remindedFor(a.id, 'REMINDER_NET', tag)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const told = await TELL.toldSummary(a, kind);
      // eslint-disable-next-line no-await-in-loop
      if (told.told || await stageMessagePending(a.id)) continue; // eslint-disable-line no-continue
      // the Admin switched this automatic message off: nothing goes by itself
      // eslint-disable-next-line no-await-in-loop
      if (kind === 'scheduled' && (await stageRuleOff())) continue; // eslint-disable-line no-continue
      summary.items.push({ applicationId: a.id, kind: 'REMINDER_NET', event: kind });
      summary.netBooked += 1;
      if (dryRun) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const mk = await mark(a.id, 'REMINDER_NET', tag, `Nobody told the candidate within ${plan.candidate.safetyNetMinutes} minutes, so the ${kind === 'cancelled' ? 'cancellation' : 'interview'} message went by itself`);
      // eslint-disable-next-line no-await-in-loop
      const r = await sendToCandidate(a, IM.PURPOSE_OF[kind], { ...plan.candidate, strategy: 'first' });
      if (!r.sent.length) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.interviewEvent.update({ where: { id: mk.id }, data: { reason: `The ${kind === 'cancelled' ? 'cancellation' : 'interview'} message could not go by itself: ${r.reasons.join('; ')}`.slice(0, 480) } }).catch(() => {});
      }
    }
  }
}

// "Interview scheduled" is switched off in Automatic messages: respect it.
async function stageRuleOff() {
  try {
    const R = require('./autoMessageRules'); // eslint-disable-line global-require
    const s = await R.loadSettings();
    if (!R.started(s)) return false;
    return !R.effectiveRule('INTERVIEW_SCHEDULED', s).on;
  } catch { return false; }
}
// A step message for this interview is still waiting (delayed / needs an OK): do not double it.
async function stageMessagePending(applicationId) {
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT id FROM "ScheduledMessage" WHERE applicationId = ? AND stageTo = 'INTERVIEW_SCHEDULED' AND status IN ('SCHEDULED','WAITING_APPROVAL','SENDING') LIMIT 1`, applicationId);
    return rows.length > 0;
  } catch { return false; }
}

// Settle the automatic "Interview scheduled" step message once a human told the candidate.
async function settleStageMessage(applicationId, who) {
  try {
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "ScheduledMessage" SET status = 'CANCELLED', statusReason = ?, updatedAt = ? WHERE applicationId = ? AND stageTo = 'INTERVIEW_SCHEDULED' AND status IN ('SCHEDULED','WAITING_APPROVAL')`,
      `Sent by hand from the booking window${who ? ` (${who})` : ''}, so the automatic message was not needed.`, Date.now(), applicationId,
    );
    return Number(n) || 0;
  } catch { return 0; }
}

module.exports = {
  run, candidateDue, staffHourDue, noShowDue, digestDue, systemIdentityFor, sendToCandidate, sendStaffText, settleStageMessage, stageMessagePending, tellStaff, istDay, ROLE_KEY,
};

// ---------------------------------------------------------------------------
// INTERVIEW NOTICES & REMINDERS (change list §11 / §12, 2026-10-03).
//
// "Scheduling should feel like booking a cab: pick a time, everyone gets told."
//
//   announceInterview(appId, event)   one notice to everybody on the interview:
//       the candidate      in-app (their portal login, when they have one) +
//                          email through the candidate message queue
//                          (CandidateMessage → utils/mailWorker.js)
//       the recruiter(s), the job's TL and the client manager (BDE)
//                          in-app + email (utils/mailer.js sendMail)
//       the client         in-app for the company's portal logins + email to
//                          the client's contact person
//     events: scheduled · rescheduled · cancelled · no_show ·
//             reminder_day · reminder_hour
//
//   runInterviewReminders({ now })   one pass of the reminder job:
//       * the day before (within 24 hours of the slot, more than 2 hours away)
//       * one hour before
//       * feedback missing (2 hours after the slot, once a day, last 14 days)
//       * guarantee period ends within 7 days (client placements, once)
//     Each reminder is written ONCE: a slot reminder leaves an InterviewEvent
//     (REMINDER_DAY / REMINDER_HOUR, toSlot = the slot) so a reschedule arms
//     it again; the other two use Notification.recipient as the key.
//
//   startSweep()   every 15 minutes on the REAL server only. The test sandbox
//                  starts no timers (index.js returns before the sweeps), and
//                  even here the pass does nothing until an Admin turns the
//                  switch on (AppSetting "interview-reminders", OFF by default).
//                  Tests call runInterviewReminders({ force: true }) directly.
//
// Test logins (ZZTEST / example.test) are never told anything on the real
// server (agent rule 35). Email to reserved test domains is refused by the
// mailer itself, and the sandbox mail transport is fake.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const sandbox = require('./sandbox');

const SETTINGS_KEY = 'interview-reminders';
const DEFAULTS = { enabled: false, lastRunAt: null, lastRun: null };
const LIVE = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
const HOUR = 3600000;
const DAY = 24 * HOUR;
const isTest = (s) => /zztest|example\.test/i.test(String(s || ''));
// Test people are skipped on the real server; in the sandbox they ARE the
// people under test.
const skipPerson = (s) => !sandbox.isSandbox() && isTest(s);

// --- settings -----------------------------------------------------------------
async function loadSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    enabled: v.enabled === true,
    lastRunAt: typeof v.lastRunAt === 'string' ? v.lastRunAt : null,
    lastRun: v.lastRun && typeof v.lastRun === 'object' ? v.lastRun : null,
    updatedByName: row ? row.updatedByName : null,
    updatedAt: row ? row.updatedAt : null,
  };
}
async function saveSettings(patch, user) {
  const cur = await loadSettings();
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled === true,
    lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : cur.lastRunAt,
    lastRun: patch.lastRun !== undefined ? patch.lastRun : cur.lastRun,
  };
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  return loadSettings();
}

// --- STAFF REMINDERS (B4, 2026-10-06) ------------------------------------------
// In-app bell reminders for the people running the interview — the panel's
// staff logins, the recruiter(s), the TL and the client manager (BDE): the day
// before and 1 hour before. ON by default and SEPARATE from the "Candidate
// emails" switch below: with that switch off the candidate, the client and every
// outside person get nothing, and no email goes to anyone.
const STAFF_SETTINGS_KEY = 'interview-staff-reminders';
async function loadStaffSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: STAFF_SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    enabled: v.enabled !== false,
    dayBefore: v.dayBefore !== false,
    hourBefore: v.hourBefore !== false,
    updatedByName: row ? row.updatedByName : null,
  };
}
async function saveStaffSettings(patch, user) {
  const cur = await loadStaffSettings();
  const next = {};
  ['enabled', 'dayBefore', 'hourBefore'].forEach((k) => { next[k] = typeof patch[k] === 'boolean' ? patch[k] : cur[k]; });
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: STAFF_SETTINGS_KEY },
    create: { key: STAFF_SETTINGS_KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  return loadStaffSettings();
}

// --- THE ONE "CANDIDATE EMAILS" SWITCH (e2e gap 4, user-approved 2026-10-03) ---
// The same AppSetting row ("interview-reminders"). It now decides EVERY
// automatic message to a candidate: the pipeline messages (Rejected, Selected,
// Hold, Offer, Joined … utils/candidateComms.js), the interview messages
// (booked / moved / cancelled / reminders) and the offer letter. OFF by
// default; an Admin turns it on (Interview Calendar → Admin line, or
// Administration → Company Setup → Step timing). While it is off the message is
// still RECORDED — status NOT_SENT_SWITCHED_OFF, so it shows on the candidate's
// Communications — but nothing is queued or transmitted. Staff in-app notices
// are not affected.
const SWITCHED_OFF = 'NOT_SENT_SWITCHED_OFF';
const SWITCHED_OFF_DETAIL = 'Not sent — candidate emails are switched off';
async function candidateEmailsOn() {
  try { return (await loadSettings()).enabled === true; } catch { return false; }
}

// --- words --------------------------------------------------------------------
function when(d) {
  if (!d) return 'a time we will confirm';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}
function whereLine(app) {
  const mode = String(app.interviewMode || '').toLowerCase();
  if (mode.includes('person')) return `In person${app.interviewLocation ? ` at ${app.interviewLocation}` : ''}`;
  if (mode.includes('tele') || mode.includes('phone')) return 'By phone';
  return `Online${app.interviewMeetingLink ? ` — join here: ${app.interviewMeetingLink}` : ''}`;
}
const TITLES = {
  scheduled: (c) => `📅 Interview booked: ${c}`,
  rescheduled: (c) => `📅 Interview moved: ${c}`,
  cancelled: (c) => `Interview cancelled: ${c}`,
  no_show: (c) => `Did not attend: ${c}`,
  reminder_day: (c) => `⏰ Interview tomorrow: ${c}`,
  reminder_hour: (c) => `⏰ Interview in 1 hour: ${c}`,
};
const CANDIDATE_TITLES = {
  scheduled: (job) => `Your interview for ${job} is booked`,
  rescheduled: (job) => `Your interview for ${job} has a new time`,
  cancelled: (job) => `Your interview for ${job} is cancelled`,
  no_show: (job) => `We missed you at the ${job} interview`,
  reminder_day: (job) => `Reminder: your ${job} interview is tomorrow`,
  reminder_hour: (job) => `Reminder: your ${job} interview starts in 1 hour`,
};

function lines(app, event, extra = {}) {
  const r = app.requirement || {};
  const client = r.internal ? 'TeamLink' : (r.client && r.client.name) || '—';
  const out = [
    `Candidate: ${app.candidate ? app.candidate.name : '—'}`,
    `Job: ${r.title || '—'} (${client})`,
    `When: ${when(app.interviewAt)}`,
    `Where: ${whereLine(app)}`,
    `Interviewer: ${app.interviewer || 'to be confirmed'}`,
  ];
  if (event === 'rescheduled' && extra.fromSlot) out.splice(2, 0, `Old time: ${when(extra.fromSlot)}`);
  if (extra.reason) out.push(`Reason: ${extra.reason}`);
  return out;
}

// --- who is on this interview ---------------------------------------------------
const APP_INCLUDE = { candidate: true, requirement: { include: { client: true } } };

async function peopleOf(app) {
  const r = app.requirement || {};
  const staffIds = [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim()), r.tlId, r.bdeId].filter(Boolean);
  const staff = staffIds.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(staffIds)] }, status: 'Active' }, select: { id: true, name: true, email: true } })
    : [];
  const clientUsers = !r.internal && r.clientId
    ? await prisma.user.findMany({ where: { clientId: r.clientId, status: 'Active' }, select: { id: true, name: true, email: true } })
    : [];
  const candidateUsers = app.candidateId
    ? await prisma.user.findMany({ where: { candidateId: app.candidateId, status: 'Active' }, select: { id: true, name: true, email: true } })
    : [];
  const ok = (u) => !skipPerson(`${u.name} ${u.email}`);
  // B4: the panel's staff logins are told like the recruiter / TL; outside
  // panelists only by email, and only while emails are switched on.
  // eslint-disable-next-line global-require
  const PANEL = require('./interviewPanel');
  const panelUsers = await PANEL.panelStaff(app.id, app.interviewRound || 1).catch(() => []);
  const panelOutside = await PANEL.panelExternal(app.id, app.interviewRound || 1).catch(() => []);
  const known = new Set(staff.map((u) => u.id));
  panelUsers.forEach((u) => { if (!known.has(u.id)) { known.add(u.id); staff.push(u); } });
  return {
    panelOutside: panelOutside.filter((x) => !skipPerson(`${x.name} ${x.email}`)),
    staff: staff.filter(ok),
    clientUsers: clientUsers.filter(ok),
    candidateUsers: candidateUsers.filter(ok),
    clientContact: !r.internal && r.client && r.client.contactEmail && !skipPerson(`${r.client.name} ${r.client.contactEmail}`)
      ? { name: r.client.contactName || r.client.name, email: r.client.contactEmail }
      : null,
  };
}

async function mailTo(to, subject, text) {
  if (!to) return { ok: false, error: 'no address' };
  try {
    // eslint-disable-next-line global-require
    return await require('./mailer').sendMail({ to, subject, text, useEmployeeFrom: false, fromName: 'TeamLink Interviews' });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The candidate's email goes through the same queue as every other candidate
// message, so it shows on Candidate 360 → Communications with its real status.
async function queueCandidateEmail(app, { template, label, subject, body, actor }) {
  const cand = app.candidate;
  if (!cand || skipPerson(`${cand.name} ${cand.email}`)) return null;
  // eslint-disable-next-line global-require
  const { emailConfig } = require('./mailer');
  // The one "Candidate emails" switch: off → recorded, never queued.
  const switchedOn = await candidateEmailsOn();
  let live = false;
  if (switchedOn) {
    try { live = !!cand.email && (await emailConfig()).configured; } catch { live = false; }
  }
  const row = await prisma.candidateMessage.create({
    data: {
      candidateId: cand.id,
      applicationId: app.id,
      channel: 'Email',
      template,
      templateLabel: label,
      trigger: `Interview: ${label}`,
      recipient: cand.email || '',
      subject,
      body,
      status: !switchedOn ? SWITCHED_OFF : (live ? 'QUEUED' : 'NOT_SENT_NO_PROVIDER'),
      statusDetail: !switchedOn ? `${SWITCHED_OFF_DETAIL}.`
        : (live ? 'Queued for sending.' : (cand.email ? 'Recorded, not transmitted — no email provider is configured.' : 'No email address on this candidate.')),
      senderUserId: actor ? actor.id : null,
      senderName: actor ? actor.name : 'TeamLink',
    },
  });
  if (live) {
    // eslint-disable-next-line global-require
    try { require('./mailWorker').kick(); } catch { /* the worker picks it up on its next tick */ }
  }
  return row;
}

// One notice to everybody on the interview. Never throws: a notice that could
// not be written must never undo the booking that already happened.
// opts: { actor, fromSlot, reason, candidateEmail (default true), key }
async function announceInterview(applicationId, event, opts = {}) {
  const out = { inApp: 0, emails: 0, candidateEmail: false, people: [] };
  try {
    const app = await prisma.application.findUnique({ where: { id: applicationId }, include: APP_INCLUDE });
    if (!app || !TITLES[event]) return out;
    const cName = app.candidate ? app.candidate.name : 'Candidate';
    const job = (app.requirement && app.requirement.title) || 'the job';
    const p = await peopleOf(app);
    const detail = lines(app, event, opts);
    const title = TITLES[event](cName);
    const message = detail.join(' · ');
    const actorId = opts.actor ? opts.actor.id : null;
    const recipientKey = opts.key || `interview|${event}|${app.id}`;

    // Staff + client logins: in-app (the person who did it is not told about
    // their own action, except by the reminder job, which has no actor).
    // staffOnly (B4): a staff reminder while candidate emails are off — the
    // client, the candidate and outside people get nothing, nobody is emailed.
    const staffOnly = opts.staffOnly === true;
    const inAppUsers = [...p.staff, ...(staffOnly ? [] : p.clientUsers)].filter((u) => u.id !== actorId);
    const seen = new Set();
    for (const u of inAppUsers) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message, channel: 'In-App', recipient: recipientKey, status: 'Sent' } });
      out.inApp += 1;
      out.people.push(u.name);
    }
    // The candidate's own login, in-app, in their words.
    for (const u of (staffOnly ? [] : p.candidateUsers)) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({
        data: { userId: u.id, title: CANDIDATE_TITLES[event](job), message: detail.slice(1).join(' · '), channel: 'In-App', recipient: recipientKey, status: 'Sent' },
      });
      out.inApp += 1;
    }

    // EMAIL ONLY WHEN THE ADMIN SWITCH IS ON (main, 2026-10-03): the local app
    // has real SMTP, so booking / rescheduling / cancelling must not email
    // clients and staff until the user approves. One switch for all interview
    // emails (Interviews → Admin line). In-app notices always go.
    const emailOn = !staffOnly && (await loadSettings()).enabled;
    out.emailsOff = !emailOn;
    // Email — staff and client contact. Sent in the background of this call;
    // the mailer refuses when no provider is configured (and is fake in the
    // sandbox), which is recorded nowhere else because it is not the record.
    const subject = `${title.replace(/^[^\w]+\s*/, '')} — ${when(app.interviewAt)}`;
    const text = ['Hello,', '', ...detail, '', 'Open TeamLink → Interviews for the details.', '', '— TeamLink'].join('\n');
    const mails = new Map();
    p.staff.filter((u) => u.id !== actorId && u.email).forEach((u) => mails.set(u.email.toLowerCase(), u.email));
    p.clientUsers.filter((u) => u.id !== actorId && u.email).forEach((u) => mails.set(u.email.toLowerCase(), u.email));
    if (p.clientContact) mails.set(p.clientContact.email.toLowerCase(), p.clientContact.email);
    (p.panelOutside || []).forEach((x) => mails.set(String(x.email).toLowerCase(), x.email));
    for (const to of (emailOn ? mails.values() : [])) {
      // eslint-disable-next-line no-await-in-loop
      const r = await mailTo(to, subject, text);
      if (r && r.ok) out.emails += 1;
    }

    // The candidate's message is always RECORDED (Communications); with the
    // switch off queueCandidateEmail writes it as "Not sent — switched off".
    if (opts.candidateEmail !== false && !staffOnly) {
      const cSubject = CANDIDATE_TITLES[event](job);
      const cBody = [`Hi ${cName},`, '', ...detail.slice(1), '',
        event === 'cancelled' ? 'Your recruiter will call you about a new time.' : 'If you cannot make it, please tell your recruiter as soon as you can.',
        '', '— TeamLink'].join('\n');
      const row = await queueCandidateEmail(app, {
        template: `INTERVIEW_${event.toUpperCase()}`, label: cSubject, subject: cSubject, body: cBody, actor: opts.actor,
      });
      out.candidateEmail = !!row && row.status !== SWITCHED_OFF;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[interviewNotices] could not announce:', err.message);
  }
  return out;
}

// --- the reminder job -------------------------------------------------------------
async function remindedFor(appId, status, slotIso) {
  const ev = await prisma.interviewEvent.findFirst({ where: { applicationId: appId, status, toSlot: slotIso }, select: { id: true } });
  return !!ev;
}

const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);

async function runInterviewReminders({ now = new Date(), force = false, dryRun = false, onlyIds = null, record = true } = {}) {
  const st = await loadSettings();
  const staffSt = await loadStaffSettings();
  // B4: staff in-app reminders follow their own setting (ON); everything the
  // candidate / client / outside people get follows the "Candidate emails" switch.
  const candOn = st.enabled === true;
  const staffOn = staffSt.enabled === true;
  if (!candOn && !staffOn && !force) return { skipped: true, reason: 'Automatic reminders are switched off (Admin setting).' };
  const t = now.getTime();
  const idFilter = onlyIds ? { id: { in: onlyIds } } : {};
  const summary = { at: now.toISOString(), dayBefore: 0, hourBefore: 0, feedbackMissing: 0, guaranteeEnding: 0, offersExpired: 0, candidateReminders: candOn, staffReminders: staffOn, dryRun: !!dryRun, items: [] };
  // B3: offers past their time become Expired (recruiter + TL told).
  // eslint-disable-next-line global-require
  if (!dryRun && !onlyIds) summary.offersExpired = await require('./offerLink').expireDue({ now }).catch(() => 0);

  // 1 + 2 — slot reminders.
  const soon = await prisma.application.findMany({
    where: { ...idFilter, interviewStatus: { in: LIVE }, interviewAt: { gt: now, lte: new Date(t + DAY) }, stage: { notIn: DECIDED } },
    select: { id: true, interviewAt: true, candidate: { select: { name: true } } },
  });
  for (const a of soon) {
    const slot = a.interviewAt.toISOString();
    const left = a.interviewAt.getTime() - t;
    let kind = null;
    if (left <= HOUR) kind = 'REMINDER_HOUR';
    else if (left > 2 * HOUR) kind = 'REMINDER_DAY';
    if (!kind) continue;
    // Is anyone to be told? Staff (their own setting) or everyone (the switch).
    const staffWants = staffOn && (kind === 'REMINDER_HOUR' ? staffSt.hourBefore : staffSt.dayBefore);
    if (!candOn && !staffWants && !force) continue;
    if (skipPerson(a.candidate && a.candidate.name)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await remindedFor(a.id, kind, slot)) continue;
    summary.items.push({ applicationId: a.id, kind, slot });
    if (kind === 'REMINDER_HOUR') summary.hourBefore += 1; else summary.dayBefore += 1;
    if (dryRun) continue;
    // Written first, so two overlapping passes cannot both send.
    // eslint-disable-next-line no-await-in-loop
    await prisma.interviewEvent.create({ data: { applicationId: a.id, status: kind, toSlot: slot, by: 'System', reason: kind === 'REMINDER_HOUR' ? 'Reminder sent — 1 hour before' : 'Reminder sent — the day before' } });
    // eslint-disable-next-line no-await-in-loop
    await announceInterview(a.id, kind === 'REMINDER_HOUR' ? 'reminder_hour' : 'reminder_day', { key: `interview|${kind}|${a.id}|${slot}`, staffOnly: !candOn });
  }

  // 3 — feedback missing: the slot is 2+ hours gone, no feedback, no decision.
  // (3 and 4 run as before: with the switch on, or "Run now".)
  const today = istDay(now);
  const owed = !candOn && !force ? [] : await prisma.application.findMany({
    where: {
      ...idFilter,
      interviewStatus: { in: [...LIVE, 'STARTED', 'COMPLETED', 'PENDING_FEEDBACK'] },
      interviewAt: { lt: new Date(t - 2 * HOUR), gte: new Date(t - 14 * DAY) },
      stage: { notIn: DECIDED },
    },
    include: { interviewFeedbacks: { where: { kind: 'Internal' }, select: { updatedAt: true } }, candidate: { select: { name: true } }, requirement: { select: { title: true, recruiterId: true, recruiterIds: true, tlId: true } } },
  });
  for (const a of owed) {
    // Feedback for THIS slot only: a round-2 slot is still owed even though
    // round 1's feedback is on file (one Internal row per application).
    if ((a.interviewFeedbacks || []).some((fb) => fb.updatedAt > a.interviewAt)) continue;
    if (skipPerson(a.candidate && a.candidate.name)) continue;
    const key = `interview|feedback-missing|${a.id}|${today}`;
    // eslint-disable-next-line no-await-in-loop
    const done = await prisma.notification.findFirst({ where: { recipient: key }, select: { id: true } });
    if (done) continue;
    summary.feedbackMissing += 1;
    summary.items.push({ applicationId: a.id, kind: 'FEEDBACK_MISSING' });
    if (dryRun) continue;
    const r = a.requirement || {};
    const ids = [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim()), r.tlId].filter(Boolean);
    // eslint-disable-next-line no-await-in-loop
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] }, status: 'Active' }, select: { id: true, name: true, email: true } });
    const daysLate = Math.max(0, Math.floor((t - a.interviewAt.getTime()) / DAY));
    const title = `🔴 Feedback missing: ${a.candidate ? a.candidate.name : 'Candidate'}`;
    const message = `${r.title || 'Job'} — interview was ${when(a.interviewAt)}${daysLate ? ` (${daysLate} day${daysLate === 1 ? '' : 's'} ago)` : ''}. Please fill the short feedback form on Interviews → Waiting for feedback.`;
    for (const u of users.filter((x) => !skipPerson(`${x.name} ${x.email}`))) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message, channel: 'In-App', recipient: key, status: 'Sent' } });
      // eslint-disable-next-line no-await-in-loop
      if (u.email) await mailTo(u.email, title.replace(/^[^\w]+\s*/, ''), `Hello ${u.name},\n\n${message}\n\n— TeamLink`);
    }
  }

  // 4 — guarantee period ends within 7 days (client placements).
  // eslint-disable-next-line global-require
  const { guaranteeDaysOf } = require('./workflowFlow');
  // eslint-disable-next-line global-require
  const { guaranteeEndOf } = require('./atsVocab');
  const joined = !candOn && !force ? [] : await prisma.application.findMany({
    where: {
      ...idFilter,
      stage: { in: ['JOINED'] },
      joiningStatus: 'Joined',
      joinedAt: { gte: new Date(t - 400 * DAY) },
      requirement: { internal: false },
    },
    include: { candidate: { select: { name: true } }, requirement: { include: { client: { select: { name: true, guaranteePeriod: true } } } } },
  });
  for (const a of joined) {
    if (a.hiringType === 'TeamLink Internal Hire') continue;
    if (skipPerson(a.candidate && a.candidate.name)) continue;
    const end = guaranteeEndOf(a, guaranteeDaysOf(a.requirement.client && a.requirement.client.guaranteePeriod));
    if (!end) continue;
    const left = end.getTime() - t;
    if (left < 0 || left > 7 * DAY) continue;
    const key = `guarantee-ends|${a.id}|${end.toISOString().slice(0, 10)}`;
    // eslint-disable-next-line no-await-in-loop
    const done = await prisma.notification.findFirst({ where: { recipient: key }, select: { id: true } });
    if (done) continue;
    summary.guaranteeEnding += 1;
    summary.items.push({ applicationId: a.id, kind: 'GUARANTEE_ENDING', ends: end.toISOString().slice(0, 10) });
    if (dryRun) continue;
    const r = a.requirement;
    const ids = [r.recruiterId, r.bdeId, r.tlId].filter(Boolean);
    // eslint-disable-next-line no-await-in-loop
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] }, status: 'Active' }, select: { id: true, name: true, email: true } });
    const daysLeft = Math.ceil(left / DAY);
    const title = `🟠 Guarantee ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}: ${a.candidate ? a.candidate.name : 'Candidate'}`;
    const message = `${r.title} — ${r.client ? r.client.name : ''}. The replacement period (${r.client ? r.client.guaranteePeriod : ''}) ends on ${end.toISOString().slice(0, 10)}. Call the candidate and the client to check all is well.`;
    for (const u of users.filter((x) => !skipPerson(`${x.name} ${x.email}`))) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message, channel: 'In-App', recipient: key, status: 'Sent' } });
      // eslint-disable-next-line no-await-in-loop
      if (u.email) await mailTo(u.email, title.replace(/^[^\w]+\s*/, ''), `Hello ${u.name},\n\n${message}\n\n— TeamLink`);
    }
  }

  // record=false: a simulated clock (sandbox tests) never becomes "last sent".
  if (!dryRun && !onlyIds && record) {
    const brief = { at: summary.at, dayBefore: summary.dayBefore, hourBefore: summary.hourBefore, feedbackMissing: summary.feedbackMissing, guaranteeEnding: summary.guaranteeEnding };
    await saveSettings({ lastRunAt: summary.at, lastRun: brief }).catch(() => null);
  }
  return summary;
}

// --- WhatsApp: the sender's OWN WhatsApp, never sent from here -------------------
// There is no WhatsApp provider. After a booking the calendar shows a
// "Send on WhatsApp" button per person: a wa.me link with the message ready,
// which opens WhatsApp on the user's own phone / computer. Nothing is sent by
// the server; opening it is logged as a follow-up (POST /ats/interviews/:id/
// whatsapp-log). Indian 10-digit numbers get the 91 country code.
function waPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
function waUrl(phone, text) {
  return `https://wa.me/${phone || ''}?text=${encodeURIComponent(text)}`;
}
async function whatsappLinks(applicationId, actor = null) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { candidate: true, requirement: { include: { client: true, bde: { include: { employee: { select: { phone: true } } } } } } },
  });
  if (!app) return [];
  const r = app.requirement || {};
  const client = r.internal ? 'TeamLink' : (r.client && r.client.name) || '';
  const round = app.interviewRound || 1;
  const first = String((app.candidate && app.candidate.name) || '').split(/\s+/)[0] || 'there';
  const sign = actor && actor.name ? `— ${actor.name}, TeamLink` : '— TeamLink';
  const slot = [
    `Round: ${round}`,
    `When: ${when(app.interviewAt)}`,
    `Where: ${whereLine(app)}`,
    `Interviewer: ${app.interviewer || 'to be confirmed'}`,
  ];
  const out = [];
  const candText = [`Hi ${first}, your interview for ${r.title || 'the job'}${client ? ` at ${client}` : ''} is booked.`, ...slot, 'Please reply OK to confirm.', sign].join('\n');
  const cPhone = waPhone(app.candidate && app.candidate.phone);
  out.push({ to: 'candidate', label: 'Candidate', name: app.candidate ? app.candidate.name : '', phone: cPhone, text: candText, url: waUrl(cPhone, candText) });
  if (r.bde) {
    const bText = [`Interview booked: ${app.candidate ? app.candidate.name : 'Candidate'} for ${r.title || 'the job'}${client ? ` (${client})` : ''}.`, ...slot, sign].join('\n');
    const bPhone = waPhone(r.bde.employee && r.bde.employee.phone);
    out.push({ to: 'bde', label: 'Client manager (BDE)', name: r.bde.name, phone: bPhone, text: bText, url: waUrl(bPhone, bText) });
  }
  return out;
}

let TIMER = null;
let RUNNING = false;
function startSweep() {
  if (sandbox.isSandbox()) return; // the sandbox runs no timers
  const ms = Number(process.env.INTERVIEW_REMINDER_SWEEP_MS || 15 * 60000);
  if (!ms || TIMER) return;
  TIMER = setInterval(async () => {
    if (RUNNING) return;
    RUNNING = true;
    try { await runInterviewReminders(); } catch (err) { console.error('[interviewReminders]', err.message); } finally { RUNNING = false; } // eslint-disable-line no-console
  }, ms);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  SETTINGS_KEY, loadSettings, saveSettings, STAFF_SETTINGS_KEY, loadStaffSettings, saveStaffSettings, announceInterview, runInterviewReminders, startSweep, queueCandidateEmail, when,
  whatsappLinks, waPhone, candidateEmailsOn, SWITCHED_OFF, SWITCHED_OFF_DETAIL,
};

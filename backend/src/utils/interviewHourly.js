// ---------------------------------------------------------------------------
// EVERY-HOUR INTERVIEW REMINDERS (founder 2026-11-04: "candiadate ki interview vuntey, interview day
// before nunchi, interview time varaku, every one hour ki cand ki, ahh recruiter ki, ahh tl ki, bde ki
// mail vellali. & also ... entire application lo ey chota vunna, popup avvali").
//
// From the day before (plan.hourly.fromHours, 24 by default) until the interview starts, once in
// every hour before the slot:
//   the candidate                    a mail (the normal one-person send: consent, STOP, "Candidate
//                                    emails", daily limits all apply there)
//   the recruiter(s), TL, BDE(s)     a mail + a bell note that pops up on screen wherever they are in
//                                    TeamLink (components/InterviewPopup.jsx, GET /admin/notifications/
//                                    interview-popups)
// The last hour is the older "1 hour before" reminder (utils/interviewEngine.js): not sent twice.
// Mails follow the same switches as every other interview mail: "Send the reminders by themselves"
// (plan.armed) and "Candidate emails". The pop-up always goes while the team reminders are on.
// Quiet hours (company Message templates -> Limits): no mail at night; the pop-up still goes.
//
// Each hour is sent ONCE: a row in "InterviewHourlyReminder" (key = interview | slot | hour) written
// BEFORE sending, so two passes can never both send. A moved interview has a new slot, so its hours
// start again; a cancelled or decided one is not scheduled any more, so nothing goes.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const MIN = 60000;
const HOUR = 3600000;
const TEAM = { Recruiter: 'recruiter', 'Team lead': 'tl', 'Client manager (BDE)': 'bde' };
// + the 15-minute pop-up (founder 2026-11-23: "a popup 60 and 15 minutes before"; runMin15 below)
const POPUP_KEYS = ['interview|hourly|', 'interview|hour|', 'interview|min15|'];

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "InterviewHourlyReminder" ("key" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)')
      .catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}
// true = this pass owns the hour (the row was new)
async function claim(key, applicationId) {
  await ensureTable();
  const n = await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "InterviewHourlyReminder" ("key", "applicationId") VALUES (?, ?)', key, applicationId);
  return Number(n) === 1;
}

// ---- pure time math (tested on its own) ----------------------------------------------------------------
// The hour this moment falls in, counted back from the slot: 5 = "between 5 and 4 hours before".
// null = nothing due (outside the window, the last hour, or just booked).
function hourDue({ leftMs, bookedAgoMs, plan }) {
  const h = plan.hourly;
  if (!h || !h.on || leftMs <= 0) return null;
  const n = Math.ceil(leftMs / HOUR);
  if (n < 2 || n > h.fromHours) return null; // the last hour = the "1 hour before" reminder
  if (bookedAgoMs < 30 * MIN) return null; // the booking message has just gone
  return n;
}
function leftWords(ms) {
  if (ms < 90 * MIN) return `in ${Math.max(1, Math.round(ms / MIN))} minutes`;
  const h = Math.round(ms / HOUR);
  return h >= 20 && h <= 28 ? `tomorrow (in about ${h} hours)` : `in about ${h} hours`;
}

// ---- one pass ----------------------------------------------------------------------------------------------
// apps: the live interviews of the next fromHours hours (with candidate + requirement.client).
// -> adds { hourlyCandidate, hourlyTeam } to summary
async function run({
  apps, bookedAt, now, plan, summary, dryRun, force, candOn, staffOn, emailsOn, quietNow, skipP,
}) {
  const IN = require('./interviewNotices'); // eslint-disable-line global-require
  const ENGINE = require('./interviewEngine'); // eslint-disable-line global-require
  const TELL = require('./interviewTell'); // eslint-disable-line global-require
  const h = plan.hourly;
  summary.hourlyCandidate = 0;
  summary.hourlyTeam = 0;
  if (!h || !h.on) return;
  const t = now.getTime();
  const mailNow = emailsOn && (!quietNow || force);
  for (const a of apps) {
    if (skipP(a.candidate && a.candidate.name)) continue; // eslint-disable-line no-continue
    const slot = a.interviewAt.toISOString();
    const left = a.interviewAt.getTime() - t;
    const booked = t - (bookedAt.get(a.id) || t - 365 * 86400000);
    const n = hourDue({ leftMs: left, bookedAgoMs: booked, plan });
    if (!n) continue; // eslint-disable-line no-continue
    const name = a.candidate ? a.candidate.name : 'Candidate';
    const r = a.requirement || {};
    const soon = leftWords(left);

    // --- the candidate: a mail
    // SCHEDULED REMINDERS (utils/scheduledReminders.js): when the new plan covers this interview, its messages replace these mails (no double messages)
    // eslint-disable-next-line no-await-in-loop
    const planCovers = await require('./scheduledReminders').coversInterview(a.id, slot); // eslint-disable-line global-require
    if (h.candidate && candOn && mailNow && !planCovers) {
      const key = `cand|${a.id}|${slot}|${n}`;
      if (dryRun) {
        summary.items.push({ applicationId: a.id, kind: 'HOURLY_CANDIDATE', hour: n });
        summary.hourlyCandidate += 1;
      // eslint-disable-next-line no-await-in-loop
      } else if (await claim(key, a.id)) {
        summary.items.push({ applicationId: a.id, kind: 'HOURLY_CANDIDATE', hour: n });
        summary.hourlyCandidate += 1;
        // eslint-disable-next-line no-await-in-loop
        const sys = await ENGINE.systemIdentityFor(a);
        const first = String(name).split(' ')[0];
        const body = [
          `Hello ${first},`, '',
          `This is a reminder: your interview for ${r.title || 'the job'} is ${soon}.`, '',
          ...IN.lines(a, 'reminder_hour', {}, true).slice(1), '',
          'Please be ready a few minutes early. If you cannot make it, reply to this mail or call your recruiter.', '',
          '— TeamLink',
        ].join('\n');
        if (sys) {
          // eslint-disable-next-line no-await-in-loop
          await require('./omniSend').send(sys, { // eslint-disable-line global-require
            audience: 'candidates', id: a.candidateId, channel: 'Email', applicationId: a.id, purpose: 'Interview reminder', urgent: true,
            subject: `Reminder: your ${r.title || ''} interview is ${soon}`.replace(/\s+/g, ' '), body,
          }).catch(() => null);
        }
      }
    }

    // --- the recruiter(s), the TL, the BDE(s): a mail + the pop-up
    if (h.team && (staffOn || force)) {
      // eslint-disable-next-line no-await-in-loop
      const parties = (await TELL.partiesOf(a)).filter((p) => p.userId && p.roles.some((x) => TEAM[x]));
      const lines = IN.staffLines(a, 'reminder_hour');
      const online = !/person|tele|phone/i.test(String(a.interviewMode || ''));
      if (online && !a.interviewMeetingLink) lines.push('⚠ No meeting link yet - add it now (Interview Calendar → Create meeting link).');
      const title = `⏰ Interview ${soon}: ${name}`;
      for (const p of parties) {
        const key = `interview|hourly|${a.id}|${slot}|${n}|${p.userId}`;
        if (dryRun) {
          summary.items.push({ applicationId: a.id, kind: 'HOURLY_TEAM', hour: n, to: p.name });
          summary.hourlyTeam += 1;
          continue; // eslint-disable-line no-continue
        }
        // eslint-disable-next-line no-await-in-loop
        if (!(await claim(key, a.id))) continue; // eslint-disable-line no-continue
        summary.items.push({ applicationId: a.id, kind: 'HOURLY_TEAM', hour: n, to: p.name });
        summary.hourlyTeam += 1;
        // the hour before's note is done with: one live note per interview in the bell
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.updateMany({ where: { userId: p.userId, read: false, recipient: { startsWith: `interview|hourly|${a.id}|` } }, data: { read: true } }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.create({ data: { userId: p.userId, title, message: lines.join(' · '), channel: 'In-App', recipient: key, status: 'Sent' } });
        if (p.email && mailNow) {
          // eslint-disable-next-line no-await-in-loop
          await IN.mailTo(p.email, title.replace(/^[^\w]+\s*/, ''), ['Hello,', '', `Interview ${soon}:`, '', ...lines, '', 'Open TeamLink → Interview Calendar for the details.', '', '— TeamLink'].join('\n'));
        }
      }
    }
  }
}

// ---- 15 MINUTES BEFORE (2026-11-23) -------------------------------------------------------------------------
// The recruiter(s), TL, BDE(s) and staff panelists get ONE more pop-up 15 minutes before the slot. The earlier hour notes of
// the same interview are marked read first, so the pop-up shows this one only (one card per interview, never two).
// Each person once per slot (claim). Switch: Administration > Step timing > Client updates > "Pop-up 15 minutes before".
async function runMin15({ apps, now, summary, dryRun, force, staffOn, skipP }) {
  summary.min15Team = 0;
  if (!(staffOn || force)) return;
  let on = true;
  try { on = (await require('./atsUpdates').settings()).interviews.min15Popup !== false; } catch { on = true; } // eslint-disable-line global-require
  if (!on) return;
  const IN = require('./interviewNotices'); // eslint-disable-line global-require
  const TELL = require('./interviewTell'); // eslint-disable-line global-require
  const t = now.getTime();
  for (const a of apps) {
    const left = a.interviewAt.getTime() - t;
    if (left <= 0 || left > 15 * MIN) continue; // eslint-disable-line no-continue
    if (skipP(a.candidate && a.candidate.name)) continue; // eslint-disable-line no-continue
    const slot = a.interviewAt.toISOString();
    const name = a.candidate ? a.candidate.name : 'Candidate';
    // eslint-disable-next-line no-await-in-loop
    const parties = (await TELL.partiesOf(a)).filter((p) => p.userId);
    const lines = IN.staffLines(a, 'reminder_hour');
    const title = `⏰ Interview in ${Math.max(1, Math.round(left / MIN))} minutes: ${name}`;
    for (const p of parties) {
      const key = `interview|min15|${a.id}|${slot}|${p.userId}`;
      if (dryRun) { summary.items.push({ applicationId: a.id, kind: 'MIN15_TEAM', to: p.name }); summary.min15Team += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (!(await claim(key, a.id))) continue; // eslint-disable-line no-continue
      summary.items.push({ applicationId: a.id, kind: 'MIN15_TEAM', to: p.name });
      summary.min15Team += 1;
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.updateMany({ where: { userId: p.userId, read: false, OR: [{ recipient: { startsWith: `interview|hourly|${a.id}|` } }, { recipient: { startsWith: `interview|hour|${a.id}|` } }] }, data: { read: true } }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: p.userId, title, message: lines.join(' · '), channel: 'In-App', recipient: key, status: 'Sent' } });
    }
  }
}

// ---- the pop-up ----------------------------------------------------------------------------------------------
// The caller's own unread interview reminders of the last 75 minutes (the hourly ones and the "1 hour
// before" one), one per interview, for interviews still booked at that slot.
async function popupsFor(userId, { now = new Date() } = {}) {
  const rows = await prisma.notification.findMany({
    where: { userId, read: false, createdAt: { gt: new Date(now.getTime() - 75 * MIN) }, OR: POPUP_KEYS.map((k) => ({ recipient: { startsWith: k } })) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const byApp = new Map(); // applicationId -> { slot, ids: [] }
  rows.forEach((n) => {
    const [, , appId, slot] = String(n.recipient).split('|');
    if (!appId || !slot) return;
    const e = byApp.get(appId) || { slot, ids: [], at: n.createdAt };
    if (e.slot === slot) e.ids.push(n.id);
    byApp.set(appId, e);
  });
  if (!byApp.size) return [];
  const apps = await prisma.application.findMany({
    where: { id: { in: [...byApp.keys()] }, interviewStatus: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] } },
    include: { candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, internal: true, client: { select: { name: true } } } } },
  });
  const IN = require('./interviewNotices'); // eslint-disable-line global-require
  return apps
    .filter((a) => a.interviewAt && a.interviewAt.toISOString() === byApp.get(a.id).slot && a.interviewAt.getTime() > now.getTime() - 10 * MIN)
    .sort((x, y) => x.interviewAt - y.interviewAt)
    .map((a) => {
      const r = a.requirement || {};
      return {
        applicationId: a.id,
        ids: byApp.get(a.id).ids,
        candidateId: a.candidateId,
        candidate: a.candidate ? a.candidate.name : 'Candidate',
        job: r.title || 'Requirement',
        client: r.internal ? 'TeamLink' : (r.client && r.client.name) || '',
        round: a.interviewRound || 1,
        at: a.interviewAt,
        when: IN.when(a.interviewAt),
        where: IN.whereLine(a).replace(/ — join here: .*$/, ''),
        mode: a.interviewMode || '',
        link: a.interviewMeetingLink || null,
        noLink: !/person|tele|phone/i.test(String(a.interviewMode || '')) && !a.interviewMeetingLink,
      };
    });
}

// "OK": the caller's own notes only.
async function seen(userId, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 100);
  if (!list.length) return 0;
  const r = await prisma.notification.updateMany({ where: { userId, id: { in: list }, OR: POPUP_KEYS.map((k) => ({ recipient: { startsWith: k } })) }, data: { read: true } });
  return r.count;
}

module.exports = {
  run, runMin15, hourDue, leftWords, popupsFor, seen, claim, POPUP_KEYS,
};

// ---------------------------------------------------------------------------
// INTERVIEW REMINDER PLAN (user, 2026-10-10) — WHO is reminded of an interview, WHEN, and HOW.
// One saved setting (AppSetting "interview-reminder-plan"), edited in Administration -> Company
// Setup -> Step timing -> "Interview reminders". It EXTENDS the two older switches, it does not
// replace them:
//   * "Candidate emails" (AppSetting "interview-reminders", utils/interviewNotices.js): the one
//     company switch for every automatic message to a candidate. Still decides whether anything goes
//     to a candidate or an outside person.
//   * "Staff reminders" (AppSetting "interview-staff-reminders"): the on/off of the bell reminders
//     for the people running the interview. Still the master switch for the four staff parties.
//
// THE FOUR PARTIES OF AN INTERVIEW: the candidate, the recruiter, the team lead (TL) and the client
// manager (BDE). The interviewer (panel) is told with the staff.
//
//   candidate  24 hours before ("tomorrow"), 1 hour before, and 15 minutes before for an ONLINE
//              interview (with the join link). Channels in order; "first" = the first one that can
//              go (WhatsApp -> SMS -> Email), "all" = every channel that can go.
//   staff      a "Today's interviews" list at 08:30 India time, and a reminder 1 hour before each
//              interview, per party: bell, mail, and (off by default) WhatsApp / SMS.
//   no-show    30 minutes after the start, an interview with no status -> the recruiter is asked
//              "Did the candidate attend?".
//   feedback   2 hours after the end with no feedback -> the interviewer, recruiter and TL.
//   safety net 10 minutes after a booking / move / cancel that nobody told the candidate about, the
//              booked message goes by itself (so an interview is never left unannounced).
//
// QUIET HOURS: the urgent reminders (1 hour, 15 minutes, no-show, moved / cancelled notices) are
// never held. The day-before reminder waits for the morning when it would fall inside the company's
// quiet hours (Message templates -> Limits), unless "quiet" is switched off here.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'interview-reminder-plan';
const PARTIES = ['recruiter', 'tl', 'bde', 'interviewer'];
const PARTY_WORD = { recruiter: 'Recruiter', tl: 'Team lead (TL)', bde: 'Client manager (BDE)', interviewer: 'Interviewer' };
const CHANNELS = ['WhatsApp', 'SMS', 'Email'];

const partyDefault = () => ({ digest: true, hourBefore: true, bell: true, email: true, whatsapp: false, sms: false });
const DEFAULTS = {
  candidate: {
    dayBefore: true, hourBefore: true, nowOnline: true, channels: ['WhatsApp', 'SMS', 'Email'], strategy: 'first', safetyNetMinutes: 10,
  },
  parties: { recruiter: partyDefault(), tl: partyDefault(), bde: partyDefault(), interviewer: partyDefault() },
  digestAt: '08:30',
  noShow: { on: true, afterMinutes: 30 },
  feedback: { on: true, afterHours: 2 },
  quiet: true,
  // OFF until an Admin / HR presses "Turn on automatic sending". While off, the reminder job sends NOTHING outside the app
  // (no mail, WhatsApp or SMS to anybody) and nothing to candidates; only the in-app bell goes. Prepared 2026-10-12 so that
  // loading this code on a live server can never message a real person by itself.
  armed: false,
};

const validHm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function clean(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const c = v.candidate && typeof v.candidate === 'object' ? v.candidate : {};
  const d = DEFAULTS.candidate;
  const chs = Array.isArray(c.channels) ? c.channels.filter((x, i, a) => CHANNELS.includes(x) && a.indexOf(x) === i) : d.channels;
  const parties = {};
  PARTIES.forEach((p) => {
    const o = v.parties && v.parties[p] && typeof v.parties[p] === 'object' ? v.parties[p] : {};
    const b = DEFAULTS.parties[p];
    parties[p] = {
      digest: bool(o.digest, b.digest), hourBefore: bool(o.hourBefore, b.hourBefore), bell: bool(o.bell, b.bell), email: bool(o.email, b.email), whatsapp: bool(o.whatsapp, b.whatsapp), sms: bool(o.sms, b.sms),
    };
  });
  const ns = v.noShow && typeof v.noShow === 'object' ? v.noShow : {};
  const fb = v.feedback && typeof v.feedback === 'object' ? v.feedback : {};
  return {
    candidate: {
      dayBefore: bool(c.dayBefore, d.dayBefore), hourBefore: bool(c.hourBefore, d.hourBefore), nowOnline: bool(c.nowOnline, d.nowOnline),
      channels: chs.length ? chs : d.channels, strategy: c.strategy === 'all' ? 'all' : 'first', safetyNetMinutes: intIn(c.safetyNetMinutes, 0, 120, d.safetyNetMinutes),
    },
    parties,
    digestAt: validHm(v.digestAt) ? v.digestAt : DEFAULTS.digestAt,
    noShow: { on: bool(ns.on, true), afterMinutes: intIn(ns.afterMinutes, 10, 180, 30) },
    feedback: { on: bool(fb.on, true), afterHours: intIn(fb.afterHours, 1, 48, 2) },
    quiet: bool(v.quiet, true),
    armed: v.armed === true,
  };
}

async function load() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return { ...clean(v), updatedByName: row ? row.updatedByName : null, updatedAt: row ? row.updatedAt : null };
}

async function save(patch, user) {
  const cur = await load();
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = {
    candidate: { ...cur.candidate, ...(p.candidate || {}) },
    parties: Object.fromEntries(PARTIES.map((k) => [k, { ...cur.parties[k], ...((p.parties || {})[k] || {}) }])),
    digestAt: p.digestAt === undefined ? cur.digestAt : p.digestAt,
    noShow: { ...cur.noShow, ...(p.noShow || {}) },
    feedback: { ...cur.feedback, ...(p.feedback || {}) },
    quiet: p.quiet === undefined ? cur.quiet : p.quiet,
    armed: p.armed === undefined ? cur.armed : p.armed === true,
  };
  if (p.digestAt !== undefined && !validHm(p.digestAt)) return { error: 'Write the time like 08:30.', status: 400 };
  if (p.candidate && p.candidate.channels !== undefined && (!Array.isArray(p.candidate.channels) || !p.candidate.channels.length)) return { error: 'Pick at least one way to reach the candidate.', status: 400 };
  const next = clean(merged);
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  return { settings: await load(), before: cur };
}

module.exports = { KEY, PARTIES, PARTY_WORD, CHANNELS, DEFAULTS, clean, load, save };

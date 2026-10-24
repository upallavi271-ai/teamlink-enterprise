// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE RULES, checked BEFORE every call attempt.
//
//   who        roleAllows: the Admin's role list; contactAccess + scope are checked by callService
//   candidate  personVerdict: phone, test list, opt-out, consent, DND, job switch, step of the application
//   when       windowVerdict: calling hours (India time) - queue for the next window or refuse (Admin's choice)
//   how many   limitVerdict: daily limit, per-recruiter limit
//   again      dedupeKey + scheduleVersionOf: one call per candidate / job / campaign / purpose / interview version / reminder slot
//
// Every verdict is { ok:true } or { ok:false, code, reason } (reason in plain words). The clock is injectable (`now`).
// CONSENT RULE CHOSEN (documented in the report, configurable):
//   WITHDRAWN / NOT_GIVEN / do-not-contact  -> never
//   GIVEN (purpose Recruitment or Messages)  -> allowed
//   no record at all -> screening: refused. Shortlist / interview / reminder ("service" calls): refused UNLESS the Admin ticked
//   "Allow service calls to people who applied but have no consent record" (default OFF).
//   DND-marked number -> screening refused; service calls refused unless the Admin ticked "Allow service calls to DND numbers".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const core = require('../utils/messagingCore');
const S = require('./scripts');
const DB = require('./schema');

const IST_MIN = 330;
const LIVE_INTERVIEW = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const CLOSED_STAGES = ['REJECTED', 'JOINED', 'HIRED'];
const refuse = (code, reason) => ({ ok: false, code, reason });
const OK = { ok: true };

// --- India clock ----------------------------------------------------------------------------------------------------
function istParts(now = new Date()) {
  const t = new Date(now.getTime() + IST_MIN * 60000);
  return { ymd: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
const hmToMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const startOfIstDay = (now = new Date()) => new Date(Date.parse(`${istParts(now).ymd}T00:00:00+05:30`));

function inWindow(now, from, to) {
  const m = istParts(now).minutes;
  const a = hmToMin(from); const b = hmToMin(to);
  return a <= b ? (m >= a && m < b) : (m >= a || m < b);
}
// The next moment the window opens (now itself when it is open).
function nextWindowStart(now, from, to) {
  if (inWindow(now, from, to)) return now;
  const p = istParts(now);
  const a = hmToMin(from);
  const day = p.minutes < a ? p.ymd : new Date(Date.parse(`${p.ymd}T00:00:00+05:30`) + 86400000 + IST_MIN * 60000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T${String(from).padStart(5, '0')}:00+05:30`));
}
function windowVerdict(now, s) {
  if (inWindow(now, s.hoursFrom, s.hoursTo)) return OK;
  const until = nextWindowStart(now, s.hoursFrom, s.hoursTo);
  const words = `Calls are placed only between ${s.hoursFrom} and ${s.hoursTo} India time.`;
  if (s.outside === 'Refuse') return refuse('outside_hours', `${words} Try again inside those hours.`);
  return { ok: false, wait: true, code: 'outside_hours', until, reason: `${words} It is queued for ${until.toISOString()}.` };
}

// --- who --------------------------------------------------------------------------------------------------------------------
const roleOf = (user) => String((user && (user.atsRole || user.role)) || '').toUpperCase();
function roleAllows(user, s, bulk = false) {
  const r = roleOf(user);
  const rr = String((user && user.role) || '').toUpperCase();
  const list = bulk ? s.bulkRoles : s.callRoles;
  return list.includes(r) || (['SUPER_ADMIN', 'ADMIN'].includes(rr) && list.includes(rr));
}

// --- the numbers --------------------------------------------------------------------------------------------------------------
const phoneKey = (e164) => String(e164 || '').replace(/\D/g, '').slice(-10);
async function suppression(e164) {
  const k = phoneKey(e164);
  if (!k) return [];
  return DB.all('SELECT "kind" FROM "AiCallSuppression" WHERE "phone" = ?', k);
}
async function callOptOut(e164) {
  try {
    const row = await require('../utils/messageDelivery').optedOut('Call', e164); // eslint-disable-line global-require
    return !!row;
  } catch { return false; }
}

// --- the person -----------------------------------------------------------------------------------------------------------------
// ctx: { candidate, app, requirement, purpose, s (settings), now, jobSetting }
async function personVerdict(ctx) {
  const {
    candidate: c, app, requirement: r, purpose, s, now,
  } = ctx;
  if (!S.PURPOSES.includes(purpose)) return refuse('bad_purpose', 'That kind of call does not exist.');
  if (s.mode === 'Off') return refuse('off', 'AI calling is switched off. An Admin turns it on in Administration > Integrations > AI Calling.');
  const m = core.normalizeMobile(c && c.phone);
  if (!m.ok) return refuse('no_phone', `This candidate has no usable phone number (${m.reason}).`);
  if (s.mode === 'Test' && !s.testNumbers.includes(m.e164)) {
    return refuse('test_number', 'Test mode is on, so only the test numbers saved by the Admin can be called. Nobody else is called until the Admin switches to Live.');
  }
  if (c.doNotContact || c.consentStatus === 'WITHDRAWN') return refuse('opted_out', 'This candidate asked not to be contacted.');
  const sup = await suppression(m.e164);
  if (sup.some((x) => x.kind === 'optout') || await callOptOut(m.e164)) return refuse('opted_out', 'This number asked not to be called by the AI assistant.');
  const service = S.TRANSACTIONAL.has(purpose);
  if (sup.some((x) => x.kind === 'dnd')) {
    if (!service) return refuse('dnd', 'This number is on the Do Not Disturb list, so a screening call is not allowed.');
    if (!s.dndService) return refuse('dnd', 'This number is on the Do Not Disturb list. An Admin can allow service calls (interview and shortlist notices) to such numbers.');
  }
  if (c.consentStatus === 'NOT_GIVEN') return refuse('no_consent', 'This candidate did not give consent to be contacted.');
  if (c.consentStatus === 'GIVEN') {
    const p = String(c.consentPurposes || '');
    if (p && !/recruit|message/i.test(p)) return refuse('no_consent', 'The consent on record is not for recruitment calls.');
  } else if (!(service && s.consentApplied)) {
    return refuse('no_consent', service
      ? 'There is no consent record for this candidate. An Admin can allow service calls to people who applied.'
      : 'There is no consent record for this candidate, so a screening call is not allowed.');
  }
  if (ctx.jobSetting && ctx.jobSetting.enabled === 0) return refuse('job_off', 'AI calling is switched off for this requirement.');
  if (!app) return refuse('no_application', 'The candidate is not on this requirement.');
  if (r && String(r.status || '') === 'CLOSED' && purpose === 'Screening') return refuse('job_closed', 'This requirement is closed.');
  const stage = String(app.stage || '');
  if (purpose === 'Screening') {
    if (CLOSED_STAGES.includes(stage)) return refuse('stage', 'This application is already closed.');
  } else if (purpose === 'Shortlist Notification') {
    if (!s.shortlistStages.includes(stage)) return refuse('stage', 'The candidate is not at the shortlisted step, so the shortlist call is not allowed.');
  } else {
    if (!LIVE_INTERVIEW.includes(String(app.interviewStatus || '')) || !app.interviewAt) return refuse('no_interview', 'There is no live interview booked for this candidate.');
    if (new Date(app.interviewAt).getTime() <= now.getTime()) return refuse('interview_past', 'The interview time has already passed.');
    if (CLOSED_STAGES.includes(stage)) return refuse('stage', 'This application is already closed.');
  }
  return { ok: true, e164: m.e164, mask: core.maskMobile(c.phone), service };
}

// --- limits ---------------------------------------------------------------------------------------------------------------------
async function attemptsToday(now, mode, userId) {
  const since = startOfIstDay(now).toISOString();
  if (userId) {
    const r = await DB.one('SELECT COUNT(*) AS n FROM "AiCallEvent" e JOIN "AiCall" c ON c."id" = e."callId" WHERE e."kind" = \'attempt\' AND e."receivedAt" >= ? AND c."mode" = ? AND c."initiatedById" = ?', since, mode.toLowerCase(), userId);
    return r ? r.n : 0;
  }
  const r = await DB.one('SELECT COUNT(*) AS n FROM "AiCallEvent" e JOIN "AiCall" c ON c."id" = e."callId" WHERE e."kind" = \'attempt\' AND e."receivedAt" >= ? AND c."mode" = ?', since, mode.toLowerCase());
  return r ? r.n : 0;
}
async function limitVerdict(now, s, userId) {
  const tomorrow = new Date(startOfIstDay(now).getTime() + 86400000);
  const day = await attemptsToday(now, s.mode, null);
  if (day >= s.dailyLimit) {
    const until = nextWindowStart(tomorrow, s.hoursFrom, s.hoursTo);
    return { ok: false, code: 'daily_limit', wait: s.outside !== 'Refuse', until, reason: `The daily limit of ${s.dailyLimit} calls is reached. ${s.outside === 'Refuse' ? 'Try again tomorrow.' : 'The call waits for tomorrow.'}` };
  }
  if (userId && s.userLimit > 0 && await attemptsToday(now, s.mode, userId) >= s.userLimit) {
    const until = nextWindowStart(tomorrow, s.hoursFrom, s.hoursTo);
    return { ok: false, code: 'user_limit', wait: s.outside !== 'Refuse', until, reason: `Your daily limit of ${s.userLimit} calls is reached. ${s.outside === 'Refuse' ? 'Try again tomorrow.' : 'The call waits for tomorrow.'}` };
  }
  return OK;
}

// --- one call per ... -------------------------------------------------------------------------------------------------------------
function dedupeKey({ candidateId, requirementId, campaignId, purpose, scheduleVersion, slot }) {
  return [candidateId, requirementId || '', campaignId || '', purpose, scheduleVersion || '', slot || ''].join('|');
}
// The schedule "version": changes whenever the real interview record changes (time, format, place, link, round).
function scheduleVersionOf(app) {
  if (!app || !app.interviewAt) return null;
  const raw = [new Date(app.interviewAt).toISOString(), app.interviewMode || '', app.interviewLocation || '', app.interviewMeetingLink || '', app.interviewRound || 1].join('|');
  return `v${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)}`;
}

module.exports = {
  LIVE_INTERVIEW, CLOSED_STAGES, istParts, startOfIstDay, inWindow, nextWindowStart, windowVerdict, roleOf, roleAllows, phoneKey, personVerdict, limitVerdict, attemptsToday, dedupeKey, scheduleVersionOf, refuse,
};

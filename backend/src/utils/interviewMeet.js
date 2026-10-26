// ---------------------------------------------------------------------------
// INTERVIEW: GOOGLE MEET LINK + E-MAIL ON SCHEDULE + "START INTERVIEW" (2026-10-14).
//
//   * Settings (AppSetting "interview-meet", Admin): three e-mail switches (default ON), copy to the booker /
//     TL / BDE (default OFF), the company's standing "Default Meet link", the "Google Calendar auto-link"
//     switch (default OFF - it only uses the account saved in Integrations > Calendar Sync, see
//     utils/meetingLinks.js) and the Start window (15 minutes before .. 2 hours after).
//   * Link check: meet.google.com/xxx-xxxx-xxx is accepted; any other https meeting address is accepted with
//     a warning; anything else is refused.
//   * sendInvites(appId, event): booked / rescheduled / cancelled -> the candidate (no client name, no money),
//     the interviewer(s) / panel and, when switched on, the booker + TL + BDE as copy. Each mail carries a
//     calendar invite (.ics, METHOD REQUEST / CANCEL, stable UID per interview round, SEQUENCE grows on every
//     change so Google Calendar / Outlook UPDATE the same entry). The result of every recipient is kept in
//     AppSetting "interview-mail:<applicationId>" (no schema change) and audited with the address masked.
//     Mail trouble NEVER blocks the booking: this module never throws.
//   * startState(): who may press "Start interview", and when.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const sandbox = require('./sandbox');

const KEY = 'interview-meet';
const MAIL_PREFIX = 'interview-mail:';
const DEFAULTS = {
  emailCandidate: true, emailInterviewer: true, emailClient: true, emailChanges: true, copyTeam: false,
  defaultMeetLink: '', calendarAutoLink: false, startBeforeMin: 15, startAfterMin: 120,
};
const isTest = (s) => /zztest|example\.test/i.test(String(s || ''));
// Test people are skipped on the real server (agent rule); in the sandbox they ARE the people under test.
const skipPerson = (s) => !sandbox.isSandbox() && isTest(s);

// ---- settings --------------------------------------------------------------------------------------------------------
function cleanInt(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
}
async function loadSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    emailCandidate: v.emailCandidate !== false,
    emailInterviewer: v.emailInterviewer !== false,
    emailClient: v.emailClient !== false,
    emailChanges: v.emailChanges !== false,
    copyTeam: v.copyTeam === true,
    defaultMeetLink: typeof v.defaultMeetLink === 'string' ? v.defaultMeetLink : '',
    calendarAutoLink: v.calendarAutoLink === true,
    startBeforeMin: cleanInt(v.startBeforeMin, 0, 240, DEFAULTS.startBeforeMin),
    startAfterMin: cleanInt(v.startAfterMin, 15, 720, DEFAULTS.startAfterMin),
    updatedByName: row ? row.updatedByName : null,
  };
}
async function saveSettings(patch, user) {
  const cur = await loadSettings();
  const next = { ...cur };
  delete next.updatedByName;
  ['emailCandidate', 'emailInterviewer', 'emailClient', 'emailChanges', 'copyTeam', 'calendarAutoLink'].forEach((k) => { if (typeof patch[k] === 'boolean') next[k] = patch[k]; });
  if (patch.startBeforeMin !== undefined) next.startBeforeMin = cleanInt(patch.startBeforeMin, 0, 240, cur.startBeforeMin);
  if (patch.startAfterMin !== undefined) next.startAfterMin = cleanInt(patch.startAfterMin, 15, 720, cur.startAfterMin);
  if (patch.defaultMeetLink !== undefined) {
    const raw = String(patch.defaultMeetLink || '').trim();
    if (raw) {
      const chk = checkLink(raw);
      if (!chk.ok) return { error: chk.error, status: 400 };
      next.defaultMeetLink = chk.url;
    } else next.defaultMeetLink = '';
  }
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  return { before: cur, settings: await loadSettings() };
}

// ---- the link ----------------------------------------------------------------------------------------------------------
const MEET_RE = /^https:\/\/meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[A-Za-z0-9_-]{4,40})(?:\?[^\s#]*)?$/i;
// Returns { ok, url, kind: 'meet' | 'other', warning? } or { ok: false, error }.
function checkLink(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, error: 'Paste the meeting link.' };
  if (url.length > 500) return { ok: false, error: 'That link is too long.' };
  if (/\s/.test(url)) return { ok: false, error: 'The link has a space in it. Paste only the link.' };
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'The meeting link should start with https:// (for example https://meet.google.com/abc-defg-hij).' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'That does not look like a link.' }; }
  if (!u.hostname.includes('.')) return { ok: false, error: 'That does not look like a link.' };
  if (MEET_RE.test(url)) return { ok: true, url, kind: 'meet' };
  if (/(^|\.)meet\.google\.com$/i.test(u.hostname)) {
    return { ok: false, error: 'That Google Meet link looks incomplete. A Meet link looks like https://meet.google.com/abc-defg-hij.' };
  }
  return { ok: true, url, kind: 'other', warning: 'This is not a Google Meet link, but it will be used as it is. Check that it opens.' };
}

// ---- words & masks -----------------------------------------------------------------------------------------------------
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return '';
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}
const istParts = (d) => {
  const f = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(d));
  const g = (t) => (f.find((x) => x.type === t) || {}).value || '';
  return { date: `${g('weekday')}, ${g('day')} ${g('month')} ${g('year')}`, time: `${g('hour')}:${g('minute')} ${g('dayPeriod').toLowerCase()} IST` };
};
const isOnline = (app) => !String(app.interviewMode || '').toLowerCase().includes('person');
function whereWords(app) {
  if (!isOnline(app)) return `In person${app.interviewLocation ? ` at ${app.interviewLocation}` : ''}`;
  return app.interviewMeetingLink && /meet\.google\.com/i.test(app.interviewMeetingLink) ? 'Online (Google Meet)' : 'Online (video call)';
}
const REASONS = {
  notConfigured: 'mail is not set up (ask your Admin: Administration > Integrations > Email)',
  noAddress: 'no email address',
  switchedOff: 'this email is switched off in Settings',
  testAddress: 'this is a test address, so nothing was sent',
};
function plainReason(r) {
  if (r.notConfigured) return REASONS.notConfigured;
  const e = String((r && r.error) || 'unknown problem');
  if (/Reserved test domain/i.test(e)) return REASONS.testAddress;
  if (/No recipient/i.test(e)) return REASONS.noAddress;
  return `the mail server said: ${e.replace(/\s+/g, ' ').slice(0, 160)}`;
}

// ---- the calendar invite ----------------------------------------------------------------------------------------------
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// The UID is the interview ROUND: a reschedule or a cancel carries the same UID and a higher SEQUENCE, so the
// calendar updates the one entry instead of adding a second.
const icsUid = (app) => `interview-${app.id}-r${app.interviewRound || 1}@teamlink`;
function buildIcs({
  app, method = 'REQUEST', sequence = 0, summary, description, organizer, attendee, minutes = 60,
}) {
  const start = new Date(app.interviewAt);
  const end = new Date(start.getTime() + minutes * 60000);
  const loc = isOnline(app) ? (app.interviewMeetingLink || 'Online') : (app.interviewLocation || 'In person');
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//TeamLink//Interviews//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${icsUid(app)}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEsc(summary)}`,
    `DESCRIPTION:${icsEsc(description)}`,
    `LOCATION:${icsEsc(loc)}`,
  ];
  if (isOnline(app) && app.interviewMeetingLink) lines.push(`URL:${app.interviewMeetingLink}`);
  if (organizer && organizer.email) lines.push(`ORGANIZER;CN=${icsEsc(organizer.name || 'TeamLink')}:mailto:${organizer.email}`);
  if (attendee && attendee.email) lines.push(`ATTENDEE;CN=${icsEsc(attendee.name || '')};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${attendee.email}`);
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---- who gets what ----------------------------------------------------------------------------------------------------
const APP_INCLUDE = { candidate: true, requirement: { include: { client: true } } };
const WORDS = {
  scheduled: { head: 'is booked', subj: 'Interview booked', cancel: false },
  rescheduled: { head: 'has a new time', subj: 'Interview moved', cancel: false },
  cancelled: { head: 'is cancelled', subj: 'Interview cancelled', cancel: true },
  updated: { head: 'was updated (see the details below)', subj: 'Interview updated', cancel: false },
};

function candidateMail(app, event, ctx) {
  const w = WORDS[event];
  const r = app.requirement || {};
  const first = String((app.candidate && app.candidate.name) || '').trim().split(/\s+/)[0] || 'there';
  const when = istParts(app.interviewAt);
  const job = r.title || 'the requirement';
  const company = r.internal ? 'TeamLink' : 'our client'; // NEVER the client's name
  const lines = [`Hi ${first},`, ''];
  if (event === 'cancelled') lines.push(`Your interview for ${job} at ${company} is cancelled. Your recruiter will contact you about a new time.`);
  else lines.push(`Your interview for ${job} at ${company} ${w.head}.`);
  lines.push('');
  if (event !== 'cancelled') {
    lines.push(`Date: ${when.date}`, `Time: ${when.time}`, `Mode: ${whereWords(app)}`);
    if (isOnline(app)) lines.push(app.interviewMeetingLink ? `Join Meet: ${app.interviewMeetingLink}` : 'Meeting link: we will send it to you before the interview.');
    if (event === 'rescheduled' && ctx.fromSlot) { const o = istParts(ctx.fromSlot); lines.push(`Old time: ${o.date}, ${o.time}`); }
    lines.push('', 'Please join 5 minutes early. If you cannot make it, reply to this email or tell your recruiter as soon as you can.');
    lines.push('Questions? Reply to this email and your TeamLink recruiter will answer.');
  } else {
    lines.push('Questions? Reply to this email and your TeamLink recruiter will answer.');
  }
  lines.push('', '— TeamLink');
  const subject = `${w.subj}: ${job} — ${when.date}, ${when.time}`;
  return { subject: event === 'cancelled' ? `${w.subj}: ${job}` : subject, text: lines.join('\n'), summary: `Interview: ${job}`, description: lines.slice(2, -2).join('\n') };
}

function staffMail(app, event, ctx, role) {
  const w = WORDS[event];
  const r = app.requirement || {};
  const company = r.internal ? 'TeamLink' : (r.client && r.client.name) || '';
  const cName = (app.candidate && app.candidate.name) || 'Candidate';
  const when = istParts(app.interviewAt);
  const lines = [`Hello,`, '', `The interview of ${cName} for ${r.title || 'the requirement'}${company ? ` (${company})` : ''} ${w.head}.`, ''];
  if (event !== 'cancelled') {
    lines.push(`Date: ${when.date}`, `Time: ${when.time}`, `Mode: ${whereWords(app)}`, `Round: ${app.interviewRound || 1}`);
    if (isOnline(app)) lines.push(app.interviewMeetingLink ? `Meet link: ${app.interviewMeetingLink}` : 'Meet link: not added yet. Ask the client manager (BDE).');
    if (event === 'rescheduled' && ctx.fromSlot) { const o = istParts(ctx.fromSlot); lines.push(`Old time: ${o.date}, ${o.time}`); }
    if (ctx.reason) lines.push(`Reason: ${ctx.reason}`);
    if (role === 'Interviewer') lines.push('', 'Use "Start interview" on the interview in TeamLink (it opens 15 minutes before) or the Meet link above.');
  } else if (ctx.reason) lines.push(`Reason: ${ctx.reason}`);
  lines.push('', `Questions? Ask ${ctx.askName || 'the client manager (BDE) of this requirement'}.`, '', '— TeamLink');
  return { subject: `${w.subj}: ${cName} — ${r.title || 'Requirement'}${event === 'cancelled' ? '' : ` — ${when.date}, ${when.time}`}`, text: lines.join('\n'), summary: `Interview: ${cName} — ${r.title || 'Requirement'}`, description: lines.slice(2, -3).join('\n') };
}

// Everyone who should get a mail for this interview: [{ key, role, name, email, kind }]
async function recipientsOf(app, event, settings, actor) {
  const out = [];
  const seen = new Map();
  const add = (row) => {
    const em = String(row.email || '').trim().toLowerCase();
    const k = em || row.key;
    if (seen.has(k)) { const e = seen.get(k); if (!e.roles.includes(row.role)) e.roles.push(row.role); return; }
    const entry = { ...row, roles: [row.role] };
    seen.set(k, entry); out.push(entry);
  };
  const changeOn = event === 'scheduled' || settings.emailChanges;
  const cand = app.candidate;
  if (cand) add({ key: 'candidate', role: 'Candidate', name: cand.name, email: cand.email, kind: 'candidate', on: settings.emailCandidate && changeOn });
  // interviewers: the panel (staff logins + outside people), else the user named in the interviewer text
  // eslint-disable-next-line global-require
  const PANEL = require('./interviewPanel');
  const round = app.interviewRound || 1;
  const staff = await PANEL.panelStaff(app.id, round).catch(() => []);
  const outside = await PANEL.panelExternal(app.id, round).catch(() => []);
  staff.forEach((u) => add({ key: `user:${u.id}`, role: 'Interviewer', name: u.name, email: u.email, kind: 'staff', on: settings.emailInterviewer && changeOn }));
  outside.forEach((x) => add({ key: `ext:${String(x.email).toLowerCase()}`, role: 'Interviewer', name: x.name, email: x.email, kind: 'staff', on: settings.emailInterviewer && changeOn }));
  if (!staff.length && !outside.length) {
    const names = String(app.interviewer || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length) {
      const users = await prisma.user.findMany({ where: { name: { in: names }, status: 'Active' }, select: { id: true, name: true, email: true } }).catch(() => []);
      users.forEach((u) => add({ key: `user:${u.id}`, role: 'Interviewer', name: u.name, email: u.email, kind: 'staff', on: settings.emailInterviewer && changeOn }));
    }
  }
  // THE CLIENT TOO (founder 2026-10-26: "bde interview schedule chestharu, client ki, candidate ki kalipi"): the client's recruitment
  // contact (else the main contact) gets the same invite. Never on a TeamLink internal job.
  {
    const r = app.requirement || {};
    const c = r.client;
    const em = c && !r.internal ? String(c.recruitmentContactEmail || c.contactEmail || '').trim() : '';
    if (em) add({ key: 'client', role: 'Client', name: c.recruitmentContactName || c.contactName || c.name, email: em, kind: 'staff', on: settings.emailClient && changeOn });
  }
  if (settings.copyTeam) {
    const r = app.requirement || {};
    const ids = [...new Set([actor && actor.id, r.tlId, r.bdeId].filter(Boolean))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true, name: true, email: true } }) : [];
    users.forEach((u) => add({ key: `copy:${u.id}`, role: 'Copy', name: u.name, email: u.email, kind: 'staff', on: changeOn }));
  }
  return out.map((e) => ({ ...e, role: e.roles.join(' + ') }));
}

// ---- the record ---------------------------------------------------------------------------------------------------------
async function readRecord(appId) {
  const row = await prisma.appSetting.findUnique({ where: { key: `${MAIL_PREFIX}${appId}` } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return { sequence: Number.isInteger(v.sequence) ? v.sequence : -1, event: v.event || null, at: v.at || null, rows: Array.isArray(v.rows) ? v.rows : [], by: v.by || null };
}
async function writeRecord(appId, rec, actor) {
  const who = actor ? { updatedById: actor.id, updatedByName: actor.name } : {};
  const value = JSON.stringify(rec);
  await prisma.appSetting.upsert({
    where: { key: `${MAIL_PREFIX}${appId}` },
    create: { key: `${MAIL_PREFIX}${appId}`, value, ...who },
    update: { value, ...who },
  });
}

let MAILER = null; // tests inject a fake: (msg) => { ok, error?, notConfigured? }
function setMailer(fn) { MAILER = fn || null; }
const sendOne = (msg) => (MAILER ? MAILER(msg) : require('./mailer').sendMail(msg)); // eslint-disable-line global-require

async function noteCandidateMessage(app, event, row, subject, body, actor) {
  try {
    const cand = app.candidate;
    await prisma.candidateMessage.create({
      data: {
        candidateId: cand.id, applicationId: app.id, channel: 'Email', template: `INTERVIEW_${event.toUpperCase()}`, templateLabel: subject, trigger: `Interview: ${subject}`,
        recipient: cand.email || '', subject, body,
        status: row.status === 'sent' ? 'SENT' : (row.notConfigured ? 'NOT_SENT_NO_PROVIDER' : (row.status === 'off' ? 'NOT_SENT_SWITCHED_OFF' : 'FAILED')),
        statusDetail: row.status === 'sent' ? 'Sent with a calendar invite.' : `Email not sent: ${row.detail}`,
        senderUserId: actor ? actor.id : null, senderName: actor ? actor.name : 'TeamLink',
      },
    });
  } catch { /* the Communications note is a convenience */ }
}

// Sends (or re-sends) the invites. opts: { actor, fromSlot, reason, only: [keys], resend: bool }
// Returns { ok, notConfigured, rows, sent, failed, message }. Never throws.
async function sendInvites(appId, event, opts = {}) {
  const out = { ok: true, notConfigured: false, rows: [], sent: 0, failed: 0, message: '' };
  try {
    if (!WORDS[event]) return { ...out, ok: false, message: 'Unknown event.' };
    const app = await prisma.application.findUnique({ where: { id: appId }, include: APP_INCLUDE });
    if (!app || !app.interviewAt) return { ...out, ok: false, message: 'No interview on this application.' };
    const settings = await loadSettings();
    const actor = opts.actor || null;
    const prev = await readRecord(appId);
    const sequence = opts.resend ? Math.max(prev.sequence, 0) : prev.sequence + 1;
    const recs = await recipientsOf(app, event, settings, actor);
    const organizer = { name: (actor && actor.name) || 'TeamLink', email: actor && actor.email ? actor.email : null };
    const rows = [];
    for (const rc of recs) {
      if (opts.only && !opts.only.includes(rc.key)) continue;
      const base = { key: rc.key, role: rc.role, name: rc.name, toMasked: maskEmail(rc.email), event, at: new Date().toISOString() };
      let row;
      if (!rc.on) row = { ...base, status: 'off', detail: REASONS.switchedOff };
      else if (!rc.email) row = { ...base, status: 'not_sent', detail: REASONS.noAddress };
      else if (skipPerson(`${rc.name} ${rc.email}`)) row = { ...base, status: 'not_sent', detail: REASONS.testAddress };
      else {
        const m = rc.kind === 'candidate' ? candidateMail(app, event, opts) : staffMail(app, event, { ...opts, askName: actor && actor.name }, rc.role.includes('Interviewer') ? 'Interviewer' : 'Copy');
        const ics = buildIcs({
          app, method: WORDS[event].cancel ? 'CANCEL' : 'REQUEST', sequence, summary: WORDS[event].cancel ? `Cancelled: ${m.summary}` : m.summary, description: m.description, organizer, attendee: { name: rc.name, email: rc.email },
        });
        // eslint-disable-next-line no-await-in-loop
        const r = await sendOne({
          to: rc.email, subject: m.subject, text: m.text, useEmployeeFrom: false, fromName: 'TeamLink Interviews', senderEmail: organizer.email || undefined,
          attachments: [{ filename: 'interview.ics', content: ics, contentType: `text/calendar; charset=utf-8; method=${WORDS[event].cancel ? 'CANCEL' : 'REQUEST'}` }],
        }).catch((err) => ({ ok: false, error: err.message }));
        if (r && r.ok) row = { ...base, status: 'sent', detail: 'Email sent with a calendar invite' };
        else row = { ...base, status: 'not_sent', detail: plainReason(r || {}), notConfigured: !!(r && r.notConfigured) };
        if (rc.kind === 'candidate') {
          // eslint-disable-next-line no-await-in-loop
          await noteCandidateMessage(app, event, row, m.subject, m.text, actor);
        }
      }
      rows.push(row);
    }
    // keep the latest result per recipient (a resend only replaces the rows it touched)
    const merged = new Map((opts.only || opts.resend ? prev.rows : []).map((x) => [x.key, x]));
    rows.forEach((x) => merged.set(x.key, x));
    await writeRecord(appId, { sequence, event, at: new Date().toISOString(), by: actor ? actor.name : 'TeamLink', rows: [...merged.values()] }, actor);
    out.rows = rows;
    out.sent = rows.filter((x) => x.status === 'sent').length;
    out.failed = rows.filter((x) => x.status === 'not_sent').length;
    out.notConfigured = rows.some((x) => x.notConfigured);
    out.message = summaryLine(rows, out);
    try {
      // eslint-disable-next-line global-require
      await require('./audit').logAudit({
        userId: actor ? actor.id : null, actorName: actor ? actor.name : 'TeamLink', action: `Interview email (${event})${opts.resend ? ' - resent' : ''}`, entity: 'Application', entityId: appId,
        toValue: rows.map((x) => `${x.role} ${x.toMasked || '-'}: ${x.status}${x.status === 'sent' ? '' : ` (${x.detail})`}`).join(' | ').slice(0, 900),
      });
    } catch { /* audit never blocks */ }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[interviewMeet] could not send invites:', err.message);
    return { ...out, ok: false, message: 'The interview emails could not be sent. The booking is saved.' };
  }
  return out;
}

function summaryLine(rows, out) {
  if (!rows.length) return 'No email was needed.';
  if (out.notConfigured) return 'The interview is saved, but no email went out: mail is not set up. Ask your Admin to set it up in Administration > Integrations > Email.';
  const parts = [];
  if (out.sent) parts.push(`Email sent to ${out.sent} ${out.sent === 1 ? 'person' : 'people'}`);
  const bad = rows.filter((x) => x.status === 'not_sent');
  if (bad.length) parts.push(`not sent to ${bad.map((x) => `${x.name || x.role} (${x.detail})`).join(', ')}`);
  const off = rows.filter((x) => x.status === 'off');
  if (off.length && !out.sent && !bad.length) parts.push('emails are switched off in Settings');
  return `${parts.join('; ')}.`;
}

// What the card shows: latest result per recipient.
async function mailStatus(appId) {
  const rec = await readRecord(appId);
  return { event: rec.event, at: rec.at, by: rec.by, rows: rec.rows.map((x) => ({ key: x.key, role: x.role, name: x.name, toMasked: x.toMasked, status: x.status, detail: x.detail, at: x.at, event: x.event })) };
}

async function removeRecord(appId) {
  await prisma.appSetting.deleteMany({ where: { key: `${MAIL_PREFIX}${appId}` } }).catch(() => null);
}

// ---- Start interview ------------------------------------------------------------------------------------------------------
const STARTABLE = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'STARTED'];
const isAdminUser = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.atsRole);
async function startCtx(user) {
  const { can } = require('./permissions'); // eslint-disable-line global-require
  const bdeTeam = (await can(user, 'ats', 'interviews', 'Schedule Interview', 'create').catch(() => false)) || (await can(user, 'ats', 'interviews', 'Schedule Interview', 'edit').catch(() => false));
  return { admin: isAdminUser(user), bdeTeam: !!bdeTeam, settings: await loadSettings() };
}
function isNamedInterviewer(user, app, panelUserIds) {
  if ((panelUserIds || []).includes(user.id)) return true;
  const names = String(app.interviewer || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.includes(String(user.name || '').trim().toLowerCase());
}
function mayStart(ctx, user, app, panelUserIds) {
  if (ctx.admin || ctx.bdeTeam) return true;
  if (isNamedInterviewer(user, app, panelUserIds)) return true;
  if (app.interviewCreatedBy && String(app.interviewCreatedBy).trim().toLowerCase() === String(user.name || '').trim().toLowerCase()) return true;
  const r = app.requirement || {};
  return !!r.tlId && r.tlId === user.id;
}
// -> { show, can, reason, needsLink, label, online }
function startState(ctx, user, app, panelUserIds, now = new Date()) {
  if (!app || !app.interviewStatus || !STARTABLE.includes(app.interviewStatus) || !app.interviewAt) return { show: false, can: false };
  if (!mayStart(ctx, user, app, panelUserIds)) return { show: false, can: false };
  const online = isOnline(app);
  const started = app.interviewStatus === 'STARTED';
  const at = new Date(app.interviewAt).getTime();
  const t = now.getTime();
  const { startBeforeMin: b, startAfterMin: a } = ctx.settings;
  let reason = null;
  if (!ctx.admin && !started) {
    if (t < at - b * 60000) reason = `Opens ${b} minutes before the interview`;
    else if (t > at + a * 60000) reason = `The start time is over (${a / 60 >= 1 ? `${Math.round((a / 60) * 10) / 10} hours` : `${a} minutes`} after the start). Ask an Admin.`;
  }
  const needsLink = online && !app.interviewMeetingLink;
  return {
    show: true, can: !reason, reason, needsLink, online, started,
    label: reason ? 'Start interview' : (needsLink ? 'Add the Meet link first' : (started ? (online ? 'Join Meet' : 'Interview started') : 'Start interview')),
    opensInMin: reason && t < at - b * 60000 ? Math.ceil((at - b * 60000 - t) / 60000) : null,
  };
}

module.exports = {
  KEY, MAIL_PREFIX, DEFAULTS, loadSettings, saveSettings, checkLink, maskEmail, buildIcs, icsUid, candidateMail, staffMail, sendInvites, mailStatus, removeRecord,
  setMailer, startCtx, startState, mayStart, isNamedInterviewer, readRecord, plainReason, isAdminUser, STARTABLE, isOnline,
};

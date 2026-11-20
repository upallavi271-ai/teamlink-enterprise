// ---------------------------------------------------------------------------
// SCHEDULE A MESSAGE (founder 2026-11-20: "not only the interview / joining reminders: there must be an option to schedule ANY kind of message.
// In ATS, on the candidate's profile give a 'Schedule a message' tab").
//
//   A recruiter / team lead writes ANY message to ONE candidate and schedules it for a later date and time, on WhatsApp, SMS or Email.
//   It is a row of the SAME raw table as the automatic reminders ("ScheduledReminder", kind 'custom': no new table) and is sent by the SAME
//   worker (utils/scheduledReminders.run, every 5 minutes on the real server) through the same sender (utils/messaging.send with the CRM's
//   WhatsApp 24-hour-window / general-template rule, credits + the Omni ledger, delivery ticks, 3 tries with back-off).
//
//   THE ONE BEHAVIOUR DECISION: a manual message is a deliberate human action, so it is sent when it is due EVEN WHILE the Admin switch for the
//   automatic interview / joining reminders is OFF. It still respects: STOP / do-not-contact / withdrawn consent (refused when scheduling and
//   again when sending), the sending hours (07:00-20:00 India time: the Admin's hours of the reminders), the person's credits, the sandbox
//   (nothing real is sent on the test server), the 3 tries, and every row says what happened (status + reason).
//
//   RULES at scheduling: the time is at least 5 minutes ahead and inside the sending hours (otherwise refused with the nearest allowed time);
//   at most 20 waiting messages per candidate; the words are required (max 1000 characters); an email needs the candidate's email address,
//   WhatsApp / SMS the mobile number; the channel must be connected. Placeholders {name} {recruiter} {company} {requirement} {client} are
//   filled when the message is SENT (the client is never named unless an Admin allowed it for reminders: "our client").
//   WHO: recruiter - own candidates; TL / STL / Manager / Admin - their team; the BDE side sees only the COUNT, never the words, and cannot
//   schedule; client and candidate logins nothing. Every create / edit / cancel is audited.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const SR = require('./scheduledReminders');

const CHANNELS = ['WhatsApp', 'SMS', 'Email'];
const MAX_PLANNED = 20;
const MAX_BODY = 1000;
const MAX_SUBJECT = 150;
const MIN_AHEAD_MIN = 5;
const MAX_AHEAD_DAYS = 365;
const DEFAULT_SUBJECT = 'A message from TeamLink';
const STOP_FOOTER = 'Reply STOP to stop these messages.';
const FOOTER = { WhatsApp: STOP_FOOTER, SMS: STOP_FOOTER, Email: '' };

const PLACEHOLDERS = [
  ['name', 'Candidate first name'],
  ['recruiter', 'Your name (who scheduled the message)'],
  ['company', 'TeamLink'],
  ['requirement', 'Job title of the candidate\'s application'],
  ['client', 'The client ("our client" unless an Admin allows naming it)'],
];
const KNOWN = new Set(PLACEHOLDERS.map((p) => p[0]));
const TEMPLATES = [
  { key: 'callback', label: 'Follow-up call-back', subject: 'Please call me back', body: 'Hi {name}, this is {recruiter} from {company}. I tried to reach you earlier. Please call me back when you are free.' },
  { key: 'documents', label: 'Document request', subject: 'Documents needed for {requirement}', body: 'Hi {name}, this is {recruiter} from {company}. For {requirement}, please send me your updated resume, ID proof and your education and experience certificates.' },
  { key: 'interview', label: 'Interview details', subject: 'Your interview for {requirement}', body: 'Hi {name}, your interview for {requirement} is confirmed. Date and time: [write date and time]. Place or link: [write place or link]. Please carry your ID proof and updated resume. - {recruiter}, {company}' },
  { key: 'thanks', label: 'Thank you', subject: 'Thank you', body: 'Hi {name}, thank you for your time and for attending the interview for {requirement}. We will share the update as soon as we hear back from {client}. - {recruiter}, {company}' },
];

const { q, x, nowIso, newId, istMinutes, istDay, atIst, addHistory, stamp, txt, MIN, DAY } = SR.internals;
const txtML = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
const who = (u) => (u && u.name) || 'System';

// ------------------------------------------------------------------ the words
function fill(text, ctx) {
  return String(text || '').replace(/\{([a-z_]+)\}/gi, (m, n) => {
    const k = n.toLowerCase();
    return KNOWN.has(k) ? String(ctx[k] == null ? '' : ctx[k]) : m;
  });
}
function unknownPlaceholders(text) {
  return [...new Set([...String(text || '').matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1].toLowerCase()).filter((n) => !KNOWN.has(n)))];
}
const APP_INCLUDE = { requirement: { include: { client: true } } };
// the values of the placeholders: the named application (must be this candidate's), else the candidate's latest one
async function contextFor(cand, applicationId, creatorName, settings) {
  let app = null;
  if (applicationId) app = await prisma.application.findFirst({ where: { id: String(applicationId), candidateId: cand.id }, include: APP_INCLUDE });
  if (!app) app = await prisma.application.findFirst({ where: { candidateId: cand.id }, orderBy: { createdAt: 'desc' }, include: APP_INCLUDE });
  const r = (app && app.requirement) || null;
  const named = r && !r.internal && settings && settings.nameClient && r.client && r.client.name;
  return {
    name: txt(cand.name, 80).split(' ')[0] || 'there',
    recruiter: creatorName || 'TeamLink',
    company: 'TeamLink',
    requirement: (r && txt(r.title, 120)) || 'the role',
    client: r && r.internal ? 'TeamLink' : (named ? r.client.name : 'our client'),
    applicationId: app ? app.id : null,
  };
}
// what really goes: the words with the placeholders filled, and the STOP line for WhatsApp / SMS
const finalText = (channel, body, ctx) => [fill(body, ctx).trim(), FOOTER[channel] || ''].filter(Boolean).join('\n\n');

// ------------------------------------------------------------------ who may do what
async function accessOf(user, candidateId) {
  const P = require('./permissions'); // eslint-disable-line global-require
  if (!user || P.isExternalLogin(user)) return { status: 403, error: 'Not available to this login.' };
  const { candidateWhere } = require('./scope'); // eslint-disable-line global-require
  const cand = await prisma.candidate.findFirst({
    where: { AND: [{ id: String(candidateId || '') }, candidateWhere(user)] },
    select: { id: true, name: true, phone: true, email: true, doNotContact: true, consentStatus: true },
  });
  if (!cand) return { status: 404, error: 'Candidate not found.' };
  const admin = SR.internals.isAdminLogin(user);
  if (!admin && SR.internals.bdeSide(user)) return { cand, level: 'count', canCreate: false };
  const role = P.stageRoleOf(user);
  if (admin || ['TL', 'STL', 'RECRUITER', 'MANAGER'].includes(role)) return { cand, level: 'full', canCreate: true };
  return { status: 403, error: 'Scheduled messages are for recruiters and team leads.' };
}

// ------------------------------------------------------------------ the checks
const suggestion = (t, lo, hi) => {
  const m = istMinutes(t);
  const day = istDay(t);
  const at = m < lo ? atIst(day, hmOf(lo)) : atIst(istDay(new Date(new Date(t).getTime() + DAY)), hmOf(lo));
  return { sendAt: at.toISOString(), words: stamp(at) };
};
const hmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function checkTime(sendAtRaw, settings, now = new Date()) {
  const t = new Date(sendAtRaw);
  if (!sendAtRaw || Number.isNaN(t.getTime())) return { status: 400, error: 'Pick the date and time when the message should go.' };
  if (t.getTime() < now.getTime() + MIN_AHEAD_MIN * MIN) return { status: 400, error: `Pick a time at least ${MIN_AHEAD_MIN} minutes from now.` };
  if (t.getTime() > now.getTime() + MAX_AHEAD_DAYS * DAY) return { status: 400, error: 'Pick a time within the next year.' };
  const lo = settings.earliestHour * 60;
  const hi = settings.latestHour * 60;
  const m = istMinutes(t);
  if (m < lo || m > hi) {
    const s = suggestion(t, lo, hi);
    return { status: 400, error: `Messages go between ${hmOf(lo)} and ${hmOf(hi)} India time. The nearest allowed time is ${s.words}.`, suggestion: s };
  }
  return { t };
}
// the words / channel / contact / opt-out checks shared by create and edit. `cand` has phone, email, flags.
async function checkMessage(cand, { channel, subject, body }, settings) {
  if (!CHANNELS.includes(channel)) return { status: 400, error: 'Pick WhatsApp, SMS or Email.' };
  const text = txtML(body, MAX_BODY + 1);
  if (!text) return { status: 400, error: 'Write the message first.' };
  if (text.length > MAX_BODY) return { status: 400, error: `The message is too long: the most is ${MAX_BODY} characters.` };
  const bad = unknownPlaceholders(text);
  if (bad.length) return { status: 400, error: `These placeholders are not known: ${bad.map((b) => `{${b}}`).join(', ')}. Use ${PLACEHOLDERS.map((p) => `{${p[0]}}`).join(' ')}.` };
  if (/\[write [^\]]*\]/i.test(text)) return { status: 400, error: 'Fill in the [write ...] parts of the message before you schedule it.' };
  const subj = txt(subject, MAX_SUBJECT + 1);
  const badSubject = unknownPlaceholders(subj);
  if (badSubject.length) return { status: 400, error: `These placeholders are not known in the subject: ${badSubject.map((n) => `{${n}}`).join(', ')}.` };
  if (subj.length > MAX_SUBJECT) return { status: 400, error: `The subject is too long: the most is ${MAX_SUBJECT} characters.` };
  // not to be contacted: refused here with the reason, and again when sending
  if (cand.doNotContact) return { status: 409, error: `${cand.name} asked not to be contacted (do not contact), so no message can be scheduled.` };
  if (cand.consentStatus === 'WITHDRAWN') return { status: 409, error: `${cand.name} withdrew consent, so no message can be scheduled.` };
  const core = require('./messagingCore'); // eslint-disable-line global-require
  if (channel === 'Email') {
    if (!cand.email || !core.validEmail(cand.email)) return { status: 409, error: 'This candidate has no email address, so an email cannot be scheduled.' };
  } else {
    const m = cand.phone ? core.normalizeMobile(cand.phone) : { ok: false };
    if (!m.ok) return { status: 409, error: 'This candidate has no valid mobile number, so a WhatsApp or SMS message cannot be scheduled.' };
    if (await require('./messageDelivery').optedOut(channel, m.e164)) return { status: 409, error: `${cand.name} replied STOP on ${channel}, so nothing more can be sent there.` }; // eslint-disable-line global-require
  }
  const chs = await SR.channelsFor(cand, settings);
  const c = chs.find((o) => o.channel === channel);
  if (!c.ready) return { status: 409, error: `${channel} is not connected yet, so it cannot be used (${String(c.reason || '').replace(/^Not ready: /, '') || 'ask an Admin'}).` };
  return { text, subj };
}
async function whatsappWarning(cand, channel) {
  if (channel !== 'WhatsApp') return '';
  try {
    const core = require('./messagingCore'); // eslint-disable-line global-require
    const m = core.normalizeMobile(cand.phone);
    if (!m.ok) return '';
    const open = await require('./waNumbers').windowOpenSystem(m.e164).catch(() => false); // eslint-disable-line global-require
    if (open) return '';
    return 'This candidate has not written to us on WhatsApp in the last 24 hours, so WhatsApp delivers this message only through the company\'s approved general template. If your WhatsApp is not set up for that, the message will show as failed with the reason.';
  } catch { return ''; }
}

// ------------------------------------------------------------------ rows
function shape(r, full = true) {
  let history = [];
  try { history = JSON.parse(r.history || '[]'); } catch { history = []; }
  return {
    id: r.id, kind: 'custom', automatic: false, candidateId: r.candidateId, applicationId: r.applicationId || null, channel: r.channel, sendAt: r.sendAt,
    status: r.status === 'sending' ? 'planned' : r.status, reason: r.reason,
    ...(full ? { subject: r.subject || '', body: r.body || '', text: r.message || null, history } : {}),
    createdBy: r.createdBy, editedBy: r.editedBy, createdAt: r.createdAt, updatedAt: r.updatedAt, sentAt: r.sentAt, deliveryStatus: r.deliveryStatus,
    attempts: Number(r.attempts) || 0, nextAttemptAt: r.nextAttemptAt,
  };
}
const customRows = (candidateId) => q('SELECT * FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "candidateId" = ? ORDER BY "sendAt"', String(candidateId));

// ------------------------------------------------------------------ reading
async function list(user, candidateId, { applicationId = null } = {}) {
  await SR.ensure();
  const acc = await accessOf(user, candidateId);
  if (acc.error) return acc;
  const { cand } = acc;
  const settings = await SR.loadSettings();
  const rows = await customRows(cand.id);
  const counts = { planned: 0, sent: 0, failed: 0, cancelled: 0, skipped: 0, total: rows.length };
  rows.forEach((r) => {
    const s = r.status === 'sending' ? 'planned' : (r.status === 'delivered' ? 'sent' : r.status);
    if (s in counts) counts[s] += 1;
  });
  // the automatic interview / joining reminders of this person (read-only here): one place to see everything scheduled
  const panels = await SR.listForCandidate(user, cand.id).catch(() => []);
  const autoCount = panels.reduce((n, p) => n + ['interview', 'joining'].reduce((m, k) => m + ((p.kinds[k] && p.kinds[k].counts.total) || 0), 0), 0);
  if (acc.level === 'count') {
    return { status: 200, access: 'count', canCreate: false, candidate: { id: cand.id, name: cand.name }, counts, automaticCount: autoCount, note: 'Only the number of messages is shown to your team. The recruiter and the team lead see the words.' };
  }
  const apps = await prisma.application.findMany({ where: { candidateId: cand.id }, select: { id: true, requirement: { select: { title: true } } }, orderBy: { createdAt: 'desc' } });
  const titleOf = new Map(apps.map((a) => [a.id, a.requirement && a.requirement.title]));
  const automatic = [];
  panels.forEach((p) => ['interview', 'joining'].forEach((k) => {
    const kb = p.kinds[k];
    (kb && kb.rows ? kb.rows : []).forEach((r) => automatic.push({
      id: r.id, kind: k, automatic: true, applicationId: p.applicationId, role: titleOf.get(p.applicationId) || null, label: `${k === 'joining' ? 'Joining' : 'Interview'} reminder (${r.label})`,
      sendAt: r.sendAt, channel: r.channel, status: r.status, reason: r.reason, text: r.text, deliveryStatus: r.deliveryStatus,
    }));
  }));
  const ctx = await contextFor(cand, applicationId, who(user), settings);
  const chs = await SR.channelsFor(cand, settings);
  const channels = chs.map((c) => ({
    channel: c.channel, offered: c.ready && c.hasContact,
    reason: !c.hasContact ? `No ${c.channel === 'Email' ? 'email address' : 'mobile number'} on this candidate` : (!c.ready ? `Not connected${c.reason ? ` (${String(c.reason).replace(/^Not ready: /, '')})` : ''}` : ''),
  }));
  const blocked = cand.doNotContact ? 'This candidate asked not to be contacted: no message can be scheduled.' : (cand.consentStatus === 'WITHDRAWN' ? 'This candidate withdrew consent: no message can be scheduled.' : '');
  return {
    status: 200, access: 'full', canCreate: true, blocked,
    candidate: { id: cand.id, name: cand.name, firstName: ctx.name },
    context: { name: ctx.name, recruiter: ctx.recruiter, company: ctx.company, requirement: ctx.requirement, client: ctx.client, applicationId: ctx.applicationId },
    messages: rows.map((r) => shape(r)), automatic, counts, channels, templates: TEMPLATES, placeholders: PLACEHOLDERS.map(([key, label]) => ({ key, label })), footer: FOOTER,
    hours: { earliest: settings.earliestHour, latest: settings.latestHour }, max: MAX_PLANNED, maxLength: MAX_BODY, minAheadMinutes: MIN_AHEAD_MIN,
    autoSwitchOn: settings.enabled,
    note: 'A message you schedule here goes at its time even when the automatic interview / joining reminders are switched off.',
  };
}

// ------------------------------------------------------------------ creating / editing / cancelling
async function create(user, candidateId, b = {}) {
  await SR.ensure();
  const acc = await accessOf(user, candidateId);
  if (acc.error) return acc;
  if (!acc.canCreate) return { status: 403, error: 'Your team sees only the number of scheduled messages. The recruiter or the team lead schedules them.' };
  const { cand } = acc;
  const settings = await SR.loadSettings();
  const channel = b.channel;
  const m = await checkMessage(cand, { channel, subject: b.subject, body: b.body }, settings);
  if (m.error) return m;
  const tm = checkTime(b.sendAt, settings);
  if (tm.error) return tm;
  const planned = await q('SELECT COUNT(*) AS n FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "candidateId" = ? AND "status" IN (\'planned\',\'sending\')', cand.id);
  if (Number(planned[0].n) >= MAX_PLANNED) return { status: 409, error: `There are already ${MAX_PLANNED} messages waiting for this candidate. Cancel one or wait until some are sent.` };
  const iso = tm.t.toISOString();
  const dup = await q('SELECT "id" FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "candidateId" = ? AND "channel" = ? AND "sendAt" = ? AND "body" = ? AND "status" IN (\'planned\',\'sending\') LIMIT 1', cand.id, channel, iso, m.text);
  if (dup.length) return { status: 409, error: 'This same message is already scheduled for that time.' };
  let applicationId = '';
  if (b.applicationId) {
    const { applicationWhere } = require('./scope'); // eslint-disable-line global-require
    const app = await prisma.application.findFirst({ where: { id: String(b.applicationId), candidateId: cand.id, ...applicationWhere(user) }, select: { id: true } });
    if (!app) return { status: 400, error: 'That application is not one of this candidate\'s.' };
    applicationId = app.id;
  }
  const id = newId();
  const t = nowIso();
  const history = JSON.stringify([{ at: t, by: who(user), text: `Scheduled for ${stamp(iso)} by ${channel}` }]);
  await x(`INSERT INTO "ScheduledReminder" ("id","applicationId","candidateId","kind","eventAt","sendAt","channel","templateKey","language","status","stepKey","createdById","createdBy","createdAt","updatedAt","notifyIds","history","subject","body")
    VALUES (?,?,?,'custom',?,?,?,'custom',?,'planned','MSG',?,?,?,?,?,?,?,?)`,
  id, applicationId, cand.id, iso, iso, channel, ['en', 'te'].includes(b.language) ? b.language : 'en', user.id, who(user), t, t, user.id, history, channel === 'Email' ? (m.subj || DEFAULT_SUBJECT) : null, m.text);
  await logAudit({ userId: user.id, actorName: who(user), action: 'Message scheduled to candidate', entity: 'Candidate', entityId: cand.id, toValue: `${channel} on ${stamp(iso)}: ${m.text.slice(0, 120)}`.slice(0, 300) }).catch(() => {});
  const [row] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', id);
  return { status: 201, message: shape(row), warning: await whatsappWarning(cand, channel) };
}

async function loadRow(user, id) {
  await SR.ensure();
  const [r] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ? AND "kind" = \'custom\'', String(id));
  if (!r) return { status: 404, error: 'That message is not there.' };
  const acc = await accessOf(user, r.candidateId);
  if (acc.error) return { status: acc.status === 404 ? 404 : acc.status, error: acc.status === 404 ? 'That message is not there.' : acc.error };
  if (!acc.canCreate) return { status: 403, error: 'Your team sees only the number of scheduled messages.' };
  return { r, cand: acc.cand };
}

async function edit(user, id, b = {}) {
  const got = await loadRow(user, id);
  if (got.error) return got;
  const { r, cand } = got;
  if (r.status !== 'planned') return { status: 409, error: r.status === 'cancelled' ? 'This message was cancelled.' : (r.status === 'sending' ? 'This message is going out right now.' : 'This message has already been handled and cannot be changed. Schedule a new one instead.') };
  const settings = await SR.loadSettings();
  const next = {
    channel: b.channel !== undefined ? b.channel : r.channel,
    body: b.body !== undefined ? b.body : r.body,
    subject: b.subject !== undefined ? b.subject : r.subject,
    sendAt: b.sendAt !== undefined ? b.sendAt : r.sendAt,
  };
  if (b.body === undefined && b.channel === undefined && b.subject === undefined && b.sendAt === undefined) return { status: 400, error: 'Nothing to change.' };
  const m = await checkMessage(cand, next, settings);
  if (m.error) return m;
  const timeChanged = b.sendAt !== undefined && (Number.isNaN(new Date(b.sendAt).getTime()) || new Date(b.sendAt).toISOString() !== r.sendAt);
  let iso = r.sendAt;
  if (timeChanged) {
    const tm = checkTime(b.sendAt, settings);
    if (tm.error) return tm;
    iso = tm.t.toISOString();
  } else if (Date.parse(r.sendAt) < Date.now() + 1000) {
    return { status: 400, error: 'The time of this message has come: pick a new time to change it.' };
  }
  const notes = [];
  if (timeChanged) notes.push(`Time changed to ${stamp(iso)} (was ${stamp(r.sendAt)})`);
  if (next.channel !== r.channel) notes.push(`Way changed to ${next.channel}`);
  if (m.text !== (r.body || '')) notes.push('Words changed');
  if (next.channel === 'Email' && (m.subj || DEFAULT_SUBJECT) !== (r.subject || '')) notes.push('Subject changed');
  if (!notes.length) return { status: 400, error: 'Nothing to change.' };
  const claimed = await x('UPDATE "ScheduledReminder" SET "sendAt" = ?, "eventAt" = ?, "channel" = ?, "body" = ?, "subject" = ?, "reason" = NULL, "attempts" = 0, "nextAttemptAt" = NULL, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ? AND "status" = \'planned\'',
    iso, iso, next.channel, m.text, next.channel === 'Email' ? (m.subj || DEFAULT_SUBJECT) : null, user.id, who(user), nowIso(), addHistory(r, who(user), notes.join('; ')), r.id);
  if (!claimed) return { status: 409, error: 'This message has just been handled and cannot be changed.' };
  await logAudit({ userId: user.id, actorName: who(user), action: 'Scheduled message changed', entity: 'Candidate', entityId: cand.id, toValue: notes.join('; ').slice(0, 300) }).catch(() => {});
  const [row] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
  return { status: 200, message: shape(row), warning: await whatsappWarning(cand, next.channel) };
}

async function cancel(user, id, reason) {
  const got = await loadRow(user, id);
  if (got.error) return got;
  const { r, cand } = got;
  if (r.status !== 'planned') return { status: 409, error: r.status === 'cancelled' ? 'This message is already cancelled.' : (r.status === 'sending' ? 'This message is going out right now.' : 'This message has already been handled, so it cannot be cancelled.') };
  const why = txt(reason, 200);
  const text = `Cancelled by ${who(user)}${why ? `: ${why}` : ''}`;
  const done = await x('UPDATE "ScheduledReminder" SET "status" = \'cancelled\', "reason" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ? AND "status" = \'planned\'',
    text, user.id, who(user), nowIso(), addHistory(r, who(user), text), r.id);
  if (!done) return { status: 409, error: 'This message has just been handled, so it cannot be cancelled.' };
  await logAudit({ userId: user.id, actorName: who(user), action: 'Scheduled message cancelled', entity: 'Candidate', entityId: cand.id, reason: why || undefined, toValue: `${r.channel} on ${stamp(r.sendAt)}`.slice(0, 300) }).catch(() => {});
  const [row] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
  return { status: 200, message: shape(row) };
}

// ------------------------------------------------------------------ sending (called by scheduledReminders.run)
async function failBell(row, reason) {
  try {
    const ids = String(row.notifyIds || row.createdById || '').split(',').filter(Boolean);
    const c = await prisma.candidate.findUnique({ where: { id: String(row.candidateId) }, select: { name: true } });
    const name = (c && c.name) || 'Candidate';
    await SR.internals.bell(ids, {
      title: `Scheduled message NOT sent: ${name}`,
      message: `Your ${row.channel} message to ${name} (scheduled for ${stamp(row.sendAt)}) was not sent: ${reason}`,
      key: `schedmsg|fail|${row.id}`, open: `/candidates/${row.candidateId}?tab=scheduled`,
    });
  } catch { /* the bell is a courtesy */ }
}
async function logToCandidate(row, cand, text, subject, res) {
  try {
    await prisma.candidateMessage.create({
      data: {
        candidateId: row.candidateId, applicationId: row.applicationId || null, channel: row.channel, template: 'SCHEDULED_MESSAGE', templateLabel: 'Scheduled message',
        trigger: 'Scheduled message', recipient: row.channel === 'Email' ? (cand.email || '') : (cand.phone || ''), subject: row.channel === 'Email' ? subject : null, body: text,
        status: 'SENT', statusDetail: `Accepted by the provider${res && res.response ? ` - ${String(res.response).slice(0, 200)}` : ''}`, providerRef: res.providerRef || null, sentAt: new Date(), attempts: 1,
        senderUserId: row.createdById || null, senderName: row.createdBy || 'TeamLink',
      },
    });
  } catch { /* the log line is a courtesy */ }
}

// One due row. -> { kind: 'none'|'deferred'|'sent'|'failed'|'skipped'|'retried', status, reason, sent }
async function runRow(r, { now = new Date(), settings } = {}) {
  const I = SR.internals;
  const t = now.getTime();
  const due = Date.parse(r.sendAt) <= t && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= t);
  if (!due) return { kind: 'none' };
  const st = settings || await SR.loadSettings();
  const skip = async (why) => { await I.setStatus(r.id, 'skipped', why); await failBell(r, why); return { kind: 'skipped', status: 'skipped', reason: why }; };
  // too late (the server was down): not sent any more, and its person is told
  if (t - Date.parse(r.sendAt) > I.STALE_MS && !r.attempts) {
    const why = 'Too late to send: its time passed more than 3 hours ago. Schedule it again.';
    await I.setStatus(r.id, 'skipped', why); await failBell(r, why);
    return { kind: 'skipped', status: 'skipped', reason: why };
  }
  const mm = istMinutes(now);
  if (mm < st.earliestHour * 60 || mm > st.latestHour * 60 + 5) return { kind: 'deferred' };
  const claimed = await x('UPDATE "ScheduledReminder" SET "status" = \'sending\', "updatedAt" = ? WHERE "id" = ? AND "status" = \'planned\'', nowIso(), r.id);
  if (!claimed) return { kind: 'none' };
  const cand = await prisma.candidate.findUnique({ where: { id: String(r.candidateId) } });
  if (!cand) return skip('The candidate is not there any more.');
  if (!I.sandboxOn() && (I.isTestPerson(cand.name) || I.isTestPerson(cand.email))) return skip('A test person: never messaged on the real server.');
  if (cand.doNotContact || cand.consentStatus === 'WITHDRAWN') return skip('The candidate asked not to be contacted.');
  const noContact = r.channel === 'Email' ? !cand.email : !cand.phone;
  if (noContact) {
    const why = `No ${r.channel === 'Email' ? 'email address' : 'mobile number'} on this candidate.`;
    await I.setStatus(r.id, 'failed', why); await failBell(r, why);
    return { kind: 'failed', status: 'failed', reason: why };
  }
  const ctx = await contextFor(cand, r.applicationId, r.createdBy, st);
  const text = finalText(r.channel, r.body, ctx);
  const subject = fill(r.subject || DEFAULT_SUBJECT, ctx);
  const messaging = require('./messaging'); // eslint-disable-line global-require
  const core = require('./messagingCore'); // eslint-disable-line global-require
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  const actor = r.createdById || undefined;
  const meta = { audience: 'candidates', personId: r.candidateId, senderUserId: actor, purpose: 'Scheduled message', template: 'custom', module: 'ATS' };
  let res;
  try {
    if (r.channel === 'WhatsApp') res = await I.whatsappSend(r, cand.phone, text, 'Scheduled message');
    else if (r.channel === 'SMS') {
      const proven = await I.smsProven();
      const to = core.normalizeMobile(cand.phone);
      if (!proven.ok) res = { ok: false, notConfigured: true, error: proven.why };
      else if (!to.ok) res = { ok: false, invalid: true, error: `The mobile number does not look right: ${to.reason}` };
      else if (await delivery.optedOut('SMS', to.e164)) res = { ok: false, optout: true, error: 'They replied STOP to our SMS, so nothing more is sent to them there.' };
      else res = await messaging.send('SMS', { to: to.e164, kind: 'bulk', text, vars: [text], actorUserId: actor, meta });
    } else res = await messaging.send('Email', { to: String(cand.email || '').trim(), subject, text, fromName: 'TeamLink', actorUserId: actor, meta });
  } catch (e) { res = { ok: false, transient: true, error: `Internal error: ${e.message}` }; }
  const attempts = (Number(r.attempts) || 0) + 1;
  if (res && res.ok) {
    await I.setStatus(r.id, 'sent', null, { sentAt: now.toISOString(), providerRef: res.providerRef || null, deliveryStatus: 'Sent', attempts, message: text, nextAttemptAt: null });
    await logToCandidate(r, cand, text, subject, res);
    return { kind: 'sent', status: 'sent', sent: true };
  }
  if (res && res.optout) return skip(I.WHY(res));
  if (res && res.transient && attempts < I.MAX_TRIES) {
    const wait = I.BACKOFF_MIN[Math.min(attempts - 1, I.BACKOFF_MIN.length - 1)];
    const [cur] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
    await x('UPDATE "ScheduledReminder" SET "status" = \'planned\', "attempts" = ?, "nextAttemptAt" = ?, "reason" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
      attempts, new Date(now.getTime() + wait * MIN).toISOString(), `Try ${attempts} of ${I.MAX_TRIES} failed: ${I.WHY(res)}`, nowIso(), addHistory(cur, 'System', `Try ${attempts} of ${I.MAX_TRIES} failed: ${I.WHY(res)}. Next try in ${wait} minutes`), r.id);
    return { kind: 'retried', status: 'planned', reason: I.WHY(res) };
  }
  const reason = `${I.WHY(res)}${attempts > 1 ? ` (after ${attempts} tries)` : ''}`;
  await I.setStatus(r.id, 'failed', reason, { attempts, nextAttemptAt: null });
  await failBell({ ...r, attempts }, reason);
  return { kind: 'failed', status: 'failed', reason };
}

module.exports = {
  CHANNELS, MAX_PLANNED, MAX_BODY, PLACEHOLDERS, TEMPLATES, FOOTER, DEFAULT_SUBJECT,
  accessOf, list, create, edit, cancel, runRow, failBell, fill, finalText, contextFor, checkTime, shape,
};

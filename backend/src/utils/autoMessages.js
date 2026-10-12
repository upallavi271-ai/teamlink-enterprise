// ---------------------------------------------------------------------------
// AUTOMATIC STAGE MESSAGES - THE SCHEDULING ENGINE (user, 2026-10-10).
//
//   handleStageMove()   called by utils/candidateComms.js recordStageCommunications() on EVERY step
//                       move (board drag, step popup, bulk move, interview booking, offer / joining
//                       automation, portal links). Until the rules were first saved (goLiveAt) it
//                       answers { handled: false } and the OLD code path runs untouched. After that
//                       it writes ONE ScheduledMessage row per step move (idempotent per stage event)
//                       and, for "right away", sends it at once.
//   processOne()        the single place a message is actually handed to the sending pipeline
//                       (CandidateMessage rows -> utils/mailWorker.js -> delivery webhooks), after the
//                       gates: kill switch, job / person overrides, test records, consent, "Candidate
//                       emails" switch, quiet hours, daily caps, duplicates, STOP, channel readiness.
//   processDue()        the sweep: reads the table, so a restart loses nothing.
//   startSweep()        real server only (the sandbox has no timers; tests call processDue()).
//
// THE ROWS: table ScheduledMessage (migration 20261010180000), read and written with plain SQL so it
// works before and after `prisma generate`. Until the table exists supported() is false and nothing
// here does anything. Dates are epoch milliseconds.
//
// HONEST STATES. SENT means "handed to the sending queue" with the CandidateMessage ids kept in
// resultJson; the list shows the live delivery state of those rows (Sent / Delivered / Failed / not
// transmitted). A message that had no way to leave (nothing connected, no address) is SKIPPED with the
// reason, never "Sent".
//
// NEVER BLOCKS A STEP MOVE. Everything called from a move is wrapped by the caller; an AI failure
// falls back to the template.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const R = require('./autoMessageRules');
const W = require('./autoMessageWriter');
const sandbox = require('./sandbox');
const { stageLabel } = require('./atsVocab');

const TEST_RECORD = /zztest|example\.test/i;
const PENDING = ['SCHEDULED', 'WAITING_APPROVAL'];
const STATUS_WORD = {
  SCHEDULED: 'Waiting to go', WAITING_APPROVAL: 'Needs an OK', SENDING: 'Sending', SENT: 'Sent', FAILED: 'Problem', CANCELLED: 'Cancelled', SKIPPED: 'Not sent',
};
const LIVE_MSG = ['QUEUED', 'RETRY', 'SENT', 'DELIVERED', 'READ'];

// --- the table, with plain SQL ------------------------------------------------------
let tableOk = null;
let tableAt = 0;
async function supported() {
  if (tableOk === true) return true;
  if (tableOk === false && Date.now() - tableAt < 30000) return false;
  try {
    const r = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name='ScheduledMessage'");
    tableOk = r.length > 0;
  } catch { tableOk = false; }
  tableAt = Date.now();
  return tableOk;
}
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const ms = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const iso = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const newId = () => `sm${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const q = async (sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = num(r[k]); }); return o; });
const ex = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const DATE_COLS = new Set(['sendAt', 'sentAt', 'decidedAt', 'createdAt', 'updatedAt']);
const BOOL_COLS = new Set(['urgent', 'aiWritten', 'edited']);
const prep = (k, v) => {
  if (v === undefined) return null;
  if (DATE_COLS.has(k)) return v == null ? null : (v instanceof Date ? v.getTime() : v);
  if (BOOL_COLS.has(k)) return v ? 1 : 0;
  return v;
};

function shape(r) {
  if (!r) return null;
  return {
    ...r,
    sendAt: iso(r.sendAt), sentAt: iso(r.sentAt), decidedAt: iso(r.decidedAt), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
    urgent: !!r.urgent, aiWritten: !!r.aiWritten, edited: !!r.edited,
    plan: json(r.channelPlan, { channels: [], strategy: 'first' }),
    result: json(r.resultJson, []),
  };
}
async function get(id) { const r = await q('SELECT * FROM "ScheduledMessage" WHERE id = ?', id); return shape(r[0]); }
async function getByKey(key) { const r = await q('SELECT * FROM "ScheduledMessage" WHERE dedupeKey = ?', key); return shape(r[0]); }
async function insert(o) {
  const now = Date.now();
  const rec = { id: newId(), createdAt: now, updatedAt: now, ...o };
  const cols = Object.keys(rec);
  try {
    await ex(`INSERT INTO "ScheduledMessage" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => prep(c, rec[c])));
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) return { duplicate: true, row: await getByKey(o.dedupeKey) };
    throw e;
  }
  return { row: await get(rec.id) };
}
async function update(id, patch, onlyIfStatus) {
  const cols = Object.keys(patch);
  const set = [...cols.map((c) => `"${c}" = ?`), '"updatedAt" = ?'];
  const params = [...cols.map((c) => prep(c, patch[c])), Date.now(), id];
  let where = 'id = ?';
  if (onlyIfStatus) { where += ` AND status IN (${onlyIfStatus.map(() => '?').join(',')})`; params.push(...onlyIfStatus); }
  return ex(`UPDATE "ScheduledMessage" SET ${set.join(', ')} WHERE ${where}`, ...params);
}

// --- who and what a message is about -----------------------------------------------------
async function loadContext(applicationId) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { candidate: true, requirement: { include: { client: true } } },
  });
  if (!app || !app.candidate) return null;
  const requirement = app.requirement || {};
  let recruiter = null;
  if (requirement.recruiterId) {
    try {
      const u = await prisma.user.findUnique({ where: { id: requirement.recruiterId } });
      const emp = u ? await prisma.employee.findUnique({ where: { userId: u.id } }).catch(() => null) : null;
      if (u) recruiter = { userId: u.id, name: (emp && emp.name) || u.name, phone: (emp && emp.phone) || null, email: (emp && emp.email) || u.email || null, user: u };
    } catch { recruiter = null; }
  }
  return { app, candidate: app.candidate, requirement, recruiter };
}

function tokensFor(ctx) {
  // eslint-disable-next-line global-require
  const cm = require('./messageContext');
  const { app, candidate, requirement, recruiter } = ctx;
  const t = cm.appTokens({ ...app, requirement });
  const first = String(candidate.name || '').trim().split(/\s+/)[0] || null;
  return {
    ...t,
    name: candidate.name,
    firstName: first,
    // CANDIDATES NEVER SEE THE CLIENT'S NAME: "our client", or TeamLink for an internal job.
    client: requirement.internal ? 'TeamLink Internal' : 'our client',
    interviewAt: t.interviewAt || 'a time we will confirm',
    mode: t.mode || 'to be confirmed',
    interviewer: t.interviewer || 'to be confirmed',
    deadline: t.deadline || 'the date in your invite',
    recruiterName: recruiter ? recruiter.name : null,
    recruiterPhone: recruiter ? recruiter.phone : null,
    recruiterEmail: recruiter ? recruiter.email : null,
    sender: recruiter ? recruiter.name : '—',
    company: cm.COMPANY,
    today: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }),
  };
}

const languageOf = (rule, candidate) => {
  if (rule.language && rule.language !== 'Auto') return rule.language;
  const l = candidate && candidate.language;
  return ['English', 'Telugu', 'Hindi'].includes(l) ? l : 'English';
};

// --- the move -> a row --------------------------------------------------------------------------
async function eventIdFor(applicationId, toStage) {
  try {
    const ev = await prisma.applicationStageEvent.findFirst({ where: { applicationId, toStage }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return ev ? ev.id : null;
  } catch { return null; }
}

async function cancelPending(applicationId, why, user, { onlyWithinMs, exceptStage } = {}) {
  const rows = await q(`SELECT id, stageTo, createdAt FROM "ScheduledMessage" WHERE applicationId = ? AND status IN ('SCHEDULED','WAITING_APPROVAL')`, applicationId);
  let n = 0;
  for (const r of rows) {
    if (exceptStage && r.stageTo === exceptStage) continue; // eslint-disable-line no-continue
    if (onlyWithinMs != null && Date.now() - ms(r.createdAt) > onlyWithinMs) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const c = await update(r.id, { status: 'CANCELLED', statusReason: why, decidedByUserId: user ? user.id : null, decidedByName: user ? user.name : null, decidedAt: Date.now() }, PENDING);
    n += Number(c) || 0;
  }
  return n;
}

// args: { application, candidate, requirement, fromStage, toStage, user, comment, stageEventId }
async function handleStageMove(args) {
  const {
    application, candidate, requirement, fromStage, toStage, user, stageEventId,
  } = args || {};
  const clock = (args && args.now) || Date.now(); // (tests pass their own clock)
  if (!application || !candidate || !toStage) return { handled: false };
  if (!(await supported())) return { handled: false };
  const settings = await R.loadSettings();
  if (!R.started(settings)) return { handled: false };
  const rule = R.effectiveRule(toStage, settings);
  const now = clock;

  // Moving again replaces a message that is still waiting from a move a moment ago.
  let superseded = 0;
  try {
    superseded = await cancelPending(application.id, 'Cancelled: the person moved to another step soon after.', user, {
      onlyWithinMs: settings.supersedeMinutes * 60000, exceptStage: toStage,
    });
  } catch { superseded = 0; }

  if (!rule.on) return { handled: true, rows: [], superseded };

  const eventId = stageEventId || await eventIdFor(application.id, toStage);
  const dedupeKey = eventId ? `${eventId}|${toStage}` : `${application.id}|${toStage}|${Math.floor(now / 60000)}`;
  const req = requirement || {};
  const jobOv = await R.jobOverride(req.id || application.requirementId);
  const paused = await R.pauseOf(candidate.id);

  let status = 'SCHEDULED';
  let reason = null;
  let sendAt = now;
  let whenMode = rule.when.mode;
  if (settings.killSwitch) { status = 'SKIPPED'; reason = 'Automatic messages are switched off for the whole company.'; sendAt = null; }
  else if (jobOv && jobOv.mode === 'off') { status = 'SKIPPED'; reason = 'Automatic messages are switched off for this job.'; sendAt = null; }
  else if (paused) { status = 'SKIPPED'; reason = `Automatic messages are paused for this person${paused.byName ? ` (by ${paused.byName})` : ''}.`; sendAt = null; }
  else {
    if (jobOv && jobOv.mode === 'approval') whenMode = 'approval';
    if (whenMode === 'approval') { status = 'WAITING_APPROVAL'; sendAt = null; reason = 'Waiting for the recruiter to say OK.'; }
    else if (whenMode === 'delay') sendAt = now + rule.when.minutes * 60000;
    else if (whenMode === 'working') sendAt = R.nextWorking(now, settings);
  }

  const language = languageOf(rule, candidate);
  const ins = await insert({
    candidateId: candidate.id,
    applicationId: application.id,
    requirementId: req.id || application.requirementId || null,
    stageEventId: eventId,
    stageFrom: fromStage || null,
    stageTo: toStage,
    dedupeKey,
    status,
    statusReason: reason,
    sendAt,
    whenMode,
    channelPlan: JSON.stringify({ channels: rule.channels, strategy: rule.strategy }),
    wording: rule.wording,
    instruction: rule.instruction || null,
    purpose: rule.templatePurpose || null,
    language,
    urgent: rule.urgent,
    candidateName: candidate.name,
    jobTitle: req.title || null,
    department: req.department || null,
    createdByUserId: user ? user.id : null,
    createdByName: user ? user.name : null,
  });
  if (ins.duplicate) return { handled: true, rows: [], duplicate: true };
  let row = ins.row;
  // The row is written: from here on nothing may fall back to the old path (that would send twice).
  try {
    return await afterInsert(row, { status, sendAt, now, req });
  } catch (e) {
    console.error('[auto-messages] after insert:', e && e.message); // eslint-disable-line no-console
    return { handled: true, rows: [], scheduled: row };
  }
}

async function afterInsert(row0, { status, sendAt, now, req }) {
  let row = row0;
  if (status === 'WAITING_APPROVAL') {
    await prepareDraft(row.id).catch((e) => console.error('[auto-messages] draft:', e.message)); // eslint-disable-line no-console
    row = await get(row.id);
    await tellAboutApproval(row, req).catch(() => {});
    return { handled: true, rows: [], scheduled: row };
  }
  if (status === 'SCHEDULED' && sendAt <= now) {
    const out = await processOne(row.id, { now });
    return { handled: true, rows: out.messages || [], scheduled: await get(row.id) };
  }
  return { handled: true, rows: [], scheduled: row };
}

async function tellAboutApproval(row, requirement) {
  // eslint-disable-next-line global-require
  const { notifyUsers } = require('./notify');
  const ids = [requirement.recruiterId, requirement.tlId].filter(Boolean);
  if (!ids.length) return;
  await notifyUsers(ids, {
    title: `A message to ${row.candidateName} needs your OK`,
    message: `"${stageLabel(row.stageTo)}"${row.jobTitle ? ` on ${row.jobTitle}` : ''}: open the person's page, read the message and press Approve & send.`,
  });
}

// --- wording ----------------------------------------------------------------------------------
let aiTried = { day: '', n: 0 };
async function aiUsedToday() {
  const day = R.ymdIst(Date.now());
  if (aiTried.day !== day) aiTried = { day, n: 0 };
  let db = 0;
  try { db = num((await q('SELECT COUNT(*) AS n FROM "ScheduledMessage" WHERE aiWritten = 1 AND updatedAt >= ?', R.dayStartIst(Date.now())))[0].n); } catch { db = 0; }
  return Math.max(db, aiTried.n);
}

const blockNamesOf = (ctx) => [ctx.requirement && !ctx.requirement.internal && ctx.requirement.client && ctx.requirement.client.name].filter(Boolean);

// -> { subject, body, aiWritten, aiNote, template }
async function wordsFor({
  channel, row, ctx, settings, useStored, windowOpen, forcePlain,
}) {
  // eslint-disable-next-line global-require
  const T = require('./messageTemplates');
  const tokens = tokensFor(ctx);
  const tpl = await T.resolve({ purpose: row.purpose, channel, language: row.language || 'English' });
  const renderT = (text) => T.render(text, tokens, { blank: '—' }).text;
  if (useStored && row.body) {
    return {
      subject: channel === 'Email' ? renderT(row.subject || (tpl && tpl.subject) || '') : null, body: renderT(row.body), aiWritten: row.aiWritten, aiNote: row.aiNote || null, template: tpl,
    };
  }
  if (!tpl && row.wording !== 'AI') return { missing: true };
  let aiNote = null;
  if (row.wording === 'AI' && !forcePlain) {
    const allow = W.channelAllowsAi(channel, { windowOpen });
    if (!allow.ok) aiNote = allow.reason;
    else if ((await aiUsedToday()) >= settings.ai.perDay) aiNote = `Today's AI limit (${settings.ai.perDay} messages) is reached, so the template is used.`;
    else {
      aiTried.n += 1;
      const facts = W.buildFacts({
        stage: row.stageTo, candidate: ctx.candidate, requirement: ctx.requirement, application: ctx.app, recruiter: ctx.recruiter, language: row.language,
      });
      const res = await W.write({
        channel, language: row.language || 'English', facts, instruction: row.instruction || '', blockNames: blockNamesOf(ctx),
        templateText: tpl ? `${tpl.subject} ${tpl.body}` : '', timeoutSeconds: settings.ai.timeoutSeconds,
      });
      if (res.ok) return { subject: res.subject, body: res.body, aiWritten: true, aiNote: res.dropped.length ? `The safety check removed ${res.dropped.length} sentence${res.dropped.length === 1 ? '' : 's'}.` : null, template: tpl };
      aiNote = res.reason;
    }
  }
  if (!tpl) return { missing: true, aiNote };
  return {
    subject: channel === 'Email' ? renderT(tpl.subject) : null, body: renderT(tpl.body), aiWritten: false, aiNote, template: tpl,
  };
}

// The text a person reads before it goes (a "Waiting for an OK" row, or the first line of a waiting one).
async function prepareDraft(id) {
  const row = await get(id);
  if (!row) return null;
  const ctx = await loadContext(row.applicationId);
  if (!ctx) return null;
  const settings = await R.loadSettings();
  const channels = row.plan.channels;
  const channel = channels.includes('Email') ? 'Email' : channels[0];
  if (!channel) return null;
  const w = await wordsFor({ channel, row, ctx, settings, useStored: false, windowOpen: false });
  if (w.missing) return null;
  await update(id, { subject: w.subject, body: w.body, aiWritten: w.aiWritten, aiNote: w.aiNote });
  return get(id);
}

// --- channel readiness -------------------------------------------------------------------------
async function channelState(channel, ctx, row, statusMap, windowOpenFor) {
  // eslint-disable-next-line global-require
  const core = require('./messagingCore');
  // eslint-disable-next-line global-require
  const delivery = require('./messageDelivery');
  const c = ctx.candidate;
  const recipient = channel === 'Email' ? (c.email || '') : (c.phone || '');
  if (!String(recipient).trim()) return { ok: false, kind: 'blocked', recipient, why: `No ${channel === 'Email' ? 'email address' : 'phone number'} on this person's record.` };
  if (channel === 'Email') {
    if (!core.validEmail(recipient)) return { ok: false, kind: 'blocked', recipient, why: 'The email address on record is not valid.' };
  } else {
    const m = core.normalizeMobile(recipient);
    if (!m.ok) return { ok: false, kind: 'blocked', recipient, why: m.reason };
    if (await delivery.optedOut(channel, recipient)) return { ok: false, kind: 'blocked', recipient, why: `They replied STOP on ${channel}, so nothing more is sent there.` };
  }
  const st = statusMap[channel];
  if (!st || !st.configured) return { ok: false, kind: 'noprovider', recipient, why: `${channel} is not connected yet${st && st.reason ? ` (${st.reason})` : ''}.` };
  let windowOpen = false;
  if (channel === 'WhatsApp') windowOpen = await windowOpenFor(recipient);
  if (channel === 'SMS' || channel === 'WhatsApp') {
    // eslint-disable-next-line global-require
    const T = require('./messageTemplates');
    const tpl = await T.resolve({ purpose: row.purpose, channel, language: row.language || 'English' });
    if (channel === 'SMS') {
      let bulk = false;
      try { bulk = !!(((await require('./smsGateway').smsConfig()).templates || {}).bulk); } catch { bulk = false; } // eslint-disable-line global-require
      if (!(tpl && tpl.source === 'saved' && tpl.dltTemplateId) && !bulk) return { ok: false, kind: 'blocked', recipient, why: 'SMS needs a registered (DLT) template for this step. An Admin adds its id in Message templates.' };
    } else {
      let bulk = false;
      try { bulk = !!(((await require('./whatsappCloud').whatsappConfig()).templates || {}).bulk); } catch { bulk = false; } // eslint-disable-line global-require
      const approved = tpl && tpl.source === 'saved' && tpl.waStatus === 'Approved' && tpl.waTemplateName;
      if (!approved && !bulk && !windowOpen) return { ok: false, kind: 'blocked', recipient, why: 'WhatsApp can only start a chat with a template Meta approved, and this step has none approved yet.' };
    }
  }
  return { ok: true, recipient, windowOpen, free: channel === 'Email' || windowOpen };
}

const dayCount = async (where) => {
  try { return await prisma.candidateMessage.count({ where: { ...where, trigger: { startsWith: 'Automatic' }, createdAt: { gte: new Date(R.dayStartIst(Date.now())) }, status: { in: LIVE_MSG } } }); } catch { return 0; }
};

// --- the dispatch -----------------------------------------------------------------------------------
async function finish(id, status, reason, extra = {}) {
  await update(id, { status, statusReason: reason, ...extra });
  return { status, reason, messages: extra.__messages || [] };
}

// opts: { force, actor, now }
async function processOne(id, opts = {}) {
  const now = opts.now || Date.now();
  const row0 = await get(id);
  if (!row0) return { error: 'No such message.', status: 404 };
  const allowed = opts.force ? PENDING : ['SCHEDULED'];
  if (!allowed.includes(row0.status)) return { skipped: true, status: row0.status };
  const claimed = Number(await update(id, { status: 'SENDING', attempts: (row0.attempts || 0) + 1 }, allowed)) || 0;
  if (!claimed) return { skipped: true };
  const row = await get(id);
  try {
    return await dispatch(row, opts, now);
  } catch (e) {
    console.error('[auto-messages] dispatch failed:', e && e.stack ? e.stack : e); // eslint-disable-line no-console
    await update(id, { status: 'FAILED', statusReason: `Something went wrong inside the app: ${String((e && e.message) || e).slice(0, 160)}` });
    return { failed: true, status: 'FAILED' };
  }
}

async function dispatch(row, opts, now) {
  const id = row.id;
  const settings = await R.loadSettings();
  const rule = R.effectiveRule(row.stageTo, settings);
  const force = !!opts.force;
  const skip = (why) => update(id, { status: 'SKIPPED', statusReason: why }).then(() => ({ status: 'SKIPPED', reason: why, messages: [] }));
  const defer = (when, why) => update(id, { status: 'SCHEDULED', sendAt: when, statusReason: why }).then(() => ({ status: 'SCHEDULED', deferred: true, reason: why, messages: [] }));

  if (settings.killSwitch && !force) return skip('Automatic messages are switched off for the whole company.');
  if (!rule.on && !force) return skip('This step\'s automatic message was switched off before it went.');
  const jobOv = await R.jobOverride(row.requirementId);
  if (jobOv && jobOv.mode === 'off') return skip('Automatic messages are switched off for this job.');
  const paused = await R.pauseOf(row.candidateId);
  if (paused) return skip('Automatic messages are paused for this person.');

  const ctx = row.applicationId ? await loadContext(row.applicationId) : null;
  if (!ctx) return skip('The application or the person no longer exists.');
  const { candidate } = ctx;
  if (!sandbox.isSandbox() && TEST_RECORD.test(`${candidate.name} ${candidate.email} ${candidate.phone}`)) return skip('Test record: never messaged.');
  if (candidate.doNotContact || candidate.consentStatus === 'WITHDRAWN') return skip('This person asked not to be contacted (consent withdrawn).');
  // eslint-disable-next-line global-require
  const IN = require('./interviewNotices');
  const switchedOn = await IN.candidateEmailsOn();
  if (['REJECTED', 'HOLD'].includes(row.stageTo) && ctx.app.stage !== row.stageTo) return skip(`They have moved on from "${stageLabel(row.stageTo)}", so this message is no longer true.`);
  const age = now - (ms(row.createdAt) || now);
  if (!force && age > settings.maxAgeHours * 3600000) return skip(`It could not go within ${settings.maxAgeHours} hours, so it was dropped (late news is worse than none).`);
  if (!force && !row.urgent && R.inQuiet(now, settings.quiet)) {
    const end = R.quietEnd(now, settings.quiet);
    return defer(end, `Waiting for quiet hours (${settings.quiet.from} to ${settings.quiet.to}) to end.`);
  }
  // duplicate guard: the same step message to the same application is not sent twice in a row
  if (!force && settings.dupHours > 0) {
    const dup = await q(`SELECT id, sentAt FROM "ScheduledMessage" WHERE applicationId = ? AND stageTo = ? AND status = 'SENT' AND id <> ? AND sentAt >= ? LIMIT 1`, row.applicationId, row.stageTo, id, now - settings.dupHours * 3600000);
    if (dup.length) return skip(`The same message already went to this person for this job at ${new Date(ms(dup[0].sentAt)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`);
  }
  if (settings.skipIfCalledToday && !force) {
    const called = await prisma.candidateMessage.count({ where: { candidateId: candidate.id, channel: 'Call', createdAt: { gte: new Date(R.dayStartIst(now)) } } }).catch(() => 0);
    if (called) return skip('A recruiter already phoned this person today.');
  }

  // per-person daily limit
  if (!force && !row.urgent) {
    const used = await dayCount({ candidateId: candidate.id });
    if (used >= settings.caps.perCandidatePerDay) return defer(R.dayStartIst(now) + 86400000 + R.hmOf(settings.workStart) * 60000, `This person already got ${used} automatic messages today (limit ${settings.caps.perCandidatePerDay}). It goes tomorrow.`);
  }

  // channels
  // eslint-disable-next-line global-require
  const messaging = require('./messaging');
  const statusMap = await messaging.channelStatus().catch(() => ({}));
  // eslint-disable-next-line global-require
  const delivery = require('./messageDelivery');
  const windowOpenFor = (to) => delivery.windowOpen(to).catch(() => false);
  let channels = [...row.plan.channels];
  const strategy = row.plan.strategy;
  // the person's own preferred channel goes first when we only need one
  if (strategy === 'first') {
    try {
      const pref = (await q(`SELECT preferredChannel FROM "Conversation" WHERE personType = 'CANDIDATE' AND personId = ? LIMIT 1`, candidate.id))[0];
      if (pref && channels.includes(pref.preferredChannel)) channels = [pref.preferredChannel, ...channels.filter((c) => c !== pref.preferredChannel)];
    } catch { /* no Conversation table yet */ }
  }
  // eslint-disable-next-line global-require
  const { senderIdentity, NOT_SENT, NOT_SENT_DETAIL } = require('./candidateComms');
  let sender = {};
  try {
    const su = (ctx.recruiter && ctx.recruiter.user) || (row.createdByUserId ? await prisma.user.findUnique({ where: { id: row.createdByUserId } }) : null);
    sender = await senderIdentity(su);
  } catch { sender = {}; }
  const label = stageLabel(row.stageTo);
  const useStored = row.edited || (row.whenMode === 'approval' && !!row.body);

  const results = [];
  const created = [];
  const notes = [];
  let chosenAi = false;
  let aiNoteAny = null;
  for (const channel of channels) {
    // eslint-disable-next-line no-await-in-loop
    const st = await channelState(channel, ctx, row, statusMap, windowOpenFor);
    const record = async (data) => {
      const m = await prisma.candidateMessage.create({
        data: {
          candidateId: candidate.id, applicationId: ctx.app.id, channel, template: row.purpose || row.stageTo, templateLabel: label,
          trigger: `Automatic${data.ai ? ' (AI-written)' : ''}: ${label}`,
          recipient: st.recipient || '', subject: data.subject || null, body: data.body || null, status: data.status, statusDetail: data.detail,
          stageFrom: row.stageFrom, stageTo: row.stageTo, ...sender,
        },
      });
      created.push(m);
      results.push({ channel, messageId: m.id, status: data.status, why: data.detail, ai: !!data.ai });
      return m;
    };
    if (!switchedOn) {
      // eslint-disable-next-line no-await-in-loop
      const w0 = await wordsFor({ channel, row, ctx, settings, useStored, windowOpen: !!st.windowOpen, forcePlain: true });
      // eslint-disable-next-line no-await-in-loop
      if (!w0.missing) await record({ status: IN.SWITCHED_OFF, detail: `${IN.SWITCHED_OFF_DETAIL}.`, subject: w0.subject, body: w0.body });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!st.ok) {
      notes.push(`${channel}: ${st.why}`);
      if (strategy === 'all') {
        // eslint-disable-next-line no-await-in-loop
        const w0 = await wordsFor({ channel, row, ctx, settings, useStored, windowOpen: false, forcePlain: true });
        // eslint-disable-next-line no-await-in-loop
        if (!w0.missing) await record({ status: st.kind === 'noprovider' ? NOT_SENT : 'NOT_SENT_BLOCKED', detail: st.kind === 'noprovider' ? `${NOT_SENT_DETAIL}${st.recipient ? '' : ` ${st.why}`}` : st.why, subject: w0.subject, body: w0.body });
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    // channel daily limit
    if (!force) {
      // eslint-disable-next-line no-await-in-loop
      const used = await dayCount({ channel });
      if (used >= settings.caps.perChannelPerDay[channel]) {
        notes.push(`${channel}: today's limit (${settings.caps.perChannelPerDay[channel]}) is reached.`);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const w = await wordsFor({
      channel, row, ctx, settings, useStored: useStored && st.free, windowOpen: !!st.windowOpen, forcePlain: !st.free && row.wording === 'AI' && channel !== 'Email',
    });
    if (w.missing) { notes.push(`${channel}: no wording for this step yet. Add a template in Message templates.`); continue; } // eslint-disable-line no-continue
    if (w.aiNote) aiNoteAny = w.aiNote;
    const fell = notes.length ? `Sent by ${channel} because ${notes.join(' ')}`.slice(0, 300) : null;
    // eslint-disable-next-line no-await-in-loop
    await record({
      status: 'QUEUED', detail: fell || 'Queued for sending.', subject: w.subject, body: w.body, ai: w.aiWritten,
    });
    if (w.aiWritten) chosenAi = true;
    if (strategy === 'first') break;
  }

  const live = created.filter((m) => m.status === 'QUEUED');
  if (live.length) {
    try { require('./mailWorker').kick(); } catch { /* the worker picks it up on its next tick */ } // eslint-disable-line global-require
  }
  const done = {
    resultJson: JSON.stringify(results), aiWritten: chosenAi, aiNote: aiNoteAny, decidedAt: opts.actor ? now : undefined,
    decidedByUserId: opts.actor ? opts.actor.id : undefined, decidedByName: opts.actor ? opts.actor.name : undefined,
  };
  Object.keys(done).forEach((k) => done[k] === undefined && delete done[k]);
  if (live.length) {
    await update(id, { status: 'SENT', statusReason: notes.length ? notes.join(' ') : null, sentAt: now, ...done });
    return { status: 'SENT', messages: created, results };
  }
  const why = !switchedOn ? `${IN.SWITCHED_OFF_DETAIL}.` : (notes.join(' ') || 'There was no way to reach this person.');
  await update(id, { status: 'SKIPPED', statusReason: why, ...done });
  return { status: 'SKIPPED', reason: why, messages: created, results };
}

// --- the sweep ------------------------------------------------------------------------------------
let sweeping = false;
async function processDue({ limit = 50, now = Date.now() } = {}) {
  const out = { considered: 0, sent: 0, skipped: 0, deferred: 0, failed: 0, recovered: 0, expired: 0 };
  if (!(await supported())) return { ...out, notReady: true };
  if (sweeping) return { ...out, busy: true };
  sweeping = true;
  try {
    const settings = await R.loadSettings();
    if (!R.started(settings)) return { ...out, notStarted: true };
    // a row that was mid-send when the process died is never sent a second time
    const stuck = await q(`SELECT id FROM "ScheduledMessage" WHERE status = 'SENDING' AND updatedAt < ?`, now - 10 * 60000);
    for (const s of stuck) {
      // eslint-disable-next-line no-await-in-loop
      await update(s.id, { status: 'FAILED', statusReason: 'The app stopped while sending this message, so it is not known whether it went. It was not sent again.' }, ['SENDING']);
      out.recovered += 1;
    }
    // a message nobody approved in time
    const old = await q(`SELECT id FROM "ScheduledMessage" WHERE status = 'WAITING_APPROVAL' AND createdAt < ?`, now - 72 * 3600000);
    for (const o of old) {
      // eslint-disable-next-line no-await-in-loop
      await update(o.id, { status: 'SKIPPED', statusReason: 'Nobody pressed OK within 3 days, so it was dropped.' }, ['WAITING_APPROVAL']);
      out.expired += 1;
    }
    const due = await q(`SELECT id FROM "ScheduledMessage" WHERE status = 'SCHEDULED' AND sendAt <= ? ORDER BY sendAt ASC LIMIT ?`, now, limit);
    out.considered = due.length;
    for (const d of due) {
      // eslint-disable-next-line no-await-in-loop
      const r = await processOne(d.id, { now });
      if (r.skipped) continue; // eslint-disable-line no-continue
      if (r.status === 'SENT') out.sent += 1;
      else if (r.deferred) out.deferred += 1;
      else if (r.status === 'FAILED' || r.failed) out.failed += 1;
      else out.skipped += 1;
    }
    return out;
  } catch (e) {
    console.error('[auto-messages] sweep:', e && e.message); // eslint-disable-line no-console
    return { ...out, error: String((e && e.message) || e) };
  } finally {
    sweeping = false;
  }
}

let timer = null;
function startSweep() {
  const every = Number(process.env.AUTO_MESSAGES_SWEEP_MS == null ? 60000 : process.env.AUTO_MESSAGES_SWEEP_MS);
  if (!every || timer || sandbox.isSandbox()) return null;
  const tick = () => processDue().then(() => dailySummaryOnce()).catch(() => {});
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
  const first = setTimeout(tick, 20000);
  if (first.unref) first.unref();
  return timer;
}

// --- actions people take ------------------------------------------------------------------------------
async function inScope(user, row) {
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const s = scope.atsScopeOf(user);
  if (s.global) return true;
  if (!row.applicationId) return false;
  const n = await prisma.application.count({ where: { AND: [scope.applicationWhere(user), { id: row.applicationId }] } });
  return n > 0;
}
async function loadFor(user, id) {
  if (!(await supported())) return { error: 'Automatic messages are being set up on this server.', status: 503 };
  const row = await get(id);
  if (!row || !(await inScope(user, row))) return { error: 'No such message, or it is outside your area.', status: 404 };
  return { row };
}

const audit = (user, action, row, extra = {}) => require('./audit').logAudit({ // eslint-disable-line global-require
  userId: user.id, actorName: user.name, action, entity: 'ScheduledMessage', entityId: row.id, toValue: `${row.candidateName} - ${stageLabel(row.stageTo)}`, ...extra,
});

async function sendNow(user, id, { approved = false } = {}) {
  if (!R.canAct(user)) return { error: 'Only the recruiter, the team lead, HR or an Admin can send this.', status: 403 };
  const f = await loadFor(user, id);
  if (f.error) return f;
  if (approved && f.row.status !== 'WAITING_APPROVAL') return { error: 'This message is not waiting for an OK.', status: 409 };
  if (!PENDING.includes(f.row.status)) return { error: `This message is already "${STATUS_WORD[f.row.status]}".`, status: 409 };
  const out = await processOne(id, { force: true, actor: user });
  await audit(user, approved ? 'Automatic message approved and sent' : 'Automatic message sent now', f.row, { reason: out.reason || null });
  return { ok: true, row: await get(id), outcome: out.status };
}
async function cancel(user, id, reason) {
  if (!R.canAct(user)) return { error: 'Only the recruiter, the team lead, HR or an Admin can cancel this.', status: 403 };
  const f = await loadFor(user, id);
  if (f.error) return f;
  if (!PENDING.includes(f.row.status)) return { error: `This message is already "${STATUS_WORD[f.row.status]}".`, status: 409 };
  await update(id, {
    status: 'CANCELLED', statusReason: `Cancelled by ${user.name}${reason ? `: ${String(reason).slice(0, 160)}` : ''}.`, decidedByUserId: user.id, decidedByName: user.name, decidedAt: Date.now(),
  }, PENDING);
  await audit(user, 'Automatic message cancelled', f.row);
  return { ok: true, row: await get(id) };
}
async function edit(user, id, { subject, body }) {
  if (!R.canAct(user)) return { error: 'Only the recruiter, the team lead, HR or an Admin can change this.', status: 403 };
  const f = await loadFor(user, id);
  if (f.error) return f;
  if (!PENDING.includes(f.row.status)) return { error: `This message is already "${STATUS_WORD[f.row.status]}", so it cannot be changed.`, status: 409 };
  const text = String(body == null ? '' : body).trim();
  if (!text) return { error: 'Write the message.', status: 400 };
  if (text.length > 3000) return { error: 'The message is too long (3000 letters at most).', status: 400 };
  // eslint-disable-next-line global-require
  const T = require('./messageTemplates');
  const bad = [...new Set([...T.unknownTokens(text), ...T.unknownTokens(subject)])];
  if (bad.length) return { error: `These placeholders are not known: ${bad.map((b) => `{{${b}}}`).join(', ')}.`, status: 400 };
  await update(id, {
    body: text, subject: subject == null ? f.row.subject : String(subject).trim().slice(0, 200), edited: true, aiWritten: false, aiNote: `Reworded by ${user.name}.`,
  }, PENDING);
  await audit(user, 'Automatic message reworded', f.row);
  return { ok: true, row: await get(id) };
}
async function pausePerson(user, candidateId, paused, reason) {
  if (!R.canAct(user)) return { error: 'Only the recruiter, the team lead, HR or an Admin can do this.', status: 403 };
  // the person must be in the caller's area
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const ok = scope.atsScopeOf(user).global || (await prisma.candidate.count({ where: { AND: [scope.candidateWhere(user), { id: candidateId }] } })) > 0;
  if (!ok) return { error: 'No such person, or outside your area.', status: 404 };
  const out = await R.setPause(user, candidateId, paused, reason);
  if (out.error) return out;
  let cancelled = 0;
  if (paused && (await supported())) {
    const rows = await q(`SELECT id FROM "ScheduledMessage" WHERE candidateId = ? AND status IN ('SCHEDULED','WAITING_APPROVAL')`, candidateId);
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      cancelled += Number(await update(r.id, { status: 'CANCELLED', statusReason: `Paused by ${user.name}: no automatic messages to this person.`, decidedByUserId: user.id, decidedByName: user.name, decidedAt: Date.now() }, PENDING)) || 0;
    }
  }
  return { ...out, cancelled };
}

// --- lists, counts, facets (scope-limited) ---------------------------------------------------------------------
const HOURS = 3600000;
function displayTime(r) { return ms(r.sendAt) || ms(r.createdAt); }

async function scopedRows(user, { days = 30, candidateId, applicationId } = {}) {
  if (!(await supported())) return [];
  const since = Date.now() - days * 24 * HOURS;
  const where = ['createdAt >= ?'];
  const params = [since];
  if (candidateId) { where.push('candidateId = ?'); params.push(candidateId); }
  if (applicationId) { where.push('applicationId = ?'); params.push(applicationId); }
  // anything still waiting is shown however old
  let rows = (await q(`SELECT * FROM "ScheduledMessage" WHERE (${where.join(' AND ')}) ORDER BY COALESCE(sendAt, createdAt) DESC LIMIT 3000`, ...params)).map(shape);
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const s = scope.atsScopeOf(user);
  if (!s.global) {
    const appIds = [...new Set(rows.map((r) => r.applicationId).filter(Boolean))];
    const okIds = new Set();
    for (let i = 0; i < appIds.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      const part = await prisma.application.findMany({ where: { AND: [scope.applicationWhere(user), { id: { in: appIds.slice(i, i + 500) } }] }, select: { id: true } });
      part.forEach((a) => okIds.add(a.id));
    }
    rows = rows.filter((r) => r.applicationId && okIds.has(r.applicationId));
  }
  return rows;
}

function matchesFilters(r, f, skip) {
  const t = displayTime(r);
  if (skip !== 'stage' && f.stage && r.stageTo !== f.stage) return false;
  if (skip !== 'status' && f.status && r.status !== f.status) return false;
  if (skip !== 'channel' && f.channel && !r.plan.channels.includes(f.channel)) return false;
  if (skip !== 'department' && f.department && r.department !== f.department) return false;
  if (skip !== 'date') {
    if (f.from && t < Date.parse(`${f.from}T00:00:00+05:30`)) return false;
    if (f.to && t > Date.parse(`${f.to}T23:59:59+05:30`)) return false;
  }
  if (f.q) {
    const hay = `${r.candidateName} ${r.jobTitle} ${stageLabel(r.stageTo)}`.toLowerCase();
    if (!hay.includes(String(f.q).toLowerCase())) return false;
  }
  return true;
}

function facetsOf(rows, f) {
  const count = (key, valuesOf) => {
    const m = new Map();
    rows.filter((r) => matchesFilters(r, f, key)).forEach((r) => valuesOf(r).forEach((v) => { if (v) m.set(v, (m.get(v) || 0) + 1); }));
    return m;
  };
  const stages = count('stage', (r) => [r.stageTo]);
  const statuses = count('status', (r) => [r.status]);
  const channels = count('channel', (r) => r.plan.channels);
  const depts = count('department', (r) => [r.department]);
  return {
    stages: [...stages].map(([value, n]) => ({ value, label: stageLabel(value), count: n })).sort((a, b) => b.count - a.count),
    statuses: [...statuses].map(([value, n]) => ({ value, label: STATUS_WORD[value] || value, count: n })).sort((a, b) => b.count - a.count),
    channels: [...channels].map(([value, n]) => ({ value, label: value, count: n })).sort((a, b) => b.count - a.count),
    departments: [...depts].map(([value, n]) => ({ value, label: value, count: n })).sort((a, b) => b.count - a.count),
  };
}

// Live state of the CandidateMessage rows a message produced.
async function deliveryOf(rows) {
  const ids = [...new Set(rows.flatMap((r) => r.result.map((x) => x.messageId)).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const part = await prisma.candidateMessage.findMany({ where: { id: { in: ids.slice(i, i + 500) } }, select: { id: true, status: true, statusDetail: true, channel: true } });
    part.forEach((m) => map.set(m.id, m));
  }
  return map;
}

function viewRow(r, user, { dmap, paused, contactOk }) {
  const act = R.canAct(user);
  const pend = PENDING.includes(r.status);
  const delivery = r.result.map((x) => { const m = dmap.get(x.messageId); return { channel: x.channel, status: m ? m.status : x.status, detail: m ? m.statusDetail : x.why, ai: !!x.ai }; });
  const aiPending = r.wording === 'AI' && !r.body && pend;
  return {
    id: r.id,
    candidateId: r.candidateId,
    candidateName: r.candidateName,
    applicationId: r.applicationId,
    requirementId: r.requirementId,
    jobTitle: r.jobTitle,
    department: r.department,
    stage: r.stageTo,
    stageLabel: stageLabel(r.stageTo),
    stageFromLabel: r.stageFrom ? stageLabel(r.stageFrom) : null,
    status: r.status,
    statusWord: STATUS_WORD[r.status] || r.status,
    reason: r.statusReason,
    sendAt: r.sendAt,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
    whenMode: r.whenMode,
    channels: r.plan.channels,
    strategy: r.plan.strategy,
    wording: r.wording,
    wordingWord: r.wording === 'AI' ? 'AI writes it' : 'Template',
    aiWritten: r.aiWritten,
    aiNote: r.aiNote,
    edited: r.edited,
    urgent: r.urgent,
    subject: r.subject,
    body: r.body,
    previewNote: aiPending ? 'The AI writes this just before it goes.' : null,
    delivery,
    paused: paused.has(r.candidateId),
    contactAllowed: contactOk,
    by: r.createdByName,
    decidedBy: r.decidedByName,
    can: {
      sendNow: act && pend && !paused.has(r.candidateId),
      approve: act && r.status === 'WAITING_APPROVAL' && !paused.has(r.candidateId),
      edit: act && pend,
      cancel: act && pend,
      pause: act && !paused.has(r.candidateId),
      resume: act && paused.has(r.candidateId),
    },
  };
}

async function list(user, f = {}) {
  const rows = await scopedRows(user, { days: Number(f.days) || 30, candidateId: f.candidateId, applicationId: f.applicationId });
  const filtered = rows.filter((r) => matchesFilters(r, f));
  const page = Math.max(1, Number(f.page) || 1);
  const size = Math.min(200, Math.max(5, Number(f.pageSize) || 50));
  // waiting ones first, then newest
  const rank = (r) => (r.status === 'WAITING_APPROVAL' ? 0 : (r.status === 'SCHEDULED' ? 1 : 2));
  const sorted = [...filtered].sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? displayTime(a) - displayTime(b) : displayTime(b) - displayTime(a)));
  const slice = sorted.slice((page - 1) * size, page * size);
  const dmap = await deliveryOf(slice);
  const paused = new Set(await R.pausedIds());
  const contactOk = !!(user.caps && user.caps.candidateContact);
  return {
    total: filtered.length,
    page,
    pageSize: size,
    counts: {
      waitingApproval: filtered.filter((r) => r.status === 'WAITING_APPROVAL').length,
      scheduled: filtered.filter((r) => r.status === 'SCHEDULED').length,
      sent: filtered.filter((r) => r.status === 'SENT').length,
      notSent: filtered.filter((r) => ['SKIPPED', 'CANCELLED'].includes(r.status)).length,
      problems: filtered.filter((r) => r.status === 'FAILED').length,
    },
    facets: facetsOf(rows, f),
    rows: slice.map((r) => viewRow(r, user, { dmap, paused, contactOk })),
  };
}

async function summary(user) {
  if (!(await supported())) return { ready: false, waitingApproval: 0, scheduled: 0, problems: 0 };
  const rows = await scopedRows(user, { days: 14 });
  return {
    ready: true,
    waitingApproval: rows.filter((r) => r.status === 'WAITING_APPROVAL').length,
    scheduled: rows.filter((r) => r.status === 'SCHEDULED').length,
    problems: rows.filter((r) => r.status === 'FAILED' && Date.now() - ms(r.updatedAt) < 2 * 24 * HOURS).length,
  };
}

// --- previews -------------------------------------------------------------------------------------------------
async function sampleApplications(user, stage, limit = 6) {
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const base = scope.applicationWhere(user);
  const pick = async (extra) => prisma.application.findMany({
    where: { AND: [base, ...extra] }, orderBy: { updatedAt: 'desc' }, take: limit,
    select: { id: true, stage: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } },
  });
  let rows = stage ? await pick([{ stage }]) : [];
  if (rows.length < limit) {
    const more = await pick([{ id: { notIn: rows.map((r) => r.id) } }]);
    rows = [...rows, ...more].slice(0, limit);
  }
  return rows.map((a) => ({ applicationId: a.id, candidateName: a.candidate.name, jobTitle: a.requirement ? a.requirement.title : null, stageLabel: stageLabel(a.stage), atThisStep: a.stage === stage }));
}

// Draft rule (what the editor shows right now) rendered with a REAL application. No row is written.
async function preview(user, { stage, rule, applicationId, useAi }) {
  const settings = await R.loadSettings();
  const eff = { ...R.effectiveRule(stage, settings), ...(rule || {}) };
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  let appId = applicationId;
  if (appId) {
    const ok = scope.atsScopeOf(user).global || (await prisma.application.count({ where: { AND: [scope.applicationWhere(user), { id: appId }] } })) > 0;
    if (!ok) return { error: 'That example is outside your area.', status: 404 };
  } else {
    const s = await sampleApplications(user, stage, 1);
    appId = s[0] && s[0].applicationId;
  }
  if (!appId) return { empty: true, note: 'There is no real example in your area yet.' };
  const ctx = await loadContext(appId);
  if (!ctx) return { empty: true, note: 'That example no longer exists.' };
  const aiStatus = await W.aiReady();
  // eslint-disable-next-line global-require
  const messaging = require('./messaging');
  const statusMap = await messaging.channelStatus().catch(() => ({}));
  const language = languageOf(eff, ctx.candidate);
  const fake = {
    purpose: eff.templatePurpose, language, wording: eff.wording, instruction: eff.instruction, stageTo: stage, stageFrom: null, body: null, edited: false, aiWritten: false,
  };
  // eslint-disable-next-line global-require
  const delivery = require('./messageDelivery');
  const out = [];
  for (const channel of eff.channels) {
    // eslint-disable-next-line no-await-in-loop
    const st = await channelState(channel, ctx, fake, statusMap, (to) => delivery.windowOpen(to).catch(() => false));
    // the preview shows the wording even when the channel cannot send; the reason is shown beside it
    const wantAi = eff.wording === 'AI' && useAi === true;
    // eslint-disable-next-line no-await-in-loop
    const w = await wordsFor({
      channel, row: { ...fake, wording: wantAi ? 'AI' : 'TEMPLATE' }, ctx, settings, useStored: false, windowOpen: !!st.windowOpen, forcePlain: false,
    });
    const allow = W.channelAllowsAi(channel, { windowOpen: !!st.windowOpen });
    out.push({
      channel, ready: st.ok === true, why: st.ok ? null : st.why, missing: !!w.missing, subject: w.subject || null, body: w.body || '', aiWritten: !!w.aiWritten, aiNote: w.aiNote || null,
      aiAllowed: allow.ok, aiBlockedBecause: allow.ok ? null : allow.reason,
    });
  }
  return {
    candidateName: ctx.candidate.name,
    jobTitle: ctx.requirement.title || null,
    ai: { available: aiStatus.available, reason: aiStatus.reason, provider: aiStatus.provider },
    channels: out,
  };
}

// --- the daily summary (a digest line) ----------------------------------------------------------------------------
async function dailySummary({ since = R.dayStartIst(Date.now()) } = {}) {
  if (!(await supported())) return { ready: false };
  const rows = (await q('SELECT status, statusReason, requirementId FROM "ScheduledMessage" WHERE createdAt >= ?', since));
  const by = (s) => rows.filter((r) => r.status === s).length;
  const reasons = new Map();
  rows.filter((r) => ['SKIPPED', 'FAILED'].includes(r.status)).forEach((r) => { const k = String(r.statusReason || '').slice(0, 80); reasons.set(k, (reasons.get(k) || 0) + 1); });
  return {
    ready: true,
    sent: by('SENT'),
    waitingApproval: by('WAITING_APPROVAL'),
    scheduled: by('SCHEDULED'),
    skipped: by('SKIPPED'),
    failed: by('FAILED'),
    cancelled: by('CANCELLED'),
    topReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, n]) => ({ why, n })),
    rows,
  };
}
function summaryLine(s) {
  if (!s || !s.ready) return null;
  const parts = [];
  if (s.sent) parts.push(`${s.sent} automatic message${s.sent === 1 ? '' : 's'} sent`);
  if (s.waitingApproval) parts.push(`${s.waitingApproval} waiting for an OK`);
  if (s.skipped) parts.push(`${s.skipped} not sent${s.topReasons[0] ? ` (mostly: ${s.topReasons[0].why})` : ''}`);
  if (s.failed) parts.push(`${s.failed} had a problem`);
  return parts.length ? `Automatic messages today: ${parts.join(', ')}.` : null;
}
// Once a day (after 18:00 IST) each TL gets one bell line about their jobs. Deduped in AppSetting.
async function dailySummaryOnce(now = Date.now()) {
  const day = R.ymdIst(now);
  if (R.minutesOfDay(now) < 18 * 60) return { skipped: 'too early' };
  const key = `auto-messages.summary.${day}`;
  if (await prisma.appSetting.findUnique({ where: { key } }).catch(() => null)) return { skipped: 'already sent' };
  const s = await dailySummary();
  if (!s.ready || !s.rows.length) return { skipped: 'nothing today' };
  await prisma.appSetting.create({ data: { key, value: JSON.stringify({ at: new Date(now).toISOString() }) } }).catch(() => {});
  const reqIds = [...new Set(s.rows.map((r) => r.requirementId).filter(Boolean))];
  const reqs = reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, tlId: true } }) : [];
  const tlOf = new Map(reqs.map((r) => [r.id, r.tlId]));
  const per = new Map();
  s.rows.forEach((r) => {
    const tl = tlOf.get(r.requirementId);
    if (!tl) return;
    const e = per.get(tl) || { ready: true, sent: 0, waitingApproval: 0, skipped: 0, failed: 0, topReasons: [] };
    if (r.status === 'SENT') e.sent += 1; else if (r.status === 'WAITING_APPROVAL') e.waitingApproval += 1; else if (r.status === 'SKIPPED') e.skipped += 1; else if (r.status === 'FAILED') e.failed += 1;
    per.set(tl, e);
  });
  // eslint-disable-next-line global-require
  const { pushNotification } = require('./notify');
  let n = 0;
  for (const [tl, e] of per) {
    const line = summaryLine(e);
    // eslint-disable-next-line no-await-in-loop
    if (line) { await pushNotification({ userId: tl, title: 'Automatic messages today', message: line }).catch(() => {}); n += 1; }
  }
  return { sentTo: n };
}

module.exports = {
  supported, handleStageMove, processOne, processDue, startSweep, sendNow, cancel, edit, pausePerson, approve: (u, id) => sendNow(u, id, { approved: true }),
  list, summary, preview, sampleApplications, dailySummary, summaryLine, dailySummaryOnce, get, loadContext, tokensFor, prepareDraft,
  STATUS_WORD, PENDING,
};

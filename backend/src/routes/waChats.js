// ---------------------------------------------------------------------------
// /api/wa-chats - the recruiter's WhatsApp chat screen (Follow-ups > WhatsApp chats). Logic: utils/waChats.js.
//
//   GET  /config                                       what this login may do + the channel state + the webhook hint (+ the Admin help)
//   GET  /unread-count                                 the badge (cheap)
//   GET  /changes?since=<ms>                           polling: chats with a message after the cursor + the badge
//   GET  /?state=&q=&numberId=&requirementId=          the list of chats (latest first)
//   GET  /person/:audience/:id                         one chat: who, window, sender, messages
//   GET  /person/:audience/:id/messages?since=|before= polling / older messages (+ the tick changes of sent ones)
//   POST /person/:audience/:id/read                    this login has read it (per login)
//   POST /person/:audience/:id/send                    { text } | { purposeKey, templateId } | { attachResume } ; Idempotency-Key header
//   POST /person/:audience/:id/intent                  Interested | Not interested | Call back | null
//   GET  /person/:audience/:id/assignees , POST .../assign       a team lead gives the chat to someone of the same area
//   GET|POST /person/candidates/:id/followup , POST .../followup/:fid/snooze     the follow-up on the same screen
//   GET  /person/candidates/:id/steps                  the steps this login may move the candidate to
//   GET  /media/:id                                    a picture / file / voice note (login + ownership checked on every request)
//   GET  /test/status , POST /test/simulate-reply , POST /test/remove    Admin, Test mode only
//
// Every route is held to the caller's own people: utils/contactAccess.js (may this role contact them, and may it see the number),
// utils/scope.js (candidateWhere / applicationWhere), and the WhatsApp number access (utils/waNumbers.js).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const access = require('../utils/contactAccess');
const convo = require('../utils/conversations');
const omni = require('../utils/omniSend');
const WC = require('../utils/waChats');
const delivery = require('../utils/messageDelivery');
const { logAudit } = require('../utils/audit');
const { idempotent } = require('../utils/idempotency');

const router = express.Router();
router.use(requireAuth);
const external = (u) => ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);
router.use((req, res, next) => (external(req.user) ? res.status(403).json({ error: 'Not available to this login' }) : next()));
router.use((req, res, next) => { WC.ensure().then(() => next(), next); });

const guarded = (fn) => async (req, res, next) => { try { return await fn(req, res, next); } catch (err) { return next(err); } };
const must = (n) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(n) || 0));

// May this login open this person's chat?  -> { rule, type, id, audience } or sends the refusal
async function authorize(req, res) {
  const audience = req.params.audience;
  const type = convo.TYPES[audience];
  if (!type) { res.status(404).json({ error: 'Unknown kind of person' }); return null; }
  const rule = await access.ruleFor(req.user, audience);
  if (!rule.allowed) { res.status(403).json({ error: rule.reason || 'Not available to this login' }); return null; }
  const id = String(req.params.id || '');
  const vis = await convo.visibleIds(req.user, type, [id]);
  if (!vis.has(id)) { res.status(403).json({ error: 'This person is outside your access.' }); return null; }
  // a WhatsApp number this login may not use: the chats that ran only on it are not theirs
  try {
    const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
    if (await WN.hasNumbers()) {
      const hide = await WN.hiddenPersons(req.user, [{ personType: type, personId: id, channel: 'WhatsApp' }]);
      if (hide.has(`${type}:${id}`)) { res.status(403).json({ error: 'This chat is on a WhatsApp number you are not given.' }); return null; }
    }
  } catch { /* the check above is an extra */ }
  return { rule, type, id, audience };
}

// ---- config -------------------------------------------------------------------------------------------------------------------------------
router.get('/config', guarded(async (req, res) => {
  const u = req.user;
  const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const [st, mine, test, rule] = await Promise.all([messaging.channelStatus(), WN.myNumbers(u), WC.testState(), access.ruleFor(u, 'candidates')]);
  const webhook = (await delivery.seenOf('whatsapp')) || null;
  let review = 0;
  try { review = await require('../outreach/omni/replyRouter').reviewCount(u); } catch { review = 0; } // eslint-disable-line global-require
  const admin = WC.isAdminLike(u);
  const types = Object.keys(await convo.allowedTypes(u));
  return res.json({
    allowed: types.length > 0,
    reason: rule.allowed ? null : rule.reason,
    masked: rule.mode === 'masked',
    channel: { configured: !!st.WhatsApp.configured, reason: st.WhatsApp.reason || null, detail: st.WhatsApp.detail || null },
    test: { mode: test.testMode, realSending: test.realSending },
    numbers: mine.legacy ? { legacy: true, numbers: [] } : { legacy: false, numbers: mine.numbers, defaultId: mine.defaultId, canSend: mine.canSend, message: mine.message },
    webhook: { seenAt: webhook && webhook.at ? webhook.at : null, count: webhook && webhook.count ? webhook.count : 0, path: '/api/webhooks/whatsapp' },
    needsReview: review, isAdmin: admin, mayAssign: WC.isLead(u),
    simulate: { available: admin && (test.testMode || !test.connected), why: admin ? (test.testMode || !test.connected ? '' : 'Real WhatsApp sending is on, so pretend replies are switched off.') : 'Only an Admin can use this.' },
    words: WC.WORDS,
  });
}));

router.get('/unread-count', guarded(async (req, res) => res.json(await WC.unreadCount(req.user))));

// ---- the list ---------------------------------------------------------------------------------------------------------------------------------
router.get('/', guarded(async (req, res) => {
  const out = await WC.listChats(req.user, { state: req.query.state, q: req.query.q, numberId: req.query.numberId, requirementId: req.query.requirementId, type: req.query.type });
  return res.json(out);
}));
router.get('/changes', guarded(async (req, res) => {
  const since = must(req.query.since);
  const [unread, list] = await Promise.all([WC.unreadCount(req.user), since ? WC.listChats(req.user, { since: Math.max(0, since - 5000) }) : Promise.resolve({ rows: [] })]);
  return res.json({ now: Date.now(), changed: list.rows.length, unreadChats: unread.chats, unreadMessages: unread.messages });
}));

// ---- one chat -----------------------------------------------------------------------------------------------------------------------------------
router.get('/person/:audience/:id', guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  const u = req.user;
  const facts = await WC.personFacts(u, a.audience, a.id);
  const masked = a.rule.mode === 'masked';
  const e164 = WC.e164Of(facts.phone);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 60));
  const messages = await WC.chatMessages(u, a.type, a.id, { limit });
  const sending = e164 ? await WC.sendingState(u, e164) : { error: WC.WORDS.NO_PHONE, code: 'NO_PHONE', legacy: true, windowOpen: false };
  const opted = e164 ? await delivery.optedOut('WhatsApp', e164) : null;
  const thread = await convo.getThread(a.type, a.id);
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const st = await messaging.channelStatus();
  const test = await WC.testState();
  const intent = (await prisma.$queryRawUnsafe('SELECT "intent" FROM "WaChatMeta" WHERE "personType" = ? AND "personId" = ?', a.type, a.id))[0];
  let blocked = null; let code = null;
  if (facts.doNotContact) { blocked = 'This person asked not to be contacted. Nothing can be sent.'; code = 'DO_NOT_CONTACT'; } else if (opted) { blocked = WC.WORDS.OPTED_OUT; code = 'OPTED_OUT'; } else if (!e164) { blocked = WC.WORDS.NO_PHONE; code = 'NO_PHONE'; } else if (!st.WhatsApp.configured) { blocked = WC.WORDS.NOT_CONNECTED; code = 'NOT_CONNECTED'; } else if (sending.error) { blocked = sending.error; code = sending.code || 'NO_SENDER'; }
  return res.json({
    person: { audience: a.audience, type: a.type, id: a.id, name: facts.name, phoneHint: access.maskedHint(facts.phone), phone: masked ? null : (facts.phone || null), department: facts.info.department || null, applicationId: facts.applicationId },
    masked, mode: a.rule.mode,
    owner: thread && thread.ownerUserId ? { userId: thread.ownerUserId, name: thread.ownerName } : null,
    intent: intent ? intent.intent : null,
    window: { open: !!sending.windowOpen, until: sending.windowUntil || null, lastInboundAt: sending.lastInboundAt || null },
    sender: { legacy: !!sending.legacy, label: sending.label || null, displayNumber: sending.displayNumber || null },
    optedOut: !!opted, canSend: !blocked, blocked, blockedCode: code,
    channel: { configured: !!st.WhatsApp.configured, testMode: test.testMode },
    messages, cursor: Date.now(), hasOlder: messages.length >= limit,
  });
}));

router.get('/person/:audience/:id/messages', guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  const masked = a.rule.mode === 'masked';
  const since = req.query.since !== undefined && req.query.since !== '' ? must(req.query.since) : null;
  const before = req.query.before !== undefined && req.query.before !== '' ? must(req.query.before) : null;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || (since != null ? 100 : 40)));
  const now = Date.now();
  const messages = await WC.chatMessages(req.user, a.type, a.id, since != null ? { since: Math.max(0, since - 5000), limit } : { before, limit });
  const out = { cursor: now, messages };
  if (since != null) {
    out.updates = await WC.tickUpdates(a.type, a.id, masked);
    const facts = await WC.personFacts(req.user, a.audience, a.id);
    const e164 = WC.e164Of(facts.phone);
    const s = e164 ? await WC.sendingState(req.user, e164) : { windowOpen: false };
    out.window = { open: !!s.windowOpen, until: s.windowUntil || null, lastInboundAt: s.lastInboundAt || null };
    out.optedOut = e164 ? !!(await delivery.optedOut('WhatsApp', e164)) : false;
  } else out.hasOlder = messages.length >= limit;
  return res.json(out);
}));

router.post('/person/:audience/:id/read', guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  await WC.markRead(req.user, a.type, a.id);
  const c = await WC.unreadCount(req.user);
  return res.json({ ok: true, unreadChats: c.chats, unreadMessages: c.messages });
}));

// ---- send -------------------------------------------------------------------------------------------------------------------------------------------
const sendFail = (res, status, code, error, extra) => res.status(status).json({ error, code, ...(extra || {}) });
router.post('/person/:audience/:id/send', require('../channels/rateLimit').limiter(), idempotent('wachat'), guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  const u = req.user;
  const b = req.body || {};
  const facts = await WC.personFacts(u, a.audience, a.id);
  if (facts.doNotContact) return sendFail(res, 409, 'DO_NOT_CONTACT', 'This person asked not to be contacted. Nothing can be sent.');
  const e164 = WC.e164Of(facts.phone);
  if (!e164) return sendFail(res, 409, 'NO_PHONE', WC.WORDS.NO_PHONE);
  if (await delivery.optedOut('WhatsApp', e164)) return sendFail(res, 409, 'OPTED_OUT', WC.WORDS.OPTED_OUT);
  const text = String(b.text == null ? '' : b.text).trim();
  const byTemplate = !!(b.purposeKey || b.templateId);
  const withResume = b.attachResume === true;
  if (!byTemplate && !text && !withResume) return sendFail(res, 400, 'EMPTY', 'Write a message first.');
  if (text.length > 4000) return sendFail(res, 400, 'TOO_LONG', 'This message is too long for WhatsApp (4000 letters at most).');
  const sending = await WC.sendingState(u, e164, b.waNumberId || undefined);
  if (sending.error) return sendFail(res, sending.code === 'NUMBER_NOT_ALLOWED' ? 403 : 409, sending.code || 'NO_SENDER', sending.error);
  // INSIDE 24 HOURS: plain words. OUTSIDE: only an approved template (the server decides, not the screen)
  if ((!byTemplate || withResume) && !sending.windowOpen) return sendFail(res, 409, 'OUTSIDE_24H', WC.WORDS.OUTSIDE_24H, { needsTemplate: true });
  const input = {
    audience: a.audience, id: a.id, channel: 'WhatsApp', applicationId: b.applicationId || facts.applicationId || undefined, waNumberId: b.waNumberId || undefined,
  };
  if (byTemplate && !withResume) {
    Object.assign(input, { purposeKey: b.purposeKey || undefined, perChannel: { WhatsApp: { templateId: b.templateId || undefined } } });
  } else {
    Object.assign(input, { purpose: 'Message', sessionText: true, perChannel: { WhatsApp: { subject: 'Message', body: text || (withResume ? 'Resume' : '') } } });
    if (withResume) input.attachments = [{ type: 'resume' }];
  }
  const out = await omni.send(u, input);
  if (out.error && out.status && out.status !== 200) return sendFail(res, out.status, out.code || 'REFUSED', out.error);
  if (!out.ok) {
    const why = (out.attempts || []).map((x) => x.reason).filter(Boolean)[0] || out.error || 'The message could not be sent.';
    const outside = /24-hour|24 hour|approved template|no approved/i.test(why);
    return sendFail(res, 409, outside ? 'OUTSIDE_24H' : 'NOT_SENT', outside && !/More than 24/.test(why) ? `${WC.WORDS.OUTSIDE_24H} (${why})` : why, outside ? { needsTemplate: true } : undefined);
  }
  await WC.markRead(u, a.type, a.id).catch(() => {}); // answering a chat means you have seen it
  return res.json({
    ok: true, id: out.jobId || `s${Date.now().toString(36)}`, stillSending: !!out.stillSending, sandbox: !!(out.result && out.result.sandbox),
    sentFrom: sending.label || null, mode: byTemplate && !withResume ? 'template' : (withResume ? 'file' : 'text'),
  });
}));

router.post('/person/:audience/:id/intent', guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  const raw = req.body && req.body.intent ? String(req.body.intent) : null;
  if (raw && !WC.INTENTS[raw]) return res.status(400).json({ error: 'Choose Interested, Not interested or Call back.' });
  await WC.setIntent(req.user, a.type, a.id, raw);
  return res.json({ ok: true, intent: raw });
}));

// ---- who the chat is given to (a team lead / manager / Admin) ------------------------------------------------------------------------------------
router.get('/person/:audience/:id/assignees', guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  if (!WC.isLead(req.user)) return res.status(403).json({ error: 'Only a team lead, a manager or an Admin can give a chat to someone else.' });
  const list = await require('./conversations').assigneesFor(req.user, a.type, a.id); // eslint-disable-line global-require
  const t = await convo.getThread(a.type, a.id);
  return res.json({ people: list.slice(0, 200), ownerUserId: t ? t.ownerUserId : null });
}));
router.post('/person/:audience/:id/assign', guarded(async (req, res) => {
  const a = await authorize(req, res);
  if (!a) return undefined;
  if (!WC.isLead(req.user)) return res.status(403).json({ error: 'Only a team lead, a manager or an Admin can give a chat to someone else.' });
  const to = req.body && req.body.userId ? String(req.body.userId) : null;
  if (to) {
    const list = await require('./conversations').assigneesFor(req.user, a.type, a.id); // eslint-disable-line global-require
    if (!list.some((p) => p.id === to)) return res.status(403).json({ error: 'You can give a chat to people of your own area only.' });
  }
  const t = await convo.assign(req.user, a.type, a.id, to);
  if (t && t.error) return res.status(400).json({ error: t.error });
  return res.json({ ok: true, owner: t && t.ownerUserId ? { userId: t.ownerUserId, name: t.ownerName } : null });
}));

// ---- the follow-up, on the same screen -------------------------------------------------------------------------------------------------------------
const FU = require('../utils/followups');
const { applicationWhere, isAssignedTo, atsScopeOf, OUT_OF_SCOPE } = require('../utils/scope');
const { stageLabel } = require('../utils/atsVocab');
const IST_MS = 330 * 60000;
const istYmd = (t) => new Date(t + IST_MS).toISOString().slice(0, 10);
// Quick buttons -> a date and time (India time). 'custom' needs dueDate (+ dueTime).
function when(b) {
  const now = Date.now();
  const q = String(b.quick || '');
  if (q === 'tomorrow10') return { dueDate: istYmd(now + 86400000), dueTime: '10:00' };
  if (q === 'in3days') return { dueDate: istYmd(now + 3 * 86400000), dueTime: '10:00' };
  if (q === 'nextweek') return { dueDate: istYmd(now + 7 * 86400000), dueTime: '10:00' };
  if (q === 'in2hours') { const t = new Date(now + 2 * 3600000 + IST_MS).toISOString(); return { dueDate: t.slice(0, 10), dueTime: t.slice(11, 16) }; }
  const d = String(b.dueDate || '').trim(); const t = String(b.dueTime || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'Pick a date for the follow-up.' };
  if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return { error: 'The time must look like 10:30.' };
  return { dueDate: d, dueTime: t || null };
}
const mayRecord = (user, application) => {
  const s = atsScopeOf(user);
  if (s.global) return true;
  return isAssignedTo(user, application.requirement);
};
const fuShape = (r, flags) => (r ? {
  id: r.id, applicationId: r.applicationId, dueDate: r.dueDate, dueTime: r.dueTime, nextAction: r.nextAction, notes: r.notes, purpose: r.purpose, status: FU.followUpStatus(r),
  ownerName: r.ownerName, completedAt: r.completedAt, outcome: r.outcome, nextStep: r.nextStep, lastContactedAt: r.lastContactedAt,
  repliedAt: flags && flags.get(r.id) ? flags.get(r.id) : null,
} : null);

router.get('/person/candidates/:id/followup', guarded(async (req, res) => {
  req.params.audience = 'candidates';
  const a = await authorize(req, res);
  if (!a) return undefined;
  const apps = await prisma.application.findMany({
    where: { AND: [{ candidateId: a.id }, applicationWhere(req.user)] }, orderBy: { updatedAt: 'desc' }, take: 8,
    include: { requirement: { include: { client: true } } },
  });
  const ids = apps.map((x) => x.id);
  const rows = ids.length ? await prisma.applicationFollowUp.findMany({ where: { applicationId: { in: ids } }, orderBy: { createdAt: 'desc' } }) : [];
  const flagRows = await prisma.$queryRawUnsafe('SELECT * FROM "WaChatFlag" WHERE "personId" = ?', a.id);
  const flags = new Map(flagRows.map((f) => [f.followUpId, Number(f.repliedAt)]));
  const perm = await require('../utils/permissions').can(req.user, 'ats', 'candidates', 'Applications', 'edit'); // eslint-disable-line global-require
  return res.json({
    applications: apps.map((app) => {
      const mine = rows.filter((r) => r.applicationId === app.id);
      const open = mine.find((r) => !r.completedAt) || null;
      const r = app.requirement || {};
      return {
        applicationId: app.id, stage: app.stage, stageLabel: stageLabel(app.stage), requirementId: app.requirementId, requirementTitle: r.title || null,
        clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
        canRecord: perm && mayRecord(req.user, app), open: fuShape(open, flags), history: mine.filter((x) => x.completedAt).slice(0, 4).map((x) => fuShape(x, flags)),
      };
    }),
    quick: [{ key: 'tomorrow10', label: 'Tomorrow 10:00' }, { key: 'in3days', label: 'In 3 days' }, { key: 'nextweek', label: 'Next week' }],
    outcomes: FU.FOLLOWUP_OUTCOMES, nextSteps: FU.FOLLOWUP_NEXT_STEPS, needDate: FU.NEXT_STEPS_NEEDING_DATE,
  });
}));

async function loadApp(user, candidateId, applicationId) {
  const app = await prisma.application.findFirst({ where: { AND: [{ id: String(applicationId || ''), candidateId }, applicationWhere(user)] }, include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: true, recruiter: true, bde: true } } } });
  return app;
}

router.post('/person/candidates/:id/followup', requirePerm('ats', 'candidates', 'Applications', 'edit'), guarded(async (req, res) => {
  req.params.audience = 'candidates';
  const a = await authorize(req, res);
  if (!a) return undefined;
  const b = req.body || {};
  const app = await loadApp(req.user, a.id, b.applicationId);
  if (!app) return res.status(403).json(OUT_OF_SCOPE);
  if (!mayRecord(req.user, app)) return res.status(403).json({ error: 'A follow-up is recorded by its owner - you are not on this requirement\'s assignment chain.' });
  const w = when(b);
  if (w.error) return res.status(400).json({ error: w.error });
  const note = String(b.note || '').trim().slice(0, 500) || null;
  const open = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
  let row;
  if (open) {
    // already one open: it moves to the new time (the history of the old time is in the audit log)
    row = await prisma.applicationFollowUp.update({ where: { id: open.id }, data: { dueDate: w.dueDate, dueTime: w.dueTime, ...(note ? { notes: note } : {}) } });
    await logAudit({ userId: req.user.id, action: 'Follow-up moved (WhatsApp chat)', entity: 'Application', entityId: app.id, fromValue: `${open.dueDate || '-'} ${open.dueTime || ''}`.trim(), toValue: `${w.dueDate} ${w.dueTime || ''}`.trim(), actorName: req.user.name });
  } else {
    const names = await FU.resolveNames([app.requirement]);
    const snap = FU.chainSnapshot(app, app.requirement, names);
    if (!snap.ownerUserId) { snap.ownerUserId = req.user.id; snap.ownerName = req.user.name; snap.ownerRole = req.user.atsRole || req.user.role; }
    const seat = await require('../utils/positions').stampFor(req.user, 'owner'); // eslint-disable-line global-require
    row = await prisma.applicationFollowUp.create({
      data: {
        applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId, ...seat, ...snap,
        contactMode: 'WhatsApp', nextAction: note || 'Follow up on WhatsApp', purpose: 'WhatsApp follow-up', notes: note, dueDate: w.dueDate, dueTime: w.dueTime,
        createdById: req.user.id, createdByName: req.user.name,
      },
    });
    await logAudit({ userId: req.user.id, action: 'Follow-up recorded (WhatsApp chat)', entity: 'Application', entityId: app.id, fromValue: 'none', toValue: `${row.nextAction} (due ${row.dueDate} ${row.dueTime || ''})`.trim(), actorName: req.user.name });
  }
  return res.status(open ? 200 : 201).json({ ok: true, followUp: fuShape(row), moved: !!open });
}));

router.post('/person/candidates/:id/followup/:fid/snooze', requirePerm('ats', 'candidates', 'Applications', 'edit'), guarded(async (req, res) => {
  req.params.audience = 'candidates';
  const a = await authorize(req, res);
  if (!a) return undefined;
  const row = await prisma.applicationFollowUp.findUnique({ where: { id: String(req.params.fid) } });
  if (!row || row.candidateId !== a.id) return res.status(404).json({ error: 'Follow-up not found' });
  const app = await loadApp(req.user, a.id, row.applicationId);
  if (!app) return res.status(403).json(OUT_OF_SCOPE);
  if (!mayRecord(req.user, app)) return res.status(403).json({ error: 'A follow-up is changed by its owner.' });
  if (row.completedAt) return res.status(400).json({ error: 'This follow-up is already done.' });
  const w = when(req.body || {});
  if (w.error) return res.status(400).json({ error: w.error });
  const up = await prisma.applicationFollowUp.update({ where: { id: row.id }, data: { dueDate: w.dueDate, dueTime: w.dueTime } });
  await logAudit({ userId: req.user.id, action: 'Follow-up snoozed (WhatsApp chat)', entity: 'Application', entityId: app.id, fromValue: `${row.dueDate || '-'} ${row.dueTime || ''}`.trim(), toValue: `${w.dueDate} ${w.dueTime || ''}`.trim(), actorName: req.user.name });
  return res.json({ ok: true, followUp: fuShape(up) });
}));

// the steps this login may move the candidate to (the same table the pipeline uses; the move itself is PATCH /api/applications/:id/stage)
router.get('/person/candidates/:id/steps', guarded(async (req, res) => {
  req.params.audience = 'candidates';
  const a = await authorize(req, res);
  if (!a) return undefined;
  const P = require('../utils/permissions'); // eslint-disable-line global-require
  const allowed = await P.allowedStagesFor(req.user);
  const apps = await prisma.application.findMany({ where: { AND: [{ candidateId: a.id }, applicationWhere(req.user)] }, orderBy: { updatedAt: 'desc' }, take: 6, include: { requirement: { select: { title: true } } } });
  return res.json({
    applications: apps.map((app) => ({
      applicationId: app.id, requirementTitle: app.requirement ? app.requirement.title : null, stage: app.stage, stageLabel: stageLabel(app.stage),
      moves: allowed.filter((s) => s !== app.stage && !['REJECTED', 'HOLD'].includes(s)).map((s) => ({ code: s, label: stageLabel(s) })),
    })),
    note: 'Rejecting or holding a candidate asks for a reason: do that on the candidate page.',
  });
}));

// ---- media -------------------------------------------------------------------------------------------------------------------------------------------------
router.get('/media/:id', guarded(async (req, res) => {
  const row = await WC.mediaRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const audience = convo.AUDIENCE_OF[row.personType];
  const rule = await access.ruleFor(req.user, audience);
  if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login' });
  const vis = await convo.visibleIds(req.user, row.personType, [row.personId]);
  if (!vis.has(row.personId)) return res.status(403).json({ error: 'This file belongs to someone outside your access.' });
  try {
    const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
    if (row.numberId && (await WN.hasNumbers())) {
      const v = await WN.visibleNumberIds(req.user);
      if (v !== 'ALL' && !v.has(row.numberId)) return res.status(403).json({ error: 'This file came on a WhatsApp number you are not given.' });
    }
  } catch { /* the number check is an extra */ }
  if (row.status !== 'stored') return res.status(409).json({ error: row.note || 'The file is not here yet.', status: row.status });
  const file = WC.mediaPath(row);
  if (!file) return res.status(404).json({ error: 'The file is missing on the server.' });
  const inline = ['image', 'audio', 'voice', 'video', 'sticker'].includes(row.kind);
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `${inline && req.query.download !== '1' ? 'inline' : 'attachment'}; filename="${String(row.fileName || 'file').replace(/[^\w.\- ()]/g, '_')}"`);
  return res.sendFile(file);
}));

// ---- test tools (Admin, Test mode only) ------------------------------------------------------------------------------------------------------------------
const adminOnly = (req, res, next) => (WC.isAdminLike(req.user) ? next() : res.status(403).json({ error: 'Only an Admin can use the test tools.' }));
router.get('/test/status', adminOnly, guarded(async (req, res) => {
  const st = await WC.testState();
  const n = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "CandidateMessage" WHERE "providerRef" LIKE ?', `${WC.TEST_PREFIX}%`))[0].n) + Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "ConversationMessage" WHERE "providerRef" LIKE ?', `${WC.TEST_PREFIX}%`))[0].n);
  return res.json({ available: st.testMode || !st.connected, testMode: st.testMode, realSending: st.realSending, testMessages: n });
}));
router.post('/test/simulate-reply', adminOnly, guarded(async (req, res) => {
  const out = await WC.simulateReply(req.user, req.body || {});
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'WhatsApp test: pretend reply', entity: 'Candidate', entityId: String(req.body.personId || ''), toValue: `${out.kind} ${out.id}`, actorName: req.user.name });
  return res.json(out);
}));
router.post('/test/remove', adminOnly, guarded(async (req, res) => {
  const out = await WC.removeTestMessages();
  await logAudit({ userId: req.user.id, action: 'WhatsApp test: pretend messages removed', entity: 'WaChat', toValue: JSON.stringify(out).slice(0, 300), actorName: req.user.name });
  return res.json({ ok: true, removed: out });
}));

module.exports = router;

// ---------------------------------------------------------------------------
// /api/conversations — one conversation per person (Call, Mail, WhatsApp, SMS) and the Inbox.
//
//   GET  /inbox                      the Inbox list + filter counts (cascading) + unread totals
//   GET  /unread-count               the badge on the Follow-ups tab
//   GET  /person/:audience/:id       one person's conversation: timeline, channels, who may do what
//   POST /person/:audience/:id/read | /done | /assign | /preferred | /await
//   POST /send                       reply / send: one channel or "Best" (utils/omniSend.js)
//   POST /request-contact            a role that cannot see the number asks a colleague to call / write
//   GET  /assignees                  people a conversation can be given to
//   GET|PUT /settings                quiet hours (Admin changes)
//   GET  /mailbox/status , POST /mailbox/poll   the shared inbox (IMAP): replies to our mail
//
// Every route is held to the caller's own people: utils/contactAccess.js (may this role contact this kind of
// person, and may it see the number) + utils/scope.js (candidateWhere / clientWhere / employeeWhere).
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const access = require('../utils/contactAccess');
const convo = require('../utils/conversations');
const omni = require('../utils/omniSend');
const messaging = require('../utils/messaging');

const router = express.Router();
router.use(requireAuth);

const external = (u) => ['CLIENT', 'CANDIDATE'].includes(u.role) || ['CLIENT', 'CANDIDATE'].includes(u.atsRole);
router.use((req, res, next) => (external(req.user) ? res.status(403).json({ error: 'Not available to this login' }) : next()));

const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.atsRole);

// May this login open this person's conversation? -> { rule, type, id } or sends the refusal.
async function authorize(req, res) {
  const audience = req.params.audience;
  const type = convo.TYPES[audience];
  if (!type) { res.status(404).json({ error: 'Unknown kind of person' }); return null; }
  const rule = await access.ruleFor(req.user, audience);
  if (!rule.allowed) { res.status(403).json({ error: rule.reason || 'Not available to this login' }); return null; }
  const id = String(req.params.id || req.body?.id || '');
  const vis = await convo.visibleIds(req.user, type, [id]);
  if (!vis.has(id)) { res.status(403).json({ error: 'This person is outside your access.' }); return null; }
  return { rule, type, id, audience };
}

router.get('/inbox', async (req, res, next) => {
  try { res.json(await convo.inbox(req.user, req.query)); } catch (err) { next(err); }
});

router.get('/unread-count', async (req, res, next) => {
  try { res.json(await convo.unreadCount(req.user)); } catch (err) { next(err); }
});

// Which channels work today (the strip on the Inbox and in the contact window).
async function channelStrip() {
  const st = await messaging.channelStatus();
  const gw = await require('../utils/callGateway').callConfig().catch(() => ({ configured: false })); // eslint-disable-line global-require
  const mb = await require('../utils/imapInbox').status().catch(() => ({ configured: false })); // eslint-disable-line global-require
  return {
    Email: { configured: st.Email.configured, detail: st.Email.detail, reason: st.Email.reason, repliesConnected: !!mb.configured, repliesHint: mb.configured ? `Replies are read from ${mb.address}` : 'Connect an inbox to see replies' },
    WhatsApp: { configured: st.WhatsApp.configured, detail: st.WhatsApp.detail, reason: st.WhatsApp.reason },
    SMS: { configured: st.SMS.configured, detail: st.SMS.detail, reason: st.SMS.reason },
    Call: { configured: !!gw.configured, detail: gw.configured ? 'Call through TeamLink (Exotel)' : 'Phone link: your own phone dials, then you save how it went', reason: gw.configured ? null : 'Not connected: calls use the phone link', phoneLink: true },
  };
}
router.get('/channels', async (req, res, next) => {
  try { res.json({ channels: await channelStrip(), quiet: await require('../utils/omniRules').settings() }); } catch (err) { next(err); } // eslint-disable-line global-require
});

router.get('/person/:audience/:id', async (req, res, next) => {
  try {
    const a = await authorize(req, res);
    if (!a) return undefined;
    const masked = a.rule.mode === 'masked';
    const ctx = await require('../utils/messageContext').recipientsFor(req.user, a.audience, [a.id], { contactKind: a.rule.kind }); // eslint-disable-line global-require
    const p = ctx[0] || {};
    const info = await convo.personInfo(a.type, a.id) || {};
    let thread = await convo.getThread(a.type, a.id);
    // opening it reads it: for the person it is assigned to, or when nobody has it yet
    if (thread && thread.unread > 0 && (!thread.ownerUserId || thread.ownerUserId === req.user.id)) {
      await convo.markRead(a.type, a.id);
      thread = await convo.getThread(a.type, a.id);
    }
    const timeline = await convo.timeline(a.type, a.id, { masked, viewer: req.user });
    const mb = await require('../utils/imapInbox').status().catch(() => ({ configured: false })); // eslint-disable-line global-require
    return res.json({
      person: { type: a.type, audience: a.audience, id: a.id, name: p.name || info.name || null, department: info.department || null, doNotContact: !!p.doNotContact },
      hints: { email: access.maskedHint(p.email), phone: access.maskedHint(p.mobile) },
      has: { email: !!p.email, phone: !!p.mobile },
      mode: a.rule.mode, kind: a.rule.kind, purposes: a.rule.purposes,
      thread: thread && { id: thread.id, unread: thread.unread, done: !!thread.doneAt, doneBy: thread.doneByName, ownerUserId: thread.ownerUserId, ownerName: thread.ownerName, preferredChannel: thread.preferredChannel, waitUntil: thread.awaitUntil, waitNext: thread.awaitNext, waitChannel: thread.awaitChannel },
      timeline,
      channels: await channelStrip(),
      mailboxConnected: !!mb.configured,
      canMarkDone: true,
    });
  } catch (err) { return next(err); }
});

router.post('/person/:audience/:id/read', async (req, res, next) => {
  try {
    const a = await authorize(req, res);
    if (!a) return undefined;
    await convo.markRead(a.type, a.id);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.post('/person/:audience/:id/done', async (req, res, next) => {
  try {
    const a = await authorize(req, res);
    if (!a) return undefined;
    const t = await convo.setDone(req.user, a.type, a.id, req.body?.done !== false);
    return res.json({ ok: true, done: !!(t && t.doneAt) });
  } catch (err) { return next(err); }
});

router.post('/person/:audience/:id/assign', async (req, res, next) => {
  try {
    const a = await authorize(req, res);
    if (!a) return undefined;
    const to = req.body?.userId ? String(req.body.userId) : null;
    if (to) {
      const ok = (await assigneesFor(req.user, a.type, a.id)).some((u) => u.id === to);
      if (!ok) return res.status(403).json({ error: 'You can give a conversation to people of your own area only.' });
    }
    const t = await convo.assign(req.user, a.type, a.id, to);
    if (t && t.error) return res.status(400).json({ error: t.error });
    return res.json({ ok: true, ownerUserId: t.ownerUserId, ownerName: t.ownerName });
  } catch (err) { return next(err); }
});

router.post('/person/:audience/:id/preferred', async (req, res, next) => {
  try {
    const a = await authorize(req, res);
    if (!a) return undefined;
    const ch = req.body?.channel ? String(req.body.channel) : null;
    if (ch && !convo.CHANNELS.includes(ch)) return res.status(400).json({ error: 'Choose Mail, WhatsApp, SMS or Call.' });
    const t = await convo.setPreferred(a.type, a.id, ch);
    return res.json({ ok: true, preferredChannel: t && t.preferredChannel });
  } catch (err) { return next(err); }
});

router.post('/person/:audience/:id/await', async (req, res, next) => {
  try {
    const a = await authorize(req, res);
    if (!a) return undefined;
    if (req.body?.clear) {
      await prisma.$executeRawUnsafe('UPDATE "Conversation" SET "awaitUntil" = NULL, "awaitNotifiedAt" = NULL WHERE "personType" = ? AND "personId" = ?', a.type, a.id);
      return res.json({ ok: true });
    }
    const out = await convo.setAwait(req.user, a.type, a.id, { ...req.body, applicationId: req.body?.applicationId });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json({ ok: true, until: out.until });
  } catch (err) { return next(err); }
});

// ---- people a conversation can be given to --------------------------------------------------------------
async function assigneesFor(user, type, id) {
  const S = require('../utils/scope'); // eslint-disable-line global-require
  const s = S.atsScopeOf(user);
  const info = await convo.personInfo(type, id) || {};
  const depts = new Set([...(s.departments || []), info.department].filter(Boolean));
  const roles = ['RECRUITER', 'TL', 'STL', 'BDE', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'];
  const where = { status: 'Active', OR: [{ atsRole: { in: roles } }, { role: { in: ['TL', 'STL', 'HR', 'MANAGER', 'ASSISTANT_MANAGER'] } }] };
  const users = await prisma.user.findMany({ where, select: { id: true, name: true, role: true, atsRole: true, atsDepartment: true }, take: 600 });
  const real = users.filter((u) => !/zztest|example\.test/i.test(`${u.name}`) || /zztest/i.test(user.name));
  const mine = s.global ? real : real.filter((u) => u.id === user.id || depts.has(u.atsDepartment) || (type === 'CLIENT' && /bde/i.test(`${u.atsDepartment || ''}${u.atsRole || ''}`)));
  return mine.map((u) => ({ id: u.id, name: u.name, role: u.atsRole && u.atsRole !== 'NONE' ? u.atsRole : u.role, department: u.atsDepartment || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
router.get('/assignees', async (req, res, next) => {
  try {
    const type = convo.TYPES[req.query.audience];
    if (!type) return res.status(400).json({ error: 'Say which kind of person.' });
    const rule = await access.ruleFor(req.user, req.query.audience);
    if (!rule.allowed) return res.status(403).json({ error: rule.reason });
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = await assigneesFor(req.user, type, String(req.query.id || ''));
    if (q) list = list.filter((u) => `${u.name} ${u.role} ${u.department || ''}`.toLowerCase().includes(q));
    return res.json({ people: list.slice(0, 60) });
  } catch (err) { return next(err); }
});

// ---- send / reply -------------------------------------------------------------------------------
router.post('/send', require('../channels/rateLimit').limiter(), async (req, res, next) => {
  try {
    const out = await omni.send(req.user, req.body || {});
    if (out.error && out.status && out.status !== 200) return res.status(out.status).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
    return res.json(out);
  } catch (err) { return next(err); }
});

// "Ask a colleague to do it": for a role that may not see the number (the BDE team) when the channel is not connected.
router.post('/request-contact', async (req, res, next) => {
  try {
    const b = req.body || {};
    const audience = ['candidates', 'clients', 'employees'].includes(b.audience) ? b.audience : null;
    const channel = ['Email', 'WhatsApp', 'SMS', 'Call'].includes(b.channel) ? b.channel : 'Call';
    if (!audience || !b.id) return res.status(400).json({ error: 'Say who.' });
    const rule = await access.ruleFor(req.user, audience);
    if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login' });
    const people = await require('../utils/messageContext').recipientsFor(req.user, audience, [String(b.id)], { applicationId: b.applicationId, contactKind: rule.kind }); // eslint-disable-line global-require
    if (!people.length) return res.status(403).json({ error: 'This person is outside your access.' });
    const person = people[0];
    const type = convo.TYPES[audience];
    // who should do it: the person who deals with them (follow-up owner / recruiter), else the team lead of the job
    let toId = null;
    const thread = await convo.getThread(type, person.id);
    if (thread && thread.ownerUserId && thread.ownerUserId !== req.user.id) toId = thread.ownerUserId;
    if (!toId && audience === 'candidates') {
      const app = await prisma.application.findFirst({ where: { candidateId: person.id, ...(b.applicationId ? { id: b.applicationId } : {}) }, orderBy: { updatedAt: 'desc' }, select: { requirement: { select: { recruiterId: true, tlId: true, title: true } } } });
      const r = app && app.requirement;
      toId = r ? [r.recruiterId, r.tlId].find((x) => x && x !== req.user.id) || null : null;
    }
    if (!toId) return res.status(409).json({ error: 'Nobody is set to handle this person yet. Ask a team lead to give the conversation to someone.' });
    const toName = (await prisma.user.findUnique({ where: { id: toId }, select: { name: true } }).catch(() => null))?.name || 'a colleague';
    const what = { Call: 'call', Email: 'write to', WhatsApp: 'WhatsApp', SMS: 'SMS' }[channel];
    const note = String(b.note || '').slice(0, 300);
    await require('../utils/notify').pushNotification({ // eslint-disable-line global-require
      userId: toId, title: `${req.user.name} asks you to ${what} ${person.name}`, message: note || 'Please contact them and save how it went on their page.',
    });
    const text = `Asked ${toName} to ${what} them${note ? `: ${note}` : ''}`;
    if (audience === 'candidates') {
      await prisma.candidateMessage.create({ data: {
        candidateId: person.id, applicationId: person.applicationId || null, channel, template: 'CONTACT_REQUEST', templateLabel: 'Asked a colleague', trigger: 'Manual',
        recipient: '', body: text, status: 'REQUESTED', statusDetail: text, senderUserId: req.user.id, senderName: req.user.name,
      } });
    }
    await convo.recordOut({ personType: type, personId: person.id, personName: person.name, channel, body: text, status: 'REQUESTED', statusDetail: text, templateLabel: 'Asked a colleague', senderUserId: req.user.id, senderName: req.user.name });
    return res.json({ ok: true, to: toName, message: `${toName} has been asked to ${what} ${person.name}.` });
  } catch (err) { return next(err); }
});

// ---- quiet hours -------------------------------------------------------------------------------------
router.get('/settings', async (req, res, next) => {
  try { res.json({ quiet: await require('../utils/omniRules').settings(), canEdit: isAdmin(req.user) }); } catch (err) { next(err); } // eslint-disable-line global-require
});
router.put('/settings', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change the quiet hours.' });
    const out = await require('../utils/omniRules').saveSettings(req.user, req.body?.quiet || req.body || {}); // eslint-disable-line global-require
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json({ quiet: out.settings });
  } catch (err) { return next(err); }
});

// ---- the shared inbox (IMAP) ----------------------------------------------------------------------------
router.get('/mailbox/status', async (req, res, next) => {
  try { res.json(await require('../utils/imapInbox').status()); } catch (err) { next(err); } // eslint-disable-line global-require
});
router.post('/mailbox/poll', async (req, res, next) => {
  try {
    if (!isAdmin(req.user) && !(await access.switchOn(req.user))) return res.status(403).json({ error: 'Not available to this login' });
    const imap = require('../utils/imapInbox'); // eslint-disable-line global-require
    // TEST SERVER ONLY: the sandbox accepts raw messages in the body, so the whole receive path can be exercised
    // without a real mailbox. Ignored everywhere else.
    const messages = require('../utils/sandbox').isSandbox() && Array.isArray(req.body?.testMessages) ? req.body.testMessages : undefined; // eslint-disable-line global-require
    const out = await imap.pollOnce({ messages });
    return res.json(out);
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports.assigneesFor = assigneesFor; // the WhatsApp chats screen (routes/waChats.js) gives a chat to the same people

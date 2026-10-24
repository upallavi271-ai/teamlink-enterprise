// ---------------------------------------------------------------------------
// /api/outreach/gs/inbox : the WHATSAPP INBOX page (Green Start "Customer conversations"). Mounted by routes/outreach.js behind login + "may use Omni-Channel".
// It is a VIEW over the app's one inbox (utils/conversations.js): the same conversations, the same scope per role, the same read / done / assign rules.
// Replying, marking done and giving a chat to a colleague go through the EXISTING endpoints of routes/conversations.js (POST /api/conversations/send, .../done,
// .../assign, GET .../assignees, GET .../person/:audience/:id): there is no second send path.
//   GET  /overview                  the WhatsApp numbers (accounts), whether WhatsApp is connected, the Test mode words, counts of waiting portal applications
//   GET  /list?tab=chats|other|calls  the chat list (?q ?country=IN|US|UK ?accounts=a,b (the departments of the picked WhatsApp number) ?dept = the workspace): rows + counts + unread per tab
//   GET  /profile/:audience/:id     the profile panel: details (masked when the role may not see them), lifecycle, kinds, last reply, recent activity
//   GET  /transcript/:audience/:id  the chat as a CSV (From, Message), masked for masked logins
//   GET  /contacts?q=               your contacts who agreed to WhatsApp (for "New conversation")
//   POST /new                       start a chat with one of your contacts (outreach/communication.js quickSend rules: agreed, Test mode = rehearsal)
//   GET  /applications              the Job-portal applications tab (ATS applications whose source is the portal; scoped by utils/scope.js applicationWhere;
//                                   phone / email / salary masked for BDE and recruiter logins)
// Roles: Super Admin / Admin, Department Head, Team Lead, BDE, Recruiter (only their own people), HR (staff chats only). Marketing and Finance have no inbox.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const A = require('../outreach/access');
const Chrome = require('../outreach/chrome');
const K = require('../outreach/contacts');
const S = require('../outreach/store');
const Comm = require('../outreach/communication');
const CS = require('../outreach/consoleSend');
const Replies = require('../outreach/replies');
const convo = require('../utils/conversations');
const access = require('../utils/contactAccess');
const core = require('../utils/messagingCore');
const scope = require('../utils/scope');
const { logAudit } = require('../utils/audit');

const router = express.Router();
// a small counter PER ROUTE and per login (channels/rateLimit.js shares one counter between every route, so a busy Preview would use up Send)
const limiter = ({ perMinute = 60 } = {}) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = (req.user && req.user.id) || req.ip || 'anon';
    const l = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (l.length >= perMinute) { res.setHeader('Retry-After', '30'); return res.status(429).json({ error: 'Too many requests in a minute. Wait a little and try again.' }); }
    l.push(now); hits.set(key, l);
    return next();
  };
};
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
router.use((req, res, next) => (A.hubsFor(req.user).inbox ? next() : res.status(403).json({ error: 'There is no inbox for your login.' })));

const TAB_CHANNELS = { chats: ['WhatsApp'], other: ['Email', 'SMS'], calls: ['Call'] };
const initialsOf = (n) => String(n || '?').replace(/\(.*\)/, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const countryOf = (digits) => { const d = String(digits || '').replace(/\D/g, ''); if (!d) return ''; if (d.length === 10) return 'IN'; if (d.startsWith('91')) return 'IN'; if (d.startsWith('44')) return 'UK'; if (d.startsWith('1') && d.length === 11) return 'US'; return 'OTHER'; };

// the phone digits of the people on a page of the list (kept on the server: only the country and, for logins that may see numbers, a search match leave it)
async function phonesOf(rows) {
  const out = new Map();
  const ids = (t) => rows.filter((r) => r.personType === t).map((r) => r.personId);
  try {
    const c = ids('CANDIDATE'); if (c.length) (await prisma.candidate.findMany({ where: { id: { in: c } }, select: { id: true, phone: true } })).forEach((x) => out.set(`CANDIDATE:${x.id}`, x.phone));
    const l = ids('CLIENT'); if (l.length) (await prisma.client.findMany({ where: { id: { in: l } }, select: { id: true, contactWhatsApp: true, contactPhone: true } })).forEach((x) => out.set(`CLIENT:${x.id}`, x.contactWhatsApp || x.contactPhone));
    const e = ids('EMPLOYEE'); if (e.length) (await prisma.employee.findMany({ where: { id: { in: e } }, select: { id: true, phone: true } })).forEach((x) => out.set(`EMPLOYEE:${x.id}`, x.phone));
  } catch { /* no phones: the country filter simply finds nothing */ }
  return out;
}
const e164 = (raw) => { const n = core.normalizeMobile(String(raw || '')); return n.ok ? n.e164 : String(raw || '').replace(/\D/g, ''); };

router.get('/overview', wrap(async (req, res) => {
  const Cfg = require('../outreach/config'); // eslint-disable-line global-require
  const Pol = require('../outreach/policy'); // eslint-disable-line global-require
  const st = await S.settings();
  let wa = { connected: false, number: '', why: '' };
  try { wa = await Cfg.account(); } catch { /* shown as not connected */ }
  const sc = A.deptScope(req.user);
  const accounts = [{ id: 'all', label: 'Company WhatsApp number', number: wa.number || '', departments: [] }];
  (await Pol.waNumbers()).forEach((r) => {
    const deps = (r.departments || []).map((d) => String(d).toLowerCase());
    if (!sc.all && deps.length && !deps.some((d) => sc.departments.includes(d))) return;
    accounts.push({ id: r.id, label: r.label, number: r.numberMasked, departments: r.departments || [] });
  });
  const k = A.kind(req.user);
  res.json({
    accounts, connected: !!wa.connected, connectedWhy: wa.connected ? '' : (wa.why || 'WhatsApp is not connected yet'), where: 'Administration > Integrations > Connections > WhatsApp Business',
    rehearsal: Comm.isRehearsal(st), testWords: Comm.isRehearsal(st) ? 'Test mode is ON: a reply sent from here is a rehearsal (the message is written down, nothing is sent).' : '',
    masked: A.masked(req.user), staffOnly: k === 'hr', ownOnly: k === 'recruiter',
    mayNew: A.maySendConsole(req.user),
    note: k === 'recruiter' ? 'You see and answer your own candidates only.' : (k === 'hr' ? 'You see staff conversations only.' : ''),
  });
}));

router.get('/list', wrap(async (req, res) => {
  const tab = TAB_CHANNELS[req.query.tab] ? req.query.tab : 'chats';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const digits = q.replace(/\D/g, '');
  const phoneSearch = digits.length >= 3 && !A.masked(req.user) && A.kind(req.user) !== 'recruiter' && /^[\d\s+()-]+$/.test(q);
  const country = ['IN', 'US', 'UK'].includes(String(req.query.country)) ? String(req.query.country) : '';
  const depts = String(req.query.accounts || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const dd = Chrome.deptOf(req.user, req.query.dept);
  const data = await convo.inbox(req.user, { state: 'all', pageSize: 100, q: phoneSearch ? '' : q, department: dd || '' });
  if (!data.ready) return res.json({ ready: false, rows: [], counts: {}, unread: {}, total: 0 });
  let rows = data.rows;
  if (A.kind(req.user) === 'hr') rows = rows.filter((r) => r.personType === 'EMPLOYEE'); // HR: the staff side only
  if (depts.length) rows = rows.filter((r) => depts.includes(String(r.department || '').toLowerCase()));
  const phones = await phonesOf(rows);
  rows = rows.map((r) => ({ ...r, _e164: e164(phones.get(`${r.personType}:${r.personId}`)) }));
  rows = rows.map((r) => ({ ...r, country: countryOf(r._e164) }));
  if (country) rows = rows.filter((r) => r.country === country);
  if (phoneSearch) rows = rows.filter((r) => r._e164 && r._e164.includes(digits.replace(/^0+/, '')));
  const counts = {}; const unread = {};
  Object.keys(TAB_CHANNELS).forEach((t) => { const inTab = rows.filter((r) => TAB_CHANNELS[t].includes(r.channel)); counts[t] = inTab.length; unread[t] = inTab.reduce((n, r) => n + (r.unread || 0), 0); });
  const out = rows.filter((r) => TAB_CHANNELS[tab].includes(r.channel)).map((r) => ({
    id: r.id, personType: r.personType, audience: convo.AUDIENCE_OF[r.personType], personId: r.personId, name: r.name || 'Unknown', initials: initialsOf(r.name), department: r.department || '',
    ownerName: r.ownerName || '', ownerUserId: r.ownerUserId || null, lastAt: r.lastAt, channel: r.channel, direction: r.direction, snippet: r.snippet || '', unread: r.unread || 0, done: !!r.done, country: r.country, numbers: (r.waNumbers || []).map((n) => n.label),
  }));
  res.json({ ready: true, rows: out, counts, unread, total: out.length, truncated: data.total > 100, masked: A.masked(req.user) });
}));

router.get('/profile/:audience/:id', wrap(async (req, res) => {
  const audience = req.params.audience; const type = convo.TYPES[audience];
  if (!type) return res.status(404).json({ error: 'Unknown kind of person.' });
  const rule = await access.ruleFor(req.user, audience);
  if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login.' });
  const id = String(req.params.id);
  if (!(await convo.visibleIds(req.user, type, [id])).has(id)) return res.status(403).json({ error: 'This person is outside your access.' });
  const masked = rule.mode === 'masked' || A.masked(req.user);
  const info = (await convo.personInfo(type, id)) || {};
  const p = ((await require('../utils/messageContext').recipientsFor(req.user, audience, [id], { contactKind: rule.kind })) || [])[0] || {}; // eslint-disable-line global-require
  const thread = await convo.getThread(type, id);
  const tl = await convo.timeline(type, id, { masked, limit: 60, viewer: req.user });
  const activity = tl.slice(-8).reverse().map((m) => ({
    title: m.direction === 'in' ? `${m.stop ? 'Asked us to stop' : 'Replied'} on ${m.channel}` : (m.channel === 'Call' ? 'Call saved' : `You sent ${m.channel === 'Email' ? 'an email' : `a ${m.channel}`}${m.template ? `: ${m.template}` : ''}`),
    at: m.at,
  }));
  let since = null; let lifecycle = type === 'CANDIDATE' ? 'Candidate' : (type === 'CLIENT' ? 'Client' : 'Employee'); let kinds = []; let lastReply = null;
  try {
    if (type === 'CANDIDATE') {
      const c = await prisma.candidate.findUnique({ where: { id }, select: { createdAt: true } });
      since = c ? c.createdAt : null;
      const a = await prisma.application.findFirst({ where: { candidateId: id }, orderBy: { updatedAt: 'desc' }, select: { stage: true } });
      if (a && a.stage) lifecycle = `Candidate · ${String(a.stage).toLowerCase().replace(/_/g, ' ')}`;
    } else if (type === 'CLIENT') {
      const c = await prisma.client.findUnique({ where: { id }, select: { createdAt: true } });
      since = c ? c.createdAt : null;
    }
  } catch { /* the profile still opens */ }
  try {
    if (await S.ready()) {
      const pk = K.phoneOf(p.mobile); const ek = K.emailOf(p.email);
      const hits = await K.findByKeys(pk.ok ? pk.key : null, ek.ok ? ek.key : null);
      if (hits.length) {
        kinds = (await S.q(`SELECT DISTINCT industry FROM "OutreachContactTag" WHERE contactId IN (${hits.map(() => '?').join(',')})`, ...hits.map((h) => h.id))).map((t) => t.industry);
        lastReply = (await Replies.lastReplyOf(hits[0])).at;
      }
    }
  } catch { /* kinds / last reply are optional */ }
  const phone = p.mobile ? (masked ? access.maskedHint(p.mobile) : p.mobile) : '';
  const email = p.email ? (masked ? access.maskedHint(p.email) : p.email) : '';
  res.json({
    name: p.name || info.name || 'Unknown', initials: initialsOf(p.name || info.name), audience, personId: id, department: info.department || '', since,
    phone, email, masked, lifecycle, kinds, lastReply,
    owner: thread && thread.ownerUserId ? { id: thread.ownerUserId, name: thread.ownerName } : null, done: !!(thread && thread.doneAt), unread: thread ? thread.unread : 0, activity,
    doNotContact: !!p.doNotContact,
  });
}));

router.get('/transcript/:audience/:id', wrap(async (req, res) => {
  const audience = req.params.audience; const type = convo.TYPES[audience];
  if (!type) return res.status(404).json({ error: 'Unknown kind of person.' });
  const rule = await access.ruleFor(req.user, audience);
  if (!rule.allowed) return res.status(403).json({ error: rule.reason || 'Not available to this login.' });
  const id = String(req.params.id);
  if (!(await convo.visibleIds(req.user, type, [id])).has(id)) return res.status(403).json({ error: 'This person is outside your access.' });
  const masked = rule.mode === 'masked' || A.masked(req.user);
  const info = (await convo.personInfo(type, id)) || {};
  const tl = await convo.timeline(type, id, { masked, limit: 1000, viewer: req.user });
  if (!tl.length) return res.status(404).json({ error: 'No messages to export' });
  const safe = (v) => require('../outreach/messageLog').safeCell(v); // eslint-disable-line global-require
  const lines = [['From', 'Message'].map(safe).join(',')];
  tl.forEach((m) => lines.push([m.direction === 'in' ? (info.name || 'Contact') : 'You', m.body || m.template || m.stateWord || ''].map(safe).join(',')));
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel inbox chat exported', entity: 'Conversation', entityId: `${type}:${id}`, toValue: `${tl.length} messages${masked ? ' (masked)' : ''}` });
  res.set('Content-Disposition', `attachment; filename="${id}_chat_transcript.csv"`);
  res.type('text/csv; charset=utf-8');
  res.send(`﻿${lines.join('\r\n')}\r\n`);
}));

router.get('/contacts', wrap(async (req, res) => {
  const out = await CS.contacts(req.user, { q: String(req.query.q || '').slice(0, 80), channel: 'whatsapp', page: 1, pageSize: 20 });
  res.json({ rows: out.rows.filter((r) => r.agreed), total: out.total, masked: out.masked });
}));
router.post('/new', limiter({ perMinute: 20 }), wrap(async (req, res) => {
  if (!A.maySendConsole(req.user)) return res.status(403).json({ error: 'Starting a chat is for the BDE team, Team Leads, Marketing, HR and Admins.' });
  const b = req.body || {};
  const out = await Comm.quickSend(req.user, { channel: 'whatsapp', contactId: String(b.contactId || ''), text: b.text, templateLabel: 'Inbox: new conversation' });
  if (out.error) return send(res, out);
  // open the chat when this person is already in the one inbox
  let opened = null;
  try {
    const one = await K.getOne(req.user, String(b.contactId || ''));
    const hit = one && one.row.phoneE164 ? await convo.findByPhone(one.row.phoneE164) : null;
    if (hit && (await convo.visibleIds(req.user, hit.type, [hit.id])).has(hit.id)) opened = { audience: convo.AUDIENCE_OF[hit.type], personId: hit.id };
  } catch { opened = null; }
  return res.json({ ...out, opened });
}));

const PORTAL = () => require('../utils/atsVocab').PORTAL_APPLICATION_SOURCE; // eslint-disable-line global-require
router.get('/applications', wrap(async (req, res) => {
  const rule = await access.ruleFor(req.user, 'candidates');
  const k = A.kind(req.user);
  if (!rule.allowed) return res.json({ allowed: false, why: rule.reason || 'Your role does not follow up candidates.', rows: [], total: 0, waiting: 0 });
  const masked = rule.mode === 'masked' || ['bde', 'bdetl', 'recruiter'].includes(k);
  const where = { AND: [{ source: PORTAL() }, scope.applicationWhere(req.user)] };
  const total = await prisma.application.count({ where });
  const waiting = await prisma.application.count({ where: { AND: [{ source: PORTAL() }, { portalImportedAt: null }, scope.applicationWhere(req.user)] } });
  const rows = await prisma.application.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, createdAt: true, stage: true, portalImportedAt: true, candidate: { select: { id: true, name: true, phone: true, email: true, currentSalary: true, expectedSalary: true, location: true } }, requirement: { select: { id: true, reqCode: true, title: true, department: true, location: true } } },
  });
  res.json({
    allowed: true, masked, total, waiting,
    rows: rows.map((a) => ({
      id: a.id, candidateId: a.candidate ? a.candidate.id : null, name: a.candidate ? a.candidate.name : '', initials: initialsOf(a.candidate && a.candidate.name),
      phone: a.candidate && a.candidate.phone ? (masked ? core.maskMobile(a.candidate.phone) : a.candidate.phone) : '',
      email: a.candidate && a.candidate.email ? (masked ? core.maskEmail(a.candidate.email) : a.candidate.email) : '',
      salary: masked ? null : (a.candidate && (a.candidate.expectedSalary || a.candidate.currentSalary)) || '', location: a.candidate ? a.candidate.location || '' : '',
      job: a.requirement ? a.requirement.title : '', jobCode: a.requirement ? a.requirement.reqCode : '', department: a.requirement ? a.requirement.department || '' : '',
      stage: String(a.stage || '').toLowerCase().replace(/_/g, ' '), appliedAt: a.createdAt, pickedUp: !!a.portalImportedAt,
    })),
  });
}));

module.exports = router;

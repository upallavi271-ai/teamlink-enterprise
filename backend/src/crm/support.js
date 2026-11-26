// ---------------------------------------------------------------------------
// CRM > CUSTOMER SUPPORT (founder 2026-11-02, from the reference CRM: "Customer Support"). A client's issue after the sale -
// a candidate to replace, an invoice question, a change to a requirement, a complaint - is a TICKET:
//   number TKT-0001, subject, what happened, the account / contact, category, how it came in, priority, status, assignee
//   SLA: the reply is due within Urgent 4 h · High 1 day · Medium 2 days · Low 5 days (dueAt); a ticket past it is "late"
//   thread: internal notes, or a reply that is EMAILED to the customer's contact (written on the account's timeline)
//   statuses: Open -> In progress -> Waiting on customer -> Resolved -> Closed (reopen any time)
// Who: a salesperson sees the tickets assigned to them or on their own accounts; a sales manager / Admin / Manager all.
// ---------------------------------------------------------------------------
const DB = require('./schema');
const S = require('./service');

const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const SLA_HOURS = { Urgent: 4, High: 24, Medium: 48, Low: 120 }; // the defaults; a Sales manager changes them (CRM settings, crm/moneyMore.js slaHours)
const slaNow = () => require('./moneyMore').slaHours().catch(() => SLA_HOURS); // eslint-disable-line global-require
const STATUSES = ['Open', 'In progress', 'Waiting on customer', 'Resolved', 'Closed'];
const CATEGORIES = ['Candidate replacement', 'Invoice / payment', 'Requirement change', 'Interview scheduling', 'Candidate joining', 'Complaint', 'Agreement', 'Other'];
const CHANNELS = ['Phone', 'Email', 'WhatsApp', 'Meeting', 'Other'];
const OPEN = ['Open', 'In progress', 'Waiting on customer'];

const scope = (user, r) => (S.seesAll(r)
  ? { sql: '1=1', params: [] }
  : { sql: '(t."ownerId" = ? OR t."accountId" IN (SELECT "id" FROM "CrmAccount" WHERE "ownerId" = ?))', params: [user.id, user.id] });

async function canSeeTicket(user, r, t) {
  if (!t) return false;
  if (S.seesAll(r) || t.ownerId === user.id) return true;
  if (!t.accountId) return t.createdById === user.id;
  const a = await S.getRow('account', t.accountId);
  return !!a && a.ownerId === user.id;
}

const late = (t) => OPEN.includes(t.status) && t.dueAt && t.dueAt < new Date().toISOString();

async function list(user, q = {}) {
  const r = S.roleOf(user);
  const s = scope(user, r);
  const where = [s.sql]; const params = [...s.params];
  if (q.status === 'open' || !q.status) where.push(`t."status" IN (${OPEN.map(() => '?').join(', ')})`), params.push(...OPEN);
  else if (STATUSES.includes(q.status)) { where.push('t."status" = ?'); params.push(q.status); }
  if (PRIORITIES.includes(q.priority)) { where.push('t."priority" = ?'); params.push(q.priority); }
  if (q.owner && S.seesAll(r)) { where.push('t."ownerId" = ?'); params.push(S.clip(q.owner, 60)); }
  if (q.accountId) { where.push('t."accountId" = ?'); params.push(S.clip(q.accountId, 60)); }
  if (q.late === '1') { where.push('t."dueAt" < ?'); params.push(new Date().toISOString()); }
  const text = S.clip(q.q, 80);
  if (text) { where.push('(t."subject" LIKE ? OR t."number" LIKE ? OR a."name" LIKE ?)'); params.push(...Array(3).fill(`%${text}%`)); }
  const rows = await DB.all(`SELECT t.*, a."name" AS "accountName", c."name" AS "contactName",
      (SELECT COUNT(*) FROM "CrmTicketComment" m WHERE m."ticketId" = t."id") AS "comments"
    FROM "CrmTicket" t LEFT JOIN "CrmAccount" a ON a."id" = t."accountId" LEFT JOIN "CrmContact" c ON c."id" = t."contactId"
    WHERE ${where.join(' AND ')}
    ORDER BY CASE t."priority" WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t."dueAt" ASC LIMIT 1000`, ...params);
  rows.forEach((t) => { t.late = late(t); });
  // the numbers on top of the list (whole scope, not just this filter)
  const all = await DB.all(`SELECT t."status", t."priority", t."dueAt", t."resolvedAt", t."createdAt", t."firstReplyAt" FROM "CrmTicket" t WHERE ${s.sql}`, ...s.params);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const resolved30 = all.filter((t) => t.resolvedAt && t.resolvedAt >= since);
  const hours = resolved30.map((t) => (Date.parse(t.resolvedAt) - Date.parse(t.createdAt)) / 3600000);
  const stats = {
    open: all.filter((t) => OPEN.includes(t.status)).length,
    late: all.filter(late).length,
    urgent: all.filter((t) => OPEN.includes(t.status) && t.priority === 'Urgent').length,
    resolved30: resolved30.length,
    avgResolveHours: hours.length ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
    slaMet30: resolved30.length ? Math.round((resolved30.filter((t) => !t.dueAt || (t.firstReplyAt || t.resolvedAt) <= t.dueAt).length / resolved30.length) * 100) : null,
  };
  return S.okBody({ rows, stats });
}

function clean(body, partial) {
  const out = {};
  if (!partial || 'subject' in body) { out.subject = S.clip(body.subject, 200); if (!out.subject) return { error: 'Write what the issue is (subject).' }; }
  if ('description' in body) out.description = S.clip(body.description, 6000);
  if ('category' in body) out.category = CATEGORIES.includes(body.category) ? body.category : (body.category ? 'Other' : null);
  if ('channel' in body) out.channel = CHANNELS.includes(body.channel) ? body.channel : null;
  if (!partial || 'priority' in body) { out.priority = PRIORITIES.includes(body.priority) ? body.priority : 'Medium'; }
  if ('accountId' in body) out.accountId = S.clip(body.accountId, 60);
  if ('contactId' in body) out.contactId = S.clip(body.contactId, 60);
  return { data: out };
}

async function create(user, body = {}) {
  const r = S.roleOf(user);
  if (!S.mayEdit(r)) return S.fail(403, 'Your role can read the CRM but not add to it.');
  const c = clean(body, false);
  if (c.error) return S.fail(400, c.error);
  if (c.data.accountId) { const a = await S.getRow('account', c.data.accountId); if (!S.canSeeRow(user, r, a)) return S.fail(400, 'Pick one of your accounts.'); }
  if (c.data.contactId) { const ct = await S.getRow('contact', c.data.contactId); if (!ct || (c.data.accountId && ct.accountId !== c.data.accountId)) c.data.contactId = null; }
  const own = body.ownerId && S.mayAssign(r) ? (await S.ownerOptions()).find((o) => o.id === body.ownerId) : { id: user.id, name: user.name };
  if (!own) return S.fail(400, 'Pick who handles it from the sales team.');
  const n = ((await DB.one('SELECT COUNT(*) AS "n" FROM "CrmTicket"')) || {}).n + 1;
  const now = DB.nowIso();
  const t = await S.insert('CrmTicket', {
    id: S.newId('tkt'), number: `TKT-${String(n).padStart(4, '0')}`, ...c.data, status: 'Open',
    dueAt: new Date(Date.now() + ((await slaNow())[c.data.priority] || SLA_HOURS[c.data.priority]) * 3600000).toISOString(),
    ownerId: own.id, ownerName: own.name || null, createdById: user.id, createdAt: now, updatedAt: now,
  });
  if (t.accountId) await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Support ticket ${t.number}: ${t.subject}`, note: `${t.priority} priority${t.category ? ` · ${t.category}` : ''}`, at: now, accountId: t.accountId, contactId: t.contactId, byId: user.id, byName: user.name || null, createdAt: now });
  if (own.id !== user.id) await require('../utils/notify').notifyUsers([own.id], { title: `Support ticket ${t.number} is yours`, message: `${t.subject} (${t.priority})` }).catch(() => null); // eslint-disable-line global-require
  await S.audit(user, 'CRM support ticket opened', 'CrmTicket', t.id, `${t.number} ${t.subject}`);
  return S.okBody({ ok: true, ticket: t });
}

async function detail(user, id) {
  const r = S.roleOf(user);
  const t = await DB.one('SELECT * FROM "CrmTicket" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!(await canSeeTicket(user, r, t))) return S.fail(404, 'This ticket is not there, or it is not yours.');
  t.late = late(t);
  const account = t.accountId ? await S.getRow('account', t.accountId) : null;
  const contact = t.contactId ? await S.getRow('contact', t.contactId) : null;
  const contacts = t.accountId ? await DB.all('SELECT "id", "name", "email", "phone", "designation" FROM "CrmContact" WHERE "accountId" = ? ORDER BY "name"', t.accountId) : [];
  const comments = await DB.all('SELECT * FROM "CrmTicketComment" WHERE "ticketId" = ? ORDER BY "createdAt" ASC', t.id);
  return S.okBody({ ticket: t, account, contact, contacts, comments, canEdit: S.mayEdit(r) });
}

async function edit(user, id, body = {}) {
  const r = S.roleOf(user);
  const t = await DB.one('SELECT * FROM "CrmTicket" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!(await canSeeTicket(user, r, t)) || !S.mayEdit(r)) return S.fail(404, 'This ticket is not there, or it is not yours.');
  const c = clean(body, true);
  if (c.error) return S.fail(400, c.error);
  const data = { ...c.data };
  const now = DB.nowIso();
  if (data.priority && data.priority !== t.priority) data.dueAt = new Date(Date.parse(t.createdAt) + ((await slaNow())[data.priority] || SLA_HOURS[data.priority]) * 3600000).toISOString();
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return S.fail(400, 'Pick a status from the list.');
    data.status = body.status;
    if (body.status === 'Resolved' && !t.resolvedAt) data.resolvedAt = now;
    if (body.status === 'Closed') { data.closedAt = now; if (!t.resolvedAt) data.resolvedAt = now; }
    if (OPEN.includes(body.status)) { data.resolvedAt = null; data.closedAt = null; }
  }
  if (body.ownerId && body.ownerId !== t.ownerId) {
    if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin can give a ticket to someone else.');
    const o = (await S.ownerOptions()).find((x) => x.id === body.ownerId);
    if (!o) return S.fail(400, 'Pick who handles it from the sales team.');
    data.ownerId = o.id; data.ownerName = o.name;
    await require('../utils/notify').notifyUsers([o.id], { title: `Support ticket ${t.number} is yours`, message: `${t.subject} (${data.priority || t.priority})`, exceptUserId: user.id }).catch(() => null); // eslint-disable-line global-require
  }
  data.updatedAt = now;
  const saved = await S.update('CrmTicket', t.id, data);
  if (data.status && data.status !== t.status) {
    await S.insert('CrmTicketComment', { id: S.newId('tc'), ticketId: t.id, body: `Status: ${t.status} → ${data.status}`, internal: 1, byId: user.id, byName: user.name || null, createdAt: now });
    await S.audit(user, 'CRM support ticket status', 'CrmTicket', t.id, `${t.number}: ${t.status} -> ${data.status}`);
  }
  return S.okBody({ ok: true, ticket: saved });
}

// A note (internal) or a reply to the customer (emailed to the contact; the first one counts as the first reply for the SLA).
async function comment(user, id, { body, toCustomer, to } = {}) {
  const r = S.roleOf(user);
  const t = await DB.one('SELECT * FROM "CrmTicket" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!(await canSeeTicket(user, r, t)) || !S.mayEdit(r)) return S.fail(404, 'This ticket is not there, or it is not yours.');
  const text = S.clip(body, 6000);
  if (!text) return S.fail(400, 'Write the note or the reply.');
  const now = DB.nowIso();
  let emailedTo = null;
  if (toCustomer) {
    const ct = t.contactId ? await S.getRow('contact', t.contactId) : null;
    const email = S.clip(to, 200) || (ct && ct.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return S.fail(400, 'Who should get the reply? This ticket\'s contact has no email - write the address.');
    const sent = await require('../utils/mailer').sendMail({ // eslint-disable-line global-require
      to: email, subject: `[${t.number}] ${t.subject}`,
      text: `${text}\n\n--\n${user.name || ''}\nTeamLink Consultants\n(Reply to this email about ticket ${t.number}.)`,
    });
    if (!sent || !sent.ok) return S.fail(502, `The reply was not emailed: ${(sent && sent.error) || 'unknown problem'}. Nothing was saved; try again or save it as an internal note.`);
    emailedTo = email;
  }
  const c = await S.insert('CrmTicketComment', { id: S.newId('tc'), ticketId: t.id, body: text, internal: toCustomer ? 0 : 1, emailedTo, byId: user.id, byName: user.name || null, createdAt: now });
  const data = { updatedAt: now };
  if (toCustomer && !t.firstReplyAt) data.firstReplyAt = now;
  if (toCustomer && t.status === 'Open') data.status = 'In progress';
  await S.update('CrmTicket', t.id, data);
  if (toCustomer && t.accountId) await S.insert('CrmActivity', { id: S.newId('act'), kind: 'email', subject: `Reply on ${t.number}: ${t.subject}`, note: text.slice(0, 500), at: now, accountId: t.accountId, contactId: t.contactId, byId: user.id, byName: user.name || null, createdAt: now });
  return S.okBody({ ok: true, comment: c });
}

module.exports = { list, create, detail, edit, comment, PRIORITIES, STATUSES, CATEGORIES, CHANNELS, SLA_HOURS, OPEN, slaNow };

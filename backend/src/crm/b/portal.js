// ---------------------------------------------------------------------------
// CRM WAVE B - CUSTOMER PORTAL (12.01 12.02 12.03 12.04 12.06)
//   portal logins  a customer's contact (or a partner) is invited from the CRM; they set a password from the link and sign in at /crm-portal
//                  (its own login page like the client portal: CrmPortalUser + a server-side session, never a staff login). Switch "Customer
//                  and partner portal" - until it is on nobody can sign in.
//   customer sees  their own company's proposals (open the PDF, accept / decline), invoices (PDF, paid / due), tickets (raise one, follow it,
//                  write in it), the help articles, and answer a survey
//   partner sees   the deals they registered and what became of them; registers a new one (a duplicate of a company already in the CRM is
//                  said so); a Sales manager accepts it (-> a lead for the partner's owner) or rejects it with a reason
//   knowledge base help articles written by the team: draft / published; shown in the portal and on a public help page
//   surveys        NPS (0-10) or CSAT (1-5) by a link; a low score tells the owner and makes a follow-up; "send by itself" after a won
//                  deal / a closed ticket only with switch "Surveys ... go by themselves"
// Everything a portal login reads is fenced by its own accountId / resellerId from the session row - never from the request.
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const C = require('./common');

const { S, B, clip, esc } = C;
const SESSION_DAYS = 7;

// ================================================================== staff: portal logins
async function portalUsers(user, { accountId, resellerId } = {}) {
  const where = []; const params = [];
  if (accountId) { const a = await C.visible(user, 'account', accountId); if (!a) return S.fail(404, 'This account is not there, or it is not yours.'); where.push('u."accountId" = ?'); params.push(a.id); }
  if (resellerId) { where.push('u."resellerId" = ?'); params.push(String(resellerId)); }
  if (!accountId && !resellerId && !C.isManager(user)) { where.push('(u."accountId" IN (SELECT "id" FROM "CrmAccount" WHERE "ownerId" = ?) OR u."byId" = ?)'); params.push(user.id, user.id); }
  const rows = await B.all(`SELECT u."id", u."type", u."accountId", u."contactId", u."resellerId", u."email", u."name", u."status", u."lastLoginAt", u."inviteUntil", u."createdAt", a."name" AS "accountName", r."name" AS "resellerName"
    FROM "CrmPortalUser" u LEFT JOIN "CrmAccount" a ON a."id" = u."accountId" LEFT JOIN "CrmReseller" r ON r."id" = u."resellerId" WHERE ${where.join(' AND ') || '1=1'} ORDER BY u."createdAt" DESC LIMIT 300`, ...params);
  return S.okBody({ users: rows, on: await B.on('portal'), loginUrl: `${String(process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '')}/crm-portal` });
}
async function invite(user, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const type = body.type === 'partner' ? 'partner' : 'customer';
  let accountId = null; let contactId = null; let resellerId = null; let email = C.lower(body.email); let name = clip(body.name, 120);
  if (type === 'customer') {
    const a = await C.editable(user, 'account', body.accountId);
    if (!a) return S.fail(404, 'Pick one of your accounts.');
    accountId = a.id;
    if (body.contactId) {
      const ct = await S.getRow('contact', body.contactId);
      if (!ct || ct.accountId !== a.id) return S.fail(400, 'That contact is not on this account.');
      contactId = ct.id; email = email || C.lower(ct.email); name = name || ct.name;
    }
  } else {
    if (!C.isManager(user)) return S.fail(403, 'Partners are invited by a Sales manager or an Admin.');
    const r = await B.one('SELECT * FROM "CrmReseller" WHERE "id" = ?', String(body.resellerId || ''));
    if (!r) return S.fail(404, 'Pick the partner.');
    resellerId = r.id; email = email || C.lower(r.email); name = name || r.contactName || r.name;
  }
  if (!C.validEmail(email)) return S.fail(400, 'Write the email address they will sign in with.');
  const tok = C.token(24);
  const until = new Date(Date.now() + 7 * 86400000).toISOString();
  const now = B.nowIso();
  const had = await B.one('SELECT * FROM "CrmPortalUser" WHERE "email" = ? AND "type" = ?', email, type);
  if (had) {
    if (had.accountId && accountId && had.accountId !== accountId) return S.fail(409, 'This email already signs in for another company.');
    await B.run('UPDATE "CrmPortalUser" SET "inviteHash" = ?, "inviteUntil" = ?, "status" = CASE WHEN "status" = \'Removed\' THEN \'Invited\' ELSE "status" END, "name" = COALESCE(?, "name"), "updatedAt" = ? WHERE "id" = ?', C.sha(tok), until, name, now, had.id);
  } else {
    await B.run('INSERT INTO "CrmPortalUser" ("id","type","accountId","contactId","resellerId","email","name","inviteHash","inviteUntil","status","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,\'Invited\',?,?,?,?)', C.newId('pu'), type, accountId, contactId, resellerId, email, name, C.sha(tok), until, user.id, user.name || null, now, now);
  }
  const front = String(process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const link = `${front}/crm-portal?invite=${tok}`;
  let mailed = false; let mailError = null;
  if (body.send !== false) {
    const own = await require('../../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
    const text = `Hello${name ? ` ${String(name).split(' ')[0]}` : ''},\n\n${type === 'customer' ? 'You can now see your quotes, invoices and support tickets with TeamLink Consultants online.' : 'You can now register the deals you bring to TeamLink Consultants online and follow them.'}\n\nSet your password here (the link works for 7 days):\n${link}\n\nAfter that, sign in at ${front}/crm-portal\n\nRegards,\n${user.name || 'TeamLink Consultants'}`;
    const r = await require('../../utils/messaging').send('Email', { to: email, subject: `Your ${type === 'customer' ? 'customer' : 'partner'} portal at TeamLink Consultants`, text, senderEmail: own.email || undefined, senderName: own.name || user.name, actorUserId: user.id, meta: { audience: 'crm', purpose: 'CRM portal invite', senderUserId: user.id } }); // eslint-disable-line global-require
    mailed = !!r.ok; mailError = r.ok ? null : r.error;
  }
  await S.audit(user, 'CRM portal login invited', 'CrmPortalUser', email, `${type} ${email}`);
  return S.okBody({ ok: true, link, mailed, mailError, portalOn: await B.on('portal') });
}
async function removeUser(user, id) {
  const u = await B.one('SELECT * FROM "CrmPortalUser" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!u) return S.fail(404, 'This login is not there.');
  if (u.accountId) { if (!(await C.editable(user, 'account', u.accountId))) return S.fail(404, 'This login is not there.'); } else if (!C.isManager(user)) return S.fail(403, 'A Sales manager removes a partner login.');
  await B.run('UPDATE "CrmPortalUser" SET "status" = \'Removed\', "passwordHash" = NULL, "inviteHash" = NULL WHERE "id" = ?', u.id);
  await B.run('DELETE FROM "CrmPortalSession" WHERE "userId" = ?', u.id);
  await S.audit(user, 'CRM portal login removed', 'CrmPortalUser', u.id, u.email);
  return S.okBody({ ok: true });
}

// ================================================================== the portal itself (no staff login)
async function newSession(u) {
  const tok = C.token(32);
  await B.run('INSERT INTO "CrmPortalSession" ("tokenHash","userId","expiresAt","createdAt") VALUES (?,?,?,?)', C.sha(tok), u.id, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), B.nowIso());
  await B.run('UPDATE "CrmPortalUser" SET "lastLoginAt" = ? WHERE "id" = ?', B.nowIso(), u.id);
  return tok;
}
const shapeMe = async (u) => {
  const a = u.accountId ? await S.getRow('account', u.accountId) : null;
  const r = u.resellerId ? await B.one('SELECT "name" FROM "CrmReseller" WHERE "id" = ?', u.resellerId) : null;
  return { name: u.name, email: u.email, type: u.type, company: (a && a.name) || (r && r.name) || '' };
};
async function login({ email, password, type } = {}) {
  if (!(await B.on('portal'))) return { status: 403, body: { error: 'The portal is not open yet. Please contact your account manager.' } };
  const t = type === 'partner' ? 'partner' : 'customer';
  const u = await B.one('SELECT * FROM "CrmPortalUser" WHERE "email" = ? AND "type" = ? AND "status" = \'Active\'', C.lower(email), t);
  const ok = !!u && !!u.passwordHash && await bcrypt.compare(String(password || ''), u.passwordHash);
  if (!ok) return { status: 401, body: { error: 'The email or the password is not right.' } };
  return { status: 200, body: { token: await newSession(u), me: await shapeMe(u) } };
}
async function acceptInvite({ invite: tok, password } = {}) {
  if (!(await B.on('portal'))) return { status: 403, body: { error: 'The portal is not open yet. Please contact your account manager.' } };
  const pw = String(password || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return { status: 400, body: { error: 'Use at least 8 characters with letters and a number.' } };
  const u = await B.one('SELECT * FROM "CrmPortalUser" WHERE "inviteHash" = ? AND "status" != \'Removed\'', C.sha(String(tok || '')));
  if (!u || Date.parse(u.inviteUntil || 0) < Date.now()) return { status: 400, body: { error: 'This link has expired. Ask your account manager to send it again.' } };
  await B.run('UPDATE "CrmPortalUser" SET "passwordHash" = ?, "inviteHash" = NULL, "inviteUntil" = NULL, "status" = \'Active\', "updatedAt" = ? WHERE "id" = ?', await bcrypt.hash(pw, 10), B.nowIso(), u.id);
  return { status: 200, body: { token: await newSession(u), me: await shapeMe(u) } };
}
async function sessionUser(tok) {
  if (!tok) return null;
  const s = await B.one('SELECT * FROM "CrmPortalSession" WHERE "tokenHash" = ?', C.sha(String(tok)));
  if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
  const u = await B.one('SELECT * FROM "CrmPortalUser" WHERE "id" = ? AND "status" = \'Active\'', s.userId);
  if (!u || !(await B.on('portal'))) return null;
  return u;
}
async function logout(tok) { await B.run('DELETE FROM "CrmPortalSession" WHERE "tokenHash" = ?', C.sha(String(tok || ''))); return { status: 200, body: { ok: true } }; }
const ok = (body) => ({ status: 200, body });
const bad = (status, error) => ({ status, body: { error } });

async function me(u) { return ok({ me: await shapeMe(u) }); }
async function quotes(u) {
  if (u.type !== 'customer') return bad(403, 'Not for this login.');
  const rows = await B.all('SELECT p."id", p."number", p."status", p."sentAt", p."decidedAt", p."dataJson", d."title" FROM "CrmProposal" p LEFT JOIN "CrmDeal" d ON d."id" = p."dealId" WHERE (p."accountId" = ? OR d."accountId" = ?) AND p."status" != \'Draft\' ORDER BY p."createdAt" DESC LIMIT 100', u.accountId, u.accountId);
  return ok({ quotes: rows.map((p) => { const d = C.json(p.dataJson, {}); return { id: p.id, number: p.number, status: p.status, sentAt: p.sentAt, decidedAt: p.decidedAt, title: p.title, validUntil: d.validUntil || null, total: d.total || d.value || null }; }) });
}
async function quoteOf(u, id) {
  if (u.type !== 'customer') return null;
  return B.one('SELECT p.* FROM "CrmProposal" p LEFT JOIN "CrmDeal" d ON d."id" = p."dealId" WHERE p."id" = ? AND (p."accountId" = ? OR d."accountId" = ?) AND p."status" != \'Draft\'', String(id || '').slice(0, 60), u.accountId, u.accountId);
}
async function decideQuote(u, id, { decision } = {}, { ip } = {}) {
  const p = await quoteOf(u, id);
  if (!p) return bad(404, 'This quote is not there.');
  const X = require('../extra'); // eslint-disable-line global-require
  const out = await X.decideByCustomer(p.id, String(decision || ''), { ip });
  if (out.error) return bad(400, out.error);
  await C.systemActivity({ dealId: p.dealId, accountId: u.accountId }, { kind: 'note', subject: `Proposal ${p.number} ${out.status ? String(out.status).toLowerCase() : 'answered'} in the customer portal`, byName: u.name || u.email });
  return ok({ ok: true, status: out.status });
}
async function invoices(u) {
  if (u.type !== 'customer') return bad(403, 'Not for this login.');
  const rows = await B.all('SELECT "id", "code", "title", "status", "issueDate", "dueDate", "total", "paidAmount" FROM "CrmInvoice" WHERE "accountId" = ? AND "status" != \'Draft\' ORDER BY "issueDate" DESC LIMIT 100', u.accountId);
  return ok({ invoices: rows.map((i) => ({ ...i, due: Math.max(0, (Number(i.total) || 0) - (Number(i.paidAmount) || 0)) })) });
}
async function invoiceOf(u, id) {
  if (u.type !== 'customer') return null;
  return B.one('SELECT * FROM "CrmInvoice" WHERE "id" = ? AND "accountId" = ? AND "status" != \'Draft\'', String(id || '').slice(0, 60), u.accountId);
}
// 12.02 the customer's own tickets
async function tickets(u) {
  if (u.type !== 'customer') return bad(403, 'Not for this login.');
  return ok({ tickets: await B.all('SELECT "id", "number", "subject", "status", "priority", "createdAt", "updatedAt", "dueAt", "resolvedAt" FROM "CrmTicket" WHERE "accountId" = ? ORDER BY "createdAt" DESC LIMIT 100', u.accountId) });
}
async function ticketOf(u, id) {
  if (u.type !== 'customer') return null;
  return B.one('SELECT * FROM "CrmTicket" WHERE "id" = ? AND "accountId" = ?', String(id || '').slice(0, 60), u.accountId);
}
async function ticket(u, id) {
  const t = await ticketOf(u, id);
  if (!t) return bad(404, 'This ticket is not there.');
  const comments = await B.all('SELECT "body", "byName", "createdAt", "internal" FROM "CrmTicketComment" WHERE "ticketId" = ? AND "internal" = 0 ORDER BY "createdAt"', t.id);
  return ok({ ticket: { id: t.id, number: t.number, subject: t.subject, description: t.description, status: t.status, priority: t.priority, createdAt: t.createdAt }, comments: comments.map((c) => ({ body: c.body, by: c.byName, at: c.createdAt })) });
}
async function raiseTicket(u, body = {}) {
  if (u.type !== 'customer') return bad(403, 'Not for this login.');
  const SUP = require('../support'); // eslint-disable-line global-require
  const subject = clip(body.subject, 200); const description = clip(body.description, 4000);
  if (!subject) return bad(400, 'Write what it is about.');
  const priority = ['High', 'Medium', 'Low'].includes(body.priority) ? body.priority : 'Medium';
  const recent = await B.one('SELECT COUNT(*) AS "n" FROM "CrmTicket" WHERE "portalUserId" = ? AND "createdAt" >= ?', u.id, new Date(Date.now() - 3600000).toISOString());
  if (Number(recent.n) >= 10) return bad(429, 'Too many tickets in an hour. Please write in an open ticket.');
  const acc = await S.getRow('account', u.accountId);
  const n = Number(((await B.one('SELECT COUNT(*) AS "n" FROM "CrmTicket"')) || {}).n) + 1;
  const now = B.nowIso();
  const t = await S.insert('CrmTicket', {
    id: S.newId('tkt'), number: `TKT-${String(n).padStart(4, '0')}`, subject, description, accountId: u.accountId, contactId: u.contactId || null, category: SUP.CATEGORIES.includes(body.category) ? body.category : 'Other', channel: 'Other',
    priority, status: 'Open', dueAt: new Date(Date.now() + ((await SUP.slaNow())[priority] || SUP.SLA_HOURS[priority]) * 3600000).toISOString(), ownerId: acc ? acc.ownerId : null, ownerName: acc ? acc.ownerName : null, createdById: null, createdAt: now, updatedAt: now,
  });
  await B.run('UPDATE "CrmTicket" SET "portalUserId" = ? WHERE "id" = ?', u.id, t.id);
  await C.systemActivity({ accountId: u.accountId, contactId: u.contactId }, { kind: 'note', subject: `Support ticket ${t.number} raised in the customer portal: ${subject}`, note: `${priority} priority`, byName: u.name || u.email });
  const tell = acc && acc.ownerId ? [acc.ownerId] : await C.managers();
  await C.notify(tell, `New ticket from ${acc ? acc.name : u.email}: ${subject}`.slice(0, 170), `${t.number} (${priority}). Open: /crm/accounts?tab=tickets`, `crm-b-tkt|${t.id}`);
  return ok({ ok: true, ticket: { id: t.id, number: t.number } });
}
async function ticketComment(u, id, body = {}) {
  const t = await ticketOf(u, id);
  if (!t) return bad(404, 'This ticket is not there.');
  const text = clip(body.body, 4000);
  if (!text) return bad(400, 'Write your message.');
  const now = B.nowIso();
  await B.run('INSERT INTO "CrmTicketComment" ("id","ticketId","body","internal","byId","byName","createdAt") VALUES (?,?,?,0,NULL,?,?)', S.newId('tc'), t.id, text, `${u.name || u.email} (customer)`, now);
  const reopen = ['Resolved', 'Closed', 'Waiting on customer'].includes(t.status);
  await B.run('UPDATE "CrmTicket" SET "status" = CASE WHEN ? = 1 THEN \'Open\' ELSE "status" END, "updatedAt" = ? WHERE "id" = ?', reopen ? 1 : 0, now, t.id);
  if (t.ownerId) await C.notify([t.ownerId], `${t.number}: the customer wrote`, `${text.slice(0, 200)}\nOpen: /crm/accounts?tab=tickets`, `crm-b-tc|${t.id}`);
  return ok({ ok: true });
}

// ================================================================== 12.03 knowledge base
async function kbList(user) {
  const rows = await B.all('SELECT * FROM "CrmKbArticle" ORDER BY "category", "title" COLLATE NOCASE');
  return S.okBody({ articles: rows, canEdit: C.canWork(user), publicUrl: `${C.baseUrl()}/api/crm-public/b/kb` });
}
async function kbSave(user, id, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const title = clip(body.title, 200); const text = clip(body.body, 20000);
  if (!title) return S.fail(400, 'Give the article a title.');
  if (!text) return S.fail(400, 'Write the article.');
  const published = body.published === true && C.isManager(user) ? 1 : (body.published === true ? 0 : 0);
  const now = B.nowIso();
  if (id) {
    const a = await B.one('SELECT * FROM "CrmKbArticle" WHERE "id" = ?', String(id).slice(0, 60));
    if (!a) return S.fail(404, 'This article is not there.');
    await B.run('UPDATE "CrmKbArticle" SET "title" = ?, "category" = ?, "body" = ?, "published" = ?, "updatedAt" = ? WHERE "id" = ?', title, clip(body.category, 80), text, C.isManager(user) ? (body.published === true ? 1 : 0) : a.published, now, a.id);
    return S.okBody({ ok: true, id: a.id, published: C.isManager(user) ? body.published === true : !!a.published });
  }
  const aid = C.newId('kb');
  await B.run('INSERT INTO "CrmKbArticle" ("id","title","category","body","published","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)', aid, title, clip(body.category, 80), text, published, user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: aid, published: !!published, note: published || !body.published ? undefined : 'Saved as a draft: a Sales manager publishes it.' });
}
async function kbRemove(user, id) {
  const no = C.needManager(user); if (no) return no;
  await B.run('DELETE FROM "CrmKbArticle" WHERE "id" = ?', String(id || '').slice(0, 60));
  return S.okBody({ ok: true });
}
async function kbPublic({ q } = {}) {
  const t = clip(q, 80);
  const rows = await B.all(`SELECT "id", "title", "category", "body", "views", "updatedAt" FROM "CrmKbArticle" WHERE "published" = 1${t ? ' AND ("title" LIKE ? OR "body" LIKE ?)' : ''} ORDER BY "category", "title" COLLATE NOCASE LIMIT 300`, ...(t ? [`%${t}%`, `%${t}%`] : []));
  return rows.map((a) => ({ ...a, body: undefined, excerpt: String(a.body).slice(0, 180) }));
}
async function kbArticle(id, { count = true } = {}) {
  const a = await B.one('SELECT * FROM "CrmKbArticle" WHERE "id" = ? AND "published" = 1', String(id || '').slice(0, 60));
  if (a && count) await B.run('UPDATE "CrmKbArticle" SET "views" = "views" + 1 WHERE "id" = ?', a.id);
  return a;
}
async function kbHelpful(id, yes) {
  const a = await kbArticle(id, { count: false });
  if (!a) return false;
  await B.run(`UPDATE "CrmKbArticle" SET "${yes ? 'helpfulYes' : 'helpfulNo'}" = "${yes ? 'helpfulYes' : 'helpfulNo'}" + 1 WHERE "id" = ?`, a.id);
  return true;
}
function kbHtml(list, article, q) {
  if (article) return C.page(article.title, `<p class="muted"><a href="?">Help articles</a>${article.category ? ` · ${esc(article.category)}` : ''}</p><h1>${esc(article.title)}</h1>${String(article.body).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}<form method="post" action="?a=${esc(article.id)}" class="row"><span class="muted" style="align-self:center">Did this help?</span><button name="yes" value="1">Yes</button><button name="yes" value="0" style="background:#fff;color:#1b2a4a;border:1px solid #cfd6e3">No</button></form>`, { wide: true });
  const groups = {};
  list.forEach((a) => { (groups[a.category || 'General'] = groups[a.category || 'General'] || []).push(a); });
  const body = Object.entries(groups).map(([g, arr]) => `<h3 style="margin:18px 0 6px">${esc(g)}</h3>${arr.map((a) => `<p style="margin:0 0 8px"><a href="?a=${esc(a.id)}">${esc(a.title)}</a><br><span class="muted">${esc(a.excerpt)}</span></p>`).join('')}`).join('') || '<p>No articles yet.</p>';
  return C.page('Help articles', `<h1>Help articles</h1><form method="get"><input name="q" value="${esc(q || '')}" placeholder="Search the help articles" aria-label="Search"></form>${body}`, { wide: true });
}

// ================================================================== 12.04 partners / resellers
async function resellers(user) {
  const rows = await B.all('SELECT r.*, (SELECT COUNT(*) FROM "CrmResellerDeal" d WHERE d."resellerId" = r."id") AS "deals", (SELECT COUNT(*) FROM "CrmResellerDeal" d WHERE d."resellerId" = r."id" AND d."status" = \'Submitted\') AS "waiting" FROM "CrmReseller" r ORDER BY r."name" COLLATE NOCASE');
  const deals = await B.all('SELECT d.*, r."name" AS "resellerName" FROM "CrmResellerDeal" d JOIN "CrmReseller" r ON r."id" = d."resellerId" ORDER BY CASE d."status" WHEN \'Submitted\' THEN 0 ELSE 1 END, d."createdAt" DESC LIMIT 300');
  return S.okBody({ resellers: rows, deals, canEdit: C.isManager(user) });
}
async function saveReseller(user, id, body = {}) {
  const no = C.needManager(user); if (no) return no;
  const name = clip(body.name, 150);
  if (!name) return S.fail(400, 'Write the partner\'s company name.');
  const email = body.email ? C.lower(body.email) : null;
  if (email && !C.validEmail(email)) return S.fail(400, 'That email does not look right.');
  const pct = body.commissionPercent === '' || body.commissionPercent == null ? null : Number(body.commissionPercent);
  if (pct != null && !(pct >= 0 && pct <= 100)) return S.fail(400, 'Commission is a percent from 0 to 100.');
  const own = body.ownerId ? (await S.ownerOptions()).find((o) => o.id === body.ownerId) : { id: user.id, name: user.name };
  const now = B.nowIso();
  const data = [name, clip(body.contactName, 120), email, clip(body.phone, 40), clip(body.city, 60), pct, body.status === 'Paused' ? 'Paused' : 'Active', own ? own.id : user.id, own ? own.name : user.name];
  if (id) {
    await B.run('UPDATE "CrmReseller" SET "name" = ?, "contactName" = ?, "email" = ?, "phone" = ?, "city" = ?, "commissionPercent" = ?, "status" = ?, "ownerId" = ?, "ownerName" = ?, "updatedAt" = ? WHERE "id" = ?', ...data, now, String(id).slice(0, 60));
    return S.okBody({ ok: true, id });
  }
  const rid = C.newId('rs');
  await B.run('INSERT INTO "CrmReseller" ("id","name","contactName","email","phone","city","commissionPercent","status","ownerId","ownerName","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rid, ...data, user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: rid });
}
async function partnerDeals(u) {
  if (u.type !== 'partner') return bad(403, 'Not for this login.');
  return ok({ deals: await B.all('SELECT "id", "company", "contactName", "value", "status", "reason", "createdAt", "decidedAt" FROM "CrmResellerDeal" WHERE "resellerId" = ? ORDER BY "createdAt" DESC LIMIT 200', u.resellerId) });
}
async function registerDeal(u, body = {}) {
  if (u.type !== 'partner') return bad(403, 'Not for this login.');
  const r = await B.one('SELECT * FROM "CrmReseller" WHERE "id" = ?', u.resellerId);
  if (!r || r.status !== 'Active') return bad(403, 'Your partner account is paused. Please contact us.');
  const company = clip(body.company, 200);
  if (!company) return bad(400, 'Write the company name.');
  if (!clip(body.phone, 40) && !C.validEmail(body.email)) return bad(400, 'Write the contact\'s phone or email.');
  const value = body.value === '' || body.value == null ? null : Number(String(body.value).replace(/[, ]/g, ''));
  const dups = await S.duplicatesOf({ company, phone: body.phone, email: body.email }).catch(() => []);
  const already = await B.one('SELECT "id" FROM "CrmResellerDeal" WHERE LOWER("company") = ? AND "status" IN (\'Submitted\', \'Accepted\')', C.lower(company));
  const status = dups.length || already ? 'Duplicate' : 'Submitted';
  const now = B.nowIso(); const id = C.newId('rd');
  await B.run('INSERT INTO "CrmResellerDeal" ("id","resellerId","company","contactName","phone","email","value","notes","status","reason","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, r.id, company, clip(body.contactName, 120), clip(body.phone, 40), C.validEmail(body.email) ? C.lower(body.email) : null, Number.isFinite(value) ? value : null, clip(body.notes, 2000), status, status === 'Duplicate' ? 'This company is already with us.' : null, now, now);
  if (status === 'Submitted') await C.notify(r.ownerId ? [r.ownerId] : await C.managers(), `Partner deal from ${r.name}: ${company}`, 'Open: /crm/accounts?tab=portal', `crm-b-rd|${id}`);
  return ok({ ok: true, id, status, note: status === 'Duplicate' ? 'This company is already with us, so it is not registered as your deal. Please talk to your partner manager.' : 'Registered. We will tell you once it is accepted.' });
}
async function decideDeal(user, id, { decision, reason } = {}) {
  const no = C.needManager(user); if (no) return no;
  const d = await B.one('SELECT * FROM "CrmResellerDeal" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!d) return S.fail(404, 'This deal is not there.');
  if (!['Submitted', 'Duplicate'].includes(d.status)) return S.fail(400, `It is ${String(d.status).toLowerCase()} already.`);
  const r = await B.one('SELECT * FROM "CrmReseller" WHERE "id" = ?', d.resellerId);
  const now = B.nowIso();
  if (decision === 'accept') {
    const l = await C.makeLead({ company: d.company, name: d.contactName, phone: d.phone, email: d.email, source: 'Referral', notes: `Registered by partner ${r ? r.name : ''}${d.notes ? `\n${d.notes}` : ''}`, utm: { utmSource: 'partner', utmCampaign: r ? r.name : null }, byName: `Partner ${r ? r.name : ''}`, ownerId: r ? r.ownerId : null });
    if (l.error) return S.fail(400, l.error);
    if (d.value && l.lead && !l.duplicate) await B.run('UPDATE "CrmLead" SET "expectedValue" = ? WHERE "id" = ?', d.value, l.lead.id);
    await B.run('UPDATE "CrmResellerDeal" SET "status" = \'Accepted\', "leadId" = ?, "decidedById" = ?, "decidedAt" = ?, "updatedAt" = ? WHERE "id" = ?', l.lead ? l.lead.id : null, user.id, now, now, d.id);
    return S.okBody({ ok: true, leadId: l.lead && l.lead.id });
  }
  const why = clip(reason, 300);
  if (!why) return S.fail(400, 'Write why, the partner sees it.');
  await B.run('UPDATE "CrmResellerDeal" SET "status" = \'Rejected\', "reason" = ?, "decidedById" = ?, "decidedAt" = ?, "updatedAt" = ? WHERE "id" = ?', why, user.id, now, now, d.id);
  return S.okBody({ ok: true });
}

// ================================================================== 12.06 NPS / CSAT surveys
const QUESTIONS = {
  nps: 'How likely are you to recommend TeamLink Consultants to a friend or colleague?',
  csat: 'How happy are you with how we handled this?',
};
async function surveyTarget(kind, row) {
  if (kind === 'ticket') { const ct = row.contactId ? await S.getRow('contact', row.contactId) : null; const acc = row.accountId ? await S.getRow('account', row.accountId) : null; return { email: (ct && ct.email) || (acc && acc.email), name: (ct && ct.name) || (acc && acc.name), accountId: row.accountId, ownerId: row.ownerId, about: `ticket ${row.number}` }; }
  if (kind === 'deal') { const ct = row.contactId ? await S.getRow('contact', row.contactId) : null; const acc = row.accountId ? await S.getRow('account', row.accountId) : null; return { email: (ct && ct.email) || (acc && acc.email), name: (ct && ct.name) || '', accountId: row.accountId, ownerId: row.ownerId, about: row.title }; }
  if (kind === 'account') { const ct = await B.one('SELECT * FROM "CrmContact" WHERE "accountId" = ? AND "email" IS NOT NULL ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 ELSE 1 END LIMIT 1', row.id); return { email: (ct && ct.email) || row.email, name: (ct && ct.name) || '', accountId: row.id, ownerId: row.ownerId, about: row.name }; }
  if (kind === 'contact') return { email: row.email, name: row.name, accountId: row.accountId, ownerId: row.ownerId, about: row.name };
  return { email: row.email, name: row.contactName, accountId: row.accountId, ownerId: row.ownerId, about: row.company };
}
async function sendSurvey(user, body = {}, { auto = false } = {}) {
  const type = body.type === 'csat' ? 'csat' : 'nps';
  const kind = String(body.kind || '');
  let row = null;
  if (kind === 'ticket') row = await B.one('SELECT * FROM "CrmTicket" WHERE "id" = ?', String(body.id || '').slice(0, 60));
  else row = auto ? await S.getRow(kind, body.id) : await C.visible(user, kind, body.id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  if (!auto && !C.canWork(user)) return C.no('Your role can read the CRM but not change it.');
  const t = await surveyTarget(kind, row);
  const email = C.lower(body.email || t.email);
  if (!C.validEmail(email)) return S.fail(400, 'There is no email address to send the survey to.');
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  if (await CMP.optedOut('email', email)) return S.fail(409, 'This address asked not to be emailed.');
  const tok = C.token(18); const now = B.nowIso();
  const link = `${C.baseUrl()}/api/crm-public/b/s/${tok}`;
  const text = `Hello${t.name ? ` ${String(t.name).split(' ')[0]}` : ''},\n\n${QUESTIONS[type]}${type === 'csat' && t.about ? ` (${t.about})` : ''}\n\nOne click is enough:\n${link}\n\nThank you,\n${auto ? 'TeamLink Consultants' : (user.name || 'TeamLink Consultants')}`;
  const res = await require('../../utils/messaging').send('Email', { to: email, subject: type === 'nps' ? 'One question for you' : 'How did we do?', text, ...(auto ? {} : { actorUserId: user.id }), meta: { audience: 'crm', purpose: `CRM survey (${type})`, ...(auto ? {} : { senderUserId: user.id }) } }); // eslint-disable-line global-require
  if (!res.ok) return S.fail(res.notConfigured ? 409 : 502, res.notConfigured ? `Email is not connected: ${res.error}` : `The survey was not sent: ${res.error || 'refused'}`);
  await B.run('INSERT INTO "CrmSurveyAsk" ("id","token","type","about","kind","recordId","accountId","email","name","sentAt","byId","byName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', C.newId('sv'), tok, type, clip(t.about, 200), kind, row.id, t.accountId || null, email, clip(t.name, 120), now, auto ? null : user.id, auto ? 'Automatic' : (user.name || null), now);
  const links = kind === 'ticket' ? { accountId: t.accountId } : C.linksFor(kind, row);
  await C.systemActivity(links, { kind: 'email', subject: `${type === 'nps' ? 'NPS' : 'CSAT'} survey sent to ${email}`, byId: auto ? null : user.id, byName: auto ? 'Automatic' : user.name });
  return S.okBody({ ok: true, link, sandbox: !!res.sandbox });
}
async function surveyOfToken(tok) { return B.one('SELECT * FROM "CrmSurveyAsk" WHERE "token" = ?', String(tok || '').slice(0, 60)); }
async function answerSurvey(tok, { score, comment } = {}) {
  const s = await surveyOfToken(tok);
  if (!s) return { error: 'This link is not valid.', status: 404 };
  if (s.answeredAt) return { s, already: true };
  const max = s.type === 'nps' ? 10 : 5; const min = s.type === 'nps' ? 0 : 1;
  const n = Math.round(Number(score));
  if (!(n >= min && n <= max)) return { s, error: `Pick a number from ${min} to ${max}.`, status: 400 };
  await B.run('UPDATE "CrmSurveyAsk" SET "score" = ?, "comment" = ?, "answeredAt" = ? WHERE "id" = ?', n, clip(comment, 2000), B.nowIso(), s.id);
  const low = s.type === 'nps' ? n <= 6 : n <= 2;
  const links = s.kind === 'ticket' ? { accountId: s.accountId } : (s.kind === 'lead' ? { leadId: s.recordId } : (s.kind === 'deal' ? { dealId: s.recordId, accountId: s.accountId } : (s.kind === 'contact' ? { contactId: s.recordId, accountId: s.accountId } : { accountId: s.recordId })));
  await C.systemActivity(links, { kind: 'note', subject: `${s.type === 'nps' ? 'NPS' : 'CSAT'} answer: ${n}/${max}${low ? ' (unhappy)' : ''}`, note: clip(comment, 2000), byName: s.name || s.email });
  if (low) {
    const acc = s.accountId ? await S.getRow('account', s.accountId) : null;
    const ownerId = acc ? acc.ownerId : null;
    await C.notify(ownerId ? [ownerId] : await C.managers(), `Unhappy customer: ${s.name || s.email} gave ${n}/${max}`, `${comment ? `"${String(comment).slice(0, 200)}"\n` : ''}Call them back. Open: /crm/accounts${acc ? `?open=account:${acc.id}` : ''}`, `crm-b-svlow|${s.id}`);
    if (acc && acc.ownerId) {
      const now = B.nowIso();
      await S.insert('CrmTask', { id: S.newId('task'), title: `Call back: ${s.type === 'nps' ? 'NPS' : 'CSAT'} ${n}/${max} from ${s.name || s.email}`.slice(0, 200), dueDate: S.istToday(), status: 'Open', type: 'Call', priority: 'High', accountId: acc.id, ownerId: acc.ownerId, ownerName: acc.ownerName, createdAt: now, updatedAt: now, origin: 'survey' });
    }
  }
  return { s, ok: true, low };
}
async function surveyResults(user, { days = 90 } = {}) {
  const since = new Date(Date.now() - Math.max(1, Math.min(730, Number(days) || 90)) * 86400000).toISOString();
  const r = C.role(user);
  const own = S.seesAll(r) ? '' : ' AND ("byId" = ? OR "accountId" IN (SELECT "id" FROM "CrmAccount" WHERE "ownerId" = ?))';
  const rows = await B.all(`SELECT * FROM "CrmSurveyAsk" WHERE "createdAt" >= ?${own} ORDER BY "createdAt" DESC LIMIT 500`, since, ...(own ? [user.id, user.id] : []));
  const nps = rows.filter((x) => x.type === 'nps' && x.score != null); const csat = rows.filter((x) => x.type === 'csat' && x.score != null);
  const pct = (a, n) => (n ? Math.round((a / n) * 100) : 0);
  const promoters = nps.filter((x) => x.score >= 9).length; const detractors = nps.filter((x) => x.score <= 6).length;
  return S.okBody({
    nps: { answers: nps.length, sent: rows.filter((x) => x.type === 'nps').length, score: nps.length ? pct(promoters, nps.length) - pct(detractors, nps.length) : null, promoters, passives: nps.length - promoters - detractors, detractors },
    csat: { answers: csat.length, sent: rows.filter((x) => x.type === 'csat').length, average: csat.length ? Math.round((csat.reduce((s, x) => s + x.score, 0) / csat.length) * 10) / 10 : null, happy: pct(csat.filter((x) => x.score >= 4).length, csat.length) },
    rows: rows.map(({ token: _t, ...x }) => x), auto: await B.on('surveysAuto'),
  });
}
// after a won deal (NPS) / a resolved or closed ticket (CSAT), once, when the switch is on
async function runSurveys() {
  if (!(await B.on('surveysAuto'))) return { off: true };
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const out = { sent: 0, skipped: 0 };
  const deals = await B.all('SELECT d."id" FROM "CrmDeal" d WHERE d."stage" = \'Won\' AND COALESCE(d."wonAt", d."updatedAt") >= ? AND NOT EXISTS (SELECT 1 FROM "CrmSurveyAsk" s WHERE s."kind" = \'deal\' AND s."recordId" = d."id") LIMIT 20', since);
  const tickets2 = await B.all('SELECT t."id" FROM "CrmTicket" t WHERE t."status" IN (\'Resolved\', \'Closed\') AND t."updatedAt" >= ? AND NOT EXISTS (SELECT 1 FROM "CrmSurveyAsk" s WHERE s."kind" = \'ticket\' AND s."recordId" = t."id") LIMIT 20', since);
  for (const [kind, type, list] of [['deal', 'nps', deals], ['ticket', 'csat', tickets2]]) {
    for (const x of list) {
      const r = await sendSurvey(null, { kind, id: x.id, type }, { auto: true }).catch(() => ({ status: 500 })); // eslint-disable-line no-await-in-loop
      if (r.status === 200) out.sent += 1; else out.skipped += 1;
      // a record with no email is marked asked, so it is not tried every minute
      if (r.status !== 200) await B.run('INSERT INTO "CrmSurveyAsk" ("id","token","type","kind","recordId","createdAt","byName") VALUES (?,?,?,?,?,?,\'Automatic: not sent\')', C.newId('sv'), C.token(18), type, kind, x.id, B.nowIso()); // eslint-disable-line no-await-in-loop
    }
  }
  return out;
}
function surveyHtml(s, { done, error, already } = {}) {
  if (done || already) return C.page('Thank you', `<h1>Thank you</h1><p>${already ? 'We already have your answer.' : 'Your answer helps us do better.'}</p>`);
  const max = s.type === 'nps' ? 10 : 5; const min = s.type === 'nps' ? 0 : 1;
  const nums = Array.from({ length: max - min + 1 }, (_, i) => i + min);
  return C.page('One question', `<h1>${esc(QUESTIONS[s.type])}</h1>${s.about && s.type === 'csat' ? `<p class="muted">About: ${esc(s.about)}</p>` : ''}${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ''}
  <form method="post"><div class="score">${nums.map((n) => `<label><input type="radio" name="score" value="${n}" required><span>${n}</span></label>`).join('')}</div>
  <p class="muted">${s.type === 'nps' ? '0 = not at all likely, 10 = very likely' : '1 = very unhappy, 5 = very happy'}</p><label for="c">Anything to tell us? (optional)</label><textarea id="c" name="comment" rows="3"></textarea><button>Send</button></form>`);
}

module.exports = {
  portalUsers, invite, removeUser, login, acceptInvite, sessionUser, logout, me, quotes, quoteOf, decideQuote, invoices, invoiceOf, tickets, ticket, raiseTicket, ticketComment,
  kbList, kbSave, kbRemove, kbPublic, kbArticle, kbHelpful, kbHtml,
  resellers, saveReseller, partnerDeals, registerDeal, decideDeal,
  sendSurvey, answerSurvey, surveyOfToken, surveyResults, runSurveys, surveyHtml,
};

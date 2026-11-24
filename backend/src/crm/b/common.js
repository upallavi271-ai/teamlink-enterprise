// ---------------------------------------------------------------------------
// CRM WAVE B - shared helpers: who may do what, the public address, HTML pages, finding a record by email / phone, a lead from a public form.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const S = require('../service');
const B = require('./schema');

const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const token = (n = 18) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const lower = (v) => String(v || '').trim().toLowerCase();
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
function baseUrl() {
  return String(process.env.PUBLIC_API_URL || process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '');
}
const secret = () => String(process.env.JWT_SECRET || 'teamlink-crm');
const sign = (purpose, v) => crypto.createHmac('sha256', secret()).update(`crm-b:${purpose}:${v}`).digest('base64url').slice(0, 22);
const signed = (purpose, v) => `${Buffer.from(String(v)).toString('base64url')}.${sign(purpose, v)}`;
function unsign(purpose, t) {
  const [b, sig] = String(t || '').split('.');
  if (!b || !sig) return null;
  let v; try { v = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const want = sign(purpose, v);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? v : null;
}

// ---- access ------------------------------------------------------------------------------------------------------------------
const role = (user) => S.roleOf(user);
const isManager = (user) => S.mayAssign(role(user)); // Admin / Sales manager
const canWork = (user) => S.mayEdit(role(user)); // not a Viewer
const no = (msg) => S.fail(403, msg || 'This is set up by a Sales manager or an Admin.');
const needManager = (user) => (isManager(user) ? null : no());
const needWork = (user) => (canWork(user) ? null : no('Your role can read the CRM but not change it.'));
const isAdmin = (user) => role(user) === 'admin';

// ---- a public HTML page (no login), the same look as the unsubscribe page
function page(title, inner, { wide = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:#1b2a4a;margin:0;padding:16px;display:flex;justify-content:center}
.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:26px 22px;max-width:${wide ? 720 : 480}px;width:100%;box-shadow:0 4px 18px rgba(20,40,80,.06);margin-top:5vh;box-sizing:border-box}
h1{font-size:21px;margin:0 0 8px}p{color:#4b5565;line-height:1.55;margin:0 0 12px}label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}
input,textarea,select{width:100%;box-sizing:border-box;padding:10px 11px;border:1px solid #cfd6e3;border-radius:8px;font:inherit;font-size:15px}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer;margin-top:14px}
.muted{font-size:12.5px;color:#6b7280}.row{display:flex;gap:8px;flex-wrap:wrap}.chk{display:flex;gap:8px;align-items:center;font-weight:500;margin:6px 0}.chk input{width:auto}
.score{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.score label{margin:0;font-weight:600;border:1px solid #cfd6e3;border-radius:8px;padding:8px 11px;cursor:pointer}.score input{display:none}.score input:checked+span{color:#2563eb}</style></head>
<body><div class="card">${inner}</div></body></html>`;
}
const htmlOut = (res, status, html) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'private, no-store'); res.set('X-Robots-Tag', 'noindex'); return res.status(status).send(html); };

// ---- find the CRM record behind an email address / phone number ---------------------------------------------------------------
async function recordByEmail(addr) {
  const e = lower(addr);
  if (!validEmail(e)) return null;
  const lead = await B.one('SELECT "id", "ownerId", "ownerName", "company", "contactName", "accountId", "dealId" FROM "CrmLead" WHERE LOWER("email") = ? ORDER BY CASE WHEN "status" IN (\'Converted\', \'Junk\') THEN 1 ELSE 0 END, "updatedAt" DESC LIMIT 1', e);
  if (lead) return { kind: 'lead', id: lead.id, ownerId: lead.ownerId, ownerName: lead.ownerName, name: lead.contactName || lead.company, links: { leadId: lead.id, accountId: lead.accountId || null } };
  const c = await B.one('SELECT "id", "ownerId", "ownerName", "name", "accountId" FROM "CrmContact" WHERE LOWER("email") = ? LIMIT 1', e);
  if (c) return { kind: 'contact', id: c.id, ownerId: c.ownerId, ownerName: c.ownerName, name: c.name, links: { contactId: c.id, accountId: c.accountId || null } };
  const a = await B.one('SELECT "id", "ownerId", "ownerName", "name" FROM "CrmAccount" WHERE LOWER("email") = ? LIMIT 1', e);
  if (a) return { kind: 'account', id: a.id, ownerId: a.ownerId, ownerName: a.ownerName, name: a.name, links: { accountId: a.id } };
  return null;
}
async function recordByPhone(raw) {
  const p = S.phone10(raw);
  if (!p || p.length < 10) return null;
  const like = `%${p}`;
  const lead = (await B.all('SELECT "id", "ownerId", "ownerName", "company", "contactName", "phone", "accountId" FROM "CrmLead" WHERE "phone" LIKE ? ORDER BY "updatedAt" DESC LIMIT 20', `%${p.slice(-6)}%`)).find((l) => S.phone10(l.phone) === p);
  if (lead) return { kind: 'lead', id: lead.id, ownerId: lead.ownerId, ownerName: lead.ownerName, name: lead.contactName || lead.company, links: { leadId: lead.id, accountId: lead.accountId || null } };
  const c = (await B.all('SELECT "id", "ownerId", "ownerName", "name", "phone", "accountId" FROM "CrmContact" WHERE "phone" LIKE ? LIMIT 20', `%${p.slice(-6)}%`)).find((x) => S.phone10(x.phone) === p);
  if (c) return { kind: 'contact', id: c.id, ownerId: c.ownerId, ownerName: c.ownerName, name: c.name, links: { contactId: c.id, accountId: c.accountId || null } };
  void like;
  return null;
}
// a timeline line written by the system (a mail read from a mailbox, a chat, a page view ...): not through addActivity (no person, no rights)
async function systemActivity(links, { kind = 'note', subject, note, at, byName = 'TeamLink', byId = null } = {}) {
  const now = B.nowIso();
  return S.insert('CrmActivity', { id: S.newId('act'), kind, subject: clip(subject, 200), note: clip(note, 4000), at: at || now, leadId: links.leadId || null, accountId: links.accountId || null, dealId: links.dealId || null, contactId: links.contactId || null, byId, byName, createdAt: now });
}
async function notify(userIds, title, message, key) {
  for (const userId of [...new Set((userIds || []).filter(Boolean))]) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId, title: String(title).slice(0, 180), message: String(message || '').slice(0, 900), channel: 'In-App', recipient: `${key}|${Date.now()}`, status: 'Sent' } }).catch(() => {});
  }
}
async function managers() { return (await S.ownerOptions()).filter((o) => o.tl).map((o) => o.id); }

// ---- a lead from a public form / chat / ad / event (the same rules as the website form, crm/sales.js capture)
async function makeLead({ company, name, phone, email, source = 'Website', notes, utm = {}, campaignId = null, visitorId = null, byName = 'Website', ownerId = null }) {
  const SETTINGS = require('../settings'); // eslint-disable-line global-require
  const st = await SETTINGS.load();
  const co = clip(company, 200) || clip(name, 200);
  if (!co) return { error: 'A name is needed.' };
  if (!clip(phone, 40) && !clip(email, 200)) return { error: 'A phone number or an email is needed.' };
  const ph = S.phone10(phone); const em = lower(email);
  const same = (await B.all('SELECT "id", "phone", "email", "ownerId" FROM "CrmLead" WHERE ("email" IS NOT NULL AND LOWER("email") = ?) OR ("phone" LIKE ?) LIMIT 30', em || '-', ph.length === 10 ? `%${ph.slice(-6)}%` : '-'))
    .find((l) => (ph.length === 10 && S.phone10(l.phone) === ph) || (em && lower(l.email) === em));
  const now = B.nowIso();
  if (same) {
    await systemActivity({ leadId: same.id }, { subject: `${byName}: came again`, note: notes, byName });
    if (visitorId) await B.run('UPDATE "CrmLead" SET "visitorId" = COALESCE("visitorId", ?) WHERE "id" = ?', visitorId, same.id);
    return { lead: same, duplicate: true };
  }
  let own = null;
  if (ownerId) own = (await S.ownerOptions()).find((o) => o.id === ownerId) || null;
  if (!own) {
    const w = await prisma.appSetting.findUnique({ where: { key: 'crm.website' } }).catch(() => null);
    if (json(w && w.value, {}).autoAssign === true) own = await require('../sales').takeTurn().catch(() => null); // eslint-disable-line global-require
  }
  const c = S.cleanFields('lead', { company: co, contactName: clip(name, 200), phone: clip(phone, 40), email: clip(email, 200), source: st.sources.includes(source) ? source : 'Other', notes: clip(notes, 2000) }, { partial: false });
  if (c.error) return { error: c.error };
  const saved = await S.insert('CrmLead', {
    id: S.newId('lead'), ...c.data, utmSource: clip(utm.utmSource, 120), utmMedium: clip(utm.utmMedium, 120), utmCampaign: clip(utm.utmCampaign, 120), pageUrl: clip(utm.pageUrl, 500),
    status: 'New', stage: st.leadStages[0].name, ownerId: own ? own.id : null, ownerName: own ? own.name : null, createdById: null, createdAt: now, updatedAt: now,
  });
  await B.run('UPDATE "CrmLead" SET "campaignId" = ?, "visitorId" = ? WHERE "id" = ?', campaignId, visitorId, saved.id);
  if (visitorId) await B.run('UPDATE "CrmWebVisit" SET "leadId" = ? WHERE "visitorId" = ? AND "leadId" IS NULL', saved.id, visitorId);
  const tell = own ? [own.id] : await managers();
  await notify(tell, `New lead (${byName}): ${saved.company}`, `Open: /crm/leads?open=lead:${saved.id}`, `crm-b-lead|${saved.id}`);
  if (own) await require('../sales').firstFollowUp(saved).catch(() => null); // eslint-disable-line global-require
  return { lead: saved, duplicate: false };
}

// a record this person may see / work on (kind lead | deal | account | contact)
async function visible(user, kind, id) {
  if (!['lead', 'deal', 'account', 'contact'].includes(kind)) return null;
  const row = await S.getRow(kind, String(id || '').slice(0, 60));
  return S.canSeeRow(user, role(user), row) ? row : null;
}
async function editable(user, kind, id) {
  if (!['lead', 'deal', 'account', 'contact'].includes(kind)) return null;
  const row = await S.getRow(kind, String(id || '').slice(0, 60));
  return S.canEditRow(user, role(user), row) ? row : null;
}
const linksFor = (kind, row) => ({ lead: { leadId: row.id, accountId: row.accountId || null }, deal: { dealId: row.id, accountId: row.accountId || null }, contact: { contactId: row.id, accountId: row.accountId || null }, account: { accountId: row.id } }[kind]);
const sandbox = () => !!(process.env.TEAMLINK_SANDBOX || process.env.TEST_MODE);

module.exports = {
  S, B, clip, esc, newId, token, sha, validEmail, lower, json, baseUrl, signed, unsign, role, isManager, canWork, needManager, needWork, isAdmin, no,
  page, htmlOut, recordByEmail, recordByPhone, systemActivity, notify, managers, makeLead, visible, editable, linksFor, sandbox,
};

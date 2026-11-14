// ---------------------------------------------------------------------------
// THE SALES CRM - RULES AND DATA (founder 2026-11-02). Four screens cover the whole CRM (frontend/src/pages/crm):
//   Dashboard            pipeline value, deals by stage, won / lost this month, follow-ups due, lead sources, closing soon
//   Leads                every lead, duplicate check, Convert -> Account + Contact + Deal; timeline + follow-ups inside
//   Deals                the pipeline board (Prospecting ... Won / Lost with reason); Won -> "Add as client" (ATS)
//   Accounts & Contacts  companies (prospects and clients) with their people, deals, timeline and follow-ups
//
// WHO SEES WHAT - a CRM for the SALES TEAM (founder 2026-11-02: "sales team kosam ani chepparu ... sale kosam crm kaavali")
//   Super Admin / Admin            everything, edits everything, may give a record to another salesperson, sets up the team
//   Sales manager                  everything, edits, gives records to salespeople, sets targets and CRM settings
//                                  (= the BDE TL, and anybody the Admin lists as "Sales manager" in CRM settings)
//   Manager / Asst Mgr (ATS)       everything, read only
//   Salesperson                    their own records only (owner = them); a new record is theirs
//                                  (= the BDEs, and anybody listed as "Salesperson" in CRM settings)
//   anybody else                   nothing (the CRM is not opened)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./schema');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

// stages are fixed; sources, lost reasons and stage probabilities are CRM settings (crm/settings.js, BDE TL / Admin)
const SETTINGS = require('./settings');

const { STAGES } = SETTINGS;
const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Junk', 'Converted'];
const CONTACT_ROLES = ['Decision maker', 'HR', 'Influencer', 'Finance', 'Other'];
const ACTIVITY_KINDS = { call: 'Call', meeting: 'Meeting', email: 'Email', whatsapp: 'WhatsApp', note: 'Note' };
const RATINGS = ['Hot', 'Warm', 'Cold'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;

const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => istNow().toISOString().slice(0, 10);
const addDaysIso = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + (Number(n) || 0)); return d.toISOString().slice(0, 10); };
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[, ]/g, '')); return Number.isFinite(n) && n >= 0 ? n : null; };
const fail = (status, error, extra) => ({ status, body: { error, ...(extra || {}) } });
const okBody = (body) => ({ status: 200, body });

// ---- access -------------------------------------------------------------------------------------------
// 'admin' | 'tl' (sales manager) | 'view' | 'bde' (salesperson) | null. The listed team comes from the CRM settings already
// read (crmRoleFor / the CRM routes read them first).
// The CRM's own list decides (crm/settings.js): Super Admin / Admin 'admin'; a Sales manager 'tl'; a Viewer 'view'; a Salesperson 'bde'
// (their own records) or 'bdeAll' (allowed to see everyone's records, still changes only their own). Nothing comes from ATS roles.
function roleOf(user) {
  if (!user || !user.id) return null;
  if (user.clientId || user.candidateId) return null; // never a client / candidate login
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return 'admin';
  const m = SETTINGS.member(user.id);
  if (!m) return null;
  if (m.role === 'manager') return 'tl';
  if (m.role === 'viewer') return 'view';
  return m.seeAll ? 'bdeAll' : 'bde';
}
// one right of a person: create / edit / delete / import / export / reports (Admin and Sales managers have all of them)
function can(user, right) {
  const r = roleOf(user);
  if (r === 'admin' || r === 'tl') return true;
  const m = SETTINGS.member(user && user.id);
  return !!(m && m.rights && m.rights[right]);
}
const rightsOf = (user) => Object.fromEntries(SETTINGS.RIGHTS.map((k) => [k, can(user, k)]));
async function crmRoleFor(user) {
  await SETTINGS.load().catch(() => null);
  return roleOf(user);
}
const seesAll = (r) => r === 'admin' || r === 'tl' || r === 'view' || r === 'bdeAll';
const mayEdit = (r) => r === 'admin' || r === 'tl' || r === 'bde' || r === 'bdeAll';
const mayAssign = (r) => r === 'admin' || r === 'tl';
const canSeeRow = (user, r, row) => !!row && (seesAll(r) || row.ownerId === user.id);
const canEditRow = (user, r, row) => !!row && mayEdit(r) && can(user, 'edit') && ((r !== 'bde' && r !== 'bdeAll') || row.ownerId === user.id);
// SQL piece for a list: a BDE reads their own rows only
const scopeSql = (user, r, alias = '') => (seesAll(r) ? { sql: '1=1', params: [] } : { sql: `${alias}"ownerId" = ?`, params: [user.id] });

// The people a record may belong to: the Sales managers and Salespeople on the CRM's own list who still work here.
async function ownerOptions() {
  const st = await SETTINGS.load();
  const listed = new Map(st.salesTeam.filter((m) => m.role !== 'viewer').map((m) => [m.userId, m.role]));
  if (!listed.size) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: [...listed.keys()] } },
    select: { id: true, name: true, status: true, clientId: true, candidateId: true },
    orderBy: { name: 'asc' },
  }).catch(() => []);
  return users.filter((u) => !u.clientId && !u.candidateId && !/inactive|disabled|deleted|left|relieved|exit|suspended/i.test(String(u.status || '')))
    .map((u) => ({ id: u.id, name: u.name, tl: listed.get(u.id) === 'manager' }));
}
async function pickOwner(user, r, wanted) {
  if (!wanted || !mayAssign(r) || wanted === user.id) return { id: user.id, name: user.name || null };
  const o = (await ownerOptions()).find((x) => x.id === wanted);
  return o ? { id: o.id, name: o.name } : null;
}

// ---- record kinds ------------------------------------------------------------------------------------
// fields a person may write, with their kind ('s' text, 'n' number, 'i' integer, 'd' date, 'L' long text)
const KINDS = {
  lead: { table: 'CrmLead', label: 'Lead', name: 'company', fields: { company: 's', contactName: 's', designation: 's', phone: 's', email: 's', industry: 's', city: 's', source: 's', status: 's', rating: 's', notes: 'L', expectedValue: 'n' } },
  account: { table: 'CrmAccount', label: 'Account', name: 'name', fields: { name: 's', industry: 's', city: 's', website: 's', phone: 's', email: 's', source: 's', gstin: 's', address: 'L', state: 's', pincode: 's', tags: 's', notes: 'L' } },
  contact: { table: 'CrmContact', label: 'Contact', name: 'name', fields: { accountId: 's', name: 's', designation: 's', role: 's', phone: 's', email: 's', notes: 'L' } },
  deal: { table: 'CrmDeal', label: 'Deal', name: 'title', fields: { title: 's', accountId: 's', contactId: 's', value: 'n', discountPercent: 'n', probability: 'i', expectedClose: 'd', nextStep: 's', notes: 'L' } },
};

function cleanFields(kind, body, { partial }) {
  const k = KINDS[kind];
  const out = {};
  for (const [f, t] of Object.entries(k.fields)) {
    if (!(f in (body || {}))) continue;
    const v = body[f];
    if (t === 's') out[f] = clip(v);
    else if (t === 'L') out[f] = clip(v, 4000);
    else if (t === 'n') out[f] = num(v);
    else if (t === 'i') { const n = num(v); out[f] = n == null ? null : Math.round(n); }
    else if (t === 'd') {
      const s = clip(v, 10);
      if (s && !YMD.test(s)) return { error: 'Please pick a proper date.' };
      out[f] = s;
    }
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: 'This email address does not look right.' };
  if (out.phone && String(out.phone).replace(/\D/g, '').length < 8) return { error: 'This phone number looks too short.' };
  if (kind === 'lead' && 'status' in out && !LEAD_STATUSES.includes(out.status || '')) return { error: 'Pick a lead status from the list.' };
  if (kind === 'contact' && out.role && !CONTACT_ROLES.includes(out.role)) return { error: 'Pick the contact\'s role from the list.' };
  if (kind === 'lead' && out.rating && !RATINGS.includes(out.rating)) return { error: 'Rating is Hot, Warm or Cold.' };
  if (kind === 'deal') {
    if (out.probability != null && out.probability > 100) return { error: 'Probability is a percent (0 to 100).' };
    if (out.feePercent != null && out.feePercent > 100) return { error: 'The fee is a percent (0 to 100).' };
    if (out.discountPercent != null && (out.discountPercent < 0 || out.discountPercent > 100)) return { error: 'Discount is a percent (0 to 100).' };
  }
  if (!partial && !out[k.name]) return { error: `${k.label === 'Lead' ? 'Company name' : k.label === 'Deal' ? 'Deal name' : 'Name'} is needed.` };
  if (partial && k.name in out && !out[k.name]) return { error: `${k.label} name cannot be empty.` };
  return { data: out };
}

// A deal's value is the amount typed (the CRM sells anything; nothing is worked out from hiring numbers any more).
function dealValue(d) {
  return d.value || 0;
}
// The amount after the discount — what the invoice will be for (founder 2026-11-13).
function finalValueOf(d) {
  const v = Number(d.value) || 0;
  const disc = Number(d.discountPercent) || 0;
  return Math.round((v - (v * disc) / 100) * 100) / 100;
}
// Does this deal's discount need a manager's approval? A discount above the CRM limit is 'Pending' until a manager approves it;
// an already-approved deal whose discount is unchanged stays 'Approved'; at or under the limit needs nothing ('None').
async function approvalFor(d, prev) {
  const limit = (await SETTINGS.load()).discountApprovalLimit;
  const disc = Number(d.discountPercent) || 0;
  if (disc <= limit) return 'None';
  if (prev && prev.approvalStatus === 'Approved' && (Number(prev.discountPercent) || 0) === disc) return 'Approved';
  return 'Pending';
}

async function getRow(kind, id) {
  return DB.one(`SELECT * FROM "${KINDS[kind] ? KINDS[kind].table : kind}" WHERE "id" = ?`, String(id || '').slice(0, 60));
}
async function insert(table, row) {
  const cols = Object.keys(row);
  await DB.run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  return DB.one(`SELECT * FROM "${table}" WHERE "id" = ?`, row.id);
}
async function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return DB.one(`SELECT * FROM "${table}" WHERE "id" = ?`, id);
  await DB.run(`UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => data[c]), id);
  return DB.one(`SELECT * FROM "${table}" WHERE "id" = ?`, id);
}
const audit = (user, action, entity, entityId, toValue, reason) => logAudit({ userId: user.id, actorName: user.name || null, action, entity, entityId, toValue: toValue ? String(toValue).slice(0, 300) : undefined, reason }).catch(() => {});

// ---- human-readable codes (founder 2026-11-13): L-0001 lead, D-0001 deal, C-0001 customer -------------
// The running number is kept in AppSetting 'crm.seq'; old rows get a code once (backfillCodes).
const CODE_PREFIX = { lead: 'L', deal: 'D', account: 'C', invoice: 'INV' };
const SEQ_KEY = 'crm.seq';
async function nextCodes(kind, n = 1) {
  const prefix = CODE_PREFIX[kind];
  if (!prefix || n < 1) return [];
  const row = await prisma.appSetting.findUnique({ where: { key: SEQ_KEY } }).catch(() => null);
  let seq = {}; try { seq = row && row.value ? JSON.parse(row.value) : {}; } catch { seq = {}; }
  const start = Number(seq[kind]) || 0;
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(`${prefix}-${String(start + i).padStart(4, '0')}`);
  seq[kind] = start + n;
  const v = JSON.stringify(seq);
  await prisma.appSetting.upsert({ where: { key: SEQ_KEY }, create: { key: SEQ_KEY, value: v }, update: { value: v } });
  return out;
}
// After sample data is removed the numbers it used are free again: the counters go back to the highest code that is still there, so the first
// REAL invoice is INV-0001 (an accountant does not want invoice numbers that start after a gap made by test records), the first real lead L-0001, ...
async function resetCodeCounters() {
  const tables = { lead: 'CrmLead', deal: 'CrmDeal', account: 'CrmAccount', invoice: 'CrmInvoice' };
  const row = await prisma.appSetting.findUnique({ where: { key: SEQ_KEY } }).catch(() => null);
  let seq = {}; try { seq = row && row.value ? JSON.parse(row.value) : {}; } catch { seq = {}; }
  const out = {};
  for (const [kind, table] of Object.entries(tables)) {
    const codes = await DB.all(`SELECT "code" FROM "${table}" WHERE "code" IS NOT NULL`).catch(() => []); // eslint-disable-line no-await-in-loop
    const max = codes.reduce((m, x) => Math.max(m, Number(String(x.code).split('-')[1]) || 0), 0);
    if ((Number(seq[kind]) || 0) > max) { seq[kind] = max; out[kind] = max; }
  }
  if (Object.keys(out).length) await prisma.appSetting.upsert({ where: { key: SEQ_KEY }, create: { key: SEQ_KEY, value: JSON.stringify(seq) }, update: { value: JSON.stringify(seq) } });
  return out;
}
let codesBackfilled = false;
async function backfillCodes() {
  if (codesBackfilled) return;
  for (const kind of ['lead', 'deal', 'account']) {
    const table = KINDS[kind].table;
    // eslint-disable-next-line no-await-in-loop
    const rows = await DB.all(`SELECT "id" FROM "${table}" WHERE "code" IS NULL ORDER BY "createdAt", "id"`).catch(() => []);
    if (!rows.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const codes = await nextCodes(kind, rows.length);
    // eslint-disable-next-line no-await-in-loop
    for (let i = 0; i < rows.length; i += 1) await DB.run(`UPDATE "${table}" SET "code" = ? WHERE "id" = ?`, codes[i], rows[i].id);
  }
  codesBackfilled = true;
}

// ---- duplicate check ----------------------------------------------------------------------------------
const normCo = (s) => String(s || '').toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|inc|india|technologies|technology|solutions|services|the)\b/g, '').replace(/[^a-z0-9]/g, '');
const phone10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
async function duplicatesOf({ company, phone, email }, { exceptLeadId } = {}) {
  const co = normCo(company); const ph = phone10(phone); const em = String(email || '').trim().toLowerCase();
  if (!co && ph.length < 10 && !em) return [];
  const hit = (name, p, e) => (co && co.length >= 3 && normCo(name) === co) || (ph.length === 10 && phone10(p) === ph) || (em && String(e || '').trim().toLowerCase() === em);
  const out = [];
  (await DB.all('SELECT "id", "company", "phone", "email", "ownerName", "status" FROM "CrmLead" WHERE "status" != \'Junk\'')).forEach((l) => {
    if (l.id !== exceptLeadId && hit(l.company, l.phone, l.email)) out.push({ where: 'Lead', id: l.id, name: l.company, owner: l.ownerName, status: l.status });
  });
  (await DB.all('SELECT "id", "name", "phone", "email", "ownerName", "kind" FROM "CrmAccount"')).forEach((a) => {
    if (hit(a.name, a.phone, a.email)) out.push({ where: 'Account', id: a.id, name: a.name, owner: a.ownerName, status: a.kind });
  });
  (await DB.all('SELECT "id", "name", "phone", "email", "ownerName" FROM "CrmContact"')).forEach((c) => {
    if ((ph.length === 10 && phone10(c.phone) === ph) || (em && String(c.email || '').toLowerCase() === em)) out.push({ where: 'Contact', id: c.id, name: c.name, owner: c.ownerName });
  });
  return out.slice(0, 10);
}

// ---- lists --------------------------------------------------------------------------------------------
const LAST_ACT = (col) => `(SELECT MAX(a."at") FROM "CrmActivity" a WHERE a."${col}" = x."id") AS "lastActivityAt"`;
const NEXT_TASK = (col) => `(SELECT MIN(t."dueDate") FROM "CrmTask" t WHERE t."${col}" = x."id" AND t."status" = 'Open') AS "nextTaskDue"`;

async function list(user, kind, q = {}) {
  const r = roleOf(user);
  const s = scopeSql(user, r, 'x.');
  const where = [s.sql]; const params = [...s.params];
  const text = clip(q.q, 80);
  if (kind === 'lead') {
    if (q.status && LEAD_STATUSES.includes(q.status)) { where.push('x."status" = ?'); params.push(q.status); } else if (q.status !== 'all') where.push('x."status" NOT IN (\'Converted\', \'Junk\')');
    if (text) { where.push('(x."company" LIKE ? OR x."contactName" LIKE ? OR x."phone" LIKE ? OR x."email" LIKE ? OR x."city" LIKE ?)'); params.push(...Array(5).fill(`%${text}%`)); }
    if (q.source) { where.push('x."source" = ?'); params.push(clip(q.source)); }
    if (q.rating && RATINGS.includes(q.rating)) { where.push('x."rating" = ?'); params.push(q.rating); }
    if (q.owner && seesAll(r)) { where.push('x."ownerId" = ?'); params.push(clip(q.owner, 60)); }
    if (q.from && YMD.test(q.from)) { where.push('x."createdAt" >= ?'); params.push(q.from); }
    if (q.to && YMD.test(q.to)) { where.push('x."createdAt" <= ?'); params.push(`${q.to}T23:59:59.999Z`); }
    const SALES = require('./sales'); // eslint-disable-line global-require
    const names = SALES.stageNames(await SETTINGS.load());
    const rows = (await DB.all(`SELECT x.*, ${LAST_ACT('leadId')}, ${NEXT_TASK('leadId')} FROM "CrmLead" x WHERE ${where.join(' AND ')} ORDER BY x."updatedAt" DESC LIMIT 1000`, ...params)).map((l) => ({ ...l, stage: SALES.stageOf(l, names) }));
    if (q.stage) return rows.filter((l) => l.stage === q.stage);
    return q.status ? rows : rows.filter((l) => !['Won', 'Lost'].includes(l.stage)); // the open leads: a won or lost one stays on the board
  }
  if (kind === 'account') {
    if (q.kind === 'Prospect' || q.kind === 'Client') { where.push('x."kind" = ?'); params.push(q.kind); }
    if (text) { where.push('(x."name" LIKE ? OR x."city" LIKE ? OR x."industry" LIKE ?)'); params.push(...Array(3).fill(`%${text}%`)); }
    if (q.owner && seesAll(r)) { where.push('x."ownerId" = ?'); params.push(clip(q.owner, 60)); }
    return DB.all(`SELECT x.*, (SELECT COUNT(*) FROM "CrmContact" c WHERE c."accountId" = x."id") AS "contacts",
      (SELECT COUNT(*) FROM "CrmDeal" d WHERE d."accountId" = x."id" AND d."stage" NOT IN ('Won', 'Lost')) AS "openDeals",
      (SELECT COALESCE(SUM(d."value"), 0) FROM "CrmDeal" d WHERE d."accountId" = x."id" AND d."stage" NOT IN ('Won', 'Lost')) AS "openValue",
      ${LAST_ACT('accountId')} FROM "CrmAccount" x WHERE ${where.join(' AND ')} ORDER BY x."name" COLLATE NOCASE LIMIT 1000`, ...params);
  }
  if (kind === 'contact') {
    if (text) { where.push('(x."name" LIKE ? OR x."phone" LIKE ? OR x."email" LIKE ? OR a."name" LIKE ?)'); params.push(...Array(4).fill(`%${text}%`)); }
    if (q.accountId) { where.push('x."accountId" = ?'); params.push(clip(q.accountId, 60)); }
    return DB.all(`SELECT x.*, a."name" AS "accountName" FROM "CrmContact" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${where.join(' AND ')} ORDER BY x."name" COLLATE NOCASE LIMIT 1000`, ...params);
  }
  if (kind === 'deal') {
    if (text) { where.push('(x."title" LIKE ? OR a."name" LIKE ?)'); params.push(`%${text}%`, `%${text}%`); }
    if (q.owner && seesAll(r)) { where.push('x."ownerId" = ?'); params.push(clip(q.owner, 60)); }
    // closed deals: the last 30 days only on the board, so Won / Lost stay readable (older ones stay on their account); a list that needs more
    // (the Revenue card's Won deals) asks with ?closedDays=
    const closedDays = Math.max(1, Math.min(3650, Math.round(Number(q.closedDays)) || 30));
    const since = new Date(Date.now() - closedDays * 86400000).toISOString();
    where.push('(x."stage" NOT IN (\'Won\', \'Lost\') OR COALESCE(x."wonAt", x."lostAt", x."updatedAt") >= ?)'); params.push(since);
    return DB.all(`SELECT x.*, a."name" AS "accountName", c."name" AS "contactName", ${LAST_ACT('dealId')}, ${NEXT_TASK('dealId')}
      FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" LEFT JOIN "CrmContact" c ON c."id" = x."contactId"
      WHERE ${where.join(' AND ')} ORDER BY x."updatedAt" DESC LIMIT 1000`, ...params);
  }
  return [];
}

// ---- one record, with its timeline and follow-ups -------------------------------------------------------
async function timelineOf(col, ids) {
  if (!ids.length) return { activities: [], tasks: [] };
  const marks = ids.map(() => '?').join(', ');
  const activities = await DB.all(`SELECT * FROM "CrmActivity" WHERE "${col}" IN (${marks}) ORDER BY "at" DESC LIMIT 300`, ...ids);
  const tasks = await DB.all(`SELECT * FROM "CrmTask" WHERE "${col}" IN (${marks}) ORDER BY "status" DESC, "dueDate" ASC LIMIT 300`, ...ids);
  return { activities, tasks };
}
async function detail(user, kind, id) {
  const r = roleOf(user);
  const row = await getRow(kind, id);
  if (!canSeeRow(user, r, row)) return fail(404, `This ${KINDS[kind].label.toLowerCase()} is not there, or it is not yours.`);
  const out = { [kind]: row, canEdit: canEditRow(user, r, row) };
  if (kind === 'lead') {
    const SALES = require('./sales'); // eslint-disable-line global-require
    out.lead = { ...row, stage: SALES.stageOf(row, SALES.stageNames(await SETTINGS.load())) };
    Object.assign(out, await timelineOf('leadId', [row.id]));
  }
  if (kind === 'deal') {
    out.account = row.accountId ? await getRow('account', row.accountId) : null;
    out.contact = row.contactId ? await getRow('contact', row.contactId) : null;
    out.contacts = row.accountId ? await DB.all('SELECT * FROM "CrmContact" WHERE "accountId" = ? ORDER BY "name"', row.accountId) : [];
    Object.assign(out, await timelineOf('dealId', [row.id]));
  }
  if (kind === 'account') {
    out.contacts = await DB.all('SELECT * FROM "CrmContact" WHERE "accountId" = ? ORDER BY "name" COLLATE NOCASE', row.id);
    out.deals = await DB.all('SELECT * FROM "CrmDeal" WHERE "accountId" = ? ORDER BY "updatedAt" DESC', row.id);
    // the account's timeline also shows what happened on its deals
    const acts = await DB.all(`SELECT * FROM "CrmActivity" WHERE "accountId" = ? OR "dealId" IN (SELECT "id" FROM "CrmDeal" WHERE "accountId" = ?) ORDER BY "at" DESC LIMIT 300`, row.id, row.id);
    const tasks = await DB.all(`SELECT * FROM "CrmTask" WHERE "accountId" = ? OR "dealId" IN (SELECT "id" FROM "CrmDeal" WHERE "accountId" = ?) ORDER BY "status" DESC, "dueDate" ASC LIMIT 300`, row.id, row.id);
    Object.assign(out, { activities: acts, tasks });
  }
  return okBody(out);
}

// ---- create / update ----------------------------------------------------------------------------------
async function create(user, kind, body = {}) {
  const r = roleOf(user);
  if (!mayEdit(r) || !can(user, 'create')) return fail(403, 'Your CRM rights do not allow adding records. Ask a Sales manager.');
  const c = cleanFields(kind, body, { partial: false });
  if (c.error) return fail(400, c.error);
  const own = await pickOwner(user, r, clip(body.ownerId, 60));
  if (!own) return fail(400, 'Pick the owner from the sales team list.');
  const now = DB.nowIso();
  const row = { id: newId(kind), ...c.data, ownerId: own.id, ownerName: own.name, createdById: user.id, createdAt: now, updatedAt: now };
  if (kind === 'lead') {
    row.status = row.status && row.status !== 'Converted' ? row.status : 'New';
    if (row.source && !(await SETTINGS.load()).sources.includes(row.source)) row.source = 'Other';
    const dups = await duplicatesOf(row);
    if (dups.length && body.force !== true) return fail(409, 'This company or person is already in the CRM.', { duplicates: dups });
  }
  if (kind === 'account') {
    const dups = (await duplicatesOf({ company: row.name, phone: row.phone, email: row.email })).filter((d) => d.where === 'Account');
    if (dups.length && body.force !== true) return fail(409, 'This company is already in the CRM.', { duplicates: dups });
  }
  if (kind === 'contact' || kind === 'deal') {
    if (row.accountId) {
      const acc = await getRow('account', row.accountId);
      if (!canSeeRow(user, r, acc)) return fail(400, 'Pick one of your accounts.');
    } else if (kind === 'deal') return fail(400, 'Pick the account this deal is with.');
  }
  if (kind === 'deal') {
    if (row.contactId) {
      const ct = await getRow('contact', row.contactId);
      if (!ct || ct.accountId !== row.accountId) row.contactId = null;
    }
    row.stage = STAGES.includes(body.stage) && !['Won', 'Lost'].includes(body.stage) ? body.stage : 'Prospecting';
    if (row.probability == null) row.probability = (await SETTINGS.load()).stageProbability[row.stage];
    row.value = dealValue(row);
    row.finalValue = finalValueOf(row);
    row.approvalStatus = await approvalFor(row, null);
  }
  if (CODE_PREFIX[kind]) { const [code] = await nextCodes(kind, 1); if (code) row.code = code; }
  const saved = await insert(KINDS[kind].table, row);
  await audit(user, `CRM ${KINDS[kind].label.toLowerCase()} added`, KINDS[kind].table, saved.id, `${saved.code ? `${saved.code} · ` : ''}${saved[KINDS[kind].name]}`);
  // a new lead gets its first call as a follow-up straight away (crm/sales.js firstFollowUp); an Excel import does not come through here
  let firstFollowUp = null;
  if (kind === 'lead') firstFollowUp = await require('./sales').firstFollowUp(saved).catch(() => null); // eslint-disable-line global-require
  return okBody({ ok: true, [kind]: saved, ...(firstFollowUp ? { firstFollowUp } : {}) });
}

// A lead may be called Contacted / Qualified, or stand on a later stage, only once somebody has LOGGED something on it - a call, meeting, email,
// WhatsApp, note, or a follow-up finished with an outcome (founder 2026-11-14: a Qualified lead "never touched" for 24 days). Lines the system writes
// (stage moves, moved follow-ups, reminders, the website form) do not count.
async function hasLoggedWork(leadId) {
  const n = await DB.one('SELECT COUNT(*) AS "n" FROM "CrmActivity" WHERE "leadId" = ? AND "byId" IS NOT NULL AND COALESCE("subject", \'\') NOT LIKE \'Stage:%\' AND COALESCE("subject", \'\') NOT LIKE \'Follow-up moved:%\'', leadId);
  return Number(n && n.n) > 0;
}
const NEEDS_LOGGED_WORK = 'Log a call, meeting, email, WhatsApp or note on this lead first - then you can mark it Contacted or Qualified.';

async function edit(user, kind, id, body = {}) {
  const r = roleOf(user);
  const row = await getRow(kind, id);
  if (!canEditRow(user, r, row)) return fail(row && canSeeRow(user, r, row) ? 403 : 404, row && canSeeRow(user, r, row) ? 'You can read this record but not change it.' : 'This record is not there, or it is not yours.');
  const c = cleanFields(kind, body, { partial: true });
  if (c.error) return fail(400, c.error);
  const data = { ...c.data };
  if (kind === 'lead' && data.status === 'Converted' && row.status !== 'Converted') return fail(400, 'Use "Convert" to turn a lead into an account and a deal.');
  if (kind === 'lead' && ['Contacted', 'Qualified'].includes(data.status) && data.status !== row.status && !(await hasLoggedWork(row.id))) return fail(409, NEEDS_LOGGED_WORK, { needsLog: true, leadId: row.id });
  if (kind === 'lead' && data.source && !(await SETTINGS.load()).sources.includes(data.source)) data.source = 'Other';
  if ('ownerId' in body && body.ownerId && body.ownerId !== row.ownerId) {
    if (!mayAssign(r)) return fail(403, 'Only a Sales manager or an Admin can give a record to another salesperson.');
    const own = await pickOwner(user, r, clip(body.ownerId, 60));
    if (!own) return fail(400, 'Pick the owner from the sales team list.');
    data.ownerId = own.id; data.ownerName = own.name;
  }
  if (kind === 'contact' && data.accountId && data.accountId !== row.accountId) {
    const acc = await getRow('account', data.accountId);
    if (!canSeeRow(user, r, acc)) return fail(400, 'Pick one of your accounts.');
  }
  if (kind === 'deal') {
    if ('accountId' in data && !data.accountId) return fail(400, 'A deal needs its account.');
    if (data.accountId && data.accountId !== row.accountId) {
      const acc = await getRow('account', data.accountId);
      if (!canSeeRow(user, r, acc)) return fail(400, 'Pick one of your accounts.');
    }
    const merged = { ...row, ...data };
    data.value = dealValue(merged);
    if ('value' in data || 'discountPercent' in data) {
      data.finalValue = finalValueOf(merged);
      const was = row.approvalStatus;
      data.approvalStatus = await approvalFor(merged, row);
      // Discount changed in a way that needs fresh approval: clear who approved it before.
      if (data.approvalStatus === 'Pending' && was !== 'Pending') { data.approvalByName = null; data.approvalAt = null; data.approvalNote = null; }
    }
  }
  data.updatedAt = DB.nowIso();
  const saved = await update(KINDS[kind].table, row.id, data);
  if (data.ownerId) await audit(user, `CRM ${KINDS[kind].label.toLowerCase()} given to another BDE`, KINDS[kind].table, row.id, `${row.ownerName || '-'} -> ${data.ownerName}`);
  return okBody({ ok: true, [kind]: saved });
}

// A deal moves on the board. Won needs nothing more; Lost needs the reason. The move is written on the timeline.
async function moveDeal(user, id, { stage, lostReason } = {}) {
  const r = roleOf(user);
  const row = await getRow('deal', id);
  if (!canEditRow(user, r, row)) return fail(row && canSeeRow(user, r, row) ? 403 : 404, 'You cannot move this deal.');
  if (!STAGES.includes(stage)) return fail(400, 'Pick a stage from the pipeline.');
  if (stage === row.stage) return okBody({ ok: true, deal: row });
  const reason = clip(lostReason, 300);
  if (stage === 'Lost' && !reason) return fail(400, 'Why was the deal lost? Please pick the reason.');
  if (stage === 'Won' && row.approvalStatus === 'Pending') return fail(409, `The ${row.discountPercent || 0}% discount on this deal is over the limit and needs a Sales manager's approval before it can be won.`);
  const now = DB.nowIso();
  const data = { stage, probability: (await SETTINGS.load()).stageProbability[stage], updatedAt: now, wonAt: stage === 'Won' ? now : null, lostAt: stage === 'Lost' ? now : null, lostReason: stage === 'Lost' ? reason : null };
  const saved = await update('CrmDeal', row.id, data);
  if (stage === 'Won' && row.accountId) await update('CrmAccount', row.accountId, { kind: 'Client', updatedAt: now });
  await insert('CrmActivity', { id: newId('act'), kind: 'note', subject: `Stage: ${row.stage} → ${stage}`, note: stage === 'Lost' ? `Lost: ${reason}` : null, at: now, dealId: row.id, accountId: row.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await audit(user, stage === 'Won' ? 'CRM deal won' : stage === 'Lost' ? 'CRM deal lost' : 'CRM deal stage changed', 'CrmDeal', row.id, `${row.title}: ${row.stage} -> ${stage}`, reason || undefined);
  // Won -> the CRM raises its own invoice (never fail the Won if that errors). founder 2026-11-13.
  let invoice = null;
  if (stage === 'Won') { try { invoice = await createInvoiceForDeal(user, saved); } catch (e) { console.error('[crm] invoice on Won:', e.message); } } // eslint-disable-line no-console
  return okBody({ ok: true, deal: saved, invoice: invoice ? invoiceOut(invoice) : null });
}

// A Sales manager / Admin approves or rejects a deal's over-limit discount (founder 2026-11-13).
async function decideDeal(user, id, { decision, note } = {}) {
  const r = roleOf(user);
  const row = await getRow('deal', id);
  if (!row || !canSeeRow(user, r, row)) return fail(404, 'This deal is not there.');
  if (!mayAssign(r)) return fail(403, 'Only a Sales manager or an Admin can approve a discount.');
  if (!['approve', 'reject'].includes(decision)) return fail(400, 'Approve or reject the discount?');
  if (row.approvalStatus !== 'Pending') return fail(400, 'This deal is not waiting for a discount approval.');
  const now = DB.nowIso();
  const status = decision === 'approve' ? 'Approved' : 'Rejected';
  const saved = await update('CrmDeal', row.id, { approvalStatus: status, approvalByName: user.name || null, approvalAt: now, approvalNote: clip(note, 300) || null, updatedAt: now });
  await insert('CrmActivity', { id: newId('act'), kind: 'note', subject: `Discount ${status.toLowerCase()} (${row.discountPercent || 0}%)`, note: clip(note, 300) || null, at: now, dealId: row.id, accountId: row.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await audit(user, `CRM deal discount ${status.toLowerCase()}`, 'CrmDeal', row.id, `${row.title}: ${row.discountPercent || 0}%`, note || undefined);
  return okBody({ ok: true, deal: saved });
}

// ---- invoices (founder 2026-11-13: "Won -> Customer + invoice"): the CRM's OWN invoice, self-contained, never ATS Accounts ------
const INVOICE_STATUSES = ['Draft', 'Sent', 'Paid', 'Partly paid', 'Cancelled'];
function invoiceAmounts(net, taxPercent) {
  const amount = Math.round((Number(net) || 0) * 100) / 100;
  const tax = Math.round(amount * ((Number(taxPercent) || 0) / 100) * 100) / 100;
  return { amount, taxAmount: tax, total: Math.round((amount + tax) * 100) / 100 };
}
// Raise the invoice for a Won deal. Idempotent: one per deal (returns the existing one). Called from moveDeal on Won, and by hand.
// `issueDate` (yyyy-mm-dd) is for a backfill: the invoice of an old Won deal is dated the day it was won, not today.
async function createInvoiceForDeal(user, deal, { byHand = false, issueDate } = {}) {
  if (!deal || !deal.id) return null;
  const existing = await DB.one('SELECT * FROM "CrmInvoice" WHERE "dealId" = ?', deal.id).catch(() => null);
  if (existing) return existing;
  const st = await SETTINGS.load();
  const account = deal.accountId ? await getRow('account', deal.accountId).catch(() => null) : null;
  const net = finalValueOf(deal);
  const { amount, taxAmount, total } = invoiceAmounts(net, st.invoiceTaxPercent);
  const now = DB.nowIso();
  const issue = issueDate && YMD.test(issueDate) ? issueDate : istToday();
  const due = st.invoiceDueDays ? addDaysIso(issue, st.invoiceDueDays) : null;
  const [code] = await nextCodes('invoice', 1);
  const billTo = account ? { name: account.name, gstin: account.gstin || '', address: account.address || '', state: account.state || '', pincode: account.pincode || '', email: account.email || '', phone: account.phone || '' } : {};
  const row = await insert('CrmInvoice', {
    id: newId('inv'), code: code || null, dealId: deal.id, accountId: deal.accountId || null, accountName: account ? account.name : null,
    title: deal.title || 'Invoice', status: 'Draft', issueDate: issue, dueDate: due,
    amount, discountPercent: Number(deal.discountPercent) || null, taxPercent: Number(st.invoiceTaxPercent) || 0, taxAmount, total,
    paidAmount: 0, paidAt: null, fromJson: JSON.stringify(st.invoiceFrom || {}), billToJson: JSON.stringify(billTo), notes: null,
    ownerId: deal.ownerId || user.id, ownerName: deal.ownerName || user.name || null, createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now,
  });
  await insert('CrmActivity', { id: newId('act'), kind: 'note', subject: `Invoice ${code || ''} raised${byHand ? ' by hand' : ' on Won'}`, note: `${total}`, at: now, dealId: deal.id, accountId: deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await audit(user, 'CRM invoice raised', 'CrmInvoice', row.id, `${code || row.id}: ${total}`);
  return row;
}
// A deal that is already Won but has no invoice yet: raise it by hand (a "Create invoice" button).
async function invoiceForDeal(user, dealId) {
  const r = roleOf(user);
  const deal = await getRow('deal', dealId);
  if (!deal || !canSeeRow(user, r, deal)) return fail(404, 'This deal is not there.');
  if (!canEditRow(user, r, deal)) return fail(403, 'You cannot raise an invoice on this deal.');
  if (deal.stage !== 'Won') return fail(400, 'An invoice is raised once the deal is Won.');
  const inv = await createInvoiceForDeal(user, deal, { byHand: true });
  return okBody({ ok: true, invoice: inv });
}
async function invoices(user, q = {}) {
  const r = roleOf(user);
  const s = scopeSql(user, r, 'x.');
  const where = [s.sql]; const params = [...s.params];
  if (q.status && INVOICE_STATUSES.includes(q.status)) { where.push('x."status" = ?'); params.push(q.status); }
  if (q.accountId) { where.push('x."accountId" = ?'); params.push(clip(q.accountId, 60)); }
  if (q.dealId) { where.push('x."dealId" = ?'); params.push(clip(q.dealId, 60)); }
  const rows = await DB.all(`SELECT x.* FROM "CrmInvoice" x WHERE ${where.join(' AND ')} ORDER BY x."createdAt" DESC LIMIT 1000`, ...params);
  // Won deals (in the viewer's scope) that have no invoice yet - the ones won before invoices existed; "Create missing invoices" makes them
  const ds = scopeSql(user, r, 'd.');
  const miss = await DB.one(`SELECT COUNT(*) AS "n" FROM "CrmDeal" d WHERE d."stage" = 'Won' AND ${ds.sql} AND NOT EXISTS (SELECT 1 FROM "CrmInvoice" i WHERE i."dealId" = d."id")`, ...ds.params);
  let out = rows.map(invoiceOut);
  if (q.dealId && rows.length) { const pays = await DB.all(`SELECT * FROM "CrmPayment" WHERE "invoiceId" IN (${rows.map(() => '?').join(',')}) ORDER BY "paidOn" ASC, "createdAt" ASC`, ...rows.map((x) => x.id)).catch(() => []); out = out.map((x) => ({ ...x, payments: pays.filter((p) => p.invoiceId === x.id).map(paymentOut) })); }
  return okBody({ invoices: out, missing: Number(miss && miss.n) || 0 });
}
// One press: an invoice for every Won deal of the viewer's that has none, dated the day it was won. Idempotent (one invoice per deal).
async function backfillInvoices(user) {
  const r = roleOf(user);
  if (!mayEdit(r) || !can(user, 'edit')) return fail(403, 'Your CRM rights do not allow raising invoices. Ask a Sales manager.');
  const ds = scopeSql(user, r, 'd.');
  const deals = await DB.all(`SELECT d.* FROM "CrmDeal" d WHERE d."stage" = 'Won' AND ${ds.sql} AND NOT EXISTS (SELECT 1 FROM "CrmInvoice" i WHERE i."dealId" = d."id") ORDER BY COALESCE(d."wonAt", d."updatedAt") ASC LIMIT 500`, ...ds.params);
  let created = 0; const skipped = [];
  for (const deal of deals) {
    if (!canEditRow(user, r, deal)) { skipped.push({ id: deal.id, name: deal.title, reason: 'not yours' }); continue; } // eslint-disable-line no-continue
    const won = deal.wonAt ? new Date(Date.parse(deal.wonAt) + 5.5 * 3600000).toISOString().slice(0, 10) : null;
    try { await createInvoiceForDeal(user, deal, { byHand: true, issueDate: won }); created += 1; } catch (e) { skipped.push({ id: deal.id, name: deal.title, reason: e.message }); } // eslint-disable-line no-await-in-loop
  }
  await audit(user, 'CRM missing invoices raised', 'CrmInvoice', `${created} invoices`, `${created} created, ${skipped.length} skipped`);
  return okBody({ ok: true, created, skipped });
}
function invoiceOut(row) {
  let from = {}; let billTo = {};
  try { from = row.fromJson ? JSON.parse(row.fromJson) : {}; } catch { from = {}; }
  try { billTo = row.billToJson ? JSON.parse(row.billToJson) : {}; } catch { billTo = {}; }
  const overdue = row.status !== 'Paid' && row.status !== 'Cancelled' && row.dueDate && row.dueDate < istToday();
  // what is blank on the customer's side of the invoice (the account had no GSTIN / address when it was made): said on Won, shown on the invoice
  const missing = [!billTo.gstin && 'GSTIN', !billTo.address && 'address'].filter(Boolean);
  return { ...row, from, billTo, overdue, missing, balance: cents(Math.max(0, row.total - row.paidAmount)) };
}
async function invoiceDetail(user, id) {
  const r = roleOf(user);
  const row = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!row || !canSeeRow(user, r, row)) return fail(404, 'This invoice is not there.');
  return okBody({ invoice: { ...invoiceOut(row), payments: await paymentsOf(row.id) } });
}
// ---- the PAYMENT LOG of an invoice (founder 2026-11-14, build order 1: "Payment log - date, amount, mode; Partly paid ki ardham raavali ante idi kavali") ----
// Every amount received is one line. The invoice's paid amount and its Partly paid / Paid status are WORKED OUT from the lines, never typed.
// No TDS / GST here: those wait for the CA (founder). Self-contained: nothing touches the ATS Accounts.
const PAYMENT_MODES = ['Bank transfer', 'UPI', 'Cheque', 'Cash', 'Card', 'Other'];
const cents = (n) => Math.round(Number(n || 0) * 100) / 100;
const paymentOut = (p) => ({ id: p.id, invoiceId: p.invoiceId, amount: p.amount, paidOn: p.paidOn, mode: p.mode, reference: p.reference, note: p.note, byName: p.createdByName || null, createdAt: p.createdAt });
async function paymentsOf(invoiceId) {
  return (await DB.all('SELECT * FROM "CrmPayment" WHERE "invoiceId" = ? ORDER BY "paidOn" ASC, "createdAt" ASC', invoiceId).catch(() => [])).map(paymentOut);
}
// The invoice follows its lines: nothing received -> back to Sent (or stays Draft/Cancelled), something -> Partly paid, all of it -> Paid.
async function settleInvoice(row) {
  const pays = await paymentsOf(row.id);
  const sum = cents(pays.reduce((n, p) => n + Number(p.amount || 0), 0));
  const data = { paidAmount: Math.min(sum, row.total), updatedAt: DB.nowIso() };
  if (row.status !== 'Cancelled') {
    if (sum > 0 && sum >= cents(row.total)) { data.status = 'Paid'; data.paidAt = `${pays[pays.length - 1].paidOn}T00:00:00.000Z`; } else if (sum > 0) { data.status = 'Partly paid'; data.paidAt = null; } else { data.paidAt = null; if (row.status === 'Paid' || row.status === 'Partly paid') data.status = 'Sent'; }
  }
  return update('CrmInvoice', row.id, data);
}
async function writePayment(user, row, { amount, paidOn, mode, reference, note }) {
  const now = DB.nowIso();
  const pay = await insert('CrmPayment', { id: newId('pay'), invoiceId: row.id, dealId: row.dealId, accountId: row.accountId, amount, paidOn, mode, reference: reference || null, note: note || null, ownerId: row.ownerId, ownerName: row.ownerName, createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now });
  await insert('CrmActivity', { id: newId('act'), kind: 'note', subject: `Payment of ${amount} received on ${row.code || 'the invoice'} (${mode}${reference ? `, ${reference}` : ''})`, note: `${paidOn}`, at: now, dealId: row.dealId, accountId: row.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await audit(user, 'CRM payment received', 'CrmInvoice', row.id, `${row.code || row.id}: ${amount} on ${paidOn} (${mode})`);
  return pay;
}
async function invoiceForPayment(user, id) {
  const r = roleOf(user);
  const row = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!row || !canSeeRow(user, r, row)) return { err: fail(404, 'This invoice is not there.') };
  if (!canEditRow(user, r, row)) return { err: fail(403, 'You cannot change the payments of this invoice.') };
  return { row };
}
// Record one payment: { amount, paidOn (yyyy-mm-dd, today if blank, never in the future), mode, reference, note }.
async function addPayment(user, id, body = {}) {
  const got = await invoiceForPayment(user, id);
  if (got.err) return got.err;
  const row = got.row;
  if (row.status === 'Cancelled') return fail(400, 'This invoice is cancelled. Payments cannot be recorded on it.');
  const amount = cents(num(body.amount));
  if (!(amount > 0)) return fail(400, 'Write the amount received.');
  const left = cents(row.total - row.paidAmount);
  if (left <= 0) return fail(400, 'This invoice is paid in full already.');
  if (amount > left + 0.005) return fail(400, `Only ${left} is left on this invoice. Write that or less.`, { left });
  const paidOn = body.paidOn ? String(body.paidOn).slice(0, 10) : istToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(paidOn))) return fail(400, 'Write the date the money came, like 2026-11-14.');
  if (paidOn > istToday()) return fail(400, 'The payment date cannot be in the future.');
  const mode = body.mode == null || body.mode === '' ? 'Bank transfer' : String(body.mode);
  if (!PAYMENT_MODES.includes(mode)) return fail(400, 'Pick the payment mode from the list.');
  await writePayment(user, row, { amount, paidOn, mode, reference: String(body.reference || '').trim().slice(0, 80), note: String(body.note || '').trim().slice(0, 300) });
  const saved = await settleInvoice(row);
  return okBody({ ok: true, invoice: { ...invoiceOut(saved), payments: await paymentsOf(row.id) } });
}
// A wrong line is deleted (and the invoice follows).
async function deletePayment(user, id, paymentId) {
  const got = await invoiceForPayment(user, id);
  if (got.err) return got.err;
  const row = got.row;
  const pay = await DB.one('SELECT * FROM "CrmPayment" WHERE "id" = ? AND "invoiceId" = ?', String(paymentId || '').slice(0, 60), row.id);
  if (!pay) return fail(404, 'This payment is not there.');
  await DB.run('DELETE FROM "CrmPayment" WHERE "id" = ?', pay.id);
  const now = DB.nowIso();
  await insert('CrmActivity', { id: newId('act'), kind: 'note', subject: `Payment of ${pay.amount} (${pay.paidOn}) removed from ${row.code || 'the invoice'}`, note: null, at: now, dealId: row.dealId, accountId: row.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await audit(user, 'CRM payment removed', 'CrmInvoice', row.id, `${row.code || row.id}: ${pay.amount} on ${pay.paidOn}`);
  const saved = await settleInvoice(row);
  return okBody({ ok: true, invoice: { ...invoiceOut(saved), payments: await paymentsOf(row.id) } });
}
// Mark an invoice Sent / Paid / Partly paid / Cancelled. Paid and Partly paid are SHORTCUTS that write the missing payment line(s)
// (mode Other, "Marked as paid"), so the log always adds up to what the invoice says. To lower the amount, delete a line.
async function setInvoiceStatus(user, id, { status, paidAmount } = {}) {
  const r = roleOf(user);
  const row = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!row || !canSeeRow(user, r, row)) return fail(404, 'This invoice is not there.');
  if (!canEditRow(user, r, row)) return fail(403, 'You cannot change this invoice.');
  if (!INVOICE_STATUSES.includes(status)) return fail(400, 'Pick an invoice status from the list.');
  const now = DB.nowIso();
  let saved;
  if (status === 'Paid' || status === 'Partly paid') {
    if (row.status === 'Cancelled') return fail(400, 'This invoice is cancelled. Set it back to Sent first.');
    const target = status === 'Paid' ? row.total : (num(paidAmount) == null ? row.paidAmount : Math.min(row.total, num(paidAmount)));
    if (status === 'Partly paid' && !(target > 0)) return fail(400, 'Write the amount received.');
    if (cents(target) < cents(row.paidAmount)) return fail(400, 'More than that is already in the payment log. Delete a payment line to lower the amount.');
    const diff = cents(target - row.paidAmount);
    if (diff > 0) await writePayment(user, row, { amount: diff, paidOn: istToday(), mode: 'Other', note: 'Marked as paid' });
    saved = await settleInvoice(row);
  } else {
    if (row.paidAmount > 0) return fail(409, 'Payments are recorded on this invoice. Delete them from the payment log first.', { hasPayments: true });
    saved = await update('CrmInvoice', row.id, { status, paidAmount: 0, paidAt: null, updatedAt: now });
  }
  await audit(user, 'CRM invoice status', 'CrmInvoice', row.id, `${row.code || row.id}: ${row.status} -> ${saved.status}`);
  return okBody({ ok: true, invoice: { ...invoiceOut(saved), payments: await paymentsOf(row.id) } });
}

// Convert a lead: an account (or the one picked), a contact (when the lead names a person) and, unless asked not to, a deal.
async function convertLead(user, id, body = {}) {
  const r = roleOf(user);
  const lead = await getRow('lead', id);
  if (!canEditRow(user, r, lead)) return fail(404, 'This lead is not there, or it is not yours.');
  if (lead.status === 'Converted') return fail(400, 'This lead is converted already.', { accountId: lead.accountId, dealId: lead.dealId });
  const now = DB.nowIso();
  const base = { ownerId: lead.ownerId, ownerName: lead.ownerName, createdById: user.id, createdAt: now, updatedAt: now };
  let account = body.accountId ? await getRow('account', body.accountId) : null;
  if (body.accountId && !canSeeRow(user, r, account)) return fail(400, 'Pick one of your accounts.');
  if (!account) {
    account = await insert('CrmAccount', { id: newId('account'), name: lead.company, industry: lead.industry, city: lead.city, phone: lead.phone, email: lead.email, source: lead.source, kind: 'Prospect', notes: lead.notes, ...base });
  }
  let contact = null;
  if (lead.contactName) {
    contact = await insert('CrmContact', { id: newId('contact'), accountId: account.id, name: lead.contactName, designation: lead.designation, role: CONTACT_ROLES.includes(body.contactRole) ? body.contactRole : 'Decision maker', phone: lead.phone, email: lead.email, ...base });
  }
  let deal = null;
  if (body.createDeal !== false) {
    const d = cleanFields('deal', { title: body.dealTitle || `${lead.company} - deal`, value: body.value != null && body.value !== '' ? body.value : lead.expectedValue, expectedClose: body.expectedClose }, { partial: false });
    if (d.error) return fail(400, d.error);
    const row = { id: newId('deal'), ...d.data, accountId: account.id, contactId: contact ? contact.id : null, leadId: lead.id, stage: 'Contacted', probability: (await SETTINGS.load()).stageProbability.Contacted, ...base };
    row.value = dealValue(row);
    deal = await insert('CrmDeal', row);
  }
  await update('CrmLead', lead.id, { status: 'Converted', convertedAt: now, accountId: account.id, contactId: contact ? contact.id : null, dealId: deal ? deal.id : null, updatedAt: now });
  // what happened on the lead stays visible on the account and the deal
  await DB.run('UPDATE "CrmActivity" SET "accountId" = COALESCE("accountId", ?), "dealId" = COALESCE("dealId", ?) WHERE "leadId" = ?', account.id, deal ? deal.id : null, lead.id);
  await DB.run('UPDATE "CrmTask" SET "accountId" = COALESCE("accountId", ?), "dealId" = COALESCE("dealId", ?) WHERE "leadId" = ?', account.id, deal ? deal.id : null, lead.id);
  await audit(user, 'CRM lead converted', 'CrmLead', lead.id, `${lead.company} -> account${contact ? ' + contact' : ''}${deal ? ' + deal' : ''}`);
  return okBody({ ok: true, account, contact, deal });
}

// ---- activities and follow-ups --------------------------------------------------------------------------
// The record an activity / task is written on (the first link given), checked: the person must be able to edit it.
async function linkedRecord(user, r, body) {
  for (const [k, col] of [['deal', 'dealId'], ['lead', 'leadId'], ['account', 'accountId'], ['contact', 'contactId']]) {
    if (body[col]) {
      const row = await getRow(k, body[col]); // eslint-disable-line no-await-in-loop
      if (!canEditRow(user, r, row)) return { error: fail(404, 'That record is not there, or it is not yours.') };
      return { kind: k, row };
    }
  }
  return { error: fail(400, 'Say which lead, deal or account this is for.') };
}
function linksOf(kind, row) {
  if (kind === 'deal') return { dealId: row.id, accountId: row.accountId || null };
  if (kind === 'lead') return { leadId: row.id, accountId: row.accountId || null };
  if (kind === 'contact') return { contactId: row.id, accountId: row.accountId || null };
  return { accountId: row.id };
}

async function addTaskRow(user, r, link, body) {
  const title = clip(body.title, 200);
  const dueDate = clip(body.dueDate, 10);
  if (!title) return { error: fail(400, 'What is the follow-up? Please write it.') };
  if (!dueDate || !YMD.test(dueDate)) return { error: fail(400, 'Pick the follow-up date.') };
  const dueTime = clip(body.dueTime, 5);
  if (dueTime && !HM.test(dueTime)) return { error: fail(400, 'Pick a proper time.') };
  const own = await pickOwner(user, r, clip(body.ownerId, 60) || link.row.ownerId);
  const now = DB.nowIso();
  const lk = linksOf(link.kind, link.row);
  const task = await insert('CrmTask', { id: newId('task'), title, dueDate, dueTime, ...(await require('./sales').taskExtras(body)), status: 'Open', leadId: lk.leadId || null, accountId: lk.accountId || null, dealId: lk.dealId || null, ownerId: (own || { id: user.id }).id, ownerName: (own || { name: user.name }).name || null, createdById: user.id, createdAt: now, updatedAt: now });
  return { task };
}

async function addActivity(user, body = {}) {
  const r = roleOf(user);
  if (!mayEdit(r)) return fail(403, 'Your role can read the CRM but not add to it.');
  const kind = ACTIVITY_KINDS[body.kind] ? body.kind : null;
  if (!kind) return fail(400, 'Pick what it was: call, meeting, email, WhatsApp or note.');
  const subject = clip(body.subject, 200); const note = clip(body.note, 4000);
  if (!subject && !note) return fail(400, 'Write what happened.');
  const link = await linkedRecord(user, r, body);
  if (link.error) return link.error;
  let at = DB.nowIso();
  if (body.at) { const t = new Date(body.at); if (!Number.isNaN(t.getTime())) at = t.toISOString(); }
  const now = DB.nowIso();
  const lk = linksOf(link.kind, link.row);
  const activity = await insert('CrmActivity', { id: newId('act'), kind, subject, note, at, leadId: lk.leadId || null, accountId: lk.accountId || null, dealId: lk.dealId || null, contactId: lk.contactId || clip(body.contactId, 60), byId: user.id, byName: user.name || null, createdAt: now });
  // a New lead that was called / mailed / met is Contacted now - unless the call was only an attempt (outcome 'No answer')
  if (link.kind === 'lead' && link.row.status === 'New' && kind !== 'note' && body.outcome !== 'No answer') await update('CrmLead', link.row.id, { status: 'Contacted', updatedAt: now });
  else await update(KINDS[link.kind].table, link.row.id, { updatedAt: now });
  // "next follow-up" given with the activity
  let task = null;
  if (body.followUp && body.followUp.dueDate) {
    const t = await addTaskRow(user, r, link, { title: body.followUp.title || `Follow up: ${link.row[KINDS[link.kind].name]}`, dueDate: body.followUp.dueDate, dueTime: body.followUp.dueTime });
    if (t.error) return t.error;
    task = t.task;
  }
  return okBody({ ok: true, activity, task });
}

async function addTask(user, body = {}) {
  const r = roleOf(user);
  if (!mayEdit(r)) return fail(403, 'Your role can read the CRM but not add to it.');
  const link = await linkedRecord(user, r, body);
  if (link.error) return link.error;
  const t = await addTaskRow(user, r, link, body);
  if (t.error) return t.error;
  return okBody({ ok: true, task: t.task });
}

// A follow-up done = what happened + what came of it + (optionally) the next follow-up, all at once (founder 2026-11-14). The outcome and the
// note go on the record's timeline as a call / meeting / email / WhatsApp, so the timeline is the one history of every contact. `input` is a
// plain note (older callers) or { note, outcome, next: { dueDate, dueTime, title, type, priority } }.
const TASK_ACTIVITY = { Call: 'call', Meeting: 'meeting', Visit: 'meeting', Email: 'email', WhatsApp: 'whatsapp' };
async function finishTask(user, id, input) {
  const body = input && typeof input === 'object' ? input : { note: input };
  const r = roleOf(user);
  const row = await getRow('CrmTask', id);
  if (!canEditRow(user, r, row)) return fail(404, 'This follow-up is not there, or it is not yours.');
  if (row.status === 'Done') return okBody({ ok: true, task: row });
  const SALES = require('./sales'); // eslint-disable-line global-require
  const outcome = SALES.OUTCOMES.includes(body.outcome) ? body.outcome : null;
  const note = clip(body.note, 1000);
  const nx = body.next && body.next.dueDate ? body.next : null;
  if (nx && !YMD.test(clip(nx.dueDate, 10))) return fail(400, 'Pick a proper date for the next follow-up.'); // checked first: nothing is saved on a bad date
  if (nx && nx.dueTime && !HM.test(clip(nx.dueTime, 5))) return fail(400, 'Pick a proper time for the next follow-up.');
  const now = DB.nowIso();
  const task = await update('CrmTask', row.id, { status: 'Done', doneAt: now, doneNote: note, outcome, updatedAt: now });
  const kind = TASK_ACTIVITY[row.type] || 'note';
  const what = outcome || note;
  let activity = null;
  if (what) {
    activity = await insert('CrmActivity', {
      id: newId('act'), kind, subject: `${row.type || 'Follow-up'} done: ${row.title}`, note: [outcome ? `Outcome: ${outcome}` : '', note].filter(Boolean).join('. ') || null, at: now,
      leadId: row.leadId || null, accountId: row.accountId || null, dealId: row.dealId || null, byId: user.id, byName: user.name || null, createdAt: now,
    });
  }
  // the record was touched (it is not "quiet" any more); a New lead that was reached is Contacted
  const table = row.dealId ? 'CrmDeal' : row.leadId ? 'CrmLead' : row.accountId ? 'CrmAccount' : null;
  const recId = row.dealId || row.leadId || row.accountId;
  if (table) await update(table, recId, { updatedAt: now });
  if (!row.dealId && row.leadId && kind !== 'note' && outcome !== 'No answer') {
    await DB.run('UPDATE "CrmLead" SET "status" = ? WHERE "id" = ? AND "status" = ?', 'Contacted', row.leadId, 'New');
  }
  let next = null;
  if (nx) {
    next = await insert('CrmTask', {
      id: newId('task'), title: clip(nx.title, 200) || row.title, dueDate: clip(nx.dueDate, 10), dueTime: nx.dueTime ? clip(nx.dueTime, 5) : null,
      ...(await SALES.taskExtras({ type: nx.type || row.type, priority: nx.priority || row.priority, remindBefore: row.remindBefore, notifyApp: row.notifyApp !== 0, notifyWhatsapp: row.notifyWhatsapp === 1, notifySms: row.notifySms === 1, notifyLead: row.notifyLead === 1 })),
      status: 'Open', leadId: row.leadId || null, accountId: row.accountId || null, dealId: row.dealId || null,
      ownerId: row.ownerId, ownerName: row.ownerName, createdById: user.id, createdAt: now, updatedAt: now,
    });
  }
  return okBody({ ok: true, task, next, activity });
}

// Follow-ups in my scope: overdue, today, upcoming (7 days), or done (last 30 days). mine=1: only mine.
async function tasks(user, { when = 'open', mine, all, from, to, owner, priority, type } = {}) {
  const r = roleOf(user);
  const s = (mine || !seesAll(r)) ? { sql: 't."ownerId" = ?', params: [user.id] } : { sql: '1=1', params: [] };
  if (owner && seesAll(r)) { s.sql += ' AND t."ownerId" = ?'; s.params.push(clip(owner, 60)); }
  // High / Medium / Low (a follow-up from before priorities counts as Medium)
  if (['High', 'Medium', 'Low'].includes(priority)) { s.sql += priority === 'Medium' ? ' AND COALESCE(t."priority", \'Medium\') = ?' : ' AND t."priority" = ?'; s.params.push(priority); }
  if (type) { s.sql += ' AND COALESCE(t."type", \'Call\') = ?'; s.params.push(clip(type, 20)); }
  if (from && YMD.test(from)) { s.sql += ' AND t."dueDate" >= ?'; s.params.push(from); }
  if (to && YMD.test(to)) { s.sql += ' AND t."dueDate" <= ?'; s.params.push(to); }
  const today = istToday();
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const cond = {
    // Needs action = everything open that is due today or already late (overdue first: the list is ordered by date)
    action: ['t."status" = \'Open\' AND t."dueDate" <= ?', [today]],
    overdue: ['t."status" = \'Open\' AND t."dueDate" < ?', [today]],
    today: ['t."status" = \'Open\' AND t."dueDate" = ?', [today]],
    upcoming: all ? ['t."status" = \'Open\' AND t."dueDate" > ?', [today]] : ['t."status" = \'Open\' AND t."dueDate" > ? AND t."dueDate" <= ?', [today, week]],
    open: ['t."status" = \'Open\'', []],
    done: from || to ? ['t."status" = \'Done\'', []] : ['t."status" = \'Done\' AND t."doneAt" >= ?', [new Date(Date.now() - 30 * 86400000).toISOString()]],
  }[when] || ['t."status" = \'Open\'', []];
  return DB.all(`SELECT t.*, COALESCE(d."title", l."company", a."name") AS "recordName",
      CASE WHEN t."dealId" IS NOT NULL THEN 'deal' WHEN t."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind",
      COALESCE(t."dealId", t."leadId", t."accountId") AS "recordId"
    FROM "CrmTask" t LEFT JOIN "CrmDeal" d ON d."id" = t."dealId" LEFT JOIN "CrmLead" l ON l."id" = t."leadId" LEFT JOIN "CrmAccount" a ON a."id" = t."accountId"
    WHERE ${s.sql} AND ${cond[0]} ORDER BY t."dueDate" ${when === 'done' ? 'DESC' : 'ASC'}, CASE COALESCE(t."priority", 'Medium') WHEN 'High' THEN 0 WHEN 'Low' THEN 2 ELSE 1 END ASC, t."dueTime" ASC LIMIT 300`, ...s.params, ...cond[1]);
}
// Move an open follow-up to another day (and time): "snooze". It reminds again and, if it is late again, tells the managers again (founder 2026-11-14).
async function snoozeTask(user, id, { dueDate, dueTime } = {}) {
  const r = roleOf(user);
  const row = await getRow('CrmTask', id);
  if (!canEditRow(user, r, row)) return fail(404, 'This follow-up is not there, or it is not yours.');
  if (row.status !== 'Open') return fail(409, 'Only an open follow-up can be moved.');
  const date = clip(dueDate, 10);
  if (!date || !YMD.test(date)) return fail(400, 'Pick the new date.');
  if (date < istToday()) return fail(400, 'Pick today or a later day.');
  const time = dueTime === undefined ? row.dueTime : (clip(dueTime, 5) || null);
  if (time && !HM.test(time)) return fail(400, 'Pick a proper time.');
  const now = DB.nowIso();
  const task = await update('CrmTask', row.id, { dueDate: date, dueTime: time || null, reminderSentAt: null, remindedOn: null, escalatedAt: null, reminderNote: null, updatedAt: now });
  await insert('CrmActivity', { id: newId('act'), kind: 'note', subject: `Follow-up moved: ${row.title}`, note: `${row.dueDate}${row.dueTime ? ` ${row.dueTime}` : ''} → ${date}${time ? ` ${time}` : ''}`, at: now, leadId: row.leadId || null, accountId: row.accountId || null, dealId: row.dealId || null, byId: user.id, byName: user.name || null, createdAt: now });
  return okBody({ ok: true, task });
}
// The numbers on the Follow-ups tabs: how many are overdue, due today and still to come, in the viewer's scope.
async function taskCounts(user, { owner } = {}) {
  const r = roleOf(user);
  const s = !seesAll(r) ? { sql: 't."ownerId" = ?', params: [user.id] } : { sql: '1=1', params: [] };
  if (owner && seesAll(r)) { s.sql += ' AND t."ownerId" = ?'; s.params.push(clip(owner, 60)); }
  const today = istToday();
  const one = await DB.one(`SELECT
      SUM(CASE WHEN t."dueDate" < ? THEN 1 ELSE 0 END) AS "overdue",
      SUM(CASE WHEN t."dueDate" = ? THEN 1 ELSE 0 END) AS "today",
      SUM(CASE WHEN t."dueDate" > ? THEN 1 ELSE 0 END) AS "upcoming"
    FROM "CrmTask" t WHERE t."status" = 'Open' AND ${s.sql}`, today, today, today, ...s.params);
  const overdue = Number(one && one.overdue) || 0; const dueToday = Number(one && one.today) || 0;
  return okBody({ counts: { overdue, today: dueToday, needsAction: overdue + dueToday, upcoming: Number(one && one.upcoming) || 0 } });
}

// ---- reminders: a bell notice (and an email) to the owner the day a follow-up is due, and once a day while it is late --
async function remind({ userId } = {}) {
  const today = istToday();
  const rows = await DB.all(`SELECT t.*, COALESCE(d."title", l."company", a."name") AS "recordName" FROM "CrmTask" t
    LEFT JOIN "CrmDeal" d ON d."id" = t."dealId" LEFT JOIN "CrmLead" l ON l."id" = t."leadId" LEFT JOIN "CrmAccount" a ON a."id" = t."accountId"
    WHERE t."status" = 'Open' AND t."dueDate" <= ? AND COALESCE(t."remindedOn", '') < ? ${userId ? 'AND t."ownerId" = ?' : ''} LIMIT 500`, today, today, ...(userId ? [userId] : []));
  if (!rows.length) return 0;
  const byOwner = new Map();
  rows.forEach((t) => { if (t.ownerId) byOwner.set(t.ownerId, [...(byOwner.get(t.ownerId) || []), t]); });
  for (const [ownerId, list] of byOwner) {
    for (const t of list) {
      // eslint-disable-next-line no-await-in-loop
      await notifyUsers([ownerId], { title: `CRM follow-up ${t.dueDate < today ? 'late' : 'today'} — ${t.recordName || 'CRM'}`, message: `${t.title}${t.dueTime ? ` at ${t.dueTime}` : ''}${t.dueDate < today ? ` (was due ${t.dueDate})` : ''}` }).catch(() => null);
      await DB.run('UPDATE "CrmTask" SET "remindedOn" = ? WHERE "id" = ?', today, t.id); // eslint-disable-line no-await-in-loop
    }
    if (!process.env.TEST_MODE) {
      // eslint-disable-next-line no-await-in-loop
      const u = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true } }).catch(() => null);
      if (u && u.email) {
        const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
        const lines = list.map((t) => `- ${t.title} (${t.recordName || 'CRM'})${t.dueTime ? ` at ${t.dueTime}` : ''}${t.dueDate < today ? ` - late, was due ${t.dueDate}` : ''}`);
        // eslint-disable-next-line no-await-in-loop, global-require
        await require('../utils/mailer').sendMail({ to: u.email, subject: `TeamLink CRM: ${list.length} follow-up(s) for today`, text: `Hello ${u.name || ''},\n\nYour CRM follow-ups for today:\n${lines.join('\n')}\n\n${base ? `Open the CRM: ${base}/crm/dashboard\n` : ''}` }).catch(() => null);
      }
    }
  }
  return rows.length;
}

// ---- the dashboard --------------------------------------------------------------------------------------
async function dashboard(user, { mine } = {}) {
  const r = roleOf(user);
  const s = (mine || !seesAll(r)) ? { sql: '"ownerId" = ?', params: [user.id] } : { sql: '1=1', params: [] };
  await remind({ userId: user.id }).catch(() => 0);
  const ist = istNow();
  const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600 * 1000).toISOString();
  const deals = await DB.all(`SELECT "id", "title", "stage", "value", "probability", "expectedClose", "wonAt", "lostAt", "lostReason", "ownerName", "accountId" FROM "CrmDeal" WHERE ${s.sql}`, ...s.params);
  const open = deals.filter((d) => !['Won', 'Lost'].includes(d.stage));
  const byStage = STAGES.map((st) => { const ds = deals.filter((d) => d.stage === st && (!['Won', 'Lost'].includes(st) || (d.wonAt || d.lostAt || '') >= monthStart)); return { stage: st, count: ds.length, value: ds.reduce((a, d) => a + (d.value || 0), 0) }; });
  const wonM = deals.filter((d) => d.stage === 'Won' && (d.wonAt || '') >= monthStart);
  const lostM = deals.filter((d) => d.stage === 'Lost' && (d.lostAt || '') >= monthStart);
  const today = istToday();
  const in30 = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const accName = new Map((await DB.all('SELECT "id", "name" FROM "CrmAccount"')).map((a) => [a.id, a.name]));
  // "Closing in the next 30 days" is only what is still to come; a close date that has already passed is its own list, "Close date passed"
  // (founder 2026-11-14: a heading that says 30 days must not hold dates from last month)
  const withClose = open.filter((d) => d.expectedClose).sort((a, b) => a.expectedClose.localeCompare(b.expectedClose)).map((d) => ({ ...d, accountName: accName.get(d.accountId) || null, late: d.expectedClose < today }));
  const closingSoon = withClose.filter((d) => !d.late && d.expectedClose <= in30).slice(0, 8);
  const overdueClose = withClose.filter((d) => d.late).slice(0, 8);
  const overdueCloseCount = withClose.filter((d) => d.late).length;
  const leads = await DB.all(`SELECT "status", "source", "createdAt" FROM "CrmLead" WHERE ${s.sql}`, ...s.params);
  const countBy = (rows, key) => Object.entries(rows.reduce((m, x) => { const k = x[key] || 'Not given'; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const lostReasons = countBy(deals.filter((d) => d.stage === 'Lost' && (d.lostAt || '') >= new Date(Date.now() - 90 * 86400000).toISOString()), 'lostReason');
  const sumV = (ds) => ds.reduce((a, d) => a + (d.value || 0), 0);
  const recent = await DB.all(`SELECT x.*, COALESCE(d."title", l."company", a."name") AS "recordName",
      CASE WHEN x."dealId" IS NOT NULL THEN 'deal' WHEN x."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind",
      COALESCE(x."dealId", x."leadId", x."accountId") AS "recordId"
    FROM "CrmActivity" x LEFT JOIN "CrmDeal" d ON d."id" = x."dealId" LEFT JOIN "CrmLead" l ON l."id" = x."leadId" LEFT JOIN "CrmAccount" a ON a."id" = x."accountId"
    WHERE ${s.sql === '1=1' ? '1=1' : 'x."byId" = ?'} ORDER BY x."at" DESC LIMIT 10`, ...s.params);
  const closedM = wonM.length + lostM.length;
  return okBody({
    today,
    scope: s.sql === '1=1' ? 'all' : 'mine',
    pipeline: { open: open.length, value: sumV(open), weighted: Math.round(open.reduce((a, d) => a + (d.value || 0) * (d.probability || 0) / 100, 0)) },
    month: { won: wonM.length, wonValue: sumV(wonM), lost: lostM.length, lostValue: sumV(lostM), winRate: closedM ? Math.round((wonM.length / closedM) * 100) : null },
    leads: {
      open: leads.filter((l) => !['Converted', 'Junk'].includes(l.status)).length,
      newThisMonth: leads.filter((l) => (l.createdAt || '') >= monthStart).length,
      converted: leads.filter((l) => l.status === 'Converted').length,
      total: leads.length,
      byStatus: LEAD_STATUSES.map((st) => ({ name: st, count: leads.filter((l) => l.status === st).length })),
      bySource: countBy(leads, 'source'),
    },
    byStage,
    closingSoon,
    overdueClose,
    overdueCloseCount,
    lostReasons,
    followUps: {
      overdue: await tasks(user, { when: 'overdue', mine }),
      today: await tasks(user, { when: 'today', mine }),
      upcoming: await tasks(user, { when: 'upcoming', mine }),
    },
    recent,
  });
}

// ---- delete (Admin / BDE TL; a BDE removes only an activity or follow-up they wrote themselves) ----------------
async function remove(user, kind, id) {
  const r = roleOf(user);
  const table = { lead: 'CrmLead', account: 'CrmAccount', contact: 'CrmContact', deal: 'CrmDeal', activity: 'CrmActivity', task: 'CrmTask' }[kind];
  if (!table) return fail(404, 'Not found.');
  const row = await getRow(table, id);
  if (!row) return fail(404, 'This record is not there.');
  const own = (kind === 'activity' ? row.byId : row.createdById || row.ownerId) === user.id || row.ownerId === user.id;
  // a Sales manager / Admin deletes anything; a Salesperson their own activities and follow-ups, and their own records when their
  // rights allow deleting
  const mine = (r === 'bde' || r === 'bdeAll') && own;
  if (!mayAssign(r) && !(mine && (kind === 'activity' || kind === 'task')) && !(mine && can(user, 'delete'))) {
    return fail(403, kind === 'lead' ? 'Your CRM rights do not allow deleting: mark the lead Junk, or ask a Sales manager.' : 'Your CRM rights do not allow deleting this.');
  }
  if (kind === 'account') {
    const n = await DB.one('SELECT COUNT(*) AS "n" FROM "CrmDeal" WHERE "accountId" = ?', row.id);
    if (n && n.n) return fail(400, 'This account still has deals. Delete or move its deals first.');
    await DB.run('UPDATE "CrmContact" SET "accountId" = NULL WHERE "accountId" = ?', row.id);
  }
  if (kind === 'deal') await DB.run('UPDATE "CrmLead" SET "dealId" = NULL WHERE "dealId" = ?', row.id);
  await DB.run(`DELETE FROM "${table}" WHERE "id" = ?`, row.id);
  await audit(user, `CRM ${kind} deleted`, table, row.id, row.company || row.name || row.title || row.subject);
  return okBody({ ok: true });
}

// the support pick lists (crm/support.js requires this file, so it is read when asked)
function ticketLists() {
  const T = require('./support'); // eslint-disable-line global-require
  return { ticketPriorities: T.PRIORITIES, ticketStatuses: T.STATUSES, ticketCategories: T.CATEGORIES, ticketChannels: T.CHANNELS, slaHours: T.SLA_HOURS };
}

async function me(user) {
  const r = roleOf(user);
  if (!r) return fail(403, 'The CRM is for the sales team. Ask an Admin to add you to the sales team (CRM settings).');
  await backfillCodes().catch(() => {}); // old records get their L-/D-/C- code once
  const st = await SETTINGS.load();
  return okBody({
    userId: user.id, name: user.name || '',
    role: r, canEdit: mayEdit(r) && can(user, 'edit'), canCreate: mayEdit(r) && can(user, 'create'), canAssign: mayAssign(r), seesAll: seesAll(r), rights: rightsOf(user),
    owners: mayAssign(r) || seesAll(r) ? await ownerOptions() : [],
    salesTeam: mayAssign(r) ? st.salesTeam : [], // the CRM's own team: who may open it, and each one's rights
    team: mayAssign(r) ? { roles: SETTINGS.ROLES, rights: SETTINGS.RIGHTS, roleRights: SETTINGS.ROLE_RIGHTS } : null,
    invoiceFrom: st.invoiceFrom, invoiceTaxPercent: st.invoiceTaxPercent, invoiceDueDays: st.invoiceDueDays, meetingLink: st.meetingLink, bookingHours: st.bookingHours, discountApprovalLimit: st.discountApprovalLimit,
    lists: { leadStages: st.leadStages, taskTypes: ['Call', 'Meeting', 'WhatsApp', 'Visit', 'Email', 'Other'], priorities: ['High', 'Medium', 'Low'], outcomes: ['Spoke', 'No answer', 'Meeting held', 'Sent details', 'Not interested'], overdueAlertManagers: st.overdueAlertManagers !== false, autoFirstFollowUp: st.autoFirstFollowUp !== false, defaultRemindBefore: st.defaultRemindBefore, stages: STAGES, stageProbability: st.stageProbability, leadStatuses: LEAD_STATUSES, sources: st.sources, contactRoles: CONTACT_ROLES, activityKinds: ACTIVITY_KINDS, lostReasons: st.lostReasons, ratings: RATINGS, staleDays: st.staleDays, proposalValidityDays: st.proposalValidityDays, ...ticketLists() },
  });
}

module.exports = {
  roleOf, crmRoleFor, can, rightsOf, me, list, detail, create, edit, moveDeal, decideDeal, taskCounts, snoozeTask, hasLoggedWork, NEEDS_LOGGED_WORK, backfillInvoices, invoiceForDeal, addPayment, deletePayment, PAYMENT_MODES, invoices, invoiceDetail, setInvoiceStatus, createInvoiceForDeal, convertLead, addActivity, addTask, finishTask, tasks, remind, dashboard, remove, duplicatesOf, dealValue,
  STAGES, LEAD_STATUSES, RATINGS,
  // shared with crm/extra.js
  resetCodeCounters, ownerOptions, getRow, insert, update, audit, canSeeRow, canEditRow, seesAll, mayEdit, mayAssign, scopeSql, newId, clip, num, fail, okBody, istToday, istNow, normCo, phone10, cleanFields, CONTACT_ROLES,
};

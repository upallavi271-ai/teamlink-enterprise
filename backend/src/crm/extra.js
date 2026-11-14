// ---------------------------------------------------------------------------
// THE FULL CRM, ON TOP OF THE FOUR SCREENS (founder 2026-11-02: "crm lo em em vundalo, 360 deg research chesi, mottham
// verify chesi, implement cheyyu" - what Salesforce / Zoho / HubSpot / Freshsales / Pipedrive carry, inside the same four
// modules, no new sidebar entries):
//   reports      BDE performance vs target (leads, calls, meetings, won, achievement), forecast by close month, the lead
//                funnel, deals going cold                                           -> Dashboard
//   targets      a monthly target per BDE (won value, deals), set by the BDE TL / Admin -> Dashboard
//   settings     sources, lost reasons, stage probabilities, "going cold" days        -> Dashboard (crm/settings.js)
//   import       leads from Excel / CSV, duplicates skipped with the reason           -> Leads
//   bulk         give leads to a BDE / set status / rating for many at once          -> Leads
//   proposals    a proposal PDF from a deal (positions, fee terms), emailed to the client, Accepted / Declined -> Deals
//   export       leads, deals, accounts, contacts, activities, follow-ups as CSV (what the login may see)
// The same access rules as crm/service.js: a BDE their own records, BDE TL / Admin everything, Manager read only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const YM = /^\d{4}-\d{2}$/;
const monthNow = () => S.istToday().slice(0, 7);
// a month (YYYY-MM, India time) as an ISO range
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const off = 5.5 * 3600 * 1000;
  return [new Date(Date.UTC(y, m - 1, 1) - off).toISOString(), new Date(Date.UTC(y, m, 1) - off).toISOString()];
}
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const byKey = (rows, key) => new Map(rows.map((r) => [r[key], r]));

// ---- reports (Dashboard) -------------------------------------------------------------------------------
async function reports(user, { month } = {}) {
  const r = S.roleOf(user);
  // a salesperson always sees their own month and target; the team's numbers need the reports right
  if (!S.can(user, 'reports') && S.seesAll(r)) return S.fail(403, 'Your CRM rights do not include reports. Ask a Sales manager.');
  const ym = YM.test(String(month || '')) ? month : monthNow();
  const [from, to] = monthRange(ym);
  const all = S.seesAll(r);
  const own = all ? '1=1' : '"ownerId" = ?';
  const p = all ? [] : [user.id];
  const st = await SETTINGS.load();

  // who is on the table: every BDE for the TL / Admin / Manager, the BDE alone otherwise
  const owners = all ? await S.ownerOptions() : [{ id: user.id, name: user.name }];
  const leads = byKey(await DB.all(`SELECT "ownerId", COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "createdAt" >= ? AND "createdAt" < ? GROUP BY "ownerId"`, ...p, from, to), 'ownerId');
  const conv = byKey(await DB.all(`SELECT "ownerId", COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "convertedAt" >= ? AND "convertedAt" < ? GROUP BY "ownerId"`, ...p, from, to), 'ownerId');
  const acts = await DB.all(`SELECT "byId", "kind", COUNT(*) AS "n" FROM "CrmActivity" WHERE ${all ? '1=1' : '"byId" = ?'} AND "at" >= ? AND "at" < ? AND COALESCE("subject", '') NOT LIKE 'Stage:%' GROUP BY "byId", "kind"`, ...p, from, to);
  const won = byKey(await DB.all(`SELECT "ownerId", COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ? GROUP BY "ownerId"`, ...p, from, to), 'ownerId');
  const lost = byKey(await DB.all(`SELECT "ownerId", COUNT(*) AS "n" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Lost' AND "lostAt" >= ? AND "lostAt" < ? GROUP BY "ownerId"`, ...p, from, to), 'ownerId');
  const open = byKey(await DB.all(`SELECT "ownerId", COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v", COALESCE(SUM("value" * "probability" / 100.0), 0) AS "w" FROM "CrmDeal" WHERE ${own} AND "stage" NOT IN ('Won', 'Lost') GROUP BY "ownerId"`, ...p), 'ownerId');
  const targets = byKey(await DB.all(`SELECT * FROM "CrmTarget" WHERE "month" = ? AND ${own}`, ym, ...p), 'ownerId');
  // somebody who holds records but is not in the BDE list any more (left, changed role) still shows
  const known = new Set(owners.map((o) => o.id));
  if (all) {
    const extra = await DB.all('SELECT DISTINCT "ownerId", "ownerName" FROM "CrmDeal" WHERE "ownerId" IS NOT NULL UNION SELECT DISTINCT "ownerId", "ownerName" FROM "CrmLead" WHERE "ownerId" IS NOT NULL');
    extra.forEach((x) => { if (!known.has(x.ownerId)) { known.add(x.ownerId); owners.push({ id: x.ownerId, name: x.ownerName || '—', former: true }); } });
  }
  const actOf = (id, kind) => acts.filter((a) => a.byId === id && (!kind || a.kind === kind)).reduce((s, a) => s + a.n, 0);
  const performance = owners.map((o) => {
    const t = targets.get(o.id);
    const wv = (won.get(o.id) || {}).v || 0;
    return {
      ownerId: o.id, ownerName: o.name, former: !!o.former,
      leads: (leads.get(o.id) || {}).n || 0,
      converted: (conv.get(o.id) || {}).n || 0,
      calls: actOf(o.id, 'call'), meetings: actOf(o.id, 'meeting'), activities: actOf(o.id),
      won: (won.get(o.id) || {}).n || 0, wonValue: wv,
      lost: (lost.get(o.id) || {}).n || 0,
      openDeals: (open.get(o.id) || {}).n || 0, openValue: (open.get(o.id) || {}).v || 0, weighted: Math.round((open.get(o.id) || {}).w || 0),
      target: t ? t.amount : null, targetDeals: t ? t.deals : null,
      achievement: t && t.amount ? Math.round((wv / t.amount) * 100) : null,
    };
  }).filter((x) => !x.former || x.leads || x.activities || x.won || x.openDeals)
    .sort((a, b) => b.wonValue - a.wonValue || b.weighted - a.weighted || String(a.ownerName).localeCompare(String(b.ownerName)));
  const sum = (k) => performance.reduce((s, x) => s + (x[k] || 0), 0);
  const totalTarget = performance.reduce((s, x) => s + (x.target || 0), 0);
  const totals = { leads: sum('leads'), converted: sum('converted'), calls: sum('calls'), meetings: sum('meetings'), activities: sum('activities'), won: sum('won'), wonValue: sum('wonValue'), lost: sum('lost'), openDeals: sum('openDeals'), openValue: sum('openValue'), weighted: sum('weighted'), target: totalTarget || null, achievement: totalTarget ? Math.round((sum('wonValue') / totalTarget) * 100) : null };

  // forecast: open deals by the month they should close (late / this month / next two / later / no date)
  const today = S.istToday();
  const thisM = monthNow();
  const openDeals = await DB.all(`SELECT "id", "title", "value", "probability", "expectedClose", "ownerName", "stage", "accountId", "updatedAt", "createdAt",
      (SELECT MAX(a."at") FROM "CrmActivity" a WHERE a."dealId" = d."id") AS "lastActivityAt" FROM "CrmDeal" d WHERE ${own} AND "stage" NOT IN ('Won', 'Lost')`, ...p);
  const buckets = [['late', 'Late (date passed)'], [thisM, 'This month'], [addMonths(thisM, 1), 'Next month'], [addMonths(thisM, 2), 'In 2 months'], ['later', 'Later'], ['none', 'No close date']];
  const bucketOf = (d) => { if (!d.expectedClose) return 'none'; if (d.expectedClose < today) return 'late'; const m = d.expectedClose.slice(0, 7); return m <= addMonths(thisM, 2) ? m : 'later'; };
  const forecast = buckets.map(([key, label]) => {
    const ds = openDeals.filter((d) => bucketOf(d) === key);
    return { key, label, count: ds.length, value: ds.reduce((s, d) => s + (d.value || 0), 0), weighted: Math.round(ds.reduce((s, d) => s + (d.value || 0) * (d.probability || 0) / 100, 0)) };
  });

  // the funnel of the leads added this month: added -> contacted -> qualified -> converted -> won
  const fl = await DB.all(`SELECT "id", "status", "dealId" FROM "CrmLead" WHERE ${own} AND "createdAt" >= ? AND "createdAt" < ?`, ...p, from, to);
  const wonFromLeads = fl.length ? (await DB.one(`SELECT COUNT(*) AS "n" FROM "CrmDeal" WHERE "stage" = 'Won' AND "leadId" IN (${fl.map(() => '?').join(', ')})`, ...fl.map((l) => l.id))).n : 0;
  const funnel = [
    { step: 'Leads added', count: fl.length },
    { step: 'Contacted', count: fl.filter((l) => l.status !== 'New' && l.status !== 'Junk').length },
    { step: 'Qualified', count: fl.filter((l) => ['Qualified', 'Converted'].includes(l.status)).length },
    { step: 'Converted to a deal', count: fl.filter((l) => l.status === 'Converted').length },
    { step: 'Won', count: wonFromLeads },
  ];

  // deals going cold: open, and nothing logged for staleDays (or never, and made that long ago)
  const coldSince = new Date(Date.now() - st.staleDays * 86400000).toISOString();
  const accName = new Map((await DB.all('SELECT "id", "name" FROM "CrmAccount"')).map((a) => [a.id, a.name]));
  const stale = openDeals.filter((d) => (d.lastActivityAt || d.createdAt) < coldSince)
    .map((d) => ({ id: d.id, title: d.title, value: d.value, stage: d.stage, ownerName: d.ownerName, accountName: accName.get(d.accountId) || null, lastActivityAt: d.lastActivityAt, days: Math.floor((Date.now() - Date.parse(d.lastActivityAt || d.createdAt)) / 86400000) }))
    .sort((a, b) => b.days - a.days).slice(0, 20);

  return S.okBody({ month: ym, scope: all ? 'all' : 'mine', performance, totals, forecast, funnel, stale, staleDays: st.staleDays });
}

// ---- targets --------------------------------------------------------------------------------------------------
async function setTarget(user, { month, ownerId, amount, deals } = {}) {
  const r = S.roleOf(user);
  if (!S.mayAssign(r)) return S.fail(403, 'Targets are set by a Sales manager or an Admin.');
  if (!YM.test(String(month || ''))) return S.fail(400, 'Pick the month.');
  const o = (await S.ownerOptions()).find((x) => x.id === ownerId);
  if (!o) return S.fail(400, 'Pick the salesperson from the list.');
  const a = S.num(amount); const d = S.num(deals);
  if (a == null) return S.fail(400, 'Write the target amount in ₹ (0 removes it).');
  const now = DB.nowIso();
  const cur = await DB.one('SELECT * FROM "CrmTarget" WHERE "ownerId" = ? AND "month" = ?', o.id, month);
  if (!a && !d) {
    if (cur) await DB.run('DELETE FROM "CrmTarget" WHERE "id" = ?', cur.id);
    return S.okBody({ ok: true, target: null });
  }
  const target = cur
    ? await S.update('CrmTarget', cur.id, { amount: a, deals: d == null ? null : Math.round(d), ownerName: o.name, setById: user.id, updatedAt: now })
    : await S.insert('CrmTarget', { id: S.newId('target'), ownerId: o.id, ownerName: o.name, month, amount: a, deals: d == null ? null : Math.round(d), setById: user.id, createdAt: now, updatedAt: now });
  await S.audit(user, 'CRM target set', 'CrmTarget', target.id, `${o.name} ${month}: ₹${a}${d ? `, ${d} deals` : ''}`);
  return S.okBody({ ok: true, target });
}

// ---- settings -------------------------------------------------------------------------------------------------
async function saveSettings(user, body) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'CRM settings are changed by a Sales manager or an Admin.');
  const st = await SETTINGS.save(body || {});
  if (body && Array.isArray(body.salesTeam)) await S.audit(user, 'CRM sales team changed', 'AppSetting', 'crm.settings', st.salesTeam.map((m) => `${m.name}: ${m.role}`).join(', ').slice(0, 300));
  await S.audit(user, 'CRM settings changed', 'AppSetting', 'crm.settings', `${st.sources.length} sources, ${st.lostReasons.length} lost reasons, cold after ${st.staleDays} days`);
  return S.okBody({ ok: true, settings: st });
}

// People an Admin / Sales manager may add to the sales team: staff logins that are active (never a client / candidate).
async function people(user, q) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'The sales team is set up by an Admin or a Sales manager.');
  const text = String(q || '').trim().slice(0, 60);
  const rows = await prisma.user.findMany({
    where: { status: 'Active', clientId: null, candidateId: null, ...(text ? { OR: [{ name: { contains: text } }, { email: { contains: text } }] } : {}) },
    select: { id: true, name: true, email: true, role: true, atsRole: true }, orderBy: { name: 'asc' }, take: 25,
  }).catch(() => []);
  return S.okBody({ people: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.atsRole || u.role })) });
}

// ---- bulk change of leads ---------------------------------------------------------------------------------------
async function bulkLeads(user, { ids, ownerId, status, rating } = {}) {
  const r = S.roleOf(user);
  if (!S.mayEdit(r)) return S.fail(403, 'Your role can read the CRM but not change it.');
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').slice(0, 60)).filter(Boolean))].slice(0, 1000);
  if (!list.length) return S.fail(400, 'Tick the leads first.');
  const data = {};
  if (ownerId) {
    if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin can give leads to another salesperson.');
    const o = (await S.ownerOptions()).find((x) => x.id === ownerId);
    if (!o) return S.fail(400, 'Pick the salesperson from the list.');
    data.ownerId = o.id; data.ownerName = o.name;
  }
  if (status) {
    if (!['New', 'Contacted', 'Qualified', 'Junk'].includes(status)) return S.fail(400, 'Pick a status (a lead becomes Converted only with "Convert").');
    data.status = status;
  }
  if (rating) {
    if (!S.RATINGS.includes(rating)) return S.fail(400, 'Rating is Hot, Warm or Cold.');
    data.rating = rating;
  }
  if (!Object.keys(data).length) return S.fail(400, 'Choose what to change.');
  data.updatedAt = DB.nowIso();
  let changed = 0; const skipped = [];
  for (const id of list) {
    const row = await S.getRow('lead', id); // eslint-disable-line no-await-in-loop
    if (!S.canEditRow(user, r, row)) { skipped.push({ id, reason: 'not yours' }); continue; } // eslint-disable-line no-continue
    if (row.status === 'Converted' && data.status) { skipped.push({ id, name: row.company, reason: 'already converted' }); continue; } // eslint-disable-line no-continue
    await S.update('CrmLead', row.id, data); // eslint-disable-line no-await-in-loop
    changed += 1;
  }
  await S.audit(user, 'CRM leads changed together', 'CrmLead', `${changed} leads`, [data.ownerName && `owner ${data.ownerName}`, data.status && `status ${data.status}`, data.rating && `rating ${data.rating}`].filter(Boolean).join(', '));
  return S.okBody({ ok: true, changed, skipped });
}

// ---- import leads from Excel / CSV ------------------------------------------------------------------------------
const HEAD = {
  company: ['company', 'companyname', 'organisation', 'organization', 'client', 'clientname', 'account', 'accountname', 'firm', 'business'],
  contactName: ['contact', 'contactname', 'contactperson', 'name', 'person', 'hrname', 'fullname'],
  designation: ['designation', 'title', 'jobtitle', 'role', 'position'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'mobileno', 'phoneno', 'contactnumber', 'contactno', 'number', 'whatsapp'],
  email: ['email', 'emailid', 'mail', 'emailaddress', 'mailid'],
  industry: ['industry', 'sector', 'domain', 'vertical'],
  city: ['city', 'location', 'place', 'town'],
  source: ['source', 'leadsource'],
  rating: ['rating', 'priority', 'temperature', 'hotwarmcold'],
  notes: ['notes', 'note', 'remarks', 'comments', 'comment', 'description'],
};
const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');

async function importLeads(user, buf, { fileName, ownerId, dryRun, source } = {}) {
  const r = S.roleOf(user);
  if (!S.mayEdit(r) || !S.can(user, 'import')) return S.fail(403, 'Your CRM rights do not allow importing. Ask a Sales manager.');
  if (!buf || !buf.length) return S.fail(400, 'Choose an Excel or CSV file.');
  let rows;
  try {
    const XLSX = require('xlsx'); // eslint-disable-line global-require
    const wb = XLSX.read(buf, { type: 'buffer', raw: false, codepage: 65001 });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  } catch (e) { return S.fail(400, 'This file could not be read. Save it as .xlsx or .csv and try again.'); }
  if (!rows.length) return S.fail(400, 'The first sheet has no rows under the headings.');
  if (rows.length > 2000) return S.fail(400, `The file has ${rows.length} rows; import at most 2000 at a time.`);
  // which column is which
  const heads = Object.keys(rows[0]);
  const col = {};
  Object.entries(HEAD).forEach(([field, names]) => { const h = heads.find((x) => names.includes(normHead(x))); if (h) col[field] = h; });
  if (!col.company) return S.fail(400, `No "Company" column found. The headings read: ${heads.slice(0, 12).join(', ')}.`);
  let own = { id: user.id, name: user.name || null };
  if (ownerId && ownerId !== user.id) {
    if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin can import leads for another salesperson.');
    const o = (await S.ownerOptions()).find((x) => x.id === ownerId);
    if (!o) return S.fail(400, 'Pick the salesperson from the list.');
    own = { id: o.id, name: o.name };
  }
  const st = await SETTINGS.load();
  // everything already in TeamLink, read once
  const seen = { co: new Map(), ph: new Map(), em: new Map() };
  const remember = (name, phone, email, label) => {
    const c = S.normCo(name); const p = S.phone10(phone); const e = String(email || '').trim().toLowerCase();
    if (c && c.length >= 3 && !seen.co.has(c)) seen.co.set(c, label);
    if (p.length === 10 && !seen.ph.has(p)) seen.ph.set(p, label);
    if (e && !seen.em.has(e)) seen.em.set(e, label);
  };
  (await DB.all('SELECT "company", "phone", "email", "ownerName" FROM "CrmLead" WHERE "status" != \'Junk\'')).forEach((l) => remember(l.company, l.phone, l.email, `lead ${l.company}${l.ownerName ? ` (${l.ownerName})` : ''}`));
  (await DB.all('SELECT "name", "phone", "email", "ownerName" FROM "CrmAccount"')).forEach((a) => remember(a.name, a.phone, a.email, `account ${a.name}${a.ownerName ? ` (${a.ownerName})` : ''}`));
  (await DB.all('SELECT "name", "phone", "email", "ownerName" FROM "CrmContact"')).forEach((c) => remember('', c.phone, c.email, `contact ${c.name}`));
  const dupOf = (x) => {
    const c = S.normCo(x.company); const p = S.phone10(x.phone); const e = String(x.email || '').trim().toLowerCase();
    return (c && c.length >= 3 && seen.co.get(c)) || (p.length === 10 && seen.ph.get(p)) || (e && seen.em.get(e)) || null;
  };
  const ready = []; const skipped = [];
  rows.forEach((raw, i) => {
    const body = {};
    Object.entries(col).forEach(([f, h]) => { body[f] = String(raw[h] == null ? '' : raw[h]).trim(); });
    if (!body.company) { if (Object.values(body).some(Boolean)) skipped.push({ row: i + 2, company: '', reason: 'No company name' }); return; }
    if (body.rating) { const rt = S.RATINGS.find((x) => x.toLowerCase() === body.rating.toLowerCase()); body.rating = rt || ''; }
    body.source = st.sources.find((x) => x.toLowerCase() === String(body.source || source || '').toLowerCase()) || (body.source || source ? 'Other' : '');
    if (body.phone) body.phone = body.phone.replace(/\.0$/, ''); // a number cell read as 9876543210.0
    const c = S.cleanFields('lead', body, { partial: false });
    if (c.error) { skipped.push({ row: i + 2, company: body.company, reason: c.error }); return; }
    const d = dupOf(c.data);
    if (d) { skipped.push({ row: i + 2, company: body.company, reason: `Already in TeamLink: ${d}` }); return; }
    remember(c.data.company, c.data.phone, c.data.email, `row ${i + 2} of this file`);
    ready.push(c.data);
  });
  if (dryRun) return S.okBody({ ok: true, dryRun: true, rows: rows.length, ready: ready.length, skipped, columns: col, sample: ready.slice(0, 5), owner: own.name });
  const now = DB.nowIso();
  for (const x of ready) {
    // eslint-disable-next-line no-await-in-loop
    await S.insert('CrmLead', { id: S.newId('lead'), ...x, status: 'New', ownerId: own.id, ownerName: own.name, createdById: user.id, createdAt: now, updatedAt: now });
  }
  await S.audit(user, 'CRM leads imported', 'CrmLead', String(fileName || 'file').slice(0, 80), `${ready.length} added, ${skipped.length} skipped, owner ${own.name}`);
  return S.okBody({ ok: true, created: ready.length, skipped, owner: own.name });
}

// ---- export (CSV) -------------------------------------------------------------------------------------------------
const EXPORTS = {
  leads: { sql: 'SELECT * FROM "CrmLead"', cols: [['company', 'Company'], ['contactName', 'Contact'], ['designation', 'Designation'], ['phone', 'Phone'], ['email', 'Email'], ['industry', 'Industry'], ['city', 'City'], ['source', 'Source'], ['rating', 'Rating'], ['status', 'Status'], ['ownerName', 'Owner'], ['createdAt', 'Added'], ['notes', 'Notes']] },
  deals: { sql: 'SELECT x.*, a."name" AS "accountName" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId"', alias: 'x.', cols: [['title', 'Deal'], ['accountName', 'Account'], ['stage', 'Stage'], ['value', 'Value (₹)'], ['probability', 'Probability %'], ['expectedClose', 'Expected close'], ['nextStep', 'Next step'], ['lostReason', 'Lost reason'], ['wonAt', 'Won on'], ['ownerName', 'Owner'], ['createdAt', 'Added']] },
  accounts: { sql: 'SELECT * FROM "CrmAccount"', cols: [['name', 'Company'], ['kind', 'Type'], ['industry', 'Industry'], ['city', 'City'], ['website', 'Website'], ['phone', 'Phone'], ['email', 'Email'], ['source', 'Source'], ['ownerName', 'Owner'], ['createdAt', 'Added']] },
  contacts: { sql: 'SELECT x.*, a."name" AS "accountName" FROM "CrmContact" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId"', alias: 'x.', cols: [['name', 'Name'], ['designation', 'Designation'], ['role', 'Role'], ['accountName', 'Company'], ['phone', 'Phone'], ['email', 'Email'], ['ownerName', 'Owner']] },
  activities: { sql: 'SELECT x.*, COALESCE(d."title", l."company", a."name") AS "record" FROM "CrmActivity" x LEFT JOIN "CrmDeal" d ON d."id" = x."dealId" LEFT JOIN "CrmLead" l ON l."id" = x."leadId" LEFT JOIN "CrmAccount" a ON a."id" = x."accountId"', alias: 'x.', ownerCol: 'byId', cols: [['at', 'When'], ['kind', 'Type'], ['subject', 'Subject'], ['note', 'What happened'], ['record', 'Lead / deal / account'], ['byName', 'By']] },
  tasks: { sql: 'SELECT x.*, COALESCE(d."title", l."company", a."name") AS "record" FROM "CrmTask" x LEFT JOIN "CrmDeal" d ON d."id" = x."dealId" LEFT JOIN "CrmLead" l ON l."id" = x."leadId" LEFT JOIN "CrmAccount" a ON a."id" = x."accountId"', alias: 'x.', cols: [['title', 'Follow-up'], ['dueDate', 'Due'], ['dueTime', 'Time'], ['status', 'Status'], ['record', 'Lead / deal / account'], ['ownerName', 'Owner'], ['doneAt', 'Done on']] },
};
async function exportCsv(user, kind) {
  const r = S.roleOf(user);
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  const e = EXPORTS[kind];
  if (!e) return S.fail(404, 'Nothing to download here.');
  const own = S.seesAll(r) ? '' : ` WHERE ${e.alias || ''}"${e.ownerCol || 'ownerId'}" = ?`;
  const rows = await DB.all(`${e.sql}${own} LIMIT 20000`, ...(own ? [user.id] : []));
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = `﻿${[e.cols.map((c) => esc(c[1])).join(','), ...rows.map((x) => e.cols.map((c) => esc(x[c[0]])).join(','))].join('\r\n')}`;
  await S.audit(user, 'CRM data downloaded', 'Crm', kind, `${rows.length} rows`);
  return { status: 200, csv, name: `crm-${kind}-${S.istToday()}.csv`, rows: rows.length };
}

// ---- proposals --------------------------------------------------------------------------------------------------------
async function proposalDefaults(user, dealId) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canSeeRow(user, r, deal)) return S.fail(404, 'This deal is not there, or it is not yours.');
  const acc = deal.accountId ? await S.getRow('account', deal.accountId) : null;
  const ct = deal.contactId ? await S.getRow('contact', deal.contactId) : (deal.accountId ? await DB.one('SELECT * FROM "CrmContact" WHERE "accountId" = ? ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 WHEN \'HR\' THEN 1 ELSE 2 END LIMIT 1', deal.accountId) : null);
  let ag = {};
  // the CRM's own defaults (it reads nothing from the agreements of ATS any more - founder 2026-11-11: the CRM stands alone)
  const st = await SETTINGS.load();
  const u = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true, email: true, employee: { select: { phone: true } } } }).catch(() => null);
  const me = u ? { name: u.name, email: u.email, phone: u.employee ? u.employee.phone : '' } : null;
  const proposals = await DB.all('SELECT "id", "number", "status", "sentAt", "sentTo", "createdAt", "createdByName" FROM "CrmProposal" WHERE "dealId" = ? ORDER BY "createdAt" DESC', deal.id);
  return S.okBody({
    proposals,
    canEdit: S.canEditRow(user, r, deal),
    defaults: {
      roles: [{ title: '', openings: deal.openings || '', ctc: deal.avgCtc || '' }],
      feePercent: deal.feePercent || ag.feePercent || 8.33, paymentDays: ag.paymentDays ?? 30, guaranteeDays: ag.guaranteeDays ?? 90,
      validityDays: st.proposalValidityDays, gstPercent: 18,
      toName: ct ? ct.name : '', toEmail: (ct && ct.email) || (acc && acc.email) || '', company: acc ? acc.name : '',
      fromName: (me && me.name) || user.name || '', fromEmail: (me && me.email) || '', fromPhone: (me && me.phone) || '',
      notes: '',
    },
  });
}

function cleanProposal(body) {
  const roles = (Array.isArray(body.roles) ? body.roles : []).slice(0, 20).map((x) => ({ title: S.clip(x && x.title, 120), openings: Math.round(S.num(x && x.openings) || 0) || null, ctc: S.num(x && x.ctc) }))
    .filter((x) => x.title);
  if (!roles.length) return { error: 'Add at least one position (job title).' };
  const fee = S.num(body.feePercent);
  if (fee == null || fee <= 0 || fee > 100) return { error: 'The fee is a percent of the annual CTC (more than 0, at most 100).' };
  const toEmail = S.clip(body.toEmail, 200);
  if (toEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) return { error: 'The client\'s email does not look right.' };
  const int = (v, d, max) => { const n = Math.round(S.num(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : d; };
  return {
    data: {
      roles, feePercent: fee, gstPercent: int(body.gstPercent, 18, 50), paymentDays: int(body.paymentDays, 30, 365), guaranteeDays: int(body.guaranteeDays, 90, 730), validityDays: int(body.validityDays, 30, 365),
      company: S.clip(body.company, 200), toName: S.clip(body.toName, 120), toEmail, fromName: S.clip(body.fromName, 120), fromEmail: S.clip(body.fromEmail, 200), fromPhone: S.clip(body.fromPhone, 40), notes: S.clip(body.notes, 3000),
    },
  };
}

async function createProposal(user, dealId, body = {}) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!S.canEditRow(user, r, deal)) return S.fail(404, 'This deal is not there, or it is not yours.');
  const c = cleanProposal(body);
  if (c.error) return S.fail(400, c.error);
  const ym = S.istToday().slice(2, 7).replace('-', '');
  const n = (await DB.one('SELECT COUNT(*) AS "n" FROM "CrmProposal" WHERE "number" LIKE ?', `TLP-${ym}-%`)).n + 1;
  const now = DB.nowIso();
  const p = await S.insert('CrmProposal', { id: S.newId('prop'), number: `TLP-${ym}-${String(n).padStart(3, '0')}`, dealId: deal.id, accountId: deal.accountId, dataJson: JSON.stringify(c.data), status: 'Draft', createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now });
  await S.audit(user, 'CRM proposal made', 'CrmProposal', p.id, `${p.number} for ${deal.title}`);
  return S.okBody({ ok: true, proposal: p });
}

async function proposalOf(user, id, { edit } = {}) {
  const r = S.roleOf(user);
  const p = await DB.one('SELECT * FROM "CrmProposal" WHERE "id" = ?', String(id || '').slice(0, 60));
  const deal = p ? await S.getRow('deal', p.dealId) : null;
  if (!p || !(edit ? S.canEditRow(user, r, deal) : S.canSeeRow(user, r, deal))) return { error: S.fail(404, 'This proposal is not there, or it is not yours.') };
  return { p, deal, data: JSON.parse(p.dataJson || '{}') };
}

// The proposal as a PDF (pdfkit, A4): the TeamLink logo, who it is for, the positions, the fee and terms, the signature line.
async function proposalPdf(user, id) {
  const x = await proposalOf(user, id);
  if (x.error) return x.error;
  const { p, data: d } = x;
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { LOGO } = require('../utils/agreementPdf'); // eslint-disable-line global-require
  const fs = require('fs'); // eslint-disable-line global-require
  const inr = (v) => `Rs. ${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
  const date = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const validTill = new Date(Date.parse(p.createdAt) + d.validityDays * 86400000).toISOString();
  const buf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Proposal ${p.number}`, Author: 'TeamLink Consultants' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 100; const NAVY = '#1b2a4a'; const MUTED = '#5b6474';
    if (fs.existsSync(LOGO)) { try { doc.image(LOGO, 50, 40, { height: 28 }); } catch { /* optional */ } }
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Proposal ${p.number}`, 50, 44, { width: W, align: 'right' }).text(date(p.createdAt), { width: W, align: 'right' });
    doc.moveDown(2.2);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text('Recruitment Services Proposal', 50);
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222');
    doc.text(`To: ${[d.toName, d.company].filter(Boolean).join(', ') || d.company || '-'}`);
    doc.text(`From: ${d.fromName || 'TeamLink Consultants'}, TeamLink Consultants`);
    doc.moveDown(0.8);
    doc.text(`Thank you for the opportunity to support ${d.company ? `${d.company}'s` : 'your'} hiring. TeamLink Consultants will source, screen and present suitable candidates for the positions below, and coordinate interviews until the candidates join.`, { width: W });
    doc.moveDown(1);
    // positions
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Positions');
    doc.moveDown(0.3);
    const cols = [50, 330, 410];
    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('Position', cols[0], y).text('Openings', cols[1], y).text('Annual CTC (approx.)', cols[2], y);
    y += 16; doc.moveTo(50, y - 3).lineTo(50 + W, y - 3).strokeColor('#d9dee8').stroke();
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    d.roles.forEach((rl) => {
      doc.text(rl.title, cols[0], y, { width: 270 }).text(rl.openings ? String(rl.openings) : '-', cols[1], y).text(rl.ctc ? inr(rl.ctc) : 'As discussed', cols[2], y);
      y = Math.max(doc.y, y + 14) + 4;
    });
    doc.y = y + 6; doc.x = 50;
    // commercials
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Commercial terms', 50);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222');
    const terms = [
      `Service fee: ${d.feePercent}% of the candidate's annual CTC (fixed salary), per candidate who joins.`,
      `GST at ${d.gstPercent}% is extra, as applicable.`,
      'The invoice is raised on the date the candidate joins.',
      `Payment within ${d.paymentDays} days of the invoice.`,
      `Replacement guarantee: if a candidate leaves within ${d.guaranteeDays} days of joining, we provide a replacement at no extra fee.`,
      'No fee is charged until a candidate joins.',
    ];
    terms.forEach((t) => { doc.text(`•  ${t}`, 60, doc.y, { width: W - 10 }); doc.moveDown(0.25); });
    // example on the first position with a CTC
    const ex = d.roles.find((rl) => rl.ctc);
    if (ex) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(MUTED).text(`Example: for a ${ex.title} at ${inr(ex.ctc)} a year, the fee is ${inr(ex.ctc * d.feePercent / 100)} + GST per candidate who joins.`, 50, doc.y, { width: W });
    }
    if (d.notes) {
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Notes', 50);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(d.notes, { width: W });
    }
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(`This proposal is valid until ${date(validTill)}. On your acceptance we will share the service agreement for signature.`, 50, doc.y, { width: W });
    doc.moveDown(1.6);
    doc.text('For TeamLink Consultants', 50);
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text(d.fromName || '');
    doc.font('Helvetica').fillColor(MUTED).text([d.fromEmail, d.fromPhone].filter(Boolean).join('  ·  '));
    doc.end();
  });
  return { status: 200, pdf: buf, name: `${p.number}.pdf` };
}

// The CRM's own invoice as a PDF (A4): from / bill-to, the amount, tax, total, due date, bank and terms. Self-contained (founder 2026-11-13).
async function invoicePdf(user, id) {
  const r = S.roleOf(user);
  const inv = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!inv || !S.canSeeRow(user, r, inv)) return S.fail(404, 'This invoice is not there.');
  let from = {}; let to = {};
  try { from = JSON.parse(inv.fromJson || '{}'); } catch { from = {}; }
  try { to = JSON.parse(inv.billToJson || '{}'); } catch { to = {}; }
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { LOGO } = require('../utils/agreementPdf'); // eslint-disable-line global-require
  const fs = require('fs'); // eslint-disable-line global-require
  const money = (v) => `Rs. ${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '-');
  const buf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.code || inv.id}`, Author: from.name || 'TeamLink Consultants' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 100; const NAVY = '#1b2a4a'; const MUTED = '#5b6474';
    if (fs.existsSync(LOGO)) { try { doc.image(LOGO, 50, 40, { height: 28 }); } catch { /* optional */ } }
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text('INVOICE', 50, 40, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(inv.code || '', { width: W, align: 'right' }).text(`Date: ${date(inv.issueDate)}`, { width: W, align: 'right' }).text(`Due: ${date(inv.dueDate)}`, { width: W, align: 'right' });
    doc.moveDown(2);
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('FROM', 50, top).text('BILL TO', 310, top);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(from.name || 'TeamLink Consultants', 50, top + 14, { width: 240 }).text(to.name || inv.accountName || '-', 310, top + 14, { width: 235 });
    doc.font('Helvetica').fontSize(9.5).fillColor('#333');
    const lines = (o) => [o.address, [o.state, o.pincode].filter(Boolean).join(' '), o.gstin ? `GSTIN: ${o.gstin}` : '', o.email, o.phone].filter(Boolean).join('\n');
    const fromY = doc.y; doc.text(lines(from), 50, fromY, { width: 240 }); const leftEnd = doc.y;
    doc.text(lines(to), 310, fromY, { width: 235 });
    doc.y = Math.max(leftEnd, doc.y) + 20; doc.x = 50;
    // item table
    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('Description', 50, y).text('Amount', 50 + W - 100, y, { width: 100, align: 'right' });
    y += 16; doc.moveTo(50, y - 3).lineTo(50 + W, y - 3).strokeColor('#d9dee8').stroke();
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(inv.title || 'Services', 50, y, { width: W - 120 });
    doc.text(money(inv.amount), 50 + W - 100, y, { width: 100, align: 'right' });
    y = Math.max(doc.y, y + 16) + 6;
    if (inv.discountPercent) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(`After a ${inv.discountPercent}% discount`, 50, y - 2); y = doc.y + 6; }
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#d9dee8').stroke(); y += 8;
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text('Subtotal', 50 + W - 220, y, { width: 110 }).text(money(inv.amount), 50 + W - 100, y, { width: 100, align: 'right' });
    y += 16; doc.text(`Tax (${inv.taxPercent || 0}%)`, 50 + W - 220, y, { width: 110 }).text(money(inv.taxAmount), 50 + W - 100, y, { width: 100, align: 'right' });
    y += 20; doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Total', 50 + W - 220, y, { width: 110 }).text(money(inv.total), 50 + W - 100, y, { width: 100, align: 'right' });
    if (inv.paidAmount > 0) {
      y += 20; doc.font('Helvetica').fontSize(10).fillColor('#222').text('Received', 50 + W - 220, y, { width: 110 }).text(money(inv.paidAmount), 50 + W - 100, y, { width: 100, align: 'right' });
      y += 15; doc.font('Helvetica-Bold').text('Balance', 50 + W - 220, y, { width: 110 }).text(money(Math.max(0, inv.total - inv.paidAmount)), 50 + W - 100, y, { width: 100, align: 'right' });
    }
    doc.y = y + 34; doc.x = 50;
    if (from.bank) { doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Bank details', 50); doc.moveDown(0.2); doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(from.bank, 50, doc.y, { width: W }); doc.moveDown(0.8); }
    if (from.terms) { doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Terms', 50); doc.moveDown(0.2); doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(from.terms, 50, doc.y, { width: W }); }
    doc.end();
  });
  return { status: 200, pdf: buf, name: `${inv.code || 'invoice'}.pdf` };
}

async function sendProposal(user, id, { to, message } = {}) {
  const x = await proposalOf(user, id, { edit: true });
  if (x.error) return x.error;
  const { p, deal, data: d } = x;
  const email = S.clip(to || d.toEmail, 200);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return S.fail(400, 'Write the client\'s email address.');
  const out = await proposalPdf(user, id);
  if (!out.pdf) return out;
  const text = `${S.clip(message, 3000) || `Dear ${d.toName || 'Sir / Madam'},\n\nPlease find attached our proposal (${p.number}) for your hiring requirement. We would be glad to discuss it at your convenience.`}\n\nRegards,\n${d.fromName || ''}\nTeamLink Consultants${d.fromPhone ? `\n${d.fromPhone}` : ''}`;
  const sent = await require('../utils/mailer').sendMail({ to: email, subject: `Proposal ${p.number}: recruitment services for ${d.company || 'your hiring'}`, text, attachments: [{ filename: out.name, content: out.pdf, contentType: 'application/pdf' }] }); // eslint-disable-line global-require
  if (!sent || !sent.ok) return S.fail(502, `The email was not sent: ${(sent && sent.error) || 'unknown problem'}. You can download the PDF and send it yourself.`);
  const now = DB.nowIso();
  await S.update('CrmProposal', p.id, { status: 'Sent', sentAt: now, sentTo: email, updatedAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'email', subject: `Proposal ${p.number} sent`, note: `To ${email}`, at: now, dealId: deal.id, accountId: deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  // the deal moves on to "Proposal sent" when it was earlier on the pipeline
  const order = SETTINGS.STAGES;
  if (order.indexOf(deal.stage) < order.indexOf('Proposal sent')) await S.moveDeal(user, deal.id, { stage: 'Proposal sent' });
  await S.audit(user, 'CRM proposal emailed', 'CrmProposal', p.id, `${p.number} to ${email}`);
  return S.okBody({ ok: true, sentTo: email });
}

async function decideProposal(user, id, { status } = {}) {
  if (!['Accepted', 'Declined', 'Sent', 'Draft'].includes(status)) return S.fail(400, 'Pick Accepted or Declined.');
  const x = await proposalOf(user, id, { edit: true });
  if (x.error) return x.error;
  const now = DB.nowIso();
  await S.update('CrmProposal', x.p.id, { status, decidedAt: ['Accepted', 'Declined'].includes(status) ? now : null, updatedAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Proposal ${x.p.number}: ${status}`, at: now, dealId: x.deal.id, accountId: x.deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  if (status === 'Accepted' && SETTINGS.STAGES.indexOf(x.deal.stage) < SETTINGS.STAGES.indexOf('Negotiation')) await S.moveDeal(user, x.deal.id, { stage: 'Negotiation' });
  return S.okBody({ ok: true });
}

// ---- the dashboard at a glance (founder 2026-11-02, the reference design: KPI cards, the sales funnel, activities today,
// recent deals, the lead-to-customer flow). period: month | last_month | quarter | year (India time), compared with the
// period before it for the arrows on the cards.
function periodRange(period) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear(); const m = ist.getUTCMonth();
  const off = 5.5 * 3600 * 1000;
  const at = (yy, mm) => new Date(Date.UTC(yy, mm, 1) - off).toISOString();
  if (period === 'last_month') return { from: at(y, m - 1), to: at(y, m), prevFrom: at(y, m - 2), prevTo: at(y, m - 1), label: 'Last month', months: [addMonths(monthNow(), -1)] };
  if (period === 'quarter') { const q = Math.floor(m / 3) * 3; return { from: at(y, q), to: at(y, q + 3), prevFrom: at(y, q - 3), prevTo: at(y, q), label: 'This quarter', months: [0, 1, 2].map((i) => new Date(Date.UTC(y, q + i, 1)).toISOString().slice(0, 7)) }; }
  if (period === 'year') return { from: at(y, 0), to: at(y + 1, 0), prevFrom: at(y - 1, 0), prevTo: at(y, 0), label: 'This year', months: Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`) };
  return { from: at(y, m), to: at(y, m + 1), prevFrom: at(y, m - 1), prevTo: at(y, m), label: 'This month', months: [monthNow()] };
}
const delta = (now, before) => (before ? Math.round(((now - before) / before) * 100) : (now ? null : 0));

async function overview(user, { period, mine } = {}) {
  const r = S.roleOf(user);
  const all = S.seesAll(r) && !mine;
  const own = all ? '1=1' : '"ownerId" = ?';
  const p = all ? [] : [user.id];
  const R = periodRange(period);
  const today = S.istToday();
  const count = async (sql, ...args) => ((await DB.one(sql, ...args)) || {}).n || 0;

  // the cards
  const leadsNow = await count(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "createdAt" >= ? AND "createdAt" < ?`, ...p, R.from, R.to);
  const leadsBefore = await count(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "createdAt" >= ? AND "createdAt" < ?`, ...p, R.prevFrom, R.prevTo);
  const openLeads = await count(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "status" NOT IN ('Converted', 'Junk')`, ...p);
  const customers = await count(`SELECT COUNT(*) AS "n" FROM "CrmAccount" WHERE ${own} AND "kind" = 'Client'`, ...p);
  const wonNow = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...p, R.from, R.to);
  const wonBefore = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...p, R.prevFrom, R.prevTo);
  const marks = R.months.map(() => '?').join(', ');
  const target = ((await DB.one(`SELECT COALESCE(SUM("amount"), 0) AS "v" FROM "CrmTarget" WHERE "month" IN (${marks}) AND ${own}`, ...R.months, ...p)) || {}).v || 0;
  const dueToday = await count(`SELECT COUNT(*) AS "n" FROM "CrmTask" WHERE ${own} AND "status" = 'Open' AND "dueDate" = ?`, ...p, today);
  const late = await count(`SELECT COUNT(*) AS "n" FROM "CrmTask" WHERE ${own} AND "status" = 'Open' AND "dueDate" < ?`, ...p, today);
  const pipe = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v", COALESCE(SUM("value" * "probability" / 100.0), 0) AS "w" FROM "CrmDeal" WHERE ${own} AND "stage" NOT IN ('Won', 'Lost')`, ...p);
  const cards = {
    leads: { value: leadsNow, delta: delta(leadsNow, leadsBefore), open: openLeads },
    customers: { value: customers, newInPeriod: wonNow.n, delta: delta(wonNow.n, wonBefore.n) },
    revenue: { value: wonNow.v, delta: delta(wonNow.v, wonBefore.v), deals: wonNow.n },
    target: { value: target, achieved: wonNow.v, pct: target ? Math.round((wonNow.v / target) * 100) : null },
    followUps: { today: dueToday, late },
    pipeline: { open: pipe.n, value: pipe.v, weighted: Math.round(pipe.w) },
  };

  // the sales funnel of the leads added in the period
  const fl = await DB.all(`SELECT l."status", d."stage" FROM "CrmLead" l LEFT JOIN "CrmDeal" d ON d."id" = l."dealId" WHERE ${all ? '1=1' : 'l."ownerId" = ?'} AND l."createdAt" >= ? AND l."createdAt" < ?`, ...p, R.from, R.to);
  const atLeast = (st) => SETTINGS.STAGES.indexOf(st) >= SETTINGS.STAGES.indexOf('Proposal sent') && st !== 'Lost';
  const funnel = [
    { step: 'New leads', count: fl.length },
    { step: 'Contacted', count: fl.filter((l) => l.status !== 'New' && l.status !== 'Junk').length },
    { step: 'Qualified', count: fl.filter((l) => ['Qualified', 'Converted'].includes(l.status)).length },
    { step: 'Proposal', count: fl.filter((l) => l.stage && atLeast(l.stage)).length },
    { step: 'Won', count: fl.filter((l) => l.stage === 'Won').length },
  ];
  const conversion = fl.length ? Math.round((funnel[4].count / fl.length) * 1000) / 10 : null;

  // won value, the last 6 months (the small bars beside the funnel)
  const thisM = monthNow();
  const trend = [];
  for (let i = 5; i >= 0; i -= 1) {
    const ym = addMonths(thisM, -i); const [f, t] = monthRange(ym);
    // eslint-disable-next-line no-await-in-loop
    const w = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...p, f, t);
    trend.push({ month: ym, won: w.n, value: w.v });
  }

  // today: what was logged today and the follow-ups due today, in time order
  const [dayFrom] = [new Date(Date.parse(`${today}T00:00:00Z`) - 5.5 * 3600 * 1000).toISOString()];
  const dayTo = new Date(Date.parse(dayFrom) + 86400000).toISOString();
  const rec = (alias) => `COALESCE(d."title", l."company", a."name") AS "recordName", CASE WHEN ${alias}."dealId" IS NOT NULL THEN 'deal' WHEN ${alias}."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind", COALESCE(${alias}."dealId", ${alias}."leadId", ${alias}."accountId") AS "recordId"`;
  const joins = (alias) => `LEFT JOIN "CrmDeal" d ON d."id" = ${alias}."dealId" LEFT JOIN "CrmLead" l ON l."id" = ${alias}."leadId" LEFT JOIN "CrmAccount" a ON a."id" = ${alias}."accountId"`;
  const acts = await DB.all(`SELECT x."id", x."kind", x."subject", x."at", x."byName", ${rec('x')} FROM "CrmActivity" x ${joins('x')} WHERE ${all ? '1=1' : 'x."byId" = ?'} AND x."at" >= ? AND x."at" < ? AND COALESCE(x."subject", '') NOT LIKE 'Stage:%' ORDER BY x."at" DESC LIMIT 20`, ...p, dayFrom, dayTo);
  const tasks = await DB.all(`SELECT t."id", t."title", t."dueTime", t."status", t."ownerName", ${rec('t')} FROM "CrmTask" t ${joins('t')} WHERE ${all ? '1=1' : 't."ownerId" = ?'} AND t."dueDate" = ? ORDER BY COALESCE(t."dueTime", '99:99') LIMIT 20`, ...p, today);
  const istTime = (iso) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(11, 16);
  const todayList = [
    ...acts.map((x) => ({ type: 'activity', id: x.id, kind: x.kind, time: istTime(x.at), title: x.subject || x.kind, recordName: x.recordName, recordKind: x.recordKind, recordId: x.recordId, by: x.byName, done: true })),
    ...tasks.map((t) => ({ type: 'task', id: t.id, kind: 'task', time: t.dueTime || null, title: t.title, recordName: t.recordName, recordKind: t.recordKind, recordId: t.recordId, by: t.ownerName, done: t.status === 'Done' })),
  ].sort((x, y) => String(x.time || '99:99').localeCompare(String(y.time || '99:99')));

  // recent deals
  const recentDeals = await DB.all(`SELECT x."id", x."title", x."stage", x."value", x."ownerName", x."updatedAt", a."name" AS "accountName" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${all ? '1=1' : 'x."ownerId" = ?'} ORDER BY x."updatedAt" DESC LIMIT 6`, ...p);

  // the flow from a lead to a customer, as it stands now
  const flow = [
    { key: 'leads', label: 'Lead generation', sub: 'New / Contacted leads', count: await count(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "status" IN ('New', 'Contacted')`, ...p), to: '/crm/leads' },
    { key: 'qualified', label: 'Qualification', sub: 'Qualified leads', count: await count(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "status" = 'Qualified'`, ...p), to: '/crm/leads' },
    { key: 'convert', label: 'Convert', sub: `Converted (${R.label.toLowerCase()})`, count: await count(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE ${own} AND "convertedAt" >= ? AND "convertedAt" < ?`, ...p, R.from, R.to), to: '/crm/leads' },
    { key: 'pipeline', label: 'Sales pipeline', sub: 'Open deals', count: pipe.n, to: '/crm/deals' },
    { key: 'customer', label: 'Customer', sub: 'Won accounts', count: customers, to: '/crm/accounts' },
  ];

  return S.okBody({ period: period || 'month', periodLabel: R.label, scope: all ? 'all' : 'mine', today, cards, funnel, conversion, trend, todayList, recentDeals, flow });
}

// ---- every call, meeting, email, WhatsApp and note in one list (Dashboard > Activities) -----------------------------------
async function activities(user, { kind, from, to, owner, q } = {}) {
  const r = S.roleOf(user);
  const where = []; const params = [];
  if (!S.seesAll(r)) { where.push('x."byId" = ?'); params.push(user.id); } else if (owner) { where.push('x."byId" = ?'); params.push(S.clip(owner, 60)); }
  if (['call', 'meeting', 'email', 'whatsapp', 'note'].includes(kind)) { where.push('x."kind" = ?'); params.push(kind); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))) { where.push('x."at" >= ?'); params.push(new Date(Date.parse(`${from}T00:00:00Z`) - 5.5 * 3600 * 1000).toISOString()); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) { where.push('x."at" < ?'); params.push(new Date(Date.parse(`${to}T00:00:00Z`) + 86400000 - 5.5 * 3600 * 1000).toISOString()); }
  const text = S.clip(q, 80);
  if (text) { where.push('(x."subject" LIKE ? OR x."note" LIKE ? OR d."title" LIKE ? OR l."company" LIKE ? OR a."name" LIKE ?)'); params.push(...Array(5).fill(`%${text}%`)); }
  where.push('COALESCE(x."subject", \'\') NOT LIKE \'Stage:%\'');
  const rows = await DB.all(`SELECT x.*, COALESCE(d."title", l."company", a."name") AS "recordName",
      CASE WHEN x."dealId" IS NOT NULL THEN 'deal' WHEN x."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind",
      COALESCE(x."dealId", x."leadId", x."accountId") AS "recordId"
    FROM "CrmActivity" x LEFT JOIN "CrmDeal" d ON d."id" = x."dealId" LEFT JOIN "CrmLead" l ON l."id" = x."leadId" LEFT JOIN "CrmAccount" a ON a."id" = x."accountId"
    WHERE ${where.join(' AND ')} ORDER BY x."at" DESC LIMIT 500`, ...params);
  const byKind = rows.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {});
  return S.okBody({ rows, byKind });
}

module.exports = { overview, activities, people, reports, setTarget, saveSettings, bulkLeads, importLeads, exportCsv, proposalDefaults, createProposal, proposalPdf, invoicePdf, sendProposal, decideProposal, monthRange };

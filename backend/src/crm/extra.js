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
  const won = byKey(await DB.all(`SELECT "ownerId", COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ? GROUP BY "ownerId"`, ...p, from, to), 'ownerId');
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
  // the invoice pieces that would otherwise be quietly put back to their defaults are refused with the reason instead
  const b = body || {};
  const was = await SETTINGS.load();
  const changed = (k) => b.invoiceFrom && String(b.invoiceFrom[k] || '').trim().toUpperCase() !== String((was.invoiceFrom || {})[k] || '').trim().toUpperCase();
  const checkGst = !!b.invoiceFrom && (changed('gstin') || changed('state')); // unchanged GSTIN / state: kept as they are, never refused
  if (b.invoiceNumberFormat && !SETTINGS.validInvoiceFormat(String(b.invoiceNumberFormat).trim())) return S.fail(400, 'The invoice number format needs exactly one running number like {0000}, and may have {FY} (2026-27) or {FY2} (26-27). Example: INV/{FY}/{0000}.');
  if (b.invoiceSac != null && b.invoiceSac !== '' && !/^\d{4,8}$/.test(String(b.invoiceSac).trim())) return S.fail(400, 'The SAC code is 4 to 8 digits, like 998314.');
  const g = checkGst && b.invoiceFrom.gstin ? String(b.invoiceFrom.gstin).trim().toUpperCase() : '';
  if (g && !require('./money').validGstin(g)) return S.fail(400, 'Our GSTIN does not look right: 15 characters, starting with the 2-digit state code (like 36ABCDE1234F1Z5).'); // eslint-disable-line global-require
  const stName = checkGst && b.invoiceFrom.state ? String(b.invoiceFrom.state).trim() : '';
  if (stName && !require('./money').stateCodeOf(stName)) return S.fail(400, `"${stName.slice(0, 40)}" is not a state we know. Write the state name (like Telangana) or its GST code (36).`); // eslint-disable-line global-require
  if (g && stName && require('./money').stateCodeOf(stName) !== g.slice(0, 2)) return S.fail(400, `Our GSTIN starts with ${g.slice(0, 2)} (${require('./money').stateName(g.slice(0, 2))}) but the state says ${stName}. Make them agree.`); // eslint-disable-line global-require
  const st = await SETTINGS.save(b);
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
    if (status !== 'Junk') return S.fail(409, 'Stages move on their own. In bulk you can only mark leads Junk.');
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
    // Contacted / Qualified only for a lead that has something logged on it (a call, meeting, email, WhatsApp or note)
    if (['Contacted', 'Qualified'].includes(data.status) && data.status !== row.status && !(await S.hasLoggedWork(row.id))) { skipped.push({ id, name: row.company, reason: 'nothing logged on it yet' }); continue; } // eslint-disable-line no-continue, no-await-in-loop
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

async function importLeads(user, buf, { fileName, ownerId, dryRun, source, map } = {}) {
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
  // COLUMN MAPPING (founder 2026-11-14): the person can say which column is which when the file's own headings are not the usual ones.
  // map = { company: 'Org name', phone: 'Cell', email: '' } - a heading of this file, or '' for "this file has none".
  if (map && typeof map === 'object') {
    Object.keys(HEAD).forEach((field) => {
      if (!(field in map)) return;
      const h = String(map[field] == null ? '' : map[field]);
      if (!h) delete col[field]; else if (heads.includes(h)) col[field] = h;
    });
  }
  if (!col.company) return S.fail(400, `No "Company" column found. Pick which column is the company.`, { headings: heads, columns: col });
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
  if (dryRun) return S.okBody({ ok: true, dryRun: true, rows: rows.length, ready: ready.length, skipped, columns: col, headings: heads, sample: ready.slice(0, 5), owner: own.name });
  const now = DB.nowIso();
  for (const x of ready) {
    // eslint-disable-next-line no-await-in-loop
    await S.insert('CrmLead', { id: S.newId('lead'), ...x, status: 'New', ownerId: own.id, ownerName: own.name, createdById: user.id, createdAt: now, updatedAt: now });
  }
  await S.audit(user, 'CRM leads imported', 'CrmLead', String(fileName || 'file').slice(0, 80), `${ready.length} added, ${skipped.length} skipped (${skipped.filter((x) => /Already in TeamLink|of this file/.test(x.reason)).length} duplicates), owner ${own.name}`);
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
async function exportCsv(user, kind, q = {}) {
  const r = S.roleOf(user);
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  const e = EXPORTS[kind];
  if (!e) return S.fail(404, 'Nothing to download here.');
  const own = S.seesAll(r) ? '' : ` WHERE ${e.alias || ''}"${e.ownerCol || 'ownerId'}" = ?`;
  let rows = await DB.all(`${e.sql}${own} LIMIT 20000`, ...(own ? [user.id] : []));
  // the list's own filters: the download holds exactly the rows the screen shows (the same list function, the same scope)
  const KIND_OF = { leads: 'lead', deals: 'deal', accounts: 'account', contacts: 'contact' };
  if (KIND_OF[kind] && require('./listFilters').any(q)) { // eslint-disable-line global-require
    const ids = new Set((await S.list(user, KIND_OF[kind], { ...q, max: 20000 })).map((x) => x.id));
    rows = rows.filter((x) => ids.has(x.id));
  }
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const hidden = require('./collab').csvHidden(user, kind); // eslint-disable-line global-require
  const cols = e.cols.filter((c) => !hidden.has(c[0])); // a field hidden from this person's CRM role is not in the file either
  const csv = `﻿${[cols.map((c) => esc(c[1])).join(','), ...rows.map((x) => cols.map((c) => esc(x[c[0]])).join(','))].join('\r\n')}`;
  await S.audit(user, 'CRM data downloaded', 'Crm', kind, `${rows.length} rows`);
  await require('./analytics').logExport(user, `List: ${kind}`, 'csv', rows.length).catch(() => {}); // eslint-disable-line global-require
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
  // a product quotation template (crm/catalog.js) is made there; the recruitment proposal goes on here
  const quote = await require('./catalog').createQuote(user, deal, body); // eslint-disable-line global-require
  if (quote) return quote;
  const c = cleanProposal(body);
  if (c.error) return S.fail(400, c.error);
  const ym = S.istToday().slice(2, 7).replace('-', '');
  const n = (await DB.one('SELECT COUNT(*) AS "n" FROM "CrmProposal" WHERE "number" LIKE ?', `TLP-${ym}-%`)).n + 1;
  const now = DB.nowIso();
  let p = await S.insert('CrmProposal', { id: S.newId('prop'), number: `TLP-${ym}-${String(n).padStart(3, '0')}`, dealId: deal.id, accountId: deal.accountId, dataJson: JSON.stringify(c.data), status: 'Draft', createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now });
  p = (await require('./catalog').afterProposal(p, deal, body).catch(() => null)) || p; // eslint-disable-line global-require
  await S.audit(user, 'CRM proposal made', 'CrmProposal', p.id, `${p.number} for ${deal.title}`);
  return S.okBody({ ok: true, proposal: p });
}

async function proposalOf(user, id, { edit, signed } = {}) {
  const r = signed ? null : S.roleOf(user);
  const p = await DB.one('SELECT * FROM "CrmProposal" WHERE "id" = ?', String(id || '').slice(0, 60));
  const deal = p ? await S.getRow('deal', p.dealId) : null;
  // `signed` is only ever passed by the public proposal link AFTER the signed, unexpired token was checked (proposalOfToken)
  if (!p || !deal || !(signed || (edit ? S.canEditRow(user, r, deal) : S.canSeeRow(user, r, deal)))) return { error: S.fail(404, 'This proposal is not there, or it is not yours.') };
  return { p, deal, data: JSON.parse(p.dataJson || '{}') };
}

// The proposal as a PDF (pdfkit, A4): the TeamLink logo, who it is for, the positions, the fee and terms, the signature line.
async function proposalPdf(user, id, { signed } = {}) {
  const x = await proposalOf(user, id, { signed });
  if (x.error) return x.error;
  const alt = await require('./catalog').quotePdf(x); // eslint-disable-line global-require
  if (alt) return alt; // a product quotation template (crm/catalog.js)
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
// `signed` is only ever passed by the public link route AFTER it has checked the signed, unexpired token (shareInvoice below).
async function invoicePdf(user, id, { signed } = {}) {
  const r = S.roleOf(user);
  const raw = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!raw || (!signed && !S.canSeeRow(user, r, raw))) return S.fail(404, 'This invoice is not there.');
  await SETTINGS.load().catch(() => null); // the public link may be the first reader: our state / SAC on an old invoice come from the settings
  const inv = S.invoiceOut(raw);
  const { from, billTo: to, gst } = inv;
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { LOGO } = require('../utils/agreementPdf'); // eslint-disable-line global-require
  const fs = require('fs'); // eslint-disable-line global-require
  const money = (v) => `Rs. ${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '-');
  const qtyText = (q) => (Number.isInteger(Number(q)) ? String(q) : String(Number(q)));
  const buf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.code || inv.id}`, Author: from.name || 'TeamLink Consultants' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 100; const NAVY = '#1b2a4a'; const MUTED = '#5b6474';
    if (fs.existsSync(LOGO)) { try { doc.image(LOGO, 50, 40, { height: 28 }); } catch { /* optional */ } }
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(from.gstin ? 'TAX INVOICE' : 'INVOICE', 50, 40, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(inv.code || '', { width: W, align: 'right' }).text(`Date: ${date(inv.issueDate)}`, { width: W, align: 'right' }).text(`Due: ${date(inv.dueDate)}`, { width: W, align: 'right' });
    doc.moveDown(2);
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('FROM', 50, top).text('BILL TO', 310, top);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(from.name || 'TeamLink Consultants', 50, top + 14, { width: 240 }).text(to.name || inv.accountName || '-', 310, top + 14, { width: 235 });
    doc.font('Helvetica').fontSize(9.5).fillColor('#333');
    const stateLine = (o, st) => [st ? `State: ${st.name} (code ${st.code})` : o.state, o.pincode].filter(Boolean).join(' ');
    const party = (o, st) => [o.address, stateLine(o, st), o.gstin ? `GSTIN: ${o.gstin}` : 'GSTIN: not given', o.email, o.phone].filter(Boolean).join('\n');
    const fromY = doc.y; doc.text(party(from, gst.ourState), 50, fromY, { width: 240 }); const leftEnd = doc.y;
    doc.text(party(to, gst.customerState), 310, fromY, { width: 235 });
    doc.y = Math.max(leftEnd, doc.y) + 10; doc.x = 50;
    doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(`Place of supply: ${gst.placeOfSupply ? `${gst.placeOfSupply.name} (${gst.placeOfSupply.code})` : 'not known'}${gst.sac ? `   ·   SAC: ${gst.sac}` : ''}`, 50, doc.y, { width: W });
    if (gst.flag) doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#b45309').text(gst.flag, 50, doc.y + 2, { width: W });
    doc.y += 12;
    // item table: description, SAC, qty, rate, amount
    const C = { desc: 50, sac: 50 + W - 300, qty: 50 + W - 230, rate: 50 + W - 190, amt: 50 + W - 100 };
    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('Description', C.desc, y).text('SAC', C.sac, y).text('Qty', C.qty, y, { width: 35, align: 'right' }).text('Rate', C.rate, y, { width: 85, align: 'right' }).text('Amount', C.amt, y, { width: 100, align: 'right' });
    y += 16; doc.moveTo(50, y - 3).lineTo(50 + W, y - 3).strokeColor('#d9dee8').stroke();
    const room = (h) => { if (y + h > doc.page.height - 60) { doc.addPage(); y = 50; } };
    inv.lines.forEach((l) => {
      room(30);
      doc.font('Helvetica').fontSize(10).fillColor('#222').text(l.description || 'Services', C.desc, y, { width: C.sac - C.desc - 8 });
      const end = doc.y;
      doc.text(l.sac || '-', C.sac, y).text(qtyText(l.qty), C.qty, y, { width: 35, align: 'right' }).text(money(l.rate), C.rate, y, { width: 85, align: 'right' }).text(money(l.amount), C.amt, y, { width: 100, align: 'right' });
      y = Math.max(end, y + 14) + 5;
    });
    if (inv.discountPercent) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(`After a ${inv.discountPercent}% discount`, 50, y - 2); y = doc.y + 6; }
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#d9dee8').stroke(); y += 8;
    const sum = (label, v, { bold, size } = {}) => { room(22); doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size || 10.5).fillColor(bold ? NAVY : '#222').text(label, 50 + W - 260, y, { width: 150 }).text(money(v), 50 + W - 100, y, { width: 100, align: 'right' }); y += bold ? 20 : 16; };
    sum('Taxable value', inv.amount);
    const r2 = (n) => Math.round(n * 1000) / 1000;
    if (gst.mode === 'intra') { sum(`CGST @ ${r2(gst.halfRate)}%`, gst.cgst); sum(`SGST @ ${r2(gst.halfRate)}%`, gst.sgst); } else if (gst.mode === 'inter') sum(`IGST @ ${r2(gst.rate)}%`, gst.igst); else sum(`Tax (${inv.taxPercent || 0}%)`, inv.taxAmount);
    y += 4; sum('Total', inv.total, { bold: true, size: 12 });
    if (inv.paidAmount > 0 || inv.tdsAmount > 0) {
      if (inv.paidAmount > 0) sum('Received', inv.paidAmount);
      if (inv.tdsAmount > 0) sum('TDS deducted by you', inv.tdsAmount);
      sum('Balance', inv.balance, { bold: true, size: 10.5 });
    }
    if (inv.notes) { doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(inv.notes, 50, y + 10, { width: W }); y = doc.y; }
    doc.y = y + 24; doc.x = 50;
    if (from.bank) { doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Bank details', 50); doc.moveDown(0.2); doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(from.bank, 50, doc.y, { width: W }); doc.moveDown(0.8); }
    if (from.terms) { doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Terms', 50); doc.moveDown(0.2); doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(from.terms, 50, doc.y, { width: W }); }
    doc.end();
  });
  return { status: 200, pdf: buf, name: `${inv.code || 'invoice'}.pdf` };
}

// ---- the invoice on WhatsApp (founder 2026-11-14, build order: "WhatsApp click-to-chat easy, PDF link tho") --------------------------------------
// TeamLink sends NOTHING: this makes a signed link to the invoice PDF (valid 30 days, no login for the customer) and the message text with the
// customer's number, and the person presses Send in their own WhatsApp. The link is the invoice id signed with the server secret, so it cannot
// be made for another invoice; it only ever opens that one PDF.
const SHARE_DAYS = 30;
const shareSecret = () => String(process.env.JWT_SECRET || 'teamlink-crm');
const shareSig = (v) => require('crypto').createHmac('sha256', shareSecret()).update(`crm-invoice-link:${v}`).digest('base64url').slice(0, 24); // eslint-disable-line global-require
function shareToken(invoiceId, days = SHARE_DAYS) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const body = `${invoiceId}.${exp}`;
  return `${Buffer.from(body).toString('base64url')}.${shareSig(body)}`;
}
/** The invoice id a link opens, or null (wrong signature, tampered, expired). */
function invoiceOfToken(token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  let body = '';
  try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const a = Buffer.from(shareSig(body)); const c = Buffer.from(sig);
  if (a.length !== c.length || !require('crypto').timingSafeEqual(a, c)) return null; // eslint-disable-line global-require
  const [id, exp] = body.split('.');
  if (!id || !(Number(exp) > Math.floor(Date.now() / 1000))) return null;
  return id;
}
async function shareInvoice(user, id, req) {
  const r = S.roleOf(user);
  const inv = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!inv || !S.canSeeRow(user, r, inv)) return S.fail(404, 'This invoice is not there.');
  if (!S.canEditRow(user, r, inv)) return S.fail(403, 'You cannot send this invoice.');
  if (inv.status === 'Cancelled') return S.fail(400, 'This invoice is cancelled. It is not sent to the customer.');
  const W = require('../utils/waLink'); // eslint-disable-line global-require
  let billTo = {}; try { billTo = JSON.parse(inv.billToJson || '{}'); } catch { billTo = {}; }
  // the number: the customer's own, else the contact who decides on this account
  let number = W.cleanNumber(billTo.phone);
  let contactName = '';
  if (inv.accountId) {
    const ct = await DB.one('SELECT "name", "phone" FROM "CrmContact" WHERE "accountId" = ? ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 WHEN \'HR\' THEN 1 ELSE 2 END LIMIT 1', inv.accountId).catch(() => null);
    if (ct) { contactName = ct.name || ''; if (!number.valid) number = W.cleanNumber(ct.phone); }
  }
  const base = require('../utils/offerLink').publicBase(req); // eslint-disable-line global-require
  const url = `${base}/api/crm-public/invoice/${shareToken(inv.id)}`;
  let from = {}; try { from = JSON.parse(inv.fromJson || '{}'); } catch { from = {}; }
  const inr = (v) => `Rs. ${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const settled = inv.paidAmount + (Number(inv.tdsAmount) || 0); // TDS the customer deducted counts as settled
  const left = Math.max(0, inv.total - settled);
  const due = inv.dueDate ? new Date(`${inv.dueDate}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const text = [
    `Hello${contactName ? ` ${String(contactName).split(/\s+/)[0]}` : ''},`,
    `Invoice ${inv.code || ''} from ${from.name || 'TeamLink Consultants'}: ${inr(left > 0 && settled > 0 ? left : inv.total)}${settled > 0 && left > 0 ? ' balance' : ''}${due ? `, due ${due}` : ''}.`,
    `You can open the invoice (PDF) here: ${url}`,
    'Thank you.',
  ].join('\n');
  const waUrl = `https://wa.me/${number.valid ? number.digits : ''}?text=${encodeURIComponent(text)}`;
  const now = DB.nowIso();
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'whatsapp', subject: `Invoice ${inv.code || ''} sent on WhatsApp (link opened)`, note: number.valid ? `to ${number.digits}` : 'no number on the customer: the person picked the chat', at: now, dealId: inv.dealId, accountId: inv.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, 'CRM invoice shared on WhatsApp', 'CrmInvoice', inv.id, `${inv.code || inv.id}: link made for 30 days`);
  return S.okBody({ ok: true, url, waUrl, text, number: number.valid ? number.digits : null, contactName: contactName || billTo.name || '', status: inv.status, expiresInDays: SHARE_DAYS });
}

// ---- the customer ANSWERS the proposal from the email (founder 2026-11-16: "mail lo customer ok cheyyaganey, ikkada accepted kindha update avvali") -----------------
// The email carries a signed link (the proposal id signed with the server secret, 60 days, no login). It opens a page with Accept / Decline; only the button
// (a POST) changes anything, so a mail scanner opening the link changes nothing. The answer is written to the proposal, the deal's timeline (with the time and
// the address it came from) and the deal owner gets a bell; an accepted proposal moves the deal to Negotiation, as when a person marks it.
const PROPOSAL_DAYS = 60;
const propSig = (v) => require('crypto').createHmac('sha256', shareSecret()).update(`crm-proposal-link:${v}`).digest('base64url').slice(0, 24); // eslint-disable-line global-require
function proposalToken(proposalId, days = PROPOSAL_DAYS) {
  const body = `${proposalId}.${Math.floor(Date.now() / 1000) + days * 86400}`;
  return `${Buffer.from(body).toString('base64url')}.${propSig(body)}`;
}
/** The proposal id a link opens, or null (wrong signature, tampered, expired). */
function proposalOfToken(token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  let body = '';
  try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const a = Buffer.from(propSig(body)); const c = Buffer.from(sig);
  if (a.length !== c.length || !require('crypto').timingSafeEqual(a, c)) return null; // eslint-disable-line global-require
  const [id, exp] = body.split('.');
  if (!id || !(Number(exp) > Math.floor(Date.now() / 1000))) return null;
  return id;
}
/** What the public page shows: the proposal's number, who it is for, and where it stands. */
async function proposalForCustomer(id) {
  const x = await proposalOf(null, id, { signed: true });
  if (x.error) return null;
  return { id: x.p.id, number: x.p.number, status: x.p.status, decidedAt: x.p.decidedAt, company: x.data.company || x.deal.title || '', toName: x.data.toName || '', fromName: x.data.fromName || 'TeamLink Consultants' };
}
/** The customer pressed Accept or Decline. Answers { ok, status } or { error }. A proposal already answered is not changed by a second click. */
async function decideByCustomer(id, decision, { ip } = {}) {
  const status = decision === 'accept' ? 'Accepted' : decision === 'decline' ? 'Declined' : null;
  if (!status) return { error: 'Choose Accept or Decline.' };
  const x = await proposalOf(null, id, { signed: true });
  if (x.error) return { error: 'This proposal is not available.' };
  const { p, deal } = x;
  if (['Accepted', 'Declined'].includes(p.status)) return { ok: true, already: true, status: p.status };
  if (p.status !== 'Sent') return { error: 'This proposal has not been sent to you yet.' };
  const now = DB.nowIso();
  await S.update('CrmProposal', p.id, { status, decidedAt: now, updatedAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Proposal ${p.number}: ${status} by the customer`, note: `The customer pressed ${status === 'Accepted' ? 'Accept' : 'Decline'} in the email link${p.sentTo ? ` (sent to ${p.sentTo})` : ''}. Address ${String(ip || 'unknown').slice(0, 60)}.`, at: now, dealId: deal.id, accountId: deal.accountId, byId: null, byName: 'Customer (email link)', createdAt: now });
  if (status === 'Accepted' && SETTINGS.STAGES.indexOf(deal.stage) < SETTINGS.STAGES.indexOf('Negotiation')) await S.moveDeal({ id: deal.ownerId, name: 'Customer (email link)', role: 'SUPER_ADMIN' }, deal.id, { stage: 'Negotiation' }).catch(() => null);
  await S.audit({ id: null, name: 'Customer (email link)' }, `CRM proposal ${status.toLowerCase()} by the customer`, 'CrmProposal', p.id, `${p.number}`).catch(() => null);
  // A POP-UP on screen (founder 2026-11-16: "customer accept chesaru ani, display meedha pop up avvali"): the same note is the bell line AND the on-screen toast with an Open button
  // (components/crm/CrmReminderToast.jsx reads the 'crm-reply|' notes). It goes to the deal's owner and to the person who made the proposal.
  const who = [...new Set([deal.ownerId, p.createdById].filter(Boolean))];
  const why = status === 'Accepted' ? 'The customer pressed Accept in the email. Next: agree the final price and terms (Negotiation), then Won.' : 'The customer pressed Decline in the email. Ask what did not suit and note it on the deal.';
  await Promise.all(who.map((userId) => prisma.notification.create({ data: { userId, title: `${status === 'Accepted' ? '✅' : '❌'} ${deal.title || 'A customer'} ${status.toLowerCase()} proposal ${p.number}`, message: `${why}\nOpen: /crm/deals?open=deal:${deal.id}`, channel: 'In-App', recipient: `crm-reply|${deal.id}|${Date.now()}`, status: 'Sent' } }).catch(() => null)));
  return { ok: true, status };
}

// ---- the invoice by EMAIL (founder 2026-11-16: "ikkada mail option kuda vundali, only wtsp ey kaadhu") -----------------------------------------------------------
// Like WhatsApp, but the PDF itself goes as an attachment, from the person's own name through the company mailbox, through the app's one send door (credits, opt-out, ledger).
// emailInvoiceDraft = the box's starting words and the customer's address (the account's, else the deciding contact's), and whether mail is set up at all;
// emailInvoice = the send (To, CC, subject, words editable). A Draft becomes Sent once the mail went (2026-11-17); WhatsApp still asks "Mark as Sent?".
async function invoiceMailOf(user, id) {
  const r = S.roleOf(user);
  const inv = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!inv || !S.canSeeRow(user, r, inv)) return { error: S.fail(404, 'This invoice is not there.') };
  if (!S.canEditRow(user, r, inv)) return { error: S.fail(403, 'You cannot send this invoice.') };
  if (inv.status === 'Cancelled') return { error: S.fail(400, 'This invoice is cancelled. It is not sent to the customer.') };
  return { inv };
}
async function emailInvoiceDraft(user, id) {
  const x = await invoiceMailOf(user, id);
  if (x.error) return x.error;
  const { inv } = x;
  let billTo = {}; let from = {};
  try { billTo = JSON.parse(inv.billToJson || '{}'); } catch { billTo = {}; }
  try { from = JSON.parse(inv.fromJson || '{}'); } catch { from = {}; }
  let to = String(billTo.email || '').trim(); let contactName = '';
  if (inv.accountId) {
    const ct = await DB.one('SELECT "name", "email" FROM "CrmContact" WHERE "accountId" = ? ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 WHEN \'HR\' THEN 1 ELSE 2 END, CASE WHEN "email" IS NULL OR "email" = \'\' THEN 1 ELSE 0 END LIMIT 1', inv.accountId).catch(() => null);
    if (ct) { contactName = ct.name || ''; if (!to) to = String(ct.email || '').trim(); }
  }
  const inr = (v) => `Rs. ${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const settled = inv.paidAmount + (Number(inv.tdsAmount) || 0);
  const left = Math.max(0, inv.total - settled);
  const due = inv.dueDate ? new Date(`${inv.dueDate}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const text = [
    `Dear ${contactName ? String(contactName).split(/\s+/)[0] : (billTo.name || 'Sir / Madam')},`,
    '',
    `Please find attached invoice ${inv.code || ''} from ${from.name || 'TeamLink Consultants'} for ${inr(left > 0 && settled > 0 ? left : inv.total)}${settled > 0 && left > 0 ? ' (balance)' : ''}${due ? `, due on ${due}` : ''}.`,
    '',
    'Please let us know if you need anything else.',
  ].join('\n');
  const mail = await require('../utils/messaging').channelStatus().then((c) => c.Email).catch(() => null); // eslint-disable-line global-require
  return S.okBody({ ok: true, to, cc: '', subject: `Invoice ${inv.code || ''} from ${from.name || 'TeamLink Consultants'}`, text, status: inv.status, mailReady: !!(mail && mail.configured), mailReason: mail && !mail.configured ? mail.reason : null });
}
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
// { to, cc ("a@x.com, b@y.com", at most 5), subject, text } -> the mail with the invoice PDF attached; a Draft becomes Sent (it went to the customer).
async function emailInvoice(user, id, { to, cc, subject, text } = {}) {
  const x = await invoiceMailOf(user, id);
  if (x.error) return x.error;
  const { inv } = x;
  const addr = S.clip(to, 200);
  if (!addr || !EMAIL_RE.test(addr)) return S.fail(400, addr ? 'That email address does not look right.' : 'Write the customer\'s email address in the To box.');
  const ccList = [...new Set((Array.isArray(cc) ? cc : String(cc || '').split(/[,;\s]+/)).map((v) => String(v || '').trim()).filter(Boolean))].filter((v) => v.toLowerCase() !== addr.toLowerCase());
  if (ccList.length > 5) return S.fail(400, 'At most 5 addresses in CC.');
  const badCc = ccList.find((v) => !EMAIL_RE.test(v) || v.length > 200);
  if (badCc) return S.fail(400, `The CC address "${badCc.slice(0, 80)}" does not look right.`);
  const subj = S.clip(subject, 200);
  const body = S.clip(text, 4000);
  if (!subj) return S.fail(400, 'Write the subject.');
  if (!body) return S.fail(400, 'Write the message first.');
  const CMP = require('./campaigns'); // eslint-disable-line global-require
  if (await CMP.optedOut('email', addr).catch(() => false)) return S.fail(409, 'This address asked not to be emailed (unsubscribed). TeamLink does not send to it.');
  const out = await invoicePdf(user, id);
  if (!out.pdf) return out;
  const own = await require('../utils/messageChannels').ownContact(user); // eslint-disable-line global-require
  const result = await require('../utils/messaging').send('Email', { // eslint-disable-line global-require
    to: addr, cc: ccList, subject: subj, text: body, senderEmail: own.email || undefined, senderName: own.name || user.name, actorUserId: user.id,
    attachments: [{ filename: out.name, content: out.pdf, contentType: 'application/pdf' }],
    meta: { audience: 'crm', personName: inv.accountName || '', senderUserId: user.id, senderName: user.name, purpose: 'CRM invoice email' },
  });
  if (!result.ok) {
    if (result.notConfigured) return S.fail(409, `Email is not set up yet, so nothing was sent. Connect it in Administration > Integrations > Email (${result.error}). You can download the PDF and send it yourself.`, { notConfigured: true });
    return S.fail(result.invalid || result.creditsBlocked || result.reserved ? 400 : 502, `The email was not sent: ${result.error || 'unknown problem'}`);
  }
  const now = DB.nowIso();
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'email', subject: `Invoice ${inv.code || ''} emailed`, note: `To ${addr}${ccList.length ? `\nCC ${ccList.join(', ')}` : ''}\n\n${body}\n\n(the invoice PDF was attached)`, at: now, dealId: inv.dealId || null, accountId: inv.accountId || null, byId: user.id, byName: user.name || null, createdAt: now });
  // it went to the customer: a Draft is Sent now (and can no longer be edited)
  let status = inv.status;
  if (inv.status === 'Draft') { await S.update('CrmInvoice', inv.id, { status: 'Sent', sentAt: inv.sentAt || now, updatedAt: now }); status = 'Sent'; }
  await S.audit(user, 'CRM invoice emailed', 'CrmInvoice', inv.id, `${inv.code || inv.id} to ${addr}${ccList.length ? ` cc ${ccList.join(', ')}` : ''}${status !== inv.status ? ' (Draft -> Sent)' : ''}`);
  return S.okBody({ ok: true, to: addr, cc: ccList, status });
}

async function sendProposal(user, id, { to, message } = {}, req) {
  const x = await proposalOf(user, id, { edit: true });
  if (x.error) return x.error;
  const { p, deal, data: d } = x;
  const blocked = await require('./catalog').sendBlock(p); // eslint-disable-line global-require
  if (blocked) return blocked; // a quote waiting for (or refused) a manager's approval is not emailed
  const email = S.clip(to || d.toEmail, 200);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return S.fail(400, 'Write the client\'s email address.');
  const out = await proposalPdf(user, id);
  if (!out.pdf) return out;
  const answerUrl = `${require('../utils/offerLink').publicBase(req)}/api/crm-public/proposal/${proposalToken(p.id)}`; // eslint-disable-line global-require
  const text = `${S.clip(message, 3000) || `Dear ${d.toName || 'Sir / Madam'},\n\nPlease find attached our proposal (${p.number}) for your hiring requirement. We would be glad to discuss it at your convenience.`}\n\nTo accept or decline this proposal online, open: ${answerUrl}\n\nRegards,\n${d.fromName || ''}\nTeamLink Consultants${d.fromPhone ? `\n${d.fromPhone}` : ''}`;
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
  const wonNow = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...p, R.from, R.to);
  const wonBefore = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...p, R.prevFrom, R.prevTo);
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

  // MONEY: BOOKED, INVOICED, COLLECTED (founder 2026-11-14, build order 2 - the three are different things and must not be mixed):
  //   booked = the value of the deals WON in the period; invoiced = invoices that went out (Sent / Partly paid / Paid, not Draft or Cancelled) dated in the period, WITH tax;
  //   collected = money that actually CAME in the period (the payment log, by the date it came, whichever month the invoice is from);
  //   still to collect = what is owed right now on the invoices that went out, of which overdue = past the due date. Drafts are said apart, they have not gone out.
  const ymd = (iso) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const dFrom = ymd(R.from); const dTo = ymd(R.to); const dPrevFrom = ymd(R.prevFrom); const dPrevTo = ymd(R.prevTo);
  const sumRow = async (sql, ...args) => { const x = (await DB.one(sql, ...args)) || {}; return { n: Number(x.n) || 0, v: Math.round((Number(x.v) || 0) * 100) / 100 }; };
  const invoicedNow = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM("total"), 0) AS "v" FROM "CrmInvoice" WHERE ${own} AND "status" NOT IN ('Draft', 'Cancelled') AND "issueDate" >= ? AND "issueDate" < ?`, ...p, dFrom, dTo);
  const collectedNow = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM("amount"), 0) AS "v" FROM "CrmPayment" WHERE ${own} AND "amount" > 0 AND "paidOn" >= ? AND "paidOn" < ?`, ...p, dFrom, dTo);
  const collectedBefore = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM("amount"), 0) AS "v" FROM "CrmPayment" WHERE ${own} AND "paidOn" >= ? AND "paidOn" < ?`, ...p, dPrevFrom, dPrevTo);
  // TDS the customer deducted counts as settled (it is not owed), but it is NOT cash: collected stays the money that came, TDS is its own line
  const BAL = '"total" - "paidAmount" - COALESCE("tdsAmount", 0)';
  const owed = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM(${BAL}), 0) AS "v" FROM "CrmInvoice" WHERE ${own} AND "status" IN ('Sent', 'Partly paid') AND ${BAL} > 0.004`, ...p);
  const overdueOwed = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM(${BAL}), 0) AS "v" FROM "CrmInvoice" WHERE ${own} AND "status" IN ('Sent', 'Partly paid') AND ${BAL} > 0.004 AND "dueDate" IS NOT NULL AND "dueDate" < ?`, ...p, today);
  const tdsNow = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM("tdsAmount"), 0) AS "v" FROM "CrmPayment" WHERE ${own} AND COALESCE("tdsAmount", 0) > 0 AND "paidOn" >= ? AND "paidOn" < ?`, ...p, dFrom, dTo);
  const drafts = await sumRow(`SELECT COUNT(*) AS "n", COALESCE(SUM("total"), 0) AS "v" FROM "CrmInvoice" WHERE ${own} AND "status" = 'Draft'`, ...p);
  const wonNoInvoice = await count(`SELECT COUNT(*) AS "n" FROM "CrmDeal" d WHERE ${all ? '1=1' : 'd."ownerId" = ?'} AND d."stage" = 'Won' AND NOT EXISTS (SELECT 1 FROM "CrmInvoice" i WHERE i."dealId" = d."id")`, ...p);
  const cash = {
    booked: { value: wonNow.v, deals: wonNow.n, delta: delta(wonNow.v, wonBefore.v) },
    invoiced: { value: invoicedNow.v, invoices: invoicedNow.n },
    collected: { value: collectedNow.v, payments: collectedNow.n, delta: delta(collectedNow.v, collectedBefore.v) },
    tds: { value: tdsNow.v, lines: tdsNow.n },
    toCollect: { value: owed.v, invoices: owed.n, overdueValue: overdueOwed.v, overdueInvoices: overdueOwed.n },
    drafts: { value: drafts.v, invoices: drafts.n },
    wonNoInvoice,
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
    const w = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...p, f, t);
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

  return S.okBody({ period: period || 'month', periodLabel: R.label, scope: all ? 'all' : 'mine', today, cards, cash, funnel, conversion, trend, todayList, recentDeals, flow });
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

module.exports = { overview, activities, people, reports, setTarget, saveSettings, bulkLeads, importLeads, exportCsv, proposalDefaults, createProposal, proposalPdf, invoicePdf, shareInvoice, invoiceOfToken, sendProposal, emailInvoiceDraft, emailInvoice, decideProposal, proposalOfToken, proposalForCustomer, decideByCustomer, monthRange };

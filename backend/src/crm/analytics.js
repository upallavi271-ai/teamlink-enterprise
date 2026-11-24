// ---------------------------------------------------------------------------
// THE CRM'S WORK AND REPORTING SIDE (2026-11-17), inside the five modules (no new sidebar item):
//   calendar      Follow-ups > Calendar: every follow-up in a date range, with whether the viewer may move it (drag = POST /tasks/:id/snooze)
//   charts        Dashboard > Overview charts: lead sources, the deal pipeline by stage value, Booked / Invoiced / Collected by month (12),
//                 the team (won value and activities per salesperson), lost reasons, and the WEIGHTED FORECAST by expected close month
//                 (open deal value x the stage probability from CRM settings)
//   reports       Dashboard > Reports: by owner, the lead funnel with conversion between stages, source performance, lost reasons, aging
//   export        each report table as Excel (.xlsx). Only with the CRM "export" right; every download is written to the export log
//                 (CrmExportLog: who, what, rows, when) that Sales managers / Admins read, and audited
//   conversation  one thread per lead / deal: every email, WhatsApp, SMS and call (sent ones and the replies), oldest first
//   leadPage      Leads list paged on the server (50 a page, the total) and sorted by any column; the filters are crm/service.js list()'s
// The access rules are crm/service.js's: a salesperson their own, a Sales manager / Admin / Viewer everyone (or "Only mine" / one owner).
// ---------------------------------------------------------------------------
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const OFF = 5.5 * 3600 * 1000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const istYm = (iso) => (iso ? new Date(Date.parse(iso) + OFF).toISOString().slice(0, 7) : null);
const istYmd = (iso) => new Date(Date.parse(iso) + OFF).toISOString().slice(0, 10);
const monthNow = () => S.istToday().slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const monthStartIso = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1) - OFF).toISOString(); };
const MONTH_WORDS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTH_WORDS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
// a person's own work, not the lines TeamLink writes by itself
const WORK = `x."byId" IS NOT NULL AND COALESCE(x."subject", '') NOT LIKE 'Stage:%' AND COALESCE(x."subject", '') NOT LIKE 'Follow-up moved:%'`;

// The period of the dashboard (this month, last month, this quarter, this year), or a custom from / to (YYYY-MM-DD, India dates).
function periodRange({ period, from, to } = {}) {
  if (YMD.test(String(from || '')) && YMD.test(String(to || '')) && from <= to) {
    const f = new Date(Date.parse(`${from}T00:00:00Z`) - OFF).toISOString();
    const t = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000 - OFF).toISOString();
    return { from: f, to: t, dFrom: from, dTo: new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), label: `${from} to ${to}`, key: 'custom' };
  }
  const ist = new Date(Date.now() + OFF);
  const y = ist.getUTCFullYear(); const m = ist.getUTCMonth();
  const at = (yy, mm) => new Date(Date.UTC(yy, mm, 1) - OFF).toISOString();
  let r;
  if (period === 'last_month') r = { from: at(y, m - 1), to: at(y, m), label: 'Last month', key: period };
  else if (period === 'quarter') { const q = Math.floor(m / 3) * 3; r = { from: at(y, q), to: at(y, q + 3), label: 'This quarter', key: period }; } else if (period === 'year') r = { from: at(y, 0), to: at(y + 1, 0), label: 'This year', key: period };
  else r = { from: at(y, m), to: at(y, m + 1), label: 'This month', key: 'month' };
  return { ...r, dFrom: istYmd(r.from), dTo: istYmd(r.to) };
}

// Whose records: a salesperson their own; everyone else everybody, "Only mine" (mine=1), or one salesperson (owner=).
function scopeOf(user, { mine, owner } = {}) {
  const r = S.roleOf(user);
  const all = S.seesAll(r) && !(mine === true || mine === '1' || mine === 1);
  const who = all ? (S.clip(owner, 60) || null) : user.id;
  return { r, all, who, own: (col = '"ownerId"') => (who ? { sql: `${col} = ?`, params: [who] } : { sql: '1=1', params: [] }) };
}
// the salespeople a team table is about
async function ownersFor(sc) {
  const opts = await S.ownerOptions();
  if (sc.who) {
    const o = opts.find((x) => x.id === sc.who);
    if (o) return [o];
    const any = await DB.one('SELECT "ownerName" AS "name" FROM "CrmDeal" WHERE "ownerId" = ? UNION ALL SELECT "ownerName" FROM "CrmLead" WHERE "ownerId" = ? LIMIT 1', sc.who, sc.who).catch(() => null);
    return [{ id: sc.who, name: (any && any.name) || '—' }];
  }
  const out = [...opts];
  const known = new Set(out.map((o) => o.id));
  const extra = await DB.all('SELECT DISTINCT "ownerId", "ownerName" FROM "CrmDeal" WHERE "ownerId" IS NOT NULL UNION SELECT DISTINCT "ownerId", "ownerName" FROM "CrmLead" WHERE "ownerId" IS NOT NULL');
  extra.forEach((x) => { if (!known.has(x.ownerId)) { known.add(x.ownerId); out.push({ id: x.ownerId, name: x.ownerName || '—', former: true }); } });
  return out;
}

// ---- Follow-ups > Calendar ------------------------------------------------------------------------------------------------
async function calendar(user, { from, to, owner } = {}) {
  const r = S.roleOf(user);
  if (!YMD.test(String(from || '')) || !YMD.test(String(to || '')) || from > to) return S.fail(400, 'Say which days: from and to (YYYY-MM-DD).');
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 62) return S.fail(400, 'At most two months at a time.');
  const where = ['t."dueDate" >= ?', 't."dueDate" <= ?', 't."status" IN (\'Open\', \'Done\')'];
  const params = [from, to];
  const owners = require('./listFilters').csv(owner).map((v) => S.clip(v, 60)); // eslint-disable-line global-require
  if (!S.seesAll(r)) { where.push('t."ownerId" = ?'); params.push(user.id); } else if (owners.length) { where.push(`t."ownerId" IN (${owners.map(() => '?').join(',')})`); params.push(...owners); }
  const rows = await DB.all(`SELECT t."id", t."title", t."dueDate", t."dueTime", t."status", t."type", t."priority", t."ownerId", t."ownerName", t."leadId", t."dealId", t."accountId", t."outcome",
      COALESCE(d."title", l."company", a."name") AS "recordName",
      CASE WHEN t."dealId" IS NOT NULL THEN 'deal' WHEN t."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind",
      COALESCE(t."dealId", t."leadId", t."accountId") AS "recordId"
    FROM "CrmTask" t LEFT JOIN "CrmDeal" d ON d."id" = t."dealId" LEFT JOIN "CrmLead" l ON l."id" = t."leadId" LEFT JOIN "CrmAccount" a ON a."id" = t."accountId"
    WHERE ${where.join(' AND ')} ORDER BY t."dueDate", COALESCE(t."dueTime", '99:99') LIMIT 2000`, ...params);
  const today = S.istToday();
  const nowHm = new Date(Date.now() + OFF).toISOString().slice(11, 16);
  return S.okBody({
    from, to, today,
    tasks: rows.map((t) => ({
      ...t, type: t.type || 'Call', priority: t.priority || 'Medium',
      late: t.status === 'Open' && (t.dueDate < today || (t.dueDate === today && !!t.dueTime && t.dueTime < nowHm)),
      canMove: t.status === 'Open' && S.canEditRow(user, r, t),
    })),
  });
}

// ---- Dashboard charts --------------------------------------------------------------------------------------------------------
async function charts(user, q = {}) {
  const sc = scopeOf(user, q);
  const R = periodRange(q);
  const st = await SETTINGS.load();
  const o = sc.own();
  const ox = sc.own('x."ownerId"');

  // where the leads added in the period came from
  const sources = (await DB.all(`SELECT COALESCE(NULLIF(x."source", ''), 'Not given') AS "name", COUNT(*) AS "count" FROM "CrmLead" x WHERE ${ox.sql} AND x."createdAt" >= ? AND x."createdAt" < ? GROUP BY 1 ORDER BY 2 DESC, 1`, ...ox.params, R.from, R.to))
    .map((x) => ({ name: x.name, count: Number(x.count) || 0 }));

  // the deal pipeline as it stands now: the open stages, by value
  const open = await DB.all(`SELECT "id", "stage", "value", "expectedClose" FROM "CrmDeal" WHERE ${o.sql} AND "stage" NOT IN ('Won', 'Lost')`, ...o.params);
  const pipeline = require('./pipelines').reportStages(open.map((d) => d.stage)).map((s) => { // eslint-disable-line global-require
    const ds = open.filter((d) => d.stage === s);
    return { stage: s, count: ds.length, value: round2(ds.reduce((a, d) => a + (Number(d.value) || 0), 0)), probability: st.stageProbability[s] != null ? st.stageProbability[s] : require('./pipelines').probabilityFor(s) }; // eslint-disable-line global-require
  });

  // money by month, the last 12: booked (won, after the discount) / invoiced (gone out, with tax) / collected (the payment log)
  const thisM = monthNow();
  const months = Array.from({ length: 12 }, (_, i) => addMonths(thisM, i - 11));
  const fromIso = monthStartIso(months[0]); const toIso = monthStartIso(addMonths(thisM, 1));
  const fromD = `${months[0]}-01`; const toD = `${addMonths(thisM, 1)}-01`;
  const won = await DB.all(`SELECT "wonAt", COALESCE("finalValue", "value") AS "v" FROM "CrmDeal" WHERE ${o.sql} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ?`, ...o.params, fromIso, toIso);
  const inv = await DB.all(`SELECT "issueDate", "total" AS "v" FROM "CrmInvoice" WHERE ${o.sql} AND "status" NOT IN ('Draft', 'Cancelled') AND "issueDate" >= ? AND "issueDate" < ?`, ...o.params, fromD, toD);
  const pay = await DB.all(`SELECT "paidOn", "amount" AS "v" FROM "CrmPayment" WHERE ${o.sql} AND "paidOn" >= ? AND "paidOn" < ?`, ...o.params, fromD, toD);
  const revenue = months.map((ym) => ({
    month: ym, label: monthLabel(ym),
    booked: round2(won.filter((x) => istYm(x.wonAt) === ym).reduce((a, x) => a + (Number(x.v) || 0), 0)),
    invoiced: round2(inv.filter((x) => String(x.issueDate).slice(0, 7) === ym).reduce((a, x) => a + (Number(x.v) || 0), 0)),
    collected: round2(pay.filter((x) => String(x.paidOn).slice(0, 7) === ym).reduce((a, x) => a + (Number(x.v) || 0), 0)),
  }));

  // the team in the period: won value and activities per salesperson
  const owners = await ownersFor(sc);
  const wonBy = await DB.all(`SELECT "ownerId", COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE ${o.sql} AND "stage" = 'Won' AND "wonAt" >= ? AND "wonAt" < ? GROUP BY "ownerId"`, ...o.params, R.from, R.to);
  const actBy = await DB.all(`SELECT x."byId", COUNT(*) AS "n" FROM "CrmActivity" x WHERE ${sc.who ? 'x."byId" = ?' : '1=1'} AND ${WORK} AND x."at" >= ? AND x."at" < ? GROUP BY x."byId"`, ...(sc.who ? [sc.who] : []), R.from, R.to);
  const team = owners.map((ow) => {
    const w = wonBy.find((x) => x.ownerId === ow.id) || {};
    const a = actBy.find((x) => x.byId === ow.id) || {};
    return { ownerId: ow.id, name: ow.name, won: Number(w.n) || 0, wonValue: round2(w.v), activities: Number(a.n) || 0, former: !!ow.former };
  }).filter((x) => !x.former || x.won || x.activities).sort((a, b) => b.wonValue - a.wonValue || b.activities - a.activities || String(a.name).localeCompare(String(b.name)));

  // why deals were lost in the period
  const lostReasons = (await DB.all(`SELECT COALESCE(NULLIF("lostReason", ''), 'Not given') AS "name", COUNT(*) AS "count", COALESCE(SUM("value"), 0) AS "value" FROM "CrmDeal" WHERE ${o.sql} AND "stage" = 'Lost' AND "lostAt" >= ? AND "lostAt" < ? GROUP BY 1 ORDER BY 2 DESC, 1`, ...o.params, R.from, R.to))
    .map((x) => ({ name: x.name, count: Number(x.count) || 0, value: round2(x.value) }));

  // the weighted forecast: open deal value x the stage probability (CRM settings), by the month they should close
  const fc = new Map([['late', { key: 'late', label: 'Close date passed', count: 0, value: 0, weighted: 0 }]]);
  for (let i = 0; i < 12; i += 1) { const ym = addMonths(thisM, i); fc.set(ym, { key: ym, label: monthLabel(ym), count: 0, value: 0, weighted: 0 }); }
  fc.set('later', { key: 'later', label: 'Later', count: 0, value: 0, weighted: 0 });
  fc.set('none', { key: 'none', label: 'No close date', count: 0, value: 0, weighted: 0 });
  const lastM = addMonths(thisM, 11);
  open.forEach((d) => {
    const ym = d.expectedClose ? String(d.expectedClose).slice(0, 7) : null;
    const key = !ym ? 'none' : (ym < thisM ? 'late' : (ym > lastM ? 'later' : ym));
    const b = fc.get(key);
    const v = Number(d.value) || 0;
    b.count += 1; b.value += v; b.weighted += (v * (Number(st.stageProbability[d.stage]) || 0)) / 100;
  });
  const forecast = [...fc.values()].map((b) => ({ ...b, value: round2(b.value), weighted: round2(b.weighted) }));
  const forecastTotal = round2(forecast.reduce((a, b) => a + b.weighted, 0));

  return S.okBody({ period: R.key, periodLabel: R.label, scope: sc.all ? (sc.who ? 'owner' : 'all') : 'mine', owner: sc.who, sources, pipeline, revenue, team, lostReasons, forecast, forecastTotal, stageProbability: st.stageProbability });
}

// ---- Dashboard > Reports --------------------------------------------------------------------------------------------------
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
async function reportTables(user, q = {}) {
  const sc = scopeOf(user, q);
  // a salesperson always sees their own; the team's numbers need the reports right (as crm/extra.js reports)
  if (S.seesAll(sc.r) && !S.can(user, 'reports')) return S.fail(403, 'Your CRM rights do not include reports. Ask a Sales manager.');
  const R = periodRange(q);
  const st = await SETTINGS.load();
  const SALES = require('./sales'); // eslint-disable-line global-require
  const names = SALES.stageNames(st);
  const today = S.istToday();
  const ox = sc.own('x."ownerId"');

  // the leads added in the period, with where each stands
  const leads = (await DB.all(`SELECT x."id", x."ownerId", x."source", x."status", x."stage", x."createdAt", d."stage" AS "dealStage", COALESCE(d."finalValue", d."value") AS "dealValue"
    FROM "CrmLead" x LEFT JOIN "CrmDeal" d ON d."id" = x."dealId" WHERE ${ox.sql} AND x."createdAt" >= ? AND x."createdAt" < ?`, ...ox.params, R.from, R.to))
    .map((l) => ({ ...l, at: SALES.stageOf(l, names) }));
  const contacted = (l) => !['New', 'Junk'].includes(l.status);
  const qualified = (l) => ['Qualified', 'Converted'].includes(l.status);
  const converted = (l) => l.status === 'Converted';
  const wonLead = (l) => l.at === 'Won' && l.dealStage === 'Won';

  // by owner
  const owners = await ownersFor(sc);
  const wonBy = await DB.all(`SELECT x."ownerId", COUNT(*) AS "n", COALESCE(SUM(COALESCE(x."finalValue", x."value")), 0) AS "v" FROM "CrmDeal" x WHERE ${ox.sql} AND x."stage" = 'Won' AND x."wonAt" >= ? AND x."wonAt" < ? GROUP BY x."ownerId"`, ...ox.params, R.from, R.to);
  const actBy = await DB.all(`SELECT x."byId", COUNT(*) AS "n" FROM "CrmActivity" x WHERE ${sc.who ? 'x."byId" = ?' : '1=1'} AND ${WORK} AND x."at" >= ? AND x."at" < ? GROUP BY x."byId"`, ...(sc.who ? [sc.who] : []), R.from, R.to);
  const overdueBy = await DB.all(`SELECT x."ownerId", COUNT(*) AS "n" FROM "CrmTask" x WHERE ${ox.sql} AND x."status" = 'Open' AND x."dueDate" < ? GROUP BY x."ownerId"`, ...ox.params, today);
  // completion: of the follow-ups due in the period (up to today), how many are done
  const lastDue = R.dTo <= today ? new Date(Date.parse(`${R.dTo}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : today;
  const dueBy = await DB.all(`SELECT x."ownerId", COUNT(*) AS "n", SUM(CASE WHEN x."status" = 'Done' THEN 1 ELSE 0 END) AS "done" FROM "CrmTask" x WHERE ${ox.sql} AND x."status" IN ('Open', 'Done') AND x."dueDate" >= ? AND x."dueDate" <= ? GROUP BY x."ownerId"`, ...ox.params, R.dFrom, lastDue);
  const get = (rows, key, id, f = 'n') => Number((rows.find((x) => x[key] === id) || {})[f]) || 0;
  const byOwner = owners.map((ow) => {
    const mineL = leads.filter((l) => l.ownerId === ow.id);
    const due = get(dueBy, 'ownerId', ow.id); const done = get(dueBy, 'ownerId', ow.id, 'done');
    return {
      ownerId: ow.id, owner: ow.name, former: !!ow.former,
      leads: mineL.length, contacted: mineL.filter(contacted).length, qualified: mineL.filter(qualified).length, converted: mineL.filter(converted).length,
      won: get(wonBy, 'ownerId', ow.id), wonValue: round2(get(wonBy, 'ownerId', ow.id, 'v')),
      activities: get(actBy, 'byId', ow.id), overdue: get(overdueBy, 'ownerId', ow.id),
      followUpsDue: due, followUpsDone: done, completion: pct(done, due),
    };
  }).filter((x) => !x.former || x.leads || x.activities || x.won || x.overdue)
    .sort((a, b) => b.wonValue - a.wonValue || b.leads - a.leads || String(a.owner).localeCompare(String(b.owner)));

  // the funnel of the leads added in the period, with the conversion from one step to the next
  const steps = [['Leads added', () => true], ['Contacted', contacted], ['Qualified', qualified], ['Converted to a deal', converted], ['Won', wonLead]];
  const funnel = steps.map(([step, f], i) => ({ step, count: leads.filter(f).length, i }));
  funnel.forEach((x, i) => { x.fromPrevious = i ? pct(x.count, funnel[i - 1].count) : null; x.ofAdded = pct(x.count, funnel[0].count); delete x.i; });

  // source performance
  const bySrc = new Map();
  leads.forEach((l) => { const k = l.source || 'Not given'; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(l); });
  const sources = [...bySrc.entries()].map(([source, ls]) => {
    const w = ls.filter(wonLead);
    return { source, leads: ls.length, contacted: ls.filter(contacted).length, qualified: ls.filter(qualified).length, converted: ls.filter(converted).length, won: w.length, wonValue: round2(w.reduce((a, l) => a + (Number(l.dealValue) || 0), 0)), conversion: pct(w.length, ls.length) };
  }).sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));

  // lost reasons: deals lost in the period, and leads that went Lost in it
  const lostDeals = await DB.all(`SELECT COALESCE(NULLIF(x."lostReason", ''), 'Not given') AS "reason", COUNT(*) AS "n", COALESCE(SUM(x."value"), 0) AS "v" FROM "CrmDeal" x WHERE ${ox.sql} AND x."stage" = 'Lost' AND x."lostAt" >= ? AND x."lostAt" < ? GROUP BY 1`, ...ox.params, R.from, R.to);
  const lostLeads = await DB.all(`SELECT COALESCE(NULLIF(x."lostReason", ''), 'Not given') AS "reason", COUNT(*) AS "n" FROM "CrmLead" x WHERE ${ox.sql} AND x."stage" = 'Lost' AND x."status" NOT IN ('Converted') AND x."updatedAt" >= ? AND x."updatedAt" < ? GROUP BY 1`, ...ox.params, R.from, R.to);
  const reasons = [...new Set([...lostDeals.map((x) => x.reason), ...lostLeads.map((x) => x.reason)])];
  const lost = reasons.map((reason) => ({ reason, deals: get(lostDeals, 'reason', reason), dealValue: round2(get(lostDeals, 'reason', reason, 'v')), leads: get(lostLeads, 'reason', reason) }))
    .sort((a, b) => (b.deals + b.leads) - (a.deals + a.leads) || a.reason.localeCompare(b.reason));

  // aging of what is still open (now, not the period): days since it was added
  const openLeads = (await DB.all(`SELECT x."createdAt", x."status", x."stage", NULL AS "dealStage" FROM "CrmLead" x WHERE ${ox.sql} AND x."status" NOT IN ('Converted', 'Junk')`, ...ox.params)).filter((l) => !['Won', 'Lost'].includes(SALES.stageOf(l, names)));
  const openDeals = await DB.all(`SELECT x."createdAt", x."value" FROM "CrmDeal" x WHERE ${ox.sql} AND x."stage" NOT IN ('Won', 'Lost')`, ...ox.params);
  const BUCKETS = [['0-7 days', 0, 7], ['8-30 days', 8, 30], ['31-60 days', 31, 60], ['61-90 days', 61, 90], ['Over 90 days', 91, Infinity]];
  const ageOf = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000));
  const aging = BUCKETS.map(([bucket, lo, hi]) => {
    const inB = (x) => { const a = ageOf(x.createdAt); return a >= lo && a <= hi; };
    const ds = openDeals.filter(inB);
    return { bucket, leads: openLeads.filter(inB).length, deals: ds.length, dealValue: round2(ds.reduce((a, d) => a + (Number(d.value) || 0), 0)) };
  });

  return S.okBody({
    period: R.key, periodLabel: R.label, from: R.dFrom, to: R.dTo, scope: sc.all ? (sc.who ? 'owner' : 'all') : 'mine',
    tables: [
      { key: 'owners', title: 'By salesperson', columns: [['owner', 'Salesperson'], ['leads', 'Leads'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['converted', 'Converted'], ['won', 'Deals won'], ['wonValue', 'Won value'], ['activities', 'Activities'], ['overdue', 'Overdue follow-ups'], ['completion', 'Follow-ups done %']], rows: byOwner },
      { key: 'funnel', title: 'Lead funnel', columns: [['step', 'Step'], ['count', 'Leads'], ['fromPrevious', '% of the step before'], ['ofAdded', '% of leads added']], rows: funnel },
      { key: 'sources', title: 'Source performance', columns: [['source', 'Source'], ['leads', 'Leads'], ['contacted', 'Contacted'], ['qualified', 'Qualified'], ['converted', 'Converted'], ['won', 'Won'], ['wonValue', 'Won value'], ['conversion', 'Lead to won %']], rows: sources },
      { key: 'lost', title: 'Lost reasons', columns: [['reason', 'Reason'], ['deals', 'Deals lost'], ['dealValue', 'Deal value lost'], ['leads', 'Leads lost']], rows: lost },
      { key: 'aging', title: 'Aging of open leads and deals', columns: [['bucket', 'Open for'], ['leads', 'Open leads'], ['deals', 'Open deals'], ['dealValue', 'Open deal value']], rows: aging },
    ],
  });
}

// ---- the export log ----------------------------------------------------------------------------------------------------------
async function logExport(user, what, format, rows, filters) {
  const at = DB.nowIso();
  await S.insert('CrmExportLog', { id: S.newId('exp'), byId: user.id, byName: user.name || null, what: String(what || '').slice(0, 120), format: String(format || '').slice(0, 10), rows: Number(rows) || 0, filters: filters ? JSON.stringify(filters).slice(0, 500) : null, at });
}
async function exportLog(user, { limit } = {}) {
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'The download log is for Sales managers and Admins.');
  const n = Math.max(1, Math.min(500, Math.round(Number(limit)) || 200));
  return S.okBody({ rows: await DB.all(`SELECT * FROM "CrmExportLog" ORDER BY "at" DESC LIMIT ${n}`) });
}

// One report table as an Excel file. -> { status, buffer, name, rows } or { status, body } when refused
async function exportReport(user, key, q = {}) {
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  const out = await reportTables(user, q);
  if (out.status !== 200) return out;
  const t = out.body.tables.find((x) => x.key === key);
  if (!t) return S.fail(404, 'There is no such report.');
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const aoa = [t.columns.map((c) => c[1]), ...t.rows.map((row) => t.columns.map((c) => (row[c[0]] == null ? '' : row[c[0]])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = t.columns.map((c, i) => ({ wch: Math.max(10, Math.min(40, Math.max(...aoa.map((r) => String(r[i] == null ? '' : r[i]).length)) + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.title.slice(0, 31));
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filters = { period: out.body.period, from: out.body.from, to: out.body.to, scope: out.body.scope, owner: q.owner || undefined };
  await logExport(user, `Report: ${t.title}`, 'xlsx', t.rows.length, filters);
  await S.audit(user, 'CRM report downloaded', 'Crm', `report:${key}`, `${t.title}: ${t.rows.length} rows (${out.body.periodLabel})`);
  return { status: 200, buffer, name: `crm-report-${key}-${S.istToday()}.xlsx`, rows: t.rows.length };
}

// ---- one conversation thread per lead / deal ---------------------------------------------------------------------------------
const INBOUND = /^(Replied on|Asked us to stop)/;
function messageOf(a) {
  const sms = a.kind === 'note' && /\bSMS\b/.test(a.subject || '');
  const channel = sms ? 'SMS' : ({ email: 'Email', whatsapp: 'WhatsApp', call: 'Call' }[a.kind] || 'Note');
  const direction = INBOUND.test(a.subject || '') ? 'in' : (a.kind === 'call' ? 'call' : 'out');
  let text = String(a.note || '');
  let to = null;
  const m = /^To ([^\n]+)\n\n([\s\S]*)$/.exec(text);
  if (m) { to = m[1]; text = m[2]; }
  let subject = a.subject || '';
  if (/^Email sent: /.test(subject)) subject = subject.slice(12);
  return { id: a.id, at: a.at, channel, direction, subject, text, to, by: a.byName || null, delivery: a.deliveryStatus || null, deliveryDetail: a.deliveryDetail || null };
}
async function conversation(user, kind, id) {
  if (!['lead', 'deal', 'account'].includes(kind)) return S.fail(404, 'Nothing to read here.');
  const r = S.roleOf(user);
  const row = await S.getRow(kind, id);
  if (!S.canSeeRow(user, r, row)) return S.fail(404, `This ${kind} is not there, or it is not yours.`);
  let where; let params;
  if (kind === 'lead') { where = row.dealId ? '("leadId" = ? OR "dealId" = ?)' : '"leadId" = ?'; params = row.dealId ? [row.id, row.dealId] : [row.id]; }
  if (kind === 'deal') { where = '("dealId" = ? OR "leadId" IN (SELECT "id" FROM "CrmLead" WHERE "dealId" = ?))'; params = [row.id, row.id]; }
  if (kind === 'account') { where = '("accountId" = ? OR "dealId" IN (SELECT "id" FROM "CrmDeal" WHERE "accountId" = ?))'; params = [row.id, row.id]; }
  const rows = await DB.all(`SELECT * FROM (SELECT * FROM "CrmActivity" WHERE ${where} AND ("kind" IN ('email', 'whatsapp', 'call') OR ("kind" = 'note' AND "subject" LIKE '%SMS%'))
    ORDER BY "at" DESC, "createdAt" DESC LIMIT 500) ORDER BY "at" ASC, "createdAt" ASC`, ...params);
  return S.okBody({ kind, id: row.id, canReply: S.canEditRow(user, r, row), messages: rows.map(messageOf) });
}

// ---- Leads list, paged and sorted on the server ------------------------------------------------------------------------------
const SORTS = {
  company: (l) => String(l.company || '').toLowerCase(),
  created: (l) => l.createdAt || null,
  touched: (l) => l.lastActivityAt || null,
  next: (l) => l.nextTaskDue || null,
  value: (l) => (l.expectedValue == null ? null : Number(l.expectedValue)),
  owner: (l) => (l.ownerName ? String(l.ownerName).toLowerCase() : null),
};
async function leadPage(user, q = {}) {
  const size = Math.max(10, Math.min(200, Math.round(Number(q.pageSize)) || 50));
  const rows = await S.list(user, 'lead', { ...q, max: 20000 });
  const st = await SETTINGS.load();
  const order = require('./sales').stageNames(st); // eslint-disable-line global-require
  const sort = SORTS[q.sort] ? q.sort : (q.sort === 'stage' ? 'stage' : 'updated');
  const dir = q.dir === 'asc' ? 1 : -1;
  const key = sort === 'stage' ? (l) => order.indexOf(l.stage) : (SORTS[sort] || ((l) => l.updatedAt || null));
  // nulls (never touched, no follow-up, no value) always go last; the same values keep the newest first
  rows.sort((a, b) => {
    const x = key(a); const y = key(b);
    if (x == null && y == null) return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    if (x == null) return 1;
    if (y == null) return -1;
    if (x < y) return -dir;
    if (x > y) return dir;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(1, Math.min(pages, Math.round(Number(q.page)) || 1));
  return S.okBody({ rows: rows.slice((page - 1) * size, page * size), total, page, pages, pageSize: size, sort, dir: dir === 1 ? 'asc' : 'desc' });
}

module.exports = { calendar, charts, reportTables, exportReport, exportLog, logExport, conversation, leadPage, periodRange };

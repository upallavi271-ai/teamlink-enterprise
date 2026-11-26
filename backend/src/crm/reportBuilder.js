// ---------------------------------------------------------------------------
// CRM WAVE A - REPORTS ANYBODY CAN BUILD (2026-11-24; 10.02 report builder, 10.03 own dashboards, 10.08 scheduled reports).
//   REPORT BUILDER  pick what it is about (leads, deals, customers, activities, follow-ups, invoices), the columns, filters, a period on one
//                   of its dates, a group (with month / week / day for a date), what is counted (count, or sum / average / min / max of a
//                   number), a chart (table, bar, line, pie), the order; save it for yourself or share it with the CRM team. A shared report
//                   is read by each person with THEIR OWN scope (a salesperson sees only their own rows in it). Excel needs the export right.
//   MY DASHBOARD    widgets (any saved report, or a ready number: open pipeline, won this month, follow-ups due, new leads), in the order and
//                   width a person picks; a Sales manager can set the team's default.
//   SCHEDULED       a saved report mailed daily / weekly / monthly at a time to people on the CRM team, with the table in the mail and the
//                   Excel file attached; it is read with the scope of the person who set it up. Mailed by itself only while an Admin has
//                   "Scheduled report mails" on; "Send me a copy now" always works for the person pressing it.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const W = require('./waveSchema');
const S = require('./service');
const DB = require('./schema');

const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const now = () => new Date().toISOString();
const OFF = 5.5 * 3600 * 1000;
const isManager = (user) => ['admin', 'tl'].includes(S.roleOf(user));

// ---- sources: [key, words, type, SQL] type s text, n number, d date (ISO moment), y date (YYYY-MM-DD) ----------------------------
const SOURCES = {
  leads: { label: 'Leads', from: '"CrmLead" x', own: 'x."ownerId"', fields: [
    ['code', 'Code', 's', 'x."code"'], ['company', 'Company', 's', 'x."company"'], ['contactName', 'Contact', 's', 'x."contactName"'], ['source', 'Source', 's', 'x."source"'],
    ['status', 'Status', 's', 'x."status"'], ['stage', 'Stage', 's', 'x."stage"'], ['rating', 'Rating', 's', 'x."rating"'], ['industry', 'Industry', 's', 'x."industry"'], ['city', 'City', 's', 'x."city"'],
    ['expectedValue', 'Expected value', 'n', 'x."expectedValue"'], ['ownerName', 'Owner', 's', 'x."ownerName"'], ['utmCampaign', 'Campaign', 's', 'x."utmCampaign"'], ['createdAt', 'Added on', 'd', 'x."createdAt"'], ['convertedAt', 'Converted on', 'd', 'x."convertedAt"'],
  ] },
  deals: { label: 'Deals', from: '"CrmDeal" x LEFT JOIN "CrmAccount" acc ON acc."id" = x."accountId"', own: 'x."ownerId"', fields: [
    ['code', 'Code', 's', 'x."code"'], ['title', 'Deal', 's', 'x."title"'], ['accountName', 'Customer', 's', 'acc."name"'], ['stage', 'Stage', 's', 'x."stage"'],
    ['value', 'Value', 'n', 'x."value"'], ['finalValue', 'Value after discount', 'n', 'COALESCE(x."finalValue", x."value")'], ['weighted', 'Weighted value', 'n', 'ROUND(x."value" * x."probability" / 100.0, 2)'],
    ['discountPercent', 'Discount %', 'n', 'x."discountPercent"'], ['probability', 'Probability %', 'n', 'x."probability"'], ['expectedClose', 'Expected close', 'y', 'x."expectedClose"'],
    ['lostReason', 'Lost reason', 's', 'x."lostReason"'], ['ownerName', 'Owner', 's', 'x."ownerName"'], ['industry', 'Industry', 's', 'acc."industry"'], ['city', 'City', 's', 'acc."city"'],
    ['createdAt', 'Added on', 'd', 'x."createdAt"'], ['wonAt', 'Won on', 'd', 'x."wonAt"'], ['lostAt', 'Lost on', 'd', 'x."lostAt"'],
  ] },
  accounts: { label: 'Customers / accounts', from: '"CrmAccount" x', own: 'x."ownerId"', fields: [
    ['code', 'Code', 's', 'x."code"'], ['name', 'Name', 's', 'x."name"'], ['kind', 'Prospect / Client', 's', 'x."kind"'], ['industry', 'Industry', 's', 'x."industry"'], ['city', 'City', 's', 'x."city"'],
    ['state', 'State', 's', 'x."state"'], ['source', 'Source', 's', 'x."source"'], ['ownerName', 'Owner', 's', 'x."ownerName"'], ['createdAt', 'Added on', 'd', 'x."createdAt"'],
  ] },
  activities: { label: 'Calls, meetings, emails, notes', from: '"CrmActivity" x', own: 'x."byId"', fields: [
    ['kind', 'What', 's', 'x."kind"'], ['subject', 'Subject', 's', 'x."subject"'], ['byName', 'By', 's', 'x."byName"'], ['at', 'When', 'd', 'x."at"'],
  ], where: 'x."byId" IS NOT NULL' },
  tasks: { label: 'Follow-ups', from: '"CrmTask" x', own: 'x."ownerId"', fields: [
    ['title', 'Follow-up', 's', 'x."title"'], ['type', 'Type', 's', 'x."type"'], ['priority', 'Priority', 's', 'x."priority"'], ['status', 'Status', 's', 'x."status"'], ['outcome', 'Outcome', 's', 'x."outcome"'],
    ['dueDate', 'Due', 'y', 'x."dueDate"'], ['ownerName', 'Owner', 's', 'x."ownerName"'], ['doneAt', 'Done on', 'd', 'x."doneAt"'],
    ['onTime', 'Done on time (1 / 0)', 'n', 'CASE WHEN x."status" = \'Done\' AND date(datetime(x."doneAt", \'+330 minutes\')) <= x."dueDate" THEN 1 ELSE 0 END'],
  ] },
  invoices: { label: 'Invoices', from: '"CrmInvoice" x', own: 'x."ownerId"', fields: [
    ['code', 'Number', 's', 'x."code"'], ['accountName', 'Customer', 's', 'x."accountName"'], ['status', 'Status', 's', 'x."status"'], ['issueDate', 'Issued', 'y', 'x."issueDate"'], ['dueDate', 'Due', 'y', 'x."dueDate"'],
    ['amount', 'Amount', 'n', 'x."amount"'], ['taxAmount', 'Tax', 'n', 'x."taxAmount"'], ['total', 'Total', 'n', 'x."total"'], ['paidAmount', 'Paid', 'n', 'x."paidAmount"'],
    ['balance', 'Balance', 'n', 'ROUND(x."total" - COALESCE(x."creditAmount", 0) + COALESCE(x."debitAmount", 0) - x."paidAmount" - COALESCE(x."tdsAmount", 0), 2)'], ['ownerName', 'Owner', 's', 'x."ownerName"'],
  ] },
};
const fieldOf = (src, k) => (SOURCES[src].fields.find((f) => f[0] === k) || null);
const OPS = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty', 'in'];
const FNS = ['count', 'sum', 'avg', 'min', 'max'];
const CHARTS = ['table', 'bar', 'line', 'pie'];
const PERIODS = ['all', 'this_month', 'last_month', 'quarter', 'year', 'last_7', 'last_30', 'last_90', 'custom'];
const istYmd = (ms) => new Date(ms + OFF).toISOString().slice(0, 10);
function periodDates(p, from, to) {
  const today = istYmd(Date.now());
  const [y, m] = today.split('-').map(Number);
  const mStart = (yy, mm) => new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  const back = (n) => istYmd(Date.now() - n * 86400000);
  switch (p) {
    case 'this_month': return [mStart(y, m - 1), mStart(y, m)];
    case 'last_month': return [mStart(y, m - 2), mStart(y, m - 1)];
    case 'quarter': { const q = Math.floor((m - 1) / 3) * 3; return [mStart(y, q), mStart(y, q + 3)]; }
    case 'year': return [mStart(y, 0), mStart(y + 1, 0)];
    case 'last_7': return [back(6), istYmd(Date.now() + 86400000)];
    case 'last_30': return [back(29), istYmd(Date.now() + 86400000)];
    case 'last_90': return [back(89), istYmd(Date.now() + 86400000)];
    case 'custom': if (/^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '') && from <= to) return [from, new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)]; return null;
    default: return null;
  }
}
// a date column as an India date (YYYY-MM-DD): an ISO moment is moved to India time first
const dayExpr = (f) => (f[2] === 'd' ? `date(datetime(${f[3]}, '+330 minutes'))` : f[3]);

function cleanSpec(body = {}) {
  const src = String(body.source || '');
  if (!SOURCES[src]) return { error: 'Pick what the report is about.' };
  const cols = (Array.isArray(body.columns) ? body.columns : []).filter((c) => fieldOf(src, c)).slice(0, 15);
  const filters = [];
  for (const f of (Array.isArray(body.filters) ? body.filters : []).slice(0, 12)) {
    if (!fieldOf(src, f.field) || !OPS.includes(f.op)) return { error: 'Check the filters: a field and how it is compared.' };
    filters.push({ field: f.field, op: f.op, value: S.clip(f.value, 200) });
  }
  const dateField = body.dateField && fieldOf(src, body.dateField) && ['d', 'y'].includes(fieldOf(src, body.dateField)[2]) ? body.dateField : null;
  const period = PERIODS.includes(body.period) ? body.period : 'all';
  if (period === 'custom' && !periodDates('custom', body.from, body.to)) return { error: 'Pick the from and to dates.' };
  const groupBy = body.groupBy && fieldOf(src, body.groupBy) ? body.groupBy : null;
  const gt = groupBy ? fieldOf(src, groupBy)[2] : null;
  const groupDate = groupBy && ['d', 'y'].includes(gt) ? (['month', 'week', 'day'].includes(body.groupDate) ? body.groupDate : 'month') : null;
  const fn = FNS.includes(body.measure && body.measure.fn) ? body.measure.fn : 'count';
  const mField = fn !== 'count' ? (body.measure && fieldOf(src, body.measure.field) && fieldOf(src, body.measure.field)[2] === 'n' ? body.measure.field : null) : null;
  if (fn !== 'count' && !mField) return { error: 'Pick the number to add up.' };
  if (!groupBy && !cols.length) return { error: 'Pick the columns, or a group.' };
  const chart = CHARTS.includes(body.chart) ? body.chart : 'table';
  const sortField = body.sort && (body.sort.field === 'value' || body.sort.field === 'group' || fieldOf(src, body.sort.field)) ? body.sort.field : null;
  return { spec: {
    source: src, columns: cols, filters, dateField, period, from: period === 'custom' ? body.from : null, to: period === 'custom' ? body.to : null,
    groupBy, groupDate, measure: { fn, field: mField }, chart: groupBy ? chart : 'table', sort: sortField ? { field: sortField, dir: body.sort.dir === 'asc' ? 'asc' : 'desc' } : null,
    limit: Math.max(1, Math.min(1000, Math.round(Number(body.limit) || 200))),
  } };
}

async function runSpec(user, spec) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const src = SOURCES[spec.source];
  const where = [src.where || '1=1']; const params = [];
  if (!S.seesAll(r)) { where.push(`${src.own} = ?`); params.push(user.id); }
  for (const f of spec.filters || []) {
    const fd = fieldOf(spec.source, f.field);
    const col = ['d'].includes(fd[2]) ? dayExpr(fd) : fd[3];
    const v = f.value;
    if (f.op === 'eq') { where.push(fd[2] === 'n' ? `${col} = ?` : `lower(COALESCE(${col}, '')) = lower(?)`); params.push(fd[2] === 'n' ? Number(v) : String(v || '')); }
    else if (f.op === 'ne') { where.push(fd[2] === 'n' ? `COALESCE(${col}, 0) <> ?` : `lower(COALESCE(${col}, '')) <> lower(?)`); params.push(fd[2] === 'n' ? Number(v) : String(v || '')); }
    else if (f.op === 'contains') { where.push(`lower(COALESCE(${col}, '')) LIKE ?`); params.push(`%${String(v || '').toLowerCase()}%`); }
    else if (['gt', 'gte', 'lt', 'lte'].includes(f.op)) { where.push(`${col} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op]} ?`); params.push(fd[2] === 'n' ? Number(v) : String(v || '')); }
    else if (f.op === 'empty') where.push(`(${col} IS NULL OR ${col} = '')`);
    else if (f.op === 'not_empty') where.push(`(${col} IS NOT NULL AND ${col} <> '')`);
    else if (f.op === 'in') { const list = String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 30); if (list.length) { where.push(`lower(COALESCE(${col}, '')) IN (${list.map(() => '?').join(', ')})`); params.push(...list); } }
  }
  const range = spec.dateField ? periodDates(spec.period, spec.from, spec.to) : null;
  if (range) { const fd = fieldOf(spec.source, spec.dateField); where.push(`${dayExpr(fd)} >= ? AND ${dayExpr(fd)} < ?`); params.push(range[0], range[1]); }
  const W_ = where.join(' AND ');
  if (spec.groupBy) {
    const gd = fieldOf(spec.source, spec.groupBy);
    let g = gd[3];
    if (spec.groupDate) {
      const d = dayExpr(gd);
      g = spec.groupDate === 'day' ? d : spec.groupDate === 'week' ? `date(${d}, '-6 days', 'weekday 1')` : `substr(${d}, 1, 7)`;
    }
    const m = spec.measure.fn === 'count' ? 'COUNT(*)' : `ROUND(${spec.measure.fn.toUpperCase()}(${fieldOf(spec.source, spec.measure.field)[3]}), 2)`;
    const order = spec.sort ? (spec.sort.field === 'group' ? `"g" ${spec.sort.dir}` : `"v" ${spec.sort.dir}`) : (spec.groupDate ? '"g" asc' : '"v" desc');
    const rows = await DB.all(`SELECT COALESCE(${g}, '') AS "g", ${m} AS "v", COUNT(*) AS "n" FROM ${src.from} WHERE ${W_} GROUP BY 1 ORDER BY ${order} LIMIT ?`, ...params, spec.limit);
    const total = rows.reduce((a, x) => a + (Number(x.v) || 0), 0);
    const mLabel = spec.measure.fn === 'count' ? 'Count' : `${{ sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' }[spec.measure.fn]} ${fieldOf(spec.source, spec.measure.field)[1].toLowerCase()}`;
    return S.okBody({ grouped: true, chart: spec.chart, columns: [['group', gd[1] + (spec.groupDate ? ` (${spec.groupDate})` : '')], ['value', mLabel], ['records', 'Records']], rows: rows.map((x) => ({ group: x.g === '' ? '(empty)' : x.g, value: Number(x.v) || 0, records: Number(x.n) || 0 })), total: Math.round(total * 100) / 100, range });
  }
  const cols = spec.columns.map((k) => fieldOf(spec.source, k));
  const order = spec.sort && spec.sort.field !== 'value' && spec.sort.field !== 'group' ? `${fieldOf(spec.source, spec.sort.field)[3]} ${spec.sort.dir}` : (spec.dateField ? `${fieldOf(spec.source, spec.dateField)[3]} desc` : 'x."createdAt" desc');
  const rows = await DB.all(`SELECT ${cols.map((c) => `${c[3]} AS "${c[0]}"`).join(', ')} FROM ${src.from} WHERE ${W_} ORDER BY ${order} LIMIT ?`, ...params, spec.limit);
  const count = await DB.one(`SELECT COUNT(*) AS "n" FROM ${src.from} WHERE ${W_}`, ...params);
  return S.okBody({ grouped: false, chart: 'table', columns: cols.map((c) => [c[0], c[1]]), rows, total: Number(count && count.n) || 0, range });
}

// ---- the screen's calls --------------------------------------------------------------------------------------------------------
async function meta(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  return S.okBody({
    sources: Object.entries(SOURCES).map(([key, v]) => ({ key, label: v.label, fields: v.fields.map(([k, l, t]) => ({ key: k, label: l, type: t === 'y' ? 'd' : t })) })),
    ops: [['eq', 'is'], ['ne', 'is not'], ['contains', 'contains'], ['gt', 'more than'], ['gte', 'at least'], ['lt', 'less than'], ['lte', 'at most'], ['empty', 'is empty'], ['not_empty', 'is not empty'], ['in', 'is one of']].map(([key, label]) => ({ key, label })),
    periods: [['all', 'Any time'], ['this_month', 'This month'], ['last_month', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'], ['last_7', 'Last 7 days'], ['last_30', 'Last 30 days'], ['last_90', 'Last 90 days'], ['custom', 'From - to']].map(([key, label]) => ({ key, label })),
    fns: FNS, charts: CHARTS,
  });
}
async function preview(user, body) {
  const c = cleanSpec(body);
  if (c.error) return S.fail(400, c.error);
  return runSpec(user, c.spec);
}
const repOut = (x, user) => ({ id: x.id, name: x.name, source: x.source, spec: W.parse(x.specJson, {}), shared: !!x.shared, ownerId: x.ownerId, ownerName: x.ownerName, mine: x.ownerId === user.id, canEdit: x.ownerId === user.id || isManager(user), createdAt: x.createdAt, updatedAt: x.updatedAt });
async function list(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const rows = await W.all('SELECT * FROM "CrmReport" WHERE "ownerId" = ? OR "shared" = 1 ORDER BY "name"', user.id);
  return S.okBody({ reports: rows.map((x) => repOut(x, user)) });
}
async function save(user, id, body = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const name = S.clip(body.name, 120);
  if (!name) return S.fail(400, 'Give the report a name.');
  const c = cleanSpec(body.spec || body);
  if (c.error) return S.fail(400, c.error);
  // sharing with the team: a Sales manager / Admin, or anybody with the reports right
  const shared = body.shared === true && (isManager(user) || S.can(user, 'reports')) ? 1 : 0;
  if (body.shared === true && !shared) return S.fail(403, 'Your CRM rights do not allow sharing a report with the team.');
  const t = now();
  if (id) {
    const prev = await W.one('SELECT * FROM "CrmReport" WHERE "id" = ?', String(id));
    if (!prev || (prev.ownerId !== user.id && !(prev.shared && isManager(user)))) return S.fail(404, 'This report is not there, or it is not yours.');
    const saved = await W.update('CrmReport', prev.id, { name, source: c.spec.source, specJson: JSON.stringify(c.spec), shared, updatedAt: t });
    return S.okBody({ ok: true, report: repOut(saved, user) });
  }
  const n = await W.one('SELECT COUNT(*) AS "n" FROM "CrmReport" WHERE "ownerId" = ?', user.id);
  if (Number(n && n.n) >= 100) return S.fail(400, 'You have 100 reports. Remove one first.');
  const saved = await W.insert('CrmReport', { id: newId('rep'), name, source: c.spec.source, specJson: JSON.stringify(c.spec), ownerId: user.id, ownerName: user.name || null, shared, createdAt: t, updatedAt: t });
  await S.audit(user, 'CRM report saved', 'CrmReport', saved.id, `${name}${shared ? ' (shared with the team)' : ''}`);
  return S.okBody({ ok: true, report: repOut(saved, user) });
}
async function reportFor(user, id) {
  const x = await W.one('SELECT * FROM "CrmReport" WHERE "id" = ?', String(id || ''));
  if (!x || (x.ownerId !== user.id && !x.shared)) return null;
  return x;
}
async function runSaved(user, id) {
  const x = await reportFor(user, id);
  if (!x) return S.fail(404, 'This report is not there.');
  const out = await runSpec(user, W.parse(x.specJson, {}));
  if (out.status !== 200) return out;
  return S.okBody({ report: repOut(x, user), ...out.body });
}
async function remove(user, id) {
  const x = await W.one('SELECT * FROM "CrmReport" WHERE "id" = ?', String(id || ''));
  if (!x || (x.ownerId !== user.id && !(x.shared && isManager(user)))) return S.fail(404, 'This report is not there, or it is not yours.');
  await W.run('DELETE FROM "CrmReport" WHERE "id" = ?', x.id);
  await W.run('DELETE FROM "CrmReportSchedule" WHERE "reportId" = ?', x.id);
  await S.audit(user, 'CRM report removed', 'CrmReport', x.id, x.name);
  return S.okBody({ ok: true });
}
function xlsxOf(title, out) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const aoa = [out.columns.map((c) => c[1]), ...out.rows.map((row) => out.columns.map((c) => (row[c[0]] == null ? '' : row[c[0]])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(title || 'Report').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function exportSaved(user, id) {
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  const out = await runSaved(user, id);
  if (out.status !== 200) return out;
  const b = out.body;
  await require('./analytics').logExport(user, `Built report: ${b.report.name}`, 'xlsx', b.rows.length, { reportId: id }).catch(() => {}); // eslint-disable-line global-require
  await S.audit(user, 'CRM report downloaded', 'CrmReport', id, `${b.report.name}: ${b.rows.length} rows`);
  return { status: 200, buffer: xlsxOf(b.report.name, b), name: `crm-${b.report.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-${S.istToday()}.xlsx` };
}

// ---- my dashboard (10.03) ---------------------------------------------------------------------------------------------------------
const KPIS = { pipeline: 'Open pipeline', wonMonth: 'Won this month', followupsDue: 'Follow-ups due today and late', newLeads: 'New leads this month', toCollect: 'Still to collect' };
const DEFAULT_WIDGETS = [{ type: 'kpi', key: 'pipeline', size: 'small' }, { type: 'kpi', key: 'wonMonth', size: 'small' }, { type: 'kpi', key: 'followupsDue', size: 'small' }, { type: 'kpi', key: 'newLeads', size: 'small' }];
function cleanWidgets(list) {
  const out = [];
  for (const w of (Array.isArray(list) ? list : []).slice(0, 16)) {
    const size = ['small', 'half', 'full'].includes(w.size) ? w.size : 'half';
    if (w.type === 'kpi' && KPIS[w.key]) out.push({ type: 'kpi', key: w.key, size });
    else if (w.type === 'report' && /^rep_[a-f0-9]{18}$/.test(String(w.reportId || ''))) out.push({ type: 'report', reportId: w.reportId, size, chart: CHARTS.includes(w.chart) ? w.chart : null });
  }
  return out;
}
async function kpi(user, key) {
  const r = S.roleOf(user);
  const own = S.seesAll(r) ? { sql: '1=1', p: [] } : { sql: '"ownerId" = ?', p: [user.id] };
  const ym = S.istToday().slice(0, 7);
  const mFrom = new Date(Date.parse(`${ym}-01T00:00:00Z`) - OFF).toISOString();
  if (key === 'pipeline') { const x = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE "stage" NOT IN ('Won', 'Lost') AND ${own.sql}`, ...own.p); return { value: Number(x.v), money: true, sub: `${x.n} open deals` }; }
  if (key === 'wonMonth') { const x = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE "stage" = 'Won' AND "wonAt" >= ? AND ${own.sql}`, mFrom, ...own.p); return { value: Number(x.v), money: true, sub: `${x.n} deals` }; }
  if (key === 'followupsDue') { const x = await DB.one(`SELECT COUNT(*) AS "n", SUM(CASE WHEN "dueDate" < ? THEN 1 ELSE 0 END) AS "late" FROM "CrmTask" WHERE "status" = 'Open' AND "dueDate" <= ? AND ${own.sql}`, S.istToday(), S.istToday(), ...own.p); return { value: Number(x.n), sub: `${Number(x.late) || 0} late` }; }
  if (key === 'newLeads') { const x = await DB.one(`SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE "createdAt" >= ? AND ${own.sql}`, mFrom, ...own.p); return { value: Number(x.n), sub: 'added this month' }; }
  if (key === 'toCollect') { const x = await DB.one(`SELECT COALESCE(SUM("total" - COALESCE("creditAmount", 0) + COALESCE("debitAmount", 0) - "paidAmount" - COALESCE("tdsAmount", 0)), 0) AS "v", COUNT(*) AS "n" FROM "CrmInvoice" WHERE "status" IN ('Sent', 'Partly paid') AND ${own.sql}`, ...own.p); return { value: Number(x.v), money: true, sub: `${x.n} invoices` }; }
  return { value: 0 };
}
async function layoutOf(user) {
  const mine = await W.one('SELECT * FROM "CrmDashboardLayout" WHERE "userId" = ?', user.id);
  if (mine) return { widgets: W.parse(mine.widgetsJson, []), from: 'mine' };
  const team = await W.one('SELECT * FROM "CrmDashboardLayout" WHERE "userId" = \'team\'');
  if (team) return { widgets: W.parse(team.widgetsJson, []), from: 'team' };
  return { widgets: DEFAULT_WIDGETS, from: 'default' };
}
async function myDashboard(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const { widgets, from } = await layoutOf(user);
  const out = [];
  for (const w of widgets) {
    if (w.type === 'kpi') out.push({ ...w, title: KPIS[w.key], data: await kpi(user, w.key) }); // eslint-disable-line no-await-in-loop
    else {
      const res = await runSaved(user, w.reportId).catch(() => null); // eslint-disable-line no-await-in-loop
      if (res && res.status === 200) out.push({ ...w, title: res.body.report.name, data: { ...res.body, rows: res.body.rows.slice(0, 50), chart: w.chart || res.body.chart } });
      else out.push({ ...w, title: 'This report is not there any more', missing: true });
    }
  }
  return S.okBody({ widgets: out, from, kpis: Object.entries(KPIS).map(([key, label]) => ({ key, label })), canSetTeam: isManager(user) });
}
async function saveDashboard(user, body = {}) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const target = body.team === true ? 'team' : user.id;
  if (target === 'team' && !isManager(user)) return S.fail(403, 'Only a Sales manager or an Admin sets the team\'s dashboard.');
  if (body.reset === true) { await W.run('DELETE FROM "CrmDashboardLayout" WHERE "userId" = ?', target); return S.okBody({ ok: true }); }
  const widgets = cleanWidgets(body.widgets);
  for (const w of widgets) if (w.type === 'report' && !(await reportFor(user, w.reportId))) return S.fail(400, 'One of the reports is not yours or not shared.'); // eslint-disable-line no-await-in-loop
  if (target === 'team' && widgets.some((w) => w.type === 'report')) {
    const shared = await W.all(`SELECT "id" FROM "CrmReport" WHERE "shared" = 1 AND "id" IN (${widgets.filter((w) => w.type === 'report').map(() => '?').join(',')})`, ...widgets.filter((w) => w.type === 'report').map((w) => w.reportId));
    if (shared.length !== new Set(widgets.filter((w) => w.type === 'report').map((w) => w.reportId)).size) return S.fail(400, 'The team dashboard can only show reports that are shared with the team.');
  }
  await W.run('INSERT INTO "CrmDashboardLayout" ("userId", "widgetsJson", "updatedAt") VALUES (?, ?, ?) ON CONFLICT("userId") DO UPDATE SET "widgetsJson" = excluded."widgetsJson", "updatedAt" = excluded."updatedAt"', target, JSON.stringify(widgets), now());
  if (target === 'team') await S.audit(user, 'CRM team dashboard set', 'Crm', 'dashboard:team', `${widgets.length} widgets`);
  return S.okBody({ ok: true, widgets });
}

// ---- scheduled reports (10.08) ---------------------------------------------------------------------------------------------------
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// the next India time this schedule goes out, after `after` (ms)
function nextAt(sc, after = Date.now()) {
  const [hh, mm] = String(sc.time || '09:00').split(':').map(Number);
  for (let i = 0; i < 400; i += 1) {
    const day = new Date(after + OFF + i * 86400000);
    const y = day.getUTCFullYear(); const m = day.getUTCMonth(); const d = day.getUTCDate();
    const at = Date.UTC(y, m, d, hh, mm) - OFF;
    if (at <= after) continue;
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    if (sc.frequency === 'weekly' && dow !== Number(sc.day)) continue;
    if (sc.frequency === 'monthly') { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); if (d !== Math.min(Number(sc.day) || 1, last)) continue; }
    return new Date(at).toISOString();
  }
  return null;
}
const schOut = (x) => ({ id: x.id, reportId: x.reportId, name: x.name, frequency: x.frequency, day: x.day, time: x.time, recipients: W.parse(x.recipientsJson, []), on: !!x.on, ownerId: x.ownerId, ownerName: x.ownerName, lastSentAt: x.lastSentAt, lastResult: x.lastResult, nextAt: x.nextAt, words: `${x.frequency === 'daily' ? 'Every day' : x.frequency === 'weekly' ? `Every ${DOW[Number(x.day) || 0]}` : `On day ${x.day} of every month`} at ${x.time}` });
async function schedules(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const rows = isManager(user) ? await W.all('SELECT * FROM "CrmReportSchedule" ORDER BY "createdAt" DESC') : await W.all('SELECT * FROM "CrmReportSchedule" WHERE "ownerId" = ? ORDER BY "createdAt" DESC', user.id);
  const sw = await W.switches();
  return S.okBody({ on: sw.schedulesOn, schedules: rows.map(schOut), people: (await S.ownerOptions()).map((o) => ({ id: o.id, name: o.name })) });
}
async function teamIds() {
  const SETTINGS = require('./settings'); // eslint-disable-line global-require
  const st = await SETTINGS.load();
  const prisma = require('../db'); // eslint-disable-line global-require
  const admins = await prisma.user.findMany({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } }).catch(() => []);
  return new Set([...(st.salesTeam || []).map((m) => m.userId), ...admins.map((a) => a.id)]);
}
async function saveSchedule(user, id, body = {}) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  if (!(isManager(user) || S.can(user, 'reports'))) return S.fail(403, 'Your CRM rights do not allow scheduled reports.');
  const rep = await reportFor(user, body.reportId);
  if (!rep) return S.fail(400, 'Pick one of your reports (or a shared one).');
  const frequency = ['daily', 'weekly', 'monthly'].includes(body.frequency) ? body.frequency : null;
  if (!frequency) return S.fail(400, 'Daily, weekly or monthly?');
  const time = /^\d{2}:\d{2}$/.test(String(body.time || '')) ? body.time : '09:00';
  const day = frequency === 'weekly' ? Math.max(0, Math.min(6, Math.round(Number(body.day) || 1))) : (frequency === 'monthly' ? Math.max(1, Math.min(31, Math.round(Number(body.day) || 1))) : null);
  const team = await teamIds();
  const recipients = [...new Set((Array.isArray(body.recipients) ? body.recipients : []).map(String))].slice(0, 30);
  if (!recipients.length) return S.fail(400, 'Pick who gets it.');
  if (recipients.some((x) => !team.has(x))) return S.fail(400, 'A scheduled report goes only to people on the CRM team.');
  const t = now();
  const data = { reportId: rep.id, name: S.clip(body.name, 120) || rep.name, frequency, day, time, recipientsJson: JSON.stringify(recipients), on: body.on === false ? 0 : 1, updatedAt: t };
  data.nextAt = nextAt(data);
  let saved;
  if (id) {
    const prev = await W.one('SELECT * FROM "CrmReportSchedule" WHERE "id" = ?', String(id));
    if (!prev || (prev.ownerId !== user.id && !isManager(user))) return S.fail(404, 'This schedule is not there, or it is not yours.');
    saved = await W.update('CrmReportSchedule', prev.id, data);
  } else saved = await W.insert('CrmReportSchedule', { id: newId('sch'), ...data, ownerId: user.id, ownerName: user.name || null, createdAt: t });
  await S.audit(user, id ? 'CRM report schedule changed' : 'CRM report scheduled', 'CrmReportSchedule', saved.id, `${saved.name}: ${schOut(saved).words}, ${recipients.length} people`);
  return S.okBody({ ok: true, schedule: schOut(saved) });
}
async function removeSchedule(user, id) {
  const prev = await W.one('SELECT * FROM "CrmReportSchedule" WHERE "id" = ?', String(id || ''));
  if (!prev || (prev.ownerId !== user.id && !isManager(user))) return S.fail(404, 'This schedule is not there, or it is not yours.');
  await W.run('DELETE FROM "CrmReportSchedule" WHERE "id" = ?', prev.id);
  await S.audit(user, 'CRM report schedule removed', 'CrmReportSchedule', prev.id, prev.name);
  return S.okBody({ ok: true });
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function mailOf(title, out, words) {
  const head = out.columns.map((c) => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">${esc(c[1])}</th>`).join('');
  const body = out.rows.slice(0, 50).map((r) => `<tr>${out.columns.map((c) => `<td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(typeof r[c[0]] === 'number' ? r[c[0]].toLocaleString('en-IN') : r[c[0]])}</td>`).join('')}</tr>`).join('');
  const more = out.rows.length > 50 ? `<p>${out.rows.length - 50} more rows are in the Excel file.</p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:13px"><h2 style="font-size:16px">${esc(title)}</h2><p style="color:#555">${esc(words)} · ${out.grouped ? `total ${out.total}` : `${out.total} records`}</p><table style="border-collapse:collapse">${`<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`}</table>${more}<p style="color:#888;font-size:11px">TeamLink CRM scheduled report. Open TeamLink CRM > Dashboard > Reports to change it.</p></div>`;
  const text = [title, words, '', out.columns.map((c) => c[1]).join(' | '), ...out.rows.slice(0, 50).map((r) => out.columns.map((c) => (r[c[0]] == null ? '' : r[c[0]])).join(' | '))].join('\n');
  return { html, text };
}
// one schedule, sent now: the report read as its owner, one mail per recipient (`only` = just these user ids, e.g. the person pressing "Send me a copy")
async function sendSchedule(sc, { only } = {}) {
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  const prisma = require('../db'); // eslint-disable-line global-require
  const mailer = require('../utils/mailer'); // eslint-disable-line global-require
  const owner = await resolveIdentity(sc.ownerId).catch(() => null);
  if (!owner || !(await S.crmRoleFor(owner))) return { ok: false, result: 'The person who set it up is not on the CRM team any more.' };
  const out = await runSaved(owner, sc.reportId);
  if (out.status !== 200) return { ok: false, result: (out.body && out.body.error) || 'The report could not be read.' };
  const ids = only || W.parse(sc.recipientsJson, []);
  const team = await teamIds();
  const people = await prisma.user.findMany({ where: { id: { in: ids.filter((x) => team.has(x)) } }, select: { id: true, email: true, name: true } }).catch(() => []);
  const words = schOut(sc).words;
  const { html, text } = mailOf(out.body.report.name, out.body, words);
  const xlsx = xlsxOf(out.body.report.name, out.body);
  let sent = 0;
  for (const p of people) {
    if (!p.email) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await mailer.sendMail({ to: p.email, subject: `CRM report: ${out.body.report.name} (${S.istToday()})`, text, html, attachments: [{ filename: `${out.body.report.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.xlsx`, content: xlsx, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] }).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) sent += 1;
  }
  return { ok: sent > 0, result: `Sent to ${sent} of ${people.length}`, sent };
}
async function sendNow(user, id) {
  const sc = await W.one('SELECT * FROM "CrmReportSchedule" WHERE "id" = ?', String(id || ''));
  if (!sc || (sc.ownerId !== user.id && !isManager(user))) return S.fail(404, 'This schedule is not there, or it is not yours.');
  const r = await sendSchedule(sc, { only: [user.id] });
  return S.okBody({ ok: r.ok, message: r.ok ? 'A copy is on its way to your mail.' : r.result });
}
// the clock: schedules whose time came (only while the Admin switch is on)
async function runSchedules({ at = Date.now() } = {}) {
  const sw = await W.switches();
  if (!sw.schedulesOn) return 0;
  const due = await W.all('SELECT * FROM "CrmReportSchedule" WHERE "on" = 1 AND "nextAt" IS NOT NULL AND "nextAt" <= ? LIMIT 50', new Date(at).toISOString());
  let n = 0;
  for (const sc of due) {
    // claim it: the next time is written first, so a second server pass never sends it twice
    const claimed = await W.run('UPDATE "CrmReportSchedule" SET "nextAt" = ? WHERE "id" = ? AND "nextAt" = ?', nextAt(sc, Math.max(at, Date.parse(sc.nextAt)) + 60000), sc.id, sc.nextAt); // eslint-disable-line no-await-in-loop
    if (!Number(claimed)) continue;
    const r = await sendSchedule(sc).catch((e) => ({ ok: false, result: e.message })); // eslint-disable-line no-await-in-loop
    await W.update('CrmReportSchedule', sc.id, { lastSentAt: now(), lastResult: String(r.result || '').slice(0, 200) }); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  return n;
}

module.exports = { SOURCES, meta, preview, runSpec, cleanSpec, list, save, runSaved, remove, exportSaved, myDashboard, saveDashboard, schedules, saveSchedule, removeSchedule, sendNow, runSchedules, nextAt, KPIS };

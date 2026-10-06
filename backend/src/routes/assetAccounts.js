// ---------------------------------------------------------------------------
// ACCOUNTS — Fixed Assets (spec S2, 2026-10-05). Mounted by routes/journal.js
// at /api/accounts/fixed-assets. HRMS owns the assets and repairs; this
// router only reads them, posts journals (utils/assetPosting.js) and reports.
// There is no add / edit / delete of an asset or a repair here.
//
//   GET  /pending?all=1                 "Pending from HRMS" (purchase / repair / disposal)
//   POST /post {items:[{kind,id}], confirmClosed?}   Post to Journal (single / bulk)
//   GET  /depreciation/preview?from&to  Run Depreciation — the preview
//   POST /depreciation/run {from,to,confirmClosed?}
//   GET  /depreciation/runs
//   GET  /register?category&status&employee   assets with cost / acc dep / book value
//   GET  /:assetId/timeline              purchase, depreciation, repairs, disposal
//   GET  /summary?from&to&category&status&employee   Asset Summary per category
//   GET  /repair-cost?from&to&category&employee&vendor&status&threshold&format=
//   GET  /settings · PUT /settings {replaceThreshold}
// Access: accounts / Journal & Ledger — view to read, create to post.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can, DENIED } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const { LedgerError } = require('../utils/ledger');
const A = require('../utils/assetPosting');

const router = express.Router();
const FEATURE = 'Journal & Ledger';
const SETTINGS_KEY = 'accounts.assetSettings';
const r2 = A.r2;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

function guard(action) {
  return [requireAuth, async (req, res, next) => {
    try {
      if (await can(req.user, 'accounts', 'accounts', FEATURE, action)) return next();
      return res.status(403).json(DENIED);
    } catch (err) { return next(err); }
  }];
}
const actor = (req) => ({ id: req.user.id, name: req.user.name || req.user.email });
function failWith(res, err) {
  if (err instanceof LedgerError || (err && err.status && err.message)) return res.status(err.status).json({ error: err.message });
  throw err;
}
function sendTable(res, format, filename, headers, rows, sheet) {
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(toXlsx(headers, rows, sheet));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return res.send(toCsv(headers, rows));
}

async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) || {} : {}; } catch { v = {}; }
  return { replaceThreshold: Number(v.replaceThreshold) > 0 ? Number(v.replaceThreshold) : 50 };
}

// Cascading filter options (agent-rules FILTER RULE): each field's options
// are counted over the rows matching every OTHER active filter.
function facets(rows, fields, values) {
  const out = {};
  Object.entries(fields).forEach(([key, get]) => {
    const others = rows.filter((r) => Object.entries(fields).every(([k, g]) => k === key || !values[k] || [].concat(g(r)).map(String).includes(String(values[k]))));
    const counts = new Map();
    others.forEach((r) => [].concat(get(r)).filter((v) => v != null && v !== '').forEach((v) => counts.set(String(v), (counts.get(String(v)) || 0) + 1)));
    out[key] = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, label: value, count }));
  });
  return out;
}
const applyFilters = (rows, fields, values) => rows.filter((r) => Object.entries(fields).every(([k, g]) => !values[k] || [].concat(g(r)).map(String).includes(String(values[k]))));

// ---- Pending from HRMS + Post to Journal ---------------------------------------------
router.get('/pending', ...guard('view'), async (req, res) => {
  const rows = await A.pendingList({ includePosted: req.query.all === '1' });
  const counts = {};
  rows.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });
  res.json({ rows, counts, canPost: await can(req.user, 'accounts', 'accounts', FEATURE, 'create') });
});

router.post('/post', ...guard('create'), async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 500) : [];
  if (!items.length) return res.status(400).json({ error: 'Pick what to post.' });
  const results = [];
  for (const it of items) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await A.postItem({ kind: String(it.kind), id: String(it.id) }, actor(req), { confirmClosed: !!req.body.confirmClosed });
      results.push({ ...it, ok: true, status: r.status, journalEntryId: r.entry && r.entry.id });
    } catch (err) {
      if (!(err instanceof LedgerError) && !(err && err.status)) throw err;
      results.push({ ...it, ok: false, code: err.status, error: err.message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const closed = results.find((r) => r.code === 409 && /closed/.test(r.error || ''));
  return res.status(ok ? (ok === results.length ? 200 : 207) : (closed ? 409 : 422)).json({ ok, failed: results.length - ok, results, closedWarning: closed ? closed.error : null });
});

// ---- Depreciation -------------------------------------------------------------------------
router.get('/depreciation/preview', ...guard('view'), async (req, res) => {
  try { return res.json(await A.depreciationPreview(String(req.query.from || ''), String(req.query.to || ''))); } catch (err) { return failWith(res, err); }
});
router.post('/depreciation/run', ...guard('create'), async (req, res) => {
  const b = req.body || {};
  try {
    const r = await A.runDepreciation(String(b.from || ''), String(b.to || ''), actor(req), { confirmClosed: !!b.confirmClosed });
    return res.status(r.replay ? 200 : 201).json({ entry: r.entry, total: r.preview.total, assets: r.preview.rows.length });
  } catch (err) { return failWith(res, err); }
});
router.get('/depreciation/runs', ...guard('view'), async (req, res) => res.json(await A.depRuns()));

// ---- The register (per asset, from HRMS + the books) ---------------------------------------
const FIELDS = {
  category: (r) => r.category,
  status: (r) => r.status,
  employee: (r) => r.holder || 'Not assigned',
};

async function registerRows({ upTo = null } = {}) {
  const assets = await A.loadAssets();
  const figs = await A.bookFigures(assets.map((a) => a.id), { upTo });
  // "In the books" = its purchase was posted (a sold asset is still one).
  const posted = await A.bookFigures(assets.map((a) => a.id), { upTo, excludeDisposal: true });
  return assets.map((a) => {
    const f = figs.get(a.id) || { gross: 0, accDep: 0, bookValue: 0 };
    const inBooks = (posted.get(a.id) || { gross: 0 }).gross > 0;
    return {
      id: a.id, assetCode: a.assetCode, name: a.name, category: a.category, status: a.status, holder: a.assignedTo ? a.assignedTo.name : null,
      holderCode: a.assignedTo ? a.assignedTo.employeeCode : null, location: a.location || null,
      purchaseDate: a.purchaseDate, purchaseCost: a.purchaseCost, gstPaid: a.gstPaid ?? null, vendor: a.vendor ?? null, invoiceNo: a.invoiceNo ?? null,
      ...A.depRules(a), inBooks, cost: f.gross, accumulatedDepreciation: f.accDep, bookValue: f.bookValue,
    };
  });
}

router.get('/register', ...guard('view'), async (req, res) => {
  const values = { category: req.query.category || '', status: req.query.status || '', employee: req.query.employee || '' };
  const all = await registerRows();
  const rows = applyFilters(all, FIELDS, values);
  const sum = (k) => r2(rows.reduce((n, r) => n + (Number(r[k]) || 0), 0));
  res.json({ rows, facets: facets(all, FIELDS, values), totals: { count: rows.length, purchaseCost: sum('purchaseCost'), cost: sum('cost'), accumulatedDepreciation: sum('accumulatedDepreciation'), bookValue: sum('bookValue') } });
});

// ---- One asset's timeline ---------------------------------------------------------------------
router.get('/:assetId/timeline', ...guard('view'), async (req, res) => {
  const [a] = await A.loadAssets({ id: req.params.assetId });
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  const lines = await prisma.journalLine.findMany({
    where: { referenceId: a.id, referenceType: { startsWith: 'ASSET' } },
    include: { journalEntry: { select: { id: true, date: true, narration: true, idempotencyKey: true, referenceType: true } } },
  });
  const byEntry = new Map();
  lines.forEach((l) => {
    const e = byEntry.get(l.journalEntryId) || { journalEntryId: l.journalEntryId, date: l.journalEntry.date, narration: l.journalEntry.narration, reversal: l.journalEntry.referenceType === 'REVERSAL', kind: l.referenceType, lines: [] };
    e.lines.push({ accountCode: l.accountCode, accountName: l.accountName, debit: l.debit, credit: l.credit });
    byEntry.set(l.journalEntryId, e);
  });
  const kindOf = { ASSET_PURCHASE: 'purchase', ASSET_DEPRECIATION: 'depreciation', ASSET_REPAIR: 'repair', ASSET_DISPOSAL: 'disposal' };
  const events = [...byEntry.values()].map((e) => ({
    ...e, kind: kindOf[e.kind] || 'other',
    amount: r2(e.lines.reduce((n, l) => n + l.debit, 0)),
  }));
  const repairs = await A.loadRepairs([a]);
  const postedRepairIds = new Set();
  for (const rep of repairs) {
    // eslint-disable-next-line no-await-in-loop
    const b = await A.bookingsOf(rep.legacy ? `asset-repair-legacy:${rep.legacyEntryId}` : `asset-repair:${rep.id}`);
    if (b.current) postedRepairIds.add(rep.id);
  }
  repairs.filter((r) => !postedRepairIds.has(r.id)).forEach((r) => events.push({
    kind: 'repair', date: r.repairDate || r.dateReported, narration: `${r.repairNo} · ${r.issue || r.repairType || 'Repair'}${r.vendor ? ` · ${r.vendor}` : ''} — ${r.underWarranty && !r.cost ? 'covered by warranty' : r.status === 'Completed' ? 'not posted yet' : r.status}`,
    amount: r2(Number(r.cost) + Number(r.gstPaid || 0)), hrmsOnly: true, lines: [],
  }));
  events.sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
  const f = (await A.bookFigures([a.id])).get(a.id) || { gross: 0, accDep: 0, bookValue: 0 };
  return res.json({
    asset: { id: a.id, assetCode: a.assetCode, name: a.name, category: a.category, status: a.status, holder: a.assignedTo ? a.assignedTo.name : null, purchaseDate: a.purchaseDate, purchaseCost: a.purchaseCost, ...A.depRules(a) },
    book: f, events,
  });
});

// ---- Asset Summary per category ----------------------------------------------------------------
router.get('/summary', ...guard('view'), async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  if (from && to && from > to) return res.status(400).json({ error: '"From" is after "To"' });
  const values = { category: req.query.category || '', status: req.query.status || '', employee: req.query.employee || '' };
  const all = await registerRows();
  const rows = applyFilters(all, FIELDS, values);
  const ids = rows.map((r) => r.id);
  const catOf = new Map(rows.map((r) => [r.id, r.category]));
  const lines = ids.length ? await prisma.journalLine.findMany({
    where: { referenceId: { in: ids }, referenceType: { startsWith: 'ASSET' }, ...(to ? { journalEntry: { date: { lte: to } } } : {}) },
    include: { journalEntry: { select: { date: true } } },
  }) : [];
  const cats = new Map();
  const row = (c) => { if (!cats.has(c)) cats.set(c, { category: c, assets: 0, notInBooks: 0, opening: 0, additions: 0, depreciation: 0, disposals: 0, closing: 0, repairCost: 0 }); return cats.get(c); };
  rows.forEach((r) => { const x = row(r.category); x.assets += 1; if (!r.inBooks && Number(r.purchaseCost) > 0) x.notInBooks += 1; });
  lines.forEach((l) => {
    const x = row(catOf.get(l.referenceId));
    const before = from && l.journalEntry.date < from;
    const fa = /^15/.test(l.accountCode); const dep = /^16/.test(l.accountCode); const rm = /^54/.test(l.accountCode);
    if (before) {
      if (fa) x.opening += l.debit - l.credit;
      if (dep) x.opening -= l.credit - l.debit;
      return;
    }
    if (fa && (l.referenceType === 'ASSET_PURCHASE' || l.referenceType === 'ASSET_REPAIR')) x.additions += l.debit - l.credit;
    if (dep && l.referenceType === 'ASSET_DEPRECIATION') x.depreciation += l.credit - l.debit;
    if (l.referenceType === 'ASSET_DISPOSAL') { if (fa) x.disposals += l.credit - l.debit; if (dep) x.disposals -= l.debit - l.credit; }
    if (l.referenceType === 'ASSET_REPAIR' && (rm || fa)) x.repairCost += l.debit - l.credit;
  });
  const out = [...cats.values()].map((x) => {
    const o = { ...x };
    ['opening', 'additions', 'depreciation', 'disposals', 'repairCost'].forEach((k) => { o[k] = r2(o[k]); });
    o.closing = r2(o.opening + o.additions - o.depreciation - o.disposals);
    return o;
  }).sort((a, b) => a.category.localeCompare(b.category));
  const totals = {};
  ['assets', 'notInBooks', 'opening', 'additions', 'depreciation', 'disposals', 'closing', 'repairCost'].forEach((k) => { totals[k] = r2(out.reduce((n, r) => n + r[k], 0)); });
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    const t = out.map((r) => [r.category, r.assets, r.opening, r.additions, r.depreciation, r.disposals, r.closing, r.repairCost, r.notInBooks]);
    t.push(['TOTAL', totals.assets, totals.opening, totals.additions, totals.depreciation, totals.disposals, totals.closing, totals.repairCost, totals.notInBooks]);
    return sendTable(res, req.query.format, `asset-summary-${from || 'start'}-${to || 'today'}`, ['Category', 'Assets', 'Opening', 'Additions', 'Depreciation', 'Disposals', 'Closing book value', 'Total repair cost', 'Not in the books yet'], t, 'Asset Summary');
  }
  return res.json({ from, to, rows: out, totals, facets: facets(all, FIELDS, values) });
});

// ---- Asset Repair Cost (from the HRMS repair data, posted or not) ---------------------------------
router.get('/repair-cost', ...guard('view'), async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  if (from && to && from > to) return res.status(400).json({ error: '"From" is after "To"' });
  const settings = await getSettings();
  const threshold = Number(req.query.threshold) > 0 ? Number(req.query.threshold) : settings.replaceThreshold;
  const assets = await A.loadAssets();
  const repairs = (await A.loadRepairs(assets)).filter((r) => r.status !== 'Cancelled');
  const inWindow = (r) => { const d = r.repairDate || r.dateReported; return (!from || (d && d >= from)) && (!to || (d && d <= to)); };
  const values = { category: req.query.category || '', status: req.query.status || '', employee: req.query.employee || '', vendor: req.query.vendor || '' };
  const byAsset = new Map();
  repairs.filter(inWindow).forEach((r) => { if (!byAsset.has(r.assetId)) byAsset.set(r.assetId, []); byAsset.get(r.assetId).push(r); });
  const base = assets.filter((a) => byAsset.has(a.id)).map((a) => {
    const reps = byAsset.get(a.id);
    const total = r2(reps.reduce((n, r) => n + (Number(r.cost) || 0), 0));
    const pc = Number(a.purchaseCost) || 0;
    const pct = pc > 0 ? r2((total / pc) * 100) : null;
    const last = reps.map((r) => r.repairDate || r.dateReported).filter(Boolean).sort().pop() || null;
    return {
      assetId: a.id, assetCode: a.assetCode, name: a.name, category: a.category, status: a.status, holder: a.assignedTo ? a.assignedTo.name : null,
      vendors: [...new Set(reps.map((r) => r.vendor).filter(Boolean))], repairs: reps.length, totalRepairCost: total, purchaseCost: pc || null,
      repairPct: pct, lastRepairDate: last, considerReplacing: pct != null && pct >= threshold,
      warrantyRepairs: reps.filter((r) => r.underWarranty).length,
    };
  });
  const F = { category: (r) => r.category, status: (r) => r.status, employee: (r) => r.holder || 'Not assigned', vendor: (r) => r.vendors };
  const rows = applyFilters(base, F, values).sort((a, b) => b.totalRepairCost - a.totalRepairCost);
  const cats = new Map();
  rows.forEach((r) => {
    const c = cats.get(r.category) || { category: r.category, assets: 0, repairs: 0, totalRepairCost: 0, purchaseCost: 0 };
    c.assets += 1; c.repairs += r.repairs; c.totalRepairCost = r2(c.totalRepairCost + r.totalRepairCost); c.purchaseCost = r2(c.purchaseCost + (r.purchaseCost || 0));
    cats.set(r.category, c);
  });
  const byCategory = [...cats.values()].map((c) => ({ ...c, repairPct: c.purchaseCost ? r2((c.totalRepairCost / c.purchaseCost) * 100) : null }));
  const totals = { assets: rows.length, repairs: rows.reduce((n, r) => n + r.repairs, 0), totalRepairCost: r2(rows.reduce((n, r) => n + r.totalRepairCost, 0)), purchaseCost: r2(rows.reduce((n, r) => n + (r.purchaseCost || 0), 0)), considerReplacing: rows.filter((r) => r.considerReplacing).length };
  totals.repairPct = totals.purchaseCost ? r2((totals.totalRepairCost / totals.purchaseCost) * 100) : null;
  if (req.query.format === 'csv' || req.query.format === 'xlsx') {
    const t = rows.map((r) => [r.assetCode, r.name, r.category, r.holder || '', r.repairs, r.totalRepairCost, r.purchaseCost || '', r.repairPct == null ? '' : r.repairPct, r.lastRepairDate || '', r.considerReplacing ? 'Consider replacing' : '']);
    byCategory.forEach((c) => t.push(['', `Total — ${c.category}`, c.category, '', c.repairs, c.totalRepairCost, c.purchaseCost, c.repairPct == null ? '' : c.repairPct, '', '']));
    t.push(['', 'TOTAL', '', '', totals.repairs, totals.totalRepairCost, totals.purchaseCost, totals.repairPct == null ? '' : totals.repairPct, '', `${totals.considerReplacing} to consider replacing`]);
    await logAudit({ userId: req.user.id, action: `Asset repair cost exported (${req.query.format.toUpperCase()})`, entity: 'Asset', toValue: `${rows.length} asset(s)` });
    return sendTable(res, req.query.format, `asset-repair-cost-${from || 'start'}-${to || 'today'}`, ['Asset ID', 'Name', 'Category', 'Assigned To', 'No. of Repairs', 'Total Repair Cost', 'Purchase Cost', 'Repair % of Purchase', 'Last Repair Date', 'Flag'], t, 'Repair Cost');
  }
  return res.json({ from, to, threshold, rows, byCategory, totals, facets: facets(base, F, values) });
});

router.get('/settings', ...guard('view'), async (req, res) => res.json(await getSettings()));
router.put('/settings', ...guard('edit'), async (req, res) => {
  const t = Number(req.body && req.body.replaceThreshold);
  if (!(t > 0 && t <= 1000)) return res.status(400).json({ error: 'The threshold is a % between 1 and 1000.' });
  const before = await getSettings();
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify({ replaceThreshold: t }), updatedById: req.user.id, updatedByName: req.user.name },
    create: { key: SETTINGS_KEY, value: JSON.stringify({ replaceThreshold: t }), updatedById: req.user.id, updatedByName: req.user.name },
  });
  await logAudit({ userId: req.user.id, action: 'Asset "consider replacing" threshold changed', entity: 'AppSetting', entityId: SETTINGS_KEY, fromValue: `${before.replaceThreshold}%`, toValue: `${t}%` });
  return res.json({ replaceThreshold: t });
});

module.exports = router;

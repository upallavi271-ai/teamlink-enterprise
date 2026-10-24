// ---------------------------------------------------------------------------
// ADMIN: "ASSETS THIS VENDOR CAN SEE" (2026-10-19) - mounted inside routes/vendorLogins.js, so it inherits requireAuth and the
// "only Admin (or a login that manages users)" guard.   /api/vendor-logins/asset-grants/*
//
//   GET  /:vendorId            the picture for one vendor: how many HRMS assets it will see, WHY each one (bought from it / repaired by it /
//                              linked to it / chosen by Admin), the saved ticks, the categories with counts, and the names that could NOT be
//                              matched safely (ambiguous / possible) for Admin to decide
//   POST /:vendorId/preview    { assetIds, categories } -> the same count for ticks that are not saved yet ("This vendor will see N assets")
//   GET  /:vendorId/search     ?q=  type-to-search over the HRMS asset list (code, name, category, serial number, seat)
//   PUT  /:vendorId            { assetIds, categories } the new full set of Admin's ticks. Adds and removes are audited one by one.
//   PUT  /:vendorId/hide       { assetIds, categories } what Admin HIDES from the AUTOMATIC rule for this vendor (a category or one asset).
//   GET  /category-map         the automatic map: vendor category -> asset categories (defaults + Admin's changes), the asset categories that exist
//   PUT  /category-map         { map: { it_service: ['Laptop', ...] } } Admin changes the map. Audited. Takes effect on the vendor's next request.
//   (the automatic rule itself - utils/assetHrmsScope.js - needs no step at all: a new asset in a mapped category is visible at once)
//
// The assets are the company's own HRMS rows (table Asset): nothing is copied or created here, and no employee detail is returned.
// Removing a tick removes it from the vendor's portal on its next request (nothing is cached).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const DB = require('../utils/vmDb');
const SCH = require('../utils/assetVendorSchema');
const HS = require('../utils/assetHrmsScope');
const VP = require('../utils/vendorPortal');
const VA = require('../utils/vendorAuth');
const CFG = require('../config/vendorModules');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const actorOf = (req) => req.user.name || req.user.email || 'Admin';
const roleOf = (req) => (['SUPER_ADMIN', 'ADMIN'].includes(req.user.role) ? 'Admin' : 'Accounts');
const adminEvent = (req, row) => VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: roleOf(req), ...row });
const nowIso = () => new Date().toISOString();

async function vendorOf(req, res) {
  const vendor = await prisma.officeVendor.findUnique({ where: { id: str(req.params.vendorId) }, select: { id: true, name: true, category: true, isActive: true } });
  if (!vendor) { res.status(404).json({ error: 'Vendor not found.' }); return null; }
  return vendor;
}

// category -> how many live (not archived) HRMS assets, for the checklist.
async function categoryCounts() {
  const rows = await prisma.asset.groupBy({ by: ['category'], where: { NOT: { status: { in: VA.ARCHIVED } } }, _count: { _all: true } });
  return rows.filter((r) => r.category).map((r) => ({ value: r.category, count: r._count._all })).sort((a, b) => a.value.localeCompare(b.value));
}

const slim = (p, take = 400) => ({
  total: p.total, byReason: p.byReason, available: p.available, underRepair: p.underRepair, repairJobs: p.repairJobs, hiddenHeld: p.hiddenHeld,
  rows: p.rows.slice(0, take).map((r) => ({ assetId: r.id, assetCode: r.assetCode, name: r.name, category: r.category, status: r.status, reasons: r.reasons, reasonText: r.reasonText })),
  shown: Math.min(take, p.total),
});

const isAdmin = (req) => ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role);
// The automatic map. Registered BEFORE '/:vendorId' so "category-map" is never read as a vendor id.
router.get('/category-map', wrap(async (req, res) => {
  const [m, real, conflicts] = await Promise.all([HS.autoMap(), categoryCounts(), HS.autoConflicts()]);
  res.json({
    map: m.map, custom: m.custom, defaults: HS.AUTO_DEFAULTS, vendorCategories: Object.entries(CFG.CATEGORIES).map(([key, c]) => ({ key, label: c.label })),
    assetCategories: real, conflicts, canEdit: isAdmin(req),
  });
}));
router.put('/category-map', wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only Admin can change which asset categories a vendor kind handles.' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const given = b.map && typeof b.map === 'object' && !Array.isArray(b.map) ? b.map : null;
  if (!given) return res.status(400).json({ error: 'Send the map.' });
  const bad = Object.keys(given).filter((k) => !CFG.CATEGORIES[k] || !Array.isArray(given[k]));
  if (bad.length) return res.status(400).json({ error: `Unknown vendor category: ${bad.join(', ')}.` });
  const before = await HS.autoMap();
  const saved = await HS.saveAutoMap(given, req.user);
  await logAudit({
    userId: req.user.id, actorName: actorOf(req), action: 'Vendor asset category map changed', entity: 'AppSetting', entityId: HS.MAP_SETTING,
    fromValue: JSON.stringify(before.map).slice(0, 900), toValue: JSON.stringify(saved).slice(0, 900),
  });
  const m = await HS.autoMap();
  res.json({ ok: true, message: 'Saved. It applies on each vendor\'s next page load.', map: m.map, custom: m.custom });
}));

router.get('/:vendorId', wrap(async (req, res) => {
  const vendor = await vendorOf(req, res); if (!vendor) return;
  const [p, cats, auto, conflicts] = await Promise.all([HS.preview({ vendorId: vendor.id }), categoryCounts(), HS.autoInfo(vendor.id), HS.autoConflicts()]);
  const granted = new Set(p.grants.categories);
  res.json({
    vendor, ...slim(p), reasonLabels: HS.REASON_TEXT, auto, autoConflicts: conflicts,
    grants: { assetIds: p.grants.assetIds, categories: p.grants.categories },
    categories: cats.map((c) => ({ ...c, granted: granted.has(c.value) })),
    ambiguous: p.ambiguous.slice(0, 200), possible: p.possible.slice(0, 200),
  });
}));

// The picked ids / categories from a body, checked against the real HRMS list (an unknown id is refused, never stored).
async function readTicks(body) {
  const b = body && typeof body === 'object' ? body : {};
  const assetIds = [...new Set((Array.isArray(b.assetIds) ? b.assetIds : []).map(str).filter(Boolean))];
  const cats = [...new Set((Array.isArray(b.categories) ? b.categories : []).map(str).filter(Boolean))];
  if (assetIds.length > 3000 || cats.length > 200) return { error: 'That is too many to tick at once.' };
  const found = assetIds.length ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true } }) : [];
  if (found.length !== assetIds.length) return { error: 'One of the ticked assets is not in the asset list any more. Open the list again.' };
  const real = new Map((await categoryCounts()).map((c) => [c.value.toLowerCase(), c.value]));
  const categories = [];
  for (const c of cats) {
    const canon = real.get(c.toLowerCase());
    if (!canon) return { error: `"${c}" is not an asset category.` };
    if (!categories.includes(canon)) categories.push(canon);
  }
  return { assetIds, categories };
}

router.post('/:vendorId/preview', wrap(async (req, res) => {
  const vendor = await vendorOf(req, res); if (!vendor) return;
  const t = await readTicks(req.body);
  if (t.error) return res.status(400).json({ error: t.error });
  const p = await HS.preview({ vendorId: vendor.id }, { assetIds: t.assetIds, categories: t.categories });
  return res.json(slim(p, 100));
}));

router.get('/:vendorId/search', wrap(async (req, res) => {
  const vendor = await vendorOf(req, res); if (!vendor) return;
  const q = VP.cleanText(req.query.q, 60);
  const and = [{ NOT: { status: { in: VA.ARCHIVED } } }];
  if (q) {
    and.push({ OR: [{ assetCode: { contains: q } }, { name: { contains: q } }, { category: { contains: q } }, { assetType: { contains: q } }, { serialNumber: { contains: q } }, { location: { contains: q } }] });
  }
  const rows = await prisma.asset.findMany({
    where: { AND: and }, orderBy: { assetCode: 'asc' }, take: 40,
    select: { id: true, assetCode: true, name: true, category: true, status: true, location: true, vendorId: true, assetType: true },
  });
  const [matches, sc] = await Promise.all([prisma.asset.count({ where: { AND: and } }), HS.scope({ vendorId: vendor.id })]);
  const names = new Map((await prisma.officeVendor.findMany({ select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  const granted = new Set(sc.grants.assetIds);
  const cats = new Set(sc.categories);
  res.json({
    total: matches,
    rows: rows.map((a) => {
      const why = HS.reasonSet(sc, a);
      return {
        assetId: a.id, assetCode: a.assetCode, name: a.name, category: a.category, status: a.status, location: a.location, type: HS.parseType(a.assetType).descriptor,
        ticked: granted.has(a.id), inCategory: cats.has(a.category), hidden: sc.auto.excludedAssetIds.includes(a.id), reasonText: [...why].map((x) => HS.REASON_TEXT[x]),
        linkedTo: a.vendorId && a.vendorId !== vendor.id ? names.get(a.vendorId) || 'another vendor' : null,
      };
    }),
  });
}));

// What Admin hides from the AUTOMATIC rule for this vendor: whole categories and single assets. The full new set is sent each time.
router.put('/:vendorId/hide', wrap(async (req, res) => {
  const vendor = await vendorOf(req, res); if (!vendor) return;
  const t = await readTicks(req.body);
  if (t.error) return res.status(400).json({ error: t.error });
  await SCH.ensure();
  const cur = await HS.excludeRows(vendor.id);
  const have = new Map(cur.map((g) => [g.grantKey, g]));
  const want = new Map();
  t.assetIds.forEach((id) => want.set(HS.xAssetKey(id), { kind: 'exclude_asset', assetId: id, category: null }));
  t.categories.forEach((c) => want.set(HS.xCatKey(c), { kind: 'exclude_category', assetId: null, category: c }));
  const removed = [...have.values()].filter((g) => !want.has(g.grantKey));
  const added = [...want.entries()].filter(([k]) => !have.has(k));
  const before = (await HS.preview({ vendorId: vendor.id })).total;
  await prisma.$transaction(async (tx) => {
    for (const g of removed) await DB.run('DELETE FROM "VendorAssetGrant" WHERE "id" = ?', [g.id], tx); // eslint-disable-line no-await-in-loop
    for (const [k, g] of added) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT OR IGNORE INTO "VendorAssetGrant" ("id","vendorId","kind","assetId","category","grantKey","grantedById","grantedByName","grantedAt") VALUES (?,?,?,?,?,?,?,?,?)',
        [HS.newGrantId(), vendor.id, g.kind, g.assetId, g.category, k, req.user.id, actorOf(req), nowIso()], tx);
    }
  }, { timeout: 20000 });
  const after = await HS.preview({ vendorId: vendor.id });
  if (removed.length || added.length) {
    for (const g of added) {
      // eslint-disable-next-line no-await-in-loop
      await adminEvent(req, { vendorId: vendor.id, assetId: g[1].assetId || null, action: 'Asset hidden from automatic access', field: g[1].kind === 'exclude_asset' ? 'asset' : 'category', oldValue: '', newValue: g[1].assetId || g[1].category });
    }
    await logAudit({
      userId: req.user.id, actorName: actorOf(req), action: 'Vendor automatic asset access changed', entity: 'OfficeVendor', entityId: vendor.id,
      fromValue: `${vendor.name} saw ${before} asset(s)`, toValue: `hidden +${added.length} / -${removed.length} · now sees ${after.total} asset(s)`,
    });
  }
  res.json({ ok: true, changed: added.length + removed.length, message: added.length + removed.length ? `Saved. ${vendor.name} will see ${after.total} asset${after.total === 1 ? '' : 's'}.` : 'Nothing changed.', ...slim(after), auto: await HS.autoInfo(vendor.id) });
}));

router.put('/:vendorId', wrap(async (req, res) => {
  const vendor = await vendorOf(req, res); if (!vendor) return;
  const t = await readTicks(req.body);
  if (t.error) return res.status(400).json({ error: t.error });
  await SCH.ensure();
  const cur = await HS.grantRows(vendor.id);
  const have = new Map(cur.map((g) => [g.grantKey, g]));
  const want = new Map();
  t.assetIds.forEach((id) => want.set(HS.assetKey(id), { kind: 'asset', assetId: id, category: null }));
  t.categories.forEach((c) => want.set(HS.catKey(c), { kind: 'category', assetId: null, category: c }));
  const removed = [...have.values()].filter((g) => !want.has(g.grantKey));
  const added = [...want.entries()].filter(([k]) => !have.has(k));
  const before = (await HS.preview({ vendorId: vendor.id })).total;
  await prisma.$transaction(async (tx) => {
    for (const g of removed) await DB.run('DELETE FROM "VendorAssetGrant" WHERE "id" = ?', [g.id], tx); // eslint-disable-line no-await-in-loop
    for (const [k, g] of added) { // eslint-disable-line no-restricted-syntax
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT OR IGNORE INTO "VendorAssetGrant" ("id","vendorId","kind","assetId","category","grantKey","grantedById","grantedByName","grantedAt") VALUES (?,?,?,?,?,?,?,?,?)',
        [HS.newGrantId(), vendor.id, g.kind, g.assetId, g.category, k, req.user.id, actorOf(req), nowIso()], tx);
    }
  }, { timeout: 20000 });
  const after = await HS.preview({ vendorId: vendor.id });
  if (removed.length || added.length) {
    const codes = new Map((await prisma.asset.findMany({ where: { id: { in: [...removed.map((g) => g.assetId), ...added.map(([, g]) => g.assetId)].filter(Boolean) } }, select: { id: true, assetCode: true } })).map((a) => [a.id, a.assetCode]));
    for (const g of removed) {
      // eslint-disable-next-line no-await-in-loop
      await adminEvent(req, { vendorId: vendor.id, assetId: g.assetId || null, action: 'Asset access removed', field: g.kind === 'asset' ? 'asset' : 'category', oldValue: g.kind === 'asset' ? (codes.get(g.assetId) || g.assetId) : g.category, newValue: '' });
    }
    for (const [, g] of added) {
      // eslint-disable-next-line no-await-in-loop
      await adminEvent(req, { vendorId: vendor.id, assetId: g.assetId || null, action: 'Asset access granted', field: g.kind === 'asset' ? 'asset' : 'category', oldValue: '', newValue: g.kind === 'asset' ? (codes.get(g.assetId) || g.assetId) : g.category });
    }
    await logAudit({
      userId: req.user.id, actorName: actorOf(req), action: 'Vendor asset access changed', entity: 'OfficeVendor', entityId: vendor.id,
      fromValue: `${vendor.name} saw ${before} asset(s)`, toValue: `+${added.length} / -${removed.length} ticks · now sees ${after.total} asset(s)`,
    });
  }
  res.json({
    ok: true, changed: added.length + removed.length,
    message: added.length + removed.length ? `Saved. ${vendor.name} will see ${after.total} asset${after.total === 1 ? '' : 's'}.` : 'Nothing changed.',
    ...slim(after), grants: after.grants,
  });
}));

module.exports = router;

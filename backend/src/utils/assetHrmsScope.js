// ---------------------------------------------------------------------------
// WHICH HRMS ASSETS BELONG TO WHICH ASSET VENDOR (2026-10-19) - the ONE place that decides.
//
// The company's assets live in HRMS (table Asset, repairs in AssetRepair). The Assets Vendor Portal never keeps its own copy: it reads those
// same rows by their own id. This file only answers "which of those rows may THIS vendor see?". An asset belongs to a vendor when ANY of:
//
//   linked      Asset.vendorId = this vendor (the real link to the vendor master)
//   supplier    the asset's free-text vendor ("Who sold it") names this vendor - same name after a CAREFUL clean-up (case, spaces, punctuation,
//               "Pvt / Ltd / LLP ..."); or a bill Accounts booked against this vendor carries the asset's invoice number
//   repaired    an AssetRepair of the asset names this vendor the same careful way (or the vendor's own repair link)
//   admin       Admin ticked the asset, or a whole category, for this vendor (table VendorAssetGrant)
//   auto        (2026-10-19, NO manual step) the asset's CATEGORY is one this vendor's own master category handles. The vendor master category
//               ("IT / Hardware / AMC / Service") is mapped to asset categories (Laptop, Mouse, ... see AUTO_DEFAULTS; Admin can edit the map,
//               AppSetting "vendor.assetCategoryMap"). Read live on every request: a NEW asset row in such a category (added in HRMS, by the
//               Accounts import, anywhere) is visible on the vendor's very next request - nothing is copied, imported or scheduled.
//               Safety: an asset linked to ANOTHER vendor (Asset.vendorId, or its "bought from" name) stays theirs; when TWO live vendors
//               share the same category the asset goes to NEITHER automatically (listed for Admin: autoConflicts); Admin can hide a
//               category or one asset from the automatic rule (table VendorAssetGrant, kind exclude_category / exclude_asset); archived
//               assets are never shown; a SIM Card is not in any hardware map (telecom vendors read SIMs in their own portal).
//
// NO GUESSING: a name that fits two vendors (or a vendor name that two vendors share after the clean-up) is NOT given to anybody. A name that
// only PARTLY fits ("Sai Laptop" / "Sai Laptop Care") is NOT given either. Both are listed for Admin (ambiguous / possible) to decide: Admin
// links the asset to the right vendor, or grants it. An asset with Asset.vendorId = ANOTHER vendor is never given by its text.
// Archived assets (Retired / Sold / Written off) are never shown.
//
// Everything is read fresh on every call (no cache): a removed grant, a changed vendor name or a re-linked asset applies on the next request.
// Nothing here writes to HRMS, and nothing creates an asset.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./assetVendorSchema');
const VA = require('./vendorAuth');
const CFG = require('../config/vendorModules');

// ---- the careful name clean-up -----------------------------------------------------------------------------------
const SUFFIX_WORDS = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'the']);
// "Sai  Laptop Care Pvt. Ltd." -> "sai laptop care". '' when nothing meaningful is left (then it never matches anything).
function nameKey(s) {
  const t = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return '';
  const words = t.split(' ').filter((w) => w && !SUFFIX_WORDS.has(w));
  const key = words.join(' ');
  return key.replace(/ /g, '').length >= 3 ? key : '';
}
const refKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- the seat code -> department rule (copied from routes/assetInventory.js deptOfSeat; the test compares the two) ----
const SEAT_DEPARTMENTS = { BDE: 'BDE', MED: 'Medical', MFG: 'Manufacturing', EDU: 'Education', HR: 'HR', 'R&D': 'R&D', IHR: 'Internal HR', INTERNAL: 'Internal HR' };
const deptOfSeat = (code) => SEAT_DEPARTMENTS[String(code || '').trim().toUpperCase().split(/[\s-]+/)[0]] || null;

// ---- brand / model / serial that HRMS already holds, inside Asset.assetType --------------------------------------
// The HRMS import wrote the finer type as "JABRA HSC027 · SN 00118040642W26K · Tag TL-H-HR" (or "Airtel · ICCID 8991..."). The brand is the
// first word, the model the rest of the first part, the serial number the SN / ICCID part. Nothing is guessed from the asset NAME.
function parseType(assetType) {
  const parts = String(assetType || '').split(/\s*[·|]\s*/).map((x) => x.trim()).filter(Boolean);
  const out = { descriptor: null, brand: null, model: null, serial: null };
  if (!parts.length) return out;
  let first = true;
  parts.forEach((p) => {
    const sn = /^(?:SN|S\/N|serial(?: no\.?| number)?|ICCID)\s*[:#-]?\s+(.+)$/i.exec(p);
    if (sn) { out.serial = out.serial || sn[1].trim(); return; }
    if (/^Tag\s+\S+/i.test(p)) return;
    if (first) {
      first = false;
      out.descriptor = p;
      const w = p.split(/\s+/);
      out.brand = w[0] || null;
      out.model = w.length > 1 ? w.slice(1).join(' ') : null;
    }
  });
  return out;
}

// ---- THE AUTOMATIC MAP: vendor-master category -> asset categories (2026-10-19) ---------------------------------------
// Keys are the vendor categories of config/vendorModules.js CATEGORIES (it_service = "IT / Hardware / AMC / Service"). Values are HRMS asset
// categories; the spelling is matched loosely (case, spaces, hyphens), so "Headset" finds "Head Set". Admin can change the map
// (PUT /api/vendor-logins/asset-grants/category-map); until then these defaults apply. A key saved by Admin replaces its default list.
const AUTO_DEFAULTS = {
  it_service: [
    'Laptop', 'Laptop Charger', 'Mouse', 'Head Set', 'Mobile Phone', 'Mobile', 'Phone Charger', 'Monitor',
    'Desktop', 'Keyboard', 'Tablet', 'Printer', 'Scanner', 'Router', 'Webcam', 'Pen Drive', 'Hard Disk', 'Docking Station', 'UPS',
  ],
};
const MAP_SETTING = 'vendor.assetCategoryMap';
const catNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
async function autoMap() {
  let saved = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: MAP_SETTING } });
    const v = row ? JSON.parse(row.value) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) saved = v;
  } catch { saved = {}; }
  const out = {};
  Object.keys(AUTO_DEFAULTS).forEach((k) => { out[k] = [...AUTO_DEFAULTS[k]]; });
  Object.keys(saved).forEach((k) => {
    if (!CFG.CATEGORIES[k] || !Array.isArray(saved[k])) return;
    out[k] = [...new Set(saved[k].map((c) => String(c || '').trim()).filter(Boolean))];
  });
  return { map: out, custom: Object.keys(saved).filter((k) => CFG.CATEGORIES[k]) };
}
async function saveAutoMap(map, user) {
  const clean = {};
  Object.keys(map || {}).forEach((k) => {
    if (!CFG.CATEGORIES[k] || !Array.isArray(map[k])) return;
    clean[k] = [...new Set(map[k].map((c) => String(c || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 80);
  });
  const value = JSON.stringify(clean);
  await prisma.appSetting.upsert({
    where: { key: MAP_SETTING }, create: { key: MAP_SETTING, value, updatedById: user ? user.id : null, updatedByName: user ? (user.name || user.email || null) : null },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? (user.name || user.email || null) : null },
  });
  return clean;
}
// The real stored spellings of the asset categories (case/space-insensitive match against the map).
async function realCategories() {
  const rows = await prisma.asset.groupBy({ by: ['category'], _count: { _all: true } });
  return rows.filter((r) => r.category).map((r) => r.category);
}
const vendorCatKey = (vendor) => CFG.resolveCategory(vendor && vendor.category);
// Vendors that can really use the Assets portal: switched on AND with at least one live login. Two of them on one category = a conflict.
async function liveVendorIdsWithLogin() {
  const users = await prisma.vendorUser.findMany({ where: { status: 'Active', deletedAt: null }, select: { vendorId: true } });
  return new Set(users.map((u) => u.vendorId));
}

// ---- the vendor master, once per call ------------------------------------------------------------------------------
async function directory() {
  const rows = await prisma.officeVendor.findMany({ select: { id: true, name: true, companyName: true, category: true, isActive: true } });
  const byKey = new Map(); // key -> Set(vendorId)
  const names = new Map();
  rows.forEach((r) => {
    names.set(r.id, r.name);
    [r.name, r.companyName].map(nameKey).filter(Boolean).forEach((k) => { if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(r.id); });
  });
  return { rows, byKey, names };
}

// ---- grants ------------------------------------------------------------------------------------------------------
// The ticks that GIVE assets (kind asset | category). Admin's "hide from the automatic rule" rows (exclude_*) are read by excludeRows().
async function grantRows(vendorId) {
  await SCH.ensure();
  return DB.q('SELECT * FROM "VendorAssetGrant" WHERE "vendorId" = ? AND "kind" IN (?,?) ORDER BY "grantedAt"', [vendorId, 'asset', 'category']);
}
async function excludeRows(vendorId) {
  await SCH.ensure();
  return DB.q('SELECT * FROM "VendorAssetGrant" WHERE "vendorId" = ? AND "kind" IN (?,?) ORDER BY "grantedAt"', [vendorId, 'exclude_asset', 'exclude_category']);
}
const newGrantId = () => `vag${crypto.randomBytes(12).toString('hex')}`;
const assetKey = (assetId) => `a:${assetId}`;
const catKey = (category) => `c:${String(category).trim().toLowerCase()}`;
const xAssetKey = (assetId) => `xa:${assetId}`;
const xCatKey = (category) => `xc:${String(category).trim().toLowerCase()}`;

const REASON_TEXT = {
  auto: 'Automatic: this vendor handles this kind of asset',
  linked: 'Linked to this vendor in the asset list',
  supplier: 'Bought from this vendor',
  repaired: 'Repaired by this vendor',
  admin: 'Chosen by Admin',
};
// reasons that make an asset the vendor's OWN (details may be edited, a repair with no vendor named belongs to it)
const OWN = ['linked', 'supplier', 'admin', 'auto'];

// ---- THE RESOLVER ------------------------------------------------------------------------------------------------
// v = { vendorId }. override = { assetIds: [...], categories: [...] } to preview Admin's un-saved ticks (instead of the saved grants).
async function load(v, override = null) {
  const vendorId = String(v.vendorId);
  const vendor = await prisma.officeVendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true, companyName: true } });
  const reasons = new Map(); // assetId -> Set(reason)
  const add = (assetId, reason) => { if (!reasons.has(assetId)) reasons.set(assetId, new Set()); reasons.get(assetId).add(reason); };
  const repairIds = new Set();
  const repairAsset = new Map(); // repairId -> assetId
  const ambiguous = [];
  const possible = [];
  const noAuto = { key: null, configured: [], categories: [], conflict: false, peers: [], excludedCategories: [], excludedAssetIds: [], notIds: [], vendorId };
  if (!vendor) return { vendor: null, reasons, categories: [], repairIds, repairAsset, ambiguous, possible, grants: { assetIds: [], categories: [] }, auto: noAuto };

  const dir = await directory();
  const myKeys = [vendor.name, vendor.companyName].map(nameKey).filter(Boolean);
  // A vendor whose own name (after the clean-up) is shared by another vendor can be matched by text by nobody.
  const mineShared = myKeys.some((k) => (dir.byKey.get(k) || new Set()).size > 1);
  const names = (set) => [...set].map((id) => dir.names.get(id)).filter(Boolean).sort();

  // 1. linked
  (await prisma.asset.findMany({ where: { vendorId }, select: { id: true } })).forEach((a) => add(a.id, 'linked'));

  // 2. supplier (the asset's own "who sold it" text)
  const withText = await prisma.asset.findMany({
    where: { AND: [{ vendor: { not: null } }, { NOT: { vendor: '' } }] },
    select: { id: true, assetCode: true, name: true, category: true, vendor: true, vendorId: true, invoiceNo: true },
  });
  const otherOwner = new Set(); // assets whose "bought from" name is ANOTHER vendor's: the automatic rule never takes them
  const judgeText = (text) => {
    const k = nameKey(text);
    if (!k) return { kind: 'none' };
    const owners = dir.byKey.get(k);
    if (owners) {
      if (!owners.has(vendorId)) return { kind: 'other' };
      return owners.size === 1 && !mineShared ? { kind: 'match' } : { kind: 'ambiguous', candidates: names(owners) };
    }
    const part = myKeys.some((mk) => mk.replace(/ /g, '').length >= 4 && k.replace(/ /g, '').length >= 4 && (k.includes(mk) || mk.includes(k)));
    return part ? { kind: 'possible' } : { kind: 'none' };
  };
  withText.forEach((a) => {
    if (a.vendorId && a.vendorId !== vendorId) return; // already another vendor's: its text never moves it
    const j = judgeText(a.vendor);
    if (j.kind === 'other') otherOwner.add(a.id);
    if (j.kind === 'match') add(a.id, 'supplier');
    else if (j.kind === 'ambiguous') ambiguous.push({ assetId: a.id, assetCode: a.assetCode, name: a.name, category: a.category, text: a.vendor, source: 'Bought from', candidates: j.candidates });
    else if (j.kind === 'possible') possible.push({ assetId: a.id, assetCode: a.assetCode, name: a.name, category: a.category, text: a.vendor, source: 'Bought from', candidates: [vendor.name] });
  });

  // 3. supplier by invoice number: a bill Accounts booked against THIS vendor (OfficeExpense.vendorId) carries the asset's invoice number
  const bills = await prisma.officeExpense.findMany({ where: { vendorId, billNumber: { not: null } }, select: { billNumber: true } }).catch(() => []);
  const billRefs = new Set(bills.map((b) => refKey(b.billNumber)).filter(Boolean));
  if (billRefs.size) {
    const inv = await prisma.asset.findMany({ where: { AND: [{ invoiceNo: { not: null } }, { NOT: { invoiceNo: '' } }, { OR: [{ vendorId: null }, { vendorId }] }] }, select: { id: true, invoiceNo: true } });
    inv.forEach((a) => { if (billRefs.has(refKey(a.invoiceNo))) add(a.id, 'supplier'); });
  }

  // 4. repaired (an AssetRepair row that names this vendor, or the vendor's own repair link)
  const reps = await prisma.assetRepair.findMany({
    where: { AND: [{ vendor: { not: null } }, { NOT: { vendor: '' } }] },
    select: { id: true, assetId: true, vendor: true, repairNo: true, asset: { select: { assetCode: true, name: true, category: true } } },
  });
  reps.forEach((r) => {
    const j = judgeText(r.vendor);
    if (j.kind === 'match') { add(r.assetId, 'repaired'); repairIds.add(r.id); repairAsset.set(r.id, r.assetId); } else if (j.kind === 'ambiguous') {
      ambiguous.push({ assetId: r.assetId, assetCode: r.asset.assetCode, name: r.asset.name, category: r.asset.category, text: r.vendor, source: `Repair ${r.repairNo}`, candidates: j.candidates });
    } else if (j.kind === 'possible') {
      possible.push({ assetId: r.assetId, assetCode: r.asset.assetCode, name: r.asset.name, category: r.asset.category, text: r.vendor, source: `Repair ${r.repairNo}`, candidates: [vendor.name] });
    }
  });

  // 5. admin grants
  let assetIds; let categories;
  if (override) {
    assetIds = [...new Set((override.assetIds || []).map(String))];
    categories = [...new Set((override.categories || []).map((c) => String(c).trim()).filter(Boolean))];
  } else {
    const g = await grantRows(vendorId);
    assetIds = g.filter((x) => x.kind === 'asset' && x.assetId).map((x) => x.assetId);
    categories = g.filter((x) => x.kind === 'category' && x.category).map((x) => x.category);
  }
  assetIds.forEach((id) => add(id, 'admin'));

  // 6. auto (the vendor's own master category -> asset categories). Read live; nothing is stored per asset.
  const auto = await autoFor(vendor, dir, otherOwner);
  return { vendor, reasons, categories, repairIds, repairAsset, ambiguous, possible, grants: { assetIds, categories }, auto };
}

// The automatic rule for ONE vendor: which real asset categories, whether a second live vendor shares them (then NOBODY gets them), and what
// Admin hid. A peer = another switched-on vendor with a live login whose master category resolves to the same key.
async function autoFor(vendor, dir, otherOwner) {
  const out = { key: null, configured: [], categories: [], conflict: false, peers: [], excludedCategories: [], excludedAssetIds: [], notIds: [], vendorId: vendor.id };
  const row = dir.rows.find((r) => r.id === vendor.id);
  const key = vendorCatKey(row);
  out.key = key;
  const { map } = await autoMap();
  const want = map[key] || [];
  if (!want.length) return out;
  const wantNorm = new Set(want.map(catNorm));
  const real = (await realCategories()).filter((c) => wantNorm.has(catNorm(c)));
  out.configured = real;
  const hasLogin = await liveVendorIdsWithLogin();
  out.peers = dir.rows.filter((r) => r.id !== vendor.id && r.isActive !== false && hasLogin.has(r.id) && vendorCatKey(r) === key).map((r) => r.name).sort();
  out.conflict = out.peers.length > 0;
  const ex = await excludeRows(vendor.id);
  out.excludedCategories = ex.filter((g) => g.kind === 'exclude_category' && g.category).map((g) => g.category);
  out.excludedAssetIds = ex.filter((g) => g.kind === 'exclude_asset' && g.assetId).map((g) => g.assetId);
  const exCat = new Set(out.excludedCategories.map(catNorm));
  out.categories = out.conflict ? [] : real.filter((c) => !exCat.has(catNorm(c)));
  out.notIds = [...new Set([...out.excludedAssetIds, ...otherOwner])];
  return out;
}
// Does the automatic rule give THIS asset (as read from the Asset table: id, category, vendorId) to this vendor?
function autoHas(auto, a) {
  if (!auto || !auto.categories.length) return false;
  if (!auto.categories.includes(a.category)) return false;
  if (a.vendorId && a.vendorId !== auto.vendorId) return false;
  return !auto.notIds.includes(a.id);
}

// ---- where-clauses ------------------------------------------------------------------------------------------------
const NONE = { id: '__none__' };
function whereFrom(r, reasonFilter) {
  const ids = [];
  r.reasons.forEach((set, id) => { if (!reasonFilter || [...set].some((x) => reasonFilter.includes(x))) ids.push(id); });
  const or = [];
  if (ids.length) or.push({ id: { in: ids } });
  if (r.categories.length && (!reasonFilter || reasonFilter.includes('admin'))) or.push({ category: { in: r.categories } });
  const au = r.auto;
  if (au && au.categories.length && (!reasonFilter || reasonFilter.includes('auto'))) {
    // the automatic rule is a WHERE clause on the category (a new asset row in it is picked up with no copying); the few exceptions are listed
    or.push({ AND: [{ category: { in: au.categories } }, { OR: [{ vendorId: null }, { vendorId: au.vendorId }] }, ...(au.notIds.length ? [{ NOT: { id: { in: au.notIds } } }] : [])] });
  }
  if (!or.length) return NONE;
  return { AND: [{ OR: or }, { NOT: { status: { in: VA.ARCHIVED } } }] };
}
// Everything this vendor may SEE. Inside ONE request (middleware below) the answer is worked out once and reused by that request's other
// calls; nothing is kept between requests, so a changed grant / link / name applies on the very next request.
const requestStore = new AsyncLocalStorage();
// Reads only: a write (a repair saved with this vendor's name, ...) changes the answer inside its own request, so writes always ask afresh.
function perRequest(req, res, next) { if (req.method !== 'GET') return next(); return requestStore.run(new Map(), next); }
// The vendor Import checks hundreds of rows in ONE request: the vendor's scope is worked out once and reused for all of them (an import
// changes repair steps and costs, never which assets are the vendor's).
const withScopeCache = (fn) => requestStore.run(new Map(), fn);
async function scope(v, override = null) {
  const store = override ? null : requestStore.getStore();
  const key = String(v.vendorId);
  if (store && store.has(key)) return store.get(key);
  const p = (async () => { const r = await load(v, override); return { ...r, where: whereFrom(r), ownWhere: whereFrom(r, OWN) }; })();
  if (store) { store.set(key, p); p.catch(() => store.delete(key)); }
  return p;
}

// WHY one asset (id, category, vendorId) is this vendor's, from an already loaded scope: every reason that applies.
function reasonSet(sc, a) {
  const set = new Set(sc.reasons.get(a.id) || []);
  if (sc.categories.includes(a.category)) set.add('admin');
  if (autoHas(sc.auto, a)) set.add('auto');
  return set;
}
// ---- WHAT THE VENDOR'S ASSETS PAGE LISTS (founder decision 2026-10-19: "only available assets") -----------------------------------
// The assets that BELONG to the vendor (scope above) are one thing; the assets it is SHOWN are fewer:
//   Available     status Available AND not held by anybody (assignedToId empty) - stock the vendor can work with
//   Under repair  an asset with an OPEN repair job for this vendor (an approved HRMS repair complaint, or a repair the company logged for it),
//                 whoever holds it; plus an asset whose HRMS status is "In Repair"
// An asset held by an employee with no open repair job, and any Retired / Sold / Written off asset, is NOT shown. The repairs themselves
// (Repairs, Repair History, Invoices) are unaffected: they follow the repair, not the asset's status.
// The Admin "will see N assets" number is worked out by THIS function too, so the two can never disagree.
async function visibleRepairIds(v, override = null) {
  const sc = await scope(v, override);
  const ids = new Set(sc.repairIds);
  if (sc.ownWhere !== NONE) {
    const own = await prisma.asset.findMany({ where: sc.ownWhere, select: { id: true } });
    if (own.length) {
      const blank = await prisma.assetRepair.findMany({ where: { assetId: { in: own.map((a) => a.id) }, OR: [{ vendor: null }, { vendor: '' }] }, select: { id: true } });
      blank.forEach((r) => ids.add(r.id));
    }
  }
  return ids;
}
const OPEN_REPAIR = ['Reported', 'In Repair'];
// SIM cards live in the Airtel Bills portal only (founder 2026-10-27); "contains" is case-insensitive here (SQLite LIKE)
const NOT_SIM = { NOT: { category: { contains: 'sim' } } };
async function listing(v, override = null) {
  const sc0 = await scope(v, override);
  if (sc0.where === NONE) return { sc: sc0, where: NONE, availableWhere: NONE, repairWhere: NONE, heldWhere: NONE, openRepairs: [], openAssetIds: [] };
  const sc = { ...sc0, where: { AND: [sc0.where, NOT_SIM] } };
  const ids = [...await visibleRepairIds(v, override)];
  const openRepairs = ids.length ? await prisma.assetRepair.findMany({ where: { id: { in: ids }, status: { in: OPEN_REPAIR } }, select: { id: true, assetId: true } }) : [];
  const openAssetIds = [...new Set(openRepairs.map((r) => r.assetId))];
  const repairOr = [{ status: 'In Repair' }, ...(openAssetIds.length ? [{ id: { in: openAssetIds } }] : [])];
  const availableWhere = { AND: [sc.where, { status: 'Available', assignedToId: null }, ...(openAssetIds.length ? [{ NOT: { id: { in: openAssetIds } } }] : [])] };
  const repairWhere = { AND: [sc.where, { OR: repairOr }] };
  // 27 Oct 2026 (Stage B): the assets employees hold are the vendor's to see too - "who has which asset"
  const heldWhere = { AND: [sc.where, { assignedToId: { not: null } }, { NOT: { status: 'In Repair' } }, ...(openAssetIds.length ? [{ NOT: { id: { in: openAssetIds } } }] : [])] };
  return { sc, where: sc.where, availableWhere, repairWhere, heldWhere, openRepairs, openAssetIds };
}

// The reasons for the assets of ONE vendor, newest meaning first - used by the Admin preview and by the detail view.
async function reasonsFor(v, assets, override = null) {
  const r = await load(v, override);
  const out = new Map();
  assets.forEach((a) => { out.set(a.id, [...reasonSet(r, a)]); });
  return { r, out };
}

// The full list for the Admin screen: every asset the vendor would see, with WHY. Same rule as the portal (the test compares the two).
async function preview(v, override = null) {
  const L = await listing(v, override);
  const sc = L.sc;
  const assets = L.where === NONE ? [] : await prisma.asset.findMany({
    where: L.where, select: { id: true, assetCode: true, name: true, category: true, status: true, location: true, vendorId: true, assignedToId: true }, orderBy: { assetCode: 'asc' },
  });
  const open = new Set(L.openAssetIds);
  const rows = assets.map((a) => {
    const set = reasonSet(sc, a);
    const { vendorId: _vendorId, assignedToId: held, ...rest } = a; // eslint-disable-line no-unused-vars
    const underRepair = open.has(a.id) || a.status === 'In Repair';
    return { ...rest, bucket: underRepair ? 'repair' : (held ? 'held' : (a.status === 'Available' ? 'available' : 'gap')), held: !!held, reasons: [...set], reasonText: [...set].map((x) => REASON_TEXT[x]) };
  });
  // how many of the vendor's assets are NOT shown, and why (a held asset with no repair job)
  const members = sc.where === NONE ? 0 : await prisma.asset.count({ where: sc.where });
  return {
    total: rows.length, rows, ambiguous: sc.ambiguous, possible: sc.possible, grants: sc.grants,
    available: rows.filter((r) => r.bucket === 'available').length, underRepair: rows.filter((r) => r.bucket === 'repair').length, withEmployees: rows.filter((r) => r.bucket === 'held').length, noHolderNamed: rows.filter((r) => r.bucket === 'gap').length, repairJobs: L.openRepairs.length,
    hiddenHeld: Math.max(0, members - rows.length),
    byReason: Object.fromEntries(Object.keys(REASON_TEXT).map((k) => [k, rows.filter((r) => r.reasons.includes(k)).length])),
  };
}

// WHO handles an asset: the vendor that is linked to it, or the one vendor that Admin ticked / the automatic map gives it to.
// -> { vendor: {id,name}|null, candidates: [{id,name,how}], conflict: bool }. Used when a repair is approved, to name the vendor on the repair.
async function vendorsForAsset(asset) {
  await SCH.ensure();
  const dir = await directory();
  const nameOf = (id) => dir.names.get(id) || null;
  const found = new Map(); // vendorId -> how
  if (asset.vendorId && nameOf(asset.vendorId)) found.set(asset.vendorId, 'linked');
  if (!found.size) {
    const gr = await DB.q('SELECT "vendorId","kind","assetId","category" FROM "VendorAssetGrant" WHERE "kind" IN (?,?)', ['asset', 'category']);
    gr.forEach((g) => {
      if ((g.kind === 'asset' && g.assetId === asset.id) || (g.kind === 'category' && catNorm(g.category) === catNorm(asset.category))) { if (nameOf(g.vendorId) && !found.has(g.vendorId)) found.set(g.vendorId, 'admin'); }
    });
    const { map } = await autoMap();
    const hasLogin = await liveVendorIdsWithLogin();
    const byKey = new Map();
    dir.rows.filter((r) => r.isActive !== false && hasLogin.has(r.id)).forEach((r) => { const k = vendorCatKey(r); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); });
    for (const [k, list] of byKey) {
      if (!(map[k] || []).some((c) => catNorm(c) === catNorm(asset.category))) continue; // eslint-disable-line no-continue
      if (list.length !== 1) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const ex = await excludeRows(list[0].id);
      const hidden = ex.some((g) => (g.kind === 'exclude_asset' && g.assetId === asset.id) || (g.kind === 'exclude_category' && catNorm(g.category) === catNorm(asset.category)));
      if (!hidden && !found.has(list[0].id)) found.set(list[0].id, 'auto');
    }
  }
  const candidates = [...found.entries()].map(([id, how]) => ({ id, name: nameOf(id), how }));
  return { vendor: candidates.length === 1 ? { id: candidates[0].id, name: candidates[0].name } : null, candidates, conflict: candidates.length > 1 };
}

// ADMIN SCREEN: what the automatic rule does for this vendor right now (the map, what is hidden, and any category shared with another vendor).
async function autoInfo(vendorId) {
  const dir = await directory();
  const row = dir.rows.find((r) => r.id === vendorId);
  if (!row) return null;
  const sc = await scope({ vendorId });
  const au = sc.auto;
  const { map, custom } = await autoMap();
  const cats = await prisma.asset.groupBy({ by: ['category'], where: { NOT: { status: { in: VA.ARCHIVED } } }, _count: { _all: true } });
  const count = new Map(cats.map((c) => [c.category, c._count._all]));
  return {
    key: au.key, keyLabel: (CFG.CATEGORIES[au.key] || {}).label || au.key, vendorCategory: row.category || null,
    mapped: (map[au.key] || []).length > 0, mapCustom: custom.includes(au.key),
    categories: au.configured.map((c) => ({ value: c, count: count.get(c) || 0, hidden: au.excludedCategories.some((x) => catNorm(x) === catNorm(c)), shown: au.categories.includes(c) })),
    conflict: au.conflict, peers: au.peers, excludedAssetIds: au.excludedAssetIds,
    total: au.categories.length ? await prisma.asset.count({ where: { AND: [{ category: { in: au.categories } }, { OR: [{ vendorId: null }, { vendorId }] }, ...(au.notIds.length ? [{ NOT: { id: { in: au.notIds } } }] : []), { NOT: { status: { in: VA.ARCHIVED } } }] } }) : 0,
  };
}
// ADMIN SCREEN: every category two live vendors share -> nobody gets those assets automatically until Admin decides.
async function autoConflicts() {
  const dir = await directory();
  const hasLogin = await liveVendorIdsWithLogin();
  const { map } = await autoMap();
  const byKey = new Map();
  dir.rows.filter((r) => r.isActive !== false && hasLogin.has(r.id)).forEach((r) => { const k = vendorCatKey(r); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r.name); });
  const real = await realCategories();
  const out = [];
  for (const [k, names] of byKey) {
    if (names.length < 2 || !(map[k] || []).length) continue; // eslint-disable-line no-continue
    const wantNorm = new Set((map[k] || []).map(catNorm));
    const cats = real.filter((c) => wantNorm.has(catNorm(c)));
    // eslint-disable-next-line no-await-in-loop
    const assets = cats.length ? await prisma.asset.count({ where: { category: { in: cats }, vendorId: null, NOT: { status: { in: VA.ARCHIVED } } } }) : 0;
    out.push({ key: k, label: (CFG.CATEGORIES[k] || {}).label || k, vendors: names.sort(), categories: cats, assets });
  }
  return out;
}

// The same, for a vendor that has the Admin grants only (a quick count for the logins list).
async function countFor(v) {
  const L = await listing(v);
  return L.where === NONE ? 0 : prisma.asset.count({ where: L.where });
}

module.exports = {
  NOT_SIM,
  nameKey, refKey, parseType, deptOfSeat, SEAT_DEPARTMENTS, REASON_TEXT, OWN, NONE,
  load, scope, listing, visibleRepairIds, OPEN_REPAIR, perRequest, withScopeCache, whereFrom, reasonsFor, reasonSet, preview, countFor, grantRows, excludeRows, newGrantId, assetKey, catKey, xAssetKey, xCatKey,
  AUTO_DEFAULTS, MAP_SETTING, autoMap, saveAutoMap, autoHas, autoInfo, autoConflicts, vendorsForAsset, realCategories, catNorm, vendorCatKey,
};

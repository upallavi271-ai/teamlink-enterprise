// ---------------------------------------------------------------------------
// THE ASSETS VENDOR PORTAL - what an ASSET VENDOR sees and may do (2026-10-19).
// Routes: routes/assetVendorPortal.js (mounted inside routes/vendorPortal.js). Pages: frontend/src/pages/vendor/AssetPortal*.jsx.
//
// WHO IS AN ASSET VENDOR (kindOf): the login has the Assets module ticked when Admin set its modules; for a login without module rows,
// the vendor-master category is the one the old Assets menu belonged to (config/vendorModules.js CATEGORIES.it_service). Every other
// vendor stays on the four finance modules exactly as before.
//
// WHAT IS "ASSIGNED TO THIS VENDOR" (nothing here is copied or created - the company's own rows are read and linked):
//   ASSETS   the company's HRMS asset rows (table Asset), read by their own id - NEVER copied. utils/assetHrmsScope.js decides which are this
//            vendor's: linked to it (Asset.vendorId), bought from it (the asset's vendor name, carefully matched), repaired by it (an
//            AssetRepair naming it), or chosen for it by Admin (VendorAssetGrant: one asset or a whole category). One asset id = one row:
//            the lists are keyed by the asset id, and nothing in this file creates an Asset. Brand / model / serial number come from what
//            HRMS already holds (Asset.assetType "BRAND MODEL · SN ..." and Asset.serialNumber) before the vendor's own note.
//   REPAIRS  the AssetRepair rows HRMS keeps (Accounts reads the same rows): vendor name = this vendor, or no vendor named yet and the
//            asset is in this vendor's asset scope. The vendor never creates a repair: it updates the company's own, so a repair
//            can never be duplicated. Its link (repair id + asset id + vendor id) is AssetRepairVendor.
//   ORDERS   the orders the company placed with this vendor: ID-card orders (IdCardOrder) and the purchase-order documents shared with
//            it. The app has no general asset-purchase-order table; nothing is invented.
// The vendor id ALWAYS comes from the session (req.vendor); an id in a body, query or path only selects a row INSIDE that vendor's own set.
//
// WHAT A VENDOR WRITES, AND WHERE ACCOUNTS SEES IT (never the ledger, never "paid"):
//   status            -> AssetRepair.status (Reported / In Repair / Completed) + the finer stage in AssetRepairVendor
//   final cost, GST   -> AssetRepair.cost / AssetRepair.gstPaid  (the fields Accounts > Fixed Assets > Repair cost and
//                        "Pending from HRMS" read)
//   invoice no.       -> AssetRepair.invoiceNo ; invoice file -> AssetRepairVendor + AssetRepair.slip (when no company slip is there)
//   vendor name       -> AssetRepair.vendor (only when it was blank: that is the link)
//   estimate, dates, remarks -> AssetRepairVendor only (HRMS has no such fields)
// Never touched: paidVia, paidBankAccountId, capitalise, underWarranty, any journal row. assetPosting.autoSync() is NOT called, so a
// vendor's save never posts anything: Accounts posts (or re-posts "Changed in HRMS") itself.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./assetVendorSchema');
const VP = require('./vendorPortal');
const CFG = require('../config/vendorModules');
const MODS = require('./vendorModules');
const R = require('./vendorRecords');
const attachments = require('./attachments');
const PAYS = require('./assetVendorPayments');
const HS = require('./assetHrmsScope'); // which HRMS assets belong to this vendor (2026-10-19)
const AC = require('./assetComplaints'); // a repair complaint approved in HRMS -> the repair job (2026-10-19)
const Mask = require('./vendorAssetMask'); // NO employee names in anything the vendor sees (founder decision 2026-10-19)

// The masker is the same for every vendor (it depends only on the company's asset and employee tables), so it is loaded once per call into a
// shared variable that the sync view builders read. Until it is loaded, the SAFE one answers: it shows "AST-<id>" and hides every free text.
const SAFE_MASK = { code: (a) => Mask.fallback(a && a.id), codeOfId: (id) => Mask.fallback(id), codeOfCode: () => '', text: () => '', scrub: () => '' };
let MASK = SAFE_MASK;
async function ensureMask() { MASK = await Mask.load(); return MASK; }
const MK = () => MASK;
const { logAudit } = require('./audit');
const { wantsAll } = require('./exportAll'); // the vendor Export asks for every row of a list (never reachable from a query string)

const { str, ROUND } = VP;
const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const newId = () => `are${crypto.randomBytes(12).toString('hex')}`;
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const NOT_YOUR_ASSET = { error: 'Forbidden. This asset is not yours.' };
const NOT_YOUR_REPAIR = { error: 'Forbidden. This repair is not yours.' };
const NOT_YOUR_ORDER = { error: 'Forbidden. This order is not yours.' };
const VIEW_ONLY = { error: 'Your login is view-only. Ask the company to allow editing.' };

// ---- who is an asset vendor: utils/vendorKind.js (one place decides the vendor's kind: assets | idcards | finance)
const { kindOfRow, kindOfToken } = require('./vendorKind');

// ---- stages ------------------------------------------------------------------------------------
// The vendor's five steps. Stored status stays the HRMS vocabulary (Reported | In Repair | Completed | Cancelled):
//   Awaiting repair = Reported ; Sent for repair, Under repair = In Repair ; Completed, Returned = Completed.
const STAGES = ['Awaiting repair', 'Sent for repair', 'Under repair', 'Completed', 'Returned'];
const STATUS_OF = { 'Awaiting repair': 'Reported', 'Sent for repair': 'In Repair', 'Under repair': 'In Repair', Completed: 'Completed', Returned: 'Completed' };
const STEP_BUTTON = { 'Sent for repair': 'Asset received', 'Under repair': 'Start repair', Completed: 'Repair done', Returned: 'Handed back to the company' };
const CONDITIONS = ['Good', 'Fair', 'Needs repair', 'Damaged', 'Not working'];
function stageOf(repair, side) {
  if (repair.status === 'Cancelled') return 'Cancelled';
  if (repair.status === 'Reported') return 'Awaiting repair';
  if (repair.status === 'In Repair') return side && ['Sent for repair', 'Under repair'].includes(side.stage) ? side.stage : 'Sent for repair';
  return side && side.stage === 'Returned' ? 'Returned' : 'Completed';
}
const nextStageOf = (stage) => { const i = STAGES.indexOf(stage); return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null; };

// ---- scope -------------------------------------------------------------------------------------
// ONE rule, in utils/assetHrmsScope.js: an HRMS asset is this vendor's when it is linked to it (Asset.vendorId), bought from it (the asset's
// vendor name, carefully cleaned up), repaired by it, or chosen for it by Admin (a single asset or a whole category). Read fresh every call.
async function assetsWhere(v) { return (await HS.scope(v)).where; }
// The assets that are the vendor's OWN (not only "sent here for a repair"): their details may be edited.
async function ownAssetsWhere(v) { return (await HS.scope(v)).ownWhere; }
async function visibleRepairIds(v) { return HS.visibleRepairIds(v); }
async function sideRows(vendorId) {
  await SCH.ensure();
  const rows = await DB.q('SELECT * FROM "AssetRepairVendor" WHERE "vendorId" = ?', [vendorId]);
  return new Map(rows.map((r) => [r.repairId, r]));
}
async function infoRows(assetIds) {
  await SCH.ensure();
  if (!assetIds.length) return new Map();
  const rows = await DB.q(`SELECT * FROM "AssetVendorInfo" WHERE "assetId" IN (${assetIds.map(() => '?').join(',')})`, assetIds);
  return new Map(rows.map((r) => [r.assetId, r]));
}
// One repair if (and only if) it is in this vendor's own set.
async function myRepair(v, id) {
  const repair = await prisma.assetRepair.findUnique({ where: { id: String(id || '') }, include: { asset: true } });
  if (!repair) return null;
  const sc = await HS.scope(v);
  let ok;
  if (String(repair.vendor || '').trim()) ok = sc.repairIds.has(repair.id);
  else ok = sc.ownWhere !== HS.NONE && (await prisma.asset.count({ where: { AND: [{ id: repair.assetId }, sc.ownWhere] } })) > 0;
  if (!ok) return null;
  await tag([repair]);
  const side = (await sideRows(v.vendorId)).get(repair.id) || null;
  return { repair, asset: repair.asset, side };
}
async function myAsset(v, id) {
  const L = await HS.listing(v); // the same rule as the Assets page (since 27 Oct 2026 that includes the assets employees hold; never SIM cards)
  return prisma.asset.findFirst({ where: { AND: [{ id: String(id || '') }, L.where] }, include: { assignedTo: { select: HOLDER_SELECT } } });
}
// THE ASSIGNMENT HISTORY HRMS HOLDS: the asset's own history lines about who held it (assigned / returned / moved / handed over), oldest first.
// HRMS keeps them as text in Asset.history - there is no separate assignment table - so they are shown as written, with their own dates.
const ASSIGN_WORDS = /assign|return|handed|hand over|moved|transfer|holder|→|unassign|given to|taken back|seat/i;
function assignmentHistory(a) {
  let h = [];
  try { h = JSON.parse(a.history || '[]'); } catch { h = []; }
  if (!Array.isArray(h)) h = [];
  const M = MK();
  // HRMS writes the newest line FIRST (routes/assetInventory.js pushHistory unshift): reversed, then a stable sort by time keeps same-minute lines in order
  return [...h].reverse().filter((e) => e && ASSIGN_WORDS.test(String(e.text || '')))
    .map((e) => ({ at: e.at || null, by: e.by || null, text: M.text(String(e.text || ''), a.id) }))
    .sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')));
}

// ---- views -------------------------------------------------------------------------------------
const iso = (d) => (d ? new Date(d).toISOString() : null);
const money = (n) => (n == null ? null : ROUND(n));
// ---- warranty and amounts (founder decision 2026-10-19) -----------------------------------------------------------------
// Warranty: the date and a plain chip. Amount: what the company paid, GST where recorded, and the total; "Not recorded" (null) when there is none,
// never 0. Amounts are shown to every asset vendor unless Admin ticked "Hide amounts from this vendor" for the login (v.showAmounts === false).
function warrantyOf(until, now = new Date()) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(until || '')) ? new Date(`${until}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return { until: null, status: 'No warranty recorded', tone: 'grey', days: null };
  const today0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((d.getTime() - today0) / 86400000);
  if (days >= 0) return { until, status: days === 0 ? 'In warranty (ends today)' : `In warranty (${days} ${days === 1 ? 'day' : 'days'} left)`, tone: 'green', days };
  return { until, status: `Expired ${-days} ${-days === 1 ? 'day' : 'days'} ago`, tone: 'red', days };
}
// Does this login see amounts? Yes unless Admin ticked "Hide amounts from this vendor" (assets module permission hideAmounts).
async function showAmountsOf(vendorRow) {
  const eff = await MODS.effectiveModules(vendorRow);
  const m = eff.map.get('assets');
  return !(m && m.permissions && m.permissions.hideAmounts === true);
}
function amountsOf(a, v) {
  if (v && v.showAmounts === false) return { amountHidden: true };
  const cost = Number(a.purchaseCost);
  const has = Number.isFinite(cost) && cost > 0;
  const gst = Number(a.gstPaid);
  const hasGst = has && Number.isFinite(gst) && gst > 0;
  return { amount: has ? ROUND(cost) : null, gst: hasGst ? ROUND(gst) : null, amountTotal: has ? ROUND(cost + (hasGst ? gst : 0)) : null, amountHidden: false };
}
function repairView(repair, asset, side, extra = {}, v = null) {
  const M = MK();
  const stage = stageOf(repair, side);
  const next = stage === 'Cancelled' ? null : nextStageOf(stage);
  const final = Number(repair.cost) || 0;
  const finalGst = Number(repair.gstPaid) || 0;
  const eCost = side && side.estimateCost != null ? Number(side.estimateCost) : null;
  const eGst = side && side.estimateGst != null ? Number(side.estimateGst) : null;
  return {
    id: repair.id, repairNo: repair.repairNo, assetId: repair.assetId, assetCode: M.code(asset), assetName: M.text(asset.name, asset.id), category: asset.category,
    assetType: M.text(asset.assetType, asset.id) || null, serialNumber: M.text(asset.serialNumber, asset.id) || null,
    warranty: warrantyOf(asset.warrantyUntil), ...amountsOf(asset, v),
    issue: M.text(repair.issue, asset.id) || null, repairType: repair.repairType, status: repair.status, stage, nextStage: next, nextStageButton: next ? STEP_BUTTON[next] : null,
    dateReported: repair.dateReported || null, expectedDate: side ? side.expectedDate || null : null, repairDate: repair.repairDate || null, returnedDate: side ? side.returnedDate || null : null,
    estimateCost: money(eCost), estimateGst: money(eGst), estimateTotal: eCost == null ? null : ROUND(eCost + (eGst || 0)),
    finalCost: final > 0 || finalGst > 0 ? money(final) : null, finalGst: finalGst > 0 ? money(finalGst) : null, finalTotal: final > 0 || finalGst > 0 ? ROUND(final + finalGst) : null,
    invoiceNo: repair.invoiceNo || null, hasInvoice: !!(side && side.invoiceFile), invoiceName: side && side.invoiceFile ? side.invoiceName : null,
    vendorRemarks: side ? side.vendorRemarks || null : null, underWarranty: !!repair.underWarranty,
    updatedAt: iso(repair.updatedAt), linked: !!side,
    // From an HRMS asset complaint: only its reference and the approval day. Never the employee, the thread or anybody's remarks.
    ticketRef: repair.__ticket ? repair.__ticket.ticketRef : null, approvedOn: repair.__ticket ? repair.__ticket.approvedOn : null,
    fromCompany: !!repair.__ticket,
    ...extra,
  };
}
// Put the complaint reference on each loaded repair (one read). A non-enumerable property: it never leaks into a JSON answer by itself.
async function tag(repairs) {
  const map = await AC.ticketsForRepairs(repairs.map((r) => r.id));
  repairs.forEach((r) => { if (map.has(r.id)) Object.defineProperty(r, '__ticket', { value: map.get(r.id), enumerable: false, configurable: true }); });
  return repairs;
}
// What the vendor may know of the department: the department NAME only (the holder's, or the seat's), never who holds the asset.
const deptOf = (a) => (a.assignedTo && a.assignedTo.department) || HS.deptOfSeat(a.location) || null;
// WHO HOLDS IT (founder 2026-10-27): name, employee ID, designation and department - nothing else about the person.
const HOLDER_SELECT = { id: true, name: true, employeeCode: true, designation: true, department: true, employmentStatus: true };
const LEFT = ['Relieved', 'Exited'];
function holderOf(a) {
  const e = a.assignedTo;
  if (!e) return null;
  return { name: e.name || null, employeeCode: e.employeeCode || null, designation: e.designation || null, department: e.department || null, left: LEFT.includes(e.employmentStatus) };
}
function assetView(a, v, info, openRepair, showInvoice = false) {
  const M = MK();
  const base = VP.vendorAssetView(a, { ...v, canViewCost: false }); // the amount is handled below (amountsOf); the old purchaseCost / invoiceNo fields stay out
  if (v.canViewCost) base.invoiceNo = a.invoiceNo ?? null; // "Show purchase value" still shows the company's purchase invoice reference
  const typeText = M.text(a.assetType, a.id);
  const t = HS.parseType(typeText); // brand / model / serial number HRMS already holds inside the finer type
  if (showInvoice) base.invoiceNo = a.invoiceNo ?? null; // what was bought from THIS vendor shows its own invoice reference
  base.assetCode = M.code(a); base.name = M.text(a.name, a.id); base.location = M.text(a.location, a.id) || null; base.serviceRemarks = M.text(a.serviceRemarks, a.id) || null;
  delete base.purchaseCost;
  return {
    ...base, ...amountsOf(a, v), warranty: warrantyOf(a.warrantyUntil), assetType: t.descriptor || typeText || null,
    serialNumber: M.text(a.serialNumber, a.id) || t.serial || null,
    brand: (info && info.brand) || t.brand || null, model: (info && info.model) || t.model || null, condition: info ? info.condition || null : null,
    department: deptOf(a), assignedVendor: v.vendorName, repairStage: openRepair ? openRepair.stage : null, repairNo: openRepair ? openRepair.repairNo : null,
    holder: holderOf(a), assignment: a.assignedToId ? 'Assigned' : 'Unassigned', assignedAt: iso(a.assignedAt), assignedBy: a.assignedByName || null, updatedAt: iso(a.updatedAt),
  };
}
const OPEN_STAGES = ['Awaiting repair', 'Sent for repair', 'Under repair'];

// Every repair of this vendor with its asset and side row, newest first.
async function loadRepairs(v) {
  await ensureMask();
  const ids = [...await visibleRepairIds(v)];
  if (!ids.length) return [];
  const [rows, sides] = await Promise.all([prisma.assetRepair.findMany({ where: { id: { in: ids } }, include: { asset: true }, orderBy: [{ createdAt: 'desc' }] }), sideRows(v.vendorId)]);
  await tag(rows);
  return rows.map((r) => ({ repair: r, asset: r.asset, side: sides.get(r.id) || null }));
}

// ---- list helpers ------------------------------------------------------------------------------
function paged(rows, q, defaultSort, sorts, defaultDir = 'asc') {
  const sortKey = typeof sorts[str(q.sort)] === 'function' ? str(q.sort) : defaultSort;
  const dir = str(q.dir) === 'desc' ? 'desc' : (str(q.dir) === 'asc' ? 'asc' : defaultDir);
  const f = sorts[sortKey];
  const cmp = (a, b) => { const x = f(a); const y = f(b); return (typeof x === 'number' && typeof y === 'number') ? x - y : String(x ?? '').localeCompare(String(y ?? '')); };
  const sorted = [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  if (wantsAll(q)) return { rows: sorted, total: sorted.length, page: 1, pageSize: sorted.length, pages: 1, sort: sortKey, dir };
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  return { rows: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize, pages, sort: sortKey, dir };
}
const facet = (rows, get) => {
  const m = new Map();
  rows.forEach((r) => { const k = get(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
};
const inRange = (d, from, to) => (!from || (d || '') >= from) && (!to || (d || '') <= to);

// ---- ASSETS ------------------------------------------------------------------------------------
const ASSET_SORTS = { assetCode: (r) => r.assetCode, name: (r) => r.name, category: (r) => r.category, brand: (r) => r.brand || '', model: (r) => r.model || '', serialNumber: (r) => r.serialNumber || '', condition: (r) => r.condition || '', status: (r) => r.status };
// view: 'available' (default) = in stock and free for the vendor's work | 'repair' = has an open repair job, or is In Repair in HRMS
async function listAssets(v, q = {}) {
  await ensureMask();
  const L = await HS.listing(v);
  // view=all (no tab on the page; used by the scope tests) is simply both tabs together: nothing outside what the vendor may see
  const tab = ['repair', 'available', 'assigned'].includes(str(q.view)) ? str(q.view) : 'all';
  const where = tab === 'repair' ? L.repairWhere : (tab === 'available' ? L.availableWhere : (tab === 'assigned' ? L.heldWhere : L.where));
  const [assets, repairs, nAvail, nRepair, nHeld, nAll] = await Promise.all([
    where === HS.NONE ? [] : prisma.asset.findMany({ where, include: { assignedTo: { select: HOLDER_SELECT } }, orderBy: { assetCode: 'asc' }, take: 5000 }),
    loadRepairs(v),
    L.availableWhere === HS.NONE ? 0 : prisma.asset.count({ where: L.availableWhere }),
    L.repairWhere === HS.NONE ? 0 : prisma.asset.count({ where: L.repairWhere }),
    L.heldWhere === HS.NONE ? 0 : prisma.asset.count({ where: L.heldWhere }),
    L.where === HS.NONE ? 0 : prisma.asset.count({ where: L.where }),
  ]);
  const info = await infoRows(assets.map((a) => a.id));
  const open = new Map();
  repairs.forEach(({ repair, side }) => { // the newest open repair of each asset
    const stage = stageOf(repair, side);
    if (OPEN_STAGES.includes(stage) && !open.has(repair.assetId)) open.set(repair.assetId, { stage, repairNo: repair.repairNo });
  });
  const all = assets.map((a) => assetView(a, v, info.get(a.id), open.get(a.id)));
  const s = str(q.q).toLowerCase();
  const keep = (r, skip) => (!str(q.category) || skip === 'category' || r.category === str(q.category))
    && (!str(q.department) || skip === 'department' || r.department === str(q.department))
    && (!str(q.assignment) || skip === 'assignment' || r.assignment === str(q.assignment))
    && (!str(q.designation) || skip === 'designation' || (r.holder && r.holder.designation) === str(q.designation))
    && (!str(q.status) || skip === 'status' || r.status === str(q.status))
    && (!str(q.condition) || skip === 'condition' || r.condition === str(q.condition))
    && (!s || [r.assetCode, r.name, r.category, r.brand, r.model, r.serialNumber, r.condition, r.status, r.location, r.department, r.holder && r.holder.name, r.holder && r.holder.employeeCode, r.holder && r.holder.designation].some((x) => String(x || '').toLowerCase().includes(s)));
  const rows = all.filter((r) => keep(r));
  return {
    ...paged(rows, q, 'assetCode', ASSET_SORTS), assignedTotal: all.length, canEdit: v.canEdit, canViewCost: v.canViewCost, showAmounts: v.showAmounts !== false, conditions: CONDITIONS,
    view: tab, tabs: { all: nAll, assigned: nHeld, available: nAvail, repair: nRepair }, openRepairJobs: L.openRepairs.length, refreshedAt: new Date().toISOString(),
    facets: {
      category: facet(all.filter((r) => keep(r, 'category')), (r) => r.category), status: facet(all.filter((r) => keep(r, 'status')), (r) => r.status),
      condition: facet(all.filter((r) => keep(r, 'condition')), (r) => r.condition),
      department: facet(all.filter((r) => keep(r, 'department')), (r) => r.department), assignment: facet(all.filter((r) => keep(r, 'assignment')), (r) => r.assignment),
      designation: facet(all.filter((r) => keep(r, 'designation')), (r) => (r.holder ? r.holder.designation : null)),
    },
  };
}

// The asset-wide timeline: this vendor's repair events + the company's own repair changes (a short allow-list of fields).
const COMPANY_FIELDS = ['status', 'cost', 'gstPaid', 'invoiceNo', 'repairDate', 'dateReported', 'vendor', 'issue'];
const FIELD_WORD = { status: 'Status', cost: 'Cost', gstPaid: 'GST', invoiceNo: 'Invoice no.', repairDate: 'Repair date', dateReported: 'Reported on', vendor: 'Vendor', issue: 'Problem' };
async function historyFor(v, repairIds) {
  if (!repairIds.length) return [];
  await SCH.ensure();
  const ph = repairIds.map(() => '?').join(',');
  const own = await DB.q(`SELECT * FROM "AssetRepairEvent" WHERE "repairId" IN (${ph}) AND ("vendorId" = ? OR "actorKind" = 'Company') ORDER BY "createdAt" DESC, "id" DESC LIMIT 400`, [...repairIds, v.vendorId]);
  const company = await prisma.auditLog.findMany({
    where: { entity: 'AssetRepair', entityId: { in: repairIds }, OR: [{ field: { in: COMPANY_FIELDS } }, { action: 'Asset repair logged' }], NOT: { action: { startsWith: 'Repair' } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  const info = new Map((await prisma.assetRepair.findMany({ where: { id: { in: repairIds } }, select: { id: true, repairNo: true, asset: { select: { id: true, assetCode: true, name: true } } } })).map((x) => [x.id, x]));
  const M = MK();
  const clean = (t, repairId) => { const x = info.get(repairId); return t == null ? t : M.text(String(t), x ? x.asset.id : ''); };
  const nos = new Map([...info.entries()].map(([k, x]) => [k, x.repairNo]));
  const assetOf = (id) => { const x = info.get(id); return x ? { assetCode: M.code(x.asset), assetName: M.text(x.asset.name, x.asset.id) } : { assetCode: null, assetName: null }; };
  const out = [
    ...own.map((e) => ({
      id: e.id, repairId: e.repairId, repairNo: nos.get(e.repairId) || null, ...assetOf(e.repairId), at: e.createdAt, by: e.actorKind === 'Vendor' ? 'You' : 'Company', kind: e.kind, field: e.field || null, from: clean(e.fromValue ?? null, e.repairId), to: clean(e.toValue ?? null, e.repairId), note: clean(e.note || null, e.repairId),
    })),
    ...company.map((a) => ({
      id: `aud:${a.id}`, repairId: a.entityId, repairNo: nos.get(a.entityId) || null, ...assetOf(a.entityId), at: iso(a.createdAt), by: 'Company', kind: a.field ? 'company change' : 'logged', field: a.field ? (FIELD_WORD[a.field] || a.field) : null,
      from: clean(a.fromValue ?? null, a.entityId), to: a.field ? clean(a.toValue ?? null, a.entityId) : null, note: a.field ? null : 'The company logged this repair.',
    })),
  ];
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function assetDetail(v, id) {
  await ensureMask();
  const a = await myAsset(v, id);
  if (!a) return null;
  const [info, all, sc] = await Promise.all([infoRows([a.id]), loadRepairs(v), HS.scope(v)]);
  const mine = all.filter((x) => x.repair.assetId === a.id);
  const px = await paymentExtras(v, mine);
  const views = mine.map(({ repair, asset, side }) => repairView(repair, asset, side, px.map.get(repair.id), v));
  const openOne = views.find((r) => OPEN_STAGES.includes(r.stage));
  const history = await historyFor(v, mine.map((x) => x.repair.id));
  const scoped = sc.ownWhere !== HS.NONE && (await prisma.asset.count({ where: { AND: [{ id: a.id }, sc.ownWhere] } })) > 0;
  const why = sc.reasons.get(a.id) || new Set();
  const boughtHere = why.has('supplier') || why.has('linked') || v.canViewCost; // the invoice number is shown for what was bought from this vendor
  return {
    asset: { ...assetView(a, v, info.get(a.id), openOne, boughtHere), warrantyUntil: a.warrantyUntil || null, amcUntil: a.amcUntil || null, updatedAt: iso(a.updatedAt) },
    purchase: purchaseOf(boughtHere ? a : { ...a, invoiceNo: null }, px.rows, v), repairs: views, history, canEdit: v.canEdit && scoped, editNote: scoped ? null : 'This asset is with you for a repair. The company keeps its details.',
    conditions: CONDITIONS,
    // who holds it now, and every hand-over HRMS wrote down (27 Oct 2026); a missing history is said, never made up
    assignment: (() => { const hist = assignmentHistory(a); return { current: holderOf(a), status: a.assignedToId ? 'Assigned' : 'Unassigned', assignedAt: iso(a.assignedAt), assignedBy: a.assignedByName || null, returnedAt: iso(a.returnedAt), history: hist, note: hist.length ? null : 'HRMS has no earlier hand-over recorded for this asset.' }; })(),
  };
}

const ASSET_EDITABLE = { brand: 'Brand', model: 'Model', condition: 'Condition', serialNumber: 'Serial number', serviceRemarks: 'Service remarks' };
async function updateAsset(v, req, id, body) {
  if (!v.canEdit) return { status: 403, body: VIEW_ONLY };
  const a = await myAsset(v, id);
  if (!a) return { status: 403, body: NOT_YOUR_ASSET };
  const own = await ownAssetsWhere(v);
  if (own === HS.NONE || !(await prisma.asset.count({ where: { AND: [{ id: a.id }, own] } }))) return { status: 403, body: { error: 'This asset is with you for a repair only. The company keeps its details.' } };
  const bad = Object.keys(body).filter((k) => !ASSET_EDITABLE[k] && k !== 'updatedAt');
  if (bad.length) return { status: 400, body: { error: `You can change only: ${Object.values(ASSET_EDITABLE).join(', ').toLowerCase()}.`, refusedFields: bad } };
  if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(a.updatedAt).getTime()) {
    return { status: 409, body: { error: 'This asset was changed by someone else just now. Refresh and try again.', stale: true, updatedAt: iso(a.updatedAt) } };
  }
  const info = (await infoRows([a.id])).get(a.id) || {};
  const want = {};
  for (const k of Object.keys(ASSET_EDITABLE)) {
    if (body[k] === undefined) continue; // eslint-disable-line no-continue
    if (VP.hasHtml(body[k])) return { status: 400, body: { error: 'Plain text only - no < or > characters.', field: k } };
    const max = k === 'serviceRemarks' ? 1000 : (k === 'serialNumber' ? 120 : 80);
    if (String(body[k] ?? '').trim().length > max) return { status: 400, body: { error: `Keep ${ASSET_EDITABLE[k].toLowerCase()} under ${max} characters.`, field: k } };
    const val = VP.cleanText(body[k], max) || null;
    if (k === 'condition' && val && !CONDITIONS.includes(val)) return { status: 400, body: { error: `Condition is one of: ${CONDITIONS.join(', ')}.`, field: k } };
    want[k] = val;
  }
  const parsed = HS.parseType(a.assetType);
  const cur = (k) => (['brand', 'model', 'condition'].includes(k) ? (info[k] || (k === 'brand' ? parsed.brand : k === 'model' ? parsed.model : null)) : (k === 'serialNumber' ? (a.serialNumber || parsed.serial) : a[k])) ?? null;
  const changes = Object.keys(want).filter((k) => want[k] !== cur(k));
  if (!changes.length) return { status: 200, body: { changed: [], message: 'Nothing changed.', asset: (await assetDetail(v, a.id)).asset } };
  if (changes.includes('serialNumber') && want.serialNumber) {
    const clash = await prisma.asset.findFirst({ where: { serialNumber: want.serialNumber, NOT: { id: a.id } }, select: { id: true, assetCode: true } });
    if (clash) {
      const mine = (await prisma.asset.count({ where: { AND: [{ id: clash.id }, await assetsWhere(v)] } })) > 0;
      return { status: 409, body: { error: mine ? `Serial number ${want.serialNumber} is already on ${clash.assetCode}.` : `Serial number ${want.serialNumber} is already used by another asset.`, field: 'serialNumber' } };
    }
  }
  const by = `${v.name} (vendor ${v.vendorName})`;
  let history = a.history;
  changes.forEach((k) => { history = VP.pushAssetHistory(history, by, `Edited by vendor ${v.name}: ${ASSET_EDITABLE[k].toLowerCase()} ${cur(k) || '-'} -> ${want[k] || '-'}`); });
  const onAsset = changes.filter((k) => ['serialNumber', 'serviceRemarks'].includes(k));
  const onInfo = changes.filter((k) => ['brand', 'model', 'condition'].includes(k));
  await SCH.ensure();
  try {
    await prisma.$transaction(async (tx) => {
      const n = await tx.asset.updateMany({ where: { id: a.id, updatedAt: a.updatedAt }, data: { ...Object.fromEntries(onAsset.map((k) => [k, want[k]])), history } });
      if (!n.count) throw Object.assign(new Error('stale'), { stale: true });
      if (onInfo.length) {
        const t = nowIso();
        const row = { brand: info.brand ?? null, model: info.model ?? null, condition: info.condition ?? null, ...Object.fromEntries(onInfo.map((k) => [k, want[k]])) };
        await DB.run('INSERT INTO "AssetVendorInfo" ("assetId","brand","model","condition","updatedByName","updatedVendorId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?) '
          + 'ON CONFLICT("assetId") DO UPDATE SET "brand"=excluded."brand","model"=excluded."model","condition"=excluded."condition","updatedByName"=excluded."updatedByName","updatedVendorId"=excluded."updatedVendorId","updatedAt"=excluded."updatedAt"',
        [a.id, row.brand, row.model, row.condition, by, v.vendorId, t, t], tx);
      }
    });
  } catch (e) {
    if (e && e.stale) return { status: 409, body: { error: 'This asset was changed by someone else just now. Refresh and try again.', stale: true } };
    throw e;
  }
  const fresh = await assetDetail(v, a.id);
  for (const k of changes) {
    // eslint-disable-next-line no-await-in-loop
    await VP.auditReq(req, { assetId: a.id, vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: 'Asset edited', field: k, oldValue: cur(k) ?? '', newValue: want[k] ?? '' });
  }
  return { status: 200, body: { changed: changes, message: 'Saved.', asset: fresh.asset } };
}

// ---- PAYMENT (read live from Accounts: utils/assetVendorPayments.js) -----------------------------------
const NO_INVOICE = { status: 'No invoice yet', tone: 'grey', paidAmount: 0, balance: 0, lastPaymentDate: null, basis: null, overdue: false, dueDate: null, paymentMode: null, note: 'Add the final cost and the invoice, then send it to Accounts.' };
const NOT_SENT = { ...NO_INVOICE, status: PAYS.STATUS.NOT_SENT, note: 'The invoice is ready. Send it to Accounts so they can pay it.' };
// payment + invoice (+ can it be sent?) for each loaded repair: ONE read of the vendor's invoices.
async function paymentExtras(v, loaded) {
  const rows = await PAYS.invoiceRows(v);
  const map = new Map();
  loaded.forEach(({ repair, asset, side }) => {
    const row = PAYS.invoiceOfRepair(rows, { ...repair, asset });
    const ready = Number(repair.cost) > 0 && !!repair.invoiceNo && !!(side && side.invoiceFile);
    const stage = stageOf(repair, side);
    map.set(repair.id, {
      payment: row ? row.payment : (Number(repair.cost) > 0 || repair.invoiceNo ? NOT_SENT : NO_INVOICE),
      invoice: PAYS.safe(row),
      canSendInvoice: !row && ready && STAGES.indexOf(stage) >= 1 && repair.status !== 'Cancelled',
    });
  });
  return { rows, map };
}
// The invoice (bill) sent for a repair that is still alive (not rejected / withdrawn), or null.
async function liveBillOf(v, repairId) {
  const links = await DB.q('SELECT "billId" FROM "AssetRepairBill" WHERE "repairId" = ? AND "vendorId" = ?', [repairId, v.vendorId]).catch(() => []);
  if (!links.length) return null;
  return prisma.vendorBillSubmission.findFirst({ where: { id: { in: links.map((l) => l.billId) }, vendorId: v.vendorId, status: { notIn: ['REJECTED', 'WITHDRAWN'] } } });
}
const PAYMENT_WORDS = /^(paid|paidamount|paymentstatus|payment|status|balance|paystatus|approvalstatus|paidstatus|paidon|paymentdate|bankref|bankreference|utr|transaction|txn|banktxnid)$/i;

// Accounts' own review queue is how the vendor's invoice gets to Accounts (routes/vendorBills.js: "Bills from vendors"): the same row the old
// portal made. Nothing is posted or paid here; an approver approves it, Accounts pays it, the bank statement proves it.
async function sendInvoice(v, req, id, body) {
  if (!v.canEdit) return { status: 403, body: VIEW_ONLY };
  const m = await myRepair(v, id);
  if (!m) return { status: 403, body: NOT_YOUR_REPAIR };
  const bad = Object.keys(body).filter((k) => k !== 'updatedAt');
  if (bad.length) return { status: 400, body: { error: bad.some((k) => PAYMENT_WORDS.test(k)) ? 'A vendor cannot set a payment status. Accounts pays the invoice and the bank statement confirms it.' : 'Nothing needs to be sent with this button.', refusedFields: bad } };
  const { repair, side, asset } = m;
  const stage = stageOf(repair, side);
  if (repair.status === 'Cancelled') return { status: 409, body: { error: 'The company cancelled this repair, so it cannot be changed.' } };
  if (STAGES.indexOf(stage) < 1) return { status: 409, body: { error: 'Send the invoice after the asset has reached you ("Asset received").' } };
  const existing = await liveBillOf(v, repair.id);
  if (existing) return { status: 200, body: { unchanged: true, message: `This invoice was already sent (${existing.billCode}).`, ...(await repairDetail(v, repair.id)) } };
  const cost = ROUND(repair.cost); const gst = ROUND(repair.gstPaid);
  if (!(cost > 0)) return { status: 409, body: { error: 'Enter the final cost (more than 0) before you send the invoice.', field: 'finalCost' } };
  if (!repair.invoiceNo) return { status: 409, body: { error: 'Enter the invoice number before you send the invoice.', field: 'invoiceNo' } };
  if (!(side && side.invoiceFile)) return { status: 409, body: { error: 'Attach the invoice file (PDF, JPG or PNG) before you send the invoice.', field: 'file' } };
  const key = VP.billKey(repair.invoiceNo);
  const dup = await prisma.vendorBillSubmission.findFirst({ where: { vendorId: v.vendorId, billNumberKey: key, status: { notIn: ['REJECTED', 'WITHDRAWN'] } }, select: { billCode: true } });
  if (dup) return { status: 409, body: { error: `Invoice number ${repair.invoiceNo} was already sent (${dup.billCode}).`, field: 'invoiceNo' } };
  const master = await prisma.officeVendor.findUnique({ where: { id: v.vendorId } });
  const by = `${v.name} (vendor ${v.vendorName})`;
  const billDate = VP.YMD.test(repair.repairDate || '') ? repair.repairDate : today();
  await SCH.ensure();
  const prevLinks = (await DB.q('SELECT "billId" FROM "AssetRepairBill" WHERE "repairId" = ?', [repair.id])).map((l) => l.billId);
  const parent = prevLinks.length ? await prisma.vendorBillSubmission.findFirst({ where: { id: { in: prevLinks }, status: 'REJECTED' }, orderBy: { submittedAt: 'desc' } }) : null;
  let bill = null;
  for (let i = 0; i < 5 && !bill; i += 1) {
    try {
      const code = await VP.nextBillCode(); // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      bill = await prisma.$transaction(async (tx) => {
        const b = await tx.vendorBillSubmission.create({
          data: {
            billCode: code, vendorId: v.vendorId, vendorUserId: v.userId, assetId: asset.id, assetCode: asset.assetCode, assetName: asset.name,
            billNumber: repair.invoiceNo, billNumberKey: key, billDate, amount: cost, gst, tds: 0, total: VP.billTotal(cost, gst, 0), remarks: `Repair ${repair.repairNo}${repair.issue ? ` - ${String(repair.issue).slice(0, 200)}` : ''}`,
            documentFile: side.invoiceFile, documentName: side.invoiceName, documentMime: side.invoiceMime, documentSize: side.invoiceSize,
            status: 'PENDING_REVIEW', submittedByName: by, source: 'Vendor Portal', parentSubmissionId: parent ? parent.id : null, version: parent ? (parent.version || 1) + 1 : 1,
            vendorNameSnap: master ? master.name : null, vendorGstinSnap: master ? master.gstin : null, vendorAddressSnap: master ? master.address : null,
          },
        });
        await DB.run('INSERT INTO "AssetRepairBill" ("billId","repairId","assetId","vendorId","createdAt") VALUES (?,?,?,?,?)', [b.id, repair.id, asset.id, v.vendorId, nowIso()], tx);
        await tx.asset.update({ where: { id: asset.id }, data: { history: VP.pushAssetHistory(asset.history, by, `Invoice ${repair.invoiceNo} for repair ${repair.repairNo} sent to Accounts (${b.billCode})`) } });
        return b;
      });
    } catch (err) {
      if (!(err && err.code === 'P2002') || i === 4) throw err;
    }
  }
  await VP.auditReq(req, { assetId: asset.id, vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: 'Bill uploaded', billId: bill.id, documentName: side.invoiceName, status: 'PENDING_REVIEW', newValue: `${bill.billCode} · ${repair.invoiceNo} · ₹${bill.total} · repair ${repair.repairNo}` });
  await logAudit({ action: 'Repair invoice sent to Accounts by vendor', entity: 'AssetRepair', entityId: repair.id, fieldLabel: 'Invoice', toValue: `${bill.billCode} · ${repair.invoiceNo} · ₹${bill.total}`, actorName: `Vendor: ${by}` });
  try {
    const list = await require('./vendorConfig').billReviewers(); // eslint-disable-line global-require
    await require('./notify').notifyUsers(list.map((u) => u.id), { // eslint-disable-line global-require
      title: `Vendor bill ${bill.billCode} waiting for your check`,
      message: `${v.vendorName} sent invoice ${repair.invoiceNo} for repair ${repair.repairNo} (${asset.assetCode}, ₹${bill.total}). Open Office & Accounts → Bills from vendors. It is not paid and not posted.`,
    });
  } catch (err) { console.error('[assets-vendor-portal] notify:', err && err.message); } // eslint-disable-line no-console
  return { status: 201, body: { message: `Invoice sent to Accounts (${bill.billCode}). They will check it and pay it.`, ...(await repairDetail(v, repair.id)) } };
}

// ---- REPAIRS -----------------------------------------------------------------------------------
const REPAIR_SORTS = { dateReported: (r) => r.dateReported || '', repairNo: (r) => r.repairNo, assetCode: (r) => r.assetCode, stage: (r) => STAGES.indexOf(r.stage), finalCost: (r) => r.finalTotal || 0, estimate: (r) => r.estimateTotal || 0 };
async function listRepairs(v, q = {}) {
  const loaded = await loadRepairs(v);
  const px = await paymentExtras(v, loaded);
  const all = loaded.map(({ repair, asset, side }) => repairView(repair, asset, side, px.map.get(repair.id), v));
  const s = str(q.q).toLowerCase();
  const from = VP.YMD.test(str(q.from)) ? str(q.from) : null;
  const to = VP.YMD.test(str(q.to)) ? str(q.to) : null;
  const keep = (r, skip) => (skip === 'stage' || !str(q.stage) || r.stage === str(q.stage))
    && (skip === 'category' || !str(q.category) || r.category === str(q.category))
    && (skip === 'payment' || !str(q.payment) || r.payment.status === str(q.payment))
    && inRange(r.dateReported, from, to)
    && (!s || [r.repairNo, r.assetCode, r.assetName, r.issue, r.invoiceNo, r.stage, r.category, r.serialNumber].some((x) => String(x || '').toLowerCase().includes(s)));
  const rows = all.filter((r) => keep(r));
  const sum = (list, k) => ROUND(list.reduce((t, r) => t + (r[k] || 0), 0));
  return {
    ...paged(rows, q, 'dateReported', REPAIR_SORTS, 'desc'), all: all.length, canEdit: v.canEdit,
    stages: [...STAGES, 'Cancelled'].map((st) => ({ value: st, count: all.filter((r) => r.stage === st).length })),
    facets: { stage: facet(all.filter((r) => keep(r, 'stage')), (r) => r.stage), category: facet(all.filter((r) => keep(r, 'category')), (r) => r.category), payment: facet(all.filter((r) => keep(r, 'payment')), (r) => r.payment.status) },
    summary: { count: all.length, open: all.filter((r) => OPEN_STAGES.includes(r.stage)).length, estimateTotal: sum(all, 'estimateTotal'), finalTotal: sum(all, 'finalTotal') },
  };
}

async function repairDetail(v, id) {
  const m = await myRepair(v, id);
  if (!m) return null;
  const AP = require('./assetPosting'); // eslint-disable-line global-require
  const posted = !!(await AP.bookingsOf(`asset-repair:${m.repair.id}`).catch(() => ({ current: null }))).current;
  const history = await historyFor(v, [m.repair.id]);
  const loadedAll = await loadRepairs(v);
  const px = await paymentExtras(v, loadedAll);
  const view = repairView(m.repair, m.asset, m.side, { inCompanyBooks: posted, ...px.map.get(m.repair.id) }, v);
  // The asset's other repairs (history per asset), newest first.
  const others = loadedAll.filter((x) => x.repair.assetId === m.repair.assetId && x.repair.id !== m.repair.id).map((x) => repairView(x.repair, x.asset, x.side, px.map.get(x.repair.id), v));
  const assetHistory = await historyFor(v, [m.repair.id, ...others.map((o) => o.id)]);
  return { repair: view, history, assetRepairs: others, assetHistory, canEdit: v.canEdit, stages: STAGES };
}

const moneyOf = (raw) => {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return NaN;
  return ROUND(n);
};
const REPAIR_KEYS = ['stage', 'estimateCost', 'estimateGst', 'expectedDate', 'finalCost', 'finalGst', 'invoiceNo', 'remarks', 'updatedAt'];
const sameNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);
const show = (x) => (x == null || x === '' ? '-' : String(x));

async function duplicateInvoice(v, repairId, invoiceNo) {
  if (!invoiceNo) return null;
  const mine = [...await visibleRepairIds(v)].filter((x) => x !== repairId);
  if (!mine.length) return null;
  const rows = await prisma.assetRepair.findMany({ where: { id: { in: mine }, invoiceNo: { not: null } }, select: { id: true, repairNo: true, invoiceNo: true } });
  return rows.find((r) => normName(r.invoiceNo) === normName(invoiceNo)) || null;
}

async function insertEvents(c, v, m, evs) {
  const t = nowIso();
  for (const e of evs) {
    // eslint-disable-next-line no-await-in-loop
    await DB.run('INSERT INTO "AssetRepairEvent" ("id","repairId","assetId","vendorId","vendorUserId","kind","field","fromValue","toValue","note","actorKind","actorName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [newId(), m.repair.id, m.repair.assetId, v.vendorId, v.userId, e.kind, e.field || null, e.from == null ? null : String(e.from).slice(0, 500), e.to == null ? null : String(e.to).slice(0, 500), e.note || null, 'Vendor', `${v.name} (vendor ${v.vendorName})`, t], c);
  }
}
// Writes the side row (insert, or update only the given columns). A row that belongs to ANOTHER vendor is replaced (the repair moved).
async function writeSide(c, v, m, cols) {
  const t = nowIso();
  const cur = await DB.one('SELECT * FROM "AssetRepairVendor" WHERE "repairId" = ?', [m.repair.id], c);
  const by = `${v.name} (vendor ${v.vendorName})`;
  if (!cur || cur.vendorId !== v.vendorId) {
    if (cur) await DB.run('DELETE FROM "AssetRepairVendor" WHERE "repairId" = ?', [m.repair.id], c);
    const base = { stage: null, estimateCost: null, estimateGst: null, estimateAt: null, expectedDate: null, returnedDate: null, vendorRemarks: null, invoiceFile: null, invoiceName: null, invoiceMime: null, invoiceSize: null, invoiceAt: null, invoiceHash: null, ...cols };
    const keys = Object.keys(base);
    await DB.run(`INSERT INTO "AssetRepairVendor" ("repairId","assetId","vendorId",${keys.map((k) => `"${k}"`).join(',')},"lastByName","createdAt","updatedAt") VALUES (?,?,?,${keys.map(() => '?').join(',')},?,?,?)`,
      [m.repair.id, m.repair.assetId, v.vendorId, ...keys.map((k) => base[k]), by, t, t], c);
    return;
  }
  const keys = Object.keys(cols);
  if (keys.length) await DB.run(`UPDATE "AssetRepairVendor" SET ${keys.map((k) => `"${k}" = ?`).join(',')},"lastByName" = ?,"updatedAt" = ? WHERE "repairId" = ?`, [...keys.map((k) => cols[k]), by, t, m.repair.id], c);
  else await DB.run('UPDATE "AssetRepairVendor" SET "lastByName" = ?,"updatedAt" = ? WHERE "repairId" = ?', [by, t, m.repair.id], c);
}

// After a save: the company is told (bell). Accounts reviewers hear about money / invoice changes. Never throws.
async function tellCompany(v, m, { stageChanged, moneyChanged, remarkAdded, wasPosted, newStage }) {
  try {
    const lines = [];
    if (stageChanged) lines.push(`${v.vendorName} moved repair ${m.repair.repairNo} (${m.asset.assetCode}) to "${newStage}".`);
    if (remarkAdded) lines.push(`${v.vendorName} added a remark on repair ${m.repair.repairNo}.`);
    if (lines.length) {
      await MODS.notifyCompany({ creatorId: m.repair.reportedById || null, title: `Repair ${m.repair.repairNo}: ${stageChanged ? newStage : 'new remark'}`, message: lines.join(' ') });
    }
    if (moneyChanged) {
      const VC = require('./vendorConfig'); // eslint-disable-line global-require
      const list = await VC.billReviewers();
      const message = `${v.vendorName} sent cost / invoice details for repair ${m.repair.repairNo} (${m.asset.assetCode}). `
        + `${wasPosted ? 'This repair is ALREADY in the books: your books are not changed; open Fixed Assets > Pending from HRMS to review "Changed in HRMS". ' : 'Open Fixed Assets > Repair cost / Pending from HRMS. '}It is not marked paid.`;
      await require('./notify').notifyUsers(list.map((u) => u.id), { title: `Repair ${m.repair.repairNo}: vendor cost / invoice`, message }); // eslint-disable-line global-require
    }
  } catch (err) { console.error('[assets-vendor-portal] notify:', err && err.message); } // eslint-disable-line no-console
}

// opts (used by the vendor Import, utils/vendorImport.js): dry = check every rule and change NOTHING; quiet = no bell to the company and no big
// answer (the import sends ONE summary instead). A normal save passes nothing and behaves exactly as before.
async function updateRepair(v, req, id, body, opts = {}) {
  if (!v.canEdit) return { status: 403, body: VIEW_ONLY };
  const m = await myRepair(v, id);
  if (!m) return { status: 403, body: NOT_YOUR_REPAIR };
  const bad = Object.keys(body).filter((k) => !REPAIR_KEYS.includes(k));
  if (bad.length) return { status: 400, body: { error: bad.some((k) => PAYMENT_WORDS.test(k)) ? 'A vendor cannot set a payment status. Accounts pays the invoice and the bank statement confirms it.' : 'You can change only: status, estimate, expected date, final cost, GST, invoice number and remarks.', refusedFields: bad } };
  const { repair } = m;
  if (repair.status === 'Cancelled') return { status: 409, body: { error: 'The company cancelled this repair, so it cannot be changed.' } };
  if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(repair.updatedAt).getTime()) {
    return { status: 409, body: { error: 'This repair was changed by someone else just now. Refresh and try again.', stale: true, updatedAt: iso(repair.updatedAt) } };
  }
  const side = m.side;
  const curStage = stageOf(repair, side);
  let newStage = curStage;
  if (body.stage !== undefined && str(body.stage) !== curStage) {
    const want = str(body.stage);
    if (!STAGES.includes(want)) return { status: 400, body: { error: `Pick a proper step: ${STAGES.join(', ')}.`, field: 'stage' } };
    const next = nextStageOf(curStage);
    if (want !== next) {
      return { status: 409, body: { error: next ? `This repair is "${curStage}". The next step is "${next}": steps cannot be skipped or taken back.` : `This repair is already "${curStage}".`, expected: next, field: 'stage' } };
    }
    newStage = want;
  }
  const idx = STAGES.indexOf(newStage);
  const stageChanged = newStage !== curStage;

  // numbers
  const m1 = { estimateCost: moneyOf(body.estimateCost), estimateGst: moneyOf(body.estimateGst), finalCost: moneyOf(body.finalCost), finalGst: moneyOf(body.finalGst) };
  for (const [k, label] of [['estimateCost', 'The estimate'], ['estimateGst', 'The estimate GST'], ['finalCost', 'The final cost'], ['finalGst', 'The GST']]) {
    if (Number.isNaN(m1[k])) return { status: 400, body: { error: `${label} must be a number of 0 or more, like 1500.`, field: k } };
  }
  if (m1.finalCost === null) return { status: 400, body: { error: 'The final cost cannot be blank. Enter 0 if there is no charge.', field: 'finalCost' } };
  const curEst = side && side.estimateCost != null ? Number(side.estimateCost) : null;
  const curEstGst = side && side.estimateGst != null ? Number(side.estimateGst) : null;
  const estCost = m1.estimateCost === undefined ? curEst : m1.estimateCost;
  const estGst = m1.estimateGst === undefined ? curEstGst : m1.estimateGst;
  if (estGst != null && estGst > 0 && (estCost == null || estGst > estCost)) return { status: 400, body: { error: 'The GST cannot be more than the estimate.', field: 'estimateGst' } };
  const estChanged = !sameNum(estCost, curEst) || !sameNum(estGst, curEstGst);
  if (estChanged && idx >= 3) return { status: 409, body: { error: 'The repair is finished, so the estimate is closed.', field: 'estimateCost' } };
  const curFinal = Number(repair.cost) || 0; const curFinalGst = Number(repair.gstPaid) || 0;
  const fCost = m1.finalCost === undefined ? curFinal : m1.finalCost;
  const fGst = m1.finalGst === undefined ? curFinalGst : (m1.finalGst == null ? 0 : m1.finalGst);
  if (fGst > 0 && fGst > fCost) return { status: 400, body: { error: 'The GST cannot be more than the final cost.', field: 'finalGst' } };
  const finalChanged = !sameNum(fCost, curFinal) || !sameNum(fGst, curFinalGst);
  if (finalChanged && idx < 1) return { status: 409, body: { error: 'Enter the final cost after the asset has reached you ("Asset received").', field: 'finalCost' } };

  // dates, invoice number, remark
  let expected = side ? side.expectedDate || null : null;
  if (body.expectedDate !== undefined) {
    const d = str(body.expectedDate);
    if (d && !VP.isRealDay(d)) return { status: 400, body: { error: 'Pick a proper date.', field: 'expectedDate' } };
    if (d && repair.dateReported && VP.YMD.test(repair.dateReported) && d < repair.dateReported) return { status: 400, body: { error: 'The expected date is before the day the problem was reported.', field: 'expectedDate' } };
    expected = d || null;
  }
  let invoiceNo = repair.invoiceNo || null;
  if (body.invoiceNo !== undefined) {
    if (VP.hasHtml(body.invoiceNo)) return { status: 400, body: { error: 'Plain text only in the invoice number.', field: 'invoiceNo' } };
    if (String(body.invoiceNo ?? '').trim().length > 80) return { status: 400, body: { error: 'Keep the invoice number under 80 characters.', field: 'invoiceNo' } };
    invoiceNo = VP.cleanText(body.invoiceNo, 80) || null;
    if (invoiceNo && invoiceNo !== (repair.invoiceNo || null)) {
      const dup = await duplicateInvoice(v, repair.id, invoiceNo);
      if (dup) return { status: 409, body: { error: `Invoice number ${invoiceNo} is already on repair ${dup.repairNo}.`, field: 'invoiceNo' } };
    }
  }
  let remark = null;
  if (body.remarks !== undefined) {
    if (VP.hasHtml(body.remarks)) return { status: 400, body: { error: 'Plain text only in the remarks.', field: 'remarks' } };
    if (String(body.remarks ?? '').trim().length > 1000) return { status: 400, body: { error: 'Keep the remarks under 1000 characters.', field: 'remarks' } };
    remark = VP.cleanText(body.remarks, 1000) || null;
    if (remark && remark === (side ? side.vendorRemarks || null : null)) remark = null; // the same remark again adds nothing
  }

  // what really changes
  const evs = [];
  const data = {}; // AssetRepair
  const cols = {}; // AssetRepairVendor
  if (stageChanged) {
    evs.push({ kind: 'status', field: 'Step', from: curStage, to: newStage, note: remark });
    cols.stage = newStage;
    if (STATUS_OF[newStage] !== repair.status) data.status = STATUS_OF[newStage];
    if (newStage === 'Completed' && !repair.repairDate) data.repairDate = today();
    if (newStage === 'Returned') cols.returnedDate = today();
  }
  if (estChanged) {
    if (!sameNum(estCost, curEst)) evs.push({ kind: 'estimate', field: 'Estimate', from: curEst == null ? null : ROUND(curEst), to: estCost == null ? null : ROUND(estCost) });
    if (!sameNum(estGst, curEstGst)) evs.push({ kind: 'estimate', field: 'Estimate GST', from: curEstGst, to: estGst });
    cols.estimateCost = estCost; cols.estimateGst = estGst; cols.estimateAt = nowIso();
  }
  if (expected !== (side ? side.expectedDate || null : null)) { evs.push({ kind: 'dates', field: 'Expected date', from: side ? side.expectedDate : null, to: expected }); cols.expectedDate = expected; }
  if (!sameNum(fCost, curFinal)) { evs.push({ kind: 'final cost', field: 'Final cost', from: curFinal || null, to: fCost }); data.cost = fCost; }
  if (!sameNum(fGst, curFinalGst)) { evs.push({ kind: 'final cost', field: 'Final GST', from: curFinalGst || null, to: fGst }); data.gstPaid = fGst; }
  if (invoiceNo !== (repair.invoiceNo || null)) { evs.push({ kind: 'invoice', field: 'Invoice no.', from: repair.invoiceNo, to: invoiceNo }); data.invoiceNo = invoiceNo; }
  if (remark) { evs.push({ kind: 'remark', field: 'Remark', from: null, to: remark }); cols.vendorRemarks = remark; }
  if (!evs.length) return { status: 200, body: { changed: [], message: 'Nothing changed.', ...(opts.dry || opts.quiet ? { unchanged: true } : await repairDetail(v, repair.id)) } };
  // the link: an unnamed repair becomes this vendor's (the name is what Accounts shows)
  if (!normName(repair.vendor)) data.vendor = v.vendorName;

  const moneyChanged = ['cost', 'gstPaid', 'invoiceNo'].some((k) => data[k] !== undefined);
  let wasPosted = false;
  if (moneyChanged) {
    const AP = require('./assetPosting'); // eslint-disable-line global-require
    wasPosted = !!(await AP.bookingsOf(`asset-repair:${repair.id}`).catch(() => ({ current: null }))).current;
  }
  let linkedBill = null;
  if (moneyChanged) {
    linkedBill = await liveBillOf(v, repair.id);
    if (linkedBill && linkedBill.status !== 'PENDING_REVIEW') {
      return { status: 409, body: { error: `Invoice ${linkedBill.billCode} is already with Accounts, so the cost and the invoice number cannot be changed now. If it is wrong, ask Accounts to reject it, then correct it and send it again.` } };
    }
    if (linkedBill && (!(fCost > 0) || !invoiceNo)) return { status: 409, body: { error: 'The invoice is with Accounts: keep a final cost above 0 and an invoice number, or ask Accounts to reject the invoice first.' } };
  }
  if (opts.dry) return { status: 200, body: { dry: true, changed: evs.map((e) => e.field), stageChanged, newStage } };
  const by = `${v.name} (vendor ${v.vendorName})`;
  let assetHistory = m.asset.history;
  if (stageChanged) assetHistory = VP.pushAssetHistory(assetHistory, by, `Repair ${repair.repairNo}: ${curStage} -> ${newStage} (vendor ${v.vendorName})${remark ? ` - ${remark}` : ''}`);
  if (data.cost !== undefined || data.gstPaid !== undefined) assetHistory = VP.pushAssetHistory(assetHistory, by, `Repair ${repair.repairNo}: final cost Rs ${fCost}${fGst ? ` + GST Rs ${fGst}` : ''} entered by vendor ${v.vendorName}`);
  await SCH.ensure();
  try {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) {
        const n = await tx.assetRepair.updateMany({ where: { id: repair.id, updatedAt: repair.updatedAt }, data });
        if (!n.count) throw Object.assign(new Error('stale'), { stale: true });
      } else {
        const same = await tx.assetRepair.count({ where: { id: repair.id, updatedAt: repair.updatedAt } });
        if (!same) throw Object.assign(new Error('stale'), { stale: true });
      }
      await writeSide(tx, v, m, cols);
      await insertEvents(tx, v, m, evs);
      if (linkedBill) { // the invoice still waiting in Accounts' queue follows the repair (same bill, never a second one)
        const nb = await tx.vendorBillSubmission.updateMany({
          where: { id: linkedBill.id, status: 'PENDING_REVIEW' },
          data: { amount: fCost, gst: fGst, total: VP.billTotal(fCost, fGst, linkedBill.tds), billNumber: invoiceNo, billNumberKey: VP.billKey(invoiceNo) },
        });
        if (!nb.count) throw Object.assign(new Error('stale'), { stale: true });
      }
      if (assetHistory !== m.asset.history) await tx.asset.update({ where: { id: m.asset.id }, data: { history: assetHistory } });
    });
  } catch (e) {
    if (e && e.stale) return { status: 409, body: { error: 'This repair was changed by someone else just now. Refresh and try again.', stale: true } };
    throw e;
  }
  for (const e of evs) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ action: `Repair ${e.kind} changed by vendor`, entity: 'AssetRepair', entityId: repair.id, fieldLabel: e.field, fromValue: show(e.from), toValue: show(e.to), actorName: `Vendor: ${by}` });
  }
  if (opts.quiet) return { status: 200, body: { changed: evs.map((e) => e.field), message: 'Saved.', stageChanged, moneyChanged, newStage } };
  await tellCompany(v, m, { stageChanged, moneyChanged, remarkAdded: !!remark && !stageChanged, wasPosted, newStage });
  const detail = await repairDetail(v, repair.id);
  const hints = [];
  if (stageChanged && newStage === 'Completed' && !(detail.repair.finalTotal > 0) && !repair.underWarranty) hints.push('Do not forget to add the final cost and the invoice.');
  if (wasPosted && moneyChanged) hints.push('This repair is already in the company\'s books. Your change was sent to Accounts to review; it does not change their books by itself.');
  return { status: 200, body: { changed: evs.map((e) => e.field), message: 'Saved.', hints, ...detail } };
}

// The invoice file of a repair (PDF / JPG / PNG; the caller has already stored it). `stored` = attachments.store() result.
async function attachInvoice(v, req, id, stored, hash, invoiceNo) {
  if (!v.canEdit) { attachments.remove(stored.billFile); return { status: 403, body: VIEW_ONLY }; }
  const m = await myRepair(v, id);
  if (!m) { attachments.remove(stored.billFile); return { status: 403, body: NOT_YOUR_REPAIR }; }
  const { repair, side } = m;
  const stage = stageOf(repair, side);
  const fail = (status, body) => { attachments.remove(stored.billFile); return { status, body }; };
  if (repair.status === 'Cancelled') return fail(409, { error: 'The company cancelled this repair, so it cannot be changed.' });
  if (STAGES.indexOf(stage) < 1) return fail(409, { error: 'Add the invoice after the asset has reached you ("Asset received").' });
  const linkedBill = await liveBillOf(v, repair.id);
  if (linkedBill && linkedBill.status !== 'PENDING_REVIEW') return fail(409, { error: `Invoice ${linkedBill.billCode} is already with Accounts, so the file cannot be replaced now. Ask Accounts to reject it first.` });
  if (side && side.invoiceHash && side.invoiceHash === hash && side.invoiceFile) { attachments.remove(stored.billFile); return { status: 200, body: { changed: [], message: 'Nothing changed. This invoice file is already attached.', ...(await repairDetail(v, repair.id)) } }; }
  let noChange = null;
  if (invoiceNo !== undefined && invoiceNo !== null && String(invoiceNo).trim() !== '') {
    if (VP.hasHtml(invoiceNo) || String(invoiceNo).trim().length > 80) return fail(400, { error: 'Keep the invoice number under 80 characters, plain text only.', field: 'invoiceNo' });
    noChange = VP.cleanText(invoiceNo, 80);
    if (noChange && noChange !== (repair.invoiceNo || null)) {
      const dup = await duplicateInvoice(v, repair.id, noChange);
      if (dup) return fail(409, { error: `Invoice number ${noChange} is already on repair ${dup.repairNo}.`, field: 'invoiceNo' });
    }
  }
  const evs = [{ kind: 'invoice', field: 'Invoice file', from: side && side.invoiceFile ? side.invoiceName : null, to: stored.billName }];
  const data = {};
  if (noChange && noChange !== (repair.invoiceNo || null)) { data.invoiceNo = noChange; evs.push({ kind: 'invoice', field: 'Invoice no.', from: repair.invoiceNo, to: noChange }); }
  if (!normName(repair.vendor)) data.vendor = v.vendorName;
  // The company's own slip is never replaced; a slip that is the vendor's own invoice is kept in step.
  let oldSlip = null; try { oldSlip = repair.slip ? JSON.parse(repair.slip) : null; } catch { oldSlip = null; }
  const oursOld = side && side.invoiceFile ? side.invoiceFile : null;
  if (!oldSlip || !oldSlip.file || (oursOld && oldSlip.file === oursOld)) {
    data.slip = JSON.stringify({ file: stored.billFile, name: stored.billName, mime: stored.billMime, size: stored.billSize, at: VP.stampNow(), by: `${v.name} (vendor ${v.vendorName})` });
  }
  let wasPosted = false;
  {
    const AP = require('./assetPosting'); // eslint-disable-line global-require
    wasPosted = !!(await AP.bookingsOf(`asset-repair:${repair.id}`).catch(() => ({ current: null }))).current;
  }
  await SCH.ensure();
  try {
    await prisma.$transaction(async (tx) => {
      const n = await tx.assetRepair.updateMany({ where: { id: repair.id, updatedAt: repair.updatedAt }, data });
      if (!n.count) throw Object.assign(new Error('stale'), { stale: true });
      await writeSide(tx, v, m, { invoiceFile: stored.billFile, invoiceName: stored.billName, invoiceMime: stored.billMime, invoiceSize: stored.billSize, invoiceAt: nowIso(), invoiceHash: hash });
      if (linkedBill) {
        const nb = await tx.vendorBillSubmission.updateMany({
          where: { id: linkedBill.id, status: 'PENDING_REVIEW' },
          data: { documentFile: stored.billFile, documentName: stored.billName, documentMime: stored.billMime, documentSize: stored.billSize, ...(data.invoiceNo ? { billNumber: data.invoiceNo, billNumberKey: VP.billKey(data.invoiceNo) } : {}) },
        });
        if (!nb.count) throw Object.assign(new Error('stale'), { stale: true });
      }
      await insertEvents(tx, v, m, evs);
    });
  } catch (e) {
    attachments.remove(stored.billFile);
    if (e && e.stale) return { status: 409, body: { error: 'This repair was changed by someone else just now. Refresh and try again.', stale: true } };
    throw e;
  }
  if (oursOld) attachments.remove(oursOld);
  const by = `${v.name} (vendor ${v.vendorName})`;
  for (const e of evs) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ action: 'Repair invoice changed by vendor', entity: 'AssetRepair', entityId: repair.id, fieldLabel: e.field, fromValue: show(e.from), toValue: show(e.to), actorName: `Vendor: ${by}` });
  }
  await tellCompany(v, m, { stageChanged: false, moneyChanged: true, remarkAdded: false, wasPosted, newStage: stage });
  const detail = await repairDetail(v, repair.id);
  return { status: 201, body: { changed: evs.map((e) => e.field), message: 'Invoice attached.', hints: wasPosted ? ['This repair is already in the company\'s books. Your change was sent to Accounts to review; it does not change their books by itself.'] : [], ...detail } };
}

// For the signed download: the invoice file of THIS vendor's repair, or null.
async function ownedRepairInvoice(vendor, id) {
  const m = await myRepair(vendor, id);
  if (!m) return null;
  if (!m.side || !m.side.invoiceFile) {
    // a repair whose bill came through "Upload repair bill" (utils/billUploads.js): the first file of the approved upload
    const up = await require('./billUploads').fileForRepair(vendor.vendorId, m.repair.id).catch(() => null); // eslint-disable-line global-require
    return up ? { ...up, assetId: m.repair.assetId } : null;
  }
  return { file: m.side.invoiceFile, mime: m.side.invoiceMime, name: m.side.invoiceName, assetId: m.repair.assetId };
}

// REPAIR HISTORY page: every change on every repair of this vendor (its own saves and the company's), newest first.
const HIST_KINDS = { approved: 'Approved by the company', withdrawn: 'Withdrawn', 'approval reverted': 'Approval taken back', status: 'Step', estimate: 'Estimate', 'final cost': 'Final cost', invoice: 'Invoice', remark: 'Remark', dates: 'Dates', 'company change': 'Company change', logged: 'Logged' };
async function listHistory(v, q = {}) {
  const ids = (await loadRepairs(v)).map((x) => x.repair.id);
  const all = await historyFor(v, ids);
  const s = str(q.q).toLowerCase();
  const from = VP.YMD.test(str(q.from)) ? str(q.from) : null;
  const to = VP.YMD.test(str(q.to)) ? str(q.to) : null;
  const keep = (e, skip) => (skip === 'kind' || !str(q.kind) || e.kind === str(q.kind)) && inRange(String(e.at || '').slice(0, 10), from, to)
    && (!s || [e.repairNo, e.assetCode, e.assetName, e.field, e.from, e.to, e.note].some((x) => String(x ?? '').toLowerCase().includes(s)));
  const rows = all.filter((e) => keep(e));
  return {
    ...paged(rows, q, 'at', { at: (e) => String(e.at || ''), repairNo: (e) => e.repairNo || '', assetCode: (e) => e.assetCode || '', kind: (e) => e.kind }, 'desc'),
    all: all.length, kinds: facet(all.filter((e) => keep(e, 'kind')), (e) => e.kind).map((k) => ({ ...k, label: HIST_KINDS[k.value] || k.value })),
  };
}

// INVOICES page: every invoice of this vendor - the ones it sent to Accounts (through a repair) and the bills Accounts booked against it - with the
// payment status DERIVED from Accounts (assetVendorPayments.js), plus the repairs whose invoice is ready but not sent yet.
async function listInvoices(v, q = {}) {
  await ensureMask();
  const [rows, loaded] = await Promise.all([PAYS.invoiceRows(v), loadRepairs(v)]);
  const repairNo = new Map(loaded.map((x) => [x.repair.id, x.repair.repairNo]));
  const sentRepairs = new Set(rows.filter((r) => r.repairId && r.payment.status !== PAYS.STATUS.REJECTED).map((r) => r.repairId));
  const all = rows.map((r) => ({ ...PAYS.safe(r), assetCode: r.assetCode ? MK().codeOfCode(r.assetCode) : null, assetName: r.assetName ? MK().text(r.assetName, '') : null, repairNo: r.repairId ? repairNo.get(r.repairId) || null : null, fileRepairId: r.repairId && r.hasDocument ? r.repairId : null }));
  loaded.forEach(({ repair, asset, side }) => { // ready (or started) but not sent: the vendor can see it and send it from the repair
    if (sentRepairs.has(repair.id) || repair.status === 'Cancelled' || !(Number(repair.cost) > 0 || repair.invoiceNo)) return;
    if (rows.some((r) => !r.repairId && PAYS.normRef(r.invoiceNo) === PAYS.normRef(repair.invoiceNo) && repair.invoiceNo)) return;
    all.push({
      key: `rep:${repair.id}`, invoiceNo: repair.invoiceNo || null, billCode: null, billDate: repair.repairDate || repair.dateReported || null, dueDate: null, amount: ROUND(repair.cost), gst: ROUND(repair.gstPaid), tds: 0,
      total: ROUND(Number(repair.cost) + Number(repair.gstPaid || 0)), net: ROUND(Number(repair.cost) + Number(repair.gstPaid || 0)), source: 'Repair', hasDocument: !!(side && side.invoiceFile), rejectionReason: null,
      payment: NOT_SENT, repairId: repair.id, assetCode: MK().code(asset), assetName: MK().text(asset.name, asset.id), repairNo: repair.repairNo, fileRepairId: side && side.invoiceFile ? repair.id : null,
    });
  });
  const s = str(q.q).toLowerCase();
  const from = VP.YMD.test(str(q.from)) ? str(q.from) : null;
  const to = VP.YMD.test(str(q.to)) ? str(q.to) : null;
  const keep = (r, skip) => (skip === 'payment' || !str(q.payment) || r.payment.status === str(q.payment)) && inRange(r.billDate, from, to)
    && (!str(q.file) || (str(q.file) === 'yes') === !!r.hasDocument)
    && (!s || [r.invoiceNo, r.billCode, r.repairNo, r.assetCode, r.assetName].some((x) => String(x || '').toLowerCase().includes(s)));
  const rowsOut = all.filter((r) => keep(r));
  const sorts = { billDate: (r) => r.billDate || '', invoiceNo: (r) => r.invoiceNo || '', total: (r) => r.total || 0, balance: (r) => r.payment.balance || 0, status: (r) => r.payment.status, repairNo: (r) => r.repairNo || '' };
  const live = all.filter((r) => ![PAYS.STATUS.REJECTED, PAYS.STATUS.NOT_SENT].includes(r.payment.status));
  const n = (st) => all.filter((r) => r.payment.status === st).length;
  return {
    ...paged(rowsOut, q, 'billDate', sorts, 'desc'), all: all.length, canEdit: v.canEdit,
    facets: { payment: facet(all.filter((r) => keep(r, 'payment')), (r) => r.payment.status) },
    summary: {
      count: all.length, paid: n(PAYS.STATUS.PAID), pending: n(PAYS.STATUS.PENDING) + n(PAYS.STATUS.WAITING), partlyPaid: n(PAYS.STATUS.PART), overdue: n(PAYS.STATUS.OVERDUE), reversed: n(PAYS.STATUS.REVERSED), notSent: n(PAYS.STATUS.NOT_SENT),
      paidTotal: ROUND(live.reduce((t, r) => t + (r.payment.paidAmount || 0), 0)), outstanding: ROUND(live.reduce((t, r) => t + (r.payment.balance || 0), 0)),
    },
  };
}

// The asset's purchase as Accounts holds it: the invoice of THIS vendor with the asset's invoice number (a stable reference), never the vendor's name alone.
function purchaseOf(a, rows, v) {
  const key = PAYS.normRef(a.invoiceNo);
  const row = key ? rows.find((r) => !r.repairId && PAYS.normRef(r.invoiceNo) === key) : null;
  return {
    invoiceNo: a.invoiceNo || null, purchaseDate: a.purchaseDate || null, ...(v.showAmounts !== false ? { amount: Number(a.purchaseCost) > 0 ? ROUND(a.purchaseCost) : null } : {}),
    invoice: PAYS.safe(row), payment: row ? row.payment : null,
    note: row ? null : (a.invoiceNo ? 'No bill with this invoice number is booked against you in Accounts.' : 'No purchase invoice number is recorded for this asset.'),
  };
}

// ---- ORDERS ------------------------------------------------------------------------------------
// Same one-step-forward rule as the ID-card order screen (routes/vendorModulePortal.js ORDER_FLOW): New -> Received -> Printing -> Ready -> Delivered.
const ORDER_FLOW = ['New', 'Received', 'Printing', 'Ready', 'Delivered'];
const ORDER_STAMP = { Received: 'receivedAt', Printing: 'printingAt', Ready: 'readyAt', Delivered: 'deliveredAt' };
const orderQty = (o) => (o.items || []).reduce((t, i) => t + (Number(i.quantity) || 0), 0);
function orderRow(o) {
  const upd = o.kind === 'order';
  return {
    id: o.id, kind: o.kind, kindText: upd ? 'ID card order' : 'Purchase order document', orderNo: o.poNumber, orderDate: o.orderDate || null, expectedDelivery: o.expectedDelivery || null,
    description: o.description || null, quantity: orderQty(o) || null, amount: o.total == null ? null : o.total, status: o.status, deliveryStatus: o.statusText,
    deliveredOn: o.deliveredOn || null, nextStatus: upd ? ORDER_FLOW[ORDER_FLOW.indexOf(o.status) + 1] || null : null, updatable: upd,
  };
}
const NO_ORDER_INVOICE = { status: 'No invoice yet', tone: 'grey', paidAmount: 0, balance: 0, lastPaymentDate: null, basis: null, overdue: false, dueDate: null, paymentMode: null, note: 'No invoice has been sent for this order.' };
// orderId -> payment of the newest invoice sent for that order (Accounts marks it Paid with the amount and date).
async function orderPayments(v) {
  if (!(await DB.ready())) return new Map();
  const bills = await DB.q('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "orderId" IS NOT NULL ORDER BY "createdAt" DESC', [v.vendorId]);
  const m = new Map();
  bills.forEach((b) => { if (!m.has(b.orderId) && b.status !== 'Rejected') m.set(b.orderId, PAYS.paymentFromModuleBill(b)); });
  return m;
}
async function listOrders(v, q = {}) {
  const [r, pays] = await Promise.all([R.listPurchaseOrders(v.vendorId, q), orderPayments(v)]);
  return { ...r, rows: r.rows.map((o) => ({ ...orderRow(o), payment: pays.get(String(o.id).replace(/^idc:/, '')) || NO_ORDER_INVOICE })), canEdit: v.canEdit };
}
async function orderEvents(orderId) {
  if (!(await DB.ready())) return [];
  const ev = await DB.q('SELECT * FROM "IdCardOrderEvent" WHERE "orderId" = ? ORDER BY "createdAt" ASC', [orderId]);
  return ev.map((e) => ({ id: e.id, from: e.fromStatus, to: e.toStatus, by: e.actorKind === 'Vendor' ? 'You' : 'Company', note: e.note || null, at: DB.toDate(e.createdAt) }));
}
async function orderDetail(v, id) {
  const o = await R.purchaseOrderDetail(v.vendorId, id);
  if (!o) return null;
  const history = o.kind === 'order' ? await orderEvents(String(o.id).replace(/^idc:/, '')) : [];
  const pays = await orderPayments(v);
  return { order: { ...orderRow(o), payment: pays.get(String(o.id).replace(/^idc:/, '')) || NO_ORDER_INVOICE, items: o.items, documents: o.documents || [] }, history, canEdit: v.canEdit, steps: ORDER_FLOW };
}
async function updateOrderStatus(v, req, id, body, opts = {}) {
  if (!v.canEdit) return { status: 403, body: VIEW_ONLY };
  const o = await R.purchaseOrderDetail(v.vendorId, id);
  if (!o) return { status: 403, body: NOT_YOUR_ORDER };
  if (o.kind !== 'order') return { status: 409, body: { error: 'A purchase-order document has no delivery status to update.' } };
  const rawId = String(o.id).replace(/^idc:/, '');
  const row = await DB.one('SELECT * FROM "IdCardOrder" WHERE "id" = ? AND "vendorId" = ?', [rawId, v.vendorId]);
  if (!row) return { status: 403, body: NOT_YOUR_ORDER };
  const bad = Object.keys(body).filter((k) => !['status', 'remarks'].includes(k));
  if (bad.length) return { status: 400, body: { error: 'You can send only the status and a remark.', refusedFields: bad } };
  const want = str(body.status);
  if (!ORDER_FLOW.includes(want)) return { status: 400, body: { error: 'Pick a proper status.', field: 'status' } };
  if (want === row.status) return { status: 200, body: { unchanged: true, message: `Order ${row.orderCode} is already ${want}.`, ...(opts.dry || opts.quiet ? {} : await orderDetail(v, id)) } };
  const next = ORDER_FLOW[ORDER_FLOW.indexOf(row.status) + 1];
  if (!next) return { status: 409, body: { error: 'This order is already Delivered.' } };
  if (want !== next) return { status: 409, body: { error: `This order is ${row.status}. The next step is ${next}: steps cannot be skipped or taken back.`, expected: next } };
  if (VP.hasHtml(body.remarks)) return { status: 400, body: { error: 'Plain text only in the remark.', field: 'remarks' } };
  const remarks = VP.cleanText(body.remarks, 500);
  if (opts.dry) return { status: 200, body: { dry: true, orderCode: row.orderCode, from: row.status, to: want } };
  const t = DB.now();
  const by = `${v.name} (vendor ${v.vendorName})`;
  const n = await DB.run(`UPDATE "IdCardOrder" SET "status" = ?, "${ORDER_STAMP[want]}" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = ?`, [want, t, t, row.id, row.status]);
  if (!n) return { status: 409, body: { error: 'This order was just changed. Refresh and try again.' } };
  await DB.run('INSERT INTO "IdCardOrderEvent" ("id","orderId","fromStatus","toStatus","actorKind","actorName","note","createdAt") VALUES (?,?,?,?,?,?,?,?)', [DB.newId(), row.id, row.status, want, 'Vendor', by, remarks || null, t]);
  await VP.auditReq(req, { vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: 'ID card order status changed', field: 'status', oldValue: row.status, newValue: want, status: row.orderCode });
  if (opts.quiet) return { status: 200, body: { orderCode: row.orderCode, from: row.status, to: want, message: `Order ${row.orderCode} is now ${want}.` } };
  await MODS.notifyCompany({
    creatorId: row.createdById, title: `ID card order ${row.orderCode} is now ${want}`, message: `${v.vendorName} marked ID card order ${row.orderCode} as ${want}.${remarks ? ` Remark: ${remarks}` : ''}`,
    task: { key: `ID cards ${row.orderCode}`, label: want, done: want === 'Delivered' },
  });
  return { status: 200, body: { message: `Order ${row.orderCode} is now ${want}. The company has been told.`, ...(await orderDetail(v, id)) } };
}

// ---- DASHBOARD ---------------------------------------------------------------------------------
async function overview(v) {
  await ensureMask();
  const L = await HS.listing(v);
  const [assets, repairs, orders] = await Promise.all([
    L.where === HS.NONE ? [] : prisma.asset.findMany({ where: L.where, select: { id: true, status: true, category: true } }),
    loadRepairs(v), R.purchaseOrders(v.vendorId),
  ]);
  const px = await paymentExtras(v, repairs);
  const views = repairs.map(({ repair, asset, side }) => repairView(repair, asset, side, px.map.get(repair.id), v));
  const invs = await listInvoices(v, { pageSize: 5 });
  const by = (list, k) => { const m = new Map(); list.forEach((r) => m.set(r[k], (m.get(r[k]) || 0) + 1)); return [...m.entries()].map(([value, count]) => ({ value, count })); };
  const ord = orders.map(orderRow);
  const sum = (k) => ROUND(views.reduce((t, r) => t + (r[k] || 0), 0));
  return {
    assets: { total: assets.length, available: L.availableWhere === HS.NONE ? 0 : await prisma.asset.count({ where: L.availableWhere }), byStatus: by(assets, 'status'), underRepair: views.filter((r) => OPEN_STAGES.slice(1).includes(r.stage)).length },
    orders: { total: ord.length, open: ord.filter((o) => o.updatable && o.status !== 'Delivered').length, delivered: ord.filter((o) => o.status === 'Delivered').length, byStatus: by(ord, 'deliveryStatus') },
    repairs: { waiting: views.filter((r) => r.stage === 'Awaiting repair').length, fromCompany: views.filter((r) => r.fromCompany && r.stage === 'Awaiting repair').length, total: views.length, byStage: [...STAGES, 'Cancelled'].map((st) => ({ value: st, count: views.filter((r) => r.stage === st).length })), open: views.filter((r) => OPEN_STAGES.includes(r.stage)).length, estimateTotal: sum('estimateTotal'), finalTotal: sum('finalTotal') },
    payments: invs.summary,
    recentRepairs: views.slice(0, 5),
    canEdit: v.canEdit,
  };
}

module.exports = {
  kindOfRow, kindOfToken, STAGES, STATUS_OF, CONDITIONS, ORDER_FLOW, stageOf, nextStageOf, normName,
  warrantyOf, amountsOf, showAmountsOf, ensureMask, assetsWhere, ownAssetsWhere, visibleRepairIds, myRepair, myAsset, loadRepairs, listAssets, assetDetail, updateAsset, listRepairs, repairDetail, updateRepair, attachInvoice, ownedRepairInvoice,
  listOrders, orderDetail, updateOrderStatus, overview, listHistory, listInvoices, sendInvoice, liveBillOf,
};

// ---------------------------------------------------------------------------
// LINK AN ACCOUNTS BILL TO ITS VENDOR BY THE VENDOR'S ID (founder, 2026-10-23: the Vendor Portal showed "Nothing here yet").
//
// ROOT CAUSE: the Vendor Portal reads a vendor's bills with `OfficeExpense.vendorId`, but bills booked in Accounts carried the vendor only as
// TEXT (`OfficeExpense.vendor`, "ARV WORKSPACES LLP"); 151 of 152 bills had no vendorId, so every vendor's portal was empty.
//
// THE RULE (deliberately strict - two different vendors are NEVER joined because their names look alike):
//   1. the bill's vendor text equals ONE vendor master record's name or company name, ignoring case, spaces, punctuation and the
//      legal words (Private, Pvt, Limited, Ltd, LLP);   or
//   2. the bill's vendor GSTIN equals the GSTIN of exactly ONE vendor master record.
// Anything else stays unlinked (and is reported); nothing is guessed. Used by the one-time script (scripts/link-expenses-to-vendors.js)
// and by the Prisma hook in db.js, so a bill booked tomorrow is linked the moment it is saved.
// ---------------------------------------------------------------------------
// Assets and ID Card vendors have their own portals, which are protected (they must behave exactly as before), so their bills are never linked here.
const CFG = require('../config/vendorModules');
const protectedKind = (v) => ['it_service', 'id_cards'].includes(CFG.resolveCategory(v && v.category));
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp']);

// 'ARV Workspaces LLP' -> 'arvworkspaces'; 'Zoho Corporation Private Limited' -> 'zohocorporation'
function nameKey(s) {
  const words = String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}
const gstKey = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

// vendors: [{ id, name, companyName, gstin }] -> { byName: Map(key -> id | null when ambiguous), byGst: Map(key -> id | null when ambiguous) }
function indexOf(vendors) {
  const byName = new Map();
  const byGst = new Map();
  const put = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, id); else if (m.get(k) !== id) m.set(k, null); };
  (vendors || []).filter((v) => !protectedKind(v)).forEach((v) => {
    put(byName, nameKey(v.name), v.id);
    put(byName, nameKey(v.companyName), v.id);
    put(byGst, gstKey(v.gstin), v.id);
  });
  return { byName, byGst };
}

// -> the vendor id, or null (no match / ambiguous)
function resolve(index, vendorText, gstin) {
  const n = index.byName.get(nameKey(vendorText));
  if (n) return n;
  const g = gstKey(gstin).length === 15 ? index.byGst.get(gstKey(gstin)) : null;
  return g || null;
}

let cache = { at: 0, index: null };
async function liveIndex(prisma) {
  if (cache.index && Date.now() - cache.at < 60000) return cache.index;
  const vendors = await prisma.officeVendor.findMany({ select: { id: true, name: true, companyName: true, gstin: true, category: true } });
  cache = { at: Date.now(), index: indexOf(vendors) };
  return cache.index;
}
const dropCache = () => { cache = { at: 0, index: null }; };

// Prisma hook (db.js), BEFORE an OfficeExpense is created or updated: link it to its vendor when the rule above finds exactly one.
// An explicit vendorId (a bill approved from the portal) is never overridden. Never throws into the caller (db.js catches).
async function before(prisma, params) {
  const d = params && params.args && params.args.data;
  if (!d || d.vendorId !== undefined) return;
  if (params.action === 'create') {
    if (!d.vendor) return;
    const id = resolve(await liveIndex(prisma), d.vendor, d.vendorGstin);
    if (id) d.vendorId = id;
    return;
  }
  if (typeof d.vendor !== 'string' && d.vendorGstin === undefined) return;
  const cur = await prisma.officeExpense.findUnique({ where: params.args.where, select: { vendor: true, vendorGstin: true, vendorId: true } });
  if (!cur) return;
  const text = d.vendor !== undefined ? d.vendor : cur.vendor;
  const gst = d.vendorGstin !== undefined ? d.vendorGstin : cur.vendorGstin;
  const id = resolve(await liveIndex(prisma), text, gst);
  if (id) { d.vendorId = id; return; }
  // re-pointed to a name that matches no vendor: it must not stay on the old vendor
  if (cur.vendorId && d.vendor !== undefined && nameKey(d.vendor) !== nameKey(cur.vendor)) d.vendorId = null;
}

module.exports = { before, nameKey, gstKey, indexOf, resolve, liveIndex, dropCache };

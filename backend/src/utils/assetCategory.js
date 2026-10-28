// ---------------------------------------------------------------------------
// ONE NAME PER ASSET CATEGORY (founder 2026-10-28: "Mobile" and "Mobile Phone", "Headset" and "Head Set" showed as two categories -
// "duplicates ni teesesi okate pettu").
//
// Every place that SAVES an asset's category (the Assets screen, the asset import, the fixed-asset import) passes it through
// canonicalCategory(): the known twins get one name, and any other spelling that differs only in case / spaces / hyphens
// takes the spelling already in use. scripts/merge-asset-categories.js puts the stored assets right once.
// ---------------------------------------------------------------------------
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// the same thing under two names -> the one name kept
const SAME = {
  headset: 'Headset', // "Head Set", "Head set", "head-set"
  mobile: 'Mobile Phone',
  mobilephone: 'Mobile Phone',
  phonemobile: 'Mobile Phone',
  mobiles: 'Mobile Phone',
  headsets: 'Headset',
};

// raw -> the category name to store. inUse (optional): the category names already stored, so "laptop" becomes "Laptop".
function canonicalCategory(raw, inUse = []) {
  const t = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!t) return t;
  if (SAME[key(t)]) return SAME[key(t)];
  const hit = (inUse || []).find((c) => c && key(c) === key(t));
  return hit || t;
}

// the stored category names (for canonicalCategory's second argument)
async function categoriesInUse(prisma) {
  return (await prisma.asset.findMany({ select: { category: true }, distinct: ['category'] })).map((r) => r.category).filter(Boolean);
}

// READ SIDE (founder 2026-10-28, live "By Category" still showed Mobile and Mobile Phone): until the stored names are merged
// (scripts/merge-asset-categories.js), every screen shows the one name, and a filter on it finds every stored spelling.
// The list / export / options handlers refresh this cache (refreshInUse) before they build their query.
let IN_USE = [];
async function refreshInUse(prisma) { IN_USE = await categoriesInUse(prisma).catch(() => IN_USE); return IN_USE; }
// the stored spellings that are this category ("Mobile Phone" -> ["Mobile Phone", "Mobile"])
function variantsOf(name) {
  const want = canonicalCategory(name);
  return [...new Set([String(name || '').trim(), want, ...IN_USE.filter((c) => canonicalCategory(c) === want)])].filter(Boolean);
}

module.exports = { canonicalCategory, categoriesInUse, refreshInUse, variantsOf, categoryKey: key, SAME };

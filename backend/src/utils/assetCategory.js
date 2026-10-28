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

module.exports = { canonicalCategory, categoriesInUse, categoryKey: key, SAME };

// ---------------------------------------------------------------------------
// WHICH ASSET IS EACH LINE OF THE BILL, AND WHO HAD IT (founder 2026-10-28: "upload cheyagane adhi hand written loo text laga
// tisukoni date and aa date ki ee item konam and adhi avariki assign chesam ani ravali, or assign di rakapoyina present eppudu aa
// assets avari degara undhi ani kuda ravali").
//
// After the bill is read (utils/billUploadAi.js: the date and every line, handwritten or printed), each line is matched to ONE of the
// vendor's assets, strongest evidence first, never a guess between two:
//   1. an asset ID / serial number / repair number written in the line
//   2. the brand AND model of exactly one asset written in the line
//   3. a bill with one line and an asset already chosen for the bill -> that asset
// For the matched asset: who held it ON THE BILL DATE (read from the asset's own HRMS history: "Assigned to X" / "Returned by X"),
// and who holds it NOW. When the history does not say, "Not recorded on that date" and the present holder is shown.
// Read only: nothing is linked or changed here; the review still decides.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const HS = require('./assetHrmsScope');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (s) => norm(s).replace(/ /g, '');
const dayOf = (s) => (s ? String(s).slice(0, 10) : '');

function historyOf(asset) {
  let h = [];
  try { h = JSON.parse(asset.history || '[]'); } catch { h = []; }
  return (Array.isArray(h) ? h : []).filter((e) => e && e.text).map((e) => ({ at: String(e.at || ''), text: String(e.text) }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
// Who held the asset at the end of `day` (YYYY-MM-DD), from its history: { name, since } | { none: true, since } | null (not recorded).
function holderOn(asset, day) {
  if (!day) return null;
  let state = null;
  for (const e of historyOf(asset)) {
    if (dayOf(e.at) > day) break;
    const a = /^assigned to (.+?)(?:\s*\(|$)/i.exec(e.text);
    if (a) { state = { name: a[1].trim(), since: dayOf(e.at) }; continue; } // eslint-disable-line no-continue
    if (/^returned by|unassign|taken back/i.test(e.text)) state = { none: true, since: dayOf(e.at) };
  }
  if (state) return state;
  // no history line before that day: the present holder counts only when HRMS says they had it since before the bill
  if (asset.assignedTo && asset.assignedAt && dayOf(asset.assignedAt.toISOString ? asset.assignedAt.toISOString() : asset.assignedAt) <= day) {
    return { name: asset.assignedTo.name, since: dayOf(asset.assignedAt.toISOString ? asset.assignedAt.toISOString() : asset.assignedAt) };
  }
  return null;
}
const holderNow = (a) => (a.assignedTo ? { name: a.assignedTo.name, employeeCode: a.assignedTo.employeeCode || null, department: a.assignedTo.department || null, since: a.assignedAt ? dayOf(a.assignedAt.toISOString()) : null } : null);

// lines: [{ lineNo, description }]; cands: billUploads.candidatesFor() result; billDate: invoice (or service) date; chosenAssetId: the bill's asset.
async function lineAssets(lines, cands, billDate, chosenAssetId, M = null) {
  const list = (lines || []).filter((l) => l && String(l.description || '').trim());
  if (!list.length) return [];
  const ids = cands.assets.map((a) => a.id);
  const full = new Map((await prisma.asset.findMany({ where: { id: { in: ids } }, include: { assignedTo: { select: { name: true, employeeCode: true, department: true } } } })).map((a) => [a.id, a]));
  const keyed = cands.keysOfAssets.map((c) => ({ id: c.id, keys: [...new Set((c.keys || []).map(compact).filter((k) => k.length >= 4))] }));
  const models = cands.assets.map((a) => { const t = HS.parseType(a.assetType) || {}; return { id: a.id, brand: norm(t.brand), model: norm(t.model) }; }).filter((x) => x.brand && x.model && x.model.length >= 2);
  const out = [];
  for (const l of list) {
    const text = compact(l.description); const words = ` ${norm(l.description)} `;
    let hits = keyed.filter((c) => c.keys.some((k) => text.includes(k))).map((c) => c.id);
    let how = hits.length === 1 ? 'Asset ID / serial number on the bill' : null;
    let several = hits.length > 1;
    if (hits.length !== 1) {
      const byModel = models.filter((x) => words.includes(` ${x.brand} `) && words.includes(` ${x.model} `)).map((x) => x.id);
      if (byModel.length > 1) several = true;
      if (!hits.length && byModel.length === 1) { hits = byModel; how = 'Brand and model on the bill'; }
      else if (hits.length > 1 && byModel.length) { const both = hits.filter((h) => byModel.includes(h)); if (both.length === 1) { hits = both; how = 'Serial and model on the bill'; } }
    }
    if (hits.length !== 1 && list.length === 1 && chosenAssetId && full.has(chosenAssetId)) { hits = [chosenAssetId]; how = 'The asset chosen for this bill'; }
    const a = hits.length === 1 ? full.get(hits[0]) : null;
    const on = a ? holderOn(a, dayOf(billDate)) : null;
    out.push({
      lineNo: l.lineNo, description: l.description,
      asset: a ? { id: a.id, code: M ? M.code(a) : a.assetCode, name: M ? M.text(a.name, a.id) : a.name, category: a.category } : null,
      how, ambiguous: !a && several, billDate: dayOf(billDate) || null,
      onBillDate: a ? (on ? (on.none ? { none: true, since: on.since } : { name: on.name, since: on.since }) : null) : null,
      now: a ? holderNow(a) : null,
    });
  }
  return out;
}

module.exports = { lineAssets, holderOn, historyOf };

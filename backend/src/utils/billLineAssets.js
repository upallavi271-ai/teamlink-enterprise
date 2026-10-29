// ---------------------------------------------------------------------------
// WHICH ASSET IS EACH LINE OF THE BILL, AND WHO HAS IT (founder 2026-10-28: "upload cheyagane adhi hand written loo text laga
// tisukoni date and aa date ki ee item konam and adhi avariki assign chesam ani ravali, or assign di rakapoyina present eppudu aa
// assets avari degara undhi ani kuda ravali"; then "AUTOMATIC ASSET DETECTION FROM IMPORTED BILLS").
//
// After the bill is read (utils/billUploadAi.js: the date and every line - description, item name, brand, model, serial number), each
// line is matched to ONE of the vendor's HRMS assets, strongest evidence first, never a guess between two, never by the item name alone:
//   0. a person's link (VendorBillLineAsset): "Linked by hand" to an asset, or "New asset - pending verification" (no asset)
//   1. the serial number read on the line = an asset's serial / asset ID exactly
//   2. an asset ID / serial number / repair number written in the line's text
//   3. the brand AND model of exactly one asset (the brand / model read on the line, else the words of the line)
//   4. a bill with one line and an asset already chosen for the bill -> that asset
// For the matched asset: who held it ON THE BILL DATE (its own HRMS history: "Assigned to X" / "Returned by X") and who holds it NOW
// (the current HRMS assignee, so a transferred asset shows its present holder). Match status per line:
//   Matched | Linked by hand | Needs review (more than one asset fits) | Unmatched | New asset - pending verification
// READ ONLY: no asset is created, assigned, returned or marked repaired here - HRMS stays the source of truth.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const HS = require('./assetHrmsScope');
const DB = require('./vmDb');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (s) => norm(s).replace(/ /g, '');
const dayOf = (s) => (s ? String(s).slice(0, 10) : '');
const isoDay = (d) => (d ? dayOf(d.toISOString ? d.toISOString() : d) : '');

const MATCH = {
  MATCHED: 'Matched', HAND: 'Linked by hand', REVIEW: 'Needs review', NONE: 'Unmatched', NEW: 'New asset - pending verification',
};

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
  if (asset.assignedTo && asset.assignedAt && isoDay(asset.assignedAt) <= day) return { name: asset.assignedTo.name, since: isoDay(asset.assignedAt) };
  return null;
}
const holderNow = (a) => (a.assignedTo ? { name: a.assignedTo.name, employeeCode: a.assignedTo.employeeCode || null, department: a.assignedTo.department || null, since: a.assignedAt ? isoDay(a.assignedAt) : null } : null);

// The assets with their current holder, by id.
async function assetsById(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.asset.findMany({ where: { id: { in: [...new Set(ids)] } }, include: { assignedTo: { select: { name: true, employeeCode: true, department: true } } } });
  return new Map(rows.map((a) => [a.id, a]));
}

// A person's links for one bill: Map lineNo -> { kind: 'linked' | 'new', assetId, byName, at }. Empty when the table is not there yet.
async function linksOf(uploadId) {
  try {
    const rows = await DB.q('SELECT * FROM "VendorBillLineAsset" WHERE "uploadId" = ?', [uploadId]);
    return new Map(rows.map((r) => [Number(r.lineNo), r]));
  } catch { return new Map(); }
}

// lines: [{ lineNo, description, itemName?, brand?, model?, serialNo?, quantity?, amount? }]; cands: billUploads.candidatesFor();
// billDate: invoice (or service) date; chosenAssetId: the bill's asset; M: the asset masker (vendor view) or null (staff);
// opts.links: linksOf(uploadId) result.
async function lineAssets(lines, cands, billDate, chosenAssetId, M = null, opts = {}) {
  const list = (lines || []).filter((l) => l && (String(l.description || '').trim() || String(l.itemName || '').trim()));
  if (!list.length) return [];
  const links = opts.links || new Map();
  const ids = new Set(cands.assets.map((a) => a.id));
  links.forEach((k) => { if (k.assetId) ids.add(k.assetId); });
  // opts.full: the vendor's assets already loaded (a list screen reuses one load for all its bills); only missing ones are fetched
  const full = new Map(opts.full || []);
  const missing = [...ids].filter((id) => !full.has(id));
  if (missing.length) (await assetsById(missing)).forEach((a, id) => full.set(id, a));
  const keyed = cands.keysOfAssets.map((c) => ({ id: c.id, keys: [...new Set((c.keys || []).map(compact).filter((k) => k.length >= 4))] }));
  const models = cands.assets.map((a) => { const t = HS.parseType(a.assetType) || {}; return { id: a.id, brand: norm(t.brand), model: norm(t.model) }; }).filter((x) => x.brand && x.model && x.model.length >= 2);
  const out = [];
  for (const l of list) {
    const text = compact(`${l.description || ''} ${l.itemName || ''} ${l.serialNo || ''}`);
    const words = ` ${norm(`${l.description || ''} ${l.itemName || ''} ${l.brand || ''} ${l.model || ''}`)} `;
    const hand = links.get(Number(l.lineNo)) || null;
    let hits = [];
    let how = null;
    let several = false;
    if (hand) {
      hits = hand.kind === 'linked' && hand.assetId && full.has(hand.assetId) ? [hand.assetId] : [];
      how = hand.kind === 'new' ? 'Marked as a new asset by a person' : 'Linked by a person';
    } else {
      // 1. the serial number read on the line, exactly
      const sn = compact(l.serialNo);
      if (sn.length >= 4) {
        const exact = keyed.filter((c) => c.keys.includes(sn)).map((c) => c.id);
        if (exact.length === 1) { hits = exact; how = 'Serial number on the bill'; } else if (exact.length > 1) several = true;
      }
      // 2. an asset ID / serial / repair number written in the text
      if (hits.length !== 1) {
        const inText = keyed.filter((c) => c.keys.some((k) => text.includes(k))).map((c) => c.id);
        if (inText.length === 1) { hits = inText; how = 'Asset ID / serial number on the bill'; } else if (inText.length > 1) { hits = inText; several = true; }
      }
      // 3. brand AND model of exactly one asset (what was read on the line, else its words)
      if (hits.length !== 1) {
        const b = norm(l.brand); const m = norm(l.model);
        const byModel = (b && m
          ? models.filter((x) => x.brand === b && (x.model === m || compact(x.model) === compact(m)))
          : models.filter((x) => words.includes(` ${x.brand} `) && words.includes(` ${x.model} `))).map((x) => x.id);
        if (byModel.length > 1) several = true;
        if (!hits.length && byModel.length === 1) { hits = byModel; how = 'Brand and model on the bill'; } else if (hits.length > 1 && byModel.length) {
          const both = hits.filter((h) => byModel.includes(h));
          if (both.length === 1) { hits = both; how = 'Serial and model on the bill'; several = false; }
        }
      }
      // 4. one-line bill with the bill's own asset
      if (hits.length !== 1 && list.length === 1 && chosenAssetId && full.has(chosenAssetId)) { hits = [chosenAssetId]; how = 'The asset chosen for this bill'; several = false; }
    }
    const a = hits.length === 1 ? full.get(hits[0]) : null;
    const on = a ? holderOn(a, dayOf(billDate)) : null;
    let matchStatus;
    if (hand && hand.kind === 'new') matchStatus = MATCH.NEW;
    else if (hand && a) matchStatus = MATCH.HAND;
    else if (a) matchStatus = MATCH.MATCHED;
    else if (several) matchStatus = MATCH.REVIEW;
    else matchStatus = MATCH.NONE;
    out.push({
      lineNo: l.lineNo, description: l.description,
      itemName: l.itemName || l.description || null, brand: l.brand || null, model: l.model || null, serialNo: l.serialNo || null,
      quantity: l.quantity == null ? null : Number(l.quantity), amount: l.amount == null ? null : Number(l.amount),
      asset: a ? {
        id: a.id, code: M ? M.code(a) : a.assetCode, name: M ? M.text(a.name, a.id) : a.name, category: a.category, serial: a.serialNumber || (HS.parseType(a.assetType) || {}).serial || null, status: a.status,
      } : null,
      how, ambiguous: !a && several && !hand, billDate: dayOf(billDate) || null,
      onBillDate: a ? (on ? (on.none ? { none: true, since: on.since } : { name: on.name, since: on.since }) : null) : null,
      now: a ? holderNow(a) : null,
      matchStatus, linkedBy: hand ? { name: hand.byName || null, at: hand.at || null } : null,
    });
  }
  return out;
}

// A short summary of a bill's items for a list row: { count, needsReview, items: [first 3] }.
function summary(rows) {
  const items = (rows || []).slice(0, 3).map((r) => ({
    itemName: r.itemName, assetCode: r.asset ? r.asset.code : null, holder: r.now ? r.now.name : null, employeeCode: r.now ? r.now.employeeCode : null, matchStatus: r.matchStatus,
  }));
  return { count: (rows || []).length, needsReview: (rows || []).filter((r) => [MATCH.REVIEW, MATCH.NONE, MATCH.NEW].includes(r.matchStatus)).length, items };
}

module.exports = {
  lineAssets, holderOn, historyOf, linksOf, summary, assetsById, MATCH,
};

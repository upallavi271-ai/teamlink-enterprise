// ---------------------------------------------------------------------------
// REPAIRS & HRMS TICKETS - STAGE C (founder's Assets Vendor Portal prompt, 27 Oct 2026; built 28 Oct).
//
// What the vendor's side of a repair needed beyond the five steps (utils/assetVendorPortal.js):
//   * ACCEPT / REJECT a repair job (reject needs a reason). Moving to "Asset received" counts as accepting.
//   * THE WORK: parts cost, labour cost, repair start date, the REAL completion date, outcome, work performed, resolution notes.
//     The final cost HRMS / Accounts read stays AssetRepair.cost (the existing "final cost" field); parts + labour are its breakdown.
//   * REPAIR PROOF: photos / documents of the work, every file kept (append-only), never replaced.
//   * REPLACEMENT: the vendor asks for a replacement when the asset cannot be repaired; HRMS (HR / Admin) approves or rejects
//     it, then records the NEW asset. The original asset is never deleted and its id never reused; it gets its final status.
//     An HRMS ticket of kind "Replacement" that the company approves opens the same replacement record (assetComplaints.js).
//   * HRMS TICKETS: every asset ticket raised in HRMS on an asset in this vendor's own set, with its state (Open / Approved / Rejected),
//     so the vendor sees what is coming before a repair job exists. Read only.
//
// Tables (raw SQL, created by utils/assetVendorSchema.js ensure(), ADDITIVE ONLY):
//   AssetRepairWork      repairId primary key = one work row per repair; vendorId says whose it is
//   AssetRepairProof     one row per file, append-only (no UPDATE / DELETE triggers like AssetRepairEvent)
//   AssetReplacement     one row per replacement; (originalAssetId) has at most ONE open (Requested / Approved) row
// Every change also writes an AssetRepairEvent (the repair history) and an audit line; HRMS sees it on Assets > Repairs.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./assetVendorSchema');
const VP = require('./vendorPortal');
const { logAudit } = require('./audit');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}${crypto.randomBytes(12).toString('hex')}`;
const ROUND = (n) => Math.round(Number(n) * 100) / 100;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const OUTCOMES = ['Repaired', 'Partly repaired', 'Could not be repaired', 'Replacement needed', 'No fault found'];
const DECISIONS = ['Accepted', 'Rejected'];
const OPEN_REPLACEMENT = ['Requested', 'Approved'];
const FINAL_STATUSES = ['Retired', 'Scrapped', 'Returned to vendor', 'Spare'];

function moneyOf(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return NaN;
  return ROUND(n);
}
function cleanText(raw, max) {
  if (raw === undefined) return undefined;
  const s = str(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (/[<>]/.test(s)) return { bad: 'Plain words only - no < or > characters.' };
  if (s.length > max) return { bad: `Keep it under ${max} characters.` };
  return s || null;
}
const isDay = (d) => YMD.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime());

// ---- reads --------------------------------------------------------------------------------------------------------
async function workOf(repairIds) {
  await SCH.ensure();
  if (!repairIds.length) return new Map();
  const rows = await DB.q(`SELECT * FROM "AssetRepairWork" WHERE "repairId" IN (${repairIds.map(() => '?').join(',')})`, repairIds);
  return new Map(rows.map((r) => [r.repairId, r]));
}
async function proofsOf(repairIds, vendorId = null) {
  await SCH.ensure();
  if (!repairIds.length) return [];
  const params = [...repairIds];
  let sql = `SELECT "id","repairId","assetId","vendorId","kind","name","mime","size","note","byName","createdAt" FROM "AssetRepairProof" WHERE "repairId" IN (${repairIds.map(() => '?').join(',')})`;
  if (vendorId) { sql += ' AND "vendorId" = ?'; params.push(vendorId); }
  return DB.q(`${sql} ORDER BY "createdAt" ASC`, params);
}
async function replacementsOf({ assetIds = [], repairIds = [] }) {
  await SCH.ensure();
  const parts = []; const params = [];
  if (assetIds.length) { parts.push(`"originalAssetId" IN (${assetIds.map(() => '?').join(',')})`); params.push(...assetIds); }
  if (repairIds.length) { parts.push(`"repairId" IN (${repairIds.map(() => '?').join(',')})`); params.push(...repairIds); }
  if (!parts.length) return [];
  return DB.q(`SELECT * FROM "AssetReplacement" WHERE ${parts.join(' OR ')} ORDER BY "requestedAt" ASC`, params);
}
const replacementView = (r, codeOf = (id) => id) => (r ? {
  id: r.id, status: r.status, reason: r.reason, source: r.source, ticketRef: r.ticketRef || null, repairId: r.repairId || null,
  originalAssetId: r.originalAssetId, originalAssetCode: codeOf(r.originalAssetId), requestedBy: r.requestedByName, requestedAt: r.requestedAt,
  decidedBy: r.decidedByName || null, decidedAt: r.decidedAt || null, decisionNote: r.decisionNote || null, approvalRef: r.approvalRef || null,
  replacementAssetId: r.replacementAssetId || null, replacementAssetCode: r.replacementAssetId ? codeOf(r.replacementAssetId) : null,
  replacementDate: r.replacementDate || null, originalFinalStatus: r.originalFinalStatus || null,
} : null);

// The plain bucket a repair sits in (the tabs of Repairs & HRMS Tickets). `stage` is the vendor step from assetVendorPortal.js.
function bucketOf(stage, work, replacement, billWaiting) {
  if (stage === 'Cancelled') return 'Closed';
  if (work && work.decision === 'Rejected') return 'Closed';
  if (['Completed', 'Returned'].includes(stage)) return billWaiting ? 'Waiting for approval' : 'Completed';
  if (replacement && replacement.status === 'Requested') return 'Waiting for approval';
  if (stage === 'Awaiting repair' && !(work && work.decision === 'Accepted')) return 'Awaiting your action';
  return 'In progress';
}

// What the vendor list / detail shows of the work row (all fields, "null" = not recorded).
function workView(w) {
  if (!w) return { decision: null, decisionReason: null, decisionAt: null, partsCost: null, labourCost: null, startDate: null, completedDate: null, outcome: null, workPerformed: null, resolutionNotes: null };
  return {
    decision: w.decision || null, decisionReason: w.decisionReason || null, decisionAt: w.decisionAt || null,
    partsCost: w.partsCost == null ? null : ROUND(w.partsCost), labourCost: w.labourCost == null ? null : ROUND(w.labourCost),
    startDate: w.startDate || null, completedDate: w.completedDate || null, outcome: w.outcome || null,
    workPerformed: w.workPerformed || null, resolutionNotes: w.resolutionNotes || null,
  };
}

// ---- writes (vendor) ----------------------------------------------------------------------------------------------
async function event(c, v, repair, kind, field, from, to, note) {
  await DB.run('INSERT INTO "AssetRepairEvent" ("id","repairId","assetId","vendorId","vendorUserId","kind","field","fromValue","toValue","note","actorKind","actorName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [newId('are'), repair.id, repair.assetId, v.vendorId, v.userId, kind, field || null, from == null ? null : String(from).slice(0, 500), to == null ? null : String(to).slice(0, 500), note || null, 'Vendor', `${v.name} (vendor ${v.vendorName})`, nowIso()], c);
}
async function upsertWork(c, v, repair, cols) {
  const cur = await DB.one('SELECT * FROM "AssetRepairWork" WHERE "repairId" = ?', [repair.id], c);
  const t = nowIso();
  const by = `${v.name} (vendor ${v.vendorName})`;
  if (!cur) {
    const keys = Object.keys(cols);
    await DB.run(`INSERT INTO "AssetRepairWork" ("repairId","assetId","vendorId",${keys.map((k) => `"${k}"`).join(',')}${keys.length ? ',' : ''}"lastByName","createdAt","updatedAt") VALUES (?,?,?,${keys.map(() => '?').join(',')}${keys.length ? ',' : ''}?,?,?)`,
      [repair.id, repair.assetId, v.vendorId, ...keys.map((k) => cols[k]), by, t, t], c);
    return;
  }
  const keys = Object.keys(cols);
  await DB.run(`UPDATE "AssetRepairWork" SET ${keys.map((k) => `"${k}" = ?`).join(',')}${keys.length ? ',' : ''}"vendorId" = ?,"lastByName" = ?,"updatedAt" = ? WHERE "repairId" = ?`, [...keys.map((k) => cols[k]), v.vendorId, by, t, repair.id], c);
}
async function tell(title, message, creatorId) {
  try { await require('./vendorModules').notifyCompany({ creatorId: creatorId || null, title, message }); } catch (e) { console.error('[repair-work] notify:', e && e.message); } // eslint-disable-line global-require, no-console
}

// m = { repair, asset, side } from assetVendorPortal.myRepair (already checked to be this vendor's own); stage = its current step.
async function decide(v, m, stage, body) {
  if (!v.canEdit) return { status: 403, body: { error: 'Your login is view-only. Ask the company to allow editing.' } };
  const { repair } = m;
  if (repair.status === 'Cancelled') return { status: 409, body: { error: 'The company cancelled this repair, so it cannot be changed.' } };
  const decision = DECISIONS.find((d) => d.toLowerCase() === str(body.decision).toLowerCase());
  if (!decision) return { status: 400, body: { error: 'Choose Accept or Reject.', field: 'decision' } };
  if (stage !== 'Awaiting repair') return { status: 409, body: { error: `This repair is already "${stage}", so it has been accepted.` } };
  const reason = cleanText(body.reason, 500);
  if (reason && reason.bad) return { status: 400, body: { error: reason.bad, field: 'reason' } };
  if (decision === 'Rejected' && (!reason || reason.length < 5)) return { status: 400, body: { error: 'Write why you cannot take this repair (a few words).', field: 'reason' } };
  const [cur] = [...(await workOf([repair.id])).values()];
  if (cur && cur.decision === decision && cur.vendorId === v.vendorId) return { status: 200, body: { message: 'Nothing changed.', unchanged: true } };
  const by = `${v.name} (vendor ${v.vendorName})`;
  await prisma.$transaction(async (tx) => {
    await upsertWork(tx, v, repair, { decision, decisionReason: reason || null, decisionAt: nowIso() });
    await event(tx, v, repair, 'decision', 'Vendor decision', cur ? cur.decision : null, decision, reason || null);
    await tx.asset.update({ where: { id: m.asset.id }, data: { history: VP.pushAssetHistory(m.asset.history, by, `Repair ${repair.repairNo}: vendor ${v.vendorName} ${decision === 'Accepted' ? 'accepted the job' : `cannot take the job - ${reason}`}`) } });
  });
  await logAudit({ action: `Repair ${decision === 'Accepted' ? 'accepted' : 'rejected'} by vendor`, entity: 'AssetRepair', entityId: repair.id, toValue: decision, reason: reason || undefined, actorName: `Vendor: ${by}` });
  await tell(`Repair ${repair.repairNo}: vendor ${decision === 'Accepted' ? 'accepted' : 'cannot take it'}`,
    decision === 'Accepted' ? `${v.vendorName} accepted repair ${repair.repairNo} (${m.asset.assetCode}).` : `${v.vendorName} cannot take repair ${repair.repairNo} (${m.asset.assetCode}): ${reason}. Open Assets > Repairs to send it to another vendor or cancel it.`,
    repair.reportedById);
  return { status: 200, body: { message: decision === 'Accepted' ? 'Accepted. Press "Asset received" when the asset reaches you.' : 'Sent. The company will give the job to someone else or cancel it.' } };
}

const WORK_KEYS = ['partsCost', 'labourCost', 'startDate', 'completedDate', 'outcome', 'workPerformed', 'resolutionNotes'];
async function saveWork(v, m, stage, body) {
  if (!v.canEdit) return { status: 403, body: { error: 'Your login is view-only. Ask the company to allow editing.' } };
  const { repair } = m;
  if (repair.status === 'Cancelled') return { status: 409, body: { error: 'The company cancelled this repair, so it cannot be changed.' } };
  const bad = Object.keys(body).filter((k) => !WORK_KEYS.includes(k));
  if (bad.length) return { status: 400, body: { error: 'You can change only: parts cost, labour cost, start date, completion date, outcome, work done and notes.', refusedFields: bad } };
  const [cur0] = [...(await workOf([repair.id])).values()];
  const cur = cur0 && cur0.vendorId === v.vendorId ? cur0 : null;
  if (cur && cur.decision === 'Rejected') return { status: 409, body: { error: 'You said you cannot take this repair.' } };
  if (stage === 'Awaiting repair') return { status: 409, body: { error: 'Press "Asset received" first, then fill in the work.' } };
  const cols = {}; const evs = [];
  for (const [k, label] of [['partsCost', 'Parts cost'], ['labourCost', 'Labour cost']]) {
    const n = moneyOf(body[k]);
    if (Number.isNaN(n)) return { status: 400, body: { error: `${label} must be a number of 0 or more, like 1500.`, field: k } };
    if (n !== undefined && !((n == null && (cur ? cur[k] : null) == null) || (n != null && cur && cur[k] != null && Math.abs(n - cur[k]) < 0.005))) { cols[k] = n; evs.push([label, cur ? cur[k] : null, n]); }
  }
  for (const [k, label] of [['startDate', 'Repair start date'], ['completedDate', 'Repair completion date']]) {
    if (body[k] === undefined) continue; // eslint-disable-line no-continue
    const d = str(body[k]);
    if (d && !isDay(d)) return { status: 400, body: { error: 'Pick a proper date.', field: k } };
    if (d && d > new Date().toISOString().slice(0, 10)) return { status: 400, body: { error: 'The date cannot be in the future.', field: k } };
    if (d && repair.dateReported && YMD.test(repair.dateReported) && d < repair.dateReported) return { status: 400, body: { error: 'The date is before the day the problem was reported.', field: k } };
    if ((d || null) !== (cur ? cur[k] || null : null)) { cols[k] = d || null; evs.push([label, cur ? cur[k] : null, d || null]); }
  }
  const start = cols.startDate !== undefined ? cols.startDate : (cur ? cur.startDate : null);
  const done = cols.completedDate !== undefined ? cols.completedDate : (cur ? cur.completedDate : null);
  if (start && done && done < start) return { status: 400, body: { error: 'The completion date is before the start date.', field: 'completedDate' } };
  if (cols.completedDate && !['Completed', 'Returned'].includes(stage)) return { status: 409, body: { error: 'Enter the completion date when you press "Repair done" (or after).', field: 'completedDate' } };
  if (body.outcome !== undefined) {
    const o = str(body.outcome) ? OUTCOMES.find((x) => x.toLowerCase() === str(body.outcome).toLowerCase()) : null;
    if (str(body.outcome) && !o) return { status: 400, body: { error: `Pick the outcome: ${OUTCOMES.join(', ')}.`, field: 'outcome' } };
    if ((o || null) !== (cur ? cur.outcome || null : null)) { cols.outcome = o; evs.push(['Outcome', cur ? cur.outcome : null, o]); }
  }
  for (const [k, label, max] of [['workPerformed', 'Work done', 1000], ['resolutionNotes', 'Notes', 1000]]) {
    const t = cleanText(body[k], max);
    if (t && t.bad) return { status: 400, body: { error: t.bad, field: k } };
    if (t !== undefined && (t || null) !== (cur ? cur[k] || null : null)) { cols[k] = t; evs.push([label, cur ? cur[k] : null, t]); }
  }
  if (!evs.length) return { status: 200, body: { message: 'Nothing changed.', unchanged: true } };
  const by = `${v.name} (vendor ${v.vendorName})`;
  // The REAL completion date goes on the HRMS repair (AssetRepair.repairDate), replacing the "today" stamp of "Repair done".
  const repairDate = cols.completedDate !== undefined && cols.completedDate && cols.completedDate !== repair.repairDate ? cols.completedDate : null;
  await prisma.$transaction(async (tx) => {
    await upsertWork(tx, v, repair, cols);
    for (const [field, from, to] of evs) await event(tx, v, repair, 'work', field, from, to); // eslint-disable-line no-await-in-loop
    if (repairDate) await tx.assetRepair.update({ where: { id: repair.id }, data: { repairDate } });
    if (cols.outcome) await tx.asset.update({ where: { id: m.asset.id }, data: { history: VP.pushAssetHistory(m.asset.history, by, `Repair ${repair.repairNo}: outcome "${cols.outcome}" (vendor ${v.vendorName})`) } });
  });
  for (const [field, from, to] of evs) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ action: 'Repair work changed by vendor', entity: 'AssetRepair', entityId: repair.id, fieldLabel: field, fromValue: from == null ? '-' : String(from), toValue: to == null ? '-' : String(to), actorName: `Vendor: ${by}` });
  }
  const hints = [];
  const parts = cols.partsCost !== undefined ? cols.partsCost : (cur ? cur.partsCost : null);
  const labour = cols.labourCost !== undefined ? cols.labourCost : (cur ? cur.labourCost : null);
  const final = Number(repair.cost) || 0;
  if ((parts != null || labour != null) && final > 0 && Math.abs((parts || 0) + (labour || 0) - final) > 0.5) hints.push(`Parts + labour (Rs ${ROUND((parts || 0) + (labour || 0))}) is not the final cost (Rs ${final}). Please check.`);
  return { status: 200, body: { message: 'Saved.', changed: evs.map((e) => e[0]), hints } };
}

// A proof file (photo / document of the work). `stored` = vendorFiles.storeFile() result. Never replaces an earlier file.
async function addProof(v, m, stored, hash, note) {
  const { repair } = m;
  const t = cleanText(note, 300);
  if (t && t.bad) return { status: 400, body: { error: t.bad, field: 'note' } };
  const same = await DB.one('SELECT "id" FROM "AssetRepairProof" WHERE "repairId" = ? AND "hash" = ?', [repair.id, hash]);
  if (same) return { status: 200, body: { message: 'This file is already on the repair.', unchanged: true, removeStored: true } };
  const by = `${v.name} (vendor ${v.vendorName})`;
  await prisma.$transaction(async (tx) => {
    await DB.run('INSERT INTO "AssetRepairProof" ("id","repairId","assetId","vendorId","kind","file","name","mime","size","hash","note","byName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [newId('arp'), repair.id, repair.assetId, v.vendorId, 'proof', stored.billFile, stored.billName, stored.billMime, stored.billSize, hash, t || null, by, nowIso()], tx);
    await event(tx, v, repair, 'proof', 'Repair proof', null, stored.billName, t || null);
  });
  await logAudit({ action: 'Repair proof added by vendor', entity: 'AssetRepair', entityId: repair.id, toValue: stored.billName, actorName: `Vendor: ${by}` });
  return { status: 201, body: { message: 'Proof added.' } };
}
// A replaced invoice file is KEPT as an earlier file of the repair (it used to be deleted from disk).
async function keepEarlierInvoice(c, repair, vendorId, side, byName) {
  if (!side || !side.invoiceFile) return;
  await DB.run('INSERT INTO "AssetRepairProof" ("id","repairId","assetId","vendorId","kind","file","name","mime","size","hash","note","byName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [newId('arp'), repair.id, repair.assetId, vendorId, 'earlier invoice', side.invoiceFile, side.invoiceName || 'invoice', side.invoiceMime || null, side.invoiceSize || null, side.invoiceHash || null, 'Replaced by a newer invoice file', byName, nowIso()], c);
}
async function ownedProofFile(vendorId, repairIds, proofId) {
  await SCH.ensure();
  const p = await DB.one('SELECT * FROM "AssetRepairProof" WHERE "id" = ? AND "vendorId" = ?', [String(proofId || ''), vendorId]);
  if (!p || !repairIds.has(p.repairId)) return null;
  return { file: p.file, mime: p.mime, name: p.name, assetId: p.assetId };
}

async function requestReplacement(v, m, stage, body) {
  if (!v.canEdit) return { status: 403, body: { error: 'Your login is view-only. Ask the company to allow editing.' } };
  const { repair } = m;
  if (repair.status === 'Cancelled') return { status: 409, body: { error: 'The company cancelled this repair, so it cannot be changed.' } };
  if (stage === 'Awaiting repair') return { status: 409, body: { error: 'Press "Asset received" first. Then you can say the asset needs a replacement.' } };
  const reason = cleanText(body.reason, 800);
  if (reason && reason.bad) return { status: 400, body: { error: reason.bad, field: 'reason' } };
  if (!reason || reason.length < 5) return { status: 400, body: { error: 'Write why it cannot be repaired (a few words).', field: 'reason' } };
  await SCH.ensure();
  const open = await DB.one(`SELECT "id","status" FROM "AssetReplacement" WHERE "originalAssetId" = ? AND "status" IN ('Requested','Approved')`, [repair.assetId]);
  if (open) return { status: 409, body: { error: `A replacement for this asset is already ${open.status === 'Requested' ? 'waiting for the company' : 'approved'}.` } };
  const by = `${v.name} (vendor ${v.vendorName})`;
  const id = newId('arx');
  await prisma.$transaction(async (tx) => {
    await DB.run('INSERT INTO "AssetReplacement" ("id","originalAssetId","repairId","vendorId","source","ticketRef","reason","status","requestedByName","requestedAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, repair.assetId, repair.id, v.vendorId, 'Vendor', null, reason, 'Requested', by, nowIso(), nowIso()], tx);
    await upsertWork(tx, v, repair, { outcome: 'Replacement needed' });
    await event(tx, v, repair, 'replacement', 'Replacement', null, 'Requested', reason);
    await tx.asset.update({ where: { id: m.asset.id }, data: { history: VP.pushAssetHistory(m.asset.history, by, `Repair ${repair.repairNo}: vendor ${v.vendorName} says it cannot be repaired - replacement asked (${reason})`) } });
  });
  await logAudit({ action: 'Replacement asked by vendor', entity: 'Asset', entityId: repair.assetId, toValue: 'Requested', reason, actorName: `Vendor: ${by}` });
  await tell(`Replacement asked: ${m.asset.assetCode}`, `${v.vendorName} says ${m.asset.name} (${m.asset.assetCode}) cannot be repaired (repair ${repair.repairNo}): ${reason}. Open Assets > Repairs > Replacements to approve or reject.`, repair.reportedById);
  return { status: 201, body: { message: 'Sent. The company will approve or reject the replacement.' } };
}

// ---- HRMS tickets the vendor may see --------------------------------------------------------------------------------
// Every asset ticket on an asset in this vendor's own set (L = assetHrmsScope.listing(v)). Who raised it: name, ID, department (founder
// 2026-10-27 allows the holder's name, ID, designation and department) - never the ticket thread or anyone's remarks.
async function vendorTickets(v, L, M) {
  await SCH.ensure();
  const assets = await prisma.asset.findMany({ where: L.where, select: { id: true, assetCode: true, name: true, category: true } });
  if (!assets.length) return [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const ids = [...byId.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    rows.push(...await DB.q(`SELECT * FROM "AssetComplaint" WHERE "assetId" IN (${chunk.map(() => '?').join(',')})`, chunk));
  }
  if (!rows.length) return [];
  const recs = new Map((await prisma.employeeRecord.findMany({ where: { id: { in: rows.map((r) => r.ticketId) } }, select: { id: true, status: true, priority: true, employee: { select: { name: true, employeeCode: true, department: true } } } })).map((r) => [r.id, r]));
  const reps = new Map((await prisma.assetRepair.findMany({ where: { id: { in: rows.map((r) => r.repairId).filter(Boolean) } }, select: { id: true, repairNo: true, status: true } })).map((r) => [r.id, r]));
  return rows.map((c) => {
    const a = byId.get(c.assetId) || {}; const r = recs.get(c.ticketId) || {}; const rep = c.repairId ? reps.get(c.repairId) : null;
    return {
      ticketRef: c.ticketRef, kind: c.kind, issue: M.text(c.issue, c.assetId) || null, state: r.status || 'Open', priority: r.priority || null,
      raisedAt: c.raisedAt, decidedAt: c.decidedAt || null, decidedBy: c.decidedRole || null,
      assetId: c.assetId, assetCode: M.code(a), assetName: M.text(a.name, c.assetId) || null, category: a.category || null,
      raisedBy: r.employee ? { name: r.employee.name, employeeCode: r.employee.employeeCode, department: r.employee.department } : null,
      repairId: rep ? rep.id : null, repairNo: rep ? rep.repairNo : null, repairStatus: rep ? rep.status : null,
    };
  }).sort((x, y) => String(y.raisedAt).localeCompare(String(x.raisedAt)));
}

// ---- HRMS side: replacements ------------------------------------------------------------------------------------------
// From an approved HRMS ticket of kind "Replacement" (assetComplaints.onStatusChange): the company itself approved the need.
async function fromApprovedTicket(c, actor) {
  await SCH.ensure();
  const open = await DB.one(`SELECT "id" FROM "AssetReplacement" WHERE "originalAssetId" = ? AND "status" IN ('Requested','Approved')`, [c.assetId]);
  if (open) return { id: open.id, existed: true };
  const id = newId('arx');
  const t = nowIso();
  await DB.run('INSERT INTO "AssetReplacement" ("id","originalAssetId","repairId","vendorId","source","ticketRef","reason","status","requestedByName","requestedAt","decidedByName","decidedAt","decisionNote","approvalRef","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, c.assetId, null, null, 'HRMS ticket', c.ticketRef, c.issue || null, 'Approved', 'Employee (HRMS ticket)', c.raisedAt || t, actor.name, t, 'Approved on the HRMS ticket', c.ticketRef, t]);
  await logAudit({ userId: actor.id || undefined, action: 'Replacement approved (HRMS ticket)', entity: 'Asset', entityId: c.assetId, toValue: `Approved · ${c.ticketRef}` });
  return { id, existed: false };
}

async function listReplacements({ status } = {}) {
  await SCH.ensure();
  const rows = await DB.q(`SELECT * FROM "AssetReplacement"${status ? ' WHERE "status" = ?' : ''} ORDER BY "requestedAt" DESC LIMIT 500`, status ? [status] : []);
  const assetIds = [...new Set(rows.flatMap((r) => [r.originalAssetId, r.replacementAssetId]).filter(Boolean))];
  const assets = new Map((await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, assetCode: true, name: true, status: true } })).map((a) => [a.id, a]));
  const reps = new Map((await prisma.assetRepair.findMany({ where: { id: { in: rows.map((r) => r.repairId).filter(Boolean) } }, select: { id: true, repairNo: true, vendor: true } })).map((r) => [r.id, r]));
  return rows.map((r) => ({
    ...replacementView(r, (id) => (assets.get(id) || {}).assetCode || id),
    originalAssetName: (assets.get(r.originalAssetId) || {}).name || null, repairNo: r.repairId && reps.get(r.repairId) ? reps.get(r.repairId).repairNo : null,
    vendor: r.repairId && reps.get(r.repairId) ? reps.get(r.repairId).vendor || null : null,
  }));
}

async function decideReplacement(user, id, body) {
  await SCH.ensure();
  const r = await DB.one('SELECT * FROM "AssetReplacement" WHERE "id" = ?', [String(id || '')]);
  if (!r) return { status: 404, body: { error: 'That replacement request is not here.' } };
  if (r.status !== 'Requested') return { status: 409, body: { error: `This request is already ${r.status}.` } };
  const approve = body && body.approve === true;
  const note = cleanText(body && body.note, 500);
  if (note && note.bad) return { status: 400, body: { error: note.bad, field: 'note' } };
  if (!approve && (!note || note.length < 3)) return { status: 400, body: { error: 'Write why the replacement is not approved.', field: 'note' } };
  const ref = cleanText(body && body.approvalRef, 80);
  if (ref && ref.bad) return { status: 400, body: { error: ref.bad, field: 'approvalRef' } };
  const name = user.name || user.email || 'HR';
  const status = approve ? 'Approved' : 'Rejected';
  const n = await DB.run(`UPDATE "AssetReplacement" SET "status" = ?, "decidedById" = ?, "decidedByName" = ?, "decidedAt" = ?, "decisionNote" = ?, "approvalRef" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = 'Requested'`,
    [status, user.id, name, nowIso(), note || null, ref || null, nowIso(), r.id]);
  if (!n) return { status: 409, body: { error: 'Someone else decided this just now. Refresh.' } };
  if (r.repairId) {
    await DB.run('INSERT INTO "AssetRepairEvent" ("id","repairId","assetId","vendorId","vendorUserId","kind","field","fromValue","toValue","note","actorKind","actorName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [newId('are'), r.repairId, r.originalAssetId, r.vendorId, null, 'replacement', 'Replacement', 'Requested', status, note || null, 'Company', name, nowIso()]);
  }
  await logAudit({ userId: user.id, action: `Replacement ${status.toLowerCase()}`, entity: 'Asset', entityId: r.originalAssetId, fromValue: 'Requested', toValue: status, reason: note || undefined });
  return { status: 200, body: { message: approve ? 'Approved. When the new asset is ready, record it here.' : 'Not approved. The vendor sees the reason.' } };
}

// The new asset is recorded: the replacement is complete only now. The original keeps its id and gets its final status.
async function completeReplacement(user, id, body) {
  await SCH.ensure();
  const r = await DB.one('SELECT * FROM "AssetReplacement" WHERE "id" = ?', [String(id || '')]);
  if (!r) return { status: 404, body: { error: 'That replacement request is not here.' } };
  if (r.status !== 'Approved') return { status: 409, body: { error: r.status === 'Completed' ? 'This replacement is already complete.' : 'Approve the replacement first.' } };
  const b = body || {};
  const newAsset = await prisma.asset.findFirst({ where: { OR: [{ id: str(b.replacementAssetId) }, { assetCode: str(b.replacementAssetId) }] } });
  if (!newAsset) return { status: 400, body: { error: 'Pick the new asset (its asset code) - add it in Assets first if it is not there yet.', field: 'replacementAssetId' } };
  if (newAsset.id === r.originalAssetId) return { status: 400, body: { error: 'The new asset must be a different asset.', field: 'replacementAssetId' } };
  const taken = await DB.one('SELECT "id" FROM "AssetReplacement" WHERE "replacementAssetId" = ? AND "id" <> ?', [newAsset.id, r.id]);
  if (taken) return { status: 409, body: { error: 'That asset already replaced another asset.', field: 'replacementAssetId' } };
  const day = str(b.replacementDate) || new Date().toISOString().slice(0, 10);
  if (!isDay(day)) return { status: 400, body: { error: 'Pick a proper replacement date.', field: 'replacementDate' } };
  const finalStatus = FINAL_STATUSES.find((s) => s.toLowerCase() === str(b.originalFinalStatus).toLowerCase());
  if (!finalStatus) return { status: 400, body: { error: `What happens to the old asset? ${FINAL_STATUSES.join(', ')}.`, field: 'originalFinalStatus' } };
  const original = await prisma.asset.findUnique({ where: { id: r.originalAssetId } });
  if (!original) return { status: 409, body: { error: 'The original asset is not there any more.' } };
  const name = user.name || user.email || 'HR';
  await prisma.$transaction(async (tx) => {
    const n = await DB.run(`UPDATE "AssetReplacement" SET "status" = 'Completed', "replacementAssetId" = ?, "replacementDate" = ?, "originalFinalStatus" = ?, "completedByName" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = 'Approved'`,
      [newAsset.id, day, finalStatus, name, nowIso(), r.id], tx);
    if (!n) throw Object.assign(new Error('stale'), { stale: true });
    // The original is NOT deleted and keeps its id; its history says what replaced it. The new one says what it replaced.
    await tx.asset.update({ where: { id: original.id }, data: { history: VP.pushAssetHistory(original.history, name, `Replaced by ${newAsset.assetCode} on ${day}${r.ticketRef ? ` (${r.ticketRef})` : ''}; this asset: ${finalStatus}`) } });
    await tx.asset.update({ where: { id: newAsset.id }, data: { history: VP.pushAssetHistory(newAsset.history, name, `Replacement for ${original.assetCode} on ${day}`) } });
    if (r.repairId) {
      await DB.run('INSERT INTO "AssetRepairEvent" ("id","repairId","assetId","vendorId","vendorUserId","kind","field","fromValue","toValue","note","actorKind","actorName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [newId('are'), r.repairId, r.originalAssetId, r.vendorId, null, 'replacement', 'Replacement', 'Approved', `Completed: ${newAsset.assetCode}`, `Old asset: ${finalStatus}`, 'Company', name, nowIso()], tx);
    }
  });
  await logAudit({ userId: user.id, action: 'Replacement completed', entity: 'Asset', entityId: original.id, fromValue: original.assetCode, toValue: `${newAsset.assetCode} (old: ${finalStatus})` });
  return { status: 200, body: { message: `Done. ${original.assetCode} is replaced by ${newAsset.assetCode}. Change the old asset's status in Assets if needed (${finalStatus}).` } };
}

module.exports = {
  OUTCOMES, DECISIONS, FINAL_STATUSES, OPEN_REPLACEMENT, WORK_KEYS,
  workOf, workView, proofsOf, replacementsOf, replacementView, bucketOf,
  decide, saveWork, addProof, keepEarlierInvoice, ownedProofFile, requestReplacement, vendorTickets,
  fromApprovedTicket, listReplacements, decideReplacement, completeReplacement,
};

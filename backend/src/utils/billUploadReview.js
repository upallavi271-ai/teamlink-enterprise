// ---------------------------------------------------------------------------
// VENDOR BILL UPLOADS - ACCOUNTS' SIDE: review, approve, reject, send back, and the SYNC into Accounts + the repair (2026-10-21).
// Routes: routes/vendorBillUploads.js (/api/vendor-bills/uploads/*, same doors as "Bills from vendors").
//
// APPROVAL needs a person with the existing approver right (Super Admin, Admin, or an Accountant with "approve" on Office & Expenses) and:
//   * every 'block' flag gone (invoice number, date, amounts, asset and repair matched, no repair invoice already in Accounts) except
//     a duplicate warning, which the approver may clear by confirming "this is not the same bill" (recorded with name and time)
//   * every 'check' flag corrected or acknowledged by name (unclear handwriting, totals that do not add up, GST rate, vendor name, over the estimate)
// SYNC (after approval, idempotent, re-tried on its own button): ONE VendorBillSubmission (Accounts' "Bills from vendors", already APPROVED) ->
// ONE OfficeExpense payable (exactly the existing approval path and fields) ; the AssetRepairBill link ; the AssetRepair row gets the verified
// invoice no., amounts and repair date. NEVER done: the repair is not marked Completed/Returned, the asset status is not touched, the bill is
// not marked paid (payment comes from the bank statement), no journal is posted here.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./vmDb');
const BU = require('./billUploads');
const AI = require('./billUploadAi');
const V = require('./billOcr/validate');
const OCR = require('./billOcr');
const VP = require('./vendorPortal');
const SCHA = require('./assetVendorSchema');
const { logAudit } = require('./audit');

const S = BU.S;
const ROUND = V.ROUND2;
const nowIso = BU.nowIso;
const office = () => require('../routes/office'); // eslint-disable-line global-require
const AVP = () => require('./assetVendorPortal'); // eslint-disable-line global-require
const flagKey = (f) => `${f.code}:${f.field || ''}`;
const DEFAULT_CATEGORIES = ['Repair & Maintenance', 'Repairs & Maintenance', 'Repair and Maintenance', 'Maintenance'];
const MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];

const actorOf = (user) => ({ id: user.id, name: user.name || user.email || 'Accounts' });

// ---- what stops an approval --------------------------------------------------------------------------------------------------------
// -> [{ key, code, field, level, message, clearable }] ; an empty list = the bill may be approved.
function unresolved(row) {
  const out = [];
  (row.flags || []).forEach((f) => {
    if (f.level !== 'block' && f.level !== 'check') return;
    const key = flagKey(f);
    const acked = (row.acks || []).some((a) => a.key === key && (!f.sig || a.sig === f.sig));
    if (acked) return;
    out.push({ key, code: f.code, field: f.field, level: f.level, message: f.message, clearable: f.level === 'check' || f.code === 'duplicate', sig: f.sig || null });
  });
  return out;
}

// ---- the staff views ----------------------------------------------------------------------------------------------------------------
async function staffRow(row, vendorsById, links) {
  const repair = row.repairId ? links.repairs.get(row.repairId) : null;
  const asset = row.assetId ? links.assets.get(row.assetId) : (repair ? links.assets.get(repair.assetId) : null);
  const v = vendorsById.get(row.vendorId);
  return {
    id: row.id, code: row.code, status: row.status, statusLabel: BU.LABEL[row.status], step: BU.STEP_OF[row.status] ?? 0, version: row.version,
    vendorId: row.vendorId, vendorName: v ? v.name : '', uploadedAt: row.uploadedAt, uploadedByName: row.uploadedByName,
    repairNo: repair ? repair.repairNo : null, assetCode: asset ? asset.assetCode : null, assetName: asset ? asset.name : null,
    invoiceNo: row.invoiceNo, invoiceDate: row.invoiceDate, total: row.total, fileCount: row.fileCount,
    flagCount: (row.flags || []).filter((f) => f.level === 'block' || f.level === 'check').length, aiBadge: row.meta && row.meta.ai === 'done' ? 'AI read' : (row.meta && row.meta.ai ? 'Typed by hand' : null),
    syncedAt: row.syncedAt, syncError: row.syncError,
  };
}

async function staffList(q = {}) {
  await BU.ensure();
  const raw = await DB.q(`SELECT * FROM "VendorBillUpload" WHERE "status" != 'SUPERSEDED' ORDER BY "uploadedAt" DESC LIMIT 3000`);
  const all0 = raw.map(BU.parse);
  const links = await BU.linkMaps(all0);
  const vendors = await prisma.officeVendor.findMany({ where: { id: { in: [...new Set(all0.map((r) => r.vendorId))] } }, select: { id: true, name: true } });
  const vendorsById = new Map(vendors.map((x) => [x.id, x]));
  const all = await Promise.all(all0.map((r) => staffRow(r, vendorsById, links)));
  const str = (x) => (x === undefined || x === null ? '' : String(x).trim());
  const s = str(q.q).toLowerCase();
  const pass = (r, skip) => (skip === 'status' || !str(q.status) || r.status === str(q.status)) && (skip === 'vendor' || !str(q.vendorId) || r.vendorId === str(q.vendorId))
    && (!s || [r.code, r.invoiceNo, r.vendorName, r.repairNo, r.assetCode, r.assetName].some((x) => String(x || '').toLowerCase().includes(s)));
  const count = (list, key, label) => {
    const m = new Map();
    list.forEach((r) => { const k = key(r); if (!k) return; const o = m.get(k) || { value: k, label: label(r), count: 0 }; o.count += 1; m.set(k, o); });
    return [...m.values()];
  };
  const counts = {}; all.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const shown = all.filter((r) => pass(r));
  await BU.itemsOf(shown, all0); // each bill's items: asset name, asset, who has it now, match status (2026-10-28)
  return {
    rows: shown, counts, waiting: all.filter((r) => BU.REVIEW_STATES.includes(r.status)).length,
    facets: { status: count(all.filter((r) => pass(r, 'status')), (r) => r.status, (r) => r.statusLabel), vendor: count(all.filter((r) => pass(r, 'vendor')), (r) => r.vendorId, (r) => r.vendorName) },
    ai: await OCR.status(),
  };
}

async function waitingCount() {
  await BU.ensure();
  const r = await DB.one(`SELECT COUNT(*) AS n FROM "VendorBillUpload" WHERE "status" IN ('NEEDS_REVIEW','PENDING_APPROVAL')`);
  return r.n;
}

async function totalCount() {
  await BU.ensure();
  return (await DB.one(`SELECT COUNT(*) AS n FROM "VendorBillUpload" WHERE "status" != 'SUPERSEDED'`)).n;
}

async function staffDetail(row, { raw = false } = {}) {
  const ls = await BU.lines(row.id);
  const links = await BU.linkMaps([row]);
  const vendor = await BU.vendorOf(row.vendorId);
  const repair = row.repairId ? links.repairs.get(row.repairId) : null;
  const asset = row.assetId ? links.assets.get(row.assetId) : (repair ? links.assets.get(repair.assetId) : null);
  const est = repair ? await DB.one('SELECT "estimateCost","estimateGst" FROM "AssetRepairVendor" WHERE "repairId" = ?', [repair.id]).catch(() => null) : null;
  let submission = null; let expense = null;
  if (row.submissionId) submission = await prisma.vendorBillSubmission.findUnique({ where: { id: row.submissionId }, select: { id: true, billCode: true, status: true } });
  if (row.expenseId) expense = await prisma.officeExpense.findUnique({ where: { id: row.expenseId }, select: { id: true, expenseCode: true, approvalStatus: true, paidStatus: true } });
  const events = await DB.q('SELECT * FROM "VendorBillUploadEvent" WHERE "uploadId" = ? ORDER BY "createdAt" DESC, "id" DESC LIMIT 300', [row.id]);
  const inReview = BU.REVIEW_STATES.includes(row.status);
  let candidates = null;
  if (inReview) {
    const c = await BU.candidatesFor(row.vendorId);
    candidates = {
      repairs: c.repairs.filter((r) => r.status !== 'Cancelled').map((r) => ({ id: r.id, repairNo: r.repairNo, assetId: r.assetId, assetCode: r.asset.assetCode, assetName: r.asset.name, status: r.status, issue: r.issue, invoiceNo: r.invoiceNo })),
      assets: c.assets.map((a) => ({ id: a.id, assetCode: a.assetCode, name: a.name, serialNumber: a.serialNumber })),
    };
  }
  const meta = row.meta || {};
  // each line of the bill -> the asset, who had it on the bill date, who has it now (founder 2026-10-28; utils/billLineAssets.js)
  // + a person's links, and the vendor's assets to link a line to (Accounts: "Link to an asset", automatic asset detection 2026-10-28)
  const BLA = require('./billLineAssets'); // eslint-disable-line global-require
  const vc = await BU.candidatesFor(row.vendorId);
  const lineAssets = await BLA.lineAssets(ls, vc, row.invoiceDate || row.serviceDate, asset ? asset.id : null, null, { links: await BLA.linksOf(row.id) }).catch(() => []);
  const optFull = await BLA.assetsById(vc.assets.map((a) => a.id));
  const assetOptions = [...optFull.values()].map((a) => ({ id: a.id, assetCode: a.assetCode, name: a.name, serialNumber: a.serialNumber || null, status: a.status, holder: a.assignedTo ? a.assignedTo.name : null, employeeCode: a.assignedTo ? a.assignedTo.employeeCode || null : null }))
    .sort((x, y) => String(x.assetCode).localeCompare(String(y.assetCode)));
  const out = {
    lineAssets, assetOptions,
    payment: await BU.paymentOfUpload(row).catch(() => null), // the payment once Accounts has the bill (2026-10-28)
    id: row.id, code: row.code, status: row.status, statusLabel: BU.LABEL[row.status], step: BU.STEP_OF[row.status] ?? 0, steps: BU.STEPS, version: row.version,
    correctsCode: row.supersedes ? ((await DB.one('SELECT "code" FROM "VendorBillUpload" WHERE "id" = ?', [row.supersedes])) || {}).code || null : null,
    updatedAt: row.updatedAt, uploadedAt: row.uploadedAt, uploadedByName: row.uploadedByName, remarks: row.remarks,
    vendor: vendor ? { id: vendor.id, name: vendor.name } : { id: row.vendorId, name: '' },
    repair: repair ? { id: repair.id, repairNo: repair.repairNo, status: repair.status, issue: repair.issue, invoiceNo: repair.invoiceNo, cost: repair.cost, gstPaid: repair.gstPaid, estimateTotal: est && est.estimateCost != null ? ROUND(Number(est.estimateCost) + Number(est.estimateGst || 0)) : null } : null,
    asset: asset ? { id: asset.id, assetCode: asset.assetCode, name: asset.name, serialNumber: asset.serialNumber } : null,
    files: BU.filesView(row), fields: BU.valuesOf(row),
    fieldMeta: Object.fromEntries(BU.FIELD_KEYS.map((k) => [k, { confidence: meta[k] ? meta[k].confidence ?? null : null, unclear: !!(meta[k] && meta[k].unclear && !meta[k].edited), edited: !!(meta[k] && meta[k].edited), by: meta[k] ? meta[k].by || null : null, note: meta[k] ? meta[k].note || null : null, aiValue: meta[k] && meta[k].aiValue !== undefined ? meta[k].aiValue : undefined, derived: !!(meta[k] && meta[k].derived) }])),
    lines: ls.map((l) => ({ lineNo: l.lineNo, description: l.description, itemName: l.itemName || null, brand: l.brand || null, model: l.model || null, serialNo: l.serialNo || null, quantity: l.quantity, rate: l.rate, amount: l.amount, confidence: l.confidence, unclear: !!l.unclear && !l.edited, edited: !!l.edited, note: l.note })),
    flags: (row.flags || []).map((f) => ({ code: f.code, field: f.field, level: f.level, message: f.message, key: flagKey(f), sig: f.sig || null, acked: (row.acks || []).some((a) => a.key === flagKey(f) && (!f.sig || a.sig === f.sig)), duplicates: f.duplicates || undefined })),
    unresolved: unresolved(row),
    ai: { state: meta.ai || null, provider: row.aiProvider, model: row.aiModel, error: row.aiError, notes: row.aiNotes, attempts: row.aiAttempts, reads: row.aiReads, docType: row.docType, finishedAt: row.aiFinishedAt, usage: BU.json(row.aiUsageJson, null) },
    review: { reviewerName: row.reviewerName, reviewedAt: row.reviewedAt, reviewNote: row.reviewNote, rejectionReason: row.rejectionReason, sentBackNote: row.sentBackNote, sentBackAt: row.sentBackAt },
    approval: { approvedAt: row.approvedAt, approvedByName: row.approvedByName, category: row.category, paymentMode: row.paymentMode, dueDate: row.dueDate, duplicateClearedAt: row.duplicateClearedAt },
    sync: { submissionId: row.submissionId, billCode: submission ? submission.billCode : null, expenseId: row.expenseId, expenseCode: expense ? expense.expenseCode : null, expenseStatus: expense ? expense.approvalStatus : null, syncedAt: row.syncedAt, syncError: row.syncError },
    candidates,
    history: events.map((e) => ({ id: e.id, at: e.createdAt, kind: e.kind, field: e.field, from: e.fromValue, to: e.toValue, note: e.note, by: e.actorName || e.actorKind, actorKind: e.actorKind, visibleToVendor: !!e.visibleToVendor })),
    defaultCategory: await defaultCategoryName(),
    modes: MODES,
  };
  if (raw) out.rawAi = BU.json(row.rawJson, null);
  return out;
}

// LINK ONE LINE OF A BILL TO AN HRMS ASSET (automatic asset detection, 2026-10-28). body: { lineNo, kind, assetId }
//   kind 'linked' -> this line is that asset ("Linked by hand"), 'new' -> a newly bought asset, pending verification (no asset is
//   created: it is registered in HRMS Assets the usual way), 'clear' -> back to the automatic reading.
// Changes NOTHING on the asset (no assignment, repair or return): only which asset the bill line is. History + audit.
async function lineAsset(user, id, body = {}) {
  const row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  if (row.status === S.SUPERSEDED) return { status: 409, body: { error: 'This file was replaced by a newer one. Open the newer bill.' } };
  const lineNo = Number(body.lineNo);
  const kind = ['linked', 'new', 'clear'].includes(body.kind) ? body.kind : null;
  if (!kind) return { status: 400, body: { error: 'Say what this line is: an asset, a new asset, or clear.', field: 'kind' } };
  const ls = await BU.lines(row.id);
  const line = ls.find((l) => Number(l.lineNo) === lineNo);
  if (!line) return { status: 404, body: { error: 'That line is not on this bill.', field: 'lineNo' } };
  let asset = null;
  if (kind === 'linked') {
    asset = body.assetId ? await prisma.asset.findUnique({ where: { id: String(body.assetId) } }) : null;
    if (!asset) return { status: 400, body: { error: 'Choose an asset from the list.', field: 'assetId' } };
  }
  const BLA = require('./billLineAssets'); // eslint-disable-line global-require
  const before = (await BLA.linksOf(row.id)).get(lineNo) || null;
  const beforeAsset = before && before.assetId ? await prisma.asset.findUnique({ where: { id: before.assetId }, select: { assetCode: true } }) : null;
  const was = before ? (before.kind === 'new' ? 'New asset - pending verification' : (beforeAsset ? beforeAsset.assetCode : 'an asset')) : 'automatic';
  const to = kind === 'clear' ? 'automatic' : (kind === 'new' ? 'New asset - pending verification' : asset.assetCode);
  const who = actorOf(user);
  await DB.run('DELETE FROM "VendorBillLineAsset" WHERE "uploadId" = ? AND "lineNo" = ?', [row.id, lineNo]);
  if (kind !== 'clear') {
    await DB.run('INSERT INTO "VendorBillLineAsset" ("id","uploadId","lineNo","kind","assetId","byId","byName","at") VALUES (?,?,?,?,?,?,?,?)',
      [BU.newId('la'), row.id, lineNo, kind, asset ? asset.id : null, who.id, who.name, BU.nowIso()]);
  }
  const item = line.itemName || line.description || `line ${lineNo}`;
  await BU.event(undefined, row, {
    kind: 'edit', field: 'line asset', from: `line ${lineNo} (${item}): ${was}`, to: `line ${lineNo} (${item}): ${to}`, actorKind: 'Company', actorName: who.name, actorId: who.id,
    note: kind === 'clear' ? `${who.name} cleared the asset of line ${lineNo}.` : `${who.name} set line ${lineNo} to ${to}.`,
  });
  await logAudit({ userId: user.id, actorName: who.name, action: 'Vendor bill line asset set', entity: 'VendorBillUpload', entityId: row.id, fromValue: `${row.code} line ${lineNo}: ${was}`, toValue: `${row.code} line ${lineNo}: ${to}` });
  return { status: 200, body: { message: kind === 'clear' ? 'Back to the automatic reading.' : 'Saved.', upload: await staffDetail(await BU.getRow(row.id)) } };
}

async function defaultCategoryName() {
  const rows = await prisma.expenseCategory.findMany({ where: { isActive: true }, select: { name: true } }).catch(() => []);
  const names = rows.map((r) => r.name);
  for (const c of DEFAULT_CATEGORIES) { const hit = names.find((n) => n.toLowerCase() === c.toLowerCase()); if (hit) return hit; }
  return DEFAULT_CATEGORIES[0];
}

// ---- reviewer edit -----------------------------------------------------------------------------------------------------------------
async function staffEdit(user, id, body) {
  const row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  if (!BU.REVIEW_STATES.includes(row.status)) return { status: 409, body: { error: `This bill is ${BU.LABEL[row.status].toLowerCase()} and cannot be changed here.` } };
  const allowed = [...BU.FIELD_KEYS, 'lines', 'repairId', 'assetId', 'reviewNote', 'updatedAt'];
  const bad = Object.keys(body).filter((k) => !allowed.includes(k));
  if (bad.length) return { status: 400, body: { error: 'You can change only the bill details, the repair, the asset and a note.', refusedFields: bad } };
  if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(row.updatedAt).getTime()) return { status: 409, body: { error: 'This bill was changed by someone else just now. Open it again.', stale: true } };
  const edit = BU.readEdit(body);
  if (edit.error) return edit.error;
  const extra = { cols: {}, notes: {}, visible: true };
  if (body.reviewNote !== undefined) {
    if (VP.hasHtml(body.reviewNote)) return { status: 400, body: { error: 'Plain text only in the note.', field: 'reviewNote' } };
    extra.cols.reviewNote = V.cleanText(body.reviewNote, 1000) || null;
  }
  if (body.repairId !== undefined || body.assetId !== undefined) {
    const cands = await BU.candidatesFor(row.vendorId);
    let repairId = body.repairId === undefined ? row.repairId : (body.repairId || null);
    let assetId = body.assetId === undefined ? row.assetId : (body.assetId || null);
    if (repairId) {
      const r = cands.repairs.find((x) => x.id === String(repairId));
      if (!r) return { status: 400, body: { error: 'That repair is not one of this vendor\'s repairs.', field: 'repairId' } };
      if (body.repairId !== undefined && body.assetId === undefined) assetId = r.assetId; // choosing the repair chooses its asset
      repairId = r.id;
    }
    if (assetId && !cands.assets.find((a) => a.id === String(assetId))) return { status: 400, body: { error: 'That asset is not one of this vendor\'s assets.', field: 'assetId' } };
    if (body.assetId !== undefined && body.repairId === undefined && repairId) {
      const r = cands.repairs.find((x) => x.id === repairId);
      if (r && r.assetId !== String(assetId)) repairId = null; // a different asset: the old repair choice no longer fits
    }
    extra.cols.repairId = repairId; extra.cols.assetId = assetId || null;
    extra.notes.repairId = 'Accounts chose the repair.'; extra.notes.assetId = 'Accounts chose the asset.';
  }
  const who = { kind: 'Company', ...actorOf(user) };
  const res = await BU.applyEdit(row, edit, who, extra);
  if (res.error) return res.error;
  if (!res.changed.length) return { status: 200, body: { changed: [], message: 'Nothing changed.' } };
  // values changed: earlier acknowledgements (except the duplicate clearance) no longer describe this bill
  const keep = (res.row.acks || []).filter((a) => /^duplicate:/.test(a.key));
  await BU.patch(null, row.id, { acksJson: JSON.stringify(keep) });
  const fresh = await BU.revalidate(row.id);
  await logAudit({ userId: user.id, actorName: who.name, action: 'Vendor bill upload edited by Accounts', entity: 'VendorBillUpload', entityId: row.id, toValue: `${row.code}: ${res.changed.join(', ')}`.slice(0, 900) });
  return { status: 200, body: { changed: res.changed, message: 'Saved.', upload: await staffDetail(fresh) } };
}

// ---- approve / reject / send back / re-read -----------------------------------------------------------------------------------------
async function approve(user, req, id, body = {}) {
  let row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  if ([S.APPROVED, S.SYNCED].includes(row.status)) return { status: 200, body: { unchanged: true, message: `This bill is already ${BU.LABEL[row.status].toLowerCase()}.`, upload: await staffDetail(row) } };
  if (!BU.REVIEW_STATES.includes(row.status)) return { status: 409, body: { error: `This bill is ${BU.LABEL[row.status].toLowerCase()} and cannot be approved.` } };
  if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(row.updatedAt).getTime()) return { status: 409, body: { error: 'This bill was changed by someone else just now. Open it again and check it.', stale: true } };
  // fresh checks (the vendor, the repair or Accounts may have changed things since the screen was opened)
  row = await BU.revalidate(id, { moveStatus: false });
  // a parallel request may have approved it while the checks ran: that is not an error, it is simply done
  if ([S.APPROVED, S.SYNCED].includes(row.status)) return { status: 200, body: { unchanged: true, message: `This bill is already ${BU.LABEL[row.status].toLowerCase()}.`, upload: await staffDetail(row) } };
  if (!BU.REVIEW_STATES.includes(row.status)) return { status: 409, body: { error: `This bill is ${BU.LABEL[row.status].toLowerCase()} and cannot be approved.` } };
  const who = actorOf(user);
  // acknowledgements + duplicate clearance given in this request
  const wantKeys = new Set([].concat(body.acknowledge || []).map(String));
  const acks = [...(row.acks || [])];
  const addAck = (f, kind) => { acks.push({ key: flagKey(f), sig: f.sig || null, by: who.name, byId: who.id, at: nowIso(), kind }); };
  const dupFlag = (row.flags || []).find((f) => f.code === 'duplicate');
  let clearedDup = false;
  for (const f of row.flags || []) {
    if (!(f.level === 'check' || f.code === 'duplicate')) continue; // eslint-disable-line no-continue
    const already = acks.some((a) => a.key === flagKey(f) && (!f.sig || a.sig === f.sig));
    if (already) continue; // eslint-disable-line no-continue
    if (f.code === 'duplicate') { if (body.confirmNotDuplicate === true) { addAck(f, 'not-duplicate'); clearedDup = true; } } else if (wantKeys.has(flagKey(f))) addAck(f, 'checked');
  }
  const withAcks = { ...row, acks };
  const left = unresolved(withAcks);
  if (left.length) {
    return { status: 409, body: { error: `${left.length === 1 ? 'One thing is' : `${left.length} things are`} not settled yet: ${left.slice(0, 3).map((x) => x.message).join(' ')}`, unresolved: left, needsCheck: true } };
  }
  const cat = await office().resolveCategory(user, body.category || (await defaultCategoryName()));
  if (cat.error) return { status: cat.status || 400, body: { error: cat.error, field: 'category' } };
  const mode = MODES.includes(body.paymentMode) ? body.paymentMode : 'Bank Transfer';
  const dueDate = body.dueDate ? String(body.dueDate).trim() : null;
  if (dueDate && !VP.isRealDay(dueDate)) return { status: 400, body: { error: 'Pick a proper due date.', field: 'dueDate' } };
  let n;
  try {
    n = await prisma.$transaction(async (tx) => {
      const k = await BU.move(tx, row.id, row.status, S.APPROVED, {
        acksJson: JSON.stringify(acks), approvedAt: nowIso(), approvedById: who.id, approvedByName: who.name, reviewerId: who.id, reviewerName: who.name, reviewedAt: nowIso(),
        category: cat.name, paymentMode: mode, dueDate, syncError: null,
        ...(clearedDup ? { duplicateClearedById: who.id, duplicateClearedAt: nowIso() } : {}),
        ...(body.reviewNote !== undefined ? { reviewNote: V.cleanText(body.reviewNote, 1000) || null } : {}),
      });
      if (!k) return 0;
      if (clearedDup) await BU.event(tx, row, { kind: 'duplicate-cleared', actorKind: 'Company', actorName: who.name, actorId: who.id, note: `${who.name} confirmed this is not a duplicate of: ${dupFlag && dupFlag.duplicates ? dupFlag.duplicates.map((d) => d.text).join('; ') : 'another bill'}.`, visible: false });
      await BU.event(tx, row, { kind: 'approved', actorKind: 'Company', actorName: who.name, actorId: who.id, note: 'Accounts approved the bill.' });
      return k;
    });
  } catch (e) {
    if (e && /UNIQUE/i.test(String(e.message))) return { status: 409, body: { error: 'A bill with the same invoice number and total, or for the same repair, is already approved. This one cannot be approved too.', duplicate: true } };
    throw e;
  }
  if (!n) {
    const now = await BU.getRow(id);
    if (now && [S.APPROVED, S.SYNCED].includes(now.status)) return { status: 200, body: { unchanged: true, message: `This bill is already ${BU.LABEL[now.status].toLowerCase()}.`, upload: await staffDetail(now) } };
    return { status: 409, body: { error: 'Someone else changed this bill. Open it again.' } };
  }
  await logAudit({ userId: user.id, actorName: who.name, action: 'Vendor bill upload approved', entity: 'VendorBillUpload', entityId: row.id, toValue: `${row.code} · ${row.invoiceNo} · ₹${row.total}`.slice(0, 900) });
  await VP.auditReq(req, { changedById: user.id, actorName: who.name, role: 'Accounts', assetId: row.assetId, vendorId: row.vendorId, action: 'Bill approved', billId: row.id, status: S.APPROVED, newValue: `${row.code} · ${row.invoiceNo}` });
  const sync = await syncApproved(row.id, user, req);
  const fresh = await BU.getRow(row.id);
  tellVendor(fresh, fresh.status === S.SYNCED || fresh.status === S.APPROVED ? 'APPROVED' : null).catch(() => {});
  return { status: 200, body: { message: sync.ok ? 'Approved and sent to Accounts and the repair record.' : `Approved, but the sync did not finish: ${sync.error} Press "Try the sync again".`, sync, upload: await staffDetail(fresh) } };
}

async function reject(user, req, id, body = {}) {
  const row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  const reason = V.cleanText(body.reason, 500);
  if (reason.length < 3) return { status: 400, body: { error: 'Write why the bill is rejected (the vendor will see it).', field: 'reason' } };
  if (!BU.REVIEW_STATES.includes(row.status)) return { status: 409, body: { error: `This bill is ${BU.LABEL[row.status].toLowerCase()} and cannot be rejected.` } };
  const who = actorOf(user);
  const n = await prisma.$transaction(async (tx) => {
    const k = await BU.move(tx, row.id, row.status, S.REJECTED, { rejectionReason: reason, reviewerId: who.id, reviewerName: who.name, reviewedAt: nowIso() });
    if (k) await BU.event(tx, row, { kind: 'rejected', actorKind: 'Company', actorName: who.name, actorId: who.id, note: `Accounts rejected the bill: ${reason}` });
    return k;
  });
  if (!n) return { status: 409, body: { error: 'Someone else changed this bill. Open it again.' } };
  await logAudit({ userId: user.id, actorName: who.name, action: 'Vendor bill upload rejected', entity: 'VendorBillUpload', entityId: row.id, toValue: `${row.code}`, reason });
  await VP.auditReq(req, { changedById: user.id, actorName: who.name, role: 'Accounts', assetId: row.assetId, vendorId: row.vendorId, action: 'Bill rejected', billId: row.id, status: S.REJECTED, newValue: reason.slice(0, 300) });
  const fresh = await BU.getRow(row.id);
  tellVendor(fresh, 'REJECTED', reason).catch(() => {});
  return { status: 200, body: { message: 'Rejected. The vendor will see the reason.', upload: await staffDetail(fresh) } };
}

async function sendBack(user, req, id, body = {}) {
  const row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  const note = V.cleanText(body.note, 500);
  if (note.length < 3) return { status: 400, body: { error: 'Write what the vendor should correct (the vendor will see it).', field: 'note' } };
  if (!BU.REVIEW_STATES.includes(row.status)) return { status: 409, body: { error: `This bill is ${BU.LABEL[row.status].toLowerCase()} and cannot be sent back.` } };
  const who = actorOf(user);
  const n = await prisma.$transaction(async (tx) => {
    const k = await BU.move(tx, row.id, row.status, S.NOT_SENT, { sentBackNote: note, sentBackAt: nowIso(), notifiedAt: null, vendorSeenStatus: null, reviewerId: who.id, reviewerName: who.name, reviewedAt: nowIso() });
    if (k) await BU.event(tx, row, { kind: 'sent-back', actorKind: 'Company', actorName: who.name, actorId: who.id, note: `Accounts sent the bill back: ${note}` });
    return k;
  });
  if (!n) return { status: 409, body: { error: 'Someone else changed this bill. Open it again.' } };
  await logAudit({ userId: user.id, actorName: who.name, action: 'Vendor bill upload sent back', entity: 'VendorBillUpload', entityId: row.id, toValue: row.code, reason: note });
  await VP.auditReq(req, { changedById: user.id, actorName: who.name, role: 'Accounts', assetId: row.assetId, vendorId: row.vendorId, action: 'Bill sent back', billId: row.id, status: S.NOT_SENT, newValue: note.slice(0, 300) });
  return { status: 200, body: { message: 'Sent back to the vendor with your note.', upload: await staffDetail(await BU.getRow(row.id)) } };
}

async function reread(user, id) {
  const row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  const r = await AI.requestReread(row, actorOf(user));
  if (!r.ok) return { status: 409, body: { error: r.error } };
  return { status: 202, body: { message: 'The bill will be read again in a moment.', upload: await staffDetail(await BU.getRow(row.id)) } };
}

// The vendor is told by email (only when the "Vendor emails" switch is on) - never a payment promise.
async function tellVendor(row, to, reason) {
  if (!to) return;
  try {
    const vu = await prisma.vendorUser.findUnique({ where: { id: row.vendorUserId }, select: { email: true, name: true } });
    if (!vu || !vu.email) return;
    const subject = to === 'APPROVED' ? `TeamLink: your bill ${row.invoiceNo || row.code} is approved` : `TeamLink: your bill ${row.invoiceNo || row.code} was rejected`;
    const text = to === 'APPROVED'
      ? `Hello ${vu.name},\n\nYour repair bill ${row.invoiceNo || row.code} (${row.code}) is approved. Payment follows the company's usual process.\n\nTeamLink`
      : `Hello ${vu.name},\n\nYour repair bill ${row.invoiceNo || row.code} (${row.code}) was rejected.\nReason: ${reason}\n\nYou can upload a corrected bill from the Vendor Portal.\n\nTeamLink`;
    await require('./vendorConfig').sendVendorEmail({ to: vu.email, subject, text }); // eslint-disable-line global-require
  } catch (err) { console.error('[bill-upload] tell vendor:', err && err.message); } // eslint-disable-line no-console
}

// ---- THE SYNC ------------------------------------------------------------------------------------------------------------------------
// Idempotent: each phase is skipped when its link already exists, and only ONE call at a time works on a bill (syncStartedAt claim).
async function syncApproved(id, user, req) {
  await SCHA.ensure();
  let row = await BU.getRow(id);
  if (!row) return { ok: false, error: 'Bill not found.' };
  if (row.status === S.SYNCED) return { ok: true, unchanged: true };
  if (row.status !== S.APPROVED) return { ok: false, error: `The bill is ${BU.LABEL[row.status].toLowerCase()}, not approved.` };
  const stale = new Date(Date.now() - 90000).toISOString();
  const claimed = await DB.run('UPDATE "VendorBillUpload" SET "syncStartedAt" = ? WHERE "id" = ? AND "status" = \'APPROVED\' AND ("syncStartedAt" IS NULL OR "syncStartedAt" < ?)', [nowIso(), id, stale]);
  if (!claimed) return { ok: false, busy: true, error: 'The sync is already running. Try again in a moment.' };
  const who = user ? actorOf(user) : { id: row.approvedById, name: row.approvedByName || 'Accounts' };
  try {
    row = await BU.getRow(id);
    const [vendor, repair] = await Promise.all([BU.vendorOf(row.vendorId), prisma.assetRepair.findUnique({ where: { id: String(row.repairId || '') }, include: { asset: true } })]);
    if (!repair) throw new Error('The repair record is missing. Choose the repair and approve again.');
    if (repair.status === 'Cancelled') throw new Error(`Repair ${repair.repairNo} was cancelled.`);
    if (!vendor) throw new Error('The vendor record is missing.');
    const amount = ROUND(row.subtotal); const gst = ROUND(row.gst || 0);
    if (!(amount > 0) || !row.invoiceNo || !row.invoiceDate) throw new Error('The invoice number, date and amount must be filled in.');
    const by = `${who.name} (Accounts)`;
    let wasPosted = false;
    try { const AP = require('./assetPosting'); wasPosted = !!(await AP.bookingsOf(`asset-repair:${repair.id}`)).current; } catch { wasPosted = false; } // eslint-disable-line global-require

    // PHASE A (one transaction): the vendor bill in Accounts' queue + the repair link + the repair figures + history
    let billCode = null; let changes = [];
    if (!row.submissionId) {
      const live = await BU.findDuplicates({ ...row, submissionId: null }, vendor);
      const sameRepair = await prisma.vendorBillSubmission.findFirst({ where: { id: { in: (await DB.q('SELECT "billId" FROM "AssetRepairBill" WHERE "repairId" = ?', [repair.id])).map((l) => l.billId) }, status: { notIn: ['REJECTED', 'WITHDRAWN'] } }, select: { billCode: true } });
      if (sameRepair) throw new Error(`Repair ${repair.repairNo} already has an invoice in Accounts (${sameRepair.billCode}).`);
      const sameBill = live.find((d) => d.kind === 'bill' || d.kind === 'expense');
      if (sameBill && !(row.acks || []).some((a) => /^duplicate:/.test(a.key))) throw new Error(`Another bill with this invoice number exists (${sameBill.text}).`);
      const files = row.files || [];
      const first = files[0];
      const support = files.slice(1).map((f) => ({ file: f.file, name: f.name, mime: f.mime, size: f.size, at: nowIso() }));
      const side = await DB.one('SELECT * FROM "AssetRepairVendor" WHERE "repairId" = ?', [repair.id]);
      const set = (data, k, val, label) => { if (!(typeof val === 'number' ? Math.abs(Number(repair[k] || 0) - val) < 0.005 : (repair[k] || null) === (val || null))) { data[k] = val; changes.push({ field: label, from: repair[k], to: val }); } };
      const rdata = {};
      set(rdata, 'cost', amount, 'Final cost'); set(rdata, 'gstPaid', gst, 'Final GST'); set(rdata, 'invoiceNo', row.invoiceNo, 'Invoice no.');
      if (row.serviceDate) set(rdata, 'repairDate', row.serviceDate, 'Repair date');
      if (!String(repair.vendor || '').trim()) set(rdata, 'vendor', vendor.name, 'Vendor');
      // WHOSE ASSET WAS REPAIRED (founder 2026-10-28: "aa recruiter di repair chesam ani ravali"): the employee holding it on the bill /
      // repair date (HRMS history), else the present holder - written on the repair and in the asset's history.
      const heldBy = await (async () => {
        const a = await prisma.asset.findUnique({ where: { id: repair.assetId }, include: { assignedTo: { select: { name: true, employeeCode: true, department: true } } } });
        if (!a) return null;
        const day = String(row.serviceDate || row.invoiceDate || '').slice(0, 10);
        const on = require('./billLineAssets').holderOn(a, day); // eslint-disable-line global-require
        if (on && !on.none) return `${on.name}${a.assignedTo && a.assignedTo.name === on.name ? ` (${[a.assignedTo.employeeCode, a.assignedTo.department].filter(Boolean).join(', ')})` : ''}`;
        if (on && on.none) return null;
        return a.assignedTo ? `${a.assignedTo.name} (${[a.assignedTo.employeeCode, a.assignedTo.department].filter(Boolean).join(', ')})` : null;
      })().catch(() => null);
      const forWhom = heldBy ? ` - asset with ${heldBy}` : '';
      if (!repair.notes && row.workDescription) set(rdata, 'notes', `Work done (vendor bill ${row.invoiceNo}): ${row.workDescription}${forWhom}`.slice(0, 1000), 'Notes');
      else if (heldBy && !String(repair.notes || '').includes(heldBy)) set(rdata, 'notes', `${repair.notes ? `${repair.notes} | ` : ''}Repaired while the asset was with ${heldBy}`.slice(0, 1000), 'Notes');
      let oldSlip = null; try { oldSlip = repair.slip ? JSON.parse(repair.slip) : null; } catch { oldSlip = null; }
      if (!oldSlip || !oldSlip.file) { rdata.slip = JSON.stringify({ file: first.file, name: first.name, mime: first.mime, size: first.size, at: VP.stampNow(), by }); changes.push({ field: 'Invoice file', from: null, to: first.name }); }
      let sub = null;
      for (let i = 0; i < 6 && !sub; i += 1) {
        try {
          const code = await VP.nextBillCode(); // eslint-disable-line no-await-in-loop
          // eslint-disable-next-line no-await-in-loop
          sub = await prisma.$transaction(async (tx) => {
            const b = await tx.vendorBillSubmission.create({
              data: {
                billCode: code, vendorId: row.vendorId, vendorUserId: row.vendorUserId, assetId: repair.assetId, assetCode: repair.asset.assetCode, assetName: repair.asset.name,
                billNumber: row.invoiceNo, billNumberKey: VP.billKey(row.invoiceNo), billDate: row.invoiceDate, amount, gst, tds: 0, total: VP.billTotal(amount, gst, 0),
                remarks: `Repair ${repair.repairNo}${row.workDescription ? ` - ${String(row.workDescription).slice(0, 200)}` : ''}${forWhom} (uploaded bill ${row.code})`,
                documentFile: first.file, documentName: first.name, documentMime: first.mime, documentSize: first.size, supportingDocs: JSON.stringify(support),
                status: 'APPROVED', reviewRemarks: row.reviewNote || null, reviewedById: row.approvedById, reviewedByName: row.approvedByName, reviewedAt: new Date(), submittedByName: row.uploadedByName,
                source: 'Vendor Portal', idempotencyKey: `bu:${row.id}`, vendorNameSnap: vendor.name, vendorGstinSnap: vendor.gstin || null, vendorAddressSnap: vendor.address || null,
              },
            });
            await DB.run('INSERT OR IGNORE INTO "AssetRepairBill" ("billId","repairId","assetId","vendorId","createdAt") VALUES (?,?,?,?,?)', [b.id, repair.id, repair.assetId, row.vendorId, nowIso()], tx);
            if (Object.keys(rdata).length) await tx.assetRepair.update({ where: { id: repair.id }, data: rdata });
            const t = nowIso();
            const evs = [...changes.map((c) => ({ kind: c.field === 'Repair date' ? 'dates' : (c.field === 'Invoice no.' || c.field === 'Invoice file' ? 'invoice' : 'final cost'), field: c.field, from: c.from, to: c.to })), { kind: 'invoice', field: 'Vendor bill', from: null, to: `${row.code} · ${b.billCode}`, note: 'Vendor bill approved by Accounts' }];
            for (const e of evs) {
              // eslint-disable-next-line no-await-in-loop
              await DB.run('INSERT INTO "AssetRepairEvent" ("id","repairId","assetId","vendorId","vendorUserId","kind","field","fromValue","toValue","note","actorKind","actorName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [BU.newId('are'), repair.id, repair.assetId, row.vendorId, null, e.kind, e.field, e.from == null ? null : String(e.from).slice(0, 500), e.to == null ? null : String(e.to).slice(0, 500), e.note || null, 'Company', by, t], tx);
            }
            await tx.asset.update({ where: { id: repair.assetId }, data: { history: VP.pushAssetHistory(repair.asset.history, by, `Repair ${repair.repairNo}: vendor bill ${row.invoiceNo} approved (${b.billCode}); cost Rs ${amount}${gst ? ` + GST Rs ${gst}` : ''}${forWhom}`) } });
            const k = await BU.patch(tx, row.id, { submissionId: b.id }, [S.APPROVED], { submissionId: null });
            if (!k) throw Object.assign(new Error('already linked'), { code: 'LINKED' });
            await BU.event(tx, row, { kind: 'submission-created', actorKind: 'System', actorName: 'TeamLink', note: `Vendor bill ${b.billCode} created.`, visible: false });
            return b;
          });
        } catch (err) {
          if (err && err.code === 'P2002' && /idempotency|vendorUserId/i.test(String(err.meta && err.meta.target))) { sub = await prisma.vendorBillSubmission.findFirst({ where: { vendorUserId: row.vendorUserId, idempotencyKey: `bu:${row.id}` } }); if (sub) await BU.patch(null, row.id, { submissionId: sub.id }, [S.APPROVED], { submissionId: null }); } else if (!(err && err.code === 'P2002')) throw err;
        }
      }
      if (!sub) throw new Error('Could not create the bill in Accounts. Try again.');
      billCode = sub.billCode;
      row = await BU.getRow(id);
    }
    const subRow = await prisma.vendorBillSubmission.findUnique({ where: { id: row.submissionId } });
    billCode = subRow.billCode;

    // PHASE B: the payable (OfficeExpense), exactly the fields the existing approval creates
    let expenseId = row.expenseId || subRow.expenseId || null;
    if (!expenseId) {
      const marker = `[bill-upload:${row.code}]`;
      let expense = await prisma.officeExpense.findFirst({ where: { notes: { contains: marker } } });
      if (!expense) {
        const rate = (x) => (amount > 0 && x > 0 ? ROUND((x / amount) * 100) : null);
        expense = await office().createWithCode({
          category: row.category || (await defaultCategoryName()),
          monthlyAmount: ROUND(amount + gst), gstAmount: gst, tdsAmount: 0, gstRatePct: rate(gst), tdsRatePct: null,
          vendor: vendor.name, vendorGstin: vendor.gstin || null, vendorId: row.vendorId, vendorAddress: vendor.address || null, vendorPan: vendor.pan || null,
          expenseDate: row.invoiceDate, dueDate: row.dueDate || null, billNumber: row.invoiceNo,
          description: `Repair bill ${row.invoiceNo} — ${repair.repairNo} ${repair.asset.assetCode} ${repair.asset.name}${row.workDescription ? ` — ${row.workDescription}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 500),
          notes: `From the Vendor Portal bill upload ${row.code} (${billCode}), repair ${repair.repairNo}, asset ${repair.asset.assetCode}. ${marker}`,
          remarks: row.reviewNote || null, reportingTags: 'Vendor Portal', paymentMode: row.paymentMode || 'Bank Transfer', recurring: false, frequency: 'One-Time', entryKind: 'expense',
          approvalStatus: 'PENDING', paidStatus: 'Unpaid', createdById: row.approvedById, updatedById: row.approvedById,
        });
        await logAudit({
          userId: row.approvedById, actorName: row.approvedByName, action: 'Expense Created', entity: 'OfficeExpense', entityId: expense.id, fromValue: '— (new)',
          toValue: `${expense.expenseCode || expense.id} · ${row.invoiceDate} · ${expense.category} · ${expense.vendor} · ${row.paymentMode || 'Bank Transfer'} · amount ₹${amount} + GST ₹${gst} = ₹${ROUND(amount + gst)} · Pending · from Vendor Portal ${billCode} (bill upload ${row.code})`.slice(0, 900),
          approvalStatus: 'PENDING',
        });
        require('./vendorPosting').syncExpense(expense.id, { id: row.approvedById, name: row.approvedByName }).catch((e) => console.error('[vendor-post]', e && e.message)); // eslint-disable-line global-require, no-console
      }
      expenseId = expense.id;
    }
    // PHASE C: link the payable to the bill and to the upload (UNIQUE on both), then finish
    await prisma.$transaction(async (tx) => {
      await tx.vendorBillSubmission.updateMany({ where: { id: row.submissionId, expenseId: null }, data: { expenseId } });
      await BU.patch(tx, row.id, { expenseId }, [S.APPROVED], { expenseId: null });
    });
    const done = await prisma.$transaction(async (tx) => {
      const k = await BU.move(tx, row.id, S.APPROVED, S.SYNCED, { syncedAt: nowIso(), syncError: null, syncStartedAt: null });
      if (k) await BU.event(tx, row, { kind: 'synced', actorKind: 'System', actorName: 'TeamLink', note: `Added to your invoices (${billCode}). Payment is decided by Accounts and confirmed by the bank statement.` });
      return k;
    });
    await logAudit({ userId: who.id, actorName: who.name, action: 'Vendor bill upload synced', entity: 'VendorBillUpload', entityId: row.id, toValue: `${row.code} → ${billCode}${changes.length ? ` · repair ${repair.repairNo}: ${changes.map((c) => c.field).join(', ')}` : ''}`.slice(0, 900) });
    // The repair was already in the company's books and its figures changed: Accounts reviews the "Changed in HRMS" line (its own mechanism)
    if (wasPosted && changes.some((c) => ['Final cost', 'Final GST', 'Invoice no.'].includes(c.field))) {
      try {
        const list = await require('./vendorConfig').billReviewers('repairCost'); // eslint-disable-line global-require
        await require('./notify').notifyUsers(list.map((u) => u.id), { // eslint-disable-line global-require
          title: `Repair ${repair.repairNo}: vendor cost / invoice`,
          message: `An approved vendor bill (${row.code}) changed the cost / invoice of repair ${repair.repairNo} (${repair.asset.assetCode}). This repair is ALREADY in the books: your books are not changed; open Fixed Assets > Pending from HRMS to review "Changed in HRMS". It is not marked paid.`,
        });
      } catch (err) { console.error('[bill-upload] notify:', err && err.message); } // eslint-disable-line no-console
    }
    return { ok: !!done || true, billCode, expenseId, changes: changes.map((c) => c.field) };
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 300);
    await DB.run('UPDATE "VendorBillUpload" SET "syncStartedAt" = NULL, "syncError" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = \'APPROVED\'', [msg, nowIso(), id]).catch(() => {});
    await BU.event(null, row, { kind: 'sync-failed', actorKind: 'System', actorName: 'TeamLink', note: msg, visible: false }).catch(() => {});
    console.error('[bill-upload] sync:', msg); // eslint-disable-line no-console
    return { ok: false, error: msg };
  }
}

async function retrySync(user, req, id) {
  const row = await BU.getRow(id);
  if (!row) return { status: 404, body: { error: 'Bill not found.' } };
  if (row.status === S.SYNCED) return { status: 200, body: { unchanged: true, message: 'Already synced.', upload: await staffDetail(row) } };
  if (row.status !== S.APPROVED) return { status: 409, body: { error: `This bill is ${BU.LABEL[row.status].toLowerCase()}, so there is nothing to sync.` } };
  const r = await syncApproved(id, user, req);
  return { status: r.ok ? 200 : 409, body: { ...(r.ok ? { message: 'Synced.' } : { error: r.error }), sync: r, upload: await staffDetail(await BU.getRow(id)) } };
}

module.exports = { unresolved, flagKey, staffList, waitingCount, totalCount, staffDetail, staffEdit, lineAsset, approve, reject, sendBack, reread, syncApproved, retrySync, defaultCategoryName, MODES, tellVendor, actorOf };

// ---------------------------------------------------------------------------
// VENDOR BILL UPLOADS - THE CORE (2026-10-21). Routes: routes/assetBillUploads.js (the vendor) and routes/vendorBillUploads.js (Accounts).
// AI reading + the job queue: utils/billUploadAi.js. Approve / reject / send back / sync into Accounts: utils/billUploadReview.js.
//
// WHAT THIS IS: an asset-repair vendor uploads a photo / scan / PDF of a bill (handwritten or printed). The bill is stored untouched, read by
// AI in the background (never inside the upload request), the result is CHECKED (arithmetic, dates, GST, asset match, duplicates, vendor name,
// estimate), and a person in Accounts verifies it. NOTHING is auto-approved: even a perfectly clear bill waits in "Waiting for approval".
// Only after an authorised approval does the data go to Accounts (the existing payables path) and to the repair record.
//
// STATUS MACHINE (server-enforced, every change is a compare-and-set on the old status):
//   NOT_SENT ("Not sent yet") -> UPLOADED -> AI_PROCESSING -> NEEDS_REVIEW | PENDING_APPROVAL -> APPROVED | REJECTED ; APPROVED -> SYNCED
//   NEEDS_REVIEW <-> PENDING_APPROVAL (after a correction), review states -> NOT_SENT (sent back to the vendor), -> UPLOADED (read again)
//   any state before approval -> SUPERSEDED (the vendor replaced the file: a new upload, version + 1)
// The word "Draft" is never shown: NOT_SENT reads "Not sent yet".
//
// WHO SEES WHAT: a vendor sees only its OWN uploads (vendorId from the session, never from the request), the fields, a few plain notices and
// the history written for it. It never sees the AI's raw answer, the model, confidences, internal reviewer notes or anything of Accounts.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./billUploadSchema');
const V = require('./billOcr/validate');
const F = require('./billUploadFiles');
const attachments = require('./attachments');
const VP = require('./vendorPortal');
const HS = require('./assetHrmsScope');

const nowIso = () => new Date().toISOString();
const todayIso = () => new Date().toISOString().slice(0, 10);
const newId = (p = 'bu') => `${p}${crypto.randomBytes(12).toString('hex')}`;
const ROUND = V.ROUND2;

// ---- statuses ---------------------------------------------------------------------------------------------------------------------
const S = {
  NOT_SENT: 'NOT_SENT', UPLOADED: 'UPLOADED', AI_PROCESSING: 'AI_PROCESSING', NEEDS_REVIEW: 'NEEDS_REVIEW', PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED', REJECTED: 'REJECTED', SYNCED: 'SYNCED', SUPERSEDED: 'SUPERSEDED',
};
const LABEL = {
  NOT_SENT: 'Not sent yet', UPLOADED: 'Uploaded', AI_PROCESSING: 'AI is reading it', NEEDS_REVIEW: 'Needs review', PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved', REJECTED: 'Rejected', SYNCED: 'Synced to Accounts', SUPERSEDED: 'Replaced by a newer file',
};
// the small stepper: Not sent yet -> Uploaded -> AI reading -> Needs review / Waiting for approval -> Approved -> Synced
const STEPS = ['Not sent yet', 'Uploaded', 'AI reading', 'Needs review / Waiting for approval', 'Approved', 'Synced'];
const STEP_OF = { NOT_SENT: 0, UPLOADED: 1, AI_PROCESSING: 2, NEEDS_REVIEW: 3, PENDING_APPROVAL: 3, REJECTED: 3, APPROVED: 4, SYNCED: 5, SUPERSEDED: 0 };
const ALLOWED = {
  NOT_SENT: ['UPLOADED', 'SUPERSEDED'],
  UPLOADED: ['AI_PROCESSING', 'NEEDS_REVIEW', 'PENDING_APPROVAL', 'SUPERSEDED'],
  AI_PROCESSING: ['NEEDS_REVIEW', 'PENDING_APPROVAL', 'UPLOADED', 'SUPERSEDED'],
  NEEDS_REVIEW: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'NOT_SENT', 'UPLOADED', 'SUPERSEDED'],
  PENDING_APPROVAL: ['NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'NOT_SENT', 'UPLOADED', 'SUPERSEDED'],
  APPROVED: ['SYNCED'],
  REJECTED: [],
  SYNCED: [],
  SUPERSEDED: [],
};
const canMove = (from, to) => (ALLOWED[from] || []).includes(to);
const VENDOR_EDITABLE = [S.NOT_SENT, S.UPLOADED, S.NEEDS_REVIEW, S.PENDING_APPROVAL];
const REVIEW_STATES = [S.NEEDS_REVIEW, S.PENDING_APPROVAL];
const DEAD = [S.REJECTED, S.SUPERSEDED];

const COLS = new Set(['code', 'vendorUserId', 'uploadedByName', 'repairId', 'assetId', 'status', 'rootId', 'supersedes', 'version', 'filesJson', 'fileCount', 'contentHash', 'remarks', 'idemKey',
  'invoiceNo', 'invoiceNoKey', 'invoiceDate', 'serviceDate', 'assetRef', 'vendorNameOnBill', 'subtotal', 'gst', 'cgst', 'sgst', 'igst', 'total', 'currency', 'workDescription', 'docType',
  'rawJson', 'metaJson', 'flagsJson', 'acksJson', 'aiNotes', 'aiProvider', 'aiModel', 'aiAttempts', 'aiReads', 'aiRunId', 'aiStartedAt', 'aiFinishedAt', 'aiError', 'aiUsageJson',
  'sentBackNote', 'sentBackAt', 'reviewerId', 'reviewerName', 'reviewedAt', 'reviewNote', 'rejectionReason', 'approvedAt', 'approvedById', 'approvedByName', 'duplicateClearedById',
  'duplicateClearedAt', 'category', 'paymentMode', 'dueDate', 'syncStartedAt', 'syncedAt', 'syncError', 'submissionId', 'expenseId', 'notifiedAt', 'vendorSeenStatus', 'uploadedAt']);

const json = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const parse = (row) => (row ? {
  ...row, files: json(row.filesJson, []), flags: json(row.flagsJson, []), acks: json(row.acksJson, []), meta: json(row.metaJson, {}),
} : null);

async function ensure() { await SCH.ensure(); }
async function getRow(id, c) { return parse(await DB.one('SELECT * FROM "VendorBillUpload" WHERE "id" = ?', [String(id || '')], c)); }
async function lines(id, c) { return DB.q('SELECT * FROM "VendorBillUploadLine" WHERE "uploadId" = ? ORDER BY "lineNo" ASC', [id], c); }

// UPDATE ... WHERE id = ? [AND status IN (from)] ; returns the number of rows changed (0 = somebody else got there first)
async function patch(c, id, data, fromStatuses = null, and = null) {
  const keys = Object.keys(data).filter((k) => COLS.has(k));
  if (!keys.length) return 0;
  const params = [...keys.map((k) => (data[k] === undefined ? null : data[k])), nowIso(), id];
  let sql = `UPDATE "VendorBillUpload" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`;
  if (fromStatuses) { sql += ` AND "status" IN (${fromStatuses.map(() => '?').join(',')})`; params.push(...fromStatuses); }
  if (and) Object.keys(and).forEach((k) => { if (!COLS.has(k)) throw new Error(`bad column ${k}`); sql += and[k] === null ? ` AND "${k}" IS NULL` : ` AND "${k}" = ?`; if (and[k] !== null) params.push(and[k]); });
  return DB.run(sql, params, c);
}
// A status change: the move must be allowed AND the row must still be in `from` (compare-and-set).
async function move(c, id, from, to, data = {}) {
  if (!canMove(from, to)) throw Object.assign(new Error(`not allowed: ${from} -> ${to}`), { code: 'ILLEGAL_MOVE' });
  return patch(c, id, { ...data, status: to }, [from]);
}

async function event(c, row, e) {
  await DB.run('INSERT INTO "VendorBillUploadEvent" ("id","uploadId","vendorId","kind","field","fromValue","toValue","note","actorKind","actorName","actorId","visibleToVendor","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [newId('bue'), row.id, row.vendorId, e.kind, e.field || null, e.from == null ? null : String(e.from).slice(0, 500), e.to == null ? null : String(e.to).slice(0, 500), e.note ? String(e.note).slice(0, 800) : null,
      e.actorKind || 'System', e.actorName ? String(e.actorName).slice(0, 160) : null, e.actorId || null, e.visible === false ? 0 : 1, nowIso()], c);
}

async function nextCode(c) { return DB.nextCode('VendorBillUpload', 'code', 'BU', 4, c); }

// ---- masker / links ----------------------------------------------------------------------------------------------------------------
const AVP = () => require('./assetVendorPortal'); // eslint-disable-line global-require
async function vendorOf(vendorId) { return prisma.officeVendor.findUnique({ where: { id: String(vendorId) }, select: { id: true, name: true, companyName: true, gstin: true, address: true, pan: true } }); }

async function linkMaps(rows) {
  const repairIds = [...new Set(rows.map((r) => r.repairId).filter(Boolean))];
  const assetIds = [...new Set(rows.map((r) => r.assetId).filter(Boolean))];
  const [repairs, assets] = await Promise.all([
    repairIds.length ? prisma.assetRepair.findMany({ where: { id: { in: repairIds } } }) : [],
    assetIds.length ? prisma.asset.findMany({ where: { id: { in: assetIds } } }) : [],
  ]);
  return { repairs: new Map(repairs.map((r) => [r.id, r])), assets: new Map(assets.map((a) => [a.id, a])) };
}

// ---- views ------------------------------------------------------------------------------------------------------------------------
const FIELD_KEYS = ['invoiceNo', 'invoiceDate', 'serviceDate', 'assetRef', 'vendorNameOnBill', 'subtotal', 'gst', 'cgst', 'sgst', 'igst', 'total', 'workDescription'];
const FIELD_LABEL = {
  invoiceNo: 'Invoice number', invoiceDate: 'Invoice date', serviceDate: 'Repair date', assetRef: 'Asset ID / serial number', vendorNameOnBill: 'Vendor name on the bill',
  subtotal: 'Amount before GST', gst: 'GST', cgst: 'CGST', sgst: 'SGST', igst: 'IGST', total: 'Total', workDescription: 'Repair work',
};
const valuesOf = (row) => Object.fromEntries(FIELD_KEYS.map((k) => [k, row[k] === undefined ? null : row[k]]));

function readingOf(row) {
  const m = row.meta || {};
  if (row.status === S.NOT_SENT) return { state: 'waiting', text: 'Not sent yet. Press Send when you are ready.' };
  if (row.status === S.UPLOADED) return { state: 'waiting', text: 'Uploaded. Reading will start in a moment.' };
  if (row.status === S.AI_PROCESSING) return { state: 'reading', text: 'The bill is being read. This takes about a minute.' };
  if (m.ai === 'off') return { state: 'off', text: 'Accounts will read this bill and type the details.' };
  if (m.ai === 'limit') return { state: 'off', text: 'Accounts will read this bill and type the details.' };
  if (m.ai === 'failed') return { state: 'failed', text: 'The automatic reading did not work. Please check the details below, or Accounts will type them.' };
  if (m.ai === 'done') return { state: 'done', text: 'The bill was read. Please check the details below.' };
  return { state: 'waiting', text: '' };
}

const VENDOR_FLAG_LEVELS = ['block', 'check'];
function vendorNotices(row) {
  return (row.flags || []).filter((f) => f.vendorMessage && VENDOR_FLAG_LEVELS.includes(f.level))
    .map((f) => ({ code: f.code, field: f.field || null, message: f.vendorMessage }));
}
function unclearFields(row) {
  const m = row.meta || {};
  return FIELD_KEYS.filter((k) => m[k] && m[k].unclear && !m[k].edited);
}

function filesView(row) { return (row.files || []).map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, pages: f.pages || 1 })); }

const shortCodeOf = async (id, c) => { const r = id ? await DB.one('SELECT "code" FROM "VendorBillUpload" WHERE "id" = ?', [id], c) : null; return r ? r.code : null; };

// A vendor's view of ONE upload. `links` = linkMaps result; `M` = the asset masker (AVP.ensureMask()).
async function vendorView(row, links, M, { withHistory = false } = {}) {
  const repair = row.repairId ? links.repairs.get(row.repairId) : null;
  const asset = row.assetId ? links.assets.get(row.assetId) : (repair ? links.assets.get(repair.assetId) : null);
  const ls = await lines(row.id);
  let submission = null;
  if (row.submissionId) submission = await prisma.vendorBillSubmission.findUnique({ where: { id: row.submissionId }, select: { billCode: true } }).catch(() => null);
  const editable = VENDOR_EDITABLE.includes(row.status);
  const out = {
    id: row.id, code: row.code, status: row.status, statusLabel: LABEL[row.status] || row.status, step: STEP_OF[row.status] ?? 0, steps: STEPS, rejected: row.status === S.REJECTED,
    version: row.version, correctsCode: await shortCodeOf(row.supersedes), uploadedAt: row.uploadedAt, updatedAt: row.updatedAt,
    repair: repair ? { id: repair.id, repairNo: repair.repairNo } : null,
    asset: asset ? { id: asset.id, code: M.code(asset), name: M.text(asset.name, asset.id) } : null,
    files: filesView(row), remarks: row.remarks || null,
    fields: valuesOf(row),
    lines: ls.map((l) => ({ lineNo: l.lineNo, description: l.description, itemName: l.itemName || null, brand: l.brand || null, model: l.model || null, serialNo: l.serialNo || null, quantity: l.quantity, rate: l.rate, amount: l.amount, unclear: !!l.unclear && !l.edited })),
    unclear: unclearFields(row), notices: vendorNotices(row), reading: readingOf(row),
    sentBackNote: row.status === S.NOT_SENT ? row.sentBackNote || null : null, rejectionReason: row.status === S.REJECTED ? row.rejectionReason || null : null,
    invoiceCode: submission ? submission.billCode : null,
    can: {
      edit: editable, replace: editable, submit: row.status === S.NOT_SENT, correct: row.status === S.REJECTED,
    },
    seen: row.vendorSeenStatus === row.status,
  };
  if (withHistory) out.history = await vendorHistory(row.id);
  // each line of the bill -> the asset, who had it on the bill date, who has it now (founder 2026-10-28; utils/billLineAssets.js)
  if (withHistory) out.payment = await paymentOfUpload(row).catch(() => null);
  if (withHistory) {
    const BLA = require('./billLineAssets'); // eslint-disable-line global-require
    out.lineAssets = await BLA.lineAssets(ls, await candidatesFor(row.vendorId), row.invoiceDate || row.serviceDate, out.asset ? out.asset.id : null, M, { links: await BLA.linksOf(row.id) }).catch(() => []);
  }
  return out;
}

async function vendorHistory(id) {
  const ev = await DB.q('SELECT * FROM "VendorBillUploadEvent" WHERE "uploadId" = ? AND "visibleToVendor" = 1 ORDER BY "createdAt" DESC, "id" DESC LIMIT 200', [id]);
  return ev.map((e) => ({ id: e.id, at: e.createdAt, by: e.actorKind === 'Vendor' ? 'You' : (e.actorKind === 'Company' ? 'Accounts' : 'TeamLink'), kind: e.kind, field: e.field ? (FIELD_LABEL[e.field] || e.field) : null, from: e.fromValue, to: e.toValue, note: e.note }));
}

// ---- the vendor's lists ---------------------------------------------------------------------------------------------------------
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const { wantsAll } = require('./exportAll');
function paged(rows, q, sorts, defSort, defDir = 'desc') {
  const sortKey = typeof sorts[str(q.sort)] === 'function' ? str(q.sort) : defSort;
  const dir = str(q.dir) === 'asc' ? 'asc' : (str(q.dir) === 'desc' ? 'desc' : defDir);
  const f = sorts[sortKey];
  const cmp = (a, b) => { const x = f(a); const y = f(b); return (typeof x === 'number' && typeof y === 'number') ? x - y : String(x ?? '').localeCompare(String(y ?? '')); };
  const sorted = [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  if (wantsAll(q)) return { rows: sorted, total: sorted.length, page: 1, pageSize: sorted.length, pages: 1, sort: sortKey, dir };
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  return { rows: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize, pages, sort: sortKey, dir };
}
const facet = (rows, get, label) => {
  const m = new Map();
  rows.forEach((r) => { const k = get(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([value, count]) => ({ value, label: label ? label(value) : value, count }));
};

async function listForVendor(v, q = {}) {
  await ensure();
  const M = await AVP().ensureMask();
  const raw = await DB.q(`SELECT * FROM "VendorBillUpload" WHERE "vendorId" = ? AND "status" != 'SUPERSEDED' ORDER BY "uploadedAt" DESC LIMIT 3000`, [v.vendorId]);
  const rows0 = raw.map(parse);
  const links = await linkMaps(rows0);
  const all = rows0.map((r) => {
    const repair = r.repairId ? links.repairs.get(r.repairId) : null;
    const asset = r.assetId ? links.assets.get(r.assetId) : (repair ? links.assets.get(repair.assetId) : null);
    return {
      id: r.id, code: r.code, status: r.status, statusLabel: LABEL[r.status], step: STEP_OF[r.status] ?? 0, version: r.version, uploadedAt: r.uploadedAt,
      repairNo: repair ? repair.repairNo : null, repairId: repair ? repair.id : null, assetCode: asset ? M.code(asset) : null, assetName: asset ? M.text(asset.name, asset.id) : null,
      invoiceNo: r.invoiceNo, invoiceDate: r.invoiceDate, total: r.total, fileCount: r.fileCount,
      reason: r.status === S.REJECTED ? r.rejectionReason : (r.status === S.NOT_SENT ? r.sentBackNote : null), isNew: r.vendorSeenStatus !== r.status && [S.REJECTED, S.APPROVED, S.SYNCED].concat(r.sentBackNote ? [S.NOT_SENT] : []).includes(r.status),
      needsYou: r.status === S.NOT_SENT && !!r.sentBackNote,
    };
  });
  const s = str(q.q).toLowerCase();
  const from = VP.YMD.test(str(q.from)) ? str(q.from) : null;
  const to = VP.YMD.test(str(q.to)) ? str(q.to) : null;
  const keep = (r, skip) => (skip === 'status' || !str(q.status) || r.status === str(q.status))
    && (!from || String(r.uploadedAt).slice(0, 10) >= from) && (!to || String(r.uploadedAt).slice(0, 10) <= to)
    && (!s || [r.code, r.invoiceNo, r.repairNo, r.assetCode, r.assetName, r.statusLabel].some((x) => String(x || '').toLowerCase().includes(s)));
  const rows = all.filter((r) => keep(r));
  const sorts = {
    uploadedAt: (r) => r.uploadedAt, invoiceDate: (r) => r.invoiceDate || '', total: (r) => r.total || 0, status: (r) => STEP_OF[r.status] ?? 0, invoiceNo: (r) => r.invoiceNo || '', code: (r) => r.code,
  };
  const page = paged(rows, q, sorts, 'uploadedAt');
  // the items of each bill on this page: asset name, asset, who has it now, match status (asset detection, 2026-10-28)
  await itemsOf(page.rows, rows0, M);
  return {
    ...page, all: all.length, canEdit: v.canEdit,
    facets: { status: facet(all.filter((r) => keep(r, 'status')), (r) => r.status, (k) => LABEL[k]) },
    summary: {
      count: all.length, waiting: all.filter((r) => [S.UPLOADED, S.AI_PROCESSING, S.NEEDS_REVIEW, S.PENDING_APPROVAL].includes(r.status)).length,
      approved: all.filter((r) => [S.APPROVED, S.SYNCED].includes(r.status)).length, needsYou: all.filter((r) => r.needsYou || r.status === S.REJECTED).length, unseen: all.filter((r) => r.isNew).length,
    },
  };
}

async function summaryFor(v) {
  await ensure();
  const raw = await DB.q(`SELECT "status","vendorSeenStatus","sentBackNote" FROM "VendorBillUpload" WHERE "vendorId" = ? AND "status" != 'SUPERSEDED'`, [v.vendorId]);
  const unseen = raw.filter((r) => r.vendorSeenStatus !== r.status && ([S.REJECTED, S.APPROVED, S.SYNCED].includes(r.status) || (r.status === S.NOT_SENT && r.sentBackNote))).length;
  return { total: raw.length, unseen };
}

// ---- options (what the upload window offers) ---------------------------------------------------------------------------------------
const OPEN_STAGES = ['Awaiting repair', 'Sent for repair', 'Under repair'];
async function optionsFor(v) {
  await ensure();
  const M = await AVP().ensureMask();
  const loaded = await AVP().loadRepairs(v);
  const L = await HS.listing(v);
  const assets = L.where === HS.NONE ? [] : await prisma.asset.findMany({ where: L.where, orderBy: { assetCode: 'asc' }, take: 1500 });
  const ocr = require('./billOcr'); // eslint-disable-line global-require
  const st = await ocr.status();
  return {
    repairs: loaded.map(({ repair, asset, side }) => {
      const stage = AVP().stageOf(repair, side);
      return {
        id: repair.id, repairNo: repair.repairNo, assetCode: M.code(asset), assetName: M.text(asset.name, asset.id), serialNumber: M.text(asset.serialNumber, asset.id) || null,
        issue: M.text(repair.issue, asset.id) || null, stage, open: OPEN_STAGES.includes(stage), invoiceNo: repair.invoiceNo || null,
      };
    }).filter((r) => r.stage !== 'Cancelled'),
    assets: assets.map((a) => ({ id: a.id, code: M.code(a), name: M.text(a.name, a.id), serialNumber: M.text(a.serialNumber, a.id) || null })),
    limits: { maxFiles: F.MAX_FILES, maxPages: F.MAX_PAGES, maxMb: Math.round(require('./vendorConfig').CFG.uploadMaxBytes / 1048576), types: ['JPG', 'PNG', 'WebP', 'PDF'] }, // eslint-disable-line global-require
    aiOn: !!st.ready,
    canEdit: !!v.canEdit,
  };
}

// ---- own-row guards ----------------------------------------------------------------------------------------------------------------
// The upload, ONLY if it belongs to this vendor. A row of another vendor looks exactly like one that does not exist.
async function mine(v, id) {
  await ensure();
  const row = await getRow(id);
  return row && row.vendorId === v.vendorId ? row : null;
}

// ---- creating -------------------------------------------------------------------------------------------------------------------------
const MAX_REMARKS = 500;
async function rateProblem(v) {
  const perHour = Number(process.env.BILL_UPLOADS_PER_HOUR || 10);
  const perDay = Number(process.env.BILL_UPLOADS_PER_DAY || 40);
  const hour = new Date(Date.now() - 3600e3).toISOString();
  const day = new Date(Date.now() - 24 * 3600e3).toISOString();
  const [h, d] = await Promise.all([
    DB.one('SELECT COUNT(*) AS n FROM "VendorBillUpload" WHERE "vendorId" = ? AND "createdAt" >= ?', [v.vendorId, hour]),
    DB.one('SELECT COUNT(*) AS n FROM "VendorBillUpload" WHERE "vendorId" = ? AND "createdAt" >= ?', [v.vendorId, day]),
  ]);
  if (h.n >= perHour) return `You have uploaded ${perHour} bills in the last hour. Please wait a little and try again.`;
  if (d.n >= perDay) return `You have uploaded ${perDay} bills today. Please try again tomorrow.`;
  return null;
}

const deleteStored = (files) => (files || []).forEach((f) => attachments.remove(f.file));

// Inspect + store the files of one request. Returns { files: [stored descriptors], hash } or throws {code} (nothing stays on disk then).
async function storeFiles(rawFiles) {
  const maxBytes = require('./vendorConfig').CFG.uploadMaxBytes; // eslint-disable-line global-require
  if (!rawFiles || !rawFiles.length) throw F.fail('NO_FILE');
  if (rawFiles.length > F.MAX_FILES) throw F.fail('TOO_MANY');
  const infos = [];
  let pages = 0;
  for (const f of rawFiles) {
    const info = await F.inspect(f, { maxBytes }); // eslint-disable-line no-await-in-loop
    pages += info.pages;
    infos.push(info);
  }
  if (pages > F.MAX_PAGES) throw F.fail('TOO_MANY_PAGES');
  if (new Set(infos.map((i) => i.sha256)).size !== infos.length) throw F.fail('SAME_FILE');
  const stored = [];
  try {
    rawFiles.forEach((f, i) => {
      const st = attachments.store({ filename: f.filename, contentType: infos[i].mime, data: f.data }, { maxBytes, allowSheet: true }); // Excel / CSV too (2026-10-28)
      stored.push({ id: newId('bf'), file: st.billFile, name: st.billName, mime: infos[i].mime, size: infos[i].size, sha256: infos[i].sha256, pages: infos[i].pages });
    });
  } catch (err) { deleteStored(stored); throw err; }
  const hash = crypto.createHash('sha256').update(stored.map((s) => s.sha256).join('|')).digest('hex');
  return { files: stored, hash };
}

// A repair/asset choice, inside the vendor's own set. Returns { repair, asset } (either may be null) or { error }.
async function resolveChoice(v, repairId, assetId) {
  let repair = null; let asset = null;
  if (repairId) {
    const m = await AVP().myRepair(v, repairId);
    if (!m) return { error: { status: 403, body: { error: 'Forbidden. This repair is not yours.' } } };
    repair = m.repair; asset = m.asset;
  }
  if (assetId) {
    const a = await AVP().myAsset(v, assetId);
    if (!a && !(asset && asset.id === String(assetId))) return { error: { status: 403, body: { error: 'Forbidden. This asset is not yours.' } } };
    if (asset && asset.id !== String(assetId)) return { error: { status: 409, body: { error: 'That asset does not belong to the repair you chose.', field: 'assetId' } } };
    asset = asset || a;
  }
  return { repair, asset };
}

// opts: { files (raw), fields: {repairId, assetId, remarks, submit, correctsId}, idemKey }
async function createUpload(v, req, opts) {
  await ensure();
  if (!v.canEdit) return { status: 403, body: { error: 'Your login is view-only. Ask the company to allow editing.' } };
  const fields = opts.fields || {};
  const bad = Object.keys(fields).filter((k) => !['repairId', 'assetId', 'remarks', 'submit', 'correctsId', 'replacesId'].includes(k));
  if (bad.length) return { status: 400, body: { error: 'Only the repair, the asset, a remark and the files can be sent.', refusedFields: bad } };
  if (opts.idemKey) {
    const dup = parse(await DB.one('SELECT * FROM "VendorBillUpload" WHERE "vendorId" = ? AND "idemKey" = ?', [v.vendorId, opts.idemKey]));
    if (dup) return { status: 200, body: { upload: await viewOf(v, dup), message: 'This bill was already uploaded.', duplicateRequest: true } };
  }
  const limited = await rateProblem(v);
  if (limited) return { status: 429, body: { error: limited } };
  if (VP.hasHtml(fields.remarks)) return { status: 400, body: { error: 'Plain text only in the remark.', field: 'remarks' } };
  const remarks = V.cleanText(fields.remarks, MAX_REMARKS) || null;
  let prev = null; // an earlier upload this one corrects (rejected) or replaces (not decided yet)
  if (fields.correctsId || fields.replacesId) {
    prev = await mine(v, fields.correctsId || fields.replacesId);
    if (!prev) return { status: 403, body: { error: 'Forbidden. This bill is not yours.' } };
    if (fields.correctsId && prev.status !== S.REJECTED) return { status: 409, body: { error: 'Only a rejected bill can be corrected this way.' } };
    if (fields.replacesId && !VENDOR_EDITABLE.includes(prev.status)) {
      return { status: 409, body: { error: prev.status === S.AI_PROCESSING ? 'This bill is being read right now. Please wait a minute and try again.' : `This bill is ${LABEL[prev.status].toLowerCase()} and its file cannot be replaced any more.` } };
    }
  }
  const choice = await resolveChoice(v, fields.repairId || (prev && prev.repairId) || null, fields.assetId || (prev && !fields.repairId && prev.assetId) || null);
  if (choice.error) return choice.error;
  let stored;
  try { stored = await storeFiles(opts.files); } catch (err) { return { status: 400, body: { error: F.messageOf(err), code: err && err.code } }; }
  // the same file again (same vendor, same bytes) -> point at the first upload instead of making a second record
  const same = parse(await DB.one(`SELECT * FROM "VendorBillUpload" WHERE "vendorId" = ? AND "contentHash" = ? AND "status" NOT IN ('REJECTED','SUPERSEDED') ORDER BY "uploadedAt" DESC LIMIT 1`, [v.vendorId, stored.hash]));
  if (same && !(prev && same.id === prev.id && fields.correctsId)) {
    deleteStored(stored.files);
    return { status: 409, body: { error: `You already uploaded this bill (${same.code}, ${LABEL[same.status].toLowerCase()}). Open it from "My bills".`, duplicateOf: same.code, existingId: same.id } };
  }
  const submit = !(fields.submit === 'false' || fields.submit === false || fields.submit === '0' || fields.submit === 'no');
  const t = nowIso();
  const by = `${v.name} (vendor ${v.vendorName})`;
  let row = null;
  for (let i = 0; i < 6 && !row; i += 1) {
    const id = newId();
    try {
      // eslint-disable-next-line no-await-in-loop
      row = await prisma.$transaction(async (tx) => {
        const code = await nextCode(tx);
        await DB.run(`INSERT INTO "VendorBillUpload" ("id","code","vendorId","vendorUserId","uploadedByName","repairId","assetId","status","source","rootId","supersedes","version","filesJson","fileCount","contentHash","remarks","idemKey",
          "currency","flagsJson","acksJson","uploadedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, code, v.vendorId, v.userId, by, choice.repair ? choice.repair.id : null, choice.asset ? choice.asset.id : null, submit ? S.UPLOADED : S.NOT_SENT, 'vendor-portal', prev ? (prev.rootId || prev.id) : id, prev ? prev.id : null,
          prev ? (prev.version || 1) + 1 : 1, JSON.stringify(stored.files), stored.files.length, stored.hash, remarks, opts.idemKey || null, 'INR', '[]', '[]', t, t, t], tx);
        const fresh = parse(await DB.one('SELECT * FROM "VendorBillUpload" WHERE "id" = ?', [id], tx));
        await event(tx, fresh, { kind: 'uploaded', actorKind: 'Vendor', actorName: by, actorId: v.userId, note: prev ? `You ${fields.correctsId ? 'sent a corrected bill' : 'replaced the file'} (${stored.files.length} file${stored.files.length === 1 ? '' : 's'}).` : `You uploaded the bill (${stored.files.length} file${stored.files.length === 1 ? '' : 's'}).${submit ? '' : ' It is not sent yet.'}` });
        if (prev && fields.replacesId) {
          const n = await move(tx, prev.id, prev.status, S.SUPERSEDED, {});
          if (!n) throw Object.assign(new Error('stale'), { stale: true });
          await event(tx, prev, { kind: 'superseded', actorKind: 'Vendor', actorName: by, actorId: v.userId, note: `You replaced this file with a new one (${code}).` });
        }
        return fresh;
      });
    } catch (e) {
      if (e && e.stale) { deleteStored(stored.files); return { status: 409, body: { error: 'This bill was just changed. Please refresh and try again.', stale: true } }; }
      if (e && (e.code === 'P2002' || /UNIQUE/i.test(String(e.message))) && !/idem/i.test(String(e.message))) continue; // eslint-disable-line no-continue
      deleteStored(stored.files);
      if (e && /idem/i.test(String(e.message))) {
        const dup = parse(await DB.one('SELECT * FROM "VendorBillUpload" WHERE "vendorId" = ? AND "idemKey" = ?', [v.vendorId, opts.idemKey]));
        if (dup) return { status: 200, body: { upload: await viewOf(v, dup), message: 'This bill was already uploaded.', duplicateRequest: true } };
      }
      throw e;
    }
  }
  if (!row) { deleteStored(stored.files); return { status: 503, body: { error: 'Could not save the bill just now. Please try again.' } }; }
  await VP.auditReq(req, { assetId: choice.asset ? choice.asset.id : null, vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: prev ? 'Repair bill replaced / corrected' : 'Repair bill uploaded', billId: row.id, documentName: stored.files[0].name, status: row.status, newValue: `${row.code} · ${stored.files.length} file(s)` });
  if (submit) require('./billUploadAi').enqueue(row.id); // eslint-disable-line global-require
  return { status: 201, body: { upload: await viewOf(v, row), message: submit ? 'Bill uploaded. We are reading it now; you can follow the steps below.' : 'Saved. It is not sent yet. Press Send when you are ready.' } };
}

// THE PAYMENT OF AN APPROVED BILL (founder 2026-10-28: "payment chesaka ani kuda tisukovali"): read live from Accounts' bill and the bank
// statement (the same words as Invoices & Payments), with every bank payment's date and amount. null until Accounts has the bill.
async function paymentOfUpload(row) {
  if (!row.expenseId) return null;
  const e = await prisma.officeExpense.findUnique({ where: { id: row.expenseId } });
  if (!e) return null;
  const PAY = require('./expensePaymentState'); // eslint-disable-line global-require
  const PV = require('./assetVendorPayments'); // eslint-disable-line global-require
  const judged = await PAY.describeMany(prisma, [e]);
  const p = PV.paymentFromJudge(e, judged.get(e.id));
  const lines = ((await require('./vendorBankPayments').forVendor(row.vendorId).catch(() => ({ byBill: new Map() }))).byBill.get(e.id) || []); // eslint-disable-line global-require
  return { status: p.status, tone: p.tone, paidAmount: p.paidAmount, balance: p.balance, dueDate: p.dueDate, note: p.note, payments: lines.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))) };
}
async function viewOf(v, row, opts) {
  const M = await AVP().ensureMask();
  const links = await linkMaps([row]);
  return vendorView(row, links, M, opts);
}
async function detailForVendor(v, id) {
  const row = await mine(v, id);
  if (!row) return null;
  await DB.run('UPDATE "VendorBillUpload" SET "vendorSeenStatus" = "status" WHERE "id" = ? AND COALESCE("vendorSeenStatus",\'\') != "status"', [row.id]);
  return { upload: await viewOf(v, { ...row, vendorSeenStatus: row.status }, { withHistory: true }) };
}

// ---- edits ----------------------------------------------------------------------------------------------------------------------------
const EDIT_TEXT = { invoiceNo: 60, assetRef: 80, vendorNameOnBill: 160, workDescription: 1000 };
const EDIT_MONEY = ['subtotal', 'gst', 'cgst', 'sgst', 'igst', 'total'];
const EDIT_DATE = ['invoiceDate', 'serviceDate'];
const PAYMENT_WORDS = /^(paid|paidamount|paymentstatus|payment|status|balance|paystatus|approvalstatus|paidstatus|paidon|paymentdate|bankref|bankreference|utr|transaction|txn|banktxnid|approved|synced|expenseid|submissionid)$/i;
const showVal = (x) => (x == null || x === '' ? '-' : String(x));

// Validates + normalises an edit body into { cols: {col: value}, lines: [...]|undefined, errors }. Pure with respect to the database.
function readEdit(body) {
  const cols = {}; let newLines;
  for (const k of Object.keys(EDIT_TEXT)) {
    if (body[k] === undefined) continue; // eslint-disable-line no-continue
    if (VP.hasHtml(body[k])) return { error: { status: 400, body: { error: 'Plain text only - no < or > characters.', field: k } } };
    if (String(body[k] ?? '').trim().length > EDIT_TEXT[k]) return { error: { status: 400, body: { error: `Keep ${FIELD_LABEL[k].toLowerCase()} under ${EDIT_TEXT[k]} characters.`, field: k } } };
    cols[k] = V.cleanText(body[k], EDIT_TEXT[k]) || null;
  }
  for (const k of EDIT_MONEY) {
    if (body[k] === undefined) continue; // eslint-disable-line no-continue
    if (body[k] === null || String(body[k]).trim() === '') { cols[k] = null; continue; } // eslint-disable-line no-continue
    const n = V.parseMoney(body[k]);
    if (n == null) return { error: { status: 400, body: { error: `${FIELD_LABEL[k]} must be an amount like 1500 or 1,500.50.`, field: k } } };
    cols[k] = n;
  }
  for (const k of EDIT_DATE) {
    if (body[k] === undefined) continue; // eslint-disable-line no-continue
    if (body[k] === null || String(body[k]).trim() === '') { cols[k] = null; continue; } // eslint-disable-line no-continue
    const d = V.parseDate(body[k]);
    if (!d) return { error: { status: 400, body: { error: `${FIELD_LABEL[k]} must be a real date, like 05/10/2026.`, field: k } } };
    cols[k] = d;
  }
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines) || body.lines.length > 60) return { error: { status: 400, body: { error: 'The lines must be a list of at most 60 rows.', field: 'lines' } } };
    newLines = [];
    for (let i = 0; i < body.lines.length; i += 1) {
      const l = body.lines[i];
      if (!l || typeof l !== 'object') return { error: { status: 400, body: { error: `Line ${i + 1} is not valid.`, field: `line.${i + 1}` } } };
      if (VP.hasHtml(l.description)) return { error: { status: 400, body: { error: `Line ${i + 1}: plain text only.`, field: `line.${i + 1}` } } };
      const description = V.cleanText(l.description, 300) || null;
      const blank = (x) => x === undefined || x === null || String(x).trim() === '';
      const quantity = blank(l.quantity) ? null : V.parseNumber(l.quantity);
      const rate = blank(l.rate) ? null : V.parseMoney(l.rate);
      const amount = blank(l.amount) ? null : V.parseMoney(l.amount);
      if ((!blank(l.quantity) && quantity == null) || (!blank(l.rate) && rate == null) || (!blank(l.amount) && amount == null)) return { error: { status: 400, body: { error: `Line ${i + 1}: quantity, rate and amount must be numbers.`, field: `line.${i + 1}` } } };
      if (description == null && quantity == null && rate == null && amount == null) continue; // eslint-disable-line no-continue
      const item = (k, max) => (blank(l[k]) ? undefined : (V.cleanText(l[k], max) || null)); // undefined = keep what the reading found
      newLines.push({
        description, quantity, rate, amount, itemName: item('itemName', 120), brand: item('brand', 60), model: item('model', 80), serialNo: item('serialNo', 80),
      });
    }
  }
  return { cols, lines: newLines };
}

const sameNumber = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);
const sameVal = (a, b) => (typeof a === 'number' || typeof b === 'number' ? sameNumber(a, b) : (a ?? null) === (b ?? null));

// Applies the edit to the row (inside a transaction), writes the events, re-checks. `who` = { kind: 'Vendor'|'Company', name, id }.
// Returns { changed: [labels], row } or { error }.
async function applyEdit(row, edit, who, extra = {}) {
  const meta = { ...(row.meta || {}) };
  const data = {}; const evs = [];
  for (const [k, val] of Object.entries(edit.cols)) {
    if (sameVal(val, row[k])) continue; // eslint-disable-line no-continue
    data[k] = val;
    if (k === 'invoiceNo') data.invoiceNoKey = val ? V.normInvoiceNo(val) : null;
    meta[k] = { ...(meta[k] || {}), edited: true, by: who.kind, confidence: 1, unclear: false, aiValue: (meta[k] && meta[k].aiValue !== undefined) ? meta[k].aiValue : (row[k] ?? null) };
    evs.push({ kind: 'edit', field: k, from: showVal(row[k]), to: showVal(val), note: `${who.kind === 'Vendor' ? 'You' : who.name} changed ${FIELD_LABEL[k].toLowerCase()}.` });
  }
  if (extra.cols) {
    for (const [k, val] of Object.entries(extra.cols)) {
      if (sameVal(val, row[k])) continue; // eslint-disable-line no-continue
      data[k] = val;
      evs.push({ kind: 'edit', field: k, from: showVal(row[k]), to: showVal(val), note: extra.notes && extra.notes[k] ? extra.notes[k] : null, visible: extra.visible !== false });
    }
  }
  let linesChanged = false;
  if (edit.lines) {
    const cur = await lines(row.id);
    const sig = (l) => `${l.description || ''}|${l.quantity ?? ''}|${l.rate ?? ''}|${l.amount ?? ''}`;
    linesChanged = cur.map(sig).join('\n') !== edit.lines.map(sig).join('\n');
    if (linesChanged) {
      meta.linesEdited = true;
      evs.push({ kind: 'edit', field: 'lines', from: `${cur.length} line(s)`, to: `${edit.lines.length} line(s)`, note: `${who.kind === 'Vendor' ? 'You' : who.name} changed the table of items.` });
    }
  }
  if (!evs.length) return { changed: [], row };
  data.metaJson = JSON.stringify(meta);
  try {
    await prisma.$transaction(async (tx) => {
      const n = await patch(tx, row.id, data, [row.status]);
      if (!n) throw Object.assign(new Error('stale'), { stale: true });
      if (linesChanged) {
        // what the reading found about each item (and a person's asset link) stays with a line whose text did not change
        const old = await lines(row.id, tx);
        const oldByText = new Map(old.map((l) => [String(l.description || '').trim().toLowerCase(), l]));
        await DB.run('DELETE FROM "VendorBillUploadLine" WHERE "uploadId" = ?', [row.id], tx);
        const keepLinks = [];
        let i = 0;
        for (const l of edit.lines) {
          i += 1;
          const was = oldByText.get(String(l.description || '').trim().toLowerCase()) || null;
          const pick = (k) => (l[k] !== undefined ? l[k] : (was ? was[k] || null : null));
          if (was) keepLinks.push([was.lineNo, i]);
          // eslint-disable-next-line no-await-in-loop
          await DB.run('INSERT INTO "VendorBillUploadLine" ("id","uploadId","lineNo","description","quantity","rate","amount","confidence","unclear","note","edited","createdAt","itemName","brand","model","serialNo") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [newId('bl'), row.id, i, l.description, l.quantity, l.rate, l.amount, 1, 0, null, 1, nowIso(), pick('itemName'), pick('brand'), pick('model'), pick('serialNo')], tx);
        }
        const links = await DB.q('SELECT * FROM "VendorBillLineAsset" WHERE "uploadId" = ?', [row.id], tx);
        await DB.run('DELETE FROM "VendorBillLineAsset" WHERE "uploadId" = ?', [row.id], tx);
        for (const k of links) {
          const to = keepLinks.find(([from]) => from === k.lineNo);
          // eslint-disable-next-line no-await-in-loop
          if (to) await DB.run('INSERT INTO "VendorBillLineAsset" ("id","uploadId","lineNo","kind","assetId","byId","byName","at") VALUES (?,?,?,?,?,?,?,?)', [newId('la'), row.id, to[1], k.kind, k.assetId, k.byId, k.byName, k.at], tx);
        }
      }
      for (const e of evs) await event(tx, row, { ...e, actorKind: who.kind, actorName: who.name, actorId: who.id }); // eslint-disable-line no-await-in-loop
    });
  } catch (e) {
    if (e && e.stale) return { error: { status: 409, body: { error: 'This bill was changed by someone else just now. Refresh and try again.', stale: true } } };
    throw e;
  }
  return { changed: evs.map((e) => e.field), row: await getRow(row.id) };
}

async function vendorEdit(v, req, id, body) {
  const row = await mine(v, id);
  if (!row) return { status: 403, body: { error: 'Forbidden. This bill is not yours.' } };
  if (!v.canEdit) return { status: 403, body: { error: 'Your login is view-only. Ask the company to allow editing.' } };
  const allowed = [...FIELD_KEYS, 'lines', 'repairId', 'assetId', 'remarks', 'updatedAt'];
  const bad = Object.keys(body).filter((k) => !allowed.includes(k));
  if (bad.length) return { status: 400, body: { error: bad.some((k) => PAYMENT_WORDS.test(k)) ? 'A vendor cannot set a status or a payment. Accounts checks the bill and the bank statement confirms payment.' : 'You can change only the details written on the bill, the repair, the asset and a remark.', refusedFields: bad } };
  if (!VENDOR_EDITABLE.includes(row.status)) {
    return { status: 409, body: { error: row.status === S.AI_PROCESSING ? 'The bill is being read right now. Please wait a minute and try again.' : `This bill is ${LABEL[row.status].toLowerCase()} and cannot be changed any more.${row.status === S.REJECTED ? ' You can upload a corrected bill.' : ''}` } };
  }
  if (row.status === S.AI_PROCESSING) return { status: 409, body: { error: 'The bill is being read right now. Please wait a minute and try again.' } };
  if (body.updatedAt && new Date(body.updatedAt).getTime() !== new Date(row.updatedAt).getTime()) return { status: 409, body: { error: 'This bill was changed by someone else just now. Refresh and try again.', stale: true, updatedAt: row.updatedAt } };
  const edit = readEdit(body);
  if (edit.error) return edit.error;
  const extra = { cols: {}, notes: {} };
  if (body.remarks !== undefined) {
    if (VP.hasHtml(body.remarks)) return { status: 400, body: { error: 'Plain text only in the remark.', field: 'remarks' } };
    extra.cols.remarks = V.cleanText(body.remarks, MAX_REMARKS) || null; extra.notes.remarks = 'You changed the remark.';
  }
  if (body.repairId !== undefined || body.assetId !== undefined) {
    const repairId = body.repairId === undefined ? row.repairId : (body.repairId || null);
    const assetId = body.assetId === undefined ? (body.repairId ? null : row.assetId) : (body.assetId || null);
    const ch = await resolveChoice(v, repairId, assetId);
    if (ch.error) return ch.error;
    extra.cols.repairId = ch.repair ? ch.repair.id : null; extra.cols.assetId = ch.asset ? ch.asset.id : (ch.repair ? ch.repair.assetId : null);
    extra.notes.repairId = 'You changed the repair.'; extra.notes.assetId = 'You changed the asset.';
  }
  const by = `${v.name} (vendor ${v.vendorName})`;
  const res = await applyEdit(row, edit, { kind: 'Vendor', name: by, id: v.userId }, extra);
  if (res.error) return res.error;
  if (!res.changed.length) return { status: 200, body: { changed: [], message: 'Nothing changed.', upload: await viewOf(v, row, { withHistory: true }) } };
  const fresh = await revalidate(row.id);
  await VP.auditReq(req, { assetId: fresh.assetId, vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: 'Repair bill details changed by vendor', billId: row.id, field: res.changed.join(','), status: fresh.status });
  return { status: 200, body: { changed: res.changed, message: 'Saved.', upload: await viewOf(v, fresh, { withHistory: true }) } };
}

async function vendorSubmit(v, req, id) {
  const row = await mine(v, id);
  if (!row) return { status: 403, body: { error: 'Forbidden. This bill is not yours.' } };
  if (!v.canEdit) return { status: 403, body: { error: 'Your login is view-only. Ask the company to allow editing.' } };
  if (row.status !== S.NOT_SENT) {
    if ([S.UPLOADED, S.AI_PROCESSING, S.NEEDS_REVIEW, S.PENDING_APPROVAL, S.APPROVED, S.SYNCED].includes(row.status)) return { status: 200, body: { unchanged: true, message: 'This bill was already sent.', upload: await viewOf(v, row, { withHistory: true }) } };
    return { status: 409, body: { error: `This bill is ${LABEL[row.status].toLowerCase()} and cannot be sent.` } };
  }
  const by = `${v.name} (vendor ${v.vendorName})`;
  const n = await prisma.$transaction(async (tx) => {
    const k = await move(tx, row.id, S.NOT_SENT, S.UPLOADED, { notifiedAt: null });
    if (k) await event(tx, row, { kind: 'submitted', actorKind: 'Vendor', actorName: by, actorId: v.userId, note: 'You sent the bill.' });
    return k;
  });
  if (!n) return { status: 409, body: { error: 'This bill was just changed. Refresh and try again.', stale: true } };
  await VP.auditReq(req, { assetId: row.assetId, vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: 'Repair bill sent', billId: row.id, status: S.UPLOADED });
  await require('./billUploadAi').afterSubmit(row.id); // eslint-disable-line global-require
  return { status: 200, body: { message: 'Bill sent.', upload: await viewOf(v, await getRow(row.id), { withHistory: true }) } };
}

// ---- the checks -----------------------------------------------------------------------------------------------------------------------
// -> flags. `row` = parsed upload. Reads the database (repair, asset, candidates, estimate, duplicates) but writes nothing.
async function computeFlags(row) {
  const out = [];
  const add = (code, field, level, message, vendorMessage, extra = {}) => out.push({ code, field: field || null, level, message, vendorMessage: vendorMessage || null, ...extra });
  const vendor = await vendorOf(row.vendorId);
  const ls = await lines(row.id);
  const meta = row.meta || {};
  const lineObjs = ls.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount, unclear: !!l.unclear && !l.edited }));

  // 1. unclear handwriting (never edited by a person) and fields the model could not read
  for (const k of FIELD_KEYS) {
    const m = meta[k];
    if (m && m.unclear && !m.edited) add('unclear', k, 'check', `Unclear handwriting: ${FIELD_LABEL[k].toLowerCase()}${row[k] == null ? ' (could not be read)' : ''}. Check the bill.${m.note ? ` AI note: ${m.note}` : ''}`, `Please check the ${FIELD_LABEL[k].toLowerCase()}. The writing was not clear.`);
  }
  lineObjs.forEach((l, i) => { if (l.unclear) add('unclear', `line.${i + 1}`, 'check', `Unclear handwriting in line ${i + 1}. Check the bill.`, `Please check line ${i + 1}. The writing was not clear.`); });
  if (meta.isBill === false) add('not-a-bill', null, 'check', 'The AI thinks this file is not a bill or invoice.', 'This file does not look like a bill. Please check you uploaded the right file.');

  // 2. the arithmetic and the dates
  const f = valuesOf(row);
  V.checkTotals(f, lineObjs).forEach((x) => add(x.code, x.field, x.level, x.message, x.message));
  V.checkDates({ invoiceDate: row.invoiceDate, serviceDate: row.serviceDate }, todayIso()).forEach((x) => add(x.code, x.field, x.level, x.message, x.message));
  if (!row.invoiceNo) add('invoice-no-missing', 'invoiceNo', 'block', 'The invoice number is not filled in.', 'The invoice number is not filled in.');

  // 3. the vendor name on the bill
  if (row.vendorNameOnBill && vendor) {
    const ok = V.sameVendorName(row.vendorNameOnBill, vendor.name) || (vendor.companyName && V.sameVendorName(row.vendorNameOnBill, vendor.companyName));
    if (ok === false) add('vendor-name', 'vendorNameOnBill', 'check', `The bill says "${row.vendorNameOnBill}", the logged-in vendor is "${vendor.name}".`, 'The name on the bill is different from your company name. Please check you uploaded your own bill.');
  }

  // 4. asset and repair
  const cands = await candidatesFor(row.vendorId);
  let repair = row.repairId ? await prisma.assetRepair.findUnique({ where: { id: row.repairId }, include: { asset: true } }) : null;
  let assetId = row.assetId || (repair ? repair.assetId : null);
  let asset = assetId ? (repair && repair.assetId === assetId ? repair.asset : await prisma.asset.findUnique({ where: { id: assetId } })) : null;
  const ref = row.assetRef ? V.matchRef(row.assetRef, cands.keysOfAssets) : { status: 'none' };
  if (!asset && ref.status === 'matched') { assetId = ref.id; asset = await prisma.asset.findUnique({ where: { id: ref.id } }); add('asset-matched', 'assetRef', 'info', `Matched to asset ${asset ? asset.assetCode : ''} from the bill's asset reference.`, null, { autoAssetId: ref.id }); }
  // FROM THE ITEMS THE AI READ (founder 2026-10-28: "AI read chesukoni ... adhey suggest cheyali"): when the bill names no asset, a serial
  // number / asset ID, or the brand + model of exactly ONE of the vendor's assets, written in its lines picks that asset. Never a guess.
  let lineHits = [];
  if (!asset && ref.status !== 'ambiguous') {
    lineHits = await require('./billLineAssets').lineAssets(lineObjs.map((l, i) => ({ lineNo: i + 1, description: l.description })), cands, row.invoiceDate || row.serviceDate, null).catch(() => []); // eslint-disable-line global-require
    const ids = [...new Set(lineHits.filter((x) => x.asset).map((x) => x.asset.id))];
    if (ids.length === 1) {
      assetId = ids[0]; asset = await prisma.asset.findUnique({ where: { id: ids[0] } });
      const how = (lineHits.find((x) => x.asset) || {}).how || 'the items on the bill';
      add('asset-matched', 'assetRef', 'info', `Matched to asset ${asset ? asset.assetCode : ''} from the items the AI read (${String(how).toLowerCase()}).`, null, { autoAssetId: ids[0] });
    } else if (ids.length > 1) {
      add('asset-several', 'assetRef', 'check', `The items on this bill are for ${ids.length} different assets. Link the bill to one repair, or ask the vendor for one bill per asset.`, 'The items on this bill are for more than one asset. Please choose the asset or repair.');
    }
  }
  if (!asset) {
    if (ref.status === 'ambiguous') add('asset-ambiguous', 'assetRef', 'block', `The asset reference "${row.assetRef}" fits more than one of the vendor's assets. Pick the right asset.`, 'The asset on the bill fits more than one of your assets. Please choose the asset.');
    else if (ref.status === 'unmatched') add('asset-unmatched', 'assetRef', 'block', `The asset reference "${row.assetRef}" matches none of the vendor's assets. Pick the asset.`, 'The asset ID or serial number on the bill does not match any of your assets. Please choose the asset.');
    else add('asset-unmatched', 'assetRef', 'block', 'No asset is chosen and the bill shows no asset ID or serial number. Pick the asset.', 'Please choose the asset or repair this bill is for.');
  }
  if (!repair && asset) {
    // exactly one open (not cancelled) repair of that asset in the vendor's set -> suggested automatically
    const mineRepairs = cands.repairs.filter((r) => r.assetId === asset.id && r.status !== 'Cancelled');
    const open = mineRepairs.filter((r) => r.status !== 'Completed');
    const pick = mineRepairs.length === 1 ? mineRepairs[0] : (open.length === 1 ? open[0] : null);
    if (pick) { repair = await prisma.assetRepair.findUnique({ where: { id: pick.id }, include: { asset: true } }); add('repair-matched', 'repairId', 'info', `Matched to repair ${pick.repairNo} (the only repair of this asset).`, null, { autoRepairId: pick.id }); } else {
      add('repair-missing', 'repairId', 'block', mineRepairs.length ? 'More than one repair belongs to this asset. Pick the repair.' : 'There is no repair record for this asset yet. Create the repair in HRMS first (Employee Services > Assets), then check again.', 'Please choose the repair this bill is for.');
    }
  }
  // WHO HAS THIS ASSET (founder 2026-10-28): the employee holding it now, and on the bill date, from HRMS - for the reviewer.
  if (asset) {
    const BLA = require('./billLineAssets'); // eslint-disable-line global-require
    const full = await prisma.asset.findUnique({ where: { id: asset.id }, include: { assignedTo: { select: { name: true, employeeCode: true, department: true } } } });
    const day = String(row.invoiceDate || row.serviceDate || '').slice(0, 10);
    const on = full ? BLA.holderOn(full, day) : null;
    const now = full && full.assignedTo ? `${full.assignedTo.name} (${[full.assignedTo.employeeCode, full.assignedTo.department].filter(Boolean).join(', ')})` : 'nobody (in stock)';
    const then = on ? (on.none ? 'nobody (in stock)' : on.name) : null;
    add('asset-holder', 'assetRef', 'info', `${full ? full.assetCode : 'This asset'} is with ${now} now${then && day ? `; on the bill date (${day}) it was with ${then}` : ''}.`, null);
  }
  if (repair) {
    if (asset && repair.assetId !== asset.id) add('repair-asset-mismatch', 'repairId', 'block', 'The chosen repair belongs to a different asset.', 'The repair and the asset do not belong together.');
    if (repair.status === 'Cancelled') add('repair-cancelled', 'repairId', 'block', `Repair ${repair.repairNo} was cancelled.`, 'The company cancelled this repair.');
    const live = await liveBillOfRepair(repair.id, row.submissionId);
    if (live) add('repair-has-invoice', 'repairId', 'block', `Repair ${repair.repairNo} already has an invoice in Accounts (${live.billCode}). Reject this upload or ask Accounts to reject the other invoice first.`, `An invoice (${live.billCode}) was already sent for this repair.`);
    if (row.assetRef && asset) {
      const keys = (cands.keysByAsset.get(asset.id) || []).concat(repair.repairNo);
      const mm = V.matchRef(row.assetRef, [{ id: asset.id, keys }]);
      if (mm.status === 'unmatched') add('asset-mismatch', 'assetRef', 'check', `The bill shows "${row.assetRef}", which is not the ID or serial number of the chosen asset (${asset.assetCode}).`, 'The asset ID on the bill is different from the asset you chose. Please check.');
    }
    const est = await DB.one('SELECT "estimateCost","estimateGst" FROM "AssetRepairVendor" WHERE "repairId" = ?', [repair.id]).catch(() => null);
    if (est && est.estimateCost != null && row.total != null) {
      const pct = V.overEstimatePct(row.total, Number(est.estimateCost) + Number(est.estimateGst || 0));
      if (pct != null && pct > 20) add('over-estimate', 'total', 'check', `The total is ${pct}% more than the estimate for this repair.`, `The total is ${pct}% more than your estimate for this repair. Please check.`);
    }
  }

  // 5. duplicates (this vendor only)
  const dups = await findDuplicates(row, vendor);
  if (dups.length) add('duplicate', 'invoiceNo', 'block', `This invoice number already exists: ${dups.map((d) => d.text).join('; ')}. Confirm it is not the same bill.`, 'This invoice number is already on another of your bills.', { sig: dups.map((d) => d.key).sort().join('|'), duplicates: dups.map((d) => ({ kind: d.kind, text: d.text })) });

  // 6. informational
  Object.keys(meta).forEach((k) => { if (FIELD_KEYS.includes(k) && meta[k].edited && meta[k].by === 'Vendor') add('vendor-edited', k, 'info', `${FIELD_LABEL[k]} was typed or changed by the vendor.`, null); });
  if (meta.ai === 'off') add('ai-unavailable', null, 'info', 'AI reading is not switched on. The details were not read from the bill: type them from the picture.', null);
  if (meta.ai === 'limit') add('ai-unavailable', null, 'info', 'The daily AI reading limit was reached. Type the details from the picture, or press "Read with AI" tomorrow.', null);
  if (meta.ai === 'failed') add('ai-unavailable', null, 'info', `The AI could not read this bill${row.aiError ? ` (${row.aiError})` : ''}. Type the details from the picture.`, null);
  if ((meta.derived || []).length) add('derived', null, 'info', `Filled by arithmetic, not read: ${(meta.derived || []).map((k) => FIELD_LABEL[k] || k).join(', ')}.`, null);
  return { flags: out, assetId: asset ? asset.id : null, repairId: repair ? repair.id : null };
}

// The vendor's repairs/assets as matching candidates. keysOfAssets: [{id, keys}] ; keysByAsset: Map(assetId -> keys) ; repairs: AssetRepair rows (own set)
// rows: list rows ({ id }); raws: their parsed VendorBillUpload rows. Adds rows[i].items = billLineAssets.summary(...). One candidates
// list per vendor, one lines and one links query for the whole page. Never fails the list (items stay null).
async function itemsOf(rows, raws, M = null) {
  if (!rows.length) return;
  try {
    const BLA = require('./billLineAssets'); // eslint-disable-line global-require
    const byId = new Map(raws.map((r) => [r.id, r]));
    const ids = rows.map((r) => r.id);
    const linesBy = new Map(); const linksBy = new Map();
    for (let i = 0; i < ids.length; i += 500) { // SQLite: keep each IN list short
      const part = ids.slice(i, i + 500); const marks = part.map(() => '?').join(',');
      // eslint-disable-next-line no-await-in-loop
      (await DB.q(`SELECT * FROM "VendorBillUploadLine" WHERE "uploadId" IN (${marks}) ORDER BY "lineNo" ASC`, part)).forEach((l) => { if (!linesBy.has(l.uploadId)) linesBy.set(l.uploadId, []); linesBy.get(l.uploadId).push(l); });
      let ks = [];
      try { ks = await DB.q(`SELECT * FROM "VendorBillLineAsset" WHERE "uploadId" IN (${marks})`, part); } catch { ks = []; } // eslint-disable-line no-await-in-loop
      ks.forEach((k) => { if (!linksBy.has(k.uploadId)) linksBy.set(k.uploadId, new Map()); linksBy.get(k.uploadId).set(Number(k.lineNo), k); });
    }
    const vendorCtx = new Map(); // vendorId -> { cands, full }: the vendor's assets loaded once for every bill of the list
    for (const r of rows) {
      const raw = byId.get(r.id);
      if (!raw) continue; // eslint-disable-line no-continue
      const ls = linesBy.get(r.id) || [];
      if (!ls.length) { r.items = { count: 0, needsReview: 0, items: [] }; continue; } // eslint-disable-line no-continue
      if (!vendorCtx.has(raw.vendorId)) {
        const cands = await candidatesFor(raw.vendorId); // eslint-disable-line no-await-in-loop
        vendorCtx.set(raw.vendorId, { cands, full: await BLA.assetsById(cands.assets.map((a) => a.id)) }); // eslint-disable-line no-await-in-loop
      }
      const c = vendorCtx.get(raw.vendorId);
      // eslint-disable-next-line no-await-in-loop
      r.items = BLA.summary(await BLA.lineAssets(ls, c.cands, raw.invoiceDate || raw.serviceDate, raw.assetId || null, M, { links: linksBy.get(r.id) || new Map(), full: c.full }));
    }
  } catch (e) {
    console.error('[bill-upload] items:', e.message); // eslint-disable-line no-console
  }
}

async function candidatesFor(vendorId) {
  const v = { vendorId };
  const M = await AVP().ensureMask();
  const ids = [...await AVP().visibleRepairIds(v)];
  const repairs = ids.length ? await prisma.assetRepair.findMany({ where: { id: { in: ids } }, include: { asset: true } }) : [];
  const L = await HS.listing(v);
  const listed = L.where === HS.NONE ? [] : await prisma.asset.findMany({ where: L.where, take: 5000 });
  const byId = new Map();
  [...listed, ...repairs.map((r) => r.asset)].forEach((a) => { if (a) byId.set(a.id, a); });
  const keysByAsset = new Map();
  byId.forEach((a) => {
    const t = HS.parseType(a.assetType);
    keysByAsset.set(a.id, [a.assetCode, M.code(a), a.serialNumber, t && t.serial].filter(Boolean));
  });
  const keysOfAssets = [...byId.values()].map((a) => ({ id: a.id, keys: keysByAsset.get(a.id) }));
  // a repair number written on the bill points at that repair's asset
  repairs.forEach((r) => { const c = keysOfAssets.find((x) => x.id === r.assetId); if (c) c.keys = [...c.keys, r.repairNo]; });
  return { keysOfAssets, keysByAsset, repairs, assets: [...byId.values()] };
}

async function liveBillOfRepair(repairId, exceptSubmissionId) {
  const links = await DB.q('SELECT "billId" FROM "AssetRepairBill" WHERE "repairId" = ?', [repairId]).catch(() => []);
  if (!links.length) return null;
  return prisma.vendorBillSubmission.findFirst({ where: { id: { in: links.map((l) => l.billId), ...(exceptSubmissionId ? { not: exceptSubmissionId } : {}) }, status: { notIn: ['REJECTED', 'WITHDRAWN'] } }, select: { id: true, billCode: true } });
}

// Same vendor + same invoice number (normalised) in: other uploads, the vendor's bills in Accounts' queue, Accounts' bills, the vendor's repair invoice numbers.
async function findDuplicates(row, vendor) {
  const key = row.invoiceNoKey || (row.invoiceNo ? V.normInvoiceNo(row.invoiceNo) : '');
  if (!key) return [];
  const out = [];
  const chain = new Set([row.id]);
  for (let cur = row.supersedes; cur && !chain.has(cur);) { chain.add(cur); const p = await DB.one('SELECT "supersedes" FROM "VendorBillUpload" WHERE "id" = ?', [cur]); cur = p ? p.supersedes : null; } // eslint-disable-line no-await-in-loop
  const ups = await DB.q(`SELECT "id","code","total","status" FROM "VendorBillUpload" WHERE "vendorId" = ? AND "invoiceNoKey" = ? AND "status" NOT IN ('REJECTED','SUPERSEDED','NOT_SENT')`, [row.vendorId, key]);
  ups.filter((u) => !chain.has(u.id)).forEach((u) => out.push({ kind: 'upload', key: `u:${u.id}`, text: `upload ${u.code} (${LABEL[u.status].toLowerCase()}${u.total != null ? `, ₹${u.total}` : ''})` }));
  const subs = await prisma.vendorBillSubmission.findMany({ where: { vendorId: row.vendorId, status: { notIn: ['REJECTED', 'WITHDRAWN'] } }, select: { id: true, billCode: true, billNumber: true, total: true } });
  subs.filter((s) => V.normInvoiceNo(s.billNumber) === key && s.id !== row.submissionId).forEach((s) => out.push({ kind: 'bill', key: `s:${s.id}`, text: `vendor bill ${s.billCode} (₹${s.total})` }));
  const exps = await prisma.officeExpense.findMany({ where: { billNumber: { not: null }, OR: [{ vendorId: row.vendorId }, ...(vendor ? [{ vendor: vendor.name }] : [])], approvalStatus: { not: 'REJECTED' } }, select: { id: true, expenseCode: true, billNumber: true, monthlyAmount: true } });
  exps.filter((e) => V.normInvoiceNo(e.billNumber) === key && e.id !== row.expenseId).forEach((e) => out.push({ kind: 'expense', key: `e:${e.id}`, text: `Accounts bill ${e.expenseCode || ''} (₹${e.monthlyAmount})`.replace('  ', ' ') }));
  const ids = [...await AVP().visibleRepairIds({ vendorId: row.vendorId })].filter((x) => x !== row.repairId);
  if (ids.length) {
    const reps = await prisma.assetRepair.findMany({ where: { id: { in: ids }, invoiceNo: { not: null } }, select: { id: true, repairNo: true, invoiceNo: true } });
    reps.filter((r) => V.normInvoiceNo(r.invoiceNo) === key).forEach((r) => out.push({ kind: 'repair', key: `r:${r.id}`, text: `repair ${r.repairNo}` }));
  }
  return out;
}

// Re-checks an upload and moves it to NEEDS_REVIEW (any flag that needs a person) or PENDING_APPROVAL (clean). Never approves anything.
async function revalidate(id, { moveStatus = true } = {}) {
  await ensure();
  const row = await getRow(id);
  if (!row) return null;
  const res = await computeFlags(row);
  const data = { flagsJson: JSON.stringify(res.flags) };
  // a unique automatic match fills the empty link; a person's choice is never overwritten
  const auto = res.flags.find((f) => f.autoAssetId); const autoRep = res.flags.find((f) => f.autoRepairId);
  if (!row.assetId && auto) data.assetId = auto.autoAssetId;
  if (!row.repairId && autoRep) { data.repairId = autoRep.autoRepairId; if (!data.assetId && !row.assetId) data.assetId = res.assetId; }
  const blocking = res.flags.some((f) => f.level === 'block' || f.level === 'check');
  const target = blocking ? S.NEEDS_REVIEW : S.PENDING_APPROVAL;
  const from = row.status;
  let moved = false;
  if (moveStatus && [S.UPLOADED, S.AI_PROCESSING, S.NEEDS_REVIEW, S.PENDING_APPROVAL].includes(from)) {
    if (from === target) await patch(null, id, data, [from]);
    else moved = !!(await move(null, id, from, target, data));
    if (moved) await event(null, row, { kind: 'status', field: 'status', from: LABEL[from], to: LABEL[target], actorKind: 'System', actorName: 'TeamLink', note: target === S.PENDING_APPROVAL ? 'Everything looks clear. It is waiting for Accounts to approve.' : 'Some details need a person to check them.' });
  } else {
    await patch(null, id, data, [from]);
  }
  const fresh = await getRow(id);
  if (REVIEW_STATES.includes(fresh.status)) await notifyReviewers(fresh).catch((err) => console.error('[bill-upload] notify:', err && err.message)); // eslint-disable-line no-console
  return fresh;
}

// ONE bell per upload (compare-and-set on notifiedAt), to the people the Admin chose for "Vendor bill is waiting for a check".
async function notifyReviewers(row) {
  if (row.notifiedAt) return false;
  const n = await DB.run('UPDATE "VendorBillUpload" SET "notifiedAt" = ? WHERE "id" = ? AND "notifiedAt" IS NULL', [nowIso(), row.id]);
  if (!n) return false;
  try {
    const VC = require('./vendorConfig'); // eslint-disable-line global-require
    const vendor = await vendorOf(row.vendorId);
    const list = await VC.billReviewers('vendorBill');
    const title = 'A vendor uploaded a repair bill: needs review';
    const message = `${vendor ? vendor.name : 'A vendor'} uploaded repair bill ${row.code}${row.invoiceNo ? ` (invoice ${row.invoiceNo}${row.total != null ? `, ₹${row.total}` : ''})` : ''}. Open Office & Accounts → Bills from vendors → Uploaded bills.`;
    await require('./notify').notifyUsers(list.map((u) => u.id), { title, message }); // eslint-disable-line global-require
    for (const u of list) {
      // eslint-disable-next-line no-await-in-loop
      if (u.email) await VC.sendVendorEmail({ to: u.email, subject: `TeamLink: ${title}`, text: `${message}\n\nThis is an automatic message from TeamLink.`, userId: u.id });
    }
    await event(null, row, { kind: 'notified', actorKind: 'System', actorName: 'TeamLink', note: `${list.length} reviewer(s) told.`, visible: false });
  } catch (err) { console.error('[bill-upload] notify:', err && err.message); } // eslint-disable-line no-console
  return true;
}

// ---- signed download ---------------------------------------------------------------------------------------------------------------------
// id = "<uploadId>:<fileId>" ; the vendor's OWN upload only.
async function ownedFile(vendor, compositeId) {
  const [uid, fid] = String(compositeId || '').split(':');
  if (!uid || !fid) return null;
  const row = await mine(vendor, uid);
  if (!row) return null;
  const f = (row.files || []).find((x) => x.id === fid);
  return f ? { file: f.file, mime: f.mime, name: f.name, assetId: row.assetId, billId: row.id } : null;
}
// The first file of the (newest approved/synced) upload for a repair: lets the Invoices page open a bill that came through an upload.
async function fileForRepair(vendorId, repairId) {
  await ensure();
  const row = parse(await DB.one(`SELECT * FROM "VendorBillUpload" WHERE "vendorId" = ? AND "repairId" = ? AND "status" IN ('APPROVED','SYNCED') ORDER BY "uploadedAt" DESC LIMIT 1`, [vendorId, repairId]));
  const f = row && row.files && row.files[0];
  return f ? { file: f.file, mime: f.mime, name: f.name } : null;
}

// the stored bytes of an upload's files, for reading
function loadFiles(row) {
  return (row.files || []).map((f) => {
    const full = attachments.resolveStored(f.file);
    if (!full) throw Object.assign(new Error('missing file'), { code: 'MISSING_FILE' });
    return { name: f.name, mime: f.mime, data: fs.readFileSync(full) };
  });
}

module.exports = {
  S, LABEL, STEPS, STEP_OF, ALLOWED, canMove, VENDOR_EDITABLE, REVIEW_STATES, DEAD, FIELD_KEYS, FIELD_LABEL, COLS,
  ensure, getRow, lines, patch, itemsOf, move, event, nextCode, parse, valuesOf, json, nowIso, newId, ROUND,
  vendorOf, linkMaps, vendorView, vendorHistory, listForVendor, summaryFor, optionsFor, mine, createUpload, viewOf, detailForVendor,
  readEdit, applyEdit, vendorEdit, vendorSubmit, computeFlags, candidatesFor, findDuplicates, revalidate, notifyReviewers, ownedFile, fileForRepair, loadFiles,
  readingOf, unclearFields, filesView, deleteStored, storeFiles, rateProblem, paymentOfUpload,
};

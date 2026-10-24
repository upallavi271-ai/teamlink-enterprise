// ---------------------------------------------------------------------------
// SIM AND CONNECTIONS — the company side (Employee Services -> Assets -> "SIM & connections"), 2026-10-14.
// /api/sim-connections — the Assets (Employee Services) grants: view to read, edit to change.
//
// The company's numbers (mobile number, SIM serial, plan, who holds it, Active / Suspended / Disconnected) and the
// requests it raises to the telecom vendor (new connection, replacement SIM, port-out, plan change). The vendor
// updates its side in its portal (routes/vendorModulePortal.js).
//
// SIM Card is ALREADY an Asset category (53 rows in the real database). Those assets are NOT retyped: the import reads
// them, shows a PREVIEW first (nothing is written), and only the rows the admin ticks are created, each linked to its
// Asset row (SimConnection.assetId). The Asset rows themselves are never changed.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const VP = require('../utils/vendorPortal');
const MODCFG = require('../config/vendorModules');
const DB = require('../utils/vmDb');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => (req.method === 'GET'
  ? requirePerm(null, 'hrms', 'Employee Services', 'view')(req, res, next)
  : requirePerm(null, 'hrms', 'Employee Services', 'edit')(req, res, next)));
router.use(async (req, res, next) => ((await DB.ready()) ? next() : res.status(503).json(DB.NOT_READY)));

const { str } = VP;
const STATUSES = ['Active', 'Suspended', 'Disconnected'];
const KINDS = { new: 'New connection', replacement: 'Replacement SIM', port_out: 'Port-out', plan_change: 'Plan change' };
const actorOf = (req) => req.user.name || req.user.email || 'Admin';
const simRow = (s, extra = {}) => ({ id: s.id, vendorId: s.vendorId, mobileNumber: s.mobileNumber, simSerial: s.simSerial || null, plan: s.plan || null, employeeId: s.employeeId || null, employeeName: s.employeeName || null, status: s.status, assetId: s.assetId || null, notes: s.notes || null, updatedAt: DB.toDate(s.updatedAt), ...extra });
const reqRow = (r, extra = {}) => ({ id: r.id, requestCode: r.requestCode, vendorId: r.vendorId, simId: r.simId || null, kind: r.kind, kindText: KINDS[r.kind] || r.kind, details: r.details || null, status: r.status, vendorNote: r.vendorNote || null, createdByName: r.createdByName || null, createdAt: DB.toDate(r.createdAt), updatedAt: DB.toDate(r.updatedAt), ...extra });
const cleanNumber = (v) => String(v || '').replace(/[^0-9+]/g, '');

router.get('/vendors', async (req, res) => {
  const [vendors, mods] = await Promise.all([
    prisma.officeVendor.findMany({ where: { isActive: true }, select: { id: true, name: true, category: true }, orderBy: { name: 'asc' } }),
    DB.q('SELECT DISTINCT u."vendorId" AS vendorId FROM "VendorLoginModule" m JOIN "VendorUser" u ON u."id" = m."vendorUserId" WHERE m."moduleKey" = \'sim_connections\' AND u."deletedAt" IS NULL AND u."status" = \'Active\''),
  ]);
  const withModule = new Set(mods.map((m) => m.vendorId));
  res.json({ vendors: vendors.filter((v) => withModule.has(v.id) || MODCFG.resolveCategory(v.category) === 'telecom').map((v) => ({ id: v.id, name: v.name, category: v.category || null, hasPortal: withModule.has(v.id) })), statuses: STATUSES, kinds: Object.entries(KINDS).map(([value, label]) => ({ value, label })) });
});

// Employee picker for "Held by" (type to search).
router.get('/employees', async (req, res) => {
  const s = str(req.query.q);
  const emps = await prisma.employee.findMany({ where: s ? { OR: [{ name: { contains: s } }, { employeeCode: { contains: s } }] } : {}, orderBy: { name: 'asc' }, take: 40, select: { id: true, name: true, employeeCode: true } });
  res.json({ employees: emps });
});

router.get('/', async (req, res) => {
  const vid = str(req.query.vendorId);
  const s = str(req.query.q).toLowerCase();
  const sims = await DB.q(`SELECT * FROM "SimConnection" ${vid ? 'WHERE "vendorId" = ?' : ''} ORDER BY "mobileNumber"`, vid ? [vid] : []);
  const reqs = await DB.q(`SELECT * FROM "SimRequest" ${vid ? 'WHERE "vendorId" = ?' : ''} ORDER BY "createdAt" DESC LIMIT 300`, vid ? [vid] : []);
  const vendors = await prisma.officeVendor.findMany({ select: { id: true, name: true } });
  const vn = new Map(vendors.map((v) => [v.id, v.name]));
  const no = new Map(sims.map((x) => [x.id, x.mobileNumber]));
  const rows = sims.map((x) => simRow(x, { vendorName: vn.get(x.vendorId) || '' })).filter((x) => !s || [x.mobileNumber, x.simSerial, x.employeeName, x.plan].some((v) => String(v || '').toLowerCase().includes(s)));
  res.json({ rows, requests: reqs.map((r) => reqRow(r, { vendorName: vn.get(r.vendorId) || '', simNumber: no.get(r.simId) || null })), statuses: STATUSES });
});

async function who(employeeId) {
  if (!employeeId) return { employeeId: null, employeeName: null };
  const e = await prisma.employee.findUnique({ where: { id: String(employeeId) }, select: { id: true, name: true, employeeCode: true } });
  return e ? { employeeId: e.id, employeeName: `${e.name}${e.employeeCode ? ` (${e.employeeCode})` : ''}` } : { error: 'That employee no longer exists.' };
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const vendor = b.vendorId ? await prisma.officeVendor.findUnique({ where: { id: String(b.vendorId) } }) : null;
  if (!vendor || vendor.isActive === false) return res.status(400).json({ error: 'Pick the telecom vendor.', field: 'vendorId' });
  const mobileNumber = cleanNumber(b.mobileNumber);
  if (mobileNumber.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Enter the 10-digit mobile number.', field: 'mobileNumber' });
  const status = STATUSES.includes(str(b.status)) ? str(b.status) : 'Active';
  const w = await who(b.employeeId);
  if (w.error) return res.status(400).json({ error: w.error, field: 'employeeId' });
  const dup = await DB.one('SELECT "id" FROM "SimConnection" WHERE "vendorId" = ? AND "mobileNumber" = ?', [vendor.id, mobileNumber]);
  if (dup) return res.status(409).json({ error: `${mobileNumber} is already in the list.`, field: 'mobileNumber' });
  const id = DB.newId(); const t = DB.now();
  await DB.run('INSERT INTO "SimConnection" ("id","vendorId","mobileNumber","simSerial","plan","employeeId","employeeName","status","notes","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, vendor.id, mobileNumber, VP.cleanText(b.simSerial, 40) || null, VP.cleanText(b.plan, 80) || null, w.employeeId, w.employeeName, status, VP.cleanText(b.notes, 300) || null, req.user.id, t, t]);
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'SIM added', entity: 'SimConnection', entityId: id, toValue: `${mobileNumber} · ${vendor.name}` });
  return res.status(201).json({ sim: simRow(await DB.one('SELECT * FROM "SimConnection" WHERE "id" = ?', [id])), message: `${mobileNumber} added.` });
});

router.patch('/:id', async (req, res) => {
  const s = await DB.one('SELECT * FROM "SimConnection" WHERE "id" = ?', [String(req.params.id)]);
  if (!s) return res.status(404).json({ error: 'Number not found.' });
  const b = req.body || {};
  const set = []; const params = []; const changes = [];
  const put = (col, val, label) => { if (val !== undefined && String(val ?? '') !== String(s[col] ?? '')) { set.push(`"${col}" = ?`); params.push(val); changes.push(`${label}: ${s[col] || '-'} -> ${val || '-'}`); } };
  if (b.simSerial !== undefined) put('simSerial', VP.cleanText(b.simSerial, 40) || null, 'SIM serial');
  if (b.plan !== undefined) put('plan', VP.cleanText(b.plan, 80) || null, 'Plan');
  if (b.notes !== undefined) put('notes', VP.cleanText(b.notes, 300) || null, 'Notes');
  if (b.employeeId !== undefined) {
    const w = await who(b.employeeId || null);
    if (w.error) return res.status(400).json({ error: w.error, field: 'employeeId' });
    put('employeeId', w.employeeId, 'Employee id'); put('employeeName', w.employeeName, 'Assigned to');
  }
  if (b.status !== undefined && STATUSES.includes(str(b.status))) put('status', str(b.status), 'Status');
  if (!set.length) return res.json({ sim: simRow(s), message: 'Nothing changed.' });
  await DB.run(`UPDATE "SimConnection" SET ${set.join(', ')}, "updatedAt" = ? WHERE "id" = ?`, [...params, DB.now(), s.id]);
  await VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: 'Admin', vendorId: s.vendorId, assetId: s.assetId || null, action: 'SIM edited by company', newValue: changes.join(' | ').slice(0, 480), status: s.mobileNumber });
  return res.json({ sim: simRow(await DB.one('SELECT * FROM "SimConnection" WHERE "id" = ?', [s.id])), message: 'Saved.' });
});

// ---- requests the company raises ------------------------------------------------
router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const vendor = b.vendorId ? await prisma.officeVendor.findUnique({ where: { id: String(b.vendorId) } }) : null;
  if (!vendor || vendor.isActive === false) return res.status(400).json({ error: 'Pick the telecom vendor.', field: 'vendorId' });
  const kind = str(b.kind);
  if (!KINDS[kind]) return res.status(400).json({ error: 'Pick the kind of request.', field: 'kind' });
  let simId = null;
  if (str(b.simId)) {
    const s = await DB.one('SELECT "id" FROM "SimConnection" WHERE "id" = ? AND "vendorId" = ?', [str(b.simId), vendor.id]);
    if (!s) return res.status(400).json({ error: 'Pick one of this vendor\'s numbers.', field: 'simId' });
    simId = s.id;
  }
  if (kind !== 'new' && !simId) return res.status(400).json({ error: 'Pick the number this request is about.', field: 'simId' });
  const details = VP.cleanText(b.details, 800) || null;
  const id = DB.newId(); const t = DB.now();
  let code;
  await prisma.$transaction(async (tx) => {
    code = await DB.nextCode('SimRequest', 'requestCode', 'SRQ', 4, tx);
    await DB.run('INSERT INTO "SimRequest" ("id","requestCode","vendorId","simId","kind","details","status","createdById","createdByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, code, vendor.id, simId, kind, details, 'Open', req.user.id, actorOf(req), t, t], tx);
  }, { timeout: 20000 });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'SIM request raised', entity: 'SimRequest', entityId: id, toValue: `${code} · ${KINDS[kind]} · ${vendor.name}` });
  await VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: 'Admin', vendorId: vendor.id, action: 'SIM request raised', newValue: `${code} · ${KINDS[kind]}`, status: code });
  return res.status(201).json({ request: reqRow(await DB.one('SELECT * FROM "SimRequest" WHERE "id" = ?', [id])), message: `Request ${code} sent to ${vendor.name}.` });
});

// ---- import the existing "SIM Card" assets: PREVIEW first, then only the ticked rows ------------
const NUMBER_RE = /(?:^|\D)(\d{10})(?!\d)/;
function readAsset(a) {
  const number = (NUMBER_RE.exec(`${a.name || ''} ${a.assetType || ''} ${a.serialNumber || ''}`) || [])[1] || '';
  const iccid = ((/ICCID\s*([0-9A-Za-z]{10,})/i.exec(`${a.assetType || ''} ${a.name || ''}`) || [])[1]) || a.serialNumber || '';
  const status = ['Retired', 'Sold', 'Written off'].includes(a.status) ? 'Disconnected' : 'Active';
  return { number, iccid, status };
}
async function candidates(vendorId) {
  const assets = await prisma.asset.findMany({ where: { category: 'SIM Card' }, include: { assignedTo: { select: { id: true, name: true, employeeCode: true } } }, orderBy: { assetCode: 'asc' } });
  const have = await DB.q('SELECT "assetId","mobileNumber" FROM "SimConnection" WHERE "vendorId" = ?', [vendorId]);
  const byAsset = new Set(have.map((h) => h.assetId).filter(Boolean));
  const byNo = new Set(have.map((h) => h.mobileNumber));
  return assets.map((a) => {
    const r = readAsset(a);
    let action = 'import'; let why = '';
    if (!r.number) { action = 'skip'; why = 'No 10-digit mobile number found on this asset.'; } else if (byAsset.has(a.id) || byNo.has(r.number)) { action = 'skip'; why = 'Already in the SIM list.'; }
    return {
      assetId: a.id, assetCode: a.assetCode, assetName: a.name, mobileNumber: r.number, simSerial: r.iccid || null, status: r.status,
      employeeId: a.assignedTo ? a.assignedTo.id : null, employeeName: a.assignedTo ? `${a.assignedTo.name}${a.assignedTo.employeeCode ? ` (${a.assignedTo.employeeCode})` : ''}` : null, action, why,
    };
  });
}
router.get('/import-preview', async (req, res) => {
  const vendor = await prisma.officeVendor.findUnique({ where: { id: str(req.query.vendorId) } });
  if (!vendor) return res.status(400).json({ error: 'Pick the telecom vendor.', field: 'vendorId' });
  const rows = await candidates(vendor.id);
  res.json({ dryRun: true, vendor: { id: vendor.id, name: vendor.name }, rows, summary: { total: rows.length, willImport: rows.filter((r) => r.action === 'import').length, skipped: rows.filter((r) => r.action === 'skip').length }, note: 'Preview only: nothing has been written. Tick the rows and press Import.' });
});
router.post('/import', async (req, res) => {
  const b = req.body || {};
  const vendor = await prisma.officeVendor.findUnique({ where: { id: str(b.vendorId) } });
  if (!vendor || vendor.isActive === false) return res.status(400).json({ error: 'Pick the telecom vendor.', field: 'vendorId' });
  const rows = (await candidates(vendor.id)).filter((r) => r.action === 'import');
  const want = b.all === true ? rows : rows.filter((r) => (Array.isArray(b.assetIds) ? b.assetIds : []).map(String).includes(r.assetId));
  if (!want.length) return res.status(400).json({ error: 'Nothing to import. Tick at least one row of the preview.' });
  const t = DB.now();
  let made = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of want) {
      // eslint-disable-next-line no-await-in-loop
      const dup = await DB.one('SELECT "id" FROM "SimConnection" WHERE "vendorId" = ? AND "mobileNumber" = ?', [vendor.id, r.mobileNumber], tx);
      if (dup) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT INTO "SimConnection" ("id","vendorId","mobileNumber","simSerial","plan","employeeId","employeeName","status","assetId","notes","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [DB.newId(), vendor.id, r.mobileNumber, r.simSerial, null, r.employeeId, r.employeeName, r.status, r.assetId, `Imported from asset ${r.assetCode}`, req.user.id, t, t], tx);
      made += 1;
    }
  }, { timeout: 30000 });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'SIM list imported from assets', entity: 'SimConnection', toValue: `${vendor.name}: ${made} number(s) from SIM Card assets` });
  await VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: 'Admin', vendorId: vendor.id, action: 'SIM list imported from assets', newValue: `${made} number(s)` });
  return res.status(201).json({ imported: made, message: `${made} number(s) added from your SIM Card assets. The assets themselves were not changed.` });
});

module.exports = router;

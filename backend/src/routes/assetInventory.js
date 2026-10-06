const express = require('express');
const prisma = require('../db');
const crypto = require('crypto');
const { scopeOf, hrmsGlobal, employeeWhere } = require('../utils/scope');
const attachments = require('../utils/attachments');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { toCsv, toXlsx, toPdf } = require('../utils/tabularExport');
const { notifyDataIo } = require('../utils/dataIoNotify');
// Accounts spec S2: assets + repairs -> Journal & Ledgers (Accounts only reads).
const AP = require('../utils/assetPosting');

const router = express.Router();
router.use(requireAuth);

// Sold / Written off (Accounts spec S2): the asset leaves the books with a
// Sale / Disposal journal. Available / Assigned are the spec's Active / Returned.
const STATUSES = ['Available', 'Assigned', 'In Repair', 'Retired', 'Sold', 'Written off'];
const LEFT_BOOKS = ['Retired', 'Sold', 'Written off'];

// The company asset inventory behind Employee Services → Assets. Unlike the
// per-employee asset *requests* on EmployeeRecord(type:'ASSET'), an asset here
// can sit unassigned in the pool, which is what the prototype's inventory,
// transfer, return, maintenance, disposal and audit screens all read.

function parseHistory(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// A history entry as the screen gets it. A repair slip's STORED name (the
// random file on disk) never leaves the server; the screen gets the display
// name, type and size, and fetches the file through GET /:id/repair/:entryId/slip.
function publicEntry(h) {
  if (!h || !h.slip) return h;
  const { file, ...slip } = h.slip;
  return { ...h, slip: { ...slip, attached: !!file } };
}

// The HOLDER as the asset screens need them — identity, department, role and
// status, nothing else. This used to be the whole Employee row (bank account,
// PAN, address …) handed to anyone who could open the asset register.
const HOLDER_SELECT = {
  id: true, employeeCode: true, name: true, department: true, designation: true,
  location: true, branch: true, employmentStatus: true,
};

function present(a) {
  const { assignedTo, ...rest } = a;
  const holder = assignedTo
    ? Object.fromEntries(Object.keys(HOLDER_SELECT).map((k) => [k, assignedTo[k] ?? null]))
    : null;
  return {
    ...rest,
    assignedTo: holder,
    history: parseHistory(a.history).map(publicEntry),
    assignedToName: holder ? holder.name : null,
    allocation: a.assignedToId ? 'Allocated' : 'Unallocated',
    // The department it counts under (holder's, or in stock its seat's) and
    // the seat's own department — the filter and the screen use these.
    department: holder ? holder.department || null : deptOfSeat(a.location),
    seatDepartment: deptOfSeat(a.location),
  };
}

// ---- Asset report filters (hrms-24 §6) --------------------------------------
// Every filter runs ON THE SERVER, over the scoped register, and they combine
// (AND): Department = R&D + Status = Assigned + a date range is one query.
//
//   q            free search: asset code / name / category / type / location,
//                holder's employee ID or name
//   employeeCode, employeeName, department   the HOLDER (an unassigned asset
//                has none, so it drops out once any of these is set)
//   category, assetType, assetCode, assetName, location, assignedBy
//   allocation   Allocated | Unallocated
//   status       Available | Assigned | In Repair | Retired
//   assignedDate, returnDate   one calendar day (YYYY-MM-DD)
//   from, to + dateField       a range over assigned | returned | purchased
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d) => new Date(`${d}T00:00:00`);
const dayEnd = (d) => new Date(new Date(`${d}T00:00:00`).getTime() + 86400000);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// WHO SEES WHICH ASSETS (user, 2026-09-29): "every employee sees only the
// assets assigned to them; a TL sees their department's assets." Before this,
// every scoped login also saw EVERY unassigned asset. Now:
//   Super Admin / Admin / HR (the asset desk)  → all assets, unassigned too
//   Manager / Assistant Manager                → all assets (view-only by role)
//   TL / STL                                   → assets held by people in their department(s)
//   everyone else                              → only the assets assigned to them
function assetScope(user) {
  const s = scopeOf(user);
  if (s.global || hrmsGlobal(user)) return null;
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(s.hrmsRole)) return null;
  if (['TL', 'STL'].includes(s.hrmsRole) && s.departments && s.departments.length) {
    return { assignedTo: { is: { department: { in: s.departments } } } };
  }
  return { assignedToId: s.employeeId || '__none__' };
}

// THE SAME SCOPE ON EVERY :id ROUTE. The list was scoped, but the write
// routes looked an asset up by id alone, so anyone holding the edit grant
// (an STL, or a role an admin widened) could change ANY asset by knowing its
// id. Outside the login's reach reads as "not found", exactly as if the id
// did not exist.
async function assetInScope(req, id, include) {
  const scope = assetScope(req.user);
  return prisma.asset.findFirst({
    where: { AND: [{ id: String(id || '') }, scope || {}] },
    ...(include ? { include } : {}),
  });
}
const NOT_FOUND = { error: 'Asset not found' };

// THE ASSET DESK — Super Admin / Admin / HR (user, 2026-10-05: "Super Admin
// and HR can edit the assets"). Editing an asset's details needs BOTH the
// Employee Services edit grant AND a desk role, so a TL / STL / employee who
// was given the edit grant for repairs or hand-overs still cannot rewrite an
// asset's name, cost or dates. A Manager / Assistant Manager is view-only.
function isAssetDesk(user) {
  const s = scopeOf(user);
  return !!(s.adminGlobal || s.hrmsRole === 'HR');
}
async function mayEditAsset(user) {
  if (!isAssetDesk(user)) return false;
  try { return !!(await can(user, null, 'hrms', 'Employee Services', 'edit')); } catch { return false; }
}

// The Department choices for this login. The asset desk and the view-only
// Manager (assetScope null) get EVERY ACTIVE department on the Department
// master, plus any department an asset holder is filed under that the master
// does not list (old records), so no held asset ever has an unpickable
// department. A TL / STL gets only their own department(s); an employee gets
// the departments of the assets they can see.
async function departmentChoices(user, scopedAssets = []) {
  const fromHolders = scopedAssets.map((a) => a.assignedTo && a.assignedTo.department).filter(Boolean);
  let names = fromHolders;
  if (!assetScope(user)) {
    const master = await prisma.department.findMany({ where: { active: true }, select: { name: true } });
    names = [...master.map((d) => d.name), ...fromHolders];
  } else {
    const s = scopeOf(user);
    if (['TL', 'STL'].includes(s.hrmsRole) && s.departments && s.departments.length) names = [...s.departments, ...fromHolders];
  }
  return [...new Set(names.filter((d) => d && d !== '—'))].sort((a, b) => a.localeCompare(b));
}

// Active people only for a hand-over — a relieved / exited employee cannot
// receive an asset. Test logins never appear (agent-rules lesson 2026-09-29).
const GONE = ['Relieved', 'Exited'];
const NOT_TEST = [
  { NOT: { name: { contains: 'ZZTEST' } } }, { NOT: { name: { contains: 'zztest' } } },
  // email is optional: a NOT on a NULL column would drop the person too.
  { OR: [{ email: null }, { NOT: { email: { contains: 'example.test' } } }] },
];

// THE SEAT'S DEPARTMENT — ONE RULE (user, 2026-10-05): a seat code's FIRST
// word decides it. "BDE TL", "BDE EDU-1", "BDE MED", "BDE MFG-2" are ALWAYS
// BDE; "MED TL" / "MED-3" Medical; "MFG TL" / "MFG-2" Manufacturing;
// "EDU TL" / "EDU-5" Education; "HR" / "HR TL" HR; "R&D TL" / "R&D-1" R&D.
// The seat is stored in Asset.location. An asset IN STOCK counts under its
// seat's department; an ASSIGNED one under its holder's department.
// The screen reads the result as `department` / `seatDepartment` on each
// asset (present()), so this table is the only copy.
const SEAT_DEPARTMENTS = { BDE: 'BDE', MED: 'Medical', MFG: 'Manufacturing', EDU: 'Education', HR: 'HR', 'R&D': 'R&D' };
function deptOfSeat(code) {
  const first = str(code).toUpperCase().split(/[\s-]+/)[0];
  return SEAT_DEPARTMENTS[first] || null;
}
// The where-arm for "location is a seat of department d" (first word = token).
const seatArms = (d) => Object.keys(SEAT_DEPARTMENTS).filter((t) => SEAT_DEPARTMENTS[t] === d)
  .flatMap((t) => [{ location: t }, { location: { startsWith: `${t} ` } }, { location: { startsWith: `${t}-` } }]);
function departmentArm(d) {
  const seats = seatArms(d);
  const held = { assignedTo: { is: { department: d } } };
  return seats.length ? { OR: [held, { AND: [{ assignedToId: null }, { OR: seats }] }] } : held;
}
// The department an asset counts under: its holder's, or (in stock) its seat's.
const assetDepartment = (a) => (a.assignedTo ? a.assignedTo.department || null : deptOfSeat(a.location));

function assetWhere(user, q = {}) {
  const scope = assetScope(user);
  const and = [scope || {}];
  const holder = {};
  if (str(q.employeeCode)) holder.employeeCode = { contains: str(q.employeeCode) };
  if (str(q.employeeName)) holder.name = { contains: str(q.employeeName) };
  if (Object.keys(holder).length) and.push({ assignedTo: { is: holder } });
  // DEPARTMENT = the holder's department, OR — for an asset in stock — the
  // department its seat belongs to (location "BDE EDU-1", "HR", "R&D-3"):
  // user, 2026-10-05, "selecting BDE must show all BDE seats' assets".
  if (str(q.department)) and.push(departmentArm(str(q.department)));
  if (str(q.category)) and.push({ category: str(q.category) });
  if (str(q.assetType)) and.push({ assetType: { contains: str(q.assetType) } });
  if (str(q.assetCode)) and.push({ assetCode: { contains: str(q.assetCode) } });
  if (str(q.assetName)) and.push({ name: { contains: str(q.assetName) } });
  if (str(q.location)) and.push({ location: { contains: str(q.location) } });
  if (str(q.assignedBy)) and.push({ assignedByName: { contains: str(q.assignedBy) } });
  if (str(q.status)) and.push({ status: str(q.status) });
  if (str(q.allocation) === 'Allocated') and.push({ assignedToId: { not: null } });
  if (str(q.allocation) === 'Unallocated') and.push({ assignedToId: null });
  if (YMD.test(str(q.assignedDate))) and.push({ assignedAt: { gte: dayStart(q.assignedDate), lt: dayEnd(q.assignedDate) } });
  if (YMD.test(str(q.returnDate))) and.push({ returnedAt: { gte: dayStart(q.returnDate), lt: dayEnd(q.returnDate) } });
  const from = YMD.test(str(q.from)) ? str(q.from) : null;
  const to = YMD.test(str(q.to)) ? str(q.to) : null;
  if (from || to) {
    const field = str(q.dateField) || 'assigned';
    if (field === 'purchased') {
      // purchaseDate is a YYYY-MM-DD string, so it compares as text.
      const r = {};
      if (from) r.gte = from;
      if (to) r.lte = to;
      and.push({ purchaseDate: r });
    } else {
      const r = {};
      if (from) r.gte = dayStart(from);
      if (to) r.lt = dayEnd(to);
      if (field === 'returned') and.push({ returnedAt: r });
      else if (field === 'any') and.push({ OR: [{ assignedAt: r }, { returnedAt: r }] });
      else and.push({ assignedAt: r });
    }
  }
  if (str(q.q)) {
    const s = str(q.q);
    and.push({
      OR: [
        { assetCode: { contains: s } }, { name: { contains: s } }, { category: { contains: s } },
        { assetType: { contains: s } }, { location: { contains: s } },
        { assignedTo: { is: { OR: [{ name: { contains: s } }, { employeeCode: { contains: s } }] } } },
      ],
    });
  }
  return { AND: and };
}

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
// Purchase cost in ₹ (user, 2026-10-03). '' / null clears it; anything else
// must be a number of 0 or more. Returns undefined when the field is absent.
function costOf(v) {
  if (v === undefined) return undefined;
  const raw = String(v ?? '').replace(/[,\s₹]/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
// The purchase / depreciation / disposal fields (Accounts spec S2.1). Only
// the keys present in the body are returned; '' clears a field.
const PAID_VIA = ['Bank', 'Cash', 'Payable'];
const ACC_LABEL = {
  vendor: 'Vendor', invoiceNo: 'Invoice no.', gstPaid: 'GST paid', paidVia: 'Paid via', paidBankAccountId: 'Paid from bank',
  usefulLifeYears: 'Useful life (years)', depreciationMethod: 'Depreciation method', depreciationRate: 'Depreciation rate %',
  salvageValue: 'Salvage value', disposalDate: 'Sold / written off on', disposalAmount: 'Sale amount', disposalPaidVia: 'Sale money received in', disposalNote: 'Disposal note',
};
const ACC_MONEY = ['gstPaid', 'salvageValue', 'disposalAmount'];
function accountingFields(body) {
  const data = {};
  const has = (k) => body[k] !== undefined;
  for (const k of ['vendor', 'invoiceNo', 'disposalNote', 'paidBankAccountId']) if (has(k)) data[k] = str(body[k]).slice(0, 200) || null;
  for (const k of ['gstPaid', 'usefulLifeYears', 'depreciationRate', 'salvageValue', 'disposalAmount']) {
    if (!has(k)) continue;
    const n = costOf(body[k]);
    if (Number.isNaN(n)) return { error: `${ACC_LABEL[k]} must be a number of 0 or more.` };
    data[k] = n;
  }
  if (has('depreciationMethod')) {
    const m = str(body.depreciationMethod).toUpperCase();
    if (m && !['SL', 'WDV'].includes(m)) return { error: 'Depreciation method is SL (straight line) or WDV (written down value).' };
    data.depreciationMethod = m || null;
  }
  if (has('paidVia')) {
    const v = str(body.paidVia);
    if (v && !PAID_VIA.includes(v)) return { error: 'Paid via is Bank, Cash or Payable.' };
    data.paidVia = v || null;
  }
  if (has('disposalPaidVia')) {
    const v = str(body.disposalPaidVia);
    if (v && !['Bank', 'Cash'].includes(v)) return { error: 'Sale money is received in Bank or Cash.' };
    data.disposalPaidVia = v || null;
  }
  if (has('disposalDate')) {
    const d = str(body.disposalDate);
    if (d && !YMD.test(d)) return { error: 'Pick a proper sold / written-off date.' };
    data.disposalDate = d || null;
  }
  if (data.depreciationRate != null && data.depreciationRate > 100) return { error: 'Depreciation rate is a % up to 100.' };
  return { data };
}
const accActor = (req) => ({ id: req.user.id, name: req.user.name || req.user.email || 'HRMS' });

const EXPORT_HEADERS = [
  'Asset ID', 'Asset Name', 'Category', 'Asset Type', 'Asset Status', 'Allocation Status',
  'Employee ID', 'Employee Name', 'Department', 'Designation', 'Location',
  'Assigned Date', 'Assigned By', 'Return Date', 'Purchase Date', 'Purchase Cost', 'Warranty Until',
];
function exportRow(a) {
  const h = a.assignedTo || {};
  return [
    a.assetCode, a.name, a.category || '', a.assetType || '', a.status, a.allocation,
    h.employeeCode || '', h.name || '', assetDepartment(a) || '', h.designation || '', a.location || '',
    ymd(a.assignedAt), a.assignedByName || '', ymd(a.returnedAt), a.purchaseDate || '', a.purchaseCost ?? '', a.warrantyUntil || '',
  ];
}

async function pushHistory(asset, req, text) {
  const history = parseHistory(asset.history);
  history.unshift({ at: new Date().toISOString().slice(0, 16).replace('T', ' '), by: req.user.name, text });
  return JSON.stringify(history);
}

async function nextCode() {
  const count = await prisma.asset.count();
  return `AST-${String(count + 1).padStart(4, '0')}`;
}

router.get('/', async (req, res) => {
  // SCOPED BY WHO HOLDS THE ASSET. An unassigned asset is company stock and
  // stays visible to anyone who may open this screen; an ASSIGNED one is a
  // fact about that employee, so it follows them. Without this a TL read the
  // whole company's asset register.
  // The report filters (assetWhere above) narrow that same scoped set.
  const assets = await prisma.asset.findMany({
    where: assetWhere(req.user, req.query), include: { assignedTo: { select: HOLDER_SELECT } }, orderBy: { createdAt: 'desc' },
  });
  res.json(assets.map(present));
});

// The choices the report's selects offer — distinct values over the SCOPED,
// unfiltered register, so nothing outside this login's reach is ever named.
router.get('/options', async (req, res, next) => {
  try {
    const assets = await prisma.asset.findMany({
      where: assetWhere(req.user, {}), include: { assignedTo: { select: HOLDER_SELECT } },
    });
    const distinct = (fn) => [...new Set(assets.map(fn).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    // DEPARTMENT = EVERY ACTIVE DEPARTMENT, with how many assets its people
    // hold (user, 2026-10-05: "HR and R&D are not in the filter"). It used to
    // list only departments that already held an asset, so a department with
    // none could never be picked. A department with 0 shows "(0)" — the user
    // asked for that, so it stays selectable. The counts CASCADE: they are
    // taken over the rows matching every OTHER filter sent in the query.
    const others = { ...req.query, department: '' };
    const filtered = await prisma.asset.findMany({
      where: assetWhere(req.user, others), select: { location: true, assignedTo: { select: { department: true } } },
    });
    const names = await departmentChoices(req.user, assets);
    // Held by someone in it, or in stock at one of its seats (departmentArm).
    const held = {};
    filtered.forEach((a) => {
      const d = assetDepartment(a);
      if (d) held[d] = (held[d] || 0) + 1;
    });
    const departmentCounts = names.map((name) => ({ name, count: held[name] || 0 }));
    res.json({
      statuses: STATUSES,
      allocations: ['Allocated', 'Unallocated'],
      categories: distinct((a) => a.category),
      assetTypes: distinct((a) => a.assetType),
      locations: distinct((a) => a.location),
      assignedBy: distinct((a) => a.assignedByName),
      departments: names,
      departmentCounts,
      total: assets.length,
      // Who may change an asset's details (PATCH /:id) — the screen draws
      // the Edit button from this, the route checks it again.
      canEdit: await mayEditAsset(req.user),
    });
  } catch (err) { next(err); }
});

// WHO AN ASSET CAN GO TO — the Allocate / Transfer dialog's two steps:
// pick the Department (every active department, with how many active people
// it has), then one of that department's ACTIVE employees. The asset desk may
// hand an asset to anyone; a scoped login (an STL) only to their own people,
// the same rule PATCH /:id/assign enforces.
router.get('/people', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res, next) => {
  try {
    const scoped = !!assetScope(req.user);
    const people = await prisma.employee.findMany({
      where: { AND: [{ employmentStatus: { notIn: GONE } }, ...NOT_TEST, scoped ? employeeWhere(req.user) : {}] },
      select: { id: true, employeeCode: true, name: true, department: true, designation: true },
      orderBy: { name: 'asc' },
    });
    // Each person's seat code(s) — the seats of the assets they hold ("BDE EDU-1").
    const held = await prisma.asset.findMany({ where: { assignedToId: { in: people.map((p) => p.id) } }, select: { assignedToId: true, location: true } });
    const seats = {};
    held.forEach((a) => { if (deptOfSeat(a.location)) (seats[a.assignedToId] = seats[a.assignedToId] || new Set()).add(a.location); });
    people.forEach((p) => { p.seats = seats[p.id] ? [...seats[p.id]].sort() : []; });
    const count = {};
    people.forEach((p) => { if (p.department) count[p.department] = (count[p.department] || 0) + 1; });
    let names = Object.keys(count);
    if (!scoped) {
      const master = await prisma.department.findMany({ where: { active: true }, select: { name: true } });
      names = [...master.map((d) => d.name), ...names];
    }
    names = [...new Set(names)].sort((a, b) => a.localeCompare(b));
    res.json({
      departments: names.map((name) => ({ name, count: count[name] || 0 })),
      employees: people,
      // People with no department on file still need to be reachable.
      noDepartment: people.filter((p) => !p.department).length,
    });
  } catch (err) { next(err); }
});

// Export — exactly the filtered, scoped rows, as Excel or CSV. The `export`
// action is the permission; the scope is assetWhere()'s, the same as the list.
async function sendAssetExport(req, res, format) {
  const assets = (await prisma.asset.findMany({
    where: assetWhere(req.user, req.query), include: { assignedTo: { select: HOLDER_SELECT } }, orderBy: { assetCode: 'asc' },
  })).map(present);
  const rows = assets.map(exportRow);
  await logAudit({
    userId: req.user.id, action: `Asset report exported (${format.toUpperCase()})`, entity: 'Asset',
    toValue: `${rows.length} asset(s)`,
  });
  // Every export tells the Super Admin (utils/dataIoNotify.js; never throws).
  await notifyDataIo(req, { kind: 'export', module: 'Assets', count: rows.length, what: 'assets', format, detail: 'Asset report (filtered register)' });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="asset-report-${stamp}.csv"`);
    return res.send(toCsv(EXPORT_HEADERS, rows));
  }
  // hrms-24 §3 — the same rows as a PDF, for the shared Export menu.
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="asset-report-${stamp}.pdf"`);
    return res.send(toPdf(EXPORT_HEADERS, rows, {
      title: 'Asset Report',
      subtitle: `${rows.length} asset(s) · exported ${new Date().toLocaleString('en-GB')} by ${req.user.name || 'user'}`,
    }));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="asset-report-${stamp}.xlsx"`);
  return res.send(toXlsx(EXPORT_HEADERS, rows, 'Assets'));
}
router.get('/export.csv', requirePerm(null, 'hrms', 'Employee Services', 'export'), (req, res, next) => sendAssetExport(req, res, 'csv').catch(next));
router.get('/export.xlsx', requirePerm(null, 'hrms', 'Employee Services', 'export'), (req, res, next) => sendAssetExport(req, res, 'xlsx').catch(next));
router.get('/export.pdf', requirePerm(null, 'hrms', 'Employee Services', 'export'), (req, res, next) => sendAssetExport(req, res, 'pdf').catch(next));

router.post('/', requirePerm(null, 'hrms', 'Employee Services', 'create'), async (req, res) => {
  const { name, category, purchaseDate, warrantyUntil, assetType, location } = req.body;
  if (!name) return res.status(400).json({ error: 'An asset name is required' });
  const purchaseCost = costOf(req.body.purchaseCost);
  if (Number.isNaN(purchaseCost)) return res.status(400).json({ error: 'Purchase cost must be a number, like 55000.' });
  const acc = accountingFields(req.body || {});
  if (acc.error) return res.status(400).json({ error: acc.error });
  const asset = await prisma.asset.create({
    data: {
      assetCode: await nextCode(),
      name,
      category: category || 'Laptop',
      status: 'Available',
      purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
      purchaseCost: purchaseCost ?? null,
      warrantyUntil: warrantyUntil || null,
      assetType: str(assetType) || null,
      location: str(location) || null,
      ...acc.data,
      history: '[]',
    },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset added', entity: 'Asset', entityId: asset.id, toValue: asset.name });
  // A new asset with a cost is posted to the journal at once (S2.3).
  const accounts = await AP.autoSync({ assetId: asset.id }, accActor(req));
  res.status(201).json({ ...present(asset), accounts });
});

// Assign (or transfer) an asset to an employee.
router.patch('/:id/assign', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const { employeeId } = req.body;
  const asset = await assetInScope(req, req.params.id);
  if (!asset) return res.status(404).json(NOT_FOUND);
  if (['Sold', 'Written off'].includes(asset.status)) return res.status(400).json({ error: `This asset is ${asset.status.toLowerCase()} — it cannot be assigned.` });
  // A scoped login (an STL) may only hand an asset to someone in their own
  // people list; the asset desk (assetScope null) may give it to anyone.
  const employee = await prisma.employee.findFirst({
    where: { AND: [{ id: String(employeeId || '') }, assetScope(req.user) ? employeeWhere(req.user) : {}] },
  });
  if (!employee) return res.status(400).json({ error: 'Pick an employee from your list.' });
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: {
      assignedToId: employee.id, status: 'Assigned', history: await pushHistory(asset, req, `Assigned to ${employee.name}`),
      // The CURRENT allocation's stamps — what the report's Assigned Date /
      // Assigned By filters read. A fresh allocation clears the last return.
      assignedAt: new Date(), assignedById: req.user.id, assignedByName: req.user.name || req.user.email || null, returnedAt: null,
    },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset assigned', entity: 'Asset', entityId: asset.id, toValue: employee.name });
  res.json(present(updated));
});

router.patch('/:id/return', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const asset = await assetInScope(req, req.params.id, { assignedTo: true });
  if (!asset) return res.status(404).json(NOT_FOUND);
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: {
      assignedToId: null,
      status: 'Available',
      returnedAt: new Date(),
      history: await pushHistory(asset, req, `Returned by ${asset.assignedTo ? asset.assignedTo.name : 'employee'}`),
    },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset returned', entity: 'Asset', entityId: asset.id, toValue: 'Available' });
  res.json(present(updated));
});

// Toggle between In Repair and Available (the old one-click switch; the
// screen now uses the repair routes below, which record vendor and slip).
// Back from repair goes back to its holder (Assigned) when it has one.
router.patch('/:id/maintenance', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const asset = await assetInScope(req, req.params.id);
  if (!asset) return res.status(404).json(NOT_FOUND);
  const status = asset.status === 'In Repair' ? (asset.assignedToId ? 'Assigned' : 'Available') : 'In Repair';
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status, history: await pushHistory(asset, req, status === 'In Repair' ? 'Sent for repair' : 'Repair completed') },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: status === 'In Repair' ? 'Asset sent for repair' : 'Asset back from repair', entity: 'Asset', entityId: asset.id, fromValue: asset.status, toValue: status });
  res.json(present(updated));
});

// Retiring keeps the record — it is never deleted.
router.patch('/:id/retire', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const asset = await assetInScope(req, req.params.id);
  if (!asset) return res.status(404).json(NOT_FOUND);
  if (['Sold', 'Written off'].includes(asset.status)) return res.status(400).json({ error: `This asset is already ${asset.status.toLowerCase()}.` });
  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { status: 'Retired', assignedToId: null, returnedAt: asset.assignedToId ? new Date() : asset.returnedAt, history: await pushHistory(asset, req, 'Retired') },
    include: { assignedTo: true },
  });
  await logAudit({ userId: req.user.id, action: 'Asset retired', entity: 'Asset', entityId: asset.id, toValue: 'Retired' });
  res.json(present(updated));
});

// EDIT AN ASSET'S DETAILS — the asset desk only (Super Admin / Admin / HR,
// with the Employee Services edit grant; see mayEditAsset). Every changed
// field is written to the asset's history ("Edited by X: field old → new")
// and to the audit log, one row per field.
const EDIT_FIELDS = [
  ['name', 'Name'], ['category', 'Category'], ['assetType', 'Asset type'], ['location', 'Location'],
  ['purchaseDate', 'Purchase date'], ['purchaseCost', 'Purchase cost'], ['warrantyUntil', 'Warranty until'], ['status', 'Status'],
  ...Object.entries(ACC_LABEL),
];
const showVal = (k, v) => (v === null || v === undefined || v === '' ? '—' : (k === 'purchaseCost' || ACC_MONEY.includes(k)) ? `₹${v}` : String(v));
router.patch('/:id', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res, next) => {
  try {
    if (!(await mayEditAsset(req.user))) {
      return res.status(403).json({ error: 'Only Super Admin, Admin or HR can change an asset\'s details.' });
    }
    const body = req.body || {};
    const { status } = body;
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
    const purchaseCost = costOf(body.purchaseCost);
    if (Number.isNaN(purchaseCost)) return res.status(400).json({ error: 'Purchase cost must be a number, like 55000.' });
    for (const k of ['purchaseDate', 'warrantyUntil']) {
      if (body[k] && !YMD.test(str(body[k]))) return res.status(400).json({ error: 'Pick a proper date.' });
    }
    if (body.name !== undefined && !str(body.name)) return res.status(400).json({ error: 'An asset name is required.' });
    const acc = accountingFields(body);
    if (acc.error) return res.status(400).json({ error: acc.error });
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    if ((status === 'Sold' || status === 'Written off') && !(acc.data.disposalDate || asset.disposalDate)) {
      return res.status(400).json({ error: `Enter the date it was ${status === 'Sold' ? 'sold' : 'written off'}.` });
    }
    // An Assigned asset needs a holder, and a holder means Assigned / In Repair:
    // the status field cannot contradict who has it (use Assign / Return).
    if (status === 'Assigned' && !asset.assignedToId) return res.status(400).json({ error: 'Nobody holds this asset. Use Assign to give it to someone.' });
    if (status === 'Available' && asset.assignedToId) return res.status(400).json({ error: 'Someone holds this asset. Use Return first.' });
    const want = {
      name: body.name === undefined ? undefined : str(body.name),
      category: body.category === undefined ? undefined : (str(body.category) || 'Other'),
      assetType: body.assetType === undefined ? undefined : (str(body.assetType) || null),
      location: body.location === undefined ? undefined : (str(body.location) || null),
      purchaseDate: body.purchaseDate === undefined ? undefined : (str(body.purchaseDate) || null),
      purchaseCost,
      warrantyUntil: body.warrantyUntil === undefined ? undefined : (str(body.warrantyUntil) || null),
      status: status || undefined,
      ...acc.data,
    };
    // Retired from the edit form = the Retire action: the holder hands it back.
    const retiring = LEFT_BOOKS.includes(want.status) && !LEFT_BOOKS.includes(asset.status);
    const changes = EDIT_FIELDS
      .filter(([k]) => want[k] !== undefined && (want[k] ?? null) !== (asset[k] ?? null))
      .map(([k, label]) => ({ k, label, from: asset[k], to: want[k] }));
    if (!changes.length) return res.json(present(await assetInScope(req, asset.id, { assignedTo: { select: HOLDER_SELECT } })));
    const who = req.user.name || req.user.email || 'user';
    let history = asset.history;
    changes.slice().reverse().forEach((c) => {
      history = JSON.stringify([{ at: stampNow(), by: who, text: `Edited by ${who}: ${c.label.toLowerCase()} ${showVal(c.k, c.from)} → ${showVal(c.k, c.to)}` }, ...parseHistory(history)]);
    });
    const data = Object.fromEntries(changes.map((c) => [c.k, c.to]));
    if (retiring && asset.assignedToId) Object.assign(data, { assignedToId: null, returnedAt: new Date() });
    const updated = await prisma.asset.update({
      where: { id: asset.id }, data: { ...data, history }, include: { assignedTo: { select: HOLDER_SELECT } },
    });
    for (const c of changes) {
      await logAudit({
        userId: req.user.id, action: 'Asset edited', entity: 'Asset', entityId: asset.id,
        field: c.k, fieldLabel: c.label, fromValue: showVal(c.k, c.from), toValue: showVal(c.k, c.to),
      });
    }
    // Keep the journal in step (S2.3): a posted purchase is updated, a
    // Sold / Written off asset gets its disposal entry. A closed month is
    // not changed silently — it waits in Accounts with the warning.
    const accounts = await AP.autoSync({ assetId: asset.id }, accActor(req));
    return res.json({ ...present(updated), accounts });
  } catch (err) { return next(err); }
});

// ONE ASSET, with its full history — the same scope as the list.
router.get('/:id', async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id, { assignedTo: { select: HOLDER_SELECT } });
    if (!asset) return res.status(404).json(NOT_FOUND);
    return res.json(present(asset));
  } catch (err) { return next(err); }
});

// ---- Repairs, with the vendor's repair / service slip ----------------------
// No new column. A repair is written into `history` like every other asset
// movement, with its details and the slip reference ON THE ENTRY:
//   { id, at, by, text, kind: 'repair', step: 'sent' | 'back', repairOf,
//     vendor, issue, expectedBack, fixed, cost,
//     slip: { file, name, mime, size, at, by } }
// The slip is stored by utils/attachments.js (the expense-bill storage: PDF /
// JPG / PNG / WebP only, first bytes must match the type, random stored name,
// outside the repository) and is served ONLY through GET
// /:id/repair/:entryId/slip, to a login whose assetScope includes the asset.
const SLIP_MAX = 10 * 1024 * 1024; // 10 MB — stated on the form
const SLIP_MESSAGE = {
  NO_FILE: 'Choose the slip file to upload.',
  TOO_LARGE: 'That file is bigger than 10 MB. Please upload a smaller PDF or photo.',
  BAD_TYPE: 'The slip must be a PDF or a photo (JPG, PNG or WebP).',
  CONTENT_MISMATCH: "That file doesn't look like a real PDF or photo. Please choose the original file.",
  NOT_MULTIPART: 'Could not read the upload. Please try again.',
};
const slipError = (err) => SLIP_MESSAGE[err && err.code] || 'Could not save the slip. Please try again.';
const stampNow = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const newEntryId = () => crypto.randomBytes(6).toString('hex');

// The form arrives as multipart (when a slip is attached) or plain JSON.
async function readRepairForm(req) {
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    return attachments.parseMultipart(req, { maxBytes: SLIP_MAX });
  }
  return { fields: req.body || {}, file: null };
}
function storeSlip(file, req) {
  const s = attachments.store(file, { maxBytes: SLIP_MAX });
  return { file: s.billFile, name: s.billName, mime: s.billMime, size: s.billSize, at: stampNow(), by: req.user.name || req.user.email || null };
}
// Writes the new history; if the row cannot be saved, the slip just written
// is removed again so no orphan file is left behind.
async function saveRepair(asset, history, data, slip) {
  try {
    return await prisma.asset.update({
      where: { id: asset.id },
      data: { ...data, history: JSON.stringify(history) },
      include: { assignedTo: { select: HOLDER_SELECT } },
    });
  } catch (err) {
    if (slip) attachments.remove(slip.file);
    throw err;
  }
}
const repairEdit = requirePerm(null, 'hrms', 'Employee Services', 'edit');

// Send for repair: vendor + problem, optional expected return date and slip.
router.post('/:id/repair/send', repairEdit, async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    if (asset.status === 'In Repair') return res.status(400).json({ error: 'This asset is already out for repair.' });
    if (LEFT_BOOKS.includes(asset.status)) return res.status(400).json({ error: `A ${asset.status.toLowerCase()} asset cannot be sent for repair.` });
    let form;
    try { form = await readRepairForm(req); } catch (err) { return res.status(400).json({ error: slipError(err) }); }
    const vendor = str(form.fields.vendor).slice(0, 120);
    const issue = str(form.fields.issue).slice(0, 500);
    const expectedBack = str(form.fields.expectedBack);
    if (!vendor) return res.status(400).json({ error: 'Enter the repair shop (vendor) name.' });
    if (!issue) return res.status(400).json({ error: 'Write what the problem is.' });
    if (expectedBack && !YMD.test(expectedBack)) return res.status(400).json({ error: 'Pick a proper expected return date.' });
    let slip = null;
    if (form.file) {
      try { slip = storeSlip(form.file, req); } catch (err) { return res.status(400).json({ error: slipError(err) }); }
    }
    const history = parseHistory(asset.history);
    const sentId = newEntryId();
    history.unshift({
      id: sentId, at: stampNow(), by: req.user.name, text: `Sent for repair to ${vendor}: ${issue}`,
      kind: 'repair', step: 'sent', vendor, issue, expectedBack: expectedBack || null, ...(slip ? { slip } : {}),
    });
    const updated = await saveRepair(asset, history, { status: 'In Repair' }, slip);
    // The repair log row (S2.2), linked to this history entry.
    await createRepairRow({
      assetId: asset.id, dateReported: new Date().toISOString().slice(0, 10), issue, vendor, status: 'In Repair',
      repairType: REPAIR_TYPES.includes(str(form.fields.repairType)) ? str(form.fields.repairType) : 'Repair',
      underWarranty: /^(1|true|yes|y)$/i.test(str(form.fields.underWarranty)),
      reportedById: req.user.id, reportedByName: req.user.name || null, legacyEntryId: sentId, slip: slip ? JSON.stringify(slip) : null,
    });
    await logAudit({
      userId: req.user.id, action: 'Asset sent for repair', entity: 'Asset', entityId: asset.id,
      fromValue: asset.status, toValue: `In Repair (${vendor})${slip ? ', slip attached' : ''}`,
    });
    return res.json(present(updated));
  } catch (err) { return next(err); }
});

// Back from repair: what was fixed, optional cost and slip. The asset goes
// back to its holder (Assigned) if it has one, otherwise to the pool.
router.post('/:id/repair/back', repairEdit, async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    if (asset.status !== 'In Repair') return res.status(400).json({ error: 'This asset is not out for repair.' });
    let form;
    try { form = await readRepairForm(req); } catch (err) { return res.status(400).json({ error: slipError(err) }); }
    const fixed = str(form.fields.fixed).slice(0, 500);
    const costRaw = str(form.fields.cost).replace(/[,\s₹]/g, '');
    if (!fixed) return res.status(400).json({ error: 'Write what was fixed.' });
    let cost = null;
    if (costRaw) {
      cost = Number(costRaw);
      if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Cost must be a number, like 1500.' });
    }
    let slip = null;
    if (form.file) {
      try { slip = storeSlip(form.file, req); } catch (err) { return res.status(400).json({ error: slipError(err) }); }
    }
    const history = parseHistory(asset.history);
    const sent = history.find((h) => h && h.kind === 'repair' && h.step === 'sent');
    const vendor = sent ? sent.vendor : null;
    history.unshift({
      id: newEntryId(), at: stampNow(), by: req.user.name,
      text: `Back from repair${vendor ? ` (${vendor})` : ''}: ${fixed}${cost !== null ? ` · cost ${cost}` : ''}`,
      kind: 'repair', step: 'back', repairOf: sent ? sent.id : null, vendor, fixed, cost, ...(slip ? { slip } : {}),
    });
    const status = asset.assignedToId ? 'Assigned' : 'Available';
    const back = repairBackFields(form.fields);
    if (back.error) { if (slip) attachments.remove(slip.file); return res.status(400).json({ error: back.error }); }
    const updated = await saveRepair(asset, history, { status }, slip);
    // Complete the repair log row and post its journal (S2.3).
    let row = sent ? await prisma.assetRepair.findUnique({ where: { legacyEntryId: sent.id } }) : null;
    const done = {
      status: 'Completed', repairDate: back.data.repairDate || new Date().toISOString().slice(0, 10), cost: cost || 0, notes: fixed, ...back.data,
    };
    if (row) row = await prisma.assetRepair.update({ where: { id: row.id }, data: done });
    else {
      row = await createRepairRow({
        assetId: asset.id, issue: sent ? sent.issue : null, vendor, reportedById: req.user.id, reportedByName: req.user.name || null,
        legacyEntryId: history[0].id, ...done,
      });
    }
    const accounts = await AP.autoSync({ assetId: asset.id, repairId: row.id }, accActor(req));
    await logAudit({
      userId: req.user.id, action: 'Asset back from repair', entity: 'Asset', entityId: asset.id,
      fromValue: 'In Repair', toValue: `${status}${cost !== null ? ` (cost ${cost})` : ''}${slip ? ', slip attached' : ''}`,
    });
    return res.json({ ...present(updated), accounts, repair: row });
  } catch (err) { return next(err); }
});

// Add the slip later, to a repair entry that has none yet.
router.post('/:id/repair/:entryId/slip', repairEdit, async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    const history = parseHistory(asset.history);
    const entry = history.find((h) => h && h.kind === 'repair' && h.id === req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'That repair entry was not found.' });
    if (entry.slip && entry.slip.file) return res.status(400).json({ error: 'This repair entry already has a slip.' });
    let form;
    try { form = await readRepairForm(req); } catch (err) { return res.status(400).json({ error: slipError(err) }); }
    let slip;
    try { slip = storeSlip(form.file, req); } catch (err) { return res.status(400).json({ error: slipError(err) }); }
    entry.slip = slip;
    history.unshift({ at: stampNow(), by: req.user.name, text: `Repair slip added (${slip.name})` });
    const updated = await saveRepair(asset, history, {}, slip);
    await logAudit({
      userId: req.user.id, action: 'Asset repair slip added', entity: 'Asset', entityId: asset.id, toValue: slip.name,
    });
    return res.json(present(updated));
  } catch (err) { return next(err); }
});

// The slip itself — only for a login that can see this asset (assetScope).
router.get('/:id/repair/:entryId/slip', async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    const entry = parseHistory(asset.history).find((h) => h && h.kind === 'repair' && h.id === req.params.entryId);
    if (!entry || !entry.slip || !entry.slip.file) return res.status(404).json({ error: 'No slip on this repair entry.' });
    const full = attachments.resolveStored(entry.slip.file);
    if (!full) return res.status(404).json({ error: 'The slip file is no longer on the server.' });
    res.setHeader('Content-Type', attachments.ALLOWED[entry.slip.mime] ? entry.slip.mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(entry.slip.name)}"`);
    return res.sendFile(full);
  } catch (err) { return next(err); }
});

// ---- The repair log (Accounts spec S2.2) --------------------------------------
// One AssetRepair row per repair / service. Send / Back above write it too;
// these routes list it and let the asset desk fill in the accounting fields.
// A repair that has a journal entry cannot be deleted — cancel it instead
// (Cancelled reverses the entry).
const REPAIR_TYPES = ['Repair', 'Service', 'AMC', 'Replacement of part'];
const REPAIR_STATUSES = ['Reported', 'In Repair', 'Completed', 'Cancelled'];
const yes = (v) => v === true || /^(1|true|yes|y)$/i.test(str(v));
async function createRepairRow(data) {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const n = (await prisma.assetRepair.count()) + 1 + i;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.assetRepair.create({ data: { repairNo: `RP-${String(n).padStart(5, '0')}`, ...data } });
    } catch (err) {
      if (!(err && err.code === 'P2002' && String(err.meta && err.meta.target).includes('repairNo'))) throw err;
    }
  }
  throw new Error('Could not number the repair');
}
// The accounting fields of a repair (Back from repair form / the edit form).
function repairBackFields(f) {
  const data = {};
  const has = (k) => f[k] !== undefined && f[k] !== null;
  if (has('gstPaid')) { const n = costOf(f.gstPaid); if (Number.isNaN(n)) return { error: 'GST paid must be a number.' }; data.gstPaid = n || 0; }
  if (has('invoiceNo')) data.invoiceNo = str(f.invoiceNo).slice(0, 80) || null;
  if (has('paidVia')) { const v = str(f.paidVia); if (v && !PAID_VIA.includes(v)) return { error: 'Paid via is Bank, Cash or Payable.' }; data.paidVia = v || null; }
  if (has('paidBankAccountId')) data.paidBankAccountId = str(f.paidBankAccountId) || null;
  if (has('underWarranty')) data.underWarranty = yes(f.underWarranty);
  if (has('capitalise')) data.capitalise = yes(f.capitalise);
  if (has('repairType')) { const t = str(f.repairType); if (t && !REPAIR_TYPES.includes(t)) return { error: `Repair type is one of: ${REPAIR_TYPES.join(', ')}.` }; if (t) data.repairType = t; }
  if (has('repairDate')) { const d = str(f.repairDate); if (d && !YMD.test(d)) return { error: 'Pick a proper repair date.' }; data.repairDate = d || null; }
  if (has('dateReported')) { const d = str(f.dateReported); if (d && !YMD.test(d)) return { error: 'Pick a proper reported date.' }; data.dateReported = d || null; }
  if (has('vendor')) data.vendor = str(f.vendor).slice(0, 120) || null;
  if (has('issue')) data.issue = str(f.issue).slice(0, 500) || null;
  if (has('notes')) data.notes = str(f.notes).slice(0, 1000) || null;
  if (has('cost')) { const n = costOf(f.cost); if (Number.isNaN(n)) return { error: 'Cost must be a number, like 1500.' }; data.cost = n || 0; }
  if (has('status')) { const st = str(f.status); if (st && !REPAIR_STATUSES.includes(st)) return { error: `Status is one of: ${REPAIR_STATUSES.join(', ')}.` }; if (st) data.status = st; }
  return { data };
}
async function repairView(r) {
  const posted = await AP.bookingsOf(`asset-repair:${r.id}`);
  const legacyPosted = r.legacyEntryId ? await AP.bookingsOf(`asset-repair-legacy:${r.legacyEntryId}`) : { current: null };
  const je = posted.current || legacyPosted.current;
  let slip = null;
  try { const sl = r.slip ? JSON.parse(r.slip) : null; slip = sl ? { name: sl.name, mime: sl.mime, size: sl.size, attached: !!sl.file } : null; } catch { slip = null; }
  return {
    ...r, slip,
    coveredByWarranty: !!r.underWarranty && !(Number(r.cost) + Number(r.gstPaid || 0)),
    accounts: je ? { posted: true, journalEntryId: je.id, date: je.date, amount: je.totalDebit } : { posted: false },
  };
}

router.get('/:id/repairs', async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    const rows = await prisma.assetRepair.findMany({ where: { assetId: asset.id }, orderBy: { createdAt: 'desc' } });
    const out = [];
    for (const r of rows) out.push(await repairView(r)); // eslint-disable-line no-await-in-loop
    return res.json({ repairs: out, types: REPAIR_TYPES, statuses: REPAIR_STATUSES, canEdit: await mayEditAsset(req.user) });
  } catch (err) { return next(err); }
});

router.post('/:id/repairs', repairEdit, async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    const f = repairBackFields(req.body || {});
    if (f.error) return res.status(400).json({ error: f.error });
    if (!f.data.issue) return res.status(400).json({ error: 'Write what the problem is.' });
    const row = await createRepairRow({
      assetId: asset.id, dateReported: f.data.dateReported || new Date().toISOString().slice(0, 10), status: 'Reported',
      reportedById: req.user.id, reportedByName: req.user.name || null, ...f.data,
    });
    await logAudit({ userId: req.user.id, action: 'Asset repair logged', entity: 'AssetRepair', entityId: row.id, toValue: `${row.repairNo} · ${asset.assetCode} · ${row.status}` });
    const accounts = await AP.autoSync({ assetId: asset.id, repairId: row.id }, accActor(req));
    return res.status(201).json({ repair: await repairView(row), accounts });
  } catch (err) { return next(err); }
});

router.patch('/:id/repairs/:repairId', repairEdit, async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    const row = await prisma.assetRepair.findUnique({ where: { id: req.params.repairId } });
    if (!row || row.assetId !== asset.id) return res.status(404).json({ error: 'That repair was not found.' });
    const f = repairBackFields(req.body || {});
    if (f.error) return res.status(400).json({ error: f.error });
    const changed = Object.keys(f.data).filter((k) => (f.data[k] ?? null) !== (row[k] ?? null));
    if (!changed.length) return res.json({ repair: await repairView(row), accounts: [] });
    const updated = await prisma.assetRepair.update({ where: { id: row.id }, data: f.data });
    for (const k of changed) {
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: req.user.id, action: 'Asset repair edited', entity: 'AssetRepair', entityId: row.id, field: k, fromValue: String(row[k] ?? '—'), toValue: String(f.data[k] ?? '—') });
    }
    const accounts = await AP.autoSync({ assetId: asset.id, repairId: row.id }, accActor(req));
    return res.json({ repair: await repairView(updated), accounts });
  } catch (err) { return next(err); }
});

router.delete('/:id/repairs/:repairId', repairEdit, async (req, res, next) => {
  try {
    const asset = await assetInScope(req, req.params.id);
    if (!asset) return res.status(404).json(NOT_FOUND);
    const row = await prisma.assetRepair.findUnique({ where: { id: req.params.repairId } });
    if (!row || row.assetId !== asset.id) return res.status(404).json({ error: 'That repair was not found.' });
    if (await AP.hasJournal({ repairId: row.id }) || (row.legacyEntryId && await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: `asset-repair-legacy:${row.legacyEntryId}` } } }))) {
      return res.status(409).json({ error: 'This repair is already in the Accounts journal, so it cannot be deleted. Set its status to Cancelled instead.' });
    }
    await prisma.assetRepair.delete({ where: { id: row.id } });
    await logAudit({ userId: req.user.id, action: 'Asset repair deleted', entity: 'AssetRepair', entityId: row.id, fromValue: `${row.repairNo} · ${asset.assetCode}` });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

module.exports = router;
// The list's own scope, reused by the dashboard charts (routes/insights.js).
module.exports.assetWhere = assetWhere;

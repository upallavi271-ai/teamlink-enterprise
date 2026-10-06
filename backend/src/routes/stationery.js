const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { scopeOf, hrmsGlobal, employeeWhere } = require('../utils/scope');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { toXlsx } = require('../utils/tabularExport');

// ---------------------------------------------------------------------------
// STATIONERY / CONSUMABLES — Employee Services -> Stationery (user 2026-10-05):
// "every employee has notepad, pen, stationery things like this. HR pushes
// (adds) the quantity; then based on the count, assigns to employees how many
// pens and notepads. That count we also want to know employee-wise."
//
// COUNTED things, not unique assets: no code per pen. Three tables
// (prisma: StationeryItem, StationeryStock, StationeryIssue):
//   left of an item = stock added - given (ISSUE) + taken back (RETURN)
//
// WHO DOES WHAT (enforced here, the screen only mirrors it):
//   Super Admin / Admin / HR (the desk) -> add stock, give, give to many,
//                                          take back, items; see everything
//   Manager / Assistant Manager         -> see everything, change nothing
//   TL / STL                            -> their team's counts, read-only
//   everyone else                       -> only what was given to them
// The people a login may see are employeeWhere()'s (utils/scope.js), the same
// rule every HRMS list uses. Every change is written to the audit log.
//
// NOT READY YET: until the migration is applied (and the client generated)
// the models are missing; every route then answers "not switched on yet"
// instead of crashing.
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(requireAuth);

const NOT_READY = { notReady: true, error: 'Stationery is not switched on yet. The admin needs to finish one update.' };
const ready = () => !!(prisma.stationeryItem && prisma.stationeryStock && prisma.stationeryIssue);
const missingTable = (err) => err && (err.code === 'P2021' || /no such table/i.test(String(err.message || '')));

// One wrapper for every route: not-ready + table-missing become a plain answer.
const h = (fn) => async (req, res, next) => {
  if (!ready()) return req.path === '/me' ? res.json({ ready: false, ...NOT_READY }) : res.status(409).json(NOT_READY);
  try { return await fn(req, res); } catch (err) {
    if (missingTable(err)) return req.path === '/me' ? res.json({ ready: false, ...NOT_READY }) : res.status(409).json(NOT_READY);
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const todayYmd = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
function dateOr(v, label = 'date') {
  const d = str(v);
  if (!d) return todayYmd();
  if (!YMD.test(d) || Number.isNaN(new Date(`${d}T00:00:00`).getTime())) throw fail(400, `Pick a proper ${label}.`);
  return d;
}
function wholeQty(v, label = 'quantity') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail(400, `Enter the ${label} as a whole number, 1 or more.`);
  if (n > 100000) throw fail(400, `${n} looks too big. Check the ${label}.`);
  return n;
}

// "1 pen", "12 pens", "3 stapler pins", "2 boxes".
function plural(name, n) {
  const w = str(name).toLowerCase();
  if (n === 1) return w;
  if (/s$/.test(w)) return w;
  if (/(x|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}
const countOf = (name, n) => `${n} ${plural(name, n)}`;

// ---- who is looking ------------------------------------------------------------
function roleOf(user) {
  const s = scopeOf(user);
  const manage = !!(s.adminGlobal || s.hrmsRole === 'HR');
  const seeAll = manage || s.global || hrmsGlobal(user);
  const team = !seeAll && ['TL', 'STL'].includes(s.hrmsRole);
  return { manage, seeAll, team, self: !seeAll && !team, employeeId: s.employeeId || null };
}
function needManage(req) {
  if (!roleOf(req.user).manage) throw fail(403, 'Only HR or Admin can change stationery.');
}
const actor = (req) => ({ id: req.user.id, name: req.user.name || req.user.email || 'Someone' });

// ---- people ----------------------------------------------------------------------
const GONE = ['Relieved', 'Exited'];
// Test logins never appear in a picker (agent-rules lesson 2026-09-29).
const NOT_TEST = [
  { NOT: { name: { contains: 'ZZTEST' } } }, { NOT: { name: { contains: 'zztest' } } },
  { OR: [{ email: null }, { NOT: { email: { contains: 'example.test' } } }] },
];
const PERSON = { id: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true };

// THE SEAT (teamlink-seat-codes): the first word decides the department.
// Same table as routes/assetInventory.js deptOfSeat (not exported there).
const SEAT_DEPARTMENTS = { BDE: 'BDE', MED: 'Medical', MFG: 'Manufacturing', EDU: 'Education', HR: 'HR', 'R&D': 'R&D' };
const isSeat = (code) => !!SEAT_DEPARTMENTS[str(code).toUpperCase().split(/[\s-]+/)[0]];

// Each person's seat code(s): the seat they sit in now (PositionAssignment
// without an end date) and the seats of the assets they hold ("BDE EDU-1").
async function seatsFor(ids) {
  const out = {};
  if (!ids.length) return out;
  const add = (id, code) => { if (code) (out[id] = out[id] || new Set()).add(code); };
  const chunks = [];
  for (let i = 0; i < ids.length; i += 400) chunks.push(ids.slice(i, i + 400));
  for (const part of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const [pos, held] = await Promise.all([
      prisma.positionAssignment.findMany({ where: { employeeId: { in: part }, toDate: null }, select: { employeeId: true, position: { select: { code: true } } } }).catch(() => []),
      prisma.asset.findMany({ where: { assignedToId: { in: part } }, select: { assignedToId: true, location: true } }).catch(() => []),
    ]);
    pos.forEach((p) => add(p.employeeId, p.position && p.position.code));
    held.forEach((a) => { if (isSeat(a.location)) add(a.assignedToId, a.location); });
  }
  const res = {};
  Object.keys(out).forEach((k) => { res[k] = [...out[k]].sort(); });
  return res;
}

// Everybody this login may see (any status — a relieved person's history still counts).
async function peopleInScope(user) {
  return prisma.employee.findMany({ where: employeeWhere(user), select: PERSON, orderBy: { name: 'asc' } });
}
// The `where` for issue rows of the people in scope.
function issueScope(user, people) {
  return Object.keys(employeeWhere(user)).length ? { employeeId: { in: people.map((p) => p.id) } } : {};
}

// ---- items and balances -----------------------------------------------------------
async function itemsWithBalance() {
  const [items, added, moved] = await Promise.all([
    prisma.stationeryItem.findMany({ orderBy: [{ createdAt: 'asc' }, { name: 'asc' }] }),
    prisma.stationeryStock.groupBy({ by: ['itemId'], _sum: { quantity: true } }),
    prisma.stationeryIssue.groupBy({ by: ['itemId', 'kind'], _sum: { quantity: true } }),
  ]);
  const addMap = Object.fromEntries(added.map((r) => [r.itemId, r._sum.quantity || 0]));
  const give = {};
  const back = {};
  moved.forEach((r) => { (r.kind === 'RETURN' ? back : give)[r.itemId] = r._sum.quantity || 0; });
  return items.map((it) => {
    const a = addMap[it.id] || 0;
    const g = give[it.id] || 0;
    const b = back[it.id] || 0;
    const left = a - g + b;
    return {
      ...it, added: a, given: g - b, issued: g, returned: b, left,
      low: it.reorderLevel !== null && it.reorderLevel !== undefined && left <= it.reorderLevel,
    };
  });
}
// The balance of ONE item, inside a transaction.
async function leftOf(tx, itemId) {
  const [a, g, b] = await Promise.all([
    tx.stationeryStock.aggregate({ where: { itemId }, _sum: { quantity: true } }),
    tx.stationeryIssue.aggregate({ where: { itemId, kind: 'ISSUE' }, _sum: { quantity: true } }),
    tx.stationeryIssue.aggregate({ where: { itemId, kind: 'RETURN' }, _sum: { quantity: true } }),
  ]);
  return (a._sum.quantity || 0) - (g._sum.quantity || 0) + (b._sum.quantity || 0);
}
async function itemOr404(id, tx = prisma) {
  const item = await tx.stationeryItem.findUnique({ where: { id: str(id) } });
  if (!item) throw fail(404, 'That item is not on the list. Pick the item again.');
  return item;
}

// ---- GET /me — what this login may do (the screen draws from it) -----------------
router.get('/me', h(async (req, res) => {
  const r = roleOf(req.user);
  let employee = null;
  if (r.employeeId) employee = await prisma.employee.findUnique({ where: { id: r.employeeId }, select: PERSON });
  res.json({
    ready: true, canManage: r.manage, seeAll: r.seeAll, team: r.team, self: r.self,
    employee, today: todayYmd(),
  });
}));

// ---- items ---------------------------------------------------------------------------
// The stock cards: Added / Given / Left (+ low). Company stock numbers are
// for the desk and the view-only Managers; a TL / employee gets names only.
router.get('/items', h(async (req, res) => {
  const r = roleOf(req.user);
  const items = await itemsWithBalance();
  if (r.seeAll) return res.json(items);
  return res.json(items.map(({ id, name, unit, active }) => ({ id, name, unit, active })));
}));

router.post('/items', h(async (req, res) => {
  needManage(req);
  const name = str(req.body && req.body.name).replace(/\s+/g, ' ');
  if (!name) throw fail(400, 'Type the item name, e.g. Pencil.');
  if (name.length > 60) throw fail(400, 'Keep the item name short (60 letters or fewer).');
  const all = await prisma.stationeryItem.findMany({ select: { id: true, name: true } });
  if (all.some((i) => i.name.toLowerCase() === name.toLowerCase())) throw fail(409, `${name} is already on the list.`);
  const reorderLevel = reorderOf(req.body && req.body.reorderLevel);
  const item = await prisma.stationeryItem.create({ data: { name, unit: 'pcs', reorderLevel, createdById: req.user.id } });
  await logAudit({ userId: req.user.id, actorName: actor(req).name, action: 'Stationery item added', entity: 'StationeryItem', entityId: item.id, toValue: `${name}${reorderLevel !== null ? ` (warn at ${reorderLevel})` : ''}` });
  res.status(201).json(item);
}));
function reorderOf(v) {
  if (v === undefined || v === null || str(v) === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fail(400, 'The warning level must be a whole number (0 or more), or empty.');
  return n;
}

router.patch('/items/:id', h(async (req, res) => {
  needManage(req);
  const item = await itemOr404(req.params.id);
  const b = req.body || {};
  const data = {};
  const changes = [];
  if (b.name !== undefined) {
    const name = str(b.name).replace(/\s+/g, ' ');
    if (!name) throw fail(400, 'The item needs a name.');
    if (name.length > 60) throw fail(400, 'Keep the item name short (60 letters or fewer).');
    const clash = await prisma.stationeryItem.findMany({ where: { NOT: { id: item.id } }, select: { name: true } });
    if (clash.some((i) => i.name.toLowerCase() === name.toLowerCase())) throw fail(409, `${name} is already on the list.`);
    if (name !== item.name) { data.name = name; changes.push(`name ${item.name} -> ${name}`); }
  }
  if (b.reorderLevel !== undefined) {
    const lvl = reorderOf(b.reorderLevel);
    if (lvl !== item.reorderLevel) { data.reorderLevel = lvl; changes.push(`warn at ${item.reorderLevel ?? 'none'} -> ${lvl ?? 'none'}`); }
  }
  if (b.active !== undefined) {
    const active = !!b.active;
    if (active !== item.active) { data.active = active; changes.push(active ? 'shown again' : 'hidden'); }
  }
  if (!changes.length) return res.json(item);
  const saved = await prisma.stationeryItem.update({ where: { id: item.id }, data });
  await logAudit({ userId: req.user.id, actorName: actor(req).name, action: 'Stationery item changed', entity: 'StationeryItem', entityId: item.id, fromValue: item.name, toValue: changes.join('; ') });
  return res.json(saved);
}));

// ---- add stock -------------------------------------------------------------------------
// itemId, or itemName to start a new item in the same step.
router.post('/stock', h(async (req, res) => {
  needManage(req);
  const b = req.body || {};
  const quantity = wholeQty(b.quantity);
  const date = dateOr(b.date);
  let cost = null;
  if (str(b.costPerUnit) !== '') {
    cost = Number(b.costPerUnit);
    if (!Number.isFinite(cost) || cost < 0) throw fail(400, 'Cost per piece must be a number (0 or more), or empty.');
  }
  let item;
  if (str(b.itemId)) item = await itemOr404(b.itemId);
  else {
    const name = str(b.itemName).replace(/\s+/g, ' ');
    if (!name) throw fail(400, 'Pick the item (or type a new one).');
    if (name.length > 60) throw fail(400, 'Keep the item name short (60 letters or fewer).');
    const all = await prisma.stationeryItem.findMany();
    item = all.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (!item) {
      item = await prisma.stationeryItem.create({ data: { name, unit: 'pcs', createdById: req.user.id } });
      await logAudit({ userId: req.user.id, actorName: actor(req).name, action: 'Stationery item added', entity: 'StationeryItem', entityId: item.id, toValue: name });
    }
  }
  const row = await prisma.stationeryStock.create({
    data: {
      itemId: item.id, quantity, date,
      vendor: str(b.vendor) || null, costPerUnit: cost, billNo: str(b.billNo) || null, note: str(b.note) || null,
      addedById: req.user.id, addedByName: actor(req).name,
    },
  });
  await logAudit({ userId: req.user.id, actorName: actor(req).name, action: 'Stationery stock added', entity: 'StationeryStock', entityId: row.id, toValue: `+${countOf(item.name, quantity)} on ${date}${row.vendor ? ` from ${row.vendor}` : ''}${row.billNo ? ` (bill ${row.billNo})` : ''}` });
  const left = await leftOf(prisma, item.id);
  res.status(201).json({ ...row, item, left, message: `Added ${countOf(item.name, quantity)}. Now ${countOf(item.name, left)} left.` });
}));

// Undo a wrong stock entry — only when what is left stays 0 or more.
router.delete('/stock/:id', h(async (req, res) => {
  needManage(req);
  const out = await prisma.$transaction(async (tx) => {
    const row = await tx.stationeryStock.findUnique({ where: { id: str(req.params.id) }, include: { item: true } });
    if (!row) throw fail(404, 'That stock entry is already gone.');
    const left = await leftOf(tx, row.itemId);
    if (left - row.quantity < 0) throw fail(409, `Can't remove it: ${countOf(row.item.name, row.quantity - left)} from this entry are already given out.`);
    await tx.stationeryStock.delete({ where: { id: row.id } });
    return { row, left: left - row.quantity };
  });
  await logAudit({ userId: req.user.id, actorName: actor(req).name, action: 'Stationery stock removed', entity: 'StationeryStock', entityId: out.row.id, fromValue: `+${countOf(out.row.item.name, out.row.quantity)} on ${out.row.date}` });
  res.json({ ok: true, left: out.left, message: `Removed. Now ${countOf(out.row.item.name, out.left)} left.` });
}));

// Stock movement history: stock-ins, hand-outs and take-backs, newest first.
router.get('/movements', h(async (req, res) => {
  if (!roleOf(req.user).seeAll) throw fail(403, 'Stock history is for HR and Admin.');
  const itemId = str(req.query.itemId);
  const where = itemId ? { itemId } : {};
  const range = dateRange(req.query);
  const [ins, outs] = await Promise.all([
    prisma.stationeryStock.findMany({ where: { ...where, ...range }, include: { item: { select: { name: true } } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500 }),
    prisma.stationeryIssue.findMany({ where: { ...where, ...range }, include: { item: { select: { name: true } } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500 }),
  ]);
  const ids = [...new Set(outs.map((o) => o.employeeId))];
  const people = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true } }) : [];
  const who = Object.fromEntries(people.map((p) => [p.id, p]));
  const rows = [
    ...ins.map((s) => ({
      id: s.id, kind: 'IN', date: s.date, item: s.item.name, itemId: s.itemId, quantity: s.quantity,
      text: `Added${s.vendor ? ` from ${s.vendor}` : ''}${s.billNo ? ` · bill ${s.billNo}` : ''}${s.costPerUnit !== null ? ` · ₹${s.costPerUnit}/pc` : ''}`,
      note: s.note, by: s.addedByName, at: s.createdAt,
    })),
    ...outs.map((o) => {
      const p = who[o.employeeId];
      const name = p ? `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}` : 'an employee';
      return {
        id: o.id, kind: o.kind === 'RETURN' ? 'RETURN' : 'OUT', date: o.date, item: o.item.name, itemId: o.itemId, quantity: o.quantity,
        text: o.kind === 'RETURN' ? `Taken back from ${name}` : `Given to ${name}${o.batchId ? ' (give to many)' : ''}`,
        note: o.note, by: o.issuedByName, at: o.createdAt, employeeId: o.employeeId,
      };
    }),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at).localeCompare(String(a.at)));
  res.json(rows.slice(0, 500));
}));
function dateRange(q) {
  const from = str(q.from);
  const to = str(q.to);
  const d = {};
  if (YMD.test(from)) d.gte = from;
  if (YMD.test(to)) d.lte = to;
  return Object.keys(d).length ? { date: d } : {};
}

// ---- who can receive -------------------------------------------------------------------
// Department (every active one, with how many active people) -> its ACTIVE
// employees: "name · ID · seat". Test logins are never offered.
router.get('/people', h(async (req, res) => {
  needManage(req);
  const people = await prisma.employee.findMany({
    where: { AND: [{ employmentStatus: { notIn: GONE } }, ...NOT_TEST] },
    select: { id: true, employeeCode: true, name: true, department: true, designation: true },
    orderBy: { name: 'asc' },
  });
  const seats = await seatsFor(people.map((p) => p.id));
  people.forEach((p) => { p.seats = seats[p.id] || []; });
  const count = {};
  people.forEach((p) => { if (p.department) count[p.department] = (count[p.department] || 0) + 1; });
  const master = await prisma.department.findMany({ where: { active: true }, select: { name: true } }).catch(() => []);
  const names = [...new Set([...master.map((d) => d.name), ...Object.keys(count)])].sort((a, b) => a.localeCompare(b));
  res.json({
    departments: names.map((name) => ({ name, count: count[name] || 0 })).filter((d) => d.count > 0),
    employees: people,
    noDepartment: people.filter((p) => !p.department).length,
  });
}));

// A person who may receive (exists, still working here). The desk may give to anyone.
async function receiver(tx, id) {
  const p = await tx.employee.findUnique({ where: { id: str(id) }, select: PERSON });
  if (!p) throw fail(404, 'Pick the employee again — that person was not found.');
  if (GONE.includes(p.employmentStatus)) throw fail(400, `${p.name} has left the company. Pick someone who works here now.`);
  return p;
}
const label = (p) => `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}`;

// ---- give to one ------------------------------------------------------------------------
router.post('/issue', h(async (req, res) => {
  needManage(req);
  const b = req.body || {};
  if (!str(b.employeeId)) throw fail(400, 'Pick the employee.');
  if (!str(b.itemId)) throw fail(400, 'Pick the item.');
  const quantity = wholeQty(b.quantity);
  const date = dateOr(b.date);
  const me = actor(req);
  const out = await prisma.$transaction(async (tx) => {
    const p = await receiver(tx, b.employeeId);
    const item = await itemOr404(b.itemId, tx);
    if (!item.active) throw fail(400, `${item.name} is hidden from the list. Show it again first.`);
    const left = await leftOf(tx, item.id);
    if (quantity > left) throw fail(409, left <= 0 ? `No ${plural(item.name, 2)} left. Add stock first.` : `Only ${countOf(item.name, left)} left.`);
    const row = await tx.stationeryIssue.create({
      data: { itemId: item.id, employeeId: p.id, quantity, kind: 'ISSUE', date, note: str(b.note) || null, issuedById: me.id, issuedByName: me.name },
    });
    return { row, p, item, left: left - quantity };
  });
  await logAudit({ userId: req.user.id, actorName: me.name, action: 'Stationery given', entity: 'StationeryIssue', entityId: out.row.id, toValue: `${countOf(out.item.name, quantity)} to ${label(out.p)} on ${date}` });
  res.status(201).json({ ...out.row, left: out.left, message: `Gave ${countOf(out.item.name, quantity)} to ${out.p.name}. ${countOf(out.item.name, out.left)} left.` });
}));

// ---- give to many -----------------------------------------------------------------------
// { employeeIds: [...], lines: [{ itemId, quantity }], date, note }
// The SAME quantity to each person. /preview checks without saving.
async function planMany(tx, body) {
  const ids = [...new Set((Array.isArray(body.employeeIds) ? body.employeeIds : []).map(str).filter(Boolean))];
  if (!ids.length) throw fail(400, 'Pick at least one person.');
  if (ids.length > 2000) throw fail(400, 'That is too many people at once.');
  const lines = (Array.isArray(body.lines) ? body.lines : [])
    .filter((l) => l && str(l.itemId) && str(l.quantity) !== '' && Number(l.quantity) !== 0);
  if (!lines.length) throw fail(400, 'Enter how many of at least one item each person gets.');
  const seen = new Set();
  const people = await tx.employee.findMany({ where: { id: { in: ids } }, select: PERSON });
  const found = new Map(people.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw fail(404, `${missing.length} of the picked people were not found. Pick them again.`);
  const gone = people.filter((p) => GONE.includes(p.employmentStatus));
  if (gone.length) throw fail(400, `${gone.map((p) => p.name).join(', ')} ${gone.length === 1 ? 'has' : 'have'} left the company. Untick ${gone.length === 1 ? 'them' : 'those people'}.`);
  const plan = [];
  for (const l of lines) {
    const itemId = str(l.itemId);
    if (seen.has(itemId)) throw fail(400, 'Each item only once, please.');
    seen.add(itemId);
    const each = wholeQty(l.quantity, 'quantity each');
    // eslint-disable-next-line no-await-in-loop
    const item = await itemOr404(itemId, tx);
    if (!item.active) throw fail(400, `${item.name} is hidden from the list. Show it again first.`);
    // eslint-disable-next-line no-await-in-loop
    const left = await leftOf(tx, itemId);
    const need = each * ids.length;
    plan.push({
      itemId, item: item.name, each, need, left, after: left - need, ok: need <= left,
      text: `${ids.length} ${ids.length === 1 ? 'person' : 'people'} × ${countOf(item.name, each)} = ${countOf(item.name, need)}`,
      problem: need <= left ? null : (left <= 0 ? `No ${plural(item.name, 2)} left. Add stock first.` : `Not enough ${plural(item.name, 2)}: you need ${need}, only ${left} left.`),
    });
  }
  return { people: ids.map((id) => found.get(id)), plan, ok: plan.every((p) => p.ok) };
}

router.post('/issue-many/preview', h(async (req, res) => {
  needManage(req);
  const { people, plan, ok } = await planMany(prisma, req.body || {});
  res.json({ count: people.length, plan, ok });
}));

router.post('/issue-many', h(async (req, res) => {
  needManage(req);
  const b = req.body || {};
  const date = dateOr(b.date);
  const note = str(b.note) || null;
  const me = actor(req);
  const batchId = `batch_${crypto.randomBytes(8).toString('hex')}`;
  const out = await prisma.$transaction(async (tx) => {
    const planned = await planMany(tx, b);
    const bad = planned.plan.find((p) => !p.ok);
    if (bad) throw fail(409, bad.problem);
    const data = [];
    planned.people.forEach((p) => planned.plan.forEach((l) => data.push({
      itemId: l.itemId, employeeId: p.id, quantity: l.each, kind: 'ISSUE', date, note, batchId, issuedById: me.id, issuedByName: me.name,
    })));
    await tx.stationeryIssue.createMany({ data });
    return planned;
  }, { timeout: 30000 });
  const what = out.plan.map((l) => countOf(l.item, l.each)).join(' + ');
  // Audit: one row per person (who, what, qty, to whom), in one write.
  await prisma.auditLog.createMany({
    data: out.people.map((p) => ({
      userId: req.user.id, actorName: me.name, action: 'Stationery given', entity: 'StationeryIssue', entityId: batchId,
      toValue: `${what} to ${label(p)} on ${date} (give to many)`,
    })),
  }).catch((err) => { console.error('[audit] stationery batch: %s', err && err.message); }); // eslint-disable-line no-console
  res.status(201).json({
    batchId, count: out.people.length, plan: out.plan.map((l) => ({ ...l, left: l.after })),
    message: `Gave ${what} to each of ${out.people.length} ${out.people.length === 1 ? 'person' : 'people'}. ${out.plan.map((l) => `${countOf(l.item, l.after)} left`).join(', ')}.`,
  });
}));

// ---- take back (a wrong issue) -----------------------------------------------------------
router.post('/return', h(async (req, res) => {
  needManage(req);
  const b = req.body || {};
  if (!str(b.employeeId)) throw fail(400, 'Pick the employee.');
  if (!str(b.itemId)) throw fail(400, 'Pick the item.');
  const quantity = wholeQty(b.quantity);
  const date = dateOr(b.date);
  const me = actor(req);
  const out = await prisma.$transaction(async (tx) => {
    const p = await tx.employee.findUnique({ where: { id: str(b.employeeId) }, select: PERSON });
    if (!p) throw fail(404, 'Pick the employee again — that person was not found.');
    const item = await itemOr404(b.itemId, tx);
    const [g, r] = await Promise.all([
      tx.stationeryIssue.aggregate({ where: { itemId: item.id, employeeId: p.id, kind: 'ISSUE' }, _sum: { quantity: true } }),
      tx.stationeryIssue.aggregate({ where: { itemId: item.id, employeeId: p.id, kind: 'RETURN' }, _sum: { quantity: true } }),
    ]);
    const holds = (g._sum.quantity || 0) - (r._sum.quantity || 0);
    if (holds <= 0) throw fail(409, `${p.name} has no ${plural(item.name, 2)} from us to take back.`);
    if (quantity > holds) throw fail(409, `${p.name} got only ${countOf(item.name, holds)}. You can take back at most ${holds}.`);
    const row = await tx.stationeryIssue.create({
      data: { itemId: item.id, employeeId: p.id, quantity, kind: 'RETURN', date, note: str(b.note) || null, issuedById: me.id, issuedByName: me.name },
    });
    return { row, p, item, left: await leftOf(tx, item.id) };
  });
  await logAudit({ userId: req.user.id, actorName: me.name, action: 'Stationery taken back', entity: 'StationeryIssue', entityId: out.row.id, toValue: `${countOf(out.item.name, quantity)} from ${label(out.p)} on ${date}` });
  res.status(201).json({ ...out.row, left: out.left, message: `Took back ${countOf(out.item.name, quantity)} from ${out.p.name}. ${countOf(out.item.name, out.left)} left.` });
}));

// ---- employee-wise counts ----------------------------------------------------------------
// One row per person: net given per item (given - taken back) inside the
// date range, last given date. Filters: department, employeeId, itemId,
// from, to, q (name / ID), all=1 (also people who got nothing).
// The filter options CASCADE (teamlink-cascading-filters): each one is
// counted over the rows matching every OTHER filter, inside this login's
// scope, and an option with 0 people is not offered.
async function buildTable(user, q) {
  const people = await peopleInScope(user);
  const issues = await prisma.stationeryIssue.findMany({
    where: { ...issueScope(user, people), ...dateRange(q) },
    select: { employeeId: true, itemId: true, quantity: true, kind: true, date: true },
  });
  const allItems = await prisma.stationeryItem.findMany({ orderBy: [{ createdAt: 'asc' }, { name: 'asc' }], select: { id: true, name: true, active: true } });
  const usedItems = new Set(issues.map((i) => i.itemId));
  const items = allItems.filter((i) => i.active || usedItems.has(i.id));
  const byPerson = {};
  issues.forEach((i) => { (byPerson[i.employeeId] = byPerson[i.employeeId] || []).push(i); });
  const f = {
    department: str(q.department), employeeId: str(q.employeeId), itemId: str(q.itemId),
    q: str(q.q).toLowerCase(), all: str(q.all) === '1',
  };
  const NO_DEPT = '(No department)';
  const deptOf = (p) => p.department || NO_DEPT;

  // A person's row under a given item filter (null = every item).
  function rowOf(p, itemId) {
    const counts = {};
    let last = null;
    (byPerson[p.id] || []).forEach((i) => {
      if (itemId && i.itemId !== itemId) return;
      counts[i.itemId] = (counts[i.itemId] || 0) + (i.kind === 'RETURN' ? -i.quantity : i.quantity);
      if (i.kind !== 'RETURN' && (!last || i.date > last)) last = i.date;
    });
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    return { counts, total, lastGiven: last };
  }
  const active = (p) => !GONE.includes(p.employmentStatus);
  // Does person p show, with every filter applied except `skip`?
  function shows(p, skip) {
    if (skip !== 'department' && f.department && deptOf(p) !== f.department) return null;
    if (skip !== 'employeeId' && f.employeeId && p.id !== f.employeeId) return null;
    if (f.q && !`${p.name} ${p.employeeCode || ''}`.toLowerCase().includes(f.q)) return null;
    const r = rowOf(p, skip === 'itemId' ? null : f.itemId || null);
    if (r.total > 0) return r;
    // "Also people who got nothing" — active people only.
    return f.all && active(p) ? r : null;
  }
  const rows = [];
  const deptCount = {};
  const personCount = {};
  const itemCount = {};
  people.forEach((p) => {
    const r = shows(p);
    if (r) rows.push({ id: p.id, name: p.name, employeeCode: p.employeeCode, department: p.department, designation: p.designation, employmentStatus: p.employmentStatus, ...r });
    if (shows(p, 'department')) deptCount[deptOf(p)] = (deptCount[deptOf(p)] || 0) + 1;
    const rp = shows(p, 'employeeId');
    if (rp) personCount[p.id] = { p, total: rp.total };
    const ri = shows(p, 'itemId');
    if (ri) Object.entries(ri.counts).forEach(([id, n]) => { if (n > 0) itemCount[id] = (itemCount[id] || 0) + 1; });
  });
  const seats = await seatsFor(rows.map((r) => r.id));
  rows.forEach((r) => { r.seats = seats[r.id] || []; });
  const totals = {};
  rows.forEach((r) => Object.entries(r.counts).forEach(([id, n]) => { totals[id] = (totals[id] || 0) + n; }));
  const keep = (v, n) => n > 0 || v === f.department || v === f.employeeId || v === f.itemId;
  const facets = {
    department: Object.entries(deptCount).filter(([d, n]) => keep(d, n)).map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    // The count beside a person = how many things they got (a zero shows only with 'all').
    employeeId: Object.values(personCount).map(({ p, total }) => ({ value: p.id, label: `${p.name}${p.employeeCode ? ` · ${p.employeeCode}` : ''}`, count: total }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    itemId: items.map((i) => ({ value: i.id, label: i.name, count: itemCount[i.id] || 0 })).filter((o) => keep(o.value, o.count)),
  };
  // The chosen person stays pickable even if another filter hides them.
  if (f.employeeId && !facets.employeeId.some((o) => o.value === f.employeeId)) {
    const p = people.find((x) => x.id === f.employeeId);
    if (p) facets.employeeId.unshift({ value: p.id, label: `${p.name}${p.employeeCode ? ` · ${p.employeeCode}` : ''}`, count: 0 });
  }
  if (f.department && !facets.department.some((o) => o.value === f.department)) facets.department.unshift({ value: f.department, label: f.department, count: 0 });
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { items: f.itemId ? items.filter((i) => i.id === f.itemId) : items, rows, totals, facets, people, issues, filters: f };
}

router.get('/employees', h(async (req, res) => {
  const r = roleOf(req.user);
  const t = await buildTable(req.user, req.query);
  res.json({
    items: t.items, rows: t.rows, totals: t.totals, facets: t.facets,
    totalPeople: t.rows.length, scope: r.seeAll ? 'all' : r.team ? 'team' : 'self',
  });
}));

router.get('/employees/export.xlsx', h(async (req, res) => {
  const t = await buildTable(req.user, req.query);
  const headers = ['Employee', 'Employee ID', 'Department', 'Seat', ...t.items.map((i) => { const w = plural(i.name, 2); return `${w.charAt(0).toUpperCase()}${w.slice(1)} given`; }), 'Total', 'Last given'];
  const body = t.rows.map((r) => [
    r.name, r.employeeCode || '', r.department || '', (r.seats || []).join(', '),
    ...t.items.map((i) => r.counts[i.id] || 0), r.total, r.lastGiven || '',
  ]);
  body.push(['Total', '', '', `${t.rows.length} ${t.rows.length === 1 ? 'person' : 'people'}`, ...t.items.map((i) => t.totals[i.id] || 0), t.items.reduce((s, i) => s + (t.totals[i.id] || 0), 0), '']);
  const buf = toXlsx(headers, body, 'Stationery');
  await logAudit({ userId: req.user.id, actorName: actor(req).name, action: 'Stationery report exported (XLSX)', entity: 'StationeryIssue', toValue: `${t.rows.length} employee row(s)` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="stationery-employee-wise-${todayYmd()}.xlsx"`);
  res.send(buf);
}));

// Per department: people (active), given per item, per person.
router.get('/departments', h(async (req, res) => {
  const t = await buildTable(req.user, { ...req.query, employeeId: '', all: '' });
  const NO_DEPT = '(No department)';
  const out = {};
  t.people.forEach((p) => {
    const d = p.department || NO_DEPT;
    const o = out[d] || (out[d] = { department: d, people: 0, got: 0, counts: {} });
    if (!GONE.includes(p.employmentStatus)) o.people += 1;
  });
  t.rows.forEach((r) => {
    const o = out[r.department || NO_DEPT];
    if (!o) return;
    o.got += 1;
    Object.entries(r.counts).forEach(([id, n]) => { o.counts[id] = (o.counts[id] || 0) + n; });
  });
  let list = Object.values(out);
  const dep = str(req.query.department);
  if (dep) list = list.filter((o) => o.department === dep);
  list = list.filter((o) => o.got > 0 || o.people > 0)
    .map((o) => ({ ...o, perPerson: Object.fromEntries(Object.entries(o.counts).map(([id, n]) => [id, o.people ? Math.round((n / o.people) * 10) / 10 : null])) }))
    .sort((a, b) => b.got - a.got || a.department.localeCompare(b.department));
  res.json({ items: t.items, departments: list });
}));

// ---- one person's history ----------------------------------------------------------------
async function historyOf(employeeId) {
  const rows = await prisma.stationeryIssue.findMany({
    where: { employeeId }, include: { item: { select: { name: true } } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });
  const totals = {};
  rows.forEach((r) => {
    const t = totals[r.itemId] || (totals[r.itemId] = { itemId: r.itemId, item: r.item.name, net: 0 });
    t.net += r.kind === 'RETURN' ? -r.quantity : r.quantity;
  });
  return {
    rows: rows.map((r) => ({ id: r.id, date: r.date, item: r.item.name, itemId: r.itemId, quantity: r.quantity, kind: r.kind, note: r.note, by: r.issuedByName, batch: !!r.batchId })),
    totals: Object.values(totals).filter((t) => t.net !== 0),
  };
}

router.get('/employee/:id', h(async (req, res) => {
  const id = str(req.params.id);
  const p = await prisma.employee.findFirst({ where: { AND: [{ id }, employeeWhere(req.user)] }, select: PERSON });
  if (!p) throw fail(404, 'That person is not in your area.');
  const seats = await seatsFor([p.id]);
  res.json({ employee: { ...p, seats: seats[p.id] || [] }, ...(await historyOf(p.id)) });
}));

// The employee's own view: "Stationery given to you". Read-only.
router.get('/mine', h(async (req, res) => {
  const { employeeId } = roleOf(req.user);
  if (!employeeId) return res.json({ employee: null, rows: [], totals: [] });
  return res.json(await historyOf(employeeId));
}));

module.exports = router;
module.exports.plural = plural;

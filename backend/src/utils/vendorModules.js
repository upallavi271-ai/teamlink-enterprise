// ---------------------------------------------------------------------------
// VENDOR MODULES — the logic around config/vendorModules.js (2026-10-14).
//   * effectiveModules(vu)  what ONE vendor login sees: its VendorLoginModule rows, or — for a login saved before
//                           modules existed (no rows, or the table is not there yet) — Assets + Invoices as today.
//   * guard(key, perm?)     THE central API check: a module the login does not have answers 403 on every route that
//                           uses it; an unticked permission answers 403 too. Read fresh on EVERY request, so an
//                           admin's edit is live on the vendor's next call (no re-create, no sign-out).
//   * saveModules(...)      writes the ticks (inside the caller's transaction).
//   * summaries(...)        the "3 orders in printing" line of each module's dashboard card.
//   * notifyCompany(...)    bell (+ optional task) to the order creator and HR / Admin, test logins excluded.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const CFG = require('../config/vendorModules');
const DB = require('./vmDb');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const parseJson = (raw) => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

// -> { configured, map: Map(moduleKey -> { permissions }) } for a VendorUser row.
async function effectiveModules(vu) {
  let rows = [];
  if (await DB.ready()) rows = await DB.q('SELECT "moduleKey", "permissionsJson" FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [vu.id]);
  rows = rows.filter((r) => CFG.MODULES[r.moduleKey]);
  const map = new Map();
  if (!rows.length) {
    // A login from before modules: Assets + Invoices with the normal ticks - it may send a bill too (founder 2026-10-28: bills import switched on for vendors).
    CFG.LEGACY_MODULES.forEach((k) => map.set(k, { permissions: k === 'assets' ? { canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost } : CFG.defaultPermissions(k) }));
    return { configured: false, map };
  }
  rows.forEach((r) => {
    const p = parseJson(r.permissionsJson);
    // The Assets ticks live on VendorUser (every old asset route reads them there) - that is the source of truth.
    map.set(r.moduleKey, { permissions: r.moduleKey === 'assets' ? { ...p, canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost } : p });
  });
  return { configured: true, map };
}

const NOT_ON = { error: 'This part of the portal is not switched on for your login.', moduleOff: true };
const NO_PERM = { error: 'Your login is not allowed to do that. Ask the company.', permissionOff: true };

// Express middleware factory. Needs req.vendor (set by VA.requireVendor); runs it itself when the route did not.
function guard(moduleKey, permKey) {
  return async (req, res, next) => {
    try {
      if (!req.vendor) return res.status(401).json({ error: 'Your session has ended. Please sign in again.', vendorSignedOut: true });
      const eff = await effectiveModules(req.vendor.row);
      req.vendor.modules = eff.map;
      const m = eff.map.get(moduleKey);
      if (!m) return res.status(403).json(NOT_ON);
      if (permKey && !CFG.permAllowed(moduleKey, m.permissions, permKey)) return res.status(403).json(NO_PERM);
      return next();
    } catch (err) { return next(err); }
  };
}
// Same check for a path prefix whose routes call requireVendor themselves (the older asset / invoice routes).
function guardPrefix(vendorOnly, moduleKey) {
  const g = guard(moduleKey);
  return (req, res, next) => (req.vendor ? g(req, res, next) : vendorOnly(req, res, (err) => (err ? next(err) : g(req, res, next))));
}
// Does this request's login have module `key` with permission `perm`? (inside a route that serves several kinds)
async function allows(req, moduleKey, permKey) {
  const eff = await effectiveModules(req.vendor.row);
  const m = eff.map.get(moduleKey);
  if (!m) return { ok: false, body: NOT_ON };
  if (permKey && !CFG.permAllowed(moduleKey, m.permissions, permKey)) return { ok: false, body: NO_PERM };
  return { ok: true, permissions: m.permissions };
}

// Clean the admin's choice: known keys only, de-duplicated, permissions only for ticked modules and known ticks.
function cleanChoice(modules, permissions) {
  const keys = [...new Set((Array.isArray(modules) ? modules : []).map(str).filter((k) => CFG.MODULES[k]))];
  const perms = {};
  keys.forEach((k) => {
    const given = permissions && typeof permissions === 'object' && permissions[k] && typeof permissions[k] === 'object' ? permissions[k] : {};
    const base = CFG.defaultPermissions(k);
    perms[k] = Object.fromEntries(Object.keys(base).map((p) => [p, Object.prototype.hasOwnProperty.call(given, p) ? given[p] === true : base[p]]));
  });
  return { keys, perms };
}

// Replace the login's module rows (call inside prisma.$transaction with its client as `c`).
async function saveModules(vendorUserId, keys, perms, c) {
  await DB.run('DELETE FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [vendorUserId], c);
  const t = DB.now();
  for (const k of keys) {
    // eslint-disable-next-line no-await-in-loop
    await DB.run('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', [DB.newId(), vendorUserId, k, JSON.stringify(perms[k] || {}), t, t], c);
  }
}

async function loginModuleKeys(vendorUserId) {
  if (!(await DB.ready())) return [];
  return (await DB.q('SELECT "moduleKey", "permissionsJson" FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [vendorUserId])).filter((r) => CFG.MODULES[r.moduleKey]);
}

// ---- bills (invoice / monthly bill / receipt) --------------------------------
const BILL_TEXT = {
  invoice: { Submitted: 'Submitted', Approved: 'Approved', Paid: 'Paid', Rejected: 'Rejected' },
  monthly_bill: { Submitted: 'Pending', Approved: 'Approved', Paid: 'Paid', Rejected: 'Rejected' },
  receipt: { Submitted: 'Received', Approved: 'Accepted', Paid: 'Accepted', Rejected: 'Rejected' },
};
const billStatusText = (kind, status) => (BILL_TEXT[kind] || BILL_TEXT.invoice)[status] || status;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodLabel = (p) => { const m = /^(\d{4})-(\d{2})$/.exec(p || ''); return m ? `${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : (p || ''); };
function parseLines(raw) { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
// One bill as the VENDOR sees it: its own data, status, rejection reason, payment. No reviewer ids.
function billView(b) {
  return {
    id: b.id, billCode: b.billCode, kind: b.kind, orderId: b.orderId || null, billNumber: b.billNumber, billDate: b.billDate, period: b.period, periodLabel: periodLabel(b.period),
    dueDate: b.dueDate, quantity: b.quantity, rate: b.rate, amount: b.amount, gst: b.gst, total: b.total, lines: parseLines(b.lines), remarks: b.remarks,
    status: b.status, statusText: billStatusText(b.kind, b.status), rejectionReason: b.status === 'Rejected' ? b.rejectionReason : null,
    document: b.documentFile ? { name: b.documentName, mime: b.documentMime, size: b.documentSize } : null,
    paidOn: b.paidOn, paidAmount: b.paidAmount, paymentRef: b.paymentRef, paymentMode: b.paymentMode,
    createdAt: DB.toDate(b.createdAt),
  };
}

// ---- company notices ----------------------------------------------------------
const TEST_USER = { NOT: [{ name: { contains: 'ZZTEST' } }, { name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }] };
// HR + Admin + Super Admin (live logins only; test logins never receive real notices).
async function hrAdminIds() {
  const users = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN', 'HR'] } }, { hrmsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'HR'] } }], ...TEST_USER },
    select: { id: true },
  });
  return users.map((u) => u.id);
}
// Bell to creator + HR/Admin; with opts.task also a task each (one open task per order+person, updated in place).
async function notifyCompany({ creatorId, title, message, task }) {
  const ids = [...new Set([creatorId, ...(await hrAdminIds())].filter(Boolean))];
  try { await require('./notify').notifyUsers(ids, { title, message }); } catch (e) { console.error('[vendor notify]', e && e.message); } // eslint-disable-line no-console
  if (task && creatorId) {
    try {
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const maker = users.find((u) => u.id === creatorId) || users[0];
      const today = new Date().toISOString().slice(0, 10);
      for (const u of users) {
        // eslint-disable-next-line no-await-in-loop
        const open = await prisma.task.findFirst({ where: { assigneeId: u.id, name: { startsWith: task.key } } });
        const data = { name: `${task.key} - ${task.label}`, description: message, status: task.done ? 'Completed' : 'In Progress', ...(task.done ? { completedAt: new Date() } : {}) };
        if (open) {
          // eslint-disable-next-line no-await-in-loop
          await prisma.task.update({ where: { id: open.id }, data });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await prisma.task.create({
            data: {
              ...data, department: 'HR', startDate: today, endDate: today, assigneeId: u.id, assigneeName: u.name || 'HR', assignedById: maker.id, assignedByName: maker.name || 'HR', priority: 'Medium',
            },
          });
        }
      }
    } catch (e) { console.error('[vendor task]', e && e.message); } // eslint-disable-line no-console
  }
  return ids;
}

// ---- dashboard summaries ------------------------------------------------------
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
async function legacyInvoices(vendorId) { return require('./vendorInvoices').listVendorInvoices(vendorId, { forVendor: true }); } // eslint-disable-line global-require

const SUMMARY = {
  async assets(v) {
    const VA = require('./vendorAuth'); // eslint-disable-line global-require
    const n = await prisma.asset.count({ where: await VA.vendorAssetWhere(v) });
    return n ? { count: n, text: `${plural(n, 'asset')} assigned to you`, tone: 'blue' } : { count: 0, text: 'No assets assigned yet', tone: 'grey' };
  },
  async office(v) {
    const r = await legacyInvoices(v.vendorId);
    const open = r.rows.filter((x) => !x.paid && !['REJECTED', 'WITHDRAWN'].includes(x.status)).length;
    return open ? { count: open, text: `${plural(open, 'bill')} waiting for payment`, tone: 'orange' } : { count: r.rows.length, text: r.rows.length ? 'All office bills are paid' : 'No office bills yet', tone: r.rows.length ? 'green' : 'grey' };
  },
  async expenses(v) {
    const r = await legacyInvoices(v.vendorId);
    return r.rows.length ? { count: r.rows.length, text: `${plural(r.rows.length, 'entry', 'entries')} · ${inr(r.summary.outstanding)} still to be paid`, tone: r.summary.outstanding ? 'orange' : 'green' } : { count: 0, text: 'No expense entries yet', tone: 'grey' };
  },
  async id_card_orders(v) {
    if (!(await DB.ready())) return { count: 0, text: 'Not set up yet', tone: 'grey' };
    const rows = await DB.q('SELECT "status", COUNT(*) AS n FROM "IdCardOrder" WHERE "vendorId" = ? GROUP BY "status"', [v.vendorId]);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const open = ['New', 'Received', 'Printing', 'Ready'].filter((s) => by[s]);
    if (!open.length) return { count: 0, text: rows.length ? 'All orders delivered' : 'No orders yet', tone: rows.length ? 'green' : 'grey' };
    return { count: open.reduce((t, s) => t + by[s], 0), text: open.map((s) => `${by[s]} ${by[s] === 1 ? 'order' : 'orders'} ${s === 'New' ? 'new' : (s === 'Printing' ? 'in printing' : s.toLowerCase())}`).join(' · '), tone: by.New ? 'orange' : 'blue' };
  },
  async sim_connections(v) {
    if (!(await DB.ready())) return { count: 0, text: 'Not set up yet', tone: 'grey' };
    const sims = await DB.q('SELECT "status", COUNT(*) AS n FROM "SimConnection" WHERE "vendorId" = ? GROUP BY "status"', [v.vendorId]);
    const reqs = await DB.one('SELECT COUNT(*) AS n FROM "SimRequest" WHERE "vendorId" = ? AND "status" IN (\'Open\',\'In progress\')', [v.vendorId]);
    const total = sims.reduce((t, r) => t + r.n, 0);
    const parts = [`${plural(total, 'number')}`];
    const susp = (sims.find((r) => r.status === 'Suspended') || {}).n || 0;
    if (susp) parts.push(`${susp} suspended`);
    if (reqs && reqs.n) parts.push(`${plural(reqs.n, 'open request')}`);
    return { count: total, text: total || (reqs && reqs.n) ? parts.join(' · ') : 'No numbers yet', tone: reqs && reqs.n ? 'orange' : (total ? 'blue' : 'grey') };
  },
  async monthly_bills(v) {
    if (!(await DB.ready())) return { count: 0, text: 'Not set up yet', tone: 'grey' };
    const b = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = \'monthly_bill\' ORDER BY "period" DESC, "createdAt" DESC LIMIT 1', [v.vendorId]);
    if (!b) return { count: 0, text: 'No bills sent yet', tone: 'grey' };
    const month = periodLabel(b.period).split(' ')[0];
    const t = billStatusText('monthly_bill', b.status).toLowerCase();
    return { count: 1, text: `${month} bill ${t}`, tone: b.status === 'Paid' ? 'green' : (b.status === 'Rejected' ? 'red' : 'orange') };
  },
  async invoices(v) {
    const legacy = await legacyInvoices(v.vendorId);
    let sub = 0; let all = 0;
    if (await DB.ready()) {
      const r = await DB.one('SELECT COUNT(*) AS n, SUM(CASE WHEN "status" IN (\'Submitted\',\'Approved\') THEN 1 ELSE 0 END) AS open FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = \'invoice\'', [v.vendorId]);
      all = (r && r.n) || 0; sub = (r && r.open) || 0;
    }
    const open = sub + legacy.rows.filter((x) => !x.paid && !['REJECTED', 'WITHDRAWN'].includes(x.status)).length;
    const total = all + legacy.rows.length;
    return open ? { count: open, text: `${plural(open, 'invoice')} waiting`, tone: 'orange' } : { count: total, text: total ? 'No invoice is waiting' : 'No invoices yet', tone: total ? 'green' : 'grey' };
  },
  async payments(v) {
    const p = await paymentRows(v.vendorId);
    return p.length ? { count: p.length, text: `Last payment ${inr(p[0].amount)} on ${p[0].date}`, tone: 'green' } : { count: 0, text: 'No payments yet', tone: 'grey' };
  },
};

// Payment history: paid legacy bills (Accounts bill marked Paid) + paid module bills. Newest first.
async function paymentRows(vendorId) {
  const out = [];
  const legacy = await legacyInvoices(vendorId);
  legacy.rows.filter((r) => r.paid).forEach((r) => out.push({
    key: `L:${r.key}`, date: r.paymentDate || r.billDate || '', amount: r.paidAmount, reference: [r.paymentMode, r.billNumber || r.billCode].filter(Boolean).join(' · ') || '—', for: r.billNumber || r.billCode || 'Bill', kind: 'bill',
  }));
  if (await DB.ready()) {
    const rows = await DB.q('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "status" = \'Paid\' ORDER BY "paidOn" DESC', [vendorId]);
    rows.forEach((b) => out.push({
      key: `M:${b.id}`, date: b.paidOn || '', amount: b.paidAmount == null ? b.total : b.paidAmount, reference: b.paymentRef || '—', mode: b.paymentMode || null,
      for: `${b.kind === 'monthly_bill' ? `${periodLabel(b.period)} bill` : 'Invoice'} ${b.billNumber || b.billCode}`, kind: b.kind,
    }));
  }
  out.forEach((r) => { r.date = r.date ? String(r.date).slice(0, 10) : ''; });
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// The portal's menu for one login (2026-10-19): EXACTLY the four modules of config/vendorModules.js PORTAL_NAV - Dashboard, Invoices, Payments,
// Purchase Orders - for desktop and mobile alike. The older per-login module ticks no longer add menu entries. 'canRaise' keeps the one
// existing vendor workflow (sending an invoice) behind the Admin's "Raise / upload invoices" tick; nothing else a vendor sees can change data.
async function portalFor(req) {
  // ASSETS VENDOR PORTAL (2026-10-19): an asset vendor's menu is the Assets portal's four pages and nothing of the finance portal.
  const kind = await require('./vendorKind').kindOfRow({ ...req.vendor.row, vendorId: req.vendor.vendorId }); // eslint-disable-line global-require
  if (kind === 'assets') {
    const nav = CFG.ASSET_PORTAL_NAV.map((n) => ({ key: n.key, label: n.label, route: n.route }));
    return { kind: 'assets', roleLabel: CFG.ROLE_LABEL.assets, modulesConfigured: true, modules: nav, core: [], nav, canRaise: false };
  }
  if (kind === 'telecom') {
    // The Airtel Bills Portal (2026-10-19): Bills, Monthly History, SIMs. canSend = the "Send a bill" tick (the only thing it can write).
    const eff = await effectiveModules(req.vendor.row);
    const ab = eff.map.get('airtel_bills');
    const nav = CFG.TELECOM_PORTAL_NAV.map((n) => ({ key: n.key, label: n.label, route: n.route }));
    return {
      kind: 'telecom', roleLabel: CFG.ROLE_LABEL.telecom, modulesConfigured: true, modules: nav, core: [], nav, canRaise: false, canSend: !ab ? false : CFG.permAllowed('airtel_bills', ab.permissions, 'sendBill'),
    };
  }
  if (kind === 'idcards') {
    // The ID Card Vendor Portal (2026-10-19): the Dashboard link + the four modules, shown in a left sidebar.
    return {
      kind: 'idcards', roleLabel: CFG.ROLE_LABEL.idcards, modulesConfigured: true, modules: CFG.IDCARD_PORTAL_MODULES.map((n) => ({ key: n.key, label: n.label, route: n.route })), core: [],
      nav: CFG.IDCARD_PORTAL_NAV.map((n) => ({ ...n })), canRaise: false,
    };
  }
  const eff = await effectiveModules(req.vendor.row);
  const inv = eff.map.get('invoices');
  const canRaise = !!inv && CFG.permAllowed('invoices', inv.permissions, 'raise');
  // the header shows the registered company name and its category (read by the vendor id of the session)
  const vm = await prisma.officeVendor.findUnique({ where: { id: req.vendor.vendorId }, select: { category: true } }).catch(() => null);
  return {
    kind: 'finance', roleLabel: CFG.ROLE_LABEL.finance, vendorCategory: (vm && vm.category) || null,
    modulesConfigured: eff.configured,
    modules: CFG.PORTAL_NAV.map((n) => ({ key: n.key, label: n.label, route: n.route })),
    core: [],
    nav: CFG.PORTAL_NAV.map((n) => ({ key: n.key, label: n.label, route: n.route })),
    canRaise,
  };
}

module.exports = {
  CFG, effectiveModules, guard, guardPrefix, allows, cleanChoice, saveModules, loginModuleKeys, billView, billStatusText, periodLabel, parseLines, parseJson,
  notifyCompany, hrAdminIds, paymentRows, portalFor, SUMMARY, NOT_ON, NO_PERM, str, TEST_USER,
};

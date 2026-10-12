// ---------------------------------------------------------------------------
// EMPLOYEE FIELD DEFINITIONS — built-in AND added fields in one place.
//
// The built-in fields (utils/employeeFieldCatalog.js) are stored as ordinary
// EmployeeField rows with key `core.<column>`, seeded the first time the
// Manage Fields screen is opened and NEVER overwritten afterwards (an edit to
// a label / required flag / pause / order is the user's). Fields an
// administrator added keep their own keys.
//
// This module is what every other part of the server asks:
//   pausedCols()    Employee columns hidden from forms / profile / exports
//   requiredCols()  Employee columns that must not be saved empty
//   layoutFor()     what the screens need to draw the form (labels, order …)
// pausedCols()/requiredCols() are SYNCHRONOUS (they read a small in-process
// copy, refreshed every few seconds and the moment a definition changes), so
// they can be used inside exports, the import template and the completion %.
//
// Where a custom field is grouped ("Extra details" or a heading of its own)
// is kept in AppSetting `employee_field_groups` — no schema change.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const cat = require('./employeeFieldCatalog');

const TTL_MS = 8000;
const GROUPS_KEY = 'employee_field_groups';

const ready = () => !!(prisma.employeeField && prisma.employeeFieldValue);

let cache = { at: 0, byCol: new Map(), loading: null };

async function refresh() {
  if (!ready()) return cache.byCol;
  if (cache.loading) return cache.loading;
  cache.loading = (async () => {
    try {
      const rows = await prisma.employeeField.findMany({ where: { key: { startsWith: 'core.' } } });
      cache = { at: Date.now(), byCol: new Map(rows.map((r) => [r.key.slice(5), r])), loading: null };
    } catch (err) {
      cache = { ...cache, at: Date.now(), loading: null };
      // eslint-disable-next-line no-console
      console.error('[employeeFieldDefs] could not load:', err && err.message);
    }
    return cache.byCol;
  })();
  return cache.loading;
}

function snapshot() {
  if (Date.now() - cache.at > TTL_MS && !cache.loading) refresh().catch(() => {});
  return cache.byCol;
}
const invalidate = () => { cache.at = 0; };

// The effective state of one built-in column, defaults when never seeded.
function stateOf(col, byCol = snapshot()) {
  const c = cat.BY_COL.get(col);
  const r = byCol.get(col);
  if (!c) return null;
  return {
    col,
    label: r ? r.label : c.label,
    helpText: r ? (r.helpText || '') : '',
    required: c.reqLocked ? true : !!(r && r.required),
    // A needed field can never be paused, whatever is stored.
    active: c.needed ? true : (r ? !!r.active : true),
    position: r ? r.position : cat.CATALOG.indexOf(c),
  };
}

function pausedCols() {
  const out = new Set();
  snapshot().forEach((r, col) => {
    const c = cat.BY_COL.get(col);
    if (c && !c.needed && r.active === false) out.add(col);
  });
  return out;
}
const isPaused = (col) => pausedCols().has(col);

// Only the "required" HR switched on: name / email / department / designation
// are always required but keep the checks they already had, so a legacy
// record without an email can still be edited.
function requiredCols() {
  const out = new Set();
  cat.CATALOG.forEach((c) => {
    if (c.reqLocked) return;
    const s = stateOf(c.col);
    if (s && s.active && s.required) out.add(c.col);
  });
  return out;
}

// ---- seeding ----------------------------------------------------------------
async function ensureBuiltins(userId) {
  if (!ready()) return false;
  const have = await prisma.employeeField.findMany({ where: { key: { startsWith: 'core.' } }, select: { key: true } });
  const haveKeys = new Set(have.map((h) => h.key));
  const missing = cat.CATALOG.filter((c) => !haveKeys.has(c.key));
  if (!missing.length) return false;
  const first = have.length === 0;
  const top = await prisma.employeeField.aggregate({ _max: { position: true } });
  let pos = first ? 0 : (top._max.position ?? -1) + 1;
  const ops = [];
  // First time: the built-ins take the front of the list; the fields added
  // earlier keep their order, after them.
  if (first) ops.push(prisma.employeeField.updateMany({ data: { position: { increment: cat.CATALOG.length } } }));
  missing.forEach((c) => {
    ops.push(prisma.employeeField.create({
      data: {
        key: c.key, label: c.label, type: c.type, required: !!c.reqLocked, active: true, position: pos++, createdById: userId || null,
      },
    }));
  });
  await prisma.$transaction(ops);
  invalidate();
  await refresh();
  return true;
}

// ---- groups for added fields ------------------------------------------------
async function readGroups() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: GROUPS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
async function writeGroup(fieldId, group, user) {
  const all = await readGroups();
  if (group) all[fieldId] = group; else delete all[fieldId];
  const value = JSON.stringify(all);
  await prisma.appSetting.upsert({
    where: { key: GROUPS_KEY },
    create: { key: GROUPS_KEY, value, updatedById: user && user.id, updatedByName: user && (user.name || user.email) },
    update: { value, updatedById: user && user.id, updatedByName: user && (user.name || user.email) },
  });
}

// ---- what the screens need to draw the form ----------------------------------
async function layoutFor() {
  await refresh();
  const fields = {};
  cat.CATALOG.forEach((c) => {
    const s = stateOf(c.col);
    fields[c.col] = {
      label: s.label !== c.label ? s.label : null,
      helpText: s.helpText || null,
      required: s.required,
      locked: !!c.reqLocked,
      active: s.active,
      position: s.position,
    };
  });
  return { fields };
}

module.exports = {
  ready, refresh, snapshot, invalidate, stateOf, pausedCols, isPaused, requiredCols, ensureBuiltins, readGroups, writeGroup, layoutFor,
};

// ---------------------------------------------------------------------------
// ASSETS — the company asset register (Asset, /api/asset-inventory): export
// (the register in scope / the assets one employee holds) and import
// (utils/moduleIo.js contract).
//
// Scope is the register's own (routes/assetInventory.js assetWhere): company
// stock (unassigned) plus the assets held by employees in the caller's HRMS
// scope. Per-employee export = the assets that employee holds now; without
// the export right, the assets the caller holds.
//
// Import = the Add Asset / Assign / Return / Edit actions in bulk, with the
// same rights (Employee Services create + edit) and the same rules as the
// Admin data import's asset sheet (routes/dataImport.js):
//   * Asset ID found -> that asset is UPDATED (blank cells never overwrite);
//     not found -> a new asset with that ID; blank -> a new asset, numbered
//     AST-0001, AST-0002 … after the highest one in use.
//   * Assigned To (Employee ID) gives the holder (must be in your scope);
//     Status then defaults to Assigned. An Available / Retired asset cannot
//     also have a holder; Status Available or Retired without a holder hands
//     the asset back (a return), exactly like Mark Returned / Retire.
//   * Every movement is written to the asset's history and the audit log. No
//     notification, no email, no asset REQUEST (EmployeeRecord ASSET) is made.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const STATUSES = ['Available', 'Assigned', 'In Repair', 'Retired'];
const DEFAULT_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Mobile', 'Headset', 'ID Card', 'Other'];

const columns = [
  { key: 'assetCode', label: 'Asset ID', example: 'AST-0101', note: 'Blank = a new asset, numbered automatically. An existing Asset ID updates that asset; a new one creates an asset with that ID.' },
  { key: 'name', label: 'Asset Name', required: true, example: 'Dell Latitude 5440' },
  { key: 'category', label: 'Category', example: 'Laptop', note: 'Any category; the ones in use are on the Lists sheet. Blank = Laptop for a new asset.' },
  { key: 'assetType', label: 'Asset Type', example: 'Latitude 5440 i5 16GB' },
  { key: 'location', label: 'Location', example: 'Hyderabad office' },
  { key: 'purchaseDate', label: 'Purchase Date', type: 'date', example: '2026-01-15', note: 'Blank = today for a new asset.' },
  { key: 'warrantyUntil', label: 'Warranty Until', type: 'date', example: '2029-01-14' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Assigned', note: 'Blank = Assigned when a holder is given, otherwise unchanged (Available for a new asset). Available / Retired without a holder returns the asset.' },
  { key: 'holder', label: 'Assigned To (Employee ID)', example: 'TL101', note: 'Employee ID (or email) of the employee who holds it — must be in your scope. Blank = no change.' },
  { key: 'assignedDate', label: 'Assigned Date', type: 'date', example: '2026-02-01', note: 'Used only when the row assigns the asset to a new holder. Blank = today.' },
  { key: 'holderName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
  { key: 'allocation', label: 'Allocation Status', readOnly: true, example: '' },
  { key: 'assignedBy', label: 'Assigned By', readOnly: true, example: '' },
  { key: 'returnDate', label: 'Return Date', readOnly: true, example: '' },
];

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function rowOf(a) {
  const h = a.assignedTo || null;
  return {
    assetCode: a.assetCode,
    name: a.name,
    category: a.category || '',
    assetType: a.assetType || '',
    location: a.location || '',
    purchaseDate: a.purchaseDate || '',
    warrantyUntil: a.warrantyUntil || '',
    status: a.status,
    holder: h ? h.employeeCode || '' : '',
    assignedDate: h ? ymd(a.assignedAt) : '',
    holderName: h ? h.name : '',
    department: h ? h.department || '' : '',
    allocation: a.assignedToId ? 'Allocated' : 'Unallocated',
    assignedBy: a.assignedToId ? a.assignedByName || '' : '',
    returnDate: ymd(a.returnedAt),
  };
}

function parseHistory(raw) {
  try { const p = JSON.parse(raw || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

const HOLDER = { select: { id: true, employeeCode: true, name: true, department: true } };

module.exports = {
  key: 'assets',
  label: 'Assets',
  module: 'Assets',
  what: 'assets',
  feature: 'Employee Services',
  importActions: ['create', 'edit'],
  sheet: 'Assets',
  entity: 'Asset',
  columns,
  instructions: [
    'One row = one asset. An existing Asset ID updates that asset (blank cells never overwrite); a blank Asset ID adds a new asset with the next AST- number.',
    'Assigned To (Employee ID) allocates or transfers the asset; Status Available or Retired with no holder returns it. Every movement is written to the asset history and the audit log. No notification or email is sent.',
  ],
  lists: async () => {
    const rows = await prisma.asset.findMany({ select: { category: true }, distinct: ['category'] });
    const inUse = rows.map((r) => r.category).filter(Boolean);
    return { Status: STATUSES, 'Categories in use': [...new Set([...inUse, ...DEFAULT_CATEGORIES])].sort() };
  },

  async exportRows(ctx, { employeeIds, filters }) {
    // eslint-disable-next-line global-require
    const { assetWhere } = require('../routes/assetInventory');
    const caps = await io.capsOf(module.exports, ctx.user);
    const oneHolder = !!io.str(filters.employeeId) || !caps.canExport;
    const where = oneHolder
      ? { assignedToId: { in: employeeIds } }
      // The register's own scope and report filters (company stock included).
      : assetWhere(ctx.user, { ...filters, employeeId: undefined });
    const assets = await prisma.asset.findMany({ where, include: { assignedTo: HOLDER }, orderBy: { assetCode: 'asc' } });
    return assets.map(rowOf);
  },

  async validate(rows, ctx) {
    const codes = [...new Set(rows.map((r) => io.str(r.assetCode)).filter(Boolean))];
    const existing = codes.length ? await prisma.asset.findMany({ where: { assetCode: { in: codes } }, include: { assignedTo: HOLDER } }) : [];
    const byCode = new Map(existing.map((a) => [a.assetCode.toLowerCase(), a]));
    const seen = new Map();
    return rows.map((r) => {
      const errors = io.requiredErrors(module.exports, r);
      const code = io.str(r.assetCode);
      const label = `${code || 'New asset'}${io.str(r.name) ? ` — ${io.str(r.name)}` : ''}`;
      if (code) {
        const k = code.toLowerCase();
        if (seen.has(k)) errors.push({ field: 'Asset ID', message: `Asset ID repeated (row ${seen.get(k)}).` });
        else seen.set(k, r.line);
        if (code.length > 80) errors.push({ field: 'Asset ID', message: 'Asset ID is too long (80 characters at most).' });
      }
      const match = code ? byCode.get(code.toLowerCase()) || null : null;
      // An asset held by somebody outside this login's scope is theirs to manage.
      if (match && match.assignedToId && !ctx.employees.byId.has(match.assignedToId)) {
        errors.push({ field: 'Asset ID', message: `${match.assetCode} is held by an employee outside your scope.` });
      }
      let holder = null;
      if (io.str(r.holder)) {
        const hit = ctx.employees.resolve(r.holder);
        if (hit.error) errors.push({ field: 'Assigned To (Employee ID)', message: hit.error });
        else holder = hit.employee;
      }
      const dates = {};
      [['purchaseDate', 'Purchase Date'], ['warrantyUntil', 'Warranty Until'], ['assignedDate', 'Assigned Date']].forEach(([k, l]) => {
        const p = io.parseDate(r[k]);
        if (p.error) errors.push({ field: l, message: `"${r[k]}" is not a date (YYYY-MM-DD).` });
        dates[k] = p.value || null;
      });
      let status = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !status) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      if (holder && !status) status = 'Assigned';
      if (holder && ['Available', 'Retired'].includes(status)) {
        errors.push({ field: 'Status', message: `An ${status} asset cannot also be assigned to somebody — make it Assigned, or clear Assigned To.` });
      }
      if (status === 'Assigned' && !holder && !(match && match.assignedToId)) {
        errors.push({ field: 'Assigned To (Employee ID)', message: 'Status is Assigned — give the Employee ID of the holder.' });
      }
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const want = {
        name: io.str(r.name).slice(0, 200),
        category: io.str(r.category).slice(0, 80) || null,
        assetType: io.str(r.assetType).slice(0, 200) || null,
        location: io.str(r.location).slice(0, 200) || null,
        purchaseDate: dates.purchaseDate,
        warrantyUntil: dates.warrantyUntil,
        status,
      };
      if (!match) {
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [
            { field: 'Asset', from: '', to: `${code || '(next AST- number)'} ${want.name}` },
            { field: 'Status', from: '', to: status || 'Available' },
            ...(holder ? [{ field: 'Assigned To', from: '', to: `${holder.name} (${holder.employeeCode})` }] : []),
          ],
          data: { code: code || null, want, holder, assignedDate: dates.assignedDate },
        };
      }
      const changes = [];
      const cmp = (field, cur, next) => { if (next !== null && next !== undefined && String(cur ?? '') !== String(next)) changes.push({ field, from: cur ?? '', to: next }); };
      cmp('Asset Name', match.name, want.name);
      cmp('Category', match.category, want.category);
      cmp('Asset Type', match.assetType, want.assetType);
      cmp('Location', match.location, want.location);
      cmp('Purchase Date', match.purchaseDate, want.purchaseDate);
      cmp('Warranty Until', match.warrantyUntil, want.warrantyUntil);
      cmp('Status', match.status, want.status);
      const curHolder = match.assignedTo ? `${match.assignedTo.name} (${match.assignedTo.employeeCode})` : '';
      if (holder && holder.id !== match.assignedToId) changes.push({ field: 'Assigned To', from: curHolder, to: `${holder.name} (${holder.employeeCode})` });
      else if (!holder && ['Available', 'Retired'].includes(status) && match.assignedToId) changes.push({ field: 'Assigned To', from: curHolder, to: '(returned)' });
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { code, want, holder, assignedDate: dates.assignedDate, asset: match },
      };
    });
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email || 'import';
    const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
    // The next AST- number after the highest in use.
    const astCodes = await prisma.asset.findMany({ where: { assetCode: { startsWith: 'AST-' } }, select: { assetCode: true } });
    let seq = astCodes.reduce((m, a) => { const n = Number((/^AST-(\d+)$/.exec(a.assetCode) || [])[1]); return Number.isFinite(n) && n > m ? n : m; }, 0);
    const nextCode = async () => {
      for (;;) {
        seq += 1;
        const c = `AST-${String(seq).padStart(4, '0')}`;
        // eslint-disable-next-line no-await-in-loop
        if (!(await prisma.asset.findUnique({ where: { assetCode: c } }))) return c;
      }
    };
    const assignedAtOf = (d) => (d ? new Date(`${d}T09:00:00`) : new Date());
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      const x = v.data;
      try {
        if (v.action === 'create') {
          // eslint-disable-next-line no-await-in-loop
          const assetCode = x.code || await nextCode();
          const history = [{ at: stamp(), by: actor, text: 'Added by import' }];
          if (x.holder) history.unshift({ at: stamp(), by: actor, text: `Assigned to ${x.holder.name} (import)` });
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const asset = await tx.asset.create({
              data: {
                assetCode, name: x.want.name, category: x.want.category || 'Laptop', status: x.want.status || 'Available',
                purchaseDate: x.want.purchaseDate || new Date().toISOString().slice(0, 10), warrantyUntil: x.want.warrantyUntil,
                assetType: x.want.assetType, location: x.want.location, history: JSON.stringify(history),
                ...(x.holder ? {
                  assignedToId: x.holder.id, assignedAt: assignedAtOf(x.assignedDate), assignedById: ctx.user.id, assignedByName: actor,
                } : {}),
              },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Asset imported', entity: 'Asset', entityId: asset.id,
                toValue: `${asset.assetCode} ${asset.name} · ${asset.status}`, reason: x.holder ? `${x.holder.employeeCode} ${x.holder.name}` : null,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const cur = await tx.asset.findUnique({ where: { id: x.asset.id } });
            if (!cur) throw new Error('asset no longer exists');
            const data = {};
            ['name', 'category', 'assetType', 'location', 'purchaseDate', 'warrantyUntil', 'status'].forEach((k) => {
              if (x.want[k] !== null && x.want[k] !== undefined && x.want[k] !== '') data[k] = x.want[k];
            });
            const history = parseHistory(cur.history);
            if (x.holder && x.holder.id !== cur.assignedToId) {
              Object.assign(data, {
                assignedToId: x.holder.id, assignedAt: assignedAtOf(x.assignedDate), assignedById: ctx.user.id, assignedByName: actor, returnedAt: null,
              });
              if (!x.want.status) data.status = 'Assigned';
              history.unshift({ at: stamp(), by: actor, text: `${cur.assignedToId ? 'Transferred' : 'Assigned'} to ${x.holder.name} (import)` });
            } else if (!x.holder && ['Available', 'Retired'].includes(x.want.status) && cur.assignedToId) {
              Object.assign(data, { assignedToId: null, returnedAt: new Date() });
              history.unshift({ at: stamp(), by: actor, text: x.want.status === 'Retired' ? 'Retired (import)' : 'Returned (import)' });
            } else if (x.want.status && x.want.status !== cur.status) {
              history.unshift({ at: stamp(), by: actor, text: `Status ${cur.status} → ${x.want.status} (import)` });
            }
            data.history = JSON.stringify(history);
            await tx.asset.update({ where: { id: cur.id }, data });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Asset updated by import', entity: 'Asset', entityId: cur.id,
                field: c.field, fieldLabel: c.field, fromValue: String(c.from ?? ''), toValue: String(c.to ?? ''),
              })),
            });
          });
          updated += 1;
        }
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed };
  },
};

// ---------------------------------------------------------------------------
// EmployeeRecord io kit — the shared export / validate / apply behind the
// Performance & Development and Employee Services record types that live on
// the one EmployeeRecord table (Targets, Recognition, KT, Disciplinary,
// Helpdesk). Not a spec itself: the leading "_" keeps utils/moduleIo.js from
// loading it (see loadSpecs()).
//
// An import records HISTORY only. It writes the EmployeeRecord row directly
// (never through routes/employeeRecords.js), so it never fans out to an
// audience, never sends a notification / email / WhatsApp, and never starts
// an approval. Every created row gets an audit row; every updated field gets
// its own audit row (from → to). Blank cells never overwrite.
//
// A spec built with recordSpec() describes:
//   type            EmployeeRecord.type
//   columns         the moduleIo columns (employeeCode first)
//   toRow(rec, aux) one export row (column key -> value)
//   aux(recs)       optional: extra lookups the export rows need
//   parse(row, e, ctx) -> { errors, key, want, createOnly, label }
//                   `key`  the match key within the employee (same key ->
//                          update, else create) — must equal keyOf(rec)
//                   `want` { dbField: value | null } — null = blank, left alone
//                   `createOnly` extra columns written only on create
//   keyOf(rec)      the same match key for a record already on file
//   fieldLabels     { dbField: 'Column label' } for the preview / audit
//   createDefaults(want, ctx) extra defaults for a created row
//   dateOf(rec)     the date the from/to export filter reads (default rec.date || createdAt)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const same = (a, b) => String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
const lower = (v) => io.str(v).toLowerCase();

function recordSpec(def) {
  const spec = {
    feature: 'Employee Services',
    importActions: ['create'],
    entity: 'EmployeeRecord',
    ...def,
  };
  const dateOf = def.dateOf || ((r) => r.date || ymd(r.createdAt));
  const labelOf = (f) => (def.fieldLabels && def.fieldLabels[f]) || f;

  spec.exportRows = async function exportRows(ctx, { employeeIds, filters = {} }) {
    const where = { type: def.type, employeeId: { in: employeeIds } };
    ['status', 'category', 'priority'].forEach((k) => { if (io.str(filters[k])) where[k] = io.str(filters[k]); });
    const recs = await prisma.employeeRecord.findMany({
      where, include: { employee: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    const dept = io.str(filters.department);
    const from = io.parseDate(filters.from).value;
    const to = io.parseDate(filters.to).value;
    const month = io.str(filters.month);
    const kept = recs.filter((r) => {
      if (dept && (!r.employee || r.employee.department !== dept)) return false;
      if (month && !String(r.date || '').startsWith(month)) return false;
      if (from || to) {
        const d = String(dateOf(r) || '').slice(0, 10);
        if (!d || (from && d < from) || (to && d > to)) return false;
      }
      return true;
    });
    const aux = typeof def.aux === 'function' ? await def.aux(kept, ctx) : {};
    return kept.map((r) => ({
      employeeCode: r.employee ? r.employee.employeeCode : '',
      employeeName: r.employee ? r.employee.name : '',
      department: r.employee ? r.employee.department || '' : '',
      ...def.toRow(r, aux),
    }));
  };

  spec.validate = async function validate(rows, ctx) {
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length
      ? await prisma.employeeRecord.findMany({ where: { type: def.type, employeeId: { in: empIds } }, orderBy: { createdAt: 'desc' } })
      : [];
    const byKey = new Map();
    existing.forEach((x) => {
      const k = `${x.employeeId}|${def.keyOf(x)}`;
      if (!byKey.has(k)) byKey.set(k, x); // the most recent wins
    });
    const seen = new Map();
    const out = [];
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const hit = resolved[i];
      const errors = io.requiredErrors(spec, r);
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      // eslint-disable-next-line no-await-in-loop
      const p = await def.parse(r, e, ctx);
      errors.push(...(p.errors || []));
      const label = e ? `${e.name} (${e.employeeCode})${p.label ? ` · ${p.label}` : ''}` : io.str(r.employeeCode);
      if (e && p.key && !errors.length) {
        const k = `${e.id}|${p.key}`;
        if (seen.has(k)) errors.push({ field: spec.columns[3] ? spec.columns[3].label : 'Row', message: `Same record as row ${seen.get(k)} (same employee, ${def.keyText || 'date'}).` });
        else seen.set(k, r.line);
      }
      if (errors.length) { out.push({ line: r.line, label, errors, action: 'error' }); continue; } // eslint-disable-line no-continue
      const match = byKey.get(`${e.id}|${p.key}`);
      // Rules that depend on the record already on file (null for a new row).
      const late = typeof p.checkAgainst === 'function' ? p.checkAgainst(match || null) : [];
      if (late.length) { out.push({ line: r.line, label, errors: late, action: 'error' }); continue; } // eslint-disable-line no-continue
      const want = p.want || {};
      if (!match) {
        const changes = Object.entries(want).filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([f, v]) => ({ field: labelOf(f), from: '', to: v }));
        out.push({
          line: r.line, label, errors: [], action: 'create', changes,
          data: { employee: e, want, createOnly: p.createOnly || {} },
        });
        continue; // eslint-disable-line no-continue
      }
      const changes = [];
      const set = {};
      Object.entries(want).forEach(([f, v]) => {
        if (v === null || v === undefined || v === '') return; // blanks never overwrite
        if (!same(match[f], v)) { changes.push({ field: labelOf(f), from: match[f] ?? '', to: v }); set[f] = v; }
      });
      if (p.extraChanges) p.extraChanges(match, set, changes);
      out.push({
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes,
        data: { employee: e, record: match, set },
      });
    }
    return out;
  };

  spec.apply = async function apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email;
    const noun = def.auditNoun || def.label;
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      try {
        const x = v.data;
        if (v.action === 'create') {
          const data = { type: def.type, employeeId: x.employee.id, status: 'Open' };
          Object.entries(x.want).forEach(([f, val]) => { if (val !== null && val !== undefined && val !== '') data[f] = val; });
          Object.assign(data, typeof def.createDefaults === 'function' ? def.createDefaults(data, ctx) : {}, x.createOnly || {});
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const rec = await tx.employeeRecord.create({ data });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: `${noun} imported`, entity: 'EmployeeRecord', entityId: rec.id,
                toValue: String(data.title || '').slice(0, 200), reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            await tx.employeeRecord.update({ where: { id: x.record.id }, data: x.set });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: `${noun} updated by import`, entity: 'EmployeeRecord', entityId: x.record.id,
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
  };

  return spec;
}

// Shared column trio every record sheet starts with.
const EMPLOYEE_COLUMNS = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
  { key: 'employeeName', label: 'Employee Name', readOnly: true, example: 'Asha Rao' },
  { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
];

// Small parse helpers for the specs.
function dateCell(r, key, label, errors, { required = false } = {}) {
  const d = io.parseDate(r[key]);
  if (d.error) { errors.push({ field: label, message: `"${r[key]}" is not a date (YYYY-MM-DD).` }); return null; }
  if (d.empty) { if (required) errors.push({ field: label, message: `${label} is required.` }); return null; }
  return d.value;
}
function numberCell(r, key, label, errors, { min = null, max = null, int = false } = {}) {
  const n = io.parseNumber(r[key]);
  if (n.error) { errors.push({ field: label, message: `"${r[key]}" is not a number.` }); return null; }
  if (n.empty) return null;
  if ((min !== null && n.value < min) || (max !== null && n.value > max)) {
    errors.push({ field: label, message: `${label} must be between ${min} and ${max}.` }); return null;
  }
  if (int && !Number.isInteger(n.value)) { errors.push({ field: label, message: `${label} must be a whole number.` }); return null; }
  return n.value;
}
function listCell(r, key, label, list, errors) {
  if (!io.str(r[key])) return null;
  const v = io.pick(list, r[key]);
  if (!v) errors.push({ field: label, message: `"${r[key]}" is not one of ${list.join(', ')}.` });
  return v;
}

module.exports = {
  recordSpec, EMPLOYEE_COLUMNS, dateCell, numberCell, listCell, ymd, lower,
};

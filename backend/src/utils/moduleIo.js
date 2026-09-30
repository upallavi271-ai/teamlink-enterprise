// ---------------------------------------------------------------------------
// MODULE DATA I/O — one framework for "export per employee + global export +
// import with a COMPULSORY sample file" in every HRMS module (the user's rule,
// 2026-09-29).
//
// A module describes itself ONCE in a spec file under src/io/<key>.js (they
// are auto-loaded — adding a module never edits a shared registry):
//
//   module.exports = {
//     key: 'leave-history',            // URL key: /api/io/leave-history/...
//     label: 'Leave requests',         // what the rows are
//     module: 'Leave',                 // the screen, as users name it
//     what: 'leave requests',          // noun for the Super Admin notice
//     feature: 'Leave & Holidays',     // HRMS feature the permissions read
//     importActions: ['create'],       // ALL must be held to import (default ['create'])
//     exportAction: 'export',          // (default 'export')
//     selfExport: true,                // no export right -> own rows only (default true)
//     columns: [ { key, label, required, type: 'date'|'number'|'text', list, note, example, readOnly } ],
//     lists: async (ctx) => ({ 'Leave type': ['Casual', …] }),   // extra "Lists" sheet columns
//     exportRows: async (ctx, { employeeIds, filters }) => [ { <column key>: value } ],  // optional
//     validate: async (rows, ctx) => [ { line, errors: [{field, message}], action, label, changes, data } ],
//     apply: async (validRows, ctx) => ({ created, updated, skipped, failed: [{ line, reason }] }),
//     caps: async (user, base) => base,  // optional override of the computed rights
//     allowRequest: false,             // view-only users may submit an import REQUEST (Super Admin approves)
//   };
//
// THE SAMPLE IS THE CONTRACT. The sample workbook (Data · Lists ·
// Instructions) and the CSV are built from `columns`, and the importer
// REFUSES a file whose header row does not match it: every importable column
// must be present, read-only columns may be present or absent, and any other
// column is an error. Rows whose first cell starts with "EXAMPLE" are the
// sample's example rows and are skipped.
//
// ctx = { req, user, lists, employees } where `employees` is employeeIndex():
// the employees THIS caller may reach (utils/scope.js employeeWhere), never a
// system account. A row naming anybody outside it is an error, so an import
// can never reach further than the list does.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../db');
const { can } = require('./permissions');
const { employeeWhere } = require('./scope');
const { withoutSystemAccounts } = require('./systemAccounts');

const MAX_ROWS = 5000;
const EXAMPLE_RE = /^example/i;
const specs = new Map();
let loaded = false;

function register(spec) {
  if (!spec || !spec.key) throw new Error('moduleIo: a spec needs a key');
  specs.set(spec.key, spec);
  return spec;
}

function loadSpecs() {
  if (loaded) return specs;
  loaded = true;
  const dir = path.join(__dirname, '..', 'io');
  if (!fs.existsSync(dir)) return specs;
  fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort().forEach((f) => {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const spec = require(path.join(dir, f));
      (Array.isArray(spec) ? spec : [spec]).forEach(register);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[moduleIo] could not load io spec %s: %s', f, err && err.message);
    }
  });
  return specs;
}

function getSpec(key) {
  loadSpecs();
  return specs.get(key) || null;
}

function allSpecs() {
  loadSpecs();
  return [...specs.values()];
}

// ---- small parsers the specs share -----------------------------------------
const str = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const loose = (v) => str(v).toLowerCase().replace(/[\s_-]+/g, '');

function dateFromSerial(n) {
  const p = XLSX.SSF.parse_date_code(Number(n));
  if (!p || !p.y) return null;
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'DD/MM/YYYY' | Excel serial -> { value } | { empty } | { error }
function parseDate(v) {
  const s = str(v);
  if (!s) return { empty: true };
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = dateFromSerial(Number(s)); return d ? parseDate(d) : { error: true }; }
  let y; let m; let d;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (mt) [, y, m, d] = mt;
  else {
    mt = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!mt) return { error: true };
    [, d, m, y] = mt;
  }
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) return { error: true };
  if (Number(y) < 1950 || Number(y) > 2100) return { error: true };
  return { value: dt.toISOString().slice(0, 10) };
}

function parseNumber(v) {
  const s = str(v).replace(/[,₹\s]/g, '');
  if (!s) return { empty: true };
  const n = Number(s);
  return Number.isFinite(n) ? { value: n } : { error: true };
}

// Case/space-insensitive pick from an allowed list; null when not in it.
function pick(list, v) {
  const want = loose(v);
  return (list || []).find((x) => loose(x) === want) || null;
}

// ---- the employees this caller may reach ------------------------------------
async function employeeIndex(req) {
  const rows = await prisma.employee.findMany({
    where: withoutSystemAccounts(employeeWhere(req.user)),
    select: {
      id: true, employeeCode: true, name: true, email: true, department: true, team: true, userId: true, employmentStatus: true,
    },
    orderBy: { name: 'asc' },
  });
  const byCode = new Map(rows.map((e) => [str(e.employeeCode).toUpperCase(), e]));
  const byEmail = new Map(rows.filter((e) => e.email).map((e) => [str(e.email).toLowerCase(), e]));
  const byId = new Map(rows.map((e) => [e.id, e]));
  return {
    list: rows,
    byId,
    // An Employee ID (preferred) or an email. { employee } | { error }
    resolve(value) {
      const v = str(value);
      if (!v) return { error: 'Employee ID is required.' };
      const e = byCode.get(v.toUpperCase()) || byEmail.get(v.toLowerCase());
      return e ? { employee: e } : { error: `Employee "${v}" is not in your scope (or does not exist).` };
    },
  };
}

// ---- rights -------------------------------------------------------------------
async function capsOf(spec, user) {
  const product = spec.product || 'hrms';
  const moduleId = spec.moduleId || 'hrms';
  const feature = spec.feature;
  const importActions = spec.importActions || ['create'];
  const [view, exp, ...imp] = await Promise.all([
    can(user, product, moduleId, feature, spec.viewAction || 'view'),
    can(user, product, moduleId, feature, spec.exportAction || 'export'),
    ...importActions.map((a) => can(user, product, moduleId, feature, a)),
  ]);
  const canImport = imp.length > 0 && imp.every(Boolean);
  let base = {
    canView: view,
    canExport: exp,
    selfExport: spec.selfExport !== false && !exp && !!user.employeeId,
    canImport,
    allowRequest: !!spec.allowRequest && view && !canImport,
    importBlockedReason: canImport ? null
      : `Import needs ${importActions.join(' + ')} rights on ${feature} — your role has view${exp ? ' + export' : ''} only.`,
  };
  if (typeof spec.caps === 'function') base = await spec.caps(user, base);
  if (base.allowRequest) base.importBlockedReason = null;
  return base;
}

// ---- the sample ---------------------------------------------------------------
const importable = (spec) => spec.columns.filter((c) => !c.readOnly);
const headerOf = (c) => `${c.label}${c.required ? ' ✱' : ''}${c.readOnly ? ' (read-only)' : ''}`;
// '?' and U+FFFD: what the ✱ becomes when Excel re-saves the CSV in a legacy code page.
const normHeader = (h) => str(h).replace(/[✱*?�]/g, '').replace(/\((read[- ]?only|required|optional)\)/ig, '').trim().toLowerCase().replace(/\s+/g, ' ');

async function listsFor(spec, ctx) {
  const extra = typeof spec.lists === 'function' ? await spec.lists(ctx) : (spec.lists || {});
  return extra || {};
}

function columnNote(c, lists) {
  const bits = [];
  if (c.required) bits.push('Required.');
  if (c.readOnly) bits.push('Read-only: exported for reference, ignored on import.');
  if (c.type === 'date') bits.push('Date: YYYY-MM-DD (DD-MM-YYYY and Excel dates also accepted).');
  if (c.type === 'number') bits.push('A number.');
  if (c.list) bits.push(`One of the values in the "${c.list}" column of the Lists sheet${lists[c.list] ? ` (${lists[c.list].length} values)` : ''}.`);
  if (c.note) bits.push(c.note);
  return bits.join(' ');
}

async function sampleFile(spec, ctx, format = 'xlsx') {
  const lists = await listsFor(spec, ctx);
  const headers = spec.columns.map(headerOf);
  const exampleRows = (spec.examples || [spec.columns.reduce((o, c) => ({ ...o, [c.key]: c.example ?? '' }), {})])
    .map((ex, i) => spec.columns.map((c, j) => {
      if (j === 0) return `EXAMPLE-${String(i + 1).padStart(3, '0')}`;
      const v = ex[c.key];
      return v === undefined || v === null ? '' : v;
    }));
  if (format === 'csv') {
    const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return Buffer.from(`﻿${[headers, ...exampleRows].map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`, 'utf8');
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
  ws['!cols'] = spec.columns.map((c) => ({ wch: Math.max(12, Math.min(40, headerOf(c).length + 4)) }));
  // Keep IDs, phones and dates as TEXT so Excel does not eat leading zeros.
  const textCols = spec.columns.map((c, i) => (c.type === 'date' || c.text !== false ? i : -1)).filter((i) => i >= 0 && spec.columns[i].type !== 'number');
  for (let r = 0; r <= exampleRows.length + 300; r += 1) {
    textCols.forEach((c) => {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { t: 's', v: '' };
      ws[ref].z = '@';
    });
  }
  // Header notes: each header cell carries its rule as a comment.
  spec.columns.forEach((c, i) => {
    const ref = XLSX.utils.encode_cell({ r: 0, c: i });
    const note = columnNote(c, lists);
    if (note && ws[ref]) { ws[ref].c = [{ a: 'TeamLink', t: note }]; ws[ref].c.hidden = true; }
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: exampleRows.length + 300, c: spec.columns.length - 1 } });
  XLSX.utils.book_append_sheet(wb, ws, (spec.sheet || spec.label || 'Data').slice(0, 31));

  // LISTS — the allowed values, generated from the live masters.
  const names = Object.keys(lists);
  if (names.length) {
    const longest = Math.max(...names.map((n) => (lists[n] || []).length));
    const aoa = [names];
    for (let i = 0; i < longest; i += 1) aoa.push(names.map((n) => (lists[n] || [])[i] ?? ''));
    const wl = XLSX.utils.aoa_to_sheet(aoa);
    wl['!cols'] = names.map((n) => ({ wch: Math.max(14, Math.min(40, n.length + 6)) }));
    XLSX.utils.book_append_sheet(wb, wl, 'Lists');
  }

  const ins = [
    [`${String(spec.module || spec.label).toUpperCase()} — IMPORT SAMPLE (${spec.label})`],
    [''],
    ['1. Fill the first sheet, one row per record, below the header row. Do NOT rename, add or remove columns — a file whose headers do not match this sample is refused.'],
    ['2. Columns marked ✱ are required. Columns marked (read-only) are for reference and are ignored on import.'],
    ['3. Rows whose first cell starts with "EXAMPLE" are examples and are always skipped — overwrite or delete them.'],
    ['4. Allowed values for list columns are on the "Lists" sheet (taken from the live masters when this file was downloaded).'],
    ['5. Upload on the module screen → Import → Check file (nothing is written), then Import. Only rows that pass every check are written.'],
    ['6. Every import is recorded in the audit log and the Super Admin is notified.'],
    ...(spec.instructions || []).map((t, i) => [`${7 + i}. ${t}`]),
    [''],
    ['Column', 'Required', 'Rule'],
    ...spec.columns.map((c) => [headerOf(c), c.required ? 'Yes ✱' : (c.readOnly ? 'Read-only' : 'No'), columnNote(c, lists)]),
  ];
  const wi = XLSX.utils.aoa_to_sheet(ins);
  wi['!cols'] = [{ wch: 34 }, { wch: 12 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, wi, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- parsing, with the STRICT header check ------------------------------------
function parseFile(spec, buffer, fileName = '') {
  const isCsv = /\.(csv|txt)$/i.test(fileName);
  let wb;
  try {
    // A CSV is read as UTF-8 text (with or without a byte-order mark), so the
    // ✱ and any non-English name survive a re-save without a BOM.
    wb = isCsv
      ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true, cellDates: false })
      : XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  } catch (err) {
    return { error: `That file could not be read as Excel or CSV (${String(err.message || err).slice(0, 80)}).` };
  }
  const want = (spec.sheet || spec.label || '').toLowerCase();
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === want)
    || wb.SheetNames.find((n) => !['lists', 'instructions'].includes(n.toLowerCase()))
    || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return { error: 'That workbook has no sheets.' };
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
  const headerIdx = aoa.findIndex((r) => r.some((c) => str(c) !== ''));
  if (headerIdx < 0) return { error: 'That file has no header row. Download the sample file and fill it in.' };
  const headers = aoa[headerIdx].map((h) => str(h));
  const byNorm = new Map(spec.columns.map((c) => [normHeader(c.label), c]));
  const mapped = headers.map((h) => (h ? byNorm.get(normHeader(h)) || null : null));
  const unknown = headers.filter((h, i) => h && !mapped[i]);
  const seen = new Map();
  const dupes = [];
  mapped.forEach((c, i) => { if (!c) return; if (seen.has(c.key)) dupes.push(headers[i]); else seen.set(c.key, i); });
  const missing = importable(spec).filter((c) => !seen.has(c.key)).map((c) => c.label);
  if (unknown.length || missing.length || dupes.length) {
    const bits = [];
    if (missing.length) bits.push(`missing column(s): ${missing.join(', ')}`);
    if (unknown.length) bits.push(`column(s) not in the sample: ${unknown.join(', ')}`);
    if (dupes.length) bits.push(`repeated column(s): ${dupes.join(', ')}`);
    return {
      error: `This file does not match the ${spec.label} sample — ${bits.join('; ')}. Download the sample file and use its header row exactly.`,
      headerMismatch: { missing, unknown, dupes },
    };
  }
  const rows = [];
  let examples = 0;
  for (let i = headerIdx + 1; i < aoa.length; i += 1) {
    const cells = aoa[i];
    const row = { line: i + 1 };
    let any = false;
    mapped.forEach((c, j) => {
      if (!c) return;
      let v = cells[j];
      if (typeof v === 'number' && c.type === 'date') v = dateFromSerial(v) || String(v);
      row[c.key] = v === undefined || v === null ? '' : (typeof v === 'number' && c.type === 'number' ? v : str(v));
      if (str(row[c.key]) !== '') any = true;
    });
    if (!any) continue; // eslint-disable-line no-continue
    const first = str(cells[mapped.findIndex(Boolean)] ?? cells[0]);
    if (EXAMPLE_RE.test(first) || EXAMPLE_RE.test(str(cells[0]))) { examples += 1; continue; } // eslint-disable-line no-continue
    rows.push(row);
  }
  if (!rows.length) return { error: examples ? 'Only the sample\'s EXAMPLE rows are in this file — add your own rows below them (or replace them).' : 'That file has no data rows.' };
  if (rows.length > MAX_ROWS) return { error: `Import at most ${MAX_ROWS} rows at a time (this file has ${rows.length}).` };
  return { rows, examples, sheetName, ignoredReadOnly: spec.columns.filter((c) => c.readOnly && seen.has(c.key)).map((c) => c.label) };
}

// Required-column check every spec gets for free (specs add their own).
function requiredErrors(spec, row) {
  return importable(spec).filter((c) => c.required && str(row[c.key]) === '').map((c) => ({ field: c.label, message: `${c.label} is required.` }));
}

// The preview payload the screen draws (and an import request stores).
function previewOf(spec, validated, parsed) {
  const bad = validated.filter((v) => v.errors && v.errors.length);
  const good = validated.filter((v) => !v.errors || !v.errors.length);
  const count = (a) => good.filter((v) => v.action === a).length;
  return {
    module: spec.module,
    label: spec.label,
    rowCount: validated.length,
    exampleRowsSkipped: parsed.examples || 0,
    validCount: good.length,
    invalidCount: bad.length,
    willCreate: count('create'),
    willUpdate: count('update'),
    unchanged: count('nochange') + count('skip'),
    errors: bad.flatMap((v) => v.errors.map((e) => ({ line: v.line, label: v.label || '', field: e.field, message: e.message }))).slice(0, 1000),
    rows: validated.slice(0, 500).map((v) => ({
      line: v.line, label: v.label || '', action: v.errors && v.errors.length ? 'error' : v.action,
      changes: (v.changes || []).slice(0, 40), errors: (v.errors || []).map((e) => `${e.field}: ${e.message}`),
    })),
    ignoredReadOnly: parsed.ignoredReadOnly || [],
  };
}

module.exports = {
  MAX_ROWS,
  register,
  getSpec,
  allSpecs,
  capsOf,
  sampleFile,
  parseFile,
  previewOf,
  requiredErrors,
  employeeIndex,
  listsFor,
  headerOf,
  normHeader,
  // parsers for specs
  str,
  loose,
  pick,
  parseDate,
  parseNumber,
  dateFromSerial,
};

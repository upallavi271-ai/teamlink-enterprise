'use strict';
// ---------------------------------------------------------------------------
// EXTRA SALARY STRUCTURES (founder 2026-11-28: "an Add structure where I add the components I want with their percentage, and can edit
// and delete them").
//
// A structure is a list of components the Super Admin defines, one AppSetting each ('payroll.salaryTemplate:<id>'). The Standard Package
// (utils/salaryRules.js) is untouched and stays the rule for everybody who is not put on one of these.
//
//   earning     pctCtc | pctBasic | fixed | rest   ("whatever is left of the CTC" - exactly one component)
//   deduction   pctGross | pctBasic | fixed        (the same amount every month, not reduced for unpaid days)
//   pf, gratuity, pt                               switched on or off per structure; PF % and cap, gratuity %
//
// Payroll still reads the salary record's own columns, so NO CALCULATION CHANGES: Basic -> basic; a component called HRA / Bonus /
// Conveyance -> that column; every other earning -> specialAllowance; deductions -> otherDeductions.
// The component names and amounts of ONE saved salary are kept with it (AppSetting 'payroll.structureLines:<versionId>', with the
// structure's definition), so editing or deleting a structure never changes a salary already saved. Screens show the names only while
// that note still adds up to the stored columns; a figure changed by hand falls back to the standard labels.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { professionalTaxFor, rulesFrom } = require('./salaryRules');

const TEMPLATE = 'payroll.salaryTemplate:';
const LINES = 'payroll.structureLines:';
const STANDARD = 'standard';
const COLUMNS = ['basic', 'hra', 'conveyance', 'specialAllowance', 'bonus'];
const EARNING_CALCS = ['pctCtc', 'pctBasic', 'fixed', 'rest'];
const DEDUCTION_CALCS = ['pctGross', 'pctBasic', 'fixed'];
const MAX_COMPONENTS = 20;
const MAX_AMOUNT = 10000000;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const total = (list) => list.reduce((n, x) => n + (Number(x.amount) || 0), 0);
const tidy = (v, max = 40) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const isBasic = (name) => /^basic( salary| pay)?$/i.test(name);

// which column of the salary record a component is paid in
function columnOf(name) {
  if (isBasic(name)) return 'basic';
  if (/^(hra|house rent( allowance)?|hra \(house rent\))$/i.test(name)) return 'hra';
  if (/^bonus$/i.test(name)) return 'bonus';
  if (/^conveyance( allowance)?$/i.test(name)) return 'conveyance';
  return 'specialAllowance';
}

const percent = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
const money = (v) => Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT;

// What the screen sends -> { definition } or { error }. Pure. `policy` fills the PF / gratuity figures nobody typed.
function cleanDefinition(input, policy) {
  const b = input || {};
  const company = rulesFrom(policy || {});
  const name = tidy(b.name);
  if (!name) return { error: 'Give the structure a name.' };
  if (/^standard( package| structure)?$/i.test(name)) return { error: 'The name "Standard" is already used by the Standard Package.' };
  const rows = Array.isArray(b.components) ? b.components : [];
  if (!rows.length) return { error: 'Add the components of this structure.' };
  if (rows.length > MAX_COMPONENTS) return { error: `A structure can have up to ${MAX_COMPONENTS} components.` };
  const seen = new Set();
  const components = [];
  for (const row of rows) {
    const label = tidy(row && row.name);
    if (!label) return { error: 'Every component needs a name.' };
    const kind = row.kind === 'deduction' ? 'deduction' : 'earning';
    if (seen.has(label.toLowerCase())) return { error: `"${label}" is added twice.` };
    seen.add(label.toLowerCase());
    if (/^(pf|pt|esi|tds|gratuity|provident fund|professional tax|employer pf)$/i.test(label)) {
      return { error: `"${label}" has its own setting (PF, gratuity, PT below; ESI and TDS on the employee's salary). Use another name.` };
    }
    const calc = String(row.calc || '');
    if (!(kind === 'earning' ? EARNING_CALCS : DEDUCTION_CALCS).includes(calc)) return { error: `Choose how "${label}" is worked out.` };
    let value = 0;
    if (calc !== 'rest') {
      value = row.value === '' || row.value === null || row.value === undefined ? NaN : Number(row.value);
      if (calc === 'fixed') {
        if (!money(value) || !(value > 0)) return { error: `Type the rupee amount of "${label}".` };
        value = Math.round(value);
      } else {
        if (!percent(value) || !(value > 0)) return { error: `Type the percentage of "${label}" (above 0, up to 100).` };
        value = r2(value);
      }
    }
    if (isBasic(label) && (kind !== 'earning' || !['pctCtc', 'fixed'].includes(calc))) return { error: 'Basic is an earning: a % of the CTC or a fixed amount.' };
    components.push({ name: label, kind, calc, value });
  }
  if (!components.some((c) => isBasic(c.name))) return { error: 'A structure needs a component called Basic (PF and gratuity are worked out on it).' };
  if (components.filter((c) => isBasic(c.name)).length > 1) return { error: 'Only one component can be Basic.' };
  const rest = components.filter((c) => c.calc === 'rest').length;
  if (rest !== 1) return { error: 'Choose exactly one component that takes "the rest of the CTC", so the parts always add up to the CTC.' };

  const num = (v, fallback) => (v === '' || v === null || v === undefined ? fallback : Number(v));
  const pfIn = b.pf || {};
  const pf = {
    on: pfIn.on !== false,
    employeePct: num(pfIn.employeePct, company.employeePfPctOfBasic),
    employerPct: num(pfIn.employerPct, company.employerPfPctOfBasic),
    cap: num(pfIn.cap, company.employeePfMonthlyCap),
  };
  if (pf.on && (!percent(pf.employeePct) || !percent(pf.employerPct) || !money(pf.cap))) return { error: 'Check the PF percentages (0 to 100) and the monthly limit.' };
  const gIn = b.gratuity || {};
  const gratuity = { on: gIn.on !== false, pct: num(gIn.pct, company.gratuityPctOfBasic) };
  if (gratuity.on && !percent(gratuity.pct)) return { error: 'Check the gratuity percentage (0 to 100).' };
  const pt = { on: !(b.pt && b.pt.on === false) };
  return { definition: { name, components, pf, gratuity, pt } };
}

// A definition + a monthly CTC -> every figure. Pure. `ok: false` with `error` when the parts do not fit the CTC.
function compute(definition, monthlyCtc) {
  const d = definition;
  const ctc = Math.max(0, Math.round(Number(monthlyCtc) || 0));
  const basicRow = d.components.find((c) => isBasic(c.name));
  const basic = basicRow.calc === 'pctCtc' ? Math.round((ctc * basicRow.value) / 100) : Math.round(basicRow.value);
  const amountOf = (c) => {
    if (c === basicRow) return basic;
    if (c.calc === 'pctCtc') return Math.round((ctc * c.value) / 100);
    if (c.calc === 'pctBasic') return Math.round((basic * c.value) / 100);
    return Math.round(c.value);
  };
  const cap = (v, limit) => (limit > 0 ? Math.min(v, limit) : v);
  const employeePf = d.pf.on ? Math.round(cap((basic * d.pf.employeePct) / 100, d.pf.cap)) : 0;
  const employerPf = d.pf.on ? Math.round(cap((basic * d.pf.employerPct) / 100, d.pf.cap)) : 0;
  const gratuity = d.gratuity.on ? Math.round((basic * d.gratuity.pct) / 100) : 0;
  const earningRows = d.components.filter((c) => c.kind === 'earning');
  const named = earningRows.reduce((n, c) => n + (c.calc === 'rest' ? 0 : amountOf(c)), 0);
  const left = ctc - named - employerPf - gratuity;
  const earnings = earningRows.map((c) => ({ name: c.name, column: columnOf(c.name), amount: c.calc === 'rest' ? left : amountOf(c) }));
  const gross = total(earnings);
  const deductionLines = d.components.filter((c) => c.kind === 'deduction').map((c) => ({
    name: c.name,
    amount: c.calc === 'pctGross' ? Math.round((gross * c.value) / 100) : c.calc === 'pctBasic' ? Math.round((basic * c.value) / 100) : Math.round(c.value),
  }));
  const column = (k) => total(earnings.filter((x) => x.column === k));
  const professionalTax = d.pt.on ? professionalTaxFor(gross) : 0;
  const otherDeductions = total(deductionLines);
  const deductions = employeePf + professionalTax + otherDeductions;
  const net = gross - deductions;
  let error = null;
  if (!(ctc > 0)) error = 'Enter the monthly CTC.';
  else if (left < 0) error = `The components, PF and gratuity add up to ₹${(ctc - left).toLocaleString('en-IN')}, more than the monthly CTC of ₹${ctc.toLocaleString('en-IN')}.`;
  else if (net < 0) error = 'The deductions are more than the gross pay.';
  return {
    ok: !error, error, monthlyCtc: ctc, annualCtc: ctc * 12,
    basic, hra: column('hra'), bonus: column('bonus'), conveyance: column('conveyance'), special: column('specialAllowance'),
    gross, employeePf, professionalTax, otherDeductions, deductions, net, employerPf, gratuity, ctcCheck: gross + employerPf + gratuity,
    earnings, deductionLines,
  };
}

// The same shape the salary cards read, with the component names.
function breakupOfResult(res, structureName) {
  const { earnings, deductionLines, ok, error, ...rest } = res;
  return {
    ...rest, valid: ok, error, structureName,
    lines: { earnings: earnings.map((x) => ({ label: x.name, amount: x.amount })), deductions: deductionLines.map((x) => ({ label: x.name, amount: x.amount })) },
  };
}

// A saved salary on a structure: the fields of a SalaryStructureVersion plus the note kept with it. esiFor comes from salaryVersions.
// `extraOther` = "Other deductions" typed on the employee's salary, on top of the structure's own deductions.
function versionData({ structureId, definition, annualCtc, cfg, esiApplicable, tds, extraOther, esiFor }) {
  const res = compute(definition, (Number(annualCtc) || 0) / 12);
  if (!res.ok) return { error: res.error };
  const applicable = esiApplicable === true || esiApplicable === false ? esiApplicable : null;
  const esi = esiFor(res.gross, cfg, applicable);
  const extra = Math.max(0, Math.round(Number(extraOther) || 0));
  return {
    data: {
      payMode: 'Package', ctc: Number(annualCtc) || 0, stipend: 0,
      basic: res.basic, hra: res.hra, bonus: res.bonus, specialAllowance: res.special, conveyance: res.conveyance,
      employerPf: res.employerPf, employeePf: res.employeePf, professionalTax: res.professionalTax, gratuity: res.gratuity,
      esiApplicable: applicable, esiEmployee: esi.employee, esiEmployer: esi.employer,
      tds: tds === null || tds === undefined || tds === '' ? null : Math.max(0, Math.round(Number(tds) || 0)),
      otherDeductions: res.otherDeductions + extra,
    },
    snapshot: { structureId, structureName: definition.name, definition, earnings: res.earnings, deductions: res.deductionLines },
  };
}

// ---- showing the names -------------------------------------------------------------------------------------------------------------
// true while the note still adds up to the salary columns of `row` (a version, a payslip or a payroll record)
function matches(snapshot, row) {
  if (!snapshot || !row || !Array.isArray(snapshot.earnings)) return false;
  return COLUMNS.every((k) => Math.abs(total(snapshot.earnings.filter((x) => x.column === k)) - (Number(row[k]) || 0)) < 0.005);
}
// the structure's own deductions as named lines inside an "other deductions" amount, with whatever else is in it left over.
// null = they do not fit in that amount (nothing to name).
function splitOther(snapshot, amount) {
  const own = ((snapshot && snapshot.deductions) || []).filter((x) => x.amount > 0);
  const sum = total(own);
  if (!own.length || sum > (Number(amount) || 0) + 0.005) return null;
  return { lines: own.map((x) => ({ label: x.name, amount: x.amount })), rest: r2((Number(amount) || 0) - sum) };
}
// the typed part of a version's "other deductions" (what is not one of the structure's own)
const extraOtherOf = (snapshot, otherDeductions) => Math.max(0, r2((Number(otherDeductions) || 0) - total((snapshot && snapshot.deductions) || [])));

// A salary card's figures with the names on, from a stored row. `base` is the standard shape (salaryRules.structureFromRow).
function breakupWithNames(base, snapshot, row) {
  if (!base || !matches(snapshot, row)) return base;
  const earnings = snapshot.earnings.filter((x) => x.amount !== 0).map((x) => ({ label: x.name, amount: x.amount }));
  const gross = total(snapshot.earnings);
  const own = (snapshot.deductions || []).filter((x) => x.amount > 0).map((x) => ({ label: x.name, amount: x.amount }));
  const fits = total(own) <= (Number(row.otherDeductions) || 0) + 0.005;
  const lines = fits ? own : [];
  const deductions = base.employeePf + base.professionalTax + total(lines);
  return {
    ...base, conveyance: Number(row.conveyance) || 0, gross, deductions, net: gross - deductions, otherDeductions: total(lines),
    ctcCheck: gross + base.employerPf + base.gratuity, valid: true, structureName: snapshot.structureName,
    lines: { earnings, deductions: lines },
  };
}

// ---- storage -----------------------------------------------------------------------------------------------------------------------
const parse = (row) => { try { return row ? JSON.parse(row.value) : null; } catch { return null; } };

async function list(db = prisma) {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: TEMPLATE } } });
  return rows.map((r) => ({ row: r, t: parse(r) })).filter((x) => x.t && x.t.name && Array.isArray(x.t.components))
    .map((x) => ({ ...x.t, id: x.row.key.slice(TEMPLATE.length), updatedAt: x.row.updatedAt, updatedByName: x.row.updatedByName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function get(id, db = prisma) {
  if (!id) return null;
  const t = parse(await db.appSetting.findUnique({ where: { key: TEMPLATE + id } }));
  return t ? { ...t, id } : null;
}
async function save(id, definition, actor, db = prisma) {
  const useId = id || `st_${crypto.randomBytes(8).toString('hex')}`;
  const data = { value: JSON.stringify(definition), updatedById: (actor && actor.id) || null, updatedByName: (actor && actor.name) || null };
  await db.appSetting.upsert({ where: { key: TEMPLATE + useId }, update: data, create: { key: TEMPLATE + useId, ...data } });
  return { ...definition, id: useId };
}
const remove = (id, db = prisma) => db.appSetting.deleteMany({ where: { key: TEMPLATE + id } });

// Map(versionId -> note) for the versions asked for (those on the Standard Package have none)
async function linesFor(versionIds, db = prisma) {
  const keys = [...new Set((versionIds || []).filter(Boolean))].map((v) => LINES + v);
  const out = new Map();
  for (let i = 0; i < keys.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.appSetting.findMany({ where: { key: { in: keys.slice(i, i + 400) } } });
    rows.forEach((r) => { const s = parse(r); if (s) out.set(r.key.slice(LINES.length), s); });
  }
  return out;
}
const linesOf = async (versionId, db = prisma) => (versionId ? parse(await db.appSetting.findUnique({ where: { key: LINES + versionId } })) : null);
// snapshot null = this salary is not on a custom structure (any older note goes)
async function setLines(versionId, snapshot, db = prisma) {
  if (!snapshot) return db.appSetting.deleteMany({ where: { key: LINES + versionId } });
  const value = JSON.stringify(snapshot);
  return db.appSetting.upsert({ where: { key: LINES + versionId }, update: { value }, create: { key: LINES + versionId, value } });
}

module.exports = {
  STANDARD, COLUMNS, columnOf, cleanDefinition, compute, breakupOfResult, versionData, matches, splitOther, extraOtherOf, breakupWithNames,
  list, get, save, remove, linesFor, linesOf, setLines,
};

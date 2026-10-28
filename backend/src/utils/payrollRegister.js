// ---------------------------------------------------------------------------
// PAY REGISTER RULES (founder 2026-10-28: "the app's payroll must give EXACTLY the salary register my team makes in Excel").
//
// From the month in AppSetting 'payroll.registerRules' ({ "from": "2026-10" }) on, the payroll engine and the edit screen
// work the way the team's Pay Register does. Months before it (all already paid / imported) keep the old whole-rupee
// arithmetic, so nothing paid ever changes. No setting = the old rules everywhere.
//
//   earned part      ROUND(full-month amount x payable days / days in the cycle, 2)   for Basic, HRA, Conveyance, Special, Bonus
//   earned total     the sum of the earned parts (paise); LOP amount = full gross - earned total
//   stipend          ROUND(stipend x payable days / days, 2), no PF / ESI / PT
//   PF (employee)    by the version's PF rule: "24% of earned basic" -> ROUND(earned basic x 24%, 2),
//                    "12% of earned basic", or a FIXED amount that LOP does not reduce; no rule -> the version's PF x paid-day ratio
//   ESI (employee)   CEILING(0.75% x earned total) when the full-month gross is up to the ESI ceiling (21,000)
//   PT (Telangana)   on the earned total: above 20,000 -> 200, above 15,000 -> 150, else 0 (no cap by the structure's stored PT)
//   TDS              the version's monthly figure (paise)
//   net              earned total - (ESI + PF + PT + TDS + other)
//
// The PF rule of a structure version lives in AppSetting 'payroll.pfRule:<versionId>' = { mode: 'PCT', pct: 24 } or
// { mode: 'FIXED', amount: 2380.64 } - no schema change. A version without one uses the old PF figure.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { PT_SLAB, rulesFrom } = require('./salaryRules');

const SETTING = 'payroll.registerRules';
const ruleKey = (versionId) => `payroll.pfRule:${versionId}`;

// Excel's ROUND(x, 2) (half away from zero, on the decimal value).
function r2(n) {
  const x = Number(n) || 0;
  const s = x < 0 ? -1 : 1;
  return (s * Math.round(Math.abs(x) * 100 + 1e-6)) / 100;
}
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

// ---- the switch ---------------------------------------------------------------------------------
async function registerFrom(db = prisma) {
  const row = await db.appSetting.findUnique({ where: { key: SETTING } }).catch(() => null);
  if (!row) return null;
  try { const v = JSON.parse(row.value); return isMonth(v && v.from) ? v.from : null; } catch { return null; }
}
const registerOn = (month, from) => !!from && isMonth(month) && String(month) >= String(from);
async function isRegisterMonth(month, db = prisma) { return registerOn(month, await registerFrom(db)); }
async function setRegisterFrom(month, actorName, db = prisma) {
  if (!isMonth(month)) throw new Error('month must be YYYY-MM');
  const value = JSON.stringify({ from: month, setBy: actorName || null, at: new Date().toISOString() });
  await db.appSetting.upsert({ where: { key: SETTING }, update: { value }, create: { key: SETTING, value } });
}

// ---- PF rule of a version -------------------------------------------------------------------------
function cleanRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.mode === 'PCT' && Number(rule.pct) > 0 && Number(rule.pct) <= 100) return { mode: 'PCT', pct: Number(rule.pct) };
  if (rule.mode === 'FIXED' && Number(rule.amount) >= 0 && Number.isFinite(Number(rule.amount))) return { mode: 'FIXED', amount: r2(rule.amount) };
  return null;
}
// "24% of earned basic" | "24%" | "12" | "Fixed" | "Fixed (same as last month)" | "Fixed 2380.64" | "Default" -> rule
//   { rule } (null = no rule / old PF) | { error }
function parsePfRule(text, fixedAmount = null) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { empty: true };
  if (/^(default|standard|none|auto|old)\b/i.test(s)) return { rule: null };
  if (/^fixed\b/i.test(s)) {
    const inText = s.replace(/^fixed/i, '').replace(/[(),]/g, ' ').match(/\d+(\.\d+)?/);
    const amt = fixedAmount !== null && fixedAmount !== undefined && String(fixedAmount).trim() !== '' ? Number(String(fixedAmount).replace(/,/g, '')) : (inText ? Number(inText[0]) : NaN);
    if (!Number.isFinite(amt) || amt < 0) return { error: 'A Fixed PF rule needs the PF fixed amount.' };
    return { rule: { mode: 'FIXED', amount: r2(amt) } };
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%?/);
  if (m && Number(m[1]) > 0 && Number(m[1]) <= 100) return { rule: { mode: 'PCT', pct: Number(m[1]) } };
  return { error: `"${s}" is not a PF rule. Use "24% of earned basic", "12% of earned basic" or "Fixed" (with the PF fixed amount).` };
}
function pfRuleText(rule) {
  const r = cleanRule(rule);
  if (!r) return '';
  if (r.mode === 'PCT') return `${r.pct}% of earned basic`;
  return 'Fixed';
}
async function pfRulesFor(versionIds, db = prisma) {
  const out = new Map();
  const ids = [...new Set((versionIds || []).filter(Boolean))];
  if (!ids.length) return out;
  const rows = await db.appSetting.findMany({ where: { key: { in: ids.map(ruleKey) } } }).catch(() => []);
  rows.forEach((r) => {
    try { const rule = cleanRule(JSON.parse(r.value)); if (rule) out.set(r.key.slice('payroll.pfRule:'.length), rule); } catch { /* a broken row = no rule */ }
  });
  return out;
}
async function pfRuleOf(versionId, db = prisma) { return versionId ? (await pfRulesFor([versionId], db)).get(versionId) || null : null; }
async function setPfRule(versionId, rule, db = prisma) {
  const r = cleanRule(rule);
  if (!r) { await db.appSetting.deleteMany({ where: { key: ruleKey(versionId) } }); return null; }
  const value = JSON.stringify(r);
  await db.appSetting.upsert({ where: { key: ruleKey(versionId) }, update: { value }, create: { key: ruleKey(versionId), value } });
  return r;
}
// The full-month employee PF a rule means (shown on the structure; the payroll works it out on the earned basic).
function fullMonthPf(rule, basic) {
  const r = cleanRule(rule);
  if (!r) return null;
  return r.mode === 'FIXED' ? r.amount : r2(((Number(basic) || 0) * r.pct) / 100);
}

// ---- the rules object of utils/payrollCalc.js in register mode --------------------------------------
function rulesOf(version, policy, payMode, pfRule) {
  const v = version || {};
  const stipend = (payMode || v.payMode) === 'Stipend';
  const r = rulesFrom(policy || {});
  const baseGrossRef = stipend ? r2(v.stipend)
    : r2((Number(v.basic) || 0) + (Number(v.hra) || 0) + (Number(v.bonus) || 0) + (Number(v.specialAllowance) || 0) + (Number(v.conveyance) || 0));
  return {
    register: true,
    payMode: stipend ? 'Stipend' : 'Package',
    pf: {
      employeeFull: Number(v.employeePf) || 0, employerFull: Number(v.employerPf) || 0, gratuityFull: Number(v.gratuity) || 0, basicRef: Number(v.basic) || 0,
      empPct: r.employeePfPctOfBasic, empCap: r.employeePfMonthlyCap, erPct: r.employerPfPctOfBasic, erCap: r.employerPfMonthlyCap, gratuityPct: r.gratuityPctOfBasic,
      rule: cleanRule(pfRule),
    },
    esi: {
      enabled: !policy || policy.esiEnabled !== false,
      ceiling: policy && policy.esiGrossCeiling != null ? Number(policy.esiGrossCeiling) : 21000,
      empPct: policy && policy.esiEmployeePct != null ? Number(policy.esiEmployeePct) : 0.75,
      erPct: policy && policy.esiEmployerPct != null ? Number(policy.esiEmployerPct) : 3.25,
      applicable: v.esiApplicable === true || v.esiApplicable === false ? v.esiApplicable : null,
    },
    pt: { slab: PT_SLAB, versionMax: null, baseGrossRef },
    tds: { fixed: v.tds === null || v.tds === undefined ? null : r2(v.tds), pct: Number((policy && policy.tdsDefaultPctOfGross) || 0) },
  };
}

// Earned parts of a stored record (full-month amounts x payable / days), for the export and the payslip.
function earnedParts(e) {
  const wd = Number(e.workingDays) || 0;
  const paid = Math.max(0, wd - (Number(e.daysLop) || 0));
  const f = (x) => (wd > 0 ? r2(((Number(x) || 0) * paid) / wd) : r2(x));
  if (e.payMode === 'Stipend') {
    const full = r2((Number(e.grossPay) || 0) - (Number(e.incentive) || 0) - (Number(e.arrears) || 0));
    return { stipend: f(full), basic: 0, hra: 0, conveyance: 0, specialAllowance: 0, bonus: 0, payable: paid, nonPayable: wd - paid };
  }
  return {
    stipend: 0, basic: f(e.basic), hra: f(e.hra), conveyance: f(e.conveyance), specialAllowance: f(e.specialAllowance), bonus: f(e.bonus), payable: paid, nonPayable: wd - paid,
  };
}

// A Package version made of the register's OWN full-month amounts (paise kept, nothing rebuilt from the CTC):
// used by the salary-structure import (Full: columns) and scripts/payroll-from-register.js.
//   full = { basic, hra, conveyance, specialAllowance, bonus }   rule = the PF rule (or null)
function directStructure({ full, rule, monthlyCtc = null, baseCtc = null, cfg = {}, esiApplicable = null, tds = null, otherDeductions = 0 }) {
  const { esiFor } = require('./salaryVersions'); // lazy: salaryVersions never needs this file
  const { professionalTaxFor } = require('./salaryRules');
  const rr = rulesFrom(cfg || {});
  const cap = (v, c) => (c > 0 ? Math.min(v, c) : v);
  const basic = r2(full.basic); const hra = r2(full.hra); const conveyance = r2(full.conveyance);
  const specialAllowance = r2(full.specialAllowance); const bonus = r2(full.bonus);
  const gross = r2(basic + hra + conveyance + specialAllowance + bonus);
  const pfFull = fullMonthPf(rule, basic);
  const esi = esiFor(gross, cfg, esiApplicable);
  const ctc = monthlyCtc !== null && monthlyCtc !== undefined && Number(monthlyCtc) > 0 ? r2(Number(monthlyCtc) * 12)
    : (Number(baseCtc) > 0 ? Number(baseCtc) : r2(gross * 12));
  return {
    payMode: 'Package', ctc, stipend: 0, basic, hra, conveyance, specialAllowance, bonus,
    employeePf: pfFull !== null ? pfFull : Math.round(cap((basic * rr.employeePfPctOfBasic) / 100, rr.employeePfMonthlyCap)),
    employerPf: Math.round(cap((basic * rr.employerPfPctOfBasic) / 100, rr.employerPfMonthlyCap)),
    gratuity: Math.round((basic * rr.gratuityPctOfBasic) / 100),
    professionalTax: professionalTaxFor(gross),
    esiApplicable: esiApplicable === true || esiApplicable === false ? esiApplicable : null,
    esiEmployee: esi.employee, esiEmployer: esi.employer,
    tds: tds === null || tds === undefined || tds === '' ? null : Math.max(0, r2(tds)),
    otherDeductions: Math.max(0, r2(otherDeductions)),
  };
}

module.exports = {
  SETTING, ruleKey, r2, registerFrom, registerOn, isRegisterMonth, setRegisterFrom,
  cleanRule, parsePfRule, pfRuleText, pfRulesFor, pfRuleOf, setPfRule, fullMonthPf, rulesOf, earnedParts, directStructure,
};

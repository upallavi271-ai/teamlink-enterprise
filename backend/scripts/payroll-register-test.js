#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAY REGISTER TEST (founder 2026-10-28): the app's payroll = the team's Excel Pay Register, to the paisa.
//
//   cd backend && node scripts/payroll-register-test.js
//     PART 1 (pure, no database rows): the October 2026 register's 18 Group A packages + 17 stipends through the
//            engine's computeEntry in pay-register mode = the founder's expected numbers (every person, every column,
//            the totals 505,901.86 / 150,166.65 / 656,068.51); the edit screen's calculation gives the same and an
//            unedited record recalculates to itself; the browser copy agrees on random inputs; PF rule words;
//            the old (whole-rupee) mode is unchanged when the switch is off.
//     PART 2 (a VACUUM INTO copy of prisma/dev.db opened READ-ONLY, deleted afterwards; never the real one):
//            the founder's attendance sheet imports as it is (month = the open payroll month, file-name check);
//            scripts/payroll-from-register.js --apply on the copy = the expected numbers for all 35 people;
//            running it again changes nothing; every PAID month is unchanged; the edit screen shows no drift and
//            "Recalculate from attendance" finds nothing to change; the structure import's Full: columns /
//            PF rule round-trip and an older file without them still reads.
//   --pure                      PART 1 only
//   TL_TEST_DB=<file in prisma/> use that copy (it is NOT deleted)
//   PAY_REGISTER / PAY_ATTENDANCE = the two Excel files (default: payroll\Pay Register for Oct 2026.xlsx and
//   Downloads\To pavan sharing sheet Sep16-Oct15_update.xlsx); PART 2 is skipped when they are missing.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.join(BACK, 'prisma', 'dev.db');
const PURE = process.argv.includes('--pure');
const REG_FILE = process.env.PAY_REGISTER || path.resolve(BACK, '..', '..', 'payroll', 'Pay Register for Oct 2026.xlsx');
const ATT_FILE = process.env.PAY_ATTENDANCE || path.join(os.homedir(), 'Downloads', 'To pavan sharing sheet Sep16-Oct15_update.xlsx');

let copy = process.env.TL_TEST_DB ? path.join(BACK, 'prisma', process.env.TL_TEST_DB) : null;
let ownCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: TL_TEST_DB is the real database.'); process.exit(2); }
if (!PURE && !copy) {
  copy = path.join(os.tmpdir(), `payroll-register-test-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  ownCopy = true;
}
process.env.DATABASE_URL = `file:${(copy || path.join(os.tmpdir(), 'payroll-register-test-none.db')).split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${(copy || path.join(os.tmpdir(), 'payroll-register-test-none.db')).split(path.sep).join('/')}`;

const E = require('../src/utils/payrollEngine');
const REG = require('../src/utils/payrollRegister');
const PEdit = require('../src/utils/payrollEdit');
const { payrollCalc } = require('../src/utils/payrollCalc');

let pass = 0; let fail = 0;
const ok = (c, name, extra) => { if (c) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} ${extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''}`); } };
const eq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;

// ---- the October 2026 register (cycle 16 Sep - 15 Oct = 30 days) --------------------------------
const DAYS = 30;
const P24 = { mode: 'PCT', pct: 24 };
const fixed = (a) => ({ mode: 'FIXED', amount: a });
//            eid      basic    hra     conv  special  bonus    rule              tds  payable
const PKG = [
  ['TL063', 42500, 17000, 2500, 42450, 0, fixed(2380.64), 50, 30],
  ['TL309', 28000, 11200, 2500, 26500, 0, fixed(2380.64), 0, 29],
  ['TL312', 23333, 9333, 2500, 21367, 6667, fixed(2267), 0, 30],
  ['TL399', 28000, 11200, 2500, 26500, 0, fixed(2380.64), 0, 30],
  ['TL406', 19333, 7733, 2500, 16967, 6667, fixed(2043), 0, 30],
  ['TL410', 4400, 1760, 2500, 1403.68, 2500, P24, 0, 30],
  ['TL416', 4400, 1760, 2500, 1403.68, 2500, P24, 0, 29.5],
  ['TL432', 4400, 1760, 2500, 1403.68, 2500, P24, 0, 3],
  ['TL448', 5533.33, 2213.33, 2500, 2298.29, 6666.67, P24, 0, 30],
  ['TL451', 6533, 2613, 2500, 3282, 4167, P24, 0, 30],
  ['TL460', 6533.33, 2613.33, 2500, 3282.07, 4166.67, P24, 0, 30],
  ['TL473', 4400, 1760, 2500, 1404, 2500, P24, 0, 30],
  ['TL482', 8000, 3200, 2500, 5340, 5000, P24, 0, 29],
  ['TL306', 7533.33, 3013.33, 2500, 4882.67, 4166.67, P24, 0, 28],
  ['TL484', 6533.33, 2613.33, 2500, 3282.07, 4166.67, P24, 0, 19],
  ['TL102', 16000, 6400, 2500, 13300, 0, { mode: 'PCT', pct: 12 }, 0, 6],
  ['TL505', 4867, 1947, 2500, 1800, 3333, P24, 0, 30],
  ['TL424', 4867, 1947, 2500, 1800, 3333, P24, 0, 11],
];
const STIPEND = { TL470: 22, TL471: 30, TL474: 30, TL477: 28, TL480: 30, TL481: 30, TL492: 29.5, TL500: 30, TL508: 30, TL509: 28, TL510: 30, TL511: 30, TL518: 30, TL519: 18, TL520: 17, TL521: 16, TL517: 22 };
// the founder's expected results: payable, full gross, earned total, ESI, PF, PT, TDS, NET
const EXPECTED = {
  TL063: [30, 104450, 104450.00, 0, 2380.64, 200, 50, 101819.36], TL309: [29, 68200, 65926.68, 0, 2380.64, 200, 0, 63346.04],
  TL312: [30, 63200, 63200, 0, 2267, 200, 0, 60733.00], TL399: [30, 68200, 68200, 0, 2380.64, 200, 0, 65619.36],
  TL406: [30, 53200, 53200, 0, 2043, 200, 0, 50957.00], TL410: [30, 12563.68, 12563.68, 95, 1056.00, 0, 0, 11412.68],
  TL416: [29.5, 12563.68, 12354.29, 93, 1038.40, 0, 0, 11222.89], TL432: [3, 12563.68, 1256.37, 10, 105.60, 0, 0, 1140.77],
  TL448: [30, 19211.62, 19211.62, 145, 1328.00, 150, 0, 17588.62], TL451: [30, 19095, 19095, 144, 1567.92, 150, 0, 17233.08],
  TL460: [30, 19095.4, 19095.4, 144, 1568.00, 150, 0, 17233.40], TL473: [30, 12564, 12564, 95, 1056, 0, 0, 11413.00],
  TL482: [29, 24040, 23238.66, 0, 1856.00, 200, 0, 21182.66], TL306: [28, 22096, 20622.93, 0, 1687.47, 200, 0, 18735.46],
  TL484: [19, 19095.4, 12093.75, 91, 993.07, 0, 0, 11009.68], TL102: [6, 38200, 7640.00, 0, 384.00, 0, 0, 7256.00],
  TL505: [30, 14447, 14447, 109, 1168.08, 0, 0, 13169.92], TL424: [11, 14447, 5297.24, 40, 428.30, 0, 0, 4828.94],
};
const TOTAL_A = 505901.86; const TOTAL_S = 150166.65; const TOTAL = 656068.51;
const policy = { esiEnabled: true, esiGrossCeiling: 21000, esiEmployeePct: 0.75, esiEmployerPct: 3.25, tdsDefaultPctOfGross: 0, employeePfPctOfBasic: 12, employerPfPctOfBasic: 12, employeePfMonthlyCap: 1800, employerPfMonthlyCap: 1800, gratuityPctOfBasic: 4.81 };
const att = (payable) => ({ workingDays: DAYS, daysPresent: payable, daysLop: DAYS - payable });

function part1() {
  console.log('--- PART 1: the engine in pay-register mode = the October 2026 register');
  let netA = 0; let netS = 0; const records = [];
  PKG.forEach(([eid, basic, hra, conveyance, specialAllowance, bonus, rule, tds, payable]) => {
    const version = REG.directStructure({ full: { basic, hra, conveyance, specialAllowance, bonus }, rule, cfg: policy, tds });
    const r = E.computeEntry({ version, att: att(payable), policy, incentive: 0, register: { pfRule: rule } });
    const x = EXPECTED[eid];
    const got = [DAYS - r.daysLop, r.grossPay, r.earnedGross, r.esiEmployee, r.pfEmployee, r.professionalTax, r.tds, r.netPay];
    ok(got.every((v, i) => eq(v, x[i])), `R01 ${eid}: payable ${x[0]}, gross ${x[1]}, earned ${x[2]}, ESI ${x[3]}, PF ${x[4]}, PT ${x[5]}, TDS ${x[6]}, net ${x[7]}`, { got, x });
    netA += r.netPay; records.push({ version, rule, r, payable });
  });
  Object.entries(STIPEND).forEach(([eid, payable]) => {
    const version = { payMode: 'Stipend', stipend: 10000, esiApplicable: null, tds: null, otherDeductions: 0 };
    const r = E.computeEntry({ version, att: att(payable), policy, incentive: 0, register: { pfRule: null } });
    const want = REG.r2((10000 * payable) / DAYS);
    ok(eq(r.netPay, want) && r.esiEmployee === 0 && r.pfEmployee === 0 && r.professionalTax === 0 && r.tds === 0, `R02 stipend ${eid}: ${payable} days -> ${want} (no PF / ESI / PT / TDS)`, r);
    netS += r.netPay; records.push({ version, rule: null, r, payable });
  });
  ok(eq(netA, TOTAL_A), `R03 Group A total net = ${TOTAL_A}`, REG.r2(netA));
  ok(eq(netS, TOTAL_S), `R04 Stipend total net = ${TOTAL_S}`, REG.r2(netS));
  ok(eq(netA + netS, TOTAL), `R05 grand total = ${TOTAL}`, REG.r2(netA + netS));

  // the edit screen: an unedited record recalculates to itself (components of the stored record -> the same figures)
  let selfOk = true; let bad = null;
  records.forEach(({ version, rule, r }) => {
    const entry = { ...r, payMode: r.payMode, arrears: 0, month: '2026-10' };
    const rules = PEdit.rulesFromVersion(version, policy, r.payMode, { pfRule: rule });
    const c = PEdit.componentsOf(entry, null);
    const drift = PEdit.driftOf(c, rules);
    const k = payrollCalc({ ...c, manual: {} }, rules);
    const same = ['grossPay', 'lopDeduction', 'earnedGross', 'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'totalDeductions', 'netPay', 'pfEmployer', 'esiEmployer', 'gratuity'].every((f) => k[f] === r[f]);
    if (!same || Object.keys(drift).length) { selfOk = false; bad = bad || { r, k, drift }; }
  });
  ok(selfOk, 'R06 every unedited record recalculates to itself on the edit screen (no drift, same totals)', bad);

  // a typed change on the edit screen keeps paise and the identities
  const one = records[6]; // TL416, 29.5 days
  const rules416 = PEdit.rulesFromVersion(one.version, policy, 'Package', { pfRule: one.rule });
  const c416 = { ...PEdit.componentsOf({ ...one.r, arrears: 0 }, null), manual: {} };
  const more = payrollCalc({ ...c416, extraEarn: [500.5] }, rules416);
  ok(eq(more.grossPay, one.r.grossPay + 500.5) && eq(more.netPay, more.grossPay - more.totalDeductions) && eq(more.earnedGross, more.grossPay - more.lopDeduction), 'R07 an added earning of 500.50 is kept to the paisa; net = gross - deductions', more);
  const lessDays = payrollCalc({ ...c416, daysLop: 2 }, rules416);
  ok(eq(lessDays.pfEmployee, REG.r2(REG.r2((4400 * 28) / 30) * 0.24)) && eq(lessDays.earnedGross, REG.r2(REG.r2((4400 * 28) / 30) + REG.r2((1760 * 28) / 30) + REG.r2((2500 * 28) / 30) + REG.r2((1403.68 * 28) / 30) + REG.r2((2500 * 28) / 30))), 'R08 2 LOP days on the edit screen: earned parts and 24% PF follow (paise)', lessDays);
  const fixedRules = PEdit.rulesFromVersion(records[1].version, policy, 'Package', { pfRule: records[1].rule });
  ok(payrollCalc({ ...PEdit.componentsOf({ ...records[1].r, arrears: 0 }, null), daysLop: 10, manual: {} }, fixedRules).pfEmployee === 2380.64, 'R09 a FIXED PF is not reduced by LOP days', null);
  ok(payrollCalc({ ...PEdit.componentsOf({ ...records[1].r, arrears: 0 }, null), daysLop: 30, manual: {} }, fixedRules).pfEmployee === 0, 'R10 no PF when nothing is earned (0 payable days)', null);
  // PT is the slab on the earned total, never capped by the structure's stored PT
  const lowPt = REG.rulesOf({ ...records[1].version, professionalTax: 0 }, policy, 'Package', records[1].rule);
  ok(payrollCalc({ ...PEdit.componentsOf({ ...records[1].r, arrears: 0 }, null), manual: {} }, lowPt).professionalTax === 200, 'R11 PT = slab on the earned total (a stored PT of 0 does not cap it)', null);

  // PF rule words
  ok(JSON.stringify(REG.parsePfRule('24% of earned basic').rule) === JSON.stringify({ mode: 'PCT', pct: 24 }), 'R12 "24% of earned basic" -> 24% rule', null);
  ok(JSON.stringify(REG.parsePfRule('12% of earned basic').rule) === JSON.stringify({ mode: 'PCT', pct: 12 }), 'R13 "12% of earned basic" -> 12% rule', null);
  ok(JSON.stringify(REG.parsePfRule('Fixed (same as last month)', 2380.64).rule) === JSON.stringify({ mode: 'FIXED', amount: 2380.64 }), 'R14 "Fixed (same as last month)" + 2380.64 -> fixed rule', null);
  ok(!!REG.parsePfRule('Fixed').error && !!REG.parsePfRule('half').error && REG.parsePfRule('Default').rule === null && REG.parsePfRule('').empty, 'R15 a Fixed rule without an amount / nonsense is refused; Default = the standard PF; blank = keep', null);
  ok(REG.r2(1.005) === 1.01 && REG.r2(27066.665) === 27066.67 && REG.r2(-2.345) === -2.35 && REG.r2(1038.4008) === 1038.4, 'R16 rounding = Excel ROUND(x, 2)', null);

  // switch off = the old whole-rupee engine, unchanged
  const oldV = { payMode: 'Package', basic: 10000, hra: 4000, bonus: 1000, specialAllowance: 8319, conveyance: 0, employeePf: 1200, employerPf: 1200, gratuity: 481, professionalTax: 200, esiApplicable: null, tds: null, otherDeductions: 0 };
  const o = E.computeEntry({ version: oldV, att: { workingDays: 26, daysPresent: 24, daysLop: 2 }, policy, incentive: 0 });
  ok(o.lopDeduction === 1794 && o.pfEmployee === 1108 && o.netPay === 23319 - (1794 + 1108 + 200), 'R17 without the switch the engine is the old whole-rupee one (LOP 1,794, PF 1,108)', o);
  ok(REG.registerOn('2026-10', '2026-10') && REG.registerOn('2027-01', '2026-10') && !REG.registerOn('2026-09', '2026-10') && !REG.registerOn('2026-10', null), 'R18 the register rules apply from the switch month on, never before, never without the setting', null);
}

// browser copy of the calculation: same numbers in register mode on random inputs
async function feCheck() {
  const FEND = fs.readFileSync(path.join(BACK, '..', 'frontend', 'src', 'utils', 'payrollCalc.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), `payrollCalc-fe-reg-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, FEND);
  const fe = await import(`file:///${tmp.replace(/\\/g, '/')}`);
  const rnd = (n) => Math.floor(Math.random() * n);
  let same = true; let bad = null; let identities = true;
  for (let i = 0; i < 500; i += 1) {
    const version = { payMode: rnd(5) ? 'Package' : 'Stipend', basic: rnd(4000000) / 100, hra: rnd(1500000) / 100, conveyance: 2500, specialAllowance: rnd(2000000) / 100, bonus: rnd(700000) / 100, stipend: 10000, employeePf: rnd(3000), employerPf: 1800, gratuity: 500, tds: rnd(3) ? null : rnd(500), esiApplicable: null };
    const rule = [null, { mode: 'PCT', pct: 24 }, { mode: 'PCT', pct: 12 }, { mode: 'FIXED', amount: rnd(300000) / 100 }][rnd(4)];
    const rules = REG.rulesOf(version, policy, version.payMode, rule);
    const comp = { workingDays: 28 + rnd(4), daysLop: rnd(57) / 2, basic: version.basic, hra: version.hra, conveyance: version.conveyance, specialAllowance: version.specialAllowance, bonus: version.bonus, stipend: version.stipend, incentive: rnd(2) ? rnd(300000) / 100 : 0, arrears: 0, extraEarn: [rnd(100000) / 100], extraDed: [rnd(50000) / 100], otherDeductions: 0, loan: rnd(2) ? rnd(80000) / 100 : 0, manual: rnd(3) ? {} : { pfEmployee: true }, pfEmployee: rnd(200000) / 100 };
    const a = payrollCalc(comp, rules); const b = fe.payrollCalc(comp, rules);
    if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; bad = { a, b }; break; }
    const paise = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
    if (!eq(a.netPay, a.grossPay - a.totalDeductions) || !eq(a.earnedGross, a.grossPay - a.lopDeduction) || !['netPay', 'grossPay', 'earnedGross', 'pfEmployee', 'totalDeductions'].every((k) => paise(a[k]))) { identities = false; bad = a; break; }
  }
  fs.unlinkSync(tmp);
  ok(same, 'R19 the browser copy gives the same pay-register numbers as the server on 500 random inputs', bad);
  ok(identities, 'R20 identities hold in pay-register mode (net = gross - deductions, earned = gross - LOP)', bad);
}

// ---- PART 2: the real data, on a copy ----------------------------------------------------------------
async function part2() {
  console.log(`--- PART 2: on a copy of the database (${copy})`);
  if (!fs.existsSync(REG_FILE) || !fs.existsSync(ATT_FILE)) { console.log(`SKIP part 2: ${!fs.existsSync(REG_FILE) ? REG_FILE : ATT_FILE} not found`); return; }
  const prisma = require('../src/db');
  const io = require('../src/utils/moduleIo');
  const attSpec = require('../src/io/payroll-attendance');
  const salSpec = require('../src/io/payroll-salary');
  const { resolveIdentity } = require('../src/utils/identity');
  const XLSX = require('xlsx');
  const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, orderBy: { createdAt: 'asc' } });
  const user = await resolveIdentity(sa.id);
  const ctx = { req: { user }, user };
  const paidBefore = await prisma.employeePayrollRun.findMany({ where: { month: { lt: '2026-10' } }, orderBy: [{ month: 'asc' }, { employeeId: 'asc' }] });
  const snap = (rows) => JSON.stringify(rows.map(({ updatedAt, ...x }) => x));

  // the founder's attendance sheet, uploaded as it is (before the script)
  const buf = fs.readFileSync(ATT_FILE);
  const parsed = io.parseFile(attSpec, buf, path.basename(ATT_FILE));
  ok(!parsed.error && parsed.rows.length === 35 && parsed.otherShape, 'R21 the team\'s own attendance sheet is read (35 rows, no sample header needed)', parsed.error || parsed.rows && parsed.rows.length);
  if (!parsed.error) {
    const v = await attSpec.validate(parsed.rows, ctx);
    const bad = v.filter((x) => x.errors && x.errors.length);
    const r416 = v.find((x) => x.data && x.data.employee.employeeCode === 'TL416');
    ok(!bad.length && v.every((x) => x.data && x.data.month === '2026-10'), 'R22 every row is for the open payroll month (October 2026) with no error', bad.slice(0, 3));
    ok(r416 && r416.data.workingDays === 30 && r416.data.daysPresent === 29.5 && r416.data.daysLop === 0.5, 'R23 TL416: payroll days 30, present 29.5, LOP 0.5 (= Non Payable Days)', r416 && r416.data);
    const wrong = io.parseFile(attSpec, buf, 'To pavan sharing sheet Oct16-Nov15.xlsx');
    const wv = await attSpec.validate(wrong.rows, ctx);
    ok(wv.every((x) => x.errors && x.errors.some((e) => e.field === 'Month' && /November/.test(e.message))), 'R24 a sheet whose file name is for another month (Oct16-Nov15) is refused in plain words', wv[0] && wv[0].errors);
    const applied = await attSpec.apply(v.filter((x) => !x.errors.length && ['create', 'update'].includes(x.action)), ctx);
    ok(applied.created + applied.updated === 35 && !applied.failed.length, 'R25 importing the sheet writes the 35 payroll-day rows', applied);
  }

  const script = path.join(__dirname, 'payroll-from-register.js');
  const args = ['--register', REG_FILE, '--attendance', ATT_FILE, '--month', '2026-10', '--db', copy, '--apply', '--out', path.join(os.tmpdir(), `payroll-register-test-out-${Date.now().toString(36)}`)];
  const run1 = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TL_ALLOW_REAL_APPLY: '' } });
  ok(run1.status === 0 && /Every record equals the register to the paisa/.test(run1.stdout), 'R26 scripts/payroll-from-register.js --apply on the copy: every record equals the register', (run1.stdout || '').slice(-1500) + (run1.stderr || '').slice(-800));
  const entries = await prisma.employeePayrollRun.findMany({ where: { month: '2026-10' }, include: { employee: { select: { employeeCode: true } } } });
  const byCode = new Map(entries.map((e) => [e.employee.employeeCode, e]));
  let allOk = true; const diffs = [];
  Object.entries(EXPECTED).forEach(([eid, x]) => {
    const e = byCode.get(eid);
    const got = e ? [e.workingDays - e.daysLop, e.grossPay, e.earnedGross, e.esiEmployee, e.pfEmployee, e.professionalTax, e.tds, e.netPay] : null;
    if (!got || !got.every((v, i) => eq(v, x[i]))) { allOk = false; diffs.push({ eid, got, x }); }
  });
  Object.entries(STIPEND).forEach(([eid, payable]) => {
    const e = byCode.get(eid);
    if (!e || !eq(e.netPay, REG.r2((10000 * payable) / DAYS)) || e.payMode !== 'Stipend') { allOk = false; diffs.push({ eid, net: e && e.netPay }); }
  });
  ok(allOk && entries.length === 35, 'R27 the October 2026 run in the app = the founder\'s expected numbers for all 18 Group A + 17 stipend people', diffs);
  const sum = (list) => REG.r2(list.reduce((n, e) => n + e.netPay, 0));
  const A = entries.filter((e) => e.payMode !== 'Stipend'); const S = entries.filter((e) => e.payMode === 'Stipend');
  ok(eq(sum(A), TOTAL_A) && eq(sum(S), TOTAL_S) && eq(sum(entries), TOTAL), `R28 totals: Group A ${sum(A)}, Stipend ${sum(S)}, all ${sum(entries)}`, null);
  const run = await prisma.payrollRun.findUnique({ where: { month: '2026-10' } });
  ok(run && eq(run.totalNet, TOTAL) && run.employees === 35, 'R29 the month\'s run row carries the same total', run);

  const before2 = snap(await prisma.employeePayrollRun.findMany({ where: { month: '2026-10' }, orderBy: { employeeId: 'asc' } }).then((r) => r.map(({ calculatedAt, ...x }) => x)));
  const counts = async () => JSON.stringify(await Promise.all([prisma.salaryStructureVersion.count(), prisma.payrollAttendance.count(), prisma.appSetting.count()]));
  const c1 = await counts();
  const run2 = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TL_ALLOW_REAL_APPLY: '' } });
  const after2 = snap(await prisma.employeePayrollRun.findMany({ where: { month: '2026-10' }, orderBy: { employeeId: 'asc' } }).then((r) => r.map(({ calculatedAt, ...x }) => x)));
  ok(run2.status === 0 && /"versionsCreated":0,"versionsUpdated":0,"versionsSame":35/.test(run2.stdout) && /"attendanceWritten":0/.test(run2.stdout) && before2 === after2 && c1 === await counts(), 'R30 running the script again changes nothing (same versions, days, records, settings)', (run2.stdout || '').slice(-600));
  const paidAfter = await prisma.employeePayrollRun.findMany({ where: { month: { lt: '2026-10' } }, orderBy: [{ month: 'asc' }, { employeeId: 'asc' }] });
  ok(paidBefore.length > 0 && snap(paidBefore) === snap(paidAfter), `R31 every earlier (paid / imported) month is unchanged (${paidBefore.length} records)`, null);

  // the edit screen + "Recalculate from attendance" on the real October records
  let drift = 0; let notSame = 0; const ex = [];
  for (const e of entries) {
    const full = await prisma.employeePayrollRun.findUnique({ where: { id: e.id }, include: { employee: true } });
    const p = await PEdit.editorPayload(full, { edit: true });
    const res = payrollCalc({ ...p.components, extraEarn: [], extraDed: [] }, p.rules);
    if (p.drift.length || !eq(res.netPay, full.netPay) || !eq(res.totalDeductions, full.totalDeductions)) { drift += 1; ex.push({ code: e.employee.employeeCode, drift: p.drift, net: [res.netPay, full.netPay] }); }
    const cmp = await PEdit.engineCompare(full);
    if (!cmp.same) { notSame += 1; ex.push({ code: e.employee.employeeCode, changes: cmp.changes }); }
  }
  ok(!drift, 'R32 the edit screen opens every October record with no drift and the same totals', ex.slice(0, 3));
  ok(!notSame, 'R33 "Recalculate from attendance" finds nothing to change on any October record', ex.slice(0, 3));

  // structure import: Full: columns + PF rule
  const labels = salSpec.columns.map((c) => c.label);
  const sheet = (rows, cols = labels) => {
    const ws = XLSX.utils.aoa_to_sheet([cols, ...rows.map((r) => cols.map((l) => (r[l] === undefined ? '' : r[l])))]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Salary structures');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const same448 = { 'Employee ID': 'TL448', 'Effective From': '2026-10', 'Full: Basic': 5533.33, 'Full: HRA': 2213.33, 'Full: Conveyance': 2500, 'Full: Special': 2298.29, 'Full: Performance Bonus': 6666.67, 'Full: Monthly Bonus': 0, 'PF rule': '24% of earned basic', 'TDS (monthly)': 0, 'Monthly CTC': 20000 };
  const p1 = io.parseFile(salSpec, sheet([same448]), 's.xlsx');
  const v1 = await salSpec.validate(p1.rows, ctx);
  ok(!p1.error && v1[0].action === 'nochange', 'R34 the register\'s own Full: amounts + PF rule for October = what the script stored (nothing to change)', p1.error || v1[0]);
  const nov = { ...same448, 'Effective From': '2026-11', 'Full: Basic': 6000, 'PF rule': '', 'TDS (monthly)': '' };
  const v2 = await salSpec.validate(io.parseFile(salSpec, sheet([nov]), 's.xlsx').rows, ctx);
  ok(v2[0].action === 'create' && v2[0].changes.some((c) => c.field === 'Basic' && Number(c.to) === 6000), 'R35 a November revision with Full: Basic 6,000 is a new version', v2[0]);
  const a2 = await salSpec.apply(v2.filter((x) => x.action === 'create'), ctx);
  const nv = await prisma.salaryStructureVersion.findFirst({ where: { employee: { employeeCode: 'TL448' }, effectiveFrom: '2026-11-01' } });
  const nrule = nv ? await REG.pfRuleOf(nv.id) : null;
  ok(a2.created === 1 && nv && nv.basic === 6000 && nv.hra === 2213.33 && nv.conveyance === 2500 && nrule && nrule.mode === 'PCT' && nrule.pct === 24 && nv.employeePf === 1440, 'R36 it is stored as given (paise kept, conveyance kept) and the 24% PF rule carries on', { nv, nrule });
  const fixedRow = { 'Employee ID': 'TL448', 'Effective From': '2026-12', 'PF rule': 'Fixed', 'PF fixed amount': 1500 };
  const v3 = await salSpec.validate(io.parseFile(salSpec, sheet([fixedRow]), 's.xlsx').rows, ctx);
  await salSpec.apply(v3.filter((x) => x.action === 'create'), ctx);
  const dv = await prisma.salaryStructureVersion.findFirst({ where: { employee: { employeeCode: 'TL448' }, effectiveFrom: '2026-12-01' } });
  const drule = dv ? await REG.pfRuleOf(dv.id) : null;
  ok(dv && dv.basic === 6000 && dv.conveyance === 2500 && drule && drule.mode === 'FIXED' && drule.amount === 1500, 'R37 a row with only "PF rule: Fixed 1,500" keeps the amounts (conveyance too) and sets the fixed PF', { dv, drule });
  const oldCols = labels.filter((l) => !/^Full: |^PF rule$|^PF fixed amount$/.test(l));
  const p4 = io.parseFile(salSpec, sheet([{ 'Employee ID': 'TL448', 'Effective From': '2026-12' }], oldCols), 'old.xlsx');
  ok(!p4.error, 'R38 an older salary-structure file without the new columns still reads', p4.error);
  const badRule = await salSpec.validate(io.parseFile(salSpec, sheet([{ ...fixedRow, 'Effective From': '2027-01', 'PF rule': 'Fixed', 'PF fixed amount': '' }]), 's.xlsx').rows, ctx);
  ok(badRule[0].action === 'error' && badRule[0].errors.some((e) => e.field === 'PF rule'), 'R39 "Fixed" without the amount is refused in plain words', badRule[0].errors);
  await prisma.$disconnect();
}

(async () => {
  try {
    part1();
    await feCheck();
    if (!PURE) await part2();
  } catch (err) {
    fail += 1; console.log('FAIL crashed', err && err.stack ? err.stack.slice(0, 1500) : err);
  } finally {
    if (ownCopy) ['', '-wal', '-shm', '-journal'].forEach((x) => { try { fs.unlinkSync(copy + x); } catch { /* gone */ } });
    console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();

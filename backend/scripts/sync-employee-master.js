#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EMPLOYEE MASTER SYNC — "Active Employee with all details" workbook.
//
//   node scripts/sync-employee-master.js <file.xlsx> --out <dir>            (dry run: PLAN only)
//   node scripts/sync-employee-master.js <file.xlsx> --out <dir> --apply    (backup + apply + re-plan)
//
// WHAT IT READS: the sheet "Total Employees" and nothing else. Every other
// sheet in that workbook (passwords, access cards, stationery …) is never
// opened. Of that sheet it reads a WHITELIST of columns only — Salary is not
// on it and is never read, printed or stored.
//
// THE RULES
//   * Employee ID (trimmed, upper-cased) is the key, and the NAME must agree
//     (token compare that tolerates order, initials and small spelling
//     differences). ID matches but the name clearly differs -> not touched,
//     listed as an ID/name mismatch.
//   * No Employee ID -> listed, never guessed. IDs only in the file -> listed,
//     never created. Duplicate IDs in the file -> used only if every copy agrees.
//   * Department / Designation / Division / User Role / Assign Team and
//     every role / permission stay exactly as Employee Management has them.
//   * A file value wins only when it is non-empty and valid; an empty cell
//     never blanks anything.
//   * Employee.email is only FILLED when blank (never changed — it is what a
//     login is created from); User.email is never touched. Differences are
//     reported.
//   * Status: Termination / Resignation / Dropout -> Relieved (the app's exit
//     status); Active -> Active. Exactly what the app's own history import
//     does: no F&F request, no approval chain, no login change, no email.
//   * Every changed employee gets one audit row per changed field
//     (Employee -> History tab shows it).
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

process.chdir(path.join(__dirname, '..'));
// eslint-disable-next-line import/no-extraneous-dependencies
require('dotenv').config();
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');

const SHEET = 'Total Employees';
const SOURCE_LABEL = 'Active Employee with all details _new (1).xlsx';
const ACTOR = 'Employee master sync (spreadsheet)';
const ACTION = 'Employee master synced from spreadsheet';

// The ONLY columns read. Salary is deliberately absent.
const COLS = {
  id: 'Employee ID',
  name: 'First Name',
  status: 'status',
  doj: 'Date Of Joining',
  dor: 'Date of Relieving',
  mobile: 'Personal Mobile Number',
  emergency: 'Emergency Mobile Number',
  blood: 'Blood Group',
  personalMail: 'Personal Mail Id',
  officeMail: 'Office Mail Id',
  dob: 'Date Of Birth',
  round1: '1 Round',
  round2: '2 Round',
  reasonLeft: 'Reason for left',
  qualification: 'Qualification',
  eduBranch: 'Branch',
  docs: 'Document Collection',
  percentage: 'Percentage',
  batch: 'Passout Batch',
  district: 'District',
};

const FIELD_LABEL = {
  employmentStatus: 'Employment status',
  dateOfJoining: 'Date of joining',
  dateOfBirth: 'Date of birth',
  phone: 'Mobile (personal)',
  emergencyContactPhone: 'Emergency contact phone',
  bloodGroup: 'Blood group',
  email: 'Email (filled — was blank)',
  district: 'District',
  educationDetails: 'Education details',
};

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const WORKING = ['Active', 'On Probation', 'Probation', 'Notice Period'];
const LEFT = ['Relieved', 'Exited', 'Exit Process'];
const FILE_EXIT = ['Termination', 'Resignation', 'Dropout'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------------------
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function validYmd(y, m, d) {
  if (!(y >= 1950 && y <= 2035 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, apl: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const fullYear = (y) => (y.length === 2 ? Number(y) + (Number(y) < 50 ? 2000 : 1900) : Number(y));
// Excel serial or "dd-mm-yyyy" / "dd/mm/yyyy" / "dd.mm.yyyy" / "yyyy-mm-dd",
// plus the month-name spellings in this file ("14_Feb_2023", "Nov/1/2023",
// "29-Apl-03"). Anything ambiguous or impossible ("12-21-2003") is refused.
function parseDate(v) {
  if (v == null || clean(v) === '') return { empty: true };
  if (typeof v === 'number') {
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    const out = validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    return out ? { value: out } : { invalid: String(v) };
  }
  const raw = clean(v);
  // One separator between parts, whatever was typed; a trailing service note
  // ("23-12-2022-5m") is not part of the date.
  const s = raw.replace(/\s+/g, '').replace(/[-/._]+/g, '-').replace(/-\d{1,2}m$/i, '');
  let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (m) {
    const out = validYmd(fullYear(m[3]), Number(m[2]), Number(m[1]));
    return out ? { value: out } : { invalid: raw };
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const out = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    return out ? { value: out } : { invalid: raw };
  }
  m = s.match(/^(\d{1,2})-([a-z]{3,4})[a-z]*-(\d{2}|\d{4})$/i); // 14-Feb-2023
  if (m && MONTHS[m[2].toLowerCase()]) {
    const out = validYmd(fullYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
    return out ? { value: out } : { invalid: raw };
  }
  m = s.match(/^([a-z]{3,4})[a-z]*-(\d{1,2})-(\d{4})$/i); // Nov-1-2023
  if (m && MONTHS[m[1].toLowerCase()]) {
    const out = validYmd(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
    return out ? { value: out } : { invalid: raw };
  }
  return { invalid: raw };
}
// A 10-digit Indian mobile. A cell holding two numbers ("9xxxxxxxxx/8xxxxxxxxx")
// gives the first one, and says so.
function parseMobile(v) {
  if (v == null || clean(v) === '') return { empty: true };
  const one = (x) => {
    let d = String(x).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : null;
  };
  const whole = one(typeof v === 'number' ? Math.round(v) : v);
  if (whole) return { value: whole };
  const parts = String(v).split(/[/,;]| or /i).map(one).filter(Boolean);
  if (parts.length) return { value: parts[0], note: `two numbers in the cell ("${clean(v)}") — the first was used` };
  return { invalid: clean(v) };
}
function parseBlood(v) {
  if (v == null || clean(v) === '') return { empty: true };
  let s = String(v).toUpperCase().replace(/[\s.()]/g, '');
  s = s.replace(/POSITIVE|POS|\+VE|VE\+|\+/g, '+').replace(/NEGATIVE|NEG|-VE|VE-|–|—|-/g, '-');
  s = s.replace(/^0/, 'O');
  const m = s.match(/^(AB|A|B|O)([+-])/);
  return m && BLOOD_GROUPS.includes(m[1] + m[2]) ? { value: m[1] + m[2] } : { invalid: clean(v) };
}
function parseEmail(v) {
  const s = clean(v).toLowerCase();
  if (!s) return { empty: true };
  return EMAIL_RE.test(s) ? { value: s } : { invalid: clean(v) };
}
function educationOf(r) {
  const q = clean(r.qualification);
  const br = clean(r.eduBranch);
  let pct = r.percentage;
  if (pct != null && clean(pct) !== '') {
    let n = Number(String(pct).replace('%', ''));
    if (Number.isFinite(n)) { if (n > 0 && n <= 1) n = Math.round(n * 1000) / 10; pct = `${n}%`; } else pct = clean(pct);
  } else pct = '';
  const batch = clean(r.batch);
  const head = [q, br ? `(${br})` : ''].filter(Boolean).join(' ');
  const parts = [head, pct, batch ? `Passout ${batch}` : ''].filter(Boolean);
  return parts.length ? { value: parts.join(' · ') } : { empty: true };
}

// --- names -----------------------------------------------------------------
// "PurnaChandra" -> "purna chandra": a capital inside a word starts a new one.
const tokens = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // A swapped pair of letters (sekhar / sekhra) is one slip, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}
function tokenMatch(a, b) {
  if (a === b) return 'exact';
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 'initial' : null;
  // "CH" for Chennamsetti / Chitturi — a two-letter abbreviation of a surname.
  if ((a.length === 2 && b.startsWith(a)) || (b.length === 2 && a.startsWith(b))) return 'initial';
  const tol = Math.max(a.length, b.length) >= 7 ? 2 : 1;
  if (Math.min(a.length, b.length) >= 4 && lev(a, b) <= tol) return 'fuzzy';
  return null;
}
// Adjacent tokens written as one word on the other side: "sai sree" ~ "saisri".
function mergeTokens(A, B) {
  const a = [...A];
  const b = [...B];
  for (let pass = 0; pass < 2; pass += 1) {
    const [X, Y] = pass === 0 ? [a, b] : [b, a];
    for (let i = 0; i < X.length - 1; i += 1) {
      const joined = X[i] + X[i + 1];
      if (!Y.includes(X[i]) && !Y.includes(X[i + 1]) && Y.some((y) => y.length >= 5 && tokenMatch(joined, y) && tokenMatch(joined, y) !== 'initial')) {
        X.splice(i, 2, joined);
      }
    }
  }
  return [a, b];
}
// exact | same (order/case/punctuation) | fuzzy | mismatch
function nameMatch(fileName, dbName) {
  const [A, B] = mergeTokens(tokens(fileName), tokens(dbName));
  if (!A.length || !B.length) return 'mismatch';
  if (A.join(' ') === B.join(' ')) return 'exact';
  if ([...A].sort().join(' ') === [...B].sort().join(' ')) return 'same';
  if (A.join('') === B.join('') || [...A].sort().join('') === [...B].sort().join('')) return 'same';
  // Every token of the shorter name pairs with a distinct token of the longer.
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  const used = new Set();
  let full = 0;
  let fuzzy = false;
  for (const t of S) {
    let best = -1;
    let kind = null;
    L.forEach((u, i) => {
      if (used.has(i) || best >= 0) return;
      const k = tokenMatch(t, u);
      if (k) { best = i; kind = k; }
    });
    if (best < 0) {
      // "PurnaChandra" vs "Purna Chandra": a token equal to two adjacent ones.
      const j = L.findIndex((u, i) => !used.has(i) && !used.has(i + 1) && L[i + 1] && u + L[i + 1] === t);
      if (j < 0) return 'mismatch';
      used.add(j); used.add(j + 1); full += 1; continue;
    }
    used.add(best);
    if (kind !== 'initial') full += 1;
    if (kind !== 'exact') fuzzy = true;
  }
  if (!full) return 'mismatch';
  return fuzzy || S.length !== L.length ? 'fuzzy' : 'same';
}

// ---------------------------------------------------------------------------
function readFile(file) {
  const wb = XLSX.readFile(file, { sheets: [SHEET] });
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`Sheet "${SHEET}" not found`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const head = grid[0].map((h) => clean(h).toLowerCase());
  const idx = {};
  Object.entries(COLS).forEach(([k, label]) => {
    const i = head.indexOf(label.toLowerCase());
    if (i < 0) throw new Error(`Column "${label}" not found`);
    idx[k] = i;
  });
  const rows = [];
  grid.slice(1).forEach((r, i) => {
    const o = { line: i + 2 };
    Object.entries(idx).forEach(([k, j]) => { o[k] = r[j]; });
    if (Object.keys(COLS).some((k) => clean(o[k]) !== '')) rows.push(o);
  });
  return rows;
}

const ymdOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const show = (f, v) => (v == null || v === '' ? '' : (['dateOfJoining', 'dateOfBirth'].includes(f) ? ymdOf(v) : String(v)));

async function buildPlan(prisma, file) {
  const rows = readFile(file);
  const employees = await prisma.employee.findMany({ include: { user: { select: { id: true, email: true, status: true } } } });
  const byCode = new Map(employees.map((e) => [clean(e.employeeCode).toUpperCase(), e]));

  const out = {
    fileRows: rows.length,
    noId: [], dupes: [], fileOnly: [], mismatch: [], fuzzy: [], invalid: [],
    emailDiff: [], statusChanges: [], statusKept: [], statusHeld: [], notes: [], changes: [], perEmployee: new Map(),
    matched: 0, dbOnly: [], statusMap: {}, relievingDates: [], noField: {},
  };

  // Each person's last day of recorded attendance, and the latest day any
  // attendance exists at all — the evidence a status flip is checked against.
  const lastDayOf = new Map();
  const agg = { by: ['employeeId'], _max: { date: true } };
  (await Promise.all([
    prisma.attendance.groupBy(agg), prisma.attendancePunch.groupBy(agg), prisma.attendanceHistory.groupBy(agg),
  ])).flat().forEach((g) => {
    const d = g._max && g._max.date;
    if (g.employeeId && d && d > (lastDayOf.get(g.employeeId) || '')) lastDayOf.set(g.employeeId, d);
  });
  const latestDay = [...lastDayOf.values()].sort().pop() || today();
  const cutoffDate = new Date(`${latestDay}T00:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  out.latestDay = latestDay;
  out.cutoff = cutoff;

  const groups = new Map();
  rows.forEach((r) => {
    const id = clean(r.id).replace(/\s+/g, '').toUpperCase();
    if (!id) { out.noId.push({ line: r.line, name: clean(r.name), status: clean(r.status), doj: parseDate(r.doj).value || clean(r.doj) }); return; }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  });

  const seenCodes = new Set();
  const todayYmd = today();
  for (const [id, list] of groups) {
    let r = list[0];
    if (list.length > 1) {
      const sig = (x) => JSON.stringify(Object.keys(COLS).map((k) => clean(x[k])));
      const agree = list.every((x) => sig(x) === sig(list[0]));
      out.dupes.push({
        id, lines: list.map((x) => x.line).join(', '), names: [...new Set(list.map((x) => clean(x.name)))].join(' | '), agree, ours: byCode.has(id) ? byCode.get(id).name : '(not in TeamLink)',
      });
      if (!agree) { if (byCode.has(id)) seenCodes.add(id); continue; }
    }
    const e = byCode.get(id);
    if (!e) {
      out.fileOnly.push({ line: r.line, id, name: clean(r.name), status: clean(r.status), doj: parseDate(r.doj).value || clean(r.doj) });
      continue;
    }
    seenCodes.add(id);
    const nm = nameMatch(r.name, e.name);
    if (nm === 'mismatch') {
      out.mismatch.push({ line: r.line, id, fileName: clean(r.name), dbName: e.name });
      continue;
    }
    if (nm === 'fuzzy') out.fuzzy.push({ line: r.line, id, fileName: clean(r.name), dbName: e.name });
    out.matched += 1;

    const data = {};
    let heldRow = false;
    const bad = (field, raw) => out.invalid.push({ line: r.line, id, name: e.name, field, value: raw });
    const offer = (field, parsed, current) => {
      if (parsed.invalid !== undefined) { bad(field, parsed.invalid); return; }
      if (parsed.empty) return;
      const cur = show(field, current);
      if (cur === parsed.value) return;
      // A held (stale) row does not get to move a joining date either.
      if (heldRow && cur && field === 'dateOfJoining') {
        out.notes.push({ id, name: e.name, note: `Date of joining kept at ${cur} (file ${parsed.value}) — the row's status was held` });
        return;
      }
      if (parsed.note) out.notes.push({ id, name: e.name, note: `${FIELD_LABEL[field] || field}: ${parsed.note}` });
      data[field] = { from: cur, to: parsed.value, kind: cur ? 'change' : 'fill' };
    };

    // --- status --------------------------------------------------------
    const fs0 = clean(r.status);
    const dor = parseDate(r.dor);
    if (fs0) {
      const cur = e.employmentStatus || 'Active';
      let target = cur;
      let note = '';
      if (fs0.toLowerCase() === 'active') {
        target = WORKING.includes(cur) ? cur : 'Active';
      } else if (FILE_EXIT.map((s) => s.toLowerCase()).includes(fs0.toLowerCase())) {
        if (LEFT.includes(cur)) target = cur === 'Exit Process' ? 'Relieved' : cur;
        else if (cur === 'Notice Period') {
          if (dor.value && dor.value <= todayYmd) target = 'Relieved';
          else { target = cur; note = `file says ${fs0}; still on notice (relieving date ${dor.value || 'not given'})`; }
        } else target = 'Relieved';
      } else bad('status', fs0);
      // THE ATTENDANCE ON FILE HAS THE LAST WORD ON A FLIP. A row that says
      // "left" for somebody still punching in, or "active" for somebody who
      // has not punched in for a month, is a stale row (a re-joiner's old
      // stint, a copy-paste) — it is held and listed, not applied.
      const last = lastDayOf.get(e.id) || '';
      let hold = '';
      if (target !== cur && target === 'Relieved' && WORKING.includes(cur)) {
        if (dor.value && last > dor.value) hold = `attendance on file up to ${last}, after the relieving date ${dor.value}`;
        else if (!dor.value && last >= cutoff) hold = `no relieving date, and attendance on file up to ${last}`;
      }
      if (target !== cur && target === 'Active' && LEFT.includes(cur)) {
        if (dor.value) hold = `file says Active but also gives a relieving date ${dor.value} (last attendance ${last || 'none'})`;
        else if (!last || last < cutoff) hold = `no attendance since ${last || 'ever'} (latest attendance data ${latestDay})`;
      }
      if (hold) {
        out.statusHeld.push({
          id, name: e.name, department: e.department, designation: e.designation, current: cur, file: fs0, wouldBe: target,
          relievingDate: dor.value || '', lastAttendance: last, login: e.user ? (e.user.status || 'Active') : 'No login', reason: hold,
        });
        heldRow = true;
        target = cur;
      }
      const key = `${fs0} -> ${target}${hold ? ' (held — see list)' : ''}`;
      out.statusMap[key] = (out.statusMap[key] || 0) + 1;
      if (note) out.statusKept.push({ id, name: e.name, current: cur, file: fs0, note });
      if (target !== cur) {
        data.employmentStatus = { from: cur, to: target, kind: 'change' };
        out.statusChanges.push({
          id, name: e.name, department: e.department, designation: e.designation, from: cur, to: target, fileStatus: fs0,
          relievingDate: dor.value || '', login: e.user ? (e.user.status || 'Active') : 'No login',
        });
      }
    }
    if (dor.value) out.relievingDates.push({ id, name: e.name, date: dor.value });
    else if (dor.invalid !== undefined) bad('Date of Relieving', dor.invalid);

    offer('dateOfJoining', parseDate(r.doj), e.dateOfJoining);
    offer('dateOfBirth', parseDate(r.dob), e.dateOfBirth);
    offer('phone', parseMobile(r.mobile), e.phone);
    offer('emergencyContactPhone', parseMobile(r.emergency), e.emergencyContactPhone);
    offer('bloodGroup', parseBlood(r.blood), e.bloodGroup);
    offer('district', clean(r.district) ? { value: clean(r.district) } : { empty: true }, e.district);
    offer('educationDetails', educationOf(r), e.educationDetails);

    // --- email: fill a blank only; report every difference --------------
    const office = parseEmail(r.officeMail);
    const personal = parseEmail(r.personalMail);
    if (office.invalid !== undefined) bad('Office Mail Id', office.invalid);
    if (personal.invalid !== undefined) bad('Personal Mail Id', personal.invalid);
    const cur = clean(e.email).toLowerCase();
    if (!cur) {
      const pick = office.value || personal.value;
      if (pick) data.email = { from: '', to: pick, kind: 'fill', note: office.value ? 'office mail' : 'personal mail (no office mail)' };
    } else if (office.value && office.value !== cur) {
      out.emailDiff.push({ id, name: e.name, employeeEmail: cur, loginEmail: e.user ? e.user.email : '', officeMail: office.value, personalMail: personal.value || '' });
    }

    // Columns with no home on the Employee record — counted, not stored.
    [['round1', '1 Round'], ['round2', '2 Round'], ['reasonLeft', 'Reason for left'], ['docs', 'Document Collection'],
      ['personalMail', 'Personal Mail Id (no separate column; used only to fill a blank email)'], ['dor', 'Date of Relieving']]
      .forEach(([k, label]) => { if (clean(r[k])) out.noField[label] = (out.noField[label] || 0) + 1; });

    if (Object.keys(data).length) {
      out.perEmployee.set(e.id, { employee: e, data });
      Object.entries(data).forEach(([field, c]) => out.changes.push({
        id, name: e.name, field, label: FIELD_LABEL[field] || field, from: c.from, to: c.to, kind: c.kind,
      }));
    }
  }
  out.dbOnly = employees.filter((e) => !seenCodes.has(clean(e.employeeCode).toUpperCase()))
    .map((e) => ({ id: e.employeeCode, name: e.name, status: e.employmentStatus, department: e.department }));
  return out;
}

function fieldCounts(plan) {
  const c = {};
  plan.changes.forEach((x) => {
    if (!c[x.field]) c[x.field] = { fill: 0, change: 0 };
    c[x.field][x.kind] += 1;
  });
  return c;
}

function writeReport(plan, dir, tag) {
  fs.mkdirSync(dir, { recursive: true });
  const counts = fieldCounts(plan);
  const L = [];
  L.push(`EMPLOYEE MASTER SYNC — ${tag} — ${new Date().toISOString()}`);
  L.push(`Source: ${SOURCE_LABEL}, sheet "${SHEET}" only. Salary column NOT read.`);
  L.push('');
  L.push(`File rows with data: ${plan.fileRows}`);
  L.push(`Matched by Employee ID + name: ${plan.matched} (of which fuzzy name matches: ${plan.fuzzy.length})`);
  L.push(`Employees with pending changes: ${plan.perEmployee.size}; field changes: ${plan.changes.length}`);
  L.push(`ID/name mismatch (not updated): ${plan.mismatch.length}`);
  L.push(`No Employee ID in file (not updated): ${plan.noId.length}`);
  L.push(`IDs only in the file (NOT created): ${plan.fileOnly.length}`);
  L.push(`Records only in Employee Management: ${plan.dbOnly.length}`);
  L.push(`Duplicate IDs in the file: ${plan.dupes.length}`);
  L.push(`Invalid values skipped: ${plan.invalid.length}`);
  L.push(`Status changes applied: ${plan.statusChanges.length}; status flips held for your decision: ${plan.statusHeld.length}`);
  L.push('');
  L.push('Per field (fill = was blank, change = old -> new):');
  Object.entries(counts).forEach(([f, v]) => L.push(`  ${FIELD_LABEL[f] || f}: fill ${v.fill}, change ${v.change}`));
  L.push('');
  L.push('Status mapping (file -> app), matched rows:');
  Object.entries(plan.statusMap).sort().forEach(([k, v]) => L.push(`  ${k}: ${v}`));
  L.push('');
  L.push(`Status CHANGES (${plan.statusChanges.length}):`);
  plan.statusChanges.forEach((s) => L.push(`  ${s.id} ${s.name} [${s.department || '-'} / ${s.designation || '-'}]: ${s.from} -> ${s.to} (file: ${s.fileStatus}${s.relievingDate ? `, relieved ${s.relievingDate}` : ''}; login: ${s.login})`));
  L.push('');
  L.push(`Status flips HELD — file contradicts the attendance on file (latest attendance day ${plan.latestDay}; 30-day window from ${plan.cutoff}) (${plan.statusHeld.length}):`);
  plan.statusHeld.forEach((s) => L.push(`  ${s.id} ${s.name} [${s.department || '-'} / ${s.designation || '-'}]: stays ${s.current} (file ${s.file} would make it ${s.wouldBe}) — ${s.reason}; login: ${s.login}`));
  if (plan.statusKept.length) {
    L.push('Status kept on purpose:');
    plan.statusKept.forEach((s) => L.push(`  ${s.id} ${s.name}: ${s.current} — ${s.note}`));
  }
  L.push('');
  L.push(`ID/name mismatch (${plan.mismatch.length}):`);
  plan.mismatch.forEach((m) => L.push(`  row ${m.line} ${m.id}: file "${m.fileName}" vs ours "${m.dbName}"`));
  L.push(`Fuzzy name matches — updated, please eyeball (${plan.fuzzy.length}):`);
  plan.fuzzy.forEach((m) => L.push(`  ${m.id}: file "${m.fileName}" ~ ours "${m.dbName}"`));
  L.push('');
  L.push(`No Employee ID (${plan.noId.length}):`);
  plan.noId.forEach((m) => L.push(`  row ${m.line} ${m.name || '(no name)'} — ${m.status || '-'} — DOJ ${m.doj || '-'}`));
  L.push('');
  L.push(`IDs only in the file — not created (${plan.fileOnly.length}):`);
  plan.fileOnly.forEach((m) => L.push(`  row ${m.line} ${m.id} ${m.name} — ${m.status || '-'} — DOJ ${m.doj || '-'}`));
  L.push('');
  L.push(`Only in Employee Management (${plan.dbOnly.length}):`);
  plan.dbOnly.forEach((m) => L.push(`  ${m.id} ${m.name} — ${m.status} — ${m.department || '-'}`));
  L.push('');
  L.push(`Duplicate IDs in the file (${plan.dupes.length}):`);
  plan.dupes.forEach((d) => L.push(`  ${d.id} rows ${d.lines}: ${d.names} (ours: ${d.ours}) — ${d.agree ? 'copies agree, used once' : 'copies DISAGREE, not used'}`));
  L.push('');
  L.push(`Office mail differs from Employee email — NOT changed (${plan.emailDiff.length}):`);
  plan.emailDiff.forEach((d) => L.push(`  ${d.id} ${d.name}: ours ${d.employeeEmail}${d.loginEmail ? ` (login ${d.loginEmail})` : ''} vs file ${d.officeMail}`));
  L.push('');
  L.push(`Notes (${plan.notes.length}):`);
  plan.notes.forEach((n) => L.push(`  ${n.id} ${n.name}: ${n.note}`));
  L.push('');
  L.push(`Invalid values skipped (${plan.invalid.length}):`);
  plan.invalid.forEach((d) => L.push(`  row ${d.line} ${d.id} ${d.name}: ${d.field} = "${d.value}"`));
  L.push('');
  L.push('Columns with no field on the Employee record (not stored), non-empty on matched rows:');
  Object.entries(plan.noField).forEach(([k, v]) => L.push(`  ${k}: ${v}`));
  L.push('  Division / Department / Designation / User Role / Assign Team: kept from Employee Management by rule.');
  L.push('  Branch (it is the academic branch — CSE, Civil …): folded into Education details, NOT the office branch.');
  L.push('  Salary: SKIPPED — never read. Needs your explicit OK.');
  const txt = path.join(dir, `employee-sync-${tag}.txt`);
  fs.writeFileSync(txt, L.join('\n'));

  const wb = XLSX.utils.book_new();
  const add = (name, list) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(list.length ? list : [{ note: 'none' }]), name);
  add('Summary', L.slice(0, 40).map((line) => ({ line })));
  add('Changes', plan.changes);
  add('Status changes', plan.statusChanges);
  add('Status held', plan.statusHeld);
  add('Notes', plan.notes);
  add('ID-name mismatch', plan.mismatch);
  add('Fuzzy name matches', plan.fuzzy);
  add('No Employee ID', plan.noId);
  add('File-only IDs', plan.fileOnly);
  add('Only in TeamLink', plan.dbOnly);
  add('Duplicate IDs', plan.dupes);
  add('Email differences', plan.emailDiff);
  add('Invalid values', plan.invalid);
  add('Relieving dates (no field)', plan.relievingDates);
  const xlsx = path.join(dir, `employee-sync-${tag}.xlsx`);
  XLSX.writeFile(wb, xlsx);
  return { txt, xlsx, counts };
}

function toDbValue(field, v) {
  if (field === 'dateOfJoining' || field === 'dateOfBirth') return new Date(`${v}T00:00:00.000Z`);
  return v;
}

async function apply(prisma, plan) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(process.cwd(), 'backups', `dev.db.before-employee-master-sync.${stamp}`).replace(/\\/g, '/');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${backup}'`);
  console.log('Backup:', backup);
  const list = [...plan.perEmployee.values()];
  await prisma.$transaction(async (tx) => {
    for (const { employee, data } of list) {
      const patch = {};
      Object.entries(data).forEach(([f, c]) => { patch[f] = toDbValue(f, c.to); });
      // eslint-disable-next-line no-await-in-loop
      await tx.employee.update({ where: { id: employee.id }, data: patch });
      // eslint-disable-next-line no-await-in-loop
      await tx.auditLog.createMany({
        data: Object.entries(data).map(([f, c]) => ({
          action: ACTION,
          entity: 'Employee',
          entityId: employee.id,
          field: f,
          fieldLabel: FIELD_LABEL[f] || f,
          fromValue: c.from || '',
          toValue: String(c.to),
          actorName: ACTOR,
          reason: `From ${SOURCE_LABEL} (sheet ${SHEET}) — ${c.kind === 'fill' ? 'filled a blank' : 'file value replaced ours'}`,
        })),
      });
    }
  }, { timeout: 120000, maxWait: 20000 });
  return { backup, employees: list.length };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
  const outDir = args[args.indexOf('--out') + 1];
  if (!file || !outDir || args.indexOf('--out') < 0) {
    console.error('usage: node scripts/sync-employee-master.js <file.xlsx> --out <dir> [--apply]');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const plan = await buildPlan(prisma, file);
    const r = writeReport(plan, outDir, args.includes('--apply') ? 'plan-before-apply' : 'plan');
    console.log(fs.readFileSync(r.txt, 'utf8').split('\n').slice(0, 40).join('\n'));
    console.log('Report:', r.txt, '\nWorkbook:', r.xlsx);
    if (args.includes('--apply')) {
      const res = await apply(prisma, plan);
      console.log(`Applied to ${res.employees} employee(s).`);
      const after = await buildPlan(prisma, file);
      const r2 = writeReport(after, outDir, 'plan-after-apply');
      console.log(`Re-plan after apply: ${after.changes.length} pending change(s). Report: ${r2.txt}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { nameMatch, parseDate, parseMobile, parseBlood, educationOf, buildPlan };

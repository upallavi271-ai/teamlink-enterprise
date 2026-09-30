// ---------------------------------------------------------------------------
// PULSEHRM -> THE TEAMLINK IMPORT TEMPLATE.
//
// Four exports, one employee master:
//
//   active_employees.csv        40   currently employed
//   relieved_employees.csv     319   everybody who has left
//   Resigned Employee list.csv   54   resignations (52 unique — 2 are duplicated)
//   rehired_employee_list.csv    16   people who left and came back
//
// 359 distinct employee codes across them, and every single row carries an
// email address, which is what makes this importable at all.
//
// WHAT THIS FILE IS FOR. PulseHRM's vocabulary is not ours and cannot be
// imported raw: it has thirteen spellings of five departments and sixteen
// designations where TeamLink has eight roles. Every mapping below is written
// out rather than guessed at run time, so a wrong one is a line you can point
// at and change, not a mystery in the data afterwards.
//
// NOTHING IS INVENTED. Where PulseHRM has no value, the cell is left empty and
// the employee fills it in from My Profile. That is the whole point of the
// profile-submit flow.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const SRC = process.argv[2] || 'C:/Users/user/Downloads/';
const OUT = process.argv[3] || path.join(__dirname, '..', '..', 'TeamLink-PULSEHRM-converted.xlsx');

// --- CSV ---------------------------------------------------------------------
function parseCsv(txt) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < txt.length; i += 1) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}
function load(file) {
  const rows = parseCsv(fs.readFileSync(path.join(SRC, file), 'utf8'));
  // PulseHRM headers carry doubled spaces ("Employee  No"), so they are
  // collapsed once here rather than everywhere they are read.
  const head = rows[0].map((h) => h.replace(/\s+/g, ' ').trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

// --- the mappings, written out ----------------------------------------------
//
// DEPARTMENT. PulseHRM spells one department several ways — "Human Resource",
// "HR", "Human Resources", "HR& Administration" are the same team, and
// "Adminstration" is a typo for "Administration". "Office Assistant" is a JOB,
// sitting in the department column of one row; it has no department, so it
// gets none.
const DEPARTMENT = {
  'human resource': 'HR',
  'human resources': 'HR',
  hr: 'HR',
  'hr& administration': 'HR',
  'hr & administration': 'HR',
  recruitment: 'Recruitment',
  'bde-hr': 'BDE',
  administration: 'Administration',
  adminstration: 'Administration',
  marketing: 'Marketing',
  it: 'IT',
  'customer support': 'Customer Support',
  'product development': 'Product Development',
  // One row (TL139, Nagalakshmi Nandoddi) has the JOB TITLE "Office Assistant"
  // in the department column — a data-entry slip in PulseHRM. Department is
  // required, and dropping a person over somebody else's typo is worse than
  // placing them where an office assistant plainly sits.
  'office assistant': 'Administration',
};

// DESIGNATION -> one of TeamLink's eight roles. This is the mapping that
// decides what each person can reach, so it is the one worth arguing about.
//
// Everything that recruits is an Employee: in TeamLink the ATS role
// (Recruiter / BDE) is separate from the HRMS designation, and a recruiter is
// an Employee in HRMS. Putting "Recruiter" in the designation column would
// name a compound role, which this app deliberately does not have.
const DESIGNATION = {
  'hr-recruiter': 'Employee',
  'hr-recuiter': 'Employee', // PulseHRM's own typo, 36 rows
  recruiter: 'Employee',
  'hr-trainee': 'Employee',
  'bde-hr': 'Employee',
  employee: 'Employee',
  systemadmin: 'Employee',
  executive: 'Employee',
  'office assistant': 'Employee',
  'hr-teamlead': 'TL',
  hr_teamlead: 'TL',
  teamlead: 'TL',
  'team lead': 'TL',
  'senior teamlead': 'STL',
  manager: 'Manager',
  'asst. manager': 'Assistant Manager',
  'assistant manager': 'Assistant Manager',
  md: 'Super Admin',
  administrator: 'Super Admin',
};

// The ATS role each PulseHRM designation implies, recorded so the recruiting
// side is not lost. TeamLink derives the ATS role from the designation, so
// this is reported for review rather than written into the sheet.
const ATS_HINT = {
  'hr-recruiter': 'Recruiter', 'hr-recuiter': 'Recruiter', recruiter: 'Recruiter',
  'bde-hr': 'BDE', 'hr-teamlead': 'TL', hr_teamlead: 'TL', teamlead: 'TL', 'team lead': 'TL',
  'senior teamlead': 'STL',
};

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};
// PulseHRM writes 03-JUL-2026. Anything else is left alone rather than guessed.
function toIso(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) return '';
  const mm = MONTHS[m[2].toUpperCase()];
  return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}` : '';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const key = (s) => clean(s).toLowerCase();
const codeOf = (r) => clean(r['Employee No'] || r['Employee Ref No (Import Purpose)']);
const emailOf = (r) => clean(r['Email Id']).toLowerCase();
const phoneOf = (r) => {
  const d = String(r['Mobile No'] || '').replace(/\D/g, '');
  return d.length === 10 ? d : (d.length === 12 && d.startsWith('91') ? d.slice(2) : '');
};

// ---------------------------------------------------------------------------
function build() {
  const active = load('active_employees.csv');
  const relieved = load('relieved_employees.csv');
  const resigned = load('Resigned Employee list.csv');
  const rehired = load('rehired_employee_list.csv');

  const resignedBy = new Map();
  resigned.forEach((r) => {
    const c = codeOf(r);
    // The list has two exact duplicates. Keep the LATEST resignation per code.
    const prev = resignedBy.get(c);
    const when = toIso(r['Date Of Resignation']);
    if (!prev || when > prev.date) {
      resignedBy.set(c, { date: when, lwd: toIso(r['Last Working Date']), reason: clean(r['Reason for Resignation']) });
    }
  });
  const rehiredBy = new Map();
  rehired.forEach((r) => {
    const c = codeOf(r);
    if (!rehiredBy.has(c)) rehiredBy.set(c, []);
    rehiredBy.get(c).push({ newDoj: toIso(r['New Date Of Joining']), oldRelieved: toIso(r['Old Relieving Date']) });
  });

  const TODAY = new Date().toISOString().slice(0, 10);
  const out = [];
  const notes = [];
  const seen = new Set();

  const add = (r, source) => {
    const code = codeOf(r);
    if (!code || seen.has(code)) return;
    seen.add(code);

    const rawDept = key(r.Department);
    const rawDesig = key(r.Designation);
    if (rawDept && !(rawDept in DEPARTMENT)) notes.push(`unmapped department "${r.Department}" on ${code}`);
    if (rawDesig && !(rawDesig in DESIGNATION)) notes.push(`unmapped designation "${r.Designation}" on ${code}`);

    // STATUS. Derived, not copied: PulseHRM says "Confirmed" for everybody,
    // which is a probation state, not an employment state.
    let status;
    const res = resignedBy.get(code);
    if (source === 'relieved') status = 'Relieved';
    else if (res && res.lwd && res.lwd > TODAY) status = 'Notice Period';
    else status = 'Active';

    out.push({
      employeeCode: code,
      name: clean(r.Name || r['Employee Name']),
      email: emailOf(r),
      phone: phoneOf(r),
      department: DEPARTMENT[rawDept] ?? '',
      team: '', // PulseHRM has no team; only Education has teams in TeamLink
      designation: DESIGNATION[rawDesig] || 'Employee',
      tl: clean(r['Reporting Authority']),
      stl: '',
      dateOfJoining: toIso(r['Date Of Joining']),
      employmentStatus: status,
      employeeType: clean(r['Employment Type']) === 'Onroll' ? 'Full-time' : '',
      location: clean(r['Work Location']),
      branch: clean(r['Work Location']),
      // Still working -> a login. Left -> none, ever.
      _createLogin: status === 'Relieved' ? 'No' : 'Yes',
      _source: source,
      _pulseDept: clean(r.Department),
      _pulseDesig: clean(r.Designation),
      _atsHint: ATS_HINT[rawDesig] || '',
      _relievedOn: source === 'relieved' ? toIso(r['Relieving Date']) : (res ? res.lwd : ''),
      _resignedOn: res ? res.date : '',
      _resignReason: res ? res.reason : clean(r['Reason Leaving']),
      _rehired: rehiredBy.has(code) ? rehiredBy.get(code).length : 0,
    });
  };

  // ACTIVE FIRST, so a rehired person (in both files) lands as Active.
  active.forEach((r) => add(r, 'active'));
  relieved.forEach((r) => add(r, 'relieved'));

  return { rows: out, notes };
}

// ---------------------------------------------------------------------------
async function write(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  const COLS = [
    ['Employee Code', 'employeeCode'], ['Full Name', 'name'], ['Official Email', 'email'],
    ['Phone', 'phone'], ['Department', 'department'], ['Team', 'team'],
    ['Designation', 'designation'], ['Reporting TL', 'tl'], ['Reporting STL', 'stl'],
    ['Date of Joining', 'dateOfJoining'], ['Employment Status', 'employmentStatus'],
    ['Employee Type', 'employeeType'], ['Branch / Office', 'branch'], ['Work Location', 'location'],
    // NOBODY WHO HAS LEFT GETS AN ACCOUNT. The 319 relieved records are
    // history: they belong in the employee master so attrition and tenure
    // stay answerable, and they must not be able to sign in. Only the people
    // still working — Active and Notice Period — get a login.
    //
    // The importer creates the login with an unguessable password hash and
    // sends NOTHING. Nobody is emailed by this import; credentials go out
    // later, deliberately, from Administration → Users.
    ['Create Login', '_createLogin'],
  ];
  ws.columns = COLS.map(([h]) => ({ header: h, key: h, width: Math.max(14, h.length + 3) }));
  rows.forEach((r) => ws.addRow(Object.fromEntries(COLS.map(([h, k]) => [h, r[k] ?? '']))));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // A second sheet that is NOT imported: what each row came from and what was
  // dropped on the way. Somebody will ask why TL407 is an Employee and this is
  // where the answer lives.
  const audit = wb.addWorksheet('Mapping audit (not imported)');
  audit.columns = [
    { header: 'Employee Code', width: 16 }, { header: 'Name', width: 30 },
    { header: 'Source file', width: 12 }, { header: 'PulseHRM Department', width: 24 },
    { header: '-> TeamLink Department', width: 24 }, { header: 'PulseHRM Designation', width: 22 },
    { header: '-> TeamLink Designation', width: 22 }, { header: 'Implied ATS role', width: 16 },
    { header: 'Status', width: 16 }, { header: 'Resigned', width: 12 },
    { header: 'Relieved', width: 12 }, { header: 'Rehire cycles', width: 14 },
    { header: 'Reason', width: 40 },
  ];
  rows.forEach((r) => audit.addRow([
    r.employeeCode, r.name, r._source, r._pulseDept, r.department,
    r._pulseDesig, r.designation, r._atsHint, r.employmentStatus,
    r._resignedOn, r._relievedOn, r._rehired || '', r._resignReason,
  ]));
  audit.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(OUT);
}

(async () => {
  const { rows, notes } = build();
  await write(rows);

  const by = (f) => rows.reduce((m, r) => { const k = f(r) || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const show = (t, o) => {
    console.log('\n' + t);
    Object.entries(o).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(k).padEnd(24) + String(n).padStart(5)));
  };

  console.log(`WROTE ${rows.length} employees -> ${OUT}`);
  show('EMPLOYMENT STATUS', by((r) => r.employmentStatus));
  show('DEPARTMENT (after mapping)', by((r) => r.department));
  show('DESIGNATION (after mapping)', by((r) => r.designation));
  show('IMPLIED ATS ROLE (not written — for review)', by((r) => r._atsHint));

  const noEmail = rows.filter((r) => !r.email).length;
  const noDoj = rows.filter((r) => !r.dateOfJoining).length;
  const dupEmail = (() => {
    const m = {}; rows.forEach((r) => { if (r.email) m[r.email] = (m[r.email] || 0) + 1; });
    return Object.entries(m).filter(([, n]) => n > 1);
  })();
  console.log('\nDATA QUALITY');
  console.log('  ' + 'without an email'.padEnd(28) + String(noEmail).padStart(5));
  console.log('  ' + 'without a joining date'.padEnd(28) + String(noDoj).padStart(5));
  console.log('  ' + 'duplicate email addresses'.padEnd(28) + String(dupEmail.length).padStart(5));
  dupEmail.slice(0, 10).forEach(([e, n]) => console.log('      ' + e + '  x' + n));
  if (notes.length) {
    console.log('\nUNMAPPED VALUES (fell through to a default):');
    [...new Set(notes)].slice(0, 20).forEach((n) => console.log('  ' + n));
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
